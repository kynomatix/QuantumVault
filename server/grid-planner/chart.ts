import type { PlannerChart, PlannerDeps } from './types';

const TTL: Record<string, number> = { '15m': 60_000, '1h': 120_000, '4h': 300_000 };
export function validateCandles(candles: Awaited<ReturnType<PlannerDeps['candles']>>, now: number): boolean {
  return candles.length > 0 && candles.every((c, i) => Number.isSafeInteger(c.time) && c.time > 0 && c.time <= now
    && (i === 0 || c.time > candles[i - 1].time)
    && [c.open, c.high, c.low, c.close].every(n => Number.isFinite(n) && n > 0)
    && c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close) && c.high >= c.low
    && c.provenance?.source === 'okx' && c.provenance.venue === 'okx' && c.provenance.basis === 'perp'
    && c.provenance.proxy === 'direct' && c.provenance.timeSemantic === 'open_time'
    && ['finalized', 'forming'].includes(c.provenance.finality));
}

/** Bounded shared work; there is no queue and failures never reset admission history. */
export class PlannerCharts {
  private cache = new Map<string, Extract<PlannerChart, { state: 'available' }>>();
  private jobs = new Map<string, { promise: Promise<PlannerChart>; controller: AbortController; users: number }>();
  private starts: number[] = [];
  private waiting = 0;
  constructor(private deps: PlannerDeps) {}
  async read(market: string, timeframe: string, bars: number, signal: AbortSignal): Promise<PlannerChart> {
    const key = `${market}:${timeframe}:${bars}`, now = this.deps.now(), cached = this.cache.get(key);
    if (cached && now >= cached.retrievedAt && now < cached.retrievedAt + TTL[timeframe]) {
      this.cache.delete(key); this.cache.set(key, cached);
      return { ...cached, validForMs: cached.retrievedAt + TTL[timeframe] - now };
    }
    if (signal.aborted) return { state: 'unavailable', reason: 'Request cancelled' };
    let job = this.jobs.get(key);
    this.starts = this.starts.filter(time => now - time < 60_000);
    if (this.waiting >= 8 || !job && (this.jobs.size >= 2 || this.starts.length >= 12))
      return { state: 'unavailable', reason: 'Planner chart is busy; refresh later' };
    if (!job) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const created = { controller, users: 0, promise: Promise.resolve<PlannerChart>({ state: 'unavailable', reason: 'Not started' }) };
      this.starts.push(now); this.jobs.set(key, created);
      created.promise = Promise.resolve().then(() => this.deps.candles(market, timeframe, bars, controller.signal)).then(raw => {
        const retrievedAt = this.deps.now(), candles = raw.slice(-bars);
        if (controller.signal.aborted) return { state: 'unavailable' as const, reason: 'Chart deadline or cancellation' };
        if (!validateCandles(candles, retrievedAt)) return { state: 'unavailable' as const, reason: 'Direct perpetual candles or provenance unavailable' };
        const response: Extract<PlannerChart, { state: 'available' }> = { state: 'available', market, timeframe, requestedBars: bars,
          actualBars: candles.length, partial: candles.length < bars, retrievedAt, cacheInsertedAt: retrievedAt,
          validForMs: TTL[timeframe], candles };
        this.cache.delete(key); this.cache.set(key, response);
        if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
        return response;
      }).catch(() => ({ state: 'unavailable' as const, reason: 'Chart source unavailable' }))
        .finally(() => { clearTimeout(timer); this.jobs.delete(key); });
      job = created;
    }
    this.waiting++; job.users++;
    const owned = job;
    return new Promise(resolve => {
      let settled = false;
      const finish = (value: PlannerChart) => {
        if (settled) return; settled = true; this.waiting--; owned.users--;
        signal.removeEventListener('abort', abort); clearTimeout(deadline);
        if (!owned.users) owned.controller.abort();
        resolve(value);
      };
      const abort = () => finish({ state: 'unavailable', reason: 'Request cancelled' });
      const deadline = setTimeout(() => finish({ state: 'unavailable', reason: 'Chart deadline exceeded' }), 15_000);
      signal.addEventListener('abort', abort, { once: true });
      owned.promise.then(finish);
    });
  }
}
