import {guardedWorkerFetch, assertWorkerEgress, type WorkerEgress} from './egress';
import type {WorkerQuota,QuotaProvider} from './quota';
import {protectiveQuotaRequest} from './protective-purpose';
/** One choke point, including retries. There is deliberately no automatic resend. */
export function workerFetch(quota: Pick<WorkerQuota,'debit'|'rateLimited'>, fetcher: typeof fetch = fetch): typeof fetch {
  return async(input, init = {}) => {
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
    // Charge 120 decicredits per venue request conservatively, including the signed read.
    await quota.debit(provider,request.kind==='venue'?120:1,protectiveQuotaRequest(u,method,init.body));
    init.signal?.throwIfAborted();
    const response=await guardedWorkerFetch(fetcher,url,request,{...init,method,signal:init.signal?AbortSignal.any([init.signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000)});
    if(response.status===429){await quota.rateLimited(provider);await response.body?.cancel();throw Error('GRID_QUOTA_BACKOFF');}
    return response;
  };
}
