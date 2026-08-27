import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import {
  ConflictException,
  ErrorCode,
  MarketHaltedException,
  NotFoundException,
  UnprocessableException,
  ValidationException,
} from '../common/errors';
import {
  applyBps,
  floorToLot,
  formatCash,
  formatPrice,
  formatQuantity,
  minBigInt,
  notionalOf,
  priceOf,
} from '../common/money';
import { walkForNotional } from '../assets/order-book';
import { CircuitBreakerService } from '../assets/circuit-breaker.service';
import { MarketDataService } from '../assets/market-data.service';
import { DatabaseService, Transaction } from '../database/database.service';
import { Asset } from '../database/schema';
import { LedgerPosting } from '../ledger/ledger.types';
import { LedgerService } from '../ledger/ledger.service';
import { TradingEvent } from '../realtime/trading-events.service';
import { LiquiditySource, buildMatchPlan, eligibleSources } from './match-plan';
import { EMPTY_POSITION, PositionState, applyFill } from './position';
import { OrdersRepository } from './orders.repository';
import {
  FillRecord,
  OrderRecord,
  OrderSide,
  OrderStatus,
  PlaceOrderCommand,
  RESTING_STATUSES,
} from './order.types';

export interface ExecutionResult {
  readonly order: OrderRecord;
  readonly fills: readonly FillRecord[];
  readonly events: readonly TradingEvent[];
}

/** Per-transaction scratch space so repeated fills for one user stay consistent. */
interface ExecutionContext {
  readonly asset: Asset;
  readonly positions: Map<string, PositionState>;
  readonly events: TradingEvent[];
}

const MAX_RESTING_ORDERS_PER_TICK = 50;

/**
 * The matching engine.
 *
 * Everything in here runs inside a caller-supplied transaction, and the locking
 * discipline is the load-bearing part:
 *
 *   1. a **symbol advisory lock** first, so only one order at a time is matched
 *      against a given asset's book;
 *   2. **`SELECT ... FOR UPDATE` on resting orders**, taken while planning, so a
 *      concurrent taker cannot plan against quantity this transaction is about
 *      to consume;
 *   3. **user advisory locks, sorted ascending**, taken once the counterparties
 *      are known.
 *
 * That order is global and total, which is what makes the engine deadlock-free:
 * two transactions can never hold resources the other needs in reverse order.
 */
