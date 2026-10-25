import {currentWorkerHolder} from './current-holder';
import {collectStartFacts} from './start-facts';
import {installWorkerBindings} from './runtime-bindings';
import {readGridMargin} from '../grid-bot/margin';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import type {PoolClient} from 'pg';
import {createGridWorkerDatabase} from './database';
import {probeGridWorkerSchema} from './boot';
import {GridWorkerLease,type WorkerLease,leaseLocallyValid} from './lease';
import {identityMatches,workerBuildIdentity} from './build-identity';
import {fencedTransaction,GridDeadline} from './transaction';
import {acknowledgePause,tightenHost} from './host';
import {WorkerObserver} from './observer';
import {priorityIncident,resolveHealthyConditions} from './incident-policy';
import {runtimeFailureCode} from './runtime-failure';
import {GridIncidents} from './incidents';
import {serviceBotPass} from './bot-pass';
import {ProtectionTruth} from './protection-truth';
import {recoverAbandonedRescues} from './rescue-recovery';
import {WorkerQuota} from './quota';
import {workerDependencies} from './dependencies';
import {WorkerScheduler} from './scheduler';
import {WorkerReconciliation} from './reconciliation';
import {WorkerStartQueue} from './start-queue';
import {GridLaunchStorage} from '../grid-bot/launch-storage-core';
import {GridMonitorStorage} from '../grid-bot/monitor-storage';
import {GridLaunchReads} from '../grid-bot/launch-reads';
import {GridMonitorReads} from '../grid-bot/monitor-reads';
import {gridExecutorCore} from '../grid-bot/executor-core';
import {statusCache,workerHttp} from './http';
import type {StatusMemory} from './status';
import {OWNER_MASTER_PUBLIC_KEYS} from './owner-master-keys';

