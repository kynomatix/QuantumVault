import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import bs58 from 'bs58';

export const ownerActions = ['pause', 'reset_pause', 'ack_critical', 'widen_scope', 'break_glass_close'] as const;
export type OwnerAction = typeof ownerActions[number];
export interface OwnerMessage {
  action: OwnerAction; scope: 'grid_worker'; target: string; nonce: string;
  issued: string; expires: string; paramsDigest: string;
}
const exact = (pattern: RegExp, value: string) => pattern.exec(value)?.[0] === value;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ownerSha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function refuse(): never { throw Error('GRID_OWNER_WIRE_INVALID'); }
export function ownerPublicKey(wallet: string): Uint8Array {
  try { const key = bs58.decode(wallet); if (key.length === 32 && bs58.encode(key) === wallet) return key; } catch { /* fixed rejection */ }
  return refuse();
}
function validString(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { const next = s.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
/** RFC 8785 for this protocol's restricted strings/arrays/object domain. No numeric coercion. */
export function canonicalOwnerParams(action: OwnerAction, input: unknown): string | undefined {
  if (!['widen_scope', 'break_glass_close'].includes(action)) { if (input !== undefined) refuse(); return undefined; }
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) return refuse();
  const obj = input as Record<string, unknown>;
  const keys = action === 'widen_scope' ? ['globalCapUsd', 'perBotCapUsd', 'wallets'] : ['botId'];
  if (Object.keys(obj).sort().join(',') !== keys.join(',')) refuse();
  if (action === 'widen_scope') {
    for (const key of ['globalCapUsd', 'perBotCapUsd']) if (typeof obj[key] !== 'string' || !exact(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/, obj[key] as string)) refuse();
    if (!Array.isArray(obj.wallets) || obj.wallets.some((w, i, all) => typeof w !== 'string' || (i > 0 && all[i - 1] >= w))) refuse();
    for (const wallet of obj.wallets as string[]) ownerPublicKey(wallet);
  } else if (typeof obj.botId !== 'string' || !exact(uuid, obj.botId)) refuse();
  const encode = (value: unknown): string => {
    if (typeof value === 'string' && validString(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(encode).join(',') + ']';
    return refuse();
  };
  return '{' + keys.map(key => JSON.stringify(key) + ':' + encode(obj[key])).join(',') + '}';
}
export function ownerParamsDigest(action: OwnerAction, params?: unknown): string {
  const encoded = canonicalOwnerParams(action, params);
  return encoded === undefined ? 'none' : ownerSha256(encoded);
}
export function serializeOwnerMessage(m: OwnerMessage): string {
  return `QV-OWNER-ACTION v1\naction:${m.action}\nscope:${m.scope}\ntarget:${m.target}\nnonce:${m.nonce}\nissued:${m.issued}\nexpires:${m.expires}\nparams:${m.paramsDigest}`;
}
export function parseOwnerMessage(bytes: Uint8Array | string): OwnerMessage {
  const raw = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  const message = raw.toString('utf8');
  if (!Buffer.from(message, 'utf8').equals(raw) || !validString(message)) refuse();
  const lines = message.split('\n');
  const names = ['action', 'scope', 'target', 'nonce', 'issued', 'expires', 'params'];
  if (lines.length !== 8 || lines[0] !== 'QV-OWNER-ACTION v1') refuse();
  const values = names.map((key, i) => { if (!lines[i + 1].startsWith(key + ':')) refuse(); return lines[i + 1].slice(key.length + 1); });
  const [action, scope, target, nonce, issued, expires, paramsDigest] = values;
  if (!(ownerActions as readonly string[]).includes(action) || scope !== 'grid_worker'
    || !exact(/^(?:host:[a-z0-9-]{1,64}|(?:incident|bot):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|all)$/, target)
    || !exact(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/, nonce)) refuse();
  ownerPublicKey(nonce);
  for (const value of [issued, expires]) {
    if (!exact(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/, value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) refuse();
  }
  const window = Date.parse(expires) - Date.parse(issued);
  if (window <= 0 || window > 120_000) refuse();
  const hasParams = action === 'widen_scope' || action === 'break_glass_close';
  if (hasParams ? !exact(/^[0-9a-f]{64}$/, paramsDigest) : paramsDigest !== 'none') refuse();
  const result = { action: action as OwnerAction, scope: 'grid_worker' as const, target, nonce, issued, expires, paramsDigest };
  if (serializeOwnerMessage(result) !== message) refuse();
  return result;
}
export function verifyOwnerSignature(message: string, signature: string, wallet: string): boolean {
  try {
    const key = ownerPublicKey(wallet), sig = bs58.decode(signature);
    if (sig.length !== 64 || bs58.encode(sig) !== signature) return false;
    const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from([48,42,48,5,6,3,43,101,112,3,33,0]), Buffer.from(key)]), type: 'spki', format: 'der' });
    return verify(null, Buffer.from(message, 'utf8'), publicKey, sig);
  } catch { return false; }
}
export function newOwnerNonce(): string {
  for (;;) { const nonce = bs58.encode(randomBytes(32)); if (nonce.length >= 43) return nonce; }
}
