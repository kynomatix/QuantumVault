import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import bs58 from 'bs58';
import { fencedTransaction, GridDeadline, hostFence, walletFences, type ClientLane } from '../../server/grid-worker/transaction';
import { backendTerminator, independentLane } from '../../server/grid-worker/lanes';
import { issueOwnerChallenge, verifyOwnerReceipt } from '../../server/grid-worker/owner-receipts';
import { parseOwnerMessage, serializeOwnerMessage } from '../../server/grid-worker/owner-auth';
import { acknowledgeCritical, acknowledgePause, localContext, pauseHost, readLegacyHost, resetPause, legacyKillContext } from '../../server/grid-worker/host';
import { GridWorkerLease, takeoverWindowsClear } from '../../server/grid-worker/lease';
import { GridIncidents } from '../../server/grid-worker/incidents';
import { authorizeSendAudit, completeSendAudit, prepareSendAudit, type SendAudit } from '../../server/grid-worker/audit';
import { gridActionAllowed } from '../../server/grid-worker/kill';
import { behaviourPolicy } from '../grid-bot/behaviour-fixtures';
import { computeGridPolicyHmac } from '../../server/grid-bot/policy-hmac';
import { umk } from '../grid-bot/draft-fixtures';

const sha256 = (s: string) => createHash('sha256').update(s).digest();
const EXAMPLE = createPrivateKey({ key:Buffer.concat([Buffer.from([48,46,2,1,0,48,5,6,3,43,101,112,4,34,4,32]),sha256('EXAMPLE_U2B:'+randomUUID())]),format:'der',type:'pkcs8' });
const owner = bs58.encode(createPublicKey(EXAMPLE).export({type:'spki',format:'der'}).subarray(-32));
const signed = (message: string) => ({message,signature:bs58.encode(sign(null,Buffer.from(message),EXAMPLE)),signer:owner,sessionWallet:owner});
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve,ms));
function latch() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve=r; }); return {promise,resolve}; }

