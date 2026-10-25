import {currentWorkerHolder,type HolderIdentity} from './current-holder';
import { randomUUID } from 'node:crypto';
import type { ClientLane } from './transaction';
import { fencedTransaction, type GridDeadline } from './transaction';
export interface GridIncident { code: 'contender_seen' | 'pause_unacknowledged' | 'schema_drift' | 'lease_lost' | 'audit_mismatch' | 'database_unavailable' | 'authority_refused' | 'transfer_refused' | 'egress_refused' | 'exposure_above_budget' | 'clock_unhealthy' | 'progress_stale' | 'stop_failed' | 'observer_silent' | 'reconciliation_unavailable' | 'protective_failure' | 'quota_pressure' | 'notification_delayed'; dedupKey: string; botId?: string; bootId?: string; epoch?: string; evidenceDigest?: string }
/** Separate bounded lane; never receives the caller's transaction. Queue remains available to explicit recovery. */
export class GridIncidents {
  private readonly pending = new Map<string, GridIncident>();
  constructor(private readonly lane: ClientLane, private readonly terminate: (pid: number) => Promise<void>,private holder?:()=>HolderIdentity|undefined,private allowExpiredLeaseLoss=false) {}
  get queued(): readonly GridIncident[] { return [...this.pending.values()]; }
  async record(incident: GridIncident, budget?: GridDeadline): Promise<boolean> {
    const authority=this.holder?{bootId:incident.bootId??this.holder()?.bootId,epoch:incident.epoch??this.holder()?.epoch}:undefined;
    if(authority){if(!authority.bootId||!authority.epoch)return false;incident={...incident,...authority};}
    this.pending.set(incident.dedupKey, incident);
    try {
      await fencedTransaction(this.lane, async c => {
        if(authority&&!await currentWorkerHolder(c,authority as HolderIdentity,this.allowExpiredLeaseLoss&&incident.code==='lease_lost'))return;
        await c.query(`INSERT INTO grid_worker_incidents(id,dedup_key,severity,code,bot_id,holder_boot_id,fencing_epoch,first_seen_at,last_seen_at,evidence_digest)
          VALUES($1,$2,$8,$3,$4,$5,$6,clock_timestamp(),clock_timestamp(),$7)
          ON CONFLICT (dedup_key) WHERE acknowledged_at IS NULL DO UPDATE SET
          last_seen_at=EXCLUDED.last_seen_at,resolved_at=NULL,occurrence_count=grid_worker_incidents.occurrence_count+1`,
          [randomUUID(), incident.dedupKey, incident.code, incident.botId ?? null, incident.bootId ?? null, incident.epoch ?? null, incident.evidenceDigest ?? null,['exposure_above_budget','quota_pressure','notification_delayed'].includes(incident.code)?'warning':'critical']);
      }, { mode: this.holder?'shared':'none', terminate: this.terminate, budget });
      if (this.pending.get(incident.dedupKey) === incident) this.pending.delete(incident.dedupKey);
      return true;
    } catch { return false; }
  }
  async flush(): Promise<void> { for (const incident of this.queued) await this.record(incident); }
  schemaDrift(evidenceDigest?: string) { return this.record({ code: 'schema_drift', dedupKey: 'grid-worker:schema-drift', evidenceDigest }); }
}
