// WO-8f acceptance tests for server/ai-trader/hl-context.ts.
//
// Module-state isolation: hl-context.ts keeps two pieces of module-level
// state (the 5s whole-universe response cache and the per-market rolling
// history Map). Every test that cares about a clean slate calls
// vi.resetModules() + a fresh `await import(...)`, mirroring the existing
// convention in tests/ai-trader/monitor.test.ts and
// tests/ai-trader/failure-drills.test.ts. Tests that deliberately exercise
// cross-call state (the cache window, the rolling history) do so within a
// single import, calling the exported functions more than once — that is
// the intended per-process behavior, not a leak.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface RawAssetCtxFixture {
  funding: string;
  openInterest: string;
  dayNtlVlm: string;
  premium: string;
  oraclePx: string;
  markPx: string;
}

function makeUniverseResponse(coins: Record<string, Partial<RawAssetCtxFixture>>): unknown {
  const names = Object.keys(coins);
  return [
    { universe: names.map((name) => ({ name })) },
    names.map((name) => coins[name]),
  ];
}

const SOL_CTX: RawAssetCtxFixture = {
  funding: "0.0000125",
  openInterest: "5364594.64",
  dayNtlVlm: "196439874.67",
  premium: "-0.000384",
  oraclePx: "78.115",
  markPx: "78.085",
};

