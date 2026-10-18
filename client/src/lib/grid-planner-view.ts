import { gridModePlanValid, gridModeLines } from './grid-behaviour-view';
import { GRID_MODES_CREATION, isGridCyclePolicyVersion } from '../../../shared/grid-behaviour';
import Decimal from 'decimal.js';
import { GRID_HISTORY_MAX_BARS } from '../../../shared/grid-lookback';
import {PER_BOT_ORDINARY_MAX,GRID_FULL_WINDOW_SLOTS,GRID_PROTECTION_RESERVE} from '../../../shared/grid-capacity';
import type { PlannerChart, PlannerMarket, PlannerPreview } from '../../../server/grid-planner/types';
import type { GridPlan } from '../../../server/grid-bot/engine-types';
import type { GridSetupForm } from './grid-setup-view';
export type { PlannerChart, PlannerMarket, PlannerPreview };
export const PLANNING_BANNER = 'Planning only — no orders are placed';
export const ASSUMPTION_LABEL = 'Your assumption — not a venue quote';
export function plannerStatus(preview: PlannerPreview, stale = false): string {
  if (stale) return 'Preview expired — refresh market data';
  if (preview.state === 'rejected') return 'Plan needs changes — see the checks below';
  if (preview.state === 'unavailable') return 'Plan unavailable — refresh market data';
  if (preview.geometry?.state === 'available') return 'Prices ready — enter an investment to check order sizes and fees';
  const missing: string[] = [];
  if (preview.fee.state === 'unknown') missing.push('fees not checked (enter your maker fee)');
  if (preview.market.constraints.state === 'available') {
    const c = preview.market.constraints.value;
    for (const [key, label] of [['maxLeverage', 'leverage limit'], ['maximumQuote', 'maximum order value'],
      ['priceBounds', 'accepted price range'], ['restrictions', 'market requirements']] as const) {
      if (c[key].state === 'unavailable') missing.push(`Pacifica’s ${label} couldn’t be loaded; refresh market data`);
    }
  } else missing.push('market limits not checked; refresh market data');
  if (missing.length) return `Plan ready — ${missing.join('; ')}`;
  return preview.state === 'hypothetical_checks_passed'
    ? 'Plan ready — price, size, maker fee and market checks passed'
    : 'Plan ready — checks incomplete; refresh market data';
}
export const clientObservationDeadline = (expiresAt: number, serverNow: number, requestStartedAt: number) =>
  requestStartedAt + Math.max(0, expiresAt - serverNow);

