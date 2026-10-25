-- policy_digest algorithm: sha256. Conservative dormant ceilings, not proven launch capacity.
-- HELD TEMPLATE; owner/conductor authorization and reviewed inputs required. No execution by this build.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '2s';
SELECT pg_advisory_xact_lock(hashtextextended('qv:grid-worker:v3:host',0));
DO $quota$
DECLARE inputs jsonb := '[{"domain_id":"deployment","provider":"pacifica_rest","total_units":"1000","valid_until":"2026-11-24T00:00:00.000Z","window_ms":60000,"worker_limit_units":"500","worker_protective_reserve_units":"120","policyDigestAlgorithm":"sha256","policy_digest":"2ebaf89b76fe2fc728d0a2b63f4b5666d72eb264680898f1260c207959ebb47a"},{"domain_id":"deployment","provider":"rpc_backup","total_units":"40","valid_until":"2026-11-24T00:00:00.000Z","window_ms":10000,"worker_limit_units":"20","worker_protective_reserve_units":"5","policyDigestAlgorithm":"sha256","policy_digest":"1115655d3d242e953373c0e9dacfcadd4fee0194a4569cf71f9910300007a0ff"}]'::jsonb; q record; current_bucket timestamptz;
BEGIN
  IF jsonb_typeof(inputs)<>'array' OR jsonb_array_length(inputs)=0 THEN RAISE EXCEPTION 'GRID_QUOTA_INPUT_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM grid_worker_host WHERE singleton_id=1 AND NOT execution_enabled AND entries_paused) THEN RAISE EXCEPTION 'GRID_QUOTA_BOOTSTRAP_DISABLED_ONLY'; END IF;
  IF (SELECT count(*) FROM jsonb_to_recordset(inputs) AS x(provider text,domain_id text)) <> (SELECT count(DISTINCT (provider,domain_id)) FROM jsonb_to_recordset(inputs) AS x(provider text,domain_id text)) THEN RAISE EXCEPTION 'GRID_QUOTA_DUPLICATE'; END IF;
  FOR q IN SELECT * FROM jsonb_to_recordset(inputs) AS x(provider text,domain_id text,window_ms integer,total_units numeric,worker_limit_units numeric,worker_protective_reserve_units numeric,policy_digest text,valid_until timestamptz) LOOP
    current_bucket := to_timestamp(floor(extract(epoch FROM clock_timestamp())*1000/q.window_ms)*q.window_ms/1000);
    IF q.valid_until IS NULL OR current_bucket IS NULL OR NOT isfinite(q.valid_until) OR NOT isfinite(current_bucket) OR q.valid_until<=clock_timestamp() OR q.valid_until>clock_timestamp()+interval '90 days' OR current_bucket>clock_timestamp() OR current_bucket+q.window_ms*interval '1 millisecond'<=clock_timestamp() THEN RAISE EXCEPTION 'GRID_QUOTA_WINDOW_INVALID'; END IF;
    IF EXISTS (SELECT 1 FROM grid_worker_quota_policy p WHERE p.provider=q.provider AND p.domain_id=q.domain_id AND ROW(p.window_ms,p.total_units,p.worker_limit_units,p.worker_protective_reserve_units,p.policy_digest,p.valid_until) IS DISTINCT FROM ROW(q.window_ms,q.total_units,q.worker_limit_units,q.worker_protective_reserve_units,q.policy_digest,q.valid_until)) THEN RAISE EXCEPTION 'GRID_QUOTA_POLICY_CONFLICT'; END IF;
    INSERT INTO grid_worker_quota_policy(provider,domain_id,window_ms,total_units,worker_limit_units,worker_protective_reserve_units,policy_digest,valid_until) VALUES(q.provider,q.domain_id,q.window_ms,q.total_units,q.worker_limit_units,q.worker_protective_reserve_units,q.policy_digest,q.valid_until) ON CONFLICT(provider,domain_id) DO NOTHING;
    IF EXISTS (SELECT 1 FROM grid_worker_quota_windows w WHERE w.provider=q.provider AND w.domain_id=q.domain_id AND w.window_start=current_bucket AND ROW(w.window_ms,w.total_units,w.worker_limit_units,w.worker_protective_reserve_units,w.policy_digest) IS DISTINCT FROM ROW(q.window_ms,q.total_units,q.worker_limit_units,q.worker_protective_reserve_units,q.policy_digest)) THEN RAISE EXCEPTION 'GRID_QUOTA_WINDOW_CONFLICT'; END IF;
    INSERT INTO grid_worker_quota_windows(provider,domain_id,window_start,window_ms,total_units,worker_limit_units,worker_used_units,worker_protective_reserve_units,observed_at,policy_digest) VALUES(q.provider,q.domain_id,current_bucket,q.window_ms,q.total_units,q.worker_limit_units,0,q.worker_protective_reserve_units,clock_timestamp(),q.policy_digest) ON CONFLICT(provider,domain_id,window_start) DO NOTHING;
  END LOOP;
END
$quota$;
COMMIT;
