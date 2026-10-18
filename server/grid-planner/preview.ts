import Decimal from 'decimal.js';
import { GRID_CYCLE_V2_CREATION } from '../grid-bot/cycle-policy';
import { GRID_LEAN_SIZING_CREATION } from '../grid-bot/lean-sizing';
import { gridSeedPriceBounds } from '../grid-bot/cycle-engine';
import { calculateGrid, calculateGridPrices, minimumInvestment, assumedPairFees, validGridDecimal } from '../grid-bot/engine';
import type { GridGeometryInput } from '../grid-bot/engine-types';
import { PLANNER_POLICY, type PlannerMarket, type PlannerPreview, type PlannerQuery } from './types';
import { unknown } from './market-snapshot';
import { dollars, explainPlannerIssue } from './order-explanation';
const D = Decimal.clone({ precision: 120 });

export function validatePreviewQuery(q: PlannerQuery): string | null {
  for (const field of ['lower', 'upper'] as const)
    if (!validGridDecimal(q[field])) return `${field}: enter a positive plain decimal (up to 18 decimal places)`;
  if (!Number.isInteger(q.intervals) || q.intervals < 1 || q.intervals > 100) return 'Invalid interval count';
  if (q.investment === '') return null;
  for (const field of ['leverage', 'investment', 'stop'] as const)
    if (!validGridDecimal(q[field])) return `${field}: enter a positive plain decimal (up to 18 decimal places)`;
  if (q.fee !== null && !validGridDecimal(q.fee, true)) return 'Fee assumption must be a nonnegative plain decimal';
  if (!['long', 'short'].includes(q.side) || !['flat', 'ascending', 'descending'].includes(q.entryScale)
    || !['flat', 'ascending', 'descending'].includes(q.profitScale) || !Number.isInteger(q.intervals) || q.intervals < 1 || q.intervals > 100)
    return 'Invalid direction, size scale or interval count';
  return null;
}

