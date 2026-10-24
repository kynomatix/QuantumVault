import Decimal from 'decimal.js';
import {requestDigest,type ExactGridRequest,type DurableGridOperation} from './launch-storage-core';
import type {GridTransferEvidence,GridTransferProof} from './transfer-evidence';
import type {GridReconciliation} from './execution';
import type {GridVenueOrder} from './order-identity';

/** The accepted C4 proof is deliberately narrower than a general transfer lookup. */
export function reconcileGridTransfer(r:ExactGridRequest,e:GridTransferEvidence|null,
  context:{reused:boolean;operations:DurableGridOperation[]},now:number):GridReconciliation{
  const unknown={state:'unknown' as const};
  try{
    const end=r.timestamp+r.expiryMs,amount=typeof r.data.amount==='string'?new Decimal(r.data.amount):null;
    if(!['fund','sweep'].includes(r.kind)||!Number.isSafeInteger(r.timestamp)||r.timestamp<0||!Number.isSafeInteger(r.expiryMs)||r.expiryMs<=0||r.expiryMs>15000
      ||!Number.isSafeInteger(end)||now<=end||!e||e.complete!==true||e.account!==r.account||e.masterAccount!==r.masterAccount||r.account===r.masterAccount
      ||r.path!=='/account/subaccount/transfer'||r.operationType!=='transfer_funds'||typeof r.data.idempotency_key!=='string'||!r.data.idempotency_key
      ||!amount||!amount.isFinite()||!amount.gt(0)||r.data.to_account!==(r.kind==='fund'?r.account:r.masterAccount)
      ||![e.startedAt,e.observedAt,e.balanceAt].every(t=>Number.isSafeInteger(t)&&t>end&&t<=now&&now-t<5000)
      ||e.observedAt<e.startedAt)return unknown;
    const digest=requestDigest(r),current=context.operations.filter(o=>o.exact_request_digest===digest&&['submitted','unconfirmed'].includes(o.state));
    if(current.length!==1)return unknown;
    for(const op of context.operations){
      const q=op.exact_request;
      if(!q||q.botId!==r.botId||q.account!==r.account||q.masterAccount!==r.masterAccount||requestDigest(q)!==op.exact_request_digest)return unknown;
      if(op.id===current[0].id)continue;
      if(['fund','sweep'].includes(q.kind)&&q.data.idempotency_key===r.data.idempotency_key)return unknown;
      if(['prepared','submitted','unconfirmed'].includes(op.state))return unknown;
      if(q.kind==='fund'&&op.state==='failed'&&op.failure_classification==='expected_rejection'){
        if(op.transfer_recovery?.version!==1||op.transfer_recovery.state!=='not_landed'||op.transfer_recovery.requestDigest!==op.exact_request_digest)return unknown;
      }
    }
    let from:number;
    if(r.kind==='fund'){
      const creates=context.operations.filter(o=>o.exact_request.kind==='create'&&o.state==='confirmed');
      if(context.reused||creates.length!==1||!e.ownedAccounts||e.ownedAccounts.filter(a=>a===r.account).length!==1)return unknown;
      from=creates[0].exact_request.timestamp;if(from>r.timestamp)return unknown;
      if(context.operations.some(o=>o.id!==current[0].id&&o.exact_request.kind!=='create'
        &&!(o.state==='failed'&&(o.submitted_at===null&&o.failure_classification==='policy'
          ||o.exact_request.kind==='fund'&&o.failure_classification==='expected_rejection'&&o.transfer_recovery?.state==='not_landed'))))return unknown;
    }else{
      const settlement=r.authority.settlement as Record<string,unknown>|undefined;
      if(r.authority.settlementComplete!==true||!settlement||settlement.account!==r.account||settlement.masterAccount!==r.masterAccount
        ||settlement.settlementComplete!==true||typeof settlement.balance!=='string'||!amount.eq(settlement.balance)
        ||!Number.isSafeInteger(settlement.observedAt)||(settlement.observedAt as number)>r.timestamp||r.timestamp-(settlement.observedAt as number)>=5000)return unknown;
      from=settlement.observedAt as number;
      if(context.operations.some(o=>o.id!==current[0].id&&o.exact_request.timestamp>=from&&o.state==='confirmed'))return unknown;
    }
    const inWindow=(t:number)=>t>=r.timestamp&&t<=end;
    const main=e.mainHistory.filter(x=>x.eventType==='subaccount_transfer'&&inWindow(x.createdAt)
      &&new Decimal(x.amount).eq(r.kind==='fund'?amount.negated():amount));
    const activity=e.subaccountHistory.filter(x=>r.kind==='fund'?x.createdAt>=from:x.createdAt>from);
    const landed=activity.length===1&&activity[0].eventType==='subaccount_transfer'&&inWindow(activity[0].createdAt)
      &&new Decimal(activity[0].amount).eq(r.kind==='fund'?amount:amount.negated())&&main.length===1;
    const balance=new Decimal(e.balance);
    // No venue minimum is documented: a nonzero residual cannot be guessed to be dust.
    const state=landed&&(r.kind==='fund'?balance.eq(amount):balance.isZero())?'confirmed'
      :activity.length===0&&main.length===0&&(r.kind==='fund'?balance.isZero():balance.eq(amount))?'not_landed':null;
    if(!state)return unknown;
    const transferProof:GridTransferProof={version:1,requestDigest:digest,state,evidence:{...e,subaccountHistory:activity,mainHistory:main}};
    return {state,requestDigest:digest,releaseSlot:true,transferProof};
  }catch{return unknown;}
}

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
