import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Executor, Transaction } from '../database/database.service';
import { asBigInt, asBigIntOrNull, asDate } from '../common/rows';
import { EMPTY_POSITION, PositionState } from './position';
import { FillRecord, OrderRecord, OrderSide, OrderStatus } from './order.types';

const ORDER_COLUMNS = sql`id, user_id, symbol, side, type, time_in_force, limit_price, quantity,
  filled_quantity, filled_notional, fees_paid, reserved_cash, reserved_quantity, status,
  reject_reason, idempotency_key, created_at, updated_at`;

const FILL_COLUMNS = sql`id, seq, order_id, user_id, symbol, side, quantity, price, notional, fee,
  liquidity_role, counterparty_type, counter_order_id, post_quantity, post_avg_cost,
  post_realized_pnl, created_at`;

export interface RestingOrderRow {
  readonly id: string;
  readonly userId: string;
  readonly price: bigint;
  readonly remaining: bigint;
  readonly createdAt: Date;
}

export interface InsertOrderInput {
  readonly userId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly type: 'MARKET' | 'LIMIT';
  readonly timeInForce: 'IOC' | 'GTC';
  readonly limitPrice: bigint | null;
  readonly quantity: bigint;
  readonly status: OrderStatus;
  readonly idempotencyKey: string;
}

export interface InsertFillInput {
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
  readonly position: PositionState;
}

/**
 * All SQL for orders, fills and position state.
 *
 * Isolating it here keeps the matching engine readable as a sequence of trading
 * decisions rather than a wall of queries, and gives every locking choice one
 * place to be reviewed.
 */
@Injectable()
export class OrdersRepository {
  async insertOrder(tx: Transaction, input: InsertOrderInput): Promise<OrderRecord> {
    const result = await tx.execute(sql`
      INSERT INTO orders (user_id, symbol, side, type, time_in_force, limit_price, quantity,
                          status, idempotency_key)
      VALUES (${input.userId}::uuid, ${input.symbol}::text, ${input.side}::text, ${input.type}::text,
              ${input.timeInForce}::text, ${input.limitPrice?.toString() ?? null}::bigint,
              ${input.quantity.toString()}::bigint, ${input.status}::text,
              ${input.idempotencyKey}::text)
      RETURNING ${ORDER_COLUMNS}
    `);
    return toOrderRecord(result.rows[0]);
  }

  async updateOrder(
    tx: Transaction,
    orderId: string,
    patch: {
      filledQuantity: bigint;
      filledNotional: bigint;
      feesPaid: bigint;
      reservedCash: bigint;
      reservedQuantity: bigint;
      status: OrderStatus;
      rejectReason?: string | null;
    },
  ): Promise<OrderRecord> {
    const result = await tx.execute(sql`
      UPDATE orders
         SET filled_quantity = ${patch.filledQuantity.toString()}::bigint,
             filled_notional = ${patch.filledNotional.toString()}::bigint,
             fees_paid = ${patch.feesPaid.toString()}::bigint,
             reserved_cash = ${patch.reservedCash.toString()}::bigint,
             reserved_quantity = ${patch.reservedQuantity.toString()}::bigint,
             status = ${patch.status}::text,
             reject_reason = ${patch.rejectReason ?? null}::text,
             updated_at = clock_timestamp()
       WHERE id = ${orderId}::uuid
      RETURNING ${ORDER_COLUMNS}
    `);
    return toOrderRecord(result.rows[0]);
  }

  /** Fetch an order and lock it for the rest of the transaction. */
  async lockOrder(tx: Transaction, orderId: string): Promise<OrderRecord | undefined> {
    const result = await tx.execute(sql`
      SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ${orderId}::uuid FOR UPDATE
    `);
    return result.rows[0] ? toOrderRecord(result.rows[0]) : undefined;
  }

  async findOrder(executor: Executor, orderId: string): Promise<OrderRecord | undefined> {
    const result = await executor.execute(sql`
      SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ${orderId}::uuid
    `);
    return result.rows[0] ? toOrderRecord(result.rows[0]) : undefined;
  }

  async listOrders(
    executor: Executor,
    userId: string,
    filters: { symbol?: string; status?: OrderStatus; limit: number; offset: number },
  ): Promise<OrderRecord[]> {
    const result = await executor.execute(sql`
      SELECT ${ORDER_COLUMNS} FROM orders
      WHERE user_id = ${userId}::uuid
        AND (${filters.symbol ?? null}::text IS NULL OR symbol = ${filters.symbol ?? null}::text)
        AND (${filters.status ?? null}::text IS NULL OR status = ${filters.status ?? null}::text)
      ORDER BY created_at DESC, id DESC
      LIMIT ${filters.limit} OFFSET ${filters.offset}
    `);
    return result.rows.map(toOrderRecord);
  }

