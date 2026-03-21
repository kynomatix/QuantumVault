import { labStorage } from "../storage";
import { compilePine, runPineParityTest } from "./index";
import { fetchOHLCV } from "../datafeed";

async function main() {
  const strategyIds = [1, 4, 5, 6];
  const ticker = "SOL/USDT:USDT";
  const timeframe = "4h";
  
  for (const sid of strategyIds) {
    try {
      const strategy = await labStorage.getStrategy(sid);
      if (!strategy) {
        console.log(`Strategy ${sid}: NOT FOUND`);
        continue;
      }
      
      console.log(`\n=== Strategy ${sid}: ${strategy.name} ===`);
      const plan = compilePine(strategy.pineScript);
      const candles = await fetchOHLCV(ticker, timeframe, 500);
      if (!candles || candles.length < 50) {
        console.log(`  Not enough candles: ${candles?.length ?? 0}`);
        continue;
      }
      
      const config = {
        initialCapital: (strategy.config as any)?.initialCapital ?? 10000,
        commission: (strategy.config as any)?.commission ?? 0.0005,
        positionSize: (strategy.config as any)?.positionSize ?? 100,
        processOrdersOnClose: (strategy.config as any)?.processOrdersOnClose ?? false,
      };
      
      console.log(`  Bars: ${candles.length}, Config: ${JSON.stringify(config)}`);
      
      const result = runPineParityTest(plan, candles, {}, ticker, timeframe, config);
      
      console.log(`  Match: ${result.match}`);
      console.log(`  Compiled path: ${result.compiledPath}`);
      if (result.compiledPath !== "compiled") {
        console.log(`  ⚠ WARNING: Fell back to interpreter — parity not truly tested`);
      }
      console.log(`  Interpreter: ${result.interpreterMs}ms`);
      console.log(`  Compiled: ${result.compiledMs}ms`);
      console.log(`  Speedup: ${result.speedup}`);
      console.log(`  Interpreted: trades=${result.interpreted.totalTrades} net=${result.interpreted.netProfitPercent}% dd=${result.interpreted.maxDrawdownPercent}% wr=${result.interpreted.winRatePercent}% pf=${result.interpreted.profitFactor}`);
      console.log(`  Compiled:    trades=${result.compiled.totalTrades} net=${result.compiled.netProfitPercent}% dd=${result.compiled.maxDrawdownPercent}% wr=${result.compiled.winRatePercent}% pf=${result.compiled.profitFactor}`);
      if (result.diffs.length > 0) {
        console.log(`  DIFFS:`);
        for (const d of result.diffs) console.log(`    - ${d}`);
      }
    } catch (err: any) {
      console.log(`Strategy ${sid}: ERROR - ${err.message}`);
      if (err.stack) console.log(err.stack.split('\n').slice(0, 5).join('\n'));
    }
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
