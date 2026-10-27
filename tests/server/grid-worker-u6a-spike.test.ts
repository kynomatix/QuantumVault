import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import { readFileSync } from 'node:fs';
import { gridWorkerIsolation } from '../helpers/grid-worker-isolation';
import { localContext } from '../../server/grid-worker/host';
import { hostFence, walletFences } from '../../server/grid-worker/transaction';
import {behaviourPolicy} from '../grid-bot/behaviour-fixtures';
import {computeGridPolicyHmac} from '../../server/grid-bot/policy-hmac';
import {prepareSendAudit,type SendAudit} from '../../server/grid-worker/audit';

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
  pool = new Pool({ connectionString, max: 2, options: '-c search_path=' + schema + ',public,pg_catalog' });
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

it('R1 FOR UPDATE blocks the committed protective audit; NO KEY UPDATE permits audit and still excludes another step',async()=>{
  const a=await pool!.connect(),b=await pool!.connect();
  const requestId=randomUUID(),operationId=randomUUID();
  const policy={...behaviourPolicy('repeat_all','long',false),id:randomUUID()};
  const key=randomBytes(32),signed=computeGridPolicyHmac(policy,key);key.fill(0);
  if(!signed.ok)throw Error('EXAMPLE_POLICY_INVALID');
  const fixtureDigest=createHash('sha256').update('EXAMPLE_U6A_R1').digest('hex');
  let audit:SendAudit;
  try{
    await a.query('BEGIN');await hostFence(a,'shared');
    const owner=(await a.query('SELECT owner_wallet FROM grid_worker_host')).rows[0].owner_wallet;
    await walletFences(a,[owner]);
    await a.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['qv:grid-worker:v3:bot:'+policy.id]);
    const {levels,sizingVersion,safetyEnvelopePrice,gridPolicyExtension,...base}=policy;
    const entries=Object.entries({...base,walletAddress:owner,clientRequestId:randomUUID(),serverIntentDigest:fixtureDigest.toUpperCase(),
      draftRevision:'EXAMPLE',createIntent:{},authoritySnapshot:{gridSizing:{sizingVersion,safetyEnvelopePrice},gridPolicyExtension},
      policyHmac:signed.digest,rangeSource:'manual',chartTimeframe:'15m'});
    await a.query(`INSERT INTO grid_bots(${entries.map(([k])=>k.replace(/[A-Z]/g,ch=>'_'+ch.toLowerCase())).join(',')})
      VALUES(${entries.map((_,i)=>'$'+(i+1)).join(',')})`,entries.map(([,v])=>v));
    await a.query(`INSERT INTO grid_worker_requests(id,owner_wallet,bot_id,action,request_key,draft_revision,server_intent_digest,
      policy_hmac,spending_policy_digest,wallet_generation,scope_revision,consent_version,consent_mac,issued_at,expires_at,state,admitted_at)
      VALUES($1::uuid,$2,$3,'protective_close',$1::uuid::text,'EXAMPLE',$4,'EXAMPLE',$4,0,1,'1','EXAMPLE',statement_timestamp(),
      statement_timestamp()+interval '10 minutes','admitted',statement_timestamp())`,[requestId,owner,policy.id,fixtureDigest]);
    audit={operationId,botId:policy.id,requestId,requestIdentity:'EXAMPLE',attempt:1,kind:'close',bootId:requestId,role:'protective',
      epoch:'2',generation:'0',policyDigest:fixtureDigest,requestDigest:fixtureDigest,signedAt:Date.now(),expiresAt:Date.now()+5000};
    await a.query(`INSERT INTO grid_operations(id,bot_id,idempotency_key,request_identity,type,state,submitted_at,exact_request_digest,exact_request)
      VALUES($1,$2,'EXAMPLE','EXAMPLE','close_position','submitted',clock_timestamp(),$3,$4::jsonb)`,
      [operationId,policy.id,fixtureDigest,JSON.stringify({timestamp:audit.signedAt,expiryMs:5000})]);
    await a.query('COMMIT');
    // This is the exact frozen-package FK, not a simulated lock table.
    const fk=(await a.query(`SELECT condeferrable,pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='grid_worker_send_audit'::regclass AND conname='grid_worker_audit_request_fk'`)).rows[0];
    expect(fk.condeferrable).toBe(false);expect(fk.definition).toContain('FOREIGN KEY (request_id)');
    await a.query('BEGIN');await hostFence(a,'shared');
    await a.query("SELECT id FROM grid_worker_requests WHERE id=$1 AND action='protective_close' FOR UPDATE NOWAIT",[requestId]);
    await b.query('BEGIN');await hostFence(b,'shared');await b.query("SET LOCAL lock_timeout='500ms'");
    await expect(prepareSendAudit(b,audit)).rejects.toMatchObject({code:'55P03',message:expect.stringContaining('PostgreSQL code=55P03 DETAIL=')});
    await b.query('ROLLBACK');await a.query('ROLLBACK');
    expect((await b.query('SELECT count(*)::integer AS n FROM grid_worker_send_audit WHERE request_id=$1',[requestId])).rows[0].n).toBe(0);
    // Candidate contract correction only: not installed in any production path.
    await a.query('BEGIN');await hostFence(a,'shared');
    await a.query("SELECT id FROM grid_worker_requests WHERE id=$1 AND action='protective_close' FOR NO KEY UPDATE NOWAIT",[requestId]);
    await b.query('BEGIN');await hostFence(b,'shared');await b.query("SET LOCAL lock_timeout='500ms'");
    await prepareSendAudit(b,audit);await b.query('COMMIT');
    expect((await b.query('SELECT sender_role,outcome FROM grid_worker_send_audit WHERE request_id=$1',[requestId])).rows[0])
      .toEqual({sender_role:'protective',outcome:'unknown'});
    await b.query('BEGIN');
    await expect(b.query('SELECT id FROM grid_worker_requests WHERE id=$1 FOR NO KEY UPDATE NOWAIT',[requestId])).rejects.toMatchObject({code:'55P03'});
    await b.query('ROLLBACK');await a.query('ROLLBACK');
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');a.release();b.release();}
},15000);