@Injectable()
export class MatchingEngineService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly marketData: MarketDataService,
    private readonly ledger: LedgerService,
    private readonly repository: OrdersRepository,
    private readonly breakers: CircuitBreakerService,
  ) {}

  // ---------------------------------------------------------------------------
  // Placement
  // ---------------------------------------------------------------------------

  async placeOrder(tx: Transaction, command: PlaceOrderCommand): Promise<ExecutionResult> {
    const asset = this.assertTradable(command.symbol);
    await DatabaseService.lockSymbol(tx, asset.symbol);

    const mid = this.marketData.requirePrice(asset.symbol);
    const sources = await this.collectLiquidity(tx, asset, mid, command.side, command.userId);
    const quantity = this.resolveQuantity(command, asset, sources);

    const plan = buildMatchPlan({
      side: command.side,
      quantity,
      limitPrice: command.limitPrice ?? null,
      sources,
      takerUserId: command.userId,
      lotSize: asset.lotSize,
    });

    this.assertExecutable(command, asset, plan.filledQuantity, plan.remainingQuantity, mid);

    // Lock every account that will move, in a deterministic order.
    const counterpartyUserIds = plan.executions
      .map((execution) => execution.source.userId)
      .filter((userId): userId is string => Boolean(userId));
    await DatabaseService.lockUsers(tx, [command.userId, ...counterpartyUserIds]);

    const rests = command.timeInForce === 'GTC' && plan.remainingQuantity > 0n;
    const order = await this.repository.insertOrder(tx, {
      userId: command.userId,
      symbol: asset.symbol,
      side: command.side,
      type: command.type,
      timeInForce: command.timeInForce,
      limitPrice: command.limitPrice ?? null,
      quantity,
      status: 'OPEN',
      idempotencyKey: command.idempotencyKey,
    });

    const context: ExecutionContext = { asset, positions: new Map(), events: [] };
    const reserved = await this.reserve(tx, order, plan.filledNotional, rests ? plan.remainingQuantity : 0n);

    const fills: FillRecord[] = [];
    let filledQuantity = 0n;
    let filledNotional = 0n;
    let feesPaid = 0n;
    let cashConsumed = 0n;

    for (const execution of plan.executions) {
      const takerFee = applyBps(execution.notional, this.config.trading.takerFeeBps);
      const fill = await this.settle(tx, context, {
        orderId: order.id,
        userId: command.userId,
        side: command.side,
        quantity: execution.quantity,
        price: execution.price,
        notional: execution.notional,
        fee: takerFee,
        liquidityRole: 'TAKER',
        counterpartyType: execution.source.kind,
        counterOrderId: execution.source.orderId ?? null,
      });
      fills.push(fill);
      filledQuantity += execution.quantity;
      filledNotional += execution.notional;
      feesPaid += takerFee;
      cashConsumed += execution.notional + takerFee;

      if (execution.source.kind === 'USER' && execution.source.orderId) {
        await this.fillMakerOrder(tx, context, execution.source.orderId, execution.quantity, execution.price);
      }
    }

    const finalised = await this.finalise(tx, order, {
      filledQuantity,
      filledNotional,
      feesPaid,
      reservedCash: command.side === 'BUY' ? reserved.cash - cashConsumed : 0n,
      reservedQuantity: command.side === 'SELL' ? reserved.quantity - filledQuantity : 0n,
      rests,
    });

    context.events.push({ type: 'ORDER_UPDATED', userId: command.userId, order: finalised });
    context.events.push({ type: 'BOOK_CHANGED', symbol: asset.symbol });

    return { order: finalised, fills, events: context.events };
  }

  // ---------------------------------------------------------------------------
  // Cancellation
  // ---------------------------------------------------------------------------

  async cancelOrder(tx: Transaction, userId: string, orderId: string): Promise<ExecutionResult> {
    const existing = await this.repository.findOrder(tx, orderId);
    if (!existing || existing.userId !== userId) {
      throw new NotFoundException(ErrorCode.ORDER_NOT_FOUND, `Order ${orderId} was not found.`, {
        orderId,
      });
    }

    await DatabaseService.lockSymbol(tx, existing.symbol);
    await DatabaseService.lockUsers(tx, [userId]);

    // Re-read under the lock: the order may have filled while we were queuing.
    const order = await this.repository.lockOrder(tx, orderId);
    if (!order) {
      throw new NotFoundException(ErrorCode.ORDER_NOT_FOUND, `Order ${orderId} was not found.`, {
        orderId,
      });
    }
    if (!RESTING_STATUSES.includes(order.status)) {
      throw new ConflictException(
        ErrorCode.ORDER_NOT_CANCELLABLE,
        `Order ${orderId} is ${order.status} and can no longer be cancelled.`,
        { orderId, status: order.status },
      );
    }

    await this.releaseReservation(tx, order, 'Cancellation refund');
    const cancelled = await this.repository.updateOrder(tx, order.id, {
      filledQuantity: order.filledQuantity,
      filledNotional: order.filledNotional,
      feesPaid: order.feesPaid,
      reservedCash: 0n,
      reservedQuantity: 0n,
      status: 'CANCELLED',
      rejectReason: null,
    });

    return {
      order: cancelled,
      fills: [],
      events: [
        { type: 'ORDER_UPDATED', userId, order: cancelled },
        { type: 'BOOK_CHANGED', symbol: order.symbol },
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // Tick-driven matching of resting orders
  // ---------------------------------------------------------------------------

  /**
   * Cross resting limit orders against the market as it stands now.
   *
   * Called after each price tick. A resting order is a *maker* — the market came
   * to it — so it pays the maker fee even though this pass is what triggers the
   * execution.
   */
  async matchRestingOrders(tx: Transaction, symbol: string): Promise<ExecutionResult[]> {
    const asset = this.marketData.find(symbol);
    if (!asset || asset.status !== 'ACTIVE') return [];
    if (this.breakers.getState(symbol).tripped) return [];

    await DatabaseService.lockSymbol(tx, symbol);
    const mid = this.marketData.currentPrice(symbol);
    if (mid === undefined) return [];

    const candidates = await this.repository.listRestingOrderIds(tx, symbol);
    const results: ExecutionResult[] = [];

    for (const orderId of candidates.slice(0, MAX_RESTING_ORDERS_PER_TICK)) {
      const order = await this.repository.lockOrder(tx, orderId);
      if (!order || !RESTING_STATUSES.includes(order.status)) continue;

      const result = await this.crossRestingOrder(tx, asset, order, mid);
      if (result) results.push(result);
    }
    return results;
  }

  private async crossRestingOrder(
    tx: Transaction,
    asset: Asset,
    order: OrderRecord,
    mid: bigint,
  ): Promise<ExecutionResult | undefined> {
    const remaining = order.quantity - order.filledQuantity;
    if (remaining <= 0n) return undefined;

    const sources = await this.collectLiquidity(tx, asset, mid, order.side, order.userId);
    const plan = buildMatchPlan({
      side: order.side,
      quantity: remaining,
      limitPrice: order.limitPrice,
      sources,
      takerUserId: order.userId,
      lotSize: asset.lotSize,
    });
    if (plan.executions.length === 0) return undefined;

    const counterpartyUserIds = plan.executions
      .map((execution) => execution.source.userId)
      .filter((userId): userId is string => Boolean(userId));
    await DatabaseService.lockUsers(tx, [order.userId, ...counterpartyUserIds]);

    const context: ExecutionContext = { asset, positions: new Map(), events: [] };
    const fills: FillRecord[] = [];
    let filledQuantity = order.filledQuantity;
    let filledNotional = order.filledNotional;
    let feesPaid = order.feesPaid;
    let cashConsumed = 0n;

    for (const execution of plan.executions) {
      const fee = applyBps(execution.notional, this.config.trading.makerFeeBps);
      const fill = await this.settle(tx, context, {
        orderId: order.id,
        userId: order.userId,
        side: order.side,
        quantity: execution.quantity,
        price: execution.price,
        notional: execution.notional,
        fee,
        liquidityRole: 'MAKER',
        counterpartyType: execution.source.kind,
        counterOrderId: execution.source.orderId ?? null,
      });
      fills.push(fill);
      filledQuantity += execution.quantity;
      filledNotional += execution.notional;
      feesPaid += fee;
      cashConsumed += execution.notional + fee;

      if (execution.source.kind === 'USER' && execution.source.orderId) {
        await this.fillMakerOrder(tx, context, execution.source.orderId, execution.quantity, execution.price);
      }
    }

    const fullyFilled = filledQuantity >= order.quantity;
    let reservedCash = order.side === 'BUY' ? order.reservedCash - cashConsumed : 0n;
    let reservedQuantity = order.side === 'SELL' ? order.reservedQuantity - plan.filledQuantity : 0n;

    if (fullyFilled) {
      await this.releaseReservation(
        tx,
        { ...order, reservedCash, reservedQuantity },
        'Unused reservation released on completion',
      );
      reservedCash = 0n;
      reservedQuantity = 0n;
    }

    const updated = await this.repository.updateOrder(tx, order.id, {
      filledQuantity,
      filledNotional,
      feesPaid,
      reservedCash,
      reservedQuantity,
      status: fullyFilled ? 'FILLED' : 'PARTIALLY_FILLED',
      rejectReason: null,
    });

    context.events.push({ type: 'ORDER_UPDATED', userId: order.userId, order: updated });
    context.events.push({ type: 'BOOK_CHANGED', symbol: asset.symbol });
    return { order: updated, fills, events: context.events };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private assertTradable(symbol: string): Asset {
    const asset = this.marketData.requireAsset(symbol);
    if (asset.status === 'HALTED') {
      throw new MarketHaltedException(
        `Trading in ${asset.symbol} is halted by an administrator.`,
        { symbol: asset.symbol },
      );
    }
    this.breakers.assertTradable(asset.symbol);
    return asset;
  }

  /** Resting user orders on the opposite side, merged with synthetic depth. */
  private async collectLiquidity(
    tx: Transaction,
    asset: Asset,
    mid: bigint,
    side: OrderSide,
    excludeUserId: string,
  ): Promise<LiquiditySource[]> {
    const oppositeSide: OrderSide = side === 'BUY' ? 'SELL' : 'BUY';
    const resting = await this.repository.lockRestingOrders(
      tx,
      asset.symbol,
      oppositeSide,
      excludeUserId,
    );
    const ladder = this.marketData.syntheticLadder(asset, mid);
    const syntheticLevels = side === 'BUY' ? ladder.asks : ladder.bids;

    return [
      ...resting.map<LiquiditySource>((row) => ({
        kind: 'USER',
        price: row.price,
        quantity: row.remaining,
        orderId: row.id,
        userId: row.userId,
        restingSince: row.createdAt,
      })),
      ...syntheticLevels.map<LiquiditySource>((level) => ({
        kind: 'SYNTHETIC',
        price: level.price,
        quantity: level.quantity,
      })),
    ];
  }

  /**
   * Resolve the order size.
   *
   * A market BUY may be expressed in USD. The spendable budget is the request
   * net of the fee it will attract (`gross = budget / (1 + f)`), and the shares
   * it buys are found by walking the same ranked liquidity the plan will use —
   * so the sizing and the execution can never disagree.
   */
  private resolveQuantity(
    command: PlaceOrderCommand,
    asset: Asset,
    sources: readonly LiquiditySource[],
  ): bigint {
    if (command.quantity !== undefined) {
      const quantity = floorToLot(command.quantity, asset.lotSize);
      if (quantity <= 0n) {
        throw new ValidationException(
          `quantity must be at least one lot (${formatQuantity(asset.lotSize)} ${asset.symbol}).`,
          { lotSize: formatQuantity(asset.lotSize) },
        );
      }
      return quantity;
    }

    const budget = (command.notional! * 10_000n) / (10_000n + BigInt(this.config.trading.takerFeeBps));
    const ranked = eligibleSources({
      side: command.side,
      limitPrice: command.limitPrice ?? null,
      sources,
      takerUserId: command.userId,
    });
    const walk = walkForNotional(
      ranked.map((source) => ({ price: source.price, quantity: source.quantity })),
      budget,
    );
    const quantity = floorToLot(walk.quantity, asset.lotSize);
    if (quantity <= 0n) {
      throw new UnprocessableException(
        ErrorCode.NO_LIQUIDITY,
        `$${formatCash(command.notional!)} does not buy a whole lot of ${asset.symbol} at current prices.`,
        { symbol: asset.symbol, usdAmount: formatCash(command.notional!) },
      );
    }
    return quantity;
  }

  private assertExecutable(
    command: PlaceOrderCommand,
    asset: Asset,
    filledQuantity: bigint,
    remainingQuantity: bigint,
    mid: bigint,
  ): void {
    if (command.limitPrice !== undefined && command.limitPrice % asset.tickSize !== 0n) {
      throw new ValidationException(
        `limitPrice must be a multiple of the ${formatPrice(asset.tickSize)} tick size.`,
        { tickSize: formatPrice(asset.tickSize) },
      );
    }

    if (command.type === 'MARKET' && filledQuantity === 0n) {
      throw new UnprocessableException(
        ErrorCode.NO_LIQUIDITY,
        `There is no resting liquidity in ${asset.symbol} to fill this market order.`,
        { symbol: asset.symbol },
      );
    }

    const referencePrice = command.limitPrice ?? mid;
    const orderNotional = notionalOf(referencePrice, filledQuantity + remainingQuantity);
    if (orderNotional < asset.minOrderNotional) {
      throw new ValidationException(
        `Order notional $${formatCash(orderNotional)} is below the $${formatCash(asset.minOrderNotional)} minimum for ${asset.symbol}.`,
        {
          notional: formatCash(orderNotional),
          minimum: formatCash(asset.minOrderNotional),
        },
      );
    }
  }

  /**
   * Move cash or shares from the free balance into the reserved balance.
   *
   * A BUY reserves the notional it expects to spend plus the taker fee it may
   * attract; anything unspent is released when the order terminates, so price
   * improvement flows back to the user. A SELL reserves the shares themselves,
   * which is what stops the same shares being sold twice by two concurrent
   * orders.
   */
  private async reserve(
    tx: Transaction,
    order: OrderRecord,
    immediateNotional: bigint,
    restingQuantity: bigint,
  ): Promise<{ cash: bigint; quantity: bigint }> {
    if (order.side === 'BUY') {
      const restingNotional =
        restingQuantity > 0n && order.limitPrice !== null
          ? notionalOf(order.limitPrice, restingQuantity)
          : 0n;
      const base = immediateNotional + restingNotional;
      const cash = base + applyBps(base, this.config.trading.takerFeeBps);
      if (cash > 0n) {
        await this.ledger.post(tx, [
          {
            userId: order.userId,
            account: 'CASH',
            assetSymbol: null,
            delta: -cash,
            entryType: 'ORDER_RESERVE',
            refType: 'ORDER',
            refId: order.id,
            memo: `Reserved for ${order.side} ${order.symbol}`,
          },
          {
            userId: order.userId,
            account: 'CASH_RESERVED',
            assetSymbol: null,
            delta: cash,
            entryType: 'ORDER_RESERVE',
            refType: 'ORDER',
            refId: order.id,
            memo: `Reserved for ${order.side} ${order.symbol}`,
          },
        ]);
      }
      return { cash, quantity: 0n };
    }

    const quantity = order.quantity;
    await this.ledger.post(tx, [
      {
        userId: order.userId,
        account: 'POSITION',
        assetSymbol: order.symbol,
        delta: -quantity,
        entryType: 'ORDER_RESERVE',
        refType: 'ORDER',
        refId: order.id,
        memo: `Reserved for SELL ${order.symbol}`,
      },
      {
        userId: order.userId,
        account: 'POSITION_RESERVED',
        assetSymbol: order.symbol,
        delta: quantity,
        entryType: 'ORDER_RESERVE',
        refType: 'ORDER',
        refId: order.id,
        memo: `Reserved for SELL ${order.symbol}`,
      },
    ]);
    return { cash: 0n, quantity };
  }

  /** Return anything still reserved to the free balance. */
  private async releaseReservation(
    tx: Transaction,
    order: Pick<OrderRecord, 'id' | 'userId' | 'symbol' | 'reservedCash' | 'reservedQuantity'>,
    memo: string,
  ): Promise<void> {
    const postings: LedgerPosting[] = [];
    if (order.reservedCash > 0n) {
      postings.push(
        {
          userId: order.userId,
          account: 'CASH_RESERVED',
          assetSymbol: null,
          delta: -order.reservedCash,
          entryType: 'ORDER_RELEASE',
          refType: 'ORDER',
          refId: order.id,
          memo,
        },
        {
          userId: order.userId,
          account: 'CASH',
          assetSymbol: null,
          delta: order.reservedCash,
          entryType: 'ORDER_RELEASE',
          refType: 'ORDER',
          refId: order.id,
          memo,
        },
      );
    }
    if (order.reservedQuantity > 0n) {
      postings.push(
        {
          userId: order.userId,
          account: 'POSITION_RESERVED',
          assetSymbol: order.symbol,
          delta: -order.reservedQuantity,
          entryType: 'ORDER_RELEASE',
          refType: 'ORDER',
          refId: order.id,
          memo,
        },
        {
          userId: order.userId,
          account: 'POSITION',
          assetSymbol: order.symbol,
          delta: order.reservedQuantity,
          entryType: 'ORDER_RELEASE',
          refType: 'ORDER',
          refId: order.id,
          memo,
        },
      );
    }
    if (postings.length > 0) await this.ledger.post(tx, postings);
  }

  /**
   * Settle one side of a trade: ledger postings, position state, fill row.
   *
   * A BUY draws from `CASH_RESERVED` (never from free cash) and credits
   * `POSITION`. A SELL draws from `POSITION_RESERVED` and credits `CASH`. Fees
   * are their own posting so a statement can separate trading cost from
   * principal.
   */
  private async settle(
    tx: Transaction,
    context: ExecutionContext,
    params: {
      orderId: string;
      userId: string;
      side: OrderSide;
      quantity: bigint;
      price: bigint;
      notional: bigint;
      fee: bigint;
      liquidityRole: 'TAKER' | 'MAKER';
      counterpartyType: 'USER' | 'SYNTHETIC';
      counterOrderId: string | null;
    },
  ): Promise<FillRecord> {
    const { userId, side, quantity, price, notional, fee, orderId } = params;
    const symbol = context.asset.symbol;
    const memo = `${side} ${formatQuantity(quantity)} ${symbol} @ ${formatPrice(price)}`;

    const postings: LedgerPosting[] =
      side === 'BUY'
        ? [
            {
              userId,
              account: 'CASH_RESERVED',
              assetSymbol: null,
              delta: -notional,
              entryType: 'TRADE_BUY',
              refType: 'FILL',
              refId: orderId,
              memo,
            },
            {
              userId,
              account: 'POSITION',
              assetSymbol: symbol,
              delta: quantity,
              entryType: 'TRADE_BUY',
              refType: 'FILL',
              refId: orderId,
              memo,
            },
            ...(fee > 0n
              ? [
                  {
                    userId,
                    account: 'CASH_RESERVED' as const,
                    assetSymbol: null,
                    delta: -fee,
                    entryType: 'FEE' as const,
                    refType: 'FILL' as const,
                    refId: orderId,
                    memo: `Trading fee — ${memo}`,
                  },
                ]
              : []),
          ]
        : [
            {
              userId,
              account: 'POSITION_RESERVED',
              assetSymbol: symbol,
              delta: -quantity,
              entryType: 'TRADE_SELL',
              refType: 'FILL',
              refId: orderId,
              memo,
            },
            {
              userId,
              account: 'CASH',
              assetSymbol: null,
              delta: notional,
              entryType: 'TRADE_SELL',
              refType: 'FILL',
              refId: orderId,
              memo,
            },
            ...(fee > 0n
              ? [
                  {
                    userId,
                    account: 'CASH' as const,
                    assetSymbol: null,
                    delta: -fee,
                    entryType: 'FEE' as const,
                    refType: 'FILL' as const,
                    refId: orderId,
                    memo: `Trading fee — ${memo}`,
                  },
                ]
              : []),
          ];

    await this.ledger.post(tx, postings);

    const key = `${userId}:${symbol}`;
    const current =
      context.positions.get(key) ??
      (await this.repository.loadPosition(tx, userId, symbol)) ??
      EMPTY_POSITION;
    const next = applyFill(current, { side, quantity, price, fee });
    context.positions.set(key, next);

    const fill = await this.repository.insertFill(tx, {
      orderId,
      userId,
      symbol,
      side,
      quantity,
      price,
      notional,
      fee,
      liquidityRole: params.liquidityRole,
      counterpartyType: params.counterpartyType,
      counterOrderId: params.counterOrderId,
      position: next,
    });

    context.events.push({ type: 'FILL', userId, symbol, fill });
    return fill;
  }

  /** Apply the counterparty side of an internal match to the resting order. */
  private async fillMakerOrder(
    tx: Transaction,
    context: ExecutionContext,
    makerOrderId: string,
    quantity: bigint,
    price: bigint,
  ): Promise<void> {
    const maker = await this.repository.lockOrder(tx, makerOrderId);
    if (!maker) return;

    const notional = notionalOf(price, quantity);
    const fee = applyBps(notional, this.config.trading.makerFeeBps);

    await this.settle(tx, context, {
      orderId: maker.id,
      userId: maker.userId,
      side: maker.side,
      quantity,
      price,
      notional,
      fee,
      liquidityRole: 'MAKER',
      counterpartyType: 'USER',
      counterOrderId: null,
    });

    const filledQuantity = maker.filledQuantity + quantity;
    const fullyFilled = filledQuantity >= maker.quantity;
    let reservedCash = maker.side === 'BUY' ? maker.reservedCash - (notional + fee) : 0n;
    let reservedQuantity = maker.side === 'SELL' ? maker.reservedQuantity - quantity : 0n;

    if (fullyFilled) {
      await this.releaseReservation(
        tx,
        { ...maker, reservedCash, reservedQuantity },
        'Unused reservation released on completion',
      );
      reservedCash = 0n;
      reservedQuantity = 0n;
    }

    const updated = await this.repository.updateOrder(tx, maker.id, {
      filledQuantity,
      filledNotional: maker.filledNotional + notional,
      feesPaid: maker.feesPaid + fee,
      reservedCash,
      reservedQuantity,
      status: fullyFilled ? 'FILLED' : 'PARTIALLY_FILLED',
      rejectReason: null,
    });

    context.events.push({ type: 'ORDER_UPDATED', userId: maker.userId, order: updated });
  }

  /** Decide the terminal (or resting) state of the taker order and settle leftovers. */
  private async finalise(
    tx: Transaction,
    order: OrderRecord,
    outcome: {
      filledQuantity: bigint;
      filledNotional: bigint;
      feesPaid: bigint;
      reservedCash: bigint;
      reservedQuantity: bigint;
      rests: boolean;
    },
  ): Promise<OrderRecord> {
    const fullyFilled = outcome.filledQuantity >= order.quantity;
    let status: OrderStatus;
    if (fullyFilled) {
      status = 'FILLED';
    } else if (outcome.rests) {
      status = outcome.filledQuantity > 0n ? 'PARTIALLY_FILLED' : 'OPEN';
    } else {
      // Immediate-or-cancel: whatever did not fill right now never will.
      status = 'CANCELLED';
    }

    let { reservedCash, reservedQuantity } = outcome;
    if (!outcome.rests || fullyFilled) {
      await this.releaseReservation(
        tx,
        { ...order, reservedCash, reservedQuantity },
        fullyFilled ? 'Unused reservation released on completion' : 'Unfilled remainder released',
      );
      reservedCash = 0n;
      reservedQuantity = 0n;
    }

    return this.repository.updateOrder(tx, order.id, {
      filledQuantity: outcome.filledQuantity,
      filledNotional: outcome.filledNotional,
      feesPaid: outcome.feesPaid,
      reservedCash,
      reservedQuantity,
      status,
      rejectReason:
        status === 'CANCELLED' && outcome.filledQuantity < order.quantity
          ? 'Unfilled remainder cancelled (immediate-or-cancel)'
          : null,
    });
  }

  /** Volume-weighted average price of an order's executions. */
  static averageFillPrice(order: OrderRecord): bigint {
    return order.filledQuantity > 0n ? priceOf(order.filledNotional, order.filledQuantity) : 0n;
  }

  /** Exposed for diagnostics: how much of an order is still working. */
  static remainingQuantity(order: OrderRecord): bigint {
    return minBigInt(order.quantity - order.filledQuantity, order.quantity);
  }
}
