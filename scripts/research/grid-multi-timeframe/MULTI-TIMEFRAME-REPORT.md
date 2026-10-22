# Multi-timeframe grid research

No shorter-range combination passed every registered requirement for beating the seven-day Simple grid. Some averages may improve, but none cleared the complete return, consistency and downside checks; this study does not justify changing the live preset.

## What was compared

D1M15 uses the preceding one day of 15-minute candles and runs for three days. D3M15 uses three days of 15-minute candles and runs for seven days. D3H1 uses three days of hourly candles and runs for seven days. D7H1 uses seven days of hourly candles and runs for fourteen days. Each has ten intervals, seed on, step_back, the shipped stop calculation, and either Equal/Equal or Further/Near sizing. G0 has no gate; G1 rejects daily squeeze; G2 combines G1 with the inherited six-month low-ADX tercile; G3 takes only the direction above/below the 50-week moving average; G4 combines G1 and G3.

The reference is D7H1 Further/Near. Both the raw reference and its G1-advised version are reported. Universe A contains Pacifica-listed pairs and is primary; A+B adds the secondary universe. Builder fee 0% is primary and 0.10% is secondary; maker/taker base fees are 0.015%/0.040%, with 0.05% adverse entry/exit slippage and observed funding. All comparisons hold fee and leverage equal. The source preset was checked against origin/main; deployment was not independently inspected.

## Data and registration

The inherited snapshot contained 45 certified hourly markets (25 A, 20 B), of which 43 have eligible launches under the inherited twelve-month rule. There are 188 rotating launch weeks with a complete fourteen-day reference horizon. All 139 inherited input bindings were checked, and quarterly selections recomputed exactly. Registration was committed before new data acquisition and simulation: preregistration commit hash a8a2403aa42665ca0761dc9f1654f3a61a00294f.

15-minute certification passed 43/45 pairs. Both 15-minute geometries were retained because at least 24 pairs passed. Certification required finalized, valid, continuous quarter-hour candles from five days before each pair’s first eligible launch through seven days after its last. Requests, raw responses and normalized bytes are retained with SHA-256 bindings. Aggregating the certified 15-minute prices to hourly OHLC produced 56 mismatched hours out of 1195864 overlapping hours against the frozen hourly snapshot; this descriptive audit did not change admission.

| Pair | Universe | Certified 15m | Rows | Reason if excluded |
|---|---|---:|---:|---|
| ETH | A | yes | 126752 | — |
| BTC | A | yes | 126752 | — |
| SOL | A | yes | 126752 | — |
| XRP | A | yes | 126752 | — |
| DOGE | A | yes | 126752 | — |
| AAVE | A | yes | 126752 | — |
| UNI | A | yes | 126752 | — |
| NEAR | A | yes | 126752 | — |
| BCH | A | yes | 126752 | — |
| ADA | A | yes | 126752 | — |
| BAT | B | yes | 126752 | — |
| FIL | B | yes | 126752 | — |
| FARTCOIN | A | yes | 21600 | — |
| BNB | A | yes | 91456 | — |
| SUI | A | yes | 73824 | — |
| LINK | A | yes | 126752 | — |
| WLFI | A | no | 0 | No eligible launch under inherited twelve-month rule |
| LTC | A | yes | 126752 | — |
| LDO | A | yes | 83008 | — |
| XPL | A | no | 0 | No eligible launch under inherited twelve-month rule |
| CRV | A | yes | 126752 | — |
| VIRTUAL | A | yes | 21600 | — |
| TRUMP | A | yes | 21600 | — |
| WLD | A | yes | 73824 | — |
| ICP | A | yes | 126752 | — |
| USELESS | A | yes | 3968 | — |
| ARB | A | yes | 83008 | — |
| ALGO | B | yes | 126752 | — |
| ATOM | B | yes | 126752 | — |
| CFX | B | yes | 126752 | — |
| CHZ | B | yes | 126752 | — |
| COMP | B | yes | 126752 | — |
| DOT | B | yes | 126752 | — |
| CRO | B | yes | 126752 | — |
| DYDX | B | yes | 126752 | — |
| ENS | B | yes | 126752 | — |
| ETC | B | yes | 126752 | — |
| GALA | B | yes | 126752 | — |
| IOTA | B | yes | 126752 | — |
| MANA | B | yes | 126752 | — |
| PEOPLE | B | yes | 126752 | — |
| SHIB | B | yes | 126752 | — |
| SUSHI | B | yes | 126752 | — |
| TRX | B | yes | 126752 | — |
| XLM | B | yes | 126752 | — |

## Primary results against raw Simple

Returns and differences are percentages and percentage points per bot horizon. Leveraged 1x and 3x strata receive equal weight within a week; weeks receive equal weight. The primary interval resamples one-week calendar blocks, and the second interval uses four-week blocks. Quarter wins count positive paired weekly averages in the inherited selection quarters. An identity row is a reference, not a discovery.

