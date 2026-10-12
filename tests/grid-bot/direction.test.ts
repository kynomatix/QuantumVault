import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Express, Request, Response, RequestHandler } from 'express';
import { BTC_TREND_CACHE_MS as DAY, BTC_TREND_NEGATIVE_CACHE_MS as NEGATIVE_TTL, BTC_TREND_WEEK_MS as WEEK } from '../../shared/grid-direction';
import { computeBtcDirection, PlannerDirection } from '../../server/grid-planner/direction';
import { aggregatePacificaDailyWeeks, pacificaBtcWeeklyCandles, plannerBtcWeeklyCandles } from '../../server/grid-planner/btc-candles';
import { registerGridPlannerRoutes } from '../../server/grid-planner/routes';
import type { PlannerCandle, PlannerDeps } from '../../server/grid-planner/types';
import type { ProvenancedOHLCV } from '../../server/lab/datafeed';

const feed = vi.hoisted(() => ({ read: vi.fn(), claim: vi.fn(() => true) }));
vi.mock('../../server/lab/datafeed', () => ({ fetchOHLCV: feed.read,
  CHART_CANDLE_POLICY: { consumer: 'chart', acceptedBasis: ['perp'], acceptedProxy: ['direct'], acceptedFinality: ['finalized', 'forming'] } }));
vi.mock('../../server/protocol/pacifica/pacifica-quota', () => ({ pacificaQuota: { tryClaimImmediate: feed.claim } }));

