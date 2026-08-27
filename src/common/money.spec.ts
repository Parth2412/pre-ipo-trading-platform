import {
  applyBps,
  bpsBetween,
  divRoundDown,
  divRoundHalfUp,
  divRoundUp,
  floorToLot,
  formatCash,
  formatPrice,
  formatQuantity,
  notionalOf,
  parseCash,
  parsePrice,
  parseQuantity,
  priceOf,
  quantityForNotional,
  roundToTick,
} from './money';

describe('money', () => {
  describe('parsing and formatting', () => {
    it('round-trips decimal strings at each scale', () => {
      expect(formatPrice(parsePrice('420.00'))).toBe('420.000000');
      expect(formatQuantity(parseQuantity('1.5'))).toBe('1.50000000');
      expect(formatCash(parseCash('1234.56'))).toBe('1234.560000');
    });

    it('scales values to integers rather than floats', () => {
      expect(parsePrice('420.00')).toBe(420_000_000n);
      expect(parseQuantity('1.5')).toBe(150_000_000n);
    });

    it('represents values a float cannot', () => {
      // 0.1 + 0.2 !== 0.3 in IEEE-754; it is exact here.
      expect(parseCash('0.1') + parseCash('0.2')).toBe(parseCash('0.3'));
    });

    it('rejects excess precision instead of silently truncating an order', () => {
      expect(() => parsePrice('1.1234567')).toThrow(/at most 6 decimal places/);
      expect(() => parseQuantity('1.123456789')).toThrow(/at most 8 decimal places/);
    });

    it('rejects values that are not decimal literals', () => {
      expect(() => parsePrice('abc')).toThrow(/decimal number/);
      expect(() => parsePrice('1e5')).toThrow(/decimal number/);
      expect(() => parsePrice('')).toThrow(/decimal number/);
    });

    it('formats negative values with a leading sign', () => {
      expect(formatCash(-parseCash('12.5'))).toBe('-12.500000');
    });
  });

  describe('rounding', () => {
    it.each([
      [5n, 2n, 3n],
      [-5n, 2n, -3n],
      [4n, 2n, 2n],
      [1n, 3n, 0n],
    ])('divRoundHalfUp(%s, %s) = %s', (a, b, expected) => {
      expect(divRoundHalfUp(a, b)).toBe(expected);
    });

    it('rounds down toward zero on both signs', () => {
      expect(divRoundDown(5n, 2n)).toBe(2n);
      expect(divRoundDown(-5n, 2n)).toBe(-2n);
    });

    it('rounds up away from zero on both signs', () => {
      expect(divRoundUp(5n, 2n)).toBe(3n);
      expect(divRoundUp(-5n, 2n)).toBe(-3n);
      expect(divRoundUp(4n, 2n)).toBe(2n);
    });

    it('refuses a non-positive divisor', () => {
      expect(() => divRoundHalfUp(1n, 0n)).toThrow(RangeError);
    });
  });

  describe('trading arithmetic', () => {
    it('computes notional on the cash scale', () => {
      expect(formatCash(notionalOf(parsePrice('420'), parseQuantity('2.5')))).toBe('1050.000000');
    });

    it('never allocates more shares than the budget pays for', () => {
      const price = parsePrice('420.00');
      const budget = parseCash('1000.00');
      const quantity = quantityForNotional(budget, price);
      expect(notionalOf(price, quantity)).toBeLessThanOrEqual(budget);
    });

    it('inverts notional back to the effective price', () => {
      const price = parsePrice('180.25');
      const quantity = parseQuantity('3.5');
      expect(priceOf(notionalOf(price, quantity), quantity)).toBe(price);
    });

    it('rounds fees up so the venue is never short a remainder', () => {
      // 1 bp of $0.000001 is a fraction of the smallest unit; it must not vanish.
      expect(applyBps(1n, 10)).toBe(1n);
      expect(applyBps(parseCash('1000'), 10)).toBe(parseCash('1'));
      expect(applyBps(parseCash('1000'), 0)).toBe(0n);
    });

    it('measures moves in basis points regardless of direction', () => {
      expect(bpsBetween(parsePrice('100'), parsePrice('115'))).toBe(1500);
      expect(bpsBetween(parsePrice('100'), parsePrice('85'))).toBe(1500);
      expect(bpsBetween(0n, parsePrice('10'))).toBe(0);
    });
  });

  describe('market microstructure', () => {
    it('snaps prices to the tick', () => {
      const tick = parsePrice('0.01');
      expect(formatPrice(roundToTick(parsePrice('420.004'), tick))).toBe('420.000000');
      expect(formatPrice(roundToTick(parsePrice('420.005'), tick))).toBe('420.010000');
    });

    it('floors quantities to a whole number of lots', () => {
      const lot = parseQuantity('0.00001');
      expect(formatQuantity(floorToLot(parseQuantity('1.234567'), lot))).toBe('1.23456000');
      expect(floorToLot(parseQuantity('0.000001'), lot)).toBe(0n);
    });
  });
});
