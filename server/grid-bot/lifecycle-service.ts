import {randomUUID} from 'node:crypto';
import Decimal from 'decimal.js';
import type {GridMonitorClaim} from './monitor-storage';
import {GridLifecycleStorage} from './lifecycle-storage';
import {GridExecution,gridReconciliationOutcome,type GridReconciliation} from './execution';
import {requestDigest,type ExactGridRequest,type DurableGridOperation} from './launch-storage';
import type {GridSendResult} from './execution-failure';
import type {GridObservation} from './reconciliation';
import {gridOwnedLive,gridRiskTrigger,freshGridFact,gridEntrySafety,gridUnresolvedEntryCancel,gridUnresolvedTransfer} from './lifecycle-policy';
import {preflightGridLaunch,type LaunchFacts} from './provision';
import type {GridPolicy} from './policy-hmac';
import {gridRecyclerGate} from './runtime-policy';
const D=Decimal.clone({precision:200});
export interface GridSettlementFact {
  account:string;masterAccount:string;observedAt:number;balance:string;withdrawable:string;
  settlementComplete:true;source:string;recycler:LaunchFacts['recycler'];
}
export interface GridResumeRisk {
  account:string;symbol:string;positionSize:string;liquidationPrice:string|null;observedAt:number;source:string;
}
/** Existing positions require current liquidation authority, not the launch projection. */
export function gridResumeClearance(risk:GridResumeRisk|undefined,o:GridObservation,policy:GridPolicy,tick:string,now:number){
  try{
    if(!risk||!risk.source||risk.account!==o.account||risk.symbol!==o.symbol||!o.position||!freshGridFact(o.observedAt,now)||!freshGridFact(risk.observedAt,now)
      ||!new D(risk.positionSize).eq(o.position.size)||!policy.stopLossPrice||!new D(tick).gt(0))return false;
    if(new D(risk.positionSize).isZero())return true;
    if(o.position.direction!==policy.direction||!risk.liquidationPrice||!new D(risk.liquidationPrice).gt(0))return false;
    const liquidation=new D(risk.liquidationPrice),stop=new D(policy.stopLossPrice),clearance=D.max(tick,liquidation.mul('0.01').div(tick).ceil().mul(tick));
    return stop.mod(tick).isZero()&&(policy.direction==='long'?stop.minus(liquidation):liquidation.minus(stop)).gte(clearance);
  }catch{return false;}
}
export interface GridLifecycleDeps {
  storage:GridLifecycleStorage;
  observe:(claim:GridMonitorClaim,signal:AbortSignal)=>Promise<GridObservation>;
  send:(claim:GridMonitorClaim,r:ExactGridRequest)=>Promise<GridSendResult>;
  recover:(claim:GridMonitorClaim,op:DurableGridOperation,signal:AbortSignal)=>Promise<GridReconciliation>;
  sol:(claim:GridMonitorClaim,signal:AbortSignal)=>Promise<{balance:string;observedAt:number}|null>;
  resume:(claim:GridMonitorClaim,signal:AbortSignal)=>Promise<{policy:GridPolicy;policyHmac:string;umk:Buffer;facts:LaunchFacts;risk:GridResumeRisk;cleanup:()=>void}|null>;
  settlement:(claim:GridMonitorClaim,signal:AbortSignal)=>Promise<GridSettlementFact|null>;
  recycle:(claim:GridMonitorClaim,requestId:string,proof:GridSettlementFact)=>Promise<void>;
}
/** One bounded recovery step per tick. Submitted payloads are never refreshed or replayed. */
export class GridLifecycleService {
  constructor(private deps:GridLifecycleDeps){}
  async tick(claim:GridMonitorClaim,signal:AbortSignal){
    const s=this.deps.storage,monitor=s.monitor,launch=monitor.launch;
    const block=async(reason:string)=>{await s.blocked(claim,reason);return reason;};
    let {bot,life}=await s.state(claim);
    const observation=await this.deps.observe(claim,signal);signal.throwIfAborted();
    if(observation.account!==claim.account||observation.symbol!==bot.market.replace(/-PERP$/,''))return block('inventory_identity_unavailable');
    // Stops are evaluated in paused/range-exhausted states as well as active states.
    const trigger=gridRiskTrigger({direction:bot.direction,stopLossPrice:bot.stop_loss_price,lowerPrice:bot.lower_price,upperPrice:bot.upper_price},observation.mark,Date.now());
    if(trigger.kind==='stop'&&bot.status!=='stopping')await s.request(bot.wallet_address,claim.id,'risk-stop:'+randomUUID(),'stop',trigger.evidence,'risk',claim);
    else if(trigger.kind==='band'&&['active','canary','resuming'].includes(bot.status))await s.request(bot.wallet_address,claim.id,'band:'+randomUUID(),'band',trigger.evidence,'risk',claim);
    else if(bot.consecutive_failures>=5&&['active','canary','resuming'].includes(bot.status))await s.request(bot.wallet_address,claim.id,'breaker:'+randomUUID(),'pause',{reason:'circuit_breaker',failures:bot.consecutive_failures},'risk',claim);
    else if(bot.status==='pausing'&&life?.state!=='pending'&&['venue_rejection','policy','invariant','circuit_breaker'].includes(bot.pause_reason))await s.request(bot.wallet_address,claim.id,'failure:'+randomUUID(),'pause',{reason:bot.pause_reason},'risk',claim);
    if(!observation.inventoryComplete||!freshGridFact(observation.observedAt,Date.now()))return block('inventory_unavailable');
    let sol:null|{balance:string;observedAt:number}=null;try{sol=await this.deps.sol(claim,signal);}catch{signal.throwIfAborted();}
    await s.sol(claim,sol);({bot,life}=await s.state(claim));
    const snapshot=await monitor.snapshot(claim);
    // Recover uncertain requests first. Acknowledgments and disappearance are never terminal facts.
    let unresolvedEntryCancel=false,unresolvedTransfer=false;
    for(const op of snapshot.operations.filter(op=>['prepared','submitted','unconfirmed'].includes(op.state))){
      if(!op.exact_request||requestDigest(op.exact_request)!==op.exact_request_digest)return block('operation_identity_unavailable');
      if(op.state==='prepared'){await launch.expirePrepared(op,claim.leaseToken);return block('prepared_operation_pending');}
      const result=await this.deps.recover(claim,op,signal);signal.throwIfAborted();
      if(result.state==='unknown'||result.requestDigest!==op.exact_request_digest){
        if(life?.state==='pending'&&life.action==='stop'&&bot.status==='stopping'
          &&gridUnresolvedTransfer(op,{botId:claim.id,account:claim.account,masterAccount:claim.masterAccount},Date.now())){
          unresolvedTransfer=true;continue;
        }
        if(life?.state==='pending'&&life.action==='stop'&&bot.status==='stopping'
          &&gridUnresolvedEntryCancel(op,{botId:claim.id,account:claim.account,masterAccount:claim.masterAccount})){
          unresolvedEntryCancel=true;continue;
        }
        return block('venue_operation_unresolved');
      }
      await launch.settle(op,gridReconciliationOutcome(result),claim.leaseToken);
      return block('recovered_reobserve_required');
    }
    if(!life||life.state!=='pending')return trigger.kind==='unavailable'?trigger.reason:'idle';
    const owned=gridOwnedLive(snapshot.operations,observation),orphan=owned.some(x=>!x.operation);
    const entry=owned.find(x=>x.operation&&!x.order.reduceOnly);
    const act=async(kind:'cancel'|'close'|'sweep',data:Record<string,unknown>,authority:Record<string,unknown>)=>{
      const now=Date.now(),r:ExactGridRequest={kind,botId:claim.id,account:claim.account,masterAccount:claim.masterAccount,
        path:kind==='cancel'?'/orders/cancel':kind==='close'?'/orders/create_market':'/account/subaccount/transfer',
        operationType:kind==='cancel'?'cancel_order':kind==='close'?'create_market_order':'transfer_funds',timestamp:now,expiryMs:5000,data,
        authority:{...authority,lifecycleEpoch:String(life.epoch),controlRequestId:life.active_request}};
      const execution=new GridExecution({storage:launch,preflight:async retained=>{
        signal.throwIfAborted();const current=await s.state(claim);
        return current.life?.active_request===life.active_request&&String(current.life.epoch)===String(life.epoch)&&requestDigest(retained)===requestDigest(r)&&freshGridFact(observation.observedAt,Date.now());
      },send:retained=>this.deps.send(claim,retained),reconcile:op=>this.deps.recover(claim,op,signal)});
      return execution.run('control:'+life.active_request+':'+randomUUID(),r,{credits:'10',slots:0,canaryIncrement:'0',observedCredits:'300',availableSlots:0,observedAt:now,expiresAt:now+5000},claim.leaseToken);
    };
    const cancel=async(target:NonNullable<typeof entry>)=>act('cancel',{symbol:target.order.symbol,order_id:target.order.orderId},{levelId:target.operation!.level_id,originalRequest:target.operation!.exact_request});
    if(entry&&!unresolvedEntryCancel)return cancel(entry);
    // Preserve all backed reduce-only exits while pausing. Orphans require owner investigation.
    if(orphan)return block('unrelated_order_requires_review');
    if(life.action==='pause'||life.action==='band'){
      await s.complete(claim,life.active_request,life.action==='band'?'range_exhausted':'paused');return 'paused';
    }
    await s.safetyObservation(claim,observation);
    let reconciled:{entriesAllowed:boolean;reconciliationComplete?:boolean}={entriesAllowed:false};
    try{reconciled=await monitor.reconcile(claim,randomUUID(),observation);}catch(error){
      if(life.action!=='stop')throw error; // Economic uncertainty must not disable a retained reduce-only stop.
    }
    if(life.action==='resume'||life.action==='resync'){
      if(!reconciled.entriesAllowed)return block('reconciliation_required');
      if(life.action==='resync'){
        // Re-sync never silently resumes an entry-denied bot.
        const target=life.previous_status==='range_exhausted'?'range_exhausted':'paused';
        await s.complete(claim,life.active_request,target);return target;
      }
      if(!gridEntrySafety({sol:bot.sol_balance,solObservedAt:bot.sol_balance_observed_at?new Date(bot.sol_balance_observed_at).getTime():null,failures:bot.consecutive_failures,mark:observation.mark},Date.now()).allowed)return block('resume_risk_denied');
      const authority=await this.deps.resume(claim,signal);if(!authority)return block('resume_authority_unavailable');
      try {
        if(authority.policy.id!==claim.id||authority.policyHmac!==bot.policy_hmac||authority.facts.account!==claim.account
          ||authority.facts.masterAccount!==claim.masterAccount)return block('resume_identity_changed');
        if(!gridResumeClearance(authority.risk,observation,authority.policy,authority.facts.tick,Date.now()))return block('resume_current_stop_clearance_unavailable');
        const gate=preflightGridLaunch(authority.policy,authority.policyHmac,authority.umk,authority.facts,Date.now(),true);
        if(!gate.ok)return block('resume_policy_or_current_authority_denied');
        await s.complete(claim,life.active_request,'canary');return 'resumed';
      }finally{authority.cleanup();}
    }
    if(life.action!=='stop')return block('unknown_control');
    if(!observation.position)return block('position_unavailable');
    if(new D(observation.position.size).gt(0)){
      if(observation.position.direction!==bot.direction)return block('position_direction_changed');
      // Existing protective exits remain in place until a confirmed reduce-only close leaves zero.
      return act('close',{symbol:observation.symbol,side:bot.direction==='long'?'ask':'bid',amount:observation.position.size,reduce_only:true,slippage_percent:'0.5',client_order_id:randomUUID()},{});
    }
    // Flat now is not terminal: the retained entry may still fill on a later tick.
    if(unresolvedEntryCancel)return block('venue_operation_unresolved');
    const exit=owned.find(x=>x.operation);if(exit)return cancel(exit);
    if(unresolvedTransfer)return block('transfer_recovery_requires_C4');
    if(!(reconciled.reconciliationComplete??reconciled.entriesAllowed))return block('terminal_history_unavailable');
    const settlement=await this.deps.settlement(claim,signal);
    if(!settlement||settlement.account!==claim.account||settlement.masterAccount!==claim.masterAccount||!settlement.settlementComplete||!settlement.source
      ||!freshGridFact(settlement.observedAt,Date.now())||!gridRecyclerGate(settlement.recycler,Date.now()))return block('settlement_or_recycler_unavailable');
    if(!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(settlement.balance)||!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(settlement.withdrawable))return block('balance_unavailable');
    if(new D(settlement.balance).gt(0)){
      if(!new D(settlement.withdrawable).eq(settlement.balance))return block('unexplained_unsweepable_residual');
      return act('sweep',{to_account:claim.masterAccount,amount:settlement.balance,idempotency_key:randomUUID()},{settlementComplete:true,settlement});
    }
    if(!new D(settlement.withdrawable).isZero())return block('inconsistent_balance');
    await this.deps.recycle(claim,life.active_request,settlement);return 'stopped';
  }
}
