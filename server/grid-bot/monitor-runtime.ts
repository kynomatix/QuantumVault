import {gridRuntimeGates,gridWorkerState} from './service';
import {GridMonitor} from './monitor';
import {mainMoneySuppressed,startMainQuotaRefresh} from '../grid-worker/main-runtime';
let monitor:GridMonitor|null=null;
export async function startGridBotMonitor(){
  await (await import('./notifications')).startGridNotifications();
  if(mainMoneySuppressed()||process.env.GRID_ENTRIES_PAUSED==='true')await startMainQuotaRefresh((await import('../db')).pool);
  if(mainMoneySuppressed()){gridWorkerState(false);return;}
  if(!gridRuntimeGates().workerEnabled||monitor)return;
  const [{pool},{GridLaunchStorage},{GridMonitorStorage},{GridMonitorReads},{GridLaunchReads},{pacificaTransportAuthority},{gridExecutorRuntime}]=await Promise.all([
    import('../db'),import('./launch-storage'),import('./monitor-storage'),import('./monitor-reads'),import('./launch-reads'),import('../protocol/pacifica/pacifica-transport'),import('./executor-runtime')]);
  const ledger=new GridLaunchStorage(pool),storage=new GridMonitorStorage(ledger),json=new GridLaunchReads(pacificaTransportAuthority(),ledger,'0.5'),reads=new GridMonitorReads(json);
  const executor=gridExecutorRuntime(storage,reads,json);
  monitor=new GridMonitor({storage,tick:(claim,signal)=>executor.tick(claim,signal).then(()=>{}),report:event=>console.warn('[Grid monitor]',event.kind,event.botId??'')});
  monitor.start();
  gridWorkerState(true);
}
export async function stopGridBotMonitor(){gridWorkerState(false);if(!mainMoneySuppressed())await (await import('./notifications')).stopGridNotifications();const current=monitor;await current?.stop();if(monitor===current)monitor=null;}
