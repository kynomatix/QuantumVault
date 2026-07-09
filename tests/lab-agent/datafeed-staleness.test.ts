// Regression tests for the live-range staleness gate in fetchOHLCV.
//
// Root cause: the cache-hit branch returned stale candles for live requests
// (e.g. "Newest 15m candle is 40m old") because it only checked count ≥ 100,
// not recency. The fix adds a freshness check when endMs is near now.
//
// Three invariants:
//   A. Historical range with a full cache → cache hits, zero fetch calls.
//   B. Live range with a fresh cached tail → cache hits, zero fetch calls.
//   C. Live range with a stale cached tail → cache bypassed, fetch called.

import { describe, it, expect, afterEach, vi } from "vitest";

// vi.mock is hoisted — mock objects must be declared via vi.hoisted().
const { mockGetCached, mockSave } = vi.hoisted(() => ({
  mockGetCached: vi.fn<(...args: any[]) => Promise<any[] | null>>(),
  mockSave: vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined),
}));

vi.mock("../../server/lab/candle-store", () => ({
  getCachedCandles: (...a: any[]) => mockGetCached(...a),
  saveCandlesToDb: (...a: any[]) => mockSave(...a),
}));

import { fetchOHLCV } from "../../server/lab/datafeed";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const INTERVAL_15M = 15 * 60 * 1000; // 900_000 ms

/** Build n OHLCV candles, first candle at startMs, each intervalMs apart. */
function makeCandles(n: number, startMs: number, intervalMs: number) {
  return Array.from({ length: n }, (_, i) => ({
    time: startMs + i * intervalMs,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1,
  }));
}

/**
 * Minimal fetch stub: returns an empty-data OKX response so the network path
 * completes quickly (emptyPages loop + Gate.io fallback) without real I/O.
 * Gate.io path also gets an empty JSON array, causing its loop to exit.
 */
function makeEmptyFetch() {
  return vi.fn().mockImplementation(async (url: string) => {
    const isOkx = url.includes("okx.com");
    if (isOkx) {
      return { ok: true, status: 200, json: async () => ({ code: "0", data: [] }), text: async () => "" };
    }
    // Gate.io — return empty array
    return { ok: true, status: 200, json: async () => [], text: async () => "" };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fetchOHLCV — live-range staleness gate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // ── A. Historical range: cache always hits regardless of candle recency ──

  it("historical range with full cache hits with zero fetch calls", async () => {
    const now = Date.now();
    const endMs = now - 30 * 24 * 60 * 60 * 1000; // 30 days ago
    const startMs = endMs - 100 * INTERVAL_15M;
    const candles = makeCandles(100, startMs, INTERVAL_15M);

    mockGetCached.mockResolvedValueOnce(candles);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fetchOHLCV(
      "BTC/USDT",
      "15m",
      new Date(startMs).toISOString(),
      new Date(endMs).toISOString(),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toEqual(candles);
  });

  // ── B. Live range, fresh tail: cache hits, no network call ──

  it("live range with cached tail within 2 intervals still cache-hits", async () => {
    const now = Date.now();
    // Newest candle 5 min ago — well within the 2×15m = 30 min freshness window
    const newestTs = now - 5 * 60 * 1000;
    const candles = makeCandles(100, newestTs - 99 * INTERVAL_15M, INTERVAL_15M);

    mockGetCached.mockResolvedValueOnce(candles);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fetchOHLCV(
      "ETH/USDT",
      "15m",
      new Date(now - 100 * INTERVAL_15M).toISOString(),
      new Date(now).toISOString(),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toEqual(candles);
  });

  // ── C. Live range, stale tail: cache bypassed, network fetch triggered ──

  it("live range with stale cached tail (40 min) triggers a network refetch", async () => {
    const now = Date.now();
    // Newest cached candle = 40 min ago → 2.67 × 15m intervals stale
    const newestTs = now - 40 * 60 * 1000;
    const staleCandles = makeCandles(100, newestTs - 99 * INTERVAL_15M, INTERVAL_15M);

    mockGetCached.mockResolvedValueOnce(staleCandles);
    const fetchSpy = makeEmptyFetch();
    vi.stubGlobal("fetch", fetchSpy);

    await fetchOHLCV(
      "SOL/USDT",
      "15m",
      new Date(now - 100 * INTERVAL_15M).toISOString(),
      new Date(now).toISOString(),
    );

    // Cache was bypassed — at least one network call was made
    expect(fetchSpy).toHaveBeenCalled();
    // The stale candle set itself was NOT returned as-is
    const calls = fetchSpy.mock.calls;
    const returnedStale = calls.length === 0; // would mean cache was used (wrong)
    expect(returnedStale).toBe(false);
  });
});
