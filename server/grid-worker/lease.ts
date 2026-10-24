import type { PoolClient } from 'pg';
import { performance } from 'node:perf_hooks';
import { localContext } from './host';
import { fencedTransaction, type ClientLane } from './transaction';
import {leaseLocallyValid,type WorkerLease} from './lease-clock';
export {leaseLocallyValid,type WorkerLease} from './lease-clock';
export interface AcceptanceBound { verified: boolean; milliseconds: number; skewMs: number }
export interface RenewalGates { entries_paused: boolean; pause_revision: string; pause_ack_revision: string | null; observer_fenced: boolean }
function boundValid(bound: AcceptanceBound) {
  return bound.verified && Number.isSafeInteger(bound.milliseconds) && bound.milliseconds >= 0
    && Number.isSafeInteger(bound.skewMs) && bound.skewMs >= 0 && bound.skewMs < 45_000;
}

export async function takeoverWindowsClear(c: PoolClient, bound: AcceptanceBound): Promise<boolean> {
  if (!boundValid(bound)) return false;
  const now = Number((await c.query('SELECT extract(epoch FROM clock_timestamp())*1000 AS now')).rows[0].now);
  const legacy = (await c.query("SELECT exact_request FROM grid_operations WHERE state IN ('prepared','submitted','unconfirmed')")).rows;
  const worker = (await c.query("SELECT signed_at,signed_expires_at FROM grid_worker_send_audit WHERE outcome='unknown'")).rows;
  const ends: number[] = [];
  for (const row of legacy) {
    const r = row.exact_request;
    if (!r || !Number.isSafeInteger(r.timestamp) || !Number.isSafeInteger(r.expiryMs) || r.expiryMs <= 0 || r.expiryMs > 15_000) return false;
    ends.push(r.timestamp + r.expiryMs);
  }
  for (const row of worker) {
    const start = new Date(row.signed_at).getTime(), end = new Date(row.signed_expires_at).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 15_000) return false;
    ends.push(end);
  }
  return ends.every(end => end + bound.milliseconds + bound.skewMs + 5_000 < now);
}
/** Inert library. Neither MAIN nor the probe entrypoint imports this module. */
export class GridWorkerLease {
  constructor(private readonly execution: ClientLane, private readonly renewal: ClientLane,
    private readonly terminate: (pid: number) => Promise<void>, private readonly ready: () => Promise<boolean>) {
    if (execution === renewal) throw Error('GRID_DEDICATED_RENEWAL_REQUIRED');
  }
  async acquire(bootId: string, bound: AcceptanceBound, reconcile: (lease: WorkerLease) => Promise<boolean>): Promise<WorkerLease> {
    if (!boundValid(bound) || !await this.ready()) throw Error('GRID_LEASE_NOT_READY');
    const lease = await fencedTransaction(this.execution, async c => {
      if (!await takeoverWindowsClear(c, bound)) throw Error('GRID_TAKEOVER_WINDOWS_PENDING');
      await localContext(c, 'lease_acquire');
      await c.query("SELECT set_config('qv.grid_worker_ready','true',true)");
      const sentAt = performance.now();
      const row = (await c.query(`UPDATE grid_worker_host SET holder_boot_id=$1::uuid,holder_role='grid-worker',fencing_epoch=fencing_epoch+1,
        lease_expires_at=clock_timestamp()+interval '45 seconds',heartbeat_at=clock_timestamp(),progress_at=clock_timestamp()
        WHERE singleton_id=1 AND execution_mode='external' AND (holder_boot_id IS NULL OR lease_expires_at<=clock_timestamp()) RETURNING fencing_epoch`, [bootId])).rows[0];
      if (!row) throw Error('GRID_LEASE_CONTENDED');
      return { bootId, epoch: String(row.fencing_epoch), sentAt, localExpiresAt: sentAt + 45_000 - bound.skewMs };
    }, { mode: 'exclusive', terminate: this.terminate });
    if (!await reconcile(lease) || !leaseLocallyValid(lease)) throw Error('GRID_TAKEOVER_RECONCILIATION_REQUIRED');
    return lease;
  }
  async renew(lease: WorkerLease, skewMs: number, progress: boolean, healthPoll = false): Promise<WorkerLease & RenewalGates> {
    if (!leaseLocallyValid(lease) || !Number.isSafeInteger(skewMs) || skewMs < 0 || skewMs >= 45_000) throw Error('GRID_LEASE_EXPIRED');
    return fencedTransaction(this.renewal, async c => {
      await localContext(c, 'heartbeat', lease);
      if (!leaseLocallyValid(lease)) throw Error('GRID_LEASE_EXPIRED');
      const sentAt = performance.now();
      const row = (await c.query(`UPDATE grid_worker_host SET lease_expires_at=clock_timestamp()+interval '45 seconds',heartbeat_at=clock_timestamp(),
        progress_at=CASE WHEN $3 THEN clock_timestamp() ELSE progress_at END,
        last_healthz_poll_at=CASE WHEN $4 THEN clock_timestamp() ELSE last_healthz_poll_at END
        WHERE singleton_id=1 AND holder_boot_id=$1::uuid AND fencing_epoch=$2::bigint AND lease_expires_at>clock_timestamp()
        RETURNING fencing_epoch,entries_paused,pause_revision,pause_ack_revision,observer_fenced`,
        [lease.bootId, lease.epoch, progress, healthPoll && await this.ready()])).rows[0];
      const next = { ...lease, sentAt, localExpiresAt: sentAt + 45_000 - skewMs };
      if (!row || !leaseLocallyValid(next)) throw Error('GRID_LEASE_EXPIRED');
      return { ...next, entries_paused: row.entries_paused, pause_revision: String(row.pause_revision),
        pause_ack_revision: row.pause_ack_revision === null ? null : String(row.pause_ack_revision), observer_fenced: row.observer_fenced };
    }, { mode: 'none', terminate: this.terminate });
  }
  async release(lease: WorkerLease): Promise<void> {
    await fencedTransaction(this.execution, async c => {
      await localContext(c, 'lease_release', lease);
      const result = await c.query(`UPDATE grid_worker_host SET holder_boot_id=NULL,holder_role=NULL,lease_expires_at='-infinity',fencing_epoch=fencing_epoch+1
        WHERE singleton_id=1 AND holder_boot_id=$1::uuid AND fencing_epoch=$2::bigint AND lease_expires_at<=clock_timestamp() RETURNING singleton_id`, [lease.bootId, lease.epoch]);
      if (result.rowCount !== 1) throw Error('GRID_LEASE_RELEASE_INVALID');
    }, { mode: 'exclusive', terminate: this.terminate });
  }
}
