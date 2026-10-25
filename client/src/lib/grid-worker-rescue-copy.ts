import {botName,relativeAge} from './grid-worker-copy';
import type {WorkerPresentation,WorkerStatus} from './grid-worker-view';
import type {WorkerRescue} from './grid-worker-rescue-wire';
export const rescueCopy={
  lead:"The main app takes over from the worker and tries to cancel this bot's orders and close its position with market orders. Part of the position may stay open.",
  screen:'Keep this page open and the screen on. If no page continues the rescue, it ends when its control expires. Orders already sent can still fill.',
  funds:"Rescue close doesn't transfer funds out of this bot's account. Returning any balance waits for the worker to finish Stop.",
  pause: 'New activity for your other bots stays paused until you press Resume.',
  takeover: 'After takeover, new activity pauses for all bots. Your other bots have no automatic stop until the worker takes back control. That can take longer than the rescue.',
  queued:"Stop is queued for this bot; it won't resume.",
  restart:'If the worker is running, it loses control and raises an alert. It must restart before taking control again.',
  uncertain:"We couldn't confirm whether the rescue started. Check again before trying another rescue.",
  watching:"This page isn't continuing the rescue.",
  unknownPhase:'Latest progress unavailable. Checking rescue status',
  unavailable:"Rescue close isn't available right now.",
  stale:"Automatic stops aren't confirmed. Last known status is shown.",
  stops:'No bot has an automatic stop until the worker takes back control',
  settlement:'The worker must settle the unknown order before it can take back control.',
  locked:'Other actions for this bot wait until the rescue close ends.',
  unknownLocked:'Other actions for this bot wait until the rescue close outcome is settled.',
  prepare:"Couldn't prepare the signature. Refresh and try again.",
  cancelled:'Rescue not started. You cancelled the signature.',
  expired:'The signature took too long, so nothing was sent. Try again.',
  starting:'Rescue sent. Waiting for the main app to take over.',
  recovered:'The rescue started. This page is running it.',
  stepUnavailable:"The main app isn't answering. Check again.",
  superseded:'This rescue close was replaced by a newer one.',
};
export const rescueTriggers:Readonly<Record<string,string>>={
  worker_unavailable:"The worker isn't available to run this bot's stop. The main app can try to close it.",
  worker_stalled:"The worker's checks for this bot are late, so its stop may not run. The main app can try to close it.",
  stop_failed:"This bot's stop didn't finish, so a position may still be open. The main app can try to close it.",
  protective_failure:"Cancelling orders or closing a position didn't finish, so a position may still be open. The main app can try to close it.",
};
export const rescueBlockers:Readonly<Record<string,string>>={
  automated_trading_off:'Rescue close needs Automated Trading on for your wallet. Turning it on in Settings → Security also lets your other bots trade again.',
  emergency_stop:"Rescue close can't run while an emergency stop is on for your wallet. It can't be cleared from the app.",
  trading_off:"Rescue close can't run while worker trading is switched off.",
  other_rescue:'A rescue close is already running. Only one runs at a time.',
  other_unknown:'A rescue close has an unknown outcome. That has to be settled first.',
  handover:"Rescue close can't start while a handover is requested.",
  protective_holder_active:'The previous rescue still holds control. Check again before starting another rescue.',
};
export const rescueRefusals:Readonly<Record<string,string>>={
  automated_trading_off:"Rescue not started. Automated Trading is off for your wallet, so the main app can't place orders for this bot. Turning it on in Settings → Security also lets your other bots trade again.",
  emergency_stop:"Rescue not started. An emergency stop is on for your wallet, and it can't be cleared from the app.",
  trading_off:'Rescue not started. Worker trading is switched off.',
  other_rescue:'Rescue not started. Another rescue close started first.',
  other_unknown:'Rescue not started. An earlier rescue outcome still needs to be settled.',
  handover:'Rescue not started. A handover is requested.',
  protective_holder_active:'Rescue not started. The previous rescue still holds control.',
  wait_too_long:'Rescue not started. Orders the worker already sent need longer to settle than a rescue can run. Try again in a few minutes.',
  nothing_to_close:'Nothing to close. This bot has already stopped.',
  changed:'Rescue not started. Status changed. Refresh and try again.',
  unknown:'Rescue not started. Refresh status before trying again.',
};
export const rescuePhases:Readonly<Record<string,string>>={
  taking_over:'Waiting for the main app to take over.',
  waiting:'Waiting for orders the worker already sent to settle, so nothing is sent twice.',
  settling:'Checking orders already sent, so nothing is sent twice.',
  cancelling:"Cancelling this bot's orders.",closing:"Closing this bot's position.",verifying:'Checking Pacifica.',
};
export function rescueStale(p:WorkerPresentation){return p.overlay==='stale'||p.overlay==='checking'||p.elapsedSeconds>=60;}
export function rescueStops(p:WorkerPresentation){return !rescueStale(p)&&p.status?.stopsAllowed===false?rescueCopy.stops:rescueCopy.stale;}
export function rescueOutcome(r:WorkerRescue,elapsed=0){
  const age=r.completedSeconds===null?null:r.completedSeconds+elapsed<60?'under a minute':relativeAge(r.completedSeconds+elapsed);
  if(r.phase==='complete'&&!r.unknownOpen)return age===null?'Rescue close finished. Completion time unavailable.':`Rescue close finished ${age} ago`;
  return "The rescue close ended without confirming this bot closed."+(age===null?' Completion time unavailable.':` Finished ${age} ago`);
}
export function rescuePhoneWarnings(s:WorkerStatus,names:ReadonlyMap<string,string>,botId?:string){
  if(s.rescueAlertsPhone===true)return [];
  const ids=new Set(s.incidents.filter(i=>i.code==='protective_failure'&&i.resolved_at===null&&i.bot_id).map(i=>i.bot_id!));
  if(s.rescue&&!s.rescue.live&&(s.rescue.phase!=='complete'||s.rescue.unknownOpen)&&(s.rescue.unknownOpen||s.rescue.completedSeconds===null||s.rescue.completedSeconds<1800))ids.add(s.rescue.botId);
  return [...ids].filter(id=>!botId||id===botId).map(id=>`A rescue close on ${botName(names,id)} ended without finishing. Phone delivery isn't confirmed. Check here.`);
}
export function rescueBotLocked(s:WorkerStatus|null,botId:string){
  return !!s&&(!!s.rescue&&(s.rescue.unknownOpen||s.rescue.botId===botId&&s.rescue.live)||s.rescue==null&&s.resetBlockedBy.includes('rescue'));
}
