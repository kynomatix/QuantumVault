import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NOW, days } from './fixtures';
const readers = vi.hoisted(() => ({ perp: vi.fn(), pacifica: vi.fn() }));
vi.mock('../../server/db', () => ({ pool: {} }));
vi.mock('../../server/ai-trader/cot-service', () => ({ getCotDisplaySnapshot: vi.fn() }));
vi.mock('../../server/lab/datafeed', () => ({ readPlannerPerpSource: readers.perp }));
vi.mock('../../server/grid-planner/pacifica-candles', () => ({ pacificaPerpWindow: readers.pacifica }));

describe('Market Stats daily source window', () => {
  beforeEach(() => { readers.perp.mockReset(); readers.pacifica.mockReset(); });
  it('requests only closed UTC history and fails over from incomplete windows', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      readers.perp.mockResolvedValueOnce(days().slice(1)).mockResolvedValueOnce(days());
      const { statsDailyCandles } = await import('../../server/market-stats/default-deps');
      const result = await statsDailyCandles();
      expect(result.candles).toHaveLength(364); expect(result.fetchedAt).toBe(NOW);
      expect(readers.perp.mock.calls.map(call => call[0])).toEqual(['okx', 'gate']);
      expect(readers.perp.mock.calls[0].slice(1, 5)).toEqual(['BTC', '1d', days()[0].time, days().at(-1)!.time + 86_400_000]);
      expect(readers.pacifica).not.toHaveBeenCalled();
    } finally { now.mockRestore(); }
  });
  it('returns unavailable history when all venues fail, without a synthetic or spot substitute', async () => {
    readers.perp.mockRejectedValue(Error('EXAMPLE unavailable')); readers.pacifica.mockResolvedValue([]);
    const { statsDailyCandles } = await import('../../server/market-stats/default-deps');
    expect((await statsDailyCandles()).candles).toEqual([]);
    expect(readers.perp).toHaveBeenCalledTimes(3); expect(readers.pacifica).toHaveBeenCalledOnce();
  });
});
