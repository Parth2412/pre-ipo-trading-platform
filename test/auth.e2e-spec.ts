import { TestHarness, Trader } from './harness';

describe('Authentication (e2e)', () => {
  let harness: TestHarness;
  let trader: Trader;

  beforeAll(async () => {
    harness = await TestHarness.create();
    trader = await harness.createTrader();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('credits the welcome balance on registration', async () => {
    const fresh = await harness.createTrader();
    const portfolio = await harness.request('GET', '/portfolio', { token: fresh.token });

    expect(portfolio.status).toBe(200);
    expect(portfolio.body.cash.available).toBe('100000.000000');
    expect(portfolio.body.totals.netDeposits).toBe('100000.000000');
  });

  it('rejects a duplicate email', async () => {
    const response = await harness.request('POST', '/auth/register', {
      body: { email: trader.email, password: 'Password123!' },
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it('rejects a weak password', async () => {
    const response = await harness.request('POST', '/auth/register', {
      body: { email: 'weak@example.com', password: 'short' },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects unknown fields rather than ignoring them', async () => {
    const response = await harness.request('POST', '/auth/login', {
      body: { email: 'alice@example.com', password: 'Password123!', role: 'ADMIN' },
    });
    expect(response.status).toBe(400);
  });

  it('issues a token for valid credentials', async () => {
    const response = await harness.request('POST', '/auth/login', {
      body: { email: 'alice@example.com', password: 'Password123!' },
    });
    expect(response.status).toBe(200);
    expect(typeof response.body.accessToken).toBe('string');
    expect(response.body.user.role).toBe('USER');
  });

  it('rejects a wrong password', async () => {
    const response = await harness.request('POST', '/auth/login', {
      body: { email: 'alice@example.com', password: 'wrong-password' },
    });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  it('protects account endpoints by default', async () => {
    for (const path of ['/portfolio', '/orders', '/auth/me']) {
      const response = await harness.request('GET', path);
      expect(response.status).toBe(401);
    }
  });

  it('rejects a malformed token', async () => {
    const response = await harness.request('GET', '/auth/me', { token: 'not-a-jwt' });
    expect(response.status).toBe(401);
  });

  it('leaves market data public', async () => {
    for (const path of ['/assets', '/assets/vSOL', '/assets/vSOL/history?limit=1', '/health']) {
      const response = await harness.request('GET', path);
      expect(response.status).toBe(200);
    }
  });

  it('restricts admin controls to administrators', async () => {
    const asUser = await harness.request('POST', '/admin/assets/vSOL/halt', {
      token: trader.token,
      body: { reason: 'nope' },
    });
    expect(asUser.status).toBe(403);
    expect(asUser.body.error.code).toBe('FORBIDDEN');

    const admin = await harness.admin();
    const asAdmin = await harness.request('POST', '/admin/assets/vSOL/halt', {
      token: admin.token,
      body: { reason: 'test' },
    });
    expect(asAdmin.status).toBe(200);
    await harness.request('POST', '/admin/assets/vSOL/resume', {
      token: admin.token,
      body: { reason: 'test' },
    });
  });
});
