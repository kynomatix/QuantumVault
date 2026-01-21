import { storage } from './storage';
import type { PlatformMetricType } from '@shared/schema';

const INDEXER_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

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

export async function calculateAndStoreMetrics(): Promise<PlatformMetricsSnapshot> {
  try {
    console.log('[Analytics] Calculating platform metrics...');
    const startTime = Date.now();
    
    const [tvl, volumeData, statsData] = await Promise.all([
      storage.calculatePlatformTVL(),
      storage.calculatePlatformVolume(),
      storage.calculatePlatformStats(),
    ]);
    
    const metrics: PlatformMetricsSnapshot = {
      tvl,
      totalVolume: volumeData.total,
      volume24h: volumeData.volume24h,
      volume7d: volumeData.volume7d,
      activeBots: statsData.activeBots,
      activeUsers: statsData.activeUsers,
      totalTrades: statsData.totalTrades,
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
  if (cachedMetrics && (Date.now() - cachedMetrics.lastUpdated.getTime()) < INDEXER_INTERVAL_MS) {
    return cachedMetrics;
  }
  
  const dbMetrics = await storage.getLatestPlatformMetrics();
  
  if (dbMetrics.length > 0) {
    const metricsMap = new Map(dbMetrics.map(m => [m.metricType, parseFloat(m.value)]));
    const latestCalcTime = dbMetrics[0]?.calculatedAt;
    
    if (latestCalcTime && (Date.now() - latestCalcTime.getTime()) < INDEXER_INTERVAL_MS) {
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
  
  console.log('[Analytics] Starting analytics indexer (interval: 5 minutes)');
  
  calculateAndStoreMetrics().catch(err => {
    console.error('[Analytics] Initial metrics calculation failed:', err);
  });
  
  indexerInterval = setInterval(() => {
    calculateAndStoreMetrics().catch(err => {
      console.error('[Analytics] Scheduled metrics calculation failed:', err);
    });
  }, INDEXER_INTERVAL_MS);
}

export function stopAnalyticsIndexer(): void {
  if (indexerInterval) {
    clearInterval(indexerInterval);
    indexerInterval = null;
    console.log('[Analytics] Indexer stopped');
  }
}
