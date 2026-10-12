import { afterEach, describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { observePacificaConstraints } from '../../server/protocol/market-constraints';
import { PlannerCharts, validateCandles } from '../../server/grid-planner/chart';
import { registerGridPlannerRoutes } from '../../server/grid-planner/routes';
import type { PlannerDeps } from '../../server/grid-planner/types';
import type { ProtocolMarket } from '../../server/protocol/protocol-types';
const clock = 1_800_000_000_000;
const candle = { time: clock - 3_600_000, open: 100, high: 110, low: 90, close: 101, volume: 2,
  provenance: { source: 'okx', venue: 'okx', basis: 'perp', proxy: 'direct', finality: 'finalized', timeSemantic: 'open_time' } } as const;
const makeDeps = (): PlannerDeps => ({ now: () => clock, cachedReference: vi.fn(() => ({ price: 100, observedAt: clock })),
  getMarkets: vi.fn(async () => [{ internalSymbol: 'BTC-PERP', protocolSymbol: 'BTC', fullName: 'Bitcoin', maxLeverage: 50, maxLeverageSource: 'venue',
    constraintObservation: observePacificaConstraints({ tick_size: '0.1', lot_size: '0.01', min_order_size: '10' }, 'BTC-PERP', clock) } as ProtocolMarket]),
  candles: vi.fn(async () => [{ ...candle }]) });
const servers: Server[] = [];
async function serve(enabled: boolean, deps: PlannerDeps) {
  const app = express(), load = vi.fn(async () => deps), auth = vi.fn((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const wallet = req.headers['x-wallet-address']; if (!wallet) return res.status(401).end();
    if (wallet !== 'EXAMPLE') return res.status(403).end(); next();
  });
  registerGridPlannerRoutes(app, auth, load, enabled);
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); }); servers.push(server);
  const port = (server.address() as { port: number }).port;
  return { load, auth, get: (path: string, wallet: string | null = 'EXAMPLE', method = 'GET') =>
    fetch(`http://127.0.0.1:${port}/api/grid-planner/${path}`, { method, headers: wallet ? { 'x-wallet-address': wallet } : {} }) };
}
afterEach(async () => { vi.useRealTimers(); for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(resolve => s.close(() => resolve())); } });
describe('bounded read-only Planner HTTP surface', () => {
  it('off flag registers no routes and loads no market, price or chart dependencies', async () => {
    const d = makeDeps(), s = await serve(false, d);
    for (const route of ['status', 'markets', 'preview', 'chart']) expect((await s.get(route)).status).toBe(404);
    expect(s.load).not.toHaveBeenCalled(); expect(d.getMarkets).not.toHaveBeenCalled();
  });
  it('auth runs before dependencies for every GET; POST is absent', async () => {
    const d = makeDeps(), s = await serve(true, d);
    for (const route of ['status', 'markets', 'preview', 'chart']) { expect((await s.get(route, null)).status).toBe(401); expect((await s.get(route, 'REDACTED')).status).toBe(403); }
    expect(s.load).not.toHaveBeenCalled(); expect((await s.get('preview', 'EXAMPLE', 'POST')).status).toBe(404);
    expect(await (await s.get('status')).json()).toEqual({ enabled: true, name: 'Grid Planner', planningOnly: true });
  });
  it('rejects unknown keys, repeated fields and unbounded query values before upstream work', async () => {
    const d = makeDeps(), s = await serve(true, d);
    for (const query of ['markets?account=EXAMPLE', 'chart?market=BTC-PERP&market=BTC-PERP', `chart?market=${'X'.repeat(81)}`, 'chart?market=BTC-PERP&timeframe=1m&bars=999']) expect((await s.get(query)).status).toBe(400);
    expect(d.getMarkets).not.toHaveBeenCalled(); expect(d.candles).not.toHaveBeenCalled();
  });
  it('serves the selected market only, preserves candles/provenance and does no price refresh', async () => {
    const d = makeDeps(), s = await serve(true, d);
    expect((await s.get('chart?market=ETH-PERP&timeframe=1h&bars=100')).status).toBe(404);
    const value = await (await s.get('chart?market=BTC-PERP&timeframe=1h&bars=100')).json();
    expect(value).toMatchObject({ state: 'available', actualBars: 1, partial: true, candles: [candle] });
    expect(d.getMarkets).toHaveBeenCalledTimes(1); expect(d.candles).toHaveBeenCalledTimes(1);
    const q = new URLSearchParams({ market: 'BTC-PERP', side: 'long', lower: '80', upper: '120', intervals: '4', entryScale: 'flat', profitScale: 'flat', seed: 'true', leverage: '1', investment: '1000', stop: '70', fee: '0' });
    expect(await (await s.get(`preview?${q}`)).json()).toMatchObject({ state: 'diagnostic', fee: { state: 'assumption' } });
    expect(d.candles).toHaveBeenCalledTimes(1); expect(d.getMarkets).toHaveBeenCalledTimes(1);
  });
  it('metadata failures are single-flight and cannot retry within five minutes', async () => {
    const d = makeDeps(); d.getMarkets = vi.fn(async () => { throw Error('EXAMPLE'); }); const s = await serve(true, d);
    expect((await s.get('markets')).status).toBe(503); expect((await s.get('markets')).status).toBe(503);
    expect(d.getMarkets).toHaveBeenCalledTimes(1);
  });
});
describe('chart work/cache bounds and provenance', () => {
  it('accepts native Pacifica candles but rejects mixed or mismatched venue provenance', async () => {
    const native = { ...candle, provenance: { ...candle.provenance, source: 'pacifica' as const, venue: 'pacifica' as const } };
    expect(validateCandles([native], clock)).toBe(true);
    expect(validateCandles([{ ...native, provenance: { ...native.provenance, venue: 'okx' } } as any], clock)).toBe(false);
    expect(validateCandles([candle, { ...native, time: candle.time + 1 }], clock)).toBe(false);
    const d = makeDeps(); d.candles = vi.fn(async () => [native]);
    const s = await serve(true, d);
    expect(await (await s.get('chart?market=BTC-PERP&timeframe=1h&bars=100')).json()).toMatchObject({ state: 'available', candles: [native] });
  });
  it('rejects spot/proxy/unknown provenance, invalid OHLC and unordered bars', () => {
    for (const provenance of [{ ...candle.provenance, basis: 'spot' }, { ...candle.provenance, proxy: 'proxy' }, { ...candle.provenance, finality: 'unknown' }])
      expect(validateCandles([{ ...candle, provenance } as any], clock)).toBe(false);
    expect(validateCandles([{ ...candle, high: 99 }], clock)).toBe(false); expect(validateCandles([candle, candle], clock)).toBe(false);
    expect(validateCandles([{ ...candle, time: clock + 1 }], clock)).toBe(false);
  });
  it('shared hits retain insertion and retrieval clocks; expiry requires a new start', async () => {
    const d = makeDeps(), charts = new PlannerCharts(d), signal = new AbortController().signal;
    const first = await charts.read('BTC-PERP', '15m', 100, signal); d.now = () => clock + 59_999;
    expect(await charts.read('BTC-PERP', '15m', 100, signal)).toMatchObject({ retrievedAt: clock, cacheInsertedAt: clock, validForMs: 1 });
    expect(d.candles).toHaveBeenCalledTimes(1); d.now = () => clock + 60_000;
    expect((await charts.read('BTC-PERP', '15m', 100, signal)).state).toBe('available'); expect(d.candles).toHaveBeenCalledTimes(2);
    expect(first.state).toBe('available');
  });
  it('does not free physical admission when an abort-ignoring upstream remains live', async () => {
    vi.useFakeTimers(); const d = makeDeps(); const resolve: Array<(value: typeof candle[]) => void> = [];
    d.candles = vi.fn(() => new Promise<typeof candle[]>(r => resolve.push(r))); const charts = new PlannerCharts(d);
    const a = new AbortController(), b = new AbortController();
    const first = charts.read('BTC-PERP', '1h', 100, a.signal), second = charts.read('ETH-PERP', '1h', 100, b.signal);
    await Promise.resolve(); a.abort(); b.abort(); expect((await first).state).toBe('unavailable'); expect((await second).state).toBe('unavailable');
    expect(await charts.read('SOL-PERP', '1h', 100, new AbortController().signal)).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('busy') });
    expect(d.candles).toHaveBeenCalledTimes(2);
    resolve.forEach(r => r([candle])); await vi.runAllTimersAsync();
    d.candles = vi.fn(async () => [candle]); expect((await charts.read('SOL-PERP', '1h', 100, new AbortController().signal)).state).toBe('available');
  });
  it('joins identical work, bounds waiting callers and enforces 12 starts per minute', async () => {
    vi.useFakeTimers(); const d = makeDeps(); let finish!: (value: typeof candle[]) => void;
    d.candles = vi.fn(() => new Promise<typeof candle[]>(r => { finish = r; })); const charts = new PlannerCharts(d);
    const shared = Array.from({ length: 8 }, () => charts.read('BTC-PERP', '1h', 100, new AbortController().signal)); await Promise.resolve();
    expect((await charts.read('BTC-PERP', '1h', 100, new AbortController().signal)).state).toBe('unavailable'); finish([candle]);
    await Promise.all(shared); expect(d.candles).toHaveBeenCalledTimes(1); d.candles = vi.fn(async () => [candle]);
    for (let i = 0; i < 11; i++) expect((await charts.read(`EXAMPLE${i}`, '1h', 100, new AbortController().signal)).state).toBe('available');
    expect((await charts.read('REDACTED', '1h', 100, new AbortController().signal)).state).toBe('unavailable');
  });
  it('synchronous dependency failure settles and releases slots without leaked timers', async () => {
    const d = makeDeps(); d.candles = vi.fn(() => { throw Error('EXAMPLE'); }); const charts = new PlannerCharts(d);
    for (let i = 0; i < 3; i++) expect((await charts.read(`EXAMPLE${i}`, '1h', 100, new AbortController().signal)).state).toBe('unavailable');
    expect(d.candles).toHaveBeenCalledTimes(3);
  });
});
