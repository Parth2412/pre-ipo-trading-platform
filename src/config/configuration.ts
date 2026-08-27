/**
 * Central, strongly typed application configuration.
 *
 * Everything the platform can be tuned with lives here so that behaviour is
 * reproducible: the price simulation is seeded, the circuit breaker thresholds
 * are explicit, and tests can freeze the market by flipping a single flag.
 */
export interface AppConfig {
  readonly env: 'development' | 'test' | 'production';
  readonly port: number;
  readonly database: {
    readonly url: string;
    readonly poolMax: number;
  };
  readonly auth: {
    readonly jwtSecret: string;
    readonly jwtExpiresIn: string;
    /** Stablecoin credited to a new account, in whole USD. */
    readonly signupBonusUsd: number;
  };
  readonly market: {
    readonly tickIntervalMs: number;
    readonly randomSeed: number;
    readonly engineEnabled: boolean;
    /**
     * How many seconds of *market* time elapse per second of wall time.
     *
     * Real annualised volatility spread over real seconds produces moves far
     * too small to be interesting in a demo — a 70%-vol name drifts by ~10 bps
     * a minute. Compressing time (default: one wall second = one market hour)
     * keeps the GBM mathematics honest while making the market observably live.
     */
    readonly timeAcceleration: number;
    /** Synthetic book: number of price levels quoted per side. */
    readonly bookLevels: number;
    /** Synthetic book: target resting notional per level, in whole USD. */
    readonly bookNotionalPerLevelUsd: number;
    /** Synthetic book: baseline quoted spread in basis points. */
    readonly bookSpreadBps: number;
  };
  readonly trading: {
    readonly takerFeeBps: number;
    readonly makerFeeBps: number;
  };
  readonly circuitBreaker: {
    readonly thresholdBps: number;
    readonly windowMs: number;
    readonly cooldownMs: number;
  };
  readonly rateLimit: {
    readonly ttlMs: number;
    readonly limit: number;
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be numeric, received "${raw}"`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

export function loadConfiguration(): AppConfig {
  const env = (process.env.NODE_ENV ?? 'development') as AppConfig['env'];
  const databaseUrl =
    env === 'test'
      ? (process.env.TEST_DATABASE_URL ?? required('DATABASE_URL'))
      : required('DATABASE_URL');

  return {
    env,
    port: num('PORT', 3000),
    database: {
      url: databaseUrl,
      poolMax: num('DATABASE_POOL_MAX', 20),
    },
    auth: {
      jwtSecret:
        process.env.JWT_SECRET ??
        (env === 'production' ? required('JWT_SECRET') : 'dev-only-secret'),
      jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '12h',
      signupBonusUsd: num('SIGNUP_BONUS_USD', 100_000),
    },
    market: {
      tickIntervalMs: num('PRICE_TICK_INTERVAL_MS', 1000),
      randomSeed: num('PRICE_RANDOM_SEED', 20240601),
      engineEnabled: bool('PRICE_ENGINE_ENABLED', true),
      timeAcceleration: num('MARKET_TIME_ACCELERATION', 3600),
      bookLevels: num('BOOK_LEVELS', 10),
      bookNotionalPerLevelUsd: num('BOOK_NOTIONAL_PER_LEVEL_USD', 25_000),
      bookSpreadBps: num('BOOK_SPREAD_BPS', 12),
    },
    trading: {
      takerFeeBps: num('TAKER_FEE_BPS', 10),
      makerFeeBps: num('MAKER_FEE_BPS', 0),
    },
    circuitBreaker: {
      thresholdBps: num('CIRCUIT_BREAKER_THRESHOLD_BPS', 1500),
      windowMs: num('CIRCUIT_BREAKER_WINDOW_MS', 60_000),
      cooldownMs: num('CIRCUIT_BREAKER_COOLDOWN_MS', 30_000),
    },
    rateLimit: {
      ttlMs: num('RATE_LIMIT_TTL_MS', 60_000),
      limit: num('RATE_LIMIT_LIMIT', 300),
    },
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
