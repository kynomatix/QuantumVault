# Walk-forward report — revision 2

Choosing settings from the past did not beat the defaults reliably at either fee level. The picks had simulated compounded returns of -58.26% at 0.100% builder fees and -36.44% at 0.000% builder fees; these results on surviving markets and previously examined years do not establish future profitability.

## What was tested

One global option per builder-fee scenario, chosen every three calendar months using only completed weekly outcomes in the preceding twelve months. Training began March 1, 2022; the first forward selection was March 1, 2023. The observed endpoint is October 19, 2026, exclusive, so the final quarter and 2026 are partial. Weeks launch Monday, last seven days and explicitly pay terminal closing fees and slippage. Selections are frozen at launch; a week crossing a selection boundary cannot enter that selection's training.

The menu contains 384 options: week/month range; 6/10/14/20 planner intervals; original/1.5-times stop distance; step_back/repeat_all; long/short/30-day-return sign; none/R1/ATR/finder filter. The exact definitions, cash behavior and tie-breaks are in [the committed preregistration](PREREGISTRATION-R2.md). A rejected executable plan or false entry condition leaves cash; missing funding never does.

Preregistration commitHash: 263fdba1ba25bba134a715093ef15934e28a5817. Preregistration SHA-256 hash: 48109b69b0dfcea6ada377dbf5783c74e21fc85af07d30c0e80316fd4678b925. Strategy outcomes computed at freeze: zero. The research branch predates the changed default, so the comparator explicitly sets week, 10 intervals, shipped stop and step_back, long, with no filter.

## Admission and assumptions

12 of the fixed twelve OKX markets are admitted: ETH, BTC, SOL, NEAR, XRP, DOGE, UNI, FIL, BAT, BCH, AAVE, ADA. Funding coverage is March 1, 2022 through October 19, 2026 exclusive, using actual observed payments. Price continuity is verified from January 1, 2022. 3252 recent funding observations also have equal reported and realized rates. No missing payment is set to zero. Monthly archives stop at a boundary before September's final payment; the recent-history API supplied that boundary and October, without conflicting overlaps.

The initial exact-hour screen falsely rejected delayed actual settlements. Both correction rounds, policies and focused test receipts are retained. Final coverage checks observed eight-hour payments with their actual delayed timestamps; all raw timestamps remain unchanged in replay. The 2022-01 funding shortfall that blocked round 1 is outside the newly authorized training period. Round 1 evidence is preserved unchanged.

The universe was fixed by current live status, pre-January-2022 listing and current 24-hour quote liquidity, with no replacements. This deliberately carries survivorship bias and future information in universe selection. The 1x, 1,000-unit sleeves use current tick/lot/leverage constraints and fixed maker/taker fees of 0.015%/0.04%, plus the stated builder fee. Historical constraint schedules are unavailable. OKX trade candles proxy mark prices; therefore liquidation results are not exchange-exact. Full fills and hourly OHLC ordering are modeling assumptions. Reported compounded returns are a return index of fixed-size weekly sleeves.

Primary results take the lower OHLC/OLHC return in each market-week, then equally weight markets. This conservative envelope is not a known actual intrabar path. Both individual path results are supplied below. Within-trade drawdown is inherited and measured before terminal close; the success criterion uses the fully costed weekly portfolio drawdown.

## Main comparisons

| Builder fee | Strategy | Mean weekly net | Compounded forward return index | Weekly maximum drawdown | Stop rate per market-week |
|---|---|---:|---:|---:|---:|
| 0.100% | Walk-forward picks | -0.411% | -58.26% | 63.017% | 23.589% |
| 0.100% | Shipped step_back | -0.343% | -51.11% | 53.610% | 39.506% |
| 0.100% | Blind repeat_all | -0.477% | -62.80% | 64.725% | 39.506% |
| 0.100% | Unattainable window hindsight | 0.787% | 317.58% | 9.336% | 8.730% |
| 0.000% | Walk-forward picks | -0.185% | -36.44% | 45.765% | 22.090% |
| 0.000% | Shipped step_back | -0.134% | -27.26% | 42.832% | 39.506% |
| 0.000% | Blind repeat_all | -0.196% | -36.57% | 49.978% | 39.506% |
| 0.000% | Unattainable window hindsight | 0.937% | 446.88% | 9.047% | 12.963% |

