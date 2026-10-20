# Entry-filter research preregistration

Fixed on 2026-10-20 before computing any entry-filter result. Research only; never merge or push. Research base commitHash: 7d12a3e5e5e2ab0a397b00f6b70ea3ce3ce56de9. Existing finder/round-2 results informed the question; their evaluation/proxy periods are held out for selection within this job, but are NOT previously unseen research data. No threshold or combination may be retuned.

## Population and execution

Reuse the verified frozen datasets and round-2 funded fixed replay from the base. Weekly UTC Sunday launches; development strictly before 2026-03-01, Pacifica evaluation from that date through 2026-10-19 exclusive; both 14/30-day horizons must fit inside their period. Direct BTC/ETH/SOL/HYPE/ZEC only after their history begins, using the finder calendar. Proxy BTC/ETH/SOL from 2022-01-02 through 2025, horizon end no later than 2026-01-01. No before-listing backfill of Pacifica execution.

Both 1h and 4h execution, long and short separately, both trade OHLC/OLHC and both mark OHLC/OLHC paths. These are sensitivities, not independent observations or guaranteed bounds. All settings: fixed grid, 10 intervals, step_back, seed on, shipped touch stop, initial equity 1000. Independently apply each rule to both shipped one-week and one-month range geometry. Builder rate per fill: 0.001, 0.0005, 0.0002, 0, added to maker 0.00015 / taker 0.0004. Leverage 1x and 3x. Include observed funding and existing liquidation/backstop model, current frozen maximum leverage and stop-clearance admission. No production accounting change.

Require complete scheduled execution candles, marks and settled funding, even if a bot would stop early; retain exact rejection counts and resulting coverage bias. Seed holds stay admitted idle outcomes. Freeze selection before inspecting execution admissibility and never backfill. BLIND includes all calendar attempts; BLIND_MEASURABLE includes the complete signal cohort. Each arm's primary comparator is BLIND_MEASURABLE on that arm's represented launch weeks, with the same range/fee/leverage/timeframe; also report unrestricted BLIND and measurable baseline. Repeated scenarios and overlapping memberships are never added to the unique admitted tally.

## Point-in-time signal and fixed rules

Signals always use hourly candles, including for 4h execution. At each launch choose OKX first, Gate only if OKX cannot supply 840 consecutive valid, finalized, positive OHLC hourly candles ending exactly at launch minus one hour, and available shipped plannerRegime plus shipped finder qualification on the last 100 of those candles. Never stitch venues. Invalid/missing/forming signal data is unavailable, not rejection. The venue is chosen using the entire 35-day window before deriving indicators. This cross-venue signal follows the finder; execution geometry remains separately computed from the execution history.

Let P be the last closed price. Let L/H be the minimum low / maximum high over the last 672 bars (28 days); W=H-L must be positive; position=(P-L)/W. All days are UTC 24-hour durations relative to launch. Let anchor L0/H0 be the extrema in days -28 through -14 (336 bars), frozen BEFORE the subsequent 14-day validation. Let anchor position=(P-L0)/(H0-L0).

A lower boundary touch is a candle low <= L+0.10W; an upper touch is a candle high >= H-0.10W. Count greedily in chronological order separately for each boundary, requiring at least 24 hours since the previously counted touch on that boundary; adjacent hours never count as separate retests. Count over the last 28 days.

Volatility is the simple mean of 14 true ranges (max of high-low and absolute distances to the preceding close), divided by the same final close. Measure at each of the 28 daily endpoints ending at launch. Sort these 28 values; the 20th percentile is nearest-rank, sorted index ceil(0.20*28)-1. "Not squeezed" means the latest value strictly exceeds that percentile.

Variance ratio uses the last 337 hourly closes (336 hourly log returns). Compute unbiased sample variance of those returns and of all 313 overlapping sums of 24 consecutive returns; VR=variance(24-hour sums)/(24*variance(hourly returns)). Zero/invalid denominator is unavailable for R4/R9, not evidence of reversion. The 7/28-day returns compare P with the closed price exactly 168/672 hours earlier.

