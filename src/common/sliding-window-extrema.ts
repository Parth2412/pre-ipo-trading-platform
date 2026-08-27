/**
 * Sliding-window minimum/maximum over a time-bounded stream of samples.
 *
 * Used by the circuit breaker, which must answer "what is the largest relative
 * price move inside the last 60 seconds?" on every order placement. Rescanning
 * the window is O(n) per query and degrades as tick frequency rises.
 *
 * Instead we keep two *monotonic deques*:
 *   - `maxDeque` is non-increasing, so its head is always the window maximum.
 *   - `minDeque` is non-decreasing, so its head is always the window minimum.
 *
 * Each sample is pushed and popped at most once, giving O(1) amortised insert
 * and O(1) worst-case extrema lookup. A ring of raw samples is kept alongside so
 * the oldest/newest values (needed for a directional move) stay available.
 */
export interface WindowSample {
  readonly value: number;
  readonly at: number;
}

export class SlidingWindowExtrema {
  private readonly samples: WindowSample[] = [];
  private readonly maxDeque: WindowSample[] = [];
  private readonly minDeque: WindowSample[] = [];
  private head = 0;

  constructor(private readonly windowMs: number) {
    if (windowMs <= 0) throw new RangeError('windowMs must be positive');
  }

  /** Record a sample. Samples must arrive in non-decreasing timestamp order. */
  push(value: number, at: number): void {
    const sample: WindowSample = { value, at };
    this.samples.push(sample);

    while (this.maxDeque.length > 0 && this.maxDeque[this.maxDeque.length - 1].value <= value) {
      this.maxDeque.pop();
    }
    this.maxDeque.push(sample);

    while (this.minDeque.length > 0 && this.minDeque[this.minDeque.length - 1].value >= value) {
      this.minDeque.pop();
    }
    this.minDeque.push(sample);

    this.evict(at);
  }

  /** Drop every sample older than `now - windowMs`. */
  evict(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.head < this.samples.length && this.samples[this.head].at < cutoff) {
      this.head += 1;
    }
    while (this.maxDeque.length > 0 && this.maxDeque[0].at < cutoff) {
      this.maxDeque.shift();
    }
    while (this.minDeque.length > 0 && this.minDeque[0].at < cutoff) {
      this.minDeque.shift();
    }
    // Compact the backing array once the dead prefix dominates it.
    if (this.head > 64 && this.head * 2 > this.samples.length) {
      this.samples.splice(0, this.head);
      this.head = 0;
    }
  }

  get size(): number {
    return this.samples.length - this.head;
  }

  get max(): WindowSample | undefined {
    return this.maxDeque[0];
  }

  get min(): WindowSample | undefined {
    return this.minDeque[0];
  }

  get oldest(): WindowSample | undefined {
    return this.samples[this.head];
  }

  get newest(): WindowSample | undefined {
    return this.samples[this.samples.length - 1];
  }

  clear(): void {
    this.samples.length = 0;
    this.maxDeque.length = 0;
    this.minDeque.length = 0;
    this.head = 0;
  }
}
