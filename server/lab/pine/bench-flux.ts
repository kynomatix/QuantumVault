import { compilePine } from "./index.js";
import { executePine } from "./runtime.js";
import { getCachedCandles } from "../candle-store.js";
import { fetchOHLCV } from "../datafeed.js";
import { db } from "../../db.js";
import { labStrategies } from "@shared/schema";
import { eq } from "drizzle-orm";

async function main() {
  const [strat] = await db.select().from(labStrategies).where(eq(labStrategies.id, 1));
  if (!strat) { console.log("No strategy found"); return; }
  console.log(`Pine script: ${strat.pineScript!.length} chars`);

  const plan = compilePine(strat.pineScript!);
  console.log(`AST stmts: ${plan.ast.length}, inputs: ${plan.inputs.length}`);

  let candles = getCachedCandles("SOL/USDT:USDT", "12h");
  if (!candles || candles.length === 0) {
    console.log("Fetching candles...");
    candles = await fetchOHLCV("SOL/USDT:USDT", "12h", "2023-01-01", "2026-03-20");
  }
  console.log(`Candles: ${candles.length}`);

  // Warm up
  const r0 = executePine(plan.ast, candles, {}, plan.inputs, plan.config, "SOL/USDT:USDT", "12h");
  console.log(`Warmup: trades=${r0.trades.length}`);

  // Time 5 runs
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const r = executePine(plan.ast, candles, {}, plan.inputs, plan.config, "SOL/USDT:USDT", "12h");
    times.push(performance.now() - t0);
  }
  console.log(`Per-backtest times: ${times.map(t => t.toFixed(0) + 'ms').join(', ')}`);
  console.log(`Average: ${(times.reduce((a,b) => a+b, 0) / times.length).toFixed(0)}ms`);
  console.log(`For 2000 iterations: ${((times.reduce((a,b) => a+b, 0) / times.length) * 2000 / 1000 / 60).toFixed(1)} minutes`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
