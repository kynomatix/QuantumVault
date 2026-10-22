# Long-horizon ADX and launch squeeze

Choosing pairs that had trended less over six months and whose price bands were not unusually narrow at launch (P4) passed the fixed historical test in the primary pair set without builder fees. The broader pair set did not confirm P4, and this reused backtest does not establish future profits.

ADX is not the same as Bollinger squeeze here: the six-month ADX score measures directional strength, while bandwidth measures relative price dispersion; across 3329 primary pair/launch observations, Pearson correlation with bandwidth percentile was -0.0504 (Spearman -0.0459; correlation with the binary squeezed flag 0.0080).

## Fixed design and decision

P1 is the lowest third of three-month average daily ADX; P2 uses six months; P3 selects launches outside the lowest bandwidth quintile; P4 combines P2 and P3. Rankings are frozen every March/June/September/December; squeeze is measured afresh at each launch from fully closed days. The original twelve-month eligibility is retained. A is the primary 25-certified-pair current-Pacifica universe, A+B adds 20 certified proxy pairs; 43 ever qualify under the inherited eligibility rule. Missing history is excluded without replacement.

All settings and outcomes are inherited: one rotating launch per week, week/month range, ten intervals, step_back, seed on, shipped stop, USD 1,000, Equal/Equal + Further/Near + Further/Further, 1x/3x, 14/30 days and both directions. Maker/taker base fees 0.015%/0.040%; builder 0% primary, 0.10% secondary. Terminal taker exit plus 0.05% adverse slippage. The lower-return OHLC/OLHC path supplies all reported metrics. Returns are per-bot horizon returns, not annualized or portfolio returns.

Success requires a positive lower 95% bound against all pairs, a positive difference in a strict majority of evaluable selection quarters, and no worse matched worst-5% return or stop rate. Every condition is checked on A, zero builder, with settings and years pooled. Stop-rate changes are differences in weighted rates; tail comparisons use identical common-admission populations.

| Picker | Decision | Return difference pp [95% CI] | Four-week CI | Quarter wins | Worst 5% picker / all % | Stop difference pp |
|---|---|---|---|---|---|---|
| P1 | FAILED | -0.109 [-0.324, 0.109] | -0.109 [-0.375, 0.154] | 7/15 | -27.140 / -27.161 | 0.313 [-0.570, 1.228] |
| P2 | FAILED | 0.134 [-0.065, 0.327] | 0.134 [-0.083, 0.342] | 9/15 | -26.891 / -27.129 | 0.090 [-0.836, 1.009] |
| P3 | FAILED | 0.191 [0.062, 0.329] | 0.191 [0.056, 0.333] | 11/15 | -27.461 / -27.159 | -1.142 [-1.800, -0.540] |
| P4 | SUCCESS | 0.401 [0.100, 0.714] | 0.401 [0.101, 0.719] | 10/15 | -27.098 / -27.208 | -0.743 [-2.138, 0.599] |

**Broader-universe check:** P4 fails the same criteria in A+B at zero builder: 0.032 [-0.160, 0.231] pp, 7/15 positive quarters, worst 5% -28.147% versus -27.466%. The primary success therefore must not be presented as evidence of a general pair-selection improvement.

## Comparators, with settings and years pooled

All return differences are percentage points. Each contrast matches actual admitted configurations and weeks, so its cohort counts may differ from marginal summaries.

