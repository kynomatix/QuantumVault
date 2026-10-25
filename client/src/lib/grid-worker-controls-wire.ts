import {canonicalControlPolicy,controlParams,controlBlockers,type HostTransitionOffer,type QuotaStatus,type QuotaRenewal} from '../../../shared/grid-worker-controls';
export interface WorkerControls {hostTransitionOffer:HostTransitionOffer|null;quotaPolicy:QuotaStatus;quotaRenewal:QuotaRenewal|null}
const blocked=(v:unknown)=>v===null||(controlBlockers as readonly unknown[]).includes(v);
export function parseWorkerControls(value:unknown):WorkerControls|null {
  try{
    if(!value||typeof value!=='object')return null;const r=value as WorkerControls;
    const q=r.quotaPolicy;if(!q||typeof q.available!=='boolean'||typeof q.backoff!=='boolean'||!Array.isArray(q.providers))return null;
    if(q.available){
      if(q.providers.length!==2||new Set(q.providers.map(p=>p.provider)).size!==2)return null;
      for(const p of q.providers){canonicalControlPolicy(p.policy);
        if(p.provider!==p.policy.provider||p.validUntil!==p.policy.valid_until||p.policyDigest!==p.policy.policy_digest||!Number.isSafeInteger(p.secondsLeft))return null;}
      if(q.earliestValidUntil!==q.providers.map(p=>p.validUntil).sort()[0]||q.earliestSecondsLeft!==Math.min(...q.providers.map(p=>p.secondsLeft)))return null;
    }else if(q.providers.length||q.earliestValidUntil!==null||q.earliestSecondsLeft!==null||r.quotaRenewal!==null)return null;
    if(r.quotaRenewal!==null){const n=r.quotaRenewal;
      if(!q.available||!n||!Array.isArray(n.policies)||n.policies.length!==2||new Set(n.policies.map(p=>p.provider)).size!==2||!blocked(n.blockedBy))return null;
      controlParams('quota_policy',n.params);
      if(JSON.stringify(n.params.policyDigests)!==JSON.stringify(n.policies.map(p=>p.policy_digest).sort()))return null;
      if(n.policies[0].valid_until!==n.policies[1].valid_until)return null;
      for(const p of n.policies){canonicalControlPolicy(p);const old=q.providers.find(v=>v.provider===p.provider)!.policy;
        if(canonicalControlPolicy({...p,valid_until:old.valid_until})!==canonicalControlPolicy(old))return null;
        if(n.blockedBy===null&&p.valid_until<=old.valid_until)return null;}
    }
    if(r.hostTransitionOffer!==null){const o=r.hostTransitionOffer;if(!o||!blocked(o.blockedBy)||o.handover!=='stop_sign_restart')return null;
      controlParams('host_transition',o.params);
      if(o.scopeRevision!==o.params.expectedScopeRevision||o.direction!==(o.params.runMode==='test'?'to_test':'to_trading')
        ||o.params.executionEnabled!==(o.params.runMode==='trading')||!o.params.legacyControlsEnabled||o.params.drainRequested)return null;}
    return {hostTransitionOffer:r.hostTransitionOffer,quotaPolicy:q,quotaRenewal:r.quotaRenewal};
  }catch{return null;}
}
export interface ControlChallengeRequest {action:'host_transition'|'quota_policy';target:'all';params:unknown;policies?:unknown[]}
export async function controlChallengeDigest(request:ControlChallengeRequest):Promise<string>{
  if(request.target!=='all')throw Error('Invalid target');
  const digest=async(s:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),n=>n.toString(16).padStart(2,'0')).join('');
  if(request.action==='quota_policy'){
    if(!request.policies||request.policies.length!==2)throw Error('Invalid policies');
    const ds=[];const providers=new Set();for(const p of request.policies){const d=await digest(canonicalControlPolicy(p));
      const row=p as {provider:string;policy_digest:string};if(d!==row.policy_digest)throw Error('Invalid digest');ds.push(d);providers.add(row.provider);}
    if(providers.size!==2||controlParams('quota_policy',{policyDigests:ds.sort()})!==controlParams('quota_policy',request.params))throw Error('Invalid params');
  }else if(request.policies!==undefined)throw Error('Invalid policies');
  return digest(controlParams(request.action,request.params));
}
