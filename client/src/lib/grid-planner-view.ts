import Decimal from 'decimal.js';
import type { PlannerChart, PlannerMarket, PlannerPreview } from '../../../server/grid-planner/types';
export type { PlannerChart, PlannerMarket, PlannerPreview };
export const PLANNING_BANNER = 'Planning only — no orders are placed';
export const ASSUMPTION_LABEL = 'Your assumption — not a venue quote';
export const clientObservationDeadline = (expiresAt: number, serverNow: number, requestStartedAt: number) =>
  requestStartedAt + Math.max(0, expiresAt - serverNow);

const D = Decimal.clone({ precision: 80 });
const plainPrice = (value: string) => value.length <= 37 && /^(0|[1-9]\d{0,17})(\.\d{1,18})?$/.test(value) && new D(value).gt(0);
export const RANGE_PRESETS = [{ label: 'Tight', percent: 5 }, { label: 'Balanced', percent: 10 }, { label: 'Wide', percent: 20 }] as const;
export const ORDER_SIZES = [
  { value: 'flat', label: 'Equal quote allocation' },
  { value: 'ascending', label: 'Larger further from current price' },
  { value: 'descending', label: 'Larger near current price' },
] as const;
export function plannerSizeHint(side: string, scale: string, startingPosition = false): string {
  const action = startingPosition ? side === 'long' ? 'sold to close the starting long' : 'bought back to close the starting short'
    : side === 'long' ? 'bought' : 'sold short';
  const move = startingPosition ? side === 'long' ? 'rises' : 'falls' : side === 'long' ? 'falls' : 'rises';
  const near = startingPosition ? side === 'long' ? 'above' : 'below' : side === 'long' ? 'below' : 'above';
  return scale === 'flat' ? `Equal quote value is ${action} at each level; base quantities vary with price and lot rounding.`
    : scale === 'ascending' ? `More quote value is ${action} as price ${move} further from the current price; base quantities depend on price and lot rounding.`
      : `More quote value is ${action} at levels just ${near} the current price; base quantities depend on price and lot rounding.`;
}

/** A shortcut uses only an unexpired, observed Pacifica price; never chart closes. */
export function plannerRangeAround(market: PlannerMarket | undefined, deadline: number, now: number, percent: number) {
  if (market?.reference.state !== 'available' || now >= deadline || !Number.isFinite(percent) || percent < 1 || percent > 40) return null;
  const price = new D(market.reference.value.price), fraction = new D(percent).div(100);
  const lower = price.times(new D(1).minus(fraction)).toFixed(18).replace(/\.?0+$/, '');
  const upper = price.times(new D(1).plus(fraction)).toFixed(18).replace(/\.?0+$/, '');
  return plainPrice(lower) && plainPrice(upper) && new D(lower).lt(upper) ? { lower, upper } : null;
}

/** Proposed input only: 3% beyond the loss-side edge, rounded outwards to the tick. */
export function proposedPlannerStop(lower: string, upper: string, side: string, tick: string): string | null {
  if (![lower, upper, tick].every(plainPrice) || !['long', 'short'].includes(side) || !new D(lower).lt(upper)) return null;
  const long = side === 'long', edge = new D(long ? lower : upper);
  const stop = edge.times(long ? '0.97' : '1.03').div(tick).toDecimalPlaces(0, long ? Decimal.ROUND_FLOOR : Decimal.ROUND_CEIL).times(tick).toFixed();
  return plainPrice(stop) ? stop : null;
}

export type PlannerRange = { lower: string; upper: string; stop: string | null };
/** User inputs are labelled proposed; quantized levels still need a current preview. */
export function plannerChartRange(lower: string, upper: string, stop: string): PlannerRange | null {
  if (![lower, upper].every(plainPrice) || !new D(lower).lt(upper)) return null;
  return { lower, upper, stop: plainPrice(stop) ? stop : null };
}

/** UI percent conversion is decimal string manipulation, never binary floating point. */
export function feePercentToRate(percent: string): string | null {
  if (percent === '') return null;
  if (!/^(0|[1-9]\d{0,17})(\.\d{1,16})?$/.test(percent)) throw new Error('Enter a nonnegative plain fee percent with up to 16 decimal places');
  const [whole, fraction = ''] = percent.split('.');
  const digits = whole.padStart(3, '0');
  const integer = digits.slice(0, -2).replace(/^0+(?=\d)/, '');
  const decimal = (digits.slice(-2) + fraction).replace(/0+$/, '');
  return integer + (decimal ? '.' + decimal : '');
}

/** Generation changes even for A→B→A and identical-query refreshes. */
export class PlannerRequestGeneration {
  private generation = 0;
  private controller: AbortController | null = null;
  invalidate() { this.generation++; this.controller?.abort(); this.controller = null; }
  start() {
    this.invalidate();
    const generation = this.generation, controller = new AbortController(); this.controller = controller;
    return { signal: controller.signal, current: () => this.generation === generation && !controller.signal.aborted };
  }
}
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const decimal = (v: unknown) => typeof v === 'string' && v.length <= 90 && /^(0|[1-9]\d*)(\.\d+)?$/.test(v) && Number.isFinite(Number(v));
const positive = (v: unknown) => decimal(v) && Number(v) > 0;
const clock = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const fact = (v: unknown, validate: (value: any) => boolean) => record(v) && (v.state === 'unavailable' && typeof v.reason === 'string'
  || v.state === 'available' && validate(v.value));
