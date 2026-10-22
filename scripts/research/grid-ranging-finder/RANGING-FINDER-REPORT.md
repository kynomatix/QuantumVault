# Ranging finder research

None of the five new filters reliably found markets where this grid bot did better than both today's finder and taking every eligible opportunity. Keep the tool, but call it **“Show weaker-trend markets”** until a genuinely new period of data demonstrates a better ranking.

## Decision

**No replacement ranking passes.** This is not evidence that a low variance ratio or low Hurst estimate cannot describe mean reversion; it is evidence that the tested launch-time criteria did not establish better grid outcomes under the registered rule. The current finder itself has no reliable advantage over ALL: primary matched difference 0.16 percentage points, one-week 95% CI [-0.15, 0.49]. ADX measures trend strength, so “weaker-trend” is more accurate than either “ranging” or “calmer.” This handback changes research files only; it does not rename the live button.

| Arm | Criterion | Registered failure against M0 | Registered failure against ALL |
| --- | --- | --- | --- |
| M1 | Significance-adjusted variance ratio | pooled CI not above zero; no majority of quarter wins; worse stop rate | pooled CI not above zero; worse stop rate |
| M2 | DFA persistence | pooled CI not above zero; no majority of quarter wins; worse stop rate | pooled CI not above zero; no majority of quarter wins; worse stop rate |
| M3 | Completed edge rejections | pooled CI not above zero; no majority of quarter wins; worse stop rate | pooled CI not above zero |
| M4 | Travel / spacing / stop distance | pooled CI not above zero; no majority of quarter wins; worse stop rate | pooled CI not above zero; no majority of quarter wins; worse stop rate |
| M5 | Equal percentile-rank blend | pooled CI not above zero; no majority of quarter wins; worse stop rate | pooled CI not above zero; worse stop rate; A+B contradiction or unavailable |

## Primary matched comparisons

Universe A is the frozen Pacifica-listed set. All numbers below use zero builder fee and equal-weight pooled 1x/3x leverage; return differences and CI endpoints are percentage points of initial margin over fourteen days. Each row matches calendar weeks and leverage strata, not identical symbols. Quarter counts can differ because no-selection weeks are absent, never zero-return cash allocations.

| Arm / baseline | Difference pp | 1-week 95% CI pp | 4-week 95% CI pp | Quarter wins | Matched weeks | BH q |
| --- | --- | --- | --- | --- | --- | --- |
| M0 / ALL | 0.16 | [-0.15, 0.49] | [-0.12, 0.46] | 11/15 | 163 | 0.68 |
| M1 / M0 | -0.49 | [-1.52, 0.49] | [-1.27, 0.50] | 3/6 | 7 | 0.68 |
| M1 / ALL | 0.06 | [-0.92, 0.96] | [-0.67, 0.98] | 4/6 | 7 | 0.96 |
| M2 / M0 | -0.47 | [-0.95, 0.01] | [-0.98, 0.03] | 4/15 | 137 | 0.27 |
| M2 / ALL | -0.29 | [-0.56, -0.01] | [-0.58, -0.00] | 6/15 | 157 | 0.25 |
| M3 / M0 | -0.14 | [-0.52, 0.24] | [-0.51, 0.22] | 4/15 | 163 | 0.76 |
| M3 / ALL | 0.04 | [-0.16, 0.26] | [-0.16, 0.25] | 8/15 | 184 | 0.86 |
| M4 / M0 | -0.44 | [-0.81, -0.08] | [-0.78, -0.12] | 2/15 | 163 | 0.22 |
| M4 / ALL | -0.21 | [-0.42, -0.01] | [-0.42, -0.01] | 4/15 | 184 | 0.25 |
| M5 / M0 | -0.21 | [-0.61, 0.17] | [-0.58, 0.15] | 4/15 | 163 | 0.68 |
| M5 / ALL | -0.05 | [-0.26, 0.16] | [-0.24, 0.14] | 8/15 | 184 | 0.83 |

