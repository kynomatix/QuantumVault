DO $$ BEGIN
  -- Catalogue-only repeat boot; no lock-taking DDL after a complete installation.
  IF to_regclass('grid_launch_accounts') IS NOT NULL AND to_regclass('grid_master_quota') IS NOT NULL
    AND to_regclass('grid_execution_claims') IS NOT NULL
    AND to_regclass('grid_read_claims') IS NOT NULL
    AND to_regclass('grid_read_master_idx') IS NOT NULL AND to_regclass('grid_launch_live_account_idx') IS NOT NULL AND to_regclass('grid_launch_live_pool_idx') IS NOT NULL
    AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='grid_operations'::regclass AND attname='exact_request' AND NOT attisdropped)
    AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('grid_execution_claims') AND conname='grid_claim_values')
    AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('grid_launch_accounts') AND conname='grid_launch_values')
    AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='grid_operations'::regclass AND conname='grid_exact_request_pair')
    AND to_regclass('grid_claim_master_idx') IS NOT NULL THEN RETURN; END IF;
  ALTER TABLE grid_operations ADD COLUMN IF NOT EXISTS exact_request jsonb;
  ALTER TABLE grid_operations ADD COLUMN IF NOT EXISTS exact_request_digest text;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='grid_operations'::regclass AND conname='grid_exact_request_pair') THEN
    ALTER TABLE grid_operations ADD CONSTRAINT grid_exact_request_pair CHECK
      ((exact_request IS NULL AND exact_request_digest IS NULL) OR
       (exact_request IS NOT NULL AND exact_request_digest IS NOT NULL AND jsonb_typeof(exact_request)='object' AND exact_request_digest ~ '^[0-9a-f]{64}$'));
  END IF;
  CREATE TABLE IF NOT EXISTS grid_master_quota (
    master_account text PRIMARY KEY, share numeric NOT NULL DEFAULT 0.5,
    backoff_until timestamptz NOT NULL DEFAULT '-infinity',
    CONSTRAINT grid_master_share CHECK (share > 0 AND share <= 1)
  );
  CREATE TABLE IF NOT EXISTS grid_launch_accounts (
    bot_id uuid PRIMARY KEY REFERENCES grid_bots(id) ON DELETE RESTRICT,
    protocol_subaccount_id integer NOT NULL REFERENCES protocol_subaccounts(id) ON DELETE RESTRICT,
    master_account text NOT NULL REFERENCES grid_master_quota(master_account),
    account text NOT NULL, reused boolean NOT NULL DEFAULT false, released_at timestamptz, canary_limit numeric NOT NULL, canary_committed numeric NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT grid_launch_values CHECK (canary_limit > 0 AND canary_committed >= 0 AND canary_committed <= canary_limit)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS grid_launch_live_account_idx ON grid_launch_accounts(account) WHERE released_at IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS grid_launch_live_pool_idx ON grid_launch_accounts(protocol_subaccount_id) WHERE released_at IS NULL;
  CREATE TABLE IF NOT EXISTS grid_execution_claims (
    operation_id uuid PRIMARY KEY REFERENCES grid_operations(id) ON DELETE RESTRICT,
    bot_id uuid NOT NULL REFERENCES grid_launch_accounts(bot_id), master_account text NOT NULL REFERENCES grid_master_quota(master_account),
    account text NOT NULL, credits numeric NOT NULL, slots integer NOT NULL, canary_increment numeric NOT NULL,
    prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(), settled_at timestamptz,
    slot_released boolean NOT NULL DEFAULT false,
    CONSTRAINT grid_claim_values CHECK (credits > 0 AND slots BETWEEN 0 AND 1 AND canary_increment >= 0)
  );
  CREATE INDEX IF NOT EXISTS grid_claim_master_idx ON grid_execution_claims(master_account,prepared_at);
  CREATE TABLE IF NOT EXISTS grid_read_claims (
    id uuid PRIMARY KEY, master_account text NOT NULL REFERENCES grid_master_quota(master_account),
    credits numeric NOT NULL CHECK (credits > 0), claimed_at timestamptz NOT NULL DEFAULT clock_timestamp()
  );
  CREATE INDEX IF NOT EXISTS grid_read_master_idx ON grid_read_claims(master_account,claimed_at);
END $$;
