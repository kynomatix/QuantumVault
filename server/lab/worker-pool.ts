import { Worker } from "worker_threads";
import { EventEmitter } from "events";
import { availableParallelism } from "os";
import type { LabBacktestResult } from "@shared/schema";

// .local/session_plan.md T001b / T005 — WorkerPool.
//
// Drop-in replacement for the old `activeWorker: Worker | null` singleton in
// routes.ts. Wraps N optimizer-worker threads, partitions work across them,
// forwards/aggregates the existing message protocol so the orchestrator in
// routes.ts doesn't need to know it's now talking to a pool.
//
// Two partitioning modes (T005):
//   * per-combo (default when numCombos >= poolSize): each worker handles a
//     disjoint subset of combos end-to-end (random + refine + deep). This is
//     what T001b shipped and is the most efficient for multi-combo jobs.
//   * per-slot (when numCombos < poolSize): ALL workers process the SAME
//     combos but split the random-search "slot indices" round-robin. The
//     first worker is the lead; non-lead workers stream per-slot results
//     back to the lead via the pool, then the lead runs refinement/deep on
//     the merged result set. This unlocks parallelism for single-combo VSS
//     workloads.
//
// Determinism: under either mode, slot K of combo C is seeded by
// deriveConfigSeed(jobSeed, comboKey, K), and refinement is seeded by
// deriveStageSeed(jobSeed, comboKey, "refine"). The (jobSeed, combo, slot)
// trajectory is therefore identical regardless of pool size or mode — the
// union of top-K results is byte-stable for the same jobSeed across N=1
// and N=4 (proved by test-determinism.ts).

const MAX_POOL_SIZE = 6;

export function recommendedPoolSize(numCombos: number): number {
  const cores = (() => {
    try { return availableParallelism(); } catch { return 4; }
  })();
  const target = Math.max(1, Math.min(MAX_POOL_SIZE, cores - 1));
  // Don't artificially cap by combo count anymore — per-slot partitioning
  // makes single-combo jobs parallelize. Still need ≥1 combo.
  return Math.max(1, numCombos > 0 ? target : 1);
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
  public readonly perSlot: boolean;
  private workers: Worker[] = [];
  private states: WorkerState[];
  private aggregatedResults: LabBacktestResult[] = [];
  private totalConfigsTested: number | undefined = undefined;
  private perWorkerProgress = new Map<number, { current: number; total: number; data: any }>();
  private terminated = false;
  private exitEmitted = false;
  private doneEmitted = false;
  private partitions: string[][];
  private leadIndex = 0;

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

    const requestedN = typeof sizeOverride === "number"
      ? Math.max(1, sizeOverride)
      : recommendedPoolSize(combos.length);
    // We can't have more workers than there is work for either mode:
    // per-combo caps at combos.length; per-slot caps at randomSamples.
    const randomSamples: number = args.config.randomSamples ?? 0;
    const N = Math.max(1, Math.min(requestedN, Math.max(combos.length, randomSamples) || 1));
    this.poolSize = N;

    // Choose partitioning mode. Per-slot kicks in when there aren't enough
    // combos to saturate the pool and there's actual random-search work.
    const perSlot = combos.length > 0 && combos.length < N && randomSamples > 0;
    this.perSlot = perSlot;

    this.states = new Array(N).fill("running");

    // Build per-worker jobs.
    type Job = {
      comboKeys: string[];
      slotsPerCombo: Record<string, number[]> | null;
      isLead: boolean;
      peerCount: number;
      candles: Record<string, any>;
    };
    const jobs: Job[] = [];

    if (perSlot) {
      const slotsByComboByWorker: Record<string, number[][]> = {};
      for (const key of combos) {
        slotsByComboByWorker[key] = Array.from({ length: N }, () => [] as number[]);
        for (let s = 0; s < randomSamples; s++) {
          slotsByComboByWorker[key][s % N].push(s);
        }
      }
      const slimCandles: Record<string, any> = {};
      for (const key of combos) if (args.candlesByCombo[key]) slimCandles[key] = args.candlesByCombo[key];
      for (let i = 0; i < N; i++) {
        const slotsPerCombo: Record<string, number[]> = {};
        for (const key of combos) slotsPerCombo[key] = slotsByComboByWorker[key][i];
        jobs.push({
          comboKeys: [...combos],
          slotsPerCombo,
          isLead: i === 0,
          peerCount: i === 0 ? N - 1 : 0,
          candles: slimCandles,
        });
      }
    } else {
      for (let i = 0; i < N; i++) {
        const partition = combos.filter((_, idx) => idx % N === i);
        const slimCandles: Record<string, any> = {};
        for (const key of partition) if (args.candlesByCombo[key]) slimCandles[key] = args.candlesByCombo[key];
        jobs.push({
          comboKeys: partition,
          slotsPerCombo: null,
          isLead: true,
          peerCount: 0,
          candles: slimCandles,
        });
      }
    }

    this.partitions = jobs.map(j => j.comboKeys);
    this.leadIndex = 0;

    for (let i = 0; i < N; i++) {
      const job = jobs[i];
      const workerData = {
        jobId: args.jobId,
        config: args.config,
        candlesByCombo: job.candles,
        resumeCheckpoint: args.resumeCheckpoint,
        randomSeed: args.randomSeed,
        comboFilter: job.comboKeys,
        slotsPerCombo: job.slotsPerCombo,
        isLead: job.isLead,
        peerCount: job.peerCount,
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
        case "slot-result":
        case "combo-random-done": {
          // T005: in per-slot mode, peers stream per-slot random results
          // back to the lead via the pool so the lead can merge them and
          // run refinement on the full result set.
          if (this.perSlot && idx !== this.leadIndex) {
            const lead = this.workers[this.leadIndex];
            if (lead) {
              const peerMsg = msg.type === "slot-result"
                ? { type: "peer-slot-result", combo: msg.combo, slot: msg.slot, result: msg.result }
                : { type: "peer-combo-random-done", combo: msg.combo };
              try { lead.postMessage(peerMsg); } catch {}
            }
          }
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
    return this.states.every(s => s !== "running");
  }
}
