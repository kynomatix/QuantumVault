import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {QuotaPolicy} from './quota';
import {requireVerifiedOwner,type VerifiedOwnerContext} from './owner-receipts';

/** Deliberately excludes the digest itself. Integers have one decimal spelling. */
export function canonicalQuotaPolicy(p:QuotaPolicy):string {
  if(!['pacifica_rest','rpc_backup'].includes(p.provider)||p.domain_id!=='deployment'
    ||!Number.isSafeInteger(p.window_ms)||p.window_ms<1||p.window_ms>60000)throw Error('GRID_QUOTA_POLICY_INVALID');
  for(const key of ['total_units','worker_limit_units','worker_protective_reserve_units'] as const)
    if(typeof p[key]!=='string'||! /^(0|[1-9][0-9]*)$/.test(p[key])||!Number.isSafeInteger(Number(p[key])))throw Error('GRID_QUOTA_POLICY_INVALID');
  const total=Number(p.total_units),worker=Number(p.worker_limit_units),reserve=Number(p.worker_protective_reserve_units);
  if(!(total>worker&&worker>reserve&&reserve>0))throw Error('GRID_QUOTA_POLICY_INVALID');
  const until=new Date(p.valid_until).toISOString();
  return JSON.stringify({domain_id:p.domain_id,provider:p.provider,total_units:p.total_units,valid_until:until,
    window_ms:p.window_ms,worker_limit_units:p.worker_limit_units,worker_protective_reserve_units:p.worker_protective_reserve_units});
}
export function quotaPolicyDigest(p:QuotaPolicy):string{return createHash('sha256').update(canonicalQuotaPolicy(p)).digest('hex');}
export function validateQuotaPolicies(policies:readonly QuotaPolicy[],now:number){
  if(policies.length!==2||new Set(policies.map(p=>p.provider)).size!==2)throw Error('GRID_QUOTA_POLICY_INVALID');
  for(const p of policies){const until=new Date(p.valid_until).getTime();
    if(until<=now||until>now+90*86400000||quotaPolicyDigest(p)!==p.policy_digest)throw Error('GRID_QUOTA_POLICY_INVALID');
  }
}
/** Exclusive host fence already held. Existing buckets and backoff are never rewritten. */
export async function replaceQuotaPolicies(c:PoolClient,owner:VerifiedOwnerContext,policies:readonly QuotaPolicy[]){
  requireVerifiedOwner(owner,'quota_policy','all');
  const now=new Date((await c.query('SELECT clock_timestamp() AS now')).rows[0].now).getTime();
  validateQuotaPolicies(policies,now);
  const {ownerParamsDigest}=await import('./owner-auth');
  const policyDigests=policies.map(p=>p.policy_digest).sort();
  if(ownerParamsDigest('quota_policy',{policyDigests})!==owner.paramsDigest)throw Error('GRID_RECEIPT_PARAMS');
  await c.query("SELECT grid_worker_consume_receipt($1::uuid,'quota_policy','all',$2)",[owner.receiptId,owner.paramsDigest]);
  for(const p of [...policies].sort((a,b)=>a.provider.localeCompare(b.provider))){
    await c.query(`INSERT INTO grid_worker_quota_policy(provider,domain_id,window_ms,total_units,worker_limit_units,worker_protective_reserve_units,policy_digest,valid_until)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(provider,domain_id) DO UPDATE SET window_ms=EXCLUDED.window_ms,
      total_units=EXCLUDED.total_units,worker_limit_units=EXCLUDED.worker_limit_units,
      worker_protective_reserve_units=EXCLUDED.worker_protective_reserve_units,policy_digest=EXCLUDED.policy_digest,valid_until=EXCLUDED.valid_until`,
      [p.provider,p.domain_id,p.window_ms,p.total_units,p.worker_limit_units,p.worker_protective_reserve_units,p.policy_digest,p.valid_until]);
  }
  return {policyDigests};
}
