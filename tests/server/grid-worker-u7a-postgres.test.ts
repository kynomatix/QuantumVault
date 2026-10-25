import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {Pool,type PoolClient} from 'pg';
import {createHash,createPrivateKey,createPublicKey,randomUUID,sign} from 'node:crypto';
import {readFileSync} from 'node:fs';
import express from 'express';
import type {Server} from 'node:http';
import bs58 from 'bs58';
import {gridWorkerIsolation} from '../helpers/grid-worker-isolation';
import {fencedTransaction,walletFences} from '../../server/grid-worker/transaction';
import {identityFences} from '../../server/grid-worker/identity-locks';
import {localContext} from '../../server/grid-worker/host';
import {backendTerminator,independentLane} from '../../server/grid-worker/lanes';
import {registerGridWorkerAdminRoutes} from '../../server/grid-worker/admin-routes';
import {behaviourPolicy} from '../grid-bot/behaviour-fixtures';
import {quotaPolicyDigest} from '../../server/grid-worker/quota-policy';
import {exactTransitionReadback,type TransitionParams} from '../../server/grid-worker/host-transition';
import type {QuotaPolicy} from '../../server/grid-worker/quota';
vi.mock('../../server/grid-worker/owner-master-keys',()=>({OWNER_MASTER_PUBLIC_KEYS:['EXAMPLE_MASTER']}));
vi.mock('../../server/grid-worker/main-readiness-identity',async()=>{
  const {createHash}=await import('node:crypto');const hash=(s:string,n:string)=>createHash(n).update(s).digest('hex');
  return {mainReadinessIdentity:{commitHash:hash('EXAMPLE_COMMIT','sha1'),treeHash:hash('EXAMPLE_TREE','sha1'),lockfileSha256:hash('EXAMPLE_LOCK','sha256')}};
});
const diagnostics=vi.hoisted(()=>({transition:''}));
vi.mock('../../server/grid-worker/host-transition',async importOriginal=>{
  const actual=await importOriginal<typeof import('../../server/grid-worker/host-transition')>();
  return {...actual,transitionHost:async(...args:Parameters<typeof actual.transitionHost>)=>{try{return await actual.transitionHost(...args);}catch(e){const x=e as any;diagnostics.transition=JSON.stringify({message:x.message,code:x.code,detail:x.detail,hint:x.hint});throw e;}}};
});
const hash=(s:string,n='sha256')=>createHash(n).update(s).digest('hex');
const EXAMPLE=createPrivateKey({key:Buffer.concat([Buffer.from([48,46,2,1,0,48,5,6,3,43,101,112,4,34,4,32]),Buffer.alloc(32,7)]),format:'der',type:'pkcs8'});
const owner=bs58.encode(createPublicKey(EXAMPLE).export({type:'spki',format:'der'}).subarray(-32));
const schema='grid_u7a_'+randomUUID().replaceAll('-',''),isolate=gridWorkerIsolation();
let sessionOwner=owner,loseCommit=false;
let transitionAccounts:{account:string;master:string}[]=[];
let admin:Pool,pool:Pool,server:Server,url:string,terminate:(pid:number)=>Promise<void>,flat=true,age=0;
const tx=<T>(fn:(c:PoolClient)=>Promise<T>)=>fencedTransaction(pool,fn,{mode:'exclusive',terminate});
const params=():TransitionParams=>({executionMode:'external',runMode:'test',executionEnabled:false,legacyControlsEnabled:true,drainRequested:false,
  commitHash:hash('EXAMPLE_COMMIT','sha1'),treeHash:hash('EXAMPLE_TREE','sha1'),lockfileSha256:hash('EXAMPLE_LOCK'),expectedFencingEpoch:'0',expectedScopeRevision:'1'});
