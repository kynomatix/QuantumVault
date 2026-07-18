// Regression tests for the OKX SOURCE-level circuit breaker.
//
// Prod incident 2026-07-18 (part 2): the production deployment's egress IPs
// cannot reach OKX at all — even majors (SOL/BTC/ETH) failed with network
// timeouts of ~75-97s EACH. The per-instrument negcache (30-min TTL) only
// saves the second touch, so with ~90 scanner markets the first-touch cost
// alone kept exhausting the 240s sweep budget → "TIMEOUT: 58 markets skipped"
// on every sweep, forever.
//
// Invariants pinned here:
//   A. 3 consecutive instruments with OKX network failures trip the breaker:
//      the next symbol makes ZERO OKX calls and goes straight to Gate.
//   B. Permanent not-found (51001) proves the API is reachable — it must NOT
//      count toward (and must reset) the breaker streak.
//   C. Any successful OKX response resets the streak.
//   D. Half-open: after the cooldown, ONE probe is allowed; a single failed
//      probe re-trips immediately (no fresh 3-symbol penalty).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { mockGetCached, mockSave } = vi.hoisted(() => ({
  mockGetCached: vi.fn<(...args: any[]) => Promise<any[] | null>>(),
  mockSave: vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined),
}));

vi.mock("../../server/lab/candle-store", () => ({
  getCachedCandles: (...a: any[]) => mockGetCached(...a),
  saveCandlesToDb: (...a: any[]) => mockSave(...a),
}));

import { fetchOHLCV, __testResetOkxSourceBreaker } from "../../server/lab/datafeed";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TF_MS = 15 * 60 * 1000;

/** Gate spot candlestick rows covering [startMs, endMs): [ts_sec, vol, close, high, low, open]. */
function gateCandles(startMs: number, count: number): string[][] {
  const rows: string[][] = [];
  for (let i = 0; i < count; i++) {
    const tsSec = Math.floor((startMs + i * TF_MS) / 1000);
    rows.push([String(tsSec), "1000", "100", "101", "99", "100"]);
  }
  return rows;
}

type OkxMode = "network-down" | "not-found" | "ok";

/**
 * Fetch stub with a switchable OKX behaviour. Gate always serves candles;
 * Pyth reports unknown symbol (never reached when Gate succeeds).
 */
function makeFetch(getOkxMode: () => OkxMode, rangeStartMs: number) {
  return vi.fn().mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("okx.com")) {
      const mode = getOkxMode();
      if (mode === "network-down") {
        throw new TypeError("fetch failed: connect ETIMEDOUT");
      }
      if (mode === "not-found") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: "51001", msg: "Instrument ID doesn't exist." }),
          text: async () => "",
        };
      }
      // "ok": one page of OKX candles [ts_ms, o, h, l, c, vol], newest-first.
      const data: string[][] = [];
      for (let i = 99; i >= 0; i--) {
        data.push([String(rangeStartMs + i * TF_MS), "100", "101", "99", "100", "1000"]);
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: "0", data }),
        text: async () => "",
      };
    }
    if (u.includes("gateio.ws")) {
      return {
        ok: true,
        status: 200,
        json: async () => gateCandles(rangeStartMs, 50),
        text: async () => "",
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ s: "error", errmsg: "unknown symbol" }),
      text: async () => "",
    };
  });
}

function callsTo(fetchSpy: ReturnType<typeof vi.fn>, host: string): number {
  return fetchSpy.mock.calls.filter(([url]) => String(url).includes(host)).length;
}

