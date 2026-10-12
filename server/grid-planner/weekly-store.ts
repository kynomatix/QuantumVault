import { btcUtcWeekStart, BTC_TREND_NEGATIVE_CACHE_MS, BTC_TREND_WEEK_MS, validBtcStoredWeek,
  type BtcStoredWeek } from '../../shared/grid-direction';

export interface BtcWeeklySnapshot { weeks: BtcStoredWeek[]; lastAttemptAt: number | null }
export interface BtcWeeklyStore {
  read(now: number): Promise<BtcWeeklySnapshot>;
  refresh(now: number, load: (signal: AbortSignal) => Promise<BtcStoredWeek[]>): Promise<void>;
}
type Query = (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>;
export interface WeeklyPool { query: Query; connect(): Promise<{ query: Query; release(error?: Error): void }> }

export class PostgresBtcWeeklyStore implements BtcWeeklyStore {
  constructor(private pool: WeeklyPool) {}
  async read(now: number): Promise<BtcWeeklySnapshot> {
    const result = await this.pool.query(`SELECT
      (SELECT jsonb_agg(w ORDER BY w.week_start) FROM (
        SELECT * FROM planner_btc_weekly_closes WHERE market = 'BTC' AND finalized
          AND week_start < $1 ORDER BY week_start DESC LIMIT 50
      ) w) AS weeks,
      (SELECT last_attempt_at FROM planner_btc_weekly_refresh WHERE market = 'BTC') AS last_attempt_at`,
      [new Date(btcUtcWeekStart(now))]);
    const row = result.rows[0];
    return { lastAttemptAt: row?.last_attempt_at ? new Date(row.last_attempt_at).getTime() : null,
      weeks: (row?.weeks ?? []).map((w: any) => ({ market: w.market, weekStart: new Date(w.week_start).getTime(),
        close: w.close, source: w.source, basis: w.basis, aggregation: w.aggregation,
        finalized: w.finalized, fetchedAt: new Date(w.fetched_at).getTime() })) };
  }
  async refresh(now: number, load: (signal: AbortSignal) => Promise<BtcStoredWeek[]>): Promise<void> {
    const client = await this.pool.connect();
    let locked = false, releaseError: Error | undefined;
    try {
      const lock = await client.query('SELECT pg_try_advisory_lock(196, 50) AS locked');
      locked = lock.rows[0]?.locked === true;
      if (!locked) return;
      const cutoff = btcUtcWeekStart(now), stored = await client.query(`SELECT week_start
        FROM planner_btc_weekly_closes WHERE market = 'BTC' AND finalized AND week_start < $1
        ORDER BY week_start DESC LIMIT 50`, [new Date(cutoff)]);
      if (stored.rows.length === 50 && stored.rows.every((row, i) =>
        new Date(row.week_start).getTime() === cutoff - (i + 1) * BTC_TREND_WEEK_MS)) return;
      // Autocommit before network I/O: errors and process death still consume the retry interval.
      const claim = await client.query(`INSERT INTO planner_btc_weekly_refresh (market, last_attempt_at)
        VALUES ('BTC', $1) ON CONFLICT (market) DO UPDATE SET last_attempt_at = EXCLUDED.last_attempt_at
        WHERE planner_btc_weekly_refresh.last_attempt_at <= $2 RETURNING market`,
        [new Date(now), new Date(now - BTC_TREND_NEGATIVE_CACHE_MS)]);
      if (!claim.rows.length) return;
      const signal = AbortSignal.timeout(20_000), weeks = await load(signal);
      signal.throwIfAborted();
      if (!weeks.length || weeks.length > 55 || !weeks.every(row => validBtcStoredWeek(row, Date.now())
        && row.weekStart >= cutoff - 55 * BTC_TREND_WEEK_MS && row.weekStart < cutoff)
        || new Set(weeks.map(row => row.weekStart)).size !== weeks.length) return;
      await client.query(`INSERT INTO planner_btc_weekly_closes
        (market, week_start, close, source, basis, aggregation, finalized, fetched_at)
        SELECT 'BTC', week_start, close, source, basis, aggregation, true, fetched_at
        FROM jsonb_to_recordset($1::jsonb) AS w(week_start timestamptz, close text, source text,
          basis text, aggregation text, fetched_at timestamptz)
        ON CONFLICT (market, week_start) DO NOTHING`, [JSON.stringify(weeks.map(row => ({
          week_start: new Date(row.weekStart).toISOString(), close: row.close, source: row.source,
          basis: row.basis, aggregation: row.aggregation, fetched_at: new Date(row.fetchedAt).toISOString() }))) ]);
    } catch (error) { releaseError = error instanceof Error ? error : new Error('Weekly refresh failed'); }
    finally {
      if (locked) {
        try { await client.query('SELECT pg_advisory_unlock(196, 50)'); }
        catch (error) { releaseError = error instanceof Error ? error : new Error('Weekly unlock failed'); }
      }
      client.release(releaseError);
    }
  }
}
