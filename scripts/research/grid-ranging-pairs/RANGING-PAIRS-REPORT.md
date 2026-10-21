# Ranging pairs research — blocked before outcomes

We do not yet know whether pairs that move sideways for years make better grid trades. The wider funding screen found 45 potential markets, but a required evidence scan blocked the study before any new simulations, so there is no defensible pair recommendation or return comparison.

## Status and blocking evidence

**INCOMPLETE / UNSEALED. ADMITTED unique new simulations: 0.** No strategy outcomes, rankings or profit comparisons were computed. The preregistration was committed before acquisition/outcomes; commit hash: f7fc916fcebd2c17ac42c348c467d909ec98f2ae. Research base commit hash: 235f33ddee36e3e6328aecb00990d7b25f9dbe66.

The reviewer's unchanged snapshot scanner rejects line 3 of the UTF-8 FRACTAL receipt under standalone-entropy: the runner's QV_RUN_ID line. The retained raw receipt and reviewer evidence establish this first-hand. The first receipt scan also rejected the original PowerShell UTF-16 encoding as binary; a lossless UTF-8 representation resolves that encoding issue but retains the actual finding. No scanner rule, literal, allowlist or finding was altered. Owner instructions require zero findings before freeze, so no data freeze or simulation launch is authorized. This is an evidence-gate blocker, **not** a finding that fewer than 24 markets exist. The in-flight funding acquisition completed; nothing remains running.

The funding SHA-256 inventories are provisional acquisition manifests, not sealed review approval. A narrowly scoped receipt scan establishes the blocker; the complete acquisition closure has not obtained a clean scan. No independent Opus review or conductor approval is claimed.

## First-hand checks and fixed design

The specified research base and branch were verified. Earlier sizing reports do not establish a confirmed joint return/drawdown advantage for Further/Near. Earlier ADX filtering stayed within the previously selected liquid markets and does not answer the owner's different-universe critique. This study's committed primary score is twelve-month Kaufman efficiency, ascending, with floor(N/3) terciles and ASCII symbol tie-breaks; six/twelve-month containment and mean crossings are descriptive only. Quarterly selections use only completed prelaunch data. Current-survivor and current-liquidity bias remain: dead/delisted pairs are absent.

The committed plan uses week/month ranges, ten intervals, explicit step_back, shipped stops, all three requested sizing choices, 1x/3x, 14/30 days and both directions. The sizing-study calendar rotates ONE launch per week through 21 weekday/hour slots; it is not 21 launches each week. Builder 0% is primary with maker 0.015% and taker 0.040%; 0.10% builder is secondary. Pacifica's captured fee response calls the base schedule level 0, despite the brief's Tier 1 wording. Current Pacifica ticks/lots and at least USD 10 order minimum are preregistered for A; B must use actual OKX specs because those contracts have no Pacifica spec. External trade candles proxy marks; that limitation must accompany any later result.

## Population and coverage before outcomes

Pacifica's public info returned 78 records: 77 tagged perpetual and one other instrument. The exact-base mapping rule produced A=77 and B=49, total 126 candidates; 114 preferred OKX, four preferred Gate and eight unmatched. B is all additional live OKX linear USDT contracts listed before 2022-01-01, subject to a fixed current 30-day median daily quote-volume floor of USD 1 million. No performance selection was used.

| Acquisition stage | Count |
|---|---:|
| Candidate A / B | 77 / 49 |
| Initial liquidity/first-month funding passes | 63 |
| Full-period funding passes A / B | 25 / 20 |
| Full-period funding passes total | 45 |
| Rechecked inherited continuous hourly candles plus funding | 12 |
| Other funding passes awaiting full candle/daily-volume certification | 33 |
| Stage failures (not simulation rejections) | 81 |
| Fully frozen study admissions | 0 |

The twelve inherited markets' recorded SHA-256 hashes, hourly continuity and observed funding were rechecked. The additional 33 have passed funding checks but have **not** been certified for hourly execution and full-period quote volume. Therefore 45 is a funding-screen count, not an admitted-data or simulation count. Their required funding begins 2022-03-01 or their later first complete listing day and ends 2026-10-19 UTC exclusive. Missing rates were never replaced by zero. Gate's required old funding requests returned HTTP 400 in the attempted requests; this is not proof all possible Gate access is unavailable. Some later OKX failures still require an individual Gate fallback audit. No final vendor-unavailability conclusion is drawn for those pairs.

| First failing stage reason | Count |
|---|---:|
| Less than twelve months before final selection on preferred source | 30 |
| No exact base-asset mapping (scaled/renamed contracts not assumed) | 8 |
| HTTP 400 for required historical Gate funding | 2 |
| Invalid funding row | 1 |
| Funding archive not uniquely available 2025-04 | 1 |
| B liquidity threshold: median daily quote below USD 1 million | 21 |
| Incomplete observed funding in 2026-04 | 2 |
| Full-period observed funding incomplete | 2 |
| Incomplete observed funding in 2025-05 | 8 |
| Incomplete observed funding in 2025-10 | 1 |
| Incomplete observed funding in 2025-03 | 1 |
| Incomplete observed funding in 2026-01 | 1 |
| Incomplete observed funding in 2026-08 | 1 |
| Incomplete observed funding in 2024-07 | 2 |

