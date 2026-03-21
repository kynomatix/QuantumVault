import { labStorage } from "../storage";
import { compilePine, runPineParityTest } from "./index";
import { fetchOHLCV } from "../datafeed";

const paramSets: Record<number, Record<string, any>[]> = {
  1: [
    {},
    { lookback: 20, atrMult: 2.5 },
  ],
  4: [
    {},
    { swingLen: 8, atrLen: 20 },
  ],
  5: [
    {},
    { regimeLen: 30, atrMult: 2.0 },
  ],
  6: [
    {},
    { bbLen: 25, bbMult: 2.5, useStopLoss: true, stopPct: 3.0 },
  ],
};

async function main() {
  const strategyIds = [1, 4, 5, 6];
  const ticker = "SOL/USDT:USDT";
  const timeframe = "4h";
  let allPassed = true;

  for (const sid of strategyIds) {
    try {
      const strategy = await labStorage.getStrategy(sid);
      if (!strategy) {
        console.log(`Strategy ${sid}: NOT FOUND`);
        allPassed = false;
        continue;
      }

      console.log(`\n=== Strategy ${sid}: ${strategy.name} ===`);
      const plan = compilePine(strategy.pineScript);
      const candles = await fetchOHLCV(ticker, timeframe, 500);
      if (!candles || candles.length < 50) {
        console.log(`  Not enough candles: ${candles?.length ?? 0}`);
        allPassed = false;
        continue;
      }

      const config = {
        initialCapital: (strategy.config as any)?.initialCapital ?? 10000,
        commission: (strategy.config as any)?.commission ?? 0.0005,
        positionSize: (strategy.config as any)?.positionSize ?? 100,
        processOrdersOnClose: (strategy.config as any)?.processOrdersOnClose ?? false,
      };

      const sets = paramSets[sid] || [{}];
      for (let pi = 0; pi < sets.length; pi++) {
        const params = sets[pi];
        const label = Object.keys(params).length === 0 ? "defaults" : JSON.stringify(params);
        console.log(`  [Param set ${pi + 1}/${sets.length}] ${label}`);
        console.log(`    Bars: ${candles.length}, Config: ${JSON.stringify(config)}`);

        const result = runPineParityTest(plan, candles, params, ticker, timeframe, config);

        if (result.compiledPath !== "compiled") {
          console.log(`    FAIL: Fell back to interpreter — compiled path not exercised`);
          allPassed = false;
          continue;
        }

        console.log(`    Match: ${result.match}`);
        console.log(`    Compiled path: ${result.compiledPath}`);
        console.log(`    Interpreter: ${result.interpreterMs}ms | Compiled: ${result.compiledMs}ms | Speedup: ${result.speedup}`);
        console.log(`    Interpreted: trades=${result.interpreted.totalTrades} net=${result.interpreted.netProfitPercent}% dd=${result.interpreted.maxDrawdownPercent}% wr=${result.interpreted.winRatePercent}% pf=${result.interpreted.profitFactor}`);
        console.log(`    Compiled:    trades=${result.compiled.totalTrades} net=${result.compiled.netProfitPercent}% dd=${result.compiled.maxDrawdownPercent}% wr=${result.compiled.winRatePercent}% pf=${result.compiled.profitFactor}`);
        if (result.diffs.length > 0) {
          console.log(`    DIFFS:`);
          for (const d of result.diffs) console.log(`      - ${d}`);
          allPassed = false;
        }
        if (!result.match) allPassed = false;
      }
    } catch (err: any) {
      console.log(`Strategy ${sid}: ERROR - ${err.message}`);
      if (err.stack) console.log(err.stack.split('\n').slice(0, 5).join('\n'));
      allPassed = false;
    }
  }

  console.log(`\n=== OVERALL: ${allPassed ? "ALL PASSED" : "FAILURES DETECTED"} ===`);
  process.exit(allPassed ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
