# Grid default research preregistration

Registered 2026-10-20 before computing new returns. Research base commitHash: 02afe5354e0192f5068357c225a5d15ad12f6ffc. This is retrospective research, never a production change or a merge to main.

## Verified baseline and implementation

The pinned source defaults to week, 10 intervals, repeat_all, seed true, flat/flat (Equal), leverage 1 and 1h. Prior experiments used eight intervals and both seed choices, so their pooled results are not this baseline. Both 1h and 4h remain research strata. Investment is an experimental 1,000 quote units, not a form default (the form leaves it blank).

Use the actual PlannerRangeFacts.read, timeWindowRange and gridHistoryWindow implementations. Feed only finalized pre-launch candles, with the historical candle boundary as the advisory clock. Freeze current observed Pacifica constraints from the prior snapshot; do not pretend they were observed historically. Lower/upper include 0.5 ATR(14), stop buffers are 0.75 ATR on 1h/4h; inward range and outward stop rounding come from PlannerRangeFacts. The manual-range 3% suggestion is a different workflow. Wider stops multiply the distance between the already tick-rounded adverse range edge and its shipped stop, then round outwards again. No no-stop arm.

Call the prior runTrailBacktest and its actual calculateCycleGrid/cycle replay/planner helpers. A fail-closed research loader changes only its two hardcoded interval references to accept an input interval count; default remains eight for equivalence checks. Keep the prior honestly labelled proxy source adapter. No planner/sizing/accounting maths are reimplemented. Flat sizing includes the shipped lot-rounded opening minima ($10 in the frozen metadata) and capacity limits. Record rejected plans and their reasons instead of changing capital or bypassing fee clearance. Keep seed on, fixed range, leverage 1, prior maker 0.115%, taker 0.14%, slippage 0.05%, no funding, final inventory marked at the horizon, and permanent stop termination.

## Locked 38-setting design

For EACH of repeat_all and step_back, run these 19 geometries:

- day/week/month x stop multiplier 1/1.5/2 x 10 intervals: nine.
- day/week/month x shipped stop multiplier 1 x intervals 6/14: six.
- week x stop multiplier 1.5/2 x intervals 6/14: four.

This includes all single-factor changes and the complete three-factor grid around the week baseline; it deliberately omits wider-stop/fewer-or-more-interval interactions for day/month to cap the search at 38. IDs are window-multiplier-intervals-mode. The shipped comparator is week-1-10-repeat_all. Also report each geometry against week-1-10 in its own mode.

## Calendar, data and missingness

Reuse and verify SHA-256 manifests for the frozen direction-study Pacifica and OKX/Gate snapshots; never download replacement data or select sources on outcomes. Pacifica BTC/ETH/SOL/HYPE/ZEC, proxy BTC/ETH/SOL; 1h/4h, 14/30 calendar days, long/short, OHLC/OLHC. Weekly Sunday 00:00 UTC launches. Pacifica development uses the prior start formula (first Sunday after max(100 bars, 10.5 days) from the first candle), through horizons ending by 2026-03-01; evaluation starts 2026-03-01, complete horizons by 2026-10-19 exclusive. Proxy starts 2022-01-02 and ends each market/timeframe at its first Pacifica candle. Missing boundary/history or invalid plans are recorded. Month can require more prehistory; do not backfill or silently truncate it. Use the original rollingWindows admission and data-hold behavior.

Report every setting's admitted-run metrics and admission coverage. The intent-to-launch sensitivity retains every scheduled scenario with rejected launches earning zero on idle cash, zero fees/fills/drawdown/stops. Distinguish a protective stop from a seed-price hold. Missing replay time remains flagged. No prices are interpolated. Candle paths and overlapping horizons are dependent observations.

## Selection locked before confirmation

Compute DEVELOPMENT first, write and hash its selection record before computing EVALUATION or PROXY. For each candidate, compare on paired scenarios admitted by both it and the shipped comparator, separately under OHLC and OLHC. Require strictly higher mean return, no higher mean drawdown, and no higher protective-stop rate under BOTH paths. Require candidate overall admission coverage at least baseline coverage, and the same return/drawdown/stop inequalities on the full scheduled grid with rejected launches held as cash. Also require these conditions against the same-mode baseline for a geometry change; the week-1-10-step_back candidate needs only the shipped comparison. Do not select the shipped comparator as an improvement.

Among eligible candidates select the greatest pooled paired mean-return improvement against shipped, breaking exact ties by lower mean drawdown, lower stop rate, then lexical ID. If none qualify, recommend keep the shipped defaults. A selected setting is confirmed only if all the same inequalities and coverage requirements hold in EACH confirmation period, under BOTH paths. No re-picking on confirmation. If confirmation fails, recommend keep the shipped defaults. Report the development winner even when rejected by confirmation. No significance claim, annualization or portfolio-return claim.

## Reporting and checks

Report mean/median net return, profitable share (>0), protective-stop rate, mean/worst maximum peak-to-trough drawdown, mean/total fees and fills, admitted/scheduled counts and seed holds for each setting/period/path. Provide pooled tables and machine-readable mode/market/side/timeframe/horizon/year splits. Returns are fractions in CSV and percentages in prose. Drawdown retains the prior engine definition (fraction of running equity peak). Reproduce representative prior eight-interval runs before evaluating the new grid. Verify actual interval count, minima, no range moves and pre-launch data boundaries at runtime.

Plain Node, ONE simulation worker (therefore always satisfies the <1.8 GiB fallback); retain sampled minimum free memory and elapsed time. No local Vitest/npx/npm install/WSL/database. Focused FRACTAL tests are required for uncertainty in the new research adapter and selector; no full suite. TEST REQUEST (owner): focused. A transport failure is reported honestly, never replaced with laptop tests. Preserve static review and the reviewer's own read-only snapshot scan over the declared input closure. No external publication, pushes, production edits or edits to prior research.

Commit this file before results in the dispatched branch if writable, otherwise in a shared scratch clone within the handback. Deliver a verified thin bundle and branch/base/content-checked INSTALL-DEFAULTS.ps1 if the worktree Git metadata is read-only. Every commit ends with the requested co-author trailer. A two-sentence plain-language headline and explicit limitations conclude the study; do not promise future profit.
