import {createHmac,timingSafeEqual} from 'node:crypto';
import type {PoolClient} from 'pg';
import {deriveSubkey,zeroizeBuffer} from '../crypto-v3';
import {ownerSha256} from './owner-auth';
import {currentAuthority} from './authority';

export const PROTECTIVE_CONSENT_PURPOSE='grid_protective_consent_v1';
export interface ProtectiveConsent {
  version:'1';action:'protective_close';owner:string;botId:string;walletGeneration:string;scopeRevision:string;
  requestKey:string;issuedAt:string;expiresAt:string;
}
const fields=['version','action','owner','botId','walletGeneration','scopeRevision','requestKey','issuedAt','expiresAt'] as const;
export function encodeProtectiveConsent(c:ProtectiveConsent){
  if(Object.keys(c).length!==fields.length||fields.some(k=>typeof c[k]!=='string'||!c[k])||c.version!=='1'||c.action!=='protective_close'
    ||!/^\d+$/.test(c.walletGeneration)||!/^\d+$/.test(c.scopeRevision)||c.scopeRevision==='0'
    ||!/^[0-9a-f]{64}$/.test(c.requestKey)||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(c.botId)
    ||![c.issuedAt,c.expiresAt].every(t=>Number.isFinite(Date.parse(t))&&new Date(t).toISOString()===t)
    ||Date.parse(c.expiresAt)<=Date.parse(c.issuedAt)||Date.parse(c.expiresAt)-Date.parse(c.issuedAt)>600000)throw Error('GRID_PROTECTIVE_CONSENT_INVALID');
  return JSON.stringify(fields.map(k=>[k,c[k]]));
}
export function protectiveConsentMac(c:ProtectiveConsent,umk:Buffer){
  if(umk.length!==32)throw Error('GRID_PROTECTIVE_KEY_INVALID');
  const key=deriveSubkey(umk,PROTECTIVE_CONSENT_PURPOSE);
  try{return createHmac('sha256',key).update(encodeProtectiveConsent(c)).digest('hex');}finally{zeroizeBuffer(key);}
}
export function storedProtectiveConsent(r:Record<string,any>):ProtectiveConsent{
  return {version:'1',action:r.action,owner:r.owner_wallet,botId:r.bot_id,walletGeneration:String(r.wallet_generation),
    scopeRevision:String(r.scope_revision),requestKey:r.request_key,issuedAt:new Date(r.issued_at).toISOString(),expiresAt:new Date(r.expires_at).toISOString()};
}
export const PROTECTIVE_UNUSED_DIGEST=ownerSha256('grid-protective-v1:unused');
export const PROTECTIVE_DRAFT='grid-protective-v1:unused';
export async function verifyProtectiveConsent(c:PoolClient,r:Record<string,any>,umk:Buffer){
  const consent=storedProtectiveConsent(r),canonical=encodeProtectiveConsent(consent);
  if(!/^[0-9a-f]{64}$/.test(r.consent_mac)||!timingSafeEqual(Buffer.from(protectiveConsentMac(consent,umk),'hex'),Buffer.from(r.consent_mac,'hex'))
    ||r.server_intent_digest!==ownerSha256(canonical)||r.policy_hmac!==PROTECTIVE_UNUSED_DIGEST||r.spending_policy_digest!==ownerSha256(canonical)
    ||r.draft_revision!==PROTECTIVE_DRAFT||r.consent_version!=='1'||r.action!=='protective_close'||r.state!=='admitted')throw Error('GRID_PROTECTIVE_CONSENT_INVALID');
  const h=(await c.query(`SELECT h.scope_revision::text,clock_timestamp() AS db_now,w.agent_public_key FROM grid_worker_host h
    JOIN grid_worker_owner o ON o.wallet_address=h.owner_wallet JOIN wallets w ON w.address=o.wallet_address
    WHERE h.singleton_id=1 AND h.owner_wallet=$1`,[consent.owner])).rows[0];
  if(!h||h.scope_revision!==consent.scopeRevision||new Date(h.db_now).getTime()>=Date.parse(consent.expiresAt)
    ||new Date(h.db_now).getTime()<Date.parse(consent.issuedAt))throw Error('GRID_PROTECTIVE_CONSENT_EXPIRED');
  await currentAuthority(c,{botId:consent.botId,wallet:consent.owner,masterAccount:h.agent_public_key,generation:consent.walletGeneration,workerExposure:true});
}
