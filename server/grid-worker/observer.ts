import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {tightenHost,clearObserver} from './host';

/** A poll reduces the observer fence only; it never supplies lease or money authority. */
export class WorkerObserver {
  private acquiredAt = 0;
  private lastPoll: number | null = null;
  private silentRecorded = false;
  private pollVersion = 0;
  private flushedVersion = 0;
  constructor(private readonly now: () => number = Date.now) {}
  poll() { this.lastPoll = this.now(); this.pollVersion++; }
  get pendingPoll() { return this.polledSinceAcquire && this.pollVersion !== this.flushedVersion; }
  get version() { return this.pollVersion; }
  flushed(version: number) { this.flushedVersion = version; }
  get silent() { return this.now() - (this.lastPoll ?? this.acquiredAt) > 300_000; }
  get polledSinceAcquire() { return this.lastPoll !== null && this.lastPoll >= this.acquiredAt; }
  fresh(milliseconds = 60_000) {
    return this.polledSinceAcquire && this.now() >= this.lastPoll! && this.now() - this.lastPoll! < milliseconds;
  }
  async acquire(c: PoolClient) {
    this.acquiredAt = this.now(); this.lastPoll = null; this.silentRecorded = false;
    await tightenHost(c, {observer: true});
  }
  async maintain(c: PoolClient, holder: {bootId: string; epoch: string}, ready: () => Promise<boolean>) {
    if (this.silent) {
      await tightenHost(c, {observer: true});
      if (!this.silentRecorded) {
        await c.query(`INSERT INTO grid_worker_incidents(id,dedup_key,severity,code,holder_boot_id,fencing_epoch)
          VALUES($1,'grid-worker:observer-silent','critical','observer_silent',$2,$3)
          ON CONFLICT(dedup_key) WHERE acknowledged_at IS NULL DO UPDATE
          SET resolved_at=NULL,last_seen_at=clock_timestamp(),occurrence_count=grid_worker_incidents.occurrence_count+1`,
          [randomUUID(),holder.bootId,holder.epoch]);
      }
      // Set only after the caller confirms COMMIT, via committed().
      return 'silent' as const;
    }
    if (this.fresh()) {
      await c.query("UPDATE grid_worker_incidents SET resolved_at=clock_timestamp() WHERE code='observer_silent' AND resolved_at IS NULL");
      const row = (await c.query(`SELECT observer_fenced,
        EXISTS(SELECT 1 FROM grid_worker_incidents WHERE code='observer_silent'
          AND (acknowledged_at IS NULL OR resolved_at IS NULL)) AS blocked
        FROM grid_worker_host WHERE singleton_id=1`)).rows[0];
      if (row?.observer_fenced && !row.blocked && await ready()) await clearObserver(c,holder,ready);
      return 'fresh' as const;
    }
    return 'waiting' as const;
  }
  committed(state: 'silent' | 'fresh' | 'waiting') {
    if (state === 'silent') this.silentRecorded = true;
    if (state === 'fresh') this.silentRecorded = false;
  }
}
