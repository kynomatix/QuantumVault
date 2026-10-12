import {GridLaunchReads} from './launch-reads';
import {GridNumber} from './pnl';
import {parseGridVenueOrders,isGridClientOrderId} from './order-identity';
import type {GridHistoryWindow,GridObservation,GridTrade} from './reconciliation';
const id=(v:unknown)=>typeof v==='string'&&/^[1-9]\d*$/.test(v)&&v.trim()===v?v:Number.isSafeInteger(v)&&(v as number)>0?String(v):null;
const exact=(v:unknown,positive=false)=>{if(typeof v!=='string')throw Error('Inexact venue decimal');const x=GridNumber.read(v);if(positive&&x.n<=0n)throw Error('Nonpositive venue decimal');return v;};
function envelope(v:unknown):{data:Record<string,unknown>[];has_more?:boolean;next_cursor?:string|null}{
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
  constructor(private reads:Pick<GridLaunchReads,'json'>,private safeWindow:(input:{account:string;from:number;through:number;observedAt:number})=>Promise<GridHistoryWindow|null>=async()=>null){}
  private async pages(master:string,path:string,params:Record<string,string>,signal:AbortSignal){
    const rows:Record<string,unknown>[]=[],cursors=new Set<string>();let cursor:string|undefined;
    for(let page=0;page<100;page++){
      signal.throwIfAborted();const r=envelope(await this.reads.json(master,path,{...params,limit:'100',...(cursor?{cursor}:{})},signal));
      if(typeof r.has_more!=='boolean'||(r.has_more&&(typeof r.next_cursor!=='string'||!r.next_cursor)))throw Error('Missing paging authority');rows.push(...r.data);
      if(!r.has_more)return rows;cursor=r.next_cursor!;if(cursors.has(cursor))throw Error('Repeated history cursor');cursors.add(cursor);
    }throw Error('Grid history page bound exceeded');
  }
  async observe(input:{account:string;masterAccount:string;symbol:string;from:number;through:number},signal:AbortSignal):Promise<GridObservation>{
    const {account,masterAccount:master,symbol,from,through}=input;
    if(!Number.isSafeInteger(from)||!Number.isSafeInteger(through)||from<0||through<from)throw Error('Invalid history interval');
    const params={account,symbol,start_time:String(from),end_time:String(through)};
    const trades=parseGridTrades(await this.pages(master,'/trades/history',params,signal));
    const history=parseGridVenueOrders(await this.pages(master,'/orders/history',params,signal),true);
    const open=envelope(await this.reads.json(master,'/orders',{account},signal));
    if(open.has_more===true)throw Error('Incomplete open orders');
    const live=parseGridVenueOrders(open.data),positions=envelope(await this.reads.json(master,'/positions',{account},signal));
    if(positions.has_more===true)throw Error('Incomplete positions');
    const matches=positions.data.filter(p=>p.symbol===symbol);if(matches.length>1)throw Error('Ambiguous position');
    const p=matches[0];let position:GridObservation['position']=null;
    // An omitted row is unavailable. It is never converted into a flat position.
    if(p){if(!['bid','ask'].includes(p.side as string))throw Error('Unknown position direction');position={direction:p.side==='bid'?'long':'short',size:exact(p.amount)};}
    const observedAt=Date.now(),safe=await this.safeWindow({account,from,through,observedAt});
    if(safe&&(safe.from!==from||safe.through>through))throw Error('History authority window mismatch');
    const liveIds=new Set(live.map(o=>o.orderId));
    return {account,symbol,observedAt,trades,orders:[...history.filter(o=>!liveIds.has(o.orderId)),...live],position,inventoryComplete:true,history:safe,mark:null};
  }
}
