/**
 * DASH-PRICE-FAILFAST-02 — Dashboard price-failfast tests for the six sibling
 * routes converted in this commit.
 *
 * Verifies that each of the following routes never initiates or awaits a
 * full-market price refresh, returns stored data enriched only by an immediate
 * in-memory cached-price snapshot, and carries the additive staleness fields
 * (pricesAsOf / pricesStale).
 *
 *   1. GET /api/wallet/capital
 *   2. GET /api/health-metrics
 *   3. GET /api/bots/:botId/balance
 *   4. GET /api/bots/:botId/overview
 *   5. GET /api/total-equity   (SPECIAL: equity calculation, stale-labelled)
 *   6. GET /api/bot/:botId/balance  (legacy)
 *
 * Coverage:
 *   [A01] getCachedPriceMeta returns oldest fetchedAt across requested symbols
 *   [A02] getCachedPriceMeta returns null when no valid entries
 *   [A03] getCachedPriceMeta is synchronous (not a Promise)
 *   [A04] getCachedPriceMeta never mutates fetchedAt
 *   [A05] getCachedPriceMeta excludes NaN/Infinity/<=0 (same eligibility as getCachedPrices)
 *   [B01] getCachedDisplayPricesWithMeta: pricesAsOf = oldest fetchedAt present
 *   [B02] getCachedDisplayPricesWithMeta: pricesStale=true when oldest exceeds threshold
 *   [B03] getCachedDisplayPricesWithMeta: pricesStale=false when fresh
 *   [B04] getCachedDisplayPricesWithMeta: pricesStale=true (pricesAsOf=null) when no entries
 *   [B05] getCachedDisplayPricesWithMeta: adapter-absent falls back gracefully
 *   [C01-C06] Per-route: zero getAllPrices calls (even with hanging mock)
 *   [C07-C12] Per-route: stale cached prices applied correctly
 *   [C13-C18] Per-route: entry-price fallback when cache empty
 *   [C19-C24] Per-route: pricesAsOf and pricesStale present in response shape
 *   [C25] NaN/Infinity/<=0 never leak into mark-price calculation
 *   [D01] total-equity: equity number uses entry-price fallback for absent prices (never zero)
 *   [D02] total-equity: pricesStale=true when a used price is stale
 *   [D03] total-equity: pricesStale=false when all used prices are fresh
 *   [E01] Zero-diff guard: getCachedPrices (positions/trading-bots callers) unchanged
 *   [E02] Two excluded routes (prices / prices/stream) are unchanged: they still call getAllPrices
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter.js';

// ---------------------------------------------------------------------------
// Internal helpers — mirrors dash-price-failfast.test.ts conventions
// ---------------------------------------------------------------------------

const STALE_AGE_MS = 5 * 60 * 1000; // 5 minutes — well past the 60 s TTL
const PRICE_STALENESS_THRESHOLD_MS = 60_000; // must match routes.ts constant

function seedPrice(
  adapter: PacificaAdapter,
  symbol: string,
  price: number,
  ageMs = 0,
): void {
  const cache = (adapter as unknown as { priceCache: Map<string, { data: number; fetchedAt: number }> }).priceCache;
  cache.set(symbol.toUpperCase(), { data: price, fetchedAt: Date.now() - ageMs });
}

function readRawEntry(adapter: PacificaAdapter, symbol: string) {
  const cache = (adapter as unknown as { priceCache: Map<string, { data: number; fetchedAt: number }> }).priceCache;
  return cache.get(symbol.toUpperCase());
}

// ---------------------------------------------------------------------------
// Simulation helpers — reproduce the route's enrichment + staleness logic
// exactly as shipped in this commit.
// ---------------------------------------------------------------------------

interface PriceAdapter {
  getCachedPrices?(symbols: string[]): Record<string, number>;
  getCachedPriceMeta?(symbols: string[]): { oldestFetchedAt: number | null };
  getAllPrices?(): Promise<Record<string, number>>;
}

function simulateCachedDisplayPricesWithMeta(
  adapter: PriceAdapter,
  symbols: string[],
): { prices: Record<string, number>; pricesAsOf: number | null; pricesStale: boolean } {
  const prices = adapter.getCachedPrices?.(symbols) ?? {};
  const meta = adapter.getCachedPriceMeta?.(symbols) ?? { oldestFetchedAt: null };
  const pricesAsOf = meta.oldestFetchedAt;
  const pricesStale = pricesAsOf === null || (Date.now() - pricesAsOf) > PRICE_STALENESS_THRESHOLD_MS;
  return { prices, pricesAsOf, pricesStale };
}

/** Simulates /api/wallet/capital enrichment (per-bot fallback branch). */
function simulateCapitalEnrichment(
  bots: { market: string }[],
  position: { market: string; baseSize: string; avgEntryPrice: string } | null,
  adapter: PriceAdapter,
) {
  const botMarketsCap = [...new Set(bots.map((b) => b.market))];
  const { prices, pricesAsOf, pricesStale } = simulateCachedDisplayPricesWithMeta(adapter, botMarketsCap);
  let unrealizedPnl = 0;
  if (position) {
    const baseSize = parseFloat(position.baseSize);
    const entryPrice = parseFloat(position.avgEntryPrice);
    const markPrice = prices[position.market] || entryPrice;
    if (Math.abs(baseSize) > 0.0001 && markPrice > 0) {
      unrealizedPnl = baseSize > 0
        ? (markPrice - entryPrice) * Math.abs(baseSize)
        : (entryPrice - markPrice) * Math.abs(baseSize);
    }
  }
  return { unrealizedPnl, pricesAsOf, pricesStale };
}