| ID | Fixed entry condition | Rationale |
| --- | --- | --- |
| R1_ESTABLISHED | At least two spaced touches of EACH 28-day boundary, and position in [0.40,0.60] | Owner's repeated ranging and return to middle |
| R2_AGED | Every close in the last 14 days inside the previously frozen anchor [L0,H0], and anchor position in [0.25,0.75] | Range held out of its formation window |
| R3_NOT_SQUEEZED | Shipped hourly ADX(14) on last 100 bars <20, and volatility strictly above its 20th percentile | Avoid lowest-volatility compression |
| R4_REVERSION | VR <=0.80 | Negative serial dependence over a daily horizon |
| R5_FLAT | Absolute 28-day return <=0.05, and position in [0.25,0.75] | Flat wider context, away from range edges |
| R6_REJECTED_QUIET | Shipped finder state not-ranging, ADX in [20,25], and absolute 7-day return <=0.03 | Precisely defined rejected but quiet cohort |
| R7_MIDDLE | Position in [0.40,0.60] | Isolate the owner's middle-entry component |
| R8_ESTABLISHED_VOL | R1 AND R3 | Predeclared combined range and volatility rule |
| R9_AGED_REVERSION | R2 AND R4 | Predeclared persistence and reversion combination |

No top-N selection. Keep every selected market. Retain feature values, source, latest closed timestamp, pass/fail/unavailable state and per-rule reasons, independently of simulation outcome. These indicators define hypotheses; no assumption that low ADX predicts breakouts is treated as established fact.

## Development selection and confirmation

Primary analysis uses 1h execution. Consider the fixed 9 rules x 2 ranges x 4 fees x 2 leverage = 144 candidate configurations on development, equally weighting recorded side/horizon/path scenarios. A candidate passes development only with at least 20 admitted launch weeks, at least 20% of measurable BLIND's unique admitted market launches, positive mean and median return, profitable share >50%, mean return above its same-week measurable BLIND, mean drawdown no worse than that baseline, positive mean in a strict majority of represented markets, both long/short sides, both horizons and both trade paths.

For each candidate compute equal-weight admitted launch-week mean return and a normal-approximation lower interval mean-1.96*standardError(weekly means). Rank passing candidates by highest such lower interval, then highest mean, lower mean drawdown, higher builder fee, lower leverage, lexical range and rule ID. Lock at most ONE complete rule/range/fee/leverage configuration, or "no qualifying filter", before any evaluation/proxy computation. Write a timestamped lock bound to registration SHA-256 and preregistration commitHash. No alternative can be promoted using confirmation.

For the locked candidate require in EACH confirmation period the same directional conditions, >=20 represented weeks, >=20% retention, and a positive lower 95% bound for weekly mean AND weekly matched-BLIND return lift. Also require both lower bounds positive using a conservative fixed Newey-West lag-4 standard error over the complete weekly calendar (zero observations for weeks with no admitted signal); this acknowledges overlapping 30-day horizons. Missing-data zero weeks measure cash/idling, not known outcomes for unavailable markets. Report the much smaller observed sample and no reliable-profit conclusion if any requirement fails. No statistical interval guarantees future profit; only one selected confirmation hypothesis is tested. The 144-way development search and previously inspected history remain limitations.

Report every candidate descriptively, with development-pass status; confirmation-pass is a confirmatory claim ONLY for the locked candidate. If none passes development, still run all confirmation cells but mark them descriptive and do not repick. 4h is sensitivity only. Year/regime/market/side/horizon/path breakdowns cannot select a new winner. Regime uses pre-launch 30-day close return >10% up, <-10% down, else ranging; missing endpoints unknown.

## Output, validation and delivery

Report mean/median, profitable share, stops/liquidations, mean/worst drawdown, seed holds, selected and admitted unique market launches per full calendar week including zero-signal weeks, year/regime splits, same-week BLIND and rejection reasons/counts. Signal frequency is for the frozen five-market direct or three-market proxy universe, not the entire platform. Reconcile one-week BLIND against finder results for identical settings and calendars. Verify raw input bindings and uniqueness first-hand.

One plain Node worker, no browser/local Vitest/npx/WSL. Focused FRACTAL tests cover closed-only features, anchor aging, separated touches, gap/source fallback, exact threshold logic, variance ratio, lock selection, same-week comparators and unique tally. TEST REQUEST (owner): focused. TEST-RISK: REQUIRED. Only bundle-v1/run-qv-tests with explicit verified full commitHash; never push. UTF-8 evidence. Tests must report commitHash, host and passed/failed/skipped counts. Research files only. No independent reviewer is implied by self-review.

Commit this file before computing results. Shared worktree metadata is read-only in this sandbox: use a writable shared scratch clone if necessary, preserve the preregistration commit and provide a verified thin bundle plus INSTALL-FILTERS.ps1 targeting only the named worktree and feat/grid-entry-filters branch. Every commit ends with the required coauthor trailer. Checkpoint each phase in handback RESUME.md. Run the reviewer's unchanged read-only snapshot secret scan over the full declared review closure before any seal; preserve all findings. An inherited scan blocker leaves an explicitly UNSEALED research handback. No contract edits after this preregistration commit.