function jsonResponse(body: unknown, ok = true): { ok: boolean; json: () => Promise<unknown> } {
  return { ok, json: () => Promise.resolve(body) };
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(jsonResponse(makeUniverseResponse({ SOL: SOL_CTX })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("mapToHlSymbol", () => {
  it("maps every documented direct symbol 1:1", async () => {
    const { mapToHlSymbol } = await import("../../server/ai-trader/hl-context");
    expect(mapToHlSymbol("SOL-PERP")).toBe("SOL");
    expect(mapToHlSymbol("BTC-PERP")).toBe("BTC");
    expect(mapToHlSymbol("ETH-PERP")).toBe("ETH");
    expect(mapToHlSymbol("SUI-PERP")).toBe("SUI");
    expect(mapToHlSymbol("APT-PERP")).toBe("APT");
    expect(mapToHlSymbol("ARB-PERP")).toBe("ARB");
    expect(mapToHlSymbol("DOGE-PERP")).toBe("DOGE");
    expect(mapToHlSymbol("WIF-PERP")).toBe("WIF");
    expect(mapToHlSymbol("JUP-PERP")).toBe("JUP");
    expect(mapToHlSymbol("RENDER-PERP")).toBe("RENDER");
  });

  it("maps BONK/PEPE to Hyperliquid's k-prefixed 1000x tickers, not the bare symbol", async () => {
    const { mapToHlSymbol } = await import("../../server/ai-trader/hl-context");
    expect(mapToHlSymbol("BONK-PERP")).toBe("kBONK");
    expect(mapToHlSymbol("PEPE-PERP")).toBe("kPEPE");
  });

  it("returns null for a symbol outside the documented table", async () => {
    const { mapToHlSymbol } = await import("../../server/ai-trader/hl-context");
    expect(mapToHlSymbol("SOME-EXOTIC-PERP")).toBeNull();
  });
});

describe("fetchHlSnapshot", () => {
  it("known symbol: parses every numeric field from the string-encoded API response", async () => {
    const { fetchHlSnapshot } = await import("../../server/ai-trader/hl-context");
    const result = await fetchHlSnapshot("SOL-PERP");
    expect(result).toEqual({
      openInterest: 5364594.64,
      volume24h: 196439874.67,
      fundingRate: 0.0000125,
      markPrice: 78.085,
      oraclePrice: 78.115,
      premium: -0.000384,
    });
  });

  it("BONK-PERP resolves via the kBONK universe entry", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        makeUniverseResponse({
          kBONK: { funding: "0.00001", openInterest: "1000", dayNtlVlm: "2000", premium: "0.0001", oraclePx: "0.00002", markPx: "0.00002" },
        })
      )
    );
    const { fetchHlSnapshot } = await import("../../server/ai-trader/hl-context");
    const result = await fetchHlSnapshot("BONK-PERP");
    expect(result).not.toBeNull();
    expect(result?.openInterest).toBe(1000);
  });

  it("unknown symbol resolves to null without making any network call", async () => {
    const { fetchHlSnapshot } = await import("../../server/ai-trader/hl-context");
    const result = await fetchHlSnapshot("SOME-EXOTIC-PERP");
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("HTTP error response (ok: false) resolves to null", async () => {
    fetchMock.mockResolvedValue(jsonResponse(makeUniverseResponse({ SOL: SOL_CTX }), false));
    const { fetchHlSnapshot } = await import("../../server/ai-trader/hl-context");
    const result = await fetchHlSnapshot("SOL-PERP");
    expect(result).toBeNull();
  });

  it("network error (fetch rejects) resolves to null, never throws", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const { fetchHlSnapshot } = await import("../../server/ai-trader/hl-context");
    await expect(fetchHlSnapshot("SOL-PERP")).resolves.toBeNull();
  });

  it("timeout (fetch rejects with an AbortError, as AbortSignal.timeout produces) resolves to null", async () => {
    fetchMock.mockRejectedValue(new DOMException("The operation was aborted.", "TimeoutError"));
    const { fetchHlSnapshot } = await import("../../server/ai-trader/hl-context");
    await expect(fetchHlSnapshot("SOL-PERP")).resolves.toBeNull();
  });

  it("passes an AbortSignal to fetch so a hung request cannot block the decision cycle indefinitely", async () => {
    const { fetchHlSnapshot } = await import("../../server/ai-trader/hl-context");
    await fetchHlSnapshot("SOL-PERP");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("malformed response shape (not a 2-element array) resolves to null", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ not: "an array" }));
    const { fetchHlSnapshot } = await import("../../server/ai-trader/hl-context");
    await expect(fetchHlSnapshot("SOL-PERP")).resolves.toBeNull();
  });

  it("missing universe/ctxs arrays inside an otherwise 2-element response resolves to null", async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ notUniverse: true }, "not-an-array"]));
    const { fetchHlSnapshot } = await import("../../server/ai-trader/hl-context");
    await expect(fetchHlSnapshot("SOL-PERP")).resolves.toBeNull();
  });

  it("res.json() throwing (bad JSON body) resolves to null", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.reject(new Error("bad json")) });
    const { fetchHlSnapshot } = await import("../../server/ai-trader/hl-context");
    await expect(fetchHlSnapshot("SOL-PERP")).resolves.toBeNull();
  });

  it("a non-finite numeric field (e.g. \"NaN\" string) resolves to null", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(makeUniverseResponse({ SOL: { ...SOL_CTX, openInterest: "NaN" } }))
    );
    const { fetchHlSnapshot } = await import("../../server/ai-trader/hl-context");
    await expect(fetchHlSnapshot("SOL-PERP")).resolves.toBeNull();
  });

  it("a missing numeric field resolves to null", async () => {
    const partial = { ...SOL_CTX } as Partial<RawAssetCtxFixture>;
    delete partial.markPx;
    fetchMock.mockResolvedValue(jsonResponse(makeUniverseResponse({ SOL: partial })));
    const { fetchHlSnapshot } = await import("../../server/ai-trader/hl-context");
    await expect(fetchHlSnapshot("SOL-PERP")).resolves.toBeNull();
  });

  it("an asset present in the symbol table but absent from the live universe resolves to null", async () => {
    fetchMock.mockResolvedValue(jsonResponse(makeUniverseResponse({ BTC: SOL_CTX })));
    const { fetchHlSnapshot } = await import("../../server/ai-trader/hl-context");
    await expect(fetchHlSnapshot("SOL-PERP")).resolves.toBeNull();
  });

  it("caches the whole-universe response for 5s: two calls (same or different market) within the window make one fetch", async () => {
    fetchMock.mockResolvedValue(jsonResponse(makeUniverseResponse({ SOL: SOL_CTX, BTC: { ...SOL_CTX, openInterest: "999" } })));
    const { fetchHlSnapshot } = await import("../../server/ai-trader/hl-context");
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const first = await fetchHlSnapshot("SOL-PERP");
    vi.setSystemTime(2_000);
    const second = await fetchHlSnapshot("BTC-PERP");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first?.openInterest).toBe(5364594.64);
    expect(second?.openInterest).toBe(999);
  });

  it("re-fetches once the 5s cache window has elapsed", async () => {
    const { fetchHlSnapshot } = await import("../../server/ai-trader/hl-context");
    vi.useFakeTimers();
    vi.setSystemTime(0);
    await fetchHlSnapshot("SOL-PERP");
    vi.setSystemTime(5_001);
    await fetchHlSnapshot("SOL-PERP");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("concurrent calls within the same cycle dedupe onto one in-flight request", async () => {
    let resolveFetch!: (v: unknown) => void;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );
    const { fetchHlSnapshot } = await import("../../server/ai-trader/hl-context");
    const p1 = fetchHlSnapshot("SOL-PERP");
    const p2 = fetchHlSnapshot("SOL-PERP");
    resolveFetch(jsonResponse(makeUniverseResponse({ SOL: SOL_CTX })));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(r2);
  });
});

