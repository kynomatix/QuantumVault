import type {Express,RequestHandler} from 'express';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {fencedTransaction,GridDeadline,type ClientLane} from './transaction';
import {issueOwnerChallenge,verifyOwnerReceipt,requireVerifiedOwner} from './owner-receipts';
import {acknowledgeCritical,pauseHost,resetPause} from './host';
import {GridIncidents} from './incidents';
import {adminStatus,readAdminFacts,resetBlockedBy} from './admin-state';
import {mainOwnerWallet} from './main-runtime';
import {registerRescueRoutes,type RescueService} from './rescue-routes';
import {rescueOffer} from './rescue-state';

export function pauseSaveOutcome(mutationStarted:boolean,revision:string|undefined){
  return {saved:revision?true:mutationStarted?'unknown' as const:false,
    acknowledgementOutcome:'not_confirmed' as const};
}

const action=z.enum(['pause','reset_pause','ack_critical']);
const target=z.union([z.literal('all'),z.string().regex(/^incident:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)]);
const revision=z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
const challenge=z.object({action,target,expectedPauseRevision:revision}).strict();
const rescueChallenge=z.object({action:z.literal('break_glass_close'),target:z.string().regex(/^bot:[0-9a-f-]{36}$/),params:z.object({botId:z.string().uuid().regex(/^[0-9a-f-]+$/)}).strict()}).strict();
const signed=z.object({message:z.string().max(2048),signature:z.string().max(128)}).strict();
const incidentId=z.string().uuid().regex(/^[0-9a-f-]+$/);
export interface AdminDependencies {
  lane:ClientLane;terminate:(pid:number)=>Promise<void>;
  enabled:()=>boolean;entriesPaused:()=>boolean;
  readiness:(c:PoolClient)=>Promise<boolean>;
  ownerWallet:()=>string|null;
  rescue?:RescueService;
}
/** Uses the same production predicates as the status response; no venue calls. */
export async function ownerResetReady(c:PoolClient):Promise<boolean>{
  return resetBlockedBy(await readAdminFacts(c),process.env.GRID_ENTRIES_PAUSED==='true').length===0;
}
async function production():Promise<AdminDependencies>{
  const [{pool},{independentLane,backendTerminator}]=await Promise.all([import('../db'),import('./lanes')]);
  const lane=independentLane(pool);
  const [{ProtectiveExecutor},{workerDependencies},{mainQuota},{probeGridWorkerSchema},{mainIdentityMatches},{OWNER_MASTER_PUBLIC_KEYS}]=await Promise.all([
    import('./protective-executor'),import('./dependencies'),import('./main-quota'),import('./boot'),import('./main-readiness-identity'),import('./owner-master-keys')]);
  const terminate=backendTerminator(independentLane(pool));
  const rescue=new ProtectiveExecutor(pool,terminate,workerDependencies(pool,{
    debit:async(provider,units)=>mainQuota.debit(provider,units),rateLimited:async provider=>mainQuota.rateLimited(provider),
  },process.env),async c=>{
    // The catalog probe owns BEGIN/COMMIT; never run it on the takeover/step connection.
    const probe=await lane.connect();
    try{await probeGridWorkerSchema((text,values)=>probe.query(text,values?[...values]:undefined));}finally{probe.release();}
    const h=(await c.query('SELECT * FROM grid_worker_host WHERE singleton_id=1')).rows[0];
    if(!h||h.execution_mode!=='external'||!mainIdentityMatches(h)||OWNER_MASTER_PUBLIC_KEYS.length===0)throw Error('GRID_RESCUE_NOT_READY');
  });
  return {lane,terminate:backendTerminator(independentLane(pool)),enabled:()=>process.env.GRID_REMOTE_WORKER_ENABLED==='true',
    entriesPaused:()=>process.env.GRID_ENTRIES_PAUSED==='true',readiness:ownerResetReady,ownerWallet:mainOwnerWallet,rescue};
}
/** MAIN only. Registration does not load the database or expose an enabled control. */
export function registerGridWorkerAdminRoutes(app:Express,requireWallet:RequestHandler,provided?:AdminDependencies){
  const enabled=()=>provided?provided.enabled():process.env.GRID_REMOTE_WORKER_ENABLED==='true';
  const off:RequestHandler=(req,res,next)=>{
    const session=(req as typeof req & {session?:{walletAddress?:string}}).session?.walletAddress;
    const owner=provided?provided.ownerWallet():mainOwnerWallet();
    // Fall through exactly as an unknown API path, before auth or a DB checkout.
    if(!enabled()||!owner||session!==owner){next('route');return;}
    res.set('Cache-Control','no-store');next();
  };
  const route=(method:'get'|'post',path:string,run:(c:PoolClient,wallet:string,body:unknown,id:unknown,d:AdminDependencies,mutating:()=>void)=>Promise<unknown>,pause=false)=>{
    app[method]('/api/grid-worker'+path,off,requireWallet,async(req,res,next)=>{
      const overall=new GridDeadline(20_000);let d:AdminDependencies|undefined,revision:string|undefined;
      let admitted=false,mutationStarted=false,external=false;
      try{
        d=provided??await production();
        const wallet=(req as typeof req & {walletAddress:string}).walletAddress;
        const result=await fencedTransaction(d.lane,async c=>{
          if(method==='get')await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
          const owner=(await c.query(`SELECT o.wallet_address,h.execution_mode FROM grid_worker_owner o JOIN grid_worker_host h
            ON h.singleton_id=o.singleton_id AND h.owner_wallet=o.wallet_address
            WHERE o.singleton_id=1`)).rows[0];
          if(!owner||owner.wallet_address!==wallet)throw Error('GRID_ADMIN_NOT_FOUND');
          admitted=true;external=owner.execution_mode==='external';
          return run(c,wallet,req.body,req.params.id,d!,()=>{mutationStarted=true;});
        },{mode:method==='get'?'none':'exclusive',pause,terminate:d.terminate,budget:new GridDeadline(pause?Math.min(9000,overall.remaining()):Math.min(18000,overall.remaining()))});
        if(!pause){res.json(result);return;}
        revision=String(result);
        // COMMIT is confirmed before latched=true. Cancellation completion is a separate observation.
        while(overall.remaining()>1500){
          const state=await fencedTransaction(d.lane,async c=>(await c.query(`SELECT execution_mode,entries_paused,pause_revision,pause_ack_revision,
            NOT EXISTS(SELECT 1 FROM grid_bots b WHERE b.status NOT IN ('draft','failed','stopped','stopping') AND NOT EXISTS(
              SELECT 1 FROM grid_control_keys k JOIN grid_control_requests r ON r.id=k.control_id
              WHERE k.bot_id=b.id AND k.request_key='host-pause:'||$1||':'||b.id::text AND r.state='complete')) AS cancellations_complete
            FROM grid_worker_host WHERE singleton_id=1`,[revision])).rows[0],
          {mode:'none',terminate:d.terminate,budget:new GridDeadline(Math.min(1000,overall.remaining()))});
          if(state?.entries_paused&&String(state.pause_revision)===revision&&(state.execution_mode==='legacy'||String(state.pause_ack_revision)===revision)){
            res.json({latched:true,saved:true,acknowledgementOutcome:state.execution_mode==='legacy'?'not_required':'confirmed',acknowledged:state.execution_mode==='legacy'?null:true,unknown:false,pauseRevision:revision,cancellationsComplete:state.cancellations_complete===true});return;
          }
          if(state&&String(state.pause_revision)!==revision){break;}
          await new Promise<void>(resolve=>setTimeout(resolve,Math.min(100,Math.max(0,overall.remaining()-1500))));
        }
        throw Error('GRID_PAUSE_ACK_TIMEOUT');
      }catch(error){
        const rejected=error instanceof Error&&/^GRID_(?:OWNER|RECEIPT|VERIFIED|RESET|INCIDENT|ADMIN_TARGET)/.test(error.message);
        if(pause&&d&&admitted&&mutationStarted&&!rejected){
          // An uncertain commit is never converted into a successful latch response.
          const incidents=new GridIncidents(d.lane,d.terminate);
          const incidentRecorded=external&&await incidents.record({code:'pause_unacknowledged',dedupKey:'grid-worker:pause-unacknowledged'},new GridDeadline(Math.max(1,overall.remaining())));
          res.status(503).json({latched:revision?true:null,...pauseSaveOutcome(mutationStarted,revision),acknowledged:false,unknown:true,pauseRevision:revision??null,cancellationsComplete:null,incidentRecorded});return;
        }
        if(!admitted){res.removeHeader('Cache-Control');next('route');return;}
        res.status(error instanceof z.ZodError?400:rejected?409:503)
          .json({error:'Worker control unavailable. Refresh status before trying again.',...(pause?{latched:false,...pauseSaveOutcome(false,undefined),acknowledged:false,unknown:false}:{} )});
      }
    });
  };
  const receipt=async(c:PoolClient,wallet:string,body:unknown)=>{
    const input=signed.parse(body);
    return verifyOwnerReceipt(c,{...input,signer:wallet,sessionWallet:wallet});
  };
  route('get','/status',async(c,_wallet,_body,_id,d)=>adminStatus(c,d.entriesPaused()));
  route('post','/challenge',async(c,wallet,body)=>{
    if((body as {action?:unknown})?.action==='break_glass_close'){
      const b=rescueChallenge.parse(body);
      if(b.target!=='bot:'+b.params.botId||!(await rescueOffer(c,wallet,b.params.botId)))throw Error('GRID_ADMIN_TARGET');
      return {message:await issueOwnerChallenge(c,wallet,b.action,b.target,b.params,120_000)};
    }
    const b=challenge.parse(body);
    await expectRevision(c,b.expectedPauseRevision);
    if((b.action==='ack_critical')!==b.target.startsWith('incident:'))throw Error('GRID_ADMIN_TARGET');
    return {message:await issueOwnerChallenge(c,wallet,b.action,b.target,undefined,120_000),expectedPauseRevision:b.expectedPauseRevision};
  });
  route('post','/pause',async(c,wallet,body,_id,_d,mutating)=>{
    const owner=await receipt(c,wallet,body);requireVerifiedOwner(owner,'pause','all');mutating();return pauseHost(c,owner);
  },true);
  route('post','/reset-pause',async(c,wallet,body,_id,d)=>{
    const input=signed.extend({expectedPauseRevision:revision}).parse(body);
    await expectRevision(c,input.expectedPauseRevision);
    await resetPause(c,await receipt(c,wallet,{message:input.message,signature:input.signature}),()=>d.readiness(c),{remoteWorkerEnabled:d.enabled(),entriesPaused:d.entriesPaused()});return {reset:true};
  });
  route('post','/incidents/:id/ack',async(c,wallet,body,id)=>{
    await acknowledgeCritical(c,await receipt(c,wallet,body),incidentId.parse(id));return {acknowledged:true};
  });
  route('post','/incidents/seen',async(c,_wallet,body)=>{
    const {ids}=z.object({ids:z.array(incidentId).min(1).max(100)}).strict().parse(body);
    await c.query(`UPDATE grid_worker_incidents SET inbox_seen_at=clock_timestamp()
      WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb))`,[JSON.stringify(ids)]);return {seen:true};
  });
  registerRescueRoutes(app,off,requireWallet,()=>provided?Promise.resolve(provided):production());
}

async function expectRevision(c:PoolClient,expected:string){
  const h=(await c.query('SELECT pause_revision FROM grid_worker_host WHERE singleton_id=1')).rows[0];
  if(!h||String(h.pause_revision)!==expected)throw Error('GRID_RESET_REVISION_MISMATCH');
}
