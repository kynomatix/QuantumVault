import type { Pool } from 'pg';
import type { WeeklyPool } from '../grid-planner/weekly-store';

/** Request-scoped budget on the existing pool; late acquisitions are immediately released. */
export function boundedStatsPool(pool: Pool, deadlineAt: number): WeeklyPool {
  const connect: WeeklyPool['connect'] = () => new Promise((resolve, reject) => {
    const remaining = Math.min(1_000, deadlineAt - Date.now());
    if (remaining <= 0) { reject(new Error('Market data database deadline exceeded')); return; }
    let expired = false;
    const timer = setTimeout(() => { expired = true; reject(new Error('Market data database busy')); }, remaining);
    pool.connect((error, client, done) => {
      clearTimeout(timer);
      if (expired) { done?.(); return; }
      if (error || !client || !done) { reject(error ?? new Error('Market data database unavailable')); return; }
      let released = false;
      const release = (failure?: Error) => { if (!released) { released = true; done(failure); } };
      resolve({ release, query: async (text, values) => {
        const budget = Math.min(1_000, deadlineAt - Date.now());
        if (budget <= 0 || released) throw new Error('Market data database deadline exceeded');
        try { return await client.query({ text, values, query_timeout: budget }); }
        catch (failure) { release(failure instanceof Error ? failure : new Error('Market data query failed')); throw failure; }
      } });
    });
  });
  return { connect, query: async (text, values) => {
    const client = await connect();
    try { return await client.query(text, values); } finally { client.release(); }
  } };
}
