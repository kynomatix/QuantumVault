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
import { __testResetOkxSourceBreaker } from '../../server/lab/datafeed';
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); sentinels.quota.mockReturnValue(true); __testResetOkxSourceBreaker(); });
const json = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
const nativeRow = (time: number, interval = '1h', duration = 3_600_000) =>
  ({ t: time, T: time + duration, s: 'BTC', i: interval, o: '100', h: '110', l: '90', c: '101', v: '2' });
const assertReadOnly = () => {
  expect(sentinels.cacheRead).not.toHaveBeenCalled(); expect(sentinels.cacheWrite).not.toHaveBeenCalled();
  expect(sentinels.adapter.getPrice).not.toHaveBeenCalled(); expect(sentinels.adapter.getAccount).not.toHaveBeenCalled(); expect(sentinels.adapter.placeOrder).not.toHaveBeenCalled();
};
describe('Planner real chart dependency path', () => {
  it.each([['15m', 900_000], ['1h', 3_600_000], ['4h', 14_400_000]] as const)('uses native Pacifica %s trade candles before OKX with exact provenance and finality', async (timeframe, step) => {
    const now = Date.now(), opening = Math.floor(now / step) * step;
    const transport = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => json({ success: true,
      data: [nativeRow(opening, timeframe, step), nativeRow(opening - step, timeframe, step)] }));
    vi.stubGlobal('fetch', transport);
    const bars = await defaultPlannerDeps.candles('BTC-PERP', timeframe, 100, new AbortController().signal);
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({ time: opening - step, provenance: { source: 'pacifica', venue: 'pacifica', basis: 'perp', proxy: 'direct', timeSemantic: 'open_time', finality: 'finalized' } });
    expect(bars[1].provenance.finality).toBe('forming'); expect(transport).toHaveBeenCalledTimes(1);
    const url = new URL(String(transport.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe('https://api.pacifica.fi/api/v1/kline');
    expect(url.searchParams.get('symbol')).toBe('BTC'); expect(url.searchParams.get('interval')).toBe(timeframe);
    expect(url.searchParams.get('limit')).toBe('100'); expect(Number(url.searchParams.get('start_time'))).toBe(opening - 99 * step);
    expect(sentinels.quota).toHaveBeenCalledWith('/kline', 'background'); assertReadOnly();
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
    expect(transport).toHaveBeenCalledTimes(2); expect(String(transport.mock.calls[1][0])).toContain('instId=BTC-USDT-SWAP'); assertReadOnly();
  });
  it('permanent missing instrument has no spot fallback and no persistence', async () => {
    const transport = vi.fn(async () => new Response(JSON.stringify({ code: '51001', msg: "Instrument doesn't exist", data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', transport);
    const bars = await defaultPlannerDeps.candles('EXAMPLE-PERP', '1h', 100, new AbortController().signal).catch(() => []);
    expect(bars).toEqual([]); expect(transport).toHaveBeenCalledTimes(2); assertReadOnly();
  });
  it('quota exhaustion skips optional Pacifica work and retains the OKX-only fallback', async () => {
    sentinels.quota.mockReturnValue(false);
    const transport = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => json({ code: '51001', data: [] })); vi.stubGlobal('fetch', transport);
    await defaultPlannerDeps.candles('BTC-PERP', '1h', 100, new AbortController().signal).catch(() => []);
    expect(transport).toHaveBeenCalledTimes(1); expect(String(transport.mock.calls[0][0])).toContain('okx.com'); assertReadOnly();
  });
  it('an in-flight caller abort stops Pacifica without starting OKX fallback', async () => {
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
});