export function isPlannerMarket(v: unknown): v is PlannerMarket {
  return record(v) && typeof v.market === 'string' && typeof v.name === 'string' && typeof v.protocolSymbol === 'string'
    && fact(v.reference, r => record(r) && positive(r.price) && clock(r.observedAt) && r.expiresAt === r.observedAt + 60_000
      && r.label === 'Cached Pacifica book reference price')
    && fact(v.constraints, c => record(c) && c.venue === 'pacifica' && c.source === '/info' && positive(c.tick) && positive(c.lot)
      && positive(c.minimumQuote) && clock(c.observedAt) && c.expiresAt === c.observedAt + 300_000
      && fact(c.maxLeverage, positive) && fact(c.maximumQuote, positive)
      && fact(c.priceBounds, b => record(b) && positive(b.minimum) && positive(b.maximum)) && fact(c.restrictions, r => typeof r === 'string'));
}
export function isPlannerChart(v: unknown): v is PlannerChart {
  if (!record(v)) return false;
  if (v.state === 'unavailable') return typeof v.reason === 'string';
  return v.state === 'available' && typeof v.market === 'string' && ['15m', '1h', '4h'].includes(v.timeframe)
    && [100, 200].includes(v.requestedBars) && clock(v.retrievedAt) && clock(v.cacheInsertedAt)
    && typeof v.validForMs === 'number' && v.validForMs > 0 && v.validForMs <= 300_000
    && Array.isArray(v.candles) && v.candles.length > 0 && v.candles.length <= v.requestedBars
    && v.actualBars === v.candles.length && v.partial === (v.actualBars < v.requestedBars)
    && v.candles.every((c: any, i: number) => record(c) && clock(c.time) && c.time <= v.retrievedAt
      && (!i || c.time > v.candles[i - 1].time) && [c.open, c.high, c.low, c.close].every(n => typeof n === 'number' && Number.isFinite(n) && n > 0)
      && c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close)
      && record(c.provenance) && ['okx', 'pacifica'].includes(c.provenance.source) && c.provenance.venue === c.provenance.source
      && c.provenance.source === v.candles[0].provenance.source && c.provenance.basis === 'perp'
      && c.provenance.proxy === 'direct' && c.provenance.timeSemantic === 'open_time' && ['finalized', 'forming'].includes(c.provenance.finality));
}
function isPlan(p: any): boolean {
  return record(p) && ['long', 'short'].includes(p.side) && positive(p.start) && positive(p.investment) && positive(p.leverage)
    && decimal(p.seedQuantity) && decimal(p.allocatedNotional) && decimal(p.unallocatedNotional)
    && ['evaluated', 'not_evaluated'].includes(p.feeGate) && Array.isArray(p.feeRows)
    && Array.isArray(p.lines) && p.lines.length >= 2 && p.lines.length <= 101
    && p.lines.every((l: any, i: number) => record(l) && l.ordinal === i && positive(l.price) && decimal(l.quantity) && decimal(l.notional)
      && (!i || Number(l.price) > Number(p.lines[i - 1].price)) && ['entry', 'seed_exit', 'virtual'].includes(l.role)
      && (l.pairedExitOrdinal === null || Number.isInteger(l.pairedExitOrdinal) && l.pairedExitOrdinal >= 0 && l.pairedExitOrdinal < p.lines.length));
}
export function isPlannerPreview(v: unknown): v is PlannerPreview {
  return record(v) && ['diagnostic', 'hypothetical_checks_passed', 'rejected', 'unavailable'].includes(v.state)
    && isPlannerMarket(v.market) && clock(v.retrievedAt) && Number.isFinite(v.validForMs) && v.validForMs >= 0 && v.validForMs <= 60_000
    && Array.isArray(v.reasons) && v.reasons.every((r: any) => typeof r === 'string')
    && (v.requestedPlan === null || isPlan(v.requestedPlan)) && (v.minimumPlan === null || isPlan(v.minimumPlan))
    && fact(v.minimum, positive) && fact(v.assumedMinimum, positive) && record(v.stop) && v.stop.state === 'unavailable' && typeof v.stop.reason === 'string'
    && record(v.fee) && (v.fee.state === 'unknown' || v.fee.state === 'assumption' && decimal(v.fee.rate) && v.fee.label === ASSUMPTION_LABEL)
    && Array.isArray(v.feeRows) && v.feeRows.length <= 100 && v.feeRows.every((r: any) => record(r) && Number.isInteger(r.ordinal)
      && positive(r.entryPrice) && positive(r.exitPrice) && decimal(r.quantity) && decimal(r.spread) && decimal(r.requiredSpread)
      && decimal(r.assumedRoundTripFee) && typeof r.clears === 'boolean') && record(v.policy)
    && v.policy.ordinaryWindow === 20 && v.policy.requiredAvailableSlots === 25 && v.policy.reserveSlots === 5
    && v.policy.maximumIntervals === 100 && v.policy.transportBatch === 10 && typeof v.policy.source === 'string';
}
export function plannerOverlays(preview: PlannerPreview | null, expiresAt: number, now: number) {
  if (!preview || now >= expiresAt || !['diagnostic', 'hypothetical_checks_passed'].includes(preview.state)) return [];
  return preview.requestedPlan?.lines ?? [];
}
export function readableDecimal(value: string): string {
  const [whole, fraction] = value.split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? '.' + fraction : '');
}
export const readableTime = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
