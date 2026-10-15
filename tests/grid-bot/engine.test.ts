import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { calculateGrid, calculateGridPrices, minimumInvestment, validGridDecimal } from '../../server/grid-bot/engine';
import type { GridInput, Scale } from '../../server/grid-bot/engine-types';
const base: GridInput = { side: 'long', lower: '80', upper: '120', start: '100', intervals: 4, entryScale: 'flat', profitScale: 'flat',
  seed: true, leverage: '1', tick: '0.1', lot: '0.01', minimumQuote: '10', investmentStep: '0.01', transferFloor: '0',
  investment: '1000', effectiveMakerCostRate: null };
const scales: Scale[] = ['flat', 'ascending', 'descending'];
describe('shared exact grid geometry', () => {
  it.each([1, 4, 17, 100])('price-only geometry matches sized plans at %s intervals across direction, seed and scales', intervals => {
    const geometry = { lower: '80.123', upper: '120.987', intervals, tick: '0.1' };
    const prices = calculateGridPrices(geometry);
    expect(prices.ok).toBe(true); if (!prices.ok) return;
    expect(prices.lines[0]).toEqual({ ordinal: 0, price: '80.1' });
    expect(prices.lines.at(-1)).toEqual({ ordinal: intervals, price: '120.9' });
    for (const side of ['long', 'short'] as const) for (const seed of [true, false]) for (const scale of scales) {
      const sized = calculateGrid({ ...base, ...geometry, side, seed, entryScale: scale, profitScale: scale, investment: '1000000' });
      expect(sized.ok).toBe(true); if (!sized.ok) continue;
      expect(sized.plan.lines.map(({ ordinal, price }) => ({ ordinal, price }))).toEqual(prices.lines);
    }
    expect(prices.lines.every(line => Object.keys(line).sort().join(',') === 'ordinal,price')).toBe(true);
  });
  it.each([
    { lower: '100', upper: '100.1', intervals: 4, tick: '0.1' },
    { lower: '0.01', upper: '0.02', intervals: 1, tick: '1' },
    { lower: '120', upper: '80', intervals: 4, tick: '0.1' },
    { lower: '1e2', upper: '120', intervals: 4, tick: '0.1' },
    { lower: '80', upper: '120', intervals: 101, tick: '0.1' },
  ])('rejects unusable price-only geometry without sizes: %j', input => {
    const result = calculateGridPrices(input);
    expect(result.ok).toBe(false); expect(result).not.toHaveProperty('lines'); expect(result).not.toHaveProperty('plan');
  });
  for (const side of ['long', 'short'] as const) for (const seed of [true, false]) for (const entryScale of scales) for (const profitScale of scales)
    it(`${side} seed=${seed} ${entryScale}/${profitScale}: conservation, roles and paired prices`, () => {
      const input = { ...base, side, seed, entryScale, profitScale }, result = calculateGrid(input);
      expect(result.ok).toBe(true); if (!result.ok) return;
      const { lines, seedQuantity, allocatedNotional, unallocatedNotional } = result.plan;
      expect(lines.map(l => l.price)).toEqual(['80', '90', '100', '110', '120']);
      expect(lines[2]).toMatchObject({ role: 'virtual', quantity: '0', notional: '0' });
      expect(new Decimal(allocatedNotional).plus(unallocatedNotional).eq(1000)).toBe(true);
      expect(new Decimal(unallocatedNotional).lt(lines.filter(l => l.role !== 'virtual').reduce((a,l) => a.plus(new Decimal(l.price).times(base.lot)), new Decimal(0)))).toBe(true);
      expect(new Decimal(seedQuantity).eq(lines.filter(l => l.role === 'seed_exit').reduce((a,l) => a.plus(l.quantity), new Decimal(0)))).toBe(true);
      for (const line of lines.filter(l => l.role === 'entry')) {
        expect(new Decimal(line.quantity).mod(base.lot).isZero()).toBe(true);
        expect(line.pairedExitOrdinal).toBe(line.ordinal + (side === 'long' ? 1 : -1));
        expect(new Decimal(line.quantity).times(lines[line.pairedExitOrdinal!].price).gte(10)).toBe(true);
      }
      if (!seed) expect(calculateGrid({ ...input, profitScale: 'flat' })).toEqual(result);
      if (entryScale !== 'flat') {
        const best = side === 'long' ? lines[0] : lines[4], near = side === 'long' ? lines[1] : lines[3];
        expect(new Decimal(best.notional).gt(near.notional)).toBe(entryScale === 'ascending');
      }
    });
  it('rejects collapsed ticks and quantized start boundary', () => {
    expect(calculateGrid({ ...base, tick: '50' })).toMatchObject({ ok: false, issues: [{ code: 'duplicate_prices' }] });
    expect(calculateGrid({ ...base, start: '80.09' })).toMatchObject({ ok: false, issues: [{ code: 'invalid_start' }] });
  });
  it('bounds intervals and decimal envelope and enforces quote alignment', () => {
    expect(calculateGrid({ ...base, intervals: 100, investment: '100000' }).ok).toBe(true);
    expect(calculateGrid({ ...base, intervals: 101 }).ok).toBe(false);
    for (const value of ['1e2', '-1', 'NaN', '1 ', '1000000000000000000', '0.0000000000000000001', 'EXAMPLE']) expect(validGridDecimal(value)).toBe(false);
    expect(validGridDecimal('0')).toBe(false); expect(validGridDecimal('0', true)).toBe(true);
    expect(calculateGrid({ ...base, investment: '1000.001' })).toMatchObject({ ok: false, issues: [{ code: 'invalid_investment' }] });
  });
  it('short paired exit minimum determines the true minimum and preceding cent fails', () => {
    const input = { ...base, side: 'short' as const, lower: '10', upper: '30', start: '20', intervals: 2, seed: false, minimumQuote: '10', lot: '0.1' };
    const minimum = minimumInvestment(input);
    expect(minimum).toMatchObject({ ok: true, investment: '15' });
    if (minimum.ok) {
      expect(calculateGrid({ ...input, investment: '14.99' })).toMatchObject({ ok: false, issues: [{ code: 'underfunded' }] });
      expect(minimum.plan.lines[2].quantity).toBe('0.5'); expect(minimum.evaluations).toBeLessThanOrEqual(260);
    }
  });
  it('unknown fee is unevaluated; explicit zero is evaluated; exact equality fails', () => {
    const input = { ...base, lower: '99.5', upper: '100.5', start: '100', intervals: 1, tick: '0.1', seed: false };
    expect(calculateGrid(input)).toMatchObject({ ok: true, plan: { feeGate: 'not_evaluated', feeRows: [] } });
    expect(calculateGrid({ ...input, effectiveMakerCostRate: '0' })).toMatchObject({ ok: true, plan: { feeGate: 'evaluated', feeRows: [{ clears: true, requiredSpread: '0' }] } });
    expect(calculateGrid({ ...input, effectiveMakerCostRate: '0.005' })).toMatchObject({ ok: false, issues: [{ code: 'fee_clearance' }] });
    expect(minimumInvestment({ ...input, effectiveMakerCostRate: '0.005' }).evaluations).toBe(1);
    expect(calculateGrid({ ...input, effectiveMakerCostRate: '0.004999' }).ok).toBe(true);
  });
  it('private decimal configuration is immune to hostile global settings', () => {
    const before = calculateGrid(base), precision = Decimal.precision, rounding = Decimal.rounding;
    try { Decimal.set({ precision: 3, rounding: Decimal.ROUND_UP }); expect(calculateGrid(base)).toEqual(before); }
    finally { Decimal.set({ precision, rounding }); }
  });
  it('search stops at its finite envelope without looping on non-funding errors', () => {
    expect(minimumInvestment({ ...base, tick: '50' })).toMatchObject({ ok: false, evaluations: 1 });
    const result = minimumInvestment({ ...base, minimumQuote: '999999999999999999', investmentStep: '0.000000000000000001' });
    expect(result.ok).toBe(false); expect(result.evaluations).toBeLessThanOrEqual(260);
  });
});
