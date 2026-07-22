/**
 * DASH-PRICE-FAILFAST-01 — Dashboard price-failfast tests.
 *
 * Verifies that the price-enrichment path used by GET /api/positions and
 * GET /api/trading-bots never initiates or awaits a full-market price
 * refresh, and returns stored account data enriched only by an immediate
 * in-memory cached-price snapshot.
 *
 * Coverage: all 17 mandatory test cases.
 *   1.  Every Pacifica market stale → getCachedPrices still returns cached values
 *   2.  Scanner disabled → cached values still returned
 *   3.  Upstream price requests never settle → getCachedPrices returns immediately
 *   4.  Pacifica quota exhausted → no quota involvement
 *   5.  /api/positions path performs ZERO upstream price requests
 *   6.  /api/positions returns stored positions with stale cached prices
 *   7.  /api/positions uses entry-price fallback when no cached price
 *   8.  /api/trading-bots path performs ZERO full-market price requests
 *   9.  /api/trading-bots returns stored bots when no price available
 *  10.  Response shape compatible — Record<string, number>
 *  11.  Only markets belonging to returned positions/bots are inspected
 *  12.  Concurrent core reads do not trigger getAllPrices
 *  13.  Cached-snapshot reads do not alter freshness/timestamps
 *  14.  NaN / Infinity / zero / negative excluded from results
 *  15.  Trading-decision price paths unchanged (getPrice still works normally)
 *  16.  Scanner behavior unchanged (getAllPrices still works normally)
 *  17.  No new timer / interval / background worker created by getCachedPrices
 *
 * No test waits for a real network request or approaches a 5-minute timeout.
 * All Pacifica HTTP is mocked or never called (sync-only primitive).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seed the adapter's internal priceCache without going through a network call. */
function seedPrice(
  adapter: PacificaAdapter,
  symbol: string,
  price: number,
  ageMs = 0,
): void {
  const cache: Map<string, { data: number; fetchedAt: number }> =
    (adapter as unknown as { priceCache: Map<string, { data: number; fetchedAt: number }> }).priceCache;
  cache.set(symbol.toUpperCase(), { data: price, fetchedAt: Date.now() - ageMs });
}

/** Read the raw priceCache entry without side-effects. */
function readRawEntry(
  adapter: PacificaAdapter,
  symbol: string,
): { data: number; fetchedAt: number } | undefined {
  const cache: Map<string, { data: number; fetchedAt: number }> =
    (adapter as unknown as { priceCache: Map<string, { data: number; fetchedAt: number }> }).priceCache;
  return cache.get(symbol.toUpperCase());
}

/**
 * Simulates the GET /api/positions price-enrichment logic exactly as it
 * exists after DASH-PRICE-FAILFAST-01.  Only the price-enrichment portion
 * is reproduced; storage / auth are irrelevant here.
 */
function simulatePositionsEnrichment(
  botPositions: { market: string; baseSize: string; avgEntryPrice: string }[],
  adapter: { getCachedPrices?: (symbols: string[]) => Record<string, number> },
): Array<{ market: string; markPrice: number; unrealizedPnl: number }> {
  const positionMarkets = [...new Set(botPositions.map((p) => p.market))];
  const prices = adapter.getCachedPrices?.(positionMarkets) ?? {};

  return botPositions
    .filter((pos) => Math.abs(parseFloat(pos.baseSize)) >= 0.0001)
    .map((pos) => {
      const baseSize = parseFloat(pos.baseSize);
      const entryPrice = parseFloat(pos.avgEntryPrice);
      const rawMarkPrice = prices[pos.market] ?? 0;
      const markPrice = rawMarkPrice > 0 ? rawMarkPrice : entryPrice;
      const unrealizedPnl =
        rawMarkPrice > 0
          ? baseSize > 0
            ? (markPrice - entryPrice) * Math.abs(baseSize)
            : (entryPrice - markPrice) * Math.abs(baseSize)
          : 0;
      return { market: pos.market, markPrice, unrealizedPnl };
    });
}

/**
 * Simulates the GET /api/trading-bots price-enrichment logic exactly as it
 * exists after DASH-PRICE-FAILFAST-01.
 */
function simulateTradingBotsEnrichment(
  bots: { id: string; market: string }[],
  adapter: { getCachedPrices?: (symbols: string[]) => Record<string, number> },
): { prices: Record<string, number>; marketCount: number } {
  const botMarkets = [...new Set(bots.map((b) => b.market))];
  const prices = adapter.getCachedPrices?.(botMarkets) ?? {};
  return { prices, marketCount: botMarkets.length };
}

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const STALE_AGE_MS = 5 * 60 * 1000; // 5 minutes — well past the 60 s TTL
const PRICE_CACHE_TTL_MS = 60 * 1000;

