import Decimal from 'decimal.js';
import {requestDigest,type ExactGridRequest} from './launch-storage';
import type {GridReconciliation} from './execution';
import type {GridVenueOrder} from './order-identity';

export type LaunchEvidence=
  |{kind:'create';masterAccount:string;account:string;complete:boolean;accounts:string[];observedAt:number}
  |{kind:'leverage';account:string;symbol:string;leverage:number;observedAt:number}
  |{kind:'fund';masterAccount:string;account:string;amount:string;timestamp:number;requestTimestamp:number;terminal:boolean;transferId:string;observedAt:number}
  |{kind:'seed';account:string;complete:boolean;orders:GridVenueOrder[];observedAt:number};
/** Normalized authoritative evidence only; acknowledgements and a balance increase are insufficient. */
export function reconcileGridLaunch(r:ExactGridRequest,e:LaunchEvidence|null,now:number):GridReconciliation{
  const unknown={state:'unknown' as const};
  try{
    if(!e||e.kind!==r.kind||e.account!==r.account||!Number.isSafeInteger(e.observedAt)||e.observedAt<r.timestamp||e.observedAt>now||now-e.observedAt>5000)return unknown;
    const confirmed={state:'confirmed' as const,requestDigest:requestDigest(r),releaseSlot:true};
    if(e.kind==='create')return e.complete&&e.masterAccount===r.masterAccount&&e.accounts.filter(a=>a===r.account).length===1?confirmed:unknown;
    if(e.kind==='leverage')return e.symbol===r.data.symbol&&e.leverage===r.data.leverage?confirmed:unknown;
    if(e.kind==='fund')return e.terminal&&!!e.transferId&&e.masterAccount===r.masterAccount&&e.requestTimestamp===r.timestamp
      &&e.timestamp>=r.timestamp&&e.timestamp<=r.timestamp+r.expiryMs&&new Decimal(e.amount).eq(String(r.data.amount))?confirmed:unknown;
    if(!e.complete)return unknown;
    const matches=e.orders.filter(o=>o.clientOrderId===r.data.client_order_id);if(matches.length!==1)return unknown;const o=matches[0];
    if(o.symbol!==r.data.symbol||o.orderType!=='market'||o.reduceOnly||o.status!=='filled'||(o.side==='long'?'bid':'ask')!==r.data.side
      ||o.createdAt<r.timestamp||o.createdAt>r.timestamp+r.expiryMs||!new Decimal(o.amount).eq(String(r.data.amount))||!new Decimal(o.filledAmount).eq(o.amount))return unknown;
    return {...confirmed,orderId:o.orderId};
  }catch{return unknown;}
}