## How often the procedure actually traded

Cash can beat losing defaults. This tally distinguishes skipped entry conditions and unaffordable grid plans from admitted replays; seed holds are included in admitted replays and shown separately.

| Builder fee | Strategy | Market-weeks | Filter cash | Planner cash | Admitted replay weeks | Seed held in either path |
|---|---|---:|---:|---:|---:|---:|
| 0.100% | Walk-forward picks | 2268 | 0 | 0 | 2268 | 0 |
| 0.100% | Shipped step_back | 2268 | 0 | 8 | 2260 | 0 |
| 0.100% | Blind repeat_all | 2268 | 0 | 8 | 2260 | 0 |
| 0.000% | Walk-forward picks | 2268 | 0 | 0 | 2268 | 0 |
| 0.000% | Shipped step_back | 2268 | 0 | 8 | 2260 | 0 |
| 0.000% | Blind repeat_all | 2268 | 0 | 8 | 2260 | 0 |

## Paired confidence intervals and decision

Intervals are percentage points of mean weekly return, picks minus shipped defaults, with 10,000 paired calendar-week bootstrap draws and seed 20261021. Four-week circular blocks are a serial-dependence sensitivity.

| Builder fee | Year | Weeks | Mean difference | 95% one-week interval | 95% four-week interval |
|---|---|---:|---:|---|---|
| 0.100% | pooled | 189 | -0.067% | [-0.474%, 0.333%] | [-0.475%, 0.319%] |
| 0.100% | 2023 | 43 | -0.187% | [-1.169%, 0.784%] | [-1.245%, 0.842%] |
| 0.100% | 2024 | 53 | 0.183% | [-0.433%, 0.799%] | [-0.306%, 0.672%] |
| 0.100% | 2025 | 52 | 0.059% | [-0.481%, 0.595%] | [-0.435%, 0.524%] |
| 0.100% | 2026 | 41 | -0.426% | [-1.630%, 0.753%] | [-1.566%, 0.727%] |
| 0.000% | pooled | 189 | -0.051% | [-0.494%, 0.389%] | [-0.483%, 0.355%] |
| 0.000% | 2023 | 43 | -0.238% | [-1.204%, 0.722%] | [-1.281%, 0.776%] |
| 0.000% | 2024 | 53 | 0.325% | [-0.421%, 1.065%] | [-0.275%, 0.904%] |
| 0.000% | 2025 | 52 | 0.018% | [-0.532%, 0.564%] | [-0.483%, 0.491%] |
| 0.000% | 2026 | 41 | -0.428% | [-1.784%, 0.890%] | [-1.682%, 0.760%] |

At builder fee 0.100%: 5/15 forward windows beat default. Pooled lower confidence bound is -0.474%; picked drawdown 63.017% versus default 53.610%. Preregistered verdict: **FAIL**. Four-week lower bound: -0.475%.

At builder fee 0.000%: 6/15 forward windows beat default. Pooled lower confidence bound is -0.494%; picked drawdown 45.765% versus default 42.832%. Preregistered verdict: **FAIL**. Four-week lower bound: -0.483%.

## What was chosen

Option IDs are range / intervals / stop multiple / mode / side / entry filter. A zero-return cash strategy can outrank trading losses; selection frequency alone does not establish a profitable trading edge.

