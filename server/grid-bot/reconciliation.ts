import {validateCycleFillPrices} from './cycle-history';
import type {GridPolicy} from './policy-hmac';
import Decimal from 'decimal.js';
import {canonicalRequest,type DurableGridOperation} from './launch-storage-core';
import {orderedGridFills,gridPnl,GridNumber,exactGridPosition,type GridEconomicFill} from './pnl';
import type {GridVenueOrder} from './order-identity';
import {GRID_HISTORY_PUBLICATION_LAG_MS} from './history-safety';
const D=Decimal.clone({precision:200});
export interface GridTrade {tradeId:string;orderId:string;clientOrderId:string|null;symbol:string;side:'open_long'|'open_short'|'close_long'|'close_short';time:number;size:string;price:string;fee:string}
export interface GridHistoryWindow {from:number;through:number;inclusive:true;publicationLagMs:number;source:string;lastId?:string;lastIds?:{orders:string;positions:string}}
export interface GridObservation {
  account:string;symbol:string;observedAt:number;orders:GridVenueOrder[];trades:GridTrade[];
  position:{direction:'long'|'short';size:string}|null;inventoryComplete:boolean;
  history:GridHistoryWindow|null;mark:{price:string;observedAt:number}|null;
  qualification?:{observedAt:number;leverage:string;maxLeverage:string;feeRate:string;minOrderSize:string;lotSize:string;tickSize:string;recycler:boolean}|null;
}
export interface ReconciliationOperation extends DurableGridOperation {venue_order_id:string|null;level_id:string|null}
export function validGridHistory(h:GridHistoryWindow|null,start:number,now:number):h is GridHistoryWindow{
  return !!h&&h.inclusive===true&&!!h.source&&[h.from,h.through,h.publicationLagMs].every(Number.isSafeInteger)
    &&h.from>=0&&h.from<=start&&h.through>=start&&h.publicationLagMs>=0&&h.publicationLagMs<=GRID_HISTORY_PUBLICATION_LAG_MS
    &&h.through<=now-h.publicationLagMs&&now-h.through<=5000+h.publicationLagMs;
}
/** Opaque CLOIDs are owned only through retained operations, never through a prefix. */
export function reconcileGridObservation(input:{account:string;symbol:string;direction:'long'|'short';start:number;now:number;operations:ReconciliationOperation[];prior:GridEconomicFill[];observation:GridObservation;cyclePolicy?:GridPolicy}){
  const {observation:o,operations}=input;
  if(o.account!==input.account||o.symbol!==input.symbol||o.observedAt>input.now||input.now-o.observedAt>5000||!o.inventoryComplete)throw Error('Grid inventory authority unavailable');
  const owner=(orderId:string,cloid:string|null)=>{
    const matches=operations.filter(op=>['limit','seed','close'].includes(op.exact_request?.kind)&&op.exact_request.account===input.account
      &&(op.venue_order_id===orderId||(cloid!==null&&op.exact_request.data.client_order_id===cloid)));
    if(matches.length!==1)return null;const op=matches[0];
    if(op.venue_order_id!==null&&op.venue_order_id!==orderId)throw Error('Conflicting order identity');return op;
  };
  const reasons:string[]=[],fills:GridEconomicFill[]=[],seen=new Map<string,string>();
  for(const t of o.trades){const encoded=canonicalRequest(t),old=seen.get(t.tradeId);if(old&&old!==encoded)throw Error('Conflicting trade pages');if(old)continue;seen.set(t.tradeId,encoded);
    const op=owner(t.orderId,t.clientOrderId);if(!op){reasons.push('unowned_trade');continue;}
    const r=op.exact_request,exit=r.data.reduce_only===true,leg=exit?'exit':'entry';
    if(t.symbol!==input.symbol||t.side!==`${exit?'close':'open'}_${input.direction}`||r.data.symbol!==t.symbol
      ||t.time<r.timestamp||!['submitted','unconfirmed','confirmed'].includes(op.state))throw Error('Trade does not match operation');
    fills.push({tradeId:t.tradeId,operationId:op.id,orderId:t.orderId,levelId:op.level_id,time:t.time,leg,size:t.size,price:t.price,fee:t.fee});
  }
  const mark=o.mark&&o.mark.observedAt<=input.now&&input.now-o.mark.observedAt<=5000?o.mark:null;
  if(input.cyclePolicy)validateCycleFillPrices(input.cyclePolicy,operations,[...input.prior,...fills]);
  const ledger=orderedGridFills([...input.prior,...fills]),pnl=gridPnl(input.direction,ledger,mark);
  const orders=new Map<string,GridVenueOrder>();
  for(const order of o.orders){const prior=orders.get(order.orderId);if(prior&&canonicalRequest(prior)!==canonicalRequest(order))throw Error('Conflicting order pages');orders.set(order.orderId,order);}
  const owned:{operationId:string;levelId:string|null;order:GridVenueOrder;remaining:string}[]=[];
  for(const order of orders.values()){const op=owner(order.orderId,order.clientOrderId);if(!op){reasons.push('opaque_orphan_order');continue;}
    const r=op.exact_request;
    if(order.symbol!==input.symbol||order.reduceOnly!==(r.data.reduce_only===true)||order.side!==(r.data.side==='bid'?'long':'short')
      ||!new D(order.amount).eq(String(r.data.amount))||(r.kind==='limit'&&!new D(order.price).eq(String(r.data.price))))throw Error('Order does not match operation');
    const filled=ledger.filter(f=>f.operationId===op.id).reduce((q,f)=>q.plus(f.size),new D(0));
    if(!filled.eq(order.filledAmount))reasons.push('order_trade_mismatch');
    if(filled.gt(order.amount))throw Error('Order overfill');
    if(order.status==='open'||order.status==='partially_filled')owned.push({operationId:op.id,levelId:op.level_id,order,remaining:new D(order.amount).minus(order.filledAmount).minus(order.cancelledAmount??'0').toFixed()});
  }
  for(const op of operations.filter(op=>['limit','seed','close'].includes(op.exact_request?.kind)&&op.state==='confirmed')){
    if(![...orders.values()].some(o=>owner(o.orderId,o.clientOrderId)?.id===op.id))reasons.push('vanished_order_unresolved');
    const sum=ledger.filter(f=>f.operationId===op.id).reduce((q,f)=>q.plus(f.size),new D(0));
    if(sum.gt(String(op.exact_request.data.amount)))throw Error('Cumulative operation overfill');
  }
  if(!validGridHistory(o.history,input.start,input.now))reasons.push('history_safe_through_unavailable');
  if(o.position===null||!new D(o.position.size).gte(0)||(!new D(o.position.size).isZero()&&o.position.direction!==input.direction)||GridNumber.read(o.position.size).cmp(exactGridPosition(ledger))!==0)reasons.push('position_mismatch_or_unavailable');
  if(operations.some(op=>['prepared','submitted','unconfirmed'].includes(op.state)))reasons.push('unresolved_operation');
  return {fills:ledger,pnl,owned,reasons:[...new Set(reasons)],entriesAllowed:reasons.length===0};
}
export interface GridFillAllocation {tradeId:string;size:string}
/** Existing reservations include prepared and uncertain sends. Only proven no-land releases them. */
export function pairGridFills(fills:GridEconomicFill[],reserved:GridFillAllocation[],wanted:string,lot:string,position:string):GridFillAllocation[]{
  const available=new Map<string,Decimal>(),ordered=orderedGridFills(fills).filter(f=>f.leg==='entry');
  for(const f of ordered)available.set(f.tradeId,new D(f.size));
  for(const a of reserved){const q=available.get(a.tradeId);if(!q||!new D(a.size).gt(0)||q.lt(a.size))throw Error('Invalid fill allocation');available.set(a.tradeId,q.minus(a.size));}
  if(!new D(lot).gt(0)||!new D(wanted).gte(0)||!new D(position).gte(0))throw Error('Invalid pairing constraints');
  let remaining=D.min(wanted,position).div(lot).floor().mul(lot);const result:GridFillAllocation[]=[];
  const total=[...available.values()].reduce((a,b)=>a.plus(b),new D(0));remaining=D.min(remaining,total.div(lot).floor().mul(lot));
  for(const f of ordered){const q=D.min(remaining,available.get(f.tradeId)!);if(q.gt(0)){result.push({tradeId:f.tradeId,size:q.toFixed()});remaining=remaining.minus(q);}if(remaining.isZero())break;}
  return result;
}
