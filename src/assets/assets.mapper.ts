import { formatCash, formatPrice, formatQuantity, notionalOf } from '../common/money';
import { Asset } from '../database/schema';
import { BreakerState } from './circuit-breaker.service';
import { HistoryPoint, PriceStats } from './market-data.service';
import { BookLevel, BookSnapshot } from './order-book';
import {
  AssetDto,
  BookLevelDto,
  CircuitBreakerDto,
  OrderBookDto,
  PriceHistoryDto,
  PricePointDto,
  PriceStatsDto,
} from './dto/asset.dto';

export function toCircuitBreakerDto(state: BreakerState): CircuitBreakerDto {
  return {
    tripped: state.tripped,
    moveBps: state.moveBps,
    thresholdBps: state.thresholdBps,
    windowMs: state.windowMs,
    resumesAt: state.resumesAt?.toISOString() ?? null,
  };
}

export function toPriceStatsDto(stats: PriceStats | undefined): PriceStatsDto | null {
  if (!stats) return null;
  return {
    open: formatPrice(stats.open),
    high: formatPrice(stats.high),
    low: formatPrice(stats.low),
    last: formatPrice(stats.last),
    changeBps: stats.changeBps,
    ticks: stats.ticks,
  };
}

export function toBookLevelDto(level: BookLevel): BookLevelDto {
  return {
    price: formatPrice(level.price),
    quantity: formatQuantity(level.quantity),
    notional: formatCash(notionalOf(level.price, level.quantity)),
  };
}

export function toOrderBookDto(snapshot: BookSnapshot, depth: number): OrderBookDto {
  return {
    symbol: snapshot.symbol,
    mid: formatPrice(snapshot.mid),
    bids: snapshot.bids.slice(0, depth).map(toBookLevelDto),
    asks: snapshot.asks.slice(0, depth).map(toBookLevelDto),
    asOf: snapshot.at.toISOString(),
  };
}

export interface AssetViewInput {
  readonly asset: Asset;
  readonly price: bigint;
  readonly book: BookSnapshot;
  readonly breaker: BreakerState;
  readonly stats?: PriceStats;
}

export function toAssetDto(input: AssetViewInput): AssetDto {
  const bid = input.book.bids[0]?.price ?? input.price;
  const ask = input.book.asks[0]?.price ?? input.price;
  const mid = (bid + ask) / 2n;

  return {
    symbol: input.asset.symbol,
    name: input.asset.name,
    sector: input.asset.sector,
    description: input.asset.description,
    status: input.asset.status,
    price: formatPrice(input.price),
    bid: formatPrice(bid),
    ask: formatPrice(ask),
    spreadBps: mid === 0n ? 0 : Number(((ask - bid) * 10_000n) / mid),
    tickSize: formatPrice(input.asset.tickSize),
    lotSize: formatQuantity(input.asset.lotSize),
    minOrderNotional: formatCash(input.asset.minOrderNotional),
    annualVolBps: input.asset.annualVolBps,
    stats24h: toPriceStatsDto(input.stats),
    circuitBreaker: toCircuitBreakerDto(input.breaker),
    asOf: input.book.at.toISOString(),
  };
}

export function toPricePointDto(point: HistoryPoint): PricePointDto {
  return { price: formatPrice(point.price), at: point.at.toISOString() };
}

export function toPriceHistoryDto(
  symbol: string,
  points: readonly HistoryPoint[],
): PriceHistoryDto {
  return { symbol, points: points.map(toPricePointDto), count: points.length };
}
