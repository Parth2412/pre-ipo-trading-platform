import { OrderSide } from '../database/schema';
import { floorToLot, minBigInt, notionalOf } from '../common/money';

export type LiquidityKind = 'USER' | 'SYNTHETIC';

/** One piece of liquidity a taker can trade against. */
export interface LiquiditySource {
  readonly kind: LiquidityKind;
  readonly price: bigint;
  readonly quantity: bigint;
  /** Present for `USER` liquidity: the resting order being hit. */
  readonly orderId?: string;
  readonly userId?: string;
  readonly restingSince?: Date;
}

export interface PlannedExecution {
  readonly price: bigint;
  readonly quantity: bigint;
  readonly notional: bigint;
  readonly source: LiquiditySource;
}

export interface MatchPlan {
  readonly executions: readonly PlannedExecution[];
  readonly filledQuantity: bigint;
  readonly filledNotional: bigint;
  /** Unfilled remainder. Rests on the book for GTC orders, cancelled for IOC. */
  readonly remainingQuantity: bigint;
}

/**
 * The liquidity an order may trade against, already filtered and ranked.
 *
 * Exposed separately because sizing a market order by USD needs the ranked list
 * before a target quantity exists.
 */
export function eligibleSources(
  request: Omit<MatchPlanRequest, 'quantity' | 'lotSize'>,
): LiquiditySource[] {
  const { side, limitPrice, sources, takerUserId } = request;
  return sources
    .filter((source) => source.quantity > 0n)
    .filter((source) => source.userId !== takerUserId)
    .filter((source) =>
      limitPrice === undefined || limitPrice === null
        ? true
        : side === 'BUY'
          ? source.price <= limitPrice
          : source.price >= limitPrice,
    )
    .sort((a, b) => comparePriority(a, b, side));
}

export interface MatchPlanRequest {
  readonly side: OrderSide;
  readonly quantity: bigint;
  readonly limitPrice?: bigint | null;
  readonly sources: readonly LiquiditySource[];
  /** Excluded from matching so a user cannot trade with themselves. */
  readonly takerUserId: string;
  readonly lotSize: bigint;
}

/**
 * Build the execution plan for an incoming order.
 *
 * Priority is **price, then origin, then time**:
 *
 *   1. *Price* — the taker always gets the best price available, whether it
 *      comes from another user or from synthetic depth.
 *   2. *Origin* — at an equal price, resting user orders are filled before
 *      synthetic depth. A real order queued at a price should never be skipped
 *      in favour of a market maker quoting the same price.
 *   3. *Time* — among user orders at the same price, oldest first. This is the
 *      classic price-time priority guarantee: queue position is earned by
 *      arriving early and cannot be jumped.
 *
 * Self-match prevention is applied by exclusion (the taker's own resting orders
 * are skipped rather than cancelled), which keeps a user's queue position
 * intact when they trade on the other side of their own book.
 *
 * The function is pure: it decides *what* to execute. Nothing is written, no
 * balances move, and it can be reasoned about — and tested — in isolation.
 */
export function buildMatchPlan(request: MatchPlanRequest): MatchPlan {
  const { quantity, lotSize } = request;
  const eligible = eligibleSources(request);

  // Normalise once: everything downstream is expressed in whole lots, so
  // `filledQuantity + remainingQuantity` always equals the tradable request.
  const requested = floorToLot(quantity, lotSize);
  const executions: PlannedExecution[] = [];
  let remaining = requested;
  let filledNotional = 0n;

  for (const source of eligible) {
    if (remaining <= 0n) break;
    const take = floorToLot(minBigInt(remaining, source.quantity), lotSize);
    if (take <= 0n) continue;

    const notional = notionalOf(source.price, take);
    executions.push({ price: source.price, quantity: take, notional, source });
    filledNotional += notional;
    remaining -= take;
  }

  return {
    executions,
    filledQuantity: requested - remaining,
    filledNotional,
    remainingQuantity: remaining,
  };
}

function comparePriority(a: LiquiditySource, b: LiquiditySource, side: OrderSide): number {
  // 1. Best price for the taker.
  if (a.price !== b.price) {
    return side === 'BUY' ? (a.price < b.price ? -1 : 1) : a.price > b.price ? -1 : 1;
  }
  // 2. Real orders ahead of synthetic depth at the same price.
  if (a.kind !== b.kind) return a.kind === 'USER' ? -1 : 1;
  // 3. Oldest resting order first.
  const aTime = a.restingSince?.getTime() ?? 0;
  const bTime = b.restingSince?.getTime() ?? 0;
  if (aTime !== bTime) return aTime - bTime;
  // Deterministic tie-break so the plan is reproducible.
  return (a.orderId ?? '').localeCompare(b.orderId ?? '');
}
