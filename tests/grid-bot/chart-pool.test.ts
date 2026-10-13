import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn(), pacifica: vi.fn() }));
vi.mock('../../server/lab/datafeed', () => ({ readPlannerPerpSource: vi.fn(), readChartPerpSource: mocks.read }));
vi.mock('../../server/grid-planner/pacifica-candles', async importOriginal => ({
  ...await importOriginal<typeof import('../../server/grid-planner/pacifica-candles')>(), pacificaPerpWindow: mocks.pacifica,
}));
vi.mock('../../server/protocol/pacifica/pacifica-quota', () => ({ pacificaQuota: { tryClaimImmediate: vi.fn(() => true) } }));
import { chartPoolCandles } from '../../server/grid-planner/candle-pool';
import { PERP_CHART_INTERVAL_MS } from '../../server/grid-planner/pacifica-candles';
import type { PlannerCandle } from '../../server/grid-planner/types';
const bars = (source: 'okx' | 'gate' | 'hyperliquid' | 'pacifica', start: number, duration: number): PlannerCandle[] =>
  Array.from({ length: 3 }, (_, i) => ({ time: start + i * duration, open: 100, high: 110, low: 90, close: 101, volume: 2,
    provenance: { source, venue: source, basis: 'perp', proxy: 'direct', timeSemantic: 'open_time', finality: 'finalized' } } as PlannerCandle));
afterEach(() => vi.resetAllMocks());
describe('shared native perpetual chart pool', () => {
  it.each(['1h', '2h', '4h', '12h', '1d'])('serves %s through Pacifica after earlier sources fail, skipping unsupported Gate intervals', async timeframe => {
    const duration = PERP_CHART_INTERVAL_MS[timeframe], end = Math.floor(Date.now() / duration) * duration, start = end - 3 * duration;
    mocks.read.mockResolvedValue([]); mocks.pacifica.mockResolvedValue(bars('pacifica', start, duration));
    const result = await chartPoolCandles('BTC/USDT', timeframe, start, end, new AbortController().signal);
    expect(result).toHaveLength(3); expect(result.every(c => c.provenance.source === 'pacifica')).toBe(true);
    expect(mocks.read.mock.calls.map(c => c[0])).toEqual(['2h', '12h'].includes(timeframe) ? ['okx', 'hyperliquid'] : ['okx', 'gate', 'hyperliquid']);
    expect(mocks.pacifica).toHaveBeenCalledWith('BTC', timeframe, start, end, expect.any(AbortSignal));
  });
  it.each(['okx', 'gate', 'hyperliquid'] as const)('stops at the first verified %s response', async source => {
    const duration = PERP_CHART_INTERVAL_MS['1h'], end = Math.floor(Date.now() / duration) * duration, start = end - 3 * duration;
    mocks.read.mockImplementation(async provider => provider === source ? bars(source, start, duration) : []);
    expect((await chartPoolCandles('BTC', '1h', start, end, new AbortController().signal))[0].provenance.source).toBe(source);
    expect(mocks.read.mock.calls.at(-1)![0]).toBe(source); expect(mocks.pacifica).not.toHaveBeenCalled();
  });
  it.each(['spot', 'mixed', 'gap', 'stale'])('rejects %s instead of stitching it into another source', async invalid => {
    const duration = PERP_CHART_INTERVAL_MS['1h'], end = Math.floor(Date.now() / duration) * duration, start = end - 3 * duration;
    const bad = bars('okx', start, duration);
    if (invalid === 'spot') bad[0].provenance.basis = 'spot';
    if (invalid === 'mixed') bad[1] = bars('gate', start + duration, duration)[0];
    if (invalid === 'gap') bad.splice(1, 1);
    if (invalid === 'stale') bad.forEach(c => { c.time -= 10 * duration; });
    mocks.read.mockImplementation(async provider => provider === 'okx' ? bad : provider === 'gate' ? bars('gate', start, duration) : []);
    expect((await chartPoolCandles('BTC', '1h', start, end, new AbortController().signal)).every(c => c.provenance.source === 'gate')).toBe(true);
  });
});
