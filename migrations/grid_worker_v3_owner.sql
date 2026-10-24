-- Canonical owner package: eleven tables. No seed DML; function DML runs only on invocation.
-- Missing host makes existing-table triggers inert; worker data readiness independently fails closed.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='2s';
SELECT pg_advisory_xact_lock(hashtextextended('qv:grid-worker:v3:host',0));
DO $install$
BEGIN
 IF current_setting('server_version_num')::integer < 140000 THEN RAISE EXCEPTION 'GRID_POSTGRES_VERSION'; END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname IN ('grid_worker_owner','grid_worker_host','grid_worker_wallet_authority','grid_worker_requests','grid_worker_reservations','grid_worker_send_audit','grid_worker_incidents','grid_worker_reconciliation','grid_worker_quota_policy','grid_worker_quota_windows','owner_action_receipts')) OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=current_schema() AND p.proname IN ('grid_worker_has_host_lock','grid_worker_has_wallet_lock','grid_worker_validate_host','grid_worker_validate_generation','grid_worker_track_wallet','grid_worker_validate_owner_scope','grid_worker_consume_receipt','grid_worker_pause_from_verified_receipt')) THEN
 IF NOT (SELECT current_setting('server_version_num')::integer >= 140000 AND capture."catalogSha256" = 'a981da1ef16a7590790ae2de79db1b5801ec00a71916453e3bed4c713cdb9bb1' AS ok FROM (WITH package_tables AS (
 SELECT c.* FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname IN ('grid_worker_owner','grid_worker_host','grid_worker_wallet_authority','grid_worker_requests','grid_worker_reservations','grid_worker_send_audit','grid_worker_incidents','grid_worker_reconciliation','grid_worker_quota_policy','grid_worker_quota_windows','owner_action_receipts')
), objects AS (
 SELECT 'table:'||c.relname AS identity, jsonb_build_object('kind',c.relkind,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,
 'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_object('name',k.conname,'type',k.contype,'definition',pg_get_constraintdef(k.oid),'delete',k.confdeltype,'update',k.confupdtype,'valid',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
 'indexes',(SELECT jsonb_agg(jsonb_build_object('name',ic.relname,'definition',replace(pg_get_indexdef(i.indexrelid),quote_ident(current_schema())||'.','public.'),'predicate',pg_get_expr(i.indpred,i.indrelid),'valid',i.indisvalid,'ready',i.indisready,'unique',i.indisunique) ORDER BY ic.relname) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid)) AS definition FROM package_tables c
 UNION ALL
 SELECT 'function:'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')', jsonb_build_object('body',p.prosrc,'language',l.lanname,'securityDefiner',p.prosecdef,'config',replace(array_to_string(p.proconfig,';'),current_schema(),'public'),'arguments',pg_get_function_arguments(p.oid),'returns',pg_get_function_result(p.oid),'volatility',p.provolatile,'strict',p.proisstrict,'leakproof',p.proleakproof,'parallel',p.proparallel,'kind',p.prokind) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname=current_schema() AND p.proname IN ('grid_worker_has_host_lock','grid_worker_has_wallet_lock','grid_worker_validate_host','grid_worker_validate_generation','grid_worker_track_wallet','grid_worker_validate_owner_scope','grid_worker_consume_receipt','grid_worker_pause_from_verified_receipt')
 UNION ALL
 SELECT 'trigger:'||c.relname||'.'||t.tgname, jsonb_build_object('definition',replace(pg_get_triggerdef(t.oid),quote_ident(current_schema())||'.','public.'),'function',p.proname,'functionSchema',CASE WHEN n.nspname=current_schema() THEN 'public' ELSE n.nspname END,'functionArgs',pg_get_function_identity_arguments(p.oid),'type',t.tgtype,'attributes',t.tgattr::text,'qual',CASE WHEN t.tgqual IS NULL THEN NULL ELSE substring(pg_get_triggerdef(t.oid) from ' WHEN (.*) EXECUTE FUNCTION ') END,'enabled',t.tgenabled,'arguments',encode(t.tgargs,'hex'),'constraint',t.tgconstraint<>0,'deferrable',t.tgdeferrable,'deferred',t.tginitdeferred) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace cn ON cn.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace WHERE cn.nspname=current_schema() AND NOT t.tgisinternal AND (c.relname IN ('grid_worker_owner','grid_worker_host','grid_worker_wallet_authority','grid_worker_requests','grid_worker_reservations','grid_worker_send_audit','grid_worker_incidents','grid_worker_reconciliation','grid_worker_quota_policy','grid_worker_quota_windows','owner_action_receipts') OR t.tgname IN ('grid_worker_host_validate','grid_worker_generation_validate','grid_worker_wallet_update','grid_worker_wallet_insert','grid_worker_grid_bots_insert','grid_worker_grid_bots_update','grid_worker_protocol_subaccounts_insert','grid_worker_protocol_subaccounts_update','grid_worker_grid_launch_accounts_insert','grid_worker_grid_launch_accounts_update','grid_worker_requests_owner_validate','grid_worker_reservations_owner_validate'))
), digests AS (
 SELECT identity,encode(sha256(convert_to(definition::text,'UTF8')),'hex') AS digest FROM objects
)
SELECT encode(sha256(convert_to(COALESCE(jsonb_object_agg(identity,digest),'{}'::jsonb)::text,'UTF8')),'hex') AS "catalogSha256",
 encode(sha256(convert_to(COALESCE(jsonb_object_agg(identity,digest) FILTER (WHERE identity LIKE 'table:%'),'{}'::jsonb)::text,'UTF8')),'hex') AS "tablesSha256",
 COALESCE(jsonb_object_agg(identity,digest),'{}'::jsonb) AS "objectHashes" FROM digests) capture) THEN RAISE EXCEPTION 'GRID_PACKAGE_PRIOR_SHAPE'; END IF;
 RETURN;
 END IF;
CREATE TABLE grid_worker_owner (
  singleton_id smallint NOT NULL DEFAULT 1,
  wallet_address text NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (singleton_id),
  UNIQUE (singleton_id,wallet_address),
  CONSTRAINT grid_worker_owner_singleton CHECK (singleton_id = 1),
  CONSTRAINT grid_worker_owner_wallet_fk FOREIGN KEY (wallet_address) REFERENCES wallets(address) ON DELETE RESTRICT,
  CONSTRAINT grid_worker_owner_clock CHECK ((installed_at IS NULL OR isfinite(installed_at)))
);


