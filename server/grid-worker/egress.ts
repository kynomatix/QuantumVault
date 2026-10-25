const writes = new Set(['/account/subaccount/create', '/account/subaccount/transfer', '/account/leverage', '/orders/create_market', '/orders/create', '/orders/cancel']);
const reads = new Set(['/info', '/info/prices', '/book', '/account', '/account/settings', '/orders', '/positions', '/orders/history', '/trades/history', '/account/balance/history', '/funding/history', '/kline']);
const rpcReads = new Set(['getBalance', 'getLatestBlockhash', 'getBlockHeight', 'getAccountInfo', 'getMultipleAccounts', 'getTokenAccountBalance', 'getSignatureStatuses']);

export type WorkerEgress = { kind: 'venue'; method: 'GET' | 'POST' }
  | { kind: 'websocket'; method: 'GET' }
  | { kind: 'rpc'; method: 'POST'; rpcMethod: string };

/** Pure guard only. U4 must install it on every client and freeze the complete read inventory. */
export function assertWorkerEgress(raw: string, request: WorkerEgress): URL {
  const url = new URL(raw);
  if (url.username || url.password || url.hash || url.port || /%|\\/.test(url.pathname)) throw Error('GRID_EGRESS_REFUSED');
  if (request.kind === 'venue') {
    if (url.protocol !== 'https:' || url.hostname !== 'api.pacifica.fi' || !url.pathname.startsWith('/api/v1/')) throw Error('GRID_EGRESS_REFUSED');
    const route = url.pathname.slice('/api/v1'.length);
    if(route==='/account/balance/history'){
      const keys=[...url.searchParams.keys()];
      if(new Set(keys).size!==keys.length||keys.some(k=>!['account','limit','cursor','include_trades'].includes(k))
        ||! /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(url.searchParams.get('account')??'')
        ||url.searchParams.get('limit')!=='100'||url.searchParams.get('include_trades')!=='true'
        ||url.searchParams.has('cursor')&&!/^[A-Za-z0-9_-]{1,512}$/.test(url.searchParams.get('cursor')??''))throw Error('GRID_EGRESS_REFUSED');
    }
    if (!(request.method === 'POST' ? writes.has(route)||route==='/account/subaccount/list' : reads.has(route)) || request.method === 'POST' && url.search) throw Error('GRID_EGRESS_REFUSED');
  } else if (request.kind === 'websocket') {
    if (url.protocol !== 'wss:' || url.hostname !== 'ws.pacifica.fi' || url.pathname !== '/ws' || url.search) throw Error('GRID_EGRESS_REFUSED');
  } else if (url.protocol !== 'https:' || !['api.mainnet-beta.solana.com', 'mainnet.helius-rpc.com'].includes(url.hostname)
    || url.pathname !== '/' || !rpcReads.has(request.rpcMethod)) throw Error('GRID_EGRESS_REFUSED');
  return url;
}
/** No redirect is followed, even to another otherwise allowlisted endpoint. */
export async function guardedWorkerFetch(fetcher: typeof fetch, raw: string, request: Exclude<WorkerEgress, {kind: 'websocket'}>, init: RequestInit): Promise<Response> {
  assertWorkerEgress(raw, request);
  if (init.method !== request.method) throw Error('GRID_EGRESS_REFUSED');
  if(new URL(raw).pathname==='/api/v1/account/subaccount/list'){
    if(typeof init.body!=='string')throw Error('GRID_EGRESS_REFUSED');
    const body=JSON.parse(init.body);
    if(!body||Array.isArray(body)||Object.keys(body).sort().join(',')!=='account,expiry_window,signature,timestamp'
      ||typeof body.account!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(body.account)
      ||typeof body.signature!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(body.signature)
      ||!Number.isSafeInteger(body.timestamp)||!Number.isSafeInteger(body.expiry_window)||body.expiry_window<1||body.expiry_window>15000
      ||Date.now()<body.timestamp||Date.now()>=body.timestamp+body.expiry_window)throw Error('GRID_EGRESS_REFUSED');
  }
  if (request.kind === 'rpc') {
    if (typeof init.body !== 'string') throw Error('GRID_EGRESS_REFUSED');
    const body: unknown = JSON.parse(init.body);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('method' in body) || body.method !== request.rpcMethod) throw Error('GRID_EGRESS_REFUSED');
  }
  const response = await fetcher(raw, {...init, redirect: 'error'});
  if (response.redirected || response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw Error('GRID_EGRESS_REFUSED');
  }
  return response;
}
