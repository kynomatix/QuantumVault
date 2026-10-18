import { createHash, randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { dollars, explainPlannerIssue } from '../grid-planner/order-explanation';
import { GRID_CREATE_POLICY, GRID_CAPACITY_UNKNOWN, gridIntentSchema, gridRevisionSchema, gridCreateRequestSchema, type GridIntent, type GridCreateRequest } from '../../shared/grid-draft';
import { calculateGrid, minimumInvestment, validGridDecimal } from './engine';
import type { GridGeometryInput, GridPlan } from './engine-types';
import { validateGridFeeQuote, type GridFeeQuote } from './fee-authority';
import { computeGridPolicyHmac, verifyGridPolicyHmac, canonicalGridPolicy, type GridPolicy, type SignedGridLevel } from './policy-hmac';
import { gridStopReachable } from './runtime-policy';
import { type GridStorage, type DraftRecord } from './storage';
import type { PlannerMarket } from '../grid-planner/types';
import { projectGridStop } from './stop-clearance';
import { GRID_CYCLE_V2_CREATION } from './cycle-policy';
import { gridSeedPriceBounds } from './cycle-engine';
import { GRID_LEAN_SIZING_CREATION } from './lean-sizing';

const D = Decimal.clone({ precision:100, toExpNeg:-100, toExpPos:100 });
export class GridDraftError extends Error { constructor(public code: 'authority_unavailable'|'preview_drift'|'idempotency_conflict'|'secret_unavailable'|'invalid_intent', public reasons: string[] = []) { super(code); } }
export interface GridDraftAuthority {
  market: PlannerMarket; referenceAccount: string | null; entryFee: GridFeeQuote | null; profitFee: GridFeeQuote | null; seedFee: GridFeeQuote | null;
  stop: { state:'available'; liquidation:string; validatedClearance:string; boundedAdverseExitPrice:string; observedAt:number; expiresAt:number; source:string } | { state:'unavailable'; reason:string };
  autoRange: { lowerPrice:string; upperPrice:string; stopPrice:string; latestFinalizedTime:number } | null;
}
export interface GridDraftDeps {
  /** Server/test injection only. HTTP bodies cannot select a policy version. */
  cycleV2Creation?: boolean;
  leanSizingCreation?: boolean;
  projectedStop?: boolean;
  now():number; observe(wallet:string,intent:GridIntent):Promise<GridDraftAuthority>; umk(wallet:string):Promise<Buffer|null>;
  storage: Pick<GridStorage,'createDraftWithLevels'|'findByClientRequest'|'getBotSnapshot'>;
}
const stable = (value: unknown): string => JSON.stringify(value, (_,v) => v && typeof v==='object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])) : v);
const digest = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex').toUpperCase();
const fresh = (observedAt:number,expiresAt:number,now:number) => Number.isSafeInteger(observedAt) && Number.isSafeInteger(expiresAt) && observedAt<=now && now<expiresAt;
function signedLevels(plan:GridPlan):SignedGridLevel[] {
  return plan.lines.map(l=>({ ordinal:l.ordinal+1,price:new D(l.price).toFixed(8),size:new D(l.quantity).toFixed(8),
    side:plan.side==='long'?(l.role==='seed_exit'?'sell':'buy'):(l.role==='seed_exit'?'buy':'sell'), reduceOnly:l.role==='seed_exit' }));
}
export async function authoritativeGridPreview(wallet:string,intent:GridIntent,draftRevision:string,deps:GridDraftDeps) {
  if (!wallet || !gridIntentSchema.safeParse(intent).success || !gridRevisionSchema.safeParse(draftRevision).success) throw new GridDraftError('invalid_intent');
  const authority=await deps.observe(wallet,intent), now=deps.now(), reasons:string[]=[];
  const cyclic=deps.cycleV2Creation ?? GRID_CYCLE_V2_CREATION;
  const lean=cyclic && (deps.leanSizingCreation ?? GRID_LEAN_SIZING_CREATION);
  const createPolicy=cyclic?{...GRID_CREATE_POLICY,policyVersion:'2.0.0',runtimePolicyVersion:'2.0.0'}:GRID_CREATE_POLICY;
  // A v2 preview must earn projected stop authority even when other observations prevent sizing.
  if(cyclic) authority.stop={state:'unavailable',reason:'Stop projection inputs unavailable'};
  const c=authority.market.constraints, reference=authority.market.reference;
  let plan:GridPlan|null=null, minimum:string|null=null, seedTakerCost:string|null=null;
  const reject=(reason:string)=>{ reasons.push(reason); };
  if (authority.market.market!==intent.market) reject('Market identity mismatch');
  if (c.state!=='available') reject(c.reason);
  if (reference.state!=='available') reject(reference.reason);
  let expiresAt=0;
  const missingCycleInputs=cyclic && c.state==='available' && reference.state==='available'
    && (!validGridDecimal(c.value.tick) || !validGridDecimal(c.value.lot) || !validGridDecimal(reference.value.price)
      || !c.value.maxLeverage || c.value.maxLeverage.state==='available' && !validGridDecimal(c.value.maxLeverage.value));
  if(missingCycleInputs) reject('Stop projection inputs unavailable');
  if (c.state==='available' && reference.state==='available' && !missingCycleInputs) {
    const cv=c.value,r=reference.value;
    if(new D(cv.tick).decimalPlaces()>8 || new D(cv.lot).decimalPlaces()>8) reject('Venue precision exceeds durable Grid price or size precision');
    expiresAt=Math.min(cv.expiresAt,r.expiresAt);
    if (!fresh(cv.observedAt,cv.expiresAt,now) || !fresh(r.observedAt,r.expiresAt,now)) reject('Market observations expired or future-dated');
    if (cv.maxLeverage.state!=='available') reject('Venue leverage maximum unavailable');
    else if (new D(intent.leverage).gt(cv.maxLeverage.value)) reject(`Pacifica allows up to ${cv.maxLeverage.value}× leverage for this market. Lower the leverage.`);
    // Optional public limits are checked below when supplied; launch checks remain independent.
    const lower=new D(intent.lowerPrice),upper=new D(intent.upperPrice),stop=new D(intent.stopPrice),tick=new D(cv.tick);
    if (!lower.lt(upper) || !stop.mod(tick).isZero() || (intent.direction==='long'?!stop.lt(lower):!stop.gt(upper))) reject('Stop must align to the tick and lie beyond the loss side of the range');
    if (intent.rangeSource==='auto') {
      const a=authority.autoRange;
      const snap=(v:string,round:Decimal.Rounding)=>new D(v).div(tick).toDecimalPlaces(0,round).mul(tick);
      if (!a || !lower.eq(snap(a.lowerPrice,D.ROUND_CEIL)) || !upper.eq(snap(a.upperPrice,D.ROUND_FLOOR))
        || !stop.eq(snap(a.stopPrice,intent.direction==='long'?D.ROUND_FLOOR:D.ROUND_CEIL))) reject('Auto range changed or finalized history unavailable; manual range remains available');
    }
    const identity=(role:'maker'|'taker',purpose:'entry'|'profit')=>({account:authority.referenceAccount??'',subaccountId:null,market:intent.market,liquidityRole:role,builderCode:'CARRY',intent:purpose});
    const entry=authority.entryFee,profit=authority.profitFee,seed=authority.seedFee;
    const makerValid=!!entry && !!profit && validateGridFeeQuote(entry,identity('maker','entry'),now) && validateGridFeeQuote(profit,identity('maker','profit'),now);
    const seedValid=!intent.seedAtCreation || !!seed && validateGridFeeQuote(seed,identity('taker','entry'),now);
    if (!makerValid) reject('Current account maker and builder fee quotes unavailable');
    if (!seedValid) reject('Current seed taker fee unavailable');
    const makerRate=makerValid?D.max(0,entry!.effectiveRate,profit!.effectiveRate).toFixed():null;
    const takerRate=intent.seedAtCreation && seedValid?new D(seed!.effectiveRate):new D(0);
    const reserveRate=cyclic?D.max(0,makerRate??'0',takerRate):takerRate;
    const reserveFactor=new D(1).plus(new D(intent.leverage).mul(reserveRate));
    const input:GridGeometryInput={side:intent.direction,lower:intent.lowerPrice,upper:intent.upperPrice,start:r.price,
      intervals:intent.gridCount,entryScale:intent.entryScaleType,profitScale:intent.profitScaleType,seed:intent.seedAtCreation,
      leverage:intent.leverage,tick:cv.tick,lot:cv.lot,minimumQuote:cv.minimumQuote,investmentStep:'0.01',transferFloor:'0.01',effectiveMakerCostRate:makerRate,
      ...(cyclic?{policyVersion:'2.0.0' as const,...(cv.maximumQuote.state==='available'?{maximumQuote:cv.maximumQuote.value}:{})}:{}),
      ...(lean?{sizingVersion:'lean-1' as const,safetyEnvelopePrice:D.max(intent.upperPrice,intent.seedAtCreation?gridSeedPriceBounds(r.price,cv.tick).high:'0',intent.direction==='short'?intent.stopPrice:'0').toFixed()}: {})};
    const min=minimumInvestment(input);
    if (min.ok) minimum=new D(min.investment).mul(reserveFactor).toDecimalPlaces(2,D.ROUND_CEIL).toFixed(2);
    else reject(...[min.issues.map(i=>i.reason).join('; ')]);
    const calculationInput={...input,investment:new D(intent.totalInvestment).div(reserveFactor).toDecimalPlaces(2,D.ROUND_FLOOR).toFixed(2)};
    const calculation=calculateGrid(calculationInput);
    if (!calculation.ok) calculation.issues.forEach(i=>reject(explainPlannerIssue(i,calculationInput)));
    else {
      plan=calculation.plan;
      if(cyclic && [plan.start,intent.stopPrice,...plan.lines.flatMap(l=>[l.price,l.quantity])].some(v=>!new D(v).eq(new D(v).toFixed(8))))
        reject('Cycle geometry exceeds durable policy precision');
      if(new D(plan.start).minus(intent.stopPrice).abs().div(plan.start).mul(100).toDecimalPlaces(4).eq(0)) reject('Stop distance is below durable policy precision');
      if (makerValid && plan.feeGate!=='evaluated') reject('Maker fee clearance unavailable');
      seedTakerCost=intent.seedAtCreation && seedValid?new D(plan.seedQuantity).mul(plan.start).mul(takerRate).toFixed():intent.seedAtCreation?null:'0';
      if(cyclic && intent.seedAtCreation && seedValid) seedTakerCost=new D(plan.seedQuantity).mul(gridSeedPriceBounds(r.price,cv.tick).high).mul(D.max(0,takerRate)).toFixed();
      if (cv.maximumQuote.state==='available') {const maximum=cv.maximumQuote.value,line=plan.lines.find(l=>new D(l.notional).gt(maximum));if(line) reject(`A grid order would be $${dollars(line.notional)}, above Pacifica's $${dollars(maximum)} maximum. Lower the investment or leverage, or use more grids.`);}
      if (cv.priceBounds.state==='available') {
        const bounds=cv.priceBounds.value as {minimum?:string;maximum?:string};
        if (!bounds.minimum || !bounds.maximum || plan.lines.some(l=>new D(l.price).lt(bounds.minimum!) || new D(l.price).gt(bounds.maximum!))) reject(`Pacifica accepts prices from $${bounds.minimum} to $${bounds.maximum}. Move the range inside those limits.`);
        if(cyclic && intent.seedAtCreation){const seedBounds=gridSeedPriceBounds(r.price,cv.tick);if(!bounds.minimum||!bounds.maximum||new D(seedBounds.low).lt(bounds.minimum)||new D(seedBounds.high).gt(bounds.maximum))reject('Bounded seed execution exceeds current price limits');}
      }
      if (cv.restrictions.state==='available' && cv.restrictions.value!== 'unrestricted') reject(cv.restrictions.value==='isolated_only'
        ? 'This market requires isolated margin, which Grid does not support. Choose another market.'
        : 'This market does not support the perpetual order-book orders Grid needs. Choose another market.');
      const s=(deps.projectedStop || cyclic) && cv.maxLeverage.state==='available' && makerValid && seedValid
        ? projectGridStop({plan,funding:intent.totalInvestment,stop:intent.stopPrice,tick:cv.tick,maxLeverage:cv.maxLeverage.value,
          makerRate:makerRate!,takerRate:takerRate.toFixed(),observedAt:Math.max(cv.observedAt,r.observedAt),expiresAt,},now)
        : cyclic ? {state:'unavailable' as const,reason:'Stop projection inputs unavailable'} : authority.stop;
      authority.stop=s;
      if (s.state!=='available') reject(s.reason);
      else {
        expiresAt=Math.min(expiresAt,s.expiresAt);
        if (!s.source || !fresh(s.observedAt,s.expiresAt,now) || !gridStopReachable({side:intent.direction,entry:plan.start,stop:intent.stopPrice,
          liquidation:s.liquidation,tick:cv.tick,validatedClearance:s.validatedClearance,boundedAdverseExitPrice:s.boundedAdverseExitPrice,enabled:true,reduceOnly:true})) reject('Stop does not have validated liquidation clearance');
      }
    }
    if (entry) expiresAt=Math.min(expiresAt,entry.expiresAt);
    if (profit) expiresAt=Math.min(expiresAt,profit.expiresAt);
    if (intent.seedAtCreation && seed) expiresAt=Math.min(expiresAt,seed.expiresAt);
  }
  const ready=reasons.length===0 && plan!==null && expiresAt>now;
  const summaryPlan=plan,observedConstraints=c.state==='available'?c.value:null;
  const geometrySummary=summaryPlan && observedConstraints?(()=>{
    const spacing=summaryPlan.lines.slice(1).map((line,i)=>new D(line.price).minus(summaryPlan.lines[i].price));
    const seedNotional=new D(summaryPlan.seedQuantity).mul(summaryPlan.start);
    const restingEntryMargin=summaryPlan.lines.filter(line=>line.role==='entry').reduce((sum,line)=>sum.plus(line.notional),new D(0)).div(intent.leverage);
    return {minimumSpacing:D.min(...spacing).toFixed(),maximumSpacing:D.max(...spacing).toFixed(),minimumOrderNotional:observedConstraints.minimumQuote,
      seedNotional:seedNotional.toFixed(),restingEntryMargin:restingEntryMargin.toFixed(),
      totalRequiredCapital:seedTakerCost===null || cyclic && reasons.length>0?null:(summaryPlan.capacityNotional
        ?new D(summaryPlan.capacityNotional).div(intent.leverage).plus(new D(summaryPlan.capacityNotional).mul(D.max(0,authority.entryFee?.effectiveRate??'0',authority.profitFee?.effectiveRate??'0',intent.seedAtCreation?authority.seedFee?.effectiveRate??'0':'0')))
        :restingEntryMargin.plus(seedNotional.div(intent.leverage)).plus(seedTakerCost)).toDecimalPlaces(2,D.ROUND_CEIL).toFixed(2),
      feeClearance:summaryPlan.feeGate==='evaluated' && summaryPlan.feeRows.every(row=>row.clears)?'clears' as const:'unknown' as const};
  })():null;
  const bound={schemaVersion:1,draftRevision,intent,authority,plan,minimum,seedTakerCost,geometrySummary,policy:createPolicy};
  return { schemaVersion:1 as const,state:ready?'ready' as const:'unavailable' as const, reasons,policy:createPolicy,
    plan,levels:plan?signedLevels(plan):[],minimum,seedTakerCost,geometrySummary,authority,capacity:GRID_CAPACITY_UNKNOWN,
    serverIntentDigest:ready?digest(bound):null,expiresAt,receivedAt:now,pnlLabel:'Excludes funding' as const };
}
export async function createGridDraft(wallet:string,request:GridCreateRequest,deps:GridDraftDeps) {
  if (!gridCreateRequestSchema.safeParse(request).success) throw new GridDraftError('invalid_intent');
  const preview=await authoritativeGridPreview(wallet,request.intent,request.draftRevision,deps);
  if (preview.state!=='ready' || !preview.plan) throw new GridDraftError('authority_unavailable',preview.reasons);
  if (preview.serverIntentDigest!==request.serverIntentDigest) throw new GridDraftError('preview_drift',['Preview changed. Review the refreshed numbers before saving.']);
  const umk=await deps.umk(wallet);
  if (!umk) throw new GridDraftError('secret_unavailable');
  const previous=await deps.storage.findByClientRequest(wallet,request.clientRequestId);
  const id=previous?.id??randomUUID(), p=preview.plan;
  const policy:GridPolicy={id,protocol:'pacifica',market:request.intent.market,direction:request.intent.direction,
    ...(p.sizingVersion?{sizingVersion:p.sizingVersion,safetyEnvelopePrice:new D(p.safetyEnvelopePrice!).toFixed(8)}:{}),
    upperPrice:new D(p.lines.at(-1)!.price).toFixed(8),lowerPrice:new D(p.lines[0].price).toFixed(8),startPrice:new D(p.start).toFixed(8),
    gridCount:request.intent.gridCount,totalInvestment:new D(request.intent.totalInvestment).toFixed(2),leverage:Number(request.intent.leverage),
    entryScaleType:request.intent.entryScaleType,profitScaleType:request.intent.profitScaleType,policyVersion:preview.policy.policyVersion,feePolicyVersion:'1.0.0',runtimePolicyVersion:preview.policy.runtimePolicyVersion,
    stopLossPercent:new D(p.start).minus(request.intent.stopPrice).abs().div(p.start).mul(100).toFixed(4),stopLossPrice:new D(request.intent.stopPrice).toFixed(8),seedAtCreation:request.intent.seedAtCreation,levels:preview.levels};
  const hmac=computeGridPolicyHmac(policy,umk);
  if (!hmac.ok) throw new GridDraftError('secret_unavailable',[hmac.reason]);
  const {levels,...immutable}=policy;
  const bot:DraftRecord={...immutable,walletAddress:wallet,clientRequestId:request.clientRequestId,serverIntentDigest:request.serverIntentDigest,
    draftRevision:request.draftRevision,createIntent:request.intent,authoritySnapshot:preview.authority,policyHmac:hmac.digest,name:`${request.intent.market} Grid draft`,
    rangeSource:request.intent.rangeSource,chartTimeframe:request.intent.timeframe};
  const result=await deps.storage.createDraftWithLevels(bot,levels);
  // A uniqueness race may elect a different UUID. Recompute with that UUID and compare complete stored geometry.
  const snapshot=await deps.storage.getBotSnapshot(wallet,result.bot.id);
  const winnerPolicy={...policy,id:snapshot.bot.id,levels:snapshot.levels.map(({ordinal,price,size,side,reduceOnly})=>({ordinal,price,size,side,reduceOnly}))};
  if (snapshot.bot.serverIntentDigest!==request.serverIntentDigest || snapshot.bot.draftRevision!==request.draftRevision
    || stable(snapshot.bot.createIntent)!==stable(request.intent) || canonicalGridPolicy({...snapshot.bot,levels:winnerPolicy.levels})!==canonicalGridPolicy({...policy,id:snapshot.bot.id})
    || !verifyGridPolicyHmac(winnerPolicy,umk,snapshot.bot.policyHmac).ok) throw new GridDraftError('idempotency_conflict');
  return {bot:snapshot.bot,result:result.result,pnlLabel:'Excludes funding'};
}
