import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GridPlannerCard } from '../../client/src/components/grid-planner/GridPlannerCard';
import { GridDraftCard } from '../../client/src/components/grid-bot/GridDraftCard';
import { GridPlannerChart } from '../../client/src/components/grid-planner/GridPlannerChart';
import { feePercentToRate, PlannerRequestGeneration, plannerOverlays, isPlannerMarket, isPlannerChart, isPlannerPreview,
  PLANNING_BANNER, ASSUMPTION_LABEL, readableDecimal, clientObservationDeadline, plannerRangeAround,
  proposedPlannerStop, plannerChartRange, type PlannerChart } from '../../client/src/lib/grid-planner-view';
import { previewGrid } from '../../server/grid-planner/preview';
import { marketSnapshot } from '../../server/grid-planner/market-snapshot';
import { observePacificaConstraints } from '../../server/protocol/market-constraints';
import type { ProtocolMarket } from '../../server/protocol/protocol-types';
const now = 1_800_000_000_000;
const market = marketSnapshot({ internalSymbol: 'BTC-PERP', protocolSymbol: 'BTC', fullName: 'Bitcoin', maxLeverage: 50, maxLeverageSource: 'venue',
  constraintObservation: observePacificaConstraints({ tick_size: '0.1', lot_size: '0.01', min_order_size: '10' }, 'BTC-PERP', now) } as ProtocolMarket,
  { now: () => now, cachedReference: () => ({ price: 100, observedAt: now }), getMarkets: async () => [], candles: async () => [] });
const preview = previewGrid({ market: 'BTC-PERP', side: 'long', lower: '80', upper: '120', intervals: 4, entryScale: 'flat', profitScale: 'flat', seed: true,
  leverage: '1', investment: '1000', stop: '70', fee: '0' }, market, now);
