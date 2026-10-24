import {durableGridUmk} from './service';
import {productionGridLaunchAuthority,unlockGridLaunchAgent} from './launch-authority';
import {pacificaTransportAuthority} from '../protocol/pacifica/pacifica-transport';
import {createGridSolReader} from './sol-authority';
import {createGridMoveStorage} from './move-runtime';
import type {GridRuntimeDependencies} from './runtime-dependencies';
const sol=createGridSolReader(async wallet=>(await import('../solana-balance-read')).getAgentSolBalanceLamportsStrict(wallet));
export function productionGridRuntimeDependencies():GridRuntimeDependencies {
  return {umk:durableGridUmk,unlock:unlockGridLaunchAgent,authority:productionGridLaunchAuthority,
    transport:pacificaTransportAuthority(),fetcher:fetch,sol,
    move:(storage,reads,claim,signal)=>createGridMoveStorage(storage,reads).activate(claim,signal),
    get environment(){return {REUSE_ON_CREATE:process.env.REUSE_ON_CREATE,RECYCLE_ON_DELETE:process.env.RECYCLE_ON_DELETE,
      REPLIT_DEPLOYMENT:process.env.REPLIT_DEPLOYMENT,GRID_RECYCLER_DEPLOYMENT:process.env.GRID_RECYCLER_DEPLOYMENT}}};
}
