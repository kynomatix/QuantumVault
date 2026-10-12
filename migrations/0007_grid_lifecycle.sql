DO $$ BEGIN
  -- Repeat boot uses catalog reads only, without locking live trading tables for DDL.
  IF to_regclass('grid_lifecycle') IS NOT NULL AND to_regclass('grid_control_requests') IS NOT NULL
    AND to_regclass('grid_risk_events') IS NOT NULL AND to_regclass('grid_control_keys') IS NOT NULL AND to_regclass('grid_wallet_safety') IS NOT NULL
    AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('grid_control_requests') AND conname='grid_control_action')
    AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('grid_lifecycle') AND conname='grid_lifecycle_epoch') THEN RETURN; END IF;
  CREATE TABLE IF NOT EXISTS grid_control_requests (
    id uuid PRIMARY KEY, bot_id uuid NOT NULL REFERENCES grid_bots(id), request_key text NOT NULL,
    action text NOT NULL, source text NOT NULL, state text NOT NULL DEFAULT 'pending',
    previous_status text NOT NULL, evidence jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamptz, UNIQUE(bot_id,request_key),
    CONSTRAINT grid_control_action CHECK(action IN ('pause','resume','resync','stop','band') AND source IN ('owner','risk') AND state IN ('pending','complete','superseded'))
  );
  CREATE TABLE IF NOT EXISTS grid_lifecycle (
    bot_id uuid PRIMARY KEY REFERENCES grid_bots(id), epoch bigint NOT NULL DEFAULT 0,
    active_request uuid REFERENCES grid_control_requests(id), blocker text, terminal_proof jsonb,
    CONSTRAINT grid_lifecycle_epoch CHECK(epoch>=0)
  );
  CREATE TABLE IF NOT EXISTS grid_control_keys (
    bot_id uuid NOT NULL REFERENCES grid_bots(id), request_key text NOT NULL,
    control_id uuid NOT NULL REFERENCES grid_control_requests(id), evidence jsonb NOT NULL,
    PRIMARY KEY(bot_id,request_key)
  );
  -- Durable incident outbox. Unique identity prevents a second notification on retry/restart.
  CREATE TABLE IF NOT EXISTS grid_wallet_safety (
    execution_wallet text PRIMARY KEY, balance_lamports numeric(30,0), observed_at timestamptz,
    guard_state text NOT NULL, incident_id uuid, policy_version text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS grid_risk_events (
    bot_id uuid NOT NULL REFERENCES grid_bots(id), event_key text NOT NULL, kind text NOT NULL,
    evidence jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), delivered_at timestamptz,
    PRIMARY KEY(bot_id,event_key)
  );
END $$;
