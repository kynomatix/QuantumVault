# Walk-forward research: blocked at data admission

We could not test whether a repeatable selection process keeps choosing better grid-bot settings, because the required training history has a verified funding gap in January 2022. No new simulations were admitted, so this job establishes neither a winning procedure nor a failed strategy.

## Exact blocker

Fresh official OKX January 2022 archives for **ETH-USDT-SWAP, BTC-USDT-SWAP, SOL-USDT-SWAP, NEAR-USDT-SWAP and DOGE-USDT-SWAP** each contain only **45 funding observations**, from **2022-01-16 16:00 UTC to 2022-01-31 08:00 UTC**. None covers January 1 through January 16 08:00. The first requested training window, January–December 2022, therefore cannot be certified for this panel.

An eight-hour calendar has 93 January slots. These files omit 48: 47 at the beginning and the final January 31 16:00 slot. This is a coverage diagnostic, not an assumption that an absent funding rate was zero, nor proof of the complete historical settlement schedule. The multi-day leading gap alone prevents certification.

The inherited BTC/ETH/SOL snapshots each contain 46 January observations, adding the final slot but leaving the same 47 initial slots absent. Their manifest and all five inherited funding files were independently SHA-256 verified. Fresh ordinary funding-history requests for BTC/ETH/SOL over the missing interval returned API code 0 with zero rows; they did not repair the gap. This conclusion concerns the acquired sources, not proof that no alternative data source exists.

