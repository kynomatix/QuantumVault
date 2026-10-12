import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PostgresBtcWeeklyStore } from '../../server/grid-planner/weekly-store';
import { btcUtcWeekStart, BTC_TREND_WEEK_MS as WEEK, type BtcStoredWeek } from '../../shared/grid-direction';
import { probeSchemaMigrationManifest, type CatalogQuery } from '../../server/schema-readiness';
import { readDbSchemaMigrationManifest } from '../helpers/schema-migration-manifest';

// The desktop runner owns the database URL. Everything rolls back in a private schema.
describe.skipIf(!process.env.DATABASE_URL)('BTC weekly migration on PostgreSQL', () => {
  it('boots twice, enforces finalized UTC weeks and decimal/provenance constraints, and deduplicates weeks', async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000,
      query_timeout: 5000, statement_timeout: 5000 });
    const schema = 'weekly_test_' + randomUUID().replaceAll('-', '');
    const sql = readFileSync(new URL('../../migrations/0008_planner_btc_weekly.sql', import.meta.url), 'utf8')
      .replaceAll('public.planner_btc_weekly_', schema + '.planner_btc_weekly_');
    const migration = readDbSchemaMigrationManifest().manifest.find(entry => entry.id === '196-planner-btc-weekly');
    if (!migration) throw new Error('weekly migration missing from the runtime manifest');
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}`);
      await client.query("SET LOCAL TIME ZONE 'UTC'");
      // The real verifier targets public. Redirect only its namespace to this rolled-back schema.
      const catalogQuery: CatalogQuery = (text, values) => client.query(
        text.replaceAll("'public'", `'${schema}'`),
        values?.map(value => typeof value === 'string' ? value.replace(/^public\./, schema + '.') : value),
      );
      for (let boot = 0; boot < 2; boot++) {
        await client.query(sql);
        const readiness = await probeSchemaMigrationManifest(catalogQuery, [migration]);
        expect(readiness.unavailableCapabilities).toEqual([]);
        expect(readiness.evidence).toEqual([]);
      }
      const catalog = await client.query(`SELECT t.relname AS table_name, c.conname,
        pg_get_constraintdef(c.oid, true) AS definition FROM pg_constraint c
        JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
        WHERE n.nspname=$1 AND c.contype IN ('c', 'u', 'p')
        ORDER BY t.relname, c.conname`, [schema]);
      expect(catalog.rows).toHaveLength(9);
      console.info('PLANNER_196_CATALOG', JSON.stringify(catalog.rows));
      const insert = `INSERT INTO planner_btc_weekly_closes
        (market, week_start, close, source, basis, aggregation, finalized, fetched_at)
        VALUES ('BTC', $1, $2, $3, $4, 'native', $5, $6) ON CONFLICT (market, week_start) DO NOTHING`;
      const good = ['2026-10-05T00:00:00Z', '83769.300000000000000001', 'okx-index', 'index', true, '2026-10-12T00:15:00Z'];
      await client.query(insert, good); await client.query(insert, good);
      expect((await client.query('SELECT close FROM planner_btc_weekly_closes')).rows).toEqual([{ close: good[1] }]);
      for (const [index, value] of [[0, '2026-10-04T16:00:00Z'], [1, 'NaN'], [1, '0'], [3, 'perp'],
        [4, false], [5, '2026-10-11T23:59:59Z']] as const) {
        await client.query('SAVEPOINT invalid_week');
        const bad = [...good]; bad[index] = value;
        await expect(client.query(insert, bad)).rejects.toMatchObject({ code: '23514' });
        await client.query('ROLLBACK TO SAVEPOINT invalid_week');
        await client.query('RELEASE SAVEPOINT invalid_week');
      }
      await client.query("INSERT INTO planner_btc_weekly_refresh VALUES ('BTC', '2026-10-12T00:15:00Z')");
      expect((await client.query('SELECT count(*)::int AS count FROM planner_btc_weekly_refresh')).rows[0].count).toBe(1);
      await client.query('DELETE FROM planner_btc_weekly_closes');
      await client.query('DELETE FROM planner_btc_weekly_refresh');
      const query = (text: string, values?: unknown[]) => client.query(text, values);
      const store = new PostgresBtcWeeklyStore({ query, connect: async () => ({ query, release: () => {} }) });
      const now = Date.now(), cutoff = btcUtcWeekStart(now);
      const rows: BtcStoredWeek[] = Array.from({ length: 55 }, (_, i) => ({ market: 'BTC', weekStart: cutoff - (55 - i) * WEEK,
        close: i === 54 ? '200.000000000000000001' : '100', source: 'okx-index', basis: 'index', aggregation: 'native', finalized: true, fetchedAt: now }));
      let loads = 0;
      const load = async () => { loads++; return rows; };
      await store.refresh(now, load); await store.refresh(now, load);
      expect(loads).toBe(1);
      expect((await client.query('SELECT count(*)::int AS count FROM planner_btc_weekly_closes')).rows[0].count).toBe(55);
      const snapshot = await store.read(now);
      expect(snapshot.weeks).toHaveLength(50);
      expect(snapshot.weeks.at(-1)).toMatchObject({ market: 'BTC', close: '200.000000000000000001', finalized: true,
        source: 'okx-index', basis: 'index', weekStart: cutoff - WEEK });
      expect(snapshot.lastAttemptAt).toBe(now);
    } finally { await client.query('ROLLBACK').catch(() => {}); await client.end(); }
  }, 30_000);
});