function pctChange(from: number, to: number): number | null {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return ((to - from) / Math.abs(from)) * 100;
}

/**
 * Mirrors getHlParticipationSnapshot's exact delta-window algorithm (as
 * documented in hl-context.ts) against a plain-JS array, independently of
 * the module under test, so the window/eviction assertions below are not
 * hand-derived magic numbers.
 */
function simulateOiDeltas(readings: number[], windowSize: number) {
  let history: number[] = [];
  return readings.map((oi) => {
    const previous = history.length > 0 ? history[history.length - 1] : null;
    const oldestInWindow = history.length > 0 ? history[0] : null;
    history = [...history, oi].slice(-windowSize);
    return {
      deltaPct: previous !== null ? pctChange(previous, oi) : null,
      deltaPctWindow: oldestInWindow !== null ? pctChange(oldestInWindow, oi) : null,
    };
  });
}

function ctxWithOi(oi: number, volume: number, funding: number): RawAssetCtxFixture {
  return {
    funding: String(funding),
    openInterest: String(oi),
    dayNtlVlm: String(volume),
    premium: "0",
    oraclePx: "1",
    markPx: "1",
  };
}

describe("getHlParticipationSnapshot", () => {
  it("first reading for a market: deltas are null and volume trend is 'unknown'", async () => {
    const { getHlParticipationSnapshot } = await import("../../server/ai-trader/hl-context");
    const result = await getHlParticipationSnapshot("SOL-PERP");
    expect(result?.openInterestDeltaPct).toBeNull();
    expect(result?.openInterestDeltaPctWindow).toBeNull();
    expect(result?.volumeTrend).toBe("unknown");
    expect(result?.fundingTrajectory).toEqual([0.0000125]);
    expect(result?.hlSymbol).toBe("SOL");
  });

  it("second reading: open interest delta is computed vs. the first, and a >2% volume rise reports 'rising'", async () => {
    const { getHlParticipationSnapshot } = await import("../../server/ai-trader/hl-context");
    vi.useFakeTimers();
    vi.setSystemTime(0);
    fetchMock.mockResolvedValue(jsonResponse(makeUniverseResponse({ SOL: ctxWithOi(1000, 100_000, 0.00001) })));
    await getHlParticipationSnapshot("SOL-PERP");
    // Advance past the 5s whole-universe response cache so the second call
    // actually re-fetches (otherwise it would silently reuse the first body).
    vi.setSystemTime(6_000);
    fetchMock.mockResolvedValue(jsonResponse(makeUniverseResponse({ SOL: ctxWithOi(1100, 150_000, 0.00002) })));
    const second = await getHlParticipationSnapshot("SOL-PERP");
    expect(second?.openInterestDeltaPct).toBeCloseTo(10, 5);
    expect(second?.openInterestDeltaPctWindow).toBeCloseTo(10, 5);
    expect(second?.volumeTrend).toBe("rising");
    expect(second?.fundingTrajectory).toEqual([0.00001, 0.00002]);
  });

  it("a >2% volume drop reports 'falling'; a move within +-2% reports 'flat'", async () => {
    const { getHlParticipationSnapshot } = await import("../../server/ai-trader/hl-context");
    vi.useFakeTimers();
    vi.setSystemTime(0);
    fetchMock.mockResolvedValue(jsonResponse(makeUniverseResponse({ SOL: ctxWithOi(1000, 100_000, 0.00001) })));
    await getHlParticipationSnapshot("SOL-PERP");
    vi.setSystemTime(6_000);
    fetchMock.mockResolvedValue(jsonResponse(makeUniverseResponse({ SOL: ctxWithOi(1000, 80_000, 0.00001) })));
    const falling = await getHlParticipationSnapshot("SOL-PERP");
    expect(falling?.volumeTrend).toBe("falling");

    vi.setSystemTime(12_000);
    fetchMock.mockResolvedValue(jsonResponse(makeUniverseResponse({ BTC: ctxWithOi(1000, 100_000, 0.00001) })));
    await getHlParticipationSnapshot("BTC-PERP");
    vi.setSystemTime(18_000);
    fetchMock.mockResolvedValue(jsonResponse(makeUniverseResponse({ BTC: ctxWithOi(1000, 100_500, 0.00001) })));
    const flat = await getHlParticipationSnapshot("BTC-PERP");
    expect(flat?.volumeTrend).toBe("flat");
  });

  it("window delta/eviction over 13 readings matches an independent parallel-array simulation of the same algorithm", async () => {
    const { getHlParticipationSnapshot, HL_HISTORY_WINDOW } = await import("../../server/ai-trader/hl-context");
    expect(HL_HISTORY_WINDOW).toBe(12);
    const oiReadings = Array.from({ length: 13 }, (_, i) => 1000 + i * 100);
    const expected = simulateOiDeltas(oiReadings, HL_HISTORY_WINDOW);

    vi.useFakeTimers();
    vi.setSystemTime(0);
    const actual: { deltaPct: number | null; deltaPctWindow: number | null }[] = [];
    for (let i = 0; i < oiReadings.length; i++) {
      // Each iteration jumps the clock past the 5s whole-universe cache
      // window so every reading is a genuine fresh fetch, not a cache hit.
      vi.setSystemTime(i * 6_000);
      fetchMock.mockResolvedValue(jsonResponse(makeUniverseResponse({ SOL: ctxWithOi(oiReadings[i], 100_000, 0.00001) })));
      const snap = await getHlParticipationSnapshot("SOL-PERP");
      actual.push({ deltaPct: snap?.openInterestDeltaPct ?? null, deltaPctWindow: snap?.openInterestDeltaPctWindow ?? null });
    }

    for (let i = 0; i < expected.length; i++) {
      expect(actual[i].deltaPct).toEqual(expected[i].deltaPct);
      expect(actual[i].deltaPctWindow).toEqual(expected[i].deltaPctWindow);
    }
    // 13th (final) reading's window delta must be measured against the 1st
    // reading, since the 12-entry window holding readings 1-12 was the state
    // BEFORE the 13th reading was recorded (then evicted down to 2-13).
    expect(actual[12].deltaPctWindow).toEqual(pctChange(oiReadings[0], oiReadings[12]));
  });

  it("funding trajectory keeps only the last 3 readings, oldest first, across more than 3 cycles", async () => {
    const { getHlParticipationSnapshot } = await import("../../server/ai-trader/hl-context");
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fundings = [0.00001, 0.00002, 0.00003, 0.00004, 0.00005];
    let last;
    for (let i = 0; i < fundings.length; i++) {
      vi.setSystemTime(i * 6_000);
      fetchMock.mockResolvedValue(jsonResponse(makeUniverseResponse({ SOL: ctxWithOi(1000, 100_000, fundings[i]) })));
      last = await getHlParticipationSnapshot("SOL-PERP");
    }
    expect(last?.fundingTrajectory).toEqual([0.00003, 0.00004, 0.00005]);
  });

  it("an unknown symbol never touches the network or the history map, and does not disturb a known symbol's series", async () => {
    const { getHlParticipationSnapshot } = await import("../../server/ai-trader/hl-context");
    const unknown = await getHlParticipationSnapshot("SOME-EXOTIC-PERP");
    expect(unknown).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    const first = await getHlParticipationSnapshot("SOL-PERP");
    expect(first?.openInterestDeltaPct).toBeNull(); // still a genuine first reading, unaffected by the unknown-symbol call
  });

  it("a null underlying fetchHlSnapshot (e.g. network failure) resolves the whole participation snapshot to null", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const { getHlParticipationSnapshot } = await import("../../server/ai-trader/hl-context");
    await expect(getHlParticipationSnapshot("SOL-PERP")).resolves.toBeNull();
  });
});
