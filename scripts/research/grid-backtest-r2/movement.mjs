import Decimal from 'decimal.js';
import {createHash} from 'node:crypto';
import {candidateGridEpoch} from '../../../server/grid-bot/move-policy.ts';
import {canonicalGridPolicy} from '../../../server/grid-bot/policy-hmac.ts';
import {retainedGridCycles} from '../../../server/grid-bot/cycle-policy.ts';
import {trailHistory,qualifyAutomaticTrail,trailCapHold} from '../../../server/grid-bot/trail-policy.ts';
import {validateEpochCarry} from '../../../server/grid-bot/epoch-policy.ts';
import {atr} from '../../../server/lab/indicators.ts';
const D=Decimal.clone({precision:200});
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export function retestDecision(state,input,qualify=qualifyAutomaticTrail){
 const {policy:p,candles:bars,now}=input,last=bars.at(-1),long=p.direction==='long',edge=Number(long?p.upperPrice:p.lowerPrice);
 if(state.pending){
  const q=state.pending;
  if(q.edge!==edge||now-q.at>7*86400000||(long?last.close<edge:last.close>edge)){state.pending=null;return {eligible:false,reason:'retest_expired_or_adverse'};}
  const inside=long?last.close>=edge&&last.close<=edge+q.band&&last.low<=edge+q.band:last.close<=edge&&last.close>=edge-q.band&&last.high>=edge-q.band;
  if(last.time<=q.lastTime)return {eligible:false,reason:'retest_duplicate'};
  q.count=inside?q.count+1:0;q.lastTime=last.time;
  if(q.count<2)return {eligible:false,reason:'retest_wait'};
  state.pending=null;return {eligible:true,decisionAt:now,confirmedAt:now,close:String(last.close)};
 }
 const decision=qualify(input);if(!decision.eligible)return decision;
 const volatility=atr(bars.map(b=>b.high),bars.map(b=>b.low),bars.map(b=>b.close),14).at(-1);
 if(!(volatility>0))return {eligible:false,reason:'retest_atr_unavailable'};
 state.pending={edge,at:now,band:0.25*volatility,count:0,lastTime:last.time};
 return {eligible:false,reason:'retest_armed'};
}
export function movement(input,initial,cycles){
 let p=initial,epoch=1,serial=0;
 const ledger=trailHistory(p,input.candles[input.start].time),state={},moves=[],holds={};
 const lot=Number(input.market.lot),quantity=units=>new D(input.market.lot).mul(units).toFixed();
 const hold=s=>{holds[s]=(holds[s]??0)+1;};
 for(const c of cycles){c.initialIssued=c.credit;c.initialRemaining=c.credit;c.sources=[];}
 function fill(kind,closing,owner,units,price,rate,time){
  if(kind==='close')return;
  const n=++serial,id=`EXAMPLE_MOVE_FILL_${n}`,op=`EXAMPLE_MOVE_OPERATION_${n}`;
  const source=(c,part,sourceKind)=>({kind:sourceKind,sourceEpochId:uuid(epoch),operationId:op,tradeId:id,sourceOwner:c.ownerOrdinal,destinationOwner:c.ownerOrdinal,time,price:String(price),fee:new D(quantity(part)).mul(String(price)).mul(String(rate)).toFixed(),units:part,consumedUnits:0});
  const consume=(c,sourceKind,needed)=>{
   for(const s of c.sources.filter(s=>s.kind===sourceKind).sort((a,b)=>a.time-b.time||a.tradeId.localeCompare(b.tradeId))){
    const amount=Math.min(needed,s.units-s.consumedUnits);s.consumedUnits+=amount;needed-=amount;if(!needed)break;
   }
   if(needed)throw Error('Research move source conservation failed');
  };
  if(kind==='seed'){for(const c of cycles){const q=Math.round(Number(c.initialInventory)/lot);if(q)c.sources.push(source(c,q,'inventory'));}return;}
  if(closing){consume(owner,'inventory',units);if(owner.recycles!==false)owner.sources.push(source(owner,units,'recycle'));}
  else {
   const issued=Math.min(units,owner.initialRemaining);owner.initialRemaining-=issued;consume(owner,'recycle',units-issued);
   owner.sources.push(source(owner,units,'inventory'));
  }
 }
 function step(i,dataHold){
  const bars=input.candles,now=bars[i].time,long=p.direction==='long',previous=bars[i-1];
  if(dataHold){if(state.pending)state.pending.count=0;ledger.lastDecisionAt=now;return null;}
  if(!state.pending&&!(long?previous.close>Number(p.upperPrice):previous.close<Number(p.lowerPrice))){ledger.lastDecisionAt=now;return null;}
  const args={policy:p,history:ledger,candles:bars.slice(Math.max(0,i-100),i),timeframe:input.timeframe,now,variant:input.trailVariant??'d'};
  const qualify=x=>{
   const cache=input.moveDecisionCache;if(!cache)return qualifyAutomaticTrail(x);
   const key=JSON.stringify([x.variant,p.direction,p.lowerPrice,p.upperPrice,ledger.originalLower,ledger.originalUpper,ledger.createdAt,ledger.lastDecisionAt,ledger.moves.map(m=>[m.activatedAt,m.lower,m.upper]),now]);
   if(!cache.has(key))cache.set(key,qualifyAutomaticTrail(x));return cache.get(key);
  };
  const decision=input.moveMode==='retest'?retestDecision(state,args,qualify):qualify(args);ledger.lastDecisionAt=now;
  if(!decision.eligible){hold(decision.reason);return null;}
  const carry={account:'EXAMPLE_RESEARCH_ACCOUNT',originEpochId:uuid(epoch),owners:cycles.map(c=>({
   ownerOrdinal:c.ownerOrdinal,lineage:p.id+':'+c.ownerOrdinal,initialIssued:quantity(c.initialIssued),initialConsumed:quantity(c.initialIssued-c.initialRemaining),initialRemaining:quantity(c.initialRemaining),remainingOneShot:c.recycles===false?quantity(c.held):'0',
   sources:c.sources.map(s=>{const {units,consumedUnits,...rest}=s;return {...rest,quantity:quantity(units),consumed:quantity(consumedUnits),transferred:quantity(units-consumedUnits),parked:'0'};}),
  }))};
  const facts={...input.market,bookPrice:String(bars[i].open),maker:{effectiveRate:String(input.makerRate??0.00115)},profit:{effectiveRate:String(input.makerRate??0.00115)}};
  let candidate;
  try{
   candidate=candidateGridEpoch({policy:p,policyHmac:createHash('sha256').update(canonicalGridPolicy(p)).digest('hex'),epochId:uuid(epoch+1),originEpochId:uuid(epoch),ordinal:epoch+1,carry,facts,close:decision.close,mark:String(bars[i].open)}).policy;
   validateEpochCarry(carry,candidate.epochAuthority);
  }catch(e){hold('candidate: '+e.message);return null;}
  const capped=trailCapHold(p,ledger,now,candidate);if(capped){hold(capped);return null;}
  const previousStop=p.stopLossPrice;p=candidate;epoch++;
  for(const next of retainedGridCycles(p)){
   const c=cycles.find(c=>c.ownerOrdinal===next.ownerOrdinal);if(!c)throw Error('Research owner lineage changed');
   Object.assign(c,next,{open:Number(next.openingPrice),close:Number(next.closingPrice),units:Math.round(Number(next.quantity)/lot),imported:true});
  }
  const move={decisionAt:now,activatedAt:now+1,lower:p.lowerPrice,upper:p.upperPrice,stop:p.stopLossPrice,previousStop,actor:'automatic'};
  if(long?Number(move.stop)<Number(previousStop):Number(move.stop)>Number(previousStop))throw Error('Research move loosened stop');
  moves.push(move);ledger.moves.push(move);
  return p;
 }
 return {fill,step,moves,holds,ledger};
}
