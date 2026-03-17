import { storage } from './storage';
import type { PlatformMetricType } from '@shared/schema';
import { fetchPlatformVolumeFromDrift, fetchPlatformTVLFromDrift } from './drift-data-api';

const RECALC_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

export interface PlatformMetricsSnapshot {
  tvl: number;
  totalVolume: number;
  volume24h: number;
  volume7d: number;
  activeBots: number;
  activeUsers: number;
  totalTrades: number;
  lastUpdated: Date;
}

let cachedMetrics: PlatformMetricsSnapshot | null = null;
let indexerInterval: NodeJS.Timeout | null = null;

async function seedCumulativeLedger(): Promise<void> {
  try {
    const [volumeData, statsData, prevMetrics, agentWallets] = await Promise.all([
      storage.calculatePlatformVolume(),
      storage.calculatePlatformStats(),
      storage.getLatestPlatformMetrics(),
      storage.getAllAgentWalletAddresses(),
    ]);

    const prevMap = new Map(prevMetrics.map(m => [m.metricType, parseFloat(m.value)]));
    const prevVolume = prevMap.get('total_volume') || 0;
    const prevTrades = prevMap.get('total_trades') || 0;

    let driftVolume = 0;
    if (agentWallets.length > 0) {
      try {
        const driftData = await fetchPlatformVolumeFromDrift(agentWallets);
        driftVolume = driftData.totalVolume;
      } catch {}
    }

    const bestVolume = Math.max(volumeData.total, prevVolume, driftVolume);
    const bestTrades = Math.max(statsData.totalTrades, prevTrades);

    await storage.seedCumulativeStats(bestVolume, bestTrades);
    console.log(`[Analytics] Cumulative ledger seeded: volume=$${bestVolume.toFixed(2)}, trades=${bestTrades}`);
  } catch (err) {
    console.error('[Analytics] Failed to seed cumulative ledger:', err);
  }
}

export async function calculateAndStoreMetrics(): Promise<PlatformMetricsSnapshot> {
  try {
    console.log('[Analytics] Calculating platform metrics...');
    const startTime = Date.now();
    
    const [tvl, volumeData, statsData, agentWallets, cumulativeStats] = await Promise.all([
      storage.calculatePlatformTVL(),
      storage.calculatePlatformVolume(),
      storage.calculatePlatformStats(),
      storage.getAllAgentWalletAddresses(),
      storage.getCumulativeStats(),
    ]);
    
    let totalVolumeFromDrift = volumeData.total;
    let driftTVLSuccess = false;
    let driftTVLValue = 0;
    
    if (agentWallets.length > 0) {
      try {
        const [volumeDriftData, tvlDriftData] = await Promise.all([
          fetchPlatformVolumeFromDrift(agentWallets),
          fetchPlatformTVLFromDrift(agentWallets),
        ]);
        
        if (volumeDriftData.totalVolume > 0) {
          const localVolume = totalVolumeFromDrift;
          totalVolumeFromDrift = Math.max(totalVolumeFromDrift, volumeDriftData.totalVolume);
          console.log(`[Analytics] Drift API volume: $${volumeDriftData.totalVolume.toFixed(2)}, Local volume: $${localVolume.toFixed(2)}, Using: $${totalVolumeFromDrift.toFixed(2)}`);
        }
        
        if (tvlDriftData.walletData.length > 0) {
          driftTVLSuccess = true;
          driftTVLValue = tvlDriftData.totalTVL;
          console.log(`[Analytics] Fetched real TVL from Drift API: $${tvlDriftData.totalTVL.toFixed(2)} (${tvlDriftData.walletData.length} wallets)`);
        } else {
          console.warn('[Analytics] Drift TVL API returned no valid wallet data, using local fallback');
        }
      } catch (driftError) {
        console.warn('[Analytics] Failed to fetch Drift API data, using local data:', driftError);
      }
    }

    const finalTVL = driftTVLSuccess ? driftTVLValue : tvl;

    let finalVolume = totalVolumeFromDrift;
    let finalTrades = statsData.totalTrades;

    if (cumulativeStats) {
      const ledgerVolume = parseFloat(cumulativeStats.totalVolume);
      const ledgerTrades = cumulativeStats.totalTrades;
      if (ledgerVolume > finalVolume) {
        console.log(`[Analytics] Cumulative ledger volume applied: $${ledgerVolume.toFixed(2)} (calculated was $${finalVolume.toFixed(2)})`);
        finalVolume = ledgerVolume;
      }
      if (ledgerTrades > finalTrades) {
        console.log(`[Analytics] Cumulative ledger trades applied: ${ledgerTrades} (calculated was ${finalTrades})`);
        finalTrades = ledgerTrades;
      }
    }

    try {
      const prevMetrics = await storage.getLatestPlatformMetrics();
      const prevMap = new Map(prevMetrics.map(m => [m.metricType, parseFloat(m.value)]));
      const prevVolume = prevMap.get('total_volume') || 0;
      const prevTrades = prevMap.get('total_trades') || 0;
      if (prevVolume > finalVolume) {
        console.log(`[Analytics] High-water mark (DB) volume applied: $${prevVolume.toFixed(2)} (new was $${finalVolume.toFixed(2)})`);
        finalVolume = prevVolume;
      }
      if (prevTrades > finalTrades) {
        console.log(`[Analytics] High-water mark (DB) trades applied: ${prevTrades} (new was ${finalTrades})`);
        finalTrades = prevTrades;
      }
    } catch {}

    const metrics: PlatformMetricsSnapshot = {
      tvl: finalTVL,
      totalVolume: finalVolume,
      volume24h: volumeData.volume24h,
      volume7d: volumeData.volume7d,
      activeBots: statsData.activeBots,
      activeUsers: statsData.activeUsers,
      totalTrades: finalTrades,
      lastUpdated: new Date(),
    };
    
    await Promise.all([
      storage.upsertPlatformMetric('tvl' as PlatformMetricType, metrics.tvl),
      storage.upsertPlatformMetric('total_volume' as PlatformMetricType, metrics.totalVolume),
      storage.upsertPlatformMetric('volume_24h' as PlatformMetricType, metrics.volume24h),
      storage.upsertPlatformMetric('volume_7d' as PlatformMetricType, metrics.volume7d),
      storage.upsertPlatformMetric('active_bots' as PlatformMetricType, metrics.activeBots),
      storage.upsertPlatformMetric('active_users' as PlatformMetricType, metrics.activeUsers),
      storage.upsertPlatformMetric('total_trades' as PlatformMetricType, metrics.totalTrades),
    ]);

    storage.seedCumulativeStats(finalVolume, finalTrades).catch(err => {
      console.error('[Analytics] Failed to update cumulative ledger:', err);
    });
    
    cachedMetrics = metrics;
    
    const duration = Date.now() - startTime;
    console.log(`[Analytics] Metrics calculated in ${duration}ms:`, {
      tvl: `$${metrics.tvl.toLocaleString()}`,
      totalVolume: `$${metrics.totalVolume.toLocaleString()}`,
      volume24h: `$${metrics.volume24h.toLocaleString()}`,
      activeBots: metrics.activeBots,
      activeUsers: metrics.activeUsers,
      totalTrades: metrics.totalTrades,
    });
    
    return metrics;
  } catch (error) {
    console.error('[Analytics] Error calculating metrics:', error);
    throw error;
  }
}