| Universe | Builder % | Contrast | Rows left / right | Weeks | Difference [95% CI] | Four-week sensitivity | Quarter wins |
|---|---:|---|---:|---:|---|---|---:|
| A | 0.000 | P1-all | 46218 / 150621 | 188 | -0.109 [-0.324, 0.109] | -0.109 [-0.375, 0.154] | 7/15 |
| A | 0.000 | P1-trending | 46188 / 46512 | 188 | -0.510 [-0.837, -0.190] | -0.510 [-0.907, -0.134] | 5/15 |
| A | 0.000 | P1-p1High | 46170 / 46629 | 188 | 0.052 [-0.283, 0.398] | 0.052 [-0.340, 0.454] | 8/15 |
| A | 0.000 | P1-p2High | 46164 / 46596 | 188 | -0.008 [-0.339, 0.328] | -0.008 [-0.430, 0.415] | 8/15 |
| A | 0.000 | P2-all | 46323 / 150681 | 188 | 0.134 [-0.065, 0.327] | 0.134 [-0.083, 0.342] | 9/15 |
| A | 0.000 | P2-trending | 46287 / 46530 | 188 | -0.266 [-0.575, 0.038] | -0.266 [-0.630, 0.084] | 6/15 |
| A | 0.000 | P2-p1High | 46269 / 46659 | 188 | 0.294 [-0.023, 0.605] | 0.294 [-0.037, 0.625] | 9/15 |
| A | 0.000 | P2-p2High | 46257 / 46620 | 188 | 0.227 [-0.081, 0.524] | 0.227 [-0.129, 0.573] | 10/15 |
| A | 0.000 | P3-all | 111933 / 150723 | 188 | 0.191 [0.062, 0.329] | 0.191 [0.056, 0.333] | 11/15 |
| A | 0.000 | P3-trending | 111837 / 46536 | 188 | -0.206 [-0.452, 0.040] | -0.206 [-0.493, 0.071] | 5/15 |
| A | 0.000 | P3-p1High | 111867 / 46671 | 188 | 0.354 [0.131, 0.579] | 0.354 [0.131, 0.580] | 12/15 |
| A | 0.000 | P3-p2High | 111849 / 46638 | 188 | 0.293 [0.059, 0.532] | 0.293 [-0.001, 0.586] | 11/15 |
| A | 0.000 | P4-all | 34209 / 144531 | 181 | 0.401 [0.100, 0.714] | 0.401 [0.101, 0.719] | 10/15 |
| A | 0.000 | P4-trending | 34173 / 44682 | 181 | -0.019 [-0.389, 0.364] | -0.019 [-0.446, 0.395] | 7/15 |
| A | 0.000 | P4-p1High | 34155 / 44787 | 181 | 0.570 [0.170, 0.970] | 0.570 [0.175, 0.967] | 10/15 |
| A | 0.000 | P4-p2High | 34143 / 44754 | 181 | 0.506 [0.106, 0.906] | 0.506 [0.088, 0.923] | 11/15 |
| A | 0.000 | P3-squeezed | 71472 / 38790 | 134 | 0.450 [0.055, 0.855] | 0.450 [0.014, 0.876] | 11/15 |
| A | 0.100 | P1-all | 46200 / 150522 | 188 | -0.104 [-0.318, 0.112] | -0.104 [-0.366, 0.154] | 7/15 |
| A | 0.100 | P1-trending | 46170 / 46482 | 188 | -0.502 [-0.827, -0.185] | -0.502 [-0.895, -0.132] | 5/15 |
| A | 0.100 | P1-p1High | 46152 / 46602 | 188 | 0.064 [-0.270, 0.409] | 0.064 [-0.319, 0.457] | 8/15 |
| A | 0.100 | P1-p2High | 46146 / 46569 | 188 | 0.002 [-0.327, 0.333] | 0.002 [-0.410, 0.418] | 8/15 |
| A | 0.100 | P2-all | 46287 / 150582 | 188 | 0.135 [-0.064, 0.328] | 0.135 [-0.077, 0.340] | 8/15 |
| A | 0.100 | P2-trending | 46251 / 46500 | 188 | -0.263 [-0.571, 0.039] | -0.263 [-0.621, 0.084] | 6/15 |
| A | 0.100 | P2-p1High | 46233 / 46632 | 188 | 0.302 [-0.016, 0.612] | 0.302 [-0.024, 0.624] | 9/15 |
| A | 0.100 | P2-p2High | 46221 / 46593 | 188 | 0.233 [-0.078, 0.533] | 0.233 [-0.121, 0.578] | 10/15 |
| A | 0.100 | P3-all | 111846 / 150624 | 188 | 0.199 [0.067, 0.340] | 0.199 [0.060, 0.347] | 11/15 |
| A | 0.100 | P3-trending | 111750 / 46506 | 188 | -0.195 [-0.441, 0.052] | -0.195 [-0.486, 0.085] | 6/15 |
| A | 0.100 | P3-p1High | 111780 / 46644 | 188 | 0.369 [0.144, 0.601] | 0.369 [0.146, 0.594] | 12/15 |
| A | 0.100 | P3-p2High | 111762 / 46611 | 188 | 0.307 [0.067, 0.548] | 0.307 [0.009, 0.601] | 11/15 |
| A | 0.100 | P4-all | 34179 / 144432 | 181 | 0.414 [0.109, 0.733] | 0.414 [0.111, 0.737] | 10/15 |
| A | 0.100 | P4-trending | 34143 / 44652 | 181 | -0.003 [-0.379, 0.381] | -0.003 [-0.429, 0.416] | 7/15 |
| A | 0.100 | P4-p1High | 34125 / 44760 | 181 | 0.589 [0.187, 0.993] | 0.589 [0.198, 0.987] | 11/15 |
| A | 0.100 | P4-p2High | 34113 / 44727 | 181 | 0.525 [0.116, 0.932] | 0.525 [0.107, 0.948] | 11/15 |
| A | 0.100 | P3-squeezed | 71424 / 38778 | 134 | 0.474 [0.076, 0.883] | 0.474 [0.034, 0.902] | 11/15 |
| A+B | 0.000 | P1-all | 105705 / 322544 | 188 | -0.095 [-0.239, 0.047] | -0.095 [-0.257, 0.070] | 6/15 |
| A+B | 0.000 | P1-trending | 105681 / 106057 | 188 | -0.340 [-0.595, -0.094] | -0.340 [-0.653, -0.041] | 5/15 |
| A+B | 0.000 | P1-p1High | 105693 / 106297 | 188 | -0.077 [-0.316, 0.163] | -0.077 [-0.357, 0.212] | 6/15 |
| A+B | 0.000 | P1-p2High | 105693 / 106177 | 188 | -0.103 [-0.330, 0.123] | -0.103 [-0.376, 0.172] | 4/15 |
| A+B | 0.000 | P2-all | 105912 / 322544 | 188 | -0.085 [-0.215, 0.045] | -0.085 [-0.239, 0.062] | 7/15 |
| A+B | 0.000 | P2-trending | 105894 / 106057 | 188 | -0.332 [-0.550, -0.120] | -0.332 [-0.614, -0.068] | 4/15 |
| A+B | 0.000 | P2-p1High | 105894 / 106297 | 188 | -0.068 [-0.288, 0.153] | -0.068 [-0.316, 0.186] | 5/15 |
| A+B | 0.000 | P2-p2High | 105894 / 106177 | 188 | -0.094 [-0.322, 0.132] | -0.094 [-0.356, 0.175] | 5/15 |
| A+B | 0.000 | P3-all | 240722 / 322544 | 188 | 0.092 [0.007, 0.182] | 0.092 [-0.009, 0.200] | 11/15 |
| A+B | 0.000 | P3-trending | 240668 / 106057 | 188 | -0.153 [-0.337, 0.028] | -0.153 [-0.372, 0.061] | 6/15 |
| A+B | 0.000 | P3-p1High | 240704 / 106297 | 188 | 0.110 [-0.037, 0.265] | 0.110 [-0.073, 0.297] | 9/15 |
| A+B | 0.000 | P3-p2High | 240704 / 106177 | 188 | 0.084 [-0.076, 0.241] | 0.084 [-0.107, 0.280] | 8/15 |
| A+B | 0.000 | P4-all | 78516 / 322544 | 188 | 0.032 [-0.160, 0.231] | 0.032 [-0.185, 0.261] | 7/15 |
| A+B | 0.000 | P4-trending | 78498 / 106057 | 188 | -0.215 [-0.479, 0.044] | -0.215 [-0.554, 0.111] | 6/15 |
| A+B | 0.000 | P4-p1High | 78504 / 106297 | 188 | 0.050 [-0.209, 0.316] | 0.050 [-0.243, 0.352] | 6/15 |
| A+B | 0.000 | P4-p2High | 78504 / 106177 | 188 | 0.024 [-0.255, 0.307] | 0.024 [-0.292, 0.347] | 6/15 |
| A+B | 0.000 | P3-squeezed | 183862 / 81822 | 154 | 0.305 [0.006, 0.610] | 0.305 [-0.043, 0.645] | 11/15 |
| A+B | 0.100 | P1-all | 105651 / 322343 | 188 | -0.088 [-0.231, 0.052] | -0.088 [-0.247, 0.074] | 6/15 |
| A+B | 0.100 | P1-trending | 105627 / 105997 | 188 | -0.335 [-0.590, -0.091] | -0.335 [-0.645, -0.036] | 5/15 |
| A+B | 0.100 | P1-p1High | 105639 / 106204 | 188 | -0.065 [-0.303, 0.174] | -0.065 [-0.341, 0.220] | 6/15 |
| A+B | 0.100 | P1-p2High | 105639 / 106096 | 188 | -0.092 [-0.316, 0.131] | -0.092 [-0.360, 0.177] | 4/15 |
| A+B | 0.100 | P2-all | 105846 / 322343 | 188 | -0.079 [-0.207, 0.051] | -0.079 [-0.231, 0.069] | 7/15 |
| A+B | 0.100 | P2-trending | 105828 / 105997 | 188 | -0.327 [-0.544, -0.116] | -0.327 [-0.608, -0.063] | 4/15 |
| A+B | 0.100 | P2-p1High | 105828 / 106204 | 188 | -0.056 [-0.275, 0.164] | -0.056 [-0.302, 0.195] | 6/15 |
| A+B | 0.100 | P2-p2High | 105828 / 106096 | 188 | -0.083 [-0.312, 0.143] | -0.083 [-0.342, 0.181] | 7/15 |
| A+B | 0.100 | P3-all | 240557 / 322343 | 188 | 0.100 [0.014, 0.191] | 0.100 [-0.002, 0.210] | 11/15 |
| A+B | 0.100 | P3-trending | 240503 / 105997 | 188 | -0.147 [-0.333, 0.036] | -0.147 [-0.368, 0.068] | 6/15 |
| A+B | 0.100 | P3-p1High | 240539 / 106204 | 188 | 0.123 [-0.025, 0.279] | 0.123 [-0.060, 0.309] | 8/15 |
| A+B | 0.100 | P3-p2High | 240539 / 106096 | 188 | 0.095 [-0.065, 0.253] | 0.095 [-0.095, 0.292] | 8/15 |
| A+B | 0.100 | P4-all | 78462 / 322343 | 188 | 0.049 [-0.146, 0.251] | 0.049 [-0.172, 0.287] | 7/15 |
| A+B | 0.100 | P4-trending | 78444 / 105997 | 188 | -0.199 [-0.468, 0.062] | -0.199 [-0.540, 0.132] | 6/15 |
| A+B | 0.100 | P4-p1High | 78450 / 106204 | 188 | 0.071 [-0.193, 0.343] | 0.071 [-0.223, 0.377] | 6/15 |
| A+B | 0.100 | P4-p2High | 78450 / 106096 | 188 | 0.044 [-0.239, 0.331] | 0.044 [-0.273, 0.372] | 6/15 |
| A+B | 0.100 | P3-squeezed | 183733 / 81786 | 154 | 0.327 [0.027, 0.634] | 0.327 [-0.021, 0.666] | 11/15 |

