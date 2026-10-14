import { afterEach, describe, expect, it, vi } from 'vitest';
import { aggregateStructureWeeks, computeWeeklyStructure, PlannerWeeklyStructure } from '../../server/grid-planner/weekly-structure';
import { parsePlannerFunding, PlannerFunding } from '../../server/grid-planner/funding';
import { plannerRegime } from '../../server/grid-planner/regime';
import { gridSignalViews, isGridSignals } from '../../client/src/lib/grid-signals-view';
import { gridMeasuredStart } from '../../shared/grid-lookback';
import { btcUtcWeekStart, BTC_TREND_WEEK_MS as WEEK } from '../../shared/grid-direction';
import type { PlannerCandle } from '../../server/grid-planner/types';
import type { GridSignals } from '../../shared/grid-signals';
const now = Date.UTC(2026, 9, 14), end = btcUtcWeekStart(now), DAY = WEEK / 7;
const provenance = { source: 'okx', venue: 'okx', basis: 'perp', proxy: 'direct', finality: 'finalized', timeSemantic: 'open_time' } as const;
function weeks(direction: 'long' | 'short' | 'neutral' = 'long'): PlannerCandle[] {
  const high = [70, 72, direction === 'short' ? 100 : 90, 74, 76, 78, 80, direction === 'short' ? 90 : 100, 82, 84, 83, 82];
  const low = [40, 39, 38, 37, direction === 'long' ? 30 : 35, 37, 38, 39, 40, direction === 'long' ? 35 : 30, 40, 41];
  return high.map((h, i) => ({ time: end - (12 - i) * WEEK, open: 50, close: 50, high: h, low: low[i], volume: 10, provenance }));
}
const payload = (data: unknown[]) => ({ success: true, data });
const signals = (): GridSignals => ({ market: 'BTC-PERP', serverNow: now,
  weekly: computeWeeklyStructure('BTC-PERP', weeks(), now),
  funding: parsePlannerFunding(payload([{ symbol: 'BTC', funding_rate: '0.0001', next_funding_rate: '0.0002' }]), now).get('BTC-PERP')!,
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('confirmed UTC weekly Dow structure', () => {
  it.each(['long', 'short', 'neutral'] as const)('requires BOTH high and low comparisons for %s', direction => {
    const result = computeWeeklyStructure('BTC-PERP', weeks(direction), now);
    expect(result).toMatchObject({ state: 'available', direction, asOf: end, expiresAt: end + WEEK, weeks: 12, venue: 'okx' });
    if (result.state === 'available') { expect(result.highs.map(h => h.time)).toEqual([end - 10 * WEEK, end - 5 * WEEK]); expect(result.lows).toHaveLength(2); }
  });
  it('treats equal swing prices as sideways and does not confirm tied neighbours', () => {
    const equal = weeks(); equal[7].high = equal[2].high;
    expect(computeWeeklyStructure('BTC-PERP', equal, now)).toMatchObject({ direction: 'neutral' });
    equal[1].high = equal[2].high;
    expect(computeWeeklyStructure('BTC-PERP', equal, now)).toMatchObject({ state: 'unavailable' });
  });
  it('excludes the last two weeks from confirmation and requires enough independent highs AND lows', () => {
    const candles = weeks(); candles[11].high = 200;
    expect(computeWeeklyStructure('BTC-PERP', candles, now)).toMatchObject({ direction: 'long' });
    for (const c of candles) c.low = 30;
    expect(computeWeeklyStructure('BTC-PERP', candles, now)).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('Fewer than two') });
  });
  it('rejects forming, non-Monday, gapped, mixed and stale histories without guessing', () => {
    const malformed = [weeks().slice(0, -1), weeks().filter((_, i) => i !== 5), weeks().slice(-6)];
    for (const field of ['time', 'provenance', 'low', 'volume']) {
      const copy = weeks().map(c => ({ ...c }));
      if (field === 'time') copy[0].time += DAY;
      if (field === 'provenance') copy[0].provenance = { ...provenance, finality: 'forming' };
      if (field === 'low') copy[0].low = 80;
      if (field === 'volume') copy[0].volume = NaN;
      malformed.push(copy);
    }
    const mixed = weeks(); mixed[5].provenance = { ...provenance, source: 'gate', venue: 'gate' }; malformed.push(mixed);
    for (const value of malformed) expect(computeWeeklyStructure('BTC-PERP', value, now).state).toBe('unavailable');
    expect(computeWeeklyStructure('BTC-PERP', weeks(), end + WEEK).state).toBe('unavailable');
  });
  it('aggregates complete UTC Monday weeks, keeps OHLC and rejects daily gaps and forming bars', () => {
    const daily = weeks().flatMap(w => Array.from({ length: 7 }, (_, i) => ({ ...w, time: w.time + i * DAY, volume: 2 })));
    expect(aggregateStructureWeeks(daily, now)).toEqual(weeks().map(w => ({ ...w, volume: 14 })));
    const midweek = aggregateStructureWeeks(daily.slice(2), now);
    expect(midweek[0].time).toBe(end - 11 * WEEK);
    expect(aggregateStructureWeeks(daily.filter((_, i) => i !== 40), now)).toEqual([]);
    daily[10].provenance = { ...provenance, finality: 'forming' };
    expect(aggregateStructureWeeks(daily, now)).toEqual([]);
  });
  it('coalesces per-market reads, caches to the weekly close and retries failures only after one minute', async () => {
    let clock = now;
    const reader = vi.fn(async () => weeks());
    const cache = new PlannerWeeklyStructure({ now: () => clock, structureCandles: reader });
    const [a, b] = await Promise.all([cache.read('BTC-PERP'), cache.read('BTC-PERP')]);
    expect(a).toEqual(b); expect(reader).toHaveBeenCalledTimes(1);
    clock += DAY; await cache.read('BTC-PERP'); expect(reader).toHaveBeenCalledTimes(1);
    clock = end + WEEK; await cache.read('BTC-PERP'); expect(reader).toHaveBeenCalledTimes(2);
    await cache.read('BTC-PERP'); expect(reader).toHaveBeenCalledTimes(2);
    clock += 60_000; await cache.read('BTC-PERP'); expect(reader).toHaveBeenCalledTimes(3);
  });
  it('does not guess when the reader throws or is absent', async () => {
    expect((await new PlannerWeeklyStructure({ now: () => now }).read('BTC-PERP')).state).toBe('unavailable');
    expect((await new PlannerWeeklyStructure({ now: () => now, structureCandles: async () => { throw Error('EXAMPLE'); } }).read('BTC-PERP')).state).toBe('unavailable');
  });
});

