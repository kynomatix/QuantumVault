import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {Pool,type PoolClient} from 'pg';
import {generateKeyPairSync,randomBytes,randomInt,randomUUID,sign,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import express from 'express';
import type {Server} from 'node:http';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {deriveSubkey,encryptToBase64,buildPooledSubaccountAAD} from '../../server/crypto-v3';
import {gridWorkerIsolation} from '../helpers/grid-worker-isolation';
import {fencedTransaction,walletFences} from '../../server/grid-worker/transaction';
import {identityFences} from '../../server/grid-worker/identity-locks';
import {recoverAbandonedRescues} from '../../server/grid-worker/rescue-recovery';
import {WorkerStartRequests} from '../../server/grid-worker/requests';
import {localContext} from '../../server/grid-worker/host';
import {GridStorage,type DraftRecord} from '../../server/grid-bot/storage';
import {behaviourPolicy} from '../grid-bot/behaviour-fixtures';
import {computeGridPolicyHmac} from '../../server/grid-bot/policy-hmac';
import {ProtectiveExecutor} from '../../server/grid-worker/protective-executor';
import {registerGridWorkerAdminRoutes} from '../../server/grid-worker/admin-routes';
import {adminStatus} from '../../server/grid-worker/admin-state';
import {GridLifecycleService} from '../../server/grid-bot/lifecycle-service';
import {parseOwnerMessage,ownerSha256} from '../../server/grid-worker/owner-auth';
import {WorkerQuota} from '../../server/grid-worker/quota';
import {workerFetch} from '../../server/grid-worker/transport';
import {withProtectivePurpose} from '../../server/grid-worker/protective-purpose';
import {verifyProtectiveConsent} from '../../server/grid-worker/protective-consent';
import {serviceBotPass} from '../../server/grid-worker/bot-pass';
import {ProtectionTruth} from '../../server/grid-worker/protection-truth';
import {GridIncidents} from '../../server/grid-worker/incidents';
import {rescueOffer,rescueView,RESCUE_TRIGGER_FLOOR_SECONDS} from '../../server/grid-worker/rescue-state';
import {validWorkerChallenge,parseWorkerStatus} from '../../client/src/lib/grid-worker-view';
import {parseWorkerRescue} from '../../client/src/lib/grid-worker-rescue-wire';
import {GridWorkerCache} from '../../client/src/lib/grid-worker-cache';
import {refuseRescueMutation} from '../../server/grid-worker/rescue-recovery';
import type {GridRuntimeDependencies} from '../../server/grid-bot/runtime-dependencies';
const fixture=vi.hoisted(()=>({key:undefined as Buffer|undefined}));
vi.mock('../../server/execution/umk',()=>({getExecutionUmk:async()=>({umk:Buffer.from(fixture.key!),cleanup(){}})}));
const schema='grid_u6a_'+randomUUID().replaceAll('-',''),isolate=gridWorkerIsolation();
const keys=generateKeyPairSync('ed25519'),owner=bs58.encode(keys.publicKey.export({format:'der',type:'spki'}).subarray(-32));
const subaccount=nacl.sign.keyPair(),master=bs58.encode(randomBytes(32)),account=bs58.encode(subaccount.publicKey);
const fixtureSha256=createHash('sha256').update('EXAMPLE_U6A').digest('hex');
let pool:Pool,admin:Pool,server:Server,url:string,botId:string,session=owner,enabled=true,posts=0,position=false;
let executor:ProtectiveExecutor;
let beforePost:(()=>Promise<void>)|undefined;
let readOverride:((url:URL)=>unknown)|undefined;
const terminate=async(pid:number)=>{await pool.query('SELECT pg_terminate_backend($1)',[pid]);};
const tx=<T>(work:(c:PoolClient)=>Promise<T>,mode:'shared'|'exclusive'|'none'='shared')=>fencedTransaction(pool,work,{mode,terminate});
function diagnostics(c:PoolClient){c.query=new Proxy(c.query,{apply(fn,self,args){const r=Reflect.apply(fn,self,args);return r&&typeof r.catch==='function'?r.catch((e:Error&{code?:string;detail?:string;hint?:string})=>{e.message+=' [PostgreSQL code='+e.code+' DETAIL='+e.detail+' hint='+e.hint+']';throw e;}):r;}});}
const fakeFetch:typeof fetch=async(input,init)=>{
  const path=new URL(String(input)).pathname;if(init?.method==='POST'){posts++;await beforePost?.();if(!position||!path.endsWith('/orders/create_market'))throw Error('EXAMPLE_UNEXPECTED_POST');const payload=JSON.parse(String(init.body));expect(payload.reduce_only).toBe(true);expect(payload.amount).toBe('1');expect(payload.account).toBe(account);return new Response(JSON.stringify({success:true,data:{order_id:'123'}}),{status:200});}
  const override=readOverride?.(new URL(String(input)));if(override)return new Response(JSON.stringify(override),{status:200});
  const data=path.endsWith('/account')?{positions_count:0,orders_count:0,stop_orders_count:0,updated_at:Date.now()}:
    path.endsWith('/positions')&&position?[{symbol:'BTC',side:'bid',amount:'1'}]:path.endsWith('/info/prices')?[{symbol:'BTC',mark:'100',timestamp:Date.now()}]:[];
  return new Response(JSON.stringify({success:true,data,has_more:false,last_order_id:0}),{status:200});
};
const deps={fetcher:fakeFetch,transport:{keyStatus:'present',quota:{snapshot:()=>({availability:'unavailable'})},restInit:(_url:string,init:RequestInit)=>init,response:(r:Response)=>r},
  umk:async()=>({umk:Buffer.from(fixture.key!),cleanup(){}}),unlock:async()=>null,move:async()=>{throw Error('EXAMPLE_FORBIDDEN_MOVE');}} as unknown as GridRuntimeDependencies;
async function api(path:string,body?:unknown){const r=await fetch(url+'/api/grid-worker'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let data:any;try{data=JSON.parse(text);}catch{data=text;}return {status:r.status,data};}
async function challenge(){return api('/challenge',{action:'break_glass_close',target:'bot:'+botId,params:{botId}});}
async function start(){const c=await challenge();expect(c.status).toBe(200);return api('/rescue',{botId,message:c.data.message,signature:bs58.encode(sign(null,Buffer.from(c.data.message),keys.privateKey))});}
beforeAll(async()=>{
  const connectionString=process.env.DATABASE_URL;if(!connectionString||new URL(connectionString).pathname!=='/qvtest')throw Error('FRACTAL qvtest required');
  fixture.key=randomBytes(32);admin=new Pool({connectionString,max:1});await admin.query('CREATE SCHEMA '+schema);
  pool=new Pool({connectionString,max:8,options:'-c search_path='+schema+',public,pg_catalog'});pool.on('connect',c=>{isolate(c);diagnostics(c);c.on('error',()=>{});});pool.on('error',()=>{});
  const tables=(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename !~ '^grid_worker_' AND tablename<>'owner_action_receipts'")).rows;
  for(const {tablename} of tables){if(!/^[a-z0-9_]+$/.test(tablename))throw Error('EXAMPLE_TABLE');await pool.query(`CREATE TABLE ${tablename} (LIKE public.${tablename} INCLUDING ALL)`);}
  await pool.query(`CREATE SEQUENCE fixture_pool_seq START ${randomInt(1_000_000,1_500_000_000)} OWNED BY protocol_subaccounts.id; ALTER TABLE protocol_subaccounts ALTER COLUMN id SET DEFAULT nextval('fixture_pool_seq')`);
  await pool.query(readFileSync('migrations/grid_worker_v3_owner.sql','utf8').replaceAll('SET search_path = pg_catalog, public','SET search_path = pg_catalog, '+schema));
  executor=new ProtectiveExecutor(pool,terminate,deps,async()=>{});
  const app=express();app.use(express.json());app.use((req,_res,next)=>{(req as any).session={walletAddress:session};next();});
  registerGridWorkerAdminRoutes(app,(req,_res,next)=>{(req as any).walletAddress=session;next();},{lane:pool,terminate,enabled:()=>enabled,entriesPaused:()=>false,ownerWallet:()=>owner,readiness:async()=>true,rescue:executor});
  app.use((_req,res)=>res.status(404).send('Unknown API'));server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));url='http://127.0.0.1:'+(server.address() as {port:number}).port;
},60000);
beforeEach(async()=>{
  session=owner;enabled=true;posts=0;position=false;beforePost=undefined;readOverride=undefined;
  const tables=(await pool.query('SELECT tablename FROM pg_tables WHERE schemaname=$1',[schema])).rows;
  await pool.query('TRUNCATE '+tables.map(r=>'"'+r.tablename+'"').join(',')+' CASCADE');
  await pool.query("INSERT INTO wallets(address,agent_public_key,execution_enabled,umk_encrypted_for_execution,agent_private_key_encrypted_v3,umk_version) VALUES($1,$2,true,'EXAMPLE','EXAMPLE',3)",[owner,master]);
  const p={...behaviourPolicy('repeat_all'),id:randomUUID()},h=computeGridPolicyHmac(p,fixture.key!);if(!h.ok)throw Error('EXAMPLE_POLICY:'+h.reason);botId=p.id;
  const {levels,...base}=p;
  await new GridStorage(pool,async()=>{}).createDraftWithLevels({...base,walletAddress:owner,clientRequestId:randomUUID(),serverIntentDigest:fixtureSha256.toUpperCase(),draftRevision:'EXAMPLE',createIntent:{},authoritySnapshot:{},policyHmac:h.digest,name:'EXAMPLE',rangeSource:'manual',chartTimeframe:'1h'} as DraftRecord,levels);
  await tx(async c=>{
    await walletFences(c,[owner]);
    const derived=deriveSubkey(fixture.key!,'grid_subaccount_privkey');const encrypted=encryptToBase64(Buffer.from(subaccount.secretKey),derived,buildPooledSubaccountAAD('grid:pacifica',owner,account));derived.fill(0);
    const id=(await c.query("INSERT INTO protocol_subaccounts(wallet_address,agent_public_key,protocol,protocol_subaccount_id,status,aad_version,subaccount_key_encrypted_v3) VALUES($1,$2,'pacifica',$3,'grid_owned',1,$4) RETURNING id",[owner,master,account,encrypted])).rows[0].id;
    await c.query("UPDATE grid_bots SET status='active',protocol_subaccount_id=$2 WHERE id=$1",[botId,id]);
    await c.query('INSERT INTO grid_launch_accounts(bot_id,protocol_subaccount_id,master_account,account,canary_limit) VALUES($1,$2,$3,$4,100)',[botId,id,master,account]);
    await c.query('INSERT INTO grid_worker_owner(wallet_address) VALUES($1)',[owner]);
    await c.query("INSERT INTO grid_worker_host(protocol_version,owner_wallet) VALUES('grid-worker-v3-a1-wire1',$1)",[owner]);
    await c.query('INSERT INTO grid_worker_wallet_authority(wallet_address) VALUES($1)',[owner]);
    await localContext(c,'bootstrap_tracking');await c.query('UPDATE grid_worker_host SET authority_tracking_enabled=true');
    await localContext(c,'transition');await c.query("SELECT set_config('qv.grid_worker_owner_verified','true',true),set_config('qv.grid_worker_ready','true',true)");
    await c.query("UPDATE grid_worker_host SET execution_mode='external',run_mode='trading',execution_enabled=true,legacy_controls_enabled=true,commit_hash=$1,tree_hash=$1,lockfile_sha256=$2",[fixtureSha256.slice(0,40),fixtureSha256]);
  },'exclusive');
});
afterAll(async()=>{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await pool?.end();if(admin){await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();}fixture.key?.fill(0);},30000);

it('round-trips the real break-glass challenge and rejects mismatched parameters',async()=>{
  const c=await challenge();expect(c.status).toBe(200);const wire=JSON.parse(JSON.stringify(c.data));
  expect(await validWorkerChallenge(wire,{action:'break_glass_close',target:'bot:'+botId,params:{botId}})).toBe(true);
  expect(await validWorkerChallenge(wire,{action:'break_glass_close',target:'bot:'+botId,params:{botId:randomUUID()}})).toBe(false);
  expect((await api('/challenge',{action:'break_glass_close',target:'all',params:{botId}})).status).toBe(400);
  expect((await api('/challenge',{action:'break_glass_close',target:'bot:'+randomUUID(),params:{botId}})).status).toBe(409);
});
it('atomically admits the retained consent, queues Stop, revokes auto-resume and takes the protective lease',async()=>{
  const r=await start();expect(r.status,r.data).toBe(200);expect(r.data.started).toBe(true);
  const h=(await pool.query('SELECT holder_role,holder_boot_id,entries_paused FROM grid_worker_host')).rows[0];
  expect(h).toEqual({holder_role:'protective',holder_boot_id:r.data.rescue.requestId,entries_paused:true});
  const b=(await pool.query('SELECT status FROM grid_bots WHERE id=$1',[botId])).rows[0];expect(b.status).toBe('stopping');
  expect((await pool.query("SELECT source,action,state FROM grid_control_requests WHERE bot_id=$1",[botId])).rows).toEqual([{source:'owner',action:'stop',state:'pending'}]);
  expect((await api('/rescue?requestKey='+r.data.requestKey)).data.rescue.requestId).toBe(r.data.rescue.requestId);expect(posts).toBe(0);
});
it('refuses a replay without replacing the rescue',async()=>{
  const c=await challenge(),body={botId,message:c.data.message,signature:bs58.encode(sign(null,Buffer.from(c.data.message),keys.privateKey))};
  expect((await api('/rescue',body)).status).toBe(200);expect((await api('/rescue',body)).status).toBe(409);
  expect((await pool.query('SELECT count(*)::integer AS n FROM grid_worker_requests')).rows[0].n).toBe(1);
});
it('uses the same blocker for offer and takeover and hides disabled/non-owner routes',async()=>{
  await tx(async c=>{await localContext(c,'tighten');await c.query('UPDATE grid_worker_host SET execution_enabled=false');},'exclusive');
  expect((await tx(c=>rescueOffer(c,owner,botId)))?.blockedBy).toBe('trading_off');expect((await start()).data.refusal).toBe('trading_off');
  session=bs58.encode(randomBytes(32));expect((await challenge()).status).toBe(404);session=owner;enabled=false;expect((await challenge()).status).toBe(404);
});
/** Move fixture time through the package's permitted transition path; never alter triggers. */
async function rescueHost(role:'grid-worker'|'protective'|null,heartbeatAge:number|null,leaseRemaining:number){
  return tx(async c=>{
    await localContext(c,'transition');
    await c.query("SELECT set_config('qv.grid_worker_owner_verified','true',true),set_config('qv.grid_worker_ready','true',true)");
    return (await c.query(`UPDATE grid_worker_host SET holder_role=$1,holder_boot_id=$2,fencing_epoch=fencing_epoch+1,
      heartbeat_at=CASE WHEN $3::integer IS NULL THEN NULL ELSE clock_timestamp()-make_interval(secs=>$3) END,
      lease_expires_at=CASE WHEN $1::text IS NULL THEN '-infinity'::timestamptz ELSE clock_timestamp()+make_interval(secs=>$4) END
      RETURNING holder_boot_id AS "bootId",fencing_epoch::text AS epoch`,[role,role?randomUUID():null,heartbeatAge,leaseRemaining])).rows[0];
  },'exclusive');
}
async function roundTripOffers(){
  const r=await api('/status');expect(r.status,JSON.stringify(r.data)).toBe(200);
  const parsed=parseWorkerStatus(JSON.parse(JSON.stringify(r.data)));expect(parsed).not.toBeNull();
  const offer=await tx(c=>rescueOffer(c,owner,botId));
  expect(parsed!.rescueOffers).toEqual(offer?[offer]:[]);
  return parsed!.rescueOffers;
}
it('R3 refuses drain as handover after an eligible challenge and under the takeover lock',async()=>{
  expect(await roundTripOffers()).toEqual([{botId,trigger:'worker_unavailable',blockedBy:null}]);
  const c=await challenge();expect(c.status).toBe(200);
  await tx(async db=>{await localContext(db,'tighten');await db.query('UPDATE grid_worker_host SET drain_requested=true');},'exclusive');
  expect(await roundTripOffers()).toEqual([{botId,trigger:'worker_unavailable',blockedBy:'handover'}]);
  const r=await api('/rescue',{botId,message:c.data.message,signature:bs58.encode(sign(null,Buffer.from(c.data.message),keys.privateKey))});
  expect(r.status).toBe(409);expect(r.data.refusal).toBe('handover');
  expect((await pool.query('SELECT holder_role,drain_requested FROM grid_worker_host')).rows[0]).toEqual({holder_role:null,drain_requested:true});
  expect((await pool.query('SELECT count(*)::integer AS n FROM grid_worker_requests')).rows[0].n).toBe(0);
  expect(posts).toBe(0);
});
it('R3 gives an unmatched live protective holder its own typed blocker, never handover',async()=>{
  await rescueHost('protective',RESCUE_TRIGGER_FLOOR_SECONDS,45);
  expect(await roundTripOffers()).toEqual([{botId,trigger:'worker_unavailable',blockedBy:'protective_holder_active'}]);
  const r=await start();expect(r.status).toBe(409);expect(r.data.refusal).toBe('protective_holder_active');expect(posts).toBe(0);
});
it.each([0,RESCUE_TRIGGER_FLOOR_SECONDS-1,RESCUE_TRIGGER_FLOOR_SECONDS,RESCUE_TRIGGER_FLOOR_SECONDS+1])(
  'R3 graceful release with heartbeat age %i uses the heartbeat floor despite minus-infinity lease',async age=>{
    const holder=await rescueHost('grid-worker',age,-1);
    await tx(async c=>{
      await localContext(c,'lease_release',holder);
      await c.query("UPDATE grid_worker_host SET holder_boot_id=NULL,holder_role=NULL,lease_expires_at='-infinity',fencing_epoch=fencing_epoch+1");
    },'exclusive');
    const eligible=age>=RESCUE_TRIGGER_FLOOR_SECONDS;
    expect(await roundTripOffers()).toEqual(eligible?[{botId,trigger:'worker_unavailable',blockedBy:null}]:[]);
    if(eligible){expect((await start()).status).toBe(200);}
    else{expect((await challenge()).status).toBe(409);}
    expect(posts).toBe(0);
  });
it.each([RESCUE_TRIGGER_FLOOR_SECONDS-1,RESCUE_TRIGGER_FLOOR_SECONDS,RESCUE_TRIGGER_FLOOR_SECONDS+1])(
  'R3 crash with heartbeat age %i uses last heartbeat, not the later lease expiry',async age=>{
    await rescueHost('grid-worker',age,45-age);
    const eligible=age>=RESCUE_TRIGGER_FLOOR_SECONDS;
    expect(await roundTripOffers()).toEqual(eligible?[{botId,trigger:'worker_unavailable',blockedBy:null}]:[]);
    if(eligible){expect((await start()).status).toBe(200);}
    else{expect((await challenge()).status).toBe(409);}
    expect(posts).toBe(0);
  });
it('R3 never calls a live worker unavailable even with a stale heartbeat',async()=>{
  await rescueHost('grid-worker',RESCUE_TRIGGER_FLOOR_SECONDS,45);
  expect(await roundTripOffers()).toEqual([{botId,trigger:'worker_stalled',blockedBy:null}]);
});
it('serializes duplicate steps without waiting and never posts during contention',async()=>{
  const r=await start();expect(r.status,r.data).toBe(200);const c=await pool.connect();
  try{await c.query('BEGIN');await c.query('SELECT id FROM grid_worker_requests WHERE id=$1 FOR NO KEY UPDATE',[r.data.rescue.requestId]);
    expect(await executor.step(owner,r.data.rescue.requestId)).toEqual({next:'wait',retryAfterSeconds:2});expect(posts).toBe(0);
  }finally{await c.query('ROLLBACK');c.release();}
});
it('steps against a fake flat venue and retains a typed DB-derived result',async()=>{
  const r=await start();expect(r.status,r.data).toBe(200);
  await executor.step(owner,r.data.rescue.requestId);
  const step=await api('/rescue/'+r.data.rescue.requestId+'/step',{});expect(step.status,JSON.stringify(step.data)).toBe(200);
  expect(step.data.next).toBe('done');expect(posts).toBe(0);
  const view=await tx(c=>rescueView(c,owner,r.data.requestKey));expect(view?.requestId).toBe(r.data.rescue.requestId);
});
it('deduplicates stop failures and resolves only on fresh identity-bound flat proof without acknowledgement',async()=>{
  const r=await start();expect(r.status,r.data).toBe(200);const truth=new ProtectionTruth(pool,terminate,new GridIncidents(pool,terminate));
  await truth.observe(botId,Error('GRID_QUOTA_BACKOFF'));await truth.observe(botId,Error('GRID_QUOTA_BACKOFF'));
  const incidents=()=>pool.query("SELECT id,bot_id,resolved_at,acknowledged_at FROM grid_worker_incidents WHERE code='stop_failed'");
  expect((await incidents()).rows).toHaveLength(1);expect((await incidents()).rows[0]).toMatchObject({bot_id:botId,resolved_at:null,acknowledged_at:null});
  await pool.query("INSERT INTO grid_monitor_state(bot_id,observation,reconciled_at) VALUES($1,$2::jsonb,clock_timestamp()) ON CONFLICT(bot_id) DO UPDATE SET observation=EXCLUDED.observation,reconciled_at=EXCLUDED.reconciled_at",[botId,JSON.stringify({account,symbol:'WRONG',observedAt:Date.now(),inventoryComplete:true,orders:[],position:{size:'0'}})]);
  await truth.observe(botId);expect((await incidents()).rows[0].resolved_at).toBeNull();
  const market=(await pool.query('SELECT market FROM grid_bots WHERE id=$1',[botId])).rows[0].market;
  await pool.query("UPDATE grid_monitor_state SET observation=$2::jsonb,reconciled_at=clock_timestamp() WHERE bot_id=$1",[botId,JSON.stringify({account,symbol:market.replace(/-PERP$/,''),observedAt:Date.now(),inventoryComplete:true,orders:[],position:{size:'0'}})]);
  await truth.observe(botId);expect((await incidents()).rows[0].resolved_at).not.toBeNull();expect((await incidents()).rows[0].acknowledged_at).toBeNull();
});

it('uses reserved quota only for protection and keeps backoff binding',async()=>{
  await pool.query(`INSERT INTO grid_worker_quota_policy(provider,domain_id,window_ms,total_units,worker_limit_units,worker_protective_reserve_units,policy_digest,valid_until)
    VALUES('pacifica_rest','deployment',60000,1000,600,240,$1,clock_timestamp()+interval '1 hour')`,[fixtureSha256]);
  const quota=new WorkerQuota(pool,terminate),send=workerFetch(quota,async()=>new Response('{}'));
  await quota.debit('pacifica_rest',360);
  await expect(send('https://api.pacifica.fi/api/v1/positions')).rejects.toThrow('GRID_QUOTA_UNAVAILABLE');
  await withProtectivePurpose(()=>send('https://api.pacifica.fi/api/v1/positions'));
  await expect(withProtectivePurpose(()=>send('https://api.pacifica.fi/api/v1/orders/create',{method:'POST',body:JSON.stringify({reduce_only:false})}))).rejects.toThrow('GRID_QUOTA_UNAVAILABLE');
  await quota.rateLimited('pacifica_rest');
  await expect(withProtectivePurpose(()=>send('https://api.pacifica.fi/api/v1/positions'))).rejects.toThrow('GRID_QUOTA_UNAVAILABLE');
});
it('records the third blocked stop pass and creates a fresh incident after acknowledgement',async()=>{
  const r=await start();expect(r.status,r.data).toBe(200);
  await pool.query("UPDATE grid_lifecycle SET blocker='history_incomplete' WHERE bot_id=$1",[botId]);
  const truth=new ProtectionTruth(pool,terminate,new GridIncidents(pool,terminate));
  const rows=async()=>(await pool.query("SELECT id FROM grid_worker_incidents WHERE code='stop_failed' AND bot_id=$1 AND acknowledged_at IS NULL",[botId])).rows;
  await truth.observe(botId);await truth.observe(botId);expect(await rows()).toHaveLength(0);
  await truth.observe(botId);expect(await rows()).toHaveLength(1);
  const old=(await rows())[0].id;
  await pool.query('UPDATE grid_worker_incidents SET acknowledged_at=clock_timestamp(),acknowledged_by=$2,inbox_seen_at=clock_timestamp() WHERE id=$1',[old,owner]);
  await truth.observe(botId,Error('GRID_QUOTA_BACKOFF'));expect(await rows()).toHaveLength(1);expect((await rows())[0].id).not.toBe(old);
});
it('refuses forged and other-bot retained consent before any POST',async()=>{
  const r=await start();expect(r.status,r.data).toBe(200);
  const stored=(await pool.query('SELECT * FROM grid_worker_requests WHERE id=$1',[r.data.rescue.requestId])).rows[0];
  await tx(c=>verifyProtectiveConsent(c,stored,fixture.key!));
  await expect(tx(c=>verifyProtectiveConsent(c,{...stored,bot_id:randomUUID()},fixture.key!))).rejects.toThrow('GRID_PROTECTIVE_CONSENT_INVALID');
  await expect(tx(c=>verifyProtectiveConsent(c,{...stored,consent_mac:fixtureSha256},fixture.key!))).rejects.toThrow('GRID_PROTECTIVE_CONSENT_INVALID');
  expect(posts).toBe(0);
});
it('continues the same pass after one bot fails and records its own stop incident',async()=>{
  const r=await start();expect(r.status,r.data).toBe(200);const other=randomUUID(),ran:string[]=[];
  const truth=new ProtectionTruth(pool,terminate,new GridIncidents(pool,terminate));
  await serviceBotPass(new AbortController().signal,{
    assertHolder:()=>{},claim:async seen=>[botId,other].find(id=>!seen.includes(id))?{id:[botId,other].find(id=>!seen.includes(id))!}:null,
    allowed:()=>true,refused:async()=>{},tick:async c=>{ran.push(c.id);if(c.id===botId)throw Error('GRID_QUOTA_BACKOFF');},
    observed:(c,e)=>truth.observe(c.id,e),observationFailed:async()=>{throw Error('EXAMPLE_TRUTH_FAILURE');},release:async()=>{},
  });
  expect(ran).toEqual([botId,other]);
  expect((await pool.query("SELECT bot_id FROM grid_worker_incidents WHERE code='stop_failed'")).rows).toEqual([{bot_id:botId}]);
});
it('signs one reduce-only close against a fake venue and never replays an uncertain operation',async()=>{
  position=true;
  await tx(c=>c.query("UPDATE grid_bots SET policy_version='1.0.0',runtime_policy_version='1.0.0' WHERE id=$1",[botId]));
  const r=await start();expect(r.status,r.data).toBe(200);
  await executor.step(owner,r.data.rescue.requestId);
  const ops=await pool.query('SELECT state,exact_request FROM grid_operations WHERE bot_id=$1',[botId]);
  expect(posts,JSON.stringify(ops.rows)).toBe(1);
  expect(ops.rows[0].exact_request).toMatchObject({kind:'close',data:{reduce_only:true},authority:{protectiveRequestId:r.data.rescue.requestId}});
  await executor.step(owner,r.data.rescue.requestId);expect(posts).toBe(1);
});

it('rejects changed targets, wrong signatures and extra step credentials before any send',async()=>{
  const c=await challenge(),message=c.data.message;
  const wrong=generateKeyPairSync('ed25519');
  expect((await api('/rescue',{botId,message,signature:bs58.encode(sign(null,Buffer.from(message),wrong.privateKey))})).status).toBe(409);
  expect((await api('/rescue',{botId:randomUUID(),message,signature:bs58.encode(sign(null,Buffer.from(message),keys.privateKey))})).status).toBe(409);
  const r=await start();expect(r.status).toBe(200);
  expect((await api('/rescue/'+r.data.rescue.requestId+'/step',{signature:'EXAMPLE'})).status).toBe(400);expect(posts).toBe(0);
});
it('recovers abandoned requests with prelocks while skipping an in-flight step',async()=>{
  const r=await start(),id=r.data.rescue.requestId;
  await tx(async c=>{await walletFences(c,[owner]);await identityFences(c,[botId],[]);await c.query("UPDATE grid_worker_requests SET issued_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[id]);});
  const locked=await pool.connect();try{
    await locked.query('BEGIN');await locked.query('SELECT id FROM grid_worker_requests WHERE id=$1 FOR NO KEY UPDATE',[id]);
    await tx(c=>recoverAbandonedRescues(c));expect((await pool.query('SELECT state FROM grid_worker_requests WHERE id=$1',[id])).rows[0].state).toBe('admitted');
  }finally{await locked.query('ROLLBACK');locked.release();}
  await tx(c=>recoverAbandonedRescues(c));
  expect((await pool.query('SELECT state,result_code FROM grid_worker_requests WHERE id=$1',[id])).rows[0]).toEqual({state:'complete',result_code:'ended'});
  expect((await pool.query("SELECT bot_id FROM grid_worker_incidents WHERE code='protective_failure'")).rows[0].bot_id).toBe(botId);
});
it('releases a failed Start reservation only after proving zero custody and execution state',async()=>{
  const r=await start(),id=r.data.rescue.requestId,workerId=randomUUID();
  const holder=await tx(async c=>{
    await walletFences(c,[owner]);await identityFences(c,[botId],[]);
    await c.query("UPDATE grid_worker_requests SET action='start' WHERE id=$1",[id]);
    await c.query(`INSERT INTO grid_worker_reservations(bot_id,start_request_id,owner_wallet,wallet_generation,policy_digest,scope_revision,
      investment_usd,leverage,budget_notional_usd,observed_exposure_usd,reserve_usd,cash_commitment_usd,fee_reserve_usd,facts_at)
      SELECT bot_id,id,owner_wallet,wallet_generation,policy_hmac,scope_revision,100,1,100,0,100,100,0,clock_timestamp() FROM grid_worker_requests WHERE id=$1`,[id]);
    await c.query("UPDATE grid_bots SET status='failed' WHERE id=$1",[botId]);
    await localContext(c,'transition');await c.query("SELECT set_config('qv.grid_worker_owner_verified','true',true),set_config('qv.grid_worker_ready','true',true)");
    return (await c.query("UPDATE grid_worker_host SET holder_role='grid-worker',holder_boot_id=$1,fencing_epoch=fencing_epoch+1,lease_expires_at=clock_timestamp()+interval '45 seconds' RETURNING holder_boot_id AS \"bootId\",fencing_epoch::text AS epoch",[workerId])).rows[0];
  },'exclusive');
  const worker=new WorkerStartRequests(pool,terminate,new GridIncidents(pool,terminate));
  expect(await worker.releaseFailedZeroState(id,holder)).toBe(false);
  await tx(async c=>{await c.query('DELETE FROM grid_launch_accounts WHERE bot_id=$1',[botId]);await c.query('UPDATE grid_bots SET protocol_subaccount_id=NULL WHERE id=$1',[botId]);});
  expect(await worker.releaseFailedZeroState(id,holder)).toBe(true);
  expect((await pool.query('SELECT state,terminal_proof_digest FROM grid_worker_reservations')).rows[0]).toMatchObject({state:'released',terminal_proof_digest:expect.stringMatching(/^[0-9a-f]{64}$/)});
});

it('round-trips real status with rescue state and reset blocker',async()=>{
  const r=await start();expect(r.status).toBe(200);
  await tx(c=>adminStatus(c,false),'none');
  const status=await api('/status');expect(status.status,JSON.stringify(status.data)).toBe(200);
  expect(parseWorkerStatus(JSON.parse(JSON.stringify(status.data)))).not.toBeNull();
  expect(status.data.cardState).toBe('rescue_running');expect(status.data.resetBlockedBy).toContain('rescue');
  expect(status.data.rescue.requestId).toBe(r.data.rescue.requestId);expect(status.data.rescueAlertsPhone).toBe(false);
});

it('ends three blocked MAIN steps with a durable protective failure',async()=>{
  const r=await start();expect(r.status).toBe(200);
  const tick=vi.spyOn(GridLifecycleService.prototype,'tick').mockImplementation(async claim=>{
    await pool.query("UPDATE grid_lifecycle SET blocker='history_incomplete' WHERE bot_id=$1",[claim.id]);
    return 'history_incomplete';
  });
  try{
    for(let n=0;n<3;n++){
      const step=await api('/rescue/'+r.data.rescue.requestId+'/step',{});
      expect(step.status,JSON.stringify(step.data)).toBe(200);
      expect(step.data.phase).toBe(n===2?'partial_ended':'closing');
    }
    expect((await pool.query("SELECT id FROM grid_worker_incidents WHERE code='protective_failure' AND bot_id=$1 AND resolved_at IS NULL",[botId])).rows).toHaveLength(1);
    expect(posts).toBe(0);
  }finally{tick.mockRestore();}
});

it('rejects malformed receipt wire and an expired nonce at the real rescue route',async()=>{
  const c=await challenge(),original=c.data.message as string;
  const variants=[original+'\n',original.replaceAll('\n','\r\n'),original.replace('QV-OWNER-ACTION v1','QV-OWNER-ACTION v2'),
    original.replace('scope:grid_worker','scope:other'),original.replace('action:break_glass_close','action:pause'),
    original.replace('params:','params:EXAMPLE'),original.replace('target:bot:','target:incident:'),
    original.replace('issued:','issued: '),original.replace('nonce:','nonce:0'),original.replace('expires:','extra:value\nexpires:')];
  for(const message of variants){
    const r=await api('/rescue',{botId,message,signature:bs58.encode(sign(null,Buffer.from(message),keys.privateKey))});
    expect(r.status,JSON.stringify(r.data)).toBe(409);
  }
  await pool.query("UPDATE auth_nonces SET expires_at=clock_timestamp()-interval '1 second' WHERE nonce_hash=$1",[ownerSha256(parseOwnerMessage(original).nonce)]);
  expect((await api('/rescue',{botId,message:original,signature:bs58.encode(sign(null,Buffer.from(original),keys.privateKey))})).status).toBe(409);
  expect(posts).toBe(0);expect((await pool.query('SELECT id FROM grid_worker_requests')).rowCount).toBe(0);
});


it('two MAIN instances serialize a step while the audit commits before the POST',async()=>{
  position=true;
  await tx(c=>c.query("UPDATE grid_bots SET policy_version='1.0.0',runtime_policy_version='1.0.0' WHERE id=$1",[botId]));
  const r=await start(),id=r.data.rescue.requestId;
  const otherPool=new Pool({...pool.options,max:4});otherPool.on('connect',c=>{isolate(c);diagnostics(c);});
  const other=new ProtectiveExecutor(otherPool,terminate,deps,async()=>{});
  let entered!:()=>void,release!:()=>void;
  const atPost=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
  beforePost=async()=>{entered();await held;};
  const running=executor.step(owner,id);
  try{
    await Promise.race([atPost,running.then(()=>{throw Error('EXAMPLE_NO_POST');})]);
    const audit=(await otherPool.query('SELECT outcome,authorized_at,request_id FROM grid_worker_send_audit WHERE request_id=$1',[id])).rows;
    expect(audit).toHaveLength(1);expect(audit[0]).toMatchObject({outcome:'unknown',request_id:id});expect(audit[0].authorized_at).toBeNull(); // Authorization is held in the still-open send transaction.
    expect(await other.step(owner,id)).toEqual({next:'wait',retryAfterSeconds:2});expect(posts).toBe(1);
  }finally{release();await running;await otherPool.end();}
  // A lost step answer is recovered by exact lookup; replay cannot submit another order.
  await executor.step(owner,id);expect(posts).toBe(1);
  expect((await api('/rescue?requestKey='+r.data.requestKey)).data.rescue.requestId).toBe(id);
});

it('recovers a lost takeover answer by exact key and keeps missing keys unknown',async()=>{
  const c=await challenge(),requestKey=ownerSha256(parseOwnerMessage(c.data.message).nonce);
  const invoke=executor.start.bind(executor);
  const lost=vi.spyOn(executor,'start').mockImplementation(async(...args)=>{await invoke(...args);throw Error('EXAMPLE_LOST_RESPONSE');});
  try{
    const answer=await api('/rescue',{botId,message:c.data.message,signature:bs58.encode(sign(null,Buffer.from(c.data.message),keys.privateKey))});
    expect(answer.status).toBe(503);expect(answer.data).toMatchObject({started:'unknown',requestKey});
  }finally{lost.mockRestore();}
  const found=await api('/rescue?requestKey='+requestKey);expect(found.data.outcome).toBe('found');expect(found.data.rescue.requestKey).toBe(requestKey);
  expect((await api('/rescue?requestKey='+ownerSha256('EXAMPLE_MISSING'))).data).toMatchObject({rescue:null,outcome:'unknown'});
});

it('normalizes the real rescue route and status JSON and rejects inexact numeric strings',async()=>{
  const r=await start();const wire=JSON.parse(JSON.stringify(r.data.rescue));
  expect(parseWorkerRescue(wire)?.requestId).toBe(wire.requestId);
  for(const k of ['expiresInSeconds','stepIdleSeconds','leaseRemainingSeconds','retryAfterSeconds','waitSeconds'])if(wire[k]!==null)wire[k]=String(wire[k]);
  expect(parseWorkerRescue(wire)?.expiresInSeconds).toBeGreaterThan(0);
  expect(parseWorkerRescue({...wire,phase:'EXAMPLE_FUTURE_PHASE'})?.next).toBe('step');
  for(const value of [' 2','2e1','+2','02','Infinity','9007199254740992'])expect(parseWorkerRescue({...wire,expiresInSeconds:value})).toBeNull();
  const status=(await api('/status')).data;status.rescue=wire;
  expect(parseWorkerStatus(JSON.parse(JSON.stringify(status)))?.rescue?.requestId).toBe(wire.requestId);
});

it('keeps a newer step result when an older GET completes later',async()=>{
  const r=await start(),old=(await api('/status')).data;
  let deliver!:(v:{status:number;body:unknown})=>void,calls=0;
  const cache=new GridWorkerCache(owner,async()=>++calls===1?{status:200,body:old}:new Promise(resolve=>deliver=resolve));
  await cache.refresh();const pending=cache.refresh();
  await executor.step(owner,r.data.rescue.requestId);
  const step=await api('/rescue/'+r.data.rescue.requestId+'/step',{});expect(step.data.next).toBe('done');
  expect(cache.acceptRescueStep(step.data)).toBe(true);deliver({status:200,body:old});await pending;
  expect(cache.snapshot().status?.rescue?.next).toBe('done');cache.dispose();
});

it('shows expiry without a final browser step, keeps GET read-only and finalizes exactly once',async()=>{
  const r=await start(),id=r.data.rescue.requestId;
  await tx(async c=>{await walletFences(c,[owner]);await identityFences(c,[botId],[]);await c.query("UPDATE grid_worker_requests SET issued_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[id]);});
  const read=await api('/rescue?requestKey='+r.data.requestKey);expect(read.data.rescue).toMatchObject({live:false,next:'done',phase:'ended'});
  expect((await pool.query('SELECT state FROM grid_worker_requests WHERE id=$1',[id])).rows[0].state).toBe('admitted');
  await tx(c=>recoverAbandonedRescues(c));await tx(c=>recoverAbandonedRescues(c));
  expect((await pool.query("SELECT id FROM grid_worker_incidents WHERE code='protective_failure'")).rows).toHaveLength(1);
});

it('blocks ordinary target mutations during a live rescue',async()=>{
  await start();await expect(tx(c=>refuseRescueMutation(c,botId))).rejects.toMatchObject({code:'conflict'});
});


it('retains an older unknown across a newer request and scopes exact recovery to its owner',async()=>{
  position=true;await tx(c=>c.query("UPDATE grid_bots SET policy_version='1.0.0',runtime_policy_version='1.0.0' WHERE id=$1",[botId]));
  const old=await start();await executor.step(owner,old.data.rescue.requestId);
  const newer=randomUUID(),newKey=ownerSha256('EXAMPLE_NEWER');
  await tx(async c=>{
    await walletFences(c,[owner]);await identityFences(c,[botId],[]);
    await c.query("UPDATE grid_worker_requests SET state='complete',result_code='unknown_ended',completed_at=clock_timestamp() WHERE id=$1",[old.data.rescue.requestId]);
    await c.query(`INSERT INTO grid_worker_requests SELECT (jsonb_populate_record(NULL::grid_worker_requests,to_jsonb(r)||
      jsonb_build_object('id',$2::text,'request_key',$3::text,'created_at',clock_timestamp(),'result_code','ended'))).* FROM grid_worker_requests r WHERE id=$1`,[old.data.rescue.requestId,newer,newKey]);
  });
  expect((await api('/rescue?requestKey='+old.data.requestKey)).data.rescue).toMatchObject({requestId:old.data.rescue.requestId,unknownOpen:true,phase:'unknown_ended'});
  expect((await api('/rescue?requestKey='+newKey)).data.rescue).toMatchObject({requestId:newer,unknownOpen:true});
  expect((await api('/status')).data).toMatchObject({cardState:'rescue_unknown',resetBlockedBy:expect.arrayContaining(['rescue'])});
  await expect(tx(c=>refuseRescueMutation(c,botId))).rejects.toMatchObject({code:'conflict'});
  expect(await tx(c=>rescueView(c,bs58.encode(randomBytes(32)),old.data.requestKey))).toBeNull();
});

it('counts three durable close attempts across MAIN restarts and never permits a fourth',async()=>{
  const r=await start(),id=r.data.rescue.requestId;
  let simulatedSends=0;
  // Inject terminal, expired signed close operations at the lifecycle boundary. Real send/audit locking is tested above.
  const tick=vi.spyOn(GridLifecycleService.prototype,'tick').mockImplementation(async()=>{
    simulatedSends++;
    await pool.query(`INSERT INTO grid_operations(id,bot_id,type,idempotency_key,request_identity,state,terminal_at,exact_request,exact_request_digest)
      VALUES($1,$2,'close_position',$3,$3,'confirmed',clock_timestamp(),$4::jsonb,$5)`,[randomUUID(),botId,'EXAMPLE_CLOSE_'+simulatedSends,
      JSON.stringify({kind:'close',timestamp:Date.now()-60000,expiryMs:1000,authority:{protectiveRequestId:id}}),fixtureSha256]);
    return 'confirmed';
  });
  try{
    for(let n=0;n<4;n++){
      const restarted=new ProtectiveExecutor(pool,terminate,deps,async()=>{});
      const result=await restarted.step(owner,id);
      if(n<3)expect(result.next).toBe('step');else expect(result).toMatchObject({next:'done',phase:'complete'});
    }
    expect(simulatedSends).toBe(3);expect((await pool.query('SELECT count(*)::integer AS n FROM grid_operations WHERE bot_id=$1',[botId])).rows[0].n).toBe(3);
  }finally{tick.mockRestore();}
});


it('requires complete all-symbol and all-order-kind proof and follows every advertised page',async()=>{
  const r=await start(),id=r.data.rescue.requestId;
  const tick=vi.spyOn(GridLifecycleService.prototype,'tick').mockResolvedValue('protective_verify_required');
  try{
    for(const failure of ['position','stop_order','partial','gap','cursor','summary']){
      readOverride=u=>u.pathname.endsWith('/positions')?{success:true,data:failure==='position'?[{symbol:'ETH',amount:'1'}]:[],has_more:false,
        ...(failure==='partial'?{partial:true}:{}),...(failure==='gap'?{sequence_gap:true}:{})}:
        u.pathname.endsWith('/orders')?{success:true,data:failure==='stop_order'?[{symbol:'SOL',order_type:'stop_market'}]:[],has_more:failure==='cursor',next_cursor:failure==='cursor'?'EXAMPLE_CURSOR':null}:
        u.pathname.endsWith('/account')?{success:true,data:{positions_count:0,orders_count:0,stop_orders_count:failure==='summary'?1:0,updated_at:Date.now()}}:undefined;
      expect(await executor.step(owner,id)).toMatchObject({live:true,phase:'verifying'});
    }
    const pages:string[]=[];
    readOverride=u=>{
      if(!u.pathname.endsWith('/orders')&&!u.pathname.endsWith('/positions'))return undefined;
      pages.push(u.pathname+':'+(u.searchParams.get('cursor')??'first'));
      return {success:true,data:[],has_more:!u.searchParams.has('cursor'),next_cursor:u.searchParams.has('cursor')?null:'EXAMPLE_NEXT'};
    };
    expect(await executor.step(owner,id)).toMatchObject({live:false,phase:'complete'});
    expect(pages).toHaveLength(4);expect(posts).toBe(0);
  }finally{tick.mockRestore();}
});

it('waits for confirmed predecessor windows as well as uncertain operations',async()=>{
  const r=await start();
  await pool.query(`INSERT INTO grid_operations(id,bot_id,type,idempotency_key,request_identity,state,terminal_at,exact_request,exact_request_digest)
    VALUES($1,$2,'close_position','EXAMPLE_PREDECESSOR','EXAMPLE_PREDECESSOR','confirmed',clock_timestamp(),$3::jsonb,$4)`,[randomUUID(),botId,
      JSON.stringify({kind:'close',timestamp:Date.now(),expiryMs:15000,authority:{}}),fixtureSha256]);
  expect(await executor.step(owner,r.data.rescue.requestId)).toMatchObject({next:'wait',phase:'waiting',retryAfterSeconds:10});expect(posts).toBe(0);
});

it('does not revive a request at a different host epoch and finalizes it once',async()=>{
  const r=await start(),id=r.data.rescue.requestId;
  await tx(async c=>{await localContext(c,'transition');await c.query("SELECT set_config('qv.grid_worker_owner_verified','true',true),set_config('qv.grid_worker_ready','true',true)");await c.query('UPDATE grid_worker_host SET fencing_epoch=fencing_epoch+1');},'exclusive');
  const read=await api('/rescue?requestKey='+r.data.requestKey);expect(read.data.rescue).toMatchObject({live:false,next:'done',phase:'ended'});
  expect((await pool.query('SELECT state FROM grid_worker_requests WHERE id=$1',[id])).rows[0].state).toBe('admitted');
  await tx(c=>recoverAbandonedRescues(c));await tx(c=>recoverAbandonedRescues(c));
  expect((await pool.query("SELECT id FROM grid_worker_incidents WHERE code='protective_failure'")).rows).toHaveLength(1);
  expect(posts).toBe(0);
});
