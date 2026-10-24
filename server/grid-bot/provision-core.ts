import { isGridCyclePolicyVersion } from '../../shared/grid-behaviour';
import {planCycleWindow} from './cycle-planner';
import {cycleCapacity} from './cycle-capacity';
import {replayGridCycles,type CycleReplayInput} from './cycle-replay';
import Decimal from 'decimal.js';
import {randomUUID} from 'node:crypto';
import {GRID_MINIMUM_LAUNCH_SLOTS} from '../../shared/grid-capacity';
import type {GridPlan} from './engine-types';
import {calculateGrid} from './engine';
import {canonicalGridPolicy,verifyGridPolicyHmac,type GridPolicy} from './policy-hmac';
import {validateGridFeeQuote,type GridFeeQuote} from './fee-authority';
import {gridExposureLimit,gridFirstPlacementGate,gridRecyclerGate,gridWalletEntryGate} from './runtime-policy';
import {projectGridStop,GRID_SEED_MAX_SLIPPAGE_PERCENT} from './stop-clearance';
import {gridClientOrderId} from './order-identity';
import {validGridEmptyProof,type GridCustody,type GridAccount,type GridEmptyProof} from './custody';
import type {GridExecution} from './execution';
import type {ExactGridRequest,GridClaim,DurableGridOperation} from './launch-storage-core';
import {GridLaunchTransientError,GRID_ACTION_CREDITS,gridProvisionAttempt} from './launch-storage-core';
import {executeGridWindow} from './placement';
import {GridLaunchAuthorityUnavailable,type GridLaunchAuthority} from './launch-authority-core';
import type {GridMarginReading} from './margin';
import {planGridRebalance} from './rebalance';
import {validateRetainedGridCycles} from './cycle-validation';
import {gridSeedPriceBounds} from './cycle-engine';

// Grid levels occupy 1..101. Funding and seed must each have their own reserved identity.
export const GRID_FUND_IDENTITY_LEVEL = 102;
export const GRID_SEED_IDENTITY_LEVEL = 103;

export {preflightGridLaunch,preflightGridResume,type LaunchFacts,type LaunchAdmission} from './launch-preflight';
import {preflightGridLaunch,preflightGridResume,type LaunchFacts,type LaunchAdmission} from './launch-preflight';