The [official historical-data page](https://www.okx.com/historical-data) currently describes funding downloads as starting in March 2022. Earlier downloadable filenames do exist, as this capture demonstrates, but do not certify full earlier months. Exact API URLs, bytes and hashes are retained in [the request inventory](C:/Apps/Replit/conductor-worktrees/grid-walkforward-20261021-handback/evidence/admission-20261021T003124702Z/requests.json).

## Fixed market screen and bias

The [data admission policy](C:/Apps/Replit/conductor-worktrees/grid-walkforward-20261021-handback/DATA-ADMISSION-POLICY.md) was saved and hash-bound before any live request. It selected 12 current live linear USDT perpetuals listed before 2022-01-01, ranked by captured 24-hour base volume multiplied by last price, descending; ties use instrument ID ascending. This is an approximate current USDT turnover ranking, not historical liquidity or an order-book-depth measurement. No failed market was replaced after inspection.

The fresh catalogue had 515 entries; 64 met the eligibility rules, 451 did not, and 52 eligible entries ranked below the provisional top 12. The [complete ranking and exclusions](C:/Apps/Replit/conductor-worktrees/grid-walkforward-20261021-handback/evidence/admission-20261021T003124702Z/universe.json) are retained. Listing before 2022 establishes neither continuous trading nor uninterrupted funding; the panel remains **provisional, not certified**.

| Liquidity rank | Provisional market | January 2022 funding admission |
|---:|---|---|
| 1 | ETH-USDT-SWAP | Rejected: 45 rows; leading gap verified |
| 2 | BTC-USDT-SWAP | Rejected: 45 rows; leading gap verified |
| 3 | SOL-USDT-SWAP | Rejected: 45 rows; leading gap verified |
| 4 | NEAR-USDT-SWAP | Rejected: 45 rows; leading gap verified |
| 5 | XRP-USDT-SWAP | Unverified: archive-index HTTP 429 |
| 6 | DOGE-USDT-SWAP | Rejected: 45 rows; leading gap verified |
| 7 | UNI-USDT-SWAP | Unverified: archive-index HTTP 429 |
| 8 | FIL-USDT-SWAP | Unverified: archive-index HTTP 429 |
| 9 | BAT-USDT-SWAP | Unverified: archive-index HTTP 429 |
| 10 | BCH-USDT-SWAP | Unverified: archive-index HTTP 429 |
| 11 | AAVE-USDT-SWAP | Unverified: archive-index HTTP 429 |
| 12 | ADA-USDT-SWAP | Unverified: archive-index HTTP 429 |

**Survivorship bias:** this list contains current survivors. **Universe-selection look-ahead:** ranking by October 2026 turnover uses information unavailable in 2022. The owner's fixed-survivor design permits this limitation, but a past-only strategy-selection procedure would not remove it. No assertion is made that the universe itself could have been chosen in 2022.

Seven HTTP 429 responses are request failures, not proof that those markets lack history. No repeated requests were needed to establish the already verified leading gaps. The mandated stop was applied: no later months, complete-price continuity, historical market constraints or Pacifica history were newly certified. Pacifica BTC/ETH/SOL/HYPE/ZEC therefore contribute zero new admissions. A smaller panel or a later training start was not substituted.

## Procedure, window choices and comparisons

The full strategy preregistration was **not committed or executed** because data admission failed. The pre-request data policy is explicitly not a strategy preregistration. The week/month, 6/10/14/20-line, stop, mode, side and optional-filter menu has no new scores; neither fee scenario was evaluated. There is no selected global/group rule, no claimed repeated favourable condition and no post-result tuning.

| Required window output | Result |
|---|---|
| First training interval: 2022-01-01 through 2022-12-31 | Blocked by January funding coverage |
| First selection/trading interval: 2023-01 through 2023-03 | No option chosen; no trading replay |
| Every subsequent quarterly roll through 2026-10 | Not executed; no options chosen |
| Frequency of selecting the same option | Not assessable |

October 2026 is incomplete at dispatch. Even with repaired data, the October-start quarter would need an explicit partial-window rule; it cannot be reported as a completed three-month window. Likewise, earlier inspection of 2022–2026 remains relevant: a walk-forward study would be retrospective evidence about a frozen procedure, not an untouched holdout or a forward observation.

| Builder fee | Walk-forward selection | Requested week / 10 / step_back baseline | Blind repeat_all | Best in hindsight, unattainable upper bound |
|---|---|---|---|---|
| 0.10% | Not run | Not run | Not run | Not computed |
| 0% | Not run | Not run | Not run | Not computed |

| Required statistic | 0.10% builder fee | 0% builder fee |
|---|---|---|
| Pooled calendar-week bootstrap 95% CI for excess return | Not computed | Not computed |
| Annual excess-return CIs, 2023–2026 | Not computed | Not computed |
| Share of quarterly windows beating the comparator | Not computed; no evaluated windows | Not computed; no evaluated windows |
| Drawdown and stop-rate comparison | Not computed | Not computed |
| Success: CI above zero, majority of windows, no worse drawdown | Not assessed | Not assessed |

**Comparator correction:** first-hand inspection of [grid-setup-view.ts](C:/Apps/Replit/conductor-worktrees/grid-walkforward-20261021/client/src/lib/grid-setup-view.ts:6) shows `repeat_all` as this research checkout's default, not `step_back`. The pinned [runtime stop policy](C:/Apps/Replit/conductor-worktrees/grid-walkforward-20261021/server/grid-bot/runtime-policy.ts:35) uses a 0.75 ATR edge buffer for hourly/four-hourly ranges. The brief's week/10/step_back comparator can still be requested, but should be labelled accurately and compared with the actual pinned defaults if the study resumes. No production default or accepted brief was edited.

## Admitted tally and evidence checks

| Tally | Count |
|---|---:|
| ADMITTED unique new simulations | **0** |
| Candidate simulations generated | 0 |
| Simulation rejections | 0: no candidates generated |
| Strategy options scored / selected | 0 / 0 |
| Reused historical simulations added to the tally | 0 |
| Provisional selected market-months screened | 12 |
| Market-months rejected for verified incomplete funding | 5 |
| Market-months unverified because of HTTP 429 | 7 |
| Certified selected market-months | 0 |
| Public HTTP requests / HTTP 200 / HTTP 429 | 22 / 15 / 7 |
| Fresh ZIPs independently decompressed and hash-matched | 5 |
| Inherited funding dataset hashes verified | 5 |

Raw captures were preserved before interpretation. A second reader using .NET ZIP decompression and PowerShell CSV parsing matched every extracted member hash and independently checked timestamps, duplicates, instrument identity, finite rates and missing-slot ranges. See [independent coverage](C:/Apps/Replit/conductor-worktrees/grid-walkforward-20261021-handback/evidence/admission-20261021T003124702Z/independent-coverage.json) and [the final evidence manifest](C:/Apps/Replit/conductor-worktrees/grid-walkforward-20261021-handback/EVIDENCE-MANIFEST.json). The captured provisional panel and all failed requests remain in the evidence.

Research base commitHash: f1df705b5ae50488a22b0c121e98b5ee6cd0dea3; verified branch: feat/grid-walkforward. All seven cited inherited engine/risk/funding/finder/filter/start-time/bootstrap source paths exist. Their presence was verified; their strategy behavior was not re-executed. The condition-search report, lessons and all 42 coverage inventory rows, plus the squeeze, start-time and round-2 reports, were inspected as context. Earlier performance claims and aggregate simulation counts are not adopted as new evidence here.

No browser, production imports, package/lockfile/schema/UI/DB changes, orders, push or merge occurred. Public capture used plain Node with at most two requests in flight and reduced to one below 1.8 GiB free memory. No worker subprocesses were launched for data collection.

**Test run inventory:** none. No test SHA or test host exists; passed, failed and skipped test counts are not applicable, rather than fabricated zero-result receipts. These are data inspection and documentation changes. Local checks were syntax parsing, static scope review, independent data-reading checks, Git bundle verification and the unchanged reviewer snapshot secret scan; detailed outcomes are retained in the review and delivery artifacts. No Vitest, npx, WSL or FRACTAL job was launched.

## Delivery and next requirement

The linked worktree's Git metadata is read-only under this job's sandbox. Research documentation is committed in an isolated shared clone and supplied as a verified thin bundle; [INSTALL-WF.ps1](C:/Apps/Replit/conductor-worktrees/grid-walkforward-20261021-handback/INSTALL-WF.ps1) installs only into the named worktree and feat/grid-walkforward branch. The full commit hash, bundle SHA-256 hash and exact file inventory are in [DELIVERY-MANIFEST.json](C:/Apps/Replit/conductor-worktrees/grid-walkforward-20261021-handback/DELIVERY-MANIFEST.json). The target branch remains at the research base until that installer runs outside this restricted session.

To execute this exact study, first supply independently verifiable actual January 1–16, 2022 funding for the selected markets and complete the remaining coverage checks. Alternatively, the owner can authorize a different start date or panel rule in a new research brief. This job did not silently change either requirement.
