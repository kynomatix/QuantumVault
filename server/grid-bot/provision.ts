import Decimal from 'decimal.js';
import type {GridPlan} from './engine-types';
import {calculateGrid} from './engine';
import {verifyGridPolicyHmac,type GridPolicy} from './policy-hmac';
import {validateGridFeeQuote,type GridFeeQuote} from './fee-authority';
import {gridCanaryBudget,gridFirstPlacementGate,gridRecyclerGate,gridWalletEntryGate} from './runtime-policy';
import {projectGridStop,GRID_SEED_MAX_SLIPPAGE_PERCENT} from './stop-clearance';
import {gridClientOrderId} from './order-identity';
import {validGridEmptyProof,type GridCustody,type GridAccount,type GridEmptyProof} from './custody';
import type {GridExecution} from './execution';
import type {ExactGridRequest,GridClaim,DurableGridOperation} from './launch-storage';
import {GridLaunchTransientError} from './launch-storage';

// Grid levels occupy 1..101. Funding and seed must each have their own reserved identity.
export const GRID_FUND_IDENTITY_LEVEL = 102;
export const GRID_SEED_IDENTITY_LEVEL = 103;

export interface LaunchFacts {
  observedAt:number;expiresAt:number;masterAccount:string;account:string|null;bookPrice:string;bookSource:string;
  tick:string;lot:string;minimumQuote:string;maximumQuote:string;minimumPrice:string;maximumPrice:string;maxLeverage:string;restrictions:'unrestricted'|'unknown'|'restricted';
  maker:GridFeeQuote;profit:GridFeeQuote;taker:GridFeeQuote|null;
  masterWithdrawable:string;sol:string|null;availableSlots:number;subaccountCount:number;observedCredits:string;availableGridCredits:string;reusableAccountAvailable?:boolean;
  transportReady:boolean;inventoryComplete:boolean;recycler:{reuse:unknown;recycle:unknown;deployment:string;expectedDeployment:string;checkedAt:number};
}
export type LaunchAdmission={ok:false;reason:string;transient?:boolean}|{ok:true;plan:GridPlan;canaryLimit:string;seedNotional:string;firstEntryOrdinal:number;stop:ReturnType<typeof projectGridStop>};
/** Every pre-reservation check is read-only. No custody, funding, enrollment or leverage mutation occurs here. */
export function preflightGridLaunch(policy:GridPolicy,policyHmac:string,umk:Buffer,f:LaunchFacts,now:number,alreadyFunded=false):LaunchAdmission{
  const deny=(reason:string):LaunchAdmission=>({ok:false,reason});
  try {
    if(!verifyGridPolicyHmac(policy,umk,policyHmac).ok)return deny('Grid policy signature or version changed.');
    if(!Number.isSafeInteger(f.observedAt)||!Number.isSafeInteger(f.expiresAt)||f.observedAt>now||f.expiresAt<=now||f.expiresAt-f.observedAt>5000)return deny('Launch observations are stale or unknown.');
    if(!f.masterAccount||!f.transportReady||!f.inventoryComplete)return deny('Grid transport or account inventory is unavailable.');
    if(!gridRecyclerGate(f.recycler,now))return deny('Subaccount reuse and recycling must both be enabled for this deployment.');
    if(!gridWalletEntryGate(f.sol).entryAllowed)return deny('Wallet SOL reserve is below the entry minimum or unknown.');
    if(!Number.isSafeInteger(f.availableSlots)||f.availableSlots<25||!Number.isSafeInteger(f.subaccountCount)||f.subaccountCount<0||f.subaccountCount>(f.account||f.reusableAccountAvailable===true?10:9))return deny('Subaccount or order slot capacity is unavailable.');
    if(f.restrictions!=='unrestricted'||!new Decimal(f.maxLeverage).gte(policy.leverage)||!alreadyFunded&&!new Decimal(f.masterWithdrawable).gte(policy.totalInvestment)
      || !new Decimal(f.observedCredits).gt(0))return deny('Funding, leverage, quota or market restrictions deny launch.');
    if(!new Decimal(f.availableGridCredits).gte(alreadyFunded?10:policy.seedAtCreation?50:40))return {ok:false,transient:true,reason:'Grid quota is temporarily unavailable.'};
    const account=f.account??f.masterAccount;
    const fee=(quote:GridFeeQuote|null,role:'maker'|'taker',intent:'entry'|'profit')=>quote&&validateGridFeeQuote(quote,{account,subaccountId:null,market:policy.market,liquidityRole:role,builderCode:'CARRY',intent},now);
    if(!fee(f.maker,'maker','entry')||!fee(f.profit,'maker','profit')||policy.seedAtCreation&&!fee(f.taker,'taker','entry'))return deny('Current account fees and builder approval are unavailable.');
    const maker=Decimal.max(0,f.maker.effectiveRate,f.profit.effectiveRate),taker=policy.seedAtCreation?new Decimal(f.taker!.effectiveRate):new Decimal(0);
    const calc=calculateGrid({side:policy.direction,lower:policy.lowerPrice,upper:policy.upperPrice,start:policy.startPrice,intervals:policy.gridCount,
      entryScale:policy.entryScaleType,profitScale:policy.profitScaleType,seed:policy.seedAtCreation,leverage:String(policy.leverage),
      tick:f.tick,lot:f.lot,minimumQuote:f.minimumQuote,investmentStep:'0.01',transferFloor:'0.01',effectiveMakerCostRate:maker.toFixed(),
      investment:new Decimal(policy.totalInvestment).div(new Decimal(1).plus(taker.mul(policy.leverage))).toDecimalPlaces(2,Decimal.ROUND_FLOOR).toFixed(2)});
    if(!calc.ok)return deny(calc.issues.map(i=>i.reason).join('; '));const plan=calc.plan;
    if(policy.levels.length!==plan.lines.length||plan.lines.some((l,i)=>{const signed=policy.levels[i];return !signed||!new Decimal(l.price).eq(signed.price)||!new Decimal(l.quantity).eq(signed.size)
      || signed.reduceOnly!==(l.role==='seed_exit')||signed.side!==(policy.direction==='long'?(l.role==='seed_exit'?'sell':'buy'):(l.role==='seed_exit'?'buy':'sell'));}))return deny('Current minimums or fees would change the signed grid geometry.');
    if(plan.lines.some(l=>new Decimal(l.notional).gt(f.maximumQuote)||new Decimal(l.price).lt(f.minimumPrice)||new Decimal(l.price).gt(f.maximumPrice)))return deny('Signed levels exceed current market bounds.');
    const spacing=Decimal.min(...plan.lines.slice(1).map((l,i)=>new Decimal(l.price).minus(plan.lines[i].price).div(policy.startPrice))).toFixed();
    if(!gridFirstPlacementGate({confirmedPrice:policy.startPrice,bookPrice:f.bookPrice,smallestSpacingFraction:spacing,observedAt:f.observedAt,source:f.bookSource,
      identityValid:true,sideFlip:plan.lines.some(l=>(new Decimal(l.price).lt(policy.startPrice)!==new Decimal(l.price).lt(f.bookPrice))|| (new Decimal(l.price).gt(policy.startPrice)!==new Decimal(l.price).gt(f.bookPrice))),
      rangeValid:new Decimal(f.bookPrice).gte(policy.lowerPrice)&&new Decimal(f.bookPrice).lte(policy.upperPrice)},now))return deny('The book moved beyond the confirmed grid; create a fresh preview.');
    if(!policy.stopLossPrice)return deny('A mandatory stop is required.');
    const stop=projectGridStop({plan,funding:policy.totalInvestment,stop:policy.stopLossPrice,tick:f.tick,maxLeverage:f.maxLeverage,makerRate:maker.toFixed(),takerRate:taker.toFixed(),observedAt:f.observedAt,expiresAt:f.expiresAt},now);
    if(stop.state!=='available')return deny(stop.reason);
    const canaryLimit=gridCanaryBudget(plan.allocatedNotional);if(!canaryLimit)return deny('Canary capacity is unknown.');
    const seedNotional=new Decimal(plan.seedQuantity).mul(stop.projection.seedWorstPrice);
    if(new Decimal(plan.seedQuantity).gt(0)&&(seedNotional.lt(f.minimumQuote)||seedNotional.gt(f.maximumQuote)
      ||new Decimal(stop.projection.seedWorstPrice).lt(f.minimumPrice)||new Decimal(stop.projection.seedWorstPrice).gt(f.maximumPrice)))return deny('The unchanged aggregate seed exceeds current market bounds.');
    const entries=plan.lines.filter(l=>l.role==='entry'&&new Decimal(l.quantity).gt(0)).sort((a,b)=>new Decimal(a.price).minus(plan.start).abs().cmp(new Decimal(b.price).minus(plan.start).abs()));
    const first=entries.find(l=>seedNotional.plus(l.notional).lte(canaryLimit));
    if(!first)return deny('The unchanged seed and one valid entry exceed the canary budget; reduce the footprint or disable the seed.');
    return {ok:true,plan,canaryLimit,seedNotional:seedNotional.toFixed(),firstEntryOrdinal:first.ordinal+1,stop};
  }catch{return deny('A required launch input is unknown or invalid.');}
}

