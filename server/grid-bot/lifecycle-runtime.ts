import {gridLifecycleCore} from './lifecycle-core';
import {productionGridRuntimeDependencies} from './runtime-dependencies-main';
import type {GridLifecycleDeps} from './lifecycle-service';
import type {GridMonitorStorage} from './monitor-storage';
import type {GridMonitorReads} from './monitor-reads';
import type {GridLaunchReads} from './launch-reads';
export {gridTerminalFact} from './lifecycle-core';
export function gridLifecycleRuntime(storage:GridMonitorStorage,reads:GridMonitorReads,json:GridLaunchReads,authorities:Partial<Pick<GridLifecycleDeps,'resume'|'settlement'|'sol'|'recover'>>={}){return gridLifecycleCore(storage,reads,json,productionGridRuntimeDependencies(),authorities);}
