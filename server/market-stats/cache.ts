/** Fixed card keys, one promise per key. Neither failures nor followers renew observation times. */
export class MarketStatsCache {
  private values = new Map<string, { value: unknown; readAt: number; expiresAt: number }>();
  private jobs = new Map<string, Promise<unknown>>();
  async read<T>(key: string, now: number, load: () => Promise<T>, expiry: (value: T) => number): Promise<T> {
    const cached = this.values.get(key);
    if (cached && now >= cached.readAt && now < cached.expiresAt) return cached.value as T;
    const existing = this.jobs.get(key);
    if (existing) return existing as Promise<T>;
    const job = Promise.resolve().then(load).then(value => {
      this.values.set(key, { value, readAt: now, expiresAt: expiry(value) });
      return value;
    }).finally(() => { this.jobs.delete(key); });
    this.jobs.set(key, job);
    return job;
  }
}
