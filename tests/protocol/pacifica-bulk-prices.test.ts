import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter';
import { pacificaCache } from '../../server/protocol/pacifica/pacifica-cache';
import { pacificaQuota } from '../../server/protocol/pacifica/pacifica-quota';
import { parsePacificaPrices } from '../../server/protocol/pacifica/pacifica-prices';

const clock = 1_800_000_000_000;
const row = (symbol = 'BTC', mid = '100', timestamp = clock - 5_000) => ({ symbol, mid, timestamp, mark: '110', oracle: '120' });
const envelope = (...data: unknown[]) => ({ success: true, data });
const response = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200 });
function adapter() {
  const a = new PacificaAdapter({ baseUrl: 'https://test-pacifica.invalid' });
  (a as any).initialized = true;
  (a as any).marketCache = { fetchedAt: clock, data: ['BTC', 'ETH'].map(symbol => ({ internalSymbol: symbol, protocolSymbol: symbol })) };
  return a;
}
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(clock);
  pacificaCache.invalidateAll(); (pacificaCache as any).inflight.clear();
  (pacificaQuota as any).spends = []; pacificaQuota.resetCounters();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); (pacificaQuota as any).spends = []; });

describe('Pacifica documented bulk midpoint parser', () => {
  it('selects midpoint and original venue timestamp, without mixing mark or oracle', () => {
    expect([...parsePacificaPrices(envelope(row(), row('ETH', '200')), clock, 60_000)])
      .toEqual([['BTC', { price: 100, observedAt: clock - 5_000 }], ['ETH', { price: 200, observedAt: clock - 5_000 }]]);
  });
  it.each([null, [], {}, { success: false, data: [row()] }, { success: true, data: {} }])('rejects malformed envelope %j', payload => {
    expect(parsePacificaPrices(payload, clock, 60_000).size).toBe(0);
  });
  it.each([
    { ...row(), mid: undefined }, { ...row(), mid: '0' }, { ...row(), mid: '-1' }, { ...row(), mid: 'NaN' },
    { ...row(), mid: 'Infinity' }, { ...row(), mid: 100 }, { ...row(), mid: '1e2' },
    { ...row(), timestamp: clock - 60_000 }, { ...row(), timestamp: clock + 1 },
    { ...row(), timestamp: 0 }, { ...row(), timestamp: String(clock) }, { ...row(), timestamp: clock - 0.5 },
    { ...row(), symbol: 'btc' }, { ...row(), symbol: 'BTC-PERP' }, null,
  ])('omits invalid or expired rows without substituting another price %j', bad => {
    expect([...parsePacificaPrices(envelope(bad, row('ETH', '200')), clock, 60_000).keys()]).toEqual(['ETH']);
  });
  it('makes duplicate symbols unavailable even when one duplicate is malformed', () => {
    for (const rows of [[row(), row('BTC', '101')], [row(), { ...row(), mid: null }], [{ ...row(), mid: null }, row()]]) {
      expect(parsePacificaPrices(envelope(...rows), clock, 60_000).size).toBe(0);
    }
  });
});

