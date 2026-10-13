import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ pool: vi.fn(), read: vi.fn(), save: vi.fn() }));
vi.mock('../../server/lab/candle-store', () => ({ getCachedCandles: mocks.read, saveCandlesToDb: mocks.save }));
vi.mock('../../server/grid-planner/candle-pool', async importOriginal => ({
  ...await importOriginal<typeof import('../../server/grid-planner/candle-pool')>(), chartPoolCandles: mocks.pool,
}));
vi.mock('../../server/telemetry', () => ({ appendTelemetry: vi.fn() }));
import { fetchChartCandles, __testResetChartCache } from '../../server/trading/chart-candles';
import type { PlannerCandle } from '../../server/grid-planner/types';
const hour = 3_600_000;
const end = Math.floor(Date.now() / hour) * hour;
const bars = (source: 'okx' | 'gate' | 'pacifica', start: number, count: number): PlannerCandle[] =>
  Array.from({ length: count }, (_, i) => ({ time: start + i * hour, open: 100, high: 110, low: 90, close: 101, volume: 2,
    provenance: { source, venue: source, basis: 'perp', proxy: 'direct', timeSemantic: 'open_time', finality: 'finalized' } } as PlannerCandle));
beforeEach(() => { __testResetChartCache(); vi.clearAllMocks(); mocks.read.mockResolvedValue(null); mocks.save.mockResolvedValue(undefined); });
describe('chart source-pure cache and append', () => {
  it('refetches the full window when the cached OKX tail fails, never splicing Gate onto it', async () => {
    const start = end - 10 * hour;
    mocks.read.mockResolvedValue(bars('okx', start, 6));
    mocks.pool.mockResolvedValueOnce([]).mockResolvedValueOnce(bars('gate', start, 10));
    const result = await fetchChartCandles('BTC/USDT', '1h', start, end, undefined, { cacheWritePolicy: 'skip' });
    expect(mocks.pool.mock.calls[0]).toEqual(['BTC/USDT', '1h', start + 5 * hour, end, expect.any(AbortSignal), 'okx']);
    expect(mocks.pool.mock.calls[1]).toEqual(['BTC/USDT', '1h', start, end, expect.any(AbortSignal)]);
    expect(result.map(c => c.provenance.source)).toEqual(Array(10).fill('gate'));
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('refreshes the overlapping bar and appends a same-source tail without losing the cached prefix', async () => {
    const start = end - 10 * hour;
    mocks.read.mockResolvedValue(bars('okx', start, 6));
    const tail = bars('okx', start + 5 * hour, 5); tail[0].close = 105;
    mocks.pool.mockResolvedValueOnce(tail);
    const result = await fetchChartCandles('BTC/USDT', '1h', start, end);
    expect(result).toHaveLength(10); expect(result[5].close).toBe(105);
    expect(mocks.pool).toHaveBeenCalledTimes(1); expect(mocks.save).toHaveBeenCalledWith('BTC/USDT', '1h', result);
  });
  it('reuses Pacifica historical cache without writing it into the shared DB or refetching', async () => {
    const to = end - 20 * hour, start = to - 10 * hour;
    mocks.pool.mockResolvedValueOnce(bars('pacifica', start, 10));
    const first = await fetchChartCandles('BTC/USDT', '1h', start, to);
    expect(await fetchChartCandles('BTC/USDT', '1h', start, to)).toEqual(first);
    expect(mocks.pool).toHaveBeenCalledTimes(1); expect(mocks.save).not.toHaveBeenCalled();
  });
  it('bypass cache always obtains a fresh, complete source-pure response', async () => {
    const start = end - 10 * hour;
    mocks.read.mockResolvedValue(bars('okx', start, 10));
    mocks.pool.mockResolvedValueOnce(bars('pacifica', start, 10));
    expect((await fetchChartCandles('BTC/USDT', '1h', start, end, undefined, { bypassCache: true }))[0].provenance.source).toBe('pacifica');
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it('retains fallback history when a narrow same-source tail refreshes the cache', async () => {
    const to = end - 20 * hour, start = to - 10 * hour;
    mocks.pool.mockResolvedValueOnce(bars('pacifica', start, 10)).mockResolvedValueOnce(bars('pacifica', to - 3 * hour, 3));
    await fetchChartCandles('BTC/USDT', '1h', start, to);
    await fetchChartCandles('BTC/USDT', '1h', to - 3 * hour, to, undefined, { bypassCache: true });
    expect(await fetchChartCandles('BTC/USDT', '1h', start, to)).toHaveLength(10);
    expect(mocks.pool).toHaveBeenCalledTimes(2);
  });
  it('does not append a gapped same-source tail', async () => {
    const start = end - 10 * hour;
    mocks.read.mockResolvedValue(bars('okx', start, 6));
    mocks.pool.mockResolvedValueOnce(bars('okx', start + 7 * hour, 3)).mockResolvedValueOnce(bars('gate', start, 10));
    const result = await fetchChartCandles('BTC/USDT', '1h', start, end, undefined, { cacheWritePolicy: 'skip' });
    expect(result.every(c => c.provenance.source === 'gate')).toBe(true);
  });
});