const D = Decimal.clone({ precision: 80 });
const plainPrice = (value: string) => value.length <= 37 && /^(0|[1-9]\d{0,17})(\.\d{1,18})?$/.test(value) && new D(value).gt(0);
export const RANGE_PRESETS = [{ label: 'Tight ±5%', percent: 5 }, { label: 'Balanced ±10%', percent: 10 }, { label: 'Wide ±20%', percent: 20 }] as const;
export const ORDER_SIZES = [
  { value: 'flat', label: 'Equal' },
  { value: 'ascending', label: 'Larger further from entry price' },
  { value: 'descending', label: 'Larger near entry price' },
] as const;
export function plannerShortcutReason(market: string, hasFreshPrice: boolean, error: string, loading: boolean) {
  return !market ? 'Choose a market to use the presets and width slider.'
    : !hasFreshPrice && error && !loading ? `Fresh price unavailable: ${error}. Refresh price to retry.` : '';
}
export function plannerSizeHint(_side: string, scale: string, startingPosition = false): string {
  if (startingPosition) return scale === 'flat' ? 'Your starting position is closed in equal pieces at each level.'
    : scale === 'ascending' ? 'Bigger pieces are closed the further price moves in your favour.'
      : 'Bigger pieces are closed at the levels nearest the entry price.';
  return scale === 'flat' ? 'Every grid order is the same size.'
    : scale === 'ascending' ? 'Orders get bigger the further price moves from the entry price.'
      : 'Orders are biggest close to the entry price.';
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

/** The request identity includes every editable preview input, including the proposed stop. */
export function plannerPreviewQuery(form: GridSetupForm, stop: string, modesCreation = GRID_MODES_CREATION) {
  try {
    const fee = form.investment ? feePercentToRate(form.feePercent) : null;
    const q = new URLSearchParams({ market: form.market, side: form.side, lower: form.lower, upper: form.upper,
      intervals: form.intervals, entryScale: form.entryScale, profitScale: form.profitScale, seed: String(form.seed),
      leverage: form.leverage, investment: form.investment, stop });
    if (modesCreation) q.set('behaviourMode', form.behaviourMode);
    if (fee !== null) q.set('fee', fee);
    return { value: q.toString(), error: '' };
  } catch (e) { return { value: '', error: (e as Error).message }; }
}

export function plannerGridCountHint(intervals: string): string {
  if (!/^[1-9]\d{0,2}$/.test(intervals) || Number(intervals) > 100) return 'Enter 1–100 grids to see the price-line count.';
  const count = Number(intervals);
  return `${count} ${count === 1 ? 'grid makes' : 'grids make'} ${count + 1} price lines.`;
}

/** Use only the requested plan, never the diagnostic plan sized at minimum investment. */
export function plannerOrderSizeSummary(plan: GridPlan | null | undefined, entryScale: string): string | null {
  if(isGridCyclePolicyVersion(plan?.policyVersion)&&plan.cycles?.length){
    const quantities=plan.cycles.filter(c=>c.enabled!==false).map(c=>new D(c.quantity)),min=readableDecimal(D.min(...quantities).toFixed()),max=readableDecimal(D.max(...quantities).toFixed());
    return `${min===max?min:`${min}–${max}`} units per cycle; quantities stay fixed as prices change`;
  }
  const entries = plan?.lines.filter(line => line.role === 'entry') ?? [];
  if (!entries.length) return null;
  const values = entries.map(line => new D(line.notional));
  const dollars = (value: Decimal) => readableDecimal(value.toDecimalPlaces(value.gte(10) ? 0 : 2, Decimal.ROUND_HALF_UP).toFixed());
  if (entryScale === 'flat') {
    // Equal quote allocations precede lot rounding; seed exits share the budget when present.
    const activeCount = plan!.lines.filter(line => line.role !== 'virtual').length;
    const allocation = new D(plan!.investment).times(plan!.leverage).div(activeCount);
    return `About $${dollars(allocation)} per grid order (equal sizes)`;
  }
  return `About $${dollars(D.min(...values))} to $${dollars(D.max(...values))} per grid order (scaled sizes)`;
}

export function plannerOpeningMinimumSummary(plan: GridPlan | null | undefined): string | null {
  const lift = plan?.openingOrderLift;
  return lift ? `${lift.count} ${lift.count === 1 ? 'grid order raised' : 'grid orders raised'} to the $${readableDecimal(lift.minimumQuote)} minimum` : null;
}

/** Generation changes even for A→B→A and identical-query refreshes. */
export class PlannerRequestGeneration {
  private generation = 0;
  private controller: AbortController | null = null;
  invalidate() { this.generation++; this.controller?.abort(); this.controller = null; }
  start(inputKey?: string) {
    this.invalidate();
    const generation = this.generation, controller = new AbortController(); this.controller = controller;
    return { signal: controller.signal, current: (currentInputKey = inputKey) => currentInputKey === inputKey
      && this.generation === generation && !controller.signal.aborted };
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
      && fact(c.priceBounds, b => record(b) && decimal(b.minimum) && positive(b.maximum) && new D(b.minimum).lt(b.maximum)) && fact(c.restrictions, r => typeof r === 'string'));
}
export function isPlannerChart(v: unknown): v is PlannerChart {
  if (!record(v)) return false;
  if (v.state === 'unavailable') return typeof v.reason === 'string';
  return v.state === 'available' && typeof v.market === 'string' && ['15m', '1h', '4h'].includes(v.timeframe)
    && Number.isSafeInteger(v.requestedBars) && v.requestedBars >= 1 && v.requestedBars <= GRID_HISTORY_MAX_BARS && clock(v.retrievedAt) && clock(v.cacheInsertedAt)
    && typeof v.validForMs === 'number' && v.validForMs > 0 && v.validForMs <= 300_000
    && Array.isArray(v.candles) && v.candles.length > 0 && v.candles.length <= v.requestedBars
    && v.actualBars === v.candles.length && v.partial === (v.actualBars < v.requestedBars)
    && v.candles.every((c: any, i: number) => record(c) && clock(c.time) && c.time <= v.retrievedAt
      && (!i || c.time > v.candles[i - 1].time) && [c.open, c.high, c.low, c.close].every(n => typeof n === 'number' && Number.isFinite(n) && n > 0)
      && c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close)
      && record(c.provenance) && ['okx', 'gate', 'hyperliquid', 'pacifica'].includes(c.provenance.source) && c.provenance.venue === c.provenance.source
      && c.provenance.source === v.candles[0].provenance.source && c.provenance.basis === 'perp'
      && c.provenance.proxy === 'direct' && c.provenance.timeSemantic === 'open_time' && ['finalized', 'forming'].includes(c.provenance.finality));
}
function isPlan(p: any): boolean {
  return record(p) && gridModePlanValid(p as GridPlan) && ['long', 'short'].includes(p.side) && positive(p.start) && positive(p.investment) && positive(p.leverage)
    && decimal(p.seedQuantity) && decimal(p.allocatedNotional) && decimal(p.unallocatedNotional)
    && (p.openingOrderLift === undefined || record(p.openingOrderLift) && Number.isInteger(p.openingOrderLift.count)
      && p.openingOrderLift.count > 0 && p.openingOrderLift.count <= 100 && positive(p.openingOrderLift.minimumQuote))
    && ['evaluated', 'not_evaluated'].includes(p.feeGate) && Array.isArray(p.feeRows)
    && Array.isArray(p.lines) && p.lines.length >= 2 && p.lines.length <= 101
    && (p.openingOrderLift?.ordinals === undefined || Array.isArray(p.openingOrderLift.ordinals)
      && p.openingOrderLift.ordinals.length === p.openingOrderLift.count
      && new Set(p.openingOrderLift.ordinals).size === p.openingOrderLift.count
      && p.openingOrderLift.ordinals.every((i: unknown) => typeof i === 'number' && Number.isInteger(i)
        && i >= 0 && i < p.lines.length && (p.lines[i].role === 'entry'
          || isGridCyclePolicyVersion(p.policyVersion) && p.lines[i].role === 'seed_exit' && Array.isArray(p.cycles)
            && p.cycles.some((c: any) => record(c) && c.ownerOrdinal === i && c.anchor === 'closing'))))
    && p.lines.every((l: any, i: number) => record(l) && l.ordinal === i && positive(l.price) && decimal(l.quantity) && decimal(l.notional)
      && (!i || Number(l.price) > Number(p.lines[i - 1].price)) && ['entry', 'seed_exit', 'virtual'].includes(l.role)
      && (l.pairedExitOrdinal === null || Number.isInteger(l.pairedExitOrdinal) && l.pairedExitOrdinal >= 0 && l.pairedExitOrdinal < p.lines.length));
}
export function isPlannerPreview(v: unknown): v is PlannerPreview {
  return record(v) && ['diagnostic', 'hypothetical_checks_passed', 'rejected', 'unavailable'].includes(v.state)
    && isPlannerMarket(v.market) && clock(v.retrievedAt) && Number.isFinite(v.validForMs) && v.validForMs >= 0 && v.validForMs <= 60_000
    && Array.isArray(v.reasons) && v.reasons.every((r: any) => typeof r === 'string')
    && (v.requestedPlan === null || isPlan(v.requestedPlan)) && (v.minimumPlan === null || isPlan(v.minimumPlan))
    && (v.geometry === undefined || fact(v.geometry, lines => Array.isArray(lines) && lines.length >= 2 && lines.length <= 101
      && lines.every((line: any, i: number) => record(line) && line.ordinal === i && positive(line.price)
        && Object.keys(line).every(key => key === 'ordinal' || key === 'price')
        && (!i || new D(line.price).gt(lines[i - 1].price)))))
    && (v.geometry?.state !== 'available' || v.state === 'diagnostic' && v.requestedPlan === null && v.minimumPlan === null
      && v.minimum?.state === 'unavailable' && v.assumedMinimum?.state === 'unavailable' && v.fee?.state === 'unknown'
      && Array.isArray(v.feeRows) && v.feeRows.length === 0)
    && fact(v.minimum, positive) && fact(v.assumedMinimum, positive) && record(v.stop) && v.stop.state === 'unavailable' && typeof v.stop.reason === 'string'
    && record(v.fee) && (v.fee.state === 'unknown' || v.fee.state === 'assumption' && decimal(v.fee.rate) && v.fee.label === ASSUMPTION_LABEL)
    && Array.isArray(v.feeRows) && v.feeRows.length <= 100 && v.feeRows.every((r: any) => record(r) && Number.isInteger(r.ordinal)
      && positive(r.entryPrice) && positive(r.exitPrice) && decimal(r.quantity) && decimal(r.spread) && decimal(r.requiredSpread)
      && decimal(r.assumedRoundTripFee) && typeof r.clears === 'boolean') && record(v.policy)
    && v.policy.ordinaryWindow === PER_BOT_ORDINARY_MAX && v.policy.requiredAvailableSlots === GRID_FULL_WINDOW_SLOTS && v.policy.reserveSlots === GRID_PROTECTION_RESERVE
    && v.policy.maximumIntervals === 100 && v.policy.transportBatch === 10 && typeof v.policy.source === 'string';
}
export function plannerOverlays(preview: PlannerPreview | null, expiresAt: number, now: number) {
  if (!preview || now >= expiresAt || preview.state === 'unavailable') return [];
  // Rejected funding/fee checks can retain valid server-calculated diagnostic geometry.
  return preview.geometry?.state === 'available' ? preview.geometry.value : gridModeLines(preview.requestedPlan ?? preview.minimumPlan);
}
export function plannerLevelMessage(preview: PlannerPreview | null, expiresAt: number, now: number,
  inputs: { market: string; lower: string; upper: string; investment: string; stop: string }, loading: boolean, error: string) {
  if (!inputs.market) return 'Choose a market to calculate grid levels.';
  const missing = [!inputs.lower && 'a lower price', !inputs.upper && 'an upper price',
    !!inputs.investment && !inputs.stop && 'a stop price (or fresh market details for a suggested stop)'].filter(Boolean);
  if (missing.length) return `To show grid levels, enter ${missing.join(', ')}.`;
  if (error) return `Grid levels are unavailable: ${error}`;
  if (loading && !preview) return 'Calculating grid levels from your inputs…';
  if (!preview) return 'Waiting for a grid preview. Refresh chart if it does not appear.';
  if (now >= expiresAt && preview.validForMs > 0) return 'Grid levels have expired. Refresh chart to get a fresh price and market details.';
  if (!plannerOverlays(preview, expiresAt, now).length) return `Grid levels are unavailable: ${preview.reasons.join('; ') || 'a fresh price and usable market details are required.'}`;
  if (preview.geometry?.state === 'available') return 'Enter an investment to see order sizes';
  const basis = preview.requestedPlan ? 'your investment' : 'the minimum investment, not your entered investment';
  const warning = preview.state === 'rejected' ? ' Checks did not pass; see Your plan.'
    : preview.state === 'diagnostic' ? ' Some checks are unavailable.' : '';
  return `Dashed grid levels show planned prices and sizes at ${basis}.${warning}`;
}
/** Display precision comes from the exchange step, never padded engine decimals. */
export function plannerPriceFormat(tick: string | null | undefined, prices: (string | number)[]) {
  if (tick && plainPrice(tick)) return { precision: new D(tick).decimalPlaces(), minMove: Number(tick) };
  const precision = Math.min(18, Math.max(0, ...prices.map(price => {
    try { return new D(price).isFinite() ? new D(price).decimalPlaces() : 0; } catch { return 0; }
  })));
  return { precision, minMove: 10 ** -precision };
}
export type PlannerIssue = { message: string; panel: string; field?: string; setting: string; original: string };
export function plannerVenueChecks(market: PlannerMarket): { label: string; value: string }[] {
  if (market.constraints.state !== 'available') return [];
  const c = market.constraints.value, fallback = 'Not checked — refresh market data';
  return [
    { label: 'Maximum order value', value: c.maximumQuote.state === 'available' ? `$${readableDecimal(c.maximumQuote.value)}` : fallback },
    { label: 'Accepted order prices', value: c.priceBounds.state === 'available' ? `$${readableDecimal(c.priceBounds.value.minimum)} to $${readableDecimal(c.priceBounds.value.maximum)}` : fallback },
    { label: 'Market requirements', value: c.restrictions.state !== 'available' ? fallback : c.restrictions.value === 'unrestricted'
      ? 'Perpetual order-book trading; cross margin supported' : c.restrictions.value === 'isolated_only' ? 'Isolated margin required' : 'Unsupported market or order type; choose another market' },
    { label: 'Market limits source', value: `Pacifica /info · checked ${readableTime(c.observedAt)}` },
  ];
}
export function plannerIssue(reason: string): PlannerIssue {
  const issue = (message: string, panel: string, setting: string, field?: string): PlannerIssue => ({ message, panel, setting, field, original: reason });
  const staleData = /constraint|observation|future-dated|shared authority|sources exhausted|Cached Pacifica book reference price.*(?:missing|invalid|older than)/i.test(reason);
  let message = reason.replace(/quantized levels/gi, 'grid levels').replace(/quantized/gi, 'rounded')
    .replace(/venue tick/gi, "the exchange's price step").replace(/observed Pacifica maximum/gi, 'exchange maximum')
    .replace(/intervals/gi, 'grids').replace(/minimum capital/gi, 'minimum investment')
    .replace(/\bobserved\b/gi, 'current').replace(/\bvenue\b/gi, 'exchange');
  if (/Lot-rounded line|Full entry quantity/i.test(reason)) message = 'A grid order is below Pacifica’s minimum order value. Raise the investment, use fewer grids, or use more leverage.';
  else if (/Fee assumption.*plain decimal/i.test(reason)) message = 'Enter a fee assumption of 0 or more, using only numbers and a decimal point.';
  else if (/interval count/i.test(reason)) message = 'Use between 1 and 100 grids.';
  else if (/precision exceeds/i.test(reason)) message = 'This market needs smaller price or quantity steps than Grid supports. Choose another market.';
  else if (/durable policy precision/i.test(reason)) message = 'Your stop loss is too close to the entry price. Move it farther away.';
  else if (/liquidation|validated.*clearance/i.test(reason)) message = 'The stop loss could not be confirmed before liquidation. Move it closer to the entry price or lower leverage, then refresh the preview.';
  else if (/seed taker fee/i.test(reason)) message = 'The fee for opening your starting position is unavailable. Refresh the preview or turn off the starting position.';
  else if (/maker.*builder.*unavailable|Maker fee clearance unavailable/i.test(reason)) message = 'Your current trading fees are unavailable. Refresh the preview to check them.';
  else if (/Auto range changed/i.test(reason)) message = 'The suggested range changed or its price history is unavailable. Suggest the range again or enter a range yourself.';
  else if (/Market identity mismatch/i.test(reason)) message = 'The market data does not match your selected market. Refresh price and try again.';
  else if (/Stop must align/i.test(reason)) message = 'Place the stop loss below the range for Long or above it for Short, using Pacifica’s price step shown in Fees & data.';
  else if (staleData) message = 'Current market data is unavailable or expired. Refresh price and try again.';
  else if (/reference price|range boundary/i.test(reason)) message = 'The current price must sit inside your range. Refresh price, then widen or move the range.';
  else if (/collaps|duplicate/i.test(reason)) message = 'Some grid prices round to the same price. Widen the range or use fewer grids.';
  else if (/round-trip cost|Assumed fee check failed/i.test(reason)) message = 'Your fee assumption uses up the profit between grid prices. Widen the range, use fewer grids, or review the fee assumption.';
  else if (/maximum order|Order exceeds venue maximum/i.test(reason)) message = 'A grid order exceeds Pacifica’s maximum order value. Lower the investment or leverage, or use more grids.';
  else if (/submitted-price bounds/i.test(reason)) message = 'A grid price is outside Pacifica’s accepted prices. Move the range inside the limits in Fees & data.';
  else if (/restrictions/i.test(reason)) message = 'This market does not support the order type or margin mode Grid needs. Choose another market.';
  // Keep the actual failure: malformed fees, missing data and inadequate spreads are different problems.
  if (/stop/i.test(reason)) return issue(message, 'stop', 'Stop loss', 'grid-stop');
  if (/below.*minimum|underfund|cannot cover (?:all|the grid order)/i.test(reason)) return issue(message, 'direction-size', 'Investment', 'grid-investment');
  if (/maximum order|Order exceeds venue maximum|above.*maximum/i.test(reason)) return issue(message, 'direction-size', 'Investment', 'grid-investment');
  if (/leverage/i.test(reason)) return issue(message, 'direction-size', 'Leverage', 'grid-leverage');
  if (/fee|round-trip cost/i.test(reason)) return issue(message, 'fees', 'Fees & data', 'grid-feePercent');
  if (/investment|below.*minimum|underfund|transfer floor/i.test(reason)) return issue(message, 'direction-size', 'Investment', 'grid-investment');
  if (/collaps|duplicate|interval|geometry/i.test(reason)) return issue(message, 'direction-size', 'Number of grids', 'grid-intervals');
  if (staleData) return issue(message, 'fees', 'Fees & data');
  if (/reference price|range boundary|lower|upper/i.test(reason)) return issue(message, 'range', 'Range', 'grid-lower');
  if (/size scale|entryScale|profitScale/i.test(reason)) return issue(message, 'orders', 'Sizing', 'grid-entryScale');
  return issue(message, 'fees', 'Fees & data');
}
export function plannerMinimumRows(preview: PlannerPreview | null) {
  if (!preview) return [{ label: 'Minimum investment', value: 'Awaiting preview' }];
  const describe = (fact: PlannerPreview['minimum']) => fact.state === 'available' ? `${readableDecimal(fact.value)} USDC` : `Unavailable — ${fact.reason}`;
  const base = { label: 'Minimum investment', value: describe(preview.minimum) };
  if (preview.fee.state === 'unknown') return [base];
  const assumed = preview.assumedMinimum;
  if (preview.minimum.state === 'available' && assumed.state === 'available' && new D(preview.minimum.value).eq(assumed.value))
    return [{ ...base, label: 'Minimum investment · includes your fee assumption' }];
  return [base, { label: 'Minimum with your fee assumption', value: describe(assumed) }];
}
export function readableDecimal(value: string): string {
  const [whole, fraction] = value.split('.');
  const trimmed = fraction?.replace(/0+$/, '');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (trimmed ? '.' + trimmed : '');
}
export const readableTime = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
