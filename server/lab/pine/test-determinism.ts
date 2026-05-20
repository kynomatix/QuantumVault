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

async function fetchCombos(
  tickers: string[],
  timeframes: string[],
  startDate: string,
  endDate: string,
): Promise<Record<string, OHLCV[]>> {
  const candlesByCombo: Record<string, OHLCV[]> = {};
  for (const t of tickers) {
    for (const tf of timeframes) {
      const candles = await fetchOHLCV(t, tf, startDate, endDate);
      candlesByCombo[`${t}|${tf}`] = candles ?? [];
      console.log(`  ${t} ${tf}: ${candles?.length ?? 0} bars`);
    }
  }
  return candlesByCombo;
}

async function compareRuns(
  label: string,
  jobIdSeed: string,
  candlesByCombo: Record<string, OHLCV[]>,
  parsedInputs: any[],
  tickers: string[],
  timeframes: string[],
  randomSamples: number,
  poolSizes: number[],
): Promise<boolean> {
  console.log(`\n=== Scenario: ${label} (${tickers.length}t × ${timeframes.length}tf × ${randomSamples} samples) ===`);
  const runs: { N: number; results: LabBacktestResult[]; elapsedMs: number; fp: string }[] = [];
  for (const N of poolSizes) {
    console.log(`\n--- ${label} run N=${N} ---`);
    const r = await runPool(jobIdSeed, candlesByCombo, parsedInputs, tickers, timeframes, randomSamples, N);
    const fp = fingerprint(r.results);
    console.log(`  results: ${r.results.length}, elapsed: ${r.elapsedMs}ms`);
    runs.push({ N, ...r, fp });
  }
  const reference = runs[0];
  let ok = true;
  for (let i = 1; i < runs.length; i++) {
    const cmp = runs[i];
    if (cmp.fp !== reference.fp) {
      ok = false;
      console.error(`\nFAIL [${label}]: N=${cmp.N} diverges from N=${reference.N} for same seed.`);
      console.error(`  N=${reference.N} count=${reference.results.length}`);
      console.error(`  N=${cmp.N} count=${cmp.results.length}`);
      const linesA = reference.fp.split("\n");
      const linesB = cmp.fp.split("\n");
      const max = Math.max(linesA.length, linesB.length);
      for (let j = 0; j < max; j++) {
        if (linesA[j] !== linesB[j]) {
          console.error(`  first diff at index ${j}:`);
          console.error(`    N=${reference.N}: ${linesA[j] ?? "<none>"}`);
          console.error(`    N=${cmp.N}: ${linesB[j] ?? "<none>"}`);
          break;
        }
      }
    } else {
      console.log(`  PASS: N=${cmp.N} matches N=${reference.N} (byte-identical top-K).`);
    }
  }
  return ok;
}

async function main() {
  const startDate = "2025-01-01";
  const endDate = "2025-06-01";

  // Multi-combo scenario (T001c original): exercises per-combo partitioning.
  const multiTickers = ["SOL/USDT:USDT"];
  const multiTfs = ["15m", "2h", "4h"];
  console.log(`Fetching candles for multi-combo scenario (${multiTickers.length * multiTfs.length} combos)…`);
  const multiCandles = await fetchCombos(multiTickers, multiTfs, startDate, endDate);

  // Single-combo scenario (T006): exercises per-config partitioning within
  // a single combo. With 1 combo and pool N>1, the lead handles a subset of
  // slots and merges peer slot results before refinement. Determinism here
  // is the contractual proof that per-slot reseeding + uniform dedup work.
  const singleTickers = ["SOL/USDT:USDT"];
  const singleTfs = ["1h"];
  console.log(`\nFetching candles for single-combo scenario…`);
  const singleCandles = await fetchCombos(singleTickers, singleTfs, startDate, endDate);

  const parsed = parsePineScript(VSS_LIKE);
  const parsedInputs = parsed.inputs;

  const multiOk = await compareRuns(
    "multi-combo",
    "determinism-seed-42",
    multiCandles,
    parsedInputs,
    multiTickers,
    multiTfs,
    50,
    [1, 4],
  );

  const singleOk = await compareRuns(
    "single-combo",
    "determinism-single-seed-7",
    singleCandles,
    parsedInputs,
    singleTickers,
    singleTfs,
    200,
    [1, 2, 4],
  );

  if (multiOk && singleOk) {
    console.log(`\nPASS: all determinism scenarios identical across pool sizes.`);
    process.exit(0);
  }
  console.error(`\nFAIL: determinism violated — see diffs above.`);
  process.exit(2);
}

main().catch(e => { console.error(e); process.exit(1); });
