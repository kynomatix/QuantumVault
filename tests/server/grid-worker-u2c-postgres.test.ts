import { makeLifecycleFenceFixture } from '../helpers/close-lifecycle-fence';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Pool,type PoolClient} from 'pg';
import {randomUUID,randomInt,randomBytes} from 'node:crypto';
import bs58 from 'bs58';
import {readFileSync} from 'node:fs';
import {drizzle} from 'drizzle-orm/node-postgres';
import * as schemaTypes from '../../shared/schema';
import {gridWorkerIsolation} from '../helpers/grid-worker-isolation';
import {fencedTransaction,walletFences} from '../../server/grid-worker/transaction';
import {identityFences} from '../../server/grid-worker/identity-locks';
import {independentLane,backendTerminator} from '../../server/grid-worker/lanes';
import {currentAuthority} from '../../server/grid-worker/authority';
import {issueStartConsent,verifyStartConsent,supersedeStartConsents,startConsentMac,type StoredStartConsent} from '../../server/grid-worker/consent';
import {walletWrite} from '../../server/grid-worker/wallet-writers';
import {GridStorage,type DraftRecord} from '../../server/grid-bot/storage';
import {GridLaunchStorage,type ExactGridRequest,type GridClaim} from '../../server/grid-bot/launch-storage';
import {GridCustody} from '../../server/grid-bot/custody';
import {policy,umk} from '../grid-bot/draft-fixtures';
import {computeGridPolicyHmac} from '../../server/grid-bot/policy-hmac';

const fixture=vi.hoisted(()=>({pool:undefined as Pool|undefined}));
vi.mock('../../server/trading/close-intent-store', async () => { const { makeLifecycleFenceFixture } = await import('../helpers/close-lifecycle-fence'); return { closeIntentStore: makeLifecycleFenceFixture() }; });
vi.mock('../../server/db',()=>({get pool(){return fixture.pool;},get db(){return drizzle(fixture.pool!,{schema:schemaTypes});}}));
vi.mock('../../server/grid-worker/lanes',async importOriginal=>{
  const original=await importOriginal<typeof import('../../server/grid-worker/lanes')>();
  return {...original,independentLane:(source:Pool)=>{const lane=original.independentLane(source);return {connect:async()=>isolate(await lane.connect())};}};
});
import {DatabaseStorage} from '../../server/storage';

