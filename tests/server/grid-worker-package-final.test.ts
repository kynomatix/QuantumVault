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
import {gridWorkerIsolation} from '../helpers/grid-worker-isolation';

describe('Final package S1-S3 R1-R3 PostgreSQL', () => {
  let admin: Pool, fixturePool: Pool, db: PoolClient;
  const schema = 'grid_final_' + randomUUID().replaceAll('-', '');
  const isolate=gridWorkerIsolation();
  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url || new URL(url).pathname !== '/qvtest') throw Error('FRACTAL qvtest required');
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query('CREATE SCHEMA ' + schema);
    fixturePool = new Pool({ connectionString: url, max: 1, options: '-c search_path=' + schema + ',pg_catalog' });
    db = isolate(await fixturePool.connect());
    // Clone only schema, retaining real column ordinals for exact trigger attributes.
    for (const table of ['wallets', 'grid_bots', 'grid_operations', 'grid_control_requests', 'protocol_subaccounts', 'grid_launch_accounts']) {
      await db.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    const sql = readFileSync('migrations/grid_worker_v3_owner.sql', 'utf8')
      .replaceAll('SET search_path = pg_catalog, public', 'SET search_path = pg_catalog, ' + schema);
    await db.query(sql);
  }, 30_000);
  beforeEach(async () => { await db.query('BEGIN'); });
  afterEach(async () => { await db.query('ROLLBACK; BEGIN'); await fence(); await db.query('TRUNCATE grid_worker_host,grid_worker_owner,wallets,grid_bots,protocol_subaccounts,grid_launch_accounts CASCADE'); await db.query('COMMIT'); });
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
  async function seed(expiredHolder?: string) {
    await fence();
    await db.query("INSERT INTO wallets(address) VALUES('EXAMPLE'),('EXAMPLE_OTHER')");
    await db.query("INSERT INTO grid_worker_owner(wallet_address) VALUES('EXAMPLE')");
    await db.query(`INSERT INTO grid_worker_host(protocol_version,owner_wallet,holder_boot_id,holder_role,lease_expires_at)
      VALUES('grid-worker-v3-a1-wire1','EXAMPLE',$1,CASE WHEN $1::uuid IS NULL THEN NULL ELSE 'grid-worker' END,
        CASE WHEN $1::uuid IS NULL THEN '-infinity'::timestamptz ELSE clock_timestamp()-interval '1 second' END)`, [expiredHolder ?? null]);
  }
  async function arm() {
    for (const wallet of ['EXAMPLE', 'EXAMPLE_OTHER']) {
      await walletLock(wallet);
      await db.query('INSERT INTO grid_worker_wallet_authority(wallet_address) VALUES($1)', [wallet]);
    }
    await context('bootstrap_tracking');
    await db.query('UPDATE grid_worker_host SET authority_tracking_enabled=true');
  }
  async function externalLeaseFixture() {
    await arm(); await context('transition');
    await db.query("SET LOCAL qv.grid_worker_ready='true'; SET LOCAL qv.grid_worker_owner_verified='true'");
    await db.query("UPDATE grid_worker_host SET execution_mode='external',legacy_controls_enabled=true");
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
  const consume = 'SELECT grid_worker_consume_receipt($1,$2,$3,$4)';
  for (const action of ['host_transition','quota_policy']) it('S1 '+action+' binds digest, target and action; consumption is atomic and once only', async () => {
    await seed(); const paramsDigest=digest('EXAMPLE_PARAMS');
    const id=await receipt(action,'host:example',paramsDigest);
    for (const args of [[id,action,'all',paramsDigest],[id,'pause','host:example',paramsDigest],[id,action,'host:example',digest('EXAMPLE_OTHER')]]) await refused(consume,args,'GRID_RECEIPT_BINDING');
    const none=await receipt(action,'all','none'); await refused(consume,[none,action,'all','none'],'GRID_RECEIPT_PARAMS');
    await db.query('SAVEPOINT consume'); await db.query(consume,[id,action,'host:example',paramsDigest]); await db.query('ROLLBACK TO SAVEPOINT consume');
    expect((await db.query('SELECT consumed_at FROM owner_action_receipts WHERE receipt_id=$1',[id])).rows[0].consumed_at).toBeNull();
    await db.query(consume,[id,action,'host:example',paramsDigest]);
    await refused(consume,[id,action,'host:example',paramsDigest],'GRID_RECEIPT_CONSUMED');
  });
  it('S2 activation advances epoch and scope atomically and supersedes pending requests only', async () => {
    await seed(); const botId=await bot(), requestId=await request(botId); await arm(); await identityLock('bot',botId);
    await context('transition'); await db.query("SET LOCAL qv.grid_worker_ready='true'; SET LOCAL qv.grid_worker_owner_verified='true'");
    await db.query('SAVEPOINT activation');
    const sql="UPDATE grid_worker_host SET execution_mode='external',legacy_controls_enabled=true,fencing_epoch=fencing_epoch+1,scope_revision=scope_revision+1";
    await db.query(sql);
    expect((await db.query('SELECT state,result_code FROM grid_worker_requests WHERE id=$1',[requestId])).rows[0]).toEqual({state:'superseded',result_code:'scope_changed'});
    expect((await db.query('SELECT fencing_epoch,scope_revision,start_scope,per_bot_cap_usd,global_ceiling_usd FROM grid_worker_host')).rows[0]).toEqual({fencing_epoch:'1',scope_revision:'2',start_scope:'owner_allowlist',per_bot_cap_usd:null,global_ceiling_usd:null});
    await db.query('ROLLBACK TO SAVEPOINT activation');
    expect((await db.query('SELECT state FROM grid_worker_requests WHERE id=$1',[requestId])).rows[0].state).toBe('pending');
    await db.query(sql); await db.query('COMMIT; BEGIN');
    expect((await db.query('SELECT state FROM grid_worker_requests WHERE id=$1',[requestId])).rows[0].state).toBe('superseded');
  });
  it('S2 refuses unverified, skipped, regressed and non-transition scope-only revisions', async () => {
    await seed(); await context('transition'); await db.query("SET LOCAL qv.grid_worker_ready='true'");
    await refused('UPDATE grid_worker_host SET scope_revision=2',[],'GRID_OWNER_TRANSITION_REQUIRED');
    await db.query("SET LOCAL qv.grid_worker_owner_verified='true'");
    await refused('UPDATE grid_worker_host SET scope_revision=3',[],'GRID_SCOPE_REVISION_INVALID');
    await refused('UPDATE grid_worker_host SET scope_revision=0',[],'GRID_HOST_MONOTONIC');
    await context('reset'); await refused('UPDATE grid_worker_host SET scope_revision=2',[],'GRID_RESET_MUTATION_INVALID');
    await context('tighten'); await refused('UPDATE grid_worker_host SET scope_revision=2',[],'GRID_TIGHTEN_ONLY');
  });
  const acquire="UPDATE grid_worker_host SET holder_boot_id=$1,holder_role='grid-worker',fencing_epoch=fencing_epoch+1,lease_expires_at=clock_timestamp()+interval '45 seconds'";
  async function worker() {
    const holder=randomUUID(); await context('lease_acquire'); await db.query("SET LOCAL qv.grid_worker_ready='true'"); await db.query(acquire,[holder]); return holder;
  }
  it('R1 legacy refuses a worker lease and external permits it', async () => {
    await seed(); await context('lease_acquire'); await db.query("SET LOCAL qv.grid_worker_ready='true'");
    await refused(acquire,[randomUUID()],'GRID_LEASE_ACQUIRE_INVALID');
    await externalLeaseFixture(); const holder=await worker();
    expect((await db.query('SELECT holder_boot_id FROM grid_worker_host')).rows[0].holder_boot_id).toBe(holder);
  });
  it('R2 reset changes only pause columns and cannot smuggle any other host field', async () => {
    await seed(); await context('reset'); await db.query("SET LOCAL qv.grid_worker_ready='true'; SET LOCAL qv.grid_worker_owner_verified='true'; SET LOCAL qv.grid_worker_deployment_flags_clear='true'");
    const reset='UPDATE grid_worker_host SET entries_paused=false,pause_revision=pause_revision+1,pause_ack_at=NULL,pause_ack_revision=NULL';
    const changes={execution_mode:"'external'",run_mode:"'trading'",execution_enabled:'true',legacy_controls_enabled:'true',drain_requested:'true',holder_boot_id:"gen_random_uuid()",holder_role:"'protective'",fencing_epoch:'1',scope_revision:'2',start_scope:"'expanded'",per_bot_cap_usd:'10',global_ceiling_usd:'100',commit_hash:"'EXAMPLE'",tree_hash:"'EXAMPLE'",lockfile_sha256:"'EXAMPLE'",authority_tracking_enabled:'true',observer_fenced:'false',updated_at:'clock_timestamp()',lease_expires_at:'clock_timestamp()',heartbeat_at:'clock_timestamp()',progress_at:'clock_timestamp()',last_healthz_poll_at:'clock_timestamp()'};
    for(const [column,value] of Object.entries(changes)) await refused(reset+','+column+'='+value,[],'GRID_RESET_MUTATION_INVALID');
    await db.query(reset); expect((await db.query('SELECT entries_paused,pause_revision,pause_ack_at,pause_ack_revision FROM grid_worker_host')).rows[0]).toEqual({entries_paused:false,pause_revision:'1',pause_ack_at:null,pause_ack_revision:null});
  });
  it('R3 independent withdrawal cursor accepts valid states and rejects unknown or incomplete complete evidence', async () => {
    await seed();
    for(const stream of ['orders','fills','transfers','withdrawals']) await db.query("INSERT INTO grid_worker_reconciliation(account,master_account,stream,cursor) VALUES('EXAMPLE_ACCOUNT','EXAMPLE_MASTER',$1,$1)",[stream]);
    await refused("INSERT INTO grid_worker_reconciliation(account,master_account,stream) VALUES('EXAMPLE_ACCOUNT','EXAMPLE_MASTER','EXAMPLE_UNKNOWN')",[],'grid_worker_reconciliation_state');
    await refused("UPDATE grid_worker_reconciliation SET state='complete' WHERE stream='withdrawals'",[],'grid_worker_reconciliation_state');
    await db.query("UPDATE grid_worker_reconciliation SET state='complete',cursor='EXAMPLE_NEXT',covered_through_at=clock_timestamp(),last_complete_at=clock_timestamp(),evidence_digest=$1 WHERE stream='withdrawals'",[digest('EXAMPLE_EVIDENCE')]);
    expect((await db.query("SELECT stream,cursor FROM grid_worker_reconciliation ORDER BY stream")).rows).toEqual([{stream:'fills',cursor:'fills'},{stream:'orders',cursor:'orders'},{stream:'transfers',cursor:'transfers'},{stream:'withdrawals',cursor:'EXAMPLE_NEXT'}]);
  });
  async function releaseFixture(mode:'legacy'|'external',status='grid_owned') {
    await seed(); const botId=await bot();
    await db.query("UPDATE wallets SET agent_public_key='EXAMPLE_MASTER' WHERE address='EXAMPLE'");
    await db.query("INSERT INTO protocol_subaccounts(id,wallet_address,protocol,status,agent_public_key,protocol_subaccount_id) VALUES(123,'EXAMPLE','pacifica',$1,'EXAMPLE_MASTER','EXAMPLE_ACCOUNT')",[status]);
    await db.query("INSERT INTO grid_launch_accounts(bot_id,protocol_subaccount_id,master_account,account,canary_limit) VALUES($1,123,'EXAMPLE_MASTER','EXAMPLE_ACCOUNT',1)",[botId]);
    let holder=randomUUID();
    if(mode==='external'){await externalLeaseFixture(); holder=await worker();}
    await db.query('COMMIT; BEGIN'); return {botId,holder};
  }
  const releasePool="UPDATE protocol_subaccounts SET status='spare' WHERE id=123";
  const releaseLaunch='UPDATE grid_launch_accounts SET released_at=clock_timestamp()';
  for(const sql of [releasePool,releaseLaunch]) {
    it('S3 legacy release stays a no-op for validator '+(sql===releasePool?'pool':'launch'),async()=>{
      await releaseFixture('legacy'); await db.query(sql); await db.query('COMMIT; BEGIN');
      const row=(await db.query('SELECT p.status,l.released_at FROM protocol_subaccounts p JOIN grid_launch_accounts l ON l.protocol_subaccount_id=p.id')).rows[0];
      expect(sql===releasePool?row.status==='spare':row.released_at!==null).toBe(true);
    });
    for(const missing of ['host','main','protective','stale-holder','stale-epoch','expired','wallet','bot','pool'] as const) it('S3 '+(sql===releasePool?'pool':'launch')+' rejects '+missing,async()=>{
      const {botId,holder}=await releaseFixture('external');
      if(missing!=='host')await fence(missing!=='protective'&&missing!=='expired');
      if(missing==='protective'||missing==='expired'){
        await context('transition'); await db.query("SET LOCAL qv.grid_worker_ready='true'; SET LOCAL qv.grid_worker_owner_verified='true'");
        await db.query(missing==='protective'?"UPDATE grid_worker_host SET holder_role='protective',fencing_epoch=2":"UPDATE grid_worker_host SET lease_expires_at=clock_timestamp()-interval '1 second',drain_requested=true");
      }
      if(missing!=='main')await db.query("SELECT set_config('qv.grid_worker_holder',$1,true),set_config('qv.grid_worker_epoch',$2,true)",[missing==='stale-holder'?randomUUID():holder,missing==='stale-epoch'?'0':missing==='protective'?'2':'1']);
      if(missing!=='wallet')await walletLock();
      if(missing!=='bot')await identityLock('bot',botId);
      if(missing!=='pool')await identityLock('pool',123);
      await refused(sql,[],missing==='host'?'GRID_RELEASE_HOST_PRELOCK_REQUIRED':missing==='wallet'?'GRID_RELEASE_WALLET_PRELOCK_REQUIRED':missing==='bot'||missing==='pool'?'GRID_RELEASE_IDENTITY_PRELOCK_REQUIRED':'GRID_RELEASE_WORKER_REQUIRED');
    });
  }
  for(const status of ['grid_owned','grid_reserved']) it('S3 live worker commits pool then launch release from '+status,async()=>{
    const {botId,holder}=await releaseFixture('external',status); await fence(true); await walletLock(); await identityLock('bot',botId); await identityLock('pool',123);
    await db.query("SELECT set_config('qv.grid_worker_holder',$1,true),set_config('qv.grid_worker_epoch','1',true)",[holder]);
    await db.query(releasePool); await db.query(releaseLaunch); await db.query('COMMIT; BEGIN');
    expect((await db.query('SELECT p.status,l.released_at IS NOT NULL AS released FROM protocol_subaccounts p JOIN grid_launch_accounts l ON l.protocol_subaccount_id=p.id')).rows[0]).toEqual({status:'spare',released:true});
  });
  it('S3 WHEN guard leaves non-grid status transitions untouched in external mode',async()=>{
    await releaseFixture('external','spare'); await db.query("UPDATE protocol_subaccounts SET status='quarantined' WHERE id=123");
    expect((await db.query('SELECT status FROM protocol_subaccounts')).rows[0].status).toBe('quarantined');
  });
  for(const table of ['pool','launch']) it('S3 '+table+' release cannot change retained identity in the same update',async()=>{
    const {botId,holder}=await releaseFixture('external'); await fence(true); await walletLock(); await identityLock('bot',botId); await identityLock('pool',123);
    await db.query("SELECT set_config('qv.grid_worker_holder',$1,true),set_config('qv.grid_worker_epoch','1',true)",[holder]);
    await refused(table==='pool'?"UPDATE protocol_subaccounts SET status='spare',protocol_subaccount_id='EXAMPLE_OTHER' WHERE id=123":"UPDATE grid_launch_accounts SET released_at=clock_timestamp(),account='EXAMPLE_OTHER'",[],'GRID_RELEASE_IDENTITY_CHANGED');
  });

});
