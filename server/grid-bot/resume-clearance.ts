import Decimal from 'decimal.js';
import {freshGridFact} from './lifecycle-policy';
import type {GridObservation} from './reconciliation';
import type {GridPolicy} from './policy-hmac';
const D=Decimal.clone({precision:200});
export interface GridResumeRisk {
  account:string;symbol:string;positionSize:string;liquidationPrice:string|null;observedAt:number;source:string;
}
/** Existing positions require current liquidation authority, not the launch projection. */
export function gridResumeClearance(risk:GridResumeRisk|undefined,o:GridObservation,policy:GridPolicy,tick:string,now:number){
  try{
    if(!risk||!risk.source||risk.account!==o.account||risk.symbol!==o.symbol||!o.position||!freshGridFact(o.observedAt,now)||!freshGridFact(risk.observedAt,now)
      ||!new D(risk.positionSize).eq(o.position.size)||!policy.stopLossPrice||!new D(tick).gt(0))return false;
    if(new D(risk.positionSize).isZero())return true;
    if(o.position.direction!==policy.direction||!risk.liquidationPrice||!new D(risk.liquidationPrice).gt(0))return false;
    const liquidation=new D(risk.liquidationPrice),stop=new D(policy.stopLossPrice),clearance=D.max(tick,liquidation.mul('0.01').div(tick).ceil().mul(tick));
    return stop.mod(tick).isZero()&&(policy.direction==='long'?stop.minus(liquidation):liquidation.minus(stop)).gte(clearance);
  }catch{return false;}
}
