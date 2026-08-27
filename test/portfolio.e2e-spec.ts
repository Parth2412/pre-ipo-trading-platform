import { TestHarness, Trader } from './harness';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Portfolio reconstruction (e2e)', () => {
  let harness: TestHarness;
  let trader: Trader;

  beforeAll(async () => {
    harness = await TestHarness.create();
  });

  beforeEach(async () => {
    trader = await harness.createTrader();
    await harness.resetMarket('vSOL', '420.00');
    await harness.resetMarket('vATL', '95.50');
  });

  afterAll(async () => {
    await harness.close();
  });

  const buy = (symbol: string, quantity: string) =>
    harness.request('POST', '/orders', {
      token: trader.token,
      body: { symbol, side: 'BUY', type: 'MARKET', quantity },
    });

  const portfolio = (query = '') =>
    harness.request('GET', `/portfolio${query}`, { token: trader.token });

  const historyAt = (at: string, verify = true) =>
    harness.request(
      'GET',
      `/portfolio/history?at=${encodeURIComponent(at)}${verify ? '&verify=true' : ''}`,
      { token: trader.token },
    );

  describe('GET /portfolio', () => {
    it('starts flat with only the welcome balance', async () => {
      const response = await portfolio('?verify=true');
      expect(response.status).toBe(200);
      expect(response.body.mode).toBe('LIVE');
      expect(response.body.holdings).toHaveLength(0);
      expect(response.body.totals.equity).toBe('100000.000000');
      expect(response.body.reconciliation.consistent).toBe(true);
    });

    it('reports cost basis and unrealised P&L after a purchase', async () => {
      await buy('vSOL', '10');
      await harness.setPrice('vSOL', '450.00');

      const response = await portfolio();
      const holding = response.body.holdings.find((h: any) => h.symbol === 'vSOL');

      expect(holding.quantity).toBe('10.00000000');
      expect(holding.markPrice).toBe('450.000000');
      expect(Number(holding.averageCost)).toBeGreaterThan(420);
      expect(Number(holding.unrealizedPnl)).toBeGreaterThan(0);
      expect(Number(holding.marketValue)).toBeCloseTo(4500, 4);
    });

    it('keeps equity equal to cash plus marked positions', async () => {
      await buy('vSOL', '5');
      await buy('vATL', '30');

      const { body } = await portfolio();
      expect(Number(body.totals.equity)).toBeCloseTo(
        Number(body.totals.cash) + Number(body.totals.positionsValue),
        4,
      );
    });

    it('separates reserved shares from available ones', async () => {
      await buy('vATL', '40');
      await harness.request('POST', '/orders', {
        token: trader.token,
        body: {
          symbol: 'vATL',
          side: 'SELL',
          type: 'LIMIT',
          quantity: '15',
          limitPrice: '500.00',
        },
      });

      const holding = (await portfolio()).body.holdings.find((h: any) => h.symbol === 'vATL');
      expect(holding.quantity).toBe('40.00000000');
      expect(holding.reservedQuantity).toBe('15.00000000');
      expect(holding.availableQuantity).toBe('25.00000000');
    });

    it('measures total return against net deposits', async () => {
      const { body } = await portfolio();
      expect(body.totals.netDeposits).toBe('100000.000000');
      expect(body.totals.totalReturnBps).toBe(0);
    });
  });

  describe('GET /portfolio/history', () => {
    it('reconstructs each stage of an account’s life', async () => {
      const t0 = new Date().toISOString();
      await wait(20);

      await buy('vSOL', '10');
      await wait(20);
      const t1 = new Date().toISOString();

      await buy('vATL', '50');
      await wait(20);
      const t2 = new Date().toISOString();

      const before = await historyAt(t0);
      expect(before.body.mode).toBe('HISTORICAL');
      expect(before.body.holdings).toHaveLength(0);
      expect(before.body.cash.total).toBe('100000.000000');

      const afterFirst = await historyAt(t1);
      expect(afterFirst.body.holdings.map((h: any) => h.symbol)).toEqual(['vSOL']);
      expect(afterFirst.body.holdings[0].quantity).toBe('10.00000000');

      const afterSecond = await historyAt(t2);
      expect(afterSecond.body.holdings.map((h: any) => h.symbol).sort()).toEqual(['vATL', 'vSOL']);
    });

    it('values holdings at the price that was printed then, not now', async () => {
      await buy('vSOL', '10');
      await wait(20);
      const atPurchase = new Date().toISOString();

      await wait(20);
      await harness.setPrice('vSOL', '460.00');

      const past = await historyAt(atPurchase);
      const now = await portfolio();

      expect(past.body.holdings[0].markPrice).toBe('420.000000');
      expect(now.body.holdings[0].markPrice).toBe('460.000000');
      expect(Number(now.body.totals.equity)).toBeGreaterThan(Number(past.body.totals.equity));
    });

    it('remembers realised P&L as of the moment it was realised', async () => {
      await buy('vATL', '20');
      await wait(20);
      const beforeSale = new Date().toISOString();

      await wait(20);
      await harness.setPrice('vATL', '105.00');
      await harness.request('POST', '/orders', {
        token: trader.token,
        body: { symbol: 'vATL', side: 'SELL', type: 'MARKET', quantity: '20' },
      });
      await wait(20);
      const afterSale = new Date().toISOString();

      expect((await historyAt(beforeSale)).body.totals.realizedPnl).toBe('0.000000');
      expect(Number((await historyAt(afterSale)).body.totals.realizedPnl)).toBeGreaterThan(0);
    });

    it('agrees with an independent fold of the raw ledger at every checkpoint', async () => {
      const checkpoints: string[] = [new Date().toISOString()];
      await wait(20);

      for (const [symbol, quantity] of [
        ['vSOL', '4'],
        ['vATL', '15'],
        ['vSOL', '3'],
      ] as const) {
        await buy(symbol, quantity);
        await wait(20);
        checkpoints.push(new Date().toISOString());
      }

      for (const at of checkpoints) {
        const response = await historyAt(at);
        expect(response.body.reconciliation.consistent).toBe(true);
        expect(response.body.reconciliation.cashDrift).toBe('0.000000');
        expect(response.body.reconciliation.positionDrift).toEqual([]);
      }
      expect(await harness.ledgerDrift()).toHaveLength(0);
    });

    it('counts what the verification actually recomputed', async () => {
      await buy('vSOL', '2');
      const response = await historyAt(new Date().toISOString());

      expect(response.body.reconciliation.ledgerEntriesFolded).toBeGreaterThan(0);
      expect(response.body.reconciliation.fillsReplayed).toBeGreaterThan(0);
    });

    it('rejects a missing, malformed or future timestamp', async () => {
      const missing = await harness.request('GET', '/portfolio/history', { token: trader.token });
      expect(missing.status).toBe(400);

      const malformed = await historyAt('yesterday', false);
      expect(malformed.status).toBe(400);

      const future = await historyAt(new Date(Date.now() + 86_400_000).toISOString(), false);
      expect(future.status).toBe(400);
      expect(future.body.error.message).toMatch(/future/i);
    });
  });

  describe('GET /portfolio/timeline', () => {
    it('samples the equity curve across the account’s life', async () => {
      await buy('vSOL', '5');
      const response = await harness.request('GET', '/portfolio/timeline?points=6', {
        token: trader.token,
      });

      expect(response.status).toBe(200);
      expect(response.body.points).toHaveLength(6);
      for (const point of response.body.points) {
        expect(Number(point.equity)).toBeGreaterThan(0);
        expect(Number(point.equity)).toBeCloseTo(
          Number(point.cash) + Number(point.positionsValue),
          4,
        );
      }
    });
  });

  describe('GET /portfolio/ledger', () => {
    it('exposes the double entry behind a trade', async () => {
      await buy('vSOL', '3');
      const response = await harness.request('GET', '/portfolio/ledger?limit=20', {
        token: trader.token,
      });

      expect(response.status).toBe(200);
      const types = response.body.map((entry: any) => entry.entryType);
      expect(types).toEqual(
        expect.arrayContaining(['DEPOSIT', 'ORDER_RESERVE', 'TRADE_BUY', 'FEE']),
      );

      // Every entry carries the running balance the point-in-time read relies on.
      for (const entry of response.body) {
        expect(entry.balanceAfter).toEqual(expect.any(String));
        expect(Number(entry.balanceAfter)).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
