import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { alignLiquidationInputs, modelLiquidations, modelMultiVenueLiquidations, HOUR, LIQUIDATION_DAY, LEVERAGE_TIERS, MMR,
  LiquidationInputError } from '../../server/market-stats/liquidations-model';
import { END, hour, fullInputs } from './liquidations-fixtures';
const sum = (bins: [number, number][]) => bins.reduce((s, b) => s + b[0] + b[1], 0);
const oi = (rows: ReturnType<typeof hour>[]) => rows.map(h => ({ time: h.time, btc: h.oiBtc }));
function multi(hours: ReturnType<typeof hour>[], optional: Parameters<typeof modelMultiVenueLiquidations>[2]) {
  const result = modelMultiVenueLiquidations(hours, END, optional);
  if (!('venueAccounting' in result)) throw new Error('Expected v3 books');
  return result;
}
describe('oi-leverage-v2 model', () => {
  it('conserves entries, matches the fixed tier formulas and assumes a 50/50 split', () => {
    const result = modelLiquidations([hour(0, 100), hour(1, 120)], END);
    expect(result.accounting).toEqual({ enteredBtc: 20, retiredBtc: 0, sweptBtc: 0, liveBtc: 20 });
    expect(result.cohorts.filter(c => c.side === 0).reduce((s, c) => s + c.btc, 0)).toBe(10);
    LEVERAGE_TIERS.forEach((tier, i) => {
      expect(result.cohorts[2 * i]).toEqual({ side: 0, btc: 10 * tier.weight, price: 100 * (1 - 1 / tier.leverage + MMR) });
      expect(result.cohorts[2 * i + 1]).toEqual({ side: 1, btc: 10 * tier.weight, price: 100 * (1 + 1 / tier.leverage - MMR) });
    });
    expect(result.value.methodologyVersion).toBe('oi-leverage-v2');
    expect(sum(result.value.columns[0].bins)).toBe(2000);
  });
  it('retires each live cohort proportionally, including cohorts from different entry hours', () => {
    const before = modelLiquidations([hour(0, 100), hour(1, 120), hour(2, 140, 100.1)], END);
    const after = modelLiquidations([hour(0, 100), hour(1, 120), hour(2, 140, 100.1), hour(3, 130, 100.1)], END);
    expect(after.cohorts).toHaveLength(20);
    after.cohorts.forEach((c, i) => expect(c.btc).toBeCloseTo(before.cohorts[i].btc * 130 / 140));
    expect(after.accounting.retiredBtc).toBeCloseTo(40 * 10 / 140);
    expect(after.accounting.liveBtc).toBeCloseTo(40 * 130 / 140);
    const { enteredBtc, retiredBtc, sweptBtc, liveBtc } = after.accounting;
    expect(enteredBtc).toBeCloseTo(retiredBtc + sweptBtc + liveBtc);
  });
  it.each([80, 1])('preserves every unswept cohort when a large OI drop leaves %s BTC at the venue', oiBtc => {
    const base = [hour(0, 100), hour(1, 120)];
    const before = modelLiquidations(base, END);
    const after = modelLiquidations([...base, hour(2, oiBtc)], END);
    expect(120 - oiBtc).toBeGreaterThan(before.accounting.liveBtc);
    expect(after.cohorts).toHaveLength(before.cohorts.length);
    after.cohorts.forEach((c, i) => {
      expect(c.btc).toBeGreaterThan(0);
      expect(c.btc).toBeCloseTo(before.cohorts[i].btc * oiBtc / 120);
    });
    expect(after.accounting.liveBtc).toBeCloseTo(20 * oiBtc / 120);
    expect(after.accounting.retiredBtc).toBeCloseTo(20 * (1 - oiBtc / 120));
    expect(after.accounting.enteredBtc).toBeCloseTo(after.accounting.retiredBtc + after.accounting.sweptBtc + after.accounting.liveBtc);
  });
  it('retires the entire model only when venue OI falls to zero', () => {
    const result = modelLiquidations([hour(0, 100), hour(1, 120), hour(2, 0)], END);
    expect(result.accounting).toEqual({ enteredBtc: 20, retiredBtc: 20, sweptBtc: 0, liveBtc: 0 });
    expect(sum(result.value.columns[0].bins)).toBe(0);
    expect(result.cohorts).toEqual([]);
  });
  it('conserves entries across repeated venue OI drops, new entries and sweeps', () => {
    const result = modelLiquidations([hour(0, 100), hour(1, 120), { ...hour(2, 60), low: 99.5 },
      hour(3, 80), { ...hour(4, 40), high: 101 }], END);
    expect(result.accounting.enteredBtc).toBe(40);
    expect(result.accounting.retiredBtc).toBeCloseTo(24.75);
    expect(result.accounting.sweptBtc).toBeCloseTo(1.25);
    expect(result.accounting.liveBtc).toBeCloseTo(14);
    const { enteredBtc, retiredBtc, sweptBtc, liveBtc } = result.accounting;
    expect(enteredBtc).toBeCloseTo(retiredBtc + sweptBtc + liveBtc);
  });
  it('sweeps longs on the first low crossing and shorts on the first high crossing, including equality', () => {
    const base = [hour(0, 100), hour(1, 120)];
    const long = modelLiquidations([...base, { ...hour(2, 120), low: 99.5 }], END);
    expect(long.accounting.sweptBtc).toBeCloseTo(1);
    expect(long.cohorts.filter(c => c.side === 1)).toHaveLength(5);
    const shortThreshold = modelLiquidations(base, END).cohorts.at(-1)!.price;
    const both = modelLiquidations([...base, { ...hour(2, 120), low: 99.5 }, { ...hour(3, 120), high: shortThreshold }], END);
    expect(both.accounting.sweptBtc).toBeCloseTo(2);
    const gone = modelLiquidations([...base, { ...hour(2, 120), low: 80 }, { ...hour(3, 120), high: 120 }, hour(4, 120)], END);
    expect(gone.accounting.sweptBtc).toBeCloseTo(20); expect(gone.cohorts).toEqual([]);
    expect(gone.value.columns[1].bins.every(b => b[0] + b[1] === 0)).toBe(true);
  });
  it('uses typical price and sweeps newly added cohorts in the same hour', () => {
    const result = modelLiquidations([hour(0, 100), { ...hour(1, 120), high: 103, low: 97 }], END);
    expect(result.cohorts[0].price).toBeCloseTo(80.5);
    expect(result.accounting.sweptBtc).toBeCloseTo(6);
  });
  it('uses the last hourly state for each 4h column, with aggregated real OHLC', () => {
    const rows = [hour(0, 100), hour(1, 120), hour(2, 120), hour(3, 110), hour(4, 110)];
    const result = modelLiquidations(rows, END).value;
    expect(result.columns).toHaveLength(2);
    expect(sum(result.columns[0].bins)).toBe(1834); // Last state: 20 * 110/120 BTC, rounded per bin, never summed.
    expect(result.columns[0].sampleAsOf).toBe(END + 4 * HOUR);
    expect(result.columns[0].candle).toEqual({ open: 100, high: 100, low: 100, close: 100 });
    expect(sum(result.columns[1].bins)).toBe(1834);
  });
  it('separately reports excluded live notional and values it at the column close', () => {
    const rows = [hour(0, 100), hour(1, 200), hour(2, 200, 125)];
    const result = modelLiquidations(rows, END);
    expect(result.value.priceRange).toEqual({ lower: 93.75, upper: 156.25 });
    expect(result.value.excludedUsd).toBe(2500); // surviving 5x + 10x longs, 20 BTC * 125
    expect(sum(result.value.columns[0].bins) + result.value.excludedUsd).toBeCloseTo(result.accounting.liveBtc * 125, -1);
  });
  it('is deterministic and leaves inputs untouched', () => {
    const rows = [hour(0, 100), hour(1, 120), hour(2, 1), hour(3, 21), { ...hour(4, 10), low: 99.5 }];
    const before = JSON.stringify(rows);
    expect(modelLiquidations(rows, END)).toEqual(modelLiquidations(rows, END));
    expect(JSON.stringify(rows)).toBe(before);
  });
  it('models 38 worst-case accumulating days well under 1 second', () => {
    const inputs = fullInputs();
    const hours = alignLiquidationInputs(inputs, END - 38 * LIQUIDATION_DAY, END);
    const start = performance.now();
    const result = modelLiquidations(hours, END - 30 * LIQUIDATION_DAY);
    const elapsed = performance.now() - start;
    console.info(`Liquidation model CPU budget: ${elapsed.toFixed(2)} ms; ${result.value.columns.length} columns`);
    expect(elapsed).toBeLessThan(800);
    expect(result.value.columns).toHaveLength(180);
    expect(result.value.columns[0].bins).toHaveLength(120);
    expect(result.accounting.enteredBtc).toBeCloseTo(result.accounting.liveBtc);
  });
});
describe('UTC alignment and completeness', () => {
  it('joins descending inputs by exact UTC hour', () => {
    const input = fullInputs(); input.oi.reverse(); input.candles.reverse();
    const result = alignLiquidationInputs(input, END - 38 * LIQUIDATION_DAY, END);
    expect(result).toHaveLength(912); expect(result[0].time).toBe(END - 38 * LIQUIDATION_DAY);
  });
  it.each(['oi', 'candles'] as const)('marks a single missing %s hour; never interpolates longer gaps', kind => {
    const input = fullInputs(), time = input[kind][10].time;
    input[kind].splice(10, 1);
    try { alignLiquidationInputs(input, END - 38 * LIQUIDATION_DAY, END); throw new Error('expected missing input'); }
    catch (error) { expect(error).toBeInstanceOf(LiquidationInputError); expect((error as LiquidationInputError).gaps).toEqual([{ time, input: kind === 'oi' ? 'open-interest' : 'candles' }]); }
  });
  it.each(['shift', 'duplicate', 'invalid'] as const)('rejects %s inputs', kind => {
    const input = fullInputs();
    if (kind === 'shift') input.oi[0].time += 1;
    if (kind === 'duplicate') input.oi.push(input.oi[0]);
    if (kind === 'invalid') input.candles[0].close = NaN;
    expect(() => alignLiquidationInputs(input, END - 38 * LIQUIDATION_DAY, END)).toThrow(LiquidationInputError);
  });
});

