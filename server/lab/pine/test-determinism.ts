// .local/session_plan.md T001c — pool determinism verification.
//
// Runs a small (50-config) optimizer job twice against cached candles using
// the WorkerPool with N=1 and then N=4. Asserts that the union of top-K
// results (sorted by score) is BYTE-IDENTICAL between the two runs for the
// same job seed. This is the contractual proof that the worker pool is a
// faithful parallelization of the single-worker engine.

import { Worker } from "worker_threads";
import { resolve } from "path";
import { fetchOHLCV } from "../datafeed";
import { WorkerPool } from "../worker-pool";
import { parsePineScript } from "../pine-parser";
import { hashStringToSeed } from "../rng";
import type { LabBacktestResult } from "@shared/schema";
import type { OHLCV } from "../engine";

const VSS_LIKE = `
//@version=5
strategy("VSS-determinism", overlay=true, initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=100)
vwmaLen = input.int(20, "VWMA Length", minval=5, maxval=80)
emaLen  = input.int(9, "EMA Length", minval=3, maxval=50)
src = close
vwma = ta.vwma(src, vwmaLen)
emaS = ta.ema(src, emaLen)
snapLong  = ta.crossover(close, vwma)  and emaS > vwma
snapShort = ta.crossunder(close, vwma) and emaS < vwma
if snapLong
    strategy.entry("L", strategy.long)
if snapShort
    strategy.entry("S", strategy.short)
`;

function spawnRawWorker(workerDataPayload: any): Worker {
  return new Worker(
    `require('tsx/cjs'); require('${resolve(process.cwd(), "server", "lab", "optimizer-worker.ts").replace(/\\/g, "/")}');`,
    { eval: true, workerData: workerDataPayload },
  );
}

function fingerprint(results: LabBacktestResult[]): string {
  return results
    .map(r => ({
      ticker: r.ticker,
      timeframe: r.timeframe,
      np: r.netProfitPercent,
      wr: r.winRatePercent,
      dd: r.maxDrawdownPercent,
      pf: r.profitFactor,
      tt: r.totalTrades,
      params: r.params,
    }))
    .map(o => JSON.stringify(o))
    .join("\n");
}

async function runPool(
  jobId: string,
  candlesByCombo: Record<string, OHLCV[]>,
  parsedInputs: any[],
  tickers: string[],
  timeframes: string[],
  randomSamples: number,
  poolSize: number,
): Promise<{ results: LabBacktestResult[]; elapsedMs: number }> {
  const start = Date.now();
  const pool = new WorkerPool(
    spawnRawWorker,
    {
      jobId,
      config: {
        tickers,
        timeframes,
        randomSamples,
        topK: 5,
        refinementsPerSeed: 3,
        minTrades: 0,
        maxDrawdownCap: 100,
        minAvgBarsHeld: 0,
        parsedInputs,
        processOrdersOnClose: false,
        deepSearch: false,
        coordinateTune: false,
        pineScript: VSS_LIKE,
      },
      candlesByCombo,
      randomSeed: hashStringToSeed(jobId),
    },
    poolSize,
  );
  return new Promise((resolveP, rejectP) => {
    pool.on("message", (msg: any) => {
      if (msg.type === "done") {
        resolveP({ results: msg.results as LabBacktestResult[], elapsedMs: Date.now() - start });
      } else if (msg.type === "error") {
        rejectP(new Error(msg.message));
      }
    });
    pool.on("error", (err) => rejectP(err));
  });
}

async function main() {
  const tickers = ["SOL/USDT:USDT"];
  const timeframes = ["15m", "2h", "4h"];
  const combos: { ticker: string; timeframe: string }[] = [];
  for (const t of tickers) for (const tf of timeframes) combos.push({ ticker: t, timeframe: tf });

  console.log(`Fetching candles for ${combos.length} combos…`);
  const startDate = "2025-01-01";
  const endDate = "2025-06-01";
  const candlesByCombo: Record<string, OHLCV[]> = {};
  for (const c of combos) {
    const candles = await fetchOHLCV(c.ticker, c.timeframe, startDate, endDate);
    candlesByCombo[`${c.ticker}|${c.timeframe}`] = candles ?? [];
    console.log(`  ${c.ticker} ${c.timeframe}: ${candles?.length ?? 0} bars`);
  }

  const parsed = parsePineScript(VSS_LIKE);
  const parsedInputs = parsed.inputs;

  const seedJobId = "determinism-seed-42";

  console.log(`\n--- Run A: pool N=1 ---`);
  const runA = await runPool(seedJobId, candlesByCombo, parsedInputs, tickers, timeframes, 50, 1);
  console.log(`  results: ${runA.results.length}, elapsed: ${runA.elapsedMs}ms`);

  console.log(`\n--- Run B: pool N=4 ---`);
  const runB = await runPool(seedJobId, candlesByCombo, parsedInputs, tickers, timeframes, 50, 4);
  console.log(`  results: ${runB.results.length}, elapsed: ${runB.elapsedMs}ms`);

  const fpA = fingerprint(runA.results);
  const fpB = fingerprint(runB.results);

  if (fpA === fpB) {
    console.log(`\nPASS: union of top-K is IDENTICAL between N=1 and N=4 (same seed).`);
    console.log(`  Run A elapsed: ${runA.elapsedMs}ms`);
    console.log(`  Run B elapsed: ${runB.elapsedMs}ms`);
    process.exit(0);
  }

  console.error(`\nFAIL: result sets differ between N=1 and N=4 for the same seed.`);
  console.error(`  N=1 count=${runA.results.length}`);
  console.error(`  N=4 count=${runB.results.length}`);
  // Print first diverging line for triage.
  const linesA = fpA.split("\n");
  const linesB = fpB.split("\n");
  const max = Math.max(linesA.length, linesB.length);
  for (let i = 0; i < max; i++) {
    if (linesA[i] !== linesB[i]) {
      console.error(`  first diff at index ${i}:`);
      console.error(`    N=1: ${linesA[i] ?? "<none>"}`);
      console.error(`    N=4: ${linesB[i] ?? "<none>"}`);
      break;
    }
  }
  process.exit(2);
}

main().catch(e => { console.error(e); process.exit(1); });