| Builder fee | Forward window | Training weeks | Chosen option | Picked return | Default return | Hindsight return |
|---|---|---:|---|---:|---:|---:|
| 0.100% | 2023-03-01 to 2023-06-01 | 51 | week / 6 / 1.5 / step_back / short / none | 0.30% | -9.11% | 7.43% |
| 0.100% | 2023-06-01 to 2023-09-01 | 51 | month / 6 / 1.5 / repeat_all / long / none | -4.89% | -4.60% | 3.87% |
| 0.100% | 2023-09-01 to 2023-12-01 | 51 | month / 6 / 1 / repeat_all / short / none | -15.84% | 3.11% | 14.13% |
| 0.100% | 2023-12-01 to 2024-03-01 | 51 | month / 10 / 1 / repeat_all / sign30 / none | 0.15% | 8.00% | 12.82% |
| 0.100% | 2024-03-01 to 2024-06-01 | 51 | week / 6 / 1 / step_back / long / none | -7.42% | -6.96% | 8.49% |
| 0.100% | 2024-06-01 to 2024-09-01 | 51 | month / 10 / 1.5 / repeat_all / long / none | -17.46% | -15.93% | 4.21% |
| 0.100% | 2024-09-01 to 2024-12-01 | 51 | month / 14 / 1.5 / repeat_all / long / none | 21.76% | 8.47% | 22.78% |
| 0.100% | 2024-12-01 to 2025-03-01 | 51 | month / 10 / 1.5 / step_back / long / none | -13.95% | -20.85% | 20.98% |
| 0.100% | 2025-03-01 to 2025-06-01 | 51 | month / 14 / 1 / repeat_all / long / none | -15.74% | -12.31% | 7.79% |
| 0.100% | 2025-06-01 to 2025-09-01 | 51 | month / 14 / 1.5 / repeat_all / long / none | 8.18% | 5.07% | 11.38% |
| 0.100% | 2025-09-01 to 2025-12-01 | 52 | month / 10 / 1.5 / repeat_all / long / none | -12.85% | -11.92% | 11.68% |
| 0.100% | 2025-12-01 to 2026-03-01 | 52 | week / 6 / 1.5 / step_back / short / none | 5.04% | -10.24% | 12.06% |
| 0.100% | 2026-03-01 to 2026-06-01 | 51 | week / 6 / 1.5 / step_back / short / none | -9.35% | 6.73% | 7.29% |
| 0.100% | 2026-06-01 to 2026-09-01 | 52 | month / 6 / 1 / repeat_all / sign30 / none | -9.48% | -0.24% | 3.23% |
| 0.100% | 2026-09-01 to 2026-10-19 (partial) | 52 | month / 6 / 1.5 / repeat_all / short / none | -5.29% | -2.79% | 4.01% |
| 0.000% | 2023-03-01 to 2023-06-01 | 51 | week / 6 / 1.5 / step_back / short / none | 2.64% | -6.33% | 8.08% |
| 0.000% | 2023-06-01 to 2023-09-01 | 51 | month / 6 / 1.5 / repeat_all / long / none | -3.11% | -1.85% | 4.39% |
| 0.000% | 2023-09-01 to 2023-12-01 | 51 | month / 6 / 1 / repeat_all / short / none | -13.90% | 5.89% | 16.53% |
| 0.000% | 2023-12-01 to 2024-03-01 | 51 | month / 10 / 1 / repeat_all / sign30 / none | 2.37% | 10.83% | 14.84% |
| 0.000% | 2024-03-01 to 2024-06-01 | 51 | month / 10 / 1.5 / repeat_all / long / none | 2.62% | -4.48% | 10.65% |
| 0.000% | 2024-06-01 to 2024-09-01 | 51 | month / 20 / 1.5 / repeat_all / long / none | -15.59% | -13.73% | 5.84% |
| 0.000% | 2024-09-01 to 2024-12-01 | 51 | month / 14 / 1.5 / repeat_all / long / none | 25.07% | 11.21% | 25.49% |
| 0.000% | 2024-12-01 to 2025-03-01 | 51 | month / 14 / 1.5 / repeat_all / long / none | -12.73% | -18.67% | 22.65% |
| 0.000% | 2025-03-01 to 2025-06-01 | 51 | month / 20 / 1 / repeat_all / long / none | -13.61% | -9.94% | 11.25% |
| 0.000% | 2025-06-01 to 2025-09-01 | 51 | month / 14 / 1.5 / repeat_all / long / none | 11.03% | 8.09% | 13.55% |
| 0.000% | 2025-09-01 to 2025-12-01 | 52 | month / 10 / 1.5 / repeat_all / long / none | -10.80% | -9.44% | 13.43% |
| 0.000% | 2025-12-01 to 2026-03-01 | 52 | week / 6 / 1.5 / step_back / short / none | 7.29% | -7.77% | 13.66% |
| 0.000% | 2026-03-01 to 2026-06-01 | 51 | week / 14 / 1.5 / step_back / short / none | -6.76% | 9.79% | 10.71% |
| 0.000% | 2026-06-01 to 2026-09-01 | 52 | month / 10 / 1.5 / repeat_all / short / none | -6.41% | 2.79% | 6.35% |
| 0.000% | 2026-09-01 to 2026-10-19 (partial) | 52 | month / 6 / 1.5 / repeat_all / short / none | -4.24% | -1.40% | 4.79% |