describe('Pacifica hourly funding, shared and honest', () => {
  it.each(['0.0001', '-0.0001', '0'])('parses fraction %s, prefers the next-hour estimate and never invents an 8-hour cadence', rate => {
    const value = parsePlannerFunding(payload([{ symbol: 'BTC', next_funding_rate: rate, funding_rate: '0.5' }]), now).get('BTC-PERP');
    expect(value).toMatchObject({ state: 'available', hourlyRate: Number(rate), basis: 'next-hour estimate', observedAt: now, expiresAt: now + 300_000 });
  });
  it('labels the last settled hour fallback, while present-but-invalid estimates are unavailable', () => {
    expect(parsePlannerFunding(payload([{ symbol: 'BTC', funding_rate: '-0.0001' }]), now).get('BTC-PERP')).toMatchObject({ basis: 'last settled hour' });
    for (const raw of ['', 'NaN', 'Infinity', '1e-5', null, 0.001, ' 0.01 ', '1'.repeat(81)]) {
      expect(parsePlannerFunding(payload([{ symbol: 'BTC', next_funding_rate: raw, funding_rate: '0.0001' }]), now).get('BTC-PERP')?.state).toBe('unavailable');
    }
    expect(parsePlannerFunding(payload([{ symbol: 'BTC' }]), now).get('BTC-PERP')?.state).toBe('unavailable');
    expect(parsePlannerFunding(payload([{ symbol: 'BTC', funding_rate: '0' }, { symbol: 'BTC', funding_rate: '0' }]), now).get('BTC-PERP')?.state).toBe('unavailable');
    expect(parsePlannerFunding({ success: false, data: [] }, now).size).toBe(0);
    expect(parsePlannerFunding(payload([{ symbol: 'BTC', instrument_type: 'spot', funding_rate: '0' }]), now).size).toBe(0);
  });
  it('uses one quota claim and bulk read for simultaneous markets, and expires without extending observation time', async () => {
    let clock = now;
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload([{ symbol: 'BTC', next_funding_rate: '0.0001' }, { symbol: 'ETH', next_funding_rate: '-0.0001' }]))));
    const claim = vi.fn(() => true), cache = new PlannerFunding(() => clock, fetcher, claim);
    const [btc, eth] = await Promise.all([cache.read('BTC-PERP'), cache.read('ETH-PERP')]);
    expect(btc).toMatchObject({ hourlyRate: 0.0001 }); expect(eth).toMatchObject({ hourlyRate: -0.0001 });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(claim).toHaveBeenCalledTimes(1);
    clock += 299_999; expect(await cache.read('BTC-PERP')).toEqual(btc);
    clock++; await cache.read('BTC-PERP'); expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await cache.read('EXAMPLE-PERP')).state).toBe('unavailable');
  });
  it('negative-caches quota and HTTP failures instead of returning a zero rate', async () => {
    let clock = now;
    const fetcher = vi.fn(async () => new Response('{}', { status: 503 }));
    const claim = vi.fn(() => false), cache = new PlannerFunding(() => clock, fetcher, claim);
    expect((await cache.read('BTC-PERP')).state).toBe('unavailable'); expect(fetcher).not.toHaveBeenCalled();
    clock += 60_000; claim.mockReturnValue(true);
    expect((await cache.read('BTC-PERP')).state).toBe('unavailable');
    await cache.read('ETH-PERP'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('independent advisory display and context indicators', () => {
  it('shows four unavailable reasons with their source and timeframe, without a combined verdict', () => {
    const views = gridSignalViews(null, null, 'BTC-PERP', '1h', { state: 'unavailable', reason: 'EXAMPLE ADX missing' });
    expect(views).toHaveLength(4);
    for (const view of views) { expect(view.unavailable).toBe(true); expect(view.direction).toBe('neutral'); expect(view.basis).toContain('As-of unavailable'); }
    expect(views[2].detail).toContain('EXAMPLE ADX missing');
  });
  it('computes +DI/−DI with the existing 28-bar ADX rule, preserves neutral ranging and excludes forming bars', () => {
    const candles = (sign: number): PlannerCandle[] => Array.from({ length: 40 }, (_, i) => {
      const close = 100 + i * sign;
      return { time: Math.floor(now / 3_600_000) * 3_600_000 - (40 - i) * 3_600_000, open: close, close, high: close + 2, low: close - 2, volume: 1, provenance };
    });
    for (const sign of [1, -1]) {
      const result = plannerRegime('BTC-PERP', '1h', candles(sign), now);
      const view = gridSignalViews(null, signals(), 'BTC-PERP', '1h', result)[2];
      expect(result.state).toBe('available'); expect(view.direction).toBe(sign > 0 ? 'long' : 'short');
      expect(plannerRegime('BTC-PERP', '1h', candles(sign).slice(-27), now).state).toBe('unavailable');
    }
    const flat = plannerRegime('BTC-PERP', '1h', candles(0), now);
    expect(gridSignalViews(null, signals(), 'BTC-PERP', '1h', flat)[2]).toMatchObject({ direction: 'neutral', summary: 'Sideways — suits grids' });
    const forming = candles(1); forming[39].provenance = { ...provenance, finality: 'forming' };
    expect(plannerRegime('BTC-PERP', '1h', forming, now).state).toBe('unavailable');
  });
  it('labels funding as a receiving-side cost hint with hourly, 8-hour and day arithmetic', () => {
    const view = gridSignalViews(null, signals(), 'BTC-PERP', '1h', { state: 'unavailable', reason: 'EXAMPLE' })[3];
    expect(view).toMatchObject({ direction: 'short', summary: 'Longs pay shorts' });
    expect(view.brief).toBe('Shorts receive about 0.48%/day of position value if this rate holds');
    expect(view.detail).toContain('0.02000% per hour'); expect(view.detail).toContain('0.1600% per 8h / 0.4800% per day');
    expect(view.basis).toContain('next-hour estimate'); expect(view.detail).toContain('if unchanged');
  });
  it('keeps negative, zero and tiny funding summaries truthful', () => {
    for (const [rate, direction, brief] of [[-0.0000125, 'long', 'Longs receive about 0.03%/day'], [0, 'neutral', 'No funding payment at this rate'], [0.000000001, 'short', 'Shorts receive about 0.0000024%/day']] as const) {
      const data = signals(); data.funding = { ...data.funding, state: 'available', market: 'BTC-PERP', hourlyRate: rate, basis: 'next-hour estimate', observedAt: now, expiresAt: now + 300_000 };
      const view = gridSignalViews(null, data, 'BTC-PERP', '1h', { state: 'unavailable', reason: 'EXAMPLE' })[3];
      expect(view.direction).toBe(direction); expect(view.brief).toContain(brief);
    }
  });
  it('rejects wrong-market, expired, malformed and stale signal payloads', () => {
    const good = signals(); expect(isGridSignals(good, 'BTC-PERP')).toBe(true);
    for (const bad of [null, {}, { ...good, market: 'ETH-PERP' }, { ...good, funding: { ...good.funding, hourlyRate: NaN } },
      { ...good, funding: { ...good.funding, expiresAt: now } }, { ...good, weekly: { ...good.weekly, asOf: end - WEEK } }]) expect(isGridSignals(bad, 'BTC-PERP')).toBe(false);
    expect(isGridSignals({ ...good, funding: { state: 'unavailable', reason: 'EXAMPLE' } }, 'BTC-PERP')).toBe(true);
    const changed = gridSignalViews(null, good, 'ETH-PERP', '1h', { state: 'unavailable', reason: 'EXAMPLE' });
    expect(changed[1].unavailable).toBe(true); expect(changed[3].unavailable).toBe(true);
  });
  it('marks a finalized-close period independently of chart context and timeframe', () => {
    for (const [timeframe, duration] of [['15m', 900_000], ['1h', 3_600_000], ['4h', 14_400_000]] as const)
      expect(gridMeasuredStart(timeframe, 'week', end - duration)).toBe(end - WEEK);
    expect(gridMeasuredStart('1h', 'day', end - 3_600_000)).toBe(end - DAY);
    expect(gridMeasuredStart('EXAMPLE', 'week', end)).toBeNull();
  });
});
