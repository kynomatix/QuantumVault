import {pacificaTransportAuthority} from '../protocol/pacifica/pacifica-transport';
import type {GridMonitorStorage} from './monitor-storage';
import type {GridLaunchReads} from './launch-reads';
import type {GridMoveStorage} from './move-storage';
import {productionGridLaunchAuthority} from './launch-authority';
import {durableGridUmk} from './service';
import {pacificaPlannerCandles} from '../grid-planner/pacifica-candles';
import {createGridMoveCore} from './move-core';
export function createGridMoveStorage(storage:GridMonitorStorage,reads:GridLaunchReads){
  return createGridMoveCore(storage,reads,{authority:productionGridLaunchAuthority,umk:durableGridUmk},pacificaPlannerCandles);
}
let singleton:Promise<GridMoveStorage>|undefined;
export function productionGridMoves(){
  if(process.env.GRID_REMOTE_WORKER_ENABLED==='true')throw Error('GRID_MAIN_MONEY_SUPPRESSED');
  return singleton??=Promise.all([import('../db'),import('./launch-storage'),import('./monitor-storage'),import('./launch-reads')]).then(([{pool},{GridLaunchStorage},{GridMonitorStorage},{GridLaunchReads}])=>{const ledger=new GridLaunchStorage(pool);return createGridMoveStorage(new GridMonitorStorage(ledger),new GridLaunchReads(pacificaTransportAuthority(),ledger,'0.5'));});
}
