import {canonicalControlPolicy,type ControlQuotaPolicy,type QuotaStatus,type QuotaRenewal} from '../../shared/grid-worker-controls';
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
export function wirePolicy(p:QuotaPolicy):ControlQuotaPolicy {
  const wire={provider:p.provider,domain_id:p.domain_id,window_ms:p.window_ms,total_units:p.total_units,
    worker_limit_units:p.worker_limit_units,worker_protective_reserve_units:p.worker_protective_reserve_units,
    valid_until:new Date(p.valid_until).toISOString(),policy_digest:p.policy_digest} as ControlQuotaPolicy;
  canonicalControlPolicy(wire);
  if(quotaPolicyDigest(wire)!==wire.policy_digest)throw Error('GRID_QUOTA_POLICY_INVALID');
  return wire;
}
export async function quotaControls(c:PoolClient):Promise<{quotaPolicy:QuotaStatus;quotaRenewal:QuotaRenewal|null}>{
  const now=new Date((await c.query('SELECT clock_timestamp() AS now')).rows[0].now).getTime();
  const rows=(await c.query("SELECT * FROM grid_worker_quota_policy WHERE domain_id='deployment' ORDER BY provider")).rows;
  const unavailable={quotaPolicy:{available:false,providers:[],earliestValidUntil:null,earliestSecondsLeft:null,backoff:false},quotaRenewal:null};
  let policies:ControlQuotaPolicy[];
  try{policies=rows.map(wirePolicy);if(policies.length!==2||new Set(policies.map(p=>p.provider)).size!==2)return unavailable;}
  catch{return unavailable;}
  const providers=policies.map(policy=>({policy,provider:policy.provider,validUntil:policy.valid_until,
    secondsLeft:Math.floor((Date.parse(policy.valid_until)-now)/1000),policyDigest:policy.policy_digest}));
  const first=[...providers].sort((a,b)=>a.validUntil.localeCompare(b.validUntil))[0];
  const backoff=!!(await c.query("SELECT 1 FROM grid_worker_quota_windows WHERE domain_id='deployment' AND provider IN ('pacifica_rest','rpc_backup') AND backoff_until>clock_timestamp() LIMIT 1")).rowCount;
  const valid_until=new Date(Math.floor(now/86400000)*86400000+89*86400000).toISOString();
  const proposed=policies.map(p=>{const next={...p,valid_until};return {...next,policy_digest:quotaPolicyDigest(next)};});
  return {quotaPolicy:{available:true,providers,earliestValidUntil:first.validUntil,earliestSecondsLeft:first.secondsLeft,backoff},
    quotaRenewal:{policies:proposed,params:{policyDigests:proposed.map(p=>p.policy_digest).sort()},
      blockedBy:policies.some(p=>p.valid_until>=valid_until)?'already_renewed':null}};
}
/** Renew only. Policy row locks serialize both providers against debits and rate-limit backoff. */
export async function replaceQuotaPolicies(c:PoolClient,owner:VerifiedOwnerContext,policies:readonly QuotaPolicy[]){
  requireVerifiedOwner(owner,'quota_policy','all');
  const stored=(await c.query("SELECT * FROM grid_worker_quota_policy WHERE domain_id='deployment' ORDER BY provider FOR UPDATE")).rows.map(wirePolicy);
  const now=new Date((await c.query('SELECT clock_timestamp() AS now')).rows[0].now).getTime();
  validateQuotaPolicies(policies,now);
  if(stored.length!==2||new Set(stored.map(p=>p.provider)).size!==2)throw Error('GRID_QUOTA_POLICY_INVALID');
  const proposed=policies.map(wirePolicy),until=new Date(Math.floor(now/86400000)*86400000+89*86400000).toISOString();
  if(proposed[0].valid_until!==proposed[1].valid_until)throw Error('GRID_QUOTA_UNEQUAL_DATES');
  for(const p of proposed){
    const old=stored.find(s=>s.provider===p.provider);
    if(!old||canonicalQuotaPolicy({...p,valid_until:old.valid_until})!==canonicalQuotaPolicy(old))throw Error('GRID_QUOTA_CHANGED');
    if(p.valid_until<=old.valid_until)throw Error('GRID_QUOTA_NOT_EXTENDING');
    if(p.valid_until!==until)throw Error('GRID_QUOTA_CHANGED');
  }
  const {ownerParamsDigest}=await import('./owner-auth');
  const policyDigests=policies.map(p=>p.policy_digest).sort();
  if(ownerParamsDigest('quota_policy',{policyDigests})!==owner.paramsDigest)throw Error('GRID_RECEIPT_PARAMS');
  await c.query("SELECT grid_worker_consume_receipt($1::uuid,'quota_policy','all',$2)",[owner.receiptId,owner.paramsDigest]);
  for(const p of [...proposed].sort((a,b)=>a.provider.localeCompare(b.provider))){
    const old=stored.find(s=>s.provider===p.provider)!;
    await c.query(`UPDATE grid_worker_quota_windows SET policy_digest=$3 WHERE provider=$1 AND domain_id=$2 AND policy_digest=$4
      AND window_start+make_interval(secs=>2*window_ms/1000.0)>clock_timestamp()`,[p.provider,p.domain_id,p.policy_digest,old.policy_digest]);
    await c.query(`UPDATE grid_worker_quota_policy SET policy_digest=$3,valid_until=$4 WHERE provider=$1 AND domain_id=$2`,
      [p.provider,p.domain_id,p.policy_digest,p.valid_until]);
  }
  return {policyDigests};
}
