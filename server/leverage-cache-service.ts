import { Connection, Keypair } from "@solana/web3.js";

interface LeverageCache {
  leverageMap: Record<string, number>;
  lastUpdated: Date;
  expiresAt: Date;
  source: 'on-chain';
}

const CONSERVATIVE_FALLBACK = 5;
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
let leverageCache: LeverageCache | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let isRefreshing = false;

async function fetchOnChainLeverageLimits(): Promise<Record<string, number> | null> {
  try {
    console.log('[LeverageCache] Fetching on-chain leverage limits from Drift...');

    const sdkModule = await import('@drift-labs/sdk');
    const { DriftClient, BulkAccountLoader, PerpMarkets } = sdkModule;

    const rpcUrl = process.env.SOLANA_RPC_URL || process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
    const connection = new Connection(rpcUrl, 'confirmed');
    const dummyKeypair = Keypair.generate();
    const wallet = {
      publicKey: dummyKeypair.publicKey,
      signTransaction: async (t: any) => t,
      signAllTransactions: async (t: any) => t,
    };

    const accountLoader = new BulkAccountLoader(connection as any, 'confirmed', 1000);
    const driftClient = new DriftClient({
      connection: connection as any,
      wallet: wallet as any,
      env: 'mainnet-beta',
      accountSubscription: {
        type: 'polling',
        accountLoader,
      },
    });

    const subscribeTimeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('DriftClient subscribe timed out')), 20000)
    );
    await Promise.race([driftClient.subscribe(), subscribeTimeout]);

    const leverageMap: Record<string, number> = {};
    const perpMarkets = PerpMarkets['mainnet-beta'] || [];

    for (const market of perpMarkets) {
      try {
        const perpMarketAccount = driftClient.getPerpMarketAccount(market.marketIndex);
        if (perpMarketAccount && perpMarketAccount.marginRatioInitial > 0) {
          const maxLeverage = Math.floor(10000 / perpMarketAccount.marginRatioInitial);
          const key = market.symbol.toUpperCase().endsWith('-PERP')
            ? market.symbol.toUpperCase()
            : `${market.symbol.toUpperCase()}-PERP`;
          leverageMap[key] = maxLeverage;
        }
      } catch (e: any) {
        console.warn(`[LeverageCache] Skipping market ${market.symbol} (index ${market.marketIndex}): ${e.message || 'unknown error'}`);
      }
    }

    await driftClient.unsubscribe();

    if (Object.keys(leverageMap).length > 0) {
      console.log(`[LeverageCache] Fetched leverage limits for ${Object.keys(leverageMap).length} markets from on-chain data`);
      const examples = Object.entries(leverageMap).slice(0, 5).map(([s, l]) => `${s}: ${l}x`).join(', ');
      console.log(`[LeverageCache] Examples: ${examples}`);
      return leverageMap;
    }

    console.warn('[LeverageCache] No leverage data obtained from on-chain');
    return null;
  } catch (error: any) {
    console.error('[LeverageCache] Failed to fetch on-chain leverage limits:', error.message);
    return null;
  }
}

export async function refreshLeverageCache(): Promise<void> {
  if (isRefreshing) return;
  isRefreshing = true;

  try {
    const onChainData = await fetchOnChainLeverageLimits();
    const now = new Date();

    if (onChainData && Object.keys(onChainData).length > 0) {
      leverageCache = {
        leverageMap: onChainData,
        lastUpdated: now,
        expiresAt: new Date(now.getTime() + REFRESH_INTERVAL_MS),
        source: 'on-chain',
      };
      console.log(`[LeverageCache] Cache updated from on-chain data (${Object.keys(onChainData).length} markets)`);
    } else {
      console.warn(`[LeverageCache] On-chain fetch failed; using conservative ${CONSERVATIVE_FALLBACK}x fallback for all markets`);
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

  return CONSERVATIVE_FALLBACK;
}

export function getAllCachedLeverageLimits(): Record<string, number> {
  if (leverageCache) {
    return { ...leverageCache.leverageMap };
  }
  return {};
}

export function getLeverageCacheStatus(): {
  cached: boolean;
  source: 'on-chain' | null;
  lastUpdated: string | null;
  expiresAt: string | null;
  marketCount: number;
} {
  if (!leverageCache) {
    return { cached: false, source: null, lastUpdated: null, expiresAt: null, marketCount: 0 };
  }
  return {
    cached: true,
    source: leverageCache.source,
    lastUpdated: leverageCache.lastUpdated.toISOString(),
    expiresAt: leverageCache.expiresAt.toISOString(),
    marketCount: Object.keys(leverageCache.leverageMap).length,
  };
}
