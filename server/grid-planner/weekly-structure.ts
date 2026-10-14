import { btcUtcWeekStart, BTC_TREND_WEEK_MS as WEEK } from '../../shared/grid-direction';
import { WEEKLY_SWING_BASIS, type WeeklyStructure } from '../../shared/grid-signals';
import { PLANNER_CANDLE_SOURCES } from './candle-pool';
import { readPlannerPerpSource } from '../lab/datafeed';
import { pacificaPerpWindow } from './pacifica-candles';
import { validateCandles } from './chart';
import type { PlannerCandle, PlannerDeps } from './types';

export { WEEKLY_SWING_BASIS };
const DAY = WEEK / 7;
export function aggregateStructureWeeks(days: PlannerCandle[], now: number): PlannerCandle[] {
  if (!validateCandles(days, now) || !days.every((c, i) => c.time % DAY === 0 && c.time + DAY <= now
    && c.provenance.finality === 'finalized' && Number.isFinite(c.volume) && c.volume >= 0
    && (!i || c.time === days[i - 1].time + DAY))) return [];
  const byTime = new Map(days.map(c => [c.time, c])), result: PlannerCandle[] = [];
  const start = btcUtcWeekStart(days[0].time) + (days[0].time === btcUtcWeekStart(days[0].time) ? 0 : WEEK);
  for (let time = start; time + WEEK <= now; time += WEEK) {
    const group = Array.from({ length: 7 }, (_, i) => byTime.get(time + i * DAY));
    if (group.some(c => !c)) break;
    const seven = group as PlannerCandle[];
    result.push({ ...seven[0], time, open: seven[0].open, close: seven[6].close, high: Math.max(...seven.map(c => c.high)),
      low: Math.min(...seven.map(c => c.low)), volume: seven.reduce((sum, c) => sum + c.volume, 0) });
  }
  return result;
}

export function computeWeeklyStructure(market: string, weeks: PlannerCandle[], now: number): WeeklyStructure {
  const unknown = (reason: string): WeeklyStructure => ({ state: 'unavailable', reason });
  if (!Number.isSafeInteger(now) || weeks.length < 7 || weeks.length > 52) return unknown('Weekly structure needs 7–52 completed weeks.');
  if (!validateCandles(weeks, now) || !weeks.every((c, i) => c.time === btcUtcWeekStart(c.time)
    && c.time + WEEK <= now && c.provenance.finality === 'finalized' && Number.isFinite(c.volume) && c.volume >= 0
    && (!i || c.time === weeks[i - 1].time + WEEK))) return unknown('Weekly history is invalid, forming, gapped or mixed-basis.');
  const asOf = weeks.at(-1)!.time + WEEK;
  if (asOf !== btcUtcWeekStart(now)) return unknown('Weekly history is missing the latest completed UTC week.');
  const highs: { time: number; price: number }[] = [], lows: { time: number; price: number }[] = [];
  for (let i = 2; i < weeks.length - 2; i++) {
    const other = [weeks[i - 2], weeks[i - 1], weeks[i + 1], weeks[i + 2]], c = weeks[i];
    if (other.every(w => c.high > w.high)) highs.push({ time: c.time, price: c.high });
    if (other.every(w => c.low < w.low)) lows.push({ time: c.time, price: c.low });
  }
  if (highs.length < 2 || lows.length < 2) return unknown('Fewer than two confirmed weekly swing highs and lows in the available history.');
  const h = highs.slice(-2), l = lows.slice(-2);
  const direction = h[1].price > h[0].price && l[1].price > l[0].price ? 'long'
    : h[1].price < h[0].price && l[1].price < l[0].price ? 'short' : 'neutral';
  return { state: 'available', market, direction, venue: weeks[0].provenance.venue, asOf,
    retrievedAt: now, expiresAt: asOf + WEEK, weeks: weeks.length, highs: h, lows: l };
}

/** Reuse direct-perpetual pool transports; daily aggregation avoids venue-specific weekly anchors. */
export async function plannerStructureCandles(market: string, signal: AbortSignal): Promise<PlannerCandle[]> {
  const symbol = market.replace(/-PERP$/, ''), end = btcUtcWeekStart(Date.now()), start = end - 52 * WEEK;
  if (!/^[A-Za-z0-9-]+$/.test(symbol)) return [];
  for (const source of PLANNER_CANDLE_SOURCES) {
    signal.throwIfAborted();
    try {
      const entry = AbortSignal.any([signal, AbortSignal.timeout(6_000)]);
      const raw = source === 'pacifica' ? await pacificaPerpWindow(symbol, '1d', start, end, entry)
        : await readPlannerPerpSource(source, symbol, '1d', start, end, entry);
      const days = raw.filter(c => c.time >= start && c.time < end);
      const weeks = aggregateStructureWeeks(days, Date.now());
      if (weeks.length >= 7 && weeks.at(-1)!.time + WEEK === end) return weeks;
    } catch { signal.throwIfAborted(); }
  }
  return [];
}

/** One computation per market/weekly close; bounded coalesced jobs and negative-cache retries. No scheduler. */
export class PlannerWeeklyStructure {
  private cache = new Map<string, { value: WeeklyStructure; readAt: number; expiresAt: number }>();
  private jobs = new Map<string, Promise<WeeklyStructure>>();
  private starts: number[] = [];
  constructor(private deps: Pick<PlannerDeps, 'now' | 'structureCandles'>) {}
  async read(market: string): Promise<WeeklyStructure> {
    const now = this.deps.now(), cached = this.cache.get(market);
    if (cached && now >= cached.readAt && now < cached.expiresAt) return cached.value;
    const existing = this.jobs.get(market); if (existing) return existing;
    const unknown = (reason: string): WeeklyStructure => ({ state: 'unavailable', reason });
    this.starts = this.starts.filter(t => now - t < 60_000);
    if (!this.deps.structureCandles) return unknown('Weekly candle pool unavailable.');
    if (this.jobs.size >= 2 || this.starts.length >= 12) return unknown('Weekly signal is busy; refresh later.');
    this.starts.push(now);
    const job = Promise.resolve().then(() => this.deps.structureCandles!(market, AbortSignal.timeout(25_000)))
      .then(weeks => {
        const clock = this.deps.now(), value = computeWeeklyStructure(market, weeks, clock);
        const complete = weeks.length >= 7 && weeks.at(-1)!.time + WEEK === btcUtcWeekStart(clock);
        const expiresAt = value.state === 'available' ? value.expiresAt : complete
          && value.reason.startsWith('Fewer than two') ? btcUtcWeekStart(clock) + WEEK : clock + 60_000;
        this.cache.delete(market);
        if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(market, { value, readAt: clock, expiresAt }); return value;
      }).catch(() => {
        const clock = this.deps.now(), value = unknown('Weekly candle pool timed out or is unavailable.');
        if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(market, { value, readAt: clock, expiresAt: clock + 60_000 }); return value;
      }).finally(() => { this.jobs.delete(market); });
    this.jobs.set(market, job); return job;
  }
}
