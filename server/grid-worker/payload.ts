import Decimal from 'decimal.js';
import type {ExactGridRequest} from '../grid-bot/launch-storage-core';

const endpoints={create:['/account/subaccount/create','subaccount_confirm'],fund:['/account/subaccount/transfer','transfer_funds'],
  leverage:['/account/leverage','update_leverage'],seed:['/orders/create_market','create_market_order'],
  limit:['/orders/create','create_order'],cancel:['/orders/cancel','cancel_order'],close:['/orders/create_market','create_market_order'],sweep:['/account/subaccount/transfer','transfer_funds']} as const;
const keys={create:[],fund:['to_account','amount','idempotency_key'],sweep:['to_account','amount','idempotency_key'],leverage:['symbol','leverage'],
  seed:['symbol','amount','side','reduce_only','slippage_percent','client_order_id'],close:['symbol','amount','side','reduce_only','slippage_percent','client_order_id'],
  limit:['symbol','price','amount','side','tif','reduce_only','client_order_id'],cancel:['symbol','order_id']} as const;
function refuse():never{throw Error('GRID_PAYLOAD_REFUSED');}
function ownRecord(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return refuse();
  for(const key of Reflect.ownKeys(value)){
    if(typeof key!=='string'||['__proto__','constructor','prototype'].includes(key))return refuse();
    const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!('value' in d)||!d.enumerable)return refuse();
  }
  return value as Record<string,unknown>;
}
function positive(value:unknown):value is string{return typeof value==='string'&&value.length<=80&&/^(0|[1-9]\d*)(\.\d+)?$/.test(value)&&new Decimal(value).gt(0);}
function uuid(value:unknown){return typeof value==='string'&&/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);}
/** Reject accessors before reading them. Each outgoing field is explicitly constructed. */
export function gridPayload(r:ExactGridRequest):Record<string,unknown>{
  ownRecord(r);
  const requestKeys=['kind','botId','account','masterAccount','path','operationType','timestamp','expiryMs','data','authority'];
  if(Reflect.ownKeys(r).length!==requestKeys.length||!requestKeys.every(key=>Object.hasOwn(r,key)))return refuse();
  const d=ownRecord(r.data);ownRecord(r.authority);
  if(!Object.hasOwn(endpoints,r.kind))return refuse();const endpoint=endpoints[r.kind],expected=keys[r.kind];
  if(r.path!==endpoint[0]||r.operationType!==endpoint[1]||!r.account||!r.masterAccount||r.account===r.masterAccount
    ||!uuid(r.botId)||!Number.isSafeInteger(r.timestamp)||!Number.isSafeInteger(r.expiryMs)||r.expiryMs<1||r.expiryMs>15000
    ||Reflect.ownKeys(d).length!==expected.length||!expected.every(key=>Object.hasOwn(d,key)))return refuse();
  if(r.kind==='create')return {};
  if(r.kind==='fund'||r.kind==='sweep'){
    if(d.to_account!==(r.kind==='fund'?r.account:r.masterAccount)||!positive(d.amount)||!uuid(d.idempotency_key))return refuse();
    return {to_account:d.to_account,amount:d.amount,idempotency_key:d.idempotency_key};
  }
  if(typeof d.symbol!=='string'||! /^[A-Z0-9]+$/.test(d.symbol))return refuse();
  if(r.kind==='leverage'){
    if(!Number.isSafeInteger(d.leverage)||Number(d.leverage)<1)return refuse();return {symbol:d.symbol,leverage:d.leverage};
  }
  if(r.kind==='cancel'){
    if(!(typeof d.order_id==='string'&&/^[1-9]\d*$/.test(d.order_id)||Number.isSafeInteger(d.order_id)&&Number(d.order_id)>0))return refuse();
    return {symbol:d.symbol,order_id:d.order_id};
  }
  if(!positive(d.amount)||!['bid','ask'].includes(String(d.side))||typeof d.reduce_only!=='boolean'||!uuid(d.client_order_id))return refuse();
  if(r.kind==='limit'){
    if(!positive(d.price)||d.tif!=='ALO')return refuse();
    return {symbol:d.symbol,price:d.price,amount:d.amount,side:d.side,tif:'ALO',reduce_only:d.reduce_only,client_order_id:d.client_order_id};
  }
  if(d.reduce_only!==(r.kind==='close')||!positive(d.slippage_percent)||new Decimal(d.slippage_percent).gt('0.5'))return refuse();
  return {symbol:d.symbol,amount:d.amount,side:d.side,reduce_only:d.reduce_only,slippage_percent:d.slippage_percent,client_order_id:d.client_order_id};
}
export function validGridPayload(r:ExactGridRequest):boolean{try{gridPayload(r);return true;}catch{return false;}}

export interface PayloadAuthority {
  investment:string;leverage:number;maxLeverage:string;currentMaster:string;
  seedAmount?:string;seedSide?:'bid'|'ask';fundAlreadyUsed?:boolean;
  ownedOrder?:{orderId:string;symbol:string};
  position?:{account:string;symbol:string;size:string;side:'bid'|'ask';observedAt:number;complete:boolean};
  settlement?:{complete:boolean;amount:string;observedAt:number};
}
/** Authority is read under wallet/identity locks; no retained request can invent its own proof. */
export function authorizeGridPayload(r:ExactGridRequest,a:PayloadAuthority,now:number):void {
  const d=gridPayload(r);
  if(a.currentMaster!==r.masterAccount)throw Error(r.kind==='sweep'?'GRID_TRANSFER_REFUSED':'GRID_PAYLOAD_REFUSED');
  if(r.kind==='fund'&&(a.fundAlreadyUsed!==false||!positive(a.investment)||!new Decimal(String(d.amount)).eq(a.investment)))return refuse();
  if(r.kind==='leverage'&&(!positive(a.maxLeverage)||d.leverage!==a.leverage||new Decimal(a.maxLeverage).lt(a.leverage)))return refuse();
  if(r.kind==='seed'&&(!a.seedAmount||!positive(a.seedAmount)||!new Decimal(String(d.amount)).eq(a.seedAmount)||d.side!==a.seedSide))return refuse();
  if(r.kind==='cancel'&&(!a.ownedOrder||a.ownedOrder.orderId!==String(d.order_id)||a.ownedOrder.symbol!==d.symbol))return refuse();
  if(r.kind==='close'){
    const p=a.position;if(!p||!p.complete||p.account!==r.account||p.symbol!==d.symbol||p.side!==d.side||!positive(p.size)
      ||p.observedAt>now||now-p.observedAt>=5000||!Number.isSafeInteger(p.observedAt)||new Decimal(String(d.amount)).gt(p.size))return refuse();
  }
  if(r.kind==='sweep'){
    const s=a.settlement;if(!s||!s.complete||!Number.isSafeInteger(s.observedAt)||s.observedAt>now||now-s.observedAt>=5000
      ||!positive(s.amount)||!new Decimal(String(d.amount)).eq(s.amount))throw Error('GRID_TRANSFER_REFUSED');
  }
}
