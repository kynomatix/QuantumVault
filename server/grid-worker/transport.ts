import {providerRequestCost} from '../grid-bot/provider-request-cost';
import {consumeRequestBurst,installRequestBudget,assertRequestBurstCurrent} from './request-budget';
import {PacificaTransportAuthority} from '../protocol/pacifica/pacifica-transport';
import {guardedWorkerFetch, assertWorkerEgress, type WorkerEgress} from './egress';
import type {WorkerQuota,QuotaProvider} from './quota';
import {protectiveQuotaRequest} from './protective-purpose';
/** One choke point, including retries. There is deliberately no automatic resend. */
export function workerFetch(quota: Pick<WorkerQuota,'debit'|'rateLimited'> & Partial<Pick<WorkerQuota,'reserve'>> & {beforeSend?:()=>Promise<()=>void>}, fetcher: typeof fetch = fetch, transport?:PacificaTransportAuthority): typeof fetch {
  transport??=new PacificaTransportAuthority(undefined,'pacifica:worker-default',Date.now,true);
  const wrapped:typeof fetch=async(input, init = {}) => {
    if(typeof input!=='string'&&!(input instanceof URL))throw Error('GRID_EGRESS_REFUSED');
    const url=String(input),u=new URL(url),method=init.method??'GET';
    let request:Exclude<WorkerEgress,{kind:'websocket'}>,provider:QuotaProvider;
    if(u.hostname==='api.pacifica.fi'){
      if(method!=='GET'&&method!=='POST')throw Error('GRID_EGRESS_REFUSED');
      request={kind:'venue',method};provider='pacifica_rest';
    }else{
      if(method!=='POST'||typeof init.body!=='string')throw Error('GRID_EGRESS_REFUSED');
      request={kind:'rpc',method:'POST',rpcMethod:JSON.parse(init.body).method};
      provider=u.hostname==='mainnet.helius-rpc.com'?'rpc_primary':'rpc_backup';
    }
    assertWorkerEgress(url,request);
    const assert=await quota.beforeSend?.();
    const reserved=request.kind==='venue'&&consumeRequestBurst(wrapped,method,url);
    if(!reserved)
      await quota.debit(provider,request.kind==='venue'?providerRequestCost(method,url):1,protectiveQuotaRequest(u,method,init.body));
    assert?.();
    init.signal?.throwIfAborted();
    const bounded={...init,method,signal:init.signal?AbortSignal.any([init.signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000)};
    const send:typeof fetch=(input,options)=>{
      assert?.();assertRequestBurstCurrent();options?.signal?.throwIfAborted();
      if(request.kind==='venue'&&method==='POST'&&typeof options?.body==='string'){
        const body=JSON.parse(options.body);
        if(typeof body.timestamp==='number'&&typeof body.expiry_window==='number'&&Date.now()>=body.timestamp+body.expiry_window)throw Error('GRID_SIGNED_REQUEST_EXPIRED');
      }
      return guardedWorkerFetch(fetcher,String(input),request,options??{});
    };
    const response=transport&&request.kind==='venue'?await transport.request(url,bounded,send,reserved):await send(url,bounded);
    if(response.status===429){await quota.rateLimited(provider);await response.body?.cancel();throw Error('GRID_QUOTA_BACKOFF');}
    return response;
  };
  installRequestBudget(wrapped,{
    async reserve(units){if(!quota.reserve)throw Error('GRID_BURST_RESERVATION_UNAVAILABLE');return quota.reserve('pacifica_rest',units,false);},
    beforeSend:()=>quota.beforeSend?quota.beforeSend():Promise.resolve(()=>{}),
  });
  return wrapped;
}
