import { afterEach, describe, it, expect, vi } from 'vitest';
const sentinels = vi.hoisted(() => ({ cacheRead: vi.fn(() => { throw Error('EXAMPLE: persistent read forbidden'); }),
  cacheWrite: vi.fn(() => { throw Error('EXAMPLE: persistent write forbidden'); }),
  quota: vi.fn(() => true),
  adapter: { getMarkets: vi.fn(async () => []), getCachedPrices: vi.fn(() => ({ 'BTC-PERP': 100 })),
    getCachedPriceMeta: vi.fn(() => ({ oldestFetchedAt: 1_800_000_000_000 })),
    getPrice: vi.fn(() => { throw Error('EXAMPLE: price refresh forbidden'); }),
    getAccount: vi.fn(() => { throw Error('EXAMPLE: account read forbidden'); }),
    placeOrder: vi.fn(() => { throw Error('EXAMPLE: mutation forbidden'); }) } }));
vi.mock('../../server/lab/candle-store', () => ({ getCachedCandles: sentinels.cacheRead, getCachedCandlesBatch: sentinels.cacheRead,
  isCandleBatchPartialReadError: () => false, saveCandlesToDb: sentinels.cacheWrite, CACHE_BUDGET_ABORT_REASON: 'EXAMPLE' }));
vi.mock('../../server/telemetry', () => ({ appendTelemetry: vi.fn() }));
vi.mock('../../server/protocol/adapter-registry', () => ({ getAdapter: () => sentinels.adapter }));
vi.mock('../../server/protocol/pacifica/pacifica-quota', () => ({ pacificaQuota: { tryClaimImmediate: sentinels.quota } }));
import { defaultPlannerDeps } from '../../server/grid-planner/default-deps';
import { pacificaPlannerCandles } from '../../server/grid-planner/pacifica-candles';
import { PlannerReferences } from '../../server/grid-planner/pacifica-reference';
import { __testResetOkxSourceBreaker } from '../../server/lab/datafeed';
import * as datafeed from '../../server/lab/datafeed';
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); sentinels.quota.mockReturnValue(true); __testResetOkxSourceBreaker(); });
const json = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
const nativeRow = (time: number, interval = '1h', duration = 3_600_000) =>
  ({ t: time, T: time + duration, s: 'BTC', i: interval, o: '100', h: '110', l: '90', c: '101', v: '2' });
const assertReadOnly = () => {
  expect(sentinels.cacheRead).not.toHaveBeenCalled(); expect(sentinels.cacheWrite).not.toHaveBeenCalled();
  expect(sentinels.adapter.getPrice).not.toHaveBeenCalled(); expect(sentinels.adapter.getAccount).not.toHaveBeenCalled(); expect(sentinels.adapter.placeOrder).not.toHaveBeenCalled();
};

