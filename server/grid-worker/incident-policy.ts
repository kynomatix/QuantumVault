import type {PoolClient} from 'pg';
/** Fixed priority and resolution rules. Recovery never acknowledges an occurrence. */
export const INCIDENT_RESOLUTION = Object.freeze({
  lease_lost: 'condition: current holder and epoch renewed successfully',
  contender_seen: 'event: retained contender evidence must be reconciled by a separately reviewed recovery; U5 keeps it latched',
  database_unavailable: 'condition: catalog and database probe successful',
  clock_unhealthy: 'condition: database and monotonic clock bounds verified',
  schema_drift: 'condition: catalog and build identity verified',
  progress_stale: 'condition: a successful supervisor pass within 30 seconds',
  stop_failed: 'event: fresh identity-bound venue-flat proof with no unknown operations, or terminal stopped; never auto-acknowledged',
  transfer_refused: 'event: exact refusal requires reviewed authority and transfer reconciliation; latched in U5',
  authority_refused: 'event: exact refusal requires reviewed authority reconciliation; latched in U5',
  egress_refused: 'event: exact refused destination and payload require security review; latched in U5',
  pause_unacknowledged: 'condition: the current paused revision is acknowledged, or an owner reset cleared the latch',
  observer_silent: 'condition: exact health GET received since acquisition within 60 seconds',
  audit_mismatch: 'event: complete retained audit must be reconciled; U7 recovery, latched in U5',
  reconciliation_unavailable: 'condition: complete reconciliation pass successful',
  protective_failure: 'event: fresh identity-bound venue-flat proof with no unknown operations, or terminal stopped; never auto-acknowledged',
} as const);
export type CriticalIncidentCode = keyof typeof INCIDENT_RESOLUTION;
export const CRITICAL_PRIORITY = Object.freeze(Object.keys(INCIDENT_RESOLUTION) as CriticalIncidentCode[]);
export function priorityIncident(codes: readonly string[]): CriticalIncidentCode | null {
  return CRITICAL_PRIORITY.find(code => codes.includes(code)) ?? null;
}
/** Call only after successful renewal, catalog/identity and clock verification. Event codes are excluded. */
export async function resolveHealthyConditions(c:PoolClient,facts:{progress:boolean;reconciled:boolean}){
  const codes:CriticalIncidentCode[]=['lease_lost','database_unavailable','clock_unhealthy','schema_drift'];
  if(facts.progress)codes.push('progress_stale');
  if(facts.reconciled)codes.push('reconciliation_unavailable');
  await c.query(`UPDATE grid_worker_incidents SET resolved_at=clock_timestamp() WHERE resolved_at IS NULL
    AND code IN (SELECT jsonb_array_elements_text($1::jsonb))`,[JSON.stringify(codes)]);
  await c.query(`UPDATE grid_worker_incidents SET resolved_at=clock_timestamp() WHERE code='pause_unacknowledged' AND resolved_at IS NULL
    AND EXISTS(SELECT 1 FROM grid_worker_host WHERE singleton_id=1 AND (NOT entries_paused OR pause_ack_revision=pause_revision))`);
}
