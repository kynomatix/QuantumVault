import Decimal from 'decimal.js';
import type {GridPolicy} from './policy-hmac';
import type {GridObservation,ReconciliationOperation} from './reconciliation';
import {reconcileGridLimit,type GridReconciliation} from './execution';
import {requestDigest,type ExactGridRequest} from './launch-storage-core';
import {gridWalletEntryGate} from './runtime-policy';
const D=Decimal.clone({precision:200});
export type GridControlAction='pause'|'resume'|'resync'|'stop'|'band'|'regrid';
export const freshGridFact=(at:number,now:number)=>Number.isSafeInteger(at)&&at<=now&&now-at<=5000;
const positive=(value:unknown)=>typeof value==='string'&&/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)&&new D(value).gt(0);
/** Only an identity-bound entry cancel may coexist with a Stop close. Never replay it. */
export function gridUnresolvedEntryCancel(op:{state:string;exact_request:ExactGridRequest;exact_request_digest:string},identity:{botId:string;account:string;masterAccount:string}){
  const r=op.exact_request,original=r?.authority?.originalRequest as ExactGridRequest|undefined;
  return ['submitted','unconfirmed'].includes(op.state)&&r?.kind==='cancel'&&requestDigest(r)===op.exact_request_digest
    &&r.botId===identity.botId&&r.account===identity.account&&r.masterAccount===identity.masterAccount
    &&original?.kind==='limit'&&original.data.reduce_only===false&&original.botId===r.botId
    &&original.account===r.account&&original.masterAccount===r.masterAccount&&original.data.symbol===r.data.symbol;
}
/** C4 uncertainty never authorizes another transfer, but must not prevent retained Stop reductions. */
export function gridUnresolvedTransfer(op:{state:string;exact_request:ExactGridRequest;exact_request_digest:string},identity:{botId:string;account:string;masterAccount:string},now:number){
  const r=op.exact_request;
  return ['submitted','unconfirmed'].includes(op.state)&&r&&['fund','sweep'].includes(r.kind)&&requestDigest(r)===op.exact_request_digest
    &&r.botId===identity.botId&&r.account===identity.account&&r.masterAccount===identity.masterAccount
    &&r.path==='/account/subaccount/transfer'&&r.operationType==='transfer_funds'
    &&r.data.to_account===(r.kind==='fund'?r.account:r.masterAccount)&&positive(r.data.amount)
    &&Number.isSafeInteger(r.timestamp)&&Number.isSafeInteger(r.expiryMs)&&r.expiryMs>0&&r.expiryMs<=15000&&r.timestamp+r.expiryMs<=now;
}
export function gridUnresolvedStopReduction(op:{state:string;exact_request:ExactGridRequest;exact_request_digest:string},r:ExactGridRequest,now:number){
  return r.kind==='close'&&r.data.reduce_only===true&&gridUnresolvedEntryCancel(op,r)
    ||(r.kind==='cancel'||r.kind==='close'&&r.data.reduce_only===true)&&gridUnresolvedTransfer(op,r,now);
}
export function gridEntrySafety(input:{sol:string|null;solObservedAt:number|null;failures:number;mark:GridObservation['mark']},now:number){
  const sol=input.solObservedAt!==null&&freshGridFact(input.solObservedAt,now)?input.sol:null;
  const wallet=gridWalletEntryGate(sol),reasons:string[]=[];
  if(!wallet.entryAllowed)reasons.push(wallet.reason??'wallet_entry_denied');
  if(!Number.isSafeInteger(input.failures)||input.failures<0||input.failures>=5)reasons.push('circuit_breaker');
  if(!input.mark||!freshGridFact(input.mark.observedAt,now)||!positive(input.mark.price))reasons.push('mark_unavailable');
  return {allowed:reasons.length===0,reasons,warning:wallet.warning};
}
/** Price stop does not depend on PnL availability. No synthetic zero is recorded as trigger evidence. */
export function gridRiskTrigger(policy:Pick<GridPolicy,'direction'|'stopLossPrice'|'lowerPrice'|'upperPrice'>,mark:GridObservation['mark'],now:number){
  if(!positive(policy.stopLossPrice))return {kind:'unavailable' as const,reason:'mandatory_stop_unavailable'};
  if(!mark||!freshGridFact(mark.observedAt,now)||!positive(mark.price))return {kind:'unavailable' as const,reason:'mark_unavailable'};
  const price=new D(mark.price),stop=new D(policy.stopLossPrice!);
  if(policy.direction==='long'?price.lte(stop):price.gte(stop))return {kind:'stop' as const,evidence:{source:'pacifica:/info/prices:mark',price:mark.price,observedAt:mark.observedAt,stop:policy.stopLossPrice,pnl:null,includesFunding:false}};
  if(price.lt(policy.lowerPrice)||price.gt(policy.upperPrice))return {kind:'band' as const,evidence:{source:'pacifica:/info/prices:mark',price:mark.price,observedAt:mark.observedAt,lower:policy.lowerPrice,upper:policy.upperPrice}};
  return {kind:'none' as const};
}
export function reconcileGridReduction(r:ExactGridRequest,orders:GridObservation['orders']):GridReconciliation{
  if(r.kind==='cancel'){
    const original=r.authority.originalRequest as ExactGridRequest|undefined;
    if(!original||original.botId!==r.botId||original.account!==r.account||original.masterAccount!==r.masterAccount||original.data.symbol!==r.data.symbol)return {state:'unknown'};
    const result=reconcileGridLimit(original,orders);
    if(result.state==='confirmed'&&result.orderId===String(r.data.order_id)&&['cancelled','filled'].includes(result.orderStatus??''))
      return {...result,requestDigest:requestDigest(r),releaseSlot:true};
    return {state:'unknown'};
  }
  if(r.kind!=='close')return {state:'unknown'};
  const matches=orders.filter(o=>o.clientOrderId===r.data.client_order_id);if(matches.length!==1)return {state:'unknown'};
  const o=matches[0];
  if(o.symbol!==r.data.symbol||!o.reduceOnly||o.orderType!=='market'||(o.side==='long'?'bid':'ask')!==r.data.side
    ||!new D(o.amount).eq(String(r.data.amount))||o.createdAt<r.timestamp||o.createdAt>r.timestamp+r.expiryMs)return {state:'unknown'};
  if(o.status==='rejected'&&new D(o.filledAmount).isZero())return {state:'rejected',requestDigest:requestDigest(r),releaseSlot:true,orderId:o.orderId,orderStatus:o.status};
  if(o.status==='filled'&&new D(o.filledAmount).eq(o.amount)||o.status==='cancelled')return {state:'confirmed',requestDigest:requestDigest(r),releaseSlot:true,orderId:o.orderId,orderStatus:o.status};
  return {state:'unknown'};
}
/** Cancellation is per retained exact identity. An orphan is never swept up by cancel-all. */
export function gridOwnedLive(operations:ReconciliationOperation[],o:GridObservation){
  return o.orders.filter(order=>['open','partially_filled'].includes(order.status)).map(order=>{
    const matches=operations.filter(op=>op.exact_request?.kind==='limit'&&op.exact_request.account===o.account
      &&op.exact_request.data.client_order_id===order.clientOrderId&&(!op.venue_order_id||op.venue_order_id===order.orderId));
    if(matches.length!==1)return {order,operation:null};
    const op=matches[0],result=reconcileGridLimit(op.exact_request,[order]);
    return {order,operation:result.state==='confirmed'?op:null};
  });
}
