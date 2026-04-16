-- Data migration: Reassign Flux Momentum strategy (id=1) to new wallet
-- Task #44 — executed 2026-04-16
--
-- Moves the "Flux Momentum" strategy and all its historical optimization runs
-- from the decommissioned buh wallet to the new wallet address.
--
-- Before: user_id = 'BuhEYpvrWV1y18jZoY8Hgfyf2pj3nqYXvmPefvBVzk41'  (buh wallet)
-- After:  user_id = 'AqTTQQajeKDjbDU5sb6JoQfTJ8HfHzpjne2sFmYthCez'  (new wallet)
--
-- Verified: 1 strategy row + 23 lab_optimization_runs rows updated.
-- Old wallet count for strategy id=1: 0 (confirmed after migration).

BEGIN;

UPDATE lab_strategies
SET user_id = 'AqTTQQajeKDjbDU5sb6JoQfTJ8HfHzpjne2sFmYthCez'
WHERE id = 1
  AND user_id = 'BuhEYpvrWV1y18jZoY8Hgfyf2pj3nqYXvmPefvBVzk41';

UPDATE lab_optimization_runs
SET user_id = 'AqTTQQajeKDjbDU5sb6JoQfTJ8HfHzpjne2sFmYthCez'
WHERE strategy_id = 1
  AND user_id = 'BuhEYpvrWV1y18jZoY8Hgfyf2pj3nqYXvmPefvBVzk41';

COMMIT;
