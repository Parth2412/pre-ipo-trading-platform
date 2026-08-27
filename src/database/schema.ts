import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle mirror of `src/database/migrations/*.sql`.
 *
 * The SQL files are authoritative — they carry the CHECK constraints, partial
 * indexes and integrity view that Drizzle's DDL cannot express. This module
 * exists purely to give queries end-to-end type safety.
 *
 * All monetary columns use `mode: 'bigint'` so scaled integers never round-trip
 * through JS `number`.
 */

const money = (name: string) => bigint(name, { mode: 'bigint' });

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    role: text('role').$type<'USER' | 'ADMIN'>().notNull().default('USER'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({ emailIdx: uniqueIndex('users_email_uidx').on(table.email) }),
);

export const assets = pgTable('assets', {
  symbol: text('symbol').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  sector: text('sector').notNull().default(''),
  initialPrice: money('initial_price').notNull(),
  annualDriftBps: integer('annual_drift_bps').notNull().default(0),
  annualVolBps: integer('annual_vol_bps').notNull(),
  tickSize: money('tick_size').notNull(),
  lotSize: money('lot_size').notNull(),
  minOrderNotional: money('min_order_notional').notNull().default(0n),
  status: text('status').$type<'ACTIVE' | 'HALTED'>().notNull().default('ACTIVE'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const priceTicks = pgTable(
  'price_ticks',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    symbol: text('symbol').notNull(),
    price: money('price').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    symbolTimeIdx: index('price_ticks_symbol_time_idx').on(table.symbol, table.createdAt),
  }),
);

export const assetStatusEvents = pgTable('asset_status_events', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  symbol: text('symbol').notNull(),
  status: text('status').$type<'ACTIVE' | 'HALTED'>().notNull(),
  reason: text('reason').notNull().default(''),
  actorUserId: uuid('actor_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type LedgerAccount = 'CASH' | 'CASH_RESERVED' | 'POSITION' | 'POSITION_RESERVED';

export const balances = pgTable('balances', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  userId: uuid('user_id').notNull(),
  account: text('account').$type<LedgerAccount>().notNull(),
  assetSymbol: text('asset_symbol'),
  amount: money('amount').notNull().default(0n),
  version: bigint('version', { mode: 'bigint' }).notNull().default(0n),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type LedgerEntryType =
  'DEPOSIT' | 'WITHDRAWAL' | 'ORDER_RESERVE' | 'ORDER_RELEASE' | 'TRADE_BUY' | 'TRADE_SELL' | 'FEE';

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    userId: uuid('user_id').notNull(),
    account: text('account').$type<LedgerAccount>().notNull(),
    assetSymbol: text('asset_symbol'),
    delta: money('delta').notNull(),
    balanceAfter: money('balance_after').notNull(),
    entryType: text('entry_type').$type<LedgerEntryType>().notNull(),
    refType: text('ref_type').$type<'ORDER' | 'FILL' | 'ADMIN' | 'SIGNUP' | null>(),
    refId: text('ref_id'),
    memo: text('memo').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userTimeIdx: index('ledger_entries_user_time_idx').on(table.userId, table.id),
  }),
);

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT';
export type TimeInForce = 'IOC' | 'GTC';
export type OrderStatus = 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED';

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    symbol: text('symbol').notNull(),
    side: text('side').$type<OrderSide>().notNull(),
    type: text('type').$type<OrderType>().notNull(),
    timeInForce: text('time_in_force').$type<TimeInForce>().notNull(),
    limitPrice: money('limit_price'),
    quantity: money('quantity').notNull(),
    filledQuantity: money('filled_quantity').notNull().default(0n),
    filledNotional: money('filled_notional').notNull().default(0n),
    feesPaid: money('fees_paid').notNull().default(0n),
    reservedCash: money('reserved_cash').notNull().default(0n),
    reservedQuantity: money('reserved_quantity').notNull().default(0n),
    status: text('status').$type<OrderStatus>().notNull(),
    rejectReason: text('reject_reason'),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idempotencyIdx: uniqueIndex('orders_user_idempotency_uidx').on(
      table.userId,
      table.idempotencyKey,
    ),
    userCreatedIdx: index('orders_user_created_idx').on(table.userId, table.createdAt),
  }),
);

export const fills = pgTable(
  'fills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seq: bigserial('seq', { mode: 'bigint' }).notNull(),
    orderId: uuid('order_id').notNull(),
    userId: uuid('user_id').notNull(),
    symbol: text('symbol').notNull(),
    side: text('side').$type<OrderSide>().notNull(),
    quantity: money('quantity').notNull(),
    price: money('price').notNull(),
    notional: money('notional').notNull(),
    fee: money('fee').notNull().default(0n),
    liquidityRole: text('liquidity_role').$type<'TAKER' | 'MAKER'>().notNull(),
    counterpartyType: text('counterparty_type').$type<'USER' | 'SYNTHETIC'>().notNull(),
    counterOrderId: uuid('counter_order_id'),
    postQuantity: money('post_quantity').notNull(),
    postAvgCost: money('post_avg_cost').notNull(),
    postRealizedPnl: money('post_realized_pnl').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    positionPitIdx: index('fills_position_pit_idx').on(table.userId, table.symbol, table.createdAt),
    orderIdx: index('fills_order_idx').on(table.orderId, table.seq),
  }),
);

export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    userId: uuid('user_id').notNull(),
    endpoint: text('endpoint').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    status: text('status').$type<'IN_FLIGHT' | 'COMPLETED'>().notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.endpoint, table.idempotencyKey] }),
  }),
);

export const circuitBreakerEvents = pgTable('circuit_breaker_events', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  symbol: text('symbol').notNull(),
  moveBps: integer('move_bps').notNull(),
  thresholdBps: integer('threshold_bps').notNull(),
  windowMs: integer('window_ms').notNull(),
  referencePrice: money('reference_price').notNull(),
  extremePrice: money('extreme_price').notNull(),
  trippedAt: timestamp('tripped_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const databaseSchema = {
  users,
  assets,
  priceTicks,
  assetStatusEvents,
  balances,
  ledgerEntries,
  orders,
  fills,
  idempotencyRecords,
  circuitBreakerEvents,
};

export type User = typeof users.$inferSelect;
export type Asset = typeof assets.$inferSelect;
export type PriceTick = typeof priceTicks.$inferSelect;
export type Balance = typeof balances.$inferSelect;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type Fill = typeof fills.$inferSelect;
