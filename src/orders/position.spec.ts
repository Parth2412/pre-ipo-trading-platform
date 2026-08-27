import {
  formatCash,
  formatPrice,
  formatQuantity,
  parsePrice,
  parseQuantity,
} from '../common/money';
import { EMPTY_POSITION, applyFill, costBasis, marketValue, unrealizedPnl } from './position';

const buy = (quantity: string, price: string, fee = '0') => ({
  side: 'BUY' as const,
  quantity: parseQuantity(quantity),
  price: parsePrice(price),
  fee: parsePrice(fee),
});

const sell = (quantity: string, price: string, fee = '0') => ({
  side: 'SELL' as const,
  quantity: parseQuantity(quantity),
  price: parsePrice(price),
  fee: parsePrice(fee),
});

describe('position (weighted average cost)', () => {
  it('sets the basis to the fill price on the opening trade', () => {
    const state = applyFill(EMPTY_POSITION, buy('10', '100'));
    expect(formatQuantity(state.quantity)).toBe('10.00000000');
    expect(formatPrice(state.avgCost)).toBe('100.000000');
    expect(state.realizedPnl).toBe(0n);
  });

  it('blends the basis across successive buys', () => {
    let state = applyFill(EMPTY_POSITION, buy('10', '100'));
    state = applyFill(state, buy('10', '200'));
    expect(formatPrice(state.avgCost)).toBe('150.000000');
    expect(formatQuantity(state.quantity)).toBe('20.00000000');
  });

  it('capitalises buy fees into the basis', () => {
    const state = applyFill(EMPTY_POSITION, buy('10', '100', '5'));
    // $1,000 of shares + $5 of fees over 10 shares.
    expect(formatPrice(state.avgCost)).toBe('100.500000');
  });

  it('realises P&L on a sale net of fees and leaves the basis alone', () => {
    let state = applyFill(EMPTY_POSITION, buy('10', '100'));
    state = applyFill(state, sell('4', '150', '6'));

    // Proceeds 600 − 6 fee = 594; cost removed 4 × 100 = 400.
    expect(formatCash(state.realizedPnl)).toBe('194.000000');
    expect(formatPrice(state.avgCost)).toBe('100.000000');
    expect(formatQuantity(state.quantity)).toBe('6.00000000');
  });

  it('accumulates realised P&L across multiple sales', () => {
    let state = applyFill(EMPTY_POSITION, buy('10', '100'));
    state = applyFill(state, sell('5', '120'));
    state = applyFill(state, sell('5', '80'));
    // +100 then −100.
    expect(state.realizedPnl).toBe(0n);
    expect(state.quantity).toBe(0n);
  });

  it('resets the basis when the position goes flat', () => {
    let state = applyFill(EMPTY_POSITION, buy('10', '100'));
    state = applyFill(state, sell('10', '150'));
    expect(state.quantity).toBe(0n);
    expect(state.avgCost).toBe(0n);
    expect(formatCash(state.realizedPnl)).toBe('500.000000');
  });

  it('re-entering after going flat starts a fresh basis', () => {
    let state = applyFill(EMPTY_POSITION, buy('10', '100'));
    state = applyFill(state, sell('10', '150'));
    state = applyFill(state, buy('2', '300'));
    expect(formatPrice(state.avgCost)).toBe('300.000000');
    expect(formatCash(state.realizedPnl)).toBe('500.000000');
  });

  it('never lets a sale drive the quantity negative', () => {
    const state = applyFill(applyFill(EMPTY_POSITION, buy('1', '100')), sell('5', '100'));
    expect(state.quantity).toBe(0n);
  });

  it('ignores a zero-quantity fill', () => {
    const state = applyFill(EMPTY_POSITION, buy('0', '100'));
    expect(state).toEqual(EMPTY_POSITION);
  });

  it('values and marks a position', () => {
    const state = applyFill(EMPTY_POSITION, buy('10', '100'));
    expect(formatCash(costBasis(state))).toBe('1000.000000');
    expect(formatCash(marketValue(state, parsePrice('130')))).toBe('1300.000000');
    expect(formatCash(unrealizedPnl(state, parsePrice('130')))).toBe('300.000000');
    expect(formatCash(unrealizedPnl(state, parsePrice('90')))).toBe('-100.000000');
    expect(unrealizedPnl(EMPTY_POSITION, parsePrice('130'))).toBe(0n);
  });

  it('keeps total P&L consistent across a full round trip', () => {
    // Buy 10 @ 100 (fee 1), sell 10 @ 110 (fee 1). Net = 1100 − 1 − 1000 − 1 = 98.
    let state = applyFill(EMPTY_POSITION, buy('10', '100', '1'));
    state = applyFill(state, sell('10', '110', '1'));
    expect(formatCash(state.realizedPnl)).toBe('98.000000');
  });
});
