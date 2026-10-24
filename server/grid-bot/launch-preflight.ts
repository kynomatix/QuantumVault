import {isGridCyclePolicyVersion} from '../../shared/grid-behaviour';
import {GRID_MINIMUM_LAUNCH_SLOTS} from '../../shared/grid-capacity';
import Decimal from 'decimal.js';
import type {GridPlan} from './engine-types';
import {calculateGrid} from './engine';
import {canonicalGridPolicy,verifyGridPolicyHmac,type GridPolicy} from './policy-hmac';
import {validateGridFeeQuote,type GridFeeQuote} from './fee-authority';
import {gridExposureLimit,gridFirstPlacementGate,gridRecyclerGate,gridWalletEntryGate} from './runtime-policy';
import {projectGridStop} from './stop-clearance';
import type {GridMarginReading} from './margin';
import {planGridRebalance} from './rebalance';
import {validateRetainedGridCycles} from './cycle-validation';
import {gridSeedPriceBounds} from './cycle-engine';
import {planCycleWindow} from './cycle-planner';
import {cycleCapacity} from './cycle-capacity';
import {replayGridCycles,type CycleReplayInput} from './cycle-replay';
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
    const fee=(quote:GridFeeQuote|null,role:'maker'|'taker',intent:'entry'|'profit')=>quote&&validateGridFeeQuote(quote,{account,subaccountId:null,market:policy.market,liquidityRole:role,builderCode:null,intent},now);
    if(!fee(f.maker,'maker','entry')||!fee(f.profit,'maker','profit')||!resume&&policy.seedAtCreation&&!fee(f.taker,'taker','entry'))return deny('Current account fees are unavailable.');
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