export function getCachedMetrics(): PlatformMetricsSnapshot | null {
  return cachedMetrics;
}

export async function getMetrics(): Promise<PlatformMetricsSnapshot> {
  if (cachedMetrics && (Date.now() - cachedMetrics.lastUpdated.getTime()) < RECALC_INTERVAL_MS) {
    return cachedMetrics;
  }
  
  const dbMetrics = await storage.getLatestPlatformMetrics();
  
  if (dbMetrics.length > 0) {
    const metricsMap = new Map(dbMetrics.map(m => [m.metricType, parseFloat(m.value)]));
    const latestCalcTime = dbMetrics[0]?.calculatedAt;
    
    if (latestCalcTime && (Date.now() - latestCalcTime.getTime()) < RECALC_INTERVAL_MS) {
      cachedMetrics = {
        tvl: metricsMap.get('tvl') || 0,
        totalVolume: metricsMap.get('total_volume') || 0,
        volume24h: metricsMap.get('volume_24h') || 0,
        volume7d: metricsMap.get('volume_7d') || 0,
        activeBots: metricsMap.get('active_bots') || 0,
        activeUsers: metricsMap.get('active_users') || 0,
        totalTrades: metricsMap.get('total_trades') || 0,
        lastUpdated: latestCalcTime,
      };
      return cachedMetrics;
    }
  }
  
  return calculateAndStoreMetrics();
}

export function startAnalyticsIndexer(): void {
  if (indexerInterval) {
    console.log('[Analytics] Indexer already running');
    return;
  }
  
  console.log(`[Analytics] Starting analytics indexer (every 2 hours)`);
  
  seedCumulativeLedger().then(() => {
    calculateAndStoreMetrics().catch(err => {
      console.error('[Analytics] Initial metrics calculation failed:', err);
    });
  }).catch(err => {
    console.error('[Analytics] Cumulative ledger seed failed:', err);
    calculateAndStoreMetrics().catch(err2 => {
      console.error('[Analytics] Initial metrics calculation failed:', err2);
    });
  });
  
  indexerInterval = setInterval(() => {
    calculateAndStoreMetrics().catch(err => {
      console.error('[Analytics] Scheduled metrics calculation failed:', err);
    });
  }, RECALC_INTERVAL_MS);
}

export function stopAnalyticsIndexer(): void {
  if (indexerInterval) {
    clearInterval(indexerInterval);
    indexerInterval = null;
    console.log('[Analytics] Indexer stopped');
  }
}
