import { Injectable } from '@nestjs/common';
import { ValidationException } from '../common/errors';
import { formatCash, formatPrice, formatQuantity, notionalOf } from '../common/money';
import { MarketDataService } from '../assets/market-data.service';
import { DatabaseService, Executor } from '../database/database.service';
import { LedgerService } from '../ledger/ledger.service';
import { AccountBalance } from '../ledger/ledger.types';
import { OrdersRepository } from '../orders/orders.repository';
import { EMPTY_POSITION, PositionState, applyFill } from '../orders/position';
import {
  CashDto,
  EquityCurveDto,
  EquityPointDto,
  HoldingDto,
  LedgerEntryDto,
  PortfolioDto,
  PortfolioTotalsDto,
  ReconciliationDto,
} from './dto/portfolio.dto';

interface SnapshotOptions {
  readonly at?: Date;
  readonly verify?: boolean;
}

interface RawSnapshot {
  readonly asOf: Date;
  readonly cashAvailable: bigint;
  readonly cashReserved: bigint;
  readonly positions: Map<string, PositionState>;
  readonly reservedShares: Map<string, bigint>;
  readonly marks: Map<string, bigint>;
  readonly netDeposits: bigint;
}

/**
 * Portfolio valuation, live and historical.
 *
 * ## How point-in-time reconstruction works
 *
 * The naive approach — fold every ledger entry and replay every fill on each
 * request — is O(account history) and degrades forever as a user trades. Two
 * columns avoid that entirely:
 *
 *   - `ledger_entries.balance_after` carries the running balance of its account,
 *     written under the same row lock as the balance update;
 *   - `fills.post_quantity / post_avg_cost / post_realized_pnl` snapshot the
 *     user's running position state immediately after each execution.
 *
 * So "what did this portfolio look like at 14:32 last Tuesday?" becomes three
 * index seeks — newest ledger entry per cash account at or before T, newest fill
 * per symbol at or before T, newest price tick per symbol at or before T — rather
 * than a full history replay. Every one of those is a `DISTINCT ON` against an
 * index whose leading columns match the predicate, so cost is O(log n) per
 * account and per asset, independent of how much the user has traded.
 *
 * ## Why the fold is still implemented
 *
 * A denormalised running total is only as good as the invariant that maintains
 * it. `verify=true` recomputes the same portfolio the slow, obviously-correct
 * way — `SUM(delta)` over the ledger and a full `applyFill` replay — and reports
 * any drift. It is the proof that the fast path is not lying, and the test suite
 * asserts the two agree.
 */
@Injectable()
export class PortfolioService {
  constructor(
    private readonly database: DatabaseService,
    private readonly ledger: LedgerService,
    private readonly marketData: MarketDataService,
    private readonly orders: OrdersRepository,
  ) {}

  async getPortfolio(userId: string, options: SnapshotOptions = {}): Promise<PortfolioDto> {
    const asOf = options.at ?? new Date();
    if (options.at && options.at.getTime() > Date.now() + 1000) {
      throw new ValidationException('`at` cannot be in the future.', {
        at: options.at.toISOString(),
      });
    }

    const raw = await this.loadSnapshot(this.database.db, userId, options.at);
    const dto = this.present(raw, Boolean(options.at));

    if (options.verify) {
      dto.reconciliation = await this.reconcile(userId, raw);
    }
    return { ...dto, asOf: asOf.toISOString() };
  }

  /**
   * Equity curve across a window.
   *
   * Each point is a full point-in-time reconstruction, which is only affordable
   * *because* reconstruction is an index seek rather than a replay — the same
   * property the history endpoint depends on, demonstrated at scale.
   */
  async getEquityCurve(
    userId: string,
    query: { from?: Date; to?: Date; points?: number },
  ): Promise<EquityCurveDto> {
    const to = query.to ?? new Date();
    const from =
      query.from ??
      (await this.ledger.firstEntryAt(this.database.db, userId)) ??
      new Date(to.getTime() - 3_600_000);
    if (from > to) throw new ValidationException('`from` must be earlier than `to`.');

    const points = query.points ?? 24;
    const stepMs = Math.max(1, Math.floor((to.getTime() - from.getTime()) / (points - 1)));

    const timestamps = Array.from(
      { length: points },
      (_, index) => new Date(Math.min(from.getTime() + index * stepMs, to.getTime())),
    );

    const series: EquityPointDto[] = [];
    for (const at of timestamps) {
      const raw = await this.loadSnapshot(this.database.db, userId, at);
      const totals = this.totalsOf(raw);
      series.push({
        at: at.toISOString(),
        equity: formatCash(totals.equity),
        cash: formatCash(totals.cash),
        positionsValue: formatCash(totals.positionsValue),
        totalPnl: formatCash(totals.totalPnl),
      });
    }

    return { points: series, from: from.toISOString(), to: to.toISOString() };
  }