| Arm / baseline | Worst 5% return %, arm / baseline | Stop %, arm / baseline | Liquidation %, arm / baseline | Underwater days, arm / baseline |
| --- | --- | --- | --- | --- |
| M0 / ALL | -19.92 / -18.54 | 51.62 / 51.34 | 0.00 / 0.00 | 5.58 / 5.67 |
| M1 / M0 | -7.23 / -15.31 | 64.29 / 53.04 | 0.00 / 0.00 | 6.28 / 5.65 |
| M1 / ALL | -7.23 / -15.20 | 64.29 / 55.52 | 0.00 / 0.00 | 6.28 / 6.04 |
| M2 / M0 | -18.62 / -19.54 | 53.34 / 52.05 | 0.00 / 0.00 | 5.85 / 5.59 |
| M2 / ALL | -18.41 / -18.43 | 52.67 / 51.29 | 0.00 / 0.00 | 5.86 / 5.74 |
| M3 / M0 | -18.37 / -19.92 | 51.82 / 51.62 | 0.00 / 0.00 | 5.61 / 5.58 |
| M3 / ALL | -18.51 / -18.68 | 50.88 / 50.95 | 0.00 / 0.00 | 5.61 / 5.71 |
| M4 / M0 | -14.38 / -19.92 | 57.35 / 51.62 | 0.00 / 0.00 | 5.99 / 5.58 |
| M4 / ALL | -14.40 / -18.68 | 56.30 / 50.95 | 0.00 / 0.00 | 5.98 / 5.71 |
| M5 / M0 | -17.13 / -19.92 | 54.20 / 51.62 | 0.00 / 0.00 | 5.79 / 5.58 |
| M5 / ALL | -17.40 / -18.68 | 53.28 / 50.95 | 0.00 / 0.00 | 5.80 / 5.71 |

## Absolute outcomes and selection coverage

These rows use each arm's own available weeks, so they are descriptive, not substitutes for the matched contrasts. Rows are direction-specific conservative outcomes, not fresh simulations. Weighted tail means are the average worst 5% of outcomes; all rates and averages give equal weight to weeks, then leverage strata and pairs. Liquidation counts are unweighted counts of reused conservative rows selected by that arm.

| Universe | Arm | Selected pair-launches | Empty weeks / 188 | Unfilled quota slots | Admitted rows | Net return % | Worst 5% % | Stop % | Liquidation % (count) | Underwater days / % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | ALL | 2504 | 0 | 0 | 9672 | -0.23 | -18.56 | 51.33 | 0.00 (0) | 5.69 / 40.62 |
| A | M0 | 574 | 25 | 197 | 2232 | -0.03 | -19.92 | 51.62 | 0.00 (0) | 5.58 / 39.86 |
| A | M1 | 8 | 181 | 763 | 32 | -0.04 | -7.23 | 64.29 | 0.00 (0) | 6.28 / 44.88 |
| A | M2 | 558 | 31 | 213 | 2166 | -0.52 | -18.41 | 52.67 | 0.00 (0) | 5.86 / 41.89 |
| A | M3 | 771 | 4 | 0 | 2964 | -0.20 | -18.51 | 50.88 | 0.00 (0) | 5.61 / 40.10 |
| A | M4 | 771 | 4 | 0 | 3062 | -0.45 | -14.40 | 56.30 | 0.00 (0) | 5.98 / 42.72 |
| A | M5 | 771 | 4 | 0 | 3022 | -0.29 | -17.40 | 53.28 | 0.00 (0) | 5.80 / 41.39 |
| A+B | ALL | 5351 | 0 | 0 | 20758 | -0.22 | -18.78 | 50.71 | 0.00 (0) | 5.64 / 40.30 |
| A+B | M0 | 1287 | 11 | 440 | 5006 | -0.15 | -19.10 | 51.38 | 0.00 (0) | 5.67 / 40.48 |
| A+B | M1 | 23 | 170 | 1704 | 88 | -0.21 | -12.25 | 63.24 | 0.00 (0) | 6.39 / 45.65 |
| A+B | M2 | 1314 | 13 | 413 | 5112 | -0.36 | -18.48 | 51.74 | 0.00 (0) | 5.68 / 40.61 |
| A+B | M3 | 1727 | 0 | 0 | 6702 | -0.29 | -19.20 | 50.73 | 0.00 (0) | 5.60 / 39.99 |
| A+B | M4 | 1727 | 0 | 0 | 6852 | -0.23 | -14.26 | 56.60 | 0.00 (0) | 5.80 / 41.44 |
| A+B | M5 | 1727 | 0 | 0 | 6806 | -0.39 | -17.34 | 54.35 | 0.00 (0) | 5.78 / 41.29 |

