import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { GRID_SETUP_INITIAL } from '../../client/src/lib/grid-setup-view';
import { plannerGridCountHint, plannerOrderSizeSummary, plannerOpeningMinimumSummary, plannerPreviewQuery, PlannerRequestGeneration, isPlannerPreview } from '../../client/src/lib/grid-planner-view';
import { previewGrid } from '../../server/grid-planner/preview';
import { marketSnapshot } from '../../server/grid-planner/market-snapshot';
import { observePacificaConstraints } from '../../server/protocol/market-constraints';
import { calculateGrid } from '../../server/grid-bot/engine';
import { explainPlannerIssue } from '../../server/grid-planner/order-explanation';
import type { ProtocolMarket } from '../../server/protocol/protocol-types';
import type { PlannerQuery } from '../../server/grid-planner/types';

const now = 1_800_000_000_000;
const form = { ...GRID_SETUP_INITIAL, market: 'BTC-PERP', investment: '300', leverage: '10', intervals: '50',
  lower: '90000', upper: '110000', stop: '85000' };
const query: PlannerQuery = { market: 'BTC-PERP', investment: '300', leverage: '10', intervals: 50, side: 'long',
  seed: true, lower: '90000', upper: '110000', stop: '85000', entryScale: 'flat', profitScale: 'flat', fee: null };
const market = marketSnapshot({ internalSymbol: 'BTC-PERP', protocolSymbol: 'BTC', fullName: 'Bitcoin', maxLeverage: 50, maxLeverageSource: 'venue',
  constraintObservation: observePacificaConstraints({ tick_size: '1', lot_size: '0.00001', min_order_size: '10',
    max_order_size: '5000000', min_tick: '0', max_tick: '1000000', isolated_only: false, instrument_type: 'perpetual' }, 'BTC-PERP', now) } as ProtocolMarket,
  { now: () => now, getMarkets: async () => [], cachedReference: () => ({ price: 100000, observedAt: now }), candles: async () => [] });

