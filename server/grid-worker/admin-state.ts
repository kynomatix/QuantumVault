import {transitionHistoryReady} from './transition-history';
import {quotaControls} from './quota-policy';
import {hostTransitionOffer} from './host-transition';
import type {PoolClient} from 'pg';
import {GRID_WORKER_REQUIRED_CAPABILITIES} from './boot';
import {SCHEMA_MIGRATION_MANIFEST} from '../schema-migration-manifest';
import {probeSchemaMigrationManifest} from '../schema-readiness-probe';
import {mainIdentityMatches} from './main-readiness-identity';
import {OWNER_MASTER_PUBLIC_KEYS} from './owner-master-keys';
import {RECONCILIATION_STREAMS} from './reconciliation';
import {CRITICAL_PRIORITY} from './incident-policy';
import {checksFresh} from './status';
import {rescueView,rescueOffer} from './rescue-state';

export type ResetBlocker='server_flag'|'open_alert'|'review_required'|'worker_checks'|'monitor_fence'|'history_checks'|'rescue';
export type CardState='awaiting_worker'|'offline'|'exec_off'|'pause_unconfirmed'|'needs_you'|'check_bots'|'test'|'paused'|'legacy_paused'
  |'attention_fence'|'attention_history'|'attention_checks'|'attention_drain'|'attention_open'|'legacy'|'running'|'rescue_running'|'rescue_unknown';
