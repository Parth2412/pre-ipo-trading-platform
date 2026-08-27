import { Logger } from '@nestjs/common';
import { AppConfig } from '../config/configuration';
import { CircuitBreakerException } from '../common/errors';
import { parsePrice } from '../common/money';
import { DatabaseService } from '../database/database.service';
import { CircuitBreakerService } from './circuit-breaker.service';
import { PriceEngineService } from './price-engine.service';

const config = {
  circuitBreaker: { thresholdBps: 1500, windowMs: 60_000, cooldownMs: 30_000 },
} as AppConfig;

function createService(): CircuitBreakerService {
  const database = { db: { execute: jest.fn().mockResolvedValue({ rows: [] }) } };
  const priceEngine = { updates: { subscribe: jest.fn() } };
  return new CircuitBreakerService(
    config,
    database as unknown as DatabaseService,
    priceEngine as unknown as PriceEngineService,
  );
}

describe('CircuitBreakerService', () => {
  const t0 = 1_700_000_000_000;

  // Trips log at warn level by design; keep the suite output readable.
  beforeAll(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterAll(() => jest.restoreAllMocks());

  it('stays closed while the price is calm', () => {
    const breaker = createService();
    breaker.observe('vSOL', parsePrice('420'), t0);
    breaker.observe('vSOL', parsePrice('425'), t0 + 10_000);
    breaker.observe('vSOL', parsePrice('418'), t0 + 20_000);

    expect(breaker.getState('vSOL', t0 + 20_000).tripped).toBe(false);
    expect(() => breaker.assertTradable('vSOL', t0 + 20_000)).not.toThrow();
  });

  it('trips once the window range breaches the threshold', () => {
    const breaker = createService();
    breaker.observe('vSOL', parsePrice('400'), t0);
    const state = breaker.observe('vSOL', parsePrice('460'), t0 + 5_000); // +15%

    expect(state.tripped).toBe(true);
    expect(state.moveBps).toBe(1500);
    expect(() => breaker.assertTradable('vSOL', t0 + 5_000)).toThrow(CircuitBreakerException);
  });

  it('measures peak-to-trough, not first-to-last', () => {
    const breaker = createService();
    breaker.observe('vSOL', parsePrice('400'), t0);
    breaker.observe('vSOL', parsePrice('480'), t0 + 1_000); // +20% spike
    const state = breaker.observe('vSOL', parsePrice('401'), t0 + 2_000); // retraced

    // First-to-last is +0.25%, but the asset clearly dislocated.
    expect(state.tripped).toBe(true);
  });

  it('resumes trading after the cooldown elapses', () => {
    const breaker = createService();
    breaker.observe('vSOL', parsePrice('400'), t0);
    breaker.observe('vSOL', parsePrice('460'), t0 + 1_000);

    expect(() => breaker.assertTradable('vSOL', t0 + 29_000)).toThrow(CircuitBreakerException);
    expect(() => breaker.assertTradable('vSOL', t0 + 31_001)).not.toThrow();
  });

  it('ignores a move whose legs have aged out of the window', () => {
    const breaker = createService();
    breaker.observe('vSOL', parsePrice('400'), t0);
    // 90s later the $400 print is outside the 60s window, so no range exists.
    const state = breaker.observe('vSOL', parsePrice('460'), t0 + 90_000);
    expect(state.tripped).toBe(false);
  });

  it('reports how long the client should wait', () => {
    const breaker = createService();
    breaker.observe('vSOL', parsePrice('400'), t0);
    breaker.observe('vSOL', parsePrice('460'), t0 + 1_000);

    try {
      breaker.assertTradable('vSOL', t0 + 6_000);
      fail('expected the breaker to reject');
    } catch (error) {
      const details = (error as CircuitBreakerException).details as Record<string, unknown>;
      expect(details.symbol).toBe('vSOL');
      expect(details.retryAfterMs).toBe(25_000); // tripped at t0+1s, 30s cooldown, asked at t0+6s
      expect(details.thresholdBps).toBe(1500);
    }
  });

  it('isolates assets from one another', () => {
    const breaker = createService();
    breaker.observe('vSOL', parsePrice('400'), t0);
    breaker.observe('vSOL', parsePrice('460'), t0 + 1_000);
    breaker.observe('vATL', parsePrice('95'), t0 + 1_000);

    expect(() => breaker.assertTradable('vSOL', t0 + 2_000)).toThrow();
    expect(() => breaker.assertTradable('vATL', t0 + 2_000)).not.toThrow();
  });

  it('clears state on reset', () => {
    const breaker = createService();
    breaker.observe('vSOL', parsePrice('400'), t0);
    breaker.observe('vSOL', parsePrice('460'), t0 + 1_000);
    breaker.reset('vSOL');
    expect(() => breaker.assertTradable('vSOL', t0 + 2_000)).not.toThrow();
  });
});
