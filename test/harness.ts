import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http-exception.filter';
import { DatabaseService } from '../src/database/database.service';
import { CircuitBreakerService } from '../src/assets/circuit-breaker.service';
import { PriceEngineService } from '../src/assets/price-engine.service';
import { MarketDataService } from '../src/assets/market-data.service';

export interface ApiResponse<T = any> {
  readonly status: number;
  readonly body: T;
  readonly headers: Record<string, unknown>;
}

export interface Trader {
  readonly id: string;
  readonly email: string;
  readonly token: string;
}

export interface RequestOptions {
  readonly token?: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string | null;
  readonly headers?: Record<string, string>;
}

/**
 * Boots the real application against the test database.
 *
 * Requests go through `fastify.inject()` rather than a socket: the full pipeline
 * (guards, pipes, filters, controllers) runs, with no port binding and no
 * network flakiness — which matters most for the concurrency specs, where dozens
 * of requests are fired at once.
 */
export class TestHarness {
  private constructor(readonly app: NestFastifyApplication) {}

  static async create(): Promise<TestHarness> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    return new TestHarness(app);
  }

  get database(): DatabaseService {
    return this.app.get(DatabaseService);
  }

  get prices(): PriceEngineService {
    return this.app.get(PriceEngineService);
  }

  get marketData(): MarketDataService {
    return this.app.get(MarketDataService);
  }

  get breakers(): CircuitBreakerService {
    return this.app.get(CircuitBreakerService);
  }

  async request<T = any>(
    method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
    url: string,
    options: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers ?? {}),
    };
    if (options.idempotencyKey !== null && method === 'POST' && url.startsWith('/orders')) {
      headers['idempotency-key'] = options.idempotencyKey ?? randomUUID();
    }

    const response = await this.app.inject({
      method,
      url,
      headers,
      payload: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    let body: unknown = null;
    try {
      body = response.body ? JSON.parse(response.body) : null;
    } catch {
      body = response.body;
    }
    return { status: response.statusCode, body: body as T, headers: response.headers };
  }

  /** Register a funded trader with a unique email. */
  async createTrader(depositUsd?: string): Promise<Trader> {
    const email = `trader-${randomUUID()}@example.com`;
    const response = await this.request('POST', '/auth/register', {
      body: { email, password: 'Password123!', displayName: 'Test Trader' },
    });
    if (response.status !== 201) {
      throw new Error(`registration failed: ${JSON.stringify(response.body)}`);
    }

    const trader: Trader = {
      id: response.body.user.id,
      email,
      token: response.body.accessToken,
    };
    if (depositUsd) await this.credit(trader.id, depositUsd);
    return trader;
  }

  /** Sign in as the seeded administrator. */
  async admin(): Promise<Trader> {
    const response = await this.request('POST', '/auth/login', {
      body: { email: 'admin@example.com', password: 'Password123!' },
    });
    return {
      id: response.body.user.id,
      email: response.body.user.email,
      token: response.body.accessToken,
    };
  }

  /** Top up a trader through the ledger, keeping the double entry intact. */
  async credit(userId: string, usd: string): Promise<void> {
    const { LedgerService } = await import('../src/ledger/ledger.service');
    const { parseCash } = await import('../src/common/money');
    const ledger = this.app.get(LedgerService);
    await this.database.transaction((tx) =>
      ledger.deposit(tx, userId, parseCash(usd), 'Test top-up', 'ADMIN'),
    );
  }

  /** Publish a mark price. The price engine is frozen in tests, so this is the only mover. */
  async setPrice(symbol: string, price: string): Promise<void> {
    const { parsePrice } = await import('../src/common/money');
    await this.prices.publishPrice(symbol, parsePrice(price));
  }

  /**
   * Return a symbol to a known price with a clean, *seeded* breaker window.
   *
   * The window is cleared after the price is published (so the jump to the reset
   * price is not itself treated as a move) and then re-seeded with one sample at
   * that price. Without the re-seed the window would be empty, and the next
   * published price would have nothing to be measured against — the breaker
   * needs a reference, not just a print.
   */
  async resetMarket(symbol: string, price: string): Promise<void> {
    const { parsePrice } = await import('../src/common/money');
    this.breakers.reset(symbol);
    await this.setPrice(symbol, price);
    this.breakers.reset(symbol);
    this.breakers.observe(symbol, parsePrice(price));
  }

  /** Best ask and its size, for tests that need to size an order against real depth. */
  async topOfBook(symbol: string): Promise<{ bid: string; ask: string; askSize: string }> {
    const { body } = await this.request('GET', `/assets/${symbol}/book?depth=1`);
    return { bid: body.bids[0].price, ask: body.asks[0].price, askSize: body.asks[0].quantity };
  }

  /** Rows where the materialised projection disagrees with the ledger fold. Must be empty. */
  async ledgerDrift(): Promise<unknown[]> {
    const result = await this.database.db.execute(sql`SELECT * FROM balances_integrity`);
    return result.rows;
  }

  async negativeBalances(): Promise<number> {
    const result = await this.database.db.execute(
      sql`SELECT COUNT(*)::int AS total FROM balances WHERE amount < 0`,
    );
    return Number((result.rows[0] as { total: number }).total);
  }

  async close(): Promise<void> {
    await this.app.close();
  }
}