At 0.100%, choice frequency: week / 6 / 1.5 / step_back / short / none (3 windows); month / 10 / 1.5 / repeat_all / long / none (2 windows); month / 14 / 1.5 / repeat_all / long / none (2 windows); month / 6 / 1.5 / repeat_all / long / none (1 windows); month / 6 / 1 / repeat_all / short / none (1 windows); month / 10 / 1 / repeat_all / sign30 / none (1 windows); week / 6 / 1 / step_back / long / none (1 windows); month / 10 / 1.5 / step_back / long / none (1 windows); month / 14 / 1 / repeat_all / long / none (1 windows); month / 6 / 1 / repeat_all / sign30 / none (1 windows); month / 6 / 1.5 / repeat_all / short / none (1 windows).
The best training median was exactly zero in 0/15 selections; 0/15 selections needed the final alphabetical tie-break after equal score and stop rate (largest tied set: 1). Repeated selection among tied options does not identify a uniquely favorable setting.
The best static hindsight option over the full forward period was month / 10 / 1 / step_back / long / ATR, with return index 9.32% and weekly drawdown 7.082%. The window-by-window hindsight comparator can switch using future outcomes and is an unattainable upper bound within this menu.

At 0.000%, choice frequency: month / 14 / 1.5 / repeat_all / long / none (3 windows); week / 6 / 1.5 / step_back / short / none (2 windows); month / 10 / 1.5 / repeat_all / long / none (2 windows); month / 6 / 1.5 / repeat_all / long / none (1 windows); month / 6 / 1 / repeat_all / short / none (1 windows); month / 10 / 1 / repeat_all / sign30 / none (1 windows); month / 20 / 1.5 / repeat_all / long / none (1 windows); month / 20 / 1 / repeat_all / long / none (1 windows); week / 14 / 1.5 / step_back / short / none (1 windows); month / 10 / 1.5 / repeat_all / short / none (1 windows); month / 6 / 1.5 / repeat_all / short / none (1 windows).
The best training median was exactly zero in 0/15 selections; 0/15 selections needed the final alphabetical tie-break after equal score and stop rate (largest tied set: 1). Repeated selection among tied options does not identify a uniquely favorable setting.
The best static hindsight option over the full forward period was month / 6 / 1 / repeat_all / sign30 / none, with return index 23.89% and weekly drawdown 18.509%. The window-by-window hindsight comparator can switch using future outcomes and is an unattainable upper bound within this menu.

## Intrabar sensitivity

The selections remain those made by the preregistered conservative score; these rows do not reselect a favorable path.

| Builder fee | Path | Paired mean weekly difference | 95% interval | Picked drawdown | Default drawdown |
|---|---|---:|---|---:|---:|
| 0.100% | OHLC | -0.069% | [-0.476%, 0.330%] | 62.960% | 53.366% |
| 0.100% | OLHC | -0.066% | [-0.473%, 0.334%] | 62.899% | 53.610% |
| 0.000% | OHLC | -0.053% | [-0.496%, 0.388%] | 45.687% | 42.594% |
| 0.000% | OLHC | -0.049% | [-0.492%, 0.391%] | 45.549% | 42.832% |

## Pacifica supplementary transfer

The OKX-selected procedure is applied unchanged to BTC, ETH, SOL, HYPE and ZEC where execution candles, mark candles, actual hourly funding and prior OKX signal history are complete. These shorter histories do not select the option or enter the primary confidence intervals. Each market has its own eligible weeks; compare strategies only within that market row. Four trade/mark path combinations are conservatively reduced.

