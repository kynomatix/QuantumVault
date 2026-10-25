import {canonicalObject} from '../../../shared/grid-worker-controls';
import {controlsVisible,type WorkerPresentation} from './grid-worker-view';
import {parseWorkerControls,type ControlChallengeRequest} from './grid-worker-controls-wire';
import type {ControlKind} from './grid-worker-controls-state';
export function controlOffer(p:WorkerPresentation,kind:ControlKind):{request:ControlChallengeRequest;key:string}|null {
  const s=p.status;
  if(!p.admitted||!s||!controlsVisible(s)||p.rescueUncertain||p.elapsedSeconds>=60||['stale','checking','save_unknown'].includes(p.overlay)||s.rescue?.live||s.rescue?.unknownOpen)return null;
  const wire=parseWorkerControls(s);if(!wire)return null;
  if(kind==='renewal'){
    const n=wire.quotaRenewal;if(!n||n.blockedBy!==null)return null;
    return {request:{action:'quota_policy',target:'all',params:n.params,policies:n.policies},key:JSON.stringify(n)};
  }
  const o=wire.hostTransitionOffer;
  if(!o||o.blockedBy!==null||!s.entriesPaused||o.direction!==(kind==='handover'?'to_test':'to_trading')||s.executionMode!==(kind==='handover'?'legacy':'external'))return null;
  return {request:{action:'host_transition',target:'all',params:o.params},key:canonicalObject(o.params as unknown as Record<string,unknown>)};
}
