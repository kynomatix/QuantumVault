-- Dedicated finalized BTC weekly history and durable refresh cadence; existing tables are untouched.
DO $$
BEGIN
  IF to_regclass('public.planner_btc_weekly_closes') IS NOT NULL
    AND to_regclass('public.planner_btc_weekly_refresh') IS NOT NULL
    AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('public.planner_btc_weekly_closes')
      AND conname IN ('planner_btc_weekly_identity_unique','planner_btc_weekly_market_check','planner_btc_weekly_utc_check',
        'planner_btc_weekly_close_check','planner_btc_weekly_source_check','planner_btc_weekly_aggregation_check','planner_btc_weekly_finalized_check')) = 7
    AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.planner_btc_weekly_refresh')
      AND conname='planner_btc_weekly_refresh_market_check') THEN RETURN;
  END IF;
  CREATE TABLE IF NOT EXISTS planner_btc_weekly_closes (
    market text NOT NULL, week_start timestamptz NOT NULL, close text NOT NULL,
    source text NOT NULL, basis text NOT NULL, aggregation text NOT NULL,
    finalized boolean NOT NULL, fetched_at timestamptz NOT NULL,
    CONSTRAINT planner_btc_weekly_identity_unique UNIQUE(market,week_start),
    CONSTRAINT planner_btc_weekly_market_check CHECK(market='BTC'),
    CONSTRAINT planner_btc_weekly_utc_check CHECK(week_start >= '1970-01-05 00:00:00+00'::timestamptz
      AND extract(isodow FROM week_start AT TIME ZONE 'UTC')=1 AND (week_start AT TIME ZONE 'UTC')::time='00:00:00'::time),
    CONSTRAINT planner_btc_weekly_close_check CHECK(CASE WHEN close ~ '^[0-9]{1,12}(\.[0-9]{1,18})?$' THEN close::numeric > 0 ELSE false END),
    CONSTRAINT planner_btc_weekly_source_check CHECK((source='okx-index' AND basis='index')
      OR (source IN ('gate-spot','kraken-spot','coinbase-spot') AND basis='spot')
      OR (source IN ('pacifica-mark','hyperliquid-perp','pacifica-perp','okx-perp') AND basis='perp')),
    CONSTRAINT planner_btc_weekly_aggregation_check CHECK(aggregation IN ('native','daily')),
    CONSTRAINT planner_btc_weekly_finalized_check CHECK(finalized AND fetched_at >= week_start + interval '168 hours')
  );
  CREATE TABLE IF NOT EXISTS planner_btc_weekly_refresh (
    market text PRIMARY KEY, last_attempt_at timestamptz NOT NULL,
    CONSTRAINT planner_btc_weekly_refresh_market_check CHECK(market='BTC')
  );
END $$;
