-- Owner publication only. Never replay to recreate lost history.
BEGIN;
CREATE TABLE ai_trader_market_entry_attempts (
  attempt_id text PRIMARY KEY,
  decision_id varchar NOT NULL UNIQUE,
  bot_id varchar NOT NULL,
  owner_wallet text NOT NULL,
  market text NOT NULL,
  paper_mode boolean NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  first_confirmed_at timestamptz,
  terminal_reason text,
  CONSTRAINT ai_market_entry_state CHECK (state IN ('pending', 'confirmed', 'no_entry')),
  CONSTRAINT ai_market_entry_clock CHECK ((state = 'confirmed' AND first_confirmed_at IS NOT NULL) OR (state <> 'confirmed' AND first_confirmed_at IS NULL)),
  CONSTRAINT ai_market_entry_finite CHECK (isfinite(admitted_at) AND (first_confirmed_at IS NULL OR (isfinite(first_confirmed_at) AND first_confirmed_at >= admitted_at))),
  CONSTRAINT ai_market_entry_identity CHECK (length(owner_wallet) > 0 AND length(market) > 0 AND length(attempt_id) > 0)
);
CREATE INDEX ai_market_entry_pending ON ai_trader_market_entry_attempts (owner_wallet, market, paper_mode) WHERE state = 'pending';
CREATE INDEX ai_market_entry_confirmed ON ai_trader_market_entry_attempts (owner_wallet, market, paper_mode, first_confirmed_at) WHERE state = 'confirmed';
COMMIT;