CREATE TABLE grid_worker_host (
  singleton_id smallint NOT NULL DEFAULT 1,
  execution_mode text NOT NULL DEFAULT 'legacy',
  run_mode text NOT NULL DEFAULT 'test',
  execution_enabled boolean NOT NULL DEFAULT false,
  entries_paused boolean NOT NULL DEFAULT true,
  drain_requested boolean NOT NULL DEFAULT false,
  holder_boot_id uuid,
  holder_role text,
  fencing_epoch bigint NOT NULL DEFAULT 0,
  lease_expires_at timestamptz NOT NULL DEFAULT '-infinity',
  heartbeat_at timestamptz,
  progress_at timestamptz,
  last_healthz_poll_at timestamptz,
  pause_ack_at timestamptz,
  protocol_version text NOT NULL,
  commit_hash text,
  tree_hash text,
  lockfile_sha256 text,
  start_scope text NOT NULL DEFAULT 'owner_allowlist',
  owner_wallet text,
  per_bot_cap_usd numeric,
  global_ceiling_usd numeric,
  scope_revision bigint NOT NULL DEFAULT 1,
  observer_fenced boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  authority_tracking_enabled boolean NOT NULL DEFAULT false,
  legacy_controls_enabled boolean NOT NULL DEFAULT false,
  pause_revision bigint NOT NULL DEFAULT 0,
  pause_ack_revision bigint,
  PRIMARY KEY (singleton_id),
  CONSTRAINT grid_worker_host_owner_fk FOREIGN KEY (singleton_id,owner_wallet) REFERENCES grid_worker_owner(singleton_id,wallet_address) ON DELETE RESTRICT,
  CONSTRAINT grid_worker_host_wallet_fk FOREIGN KEY (owner_wallet) REFERENCES wallets(address) ON DELETE RESTRICT,
  CONSTRAINT grid_worker_singleton CHECK (singleton_id = 1),
  CONSTRAINT grid_worker_protocol CHECK (protocol_version = 'grid-worker-v3-a1-wire1'),
  CONSTRAINT grid_worker_mode CHECK (execution_mode IN ('legacy','external') AND run_mode IN ('test','trading') AND (holder_role IS NULL OR holder_role IN ('grid-worker','protective'))),
  CONSTRAINT grid_worker_scope CHECK (start_scope IN ('owner_allowlist','expanded') AND (NOT execution_enabled OR (owner_wallet IS NOT NULL AND length(btrim(owner_wallet)) > 0)) AND (start_scope = 'owner_allowlist' OR (per_bot_cap_usd IS NOT NULL AND global_ceiling_usd IS NOT NULL))),
  CONSTRAINT grid_worker_caps CHECK ((per_bot_cap_usd IS NULL OR (per_bot_cap_usd NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) AND per_bot_cap_usd > 0 AND per_bot_cap_usd <= 250)) AND (global_ceiling_usd IS NULL OR (global_ceiling_usd NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) AND global_ceiling_usd > 0))),
  CONSTRAINT grid_worker_counters CHECK (fencing_epoch >= 0 AND scope_revision > 0 AND pause_revision >= 0 AND (pause_ack_revision IS NULL OR (pause_ack_revision = pause_revision AND pause_ack_at IS NOT NULL)) AND ((pause_ack_revision IS NULL) = (pause_ack_at IS NULL))),
  CONSTRAINT grid_worker_identity CHECK ((commit_hash IS NULL OR commit_hash ~ '^[0-9a-f]{40}$') AND (tree_hash IS NULL OR tree_hash ~ '^[0-9a-f]{40}$') AND (lockfile_sha256 IS NULL OR lockfile_sha256 ~ '^[0-9a-f]{64}$') AND ((holder_boot_id IS NULL) = (holder_role IS NULL)) AND (NOT execution_enabled OR (commit_hash IS NOT NULL AND tree_hash IS NOT NULL AND lockfile_sha256 IS NOT NULL))),
  CONSTRAINT grid_worker_external CHECK (execution_mode <> 'external' OR (authority_tracking_enabled AND legacy_controls_enabled AND owner_wallet IS NOT NULL)),
  CONSTRAINT grid_worker_lease CHECK (isfinite(lease_expires_at) OR (lease_expires_at = '-infinity'::timestamptz AND holder_boot_id IS NULL)),
  CONSTRAINT grid_worker_host_clock CHECK ((heartbeat_at IS NULL OR isfinite(heartbeat_at)) AND (progress_at IS NULL OR isfinite(progress_at)) AND (last_healthz_poll_at IS NULL OR isfinite(last_healthz_poll_at)) AND (pause_ack_at IS NULL OR isfinite(pause_ack_at)) AND (updated_at IS NULL OR isfinite(updated_at)))
);


CREATE TABLE grid_worker_wallet_authority (
  wallet_address text NOT NULL,
  generation bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (wallet_address),
  CONSTRAINT grid_worker_authority_wallet_fk FOREIGN KEY (wallet_address) REFERENCES wallets(address) ON DELETE RESTRICT,
  CONSTRAINT grid_worker_generation CHECK (generation >= 0),
  CONSTRAINT grid_worker_authority_clock CHECK ((updated_at IS NULL OR isfinite(updated_at)))
);


CREATE TABLE grid_worker_requests (
  id uuid NOT NULL,
  owner_wallet text NOT NULL,
  bot_id uuid NOT NULL,
  action text NOT NULL,
  request_key text NOT NULL,
  draft_revision text NOT NULL,
  server_intent_digest text NOT NULL,
  policy_hmac text NOT NULL,
  spending_policy_digest text NOT NULL,
  wallet_generation bigint NOT NULL,
  scope_revision bigint NOT NULL,
  consent_version text NOT NULL,
  consent_mac text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  admitted_at timestamptz,
  completed_at timestamptz,
  control_request_id uuid,
  result_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (id),
  UNIQUE (owner_wallet,request_key),
  CONSTRAINT grid_worker_request_owner_fk FOREIGN KEY (owner_wallet) REFERENCES wallets(address) ON DELETE RESTRICT,
  CONSTRAINT grid_worker_request_bot_fk FOREIGN KEY (bot_id) REFERENCES grid_bots(id) ON DELETE RESTRICT,
  CONSTRAINT grid_worker_request_control_fk FOREIGN KEY (control_request_id) REFERENCES grid_control_requests(id) ON DELETE RESTRICT,
  CONSTRAINT grid_worker_request_kind CHECK (action IN ('start','protective_close','resume') AND state IN ('pending','admitted','complete','superseded','refused','expired')),
  CONSTRAINT grid_worker_request_clock CHECK (isfinite(issued_at) AND isfinite(expires_at) AND expires_at > issued_at AND expires_at <= issued_at + interval '10 minutes'),
  CONSTRAINT grid_worker_request_revision CHECK (wallet_generation >= 0 AND scope_revision > 0 AND length(request_key)>0 AND length(draft_revision)>0 AND length(consent_version)>0 AND length(consent_mac)>0 AND length(policy_hmac)>0),
  CONSTRAINT grid_worker_request_terminal CHECK ((state IN ('complete','superseded','refused','expired')) = (completed_at IS NOT NULL) AND (state <> 'admitted' OR admitted_at IS NOT NULL)),
  CONSTRAINT grid_worker_request_digests CHECK ((server_intent_digest IS NULL OR server_intent_digest ~ '^[0-9a-f]{64}$') AND (spending_policy_digest IS NULL OR spending_policy_digest ~ '^[0-9a-f]{64}$')),
  CONSTRAINT grid_worker_request_dates CHECK ((admitted_at IS NULL OR isfinite(admitted_at)) AND (completed_at IS NULL OR isfinite(completed_at)) AND (created_at IS NULL OR isfinite(created_at)))
);
CREATE INDEX grid_worker_request_pending ON grid_worker_requests(created_at,id) WHERE state = 'pending';
CREATE UNIQUE INDEX grid_worker_start_active ON grid_worker_requests(bot_id) WHERE action = 'start' AND state IN ('pending','admitted');

