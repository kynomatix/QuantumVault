import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import { readFileSync } from 'node:fs';
import { gridWorkerIsolation } from '../helpers/grid-worker-isolation';
import { localContext } from '../../server/grid-worker/host';
import { hostFence, walletFences } from '../../server/grid-worker/transaction';

const schema = 'grid_u6a_spike_' + randomUUID().replaceAll('-', '');
const isolate = gridWorkerIsolation();
let admin: Pool | undefined, pool: Pool | undefined;
function diagnostics(c: PoolClient) {
  c.query = new Proxy(c.query, { apply(fn, self, args) {
    const result = Reflect.apply(fn, self, args);
    if (result && typeof result.catch === 'function') return result.catch((e: Error & { code?: string; detail?: string; hint?: string }) => {
      e.message += ' [PostgreSQL code=' + String(e.code) + ' DETAIL=' + String(e.detail) + ' hint=' + String(e.hint) + ']';
      throw e;
    });
    return result;
  } });
}
beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || new URL(connectionString).pathname !== '/qvtest') throw Error('FRACTAL qvtest required');
  admin = new Pool({ connectionString, max: 1 });
  await admin.query('CREATE SCHEMA ' + schema);
  pool = new Pool({ connectionString, max: 1, options: '-c search_path=' + schema + ',public,pg_catalog' });
  pool.on('connect', c => { isolate(c); diagnostics(c); c.on('error', () => {}); });
  pool.on('error', () => {});
  for (const table of ['wallets', 'grid_bots', 'grid_operations', 'grid_control_requests', 'grid_control_keys', 'protocol_subaccounts', 'grid_launch_accounts', 'auth_nonces', 'grid_monitor_state']) {
    await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
  }
  await pool.query(readFileSync('migrations/grid_worker_v3_owner.sql', 'utf8').replaceAll('SET search_path = pg_catalog, public', 'SET search_path = pg_catalog, ' + schema));
}, 30000);
afterAll(async () => {
  await pool?.end();
  if (admin) { await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); await admin.end(); }
}, 30000);

it('the frozen transition context admits a protective takeover and fences the former holder', async () => {
  const c = await pool!.connect();
  const oldHolder = randomUUID(), requestId = randomUUID();
  const owner = bs58.encode(generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  const identitySha256 = createHash('sha256').update('EXAMPLE_U6A_SPIKE').digest('hex');
  try {
    await c.query('BEGIN');
    await hostFence(c, 'exclusive');
    await walletFences(c, [owner]);
    await c.query('INSERT INTO wallets(address) VALUES($1)', [owner]);
    await c.query('INSERT INTO grid_worker_owner(wallet_address) VALUES($1)', [owner]);
    await c.query("INSERT INTO grid_worker_host(protocol_version,owner_wallet) VALUES('grid-worker-v3-a1-wire1',$1)", [owner]);
    await c.query('INSERT INTO grid_worker_wallet_authority(wallet_address) VALUES($1)', [owner]);
    await localContext(c, 'bootstrap_tracking');
    await c.query('UPDATE grid_worker_host SET authority_tracking_enabled=true');
    await localContext(c, 'transition');
    await c.query("SELECT set_config('qv.grid_worker_owner_verified','true',true),set_config('qv.grid_worker_ready','true',true)");
    await c.query(`UPDATE grid_worker_host SET execution_mode='external',run_mode='trading',execution_enabled=true,
      legacy_controls_enabled=true,commit_hash=$1,tree_hash=$1,lockfile_sha256=$2`, [identitySha256.slice(0, 40), identitySha256]);
    await localContext(c, 'lease_acquire');
    await c.query("UPDATE grid_worker_host SET holder_boot_id=$1,holder_role='grid-worker',fencing_epoch=1,lease_expires_at=clock_timestamp()+interval '45 seconds'", [oldHolder]);
    await localContext(c, 'transition');
    const result = await c.query(`UPDATE grid_worker_host SET entries_paused=true,holder_role='protective',holder_boot_id=$1,
      fencing_epoch=fencing_epoch+1,lease_expires_at=clock_timestamp()+interval '45 seconds'
      RETURNING holder_boot_id,holder_role,fencing_epoch,lease_expires_at<=clock_timestamp()+interval '45 seconds' AS bounded`, [requestId]);
    expect(result.rows[0]).toEqual({ holder_boot_id: requestId, holder_role: 'protective', fencing_epoch: '2', bounded: true });
    await c.query('COMMIT');
    await c.query('BEGIN');
    await localContext(c, 'heartbeat', { bootId: oldHolder, epoch: '1' });
    await expect(c.query("UPDATE grid_worker_host SET lease_expires_at=clock_timestamp()+interval '45 seconds'")).rejects.toThrow('GRID_HEARTBEAT_CAS_REQUIRED');
    await c.query('ROLLBACK');
  } catch (error) { await c.query('ROLLBACK'); throw error; }
  finally { c.release(); }
});
