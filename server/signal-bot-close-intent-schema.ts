// Full-close objective as admitted (strict venue size when available, otherwise the declared bounded fallback; see position_epoch.sizeSource).
export const SIGNAL_CLOSE_INTENT_DDL = String.raw`CREATE TABLE IF NOT EXISTS signal_bot_close_intents (
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
  CONSTRAINT sb_close_payload_check CHECK (jsonb_typeof(request_payload) = 'object' AND request_payload @> jsonb_build_object('account', original_account, 'reduce_only', true, 'amount', requested_size_base, 'client_order_id', client_order_id::text, 'side', CASE WHEN position_side = 'long' THEN 'ask' ELSE 'bid' END)),
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
  RETURN NEW;
END;
$fn$;
DO $ddl$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass(current_schema() || '.signal_bot_close_intents') AND tgname = 'sb_close_preserve_identity_trigger' AND NOT tgisinternal) THEN
    CREATE TRIGGER sb_close_preserve_identity_trigger BEFORE UPDATE OR DELETE ON signal_bot_close_intents FOR EACH ROW EXECUTE FUNCTION sb_close_preserve_identity();
  END IF;
END;
$ddl$;`;

export const SIGNAL_CLOSE_INTENT_REQUIREMENTS = [
  { "kind": "constraint", "table": "signal_bot_close_intents", "constraint": "signal_bot_close_intents_pkey", "definitionIncludes": ["PRIMARY KEY (id)"] },
  { "kind": "constraint", "table": "signal_bot_close_intents", "constraint": "signal_bot_close_intents_original_trade_id_key", "definitionIncludes": ["UNIQUE (original_trade_id)"] },
  { "kind": "constraint", "table": "signal_bot_close_intents", "constraint": "signal_bot_close_intents_client_order_id_key", "definitionIncludes": ["UNIQUE (client_order_id)"] },
  {
    "kind": "table",
    "table": "signal_bot_close_intents",
    "columns": [
      "id",
      "source_key",
      "owner_wallet",
      "bot_id",
      "original_trade_id",
      "protocol",
      "environment",
      "original_account",
      "original_subaccount_id",
      "signer_public_key",
      "signer_mode",
      "authority_ref",
      "position_epoch",
      "market",
      "close_kind",
      "position_side",
      "original_position_size_base",
      "requested_size_base",
      "client_order_id",
      "request_payload",
      "status",
      "dispatch_state",
      "attempt_count",
      "attempt_log",
      "last_evidence",
      "last_observed_at",
      "next_action_at",
      "last_error_code",
      "revision",
      "created_at",
      "updated_at",
      "completed_at",
      "release_mode"
    ]
  },
  {
    "kind": "constraint",
    "table": "signal_bot_close_intents",
    "constraint": "sb_close_source_unique",
    "definitionIncludes": ["UNIQUE (owner_wallet, bot_id, source_key)"]
  },
  {
    "kind": "constraint",
    "table": "signal_bot_close_intents",
    "constraint": "sb_close_protocol_check",
    "definitionIncludes": ["CHECK (protocol = 'pacifica')"]
  },
  {
    "kind": "constraint",
    "table": "signal_bot_close_intents",
    "constraint": "sb_close_scope_check",
    "definitionIncludes": ["CHECK (length(source_key) > 0 AND length(owner_wallet) > 0 AND length(bot_id) > 0 AND length(original_trade_id) > 0 AND length(environment) > 0 AND length(original_account) > 0 AND length(market) > 0 AND original_subaccount_id IS NULL)"]
  },
  {
    "kind": "constraint",
    "table": "signal_bot_close_intents",
    "constraint": "sb_close_signer_check",
    "definitionIncludes": ["CHECK (signer_mode IN ('external_key','wallet_agent') AND signer_public_key = original_account AND jsonb_typeof(authority_ref) = 'object' AND authority_ref <> '{}'::jsonb)"]
  },
  {
    "kind": "constraint",
    "table": "signal_bot_close_intents",
    "constraint": "sb_close_objective_check",
    "definitionIncludes": ["CHECK (close_kind IN ('full','partial') AND position_side IN ('long','short') AND jsonb_typeof(position_epoch) = 'object' AND position_epoch <> '{}'::jsonb)"]
  },
  {
    "kind": "constraint",
    "table": "signal_bot_close_intents",
    "constraint": "sb_close_original_size_check",
    "definitionIncludes": ["CHECK (length(original_position_size_base) <= 80 AND original_position_size_base ~ '^(0|[1-9][0-9]*)(\\.[0-9]+)?$' AND original_position_size_base !~ '^0(\\.0+)?$')"]
  },
  {
    "kind": "constraint",
    "table": "signal_bot_close_intents",
    "constraint": "sb_close_requested_size_check",
    "definitionIncludes": ["CHECK (length(requested_size_base) <= 80 AND requested_size_base ~ '^(0|[1-9][0-9]*)(\\.[0-9]+)?$' AND requested_size_base !~ '^0(\\.0+)?$')"]
  },
  {
    "kind": "constraint",
    "table": "signal_bot_close_intents",
    "constraint": "sb_close_size_bound_check",
    "definitionIncludes": ["CHECK (requested_size_base::numeric <= original_position_size_base::numeric AND (close_kind <> 'full' OR requested_size_base::numeric = original_position_size_base::numeric))"]
  },
  {
    "kind": "constraint",
    "table": "signal_bot_close_intents",
    "constraint": "sb_close_payload_check",
    "definitionIncludes": ["CHECK (jsonb_typeof(request_payload) = 'object' AND request_payload @> jsonb_build_object('account', original_account, 'reduce_only', true, 'amount', requested_size_base, 'client_order_id', client_order_id::text, 'side', CASE WHEN position_side = 'long' THEN 'ask' ELSE 'bid' END))"]
  },
  {
    "kind": "constraint",
    "table": "signal_bot_close_intents",
    "constraint": "sb_close_status_check",
    "definitionIncludes": ["CHECK (status IN ('pending','needs_user','confirmed','released'))"]
  },
  {
    "kind": "constraint",
    "table": "signal_bot_close_intents",
    "constraint": "sb_close_dispatch_check",
    "definitionIncludes": ["CHECK (dispatch_state IN ('not_admitted','admitted_unknown','proven_not_landed') AND ((dispatch_state = 'not_admitted') = (attempt_count = 0)))"]
  },
  {
    "kind": "constraint",
    "table": "signal_bot_close_intents",
    "constraint": "sb_close_attempts_check",
    "definitionIncludes": ["CHECK (attempt_count BETWEEN 0 AND 3 AND jsonb_typeof(attempt_log) = 'array' AND jsonb_array_length(attempt_log) = attempt_count)"]
  },
  {
    "kind": "constraint",
    "table": "signal_bot_close_intents",
    "constraint": "sb_close_evidence_check",
    "definitionIncludes": ["CHECK (jsonb_typeof(last_evidence) = 'object' AND revision >= 0)"]
  },
  {
    "kind": "constraint",
    "table": "signal_bot_close_intents",
    "constraint": "sb_close_completion_check",
    "definitionIncludes": ["CHECK ((status IN ('confirmed','released')) = (completed_at IS NOT NULL))"]
  },
  {
    "kind": "constraint",
    "table": "signal_bot_close_intents",
    "constraint": "sb_close_release_check",
    "definitionIncludes": ["CHECK ((status = 'released' AND release_mode IS NOT NULL AND release_mode IN ('flat','still_open','residual','not_sent')) OR (status <> 'released' AND release_mode IS NULL))"]
  },
  {
    "kind": "index",
    "table": "signal_bot_close_intents",
    "index": "sb_close_unresolved_scope_unique",
    "columns": [
      "environment",
      "original_account",
      "market"
    ],
    "unique": true,
    "predicateEquals": "status IN ('pending','needs_user')",
    "predicateIncludes": [
      "pending",
      "needs_user"
    ]
  },
  {
    "kind": "index",
    "table": "signal_bot_close_intents",
    "index": "sb_close_due_idx",
    "columns": [
      "next_action_at",
      "id"
    ],
    "unique": false,
    "predicateEquals": "status IN ('pending','needs_user')",
    "predicateIncludes": [
      "pending",
      "needs_user"
    ]
  },
  {
    "kind": "index",
    "table": "signal_bot_close_intents",
    "index": "sb_close_bot_idx",
    "columns": [
      "bot_id",
      "created_at DESC"
    ],
    "unique": false,
    "predicateIncludes": []
  },
  {
    "kind": "data",
    "identity": "signal_bot_close_intent.function.bodySha256",
    "checkSql": "SELECT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace WHERE t.tgrelid=to_regclass(current_schema() || '.signal_bot_close_intents') AND t.tgname='sb_close_preserve_identity_trigger' AND NOT t.tgisinternal AND t.tgenabled='O' AND t.tgtype=27 AND n.nspname=current_schema() AND p.proname='sb_close_preserve_identity' AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='3eba30bd8a780a70b08bae110f4962400041936a691b2591a59279d95268bc2f') AS ok"
  }
] as const;
