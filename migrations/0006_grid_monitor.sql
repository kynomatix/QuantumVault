DO $$ BEGIN
  -- Repeat boot performs catalog reads only; existing tables never acquire DDL locks.
  IF to_regclass('grid_monitor_state') IS NOT NULL AND to_regclass('grid_exact_fills') IS NOT NULL
    AND to_regclass('grid_profit_allocations') IS NOT NULL AND to_regclass('grid_monitor_orders') IS NOT NULL AND to_regclass('grid_exact_fills_time_idx') IS NOT NULL
    AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('grid_exact_fills') AND conname='grid_exact_fill_values')
    AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('grid_profit_allocations') AND conname='grid_allocation_values')
    AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('grid_profit_allocations') AND attname='settled_at' AND NOT attisdropped) THEN RETURN; END IF;
  CREATE TABLE IF NOT EXISTS grid_monitor_state (
    bot_id uuid PRIMARY KEY REFERENCES grid_bots(id), boot_id uuid,
    generation bigint NOT NULL DEFAULT 0, safe_through bigint,
    observation jsonb, pnl jsonb, blocked_reasons jsonb NOT NULL DEFAULT '["startup_required"]',
    reconciled_at timestamptz
  );
  CREATE TABLE IF NOT EXISTS grid_exact_fills (
    account text NOT NULL, trade_id text NOT NULL, bot_id uuid NOT NULL REFERENCES grid_bots(id),
    operation_id uuid NOT NULL REFERENCES grid_operations(id), level_id uuid REFERENCES grid_levels(id),
    order_id text NOT NULL, venue_time bigint NOT NULL, leg text NOT NULL,
    size numeric NOT NULL, price numeric NOT NULL, fee numeric NOT NULL,
    PRIMARY KEY(account,trade_id),
    CONSTRAINT grid_exact_fill_values CHECK (size>0 AND price>0 AND fee>=0 AND venue_time>=0 AND leg IN ('entry','exit'))
  );
  CREATE INDEX IF NOT EXISTS grid_exact_fills_time_idx ON grid_exact_fills(bot_id,venue_time,trade_id);
  CREATE TABLE IF NOT EXISTS grid_profit_allocations (
    operation_id uuid NOT NULL REFERENCES grid_operations(id), account text NOT NULL,
    trade_id text NOT NULL, size numeric NOT NULL, released_at timestamptz, released_size numeric NOT NULL DEFAULT 0, settled_at timestamptz,
    PRIMARY KEY(operation_id,account,trade_id), FOREIGN KEY(account,trade_id) REFERENCES grid_exact_fills(account,trade_id),
    CONSTRAINT grid_allocation_values CHECK(size>0 AND released_size>=0 AND released_size<=size)
  );
  CREATE TABLE IF NOT EXISTS grid_monitor_orders (
    operation_id uuid PRIMARY KEY REFERENCES grid_operations(id), order_id text NOT NULL,
    status text NOT NULL, filled numeric NOT NULL, remaining numeric NOT NULL,
    observed_at bigint NOT NULL, CONSTRAINT grid_monitor_order_values CHECK (filled>=0 AND remaining>=0 AND observed_at>=0)
  );
END $$;