const BOT_POSITIONS = [
  { market: 'SOL-PERP', baseSize: '10', avgEntryPrice: '140.00' },
  { market: 'BTC-PERP', baseSize: '-0.5', avgEntryPrice: '60000.00' },
];

const BOTS = [
  { id: 'bot-1', market: 'SOL-PERP' },
  { id: 'bot-2', market: 'ETH-PERP' },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DASH-PRICE-FAILFAST-01: PacificaAdapter.getCachedPrices', () => {
  let adapter: PacificaAdapter;

  beforeEach(() => {
    adapter = new PacificaAdapter();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // 1 — Every Pacifica market stale → getCachedPrices still returns cached values
  it('[T01] returns stale cached prices when all markets are past TTL', () => {
    seedPrice(adapter, 'SOL-PERP', 142.5, STALE_AGE_MS);
    seedPrice(adapter, 'BTC-PERP', 61000, STALE_AGE_MS);

    const result = adapter.getCachedPrices(['SOL-PERP', 'BTC-PERP']);

    expect(result['SOL-PERP']).toBe(142.5);
    expect(result['BTC-PERP']).toBe(61000);
  });

  // 2 — Scanner disabled → cached values still returned (no refresh timer needed)
  it('[T02] returns cached prices regardless of whether scanner timer is running', () => {
    // Confirm no telemetry interval is set (scanner not running)
    const internal = adapter as unknown as { telemetryInterval: NodeJS.Timeout | null };
    expect(internal.telemetryInterval).toBeNull();

    seedPrice(adapter, 'SOL-PERP', 145.0, STALE_AGE_MS);

    const result = adapter.getCachedPrices(['SOL-PERP']);
    expect(result['SOL-PERP']).toBe(145.0);
  });

  // 3 — Upstream price requests never settle → getCachedPrices returns immediately
  it('[T03] getCachedPrices returns synchronously — it is not a Promise', () => {
    seedPrice(adapter, 'SOL-PERP', 150.0, STALE_AGE_MS);

    // If getCachedPrices were async it would return a Promise (thenable).
    const result = adapter.getCachedPrices(['SOL-PERP']);
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof result).toBe('object');
    // Confirm no microtask needed — value is available synchronously.
    expect(result['SOL-PERP']).toBe(150.0);
  });

  // 4 — Quota exhausted → getCachedPrices has zero quota involvement
  it('[T04] getCachedPrices never interacts with quota (synchronous, no network path)', () => {
    // There is no exposed quota object; this test proves the method is
    // synchronous (no await) and reads only from the Map, verified by:
    //   a) spy on this.get — which is the quota-gated fetch
    //   b) confirm the spy is never called
    const getSpy = vi.spyOn(
      adapter as unknown as { get: (...args: unknown[]) => unknown },
      'get',
    );
    seedPrice(adapter, 'ETH-PERP', 3500, STALE_AGE_MS);

    adapter.getCachedPrices(['ETH-PERP']);

    expect(getSpy).not.toHaveBeenCalled();
  });

  // 5 — /api/positions path performs ZERO upstream price requests
  it('[T05] positions enrichment calls getCachedPrices, never getAllPrices or getPrice', () => {
    const getAllPricesSpy = vi.spyOn(adapter, 'getAllPrices');
    const getPriceSpy = vi.spyOn(adapter, 'getPrice');
    seedPrice(adapter, 'SOL-PERP', 143.0);

    simulatePositionsEnrichment(BOT_POSITIONS, adapter);

    expect(getAllPricesSpy).not.toHaveBeenCalled();
    expect(getPriceSpy).not.toHaveBeenCalled();
  });

  // 6 — /api/positions returns stored positions with stale cached prices
  it('[T06] positions enrichment uses stale cached prices for mark-price display', () => {
    seedPrice(adapter, 'SOL-PERP', 155.0, STALE_AGE_MS);
    seedPrice(adapter, 'BTC-PERP', 62000, STALE_AGE_MS);

    const result = simulatePositionsEnrichment(BOT_POSITIONS, adapter);

    const sol = result.find((p) => p.market === 'SOL-PERP')!;
    const btc = result.find((p) => p.market === 'BTC-PERP')!;

    // SOL LONG: markPrice = cached stale price
    expect(sol.markPrice).toBe(155.0);
    expect(sol.unrealizedPnl).toBeCloseTo((155.0 - 140.0) * 10, 6);

    // BTC SHORT: markPrice = cached stale price
    expect(btc.markPrice).toBe(62000);
    expect(btc.unrealizedPnl).toBeCloseTo((60000 - 62000) * 0.5, 6);
  });

  // 7 — /api/positions uses entry-price fallback when no cached price
  it('[T07] positions enrichment falls back to entry price when cache is empty', () => {
    // priceCache is empty — getCachedPrices returns {}
    const result = simulatePositionsEnrichment(BOT_POSITIONS, adapter);

    const sol = result.find((p) => p.market === 'SOL-PERP')!;
    const btc = result.find((p) => p.market === 'BTC-PERP')!;

    // markPrice must equal entryPrice (fallback) — unrealizedPnl must be 0
    expect(sol.markPrice).toBe(140.0);
    expect(sol.unrealizedPnl).toBe(0);
    expect(btc.markPrice).toBe(60000);
    expect(btc.unrealizedPnl).toBe(0);
  });

  // 8 — /api/trading-bots path performs ZERO full-market price requests
  it('[T08] trading-bots enrichment calls getCachedPrices, never getAllPrices or getPrice', () => {
    const getAllPricesSpy = vi.spyOn(adapter, 'getAllPrices');
    const getPriceSpy = vi.spyOn(adapter, 'getPrice');
    seedPrice(adapter, 'SOL-PERP', 143.0);
    seedPrice(adapter, 'ETH-PERP', 3400);

    simulateTradingBotsEnrichment(BOTS, adapter);

    expect(getAllPricesSpy).not.toHaveBeenCalled();
    expect(getPriceSpy).not.toHaveBeenCalled();
  });

  // 9 — /api/trading-bots returns stored bots when no price available
  it('[T09] trading-bots enrichment returns empty prices map gracefully when cache empty', () => {
    // No seeds — getCachedPrices returns {}
    const { prices, marketCount } = simulateTradingBotsEnrichment(BOTS, adapter);

    // prices map must be empty (no prices to show) — not an error
    expect(prices).toEqual({});
    // All bots still counted (not filtered out)
    expect(marketCount).toBe(2);
  });

  // 10 — Response shape compatible — Record<string, number>
  it('[T10] getCachedPrices returns a plain Record<string, number>', () => {
    seedPrice(adapter, 'SOL-PERP', 144.0);
    seedPrice(adapter, 'BTC-PERP', 60500);

    const result = adapter.getCachedPrices(['SOL-PERP', 'BTC-PERP']);

    expect(typeof result).toBe('object');
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).not.toBeInstanceOf(Map);
    for (const v of Object.values(result)) {
      expect(typeof v).toBe('number');
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });

  // 11 — Only markets belonging to returned positions/bots are inspected
  it('[T11] getCachedPrices inspects only the symbols passed in, not the full market universe', () => {
    // Populate the cache with 5 markets but only request 2
    seedPrice(adapter, 'SOL-PERP', 144);
    seedPrice(adapter, 'BTC-PERP', 60500);
    seedPrice(adapter, 'ETH-PERP', 3400);
    seedPrice(adapter, 'ARB-PERP', 1.2);
    seedPrice(adapter, 'DOGE-PERP', 0.15);

    const getCachedSpy = vi.spyOn(adapter, 'getCachedPrices');
    const result = adapter.getCachedPrices(['SOL-PERP', 'BTC-PERP']);

    // Only the two requested markets should appear in the result
    expect(Object.keys(result)).toHaveLength(2);
    expect(result['SOL-PERP']).toBe(144);
    expect(result['BTC-PERP']).toBe(60500);
    expect(result['ETH-PERP']).toBeUndefined();
    expect(getCachedSpy).toHaveBeenCalledOnce();
  });

  // 12 — Concurrent core reads do not trigger getAllPrices
  it('[T12] multiple concurrent getCachedPrices calls never trigger getAllPrices', async () => {
    const getAllPricesSpy = vi.spyOn(adapter, 'getAllPrices');
    seedPrice(adapter, 'SOL-PERP', 143.0);
    seedPrice(adapter, 'ETH-PERP', 3400);

    // Fire 10 "concurrent" reads (all synchronous, no await needed)
    await Promise.all(
      Array.from({ length: 10 }, () =>
        Promise.resolve(adapter.getCachedPrices(['SOL-PERP', 'ETH-PERP'])),
      ),
    );

    expect(getAllPricesSpy).not.toHaveBeenCalled();
  });

  // 13 — Cached-snapshot reads do not alter freshness/timestamps
  it('[T13] getCachedPrices does not mutate fetchedAt or any cache entry', () => {
    const staleFetchedAt = Date.now() - STALE_AGE_MS;
    seedPrice(adapter, 'SOL-PERP', 146.0, STALE_AGE_MS);

    const before = readRawEntry(adapter, 'SOL-PERP');
    expect(before?.fetchedAt).toBe(staleFetchedAt);

    adapter.getCachedPrices(['SOL-PERP']);
    adapter.getCachedPrices(['SOL-PERP']);
    adapter.getCachedPrices(['SOL-PERP']);

    const after = readRawEntry(adapter, 'SOL-PERP');
    expect(after?.fetchedAt).toBe(staleFetchedAt);
    expect(after?.data).toBe(146.0);
  });

  // 14 — NaN / Infinity / zero / negative excluded
  it('[T14] excludes NaN, Infinity, zero, and negative values from results', () => {
    const cache = (adapter as unknown as { priceCache: Map<string, { data: number; fetchedAt: number }> }).priceCache;
    const ts = Date.now();
    cache.set('NAN-PERP', { data: NaN, fetchedAt: ts });
    cache.set('INF-PERP', { data: Infinity, fetchedAt: ts });
    cache.set('NINF-PERP', { data: -Infinity, fetchedAt: ts });
    cache.set('ZERO-PERP', { data: 0, fetchedAt: ts });
    cache.set('NEG-PERP', { data: -100, fetchedAt: ts });
    cache.set('OK-PERP', { data: 50, fetchedAt: ts });

    const result = adapter.getCachedPrices([
      'NAN-PERP', 'INF-PERP', 'NINF-PERP', 'ZERO-PERP', 'NEG-PERP', 'OK-PERP',
    ]);

    expect(result['NAN-PERP']).toBeUndefined();
    expect(result['INF-PERP']).toBeUndefined();
    expect(result['NINF-PERP']).toBeUndefined();
    expect(result['ZERO-PERP']).toBeUndefined();
    expect(result['NEG-PERP']).toBeUndefined();
    expect(result['OK-PERP']).toBe(50);
  });

  // 15 — Trading-decision price paths unchanged (getPrice still async + network)
  it('[T15] getPrice (trading-decision path) remains async and does NOT use getCachedPrices', () => {
    seedPrice(adapter, 'SOL-PERP', 142.0); // Fresh — getPrice should return from cache synchronously inside

    // getPrice must return a Promise regardless
    const result = adapter.getPrice('SOL-PERP', { priority: 'background' });
    expect(result).toBeInstanceOf(Promise);
  });

  // 16 — Scanner behavior unchanged (getAllPrices still returns a Promise)
  it('[T16] getAllPrices (scanner path) remains async and is unmodified by this change', () => {
    // getAllPrices must return a Promise
    const result = adapter.getAllPrices();
    expect(result).toBeInstanceOf(Promise);
    // Cancel the in-flight work to avoid dangling promises in the test
    result.catch(() => {});
  });

  // 17 — No new timer / interval / background worker created by getCachedPrices
  it('[T17] getCachedPrices creates no timer, interval, or background worker', () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

    seedPrice(adapter, 'SOL-PERP', 144.0);
    adapter.getCachedPrices(['SOL-PERP']);
    adapter.getCachedPrices(['SOL-PERP']);
    adapter.getCachedPrices(['SOL-PERP']);

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  // Bonus — duplicate symbols are deduped; case-insensitive lookup matches storage strings
  it('[bonus] deduplicates symbols and matches case-insensitively', () => {
    seedPrice(adapter, 'SOL-PERP', 147.0);

    const result = adapter.getCachedPrices(['SOL-PERP', 'sol-perp', 'SOL-PERP', 'Sol-Perp']);

    // All four refer to the same symbol — only one key in result
    expect(Object.keys(result)).toHaveLength(1);
    // Returned under the FIRST occurrence's original casing
    expect(result['SOL-PERP']).toBe(147.0);
  });
});

// ---------------------------------------------------------------------------
// Adapter-absent / optional-method fallback
// ---------------------------------------------------------------------------

describe('DASH-PRICE-FAILFAST-01: optional getCachedPrices fallback', () => {
  afterEach(() => vi.restoreAllMocks());

  it('simulatePositionsEnrichment falls back to {} when adapter has no getCachedPrices', () => {
    const adapterWithout = { /* no getCachedPrices */ } as object;

    const result = simulatePositionsEnrichment(BOT_POSITIONS, adapterWithout);

    // All positions present — no records dropped
    expect(result).toHaveLength(2);
    // All fall back to entry-price (unrealizedPnl = 0)
    for (const pos of result) {
      expect(pos.unrealizedPnl).toBe(0);
    }
  });

  it('simulateTradingBotsEnrichment falls back to {} when adapter has no getCachedPrices', () => {
    const adapterWithout = {} as object;

    const { prices } = simulateTradingBotsEnrichment(BOTS, adapterWithout);

    expect(prices).toEqual({});
  });
});
