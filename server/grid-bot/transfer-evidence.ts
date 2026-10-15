import Decimal from 'decimal.js';
import type {GridLaunchReads} from './launch-reads';
import type {ExactGridRequest} from './launch-storage';

export interface GridBalanceEvent {amount:string;eventType:string;createdAt:number}
export interface GridTransferEvidence {
  account:string;masterAccount:string;complete:boolean;startedAt:number;observedAt:number;balanceAt:number;balance:string;
  ownedAccounts:string[]|null;subaccountHistory:GridBalanceEvent[];mainHistory:GridBalanceEvent[];
}
export interface GridTransferProof {
  version:1;requestDigest:string;state:'confirmed'|'not_landed';evidence:GridTransferEvidence;
}
const object=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
const decimal=(v:unknown):v is string=>typeof v==='string'&&/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v);
const fresh=(v:unknown,start:number,now:number):v is number=>Number.isSafeInteger(v)&&(v as number)>=start&&(v as number)<=now&&now-(v as number)<5000;
function envelope(raw:unknown,account:string){
  const r=object(raw);if(!r||r.success!==true||r.error!==null||(r.partial!==undefined&&r.partial!==false)||(r.complete!==undefined&&r.complete!==true)
    ||(r.account!==undefined&&r.account!==account))throw Error('Incomplete transfer evidence');return r;
}
function complete(r:Record<string,unknown>){
  if((r.partial!==undefined&&r.partial!==false)||(r.complete!==undefined&&r.complete!==true)||(r.has_more!==undefined&&r.has_more!==false)||r.next_cursor!=null)throw Error('Partial transfer evidence');
}
function accountBalance(raw:unknown,account:string,start:number,now:number){
  const r=envelope(raw,account),d=object(r.data);complete(r);
  if(!d)throw Error('Missing transfer account');complete(d);
  if(r.updated_at!==undefined&&!fresh(r.updated_at,start,now))throw Error('Stale transfer account');
  if((d.account!==undefined&&d.account!==account)||d.subaccount_id!=null||!fresh(d.updated_at,start,now)
    ||!['balance','available_to_withdraw','account_equity','pending_balance','pending_interest','spot_collateral','spot_market_value','total_margin_used'].every(k=>decimal(d[k]))
    ||!['pending_balance','pending_interest','spot_collateral','spot_market_value','total_margin_used'].every(k=>new Decimal(d[k] as string).isZero())
    ||!['positions_count','orders_count','stop_orders_count'].every(k=>d[k]===0)||!Array.isArray(d.spot_balances)||d.spot_balances.length!==0
    ||!new Decimal(d.balance as string).eq(d.account_equity as string)||!new Decimal(d.balance as string).eq(d.available_to_withdraw as string))throw Error('Unsettled transfer account');
  return {balance:d.balance as string,at:d.updated_at as number};
}
function emptyInventory(raw:unknown,account:string,start:number,now:number){
  const r=envelope(raw,account);complete(r);
  if(r.updated_at!==undefined&&!fresh(r.updated_at,start,now))throw Error('Stale transfer inventory');
  if(!Array.isArray(r.data)||r.data.length!==0)throw Error('Transfer account has activity');
}
/** All pages are required. Never mistake a missing page, trade, or failed read for zero. */
async function balanceHistory(reads:Pick<GridLaunchReads,'json'>,r:ExactGridRequest,account:string,signal:AbortSignal,start:number,now:()=>number){
  const rows:GridBalanceEvent[]=[],seen=new Set<string>();let cursor:string|undefined;
  for(let page=0;page<20;page++){
    signal.throwIfAborted();const raw=envelope(await reads.json(r.masterAccount,'/account/balance/history',
      {account,limit:'100',include_trades:'true',...(cursor?{cursor}:{})},signal),account);
    if(raw.partial===true||raw.complete===false||!Array.isArray(raw.data)||typeof raw.has_more!=='boolean')throw Error('Incomplete balance history');
    if(raw.updated_at!==undefined&&!fresh(raw.updated_at,start,now()))throw Error('Stale balance history');
    for(const value of raw.data){const row=object(value);
      if(!row||typeof row.amount!=='string'||!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(row.amount)||typeof row.event_type!=='string'||!row.event_type
        ||!Number.isSafeInteger(row.created_at)||(row.created_at as number)<0||(row.created_at as number)>now()
        ||(row.account!==undefined&&row.account!==account))throw Error('Invalid balance event');
      rows.push({amount:row.amount,eventType:row.event_type,createdAt:row.created_at as number});
    }
    if(!raw.has_more){if(raw.next_cursor!=null)throw Error('Conflicting history cursor');return rows;}
    if(typeof raw.next_cursor!=='string'||!raw.next_cursor||seen.has(raw.next_cursor)||raw.data.length===0)throw Error('Invalid history cursor');
    seen.add(raw.next_cursor);cursor=raw.next_cursor;
  }
  throw Error('Balance history exceeds complete-read budget');
}
/** Called only after expiry; no cached monitor observation enters a balance proof. */
export async function readGridTransferEvidence(r:ExactGridRequest,reads:Pick<GridLaunchReads,'json'>,inventory:()=>Promise<string[]|null>,
  signal:AbortSignal,now:()=>number=Date.now):Promise<GridTransferEvidence|null>{
  const startedAt=now();
  if(!['fund','sweep'].includes(r.kind)||!Number.isSafeInteger(r.timestamp)||!Number.isSafeInteger(r.expiryMs)||r.expiryMs<=0
    ||!Number.isSafeInteger(r.timestamp+r.expiryMs)||startedAt<=r.timestamp+r.expiryMs)return null;
  try{
    const ownedAccounts=r.kind==='fund'?await inventory():null;
    const get=(path:string)=>reads.json(r.masterAccount,path,{account:r.account},signal);
    const before=accountBalance(await get('/account'),r.account,r.timestamp+r.expiryMs+1,now());
    emptyInventory(await get('/orders'),r.account,startedAt,now());
    emptyInventory(await get('/positions'),r.account,startedAt,now());
    const subaccountHistory=await balanceHistory(reads,r,r.account,signal,startedAt,now);
    const mainHistory=await balanceHistory(reads,r,r.masterAccount,signal,startedAt,now);
    const after=accountBalance(await get('/account'),r.account,r.timestamp+r.expiryMs+1,now());
    signal.throwIfAborted();const observedAt=now();
    if(!fresh(startedAt,startedAt,observedAt)||!new Decimal(before.balance).eq(after.balance))return null;
    return {account:r.account,masterAccount:r.masterAccount,complete:true,startedAt,observedAt,balanceAt:Math.min(before.at,after.at),balance:after.balance,
      ownedAccounts,subaccountHistory,mainHistory};
  }catch{signal.throwIfAborted();return null;}
}
