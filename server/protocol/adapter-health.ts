interface OperationMetrics {
  totalAttempts: number;
  successCount: number;
  failureCount: number;
  fallbackCount: number;
  totalLatencyMs: number;
}

export interface HealthSnapshot {
  totalAttempts: number;
  successCount: number;
  failureCount: number;
  fallbackCount: number;
  successRate: string;
  avgLatencyMs: number;
  avgPriceImprovementBps: string;
  errorDistribution: Record<string, number>;
  perOperation: Record<string, {
    totalAttempts: number;
    successCount: number;
    failureCount: number;
    fallbackCount: number;
    avgLatencyMs: number;
    successRate: string;
  }>;
  uptimeSinceReset: string;
  lastResetAt: string;
}

export class AdapterHealthTracker {
  private totalAttempts = 0;
  private successCount = 0;
  private failureCount = 0;
  private fallbackCount = 0;
  private totalLatencyMs = 0;
  private totalPriceImprovementBps = 0;
  private priceImprovementCount = 0;
  private perOperation = new Map<string, OperationMetrics>();
  private errorDistribution = new Map<string, number>();
  private lastResetAt = Date.now();

  private getOrCreate(operation: string): OperationMetrics {
    let m = this.perOperation.get(operation);
    if (!m) {
      m = { totalAttempts: 0, successCount: 0, failureCount: 0, fallbackCount: 0, totalLatencyMs: 0 };
      this.perOperation.set(operation, m);
    }
    return m;
  }

  recordAttempt(operation: string): void {
    this.totalAttempts++;
    this.getOrCreate(operation).totalAttempts++;
  }

  recordSuccess(operation: string, latencyMs: number, priceImprovementBps?: number): void {
    this.successCount++;
    this.totalLatencyMs += latencyMs;
    const m = this.getOrCreate(operation);
    m.successCount++;
    m.totalLatencyMs += latencyMs;
    if (priceImprovementBps !== undefined) {
      this.totalPriceImprovementBps += priceImprovementBps;
      this.priceImprovementCount++;
    }
  }

  recordFailure(operation: string, errorType: string): void {
    this.failureCount++;
    this.getOrCreate(operation).failureCount++;
    this.errorDistribution.set(errorType, (this.errorDistribution.get(errorType) || 0) + 1);
  }

  recordFallback(operation: string): void {
    this.fallbackCount++;
    this.getOrCreate(operation).fallbackCount++;
  }

  getSnapshot(): HealthSnapshot {
    const perOperation: HealthSnapshot['perOperation'] = {};
    this.perOperation.forEach((m, op) => {
      perOperation[op] = {
        totalAttempts: m.totalAttempts,
        successCount: m.successCount,
        failureCount: m.failureCount,
        fallbackCount: m.fallbackCount,
        avgLatencyMs: m.successCount > 0 ? Math.round(m.totalLatencyMs / m.successCount) : 0,
        successRate: m.totalAttempts > 0 ? `${((m.successCount / m.totalAttempts) * 100).toFixed(1)}%` : 'N/A',
      };
    });

    const errorDistribution: Record<string, number> = {};
    this.errorDistribution.forEach((count, type) => { errorDistribution[type] = count; });

    return {
      totalAttempts: this.totalAttempts,
      successCount: this.successCount,
      failureCount: this.failureCount,
      fallbackCount: this.fallbackCount,
      successRate: this.totalAttempts > 0 ? `${((this.successCount / this.totalAttempts) * 100).toFixed(1)}%` : 'N/A',
      avgLatencyMs: this.successCount > 0 ? Math.round(this.totalLatencyMs / this.successCount) : 0,
      avgPriceImprovementBps: this.priceImprovementCount > 0
        ? (this.totalPriceImprovementBps / this.priceImprovementCount).toFixed(2)
        : 'N/A',
      errorDistribution,
      perOperation,
      uptimeSinceReset: `${Math.round((Date.now() - this.lastResetAt) / 60000)} minutes`,
      lastResetAt: new Date(this.lastResetAt).toISOString(),
    };
  }

  reset(): void {
    this.totalAttempts = 0;
    this.successCount = 0;
    this.failureCount = 0;
    this.fallbackCount = 0;
    this.totalLatencyMs = 0;
    this.totalPriceImprovementBps = 0;
    this.priceImprovementCount = 0;
    this.perOperation.clear();
    this.errorDistribution.clear();
    this.lastResetAt = Date.now();
  }
}