## Primary marginal outcomes

| Group | Rows | Mean return % [95% CI] | Worst 5% % | Stop % [95% CI] | Mean drawdown % [95% CI] | Worst drawdown % | Liquidations |
|---|---:|---|---:|---|---|---:|---:|
| P1 | 46218 | -0.474 [-0.821, -0.130] | -27.140 | 48.271 [46.240, 50.305] | 8.728 [8.437, 9.038] | 69.131 | 0 |
| P2 | 46323 | -0.223 [-0.553, 0.107] | -26.891 | 48.010 [45.981, 49.991] | 8.892 [8.601, 9.199] | 74.285 | 0 |
| P3 | 111933 | -0.171 [-0.488, 0.149] | -27.461 | 46.783 [44.937, 48.612] | 9.134 [8.874, 9.411] | 74.285 | 0 |
| P4 | 34209 | 0.060 [-0.346, 0.485] | -27.098 | 46.829 [44.514, 49.103] | 9.224 [8.920, 9.533] | 74.285 | 0 |
| all | 150723 | -0.362 [-0.651, -0.075] | -27.159 | 47.925 [46.097, 49.733] | 8.855 [8.580, 9.139] | 74.285 | 0 |
| trending | 46536 | 0.037 [-0.308, 0.380] | -25.744 | 47.061 [45.031, 49.065] | 8.746 [8.464, 9.030] | 63.912 | 0 |
| p1High | 46671 | -0.529 [-0.867, -0.191] | -27.688 | 48.526 [46.616, 50.435] | 8.757 [8.471, 9.050] | 73.377 | 0 |
| p2High | 46638 | -0.469 [-0.824, -0.117] | -26.980 | 48.172 [46.055, 50.286] | 8.729 [8.403, 9.066] | 73.377 | 0 |
| squeezed | 38790 | -0.784 [-1.162, -0.399] | -23.657 | 52.818 [50.494, 55.210] | 7.464 [7.123, 7.826] | 57.185 | 0 |

