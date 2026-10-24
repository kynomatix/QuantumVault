import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {createHash} from 'node:crypto';
import {healthStatus, publicSnapshot, type StatusMemory} from './status';
import {statusPage} from './status-page';
export function statusCache(read: () => StatusMemory, now = Date.now) {
  let bytes: {html: Buffer; json: Buffer; status: 200|503; csp: string};
  const rebuild = () => {
    const snapshot = publicSnapshot(read(), now()), html = statusPage(snapshot, now());
    const css = html.match(/<style>([\s\S]*?)<\/style>/)![1];
    bytes = {html:Buffer.from(html),json:Buffer.from(JSON.stringify(snapshot)),status:healthStatus(snapshot),
      csp:`default-src 'none'; style-src 'sha256-${createHash('sha256').update(css).digest('base64')}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`};
    if (bytes.html.length > 16384 || bytes.json.length > 2048) throw Error('GRID_STATUS_SIZE');
  };
  rebuild();
  const timer = setInterval(rebuild,1000); timer.unref();
  return {read:()=>bytes, close:()=>clearInterval(timer), rebuild};
}
/** No input access except exact raw method/path. No request stream listeners. */
export function statusHandler(cache: ReturnType<typeof statusCache>, poll: () => void) {
  return (request: IncomingMessage, response: ServerResponse) => {
    const bytes = cache.read(), path = request.url, method = request.method;
    const known = path === '/' || path === '/healthz', allowed = method === 'GET' || method === 'HEAD';
    const status = !known ? 404 : !allowed ? 405 : path === '/' ? 200 : bytes.status;
    const body = !known ? Buffer.from('Not found\n') : !allowed ? Buffer.from('Method not allowed\n') : path === '/' ? bytes.html : bytes.json;
    response.writeHead(status, {'Content-Type':known&&allowed?(path==='/'?'text/html; charset=utf-8':'application/json; charset=utf-8'):'text/plain; charset=utf-8',
      'Content-Length':body.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
      'X-Robots-Tag':'noindex','Content-Security-Policy':bytes.csp,...(status===405?{'Allow':'GET, HEAD'}:{})});
    if (known && allowed && path === '/healthz') poll();
    response.end(method==='HEAD'?undefined:body);
  };
}
export function workerHttp(cache: ReturnType<typeof statusCache>, poll: () => void) {
  const server = createServer({maxHeaderSize:8192,headersTimeout:5000,requestTimeout:5000,connectionsCheckingInterval:1000},statusHandler(cache,poll));
  server.maxConnections=32; server.keepAliveTimeout=1000; server.maxRequestsPerSocket=2; server.setTimeout(5000,socket=>socket.destroy());
  server.on('clientError',(_error,socket)=>socket.destroy());
  return server;
}
