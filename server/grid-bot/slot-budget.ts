import {gridPlacementBudget, VENUE_OPEN_ORDER_CAPACITY} from '../../shared/grid-capacity';
import type {ExactGridRequest} from './launch-storage-core';
import type {GridVenueOrder} from './order-identity';
import Decimal from 'decimal.js';

export interface RetainedGridSlot {
  bot_id:string; slots:number; state:string; venue_order_id:string|null; exact_request:ExactGridRequest;
}
/** A confirmed claim is covered by inventory only when its exact live venue identity agrees. */
export function gridClaimPlacementBudget(botId:string, account:string, availableSlots:number,
  retained:RetainedGridSlot[], observation:{account:string;inventoryComplete:boolean;orders:GridVenueOrder[]}|null) {
  if(observation&&(!observation.inventoryComplete||observation.account!==account))return 0;
  const live=observation?.orders.filter(o=>['open','partially_filled'].includes(o.status))??[];
  if(new Set(live.map(o=>o.orderId)).size!==live.length)return 0;
  let pending=0,ordinary=0;
  for(const claim of retained){
    if(!Number.isSafeInteger(claim.slots)||claim.slots<0)return 0;
    if(claim.bot_id===botId)ordinary+=claim.slots;
    const r=claim.exact_request;
    const covered=claim.state==='confirmed'&&r.account===account&&r.kind==='limit'&&live.some(o=>
      o.orderId===claim.venue_order_id&&o.clientOrderId===r.data.client_order_id&&o.symbol===r.data.symbol
      &&o.side===(r.data.side==='bid'?'long':'short')&&o.reduceOnly===r.data.reduce_only
      &&new Decimal(o.price).eq(String(r.data.price))&&new Decimal(o.amount).eq(String(r.data.amount)));
    if(!covered)pending+=claim.slots;
  }
  // Fresh full-account inventory overrides a caller's free-slot estimate. All other orders count too.
  const available=observation?Math.max(0,VENUE_OPEN_ORDER_CAPACITY-live.length):Math.min(availableSlots,VENUE_OPEN_ORDER_CAPACITY);
  return gridPlacementBudget(ordinary,available,pending);
}
