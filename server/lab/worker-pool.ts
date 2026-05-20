import { Worker } from "worker_threads";
import { EventEmitter } from "events";
import { availableParallelism } from "os";
import type { LabBacktestResult } from "@shared/schema";

// .local/session_plan.md T001b — WorkerPool.
//
// Drop-in replacement for the old `activeWorker: Worker | null` singleton in
// routes.ts. Wraps N optimizer-worker threads, partitions combos round-robin
// across them, forwards/aggregates the existing message protocol so the
// orchestrator in routes.ts doesn't need to know it's now talking to a pool.
//
// Determinism: combo partition is by index modulo N. Each worker reseeds
// its PRNG per combo using deriveComboSeed(jobSeed, comboKey), so the
// random search for any given (jobSeed, combo) is identical regardless of
// which pool member processes it. Union of top-K results is therefore
// stable across pool sizes for the same jobSeed.

const MAX_POOL_SIZE = 6;

export function recommendedPoolSize(numCombos: number): number {
  const cores = (() => {
    try { return availableParallelism(); } catch { return 4; }
  })();
  const target = Math.max(1, Math.min(MAX_POOL_SIZE, cores - 1));
  return Math.max(1, Math.min(target, numCombos || 1));
}

type WorkerState = "running" | "done" | "errored";

export interface PoolSpawnArgs {
  jobId: string;
  config: any;
  candlesByCombo: Record<string, any>;
  resumeCheckpoint?: any;
  randomSeed: number;
}

function scoreFinal(r: LabBacktestResult): number {
  const dd = r.maxDrawdownPercent;
  const safeMaxLev = dd > 0 ? Math.min(20, 80 / dd) : 20;
  const leveragedProfit = r.netProfitPercent * safeMaxLev;
  return leveragedProfit * 100 + r.winRatePercent * 10 + r.profitFactor * 50 - dd * 50;
}

export class WorkerPool extends EventEmitter {
  public readonly poolSize: number;
  private workers: Worker[] = [];
  private states: WorkerState[];
  private aggregatedResults: LabBacktestResult[] = [];
  private totalConfigsTested: number | undefined = undefined;
  private perWorkerProgress = new Map<number, { current: number; total: number; data: any }>();
  private terminated = false;
  private exitEmitted = false;
  private doneEmitted = false;
  private partitions: string[][];

  constructor(
    private readonly spawnFn: (workerData: any) => Worker,
    private readonly args: PoolSpawnArgs,
    sizeOverride?: number,
  ) {
    super();

    const tickers: string[] = args.config.tickers || [];
    const timeframes: string[] = args.config.timeframes || [];
    const combos: string[] = [];
    for (const t of tickers) for (const tf of timeframes) combos.push(`${t}|${tf}`);
    const N = typeof sizeOverride === "number"
      ? Math.max(1, Math.min(sizeOverride, combos.length || 1))
      : recommendedPoolSize(combos.length);
    this.poolSize = N;
    this.states = new Array(N).fill("running");
    this.partitions = new Array(N).fill(null).map((_, i) => combos.filter((_, idx) => idx % N === i));

    for (let i = 0; i < N; i++) {
      const partition = this.partitions[i];
      // Slim candlesByCombo to this worker's combos to save memory.
      const slimCandles: Record<string, any> = {};
      for (const key of partition) {
        if (args.candlesByCombo[key]) slimCandles[key] = args.candlesByCombo[key];
      }
      const workerData = {
        jobId: args.jobId,
        config: args.config,
        candlesByCombo: slimCandles,
        resumeCheckpoint: args.resumeCheckpoint,
        randomSeed: args.randomSeed,
        comboFilter: partition,
      };
      let w: Worker;
      try {
        w = this.spawnFn(workerData);
      } catch (err: any) {
        this.states[i] = "errored";
        queueMicrotask(() => this.emit("error", err));
        continue;
      }
      this.workers.push(w);
      this.attach(w, i);
    }

    // Edge case: zero combos / zero workers — emit done immediately.
    if (this.workers.length === 0) {
      queueMicrotask(() => {
        if (this.doneEmitted) return;
        this.doneEmitted = true;
        this.emit("message", { type: "done", results: [] });
        this.exitEmitted = true;
        this.emit("exit", 0);
      });
    }
  }

  postMessage(msg: any): void {
    for (const w of this.workers) {
      try { w.postMessage(msg); } catch {}
    }
  }

  async terminate(): Promise<void> {
    this.terminated = true;
    await Promise.all(this.workers.map(w => w.terminate().catch(() => 0)));
  }

  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  private attach(w: Worker, idx: number): void {
    w.on("message", (msg: any) => {
      switch (msg?.type) {
        case "progress": {
          const cur = msg.data?.current ?? 0;
          const tot = msg.data?.total ?? 0;
          this.perWorkerProgress.set(idx, { current: cur, total: tot, data: msg.data });
          this.emit("message", this.synthesizeProgress(msg));
          break;
        }
        case "done": {
          if (this.states[idx] === "done") break;
          this.states[idx] = "done";
          if (Array.isArray(msg.results)) this.aggregatedResults.push(...msg.results);
          if (typeof msg.totalConfigsTested === "number") {
            this.totalConfigsTested = (this.totalConfigsTested ?? 0) + msg.totalConfigsTested;
          }
          if (this.allFinished() && !this.doneEmitted) {
            this.doneEmitted = true;
            this.aggregatedResults.sort((a, b) => scoreFinal(b) - scoreFinal(a));
            this.emit("message", {
              type: "done",
              results: this.aggregatedResults,
              totalConfigsTested: this.totalConfigsTested,
            });
          }
          break;
        }
        case "error": {
          this.states[idx] = "errored";
          this.emit("message", msg);
          break;
        }
        default:
          // partial-checkpoint, combo-complete, best-discovery — forward verbatim.
          this.emit("message", msg);
      }
    });

    w.on("error", (err: Error) => {
      this.states[idx] = "errored";
      this.emit("error", err);
    });

    w.on("exit", (code: number) => {
      if (this.states[idx] === "running") this.states[idx] = "errored";
      if (this.allExited() && !this.exitEmitted) {
        this.exitEmitted = true;
        const allDone = this.states.every(s => s === "done") && !this.terminated;
        const firstBadCode = allDone ? 0 : (code === 0 ? 1 : code);
        this.emit("exit", firstBadCode);
      }
    });
  }

  private synthesizeProgress(latest: any): any {
    let curSum = 0;
    let totSum = 0;
    this.perWorkerProgress.forEach(p => {
      curSum += p.current;
      totSum += p.total;
    });
    const baseData = latest?.data ?? {};
    const percent = totSum > 0 ? Math.min(99, Math.round((curSum / totSum) * 100)) : 0;
    return { type: "progress", data: { ...baseData, current: curSum, total: totSum, percent } };
  }

  private allFinished(): boolean {
    return this.states.every(s => s !== "running");
  }
  private allExited(): boolean {
    // After all workers reached a terminal state, treat the pool as exited.
    // Worker thread "exit" events arrive after "message: done", so we still
    // emit a pool-level exit once every member has reported.
    return this.states.every(s => s !== "running");
  }
}
