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
  isCandleBatchPartialReadError: (error: any) => error?.name === "CandleBatchPartialReadError"
    && error?.code === "candle_batch_partial_read"
    && error?.completed instanceof Map
    && error?.unresolvedSymbols instanceof Set
    && ["pool_acquire_timeout", "batch_deadline_exhausted", "server_statement_timeout", "client_query_timeout", "connection_error", "query_error"]
      .includes(String(error?.termination)),
  saveCandlesToDb: (...a: any[]) => mockSave(...a),
  CACHE_BUDGET_ABORT_REASON: "candle-cache-budget-exceeded",
}));

import {
  AI_CONTEXT_CANDLE_POLICY,
  __testResetOkxSourceBreaker,
  completeCachedOHLCVTail,
  fetchOHLCV,
  isCacheDegradedError,
  mergeScannerCandleTail,
  MONEY_CANDLE_POLICY,
  prefetchCachedOHLCV,
  SCANNER_BATCH_CACHE_QUERY_TIMEOUT_MS,
  setOkxDatafeedDiagnosticReporter,
  type OkxDatafeedDiagnostic,
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
let okxDiagnostics: OkxDatafeedDiagnostic[];

beforeEach(() => {
  vi.useFakeTimers();
  __testResetOkxSourceBreaker();
  mockGetCached.mockReset();
  mockGetCachedBatch.mockReset();
  mockSave.mockClear();
  wedgeCacheReads();
  fetchSpy = vi.fn().mockImplementation(async (url: unknown) => {
    throw new Error(`network fetch must not run during cache degradation: ${String(url)}`);
  });
  vi.stubGlobal("fetch", fetchSpy);
  okxDiagnostics = [];
  setOkxDatafeedDiagnosticReporter((record) => okxDiagnostics.push(record));
});

afterEach(() => {
  setOkxDatafeedDiagnosticReporter(null);
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

describe("provider response-body cancellation lifetime", () => {
  it("forwards caller abort after headers while the OKX body is pending", async () => {
    const caller = new AbortController();
    let internalSignal: AbortSignal | undefined;
    let bodyStarted!: () => void;
    const bodyIsPending = new Promise<void>((resolve) => { bodyStarted = resolve; });
    fetchSpy.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      internalSignal = init?.signal ?? undefined;
      return {
        status: 200,
        ok: true,
        json: () => new Promise((_resolve, reject) => {
          bodyStarted();
          const rejectAborted = () => {
            const error = new Error("provider body aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (internalSignal?.aborted) rejectAborted();
          else internalSignal?.addEventListener("abort", rejectAborted, { once: true });
        }),
      };
    });

    const now = Date.now();
    const pending = fetchOHLCV(
      "SOL/USDT", "15m", now - TF_MS, now, undefined,
      {
        basisPolicy: MONEY_CANDLE_POLICY,
        bypassCache: true,
        cacheWritePolicy: "skip",
        deadlineMs: 45_000,
        signal: caller.signal,
        callerClass: "scanner",
      },
    );
    pending.catch(() => {});
    await bodyIsPending;
    expect(internalSignal).toBeDefined();
    expect(internalSignal).not.toBe(caller.signal);

    caller.abort("sweep-stopped-after-headers");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockSave).not.toHaveBeenCalled();
    expect(okxDiagnostics).toEqual([
      expect.objectContaining({
        kind: "okx_request_terminal",
        provider: "okx",
        callerClass: "scanner",
        instrument: "SOL-USDT-SWAP",
        timeframe: "15m",
        attempt: 1,
        phase: "body",
        settlement: "external_abort",
        elapsedToHeadersMs: 0,
        bodyStartElapsedMs: 0,
        bodyEndElapsedMs: 0,
        externalAbortElapsedMs: 0,
        hardTerminalElapsedMs: null,
        settledElapsedMs: 0,
      }),
    ]);
  });

  it("terminates caller-aborted OKX bodies that ignore the internal signal", async () => {
    const caller = new AbortController();
    let internalSignal: AbortSignal | undefined;
    let bodyStarted!: () => void;
    const bodyIsPending = new Promise<void>((resolve) => { bodyStarted = resolve; });
    fetchSpy.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      internalSignal = init?.signal ?? undefined;
      return {
        status: 200,
        ok: true,
        json: () => {
          bodyStarted();
          return new Promise(() => {});
        },
      };
    });

    const now = Date.now();
    const pending = fetchOHLCV(
      "SOL/USDT", "15m", now - TF_MS, now, undefined,
      {
        basisPolicy: MONEY_CANDLE_POLICY,
        bypassCache: true,
        cacheWritePolicy: "skip",
        deadlineMs: 45_000,
        signal: caller.signal,
      },
    );
    pending.catch(() => {});
    await bodyIsPending;

    caller.abort("sweep-stopped-signal-ignored-by-body");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(internalSignal?.aborted).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockSave).not.toHaveBeenCalled();
    expect(okxDiagnostics).toEqual([
      expect.objectContaining({
        kind: "okx_request_terminal",
        attempt: 1,
        phase: "body",
        settlement: "external_abort",
      }),
    ]);
  });

  it("hard-terminates every signal-ignoring direct-perpetual provider opportunity", async () => {
    const internalSignals: AbortSignal[] = [];
    fetchSpy.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if (init?.signal) internalSignals.push(init.signal);
      return {
        status: 200,
        ok: true,
        json: () => new Promise(() => {}),
      };
    });

    const now = Date.now();
    const pending = fetchOHLCV(
      "HARDTERMINAL/USDT", "15m", now - TF_MS, now, undefined,
      {
        basisPolicy: MONEY_CANDLE_POLICY,
        bypassCache: true,
        cacheWritePolicy: "skip",
        skipSpotFallback: true,
        deadlineMs: 62_000,
      },
    );
    pending.catch(() => {});

    await vi.advanceTimersByTimeAsync(65_000);
    await expect(pending).rejects.toBeDefined();
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(internalSignals).toHaveLength(4);
    expect(internalSignals.every((signal) => signal.aborted)).toBe(true);
    expect(mockSave).not.toHaveBeenCalled();
    expect(okxDiagnostics.filter((record) => record.kind === "okx_request_terminal")).toEqual([
      expect.objectContaining({ provider: "okx", endpoint: "openapi", attempt: 1, phase: "body", settlement: "hard_terminal" }),
      expect.objectContaining({ provider: "gate", endpoint: "api", attempt: 1, phase: "body", settlement: "hard_terminal" }),
      expect.objectContaining({ provider: "okx", endpoint: "legacy", attempt: 1, phase: "body", settlement: "hard_terminal" }),
      expect.objectContaining({ provider: "gate", endpoint: "fx", attempt: 1, phase: "body", settlement: "hard_terminal" }),
    ]);
    expect(okxDiagnostics).toContainEqual(expect.objectContaining({
      kind: "okx_source_breaker_increment",
      instrument: "HARDTERMINAL-USDT-SWAP",
      timeframe: "15m",
      attempt: 1,
      priorConsecutiveFailures: 0,
      resultingConsecutiveFailures: 1,
      opened: false,
      cooldownMs: 15 * 60_000,
    }));
    expect(okxDiagnostics).toContainEqual(expect.objectContaining({
      kind: "gate_futures_source_breaker_increment",
      provider: "gate",
      instrument: "HARDTERMINAL_USDT",
      priorConsecutiveFailures: 0,
      resultingConsecutiveFailures: 1,
    }));
  });

  it("attributes a pre-header transport rejection caused by the internal controller deadline", async () => {
    fetchSpy.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      const signal = init?.signal;
      return await new Promise((_resolve, reject) => {
        const rejectAborted = () => {
          const error = new Error("transport observed internal abort");
          error.name = "AbortError";
          reject(error);
        };
        if (signal?.aborted) rejectAborted();
        else signal?.addEventListener("abort", rejectAborted, { once: true });
      });
    });

    const now = Date.now();
    const pending = fetchOHLCV(
      "CONTROLLER/USDT", "15m", now - TF_MS, now, undefined,
      {
        basisPolicy: MONEY_CANDLE_POLICY,
        bypassCache: true,
        cacheWritePolicy: "skip",
        skipSpotFallback: true,
        // One complete three-attempt chain (15s + 1s + 15s + 2s + 15s)
        // is allowed to finish, then the outer deadline stops pagination.
        deadlineMs: 45_000,
        callerClass: "scanner",
      },
    );
    pending.catch(() => {});

    await vi.advanceTimersByTimeAsync(50_000);
    await expect(pending).rejects.toBeDefined();

    expect(okxDiagnostics.filter((record) => record.kind === "okx_request_terminal")).toEqual([
      expect.objectContaining({
        attempt: 1,
        phase: "headers",
        settlement: "controller_abort",
        elapsedToHeadersMs: null,
        provider: "okx",
        endpoint: "openapi",
        controllerAbortElapsedMs: 10_000,
        hardTerminalElapsedMs: null,
        settledElapsedMs: 10_000,
      }),
      expect.objectContaining({
        provider: "gate",
        endpoint: "api",
        attempt: 1,
        phase: "headers",
        settlement: "controller_abort",
        controllerAbortElapsedMs: 10_000,
      }),
      expect.objectContaining({
        provider: "okx",
        endpoint: "legacy",
        attempt: 1,
        phase: "headers",
        settlement: "controller_abort",
        controllerAbortElapsedMs: 10_000,
      }),
      expect.objectContaining({
        provider: "gate",
        endpoint: "fx",
        attempt: 1,
        phase: "headers",
        settlement: "controller_abort",
        controllerAbortElapsedMs: 10_000,
      }),
    ]);
    expect(okxDiagnostics).toContainEqual(expect.objectContaining({
      kind: "okx_source_breaker_increment",
      callerClass: "scanner",
      instrument: "CONTROLLER-USDT-SWAP",
      attempt: 1,
      priorConsecutiveFailures: 0,
      resultingConsecutiveFailures: 1,
      opened: false,
    }));
  });

  it("aborts every unread 429 response without retry backoff inside a provider", async () => {
    const internalSignals: AbortSignal[] = [];
    fetchSpy.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if (init?.signal) internalSignals.push(init.signal);
      return {
        status: 429,
        ok: false,
        json: vi.fn(),
        text: vi.fn(),
      };
    });

    const now = Date.now();
    const pending = fetchOHLCV(
      "SOL/USDT", "15m", now - TF_MS, now, undefined,
      {
        basisPolicy: MONEY_CANDLE_POLICY,
        bypassCache: true,
        cacheWritePolicy: "skip",
        deadlineMs: 45_000,
      },
    );
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(50_000);
    await expect(pending).rejects.toMatchObject({ name: "CandleSourceUnavailableError" });
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(internalSignals.every((signal) => signal.aborted)).toBe(true);
    expect(mockSave).not.toHaveBeenCalled();
    expect(okxDiagnostics.filter((record) => record.kind === "okx_request_terminal"))
      .toHaveLength(4);
    expect(okxDiagnostics.filter((record) => record.kind === "okx_request_terminal"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ provider: "okx", phase: "released_unread", settlement: "http_release" }),
        expect.objectContaining({ provider: "gate", phase: "released_unread", settlement: "http_release" }),
      ]));
  });

  it("records header transport failure without retaining URL or arbitrary error prose", async () => {
    fetchSpy.mockRejectedValue(new Error(
      "Authorization: Bearer should-never-appear; Cookie=session; https://www.okx.com/private?token=secret",
    ));

    const now = Date.now();
    const pending = fetchOHLCV(
      "SCRUB/USDT", "15m", now - TF_MS, now, undefined,
      {
        basisPolicy: MONEY_CANDLE_POLICY,
        bypassCache: true,
        cacheWritePolicy: "skip",
        skipSpotFallback: true,
        // Four bounded endpoint opportunities, with no provider-local retry sleep.
        deadlineMs: 3_000,
        callerClass: "scanner",
      },
    );
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(pending).rejects.toBeDefined();

    const terminals = okxDiagnostics.filter((record) => record.kind === "okx_request_terminal");
    expect(terminals).toHaveLength(4);
    expect(terminals).toEqual([
      expect.objectContaining({ provider: "okx", attempt: 1, endpoint: "openapi", phase: "headers", settlement: "transport_error" }),
      expect.objectContaining({ provider: "gate", attempt: 1, endpoint: "api", phase: "headers", settlement: "transport_error" }),
      expect.objectContaining({ provider: "okx", attempt: 1, endpoint: "legacy", phase: "headers", settlement: "transport_error" }),
      expect.objectContaining({ provider: "gate", attempt: 1, endpoint: "fx", phase: "headers", settlement: "transport_error" }),
    ]);
    expect(fetchSpy.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual([
      "openapi.okx.com", "api.gateio.ws", "www.okx.com", "fx-api.gateio.ws",
    ]);
    const retained = JSON.stringify(okxDiagnostics);
    expect(retained).not.toContain("Authorization");
    expect(retained).not.toContain("Bearer");
    expect(retained).not.toContain("Cookie");
    expect(retained).not.toContain("history-candles");
    expect(retained).not.toContain("token=secret");
    expect(retained).not.toContain("stack");
  });

  it("attributes each source failure and identifies the exact increment that opens the breaker", async () => {
    fetchSpy.mockRejectedValue(new Error("network unavailable"));
    const now = Date.now();

    for (const symbol of ["ONE/USDT", "TWO/USDT", "THREE/USDT"]) {
      const pending = fetchOHLCV(
        symbol, "15m", now - TF_MS, now, undefined,
        {
          basisPolicy: MONEY_CANDLE_POLICY,
          bypassCache: true,
          cacheWritePolicy: "skip",
          skipSpotFallback: true,
          deadlineMs: 3_000,
          callerClass: "scanner",
        },
      );
      pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(pending).rejects.toBeDefined();
    }

    expect(okxDiagnostics.filter((record) => record.kind === "okx_source_breaker_increment")).toEqual([
      expect.objectContaining({
        instrument: "ONE-USDT-SWAP",
        priorConsecutiveFailures: 0,
        resultingConsecutiveFailures: 1,
        opened: false,
      }),
      expect.objectContaining({
        instrument: "TWO-USDT-SWAP",
        priorConsecutiveFailures: 1,
        resultingConsecutiveFailures: 2,
        opened: false,
      }),
      expect.objectContaining({
        instrument: "THREE-USDT-SWAP",
        priorConsecutiveFailures: 2,
        // The established half-open behavior deliberately stores threshold-1.
        resultingConsecutiveFailures: 2,
        opened: true,
        cooldownMs: 15 * 60_000,
      }),
    ]);
    expect(okxDiagnostics.filter((record) => record.kind === "gate_futures_source_breaker_increment")).toEqual([
      expect.objectContaining({ instrument: "ONE_USDT", priorConsecutiveFailures: 0, resultingConsecutiveFailures: 1, opened: false }),
      expect.objectContaining({ instrument: "TWO_USDT", priorConsecutiveFailures: 1, resultingConsecutiveFailures: 2, opened: false }),
      expect.objectContaining({ instrument: "THREE_USDT", priorConsecutiveFailures: 2, resultingConsecutiveFailures: 2, opened: true }),
    ]);

    const networkCallsBeforeOpenCircuitRead = fetchSpy.mock.calls.length;
    await expect(fetchOHLCV(
      "FOUR/USDT", "15m", now - TF_MS, now, undefined,
      {
        basisPolicy: MONEY_CANDLE_POLICY,
        bypassCache: true,
        cacheWritePolicy: "skip",
        skipSpotFallback: true,
        deadlineMs: 3_000,
        callerClass: "scanner",
      },
    )).rejects.toMatchObject({
      name: "CandleSourceUnavailableError",
      reason: "provider_circuit_open",
      source: "direct_perp",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(networkCallsBeforeOpenCircuitRead);
  });

  it("does not turn a transport outage into a per-instrument negative cache", async () => {
    fetchSpy.mockRejectedValue(new Error("network unavailable"));
    const now = Date.now();

    for (let invocation = 0; invocation < 2; invocation++) {
      const pending = fetchOHLCV(
        "RETRYABLE/USDT", "15m", now - TF_MS, now, undefined,
        {
          basisPolicy: MONEY_CANDLE_POLICY,
          bypassCache: true,
          cacheWritePolicy: "skip",
          skipSpotFallback: true,
          deadlineMs: 3_000,
          callerClass: "scanner",
        },
      );
      pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(pending).rejects.toMatchObject({
        name: "CandleSourceUnavailableError",
        reason: "transport_unavailable",
        source: "direct_perp",
      });
    }

    expect(fetchSpy).toHaveBeenCalledTimes(8);
    expect(fetchSpy.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual([
      "openapi.okx.com", "api.gateio.ws", "www.okx.com", "fx-api.gateio.ws",
      "openapi.okx.com", "api.gateio.ws", "www.okx.com", "fx-api.gateio.ws",
    ]);
  });

  it("keeps source-unavailable typing scanner-only for existing AI-context consumers", async () => {
    fetchSpy.mockRejectedValue(new Error("network unavailable"));
    const now = Date.now();
    const pending = fetchOHLCV(
      "CONTEXT/USDT", "15m", now - TF_MS, now, undefined,
      {
        basisPolicy: AI_CONTEXT_CANDLE_POLICY,
        bypassCache: true,
        cacheWritePolicy: "skip",
        skipSpotFallback: true,
        deadlineMs: 3_000,
        callerClass: "ai_context",
      },
    );
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(4_000);

    await expect(pending).rejects.toMatchObject({
      name: "CandleBasisUnavailableError",
      reason: "no_acceptable_source",
    });
  });

  it("fails over from OKX primary to Gate USDT futures with exact direct provenance", async () => {
    const now = Date.now();
    fetchSpy.mockImplementation(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.hostname === "openapi.okx.com") throw new Error("OKX egress unavailable");
      expect(url.hostname).toBe("api.gateio.ws");
      expect(url.pathname).toBe("/api/v4/futures/usdt/candlesticks");
      expect(url.searchParams.get("contract")).toBe("SOL_USDT");
      expect(url.searchParams.get("interval")).toBe("15m");
      expect(url.searchParams.has("from")).toBe(true);
      expect(url.searchParams.has("to")).toBe(true);
      expect(url.searchParams.has("limit")).toBe(false);
      return {
        status: 200,
        ok: true,
        json: async () => [{
          t: String((now - TF_MS) / 1000), o: "10", h: "11", l: "9", c: "10.5", v: "7",
        }],
      };
    });

    const candles = await fetchOHLCV(
      "SOL/USDT", "15m", now - 2 * TF_MS, now, undefined,
      {
        basisPolicy: MONEY_CANDLE_POLICY,
        bypassCache: true,
        cacheWritePolicy: "skip",
        deadlineMs: 45_000,
        callerClass: "scanner",
      },
    );

    expect(fetchSpy.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual([
      "openapi.okx.com", "api.gateio.ws",
    ]);
    expect(candles).toEqual([
      expect.objectContaining({
        time: now - TF_MS,
        close: 10.5,
        volume: 7,
        provenance: {
          source: "gate",
          venue: "gate",
          basis: "perp",
          proxy: "direct",
          finality: "finalized",
          timeSemantic: "open_time",
        },
      }),
    ]);
  });

  it("discards a partial OKX result before selecting a provider-pure Gate result", async () => {
    const now = Date.now();
    let openapiCalls = 0;
    fetchSpy.mockImplementation(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.hostname === "openapi.okx.com") {
        openapiCalls++;
        if (openapiCalls === 1) {
          return {
            status: 200,
            ok: true,
            json: async () => ({
              code: "0",
              data: [[String(now - TF_MS), "100", "101", "99", "100.5", "8", "0", "0", "1"]],
            }),
          };
        }
        throw new Error("OKX second page failed");
      }
      expect(url.hostname).toBe("api.gateio.ws");
      return {
        status: 200,
        ok: true,
        json: async () => [{
          t: String((now - 2 * TF_MS) / 1000), o: "20", h: "21", l: "19", c: "20.5", v: "9",
        }],
      };
    });

    const candles = await fetchOHLCV(
      "SOL/USDT", "15m", now - 3 * TF_MS, now, undefined,
      {
        basisPolicy: MONEY_CANDLE_POLICY,
        bypassCache: true,
        cacheWritePolicy: "skip",
        deadlineMs: 45_000,
        callerClass: "scanner",
      },
    );

    expect(openapiCalls).toBe(2);
    expect(candles).toHaveLength(1);
    expect(candles[0]).toMatchObject({
      close: 20.5,
      provenance: { source: "gate", venue: "gate", basis: "perp" },
    });
    expect(new Set(candles.map((candle) => candle.provenance.source))).toEqual(new Set(["gate"]));
  });

  it("rejects malformed and forming Gate rows while retaining a finalized direct row", async () => {
    const now = Date.now();
    fetchSpy.mockImplementation(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.hostname.endsWith("okx.com")) throw new Error("OKX unavailable");
      return {
        status: 200,
        ok: true,
        json: async () => [
          { t: String((now - 2 * TF_MS) / 1000), o: "10", h: "11", l: "9", c: "10.5", v: "not-finite" },
          { t: String(now / 1000), o: "12", h: "13", l: "11", c: "12.5", v: "1" },
          { t: String((now - 3 * TF_MS) / 1000), o: "NaN", h: "11", l: "9", c: "10", v: "1" },
          ["array rows belong to Gate spot, not futures"],
        ],
      };
    });

    const candles = await fetchOHLCV(
      "SOL/USDT", "15m", now - 4 * TF_MS, now, undefined,
      {
        basisPolicy: MONEY_CANDLE_POLICY,
        bypassCache: true,
        cacheWritePolicy: "skip",
        deadlineMs: 45_000,
        callerClass: "scanner",
      },
    );

    expect(candles).toHaveLength(1);
    expect(candles[0]).toMatchObject({
      time: now - 2 * TF_MS,
      volume: 0,
      provenance: { source: "gate", finality: "finalized", proxy: "direct" },
    });
  });

  it("preserves multiplier identity so a different Gate contract cannot become direct", async () => {
    const now = Date.now();
    fetchSpy.mockImplementation(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.hostname.endsWith("okx.com")) throw new Error("OKX unavailable");
      expect(url.searchParams.get("contract")).toBe("1KPEPE_USDT");
      return {
        status: 200,
        ok: true,
        json: async () => [{
          t: String((now - TF_MS) / 1000), o: "1", h: "2", l: "0.5", c: "1.5", v: "1",
        }],
      };
    });

    await expect(fetchOHLCV(
      "1KPEPE/USDT", "15m", now - 2 * TF_MS, now, undefined,
      {
        basisPolicy: MONEY_CANDLE_POLICY,
        bypassCache: true,
        cacheWritePolicy: "skip",
        deadlineMs: 45_000,
        callerClass: "scanner",
      },
    )).rejects.toMatchObject({
      name: "CandleBasisUnavailableError",
      reason: "no_acceptable_source",
    });
    expect(fetchSpy.mock.calls.every(([url]) => !String(url).includes("/spot/"))).toBe(true);
  });

  it("retains authoritative 51001 instrument negative caching without retrying", async () => {
    fetchSpy.mockImplementation(async (input: unknown) => {
      const hostname = new URL(String(input)).hostname;
      if (hostname.endsWith("okx.com")) {
        return {
          status: 200,
          ok: true,
          json: async () => ({ code: "51001", msg: "Instrument ID doesn't exist", data: [] }),
          text: async () => "",
        };
      }
      return {
        status: 404,
        ok: false,
        json: async () => ({}),
        text: async () => JSON.stringify({ label: "CONTRACT_NOT_FOUND" }),
      };
    });
    const now = Date.now();
    const options = {
      basisPolicy: MONEY_CANDLE_POLICY,
      bypassCache: true,
      cacheWritePolicy: "skip" as const,
      skipSpotFallback: true,
      deadlineMs: 3_000,
      callerClass: "scanner" as const,
    };

    await expect(fetchOHLCV(
      "MISSING/USDT", "15m", now - TF_MS, now, undefined, options,
    )).rejects.toMatchObject({ name: "CandleBasisUnavailableError" });
    await expect(fetchOHLCV(
      "MISSING/USDT", "15m", now - TF_MS, now, undefined, options,
    )).rejects.toMatchObject({ name: "CandleBasisUnavailableError" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual([
      "openapi.okx.com", "api.gateio.ws",
    ]);
  });

  it("records successful OKX body timing once and lets a throwing observer fail open", async () => {
    setOkxDatafeedDiagnosticReporter((record) => {
      okxDiagnostics.push(record);
      throw new Error("observer failure must not alter the fetch");
    });
    const now = Date.now();
    fetchSpy.mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        code: "0",
        data: [[String(now - TF_MS), "1", "2", "0.5", "1.5", "10", "10", "10", "1"]],
      }),
    });

    const result = await fetchOHLCV(
      "SOL/USDT", "15m", now - TF_MS, now, undefined,
      {
        basisPolicy: MONEY_CANDLE_POLICY,
        bypassCache: true,
        cacheWritePolicy: "skip",
        deadlineMs: 45_000,
        callerClass: "scanner",
      },
    );

    expect(result).toHaveLength(1);
    expect(okxDiagnostics).toEqual([
      expect.objectContaining({
        kind: "okx_request_terminal",
        attempt: 1,
        phase: "body",
        settlement: "success",
        elapsedToHeadersMs: 0,
        bodyStartElapsedMs: 0,
        bodyEndElapsedMs: 0,
        controllerAbortElapsedMs: null,
        externalAbortElapsedMs: null,
        hardTerminalElapsedMs: null,
        settledElapsedMs: 0,
      }),
    ]);
  });

  it("removes the caller relay after successful body consumption", async () => {
    const caller = new AbortController();
    let internalSignal: AbortSignal | undefined;
    const now = Date.now();
    const candleTime = now - TF_MS;
    fetchSpy.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      internalSignal = init?.signal ?? undefined;
      return {
        status: 200,
        ok: true,
        json: async () => ({
          code: "0",
          data: [[String(candleTime), "100", "101", "99", "100.5", "10", "0", "0", "1"]],
        }),
      };
    });

    await expect(fetchOHLCV(
      "SOL/USDT", "15m", candleTime, now, undefined,
      {
        basisPolicy: MONEY_CANDLE_POLICY,
        bypassCache: true,
        cacheWritePolicy: "skip",
        deadlineMs: 45_000,
        signal: caller.signal,
      },
    )).resolves.toHaveLength(1);
    expect(internalSignal?.aborted).toBe(false);

    caller.abort("late-owner-abort");
    await Promise.resolve();
    expect(internalSignal?.aborted).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

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