  /**
   * Resting liquidity on `side`, in price-time priority, locked for update.
   *
   * The lock is taken here — while the symbol advisory lock is already held —
   * so that a concurrent taker cannot plan against quantity this transaction is
   * about to consume.
   */
  async lockRestingOrders(
    tx: Transaction,
    symbol: string,
    side: OrderSide,
    excludeUserId?: string,
  ): Promise<RestingOrderRow[]> {
    const result = await tx.execute(sql`
      SELECT id, user_id, limit_price, (quantity - filled_quantity) AS remaining, created_at
      FROM orders
      WHERE symbol = ${symbol}::text
        AND side = ${side}::text
        AND type = 'LIMIT'
        AND status IN ('OPEN', 'PARTIALLY_FILLED')
        AND quantity > filled_quantity
        AND (${excludeUserId ?? null}::uuid IS NULL OR user_id <> ${excludeUserId ?? null}::uuid)
      ORDER BY limit_price ${side === 'SELL' ? sql`ASC` : sql`DESC`}, created_at ASC, id ASC
      FOR UPDATE
    `);

    return (
      result.rows as unknown as Array<{
        id: string;
        user_id: string;
        limit_price: string;
        remaining: string;
        created_at: string;
      }>
    ).map((row) => ({
      id: row.id,
      userId: row.user_id,
      price: asBigInt(row.limit_price),
      remaining: asBigInt(row.remaining),
      createdAt: asDate(row.created_at),
    }));
  }

  async insertFill(tx: Transaction, input: InsertFillInput): Promise<FillRecord> {
    const result = await tx.execute(sql`
      INSERT INTO fills (order_id, user_id, symbol, side, quantity, price, notional, fee,
                         liquidity_role, counterparty_type, counter_order_id,
                         post_quantity, post_avg_cost, post_realized_pnl)
      VALUES (${input.orderId}::uuid, ${input.userId}::uuid, ${input.symbol}::text,
              ${input.side}::text, ${input.quantity.toString()}::bigint,
              ${input.price.toString()}::bigint, ${input.notional.toString()}::bigint,
              ${input.fee.toString()}::bigint, ${input.liquidityRole}::text,
              ${input.counterpartyType}::text, ${input.counterOrderId}::uuid,
              ${input.position.quantity.toString()}::bigint,
              ${input.position.avgCost.toString()}::bigint,
              ${input.position.realizedPnl.toString()}::bigint)
      RETURNING ${FILL_COLUMNS}
    `);
    return toFillRecord(result.rows[0]);
  }

  async listFillsForOrder(executor: Executor, orderId: string): Promise<FillRecord[]> {
    const result = await executor.execute(sql`
      SELECT ${FILL_COLUMNS} FROM fills WHERE order_id = ${orderId}::uuid ORDER BY seq ASC
    `);
    return result.rows.map(toFillRecord);
  }

  async listFillsForUser(
    executor: Executor,
    userId: string,
    filters: { symbol?: string; limit: number; offset: number },
  ): Promise<FillRecord[]> {
    const result = await executor.execute(sql`
      SELECT ${FILL_COLUMNS} FROM fills
      WHERE user_id = ${userId}::uuid
        AND (${filters.symbol ?? null}::text IS NULL OR symbol = ${filters.symbol ?? null}::text)
      ORDER BY created_at DESC, seq DESC
      LIMIT ${filters.limit} OFFSET ${filters.offset}
    `);
    return result.rows.map(toFillRecord);
  }

  /**
   * Current position state for one asset, read from the newest fill.
   *
   * The running `post_*` columns mean this is a single index seek rather than an
   * aggregate over every fill the user has ever made.
   */
  async loadPosition(
    executor: Executor,
    userId: string,
    symbol: string,
    at?: Date,
  ): Promise<PositionState> {
    const result = await executor.execute(sql`
      SELECT post_quantity, post_avg_cost, post_realized_pnl
      FROM fills
      WHERE user_id = ${userId}::uuid
        AND symbol = ${symbol}::text
        AND (${at ? at.toISOString() : null}::timestamptz IS NULL
             OR created_at <= ${at ? at.toISOString() : null}::timestamptz)
      ORDER BY created_at DESC, seq DESC
      LIMIT 1
    `);
    const row = result.rows[0] as unknown as
      { post_quantity: string; post_avg_cost: string; post_realized_pnl: string } | undefined;
    if (!row) return EMPTY_POSITION;
    return {
      quantity: asBigInt(row.post_quantity),
      avgCost: asBigInt(row.post_avg_cost),
      realizedPnl: asBigInt(row.post_realized_pnl),
    };
  }