describe('venue-owned v3 model', () => {
  it.each([1, 80, 130])('preserves the complete v2 fixture and error path without optional venues (drop %s)', drop => {
    const hours = [hour(0, 100), hour(1, 120), hour(2, drop), hour(3, drop + 20), { ...hour(4, drop), low: 99.5 }];
    expect(modelMultiVenueLiquidations(hours, END, [])).toEqual(modelLiquidations(hours, END));
    expect(() => modelMultiVenueLiquidations([], END, [])).toThrow('Insufficient or oversized model history.');
    expect(() => modelMultiVenueLiquidations(hours, END + 100 * HOUR, [])).toThrow('No hourly states in the display window.');
  });
  it('does not seed a staggered baseline or net opposing venue deltas', () => {
    const hours = [hour(0, 100), hour(1, 120), hour(2, 110), hour(3, 110)];
    const result = multi(hours, [{ venue: 'binance', rows: oi([hour(1, 1000), hour(2, 1010), hour(3, 1010)]) }]);
    expect(result.accounting.enteredBtc).toBe(30);
    expect(result.venueAccounting.find(b => b.venue === 'binance')).toMatchObject({ enteredBtc: 10, retiredBtc: 0, liveBtc: 10 });
    expect(result.venueAccounting.find(b => b.venue === 'okx')!.retiredBtc).toBeCloseTo(20 * 10 / 120);
    expect(result.value.initialOiBtc).toBe(100); expect(result.value.methodologyVersion).toBe('oi-leverage-v3');
  });
  it('retires only the venue whose OI falls', () => {
    const result = multi([hour(0, 100), hour(1, 120), hour(2, 120)], [
      { venue: 'binance', rows: oi([hour(0, 100), hour(1, 120), hour(2, 60)]) },
    ]);
    expect(result.venueAccounting.map(b => b.liveBtc)).toEqual([20, 10]);
    expect(result.venueAccounting.map(b => b.retiredBtc)).toEqual([0, 10]);
  });
  it('discards gaps separately and resumes with an empty baseline, without cross-gap differencing', () => {
    const hours = Array.from({ length: 6 }, (_, i) => hour(i, 100));
    const result = multi(hours, [{ venue: 'binance', rows: oi([hour(0, 100), hour(1, 120), hour(3, 140), hour(4, 150)]) }]);
    expect(result.accounting).toMatchObject({ enteredBtc: 30, retiredBtc: 0, sweptBtc: 0, discardedForGapBtc: 20, liveBtc: 10 });
  });
  it('sweeps terminal-lag cohorts with the shared OKX prices, including threshold equality', () => {
    const hours = [hour(0, 100), hour(1, 100), { ...hour(2, 100), low: 99.5 }];
    const result = multi(hours, [{ venue: 'bybit', rows: oi([hour(0, 100), hour(1, 120)]) }]);
    expect(result.accounting.enteredBtc).toBe(20); expect(result.accounting.sweptBtc).toBeCloseTo(1);
    expect(result.accounting.liveBtc).toBeCloseTo(19);
    const added = multi([hour(0, 100), { ...hour(1, 100), high: 103, low: 97 }], [
      { venue: 'bybit', rows: oi([hour(0, 100), hour(1, 120)]) },
    ]);
    expect(added.cohorts[0].price).toBeCloseTo(80.5); expect(added.accounting.sweptBtc).toBeCloseTo(6);
  });
  it('handles zero observations without a division or phantom entries', () => {
    const result = multi(Array.from({ length: 4 }, (_, i) => hour(i, 100)), [
      { venue: 'hyperliquid', rows: oi([hour(0, 0), hour(1, 0), hour(2, 10), hour(3, 0)]) },
    ]);
    expect(result.accounting).toMatchObject({ enteredBtc: 10, retiredBtc: 10, liveBtc: 0 });
  });
  it('orders venues deterministically and rounds after summing unrounded books', () => {
    const hours = [hour(0, 0), hour(1, 0.03)];
    const optional = (['hyperliquid', 'bybit', 'binance'] as const).map(venue => ({ venue, rows: oi(hours) }));
    const result = multi(hours, optional);
    expect(result).toEqual(multi(hours, [...optional].reverse()));
    expect(result.venueAccounting.map(b => b.venue)).toEqual(['okx', 'binance', 'bybit', 'hyperliquid']);
    expect(sum(result.value.columns[0].bins)).toBeGreaterThan(4 * sum(modelLiquidations(hours, END).value.columns[0].bins));
    expect(result.accounting.enteredBtc).toBeCloseTo(0.12);
  });
  it('conserves all four books through closes, sweeps and coverage resets', () => {
    const hours = [hour(0, 100), hour(1, 120), hour(2, 60), { ...hour(3, 80), low: 99.5 }, hour(4, 40)];
    const result = multi(hours, [
      { venue: 'binance', rows: oi(hours) }, { venue: 'bybit', rows: oi(hours.filter((_, i) => i !== 2)) },
      { venue: 'hyperliquid', rows: oi(hours.slice(0, 3)) },
    ]);
    for (const b of [...result.venueAccounting, result.accounting])
      expect(b.enteredBtc).toBeCloseTo(b.retiredBtc + b.sweptBtc + b.discardedForGapBtc + b.liveBtc);
  });
  it('bounds four accumulating books to 36440 cohorts and the unchanged response geometry', () => {
    const hours = alignLiquidationInputs(fullInputs(), END - 38 * LIQUIDATION_DAY, END);
    const before = performance.now(), heapBefore = process.memoryUsage().heapUsed;
    const result = modelMultiVenueLiquidations(hours, END - 30 * LIQUIDATION_DAY,
      (['binance', 'bybit', 'hyperliquid'] as const).map(venue => ({ venue, rows: oi(hours) })));
    console.info(`Four-venue model: ${(performance.now() - before).toFixed(2)} ms; heap delta ${process.memoryUsage().heapUsed - heapBefore} bytes; ${result.cohorts.length} cohorts`);
    expect(result.cohorts).toHaveLength(36440); expect(result.value.columns).toHaveLength(180);
    expect(result.value.columns.every(c => c.bins.length === 120)).toBe(true);
    expect(result.accounting.enteredBtc).toBeCloseTo(result.accounting.liveBtc);
  });
});
