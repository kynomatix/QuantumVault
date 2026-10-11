import Decimal from 'decimal.js';
import { calculateGrid, minimumInvestment, assumedPairFees, validGridDecimal } from '../grid-bot/engine';
import type { GridGeometryInput } from '../grid-bot/engine-types';
import { PLANNER_POLICY, type PlannerMarket, type PlannerPreview, type PlannerQuery } from './types';
import { unknown } from './market-snapshot';
const D = Decimal.clone({ precision: 120 });

export function validatePreviewQuery(q: PlannerQuery): string | null {
  for (const field of ['lower', 'upper', 'leverage', 'investment', 'stop'] as const)
    if (!validGridDecimal(q[field])) return `${field}: enter a positive plain decimal (up to 18 decimal places)`;
  if (q.fee !== null && !validGridDecimal(q.fee, true)) return 'Fee assumption must be a nonnegative plain decimal';
  if (!['long', 'short'].includes(q.side) || !['flat', 'ascending', 'descending'].includes(q.entryScale)
    || !['flat', 'ascending', 'descending'].includes(q.profitScale) || !Number.isInteger(q.intervals) || q.intervals < 1 || q.intervals > 100)
    return 'Invalid direction, size scale or interval count';
  return null;
}

export function previewGrid(q: PlannerQuery, market: PlannerMarket, now: number): PlannerPreview {
  const result: PlannerPreview = { state: 'unavailable', reasons: [], market, retrievedAt: now, validForMs: 0,
    requestedPlan: null, minimumPlan: null, minimum: unknown('Geometry not evaluated'), assumedMinimum: unknown('Assumed fee not evaluated'), feeRows: [],
    fee: q.fee === null ? { state: 'unknown' } : { state: 'assumption', rate: q.fee, label: 'Your assumption — not a venue quote' },
    stop: { state: 'unavailable', reason: 'Liquidation clearance is unknown; no account or position is read. This stop is not certified reachable.' }, policy: PLANNER_POLICY };
  const invalid = validatePreviewQuery(q);
  if (invalid) return { ...result, state: 'rejected', reasons: [invalid] };
  if (market.market !== q.market || market.constraints.state !== 'available' || market.reference.state !== 'available') {
    result.reasons = [market.market !== q.market ? 'Market identity mismatch' : market.constraints.state === 'unavailable'
      ? market.constraints.reason : market.reference.state === 'unavailable' ? market.reference.reason : 'Market unavailable'];
    return result;
  }
  const c = market.constraints.value, r = market.reference.value;
  if (now < c.observedAt || now > c.expiresAt || now < r.observedAt || now > r.expiresAt) return { ...result, reasons: ['Market observations expired or are future-dated'] };
  result.validForMs = Math.max(0, Math.min(c.expiresAt, r.expiresAt) - now);
  if (c.maxLeverage.state === 'available' && new D(q.leverage).gt(c.maxLeverage.value)) return { ...result, state: 'rejected', reasons: ['Leverage exceeds the observed Pacifica maximum'] };
  if (new D(q.leverage).lt(1)) return { ...result, state: 'rejected', reasons: ['Leverage must be at least 1'] };
  const stop = new D(q.stop), tick = new D(c.tick);
  if (!stop.mod(tick).isZero() || (q.side === 'long' ? !stop.lt(q.lower) : !stop.gt(q.upper)))
    return { ...result, state: 'rejected', reasons: ['Stop must align to the venue tick and lie beyond the loss side of the range'] };
  const input: GridGeometryInput = { side: q.side, lower: q.lower, upper: q.upper, start: r.price,
    intervals: q.intervals, entryScale: q.entryScale, profitScale: q.profitScale, seed: q.seed, leverage: q.leverage,
    tick: c.tick, lot: c.lot, minimumQuote: c.minimumQuote, investmentStep: '0.01',
    // Geometry-only capital model. No account transfer is proposed or inferred.
    transferFloor: '0', effectiveMakerCostRate: null };
  const minimum = minimumInvestment(input);
  const requested = calculateGrid({ ...input, investment: q.investment });
  result.minimum = minimum.ok ? { state: 'available', value: minimum.investment } : unknown(minimum.issues.map(i => i.reason).join('; '));
  result.requestedPlan = requested.ok ? requested.plan : null;
  result.minimumPlan = !requested.ok && minimum.ok ? minimum.plan : null;
  if (!requested.ok) result.reasons.push(...requested.issues.map(i => i.reason));
  const diagnostic = result.requestedPlan ?? result.minimumPlan;
  let feePassed = false;
  if (q.fee !== null && diagnostic) {
    result.feeRows = assumedPairFees(diagnostic, q.fee);
    const assumed = minimumInvestment({ ...input, effectiveMakerCostRate: q.fee });
    result.assumedMinimum = assumed.ok ? { state: 'available', value: assumed.investment } : unknown(assumed.issues.map(i => i.reason).join('; '));
    feePassed = assumed.ok && result.feeRows.every(row => row.clears);
    if (!feePassed) result.reasons.push('Assumed fee check failed; diagnostic rows remain visible');
  }
  const missing = [c.maxLeverage, c.maximumQuote, c.priceBounds, c.restrictions].filter(fact => fact.state === 'unavailable');
  for (const fact of missing) if (fact.state === 'unavailable') result.reasons.push(fact.reason);
  result.state = !requested.ok || q.fee !== null && !feePassed ? 'rejected'
    : q.fee === null || missing.length ? 'diagnostic' : 'hypothetical_checks_passed';
  return result;
}
