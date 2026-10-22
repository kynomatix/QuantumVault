import { describe, it, expect, vi } from 'vitest';
// Route imports include unrelated live candle adapters. This unit supplies its
// own read-only reader; source integration is covered by squeeze-source.test.ts.
vi.mock('../../server/lab/datafeed', () => ({ readPlannerPerpSource: vi.fn(), readChartPerpSource: vi.fn() }));
import { dailySqueeze, PlannerSqueeze, squeezeWindow } from '../../server/grid-planner/squeeze';
import { registerGridPlannerRoutes } from '../../server/grid-planner/routes';
import type { PlannerCandle, PlannerDeps } from '../../server/grid-planner/types';
import type { Express } from 'express';
import type { ProtocolMarket } from '../../server/protocol/protocol-types';

const DAY = 86_400_000, now = Date.UTC(2026, 9, 22, 12), market = 'BTC-PERP';
const candles = (at = now, close: (i: number, n: number) => number = () => 100): PlannerCandle[] => {
  const { start, bars } = squeezeWindow(at);
  return Array.from({ length: bars }, (_, i) => {
    const value = close(i, bars);
    return { time: start + i * DAY, open: value, high: value, low: value, close: value, volume: 1,
      provenance: { source: 'okx', venue: 'okx', basis: 'perp', proxy: 'direct', timeSemantic: 'open_time', finality: 'finalized' } };
  });
};
const deps = (read = vi.fn(async () => candles())): PlannerDeps => ({ now: () => now, rangeCandles: read,
  candles: vi.fn(async () => []), cachedReference: () => null,
  getMarkets: async () => [{ internalSymbol: market } as ProtocolMarket] });

describe('point-in-time daily squeeze', () => {
  it('uses population SD on 20 closes and excludes the current bandwidth from its rank', () => {
    const raw = candles(now, (i, n) => i < n - 20 ? 100 : i % 2 ? 101 : 99);
    const result = dailySqueeze(market, raw, now);
    expect(result).toMatchObject({ state: 'available', historyDays: 365, latestFinalizedTime: Date.UTC(2026, 9, 21), squeezed: false });
    if (result.state !== 'available') throw Error(result.reason);
    expect(result.bandwidth).toBeCloseTo(0.04, 12);
    // Independently calculate all previous window widths, without current-day leakage.
    const prior: number[] = [];
    for (let end = 20; end < raw.length; end++) {
      const values = raw.slice(end - 20, end).map(c => c.close);
      const mean = values.reduce((a, b) => a + b) / 20;
      prior.push(4 * Math.sqrt(values.reduce((sum, x) => sum + (x - mean) ** 2, 0) / 20) / mean);
    }
    expect(result.percentile).toBe(prior.filter(x => x < result.bandwidth).length / 365);
  });
  it.each([91, 92])('uses a strict bottom-20-percent boundary with %s flat warmup days', flat => {
    const raw = candles(now, (i, n) => i < flat ? 100 : i < n - 20 ? (i % 2 ? 120 : 80) : (i % 2 ? 101 : 99));
    const result = dailySqueeze(market, raw, now);
    expect(result).toMatchObject({ state: 'available', percentile: (flat - 19) / 365, squeezed: flat === 91 });
  });
  it('matches strict-less tie ranking, including a flat series', () => {
    expect(dailySqueeze(market, candles(), now)).toMatchObject({ state: 'available', bandwidth: 0, percentile: 0, squeezed: true });
  });
  it('ignores forming and future days and extra pre-window history', () => {
    const raw = candles(), { start, end } = squeezeWindow(now);
    const result = dailySqueeze(market, raw, now);
    expect(dailySqueeze(market, [{ ...raw[0], time: start - DAY, close: 999 }, ...raw,
      { ...raw[0], time: end, close: 999, provenance: { ...raw[0].provenance, finality: 'forming' } },
      { ...raw[0], time: end + DAY, close: 999 }], now)).toEqual(result);
    expect(dailySqueeze(market, raw, end + DAY)).toMatchObject({ state: 'unavailable' });
  });
  it('uses UTC calendar months across leap years and closes the next day only at midnight', () => {
    const leap = Date.UTC(2024, 2, 1), dayBefore = leap - 1;
    expect(squeezeWindow(leap)).toMatchObject({ at: Date.UTC(2024, 1, 29), begin: Date.UTC(2023, 2, 1), bars: 385 });
    expect(dailySqueeze(market, candles(dayBefore), dayBefore)).toMatchObject({ state: 'available', validForMs: 1 });
    expect(dailySqueeze(market, candles(Date.UTC(2025, 1, 28)), Date.UTC(2025, 1, 28))).toMatchObject({ historyDays: 366 });
  });
  it.each(['missing', 'warmup', 'stale', 'duplicate', 'unsorted', 'forming', 'invalid', 'mixed', 'spot'])('returns unavailable for %s data', fault => {
    const raw = candles();
    if (fault === 'missing') raw.splice(100, 1);
    if (fault === 'warmup') raw.shift();
    if (fault === 'stale') raw.pop();
    if (fault === 'duplicate') raw[1] = raw[0];
    if (fault === 'unsorted') [raw[0], raw[1]] = [raw[1], raw[0]];
    if (fault === 'forming') raw[50].provenance.finality = 'forming';
    if (fault === 'invalid') raw[50].close = NaN;
    if (fault === 'mixed') raw[50].provenance.source = 'gate';
    if (fault === 'spot') raw[50].provenance.basis = 'spot';
    const result = dailySqueeze(market, raw, now);
    expect(result).toMatchObject({ state: 'unavailable', reason: expect.any(String) });
    expect(result).not.toHaveProperty('squeezed');
  });
});