| Builder fee | Market | Eligible weeks | Picked mean weekly | Default mean weekly | Picked drawdown | Default drawdown |
|---|---|---:|---:|---:|---:|---:|
| 0.100% | BTC | 52 | -0.727% | -0.373% | 34.690% | 22.431% |
| 0.100% | ETH | 51 | -0.719% | -0.343% | 44.121% | 25.331% |
| 0.100% | SOL | 51 | -0.614% | 0.040% | 40.453% | 14.908% |
| 0.100% | HYPE | 47 | -1.459% | -0.428% | 63.222% | 28.376% |
| 0.100% | ZEC | 28 | -2.396% | 1.419% | 56.761% | 10.669% |
| 0.000% | BTC | 52 | -0.628% | -0.172% | 31.274% | 18.823% |
| 0.000% | ETH | 51 | -0.857% | -0.140% | 44.512% | 22.942% |
| 0.000% | SOL | 51 | -0.554% | 0.247% | 40.336% | 12.339% |
| 0.000% | HYPE | 47 | -1.404% | -0.211% | 62.922% | 24.075% |
| 0.000% | ZEC | 28 | -0.969% | 1.604% | 34.796% | 10.361% |

Supplementary excluded market-fee-weeks: 194. Reasons: execution candle gap: 16; missing or ambiguous observed hourly funding: 168; signal warmup or gap: 10. Exact dates and funding checks are in supplement.json.

## Simulation and rejection tally

Main-panel physical attempts: 740352. **ADMITTED unique new main simulations: 739368.** Planner no-launch rejections: 984; data rejections: 0; replay rejections: 0. Derived option rows: 2221056; false-filter cash rows: 1368576. Supplementary physical attempts: 5496; admitted unique new: 5432; planner no-launch rejections: 64. Total ADMITTED unique new simulations: **744800**. Equivalent sign/filter/benchmark uses share physical results and are not recounted.

| Main rejection reason | Count |
|---|---:|
| plannerRejected: Assumed round-trip cost is at least a cycle spread | 280 |
| plannerRejected: Safety envelope is unavailable or below the execution bound | 704 |

## Validation and reproducibility

TEST-DEFECT: REQUIRED for corrected funding admission; TEST-RISK: REQUIRED for new selection, closing-cost and hourly funding accounting. All required focused tests ran on FRACTAL, with verified full commit hashes. No local test framework, full regression, browser, production changes, push or merge.

| Test receipt | Commit hash | Host | Passed | Failed | Skipped |
|---|---|---|---:|---:|---:|
| FRACTAL-R2.stdout.log | 7e2a5a6dbbb074820fb8e04b07034ee31679282e | Fractal | 7 | 0 | 0 |
| FRACTAL-R2-CORRECTION2.stdout.log | 72f83b80f8bb3247c37080d7816d3e77f4ea8e4f | Fractal | 7 | 0 | 0 |
| FRACTAL-PROCEDURE-R2.stdout.log | 263fdba1ba25bba134a715093ef15934e28a5817 | Fractal | 13 | 0 | 0 |
| FRACTAL-RUNNER-R2.stdout.log | 38a1e7af9e7802ea8cbba867af83b904ffcfb6a6 | Fractal | 15 | 0 | 0 |
| FRACTAL-DEPENDENCIES-R2.stdout.log | 4648739227961298f0c09439a1562d6636cb87c7 | Fractal | 15 | 0 | 0 |
| FRACTAL-ISOLATION-R2.stdout.log | 6730da031a25a938098108b24033d147618e3d65 | Fractal | 17 | 0 | 0 |

Evidence roots: C:\Apps\Replit\conductor-worktrees\grid-walkforward-20261021-handback\evidence\r2-certified-20261021T013112001Z; C:\Apps\Replit\conductor-worktrees\grid-walkforward-20261021-handback\evidence\r2-simulations-20261021T014949507Z. Exact rankings, selected training cutoffs, weekly returns, physical results, input hashes, counts and resumable acquisition checkpoints are retained. The fixedReplay backend and planner adapters are inherited from the earlier reviewed research harness; this job adds terminal closing costs and the preregistered selection procedure. Static checks and the reviewer's unchanged read-only snapshot secret scan are recorded separately in REVIEW-R2.md and REVIEW-SCAN-R2.json. Installation is a guarded research-only thin bundle because this sandbox cannot write the source worktree's shared Git metadata.

Primary funding schedule references: [OKX funding mechanism](https://www.okx.com/en-ae/help/perps-funding-fee-mechanism), [automatic frequency adjustment](https://www.okx.com/it/help/okx-announcement-on-the-upgrade-of-automatic-funding-fee-settlement). These describe possible schedule changes; the admission evidence is the captured observed payment series, not a current schedule assumed backward.
