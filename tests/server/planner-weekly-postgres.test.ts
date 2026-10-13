import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PostgresBtcWeeklyStore } from '../../server/grid-planner/weekly-store';
import { btcUtcWeekStart, BTC_TREND_WEEK_MS as WEEK, type BtcStoredWeek } from '../../shared/grid-direction';
import { probeSchemaMigrationManifest, type CatalogQuery } from '../../server/schema-readiness';
import { readDbSchemaMigrationManifest } from '../helpers/schema-migration-manifest';

// The desktop runner owns the database URL. Everything rolls back in a private schema.
describe.skipIf(!process.env.DATABASE_URL)('BTC weekly migration on PostgreSQL', () => {
  it('upgrades 196, boots twice without replacing the corrected CHECK, renders every planner CHECK single-line, and enforces weekly storage', async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000,
      query_timeout: 5000, statement_timeout: 5000 });
    const schema = 'weekly_test_' + randomUUID().replaceAll('-', '');
    const migrations = readDbSchemaMigrationManifest().manifest.filter(entry =>
      entry.id === '196-planner-btc-weekly' || entry.id === '197-planner-btc-weekly-close-check');
    if (migrations.length !== 2) throw new Error('weekly migrations missing from the runtime manifest');
    const sql = migrations.map(migration => migration.sql
      .replaceAll('public.planner_btc_weekly_', schema + '.planner_btc_weekly_'));
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
      let correctedOid: number | undefined;
      for (let boot = 0; boot < 2; boot++) {
        await client.query(sql[0]);
        if (boot === 0) {
          const old = await client.query(`SELECT pg_get_constraintdef(oid, true) AS definition
            FROM pg_constraint WHERE conrelid=$1::regclass AND conname='planner_btc_weekly_close_check'`,
          [schema + '.planner_btc_weekly_closes']);
          expect(old.rows[0].definition).toMatch(/[\r\n]/);
          expect((await probeSchemaMigrationManifest(catalogQuery, migrations)).unavailableCapabilities).toEqual(['grid_bot']);
        }
        await client.query(sql[1]);
        const readiness = await probeSchemaMigrationManifest(catalogQuery, migrations);
        expect(readiness.unavailableCapabilities).toEqual([]);
        expect(readiness.evidence).toEqual([]);
        const checks = await client.query(`SELECT c.oid, c.conname,
          pg_get_constraintdef(c.oid) AS definition, pg_get_constraintdef(c.oid, true) AS pretty_definition
          FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
          JOIN pg_namespace n ON n.oid=t.relnamespace
          WHERE n.nspname=$1 AND t.relname IN ('planner_btc_weekly_closes', 'planner_btc_weekly_refresh')
            AND c.contype='c' ORDER BY c.conname`, [schema]);
        expect(checks.rows).toHaveLength(7);
        for (const check of checks.rows) {
          expect(check.definition, check.conname).not.toMatch(/[\r\n]/);
          expect(check.pretty_definition, check.conname).not.toMatch(/[\r\n]/);
        }
        const close = checks.rows.find(check => check.conname === 'planner_btc_weekly_close_check')!;
        const canonical = migrations[1].sql.match(/\$constraint\$(.*?)\$constraint\$/)?.[1];
        expect(close.pretty_definition).toBe(canonical);
        if (correctedOid !== undefined) expect(close.oid).toBe(correctedOid);
        correctedOid = close.oid;
      }
      const catalog = await client.query(`SELECT t.relname AS table_name, c.conname,
        pg_get_constraintdef(c.oid, true) AS definition FROM pg_constraint c
        JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
        WHERE n.nspname=$1 AND c.contype IN ('c', 'u', 'p')
        ORDER BY t.relname, c.conname`, [schema]);
      expect(catalog.rows).toHaveLength(9);
      console.info('PLANNER_197_SINGLE_LINE', JSON.stringify({ checks: 7, renderings: 14, multiline: 0, boots: 2 }));
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
      // Repair a differing definition and a missing CHECK, then prove the fast no-op again.
      for (const replacement of ['ADD CONSTRAINT planner_btc_weekly_close_check CHECK (true)', '']) {
        await client.query('ALTER TABLE planner_btc_weekly_closes DROP CONSTRAINT planner_btc_weekly_close_check');
        if (replacement) await client.query('ALTER TABLE planner_btc_weekly_closes ' + replacement);
        await client.query(sql[1]);
        expect((await probeSchemaMigrationManifest(catalogQuery, migrations)).evidence).toEqual([]);
        const before = await client.query(`SELECT oid FROM pg_constraint
          WHERE conrelid=$1::regclass AND conname='planner_btc_weekly_close_check'`, [schema + '.planner_btc_weekly_closes']);
        await client.query(sql[1]);
        const after = await client.query(`SELECT oid FROM pg_constraint
          WHERE conrelid=$1::regclass AND conname='planner_btc_weekly_close_check'`, [schema + '.planner_btc_weekly_closes']);
        expect(after.rows).toEqual(before.rows);
      }
    } finally { await client.query('ROLLBACK').catch(() => {}); await client.end(); }
  }, 30_000);

  it('proves regex-only positivity is equivalent to the original CASE/numeric CHECK in PostgreSQL', async () => {
    const { manifest } = readDbSchemaMigrationManifest();
    const original = manifest[196].sql.match(/CONSTRAINT planner_btc_weekly_close_check CHECK\((.*?)\),/)?.[1];
    const repaired = manifest[197].sql.match(/ADD CONSTRAINT planner_btc_weekly_close_check\s+CHECK \((.*?)\);/)?.[1];
    if (!original || !repaired) throw new Error('close predicates missing from runtime migrations');
    const cases = new Map<string, boolean>();
    // Every allowed zero width, every integer digit position and every fractional digit position.
    for (let integerWidth = 1; integerWidth <= 12; integerWidth++) {
      const zero = '0'.repeat(integerWidth);
      cases.set(zero, false);
      for (let position = 0; position < integerWidth; position++) {
        for (let digit = 1; digit <= 9; digit++) {
          cases.set(zero.slice(0, position) + digit + zero.slice(position + 1), true);
        }
      }
      for (let fractionWidth = 1; fractionWidth <= 18; fractionWidth++) {
        const fraction = '0'.repeat(fractionWidth);
        cases.set(zero + '.' + fraction, false);
        cases.set('9'.repeat(integerWidth) + '.' + '9'.repeat(fractionWidth), true);
        for (let position = 0; position < fractionWidth; position++) {
          cases.set(zero + '.' + fraction.slice(0, position) + '1' + fraction.slice(position + 1), true);
        }
      }
    }
    for (const value of ['', '0.', '.1', '-1', '+1', '1e1', 'NaN', 'Infinity', ' 1', '1 ', '1\n', '\n1',
      '1\r', '1\t', '1.2.3', '1,000', '0x1', '١', '１', '1000000000000', '0.0000000000000000001']) {
      cases.set(value, false);
    }
    const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000,
      query_timeout: 5000, statement_timeout: 5000 });
    await client.connect();
    try {
      const result = await client.query(`SELECT close, expected, (${original}) AS old_accepts, (${repaired}) AS new_accepts
        FROM unnest($1::text[], $2::boolean[]) AS samples(close, expected)
        WHERE (${original}) IS DISTINCT FROM (${repaired}) OR (${repaired}) IS DISTINCT FROM expected`,
      [[...cases.keys()], [...cases.values()]]);
      expect(result.rows).toEqual([]);
      console.info('PLANNER_197_EQUIVALENCE', JSON.stringify({ cases: cases.size, mismatches: result.rowCount }));
    } finally { await client.end(); }
  }, 30_000);
});
