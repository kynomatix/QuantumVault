import {createHash} from 'node:crypto';
import {canonicalControlPolicy,controlParams,controlBlockers,type ControlQuotaPolicy,type HostTransitionParams} from '../../shared/grid-worker-controls';
import {emptyControl,type ControlKind} from '../../client/src/lib/grid-worker-controls-state';
import type {ControlChallengeRequest} from '../../client/src/lib/grid-worker-controls-wire';
import {controlLabels,refusedControl,controlCopy} from '../../client/src/lib/grid-worker-controls-copy';
import {controlOffer} from '../../client/src/lib/grid-worker-controls-offer';
import {presentation,status,incident} from './grid-worker-u5b-fixtures';
import {rescue} from './grid-worker-u6b-fixtures';
import type {WorkerPresentation} from '../../client/src/lib/grid-worker-view';
export const sha256=(text:string)=>createHash('sha256').update(text).digest('hex');
export function policy(provider:ControlQuotaPolicy['provider'],date='2026-11-04T00:00:00.000Z'):ControlQuotaPolicy {
  const row:ControlQuotaPolicy={provider,domain_id:'deployment',window_ms:60000,total_units:'1000',worker_limit_units:'500',worker_protective_reserve_units:'100',valid_until:date,policy_digest:sha256('EXAMPLE')};
  row.policy_digest=sha256(canonicalControlPolicy(row));return row;
}
export function controlsState(kind:ControlKind='handover',seconds=10*86400):WorkerPresentation {
  const params:HostTransitionParams={executionMode:'external',runMode:kind==='trading'?'trading':'test',executionEnabled:kind==='trading',legacyControlsEnabled:true,drainRequested:false,commitHash:sha256('EXAMPLE commit').slice(0,40),treeHash:sha256('EXAMPLE tree').slice(0,40),lockfileSha256:sha256('EXAMPLE lockfile'),expectedFencingEpoch:'9007199254740993',expectedScopeRevision:'9007199254740995'};
  const old=[policy('pacifica_rest'),policy('rpc_backup')],policies=[policy('pacifica_rest','2027-01-22T00:00:00.000Z'),policy('rpc_backup','2027-01-22T00:00:00.000Z')];
  return presentation({status:status({executionMode:kind==='handover'?'legacy':'external',cardState:kind==='handover'?'legacy_paused':'test',entriesPaused:true,pauseAckRevision:'3',host:{legacy_controls_enabled:true,observer_fenced:false},executionRestrictions:kind==='handover'?[]:['test'],stopsAllowed:false,
    hostTransitionOffer:kind==='renewal'?null:{direction:kind==='handover'?'to_test':'to_trading',params,scopeRevision:params.expectedScopeRevision,blockedBy:null,handover:'stop_sign_restart'},
    quotaPolicy:{available:true,providers:old.map(p=>({provider:p.provider,policy:p,validUntil:p.valid_until,policyDigest:p.policy_digest,secondsLeft:seconds})),earliestValidUntil:old[0].valid_until,earliestSecondsLeft:seconds,backoff:false},
    quotaRenewal:{policies,params:{policyDigests:policies.map(p=>p.policy_digest).sort()},blockedBy:null}})});
}
export function challenge(request:ControlChallengeRequest){return {message:['QV-OWNER-ACTION v1','action:'+request.action,'scope:grid_worker','target:all','nonce:'+'EXAMPLE'.repeat(6)+'X','issued:2026-10-25T00:00:00.000Z','expires:2026-10-25T00:02:00.000Z','params:'+sha256(controlParams(request.action,request.params))].join('\n')};}
export function confirming(kind:ControlKind):WorkerPresentation {
  const p=controlsState(kind),o=controlOffer(p,kind)!;
  return {...p,confirmation:'control',control:{...emptyControl,kind,phase:'confirming',request:o.request,offerKey:o.key,message:challenge(o.request).message}};
}
export function controlsCases():[string,WorkerPresentation][] {
  const rows:[string,WorkerPresentation][]=[];
  for(const kind of ['handover','trading','renewal'] as const){
    rows.push([kind+'-ready',controlsState(kind)]);
    for(const phase of ['preparing','confirming','signing','sending','unknown','saved','refused'] as const){const p=confirming(kind);p.control={...p.control!,phase,checked:phase==='confirming',notice:phase==='unknown'?controlCopy.unknown:phase==='saved'?controlLabels[kind].done:phase==='refused'?refusedControl(kind,'changed'):''};rows.push([kind+'-'+phase,p]);}
    for(const blocker of controlBlockers){const p=controlsState(kind);if(kind==='renewal')p.status!.quotaRenewal!.blockedBy=blocker;else p.status!.hostTransitionOffer!.blockedBy=blocker;rows.push([kind+'-blocker-'+blocker,p]);const refused=controlsState(kind);refused.control={...emptyControl,kind,phase:'refused',notice:refusedControl(kind,blocker)};rows.push([kind+'-refused-'+blocker,refused]);}
  }
  for(const [name,seconds] of [['over-fortnight',15*86400],['fortnight',14*86400],['three-days',3*86400],['one-day',86400],['under-day',3600],['ended',0],['past-end',-10]] as const)rows.push(['limits-'+name,controlsState('renewal',seconds)]);
  const missing=controlsState();missing.status!.quotaPolicy={available:false,providers:[],earliestValidUntil:null,earliestSecondsLeft:null,backoff:false};missing.status!.quotaRenewal=null;rows.push(['limits-unavailable',missing]);
  for(const mode of ['offline','awaiting_worker','exec_off','needs_you','running','test'] as const){const p=controlsState('trading');p.status!.cardState=mode;p.status!.hostTransitionOffer!.blockedBy='unavailable';if(mode==='needs_you')p.status!.incidents=[incident()];rows.push(['mode-'+mode,p]);}
  for(const phase of ['live','unknown'] as const){const p=controlsState('trading');p.status!.rescue=rescue({live:phase==='live',unknownOpen:phase==='unknown'});p.status!.resetBlockedBy=[];rows.push(['rescue-'+phase,p]);}
  rows.push(['stale',{...controlsState(),overlay:'stale'}],['checking',{...controlsState(),overlay:'checking'}],['signature-busy',{...controlsState(),busy:true}],['wallet-changed',{...controlsState(),admitted:false}],['non-owner',presentation({admitted:false})],['dormant',presentation({status:status({executionMode:'legacy'})})],['legacy-off',presentation({status:status({executionMode:'legacy',host:{legacy_controls_enabled:false,observer_fenced:false}})})]);
  return rows;
}
