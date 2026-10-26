import {AsyncLocalStorage} from 'node:async_hooks';
import {mainQuota} from './main-quota';
import {verifyMainSend} from './main-quota-guard';
import {mainGridQuotaAccount,mainGridQuotaRequest} from './main-quota-scope';
import {providerRequestCost} from '../grid-bot/provider-request-cost';

export interface RequestReservation {release():Promise<void>}
export interface RequestBudget {
  reserve(units:number):Promise<RequestReservation>;
  beforeSend():Promise<()=>void>;
}
const budgets=new WeakMap<typeof fetch,RequestBudget>();
const bursts=new AsyncLocalStorage<{fetcher:typeof fetch;expiresAt:number;remaining:Map<string,{count:number;cost:number}>}>();
export function installRequestBudget(fetcher:typeof fetch,budget:RequestBudget){budgets.set(fetcher,budget);}
export function hasRequestBudget(fetcher:typeof fetch){return budgets.has(fetcher);}
export function requestBudget(fetcher:typeof fetch,master:string):RequestBudget {
  const known=budgets.get(fetcher);if(known)return known;
  return {
    async reserve(units){
      if(!mainGridQuotaAccount(master)||process.env.GRID_REMOTE_WORKER_ENABLED!=='true'||process.env.QV_PROCESS_ROLE==='grid-worker')return {release:async()=>{}};
      const assert=await verifyMainSend();assert();
      const release=mainQuota.reserve('pacifica_rest',units);
      return {release:async()=>{release();}};
    },
    beforeSend:()=>mainGridQuotaAccount(master)?verifyMainSend():Promise.resolve(()=>{}),
  };
}
export function withinRequestBurst<T>(fetcher:typeof fetch,requests:readonly {method:string;url:string;cost?:number}[],work:()=>Promise<T>):Promise<T>{
  const remaining=new Map<string,{count:number;cost:number}>();
  for(const r of requests){const k=r.method+' '+r.url;remaining.set(k,{count:(remaining.get(k)?.count??0)+1,cost:r.cost??providerRequestCost(r.method,r.url)});}
  return bursts.run({fetcher,expiresAt:Date.now()+5000,remaining},work);
}
export function assertRequestBurstCurrent(){const b=bursts.getStore();if(b&&Date.now()>=b.expiresAt)throw Error('GRID_BURST_EXPIRED');}
export function hasRequestBurst(fetcher:typeof fetch,method:string,url:string):boolean{
  const b=bursts.getStore();return !!b&&b.fetcher===fetcher&&(b.remaining.get(method+' '+url)?.count??0)>0;
}
/** One use, exact method and URL, including account/query; retries never reuse a charge. */
export function consumeRequestBurst(fetcher:typeof fetch,method:string,url:string):boolean{
  const b=bursts.getStore(),key=method+' '+url;
  if(!b||b.fetcher!==fetcher||!(b.remaining.get(key)?.count??0))return false;
  assertRequestBurstCurrent();
  const permit=b.remaining.get(key)!;
  if(providerRequestCost(method,url)>permit.cost)throw Error('GRID_BURST_COST_CHANGED');
  permit.count--;return true;
}
export async function beforeMainRequest(fetcher:typeof fetch,url:string,init:RequestInit,master?:string){
  if(hasRequestBudget(fetcher))return ()=>{};
  if(!mainGridQuotaAccount(master)&&!mainGridQuotaRequest(url,init))return ()=>{};
  const assert=await verifyMainSend();assert();
  if(process.env.GRID_REMOTE_WORKER_ENABLED==='true'&&process.env.QV_PROCESS_ROLE!=='grid-worker')
    mainQuota.debit('pacifica_rest',providerRequestCost(init.method??'GET',url));
  return assert;
}
