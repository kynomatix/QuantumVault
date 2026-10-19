import {plannerRegime} from '../grid-planner/regime';
import {adx,atr} from '../lab/indicators';
import Decimal from 'decimal.js';
import type { PlannerCandle } from '../grid-planner/types';
import { validateCandles } from '../grid-planner/chart';
import { PERP_CHART_INTERVAL_MS } from '../grid-planner/pacifica-candles';
import { retainedGridCycles } from './cycle-policy';
import { gridPolicyExtension } from './behaviour-policy';
import { canonicalGridPolicy, type GridPolicy } from './policy-hmac';
import { epochDigest, GRID_EPOCH_POLICY_VERSION, GRID_MOVE_REVISION, type EpochCarry } from './epoch-policy';
import { validateRetainedGridCycles } from './cycle-validation';
import type { LaunchFacts } from './provision';

const D=Decimal.clone({precision:200});
/** Same strict two-bars-each-side swing definition as weekly structure; only the bot's finalized timeframe. */
export function qualifyGridDow(input:{policy:GridPolicy;timeframe:string;candles:PlannerCandle[];now:number;after:number}) {
  const {policy:p,candles:bars,now}=input,duration=PERP_CHART_INTERVAL_MS[input.timeframe];
  if(!['15m','1h','4h'].includes(input.timeframe)||!duration||bars.length<7||bars.length>200||!validateCandles(bars,now)
    ||!bars.every((c,i)=>c.provenance.source==='pacifica'&&c.provenance.venue==='pacifica'&&c.provenance.basis==='perp'&&c.provenance.proxy==='direct'
      &&c.provenance.finality==='finalized'&&c.time%duration===0&&c.time+duration<=now&&Number.isFinite(c.volume)&&c.volume>=0&&(!i||c.time===bars[i-1].time+duration))
    ||bars.at(-1)!.time+duration!==Math.floor(now/duration)*duration)throw Error('Finalized bot-timeframe Pacifica history is unavailable');
  const highs:number[]=[],lows:number[]=[];
  for(let i=2;i<bars.length-2;i++){
    const other=[bars[i-2],bars[i-1],bars[i+1],bars[i+2]];
    if(other.every(c=>bars[i].high>c.high))highs.push(i);
    if(other.every(c=>bars[i].low<c.low))lows.push(i);
  }
  if(highs.length<2||lows.length<2)throw Error('Two confirmed swing highs and lows are required');
  const h=highs.slice(-2),l=lows.slice(-2),long=p.direction==='long',last=bars.at(-1)!;
  const pivot=long?h[1]:l[1],edge=long?p.upperPrice:p.lowerPrice;
  const favourable=long?new D(bars[h[1]].high).gt(bars[h[0]].high)&&new D(bars[h[1]].high).gt(edge)
    :new D(bars[l[1]].low).lt(bars[l[0]].low)&&new D(bars[l[1]].low).lt(edge);
  const baseline=(long?lows:highs).filter(i=>i<pivot).at(-1);
  if(!favourable||baseline===undefined||bars[pivot].time<input.after||last.time<input.after
    ||!(long?new D(last.close).gt(edge):new D(last.close).lt(edge))
    ||bars.slice(pivot+1).some(c=>long?c.low<bars[baseline].low:c.high>bars[baseline].high))throw Error(long?'Wait for a confirmed higher high above the range with no lower low since':'Wait for a confirmed lower low below the range with no higher high since');
  // Advisory only for manual moves: missing warm-up or adverse indicators never veto Dow qualification.
  const regime=plannerRegime(p.market,input.timeframe,bars,now),high=bars.map(c=>c.high),low=bars.map(c=>c.low),close=bars.map(c=>c.close);
  const volatility=atr(high,low,close,14).at(-1),strength=adx(high,low,close,14).slice(-3);
  const information=regime.state==='available'&&volatility!==null&&volatility!==undefined&&Number.isFinite(volatility)&&volatility>0
    ?{state:'available' as const,adx:regime.adx,plusDi:regime.plusDi,minusDi:regime.minusDi,atr:volatility,
      edgeAtr:new D(last.close).minus(edge).abs().div(volatility).toNumber(),adxDeclining:strength.length===3&&strength.every(v=>v!==null)&&strength[0]!>strength[1]!&&strength[1]!>strength[2]!}
    :{state:'unavailable' as const,reason:regime.state==='unavailable'?regime.reason:'ATR is unavailable'};
  return {information,timeframe:input.timeframe,source:'pacifica',closedAt:last.time+duration,close:String(last.close),pivotAt:bars[pivot].time,
    confirmedAt:bars[pivot+2].time+duration,highs:h.map(i=>({time:bars[i].time,price:String(bars[i].high)})),lows:l.map(i=>({time:bars[i].time,price:String(bars[i].low)})),candleDigest:epochDigest(bars)};
}

