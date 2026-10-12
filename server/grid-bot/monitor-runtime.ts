import {GRID_WORKER_ENABLED} from './service';
import {GridMonitor} from './monitor';
let monitor:GridMonitor|null=null;
export async function startGridBotMonitor(){
  if(!GRID_WORKER_ENABLED||monitor)return;
  const [{pool},{GridLaunchStorage},{GridMonitorStorage},{GridMonitorService},{GridMonitorReads},{GridLaunchReads},{pacificaTransportAuthority}]=await Promise.all([
    import('../db'),import('./launch-storage'),import('./monitor-storage'),import('./monitor-service'),import('./monitor-reads'),import('./launch-reads'),import('../protocol/pacifica/pacifica-transport')]);
  const ledger=new GridLaunchStorage(pool),storage=new GridMonitorStorage(ledger),json=new GridLaunchReads(pacificaTransportAuthority(),ledger,'0.5'),reads=new GridMonitorReads(json);
  const {gridLifecycleRuntime}=await import('./lifecycle-runtime'),lifecycle=gridLifecycleRuntime(storage,reads,json);
  const service=new GridMonitorService({storage,observe:async(claim,from,signal)=>{
    const {bot}=await storage.snapshot(claim);
    return reads.observe({...claim,symbol:bot.market.replace(/-PERP$/,''),from,through:Date.now()},signal);
  }});
  monitor=new GridMonitor({storage,tick:async(claim,signal)=>{if(await lifecycle.service.tick(claim,signal)!=='stopped')await service.tick(claim,signal);},report:event=>console.warn('[Grid monitor]',event.kind,event.botId??'')});
  monitor.start();
}
export async function stopGridBotMonitor(){const current=monitor;await current?.stop();if(monitor===current)monitor=null;}