## Primary quarter differences

Selection-quarter start dates, not civil January/April/July/October quarters; the last is partial.

| Selection quarter | P1 minus all pp | P2 minus all pp | P3 minus all pp | P4 minus all pp |
|---|---:|---:|---:|---:|
| 2023-03-01 | -0.078 | 0.195 | 0.256 | 0.219 |
| 2023-06-01 | -1.061 | 0.010 | -0.452 | -0.073 |
| 2023-09-01 | 0.189 | 0.660 | 0.045 | 0.784 |
| 2023-12-01 | -0.514 | 0.196 | -0.011 | 0.190 |
| 2024-03-01 | -0.594 | -0.177 | -0.050 | -0.202 |
| 2024-06-01 | 1.021 | 0.344 | 0.049 | 0.847 |
| 2024-09-01 | 0.270 | 0.165 | 0.251 | 0.165 |
| 2024-12-01 | -0.884 | -0.287 | 0.512 | 0.015 |
| 2025-03-01 | 0.381 | 0.759 | 0.300 | 1.037 |
| 2025-06-01 | -0.248 | -0.223 | 0.472 | -0.146 |
| 2025-09-01 | -0.361 | -0.434 | -0.010 | -0.462 |
| 2025-12-01 | 0.088 | -0.068 | 0.513 | 0.366 |
| 2026-03-01 | 0.472 | 0.554 | 0.637 | 1.745 |
| 2026-06-01 | 0.034 | 0.257 | 0.277 | 1.387 |
| 2026-09-01 | -0.994 | -0.251 | 0.056 | -0.306 |

