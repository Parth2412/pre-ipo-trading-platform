import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ErrorCode, NotFoundException, ValidationException } from '../common/errors';
import { DatabaseService, Executor } from '../database/database.service';
import { asBigInt, asDate, asNumber } from '../common/rows';
import { Asset, OrderSide } from '../database/schema';
import { BookLevel, BookSnapshot, mergeLevels } from './order-book';
import { DepthLadderService, LadderParameters } from './depth-ladder.service';
import { PriceEngineService } from './price-engine.service';

export interface PriceStats {
  readonly open: bigint;
  readonly high: bigint;
  readonly low: bigint;
  readonly last: bigint;
  readonly changeBps: number;
  readonly ticks: number;
}

export interface HistoryQuery {
  readonly from?: Date;
  readonly to?: Date;
  readonly limit: number;
}

export interface HistoryPoint {
  readonly price: bigint;
  readonly at: Date;
}

interface AssetRow {
  symbol: string;
  name: string;
  description: string;
  sector: string;
  initial_price: string;
  annual_drift_bps: number | string;
  annual_vol_bps: number | string;
  tick_size: string;
  lot_size: string;
  min_order_notional: string;
  status: 'ACTIVE' | 'HALTED';
  created_at: string;
}

const MAX_HISTORY_POINTS = 1000;

/**
 * Read side of the market: asset metadata, live prices, book snapshots and
 * price history.
 *
 * Asset rows are cached in memory because every order placement reads tick and
 * lot sizes; they change only through an administrative action, which
 * invalidates the cache explicitly.
 */
@Injectable()
export class MarketDataService implements OnApplicationBootstrap {
  private readonly assets = new Map<string, Asset>();

  constructor(
    private readonly database: DatabaseService,
    private readonly prices: PriceEngineService,
    private readonly ladder: DepthLadderService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.refresh();
  }

  /** Reload the asset cache. Called at boot and after an administrative change. */
  async refresh(): Promise<void> {
    const result = await this.database.db.execute(sql`SELECT * FROM assets ORDER BY symbol`);
    this.assets.clear();
    for (const row of result.rows as unknown as AssetRow[]) {
      this.assets.set(row.symbol, toAsset(row));
    }
  }

  list(): Asset[] {
    return [...this.assets.values()];
  }

  find(symbol: string): Asset | undefined {
    return this.assets.get(symbol.trim());
  }

  requireAsset(symbol: string): Asset {
    const asset = this.find(symbol);
    if (!asset) {
      throw new NotFoundException(
        ErrorCode.ASSET_NOT_FOUND,
        `Unknown asset "${symbol}". Call GET /assets for the tradable universe.`,
        { symbol },
      );
    }
    return asset;
  }

  /** Latest simulated price. Throws if the engine has not produced a mark yet. */
  requirePrice(symbol: string): bigint {
    const price = this.prices.getPrice(symbol);
    if (price === undefined || price <= 0n) {
      throw new NotFoundException(
        ErrorCode.PRICE_UNAVAILABLE,
        `No price is currently available for ${symbol}.`,
        { symbol },
      );
    }
    return price;
  }

  ladderParameters(asset: Asset): LadderParameters {
    return {
      symbol: asset.symbol,
      tickSize: asset.tickSize,
      lotSize: asset.lotSize,
      annualVolBps: asset.annualVolBps,
    };
  }

  /** Synthetic market-maker depth only — the fallback counterparty for matching. */
  syntheticLadder(asset: Asset, mid = this.requirePrice(asset.symbol)) {
    return this.ladder.build(this.ladderParameters(asset), mid);
  }

  /**
   * The book a client sees: resting user limit orders aggregated by price and
   * merged with the synthetic ladder.
   */
  async getBookSnapshot(symbol: string): Promise<BookSnapshot> {
    const asset = this.requireAsset(symbol);
    const mid = this.requirePrice(asset.symbol);
    const synthetic = this.syntheticLadder(asset, mid);
    const resting = await this.restingLiquidity(this.database.db, asset.symbol);

    return {
      symbol: asset.symbol,
      mid,
      bids: mergeLevels([...synthetic.bids, ...resting.BUY], 'BUY'),
      asks: mergeLevels([...synthetic.asks, ...resting.SELL], 'SELL'),
      at: new Date(),
    };
  }

  /** Unfilled quantity of resting user limit orders, aggregated per price level. */
  async restingLiquidity(
    executor: Executor,
    symbol: string,
  ): Promise<Record<OrderSide, BookLevel[]>> {
    const result = await executor.execute(sql`
      SELECT side, limit_price AS price, SUM(quantity - filled_quantity)::bigint AS quantity
      FROM orders
      WHERE symbol = ${symbol}::text
        AND type = 'LIMIT'
        AND status IN ('OPEN', 'PARTIALLY_FILLED')
      GROUP BY side, limit_price
    `);

    const levels: Record<OrderSide, BookLevel[]> = { BUY: [], SELL: [] };
    for (const row of result.rows as unknown as Array<{
      side: OrderSide;
      price: string;
      quantity: string;
    }>) {
      const quantity = asBigInt(row.quantity);
      if (quantity > 0n) levels[row.side].push({ price: asBigInt(row.price), quantity });
    }
    return levels;
  }