describe('Planner client authority boundaries', () => {
  it('blank, explicit zero and decimal percentages preserve meaning without floats', () => {
    expect(feePercentToRate('')).toBeNull(); expect(feePercentToRate('0')).toBe('0'); expect(feePercentToRate('0.05')).toBe('0.0005');
    expect(feePercentToRate('1.2345678901234567')).toBe('0.012345678901234567');
    for (const value of ['-1', '1e-3', ' 0', '0.00000000000000001', 'EXAMPLE']) expect(() => feePercentToRate(value)).toThrow();
    expect(PLANNING_BANNER).toBe('Planning only — no orders are placed'); expect(ASSUMPTION_LABEL).toBe('Your assumption — not a venue quote');
  });
  it('A-B-A and same-query refresh never accept a superseded response, even if abort is ignored', async () => {
    const generation = new PlannerRequestGeneration(), updates: string[] = [];
    const oldA = generation.start(), b = generation.start(), newA = generation.start();
    await Promise.resolve(); for (const [token, value] of [[oldA, 'old A'], [b, 'B'], [newA, 'new A']] as const) if (token.current()) updates.push(value);
    expect(updates).toEqual(['new A']); expect(oldA.signal.aborted).toBe(true); expect(b.signal.aborted).toBe(true);
    const refresh = generation.start(); expect(newA.current()).toBe(false); generation.invalidate(); expect(refresh.current()).toBe(false);
  });
  it('close/unmount/identity invalidation clears all resource ownership; unrelated resources are independent', () => {
    const resources = [new PlannerRequestGeneration(), new PlannerRequestGeneration(), new PlannerRequestGeneration()];
    const tokens = resources.map(r => r.start()); resources[2].invalidate(); expect(tokens[0].current()).toBe(true);
    resources.forEach(r => r.invalidate()); expect(tokens.every(t => !t.current() && t.signal.aborted)).toBe(true);
  });
  it('strict runtime guards accept real API objects and refuse mismatched provenance or malformed rows', () => {
    expect(isPlannerMarket(market)).toBe(true); expect(isPlannerPreview(preview)).toBe(true);
    expect(isPlannerPreview({ ...preview, requestedPlan: { ...preview.requestedPlan, lines: [{ price: 'EXAMPLE' }] } })).toBe(false);
    expect(isPlannerPreview({ ...preview, fee: { state: 'assumption', rate: '0', label: 'Venue fee' } })).toBe(false);
    expect(isPlannerMarket({ ...market, reference: { state: 'available', value: { price: '0', observedAt: now, expiresAt: now + 60000 } } })).toBe(false);
    expect(isPlannerChart({ state: 'available', candles: [] })).toBe(false);
  });
  it('only current, accepted requested geometry draws overlays; rejected and expired geometry clears', () => {
    expect(plannerOverlays(preview, now + 60000, now)).toHaveLength(5);
    expect(plannerOverlays(preview, now + 60000, now + 60000)).toEqual([]);
    expect(plannerOverlays({ ...preview, state: 'rejected' }, now + 60000, now)).toEqual([]);
    expect(plannerOverlays({ ...preview, requestedPlan: null, minimumPlan: preview.requestedPlan }, now + 60000, now)).toEqual([]);
    expect(plannerOverlays(null, now + 60000, now)).toEqual([]);
  });
  it('observation deadlines subtract transit and do not depend on client/server wall-clock agreement', () => {
    expect(clientObservationDeadline(now + 60_000, now, 1000)).toBe(61_000);
    expect(clientObservationDeadline(now - 1, now, 1000)).toBe(1000);
  });
  it('range shortcuts use an observed price and recheck expiry at click time', () => {
    const deadline = now + 60_000;
    expect(plannerRangeAround(market, deadline, now, 5)).toEqual({ lower: '95', upper: '105' });
    expect(plannerRangeAround(market, deadline, now, 10)).toEqual({ lower: '90', upper: '110' });
    expect(plannerRangeAround(market, deadline, now, 20)).toEqual({ lower: '80', upper: '120' });
    expect(plannerRangeAround(market, deadline, deadline, 10)).toBeNull();
    expect(plannerRangeAround(undefined, deadline, now, 10)).toBeNull();
    expect(plannerRangeAround({ ...market, reference: { state: 'unavailable', reason: 'EXAMPLE' } }, deadline, now, 10)).toBeNull();
    for (const width of [0, 41, NaN, Infinity]) expect(plannerRangeAround(market, deadline, now, width)).toBeNull();
    const small = { ...market, reference: { ...market.reference, state: 'available' as const,
      value: { price: '0.00000123', observedAt: now, expiresAt: deadline, label: 'Cached Pacifica book reference price' as const } } };
    expect(plannerRangeAround(small, deadline, now, 5)).toEqual({ lower: '0.0000011685', upper: '0.0000012915' });
  });
  it('proposed stops round outwards to the tick; manual invalid inputs never become chart prices', () => {
    expect(proposedPlannerStop('95', '105', 'long', '0.1')).toBe('92.1');
    expect(proposedPlannerStop('95', '105', 'short', '0.1')).toBe('108.2');
    expect(proposedPlannerStop('0.000001', '0.000002', 'long', '0.00000001')).toBe('0.00000097');
    expect(proposedPlannerStop('0.01', '0.02', 'long', '1')).toBeNull();
    for (const lower of ['', '0', '-1', '1e-3', 'EXAMPLE', '105']) {
      expect(proposedPlannerStop(lower, '105', 'long', '0.1')).toBeNull();
      expect(plannerChartRange(lower, '105', '90')).toBeNull();
    }
    expect(plannerChartRange('95', '105', 'EXAMPLE')).toEqual({ lower: '95', upper: '105', stop: null });
    expect(plannerChartRange('95', '105', '92.1')).toEqual({ lower: '95', upper: '105', stop: '92.1' });
  });
  it('chart captions preserve provenance, partial coverage, expiry and unavailable explanations', () => {
    const chart: PlannerChart = { state: 'available', market: 'BTC-PERP', timeframe: '15m', requestedBars: 100, actualBars: 1,
      partial: true, retrievedAt: now, cacheInsertedAt: now, validForMs: 60_000,
      candles: [{ time: now - 900_000, open: 100, high: 101, low: 99, close: 100, volume: 1,
        provenance: { source: 'okx', venue: 'okx', basis: 'perp', proxy: 'direct', timeSemantic: 'open_time', finality: 'forming' } }] };
    expect(isPlannerChart(chart)).toBe(true);
    const html = renderToStaticMarkup(createElement(GridPlannerChart, { chart, lines: [], range: null, stale: false }));
    for (const text of ['OKX direct perpetual candles', '15m', '1/100 bars', 'partial coverage', 'opening times', 'forming candles', 'separate from the Pacifica', 'Expand Planner chart']) expect(html).toContain(text);
    const expired = renderToStaticMarkup(createElement(GridPlannerChart, { chart, lines: [], range: null, stale: true }));
    expect(expired).toContain('Chart cache expired');
    const unavailable = renderToStaticMarkup(createElement(GridPlannerChart, { chart: { state: 'unavailable', reason: 'EXAMPLE' }, lines: [], range: null, stale: false }));
    expect(unavailable).toContain('Chart unavailable: EXAMPLE');
  });
  it('planner flags coexist with a truthful Grid surface and never offer a live start', () => {
    for (const props of [{ authenticated: false, identity: null }, { authenticated: true, identity: 'EXAMPLE' }]) {
      const html = renderToStaticMarkup(createElement(GridPlannerCard, props));
      expect(html).toBe('');
      // Before Grid is enabled (and with no Grid bots) the original coming-soon card stays.
      const live=renderToStaticMarkup(createElement(GridDraftCard,props));expect(live).toContain('card-grid-bot-coming-soon');expect(live).toContain('Coming soon');expect(live).not.toContain('Start bot');
    }
    expect(readableDecimal('123456.000001')).toBe('123,456.000001');
  });
});
