import { OrderSide, OrderStatus, OrderType, TimeInForce } from '../database/schema';
import { priceOf } from '../common/money';

export type { OrderSide, OrderStatus, OrderType, TimeInForce };

export const ORDERS_ENDPOINT = 'POST /orders';

/** Statuses at which an order still has unfilled quantity sitting on the book. */
export const RESTING_STATUSES: readonly OrderStatus[] = ['OPEN', 'PARTIALLY_FILLED'];

export interface PlaceOrderCommand {
  readonly userId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly type: OrderType;
  readonly timeInForce: TimeInForce;
  readonly limitPrice?: bigint;
  /** Exactly one of `quantity` / `notional` is set; `notional` is MARKET BUY only. */
  readonly quantity?: bigint;
  readonly notional?: bigint;
  readonly idempotencyKey: string;
}

export interface OrderRecord {
  readonly id: string;
  readonly userId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly type: OrderType;
  readonly timeInForce: TimeInForce;
  readonly limitPrice: bigint | null;
  readonly quantity: bigint;
  readonly filledQuantity: bigint;
  readonly filledNotional: bigint;
  readonly feesPaid: bigint;
  readonly reservedCash: bigint;
  readonly reservedQuantity: bigint;
  readonly status: OrderStatus;
  readonly rejectReason: string | null;
  readonly idempotencyKey: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface FillRecord {
  readonly id: string;
  readonly seq: bigint;
  readonly orderId: string;
  readonly userId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly quantity: bigint;
  readonly price: bigint;
  readonly notional: bigint;
  readonly fee: bigint;
  readonly liquidityRole: 'TAKER' | 'MAKER';
  readonly counterpartyType: 'USER' | 'SYNTHETIC';
  readonly counterOrderId: string | null;
  readonly postQuantity: bigint;
  readonly postAvgCost: bigint;
  readonly postRealizedPnl: bigint;
  readonly createdAt: Date;
}

/** Volume-weighted average price of an order's executions. Zero before the first fill. */
export function averageFillPrice(order: OrderRecord): bigint {
  return order.filledQuantity > 0n ? priceOf(order.filledNotional, order.filledQuantity) : 0n;
}

/** Quantity still working on the book. */
export function remainingQuantity(order: OrderRecord): bigint {
  return order.quantity - order.filledQuantity;
}

export interface OrderWithFills {
  readonly order: OrderRecord;
  readonly fills: readonly FillRecord[];
}
