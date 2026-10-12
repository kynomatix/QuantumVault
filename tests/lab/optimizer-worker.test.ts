import { getPriority } from "node:os";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { WorkerPool } from "../../server/lab/worker-pool";
import { parsePineScript } from "../../server/lab/pine-parser";

const pineScript = `
//@version=5
strategy("EXAMPLE determinism", overlay=true, initial_capital=10000)
vwmaLen = input.int(12, "VWMA Length", minval=5, maxval=30)
emaLen = input.int(5, "EMA Length", minval=3, maxval=15)
vwma = ta.vwma(close, vwmaLen)
emaS = ta.ema(close, emaLen)
if ta.crossover(close, vwma) and emaS > vwma
    strategy.entry("L", strategy.long)
if ta.crossunder(close, vwma) and emaS < vwma
    strategy.entry("S", strategy.short)
`;
const candles = Array.from({ length: 240 }, (_, i) => {
  const close = 100 + 6 * Math.sin(i / 6) + 2 * Math.sin(i / 17);
  return { time: 1700000000000 + i * 3600000, open: close - 0.1, high: close + 0.5, low: close - 0.5, close, volume: 1000 + i };
});

async function runPool(size: number, tickers = ["EXAMPLE"], completedCombos: string[] = []) {
  const messages: any[] = [];
  const path = resolve(process.cwd(), "server/lab/optimizer-worker.ts").replace(/\\/g, "/");
  const pool = new WorkerPool(data => new Worker(
    `require('tsx/cjs'); require(${JSON.stringify(path)}); require('node:worker_threads').parentPort.postMessage({type:'priority-check',value:require('node:os').getPriority()});`,
    { eval: true, workerData: data },
  ), {
    jobId: "EXAMPLE-determinism", randomSeed: 42,
    config: { tickers, timeframes: ["1h"], randomSamples: 12, topK: 3, refinementsPerSeed: 1,
      minTrades: 0, maxDrawdownCap: 100, minAvgBarsHeld: 0, parsedInputs: parsePineScript(pineScript).inputs,
      pineScript, processOrdersOnClose: false, deepSearch: false, coordinateTune: false },
    candlesByCombo: Object.fromEntries(tickers.map(t => [`${t}|1h`, candles])),
    resumeCheckpoint: completedCombos.length ? { completedCombos } : undefined,
  }, size);
  try {
    const done = await new Promise<any>((resolveDone, reject) => {
      pool.on("message", message => {
        messages.push(message);
        if (message.type === "done") resolveDone(message);
        if (message.type === "error") reject(new Error(message.message));
      });
      pool.on("error", reject);
      pool.on("exit", code => { if (code !== 0) reject(new Error(`EXAMPLE worker exit ${code}`)); });
    });
    return { done, messages };
  } finally { await pool.terminate(); }
}

function canonicalResults(results: any[]) {
  // Cross-combo score ties retain arrival order in the existing aggregator.
  // Compare every result field while making only that ordering stable.
  return [...results].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

describe("real optimizer workers", () => {
  it("keeps full deterministic results for single-worker and per-slot pools at nice 19", async () => {
    const parentPriority = getPriority();
    const single = await runPool(1), parallel = await runPool(3);
    expect(single.done.results.length).toBeGreaterThan(0);
    expect(canonicalResults(parallel.done.results)).toEqual(canonicalResults(single.done.results));
    expect(parallel.done.parityMatch).toBe(single.done.parityMatch);
    const priorities = parallel.messages.filter(m => m.type === "priority-check");
    expect(priorities).toHaveLength(3);
    expect(priorities.every(m => m.value === 19)).toBe(true);
    expect(getPriority()).toBe(parentPriority);
  }, 60_000);

  it("keeps results across per-combo pools and skips already completed resume combos", async () => {
    const tickers = ["A", "B", "C"];
    const single = await runPool(1, tickers), parallel = await runPool(3, tickers);
    expect(single.done.results.length).toBeGreaterThan(0);
    expect(canonicalResults(parallel.done.results)).toEqual(canonicalResults(single.done.results));
    const resumed = await runPool(2, tickers, ["A|1h"]);
    expect(canonicalResults(resumed.done.results)).toEqual(canonicalResults(single.done.results.filter((r: any) => r.ticker !== "A")));
    expect(resumed.messages.filter(m => m.type === "combo-complete").map(m => m.combo).sort()).toEqual(["B|1h", "C|1h"]);
  }, 60_000);
});
