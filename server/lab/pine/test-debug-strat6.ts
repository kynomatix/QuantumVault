import { labStorage } from "../storage";
import { compilePine } from "./index";
import { executePine, type PineEngineConfig } from "./runtime";
import { fetchOHLCV } from "../datafeed";

async function main() {
  const stratId = parseInt(process.argv[2] || "6");
  const strategy = await labStorage.getStrategy(stratId);
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

  console.log(`Strategy ${stratId}: interpreted=${interpreted.totalTrades} compiled=${compiled.totalTrades}`);
  
  // Find first pnl divergence
  const minLen = Math.min(interpreted.trades.length, compiled.trades.length);
  for (let i = 0; i < minLen; i++) {
    const it = interpreted.trades[i];
    const ct = compiled.trades[i];
    if (it.direction !== ct.direction || it.entryPrice !== ct.entryPrice || it.exitPrice !== ct.exitPrice) {
      console.log(`\nFirst trade mismatch at index ${i}:`);
      console.log(`  interp: dir=${it.direction} entry=${it.entryPrice} exit=${it.exitPrice} pnl=${it.pnlPercent}% reason=${it.exitReason} held=${it.barsHeld}`);
      console.log(`  compil: dir=${ct.direction} entry=${ct.entryPrice} exit=${ct.exitPrice} pnl=${ct.pnlPercent}% reason=${ct.exitReason} held=${ct.barsHeld}`);
      // Show context
      for (let j = Math.max(0, i - 1); j <= Math.min(i + 3, minLen - 1); j++) {
        if (j === i) continue;
        const it2 = interpreted.trades[j];
        const ct2 = compiled.trades[j];
        console.log(`  [${j}] interp: dir=${it2.direction} entry=${it2.entryPrice} exit=${it2.exitPrice} pnl=${it2.pnlPercent}%`);
        console.log(`  [${j}] compil: dir=${ct2.direction} entry=${ct2.entryPrice} exit=${ct2.exitPrice} pnl=${ct2.pnlPercent}%`);
      }
      break;
    }
  }
  
  // Also check: compiled has 271, interpreted has 285 - so interpreted has 14 more trades.
  // Those extra trades happen after trade 271. Let's see what bar they start on.
  if (interpreted.trades.length > compiled.trades.length) {
    const extra = interpreted.trades.slice(compiled.trades.length);
    console.log(`\nExtra interpreted trades (${extra.length}):`);
    for (const t of extra.slice(0, 5)) {
      console.log(`  dir=${t.direction} entry=${t.entryPrice} exit=${t.exitPrice} pnl=${t.pnlPercent}% reason=${t.exitReason} held=${t.barsHeld} entryTime=${t.entryTime}`);
    }
  }
  
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