const policies=():QuotaPolicy[]=>['pacifica_rest','rpc_backup'].map(provider=>{
  const p:QuotaPolicy={provider:provider as QuotaPolicy['provider'],domain_id:'deployment',window_ms:60000,total_units:'1000',worker_limit_units:'500',worker_protective_reserve_units:'120',policy_digest:'EXAMPLE',valid_until:new Date(Date.now()+86400000)};
  return {...p,policy_digest:quotaPolicyDigest(p)};
});
async function post(path:string,body:unknown){const response=await fetch(url+'/api/grid-worker'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const text=await response.text();let parsed:any;try{parsed=JSON.parse(text);}catch{parsed={text};}return {status:response.status,body:parsed};}
async function signed(action:string,p:unknown){const challenge=await post('/challenge',{action,target:'all',params:p});expect(challenge.status).toBe(200);return {message:challenge.body.message,signature:bs58.encode(sign(null,Buffer.from(challenge.body.message),EXAMPLE))};}
beforeAll(async()=>{
  const connectionString=process.env.DATABASE_URL;if(!connectionString||new URL(connectionString).pathname!=='/qvtest')throw Error('FRACTAL qvtest required');
  admin=new Pool({connectionString,max:1});await admin.query('CREATE SCHEMA '+schema);
  pool=new Pool({connectionString,max:4,options:'-c search_path='+schema+',pg_catalog'});pool.on('connect',c=>{isolate(c);c.query=new Proxy(c.query,{apply(fn,self,args){const r=Reflect.apply(fn,self,args);return r&&typeof r.catch==='function'?r.then((v:unknown)=>{if(args[0]==='COMMIT'&&loseCommit){loseCommit=false;throw Error('EXAMPLE_COMMIT_REPLY_LOST');}return v;}).catch((e:Error&{code?:string;detail?:string;hint?:string})=>{e.message+=' [PostgreSQL code='+e.code+' DETAIL='+e.detail+' hint='+e.hint+']';throw e;}):r;}});c.on('error',()=>{});});pool.on('error',()=>{});
  for(const table of ['wallets','grid_bots','grid_operations','grid_control_requests','protocol_subaccounts','grid_launch_accounts','auth_nonces','grid_execution_claims'])await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
  await pool.query(readFileSync('migrations/grid_worker_v3_owner.sql','utf8').replaceAll('SET search_path = pg_catalog, public','SET search_path = pg_catalog, '+schema));
  const lane=independentLane(pool);terminate=backendTerminator({connect:async()=>isolate(await lane.connect())});
  const app=express();app.use(express.json());app.use((req,_res,next)=>{(req as any).session={walletAddress:sessionOwner};next();});
  registerGridWorkerAdminRoutes(app,(req,_res,next)=>{(req as any).walletAddress=owner;next();},{lane:pool,terminate,enabled:()=>true,entriesPaused:()=>false,readiness:async()=>true,ownerWallet:()=>owner,transitionEvidence:async()=>({accounts:transitionAccounts,flat,observedAt:Date.now()-age})});
  server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('EXAMPLE_LISTENER');url='http://127.0.0.1:'+address.port;
},30000);
beforeEach(async()=>{
  flat=true;age=0;sessionOwner=owner;loseCommit=false;transitionAccounts=[];
  await pool.query('TRUNCATE grid_worker_host,grid_worker_owner,grid_worker_wallet_authority,grid_worker_requests,grid_worker_reservations,grid_worker_send_audit,grid_worker_incidents,grid_worker_reconciliation,grid_worker_quota_windows,grid_worker_quota_policy,owner_action_receipts,auth_nonces,grid_execution_claims,grid_operations,grid_bots,grid_control_requests,grid_launch_accounts,protocol_subaccounts,wallets CASCADE');
  await tx(async c=>{
    await c.query('INSERT INTO wallets(address) VALUES($1)',[owner]);await c.query('INSERT INTO grid_worker_owner(wallet_address) VALUES($1)',[owner]);
    await c.query("INSERT INTO grid_worker_host(protocol_version,owner_wallet) VALUES('grid-worker-v3-a1-wire1',$1)",[owner]);
    await walletFences(c,[owner]);await c.query('INSERT INTO grid_worker_wallet_authority(wallet_address) VALUES($1)',[owner]);await localContext(c,'bootstrap_tracking');await c.query('UPDATE grid_worker_host SET authority_tracking_enabled=true');
    for(const p of policies())await c.query('INSERT INTO grid_worker_quota_policy(provider,domain_id,window_ms,total_units,worker_limit_units,worker_protective_reserve_units,policy_digest,valid_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[p.provider,p.domain_id,p.window_ms,p.total_units,p.worker_limit_units,p.worker_protective_reserve_units,p.policy_digest,p.valid_until]);
  });
});
afterAll(async()=>{if(server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}await pool?.end();if(admin){await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();}},30000);
it('uses a real challenge, signature, route and JSON string revisions for both forward transitions; replay refuses',async()=>{
  const p=params(),receipt=await signed('host_transition',p),result=await post('/host-transition',{...receipt,params:p});
  expect(result,diagnostics.transition).toMatchObject({status:200,body:{executionMode:'external',runMode:'test',executionEnabled:false,entriesPaused:true,fencingEpoch:'1',scopeRevision:'2'}});
  const {parseTransitionResult}=await import('../../server/grid-worker/transition-result');expect(parseTransitionResult(result.body).fencingEpoch).toBe('1');
  const h=(await pool.query('SELECT * FROM grid_worker_host')).rows[0];expect(exactTransitionReadback(h,p)).toBe(true);
  expect((await post('/host-transition',{...receipt,params:p})).status).not.toBe(200);
  const trading={...p,runMode:'trading',executionEnabled:true,expectedFencingEpoch:'1',expectedScopeRevision:'2'};
  const next=await post('/host-transition',{...await signed('host_transition',trading),params:trading});expect(next).toMatchObject({status:200,body:{runMode:'trading',entriesPaused:true,fencingEpoch:'2',scopeRevision:'3'}});
  expect((await pool.query('SELECT count(*) AS n FROM owner_action_receipts WHERE consumed_at IS NOT NULL')).rows[0].n).toBe('2');
});
it.each(['stale','not-flat','identity','direction','revision','policy-expired','unacknowledged-incident'])('refuses %s without changing host identity',async(reason)=>{
  const p=params();
  if(reason==='stale')age=5001;if(reason==='not-flat')flat=false;if(reason==='identity')p.commitHash=hash('EXAMPLE_OTHER','sha1');
  if(reason==='direction'){p.runMode='trading';p.executionEnabled=true;}if(reason==='revision')p.expectedScopeRevision='99';
  if(reason==='policy-expired')await pool.query("UPDATE grid_worker_quota_policy SET valid_until=clock_timestamp()-interval '1 second'");
  if(reason==='unacknowledged-incident')await pool.query("INSERT INTO grid_worker_incidents(id,code,severity,dedup_key,first_seen_at,last_seen_at) VALUES(gen_random_uuid(),'audit_mismatch','critical','balance-unexplained:EXAMPLE',clock_timestamp(),clock_timestamp())");
  expect((await post('/host-transition',{...await signed('host_transition',p),params:p})).status).not.toBe(200);
  expect((await pool.query('SELECT execution_mode FROM grid_worker_host')).rows[0].execution_mode).toBe('legacy');
});
it('replaces signed policies without refunding persisted spent units, then refuses receipt replay and tampering',async()=>{
  await pool.query("INSERT INTO grid_worker_quota_windows(provider,domain_id,window_ms,total_units,worker_limit_units,worker_protective_reserve_units,policy_digest,window_start,worker_used_units,observed_at) SELECT provider,domain_id,window_ms,total_units,worker_limit_units,worker_protective_reserve_units,policy_digest,to_timestamp(floor(extract(epoch FROM clock_timestamp())*1000/window_ms)*window_ms/1000),120,clock_timestamp() FROM grid_worker_quota_policy");
  const ps=policies(),p={policyDigests:ps.map(p=>p.policy_digest).sort()},r=await signed('quota_policy',p);
  expect((await post('/quota-policy',{...r,policies:ps})).status).toBe(200);
  expect((await pool.query('SELECT worker_used_units FROM grid_worker_quota_windows')).rows.every(r=>String(r.worker_used_units)==='120')).toBe(true);
  expect((await post('/quota-policy',{...r,policies:ps})).status).not.toBe(200);
  const receipt=await signed('quota_policy',p);ps[0].total_units='1001';expect((await post('/quota-policy',{...receipt,policies:ps})).status).not.toBe(200);
});

it('keeps non-owner routes hidden and refuses expired receipts',async()=>{
  sessionOwner='EXAMPLE_OTHER';expect((await post('/host-transition',{})).status).toBe(404);sessionOwner=owner;
  const p=params(),r=await signed('host_transition',p);await pool.query("UPDATE auth_nonces SET expires_at=clock_timestamp()-interval '1 second'");
  expect((await post('/host-transition',{...r,params:p})).status).not.toBe(200);
});
it('confirms an unknown commit only through exact durable readback',async()=>{
  const p=params(),r=await signed('host_transition',p);loseCommit=true;
  expect(await post('/host-transition',{...r,params:p})).toMatchObject({status:200,body:{readback:true,fencingEpoch:'1',scopeRevision:'2'}});
});
it('worker acquisition refuses legacy and succeeds only after transition commits; rollback is forbidden',async()=>{
  const {GridWorkerLease}=await import('../../server/grid-worker/lease');
  const lease=new GridWorkerLease(pool,independentLane(pool),terminate,async()=>true),bound={verified:true,milliseconds:0,skewMs:0};
  await expect(lease.acquire(randomUUID(),bound,async()=>true)).rejects.toThrow();
  const p=params();expect((await post('/host-transition',{...await signed('host_transition',p),params:p})).status).toBe(200);
  const acquired=await lease.acquire(randomUUID(),bound,async()=>true);expect(acquired.epoch).toBe('2');
  const next={...p,runMode:'trading',executionEnabled:true,expectedFencingEpoch:'2',expectedScopeRevision:'2'};
  expect((await post('/host-transition',{...await signed('host_transition',next),params:next})).status).not.toBe(200);
  const rollback={...p,executionMode:'legacy',expectedFencingEpoch:'2',expectedScopeRevision:'2'};
  expect((await post('/host-transition',{...await signed('host_transition',rollback),params:rollback})).status).not.toBe(200);
});

it.each(['active-other-wallet','legacy-holder'])('refuses %s while all supplied venue evidence is flat',async(reason)=>{
  const wallet='EXAMPLE_OTHER';
  await tx(async c=>{await walletFences(c,[wallet]);await c.query('INSERT INTO wallets(address) VALUES($1)',[wallet]);});
  const {levels,sizingVersion,safetyEnvelopePrice,gridPolicyExtension,...base}=behaviourPolicy('repeat_all');
  const record={...base,id:randomUUID(),walletAddress:wallet,clientRequestId:randomUUID(),serverIntentDigest:hash('EXAMPLE').toUpperCase(),draftRevision:'EXAMPLE',createIntent:{},authoritySnapshot:{},policyHmac:hash('EXAMPLE_POLICY'),protocolSubaccountId:1,name:'EXAMPLE',rangeSource:'manual',chartTimeframe:'1h',status:reason==='active-other-wallet'?'active':'stopped',leaseToken:reason==='legacy-holder'?randomUUID():null,leaseExpiresAt:reason==='legacy-holder'?new Date(Date.now()+60000):null};
  const snake=(s:string)=>s.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()),keys=Object.keys(record);
  await tx(async c=>{await walletFences(c,[wallet]);await identityFences(c,[record.id],[1]);await c.query("INSERT INTO protocol_subaccounts(id,wallet_address,protocol,protocol_subaccount_id,agent_public_key,status) VALUES(1,$1,'pacifica','EXAMPLE_CHILD','EXAMPLE_MASTER','grid_owned')",[wallet]);await c.query(`INSERT INTO grid_bots (${keys.map(snake).join(',')}) VALUES (${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(record));});
  transitionAccounts=[{account:'EXAMPLE_CHILD',master:'EXAMPLE_MASTER'}];
  const p=params();expect((await post('/host-transition',{...await signed('host_transition',p),params:p})).status).not.toBe(200);
  expect(diagnostics.transition).toContain('GRID_TRANSITION_LIABILITY');
});

it('refuses an outstanding legacy execution claim',async()=>{
  await pool.query("INSERT INTO grid_execution_claims(operation_id,bot_id,master_account,account,credits,slots,canary_increment) VALUES($1,$2,'EXAMPLE_MASTER','EXAMPLE_ACCOUNT',1,1,0)",[randomUUID(),randomUUID()]);
  const p=params();expect((await post('/host-transition',{...await signed('host_transition',p),params:p})).status).not.toBe(200);expect(diagnostics.transition).toContain('GRID_TRANSITION_LIABILITY');
});
it('refuses signed but expired quota policies',async()=>{
  const ps=policies().map(p=>({...p,valid_until:new Date(Date.now()-1000)}));for(const p of ps)p.policy_digest=quotaPolicyDigest(p);
  const p={policyDigests:ps.map(p=>p.policy_digest).sort()};expect((await post('/quota-policy',{...await signed('quota_policy',p),policies:ps})).status).not.toBe(200);
});
it('executes the exact filled P3 twice using execution-time buckets without refunding spent units',async()=>{
  await pool.query('DELETE FROM grid_worker_quota_policy');
  const sql=readFileSync('tests/fixtures/grid-worker-u7a/P3-QUOTA-HELD.sql','utf8');
  const c=await pool.connect();try{await c.query(sql);await c.query('UPDATE grid_worker_quota_windows SET worker_used_units=1');await c.query(sql);}finally{c.release();}
  const rows=(await pool.query('SELECT * FROM grid_worker_quota_windows')).rows;expect(rows).toHaveLength(2);expect(rows.every(r=>String(r.worker_used_units)==='1')).toBe(true);
  const {validateQuotaPolicies}=await import('../../server/grid-worker/quota-policy');const ps=(await pool.query('SELECT * FROM grid_worker_quota_policy')).rows;expect(()=>validateQuotaPolicies(ps,Date.now())).not.toThrow();
});