describe("fetchOHLCV cache write policy", () => {
  async function runDirectFetch(cacheWritePolicy?: "background" | "skip") {
    const now = Date.now();
    const start = now - TF_MS;
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        code: "0",
        data: [[String(start), "10", "11", "9", "10", "1", "1", "1", "1"]],
      }),
      text: async () => "",
    });
    return fetchOHLCV(
      "SOL/USDT",
      "15m",
      new Date(start).toISOString(),
      new Date(now).toISOString(),
      undefined,
      {
        basisPolicy: MONEY_CANDLE_POLICY,
        bypassCache: true,
        cacheWritePolicy,
        deadlineMs: 20_000,
        callerClass: "scanner",
      },
    );
  }

  it("returns admitted provider candles without persistence when writes are suppressed", async () => {
    const candles = await runDirectFetch("skip");
    expect(candles).toHaveLength(1);
    expect(candles[0].provenance).toMatchObject({
      source: "okx",
      venue: "okx",
      basis: "perp",
      proxy: "direct",
      finality: "finalized",
    });
    expect(mockGetCached).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("retains background persistence by default for the same direct provider result", async () => {
    const candles = await runDirectFetch();
    expect(candles).toHaveLength(1);
    expect(mockGetCached).not.toHaveBeenCalled();
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSave).toHaveBeenCalledWith("SOL/USDT", "15m", candles);
  });
});

