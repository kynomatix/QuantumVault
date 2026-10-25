import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {Pool,type PoolClient} from 'pg';
import express from 'express';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {parseWorkerStatus,type WorkerStatus} from '../../client/src/lib/grid-worker-view';
import {GridWorkerStatusView} from '../../client/src/components/grid-bot/GridWorkerStatusView';
import {presentation} from '../helpers/grid-worker-u5b-fixtures';
import type {Server} from 'node:http';
import {createHash,createPrivateKey,createPublicKey,randomUUID,sign} from 'node:crypto';
import {readFileSync} from 'node:fs';
import bs58 from 'bs58';
import {gridWorkerIsolation} from '../helpers/grid-worker-isolation';
import {fencedTransaction,walletFences,hostFence,type ClientLane} from '../../server/grid-worker/transaction';
import {independentLane,backendTerminator} from '../../server/grid-worker/lanes';
import {localContext,tightenHost,acknowledgePause,acknowledgeCritical,legacyKillContext,resetPause} from '../../server/grid-worker/host';
import {GridWorkerLease,type WorkerLease} from '../../server/grid-worker/lease';
import {WorkerObserver} from '../../server/grid-worker/observer';
import {GridIncidents} from '../../server/grid-worker/incidents';
import {issueOwnerChallenge,verifyOwnerReceipt} from '../../server/grid-worker/owner-receipts';
import {parseOwnerMessage,serializeOwnerMessage} from '../../server/grid-worker/owner-auth';
import {adminStatus} from '../../server/grid-worker/admin-state';
import {registerGridWorkerAdminRoutes} from '../../server/grid-worker/admin-routes';
import {CRITICAL_PRIORITY,priorityIncident,resolveHealthyConditions} from '../../server/grid-worker/incident-policy';
import {behaviourPolicy} from '../grid-bot/behaviour-fixtures';
import {computeGridPolicyHmac} from '../../server/grid-bot/policy-hmac';
import {umk} from '../grid-bot/draft-fixtures';
import {relayMainEntriesPause} from '../../server/grid-worker/main-runtime';
import {publicSnapshot,healthStatus} from '../../server/grid-worker/status';
import {gridActionAllowed} from '../../server/grid-worker/kill';