describe('bounded read-only squeeze service and route', () => {
  it('uses the range-facts daily source and preserves cache age', async () => {
    const read = vi.fn(async () => candles()), d = deps(read), service = new PlannerSqueeze();
    const first = await service.read(market, d, new AbortController().signal);
    expect(read).toHaveBeenCalledWith(market, '1d', 385, expect.any(AbortSignal));
    d.now = () => now + 1000;
    expect(await service.read(market, d, new AbortController().signal)).toMatchObject({ ...first, validForMs: 299000 });
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('never treats unavailable, failed or cancelled history as not squeezed', async () => {
    for (const read of [undefined, vi.fn(async () => []), vi.fn(async () => { throw Error('EXAMPLE'); })]) {
      const d = deps(); d.rangeCandles = read;
      expect(await new PlannerSqueeze().read(market, d, new AbortController().signal)).toMatchObject({ state: 'unavailable', reason: expect.any(String) });
    }
    const controller = new AbortController(); controller.abort();
    const d = deps(); expect(await new PlannerSqueeze().read(market, d, controller.signal)).toMatchObject({ state: 'unavailable' });
    expect(d.rangeCandles).not.toHaveBeenCalled();
  });
  it('bounds concurrent work and releases cancelled callers', async () => {
    const service = new PlannerSqueeze(), d = deps(vi.fn(() => new Promise<PlannerCandle[]>(() => {})));
    const a = new AbortController(), b = new AbortController();
    const first = service.read(market, d, a.signal), second = service.read('ETH-PERP', d, b.signal);
    expect(await service.read('SOL-PERP', d, new AbortController().signal)).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('busy') });
    a.abort(); b.abort();
    expect(await first).toMatchObject({ state: 'unavailable' }); expect(await second).toMatchObject({ state: 'unavailable' });
  });
  it('registers an authenticated GET and validates market membership', async () => {
    const routes = new Map<string, Function[]>(), auth = vi.fn(), d = deps();
    registerGridPlannerRoutes({ get: (path: string, ...handlers: Function[]) => routes.set(path, handlers) } as unknown as Express, auth, async () => d, true);
    const [guard, handler] = routes.get('/api/grid-planner/squeeze')!;
    expect(guard).toBe(auth);
    const response = () => { const res = { set: vi.fn(), status: vi.fn(), json: vi.fn(), on: vi.fn(), off: vi.fn(), destroyed: false }; res.status.mockReturnValue(res); return res; };
    const valid = response(); await handler({ query: { market } }, valid);
    expect(valid.json).toHaveBeenCalledWith(expect.objectContaining({ state: 'available', market, squeezed: true }));
    const invalid = response(); await handler({ query: { market: 'EXAMPLE-PERP' } }, invalid);
    expect(invalid.status).toHaveBeenCalledWith(400);
    const extra = response(); await handler({ query: { market, timeframe: '1h' } }, extra);
    expect(extra.status).toHaveBeenCalledWith(400);
    expect(d.rangeCandles).toHaveBeenCalledTimes(1);
  });
});
