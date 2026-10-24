import {loadActiveGridLevels} from './active-epoch';
import { isGridCyclePolicyVersion } from '../../shared/grid-behaviour';
import {windowLevelKey} from './window';
import type {GridResumeRisk} from './resume-clearance';
import Decimal from 'decimal.js';
import {GridCustody,type GridAccount} from './custody';
import {GridExecution,GridPacificaSender,reconcileGridLimit,gridReconciliationOutcome,type GridReconciliation} from './execution';
import {GridExecutor} from './executor';
import {GridFirstPlacementAuthority} from './first-placement';
import {retainedGridPolicy,gridProductionResume,type GridLaunchSecurity} from './launch-authority-core';
import type {GridRuntimeDependencies} from './runtime-dependencies';
import type {GridLaunchReads} from './launch-reads';
import {reconcileGridLaunch} from './launch-reconciliation';
import {recoverGridTransfer} from './transfer-recovery';
import {GridLaunchTransientError,requestDigest,GRID_ACTION_CREDITS,gridProvisionAttempt,gridOperationCouldHaveLanded,type ExactGridRequest,type DurableGridOperation,type GridClaim} from './launch-storage-core';
import {gridOwnedLive,reconcileGridReduction} from './lifecycle-policy';
import {gridLifecycleCore} from './lifecycle-core';
import {gridResumeClearance} from './lifecycle-service';
import {gridAddsExposure} from './margin';
import type {GridMonitorReads} from './monitor-reads';
import {GridMonitorService} from './monitor-service';
import type {GridMonitorStorage,GridMonitorClaim} from './monitor-storage';
import {executeGridWindow,gridLevelRequest,validGridLevelAuthority} from './placement';
import {verifyGridPolicyHmac,type GridPolicy} from './policy-hmac';
import {GridProvision,type LaunchFacts} from './provision-core';
import {gridProvisionEmpty,gridProvisionRecoveryEvidence} from './provision-evidence';

import {observePacificaConstraints} from '../protocol/market-constraints';

import type {WindowLevel,WindowOrder} from './window';
import {startRetainedGrid} from './start-service';
import type {GridStartRequest} from '../../shared/grid-start';

const claimFor=(a:GridAccount):GridMonitorClaim=>({id:a.botId,leaseToken:a.leaseToken,account:a.account,masterAccount:a.masterAccount});
const constraintFor=(f:LaunchFacts)=>observePacificaConstraints({tick_size:f.tick,lot_size:f.lot,min_order_size:f.minimumQuote},f.market,f.observedAt);
const generation=(a:GridAccount,f:LaunchFacts)=>`${a.masterAccount}:${f.agentGeneration.umkVersion}:${a.leaseToken}`;
const quotaClaim=(f:LaunchFacts,slots:0|1,increment='0'):GridClaim=>({credits:GRID_ACTION_CREDITS,slots,canaryIncrement:increment,observedCredits:f.observedCredits,
  availableSlots:f.availableSlots,observedAt:f.observedAt,expiresAt:f.expiresAt});