export interface GridProvisionDeps {
  quotaShare?:string;
  now():number;
  durableUmk(wallet:string):Promise<{umk:Buffer;cleanup():void}|null>;
  observe(policy:GridPolicy,account:GridAccount|null):Promise<LaunchFacts>;
  custody:Pick<GridCustody,'reserve'|'confirmCreated'|'confirmReused'>;
  verifyEmpty(account:GridAccount):Promise<GridEmptyProof>;
  execution:Pick<GridExecution,'run'>;
  existing(key:string,botId:string):Promise<DurableGridOperation|null>;
  markCanary(account:GridAccount):Promise<void>;
}
/** Unit 5 will supervise retries. Each invocation advances only from authoritative confirmed steps. */
export class GridProvision {
  constructor(private deps:GridProvisionDeps){}
  async start(input:{wallet:string;policy:GridPolicy;policyHmac:string;account?:GridAccount}):Promise<{state:'denied'|'pending'|'canary';reason?:string;account?:GridAccount}>{
    const security=await this.deps.durableUmk(input.wallet);if(!security)return {state:'denied',reason:'Durable execution security is unavailable.'};
    let retainedAccount=input.account;
    try {
      if(!verifyGridPolicyHmac(input.policy,security.umk,input.policyHmac).ok)return {state:'denied',reason:'Grid policy signature changed.'};
      // Recovery precedes new market/fee reads. A disappeared response cannot grant a new send.
      for(const kind of ['create','fund','leverage','seed']){
        const key=`grid:${input.policy.id}:launch:${kind}`,old=await this.deps.existing(key,input.policy.id);
        if(old && ['submitted','unconfirmed'].includes(old.state)){
          if(!input.account)return {state:'pending',reason:'Recover the retained Grid custody identity before resuming.'};
          const unused:GridClaim={credits:'10',slots:0,canaryIncrement:'0',observedCredits:'300',availableSlots:0,observedAt:0,expiresAt:0};
          if(await this.deps.execution.run(key,old.exact_request,unused,input.account.leaseToken)!=='confirmed')return {state:'pending',account:input.account};
        }
      }
      const funding=await this.deps.existing(`grid:${input.policy.id}:launch:fund`,input.policy.id);
      const facts=await this.deps.observe(input.policy,input.account??null),now=this.deps.now();
      const admission=preflightGridLaunch(input.policy,input.policyHmac,security.umk,facts,now,funding?.state==='confirmed');
      if(!admission.ok)return {state:admission.transient?'pending':'denied',reason:admission.reason,account:retainedAccount};
      const account=input.account??await this.deps.custody.reserve({botId:input.policy.id,wallet:input.wallet,masterAccount:facts.masterAccount,
        policyHmac:input.policyHmac,canaryLimit:admission.canaryLimit,share:this.deps.quotaShare},security.umk);
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
        idempotency_key:gridClientOrderId({botId:input.policy.id,level:GRID_FUND_IDENTITY_LEVEL,attempt:0,leg:'profit'})}},
        {kind:'leverage',path:'/account/leverage',operationType:'update_leverage',data:{symbol,leverage:input.policy.leverage}});
      if(input.policy.seedAtCreation&&new Decimal(admission.plan.seedQuantity).gt(0))steps.push({kind:'seed',path:'/orders/create_market',operationType:'create_market_order',
        data:{symbol,amount:admission.plan.seedQuantity,side:input.policy.direction==='long'?'bid':'ask',reduce_only:false,slippage_percent:GRID_SEED_MAX_SLIPPAGE_PERCENT,
          client_order_id:gridClientOrderId({botId:input.policy.id,level:GRID_SEED_IDENTITY_LEVEL,attempt:0,leg:'entry'}),...(facts.taker?.builder?{builder_code:facts.taker.builder.code}:{})}});
      for(const step of steps){
        const key=`grid:${input.policy.id}:launch:${step.kind}`,old=await this.deps.existing(key,input.policy.id);
        if(old?.state==='confirmed'){if(step.kind==='create')await this.deps.custody.confirmCreated(account);continue;}
        const current=await this.deps.observe(input.policy,step.kind==='create'?null:account),timestamp=this.deps.now();
        const funded=await this.deps.existing(`grid:${input.policy.id}:launch:fund`,input.policy.id);
        const latest=preflightGridLaunch(input.policy,input.policyHmac,security.umk,current,timestamp,funded?.state==='confirmed');
        if(!latest.ok)return {state:latest.transient?'pending':'denied',reason:latest.reason,account};
        if((step.kind!=='create'&&current.account!==account.account)||current.masterAccount!==account.masterAccount)return {state:'denied',reason:'Reserved account authority changed.',account};
        if(step.kind==='fund'){
          const empty=await this.deps.verifyEmpty(account);
          if(empty.state!=='empty'||!validGridEmptyProof(account,empty,this.deps.now()))return {state:'denied',reason:'Funding requires the exact confirmed empty subaccount.',account};
        }
        if(step.kind==='seed'){
          if(!current.taker)return {state:'denied',reason:'Fresh subaccount taker fee unavailable.',account};
          delete step.data.builder_code;
          if(current.taker.builder)step.data.builder_code=current.taker.builder.code;
        }
        const request:ExactGridRequest=old?.exact_request??{...step,botId:input.policy.id,account:account.account,masterAccount:account.masterAccount,timestamp,expiryMs:5000,
          authority:{policyHmac:input.policyHmac,policy:input.policy,admission:latest,facts:current,seedWorstPrice:latest.stop.state==='available'?latest.stop.projection.seedWorstPrice:null}};
        const claim:GridClaim={credits:'10',slots:0,canaryIncrement:step.kind==='seed'?latest.seedNotional:'0',observedCredits:current.observedCredits,
          availableSlots:current.availableSlots,observedAt:current.observedAt,expiresAt:current.expiresAt};
        const result=await this.deps.execution.run(key,request,claim,account.leaseToken);
        if(result!=='confirmed')return {state:'pending',reason:result==='failed'?'A launch operation was rejected; reconcile before recovery.':undefined,account};
        if(step.kind==='create')await this.deps.custody.confirmCreated(account);
      }
      await this.deps.markCanary(account);return {state:'canary',account};
    }catch(error){
      if(error instanceof GridLaunchTransientError)return {state:'pending',reason:error.message,account:retainedAccount};
      throw error;
    }finally{security.cleanup();}
  }
}
