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
import type {ExactGridRequest,GridClaim,DurableGridOperation} from './launch-storage';
import {GridLaunchTransientError,GRID_ACTION_CREDITS,gridProvisionAttempt} from './launch-storage';
import {executeGridWindow} from './placement';
import {defaultGridLaunchAuthority,GridLaunchAuthorityUnavailable} from './launch-authority';
import {durableGridUmk} from './service';
import type {GridMarginReading} from './margin';
import {planGridRebalance} from './rebalance';
import {validateRetainedGridCycles} from './cycle-validation';
import {gridSeedPriceBounds} from './cycle-engine';

// Grid levels occupy 1..101. Funding and seed must each have their own reserved identity.
export const GRID_FUND_IDENTITY_LEVEL = 102;
export const GRID_SEED_IDENTITY_LEVEL = 103;

export interface LaunchFacts {
  market:string; margin:GridMarginReading; agentGeneration:{wallet:string;masterAccount:string;umkVersion:number};
  observedAt:number;expiresAt:number;masterAccount:string;account:string|null;bookPrice:string;bookSource:string;
  tick:string;lot:string;minimumQuote:string;maximumQuote:string;minimumPrice:string;maximumPrice:string;maxLeverage:string;restrictions:'unrestricted'|'unknown'|'restricted';
  maker:GridFeeQuote;profit:GridFeeQuote;taker:GridFeeQuote|null;
  masterWithdrawable:string;sol:string|null;availableSlots:number;subaccountCount:number;observedCredits:string;availableGridCredits:string;reusableAccountAvailable?:boolean;
  transportReady:boolean;inventoryComplete:boolean;recycler:{reuse:unknown;recycle:unknown;deployment:string;expectedDeployment:string;checkedAt:number};
}
export type LaunchAdmission={ok:false;reason:string;transient?:boolean}|{ok:true;plan:GridPlan;exposureLimit:string;seedNotional:string;firstEntryOrdinal:number;stop:ReturnType<typeof projectGridStop>};
/** Shared immutable policy and current account/market authority; Resume never funds or seeds. */
function gridCurrentAuthority(policy:GridPolicy,policyHmac:string,umk:Buffer,f:LaunchFacts,now:number,alreadyFunded:boolean,resume:boolean){
  const deny=(reason:string)=>({ok:false as const,reason});
  try {
    if(!verifyGridPolicyHmac(policy,umk,policyHmac).ok)return deny('Grid policy signature or version changed.');
    if(!Number.isSafeInteger(f.observedAt)||!Number.isSafeInteger(f.expiresAt)||f.observedAt>now||f.expiresAt<=now||f.expiresAt-f.observedAt>5000)return deny('Launch observations are stale or unknown.');
    if(!f.masterAccount||!f.transportReady||!f.inventoryComplete)return deny('Grid transport or account inventory is unavailable.');
    if(f.market!==policy.market||!f.agentGeneration||f.agentGeneration.masterAccount!==f.masterAccount||!f.agentGeneration.wallet||!Number.isSafeInteger(f.agentGeneration.umkVersion)||f.agentGeneration.umkVersion<1)return deny('Grid launch identity or agent generation changed.');
    if(!f.margin||f.margin.account!==(f.account??f.masterAccount)||f.margin.symbol!==policy.market.replace(/-PERP$/,'')
      ||![f.margin.observedAt,f.margin.accountUpdatedAt].every(t=>Number.isSafeInteger(t)&&t<=now&&now-t<5000)
      ||![f.margin.available,f.margin.feeRate].every(v=>new Decimal(v).isFinite()&&new Decimal(v).gte(0))
      ||!new Decimal(f.margin.leverage).isInteger()||!new Decimal(f.margin.leverage).gte(1))return deny('Strict Grid account margin is stale or identity changed.');
    if(!gridRecyclerGate(f.recycler,now))return deny('Subaccount reuse and recycling must both be enabled for this deployment.');
    if(!gridWalletEntryGate(f.sol).entryAllowed)return deny('Wallet SOL reserve is below the entry minimum or unknown.');
    if(!Number.isSafeInteger(f.availableSlots)||f.availableSlots<(resume?1:GRID_MINIMUM_LAUNCH_SLOTS)||!Number.isSafeInteger(f.subaccountCount)||f.subaccountCount<0||f.subaccountCount>(f.account||f.reusableAccountAvailable===true?10:9))return deny('Subaccount or order slot capacity is unavailable.');
    if(f.restrictions!=='unrestricted'||!new Decimal(f.maxLeverage).gte(policy.leverage)||!resume&&!alreadyFunded&&!new Decimal(f.masterWithdrawable).gte(policy.totalInvestment)
      || !new Decimal(f.observedCredits).gt(0))return deny('Funding, leverage, quota or market restrictions deny launch.');
    if(!new Decimal(f.availableGridCredits).gte(resume||alreadyFunded?10:policy.seedAtCreation?50:40))return {ok:false as const,transient:true,reason:'Grid quota is temporarily unavailable.'};
    const account=f.account??f.masterAccount;
    const fee=(quote:GridFeeQuote|null,role:'maker'|'taker',intent:'entry'|'profit')=>quote&&validateGridFeeQuote(quote,{account,subaccountId:null,market:policy.market,liquidityRole:role,builderCode:'CARRY',intent},now);
    if(!fee(f.maker,'maker','entry')||!fee(f.profit,'maker','profit')||!resume&&policy.seedAtCreation&&!fee(f.taker,'taker','entry'))return deny('Current account fees and builder approval are unavailable.');
    const maker=Decimal.max(0,f.maker.effectiveRate,f.profit.effectiveRate),taker=!resume&&policy.seedAtCreation?new Decimal(f.taker!.effectiveRate):new Decimal(0);
    return {ok:true as const,maker,taker};
  }catch{return deny('A required current authority input is unknown or invalid.');}
}
/** Every pre-reservation check is read-only. No custody, funding, enrollment or leverage mutation occurs here. */
export function preflightGridLaunch(policy:GridPolicy,policyHmac:string,umk:Buffer,f:LaunchFacts,now:number,alreadyFunded=false):LaunchAdmission{
  const deny=(reason:string):LaunchAdmission=>({ok:false,reason});
  try {
    const current=gridCurrentAuthority(policy,policyHmac,umk,f,now,alreadyFunded,false);if(!current.ok)return current;
    const {maker,taker}=current;
    const cyclic=isGridCyclePolicyVersion(policy.policyVersion);
    const calc=calculateGrid({side:policy.direction,lower:policy.lowerPrice,upper:policy.upperPrice,start:policy.startPrice,intervals:policy.gridCount,
      entryScale:policy.entryScaleType,profitScale:policy.profitScaleType,seed:policy.seedAtCreation,leverage:String(policy.leverage),
      tick:f.tick,lot:f.lot,minimumQuote:f.minimumQuote,investmentStep:'0.01',transferFloor:'0.01',effectiveMakerCostRate:maker.toFixed(),
      ...(cyclic?{policyVersion:policy.policyVersion as '2.0.0'|'2.2.0',...(policy.gridPolicyExtension?{behaviourMode:policy.gridPolicyExtension.mode}:{}),maximumQuote:f.maximumQuote}:{}),
      ...(policy.sizingVersion?{sizingVersion:policy.sizingVersion,safetyEnvelopePrice:policy.safetyEnvelopePrice}:{}),
      investment:new Decimal(policy.totalInvestment).div(new Decimal(1).plus((cyclic?Decimal.max(0,maker,taker):taker).mul(policy.leverage))).toDecimalPlaces(2,Decimal.ROUND_FLOOR).toFixed(2)});
    if(!calc.ok)return deny(calc.issues.map(i=>i.reason).join('; '));const plan=calc.plan;
    if(policy.levels.length!==plan.lines.length||plan.lines.some((l,i)=>{const signed=policy.levels[i];return !signed||!new Decimal(l.price).eq(signed.price)||!new Decimal(l.quantity).eq(signed.size)
      || signed.reduceOnly!==(l.role==='seed_exit')||signed.side!==(policy.direction==='long'?(l.role==='seed_exit'?'sell':'buy'):(l.role==='seed_exit'?'buy':'sell'));}))return deny('Current minimums or fees would change the signed grid geometry.');
    if(cyclic){const verified=validateRetainedGridCycles(policy,{...f,openingFeeRate:maker.toFixed(),closingFeeRate:maker.toFixed()});if(!verified.ok)return deny(verified.reason);}
    if(plan.lines.some(l=>new Decimal(l.notional).gt(f.maximumQuote)||new Decimal(l.price).lt(f.minimumPrice)||new Decimal(l.price).gt(f.maximumPrice)))return deny('Signed levels exceed current market bounds.');
    if(cyclic && policy.seedAtCreation){const bounds=gridSeedPriceBounds(plan.start,f.tick);
      if(new Decimal(bounds.low).lt(f.minimumPrice)||new Decimal(bounds.high).gt(f.maximumPrice))return deny('Bounded seed execution exceeds current price limits.');}
    const spacing=Decimal.min(...plan.lines.slice(1).map((l,i)=>new Decimal(l.price).minus(plan.lines[i].price).div(policy.startPrice))).toFixed();
    if(!gridFirstPlacementGate({confirmedPrice:policy.startPrice,bookPrice:f.bookPrice,smallestSpacingFraction:spacing,observedAt:f.observedAt,source:f.bookSource,
      identityValid:true,sideFlip:plan.lines.some(l=>(new Decimal(l.price).lt(policy.startPrice)!==new Decimal(l.price).lt(f.bookPrice))|| (new Decimal(l.price).gt(policy.startPrice)!==new Decimal(l.price).gt(f.bookPrice))),
      rangeValid:new Decimal(f.bookPrice).gte(policy.lowerPrice)&&new Decimal(f.bookPrice).lte(policy.upperPrice)},now))return deny('The book moved beyond the confirmed grid; create a fresh preview.');
    if(!policy.stopLossPrice)return deny('A mandatory stop is required.');
    const stop=projectGridStop({plan,funding:policy.totalInvestment,stop:policy.stopLossPrice,tick:f.tick,maxLeverage:f.maxLeverage,makerRate:maker.toFixed(),takerRate:taker.toFixed(),observedAt:f.observedAt,expiresAt:f.expiresAt},now);
    if(stop.state!=='available')return deny(stop.reason);
    const exposureLimit=gridExposureLimit(policy.totalInvestment,policy.leverage);if(!exposureLimit)return deny('Configured exposure capacity is unknown.');
    const seedNotional=new Decimal(plan.seedQuantity).mul(stop.projection.seedWorstPrice);
    if(new Decimal(plan.seedQuantity).gt(0)&&(seedNotional.lt(f.minimumQuote)||seedNotional.gt(f.maximumQuote)
      ||new Decimal(stop.projection.seedWorstPrice).lt(f.minimumPrice)||new Decimal(stop.projection.seedWorstPrice).gt(f.maximumPrice)))return deny('The unchanged aggregate seed exceeds current market bounds.');
    const entries=plan.lines.filter(l=>l.role==='entry'&&new Decimal(l.quantity).gt(0)).sort((a,b)=>new Decimal(a.price).minus(plan.start).abs().cmp(new Decimal(b.price).minus(plan.start).abs()));
    const first=policy.sizingVersion?entries[0]:entries.find(l=>seedNotional.plus(l.notional).lte(exposureLimit));
    if(!first)return deny('The unchanged seed and one valid entry exceed the configured investment × leverage; reduce the footprint or disable the seed.');
    return {ok:true,plan,exposureLimit,seedNotional:seedNotional.toFixed(),firstEntryOrdinal:first.ordinal+1,stop};
  }catch{return deny('A required launch input is unknown or invalid.');}
}