## Leverage and broader-universe checks

All eleven contrasts are shown for each leverage and universe in COMPARISONS.csv. Below are the candidate-versus-ALL effects; M0 comparisons and matched risk metrics remain in that CSV and the bound contrasts evidence. A+B is a secondary frozen 45-market universe, not an independent sample. “Not contradicted” was preregistered as the broad upper CI being nonnegative against both comparators; it does not establish replication.

| Universe | Leverage | Arm | Difference pp | 1-week 95% CI pp | 4-week 95% CI pp | Quarter wins |
| --- | --- | --- | --- | --- | --- | --- |
| A | 1 | M1 | 0.01 | [-0.50, 0.50] | [-0.37, 0.51] | 3/6 |
| A | 1 | M2 | -0.16 | [-0.30, -0.03] | [-0.31, -0.02] | 5/15 |
| A | 1 | M3 | 0.01 | [-0.10, 0.12] | [-0.10, 0.12] | 6/15 |
| A | 1 | M4 | -0.12 | [-0.23, -0.02] | [-0.23, -0.01] | 4/15 |
| A | 1 | M5 | -0.05 | [-0.15, 0.06] | [-0.15, 0.05] | 8/15 |
| A | 3 | M1 | 0.10 | [-1.37, 1.41] | [-1.01, 1.45] | 4/6 |
| A | 3 | M2 | -0.42 | [-0.84, 0.00] | [-0.86, 0.02] | 6/15 |
| A | 3 | M3 | 0.08 | [-0.23, 0.40] | [-0.24, 0.40] | 8/15 |
| A | 3 | M4 | -0.30 | [-0.60, -0.00] | [-0.61, 0.00] | 5/15 |
| A | 3 | M5 | -0.05 | [-0.37, 0.26] | [-0.34, 0.23] | 9/15 |
| A+B | pooled | M1 | -0.06 | [-0.75, 0.65] | [-0.76, 0.57] | 5/10 |
| A+B | pooled | M2 | -0.15 | [-0.38, 0.10] | [-0.36, 0.07] | 4/15 |
| A+B | pooled | M3 | -0.07 | [-0.20, 0.07] | [-0.20, 0.07] | 6/15 |
| A+B | pooled | M4 | -0.01 | [-0.15, 0.13] | [-0.17, 0.14] | 8/15 |
| A+B | pooled | M5 | -0.17 | [-0.31, -0.03] | [-0.34, -0.02] | 6/15 |
| A+B | 1 | M1 | -0.09 | [-0.45, 0.26] | [-0.47, 0.23] | 5/10 |
| A+B | 1 | M2 | -0.06 | [-0.19, 0.09] | [-0.18, 0.07] | 4/15 |
| A+B | 1 | M3 | -0.03 | [-0.10, 0.04] | [-0.10, 0.04] | 6/15 |
| A+B | 1 | M4 | -0.02 | [-0.10, 0.06] | [-0.11, 0.06] | 7/15 |
| A+B | 1 | M5 | -0.09 | [-0.16, -0.01] | [-0.17, -0.00] | 5/15 |
| A+B | 3 | M1 | -0.02 | [-1.06, 1.04] | [-1.07, 0.92] | 6/10 |
| A+B | 3 | M2 | -0.23 | [-0.57, 0.12] | [-0.56, 0.09] | 4/15 |
| A+B | 3 | M3 | -0.10 | [-0.31, 0.11] | [-0.31, 0.10] | 6/15 |
| A+B | 3 | M4 | -0.00 | [-0.21, 0.21] | [-0.23, 0.22] | 8/15 |
| A+B | 3 | M5 | -0.25 | [-0.47, -0.04] | [-0.50, -0.02] | 6/15 |

