import { isGridCyclePolicyVersion } from '../../shared/grid-behaviour';
import {gridResumeClearance,type GridResumeRisk} from './resume-clearance';
export {gridResumeClearance,type GridResumeRisk} from './resume-clearance';
import {cycleCloseAllocations} from './cycle-storage';
import {randomUUID} from 'node:crypto';
import Decimal from 'decimal.js';
import type {GridMonitorClaim} from './monitor-storage';
import {GridLifecycleStorage} from './lifecycle-storage';
import {GridExecution,gridReconciliationOutcome,type GridReconciliation} from './execution';
import {GridLaunchTransientError,GRID_ACTION_CREDITS,requestDigest,type ExactGridRequest,type DurableGridOperation} from './launch-storage';
import type {GridSendResult} from './execution-failure';
import type {GridObservation} from './reconciliation';
import {gridOwnedLive,gridRiskTrigger,freshGridFact,gridEntrySafety,gridUnresolvedEntryCancel,gridUnresolvedTransfer} from './lifecycle-policy';
import {preflightGridResume,type LaunchFacts} from './provision';
import type {GridPolicy} from './policy-hmac';
import {gridRecyclerGate} from './runtime-policy';
import type {GridAutoResumeToken} from './auto-resume-storage';
import type {WindowOrder} from './window';
const D=Decimal.clone({precision:200});
export interface GridSettlementFact {
  account:string;masterAccount:string;observedAt:number;balance:string;withdrawable:string;
  settlementComplete:true;source:string;recycler:LaunchFacts['recycler'];
}
export interface GridLifecycleDeps {
  storage:GridLifecycleStorage;
  marketTick?:(claim:GridMonitorClaim,signal:AbortSignal)=>Promise<string|null>;
  observe:(claim:GridMonitorClaim,signal:AbortSignal)=>Promise<GridObservation>;
  send:(claim:GridMonitorClaim,r:ExactGridRequest)=>Promise<GridSendResult>;
  recover:(claim:GridMonitorClaim,op:DurableGridOperation,signal:AbortSignal)=>Promise<GridReconciliation>;
  sol:(claim:GridMonitorClaim,signal:AbortSignal)=>Promise<{balance:string;observedAt:number}|null>;
  resume:(claim:GridMonitorClaim,signal:AbortSignal)=>Promise<{policy:GridPolicy;policyHmac:string;umk:Buffer;facts:LaunchFacts;risk:GridResumeRisk;cleanup:()=>void}|null>;
  move?:(claim:GridMonitorClaim,signal:AbortSignal)=>Promise<string>;
  settlement:(claim:GridMonitorClaim,signal:AbortSignal)=>Promise<GridSettlementFact|null>;
  recycle:(claim:GridMonitorClaim,requestId:string,proof:GridSettlementFact)=>Promise<void>;
}
/** One bounded recovery step per tick. Submitted payloads are never refreshed or replayed. */
export class GridLifecycleService {
  constructor(private deps:GridLifecycleDeps){}
  async tick(claim:GridMonitorClaim,signal:AbortSignal){
    const s=this.deps.storage,monitor=s.monitor,launch=monitor.launch;
    let autoPermit:GridAutoResumeToken|undefined;
    const block=async(reason:string)=>{
      if(s.auto){
        const held=reason.includes('stop_clearance')?'stop_clearance_unavailable':reason.includes('operation')?'operation_pending':reason.includes('inventory')||reason.includes('reconciliation')?'reconciliation_required':reason.includes('risk')?'risk_pause':reason.includes('identity')||reason.includes('policy')?'policy_changed':'resume_authority_unavailable';
        await s.auto.hold(claim,held,!!autoPermit&&reason!=='resume_retry_waiting',autoPermit);
      }
      await s.blocked(claim,reason);return reason;
    };
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
    let resumeBoot:string|undefined;
    if(s.auto&&(bot.status==='range_exhausted'||life?.source==='auto'&&life.state==='pending')&&await s.auto.armed(claim)){
      if(!gridEntrySafety({sol:bot.sol_balance,solObservedAt:bot.sol_balance_observed_at?new Date(bot.sol_balance_observed_at).getTime():null,failures:bot.consecutive_failures,mark:observation.mark},Date.now()).allowed){await s.auto.hold(claim,'risk_pause',true);return block('resume_risk_denied');}
      await s.safetyObservation(claim,observation);resumeBoot=randomUUID();
      const reconciliation=await monitor.reconcile(claim,resumeBoot,observation);
      if(!reconciliation.entriesAllowed){await s.auto.hold(claim,'reconciliation_required');return block('reconciliation_required');}
      let tick:string|null=null;try{tick=await this.deps.marketTick?.(claim,signal)??null;}catch{signal.throwIfAborted();}
      if(!tick){await s.auto.hold(claim,'market_data_unavailable');return 'market_data_unavailable';}
      autoPermit=await s.auto.reserve(claim,tick,observation.mark)??undefined;
      if(!autoPermit)return 'auto_resume_waiting';
      ({bot,life}=await s.state(claim));
      if(!await s.auto.current(claim,autoPermit,tick))return 'auto_resume_superseded';
    }
    if(!life||life.state!=='pending')return trigger.kind==='unavailable'?trigger.reason:'idle';
    const owned=gridOwnedLive(snapshot.operations,observation),orphan=owned.some(x=>!x.operation);
    const entry=owned.find(x=>x.operation&&!x.order.reduceOnly);
    const act=async(kind:'cancel'|'close'|'sweep',data:Record<string,unknown>,authority:Record<string,unknown>)=>{
      const cycleClose=isGridCyclePolicyVersion(bot.policy_version)&&kind==='close'?(await monitor.planningState(claim,bootId)).cycle:undefined;
      const now=Date.now(),r:ExactGridRequest={kind,botId:claim.id,account:claim.account,masterAccount:claim.masterAccount,
        path:kind==='cancel'?'/orders/cancel':kind==='close'?'/orders/create_market':'/account/subaccount/transfer',
        operationType:kind==='cancel'?'cancel_order':kind==='close'?'create_market_order':'transfer_funds',timestamp:now,expiryMs:5000,data,
        authority:{...authority,...(cycleClose?{cycleAllocations:cycleCloseAllocations(cycleClose,String(data.amount))}:{}),lifecycleEpoch:String(life.epoch),controlRequestId:life.active_request}};
      const execution=new GridExecution({storage:launch,preflight:async retained=>{
        signal.throwIfAborted();const current=await s.state(claim);
        return current.life?.active_request===life.active_request&&String(current.life.epoch)===String(life.epoch)&&requestDigest(retained)===requestDigest(r)&&freshGridFact(observation.observedAt,Date.now());
      },send:retained=>this.deps.send(claim,retained),reconcile:op=>this.deps.recover(claim,op,signal)});
        return execution.run('control:'+life.active_request+':'+randomUUID(),r,{credits:GRID_ACTION_CREDITS,slots:0,canaryIncrement:'0',observedCredits:'300',availableSlots:0,observedAt:now,expiresAt:now+5000},claim.leaseToken);
    };
    const cancel=async(target:NonNullable<typeof entry>)=>act('cancel',{symbol:target.order.symbol,order_id:target.order.orderId},{levelId:target.operation!.level_id,originalRequest:target.operation!.exact_request});
    if(entry&&!unresolvedEntryCancel)return cancel(entry);
    // Preserve all backed reduce-only exits while pausing. Orphans require owner investigation.
    if(orphan)return block('unrelated_order_requires_review');
    if(life.action==='regrid'){
      const remaining=owned.find(x=>x.operation);if(remaining)return cancel(remaining);
      await s.safetyObservation(claim,observation);
      const checked=await monitor.reconcile(claim,randomUUID(),observation);
      if(!(checked.reconciliationComplete??checked.entriesAllowed))return block('reconciliation_required');
      return this.deps.move?this.deps.move(claim,signal):block('range_move_unavailable');
    }
    if(life.action==='pause'||life.action==='band'){
      if(life.action==='band'){
        await s.safetyObservation(claim,observation);
        const reconciled=await monitor.reconcile(claim,randomUUID(),observation);
        if(!(reconciled.reconciliationComplete??reconciled.entriesAllowed))return block('reconciliation_required');
        if(s.auto){const identity=await s.auto.identity(bot.wallet_address,claim.id);await s.complete(claim,life.active_request,'range_exhausted',{identity});}
        else await s.complete(claim,life.active_request,'range_exhausted');
      }else await s.complete(claim,life.active_request,'paused');
      return 'paused';
    }
    if(!resumeBoot)await s.safetyObservation(claim,observation);
    const bootId=resumeBoot??randomUUID();
    let reconciled:{entriesAllowed:boolean;reconciliationComplete?:boolean}={entriesAllowed:false};
    try{reconciled=resumeBoot?{entriesAllowed:true}:await monitor.reconcile(claim,bootId,observation);}catch(error){
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
      let authority:Awaited<ReturnType<GridLifecycleDeps['resume']>>;
      try{authority=await this.deps.resume(claim,signal);}catch(error){
        signal.throwIfAborted();
        if(autoPermit&&error instanceof GridLaunchTransientError){await s.auto.transient(claim,autoPermit);return 'resume_retry_waiting';}
        return block('resume_authority_unavailable');
      }
      if(!authority)return block('resume_authority_unavailable');
      try {
        if(autoPermit&&!await s.auto.current(claim,autoPermit,authority.facts.tick))return 'auto_resume_superseded';
        if(authority.policy.id!==claim.id||authority.policyHmac!==bot.policy_hmac||authority.facts.account!==claim.account
          ||authority.facts.masterAccount!==claim.masterAccount)return block('resume_identity_changed');
        if(!gridResumeClearance(authority.risk,observation,authority.policy,authority.facts.tick,Date.now()))return block('resume_current_stop_clearance_unavailable');
        const planning=await monitor.planningState(claim,bootId);
        const exposure=await launch.transaction(async c=>{await c.query('SELECT master_account FROM grid_master_quota WHERE master_account=$1 FOR UPDATE',[claim.masterAccount]);await monitor.assertLease(c,claim);return launch.pilotExposure(c,claim.id,Date.now());});
        const remaining=exposure.limitUsd!==null&&exposure.exposureUsd!==null?D.max(0,new D(exposure.limitUsd).minus(exposure.exposureUsd)).toFixed():'0';
        const ownedOrders:WindowOrder[]=owned.map(({order,operation})=>{if(!operation?.level_id||!order.clientOrderId)throw Error('Resume ownership unavailable');return {levelId:operation.level_id,orderId:order.orderId,clientOrderId:order.clientOrderId,reduceOnly:order.reduceOnly,...(isGridCyclePolicyVersion(bot.policy_version)?{cycleLeg:order.reduceOnly?'closing' as const:'opening' as const}:{}),remaining:new D(order.amount).minus(order.filledAmount).minus(order.cancelledAmount??'0').toFixed()};});
        const gate=preflightGridResume(authority.policy,authority.policyHmac,authority.umk,authority.facts,Date.now(),{
          ...(planning.cycle?{cycleReplay:planning.cycle.input}:{}),direction:authority.policy.direction,levels:planning.levels.map(l=>({id:l.id,ordinal:l.ordinal,price:l.price,size:l.exact_size,side:l.side,reduceOnly:l.reduce_only,attempt:l.placement_attempt,status:l.status})),fills:planning.fills,reserved:planning.reserved,owned:ownedOrders,
          positionSize:planning.observation.position?.size??null,bookPrice:authority.facts.bookPrice,lot:authority.facts.lot,minimumQuote:authority.facts.minimumQuote,freeSlots:authority.facts.availableSlots,inventoryComplete:planning.observation.inventoryComplete,entriesAllowed:planning.entriesAllowed,canaryRemaining:remaining});
        if(!gate.ok){if(autoPermit&&'transient' in gate&&gate.transient){await s.auto.transient(claim,autoPermit);return 'resume_retry_waiting';}return block('resume_policy_or_current_authority_denied');}
        if(autoPermit&&!await s.auto.current(claim,autoPermit,authority.facts.tick))return 'auto_resume_superseded';
        await s.complete(claim,life.active_request,'canary',{epoch:String(life.epoch),token:autoPermit,tick:authority.facts.tick,identity:{policyHash:authority.policyHmac,umkVersion:authority.facts.agentGeneration.umkVersion}});return 'resumed';
      }finally{authority.cleanup();}
    }
    if(life.action!=='stop')return block('unknown_control');
    if(isGridCyclePolicyVersion(bot.policy_version)){const exit=owned.find(x=>x.operation);if(exit)return cancel(exit);}
    if(!observation.position)return block('position_unavailable');
    if(new D(observation.position.size).gt(0)){
      if(observation.position.direction!==bot.direction)return block('position_direction_changed');
      // Existing protective exits remain in place until a confirmed reduce-only close leaves zero.
      return act('close',{symbol:observation.symbol,side:bot.direction==='long'?'ask':'bid',amount:observation.position.size,reduce_only:true,slippage_percent:'0.5',client_order_id:randomUUID()},{});
    }
    // Flat now is not terminal: the retained entry may still fill on a later tick.
    if(unresolvedEntryCancel)return block('venue_operation_unresolved');
    const exit=owned.find(x=>x.operation);if(exit)return cancel(exit);
    if(unresolvedTransfer)return block('transfer_outcome_unknown');
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
