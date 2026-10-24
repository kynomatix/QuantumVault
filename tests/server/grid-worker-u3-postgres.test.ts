import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Pool,type PoolClient} from 'pg';
import {randomUUID,randomInt,randomBytes,createHash} from 'node:crypto';
import bs58 from 'bs58';
import {readFileSync} from 'node:fs';
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
  it.each([null,'0','251'])('database refuses invalid future cap %s',async cap=>{
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
