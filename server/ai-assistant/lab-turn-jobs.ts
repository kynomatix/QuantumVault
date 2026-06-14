// Single-flight, per-task background turn runner for the QuantumLab Lab Assistant
// (Phase C). It is the lab-side sibling of creator-jobs.ts, but the unit of work is
// ONE orchestrator.advance() (start or resume) rather than an LLM chain.
//
// WHY THIS EXISTS: a turn can fan out into several brain calls + tool reads and may
// PARK on an async backtest. Holding the HTTP request open for that long gets reaped
// by the Replit dev proxy / prod load balancer. So the routes start a turn here and
// return 202 immediately; the client polls GET .../messages and POSTs .../step.
//
// SINGLE-FLIGHT: keyed by taskId. The orchestrator's CAS turn-lease is the real
// concurrency guarantee (a second advance() no-ops as "busy"); this store is the
// cheap in-process guard that stops us from spawning a duplicate background promise
// (and a duplicate key decrypt) while one is already advancing the same task.
//
// MEMORY: a bounded Map with a stuck-cap sweep. A turn never blocks forever — every
// brain call has its own timeout and the orchestrator's global loop/spend caps force
// a terminal outcome — so the entry is always removed in the finally.

import type { LabTurnOrchestrator, AdvanceOptions, AdvanceResult } from "../lab-agent/orchestrator";

interface TurnJob {
  taskId: number;
  walletAddress: string;
  startedAt: number;
}

const MAX_JOBS = 200;
// Worst case: maxBrainCalls (16) brain calls, each bounded by its own ~30s timeout,
// across a couple of segments. 8 min is a generous reclaim net for a wedged entry.
const STUCK_CAP_MS = 8 * 60 * 1000;
// A long, non-pausing read segment yields at the segment cap; the loop_count cap
// makes this terminate within a couple of continuations, but bound it defensively.
const MAX_YIELD_CONTINUATIONS = 16;

const jobs = new Map<number, TurnJob>();

function sweep(): void {
  const now = Date.now();
  for (const [taskId, job] of Array.from(jobs.entries())) {
    if (now - job.startedAt > STUCK_CAP_MS) jobs.delete(taskId);
  }
  if (jobs.size > MAX_JOBS) {
    const oldest = Array.from(jobs.values()).sort((a, b) => a.startedAt - b.startedAt);
    for (const j of oldest) {
      if (jobs.size <= MAX_JOBS) break;
      jobs.delete(j.taskId);
    }
  }
}

/** True while a background turn is advancing this task (so /step can no-op cheaply). */
export function isLabTurnRunning(taskId: number): boolean {
  return jobs.has(taskId);
}

export interface StartLabTurnArgs {
  taskId: number;
  walletAddress: string;
  /** Only `.advance` is used; the route passes the shared orchestrator singleton. */
  orchestrator: Pick<LabTurnOrchestrator, "advance">;
  /** Brain (key + model already bound by the caller) + hasKey for the degrade path. */
  opts: AdvanceOptions;
}

/**
 * Start a background turn for `taskId`. Single-flight: returns false (no new job)
 * when one is already running for this task — the caller still returns 202 and the
 * client keeps polling. The background loop continues across pure-compute yields
 * and settles on final/waiting/stopped/halted/error; it can never raise an
 * unhandled rejection and always removes its store entry.
 */
export function startLabTurn(args: StartLabTurnArgs): boolean {
  sweep();
  if (jobs.has(args.taskId)) return false;
  jobs.set(args.taskId, {
    taskId: args.taskId,
    walletAddress: args.walletAddress,
    startedAt: Date.now(),
  });

  void (async () => {
    try {
      let result: AdvanceResult = await args.orchestrator.advance(args.taskId, args.opts);
      // Server-side continuation across segment-cap yields. The turn still PARKS on
      // an async run (waiting) and stops at the global caps; loop_count bounds this.
      let continuations = 0;
      while (result.outcome === "yield" && continuations < MAX_YIELD_CONTINUATIONS) {
        continuations++;
        result = await args.orchestrator.advance(args.taskId, args.opts);
      }
    } catch (err) {
      // A turn shouldn't throw (the orchestrator handles brain/tool errors and
      // releases its lease in a finally), but a DB hiccup could surface here. Log
      // and drop the entry; the client's /step (or next message) re-drives via a
      // fresh job, and the orchestrator reconciles live run state on re-entry.
      console.error(
        `[LabTurnJob] turn ${args.taskId} crashed:`,
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      jobs.delete(args.taskId);
    }
  })();

  return true;
}