const schema='grid_u5a_'+randomUUID().replaceAll('-',''),isolate=gridWorkerIsolation();
const fixtureSha256=createHash('sha256').update('EXAMPLE_U5A:'+randomUUID()).digest();
const EXAMPLE=createPrivateKey({key:Buffer.concat([Buffer.from([48,46,2,1,0,48,5,6,3,43,101,112,4,34,4,32]),fixtureSha256]),format:'der',type:'pkcs8'});
const owner=bs58.encode(createPublicKey(EXAMPLE).export({format:'der',type:'spki'}).subarray(-32));
const signed=(message:string)=>({message,signature:bs58.encode(sign(null,Buffer.from(message),EXAMPLE))});
let admin:Pool,pool:Pool,server:Server,url:string,enabled=true,flag=false,session=owner;
let terminate:(pid:number)=>Promise<void>,service:GridWorkerLease;
const lane=():ClientLane=>{const l=independentLane(pool);return {connect:async()=>{const c=isolate(await l.connect());diagnostics(c);return c;}};};
// Retain PostgreSQL diagnostics even when the runner only reports Error.message.
function diagnostics(c:PoolClient){c.query=new Proxy(c.query,{apply(fn,self,args){
  const result=Reflect.apply(fn,self,args);
  if(result&&typeof result.catch==='function')return result.catch((e:Error&{code?:string;detail?:string;hint?:string})=>{
    e.message+=' [PostgreSQL code='+String(e.code)+' DETAIL='+String(e.detail)+' hint='+String(e.hint)+']';throw e;
  });return result;
}});}
const tx=<T>(work:(c:PoolClient)=>Promise<T>,mode:'shared'|'exclusive'|'none'='shared')=>fencedTransaction(pool,work,{mode,terminate});
const challenge=(action:'pause'|'reset_pause'|'ack_critical'='pause',target='all')=>tx(c=>issueOwnerChallenge(c,owner,action,target));
const receipt=async(c:PoolClient,message:string)=>verifyOwnerReceipt(c,{...signed(message),signer:owner,sessionWallet:owner});
const api=async(path:string,body?:unknown)=>{
  const r=await fetch(url+'/api/grid-worker'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const text=await r.text();let data:Record<string,any>={};try{data=JSON.parse(text);}catch{/* 404 is deliberately uninformative. */}
  return {status:r.status,data,text,cache:r.headers.get('Cache-Control'),type:r.headers.get('Content-Type')};
};
async function external(){await tx(async c=>{
  await walletFences(c,[owner]);await c.query('INSERT INTO grid_worker_wallet_authority(wallet_address) VALUES($1)',[owner]);
  await localContext(c,'bootstrap_tracking');await c.query('UPDATE grid_worker_host SET authority_tracking_enabled=true');
  await localContext(c,'transition');await c.query("SELECT set_config('qv.grid_worker_owner_verified','true',true),set_config('qv.grid_worker_ready','true',true)");
  const digest=fixtureSha256.toString('hex');
  await c.query("UPDATE grid_worker_host SET execution_mode='external',run_mode='trading',execution_enabled=true,legacy_controls_enabled=true,commit_hash=$1,tree_hash=$1,lockfile_sha256=$2",[digest.slice(0,40),digest]);
},'exclusive');}
async function acquire(observer?:WorkerObserver){await external();return service.acquire(randomUUID(),{verified:true,milliseconds:0,skewMs:1000},async()=>{
  if(observer)await tx(c=>observer.acquire(c));return true;
});}
async function reset(){const m=await challenge('reset_pause');await tx(async c=>resetPause(c,await receipt(c,m),async()=>true,{remoteWorkerEnabled:true,entriesPaused:false}),'exclusive');}
async function maintenance(observer:WorkerObserver,holder:WorkerLease){const state=await tx(c=>observer.maintain(c,holder,async()=>true));observer.committed(state);return state;}
async function openCodes(){return (await pool.query("SELECT code FROM grid_worker_incidents WHERE severity='critical' AND (resolved_at IS NULL OR acknowledged_at IS NULL)")).rows.map(r=>String(r.code));}
beforeAll(async()=>{
  const connectionString=process.env.DATABASE_URL;if(!connectionString||new URL(connectionString).pathname!=='/qvtest')throw Error('FRACTAL qvtest required');
  admin=new Pool({connectionString,max:1});await admin.query('CREATE SCHEMA '+schema);
  // Fixture writes resolve to cloned private tables. Read-only catalog probes may inspect existing public epoch objects.
  pool=new Pool({connectionString,max:6,options:'-c search_path='+schema+',public,pg_catalog'});
  pool.on('connect',c=>{isolate(c);diagnostics(c);c.on('error',()=>{});});pool.on('error',()=>{});
  for(const table of ['wallets','grid_bots','grid_operations','grid_control_requests','grid_control_keys','protocol_subaccounts','grid_launch_accounts','auth_nonces','grid_monitor_state'])await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
  await pool.query(readFileSync('migrations/grid_worker_v3_owner.sql','utf8').replaceAll('SET search_path = pg_catalog, public','SET search_path = pg_catalog, '+schema));
  terminate=backendTerminator(lane());service=new GridWorkerLease(pool,lane(),terminate,async()=>true);
  const app=express();app.use(express.json({limit:'8kb'}));
  app.use((req,_res,next)=>{(req as unknown as {session:{walletAddress:string}}).session={walletAddress:session};next();});
  registerGridWorkerAdminRoutes(app,(req,_res,next)=>{(req as typeof req&{walletAddress:string}).walletAddress=session;next();},
    {lane:pool,terminate,enabled:()=>enabled,entriesPaused:()=>flag,readiness:async()=>true,ownerWallet:()=>owner});
  app.use((_req,res)=>{res.status(404).send('Unknown API');});
  server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();if(!address||typeof address==='string')throw Error('EXAMPLE_LISTENER');url='http://127.0.0.1:'+address.port;
},30000);
beforeEach(async()=>{
  enabled=true;flag=false;session=owner;
  await pool.query('TRUNCATE grid_worker_host,grid_worker_owner,grid_worker_wallet_authority,grid_worker_incidents,owner_action_receipts,auth_nonces,grid_control_keys,grid_control_requests,grid_operations,grid_monitor_state,grid_bots,wallets CASCADE');
  await tx(async c=>{await c.query('INSERT INTO wallets(address) VALUES($1)',[owner]);await c.query('INSERT INTO grid_worker_owner(wallet_address) VALUES($1)',[owner]);
    await c.query("INSERT INTO grid_worker_host(protocol_version,owner_wallet) VALUES('grid-worker-v3-a1-wire1',$1)",[owner]);},'exclusive');
});
afterAll(async()=>{if(server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}await pool?.end();if(admin){await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();}},30000);
describe('U5a observer and health truth on isolated PostgreSQL',()=>{
  it('arms a stale false fence, preserves running cycles, and requires fresh poll plus occurrence acknowledgment',async()=>{
    let now=1000;const observer=new WorkerObserver(()=>now),holder=await acquire();
    // First establish the previous holder-visible false value through the real CAS.
    observer.poll();await service.renew(holder,1000,true,true);await maintenance(observer,holder);
    expect((await pool.query('SELECT observer_fenced FROM grid_worker_host')).rows[0].observer_fenced).toBe(false);
    await tx(c=>observer.acquire(c));expect(observer.polledSinceAcquire).toBe(false);
    now+=300001;expect(await maintenance(observer,holder)).toBe('silent');
    expect(await openCodes()).toEqual(['observer_silent']);
    const h=(await pool.query('SELECT *,true AS holder_live FROM grid_worker_host')).rows[0];
    const context=legacyKillContext({...h,entries_paused:false},{role:'grid-worker',holderValid:true});
    expect(gridActionAllowed('cycle',context)).toBe(true);
    for(const action of ['start','resume'] as const)expect(gridActionAllowed(action,context)).toBe(false);
    expect((await pool.query('SELECT count(*) AS n FROM grid_operations')).rows[0].n).toBe('0');
    observer.poll();await service.renew(holder,1000,true,true);await maintenance(observer,holder);
    expect((await pool.query('SELECT observer_fenced FROM grid_worker_host')).rows[0].observer_fenced).toBe(true);
    const id=(await pool.query('SELECT id FROM grid_worker_incidents')).rows[0].id;
    const m=await challenge('ack_critical','incident:'+id);await tx(async c=>acknowledgeCritical(c,await receipt(c,m),id),'exclusive');
    await maintenance(observer,holder);expect(await openCodes()).toEqual([]);
    expect((await pool.query('SELECT observer_fenced FROM grid_worker_host')).rows[0].observer_fenced).toBe(false);
    // A spoofed poll never changes the holder or epoch; the CAS refuses a foreign holder.
    await tx(c=>tightenHost(c,{observer:true}));observer.poll();
    await expect(maintenance(observer,{...holder,bootId:randomUUID()})).rejects.toThrow('GRID_OBSERVER_CLEAR_INVALID');
  });
  it('all fifteen critical codes survive acknowledgment, recurrence reopens or creates a fresh occurrence',async()=>{
    const writer=new GridIncidents(pool,terminate),now=Date.now();expect(CRITICAL_PRIORITY).toHaveLength(15);
    for(const code of CRITICAL_PRIORITY){
      expect(await writer.record({code,dedupKey:'EXAMPLE:'+code})).toBe(true);
      const incidentCode=priorityIncident(await openCodes());
      expect(healthStatus(publicSnapshot({standby:false,database:true,inControl:true,test:false,paused:false,critical:true,incidentCode,reconciled:true,renewalAt:now,passAt:now,botCheckTimes:[],waiting:0,running:0,commitHash:'EXAMPLE'},now))).toBe(503);
      await pool.query('UPDATE grid_worker_incidents SET acknowledged_at=clock_timestamp(),acknowledged_by=$1 WHERE code=$2',[owner,code]);
      expect(await openCodes()).toContain(code);
    }
    await pool.query("UPDATE grid_worker_incidents SET resolved_at=clock_timestamp() WHERE code='observer_silent'");
    await writer.record({code:'observer_silent',dedupKey:'EXAMPLE:observer_silent'});
    expect((await pool.query("SELECT count(*) AS n FROM grid_worker_incidents WHERE code='observer_silent'")).rows[0].n).toBe('2');
    await pool.query("UPDATE grid_worker_incidents SET resolved_at=clock_timestamp() WHERE code='observer_silent' AND acknowledged_at IS NULL");
    await writer.record({code:'observer_silent',dedupKey:'EXAMPLE:observer_silent'});
    expect((await pool.query("SELECT resolved_at FROM grid_worker_incidents WHERE code='observer_silent' AND acknowledged_at IS NULL")).rows[0].resolved_at).toBeNull();
    await tx(c=>resolveHealthyConditions(c,{progress:true,reconciled:true}));
    expect(await openCodes()).toContain('observer_silent');expect(await openCodes()).toContain('audit_mismatch');expect(await openCodes()).not.toContain('progress_stale');
  });
  it('returns current pause gates at renewal, skips stale reset revisions, and re-latches flags without auto-reset',async()=>{
    const holder=await acquire();await reset();await tx(c=>tightenHost(c,{pause:true}));
    const renewed=await service.renew(holder,1000,true);expect(renewed.entries_paused).toBe(true);
    await tx(c=>acknowledgePause(c,holder,renewed.pause_revision));
    expect((await service.renew(holder,1000,true)).pause_ack_revision).toBe(renewed.pause_revision);
    await reset();await expect(tx(c=>acknowledgePause(c,holder,renewed.pause_revision))).rejects.toThrow('GRID_PAUSE_ACK_INVALID');
    expect(await service.renew(holder,1000,true)).toMatchObject({entries_paused:false,pause_ack_revision:null});
    await tx(c=>tightenHost(c,{pause:true}));const a=await service.renew(holder,1000,true);await tx(c=>tightenHost(c,{pause:true}));
    expect((await service.renew(holder,1000,true)).pause_revision).toBe(a.pause_revision);
  });
});
describe('U5a owner API uses signed receipt transactions',()=>{
  it('is dormant and hides every route from nonowners',async()=>{
    for(const inactive of [true,false]){enabled=!inactive;session=inactive?owner:'EXAMPLE_NONOWNER';
      for(const [path,body] of [['/status',undefined],['/challenge',{}],['/pause',{}],['/reset-pause',{}],['/incidents/'+randomUUID()+'/ack',{}],['/incidents/seen',{}]] as const)
        expect(await api(path,body)).toEqual(await api('/unknown',body));
    }
  });
  it('validates the route challenge and rejects malformed, altered, noncanonical and stale receipt vectors atomically',async()=>{
    const good=await api('/challenge',{action:'pause',target:'all',expectedPauseRevision:'0'});expect(good.status).toBe(200);expect(good.data.expectedPauseRevision).toBe('0');const message=String(good.data.message),m=parseOwnerMessage(message);
    expect(Date.parse(m.expires)-Date.parse(m.issued)).toBe(120000);
    const malformed=[message+'\n',message+' ',message.replaceAll('\n','\r\n'),message.replace('scope:grid_worker','scope:other'),
      message.replace('action:pause\nscope:grid_worker','scope:grid_worker\naction:pause'),message.replace('target:all','target:ALL'),
      message.replace('params:none','params:None'),message.replace('params:none','params:'+fixtureSha256.toString('hex')),
      message.replace('QV-OWNER-ACTION v1','QV-OWNER-ACTION v1\u0000'),message.replace('target:all','target:host:example'),
      serializeOwnerMessage({...m,action:'reset_pause'}),serializeOwnerMessage({...m,expires:new Date(Date.parse(m.issued)+120001).toISOString()}),
      serializeOwnerMessage({...m,expires:new Date(Date.parse(m.issued)+300001).toISOString()}),
      serializeOwnerMessage({...m,issued:new Date(Date.now()+1000).toISOString(),expires:new Date(Date.now()+121000).toISOString()}),
      message.replace('params:none','params:'+fixtureSha256.toString('hex').toUpperCase())];
    for(const text of malformed)expect((await api('/pause',signed(text))).status,text).toBe(409);
    expect((await api('/pause',{...signed(message),signature:'EXAMPLE'})).status).toBe(409);
    expect((await api('/pause',{...signed(message),params:'{"extra":true}'})).status).toBe(400);
    await pool.query("UPDATE auth_nonces SET created_at=created_at-interval '3 minutes',expires_at=expires_at-interval '3 minutes'");
    expect((await api('/pause',signed(message))).status).toBe(409);
    expect((await pool.query('SELECT count(*) AS n FROM owner_action_receipts')).rows[0].n).toBe('0');
    expect((await pool.query('SELECT pause_revision FROM grid_worker_host')).rows[0].pause_revision).toBe('0');
  });
  it('resets only with a valid reset receipt and rejects unresolved critical occurrences',async()=>{
    const message=await challenge('reset_pause');
    expect((await api('/reset-pause',{...signed(message),expectedPauseRevision:'0'})).status).toBe(200);
    expect((await pool.query('SELECT entries_paused FROM grid_worker_host')).rows[0].entries_paused).toBe(false);
    await tx(c=>tightenHost(c,{pause:true}));
    await new GridIncidents(pool,terminate).record({code:'observer_silent',dedupKey:'EXAMPLE_RESET'});
    expect((await api('/reset-pause',{...signed(await challenge('reset_pause')),expectedPauseRevision:String((await pool.query('SELECT pause_revision FROM grid_worker_host')).rows[0].pause_revision)})).status).toBe(409);
    expect((await pool.query('SELECT entries_paused FROM grid_worker_host')).rows[0].entries_paused).toBe(true);
  });
  it('pause waits through an in-flight five second shared POST fence, observes renewal ack, and rejects replay',async()=>{
    const holder=await acquire(),message=await challenge();let release!:()=>void;const entered=new Promise<void>(r=>{release=r;});
    const start=Date.now();
    const post=tx(async c=>{await c.query("SET LOCAL statement_timeout='7s'");release();await c.query('SELECT pg_sleep(5)');});
    await entered;
    const response=api('/pause',signed(message));
    const renew=(async()=>{await new Promise(r=>setTimeout(r,250));expect(await service.renew(holder,1000,true)).toMatchObject({bootId:holder.bootId});
      await new Promise(r=>setTimeout(r,5200));await tx(async c=>{const h=(await c.query('SELECT pause_revision FROM grid_worker_host')).rows[0];await acknowledgePause(c,holder,String(h.pause_revision));});})();
    const [result]=await Promise.all([response,post,renew]);expect(result.status,JSON.stringify(result.data)).toBe(200);
    expect(result.data).toMatchObject({latched:true,saved:true,acknowledgementOutcome:'confirmed',acknowledged:true,unknown:false,cancellationsComplete:true});
    expect(Date.now()-start).toBeGreaterThanOrEqual(5000);expect(Date.now()-start).toBeLessThan(20000);
    expect((await api('/pause',signed(message))).status).toBe(409);
  },25000);
  it.each(['stale','consumed','digest'])('database rejects a %s verified receipt with 409 and rolls back the pause',async variant=>{
    const assignment=variant==='stale'?"NEW.verified_at:=clock_timestamp()-interval '61 seconds';":variant==='digest'?
      "NEW.message_digest:=encode(sha256(convert_to('EXAMPLE_WRONG_DIGEST','UTF8')),'hex');":"NEW.consumed_at:=clock_timestamp();NEW.consumed_by:='EXAMPLE';";
    await pool.query(`CREATE OR REPLACE FUNCTION fixture_receipt() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN ${assignment} RETURN NEW; END $body$`);
    await pool.query('CREATE TRIGGER fixture_receipt BEFORE INSERT ON owner_action_receipts FOR EACH ROW EXECUTE FUNCTION fixture_receipt()');
    try{const response=await api('/pause',signed(await challenge()));expect(response.status).toBe(409);expect(response.data.latched).toBe(false);expect(response.data.saved).toBe(false);
      expect((await pool.query('SELECT pause_revision FROM grid_worker_host')).rows[0].pause_revision).toBe('0');
      expect(await openCodes()).toEqual([]);
    }finally{await pool.query('DROP TRIGGER fixture_receipt ON owner_action_receipts');}
  });
  it('reports an unacknowledged committed pause as unknown within twenty seconds',async()=>{
    await acquire();const message=await challenge(),start=Date.now(),response=await api('/pause',signed(message));
    expect(Date.now()-start).toBeLessThan(20000);expect(response.status).toBe(503);
    expect(response.data).toMatchObject({latched:true,saved:true,acknowledgementOutcome:'not_confirmed',acknowledged:false,unknown:true,incidentRecorded:true,cancellationsComplete:null});
    expect(await openCodes()).toEqual(['pause_unacknowledged']);
  },25000);
  it('acknowledges only the signed occurrence, seen needs no signature, and MAIN flag blocks reset',async()=>{
    const writer=new GridIncidents(pool,terminate);await writer.record({code:'observer_silent',dedupKey:'EXAMPLE_API'});
    const id=(await pool.query('SELECT id FROM grid_worker_incidents')).rows[0].id;
    const message=await challenge('ack_critical','incident:'+id);
    expect((await api('/incidents/'+randomUUID()+'/ack',signed(message))).status).toBe(409);
    expect((await api('/incidents/'+id+'/ack',signed(message))).status).toBe(200);
    expect(await openCodes()).toEqual(['observer_silent']);
    expect((await api('/incidents/seen',{ids:[id]})).status).toBe(200);
    expect((await pool.query('SELECT inbox_seen_at FROM grid_worker_incidents')).rows[0].inbox_seen_at).not.toBeNull();
    flag=true;expect((await api('/reset-pause',{...signed(await challenge('reset_pause')),expectedPauseRevision:String((await pool.query('SELECT pause_revision FROM grid_worker_host')).rows[0].pause_revision)})).status).toBe(409);
  });
});

describe('U5a R2 revision and MAIN relay contracts',()=>{
  it('legacy pause returns immediately without inventing a worker acknowledgement incident',async()=>{
    const start=Date.now(),response=await api('/pause',signed(await challenge()));
    expect(response.status).toBe(200);expect(response.data).toMatchObject({latched:true,acknowledged:null,unknown:false});
    expect(Date.now()-start).toBeLessThan(3000);expect(await openCodes()).toEqual([]);
  });
  it('rejects stale challenge and reset revisions before consuming a receipt',async()=>{
    expect((await api('/challenge',{action:'reset_pause',target:'all',expectedPauseRevision:'1'})).status).toBe(409);
    const message=await challenge('reset_pause');
    expect((await api('/reset-pause',{...signed(message),expectedPauseRevision:'1'})).status).toBe(409);
    expect((await pool.query('SELECT count(*) AS n FROM owner_action_receipts')).rows[0].n).toBe('0');
  });
  it('MAIN flag alone latches the DB pause observed by the external worker and clearing it never resets',async()=>{
    const holder=await acquire();await reset();
    await relayMainEntriesPause(pool,terminate,false);expect((await service.renew(holder,1000,true)).entries_paused).toBe(false);
    await relayMainEntriesPause(pool,terminate,true);const paused=await service.renew(holder,1000,true);expect(paused.entries_paused).toBe(true);
    await relayMainEntriesPause(pool,terminate,false);expect((await service.renew(holder,1000,true)).pause_revision).toBe(paused.pause_revision);
    expect((await service.renew(holder,1000,true)).entries_paused).toBe(true);
  });
  it('resolves pause timeout only for current revision acknowledgement, retaining the acknowledgement requirement',async()=>{
    const holder=await acquire();await new GridIncidents(pool,terminate).record({code:'pause_unacknowledged',dedupKey:'EXAMPLE_ACK'});
    await tx(c=>resolveHealthyConditions(c,{progress:false,reconciled:false}));
    expect((await pool.query("SELECT resolved_at FROM grid_worker_incidents WHERE code='pause_unacknowledged'")).rows[0].resolved_at).toBeNull();
    const h=await service.renew(holder,1000,true);await tx(c=>acknowledgePause(c,holder,h.pause_revision));
    await tx(c=>resolveHealthyConditions(c,{progress:false,reconciled:false}));
    const incident=(await pool.query("SELECT resolved_at,acknowledged_at FROM grid_worker_incidents WHERE code='pause_unacknowledged'")).rows[0];
    expect(incident.resolved_at).not.toBeNull();expect(incident.acknowledged_at).toBeNull();
  });
  it('status has no host lock, provides DB ages, and retains critical cards above old seen warnings',async()=>{
    const writer=new GridIncidents(pool,terminate);
    await writer.record({code:'exposure_above_budget',dedupKey:'EXAMPLE_WARNING'});
    await writer.record({code:'stop_failed',dedupKey:'EXAMPLE_CRITICAL'});
    await pool.query("UPDATE grid_worker_incidents SET inbox_seen_at=clock_timestamp(),first_seen_at=clock_timestamp()-interval '26 hours',last_seen_at=clock_timestamp()-interval '25 hours' WHERE severity='warning'");
    await tx(c=>adminStatus(c,false),'none');
    const c=await pool.connect();await c.query('BEGIN');await hostFence(c,'exclusive');
    try{const response=await api('/status');expect(response.status,JSON.stringify(response.data)).toBe(200);
      expect(response.data.incidents.map((i:{code:string})=>i.code)).toEqual(['stop_failed']);
      expect(response.data).toMatchObject({cardState:'exec_off',executionMode:'legacy',entriesPaused:true,pauseRevision:'0',cancellationsComplete:true,botsPaused:{total:0,paused:0}});
      expect(response.data.resetBlockedBy).not.toContain('worker_checks');expect(response.data.resetBlockedBy).not.toContain('monitor_fence');
      expect(response.data.ages.observedAt).toBeTruthy();expect(response.data.host).toHaveProperty('holder_live');
      expect(response.data.incidents[0]).toMatchObject({occurrence_count:'1',acknowledged:false,seen:false,bot_id:null});
    }finally{await c.query('ROLLBACK');c.release();}
  });
});

it('counts paused positions as at risk and cancellations only for the current pause revision',async()=>{
  const ids:string[]=[];
  for(const [status,position] of [['paused','1'],['paused','0'],['active','0']] as const){
    const policy={...behaviourPolicy('repeat_all','long',false),id:randomUUID()},mac=computeGridPolicyHmac(policy,umk());
    if(!mac.ok)throw Error('EXAMPLE_POLICY');
    const {levels,sizingVersion,safetyEnvelopePrice,gridPolicyExtension,...base}=policy;
    const row={...base,status,protocolSubaccountId:1,walletAddress:owner,clientRequestId:randomUUID(),serverIntentDigest:fixtureSha256.toString('hex').toUpperCase(),
      draftRevision:'EXAMPLE',createIntent:{},authoritySnapshot:{gridSizing:{sizingVersion,safetyEnvelopePrice},gridPolicyExtension},policyHmac:mac.digest,rangeSource:'manual',chartTimeframe:'15m'};
    const entries=Object.entries(row);await pool.query(`INSERT INTO grid_bots(${entries.map(([k])=>k.replace(/[A-Z]/g,c=>'_'+c.toLowerCase())).join(',')}) VALUES(${entries.map((_,i)=>'$'+(i+1)).join(',')})`,entries.map(([,v])=>v));
    await pool.query('INSERT INTO grid_monitor_state(bot_id,observation) VALUES($1,$2::jsonb)',[policy.id,JSON.stringify({position:{size:position}})]);ids.push(policy.id);
  }
  const complete=async(botId:string,revision:string)=>{
    const id=randomUUID(),key=`host-pause:${revision}:${botId}`;
    await pool.query("INSERT INTO grid_control_requests(id,bot_id,request_key,action,source,previous_status,evidence,state,completed_at) VALUES($1,$2,$3,'pause','risk','active','{}','complete',clock_timestamp())",[id,botId,key]);
    await pool.query("INSERT INTO grid_control_keys(bot_id,request_key,control_id,evidence) VALUES($1,$2,$3,'{}')",[botId,key,id]);
  };
  await complete(ids[0],'0');await complete(ids[1],'1');
  const response=await api('/status');expect(response.status).toBe(200);
  expect(response.data).toMatchObject({gridBotsAtRisk:2,botsPaused:{total:3,paused:1},cancellationsComplete:false});
  await complete(ids[1],'0');await complete(ids[2],'0');
  expect((await api('/status')).data).toMatchObject({botsPaused:{total:3,paused:3},cancellationsComplete:true});
});

it('U5b exposes stored acknowledgement capability, complete critical totals and list truncation',async()=>{
  const writer=new GridIncidents(pool,terminate);
  for(let n=0;n<102;n++)await writer.record({code:'stop_failed',dedupKey:'EXAMPLE_U5B:'+n});
  await pool.query("UPDATE grid_worker_incidents SET acknowledged_at=clock_timestamp(),acknowledged_by=$1 WHERE id=(SELECT id FROM grid_worker_incidents LIMIT 1)",[owner]);
  const payload=await tx(c=>adminStatus(c,false),'none');
  expect(payload.incidents).toHaveLength(100);expect(payload.truncated).toBe(true);
  expect(payload.unacknowledgedCritical).toBe(101);expect(payload.acknowledgedCritical).toBe(1);
  for(const row of payload.incidents)expect(row.canAcknowledge).toBe(!row.acknowledged);
  expect(payload.executionRestrictions).toEqual(['trading_off','test','limits_unavailable']);expect(payload.stopsAllowed).toBe(false);expect(typeof payload.stopsAllowed).toBe('boolean');
  await pool.query("DELETE FROM grid_worker_incidents");
  await pool.query("INSERT INTO grid_worker_incidents(id,dedup_key,severity,code,first_seen_at,last_seen_at) VALUES($1,'EXAMPLE_U5B_STORED_WARNING','warning','stop_failed',clock_timestamp(),clock_timestamp())",[randomUUID()]);
  const downgraded=await tx(c=>adminStatus(c,false),'none');
  expect(downgraded.incidents[0]).toMatchObject({severity:'critical',canAcknowledge:false});
  expect(downgraded.unacknowledgedCritical).toBe(1);expect(downgraded.truncated).toBe(false);
});

// The client consumes the real route JSON, including PostgreSQL int8/numeric strings.
async function legacyControls(){await tx(async c=>{
  const digest=fixtureSha256.toString('hex');
  await localContext(c,'transition');
  await c.query("SELECT set_config('qv.grid_worker_owner_verified','true',true),set_config('qv.grid_worker_ready','true',true)");
  await c.query("UPDATE grid_worker_host SET run_mode='trading',execution_enabled=true,legacy_controls_enabled=true,commit_hash=$1,tree_hash=$1,lockfile_sha256=$2",[digest.slice(0,40),digest]);
},'exclusive');}
async function wireStatus(){
  const response=await api('/status');expect(response.status,JSON.stringify(response.data)).toBe(200);return response.data;
}
function parsedCard(raw:unknown,cardState:string,pill:string,names:ReadonlyMap<string,string>=new Map()):WorkerStatus {
  const parsed=parseWorkerStatus(JSON.parse(JSON.stringify(raw)));
  expect(parsed).not.toBeNull();expect(parsed!.cardState).toBe(cardState);
  const html=renderToStaticMarkup(React.createElement(GridWorkerStatusView,{state:presentation({status:parsed}),names,canSign:true,expanded:true}));
  expect(html).toContain(pill);expect(html).not.toContain('Not checked recently');return parsed!;
}
async function boundaryBot(){
  const policy={...behaviourPolicy('repeat_all','long',false),id:randomUUID()},mac=computeGridPolicyHmac(policy,umk());
  if(!mac.ok)throw Error('EXAMPLE_POLICY');
  const {levels,sizingVersion,safetyEnvelopePrice,gridPolicyExtension,...base}=policy;
  const row={...base,status:'paused',protocolSubaccountId:1,walletAddress:owner,clientRequestId:randomUUID(),serverIntentDigest:fixtureSha256.toString('hex').toUpperCase(),
    draftRevision:'EXAMPLE',createIntent:{},authoritySnapshot:{gridSizing:{sizingVersion,safetyEnvelopePrice},gridPolicyExtension},policyHmac:mac.digest,rangeSource:'manual',chartTimeframe:'15m'};
  const entries=Object.entries(row);
  await pool.query(`INSERT INTO grid_bots(${entries.map(([k])=>k.replace(/[A-Z]/g,c=>'_'+c.toLowerCase())).join(',')}) VALUES(${entries.map((_,i)=>'$'+(i+1)).join(',')})`,entries.map(([,v])=>v));
  return policy.id;
}
describe('U5b real PostgreSQL to client markup boundary',()=>{
  it('round-trips no incidents with all numeric fields from the status route',async()=>{
    await legacyControls();await reset();const raw=await wireStatus();
    // This isolated fixture intentionally lacks the complete migration capability catalog.
    const parsed=parsedCard(raw,'attention_open','Needs attention');
    expect(parsed.incidents).toEqual([]);expect(parsed.incidentCounts).toEqual({});
    expect(parsed).toMatchObject({unacknowledgedCritical:0,acknowledgedCritical:0,gridBotsAtRisk:0,botsPaused:{paused:0,total:0},pauseAckRevision:null});
  });
  it('round-trips a critical occurrence with a real bot reference and PostgreSQL bigint count',async()=>{
    await legacyControls();const botId=await boundaryBot();
    expect(await new GridIncidents(pool,terminate).record({code:'stop_failed',botId,dedupKey:'EXAMPLE_BOUNDARY_BOT'})).toBe(true);
    const raw=await wireStatus();expect(raw.incidents[0]).toMatchObject({occurrence_count:'1',bot_id:botId});
    expect(typeof raw.incidents[0].first_seen_seconds).toBe('string');
    const parsed=parsedCard(raw,'needs_you','Needs you',new Map([[botId,'Evening grid']]));
    expect(parsed.incidents[0]).toMatchObject({occurrence_count:1,bot_id:botId,canAcknowledge:true});
    expect(typeof parsed.incidents[0].first_seen_seconds).toBe('number');
    const html=renderToStaticMarkup(React.createElement(GridWorkerStatusView,{state:presentation({status:parsed}),names:new Map([[botId,'Evening grid']]),canSign:true,expanded:true}));
    expect(html).toContain('Evening grid');expect(html).not.toContain(botId);
  });
  it.each(['warning','critical'])('round-trips a future unknown code stored at %s through real state SQL',async severity=>{
    await legacyControls();
    // The current package deliberately forbids future codes. A transaction-local TEMP
    // fixture models a future producer without changing any package or persistent table.
    const raw=await tx(async c=>{
      await c.query(`CREATE TEMP TABLE grid_worker_incidents (LIKE ${schema}.grid_worker_incidents INCLUDING DEFAULTS) ON COMMIT DROP`);
      await c.query("INSERT INTO grid_worker_incidents(id,dedup_key,severity,code,first_seen_at,last_seen_at) VALUES($1,'EXAMPLE_FUTURE',$2,'EXAMPLE_FUTURE_CODE',clock_timestamp(),clock_timestamp())",[randomUUID(),severity]);
      return adminStatus(c,false);
    },'none');
    const parsed=parsedCard(raw,'needs_you','Needs you');
    expect(parsed.incidents[0]).toMatchObject({severity:'critical',canAcknowledge:severity==='critical',occurrence_count:1});
    expect(parsed.resetBlockedBy).toContain('open_alert');
    const html=renderToStaticMarkup(React.createElement(GridWorkerStatusView,{state:presentation({status:parsed}),names:new Map(),canSign:true,expanded:true}));
    expect(html).not.toContain('EXAMPLE_FUTURE_CODE');if(severity==='warning')expect(html).toContain('Review needed');
  });
  it('round-trips the truncated list while retaining global totals',async()=>{
    await legacyControls();
    await pool.query("INSERT INTO grid_worker_incidents(id,dedup_key,severity,code,first_seen_at,last_seen_at) SELECT gen_random_uuid(),'EXAMPLE_BOUNDARY_'||n,'critical','stop_failed',clock_timestamp(),clock_timestamp() FROM generate_series(1,102) n");
    await pool.query("UPDATE grid_worker_incidents SET acknowledged_at=clock_timestamp(),acknowledged_by=$1 WHERE id=(SELECT id FROM grid_worker_incidents LIMIT 1)",[owner]);
    const parsed=parsedCard(await wireStatus(),'needs_you','Needs you');
    expect(parsed.incidents).toHaveLength(100);expect(parsed).toMatchObject({truncated:true,unacknowledgedCritical:101,acknowledgedCritical:1,incidentCounts:{critical:102}});
  });
  it('round-trips legacy paused without a worker acknowledgement',async()=>{
    await legacyControls();const parsed=parsedCard(await wireStatus(),'legacy_paused','New activity paused');
    expect(parsed).toMatchObject({entriesPaused:true,pauseRevision:'0',pauseAckRevision:null});
  });
  it('round-trips pause_unconfirmed without inventing an elapsed timeout',async()=>{
    await acquire();const parsed=parsedCard(await wireStatus(),'pause_unconfirmed','Pause not confirmed');
    const html=renderToStaticMarkup(React.createElement(GridWorkerStatusView,{state:presentation({status:parsed}),names:new Map(),canSign:true}));
    expect(html).toContain('Not confirmed yet');expect(html).not.toContain('Not after 20 s');
  });
});
