import Decimal from 'decimal.js';
import {createHash} from 'node:crypto';
import type {GridLaunchReads} from '../grid-bot/launch-reads';
import {balanceDecimal,type OwnedBalanceEvent} from './balance-history';
import type {LedgerFill} from './balance-ledger';
const D=Decimal.clone({precision:200});
const numericId=(v:unknown)=>typeof v==='string'&&/^[1-9][0-9]*$/.test(v)?v:Number.isSafeInteger(v)&&Number(v)>0?String(v):null;
export async function balancePages(reads:Pick<GridLaunchReads,'json'>,master:string,account:string,path:string,signal:AbortSignal){
  const rows:Record<string,any>[]=[],seen=new Set<string>();let cursor:string|undefined;
  for(let page=0;page<100;page++){
    const r=await reads.json(master,path,{account,limit:'100',...(cursor?{cursor}:{})},signal) as Record<string,any>;
    if(r?.success!==true||r.error!=null||!Array.isArray(r.data)||r.data.length>100||r.data.some((v:unknown)=>!v||typeof v!=='object'||Array.isArray(v))
      ||typeof r.has_more!=='boolean'||r.partial===true||r.complete===false||r.sequence_gap===true)throw Error('GRID_BALANCE_TRADE_PAGE');
    rows.push(...r.data);
    if(!r.has_more){if(r.next_cursor!=null)throw Error('GRID_BALANCE_TRADE_CURSOR');return rows;}
    if(!r.data.length||typeof r.next_cursor!=='string'||!r.next_cursor||seen.has(r.next_cursor))throw Error('GRID_BALANCE_TRADE_CURSOR');
    cursor=r.next_cursor;seen.add(cursor!);
  }
  throw Error('GRID_BALANCE_TRADE_BOUND');
}
/** Exact own fill economics and order lineage, one-to-one across all three products. */
export function matchBalanceTrades(account:string,trades:Record<string,any>[],funding:Record<string,any>[],fills:LedgerFill[]):OwnedBalanceEvent[]{
  const events:OwnedBalanceEvent[]=[],used=new Set<string>(),seen=new Set<string>();
  const verified=new Map<string,{r:Record<string,any>;own:LedgerFill}>();
  for(const r of trades){
    const order=numericId(r.order_id),id=numericId(r.history_id);
    if(!order||!id||seen.has(id)||!Number.isSafeInteger(r.created_at)||r.created_at<0||typeof r.symbol!=='string'
      ||!['open_long','close_long','open_short','close_short'].includes(r.side)
      ||!['fulfill_maker','fulfill_taker'].includes(r.event_type)||r.cause!=='normal')throw Error('GRID_BALANCE_TRADE');
    seen.add(id);for(const field of ['amount','price','fee','pnl'])balanceDecimal(r[field]);
    const candidates=fills.filter(f=>!used.has(f.id)&&f.orderId===order&&(f.fillId===null||f.fillId===id)&&f.symbol===r.symbol
      &&new D(balanceDecimal(f.size)).eq(r.amount)&&new D(balanceDecimal(f.price)).eq(r.price)&&new D(balanceDecimal(f.fee)).eq(r.fee));
    const own=candidates.length===1?candidates[0]:undefined;
    if(own){used.add(own.id);verified.set(id,{r,own});}
    events.push({id:'trade:'+id,account,kind:'trade',amount:new D(r.pnl).minus(r.fee).toFixed(),earliest:r.created_at,latest:r.created_at,
      publicationRequired:false,...(own?{orderId:order,fillId:own.id}:{})});
  }
  // A local exact fill missing from the venue replay also prevents completeness.
  for(const f of fills)if(!used.has(f.id))events.push({id:'unmatched:'+f.id,account,kind:'trade',amount:'0',earliest:0,latest:0,publicationRequired:false});
  const fundingIds=new Set<string>();
  for(const r of funding){
    const id=numericId(r.history_id);
    if(!id||fundingIds.has(id)||typeof r.symbol!=='string'||!['bid','ask'].includes(r.side)||!Number.isSafeInteger(r.created_at)||r.created_at<0)throw Error('GRID_BALANCE_FUNDING');
    fundingIds.add(id);for(const f of ['amount','payout','rate'])balanceDecimal(r[f]);
    const prior=trades.filter(t=>t.symbol===r.symbol&&t.created_at<r.created_at);
    let position=new D(0);for(const t of prior)position=position.plus(new D(t.amount).mul(['open_long','close_short'].includes(t.side)?1:-1));
    const own=prior.length>0&&prior.every(t=>verified.has(String(t.history_id)))&&position.abs().eq(r.amount)
      &&(position.gt(0)?r.side==='bid':position.lt(0)&&r.side==='ask')&&!trades.some(t=>t.symbol===r.symbol&&t.created_at===r.created_at);
    const lineageDigest=createHash('sha256').update(JSON.stringify(prior.map(t=>String(t.history_id)))).digest('hex');
    events.push({id:'funding:'+id,account,kind:'funding',amount:r.payout,earliest:r.created_at,latest:r.created_at,publicationRequired:false,
      ...(own?{orderId:'funding-position:'+lineageDigest,fillId:'funding-fills:'+lineageDigest}:{})});
  }
  return events;
}
