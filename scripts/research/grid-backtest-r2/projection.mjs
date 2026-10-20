import {retainedGridCycles} from '../../../server/grid-bot/cycle-policy.ts';
import {projectGridStop} from '../../../server/grid-bot/stop-clearance.ts';
import Decimal from 'decimal.js';
export function projection(policy,market,maxLeverage,makerRate,takerRate,now){
 const cycles=retainedGridCycles(policy),seedQuantity=cycles.reduce((s,c)=>s+Number(c.initialInventory),0).toFixed(8);
 const plan={policyVersion:policy.policyVersion,sizingVersion:policy.sizingVersion,side:policy.direction,start:policy.startPrice,
  leverage:String(policy.leverage),seedQuantity,seedPriceBounds:policy.gridPolicyExtension.seedPriceBounds,
  capacityPrice:Decimal.max(policy.upperPrice,policy.gridPolicyExtension.seedPriceBounds.high).toFixed(),safetyEnvelopePrice:new Decimal(policy.safetyEnvelopePrice).toFixed(),
  lines:policy.levels.map(l=>({price:l.price,quantity:l.size,role:l.reduceOnly?'exit':'entry'})),cycles};
 return projectGridStop({plan,funding:policy.totalInvestment,stop:policy.stopLossPrice,tick:market.tick,
  maxLeverage:String(maxLeverage),makerRate:String(makerRate),takerRate:String(takerRate),observedAt:now,expiresAt:now+60000},now);
}
