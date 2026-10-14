import {randomUUID} from 'node:crypto';
import type {GridMonitorStorage,GridMonitorClaim} from './monitor-storage';
import type {GridObservation,ReconciliationOperation} from './reconciliation';
import type {GridReconciliation} from './execution';
import {reconcileGridLimit,gridReconciliationOutcome} from './execution';
import {reconcileGridLaunch} from './launch-reconciliation';
import {requestDigest} from './launch-storage';
import {gridWindow,type WindowLevel} from './window';
import {planGridRebalance} from './rebalance';
import {reconcileGridReduction} from './lifecycle-policy';
/** Each process gets a new startup authority; persisted timestamps cannot satisfy it. */
export class GridMonitorService {
  readonly bootId=randomUUID();
  constructor(private deps:{storage:GridMonitorStorage;
    observe:(claim:GridMonitorClaim,start:number,signal:AbortSignal)=>Promise<GridObservation>;
    recover?:(operation:ReconciliationOperation,observation:GridObservation,signal:AbortSignal)=>Promise<GridReconciliation>;
  }){}
  async tick(claim:GridMonitorClaim,signal:AbortSignal){
    await this.deps.storage.block(claim,'startup_or_reconciliation_in_progress');
    let snapshot=await this.deps.storage.snapshot(claim);signal.throwIfAborted();
    for(const op of snapshot.operations.filter(o=>o.state==='prepared')){
      if(!op.exact_request||requestDigest(op.exact_request)!==op.exact_request_digest)throw Error('Unrecoverable prepared identity');
      // Never re-send a startup operation. Expired prepared rows are provably unsent by the submit CAS.
      await this.deps.storage.launch.expirePrepared(op,claim.leaseToken);signal.throwIfAborted();
    }
    const observation=await this.deps.observe(claim,new Date(snapshot.bot.created_at).getTime(),signal);signal.throwIfAborted();
    if(observation.account!==claim.account||observation.symbol!==snapshot.bot.market.replace(/-PERP$/,'')||!observation.inventoryComplete
      ||observation.observedAt>Date.now()||Date.now()-observation.observedAt>5000)throw Error('Recovery observation authority unavailable');
    for(const op of snapshot.operations.filter(o=>['submitted','unconfirmed'].includes(o.state))){
      if(!op.exact_request||requestDigest(op.exact_request)!==op.exact_request_digest)throw Error('Unrecoverable operation identity');
      let result:GridReconciliation={state:'unknown'};
      if(op.exact_request.kind==='limit')result=reconcileGridLimit(op.exact_request,observation.orders);
      else if(['cancel','close'].includes(op.exact_request.kind))result=reconcileGridReduction(op.exact_request,observation.orders);
      else if(op.exact_request.kind==='seed')result=reconcileGridLaunch(op.exact_request,{kind:'seed',account:claim.account,complete:observation.inventoryComplete,orders:observation.orders,observedAt:observation.observedAt},Date.now());
      else if(this.deps.recover)result=await this.deps.recover(op,observation,signal);
      signal.throwIfAborted();
      if(result.state!=='unknown'&&result.requestDigest===op.exact_request_digest){
        const outcome=gridReconciliationOutcome(result);
        await this.deps.storage.launch.settle(op,{...outcome,releaseSlot:op.exact_request.kind==='limit'&&result.state==='confirmed'?false:outcome.releaseSlot},claim.leaseToken);
      }
    }
    signal.throwIfAborted();const result=await this.deps.storage.reconcile(claim,this.bootId,observation);
    // Reconciliation always runs, even when movement, mark or entry authority is unavailable.
    return result;
  }
  async plan(claim:GridMonitorClaim,input:Omit<Parameters<typeof planGridRebalance>[0],'direction'|'levels'|'fills'|'reserved'|'positionSize'|'inventoryComplete'|'entriesAllowed'>){
    const state=await this.deps.storage.planningState(claim,this.bootId),snapshot=await this.deps.storage.snapshot(claim);
    const plan=planGridRebalance({...input,direction:snapshot.bot.direction,levels:state.levels.map(l=>({id:l.id,ordinal:l.ordinal,price:l.price,size:l.exact_size,side:l.side,reduceOnly:l.reduce_only,attempt:l.placement_attempt,status:l.status})),fills:state.fills,reserved:state.reserved,
      positionSize:state.observation.position?.size??null,inventoryComplete:state.observation.inventoryComplete,entriesAllowed:state.entriesAllowed&&['active','canary'].includes(snapshot.bot.status)});
    return {...plan,authority:state.authority};
  }
}
/** Pure local diff: the executor must re-observe, reserve allocations and check generation per action. */
export function gridMonitorDiff(input:Parameters<typeof gridWindow>[0]){return gridWindow(input);}
export type GridMonitorLevel=WindowLevel;
