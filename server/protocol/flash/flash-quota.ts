/**
 * Flash RPC budget manager (Helius rate-limit plane).
 *
 * Flash is on-chain, so the scarce resource is NOT a REST credit budget (as on
 * Pacifica) but Solana RPC throughput. On Helius this is rate-limited per second
 * and metered in monthly credits, and `getProgramAccounts` / large
 * `getMultipleAccounts` scans are far heavier than a single `getAccountInfo`.
 *
 * This is the symmetric counterpart to `pacifica-quota.ts`: a sliding-window
 * weighted-cost tracker that lets read paths ask "can I afford this?" before
 * firing, reserves headroom so write/urgent paths never starve, and records
 * actual spend for accurate accounting. Per the repo memory & RPC rules,
 * callers should prefer WS account subscriptions (`flash-ws.ts`) and the bounded
 * caches (`flash-cache.ts`) over polling whenever possible; this plane is the
 * backstop for the reads that remain.
 */

const WINDOW_MS = 1_000;
// Conservative per-second request budget. Helius shared/dev plans sit around
// 50 RPS; we keep a margin and reserve headroom for write/urgent calls.
const TOTAL_BUDGET = 50;
const RESERVED_HEADROOM = 10;
const NORMAL_BUDGET = TOTAL_BUDGET - RESERVED_HEADROOM;

export type RpcPriority = 'critical' | 'normal' | 'background';

/**
 * Relative weights per RPC method. `getProgramAccounts` is the most expensive
 * (full-program scan); multi-account reads cost more than a single account.
 * These are conservative estimates — tune against observed Helius credit usage.
 */
const METHOD_COSTS: Record<string, number> = {
  getProgramAccounts: 10,
  getMultipleAccounts: 3,
  getAccountInfo: 1,
  getBalance: 1,
  getTokenAccountBalance: 1,
  getTokenAccountsByOwner: 2,
  getLatestBlockhash: 1,
  sendTransaction: 1,
  sendRawTransaction: 1,
  simulateTransaction: 2,
  getSignatureStatuses: 1,
  getSlot: 1,
};

const DEFAULT_COST = 1;

interface SpendEntry {
  timestamp: number;
  credits: number;
  method: string;
}

class FlashRpcQuota {
  private spends: SpendEntry[] = [];
  private rejected = 0;
  private served = 0;

  estimateCost(method: string): number {
    return METHOD_COSTS[method] ?? DEFAULT_COST;
  }

  /**
   * True if a call of `method` fits the budget for the given priority.
   *   - critical:   full TOTAL_BUDGET (writes / urgent reconciliation)
   *   - normal:     NORMAL_BUDGET (reserves headroom for critical)
   *   - background: 60% of NORMAL_BUDGET (sweeps / cron)
   */
  canAfford(method: string, priority: RpcPriority = 'normal'): boolean {
    this.evictOld();
    const cost = this.estimateCost(method);
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

  /** Milliseconds until the oldest in-window spend frees its credits. */
  msUntilNextRefund(): number {
    this.evictOld();
    if (this.spends.length === 0) return 0;
    const oldestExpiresAt = this.spends[0].timestamp + WINDOW_MS;
    return Math.max(0, oldestExpiresAt - Date.now());
  }

  /** Record an actual spend. Call AFTER the RPC returns (success or failure). */
  record(method: string, actualCost?: number): void {
    const cost = actualCost ?? this.estimateCost(method);
    this.spends.push({ timestamp: Date.now(), credits: cost, method });
    this.served += 1;
  }

  noteRejection(): void {
    this.rejected += 1;
  }

  currentSpend(): number {
    this.evictOld();
    return this.spends.reduce((sum, e) => sum + e.credits, 0);
  }

  snapshot(): {
    creditsUsed: number;
    creditsRemaining: number;
    totalBudget: number;
    normalBudget: number;
    requestsServed: number;
    requestsRejected: number;
    topMethods: Array<{ method: string; credits: number; calls: number }>;
  } {
    this.evictOld();
    const used = this.currentSpend();

    const byMethod = new Map<string, { credits: number; calls: number }>();
    for (const e of this.spends) {
      const cur = byMethod.get(e.method) ?? { credits: 0, calls: 0 };
      cur.credits += e.credits;
      cur.calls += 1;
      byMethod.set(e.method, cur);
    }
    const topMethods = Array.from(byMethod.entries())
      .map(([method, v]) => ({ method, ...v }))
      .sort((a, b) => b.credits - a.credits)
      .slice(0, 5);

    return {
      creditsUsed: used,
      creditsRemaining: Math.max(0, TOTAL_BUDGET - used),
      totalBudget: TOTAL_BUDGET,
      normalBudget: NORMAL_BUDGET,
      requestsServed: this.served,
      requestsRejected: this.rejected,
      topMethods,
    };
  }

  resetCounters(): void {
    this.served = 0;
    this.rejected = 0;
  }

  private evictOld(): void {
    const cutoff = Date.now() - WINDOW_MS;
    let i = 0;
    while (i < this.spends.length && this.spends[i].timestamp < cutoff) i += 1;
    if (i > 0) this.spends.splice(0, i);
  }
}

export class RpcQuotaExhaustedError extends Error {
  constructor(public readonly method: string, public readonly creditsUsed: number) {
    super(
      `FlashAdapter RPC quota exhausted: ${creditsUsed}/${TOTAL_BUDGET} credits in last ` +
      `${WINDOW_MS}ms, cannot afford ${method}`,
    );
    this.name = 'RpcQuotaExhaustedError';
  }
}

// Module-level singleton: RPC throughput is a per-process resource.
export const flashRpcQuota = new FlashRpcQuota();
