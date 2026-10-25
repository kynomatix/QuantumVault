import {createHash} from 'node:crypto';
import DecimalBase from 'decimal.js';
import type {GridLaunchReads} from '../grid-bot/launch-reads';

const D=DecimalBase.clone({precision:200});
export const OWN_TRANSFER_PUBLICATION_DEADLINE_MS=10*60_000;
export const BALANCE_REPLAY_PAGE_LIMIT=100;
export interface BalanceRow {amount:string;balance:string;pending_balance:string;event_type:string;created_at:number}
export interface BalanceState {balance:string;pending_balance:string;observedAt:number}
export interface OwnedBalanceEvent {
  id:string;account:string;kind:'subaccount_transfer'|'withdraw'|'trade'|'funding';amount:string;
  earliest:number;latest:number;publicationRequired:boolean;
  /** A trade/funding explanation must carry both retained order and fill lineage. */
  orderId?:string;fillId?:string;
}
export interface BalanceProof {complete:boolean;observedAt:number;evidenceDigest:string;unexplained:string[];unpublished:string[]}
const types=new Set(['deposit','deposit_release','withdraw','trade','market_liquidation','backstop_liquidation','adl_liquidation','subaccount_transfer','funding','payout']);
export function balanceDecimal(raw:unknown):string {
  if(typeof raw!=='string'||raw.length>80||! /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)||!new D(raw).isFinite())throw Error('GRID_BALANCE_DECIMAL');
  return raw;
}
export function parseBalanceRow(raw:unknown):BalanceRow {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('GRID_BALANCE_ROW');
  const r=raw as Record<string,unknown>;
  if(Object.keys(r).sort().join(',')!=='amount,balance,created_at,event_type,pending_balance'||typeof r.event_type!=='string'
    ||!Number.isSafeInteger(r.created_at)||(r.created_at as number)<0)throw Error('GRID_BALANCE_ROW');
  return {amount:balanceDecimal(r.amount),balance:balanceDecimal(r.balance),pending_balance:balanceDecimal(r.pending_balance),event_type:r.event_type,created_at:r.created_at as number};
}
const rowIdentity=(r:BalanceRow)=>createHash('sha256').update(JSON.stringify(r)).digest('hex');
/** Full replay from the zero-balance head, never a stored cursor or newest-row age. */
export function proveBalanceHistory(account:string,rows:readonly BalanceRow[],before:BalanceState,after:BalanceState,
  owned:readonly OwnedBalanceEvent[],now=Date.now()):BalanceProof {
  const unexplained:string[]=[],unpublished:string[]=[],used=new Set<string>(),identities=new Set<string>();
  let complete=Number.isSafeInteger(now)&&before.observedAt<=after.observedAt&&after.observedAt<=now&&now-before.observedAt<5000
    &&new D(balanceDecimal(before.balance)).eq(balanceDecimal(after.balance))
    &&new D(balanceDecimal(before.pending_balance)).eq(balanceDecimal(after.pending_balance));
  // The public schema does not define the pending-deposit transition algebra.
  // A nonzero pending value or release cannot be promoted into completeness.
  if(!new D(before.pending_balance).isZero()||!new D(after.pending_balance).isZero())complete=false;
  const descending=rows.length>1&&rows[0].created_at>rows[rows.length-1].created_at;
  const first=rows[descending?rows.length-1:0],last=rows[descending?0:rows.length-1];
  if(first&&!new D(first.balance).eq(first.amount))complete=false;
  if(!new D(last?.balance??'0').eq(after.balance))complete=false;
  for(let i=0;i<rows.length;i++){
    const r=rows[i],identity=rowIdentity(r);
    if(identities.has(identity)||!types.has(r.event_type)||r.created_at>before.observedAt||!new D(r.pending_balance).isZero()
      ||r.event_type==='deposit_release')complete=false;
    identities.add(identity);
    if(i){const previous=rows[i-1];
      if(descending?(r.created_at>previous.created_at||!new D(r.balance).plus(previous.amount).eq(previous.balance))
        :(r.created_at<previous.created_at||!new D(previous.balance).plus(r.amount).eq(r.balance)))complete=false;
    }
    const candidates=owned.filter(e=>e.account===account&&e.kind===r.event_type&&!used.has(e.id)
      &&Number.isSafeInteger(e.earliest)&&Number.isSafeInteger(e.latest)&&e.earliest<=r.created_at&&r.created_at<=e.latest
      &&new D(balanceDecimal(e.amount)).eq(r.amount)
      &&(!['trade','funding'].includes(e.kind)||!!e.orderId&&!!e.fillId));
    // Ambiguity never selects an arbitrary ledger row. One record explains at most one row.
    if(candidates.length===1)used.add(candidates[0].id);
    if(new D(r.amount).lt(0)&&candidates.length!==1){complete=false;unexplained.push(identity);}
  }
  if(new Set(owned.map(e=>e.id)).size!==owned.length)complete=false;
  for(const e of owned.filter(e=>e.account===account&&(e.publicationRequired||e.kind==='trade'||e.kind==='funding')))if(!used.has(e.id)){
    complete=false;
    if(e.publicationRequired&&now-e.earliest>OWN_TRANSFER_PUBLICATION_DEADLINE_MS)unpublished.push(e.id);
  }
  const evidenceDigest=createHash('sha256').update(JSON.stringify({account,rows,before,after,owned,complete})).digest('hex');
  return {complete,observedAt:after.observedAt,evidenceDigest,unexplained,unpublished};
}
export async function balanceReplay(reads:Pick<GridLaunchReads,'json'>,master:string,account:string,signal:AbortSignal,
  owned:()=>Promise<readonly OwnedBalanceEvent[]>):Promise<BalanceProof> {
  const state=async():Promise<BalanceState>=>{
    const r=await reads.json(master,'/account',{account},signal) as Record<string,any>;
    if(r?.success!==true||r.error!=null||!r.data||r.partial===true||r.complete===false
      ||r.data.account!==undefined&&r.data.account!==account)throw Error('GRID_BALANCE_STATE');
    return {balance:balanceDecimal(r.data.balance),pending_balance:balanceDecimal(r.data.pending_balance),observedAt:Date.now()};
  };
  const before=await state(),rows:BalanceRow[]=[],cursors=new Set<string>();let cursor:string|undefined,ended=false;
  for(let page=0;page<BALANCE_REPLAY_PAGE_LIMIT;page++){
    signal.throwIfAborted();
    const r=await reads.json(master,'/account/balance/history',{account,limit:'100',include_trades:'true',...(cursor?{cursor}:{})},signal) as Record<string,unknown>;
    if(!r||r.success!==true||r.error!=null||!Array.isArray(r.data)||r.data.length>100||typeof r.has_more!=='boolean'
      ||r.partial===true||r.complete===false||r.sequence_gap===true)throw Error('GRID_BALANCE_PAGE');
    rows.push(...r.data.map(parseBalanceRow));
    if(!r.has_more){if(r.next_cursor!=null)throw Error('GRID_BALANCE_CURSOR');ended=true;break;}
    if(!r.data.length||typeof r.next_cursor!=='string'||!r.next_cursor||cursors.has(r.next_cursor))throw Error('GRID_BALANCE_CURSOR');
    cursor=r.next_cursor;cursors.add(cursor);
  }
  if(!ended)throw Error('GRID_BALANCE_PAGE_BOUND');
  const events=await owned(),after=await state();
  return proveBalanceHistory(account,rows,before,after,events);
}