CREATE TABLE grid_worker_reservations (
  bot_id uuid NOT NULL,
  start_request_id uuid NOT NULL,
  owner_wallet text NOT NULL,
  wallet_generation bigint NOT NULL,
  policy_digest text NOT NULL,
  scope_revision bigint NOT NULL,
  investment_usd numeric NOT NULL,
  leverage integer NOT NULL,
  budget_notional_usd numeric NOT NULL,
  observed_exposure_usd numeric NOT NULL,
  reserve_usd numeric NOT NULL,
  cash_commitment_usd numeric NOT NULL,
  fee_reserve_usd numeric NOT NULL,
  state text NOT NULL DEFAULT 'held',
  facts_at timestamptz NOT NULL,
  terminal_proof_digest text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (bot_id),
  UNIQUE (start_request_id),
  CONSTRAINT grid_worker_reservation_bot_fk FOREIGN KEY (bot_id) REFERENCES grid_bots(id) ON DELETE RESTRICT,
  CONSTRAINT grid_worker_reservation_request_fk FOREIGN KEY (start_request_id) REFERENCES grid_worker_requests(id) ON DELETE RESTRICT,
  CONSTRAINT grid_worker_reservation_wallet_fk FOREIGN KEY (owner_wallet) REFERENCES wallets(address) ON DELETE RESTRICT,
  CONSTRAINT grid_worker_reservation_state CHECK (state IN ('held','uncertain','released') AND (state <> 'released' OR terminal_proof_digest IS NOT NULL)),
  CONSTRAINT grid_worker_reservation_revision CHECK (wallet_generation >= 0 AND scope_revision > 0 AND leverage > 0),
  CONSTRAINT grid_worker_reservation_money CHECK ((investment_usd NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) AND investment_usd >= 0) AND (budget_notional_usd NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) AND budget_notional_usd >= 0) AND (observed_exposure_usd NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) AND observed_exposure_usd >= 0) AND (reserve_usd NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) AND reserve_usd >= 0) AND (cash_commitment_usd NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) AND cash_commitment_usd >= 0) AND (fee_reserve_usd NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) AND fee_reserve_usd >= 0)),
  CONSTRAINT grid_worker_reservation_digests CHECK ((policy_digest IS NULL OR policy_digest ~ '^[0-9a-f]{64}$') AND (terminal_proof_digest IS NULL OR terminal_proof_digest ~ '^[0-9a-f]{64}$')),
  CONSTRAINT grid_worker_reservation_clock CHECK ((facts_at IS NULL OR isfinite(facts_at)) AND (updated_at IS NULL OR isfinite(updated_at)))
);
CREATE INDEX grid_worker_reservation_owner ON grid_worker_reservations(state,owner_wallet);

CREATE TABLE grid_worker_send_audit (
  id uuid NOT NULL,
  operation_id uuid NOT NULL,
  bot_id uuid NOT NULL,
  request_id uuid,
  request_identity text NOT NULL,
  attempt integer NOT NULL,
  kind text NOT NULL,
  holder_boot_id uuid NOT NULL,
  sender_role text NOT NULL,
  fencing_epoch bigint NOT NULL,
  wallet_generation bigint NOT NULL,
  policy_digest text NOT NULL,
  request_digest text NOT NULL,
  signed_at timestamptz NOT NULL,
  signed_expires_at timestamptz NOT NULL,
  prepared_at timestamptz NOT NULL,
  authorized_at timestamptz,
  completed_at timestamptz,
  outcome text NOT NULL DEFAULT 'unknown',
  venue_order_id text,
  venue_trade_id text,
  outcome_code text,
  PRIMARY KEY (id),
  UNIQUE (operation_id,attempt),
  CONSTRAINT grid_worker_audit_operation_fk FOREIGN KEY (operation_id) REFERENCES grid_operations(id) ON DELETE RESTRICT,
  CONSTRAINT grid_worker_audit_bot_fk FOREIGN KEY (bot_id) REFERENCES grid_bots(id) ON DELETE RESTRICT,
  CONSTRAINT grid_worker_audit_request_fk FOREIGN KEY (request_id) REFERENCES grid_worker_requests(id) ON DELETE RESTRICT,
  CONSTRAINT grid_worker_audit_kind CHECK (kind IN ('create','fund','leverage','seed','limit','cancel','close','sweep') AND outcome IN ('unknown','confirmed','refused','failed') AND sender_role IN ('legacy','grid-worker','protective')),
  CONSTRAINT grid_worker_audit_clock CHECK (isfinite(signed_at) AND isfinite(signed_expires_at) AND signed_expires_at > signed_at AND signed_expires_at <= signed_at + interval '15 seconds' AND attempt > 0 AND fencing_epoch >= 0 AND wallet_generation >= 0),
  CONSTRAINT grid_worker_audit_completion CHECK ((outcome = 'unknown') = (completed_at IS NULL)),
  CONSTRAINT grid_worker_audit_dates CHECK ((prepared_at IS NULL OR isfinite(prepared_at)) AND (authorized_at IS NULL OR isfinite(authorized_at)) AND (completed_at IS NULL OR isfinite(completed_at))),
  CONSTRAINT grid_worker_audit_digests CHECK ((policy_digest IS NULL OR policy_digest ~ '^[0-9a-f]{64}$') AND (request_digest IS NULL OR request_digest ~ '^[0-9a-f]{64}$'))
);
CREATE INDEX grid_worker_audit_bot ON grid_worker_send_audit(bot_id,prepared_at);
CREATE INDEX grid_worker_audit_outcome ON grid_worker_send_audit(outcome,signed_expires_at);

