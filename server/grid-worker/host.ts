import type { PoolClient } from 'pg';
import { gridActionAllowed, type GridAction, type KillContext } from './kill';
import { requireVerifiedOwner, type VerifiedOwnerContext } from './owner-receipts';
import { GRID_WORKER_CATALOG_CHECK_SQL } from './schema';

export interface WorkerHost {
  execution_mode: 'legacy' | 'external'; run_mode: 'test' | 'trading'; execution_enabled: boolean;
  entries_paused: boolean; drain_requested: boolean; observer_fenced: boolean; legacy_controls_enabled: boolean;
  authority_tracking_enabled: boolean; holder_boot_id: string | null; holder_role: string | null;
  fencing_epoch: string; holder_live: boolean; owner_wallet: string | null; pause_revision: string;
}
export async function readLegacyHost(c: PoolClient, phase = process.env.GRID_WORKER_DEPLOYMENT_PHASE ?? 'legacy'): Promise<WorkerHost | null> {
  const exists = (await c.query("SELECT to_regclass('grid_worker_host') IS NOT NULL AS present")).rows[0]?.present;
  if (!exists) { if (phase === 'legacy') return null; throw Error('GRID_WORKER_PACKAGE_REQUIRED'); }
  if (phase !== 'legacy' && !(await c.query(GRID_WORKER_CATALOG_CHECK_SQL)).rows[0]?.ok) throw Error('GRID_WORKER_SCHEMA_DRIFT');
  const host = (await c.query('SELECT *,lease_expires_at>clock_timestamp() AS holder_live FROM grid_worker_host WHERE singleton_id=1')).rows[0] as WorkerHost | undefined;
  if (!host) { if (phase === 'legacy') return null; throw Error('GRID_HOST_MISSING'); }
  if (host.execution_mode !== 'legacy' || host.holder_boot_id && host.holder_live) throw Error('GRID_MAIN_CONTENDER_SEEN');
  return host;
}
export function legacyKillContext(host: WorkerHost | null, overrides: Partial<KillContext> = {}): KillContext {
  return {
    role: 'legacy', executionMode: host?.execution_mode ?? 'legacy', legacyControlsEnabled: host?.legacy_controls_enabled ?? false,
    runMode: host?.run_mode ?? 'test', executionEnabled: host?.execution_enabled ?? false,
    entriesPaused: host?.entries_paused ?? true, drainRequested: host?.drain_requested ?? false, observerFenced: host?.observer_fenced ?? true,
    holderValid: !host?.holder_live, identityValid: true, authorityValid: true, alreadyOwned: true,
    terminalProof: false, scopeAndConsent: true, retainedAuthority: true, signedPolicy: true, protectiveDrain: false, ...overrides,
  };
}
export function requireLegacyAction(host: WorkerHost | null, action: GridAction, overrides: Partial<KillContext> = {}) {
  if (!gridActionAllowed(action, legacyKillContext(host, overrides))) throw Error('GRID_HOST_ACTION_DENIED');
}
export async function localContext(c: PoolClient, action: string, holder?: { bootId: string; epoch: string }) {
  await c.query("SELECT set_config('qv.grid_worker_action',$1,true)", [action]);
  if (holder) await c.query("SELECT set_config('qv.grid_worker_holder',$1,true),set_config('qv.grid_worker_epoch',$2,true)", [holder.bootId, holder.epoch]);
}
/** Caller uses the exclusive pause-budget transaction. A commit alone is not acknowledgment. */
export async function pauseHost(c: PoolClient, owner: VerifiedOwnerContext): Promise<string> {
  requireVerifiedOwner(owner, 'pause', 'all');
  await c.query("SELECT grid_worker_pause_from_verified_receipt($1::uuid,'pause','all','none')", [owner.receiptId]);
  return (await c.query('SELECT pause_revision FROM grid_worker_host WHERE singleton_id=1')).rows[0].pause_revision;
}
export async function resetPause(c: PoolClient, owner: VerifiedOwnerContext, readiness: () => Promise<boolean>, deploymentFlags: { remoteWorkerEnabled: boolean; entriesPaused: boolean }) {
  requireVerifiedOwner(owner, 'reset_pause', 'all');
  if (deploymentFlags.entriesPaused || !await readiness()) throw Error('GRID_RESET_REQUIRED');
  await c.query("SELECT grid_worker_consume_receipt($1::uuid,'reset_pause','all','none')", [owner.receiptId]);
  await c.query("SELECT set_config('qv.grid_worker_owner_verified','true',true),set_config('qv.grid_worker_ready','true',true),set_config('qv.grid_worker_deployment_flags_clear','true',true)");
  await localContext(c, 'reset');
  const changed = await c.query(`UPDATE grid_worker_host SET entries_paused=false,pause_revision=pause_revision+1,pause_ack_at=NULL,pause_ack_revision=NULL
    WHERE singleton_id=1 AND entries_paused RETURNING singleton_id`);
  if (changed.rowCount !== 1) throw Error('GRID_RESET_REQUIRED');
}
export async function acknowledgeCritical(c: PoolClient, owner: VerifiedOwnerContext, incidentId: string) {
  requireVerifiedOwner(owner, 'ack_critical', 'incident:' + incidentId);
  await c.query("SELECT grid_worker_consume_receipt($1::uuid,'ack_critical',$2,'none')", [owner.receiptId, 'incident:' + incidentId]);
  const result = await c.query(`UPDATE grid_worker_incidents SET acknowledged_at=clock_timestamp(),acknowledged_by=$2
    WHERE id=$1::uuid AND severity='critical' AND acknowledged_at IS NULL RETURNING id`, [incidentId, owner.ownerWallet]);
  if (result.rowCount !== 1) throw Error('GRID_INCIDENT_OCCURRENCE_INVALID');
}
/** Maintenance transaction holds the shared host fence; heartbeat alone is fence-free. */
export async function acknowledgePause(c: PoolClient, holder: { bootId: string; epoch: string }, revision: string) {
  await localContext(c, 'pause_ack', holder);
  const result = await c.query(`UPDATE grid_worker_host SET pause_ack_at=clock_timestamp(),pause_ack_revision=pause_revision
    WHERE singleton_id=1 AND holder_boot_id=$1::uuid AND fencing_epoch=$2::bigint AND pause_revision=$3::bigint
    AND entries_paused AND lease_expires_at>clock_timestamp() RETURNING singleton_id`, [holder.bootId, holder.epoch, revision]);
  if (result.rowCount !== 1) throw Error('GRID_PAUSE_ACK_INVALID');
}
export async function clearObserver(c: PoolClient, holder: { bootId: string; epoch: string }, readiness: () => Promise<boolean>) {
  if (!await readiness()) throw Error('GRID_OBSERVER_CLEAR_INVALID');
  await localContext(c, 'observer_clear', holder);
  await c.query("SELECT set_config('qv.grid_worker_ready','true',true)");
  const result = await c.query(`UPDATE grid_worker_host SET observer_fenced=false WHERE singleton_id=1
    AND holder_boot_id=$1::uuid AND fencing_epoch=$2::bigint AND observer_fenced RETURNING singleton_id`, [holder.bootId, holder.epoch]);
  if (result.rowCount !== 1) throw Error('GRID_OBSERVER_CLEAR_INVALID');
}
export async function tightenHost(c: PoolClient, gates: { pause?: boolean; observer?: boolean; drain?: boolean; disable?: boolean }) {
  await localContext(c, 'tighten');
  await c.query(`UPDATE grid_worker_host SET entries_paused=entries_paused OR $1,observer_fenced=observer_fenced OR $2,
    drain_requested=drain_requested OR $3,execution_enabled=execution_enabled AND NOT $4,
    pause_revision=pause_revision+CASE WHEN $1 AND NOT entries_paused THEN 1 ELSE 0 END,
    pause_ack_at=CASE WHEN $1 AND NOT entries_paused THEN NULL ELSE pause_ack_at END,
    pause_ack_revision=CASE WHEN $1 AND NOT entries_paused THEN NULL ELSE pause_ack_revision END WHERE singleton_id=1`,
    [gates.pause === true, gates.observer === true, gates.drain === true, gates.disable === true]);
}
