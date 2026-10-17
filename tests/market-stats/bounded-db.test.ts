import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { boundedStatsPool } from '../../server/market-stats/bounded-db';

describe('request-scoped database budget', () => {
  afterEach(() => vi.useRealTimers());
  it('releases a late acquisition without running a query', async () => {
    vi.useFakeTimers();
    let acquired!: (error: Error | undefined, client: unknown, done: () => void) => void;
    const pool = { connect: vi.fn(callback => { acquired = callback; }) } as unknown as Pool;
    const query = vi.fn(), done = vi.fn();
    const result = boundedStatsPool(pool, Date.now() + 24_000).query('SELECT 1').catch(error => error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toBeInstanceOf(Error);
    acquired(undefined, { query }, done);
    expect(done).toHaveBeenCalledOnce(); expect(query).not.toHaveBeenCalled();
  });
  it('bounds a query and destroys a failed connection exactly once', async () => {
    const query = vi.fn().mockRejectedValue(Error('EXAMPLE timeout')), done = vi.fn();
    const pool = { connect: (callback: Function) => callback(null, { query }, done) } as unknown as Pool;
    await expect(boundedStatsPool(pool, Date.now() + 24_000).query('SELECT $1', [1])).rejects.toThrow('EXAMPLE');
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ text: 'SELECT $1', values: [1], query_timeout: 1_000 }));
    expect(done).toHaveBeenCalledOnce(); expect(done.mock.calls[0][0]).toBeInstanceOf(Error);
  });
  it('refuses work after the request deadline', async () => {
    const connect = vi.fn();
    await expect(boundedStatsPool({ connect } as unknown as Pool, Date.now() - 1).query('SELECT 1')).rejects.toThrow('deadline');
    expect(connect).not.toHaveBeenCalled();
  });
});