export function previewGrid(q: PlannerQuery, market: PlannerMarket, now: number,
  deps: { cycleV2Creation?: boolean; leanSizingCreation?: boolean } = {}): PlannerPreview {
  const result: PlannerPreview = { state: 'unavailable', reasons: [], market, retrievedAt: now, validForMs: 0,
    geometry: unknown('Geometry not evaluated'),
    requestedPlan: null, minimumPlan: null, minimum: unknown('Geometry not evaluated'), assumedMinimum: unknown('Assumed fee not evaluated'), feeRows: [],
    fee: q.investment === '' || q.fee === null ? { state: 'unknown' } : { state: 'assumption', rate: q.fee, label: 'Your assumption — not a venue quote' },
    stop: { state: 'unavailable', reason: 'Liquidation clearance is unknown; no account or position is read. This stop is not certified reachable.' }, policy: PLANNER_POLICY };
  const invalid = validatePreviewQuery(q);
  if (invalid) return { ...result, state: 'rejected', reasons: [invalid] };
  if (q.investment === '') {
    const needsInvestment = unknown<string>('Enter an investment to see order sizes');
    result.minimum = needsInvestment; result.assumedMinimum = needsInvestment;
    if (market.market !== q.market || market.constraints.state !== 'available')
      return { ...result, reasons: [market.market !== q.market ? 'Market identity mismatch' : market.constraints.state === 'unavailable' ? market.constraints.reason : 'Market unavailable'] };
    const c = market.constraints.value;
    if (now < c.observedAt || now >= c.expiresAt)
      return { ...result, reasons: ['Market observations expired or are future-dated'] };
    const geometry = calculateGridPrices({ lower: q.lower, upper: q.upper, intervals: q.intervals, tick: c.tick });
    if (!geometry.ok) return { ...result, state: 'rejected', reasons: geometry.issues.map(issue => issue.reason) };
    return { ...result, state: 'diagnostic', validForMs: Math.min(60_000, c.expiresAt - now), geometry: { state: 'available', value: geometry.lines } };
  }
  if (market.market !== q.market || market.constraints.state !== 'available' || market.reference.state !== 'available') {
    result.reasons = [market.market !== q.market ? 'Market identity mismatch' : market.constraints.state === 'unavailable'
      ? market.constraints.reason : market.reference.state === 'unavailable' ? market.reference.reason : 'Market unavailable'];
    return result;
  }
  const c = market.constraints.value, r = market.reference.value;
  if (now < c.observedAt || now > c.expiresAt || now < r.observedAt || now > r.expiresAt) return { ...result, reasons: ['Market observations expired or are future-dated'] };
  result.validForMs = Math.max(0, Math.min(c.expiresAt, r.expiresAt) - now);
  if (c.maxLeverage.state === 'available' && new D(q.leverage).gt(c.maxLeverage.value)) return { ...result, state: 'rejected', reasons: [`Pacifica allows up to ${c.maxLeverage.value}× leverage for this market. Lower the leverage.`] };
  if (new D(q.leverage).lt(1)) return { ...result, state: 'rejected', reasons: ['Leverage must be at least 1'] };
  const stop = new D(q.stop), tick = new D(c.tick);
  if (!stop.mod(tick).isZero() || (q.side === 'long' ? !stop.lt(q.lower) : !stop.gt(q.upper)))
    return { ...result, state: 'rejected', reasons: ['Stop must align to the venue tick and lie beyond the loss side of the range'] };
  const cyclic=deps.cycleV2Creation ?? GRID_CYCLE_V2_CREATION, lean=cyclic && (deps.leanSizingCreation ?? GRID_LEAN_SIZING_CREATION);
  const reserveFactor=lean?new D(1).plus(new D(q.leverage).mul(q.fee??'0')):new D(1);
  const input: GridGeometryInput = { policyVersion: cyclic ? '2.0.0' : '1.0.0', side: q.side, lower: q.lower, upper: q.upper, start: r.price,
    ...(lean?{sizingVersion:'lean-1' as const,safetyEnvelopePrice:D.max(q.upper,q.seed?gridSeedPriceBounds(r.price,c.tick).high:'0',q.side==='short'?q.stop:'0').toFixed()}:{}),
    intervals: q.intervals, entryScale: q.entryScale, profitScale: q.profitScale, seed: q.seed, leverage: q.leverage,
    tick: c.tick, lot: c.lot, minimumQuote: c.minimumQuote, investmentStep: '0.01',
    // Geometry-only capital model. No account transfer is proposed or inferred.
    transferFloor: '0', effectiveMakerCostRate: null };
  const minimum = minimumInvestment(input);
  const requested = calculateGrid({ ...input, investment: lean ? new D(q.investment).div(reserveFactor).toDecimalPlaces(2,D.ROUND_FLOOR).toFixed(2) : q.investment });
  result.minimum = minimum.ok ? { state: 'available', value: lean ? new D(minimum.investment).mul(reserveFactor).toDecimalPlaces(2,D.ROUND_CEIL).toFixed(2) : minimum.investment } : unknown(minimum.issues.map(i => i.reason).join('; '));
  result.requestedPlan = requested.ok ? requested.plan : null;
  result.minimumPlan = !requested.ok && minimum.ok ? minimum.plan : null;
  if (!requested.ok) result.reasons.push(...requested.issues.map(i => explainPlannerIssue(i, { ...input, investment: q.investment })));
  let venueRejected = false;
  if (requested.ok) {
    const lines = requested.plan.lines.filter(line => line.role !== 'virtual');
    if (c.maximumQuote.state === 'available') {
      const maximum = c.maximumQuote.value, tooLarge = lines.find(line => new D(line.notional).gt(maximum));
      if (tooLarge) { venueRejected = true; result.reasons.push(`A grid order would be $${dollars(tooLarge.notional)}, above Pacifica's $${dollars(maximum)} maximum. Lower the investment or leverage, or use more grids.`); }
    }
    if (c.priceBounds.state === 'available') {
      const { minimum, maximum } = c.priceBounds.value;
      if ([...lines.map(line => line.price), q.stop].some(price => new D(price).lt(minimum) || new D(price).gt(maximum))) {
        venueRejected = true; result.reasons.push(`Pacifica accepts prices from $${minimum} to $${maximum}. Move the range and stop loss inside those limits.`);
      }
    }
    if (c.restrictions.state === 'available' && c.restrictions.value !== 'unrestricted') {
      venueRejected = true; result.reasons.push(c.restrictions.value === 'isolated_only'
        ? 'This market requires isolated margin, which Grid does not support. Choose another market.'
        : 'This market does not support the perpetual order-book orders Grid needs. Choose another market.');
    }
  }
  const diagnostic = result.requestedPlan ?? result.minimumPlan;
  let feePassed = false;
  if (q.fee !== null && diagnostic) {
    result.feeRows = assumedPairFees(diagnostic, q.fee);
    const assumed = minimumInvestment({ ...input, effectiveMakerCostRate: q.fee });
    result.assumedMinimum = assumed.ok ? { state: 'available', value: lean ? new D(assumed.investment).mul(reserveFactor).toDecimalPlaces(2,D.ROUND_CEIL).toFixed(2) : assumed.investment } : unknown(assumed.issues.map(i => i.reason).join('; '));
    feePassed = assumed.ok && result.feeRows.every(row => row.clears);
    if (!feePassed) result.reasons.push('Assumed fee check failed; diagnostic rows remain visible');
  }
  const missing = [c.maxLeverage, c.maximumQuote, c.priceBounds, c.restrictions].filter(fact => fact.state === 'unavailable');
  if (c.maxLeverage.state === 'unavailable') result.reasons.push('Pacifica’s leverage limit is unavailable. Refresh market data before choosing leverage.');
  result.state = !requested.ok || venueRejected || q.fee !== null && !feePassed ? 'rejected'
    : q.fee === null || missing.length ? 'diagnostic' : 'hypothetical_checks_passed';
  return result;
}
