import { getAllMarkets, getMarketInfo, isMarketCacheStale, updateMarketCache } from "./market-registry";
import type { MarketInfo } from "./market-registry";

interface LeverageCache {
  leverageMap: Record<string, number>;
  nonTradableMarkets: Set<string>;
  lastUpdated: Date;
  expiresAt: Date;
}

const CONSERVATIVE_FALLBACK = 5;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

let leverageCache: LeverageCache | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let isRefreshing = false;
let onCacheRefreshed: (() => void) | null = null;

export function setOnCacheRefreshed(cb: () => void): void {
  onCacheRefreshed = cb;
}

function buildCacheFromMarkets(markets: MarketInfo[]): { leverageMap: Record<string, number>; nonTradableMarkets: Set<string> } {
  const leverageMap: Record<string, number> = {};
  const nonTradableMarkets = new Set<string>();

  for (const m of markets) {
    leverageMap[m.internalSymbol] = m.maxLeverage;
    if (!m.isActive) {
      nonTradableMarkets.add(m.internalSymbol);
    }
  }

  return { leverageMap, nonTradableMarkets };
}

export async function refreshLeverageCache(): Promise<void> {
  if (isRefreshing) return;
  isRefreshing = true;

  try {
    const markets = getAllMarkets();

    if (markets.length > 0) {
      const { leverageMap, nonTradableMarkets } = buildCacheFromMarkets(markets);
      const now = new Date();

      leverageCache = {
        leverageMap,
        nonTradableMarkets,
        lastUpdated: now,
        expiresAt: new Date(now.getTime() + REFRESH_INTERVAL_MS),
      };
      console.log(`[LeverageCache] Cache updated from adapter (${Object.keys(leverageMap).length} markets, ${nonTradableMarkets.size} non-tradable)`);
      if (onCacheRefreshed) onCacheRefreshed();
    } else {
      console.warn(`[LeverageCache] No market data available from adapter; using conservative ${CONSERVATIVE_FALLBACK}x fallback`);
    }
  } finally {
    isRefreshing = false;
  }
}

export async function initLeverageCache(): Promise<void> {
  await refreshLeverageCache();

  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    refreshLeverageCache().catch(err => {
      console.error('[LeverageCache] Periodic refresh failed:', err.message);
    });
  }, REFRESH_INTERVAL_MS);
  console.log(`[LeverageCache] Periodic refresh scheduled every ${REFRESH_INTERVAL_MS / 60000} minutes`);
}

export function getCachedMaxLeverage(symbol: string): number {
  const normalizedSymbol = symbol.toUpperCase().includes('-PERP')
    ? symbol.toUpperCase()
    : `${symbol.toUpperCase()}-PERP`;

  if (leverageCache) {
    return leverageCache.leverageMap[normalizedSymbol] ?? CONSERVATIVE_FALLBACK;
  }

  const marketInfo = getMarketInfo(normalizedSymbol);
  if (marketInfo) return marketInfo.maxLeverage;

  return CONSERVATIVE_FALLBACK;
}

export function getAllCachedLeverageLimits(): Record<string, number> {
  if (leverageCache) {
    return { ...leverageCache.leverageMap };
  }
  const result: Record<string, number> = {};
  for (const m of getAllMarkets()) {
    result[m.internalSymbol] = m.maxLeverage;
  }
  return result;
}

export function isMarketNonTradable(symbol: string): boolean | null {
  const normalizedSymbol = symbol.toUpperCase().includes('-PERP')
    ? symbol.toUpperCase()
    : `${symbol.toUpperCase()}-PERP`;
  if (leverageCache) {
    return leverageCache.nonTradableMarkets.has(normalizedSymbol);
  }
  const marketInfo = getMarketInfo(normalizedSymbol);
  if (marketInfo) return !marketInfo.isActive;
  return null;
}

export function isLeverageCacheReady(): boolean {
  return leverageCache !== null;
}

export function getNonTradableMarkets(): string[] {
  if (leverageCache) {
    return Array.from(leverageCache.nonTradableMarkets);
  }
  return getAllMarkets().filter(m => !m.isActive).map(m => m.internalSymbol);
}

export function getLeverageCacheStatus(): {
  cached: boolean;
  source: 'adapter' | null;
  lastUpdated: string | null;
  expiresAt: string | null;
  marketCount: number;
  nonTradableCount: number;
  nonTradableMarkets: string[];
} {
  if (!leverageCache) {
    return { cached: false, source: null, lastUpdated: null, expiresAt: null, marketCount: 0, nonTradableCount: 0, nonTradableMarkets: [] };
  }
  return {
    cached: true,
    source: 'adapter',
    lastUpdated: leverageCache.lastUpdated.toISOString(),
    expiresAt: leverageCache.expiresAt.toISOString(),
    marketCount: Object.keys(leverageCache.leverageMap).length,
    nonTradableCount: leverageCache.nonTradableMarkets.size,
    nonTradableMarkets: Array.from(leverageCache.nonTradableMarkets),
  };
}
