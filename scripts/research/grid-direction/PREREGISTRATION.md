# Direction signal backtest preregistration

Registered 2026-10-19, before opening prior run outcomes or calculating any direction-conditioned performance. Prior design, implementation, metadata and the brief's already-disclosed baseline have been inspected; this is not an untouched statistical holdout.

## Locked universe and estimand

Research base commitHash: 82d626419f9f288066ed117d62e4a52ddbde4ff8. Reuse every valid round-2 fixed-range arm a run: BTC/ETH/SOL/HYPE/ZEC, 1h/4h, 14/30 days, long/short, seed false/true, repeat_all/step_back/step_back_edge, OHLC/OLHC. Verify frozen candle hashes and prior row counts before using them. No rerun or parameter search is necessary for unchanged Pacifica outcomes: join launch-time signal classifications onto existing arm a rows. Recompute representative arm a rows to establish engine equivalence.

Use the shipped rollingWindows, plannerLaunchGeometry, makeTrailGrid and runTrailBacktest for proxy replay, keeping investment, leverage, fees, ticks, slippage, stops, modes and seed settings identical. Weekly Sunday launches use the original calendar, first Sunday on/after 2022-01-01, and complete horizons ending no later than each market's first Pacifica candle. Fetch pre-2022 context. BTC/ETH/SOL only; current Pacifica constraints and survivor selection are explicit proxy limitations. No splicing proxy returns into Pacifica returns.

## Point-in-time reconstruction

Reuse computeBtcDirection, aggregateBtcDailyWeeks where needed, aggregateStructureWeeks, computeWeeklyStructure, plannerRegime and gridSignalViews from the shipped source; do not recode indicator mathematics. Every candle must be finalized, with exclusive close boundary <= launchAt (the last instant represented is strictly before launch). Discard the launch candle. Macro uses exactly the latest completed Monday UTC week and 50 consecutive closes. Weekly structure uses up to 52 completed Monday UTC weeks, with confirmed two-left/two-right swings as shipped. Trend uses the last 200 closed context bars, as the shipped WEEK planner does. Neutral is distinct from unavailable.

Macro source priority is the actual BTC_WEEKLY_SOURCE_ORDER in server/grid-planner/btc-candles.ts, not the brief's market-stats citation. Try OKX index historical weekly data first, then the shipped fallback order when the required complete window is unavailable. Freeze native payloads and normalized rows with source labels and SHA-256. Structure and trend use direct perpetual candles from the shipped pool, prioritizing OKX then Gate, then available Hyperliquid/Pacifica history; never relabel another venue as Pacifica. The proxy simulation uses the first publicly obtainable adequate OKX/Gate perpetual history. Missing/gapped/stale data is unavailable, never interpolated. Window selection and fallback depend on data validity only, never outcomes.

Historical download time is not historical publication time. Preserve actual retrievedAt in snapshot evidence; supply a separately labelled reconstructed availability timestamp at the completed candle boundary for the pure functions. This estimates signals from finalized historical bars and does not establish what an historical user saw, original revision state, cache availability or latency. Sunday launches avoid Monday publication grace. No historical Pacifica funding quote is inferred from today's /info or another venue. Unless exact pre-launch historical funding observations with the shipped freshness semantics are publicly available, Funding is unavailable. Funding cashflows remain excluded as in round 2.

## Locked classes (applied relative to each bot's side)

For each of Macro, Structure, Trend and Funding: aligned means the signal points to the bot's side; against means the opposite; neutral/mixed means an available neutral signal; unavailable is separate.

All available signals agree: ignore unavailable observations; require at least one available observation and every available observation to point in the same non-neutral direction. Classify aligned/against relative to side. Any neutral observation or disagreement is neutral/mixed. Zero available is unavailable. Report available-signal counts so one-signal agreement is visible.

Majority agree: require strictly more than half of all available observations to point in one direction. Available neutral observations count in the denominator and cast no directional vote. Unavailable observations do not count. A tie or no strict majority is neutral/mixed; zero available is unavailable. Classify a directional majority as aligned/against relative to side.

Blind baseline contains all valid launches. No confidence weighting, ADX threshold changes, funding weighting, best-mode selection or post-result rule changes. Any later rule is exploratory and must be separate; none is planned.

## Locked reporting and comparisons

For blind and every class report run count, retained share, unique launch count (market/timeframe/launchAt), mean and median net return, profitable share (>0), stop rate, mean and worst peak-to-trough drawdown. Returns/drawdowns are percent of initial investment; percentage-point differences use identical weighting. Keep OHLC and OLHC separate. Equal weight per valid bot scenario, as in round 2. Split by period, side, market, timeframe, horizon, seed and mode; supply full cross-cells in machine-readable CSV. Coverage denominators come from the corresponding blind stratum, including signal-unavailable launches. Report signal availability and how many unique opportunities survive; 50% side retention can mean every time retained with a side choice.

Periods: Pacifica development before 2026-03-01, evaluation from 2026-03-01 to 2026-10-19 exclusive, and proxy 2022 to each market's Pacifica start. Also show calendar-year proxy splits and Macro above/below/unknown descriptive regimes, fixed before results. Regimes describe the pre-launch signal, not a hindsight classification.

Following a rule beats blind in a stratum only when its aligned mean return exceeds that stratum's blind mean under BOTH explicit intrabar paths; show median, stops, drawdown and retention even when they disagree. Also give side-matched deltas to expose a rule that merely selects longs in a rising sample. No p-values or claims of independent samples: horizons overlap and strategy variants repeat the same price path. Prior evaluation was already examined in earlier research. Proxy years are a historical extension, not prospective validation. Conclusions apply to this simulator and observed sample only.

## Execution and integrity

Plain Node, at most two evaluation workers, reducing to one if free memory is below 1.8 GiB. Prefer one worker for laptop responsiveness. No local Vitest, npx, npm install, WSL, DB, production modifications, pushes or merges. Required focused tests run only through permitted FRACTAL transport against a verified 40-character commit hash. Commit this registration first, before implementation or results. If shared Git metadata is read-only, use a writable scratch clone and deliver a verified thin bundle plus branch-checked installer.