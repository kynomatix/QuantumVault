import {GridLaunchReads} from './launch-reads';
import {GridNumber} from './pnl';
import {parseGridVenueOrders,isGridClientOrderId} from './order-identity';
import type {GridHistoryWindow,GridObservation,GridTrade} from './reconciliation';
import {GRID_HISTORY_PUBLICATION_LAG_MS,gridStableHistoryCut,gridLastId} from './history-safety';
import {readGridMargin} from './margin';
import {gridRecyclerGate} from './runtime-policy';
const id=(v:unknown)=>typeof v==='string'&&/^[1-9]\d*$/.test(v)&&v.trim()===v?v:Number.isSafeInteger(v)&&(v as number)>0?String(v):null;
const exact=(v:unknown,positive=false)=>{if(typeof v!=='string')throw Error('Inexact venue decimal');const x=GridNumber.read(v);if(positive&&x.n<=0n)throw Error('Nonpositive venue decimal');return v;};
function envelope(v:unknown):{data:Record<string,unknown>[];has_more?:boolean;next_cursor?:string|null}&Record<string,unknown>{
  const r=v as Record<string,unknown>;if(!r||r.success!==true||!Array.isArray(r.data)||r.data.some(x=>!x||typeof x!=='object'||Array.isArray(x)))throw Error('Grid history unavailable');
  return r as ReturnType<typeof envelope>;
}
export function parseGridTrades(rows:Record<string,unknown>[]):GridTrade[]{return rows.map(r=>{
  const tradeId=id(r.history_id),orderId=id(r.order_id);
  if(!tradeId||!orderId||typeof r.symbol!=='string'||!r.symbol||!['open_long','open_short','close_long','close_short'].includes(r.side as string)
    ||!['fulfill_maker','fulfill_taker'].includes(r.event_type as string)||r.cause!=='normal'||!Number.isSafeInteger(r.created_at)||(r.created_at as number)<0
    ||(r.client_order_id!=null&&!isGridClientOrderId(r.client_order_id)))throw Error('Unsupported Grid trade fact');
  return {tradeId,orderId,clientOrderId:r.client_order_id as string??null,symbol:r.symbol,side:r.side as GridTrade['side'],time:r.created_at as number,size:exact(r.amount,true),price:exact(r.price,true),fee:exact(r.fee)};
});}
export class GridMonitorReads {
  constructor(private reads:Pick<GridLaunchReads,'json'>,private safeWindow?:(input:{account:string;from:number;through:number;observedAt:number})=>Promise<GridHistoryWindow|null>){}
  async mark(master:string,symbol:string,signal:AbortSignal):Promise<GridObservation['mark']>{
    try{const prices=envelope(await this.reads.json(master,'/info/prices',{},signal)).data.filter(p=>p.symbol===symbol);
      if(prices.length===1){const p=prices[0],now=Date.now();if(Number.isSafeInteger(p.timestamp)&&(p.timestamp as number)<=now&&now-(p.timestamp as number)<=5000)return {price:exact(p.mark,true),observedAt:p.timestamp as number};}
    }catch{signal.throwIfAborted();}return null;
  }
  private async pages(master:string,path:string,params:Record<string,string>,signal:AbortSignal){
    const rows:Record<string,unknown>[]=[],cursors=new Set<string>();let cursor:string|undefined;
    for(let page=0;page<100;page++){
      signal.throwIfAborted();const r=envelope(await this.reads.json(master,path,{...params,limit:'100',...(cursor?{cursor}:{})},signal));
      if(r.sequence_gap===true||r.partial===true||r.complete===false||typeof r.has_more!=='boolean'||(r.has_more&&(typeof r.next_cursor!=='string'||!r.next_cursor||r.data.length===0))||!r.has_more&&r.next_cursor!=null)throw Error('Missing or partial paging authority');rows.push(...r.data);
      if(!r.has_more)return rows;cursor=r.next_cursor!;if(cursors.has(cursor))throw Error('Repeated history cursor');cursors.add(cursor);
    }throw Error('Grid history page bound exceeded');
  }
  async observe(input:{account:string;masterAccount:string;symbol:string;from:number;through:number},signal:AbortSignal):Promise<GridObservation>{
    const {account,masterAccount:master,symbol,from,through}=input;
    if(!Number.isSafeInteger(from)||!Number.isSafeInteger(through)||from<0||through<from)throw Error('Invalid history interval');
    signal.throwIfAborted();
    const before=[envelope(await this.reads.json(master,'/orders',{account},signal)),envelope(await this.reads.json(master,'/positions',{account},signal))];
    const params={account,symbol,start_time:String(from),end_time:String(through)};
    const trades=parseGridTrades(await this.pages(master,'/trades/history',params,signal));
    const history=parseGridVenueOrders(await this.pages(master,'/orders/history',{account},signal),true);
    const open=envelope(await this.reads.json(master,'/orders',{account},signal));
    if(open.has_more===true)throw Error('Incomplete open orders');
    const live=parseGridVenueOrders(open.data),positions=envelope(await this.reads.json(master,'/positions',{account},signal));
    if(positions.has_more===true)throw Error('Incomplete positions');
    const matches=positions.data.filter(p=>p.symbol===symbol);if(matches.length>1)throw Error('Ambiguous position');
    const p=matches[0];let position:GridObservation['position']=null;
    // Absence alone is not flatness. A fresh explicit full-account zero count can prove it.
    if(p){if(!['bid','ask'].includes(p.side as string))throw Error('Unknown position direction');position={direction:p.side==='bid'?'long':'short',size:exact(p.amount)};}
    else if(positions.data.length===0){try{
      const r=await this.reads.json(master,'/account',{account},signal) as {success?:boolean;data?:{positions_count?:number;updated_at?:number}};
      const at=r?.data?.updated_at,now=Date.now();
      if(r?.success===true&&r.data?.positions_count===0&&Number.isSafeInteger(at)&&at!<=now&&now-at!<=5000)position={direction:'long',size:'0'};
    }catch{signal.throwIfAborted();}}
    const observedAt=Date.now(),lastId=gridStableHistoryCut(before,[open,positions],symbol);
    // Full bounded replay + an unchanged per-symbol LI cut is the inferred authority.
    // The 120-second publication allowance requires confirmation during canary monitoring.
    const safeThrough=Math.min(through,observedAt-GRID_HISTORY_PUBLICATION_LAG_MS);
    const safe=this.safeWindow?await this.safeWindow({account,from,through,observedAt}):
      lastId!==null&&safeThrough>=from?{from,through:safeThrough,inclusive:true as const,publicationLagMs:GRID_HISTORY_PUBLICATION_LAG_MS,source:'pacifica_full_replay_stable_last_id',lastId,lastIds:{orders:gridLastId(open.last_order_id,symbol)!,positions:gridLastId(positions.last_order_id,symbol)!}}:null;
    if(safe&&(safe.from!==from||safe.through>through))throw Error('History authority window mismatch');
    const liveIds=new Set(live.map(o=>o.orderId));
    // Mark failure must not discard authoritative order recovery. History paging is NOT a safeWindow authority.
    const mark=await this.mark(master,symbol,signal);
    let qualification:GridObservation['qualification']=null;
    if(safe)try{
      const started=Date.now(),margin=await readGridMargin(this.reads,{kind:'limit',botId:'qualification',account,masterAccount:master,path:'/orders/create',operationType:'create_order',timestamp:started,expiryMs:5000,data:{symbol,reduce_only:false},authority:{}});
      const info=envelope(await this.reads.json(master,'/info',{},signal)).data.filter(x=>x.symbol===symbol);
      const now=Date.now();
      if(margin&&[margin.observedAt,margin.accountUpdatedAt].every(at=>Number.isSafeInteger(at)&&at<=now&&now-at<=5000)&&info.length===1&&Number.isSafeInteger(info[0].max_leverage)&&(info[0].max_leverage as number)>=1){const m=info[0];
        qualification={observedAt:started,leverage:margin.leverage,maxLeverage:String(m.max_leverage),feeRate:margin.feeRate,minOrderSize:exact(m.min_order_size,true),lotSize:exact(m.lot_size,true),tickSize:exact(m.tick_size,true),
          recycler:gridRecyclerGate({reuse:process.env.REUSE_ON_CREATE,recycle:process.env.RECYCLE_ON_DELETE,deployment:process.env.REPLIT_DEPLOYMENT??'',expectedDeployment:process.env.GRID_RECYCLER_DEPLOYMENT??'',checkedAt:Date.now()},Date.now())};
      }
    }catch{signal.throwIfAborted();}
    signal.throwIfAborted();
    return {account,symbol,observedAt,trades,orders:[...history.filter(o=>!liveIds.has(o.orderId)),...live],position,inventoryComplete:true,history:safe,mark,qualification};
  }
}
