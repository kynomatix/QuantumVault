import type { CatalogQuery } from '../schema-readiness-probe';

export type GridWorkerDataStage = 'unseeded' | 'seeded' | 'tracking' | 'quota';
export interface GridWorkerQuotaDomain { readonly provider: string; readonly domainId: string; readonly policyDigest: string }
export const GRID_WORKER_DATA_SQL = `WITH now AS (SELECT statement_timestamp() AS at),
domains AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(provider text, "domainId" text, "policyDigest" text)),
state AS (SELECT
 EXISTS(SELECT 1 FROM grid_worker_host h JOIN grid_worker_owner o ON o.singleton_id=h.singleton_id AND o.wallet_address=h.owner_wallet WHERE h.singleton_id=1 AND h.protocol_version='grid-worker-v3-a1-wire1') AS seeded,
 EXISTS(SELECT 1 FROM grid_worker_host WHERE singleton_id=1 AND authority_tracking_enabled) AND NOT EXISTS(SELECT 1 FROM wallets w LEFT JOIN grid_worker_wallet_authority a ON a.wallet_address=w.address WHERE a.wallet_address IS NULL) AS tracking,
 EXISTS(SELECT 1 FROM domains) AND NOT EXISTS(SELECT 1 FROM domains d WHERE NOT EXISTS(
  SELECT 1 FROM grid_worker_quota_policy p JOIN grid_worker_quota_windows w USING(provider,domain_id), now
  WHERE p.provider=d.provider AND p.domain_id=d."domainId" AND p.policy_digest=d."policyDigest" AND p.valid_until>now.at
   AND w.window_start<=now.at AND w.window_start+w.window_ms*interval '1 millisecond'>now.at
   AND w.observed_at<=now.at AND (w.backoff_until IS NULL OR w.backoff_until<=now.at)
   AND ROW(w.window_ms,w.total_units,w.worker_limit_units,w.worker_protective_reserve_units,w.policy_digest)=ROW(p.window_ms,p.total_units,p.worker_limit_units,p.worker_protective_reserve_units,p.policy_digest)
 )) AS quota)
SELECT CASE WHEN NOT seeded THEN 'unseeded' WHEN NOT tracking THEN 'seeded' WHEN NOT quota THEN 'tracking' ELSE 'quota' END AS stage,
 seeded AND tracking AND quota AS ready, now.at AS "checkedAt", now.at+interval '60 seconds' AS "expiresAt" FROM state, now`;

// Call after catalog readiness. Domain inventory comes from U4; an empty inventory fails closed.
// No boot seed, repair, timer, incident write or authorization decision occurs here.
export async function probeGridWorkerData(query: CatalogQuery, domains: readonly GridWorkerQuotaDomain[] = []) {
  const row = (await query(GRID_WORKER_DATA_SQL, [JSON.stringify(domains)])).rows[0];
  if (!row || !['unseeded', 'seeded', 'tracking', 'quota'].includes(String(row.stage))) throw Error('GRID_WORKER_DATA_UNAVAILABLE');
  return Object.freeze({ stage: row.stage as GridWorkerDataStage, ready: row.ready === true, checkedAt: row.checkedAt, expiresAt: row.expiresAt });
}
