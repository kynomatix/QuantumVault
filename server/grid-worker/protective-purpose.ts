import {AsyncLocalStorage} from 'node:async_hooks';

export type WorkerRequestPurpose='ordinary'|'protective';
const purpose=new AsyncLocalStorage<WorkerRequestPurpose>();
/** The scope only permits the narrow read/cancel/reduce-only close inventory below. */
export function withProtectivePurpose<T>(work:()=>T):T{return purpose.run('protective',work);}
export function protectiveQuotaRequest(url:URL,method:string,body:unknown):boolean{
  if(purpose.getStore()!=='protective'||url.hostname!=='api.pacifica.fi')return false;
  if(method==='GET')return ['/api/v1/positions','/api/v1/orders','/api/v1/info/prices'].includes(url.pathname);
  if(method!=='POST'||typeof body!=='string')return false;
  let payload:unknown;try{payload=JSON.parse(body);}catch{return false;}
  if(!payload||typeof payload!=='object')return false;
  const p=payload as Record<string,unknown>;
  if(url.pathname==='/api/v1/orders/cancel')return typeof p.order_id==='string'||typeof p.order_id==='number';
  return url.pathname==='/api/v1/orders/create_market'&&p.reduce_only===true;
}
