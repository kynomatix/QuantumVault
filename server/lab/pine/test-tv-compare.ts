import { labStorage } from "../storage";
import { compilePine, runPineBacktest } from "./index";
import { fetchOHLCV } from "../datafeed";

const tvParams = {
  bb_use_ema: false,
  bb_length: 15,
  bb_source: "close",
  bb_mult: 6.6,
  fast_ma_len: 32,
  aoSlowLen: 196,
  aoFastLen: 45,
  cviLength: 44,
  cviBullThld: -0.77,
  cviBearThld: 1.376,
  useCVIentry: false,
  useCVIexit: false,
  useTrendFilter: false,
  trendEmaLen: 642,
  trendMode: "Counter-Trend Only",
  useADX: false,
  adxLen: 26,
  adxThreshold: 15.9,
  useStopLoss: true,
  slMode: "ATR",
  slATRmult: 4.9,
  slPercent: 20,
  slATRlen: 50,
  bosSwingLen: 19,
  slOnClose: true,
  useTrailing: false,
  trailMode: "Percentage",
  trailATRmult: 4.5,
  trailPercent: 7.75,
  trailActivation: true,
  activationATR: 3,
  activationPct: 2.5,
  useTP: false,
  tpMode: "Percentage",
  tpATRmult: 8,
  tpPercent: 11,
  tpRiskMult: 3.25,
  usePartialTP: true,
  partialTrigger: "Fixed Level",
  partialPercent: 55,
  partialLevel: 2,
  moveSlToBreakeven: false,
  useDateFilter: true,
  backtestStartDate: new Date("2023-01-01").getTime(),
};

const tvTrades = [
  { num: 1, dir: "short", entry: 19.68, exit: 58.53, pnl: -197.51 },
  { num: 2, dir: "long",  entry: 58.53, exit: 92.91, pnl: 58.58 },
  { num: 3, dir: "short", entry: 92.91, exit: 100.85, pnl: -8.65 },
  { num: 4, dir: "long",  entry: 100.85, exit: 151.53, pnl: 50.10 },
  { num: 5, dir: "short", entry: 151.53, exit: 168.32, pnl: -11.18 },
  { num: 6, dir: "long",  entry: 168.32, exit: 136.68, pnl: -18.88 },
  { num: 7, dir: "long",  entry: 143.06, exit: 146.32, pnl: 2.18 },
  { num: 8, dir: "short", entry: 146.32, exit: 138.57, pnl: 5.20 },
  { num: 9, dir: "long",  entry: 138.57, exit: 114.14, pnl: -17.71 },
  { num: 10, dir: "short", entry: 144.91, exit: 87.37, pnl: 39.61 },
];

async function main() {
  const strategy = await labStorage.getStrategy(6);
  if (!strategy) { console.log("Strategy 6 not found"); return; }

  console.log("=== BB Trend Trader: Our Engine vs TradingView ===");
  console.log("Ticker: SOL/USDT:USDT, Timeframe: 8h");
  console.log("Params:", JSON.stringify(tvParams, null, 2));

  const candles = await fetchOHLCV("SOL/USDT:USDT", "8h", 500);
  if (!candles || candles.length < 50) {
    console.log("Not enough candles:", candles?.length ?? 0);
    return;
  }

  console.log(`\nCandles: ${candles.length}`);
  console.log(`First candle: ${new Date(candles[0].time).toISOString()} O=${candles[0].open}`);
  console.log(`Last candle: ${new Date(candles[candles.length - 1].time).toISOString()} O=${candles[candles.length - 1].open}`);

  const config = {
    initialCapital: 100,
    commission: 0.0005,
    positionSize: 100,
    processOrdersOnClose: true,
  };

  const plan = compilePine(strategy.pineScript);
  const result = runPineBacktest(plan, candles, tvParams, "SOL/USDT:USDT", "8h", config);

  console.log(`\n--- Our Results ---`);
  console.log(`Total trades: ${result.trades.length}`);
  const netPnl = result.trades.reduce((s, t) => s + t.pnlDollar, 0);
  const winners = result.trades.filter(t => t.pnlDollar > 0).length;
  console.log(`Net PnL: $${netPnl.toFixed(2)} (${(netPnl / config.initialCapital * 100).toFixed(2)}%)`);
  console.log(`Win rate: ${(winners / result.trades.length * 100).toFixed(1)}%`);

  console.log(`\n--- Trade-by-Trade Comparison ---`);
  console.log(`${"#".padStart(3)} ${"Dir".padEnd(6)} ${"TV Entry".padStart(10)} ${"Our Entry".padStart(10)} ${"TV Exit".padStart(10)} ${"Our Exit".padStart(10)} ${"TV PnL%".padStart(10)} ${"Our PnL%".padStart(10)} ${"Match?".padStart(7)}`);
  console.log("-".repeat(85));

  const maxLen = Math.max(tvTrades.length, result.trades.length);
  for (let i = 0; i < maxLen; i++) {
    const tv = tvTrades[i];
    const our = result.trades[i];
    if (tv && our) {
      const entryMatch = Math.abs(tv.entry - our.entryPrice) < 0.5;
      const exitMatch = Math.abs(tv.exit - our.exitPrice) < 0.5;
      const pnlMatch = Math.abs(tv.pnl - our.pnlPercent) < 2;
      const match = entryMatch && exitMatch && pnlMatch ? "✓" : "✗";
      console.log(
        `${(i + 1).toString().padStart(3)} ${(our.direction).padEnd(6)} ${tv.entry.toFixed(2).padStart(10)} ${our.entryPrice.toFixed(2).padStart(10)} ${tv.exit.toFixed(2).padStart(10)} ${our.exitPrice.toFixed(2).padStart(10)} ${tv.pnl.toFixed(2).padStart(10)} ${our.pnlPercent.toFixed(2).padStart(10)} ${match.padStart(7)}`
      );
    } else if (tv) {
      console.log(`${(i + 1).toString().padStart(3)} ${tv.dir.padEnd(6)} ${tv.entry.toFixed(2).padStart(10)} ${"MISSING".padStart(10)} ${tv.exit.toFixed(2).padStart(10)} ${"MISSING".padStart(10)} ${tv.pnl.toFixed(2).padStart(10)} ${"N/A".padStart(10)} ${"✗".padStart(7)}`);
    } else if (our) {
      console.log(`${(i + 1).toString().padStart(3)} ${our.direction.padEnd(6)} ${"EXTRA".padStart(10)} ${our.entryPrice.toFixed(2).padStart(10)} ${"EXTRA".padStart(10)} ${our.exitPrice.toFixed(2).padStart(10)} ${"N/A".padStart(10)} ${our.pnlPercent.toFixed(2).padStart(10)} ${"✗".padStart(7)}`);
    }
  }

  console.log(`\n--- TV Summary ---`);
  console.log(`Total trades: 10, Net PnL: -$97.83 (-97.83%), Win rate: 50%, PF: 0.614`);

  console.log(`\n--- Full Trade List (Our Engine) ---`);
  for (let i = 0; i < result.trades.length; i++) {
    const t = result.trades[i];
    console.log(`  T${i + 1}: ${t.direction} entry=${t.entryPrice.toFixed(2)} exit=${t.exitPrice.toFixed(2)} pnl=${t.pnlPercent.toFixed(2)}% ($${t.pnlDollar.toFixed(2)}) reason=${t.exitReason} bars=${t.barsHeld} time=${t.entryTime} -> ${t.exitTime}`);
  }
}

main().catch(console.error).finally(() => process.exit(0));
