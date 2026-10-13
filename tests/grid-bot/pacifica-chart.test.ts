import { afterEach, expect, it, vi } from 'vitest';
const quota = vi.hoisted(() => vi.fn(() => true));
vi.mock('../../server/protocol/pacifica/pacifica-quota', () => ({ pacificaQuota: { tryClaimImmediate: quota } }));
import { pacificaPerpWindow, PERP_CHART_INTERVAL_MS } from '../../server/grid-planner/pacifica-candles';
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it.each(['1h', '2h', '4h', '12h', '1d'])('requests and verifies native Pacifica %s trade candles including the forming bar', async timeframe => {
  const duration = PERP_CHART_INTERVAL_MS[timeframe], now = Date.now(), open = Math.floor(now / duration) * duration;
  const rows = [open - duration, open].map(t => ({ t, T: t + duration, s: 'BTC', i: timeframe, o: '100', h: '110', l: '90', c: '101', v: '2' }));
  const transport = vi.fn(async (_input: string) => new Response(JSON.stringify({ success: true, data: rows }), { status: 200 }));
  vi.stubGlobal('fetch', transport);
  const result = await pacificaPerpWindow('BTC', timeframe, open - duration, now, new AbortController().signal);
  expect(result.map(c => c.provenance.finality)).toEqual(['finalized', 'forming']);
  const url = new URL(transport.mock.calls[0][0] as string);
  expect(url.pathname).toBe('/api/v1/kline'); expect(url.searchParams.get('interval')).toBe(timeframe);
  expect(quota).toHaveBeenCalledWith('/kline', 'background');
});
it('pages beyond the native 4000-bar limit without blending or repeating candles', async () => {
  const duration = PERP_CHART_INTERVAL_MS['1h'], end = Math.floor(Date.now() / duration) * duration, start = end - 4_001 * duration;
  const transport = vi.fn(async (input: string) => {
    const url = new URL(input), from = Number(url.searchParams.get('start_time')), to = Number(url.searchParams.get('end_time'));
    const rows = Array.from({ length: Math.floor((to + 1 - from) / duration) }, (_, i) => ({ t: from + i * duration, T: from + (i + 1) * duration, s: 'BTC', i: '1h', o: '100', h: '110', l: '90', c: '101', v: '2' }));
    return new Response(JSON.stringify({ success: true, data: rows }), { status: 200 });
  });
  vi.stubGlobal('fetch', transport);
  expect(await pacificaPerpWindow('BTC', '1h', start, end, new AbortController().signal)).toHaveLength(4_001);
  expect(transport).toHaveBeenCalledTimes(2);
  expect(transport.mock.calls.every(([url]) => Number(new URL(url).searchParams.get('limit')) <= 4_000)).toBe(true);
});
