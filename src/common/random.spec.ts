import { SeededRandom, hashString } from './random';

describe('SeededRandom', () => {
  it('replays an identical sequence for the same seed', () => {
    const a = new SeededRandom(42);
    const b = new SeededRandom(42);
    const left = Array.from({ length: 20 }, () => a.next());
    const right = Array.from({ length: 20 }, () => b.next());
    expect(left).toEqual(right);
  });

  it('produces different sequences for different seeds', () => {
    expect(new SeededRandom(1).next()).not.toBe(new SeededRandom(2).next());
  });

  it('stays inside the unit interval', () => {
    const random = new SeededRandom(7);
    for (let i = 0; i < 1000; i += 1) {
      const value = random.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('produces gaussian variates with roughly zero mean and unit variance', () => {
    const random = new SeededRandom(2024);
    const samples = Array.from({ length: 20_000 }, () => random.nextGaussian());
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const variance =
      samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length;

    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(Math.abs(variance - 1)).toBeLessThan(0.05);
  });

  it('survives a zero seed', () => {
    expect(() => new SeededRandom(0).next()).not.toThrow();
  });

  it('bounds integers inclusively', () => {
    const random = new SeededRandom(3);
    for (let i = 0; i < 500; i += 1) {
      const value = random.nextInt(1, 5);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(5);
      expect(Number.isInteger(value)).toBe(true);
    }
  });
});

describe('hashString', () => {
  it('is stable and unsigned', () => {
    expect(hashString('vSOL')).toBe(hashString('vSOL'));
    expect(hashString('vSOL')).toBeGreaterThanOrEqual(0);
  });

  it('separates similar inputs', () => {
    expect(hashString('vSOL')).not.toBe(hashString('vATL'));
  });
});