CREATE TABLE grid_worker_incidents (
  id uuid NOT NULL,
  dedup_key text NOT NULL,
  severity text NOT NULL,
  code text NOT NULL,
  bot_id uuid,
  holder_boot_id uuid,
  fencing_epoch bigint,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  occurrence_count bigint NOT NULL DEFAULT 1,
  resolved_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by text,
  inbox_seen_at timestamptz,
  evidence_digest text,
  PRIMARY KEY (id),
  CONSTRAINT grid_worker_incident_bot_fk FOREIGN KEY (bot_id) REFERENCES grid_bots(id) ON DELETE RESTRICT,
  CONSTRAINT grid_worker_incident_wallet_fk FOREIGN KEY (acknowledged_by) REFERENCES wallets(address) ON DELETE RESTRICT,
  CONSTRAINT grid_worker_incident_code CHECK (severity IN ('warning','critical') AND code IN ('lease_lost','contender_seen','database_unavailable','clock_unhealthy','progress_stale','stop_failed','transfer_refused','authority_refused','egress_refused','pause_unacknowledged','observer_silent','audit_mismatch','reconciliation_unavailable','protective_failure','schema_drift','quota_pressure','notification_delayed','exposure_above_budget') AND (severity <> 'critical' OR code NOT IN ('quota_pressure','notification_delayed','exposure_above_budget'))),
  CONSTRAINT grid_worker_incident_ack CHECK ((acknowledged_at IS NULL) = (acknowledged_by IS NULL)),
  CONSTRAINT grid_worker_incident_count CHECK (occurrence_count > 0 AND (fencing_epoch IS NULL OR fencing_epoch >= 0) AND last_seen_at >= first_seen_at AND length(dedup_key)>0),
  CONSTRAINT grid_worker_incident_clock CHECK ((first_seen_at IS NULL OR isfinite(first_seen_at)) AND (last_seen_at IS NULL OR isfinite(last_seen_at)) AND (resolved_at IS NULL OR isfinite(resolved_at)) AND (acknowledged_at IS NULL OR isfinite(acknowledged_at)) AND (inbox_seen_at IS NULL OR isfinite(inbox_seen_at))),
  CONSTRAINT grid_worker_incident_digest CHECK ((evidence_digest IS NULL OR evidence_digest ~ '^[0-9a-f]{64}$'))
);
CREATE UNIQUE INDEX grid_worker_incident_open ON grid_worker_incidents(dedup_key) WHERE acknowledged_at IS NULL;
CREATE INDEX grid_worker_incident_unacked ON grid_worker_incidents(severity,first_seen_at) WHERE acknowledged_at IS NULL;

CREATE TABLE grid_worker_reconciliation (
  account text NOT NULL,
  master_account text NOT NULL,
  bot_id uuid,
  stream text NOT NULL,
  cursor text,
  covered_through_at timestamptz,
  last_attempt_at timestamptz,
  last_complete_at timestamptz,
  state text NOT NULL DEFAULT 'pending',
  evidence_digest text,
  PRIMARY KEY (account,stream),
  CONSTRAINT grid_worker_reconciliation_bot_fk FOREIGN KEY (bot_id) REFERENCES grid_bots(id) ON DELETE RESTRICT,
  CONSTRAINT grid_worker_reconciliation_state CHECK (stream IN ('orders','fills','transfers') AND state IN ('pending','complete','incomplete','mismatch') AND length(account)>0 AND length(master_account)>0 AND (state <> 'complete' OR (last_complete_at IS NOT NULL AND covered_through_at IS NOT NULL AND evidence_digest IS NOT NULL))),
  CONSTRAINT grid_worker_reconciliation_clock CHECK ((covered_through_at IS NULL OR isfinite(covered_through_at)) AND (last_attempt_at IS NULL OR isfinite(last_attempt_at)) AND (last_complete_at IS NULL OR isfinite(last_complete_at))),
  CONSTRAINT grid_worker_reconciliation_digest CHECK ((evidence_digest IS NULL OR evidence_digest ~ '^[0-9a-f]{64}$'))
);
CREATE INDEX grid_worker_reconciliation_complete ON grid_worker_reconciliation(last_complete_at);

CREATE TABLE grid_worker_quota_policy (
  provider text NOT NULL,
  domain_id text NOT NULL,
  window_ms integer NOT NULL,
  total_units numeric NOT NULL,
  worker_limit_units numeric NOT NULL,
  worker_protective_reserve_units numeric NOT NULL,
  policy_digest text NOT NULL,
  valid_until timestamptz NOT NULL,
  PRIMARY KEY (provider,domain_id),
  CONSTRAINT gw_quota_policy_domain CHECK (provider IN ('pacifica_rest','pacifica_ws','rpc_primary','rpc_backup') AND length(domain_id)>0),
  CONSTRAINT gw_quota_policy_budget CHECK (window_ms > 0 AND total_units > 0 AND worker_limit_units > 0 AND worker_limit_units < total_units AND worker_protective_reserve_units >= 0 AND worker_protective_reserve_units < worker_limit_units),
  CONSTRAINT gw_quota_policy_finite CHECK ((total_units NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) AND total_units >= 0) AND (worker_limit_units NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) AND worker_limit_units >= 0) AND (worker_protective_reserve_units NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) AND worker_protective_reserve_units >= 0)),
  CONSTRAINT gw_quota_policy_digest CHECK ((policy_digest IS NULL OR policy_digest ~ '^[0-9a-f]{64}$')),
  CONSTRAINT gw_quota_policy_clock CHECK ((valid_until IS NULL OR isfinite(valid_until)))
);


CREATE TABLE grid_worker_quota_windows (
  provider text NOT NULL,
  domain_id text NOT NULL,
  window_ms integer NOT NULL,
  total_units numeric NOT NULL,
  worker_limit_units numeric NOT NULL,
  worker_protective_reserve_units numeric NOT NULL,
  policy_digest text NOT NULL,
  window_start timestamptz NOT NULL,
  worker_used_units numeric NOT NULL DEFAULT 0,
  observed_at timestamptz NOT NULL,
  backoff_until timestamptz,
  PRIMARY KEY (provider,domain_id,window_start),
  CONSTRAINT gw_quota_windows_domain CHECK (provider IN ('pacifica_rest','pacifica_ws','rpc_primary','rpc_backup') AND length(domain_id)>0),
  CONSTRAINT gw_quota_windows_budget CHECK (window_ms > 0 AND total_units > 0 AND worker_limit_units > 0 AND worker_limit_units < total_units AND worker_protective_reserve_units >= 0 AND worker_protective_reserve_units < worker_limit_units AND worker_used_units >= 0 AND worker_used_units <= worker_limit_units),
  CONSTRAINT gw_quota_windows_finite CHECK ((total_units NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) AND total_units >= 0) AND (worker_limit_units NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) AND worker_limit_units >= 0) AND (worker_protective_reserve_units NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) AND worker_protective_reserve_units >= 0) AND (worker_used_units NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) AND worker_used_units >= 0)),
  CONSTRAINT gw_quota_windows_digest CHECK ((policy_digest IS NULL OR policy_digest ~ '^[0-9a-f]{64}$')),
  CONSTRAINT gw_quota_windows_clock CHECK ((window_start IS NULL OR isfinite(window_start)) AND (observed_at IS NULL OR isfinite(observed_at)) AND (backoff_until IS NULL OR isfinite(backoff_until)))
);
CREATE INDEX grid_worker_quota_window_latest ON grid_worker_quota_windows(provider,domain_id,window_start DESC);