| Geometry / sizing / gate | Weeks | Candidate return % | Simple return % | Difference pp | 95% CI, 1 week | 95% CI, 4 weeks | Quarter wins | BH q | Verdict |
|---|---:|---:|---:|---:|---|---|---:|---:|---|
| D1M15 · Equal/Equal · G0 | 188 | -0.29 | -0.28 | -0.01 | [-0.28, 0.25] | [-0.28, 0.26] | 7/15 | 0.9905 | FAIL |
| D1M15 · Equal/Equal · G1 | 188 | -0.28 | -0.28 | -0.01 | [-0.27, 0.26] | [-0.29, 0.27] | 7/15 | 0.9905 | FAIL |
| D1M15 · Equal/Equal · G2 | 181 | -0.32 | -0.26 | -0.06 | [-0.36, 0.23] | [-0.38, 0.25] | 7/15 | 0.8550 | FAIL |
| D1M15 · Equal/Equal · G3 | 188 | -0.23 | -0.28 | 0.04 | [-0.30, 0.39] | [-0.30, 0.40] | 8/15 | 0.9498 | FAIL |
| D1M15 · Equal/Equal · G4 | 188 | -0.21 | -0.28 | 0.06 | [-0.28, 0.42] | [-0.31, 0.45] | 8/15 | 0.8847 | FAIL |
| D1M15 · Further/Near · G0 | 188 | -0.25 | -0.28 | 0.02 | [-0.24, 0.28] | [-0.24, 0.29] | 8/15 | 0.9677 | FAIL |
| D1M15 · Further/Near · G1 | 188 | -0.25 | -0.28 | 0.02 | [-0.24, 0.29] | [-0.25, 0.29] | 7/15 | 0.9646 | FAIL |
| D1M15 · Further/Near · G2 | 181 | -0.29 | -0.26 | -0.03 | [-0.31, 0.26] | [-0.33, 0.28] | 7/15 | 0.9677 | FAIL |
| D1M15 · Further/Near · G3 | 188 | -0.22 | -0.28 | 0.06 | [-0.25, 0.37] | [-0.25, 0.38] | 7/15 | 0.8789 | FAIL |
| D1M15 · Further/Near · G4 | 188 | -0.21 | -0.28 | 0.06 | [-0.25, 0.38] | [-0.27, 0.40] | 7/15 | 0.8587 | FAIL |
| D3M15 · Equal/Equal · G0 | 188 | -0.42 | -0.28 | -0.14 | [-0.37, 0.07] | [-0.37, 0.07] | 8/15 | 0.4733 | FAIL |
| D3M15 · Equal/Equal · G1 | 188 | -0.43 | -0.28 | -0.15 | [-0.39, 0.07] | [-0.39, 0.07] | 7/15 | 0.4733 | FAIL |
| D3M15 · Equal/Equal · G2 | 181 | -0.40 | -0.26 | -0.14 | [-0.42, 0.14] | [-0.44, 0.15] | 8/15 | 0.5387 | FAIL |
| D3M15 · Equal/Equal · G3 | 188 | -0.49 | -0.28 | -0.22 | [-0.61, 0.17] | [-0.59, 0.17] | 8/15 | 0.4947 | FAIL |
| D3M15 · Equal/Equal · G4 | 188 | -0.43 | -0.28 | -0.16 | [-0.55, 0.24] | [-0.56, 0.26] | 5/15 | 0.6273 | FAIL |
| D3M15 · Further/Near · G0 | 188 | -0.38 | -0.28 | -0.10 | [-0.33, 0.11] | [-0.33, 0.11] | 7/15 | 0.5536 | FAIL |
| D3M15 · Further/Near · G1 | 188 | -0.39 | -0.28 | -0.11 | [-0.34, 0.11] | [-0.34, 0.11] | 7/15 | 0.5363 | FAIL |
| D3M15 · Further/Near · G2 | 181 | -0.36 | -0.26 | -0.10 | [-0.36, 0.17] | [-0.37, 0.17] | 8/15 | 0.6701 | FAIL |
| D3M15 · Further/Near · G3 | 188 | -0.42 | -0.28 | -0.15 | [-0.47, 0.18] | [-0.47, 0.18] | 8/15 | 0.5772 | FAIL |
| D3M15 · Further/Near · G4 | 188 | -0.39 | -0.28 | -0.11 | [-0.45, 0.22] | [-0.45, 0.24] | 8/15 | 0.6994 | FAIL |
| D3H1 · Equal/Equal · G0 | 188 | -0.45 | -0.28 | -0.18 | [-0.40, 0.04] | [-0.40, 0.04] | 6/15 | 0.4733 | FAIL |
| D3H1 · Equal/Equal · G1 | 188 | -0.43 | -0.28 | -0.15 | [-0.39, 0.08] | [-0.40, 0.08] | 7/15 | 0.4733 | FAIL |
| D3H1 · Equal/Equal · G2 | 181 | -0.36 | -0.26 | -0.10 | [-0.39, 0.19] | [-0.40, 0.20] | 7/15 | 0.7064 | FAIL |
| D3H1 · Equal/Equal · G3 | 188 | -0.52 | -0.28 | -0.24 | [-0.66, 0.17] | [-0.63, 0.15] | 6/15 | 0.4834 | FAIL |
| D3H1 · Equal/Equal · G4 | 188 | -0.42 | -0.28 | -0.14 | [-0.58, 0.29] | [-0.57, 0.28] | 6/15 | 0.7050 | FAIL |
| D3H1 · Further/Near · G0 | 188 | -0.41 | -0.28 | -0.14 | [-0.36, 0.07] | [-0.36, 0.08] | 8/15 | 0.4733 | FAIL |
| D3H1 · Further/Near · G1 | 188 | -0.40 | -0.28 | -0.12 | [-0.35, 0.10] | [-0.36, 0.11] | 8/15 | 0.5065 | FAIL |
| D3H1 · Further/Near · G2 | 181 | -0.36 | -0.26 | -0.10 | [-0.37, 0.17] | [-0.38, 0.17] | 8/15 | 0.6680 | FAIL |
| D3H1 · Further/Near · G3 | 188 | -0.44 | -0.28 | -0.16 | [-0.51, 0.19] | [-0.50, 0.18] | 6/15 | 0.5589 | FAIL |
| D3H1 · Further/Near · G4 | 188 | -0.37 | -0.28 | -0.10 | [-0.46, 0.26] | [-0.46, 0.27] | 6/15 | 0.7771 | FAIL |
| D7H1 · Equal/Equal · G0 | 188 | -0.37 | -0.28 | -0.09 | [-0.14, -0.05] | [-0.15, -0.04] | 2/15 | 0.0148 | FAIL |
| D7H1 · Equal/Equal · G1 | 188 | -0.31 | -0.28 | -0.03 | [-0.15, 0.09] | [-0.17, 0.11] | 6/15 | 0.8105 | FAIL |
| D7H1 · Equal/Equal · G2 | 181 | -0.17 | -0.26 | 0.09 | [-0.22, 0.41] | [-0.25, 0.44] | 7/15 | 0.7706 | FAIL |
| D7H1 · Equal/Equal · G3 | 188 | -0.56 | -0.28 | -0.28 | [-0.72, 0.16] | [-0.68, 0.14] | 7/15 | 0.4733 | FAIL |
| D7H1 · Equal/Equal · G4 | 188 | -0.35 | -0.28 | -0.08 | [-0.56, 0.41] | [-0.55, 0.42] | 6/15 | 0.9092 | FAIL |
| D7H1 · Further/Near · G0 | 188 | -0.28 | -0.28 | 0.00 | [0.00, 0.00] | [0.00, 0.00] | 0/15 | — | reference |
| D7H1 · Further/Near · G1 | 188 | -0.22 | -0.28 | 0.06 | [-0.04, 0.16] | [-0.06, 0.17] | 9/15 | 0.5114 | FAIL |
| D7H1 · Further/Near · G2 | 181 | -0.07 | -0.26 | 0.19 | [-0.08, 0.48] | [-0.11, 0.51] | 9/15 | 0.4733 | FAIL |
| D7H1 · Further/Near · G3 | 188 | -0.39 | -0.28 | -0.11 | [-0.44, 0.22] | [-0.42, 0.20] | 7/15 | 0.6991 | FAIL |
| D7H1 · Further/Near · G4 | 188 | -0.23 | -0.28 | 0.04 | [-0.32, 0.40] | [-0.32, 0.41] | 7/15 | 0.9525 | FAIL |

