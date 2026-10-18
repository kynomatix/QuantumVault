CREATE TABLE IF NOT EXISTS grid_auto_resume (
  bot_id uuid PRIMARY KEY REFERENCES grid_bots(id),
  enabled boolean NOT NULL DEFAULT true,
  generation bigint NOT NULL DEFAULT 0,
  cycle bigint NOT NULL DEFAULT 0,
  armed_cycle bigint,
  armed_generation bigint,
  armed_lifecycle_epoch bigint,
  armed_band_request uuid REFERENCES grid_control_requests(id),
  armed_policy_hmac text,
  armed_umk_version integer,
  resume_request_id uuid REFERENCES grid_control_requests(id),
  attempts smallint NOT NULL DEFAULT 0,
  first_attempt_at timestamptz,
  next_attempt_at timestamptz,
  held_reason text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT grid_auto_resume_counts CHECK (generation>=0 AND cycle>=0 AND attempts>=0 AND attempts<=3),
  CONSTRAINT grid_auto_resume_arm CHECK ((armed_cycle IS NULL AND armed_generation IS NULL AND armed_lifecycle_epoch IS NULL AND armed_band_request IS NULL AND armed_policy_hmac IS NULL AND armed_umk_version IS NULL AND resume_request_id IS NULL AND attempts=0 AND first_attempt_at IS NULL AND next_attempt_at IS NULL) OR (enabled AND armed_cycle IS NOT NULL AND armed_cycle=cycle AND armed_cycle>0 AND armed_generation IS NOT NULL AND armed_generation=generation AND armed_lifecycle_epoch IS NOT NULL AND armed_lifecycle_epoch>=0 AND armed_band_request IS NOT NULL AND armed_policy_hmac IS NOT NULL AND armed_policy_hmac ~ '^[0-9a-f]{64}$' AND armed_umk_version IS NOT NULL AND armed_umk_version>0)),
  CONSTRAINT grid_auto_resume_retry CHECK ((attempts=0 AND first_attempt_at IS NULL AND next_attempt_at IS NULL) OR (attempts>0 AND first_attempt_at IS NOT NULL AND (next_attempt_at IS NULL OR next_attempt_at>=first_attempt_at))),
  CONSTRAINT grid_auto_resume_reason CHECK (held_reason IS NULL OR held_reason IN ('waiting_for_inner_band','range_unavailable','reconciliation_required','operation_pending','market_data_unavailable','resume_authority_unavailable','risk_pause','stop_clearance_unavailable','policy_changed','execution_revoked','retry_limit','preference_off'))
);
ALTER TABLE grid_auto_resume ALTER COLUMN enabled SET DEFAULT true;
ALTER TABLE grid_control_requests DROP CONSTRAINT IF EXISTS grid_control_action;
ALTER TABLE grid_control_requests ADD CONSTRAINT grid_control_action CHECK (action IN ('pause','resume','resync','stop','band') AND source IN ('owner','risk','auto') AND state IN ('pending','complete','superseded') AND (source<>'auto' OR action='resume'));
