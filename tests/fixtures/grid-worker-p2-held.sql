-- HELD. Owner console only, after publication, retirement and production sizing proof.
-- Readiness must be explicitly supplied in this console session as qv.u2c_readiness JSON.
-- No readiness facts are claimed by this build. Missing or false facts refuse execution.
-- Required keys: published, incompatibleProcessesRetired, outsideDbFirstInstallRecord,
-- productionWalletCount, measuredP2DurationMs. The record is an external evidence reference.
-- sqlSha256 is recorded in evidence/package-digests.json (avoids a self-referential digest).
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '2s';
SELECT pg_advisory_xact_lock(hashtextextended('qv:grid-worker:v3:host',0));
DO $authorization$
DECLARE readiness jsonb := nullif(current_setting('qv.u2c_readiness',true),'')::jsonb;
BEGIN
  IF readiness IS NULL OR readiness->>'published' IS DISTINCT FROM 'true'
    OR readiness->>'incompatibleProcessesRetired' IS DISTINCT FROM 'true'
    OR coalesce(length(readiness->>'outsideDbFirstInstallRecord'),0)=0
    OR coalesce(readiness->>'productionWalletCount','') !~ '^[0-9]+$'
    OR coalesce(readiness->>'measuredP2DurationMs','') !~ '^[0-9]+$'
  THEN RAISE EXCEPTION 'GRID_U2C_READINESS_REQUIRED'; END IF;
  IF (readiness->>'productionWalletCount')::bigint < (SELECT count(*) FROM wallets)
    OR (readiness->>'measuredP2DurationMs')::bigint NOT BETWEEN 1 AND 1999
  THEN RAISE EXCEPTION 'GRID_CHECKPOINTED_BOOTSTRAP_REQUIRED'; END IF;
END $authorization$;
SET LOCAL qv.grid_worker_action='bootstrap_tracking';
DO $authority$
DECLARE w record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM grid_worker_host h JOIN grid_worker_owner o ON o.singleton_id=h.singleton_id AND o.wallet_address=h.owner_wallet WHERE h.singleton_id=1) THEN RAISE EXCEPTION 'GRID_BOOTSTRAP_IDENTITY_MISSING'; END IF;
  IF (SELECT authority_tracking_enabled FROM grid_worker_host WHERE singleton_id=1) THEN
    IF EXISTS (SELECT 1 FROM wallets wallet_row LEFT JOIN grid_worker_wallet_authority a ON a.wallet_address=wallet_row.address WHERE a.wallet_address IS NULL) THEN RAISE EXCEPTION 'GRID_AUTHORITY_HISTORY_MISSING'; END IF;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM grid_worker_host WHERE singleton_id=1 AND execution_mode='legacy' AND NOT execution_enabled AND entries_paused) OR EXISTS (SELECT 1 FROM grid_worker_wallet_authority) OR EXISTS (SELECT 1 FROM grid_worker_requests) OR EXISTS (SELECT 1 FROM grid_worker_send_audit) OR EXISTS (SELECT 1 FROM grid_worker_reservations) THEN RAISE EXCEPTION 'GRID_AUTHORITY_NOT_FIRST_INSTALL'; END IF;
  FOR w IN SELECT address FROM wallets ORDER BY address COLLATE "C" LOOP
    PERFORM pg_advisory_xact_lock(927412,hashtext(w.address));
  END LOOP;
  FOR w IN SELECT address FROM wallets ORDER BY address COLLATE "C" FOR UPDATE LOOP
    INSERT INTO grid_worker_wallet_authority(wallet_address,generation) VALUES(w.address,0);
  END LOOP;
  UPDATE grid_worker_host SET authority_tracking_enabled=true WHERE singleton_id=1;
END
$authority$;
COMMIT;