## Downside and time underwater

Each candidate and reference below uses exactly the same matched weeks and leverage strata as its return comparison. The worst 5% is a weighted mean of the worst outcomes, retaining fractional boundary weight. Stops and liquidation rates are weighted; liquidation counts are unweighted derived bot rows, not independent events. Underwater days include stopped cash through the scheduled horizon, and the fraction makes different horizons easier to compare.

| Geometry / sizing / gate | Worst 5%, candidate / Simple % | Stop rate, candidate / Simple % | Liquidation count, candidate / Simple | Liquidation rate, candidate / Simple % | Underwater days, candidate / Simple | Underwater fraction, candidate / Simple % |
|---|---|---|---|---|---|---|
| D1M15 · Equal/Equal · G0 | -9.61 / -18.47 | 58.63 / 52.16 | 0 / 0 | 0.00 / 0.00 | 1.32 / 5.74 | 44.01 / 41.01 |
| D1M15 · Equal/Equal · G1 | -9.86 / -18.47 | 58.46 / 52.16 | 0 / 0 | 0.00 / 0.00 | 1.32 / 5.74 | 43.84 / 41.01 |
| D1M15 · Equal/Equal · G2 | -10.24 / -18.63 | 58.44 / 51.85 | 0 / 0 | 0.00 / 0.00 | 1.32 / 5.72 | 44.13 / 40.88 |
| D1M15 · Equal/Equal · G3 | -9.50 / -18.47 | 58.25 / 52.16 | 0 / 0 | 0.00 / 0.00 | 1.32 / 5.74 | 44.10 / 41.01 |
| D1M15 · Equal/Equal · G4 | -9.85 / -18.47 | 57.24 / 52.16 | 0 / 0 | 0.00 / 0.00 | 1.31 / 5.74 | 43.57 / 41.01 |
| D1M15 · Further/Near · G0 | -7.96 / -18.47 | 58.63 / 52.16 | 0 / 0 | 0.00 / 0.00 | 1.24 / 5.74 | 41.48 / 41.01 |
| D1M15 · Further/Near · G1 | -8.16 / -18.47 | 58.46 / 52.16 | 0 / 0 | 0.00 / 0.00 | 1.24 / 5.74 | 41.45 / 41.01 |
| D1M15 · Further/Near · G2 | -8.57 / -18.63 | 58.44 / 51.85 | 0 / 0 | 0.00 / 0.00 | 1.24 / 5.72 | 41.22 / 40.88 |
| D1M15 · Further/Near · G3 | -7.85 / -18.47 | 58.25 / 52.16 | 0 / 0 | 0.00 / 0.00 | 1.25 / 5.74 | 41.56 / 41.01 |
| D1M15 · Further/Near · G4 | -8.15 / -18.47 | 57.24 / 52.16 | 0 / 0 | 0.00 / 0.00 | 1.24 / 5.74 | 41.25 / 41.01 |
| D3M15 · Equal/Equal · G0 | -14.81 / -18.47 | 57.28 / 52.16 | 0 / 0 | 0.00 / 0.00 | 3.19 / 5.74 | 45.60 / 41.01 |
| D3M15 · Equal/Equal · G1 | -15.06 / -18.47 | 57.40 / 52.16 | 0 / 0 | 0.00 / 0.00 | 3.20 / 5.74 | 45.69 / 41.01 |
| D3M15 · Equal/Equal · G2 | -15.14 / -18.63 | 57.32 / 51.85 | 0 / 0 | 0.00 / 0.00 | 3.22 / 5.72 | 46.03 / 40.88 |
| D3M15 · Equal/Equal · G3 | -15.02 / -18.47 | 56.17 / 52.16 | 0 / 0 | 0.00 / 0.00 | 3.17 / 5.74 | 45.22 / 41.01 |
| D3M15 · Equal/Equal · G4 | -15.17 / -18.47 | 55.78 / 52.16 | 0 / 0 | 0.00 / 0.00 | 3.10 / 5.74 | 44.32 / 41.01 |
| D3M15 · Further/Near · G0 | -12.01 / -18.47 | 57.28 / 52.16 | 0 / 0 | 0.00 / 0.00 | 3.04 / 5.74 | 43.40 / 41.01 |
| D3M15 · Further/Near · G1 | -12.15 / -18.47 | 57.40 / 52.16 | 0 / 0 | 0.00 / 0.00 | 3.05 / 5.74 | 43.52 / 41.01 |
| D3M15 · Further/Near · G2 | -12.34 / -18.63 | 57.32 / 51.85 | 0 / 0 | 0.00 / 0.00 | 3.08 / 5.72 | 43.96 / 40.88 |
| D3M15 · Further/Near · G3 | -12.01 / -18.47 | 56.17 / 52.16 | 0 / 0 | 0.00 / 0.00 | 2.99 / 5.74 | 42.79 / 41.01 |
| D3M15 · Further/Near · G4 | -12.08 / -18.47 | 55.78 / 52.16 | 0 / 0 | 0.00 / 0.00 | 2.95 / 5.74 | 42.11 / 41.01 |
| D3H1 · Equal/Equal · G0 | -16.61 / -18.47 | 53.44 / 52.16 | 0 / 0 | 0.00 / 0.00 | 3.06 / 5.74 | 43.67 / 41.01 |
| D3H1 · Equal/Equal · G1 | -16.84 / -18.47 | 53.41 / 52.16 | 0 / 0 | 0.00 / 0.00 | 3.04 / 5.74 | 43.41 / 41.01 |
| D3H1 · Equal/Equal · G2 | -16.86 / -18.63 | 53.12 / 51.85 | 0 / 0 | 0.00 / 0.00 | 3.06 / 5.72 | 43.66 / 40.88 |
| D3H1 · Equal/Equal · G3 | -16.62 / -18.47 | 52.51 / 52.16 | 0 / 0 | 0.00 / 0.00 | 3.03 / 5.74 | 43.22 / 41.01 |
| D3H1 · Equal/Equal · G4 | -16.71 / -18.47 | 51.67 / 52.16 | 0 / 0 | 0.00 / 0.00 | 2.94 / 5.74 | 42.00 / 41.01 |
| D3H1 · Further/Near · G0 | -13.75 / -18.47 | 53.44 / 52.16 | 0 / 0 | 0.00 / 0.00 | 2.91 / 5.74 | 41.62 / 41.01 |
| D3H1 · Further/Near · G1 | -13.88 / -18.47 | 53.41 / 52.16 | 0 / 0 | 0.00 / 0.00 | 2.90 / 5.74 | 41.37 / 41.01 |
| D3H1 · Further/Near · G2 | -14.05 / -18.63 | 53.12 / 51.85 | 0 / 0 | 0.00 / 0.00 | 2.90 / 5.72 | 41.46 / 40.88 |
| D3H1 · Further/Near · G3 | -13.58 / -18.47 | 52.51 / 52.16 | 0 / 0 | 0.00 / 0.00 | 2.87 / 5.74 | 41.01 / 41.01 |
| D3H1 · Further/Near · G4 | -13.62 / -18.47 | 51.67 / 52.16 | 0 / 0 | 0.00 / 0.00 | 2.80 / 5.74 | 39.93 / 41.01 |
| D7H1 · Equal/Equal · G0 | -22.59 / -18.47 | 52.16 / 52.16 | 0 / 0 | 0.00 / 0.00 | 6.10 / 5.74 | 43.56 / 41.01 |
| D7H1 · Equal/Equal · G1 | -23.22 / -18.47 | 51.59 / 52.16 | 0 / 0 | 0.00 / 0.00 | 6.05 / 5.74 | 43.18 / 41.01 |
| D7H1 · Equal/Equal · G2 | -23.07 / -18.63 | 51.48 / 51.85 | 0 / 0 | 0.00 / 0.00 | 6.05 / 5.72 | 43.21 / 40.88 |
| D7H1 · Equal/Equal · G3 | -22.67 / -18.47 | 51.23 / 52.16 | 0 / 0 | 0.00 / 0.00 | 5.99 / 5.74 | 42.80 / 41.01 |
| D7H1 · Equal/Equal · G4 | -23.08 / -18.47 | 49.23 / 52.16 | 0 / 0 | 0.00 / 0.00 | 5.82 / 5.74 | 41.56 / 41.01 |
| D7H1 · Further/Near · G0 | -18.47 / -18.47 | 52.16 / 52.16 | 0 / 0 | 0.00 / 0.00 | 5.74 / 5.74 | 41.01 / 41.01 |
| D7H1 · Further/Near · G1 | -18.85 / -18.47 | 51.59 / 52.16 | 0 / 0 | 0.00 / 0.00 | 5.71 / 5.74 | 40.80 / 41.01 |
| D7H1 · Further/Near · G2 | -18.79 / -18.63 | 51.48 / 51.85 | 0 / 0 | 0.00 / 0.00 | 5.66 / 5.72 | 40.44 / 40.88 |
| D7H1 · Further/Near · G3 | -18.23 / -18.47 | 51.23 / 52.16 | 0 / 0 | 0.00 / 0.00 | 5.63 / 5.74 | 40.25 / 41.01 |
| D7H1 · Further/Near · G4 | -18.43 / -18.47 | 49.23 / 52.16 | 0 / 0 | 0.00 / 0.00 | 5.48 / 5.74 | 39.15 / 41.01 |