export function preflightGridResume(policy:GridPolicy,policyHash:string,umk:Buffer,f:LaunchFacts,now:number,input:Parameters<typeof planGridRebalance>[0]&{cycleReplay?:CycleReplayInput}){
  const deny=(reason:string)=>({ok:false as const,reason});
  try {
    const current=gridCurrentAuthority(policy,policyHash,umk,f,now,true,true);if(!current.ok)return current;
    if(isGridCyclePolicyVersion(policy.policyVersion)){
      const verified=validateRetainedGridCycles(policy,{...f,openingFeeRate:current.maker.toFixed(),closingFeeRate:current.maker.toFixed()});
      if(!verified.ok)return verified;
      if(!input.cycleReplay||canonicalGridPolicy(input.cycleReplay.policy)!==canonicalGridPolicy(policy))return deny('Grid cycle Resume requires complete retained replay.');
    }
    if(!f.account||f.margin.leverage!==String(policy.leverage)||!policy.stopLossPrice||!input.inventoryComplete||!input.entriesAllowed)return deny('Current Resume inventory or margin is unavailable.');
    if(![f.tick,f.lot,f.bookPrice,f.minimumPrice,f.maximumPrice,f.maximumQuote].every(v=>new Decimal(v).isFinite()&&new Decimal(v).gt(0)))return deny('Current market limits are unavailable.');
    if(!new Decimal(f.bookPrice).gte(policy.lowerPrice)||!new Decimal(f.bookPrice).lte(policy.upperPrice))return deny('Current book is outside the retained range.');
    for(const l of policy.levels){
      if(!new Decimal(l.price).mod(f.tick).isZero()||!new Decimal(l.size).mod(f.lot).isZero()||new Decimal(l.price).lt(f.minimumPrice)||new Decimal(l.price).gt(f.maximumPrice))return deny('Signed geometry is incompatible with current market limits.');
    }
    for(const l of input.levels){const signed=policy.levels[l.ordinal-1];if(!signed||!new Decimal(l.price).eq(signed.price)||!new Decimal(l.size).eq(signed.size)||l.side!==signed.side||l.reduceOnly!==signed.reduceOnly)return deny('Retained levels differ from signed geometry.');}
    const prices=policy.levels.map(l=>new Decimal(l.price)).sort((a,b)=>a.cmp(b));
    for(let i=1;i<prices.length;i++)if(!prices[i].minus(prices[i-1]).gt(Decimal.max(prices[i],prices[i-1]).mul(Decimal.max(0,f.maker.effectiveRate).plus(Decimal.max(0,f.profit.effectiveRate)))))return deny('Current fees consume the retained grid spread.');
    const replay=isGridCyclePolicyVersion(policy.policyVersion)?replayGridCycles(input.cycleReplay!):null;
    if(replay&&!replay.ok)return deny(replay.reason);
    const plan=replay?.ok?planCycleWindow({...input,cycles:replay.cycles,pool:cycleCapacity(input.cycleReplay!,f.bookPrice),bookPrice:f.bookPrice,lot:f.lot,minimumQuote:f.minimumQuote,freeSlots:f.availableSlots}):planGridRebalance({...input,bookPrice:f.bookPrice,lot:f.lot,minimumQuote:f.minimumQuote,freeSlots:f.availableSlots});
    const safe=plan.chunks.flat().filter(a=>a.kind==='place');
    if(!safe.length&&!isGridCyclePolicyVersion(policy.policyVersion))return deny('No safe resting order is currently available.');
    let required=new Decimal(0);
    for(const a of safe){const l=a.level,notional=new Decimal(l.price).mul(l.size);if(notional.gt(f.maximumQuote))return deny('Current order bounds deny Resume.');if(!l.reduceOnly)required=required.plus(notional.div(f.margin.leverage).plus(notional.mul(f.margin.feeRate)));}
    if(required.gt(f.margin.available))return deny('Current margin cannot back the remaining Resume orders.');
    return {ok:true as const,plan};
  }catch{return deny('Current Resume planning authority is unavailable.');}
}

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
  constructor(private deps:GridProvisionDeps){}
  async start(input:{wallet:string;policy:GridPolicy;policyHmac:string;account?:GridAccount}):Promise<{state:'denied'|'pending'|'canary';reason?:string;account?:GridAccount}>{
    const security=await (this.deps.durableUmk??durableGridUmk)(input.wallet);if(!security)return {state:'denied',reason:'Durable execution security is unavailable.'};
    const observe=async(account:GridAccount|null)=>{
      try{const facts=this.deps.observe?await this.deps.observe(input.policy,account)
        :await (await defaultGridLaunchAuthority()).observe(input.wallet,input.policy,account,security.umk);
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
          client_order_id:gridClientOrderId({botId:input.policy.id,level:GRID_SEED_IDENTITY_LEVEL,attempt:0,leg:'entry'}),...(facts.taker?.builder?{builder_code:facts.taker.builder.code}:{})}});
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
          delete step.data.builder_code;
          if(current.taker.builder)step.data.builder_code=current.taker.builder.code;
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