describe('shared adapter bulk cache and consumer fail-closed reads', () => {
  it('serves two markets from one tagged bulk call and retains venue age in both cache views', async () => {
    const a = adapter(), fetchSpy = vi.fn(async (_url: string | URL | Request) => response(envelope(row(), row('ETH', '200')))); vi.stubGlobal('fetch', fetchSpy);
    const first = a.getAllPrices({ caller: 'routes.api-prices' });
    expect(a.getAllPrices({ caller: 'telegram.summary' })).toBe(first);
    expect(await first).toEqual({ BTC: 100, ETH: 200 });
    expect(await a.getPrice('ETH', { priority: 'critical', caller: 'ai.executor' })).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://test-pacifica.invalid/info/prices');
    expect(a.getCachedPriceMeta!(['BTC'])).toEqual({ oldestFetchedAt: clock - 5_000 });
    expect(pacificaQuota.snapshot().topCallers).toEqual([{ caller: 'routes.api-prices', credits: 2, calls: 1 }]);
    vi.mocked(Date.now).mockReturnValue(clock + 55_000);
    expect(a.getCachedPrices!(['BTC', 'ETH'])).toEqual({});
    expect(a.getCachedPriceMeta!(['BTC'])).toEqual({ oldestFetchedAt: null });
  });
  it('does not renew cached rows when the venue repeats the same timestamp', async () => {
    const a = adapter(), fetchSpy = vi.fn(async () => response(envelope(row()))); vi.stubGlobal('fetch', fetchSpy);
    expect(await a.getPrice('BTC', { priority: 'normal' })).toBe(100);
    vi.mocked(Date.now).mockReturnValue(clock + 55_000);
    expect(await a.getPrice('BTC', { priority: 'critical' })).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(a.getCachedPrices!(['BTC'])).toEqual({});
  });
  it.each([envelope(row('ETH', '200')), envelope({ ...row(), mid: undefined }), envelope(row('BTC', '100', clock - 60_000)), { success: false, data: [row()] }])
    ('returns unavailable for missing, malformed, stale or unsuccessful required markets %j', async payload => {
      const a = adapter(); vi.stubGlobal('fetch', vi.fn(async () => response(payload)));
      expect(await a.getPrice('BTC', { priority: 'normal', caller: 'ai.context' })).toBeNull();
      expect(a.getCachedPrices!(['BTC'])).toEqual({});
    });
  it('does not fall back to transport-cache prices after an upstream error', async () => {
    const a = adapter(); vi.stubGlobal('fetch', vi.fn(async () => response(envelope(row()))));
    expect(await a.getPrice('BTC', { priority: 'normal' })).toBe(100);
    vi.mocked(Date.now).mockReturnValue(clock + 55_000);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('EXAMPLE unavailable', { status: 429 })));
    expect(await a.getPrice('BTC', { priority: 'critical' })).toBeNull();
  });
  it('keeps a late older priority response from overwriting a newer observation', async () => {
    const a = adapter(); let complete!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { complete = resolve; }))
      .mockImplementationOnce(async () => response(envelope(row('BTC', '101', clock - 1_000)))));
    const background = a.getAllPrices();
    expect(await a.getPrice('BTC', { priority: 'critical' })).toBe(101);
    complete(response(envelope(row()))); await background;
    expect(await a.getPrice('BTC')).toBe(101);
    expect(a.getCachedPriceMeta!(['BTC'])).toEqual({ oldestFetchedAt: clock - 1_000 });
  });
  it('unknown markets never issue a price read', async () => {
    const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
    expect(await adapter().getPrice('EXAMPLE')).toBeNull(); expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('positions refuse missing prices instead of substituting entry price', async () => {
    const a = adapter(); vi.spyOn(a as any, 'get').mockResolvedValue([{ symbol: 'BTC', amount: '1', entry_price: '90', side: 'bid' }]);
    vi.spyOn(a, 'getAllPrices').mockResolvedValue({});
    await expect(a.getPositions('EXAMPLE')).rejects.toThrow(/position price unavailable/);
  });
  it('keeps orderbook bid/ask reads independent of the bulk midpoint cache', async () => {
    const a = adapter(); vi.spyOn(a as any, 'get').mockResolvedValue({ l: [[{ p: '99', a: '2' }], [{ p: '101', a: '3' }]] });
    vi.spyOn(a as any, 'getRegistry').mockReturnValue({ internalToProtocol: (symbol: string) => symbol });
    await a.getOrderbook('BTC');
    expect((a as any).get).toHaveBeenCalledWith('/book', expect.objectContaining({ symbol: 'BTC' }), expect.objectContaining({ caller: 'adapter.orderbook' }));
  });
});

describe('minute quota caller attribution', () => {
  it('aggregates physical spends by caller and expires them with the same rolling budget', () => {
    pacificaQuota.record('/book', undefined, 'adapter.orderbook');
    pacificaQuota.record('/info/prices', undefined, 'ai.context');
    pacificaQuota.record('/info/prices', undefined, 'ai.context');
    pacificaQuota.resetCounters();
    expect(pacificaQuota.snapshot().topCallers).toEqual([{ caller: 'ai.context', credits: 4, calls: 2 }, { caller: 'adapter.orderbook', credits: 1, calls: 1 }]);
    vi.mocked(Date.now).mockReturnValue(clock + 60_001);
    expect(pacificaQuota.snapshot().topCallers).toEqual([]);
  });
});