## Which requirement failed, including the advised baseline

Success requires a strictly positive primary pooled CI in A at zero builder fee, a strict majority of quarter wins, no worse worst-5% return or stop rate, and no wholly negative A+B interval. The advised comparison applies that rule independently.

| Geometry / sizing / gate | Raw Simple | Advised Simple | A+B raw 95% CI | A+B advised 95% CI |
|---|---|---|---|---|
| D1M15 · Equal/Equal · G0 | pooled CI not above zero; no majority of quarter wins; worse stop rate | pooled CI not above zero; no majority of quarter wins; worse stop rate | [-0.26, 0.24] | [-0.29, 0.23] |
| D1M15 · Equal/Equal · G1 | pooled CI not above zero; no majority of quarter wins; worse stop rate | pooled CI not above zero; no majority of quarter wins; worse stop rate | [-0.25, 0.25] | [-0.27, 0.24] |
| D1M15 · Equal/Equal · G2 | pooled CI not above zero; no majority of quarter wins; worse stop rate | pooled CI not above zero; worse stop rate | [-0.27, 0.25] | [-0.30, 0.23] |
| D1M15 · Equal/Equal · G3 | pooled CI not above zero; worse stop rate | pooled CI not above zero; worse stop rate | [-0.32, 0.34] | [-0.34, 0.32] |
| D1M15 · Equal/Equal · G4 | pooled CI not above zero; worse stop rate | pooled CI not above zero; worse stop rate | [-0.30, 0.35] | [-0.33, 0.34] |
| D1M15 · Further/Near · G0 | pooled CI not above zero; worse stop rate | pooled CI not above zero; no majority of quarter wins; worse stop rate | [-0.23, 0.26] | [-0.26, 0.25] |
| D1M15 · Further/Near · G1 | pooled CI not above zero; no majority of quarter wins; worse stop rate | pooled CI not above zero; no majority of quarter wins; worse stop rate | [-0.22, 0.27] | [-0.25, 0.26] |
| D1M15 · Further/Near · G2 | pooled CI not above zero; no majority of quarter wins; worse stop rate | pooled CI not above zero; no majority of quarter wins; worse stop rate | [-0.24, 0.26] | [-0.27, 0.24] |
| D1M15 · Further/Near · G3 | pooled CI not above zero; no majority of quarter wins; worse stop rate | pooled CI not above zero; worse stop rate | [-0.27, 0.32] | [-0.30, 0.30] |
| D1M15 · Further/Near · G4 | pooled CI not above zero; no majority of quarter wins; worse stop rate | pooled CI not above zero; worse stop rate | [-0.26, 0.33] | [-0.29, 0.31] |
| D3M15 · Equal/Equal · G0 | pooled CI not above zero; worse stop rate | pooled CI not above zero; no majority of quarter wins; worse stop rate | [-0.38, 0.06] | [-0.41, 0.05] |
| D3M15 · Equal/Equal · G1 | pooled CI not above zero; no majority of quarter wins; worse stop rate | pooled CI not above zero; no majority of quarter wins; worse stop rate | [-0.38, 0.06] | [-0.40, 0.04] |
| D3M15 · Equal/Equal · G2 | pooled CI not above zero; worse stop rate | pooled CI not above zero; no majority of quarter wins; worse stop rate | [-0.39, 0.07] | [-0.41, 0.05] |
| D3M15 · Equal/Equal · G3 | pooled CI not above zero; worse stop rate | pooled CI not above zero; no majority of quarter wins; worse stop rate | [-0.68, 0.11] | [-0.71, 0.10] |
| D3M15 · Equal/Equal · G4 | pooled CI not above zero; no majority of quarter wins; worse stop rate | pooled CI not above zero; no majority of quarter wins; worse stop rate | [-0.67, 0.12] | [-0.69, 0.11] |
| D3M15 · Further/Near · G0 | pooled CI not above zero; no majority of quarter wins; worse stop rate | pooled CI not above zero; no majority of quarter wins; worse stop rate | [-0.34, 0.10] | [-0.37, 0.09] |
| D3M15 · Further/Near · G1 | pooled CI not above zero; no majority of quarter wins; worse stop rate | pooled CI not above zero; no majority of quarter wins; worse stop rate | [-0.34, 0.10] | [-0.36, 0.08] |
| D3M15 · Further/Near · G2 | pooled CI not above zero; worse stop rate | pooled CI not above zero; no majority of quarter wins; worse stop rate | [-0.34, 0.11] | [-0.36, 0.08] |
| D3M15 · Further/Near · G3 | pooled CI not above zero; worse stop rate | pooled CI not above zero; no majority of quarter wins; worse stop rate | [-0.54, 0.12] | [-0.57, 0.11] |
| D3M15 · Further/Near · G4 | pooled CI not above zero; worse stop rate | pooled CI not above zero; worse stop rate | [-0.53, 0.14] | [-0.56, 0.12] |
| D3H1 · Equal/Equal · G0 | pooled CI not above zero; no majority of quarter wins; worse stop rate | pooled CI not above zero; no majority of quarter wins; worse stop rate | [-0.42, 0.02] | [-0.45, 0.01] |
| D3H1 · Equal/Equal · G1 | pooled CI not above zero; no majority of quarter wins; worse stop rate | pooled CI not above zero; no majority of quarter wins; worse stop rate | [-0.42, 0.03] | [-0.44, 0.02] |
| D3H1 · Equal/Equal · G2 | pooled CI not above zero; no majority of quarter wins; worse stop rate | pooled CI not above zero; worse stop rate | [-0.40, 0.11] | [-0.42, 0.08] |
| D3H1 · Equal/Equal · G3 | pooled CI not above zero; no majority of quarter wins; worse stop rate | pooled CI not above zero; no majority of quarter wins; worse stop rate | [-0.76, 0.10] | [-0.79, 0.08] |
| D3H1 · Equal/Equal · G4 | pooled CI not above zero; no majority of quarter wins | pooled CI not above zero; no majority of quarter wins; worse stop rate | [-0.75, 0.12] | [-0.77, 0.10] |
| D3H1 · Further/Near · G0 | pooled CI not above zero; worse stop rate | pooled CI not above zero; no majority of quarter wins; worse stop rate | [-0.37, 0.06] | [-0.40, 0.05] |
| D3H1 · Further/Near · G1 | pooled CI not above zero; worse stop rate | pooled CI not above zero; no majority of quarter wins; worse stop rate | [-0.37, 0.07] | [-0.39, 0.06] |
| D3H1 · Further/Near · G2 | pooled CI not above zero; worse stop rate | pooled CI not above zero; no majority of quarter wins; worse stop rate | [-0.35, 0.12] | [-0.37, 0.10] |
| D3H1 · Further/Near · G3 | pooled CI not above zero; no majority of quarter wins; worse stop rate | pooled CI not above zero; no majority of quarter wins; worse stop rate | [-0.60, 0.12] | [-0.63, 0.11] |
| D3H1 · Further/Near · G4 | pooled CI not above zero; no majority of quarter wins | pooled CI not above zero; no majority of quarter wins; worse stop rate | [-0.59, 0.13] | [-0.61, 0.12] |
| D7H1 · Equal/Equal · G0 | pooled CI not above zero; no majority of quarter wins; worse worst 5%; A+B contradiction or unavailable | pooled CI not above zero; no majority of quarter wins; worse worst 5%; worse stop rate; A+B contradiction or unavailable | [-0.14, -0.04] | [-0.18, -0.04] |
| D7H1 · Equal/Equal · G1 | pooled CI not above zero; no majority of quarter wins; worse worst 5% | pooled CI not above zero; no majority of quarter wins; worse worst 5%; A+B contradiction or unavailable | [-0.15, 0.02] | [-0.14, -0.03] |
| D7H1 · Equal/Equal · G2 | pooled CI not above zero; no majority of quarter wins; worse worst 5% | pooled CI not above zero; no majority of quarter wins; worse worst 5%; worse stop rate | [-0.25, 0.12] | [-0.25, 0.08] |
| D7H1 · Equal/Equal · G3 | pooled CI not above zero; no majority of quarter wins; worse worst 5% | pooled CI not above zero; no majority of quarter wins; worse worst 5% | [-0.82, 0.09] | [-0.84, 0.08] |
| D7H1 · Equal/Equal · G4 | pooled CI not above zero; no majority of quarter wins; worse worst 5% | pooled CI not above zero; no majority of quarter wins; worse worst 5% | [-0.81, 0.14] | [-0.82, 0.12] |
| D7H1 · Further/Near · G0 | reference | pooled CI not above zero; no majority of quarter wins; worse stop rate | [0.00, 0.00] | [-0.08, 0.03] |
| D7H1 · Further/Near · G1 | pooled CI not above zero; worse worst 5% | reference | [-0.03, 0.08] | [0.00, 0.00] |
| D7H1 · Further/Near · G2 | pooled CI not above zero; worse worst 5% | pooled CI not above zero; worse stop rate | [-0.11, 0.20] | [-0.12, 0.17] |
| D7H1 · Further/Near · G3 | pooled CI not above zero; no majority of quarter wins | pooled CI not above zero; no majority of quarter wins | [-0.52, 0.16] | [-0.54, 0.15] |
| D7H1 · Further/Near · G4 | pooled CI not above zero; no majority of quarter wins | pooled CI not above zero; no majority of quarter wins | [-0.50, 0.20] | [-0.52, 0.18] |

