import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

describe.skipIf(!process.env.DATABASE_URL)('Signal Lab provenance DDL on isolated PostgreSQL temp tables', () => {
  it('is idempotent, defaults existing bots, enforces the CHECK/FKs, and retains snapshots after source deletion', async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('CREATE TEMP TABLE lab_strategies(id integer PRIMARY KEY); CREATE TEMP TABLE lab_optimization_runs(id integer PRIMARY KEY); CREATE TEMP TABLE lab_optimization_results(id integer PRIMARY KEY); CREATE TEMP TABLE trading_bots(id text PRIMARY KEY, name text NOT NULL)');
      await client.query("INSERT INTO trading_bots VALUES ('EXAMPLE','EXAMPLE'); INSERT INTO lab_strategies VALUES (1); INSERT INTO lab_optimization_runs VALUES (2); INSERT INTO lab_optimization_results VALUES (3)");
      const ddl = readFileSync('migrations/0010_lab_signal_provenance.sql', 'utf8');
      await client.query(ddl); await client.query(ddl);
      expect((await client.query("SELECT * FROM pg_temp.trading_bots WHERE id='EXAMPLE'")).rows[0]).toMatchObject({ name: 'EXAMPLE', lab_link_state: 'unlinked', lab_deploy_snapshot: null, lab_strategy_id: null, lab_run_id: null, lab_result_id: null });
      await client.query('SAVEPOINT invalid_state');
      await expect(client.query("UPDATE pg_temp.trading_bots SET lab_link_state='EXAMPLE'")).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT invalid_state');
      await client.query('SAVEPOINT invalid_source');
      await expect(client.query('UPDATE pg_temp.trading_bots SET lab_result_id=99')).rejects.toMatchObject({ code: '23503' });
      await client.query('ROLLBACK TO SAVEPOINT invalid_source');
      await client.query("UPDATE pg_temp.trading_bots SET lab_strategy_id=1,lab_run_id=2,lab_result_id=3,lab_link_state='linked',lab_deploy_snapshot=$1::jsonb,lab_linked_at=now()", [JSON.stringify({ evidence: 'EXAMPLE' })]);
      await client.query('DELETE FROM pg_temp.lab_strategies; DELETE FROM pg_temp.lab_optimization_runs; DELETE FROM pg_temp.lab_optimization_results');
      expect((await client.query('SELECT * FROM pg_temp.trading_bots')).rows[0]).toMatchObject({ lab_strategy_id: null, lab_run_id: null, lab_result_id: null, lab_link_state: 'linked', lab_deploy_snapshot: { evidence: 'EXAMPLE' } });
      const columns = (await client.query("SELECT attname,format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid='pg_temp.trading_bots'::regclass AND attname LIKE 'lab_%'")).rows;
      expect(columns.find(c => c.attname === 'lab_linked_at')?.type).toBe('timestamp with time zone');
      expect(columns.find(c => c.attname === 'lab_deploy_snapshot')?.type).toBe('jsonb');
    } finally { await client.query('ROLLBACK'); await client.end(); }
  }, 15_000);
});