describe("prefetchCachedOHLCV batch hits", () => {
  function cachedBars(now: number, provenance = {
    source: "okx", venue: "okx", basis: "perp", proxy: "direct",
    finality: "finalized", timeSemantic: "open_time",
  }) {
    return Array.from({ length: 101 }, (_, index) => ({
      time: now - (101 - index) * TF_MS,
      open: 10, high: 11, low: 9, close: 10, volume: 1, provenance,
    }));
  }

  it("passes the exact 5-second SELECT timeout and admits a fresh policy-equivalent hit", async () => {
    const now = Date.now();
    const batchDeadlineAtMs = now + 42_000;
    mockGetCachedBatch.mockResolvedValue(new Map([
      ["SOL/USDT", cachedBars(now)],
      ["MISS/USDT", null],
    ]));

    const result = await prefetchCachedOHLCV(
      ["SOL/USDT", "MISS/USDT"], "15m", now - 100 * TF_MS, now,
      { basisPolicy: MONEY_CANDLE_POLICY, callerClass: "scanner", batchDeadlineAtMs },
    );

    expect([...result.complete.keys()]).toEqual(["SOL/USDT"]);
    expect([...result.prefixes.keys()]).toEqual([]);
    expect([...result.exactMisses]).toEqual(["MISS/USDT"]);
    expect([...result.unresolvedSymbols]).toEqual([]);
    expect(result.partialTermination).toBeNull();
    expect(mockGetCachedBatch).toHaveBeenCalledWith(
      ["SOL/USDT", "MISS/USDT"], "15m", now - 100 * TF_MS, now,
      expect.objectContaining({
        queryTimeoutMs: SCANNER_BATCH_CACHE_QUERY_TIMEOUT_MS,
        batchDeadlineAtMs,
        callerClass: "scanner",
      }),
    );
    expect(SCANNER_BATCH_CACHE_QUERY_TIMEOUT_MS).toBe(5_000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("retains completed batch groups while keeping unresolved symbols distinct from exact misses", async () => {
    const now = Date.now();
    mockGetCachedBatch.mockRejectedValue(Object.assign(
      new Error("partial batch"),
      {
        name: "CandleBatchPartialReadError",
        code: "candle_batch_partial_read",
        completed: new Map([
          ["SOL/USDT", cachedBars(now)],
          ["MISS/USDT", null],
        ]),
        unresolvedSymbols: new Set(["BTC/USDT"]),
        termination: "batch_deadline_exhausted",
      },
    ));

    const result = await prefetchCachedOHLCV(
      ["SOL/USDT", "MISS/USDT", "BTC/USDT"], "15m", now - 100 * TF_MS, now,
      { basisPolicy: MONEY_CANDLE_POLICY, callerClass: "scanner" },
    );

    expect([...result.complete.keys()]).toEqual(["SOL/USDT"]);
    expect([...result.exactMisses]).toEqual(["MISS/USDT"]);
    expect([...result.unresolvedSymbols]).toEqual(["BTC/USDT"]);
    expect(result.partialTermination).toBe("batch_deadline_exhausted");
  });

  it("partitions policy-ineligible groups as misses and a natural-boundary stale group as a reusable prefix", async () => {
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

    const result = await prefetchCachedOHLCV(
      ["SPOT/USDT", "STALE/USDT"], "15m", now - 100 * TF_MS, now,
      { basisPolicy: MONEY_CANDLE_POLICY },
    );
    expect([...result.complete.keys()]).toEqual([]);
    expect([...result.prefixes.keys()]).toEqual(["STALE/USDT"]);
    expect([...result.exactMisses]).toEqual(["SPOT/USDT"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps a fresh-tail range with interior gaps on the exact-fetch path", async () => {
    const now = Date.now();
    const underCovered = cachedBars(now).filter((_candle, index) =>
      index < 10 || index > 30,
    );
    expect(underCovered).toHaveLength(80);
    expect(underCovered.at(-1)?.time).toBe(now - TF_MS);
    mockGetCachedBatch.mockResolvedValue(new Map([
      ["GAPPED/USDT", underCovered],
    ]));

    const result = await prefetchCachedOHLCV(
      ["GAPPED/USDT"], "15m", now - 100 * TF_MS, now,
      { basisPolicy: MONEY_CANDLE_POLICY, callerClass: "scanner" },
    );

    expect([...result.complete.keys()]).toEqual([]);
    expect([...result.prefixes.keys()]).toEqual([]);
    expect([...result.exactMisses]).toEqual(["GAPPED/USDT"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("completes a measured 8-bar stale tail without a second cache read and revalidates the full range", async () => {
    const now = Date.now();
    const startMs = now - 101 * TF_MS;
    const prefix = cachedBars(now).filter((candle) => candle.time <= now - 8 * TF_MS);
    const responseRows = Array.from({ length: 8 }, (_, index) => {
      const time = now - (8 - index) * TF_MS;
      return [String(time), "10", "11", "9", "10", "1", "1", "1", "1"];
    }).reverse();
    fetchSpy.mockImplementation(async (input: unknown) => {
      expect(String(input)).toContain("okx.com");
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: "0", data: responseRows }),
        text: async () => "",
      };
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const completed = await completeCachedOHLCVTail(
      "SOL/USDT",
      "15m",
      startMs,
      now,
      prefix,
      undefined,
      {
        basisPolicy: MONEY_CANDLE_POLICY,
        deadlineMs: 20_000,
        callerClass: "scanner",
      },
    );

    expect(prefix).toHaveLength(94);
    expect(completed).toHaveLength(101);
    expect(completed[0].time).toBe(startMs);
    expect(completed.at(-1)?.time).toBe(now - TF_MS);
    expect(mockGetCached).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(
      /^\[ScannerTailCompletion\] SOL\/USDT 15m outcome=complete .* duration=\d+ms$/,
    ));
    consoleSpy.mockRestore();
  });

  it("retains per-candle identity when an OKX cached prefix is completed by a Gate futures tail", async () => {
    const now = Math.floor(Date.now() / TF_MS) * TF_MS;
    const startMs = now - 101 * TF_MS;
    const prefix = cachedBars(now).filter((candle) => candle.time <= now - 8 * TF_MS);
    fetchSpy.mockImplementation(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.hostname.endsWith("okx.com")) throw new Error("OKX unavailable");
      return {
        ok: true,
        status: 200,
        json: async () => Array.from({ length: 8 }, (_, index) => {
          const time = now - (8 - index) * TF_MS;
          return { t: String(time / 1000), o: "10", h: "11", l: "9", c: "10", v: "1" };
        }),
        text: async () => "",
      };
    });

    const completed = await completeCachedOHLCVTail(
      "SOL/USDT",
      "15m",
      startMs,
      now,
      prefix,
      undefined,
      {
        basisPolicy: MONEY_CANDLE_POLICY,
        deadlineMs: 20_000,
        callerClass: "scanner",
        cacheWritePolicy: "skip",
      },
    );

    expect(completed).toHaveLength(101);
    expect(completed[0].provenance).toMatchObject({ source: "okx", venue: "okx" });
    expect(completed.at(-1)?.provenance).toMatchObject({ source: "gate", venue: "gate" });
    expect(new Set(completed.map((candle) => candle.provenance.source))).toEqual(new Set(["okx", "gate"]));
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("fails closed when tail completion observes forming candles only", async () => {
    const now = Date.now();
    const startMs = now - 101 * TF_MS;
    const prefix = cachedBars(now).filter((candle) => candle.time <= now - 8 * TF_MS);
    const responseRows = Array.from({ length: 8 }, (_, index) => {
      const time = now - (index + 1) * TF_MS;
      return [String(time), "10", "11", "9", "10", "1", "1", "1", "0"];
    });
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: "0", data: responseRows }),
      text: async () => "",
    });

    await expect(completeCachedOHLCVTail(
      "FORM/USDT",
      "15m",
      startMs,
      now,
      prefix,
      undefined,
      { basisPolicy: MONEY_CANDLE_POLICY, deadlineMs: 20_000, callerClass: "scanner" },
    )).rejects.toMatchObject({
      name: "CandleBasisUnavailableError",
      reason: "nonfinalized_only",
    });
    expect(mockGetCached).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("fails closed when tail completion observes malformed provenance", async () => {
    const now = Date.now();
    const startMs = now - 101 * TF_MS;
    const prefix = cachedBars(now).filter((candle) => candle.time <= now - 8 * TF_MS);
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        code: "0",
        data: [[String(now - 8 * TF_MS), "10", "11", "9", "10", "1", "1", "1", "unknown"]],
      }),
      text: async () => "",
    });

    await expect(completeCachedOHLCVTail(
      "MALFORM/USDT",
      "15m",
      startMs,
      now,
      prefix,
      undefined,
      { basisPolicy: MONEY_CANDLE_POLICY, deadlineMs: 20_000, callerClass: "scanner" },
    )).rejects.toMatchObject({
      name: "CandleBasisUnavailableError",
      reason: "malformed_provenance",
    });
    expect(mockGetCached).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("fails closed when the merged range remains stale and under-covered", async () => {
    const now = Date.now();
    const startMs = now - 101 * TF_MS;
    const prefix = cachedBars(now).filter((candle) => candle.time <= now - 8 * TF_MS);
    const responseRows = [7, 8].map((barsAgo) => [
      String(now - barsAgo * TF_MS), "10", "11", "9", "10", "1", "1", "1", "1",
    ]);
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: "0", data: responseRows }),
      text: async () => "",
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(completeCachedOHLCVTail(
      "STALE/USDT",
      "15m",
      startMs,
      now,
      prefix,
      undefined,
      { basisPolicy: MONEY_CANDLE_POLICY, deadlineMs: 20_000, callerClass: "scanner" },
    )).rejects.toMatchObject({
      name: "CandleTailCompletionError",
      reason: "merged_range_inadmissible",
    });
    expect(mockGetCached).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(
      /^\[ScannerTailCompletion\] STALE\/USDT 15m outcome=failed .* duration=\d+ms$/,
    ));
    consoleSpy.mockRestore();
  });

  it("retains the strongest finality deterministically at a tail overlap", () => {
    const [base] = cachedBars(Date.now());
    const forming = {
      ...base,
      close: 9,
      provenance: { ...base.provenance, finality: "forming" as const },
    };
    const finalized = {
      ...base,
      close: 11,
      provenance: { ...base.provenance, finality: "finalized" as const },
    };

    expect(mergeScannerCandleTail([forming], [finalized])).toMatchObject([
      { time: base.time, close: 11, provenance: { finality: "finalized" } },
    ]);
  });

  it("does not manufacture a JavaScript five-second deadline around the backend-bounded batch", async () => {
    let resolveBatch!: (value: Map<string, any[] | null>) => void;
    mockGetCachedBatch.mockImplementation(() => new Promise((resolve) => {
      resolveBatch = resolve;
    }));
    const now = Date.now();
    const pending = prefetchCachedOHLCV(
      ["SOL/USDT"], "15m", now - 100 * TF_MS, now,
      { basisPolicy: MONEY_CANDLE_POLICY },
    );
    let settled = false;
    pending.finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(5_100);
    expect(settled).toBe(false);
    expect(mockGetCachedBatch.mock.calls[0][4]).toMatchObject({
      queryTimeoutMs: SCANNER_BATCH_CACHE_QUERY_TIMEOUT_MS,
      signal: undefined,
    });
    resolveBatch(new Map([["SOL/USDT", cachedBars(now)]]));
    await expect(pending).resolves.toMatchObject({
      complete: new Map([["SOL/USDT", cachedBars(now)]]),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes the owning sweep signal through and cancels promptly without provider fallback", async () => {
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
    const controller = new AbortController();
    const pending = prefetchCachedOHLCV(
      ["SOL/USDT"], "15m", now - 100 * TF_MS, now,
      { basisPolicy: MONEY_CANDLE_POLICY, signal: controller.signal },
    );
    pending.catch(() => {});
    controller.abort("sweep-stopped");
    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "sweep-stopped" });
    expect(mockGetCachedBatch.mock.calls[0][4].signal).toBe(controller.signal);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
