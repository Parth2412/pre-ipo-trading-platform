import { OrderSide } from '../database/schema';
import { minBigInt, notionalOf, quantityForNotional } from '../common/money';

export interface BookLevel {
  readonly price: bigint;
  readonly quantity: bigint;
}

export interface BookSnapshot {
  readonly symbol: string;
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
  readonly mid: bigint;
  readonly at: Date;
}

export interface ConsumedLevel {
  readonly price: bigint;
  readonly quantity: bigint;
  readonly notional: bigint;
}

export interface WalkResult {
  /** Total shares obtainable. */
  readonly quantity: bigint;
  /** Total cash exchanged, excluding fees. */
  readonly notional: bigint;
  readonly levels: readonly ConsumedLevel[];
  /** True when the request could not be satisfied in full at acceptable prices. */
  readonly exhausted: boolean;
}

const EMPTY: WalkResult = { quantity: 0n, notional: 0n, levels: [], exhausted: true };

/**
 * Levels a taker on `side` can trade against, best price first.
 *
 * A buyer lifts asks from the lowest up; a seller hits bids from the highest
 * down. Levels outside the taker's limit price are dropped, which is what makes
 * a marketable limit order fill partially and rest for the remainder.
 */
export function takeableLevels(
  snapshot: Pick<BookSnapshot, 'bids' | 'asks'>,
  side: OrderSide,
  limitPrice?: bigint | null,
): BookLevel[] {
  const levels = side === 'BUY' ? [...snapshot.asks] : [...snapshot.bids];
  levels.sort((a, b) => (side === 'BUY' ? compare(a.price, b.price) : compare(b.price, a.price)));
  if (limitPrice === undefined || limitPrice === null) return levels;
  return levels.filter((level) =>
    side === 'BUY' ? level.price <= limitPrice : level.price >= limitPrice,
  );
}

/** Walk the book until `targetQuantity` shares are accumulated or liquidity runs out. */
export function walkForQuantity(levels: readonly BookLevel[], targetQuantity: bigint): WalkResult {
  if (targetQuantity <= 0n) return { ...EMPTY, exhausted: false };

  const consumed: ConsumedLevel[] = [];
  let remaining = targetQuantity;
  let notional = 0n;

  for (const level of levels) {
    if (remaining === 0n) break;
    if (level.quantity <= 0n) continue;
    const take = minBigInt(remaining, level.quantity);
    const levelNotional = notionalOf(level.price, take);
    consumed.push({ price: level.price, quantity: take, notional: levelNotional });
    notional += levelNotional;
    remaining -= take;
  }

  return {
    quantity: targetQuantity - remaining,
    notional,
    levels: consumed,
    exhausted: remaining > 0n,
  };
}

/**
 * Walk the book spending at most `budget` cash.
 *
 * The final level is sized to the cash that is actually left, rounded *down*,
 * so the walk can never spend more than the budget — the property the price
 * calculator and every market BUY rely on.
 */
export function walkForNotional(levels: readonly BookLevel[], budget: bigint): WalkResult {
  if (budget <= 0n) return { ...EMPTY, exhausted: false };

  const consumed: ConsumedLevel[] = [];
  let remainingBudget = budget;
  let quantity = 0n;
  let notional = 0n;
  // Distinguishes "ran out of liquidity" from "ran out of money", which is the
  // difference between an unfillable order and a fully satisfied one.
  let consumedEveryLevel = true;

  for (const level of levels) {
    if (remainingBudget <= 0n) {
      consumedEveryLevel = false;
      break;
    }
    if (level.quantity <= 0n) continue;

    const affordable = quantityForNotional(remainingBudget, level.price);
    const take = minBigInt(level.quantity, affordable);
    if (take <= 0n) {
      // The leftover budget cannot buy a single unit at this price: the request
      // is satisfied to the precision the market supports.
      consumedEveryLevel = false;
      break;
    }

    const levelNotional = notionalOf(level.price, take);
    consumed.push({ price: level.price, quantity: take, notional: levelNotional });
    quantity += take;
    notional += levelNotional;
    remainingBudget -= levelNotional;
  }

  return {
    quantity,
    notional,
    levels: consumed,
    exhausted: consumedEveryLevel && remainingBudget > 0n,
  };
}

/** Aggregate duplicate price levels and drop empties. Keeps snapshots tidy for clients. */
export function mergeLevels(levels: readonly BookLevel[], side: OrderSide): BookLevel[] {
  const totals = new Map<string, bigint>();
  for (const level of levels) {
    if (level.quantity <= 0n) continue;
    const key = level.price.toString();
    totals.set(key, (totals.get(key) ?? 0n) + level.quantity);
  }
  return [...totals.entries()]
    .map(([price, quantity]) => ({ price: BigInt(price), quantity }))
    .sort((a, b) => (side === 'BUY' ? compare(b.price, a.price) : compare(a.price, b.price)));
}

function compare(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
