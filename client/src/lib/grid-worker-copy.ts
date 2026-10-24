import {workerCopyViolation} from '../../../shared/grid-worker-copy-check';
import {cardStates,currentPause,type WorkerPresentation,type WorkerStatus} from './grid-worker-view';
export const incidentCopy:Readonly<Record<string,{text:string;kind:'condition'|'event'|'notice'}>>=Object.freeze(Object.assign(Object.create(null),{
  lease_lost:{kind:'condition',text:"The worker lost its lease and shut down to stay safe. Stops don't run until a worker is back in control."},
  contender_seen:{kind:'event',text:"A second process tried to run your grid bots, or the worker's control record changed unexpectedly."},
  database_unavailable:{kind:'condition',text:"The worker couldn't reach its database."},
  clock_unhealthy:{kind:'condition',text:"The worker's clock went out of step with the database, so it shut down to stay safe."},
  progress_stale:{kind:'condition',text:"The worker stopped making progress on its bot checks."},
  stop_failed:{kind:'event',text:"A stop-loss or bot Stop didn't finish, so a position may still be open."},
  transfer_refused:{kind:'event',text:"The worker refused a funds transfer whose destination didn't match your account. That transfer wasn't sent."},
  authority_refused:{kind:'event',text:"The worker refused a request it couldn't verify. That request wasn't sent."},
  egress_refused:{kind:'event',text:"The worker blocked a connection to a server that isn't on its approved list."},
  pause_unacknowledged:{kind:'condition',text:"The worker hasn't confirmed this pause."},
  observer_silent:{kind:'condition',text:"The alert monitor has been silent for over 5 minutes, so new starts and resumes are on hold."},
  audit_mismatch:{kind:'event',text:"The worker's records don't match Pacifica's, so new activity on the affected bots is on hold."},
  reconciliation_unavailable:{kind:'condition',text:"The worker couldn't finish checking your Pacifica history, so new starts and resumes are on hold."},
  protective_failure:{kind:'event',text:"The worker couldn't finish cancelling orders or closing a position, so a position may still be open."},
  schema_drift:{kind:'condition',text:"The worker couldn't verify its database setup, so it shut down to stay safe. Stops don't run until it's back."},
  quota_pressure:{kind:'notice',text:"The worker is close to Pacifica's request limit and is slowing down."},
  notification_delayed:{kind:'notice',text:"A bot notification is taking longer than usual to send."},
  exposure_above_budget:{kind:'notice',text:"A bot is holding more than its planned budget. Nothing was closed because of it."},
}));
export const unknownIncident={kind:'event' as const,text:"The worker raised an alert this page doesn't recognise."};
export const outcomeCopy={
  prepare:"Couldn't prepare the signature. Refresh and try again.",
  expired:'The signature took too long, so nothing was sent. Try again.',
  pauseCancelled:'Pause not sent. You cancelled the signature.',
  resumeCancelled:'Resume not sent. You cancelled the signature.',
  ackCancelled:'Not acknowledged. You cancelled the signature.',
  refused:'This request did not save a pause. Refresh status before trying again.',
  changed:'Status changed. Refresh before trying Resume again.',
  ackFailed:"Couldn't acknowledge. Refresh and try again.",
  repaused:'The worker paused new activity again straight after the resume. Its own server pause setting may be on.',
};
export const relativeAge=(seconds:number|null)=>seconds===null?'not yet':seconds<5?'just now':seconds<90?`${Math.floor(seconds)} s`:seconds<5400?`${Math.floor(seconds/60)} min`:seconds<172800?`${Math.floor(seconds/3600)} h`:'over 2 days';
export const aged=(seconds:number|null,elapsed:number)=>seconds===null?null:Math.max(0,seconds+elapsed);
export function botName(names:ReadonlyMap<string,string>,id:string|null){const name=id?names.get(id):null;return name&&!workerCopyViolation(name)?name:'A grid bot';}
export function restrictionText(s:WorkerStatus):string[]{return s.executionRestrictions.map(r=>r==='test'?(s.executionMode==='external'?'Worker test mode: no orders or stops.':'Test mode: no orders or stops.'):
  r==='trading_off'?(s.executionMode==='external'?"Worker trading is off; stops won't run.":"Trading is off; stops won't run."):
  r==='drain'?'A handover has been requested. New activity is on hold, and stops and closes are restricted.':'Execution availability needs review.');}
