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
| Position events (entry → final exit) | 110 |
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
TradingView splits a single position event into one List-of-Trades row per `strategy.close` fill. With `tp1QtyPct=20`, each position therefore produces two TV "trades": the 20 % TP1 slice and the 80 % runner. So 220 TV rows = 110 actual position lifecycles. The parity CLI normalises both sides to position lifecycles before diffing.
