import { labStorage } from "../storage";
import { compilePine } from "./index";
import { executePine, type PineEngineConfig } from "./runtime";
import { fetchOHLCV } from "../datafeed";

async function main() {
  const strategy = await labStorage.getStrategy(5);
  if (!strategy) { console.log("Strategy not found"); process.exit(1); }
  
  const plan = compilePine(strategy.pineScript);
  const ticker = "SOL/USDT:USDT";
  const timeframe = "4h";
  const config: PineEngineConfig = { initialCapital: 10000, commission: 0.0005, positionSize: 100, processOrdersOnClose: false };
  const candles = await fetchOHLCV(ticker, timeframe, 500);
  if (!candles || candles.length < 50) { console.log("Not enough candles"); process.exit(1); }
  
  const params = strategy.parameterRanges ? Object.fromEntries(
    Object.entries(strategy.parameterRanges as Record<string, any>).map(([k, v]: [string, any]) => [k, v.default ?? v.min])
  ) : {};

  const interpreted = executePine(plan.ast, candles, params, ticker, timeframe, config, undefined, undefined, true);
  const compiled = executePine(plan.ast, candles, params, ticker, timeframe, config);

  console.log(`Strategy 5: interpreted=${interpreted.totalTrades} compiled=${compiled.totalTrades}`);
  
  const maxTrades = Math.max(interpreted.trades.length, compiled.trades.length);
  for (let i = 0; i < maxTrades; i++) {
    const it = interpreted.trades[i];
    const ct = compiled.trades[i];
    if (!it || !ct || it.direction !== ct.direction || it.entryPrice !== ct.entryPrice || it.exitPrice !== ct.exitPrice) {
      console.log(`\nFirst trade mismatch at index ${i}:`);
      if (it) console.log(`  interp: dir=${it.direction} entry=${it.entryPrice} exit=${it.exitPrice} pnl=${it.pnlPercent}% reason=${it.exitReason} held=${it.barsHeld} time=${it.entryTime}`);
      if (ct) console.log(`  compil: dir=${ct.direction} entry=${ct.entryPrice} exit=${ct.exitPrice} pnl=${ct.pnlPercent}% reason=${ct.exitReason} held=${ct.barsHeld} time=${ct.entryTime}`);
      for (let j = Math.max(0, i - 2); j <= Math.min(i + 5, maxTrades - 1); j++) {
        if (j === i) continue;
        const it2 = interpreted.trades[j];
        const ct2 = compiled.trades[j];
        if (it2) console.log(`  [${j}] interp: dir=${it2.direction} entry=${it2.entryPrice} exit=${it2.exitPrice} pnl=${it2.pnlPercent}% reason=${it2.exitReason}`);
        if (ct2) console.log(`  [${j}] compil: dir=${ct2.direction} entry=${ct2.entryPrice} exit=${ct2.exitPrice} pnl=${ct2.pnlPercent}% reason=${ct2.exitReason}`);
      }
      break;
    }
  }
  
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
