import { describe, it, expect, vi } from 'vitest';
import { observePacificaConstraints } from '../../server/protocol/market-constraints';
import type { ProtocolMarket } from '../../server/protocol/protocol-types';
import type { PlannerDeps, PlannerQuery } from '../../server/grid-planner/types';
import { marketSnapshot } from '../../server/grid-planner/market-snapshot';
import { previewGrid } from '../../server/grid-planner/preview';
import { proposedPlannerStop, plannerRangeAround } from '../../client/src/lib/grid-planner-view';
const now = 1_800_000_000_000;
export const row = (): ProtocolMarket => ({ internalSymbol: 'BTC-PERP', protocolSymbol: 'BTC', fullName: 'Bitcoin', maxLeverage: 50, maxLeverageSource: 'venue',
  constraintObservation: observePacificaConstraints({ tick_size: '0.1', lot_size: '0.01', min_order_size: '10' }, 'BTC-PERP', now),
  constraintAuthority: { state: 'unavailable', venue: 'pacifica', market: 'BTC-PERP', source: '/info', reason: 'EXAMPLE', refreshFailed: false },
  isActive: true, category: ['crypto'], maintenanceMarginWeight: 0.01, riskTier: 'recommended', estimatedSlippagePct: 0.01 });
export const deps = (): PlannerDeps => ({ now: () => now, getMarkets: vi.fn(async () => [row()]),
  cachedReference: vi.fn(() => ({ price: 100, observedAt: now })), candles: vi.fn(async () => []) });
const query: PlannerQuery = { market: 'BTC-PERP', side: 'long', lower: '80', upper: '120', intervals: 4, entryScale: 'flat', profitScale: 'flat',
  seed: true, investment: '1000', leverage: '1', stop: '70', fee: null };
describe('Pacifica authority and honest planner verdicts', () => {
  it('uses original observation clocks and refuses to fabricate missing maxima', () => {
    const m = marketSnapshot(row(), deps());
    expect(m.constraints).toMatchObject({ state: 'available', value: { tick: '0.1', lot: '0.01', minimumQuote: '10', observedAt: now,
      maxLeverage: { state: 'available', value: '50' }, maximumQuote: { state: 'unavailable' }, priceBounds: { state: 'unavailable' }, restrictions: { state: 'unavailable' } } });
    expect(previewGrid({ ...query, fee: '0' }, m, now).state).toBe('diagnostic');
  });
  for (const key of ['tick', 'lot', 'openingMinimum'] as const) it(`missing ${key} never uses legacy fallback`, () => {
    const r = row(); r.constraintObservation![key] = null;
    Object.assign(r, { tickSize: 0.1, lotSize: 0.01, minOrderSizeUsd: 10 });
    expect(marketSnapshot(r, deps()).constraints.state).toBe('unavailable');
  });
  it('rejects wrong units, identity, copied clocks, failed refresh, stale and future observations', () => {
    const corruptions = [(r: ProtocolMarket) => { r.constraintObservation!.tick!.unit = 'base'; },
      (r: ProtocolMarket) => { r.constraintObservation!.market = 'ETH-PERP'; },
      (r: ProtocolMarket) => { r.constraintObservation!.expiresAt++; },
      (r: ProtocolMarket) => { r.constraintObservation!.refreshFailed = true; },
      (r: ProtocolMarket) => { r.constraintObservation!.observedAt = now - 300_001; r.constraintObservation!.expiresAt = now - 1; },
      (r: ProtocolMarket) => { r.constraintObservation!.observedAt++; r.constraintObservation!.expiresAt++; }];
    for (const corrupt of corruptions) { const r = row(); corrupt(r); expect(marketSnapshot(r, deps()).constraints.state).toBe('unavailable'); }
  });
  it('canonicalizes valid exact scientific venue decimals and rejects compatibility leverage', () => {
    const r = row(); r.constraintObservation = observePacificaConstraints({ tick_size: '1e-1', lot_size: '1e-2', min_order_size: '1e1' }, r.internalSymbol, now);
    r.maxLeverageSource = 'fallback';
    expect(marketSnapshot(r, deps()).constraints).toMatchObject({ state: 'available', value: { tick: '0.1', lot: '0.01', maxLeverage: { state: 'unavailable' } } });
  });
  it('cached reference is usable at 60 seconds but unavailable one millisecond later; unknown is not zero', () => {
    const d = deps(); d.cachedReference = () => ({ price: 100, observedAt: now - 60_000 });
    expect(marketSnapshot(row(), d).reference.state).toBe('available'); d.now = () => now + 1;
    expect(marketSnapshot(row(), d).reference).toMatchObject({ state: 'unavailable' });
    d.cachedReference = () => ({ price: 0, observedAt: now }); expect(marketSnapshot(row(), d).reference.state).toBe('unavailable');
  });
  it('keeps blank fee unknown and explicit zero visibly an assumption', () => {
    const m = marketSnapshot(row(), deps()), blank = previewGrid(query, m, now), zero = previewGrid({ ...query, fee: '0' }, m, now);
    expect(blank.fee).toEqual({ state: 'unknown' }); expect(blank.assumedMinimum.state).toBe('unavailable'); expect(blank.feeRows).toEqual([]);
    expect(zero.fee).toEqual({ state: 'assumption', rate: '0', label: 'Your assumption — not a venue quote' });
    expect(zero.feeRows.every(r => r.assumedRoundTripFee === '0')).toBe(true);
    expect(zero.stop.state).toBe('unavailable');
  });
  it('fee failure retains requested diagnostic quantities and rows; underfunding labels a separate minimum plan', () => {
    const m = marketSnapshot(row(), deps()), failed = previewGrid({ ...query, fee: '1' }, m, now);
    expect(failed.state).toBe('rejected'); expect(failed.requestedPlan).not.toBeNull(); expect(failed.feeRows.some(r => !r.clears)).toBe(true);
    const low = previewGrid({ ...query, investment: '0.01' }, m, now);
    expect(low).toMatchObject({ state: 'rejected', requestedPlan: null, minimum: { state: 'available' } }); expect(low.minimumPlan).not.toBeNull();
  });
  it('rejects invalid stops and leverage and invalidates expired references', () => {
    const m = marketSnapshot(row(), deps());
    expect(previewGrid({ ...query, stop: '80' }, m, now).state).toBe('rejected');
    expect(previewGrid({ ...query, stop: '70.01' }, m, now).state).toBe('rejected');
    expect(previewGrid({ ...query, leverage: '51' }, m, now).state).toBe('rejected');
    expect(previewGrid(query, m, now + 60_001)).toMatchObject({ state: 'unavailable', requestedPlan: null, validForMs: 0 });
  });
  it('primary range and suggested-stop shortcuts remain proposals checked by the server', () => {
    const m = marketSnapshot(row(), deps());
    const range = plannerRangeAround(m, now + 60_000, now, 10)!;
    for (const side of ['long', 'short'] as const) {
      const stop = proposedPlannerStop(range.lower, range.upper, side, '0.1')!;
      const result = previewGrid({ ...query, ...range, side, stop, fee: '0' }, m, now);
      expect(result.state).toBe('diagnostic'); expect(result.requestedPlan).not.toBeNull();
      expect(result.stop.state).toBe('unavailable');
      expect(previewGrid({ ...query, ...range, side, stop }, m, now + 60_001).state).toBe('unavailable');
    }
  });
});
