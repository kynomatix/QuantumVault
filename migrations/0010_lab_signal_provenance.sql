ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS lab_strategy_id integer REFERENCES lab_strategies(id) ON DELETE SET NULL;
ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS lab_run_id integer REFERENCES lab_optimization_runs(id) ON DELETE SET NULL;
ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS lab_result_id integer REFERENCES lab_optimization_results(id) ON DELETE SET NULL;
ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS lab_deploy_snapshot jsonb;
ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS lab_link_state text DEFAULT 'unlinked';
ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS lab_linked_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'trading_bots'::regclass AND conname = 'trading_bots_lab_link_state_check') THEN
    ALTER TABLE trading_bots ADD CONSTRAINT trading_bots_lab_link_state_check CHECK (lab_link_state IN ('linked','owner_confirmed','unlinked'));
  END IF;
END $$;
