import type {GridLaunchAuthority,GridLaunchSecurity,GridLaunchAuthorityDeps} from './launch-authority-core';
import type {GridLaunchReads} from './launch-reads';
import type {GridLaunchStorage} from './launch-storage-core';
import type {GridMonitorStorage,GridMonitorClaim} from './monitor-storage';
import type {PacificaTransportAuthority} from '../protocol/pacifica/pacifica-transport';
import type {GridLifecycleDeps} from './lifecycle-service';
export interface GridRuntimeDependencies {
  umk(wallet:string):Promise<{umk:Buffer;cleanup:()=>void}|null>;
  unlock(wallet:string,umk:Buffer):Promise<GridLaunchSecurity|null>;
  authority(reads:GridLaunchReads,ledger:GridLaunchStorage):GridLaunchAuthority;
  transport:PacificaTransportAuthority;
  fetcher:typeof fetch;
  sol:GridLaunchAuthorityDeps['sol'];
  move(storage:GridMonitorStorage,reads:GridLaunchReads,claim:GridMonitorClaim,signal:AbortSignal):ReturnType<NonNullable<GridLifecycleDeps['move']>>;
  environment:ReturnType<GridLaunchAuthorityDeps['environment']>;
}