## Pairs selected most often

Frequencies count unique eligible pair/launch opportunities before execution rejection; settings and horizons do not multiply them. Quarterly counts apply to P1/P2; P3/P4 are launch-dependent. Complete frequencies and every selection are in the evidence files.

| Universe | Picker | Ten most frequent pairs (launches; quarterly choices where applicable) |
|---|---|---|
| A | P1 | LTC 104 (8 quarters), ICP 83 (7 quarters), BCH 78 (6 quarters), LINK 77 (6 quarters), BNB 69 (6 quarters), UNI 67 (5 quarters), AAVE 66 (5 quarters), SOL 58 (5 quarters), NEAR 57 (5 quarters), LDO 53 (4 quarters) |
| A | P2 | LTC 118 (9 quarters), ICP 109 (9 quarters), BCH 79 (6 quarters), LDO 79 (6 quarters), UNI 77 (6 quarters), LINK 73 (6 quarters), XRP 71 (6 quarters), AAVE 66 (5 quarters), NEAR 66 (5 quarters), BNB 64 (5 quarters) |
| A | P3 | ADA 149, UNI 147, XRP 147, BCH 146, ETH 144, ICP 144, SOL 144, BTC 143, AAVE 141, NEAR 141 |
| A | P4 | ICP 84, LTC 82, BCH 59, LDO 58, LINK 58, AAVE 57, XRP 55, UNI 53, NEAR 51, BNB 48 |
| A+B | P1 | LTC 117 (9 quarters), CFX 108 (9 quarters), BCH 92 (7 quarters), LINK 91 (7 quarters), ICP 83 (7 quarters), FIL 82 (7 quarters), AAVE 80 (6 quarters), XRP 79 (6 quarters), PEOPLE 78 (6 quarters), TRX 78 (6 quarters) |
| A+B | P2 | LTC 145 (11 quarters), ICP 122 (10 quarters), CFX 96 (8 quarters), FIL 95 (8 quarters), AAVE 93 (7 quarters), TRX 91 (7 quarters), NEAR 90 (7 quarters), ENS 85 (7 quarters), XRP 84 (7 quarters), BCH 79 (6 quarters) |
| A+B | P3 | XLM 150, ADA 149, BAT 148, CFX 148, COMP 148, ALGO 147, DOT 147, FIL 147, IOTA 147, UNI 147 |
| A+B | P4 | LTC 96, ICP 93, CFX 80, AAVE 77, TRX 77, FIL 70, BAT 68, NEAR 67, ENS 60, XRP 60 |