describe('Planner fresh Pacifica price observations', () => {
  const clock = 1_800_000_000_000;
  const bulk = (timestamp = clock, mid = '100') => ({ success: true, data: [{ symbol: 'BTC', timestamp, mid }] });
  it('reads the bulk midpoint with background quota and preserves venue age and transit time', async () => {
    let now = clock;
    const refs = new PlannerReferences(() => now), transport = vi.fn(async () => { now += 5_000; return json(bulk(clock - 10_000)); });
    vi.stubGlobal('fetch', transport);
    await refs.refresh('BTC-PERP', 'BTC', new AbortController().signal);
    expect(refs.cached('BTC-PERP')).toEqual({ price: 100, observedAt: clock - 10_000 });
    expect(sentinels.quota).toHaveBeenCalledWith('/info/prices', 'background', 'grid-planner.reference');
    expect(transport).toHaveBeenCalledWith('https://api.pacifica.fi/api/v1/info/prices', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    now += 20_000;
    await refs.refresh('BTC-PERP', 'BTC', new AbortController().signal);
    expect(refs.cached('BTC-PERP')?.observedAt).toBe(clock - 10_000); assertReadOnly();
  });
  it.each([
    ['expired', bulk(clock - 60_000)], ['future', bulk(clock + 1)],
    ['wrong market', { success: true, data: [{ symbol: 'ETH', timestamp: clock, mid: '100' }] }],
    ['missing midpoint', { success: true, data: [{ symbol: 'BTC', timestamp: clock, mark: '100' }] }],
    ['duplicate', { success: true, data: [...bulk().data, ...bulk().data] }],
    ['zero', bulk(clock, '0')], ['invalid number', bulk(clock, 'NaN')],
    ['unsuccessful', { ...bulk(), success: false }],
  ])('fails closed for %s without renewing the previous observation', async (_name, payload) => {
    const refs = new PlannerReferences(() => clock), transport = vi.fn().mockResolvedValueOnce(json(bulk())).mockResolvedValueOnce(json(payload));
    vi.stubGlobal('fetch', transport);
    await refs.refresh('BTC-PERP', 'BTC', new AbortController().signal);
    await expect(refs.refresh('BTC-PERP', 'BTC', new AbortController().signal)).rejects.toThrow();
    expect(refs.cached('BTC-PERP')).toEqual({ price: 100, observedAt: clock }); assertReadOnly();
  });
  it('coalesces callers and prevents an aborted caller from publishing a response', async () => {
    let finish!: (value: Response) => void;
    const refs = new PlannerReferences(() => clock), transport = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', transport);
    const canceled = new AbortController(), rejected = expect(refs.refresh('BTC-PERP', 'BTC', canceled.signal)).rejects.toThrow();
    const active = refs.refresh('BTC-PERP', 'BTC', new AbortController().signal);
    canceled.abort(); finish(json(bulk()));
    await rejected; await active;
    expect(transport).toHaveBeenCalledTimes(1); expect(sentinels.quota).toHaveBeenCalledTimes(1);
    expect(refs.cached('BTC-PERP')).toEqual({ price: 100, observedAt: clock }); assertReadOnly();
  });
  it('refuses unavailable quota, canceled callers and unbounded starts without upstream work', async () => {
    const refs = new PlannerReferences(() => clock), transport = vi.fn(async () => json(bulk())); vi.stubGlobal('fetch', transport);
    const canceled = new AbortController(); canceled.abort();
    await expect(refs.refresh('BTC-PERP', 'BTC', canceled.signal)).rejects.toThrow();
    sentinels.quota.mockReturnValue(false);
    await expect(refs.refresh('BTC-PERP', 'BTC', new AbortController().signal)).rejects.toThrow(/quota/);
    expect(transport).not.toHaveBeenCalled();
    sentinels.quota.mockReturnValue(true);
    for (let i = 0; i < 30; i++) await refs.refresh('BTC-PERP', 'BTC', new AbortController().signal);
    await expect(refs.refresh('BTC-PERP', 'BTC', new AbortController().signal)).rejects.toThrow(/busy/);
    expect(transport).toHaveBeenCalledTimes(30); assertReadOnly();
  });
  it('shares one bulk read across different markets and expires observations at the original limit', async () => {
    let now = clock, finish!: (value: Response) => void;
    const refs = new PlannerReferences(() => now), transport = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', transport);
    const btc = refs.refresh('BTC-PERP', 'BTC', new AbortController().signal);
    const eth = refs.refresh('ETH-PERP', 'ETH', new AbortController().signal);
    finish(json({ success: true, data: [...bulk(clock - 5_000).data, { symbol: 'ETH', mid: '200', timestamp: clock - 5_000 }] }));
    await Promise.all([btc, eth]);
    expect(transport).toHaveBeenCalledTimes(1); expect(sentinels.quota).toHaveBeenCalledTimes(1);
    expect(refs.cached('ETH-PERP')).toEqual({ price: 200, observedAt: clock - 5_000 });
    now += 55_000; expect(refs.cached('BTC-PERP')).toBeNull(); expect(refs.cached('ETH-PERP')).toBeNull(); assertReadOnly();
  });
});
describe('Planner real chart dependency path', () => {
  it.each([['15m', 900_000], ['1h', 3_600_000], ['4h', 14_400_000]] as const)('falls back to native Pacifica %s trade candles when OKX has no usable candles', async (timeframe, step) => {
    const now = Date.now(), opening = Math.floor(now / step) * step;
    const primary = vi.spyOn(datafeed, 'fetchOHLCV').mockResolvedValue([]);
    const transport = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => json({ success: true,
      data: [nativeRow(opening, timeframe, step), nativeRow(opening - step, timeframe, step)] }));
    vi.stubGlobal('fetch', transport);
    const bars = await defaultPlannerDeps.candles('BTC-PERP', timeframe, 100, new AbortController().signal);
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({ time: opening - step, provenance: { source: 'pacifica', venue: 'pacifica', basis: 'perp', proxy: 'direct', timeSemantic: 'open_time', finality: 'finalized' } });
    expect(bars[1].provenance.finality).toBe('forming'); expect(transport).toHaveBeenCalledTimes(1);
    expect(primary.mock.invocationCallOrder[0]).toBeLessThan(transport.mock.invocationCallOrder[0]);
    const url = new URL(String(transport.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe('https://api.pacifica.fi/api/v1/kline');
    expect(url.searchParams.get('symbol')).toBe('BTC'); expect(url.searchParams.get('interval')).toBe(timeframe);
    expect(url.searchParams.get('limit')).toBe('100'); expect(Number(url.searchParams.get('start_time'))).toBe(opening - 99 * step);
    expect(sentinels.quota).toHaveBeenCalledWith('/kline', 'background'); assertReadOnly();
  });
  it.each(['failure', 'invalid geometry', 'spot provenance'])('uses verified Pacifica fallback after OKX %s', async failure => {
    const now = Date.now(), opening = Math.floor(now / 3_600_000) * 3_600_000;
    const primary = vi.spyOn(datafeed, 'fetchOHLCV');
    if (failure === 'failure') primary.mockRejectedValue(new Error('EXAMPLE provider unavailable'));
    else primary.mockResolvedValue([{ time: opening, open: 100, high: failure === 'invalid geometry' ? 99 : 110, low: 90, close: 101, volume: 2,
      provenance: { source: 'okx', venue: 'okx', basis: failure === 'spot provenance' ? 'spot' : 'perp', proxy: 'direct', finality: 'forming', timeSemantic: 'open_time' } }]);
    const transport = vi.fn(async () => json({ success: true, data: [nativeRow(opening)] })); vi.stubGlobal('fetch', transport);
    const candles = await defaultPlannerDeps.candles('BTC-PERP', '1h', 100, new AbortController().signal);
    expect(candles).toHaveLength(1); expect(candles[0].provenance.source).toBe('pacifica');
    expect(transport).toHaveBeenCalledTimes(1); assertReadOnly();
  });
  it('refuses corrupt Pacifica identity, timing, numbers, ordering duplicates and oversized responses', async () => {
    const now = Date.now(), opening = Math.floor(now / 3_600_000) * 3_600_000, row = nativeRow(opening);
    const bad = [[{ ...row, s: 'ETH' }], [{ ...row, i: '15m' }], [{ ...row, t: opening + 1 }], [{ ...row, T: opening + 1 }],
      [{ ...row, o: 'NaN' }], [{ ...row, h: '99' }], [{ ...row, v: '-1' }], [row, row], Array.from({ length: 101 }, () => row)];
    for (const data of bad) {
      vi.stubGlobal('fetch', vi.fn(async () => json({ success: true, data })));
      expect(await pacificaPlannerCandles('BTC', '1h', 100, now, new AbortController().signal)).toEqual([]);
    }
    assertReadOnly();
  });
  it('uses cached price only and preserves its original clock', () => {
    expect(defaultPlannerDeps.cachedReference('BTC-PERP')).toEqual({ price: 100, observedAt: 1_800_000_000_000 }); assertReadOnly();
  });
  it('fetches bounded direct OKX perp candles with no persistent cache access or save', async () => {
    const now = Date.now(), step = 3_600_000;
    const transport = vi.fn(async (url: string | URL | Request, _options?: RequestInit) => String(url).includes('pacifica.fi') ? json({ success: false, data: [] }) : new Response(JSON.stringify({ code: '0', data: [
      [String(now - step), '100', '110', '90', '101', '1', '1', '1', '0'],
      [String(now - 101 * step), '100', '110', '90', '101', '1', '1', '1', '1'],
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', transport);
    const bars = await defaultPlannerDeps.candles('BTC-PERP', '1h', 100, new AbortController().signal);
    expect(bars).toHaveLength(1); expect(bars[0]).toMatchObject({ open: 100, close: 101, provenance: { source: 'okx', basis: 'perp', proxy: 'direct', finality: 'forming' } });
    expect(transport).toHaveBeenCalledTimes(1); expect(String(transport.mock.calls[0][0])).toContain('instId=BTC-USDT-SWAP');
    expect(sentinels.quota).not.toHaveBeenCalled(); assertReadOnly();
  });
  it('permanent missing instrument has no spot fallback and no persistence', async () => {
    const transport = vi.fn(async () => new Response(JSON.stringify({ code: '51001', msg: "Instrument doesn't exist", data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', transport);
    const bars = await defaultPlannerDeps.candles('EXAMPLE-PERP', '1h', 100, new AbortController().signal).catch(() => []);
    expect(bars).toEqual([]); expect(transport).toHaveBeenCalledTimes(2); assertReadOnly();
  });
  it('quota exhaustion skips Pacifica after the OKX primary fails', async () => {
    sentinels.quota.mockReturnValue(false);
    const transport = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => json({ code: '51001', data: [] })); vi.stubGlobal('fetch', transport);
    await defaultPlannerDeps.candles('BTC-PERP', '1h', 100, new AbortController().signal).catch(() => []);
    expect(transport).toHaveBeenCalledTimes(1); expect(String(transport.mock.calls[0][0])).toContain('okx.com'); assertReadOnly();
  });
  it('an in-flight caller abort stops OKX without starting Pacifica fallback', async () => {
    const transport = vi.fn((_url: string | URL | Request, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
    }));
    vi.stubGlobal('fetch', transport); const controller = new AbortController();
    const pending = defaultPlannerDeps.candles('BTC-PERP', '1h', 100, controller.signal); controller.abort();
    await expect(pending).rejects.toThrow(); expect(transport).toHaveBeenCalledTimes(1); assertReadOnly();
  });
  it('abort before transport performs no network/cache/order work', async () => {
    const transport = vi.fn(); vi.stubGlobal('fetch', transport); const controller = new AbortController(); controller.abort();
    await expect(defaultPlannerDeps.candles('BTC-PERP', '1h', 100, controller.signal)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled(); assertReadOnly();
  });
  it('keeps the newer valid real observation across the Planner and adapter caches', async () => {
    const observedAt = Date.now() - 5_000;
    const prices = vi.spyOn(sentinels.adapter, 'getCachedPrices').mockReturnValue({ 'BTC-PERP': 250 });
    const metadata = vi.spyOn(sentinels.adapter, 'getCachedPriceMeta').mockReturnValue({ oldestFetchedAt: observedAt - 1_000 });
    vi.stubGlobal('fetch', vi.fn(async () => json({ success: true, data: [{ symbol: 'BTC', timestamp: observedAt, mid: '100' }] })));
    await defaultPlannerDeps.refreshReference!('BTC-PERP', 'BTC', new AbortController().signal);
    expect(defaultPlannerDeps.cachedReference('BTC-PERP')).toEqual({ price: 100, observedAt });
    metadata.mockReturnValue({ oldestFetchedAt: observedAt + 1_000 });
    expect(defaultPlannerDeps.cachedReference('BTC-PERP')).toEqual({ price: 250, observedAt: observedAt + 1_000 });
    prices.mockReturnValue({ 'BTC-PERP': NaN });
    expect(defaultPlannerDeps.cachedReference('BTC-PERP')).toEqual({ price: 100, observedAt });
    prices.mockReturnValue({ 'BTC-PERP': 250 }); metadata.mockReturnValue({ oldestFetchedAt: Date.now() + 60_000 });
    expect(defaultPlannerDeps.cachedReference('BTC-PERP')).toEqual({ price: 100, observedAt }); assertReadOnly();
  });
});
