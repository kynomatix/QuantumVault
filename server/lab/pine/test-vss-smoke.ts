import { compilePine, runPineBacktest } from "./index";
import { fetchOHLCV } from "../datafeed";

const VSS_LIKE = `
//@version=5
strategy("VSS-like smoke", overlay=true, initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=100)

vwmaLen = input.int(20, "VWMA Length")
src = close
vwma = ta.vwma(src, vwmaLen)
ema9 = ta.ema(src, 9)

snapLong  = ta.crossover(close, vwma)  and ema9 > vwma
snapShort = ta.crossunder(close, vwma) and ema9 < vwma

if snapLong
    strategy.entry("L", strategy.long)
if snapShort
    strategy.entry("S", strategy.short)
`;

async function main() {
  const ticker = "SOL/USDT:USDT";
  const timeframe = "5m";

  console.log("=== VSS-like smoke (ta.vwma) ===");
  const plan = compilePine(VSS_LIKE);
  const candles = await fetchOHLCV(ticker, timeframe, 500);
  console.log(`Bars: ${candles?.length ?? 0}`);
  if (!candles || candles.length < 50) {
    console.log("Not enough candles");
    process.exit(1);
  }

  const config = {
    initialCapital: 10000,
    commission: 0.0005,
    positionSize: 100,
    processOrdersOnClose: false,
  };

  const result = runPineBacktest(plan, candles, {}, ticker, timeframe, config);
  console.log(`compiledPath=${result.compiledPath}`);
  console.log(`entries triggered: ${result.totalTrades}`);
  console.log(`netProfit=${result.netProfitPercent}%  winRate=${result.winRatePercent}%  pf=${result.profitFactor}  dd=${result.maxDrawdownPercent}%`);
  if (result.totalTrades > 0) {
    console.log("SMOKE-TEST PASS: vwma-based strategy produced trades.");
    process.exit(0);
  }
  console.log("SMOKE-TEST FAIL: 0 trades.");
  process.exit(2);
}

main().catch(e => { console.error(e); process.exit(1); });
