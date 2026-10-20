# Finder-conditioned grid backtest preregistration

Registered 2026-10-20 before computing any finder selections or returns. Research base commitHash: 9fa9fa5ce0bb0cb710c99f8ea70159580822592a. Research only; never push or merge. The supplied brief is a hypothesis, not evidence. The post-launch “inside range” group cannot establish an entry signal.

## Frozen design

Use the actual shipped qualifyRangingMarket, plannerRegime and suggestGridRange functions. Extract only the pure scanner declaration through a Node loader to avoid transport initialization; preserve its function body exactly. Use exactly 100 contiguous finalized direct perpetual candles ending immediately before each Sunday UTC launch. At launch now equals historyCut. Ranging requires available structural range AND ADX(14) <20; ADX >=20 is rejected, and missing/invalid structural or candle data is unavailable, never rejected or zero.

The primary timeframe is the UI default 1h. Report 4h separately and pooled as a sensitivity inherited from round 2. No 15m series exists in the authorized frozen data; do not synthesize it. For the finder use complete OKX history first, then Gate if OKX candle history is unavailable, without mixing venues. Never use Pacifica as finder input because the shipped function excludes it. Use only the authorized OKX/Gate sources. Rank flagged candidates by full-precision ascending ADX, then symbol ascending, exactly as the UI does. No rounding before ranking.

Arms: BLIND launches every eligible market; FINDER launches all flagged markets; TOP1 and TOP2 launch the first one/two flagged markets, without replacement when a chosen market later fails launch admission; AGAINST launches only measured not-ranging markets. Unavailable markets remain in BLIND and in an explicitly counted missing-selection group. These arms overlap; summed arm memberships are not unique simulations.

At each launch the ranking universe comprises the registered markets with direct history already available at that date for Pacifica, or BTC/ETH/SOL for proxy. Selection never uses future funding completeness, future candle coverage, order admission, returns, direction or horizon. The same selection applies to both sides, both holding horizons and all fees/leverage.

Execution: one-week range; shipped stop and touch trigger; 10 intervals; step_back; seed on; fixed range; equal entry/profit sizing; 1,000 quote equity; adverse market slippage 0.05%; final inventory marked, not forcibly closed. Use the round-2 canonical-endpoint adapter, actual planner and stop-clearance gate without weakening validation. BLIND is the round-2 weekly step_back comparator rerun on this study's calendar, not the original repeat_all arm.

Fee grid: builder 0.10%, 0.05%, 0.02%, 0%, added to frozen Tier-1 maker 0.015% / taker 0.040%. Treat the owner's registered 0.10% as the requested scenario, not independently verified live billing. Leverage 1x/3x/5x. All 12 combinations include round-2 observed funding, mark, liquidation/backstop accounting and current frozen maintenance schedules; no missing funding is zero. Require shipped stop-clearance admission. Exclude unsafe plans, keeping exact reasons. Four trade/mark OHLC/OLHC combinations are modeling sensitivities, not four independent observations or guaranteed bounds.

## Data and periods

Verify every loaded frozen dataset and manifest against its SHA-256 binding. Reuse direct Pacifica trade snapshots from the trail handback, OKX/Gate snapshots from the direction handback, and frozen mark/funding/current-market facts from round 2. Record source paths and SHA-256. All inputs remain read-only.

Pacifica development precedes 2026-03-01; evaluation starts 2026-03-01 and ends 2026-10-19 exclusive, preserving round-2 Sunday launches and 14/30-day horizons wholly inside the period. BTC/ETH/SOL plus HYPE/ZEC only with direct Pacifica history. Proxy confirmation uses BTC/ETH/SOL launches from 2022-01-02 with horizons ending no later than 2026-01-01, restricted to 2022–2025 and proxy execution history. It is an older-market stress test with Pacifica's frozen constraints/fees, actual OKX funding, and traded-price mark proxies, not historical Pacifica trading.

Before execution require complete expected candle boundaries/continuity, marks and settled funding across the entire scheduled horizon, matching round-2 funded admission. Preserve the resulting coverage bias, including horizons that would have stopped before a later data gap. Missing data exclusions are not losses and are not admitted runs. Seed holds remain admitted idle outcomes, separately reported as in round 2.

Regime breakdown uses the exact pre-launch close and close 30 days earlier: >10% trending up, <-10% trending down, otherwise ranging, missing endpoints unknown. This descriptive regime is different from the finder's ADX label. No retrospective “inside range” subgroup enters selection.

## Selection, confirmation and statistics

Produce every prespecified arm/fee/leverage cell regardless of selection. Select at most one filtered arm on Pacifica development, primary 1h, builder 0.10%, leverage 1x, with both horizons and all paths equally represented. Require at least 20 distinct eligible launch weeks and 20% of BLIND admitted market launches, positive mean return, profitable share >50%, positive return lift over the finder-measurable BLIND cohort, mean drawdown no higher, and positive mean in a majority of represented markets and each trade path. Among qualifying FINDER/TOP1/TOP2 choose highest mean return, then lower mean drawdown, higher coverage, lexical ID. Otherwise lock “no qualifying filter.” Write and hash the lock before evaluation or proxy execution. Never reselect on confirmation.

For a reliability claim require the locked filter to repeat these directional conditions in both independent confirmation periods, at least 20 represented launch weeks each, and a positive lower 95% interval for equal-weight launch-week mean return in each. The deterministic interval is a descriptive week-cluster t interval (1.96 normal approximation); overlapping 14/30-day horizons still induce dependence, so this cannot establish reliable future profit. Report no robust conclusion if sample/coverage is inadequate. Other fee/leverage cells are prespecified descriptive comparisons, not newly selected winners.

For each cell report ADMITTED runs, mean/median equity return, profitable share, protective stop and liquidation rates, mean/worst drawdown, seed holds, unique admitted market launches, selected/admitted launches per calendar week (including zero-selection weeks), represented weeks and retention. Report pooled, period, year, regime, timeframe, market, side, horizon and path breakdowns. Include same-fee/leverage BLIND and measurable-BLIND comparisons to expose missing-selection bias. Arm memberships and unique simulated admissions receive separate totals; the tally is unique admitted simulations only.

## Implementation and validation

One plain Node worker, no browser or local Vitest/npx/WSL, no production/package/schema/DB edits. Checkpoint in handback RESUME.md. Copy only needed research modules from the uncommitted round-2 worktree, retain exact source bindings, and inspect their behavior first-hand. Focused FRACTAL tests cover point-in-time selection, ranking/ties, rejected vs unavailable states, arm membership, calendar bounds and aggregate counting, plus reused accounting where practical. TEST REQUEST (owner): focused. TEST-RISK: REQUIRED. Report each requested test's full commitHash, host and counts, retaining rejected/failed attempts. Use only run-qv-tests or bundle-v1.

Commit this registration before any result. If shared worktree Git metadata is unwritable, commit in a writable shared scratch clone and preserve a verified thin bundle plus INSTALL-FINDER.ps1 targeting this worktree and branch. No push. Run the reviewer's unchanged read-only snapshot secret scan over the complete declared review closure; zero findings is required for sealing. Preserve findings and disclose an unsealed handback if inherited inputs prevent zero findings. No independent review or live-deployment approval is implied.
