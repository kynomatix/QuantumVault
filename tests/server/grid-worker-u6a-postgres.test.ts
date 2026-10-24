import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {Pool,type PoolClient} from 'pg';
import {generateKeyPairSync,randomBytes,randomInt,randomUUID,sign,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import express from 'express';
import type {Server} from 'node:http';
import bs58 from 'bs58';
import {gridWorkerIsolation} from '../helpers/grid-worker-isolation';
import {fencedTransaction,walletFences} from '../../server/grid-worker/transaction';
import {localContext} from '../../server/grid-worker/host';
import {GridStorage,type DraftRecord} from '../../server/grid-bot/storage';
import {behaviourPolicy} from '../grid-bot/behaviour-fixtures';
import {computeGridPolicyHmac} from '../../server/grid-bot/policy-hmac';
import {ProtectiveExecutor} from '../../server/grid-worker/protective-executor';
import {registerGridWorkerAdminRoutes} from '../../server/grid-worker/admin-routes';
import {ProtectionTruth} from '../../server/grid-worker/protection-truth';
import {GridIncidents} from '../../server/grid-worker/incidents';
import {rescueOffer,rescueView} from '../../server/grid-worker/rescue-state';
import {validWorkerChallenge} from '../../client/src/lib/grid-worker-view';
import type {GridRuntimeDependencies} from '../../server/grid-bot/runtime-dependencies';
const fixture=vi.hoisted(()=>({key:undefined as Buffer|undefined}));
vi.mock('../../server/execution/umk',()=>({getExecutionUmk:async()=>({umk:Buffer.from(fixture.key!),cleanup(){}})}));
const schema='grid_u6a_'+randomUUID().replaceAll('-',''),isolate=gridWorkerIsolation();
const keys=generateKeyPairSync('ed25519'),owner=bs58.encode(keys.publicKey.export({format:'der',type:'spki'}).subarray(-32));
const master=bs58.encode(randomBytes(32)),account=bs58.encode(randomBytes(32));
const fixtureSha256=createHash('sha256').update('EXAMPLE_U6A').digest('hex');
let pool:Pool,admin:Pool,server:Server,url:string,botId:string,session=owner,enabled=true,posts=0;
let executor:ProtectiveExecutor;
const terminate=async(pid:number)=>{await pool.query('SELECT pg_terminate_backend($1)',[pid]);};
const tx=<T>(work:(c:PoolClient)=>Promise<T>,mode:'shared'|'exclusive'|'none'='shared')=>fencedTransaction(pool,work,{mode,terminate});
function diagnostics(c:PoolClient){c.query=new Proxy(c.query,{apply(fn,self,args){const r=Reflect.apply(fn,self,args);return r&&typeof r.catch==='function'?r.catch((e:Error&{code?:string;detail?:string;hint?:string})=>{e.message+=' [PostgreSQL code='+e.code+' DETAIL='+e.detail+' hint='+e.hint+']';throw e;}):r;}});}
const fakeFetch:typeof fetch=async(input,init)=>{
  const path=new URL(String(input)).pathname;if(init?.method==='POST'){posts++;throw Error('EXAMPLE_UNEXPECTED_POST');}
  const data=path.endsWith('/account')?{positions_count:0,orders_count:0,stop_orders_count:0,updated_at:Date.now()}:
    path.endsWith('/info/prices')?[{symbol:'SOL',mark:'100',timestamp:Date.now()}]:[];
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
  pool=new Pool({connectionString,max:8,options:'-c search_path='+schema+',pg_catalog'});pool.on('connect',c=>{isolate(c);diagnostics(c);c.on('error',()=>{});});pool.on('error',()=>{});
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
  session=owner;enabled=true;posts=0;
  const tables=(await pool.query('SELECT tablename FROM pg_tables WHERE schemaname=$1',[schema])).rows;
  await pool.query('TRUNCATE '+tables.map(r=>'"'+r.tablename+'"').join(',')+' CASCADE');
  await pool.query("INSERT INTO wallets(address,agent_public_key,execution_enabled,umk_encrypted_for_execution,agent_private_key_encrypted_v3,umk_version) VALUES($1,$2,true,'EXAMPLE','EXAMPLE',3)",[owner,master]);
  const p={...behaviourPolicy('continuous'),id:randomUUID()},h=computeGridPolicyHmac(p,fixture.key!);if(!h.ok)throw Error('EXAMPLE_POLICY');botId=p.id;
  const {levels,...base}=p;
  await new GridStorage(pool,async()=>{}).createDraftWithLevels({...base,walletAddress:owner,clientRequestId:randomUUID(),serverIntentDigest:fixtureSha256.toUpperCase(),draftRevision:'EXAMPLE',createIntent:{},authoritySnapshot:{},policyHmac:h.digest,name:'EXAMPLE',rangeSource:'manual',chartTimeframe:'1h'} as DraftRecord,levels);
  await tx(async c=>{
    await walletFences(c,[owner]);
    const id=(await c.query("INSERT INTO protocol_subaccounts(wallet_address,agent_public_key,protocol,protocol_subaccount_id,bot_id,status) VALUES($1,$2,'pacifica',$3,$4,'active') RETURNING id",[owner,master,account,botId])).rows[0].id;
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
it('serializes duplicate steps without waiting and never posts during contention',async()=>{
  const r=await start();expect(r.status,r.data).toBe(200);const c=await pool.connect();
  try{await c.query('BEGIN');await c.query('SELECT id FROM grid_worker_requests WHERE id=$1 FOR NO KEY UPDATE',[r.data.rescue.requestId]);
    expect(await executor.step(owner,r.data.rescue.requestId)).toEqual({next:'wait',retryAfterSeconds:2});expect(posts).toBe(0);
  }finally{await c.query('ROLLBACK');c.release();}
});
it('steps against a fake flat venue and retains a typed DB-derived result',async()=>{
  const r=await start();expect(r.status,r.data).toBe(200);
  const step=await api('/rescue/'+r.data.rescue.requestId+'/step',{});expect(step.status,JSON.stringify(step.data)).toBe(200);
  expect(['step','wait','done']).toContain(step.data.next);expect(posts).toBe(0);
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
