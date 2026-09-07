/** Human diagnostic evidence only. No admission, execution or model-input consumer. */
export type ExcursionUnavailableReason = 'empty_window' | 'malformed_window' | 'mixed_provenance'
  | 'window_limit' | 'no_retained_observation' | 'terminal_precedes_sample';
export interface ExcursionUnavailable {
  version: 1; status: 'unavailable'; bootId: string; reason: ExcursionUnavailableReason;
}
export interface ExcursionObserved {
  version: 1; status: 'observed'; bootId: string; coverage: 'partial';
  basis: 'paper_closed_candles' | 'live_sampled_marks';
  decisionStartedAtMs: number; fromMs: number; throughMs: number;
  sampleCount: number; timeframeMs: number | null; expectedInteriorBars: number | null;
  missingInteriorBars: number | null;
  high: { price: number; atMs: number }; low: { price: number; atMs: number };
  source: { provider: string; venue: string; basis: string; proxy: string; timeSemantic: string };
}
export type PriceExcursion = ExcursionUnavailable | ExcursionObserved;
export const validObservationTime = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 8.64e15;
export const positiveObservationPrice = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0;
const obj = (v: unknown): Record<string, any> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : null;
const member = (v: unknown, choices: string[]) => typeof v === 'string' && choices.includes(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 1e9;
const reasons = ['empty_window','malformed_window','mixed_provenance','window_limit',
  'no_retained_observation','terminal_precedes_sample'];
/** Copies only bounded primitives. Invalid optional evidence must never throw into a close. */
export function readPriceExcursion(value: unknown, bounds?: {
  decisionStartedAtMs: number; closedAtMs: number;
}): PriceExcursion | null {
  try {
    const v = obj(value);
    if (!v || v.version !== 1 || typeof v.bootId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(v.bootId)) return null;
    if (v.status === 'unavailable') return member(v.reason, reasons)
      ? { version: 1, status: 'unavailable', bootId: v.bootId, reason: v.reason } : null;
    if (v.status !== 'observed' || v.coverage !== 'partial'
      || !member(v.basis, ['paper_closed_candles','live_sampled_marks'])
      || !validObservationTime(v.decisionStartedAtMs) || !validObservationTime(v.fromMs)
      || !validObservationTime(v.throughMs) || v.fromMs <= v.decisionStartedAtMs || v.throughMs < v.fromMs
      || !count(v.sampleCount) || v.sampleCount === 0) return null;
    const high = obj(v.high), low = obj(v.low), source = obj(v.source);
    if (!high || !low || !source || !positiveObservationPrice(high.price) || !positiveObservationPrice(low.price)
      || high.price < low.price || ![high.atMs,low.atMs].every(t =>
        validObservationTime(t) && t >= v.fromMs && t <= v.throughMs)) return null;
    if (v.basis === 'paper_closed_candles') {
      if (!count(v.timeframeMs) || v.timeframeMs === 0 || !count(v.expectedInteriorBars)
        || !count(v.missingInteriorBars) || v.expectedInteriorBars !== v.sampleCount + v.missingInteriorBars
        || v.expectedInteriorBars > 20_000
        || !member(source.provider,['okx','gate','pyth','hyperliquid'])
        || !member(source.venue,['okx','gate','hyperliquid','none'])
        || !member(source.basis,['perp','spot','index']) || !member(source.proxy,['direct','proxy'])
        || source.timeSemantic !== 'open_time'
        || [v.fromMs,v.throughMs,high.atMs,low.atMs].some(t => t % v.timeframeMs !== 0)) return null;
    } else if (v.timeframeMs !== null || v.expectedInteriorBars !== null || v.missingInteriorBars !== null
      || !member(source.provider,['pacifica','flash','drift','hyperliquid']) || source.venue !== source.provider
      || source.basis !== 'mark' || source.proxy !== 'direct' || source.timeSemantic !== 'monitor_read_time') return null;
    if (bounds && (!validObservationTime(bounds.closedAtMs)
      || bounds.decisionStartedAtMs !== v.decisionStartedAtMs
      || v.throughMs + (v.timeframeMs ?? 0) > bounds.closedAtMs)) return null;
    return { version: 1, status: 'observed', bootId: v.bootId, coverage: 'partial', basis: v.basis,
      decisionStartedAtMs: v.decisionStartedAtMs, fromMs: v.fromMs, throughMs: v.throughMs,
      sampleCount: v.sampleCount, timeframeMs: v.timeframeMs, expectedInteriorBars: v.expectedInteriorBars,
      missingInteriorBars: v.missingInteriorBars,
      high: { price: high.price, atMs: high.atMs }, low: { price: low.price, atMs: low.atMs },
      source: { provider: source.provider, venue: source.venue, basis: source.basis,
        proxy: source.proxy, timeSemantic: source.timeSemantic } };
  } catch { return null; }
}
export function observedExcursionMetrics(v: ExcursionObserved, side: 'long' | 'short',
  entry: number, stop: number | null, target: number | null) {
  if (!positiveObservationPrice(entry)) return null;
  const sign = side === 'long' ? 1 : -1, favorable = side === 'long' ? v.high : v.low,
    adverse = side === 'long' ? v.low : v.high;
  const up = Math.max(0, sign * (favorable.price - entry)), down = Math.max(0, sign * (entry - adverse.price));
  const finite = (n: number) => Number.isFinite(n) ? n : null;
  const reward = target === null ? NaN : sign * (target - entry), risk = stop === null ? NaN : sign * (entry - stop);
  return { favorablePct: finite(up / entry * 100), adversePct: finite(down / entry * 100),
    targetProgress: reward > 0 ? finite(up / reward) : null, adverseRisk: risk > 0 ? finite(down / risk) : null,
    favorableAtMs: favorable.atMs, adverseAtMs: adverse.atMs };
}