## Direct answer and robustness

A shorter-range grid did not establish an improvement under the complete registered rule. No gate and geometry combination passed the complete rule against raw Simple. Against advised Simple, none passed.

All 960 cells, including both universes, both builder fees, pooled/1x/3x leverage, and both baselines, are in [COMPARISONS.csv](COMPARISONS.csv). [QUARTERS.csv](QUARTERS.csv) gives every matched quarter. [RETENTION.csv](RETENTION.csv) gives available and retained rows, pairs and weeks. These files expose the secondary fee and leverage results without selecting a favorable subset.

There were 936 nonempty, nonidentity return comparisons and 1872 reported return-difference intervals across the one- and four-week block lengths. Benjamini–Hochberg q-values use the entire comparison family and centered two-sided bootstrap p-values. They are descriptive: overlapping arms, reused history and dependent contrasts mean this is not a new independent confirmation. The success rule uses the preregistered unadjusted interval; q-values do not silently replace it.

## Pairs most often selected

Counts are eligible pair-launch selections before geometry/order admission, not trade counts or a ranking by realized profit. G3/G4 count a pair once if either side passes. Full counts are in [PAIR-FREQUENCIES.csv](PAIR-FREQUENCIES.csv).

| Universe | Geometry | Gate | Most frequently selected pairs (launches) |
|---|---|---|---|
| A | D1M15 | G0 | AAVE (188), ADA (188), BCH (188), BTC (188), CRV (188) |
| A | D1M15 | G1 | ADA (149), UNI (147), XRP (147), BCH (146), ETH (144) |
| A | D1M15 | G2 | ICP (84), LTC (82), BCH (59), LDO (58), LINK (58) |
| A | D1M15 | G3 | AAVE (188), ADA (188), BCH (188), BTC (188), CRV (188) |
| A | D1M15 | G4 | ADA (149), UNI (147), XRP (147), BCH (146), ETH (144) |
| A | D3M15 | G0 | AAVE (188), ADA (188), BCH (188), BTC (188), CRV (188) |
| A | D3M15 | G1 | ADA (149), UNI (147), XRP (147), BCH (146), ETH (144) |
| A | D3M15 | G2 | ICP (84), LTC (82), BCH (59), LDO (58), LINK (58) |
| A | D3M15 | G3 | AAVE (188), ADA (188), BCH (188), BTC (188), CRV (188) |
| A | D3M15 | G4 | ADA (149), UNI (147), XRP (147), BCH (146), ETH (144) |
| A | D3H1 | G0 | AAVE (188), ADA (188), BCH (188), BTC (188), CRV (188) |
| A | D3H1 | G1 | ADA (149), UNI (147), XRP (147), BCH (146), ETH (144) |
| A | D3H1 | G2 | ICP (84), LTC (82), BCH (59), LDO (58), LINK (58) |
| A | D3H1 | G3 | AAVE (188), ADA (188), BCH (188), BTC (188), CRV (188) |
| A | D3H1 | G4 | ADA (149), UNI (147), XRP (147), BCH (146), ETH (144) |
| A | D7H1 | G0 | AAVE (188), ADA (188), BCH (188), BTC (188), CRV (188) |
| A | D7H1 | G1 | ADA (149), UNI (147), XRP (147), BCH (146), ETH (144) |
| A | D7H1 | G2 | ICP (84), LTC (82), BCH (59), LDO (58), LINK (58) |
| A | D7H1 | G3 | AAVE (188), ADA (188), BCH (188), BTC (188), CRV (188) |
| A | D7H1 | G4 | ADA (149), UNI (147), XRP (147), BCH (146), ETH (144) |
| A+B | D1M15 | G0 | AAVE (188), ADA (188), ALGO (188), ATOM (188), BAT (188) |
| A+B | D1M15 | G1 | XLM (150), ADA (149), BAT (148), CFX (148), COMP (148) |
| A+B | D1M15 | G2 | LTC (96), ICP (93), CFX (80), AAVE (77), TRX (77) |
| A+B | D1M15 | G3 | AAVE (188), ADA (188), ALGO (188), ATOM (188), BAT (188) |
| A+B | D1M15 | G4 | XLM (150), ADA (149), BAT (148), CFX (148), COMP (148) |
| A+B | D3M15 | G0 | AAVE (188), ADA (188), ALGO (188), ATOM (188), BAT (188) |
| A+B | D3M15 | G1 | XLM (150), ADA (149), BAT (148), CFX (148), COMP (148) |
| A+B | D3M15 | G2 | LTC (96), ICP (93), CFX (80), AAVE (77), TRX (77) |
| A+B | D3M15 | G3 | AAVE (188), ADA (188), ALGO (188), ATOM (188), BAT (188) |
| A+B | D3M15 | G4 | XLM (150), ADA (149), BAT (148), CFX (148), COMP (148) |
| A+B | D3H1 | G0 | AAVE (188), ADA (188), ALGO (188), ATOM (188), BAT (188) |
| A+B | D3H1 | G1 | XLM (150), ADA (149), BAT (148), CFX (148), COMP (148) |
| A+B | D3H1 | G2 | LTC (96), ICP (93), CFX (80), AAVE (77), TRX (77) |
| A+B | D3H1 | G3 | AAVE (188), ADA (188), ALGO (188), ATOM (188), BAT (188) |
| A+B | D3H1 | G4 | XLM (150), ADA (149), BAT (148), CFX (148), COMP (148) |
| A+B | D7H1 | G0 | AAVE (188), ADA (188), ALGO (188), ATOM (188), BAT (188) |
| A+B | D7H1 | G1 | XLM (150), ADA (149), BAT (148), CFX (148), COMP (148) |
| A+B | D7H1 | G2 | LTC (96), ICP (93), CFX (80), AAVE (77), TRX (77) |
| A+B | D7H1 | G3 | AAVE (188), ADA (188), ALGO (188), ATOM (188), BAT (188) |
| A+B | D7H1 | G4 | XLM (150), ADA (149), BAT (148), CFX (148), COMP (148) |