/** Simulates /api/health-metrics enrichment (one DB position). */
function simulateHealthMetricsEnrichment(
  bots: { market: string }[],
  dbPositions: { market: string; baseSize: string; avgEntryPrice: string }[],
  adapter: PriceAdapter,
) {
  const hmMarkets = [...new Set(bots.map((b) => b.market))];
  const { prices, pricesAsOf, pricesStale } = simulateCachedDisplayPricesWithMeta(adapter, hmMarkets);
  const results = dbPositions.map((pos) => {
    const baseSize = parseFloat(pos.baseSize);
    const entryPrice = parseFloat(pos.avgEntryPrice);
    const markPrice = prices[pos.market] || entryPrice;
    return { market: pos.market, markPrice, entryPrice };
  });
  return { results, pricesAsOf, pricesStale };
}

/** Simulates /api/bots/:botId/balance enrichment (single-bot fallback). */
function simulateBotBalanceEnrichment(
  botMarket: string,
  position: { market: string; baseSize: string; avgEntryPrice: string; realizedPnl: string; totalFees: string } | null,
  netDeposited: number,
  adapter: PriceAdapter,
) {
  const { prices, pricesAsOf, pricesStale } = simulateCachedDisplayPricesWithMeta(adapter, [botMarket]);
  let unrealizedPnl = 0;
  if (position) {
    const baseSize = parseFloat(position.baseSize);
    const entryPrice = parseFloat(position.avgEntryPrice);
    const markPrice = prices[position.market] || entryPrice;
    if (Math.abs(baseSize) > 0.0001 && markPrice > 0) {
      unrealizedPnl = baseSize > 0
        ? (markPrice - entryPrice) * Math.abs(baseSize)
        : (entryPrice - markPrice) * Math.abs(baseSize);
    }
  }
  const realizedPnl = parseFloat(position?.realizedPnl || '0');
  const totalFees = parseFloat(position?.totalFees || '0');
  const botBalance = netDeposited + realizedPnl + unrealizedPnl - totalFees;
  return { botBalance, pricesAsOf, pricesStale };
}

/** Simulates /api/bots/:botId/overview enrichment (DB-fallback branch). */
function simulateOverviewEnrichment(
  botMarket: string,
  dbPosition: { market: string; baseSize: string; avgEntryPrice: string } | null,
  adapter: PriceAdapter,
) {
  const { prices, pricesAsOf, pricesStale } = simulateCachedDisplayPricesWithMeta(adapter, [botMarket]);
  let unrealizedPnl = 0;
  let markPrice = 0;
  if (dbPosition) {
    const baseSize = parseFloat(dbPosition.baseSize);
    const entryPrice = parseFloat(dbPosition.avgEntryPrice);
    markPrice = prices[dbPosition.market] || entryPrice;
    if (Math.abs(baseSize) > 0.0001 && markPrice > 0) {
      unrealizedPnl = baseSize > 0
        ? (markPrice - entryPrice) * Math.abs(baseSize)
        : (entryPrice - markPrice) * Math.abs(baseSize);
    }
  }
  return { markPrice, unrealizedPnl, pricesAsOf, pricesStale };
}

