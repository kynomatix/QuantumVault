import type {GridMonitorClaim} from './monitor-storage';

export interface GridExecutorDeps {
  recover(claim:GridMonitorClaim,signal:AbortSignal):Promise<void>;
  lifecycle(claim:GridMonitorClaim,signal:AbortSignal):Promise<string>;
  status(claim:GridMonitorClaim):Promise<string>;
  provision(claim:GridMonitorClaim,signal:AbortSignal):Promise<unknown>;
  reconcile(claim:GridMonitorClaim,signal:AbortSignal):Promise<{entriesAllowed:boolean;reconciliationComplete?:boolean}>;
  roll(claim:GridMonitorClaim,signal:AbortSignal,entriesAllowed:boolean):Promise<unknown>;
}
/** Recovery may settle old requests, but only lifecycle and fresh authority can permit a new send. */
export class GridExecutor {
  constructor(private deps:GridExecutorDeps){}
  async tick(claim:GridMonitorClaim,signal:AbortSignal){
    await this.deps.recover(claim,signal);signal.throwIfAborted();
    if(await this.deps.lifecycle(claim,signal)==='stopped')return;
    signal.throwIfAborted();const status=await this.deps.status(claim);
    if(status==='provisioning')return this.deps.provision(claim,signal);
    const reconciled=await this.deps.reconcile(claim,signal);signal.throwIfAborted();
    if(!(reconciled.reconciliationComplete??reconciled.entriesAllowed))return;
    const current=await this.deps.status(claim);
    // Retained exits stay supervised while waiting; the planner receives no entry authority.
    if(['active','canary','paused','range_exhausted','resuming'].includes(current))return this.deps.roll(claim,signal,['active','canary'].includes(current)&&reconciled.entriesAllowed);
  }
}