## New simulation tally

Only newly executed physical OHLC/OLHC paths count as simulations. Gates, universe views, pooled leverage, conservative path selection and bootstrap resamples reuse those paths and are not additional simulations. No inherited outcome is included in this tally.

| Geometry | Attempted new paths | Admitted new paths | Rejected new paths |
|---|---:|---:|---:|
| D1M15 | 226848 | 212996 | 13852 |
| D3M15 | 226848 | 222520 | 4328 |
| D3H1 | 226848 | 224332 | 2516 |
| D7H1 | 226848 | 223756 | 3092 |
| **Total** | **907392** | **883604** | **23788** |

441802 conservative derived bot outcomes were formed from paired physical paths. 1371 pair-launches were skipped before attempting geometry because of inherited quarterly eligibility. Fifteen-minute certification exclusions above are pre-simulation exclusions.

| Admission rejection reason | New physical paths |
|---|---:|
| Safety envelope is unavailable or below the execution bound | 11856 |
| Assumed round-trip cost is at least a cycle spread | 5760 |
| Stop must remain at least 1% on the safe side of projected liquidation, rounded to the market tick. | 3476 |
| Generated sizing policy is not canonical | 2696 |

## Interpretation limits

This changes range length, candle resolution, ATR stop geometry and bot horizon together. Per-bot returns do not measure annualized return, a capital-reuse strategy, or an isolated timeframe effect. Gates change selected directions and markets; comparisons condition on weeks where both candidate and reference admit at least one bot in the same leverage stratum. No-launch weeks are missing, not a modeled cash portfolio. Retention is therefore part of the result.

Prices are exchange proxies with ideal full fills, OHLC intrabar ambiguity, current-survivor selection and inherited current market constraints. The worse of two OHLC paths is a conservative convention, not a reconstruction of the actual trade sequence. Daily squeeze and ADX use only bars closed at launch; weekly trend uses 50 complete UTC weeks and the latest closed daily close. Incomplete signals reject the gate. Funding and the inherited liquidation model are retained; neither fills nor venue-specific liquidation behavior have been established for live deployment. No production code, configuration, database or trading was changed.

## Verification and delivery

The report is accompanied by REVIEW.md, focused FRACTAL receipts, input bindings, raw candle responses, per-market new path outputs and their SHA-256 bindings. Review is self-review, not an independent approval. See DELIVERY-MANIFEST.json for delivery commit and bundle hashes, and INSTALL-MTF.ps1 for installation without a push or merge. The original shared Git metadata is read-only in this job, so committed delivery is a thin bundle from a permitted scratch clone.
