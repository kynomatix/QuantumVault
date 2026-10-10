-- Manual rollback only, after deploying pre-U02 code with writers stopped.
-- Refuse to destroy any Phoenix identity or recovery record. Never migrate assets.
BEGIN;
LOCK TABLE trading_bots, phoenix_operations, phoenix_operation_attempts IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM trading_bots WHERE active_protocol = 'phoenix')
     OR EXISTS (SELECT 1 FROM phoenix_operations)
     OR EXISTS (SELECT 1 FROM phoenix_operation_attempts) THEN
    RAISE EXCEPTION 'Phoenix rollback refused: retain identity and recovery records';
  END IF;
END $$;
DROP TABLE phoenix_operation_attempts;
DROP TABLE phoenix_operations;
DROP TRIGGER trading_bots_phoenix_identity_immutable ON trading_bots;
DROP FUNCTION qv_phoenix_identity_immutable();
DROP INDEX trading_bots_phoenix_authority_unique;
DROP INDEX trading_bots_phoenix_trader_unique;
ALTER TABLE trading_bots DROP CONSTRAINT trading_bots_phoenix_identity_check;
ALTER TABLE trading_bots
  DROP COLUMN phoenix_authority_wallet,
  DROP COLUMN phoenix_trader_account,
  DROP COLUMN phoenix_network,
  DROP COLUMN phoenix_program_address,
  DROP COLUMN phoenix_portfolio_index,
  DROP COLUMN phoenix_subaccount_index;
ALTER TABLE trading_bots DROP CONSTRAINT trading_bots_active_protocol_check;
ALTER TABLE trading_bots ADD CONSTRAINT trading_bots_active_protocol_check
  CHECK (active_protocol IN ('pacifica', 'drift', 'flash'));
COMMIT;
