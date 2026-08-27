import { TestHarness } from './harness';

describe('Market data and calculator (e2e)', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await TestHarness.create();
    await harness.resetMarket('vSOL', '420.00');
    await harness.resetMarket('vATL', '95.50');
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('GET /assets', () => {
    it('lists the whole tradable universe', async () => {
      const response = await harness.request('GET', '/assets');
      expect(response.status).toBe(200);
      expect(response.body.map((a: any) => a.symbol).sort()).toEqual([
        'vATL',
        'vHLX',
        'vSOL',
        'vVAN',
      ]);
    });

    it('quotes a two-sided market that brackets the mark', async () => {
      const response = await harness.request('GET', '/assets');
      for (const asset of response.body) {
        expect(Number(asset.bid)).toBeLessThanOrEqual(Number(asset.price));
        expect(Number(asset.price)).toBeLessThanOrEqual(Number(asset.ask));
        expect(asset.spreadBps).toBeGreaterThan(0);
      }
    });

    it('reports circuit breaker state per asset', async () => {
      const response = await harness.request('GET', '/assets');
      const vsol = response.body.find((a: any) => a.symbol === 'vSOL');
      expect(vsol.circuitBreaker).toMatchObject({ tripped: false, thresholdBps: 1500 });
    });
  });

  describe('GET /assets/:symbol', () => {
    it('returns detail with an order book', async () => {
      const response = await harness.request('GET', '/assets/vSOL');
      expect(response.status).toBe(200);
      expect(response.body.name).toBe('Solace AI');
      expect(response.body.book.bids.length).toBeGreaterThan(0);
      expect(response.body.book.asks.length).toBeGreaterThan(0);
    });

    it('orders the book away from the touch on both sides', async () => {
      const { body } = await harness.request('GET', '/assets/vSOL/book?depth=5');
      const bids = body.bids.map((l: any) => Number(l.price));
      const asks = body.asks.map((l: any) => Number(l.price));
      expect([...bids].sort((a, b) => b - a)).toEqual(bids);
      expect([...asks].sort((a, b) => a - b)).toEqual(asks);
      expect(asks[0]).toBeGreaterThan(bids[0]);
    });

    it('404s an unknown symbol', async () => {
      const response = await harness.request('GET', '/assets/NOPE');
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('ASSET_NOT_FOUND');
    });
  });

  describe('GET /assets/:symbol/history', () => {
    it('returns ticks oldest first', async () => {
      await harness.setPrice('vATL', '96.00');
      await harness.setPrice('vATL', '97.00');
      const response = await harness.request('GET', '/assets/vATL/history?limit=3');

      expect(response.status).toBe(200);
      const times = response.body.points.map((p: any) => new Date(p.at).getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(response.body.points.at(-1).price).toBe('97.000000');
    });

    it('honours the time range', async () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      const response = await harness.request(
        'GET',
        `/assets/vATL/history?from=${encodeURIComponent(future)}`,
      );
      expect(response.status).toBe(200);
      expect(response.body.points).toHaveLength(0);
    });

    it('rejects an out-of-range limit', async () => {
      const response = await harness.request('GET', '/assets/vATL/history?limit=99999');
      expect(response.status).toBe(400);
    });
  });

  describe('POST /calculator', () => {
    it('converts USD into shares without touching any state', async () => {
      const before = await harness.request('GET', '/assets/vSOL');
      const response = await harness.request('POST', '/calculator', {
        body: { symbol: 'vSOL', usdAmount: '10000' },
      });
      const after = await harness.request('GET', '/assets/vSOL');

      expect(response.status).toBe(200);
      expect(Number(response.body.quantity)).toBeGreaterThan(0);
      // Side-effect-free: the book is untouched by a quote.
      expect(after.body.book.bids[0]).toEqual(before.body.book.bids[0]);
    });

    it('never quotes a total above the requested budget', async () => {
      for (const amount of ['1000', '5000', '25000', '99999.99']) {
        const response = await harness.request('POST', '/calculator', {
          body: { symbol: 'vSOL', usdAmount: amount },
        });
        expect(Number(response.body.netCash)).toBeLessThanOrEqual(Number(amount));
      }
    });

    it('prices a sale net of fees', async () => {
      const response = await harness.request('POST', '/calculator', {
        body: { symbol: 'vSOL', side: 'SELL', quantity: '10' },
      });
      expect(response.status).toBe(200);
      expect(Number(response.body.netCash)).toBe(
        Number(response.body.grossNotional) - Number(response.body.fee),
      );
    });

    it('charges more per share as the order sweeps deeper', async () => {
      const small = await harness.request('POST', '/calculator', {
        body: { symbol: 'vSOL', usdAmount: '1000' },
      });
      const large = await harness.request('POST', '/calculator', {
        body: { symbol: 'vSOL', usdAmount: '150000' },
      });
      expect(Number(large.body.effectivePrice)).toBeGreaterThan(Number(small.body.effectivePrice));
      expect(large.body.slippageBps).toBeGreaterThan(small.body.slippageBps);
    });

    it('returns nothing fillable for an unreachable limit price', async () => {
      const response = await harness.request('POST', '/calculator', {
        body: { symbol: 'vSOL', usdAmount: '1000', limitPrice: '1.00' },
      });
      expect(response.body.quantity).toBe('0.00000000');
      expect(response.body.fillable).toBe(false);
      expect(response.body.warnings[0]).toMatch(/no resting liquidity/i);
    });

    it('requires exactly one of usdAmount and quantity', async () => {
      const neither = await harness.request('POST', '/calculator', { body: { symbol: 'vSOL' } });
      expect(neither.status).toBe(400);

      const both = await harness.request('POST', '/calculator', {
        body: { symbol: 'vSOL', usdAmount: '100', quantity: '1' },
      });
      expect(both.status).toBe(400);
    });

    it('rejects a non-decimal amount', async () => {
      const response = await harness.request('POST', '/calculator', {
        body: { symbol: 'vSOL', usdAmount: 'lots' },
      });
      expect(response.status).toBe(400);
    });
  });
});
