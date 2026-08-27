import { formatQuantity, parsePrice, parseQuantity } from '../common/money';
import { LiquiditySource, buildMatchPlan } from './match-plan';

const LOT = parseQuantity('0.00001');
const TAKER = 'taker-user';

const user = (
  price: string,
  quantity: string,
  overrides: Partial<LiquiditySource> = {},
): LiquiditySource => ({
  kind: 'USER',
  price: parsePrice(price),
  quantity: parseQuantity(quantity),
  orderId: `order-${price}-${quantity}`,
  userId: 'maker-user',
  restingSince: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

const synthetic = (price: string, quantity: string): LiquiditySource => ({
  kind: 'SYNTHETIC',
  price: parsePrice(price),
  quantity: parseQuantity(quantity),
});

const plan = (
  side: 'BUY' | 'SELL',
  quantity: string,
  sources: LiquiditySource[],
  limitPrice?: string,
) =>
  buildMatchPlan({
    side,
    quantity: parseQuantity(quantity),
    limitPrice: limitPrice ? parsePrice(limitPrice) : undefined,
    sources,
    takerUserId: TAKER,
    lotSize: LOT,
  });

describe('buildMatchPlan', () => {
  it('takes the best price first when buying', () => {
    const result = plan('BUY', '5', [synthetic('102', '10'), synthetic('101', '10')]);
    expect(result.executions[0].price).toBe(parsePrice('101'));
    expect(result.remainingQuantity).toBe(0n);
  });

  it('takes the highest bid first when selling', () => {
    const result = plan('SELL', '5', [synthetic('99', '10'), synthetic('100', '10')]);
    expect(result.executions[0].price).toBe(parsePrice('100'));
  });

  it('fills user liquidity ahead of synthetic depth at the same price', () => {
    const result = plan('BUY', '5', [synthetic('101', '10'), user('101', '10')]);
    expect(result.executions[0].source.kind).toBe('USER');
  });

  it('honours time priority among user orders at the same price', () => {
    const older = user('101', '3', {
      orderId: 'older',
      restingSince: new Date('2026-01-01T00:00:00Z'),
    });
    const newer = user('101', '3', {
      orderId: 'newer',
      restingSince: new Date('2026-01-01T00:05:00Z'),
    });
    const result = plan('BUY', '6', [newer, older]);
    expect(result.executions.map((e) => e.source.orderId)).toEqual(['older', 'newer']);
  });

  it('skips the taker’s own resting orders', () => {
    const own = user('101', '10', { userId: TAKER, orderId: 'own' });
    const result = plan('BUY', '5', [own, synthetic('102', '10')]);
    expect(result.executions).toHaveLength(1);
    expect(result.executions[0].source.kind).toBe('SYNTHETIC');
  });

  it('ignores liquidity outside the limit price', () => {
    const result = plan('BUY', '10', [synthetic('101', '4'), synthetic('105', '10')], '102');
    expect(formatQuantity(result.filledQuantity)).toBe('4.00000000');
    expect(formatQuantity(result.remainingQuantity)).toBe('6.00000000');
  });

  it('produces a partial fill when the book is thin', () => {
    const result = plan('BUY', '10', [synthetic('101', '2'), synthetic('102', '3')]);
    expect(formatQuantity(result.filledQuantity)).toBe('5.00000000');
    expect(formatQuantity(result.remainingQuantity)).toBe('5.00000000');
    expect(result.executions).toHaveLength(2);
  });

  it('sums notional across every execution', () => {
    const result = plan('BUY', '5', [synthetic('100', '2'), synthetic('110', '3')]);
    // 2 × 100 + 3 × 110 = 530
    expect(result.filledNotional).toBe(parsePrice('530'));
  });

  it('rounds the request down to a whole number of lots', () => {
    const result = buildMatchPlan({
      side: 'BUY',
      quantity: parseQuantity('1.000009'),
      sources: [synthetic('100', '10')],
      takerUserId: TAKER,
      lotSize: LOT,
    });
    expect(formatQuantity(result.filledQuantity)).toBe('1.00000000');
  });

  it('returns an empty plan when nothing is eligible', () => {
    const result = plan('BUY', '5', []);
    expect(result.executions).toHaveLength(0);
    expect(result.filledQuantity).toBe(0n);
    expect(formatQuantity(result.remainingQuantity)).toBe('5.00000000');
  });

  it('is deterministic for identically-priced identical sources', () => {
    const sources = [synthetic('101', '2'), synthetic('101', '2'), user('101', '2')];
    expect(plan('BUY', '6', sources)).toEqual(plan('BUY', '6', [...sources].reverse()));
  });
});