export interface GridProvisionDeps {
  /** Explicit production composition; isolated/incomplete callers remain denied. */
  cycleExecutionReady?:boolean;
  cycleFirstWindow?(account:GridAccount):Promise<boolean>;
  quotaShare?:string;
  now():number;
  durableUmk?(wallet:string):Promise<{umk:Buffer;cleanup():void}|null>;
  observe?(policy:GridPolicy,account:GridAccount|null):Promise<LaunchFacts>;
  custody:Pick<GridCustody,'reserve'|'confirmCreated'|'confirmReused'>;
  verifyEmpty(account:GridAccount):Promise<GridEmptyProof>;
  execution:Pick<GridExecution,'run'>;
  existing(key:string,botId:string):Promise<DurableGridOperation|null>;
  markCanary(account:GridAccount):Promise<void>;
  beforeStep?(account:GridAccount,kind:ExactGridRequest['kind']):Promise<Record<string,unknown>>;
  prepareFirstEntry?(input:{account:GridAccount;policy:GridPolicy;policyHmac:string;admission:Extract<LaunchAdmission,{ok:true}>;facts:LaunchFacts;now:number}):Promise<{request:ExactGridRequest;claim:GridClaim}>;
}
/** The durable worker resumes this state machine only from authoritative confirmed steps. */
export class GridProvision {
  constructor(private deps:GridProvisionDeps,private defaults:{umk?:NonNullable<GridProvisionDeps['durableUmk']>;authority?:()=>Promise<GridLaunchAuthority>}={}){}
  private async defaultAuthority(){if(!this.defaults.authority)throw new GridLaunchAuthorityUnavailable('GRID_AUTHORITY_INJECTION_REQUIRED');return this.defaults.authority();}
  async start(input:{wallet:string;policy:GridPolicy;policyHmac:string;account?:GridAccount}):Promise<{state:'denied'|'pending'|'canary';reason?:string;account?:GridAccount}>{
    const security=await (this.deps.durableUmk??this.defaults.umk??(async()=>null))(input.wallet);if(!security)return {state:'denied',reason:'Durable execution security is unavailable.'};
    const observe=async(account:GridAccount|null)=>{
      try{const facts=this.deps.observe?await this.deps.observe(input.policy,account)
        :await (await this.defaultAuthority()).observe(input.wallet,input.policy,account,security.umk);
        if(facts.agentGeneration?.wallet!==input.wallet)throw new GridLaunchAuthorityUnavailable('Grid execution wallet generation changed.');
        return facts;}
      catch(error){if(error instanceof GridLaunchAuthorityUnavailable||error instanceof GridLaunchTransientError)throw error;throw new GridLaunchAuthorityUnavailable('Production Grid launch authority unavailable.');}
    };
    let retainedAccount=input.account;
    const attempt=(kind:string)=>gridProvisionAttempt(this.deps.existing,input.policy.id,kind,this.deps.now());
    try {
      if(!verifyGridPolicyHmac(input.policy,security.umk,input.policyHmac).ok)return {state:'denied',reason:'Grid policy signature changed.'};
      if(isGridCyclePolicyVersion(input.policy.policyVersion)&&(!this.deps.cycleExecutionReady||!this.deps.cycleFirstWindow))return {state:'denied',reason:'Grid cycle provisioning requires complete execution integration.'};
      // Recovery precedes new market/fee reads. A disappeared response cannot grant a new send.
      for(const kind of ['create','fund','leverage','seed','entry']){
        const {key,op:old}=await attempt(kind);
        if(old && ['prepared','submitted','unconfirmed'].includes(old.state)){
          if(!input.account)return {state:'pending',reason:'Recover the retained Grid custody identity before resuming.'};
          const result=await this.deps.execution.run(key,old.exact_request,{recoveryOnly:true},input.account.leaseToken);
          if(result!=='confirmed'&&(await attempt(kind)).op!==null)return {state:'pending',account:input.account};
        }
      }
      const {op:funding}=await attempt('fund');
      const facts=await observe(input.account??null),now=this.deps.now();
      const admission=preflightGridLaunch(input.policy,input.policyHmac,security.umk,facts,now,funding?.state==='confirmed');
      if(!admission.ok)return {state:admission.transient?'pending':'denied',reason:admission.reason,account:retainedAccount};
      if(!isGridCyclePolicyVersion(input.policy.policyVersion)&&!this.deps.prepareFirstEntry)return {state:'pending',reason:'First resting entry preparation authority is unavailable.',account:retainedAccount};
      const account=input.account??await this.deps.custody.reserve({botId:input.policy.id,wallet:input.wallet,masterAccount:facts.masterAccount,
        policyHmac:input.policyHmac,share:this.deps.quotaShare},security.umk);
      retainedAccount=account;
      if(account.wallet!==input.wallet||account.botId!==input.policy.id||account.masterAccount!==facts.masterAccount)throw Error('Grid provision identity conflict');
      if(funding?.state!=='confirmed'){
        const empty=await this.deps.verifyEmpty(account);
        if(!validGridEmptyProof(account,empty,this.deps.now()))return {state:'denied',reason:'Reserved subaccount is not authoritatively empty; its key remains retained.',account};
        if(account.reused)await this.deps.custody.confirmReused(account,empty,this.deps.now());
      }
      const symbol=input.policy.market.replace(/-PERP$/,'');
      const steps:Array<{kind:ExactGridRequest['kind'];path:string;operationType:string;data:Record<string,unknown>}>=[];
      if(!account.reused)steps.push({kind:'create',path:'/account/subaccount/create',operationType:'subaccount_confirm',data:{}});
      steps.push({kind:'fund',path:'/account/subaccount/transfer',operationType:'transfer_funds',data:{to_account:account.account,amount:input.policy.totalInvestment,
        idempotency_key:randomUUID()}},
        {kind:'leverage',path:'/account/leverage',operationType:'update_leverage',data:{symbol,leverage:input.policy.leverage}});
      if(input.policy.seedAtCreation&&new Decimal(admission.plan.seedQuantity).gt(0))steps.push({kind:'seed',path:'/orders/create_market',operationType:'create_market_order',
        data:{symbol,amount:admission.plan.seedQuantity,side:input.policy.direction==='long'?'bid':'ask',reduce_only:false,slippage_percent:GRID_SEED_MAX_SLIPPAGE_PERCENT,
          client_order_id:gridClientOrderId({botId:input.policy.id,level:GRID_SEED_IDENTITY_LEVEL,attempt:0,leg:'entry'})}});
      for(const step of steps){
        const {key,op:old}=await attempt(step.kind);
        if(old?.state==='confirmed'){if(step.kind==='create')await this.deps.custody.confirmCreated(account);continue;}
        const authority=await this.deps.beforeStep?.(account,step.kind)??{};
        const current=await observe(step.kind==='create'?null:account),timestamp=this.deps.now();
        const {op:funded}=await attempt('fund');
        const latest=preflightGridLaunch(input.policy,input.policyHmac,security.umk,current,timestamp,funded?.state==='confirmed');
        if(!latest.ok)return {state:latest.transient?'pending':'denied',reason:latest.reason,account};
        if((step.kind!=='create'&&current.account!==account.account)||current.masterAccount!==account.masterAccount)return {state:'denied',reason:'Reserved account authority changed.',account};
        if(step.kind==='fund'){
          const empty=await this.deps.verifyEmpty(account);
          if(empty.state!=='empty'||!validGridEmptyProof(account,empty,this.deps.now()))return {state:'denied',reason:'Funding requires the exact confirmed empty subaccount.',account};
        }
        if(step.kind==='seed'){
          if(isGridCyclePolicyVersion(input.policy.policyVersion))step.data.client_order_id=gridClientOrderId({botId:input.policy.id+':'+key,level:GRID_SEED_IDENTITY_LEVEL,attempt:0,leg:'entry'});
          if(current.margin.leverage!==String(input.policy.leverage))return {state:'denied',reason:'Actual subaccount leverage does not match the confirmed policy.',account};
          if(!current.taker)return {state:'denied',reason:'Fresh subaccount taker fee unavailable.',account};
        }
        const request:ExactGridRequest=old?.exact_request??{...step,botId:input.policy.id,account:account.account,masterAccount:account.masterAccount,timestamp,expiryMs:5000,
          authority:{...authority,policyHmac:input.policyHmac,policy:input.policy,admission:latest,facts:current,seedWorstPrice:latest.stop.state==='available'?latest.stop.projection.seedWorstPrice:null}};
        const claim:GridClaim={credits:GRID_ACTION_CREDITS,slots:0,canaryIncrement:step.kind==='seed'?latest.seedNotional:'0',observedCredits:current.observedCredits,
          availableSlots:current.availableSlots,observedAt:current.observedAt,expiresAt:current.expiresAt};
        const result=await this.deps.execution.run(key,request,claim,account.leaseToken);
        if(result!=='confirmed')return {state:result==='failed'?'denied':'pending',reason:result==='failed'?'A launch operation was rejected; custody remains retained.':undefined,account};
        if(step.kind==='create')await this.deps.custody.confirmCreated(account);
      }
      if(isGridCyclePolicyVersion(input.policy.policyVersion)){
        await this.deps.beforeStep?.(account,'limit');
        if(!await this.deps.cycleFirstWindow!(account))return {state:'pending',reason:'Cycle launch is reconciling or placing backed closing orders.',account};
        await this.deps.markCanary(account);return {state:'canary',account};
      }
      const {key:entryKey,op:oldEntry}=await attempt('entry');
      if(oldEntry?.state!=='confirmed'){
        await this.deps.beforeStep?.(account,'limit');
        const current=await observe(account),timestamp=this.deps.now();
        const latest=preflightGridLaunch(input.policy,input.policyHmac,security.umk,current,timestamp,true);
        if(!latest.ok)return {state:latest.transient?'pending':'denied',reason:latest.reason,account};
        if(current.account!==account.account||current.masterAccount!==account.masterAccount)return {state:'denied',reason:'First entry account authority changed.',account};
        if(current.margin.leverage!==String(input.policy.leverage))return {state:'denied',reason:'Actual subaccount leverage does not match the confirmed policy.',account};
        const prepared=await this.deps.prepareFirstEntry!({account,policy:input.policy,policyHmac:input.policyHmac,admission:latest,facts:current,now:timestamp});
        const request=oldEntry?.exact_request??prepared.request,claim=prepared.claim;
        const line=input.policy.levels.find(l=>l.ordinal===latest.firstEntryOrdinal);
        if(!line||line.reduceOnly||request.kind!=='limit'||request.botId!==input.policy.id||request.account!==account.account
          ||request.masterAccount!==account.masterAccount||request.data.symbol!==symbol||request.data.reduce_only!==false
          ||request.data.tif!=='ALO'||request.data.price!==line.price||request.data.amount!==line.size
          ||request.data.side!==(line.side==='buy'?'bid':'ask')||request.authority.policyHmac!==input.policyHmac
          ||!Number.isSafeInteger(request.authority.levelAttempt)||(request.authority.levelAttempt as number)<0
          ||request.data.client_order_id!==gridClientOrderId({botId:input.policy.id,level:line.ordinal,attempt:request.authority.levelAttempt as number,leg:'entry'})
          ||typeof request.authority.levelId!=='string'||request.authority.levelAttempt!==prepared.request.authority.levelAttempt||claim.slots!==1
          ||!new Decimal(claim.canaryIncrement).eq(new Decimal(line.price).mul(line.size)))return {state:'pending',reason:'First entry would change the confirmed geometry or identity; recover or confirm a new preview.',account};
        const result=await executeGridWindow([[{kind:'place',level:{...line,id:request.authority.levelId,attempt:request.authority.levelAttempt as number}}]],this.deps.execution,
          async()=>({key:entryKey,request,claim,leaseToken:account.leaseToken}));
        if(result.state!=='confirmed')return {state:result.state==='failed'?'denied':'pending',reason:result.state==='failed'?'First resting entry was rejected; custody remains retained.':'First resting entry remains attributable to its retained operation.',account};
      }
      await this.deps.markCanary(account);return {state:'canary',account};
    }catch(error){
      if(error instanceof GridLaunchTransientError)return {state:'pending',reason:error.message,account:retainedAccount};
      if(error instanceof GridLaunchAuthorityUnavailable)return {state:'denied',reason:error.message,account:retainedAccount};
      throw error;
    }finally{security.cleanup();}
  }
}
