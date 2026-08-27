import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { TestHarness, Trader } from './harness';

/**
 * Concurrency behaviour under simultaneous load.
 *
 * Requests are fired with `Promise.all` through `fastify.inject()`, so they hit
 * the real pipeline at the same time and genuinely contend for the same rows and
 * advisory locks. Every case asserts the same two global invariants afterwards:
 * no balance went negative, and the materialised balances still equal an
 * independent `SUM(delta)` fold of the ledger.
 */
describe('Concurrency (e2e)', () => {
  let harness: TestHarness;
  let trader: Trader;

  beforeAll(async () => {
    harness = await TestHarness.create();
  });

  beforeEach(async () => {
    trader = await harness.createTrader();
    await harness.resetMarket('vSOL', '420.00');
    await harness.resetMarket('vATL', '95.50');
    await harness.resetMarket('vVAN', '310.10');
  });

  afterAll(async () => {
    await harness.close();
  });

  async function expectLedgerIntact(): Promise<void> {
    expect(await harness.negativeBalances()).toBe(0);
    expect(await harness.ledgerDrift()).toHaveLength(0);
  }

  const tally = (responses: Array<{ status: number; body: any }>) =>
    responses.reduce<Record<string, number>>((counts, response) => {
      const key = `${response.status}:${response.body?.error?.code ?? response.body?.status ?? 'OK'}`;
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {});

  it('creates exactly one order when the same Idempotency-Key races itself', async () => {
    const key = randomUUID();
    const body = { symbol: 'vATL', side: 'BUY', type: 'MARKET', quantity: '1' };

    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        harness.request('POST', '/orders', { token: trader.token, idempotencyKey: key, body }),
      ),
    );

    const created = responses.filter((r) => r.status === 201);
    const inFlight = responses.filter(
      (r) => r.body?.error?.code === 'IDEMPOTENT_REQUEST_IN_FLIGHT',
    );

    // Every response is either the one order or an explicit "already running".
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(created.length + inFlight.length).toBe(20);
    // Whatever succeeded, they all describe the same single order.
    expect(new Set(created.map((r) => r.body.id)).size).toBe(1);

    const rows = await harness.database.db.execute(sql`
      SELECT COUNT(*)::int AS total FROM orders
      WHERE user_id = ${trader.id}::uuid AND idempotency_key = ${key}::text
    `);
    expect(Number((rows.rows[0] as { total: number }).total)).toBe(1);
    await expectLedgerIntact();
  });

  it('never lets concurrent buys overdraw the account', async () => {
    // $100,000 of buying power against 25 simultaneous $9,000 orders.
    const responses = await Promise.all(
      Array.from({ length: 25 }, () =>
        harness.request('POST', '/orders', {
          token: trader.token,
          body: { symbol: 'vSOL', side: 'BUY', type: 'MARKET', usdAmount: '9000' },
        }),
      ),
    );

    const filled = responses.filter((r) => r.status === 201);
    const rejected = responses.filter((r) => r.body?.error?.code === 'INSUFFICIENT_FUNDS');

    expect(filled.length).toBeGreaterThan(0);
    expect(rejected.length).toBeGreaterThan(0);
    expect(filled.length + rejected.length).toBe(25);
    // Eleven $9,000 orders is $99,000 — the most $100,000 can carry with fees.
    expect(filled.length).toBeLessThanOrEqual(11);

    const spent = filled.reduce(
      (total, r) => total + Number(r.body.filledNotional) + Number(r.body.feesPaid),
      0,
    );
    const portfolio = await harness.request('GET', '/portfolio', { token: trader.token });
    expect(spent).toBeLessThanOrEqual(100_000);
    expect(Number(portfolio.body.cash.available)).toBeCloseTo(100_000 - spent, 4);
    await expectLedgerIntact();
  });

  it('never lets concurrent sells oversell a position', async () => {
    await harness.request('POST', '/orders', {
      token: trader.token,
      body: { symbol: 'vVAN', side: 'BUY', type: 'MARKET', quantity: '20' },
    });

    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        harness.request('POST', '/orders', {
          token: trader.token,
          body: { symbol: 'vVAN', side: 'SELL', type: 'MARKET', quantity: '5' },
        }),
      ),
    );

    const accepted = responses.filter((r) => r.status === 201);
    const rejected = responses.filter((r) => r.body?.error?.code === 'INSUFFICIENT_SHARES');

    const sold = accepted.reduce((total, r) => total + Number(r.body.filledQuantity), 0);
    expect(sold).toBeLessThanOrEqual(20);
    expect(accepted.length + rejected.length).toBe(12);

    const portfolio = await harness.request('GET', '/portfolio', { token: trader.token });
    const holding = portfolio.body.holdings.find((h: any) => h.symbol === 'vVAN');
    expect(Number(holding?.quantity ?? 0)).toBeCloseTo(20 - sold, 6);
    await expectLedgerIntact();
  });

  it('cancels a resting order exactly once under a cancel storm', async () => {
    const placed = await harness.request('POST', '/orders', {
      token: trader.token,
      body: { symbol: 'vSOL', side: 'BUY', type: 'LIMIT', quantity: '10', limitPrice: '300.00' },
    });
    expect(placed.body.status).toBe('OPEN');

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        harness.request('DELETE', `/orders/${placed.body.id}`, { token: trader.token }),
      ),
    );

    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.body?.error?.code === 'ORDER_NOT_CANCELLABLE')).toHaveLength(
      9,
    );

    // The reservation came back exactly once, not ten times.
    const portfolio = await harness.request('GET', '/portfolio', { token: trader.token });
    expect(portfolio.body.cash.available).toBe('100000.000000');
    expect(portfolio.body.cash.reserved).toBe('0.000000');
    await expectLedgerIntact();
  });

  it('keeps two traders crossing the same book consistent', async () => {
    const maker = await harness.createTrader();
    await harness.request('POST', '/orders', {
      token: maker.token,
      body: { symbol: 'vATL', side: 'BUY', type: 'MARKET', quantity: '200' },
    });

    const { bid, ask } = await harness.topOfBook('vATL');
    const inside = ((Number(bid) + Number(ask)) / 2).toFixed(2);
    const resting = await harness.request('POST', '/orders', {
      token: maker.token,
      body: { symbol: 'vATL', side: 'SELL', type: 'LIMIT', quantity: '100', limitPrice: inside },
    });
    expect(resting.body.status).toBe('OPEN');

    // Ten simultaneous takers competing for the same 100 resting shares.
    const takers = await Promise.all(
      Array.from({ length: 10 }, () =>
        harness.request('POST', '/orders', {
          token: trader.token,
          body: { symbol: 'vATL', side: 'BUY', type: 'MARKET', quantity: '20' },
        }),
      ),
    );
    expect(takers.every((r) => r.status === 201)).toBe(true);

    const makerOrder = await harness.request('GET', `/orders/${resting.body.id}`, {
      token: maker.token,
    });
    // The resting order can be consumed but never over-consumed.
    expect(Number(makerOrder.body.filledQuantity)).toBeLessThanOrEqual(100);
    expect(Number(makerOrder.body.filledQuantity)).toBeGreaterThan(0);

    const takerFillsAgainstMaker = takers
      .flatMap((r) => r.body.fills)
      .filter((f: any) => f.counterpartyType === 'USER')
      .reduce((total: number, f: any) => total + Number(f.quantity), 0);
    expect(takerFillsAgainstMaker).toBeCloseTo(Number(makerOrder.body.filledQuantity), 6);
    await expectLedgerIntact();
  });

  it('holds the ledger together under a mixed burst of activity', async () => {
    await harness.credit(trader.id, '400000');
    const other = await harness.createTrader('400000');

    const actions = [
      ...Array.from({ length: 8 }, () => ({
        token: trader.token,
        body: { symbol: 'vSOL', side: 'BUY', type: 'MARKET', usdAmount: '12000' },
      })),
      ...Array.from({ length: 8 }, () => ({
        token: other.token,
        body: { symbol: 'vSOL', side: 'BUY', type: 'LIMIT', quantity: '5', limitPrice: '430.00' },
      })),
      ...Array.from({ length: 6 }, () => ({
        token: other.token,
        body: { symbol: 'vATL', side: 'BUY', type: 'MARKET', quantity: '10' },
      })),
    ];

    const responses = await Promise.all(
      actions.map((action) =>
        harness.request('POST', '/orders', { token: action.token, body: action.body }),
      ),
    );

    // Every request resolved to a definite outcome; none hung or errored out.
    expect(responses.every((r) => r.status === 201 || r.status >= 400)).toBe(true);
    expect(responses.some((r) => r.status >= 500)).toBe(false);
    // eslint-disable-next-line no-console
    console.log('mixed burst outcomes:', tally(responses));
    await expectLedgerIntact();
  });
});