CREATE TABLE owner_action_receipts (
  receipt_id uuid NOT NULL DEFAULT gen_random_uuid(),
  owner_wallet text NOT NULL,
  action text NOT NULL,
  scope text NOT NULL,
  target text NOT NULL,
  nonce text NOT NULL,
  message_digest char(64) NOT NULL,
  params_digest text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consumed_at timestamptz,
  consumed_by text,
  PRIMARY KEY (receipt_id),
  UNIQUE (nonce),
  CONSTRAINT owner_receipt_wallet_fk FOREIGN KEY (owner_wallet) REFERENCES wallets(address) ON DELETE RESTRICT,
  CONSTRAINT owner_receipt_action CHECK (action IN ('pause','reset_pause','ack_critical','widen_scope','break_glass_close')),
  CONSTRAINT owner_receipt_scope CHECK (scope = 'grid_worker'),
  CONSTRAINT owner_receipt_message_digest CHECK ((message_digest IS NULL OR message_digest ~ '^[0-9a-f]{64}$')),
  CONSTRAINT owner_receipt_params_digest CHECK (params_digest = 'none' OR params_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT owner_receipt_window CHECK (isfinite(issued_at) AND isfinite(expires_at) AND expires_at > issued_at AND expires_at <= issued_at + interval '300 seconds'),
  CONSTRAINT owner_receipt_consumption CHECK ((consumed_at IS NULL) = (consumed_by IS NULL)),
  CONSTRAINT owner_receipt_clock CHECK ((verified_at IS NULL OR isfinite(verified_at)) AND (consumed_at IS NULL OR isfinite(consumed_at)))
);
CREATE INDEX owner_receipt_pending ON owner_action_receipts(action,target) WHERE consumed_at IS NULL;

CREATE FUNCTION grid_worker_has_host_lock(exclusive_required boolean) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $body$
DECLARE key bigint := hashtextextended('qv:grid-worker:v3:host',0);
BEGIN
  RETURN EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=((key >> 32) & 4294967295)::oid AND objid=(key & 4294967295)::oid AND objsubid=1 AND (mode='ExclusiveLock' OR (NOT exclusive_required AND mode='ShareLock')));
END
$body$;

CREATE FUNCTION grid_worker_has_wallet_lock(wallet text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $body$
BEGIN
  RETURN EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=927412::oid AND objid=(hashtext(wallet)::bigint & 4294967295)::oid AND objsubid=2 AND mode='ExclusiveLock');
END
$body$;

CREATE FUNCTION grid_worker_validate_host() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public AS $body$
DECLARE action_context text := current_setting('qv.grid_worker_action',true); changed_scope boolean; heartbeat_only boolean;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT grid_worker_has_host_lock(true) OR NEW.execution_enabled OR NEW.execution_mode<>'legacy' OR NEW.run_mode<>'test' OR NOT NEW.entries_paused OR NEW.authority_tracking_enabled OR NEW.legacy_controls_enabled OR NEW.fencing_epoch<>0 THEN RAISE EXCEPTION 'GRID_HOST_BOOTSTRAP_INVALID'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.owner_wallet IS DISTINCT FROM OLD.owner_wallet OR NEW.singleton_id<>OLD.singleton_id OR NEW.protocol_version<>OLD.protocol_version THEN RAISE EXCEPTION 'GRID_HOST_IDENTITY_IMMUTABLE'; END IF;
  IF NEW.fencing_epoch<OLD.fencing_epoch OR NEW.scope_revision<OLD.scope_revision OR NEW.pause_revision<OLD.pause_revision OR (OLD.authority_tracking_enabled AND NOT NEW.authority_tracking_enabled) OR (OLD.legacy_controls_enabled AND NOT NEW.legacy_controls_enabled) THEN RAISE EXCEPTION 'GRID_HOST_MONOTONIC'; END IF;
  heartbeat_only := (to_jsonb(NEW)-ARRAY['lease_expires_at','heartbeat_at','progress_at','last_healthz_poll_at'])=(to_jsonb(OLD)-ARRAY['lease_expires_at','heartbeat_at','progress_at','last_healthz_poll_at']);
  IF heartbeat_only THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
    IF action_context IS DISTINCT FROM 'heartbeat' OR OLD.holder_boot_id IS NULL OR OLD.lease_expires_at IS NULL OR OLD.lease_expires_at<=clock_timestamp() OR current_setting('qv.grid_worker_holder',true) IS DISTINCT FROM OLD.holder_boot_id::text OR current_setting('qv.grid_worker_epoch',true) IS DISTINCT FROM OLD.fencing_epoch::text OR NEW.lease_expires_at IS NULL OR NEW.lease_expires_at<OLD.lease_expires_at OR NEW.heartbeat_at<OLD.heartbeat_at OR NEW.progress_at<OLD.progress_at OR NEW.last_healthz_poll_at>clock_timestamp() THEN RAISE EXCEPTION 'GRID_HEARTBEAT_CAS_REQUIRED'; END IF;
    RETURN NEW;
  END IF;
  IF NOT grid_worker_has_host_lock(false) THEN RAISE EXCEPTION 'GRID_HOST_PRELOCK_REQUIRED'; END IF;
  IF action_context IS NULL OR action_context NOT IN ('pause','reset','transition','bootstrap_tracking','tighten','observer_clear','pause_ack') THEN RAISE EXCEPTION 'GRID_HOST_CONTEXT_REQUIRED'; END IF;
  IF action_context='pause' THEN
    IF NOT grid_worker_has_host_lock(true) OR NOT NEW.entries_paused OR NEW.pause_revision<>OLD.pause_revision+1 OR NEW.pause_ack_at IS NOT NULL OR NEW.pause_ack_revision IS NOT NULL OR (to_jsonb(NEW)-ARRAY['entries_paused','pause_revision','pause_ack_at','pause_ack_revision']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['entries_paused','pause_revision','pause_ack_at','pause_ack_revision']) THEN RAISE EXCEPTION 'GRID_PAUSE_MUTATION_INVALID'; END IF;
    RETURN NEW;
  END IF;
  IF action_context='pause_ack' THEN
    IF OLD.holder_boot_id IS NULL OR NOT OLD.entries_paused OR NEW.pause_ack_revision IS DISTINCT FROM OLD.pause_revision OR NEW.pause_ack_at IS NULL OR NEW.pause_ack_at>clock_timestamp() OR OLD.lease_expires_at IS NULL OR OLD.lease_expires_at<=clock_timestamp() OR current_setting('qv.grid_worker_holder',true) IS DISTINCT FROM OLD.holder_boot_id::text OR current_setting('qv.grid_worker_epoch',true) IS DISTINCT FROM OLD.fencing_epoch::text OR (to_jsonb(NEW)-ARRAY['pause_ack_at','pause_ack_revision']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['pause_ack_at','pause_ack_revision']) THEN RAISE EXCEPTION 'GRID_PAUSE_ACK_INVALID'; END IF;
    RETURN NEW;
  END IF;
  IF action_context='tighten' THEN
    IF (OLD.entries_paused AND NOT NEW.entries_paused) OR (OLD.observer_fenced AND NOT NEW.observer_fenced) OR (OLD.drain_requested AND NOT NEW.drain_requested) OR (NOT OLD.execution_enabled AND NEW.execution_enabled) OR (to_jsonb(NEW)-ARRAY['entries_paused','observer_fenced','drain_requested','execution_enabled','pause_revision','pause_ack_at','pause_ack_revision']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['entries_paused','observer_fenced','drain_requested','execution_enabled','pause_revision','pause_ack_at','pause_ack_revision']) THEN RAISE EXCEPTION 'GRID_TIGHTEN_ONLY'; END IF;
  ELSIF action_context='observer_clear' THEN
    IF NOT OLD.observer_fenced OR NEW.observer_fenced OR OLD.holder_boot_id IS NULL OR OLD.lease_expires_at IS NULL OR OLD.lease_expires_at<=clock_timestamp() OR current_setting('qv.grid_worker_holder',true) IS DISTINCT FROM OLD.holder_boot_id::text OR current_setting('qv.grid_worker_epoch',true) IS DISTINCT FROM OLD.fencing_epoch::text OR OLD.last_healthz_poll_at IS NULL OR OLD.last_healthz_poll_at<clock_timestamp()-interval '60 seconds' OR OLD.last_healthz_poll_at>clock_timestamp() OR current_setting('qv.grid_worker_ready',true) IS DISTINCT FROM 'true' OR EXISTS(SELECT 1 FROM grid_worker_incidents WHERE code='observer_silent' AND (resolved_at IS NULL OR acknowledged_at IS NULL)) OR (to_jsonb(NEW)-'observer_fenced') IS DISTINCT FROM (to_jsonb(OLD)-'observer_fenced') THEN RAISE EXCEPTION 'GRID_OBSERVER_CLEAR_INVALID'; END IF;
    RETURN NEW;
  ELSE
    IF NOT grid_worker_has_host_lock(true) THEN RAISE EXCEPTION 'GRID_HOST_EXCLUSIVE_REQUIRED'; END IF;
    IF action_context='bootstrap_tracking' THEN
      IF OLD.authority_tracking_enabled OR NOT NEW.authority_tracking_enabled OR OLD.execution_enabled OR OLD.execution_mode<>'legacy' OR NOT OLD.entries_paused OR (to_jsonb(NEW)-'authority_tracking_enabled') IS DISTINCT FROM (to_jsonb(OLD)-'authority_tracking_enabled') OR EXISTS(SELECT 1 FROM wallets w LEFT JOIN grid_worker_wallet_authority a ON a.wallet_address=w.address WHERE a.wallet_address IS NULL) THEN RAISE EXCEPTION 'GRID_TRACKING_BOOTSTRAP_INVALID'; END IF;
      RETURN NEW;
    END IF;
    -- Context is not authentication: U2b must consume fresh owner receipts in this transaction.
    -- The shared-login residual risk is explicitly accepted; these validators enforce ordering/shape.
    IF current_setting('qv.grid_worker_ready',true) IS DISTINCT FROM 'true' OR current_setting('qv.grid_worker_owner_verified',true) IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'GRID_OWNER_TRANSITION_REQUIRED'; END IF;
    IF OLD.entries_paused AND NOT NEW.entries_paused AND (action_context<>'reset' OR current_setting('qv.grid_worker_deployment_flags_clear',true) IS DISTINCT FROM 'true' OR EXISTS(SELECT 1 FROM grid_worker_incidents WHERE severity='critical' AND (resolved_at IS NULL OR acknowledged_at IS NULL))) THEN RAISE EXCEPTION 'GRID_RESET_REQUIRED'; END IF;
  END IF;
  IF NEW.entries_paused IS DISTINCT FROM OLD.entries_paused THEN
    IF NEW.pause_revision<>OLD.pause_revision+1 OR NEW.pause_ack_at IS NOT NULL OR NEW.pause_ack_revision IS NOT NULL THEN RAISE EXCEPTION 'GRID_PAUSE_REVISION_REQUIRED'; END IF;
  ELSIF NEW.pause_revision<>OLD.pause_revision OR NEW.pause_ack_at IS DISTINCT FROM OLD.pause_ack_at OR NEW.pause_ack_revision IS DISTINCT FROM OLD.pause_ack_revision THEN RAISE EXCEPTION 'GRID_PAUSE_REVISION_INVALID'; END IF;
  changed_scope := ROW(NEW.start_scope,NEW.per_bot_cap_usd,NEW.global_ceiling_usd) IS DISTINCT FROM ROW(OLD.start_scope,OLD.per_bot_cap_usd,OLD.global_ceiling_usd);
  IF changed_scope THEN
    IF NEW.scope_revision<>OLD.scope_revision+1 THEN RAISE EXCEPTION 'GRID_SCOPE_REVISION_REQUIRED'; END IF;
    UPDATE grid_worker_requests SET state='superseded',completed_at=clock_timestamp(),result_code='scope_changed' WHERE state='pending';
  ELSIF NEW.scope_revision<>OLD.scope_revision THEN RAISE EXCEPTION 'GRID_SCOPE_REVISION_INVALID'; END IF;
  IF ROW(NEW.holder_boot_id,NEW.holder_role) IS DISTINCT FROM ROW(OLD.holder_boot_id,OLD.holder_role) AND NEW.fencing_epoch<=OLD.fencing_epoch THEN RAISE EXCEPTION 'GRID_EPOCH_REQUIRED'; END IF;
  RETURN NEW;
