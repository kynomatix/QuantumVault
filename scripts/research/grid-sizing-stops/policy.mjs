// Research wrapper around the unchanged product sizing and canonical-policy helpers.
import Decimal from 'decimal.js';
import {calculateCycleGrid} from '../../../server/grid-bot/cycle-engine.ts';
import {canonicalGridPolicy} from '../../../server/grid-bot/policy-hmac.ts';
const D=Decimal.clone({precision:80});
export const ARMS={flat_flat:['flat','flat'],further_further:['ascending','ascending'],further_flat:['ascending','flat'],flat_further:['flat','ascending'],near_near:['descending','descending']};
export function sizingPolicy({market:m,direction,geometry:g,reference,leverage,makerRate,arm,investment='1000.00'}){
 const long=direction==='long',stop=long?g.longStop:g.shortStop,envelope=long?g.upper:stop;
 const [entryScale,profitScale]=ARMS[arm]??[];
 const result=calculateCycleGrid({side:direction,lower:g.lower,upper:g.upper,start:reference,intervals:10,
  entryScale,profitScale,seed:true,leverage:String(leverage),tick:m.tick,lot:m.lot,minimumQuote:m.minimumQuote,
  maximumQuote:m.maximumQuote,investmentStep:'0.01',transferFloor:'0',investment,
  effectiveMakerCostRate:String(makerRate),policyVersion:'2.2.0',behaviourMode:'step_back',sizingVersion:'lean-1',safetyEnvelopePrice:envelope});
 if(!result.ok)throw Error(result.issues.map(i=>i.reason).join('; '));
 const p=result.plan;
 const policy={id:'00000000-0000-4000-8000-000000000001',protocol:'pacifica',market:m.symbol+'-PERP',direction,
  lowerPrice:new D(p.lines[0].price).toFixed(8),upperPrice:new D(p.lines.at(-1).price).toFixed(8),startPrice:new D(p.start).toFixed(8),
  gridCount:10,totalInvestment:investment,leverage,entryScaleType:entryScale,profitScaleType:profitScale,
  policyVersion:'2.2.0',runtimePolicyVersion:'2.2.0',feePolicyVersion:'1.0.0',
  stopLossPercent:new D(stop).minus(reference).abs().div(reference).mul(100).toFixed(4),stopLossPrice:stop,seedAtCreation:true,
  sizingVersion:'lean-1',safetyEnvelopePrice:envelope,gridPolicyExtension:p.gridPolicyExtension,
  levels:p.lines.map(l=>{const closing=long?new D(l.price).gt(p.start):new D(l.price).lt(p.start);return {ordinal:l.ordinal+1,
   price:new D(l.price).toFixed(8),size:new D(l.quantity).toFixed(8),reduceOnly:closing,side:long?(closing?'sell':'buy'):(closing?'buy':'sell')};})};
 if(!canonicalGridPolicy(policy))throw Error('Generated sizing policy is not canonical');
 return {policy,lift:p.openingOrderLift??null};
}
