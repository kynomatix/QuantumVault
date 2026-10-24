import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Pool,type PoolClient} from 'pg';
import {randomUUID,randomInt,randomBytes,createHash} from 'node:crypto';
import bs58 from 'bs58';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';
import {drizzle} from 'drizzle-orm/node-postgres';
import * as schemaTypes from '../../shared/schema';
import {gridWorkerIsolation} from '../helpers/grid-worker-isolation';
import {fencedTransaction,walletFences} from '../../server/grid-worker/transaction';
import {identityFences} from '../../server/grid-worker/identity-locks';
import {independentLane,backendTerminator} from '../../server/grid-worker/lanes';
import {currentAuthority} from '../../server/grid-worker/authority';
import {issueStartConsent,verifyStartConsent,supersedeStartConsents,startConsentMac,storedStartConsent,type StoredStartConsent} from '../../server/grid-worker/consent';
import {walletWrite} from '../../server/grid-worker/wallet-writers';
import {GridStorage,type DraftRecord} from '../../server/grid-bot/storage';
import {GridLaunchStorage,type ExactGridRequest,type GridClaim} from '../../server/grid-bot/launch-storage';
import {GridCustody} from '../../server/grid-bot/custody';
import {policy,umk} from '../grid-bot/draft-fixtures';
import {computeGridPolicyHmac} from '../../server/grid-bot/policy-hmac';

const fixture=vi.hoisted(()=>({pool:undefined as Pool|undefined}));
vi.mock('../../server/db',()=>({get pool(){return fixture.pool;},get db(){return drizzle(fixture.pool!,{schema:schemaTypes});}}));
vi.mock('../../server/grid-worker/lanes',async importOriginal=>{
  const original=await importOriginal<typeof import('../../server/grid-worker/lanes')>();
  return {...original,independentLane:(source:Pool)=>{const lane=original.independentLane(source);return {connect:async()=>isolate(await lane.connect())};}};
});
import {DatabaseStorage} from '../../server/storage';

