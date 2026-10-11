import bs58 from 'bs58';
import { randomUUID } from 'node:crypto';
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
/** Credentials stay in private memory, never in config/status/quotes or durable request material. */
export class PacificaTransportAuthority {
  #key: string | null;
  readonly generation = randomUUID();
  readonly keyStatus: 'absent' | 'invalid' | 'present';
  readonly quota: ObservedPacificaQuota;
  constructor(key: unknown, domain = 'pacifica:deployment-local', now: () => number = Date.now) {
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
      if (!approvedTarget(url, false)) throw new Error('Pacifica credential target refused');
      headers.set('PF-API-KEY', this.#key);
    }
    return { ...init, headers, redirect: 'error' };
  }
  websocketOptions(url: string): { headers: Record<string, string>; followRedirects: false } {
    if (this.#key && !approvedTarget(url, true)) throw new Error('Pacifica credential target refused');
    return { headers: this.#key ? { 'PF-API-KEY': this.#key } : {}, followRedirects: false };
  }
  /** Called at response headers, before any potentially hanging body read. */
  response(response: Response): Response {
    if (this.#key) this.quota.observe(response.ok
      ? parseRestQuota(response.headers?.get('ratelimit') ?? null, response.headers?.get('ratelimit-policy') ?? null) : null);
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
    if (!currentConnection || !this.#key || !raw || typeof raw !== 'object') return;
    const r = raw as Record<string, unknown>;
    // Market/subscription/pong frames do not prove action quota.
    if (!['create_order', 'create_market_order', 'edit_order', 'batch_order', 'cancel_order', 'cancel_all_orders'].includes(r.type as string)) return;
    if (typeof r.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(r.id) || !Number.isSafeInteger(r.code)) return;
    this.quota.observe((r.code as number) >= 200 && (r.code as number) < 300 ? parseWsQuota(r.rl) : null);
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
