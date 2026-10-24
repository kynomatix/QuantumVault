const writes = new Set(['/account/subaccount/create', '/account/subaccount/transfer', '/account/leverage', '/orders/create_market', '/orders/create', '/orders/cancel']);
const reads = new Set(['/info', '/book', '/account', '/account/settings', '/orders', '/positions', '/orders/history', '/trades/history']);
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
    if (!(request.method === 'POST' ? writes : reads).has(route) || request.method === 'POST' && url.search) throw Error('GRID_EGRESS_REFUSED');
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
