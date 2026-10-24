import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import bs58 from 'bs58';
import { readFileSync } from 'node:fs';
import { GRID_WORKER_CATALOG_CAPTURE_SQL, GRID_WORKER_CATALOG_CHECK_SQL, GRID_WORKER_CATALOG_SHA256 } from '../../server/grid-worker/schema';
import { probeGridWorkerData } from '../../server/grid-worker/data-readiness';
import { behaviourPolicy } from '../grid-bot/behaviour-fixtures';
import { computeGridPolicyHmac } from '../../server/grid-bot/policy-hmac';
import { umk } from '../grid-bot/draft-fixtures';
import { U2A_CONSOLE_TEMPLATES } from '../helpers/grid-worker-u2a-console-templates';
import { OWNER_RECEIPT_VECTORS } from '../helpers/grid-worker-owner-receipt-vectors';

describe('U2a PostgreSQL package', () => {
  let admin: Pool, fixturePool: Pool, db: PoolClient;
  const schema = 'grid_u2a_' + randomUUID().replaceAll('-', '');
  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url || new URL(url).pathname !== '/qvtest') throw Error('FRACTAL qvtest required');
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query('CREATE SCHEMA ' + schema);
    fixturePool = new Pool({ connectionString: url, max: 1, options: '-c search_path=' + schema + ',pg_catalog' });
    db = await fixturePool.connect();
    // Clone only schema, retaining real column ordinals for exact trigger attributes.
    for (const table of ['wallets', 'grid_bots', 'grid_operations', 'grid_control_requests', 'protocol_subaccounts', 'grid_launch_accounts']) {
      await db.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    const sql = readFileSync('migrations/grid_worker_v3_owner.sql', 'utf8')
      .replaceAll('SET search_path = pg_catalog, public', 'SET search_path = pg_catalog, ' + schema);
    await db.query(sql);
  }, 30_000);
  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK'); });
  afterAll(async () => {
    await db?.query('ROLLBACK');
    db?.release();
    await fixturePool?.end();
    if (admin) {
      await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
      await admin.end();
    }
  });
  it('CatalogCapture', async () => {
    const capture = (await db.query(GRID_WORKER_CATALOG_CAPTURE_SQL)).rows[0];
    // First bootstrap run reports the measured oracle for independent reconciliation.
    expect(capture.catalogSha256, JSON.stringify(capture)).toBe(GRID_WORKER_CATALOG_SHA256);
  });
  const query = (text: string, values?: readonly unknown[]) => db.query(text, values ? [...values] : undefined);
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const fence = (shared = false) => db.query(`SELECT pg_advisory_xact_lock${shared ? '_shared' : ''}(hashtextextended('qv:grid-worker:v3:host',0))`);
  const walletLock = (wallet = 'EXAMPLE') => db.query('SELECT pg_advisory_xact_lock(927412,hashtext($1))', [wallet]);
  const identityLock = (kind: 'bot' | 'pool', id: string | number) => db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['qv:grid-worker:v3:' + kind + ':' + id]);
  async function context(action: string) { await db.query("SELECT set_config('qv.grid_worker_action',$1,true)", [action]); }
  async function seed() {
    await fence();
    await db.query("INSERT INTO wallets(address) VALUES('EXAMPLE'),('EXAMPLE_OTHER')");
    await db.query("INSERT INTO grid_worker_owner(wallet_address) VALUES('EXAMPLE')");
    await db.query("INSERT INTO grid_worker_host(protocol_version,owner_wallet) VALUES('grid-worker-v3-a1-wire1','EXAMPLE')");
  }
  async function arm() {
    for (const wallet of ['EXAMPLE', 'EXAMPLE_OTHER']) {
      await walletLock(wallet);
      await db.query('INSERT INTO grid_worker_wallet_authority(wallet_address) VALUES($1)', [wallet]);
    }
    await context('bootstrap_tracking');
    await db.query('UPDATE grid_worker_host SET authority_tracking_enabled=true');
  }
  async function refused(sql: string, values: unknown[] = [], code?: string) {
    await db.query('SAVEPOINT negative');
    if (code) await expect(db.query(sql, values)).rejects.toThrow(code);
    else await expect(db.query(sql, values)).rejects.toThrow();
    await db.query('ROLLBACK TO SAVEPOINT negative');
  }
  async function bot(wallet = 'EXAMPLE') {
    const policy = { ...behaviourPolicy('repeat_all', 'long', false), id: randomUUID() };
    const signed = computeGridPolicyHmac(policy, umk());
    if (!signed.ok) throw Error('EXAMPLE policy invalid');
    const { levels, sizingVersion, safetyEnvelopePrice, gridPolicyExtension, ...base } = policy;
    const record = { ...base, walletAddress: wallet, clientRequestId: randomUUID(), serverIntentDigest: digest('EXAMPLE').toUpperCase(), draftRevision: 'EXAMPLE', createIntent: {}, authoritySnapshot: { gridSizing: { sizingVersion, safetyEnvelopePrice }, gridPolicyExtension }, policyHmac: signed.digest, rangeSource: 'manual', chartTimeframe: '15m' };
    const entries = Object.entries(record);
    await db.query(`INSERT INTO grid_bots(${entries.map(([key]) => key.replace(/[A-Z]/g, c => '_' + c.toLowerCase())).join(',')}) VALUES(${entries.map((_, i) => '$' + (i + 1)).join(',')})`, entries.map(([, value]) => value));
    return policy.id;
  }
  async function request(botId: string, wallet = 'EXAMPLE') {
    const id = randomUUID();
    await db.query(`INSERT INTO grid_worker_requests(id,owner_wallet,bot_id,action,request_key,draft_revision,server_intent_digest,policy_hmac,spending_policy_digest,wallet_generation,scope_revision,consent_version,consent_mac,issued_at,expires_at)
      VALUES($1::uuid,$2,$3,'start',$1::uuid::text,'EXAMPLE',$4,'EXAMPLE',$4,0,1,'EXAMPLE','EXAMPLE',clock_timestamp(),clock_timestamp()+interval '60 seconds')`, [id, wallet, botId, digest('EXAMPLE')]);
    return id;
  }
  async function receipt(action = 'pause', target = 'all', paramsDigest = 'none') {
    const id = randomUUID(), nonce = bs58.encode(randomBytes(32));
    const now = (await db.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")).rows[0].at as Date;
    const expires = new Date(now.getTime() + 120_000);
    const message = `QV-OWNER-ACTION v1\naction:${action}\nscope:grid_worker\ntarget:${target}\nnonce:${nonce}\nissued:${now.toISOString()}\nexpires:${expires.toISOString()}\nparams:${paramsDigest}`;
    await db.query(`INSERT INTO owner_action_receipts(receipt_id,owner_wallet,action,scope,target,nonce,message_digest,params_digest,issued_at,expires_at)
      VALUES($1,'EXAMPLE',$2,'grid_worker',$3,$4,$5,$6,$7,$8)`, [id, action, target, nonce, digest(message), paramsDigest, now, expires]);
    return id;
  }
  const pause = 'SELECT grid_worker_pause_from_verified_receipt($1::uuid)';

  it('commits deterministic message, digest and signature vectors for all actions', () => {
    expect(OWNER_RECEIPT_VECTORS).toHaveLength(5);
    for (const vector of OWNER_RECEIPT_VECTORS) {
      expect(Buffer.from(vector.messageBytes).toString('utf8')).toBe(vector.message);
      expect(digest(vector.message)).toBe(vector.messageDigest);
      expect(bs58.decode(vector.signature)).toHaveLength(64);
      expect(vector.message.split('\n')).toHaveLength(8);
    }
  });
  it('receipt consumption requires prelocks and an existing receipt', async () => {
    await refused(pause, [randomUUID()], 'GRID_HOST_EXCLUSIVE_REQUIRED');
    await seed(); await refused(pause, [randomUUID()], 'GRID_RECEIPT_MISSING');
  });

  it('accepts legacy, worker and protective send attribution and rejects an unknown sender role', async () => {
    await seed();
    const botId = await bot(), operationId = randomUUID();
    await db.query(`INSERT INTO grid_operations(id,bot_id,idempotency_key,request_identity,type)
      VALUES($1,$2,'EXAMPLE','EXAMPLE','place_level_order')`, [operationId, botId]);
    const insert = `INSERT INTO grid_worker_send_audit(id,operation_id,bot_id,request_identity,attempt,kind,
      holder_boot_id,sender_role,fencing_epoch,wallet_generation,policy_digest,request_digest,
      signed_at,signed_expires_at,prepared_at)
      VALUES($1,$2,$3,'EXAMPLE',$4,'limit',$5,$6,0,0,$7,$7,
        transaction_timestamp(),transaction_timestamp()+interval '10 seconds',transaction_timestamp())
      RETURNING sender_role`;
    let attempt = 1;
    for (const role of ['legacy', 'grid-worker', 'protective']) {
      const row = await db.query(insert, [randomUUID(), operationId, botId, attempt++, randomUUID(), role, digest('EXAMPLE')]);
      expect(row.rows[0].sender_role).toBe(role);
    }
    await db.query('SAVEPOINT invalid_role');
    await expect(db.query(insert, [randomUUID(), operationId, botId, attempt, randomUUID(), 'EXAMPLE_UNKNOWN', digest('EXAMPLE')]))
      .rejects.toMatchObject({ code: '23514', constraint: 'grid_worker_audit_kind' });
    await db.query('ROLLBACK TO SAVEPOINT invalid_role');
    expect((await db.query('SELECT count(*)::integer AS count FROM grid_worker_send_audit')).rows[0].count).toBe(3);
  });

  it('all catalog attributes match the captured package', async () => {
    expect((await db.query(GRID_WORKER_CATALOG_CHECK_SQL)).rows[0].ok).toBe(true);
    expect((await probeGridWorkerData(query)).stage).toBe('unseeded');
  });
  function fixtureSql(path: string) {
    return readFileSync(path, 'utf8').replaceAll('SET search_path = pg_catalog, public', 'SET search_path = pg_catalog, ' + schema).replace(/^BEGIN;\r?\n/m, '').replace(/^COMMIT;\r?\n/m, '');
  }
  it('complete package repeats exactly and refuses partial prior shape', async () => {
    await db.query(fixtureSql('migrations/grid_worker_v3_owner.sql'));
    await db.query('ALTER TABLE grid_worker_owner ADD COLUMN extra text');
    await refused(fixtureSql('migrations/grid_worker_v3_owner.sql'), [], 'GRID_PACKAGE_PRIOR_SHAPE');
  });
  it('fallback recreates omitted functions and triggers with exact equality', async () => {
    const functions = (await db.query("SELECT p.oid::regprocedure::text AS name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=current_schema() AND p.proname LIKE 'grid_worker_%'")).rows;
    for (const fn of functions) await db.query('DROP FUNCTION ' + fn.name + ' CASCADE');
    expect((await db.query(GRID_WORKER_CATALOG_CHECK_SQL)).rows[0].ok).toBe(false);
    const fallback = fixtureSql('migrations/grid_worker_v3_fallback.sql');
    await db.query(fallback);
    expect((await db.query(GRID_WORKER_CATALOG_CHECK_SQL)).rows[0].ok).toBe(true);
    await db.query(fallback);
    expect((await db.query(GRID_WORKER_CATALOG_CHECK_SQL)).rows[0].ok).toBe(true);
  });
  it('fallback refuses divergent bodies and extra overloads without replacing them', async () => {
    await db.query('SAVEPOINT divergence');
    await db.query('ALTER FUNCTION grid_worker_has_wallet_lock(text) SECURITY DEFINER');
    await refused(fixtureSql('migrations/grid_worker_v3_fallback.sql'), [], 'GRID_FUNCTION_DIVERGENT');
    await db.query('ROLLBACK TO SAVEPOINT divergence');
    await db.query('CREATE FUNCTION grid_worker_has_wallet_lock() RETURNS boolean LANGUAGE sql AS $$SELECT true$$');
    await refused(fixtureSql('migrations/grid_worker_v3_fallback.sql'), [], 'GRID_PACKAGE_CATALOG_DIVERGENT');
  });
  for (const [name, mutation] of Object.entries({
    ExtraColumn: 'ALTER TABLE grid_worker_owner ADD COLUMN extra text',
    MissingColumn: 'ALTER TABLE grid_worker_reconciliation DROP COLUMN cursor',
    ExtraCheck: 'ALTER TABLE grid_worker_owner ADD CONSTRAINT extra CHECK (singleton_id>0)',
    ChangedCheck: 'ALTER TABLE grid_worker_owner DROP CONSTRAINT grid_worker_owner_singleton; ALTER TABLE grid_worker_owner ADD CONSTRAINT grid_worker_owner_singleton CHECK (singleton_id IN (1,2))',
    ForeignKeyAction: 'ALTER TABLE grid_worker_owner DROP CONSTRAINT grid_worker_owner_wallet_fk; ALTER TABLE grid_worker_owner ADD CONSTRAINT grid_worker_owner_wallet_fk FOREIGN KEY(wallet_address) REFERENCES wallets(address) ON DELETE CASCADE',
    Predicate: "DROP INDEX owner_receipt_pending; CREATE INDEX owner_receipt_pending ON owner_action_receipts(action,target) WHERE consumed_at IS NOT NULL",
    DisabledTrigger: 'ALTER TABLE wallets DISABLE TRIGGER grid_worker_wallet_update',
    ExtraTrigger: 'CREATE TRIGGER extra BEFORE INSERT ON grid_worker_owner FOR EACH ROW EXECUTE FUNCTION grid_worker_validate_generation()',
    FunctionBody: "CREATE OR REPLACE FUNCTION grid_worker_has_wallet_lock(wallet text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog, public AS $$BEGIN RETURN true; END$$",
  })) it('catalog rejects ' + name, async () => {
    await db.query(mutation);
    expect((await db.query(GRID_WORKER_CATALOG_CHECK_SQL)).rows[0].ok).toBe(false);
  });
  it('host and wallet lock predicates recognize only this session locks', async () => {
    expect((await db.query("SELECT grid_worker_has_host_lock(false) AS host,grid_worker_has_wallet_lock('EXAMPLE') AS wallet")).rows[0]).toEqual({ host: false, wallet: false });
    await fence(true);
    expect((await db.query('SELECT grid_worker_has_host_lock(false) AS shared,grid_worker_has_host_lock(true) AS exclusive')).rows[0]).toEqual({ shared: true, exclusive: false });
    await walletLock();
    expect((await db.query("SELECT grid_worker_has_wallet_lock('EXAMPLE') AS ok")).rows[0].ok).toBe(true);
  });
  it('host insert requires exclusive prelock and safe defaults', async () => {
    await db.query("INSERT INTO wallets(address) VALUES('EXAMPLE'); INSERT INTO grid_worker_owner(wallet_address) VALUES('EXAMPLE')");
    await refused("INSERT INTO grid_worker_host(protocol_version,owner_wallet) VALUES('grid-worker-v3-a1-wire1','EXAMPLE')", [], 'GRID_HOST_BOOTSTRAP_INVALID');
    await fence();
    await refused("INSERT INTO grid_worker_host(protocol_version,owner_wallet,execution_enabled) VALUES('grid-worker-v3-a1-wire1','EXAMPLE',true)", [], 'GRID_HOST_BOOTSTRAP_INVALID');
  });
  it('host direct update without a prelock is refused', async () => {
    await seed(); await db.query('COMMIT; BEGIN');
    try { await refused('UPDATE grid_worker_host SET drain_requested=true', [], 'GRID_HOST_PRELOCK_REQUIRED'); }
    finally {
      await db.query('ROLLBACK; BEGIN');
      await db.query('DELETE FROM grid_worker_host; DELETE FROM grid_worker_owner; DELETE FROM wallets');
      await db.query('COMMIT; BEGIN');
    }
  });
  it('host tightening uses shared fence; loosening requires exclusive owner context', async () => {
    await seed();
    await context('tighten');
    await db.query('UPDATE grid_worker_host SET drain_requested=true');
    await refused('UPDATE grid_worker_host SET drain_requested=false', [], 'GRID_TIGHTEN_ONLY');
    await context('transition');
    await refused('UPDATE grid_worker_host SET drain_requested=false', [], 'GRID_OWNER_TRANSITION_REQUIRED');
  });
  it('epoch and generation cannot decrease and tracking cannot be cleared', async () => {
    await seed(); await arm();
    await refused('UPDATE grid_worker_host SET authority_tracking_enabled=false', [], 'GRID_HOST_MONOTONIC');
    await db.query("UPDATE grid_worker_wallet_authority SET generation=2 WHERE wallet_address='EXAMPLE'");
    await refused("UPDATE grid_worker_wallet_authority SET generation=1 WHERE wallet_address='EXAMPLE'", [], 'GRID_GENERATION_MONOTONIC');
    await refused('UPDATE grid_worker_host SET fencing_epoch=-1', [], 'GRID_HOST_MONOTONIC');
  });
  for (const seeded of [false, true]) for (const [name, change] of Object.entries({
    grant: "execution_enabled=true,umk_encrypted_for_execution='EXAMPLE',execution_expires_at=timestamp '2099-01-01'",
    revoke: 'execution_enabled=false,umk_encrypted_for_execution=NULL,execution_expires_at=NULL',
    emergencyStop: 'emergency_stop_triggered=true,execution_enabled=false',
    resync: "agent_public_key='EXAMPLE_AGENT'",
    reset: "agent_public_key='EXAMPLE_RESET',agent_private_key_encrypted_v3='EXAMPLE',umk_version=3",
    preferences: "display_name='EXAMPLE',notifications_enabled=true",
  })) it(`dormant wallet ${name} with ${seeded ? 'seeded' : 'absent'} host`, async () => {
    if (seeded) await seed(); else await db.query("INSERT INTO wallets(address) VALUES('EXAMPLE')");
    const before = (await db.query("SELECT count(*)::integer AS n FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'")).rows[0].n;
    await db.query('UPDATE wallets SET ' + change + " WHERE address='EXAMPLE'");
    expect((await db.query('SELECT count(*)::integer AS n FROM grid_worker_wallet_authority')).rows[0].n).toBe(0);
    expect((await db.query("SELECT count(*)::integer AS n FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'")).rows[0].n).toBe(before);
  });
  it('armed wallet changes bump once, no-op updates do not, and new wallets get zero', async () => {
    await seed(); await arm();
    await db.query("UPDATE wallets SET execution_enabled=true,umk_encrypted_for_execution='EXAMPLE' WHERE address='EXAMPLE'");
    await db.query("UPDATE wallets SET execution_enabled=execution_enabled WHERE address='EXAMPLE'");
    expect((await db.query("SELECT generation FROM grid_worker_wallet_authority WHERE wallet_address='EXAMPLE'")).rows[0].generation).toBe('1');
    await refused("INSERT INTO wallets(address) VALUES('EXAMPLE_NEW')", [], 'GRID_WALLET_PRELOCK_REQUIRED');
    await walletLock('EXAMPLE_NEW');
    await db.query("INSERT INTO wallets(address) VALUES('EXAMPLE_NEW')");
    expect((await db.query("SELECT generation FROM grid_worker_wallet_authority WHERE wallet_address='EXAMPLE_NEW'")).rows[0].generation).toBe('0');
  });
  it('authority revocation supersedes pending work atomically', async () => {
    await seed(); const id = await bot(); const requestId = await request(id); await arm();
    await identityLock('bot', id);
    await db.query("UPDATE wallets SET emergency_stop_triggered=true WHERE address='EXAMPLE'");
    expect((await db.query('SELECT state FROM grid_worker_requests WHERE id=$1', [requestId])).rows[0].state).toBe('superseded');
  });
  it('armed cross-owner bot/request validators refuse mismatches', async () => {
    await seed(); const id = await bot(); await arm();
    await refused("UPDATE grid_bots SET wallet_address='EXAMPLE_OTHER' WHERE id=$1", [id], 'GRID_BOT_OWNER_IMMUTABLE');
    await db.query('SAVEPOINT request_owner');
    await expect(request(id, 'EXAMPLE_OTHER')).rejects.toThrow('GRID_REQUEST_OWNER_MISMATCH');
    await db.query('ROLLBACK TO SAVEPOINT request_owner');
  });
  it('armed requests and reservations require bot prelocks and matching bindings', async () => {
    await seed(); const id = await bot(); await arm();
    await db.query('SAVEPOINT missing_bot_lock');
    await expect(request(id)).rejects.toThrow('GRID_IDENTITY_PRELOCK_REQUIRED');
    await db.query('ROLLBACK TO SAVEPOINT missing_bot_lock');
    await identityLock('bot', id);
    const requestId = await request(id);
    const sql = `INSERT INTO grid_worker_reservations(bot_id,start_request_id,owner_wallet,wallet_generation,policy_digest,scope_revision,investment_usd,leverage,budget_notional_usd,observed_exposure_usd,reserve_usd,cash_commitment_usd,fee_reserve_usd,facts_at) VALUES($1,$2,'EXAMPLE',0,$3,1,10,1,10,0,10,10,0,clock_timestamp())`;
    await refused(sql, [id, randomUUID(), digest('EXAMPLE')], 'GRID_RESERVATION_REQUEST_MISMATCH');
    await db.query(sql, [id, requestId, digest('EXAMPLE')]);
  });
  for (const seeded of [false, true]) it('dormant pool and launch validators preserve baseline with ' + (seeded ? 'seeded' : 'absent') + ' host', async () => {
    if (seeded) await seed(); else await db.query("INSERT INTO wallets(address) VALUES('EXAMPLE'),('EXAMPLE_OTHER')");
    const id = await bot();
    await db.query("INSERT INTO protocol_subaccounts(id,wallet_address,protocol,status,agent_public_key) VALUES(123,'EXAMPLE_OTHER','pacifica','spare','EXAMPLE_AGENT')");
    // Deliberate mismatch reaches only the new inert trigger; existing fixture constraints still apply.
    await db.query("INSERT INTO grid_launch_accounts(bot_id,protocol_subaccount_id,master_account,account,canary_limit) VALUES($1,123,'EXAMPLE_UNRELATED','EXAMPLE_ACCOUNT',1)", [id]);
    await db.query("UPDATE grid_launch_accounts SET master_account='EXAMPLE_CHANGED' WHERE bot_id=$1", [id]);
    await db.query("UPDATE protocol_subaccounts SET wallet_address='EXAMPLE',agent_public_key='EXAMPLE_CHANGED' WHERE id=123");
    expect((await db.query('SELECT count(*)::integer AS n FROM grid_worker_wallet_authority')).rows[0].n).toBe(0);
    expect(id).toBeTruthy();
  });
  it('armed pool and launch validators require matching ownership and prelocked identities', async () => {
    await seed(); const id = await bot();
    await db.query("UPDATE wallets SET agent_public_key='EXAMPLE_AGENT' WHERE address='EXAMPLE'");
    await db.query("INSERT INTO protocol_subaccounts(id,wallet_address,protocol,status,agent_public_key) VALUES(123,'EXAMPLE','pacifica','spare','EXAMPLE_AGENT')");
    await arm();
    const sql = "INSERT INTO grid_launch_accounts(bot_id,protocol_subaccount_id,master_account,account,canary_limit) VALUES($1,123,$2,'EXAMPLE_ACCOUNT',1)";
    await refused(sql, [id, 'EXAMPLE_OTHER'], 'GRID_LAUNCH_OWNER_MISMATCH');
    await refused(sql, [id, 'EXAMPLE_AGENT'], 'GRID_IDENTITY_PRELOCK_REQUIRED');
    await identityLock('bot', id); await identityLock('pool', 123);
    await db.query(sql, [id, 'EXAMPLE_AGENT']);
    await refused("UPDATE protocol_subaccounts SET wallet_address='EXAMPLE_OTHER' WHERE id=123", [], 'GRID_POOL_OWNER_MISMATCH');
    await refused("UPDATE grid_launch_accounts SET master_account='EXAMPLE_OTHER'", [], 'GRID_LAUNCH_OWNER_MISMATCH');
  });
  it('host holder CAS, observer clear and pause acknowledgement preserve epoch and scope rules', async () => {
    await seed(); await context('transition');
    await db.query("SET LOCAL qv.grid_worker_ready='true'; SET LOCAL qv.grid_worker_owner_verified='true'");
    const holder = randomUUID();
    await db.query("UPDATE grid_worker_host SET holder_boot_id=$1,holder_role='grid-worker',fencing_epoch=1,lease_expires_at=clock_timestamp()+interval '60 seconds'", [holder]);
    await context('heartbeat');
    await refused('UPDATE grid_worker_host SET heartbeat_at=clock_timestamp()', [], 'GRID_HEARTBEAT_CAS_REQUIRED');
    await db.query("SELECT set_config('qv.grid_worker_holder',$1,true),set_config('qv.grid_worker_epoch','1',true)", [holder]);
    await db.query('UPDATE grid_worker_host SET heartbeat_at=clock_timestamp(),last_healthz_poll_at=clock_timestamp()');
    await context('observer_clear'); await db.query('UPDATE grid_worker_host SET observer_fenced=false');
    await context('pause_ack'); await db.query('UPDATE grid_worker_host SET pause_ack_at=clock_timestamp(),pause_ack_revision=pause_revision');
    await context('transition');
    await refused('UPDATE grid_worker_host SET per_bot_cap_usd=10', [], 'GRID_SCOPE_REVISION_REQUIRED');
    await db.query('UPDATE grid_worker_host SET per_bot_cap_usd=10,scope_revision=scope_revision+1');
    await context('reset');
    await refused('UPDATE grid_worker_host SET entries_paused=false,pause_revision=pause_revision+1,pause_ack_at=NULL,pause_ack_revision=NULL', [], 'GRID_RESET_REQUIRED');
    await db.query("SET LOCAL qv.grid_worker_deployment_flags_clear='true'");
    await db.query('UPDATE grid_worker_host SET entries_paused=false,pause_revision=pause_revision+1,pause_ack_at=NULL,pause_ack_revision=NULL');
  });
  it('data staging remains separate from catalog readiness', async () => {
    await seed(); expect((await probeGridWorkerData(query)).stage).toBe('seeded');
    await arm(); expect((await probeGridWorkerData(query)).stage).toBe('tracking');
    expect((await probeGridWorkerData(query)).ready).toBe(false);
    expect((await db.query(GRID_WORKER_CATALOG_CHECK_SQL)).rows[0].ok).toBe(true);
  });
  it('quota stage requires the supplied policy digest and a matching live window', async () => {
    await seed(); await arm();
    const policyDigest = digest('EXAMPLE_POLICY');
    await db.query("INSERT INTO grid_worker_quota_policy VALUES('rpc_primary','EXAMPLE',60000,100,80,20,$1,clock_timestamp()+interval '1 hour')", [policyDigest]);
    await db.query("INSERT INTO grid_worker_quota_windows VALUES('rpc_primary','EXAMPLE',60000,100,80,20,$1,clock_timestamp(),0,clock_timestamp(),NULL)", [policyDigest]);
    const domains = [{ provider: 'rpc_primary', domainId: 'EXAMPLE', policyDigest }];
    expect((await probeGridWorkerData(query, domains)).stage).toBe('quota');
    expect((await probeGridWorkerData(query, [{ ...domains[0], policyDigest: digest('EXAMPLE_OTHER') }])).ready).toBe(false);
    await db.query("UPDATE grid_worker_quota_windows SET backoff_until=clock_timestamp()+interval '1 minute'");
    expect((await probeGridWorkerData(query, domains)).ready).toBe(false);
  });
  for (const action of ['reset_pause', 'ack_critical', 'widen_scope', 'break_glass_close']) it('consumer binds ' + action, async () => {
    await seed();
    const paramsDigest = ['widen_scope', 'break_glass_close'].includes(action) ? digest('EXAMPLE_PARAMS') : 'none';
    const id = await receipt(action, 'all', paramsDigest);
    await refused('SELECT grid_worker_consume_receipt($1,$2,$3,$4)', [id, action, 'all', digest('EXAMPLE_WRONG')], 'GRID_RECEIPT_BINDING');
    await db.query('SELECT grid_worker_consume_receipt($1,$2,$3,$4)', [id, action, 'all', paramsDigest]);
    expect((await db.query('SELECT consumed_by IS NOT NULL AS used FROM owner_action_receipts WHERE receipt_id=$1', [id])).rows[0].used).toBe(true);
  });
  for (const timeZone of ['UTC', 'Australia/Sydney', 'America/New_York']) it('pause consumes atomically in ' + timeZone, async () => {
    await seed(); await db.query('SELECT set_config(\'TimeZone\',$1,true)', [timeZone]);
    const before = (await db.query('SELECT to_jsonb(h) AS host FROM grid_worker_host h')).rows[0].host;
    const id = await receipt(); await db.query(pause, [id]);
    const after = (await db.query('SELECT to_jsonb(h) AS host FROM grid_worker_host h')).rows[0].host;
    expect(after).toEqual({ ...before, pause_revision: 1 });
    expect((await db.query('SELECT consumed_at IS NOT NULL AS used FROM owner_action_receipts WHERE receipt_id=$1', [id])).rows[0].used).toBe(true);
    await refused(pause, [id], 'GRID_RECEIPT_CONSUMED');
  });
  for (const [name, mutation, code] of [
    ['digest', 'message_digest=$2', 'GRID_RECEIPT_DIGEST'],
    ['owner', "owner_wallet='EXAMPLE_OTHER'", 'GRID_RECEIPT_OWNER'],
    ['action', "action='reset_pause'", 'GRID_RECEIPT_BINDING'],
    ['target', "target='host:example'", 'GRID_RECEIPT_BINDING'],
    ['expired', "issued_at=clock_timestamp()-interval '240 seconds',expires_at=clock_timestamp()-interval '1 second'", 'GRID_RECEIPT_EXPIRED'],
    ['stale', "verified_at=clock_timestamp()-interval '61 seconds'", 'GRID_RECEIPT_STALE'],
    ['consumed', "consumed_at=clock_timestamp(),consumed_by='EXAMPLE'", 'GRID_RECEIPT_CONSUMED'],
    ['futureIssued', "issued_at=clock_timestamp()+interval '30 seconds'", 'GRID_RECEIPT_EXPIRED'],
    ['futureVerified', "verified_at=clock_timestamp()+interval '30 seconds'", 'GRID_RECEIPT_STALE'],
    ['microseconds', "expires_at=date_trunc('milliseconds',expires_at)+interval '1 microsecond'", 'GRID_RECEIPT_CANONICAL'],
    ['nonce', "nonce='CHANGEME'", 'GRID_RECEIPT_CANONICAL'],
  ]) it('pause refuses receipt ' + name, async () => {
    await seed(); const id = await receipt();
    await db.query('UPDATE owner_action_receipts SET ' + mutation + ' WHERE receipt_id=$1', name === 'digest' ? [id, digest('EXAMPLE_WRONG')] : [id]);
    await refused(pause, [id], code);
    expect((await db.query('SELECT pause_revision FROM grid_worker_host')).rows[0].pause_revision).toBe('0');
  });
  it('pause refuses wrong scope, placeholders and parameter binding', async () => {
    await seed(); const id = await receipt();
    await db.query('ALTER TABLE owner_action_receipts DROP CONSTRAINT owner_receipt_scope');
    await db.query("UPDATE owner_action_receipts SET scope='EXAMPLE_OTHER'");
    await refused(pause, [id], 'GRID_RECEIPT_BINDING');
    await refused(pause, ['CHANGEME']);
    await refused("SELECT grid_worker_pause_from_verified_receipt($1,'reset_pause','all','none')", [id], 'GRID_PAUSE_BINDING');
  });
  it('receipt constraints reject overlong windows and uppercase message digests', async () => {
    await seed(); const id = await receipt();
    await refused("UPDATE owner_action_receipts SET expires_at=issued_at+interval '301 seconds' WHERE receipt_id=$1", [id]);
    await refused('UPDATE owner_action_receipts SET message_digest=upper(message_digest) WHERE receipt_id=$1', [id]);
    const wrongParams = await receipt('reset_pause', 'all', digest('EXAMPLE_PARAMS'));
    await refused("SELECT grid_worker_consume_receipt($1,'reset_pause','all',$2)", [wrongParams, digest('EXAMPLE_PARAMS')], 'GRID_RECEIPT_PARAMS');
  });
  for (const mutation of ['space', 'CRLF', 'trailingLF', 'fieldOrder']) it('consumer rejects noncanonical message ' + mutation, async () => {
    await seed(); const id = await receipt();
    const r = (await db.query('SELECT * FROM owner_action_receipts WHERE receipt_id=$1', [id])).rows[0];
    const lines = ['QV-OWNER-ACTION v1', 'action:pause', 'scope:grid_worker', 'target:all', 'nonce:' + r.nonce, 'issued:' + r.issued_at.toISOString(), 'expires:' + r.expires_at.toISOString(), 'params:none'];
    if (mutation === 'fieldOrder') [lines[1], lines[2]] = [lines[2], lines[1]];
    const message = lines.join(mutation === 'CRLF' ? '\r\n' : '\n') + (mutation === 'trailingLF' ? '\n' : mutation === 'space' ? ' ' : '');
    await db.query('UPDATE owner_action_receipts SET message_digest=$2 WHERE receipt_id=$1', [id, digest(message)]);
    await refused(pause, [id], 'GRID_RECEIPT_DIGEST');
  });
  it('receipt consumption rolls back when pause mutation fails', async () => {
    await seed(); const id = await receipt();
    await db.query('ALTER TABLE grid_worker_host ADD CONSTRAINT example_refusal CHECK(pause_revision=0)');
    await refused(pause, [id]);
    expect((await db.query('SELECT consumed_at FROM owner_action_receipts WHERE receipt_id=$1', [id])).rows[0].consumed_at).toBeNull();
  });
  it('incident acknowledgement allows a second occurrence', async () => {
    await seed();
    const insert = "INSERT INTO grid_worker_incidents(id,dedup_key,severity,code,first_seen_at,last_seen_at) VALUES($1,'EXAMPLE','critical','schema_drift',clock_timestamp(),clock_timestamp())";
    await db.query(insert, [randomUUID()]);
    await refused(insert, [randomUUID()]);
    await db.query("UPDATE grid_worker_incidents SET acknowledged_at=clock_timestamp(),acknowledged_by='EXAMPLE'");
    await db.query(insert, [randomUUID()]);
    expect((await db.query('SELECT count(*)::integer AS n FROM grid_worker_incidents')).rows[0].n).toBe(2);
  });
  it('held console templates reject placeholders and preserve exact reruns in a scratch fixture', async () => {
    const template = (name: keyof typeof U2A_CONSOLE_TEMPLATES) => {
      const value = U2A_CONSOLE_TEMPLATES[name];
      expect(digest(value.sql)).toBe(value.sqlSha256);
      return value.sql.replace(/^BEGIN;\n/m, '').replace(/^COMMIT;\n/m, '');
    };
    await db.query("INSERT INTO wallets(address) VALUES('EXAMPLE')");
    await refused(template('P1-OWNER-HOST.sql'), [], 'GRID_OWNER_INPUT_REQUIRED');
    const p1 = template('P1-OWNER-HOST.sql').replace("chosen_wallet text := 'CHANGEME'", "chosen_wallet text := 'EXAMPLE'");
    await db.query(p1); await db.query(p1);
    expect((await probeGridWorkerData(query)).stage).toBe('seeded');
    await refused(template('P2-AUTHORITY-HELD.sql'), [], 'GRID_U2C_AUTHORIZATION_REQUIRED');
    const p2 = template('P2-AUTHORITY-HELD.sql').replace("'CHANGEME'", "'REVIEWED_U2C_FIRST_INSTALL'");
    await db.query(p2); await db.query(p2);
    expect((await probeGridWorkerData(query)).stage).toBe('tracking');
    await refused(template('P3-QUOTA-HELD.sql'));
    const now = (await db.query('SELECT clock_timestamp() AS at')).rows[0].at as Date;
    const policyDigest = digest('EXAMPLE_POLICY');
    const rows = [{ provider: 'rpc_primary', domain_id: 'EXAMPLE', window_ms: 60000, total_units: 100, worker_limit_units: 80, worker_protective_reserve_units: 20, policy_digest: policyDigest, valid_until: new Date(now.getTime() + 3600000).toISOString(), window_start: now.toISOString() }];
    const p3 = template('P3-QUOTA-HELD.sql').replace("'CHANGEME'::jsonb", "'" + JSON.stringify(rows) + "'::jsonb");
    await db.query(p3); await db.query(p3);
    expect((await probeGridWorkerData(query, [{ provider: 'rpc_primary', domainId: 'EXAMPLE', policyDigest }])).stage).toBe('quota');
    await refused(template('OWNER-PAUSE.sql'));
  });
});