  async getLedger(
    userId: string,
    options: { limit: number; offset: number },
  ): Promise<LedgerEntryDto[]> {
    const entries = await this.ledger.statement(this.database.db, userId, options);
    return entries.map((entry) => ({
      id: entry.id.toString(),
      account: entry.account,
      symbol: entry.assetSymbol,
      delta: entry.assetSymbol ? formatQuantity(entry.delta) : formatCash(entry.delta),
      balanceAfter: entry.assetSymbol
        ? formatQuantity(entry.balanceAfter)
        : formatCash(entry.balanceAfter),
      entryType: entry.entryType,
      reference: entry.reference,
      memo: entry.memo,
      at: entry.createdAt.toISOString(),
    }));
  }

  // ---------------------------------------------------------------------------
  // Reconstruction
  // ---------------------------------------------------------------------------

  private async loadSnapshot(executor: Executor, userId: string, at?: Date): Promise<RawSnapshot> {
    const asOf = at ?? new Date();

    // Cash: one index seek per account when historical, one row read when live.
    const balances = at
      ? await this.ledger.balancesAt(executor, userId, at)
      : await this.ledger.getBalances(executor, userId);

    const positions = await this.orders.loadPositionsAt(executor, userId, at);
    const netDeposits = await this.ledger.netDeposits(executor, userId, at);

    const reservedShares = new Map<string, bigint>();
    let cashAvailable = 0n;
    let cashReserved = 0n;
    for (const balance of balances as AccountBalance[]) {
      if (balance.account === 'CASH') cashAvailable = balance.amount;
      else if (balance.account === 'CASH_RESERVED') cashReserved = balance.amount;
      else if (balance.account === 'POSITION_RESERVED' && balance.assetSymbol) {
        reservedShares.set(balance.assetSymbol, balance.amount);
      }
    }

    const symbols = [...positions.keys()].filter((symbol) => {
      const state = positions.get(symbol)!;
      return state.quantity > 0n || state.realizedPnl !== 0n;
    });

    const marks = at
      ? await this.marketData.pricesAt(symbols, at, executor)
      : new Map(
          symbols
            .map((symbol) => [symbol, this.marketData.currentPrice(symbol)] as const)
            .filter((entry): entry is readonly [string, bigint] => entry[1] !== undefined),
        );

    return { asOf, cashAvailable, cashReserved, positions, reservedShares, marks, netDeposits };
  }

