import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Subject, Subscription } from 'rxjs';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { CircuitBreakerException } from '../common/errors';
import { SlidingWindowExtrema } from '../common/sliding-window-extrema';
import { formatPrice } from '../common/money';
import { DatabaseService } from '../database/database.service';
import { PriceEngineService } from './price-engine.service';

export interface BreakerState {
  readonly symbol: string;
  readonly tripped: boolean;
  readonly moveBps: number;
  readonly thresholdBps: number;
  readonly windowMs: number;
  readonly cooldownMs: number;
  readonly resumesAt?: Date;
  readonly referencePrice?: bigint;
  readonly extremePrice?: bigint;
}

interface SymbolBreaker {
  readonly window: SlidingWindowExtrema;
  trippedUntil: number;
  lastMoveBps: number;
  referencePrice?: bigint;
  extremePrice?: bigint;
}

/**
 * Volatility circuit breaker.
 *
 * Rule: if the price of an asset moves more than `thresholdBps` (default 1500 =
 * 15%) at any point inside a rolling `windowMs` (default 60s), new orders on
 * that asset are rejected for `cooldownMs` (default 30s).
 *
 * "Moved 15%" is measured as the full peak-to-trough range inside the window
 * relative to the trough, not merely first-tick-to-last-tick. A price that
 * spikes 20% and retraces has still dislocated, and a first-to-last comparison
 * would miss it entirely.
 *
 * The range query runs on every order placement, so it must not be a window
 * rescan. Two monotonic deques (see `SlidingWindowExtrema`) give O(1) amortised
 * insertion and O(1) extrema lookup regardless of tick rate.
 *
 * State is in-process — this is a single-node engine. Trips are persisted for
 * audit and so the asset endpoint can still report a live trip after a restart.
 */
@Injectable()
export class CircuitBreakerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private readonly breakers = new Map<string, SymbolBreaker>();
  private readonly trips$ = new Subject<BreakerState>();
  private subscription?: Subscription;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: DatabaseService,
    private readonly priceEngine: PriceEngineService,
  ) {}

  get trips() {
    return this.trips$.asObservable();
  }

  onApplicationBootstrap(): void {
    this.subscription = this.priceEngine.updates.subscribe((update) => {
      this.observe(update.symbol, update.price, update.at.getTime());
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
    this.trips$.complete();
  }

  /** Record a price observation and trip the breaker if the window range breaches. */
  observe(symbol: string, price: bigint, at: number = Date.now()): BreakerState {
    const breaker = this.breakerFor(symbol);
    breaker.window.push(Number(price), at);

    const high = breaker.window.max;
    const low = breaker.window.min;
    if (!high || !low || low.value <= 0) return this.stateOf(symbol, breaker, at);

    const moveBps = Math.round(((high.value - low.value) / low.value) * 10_000);
    breaker.lastMoveBps = moveBps;

    const { thresholdBps, cooldownMs, windowMs } = this.config.circuitBreaker;
    if (moveBps >= thresholdBps && at >= breaker.trippedUntil) {
      breaker.trippedUntil = at + cooldownMs;
      breaker.referencePrice = BigInt(Math.round(low.value));
      breaker.extremePrice = BigInt(Math.round(high.value));

      const state = this.stateOf(symbol, breaker, at);
      this.logger.warn(
        `circuit breaker tripped on ${symbol}: ${(moveBps / 100).toFixed(2)}% range ` +
          `($${formatPrice(breaker.referencePrice)} → $${formatPrice(breaker.extremePrice)}) ` +
          `within ${windowMs}ms; trading resumes at ${new Date(breaker.trippedUntil).toISOString()}`,
      );
      this.trips$.next(state);
      void this.persist(symbol, moveBps, breaker);
      return state;
    }

    return this.stateOf(symbol, breaker, at);
  }

  /** Reject the order if the asset is currently halted by the breaker. */
  assertTradable(symbol: string, at: number = Date.now()): void {
    const breaker = this.breakers.get(symbol);
    if (!breaker || at >= breaker.trippedUntil) return;

    const resumesAt = new Date(breaker.trippedUntil);
    throw new CircuitBreakerException(
      `Trading in ${symbol} is paused: the price moved ${(breaker.lastMoveBps / 100).toFixed(2)}% ` +
        `within ${this.config.circuitBreaker.windowMs / 1000}s. Orders resume at ${resumesAt.toISOString()}.`,
      {
        symbol,
        moveBps: breaker.lastMoveBps,
        thresholdBps: this.config.circuitBreaker.thresholdBps,
        resumesAt: resumesAt.toISOString(),
        retryAfterMs: breaker.trippedUntil - at,
      },
    );
  }

  getState(symbol: string, at: number = Date.now()): BreakerState {
    return this.stateOf(symbol, this.breakerFor(symbol), at);
  }

  /** Test and operations hook: clear breaker state for one symbol or all of them. */
  reset(symbol?: string): void {
    if (symbol) {
      this.breakers.delete(symbol);
      return;
    }
    this.breakers.clear();
  }

  private breakerFor(symbol: string): SymbolBreaker {
    let breaker = this.breakers.get(symbol);
    if (!breaker) {
      breaker = {
        window: new SlidingWindowExtrema(this.config.circuitBreaker.windowMs),
        trippedUntil: 0,
        lastMoveBps: 0,
      };
      this.breakers.set(symbol, breaker);
    }
    return breaker;
  }

  private stateOf(symbol: string, breaker: SymbolBreaker, at: number): BreakerState {
    const tripped = at < breaker.trippedUntil;
    return {
      symbol,
      tripped,
      moveBps: breaker.lastMoveBps,
      thresholdBps: this.config.circuitBreaker.thresholdBps,
      windowMs: this.config.circuitBreaker.windowMs,
      cooldownMs: this.config.circuitBreaker.cooldownMs,
      resumesAt: tripped ? new Date(breaker.trippedUntil) : undefined,
      referencePrice: breaker.referencePrice,
      extremePrice: breaker.extremePrice,
    };
  }

  private async persist(symbol: string, moveBps: number, breaker: SymbolBreaker): Promise<void> {
    try {
      await this.database.db.execute(sql`
        INSERT INTO circuit_breaker_events
          (symbol, move_bps, threshold_bps, window_ms, reference_price, extreme_price, expires_at)
        VALUES
          (${symbol}::text, ${moveBps}::int, ${this.config.circuitBreaker.thresholdBps}::int,
           ${this.config.circuitBreaker.windowMs}::int,
           ${(breaker.referencePrice ?? 0n).toString()}::bigint,
           ${(breaker.extremePrice ?? 0n).toString()}::bigint,
           ${new Date(breaker.trippedUntil).toISOString()}::timestamptz)
      `);
    } catch (error) {
      // Audit persistence must never block trading control flow.
      this.logger.error(
        `failed to persist circuit breaker event for ${symbol}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
