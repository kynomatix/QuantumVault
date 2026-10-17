import { describe, it, expect, vi } from 'vitest';
import { MarketStatsCache } from '../../server/market-stats/cache';
import { getMarketStats, type MarketStatsDeps } from '../../server/market-stats/service';
import { computeBtcDirection } from '../../server/grid-planner/direction';
import { DAY } from '../../server/market-stats/sources';
import { NOW, weeks, days } from './fixtures';

export function dependencies(clock = { now: NOW }): MarketStatsDeps {
  return { cache: new MarketStatsCache(), now: () => clock.now,
    direction: vi.fn(async () => computeBtcDirection(weeks(), clock.now)),
    dailyCandles: vi.fn(async () => ({ candles: days(clock.now), fetchedAt: clock.now })),
    cot: vi.fn(async () => ({ reportDate: '2026-10-13', commIndex: 50, dumbIndex: 40, weeksInWindow: 120,
      fetchedAt: clock.now, retryAt: clock.now + DAY, latestFlip: null })),
    funding: vi.fn(async () => ({ fundingRate: 0, openInterest: 0, fetchedAt: clock.now })) };
}
describe('in-process Market Stats cache', () => {
  it('coalesces concurrent requests for every source and warm loads retain timestamps', async () => {
    const clock = { now: NOW }, deps = dependencies(clock);
    const [one, two] = await Promise.all([getMarketStats(deps, NOW), getMarketStats(deps, NOW)]);
    expect(one).toEqual(two);
    for (const reader of [deps.direction, deps.dailyCandles, deps.cot, deps.funding]) expect(reader).toHaveBeenCalledTimes(1);
    clock.now++;
    expect((await getMarketStats(deps, clock.now)).funding.asOf).toBe(NOW);
    expect(deps.funding).toHaveBeenCalledTimes(1);
  });
  it('expires funding after one hour while other source groups remain cached', async () => {
    const clock = { now: NOW }, deps = dependencies(clock);
    await getMarketStats(deps, clock.now); clock.now += 3_600_000;
    await getMarketStats(deps, clock.now);
    expect(deps.funding).toHaveBeenCalledTimes(2);
    expect(deps.dailyCandles).toHaveBeenCalledTimes(1); expect(deps.cot).toHaveBeenCalledTimes(1);
  });
  it('negative-caches a provider failure and returns successful partial results', async () => {
    const clock = { now: NOW }, deps = dependencies(clock);
    vi.mocked(deps.funding).mockRejectedValue(Error('EXAMPLE provider failure'));
    const result = await getMarketStats(deps, NOW);
    expect(result.funding.status).toBe('unavailable'); expect(result.cycle.status).toBe('available');
    expect(result.cot.status).toBe('available'); expect(result.dow.daily.status).toBe('available');
    clock.now += 59_999; await getMarketStats(deps, clock.now); expect(deps.funding).toHaveBeenCalledTimes(1);
    clock.now++; await getMarketStats(deps, clock.now); expect(deps.funding).toHaveBeenCalledTimes(2);
  });
  it('rolls daily history at midnight and keeps original weekly MA validity', async () => {
    const clock = { now: NOW }, deps = dependencies(clock);
    await getMarketStats(deps, clock.now); clock.now = Date.UTC(2026, 9, 18);
    await getMarketStats(deps, clock.now);
    expect(deps.dailyCandles).toHaveBeenCalledTimes(2); expect(deps.direction).toHaveBeenCalledTimes(1);
  });
  it('cannot resurrect an available card that expires while another source is loading', async () => {
    const clock = { now: NOW }, deps = dependencies(clock);
    vi.mocked(deps.cot).mockResolvedValueOnce({ reportDate: '2026-10-13', commIndex: 50, dumbIndex: 40,
      weeksInWindow: 120, fetchedAt: NOW, retryAt: NOW + 3_599_999, latestFlip: null });
    await getMarketStats(deps, NOW);
    clock.now = NOW + 3_599_999;
    vi.mocked(deps.cot).mockImplementation(async () => { clock.now += 2; return null; });
    const result = await getMarketStats(deps, clock.now);
    expect(result.funding.status).toBe('unavailable');
    expect(result.funding.asOf).toBe(NOW);
    expect(deps.funding).toHaveBeenCalledTimes(1);
    expect(result.serverNow).toBe(clock.now);
  });
  it('drops in-flight ownership after rejected work and handles clock rollback', async () => {
    const cache = new MarketStatsCache(), load = vi.fn().mockRejectedValueOnce(Error('EXAMPLE')).mockResolvedValue({ expiresAt: 300 });
    await expect(cache.read('card', 100, load, v => v.expiresAt)).rejects.toThrow('EXAMPLE');
    await cache.read('card', 100, load, v => v.expiresAt);
    await cache.read('card', 99, load, v => v.expiresAt);
    expect(load).toHaveBeenCalledTimes(3);
  });
});
