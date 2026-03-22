import { labStorage } from "../storage";
import { compilePine, runPineBacktest } from "./index";
import { fetchOHLCV } from "../datafeed";

const sbrParams = {
  pivot_len: 22,
  zone_tolerance: 0.2,
  max_bars_retest: 90,
  use_adx: true,
  adx_len: 34,
  adx_threshold: 14.5,
  use_vol: true,
  vol_mult: 2.2,
  use_body: false,
  body_pct: 0.65,
  cooldown_bars: 12,
  atr_len: 46,
  sl_atr_mult: 2.6,
  tp1_atr: 15,
  use_trail: true,
  trail_atr_mult: 0.9,
  trail_trigger: 2.2,
  trade_dir: "Long Only",
};

const tvTrades = [
  { num: 1, dir: "long", entry: 14.47, exit: 16.58, pnl: 14.47, date: "2023-01-09" },
  { num: 2, dir: "long", entry: 21.40, exit: 20.67, pnl: -3.51, date: "2023-05-15" },
  { num: 3, dir: "long", entry: 21.29, exit: 20.67, pnl: -3.01, date: "2023-05-30" },
  { num: 4, dir: "long", entry: 16.98, exit: 16.17, pnl: -4.87, date: "2023-06-24" },
  { num: 5, dir: "long", entry: 18.06, exit: 18.73, pnl: 3.61, date: "2023-06-29" },
  { num: 6, dir: "long", entry: 18.07, exit: 19.64, pnl: 8.58, date: "2023-07-01" },
  { num: 7, dir: "long", entry: 21.34, exit: 21.73, pnl: 1.73, date: "2023-08-30" },
  { num: 8, dir: "long", entry: 19.60, exit: 19.98, pnl: 1.84, date: "2023-09-18" },
  { num: 9, dir: "long", entry: 24.77, exit: 26.11, pnl: 5.31, date: "2023-10-20" },
  { num: 10, dir: "long", entry: 34.80, exit: 36.01, pnl: 3.37, date: "2023-10-30" },
  { num: 11, dir: "long", entry: 45.45, exit: 47.84, pnl: 5.15, date: "2023-11-10" },
  { num: 12, dir: "long", entry: 62.09, exit: 65.61, pnl: 5.56, date: "2023-12-04" },
  { num: 13, dir: "long", entry: 70.83, exit: 65.59, pnl: -7.49, date: "2023-12-11" },
  { num: 14, dir: "long", entry: 108.83, exit: 112.94, pnl: 3.67, date: "2024-02-13" },
  { num: 15, dir: "long", entry: 111.80, exit: 107.08, pnl: -4.32, date: "2024-02-18" },
  { num: 16, dir: "long", entry: 118.90, exit: 131.09, pnl: 10.14, date: "2024-03-06" },
  { num: 17, dir: "long", entry: 158.56, exit: 152.85, pnl: -3.69, date: "2024-10-16" },
  { num: 18, dir: "long", entry: 173.01, exit: 165.91, pnl: -4.20, date: "2024-10-24" },
  { num: 19, dir: "long", entry: 185.01, exit: 195.70, pnl: 5.67, date: "2024-11-06" },
  { num: 20, dir: "long", entry: 195.65, exit: 203.34, pnl: 3.83, date: "2025-01-16" },
  { num: 21, dir: "long", entry: 136.40, exit: 139.82, pnl: 2.41, date: "2025-04-20" },
  { num: 22, dir: "long", entry: 177.87, exit: 169.71, pnl: -4.69, date: "2025-05-23" },
  { num: 23, dir: "long", entry: 172.77, exit: 176.38, pnl: 1.99, date: "2025-08-07" },
  { num: 24, dir: "long", entry: 251.31, exit: 242.85, pnl: -3.46, date: "2025-09-19" },
  { num: 25, dir: "long", entry: 88.53, exit: 90.86, pnl: 2.53, date: "2026-02-26" },
];