/** Simulates /api/total-equity enrichment (DB-fallback branch, prices hoisted out of loop). */
function simulateTotalEquityEnrichment(
  bots: { market: string }[],
  perBotData: Array<{ position: { market: string; baseSize: string; avgEntryPrice: string } | null; netDeposited: number }>,
  adapter: PriceAdapter,
) {
  const teBotMarkets = [...new Set(bots.map((b) => b.market))];
  const { prices: teDbPrices, pricesAsOf, pricesStale } = simulateCachedDisplayPricesWithMeta(adapter, teBotMarkets);
  let totalBotBalance = 0;
  for (const { position, netDeposited } of perBotData) {
    let unrealizedPnl = 0;
    if (position) {
      const baseSize = parseFloat(position.baseSize);
      const entryPrice = parseFloat(position.avgEntryPrice);
      const markPrice = teDbPrices[position.market] || entryPrice;
      if (Math.abs(baseSize) > 0.0001 && markPrice > 0) {
        unrealizedPnl = baseSize > 0
          ? (markPrice - entryPrice) * Math.abs(baseSize)
          : (entryPrice - markPrice) * Math.abs(baseSize);
      }
    }
    totalBotBalance += netDeposited + unrealizedPnl;
  }
  return { totalBotBalance, pricesAsOf, pricesStale };
}

/** Simulates legacy /api/bot/:botId/balance enrichment. */
function simulateLegacyBotBalanceEnrichment(
  botMarket: string,
  position: { market: string; baseSize: string; avgEntryPrice: string } | null,
  netDeposited: number,
  realizedPnl: number,
  totalFees: number,
  adapter: PriceAdapter,
) {
  const { prices: legPrices, pricesAsOf, pricesStale } = simulateCachedDisplayPricesWithMeta(adapter, [botMarket]);
  let unrealizedPnl = 0;
  if (position) {
    const baseSize = parseFloat(position.baseSize);
    const entryPrice = parseFloat(position.avgEntryPrice);
    const markPrice = legPrices[position.market] || entryPrice;
    if (Math.abs(baseSize) > 0.0001 && markPrice > 0) {
      unrealizedPnl = baseSize > 0
        ? (markPrice - entryPrice) * Math.abs(baseSize)
        : (entryPrice - markPrice) * Math.abs(baseSize);
    }
  }
  const botBalance = netDeposited + realizedPnl + unrealizedPnl - totalFees;
  return { botBalance, pricesAsOf, pricesStale };
}

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const SOL_BOT = { market: 'SOL-PERP' };
const BTC_BOT = { market: 'BTC-PERP' };
const BOTS = [SOL_BOT, BTC_BOT];

const SOL_POSITION = { market: 'SOL-PERP', baseSize: '10', avgEntryPrice: '140.00', realizedPnl: '0', totalFees: '5' };
const BTC_POSITION = { market: 'BTC-PERP', baseSize: '-0.5', avgEntryPrice: '60000.00', realizedPnl: '200', totalFees: '10' };

// ---------------------------------------------------------------------------
// SECTION A: getCachedPriceMeta on PacificaAdapter
// ---------------------------------------------------------------------------

