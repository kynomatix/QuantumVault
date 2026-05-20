import { Worker } from "worker_threads";
import { resolve } from "path";
import { fetchOHLCV } from "../datafeed";
import { WorkerPool } from "../worker-pool";
import { parsePineScript } from "../pine-parser";
import { hashStringToSeed } from "../rng";
import type { OHLCV } from "../engine";

const VSS_LIKE = `
//@version=5
strategy("VSS-bench", overlay=true, initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=100)
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

async function runPool(
  jobId: string,
  candlesByCombo: Record<string, OHLCV[]>,
  parsedInputs: any[],
  tickers: string[],
  timeframes: string[],
  randomSamples: number,
  poolSize: number,
): Promise<number> {
  const start = Date.now();
  const pool = new WorkerPool(
    spawnRawWorker,
    {
      jobId,
      config: {
        tickers, timeframes, randomSamples, topK: 10,
        refinementsPerSeed: 3, minTrades: 0, maxDrawdownCap: 100, minAvgBarsHeld: 0,
        parsedInputs, processOrdersOnClose: false,
        deepSearch: false, coordinateTune: false, pineScript: VSS_LIKE,
      },
      candlesByCombo,
      randomSeed: hashStringToSeed(jobId),
    },
    poolSize,
  );
  return new Promise((resolveP, rejectP) => {
    pool.on("message", (msg: any) => {
      if (msg.type === "done") resolveP(Date.now() - start);
      else if (msg.type === "error") rejectP(new Error(msg.message));
    });
    pool.on("error", (err) => rejectP(err));
  });
}

async function main() {
  // T007: single-combo real-workload bench. Exercises per-config slot
  // partitioning within a single combo (T005). 1 ticker × 1 timeframe ×
  // 500 random samples — same seed across pool sizes.
  const tickers = ["SOL/USDT:USDT"];
  const timeframes = ["15m"];
  const startDate = "2025-01-01";
  const endDate = "2025-06-01";

  console.log(`Fetching candles…`);
  const candlesByCombo: Record<string, OHLCV[]> = {};
  for (const t of tickers) for (const tf of timeframes) {
    const candles = await fetchOHLCV(t, tf, startDate, endDate);
    candlesByCombo[`${t}|${tf}`] = candles ?? [];
    console.log(`  ${t} ${tf}: ${candles?.length ?? 0} bars`);
  }

  const parsed = parsePineScript(VSS_LIKE);
  const RAND_SAMPLES = 500;
  const seedJobId = "bench-seed-single-500";

  console.log(`\nMeasuring ${RAND_SAMPLES}-config job, ${tickers.length * timeframes.length} combo (single-combo per-slot partitioning)…`);

  const results: { N: number; ms: number }[] = [];
  for (const N of [1, 2, 4]) {
    const ms = await runPool(seedJobId, candlesByCombo, parsed.inputs, tickers, timeframes, RAND_SAMPLES, N);
    console.log(`  N=${N}: ${ms}ms`);
    results.push({ N, ms });
  }

  console.log(`\n--- Speedup table (baseline N=1) ---`);
  const baseline = results[0].ms;
  for (const r of results) {
    const speedup = (baseline / r.ms).toFixed(2);
    const eff = ((baseline / r.ms) / r.N * 100).toFixed(0);
    console.log(`  N=${r.N}: ${r.ms}ms  speedup=${speedup}x  efficiency=${eff}%`);
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