describe('U2b PostgreSQL races and durable evidence', () => {
  const schema = 'grid_u2b_' + randomUUID().replaceAll('-','');
  // PostgreSQL advisory keys are database-wide, even across search_path schemas.
  // Translate ONLY the host identity in this fixture's SQL (including its copied
  // trigger bodies), so deliberate pause/stall tests cannot fence other suites.
  // Product SQL and the frozen package retain the canonical identity unchanged.
  const fixtureHost = 'qv:grid-worker:v3:host:' + schema;
  const fixtureWalletNamespace=String(1_000_000+Math.floor(Math.random()*1_000_000_000));
  function isolateHost(c: PoolClient) {
    c.query = new Proxy(c.query, { apply(query, receiver, args) {
      const rewrite = (sql: string) => sql.replaceAll("'qv:grid-worker:v3:host'", "'" + fixtureHost + "'").replaceAll('927412',fixtureWalletNamespace).replaceAll('qv:grid-worker:v3:bot:','qv:grid-worker:v3:'+schema+':bot:').replaceAll('qv:grid-worker:v3:pool:','qv:grid-worker:v3:'+schema+':pool:');
      if (typeof args[0] === 'string') args[0] = rewrite(args[0]);
      else if (args[0] && typeof args[0].text === 'string') args[0] = { ...args[0], text: rewrite(args[0].text) };
      if(Array.isArray(args[1]))args[1]=args[1].map(v=>typeof v==='string'?v.replaceAll('qv:grid-worker:v3:bot:','qv:grid-worker:v3:'+schema+':bot:').replaceAll('qv:grid-worker:v3:pool:','qv:grid-worker:v3:'+schema+':pool:'):v===927412?Number(fixtureWalletNamespace):v);
      return Reflect.apply(query, receiver, args);
    } });
    return c;
  }
  const controlLane = (): ClientLane => {
    const lane = independentLane(pool);
    return { connect: async () => isolateHost(await lane.connect()) };
  };
  let admin: Pool, pool: Pool, terminate: (pid:number)=>Promise<void>;
  const tx = <T>(work:(c:PoolClient,d:GridDeadline)=>Promise<T>, mode:'shared'|'exclusive'|'none'='shared', pause=false) => fencedTransaction(pool,work,{mode,pause,terminate});
  beforeAll(async () => {
    const url=process.env.DATABASE_URL;
    if(!url || new URL(url).pathname!=='/qvtest')throw Error('FRACTAL qvtest required');
    admin=new Pool({connectionString:url,max:2}); await admin.query('CREATE SCHEMA '+schema);
    pool=new Pool({connectionString:url,max:8,options:'-c search_path='+schema+',pg_catalog'});
    pool.on('error',()=>{}); pool.on('connect',c=>{isolateHost(c);c.on('error',()=>{});});
    terminate=backendTerminator(controlLane());
    const c=await pool.connect();
    try {
      for(const table of ['wallets','grid_bots','grid_operations','grid_control_requests','protocol_subaccounts','grid_launch_accounts','auth_nonces']) await c.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
      await c.query(readFileSync('migrations/grid_worker_v3_owner.sql','utf8').replaceAll('SET search_path = pg_catalog, public','SET search_path = pg_catalog, '+schema));
    } finally { c.release(); }
  },30_000);
  beforeEach(async()=>{
    await pool.query('TRUNCATE grid_worker_host,grid_worker_owner,grid_worker_wallet_authority,grid_worker_requests,grid_worker_reservations,grid_worker_send_audit,grid_worker_incidents,grid_worker_reconciliation,grid_worker_quota_windows,grid_worker_quota_policy,owner_action_receipts,auth_nonces,grid_operations,grid_bots,grid_control_requests,grid_launch_accounts,protocol_subaccounts,wallets CASCADE');
    await tx(async c=>{
      await c.query('INSERT INTO wallets(address) VALUES($1)',[owner]);
      await c.query('INSERT INTO grid_worker_owner(wallet_address) VALUES($1)',[owner]);
      await c.query("INSERT INTO grid_worker_host(protocol_version,owner_wallet) VALUES('grid-worker-v3-a1-wire1',$1)",[owner]);
    },'exclusive');
  });
  afterAll(async()=>{await pool?.end();if(admin){await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();}},30_000);
  it('different schemas share canonical host locks, but fixture exclusive locks leave MAIN admission free', async () => {
    const canonical = 'EXAMPLE_isolation_control:'+schema;
    const fixture = await pool.connect(), main = await admin.connect();
    try {
      await fixture.query('BEGIN'); await main.query('BEGIN');
      // Parameter binding deliberately bypasses the fixture's literal translation.
      await fixture.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [canonical]);
      expect((await main.query('SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) AS ok', [canonical])).rows[0].ok).toBe(false);
      await fixture.query('ROLLBACK'); await fixture.query('BEGIN');
      await hostFence(fixture, 'exclusive');
      expect((await main.query('SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) AS ok', [fixtureHost])).rows[0].ok).toBe(false);
      // The unmodified product helper on a public client uses the canonical key.
      await main.query("SET LOCAL statement_timeout='500ms'");
      await main.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[canonical]);
    } finally {
      await fixture.query('ROLLBACK'); await main.query('ROLLBACK'); fixture.release(); main.release();
    }
  });
  it('fenced commit and rollback restore timeout settings on the same pooled backend', async () => {
    const single = new Pool({connectionString:process.env.DATABASE_URL,max:1,options:'-c search_path='+schema+',pg_catalog'});
    single.on('connect', isolateHost);
    const settings = "SELECT pg_backend_pid() AS pid,current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle";
    try {
      const before = (await single.query(settings)).rows[0];
      for (const rollback of [false,true]) {
        const run = fencedTransaction(single, async c => {
          expect((await c.query(settings)).rows[0]).toEqual({pid:before.pid,statement:'2s',lock:'2s',idle:'12s'});
          if (rollback) throw Error('EXAMPLE_ROLLBACK');
        }, {terminate});
        if (rollback) await expect(run).rejects.toThrow('EXAMPLE_ROLLBACK'); else await run;
        expect((await single.query(settings)).rows[0]).toEqual(before);
      }
    } finally { await single.end(); }
  });
  async function external() {
    // Fixture models the separately reviewed future owner activation. Application exposes no such API.
    await tx(async c=>{
      await walletFences(c,[owner]);
      await c.query('INSERT INTO grid_worker_wallet_authority(wallet_address) VALUES($1)',[owner]);
      await localContext(c,'bootstrap_tracking');
      await c.query('UPDATE grid_worker_host SET authority_tracking_enabled=true');
      await c.query("SELECT set_config('qv.grid_worker_owner_verified','true',true),set_config('qv.grid_worker_ready','true',true)");
      await localContext(c,'transition');
      const fixtureSha256=sha256('EXAMPLE_IDENTITY').toString('hex');
      await c.query("UPDATE grid_worker_host SET execution_mode='external',run_mode='trading',execution_enabled=true,legacy_controls_enabled=true,commit_hash=$1,tree_hash=$1,lockfile_sha256=$2",[fixtureSha256.slice(0,40),fixtureSha256]);
    },'exclusive');
  }
  const lease = () => new GridWorkerLease(pool,controlLane(),terminate,async()=>true);
  const acceptance = {verified:true,milliseconds:0,skewMs:50};
  async function challenge(action:'pause'|'reset_pause'|'ack_critical'='pause',target='all',ttl=120_000) { return tx(c=>issueOwnerChallenge(c,owner,action,target,undefined,ttl)); }
  it('nonce verification consume and latch share one transaction; rollback restores nonce; replay refused',async()=>{
    const message=await challenge();
    await expect(tx(async c=>{const verified=await verifyOwnerReceipt(c,signed(message));await pauseHost(c,verified);throw Error('EXAMPLE_CALLER_ROLLBACK');},'exclusive')).rejects.toThrow('EXAMPLE_CALLER_ROLLBACK');
    expect((await pool.query('SELECT used_at FROM auth_nonces')).rows[0].used_at).toBeNull();
    expect((await pool.query('SELECT count(*)::int AS n FROM owner_action_receipts')).rows[0].n).toBe(0);
    const revision=await tx(async c=>pauseHost(c,await verifyOwnerReceipt(c,signed(message))),'exclusive',true);
    expect(String(revision)).toBe('1');
    await expect(tx(c=>verifyOwnerReceipt(c,signed(message)),'exclusive')).rejects.toThrow('GRID_OWNER_NONCE_INVALID');
    expect((await pool.query('SELECT consumed_at IS NOT NULL AS consumed FROM owner_action_receipts')).rows[0].consumed).toBe(true);
  });
  it('expired future altered signature session nonowner and forged context refuse without consumption',async()=>{
    const message=await challenge();
    for(const input of [{...signed(message),sessionWallet:'EXAMPLE'}, {...signed(message),signer:'EXAMPLE'},
      {...signed(message),message:message.replace('target:all','target:host:other')},signed(message.replace('issued:','issued: '))]) {
      await expect(tx(c=>verifyOwnerReceipt(c,input),'exclusive')).rejects.toThrow();
    }
    const expired=await challenge('pause','all',1);await delay(10);
    await expect(tx(c=>verifyOwnerReceipt(c,signed(expired)),'exclusive')).rejects.toThrow('GRID_OWNER_NONCE_INVALID');
    const future=parseOwnerMessage(await challenge());
    future.issued=new Date(Date.now()+60_000).toISOString();future.expires=new Date(Date.parse(future.issued)+120_000).toISOString();
    await pool.query("UPDATE auth_nonces SET created_at=$1::timestamptz AT TIME ZONE 'UTC',expires_at=$2::timestamptz AT TIME ZONE 'UTC' WHERE nonce_hash=$3",[future.issued,future.expires,sha256(future.nonce).toString('hex')]);
    await expect(tx(c=>verifyOwnerReceipt(c,signed(serializeOwnerMessage(future))),'exclusive')).rejects.toThrow('GRID_OWNER_WINDOW_INVALID');
    await expect(tx(c=>pauseHost(c,{receiptId:randomUUID(),ownerWallet:owner,action:'pause',target:'all',paramsDigest:'none'}),'exclusive')).rejects.toThrow('GRID_VERIFIED_OWNER_REQUIRED');
    await expect(pool.query("SELECT grid_worker_pause_from_verified_receipt('CHANGEME','pause','all','none')")).rejects.toThrow();
    expect((await pool.query('SELECT count(*)::int AS n FROM auth_nonces WHERE used_at IS NOT NULL')).rows[0].n).toBe(0);
  });
  it('DB UTC challenge ignores connection timezone; reset flags and readiness are mandatory',async()=>{
    const message=await tx(async c=>{await c.query("SET LOCAL TIME ZONE 'Australia/Sydney'");return issueOwnerChallenge(c,owner,'reset_pause','all');});
    await expect(tx(async c=>resetPause(c,await verifyOwnerReceipt(c,signed(message)),async()=>true,{remoteWorkerEnabled:true,entriesPaused:false}),'exclusive')).rejects.toThrow('GRID_RESET_REQUIRED');
    await tx(async c=>resetPause(c,await verifyOwnerReceipt(c,signed(message)),async()=>true,{remoteWorkerEnabled:false,entriesPaused:false}),'exclusive');
    expect((await pool.query('SELECT entries_paused FROM grid_worker_host')).rows[0].entries_paused).toBe(false);
  });
  it('two contenders: one commit and one reconciliation/send admission; MAIN refuses holder',async()=>{
    await external();let sends=0;
    const results=await Promise.allSettled([lease().acquire(randomUUID(),acceptance,async()=>{sends++;return true;}),lease().acquire(randomUUID(),acceptance,async()=>{sends++;return true;})]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(sends).toBe(1);
    await expect(tx(c=>readLegacyHost(c))).rejects.toThrow('GRID_MAIN_CONTENDER_SEEN');
    const winner=results.find(r=>r.status==='fulfilled');if(winner?.status!=='fulfilled')throw Error('EXAMPLE');
    await expect(lease().release(winner.value)).rejects.toThrow('GRID_LEASE_RELEASE_INVALID');
    await expect(lease().renew({...winner.value,localExpiresAt:0},0,true)).rejects.toThrow('GRID_LEASE_EXPIRED');
  });
  it('raw SQL without prelock refuses; legacy compatibility absent/no-host/dormant is equal',async()=>{
    await expect(pool.query('UPDATE grid_worker_host SET observer_fenced=false')).rejects.toThrow();
    const dormant=await tx(c=>readLegacyHost(c));
    await pool.query('TRUNCATE grid_worker_host');const noHost=await tx(c=>readLegacyHost(c));
    const noPackage=await fencedTransaction(admin,c=>readLegacyHost(c),{terminate});
    for(const host of [dormant,noHost,noPackage])expect(gridActionAllowed('cycle',legacyKillContext(host))).toBe(true);
    await expect(tx(c=>readLegacyHost(c,'external'))).rejects.toThrow();
  });
  it('independent incident commits survive caller rollback; ack recurrence gets new uuid',async()=>{
    const incidents=new GridIncidents(controlLane(),terminate);
    await expect(tx(async()=>{expect(await incidents.record({code:'schema_drift',dedupKey:'EXAMPLE'})).toBe(true);throw Error('EXAMPLE_ROLLBACK');})).rejects.toThrow('EXAMPLE_ROLLBACK');
    expect(await incidents.schemaDrift()).toBe(true);
    const first=(await pool.query("SELECT id FROM grid_worker_incidents WHERE dedup_key='EXAMPLE'")).rows[0].id;
    const message=await challenge('ack_critical','incident:'+first);
    await tx(async c=>acknowledgeCritical(c,await verifyOwnerReceipt(c,signed(message)),first),'exclusive');
    await incidents.record({code:'schema_drift',dedupKey:'EXAMPLE'});
    await incidents.record({code:'schema_drift',dedupKey:'EXAMPLE'});
    const rows=(await pool.query("SELECT id,occurrence_count FROM grid_worker_incidents WHERE dedup_key='EXAMPLE' ORDER BY first_seen_at")).rows;
    expect(rows).toHaveLength(2);expect(rows[1].id).not.toBe(first);expect(Number(rows[1].occurrence_count)).toBe(2);
    const unavailable=new GridIncidents({connect:async()=>{throw Error('EXAMPLE_OFFLINE');}},terminate);
    expect(await unavailable.schemaDrift()).toBe(false);expect(unavailable.queued).toHaveLength(1);
  });
  it('watchdog aborts transport destroys backend and rolls back; late pool admission never works',async()=>{
    let aborted=false,pid=0,lateWork=false;
    const began=Date.now();
    await expect(fencedTransaction(pool,async(c,d)=>{pid=(c as PoolClient&{processID:number}).processID;await new Promise<void>(resolve=>d.abort.signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));d.check();},{terminate,budget:new GridDeadline(250)})).rejects.toThrow('GRID_TRANSACTION_UNKNOWN');
    expect(aborted).toBe(true);expect(Date.now()-began).toBeLessThan(1000);
    expect((await admin.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1',[pid])).rowCount).toBe(0);
    let destroyed=false;
    const connection=latch();
    const slow={connect:async()=>{await connection.promise;const c=await pool.connect();const release=c.release.bind(c);c.release=(destroy?:boolean|Error)=>{destroyed=destroy===true;release(destroy);};return c;}};
    await expect(fencedTransaction(slow,async()=>{lateWork=true;},{terminate,budget:new GridDeadline(40)})).rejects.toThrow('GRID_TRANSACTION_UNKNOWN');
    connection.resolve();await delay(50);expect(destroyed).toBe(true);expect(lateWork).toBe(false);
  });
  it('exclusive waiter is admitted before continuous later shared load',async()=>{
    const entered=latch(),release=latch(),order:string[]=[];
    const first=tx(async()=>{entered.resolve();await release.promise;});await entered.promise;
    const exclusive=tx(async()=>{order.push('exclusive');},'exclusive');await delay(40);
    const readers=Array.from({length:5},async()=>{for(let n=0;n<20;n++)await tx(async()=>{order.push('shared');});});
    release.resolve();await Promise.all([first,exclusive,...readers]);expect(order[0]).toBe('exclusive');
  });
  it('five-second POST drains for exclusive owner pause; independent renewal and matching ack complete within20s',async()=>{
    await external();const current=await lease().acquire(randomUUID(),acceptance,async()=>true);
    const message=await challenge();const entered=latch(),start=Date.now();
    const post=tx(async()=>{entered.resolve();await delay(5000);});await entered.promise;
    const paused=tx(async c=>pauseHost(c,await verifyOwnerReceipt(c,signed(message))),'exclusive',true);
    const renewed=await lease().renew(current,50,true);
    const revision=String(await paused);await post;
    await tx(c=>acknowledgePause(c,renewed,revision),'shared');
    const row=(await pool.query('SELECT pause_revision,pause_ack_revision,heartbeat_at FROM grid_worker_host')).rows[0];
    expect(row.pause_ack_revision).toBe(row.pause_revision);expect(row.heartbeat_at).not.toBeNull();expect(Date.now()-start).toBeLessThan(20_000);
  },25_000);
  it('MAIN CPU stall exceeds45s without a worker lease; pause failure is bounded and durable',async()=>{
    const message=await challenge(),ready=latch();let workerPid=0;
    const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');const {Client}=require('pg');
      (async()=>{const c=new Client({connectionString:process.env.DATABASE_URL,options:'-c search_path='+workerData.schema+',pg_catalog'});c.on('error',()=>{});await c.connect();
      await c.query("BEGIN; SET LOCAL idle_in_transaction_session_timeout='12s'");await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",[workerData.fixtureHost]);parentPort.postMessage(c.processID);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,45500);await c.end().catch(()=>{});parentPort.postMessage('done');})().catch(()=>process.exit(1));`,{eval:true,workerData:{schema,fixtureHost}});
    const completed=new Promise<void>((resolve,reject)=>{worker.on('message',v=>{if(typeof v==='number'){workerPid=v;ready.resolve();}});worker.on('error',reject);worker.on('exit',code=>code?reject(Error('EXAMPLE_STALL_EXIT')):resolve());});
    await ready.promise;
    const start=Date.now();await expect(tx(async c=>pauseHost(c,await verifyOwnerReceipt(c,signed(message))),'exclusive',true)).rejects.toThrow();
    expect(Date.now()-start).toBeLessThan(10_000);expect(workerPid).toBeGreaterThan(0);
    const incidents=new GridIncidents(controlLane(),terminate);expect(await incidents.record({code:'pause_unacknowledged',dedupKey:'EXAMPLE_PAUSE'})).toBe(true);
    await completed;
    const host=await tx(c=>readLegacyHost(c));expect(host?.holder_boot_id).toBeNull();expect(gridActionAllowed('cycle',legacyKillContext(host))).toBe(true);
    expect((await pool.query("SELECT code FROM grid_worker_incidents")).rows.map(r=>r.code)).toEqual(['pause_unacknowledged']);
  },60_000);
  async function submittedAudit():Promise<SendAudit> {
    return tx(async c=>{
      const policy={...behaviourPolicy('repeat_all','long',false),id:randomUUID()},hmac=computeGridPolicyHmac(policy,umk());if(!hmac.ok)throw Error('EXAMPLE_POLICY');
      await walletFences(c,[owner]);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['qv:grid-worker:v3:bot:'+policy.id]);
      const {levels,sizingVersion,safetyEnvelopePrice,gridPolicyExtension,...base}=policy;
      const entries=Object.entries({...base,walletAddress:owner,clientRequestId:randomUUID(),serverIntentDigest:sha256('EXAMPLE').toString('hex').toUpperCase(),draftRevision:'EXAMPLE',createIntent:{},authoritySnapshot:{gridSizing:{sizingVersion,safetyEnvelopePrice},gridPolicyExtension},policyHmac:hmac.digest,rangeSource:'manual',chartTimeframe:'15m'});
      await c.query(`INSERT INTO grid_bots(${entries.map(([k])=>k.replace(/[A-Z]/g,ch=>'_'+ch.toLowerCase())).join(',')}) VALUES(${entries.map((_,i)=>'$'+(i+1)).join(',')})`,entries.map(([,v])=>v));
      const a:SendAudit={operationId:randomUUID(),botId:policy.id,requestIdentity:'EXAMPLE',attempt:1,kind:'limit',bootId:randomUUID(),role:'legacy',epoch:'0',generation:'0',policyDigest:sha256('EXAMPLE_POLICY').toString('hex'),requestDigest:sha256('EXAMPLE_REQUEST').toString('hex'),signedAt:Date.now(),expiresAt:Date.now()+1000};
      await c.query("INSERT INTO grid_operations(id,bot_id,idempotency_key,request_identity,type,state,submitted_at,exact_request_digest,exact_request) VALUES($1,$2,'EXAMPLE','EXAMPLE','place_level_order','submitted',clock_timestamp(),$3,$4::jsonb)",[a.operationId,a.botId,a.requestDigest,JSON.stringify({timestamp:a.signedAt,expiryMs:1000})]);
      await prepareSendAudit(c,a);return a;
    });
  }
  it('submitted unknown audit commits before POST; attribution mismatch and completion replay refuse',async()=>{
    const a=await submittedAudit();
    expect((await pool.query('SELECT outcome,authorized_at FROM grid_worker_send_audit')).rows[0]).toEqual({outcome:'unknown',authorized_at:null});
    await expect(tx(c=>authorizeSendAudit(c,{...a,generation:'1'}))).rejects.toThrow('GRID_AUDIT_ATTRIBUTION_MISMATCH');
    await tx(c=>authorizeSendAudit(c,a));
    // Simulated process loss after transport: the durable row remains unknown until reconciliation.
    expect((await pool.query('SELECT outcome FROM grid_worker_send_audit')).rows[0].outcome).toBe('unknown');
    await tx(c=>completeSendAudit(c,a.operationId,'confirmed','EXAMPLE_CONFIRMED'));
    await expect(tx(c=>completeSendAudit(c,a.operationId,'confirmed','EXAMPLE_CONFIRMED'))).rejects.toThrow('GRID_AUDIT_COMPLETION_INVALID');
  });
  it('session loss then rolling takeover waits every persisted signed window plus acceptance and5s',async()=>{
    await external();const old=await lease().acquire(randomUUID(),acceptance,async()=>true);const a=await submittedAudit();
    expect(await tx(c=>takeoverWindowsClear(c,acceptance),'exclusive')).toBe(false);
    expect(await tx(c=>takeoverWindowsClear(c,{...acceptance,verified:false}),'exclusive')).toBe(false);
    const raw=await pool.connect();raw.on('error',()=>{});await raw.query('BEGIN');await hostFence(raw,'shared');await terminate((raw as PoolClient&{processID:number}).processID);raw.release(true);
    await expect(lease().acquire(randomUUID(),acceptance,async()=>true)).rejects.toThrow();
    await delay(45_200);
    const acquired=await lease().acquire(randomUUID(),acceptance,async()=>true);expect(acquired.epoch).toBe(String(Number(old.epoch)+1));
    expect((await pool.query('SELECT outcome FROM grid_worker_send_audit WHERE operation_id=$1',[a.operationId])).rows[0].outcome).toBe('unknown');
  },60_000);
  it('wallet lists empty singleton and multiple lock identities use sorted independent scalar bindings',async()=>{
    for(const wallets of [[],[owner],['EXAMPLE_Z',owner,'EXAMPLE_A']]) await tx(c=>walletFences(c,wallets));
  });
});
