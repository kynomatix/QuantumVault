import { getAllMarkets, getMarketInfo, isMarketCacheStale, updateMarketCache } from "./market-registry";
import type { MarketInfo, MarketMaxLeverageSource } from "./market-registry";

interface LeverageCache {
  leverageMap: Record<string, number>;
  leverageSourceMap: Record<string, MarketMaxLeverageSource>;
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

export interface MarketMaxLeverageReading {
  maxLeverage: number;
  maxLeverageSource: MarketMaxLeverageSource;
}

export function setOnCacheRefreshed(cb: () => void): void {
  onCacheRefreshed = cb;
}

function buildCacheFromMarkets(markets: MarketInfo[]): { leverageMap: Record<string, number>; leverageSourceMap: Record<string, MarketMaxLeverageSource>; nonTradableMarkets: Set<string> } {
  const leverageMap: Record<string, number> = {};
  const leverageSourceMap: Record<string, MarketMaxLeverageSource> = {};
  const nonTradableMarkets = new Set<string>();

  for (const m of markets) {
    leverageMap[m.internalSymbol] = m.maxLeverage;
    leverageSourceMap[m.internalSymbol] = m.maxLeverageSource;
    if (!m.isActive) {
      nonTradableMarkets.add(m.internalSymbol);
    }
  }

  return { leverageMap, leverageSourceMap, nonTradableMarkets };
}

export async function refreshLeverageCache(): Promise<void> {
  if (isRefreshing) return;
  isRefreshing = true;

  try {
    const markets = getAllMarkets();

    if (markets.length > 0) {
      const { leverageMap, leverageSourceMap, nonTradableMarkets } = buildCacheFromMarkets(markets);
      const now = new Date();

      leverageCache = {
        leverageMap,
        leverageSourceMap,
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

export function getCachedMaxLeverageWithSource(symbol: string): MarketMaxLeverageReading {
  const normalizedSymbol = symbol.toUpperCase().includes('-PERP')
    ? symbol.toUpperCase()
    : `${symbol.toUpperCase()}-PERP`;

  if (leverageCache) {
    const maxLeverage = leverageCache.leverageMap[normalizedSymbol];
    if (maxLeverage !== undefined) {
      return {
        maxLeverage,
        maxLeverageSource: leverageCache.leverageSourceMap[normalizedSymbol] === 'venue' ? 'venue' : 'fallback',
      };
    }
    return { maxLeverage: CONSERVATIVE_FALLBACK, maxLeverageSource: 'fallback' };
  }

  const marketInfo = getMarketInfo(normalizedSymbol);
  if (marketInfo) {
    return {
      maxLeverage: marketInfo.maxLeverage,
      maxLeverageSource: marketInfo.maxLeverageSource,
    };
  }

  return { maxLeverage: CONSERVATIVE_FALLBACK, maxLeverageSource: 'fallback' };
}

export function getCachedMaxLeverage(symbol: string): number {
  return getCachedMaxLeverageWithSource(symbol).maxLeverage;
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

export function getAllCachedLeverageSources(): Record<string, MarketMaxLeverageSource> {
  if (leverageCache) {
    return { ...leverageCache.leverageSourceMap };
  }
  const result: Record<string, MarketMaxLeverageSource> = {};
  for (const m of getAllMarkets()) {
    result[m.internalSymbol] = m.maxLeverageSource;
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