## Registered design and what was actually tested

The registration commit hash is **747bfbf2b013c7e996e50fbd0f97d9a5c0ef21b5**, created before new scores, memberships, or result analysis. Today's main was read at commit hash **f10e6774355b5b1e970568105ac6a8e9c80b40ea**. The research base commit hash is **5e354392665cae7fa7ef087a58218b4ed6266312**. No parameter was fitted to outcomes. The inherited rolling prior-year eligibility calendar has 188 weekly launches from 2023-03-05 through 2026-10-03, with complete fourteen-day horizons and March/June/September/December selection quarters. There is no newly untouched holdout: these same historical outcomes have already informed earlier studies, so this is exploratory forward-calendar evidence, not new confirmatory validation.

Simple configuration is seven-day range on hourly candles, ten intervals, step_back, shipped range-facts stops, Further/Near sizing, seed on, USD 1,000, 1x/3x, both long and short, fixed range, stop on touch, close at day fourteen. Fees are maker 0.015%, taker 0.040%, builder 0%; adverse entry/exit slippage is 0.05%, with observed funding. Each direction uses the lower-return complete OHLC/OLHC replay. Signals use only closed bars before launch; replay fill and mark prices remain the inherited hourly proxy assumptions, not live execution evidence. The 25 A / 20 B snapshot is fixed; 43 markets ever qualify. Frozen present-day listing membership entails survivorship limitations.

Every arm and ALL skips squeezed launches using the live daily advisory formula: twenty closes, population standard deviation, strict-less bandwidth percentile against the previous twelve calendar months, squeezed below 20%. The live UI is advisory; skipping here is the owner's requested research policy. Of 8,460 market-weeks, 1371 fail inherited quarterly eligibility, 1738 are squeezed, 0 lack squeeze history, and 0 lack usable features; 5351 remain in A+B. Requiring 721 contiguous closes therefore removes no additional eligible non-squeezed launches in this snapshot.

Rank within A and A+B separately before execution admission. Quota is floor(eligible non-squeezed population / 3), with ASCII ties. M0 preserves today's live qualification (100 bars, ADX below 20 and usable range), ranked by ascending ADX. M1 requires both q=4 and q=12 Lo–MacKinlay heteroskedastic variance-ratio upper bounds below one on 336 hourly returns; each uses a one-sided 2.5% test, Bonferroni-adjusted across the two horizons. M2 requires DFA H below 0.5 over both 336 and 720 returns; scales are 8/16/32/64 and additionally 128 for thirty days. M3 counts completed upper/lower-edge rejections over the preceding seven days, each against its own prior seven-day range, returning at least 10% of range inside within six closed bars; same-edge events cannot overlap. M4 ranks absolute hourly close travel per day divided by twice actual ten-interval spacing, then by mean fractional distance to long/short stops. M5 equally averages component percentile ranks without hard M1/M2 gates. M4 is a travel opportunity proxy, not a forecast of executed profitable round trips.

M0, M1 and M2 can leave quota vacancies when too few markets qualify. This explicitly preregistered interpretation of “top third” preserves the meaning of today's finder and the hard statistical thresholds; forced filling would test a different rule. No rejected selected bot is replaced. Both directions must be admitted on both paths before comparison, avoiding accidental direction imbalance. ALL includes all eligible non-squeezed launches before the same admission and direction-pair filters. Coverage differences mean the resulting estimand is conditional launched-bot performance, not equal-capital portfolio return.

