import type { GridSqueeze } from '../../shared/grid-squeeze';
import type { PlannerCandle, PlannerDeps } from './types';
import { validateCandles } from './chart';

const DAY = 86_400_000;
export function squeezeWindow(now: number) {
  const end = Math.floor(now / DAY) * DAY, at = end - DAY, date = new Date(at);
  // Match the research's UTC calendar-month subtraction, including leap-day rollover.
  const begin = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 12, date.getUTCDate());
  const start = begin - 19 * DAY;
  return { start, end, at, begin, bars: (end - start) / DAY };
}

/** 20 daily closes, population SD, (upper-lower)/mean for 2-SD bands.
 * Compare the latest fully closed day with every prior daily bandwidth in the
 * previous 12 calendar months, excluding that day's bandwidth. Strict-less rank
 * and percentile < 0.2 deliberately match grid-long-adx/core.mjs (ties included).
 */
export function dailySqueeze(market: string, raw: PlannerCandle[], now: number): GridSqueeze {
  const unavailable = (reason: string): GridSqueeze => ({ state: 'unavailable', reason });
  if (!Number.isSafeInteger(now) || now <= 0) return unavailable('Invalid observation time.');
  const { start, end, at, bars } = squeezeWindow(now);
  // Cut off forming/future days before doing any arithmetic; never use a partial close.
  const candles = raw.filter(c => c.time >= start && c.time < end);
  if (candles.length !== bars || !validateCandles(candles, now) || candles.some((c, i) =>
    c.time !== start + i * DAY || c.provenance.finality !== 'finalized'
    || !Number.isFinite(c.volume) || c.volume < 0))
    return unavailable('Complete finalized daily history for the previous 12 months and 20-day warmup is unavailable.');
  const widths: number[] = [];
  for (let i = 19; i < candles.length; i++) {
    const closes = candles.slice(i - 19, i + 1).map(c => c.close);
    const mean = closes.reduce((sum, close) => sum + close, 0) / 20;
    const variance = closes.reduce((sum, close) => sum + (close - mean) ** 2, 0) / 20;
    const width = 4 * Math.sqrt(variance) / mean;
    if (!Number.isFinite(width)) return unavailable('Daily bandwidth is unavailable.');
    widths.push(width);
  }
  const bandwidth = widths.pop()!, historyDays = widths.length;
  const percentile = widths.filter(width => width < bandwidth).length / historyDays;
  return { state: 'available', market, squeezed: percentile < 0.2, bandwidth, percentile,
    historyDays, latestFinalizedTime: at, retrievedAt: now, validForMs: Math.min(300_000, end + DAY - now) };
}

/** Bounded, read-only work through the same finalized candle pool as range facts. */
export class PlannerSqueeze {
  private active = 0;
  private starts: number[] = [];
  private cache = new Map<string, { result: GridSqueeze; observedAt: number; expiresAt: number }>();
  async read(market: string, deps: PlannerDeps, signal: AbortSignal): Promise<GridSqueeze> {
    const now = deps.now(), cached = this.cache.get(market);
    const unavailable = (reason: string): GridSqueeze => ({ state: 'unavailable', reason });
    if (signal.aborted) return unavailable('Request cancelled.');
    if (cached && now >= cached.observedAt && now < cached.expiresAt)
      return cached.result.state === 'available' ? { ...cached.result, validForMs: cached.expiresAt - now } : cached.result;
    if (!deps.rangeCandles) return unavailable('Daily candle reader unavailable.');
    this.starts = this.starts.filter(t => now - t < 60_000);
    if (this.active >= 2 || this.starts.length >= 12) return unavailable('Squeeze advisory is busy; refresh later.');
    this.active++; this.starts.push(now);
    const controller = new AbortController(), abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 30_000);
    let rejectAbort: () => void = () => {};
    try {
      const cancelled = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(new Error('cancelled'));
        controller.signal.addEventListener('abort', rejectAbort, { once: true });
      });
      const raw = await Promise.race([deps.rangeCandles(market, '1d', squeezeWindow(now).bars, controller.signal), cancelled]);
      controller.signal.throwIfAborted();
      const retrievedAt = deps.now();
      const result = dailySqueeze(market, raw, retrievedAt);
      const expiresAt = result.state === 'available' ? retrievedAt + result.validForMs : retrievedAt + 60_000;
      this.cache.delete(market); this.cache.set(market, { result, observedAt: retrievedAt, expiresAt });
      if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
      return result;
    } catch { return unavailable('Finalized daily candles are temporarily unavailable.'); }
    finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', rejectAbort); this.active--;
    }
  }
}
