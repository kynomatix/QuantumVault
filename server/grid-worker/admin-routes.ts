import type {Express,RequestHandler} from 'express';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {fencedTransaction,GridDeadline,type ClientLane} from './transaction';
import {issueOwnerChallenge,verifyOwnerReceipt,requireVerifiedOwner} from './owner-receipts';
import {acknowledgeCritical,pauseHost,resetPause} from './host';
import {GridIncidents} from './incidents';
import {GRID_WORKER_REQUIRED_CAPABILITIES} from './boot';
import {SCHEMA_MIGRATION_MANIFEST} from '../schema-migration-manifest';
import {probeSchemaMigrationManifest} from '../schema-readiness-probe';
import {identityMatches} from './build-identity';
import {OWNER_MASTER_PUBLIC_KEYS} from './owner-master-keys';
import {RECONCILIATION_STREAMS} from './reconciliation';

const action=z.enum(['pause','reset_pause','ack_critical']);
const target=z.union([z.literal('all'),z.string().regex(/^incident:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)]);
const challenge=z.object({action,target}).strict();
const signed=z.object({message:z.string().max(2048),signature:z.string().max(128)}).strict();
const incidentId=z.string().uuid().regex(/^[0-9a-f-]+$/);
export interface AdminDependencies {
  lane:ClientLane;terminate:(pid:number)=>Promise<void>;
  enabled:()=>boolean;entriesPaused:()=>boolean;
  readiness:(c:PoolClient)=>Promise<boolean>;
}
/** A current worker observation, full inventory and catalog are required. No venue calls. */
export async function ownerResetReady(c:PoolClient):Promise<boolean>{
  // Stay inside the receipt's existing exclusive transaction; the boot probe owns its own BEGIN/COMMIT.
  const required=new Set<string>(GRID_WORKER_REQUIRED_CAPABILITIES);
  const catalog=await probeSchemaMigrationManifest((text,values)=>c.query(text,values?[...values]:undefined),
    SCHEMA_MIGRATION_MANIFEST.filter(entry=>entry.capabilities.some(capability=>required.has(capability))));
  if(catalog.unavailableCapabilities.some(capability=>required.has(capability)))return false;
  const h=(await c.query(`SELECT *,lease_expires_at>clock_timestamp() AS holder_live,
    heartbeat_at BETWEEN clock_timestamp()-interval '15 seconds' AND clock_timestamp() AS heartbeat_fresh,
    progress_at BETWEEN clock_timestamp()-interval '30 seconds' AND clock_timestamp() AS progress_fresh
    FROM grid_worker_host WHERE singleton_id=1`)).rows[0];
  if(!h||!identityMatches(h)||!h.holder_live||!h.heartbeat_fresh||!h.progress_fresh||h.observer_fenced||h.drain_requested
    ||!h.authority_tracking_enabled||h.start_scope!=='owner_allowlist'||OWNER_MASTER_PUBLIC_KEYS.length===0)return false;
  const unhealthy=(await c.query(`SELECT 1 FROM grid_worker_incidents WHERE severity='critical'
    AND (acknowledged_at IS NULL OR resolved_at IS NULL) LIMIT 1`)).rowCount;
  if(unhealthy)return false;
  // Missing coverage is not successful reconciliation, including accounts without a bot.
  return !(await c.query(`SELECT 1 FROM protocol_subaccounts p
    CROSS JOIN jsonb_array_elements_text($1::jsonb) s(stream)
    WHERE p.protocol='pacifica' AND p.protocol_subaccount_id IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM grid_worker_reconciliation r WHERE r.account=p.protocol_subaccount_id AND r.stream=s.stream
        AND r.state='complete' AND r.last_complete_at BETWEEN clock_timestamp()-interval '30 seconds' AND clock_timestamp()
        AND r.covered_through_at BETWEEN clock_timestamp()-interval '125 seconds' AND clock_timestamp()) LIMIT 1`,
    [JSON.stringify(RECONCILIATION_STREAMS)])).rowCount;
}
async function production():Promise<AdminDependencies>{
  const [{pool},{independentLane,backendTerminator}]=await Promise.all([import('../db'),import('./lanes')]);
  const lane=independentLane(pool);
  return {lane,terminate:backendTerminator(independentLane(pool)),enabled:()=>process.env.GRID_REMOTE_WORKER_ENABLED==='true',
    entriesPaused:()=>process.env.GRID_ENTRIES_PAUSED==='true',readiness:ownerResetReady};
}
/** MAIN only. Registration does not load the database or expose an enabled control. */
export function registerGridWorkerAdminRoutes(app:Express,requireWallet:RequestHandler,provided?:AdminDependencies){
  const enabled=()=>provided?provided.enabled():process.env.GRID_REMOTE_WORKER_ENABLED==='true';
  const off:RequestHandler=(_req,res,next)=>{res.set('Cache-Control','no-store');if(!enabled()){res.sendStatus(404);return;}next();};
  const route=(method:'get'|'post',path:string,run:(c:PoolClient,wallet:string,body:unknown,id:unknown,d:AdminDependencies,mutating:()=>void)=>Promise<unknown>,pause=false)=>{
    app[method]('/api/grid-worker'+path,off,requireWallet,async(req,res)=>{
      const overall=new GridDeadline(20_000);let d:AdminDependencies|undefined,revision:string|undefined;
      let admitted=false,mutationStarted=false;
      try{
        d=provided??await production();
        const wallet=(req as typeof req & {walletAddress:string}).walletAddress;
        const result=await fencedTransaction(d.lane,async c=>{
          const owner=(await c.query(`SELECT o.wallet_address FROM grid_worker_owner o JOIN grid_worker_host h
            ON h.singleton_id=o.singleton_id AND h.owner_wallet=o.wallet_address
            WHERE o.singleton_id=1`)).rows[0];
          if(!owner||owner.wallet_address!==wallet)throw Error('GRID_ADMIN_NOT_FOUND');
          admitted=true;
          return run(c,wallet,req.body,req.params.id,d!,()=>{mutationStarted=true;});
        },{mode:method==='get'?'shared':'exclusive',pause,terminate:d.terminate,budget:new GridDeadline(pause?Math.min(9000,overall.remaining()):Math.min(18000,overall.remaining()))});
        if(!pause){res.json(result);return;}
        revision=String(result);
        // COMMIT is confirmed before latched=true. Cancellation completion is a separate observation.
        while(overall.remaining()>1500){
          const state=await fencedTransaction(d.lane,async c=>(await c.query(`SELECT entries_paused,pause_revision,pause_ack_revision,
            NOT EXISTS(SELECT 1 FROM grid_bots b WHERE b.status NOT IN ('draft','failed','stopped','stopping') AND NOT EXISTS(
              SELECT 1 FROM grid_control_keys k JOIN grid_control_requests r ON r.id=k.control_id
              WHERE k.bot_id=b.id AND k.request_key='host-pause:'||$1||':'||b.id::text AND r.state='complete')) AS cancellations_complete
            FROM grid_worker_host WHERE singleton_id=1`,[revision])).rows[0],
          {mode:'none',terminate:d.terminate,budget:new GridDeadline(Math.min(1000,overall.remaining()))});
          if(state?.entries_paused&&String(state.pause_revision)===revision&&String(state.pause_ack_revision)===revision){
            res.json({latched:true,acknowledged:true,unknown:false,pauseRevision:revision,cancellationsComplete:state.cancellations_complete===true});return;
          }
          if(state&&String(state.pause_revision)!==revision)break;
          await new Promise<void>(resolve=>setTimeout(resolve,Math.min(100,Math.max(0,overall.remaining()-1500))));
        }
        throw Error('GRID_PAUSE_ACK_TIMEOUT');
      }catch(error){
        const rejected=error instanceof Error&&/^GRID_(?:OWNER|RECEIPT|VERIFIED|RESET|INCIDENT|ADMIN_TARGET)/.test(error.message);
        if(pause&&d&&admitted&&mutationStarted&&!rejected){
          // An uncertain commit is never converted into a successful latch response.
          const incidents=new GridIncidents(d.lane,d.terminate);
          const incidentRecorded=await incidents.record({code:'pause_unacknowledged',dedupKey:'grid-worker:pause-unacknowledged'},new GridDeadline(Math.max(1,overall.remaining())));
          res.status(503).json({latched:revision?true:null,acknowledged:false,unknown:true,pauseRevision:revision??null,cancellationsComplete:null,incidentRecorded});return;
        }
        if(!admitted){res.sendStatus(404);return;}
        res.status(error instanceof z.ZodError?400:rejected?409:503)
          .json({error:'Worker control unavailable. Refresh status before trying again.'});
      }
    });
  };
  const receipt=async(c:PoolClient,wallet:string,body:unknown)=>{
    const input=signed.parse(body);
    return verifyOwnerReceipt(c,{...input,signer:wallet,sessionWallet:wallet});
  };
  route('get','/status',async c=>{
    const host=(await c.query(`SELECT execution_mode,run_mode,execution_enabled,entries_paused,observer_fenced,legacy_controls_enabled,
      pause_revision,pause_ack_revision,pause_ack_at,last_healthz_poll_at,heartbeat_at,progress_at,clock_timestamp() AS observed_at
      FROM grid_worker_host WHERE singleton_id=1`)).rows[0];
    const incidents=(await c.query(`SELECT id,severity,code,first_seen_at,last_seen_at,resolved_at,acknowledged_at,inbox_seen_at
      FROM grid_worker_incidents WHERE acknowledged_at IS NULL OR resolved_at IS NULL OR inbox_seen_at IS NULL
      ORDER BY first_seen_at DESC,id LIMIT 100`)).rows;
    return {host,incidents};
  });
  route('post','/challenge',async(c,wallet,body)=>{
    const b=challenge.parse(body);
    if((b.action==='ack_critical')!==b.target.startsWith('incident:'))throw Error('GRID_ADMIN_TARGET');
    return {message:await issueOwnerChallenge(c,wallet,b.action,b.target,undefined,120_000)};
  });
  route('post','/pause',async(c,wallet,body,_id,_d,mutating)=>{
    const owner=await receipt(c,wallet,body);requireVerifiedOwner(owner,'pause','all');mutating();return pauseHost(c,owner);
  },true);
  route('post','/reset-pause',async(c,wallet,body,_id,d)=>{
    await resetPause(c,await receipt(c,wallet,body),()=>d.readiness(c),{remoteWorkerEnabled:d.enabled(),entriesPaused:d.entriesPaused()});return {reset:true};
  });
  route('post','/incidents/:id/ack',async(c,wallet,body,id)=>{
    await acknowledgeCritical(c,await receipt(c,wallet,body),incidentId.parse(id));return {acknowledged:true};
  });
  route('post','/incidents/seen',async(c,_wallet,body)=>{
    const {ids}=z.object({ids:z.array(incidentId).min(1).max(100)}).strict().parse(body);
    await c.query(`UPDATE grid_worker_incidents SET inbox_seen_at=clock_timestamp()
      WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb))`,[JSON.stringify(ids)]);return {seen:true};
  });
}
