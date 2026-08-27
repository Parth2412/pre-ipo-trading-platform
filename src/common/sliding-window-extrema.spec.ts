import { SlidingWindowExtrema } from './sliding-window-extrema';

describe('SlidingWindowExtrema', () => {
  it('tracks the extrema of the samples still inside the window', () => {
    const window = new SlidingWindowExtrema(1000);
    window.push(100, 0);
    window.push(120, 100);
    window.push(90, 200);

    expect(window.max?.value).toBe(120);
    expect(window.min?.value).toBe(90);
    expect(window.size).toBe(3);
  });

  it('evicts samples that have aged out', () => {
    const window = new SlidingWindowExtrema(1000);
    window.push(500, 0); // becomes the max, then expires
    window.push(100, 900);
    window.push(110, 1500);

    expect(window.size).toBe(2);
    expect(window.max?.value).toBe(110);
    expect(window.min?.value).toBe(100);
  });

  it('exposes the oldest and newest sample for directional comparisons', () => {
    const window = new SlidingWindowExtrema(10_000);
    window.push(10, 0);
    window.push(30, 1000);
    window.push(20, 2000);

    expect(window.oldest?.value).toBe(10);
    expect(window.newest?.value).toBe(20);
  });

  it('evicts on demand even without a new sample', () => {
    const window = new SlidingWindowExtrema(1000);
    window.push(42, 0);
    expect(window.size).toBe(1);

    window.evict(5000);
    expect(window.size).toBe(0);
    expect(window.max).toBeUndefined();
  });

  it('agrees with a brute-force scan over a long random stream', () => {
    const windowMs = 50;
    const window = new SlidingWindowExtrema(windowMs);
    const samples: Array<{ value: number; at: number }> = [];

    for (let at = 0; at < 2000; at += 1) {
      // Deterministic pseudo-random values; no dependence on Math.random.
      const value = ((at * 1103515245 + 12345) >>> 8) % 1000;
      window.push(value, at);
      samples.push({ value, at });

      const live = samples.filter((sample) => sample.at >= at - windowMs);
      expect(window.max?.value).toBe(Math.max(...live.map((s) => s.value)));
      expect(window.min?.value).toBe(Math.min(...live.map((s) => s.value)));
      expect(window.size).toBe(live.length);
    }
  });

  it('clears back to an empty window', () => {
    const window = new SlidingWindowExtrema(1000);
    window.push(1, 0);
    window.clear();
    expect(window.size).toBe(0);
    expect(window.min).toBeUndefined();
  });

  it('rejects a non-positive window', () => {
    expect(() => new SlidingWindowExtrema(0)).toThrow(RangeError);
  });
});
