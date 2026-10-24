import type {PoolClient} from 'pg';
/** Proposed trigger floor; changing it requires review, not a schema change. */
export const RESCUE_TRIGGER_FLOOR_SECONDS=120;
export type RescueTrigger='worker_unavailable'|'worker_stalled'|'stop_failed'|'protective_failure';
export type RescueBlocker='automated_trading_off'|'emergency_stop'|'trading_off'|'other_rescue'|'other_unknown'|'handover';
export interface RescueOffer{botId:string;trigger:RescueTrigger;blockedBy:RescueBlocker|null}
export type RescuePhase='waiting'|'settling'|'cancelling'|'closing'|'verifying'|'complete'|'partial_ended'|'unknown_ended'|'ended';
export interface RescueView{
  requestId:string;requestKey:string;botId:string;phase:RescuePhase;live:boolean;unknownOpen:boolean;
  expiresInSeconds:number;completedSeconds:number|null;stepIdleSeconds:number|null;leaseRemainingSeconds:number|null;
  next:'step'|'wait'|'done';retryAfterSeconds:number;waitSeconds:number;
}
export class RescueRefusal extends Error{
  constructor(readonly code:RescueBlocker|'changed'|'wait_too_long'|'expired'|'lease_lost'|'superseded'|'not_owner'){super(code);}
}
function seconds(v:unknown):number|null{
  if(v===null||v===undefined)return null;
  const n=typeof v==='number'?v:typeof v==='string'&&/^-?\d+(\.\d+)?$/.test(v)?Number(v):NaN;
  return Number.isFinite(n)?Math.max(0,Math.ceil(n)):null;
}
/** One predicate for the offer and the exclusive takeover. No display-only eligibility. */
export async function rescueOffer(c:PoolClient,owner:string,botId:string):Promise<RescueOffer|null>{
  const r=(await c.query(`SELECT b.id,b.status,b.last_tick_at,w.execution_enabled AS automated,w.emergency_stop_triggered,
    h.*,h.lease_expires_at>clock_timestamp() AS holder_live,
    (h.heartbeat_at IS NULL OR h.heartbeat_at<=clock_timestamp()-make_interval(secs=>$3)) AS unavailable,
    (h.progress_at IS NULL OR h.progress_at<=clock_timestamp()-make_interval(secs=>$3)
      OR b.last_tick_at IS NULL OR b.last_tick_at<=clock_timestamp()-make_interval(secs=>$3)) AS stalled,
    EXISTS(SELECT 1 FROM grid_worker_incidents i WHERE i.bot_id=b.id AND i.code='stop_failed' AND i.resolved_at IS NULL) AS stop_failed,
    EXISTS(SELECT 1 FROM grid_worker_incidents i WHERE i.bot_id=b.id AND i.code='protective_failure' AND i.resolved_at IS NULL) AS protective_failure,
    EXISTS(SELECT 1 FROM grid_worker_requests r WHERE r.action='protective_close' AND r.state='admitted'
      AND r.expires_at>clock_timestamp() AND r.id=h.holder_boot_id AND h.holder_role='protective' AND h.lease_expires_at>clock_timestamp()) AS rescue_live,
    EXISTS(SELECT 1 FROM grid_worker_send_audit a WHERE a.sender_role='protective' AND a.outcome='unknown') OR
      EXISTS(SELECT 1 FROM grid_operations o WHERE o.state IN ('prepared','submitted','unconfirmed')
        AND o.exact_request->'authority'->>'protectiveRequestId' IS NOT NULL) AS protective_unknown
    FROM grid_bots b JOIN wallets w ON w.address=b.wallet_address JOIN grid_launch_accounts l ON l.bot_id=b.id
    JOIN grid_worker_owner ow ON ow.wallet_address=w.address CROSS JOIN grid_worker_host h
    WHERE b.id=$1 AND b.wallet_address=$2 AND h.owner_wallet=$2 AND l.released_at IS NULL`,[botId,owner,RESCUE_TRIGGER_FLOOR_SECONDS])).rows[0];
  if(!r||r.execution_mode!=='external'||r.run_mode!=='trading'||['draft','failed','stopped'].includes(r.status))return null;
  const liveWorker=r.holder_role==='grid-worker'&&r.holder_live;
  const trigger:RescueTrigger|null=r.stop_failed?'stop_failed':r.protective_failure?'protective_failure':!liveWorker&&r.unavailable?'worker_unavailable':liveWorker&&r.stalled?'worker_stalled':null;
  if(!trigger)return null;
  const blockedBy:RescueBlocker|null=!r.automated?'automated_trading_off':r.emergency_stop_triggered?'emergency_stop':!r.execution_enabled?'trading_off':
    r.rescue_live?'other_rescue':r.protective_unknown?'other_unknown':r.holder_role==='protective'&&r.holder_live?'handover':null;
  return {botId,trigger,blockedBy};
}
/** All predecessor windows, not only this request's sends. Missing window data denies. */
export async function rescueWait(c:PoolClient,botId:string,requestId?:string):Promise<number>{
  const rows=(await c.query(`SELECT exact_request FROM grid_operations WHERE bot_id=$1 AND state IN ('prepared','submitted','unconfirmed')`,[botId])).rows;
  const b=(await c.query(`SELECT extract(epoch FROM clock_timestamp())*1000 AS now,
    CASE WHEN lease_token IS DISTINCT FROM $2::uuid THEN extract(epoch FROM lease_expires_at)*1000 ELSE NULL END AS lease FROM grid_bots WHERE id=$1`,[botId,requestId??null])).rows[0];
  if(!b)return Infinity;
  let until=Number(b.now);if(b.lease!==null&&Number.isFinite(Number(b.lease)))until=Math.max(until,Number(b.lease));
  for(const {exact_request:r} of rows){
    if(!r||!Number.isSafeInteger(r.timestamp)||!Number.isSafeInteger(r.expiryMs)||r.expiryMs<1||r.expiryMs>15000)return Infinity;
    until=Math.max(until,r.timestamp+r.expiryMs+7000);
  }
  const audit=(await c.query(`SELECT extract(epoch FROM max(signed_expires_at))*1000 AS until FROM grid_worker_send_audit WHERE bot_id=$1`,[botId])).rows[0];
  if(audit?.until!==null)until=Math.max(until,Number(audit.until)+7000);
  return Math.max(0,Math.ceil((until-Number(b.now))/1000));
}
export async function rescueView(c:PoolClient,owner:string,requestKey?:string):Promise<RescueView|null>{
  const r=(await c.query(`SELECT r.*,h.holder_role,h.holder_boot_id,h.lease_expires_at>clock_timestamp() AS holder_live,
    r.expires_at>clock_timestamp() AS request_live,extract(epoch FROM r.expires_at-clock_timestamp()) AS remaining,
    extract(epoch FROM clock_timestamp()-r.completed_at) AS completed_seconds,
    CASE WHEN h.holder_boot_id=r.id THEN extract(epoch FROM clock_timestamp()-h.heartbeat_at) END AS idle,
    CASE WHEN h.holder_boot_id=r.id THEN extract(epoch FROM h.lease_expires_at-clock_timestamp()) END AS lease_remaining,
    EXISTS(SELECT 1 FROM grid_worker_send_audit a WHERE a.sender_role='protective' AND a.outcome='unknown') OR
      EXISTS(SELECT 1 FROM grid_operations o WHERE o.state IN ('prepared','submitted','unconfirmed')
        AND o.exact_request->'authority'->>'protectiveRequestId' IS NOT NULL) AS unknown_open
    FROM grid_worker_requests r CROSS JOIN grid_worker_host h WHERE r.owner_wallet=$1 AND r.action='protective_close'
      AND ($2::text IS NULL OR r.request_key=$2) ORDER BY r.created_at DESC,r.id DESC LIMIT 1`,[owner,requestKey??null])).rows[0];
  if(!r)return null;
  const live=r.state==='admitted'&&r.request_live&&r.holder_role==='protective'&&r.holder_boot_id===r.id&&r.holder_live;
  const terminal:RescuePhase=r.state==='complete'&&r.result_code==='complete'?'complete':r.unknown_open?'unknown_ended':r.result_code==='partial_ended'?'partial_ended':'ended';
  const phases=['waiting','settling','cancelling','closing','verifying'];
  const phase:RescuePhase=live?(phases.includes(r.result_code)?r.result_code:'waiting'):terminal;
  const wait=live?await rescueWait(c,r.bot_id,r.id):0;
  return {requestId:r.id,requestKey:r.request_key,botId:r.bot_id,phase,live,unknownOpen:r.unknown_open,
    expiresInSeconds:seconds(r.remaining)??0,completedSeconds:seconds(r.completed_seconds),stepIdleSeconds:seconds(r.idle),leaseRemainingSeconds:seconds(r.lease_remaining),
    next:live?(wait>0?'wait':'step'):'done',retryAfterSeconds:live?Math.min(10,Math.max(1,Number.isFinite(wait)?wait:10)):0,waitSeconds:Number.isFinite(wait)?wait:600};
}
