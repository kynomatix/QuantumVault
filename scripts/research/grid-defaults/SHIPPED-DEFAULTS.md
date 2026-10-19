# Source inventory at the research base

Base commitHash: 02afe5354e0192f5068357c225a5d15ad12f6ffc. These are the pinned checkout's defaults, not a claim that a later main or deployment is identical.

| Item | Verified value | Source |
|---|---|---|
| Range window | week | client/src/lib/grid-setup-view.ts:5-6 |
| Intervals | 10 | client/src/lib/grid-setup-view.ts:5 |
| Behaviour | repeat_all; step_back is a comparison, not yet this source's default | client/src/lib/grid-setup-view.ts:6 |
| Seed, timeframe, leverage | true, 1h, 1 | client/src/lib/grid-setup-view.ts:6 |
| Entry/profit scale | flat / flat | client/src/lib/grid-setup-view.ts:5 |
| Display name | Equal | client/src/lib/grid-planner-view.ts:37-38 |
| Investment | blank; research fixes 1,000 | client/src/lib/grid-setup-view.ts:6 |
| Lookback | day=1, week=7, month=30 days; context=max(100, ceil(1.5 x range bars)) | shared/grid-lookback.ts:5-10 |
| Range bounds | period lows/highs expanded by 0.5 ATR(14); last 200 context bars for ATR | server/grid-planner/range-facts.ts:17-33 |
| Stop | 0.75 ATR beyond adverse edge for 1h/4h | server/grid-bot/runtime-policy.ts:35; server/grid-planner/range-facts.ts:32-33 |
| Tick rounding | lower ceil, upper floor, long stop floor, short stop ceil | server/grid-planner/range-facts.ts:64-69 |
| Alternate manual stop | 3% suggestion when no range-window stop supplied | client/src/components/grid-planner/GridPlannerSheet.tsx:126-129,499-500 |
| Minimum sizing | opening cycle quantity at least lot-rounded minimumQuote / openingPrice; capacity constrained; lifts recorded | server/grid-bot/cycle-engine.ts:60,77,91-113,127 |
| Earlier research | 8 intervals; 1,000 capital, leverage 1, flat/flat | server/grid-bot/trail-backtest.ts:18-20,41-44 |

The earlier headline of roughly 55% stopped bots is a pooled observation across different seed and mode settings, not an established rate for the shipped 10-interval seeded default. Recompute this study's baseline. Stop losses vary with geometry and exposure; a single 3-4.5% loss assumption is not imposed.
