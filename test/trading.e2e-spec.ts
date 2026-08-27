import { randomUUID } from 'node:crypto';
import { TestHarness, Trader } from './harness';

describe('Trading engine (e2e)', () => {
  let harness: TestHarness;
  let trader: Trader;
  let admin: Trader;

  beforeAll(async () => {
    harness = await TestHarness.create();
    admin = await harness.admin();
  });

  beforeEach(async () => {
    trader = await harness.createTrader();
    await harness.resetMarket('vSOL', '420.00');
    await harness.resetMarket('vATL', '95.50');
    await harness.resetMarket('vHLX', '180.25');
    await harness.resetMarket('vVAN', '310.10');
  });

  afterAll(async () => {
    await harness.close();
  });

  const place = (body: unknown, options: { token?: string; key?: string } = {}) =>
    harness.request('POST', '/orders', {
      token: options.token ?? trader.token,
      idempotencyKey: options.key,
      body,
    });

  // ---------------------------------------------------------------- happy path

  describe('happy path', () => {
    it('fills a market buy sized in USD and settles the ledger', async () => {
      const response = await place({
        symbol: 'vSOL',
        side: 'BUY',
        type: 'MARKET',
        usdAmount: '20000',
      });

      expect(response.status).toBe(201);
      expect(response.body.status).toBe('FILLED');
      expect(Number(response.body.filledQuantity)).toBeGreaterThan(0);
      expect(response.body.fills.length).toBeGreaterThan(0);
      expect(response.body.reservedCash).toBe('0.000000');

      // Cash out equals notional plus fees, exactly.
      const portfolio = await harness.request('GET', '/portfolio', { token: trader.token });
      const spent = 100_000 - Number(portfolio.body.cash.available);
      expect(spent).toBeCloseTo(
        Number(response.body.filledNotional) + Number(response.body.feesPaid),
        6,
      );
      expect(await harness.ledgerDrift()).toHaveLength(0);
    });

    it('fills a market buy sized in shares', async () => {
      const response = await place({ symbol: 'vATL', side: 'BUY', type: 'MARKET', quantity: '25' });
      expect(response.status).toBe(201);
      expect(response.body.filledQuantity).toBe('25.00000000');
    });

    it('rests a limit buy away from the touch and reserves the cash', async () => {
      const response = await place({
        symbol: 'vSOL',
        side: 'BUY',
        type: 'LIMIT',
        quantity: '10',
        limitPrice: '300.00',
      });

      expect(response.status).toBe(201);
      expect(response.body.status).toBe('OPEN');
      expect(response.body.filledQuantity).toBe('0.00000000');
      // 10 × $300 = $3,000 plus the 10 bp taker fee it may attract.
      expect(response.body.reservedCash).toBe('3003.000000');

      const portfolio = await harness.request('GET', '/portfolio', { token: trader.token });
      expect(portfolio.body.cash.reserved).toBe('3003.000000');
      expect(portfolio.body.cash.available).toBe('96997.000000');
    });

    it('fills a marketable limit immediately at or better than the limit', async () => {
      const response = await place({
        symbol: 'vSOL',
        side: 'BUY',
        type: 'LIMIT',
        quantity: '5',
        limitPrice: '500.00',
      });

      expect(response.body.status).toBe('FILLED');
      for (const fill of response.body.fills) {
        expect(Number(fill.price)).toBeLessThanOrEqual(500);
      }
    });

    it('round-trips a position and realises P&L', async () => {
      await place({ symbol: 'vATL', side: 'BUY', type: 'MARKET', quantity: '20' });
      // Deliberately under the 15% breaker threshold: this test is about P&L,
      // not about volatility controls.
      await harness.setPrice('vATL', '105.00');
      const sell = await place({ symbol: 'vATL', side: 'SELL', type: 'MARKET', quantity: '20' });

      expect(sell.body.status).toBe('FILLED');
      const portfolio = await harness.request('GET', '/portfolio', { token: trader.token });
      expect(Number(portfolio.body.totals.realizedPnl)).toBeGreaterThan(0);
      expect(await harness.ledgerDrift()).toHaveLength(0);
    });
  });

  // ----------------------------------------------------------------- rejections

  describe('rejections', () => {
    it('rejects a buy the account cannot fund', async () => {
      const response = await place({
        symbol: 'vSOL',
        side: 'BUY',
        type: 'LIMIT',
        quantity: '10000',
        limitPrice: '400.00',
      });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('INSUFFICIENT_FUNDS');
    });

    it('rejects a sale of shares the account does not hold', async () => {
      const response = await place({ symbol: 'vVAN', side: 'SELL', type: 'MARKET', quantity: '5' });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('INSUFFICIENT_SHARES');
    });

    it('rejects an unknown symbol', async () => {
      const response = await place({ symbol: 'vNOPE', side: 'BUY', type: 'MARKET', quantity: '1' });
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('ASSET_NOT_FOUND');
    });

    it('rejects a limit order with no limit price', async () => {
      const response = await place({ symbol: 'vSOL', side: 'BUY', type: 'LIMIT', quantity: '1' });
      expect(response.status).toBe(400);
      expect(response.body.error.message).toMatch(/limitPrice.*required/i);
    });

    it('rejects a market order that carries a limit price', async () => {
      const response = await place({
        symbol: 'vSOL',
        side: 'BUY',
        type: 'MARKET',
        quantity: '1',
        limitPrice: '400.00',
      });
      expect(response.status).toBe(400);
    });

    it('rejects a market order asked to rest', async () => {
      const response = await place({
        symbol: 'vSOL',
        side: 'BUY',
        type: 'MARKET',
        quantity: '1',
        timeInForce: 'GTC',
      });
      expect(response.status).toBe(400);
      expect(response.body.error.message).toMatch(/cannot rest/i);
    });

    it('rejects a limit price off the tick grid', async () => {
      const response = await place({
        symbol: 'vSOL',
        side: 'BUY',
        type: 'LIMIT',
        quantity: '1',
        limitPrice: '400.0033',
      });
      expect(response.status).toBe(400);
      expect(response.body.error.message).toMatch(/tick size/i);
    });

    it('rejects an order below the minimum notional', async () => {
      const response = await place({
        symbol: 'vSOL',
        side: 'BUY',
        type: 'LIMIT',
        quantity: '0.00001',
        limitPrice: '400.00',
      });
      expect(response.status).toBe(400);
      expect(response.body.error.message).toMatch(/minimum/i);
    });

    it('rejects usdAmount on anything but a market buy', async () => {
      const response = await place({
        symbol: 'vSOL',
        side: 'SELL',
        type: 'MARKET',
        usdAmount: '100',
      });
      expect(response.status).toBe(400);
    });

    it('rejects a zero quantity', async () => {
      const response = await place({ symbol: 'vSOL', side: 'BUY', type: 'MARKET', quantity: '0' });
      expect(response.status).toBe(400);
    });
  });

  // -------------------------------------------------------------- idempotency

  describe('idempotency', () => {
    it('requires the header', async () => {
      const response = await harness.request('POST', '/orders', {
        token: trader.token,
        idempotencyKey: null,
        body: { symbol: 'vSOL', side: 'BUY', type: 'MARKET', quantity: '1' },
      });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('replays the original response instead of placing a second order', async () => {
      const key = randomUUID();
      const body = { symbol: 'vSOL', side: 'BUY', type: 'MARKET', quantity: '2' };

      const first = await place(body, { key });
      const second = await place(body, { key });

      expect(first.body.id).toBe(second.body.id);
      expect(first.headers['idempotent-replay']).toBe('false');
      expect(second.headers['idempotent-replay']).toBe('true');

      const orders = await harness.request('GET', '/orders', { token: trader.token });
      expect(orders.body.filter((o: any) => o.symbol === 'vSOL')).toHaveLength(1);
    });

    it('rejects the same key with a different payload', async () => {
      const key = randomUUID();
      await place({ symbol: 'vSOL', side: 'BUY', type: 'MARKET', quantity: '1' }, { key });
      const response = await place(
        { symbol: 'vSOL', side: 'BUY', type: 'MARKET', quantity: '999' },
        { key },
      );

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('replays a rejection as the same rejection', async () => {
      const key = randomUUID();
      const body = { symbol: 'vVAN', side: 'SELL', type: 'MARKET', quantity: '5' };

      const first = await place(body, { key });
      const second = await place(body, { key });

      expect(first.status).toBe(422);
      expect(second.status).toBe(422);
      expect(second.body.error.code).toBe('INSUFFICIENT_SHARES');
    });

    it('scopes keys to the user', async () => {
      const key = randomUUID();
      const other = await harness.createTrader();
      const body = { symbol: 'vSOL', side: 'BUY', type: 'MARKET', quantity: '1' };

      const mine = await place(body, { key });
      const theirs = await place(body, { key, token: other.token });

      expect(mine.status).toBe(201);
      expect(theirs.status).toBe(201);
      expect(mine.body.id).not.toBe(theirs.body.id);
    });
  });

  // ------------------------------------------------------- partial fill / cancel

  describe('partial fills and cancellation', () => {
    it('partially fills against thin liquidity and rests the remainder', async () => {
      await harness.credit(trader.id, '5000000');

      // Price the limit at the touch so only the best level is reachable, and
      // ask for several times that level's size: the fill must be partial.
      const { ask, askSize } = await harness.topOfBook('vATL');
      const response = await place({
        symbol: 'vATL',
        side: 'BUY',
        type: 'LIMIT',
        quantity: (Number(askSize) * 4).toFixed(5),
        limitPrice: ask,
      });

      expect(response.status).toBe(201);
      expect(response.body.status).toBe('PARTIALLY_FILLED');
      expect(Number(response.body.filledQuantity)).toBeGreaterThan(0);
      expect(Number(response.body.remainingQuantity)).toBeGreaterThan(0);
      expect(Number(response.body.reservedCash)).toBeGreaterThan(0);
    });

    it('fills a resting order as the market moves to it', async () => {
      await place({
        symbol: 'vHLX',
        side: 'BUY',
        type: 'LIMIT',
        quantity: '10',
        limitPrice: '178.00',
      });

      // The price engine is frozen, so publishing a mark is what drives the tick
      // matcher. The move stays under the breaker threshold so the matcher runs.
      await harness.setPrice('vHLX', '172.00');
      await new Promise((resolve) => setTimeout(resolve, 400));

      const orders = await harness.request('GET', '/orders?symbol=vHLX', { token: trader.token });
      const order = orders.body[0];
      expect(['PARTIALLY_FILLED', 'FILLED']).toContain(order.status);
      expect(Number(order.filledQuantity)).toBeGreaterThan(0);
      expect(order.fills[0].liquidityRole).toBe('MAKER');
    });

    it('cancels a resting order and releases the reservation exactly', async () => {
      const placed = await place({
        symbol: 'vSOL',
        side: 'BUY',
        type: 'LIMIT',
        quantity: '10',
        limitPrice: '300.00',
      });

      const before = await harness.request('GET', '/portfolio', { token: trader.token });
      expect(before.body.cash.reserved).toBe('3003.000000');

      const cancelled = await harness.request('DELETE', `/orders/${placed.body.id}`, {
        token: trader.token,
      });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.status).toBe('CANCELLED');
      expect(cancelled.body.reservedCash).toBe('0.000000');

      const after = await harness.request('GET', '/portfolio', { token: trader.token });
      expect(after.body.cash.reserved).toBe('0.000000');
      expect(after.body.cash.available).toBe('100000.000000');
      expect(await harness.ledgerDrift()).toHaveLength(0);
    });

    it('releases only the unfilled part when cancelling a partially filled order', async () => {
      await harness.credit(trader.id, '5000000');
      const { ask, askSize } = await harness.topOfBook('vATL');
      const placed = await place({
        symbol: 'vATL',
        side: 'BUY',
        type: 'LIMIT',
        quantity: (Number(askSize) * 4).toFixed(5),
        limitPrice: ask,
      });
      expect(placed.body.status).toBe('PARTIALLY_FILLED');

      const cancelled = await harness.request('DELETE', `/orders/${placed.body.id}`, {
        token: trader.token,
      });
      expect(cancelled.body.status).toBe('CANCELLED');
      expect(cancelled.body.filledQuantity).toBe(placed.body.filledQuantity);
      expect(cancelled.body.reservedCash).toBe('0.000000');
      expect(await harness.ledgerDrift()).toHaveLength(0);
    });

    it('returns reserved shares when a sell order is cancelled', async () => {
      await place({ symbol: 'vATL', side: 'BUY', type: 'MARKET', quantity: '30' });
      const placed = await place({
        symbol: 'vATL',
        side: 'SELL',
        type: 'LIMIT',
        quantity: '30',
        limitPrice: '500.00',
      });
      expect(placed.body.status).toBe('OPEN');
      expect(placed.body.reservedQuantity).toBe('30.00000000');

      const holdingWhileResting = await harness.request('GET', '/portfolio', {
        token: trader.token,
      });
      expect(
        holdingWhileResting.body.holdings.find((h: any) => h.symbol === 'vATL').availableQuantity,
      ).toBe('0.00000000');

      await harness.request('DELETE', `/orders/${placed.body.id}`, { token: trader.token });
      const after = await harness.request('GET', '/portfolio', { token: trader.token });
      expect(after.body.holdings.find((h: any) => h.symbol === 'vATL').availableQuantity).toBe(
        '30.00000000',
      );
    });

    it('refuses to cancel a filled order', async () => {
      const placed = await place({ symbol: 'vSOL', side: 'BUY', type: 'MARKET', quantity: '1' });
      const response = await harness.request('DELETE', `/orders/${placed.body.id}`, {
        token: trader.token,
      });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('ORDER_NOT_CANCELLABLE');
    });

    it('will not cancel another trader’s order', async () => {
      const placed = await place({
        symbol: 'vSOL',
        side: 'BUY',
        type: 'LIMIT',
        quantity: '1',
        limitPrice: '300.00',
      });
      const other = await harness.createTrader();
      const response = await harness.request('DELETE', `/orders/${placed.body.id}`, {
        token: other.token,
      });
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('ORDER_NOT_FOUND');
    });

    it('404s an unknown order id', async () => {
      const response = await harness.request('DELETE', `/orders/${randomUUID()}`, {
        token: trader.token,
      });
      expect(response.status).toBe(404);
    });
  });

  // ------------------------------------------------- cross-user price-time priority

  describe('matching across users', () => {
    it('fills the taker against a resting user order before synthetic depth', async () => {
      const maker = await harness.createTrader();
      await harness.request('POST', '/orders', {
        token: maker.token,
        body: { symbol: 'vVAN', side: 'BUY', type: 'MARKET', quantity: '50' },
      });

      // Rest a sell inside the spread so it is the best offer in the market.
      const book = await harness.request('GET', '/assets/vVAN/book?depth=1');
      const inside = (
        (Number(book.body.bids[0].price) + Number(book.body.asks[0].price)) /
        2
      ).toFixed(2);
      const resting = await harness.request('POST', '/orders', {
        token: maker.token,
        body: { symbol: 'vVAN', side: 'SELL', type: 'LIMIT', quantity: '40', limitPrice: inside },
      });
      expect(resting.body.status).toBe('OPEN');

      const taker = await place({ symbol: 'vVAN', side: 'BUY', type: 'MARKET', quantity: '15' });
      expect(taker.body.fills[0].counterpartyType).toBe('USER');
      expect(taker.body.fills[0].price).toBe(`${inside}0000`);

      const makerOrder = await harness.request('GET', `/orders/${resting.body.id}`, {
        token: maker.token,
      });
      expect(makerOrder.body.status).toBe('PARTIALLY_FILLED');
      expect(makerOrder.body.filledQuantity).toBe('15.00000000');
      expect(makerOrder.body.fills[0].liquidityRole).toBe('MAKER');
      expect(await harness.ledgerDrift()).toHaveLength(0);
    });

    it('never matches a trader against their own resting order', async () => {
      await place({ symbol: 'vHLX', side: 'BUY', type: 'MARKET', quantity: '20' });

      const book = await harness.request('GET', '/assets/vHLX/book?depth=1');
      const inside = (
        (Number(book.body.bids[0].price) + Number(book.body.asks[0].price)) /
        2
      ).toFixed(2);
      const own = await place({
        symbol: 'vHLX',
        side: 'SELL',
        type: 'LIMIT',
        quantity: '10',
        limitPrice: inside,
      });
      expect(own.body.status).toBe('OPEN');

      const cross = await place({ symbol: 'vHLX', side: 'BUY', type: 'MARKET', quantity: '5' });
      // Filled against synthetic depth at a worse price, leaving the own order alone.
      expect(cross.body.fills.every((f: any) => f.counterpartyType === 'SYNTHETIC')).toBe(true);

      const stillResting = await harness.request('GET', `/orders/${own.body.id}`, {
        token: trader.token,
      });
      expect(stillResting.body.status).toBe('OPEN');
      expect(stillResting.body.filledQuantity).toBe('0.00000000');
    });
  });

  // ---------------------------------------------------- circuit breaker and halts

  describe('circuit breaker and market halts', () => {
    it('rejects new orders after a >15% move inside the window', async () => {
      await harness.resetMarket('vSOL', '400.00');
      await harness.setPrice('vSOL', '470.00'); // +17.5%

      const response = await place({ symbol: 'vSOL', side: 'BUY', type: 'MARKET', quantity: '1' });
      expect(response.status).toBe(423);
      expect(response.body.error.code).toBe('CIRCUIT_BREAKER_TRIPPED');
      expect(response.body.error.details.retryAfterMs).toBeGreaterThan(0);
      expect(response.body.error.details.thresholdBps).toBe(1500);
    });

    it('leaves other assets tradable while one is breached', async () => {
      await harness.resetMarket('vSOL', '400.00');
      await harness.setPrice('vSOL', '470.00');

      const other = await place({ symbol: 'vATL', side: 'BUY', type: 'MARKET', quantity: '1' });
      expect(other.status).toBe(201);
    });

    it('still allows a resting order to be cancelled while the breaker holds', async () => {
      const placed = await place({
        symbol: 'vSOL',
        side: 'BUY',
        type: 'LIMIT',
        quantity: '5',
        limitPrice: '300.00',
      });
      await harness.setPrice('vSOL', '470.00');

      const cancelled = await harness.request('DELETE', `/orders/${placed.body.id}`, {
        token: trader.token,
      });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.status).toBe('CANCELLED');
    });

    it('rejects orders on a halted asset and resumes on command', async () => {
      const halt = await harness.request('POST', '/admin/assets/vVAN/halt', {
        token: admin.token,
        body: { reason: 'pending announcement' },
      });
      expect(halt.status).toBe(200);
      expect(halt.body.status).toBe('HALTED');

      const blocked = await place({ symbol: 'vVAN', side: 'BUY', type: 'MARKET', quantity: '1' });
      expect(blocked.status).toBe(423);
      expect(blocked.body.error.code).toBe('MARKET_HALTED');

      await harness.request('POST', '/admin/assets/vVAN/resume', {
        token: admin.token,
        body: { reason: 'announcement made' },
      });
      const allowed = await place({ symbol: 'vVAN', side: 'BUY', type: 'MARKET', quantity: '1' });
      expect(allowed.status).toBe(201);
    });
  });
});