  /**
   * Position state for every traded symbol at one instant, in a single query.
   *
   * `DISTINCT ON` picks the newest fill per symbol using `fills_position_pit_idx`,
   * so an N-asset portfolio costs one index scan rather than N round trips.
   */
  async loadPositionsAt(
    executor: Executor,
    userId: string,
    at?: Date,
  ): Promise<Map<string, PositionState>> {
    const result = await executor.execute(sql`
      SELECT DISTINCT ON (symbol)
             symbol, post_quantity, post_avg_cost, post_realized_pnl
      FROM fills
      WHERE user_id = ${userId}::uuid
        AND (${at ? at.toISOString() : null}::timestamptz IS NULL
             OR created_at <= ${at ? at.toISOString() : null}::timestamptz)
      ORDER BY symbol, created_at DESC, seq DESC
    `);

    const positions = new Map<string, PositionState>();
    for (const row of result.rows as unknown as Array<{
      symbol: string;
      post_quantity: string;
      post_avg_cost: string;
      post_realized_pnl: string;
    }>) {
      positions.set(row.symbol, {
        quantity: asBigInt(row.post_quantity),
        avgCost: asBigInt(row.post_avg_cost),
        realizedPnl: asBigInt(row.post_realized_pnl),
      });
    }
    return positions;
  }

  /**
   * Every fill up to an instant, oldest first.
   *
   * Only used by the verification path, which replays the whole history to prove
   * the snapshot columns are right. Deliberately not on any hot path.
   */
  async listFillsUpTo(executor: Executor, userId: string, at?: Date): Promise<FillRecord[]> {
    const result = await executor.execute(sql`
      SELECT ${FILL_COLUMNS} FROM fills
      WHERE user_id = ${userId}::uuid
        AND (${at ? at.toISOString() : null}::timestamptz IS NULL
             OR created_at <= ${at ? at.toISOString() : null}::timestamptz)
      ORDER BY created_at ASC, seq ASC
    `);
    return result.rows.map(toFillRecord);
  }

  /** Every symbol the user has ever traded, for portfolio reconstruction. */
  async listTradedSymbols(executor: Executor, userId: string, at?: Date): Promise<string[]> {
    const result = await executor.execute(sql`
      SELECT DISTINCT symbol FROM fills
      WHERE user_id = ${userId}::uuid
        AND (${at ? at.toISOString() : null}::timestamptz IS NULL
             OR created_at <= ${at ? at.toISOString() : null}::timestamptz)
      ORDER BY symbol
    `);
    return (result.rows as unknown as Array<{ symbol: string }>).map((row) => row.symbol);
  }

  /**
   * Ids of every resting order on a symbol, in price-time priority.
   *
   * Ids rather than rows: the tick matcher re-locks each order individually as
   * it reaches it, so a fill executed earlier in the same pass is always seen.
   */
  async listRestingOrderIds(tx: Transaction, symbol: string): Promise<string[]> {
    const result = await tx.execute(sql`
      SELECT id FROM orders
      WHERE symbol = ${symbol}::text
        AND status IN ('OPEN', 'PARTIALLY_FILLED')
        AND quantity > filled_quantity
      ORDER BY created_at ASC, id ASC
    `);
    return (result.rows as unknown as Array<{ id: string }>).map((row) => row.id);
  }

  /** Symbols with resting orders on `side`, used to decide whether a tick needs a match run. */
  async listSymbolsWithRestingOrders(executor: Executor): Promise<string[]> {
    const result = await executor.execute(sql`
      SELECT DISTINCT symbol FROM orders WHERE status IN ('OPEN', 'PARTIALLY_FILLED')
    `);
    return (result.rows as unknown as Array<{ symbol: string }>).map((row) => row.symbol);
  }
}

function toOrderRecord(row: unknown): OrderRecord {
  const record = row as Record<string, string | null>;
  return {
    id: record.id as string,
    userId: record.user_id as string,
    symbol: record.symbol as string,
    side: record.side as OrderRecord['side'],
    type: record.type as OrderRecord['type'],
    timeInForce: record.time_in_force as OrderRecord['timeInForce'],
    limitPrice: asBigIntOrNull(record.limit_price),
    quantity: asBigInt(record.quantity),
    filledQuantity: asBigInt(record.filled_quantity),
    filledNotional: asBigInt(record.filled_notional),
    feesPaid: asBigInt(record.fees_paid),
    reservedCash: asBigInt(record.reserved_cash),
    reservedQuantity: asBigInt(record.reserved_quantity),
    status: record.status as OrderStatus,
    rejectReason: record.reject_reason,
    idempotencyKey: record.idempotency_key as string,
    createdAt: asDate(record.created_at),
    updatedAt: asDate(record.updated_at),
  };
}

function toFillRecord(row: unknown): FillRecord {
  const record = row as Record<string, string | null>;
  return {
    id: record.id as string,
    seq: asBigInt(record.seq),
    orderId: record.order_id as string,
    userId: record.user_id as string,
    symbol: record.symbol as string,
    side: record.side as OrderSide,
    quantity: asBigInt(record.quantity),
    price: asBigInt(record.price),
    notional: asBigInt(record.notional),
    fee: asBigInt(record.fee),
    liquidityRole: record.liquidity_role as 'TAKER' | 'MAKER',
    counterpartyType: record.counterparty_type as 'USER' | 'SYNTHETIC',
    counterOrderId: record.counter_order_id,
    postQuantity: asBigInt(record.post_quantity),
    postAvgCost: asBigInt(record.post_avg_cost),
    postRealizedPnl: asBigInt(record.post_realized_pnl),
    createdAt: asDate(record.created_at),
  };
}