  /** Price history, newest last, capped so a client cannot ask for the whole tape. */
  async getHistory(symbol: string, query: HistoryQuery): Promise<HistoryPoint[]> {
    this.requireAsset(symbol);
    if (query.limit <= 0 || query.limit > MAX_HISTORY_POINTS) {
      throw new ValidationException(`limit must be between 1 and ${MAX_HISTORY_POINTS}.`, {
        limit: query.limit,
      });
    }
    if (query.from && query.to && query.from > query.to) {
      throw new ValidationException('`from` must be earlier than `to`.');
    }

    const result = await this.database.db.execute(sql`
      SELECT price, created_at
      FROM (
        SELECT price, created_at
        FROM price_ticks
        WHERE symbol = ${symbol}::text
          AND (${query.from ? query.from.toISOString() : null}::timestamptz IS NULL
               OR created_at >= ${query.from ? query.from.toISOString() : null}::timestamptz)
          AND (${query.to ? query.to.toISOString() : null}::timestamptz IS NULL
               OR created_at <= ${query.to ? query.to.toISOString() : null}::timestamptz)
        ORDER BY created_at DESC, id DESC
        LIMIT ${query.limit}
      ) recent
      ORDER BY created_at ASC
    `);

    return (result.rows as unknown as Array<{ price: string; created_at: string }>).map((row) => ({
      price: asBigInt(row.price),
      at: asDate(row.created_at),
    }));
  }

  /** Open/high/low/close statistics over a trailing window. */
  async getStats(symbol: string, windowMs = 24 * 60 * 60 * 1000): Promise<PriceStats | undefined> {
    const since = new Date(Date.now() - windowMs);
    const result = await this.database.db.execute(sql`
      SELECT
        (SELECT price FROM price_ticks
          WHERE symbol = ${symbol}::text AND created_at >= ${since.toISOString()}::timestamptz
          ORDER BY created_at ASC, id ASC LIMIT 1) AS open,
        (SELECT price FROM price_ticks
          WHERE symbol = ${symbol}::text AND created_at >= ${since.toISOString()}::timestamptz
          ORDER BY created_at DESC, id DESC LIMIT 1) AS last,
        MAX(price) AS high,
        MIN(price) AS low,
        COUNT(*)::int AS ticks
      FROM price_ticks
      WHERE symbol = ${symbol}::text AND created_at >= ${since.toISOString()}::timestamptz
    `);

    const row = result.rows[0] as unknown as {
      open: string | null;
      last: string | null;
      high: string | null;
      low: string | null;
      ticks: number;
    };
    if (!row?.open || !row.last) return undefined;

    const open = asBigInt(row.open);
    const last = asBigInt(row.last);
    return {
      open,
      last,
      high: asBigInt(row.high ?? row.last),
      low: asBigInt(row.low ?? row.last),
      changeBps: open === 0n ? 0 : Number(((last - open) * 10_000n) / open),
      ticks: asNumber(row.ticks),
    };
  }

  /**
   * The mark price for an asset as it stood at `at`.
   *
   * Used by point-in-time portfolio valuation: holdings are valued at the price
   * that was actually printed then, never at today's price.
   */
  async priceAt(symbol: string, at: Date, executor: Executor = this.database.db): Promise<bigint | undefined> {
    const result = await executor.execute(sql`
      SELECT price FROM price_ticks
      WHERE symbol = ${symbol}::text AND created_at <= ${at.toISOString()}::timestamptz
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `);
    const row = result.rows[0] as unknown as { price: string } | undefined;
    return row ? asBigInt(row.price) : undefined;
  }

  /**
   * Mark prices for many symbols at one instant, in a single round trip.
   *
   * `DISTINCT ON` with a matching index is the efficient Postgres idiom for
   * "latest row per group" — the alternative correlated subquery per symbol
   * turns an N-symbol portfolio into N queries.
   */
  async pricesAt(
    symbols: readonly string[],
    at: Date,
    executor: Executor = this.database.db,
  ): Promise<Map<string, bigint>> {
    const prices = new Map<string, bigint>();
    if (symbols.length === 0) return prices;

    const result = await executor.execute(sql`
      SELECT DISTINCT ON (symbol) symbol, price
      FROM price_ticks
      WHERE symbol = ANY(${symbols as string[]}::text[])
        AND created_at <= ${at.toISOString()}::timestamptz
      ORDER BY symbol, created_at DESC, id DESC
    `);

    for (const row of result.rows as unknown as Array<{ symbol: string; price: string }>) {
      prices.set(row.symbol, asBigInt(row.price));
    }
    return prices;
  }
}

function toAsset(row: AssetRow): Asset {
  return {
    symbol: row.symbol,
    name: row.name,
    description: row.description,
    sector: row.sector,
    initialPrice: asBigInt(row.initial_price),
    annualDriftBps: asNumber(row.annual_drift_bps),
    annualVolBps: asNumber(row.annual_vol_bps),
    tickSize: asBigInt(row.tick_size),
    lotSize: asBigInt(row.lot_size),
    minOrderNotional: asBigInt(row.min_order_notional),
    status: row.status,
    createdAt: asDate(row.created_at),
  };
}
