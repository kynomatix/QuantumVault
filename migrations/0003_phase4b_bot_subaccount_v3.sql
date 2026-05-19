-- Phase 4b (Task 99): per-bot subaccount key V3 encryption.
--
-- Adds the v3 ciphertext column and relaxes the external-key invariant so it
-- accepts either the legacy or v3 ciphertext during the migration window.
-- Login backfills any legacy-only rows the next time the owner signs in.
-- Idempotent — safe to re-run.

ALTER TABLE trading_bots
  ADD COLUMN IF NOT EXISTS bot_subaccount_key_encrypted_v3 text;

DO $$
BEGIN
  ALTER TABLE trading_bots DROP CONSTRAINT IF EXISTS trading_bots_external_key_invariant;
  ALTER TABLE trading_bots ADD CONSTRAINT trading_bots_external_key_invariant
    CHECK (
      NOT (subaccount_auth_mode = 'external_key' AND subaccount_status = 'active')
      OR (
        protocol_subaccount_id IS NOT NULL
        AND (
          bot_subaccount_key_encrypted IS NOT NULL
          OR bot_subaccount_key_encrypted_v3 IS NOT NULL
        )
      )
    );
END $$;
