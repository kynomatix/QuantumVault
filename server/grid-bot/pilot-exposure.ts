import Decimal from 'decimal.js';
import type {ExactGridRequest} from './launch-storage';
import {gridAddsExposure} from './margin';
import {orderedGridFills,type GridEconomicFill} from './pnl';
import type {GridObservation} from './reconciliation';
const D=Decimal.clone({precision:200});
export interface GridPilotOperation {
  id:string;state:string;venue_order_id:string|null;exact_request:ExactGridRequest;canary_increment:string|null;
}
/** These deny new risk, never the economic replay or its reduce-only exit authority. */
export const isGridPilotExposureBlockReason=(reason:string)=>['pilot_exposure_limit_exceeded','pilot_exposure_mark_unavailable','pilot_exposure_unknown','pilot_exposure_reservation_unavailable'].includes(reason);
const quantity=(s:unknown)=>{
  if(typeof s!=='string'||s.length>80||!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s))throw Error('Unknown Grid exposure');
  return new D(s);
};
/** Not collateral: no leverage division. Unknown sends retain their FULL signed reservation.
 * Only a complete reconciled inventory can release filled/cancelled/closed risk. Reduce-only
 * exits are excluded, since the position they protect is already counted. Storage compares
 * this exposure with configured investment × leverage; the canary clock never changes it. */
export function gridPilotExposure(input:{operations:GridPilotOperation[];fills:GridEconomicFill[];
  observation:GridObservation|null;authoritative:boolean;retainedUsd:string;now:number}):{exposureUsd:string|null;reason:string|null}{
  try{
    if(!Number.isSafeInteger(input.now))throw Error('Unknown observation time');
    const fills=orderedGridFills(input.fills),o=input.observation;
    const entries=input.operations.filter(op=>gridAddsExposure(op.exact_request));
    const mark=o?.mark&&Number.isSafeInteger(o.mark.observedAt)&&o.mark.observedAt<=input.now&&input.now-o.mark.observedAt<=5000?quantity(o.mark.price):null;
    if(mark&&!mark.gt(0))throw Error('Unknown mark');
    let position=new D(0),worst=mark??new D(0);
    for(const f of fills){const size=quantity(f.size);position=f.leg==='entry'?position.plus(size):position.minus(size);
      if(position.lt(0))throw Error('Overclosed position');
      if(f.leg==='entry')worst=D.max(worst,quantity(f.price));
    }
    if(position.gt(0)&&!mark)return {exposureUsd:null,reason:'pilot_exposure_mark_unavailable'};
    const bounds=new Map<string,Decimal>();
    for(const op of entries){const r=op.exact_request,price=quantity(r.kind==='seed'?r.authority.seedWorstPrice:r.data.price);
      if(!price.gt(0)||!quantity(r.data.amount).gt(0))throw Error('Invalid exposure request');
      bounds.set(op.id,D.max(price,mark??0));worst=D.max(worst,price);
    }
    const authoritative=input.authoritative&&!!o&&o.inventoryComplete&&Number.isSafeInteger(o.observedAt)&&o.observedAt<=input.now&&input.now-o.observedAt<=5000;
    if(authoritative&&(!o!.position||!quantity(o!.position.size).eq(position)))throw Error('Position parity unavailable');
    // Even an incomplete inventory cannot erase known filled risk. In that case the
    // full operation reservations are added conservatively until a complete replay.
    let used=position.mul(worst);
    for(const op of entries){
      if(op.state==='failed')continue;
      if(!['prepared','submitted','unconfirmed','confirmed'].includes(op.state)||op.canary_increment===null)throw Error('Missing exposure reservation');
      const amount=quantity(op.exact_request.data.amount),reserved=quantity(op.canary_increment),bound=bounds.get(op.id)!;
      if(authoritative&&op.state==='confirmed'){
        const order=o!.orders.find(order=>order.orderId===op.venue_order_id||order.clientOrderId!==null&&order.clientOrderId===op.exact_request.data.client_order_id);
        if(order){
          const filled=fills.filter(f=>f.operationId===op.id).reduce((sum,f)=>sum.plus(f.size),new D(0));
          if(!quantity(order.amount).eq(amount)||!quantity(order.filledAmount).eq(filled))throw Error('Order parity unavailable');
          if(['open','partially_filled'].includes(order.status)){
            const remaining=amount.minus(filled).minus(quantity(order.cancelledAmount??'0'));
            if(remaining.lt(0))throw Error('Invalid order residual');used=used.plus(remaining.mul(bound));
          }else if(!['filled','cancelled','rejected'].includes(order.status))throw Error('Unknown order status');
          continue;
        }
      }
      // No authoritative terminal inventory, or a send whose outcome remains unknown.
      // Including observed partial fills as well is deliberately conservative until settlement.
      used=used.plus(D.max(reserved,amount.mul(D.max(bound,worst))));
    }
    if(!authoritative)used=D.max(used,quantity(input.retainedUsd));
    return {exposureUsd:used.toFixed(),reason:null};
  }catch{return {exposureUsd:null,reason:'pilot_exposure_unknown'};}
}
