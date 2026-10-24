import {gridExecutorCore} from './executor-core';
import {productionGridRuntimeDependencies} from './runtime-dependencies-main';
import {pacificaTransportAuthority} from '../protocol/pacifica/pacifica-transport';
import type {GridMonitorStorage} from './monitor-storage';
import type {GridMonitorReads} from './monitor-reads';
import type {GridLaunchReads} from './launch-reads';
export function gridExecutorRuntime(storage:GridMonitorStorage,reads:GridMonitorReads,json:GridLaunchReads){return gridExecutorCore(storage,reads,json,productionGridRuntimeDependencies());}
/** Initialized only behind the release gate. Rejected construction may retry on a later request. */
let production:Promise<ReturnType<typeof gridExecutorRuntime>>|undefined;
export function productionGridExecutor(){
  if(process.env.GRID_REMOTE_WORKER_ENABLED==='true')throw Error('GRID_MAIN_MONEY_SUPPRESSED');
  return production??=Promise.all([import('../db'),import('./launch-storage'),import('./monitor-storage'),import('./launch-reads'),import('./monitor-reads')])
    .then(([{pool},{GridLaunchStorage},{GridMonitorStorage},{GridLaunchReads},{GridMonitorReads}])=>{
      const ledger=new GridLaunchStorage(pool),storage=new GridMonitorStorage(ledger),json=new GridLaunchReads(pacificaTransportAuthority(),ledger,'0.5');
      return gridExecutorRuntime(storage,new GridMonitorReads(json),json);
    }).catch(error=>{production=undefined;throw error;});
}