## Coverage, tally and rejection reasons

**New ADMITTED simulations: 0.** All 1,289,774 admitted physical paths are reused; 644,887 conservative rows are derived, not additional simulations. Original attempts 1,352,832; original rejections 63,058; ineligible pair/calendar horizons 2738. No new replay was launched.

| Original execution rejection reason | Physical paths |
|---|---:|
| Stop must remain at least 1% on the safe side of projected liquidation, rounded to the market tick. | 60186 |
| Safety envelope is unavailable or below the execution bound | 1248 |
| Investment cannot fund every enabled line at the venue lot size | 40 |
| Generated sizing policy is not canonical | 1536 |
| Assumed round-trip cost is at least a cycle spread | 48 |

| Signal exclusion | Pair/launch opportunities |
|---|---:|
| None | 0 |

Missing ADX score entries across universe/quarter selections: P1 0, P2 0. Signal exclusions are not failed simulations, and A overlaps A+B.

## Statistics and limitations

There are four picker hypotheses, 17 contrast definitions, 720 crossed summary cells, 12240 evaluable contrasts and 262080 metric/block confidence intervals. LONG-ADX-ALL-CELLS.csv contains all inherited fee/leverage/sizing/range/year crossings and both blocks; exact JSON includes matched tail metrics and quarter outcomes. There is no multiplicity adjustment, no threshold search and no new holdout.

The inherited estimators weight configurations/directions within pair, pairs equally within group, and calendar weeks equally. They use 10,000 synchronized block-bootstrap draws, seed 20261021, with one-week primary and four-week circular sensitivity and intervening empty weeks retained. The inherited analysis-core file remains unchanged; the analysis shares resamples across linear group differences, verified against the original on FRACTAL and the retained original-calculation cells. Floating-point differences below 1e-12 do not affect reported precision. The worst 5% uses fractional mass with equal week/pair weights. Adjacent overlapping horizons remain a limitation of the one-week primary interval.

Current-survivor markets omit delisted pairs; present-day liquidity and trading constraints introduce survivorship bias. External trade candles proxy marks, and complete historical fills are optimistic. The same historical periods have already appeared in earlier research. A lower ADX average is a directional-strength description, not proof that price stayed inside a tradable band. No production behavior, default, token literal, database or package changed.

A+B correlation: Pearson -0.0306, Spearman -0.0296, 7089 observations. These repeated pair/week observations are descriptive; no independence-based correlation significance claim is made.

## Verification and delivery

Evidence root: C:/Apps/Replit/conductor-worktrees/grid-long-adx-20261022-handback/evidence/study-20261022T023833592Z. See REVIEW.md for focused FRACTAL receipt, static review, source bindings and scan status. The bundle installer targets only the dispatched research branch. No push, merge, independent review or conductor seal is claimed.