Bootstrap resamples full calendar weeks, including empty gaps, with 10,000 deterministic circular draws, one-week blocks primary and four-week blocks sensitivity. There are 66 declared comparisons (11 contrasts × 3 leverage views × 2 universes), 66 estimable p-values, and 0 BH q-values below 0.05. BH q-values cover all one-week contrasts; reported 95% CIs are pointwise, not multiplicity-adjusted. Four-week intervals address adjacent fourteen-day-horizon dependence but cannot eliminate all shared-market dependence. Quarter wins use the inherited selection quarters, including partial first/last quarters. Full quarter deltas are in QUARTERS.csv. No rescue search or post-result tuning was performed.

Method references: [MathWorks variance-ratio test documentation](https://www.mathworks.com/help/econ/vratiotest.html), [PhysioNet DFA reference implementation](https://www.physionet.org/content/dfa/1.0.0/dfa.c). The implementation and all exact thresholds are frozen in PREREGISTRATION.md and core.mjs.

## Admitted tally — new and reused kept separate

**NEW simulations attempted: 0; admitted: 0; rejected: 0.** The previous multi-timeframe run already contained the exact required D7H1 / Further-Near / zero-builder paths. All 45 output hashes and receipt hashes were checked, both physical paths required, and each retained worst-path row compared to its physical source. The following is a reuse audit, not newly generated evidence or a multiplication by arm membership.

| Reuse audit | Count |
| --- | --- |
| Physical paths inspected for requested settings | 56712 |
| Physical paths admitted | 55950 |
| Physical paths rejected | 762 |
| Derived worst-path outcomes | 27975 |
| Direction-specific outcomes excluded for absent partner | 313 |
| Paired direction-specific conservative outcomes before squeeze/membership | 27662 |

| Inherited rejection reason | Physical paths |
| --- | --- |
| Stop must remain at least 1% on the safe side of projected liquidation, rounded to the market tick. | 610 |
| Safety envelope is unavailable or below the execution bound | 96 |
| Generated sizing policy is not canonical | 56 |

The inherited files include squeezed and otherwise nonselected launches. Admission counts in each arm above apply membership only after the audit. 381 direction/launch/leverage combinations lack an admitted pair of physical paths. There were no new network market-data requests or rate-limit responses.

## Validation and evidence

TEST-RISK: REQUIRED. Focused pure-estimator, closed-bar timing, selection, pairing and matched-week tests ran only on FRACTAL using verified exact-source thin-bundle projections. No local Vitest, full regression, database reset or capture endpoint was used. Both run records remain intact:

| Test commit hash | Source commit hash | Host | Passed | Failed | Skipped |
| --- | --- | --- | --- | --- | --- |
| 9aaf3c26aab5dbbd31cea4c50cfabf9822bcb2cf | e63404b6537493d26188f7833646536d80726c14 | Fractal | 7 | 2 | 0 |
| cd681416c9f179eec7ab411e7863bc92d262863d | ceb3be5069278c7f04dde1838ab2aea4a1543f2b | Fractal | 9 | 0 | 0 |

The first run's two failures were corrected test expectations: the edge fixture accidentally touched the lower edge repeatedly, and the BH assertion required exact floating-point equality. Research formulas and results did not change. The rerun passed all nine checks. Projection blob bindings in each intent.json show exactly which source files were tested. These are build-time research checks, not conductor gate evidence.

Evidence root: C:\Apps\Replit\conductor-worktrees\grid-ranging-finder-20261023-handback/evidence/study-20261022T213516608Z. It contains registration/input bindings, launch-time features and memberships, replay-reuse bindings, 66 complete comparisons, decisions, and tally. REVIEW.md describes the static review and limitations; REVIEW-SCAN-STATUS.md records the reviewer's read-only snapshot secret-scan result. Raw FRACTAL QV_RUN_ID entropy findings, if present, are disclosed there under the owner's explicit exception; neither receipts nor scanner are altered. Delivery bundle and installer byte verification are recorded separately in DELIVERY-MANIFEST.json and DELIVERY-VERIFICATION.json.