describe('current grid planner inputs', () => {
  it('uses the typed grid count in the helper, including invalid intermediate input', () => {
    expect(plannerGridCountHint('50')).toBe('50 grids make 51 price lines.');
    expect(plannerGridCountHint('1')).toBe('1 grid makes 2 price lines.');
    expect(plannerGridCountHint('100')).toBe('100 grids make 101 price lines.');
    for (const value of ['', '0', '101', '1.5', 'EXAMPLE']) expect(plannerGridCountHint(value)).toContain('Enter 1–100 grids');
  });

  it('serializes current investment, leverage, grids, side, seed, scales, market, range, stop and fee', () => {
    const current = plannerPreviewQuery(form, form.stop);
    expect(current.error).toBe('');
    expect(Object.fromEntries(new URLSearchParams(current.value))).toMatchObject({ investment: '300', leverage: '10', intervals: '50', side: 'long', seed: 'true' });
    for (const change of [{ investment: '30' }, { leverage: '1' }, { intervals: '10' }, { side: 'short' }, { seed: false },
      { entryScale: 'ascending' }, { profitScale: 'descending' }, { market: 'ETH-PERP' }, { lower: '91000' }, { upper: '111000' }, { feePercent: '0.01' }]) {
      expect(plannerPreviewQuery({ ...form, ...change }, form.stop).value).not.toBe(current.value);
    }
    expect(plannerPreviewQuery(form, '84000').value).not.toBe(current.value);
    expect(plannerPreviewQuery({ ...form, feePercent: 'EXAMPLE' }, form.stop).error).not.toBe('');
  });

  it('ignores late success, error and completion before cleanup when any input changes', async () => {
    const generation = new PlannerRequestGeneration();
    const inputKey = plannerPreviewQuery(form, form.stop).value;
    const request = generation.start(inputKey);
    for (const change of [{ investment: '30' }, { leverage: '1' }, { intervals: '10' }, { side: 'short' }, { seed: false }]) {
      let resolve!: (value: string) => void;
      const pending = new Promise<string>((done) => { resolve = done; });
      const changedKey = plannerPreviewQuery({ ...form, ...change }, form.stop).value;
      const updates: string[] = [];
      const completion = pending.then((value) => { if (request.current(changedKey)) updates.push(value); })
        .finally(() => { if (request.current(changedKey)) updates.push('finished'); });
      resolve('old preview'); await completion;
      expect(updates).toEqual([]);
      const failure = Promise.reject(Error('EXAMPLE old request failed'))
        .catch((error: Error) => { if (request.current(changedKey)) updates.push(error.message); });
      await failure; expect(updates).toEqual([]);
    }
    generation.invalidate();
    expect(request.signal.aborted).toBe(true);
    const replacement = generation.start(inputKey);
    expect(request.current(inputKey)).toBe(false);
    expect(replacement.current(inputKey)).toBe(true);
    const refresh = generation.start(inputKey);
    expect(replacement.current(inputKey)).toBe(false);
    expect(refresh.current(inputKey)).toBe(true);
  });

  it.each(['long', 'short'] as const)('passes the 300 USDC / 10× / 50-grid BTC minimum for %s with a starting position', (side) => {
    const preview = previewGrid({ ...query, side, stop: side === 'long' ? '85000' : '115000' }, market, now);
    expect(preview.state).not.toBe('rejected');
    expect(preview.reasons).toEqual([]);
    expect(preview.requestedPlan).not.toBeNull();
    const entries = preview.requestedPlan!.lines.filter(line => line.role === 'entry');
    const exits = preview.requestedPlan!.lines.filter(line => line.role === 'seed_exit');
    expect(entries).toHaveLength(25); expect(exits).toHaveLength(25);
    for (const line of [...entries, ...exits]) {
      expect(Number(line.notional)).toBeGreaterThanOrEqual(58.9);
      expect(Number(line.notional)).toBeLessThanOrEqual(60);
      expect(new Decimal(60).minus(line.notional).lt(new Decimal(line.price).mul('0.00001'))).toBe(true);
    }
    expect(plannerOrderSizeSummary(preview.requestedPlan, 'flat')).toBe('About $60 per grid order (equal sizes)');
  });

  it('updates the split when the seed changes and does not label a minimum-sized diagnostic as the requested size', () => {
    const unseeded = previewGrid({ ...query, seed: false }, market, now);
    expect(unseeded.requestedPlan?.seedQuantity).toBe('0');
    expect(plannerOrderSizeSummary(unseeded.requestedPlan, 'flat')).toBe('About $120 per grid order (equal sizes)');
    for (const change of [{ leverage: '1' }, { investment: '30' }]) {
      const underfunded = previewGrid({ ...query, ...change }, market, now);
      expect(underfunded.state).toBe('rejected');
      expect(underfunded.minimumPlan).not.toBeNull();
      expect(plannerOrderSizeSummary(underfunded.requestedPlan, 'flat')).toBeNull();
    }
    const scaled = previewGrid({ ...query, entryScale: 'ascending', investment: '1000' }, market, now);
    expect(plannerOrderSizeSummary(scaled.requestedPlan, 'ascending')).toContain('(scaled sizes)');
  });
  it.each(['long', 'short'] as const)('lifts the nearest BTC entries at $300 / 10x / 50 grids for %s and explains the count', side => {
    const preview = previewGrid({ ...query, side, entryScale: 'ascending', profitScale: 'ascending', fee: '0',
      stop: side === 'long' ? '85000' : '115000' }, market, now);
    expect(preview.reasons).toEqual([]); expect(isPlannerPreview(preview)).toBe(true);
    const plan = preview.requestedPlan!; expect(plan).not.toBeNull();
    const liftedOrdinals = plan.lines.filter(line => line.role === 'entry')
      .sort((a, b) => Math.abs(Number(a.price) - Number(plan.start)) - Math.abs(Number(b.price) - Number(plan.start)))
      .slice(0, 2).reverse().map(line => line.ordinal);
    expect(plan.openingOrderLift).toEqual({ count: 2, minimumQuote: '10', ordinals: liftedOrdinals });
    expect(plannerOpeningMinimumSummary(plan)).toBe('2 grid orders raised to the $10 minimum');
    expect(plan.lines.filter(line => line.role === 'entry').every(line => new Decimal(line.notional).gte(10))).toBe(true);
    expect(plan.lines.filter(line => line.role === 'seed_exit').some(line => new Decimal(line.notional).lt(10))).toBe(true);
    expect(new Decimal(plan.allocatedNotional).lte(3000)).toBe(true);
    const malformed = { ...preview, requestedPlan: { ...plan, openingOrderLift: { count: -1, minimumQuote: '10' } } };
    expect(isPlannerPreview(malformed)).toBe(false);
  });
});

describe('opening minimum and reduce-only lot floor', () => {
  const input = { side: 'short' as const, lower: '10', upper: '30', start: '20', intervals: 2, entryScale: 'flat' as const, profitScale: 'flat' as const,
    seed: false, leverage: '1', tick: '0.1', lot: '0.1', minimumQuote: '10', investmentStep: '0.01', transferFloor: '0', investment: '12' };
  it('accepts a paired exit under $10 while rejecting an entry under $10', () => {
    const result = calculateGrid(input);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.plan.lines[2].quantity).toBe('0.4');
    const small = { ...input, investment: '9' }, rejected = calculateGrid(small);
    expect(rejected.ok).toBe(false); if (rejected.ok) return;
    expect(explainPlannerIssue(rejected.issues[0], small)).toContain('cannot cover the grid order at the $10 minimum');
  });
  it('accepts a seed take-profit under $10 and rejects one below a lot', () => {
    const seeded = { ...input, side: 'long' as const, upper: '40', intervals: 3, seed: true, profitScale: 'descending' as const, investment: '36' };
    const result = calculateGrid(seeded);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.plan.lines[3]).toMatchObject({ role: 'seed_exit', quantity: '0.2', notional: '8' });
    const tiny = { ...seeded, lot: '0.3' };
    const zero = calculateGrid(tiny);
    expect(zero.ok).toBe(false); if (zero.ok) return;
    expect(zero.issues[0]).toMatchObject({ ordinal: 3, reason: 'Lot-rounded line is below one lot' });
    expect(explainPlannerIssue(zero.issues[0], tiny)).toContain("smallest quantity step (0.3 base units)");
  });
});
