interface SwiftMetrics {
  totalOrders: number;
  successCount: number;
  failureCount: number;
  fallbackCount: number;
  totalLatencyMs: number;
  totalPriceImprovementBps: number;
  priceImprovementCount: number;
  perMarket: Map<string, MarketMetrics>;
  errorDistribution: Map<string, number>;
  lastResetAt: number;
}

interface MarketMetrics {
  totalOrders: number;
  successCount: number;
  failureCount: number;
  fallbackCount: number;
  totalLatencyMs: number;
}

const metrics: SwiftMetrics = {
  totalOrders: 0,
  successCount: 0,
  failureCount: 0,
  fallbackCount: 0,
  totalLatencyMs: 0,
  totalPriceImprovementBps: 0,
  priceImprovementCount: 0,
  perMarket: new Map(),
  errorDistribution: new Map(),
  lastResetAt: Date.now(),
};

function getOrCreateMarketMetrics(market: string): MarketMetrics {
  let m = metrics.perMarket.get(market);
  if (!m) {
    m = { totalOrders: 0, successCount: 0, failureCount: 0, fallbackCount: 0, totalLatencyMs: 0 };
    metrics.perMarket.set(market, m);
  }
  return m;
}

export function recordSwiftAttempt(market: string): void {
  metrics.totalOrders++;
  getOrCreateMarketMetrics(market).totalOrders++;
}

export function recordSwiftSuccess(market: string, latencyMs: number, priceImprovementBps?: number): void {
  metrics.successCount++;
  metrics.totalLatencyMs += latencyMs;
  const m = getOrCreateMarketMetrics(market);
  m.successCount++;
  m.totalLatencyMs += latencyMs;
  if (priceImprovementBps !== undefined) {
    metrics.totalPriceImprovementBps += priceImprovementBps;
    metrics.priceImprovementCount++;
  }
}

export function recordSwiftFailure(market: string, errorType: string): void {
  metrics.failureCount++;
  getOrCreateMarketMetrics(market).failureCount++;
  const count = metrics.errorDistribution.get(errorType) || 0;
  metrics.errorDistribution.set(errorType, count + 1);
}

export function recordSwiftFallback(market: string): void {
  metrics.fallbackCount++;
  getOrCreateMarketMetrics(market).fallbackCount++;
}

export function getSwiftMetrics() {
  const perMarket: Record<string, any> = {};
  metrics.perMarket.forEach((m, market) => {
    perMarket[market] = {
      totalOrders: m.totalOrders,
      successCount: m.successCount,
      failureCount: m.failureCount,
      fallbackCount: m.fallbackCount,
      avgLatencyMs: m.successCount > 0 ? Math.round(m.totalLatencyMs / m.successCount) : 0,
      successRate: m.totalOrders > 0 ? `${((m.successCount / m.totalOrders) * 100).toFixed(1)}%` : 'N/A',
    };
  });

  const errorDistribution: Record<string, number> = {};
  metrics.errorDistribution.forEach((count, errorType) => {
    errorDistribution[errorType] = count;
  });

  return {
    summary: {
      totalOrders: metrics.totalOrders,
      successCount: metrics.successCount,
      failureCount: metrics.failureCount,
      fallbackCount: metrics.fallbackCount,
      successRate: metrics.totalOrders > 0 ? `${((metrics.successCount / metrics.totalOrders) * 100).toFixed(1)}%` : 'N/A',
      avgLatencyMs: metrics.successCount > 0 ? Math.round(metrics.totalLatencyMs / metrics.successCount) : 0,
      avgPriceImprovementBps: metrics.priceImprovementCount > 0 ? (metrics.totalPriceImprovementBps / metrics.priceImprovementCount).toFixed(2) : 'N/A',
    },
    perMarket,
    errorDistribution,
    uptimeSinceReset: `${Math.round((Date.now() - metrics.lastResetAt) / 60000)} minutes`,
    lastResetAt: new Date(metrics.lastResetAt).toISOString(),
  };
}

export function resetSwiftMetrics(): void {
  metrics.totalOrders = 0;
  metrics.successCount = 0;
  metrics.failureCount = 0;
  metrics.fallbackCount = 0;
  metrics.totalLatencyMs = 0;
  metrics.totalPriceImprovementBps = 0;
  metrics.priceImprovementCount = 0;
  metrics.perMarket.clear();
  metrics.errorDistribution.clear();
  metrics.lastResetAt = Date.now();
}
