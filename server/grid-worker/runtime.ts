import {installWorkerBindings} from './runtime-bindings';
import {readGridMargin} from '../grid-bot/margin';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import type {PoolClient} from 'pg';
import {createGridWorkerDatabase} from './database';
import {probeGridWorkerSchema} from './boot';
import {GridWorkerLease,type WorkerLease,leaseLocallyValid} from './lease';
import {identityMatches,workerBuildIdentity} from './build-identity';
import {fencedTransaction} from './transaction';
import {acknowledgePause,clearObserver} from './host';
import {GridIncidents} from './incidents';
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
  let dying=false;
  const active=new Set<Promise<void>>();
  const launch=(job:()=>Promise<void>)=>{const task=job();active.add(task);void task.finally(()=>active.delete(task)).catch(()=>fatal());};
  let host:Record<string,any>|undefined,lastPoll=0,lastProgress=0;
  const clock={wall:Date.now(),mono:performance.now()};
  const ready=()=>!closing&&performance.now()<readyUntil&&Math.abs((Date.now()-clock.wall)-(performance.now()-clock.mono))<1000;
  const memory:StatusMemory={standby:true,database:false,inControl:false,test:true,paused:true,critical:false,reconciled:false,
    renewalAt:null,passAt:null,botCheckTimes:[],running:0,waiting:0,commitHash:workerBuildIdentity.commitHash};
  const cache=statusCache(()=>memory),server=workerHttp(cache,()=>{lastPoll=Date.now();});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(Number(env.PORT??5000),'0.0.0.0',()=>{server.removeListener('error',reject);resolve();});});
  const terminate=async(pid:number)=>{await pool.query('SELECT pg_terminate_backend($1)',[pid]);};
  const incidents=new GridIncidents(pool,terminate),quota=new WorkerQuota(pool,terminate),dependencies=workerDependencies(pool,quota,env);
  installWorkerBindings(dependencies.umk,()=>ready()&&!!lease&&leaseLocallyValid(lease)&&host?.execution_enabled===true&&host?.run_mode==='trading'&&!host?.entries_paused&&!host?.observer_fenced);
  const holder=()=>{if(!lease||!leaseLocallyValid(lease)||!ready())throw Error('GRID_LEASE_EXPIRED');return lease;};
  let queue:WorkerStartQueue;
  const ledger:GridLaunchStorage=new GridLaunchStorage(pool,async()=>{if(!ready())throw Error('GRID_WORKER_NOT_READY');},r=>readGridMargin(json,r),
    {lease:holder,ready,terminate,verifyStart:(c,id)=>queue.verify(c,id),releaseReservation:(c,id)=>queue.release(c,id)});
  const json:GridLaunchReads=new GridLaunchReads(dependencies.transport,ledger,'0.5',dependencies.fetcher),reads=new GridMonitorReads(json),monitor=new GridMonitorStorage(ledger,OWNER_MASTER_PUBLIC_KEYS);
  const executor=gridExecutorCore(monitor,reads,json,dependencies),reconciliation=new WorkerReconciliation(pool,terminate,json,reads,dependencies,incidents);
  queue=new WorkerStartQueue(pool,terminate,incidents,holder,dependencies,async()=>{
    // Full transfer/withdrawal history is deliberately unavailable in the frozen read inventory.
    // Never fabricate spending facts from balances or from an incomplete cursor. U7 cannot activate this path.
    throw Error('GRID_RECONCILIATION_UNAVAILABLE');
  },(wallet,id,expected,signal)=>executor.start(wallet,id,expected,signal));
  const scheduler=new WorkerScheduler({
    async existing(signal){
      if(!host||host.run_mode!=='trading'||!host.execution_enabled)return;
      const seen:string[]=[];
      for(let i=0;i<100;i++){
        signal.throwIfAborted();holder();const claim=await monitor.claim(seen);if(!claim)break;seen.push(claim.id);
        if(!OWNER_MASTER_PUBLIC_KEYS.includes(claim.masterAccount))throw Error('GRID_OWNER_MASTER_UNCONFIRMED');
        await executor.tick(claim,signal);signal.throwIfAborted();if(lease&&leaseLocallyValid(lease)&&ready())await monitor.release(claim);
      }
    },
    // The injected executor tick services lifecycle/protection before new order work.
    lifecycle:async()=>{},
    async reconcile(signal){const clean=await reconciliation.pass(signal);memory.reconciled=clean;return clean;},
    startOne:signal=>queue.one(signal),
  },()=>ready()&&!!lease&&leaseLocallyValid(lease)&&host?.run_mode==='trading'&&host.execution_enabled&&!host.entries_paused&&!host.observer_fenced&&!host.drain_requested&&memory.reconciled);
  let leaseService:GridWorkerLease|undefined;
  const die=async(code:'lease_lost'|'clock_unhealthy'|'schema_drift')=>{
    if(dying)return;dying=true;memory.critical=true;memory.inControl=false;readyUntil=0;
    try{await incidents.record({code,dedupKey:'grid-worker:'+code,bootId,epoch:lease?.epoch});}finally{fatal();}
  };
  async function refresh(){
    if(probing||closing)return;probing=true;
    try{
      const c=await database.connect();
      try{await probeGridWorkerSchema((text,values)=>c.query(text,values?[...values]:undefined));readyUntil=performance.now()+55000;
        host=(await c.query('SELECT *,lease_expires_at>clock_timestamp() AS holder_live,clock_timestamp() AS db_now FROM grid_worker_host WHERE singleton_id=1')).rows[0];
        if(!host||Math.abs(new Date(host.db_now).getTime()-Date.now())>=1000)throw Error('GRID_CLOCK_UNHEALTHY');
        memory.database=true;memory.test=host.run_mode!=='trading';memory.paused=host.entries_paused;
        memory.critical=!!(await c.query("SELECT 1 FROM grid_worker_incidents WHERE severity='critical' AND acknowledged_at IS NULL LIMIT 1")).rowCount;
        const bots=(await c.query("SELECT last_tick_at FROM grid_bots WHERE status NOT IN ('draft','failed','stopped') LIMIT 1001")).rows;
        memory.botCheckTimes=bots.map(b=>b.last_tick_at?new Date(b.last_tick_at).getTime():null);memory.running=bots.length;
        memory.waiting=Number((await c.query("SELECT count(*) AS count FROM grid_worker_requests WHERE state='pending' AND expires_at>clock_timestamp()")).rows[0].count);
      }finally{c.release();}
      memory.standby=env.GRID_REMOTE_WORKER_ENABLED!=='true'||host.execution_mode!=='external';
      if(memory.standby){if(lease)await die('lease_lost');return;}
      if(!identityMatches(host)||host.protocol_version!=='grid-worker-v3-a1-wire1'){if(lease)await die('schema_drift');return;}
      if(!lease){
        // No unverified acceptance bound: acquire only when there are NO retained unknown windows.
        const pending=(await pool.query(`SELECT 1 FROM grid_operations WHERE state IN ('prepared','submitted','unconfirmed')
          UNION ALL SELECT 1 FROM grid_worker_send_audit WHERE outcome='unknown' LIMIT 1`)).rowCount;
        if(pending||host.holder_live)return;
        renewal=await database.connect();
        const renewalLane={connect:async()=>new Proxy(renewal!,{get(target,key){if(key==='release')return (destroy?:boolean)=>{if(destroy){target.release(true);renewal=undefined;}};
          const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}})};
        leaseService=new GridWorkerLease(pool,renewalLane,terminate,async()=>ready()&&!!host&&identityMatches(host));
        lease=await leaseService.acquire(bootId,{verified:true,milliseconds:0,skewMs:1000},async acquired=>{lease=acquired;memory.reconciled=await reconciliation.pass(AbortSignal.timeout(30000));return true;});
        memory.inControl=true;memory.renewalAt=Date.now();
      }
      if(lease&&!leaseLocallyValid(lease))await die('lease_lost');
    }catch{memory.database=false;readyUntil=0;if(lease)await die('schema_drift');else {renewal?.release();renewal=undefined;}}
    finally{probing=false;}
  }
  async function renew(){
    if(renewing||!lease||!leaseService)return;renewing=true;
    try{
      if(!ready()&&!closing)throw Error('GRID_CLOCK_OR_READINESS');
      lease=await leaseService.renew(lease,1000,lastProgress>0&&Date.now()-lastProgress<30000,lastPoll>0&&Date.now()-lastPoll<10000);
      memory.renewalAt=Date.now();
      // Acknowledgment is exposed only after COMMIT. This uses an execution lane; renewal remains fence-free.
      if(host?.entries_paused)await fencedTransaction(pool,async c=>{await acknowledgePause(c,lease!,String(host!.pause_revision));},{terminate});
      if(!closing&&host?.observer_fenced&&memory.reconciled&&lastPoll>0&&Date.now()-lastPoll<10000&&lastProgress>0&&Date.now()-lastProgress<30000){
        await fencedTransaction(pool,c=>clearObserver(c,lease!,async()=>ready()&&memory.reconciled),{terminate});
      }
    }catch{await die('lease_lost');}finally{renewing=false;}
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
