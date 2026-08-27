import { OrderSide } from '../database/schema';
import { divRoundHalfUp, notionalOf, QTY_SCALE } from '../common/money';

/**
 * A user's running state in one asset.
 *
 * `avgCost` is the weighted-average cost per share *including fees*, and
 * `realizedPnl` is cumulative for the life of the account in that symbol. Both
 * are snapshotted onto every fill row, which is what makes point-in-time cost
 * basis an index seek rather than a replay of the user's entire trade history.
 */
export interface PositionState {
  readonly quantity: bigint;
  readonly avgCost: bigint;
  readonly realizedPnl: bigint;
}

export const EMPTY_POSITION: PositionState = { quantity: 0n, avgCost: 0n, realizedPnl: 0n };

export interface FillInput {
  readonly side: OrderSide;
  readonly quantity: bigint;
  readonly price: bigint;
  readonly fee: bigint;
}

/**
 * Advance a position by one fill using **weighted average cost**.
 *
 * WAC is chosen over FIFO/LIFO lot tracking deliberately:
 *   - it is a single `(quantity, avgCost)` pair, so the whole position state
 *     fits in three columns and point-in-time reconstruction stays O(log n)
 *     rather than requiring a lot table to be replayed;
 *   - it is the convention for fractional/tokenized share products, where lots
 *     are not individually identifiable anyway.
 *
 * Fees are capitalised into the basis on a buy and deducted from proceeds on a
 * sell, so realised P&L is net of trading costs — the number a user actually
 * cares about.
 */
export function applyFill(state: PositionState, fill: FillInput): PositionState {
  if (fill.quantity <= 0n) return state;

  if (fill.side === 'BUY') {
    const addedCost = notionalOf(fill.price, fill.quantity) + fill.fee;
    const existingCost = notionalOf(state.avgCost, state.quantity);
    const quantity = state.quantity + fill.quantity;
    return {
      quantity,
      // Cost basis is (total cost) / (total shares), carried at price scale.
      avgCost: divRoundHalfUp((existingCost + addedCost) * QTY_SCALE, quantity),
      realizedPnl: state.realizedPnl,
    };
  }

  const soldQuantity = fill.quantity > state.quantity ? state.quantity : fill.quantity;
  const proceeds = notionalOf(fill.price, fill.quantity) - fill.fee;
  const costRemoved = notionalOf(state.avgCost, soldQuantity);
  const quantity = state.quantity - soldQuantity;

  return {
    quantity,
    // Selling does not change the average cost of what is left; a flat position
    // resets it so a later re-entry starts clean.
    avgCost: quantity === 0n ? 0n : state.avgCost,
    realizedPnl: state.realizedPnl + (proceeds - costRemoved),
  };
}

/** Unrealised P&L of a position marked at `markPrice`. */
export function unrealizedPnl(state: PositionState, markPrice: bigint): bigint {
  if (state.quantity === 0n) return 0n;
  return notionalOf(markPrice, state.quantity) - notionalOf(state.avgCost, state.quantity);
}

/** Market value of a position at `markPrice`. */
export function marketValue(state: PositionState, markPrice: bigint): bigint {
  return notionalOf(markPrice, state.quantity);
}

/** Total cost basis still tied up in the position. */
export function costBasis(state: PositionState): bigint {
  return notionalOf(state.avgCost, state.quantity);
}
