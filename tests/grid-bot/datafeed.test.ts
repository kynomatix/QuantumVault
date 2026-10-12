import { afterEach, describe, it, expect, vi } from 'vitest';
const sentinels = vi.hoisted(() => ({ cacheRead: vi.fn(() => { throw Error('EXAMPLE: persistent read forbidden'); }),
  cacheWrite: vi.fn(() => { throw Error('EXAMPLE: persistent write forbidden'); }),
  adapter: { getMarkets: vi.fn(async () => []), getCachedPrices: vi.fn(() => ({ 'BTC-PERP': 100 })),
    getCachedPriceMeta: vi.fn(() => ({ oldestFetchedAt: 1_800_000_000_000 })),
    getPrice: vi.fn(() => { throw Error('EXAMPLE: price refresh forbidden'); }),
    getAccount: vi.fn(() => { throw Error('EXAMPLE: account read forbidden'); }),
    placeOrder: vi.fn(() => { throw Error('EXAMPLE: mutation forbidden'); }) } }));
vi.mock('../../server/lab/candle-store', () => ({ getCachedCandles: sentinels.cacheRead, getCachedCandlesBatch: sentinels.cacheRead,
  isCandleBatchPartialReadError: () => false, saveCandlesToDb: sentinels.cacheWrite, CACHE_BUDGET_ABORT_REASON: 'EXAMPLE' }));
vi.mock('../../server/telemetry', () => ({ appendTelemetry: vi.fn() }));
vi.mock('../../server/protocol/adapter-registry', () => ({ getAdapter: () => sentinels.adapter }));
import { defaultPlannerDeps } from '../../server/grid-planner/default-deps';
import { __testResetOkxSourceBreaker } from '../../server/lab/datafeed';
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); __testResetOkxSourceBreaker(); });
const assertReadOnly = () => {
  expect(sentinels.cacheRead).not.toHaveBeenCalled(); expect(sentinels.cacheWrite).not.toHaveBeenCalled();
  expect(sentinels.adapter.getPrice).not.toHaveBeenCalled(); expect(sentinels.adapter.getAccount).not.toHaveBeenCalled(); expect(sentinels.adapter.placeOrder).not.toHaveBeenCalled();
};
describe('Planner real chart dependency path', () => {
  it('uses cached price only and preserves its original clock', () => {
    expect(defaultPlannerDeps.cachedReference('BTC-PERP')).toEqual({ price: 100, observedAt: 1_800_000_000_000 }); assertReadOnly();
  });
  it('fetches bounded direct OKX perp candles with no persistent cache access or save', async () => {
    const now = Date.now(), step = 3_600_000;
    const transport = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => new Response(JSON.stringify({ code: '0', data: [
      [String(now - step), '100', '110', '90', '101', '1', '1', '1', '0'],
      [String(now - 101 * step), '100', '110', '90', '101', '1', '1', '1', '1'],
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', transport);
    const bars = await defaultPlannerDeps.candles('BTC-PERP', '1h', 100, new AbortController().signal);
    expect(bars).toHaveLength(1); expect(bars[0]).toMatchObject({ open: 100, close: 101, provenance: { source: 'okx', basis: 'perp', proxy: 'direct', finality: 'forming' } });
    expect(transport).toHaveBeenCalledTimes(1); expect(String(transport.mock.calls[0][0])).toContain('instId=BTC-USDT-SWAP'); assertReadOnly();
  });
  it('permanent missing instrument has no spot fallback and no persistence', async () => {
    const transport = vi.fn(async () => new Response(JSON.stringify({ code: '51001', msg: "Instrument doesn't exist", data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', transport);
    const bars = await defaultPlannerDeps.candles('EXAMPLE-PERP', '1h', 100, new AbortController().signal).catch(() => []);
    expect(bars).toEqual([]); expect(transport).toHaveBeenCalledTimes(1); assertReadOnly();
  });
  it('abort before transport performs no network/cache/order work', async () => {
    const transport = vi.fn(); vi.stubGlobal('fetch', transport); const controller = new AbortController(); controller.abort();
    await expect(defaultPlannerDeps.candles('BTC-PERP', '1h', 100, controller.signal)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled(); assertReadOnly();
  });
});
