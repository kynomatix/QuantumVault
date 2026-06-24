import { describe, it, expect } from "vitest";
import {
  RingBuffer,
  percentile,
  computeBasisStats,
} from "../../server/live-data-spine/ring-buffer";
import { PriceStore } from "../../server/live-data-spine/price-store";
import type { PriceTick } from "../../server/live-data-spine/types";

function tick(over: Partial<PriceTick> = {}): PriceTick {
  return {
    venue: "pacifica",
    internalSymbol: "SOL-PERP",
    mark: 100,
    oracle: 100,
    funding: 0,
    publishTime: 1_000,
    receivedAt: 1_000,
    ...over,
  };
}

describe("RingBuffer", () => {
  it("rejects non-positive / non-integer capacity", () => {
    expect(() => new RingBuffer<number>(0)).toThrow();
    expect(() => new RingBuffer<number>(-1)).toThrow();
    expect(() => new RingBuffer<number>(2.5)).toThrow();
  });

  it("fills up to capacity then drops the oldest, preserving order", () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    expect(rb.size).toBe(3);
    expect(rb.isFull()).toBe(true);
    expect(rb.toArray()).toEqual([1, 2, 3]);

    rb.push(4); // drops 1
    rb.push(5); // drops 2
    expect(rb.size).toBe(3);
    expect(rb.toArray()).toEqual([3, 4, 5]);
  });

  it("never exceeds capacity under heavy churn (bounded memory)", () => {
    const rb = new RingBuffer<number>(5);
    for (let i = 0; i < 10_000; i++) rb.push(i);
    expect(rb.size).toBe(5);
    expect(rb.toArray()).toEqual([9995, 9996, 9997, 9998, 9999]);
  });

  it("clears", () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1);
    rb.clear();
    expect(rb.size).toBe(0);
    expect(rb.toArray()).toEqual([]);
  });
});

describe("percentile", () => {
  it("handles empty / single", () => {
    expect(Number.isNaN(percentile([], 50))).toBe(true);
    expect(percentile([42], 99)).toBe(42);
  });

  it("interpolates", () => {
    const data = [0, 1, 2, 3, 4];
    expect(percentile(data, 0)).toBe(0);
    expect(percentile(data, 50)).toBe(2);
    expect(percentile(data, 100)).toBe(4);
    expect(percentile(data, 25)).toBe(1);
  });
});

describe("computeBasisStats", () => {
  it("returns null for no samples", () => {
    expect(computeBasisStats([])).toBeNull();
  });

  it("computes min/max/mean/percentiles", () => {
    const stats = computeBasisStats([0.001, 0.002, 0.003, 0.004])!;
    expect(stats.count).toBe(4);
    expect(stats.min).toBeCloseTo(0.001, 12);
    expect(stats.max).toBeCloseTo(0.004, 12);
    expect(stats.mean).toBeCloseTo(0.0025, 12);
    expect(stats.p50).toBeCloseTo(0.0025, 12);
  });
});

describe("PriceStore", () => {
  it("records ticks and reports latest + counts", () => {
    const store = new PriceStore();
    store.recordTick(tick({ mark: 101, receivedAt: 2_000 }));
    store.recordTick(tick({ mark: 102, receivedAt: 3_000 }));

    expect(store.symbolCount()).toBe(1);
    const latest = store.getLatest("pacifica", "SOL-PERP");
    expect(latest?.mark).toBe(102);

    const status = store.getStatus(5_000);
    expect(status).toHaveLength(1);
    expect(status[0].tickCount).toBe(2);
    expect(status[0].lastSeenAt).toBe(3_000);
    expect(status[0].ageMs).toBe(2_000);
  });

  it("separates entries by venue and symbol", () => {
    const store = new PriceStore();
    store.recordTick(tick({ venue: "pacifica", internalSymbol: "SOL-PERP" }));
    store.recordTick(tick({ venue: "flash", internalSymbol: "SOL-PERP" }));
    store.recordTick(tick({ venue: "pacifica", internalSymbol: "BTC-PERP" }));
    expect(store.symbolCount()).toBe(3);
  });

  it("accumulates basis deviation stats from mark vs oracle", () => {
    const store = new PriceStore();
    // |100.5 - 100| / 100 = 0.005, |101 - 100| / 100 = 0.01
    store.recordTick(tick({ mark: 100.5, oracle: 100 }));
    store.recordTick(tick({ mark: 101, oracle: 100 }));
    const basis = store.getStatus()[0].basis!;
    expect(basis.count).toBe(2);
    expect(basis.min).toBeCloseTo(0.005, 12);
    expect(basis.max).toBeCloseTo(0.01, 12);
  });

  it("skips basis when oracle is null or non-positive", () => {
    const store = new PriceStore();
    store.recordTick(tick({ mark: 100, oracle: null }));
    store.recordTick(tick({ mark: 100, oracle: 0 }));
    expect(store.getStatus()[0].basis).toBeNull();
  });

  it("treats a non-finite mark as a parse error and keeps last good tick", () => {
    const store = new PriceStore();
    store.recordTick(tick({ mark: 100, receivedAt: 1_000 }));
    store.recordTick(tick({ mark: NaN, receivedAt: 2_000 }));
    expect(store.getParseErrorCount()).toBe(1);
    expect(store.getLatest("pacifica", "SOL-PERP")?.mark).toBe(100);
    expect(store.getStatus()[0].tickCount).toBe(1);
  });

  it("bounds basis samples to the ring capacity", () => {
    const store = new PriceStore(10);
    for (let i = 0; i < 1_000; i++) {
      store.recordTick(tick({ mark: 100 + i * 0.001, oracle: 100 }));
    }
    expect(store.getStatus()[0].basis!.count).toBe(10);
  });

  it("caps the number of tracked symbols (bounded vs churn)", () => {
    const store = new PriceStore(10, 2);
    store.recordTick(tick({ internalSymbol: "AAA-PERP" }));
    store.recordTick(tick({ internalSymbol: "BBB-PERP" }));
    store.recordTick(tick({ internalSymbol: "CCC-PERP" })); // exceeds cap -> dropped
    expect(store.symbolCount()).toBe(2);
    expect(store.getDroppedSymbolCount()).toBe(1);
    // Existing symbols still update after the cap is hit.
    store.recordTick(tick({ internalSymbol: "AAA-PERP", mark: 123 }));
    expect(store.getLatest("pacifica", "AAA-PERP")?.mark).toBe(123);
  });
});