async function main() {
  const strategy = await labStorage.getStrategy(3);
  if (!strategy) { console.log("Strategy 3 (SBR) not found"); return; }

  console.log("=== SBR v1: Our Engine vs TradingView ===");
  console.log("Ticker: SOL/USDT:USDT, Timeframe: 2h");

  const candles = await fetchOHLCV("SOL/USDT:USDT", "2h", 500);
  if (!candles || candles.length < 50) {
    console.log("Not enough candles:", candles?.length ?? 0);
    return;
  }

  console.log(`Candles: ${candles.length}`);
  console.log(`First: ${new Date(candles[0].time).toISOString()} O=${candles[0].open}`);
  console.log(`Last: ${new Date(candles[candles.length - 1].time).toISOString()} O=${candles[candles.length - 1].open}`);

  const config = {
    initialCapital: 100,
    commission: 0.0005,
    positionSize: 100,
    processOrdersOnClose: false,
  };

  const plan = compilePine(strategy.pineScript);
  const result = runPineBacktest(plan, candles, sbrParams, "SOL/USDT:USDT", "2h", config);

  console.log(`\n--- Our Results ---`);
  console.log(`Total trades: ${result.trades.length}`);
  const netPnl = result.trades.reduce((s, t) => s + t.pnlDollar, 0);
  const winners = result.trades.filter(t => t.pnlDollar > 0).length;
  console.log(`Net PnL: $${netPnl.toFixed(2)} (${result.netProfitPercent}%)`);
  console.log(`Win rate: ${result.winRatePercent}%`);
  console.log(`Profit factor: ${result.profitFactor}`);

  console.log(`\n--- Trade-by-Trade Comparison ---`);
  console.log(`${"#".padStart(3)} ${"Dir".padEnd(6)} ${"TV Entry".padStart(10)} ${"Our Entry".padStart(10)} ${"TV Exit".padStart(10)} ${"Our Exit".padStart(10)} ${"TV PnL%".padStart(10)} ${"Our PnL%".padStart(10)} ${"Match?".padStart(7)}`);
  console.log("-".repeat(85));

  const maxLen = Math.max(tvTrades.length, result.trades.length);
  let matchCount = 0;
  for (let i = 0; i < maxLen; i++) {
    const tv = tvTrades[i];
    const our = result.trades[i];
    if (tv && our) {
      const entryMatch = Math.abs(tv.entry - our.entryPrice) < 0.5;
      const exitMatch = Math.abs(tv.exit - our.exitPrice) < 0.5;
      const pnlMatch = Math.abs(tv.pnl - our.pnlPercent) < 2;
      const match = entryMatch && exitMatch && pnlMatch;
      if (match) matchCount++;
      console.log(
        `${(i + 1).toString().padStart(3)} ${(our.direction).padEnd(6)} ${tv.entry.toFixed(2).padStart(10)} ${our.entryPrice.toFixed(2).padStart(10)} ${tv.exit.toFixed(2).padStart(10)} ${our.exitPrice.toFixed(2).padStart(10)} ${tv.pnl.toFixed(2).padStart(10)} ${our.pnlPercent.toFixed(2).padStart(10)} ${(match ? "✓" : "✗").padStart(7)}`
      );
    } else if (tv) {
      console.log(`${(i + 1).toString().padStart(3)} ${tv.dir.padEnd(6)} ${tv.entry.toFixed(2).padStart(10)} ${"MISSING".padStart(10)} ${tv.exit.toFixed(2).padStart(10)} ${"MISSING".padStart(10)} ${tv.pnl.toFixed(2).padStart(10)} ${"N/A".padStart(10)} ${"✗".padStart(7)}`);
    } else if (our) {
      console.log(`${(i + 1).toString().padStart(3)} ${our.direction.padEnd(6)} ${"EXTRA".padStart(10)} ${our.entryPrice.toFixed(2).padStart(10)} ${"EXTRA".padStart(10)} ${our.exitPrice.toFixed(2).padStart(10)} ${"N/A".padStart(10)} ${our.pnlPercent.toFixed(2).padStart(10)} ${"✗".padStart(7)}`);
    }
  }

  console.log(`\nMatched: ${matchCount}/${tvTrades.length}`);

  console.log(`\n--- TV Summary ---`);
  console.log(`Total trades: 25, Net PnL: $40.61 (40.61%), Win rate: 64%, PF: 2.035`);

  console.log(`\n--- Full Trade List (Our Engine) ---`);
  for (let i = 0; i < result.trades.length; i++) {
    const t = result.trades[i];
    console.log(`  T${i + 1}: ${t.direction} entry=${t.entryPrice.toFixed(2)} exit=${t.exitPrice.toFixed(2)} pnl=${t.pnlPercent.toFixed(2)}% ($${t.pnlDollar.toFixed(2)}) reason=${t.exitReason} bars=${t.barsHeld} time=${t.entryTime} -> ${t.exitTime}`);
  }
}

main().catch(console.error).finally(() => process.exit(0));