END
$body$;

CREATE FUNCTION grid_worker_validate_generation() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public AS $body$
BEGIN
  IF NOT grid_worker_has_host_lock(false) OR NOT grid_worker_has_wallet_lock(NEW.wallet_address) THEN RAISE EXCEPTION 'GRID_AUTHORITY_PRELOCK_REQUIRED'; END IF;
  IF TG_OP='UPDATE' AND (NEW.wallet_address<>OLD.wallet_address OR NEW.generation<OLD.generation) THEN RAISE EXCEPTION 'GRID_GENERATION_MONOTONIC'; END IF;
  RETURN NEW;
END
$body$;

CREATE FUNCTION grid_worker_track_wallet() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public AS $body$
BEGIN
  -- Missing host is inert ONLY because worker readiness independently fails closed.
  IF NOT COALESCE((SELECT authority_tracking_enabled FROM grid_worker_host WHERE singleton_id=1),false) THEN RETURN NEW; END IF;
  IF NOT grid_worker_has_host_lock(false) OR NOT grid_worker_has_wallet_lock(NEW.address) THEN RAISE EXCEPTION 'GRID_WALLET_PRELOCK_REQUIRED'; END IF;
  IF TG_OP='INSERT' THEN
    INSERT INTO grid_worker_wallet_authority(wallet_address,generation) VALUES(NEW.address,0);
  ELSE
    UPDATE grid_worker_wallet_authority SET generation=generation+1,updated_at=clock_timestamp() WHERE wallet_address=NEW.address;
    IF NOT FOUND THEN RAISE EXCEPTION 'GRID_AUTHORITY_HISTORY_MISSING'; END IF;
    UPDATE grid_worker_requests SET state='superseded',completed_at=clock_timestamp(),result_code='authority_changed' WHERE owner_wallet=NEW.address AND state='pending';
  END IF;
  RETURN NEW;
END
$body$;

