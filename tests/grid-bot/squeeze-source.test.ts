import { afterEach, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn(), claim: vi.fn(() => true) }));
vi.mock('../../server/lab/datafeed', () => ({ readPlannerPerpSource: mocks.read, readChartPerpSource: vi.fn() }));
vi.mock('../../server/protocol/pacifica/pacifica-quota', () => ({ pacificaQuota: { tryClaimImmediate: mocks.claim } }));
import { plannerPoolCandles } from '../../server/grid-planner/candle-pool';
import { pacificaPlannerCandles } from '../../server/grid-planner/pacifica-candles';
import type { PlannerCandle } from '../../server/grid-planner/types';
const DAY = 86400000;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); mocks.read.mockReset(); mocks.claim.mockReset().mockReturnValue(true); });
it('requests complete finalized daily history through the existing ordered range source pool', async () => {
  const end = Math.floor(Date.now() / DAY) * DAY, start = end - 385 * DAY;
  const rows: PlannerCandle[] = Array.from({ length: 385 }, (_, i) => ({ time: start + i * DAY, open: 100, high: 101, low: 99, close: 100, volume: 1,
    provenance: { source: 'gate', venue: 'gate', basis: 'perp', proxy: 'direct', timeSemantic: 'open_time', finality: 'finalized' } }));
  mocks.read.mockImplementation(async source => source === 'gate' ? rows : []);
  expect(await plannerPoolCandles('BTC-PERP', '1d', 385, new AbortController().signal)).toEqual(rows);
  expect(mocks.read.mock.calls.map(args => args[0])).toEqual(['okx', 'gate']);
  expect(mocks.read).toHaveBeenLastCalledWith('gate', 'BTC', '1d', start, end, expect.any(AbortSignal));
});
it('admits the native daily Pacifica fallback without admitting a forming day', async () => {
  const end = Math.floor(Date.now() / DAY) * DAY;
  const fetcher = vi.fn(async (_url: string, _options?: RequestInit) => ({ ok: true, json: async () => ({ success: true, data: [
    { s: 'BTC', i: '1d', t: end - DAY, T: end - 1, o: '100', h: '101', l: '99', c: '100', v: '1' },
  ] }) }));
  vi.stubGlobal('fetch', fetcher);
  const result = await pacificaPlannerCandles('BTC', '1d', 1, end, new AbortController().signal);
  expect(result).toHaveLength(1);
  expect(result[0].provenance.finality).toBe('finalized');
  expect(fetcher.mock.calls[0][0]).toContain('interval=1d');
  expect(mocks.claim).toHaveBeenCalledWith('/kline', 'background');
});