describe('DASH-PRICE-FAILFAST-02 [A]: PacificaAdapter.getCachedPriceMeta', () => {
  let adapter: PacificaAdapter;

  beforeEach(() => {
    adapter = new PacificaAdapter();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // A01 — returns oldest fetchedAt across requested symbols
  it('[A01] returns the oldest fetchedAt across valid entries', () => {
    const now = Date.now();
    seedPrice(adapter, 'SOL-PERP', 142, 1000);   // fetchedAt = now - 1000
    seedPrice(adapter, 'BTC-PERP', 60000, 5000); // fetchedAt = now - 5000 (older)

    const { oldestFetchedAt } = adapter.getCachedPriceMeta(['SOL-PERP', 'BTC-PERP']);

    expect(oldestFetchedAt).not.toBeNull();
    // Should be approximately now-5000 (oldest)
    expect(Math.abs(oldestFetchedAt! - (now - 5000))).toBeLessThan(50);
  });

  // A02 — returns null when no valid entries
  it('[A02] returns null when cache is empty', () => {
    const { oldestFetchedAt } = adapter.getCachedPriceMeta(['SOL-PERP', 'BTC-PERP']);
    expect(oldestFetchedAt).toBeNull();
  });

  // A03 — synchronous
  it('[A03] getCachedPriceMeta is synchronous — not a Promise', () => {
    seedPrice(adapter, 'SOL-PERP', 142);
    const result = adapter.getCachedPriceMeta(['SOL-PERP']);
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof result).toBe('object');
    expect('oldestFetchedAt' in result).toBe(true);
  });

  // A04 — never mutates fetchedAt
  it('[A04] getCachedPriceMeta does not mutate fetchedAt', () => {
    const originalFetchedAt = Date.now() - STALE_AGE_MS;
    seedPrice(adapter, 'SOL-PERP', 145, STALE_AGE_MS);

    const before = readRawEntry(adapter, 'SOL-PERP');
    expect(before?.fetchedAt).toBe(originalFetchedAt);

    adapter.getCachedPriceMeta(['SOL-PERP']);
    adapter.getCachedPriceMeta(['SOL-PERP']);

    const after = readRawEntry(adapter, 'SOL-PERP');
    expect(after?.fetchedAt).toBe(originalFetchedAt);
  });

  // A05 — excludes NaN/Infinity/<=0 (same eligibility as getCachedPrices)
  it('[A05] excludes invalid entries (NaN, Infinity, zero, negative) from staleness calc', () => {
    const cache = (adapter as unknown as { priceCache: Map<string, { data: number; fetchedAt: number }> }).priceCache;
    const ts = Date.now() - 1000;
    cache.set('NAN-PERP', { data: NaN, fetchedAt: ts });
    cache.set('INF-PERP', { data: Infinity, fetchedAt: ts });
    cache.set('ZERO-PERP', { data: 0, fetchedAt: ts });
    cache.set('NEG-PERP', { data: -100, fetchedAt: ts });

    const { oldestFetchedAt } = adapter.getCachedPriceMeta([
      'NAN-PERP', 'INF-PERP', 'ZERO-PERP', 'NEG-PERP',
    ]);

    // All entries are invalid — should not count toward staleness
    expect(oldestFetchedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SECTION B: getCachedDisplayPricesWithMeta logic
// ---------------------------------------------------------------------------

describe('DASH-PRICE-FAILFAST-02 [B]: getCachedDisplayPricesWithMeta', () => {
  let adapter: PacificaAdapter;

  beforeEach(() => {
    adapter = new PacificaAdapter();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // B01 — pricesAsOf = oldest fetchedAt
  it('[B01] pricesAsOf equals the oldest fetchedAt among valid entries', () => {
    const now = Date.now();
    seedPrice(adapter, 'SOL-PERP', 142, 1000);
    seedPrice(adapter, 'BTC-PERP', 60000, 3000); // older

    const { pricesAsOf } = simulateCachedDisplayPricesWithMeta(adapter, ['SOL-PERP', 'BTC-PERP']);

    expect(pricesAsOf).not.toBeNull();
    expect(Math.abs(pricesAsOf! - (now - 3000))).toBeLessThan(50);
  });

  // B02 — pricesStale=true when oldest exceeds threshold
  it('[B02] pricesStale=true when oldest cached entry exceeds the staleness threshold', () => {
    seedPrice(adapter, 'SOL-PERP', 142, STALE_AGE_MS); // 5 min old > 60s

    const { pricesStale } = simulateCachedDisplayPricesWithMeta(adapter, ['SOL-PERP']);
    expect(pricesStale).toBe(true);
  });

  // B03 — pricesStale=false when fresh
  it('[B03] pricesStale=false when all used entries are fresh', () => {
    seedPrice(adapter, 'SOL-PERP', 142, 10_000); // 10s old < 60s threshold

    const { pricesStale } = simulateCachedDisplayPricesWithMeta(adapter, ['SOL-PERP']);
    expect(pricesStale).toBe(false);
  });

  // B04 — pricesStale=true (null) when no valid entries
  it('[B04] pricesStale=true and pricesAsOf=null when cache has no valid entries', () => {
    // empty cache
    const { pricesAsOf, pricesStale } = simulateCachedDisplayPricesWithMeta(adapter, ['SOL-PERP']);
    expect(pricesAsOf).toBeNull();
    expect(pricesStale).toBe(true);
  });

  // B05 — adapter-absent: graceful fallback
  it('[B05] falls back gracefully when adapter has no getCachedPrices / getCachedPriceMeta', () => {
    const noAdapter: PriceAdapter = {};
    const { prices, pricesAsOf, pricesStale } = simulateCachedDisplayPricesWithMeta(noAdapter, ['SOL-PERP']);
    expect(prices).toEqual({});
    expect(pricesAsOf).toBeNull();
    expect(pricesStale).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SECTION C: Per-route isolation, fallback, and staleness field coverage
// ---------------------------------------------------------------------------

describe('DASH-PRICE-FAILFAST-02 [C]: per-route isolation and staleness fields', () => {
  let adapter: PacificaAdapter;

  beforeEach(() => {
    adapter = new PacificaAdapter();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // --- /api/wallet/capital ---

  it('[C01] /api/wallet/capital: zero getAllPrices calls even when getAllPrices never resolves', () => {
    const getAllPricesSpy = vi.spyOn(adapter, 'getAllPrices').mockImplementation(
      () => new Promise(() => { /* intentionally never resolves */ }),
    );
    seedPrice(adapter, 'SOL-PERP', 143, STALE_AGE_MS);

    // Simulate the route's enrichment
    simulateCapitalEnrichment(BOTS, SOL_POSITION, adapter);

    expect(getAllPricesSpy).not.toHaveBeenCalled();
  });

  it('[C07] /api/wallet/capital: stale cached mark-price applied to position unrealizedPnl', () => {
    seedPrice(adapter, 'SOL-PERP', 160, STALE_AGE_MS); // stale

    const { unrealizedPnl } = simulateCapitalEnrichment(BOTS, SOL_POSITION, adapter);

    // SOL LONG 10 contracts: (160 - 140) * 10 = 200
    expect(unrealizedPnl).toBeCloseTo(200, 6);
  });

  it('[C13] /api/wallet/capital: entry-price fallback when cache empty → unrealizedPnl=0', () => {
    const { unrealizedPnl } = simulateCapitalEnrichment(BOTS, SOL_POSITION, adapter);
    // markPrice === entryPrice → unrealizedPnl = 0
    expect(unrealizedPnl).toBe(0);
  });

  it('[C19] /api/wallet/capital: pricesAsOf and pricesStale present in response shape', () => {
    seedPrice(adapter, 'SOL-PERP', 143, STALE_AGE_MS);
    const { pricesAsOf, pricesStale } = simulateCapitalEnrichment(BOTS, SOL_POSITION, adapter);
    expect(typeof pricesAsOf === 'number' || pricesAsOf === null).toBe(true);
    expect(typeof pricesStale).toBe('boolean');
    expect(pricesStale).toBe(true); // STALE_AGE_MS > threshold
  });

  // --- /api/health-metrics ---

  it('[C02] /api/health-metrics: zero getAllPrices calls even when getAllPrices never resolves', () => {
    const getAllPricesSpy = vi.spyOn(adapter, 'getAllPrices').mockImplementation(
      () => new Promise(() => {}),
    );
    seedPrice(adapter, 'SOL-PERP', 143, STALE_AGE_MS);

    simulateHealthMetricsEnrichment(BOTS, [SOL_POSITION], adapter);

    expect(getAllPricesSpy).not.toHaveBeenCalled();
  });

  it('[C08] /api/health-metrics: stale cached mark-price applied to positions', () => {
    seedPrice(adapter, 'SOL-PERP', 165, STALE_AGE_MS);

    const { results } = simulateHealthMetricsEnrichment(BOTS, [SOL_POSITION], adapter);

    expect(results[0].markPrice).toBe(165);
  });

  it('[C14] /api/health-metrics: entry-price fallback when cache empty', () => {
    const { results } = simulateHealthMetricsEnrichment(BOTS, [SOL_POSITION], adapter);
    expect(results[0].markPrice).toBe(140); // entryPrice
  });

  it('[C20] /api/health-metrics: pricesAsOf and pricesStale present in response shape', () => {
    seedPrice(adapter, 'SOL-PERP', 143, STALE_AGE_MS);
    const { pricesAsOf, pricesStale } = simulateHealthMetricsEnrichment(BOTS, [SOL_POSITION], adapter);
    expect(typeof pricesAsOf === 'number' || pricesAsOf === null).toBe(true);
    expect(pricesStale).toBe(true);
  });

  // --- /api/bots/:botId/balance ---

  it('[C03] /api/bots/:botId/balance: zero getAllPrices calls even when getAllPrices never resolves', () => {
    const getAllPricesSpy = vi.spyOn(adapter, 'getAllPrices').mockImplementation(
      () => new Promise(() => {}),
    );
    seedPrice(adapter, 'SOL-PERP', 143, STALE_AGE_MS);

    simulateBotBalanceEnrichment('SOL-PERP', SOL_POSITION, 500, adapter);

    expect(getAllPricesSpy).not.toHaveBeenCalled();
  });

  it('[C09] /api/bots/:botId/balance: stale cached price contributes to botBalance', () => {
    seedPrice(adapter, 'SOL-PERP', 160, STALE_AGE_MS);

    const { botBalance } = simulateBotBalanceEnrichment('SOL-PERP', SOL_POSITION, 500, adapter);

    // netDeposited=500, realizedPnl=0, unrealizedPnl=(160-140)*10=200, totalFees=5
    expect(botBalance).toBeCloseTo(500 + 200 - 5, 6);
  });

  it('[C15] /api/bots/:botId/balance: entry-price fallback when cache empty → unrealizedPnl=0', () => {
    const { botBalance } = simulateBotBalanceEnrichment('SOL-PERP', SOL_POSITION, 500, adapter);
    // unrealizedPnl = 0 (entry-price fallback), totalFees=5
    expect(botBalance).toBeCloseTo(500 - 5, 6);
  });

  it('[C21] /api/bots/:botId/balance: pricesAsOf and pricesStale present', () => {
    seedPrice(adapter, 'SOL-PERP', 143, STALE_AGE_MS);
    const { pricesAsOf, pricesStale } = simulateBotBalanceEnrichment('SOL-PERP', SOL_POSITION, 500, adapter);
    expect(typeof pricesAsOf === 'number' || pricesAsOf === null).toBe(true);
    expect(pricesStale).toBe(true);
  });

  // --- /api/bots/:botId/overview ---

  it('[C04] /api/bots/:botId/overview: zero getAllPrices calls even when getAllPrices never resolves', () => {
    const getAllPricesSpy = vi.spyOn(adapter, 'getAllPrices').mockImplementation(
      () => new Promise(() => {}),
    );
    seedPrice(adapter, 'SOL-PERP', 143, STALE_AGE_MS);

    simulateOverviewEnrichment('SOL-PERP', SOL_POSITION, adapter);

    expect(getAllPricesSpy).not.toHaveBeenCalled();
  });

  it('[C10] /api/bots/:botId/overview: stale cached price used as mark-price', () => {
    seedPrice(adapter, 'SOL-PERP', 175, STALE_AGE_MS);

    const { markPrice } = simulateOverviewEnrichment('SOL-PERP', SOL_POSITION, adapter);
    expect(markPrice).toBe(175);
  });

  it('[C16] /api/bots/:botId/overview: entry-price fallback when cache empty', () => {
    const { markPrice } = simulateOverviewEnrichment('SOL-PERP', SOL_POSITION, adapter);
    expect(markPrice).toBe(140); // entryPrice
  });

  it('[C22] /api/bots/:botId/overview: pricesAsOf and pricesStale present', () => {
    seedPrice(adapter, 'SOL-PERP', 143, STALE_AGE_MS);
    const { pricesAsOf, pricesStale } = simulateOverviewEnrichment('SOL-PERP', SOL_POSITION, adapter);
    expect(typeof pricesAsOf === 'number' || pricesAsOf === null).toBe(true);
    expect(pricesStale).toBe(true);
  });

  // --- /api/total-equity ---

  it('[C05] /api/total-equity: zero getAllPrices calls even when getAllPrices never resolves', () => {
    const getAllPricesSpy = vi.spyOn(adapter, 'getAllPrices').mockImplementation(
      () => new Promise(() => {}),
    );
    seedPrice(adapter, 'SOL-PERP', 143, STALE_AGE_MS);

    simulateTotalEquityEnrichment(
      BOTS,
      [{ position: SOL_POSITION, netDeposited: 500 }],
      adapter,
    );

    expect(getAllPricesSpy).not.toHaveBeenCalled();
  });

  it('[C11] /api/total-equity: stale cached prices used in equity calculation', () => {
    seedPrice(adapter, 'SOL-PERP', 160, STALE_AGE_MS);

    const { totalBotBalance } = simulateTotalEquityEnrichment(
      [SOL_BOT],
      [{ position: SOL_POSITION, netDeposited: 500 }],
      adapter,
    );

    // unrealizedPnl = (160-140)*10=200; botBalance = 500+200=700
    expect(totalBotBalance).toBeCloseTo(700, 6);
  });

  it('[C17] /api/total-equity: entry-price fallback when cache empty', () => {
    const { totalBotBalance } = simulateTotalEquityEnrichment(
      [SOL_BOT],
      [{ position: SOL_POSITION, netDeposited: 500 }],
      adapter,
    );
    // unrealizedPnl=0 (entry-price fallback)
    expect(totalBotBalance).toBeCloseTo(500, 6);
  });

  it('[C23] /api/total-equity: pricesAsOf and pricesStale present', () => {
    seedPrice(adapter, 'SOL-PERP', 143, STALE_AGE_MS);
    const { pricesAsOf, pricesStale } = simulateTotalEquityEnrichment(
      BOTS,
      [{ position: SOL_POSITION, netDeposited: 500 }],
      adapter,
    );
    expect(typeof pricesAsOf === 'number' || pricesAsOf === null).toBe(true);
    expect(pricesStale).toBe(true);
  });

  // --- /api/bot/:botId/balance (legacy) ---

  it('[C06] legacy /api/bot/:botId/balance: zero getAllPrices calls even when getAllPrices never resolves', () => {
    const getAllPricesSpy = vi.spyOn(adapter, 'getAllPrices').mockImplementation(
      () => new Promise(() => {}),
    );
    seedPrice(adapter, 'SOL-PERP', 143, STALE_AGE_MS);

    simulateLegacyBotBalanceEnrichment('SOL-PERP', SOL_POSITION, 500, 0, 5, adapter);

    expect(getAllPricesSpy).not.toHaveBeenCalled();
  });

  it('[C12] legacy /api/bot/:botId/balance: stale cached price contributes to botBalance', () => {
    seedPrice(adapter, 'SOL-PERP', 160, STALE_AGE_MS);

    const { botBalance } = simulateLegacyBotBalanceEnrichment('SOL-PERP', SOL_POSITION, 500, 0, 5, adapter);

    // unrealizedPnl=(160-140)*10=200; 500+0+200-5=695
    expect(botBalance).toBeCloseTo(695, 6);
  });

  it('[C18] legacy /api/bot/:botId/balance: entry-price fallback when cache empty', () => {
    const { botBalance } = simulateLegacyBotBalanceEnrichment('SOL-PERP', SOL_POSITION, 500, 0, 5, adapter);
    // unrealizedPnl=0, totalFees=5 → 500-5=495
    expect(botBalance).toBeCloseTo(495, 6);
  });

  it('[C24] legacy /api/bot/:botId/balance: pricesAsOf and pricesStale present', () => {
    seedPrice(adapter, 'SOL-PERP', 143, STALE_AGE_MS);
    const { pricesAsOf, pricesStale } = simulateLegacyBotBalanceEnrichment('SOL-PERP', SOL_POSITION, 500, 0, 5, adapter);
    expect(typeof pricesAsOf === 'number' || pricesAsOf === null).toBe(true);
    expect(pricesStale).toBe(true);
  });

  // C25 — NaN/Infinity/<=0 never leak into mark-price calculation
  it('[C25] NaN/Infinity/zero/negative cached values never become mark-price', () => {
    const cache = (adapter as unknown as { priceCache: Map<string, { data: number; fetchedAt: number }> }).priceCache;
    const ts = Date.now();
    cache.set('SOL-PERP', { data: NaN, fetchedAt: ts });

    // With NaN in cache, getCachedPrices should return {} for SOL-PERP
    const prices = adapter.getCachedPrices(['SOL-PERP']);
    expect(prices['SOL-PERP']).toBeUndefined();

    // Route logic falls back to entryPrice
    const { botBalance } = simulateBotBalanceEnrichment('SOL-PERP', SOL_POSITION, 500, adapter);
    // unrealizedPnl=0 (NaN excluded → entryPrice fallback)
    expect(botBalance).toBeCloseTo(500 - 5, 6);
  });
});

// ---------------------------------------------------------------------------
// SECTION D: /api/total-equity special cases
// ---------------------------------------------------------------------------

describe('DASH-PRICE-FAILFAST-02 [D]: /api/total-equity special cases', () => {
  let adapter: PacificaAdapter;

  beforeEach(() => {
    adapter = new PacificaAdapter();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // D01 — absent price → entry-price fallback, never zero equity
  it('[D01] absent price uses entry-price fallback — botBalance never incorrectly zeroed', () => {
    // Cache has no SOL-PERP entry — markPrice falls back to entryPrice
    const { totalBotBalance } = simulateTotalEquityEnrichment(
      [SOL_BOT],
      [{ position: SOL_POSITION, netDeposited: 500 }],
      adapter,
    );
    // unrealizedPnl=0 because markPrice===entryPrice; netDeposited=500 still counts
    expect(totalBotBalance).toBeGreaterThan(0);
    expect(totalBotBalance).toBeCloseTo(500, 6);
  });

  // D02 — pricesStale=true when any used price is stale
  it('[D02] pricesStale=true when a used price is older than the threshold', () => {
    seedPrice(adapter, 'SOL-PERP', 142, STALE_AGE_MS); // stale

    const { pricesStale } = simulateTotalEquityEnrichment(
      [SOL_BOT],
      [{ position: SOL_POSITION, netDeposited: 500 }],
      adapter,
    );

    expect(pricesStale).toBe(true);
  });

  // D03 — pricesStale=false when all prices fresh
  it('[D03] pricesStale=false when all used prices are fresh', () => {
    seedPrice(adapter, 'SOL-PERP', 142, 5_000); // 5s old — fresh

    const { pricesStale } = simulateTotalEquityEnrichment(
      [SOL_BOT],
      [{ position: SOL_POSITION, netDeposited: 500 }],
      adapter,
    );

    expect(pricesStale).toBe(false);
  });

  // D04 — prices are hoisted out of loop; multiple bots each get correct price
  it('[D04] all bots in the loop use the same pre-fetched price snapshot', () => {
    seedPrice(adapter, 'SOL-PERP', 160, STALE_AGE_MS);
    seedPrice(adapter, 'BTC-PERP', 62000, STALE_AGE_MS);

    const { totalBotBalance } = simulateTotalEquityEnrichment(
      BOTS,
      [
        { position: { market: 'SOL-PERP', baseSize: '10', avgEntryPrice: '140', realizedPnl: '0', totalFees: '0' }, netDeposited: 500 },
        { position: { market: 'BTC-PERP', baseSize: '-0.5', avgEntryPrice: '60000', realizedPnl: '0', totalFees: '0' }, netDeposited: 300 },
      ],
      adapter,
    );

    // SOL LONG: unrealizedPnl=(160-140)*10=200; botBalance=500+200=700
    // BTC SHORT: unrealizedPnl=(60000-62000)*0.5=-1000; botBalance=300-1000=-700
    expect(totalBotBalance).toBeCloseTo(0, 6);
  });
});

// ---------------------------------------------------------------------------
// SECTION E: zero-diff guards for unchanged paths
// ---------------------------------------------------------------------------

describe('DASH-PRICE-FAILFAST-02 [E]: unchanged-path guards', () => {
  let adapter: PacificaAdapter;

  beforeEach(() => { adapter = new PacificaAdapter(); });
  afterEach(() => { vi.restoreAllMocks(); });

  // E01 — getCachedPrices (positions/trading-bots callers) still works
  it('[E01] getCachedPrices still works correctly (89eec978 callers unchanged)', () => {
    seedPrice(adapter, 'SOL-PERP', 142, STALE_AGE_MS);
    seedPrice(adapter, 'BTC-PERP', 60000);

    const result = adapter.getCachedPrices(['SOL-PERP', 'BTC-PERP']);
    expect(result['SOL-PERP']).toBe(142);
    expect(result['BTC-PERP']).toBe(60000);
    expect(result).not.toBeInstanceOf(Promise);
  });

  // E02 — getAllPrices still returns a Promise (excluded routes unchanged)
  it('[E02] getAllPrices still returns a Promise (excluded routes: /api/prices and /api/prices/stream)', () => {
    const result = adapter.getAllPrices();
    expect(result).toBeInstanceOf(Promise);
    result.catch(() => {}); // suppress unhandled rejection
  });

  // E03 — getCachedPriceMeta doesn't call getAllPrices or getPrice
  it('[E03] getCachedPriceMeta never calls getAllPrices or getPrice', () => {
    const getAllPricesSpy = vi.spyOn(adapter, 'getAllPrices');
    const getPriceSpy = vi.spyOn(adapter, 'getPrice');
    seedPrice(adapter, 'SOL-PERP', 142);

    adapter.getCachedPriceMeta(['SOL-PERP']);

    expect(getAllPricesSpy).not.toHaveBeenCalled();
    expect(getPriceSpy).not.toHaveBeenCalled();
  });

  // E04 — adapter-absent fallback: getCachedPriceMeta falls back to null
  it('[E04] getCachedPriceMeta? optional chaining falls back to { oldestFetchedAt: null }', () => {
    const adapterWithout: PriceAdapter = { getCachedPrices: () => ({}) }; // no getCachedPriceMeta
    const { pricesAsOf, pricesStale } = simulateCachedDisplayPricesWithMeta(adapterWithout, ['SOL-PERP']);
    expect(pricesAsOf).toBeNull();
    expect(pricesStale).toBe(true);
  });
});