const schema='grid_u3_'+randomUUID().replaceAll('-',''),owner=bs58.encode(randomBytes(32)),other=bs58.encode(randomBytes(32));
const isolate=gridWorkerIsolation(),storage=new DatabaseStorage();
let admin:Pool,pool:Pool,terminate:(pid:number)=>Promise<void>;
const tx=<T>(work:(c:PoolClient)=>Promise<T>,mode:'shared'|'exclusive'='shared')=>fencedTransaction(pool,work,{mode,terminate});
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const p2Sql=readFileSync('tests/fixtures/grid-worker-p2-held.sql','utf8');
async function p2(sql=p2Sql){const c=await pool.connect();try{
  await c.query("SELECT set_config('qv.u2c_readiness',$1,false)",[JSON.stringify({published:true,incompatibleProcessesRetired:true,outsideDbFirstInstallRecord:'EXAMPLE_ISOLATED_FIXTURE',productionWalletCount:1000,measuredP2DurationMs:1})]);
  const started=Date.now();await c.query(sql);return Date.now()-started;
}catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}}
function latch(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
async function locked<T>(id:string,work:(c:PoolClient)=>Promise<T>){return tx(async c=>{await walletFences(c,[owner]);await identityFences(c,[id],[]);return work(c);});}
async function draft(wallet=owner){
  const p=launchAuthorityFixture().policy,h=computeGridPolicyHmac(p,umk());if(!h.ok)throw Error('EXAMPLE_POLICY');
  const {levels,...base}=p;
  const bot:DraftRecord={...base,walletAddress:wallet,clientRequestId:randomUUID(),serverIntentDigest:createHash('sha256').update('EXAMPLE_INTENT').digest('hex').toUpperCase(),draftRevision:'EXAMPLE revision',
    createIntent:{},authoritySnapshot:{},policyHmac:h.digest,name:'EXAMPLE',rangeSource:'manual',chartTimeframe:'1h'};
  await new GridStorage(pool,async()=>{}).createDraftWithLevels(bot,levels);return bot;
}
async function arm(){await tx(async c=>{
  await walletFences(c,(await c.query('SELECT address FROM wallets')).rows.map(r=>r.address));
  await c.query('INSERT INTO grid_worker_wallet_authority(wallet_address) SELECT address FROM wallets');
  await c.query("SET LOCAL qv.grid_worker_action='bootstrap_tracking'");
  await c.query('UPDATE grid_worker_host SET authority_tracking_enabled=true');
},'exclusive');}
const intent=(b:DraftRecord)=>({owner:b.walletAddress,botId:b.id,draftRevision:b.draftRevision,serverIntentDigest:b.serverIntentDigest.toLowerCase(),
  policyHmac:b.policyHmac.toLowerCase(),spendingPolicyDigest:'0'.repeat(64),requestKey:randomUUID()});
beforeAll(async()=>{
  const url=process.env.DATABASE_URL;if(!url||new URL(url).pathname!=='/qvtest')throw Error('FRACTAL qvtest required');
  admin=new Pool({connectionString:url,max:1});await admin.query('CREATE SCHEMA '+schema);
  pool=new Pool({connectionString:url,max:8,options:'-c search_path='+schema+',pg_catalog'});fixture.pool=pool;
  pool.on('connect',c=>{isolate(c);c.on('error',()=>{});});pool.on('error',()=>{});
  const lane=independentLane(pool);terminate=backendTerminator(lane);
  const tables=(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename !~ '^grid_worker_' AND tablename<>'owner_action_receipts'")).rows;
  for(const {tablename} of tables){if(!/^[a-z0-9_]+$/.test(tablename))throw Error('EXAMPLE_TABLE');await pool.query(`CREATE TABLE ${tablename} (LIKE public.${tablename} INCLUDING ALL)`);}
  await pool.query(`CREATE SEQUENCE fixture_pool_seq START ${randomInt(1_000_000,1_500_000_000)} OWNED BY protocol_subaccounts.id; ALTER TABLE protocol_subaccounts ALTER COLUMN id SET DEFAULT nextval('fixture_pool_seq')`);
  await pool.query(readFileSync('migrations/grid_worker_v3_owner.sql','utf8').replaceAll('SET search_path = pg_catalog, public','SET search_path = pg_catalog, '+schema));
},60_000);
beforeEach(async()=>{
  await pool.query('TRUNCATE grid_worker_host,grid_worker_owner,grid_worker_wallet_authority,grid_worker_requests,grid_worker_reservations,grid_worker_send_audit,grid_bots,grid_launch_accounts,protocol_subaccounts,wallets CASCADE');
  for(const address of [owner,other])await storage.createWallet({address,agentPublicKey:'EXAMPLE_MASTER',executionEnabled:true,
    umkEncryptedForExecution:'EXAMPLE',agentPrivateKeyEncryptedV3:'EXAMPLE',umkVersion:3});
  await tx(async c=>{
    await c.query('INSERT INTO grid_worker_owner(wallet_address) VALUES($1)',[owner]);
    await c.query("INSERT INTO grid_worker_host(protocol_version,owner_wallet) VALUES('grid-worker-v3-a1-wire1',$1)",[owner]);
  },'exclusive');
});
afterAll(async()=>{await pool?.end();if(admin){await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();}},30_000);


import {MainStartRequests,WorkerStartRequests,verifyAdmittedStart,releaseTerminalReservation} from '../../server/grid-worker/requests';
import {localContext,tightenHost,clearObserver} from '../../server/grid-worker/host';
import {GridWorkerLease} from '../../server/grid-worker/lease';
import {GridIncidents} from '../../server/grid-worker/incidents';
import {launchAuthorityFixture,clock} from '../grid-bot/launch-authority-fixtures';
import type {SpendingFacts} from '../../server/grid-worker/spending';
import {aggregateReservationFence,AGGREGATE_RESERVATION_IDENTITY} from '../../server/grid-worker/spending';
const main=()=>new MainStartRequests(pool,terminate);
const worker=()=>new WorkerStartRequests(pool,terminate,new GridIncidents(independentLane(pool),terminate));
const confirm=async(b:DraftRecord)=>{
  const result=await main().confirm(b.walletAddress,b.id,{confirmed:true,requestKey:randomUUID(),draftRevision:b.draftRevision,serverIntentDigest:b.serverIntentDigest},umk());
  return (await pool.query('SELECT id FROM grid_worker_requests WHERE request_key=$1',[result.requestKey])).rows[0].id as string;
};
async function external(ceiling:string|null=null){
  await arm();
  await tx(async c=>{
    await localContext(c,'transition');
    await c.query("SELECT set_config('qv.grid_worker_owner_verified','true',true),set_config('qv.grid_worker_ready','true',true)");
    const fixtureSha256=createHash('sha256').update('EXAMPLE_BUILD').digest('hex');
    await c.query(`UPDATE grid_worker_host SET execution_mode='external',run_mode='trading',execution_enabled=true,
      legacy_controls_enabled=true,commit_hash=$1,tree_hash=$1,lockfile_sha256=$2,global_ceiling_usd=$3,
      scope_revision=scope_revision+CASE WHEN global_ceiling_usd IS DISTINCT FROM $3::numeric THEN 1 ELSE 0 END`,[fixtureSha256.slice(0,40),fixtureSha256,ceiling]);
    await c.query("SELECT set_config('qv.grid_worker_deployment_flags_clear','true',true)");
    await localContext(c,'reset');
    await c.query('UPDATE grid_worker_host SET entries_paused=false,pause_revision=pause_revision+1,pause_ack_at=NULL,pause_ack_revision=NULL WHERE entries_paused');
  },'exclusive');
  const lease=new GridWorkerLease(pool,independentLane(pool),terminate,async()=>true);
  const holder=await lease.acquire(randomUUID(),{verified:true,milliseconds:0,skewMs:50},async()=>true);
  await lease.renew(holder,50,true,true);
  await tx(c=>clearObserver(c,holder,async()=>true),'exclusive');
  return holder;
}
async function launchFacts():Promise<import('../../server/grid-bot/launch-preflight').LaunchFacts>{
  const f=launchAuthorityFixture(),now=Date.now();
  f.raw.master.updated_at=now;f.raw.sub.updated_at=now;f.raw.book.t=now;
  vi.mocked(f.deps.sol).mockResolvedValue({balance:'0.1',observedAt:now});
  // Generate fresh fee quotes and their digests together; never rewrite signed timestamps.
  const facts=await f.authority.observe(f.account.wallet,f.policy,null,umk());
  return {...facts,agentGeneration:{wallet:owner,masterAccount:'EXAMPLE_MASTER',umkVersion:3}};
}
const spending=(patch:Partial<SpendingFacts>={}):SpendingFacts=>({observedAt:Date.now(),complete:true,quoteDecimals:2,positionNotional:'0',orders:[],entries:[],feeReserve:'0',fundingReserve:'0',remainingSlippageReserve:'0',uncertainTransfers:[],...patch});
describe('U3 PostgreSQL admission and spending',()=>{
  it.each(['forged','superseded','stale scope','stale generation','wrong version','replayed'].flatMap(kind=>['pending','admitted'].map(state=>({kind,state}))))('refuses $kind retained consent at $state boundary',async({kind,state})=>{
    const b=await draft(),holder=await external(),id=await confirm(b);
    if(state==='admitted')await worker().admit(id,holder,umk(),await launchFacts(),spending());
    await tx(async c=>{
      await walletFences(c,[owner]);await identityFences(c,[b.id],[]);
      const r=(await c.query('SELECT * FROM grid_worker_requests WHERE id=$1 FOR UPDATE',[id])).rows[0];
      const value=storedStartConsent(r);
      if(kind==='stale scope')value.consent.scopeRevision=String(Number(value.consent.scopeRevision)+1);
      if(kind==='stale generation')value.consent.walletGeneration=String(Number(value.consent.walletGeneration)+1);
      const mac=kind==='forged'?createHash('sha256').update('EXAMPLE_FORGED').digest('hex'):startConsentMac(value.consent,umk());
      await c.query(`UPDATE grid_worker_requests SET consent_mac=$2,scope_revision=$3,wallet_generation=$4,consent_version=$5,state=$6,
        completed_at=CASE WHEN $6 IN ('superseded','complete') THEN clock_timestamp() ELSE NULL END WHERE id=$1`,
        [id,mac,value.consent.scopeRevision,value.consent.walletGeneration,kind==='wrong version'?'EXAMPLE_WRONG_VERSION':value.consent.consentVersion,
          kind==='superseded'?'superseded':kind==='replayed'?'complete':state]);
    });
    if(state==='pending'){
      await expect(worker().admit(id,holder,umk(),await launchFacts(),spending())).rejects.toThrow();
      expect((await pool.query('SELECT count(*)::int AS n FROM grid_worker_reservations')).rows[0].n).toBe(0);
      expect((await pool.query("SELECT count(*)::int AS n FROM grid_worker_incidents WHERE code='authority_refused'")).rows[0].n).toBeGreaterThan(0);
    }else await expect(tx(c=>verifyAdmittedStart(c,id,holder,umk()))).rejects.toThrow();
  });
  it.each(['pending','admitted'])('expiry blocks first admission only: %s',async state=>{
    const b=await draft(),holder=await external(),id=await confirm(b);
    if(state==='admitted')await worker().admit(id,holder,umk(),await launchFacts(),spending());
    await tx(async c=>{
      await walletFences(c,[owner]);await identityFences(c,[b.id],[]);
      const value=storedStartConsent((await c.query('SELECT * FROM grid_worker_requests WHERE id=$1 FOR UPDATE',[id])).rows[0]);
      const now=Date.now();value.consent.issuedAt=new Date(now-2000).toISOString();value.consent.expiresAt=new Date(now-1000).toISOString();
      await c.query('UPDATE grid_worker_requests SET issued_at=$2,expires_at=$3,consent_mac=$4 WHERE id=$1',[id,value.consent.issuedAt,value.consent.expiresAt,startConsentMac(value.consent,umk())]);
    });
    if(state==='pending')await expect(worker().admit(id,holder,umk(),await launchFacts(),spending())).rejects.toThrow();
    else await tx(c=>verifyAdmittedStart(c,id,holder,umk()));
  });
  it('queues only explicit owner confirmation, recovers exact keys, and MAIN never reserves',async()=>{
    const bot=await draft(),outsider=await draft(other);await external();
    const input={confirmed:true as const,requestKey:randomUUID(),draftRevision:bot.draftRevision,serverIntentDigest:bot.serverIntentDigest};
    await expect(main().confirm(owner,bot.id,{...input,confirmed:false as true},umk())).rejects.toThrow();
    await expect(main().confirm(other,outsider.id,input,umk())).rejects.toThrow();
    const first=await main().confirm(owner,bot.id,input,umk());expect(first.state).toBe('pending');
    expect(await main().confirm(owner,bot.id,input,umk())).toEqual(first);
    expect(await main().recover(owner,bot.id,input.requestKey)).toEqual(first);
    await expect(main().confirm(owner,bot.id,{...input,draftRevision:'EXAMPLE_CHANGED'},umk())).rejects.toThrow();
    expect(await main().states(owner,[])).toEqual({});expect(Object.keys(await main().states(owner,[bot.id]))).toEqual([bot.id]);expect(Object.keys(await main().states(owner,[bot.id,outsider.id]))).toEqual([bot.id]);
    expect((await pool.query('SELECT count(*)::int AS n FROM grid_worker_reservations')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT active_request FROM grid_lifecycle WHERE bot_id=$1',[bot.id])).rows.every(r=>r.active_request===null)).toBe(true);
  });
  it('concurrent separate connections commit exactly two reservations at the global boundary; loser retry never adds one',async()=>{
    const bots=await Promise.all(Array.from({length:4},()=>draft()));const holder=await external('400');
    const ids=await Promise.all(bots.map(confirm)),facts=await launchFacts(),started=Date.now();
    const results=await Promise.allSettled(ids.map(id=>worker().admit(id,holder,umk(),facts,spending())));
    const wins=results.flatMap((r,i)=>r.status==='fulfilled'?[i]:[]),losers=results.flatMap((r,i)=>r.status==='rejected'?[i]:[]);
    expect(wins).toHaveLength(2);expect(losers).toHaveLength(2);expect(Date.now()-started).toBeLessThan(12000);
    expect((await pool.query('SELECT count(*)::int AS n,sum(reserve_usd)::text AS total FROM grid_worker_reservations')).rows[0]).toEqual({n:2,total:'400'});
    await worker().admit(ids[wins[0]],holder,umk(),await launchFacts(),spending());
    await expect(worker().admit(ids[losers[0]],holder,umk(),await launchFacts(),spending())).rejects.toThrow();
    expect((await pool.query('SELECT count(*)::int AS n FROM grid_worker_reservations')).rows[0].n).toBe(2);
    console.info(JSON.stringify({case:'cap-boundary',committed:wins,losingTransactions:losers,deadlineMs:12000,retry:'winner idempotent; loser refused'}));
  });
  it('retains uncertain cash, raises exposure warning, and freezes final entry without closing',async()=>{
    const b=await draft(),holder=await external(),id=await confirm(b);
    await worker().admit(id,holder,umk(),await launchFacts(),spending({uncertainTransfers:[{operationId:'EXAMPLE_TRANSFER',amount:'100'}]}));
    expect((await pool.query('SELECT state,cash_commitment_usd::text AS cash FROM grid_worker_reservations')).rows[0]).toEqual({state:'uncertain',cash:'200'});
    await worker().refresh(id,holder,spending({positionNotional:'201',uncertainTransfers:[{operationId:'EXAMPLE_TRANSFER',amount:'100'}]}));
    await expect(tx(c=>verifyAdmittedStart(c,id,holder,umk()))).rejects.toThrow();
    expect((await pool.query("SELECT severity FROM grid_worker_incidents WHERE code='exposure_above_budget'")).rows[0]?.severity).toBe('warning');
    expect((await pool.query('SELECT status FROM grid_bots WHERE id=$1',[b.id])).rows[0].status).toBe('draft');
    await expect(tx(c=>releaseTerminalReservation(c,id,holder))).rejects.toThrow();
    expect((await pool.query('SELECT state FROM grid_worker_reservations')).rows[0].state).toBe('uncertain');
  });
  it('revocation after committed admission refuses custody/final send, including an exact retry',async()=>{
    const b=await draft(),holder=await external(),id=await confirm(b);await worker().admit(id,holder,umk(),await launchFacts(),spending());
    await tx(c=>verifyAdmittedStart(c,id,holder,umk()));
    await storage.updateWalletAgentIdentityV3(owner,'EXAMPLE_NEW_MASTER','EXAMPLE_NEW');
    await expect(tx(c=>verifyAdmittedStart(c,id,holder,umk()))).rejects.toThrow();
    await expect(worker().admit(id,holder,umk(),await launchFacts(),spending())).rejects.toThrow();
  });
  it('pause/observer fence refusals are plain words and do not reserve',async()=>{
    const b=await draft();await external();await tx(c=>tightenHost(c,{pause:true}),'exclusive');
    await expect(confirm(b)).rejects.toThrow('New entries are paused');
    expect((await pool.query('SELECT count(*)::int AS n FROM grid_worker_reservations')).rows[0].n).toBe(0);
  });
  it('refuses expanded scope at MAIN, consumption and final authority even with valid caps',async()=>{
    const b=await draft(),holder=await external(),id=await confirm(b);await worker().admit(id,holder,umk(),await launchFacts(),spending());
    await tx(async c=>{
      // Fixture-only future state; U3 has no widening consumer. Constraints remain enabled.
      await c.query('ALTER TABLE grid_worker_host DISABLE TRIGGER USER');
      await c.query("UPDATE grid_worker_host SET start_scope='expanded',per_bot_cap_usd=250,global_ceiling_usd=1000");
      await c.query('ALTER TABLE grid_worker_host ENABLE TRIGGER USER');
    },'exclusive');
    await expect(confirm(b)).rejects.toThrow();
    await expect(worker().admit(id,holder,umk(),await launchFacts(),spending())).rejects.toThrow();
    await expect(tx(c=>verifyAdmittedStart(c,id,holder,umk()))).rejects.toThrow();
  });
  it.each([null,'-1','0','251'])('database refuses invalid future cap %s',async cap=>{
    await external();await expect(tx(async c=>{
      await c.query('ALTER TABLE grid_worker_host DISABLE TRIGGER USER');
      await c.query("UPDATE grid_worker_host SET start_scope='expanded',per_bot_cap_usd=$1,global_ceiling_usd=1000",[cap]);
    },'exclusive')).rejects.toThrow();
  });
  it('aggregate identity is transaction-scoped and distinct from every fixture lock family',async()=>{
    await tx(async c=>{
      await aggregateReservationFence(c);
      const keys=[AGGREGATE_RESERVATION_IDENTITY,'qv:grid-worker:v3:host','qv:grid-worker:v3:wallet:'+owner,'qv:grid-worker:v3:bot:'+randomUUID(),'qv:grid-worker:v3:pool:1'];
      const rows=(await c.query('SELECT hashtextextended(value,0)::text AS lock_hash FROM jsonb_array_elements_text($1::jsonb)',[JSON.stringify(keys)])).rows;
      expect(new Set(rows.map(r=>r.lock_hash)).size).toBe(keys.length);
    });
  });
});


import {WorkerQuota} from '../../server/grid-worker/quota';
describe('U4 shared quota and rolling windows',()=>{
  beforeEach(async()=>{await pool.query('TRUNCATE grid_worker_quota_windows,grid_worker_quota_policy');});
  const quotaPolicy=async()=>{await pool.query(`INSERT INTO grid_worker_quota_policy
    (provider,domain_id,window_ms,total_units,worker_limit_units,worker_protective_reserve_units,policy_digest,valid_until)
    VALUES('pacifica_rest','deployment',60000,1000,600,120,$1,clock_timestamp()+interval '5 minutes')`,[createHash('sha256').update('EXAMPLE_U4_QUOTA').digest('hex')]);};
  it('serializes independent connections and retains a protective reserve',async()=>{
    await quotaPolicy();const a=new WorkerQuota(pool,terminate),b=new WorkerQuota(pool,terminate);
    const outcomes=await Promise.allSettled(Array.from({length:8},(_,i)=>(i%2?a:b).debit('pacifica_rest',120)));
    expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(4);
    expect(Number((await pool.query('SELECT sum(worker_used_units) AS used FROM grid_worker_quota_windows')).rows[0].used)).toBe(480);
    await a.debit('pacifica_rest',120,true);await expect(b.debit('pacifica_rest',1,true)).rejects.toThrow('GRID_QUOTA_UNAVAILABLE');
  });
  it('shares the ordinary allocation between two operating-system processes',async()=>{
    await quotaPolicy();const dir=mkdtempSync(join(process.cwd(),'.u4-quota-')),file=join(dir,'child.cjs');
    try{
      await build({stdin:{contents:`import {Pool} from 'pg';import {WorkerQuota} from './server/grid-worker/quota';
        const pool=new Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+process.argv[2]+',pg_catalog',max:2});
        const q=new WorkerQuota(pool,async pid=>{await pool.query('SELECT pg_terminate_backend($1)',[pid]);});
        (async()=>{let passed=0;try{for(let i=0;i<4;i++){try{await q.debit('pacifica_rest',120);passed++;}catch(e){if(e.message!=='GRID_QUOTA_UNAVAILABLE')throw e;}}
        process.stdout.write(String(passed));}finally{await pool.end();}})().catch(()=>{process.exitCode=1;});`,resolveDir:process.cwd(),loader:'ts'},outfile:file,bundle:true,packages:'external',platform:'node',format:'cjs',logLevel:'silent'});
      const run=()=>new Promise<number>((resolve,reject)=>{const child=spawn(process.execPath,[file,schema],{stdio:['ignore','pipe','pipe']});let out='';
        child.stdout.on('data',b=>{out+=String(b);});child.on('error',reject);child.on('exit',code=>code===0&&/^[0-4]$/.test(out)?resolve(Number(out)):reject(Error('EXAMPLE_CHILD_FAILED')));});
      expect((await Promise.all([run(),run()])).reduce((a,b)=>a+b,0)).toBe(4);
      expect(Number((await pool.query('SELECT sum(worker_used_units) AS used FROM grid_worker_quota_windows')).rows[0].used)).toBe(480);
    }finally{rmSync(dir,{recursive:true,force:true});}
  },30000);
  it('counts previous buckets and refuses backoff, absent and expired policies',async()=>{
    const q=new WorkerQuota(pool,terminate);await expect(q.debit('pacifica_rest',120)).rejects.toThrow();
    await quotaPolicy();await q.debit('pacifica_rest',480);
    await pool.query("UPDATE grid_worker_quota_windows SET window_start=window_start-interval '60 seconds'");
    await expect(q.debit('pacifica_rest',120)).rejects.toThrow();
    await q.rateLimited('pacifica_rest');await expect(q.debit('pacifica_rest',1,true)).rejects.toThrow();
    await pool.query("UPDATE grid_worker_quota_policy SET valid_until=clock_timestamp()-interval '1 second'");
    await expect(q.debit('pacifica_rest',1,true)).rejects.toThrow();
  });
});

import {startWorkerRuntime} from '../../server/grid-worker/runtime';
// Runtime orchestration uses the real isolated PostgreSQL schema. Full readiness and
// emitted identity checks are independently exercised by the U1/U2a build suites.
vi.mock('../../server/grid-worker/boot',()=>({probeGridWorkerSchema:async()=>({})}));
vi.mock('../../server/grid-worker/build-identity',()=>({identityMatches:vi.fn(()=>true),workerBuildIdentity:{commitHash:'EXAMPLE'}}));
import {identityMatches} from '../../server/grid-worker/build-identity';
describe('U4 PostgreSQL supervisor lifecycle',()=>{
  beforeEach(async()=>{vi.mocked(identityMatches).mockReturnValue(true);await pool.query('TRUNCATE grid_worker_incidents');});
  const factory=()=>({pool,connect:()=>pool.connect(),close:async()=>{}});
  it('legacy standby keeps HTTP alive and never obtains a holder',async()=>{
    const fatal=vi.fn(),runtime=await startWorkerRuntime({PORT:'0',GRID_REMOTE_WORKER_ENABLED:'true'},factory,fatal);
    try{expect(runtime.status().standby).toBe(true);expect(runtime.status().inControl).toBe(false);
      expect((await pool.query('SELECT holder_boot_id FROM grid_worker_host')).rows[0].holder_boot_id).toBeNull();expect(fatal).not.toHaveBeenCalled();}
    finally{await runtime.stop();}
  });
  it.each(['lease','identity'] as const)('external test mode renews with zero money then self-fences on %s loss',async loss=>{
    await arm();await tx(async c=>{await localContext(c,'transition');
      await c.query("SELECT set_config('qv.grid_worker_owner_verified','true',true),set_config('qv.grid_worker_ready','true',true)");
      const fixtureSha256=createHash('sha256').update('EXAMPLE_RUNTIME_BUILD').digest('hex');
      await c.query("UPDATE grid_worker_host SET execution_mode='external',run_mode='test',execution_enabled=false,legacy_controls_enabled=true,commit_hash=$1,tree_hash=$1,lockfile_sha256=$2",[fixtureSha256.slice(0,40),fixtureSha256]);
    },'exclusive');
    const fatal=vi.fn(),fetcher=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('EXAMPLE_UNEXPECTED_EGRESS'));
    const before=Number((await pool.query('SELECT count(*) AS n FROM grid_risk_events')).rows[0].n);
    const runtime=await startWorkerRuntime({PORT:'0',GRID_REMOTE_WORKER_ENABLED:'true'},factory,fatal);
    try{expect(runtime.status().inControl).toBe(true);expect(runtime.status().test).toBe(true);
      await delay(16000);expect(runtime.status().passAt).not.toBeNull();expect(fatal).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();
      expect(Number((await pool.query('SELECT count(*) AS n FROM grid_risk_events')).rows[0].n)).toBe(before);
      expect(Number((await pool.query('SELECT count(*) AS n FROM grid_worker_send_audit')).rows[0].n)).toBe(0);
      expect(Number((await pool.query('SELECT count(*) AS n FROM grid_operations')).rows[0].n)).toBe(0);
      if(loss==='identity')vi.mocked(identityMatches).mockReturnValue(false);
      else await tx(async c=>{await c.query('ALTER TABLE grid_worker_host DISABLE TRIGGER USER');
        await c.query("UPDATE grid_worker_host SET lease_expires_at=clock_timestamp()-interval '1 second'");
        await c.query('ALTER TABLE grid_worker_host ENABLE TRIGGER USER');},'exclusive');
      await delay(5500);expect(fatal).toHaveBeenCalledOnce();expect(runtime.status().inControl).toBe(false);
      expect((await pool.query("SELECT code FROM grid_worker_incidents WHERE code=$1",[loss==='identity'?'schema_drift':'lease_lost'])).rowCount).toBe(1);
      expect(fetcher).not.toHaveBeenCalled();
    }finally{await runtime.stop();fetcher.mockRestore();vi.mocked(identityMatches).mockReturnValue(true);}
    const host=(await pool.query('SELECT holder_boot_id,drain_requested FROM grid_worker_host')).rows[0];
    expect(host.holder_boot_id).toBeNull();expect(host.drain_requested).toBe(false);
  },80000);
});
