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

const { mockGetCached, mockGetCachedBatch, mockSave } = vi.hoisted(() => ({
  mockGetCached: vi.fn<(...args: any[]) => Promise<any[] | null>>(),
  mockGetCachedBatch: vi.fn<(...args: any[]) => Promise<Map<string, any[] | null>>>(),
  mockSave: vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined),
}));

vi.mock("../../server/lab/candle-store", () => ({
  getCachedCandles: (...a: any[]) => mockGetCached(...a),
  getCachedCandlesBatch: (...a: any[]) => mockGetCachedBatch(...a),
  saveCandlesToDb: (...a: any[]) => mockSave(...a),
  CACHE_BUDGET_ABORT_REASON: "candle-cache-budget-exceeded",
}));

import {
  fetchOHLCV,
  isCacheDegradedError,
  MONEY_CANDLE_POLICY,
  prefetchCachedOHLCV,
  SCANNER_BATCH_CACHE_QUERY_TIMEOUT_MS,
} from "../../server/lab/datafeed";

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
  mockGetCachedBatch.mockReset();
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
    { basisPolicy: MONEY_CANDLE_POLICY, deadlineMs, callerClass: "scanner", signal },
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

  it("WO-10: budget fires during cache read, query then rejects with plain Error (non-AbortError) → CacheDegradedError (signal-state wins), no providers, no write", async () => {
    // The budget timer fires while getCachedCandles is pending. The inner
    // candle-store code re-throws with a non-AbortError because the query
    // rejected with a plain Error after the budget signal fired. The
    // datafeed catch must check budgetCtrl.signal.aborted (state-first) and
    // convert to CacheDegradedError — NOT interpret the non-AbortError as a
    // miss that allows network fallback.
    let rejectQuery!: (e: Error) => void;
    mockGetCached.mockImplementation(
      () =>
        new Promise<null>((_res, rej) => {
          rejectQuery = rej;
        }),
    );

    const p = runFetch(4_000);
    p.catch(() => {});

    // Advance past the 1000ms cache budget to fire budgetCtrl.
    await vi.advanceTimersByTimeAsync(1_100);

    // Now reject the pending getCachedCandles with a plain Error — simulating
    // what candle-store does when the query rejects with a non-AbortError
    // after the signal has fired.
    rejectQuery(new Error("DB reset connection"));
    await vi.advanceTimersByTimeAsync(10);

    let caught: unknown;
    try {
      await p;
    } catch (err) {
      caught = err;
    }
    expect(isCacheDegradedError(caught)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("WO-10: operational cache-read error before budget fires (pool/SQL/connection failure) → CacheDegradedError, no providers, no write", async () => {
    // getCachedCandles rejects immediately with an operational error (not an
    // AbortError, budget not yet expired). Datafeed must classify this as
    // degradation — never a miss — so it does not start OKX/Gate/Pyth calls
    // or a cache write-back while the DB is degraded.
    mockGetCached.mockImplementation(() =>
      Promise.reject(new Error("Pool checkout timeout")),
    );

    const p = runFetch(4_000);
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(10); // let rejection propagate

    let caught: unknown;
    try {
      await p;
    } catch (err) {
      caught = err;
    }
    expect(isCacheDegradedError(caught)).toBe(true);
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

describe("prefetchCachedOHLCV batch hits", () => {
  function cachedBars(now: number, provenance = {
    source: "okx", venue: "okx", basis: "perp", proxy: "direct",
    finality: "finalized", timeSemantic: "open_time",
  }) {
    return Array.from({ length: 101 }, (_, index) => ({
      time: now - (100 - index) * TF_MS,
      open: 10, high: 11, low: 9, close: 10, volume: 1, provenance,
    }));
  }

  it("passes the exact 5-second SELECT timeout and admits a fresh policy-equivalent hit", async () => {
    const now = Date.now();
    mockGetCachedBatch.mockResolvedValue(new Map([
      ["SOL/USDT", cachedBars(now)],
      ["MISS/USDT", null],
    ]));

    const hits = await prefetchCachedOHLCV(
      ["SOL/USDT", "MISS/USDT"], "15m", now - 100 * TF_MS, now,
      { basisPolicy: MONEY_CANDLE_POLICY, callerClass: "scanner" },
    );

    expect([...hits.keys()]).toEqual(["SOL/USDT"]);
    expect(mockGetCachedBatch).toHaveBeenCalledWith(
      ["SOL/USDT", "MISS/USDT"], "15m", now - 100 * TF_MS, now,
      expect.objectContaining({
        queryTimeoutMs: SCANNER_BATCH_CACHE_QUERY_TIMEOUT_MS,
        callerClass: "scanner",
      }),
    );
    expect(SCANNER_BATCH_CACHE_QUERY_TIMEOUT_MS).toBe(5_000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("turns policy-ineligible and stale groups into misses without a wrapper-level error", async () => {
    const now = Date.now();
    const spot = cachedBars(now, {
      source: "okx", venue: "okx", basis: "spot", proxy: "direct",
      finality: "finalized", timeSemantic: "open_time",
    });
    const stale = cachedBars(now - 3 * TF_MS);
    mockGetCachedBatch.mockResolvedValue(new Map([
      ["SPOT/USDT", spot],
      ["STALE/USDT", stale],
    ]));

    await expect(prefetchCachedOHLCV(
      ["SPOT/USDT", "STALE/USDT"], "15m", now - 100 * TF_MS, now,
      { basisPolicy: MONEY_CANDLE_POLICY },
    )).resolves.toEqual(new Map());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("aborts a wedged batch at the reviewed five-second bound without reaching a provider", async () => {
    mockGetCachedBatch.mockImplementation(
      (_symbols, _timeframe, _start, _end, opts?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const signal = opts?.signal;
          const fail = () => {
            const error = new Error(String(signal?.reason ?? "aborted"));
            error.name = "AbortError";
            reject(error);
          };
          if (signal?.aborted) fail();
          else signal?.addEventListener("abort", fail, { once: true });
        }),
    );
    const now = Date.now();
    const pending = prefetchCachedOHLCV(
      ["SOL/USDT"], "15m", now - 100 * TF_MS, now,
      { basisPolicy: MONEY_CANDLE_POLICY },
    );
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(5_100);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
