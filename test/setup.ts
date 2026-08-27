import { config as loadEnv } from 'dotenv';

loadEnv({ quiet: true });

// Deterministic market: the price process is frozen so tests move prices
// explicitly through the admin control rather than waiting on a random walk.
process.env.NODE_ENV = 'test';
process.env.PRICE_ENGINE_ENABLED = 'false';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret';
process.env.SIGNUP_BONUS_USD = process.env.SIGNUP_BONUS_USD ?? '100000';
// The suite deliberately fires bursts of concurrent requests; throttling them
// would be measuring the rate limiter rather than the engine.
process.env.RATE_LIMIT_LIMIT = '1000000';

jest.setTimeout(60_000);
