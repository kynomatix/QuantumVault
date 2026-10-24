import type {PoolClient} from 'pg';
import {fencedTransaction, type ClientLane} from './transaction';
export type QuotaProvider = 'pacifica_rest' | 'pacifica_ws' | 'rpc_primary' | 'rpc_backup';
export const QUOTA_DOMAIN = 'deployment';
export interface QuotaPolicy {provider: QuotaProvider; domain_id: string; window_ms: number; total_units: string; worker_limit_units: string; worker_protective_reserve_units: string; policy_digest: string; valid_until: string | Date}
export class WorkerQuota {
  constructor(private lane: ClientLane, private terminate: (pid: number) => Promise<void>) {}
  async debit(provider: QuotaProvider, units: number, protective = false, domain = QUOTA_DOMAIN): Promise<void> {
    if (!Number.isSafeInteger(units) || units < 1) throw Error('GRID_QUOTA_COST_INVALID');
    const ok = await fencedTransaction(this.lane, async c => {
      // Serializes all processes and policy replacement; backoff spans window boundaries.
      const policy = (await c.query(`SELECT * FROM grid_worker_quota_policy WHERE provider=$1 AND domain_id=$2
        AND valid_until>clock_timestamp() AND policy_digest ~ '^[0-9a-f]{64}$' FOR UPDATE`,[provider,domain])).rows[0];
      if (!policy) return false;
      if ((await c.query(`SELECT 1 FROM grid_worker_quota_windows WHERE provider=$1 AND domain_id=$2 AND backoff_until>clock_timestamp() LIMIT 1`,[provider,domain])).rowCount) return false;
      // Retain the entire current and previous bucket. This overcounts, but bounds
      // every rolling provider window even across a bucket or policy boundary.
      const spent=(await c.query(`SELECT coalesce(sum(worker_used_units),0) AS used
        FROM grid_worker_quota_windows WHERE provider=$1 AND domain_id=$2
          AND window_start+make_interval(secs=>2*window_ms/1000.0)>clock_timestamp()`,[provider,domain])).rows[0];
      const available=Number(policy.worker_limit_units)-(protective?0:Number(policy.worker_protective_reserve_units));
      if(!Number.isSafeInteger(available)||Number(spent.used)+units>available)return false;
      const changed = await c.query(`INSERT INTO grid_worker_quota_windows(provider,domain_id,window_ms,total_units,worker_limit_units,
        worker_protective_reserve_units,policy_digest,window_start,worker_used_units,observed_at)
        SELECT provider,domain_id,window_ms,total_units,worker_limit_units,worker_protective_reserve_units,policy_digest,
          to_timestamp(floor(extract(epoch FROM clock_timestamp())*1000/window_ms)*window_ms/1000),$3,clock_timestamp()
        FROM grid_worker_quota_policy WHERE provider=$1 AND domain_id=$2 AND valid_until>clock_timestamp()
          AND $3<=worker_limit_units-CASE WHEN $4 THEN 0 ELSE worker_protective_reserve_units END
        ON CONFLICT(provider,domain_id,window_start) DO UPDATE SET worker_used_units=grid_worker_quota_windows.worker_used_units+$3,observed_at=clock_timestamp()
        WHERE grid_worker_quota_windows.policy_digest=EXCLUDED.policy_digest
          AND grid_worker_quota_windows.worker_used_units+$3<=EXCLUDED.worker_limit_units-CASE WHEN $4 THEN 0 ELSE EXCLUDED.worker_protective_reserve_units END
        RETURNING provider`,[provider,domain,units,protective]);
      return changed.rowCount === 1;
    },{mode:'none',terminate:this.terminate});
    if (!ok) throw Error('GRID_QUOTA_UNAVAILABLE');
  }
  async rateLimited(provider: QuotaProvider, domain = QUOTA_DOMAIN): Promise<void> {
    await fencedTransaction(this.lane,async c=>{
      await c.query('SELECT provider FROM grid_worker_quota_policy WHERE provider=$1 AND domain_id=$2 FOR UPDATE',[provider,domain]);
      await c.query(`UPDATE grid_worker_quota_windows SET backoff_until=clock_timestamp()+interval '60 seconds'
        WHERE provider=$1 AND domain_id=$2 AND window_start=(SELECT max(window_start) FROM grid_worker_quota_windows WHERE provider=$1 AND domain_id=$2)`,[provider,domain]);
    },{mode:'none',terminate:this.terminate});
  }
}
export async function readQuotaPolicies(c: Pick<PoolClient,'query'>): Promise<QuotaPolicy[]> {
  return (await c.query(`SELECT * FROM grid_worker_quota_policy WHERE valid_until>clock_timestamp()`)).rows;
}
