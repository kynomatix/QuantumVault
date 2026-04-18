/**
 * Pacifica credit budget manager.
 *
 * Pacifica enforces a 300-credit / 60-second rolling-window quota per master
 * account, shared across the main account and ALL its subaccounts. Heavy GETs
 * cost more credits than light ones. Exceeding the budget returns HTTP 429.
 *
 * This module implements a sliding-window credit tracker that:
 *   - Estimates per-endpoint credit cost
 *   - Reserves a safety headroom so writes (orders/cancels) never starve
 *   - Exposes a "can I afford this?" check that callers consult before fetching
 *   - Records actual spend after every call for accurate window accounting
 *
 * Reference: docs/PACIFICA_MIGRATION.md §19 (Risk Assessment, line ~3297)
 */

const WINDOW_MS = 60_000;
const TOTAL_BUDGET = 300;
const RESERVED_HEADROOM = 30; // 10% reserved for write-path / urgent calls
const NORMAL_BUDGET = TOTAL_BUDGET - RESERVED_HEADROOM; // 270 credits/min

export type RequestPriority = 'critical' | 'normal' | 'background';

/**
 * Estimated credit cost per endpoint. Pacifica does not publish the exact
 * weights — these are conservative-but-not-paranoid estimates derived from
 * empirical observation: at ~84 GETs/min we hit the 300/60s ceiling, so the
 * average cost is ~3.5 credits/call. Heavy account-data endpoints get a
 * slight premium; light static reads get a discount. Tune as we observe.
 */
const ENDPOINT_COSTS: Record<string, number> = {
  '/account': 3,
  '/positions': 3,
  '/account/trades': 3,
  '/account/equity_history': 3,
  '/account/funding/history': 3,
  '/account/orders': 2,
  '/account/orders/history': 3,
  '/account/orders/stop': 2,
  '/info': 2,
  '/book': 1,
  '/funding': 1,
  '/funding_history': 2,
  '/kline': 2,
  '/agent/bind': 1,
};

const DEFAULT_COST = 2;

interface CreditEntry {
  timestamp: number;
  credits: number;
  path: string;
}

class PacificaQuota {
  private spends: CreditEntry[] = [];
  private rejected = 0;
  private served = 0;

  /**
   * Estimate the credit cost for a given REST path.
   * Strips query string before lookup.
   */
  estimateCost(path: string): number {
    const cleanPath = path.split('?')[0];
    return ENDPOINT_COSTS[cleanPath] ?? DEFAULT_COST;
  }

  /**
   * Returns true if the request can proceed within budget for the given priority.
   *   - critical: may use full TOTAL_BUDGET (writes / urgent reconciliation)
   *   - normal:   may use NORMAL_BUDGET (reserves headroom for critical)
   *   - background: may only use up to 60% of NORMAL_BUDGET (cron jobs, sweeps)
   */
  canAfford(path: string, priority: RequestPriority = 'normal'): boolean {
    this.evictOld();
    const cost = this.estimateCost(path);
    const used = this.currentSpend();

    let cap: number;
    switch (priority) {
      case 'critical':
        cap = TOTAL_BUDGET;
        break;
      case 'normal':
        cap = NORMAL_BUDGET;
        break;
      case 'background':
        cap = Math.floor(NORMAL_BUDGET * 0.6);
        break;
    }

    return used + cost <= cap;
  }

  /**
   * Returns the number of milliseconds until the oldest in-window spend
   * expires (and frees its credits). Used by callers that want to back off
   * briefly instead of failing immediately when budget is depleted.
   *
   * Returns 0 if no spends are tracked.
   */
  msUntilNextRefund(): number {
    this.evictOld();
    if (this.spends.length === 0) return 0;
    const oldestExpiresAt = this.spends[0].timestamp + WINDOW_MS;
    return Math.max(0, oldestExpiresAt - Date.now());
  }

  /**
   * Record an actual spend. Call this AFTER the fetch returns (success or fail),
   * since Pacifica counts the request regardless of HTTP status.
   */
  record(path: string, actualCost?: number): void {
    const cost = actualCost ?? this.estimateCost(path);
    this.spends.push({ timestamp: Date.now(), credits: cost, path });
    this.served += 1;
  }

  /**
   * Note that a request was rejected by quota (caller chose not to send).
   * Used purely for telemetry.
   */
  noteRejection(): void {
    this.rejected += 1;
  }

  /**
   * Sum of credits spent in the last 60 seconds.
   */
  currentSpend(): number {
    this.evictOld();
    return this.spends.reduce((sum, e) => sum + e.credits, 0);
  }

  /**
   * Snapshot for telemetry / health endpoints.
   */
  snapshot(): {
    creditsUsed: number;
    creditsRemaining: number;
    totalBudget: number;
    normalBudget: number;
    requestsServed: number;
    requestsRejected: number;
    topEndpoints: Array<{ path: string; credits: number; calls: number }>;
  } {
    this.evictOld();
    const used = this.currentSpend();

    const byPath = new Map<string, { credits: number; calls: number }>();
    for (const e of this.spends) {
      const cur = byPath.get(e.path) ?? { credits: 0, calls: 0 };
      cur.credits += e.credits;
      cur.calls += 1;
      byPath.set(e.path, cur);
    }
    const topEndpoints = Array.from(byPath.entries())
      .map(([path, v]) => ({ path, ...v }))
      .sort((a, b) => b.credits - a.credits)
      .slice(0, 5);

    return {
      creditsUsed: used,
      creditsRemaining: Math.max(0, TOTAL_BUDGET - used),
      totalBudget: TOTAL_BUDGET,
      normalBudget: NORMAL_BUDGET,
      requestsServed: this.served,
      requestsRejected: this.rejected,
      topEndpoints,
    };
  }

  /**
   * Reset rolling counters (used between telemetry log emissions if desired).
   * Does NOT clear the sliding window itself.
   */
  resetCounters(): void {
    this.served = 0;
    this.rejected = 0;
  }

  private evictOld(): void {
    const cutoff = Date.now() - WINDOW_MS;
    // entries are pushed in time order so a single index scan suffices
    let i = 0;
    while (i < this.spends.length && this.spends[i].timestamp < cutoff) i += 1;
    if (i > 0) this.spends.splice(0, i);
  }
}

export class QuotaExhaustedError extends Error {
  constructor(public readonly path: string, public readonly creditsUsed: number) {
    super(`PacificaAdapter quota exhausted: ${creditsUsed}/${TOTAL_BUDGET} credits used in last 60s, cannot afford ${path}`);
    this.name = 'QuotaExhaustedError';
  }
}

// Module-level singleton: the credit budget is per master account, and the
// adapter itself is a singleton in this codebase.
export const pacificaQuota = new PacificaQuota();