CREATE FUNCTION grid_worker_validate_owner_scope() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public AS $body$
DECLARE wallet text; bot uuid; master text; pool_id integer; pool_wallet text; pool_agent text; h grid_worker_host%ROWTYPE; lock_keys bigint[] := ARRAY[]::bigint[]; lock_key bigint;
BEGIN
  -- No locks, mutations or exceptions in the dormant or absent-host branch.
  IF NOT COALESCE((SELECT authority_tracking_enabled FROM grid_worker_host WHERE singleton_id=1),false) THEN RETURN NEW; END IF;
  SELECT * INTO h FROM grid_worker_host WHERE singleton_id=1;
  IF NOT grid_worker_has_host_lock(false) THEN RAISE EXCEPTION 'GRID_OWNER_PRELOCK_REQUIRED'; END IF;
  IF TG_TABLE_NAME='grid_bots' THEN
    wallet:=NEW.wallet_address; bot:=NEW.id;
    lock_keys:=ARRAY[hashtextextended('qv:grid-worker:v3:bot:'||bot::text,0)];
    IF TG_OP='UPDATE' AND NEW.wallet_address IS DISTINCT FROM OLD.wallet_address THEN RAISE EXCEPTION 'GRID_BOT_OWNER_IMMUTABLE'; END IF;
  ELSIF TG_TABLE_NAME='protocol_subaccounts' THEN
    wallet:=NEW.wallet_address;
    lock_keys:=ARRAY[hashtextextended('qv:grid-worker:v3:pool:'||NEW.id::text,0)] || ARRAY(SELECT hashtextextended('qv:grid-worker:v3:bot:'||l.bot_id::text,0) FROM grid_launch_accounts l WHERE l.protocol_subaccount_id=NEW.id AND l.released_at IS NULL);
    IF TG_OP='UPDATE' THEN IF NOT grid_worker_has_wallet_lock(OLD.wallet_address) THEN RAISE EXCEPTION 'GRID_WALLET_PRELOCK_REQUIRED'; END IF; END IF;
    IF EXISTS(SELECT 1 FROM grid_launch_accounts l JOIN grid_bots b ON b.id=l.bot_id WHERE l.protocol_subaccount_id=NEW.id AND l.released_at IS NULL AND (b.wallet_address<>wallet OR l.master_account IS DISTINCT FROM NEW.agent_public_key)) THEN RAISE EXCEPTION 'GRID_POOL_OWNER_MISMATCH'; END IF;
  ELSIF TG_TABLE_NAME='grid_launch_accounts' THEN
    bot:=NEW.bot_id; master:=NEW.master_account; pool_id:=NEW.protocol_subaccount_id;
    lock_keys:=ARRAY[hashtextextended('qv:grid-worker:v3:bot:'||bot::text,0),hashtextextended('qv:grid-worker:v3:pool:'||pool_id::text,0)];
    IF TG_OP='UPDATE' THEN lock_keys:=lock_keys || ARRAY[hashtextextended('qv:grid-worker:v3:bot:'||OLD.bot_id::text,0),hashtextextended('qv:grid-worker:v3:pool:'||OLD.protocol_subaccount_id::text,0)]; END IF;
    SELECT wallet_address INTO wallet FROM grid_bots WHERE id=bot;
    SELECT wallet_address,agent_public_key INTO pool_wallet,pool_agent FROM protocol_subaccounts WHERE id=pool_id;
    IF wallet IS NULL OR pool_wallet IS DISTINCT FROM wallet OR pool_agent IS DISTINCT FROM master OR NOT EXISTS(SELECT 1 FROM wallets WHERE address=wallet AND agent_public_key=master) THEN RAISE EXCEPTION 'GRID_LAUNCH_OWNER_MISMATCH'; END IF;
  ELSE
    wallet:=NEW.owner_wallet; bot:=NEW.bot_id;
    lock_keys:=ARRAY[hashtextextended('qv:grid-worker:v3:bot:'||bot::text,0)];
    IF NOT EXISTS(SELECT 1 FROM grid_bots WHERE id=bot AND wallet_address=wallet) THEN RAISE EXCEPTION 'GRID_REQUEST_OWNER_MISMATCH'; END IF;
    IF TG_TABLE_NAME='grid_worker_requests' THEN
      IF NEW.action IN ('start','resume') AND h.start_scope='owner_allowlist' AND NOT EXISTS(SELECT 1 FROM grid_worker_owner WHERE singleton_id=1 AND wallet_address=wallet AND wallet_address=h.owner_wallet) THEN RAISE EXCEPTION 'GRID_OWNER_SCOPE_REFUSED'; END IF;
    END IF;
    IF TG_TABLE_NAME='grid_worker_reservations' THEN
      IF NOT EXISTS(SELECT 1 FROM grid_worker_requests WHERE id=NEW.start_request_id AND bot_id=bot AND owner_wallet=wallet AND wallet_generation=NEW.wallet_generation AND scope_revision=NEW.scope_revision) THEN RAISE EXCEPTION 'GRID_RESERVATION_REQUEST_MISMATCH'; END IF;
    END IF;
  END IF;
  FOREACH lock_key IN ARRAY lock_keys LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=((lock_key >> 32) & 4294967295)::oid AND objid=(lock_key & 4294967295)::oid AND objsubid=1 AND mode='ExclusiveLock') THEN RAISE EXCEPTION 'GRID_IDENTITY_PRELOCK_REQUIRED'; END IF;
  END LOOP;
  IF wallet IS NULL OR NOT grid_worker_has_wallet_lock(wallet) THEN RAISE EXCEPTION 'GRID_WALLET_PRELOCK_REQUIRED'; END IF;
  RETURN NEW;
END
$body$;

