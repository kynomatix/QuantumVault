import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { deriveSubkey, zeroizeBuffer } from '../crypto-v3';
import { currentAuthority } from './authority';

export const START_CONSENT_PURPOSE = 'grid_start_consent_v1';
export const START_CONSENT_VERSION = '1';
export interface StartConsent {
  version: string; action: 'start'; owner: string; botId: string; draftRevision: string;
  serverIntentDigest: string; policyHmac: string; spendingPolicyDigest: string;
  walletGeneration: string; scopeRevision: string; consentVersion: string;
  requestKey: string; issuedAt: string; expiresAt: string;
}
const fields = ['version','action','owner','botId','draftRevision','serverIntentDigest','policyHmac','spendingPolicyDigest',
  'walletGeneration','scopeRevision','consentVersion','requestKey','issuedAt','expiresAt'] as const;
const digest = /^[0-9a-f]{64}$/;
const integer = /^(0|[1-9][0-9]*)$/;
const time = (s: string) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
export function encodeStartConsent(c: StartConsent): string {
  if (!c || Object.keys(c).length !== fields.length || !fields.every(k => typeof c[k] === 'string' && c[k].length > 0)
    || c.version !== '1' || c.action !== 'start' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(c.botId)
    || !['serverIntentDigest','policyHmac','spendingPolicyDigest'].every(k=>digest.test(c[k as keyof StartConsent]))
    || ![c.walletGeneration,c.scopeRevision,c.consentVersion].every(v=>integer.test(v))
    || c.draftRevision.length>2048 || c.draftRevision.trim()!==c.draftRevision
    || c.scopeRevision === '0' || c.consentVersion !== START_CONSENT_VERSION
    || !time(c.issuedAt) || !time(c.expiresAt) || Date.parse(c.expiresAt) <= Date.parse(c.issuedAt)
    || Date.parse(c.expiresAt)-Date.parse(c.issuedAt)>600_000) throw Error('GRID_CONSENT_CANONICAL');
  // An ordered array of key/value pairs has one encoding, with no delimiter ambiguity.
  return JSON.stringify(fields.map(k => [k,c[k]]));
}
export function startConsentMac(c: StartConsent, umk: Buffer): string {
  if (umk.length !== 32) throw Error('GRID_CONSENT_KEY');
  const key = deriveSubkey(umk, START_CONSENT_PURPOSE);
  try { return createHmac('sha256', key).update(encodeStartConsent(c),'utf8').digest('hex'); }
  finally { zeroizeBuffer(key); }
}
export function verifyStartConsentMac(c: StartConsent, mac: string, umk: Buffer): boolean {
  if (!digest.test(mac)) return false;
  const expected = Buffer.from(startConsentMac(c,umk),'hex'), actual = Buffer.from(mac,'hex');
  return expected.length === actual.length && timingSafeEqual(expected,actual);
}
export interface StoredStartConsent { id: string; consent: StartConsent; consentMac: string; state: string }
export function storedStartConsent(r: Record<string, any>): StoredStartConsent {
  return {id:r.id,state:r.state,consentMac:r.consent_mac,consent:{version:'1',action:r.action,owner:r.owner_wallet,botId:r.bot_id,
    draftRevision:r.draft_revision,serverIntentDigest:r.server_intent_digest,policyHmac:r.policy_hmac,spendingPolicyDigest:r.spending_policy_digest,
    walletGeneration:String(r.wallet_generation),scopeRevision:String(r.scope_revision),consentVersion:r.consent_version,
    requestKey:r.request_key,issuedAt:new Date(r.issued_at).toISOString(),expiresAt:new Date(r.expires_at).toISOString()}};
}
async function context(c: PoolClient, owner: string, botId: string) {
  // Enforce the injected transaction contract before any request-row lock or write.
  if (!(await c.query('SELECT grid_worker_has_host_lock(false) AND grid_worker_has_wallet_lock($1) AS locked',[owner])).rows[0]?.locked) throw Error('GRID_CONSENT_PRELOCK_REQUIRED');
  if (!(await c.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
    AND granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
    AND classid=((hashtextextended('qv:grid-worker:v3:bot:'||$1,0)>>32)&4294967295)::oid
    AND objid=(hashtextextended('qv:grid-worker:v3:bot:'||$1,0)&4294967295)::oid
    AND objsubid=1 AND mode='ExclusiveLock') AS locked`,[botId])).rows[0]?.locked)throw Error('GRID_CONSENT_PRELOCK_REQUIRED');
  const h=(await c.query(`SELECT h.scope_revision::text,h.start_scope,h.authority_tracking_enabled,
    h.owner_wallet,o.wallet_address AS installed_owner,date_trunc('milliseconds',clock_timestamp()) AS db_now,
    b.wallet_address,b.draft_revision,b.server_intent_digest,b.policy_hmac,w.agent_public_key
    FROM grid_worker_host h JOIN grid_worker_owner o ON o.singleton_id=h.singleton_id
    JOIN grid_bots b ON b.id=$2 AND b.wallet_address=$1 JOIN wallets w ON w.address=b.wallet_address WHERE h.singleton_id=1`,[owner,botId])).rows[0];
  if (!h || h.owner_wallet!==owner || h.installed_owner!==owner || h.wallet_address!==owner
    || h.start_scope!=='owner_allowlist' || !h.authority_tracking_enabled) throw Error('GRID_OWNER_SCOPE_REFUSED');
  const authority=await currentAuthority(c,{botId,wallet:owner,masterAccount:h.agent_public_key,requirePool:false,workerExposure:true});
  return {...h,generation:authority.generation as string};
}
export type StartIntent = Pick<StartConsent,'owner'|'botId'|'draftRevision'|'serverIntentDigest'|'policyHmac'|'spendingPolicyDigest'|'requestKey'>;
/** Host -> wallet -> bot identity locks belong to the caller; no routes or session imports. */
export async function issueStartConsent(c: PoolClient, intent: StartIntent, umk: Buffer, lifetimeMs=600_000): Promise<StoredStartConsent> {
  if (!Number.isSafeInteger(lifetimeMs)||lifetimeMs<1||lifetimeMs>600_000) throw Error('GRID_CONSENT_LIFETIME');
  const ctx=await context(c,intent.owner,intent.botId);
  const existing=(await c.query('SELECT * FROM grid_worker_requests WHERE owner_wallet=$1 AND request_key=$2 FOR UPDATE',[intent.owner,intent.requestKey])).rows[0];
  if(existing){const value=storedStartConsent(existing);if(!Object.entries(intent).every(([k,v])=>value.consent[k as keyof StartConsent]===v))throw Error('GRID_CONSENT_REQUEST_CONFLICT');
    if(!verifyStartConsentMac(value.consent,value.consentMac,umk))throw Error('GRID_CONSENT_MAC');return value;}
  if(String(ctx.draft_revision)!==intent.draftRevision || String(ctx.server_intent_digest).toLowerCase()!==intent.serverIntentDigest
    || String(ctx.policy_hmac).toLowerCase()!==intent.policyHmac)throw Error('GRID_CONSENT_DRAFT_CHANGED');
  const issuedAt=new Date(ctx.db_now).toISOString();
  const consent:StartConsent={...intent,version:'1',action:'start',walletGeneration:ctx.generation,scopeRevision:ctx.scope_revision,
    consentVersion:START_CONSENT_VERSION,issuedAt,expiresAt:new Date(Date.parse(issuedAt)+lifetimeMs).toISOString()};
  const consentMac=startConsentMac(consent,umk),id=randomUUID();
  await c.query(`INSERT INTO grid_worker_requests(id,owner_wallet,bot_id,action,request_key,draft_revision,server_intent_digest,policy_hmac,
    spending_policy_digest,wallet_generation,scope_revision,consent_version,consent_mac,issued_at,expires_at)
    VALUES($1,$2,$3,'start',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[id,intent.owner,intent.botId,intent.requestKey,intent.draftRevision,
      intent.serverIntentDigest,intent.policyHmac,intent.spendingPolicyDigest,consent.walletGeneration,consent.scopeRevision,consent.consentVersion,consentMac,consent.issuedAt,consent.expiresAt]);
  return {id,consent,consentMac,state:'pending'};
}
/** Admission, consumption and final send use one verifier and explicit allowed states. */
export async function verifyStartConsent(c: PoolClient, value: StoredStartConsent, umk: Buffer, allowedStates: readonly string[]): Promise<void> {
  if(!verifyStartConsentMac(value.consent,value.consentMac,umk))throw Error('GRID_CONSENT_MAC');
  const ctx=await context(c,value.consent.owner,value.consent.botId);
  const r=(await c.query('SELECT * FROM grid_worker_requests WHERE id=$1 FOR UPDATE',[value.id])).rows[0];
  if(!r)throw Error('GRID_CONSENT_MISSING');
  const retained=storedStartConsent(r);
  if(!allowedStates.includes(retained.state)||['complete','superseded','refused','expired'].includes(retained.state)
    ||encodeStartConsent(retained.consent)!==encodeStartConsent(value.consent)||retained.consentMac!==value.consentMac)throw Error('GRID_CONSENT_REPLAY');
  if(value.consent.walletGeneration!==ctx.generation || value.consent.scopeRevision!==ctx.scope_revision
    ||value.consent.consentVersion!==START_CONSENT_VERSION)throw Error('GRID_CONSENT_STALE');
  if(value.consent.draftRevision!==String(ctx.draft_revision)
    ||value.consent.serverIntentDigest!==String(ctx.server_intent_digest).toLowerCase()
    ||value.consent.policyHmac!==String(ctx.policy_hmac).toLowerCase())throw Error('GRID_CONSENT_DRAFT_CHANGED');
  const now=new Date(ctx.db_now).getTime();
  if(Date.parse(value.consent.issuedAt)>now||retained.state==='pending'&&Date.parse(value.consent.expiresAt)<=now)throw Error('GRID_CONSENT_EXPIRED');
}
export async function supersedeStartConsents(c: PoolClient, owner: string, botIds: readonly string[], reason: 'draft_changed'|'stop'): Promise<number> {
  const result=await c.query(`UPDATE grid_worker_requests SET state='superseded',completed_at=clock_timestamp(),result_code=$3
    WHERE owner_wallet=$1 AND action='start' AND bot_id IN (SELECT value::uuid FROM jsonb_array_elements_text($2::jsonb)) AND state='pending'`,[owner,JSON.stringify(botIds),reason]);
  return result.rowCount??0;
}