/** Explicit production composition. No caller-supplied facts or session keys enter this path. */
export function gridExecutorCore(storage:GridMonitorStorage,reads:GridMonitorReads,json:GridLaunchReads,dependencies:GridRuntimeDependencies){
  const ledger=storage.launch,custody=new GridCustody(ledger),authority=dependencies.authority(json,ledger);
  const sender=new GridPacificaSender(dependencies.transport,dependencies.fetcher,new GridFirstPlacementAuthority(ledger,json),ledger);
  async function withAgent<T>(wallet:string,master:string,work:(agent:GridLaunchSecurity)=>Promise<T>):Promise<T>{
    const key=await dependencies.umk(wallet);if(!key)throw Error('Grid durable security unavailable');
    let agent:GridLaunchSecurity|null=null;
    try{agent=await dependencies.unlock(wallet,key.umk);if(!agent||agent.masterAccount!==master||!await agent.current())throw Error('Grid agent generation unavailable');
      const result=await work(agent);if(!await agent.current())throw Error('Grid agent generation changed');return result;
    }finally{agent?.cleanup();key.cleanup();}
  }
  async function observe(claim:GridMonitorClaim,signal:AbortSignal){const {bot}=await storage.snapshot(claim);
    return reads.observe({...claim,symbol:bot.market.replace(/-PERP$/,''),from:new Date(bot.created_at).getTime(),through:Date.now()},signal);
  }
  async function recover(claim:GridMonitorClaim,op:DurableGridOperation,signal:AbortSignal):Promise<GridReconciliation>{
    const r=op.exact_request;
    if(requestDigest(r)!==op.exact_request_digest||r.botId!==claim.id||r.account!==claim.account||r.masterAccount!==claim.masterAccount)throw Error('Grid recovery identity changed');
    if(r.kind==='fund'||r.kind==='sweep')return recoverGridTransfer(storage,json,claim,op,async()=>{
      const {bot}=await storage.snapshot(claim);
      return withAgent(bot.wallet_address,claim.masterAccount,a=>json.subaccounts(claim.masterAccount,a.signingKey,signal));
    },signal);
    if(r.kind==='create'||r.kind==='leverage'){
      const {bot}=await storage.snapshot(claim),started=Date.now();
      const raw=r.kind==='create'?await withAgent(bot.wallet_address,claim.masterAccount,a=>json.subaccounts(claim.masterAccount,a.signingKey,signal))
        :await json.json(claim.masterAccount,'/account/settings',{account:claim.account},signal);
      signal.throwIfAborted();return reconcileGridLaunch(r,gridProvisionRecoveryEvidence(r,raw,started,Date.now()),Date.now());
    }
    const o=await observe(claim,signal);signal.throwIfAborted();
    if(!o.inventoryComplete||o.account!==claim.account||o.symbol!==r.data.symbol||o.observedAt>Date.now()||Date.now()-o.observedAt>=5000)return {state:'unknown'};
    if(r.kind==='limit')return reconcileGridLimit(r,o.orders);
    if(r.kind==='seed')return reconcileGridLaunch(r,{kind:'seed',account:claim.account,complete:true,orders:o.orders,observedAt:o.observedAt},Date.now());
    return reconcileGridReduction(r,o.orders);
  }
  async function recoverPending(claim:GridMonitorClaim,signal:AbortSignal){
    const {operations}=await storage.snapshot(claim);
    for(const op of operations){signal.throwIfAborted();
      if(op.state==='prepared'){if(requestDigest(op.exact_request)!==op.exact_request_digest)throw Error('Grid prepared identity changed');await ledger.expirePrepared(op,claim.leaseToken);}
      else if(['submitted','unconfirmed'].includes(op.state)){
        const result=await recover(claim,op,signal);
        if(result.state!=='unknown'&&result.requestDigest===op.exact_request_digest){const outcome=gridReconciliationOutcome(result);
          await ledger.settle(op,{...outcome,releaseSlot:riskHeld(op,result)?false:outcome.releaseSlot},claim.leaseToken);}
      }
    }
  }
  // Terminal orders keep their slot until full trade reconciliation accounts for every actual fill.
  function riskHeld(op:DurableGridOperation,result:Exclude<GridReconciliation,{state:'unknown'}>){return op.exact_request.kind==='limit'&&result.state==='confirmed';}
  const lifecycle=gridLifecycleCore(storage,reads,json,dependencies,{recover,resume:gridProductionResume(storage,authority,dependencies.umk)});
  const monitor=new GridMonitorService({storage,observe:(claim,_from,signal)=>observe(claim,signal),recover:(op,_o,signal)=>recover(
    {id:op.exact_request.botId,account:op.exact_request.account,masterAccount:op.exact_request.masterAccount,leaseToken:activeLease(op.exact_request.botId)},op,signal)});
  // The monitor is serial; only the current bounded tick may use this recovery closure.
  const leases=new Map<string,string>();
  function activeLease(id:string){
    const leaseToken=leases.get(id);
    if(!leaseToken)throw Error('Grid active worker unavailable');
    return leaseToken;
  }
  async function empty(account:GridAccount,signal:AbortSignal){const started=Date.now();
    return withAgent(account.wallet,account.masterAccount,async agent=>{
      const inventory=await json.subaccounts(account.masterAccount,agent.signingKey,signal);
      // A failed account GET cannot become zero. Signed absence is independently sufficient for create only.
      let raw:unknown=null;try{raw=await json.json(account.masterAccount,'/account',{account:account.account},signal);}catch{signal.throwIfAborted();}
      return gridProvisionEmpty(account,inventory,raw,started,Date.now());
    });
  }
  function execution(account:GridAccount,policy:GridPolicy,policyHmac:string,umk:Buffer,signal:AbortSignal){const claim=claimFor(account);
    return new GridExecution({storage:ledger,preflight:async r=>{
      signal.throwIfAborted();const {bot,levels}=await storage.snapshot(claim),now=Date.now();
      if(bot.policy_hmac!==policyHmac||!verifyGridPolicyHmac(retainedGridPolicy(bot,levels),umk,policyHmac).ok
        ||r.authority.policyHmac!==policyHmac||r.account!==account.account||r.masterAccount!==account.masterAccount)return false;
      const life=await lifecycle.lifecycle.state(claim);
      if(life.life&&String(life.life.epoch)!==String(r.authority.lifecycleEpoch))return false;
      if(!(gridAddsExposure(r)?['provisioning','active','canary']:['provisioning','active','canary','paused','range_exhausted','resuming']).includes(bot.status))return false;
      const f=r.authority.facts as LaunchFacts|undefined;
      if(!f||f.market!==policy.market||f.masterAccount!==account.masterAccount||!f.agentGeneration||f.agentGeneration.wallet!==account.wallet
        ||f.agentGeneration.masterAccount!==account.masterAccount||!Number.isSafeInteger(f.agentGeneration.umkVersion)||f.agentGeneration.umkVersion<1
        ||f.account!==(r.kind==='create'?null:account.account)||!f.margin||f.margin.account!==(r.kind==='create'?account.masterAccount:account.account)
        ||f.margin.symbol!==policy.market.replace(/-PERP$/,'')||![f.margin.observedAt,f.margin.accountUpdatedAt].every(t=>Number.isSafeInteger(t)&&t<=now&&now-t<5000)
        ||f.observedAt>now||f.expiresAt<=now||now-f.observedAt>=5000)return false;
      if(r.kind==='limit'){
        if(!validGridLevelAuthority(r,{account:account.account,subaccountId:null,signerPublicKey:account.account,signerGeneration:generation(account,f),
          deployment:f.recycler.deployment,endpoint:'https://api.pacifica.fi/api/v1/orders/create',...(isGridCyclePolicyVersion(policy.policyVersion)?{runtimePolicyVersion:policy.runtimePolicyVersion}:{}),constraint:constraintFor(f)},now))return false;
        const price=new Decimal(String(r.data.price)),notional=price.mul(String(r.data.amount));
        if(price.lt(f.minimumPrice)||price.gt(f.maximumPrice)||(r.data.reduce_only!==true&&notional.lt(f.minimumQuote))||notional.gt(f.maximumQuote))return false;
      }
      return !gridAddsExposure(r)||f.margin.leverage===String(policy.leverage);
    },send:r=>withAgent(account.wallet,account.masterAccount,async agent=>{
      signal.throwIfAborted();const f=r.authority.facts as LaunchFacts;
      if(agent.umkVersion!==f.agentGeneration.umkVersion)throw Error('Grid signing generation changed');
      // Share the agent's bytes so cleanup also wipes the sender's view.
      const masterSecret=['create','fund'].includes(r.kind)?Buffer.from(agent.signingKey.buffer,agent.signingKey.byteOffset,agent.signingKey.byteLength):undefined;
      return custody.withSecret(account,umk,secret=>sender.send(r,secret,masterSecret,account.leaseToken));
    }),reconcile:op=>recover(claim,op,signal)});
  }
  async function beforeStep(account:GridAccount,kind:ExactGridRequest['kind'],signal:AbortSignal){const claim=claimFor(account);
    if(kind==='create'){
      const proof=await empty(account,signal);await storage.authorizeProvisioning(claim,account,proof);return {};
    }
    await lifecycle.service.tick(claim,signal);
    const {bot}=await storage.snapshot(claim);if(bot.status!=='provisioning')throw new GridLaunchTransientError('Grid lifecycle blocks provisioning');
    const result=await monitor.tick(claim,signal);if(!result.entriesAllowed)throw new GridLaunchTransientError('Grid provisioning requires full reconciliation');
    return (await storage.planningState(claim,monitor.bootId)).authority;
  }
  async function provision(wallet:string,policy:GridPolicy,policyHmac:string,signal:AbortSignal,retained?:GridAccount){
    const key=await dependencies.umk(wallet);if(!key)throw Error('Grid durable security unavailable');let account=retained;
    try{
      const p=new GridProvision({cycleExecutionReady:true,now:Date.now,durableUmk:async()=>({umk:key.umk,cleanup:()=>{}}),
        cycleFirstWindow:async a=>{
          const claim=claimFor(a);await roll(claim,signal,true);
          return (await storage.snapshot(claim)).operations.some(op=>op.state==='confirmed'&&op.exact_request?.kind==='limit'&&op.exact_request.data.reduce_only===false);
        },
        observe:async(p,a)=>{
          // A restart may own a reserved address that has never existed at the venue.
          const created=a&&!a.reused?(await gridProvisionAttempt((id,botId)=>ledger.read(botId,id),a.botId,'create',Date.now())).op:null;
          const absent=a&&!a.reused&&!gridOperationCouldHaveLanded(created)&&(await empty(a,signal)).state==='absent';
          return authority.observe(wallet,p,absent?null:a,key.umk,signal);
        },custody:{reserve:async(input,umk)=>{
          account=await custody.reserve(input,umk);leases.set(account.botId,account.leaseToken);return account;
        },confirmCreated:a=>custody.confirmCreated(a),confirmReused:(a,proof,now)=>custody.confirmReused(a,proof,now)},
        verifyEmpty:a=>empty(a,signal),existing:(id,botId)=>ledger.read(botId,id),markCanary:a=>ledger.markCanary(a),
        beforeStep:(a,kind)=>beforeStep(a,kind,signal),execution:{run:(id,r,c,token)=>{
          if(!account||account.leaseToken!==token)throw Error('Grid launch custody unavailable');return execution(account,policy,policyHmac,key.umk,signal).run(id,r,c,token);
        }},prepareFirstEntry:async({account:a,admission,facts,now})=>{
          const state=await storage.planningState(claimFor(a),monitor.bootId),line=state.levels.find(l=>l.ordinal===admission.firstEntryOrdinal);
          if(!line||!Number.isSafeInteger(line.placement_attempt)||line.placement_attempt<0||line.status!=='pending')throw new GridLaunchTransientError('Grid first level requires recovery');
          const level:WindowLevel={id:line.id,ordinal:line.ordinal,price:line.price,size:line.size,side:line.side,reduceOnly:line.reduce_only,attempt:line.placement_attempt};
          return {request:gridLevelRequest({account:a,level,market:policy.market,protocolSymbol:policy.market.replace(/-PERP$/,''),signerGeneration:generation(a,facts),
            deployment:facts.recycler.deployment,fee:facts.maker,constraint:constraintFor(facts),now,authority:{...state.authority,policy,policyHmac,facts}}),
            claim:quotaClaim(facts,1,new Decimal(level.price).mul(level.size).toFixed())};
        }});
      const result=await p.start({wallet,policy,policyHmac,...(retained?{account:retained}:{})});
      const deniedAccount=result.account??account;
      if(result.state==='denied'&&deniedAccount)await storage.provisioningDenied(claimFor(deniedAccount),result.reason??'Launch authority unavailable');
      return result;
    }finally{key.cleanup();if(!retained&&account){try{await storage.release(claimFor(account));}finally{leases.delete(account.botId);}}}
  }
  async function roll(claim:GridMonitorClaim,signal:AbortSignal,entriesAllowed:boolean){
    const {bot,levels,operations}=await storage.snapshot(claim),policy=retainedGridPolicy(bot,levels),key=await dependencies.umk(bot.wallet_address);
    if(!key)throw Error('Grid durable security unavailable');
    try{
      if(!verifyGridPolicyHmac(policy,key.umk,bot.policy_hmac).ok)throw Error('Grid policy signature changed');
      const account=await custody.recover(claim.id,bot.wallet_address,claim.leaseToken),{facts,risk}=await authority.collect(account.wallet,policy,account,key.umk,signal);
      const state=await storage.planningState(claim,monitor.bootId);
      const clearance=gridResumeClearance(risk,state.observation,policy,facts.tick,Date.now());
      const exposure=await ledger.transaction(async c=>{await c.query('SELECT master_account FROM grid_master_quota WHERE master_account=$1 FOR UPDATE',[claim.masterAccount]);
        await storage.assertLease(c,claim);return ledger.pilotExposure(c,claim.id,Date.now());});
      const remaining=exposure.limitUsd!==null&&exposure.exposureUsd!==null?Decimal.max(0,new Decimal(exposure.limitUsd).minus(exposure.exposureUsd)).toFixed():'0';
      const owned:WindowOrder[]=gridOwnedLive(operations,state.observation).map(({order,operation})=>{
        if(!operation?.level_id||!order.clientOrderId)throw Error('Grid live order ownership unavailable');
        return {levelId:operation.level_id,orderId:order.orderId,clientOrderId:order.clientOrderId,reduceOnly:order.reduceOnly,
          ...(isGridCyclePolicyVersion(policy.policyVersion)?{cycleLeg:order.reduceOnly?'closing' as const:'opening' as const}:{}),
          remaining:new Decimal(order.amount).minus(order.filledAmount).minus(order.cancelledAmount??'0').toFixed()};
      });
      const plan=await monitor.plan(claim,{owned,bookPrice:facts.bookPrice,lot:facts.lot,minimumQuote:facts.minimumQuote,freeSlots:facts.availableSlots,
        canaryRemaining:clearance&&entriesAllowed?remaining:'0'});
      const action=plan.chunks.flat()[0];if(!action)return;
      // One action per generation: the next tick must reconcile any cancellation/fill before planning again.
      return executeGridWindow([[action]],execution(account,policy,bot.policy_hmac,key.umk,signal),async current=>{
        signal.throwIfAborted();const latest=await storage.planningState(claim,monitor.bootId);
        if(requestDigest(latest.authority)!==requestDigest(plan.authority))throw new GridLaunchTransientError('Grid plan generation changed');
        const base={...plan.authority,policy,policyHmac:bot.policy_hmac,facts,...(isGridCyclePolicyVersion(policy.policyVersion)?{cycleRisk:risk}:{})},now=Date.now();
        if(current.kind==='cancel'){
          const original=operations.find(op=>op.level_id===current.order.levelId&&op.venue_order_id===current.order.orderId&&op.exact_request.kind==='limit');
          if(!original)throw Error('Grid cancel source unavailable');
          const request:ExactGridRequest={kind:'cancel',botId:claim.id,account:claim.account,masterAccount:claim.masterAccount,path:'/orders/cancel',operationType:'cancel_order',timestamp:now,expiryMs:5000,
            data:{symbol:policy.market.replace(/-PERP$/,''),order_id:current.order.orderId},authority:{...base,levelId:current.order.levelId,originalRequest:original.exact_request}};
          return {key:`grid:${claim.id}:cancel:${original.id}`,request,claim:quotaClaim(facts,0),leaseToken:claim.leaseToken};
        }
        const l=current.level;
        const request=gridLevelRequest({account,level:l,market:policy.market,protocolSymbol:policy.market.replace(/-PERP$/,''),signerGeneration:generation(account,facts),
          deployment:facts.recycler.deployment,fee:l.reduceOnly?facts.profit:facts.maker,constraint:constraintFor(facts),now,
          authority:{...base,...(l.reduceOnly?{fillAllocations:plan.allocations[windowLevelKey(l)]}:{})}});
        return {key:`grid:${claim.id}:level:${l.ordinal}:${l.attempt}:${l.reduceOnly?'profit':'entry'}`,request,
          claim:quotaClaim(facts,1,l.reduceOnly?'0':new Decimal(l.price).mul(l.size).toFixed()),leaseToken:claim.leaseToken};
      });
    }finally{key.cleanup();}
  }
  const executor=new GridExecutor({recover:recoverPending,lifecycle:async(claim,signal)=>{await lifecycle.lifecycle.observeHostPause(claim);return lifecycle.service.tick(claim,signal);},
    status:async claim=>(await storage.snapshot(claim)).bot.status,reconcile:(claim,signal)=>monitor.tick(claim,signal),roll,
    provision:async(claim,signal)=>{const {bot,levels}=await storage.snapshot(claim),account=await custody.recover(claim.id,bot.wallet_address,claim.leaseToken);
      return provision(bot.wallet_address,retainedGridPolicy(bot,levels),bot.policy_hmac,signal,account);}});
  return {async tick(claim:GridMonitorClaim,signal:AbortSignal){leases.set(claim.id,claim.leaseToken);try{return await executor.tick(claim,signal);}finally{leases.delete(claim.id);}},
    async start(wallet:string,id:string,expected:GridStartRequest,signal:AbortSignal){
      return startRetainedGrid(wallet,id,expected,signal,{
        read:(owner,botId)=>ledger.transaction(async c=>{
          const bot=(await c.query('SELECT * FROM grid_bots WHERE id=$1 AND wallet_address=$2',[botId,owner])).rows[0];
          if(!bot)return null;
          const levels=(await loadActiveGridLevels(c,botId,'all')).rows;
          return {policy:retainedGridPolicy(bot,levels),policyHmac:bot.policy_hmac,status:bot.status,
            draftRevision:bot.draft_revision,serverIntentDigest:bot.server_intent_digest};
        }),
        provision:(owner,draft,abort)=>provision(owner,draft.policy,draft.policyHmac,abort),
      });
    }};
}

