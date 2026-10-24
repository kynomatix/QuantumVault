import type {GridRuntimeDependencies} from '../grid-bot/runtime-dependencies';
let keyReader:GridRuntimeDependencies['umk']=async()=>null;
let allowed=()=>false;
/** Explicit build-time replacement of MAIN's session-backed service for the worker artifact. */
export function installWorkerBindings(read:GridRuntimeDependencies['umk'],gates:()=>boolean){keyReader=read;allowed=gates;}
export const durableGridUmk=(wallet:string)=>keyReader(wallet);
export function gridRuntimeGates(){const enabled=allowed();return {draftEnabled:enabled,startConfigured:enabled,workerEnabled:enabled,workerRunning:enabled,startEnabled:enabled,draftOnly:!enabled};}