export interface AdminFacts {
  host:Record<string,any>; catalog:boolean; identity:boolean; history:boolean; ownerKeys:boolean;
  unacknowledged:boolean; unresolved:boolean; protective:boolean; pauseUnconfirmed:boolean; botChecksFresh:boolean;
  rescueLive?:boolean;rescueUnknown?:boolean;
}
export function executionRestrictions(f:AdminFacts):('trading_off'|'test'|'drain')[]{
  const h=f.host, result:('trading_off'|'test'|'drain')[]=[];
  if(!h.execution_enabled)result.push('trading_off');
  if(h.run_mode!=='trading')result.push('test');
  if(h.drain_requested)result.push('drain');
  return result;
}
/** This function is shared by status and reset; a display can never bypass a reset predicate. */
export function resetBlockedBy(f:AdminFacts,entriesPaused:boolean):ResetBlocker[]{
  const h=f.host,external=h.execution_mode==='external',blocked:ResetBlocker[]=[];
  if(entriesPaused)blocked.push('server_flag');
  if(f.rescueLive||f.rescueUnknown)blocked.push('rescue');
  if(f.unacknowledged)blocked.push('open_alert');
  if(f.unresolved||!f.catalog||!f.identity||external&&(!h.authority_tracking_enabled||h.start_scope!=='owner_allowlist')
    ||!f.ownerKeys||!external&&!h.legacy_controls_enabled)blocked.push('review_required');
  if(external&&(h.holder_role!=='grid-worker'||!h.holder_live||!h.heartbeat_fresh||!h.progress_fresh||h.drain_requested))blocked.push('worker_checks');
  if(external&&h.observer_fenced)blocked.push('monitor_fence');
  if(!f.history)blocked.push('history_checks');
  return blocked;
}
export function ownerCardState(f:AdminFacts,blocked:readonly ResetBlocker[]):CardState{
  const h=f.host,external=h.execution_mode==='external';
  if(f.rescueLive)return 'rescue_running';
  if(f.rescueUnknown)return 'rescue_unknown';
  if(external&&(h.holder_role!=='grid-worker'||!h.holder_live||!h.heartbeat_online)){
    if(!h.awaiting_worker)return 'offline';
    if(f.unacknowledged)return 'needs_you';
    if(f.protective)return 'check_bots';
    if(f.unresolved)return 'attention_open';
    return h.awaiting_worker===true?'awaiting_worker':'offline';
  }
  if(!h.execution_enabled)return 'exec_off';
  if(external&&h.entries_paused&&String(h.pause_ack_revision)!==String(h.pause_revision)&&f.pauseUnconfirmed)return 'pause_unconfirmed';
  if(f.unacknowledged)return 'needs_you';
  if(f.protective)return 'check_bots';
  if(h.run_mode!=='trading')return 'test';
  if(h.drain_requested)return 'attention_drain';
  if(h.entries_paused){
    if(!external)return 'legacy_paused';
    if(String(h.pause_ack_revision)===String(h.pause_revision))return 'paused';
    return 'pause_unconfirmed';
  }
  if(external&&h.observer_fenced)return 'attention_fence';
  if(!f.history)return 'attention_history';
  if(external&&(!h.heartbeat_fresh||!h.progress_fresh||!f.botChecksFresh))return 'attention_checks';
  if(f.unresolved||blocked.length)return 'attention_open';
  return external?'running':'legacy';
}
export async function readAdminFacts(c:PoolClient):Promise<AdminFacts>{
  const host=(await c.query(`SELECT *,lease_expires_at>clock_timestamp() AS holder_live,
    heartbeat_at BETWEEN clock_timestamp()-interval '45 seconds' AND clock_timestamp() AS heartbeat_online,
    heartbeat_at BETWEEN clock_timestamp()-interval '15 seconds' AND clock_timestamp() AS heartbeat_fresh,
    progress_at BETWEEN clock_timestamp()-interval '30 seconds' AND clock_timestamp() AS progress_fresh,
    clock_timestamp() AS observed_at,
    EXTRACT(epoch FROM clock_timestamp()-heartbeat_at) AS worker_check_in_seconds,
    EXTRACT(epoch FROM clock_timestamp()-last_healthz_poll_at) AS monitor_poll_seconds
    FROM grid_worker_host WHERE singleton_id=1`)).rows[0];
  if(!host)throw Error('GRID_ADMIN_HOST_MISSING');
  host.awaiting_worker=host.execution_mode==='external'&&host.holder_boot_id===null&&!!(await c.query(`SELECT 1 FROM (
    SELECT consumed_at FROM owner_action_receipts WHERE action='host_transition' AND target='all' AND owner_wallet=$1 AND consumed_at IS NOT NULL
    ORDER BY consumed_at DESC LIMIT 1) latest WHERE consumed_at BETWEEN clock_timestamp()-interval '120 seconds' AND clock_timestamp()
    AND ($2::timestamptz IS NULL OR $2::timestamptz<consumed_at)`,[host.owner_wallet,host.heartbeat_at])).rowCount;
  const botChecks=(await c.query(`SELECT last_tick_at,clock_timestamp() AS checked_at FROM grid_bots
    WHERE status NOT IN ('draft','failed','stopped')`)).rows;
  const botChecksFresh=botChecks.every(b=>checksFresh([b.last_tick_at===null?null:new Date(b.last_tick_at).getTime()],new Date(b.checked_at).getTime()));
  const required=new Set<string>(GRID_WORKER_REQUIRED_CAPABILITIES);let databaseFailure:unknown=null;
  const catalog=await probeSchemaMigrationManifest(async(text,values)=>{
    try{return await c.query(text,values?[...values]:undefined);}catch(error){databaseFailure??=error;throw error;}
  },SCHEMA_MIGRATION_MANIFEST.filter(entry=>entry.capabilities.some(capability=>required.has(capability))));
  if(databaseFailure)throw databaseFailure;
  const incidents=(await c.query(`SELECT code,severity,acknowledged_at,resolved_at FROM grid_worker_incidents
    WHERE (severity='critical' OR NOT(code=ANY(SELECT jsonb_array_elements_text($1::jsonb))))
      AND (acknowledged_at IS NULL OR resolved_at IS NULL)`,[JSON.stringify([...CRITICAL_PRIORITY,'exposure_above_budget','quota_pressure','notification_delayed'])])).rows;
  // Legacy controls have no worker history producer. Their per-bot launch/entry checks still apply.
  const history=host.execution_mode==='legacy'||await transitionHistoryReady(c);
  const rescue=await rescueView(c,host.owner_wallet);
  return {host,rescueLive:rescue?.live??false,rescueUnknown:rescue?.unknownOpen??false,catalog:!catalog.unavailableCapabilities.some(x=>required.has(x)),identity:host.execution_mode==='legacy'||mainIdentityMatches(host),history,
    ownerKeys:host.execution_mode==='legacy'||OWNER_MASTER_PUBLIC_KEYS.length>0,
    unacknowledged:incidents.some(i=>i.acknowledged_at===null),unresolved:incidents.some(i=>i.resolved_at===null),
    protective:incidents.some(i=>['stop_failed','protective_failure'].includes(i.code)&&i.resolved_at===null),
    pauseUnconfirmed:incidents.some(i=>i.code==='pause_unacknowledged'),botChecksFresh};
}
export async function pauseCompletion(c:PoolClient,revision:string){
  return (await c.query(`SELECT count(*)::integer AS total,
    count(*) FILTER(WHERE EXISTS(SELECT 1 FROM grid_control_keys k JOIN grid_control_requests r ON r.id=k.control_id
      WHERE k.bot_id=b.id AND k.request_key='host-pause:'||$1||':'||b.id::text AND r.state='complete'))::integer AS paused
    FROM grid_bots b WHERE b.status NOT IN ('draft','failed','stopped','stopping')`,[revision])).rows[0] as {total:number;paused:number};
}
/** Warnings remain retained; seen warnings older than 24h are omitted from the inbox, never criticals. */
export async function adminStatus(c:PoolClient,entriesPaused:boolean){
  const facts=await readAdminFacts(c),h=facts.host,blocked=resetBlockedBy(facts,entriesPaused);
  const rescue=await rescueView(c,h.owner_wallet),rescueOffers=[];
  for(const b of (await c.query('SELECT id FROM grid_bots WHERE wallet_address=$1 ORDER BY id',[h.owner_wallet])).rows){
    const offer=await rescueOffer(c,h.owner_wallet,b.id);if(offer)rescueOffers.push(offer);
  }
  const effectiveSeverity=`CASE WHEN severity='critical' OR NOT(code IN ('exposure_above_budget','quota_pressure','notification_delayed')) THEN 'critical' ELSE severity END`;
  const incidentWhere=`(${effectiveSeverity}='critical' AND (acknowledged_at IS NULL OR resolved_at IS NULL OR inbox_seen_at IS NULL))
    OR (${effectiveSeverity}<>'critical' AND (inbox_seen_at IS NULL OR last_seen_at>=clock_timestamp()-interval '24 hours'))`;
  const incidents=(await c.query(`SELECT id,bot_id,${effectiveSeverity} AS severity,code,occurrence_count,first_seen_at,last_seen_at,resolved_at,acknowledged_at,inbox_seen_at,
    acknowledged_at IS NOT NULL AS acknowledged,inbox_seen_at IS NOT NULL AS seen,
    severity='critical' AND acknowledged_at IS NULL AS "canAcknowledge",
    EXTRACT(epoch FROM clock_timestamp()-first_seen_at) AS first_seen_seconds,
    EXTRACT(epoch FROM clock_timestamp()-last_seen_at) AS last_seen_seconds,
    EXTRACT(epoch FROM clock_timestamp()-resolved_at) AS resolved_seconds
    FROM grid_worker_incidents WHERE ${incidentWhere}
    ORDER BY CASE WHEN ${effectiveSeverity}='critical' THEN 0 ELSE 1 END,first_seen_at DESC,id LIMIT 100`)).rows;
  for(const incident of incidents){
    if(incident.code!=='lease_lost')continue;
    const proven=(await c.query(`SELECT 1 FROM grid_worker_incidents i JOIN grid_worker_requests r
      ON r.action='protective_close' AND i.first_seen_at BETWEEN r.admitted_at AND r.admitted_at+interval '60 seconds'
      CROSS JOIN grid_worker_host h WHERE i.id=$1 AND
      (h.holder_role='protective' AND h.holder_boot_id=r.id AND h.fencing_epoch=i.fencing_epoch+1
       OR EXISTS(SELECT 1 FROM grid_worker_send_audit a WHERE a.request_id=r.id AND a.sender_role='protective'
         AND a.fencing_epoch=i.fencing_epoch+1)) LIMIT 1`,[incident.id])).rowCount;
    if(proven)incident.afterRescue=true;
  }
  const counts=(await c.query(`SELECT ${effectiveSeverity} AS severity,count(*)::integer AS count,
    count(*) FILTER(WHERE acknowledged_at IS NULL)::integer AS unacknowledged,
    count(*) FILTER(WHERE acknowledged_at IS NOT NULL)::integer AS acknowledged
    FROM grid_worker_incidents WHERE ${incidentWhere} GROUP BY ${effectiveSeverity}`)).rows;
  const botsPaused=await pauseCompletion(c,String(h.pause_revision));
  const risk=(await c.query(`SELECT count(*)::integer AS n FROM grid_bots b LEFT JOIN grid_monitor_state m ON m.bot_id=b.id
    WHERE b.status NOT IN ('draft','failed','stopped','paused') OR
      (m.observation->'position' IS NOT NULL AND m.observation->'position'<>'null'::jsonb
       AND COALESCE(m.observation->'position'->>'size','unknown')!~ '^-?0(\\.0+)?$')`)).rows[0].n;
  const age=(value:unknown)=>value===null||!Number.isFinite(Number(value))?null:Math.max(0,Math.floor(Number(value)));
  // Explicit allowlist: no owner keys or database identity escape into the card payload.
  const safeHost=Object.fromEntries(['execution_mode','run_mode','execution_enabled','entries_paused','observer_fenced','legacy_controls_enabled',
    'pause_revision','pause_ack_revision','pause_ack_at','last_healthz_poll_at','heartbeat_at','progress_at','observed_at','holder_live'].map(k=>[k,h[k]]));
  const controls=await quotaControls(c),offer=await hostTransitionOffer(c);
  const limits=controls.quotaPolicy.available&&controls.quotaPolicy.providers.every(p=>p.secondsLeft>0);
  const restrictions:string[]=executionRestrictions(facts);
  if(!controls.quotaPolicy.available)restrictions.push('limits_unavailable');else if(!limits)restrictions.push('limits_expired');
  const critical=counts.find(r=>r.severity==='critical');
  const stopsAllowed=limits&&!controls.quotaPolicy.backoff&&restrictions.length===0&&facts.catalog&&facts.identity&&facts.ownerKeys&&
    (h.execution_mode==='legacy'?h.legacy_controls_enabled===true:
      h.holder_role==='grid-worker'&&h.holder_live===true&&h.heartbeat_fresh===true&&h.progress_fresh===true&&facts.botChecksFresh&&h.authority_tracking_enabled===true);
  return {...controls,hostTransitionOffer:offer,host:safeHost,incidents,cardState:ownerCardState(facts,blocked),resetBlockedBy:blocked,rescue,rescueOffers,rescueAlertsPhone:false,
    executionRestrictions:restrictions,stopsAllowed,
    unacknowledgedCritical:Number(critical?.unacknowledged??0),acknowledgedCritical:Number(critical?.acknowledged??0),
    truncated:counts.reduce((n,r)=>n+Number(r.count),0)>incidents.length,
    incidentCounts:Object.fromEntries(counts.map(r=>[r.severity,r.count])),gridBotsAtRisk:Number(risk),botsPaused,
    cancellationsComplete:botsPaused.paused===botsPaused.total,executionMode:h.execution_mode,entriesPaused:h.entries_paused,
    pauseRevision:String(h.pause_revision),pauseAckRevision:h.pause_ack_revision===null?null:String(h.pause_ack_revision),
    ages:{workerCheckInSeconds:age(h.worker_check_in_seconds),monitorPollSeconds:age(h.monitor_poll_seconds),observedAt:h.observed_at}};
}
