import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { bpsBetween, formatPrice, parsePrice } from '../common/money';
import { asDate } from '../common/rows';
import { CircuitBreakerService } from '../assets/circuit-breaker.service';
import { MarketDataService } from '../assets/market-data.service';
import { PriceEngineService } from '../assets/price-engine.service';
import { DatabaseService } from '../database/database.service';
import { TradingEventsService } from '../realtime/trading-events.service';
import { MarketControlResultDto, PriceShockResultDto } from './dto/admin.dto';

/**
 * Administrative market controls.
 *
 * A halt is a hard stop that only an operator can lift, distinct from the
 * circuit breaker, which trips and clears on its own. Both reject new orders;
 * only the halt survives a restart, because it is persisted on the asset.
 */
@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly marketData: MarketDataService,
    private readonly priceEngine: PriceEngineService,
    private readonly breakers: CircuitBreakerService,
    private readonly events: TradingEventsService,
  ) {}

  async setStatus(
    actorUserId: string,
    symbol: string,
    status: 'ACTIVE' | 'HALTED',
    reason: string,
  ): Promise<MarketControlResultDto> {
    const asset = this.marketData.requireAsset(symbol);

    const result = await this.database.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE assets SET status = ${status}::text WHERE symbol = ${asset.symbol}::text
      `);
      const inserted = await tx.execute(sql`
        INSERT INTO asset_status_events (symbol, status, reason, actor_user_id)
        VALUES (${asset.symbol}::text, ${status}::text, ${reason}::text, ${actorUserId}::uuid)
        RETURNING created_at
      `);
      return inserted.rows[0] as unknown as { created_at: string };
    });

    await this.marketData.refresh();
    this.priceEngine.setStatus(asset.symbol, status);
    this.events.publish([{ type: 'BOOK_CHANGED', symbol: asset.symbol }]);
    this.logger.warn(`${asset.symbol} set to ${status} by ${actorUserId}: ${reason || 'no reason given'}`);

    return {
      symbol: asset.symbol,
      status,
      reason,
      at: asDate(result.created_at).toISOString(),
    };
  }

  /**
   * Publish an out-of-band mark.
   *
   * A simulation control, not a trading primitive: it exists so volatility-driven
   * behaviour — the circuit breaker above all — can be demonstrated and tested
   * without waiting for the random walk to produce a 15% move on its own.
   */
  async shockPrice(symbol: string, price: string): Promise<PriceShockResultDto> {
    const asset = this.marketData.requireAsset(symbol);
    const target = parsePrice(price, 'price');
    const update = await this.priceEngine.publishPrice(asset.symbol, target);

    const breaker = this.breakers.getState(asset.symbol);
    return {
      symbol: asset.symbol,
      previousPrice: formatPrice(update.previousPrice),
      price: formatPrice(update.price),
      moveBps: bpsBetween(update.previousPrice, update.price),
      circuitBreakerTripped: breaker.tripped,
      at: update.at.toISOString(),
    };
  }
}
