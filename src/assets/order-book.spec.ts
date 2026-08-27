import { parsePrice, parseQuantity } from '../common/money';
import { BookLevel, mergeLevels, takeableLevels, walkForNotional, walkForQuantity } from './order-book';

const level = (price: string, quantity: string): BookLevel => ({
  price: parsePrice(price),
  quantity: parseQuantity(quantity),
});

const book = {
  bids: [level('99', '10'), level('98', '20'), level('97', '30')],
  asks: [level('101', '10'), level('102', '20'), level('103', '30')],
};

describe('order book', () => {
  describe('takeableLevels', () => {
    it('gives a buyer the asks, cheapest first', () => {
      expect(takeableLevels(book, 'BUY').map((l) => l.price)).toEqual([
        parsePrice('101'),
        parsePrice('102'),
        parsePrice('103'),
      ]);
    });

    it('gives a seller the bids, highest first', () => {
      expect(takeableLevels(book, 'SELL').map((l) => l.price)).toEqual([
        parsePrice('99'),
        parsePrice('98'),
        parsePrice('97'),
      ]);
    });

    it('drops levels outside the limit price', () => {
      expect(takeableLevels(book, 'BUY', parsePrice('102')).map((l) => l.price)).toEqual([
        parsePrice('101'),
        parsePrice('102'),
      ]);
      expect(takeableLevels(book, 'SELL', parsePrice('98')).map((l) => l.price)).toEqual([
        parsePrice('99'),
        parsePrice('98'),
      ]);
    });
  });

  describe('walkForQuantity', () => {
    it('fills within a single level when depth allows', () => {
      const result = walkForQuantity(takeableLevels(book, 'BUY'), parseQuantity('5'));
      expect(result.quantity).toBe(parseQuantity('5'));
      expect(result.notional).toBe(parsePrice('505'));
      expect(result.levels).toHaveLength(1);
      expect(result.exhausted).toBe(false);
    });

    it('sweeps successive levels and pays the worse prices', () => {
      const result = walkForQuantity(takeableLevels(book, 'BUY'), parseQuantity('25'));
      // 10 @ 101 + 15 @ 102 = 1010 + 1530
      expect(result.quantity).toBe(parseQuantity('25'));
      expect(result.notional).toBe(parsePrice('2540'));
      expect(result.levels).toHaveLength(2);
    });

    it('reports exhaustion when the book cannot cover the request', () => {
      const result = walkForQuantity(takeableLevels(book, 'BUY'), parseQuantity('100'));
      expect(result.quantity).toBe(parseQuantity('60'));
      expect(result.exhausted).toBe(true);
    });

    it('returns nothing for a non-positive request', () => {
      expect(walkForQuantity(takeableLevels(book, 'BUY'), 0n).quantity).toBe(0n);
    });
  });

  describe('walkForNotional', () => {
    it('never spends more than the budget', () => {
      const budget = parsePrice('1000');
      const result = walkForNotional(takeableLevels(book, 'BUY'), budget);
      expect(result.notional).toBeLessThanOrEqual(budget);
      expect(result.exhausted).toBe(false);
    });

    it('distinguishes running out of money from running out of liquidity', () => {
      // Budget is satisfiable: stopping early is not exhaustion.
      expect(walkForNotional(takeableLevels(book, 'BUY'), parsePrice('500')).exhausted).toBe(false);
      // Budget far exceeds every level: the book really is exhausted.
      expect(walkForNotional(takeableLevels(book, 'BUY'), parsePrice('10000000')).exhausted).toBe(
        true,
      );
    });

    it('spends across levels in price order', () => {
      const result = walkForNotional(takeableLevels(book, 'BUY'), parsePrice('2000'));
      expect(result.levels[0].price).toBe(parsePrice('101'));
      expect(result.levels[1].price).toBe(parsePrice('102'));
    });
  });

  describe('mergeLevels', () => {
    it('aggregates duplicate prices and sorts by side', () => {
      const merged = mergeLevels(
        [level('100', '1'), level('100', '2'), level('99', '5'), level('101', '0')],
        'BUY',
      );
      expect(merged).toEqual([
        { price: parsePrice('100'), quantity: parseQuantity('3') },
        { price: parsePrice('99'), quantity: parseQuantity('5') },
      ]);
    });

    it('sorts ask levels ascending', () => {
      const merged = mergeLevels([level('102', '1'), level('101', '1')], 'SELL');
      expect(merged.map((l) => l.price)).toEqual([parsePrice('101'), parsePrice('102')]);
    });
  });
});