  private present(raw: RawSnapshot, historical: boolean): PortfolioDto {
    const totals = this.totalsOf(raw);
    const holdings: HoldingDto[] = [];

    for (const [symbol, state] of [...raw.positions.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (state.quantity === 0n && state.realizedPnl === 0n) continue;

      const asset = this.marketData.find(symbol);
      const mark = raw.marks.get(symbol) ?? state.avgCost;
      const reserved = raw.reservedShares.get(symbol) ?? 0n;
      const costBasis = notionalOf(state.avgCost, state.quantity);
      const marketValue = notionalOf(mark, state.quantity);
      const unrealized = marketValue - costBasis;

      holdings.push({
        symbol,
        name: asset?.name ?? symbol,
        quantity: formatQuantity(state.quantity),
        availableQuantity: formatQuantity(state.quantity - reserved),
        reservedQuantity: formatQuantity(reserved),
        averageCost: formatPrice(state.avgCost),
        costBasis: formatCash(costBasis),
        markPrice: formatPrice(mark),
        marketValue: formatCash(marketValue),
        unrealizedPnl: formatCash(unrealized),
        unrealizedPnlBps: costBasis === 0n ? 0 : Number((unrealized * 10_000n) / costBasis),
        realizedPnl: formatCash(state.realizedPnl),
        weightBps: totals.equity === 0n ? 0 : Number((marketValue * 10_000n) / totals.equity),
      });
    }

    const cash: CashDto = {
      available: formatCash(raw.cashAvailable),
      reserved: formatCash(raw.cashReserved),
      total: formatCash(raw.cashAvailable + raw.cashReserved),
    };

    const totalsDto: PortfolioTotalsDto = {
      cash: formatCash(totals.cash),
      positionsValue: formatCash(totals.positionsValue),
      equity: formatCash(totals.equity),
      costBasis: formatCash(totals.costBasis),
      unrealizedPnl: formatCash(totals.unrealizedPnl),
      realizedPnl: formatCash(totals.realizedPnl),
      totalPnl: formatCash(totals.totalPnl),
      netDeposits: formatCash(raw.netDeposits),
      totalReturnBps:
        raw.netDeposits === 0n
          ? 0
          : Number(((totals.equity - raw.netDeposits) * 10_000n) / raw.netDeposits),
    };

    return {
      asOf: raw.asOf.toISOString(),
      mode: historical ? 'HISTORICAL' : 'LIVE',
      cash,
      holdings,
      totals: totalsDto,
    };
  }

  private totalsOf(raw: RawSnapshot) {
    let positionsValue = 0n;
    let costBasis = 0n;
    let realizedPnl = 0n;

    for (const [symbol, state] of raw.positions) {
      realizedPnl += state.realizedPnl;
      if (state.quantity === 0n) continue;
      const mark = raw.marks.get(symbol) ?? state.avgCost;
      positionsValue += notionalOf(mark, state.quantity);
      costBasis += notionalOf(state.avgCost, state.quantity);
    }

    const cash = raw.cashAvailable + raw.cashReserved;
    const unrealizedPnl = positionsValue - costBasis;
    return {
      cash,
      positionsValue,
      equity: cash + positionsValue,
      costBasis,
      unrealizedPnl,
      realizedPnl,
      totalPnl: unrealizedPnl + realizedPnl,
    };
  }

  /**
   * Recompute the same portfolio the slow way and compare.
   *
   * Cash is re-derived with `SUM(delta)` over every ledger entry; positions are
   * re-derived by replaying every fill through `applyFill`. Any disagreement is
   * a bug in the running-total maintenance, and is reported rather than hidden.
   */
  private async reconcile(userId: string, raw: RawSnapshot): Promise<ReconciliationDto> {
    const at = raw.asOf;
    const folded = await this.ledger.foldBalances(this.database.db, userId, at);
    const fills = await this.orders.listFillsUpTo(this.database.db, userId, at);
    const entryCount = await this.ledger.countEntries(this.database.db, userId, at);

    let foldedCash = 0n;
    for (const balance of folded) {
      if (balance.account === 'CASH' || balance.account === 'CASH_RESERVED') {
        foldedCash += balance.amount;
      }
    }

    const replayed = new Map<string, PositionState>();
    for (const fill of fills) {
      const current = replayed.get(fill.symbol) ?? EMPTY_POSITION;
      replayed.set(
        fill.symbol,
        applyFill(current, {
          side: fill.side,
          quantity: fill.quantity,
          price: fill.price,
          fee: fill.fee,
        }),
      );
    }

    const positionDrift: string[] = [];
    const symbols = new Set([...raw.positions.keys(), ...replayed.keys()]);
    for (const symbol of symbols) {
      const snapshot = raw.positions.get(symbol) ?? EMPTY_POSITION;
      const recomputed = replayed.get(symbol) ?? EMPTY_POSITION;
      if (
        snapshot.quantity !== recomputed.quantity ||
        snapshot.avgCost !== recomputed.avgCost ||
        snapshot.realizedPnl !== recomputed.realizedPnl
      ) {
        positionDrift.push(symbol);
      }
    }

    const cashDrift = raw.cashAvailable + raw.cashReserved - foldedCash;
    return {
      consistent: cashDrift === 0n && positionDrift.length === 0,
      cashDrift: formatCash(cashDrift),
      positionDrift,
      ledgerEntriesFolded: entryCount,
      fillsReplayed: fills.length,
    };
  }
}