const now = Date.UTC(2026, 9, 13), asOf = now - DAY;
function history(count = 55, lastClose = 200, source: 'okx' | 'gate' = 'okx'): ProvenancedOHLCV[] {
  return Array.from({ length: count }, (_, i) => ({ time: asOf - (count - i) * WEEK,
    open: 100, high: 200, low: 50, close: i === count - 1 ? lastClose : 100, volume: 10,
    provenance: { source, venue: source, basis: 'perp', proxy: 'direct', finality: 'finalized', timeSemantic: 'open_time' } }));
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); feed.read.mockReset(); feed.claim.mockReset().mockReturnValue(true); });

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
  it('refreshes at the one-week freshness cap before the 24-hour cache expires', async () => {
    let clock = asOf + WEEK - DAY / 2;
    const load = vi.fn(async () => history());
    const service = new PlannerDirection({ now: () => clock, btcWeeklyCandles: load });
    expect((await service.read()).regime).toBe('above');
    clock = asOf + WEEK;
    expect((await service.read()).regime).toBe('unavailable');
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('caches failure for only 30 minutes without serving an expired success', async () => {
    let clock = now;
    const load = vi.fn(async () => history());
    const service = new PlannerDirection({ now: () => clock, btcWeeklyCandles: load });
    expect((await service.read()).regime).toBe('above');
    load.mockRejectedValue(new Error('EXAMPLE upstream unavailable'));
    clock += DAY;
    expect(await service.read()).toMatchObject({ regime: 'unavailable', movingAverage: null });
    expect((await service.read()).expiresAt).toBe(clock + NEGATIVE_TTL);
    clock += NEGATIVE_TTL - 1; await service.read();
    expect(load).toHaveBeenCalledTimes(2);
    clock++; load.mockResolvedValue(history());
    expect((await service.read()).regime).toBe('above');
    expect(load).toHaveBeenCalledTimes(3);
  });
  it('retries incomplete history after the same 30-minute negative TTL', async () => {
    let clock = now;
    const load = vi.fn(async () => history(49));
    const service = new PlannerDirection({ now: () => clock, btcWeeklyCandles: load });
    expect(await service.read()).toMatchObject({ regime: 'unavailable', expiresAt: now + NEGATIVE_TTL });
    clock += NEGATIVE_TTL - 1; await service.read(); expect(load).toHaveBeenCalledTimes(1);
    clock++; load.mockResolvedValue(history());
    expect((await service.read()).regime).toBe('above'); expect(load).toHaveBeenCalledTimes(2);
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

function pacificaDays(count = 55 * 7): PlannerCandle[] {
  return Array.from({ length: count }, (_, i) => ({ time: asOf - 55 * WEEK + i * DAY,
    open: 100, high: 200, low: 50, close: i === 55 * 7 - 1 ? 200 : 100, volume: 10,
    provenance: { source: 'pacifica', venue: 'pacifica', basis: 'perp', proxy: 'direct', finality: 'finalized', timeSemantic: 'open_time' } }));
}
function pacificaRows(interval: '1w' | '1d') {
  const bars = interval === '1d' ? pacificaDays() : history();
  return bars.map(c => ({ s: 'BTC', i: interval, t: c.time, T: c.time + (interval === '1d' ? DAY : WEEK),
    o: String(c.open), h: String(c.high), l: String(c.low), c: String(c.close), v: String(c.volume) }));
}
const response = (data: unknown[]) => ({ ok: true, json: async () => ({ success: true, data }) });

describe('Planner direct-perpetual weekly source fallback', () => {
  it('uses OKX first without requesting Pacifica or permitting spot', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    feed.read.mockResolvedValue(history());
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const candles = await plannerBtcWeeklyCandles(new AbortController().signal);
    expect(computeBtcDirection(candles, now)).toMatchObject({ regime: 'above', sourceVenue: 'okx' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(feed.read).toHaveBeenCalledWith('BTC/USDT', '1w', expect.any(Number), now, undefined,
      expect.objectContaining({ skipSpotFallback: true, bypassCache: true, cacheWritePolicy: 'skip',
        basisPolicy: expect.objectContaining({ consumer: 'chart', acceptedBasis: ['perp'], acceptedFinality: ['finalized'] }) }));
  });
  it.each(['exception', 'empty', 'stale', 'spot', 'incomplete'] as const)('tries Pacifica native weekly after OKX %s', failure => {
    return (async () => {
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const raw = history();
      if (failure === 'exception') feed.read.mockRejectedValue(Error('EXAMPLE transport failure'));
      else {
        if (failure === 'stale') raw.forEach(c => { c.time -= WEEK; });
        if (failure === 'spot') raw.forEach(c => { c.provenance.basis = 'spot'; });
        feed.read.mockResolvedValue(failure === 'empty' ? [] : failure === 'incomplete' ? history(49) : raw);
      }
      const fetcher = vi.fn(async (_url: string) => response(pacificaRows('1w'))); vi.stubGlobal('fetch', fetcher);
      const candles = await plannerBtcWeeklyCandles(new AbortController().signal);
      expect(computeBtcDirection(candles, now)).toMatchObject({ regime: 'above', sourceVenue: 'pacifica' });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(new URL(fetcher.mock.calls[0][0]).searchParams.get('interval')).toBe('1w');
      expect(feed.claim).toHaveBeenCalledWith('/kline', 'background');
    })();
  });
  it('falls back to complete daily weeks when native weekly is unsupported', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now); feed.read.mockResolvedValue([]);
    const fetcher = vi.fn(async (url: string) => new URL(url).searchParams.get('interval') === '1w'
      ? { ok: false, json: async () => ({ success: false }) } : response(pacificaRows('1d')));
    vi.stubGlobal('fetch', fetcher);
    const candles = await plannerBtcWeeklyCandles(new AbortController().signal);
    expect(fetcher.mock.calls.map(([url]) => new URL(url).searchParams.get('interval'))).toEqual(['1w', '1d']);
    expect(computeBtcDirection(candles, now)).toMatchObject({ regime: 'above', sourceVenue: 'pacifica', sourceAggregation: 'weekly-from-daily' });
  });
  it('returns unavailable when both sources fail and preserves quota headroom', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now); feed.read.mockResolvedValue([]);
    feed.claim.mockReturnValue(false);
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect(await plannerBtcWeeklyCandles(new AbortController().signal)).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not start fallback after caller cancellation or the total deadline', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController(); controller.abort();
    await expect(plannerBtcWeeklyCandles(controller.signal)).rejects.toThrow();
    expect(feed.read).not.toHaveBeenCalled();
    vi.spyOn(Date, 'now').mockReturnValueOnce(now).mockReturnValue(now + 15_000);
    feed.read.mockResolvedValue([]);
    expect(await plannerBtcWeeklyCandles(new AbortController().signal)).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['symbol', 'interval', 'boundary', 'end time', 'duplicate', 'price'] as const)('rejects malformed Pacifica %s', defect => {
    return (async () => {
      const rows = pacificaRows('1w');
      if (defect === 'symbol') rows[0].s = 'ETH';
      if (defect === 'interval') rows[0].i = '1d';
      if (defect === 'boundary') { rows[0].t++; rows[0].T++; }
      if (defect === 'end time') rows[0].T -= 2;
      if (defect === 'duplicate') rows[1] = { ...rows[0] };
      if (defect === 'price') rows[0].c = '0';
      vi.stubGlobal('fetch', vi.fn(async () => response(rows)));
      expect(await pacificaBtcWeeklyCandles(now, new AbortController().signal)).toEqual([]);
    })();
  });
});

describe('complete UTC Monday Pacifica daily aggregation', () => {
  it('preserves weekly OHLC, Sunday close, volume and honest provenance without mutating input', () => {
    const raw = pacificaDays().reverse(), before = raw.map(c => c.time);
    const weeks = aggregatePacificaDailyWeeks(raw, now);
    expect(weeks).toHaveLength(55);
    expect(weeks.at(-1)).toMatchObject({ time: asOf - WEEK, open: 100, high: 200, low: 50, close: 200, volume: 70,
      provenance: { source: 'pacifica', basis: 'perp', aggregation: 'weekly-from-daily', finality: 'finalized' } });
    expect(raw.map(c => c.time)).toEqual(before);
    expect(computeBtcDirection(weeks, now)).toMatchObject({ regime: 'above', sourceVenue: 'pacifica', sourceAggregation: 'weekly-from-daily', movingAverage: 102 });
  });
  it.each(['missing', 'duplicate', 'forming', 'partial current week'] as const)('never fills a %s with an invented close', defect => {
    const raw = pacificaDays();
    if (defect === 'missing') raw.splice(raw.length - 2, 1);
    if (defect === 'duplicate') raw[raw.length - 2] = raw[raw.length - 3];
    if (defect === 'forming') raw[raw.length - 1].provenance.finality = 'forming';
    if (defect === 'partial current week') raw.push({ ...raw[0], time: asOf, low: 1, close: 1 });
    const weeks = aggregatePacificaDailyWeeks(raw, now);
    expect(weeks.at(-1)?.time).toBe(defect === 'partial current week' ? asOf - WEEK : asOf - 2 * WEEK);
    expect(computeBtcDirection(weeks, now).regime).toBe(defect === 'partial current week' ? 'above' : 'unavailable');
  });
  it('rejects foreign provenance and mixed native/aggregated weekly windows', () => {
    const raw = pacificaDays(); raw[0].provenance.basis = 'spot';
    expect(aggregatePacificaDailyWeeks(raw, now)).toEqual([]);
    const weeks = aggregatePacificaDailyWeeks(pacificaDays(), now);
    const last = weeks[weeks.length - 1];
    last.provenance = { source: 'pacifica', venue: 'pacifica', basis: 'perp', proxy: 'direct', finality: 'finalized', timeSemantic: 'open_time' };
    expect(computeBtcDirection(weeks, now).regime).toBe('unavailable');
  });
});
