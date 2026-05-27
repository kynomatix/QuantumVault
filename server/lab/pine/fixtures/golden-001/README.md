# golden-001 — VSS: VWAP Snap Scalper v1 (ETH 1H)

Captured 2026-05-26 from production divergence reported under the kryptolytix account.

## Source
- **Script:** `script.pine` — `VSS: VWAP Snap Scalper v1 [Kryptolytix]` (mean-reversion scalper).
- **Symbol / TF:** OKX:ETHUSDT.P — 1 hour.
- **Trading range observed in TV:** Jan 26 2023 — May 20 2026.
- **Backtesting range loaded by TV:** Dec 31 2022 11:00 — May 20 2026 10:00.
- **Date filter (in-script):** start `Jan 01 2023 11:00`, end `Dec 31 2030 11:00`, enabled.
- **Trade direction:** Long Only.
- **Initial capital:** $100. Commission: 0.10% (per side). Slippage: 0.
- **Order processing:** `process_orders_on_close=false` (default — fills at next bar open).
- **Position sizing:** `default_qty_type=strategy.cash`, `default_qty_value=100` (fixed $100 cash per entry).

## TV results (source of truth for parity diff)
See `tv-summary.json` and full per-trade list in `tv-trades.csv`.

| Metric | Value |
|---|---|
| Total trades (fills, TV counts each chunk) | 220 |
| List-of-trades CSV rows (entry+exit pair per fill) | 440 |
| Position events after collapsing entry+exit pairs | 130 |
| Win rate | 76.36 % |
| Net profit | +$59.17 (+59.17 %) |
| Profit factor | 1.419 |
| Sharpe | 0.266 |
| Sortino | 0.543 |
| Avg bars in trade | 27 |

## Files
- `script.pine` — verbatim Pine v5 source.
- `tv-report.xlsx` — full TradingView Strategy Tester export (Performance / Trades analysis / Risk-adjusted performance / List of trades / Properties).
- `tv-summary.json` — flattened headline metrics.
- `tv-properties.json` — every input parameter as exported by TV.
- `tv-trades.csv` — full List of Trades export (440 rows = 220 fills × {entry, exit} lines).
- `params.json` — same params as `tv-properties.json` but keyed by Pine input variable name (the form QuantumLab passes to `runPineBacktest`).

## Reproducing
Run the parity diff CLI from repo root:

```
tsx server/lab/pine/parity-diff.ts golden-001
```

It will fetch 1H ETH/USDT:USDT candles via `datafeed.ts`, run the script through the Pine engine, and diff headline metrics + first-N trades against `tv-trades.csv`. The CLI is read-only — it does not write fixtures or modify any engine code.

## Notes on TV's trade-list format
TradingView splits a single position event into one List-of-Trades row per `strategy.close` fill. With `tp1QtyPct=20`, each position produces TP1 slice + runner fills, each yielding paired entry/exit rows. The CLI collapser groups by (entryTime, entryPrice, direction) which yields 130 position events from this fixture's 440 raw rows. The parity CLI normalises both sides to position lifecycles before diffing.

## Current parity status (captured 2026-05-27)
Running `tsx server/lab/pine/parity-diff.ts golden-001 --trades 20` against `main` after fixing the parity-diff CLI's `__dirname` bug, adding `--path both`, coercing ISO-date params to numeric ms, and collapsing QL's per-fill records into position events the same way TV's are collapsed:

### Headline (collapsed position events)
| Metric | TV | QL | Gap |
|---|---|---|---|
| Position events | 130 | 142 | +12 (+9%) |
| Net % | 59.17 | 127.03 | **2.15×** |
| Win rate % | 76.36 | 83.75 | +7.4pp |
| Profit factor | 1.42 | 2.01 | +41% |
| Interpreter vs compiled | — | identical | no path divergence |

### Per-position alignment (first 20 positions)
- **Entries: 100% match.** Every entry price and timestamp matches TV exactly. Entry logic in the Pine engine is correct.
- **Exits: within $0.05–$2 of TV.** Trail-stop and TP1 mechanics align.
- **PnL%: consistently +0.20pp (single-fill exits) or +0.40pp (TP1 + runner two-fill exits) higher than TV.**

That last signature is the fingerprint of a specific bug: **trade record `pnlPercent` is reported GROSS, but TV's `Net P&L %` column is NET of commission.** The engine's headline `netProfitPercent` is correctly net (computed from equity, which uses `pnlDollar` and subtracts commission). But `recordClose` writes a gross `pnlPercent` to each trade, and downstream `winRatePercent` is classified by `pnlPercent > 0` — so trades that gross +0.1% but net -0.1% (commission > gross gain) wrongly count as wins. This explains WR 84 vs 76 and PF 2.01 vs 1.42.

### Open root causes (in priority order)
1. ~~`pnlPercent` displayed gross, should be net of commission.~~ **FIXED** in `recordClose` (now subtracts `2 × commission × 100`) and win classifier in `executePine` (now uses `pnlDollar > 0`). WR moved 83.75 → 80.83 (gap to TV halved from 7.4pp to 4.5pp). Headline net% and PF unchanged — both already net.
2. **12 extra positions (+9%) and inflated per-position P&L.** The first 20 entries are identical to TV, so the extras are later in the time series, and the per-position gross P&L is also higher than TV. Likely candidates:
   - `var int barsSinceExit` counter semantics — cooldown reset block in the script (`if position_size == 0 and position_size[1] != 0 → barsSinceExit := 0`) may not correctly access `position_size[1]` in our runtime.
   - Trail-stop progression — `trailLevel := na(trailLevel) ? newTrail : math.max(trailLevel, newTrail)` carries across bars; if our `var float trailLevel` doesn't reset to `na` on position close, the next position inherits a stale trail and exits at a different price.
   - Bigger wins per position would happen if our trail rides further before stopping out.
   - Next investigation: write a debug script that logs `(barIndex, time, position_size, position_size[1], barsSinceExit, trailLevel, stopLevel)` per bar near a known TV entry, compare against TV's "Strategy Tester → Trades" CSV row for the same time. Look at positions #20+ where divergence starts.

### Notes on the CLI
- `parity-diff.ts` now coerces ISO-date params to ms (production sends ms; params.json keeps strings for human-readability).
- Use `--path both` to verify interpreter and compiled paths still match — important regression check whenever the compiler is touched.
- `debug-gates.ts` is a sibling harness that runs progressively-relaxed variants of this script to isolate which Pine gate stops trades firing. Run it after any change to compiler/runtime to make sure entries still flow.
