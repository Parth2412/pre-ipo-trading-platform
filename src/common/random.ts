/**
 * Deterministic pseudo-random number generation.
 *
 * The market simulation must be reproducible: given the same seed, the same
 * sequence of prices and the same synthetic order book depth. `Math.random()`
 * cannot be seeded, so we use mulberry32 — a small, fast, well-distributed
 * 32-bit generator — plus the Box-Muller transform for normal variates.
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    // Ensure a non-zero uint32 state.
    this.state = (Math.trunc(seed) >>> 0) || 0x9e3779b9;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [min, max). */
  nextInRange(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max]. */
  nextInt(min: number, max: number): number {
    return Math.floor(this.nextInRange(min, max + 1));
  }

  /** Standard normal variate via Box-Muller. */
  nextGaussian(): number {
    // u must be strictly positive for Math.log.
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

/** Stable 32-bit hash, used to derive per-symbol sub-seeds from a master seed. */
export function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
