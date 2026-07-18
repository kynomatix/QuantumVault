// Regression tests for permanent "not found" classification in the datafeed.
//
// Prod incident 2026-07-18: markets not listed on a candle source (XMR, ORE…)
// returned PERMANENT not-found errors that were treated as transient:
//   1. OKX "Instrument doesn't exist" (code 51001) was retried 3× inner +
//      5× outer with escalating sleeps ≈ 30-45s per missing market.
//   2. Gate's bare INVALID_CURRENCY label (e.g. XMR) was never matched by the
//      not-found detector (only INVALID_CURRENCY_PAIR), so it was retried
//      forever and NEVER negative-cached — ~40s burned every sweep.
//   3. Even a detected GatePairNotFoundError was retried 3× with backoff by
//      the inner catch before propagating.
// Result: the scanner's 240s sweep fetch budget evaporated on dead markets →
// "[Scanner] TIMEOUT: 61 markets skipped" → system-wide starvation.
//
// Invariants pinned here:
//   A. OKX 51001 → exactly ONE OKX call (no retries), then fall through.
//   B. Gate INVALID_CURRENCY (bare) → exactly ONE Gate call (no retries).
//   C. Both sources are negative-cached: a second fetch for the same symbol
//      makes ZERO additional OKX/Gate calls.

import { describe, it, expect, afterEach, vi } from "vitest";

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

/**
 * Fetch stub where every source reports the symbol as permanently missing:
 *  - OKX    → HTTP 200, body { code: "51001", msg: "...doesn't exist." }
 *  - Gate   → HTTP 400, bare INVALID_CURRENCY label (the XMR variant)
 *  - Pyth   → HTTP 200, { s: "error" } (invalid symbol)
 */
function makeNotFoundFetch() {
  return vi.fn().mockImplementation(async (url: string) => {
    if (url.includes("okx.com")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: "51001",
          msg: "Instrument ID, Instrument ID code, or Spread ID doesn't exist.",
        }),
        text: async () => "",
      };
    }
    if (url.includes("gateio.ws")) {
      return {
        ok: false,
        status: 400,
        json: async () => ({}),
        text: async () => JSON.stringify({ label: "INVALID_CURRENCY", message: "Invalid currency XMR" }),
      };
    }
    // Pyth Benchmarks shim
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

async function runFetch(symbol: string) {
  const now = Date.now();
  const startMs = now - 100 * 15 * 60 * 1000;
  return fetchOHLCV(
    symbol,
    "15m",
    new Date(startMs).toISOString(),
    new Date(now).toISOString(),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fetchOHLCV — permanent not-found is non-retryable + negcached", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("OKX 51001 and Gate INVALID_CURRENCY each get exactly one call — no retry storm", async () => {
    mockGetCached.mockResolvedValue(null);
    const fetchSpy = makeNotFoundFetch();
    vi.stubGlobal("fetch", fetchSpy);

    const started = Date.now();
    const result = await runFetch("XMRTEST/USDT");
    const elapsed = Date.now() - started;

    expect(result).toEqual([]);
    // One shot per source: the old code made 15 OKX calls (3 retries × 5
    // pages) and 15 Gate calls for a missing market.
    expect(callsTo(fetchSpy, "okx.com")).toBe(1);
    expect(callsTo(fetchSpy, "gateio.ws")).toBe(1);
    // No backoff sleeps: the old path burned 30-45s here.
    expect(elapsed).toBeLessThan(5_000);
  });

  it("second fetch for the same symbol is fully negative-cached (zero OKX/Gate calls)", async () => {
    mockGetCached.mockResolvedValue(null);
    const fetchSpy = makeNotFoundFetch();
    vi.stubGlobal("fetch", fetchSpy);

    await runFetch("ORETEST/USDT");
    const okxAfterFirst = callsTo(fetchSpy, "okx.com");
    const gateAfterFirst = callsTo(fetchSpy, "gateio.ws");
    expect(okxAfterFirst).toBe(1);
    expect(gateAfterFirst).toBe(1);

    const result = await runFetch("ORETEST/USDT");
    expect(result).toEqual([]);
    // Negcaches hold: no new calls to either source.
    expect(callsTo(fetchSpy, "okx.com")).toBe(okxAfterFirst);
    expect(callsTo(fetchSpy, "gateio.ws")).toBe(gateAfterFirst);
  });

  it("legacy INVALID_CURRENCY_PAIR label is still detected (single Gate call)", async () => {
    mockGetCached.mockResolvedValue(null);
    const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes("okx.com")) {
        // OKX empty data → falls through to Gate without error.
        return { ok: true, status: 200, json: async () => ({ code: "0", data: [] }), text: async () => "" };
      }
      if (String(url).includes("gateio.ws")) {
        return {
          ok: false,
          status: 400,
          json: async () => ({}),
          text: async () => JSON.stringify({ label: "INVALID_CURRENCY_PAIR", message: "Invalid currency pair ABC_USDT" }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ s: "error" }), text: async () => "" };
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await runFetch("PAIRTEST/USDT");
    expect(result).toEqual([]);
    expect(callsTo(fetchSpy, "gateio.ws")).toBe(1);
  });
});
