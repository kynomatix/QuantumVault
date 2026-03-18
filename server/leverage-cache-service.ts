import { Connection, PublicKey } from "@solana/web3.js";
import path from "path";
import fs from "fs";
import { createRequire } from "module";

interface LeverageCache {
  leverageMap: Record<string, number>;
  nonTradableMarkets: Set<string>;
  lastUpdated: Date;
  expiresAt: Date;
}

const CONSERVATIVE_FALLBACK = 5;
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const DRIFT_PROGRAM_ID = new PublicKey('dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH');

let leverageCache: LeverageCache | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let isRefreshing = false;
let onCacheRefreshed: (() => void) | null = null;

export function setOnCacheRefreshed(cb: () => void): void {
  onCacheRefreshed = cb;
}

interface OnChainMarketData {
  leverageMap: Record<string, number>;
  nonTradableMarkets: Set<string>;
}

async function fetchOnChainMarketData(): Promise<OnChainMarketData | null> {
  try {
    console.log('[LeverageCache] Fetching market data from Drift on-chain...');

    const sdkModule = await import('@drift-labs/sdk');
    const { PerpMarkets, getPerpMarketPublicKeySync, CustomBorshAccountsCoder } = sdkModule;

    const _require = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
    const sdkPath = path.dirname(_require.resolve('@drift-labs/sdk/package.json'));
    const idl = JSON.parse(fs.readFileSync(path.join(sdkPath, 'lib/node/idl/drift.json'), 'utf8'));
    const coder = new CustomBorshAccountsCoder(idl);

    const rpcUrl = process.env.SOLANA_RPC_URL || process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
    const connection = new Connection(rpcUrl, 'confirmed');

    const perpMarkets = PerpMarkets['mainnet-beta'] || [];
    const keys = perpMarkets.map((m: any) => getPerpMarketPublicKeySync(DRIFT_PROGRAM_ID, m.marketIndex));

    const accounts = await connection.getMultipleAccountsInfo(keys);

    const leverageMap: Record<string, number> = {};
    const nonTradableMarkets = new Set<string>();

    for (let i = 0; i < accounts.length; i++) {
      if (!accounts[i]) continue;
      try {
        const decoded = coder.decode('PerpMarket', accounts[i]!.data);
        const symbol = perpMarkets[i].symbol.toUpperCase();
        const key = symbol.endsWith('-PERP') ? symbol : `${symbol}-PERP`;

        if (decoded.marginRatioInitial > 0) {
          const maxLeverage = Math.floor(10000 / decoded.marginRatioInitial);
          leverageMap[key] = maxLeverage;
        }

        const status = decoded.status;
        if (status) {
          const isReduceOnly = 'reduceOnly' in status;
          const isDelisted = 'delisted' in status;
          const isSettlement = 'settlement' in status;
          if (isReduceOnly || isDelisted || isSettlement) {
            nonTradableMarkets.add(key);
          }
        }
      } catch (e: any) {
        console.warn(`[LeverageCache] Skipping market ${perpMarkets[i].symbol}: ${e.message}`);
      }
    }

    if (Object.keys(leverageMap).length > 0) {
      console.log(`[LeverageCache] Fetched leverage for ${Object.keys(leverageMap).length} markets`);
      if (nonTradableMarkets.size > 0) {
        console.log(`[LeverageCache] Non-tradable markets (reduce-only/delisted/settlement): ${[...nonTradableMarkets].join(', ')}`);
      }
      return { leverageMap, nonTradableMarkets };
    }

    console.warn('[LeverageCache] No leverage data obtained');
    return null;
  } catch (error: any) {
    console.error('[LeverageCache] Failed to fetch market data:', error.message);
    return null;
  }
}

export async function refreshLeverageCache(): Promise<void> {
  if (isRefreshing) return;
  isRefreshing = true;

  try {
    const data = await fetchOnChainMarketData();
    const now = new Date();

    if (data && Object.keys(data.leverageMap).length > 0) {
      leverageCache = {
        leverageMap: data.leverageMap,
        nonTradableMarkets: data.nonTradableMarkets,
        lastUpdated: now,
        expiresAt: new Date(now.getTime() + REFRESH_INTERVAL_MS),
      };
      console.log(`[LeverageCache] Cache updated (${Object.keys(data.leverageMap).length} markets, ${data.nonTradableMarkets.size} non-tradable)`);
      if (onCacheRefreshed) onCacheRefreshed();
    } else {
      console.warn(`[LeverageCache] Fetch failed; using conservative ${CONSERVATIVE_FALLBACK}x fallback`);
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
  console.log(`[LeverageCache] Periodic refresh scheduled every ${REFRESH_INTERVAL_MS / 3600000} hours`);
}

export function getCachedMaxLeverage(symbol: string): number {
  const normalizedSymbol = symbol.toUpperCase().includes('-PERP')
    ? symbol.toUpperCase()
    : `${symbol.toUpperCase()}-PERP`;

  if (leverageCache) {
    return leverageCache.leverageMap[normalizedSymbol] ?? CONSERVATIVE_FALLBACK;
  }

  return CONSERVATIVE_FALLBACK;
}

export function getAllCachedLeverageLimits(): Record<string, number> {
  if (leverageCache) {
    return { ...leverageCache.leverageMap };
  }
  return {};
}

export function isMarketNonTradable(symbol: string): boolean | null {
  const normalizedSymbol = symbol.toUpperCase().includes('-PERP')
    ? symbol.toUpperCase()
    : `${symbol.toUpperCase()}-PERP`;
  if (leverageCache) {
    return leverageCache.nonTradableMarkets.has(normalizedSymbol);
  }
  return null;
}

export function isLeverageCacheReady(): boolean {
  return leverageCache !== null;
}

export function getNonTradableMarkets(): string[] {
  if (leverageCache) {
    return [...leverageCache.nonTradableMarkets];
  }
  return [];
}

export function getLeverageCacheStatus(): {
  cached: boolean;
  source: 'on-chain' | null;
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
    source: 'on-chain',
    lastUpdated: leverageCache.lastUpdated.toISOString(),
    expiresAt: leverageCache.expiresAt.toISOString(),
    marketCount: Object.keys(leverageCache.leverageMap).length,
    nonTradableCount: leverageCache.nonTradableMarkets.size,
    nonTradableMarkets: [...leverageCache.nonTradableMarkets],
  };
}