export function resumeReason(s:WorkerStatus,stale:boolean):string {
  if(stale)return 'Resume opens once this page reaches the server again.';
  if(s.incidents.some(i=>!incidentCopy[i.code]))return 'This setup needs review before Resume is available.';
  if(s.incidents.some(i=>i.resolved_at===null&&incidentCopy[i.code]?.kind==='event'))return 'Resume stays locked until this alert has been reviewed and cleared.';
  const reason=s.resetBlockedBy[0];
  if(!reason)return '';
  return ({server_flag:"Resume is locked by the server's pause setting.",open_alert:'Resume opens once every alert is acknowledged and fixed.',review_required:'This setup needs review before Resume is available.',worker_checks:'Resume is waiting for the worker to be ready.',monitor_fence:'Resume opens once the desktop alert monitor checks in.',history_checks:'Resume opens once Pacifica history checks are complete.'} as Record<string,string>)[reason]??'This setup needs review before Resume is available.';
}
export function cardCopy(p:WorkerPresentation):{pill:string;sentence:string;tone:'red'|'amber'|'teal'|'primary'|'muted'} {
  const s=p.status;
  if(p.overlay==='stale'||p.overlay==='checking'||!s)return {pill:'Not checked recently',sentence:p.overlay==='checking'?'Checking the latest status…':"The latest status isn't confirmed. Last known information is shown below.",tone:'muted'};
  if(p.overlay==='signing')return {pill:'Check your wallet…',sentence:p.target?.action==='pause'?'Check your wallet to sign the pause.':p.target?.action==='reset_pause'?'Check your wallet to sign the resume.':'Check your wallet to acknowledge this alert.',tone:'primary'};
  if(p.overlay==='pausing')return {pill:'Pausing…',sentence:s.executionMode==='legacy'?'Pause sent. Waiting for the server to save it.':'Pause sent. Waiting for the server to save it and the worker to confirm.',tone:'amber'};
  if(p.overlay==='save_unknown')return {pill:'Pause not confirmed',sentence:"We couldn't tell whether the pause was saved. Check again, or pause again to be sure.",tone:'red'};
  if(p.overlay==='resuming')return {pill:'Resuming',sentence:'Resume sent. Waiting for the server to clear it.',tone:'amber'};
  switch(s.cardState){
    case 'offline':return {pill:'Offline or not responding',sentence:"The worker isn't available to run your bots. Orders already on Pacifica can still fill, and stops won't run until it's back.",tone:'red'};
    case 'exec_off':return {pill:'Trading switched off',sentence:s.executionMode==='external'?"Trading is switched off for the worker, so it won't run stops or place orders.":"Trading is switched off, so the main app won't run stops or place orders.",tone:'red'};
    case 'pause_unconfirmed':return {pill:'Pause not confirmed',sentence:currentPause(s)?"The pause is saved, but the worker hasn't confirmed it, so it may still place new entries.":"The worker hasn't confirmed this pause.",tone:'red'};
    case 'needs_you':return {pill:'Needs you',sentence:currentPause(s)?`New grid activity is paused, and ${s.unacknowledgedCritical} ${s.unacknowledgedCritical===1?'alert needs':'alerts need'} you.`:s.unacknowledgedCritical===1?'An alert needs you: acknowledge it below.':`${s.unacknowledgedCritical} alerts need you: acknowledge them below.`,tone:'red'};
    case 'check_bots':return {pill:'Check your bots',sentence:'A position may still be open. Check the bot named below, or close it on Pacifica.',tone:'red'};
    case 'test':return {pill:'Test mode, not trading',sentence:s.executionMode==='external'?"Test mode: the worker checks your grid bots but won't place orders or run stops.":"Test mode: the main app won't place orders or run stops.",tone:'primary'};
    case 'paused':case 'legacy_paused':return {pill:'New activity paused',sentence:'New grid activity is paused for all bots.'+(s.stopsAllowed&&s.executionRestrictions.length===0?(s.executionMode==='external'?' Stops and closes still run while the worker is online.':' Stops and closes still run while the main app is running.') :''),tone:'amber'};
    case 'attention_fence':return {pill:'Needs attention',sentence:'Start and resume are on hold until the alert monitor checks in.',tone:'amber'};
    case 'attention_history':return {pill:'Needs attention',sentence:'Exchange history checks are incomplete, so new starts and resumes are on hold.',tone:'amber'};
    case 'attention_checks':return {pill:'Needs attention',sentence:"The worker's checks are running late, so new starts and resumes are on hold.",tone:'amber'};
    case 'attention_drain':return {pill:'Needs attention',sentence:'A handover has been requested, so new starts and resumes are on hold.',tone:'amber'};
    case 'attention_open':return {pill:'Needs attention',sentence:'This setup needs attention before activity can resume.',tone:'amber'};
    case 'legacy':return {pill:'Main app in control',sentence:"The main app is running your grid bots. The worker isn't in control yet.",tone:'primary'};
    case 'running':return {pill:'Running normally',sentence:'The worker is checking your grid bots.',tone:'teal'};
    default:return {pill:'Not checked recently',sentence:"The latest status isn't confirmed. Last known information is shown below.",tone:'muted'};
  }
}
export function phoneState(p:WorkerPresentation):'none'|'stale'|'off'|'muted'|'legacy' {
  const s=p.status;if(!s)return 'none';
  if(s.executionMode==='legacy')return 'legacy';
  if(s.cardState==='offline')return 'none';
  if(p.overlay==='stale'||p.overlay==='checking'||!cardStates.includes(s.cardState as typeof cardStates[number]))return s.gridBotsAtRisk>0?'stale':'none';
  const age=aged(s.ages.monitorPollSeconds,p.elapsedSeconds);
  return age===null||age>=180?s.gridBotsAtRisk>0?'off':'muted':'none';
}
export function drawerCopy(p:WorkerPresentation,botId:string):string|null {
  const s=p.status;if(!s)return null;
  if(s.incidents.some(i=>i.bot_id===botId&&['stop_failed','protective_failure'].includes(i.code)&&i.resolved_at===null))return 'This bot has an open alert: a position may be open.';
  if(p.overlay==='stale'||p.overlay==='checking')return 'Grid worker status may be out of date.';
  if(p.overlay==='save_unknown')return "We couldn't tell whether the pause was saved.";
  if(s.cardState==='offline')return "The grid worker is offline; stops won't run.";
  const restriction=restrictionText(s);if(restriction.length)return restriction.join(' ');
  if(s.cardState==='pause_unconfirmed')return currentPause(s)?"Pause saved, but the worker hasn't confirmed it.":"The worker hasn't confirmed this pause.";
  if(s.unacknowledgedCritical>0||s.cardState==='check_bots')return 'A grid worker alert needs you. Close to see it.';
  if(p.overlay==='pausing')return 'Pausing new grid activity…';
  if(currentPause(s))return 'New grid activity is paused for all bots.';
  if(['attention_fence','attention_history','attention_checks','attention_drain'].includes(s.cardState))return 'New starts and resumes are on hold.';
  return phoneState(p)==='off'?'Phone alerts are off. FRACTAL may be asleep.':null;
}
