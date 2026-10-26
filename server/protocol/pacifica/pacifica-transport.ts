import {providerRequestCost,providerEndpoint,latchProviderEndpoint} from '../../grid-bot/provider-request-cost';
import type {QuotaObservation} from './pacifica-observed-quota';
import bs58 from 'bs58';
import { randomUUID } from 'node:crypto';
import {mainQuota} from '../../grid-worker/main-quota';
import {mainGridQuotaAccount} from '../../grid-worker/main-quota-scope';
import { ObservedPacificaQuota, parseRestQuota, parseWsQuota } from './pacifica-observed-quota.js';

export function validPacificaConfigKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9]{8}_[1-9A-HJ-NP-Za-km-z]{16,22}$/.test(value)) return false;
  try { return bs58.decode(value.slice(9)).length === 16; } catch { return false; }
}
function approvedTarget(raw: string, ws: boolean): boolean {
  try {
    const u = new URL(raw);
    return !u.username && !u.password && !u.hash && !u.port && (ws
      ? u.protocol === 'wss:' && u.hostname === 'ws.pacifica.fi' && u.pathname === '/ws' && !u.search
      : u.protocol === 'https:' && u.hostname === 'api.pacifica.fi' && u.pathname.startsWith('/api/v1/')
        && !/%|\\/.test(u.pathname));
  } catch { return false; }
}
export class PacificaCredentialTargetError extends Error {
  constructor() { super('Pacifica credential target refused'); this.name = 'PacificaCredentialTargetError'; }
}
/** Credentials stay in private memory, never in config/status/quotes or durable request material. */
export class PacificaTransportAuthority {
  #key: string | null;
  private inFlight=0;
  private sequence=0;
  private previous:(QuotaObservation & {at:number;sequence:number})|null=null;
  private clock:()=>number;
  private pendingWarnings=new Set<string>();
  private costWarning:((endpoint:string)=>Promise<void>)|undefined;
  onCostLatch(warning:(endpoint:string)=>Promise<void>){this.costWarning=warning;}
  async request(url:string,init:RequestInit,fetcher:typeof fetch=fetch,reserved=false,credentialed=true):Promise<Response>{
    for(const endpoint of this.pendingWarnings){if(!this.costWarning)throw Error('GRID_COST_LATCH_RECORD_UNAVAILABLE');await this.costWarning(endpoint);this.pendingWarnings.delete(endpoint);}
    const units=providerRequestCost(init.method??'GET',url),reservation='request:'+randomUUID();
    if(!reserved){const q=this.quota.snapshot();if(q.availability==='observed'&&q.remainingDeciCredits!<units)throw Error('GRID_QUOTA_UNAVAILABLE');this.quota.reserve(reservation,units,'risk-reduction');}
    const sequence=++this.sequence;
    if(this.inFlight++)this.previous=null;
    const previous=this.previous;
    const cost=providerRequestCost(init.method??'GET',url);
    try{
      const response=await fetcher(url,credentialed?this.restInit(url,init):init);
      const raw=parseRestQuota(response.headers.get('ratelimit'),response.headers.get('ratelimit-policy'));
      const at=this.clock();
      // A warning-store failure must not discard the lower quota already received.
      const observedResponse=this.response(response);
      if(raw&&previous&&this.inFlight===1&&sequence===this.sequence&&sequence===previous.sequence+1
        &&raw.quota===previous.quota&&raw.resetSeconds<=previous.resetSeconds&&raw.resetSeconds>0
        &&at>=previous.at&&at<previous.at+previous.resetSeconds*1000
        &&previous.remaining-raw.remaining>cost){
        const endpoint=providerEndpoint(url);
        if(latchProviderEndpoint(endpoint)){this.pendingWarnings.add(endpoint);if(this.costWarning){await this.costWarning(endpoint);this.pendingWarnings.delete(endpoint);}}
      }
      this.previous=raw&&this.inFlight===1&&sequence===this.sequence?{...raw,at,sequence}:null;
      return observedResponse;
    }catch(error){this.previous=null;throw this.safeError(error);}
    finally{this.inFlight--;if(!reserved)this.quota.settle(reservation,'uncertain');}
  }
  readonly generation = randomUUID();
  readonly keyStatus: 'absent' | 'invalid' | 'present';
  readonly quota: ObservedPacificaQuota;
  get gridReady(){return this.keyStatus==='present'||this.workerNoKey&&this.keyStatus==='absent';}
  constructor(key: unknown, domain = 'pacifica:deployment-local', now: () => number = Date.now, readonly workerNoKey=false) {
    this.clock=now;
    this.keyStatus = key === undefined || key === '' ? 'absent' : validPacificaConfigKey(key) ? 'present' : 'invalid';
    this.#key = this.keyStatus === 'present' ? key as string : null;
    this.quota = new ObservedPacificaQuota(domain, now);
  }
  status() {
    const quota = this.quota.snapshot();
    return { keyStatus: this.keyStatus, generation: this.generation, quota, sharingProof: 'deployment_local_only' as const,
      liveEntryAllowed: this.keyStatus === 'present' && quota.availability === 'observed' && quota.entryDeciCredits > 0,
      reason: this.keyStatus !== 'present' ? `config_key_${this.keyStatus}` : quota.availability !== 'observed' ? 'quota_metadata_missing_or_stale' : quota.entryDeciCredits <= 0 ? 'quota_budget_exhausted' : null };
  }
  restInit(url: string, init: RequestInit): RequestInit {
    const headers = new Headers(init.headers);
    headers.delete('PF-API-KEY');
    if (this.#key) {
      if (!approvedTarget(url, false)) throw new PacificaCredentialTargetError();
      headers.set('PF-API-KEY', this.#key);
    }
    return { ...init, headers, redirect: 'error' };
  }
  websocketOptions(url: string, account?:string): { headers: Record<string, string>; followRedirects: false } {
    // WS message costs cannot be bounded at connection setup. External MAIN refuses this transport.
    if(mainGridQuotaAccount(account)&&process.env.GRID_REMOTE_WORKER_ENABLED==='true'&&process.env.QV_PROCESS_ROLE!=='grid-worker')throw Error('GRID_MAIN_WS_QUOTA_UNAVAILABLE');
    if (this.#key && !approvedTarget(url, true)) throw new PacificaCredentialTargetError();
    return { headers: this.#key ? { 'PF-API-KEY': this.#key } : {}, followRedirects: false };
  }
  /** Called at response headers, before any potentially hanging body read. */
  response(response: Response, gridSharedAccount=false): Response {
    if(gridSharedAccount&&response.status===429)mainQuota.rateLimited('pacifica_rest');
    this.quota.observe(parseRestQuota(response.headers?.get('ratelimit') ?? null, response.headers?.get('ratelimit-policy') ?? null));
    const sanitize = (value: unknown): unknown => {
      if (typeof value === 'string') return this.redact(value);
      if (Array.isArray(value)) return value.map(sanitize);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [this.redact(k), sanitize(v)]));
      return value;
    };
    if (!this.#key) return response;
    return new Proxy(response, { get: (target, prop) => {
      if (prop === 'text') return async () => { try { return this.redact(await target.text()); } catch (e) { throw this.safeError(e); } };
      if (prop === 'json') return async () => { try { return sanitize(await target.json()); } catch (e) { throw this.safeError(e); } };
      const v = Reflect.get(target, prop, target); return typeof v === 'function' ? v.bind(target) : v;
    } });
  }
  observeWsAction(raw: unknown, currentConnection: boolean): void {
    if (!currentConnection || !raw || typeof raw !== 'object') return;
    const r = raw as Record<string, unknown>;
    // Market/subscription/pong frames do not prove action quota.
    if (!['create_order', 'create_market_order', 'edit_order', 'batch_order', 'cancel_order', 'cancel_all_orders'].includes(r.type as string)) return;
    if (typeof r.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(r.id) || !Number.isSafeInteger(r.code)) return;
    this.quota.observe(parseWsQuota(r.rl));
  }
  redact(value: string): string { return this.#key ? value.split(this.#key).join('REDACTED') : value; }
  safeError(error: unknown): Error {
    return this.#key ? new Error('Pacifica transport failed') : error instanceof Error ? error : new Error('Pacifica transport failed');
  }
}
let authority: PacificaTransportAuthority | undefined;
/** Lazy runtime-only capture. Tests inject placeholders; build tooling never reads Secrets. */
export function pacificaTransportAuthority(): PacificaTransportAuthority {
  return authority ??= new PacificaTransportAuthority(process.env.PACIFICA_API_KEY);
}
