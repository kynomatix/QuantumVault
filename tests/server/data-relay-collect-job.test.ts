import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextCollectionTime, startDataRelayCollectJob } from '../../server/data-relay-collect-job';
import type { CollectResult } from '../../server/market-stats/liquidations-relay';

const HOUR = 3_600_000, midnight = Date.UTC(2026, 9, 18);
let stop = () => {};
afterEach(() => { stop(); vi.useRealTimers(); });
function setup(deployment = '1') {
  vi.useFakeTimers(); vi.setSystemTime(midnight + 2 * 60_000);
  const collect = vi.fn(async (): Promise<CollectResult> => ({ status: 'done', durationMs: 10, partial: true }));
  const log = vi.fn(); const options = { deployment, collect, now: Date.now, log };
  stop = startDataRelayCollectJob(options);
  return { collect, log, options };
}
describe('production-only relay collection timer', () => {
  it.each(['0', '', 'true', undefined])('does not run outside exact deployment 1 (%s)', async deployment => {
    const { collect } = setup(deployment ?? ''); await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(collect).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('schedules UTC minute 3 without startup work or missed-hour catch-up', async () => {
    const { collect, log } = setup(); expect(collect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(59_999); expect(collect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(collect).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith({ status: 'done', durationMs: 10, partial: true });
    expect(nextCollectionTime(midnight + 3 * 60_000)).toBe(midnight + HOUR + 3 * 60_000);
    await vi.advanceTimersByTimeAsync(HOUR); expect(collect).toHaveBeenCalledTimes(2);
  });
  it('has one timer owner and one in-flight request per process', async () => {
    const { options, collect } = setup(); let finish!: (result: CollectResult) => void;
    collect.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    expect(startDataRelayCollectJob(options)).toBe(stop);
    await vi.advanceTimersByTimeAsync(60_000 + HOUR); expect(collect).toHaveBeenCalledOnce();
    finish({ status: 'done', durationMs: HOUR }); await vi.advanceTimersByTimeAsync(HOUR);
    expect(collect).toHaveBeenCalledTimes(2);
  });
  it('logs a not-ready response at most once an hour without retries', async () => {
    const { collect, log } = setup(); collect.mockResolvedValue({ status: 'not-ready', httpStatus: 404, durationMs: 10 });
    await vi.advanceTimersByTimeAsync(60_000 + HOUR - 1);
    expect(collect).toHaveBeenCalledOnce(); expect(log).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(collect).toHaveBeenCalledTimes(2); expect(log).toHaveBeenCalledTimes(2);
  });
  it('drops exception text and unknown response fields from logs and permits the next hour', async () => {
    const { collect, log } = setup(); collect.mockRejectedValueOnce(new Error('EXAMPLE'));
    await vi.advanceTimersByTimeAsync(60_000); expect(log.mock.calls[0][0]).toEqual({ status: 'malformed', durationMs: 0 });
    collect.mockResolvedValue({ status: 'done', durationMs: 10, body: 'EXAMPLE' } as CollectResult);
    await vi.advanceTimersByTimeAsync(HOUR); expect(collect).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain('EXAMPLE');
    stop(); await vi.advanceTimersByTimeAsync(HOUR); expect(collect).toHaveBeenCalledTimes(2);
  });
});