export function candidateGridEpoch(input:{policy:GridPolicy;policyHmac:string;epochId:string;originEpochId:string;ordinal:number;carry:EpochCarry;facts:LaunchFacts;close:string;mark:string}) {
  const {policy:old,facts:f,carry}=input,long=old.direction==='long';
  if(!['2.2.0',GRID_EPOCH_POLICY_VERSION].includes(old.policyVersion)||old.sizingVersion!=='lean-1'||!old.stopLossPrice||!old.gridPolicyExtension||!canonicalGridPolicy(old))throw Error('This bot does not support range moving');
  const edge=long?new D(old.upperPrice).minus(old.levels.at(-2)!.price):new D(old.levels[1].price).minus(old.lowerPrice);
  if(!edge.gt(0)||!edge.mod(f.tick).eq(0))throw Error('The edge interval is not an exact market tick');
  let shift:Decimal|undefined;
  for(const multiple of [1,2]){
    const d=edge.mul(multiple).mul(long?1:-1),lower=new D(old.lowerPrice).plus(d),upper=new D(old.upperPrice).plus(d);
    if([input.close,input.mark,f.bookPrice].every(v=>new D(v).gt(lower)&&new D(v).lt(upper))){shift=d;break;}
  }
  if(!shift)throw Error('Price is too far beyond this range to move safely');
  const translate=(v:string)=>new D(v).plus(shift!).toFixed(8);
  const stop=translate(old.stopLossPrice),upper=translate(old.upperPrice),lower=translate(old.lowerPrice);
  if(!new D(stop).gt(0)||!new D(stop).mod(f.tick).eq(0)||(long?new D(stop).gte(lower):new D(stop).lte(upper)))throw Error('The translated stop is not protective');
  const envelope=D.max(old.safetyEnvelopePrice!,upper,long?'0':stop).toFixed(8),ceiling=new D(old.totalInvestment).mul(old.leverage);
  const held=carry.owners.reduce((sum,o)=>sum.plus(o.sources.filter(s=>s.kind==='inventory').reduce((n,s)=>n.plus(s.transferred),new D(0))),new D(0));
  if(held.mul(envelope).gt(ceiling))throw Error('Existing holdings exceed the moved range capacity');
  const levels=old.levels.map(l=>({...l,price:translate(l.price),size:new D(l.size).eq(0)?l.size:D.min(l.size,ceiling.div(envelope).div(f.lot).floor().mul(f.lot)).toFixed(8)}));
  const p:GridPolicy={...old,lowerPrice:lower,upperPrice:upper,startPrice:translate(old.startPrice),stopLossPrice:stop,levels,safetyEnvelopePrice:envelope,
    policyVersion:GRID_EPOCH_POLICY_VERSION,runtimePolicyVersion:GRID_EPOCH_POLICY_VERSION,
    epochAuthority:{epochId:input.epochId,predecessorId:input.originEpochId,ordinal:input.ordinal,revision:GRID_MOVE_REVISION,account:carry.account,
      originalPolicyHmac:old.epochAuthority?.originalPolicyHmac??input.policyHmac,carryDigest:epochDigest(carry),originalInvestment:old.totalInvestment,originalLeverage:old.leverage,originalSeedAtCreation:old.seedAtCreation,
      owners:carry.owners.map(o=>({ownerOrdinal:o.ownerOrdinal,lineage:o.lineage}))}};
  const cycles=retainedGridCycles(p);if(!cycles)throw Error('Moved cycle authority is unavailable');
  for(const c of cycles){const owner=carry.owners.find(o=>o.ownerOrdinal===c.ownerOrdinal);if(!owner)throw Error('Owner lineage changed');
    const inventory=owner.sources.filter(s=>s.kind==='inventory'),amount=inventory.reduce((n,s)=>n.plus(s.transferred),new D(0));
    if(amount.gt(c.quantity))throw Error('Existing holdings do not fit their owner quota');
    // The move may not turn a carried lot into a losing passive exit. Never average unrelated owners or spend rebates in advance.
    for(const lot of inventory.filter(s=>new D(s.transferred).gt(0))){
      const entryFee=D.max(0,lot.fee).div(lot.quantity),exitFee=D.max(0,f.profit.effectiveRate).mul(c.closingPrice),price=new D(lot.price);
      if(long?new D(c.closingPrice).minus(exitFee).lt(price.plus(entryFee)):new D(c.closingPrice).plus(exitFee).gt(price.minus(entryFee)))throw Error('A carried lot would exit below its fee-inclusive cost');
    }
  }
  const bounds={low:translate(old.gridPolicyExtension.seedPriceBounds.low),high:translate(old.gridPolicyExtension.seedPriceBounds.high)};
  p.gridPolicyExtension=gridPolicyExtension(cycles,old.gridPolicyExtension.mode,envelope,old.seedAtCreation,long,bounds);
  const valid=validateRetainedGridCycles(p,{...f,openingFeeRate:f.maker.effectiveRate,closingFeeRate:f.profit.effectiveRate});
  if(!canonicalGridPolicy(p)||!valid.ok)throw Error(valid.ok?'Moved policy is invalid':valid.reason);
  return {policy:p,displacement:shift.toFixed(8)};
}
