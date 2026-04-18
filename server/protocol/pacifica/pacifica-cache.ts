/**
 * Pacifica REST response cache + in-flight request deduplication.
 *
 * Two responsibilities:
 *   1. TTL cache — short-lived per-endpoint cache so repeated reads inside the
 *      TTL window return immediately without consuming Pacifica credits.
 *   2. In-flight dedup — when N concurrent callers request the same key
 *      simultaneously (cache miss / expired), only one upstream fetch is
 *      issued and all callers await the same Promise. Eliminates the cache-
 *      stampede problem that otherwise burns through the credit budget.
 *
 * The cache is keyed by `path + sorted(params)` so different subaccount
 * queries cache separately. This is critical for tenant isolation across
 * wallets / subaccounts.
 *
 * Design note: this cache is intentionally per-process and in-memory. The
 * codebase runs as a single Node process; if we ever scale horizontally
 * we'll need a shared cache (e.g. Redis) — that is Phase C work, not this PR.
 */

interface CacheEntry {
  data: any;
  fetchedAt: number;
  expiresAt: number;
}

/**
 * TTL configuration per endpoint, in milliseconds.
 *
 * Trade-off rationale (per user discussion 2026-04-18):
 *   - Platform is mostly automated (bots), not manual day-trading
 *   - 5–15s staleness is acceptable for UI displays
 *   - Trading decisions read fresh prices from /book independently
 *   - /info already cached 5min by market-registry.ts
 *   - /funding rates change hourly, so 5min is generous
 */
const ENDPOINT_TTL_MS: Record<string, number> = {
  '/account': 15_000,
  '/positions': 10_000,
  '/account/trades': 30_000,
  '/account/orders': 5_000,
  '/account/orders/stop': 5_000,
  '/account/orders/history': 30_000,
  '/account/equity_history': 60_000,
  '/account/funding/history': 60_000,
  '/info': 300_000,
  '/funding': 300_000,
  '/funding_history': 60_000,
  '/book': 5_000,
  '/kline': 30_000,
};

const DEFAULT_TTL_MS = 10_000;

/**
 * Endpoints whose responses must NEVER be cached:
 *   - Order placement / cancellation acks (POST)
 *   - Agent registration
 *   - Deposit/withdraw confirmations
 *
 * These are write paths and are not routed through this cache anyway, but the
 * list is documented here for clarity.
 */

class PacificaCache {
  private store = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<any>>();

  private hits = 0;
  private misses = 0;
  private dedupedJoins = 0;

  ttlFor(path: string): number {
    const cleanPath = path.split('?')[0];
    return ENDPOINT_TTL_MS[cleanPath] ?? DEFAULT_TTL_MS;
  }

  buildKey(path: string, params?: Record<string, string>): string {
    if (!params || Object.keys(params).length === 0) return path;
    const sorted = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
    return `${path}?${sorted}`;
  }

  /**
   * Read a fresh entry. Returns undefined if missing or expired.
   */
  getFresh(key: string): any | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    this.hits += 1;
    return entry.data;
  }

  /**
   * Read a stale entry regardless of expiry. Used as a graceful fallback when
   * upstream is rate-limited. Returns undefined only if the key was never seen.
   */
  getStale(key: string): { data: any; ageMs: number } | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    return { data: entry.data, ageMs: Date.now() - entry.fetchedAt };
  }

  set(key: string, path: string, data: any): void {
    const ttl = this.ttlFor(path);
    this.store.set(key, {
      data,
      fetchedAt: Date.now(),
      expiresAt: Date.now() + ttl,
    });
  }

  noteMiss(): void {
    this.misses += 1;
  }

  /**
   * In-flight dedup. If a fetch for `key` is already running, returns its
   * Promise so all concurrent callers share one upstream request. Otherwise
   * registers `producer()` as the in-flight fetch and returns its Promise.
   *
   * Cleans up the registration when the producer settles, regardless of
   * outcome (success or failure), so a transient error does not leave a
   * permanently-pending entry.
   */
  async dedup<T>(key: string, producer: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) {
      this.dedupedJoins += 1;
      return existing as Promise<T>;
    }
    const promise = producer().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  invalidate(pathPrefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(pathPrefix)) this.store.delete(key);
    }
  }

  invalidateAll(): void {
    this.store.clear();
  }

  snapshot(): {
    entries: number;
    inflight: number;
    hits: number;
    misses: number;
    dedupedJoins: number;
    hitRatePct: number;
  } {
    const total = this.hits + this.misses;
    return {
      entries: this.store.size,
      inflight: this.inflight.size,
      hits: this.hits,
      misses: this.misses,
      dedupedJoins: this.dedupedJoins,
      hitRatePct: total > 0 ? Math.round((this.hits / total) * 100) : 0,
    };
  }

  resetCounters(): void {
    this.hits = 0;
    this.misses = 0;
    this.dedupedJoins = 0;
  }
}

export const pacificaCache = new PacificaCache();
