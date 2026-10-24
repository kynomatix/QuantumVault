import { randomUUID } from 'node:crypto';
import type { ClientLane } from './transaction';
import { fencedTransaction } from './transaction';
export interface GridIncident { code: 'contender_seen' | 'pause_unacknowledged' | 'schema_drift' | 'lease_lost' | 'audit_mismatch' | 'database_unavailable' | 'authority_refused' | 'transfer_refused' | 'egress_refused' | 'exposure_above_budget'; dedupKey: string; botId?: string; bootId?: string; epoch?: string; evidenceDigest?: string }
/** Separate bounded lane; never receives the caller's transaction. Queue remains available to explicit recovery. */
export class GridIncidents {
  private readonly pending = new Map<string, GridIncident>();
  constructor(private readonly lane: ClientLane, private readonly terminate: (pid: number) => Promise<void>) {}
  get queued(): readonly GridIncident[] { return [...this.pending.values()]; }
  async record(incident: GridIncident): Promise<boolean> {
    this.pending.set(incident.dedupKey, incident);
    try {
      await fencedTransaction(this.lane, async c => {
        await c.query(`INSERT INTO grid_worker_incidents(id,dedup_key,severity,code,bot_id,holder_boot_id,fencing_epoch,first_seen_at,last_seen_at,evidence_digest)
          VALUES($1,$2,$8,$3,$4,$5,$6,clock_timestamp(),clock_timestamp(),$7)
          ON CONFLICT (dedup_key) WHERE acknowledged_at IS NULL DO UPDATE SET
          last_seen_at=EXCLUDED.last_seen_at,occurrence_count=grid_worker_incidents.occurrence_count+1`,
          [randomUUID(), incident.dedupKey, incident.code, incident.botId ?? null, incident.bootId ?? null, incident.epoch ?? null, incident.evidenceDigest ?? null,incident.code==='exposure_above_budget'?'warning':'critical']);
      }, { mode: 'none', terminate: this.terminate });
      if (this.pending.get(incident.dedupKey) === incident) this.pending.delete(incident.dedupKey);
      return true;
    } catch { return false; }
  }
  async flush(): Promise<void> { for (const incident of this.queued) await this.record(incident); }
  schemaDrift(evidenceDigest?: string) { return this.record({ code: 'schema_drift', dedupKey: 'grid-worker:schema-drift', evidenceDigest }); }
}