/** Drive fetchOHLCV to completion under fake timers (retry sleeps are timers). */
async function runFetch(symbol: string): Promise<any[]> {
  const now = Date.now();
  const startMs = now - 100 * TF_MS;
  const p = fetchOHLCV(
    symbol,
    "15m",
    new Date(startMs).toISOString(),
    new Date(now).toISOString(),
  );
  // Let all retry/backoff sleeps elapse instantly.
  await vi.runAllTimersAsync();
  return p;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fetchOHLCV — OKX source-level circuit breaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __testResetOkxSourceBreaker();
    mockGetCached.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("A: trips after 3 consecutive network-failed symbols — 4th symbol makes ZERO OKX calls", async () => {
    const rangeStart = Date.now() - 100 * TF_MS;
    const fetchSpy = makeFetch(() => "network-down", rangeStart);
    vi.stubGlobal("fetch", fetchSpy);

    const r1 = await runFetch("BRKA1/USDT");
    const r2 = await runFetch("BRKA2/USDT");
    const r3 = await runFetch("BRKA3/USDT");
    // Fallback stays intact: Gate served candles for every symbol.
    expect(r1.length).toBeGreaterThan(0);
    expect(r2.length).toBeGreaterThan(0);
    expect(r3.length).toBeGreaterThan(0);
    const okxAfterTrip = callsTo(fetchSpy, "okx.com");
    expect(okxAfterTrip).toBeGreaterThan(0);

    const r4 = await runFetch("BRKA4/USDT");
    expect(r4.length).toBeGreaterThan(0);
    // Breaker OPEN: no new OKX traffic at all for a fresh symbol.
    expect(callsTo(fetchSpy, "okx.com")).toBe(okxAfterTrip);
  });

  it("B: not-found (51001) does not count toward the breaker", async () => {
    const rangeStart = Date.now() - 100 * TF_MS;
    let mode: OkxMode = "not-found";
    const fetchSpy = makeFetch(() => mode, rangeStart);
    vi.stubGlobal("fetch", fetchSpy);

    await runFetch("BRKB1/USDT");
    await runFetch("BRKB2/USDT");
    await runFetch("BRKB3/USDT");
    // Each not-found = exactly one OKX call, and the breaker stays CLOSED.
    expect(callsTo(fetchSpy, "okx.com")).toBe(3);

    mode = "ok";
    const r4 = await runFetch("BRKB4/USDT");
    // OKX was still attempted (breaker closed) and served candles.
    expect(callsTo(fetchSpy, "okx.com")).toBeGreaterThan(3);
    expect(r4.length).toBeGreaterThan(0);
  });

  it("C: a successful OKX response resets the failure streak", async () => {
    const rangeStart = Date.now() - 100 * TF_MS;
    let mode: OkxMode = "network-down";
    const fetchSpy = makeFetch(() => mode, rangeStart);
    vi.stubGlobal("fetch", fetchSpy);

    await runFetch("BRKC1/USDT"); // failure 1
    await runFetch("BRKC2/USDT"); // failure 2
    mode = "ok";
    await runFetch("BRKC3/USDT"); // success → streak resets
    mode = "network-down";
    await runFetch("BRKC4/USDT"); // failure 1 (fresh streak)
    await runFetch("BRKC5/USDT"); // failure 2
    const okxBefore = callsTo(fetchSpy, "okx.com");

    // Breaker must still be CLOSED (2 < 3): next symbol attempts OKX.
    await runFetch("BRKC6/USDT");
    expect(callsTo(fetchSpy, "okx.com")).toBeGreaterThan(okxBefore);
  });

  it("D: half-open after cooldown — one failed probe re-trips immediately", async () => {
    const rangeStart = Date.now() - 100 * TF_MS;
    const fetchSpy = makeFetch(() => "network-down", rangeStart);
    vi.stubGlobal("fetch", fetchSpy);

    await runFetch("BRKD1/USDT");
    await runFetch("BRKD2/USDT");
    await runFetch("BRKD3/USDT"); // trips
    const okxAtTrip = callsTo(fetchSpy, "okx.com");
    await runFetch("BRKD4/USDT"); // skipped
    expect(callsTo(fetchSpy, "okx.com")).toBe(okxAtTrip);

    // Past the cooldown: exactly one probe symbol gets through…
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    await runFetch("BRKD5/USDT"); // probe, fails
    const okxAfterProbe = callsTo(fetchSpy, "okx.com");
    expect(okxAfterProbe).toBeGreaterThan(okxAtTrip);

    // …and its single failure re-trips the breaker (no 3-symbol penalty).
    await runFetch("BRKD6/USDT");
    expect(callsTo(fetchSpy, "okx.com")).toBe(okxAfterProbe);
  });
});
