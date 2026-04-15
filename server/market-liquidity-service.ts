import { getCachedMaxLeverage, isMarketNonTradable, getNonTradableMarkets } from "./leverage-cache-service";
import { getMarketInfo as getAdapterMarketInfo, getAllMarkets as getAdapterAllMarkets } from "./market-registry";
import type { MarketInfo as RegistryMarketInfo } from "./market-registry";
import type { RiskTier } from "./protocol/protocol-types";

export type { RiskTier };

export interface MarketInfo {
  symbol: string;
  fullName: string;
  marketIndex: number;
  category: string[];
  baseAssetSymbol: string;
  riskTier: RiskTier;
  estimatedSlippagePct: number;
  openInterestUsd: number | null;
  lastPrice: number | null;
  isActive: boolean;
  warning?: string;
  maxLeverage?: number;
}

interface MarketCache {
  markets: MarketInfo[];
  lastUpdated: Date;
  expiresAt: Date;
  source: 'adapter';
}

let marketCache: MarketCache | null = null;
const CACHE_DURATION_MS = 5 * 60 * 1000;

async function fetchMarketPrices(): Promise<Record<string, number>> {
  try {
    const response = await fetch('http://localhost:5000/api/prices');
    if (response.ok) {
      return await response.json();
    }
  } catch (error) {
  }
  return {};
}

function buildMarketFromRegistry(m: RegistryMarketInfo, price: number | null): MarketInfo {
  const baseSymbol = m.internalSymbol.replace(/-PERP$/, '');

  return {
    symbol: m.internalSymbol,
    fullName: m.fullName || baseSymbol,
    marketIndex: 0,
    category: m.category || [],
    baseAssetSymbol: baseSymbol,
    isActive: m.isActive,
    warning: m.warning,
    maxLeverage: m.maxLeverage,
    riskTier: m.riskTier,
    estimatedSlippagePct: m.estimatedSlippagePct,
    lastPrice: price,
    openInterestUsd: m.openInterestUsd || null,
  };
}

export async function getAllPerpMarkets(forceRefresh = false): Promise<MarketInfo[]> {
  const now = new Date();

  if (marketCache && !forceRefresh && now < marketCache.expiresAt) {
    return marketCache.markets;
  }

  const adapterMarkets = getAdapterAllMarkets();

  if (adapterMarkets.length === 0) {
    console.warn('[MarketLiquidity] No markets in adapter registry — returning empty list');
    return [];
  }

  const prices = await fetchMarketPrices();

  const markets: MarketInfo[] = adapterMarkets
    .filter(m => m.isActive)
    .map(m => buildMarketFromRegistry(m, prices[m.internalSymbol] || null));

  markets.sort((a, b) => (b.maxLeverage || 0) - (a.maxLeverage || 0) || a.symbol.localeCompare(b.symbol));

  marketCache = {
    markets,
    lastUpdated: now,
    expiresAt: new Date(now.getTime() + CACHE_DURATION_MS),
    source: 'adapter',
  };

  console.log(`[MarketLiquidity] Cached ${markets.length} markets from adapter: leverage range ${Math.min(...markets.map(m => m.maxLeverage || 1))}x - ${Math.max(...markets.map(m => m.maxLeverage || 1))}x`);

  return markets;
}

export async function getMarketBySymbol(symbol: string): Promise<MarketInfo | null> {
  const markets = await getAllPerpMarkets();
  return markets.find(m => m.symbol === symbol) || null;
}

export function getRiskTierInfo(tier: RiskTier): { label: string; color: string; description: string } {
  switch (tier) {
    case 'recommended':
      return {
        label: 'Recommended',
        color: 'green',
        description: 'High liquidity market (20x+ leverage) - minimal slippage',
      };
    case 'caution':
      return {
        label: 'Caution',
        color: 'yellow',
        description: 'Medium liquidity market (10-19x leverage) - moderate slippage',
      };
    case 'high_risk':
      return {
        label: 'High Risk',
        color: 'red',
        description: 'Lower liquidity market (<10x leverage) - higher slippage possible',
      };
  }
}

export function isValidMarket(symbol: string): boolean {
  const normalizedSymbol = symbol.toUpperCase().includes('-PERP')
    ? symbol.toUpperCase()
    : `${symbol.toUpperCase()}-PERP`;
  const info = getAdapterMarketInfo(normalizedSymbol);
  return info !== undefined && info.isActive;
}

export function getMarketIndex(symbol: string): number | null {
  return 0;
}

export function getMinOrderSize(symbol: string): number {
  const normalizedSymbol = symbol.toUpperCase().includes('-PERP')
    ? symbol.toUpperCase()
    : `${symbol.toUpperCase()}-PERP`;
  const adapterInfo = getAdapterMarketInfo(normalizedSymbol);
  if (adapterInfo) return adapterInfo.minOrderSizeBase;
  return 0.01;
}

export function getMarketMaxLeverage(symbol: string): number {
  return getCachedMaxLeverage(symbol);
}

export function invalidateMarketCache(): void {
  marketCache = null;
}

export async function refreshMarketData(): Promise<{
  success: boolean;
  marketCount: number;
  source: 'adapter';
  message: string;
  cacheExpiresAt: string;
}> {
  try {
    const markets = await getAllPerpMarkets(true);
    return {
      success: true,
      marketCount: markets.length,
      source: 'adapter',
      message: `Refreshed ${markets.length} markets from protocol adapter`,
      cacheExpiresAt: marketCache?.expiresAt.toISOString() || new Date().toISOString(),
    };
  } catch (error: any) {
    return {
      success: false,
      marketCount: 0,
      source: 'adapter',
      message: error.message || 'Failed to refresh market data',
      cacheExpiresAt: new Date().toISOString(),
    };
  }
}

export function getCacheStatus(): {
  cached: boolean;
  source: 'adapter' | null;
  lastUpdated: string | null;
  expiresAt: string | null;
  marketCount: number;
} {
  if (!marketCache) {
    return {
      cached: false,
      source: null,
      lastUpdated: null,
      expiresAt: null,
      marketCount: 0,
    };
  }

  return {
    cached: true,
    source: marketCache.source,
    lastUpdated: marketCache.lastUpdated.toISOString(),
    expiresAt: marketCache.expiresAt.toISOString(),
    marketCount: marketCache.markets.length,
  };
}
