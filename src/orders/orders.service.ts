import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import {
  DomainException,
  ErrorCode,
  NotFoundException,
  ValidationException,
} from '../common/errors';
import { parseCash, parsePrice, parseQuantity } from '../common/money';
import { DatabaseService } from '../database/database.service';
import { TradingEventsService } from '../realtime/trading-events.service';
import { IdempotencyService } from './idempotency.service';
import { MatchingEngineService } from './matching-engine.service';
import { OrdersRepository } from './orders.repository';
import { ORDERS_ENDPOINT, OrderRecord, PlaceOrderCommand } from './order.types';
import {
  OrderDto,
  OrderListQueryDto,
  PlaceOrderDto,
  TradeDto,
  TradeListQueryDto,
} from './dto/order.dto';
import { toOrderDto, toTradeDto } from './orders.mapper';

export interface PlacementOutcome {
  readonly order: OrderDto;
  /** True when the response was replayed from a previous request with the same key. */
  readonly replayed: boolean;
}

/**
 * Orchestration around the matching engine: request validation, idempotency,
 * transaction boundaries and post-commit event publication.
 *
 * The engine itself stays free of HTTP concerns; everything that is about
 * *requests* rather than *trading* lives here.
 */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: DatabaseService,
    private readonly engine: MatchingEngineService,
    private readonly repository: OrdersRepository,
    private readonly idempotency: IdempotencyService,
    private readonly events: TradingEventsService,
  ) {}

  async place(
    userId: string,
    dto: PlaceOrderDto,
    idempotencyKey: string,
  ): Promise<PlacementOutcome> {
    const command = this.toCommand(userId, dto, idempotencyKey);
    const requestHash = IdempotencyService.hashRequest(dto);

    const begin = await this.idempotency.begin(
      userId,
      ORDERS_ENDPOINT,
      idempotencyKey,
      requestHash,
    );
    if (begin.outcome === 'REPLAY') {
      if (begin.status >= 400) throw replayedError(begin.status, begin.body);
      return { order: begin.body as OrderDto, replayed: true };
    }

    try {
      const result = await this.database.transaction((tx) => this.engine.placeOrder(tx, command));
      const dtoResult = toOrderDto(result.order, result.fills);

      await this.idempotency.complete(userId, ORDERS_ENDPOINT, idempotencyKey, 201, dtoResult);
      // Published only after the transaction commits, so a subscriber can never
      // observe a fill that later rolls back.
      this.events.publish(result.events);
      return { order: dtoResult, replayed: false };
    } catch (error) {
      if (error instanceof DomainException) {
        // A deliberate rejection is a real outcome: record it so replaying the
        // same key returns the same rejection instead of re-running the engine.
        await this.idempotency.complete(
          userId,
          ORDERS_ENDPOINT,
          idempotencyKey,
          error.getStatus(),
          {
            code: error.code,
            message: error.message,
            details: error.details,
          },
        );
        throw error;
      }
      // Unexpected failure: drop the marker so the client may safely retry.
      await this.idempotency.release(userId, ORDERS_ENDPOINT, idempotencyKey);
      throw error;
    }
  }

  async cancel(userId: string, orderId: string): Promise<OrderDto> {
    const result = await this.database.transaction((tx) =>
      this.engine.cancelOrder(tx, userId, orderId),
    );
    const fills = await this.repository.listFillsForOrder(this.database.db, orderId);
    this.events.publish(result.events);
    return toOrderDto(result.order, fills);
  }

  async findOne(userId: string, orderId: string): Promise<OrderDto> {
    const order = await this.repository.findOrder(this.database.db, orderId);
    if (!order || order.userId !== userId) {
      throw new NotFoundException(ErrorCode.ORDER_NOT_FOUND, `Order ${orderId} was not found.`, {
        orderId,
      });
    }
    const fills = await this.repository.listFillsForOrder(this.database.db, orderId);
    return toOrderDto(order, fills);
  }

  async list(userId: string, query: OrderListQueryDto): Promise<OrderDto[]> {
    const orders = await this.repository.listOrders(this.database.db, userId, {
      symbol: query.symbol,
      status: query.status,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });
    return Promise.all(
      orders.map(async (order: OrderRecord) =>
        toOrderDto(order, await this.repository.listFillsForOrder(this.database.db, order.id)),
      ),
    );
  }

  async listTrades(userId: string, query: TradeListQueryDto): Promise<TradeDto[]> {
    const fills = await this.repository.listFillsForUser(this.database.db, userId, {
      symbol: query.symbol,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });
    return fills.map(toTradeDto);
  }

  /**
   * Run the tick matcher for one symbol.
   *
   * Failures are logged and swallowed: a resting order that cannot be crossed
   * this tick will be retried on the next one, and a background pass must never
   * take the price engine down with it.
   */
  async runRestingMatch(symbol: string): Promise<void> {
    try {
      const results = await this.database.transaction((tx) =>
        this.engine.matchRestingOrders(tx, symbol),
      );
      for (const result of results) this.events.publish(result.events);
    } catch (error) {
      this.logger.error(
        `resting order match failed for ${symbol}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * Translate a request into an engine command, rejecting combinations that are
   * meaningless before any state is touched.
   */
  private toCommand(userId: string, dto: PlaceOrderDto, idempotencyKey: string): PlaceOrderCommand {
    const type = dto.type;
    const side = dto.side;
    const timeInForce = dto.timeInForce ?? (type === 'MARKET' ? 'IOC' : 'GTC');

    if (type === 'MARKET' && timeInForce === 'GTC') {
      throw new ValidationException(
        'A MARKET order cannot rest on the book; use timeInForce IOC or place a LIMIT order.',
      );
    }
    if (type === 'MARKET' && dto.limitPrice !== undefined) {
      throw new ValidationException('`limitPrice` is only valid on a LIMIT order.');
    }
    if (type === 'LIMIT' && dto.limitPrice === undefined) {
      throw new ValidationException('`limitPrice` is required for a LIMIT order.');
    }
    if (dto.quantity === undefined && dto.usdAmount === undefined) {
      throw new ValidationException('Provide either `quantity` or `usdAmount`.');
    }
    if (dto.quantity !== undefined && dto.usdAmount !== undefined) {
      throw new ValidationException('`quantity` and `usdAmount` are mutually exclusive.');
    }
    if (dto.usdAmount !== undefined && !(type === 'MARKET' && side === 'BUY')) {
      throw new ValidationException(
        '`usdAmount` is only supported for MARKET BUY orders. Use `quantity` otherwise.',
      );
    }

    const quantity =
      dto.quantity !== undefined ? parseQuantity(dto.quantity, 'quantity') : undefined;
    const notional =
      dto.usdAmount !== undefined ? parseCash(dto.usdAmount, 'usdAmount') : undefined;
    const limitPrice =
      dto.limitPrice !== undefined ? parsePrice(dto.limitPrice, 'limitPrice') : undefined;

    if (quantity !== undefined && quantity <= 0n) {
      throw new ValidationException('`quantity` must be greater than zero.');
    }
    if (notional !== undefined && notional <= 0n) {
      throw new ValidationException('`usdAmount` must be greater than zero.');
    }
    if (limitPrice !== undefined && limitPrice <= 0n) {
      throw new ValidationException('`limitPrice` must be greater than zero.');
    }

    return {
      userId,
      symbol: dto.symbol.trim(),
      side,
      type,
      timeInForce,
      limitPrice,
      quantity,
      notional,
      idempotencyKey,
    };
  }

  /** Exposed for the console UI so it can show the configured fee schedule. */
  get feeSchedule() {
    return {
      takerFeeBps: this.config.trading.takerFeeBps,
      makerFeeBps: this.config.trading.makerFeeBps,
    };
  }
}

function replayedError(status: number, body: unknown): DomainException {
  const payload = (body ?? {}) as {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
  return new DomainException(
    (payload.code as ErrorCode) ?? ErrorCode.INTERNAL_ERROR,
    payload.message ?? 'The original request failed.',
    status,
    payload.details,
  );
}
