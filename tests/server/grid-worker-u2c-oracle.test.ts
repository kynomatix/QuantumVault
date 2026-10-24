import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { GRID_WORKER_CATALOG_CAPTURE_SQL, GRID_WORKER_CATALOG_SHA256 } from '../../server/grid-worker/schema';

// Independently measure the exact amended package on PostgreSQL.
const schema = 'grid_u2c_oracle_' + randomUUID().replaceAll('-', '');
const host = 'qv:grid-worker:v3:host:' + schema;
let admin: Pool, pool: Pool, objectHashes: Record<string, string>;
beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url || new URL(url).pathname !== '/qvtest') throw Error('FRACTAL qvtest required');
  admin = new Pool({ connectionString: url, max: 1 });
  await admin.query('CREATE SCHEMA ' + schema);
  pool = new Pool({ connectionString: url, max: 1, options: '-c search_path=' + schema + ',pg_catalog' });
  for (const table of ['wallets', 'grid_bots', 'grid_operations', 'grid_control_requests', 'protocol_subaccounts', 'grid_launch_accounts']) {
    await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
  }
  await pool.query(readFileSync('migrations/grid_worker_v3_owner.sql', 'utf8')
    .replaceAll('SET search_path = pg_catalog, public', 'SET search_path = pg_catalog, ' + schema)
    .replaceAll("'qv:grid-worker:v3:host'", "'" + host + "'"));
  const q = GRID_WORKER_CATALOG_CAPTURE_SQL.replace('p.prosrc', `replace(p.prosrc,'${host}','qv:grid-worker:v3:host')`);
  const capture = (await pool.query(q)).rows[0];
  objectHashes = { ...capture.objectHashes, catalogSha256: capture.catalogSha256 };
}, 30_000);
afterAll(async () => {
  await pool?.end();
  if (admin) { await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); await admin.end(); }
});
for (const name of ['function:grid_worker_validate_generation()', 'function:grid_worker_validate_owner_scope()',
  'trigger:grid_worker_wallet_authority.grid_worker_generation_validate', 'trigger:wallets.grid_worker_wallet_update',
  'trigger:protocol_subaccounts.grid_worker_protocol_subaccounts_update', 'catalogSha256']) {
  it('catalog sha256 ' + name, () => {
    expect(objectHashes[name]).toMatch(/^[0-9a-f]{64}$/);
    if(name==='catalogSha256')expect(objectHashes[name]).toBe(GRID_WORKER_CATALOG_SHA256);
  });
}
