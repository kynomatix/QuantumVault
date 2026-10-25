/** Closed wire vocabulary for the owner controls; unknown failures have no invented reason. */
export const controlBlockers=['not_flat','evidence_unavailable','changed','open_alert','needs_review','bots_active','settling',
  'limits_expired','limits_busy','identity','holder','worker_unhealthy','history','rescue','scope','expired',
  'not_paused','owner_key','tracking','drain','invalid','not_extending','unequal_dates','already_renewed','unavailable'] as const;
export type ControlBlocker=typeof controlBlockers[number];
export interface HostTransitionParams {
  executionMode:'external';runMode:'test'|'trading';executionEnabled:boolean;legacyControlsEnabled:boolean;drainRequested:boolean;
  commitHash:string;treeHash:string;lockfileSha256:string;expectedFencingEpoch:string;expectedScopeRevision:string;
}
export interface HostTransitionOffer {direction:'to_test'|'to_trading';params:HostTransitionParams;scopeRevision:string;
  blockedBy:ControlBlocker|null;handover:'stop_sign_restart'}
export interface ControlQuotaPolicy {provider:'pacifica_rest'|'rpc_backup';domain_id:'deployment';window_ms:number;
  total_units:string;worker_limit_units:string;worker_protective_reserve_units:string;valid_until:string;policy_digest:string}
export interface QuotaStatus {available:boolean;providers:{policy:ControlQuotaPolicy;provider:ControlQuotaPolicy['provider'];
  validUntil:string;secondsLeft:number;policyDigest:string}[];earliestValidUntil:string|null;earliestSecondsLeft:number|null;backoff:boolean}
export interface QuotaRenewal {policies:ControlQuotaPolicy[];params:{policyDigests:string[]};blockedBy:ControlBlocker|null}
export const canonicalObject=(r:Record<string,unknown>)=>JSON.stringify(Object.fromEntries(Object.keys(r).sort().map(k=>[k,r[k]])));
export function controlParams(action:'host_transition'|'quota_policy',value:unknown):string {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid control params');
  const p=value as Record<string,unknown>,keys=action==='quota_policy'?['policyDigests']:
    ['executionMode','runMode','executionEnabled','legacyControlsEnabled','drainRequested','commitHash','treeHash','lockfileSha256','expectedFencingEpoch','expectedScopeRevision'];
  if(Object.keys(p).sort().join(',')!==keys.sort().join(','))throw Error('Invalid control params');
  if(action==='quota_policy'){
    if(!Array.isArray(p.policyDigests)||p.policyDigests.length!==2||!p.policyDigests.every((s,i,a)=>typeof s==='string'&&/^[0-9a-f]{64}$/.test(s)&&(i===0||a[i-1]<s)))throw Error('Invalid control params');
  }else if(p.executionMode!=='external'||typeof p.runMode!=='string'||!['test','trading'].includes(p.runMode)
    ||!['executionEnabled','legacyControlsEnabled','drainRequested'].every(k=>typeof p[k]==='boolean')
    ||!['commitHash','treeHash'].every(k=>typeof p[k]==='string'&&/^[0-9a-f]{40}$/.test(p[k] as string))
    ||typeof p.lockfileSha256!=='string'||!/^[0-9a-f]{64}$/.test(p.lockfileSha256)
    ||!['expectedFencingEpoch','expectedScopeRevision'].every(k=>typeof p[k]==='string'&&/^(0|[1-9][0-9]*)$/.test(p[k] as string)&&BigInt(p[k] as string)<=9223372036854775807n))throw Error('Invalid control params');
  return canonicalObject(p);
}
export function canonicalControlPolicy(value:unknown):string {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid policy');
  const p=value as ControlQuotaPolicy;
  if(Object.keys(p).sort().join(',')!==['provider','domain_id','window_ms','total_units','worker_limit_units','worker_protective_reserve_units','valid_until','policy_digest'].sort().join(',')
    ||!['pacifica_rest','rpc_backup'].includes(p.provider)||p.domain_id!=='deployment'||!Number.isSafeInteger(p.window_ms)||p.window_ms<1||p.window_ms>60000
    ||typeof p.valid_until!=='string'||new Date(p.valid_until).toISOString()!==p.valid_until||typeof p.policy_digest!=='string'||!/^[0-9a-f]{64}$/.test(p.policy_digest)
    ||!['total_units','worker_limit_units','worker_protective_reserve_units'].every(k=>{const v=p[k as keyof ControlQuotaPolicy];return typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v)&&Number.isSafeInteger(Number(v));})
    ||!(Number(p.total_units)>Number(p.worker_limit_units)&&Number(p.worker_limit_units)>Number(p.worker_protective_reserve_units)&&Number(p.worker_protective_reserve_units)>0))throw Error('Invalid policy');
  const {policy_digest,...fields}=p;return canonicalObject(fields);
}