export interface RuntimeHandle {stop():Promise<void>;status():StatusMemory}
/** Reserved renewal connection plus at most three execution/read/termination connections. */
export async function startWorkerRuntime(env:Readonly<NodeJS.ProcessEnv>,databaseFactory=createGridWorkerDatabase,
  fatal:()=>void=()=>process.exit(1)):Promise<RuntimeHandle>{
  const database=databaseFactory(env.DATABASE_URL!),pool=database.pool,bootId=randomUUID();
  let lease:WorkerLease|undefined,renewal:PoolClient|undefined,closing=false,readyUntil=0,probing=false,working=false,renewing=false;
  let dying=false,maintaining=false;
  const active=new Set<Promise<void>>();
  const launch=(job:()=>Promise<void>)=>{const task=job();active.add(task);void task.finally(()=>active.delete(task)).catch(()=>fatal());};
  let host:Record<string,any>|undefined,lastProgress=0;
  const observer=new WorkerObserver();
  const clock={wall:Date.now(),mono:performance.now()};
  const ready=()=>!closing&&performance.now()<readyUntil&&Math.abs((Date.now()-clock.wall)-(performance.now()-clock.mono))<1000;
  const memory:StatusMemory={standby:true,database:false,inControl:false,test:true,paused:true,critical:false,reconciled:false,
    renewalAt:null,passAt:null,botCheckTimes:[],running:0,waiting:0,commitHash:workerBuildIdentity.commitHash};
  const cache=statusCache(()=>memory),server=workerHttp(cache,()=>observer.poll());
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(Number(env.PORT??5000),'0.0.0.0',()=>{server.removeListener('error',reject);resolve();});});
  const terminate=async(pid:number)=>{await pool.query('SELECT pg_terminate_backend($1)',[pid]);};
  const current=()=>lease, bootIncidents=new GridIncidents(pool,terminate),fatalIncidents=new GridIncidents(pool,terminate,current,true);
  const incidents=new GridIncidents(pool,terminate,current),quota=new WorkerQuota(pool,terminate),dependencies=workerDependencies(pool,quota,env);
  const protection=new ProtectionTruth(pool,terminate,incidents,current);
  installWorkerBindings(dependencies.umk,()=>ready()&&!!lease&&leaseLocallyValid(lease)&&observer.polledSinceAcquire&&!memory.critical&&memory.reconciled&&env.GRID_ENTRIES_PAUSED!=='true'&&host?.execution_enabled===true&&host?.run_mode==='trading'&&!host?.entries_paused&&!host?.observer_fenced);
  const holder=()=>{if(!lease||!leaseLocallyValid(lease)||!ready())throw Error('GRID_LEASE_EXPIRED');return lease;};
  let queue:WorkerStartQueue;
  const ledger:GridLaunchStorage=new GridLaunchStorage(pool,async()=>{if(!ready())throw Error('GRID_WORKER_NOT_READY');},r=>readGridMargin(json,r),
    {lease:holder,ready,terminate,verifyStart:(c,id)=>queue.verify(c,id),releaseReservation:(c,id)=>queue.release(c,id)});
  const json:GridLaunchReads=new GridLaunchReads(dependencies.transport,ledger,'0.5',dependencies.fetcher),reads=new GridMonitorReads(json),monitor=new GridMonitorStorage(ledger);
  const executor=gridExecutorCore(monitor,reads,json,dependencies),reconciliation=new WorkerReconciliation(pool,terminate,json,reads,dependencies,incidents,OWNER_MASTER_PUBLIC_KEYS,current);
  queue=new WorkerStartQueue(pool,terminate,incidents,holder,dependencies,
    (botId,umk,signal)=>collectStartFacts(pool,dependencies,json,ledger,botId,umk,signal),(wallet,id,expected,signal)=>executor.start(wallet,id,expected,signal));
  const scheduler=new WorkerScheduler({
    async existing(signal){
      if(!host||host.run_mode!=='trading'||!host.execution_enabled)return;
      await serviceBotPass(signal,{
        assertHolder:holder,claim:seen=>monitor.claim(seen),allowed:claim=>OWNER_MASTER_PUBLIC_KEYS.includes(claim.masterAccount),
        refused:claim=>incidents.record({code:'authority_refused',dedupKey:'authority-refused:'+claim.id,botId:claim.id,bootId,epoch:lease?.epoch}),
        tick:claim=>executor.tick(claim,signal),observed:(claim,error)=>protection.observe(claim.id,error),
        observationFailed:claim=>incidents.record({code:'protective_failure',dedupKey:'protective-failure:'+claim.id,botId:claim.id,bootId,epoch:lease?.epoch}),
        release:async claim=>{if(lease&&leaseLocallyValid(lease)&&ready())try{await monitor.release(claim);}catch{/* Retain the bounded bot lease on uncertainty. */}},
      });
    },
    // The injected executor tick services lifecycle/protection before new order work.
    lifecycle:async()=>{},
    async reconcile(signal){const clean=await reconciliation.pass(signal);memory.reconciled=clean;return clean;},
    startOne:signal=>queue.one(signal),
  },()=>ready()&&!!lease&&leaseLocallyValid(lease)&&observer.polledSinceAcquire&&!memory.critical&&memory.reconciled&&env.GRID_ENTRIES_PAUSED!=='true'&&host?.run_mode==='trading'&&host.execution_enabled&&!host.entries_paused&&!host.observer_fenced&&!host.drain_requested&&memory.reconciled);
  let leaseService:GridWorkerLease|undefined;
  const die=async(code:'lease_lost'|'clock_unhealthy'|'schema_drift'|'database_unavailable')=>{
    if(dying)return;dying=true;memory.critical=true;memory.inControl=false;readyUntil=0;
    try{await (lease?fatalIncidents:bootIncidents).record({code,dedupKey:'grid-worker:'+code,bootId,epoch:lease?.epoch});}finally{fatal();}
  };
  async function refresh(){
    if(probing||closing)return;probing=true;
    try{
      const c=await database.connect();
      try{await probeGridWorkerSchema((text,values)=>c.query(text,values?[...values]:undefined));readyUntil=performance.now()+55000;
        host=(await c.query('SELECT *,lease_expires_at>clock_timestamp() AS holder_live,clock_timestamp() AS db_now FROM grid_worker_host WHERE singleton_id=1')).rows[0];
        if(!host||Math.abs(new Date(host.db_now).getTime()-Date.now())>=1000)throw Error('GRID_CLOCK_UNHEALTHY');
        memory.database=true;memory.test=host.run_mode!=='trading';memory.paused=host.entries_paused;
        const open=(await c.query("SELECT DISTINCT code FROM grid_worker_incidents WHERE severity='critical' AND (acknowledged_at IS NULL OR resolved_at IS NULL)")).rows;
        memory.critical=open.length>0||(!!lease&&observer.silent);memory.incidentCode=priorityIncident([...open.map(r=>r.code),...(lease&&observer.silent?['observer_silent']:[])]);
        const bots=(await c.query("SELECT last_tick_at FROM grid_bots WHERE status NOT IN ('draft','failed','stopped') LIMIT 1001")).rows;
        memory.botCheckTimes=bots.map(b=>b.last_tick_at?new Date(b.last_tick_at).getTime():null);memory.running=bots.length;
        memory.waiting=Number((await c.query("SELECT count(*) AS count FROM grid_worker_requests WHERE state='pending' AND expires_at>clock_timestamp()")).rows[0].count);
      }finally{c.release();}
      memory.standby=env.GRID_REMOTE_WORKER_ENABLED!=='true'||host.execution_mode!=='external';
      if(memory.standby){if(lease)await die('lease_lost');return;}
      if(!identityMatches(host)||host.protocol_version!=='grid-worker-v3-a1-wire1'){if(lease)await die('schema_drift');return;}
      if(!lease){
        await fencedTransaction(pool,recoverAbandonedRescues,{terminate});
        // No unverified acceptance bound: acquire only when there are NO retained unknown windows.
        const pending=(await pool.query(`SELECT 1 FROM grid_operations WHERE state IN ('prepared','submitted','unconfirmed')
          UNION ALL SELECT 1 FROM grid_worker_send_audit WHERE outcome='unknown' LIMIT 1`)).rowCount;
        if(pending||host.holder_live)return;
        renewal=await database.connect();
        const renewalLane={connect:async()=>new Proxy(renewal!,{get(target,key){if(key==='release')return (destroy?:boolean)=>{if(destroy){target.release(true);renewal=undefined;}};
          const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}})};
        leaseService=new GridWorkerLease(pool,renewalLane,terminate,async()=>ready()&&!!host&&identityMatches(host));
        lease=await leaseService.acquire(bootId,{verified:true,milliseconds:0,skewMs:1000},async acquired=>{
          lease=acquired;host!.observer_fenced=true;
          await fencedTransaction(pool,async c=>{if(!await currentWorkerHolder(c,acquired))throw Error('GRID_LEASE_EXPIRED');await observer.acquire(c);if(env.GRID_ENTRIES_PAUSED==='true')await tightenHost(c,{pause:true});},{terminate});
          memory.reconciled=await reconciliation.pass(AbortSignal.timeout(30000));return true;
        });
        memory.inControl=true;memory.renewalAt=Date.now();
      }
      if(lease&&!leaseLocallyValid(lease))await die('lease_lost');
    }catch(error){memory.database=false;readyUntil=0;const code=runtimeFailureCode(error);memory.incidentCode=code;
      if(lease)await die(code);else {renewal?.release();renewal=undefined;}}
    finally{probing=false;}
  }
  async function renew(){
    if(renewing||!lease||!leaseService)return;renewing=true;
    try{
      if(!ready()&&!closing)throw Error('GRID_CLOCK_OR_READINESS');
      const pollVersion=observer.version;
      const renewed=await leaseService.renew(lease,1000,lastProgress>0&&Date.now()-lastProgress<30000,observer.pendingPoll);
      observer.flushed(pollVersion);
      lease=renewed;host={...host,...renewed};
      memory.renewalAt=Date.now();
      memory.paused=renewed.entries_paused||env.GRID_ENTRIES_PAUSED==='true';
    }catch(error){await die(error instanceof Error&&/CLOCK/.test(error.message)?'clock_unhealthy':'lease_lost');renewing=false;return;}
    renewing=false;
    if(maintaining)return;maintaining=true;
    const authority=lease;
    const budget=new GridDeadline(8000);
    if(observer.silent){host!.observer_fenced=true;memory.critical=true;memory.incidentCode=priorityIncident([memory.incidentCode??'','observer_silent']);cache.rebuild();}
    try{
      // Local gates close before acknowledgment. A reset racing this maintenance is retried, never fatal.
      if(env.GRID_ENTRIES_PAUSED==='true'){
        host!.entries_paused=true;
        await fencedTransaction(pool,async c=>{if(await currentWorkerHolder(c,authority))await tightenHost(c,{pause:true});},{terminate,budget});
      }
      await fencedTransaction(pool,async c=>{
        if(!await currentWorkerHolder(c,authority))return;
        const h=(await c.query('SELECT entries_paused,pause_revision,pause_ack_revision FROM grid_worker_host WHERE singleton_id=1')).rows[0];
        if(h?.entries_paused){host!.entries_paused=true;memory.paused=true;
          if(String(h.pause_revision)!==String(h.pause_ack_revision))await acknowledgePause(c,lease!,String(h.pause_revision));}
      },{terminate,budget});
      if(!closing){
        const state=await fencedTransaction(pool,async c=>{
          if(!await currentWorkerHolder(c,authority))throw Error('GRID_LEASE_EXPIRED');
          const progress=lastProgress>0&&Date.now()-lastProgress<30000;
          if(ready()&&host&&identityMatches(host))await resolveHealthyConditions(c,{progress,reconciled:memory.reconciled&&progress});
          return observer.maintain(c,lease!,async()=>ready()&&memory.reconciled&&progress);
        },{terminate,budget});
        observer.committed(state);
        if(state==='silent'){host!.observer_fenced=true;memory.critical=true;memory.incidentCode=priorityIncident([memory.incidentCode??'','observer_silent']);}
      }
    }catch{/* Pause/observer maintenance is retried next renewal, independently of ownership. */}
    finally{maintaining=false;cache.rebuild();}
  }
  async function pass(){
    if(working||closing||!lease||!ready())return;working=true;
    try{holder();await scheduler.pass();lastProgress=Date.now();memory.passAt=lastProgress;}
    catch{memory.reconciled=false;await incidents.record({code:'reconciliation_unavailable',dedupKey:'grid-worker:pass',bootId,epoch:lease?.epoch});}
    finally{working=false;}
  }
  const refreshTimer=setInterval(()=>{launch(refresh);},5000),renewTimer=setInterval(()=>{launch(renew);},10000),passTimer=setInterval(()=>{launch(pass);},15000);
  const clockTimer=setInterval(()=>{if(lease&&(!leaseLocallyValid(lease)||Math.abs((Date.now()-clock.wall)-(performance.now()-clock.mono))>=1000))void die('clock_unhealthy');},1000);
  await refresh();
  return {status:()=>({...memory}),async stop(){
    if(closing)return;closing=true;clearInterval(refreshTimer);clearInterval(passTimer);clearInterval(clockTimer);
    try{await scheduler.stop();}catch{/* Unknown sends remain retained. */}
    // Renewal continues through abort/drain. Never write drain_requested on process shutdown.
    clearInterval(renewTimer);
    await Promise.allSettled([...active]);
    if(lease&&leaseService){await new Promise(resolve=>setTimeout(resolve,46000));try{await leaseService.release(lease);}catch{/* A successor owns the row or DB is unavailable. */}}
    renewal?.release();cache.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await database.close();
  }};
}
