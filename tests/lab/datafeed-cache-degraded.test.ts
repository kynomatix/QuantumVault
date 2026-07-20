// 2026-07-20 incident regression tests: the datafeed cache-budget path in
// server/lab/datafeed.ts (fetchOHLCV). During the incident a slow cache read
// was treated as a MISS, which started a network fetch + full-range cache
// write-back exactly while the DB was under pressure — adding load to the
// wedged pool. The fix fails the invocation typed instead:
//
//   - budget expiry on a deadline-bounded caller → CacheDegradedError,
//     NO network fallback, NO cache write;
//   - caller abort (sweep teardown) → plain AbortError, NOT an incident.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { mockGetCached, mockSave } = vi.hoisted(() => ({
  mockGetCached: vi.fn<(...args: any[]) => Promise<any[] | null>>(),
  mockSave: vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined),
}));

vi.mock("../../server/lab/candle-store", () => ({
  getCachedCandles: (...a: any[]) => mockGetCached(...a),
  saveCandlesToDb: (...a: any[]) => mockSave(...a),
  CACHE_BUDGET_ABORT_REASON: "candle-cache-budget-exceeded",
}));

import { fetchOHLCV, isCacheDegradedError } from "../../server/lab/datafeed";

const TF_MS = 15 * 60 * 1000;

/** Cache read that never resolves on its own — only the AbortSignal ends it. */
function wedgeCacheReads(): void {
  mockGetCached.mockImplementation(
    (_sym: string, _tf: string, _s: number, _e: number, opts?: { signal?: AbortSignal }) =>
      new Promise<any[] | null>((_resolve, reject) => {
        const signal = opts?.signal;
        const fail = () => {
          const err = new Error(String(signal?.reason ?? "aborted"));
          err.name = "AbortError";
          reject(err);
        };
        if (signal?.aborted) return fail();
        signal?.addEventListener("abort", fail, { once: true });
      }),
  );
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  mockGetCached.mockReset();
  mockSave.mockClear();
  wedgeCacheReads();
  fetchSpy = vi.fn().mockImplementation(async (url: unknown) => {
    throw new Error(`network fetch must not run during cache degradation: ${String(url)}`);
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function runFetch(deadlineMs: number, signal?: AbortSignal) {
  const now = Date.now();
  return fetchOHLCV(
    "SOL/USDT",
    "15m",
    new Date(now - 100 * TF_MS).toISOString(),
    new Date(now).toISOString(),
    undefined,
    { deadlineMs, callerClass: "scanner", signal },
  );
}

describe("fetchOHLCV — slow cache under a deadline", () => {
  it("budget expiry → typed CacheDegradedError; NO network fallback, NO cache write", async () => {
    const p = runFetch(4_000); // cache budget = max(1000, 4000/4) = 1000ms
    p.catch(() => {}); // avoid unhandled-rejection noise while timers advance
    await vi.advanceTimersByTimeAsync(1_100); // fire the internal budget timer

    let caught: unknown;
    try {
      await p;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(isCacheDegradedError(caught)).toBe(true);
    // The whole point of the fix: degradation must not add load.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("caller abort (sweep teardown) → plain AbortError, NOT CacheDegradedError", async () => {
    const ctrl = new AbortController();
    const p = runFetch(60_000, ctrl.signal); // budget far away; caller cancels first
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(10);
    ctrl.abort();
    await vi.advanceTimersByTimeAsync(10);

    let caught: any;
    try {
      await p;
    } catch (err) {
      caught = err;
    }
    expect(caught?.name).toBe("AbortError");
    expect(isCacheDegradedError(caught)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });
});
