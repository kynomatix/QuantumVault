-- Replit's publisher requires a single-line PostgreSQL CHECK definition.
DO $$
DECLARE
  current_definition text;
BEGIN
  SELECT pg_get_constraintdef(oid, true)
    INTO current_definition
    FROM pg_constraint
    WHERE conrelid = to_regclass('public.planner_btc_weekly_closes')
      AND conname = 'planner_btc_weekly_close_check';
  IF current_definition IS NOT DISTINCT FROM $constraint$CHECK (close ~ '^[0-9]{1,12}(\.[0-9]{1,18})?$'::text AND close !~ '^0{1,12}(\.0{1,18})?$'::text)$constraint$ THEN
    RETURN;
  END IF;
  ALTER TABLE public.planner_btc_weekly_closes
    DROP CONSTRAINT IF EXISTS planner_btc_weekly_close_check;
  ALTER TABLE public.planner_btc_weekly_closes
    ADD CONSTRAINT planner_btc_weekly_close_check
    CHECK (close ~ '^[0-9]{1,12}(\.[0-9]{1,18})?$' AND close !~ '^0{1,12}(\.0{1,18})?$');
END $$;