CREATE FUNCTION grid_worker_consume_receipt(receipt_id uuid, expected_action text, expected_target text, expected_params_digest text) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public AS $body$
DECLARE r owner_action_receipts%ROWTYPE; db_now timestamptz := clock_timestamp(); message text;
BEGIN
  IF NOT grid_worker_has_host_lock(true) THEN RAISE EXCEPTION 'GRID_HOST_EXCLUSIVE_REQUIRED'; END IF;
  SELECT * INTO r FROM owner_action_receipts WHERE owner_action_receipts.receipt_id=grid_worker_consume_receipt.receipt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GRID_RECEIPT_MISSING'; END IF;
  IF r.action IS DISTINCT FROM expected_action OR r.scope<>'grid_worker' OR r.target IS DISTINCT FROM expected_target OR r.params_digest IS DISTINCT FROM expected_params_digest THEN RAISE EXCEPTION 'GRID_RECEIPT_BINDING'; END IF;
  IF NOT EXISTS(SELECT 1 FROM grid_worker_owner o JOIN grid_worker_host h ON h.singleton_id=o.singleton_id AND h.owner_wallet=o.wallet_address WHERE o.singleton_id=1 AND o.wallet_address=r.owner_wallet) THEN RAISE EXCEPTION 'GRID_RECEIPT_OWNER'; END IF;
  IF (r.action IN ('pause','reset_pause','ack_critical') AND r.params_digest<>'none') OR (r.action IN ('widen_scope','break_glass_close') AND r.params_digest='none') THEN RAISE EXCEPTION 'GRID_RECEIPT_PARAMS'; END IF;
  IF r.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'GRID_RECEIPT_CONSUMED'; END IF;
  IF r.issued_at>db_now OR r.expires_at<=db_now OR r.expires_at<=r.issued_at OR r.expires_at>r.issued_at+interval '300 seconds' OR NOT isfinite(r.issued_at) OR NOT isfinite(r.expires_at) THEN RAISE EXCEPTION 'GRID_RECEIPT_EXPIRED'; END IF;
  IF r.verified_at<db_now-interval '60 seconds' OR r.verified_at>db_now OR r.verified_at<r.issued_at THEN RAISE EXCEPTION 'GRID_RECEIPT_STALE'; END IF;
  IF r.nonce !~ '^[1-9A-HJ-NP-Za-km-z]{43,44}$' OR r.target !~ '^(host:[a-z0-9-]{1,64}|incident:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|bot:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|all)$' OR date_trunc('milliseconds',r.issued_at)<>r.issued_at OR date_trunc('milliseconds',r.expires_at)<>r.expires_at THEN RAISE EXCEPTION 'GRID_RECEIPT_CANONICAL'; END IF;
  message := 'QV-OWNER-ACTION v1'||chr(10)||'action:'||r.action||chr(10)||'scope:'||r.scope||chr(10)||'target:'||r.target||chr(10)||'nonce:'||r.nonce||chr(10)||'issued:'||to_char(r.issued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')||chr(10)||'expires:'||to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')||chr(10)||'params:'||r.params_digest;
  IF r.message_digest IS DISTINCT FROM encode(sha256(convert_to(message,'UTF8')),'hex') THEN RAISE EXCEPTION 'GRID_RECEIPT_DIGEST'; END IF;
  UPDATE owner_action_receipts SET consumed_at=db_now,consumed_by='grid_worker_consume_receipt' WHERE owner_action_receipts.receipt_id=r.receipt_id;
END
$body$;

CREATE FUNCTION grid_worker_pause_from_verified_receipt(receipt_id uuid, expected_action text DEFAULT 'pause', expected_target text DEFAULT 'all', expected_params_digest text DEFAULT 'none') RETURNS void LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public AS $body$
DECLARE previous_context text := current_setting('qv.grid_worker_action',true);
BEGIN
  IF expected_action IS DISTINCT FROM 'pause' OR expected_target IS DISTINCT FROM 'all' OR expected_params_digest IS DISTINCT FROM 'none' THEN RAISE EXCEPTION 'GRID_PAUSE_BINDING'; END IF;
  PERFORM grid_worker_consume_receipt(receipt_id,expected_action,expected_target,expected_params_digest);
  PERFORM set_config('qv.grid_worker_action','pause',true);
  UPDATE grid_worker_host SET entries_paused=true,pause_revision=pause_revision+1,pause_ack_at=NULL,pause_ack_revision=NULL WHERE singleton_id=1;
  IF NOT FOUND THEN RAISE EXCEPTION 'GRID_HOST_MISSING'; END IF;
  UPDATE owner_action_receipts SET consumed_by='grid_worker_pause_from_verified_receipt' WHERE owner_action_receipts.receipt_id=grid_worker_pause_from_verified_receipt.receipt_id;
  PERFORM set_config('qv.grid_worker_action',COALESCE(previous_context,''),true);
END
$body$;

CREATE TRIGGER grid_worker_host_validate BEFORE INSERT OR UPDATE ON grid_worker_host FOR EACH ROW EXECUTE FUNCTION grid_worker_validate_host();
CREATE TRIGGER grid_worker_generation_validate BEFORE INSERT OR UPDATE ON grid_worker_wallet_authority FOR EACH ROW EXECUTE FUNCTION grid_worker_validate_generation();
CREATE TRIGGER grid_worker_wallet_update AFTER UPDATE OF execution_enabled,umk_encrypted_for_execution,execution_expires_at,emergency_stop_triggered,agent_public_key,agent_private_key_encrypted_v3,umk_version ON wallets FOR EACH ROW WHEN (OLD.execution_enabled IS DISTINCT FROM NEW.execution_enabled OR OLD.umk_encrypted_for_execution IS DISTINCT FROM NEW.umk_encrypted_for_execution OR OLD.execution_expires_at IS DISTINCT FROM NEW.execution_expires_at OR OLD.emergency_stop_triggered IS DISTINCT FROM NEW.emergency_stop_triggered OR OLD.agent_public_key IS DISTINCT FROM NEW.agent_public_key OR OLD.agent_private_key_encrypted_v3 IS DISTINCT FROM NEW.agent_private_key_encrypted_v3 OR OLD.umk_version IS DISTINCT FROM NEW.umk_version) EXECUTE FUNCTION grid_worker_track_wallet();
CREATE TRIGGER grid_worker_wallet_insert AFTER INSERT ON wallets FOR EACH ROW EXECUTE FUNCTION grid_worker_track_wallet();
CREATE TRIGGER grid_worker_grid_bots_insert BEFORE INSERT ON grid_bots FOR EACH ROW EXECUTE FUNCTION grid_worker_validate_owner_scope();
CREATE TRIGGER grid_worker_grid_bots_update BEFORE UPDATE OF wallet_address ON grid_bots FOR EACH ROW WHEN (OLD.wallet_address IS DISTINCT FROM NEW.wallet_address) EXECUTE FUNCTION grid_worker_validate_owner_scope();
CREATE TRIGGER grid_worker_protocol_subaccounts_insert BEFORE INSERT ON protocol_subaccounts FOR EACH ROW EXECUTE FUNCTION grid_worker_validate_owner_scope();
CREATE TRIGGER grid_worker_protocol_subaccounts_update BEFORE UPDATE OF wallet_address,agent_public_key ON protocol_subaccounts FOR EACH ROW WHEN (OLD.wallet_address IS DISTINCT FROM NEW.wallet_address OR OLD.agent_public_key IS DISTINCT FROM NEW.agent_public_key) EXECUTE FUNCTION grid_worker_validate_owner_scope();
CREATE TRIGGER grid_worker_grid_launch_accounts_insert BEFORE INSERT ON grid_launch_accounts FOR EACH ROW EXECUTE FUNCTION grid_worker_validate_owner_scope();
CREATE TRIGGER grid_worker_grid_launch_accounts_update BEFORE UPDATE OF bot_id,master_account,protocol_subaccount_id ON grid_launch_accounts FOR EACH ROW WHEN (OLD.bot_id IS DISTINCT FROM NEW.bot_id OR OLD.master_account IS DISTINCT FROM NEW.master_account OR OLD.protocol_subaccount_id IS DISTINCT FROM NEW.protocol_subaccount_id) EXECUTE FUNCTION grid_worker_validate_owner_scope();
CREATE TRIGGER grid_worker_requests_owner_validate BEFORE INSERT OR UPDATE ON grid_worker_requests FOR EACH ROW EXECUTE FUNCTION grid_worker_validate_owner_scope();
CREATE TRIGGER grid_worker_reservations_owner_validate BEFORE INSERT OR UPDATE ON grid_worker_reservations FOR EACH ROW EXECUTE FUNCTION grid_worker_validate_owner_scope();
END
$install$;
COMMIT;
