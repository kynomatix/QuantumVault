import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Express, Request, Response, RequestHandler } from 'express';
import { BTC_TREND_CACHE_MS as DAY, BTC_TREND_WEEK_MS as WEEK } from '../../shared/grid-direction';
import { computeBtcDirection, PlannerDirection } from '../../server/grid-planner/direction';
import { registerGridPlannerRoutes } from '../../server/grid-planner/routes';
import type { PlannerCandle, PlannerDeps } from '../../server/grid-planner/types';
import type { ProvenancedOHLCV } from '../../server/lab/datafeed';

const now = Date.UTC(2026, 9, 13), asOf = now - DAY;
function history(count = 55, lastClose = 200, source: 'okx' | 'gate' = 'okx'): ProvenancedOHLCV[] {
  return Array.from({ length: count }, (_, i) => ({ time: asOf - (count - i) * WEEK,
    open: 100, high: 200, low: 50, close: i === count - 1 ? lastClose : 100, volume: 10,
    provenance: { source, venue: source, basis: 'perp', proxy: 'direct', finality: 'finalized', timeSemantic: 'open_time' } }));
}
afterEach(() => vi.useRealTimers());

describe('BTC finalized 50-week direction suggestion', () => {
  it.each(['okx', 'gate'] as const)('uses the latest 50 of 55 %s weeks and ignores a forming candle', source => {
    const bars = history(55, 200, source);
    bars[0].close = 50;
    bars.push({ ...bars[54], time: asOf, close: 1, provenance: { ...bars[54].provenance, finality: 'forming' } });
    const value = computeBtcDirection(bars, now);
    expect(value).toMatchObject({ regime: 'above', sourceVenue: source, asOf, lastClose: 200, retrievedAt: now, serverNow: now });
    expect(value.movingAverage).toBeCloseTo(102);
  });
  it('suggests short below the average and gives no suggestion at equality', () => {
    expect(computeBtcDirection(history(55, 50), now)).toMatchObject({ regime: 'below', movingAverage: 99, lastClose: 50 });
    expect(computeBtcDirection(history(55, 100), now).regime).toBe('unavailable');
  });
  it('sorts history without modifying the input', () => {
    const bars = history().reverse(), times = bars.map(c => c.time);
    expect(computeBtcDirection(bars, now).regime).toBe('above');
    expect(bars.map(c => c.time)).toEqual(times);
  });
  it('returns truthful null facts for missing, stale and future-finalized history', () => {
    for (const [bars, clock] of [[[], now], [history(49), now], [history(), asOf + WEEK], [history(), asOf - 1]] as const) {
      expect(computeBtcDirection(bars as PlannerCandle[], clock)).toMatchObject({ regime: 'unavailable', sourceVenue: null,
        asOf: null, movingAverage: null, lastClose: null });
    }
  });
  it.each(['gap', 'duplicate', 'mixed', 'proxy', 'unknown finality', 'bad price'] as const)('refuses %s in the averaging window', defect => {
    const bars = history(50);
    if (defect === 'gap') bars[25].time += WEEK / 2;
    if (defect === 'duplicate') bars[25].time = bars[24].time;
    if (defect === 'mixed') bars[25].provenance = { ...bars[25].provenance, source: 'gate', venue: 'gate' };
    if (defect === 'proxy') bars[25].provenance.proxy = 'proxy';
    if (defect === 'unknown finality') bars[25].provenance.finality = 'unknown';
    if (defect === 'bad price') bars[25].close = NaN;
    expect(computeBtcDirection(bars, now).regime).toBe('unavailable');
  });
});

describe('one process-wide Planner BTC read', () => {
  it('shares concurrent work and caches for 24 hours before refreshing', async () => {
    let clock = now, resolve!: (bars: PlannerCandle[]) => void;
    const load = vi.fn(() => new Promise<PlannerCandle[]>(done => { resolve = done; }));
    const service = new PlannerDirection({ now: () => clock, btcWeeklyCandles: load });
    const a = service.read(), b = service.read();
    expect(load).toHaveBeenCalledTimes(1);
    resolve(history());
    expect(await a).toEqual(await b);
    clock += DAY - 1;
    expect(await service.read()).toMatchObject({ regime: 'above', serverNow: clock, retrievedAt: now });
    expect(load).toHaveBeenCalledTimes(1);
    clock++;
    const next = service.read(); resolve(history(55, 50));
    expect(await next).toMatchObject({ regime: 'below', retrievedAt: clock });
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('hides a weekly observation that turns stale inside the 24-hour cache', async () => {
    let clock = asOf + WEEK - DAY / 2;
    const load = vi.fn(async () => history());
    const service = new PlannerDirection({ now: () => clock, btcWeeklyCandles: load });
    expect((await service.read()).regime).toBe('above');
    clock = asOf + WEEK;
    expect((await service.read()).regime).toBe('unavailable');
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('caches failure and retries after 24 hours without serving an expired success', async () => {
    let clock = now;
    const load = vi.fn(async () => history());
    const service = new PlannerDirection({ now: () => clock, btcWeeklyCandles: load });
    expect((await service.read()).regime).toBe('above');
    load.mockRejectedValue(new Error('EXAMPLE upstream unavailable'));
    clock += DAY;
    expect(await service.read()).toMatchObject({ regime: 'unavailable', movingAverage: null });
    clock += DAY - 1; await service.read();
    expect(load).toHaveBeenCalledTimes(2);
    clock++; load.mockResolvedValue(history());
    expect((await service.read()).regime).toBe('above');
    expect(load).toHaveBeenCalledTimes(3);
  });
  it('bounds an unresponsive feed and releases the single flight', async () => {
    vi.useFakeTimers();
    const load = vi.fn((_signal: AbortSignal) => new Promise<PlannerCandle[]>(() => {}));
    const service = new PlannerDirection({ now: () => now, btcWeeklyCandles: load });
    const pending = service.read();
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await pending).regime).toBe('unavailable');
    expect(load.mock.calls[0][0].aborted).toBe(true);
    await service.read(); expect(load).toHaveBeenCalledTimes(1);
  });
  it('is a GET behind the Planner flag and existing auth without market/account work', async () => {
    const registrations = new Map<string, RequestHandler[]>();
    const get = vi.fn((path: string, ...handlers: RequestHandler[]) => { registrations.set(path, handlers); });
    const app = { get } as unknown as Express, auth: RequestHandler = (_req, _res, next) => next();
    const deps: PlannerDeps = { now: () => now, getMarkets: vi.fn(async () => []),
      cachedReference: vi.fn(() => null), candles: vi.fn(async () => []), btcWeeklyCandles: vi.fn(async () => history()) };
    const load = vi.fn(async () => deps);
    registerGridPlannerRoutes(app, auth, load, false);
    expect(get).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
    registerGridPlannerRoutes(app, auth, load, true);
    const handlers = registrations.get('/api/grid-planner/direction')!;
    expect(handlers[0]).toBe(auth);
    const json = vi.fn(), status = vi.fn();
    const res = { set: vi.fn(), json, status, destroyed: false } as unknown as Response;
    status.mockReturnValue(res);
    await handlers[1]({ query: {} } as Request, res, vi.fn());
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ regime: 'above' }));
    expect(deps.getMarkets).not.toHaveBeenCalled(); expect(deps.cachedReference).not.toHaveBeenCalled();
    await handlers[1]({ query: { side: 'short' } } as unknown as Request, res, vi.fn());
    expect(status).toHaveBeenCalledWith(400);
    expect(deps.btcWeeklyCandles).toHaveBeenCalledTimes(1);
  });
});