const schema='grid_u2c_'+randomUUID().replaceAll('-',''),owner=bs58.encode(randomBytes(32)),other=bs58.encode(randomBytes(32));
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
  const p=policy(),h=computeGridPolicyHmac(p,umk());if(!h.ok)throw Error('EXAMPLE_POLICY');
  const {levels,...base}=p;
  const bot:DraftRecord={...base,walletAddress:wallet,clientRequestId:randomUUID(),serverIntentDigest:'A'.repeat(64),draftRevision:'EXAMPLE revision',
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

describe('U2c PostgreSQL authority and consent',()=>{
  it('armed storage writers commit, supersede pending consent, and preserve resync CAS',async()=>{
    await arm();const bot=await draft(),request=intent(bot);
    const consent=await locked(bot.id,c=>issueStartConsent(c,request,umk()));
    await storage.updateWalletAgentIdentityV3(owner,'EXAMPLE_MASTER','EXAMPLE_NEW');
    expect((await pool.query('SELECT state FROM grid_worker_requests WHERE id=$1',[consent.id])).rows[0].state).toBe('superseded');
    await storage.updateWalletAgentKeys(owner,'EXAMPLE_MASTER','EXAMPLE_LEGACY');
    await storage.updateWalletAgentKeyV3(owner,'EXAMPLE_V3');
    await storage.updateWalletSecurityV3(owner,{userSalt:'EXAMPLE',encryptedUserMasterKey:'EXAMPLE',umkVersion:3});
    expect(await storage.initWalletUmkIfAbsent(owner,'EXAMPLE_OTHER','EXAMPLE_OTHER')).toBe(false);
    await storage.setHandsOffApproved('EXAMPLE_'+randomUUID(),true);
    expect(await storage.resyncWalletExecutionUmk(owner,'EXAMPLE_RESYNC')).toBe(true);
    await storage.updateWalletExecution(owner,{executionEnabled:false,umkEncryptedForExecution:null,executionExpiresAt:null});
    expect(await storage.resyncWalletExecutionUmk(owner,'EXAMPLE_NO_RESURRECTION')).toBe(false);
    await expect(storage.updateWallet(owner,{agentPublicKey:'EXAMPLE_BYPASS'})).rejects.toThrow('GRID_FENCED_WALLET_WRITER_REQUIRED');
    await expect(pool.query("UPDATE wallets SET execution_enabled=true WHERE address=$1",[owner])).rejects.toThrow('PRELOCK');
    await expect(tx(async c=>{await walletFences(c,[owner]);await c.query('DELETE FROM grid_worker_wallet_authority WHERE wallet_address=$1',[owner]);})).rejects.toThrow('GRID_AUTHORITY_HISTORY_DELETE_REFUSED');
  });
  it('exact request retry is retained, altered retry conflicts, terminal replay refuses',async()=>{
    await arm();const b=await draft(),i=intent(b);
    const a=await locked(b.id,c=>issueStartConsent(c,i,umk()));
    expect(await locked(b.id,c=>issueStartConsent(c,i,umk()))).toEqual(a);
    await expect(locked(b.id,c=>issueStartConsent(c,{...i,draftRevision:'EXAMPLE changed'},umk()))).rejects.toThrow('GRID_CONSENT_REQUEST_CONFLICT');
    await locked(b.id,c=>verifyStartConsent(c,a,umk(),['pending']));
    await locked(b.id,c=>supersedeStartConsents(c,owner,[], 'stop'));
    expect(await locked(b.id,c=>supersedeStartConsents(c,owner,[b.id],'stop'))).toBe(1);
    await expect(locked(b.id,c=>verifyStartConsent(c,a,umk(),['pending']))).rejects.toThrow('GRID_CONSENT_REPLAY');
  });
  it('refuses forged MAC, DB expiry, future issue time, wrong owner and changed generation',async()=>{
    await arm();const b=await draft(),a=await locked(b.id,c=>issueStartConsent(c,intent(b),umk()));
    await expect(locked(b.id,c=>verifyStartConsent(c,{...a,consentMac:'0'.repeat(64)},umk(),['pending']))).rejects.toThrow('GRID_CONSENT_MAC');
    const alterClock=async(offset:number)=>locked(b.id,async c=>{
      const now=new Date((await c.query('SELECT clock_timestamp() AS now')).rows[0].now).getTime();
      const consent={...a.consent,issuedAt:new Date(now+offset).toISOString(),expiresAt:new Date(now+offset+1000).toISOString()};
      const value:StoredStartConsent={...a,consent,consentMac:startConsentMac(consent,umk())};
      await c.query('UPDATE grid_worker_requests SET issued_at=$2,expires_at=$3,consent_mac=$4 WHERE id=$1',[a.id,consent.issuedAt,consent.expiresAt,value.consentMac]);return value;
    });
    for(const offset of [-10_000,10_000]){const value=await alterClock(offset);await expect(locked(b.id,c=>verifyStartConsent(c,value,umk(),['pending']))).rejects.toThrow('GRID_CONSENT_EXPIRED');}
    const otherBot=await draft(other);
    await expect(tx(async c=>{await walletFences(c,[other]);await identityFences(c,[otherBot.id],[]);return issueStartConsent(c,intent(otherBot),umk());})).rejects.toThrow('GRID_OWNER_SCOPE_REFUSED');
    await storage.updateWalletAgentKeyV3(owner,'EXAMPLE_NEW');
    await expect(locked(b.id,c=>verifyStartConsent(c,a,umk(),['pending']))).rejects.toThrow();
  });
  it.each(['revoke','emergency'] as const)('%s waits behind a five-second protected send, commits, then refuses the next authority check',async kind=>{
    await arm();const b=await draft(),entered=latch();
    const send=locked(b.id,async c=>{await currentAuthority(c,{botId:b.id,wallet:owner,masterAccount:'EXAMPLE_MASTER',requirePool:false});entered.resolve();await delay(5000);});
    await entered.promise;const start=Date.now();
    const revoke=kind==='revoke'?storage.atomicRevokeExecutionAndPauseBots(owner,'EXAMPLE'):
      storage.updateWalletEmergencyStop(owner,{executionEnabled:false,umkEncryptedForExecution:null,executionExpiresAt:null,emergencyStopTriggered:true,emergencyStopAt:new Date(),emergencyStopBy:'EXAMPLE'});
    await Promise.all([send,revoke]);expect(Date.now()-start).toBeGreaterThanOrEqual(4800);expect(Date.now()-start).toBeLessThan(20_000);
    await expect(locked(b.id,c=>currentAuthority(c,{botId:b.id,wallet:owner,masterAccount:'EXAMPLE_MASTER',requirePool:false}))).rejects.toThrow('GRID_CURRENT_AUTHORITY_INVALID');
  },25_000);
  it('opposite caller wallet orders serialize without deadlock; committed master reset refuses stale master',async()=>{
    await arm();const b=await draft();
    await Promise.all([walletWrite(pool,[owner,other],async()=>{}),walletWrite(pool,[other,owner],async()=>{})]);
    await storage.updateWalletAgentIdentityV3(owner,'EXAMPLE_REPLACEMENT','EXAMPLE');
    await expect(locked(b.id,c=>currentAuthority(c,{botId:b.id,wallet:owner,masterAccount:'EXAMPLE_MASTER',requirePool:false}))).rejects.toThrow('GRID_CURRENT_AUTHORITY_INVALID');
  });
  it('non-owner legacy grants pass without applying the worker owner restriction',async()=>{
    await arm();const b=await draft(other);
    await tx(async c=>{await walletFences(c,[other]);await identityFences(c,[b.id],[]);
      const a=await currentAuthority(c,{botId:b.id,wallet:other,masterAccount:'EXAMPLE_MASTER',requirePool:false});expect(a.generation).toBe('0');
      await expect(currentAuthority(c,{botId:b.id,wallet:other,masterAccount:'EXAMPLE_MASTER',requirePool:false,workerExposure:true})).rejects.toThrow('GRID_OWNER_SCOPE_REFUSED');});
  });
  it.each(['revoke','emergency','resync','grant'] as const)('actual sendOwned POST holds authority for five seconds before %s commits',async kind=>{
    await arm();const b=await draft(),s=new GridLaunchStorage(pool,async()=>{}),custody=new GridCustody(s);
    const account=await custody.reserve({botId:b.id,wallet:owner,masterAccount:'EXAMPLE_MASTER',policyHmac:b.policyHmac},umk());
    const now=Date.now(),request:ExactGridRequest={kind:'fund',botId:b.id,account:account.account,masterAccount:account.masterAccount,
      path:'/account/subaccount/transfer',operationType:'transfer_funds',timestamp:now,expiryMs:15_000,data:{to_account:account.account,amount:'100',idempotency_key:randomUUID()},authority:{}};
    const claim:GridClaim={credits:'10',slots:0,canaryIncrement:'0',observedCredits:'300',availableSlots:100,observedAt:now,expiresAt:now+5000};
    const op=await s.prepare('EXAMPLE_'+randomUUID(),request,claim,account.leaseToken);expect(await s.submit(op,account.leaseToken)).toBe(true);
    const entered=latch();let posts=0;
    const sending=s.sendOwned(request,account.leaseToken,async()=>{posts++;entered.resolve();await delay(5000);return 'EXAMPLE_POST_COMPLETE';});
    // Propagate setup failures instead of leaving the latch pending.
    await Promise.race([entered.promise,sending]);expect(posts).toBe(1);const started=Date.now();
    const tightening=kind==='revoke'?storage.atomicRevokeExecutionAndPauseBots(owner,'EXAMPLE'):
      kind==='resync'?storage.resyncWalletExecutionUmk(owner,'EXAMPLE_RESYNC'):
      kind==='grant'?storage.updateWalletExecution(owner,{executionEnabled:true,umkEncryptedForExecution:'EXAMPLE_GRANT',executionExpiresAt:null}):
      storage.updateWalletEmergencyStop(owner,{executionEnabled:false,umkEncryptedForExecution:null,executionExpiresAt:null,emergencyStopTriggered:true,emergencyStopAt:new Date(),emergencyStopBy:'EXAMPLE'});
    await Promise.all([sending,tightening]);expect(Date.now()-started).toBeGreaterThanOrEqual(4800);expect(Date.now()-started).toBeLessThan(20_000);
    await expect(s.sendOwned(request,account.leaseToken,async()=>{posts++;})).rejects.toThrow();expect(posts).toBe(1);
  },25_000);
  it('signup, resync and grant wait behind the exclusive host fence and commit honestly',async()=>{
    await arm();const entered=latch(),hold=tx(async()=>{entered.resolve();await delay(3000);},'exclusive');await entered.promise;
    const started=Date.now();await Promise.all([hold,storage.initWalletUmkIfAbsent('EXAMPLE_'+randomUUID(),'EXAMPLE','EXAMPLE'),
      storage.resyncWalletExecutionUmk(owner,'EXAMPLE_LOGIN'),storage.updateWalletExecution(other,{executionEnabled:true,umkEncryptedForExecution:'EXAMPLE_GRANT',executionExpiresAt:null})]);
    expect(Date.now()-started).toBeLessThan(20_000);
  },25_000);
  it('armed non-grid pool insert, reuse, stuck-funds and external reservation keep identity prelocks',async()=>{
    await arm();const account='EXAMPLE_'+randomUUID(),p={walletAddress:owner,protocol:'pacifica',protocolSubaccountId:account,
      agentPublicKey:'EXAMPLE_MASTER',subaccountKeyEncryptedV3:'EXAMPLE',aadVersion:1};
    await storage.poolSubaccountAsSpare(p);await storage.poolSubaccountAsSpare(p);
    await storage.claimSpareSubaccount({walletAddress:owner,protocol:'pacifica',agentPublicKey:'EXAMPLE_MASTER',claimToken:randomUUID()});
    await storage.markSubaccountStuckFunds({...p,botId:null,lastError:'EXAMPLE'});
    await storage.prepareExternalSubaccountReservation({...p,protocolSubaccountId:'EXAMPLE_'+randomUUID(),observedAgentPublicKey:'EXAMPLE_MASTER',claimToken:randomUUID(),derivationIndex:null,derivationPathVersion:null});
    expect((await pool.query('SELECT count(*)::integer AS n FROM protocol_subaccounts')).rows[0].n).toBe(2);
  });
  it('armed signup, login resync and pool insert each measure below the two-second SQL bound',async()=>{
    await arm();
    const measured=async(work:()=>Promise<unknown>)=>{const start=performance.now();await work();expect(performance.now()-start).toBeLessThan(2000);};
    await measured(()=>storage.initWalletUmkIfAbsent('EXAMPLE_'+randomUUID(),'EXAMPLE','EXAMPLE'));
    await measured(()=>storage.resyncWalletExecutionUmk(owner,'EXAMPLE_LOGIN'));
    await measured(()=>storage.poolSubaccountAsSpare({walletAddress:owner,protocol:'pacifica',protocolSubaccountId:'EXAMPLE_'+randomUUID(),agentPublicKey:'EXAMPLE_MASTER',subaccountKeyEncryptedV3:'EXAMPLE',aadVersion:1}));
  });
  it('reset commits the new master under host and wallet prelocks',async()=>{
    await arm();const b=await draft();
    expect(await storage.finalizeAgentWalletReset({walletAddress:owner,observedAgentPublicKey:'EXAMPLE_MASTER',encryptedMnemonicWords:'EXAMPLE',newAgentPublicKey:'EXAMPLE_REPLACEMENT',newAgentPrivateKeyEncryptedV3:'EXAMPLE'})).toMatchObject({outcome:'committed'});
    await expect(locked(b.id,c=>currentAuthority(c,{botId:b.id,wallet:owner,masterAccount:'EXAMPLE_MASTER',requirePool:false}))).rejects.toThrow('GRID_CURRENT_AUTHORITY_INVALID');
  });
  it('jsonb multiple supersession and consumed replay refuse',async()=>{
    await arm();const a=await draft(),b=await draft();
    const value=await locked(a.id,c=>issueStartConsent(c,intent(a),umk()));await locked(b.id,c=>issueStartConsent(c,intent(b),umk()));
    await tx(async c=>{await walletFences(c,[owner]);await identityFences(c,[a.id,b.id],[]);expect(await supersedeStartConsents(c,owner,[a.id,b.id],'draft_changed')).toBe(2);});
    await expect(locked(a.id,c=>verifyStartConsent(c,value,umk(),['pending']))).rejects.toThrow('GRID_CONSENT_REPLAY');
    const d=await draft(),v=await locked(d.id,c=>issueStartConsent(c,intent(d),umk()));
    await locked(d.id,c=>c.query("UPDATE grid_worker_requests SET state='complete',completed_at=clock_timestamp() WHERE id=$1",[v.id]));
    await expect(locked(d.id,c=>verifyStartConsent(c,v,umk(),['complete']))).rejects.toThrow('GRID_CONSENT_REPLAY');
  });
  it('P2 first install, no-op rerun and interruption preserve complete history',async()=>{
    await expect(p2(p2Sql.replace('COMMIT;','SELECT 1/0; COMMIT;'))).rejects.toThrow('division by zero');
    expect((await pool.query('SELECT count(*)::integer AS n FROM grid_worker_wallet_authority')).rows[0].n).toBe(0);
    const ms=await p2();expect(ms).toBeLessThan(2000);
    const before=(await pool.query('SELECT * FROM grid_worker_wallet_authority ORDER BY wallet_address')).rows;
    await p2();expect((await pool.query('SELECT * FROM grid_worker_wallet_authority ORDER BY wallet_address')).rows).toEqual(before);
    // TRUNCATE is deliberate fixture corruption; production DELETE is guarded separately.
    await pool.query('TRUNCATE grid_worker_wallet_authority CASCADE');
    await expect(p2()).rejects.toThrow('GRID_AUTHORITY_HISTORY_MISSING');
  });
  it('P2 refuses retained pre-install history and missing owner readiness',async()=>{
    await tx(async c=>{await walletFences(c,[owner]);await c.query('INSERT INTO grid_worker_wallet_authority(wallet_address) VALUES($1)',[owner]);});
    await expect(p2()).rejects.toThrow('GRID_AUTHORITY_NOT_FIRST_INSTALL');
    const c=await pool.connect();try{await c.query("RESET qv.u2c_readiness");await expect(c.query(p2Sql)).rejects.toThrow('GRID_U2C_READINESS_REQUIRED');await c.query('ROLLBACK');}finally{c.release();}
  });
  it('P2 serializes concurrent signup, login, pool insert and draft insert',async()=>{
    const started=Date.now();await Promise.all([p2(),storage.initWalletUmkIfAbsent('EXAMPLE_'+randomUUID(),'EXAMPLE','EXAMPLE'),
      storage.resyncWalletExecutionUmk(owner,'EXAMPLE_LOGIN'),draft(),storage.poolSubaccountAsSpare({walletAddress:other,protocol:'pacifica',protocolSubaccountId:'EXAMPLE_'+randomUUID(),agentPublicKey:'EXAMPLE_MASTER',subaccountKeyEncryptedV3:'EXAMPLE',aadVersion:1})]);
    expect(Date.now()-started).toBeLessThan(20_000);
    expect((await pool.query('SELECT count(*)::integer AS n FROM wallets w LEFT JOIN grid_worker_wallet_authority a ON a.wallet_address=w.address WHERE a.wallet_address IS NULL')).rows[0].n).toBe(0);
  });
  it('no-host, seeded dormant and armed non-grid writers preserve grant behavior',async()=>{
    for(const state of ['no-host','dormant','armed']){
      if(state==='no-host')await pool.query('TRUNCATE grid_worker_host CASCADE');
      if(state==='dormant')await tx(c=>c.query("INSERT INTO grid_worker_host(protocol_version,owner_wallet) VALUES('grid-worker-v3-a1-wire1',$1)",[owner]),'exclusive');
      if(state==='armed')await arm();
      const address='EXAMPLE_'+randomUUID();expect(await storage.initWalletUmkIfAbsent(address,'EXAMPLE','EXAMPLE')).toBe(true);
      await storage.updateWalletExecution(address,{executionEnabled:true,umkEncryptedForExecution:'EXAMPLE',executionExpiresAt:null});
      expect((await storage.getWallet(address))?.executionEnabled).toBe(true);
    }
  });
  it('stale scope and generation fail even with a correctly recomputed retained MAC',async()=>{
    await arm();const b=await draft(),v=await locked(b.id,c=>issueStartConsent(c,intent(b),umk()));
    for(const field of ['scopeRevision','walletGeneration'] as const){
      const consent={...v.consent,[field]:'99'},consentMac=startConsentMac(consent,umk()),value={...v,consent,consentMac};
      await locked(b.id,c=>c.query('UPDATE grid_worker_requests SET scope_revision=$2,wallet_generation=$3,consent_mac=$4 WHERE id=$1',[v.id,consent.scopeRevision,consent.walletGeneration,consentMac]));
      await expect(locked(b.id,c=>verifyStartConsent(c,value,umk(),['pending']))).rejects.toThrow('GRID_CONSENT_STALE');
    }
  });
  it('package-absent signup and legacy current-authority checks remain available',async()=>{
    const bareSchema='grid_u2c_absent_'+randomUUID().replaceAll('-',''),originalPool=pool;
    await admin.query('CREATE SCHEMA '+bareSchema);
    const bare=new Pool({connectionString:process.env.DATABASE_URL,max:3,options:'-c search_path='+bareSchema+',pg_catalog'});bare.on('connect',isolate);
    try{
      const tables=(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename !~ '^grid_worker_' AND tablename<>'owner_action_receipts'")).rows;
      for(const {tablename} of tables){if(!/^[a-z0-9_]+$/.test(tablename))throw Error('EXAMPLE_TABLE');await bare.query(`CREATE TABLE ${tablename} (LIKE public.${tablename} INCLUDING ALL)`);}
      await bare.query(`CREATE SEQUENCE fixture_pool_seq START ${randomInt(1_000_000,1_500_000_000)} OWNED BY protocol_subaccounts.id; ALTER TABLE protocol_subaccounts ALTER COLUMN id SET DEFAULT nextval('fixture_pool_seq')`);
      pool=bare;fixture.pool=bare;
      await storage.createWallet({address:owner,agentPublicKey:'EXAMPLE_MASTER',executionEnabled:true,umkEncryptedForExecution:'EXAMPLE',agentPrivateKeyEncryptedV3:'EXAMPLE'});
      expect(await storage.initWalletUmkIfAbsent('EXAMPLE_'+randomUUID(),'EXAMPLE','EXAMPLE')).toBe(true);
      const b=await draft();await locked(b.id,async c=>{expect((await currentAuthority(c,{botId:b.id,wallet:owner,masterAccount:'EXAMPLE_MASTER',requirePool:false})).generation).toBeNull();});
      await storage.updateWalletExecution(owner,{executionEnabled:false,umkEncryptedForExecution:null,executionExpiresAt:null});
      await expect(locked(b.id,c=>currentAuthority(c,{botId:b.id,wallet:owner,masterAccount:'EXAMPLE_MASTER',requirePool:false}))).rejects.toThrow('GRID_CURRENT_AUTHORITY_INVALID');
    }finally{pool=originalPool;fixture.pool=originalPool;await bare.end();await admin.query('DROP SCHEMA '+bareSchema+' CASCADE');}
  });
  it('resync and grant supersede consent only after the issuing transaction commits',async()=>{
    await arm();const b=await draft(),entered=latch();
    const issuing=locked(b.id,async c=>{const value=await issueStartConsent(c,intent(b),umk());entered.resolve();await delay(250);return value;});
    await entered.promise;
    const changes=Promise.all([storage.resyncWalletExecutionUmk(owner,'EXAMPLE_RESYNC_RACE'),storage.updateWalletExecution(owner,{executionEnabled:true,umkEncryptedForExecution:'EXAMPLE_GRANT_RACE',executionExpiresAt:null})]);
    const consent=await issuing;await changes;
    expect((await pool.query('SELECT state FROM grid_worker_requests WHERE id=$1',[consent.id])).rows[0].state).toBe('superseded');
  });
  it('revoke queued behind an exclusive pause commits within its watchdog',async()=>{
    await arm();const entered=latch(),pause=tx(async()=>{entered.resolve();await delay(3000);},'exclusive');await entered.promise;
    const started=Date.now();await Promise.all([pause,storage.atomicRevokeExecutionAndPauseBots(owner,'EXAMPLE')]);
    expect(Date.now()-started).toBeLessThan(20_000);expect((await storage.getWallet(owner))?.executionEnabled).toBe(false);
  },25_000);
  it('cross-owner linked pool and launch identities are refused under complete prelocks',async()=>{
    await arm();const b=await draft(),s=new GridLaunchStorage(pool,async()=>{}),custody=new GridCustody(s);
    const account=await custody.reserve({botId:b.id,wallet:owner,masterAccount:'EXAMPLE_MASTER',policyHmac:b.policyHmac},umk());
    const poolId=(await pool.query('SELECT protocol_subaccount_id FROM grid_launch_accounts WHERE bot_id=$1',[b.id])).rows[0].protocol_subaccount_id;
    await expect(tx(async c=>{await walletFences(c,[owner,other]);await identityFences(c,[b.id],[poolId]);await c.query('UPDATE protocol_subaccounts SET wallet_address=$2 WHERE id=$1',[poolId,other]);})).rejects.toThrow('GRID_');
    const otherBot=await draft(other);
    await expect(tx(async c=>{await walletFences(c,[owner,other]);await identityFences(c,[b.id,otherBot.id],[poolId]);await c.query('INSERT INTO grid_launch_accounts(bot_id,protocol_subaccount_id,master_account,account,canary_limit) VALUES($1,$2,$3,$4,100)',[otherBot.id,poolId,'EXAMPLE_MASTER',account.account]);})).rejects.toThrow('GRID_');
  });
  it('missing authority history refuses send and independently records a critical incident',async()=>{
    await arm();const b=await draft(),s=new GridLaunchStorage(pool,async()=>{});await pool.query('TRUNCATE grid_worker_wallet_authority CASCADE');
    let posts=0;await expect(s.sendOwned({kind:'fund',botId:b.id,account:'EXAMPLE',masterAccount:'EXAMPLE_MASTER',path:'/account/subaccount/transfer',operationType:'transfer_funds',timestamp:Date.now(),expiryMs:5000,data:{},authority:{}},randomUUID(),async()=>{posts++;})).rejects.toThrow('GRID_AUTHORITY_HISTORY_MISSING');
    expect(posts).toBe(0);expect((await pool.query("SELECT code FROM grid_worker_incidents WHERE code='schema_drift'")).rowCount).toBe(1);
  });
  it('expanded scope is an explicit refusal even for a valid retained consent',async()=>{
    await arm();const b=await draft(),v=await locked(b.id,c=>issueStartConsent(c,intent(b),umk()));
    // Seed a future U5 state only in this isolated fixture; U2c ships no widening path.
    await tx(async c=>{await walletFences(c,[owner]);await identityFences(c,[b.id],[]);
      await c.query('ALTER TABLE grid_worker_host DISABLE TRIGGER USER');
      await c.query("UPDATE grid_worker_host SET start_scope='expanded',per_bot_cap_usd=100,global_ceiling_usd=1000");
      await c.query('ALTER TABLE grid_worker_host ENABLE TRIGGER USER');
    },'exclusive');
    await expect(locked(b.id,c=>verifyStartConsent(c,v,umk(),['pending']))).rejects.toThrow('GRID_OWNER_SCOPE_REFUSED');
  });
});
