import { labStorage } from "../storage";
import { compilePine } from "./index";
import { executePine, type PineEngineConfig } from "./runtime";
import { fetchOHLCV } from "../datafeed";

async function main() {
  const strategy = await labStorage.getStrategy(6);
  if (!strategy) { console.log("Strategy not found"); process.exit(1); }
  
  const plan = compilePine(strategy.pineScript);
  const ticker = "SOL/USDT:USDT";
  const timeframe = "4h";
  const config: PineEngineConfig = { initialCapital: 10000, commission: 0.0005, positionSize: 100, processOrdersOnClose: false };
  const candles = await fetchOHLCV(ticker, timeframe, 500);
  if (!candles || candles.length < 50) process.exit(1);
  
  const params = strategy.parameterRanges ? Object.fromEntries(
    Object.entries(strategy.parameterRanges as Record<string, any>).map(([k, v]: [string, any]) => [k, v.default ?? v.min])
  ) : {};

  // Both trades have entry price 24.821
  // Interpreter exits at 24.548 (Stop) after 5 bars
  // Compiled exits at 23.35 (Flip) after 27 bars
  // Let's find which bar has close=24.821 for the 2nd long trade
  
  // Run interpreted and check trades
  const interpreted = executePine(plan.ast, candles, params, ticker, timeframe, config, undefined, undefined, true);
  const compiled = executePine(plan.ast, candles, params, ticker, timeframe, config);
  
  // Trade 2 in both has entry 24.821
  const it2 = interpreted.trades[2];
  const ct2 = compiled.trades[2];
  console.log("Interp trade 2:", JSON.stringify(it2));
  console.log("Compil trade 2:", JSON.stringify(ct2));
  
  // Trade 1 (should match)
  const it1 = interpreted.trades[1];
  const ct1 = compiled.trades[1];
  console.log("\nInterp trade 1:", JSON.stringify(it1));
  console.log("Compil trade 1:", JSON.stringify(ct1));
  
  // Trade 0
  const it0 = interpreted.trades[0];
  const ct0 = compiled.trades[0];
  console.log("\nInterp trade 0:", JSON.stringify(it0));
  console.log("Compil trade 0:", JSON.stringify(ct0));
  
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
