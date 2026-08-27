import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Subject } from 'rxjs';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { SeededRandom, hashString } from '../common/random';
import { DatabaseService } from '../database/database.service';
import { PRICE_SCALE, maxBigInt, roundToTick } from '../common/money';
import { asBigInt, asDate } from '../common/rows';

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;
/** Prices are floored here so a pathological random walk can never reach zero. */
const MIN_PRICE = 1_000n; // $0.001

export interface PriceUpdate {
  readonly symbol: string;
  readonly price: bigint;
  readonly previousPrice: bigint;
  readonly at: Date;
}

interface AssetParameters {
  readonly symbol: string;
  readonly annualDrift: number;
  readonly annualVol: number;
  readonly tickSize: bigint;
  status: 'ACTIVE' | 'HALTED';
}

/**
 * Simulated market data, driven by geometric Brownian motion.
 *
 *   S(t+dt) = S(t) · exp( (μ − σ²/2)·dt + σ·√dt·Z ),  Z ~ N(0,1)
 *
 * GBM is used rather than a random walk on the price itself because it is
 * multiplicative: prices stay strictly positive, and a 1% move costs the same
 * in log space at $95 as it does at $420, which is how equities actually
 * behave. The −σ²/2 term is the Itô correction that keeps the *expected*
 * return equal to μ rather than μ + σ²/2.
 *
 * The generator is seeded, so a given `PRICE_RANDOM_SEED` replays the exact
 * same market — which is what makes the price path reproducible in tests.
 */
@Injectable()
export class PriceEngineService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PriceEngineService.name);
  private readonly prices = new Map<string, bigint>();
  private readonly parameters = new Map<string, AssetParameters>();
  private readonly generators = new Map<string, SeededRandom>();
  private readonly updates$ = new Subject<PriceUpdate>();
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: DatabaseService,
  ) {}

  /** Stream of every price change, consumed by the WebSocket gateway and the circuit breaker. */
  get updates() {
    return this.updates$.asObservable();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.load();
    if (this.config.market.engineEnabled) {
      this.timer = setInterval(() => void this.tick(), this.config.market.tickIntervalMs);
      this.timer.unref();
      this.logger.log(
        `price engine started: ${this.parameters.size} assets, ${this.config.market.tickIntervalMs}ms tick, seed ${this.config.market.randomSeed}`,
      );
    } else {
      this.logger.log('price engine disabled; prices are frozen at their last recorded tick');
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.updates$.complete();
  }

  /** (Re)load asset parameters and last known prices from the database. */
  async load(): Promise<void> {
    const assets = await this.database.db.execute(sql`
      SELECT a.symbol,
             a.annual_drift_bps,
             a.annual_vol_bps,
             a.tick_size,
             a.status,
             a.initial_price,
             (SELECT price FROM price_ticks t
               WHERE t.symbol = a.symbol
               ORDER BY t.created_at DESC, t.id DESC
               LIMIT 1) AS last_price
      FROM assets a
      ORDER BY a.symbol
    `);

    for (const raw of assets.rows as unknown as Array<{
      symbol: string;
      annual_drift_bps: number | string;
      annual_vol_bps: number | string;
      tick_size: string;
      status: 'ACTIVE' | 'HALTED';
      initial_price: string;
      last_price: string | null;
    }>) {
      this.parameters.set(raw.symbol, {
        symbol: raw.symbol,
        annualDrift: Number(raw.annual_drift_bps) / 10_000,
        annualVol: Number(raw.annual_vol_bps) / 10_000,
        tickSize: asBigInt(raw.tick_size),
        status: raw.status,
      });
      this.prices.set(raw.symbol, asBigInt(raw.last_price ?? raw.initial_price));
      this.generators.set(
        raw.symbol,
        new SeededRandom(this.config.market.randomSeed ^ hashString(raw.symbol)),
      );
    }
  }

  getPrice(symbol: string): bigint | undefined {
    return this.prices.get(symbol);
  }

  getPrices(): ReadonlyMap<string, bigint> {
    return this.prices;
  }

  setStatus(symbol: string, status: 'ACTIVE' | 'HALTED'): void {
    const parameters = this.parameters.get(symbol);
    if (parameters) parameters.status = status;
  }

  /**
   * Publish an out-of-band mark for an asset.
   *
   * Used by the administrative price-shock control, which exists so that
   * volatility-driven behaviour (the circuit breaker in particular) can be
   * demonstrated and tested without waiting for the random walk to cooperate.
   */
  async publishPrice(symbol: string, price: bigint): Promise<PriceUpdate> {
    const parameters = this.parameters.get(symbol);
    if (!parameters) throw new Error(`Unknown asset ${symbol}`);
    const clamped = maxBigInt(roundToTick(price, parameters.tickSize), MIN_PRICE);
    return this.commit(symbol, clamped);
  }

  /** Advance every active asset by one simulated step. */
  async tick(): Promise<void> {
    if (this.ticking) return; // A slow database write must not overlap the next tick.
    this.ticking = true;
    try {
      const dt =
        (this.config.market.tickIntervalMs * this.config.market.timeAcceleration) / MS_PER_YEAR;
      for (const parameters of this.parameters.values()) {
        if (parameters.status !== 'ACTIVE') continue;
        const next = this.nextPrice(parameters, dt);
        await this.commit(parameters.symbol, next);
      }
    } catch (error) {
      this.logger.error('price tick failed', error instanceof Error ? error.stack : String(error));
    } finally {
      this.ticking = false;
    }
  }

  private nextPrice(parameters: AssetParameters, dt: number): bigint {
    const current = this.prices.get(parameters.symbol) ?? MIN_PRICE;
    const random = this.generators.get(parameters.symbol)!;
    const { annualDrift: mu, annualVol: sigma } = parameters;

    const exponent =
      (mu - (sigma * sigma) / 2) * dt + sigma * Math.sqrt(dt) * random.nextGaussian();
    const multiplier = Math.exp(exponent);

    // Multiply in fixed point: scale the multiplier by PRICE_SCALE, then divide back out.
    const scaledMultiplier = BigInt(Math.round(multiplier * Number(PRICE_SCALE)));
    const next = (current * scaledMultiplier) / PRICE_SCALE;
    return maxBigInt(roundToTick(next, parameters.tickSize), MIN_PRICE);
  }

  private async commit(symbol: string, price: bigint): Promise<PriceUpdate> {
    const previousPrice = this.prices.get(symbol) ?? price;
    const inserted = await this.database.db.execute(sql`
      INSERT INTO price_ticks (symbol, price)
      VALUES (${symbol}::text, ${price.toString()}::bigint)
      RETURNING created_at
    `);
    const at = asDate((inserted.rows[0] as unknown as { created_at: string }).created_at);

    this.prices.set(symbol, price);
    const update: PriceUpdate = { symbol, price, previousPrice, at };
    this.updates$.next(update);
    return update;
  }
}
