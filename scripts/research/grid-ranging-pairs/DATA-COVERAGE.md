# Pre-outcome data coverage

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


No outcomes exist; this is not a sealed snapshot.
