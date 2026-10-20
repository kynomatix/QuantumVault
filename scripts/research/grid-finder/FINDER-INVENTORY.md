# Shipped finder inventory

All citations refer to the unchanged research-base checkout at C:/Apps/Replit/conductor-worktrees/grid-finder-backtest-20261020. Source identity is recorded separately by SHA-256.

| Fact | First-hand source |
|---|---|
| Active symbols ending in -PERP; deduplicate then sort alphabetically; scan 20 per request, two reads, 15-second deadline | server/grid-planner/scanner.ts:33–49,69–100; shared/grid-finder.ts:13 |
| User's current timeframe; initial UI default 1h; supported 15m/1h/4h | client/src/lib/grid-setup-view.ts:6; client/src/components/grid-planner/GridPlannerSheet.tsx:455; shared/grid-finder.ts:1 |
| Exactly 100 candles, newest close time must equal finalized history cut, cut must equal current timeframe boundary | server/grid-planner/scanner.ts:10–19 |
| 100 bars means 25 hours at 15m, 100 hours at 1h, 400 hours at 4h; not the bot's one-week geometry | shared/grid-finder.ts:13; server/grid-bot/range.ts:8–12 |
| ADX(14); valid, contiguous, positive OHLC, nonnegative volume, common direct perpetual provenance; fully closed and not stale | server/grid-planner/regime.ts:8–28; server/lab/indicators.ts:252 |
| ADX <20 ranging; 20 through 25 inclusive transitional; >25 trending; invalid values unknown | server/grid-bot/runtime-policy.ts:103–104 |
| Finder also requires an available structural range; Pacifica explicitly excluded for this purpose | server/grid-planner/scanner.ts:16–24; server/grid-bot/range.ts:14–27 |
| Structural range walks backwards from newest closed candle; stops before a bar wider than 3 latest ATR(14), or close drift above 6 ATR; at most supplied 100 bars, implementation cap 400 | server/ai-trader/active-range.ts:51–119; server/grid-bot/range.ts:7,22 |
| Range must have positive width and ATR, positive structural stop; buffer is 0.90 ATR for 15m, 0.75 ATR for 1h/4h | server/ai-trader/active-range.ts:122–127; server/grid-bot/runtime-policy.ts:35–37 |
| Only qualifying candidates returned; score is raw ADX, lower first, symbol breaks ties; no separate numerical rank field or composite score | server/grid-planner/scanner.ts:21–24,100; shared/grid-finder.ts:2–12 |
| UI combines fetched pages and sorts again; displays five initially, more on request; next 20 markets needs another request | client/src/components/grid-planner/GridRangingFinder.tsx:68–102 |
| User sees “Ranging,” ADX rounded to one decimal, detected band, update time, coverage/unavailable counts, source provenance and a no-return-prediction explanation | client/src/components/grid-planner/GridRangingFinder.tsx:77–102 |
| Selection changes the market picker and reloads facts; the detected band is not applied | client/src/components/grid-planner/GridRangingFinder.tsx:84–85,101 |

The study scans the complete frozen research universe of at most five markets, so it does not model network deadlines, partial pagination, historical listing metadata, execution latency or the full live market universe. It preserves the actual pure qualification function and ranking. Proxy-first selection for Pacifica executions is required by the shipped source guard, not an invented substitute signal.

The supplied “inside range” profitability claim is a post-launch subgroup from prior research, not a point-in-time finder result. Prior round-2 reports explicitly distinguish unfunded phase-B/fee results from funded risk results and disclose severe funding-coverage exclusions. The comparator here therefore reruns the same fixed weekly step_back setting with funding at all fees/leverage.
