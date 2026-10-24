export const cardStates=['offline','exec_off','pause_unconfirmed','needs_you','check_bots','test','paused','legacy_paused','attention_fence','attention_history','attention_checks','attention_drain','attention_open','legacy','running'] as const;
export type WorkerCardState=typeof cardStates[number];
export type WorkerAction='pause'|'reset_pause'|'ack_critical';
export type WorkerOverlay='none'|'stale'|'checking'|'signing'|'pausing'|'save_unknown'|'resuming';
export interface WorkerIncident {
  id:string;bot_id:string|null;code:string;severity:string;canAcknowledge:boolean;
  acknowledged:boolean;seen:boolean;resolved_at:string|null;occurrence_count:number;
  first_seen_seconds:number|null;last_seen_seconds:number|null;resolved_seconds:number|null;
}
export interface WorkerStatus {
  cardState:string;executionMode:'external'|'legacy';entriesPaused:boolean;pauseRevision:string;pauseAckRevision:string|null;
  host:{legacy_controls_enabled:boolean;observer_fenced:boolean};executionRestrictions:string[];stopsAllowed:boolean;
  resetBlockedBy:string[];incidents:WorkerIncident[];incidentCounts:{critical?:number;warning?:number};
  unacknowledgedCritical:number;acknowledgedCritical:number;truncated:boolean;gridBotsAtRisk:number;
  cancellationsComplete:boolean;botsPaused:{paused:number;total:number};
  ages:{workerCheckInSeconds:number|null;monitorPollSeconds:number|null;observedAt:string};
}
export interface PauseOutcome {saved:boolean|'unknown';acknowledgementOutcome:'confirmed'|'not_required'|'not_confirmed'|'timeout';pauseRevision:string|null}
export interface WorkerTarget {action:WorkerAction;target:string}
export interface WorkerPresentation {
  status:WorkerStatus|null;admitted:boolean;overlay:WorkerOverlay;elapsedSeconds:number;
  target:WorkerTarget|null;outcome:PauseOutcome|null;notice:string;busy:boolean;
}
export function controlsVisible(s:WorkerStatus|null):boolean {return !!s&&(s.executionMode==='external'||s.executionMode==='legacy'&&s.host.legacy_controls_enabled===true);}
export function decimalCompare(a:string,b:string):number|null {
  if(!/^(0|[1-9][0-9]*)$/.test(a)||!/^(0|[1-9][0-9]*)$/.test(b))return null;
  return a.length===b.length?(a===b?0:a>b?1:-1):a.length>b.length?1:-1;
}
export function currentPause(s:WorkerStatus|null,revision?:string|null):boolean {
  if(!s||s.entriesPaused!==true)return false;
  return revision==null?decimalCompare(s.pauseRevision,s.pauseRevision)===0:(decimalCompare(s.pauseRevision,revision)??-1)>=0;
}
/** Revisions are deliberately outside the unchanged signed wire; check the challenge echo too. */
export function validWorkerChallenge(value:unknown,request:WorkerTarget&{expectedPauseRevision:string}):value is {message:string;expectedPauseRevision:string}{
  if(!value||typeof value!=='object')return false;
  const c=value as Record<string,unknown>;
  if(c.expectedPauseRevision!==request.expectedPauseRevision||typeof c.message!=='string')return false;
  const lines=c.message.split('\n');
  if(lines.length!==8||lines[0]!=='QV-OWNER-ACTION v1'||lines[1]!==`action:${request.action}`||lines[2]!=='scope:grid_worker'||lines[3]!==`target:${request.target}`||lines[7]!=='params:none')return false;
  if(!/^nonce:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(lines[4]))return false;
  if(!/^issued:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(lines[5])||!/^expires:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(lines[6]))return false;
  const issued=Date.parse(lines[5].slice(7)),expires=Date.parse(lines[6].slice(8));
  return Number.isFinite(issued)&&Number.isFinite(expires)&&new Date(issued).toISOString()===lines[5].slice(7)&&new Date(expires).toISOString()===lines[6].slice(8)&&expires>issued&&expires-issued<=120_000;
}
export function parseWorkerStatus(value:unknown):WorkerStatus|null {
  if(!value||typeof value!=='object')return null;
  const s=value as WorkerStatus;
  if(!['external','legacy'].includes(s.executionMode)||typeof s.cardState!=='string'||typeof s.entriesPaused!=='boolean'||
    typeof s.pauseRevision!=='string'||decimalCompare(s.pauseRevision,s.pauseRevision)!==0||!s.host||!s.ages||!s.botsPaused||
    !Array.isArray(s.incidents)||!Array.isArray(s.executionRestrictions)||!Array.isArray(s.resetBlockedBy)||
    typeof s.unacknowledgedCritical!=='number'||typeof s.acknowledgedCritical!=='number'||typeof s.truncated!=='boolean')return null;
  const count=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
  const age=(n:unknown)=>n===null||typeof n==='number'&&Number.isFinite(n)&&n>=0;
  if(typeof s.host.legacy_controls_enabled!=='boolean'||typeof s.host.observer_fenced!=='boolean'||typeof s.stopsAllowed!=='boolean'||typeof s.cancellationsComplete!=='boolean'||
    !count(s.unacknowledgedCritical)||!count(s.acknowledgedCritical)||!count(s.gridBotsAtRisk)||!count(s.botsPaused.paused)||!count(s.botsPaused.total)||
    !age(s.ages.workerCheckInSeconds)||!age(s.ages.monitorPollSeconds)||typeof s.ages.observedAt!=='string'||
    !s.incidentCounts||!Object.values(s.incidentCounts).every(count)||!s.executionRestrictions.every(r=>typeof r==='string')||!s.resetBlockedBy.every(r=>typeof r==='string')||
    s.pauseAckRevision!==null&&(typeof s.pauseAckRevision!=='string'||decimalCompare(s.pauseAckRevision,s.pauseAckRevision)!==0))return null;
  const incidents:WorkerIncident[]=[];
  for(const row of s.incidents){
    if(!row||typeof row.id!=='string'||row.bot_id!==null&&typeof row.bot_id!=='string'||typeof row.code!=='string'||typeof row.severity!=='string'||
      typeof row.canAcknowledge!=='boolean'||typeof row.acknowledged!=='boolean'||typeof row.seen!=='boolean'||!count(row.occurrence_count)||
      row.resolved_at!==null&&typeof row.resolved_at!=='string')return null;
    const ages=[row.first_seen_seconds,row.last_seen_seconds,row.resolved_seconds].map(n=>n===null?null:Number(n));
    if(!ages.every(age))return null;
    incidents.push({...row,first_seen_seconds:ages[0],last_seen_seconds:ages[1],resolved_seconds:ages[2]});
  }
  return {...s,incidents};
}
