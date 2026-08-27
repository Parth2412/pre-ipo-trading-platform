import { AppConfig } from '../config/configuration';
import { formatQuantity, notionalOf, parsePrice, parseQuantity } from '../common/money';
import { DepthLadderService, LadderParameters } from './depth-ladder.service';

const config = {
  market: { bookLevels: 10, bookNotionalPerLevelUsd: 25_000, bookSpreadBps: 12 },
} as AppConfig;

const parameters: LadderParameters = {
  symbol: 'vSOL',
  tickSize: parsePrice('0.01'),
  lotSize: parseQuantity('0.00001'),
  annualVolBps: 7000,
};

describe('DepthLadderService', () => {
  const service = new DepthLadderService(config);
  const mid = parsePrice('420.00');

  it('quotes the requested number of levels per side', () => {
    const ladder = service.build(parameters, mid);
    expect(ladder.bids).toHaveLength(10);
    expect(ladder.asks).toHaveLength(10);
  });

  it('brackets the mid with a positive spread', () => {
    const ladder = service.build(parameters, mid);
    expect(ladder.bids[0].price).toBeLessThan(mid);
    expect(ladder.asks[0].price).toBeGreaterThan(mid);
    expect(ladder.asks[0].price).toBeGreaterThan(ladder.bids[0].price);
  });

  it('orders levels away from the touch', () => {
    const ladder = service.build(parameters, mid);
    for (let i = 1; i < ladder.bids.length; i += 1) {
      expect(ladder.bids[i].price).toBeLessThan(ladder.bids[i - 1].price);
      expect(ladder.asks[i].price).toBeGreaterThan(ladder.asks[i - 1].price);
    }
  });

  it('is deterministic for the same symbol and price', () => {
    expect(service.build(parameters, mid)).toEqual(service.build(parameters, mid));
  });

  it('differs between symbols at the same price', () => {
    const other = service.build({ ...parameters, symbol: 'vATL' }, mid);
    expect(other.asks[0].quantity).not.toBe(service.build(parameters, mid).asks[0].quantity);
  });

  it('quotes wider on a more volatile name', () => {
    const calm = service.build({ ...parameters, annualVolBps: 1000 }, mid);
    const wild = service.build({ ...parameters, annualVolBps: 9000 }, mid);
    const spreadOf = (l: typeof calm) => l.asks[0].price - l.bids[0].price;
    expect(spreadOf(wild)).toBeGreaterThan(spreadOf(calm));
  });

  it('sizes levels to roughly the configured notional', () => {
    const ladder = service.build(parameters, mid);
    const topNotional = Number(notionalOf(ladder.asks[0].price, ladder.asks[0].quantity)) / 1e6;
    expect(topNotional).toBeGreaterThan(25_000 * 0.6);
    expect(topNotional).toBeLessThan(25_000 * 1.4);
  });

  it('deepens as levels move away from the touch', () => {
    const ladder = service.build(parameters, mid);
    const front = ladder.asks.slice(0, 3).reduce((sum, l) => sum + l.quantity, 0n);
    const back = ladder.asks.slice(-3).reduce((sum, l) => sum + l.quantity, 0n);
    expect(back).toBeGreaterThan(front);
  });

  it('quotes whole lots only', () => {
    const ladder = service.build(parameters, mid);
    for (const level of [...ladder.bids, ...ladder.asks]) {
      expect(level.quantity % parameters.lotSize).toBe(0n);
      expect(formatQuantity(level.quantity)).toMatch(/^\d+\.\d{8}$/);
    }
  });
});
