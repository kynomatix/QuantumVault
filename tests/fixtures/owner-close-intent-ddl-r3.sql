-- Owner-run DDL only. Does not connect or execute during the build.
-- Generated from the runtime DDL and manifest. Existing public objects fail closed on shape differences.
BEGIN;
SET LOCAL search_path = public, pg_catalog;
CREATE TEMP TABLE qv_r3_expected_close_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text NOT NULL,
  owner_wallet text NOT NULL,
  bot_id varchar NOT NULL,
  original_trade_id varchar NOT NULL UNIQUE,
  protocol text NOT NULL DEFAULT 'pacifica',
  environment text NOT NULL,
  original_account text NOT NULL,
  original_subaccount_id integer,
  signer_public_key text NOT NULL,
  signer_mode text NOT NULL,
  authority_ref jsonb NOT NULL,
  position_epoch jsonb NOT NULL,
  market text NOT NULL,
  close_kind text NOT NULL,
  position_side text NOT NULL,
  original_position_size_base text NOT NULL,
  requested_size_base text NOT NULL,
  client_order_id uuid NOT NULL UNIQUE,
  request_payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  dispatch_state text NOT NULL DEFAULT 'not_admitted',
  attempt_count smallint NOT NULL DEFAULT 0,
  attempt_log jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_observed_at timestamptz,
  next_action_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  release_mode text,
  CONSTRAINT sb_close_source_unique UNIQUE (owner_wallet, bot_id, source_key),
  CONSTRAINT sb_close_protocol_check CHECK (protocol = 'pacifica'),
  CONSTRAINT sb_close_scope_check CHECK (length(source_key) > 0 AND length(owner_wallet) > 0 AND length(bot_id) > 0 AND length(original_trade_id) > 0 AND length(environment) > 0 AND length(original_account) > 0 AND length(market) > 0 AND original_subaccount_id IS NULL),
  CONSTRAINT sb_close_signer_check CHECK (signer_mode IN ('external_key','wallet_agent') AND signer_public_key = original_account AND jsonb_typeof(authority_ref) = 'object' AND authority_ref <> '{}'::jsonb),
  CONSTRAINT sb_close_objective_check CHECK (close_kind IN ('full','partial') AND position_side IN ('long','short') AND jsonb_typeof(position_epoch) = 'object' AND position_epoch <> '{}'::jsonb),
  CONSTRAINT sb_close_original_size_check CHECK (length(original_position_size_base) <= 80 AND original_position_size_base ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$' AND original_position_size_base !~ '^0(\.0+)?$'),
  CONSTRAINT sb_close_requested_size_check CHECK (length(requested_size_base) <= 80 AND requested_size_base ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$' AND requested_size_base !~ '^0(\.0+)?$'),
  CONSTRAINT sb_close_size_bound_check CHECK (requested_size_base::numeric <= original_position_size_base::numeric AND (close_kind <> 'full' OR requested_size_base::numeric = original_position_size_base::numeric)),
  CONSTRAINT sb_close_payload_check CHECK (jsonb_typeof(request_payload) = 'object' AND request_payload @> jsonb_build_object('account', original_account, 'reduce_only', true, 'amount', requested_size_base, 'client_order_id', client_order_id::text) AND ((position_side = 'long' AND request_payload @> '{"side":"ask"}'::jsonb) OR (position_side = 'short' AND request_payload @> '{"side":"bid"}'::jsonb))),
  CONSTRAINT sb_close_status_check CHECK (status IN ('pending','needs_user','confirmed','released')),
  CONSTRAINT sb_close_dispatch_check CHECK (dispatch_state IN ('not_admitted','admitted_unknown','proven_not_landed') AND ((dispatch_state = 'not_admitted') = (attempt_count = 0))),
  CONSTRAINT sb_close_attempts_check CHECK (attempt_count BETWEEN 0 AND 3 AND jsonb_typeof(attempt_log) = 'array' AND jsonb_array_length(attempt_log) = attempt_count),
  CONSTRAINT sb_close_evidence_check CHECK (jsonb_typeof(last_evidence) = 'object' AND revision >= 0),
  CONSTRAINT sb_close_completion_check CHECK ((status IN ('confirmed','released')) = (completed_at IS NOT NULL)),
  CONSTRAINT sb_close_release_check CHECK ((status = 'released' AND release_mode IS NOT NULL AND release_mode IN ('flat','still_open','residual','not_sent')) OR (status <> 'released' AND release_mode IS NULL))
) ON COMMIT DROP;
CREATE UNIQUE INDEX IF NOT EXISTS sb_close_unresolved_scope_unique ON qv_r3_expected_close_intents (environment, original_account, market) WHERE status IN ('pending','needs_user');
CREATE INDEX IF NOT EXISTS sb_close_due_idx ON qv_r3_expected_close_intents (next_action_at, id) WHERE status IN ('pending','needs_user');
CREATE INDEX IF NOT EXISTS sb_close_bot_idx ON qv_r3_expected_close_intents (bot_id, created_at DESC);

CREATE TABLE IF NOT EXISTS signal_bot_close_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text NOT NULL,
  owner_wallet text NOT NULL,
  bot_id varchar NOT NULL,
  original_trade_id varchar NOT NULL UNIQUE,
  protocol text NOT NULL DEFAULT 'pacifica',
  environment text NOT NULL,
  original_account text NOT NULL,
  original_subaccount_id integer,
  signer_public_key text NOT NULL,
  signer_mode text NOT NULL,
  authority_ref jsonb NOT NULL,
  position_epoch jsonb NOT NULL,
  market text NOT NULL,
  close_kind text NOT NULL,
  position_side text NOT NULL,
  original_position_size_base text NOT NULL,
  requested_size_base text NOT NULL,
  client_order_id uuid NOT NULL UNIQUE,
  request_payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  dispatch_state text NOT NULL DEFAULT 'not_admitted',
  attempt_count smallint NOT NULL DEFAULT 0,
  attempt_log jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_observed_at timestamptz,
  next_action_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  release_mode text,
  CONSTRAINT sb_close_source_unique UNIQUE (owner_wallet, bot_id, source_key),
  CONSTRAINT sb_close_protocol_check CHECK (protocol = 'pacifica'),
  CONSTRAINT sb_close_scope_check CHECK (length(source_key) > 0 AND length(owner_wallet) > 0 AND length(bot_id) > 0 AND length(original_trade_id) > 0 AND length(environment) > 0 AND length(original_account) > 0 AND length(market) > 0 AND original_subaccount_id IS NULL),
  CONSTRAINT sb_close_signer_check CHECK (signer_mode IN ('external_key','wallet_agent') AND signer_public_key = original_account AND jsonb_typeof(authority_ref) = 'object' AND authority_ref <> '{}'::jsonb),
  CONSTRAINT sb_close_objective_check CHECK (close_kind IN ('full','partial') AND position_side IN ('long','short') AND jsonb_typeof(position_epoch) = 'object' AND position_epoch <> '{}'::jsonb),
  CONSTRAINT sb_close_original_size_check CHECK (length(original_position_size_base) <= 80 AND original_position_size_base ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$' AND original_position_size_base !~ '^0(\.0+)?$'),
  CONSTRAINT sb_close_requested_size_check CHECK (length(requested_size_base) <= 80 AND requested_size_base ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$' AND requested_size_base !~ '^0(\.0+)?$'),
  CONSTRAINT sb_close_size_bound_check CHECK (requested_size_base::numeric <= original_position_size_base::numeric AND (close_kind <> 'full' OR requested_size_base::numeric = original_position_size_base::numeric)),
  CONSTRAINT sb_close_payload_check CHECK (jsonb_typeof(request_payload) = 'object' AND request_payload @> jsonb_build_object('account', original_account, 'reduce_only', true, 'amount', requested_size_base, 'client_order_id', client_order_id::text) AND ((position_side = 'long' AND request_payload @> '{"side":"ask"}'::jsonb) OR (position_side = 'short' AND request_payload @> '{"side":"bid"}'::jsonb))),
  CONSTRAINT sb_close_status_check CHECK (status IN ('pending','needs_user','confirmed','released')),
  CONSTRAINT sb_close_dispatch_check CHECK (dispatch_state IN ('not_admitted','admitted_unknown','proven_not_landed') AND ((dispatch_state = 'not_admitted') = (attempt_count = 0))),
  CONSTRAINT sb_close_attempts_check CHECK (attempt_count BETWEEN 0 AND 3 AND jsonb_typeof(attempt_log) = 'array' AND jsonb_array_length(attempt_log) = attempt_count),
  CONSTRAINT sb_close_evidence_check CHECK (jsonb_typeof(last_evidence) = 'object' AND revision >= 0),
  CONSTRAINT sb_close_completion_check CHECK ((status IN ('confirmed','released')) = (completed_at IS NOT NULL)),
  CONSTRAINT sb_close_release_check CHECK ((status = 'released' AND release_mode IS NOT NULL AND release_mode IN ('flat','still_open','residual','not_sent')) OR (status <> 'released' AND release_mode IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS sb_close_unresolved_scope_unique ON signal_bot_close_intents (environment, original_account, market) WHERE status IN ('pending','needs_user');
CREATE INDEX IF NOT EXISTS sb_close_due_idx ON signal_bot_close_intents (next_action_at, id) WHERE status IN ('pending','needs_user');
CREATE INDEX IF NOT EXISTS sb_close_bot_idx ON signal_bot_close_intents (bot_id, created_at DESC);
CREATE OR REPLACE FUNCTION sb_close_preserve_identity() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Close intent records must be retained';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['release_mode','status','dispatch_state','attempt_count','attempt_log','last_evidence','last_observed_at','next_action_at','last_error_code','revision','updated_at','completed_at']::text[]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['release_mode','status','dispatch_state','attempt_count','attempt_log','last_evidence','last_observed_at','next_action_at','last_error_code','revision','updated_at','completed_at']::text[]) THEN
    RAISE EXCEPTION 'Close intent identity is immutable';
  END IF;
  IF NEW.revision <> OLD.revision + 1 OR NEW.attempt_count < OLD.attempt_count OR NEW.attempt_count > OLD.attempt_count + 1 THEN
    RAISE EXCEPTION 'Close intent revision or attempt transition is invalid';
  END IF;
  IF OLD.status IN ('confirmed','released') AND (NEW.status <> OLD.status OR NEW.release_mode IS DISTINCT FROM OLD.release_mode) THEN
    RAISE EXCEPTION 'Terminal close intent cannot be reopened';
  END IF;
  IF NEW.attempt_count = OLD.attempt_count + 1 AND (OLD.status <> 'pending' OR (OLD.attempt_count > 0 AND OLD.dispatch_state <> 'proven_not_landed')) THEN
    RAISE EXCEPTION 'Close admission lacks committed non-execution proof';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(OLD.attempt_log) WITH ORDINALITY a(value, n) WHERE ((NEW.attempt_log -> (a.n::integer - 1)) - ARRAY['outcome','receivedAt']::text[]) IS DISTINCT FROM (a.value - ARRAY['outcome','receivedAt']::text[])) THEN
    RAISE EXCEPTION 'Admitted close header is immutable';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(OLD.attempt_log) WITH ORDINALITY a(value, n) WHERE (a.value ? 'outcome' OR a.value ? 'receivedAt') AND (NEW.attempt_log -> (a.n::integer - 1)) IS DISTINCT FROM a.value) THEN
    RAISE EXCEPTION 'Recorded close outcome is immutable';
  END IF;
  RETURN NEW;
END;
$fn$;
DO $ddl$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass(current_schema() || '.signal_bot_close_intents') AND tgname = 'sb_close_preserve_identity_trigger' AND NOT tgisinternal) THEN
    CREATE TRIGGER sb_close_preserve_identity_trigger BEFORE UPDATE OR DELETE ON signal_bot_close_intents FOR EACH ROW EXECUTE FUNCTION sb_close_preserve_identity();
  END IF;
END;
$ddl$;
DO $shape$
DECLARE expected record; actual record;
BEGIN
  FOR expected IN SELECT a.attname,a.atttypid,a.atttypmod,a.attnotnull,pg_get_expr(d.adbin,d.adrelid) AS default_expr FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='pg_temp.qv_r3_expected_close_intents'::regclass AND a.attnum>0 AND NOT a.attisdropped LOOP
    SELECT a.attname,a.atttypid,a.atttypmod,a.attnotnull,pg_get_expr(d.adbin,d.adrelid) AS default_expr INTO actual FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.signal_bot_close_intents'::regclass AND a.attname=expected.attname AND a.attnum>0 AND NOT a.attisdropped;
    IF NOT FOUND OR actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'public.signal_bot_close_intents column shape mismatch: %',expected.attname; END IF;
  END LOOP;
  FOR expected IN SELECT replace(c.conname,'qv_r3_expected_close_intents','signal_bot_close_intents') AS constraint_name,pg_get_constraintdef(c.oid,true) AS definition FROM pg_constraint c WHERE c.conrelid='pg_temp.qv_r3_expected_close_intents'::regclass AND c.contype IN ('p','u','c') LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.signal_bot_close_intents'::regclass AND c.conname=expected.constraint_name AND c.convalidated AND pg_get_constraintdef(c.oid,true)=expected.definition) THEN RAISE EXCEPTION 'public.signal_bot_close_intents constraint mismatch: %',expected.constraint_name; END IF;
  END LOOP;
  FOR expected IN SELECT ci.relname AS index_name,i.indisunique,i.indisvalid,i.indnkeyatts,pg_get_expr(i.indpred,i.indrelid,true) AS predicate,ARRAY(SELECT pg_get_indexdef(i.indexrelid,n,true) FROM generate_series(1,i.indnkeyatts) n) AS columns FROM pg_index i JOIN pg_class ci ON ci.oid=i.indexrelid WHERE i.indrelid='pg_temp.qv_r3_expected_close_intents'::regclass AND ci.relname IN ('sb_close_unresolved_scope_unique','sb_close_due_idx','sb_close_bot_idx') LOOP
    SELECT ci.relname AS index_name,i.indisunique,i.indisvalid,i.indnkeyatts,pg_get_expr(i.indpred,i.indrelid,true) AS predicate,ARRAY(SELECT pg_get_indexdef(i.indexrelid,n,true) FROM generate_series(1,i.indnkeyatts) n) AS columns INTO actual FROM pg_index i JOIN pg_class ci ON ci.oid=i.indexrelid WHERE i.indrelid='public.signal_bot_close_intents'::regclass AND ci.relname=expected.index_name;
    IF NOT FOUND OR actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'public.signal_bot_close_intents index mismatch: %',expected.index_name; END IF;
  END LOOP;
  IF NOT (EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace WHERE t.tgrelid=to_regclass('public' || '.signal_bot_close_intents') AND t.tgname='sb_close_preserve_identity_trigger' AND NOT t.tgisinternal AND t.tgenabled='O' AND t.tgtype=27 AND n.nspname='public' AND p.proname='sb_close_preserve_identity' AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='6ddb3b5078a69f7169e999adfc063271a10afff78ae4d62fe211da891d9434d2')) THEN RAISE EXCEPTION 'public.signal_bot_close_intents trigger bodySha256 mismatch'; END IF;
END;
$shape$;
COMMIT;
