/**
 * Bounded circular buffer + numeric percentile helpers for the Live-Data Spine.
 *
 * The Spine MUST stay within bounded memory on the constrained host (no growing
 * tick-history arrays). Every recent-sample window goes through a fixed-capacity
 * RingBuffer that explicitly drops the oldest entry once full.
 */

import type { BasisStats } from './types.js';

export class RingBuffer<T> {
  private buf: (T | undefined)[];
  /** Index of the oldest element. */
  private start = 0;
  /** Number of live elements (0..capacity). */
  private count = 0;

  constructor(public readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.buf = new Array<T | undefined>(capacity);
  }

  /** Append a value; once full, overwrites the oldest entry. O(1). */
  push(value: T): void {
    if (this.count < this.capacity) {
      this.buf[(this.start + this.count) % this.capacity] = value;
      this.count++;
    } else {
      // Full: overwrite the oldest slot, then advance start so it becomes newest.
      this.buf[this.start] = value;
      this.start = (this.start + 1) % this.capacity;
    }
  }

  get size(): number {
    return this.count;
  }

  isFull(): boolean {
    return this.count === this.capacity;
  }

  clear(): void {
    this.start = 0;
    this.count = 0;
    // Drop references so GC can reclaim.
    this.buf = new Array<T | undefined>(this.capacity);
  }

  /** Snapshot in logical order (oldest → newest). */
  toArray(): T[] {
    const out: T[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      out[i] = this.buf[(this.start + i) % this.capacity] as T;
    }
    return out;
  }
}

/**
 * Linear-interpolated percentile over an ascending-sorted array.
 * Returns NaN for an empty array. `p` is 0..100.
 */
export function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  if (n === 1) return sortedAsc[0];
  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const frac = rank - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

/** Compute basis-deviation summary stats, or null when there are no samples. */
export function computeBasisStats(samples: number[]): BasisStats | null {
  const n = samples.length;
  if (n === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    count: n,
    min: sorted[0],
    max: sorted[n - 1],
    mean: sum / n,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}