These mutually exclusive stage reasons sum to 81; every pair is listed in PAIR-COVERAGE.csv with observed volume, current spread and thin flag where obtained. Missing observations are blank, never zero. Counts do not imply an exhaustive Gate certification attempt for every OKX failure.

## Potential markets, not a good-grid-pair list

A funding survivors: BTC, ETH, SOL, XRP, DOGE, AAVE, UNI, NEAR, BCH, ADA, FARTCOIN, BNB, SUI, LINK, LTC, WLFI, LDO, CRV, XPL, VIRTUAL, TRUMP, WLD, ICP, ARB, USELESS.

B funding survivors: BAT, FIL, ALGO, ATOM, CFX, CHZ, COMP, DOT, CRO, DYDX, ENS, ETC, GALA, IOTA, MANA, PEOPLE, SHIB, SUSHI, TRX, XLM.

Thin funding survivors: BAT, CFX, CHZ, COMP, CRO, DYDX, ENS, GALA, IOTA, MANA, PEOPLE, SUSHI. The preregistered flag is median daily quote volume below USD 5 million, current spread above 20 bps or unavailable spread. Full fills remain optimistic on thin markets. No selection-frequency ranking was computed, so this list must not be presented as grid recommendations. Full-period daily median volume and hourly high-low spread proxy remain pending; the CSV has the captured latest-30-day median quote volume and contemporaneous bid/ask spread.

## Requested result tables — not estimable

| Builder fee | Leverage | Walk-forward ranging vs trending/all/majors | Hindsight benchmark | Sizing interaction |
|---|---|---|---|---|
| 0% primary | 1x | Not run | Not run | Not run |
| 0% primary | 3x | Not run | Not run | Not run |
| 0.10% secondary | 1x | Not run | Not run | Not run |
| 0.10% secondary | 3x | Not run | Not run | Not run |

Pooled/per-year means and 95% calendar-week bootstrap CIs, quarterly win shares, mean/worst drawdowns, worst 5%, stop rates, liquidation counts and time underwater are all unavailable. Actual comparisons made: **0**; bootstrap intervals computed: **0**. Success is unassessed, not failed. A hindsight selection is unattainable at launch and is not a mathematical upper bound on grid profit. The fixed five-major comparator also lacks full admitted coverage: BTC/ETH/SOL passed funding; HYPE and ZEC were not admitted. No replacement was made.

## Validation and delivery

TEST-RISK: REQUIRED. Focused test request is retained in OWNER-TEST-REQUEST.md. One FRACTAL run completed:

| Tested commit hash | Host | Passed | Failed | Skipped |
|---|---|---:|---:|---:|
| 8fa8194f61b9236f6bd3a3493098423d5c2d1ae1 | Fractal / Ubuntu 26.04.1 / Node 22.23.1 | 7 | 0 | 0 |

The seven tests cover point-in-time cutoffs, score warmup/gaps, terciles/ties, quarterly mapping, rotating launch calendar, tail/bootstrap helpers and request filename namespaces. They do not establish market-data completeness, end-to-end capture correctness or replay results. No local Vitest/npx, browser, DB operation, production edit or push occurred. Acquisition and review scripts received static inspection. Full replay/analysis was not implemented after the mandatory evidence gate blocked progress.

A capture defect was found before outcomes: per-process request sequence numbers could overwrite another process's raw response. That root was retired, a fresh root reacquired, and filenames now include a process namespace. The retired root and hold note are preserved; it is not used as certified data. A tested pure namespace helper does not by itself certify the live capture integration.

Shared Git metadata is read-only here. The preregistration and research changes are committed in the writable scratch clone; a verified thin delivery bundle and guarded INSTALL-RANGING.ps1 install into the specified worktree/branch only. No main merge or push is authorized. The handback remains blocked/unsealed even after installation. See DELIVERY.json for final commit/bundle hash labels and RESUME.md for a precise recovery checkpoint.

## Evidence locations

- Current acquisition root: C:/Apps/Replit/conductor-worktrees/grid-ranging-pairs-20261021-handback/evidence/coverage-20261021T100004840Z
- Candidate/stage CSV: C:/Apps/Replit/conductor-worktrees/grid-ranging-pairs-20261021-handback/PAIR-COVERAGE.csv
- Original receipt: C:/Apps/Replit/conductor-worktrees/grid-ranging-pairs-20261021-handback/FOCUSED-RUN.log
- UTF-8 receipt: C:/Apps/Replit/conductor-worktrees/grid-ranging-pairs-20261021-handback/FOCUSED-RUN.utf8.log
- Snapshot pointer: C:/Apps/Replit/conductor-worktrees/grid-ranging-pairs-20261021-handback/receipt-review-snapshot-path.txt
- Preregistration: C:/Apps/Replit/conductor-worktrees/grid-ranging-pairs-20261021/scripts/research/grid-ranging-pairs/PREREGISTRATION.md

Primary documentation consulted: [Pacifica market info](https://docs.pacifica.fi/api-documentation/api/rest-api/markets/get-market-info), [OKX historical downloads](https://www.okx.com/historical-data), [Gate API documentation](https://www.gate.com/docs/developers/apiv4/en/). Actual counts and exclusions above come from captured responses and first-hand continuity checks, not the documentation alone.
