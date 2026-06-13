// QuantumLab Sandbox Agent — task↔run reconciler (Phase A, T6).
//
// The READER half of the §7b reliability spine. The DB is the single source of
// truth: a backtest can finish, fail, or be interrupted while the user is away,
// so the reconciler NEVER trusts in-memory step state — it reads the task's owned
// runs from the DB and brings the task row back into agreement with reality.
//
// Liveness without worker coupling: server/lab/storage.ts already de-zombifies
// stale `running` rows into `paused`/`failed` at startup, so a run still mapped
// `running` here is genuinely live on a fresh worker; a crashed one shows up as
// `paused` (salvageable) or `failed`. The reconciler therefore trusts DB status.
//
// What it does (deterministic, no LLM, no auto-resume):
//  - buckets every owned run by the contract RunStatus (via dto-mappers — the one
//    place that maps raw lab status onto the closed enum),
//  - resyncs activeRunId to the genuinely-live owned run (queued|running) or null,
//  - honours a stop request: cancels owned QUEUED runs (frees the shared worker),
//    leaves RUNNING child-process work alone, and only then moves the task to a
//    clean `stopped` (CAS-race-safe — a queued run that started mid-cancel is
//    treated as live),
//  - enforces the idle-ONLY pause TTL: an awaiting_input task with no live run may
//    expire; a task with work in flight is NEVER evicted
//    (.agents/memory/long-request-proxy-reap.md),
//  - SURFACES interrupted (paused) owned runs for a later phase to decide on
//    resume — it deliberately does NOT auto-resume here.

import type {
  LabAgentTask,
  LabOptimizationRun,
  InsertLabAgentTask,
  LabCheckpoint,
} from "@shared/schema";
import { mapRunStatusFromDb } from "./dto-mappers";
import { TERMINAL_TASK_STATUSES, type TaskStatus } from "./task-store";

/** Idle-only pause TTL (§7b). A running task/run is never evicted by it. */
export const DEFAULT_PAUSE_TTL_MS = 24 * 60 * 60 * 1000;

/** `userCancelled` lives in the checkpoint jsonb but not on the interface type. */
type LabCheckpointLoose = LabCheckpoint & { userCancelled?: boolean };

export interface ReconcilerStorage {
  getAgentTask(id: number): Promise<LabAgentTask | undefined>;
  /** Authoritative owned-run fetch — scoped by wallet + agent_task_id (§8). */
  getAgentRunsForTask(walletAddress: string, agentTaskId: number): Promise<LabOptimizationRun[]>;
  markAgentRunCancelled(id: number): Promise<boolean>;
  updateAgentTask(id: number, patch: Partial<InsertLabAgentTask>): Promise<LabAgentTask | undefined>;
}

export interface ReconcileBuckets {
  queued: number[];
  running: number[];
  paused: number[];
  completed: number[];
  failed: number[];
  cancelled: number[];
}

export interface ReconcileResult {
  taskId: number;
  /** The genuinely-live owned run (running preferred over queued), or null. */
  activeRunId: number | null;
  buckets: ReconcileBuckets;
  /** Paused owned runs — interrupted but salvageable; a later phase decides resume. */
  interruptedRunIds: number[];
  /** Queued owned runs cancelled to honour a stop request. */
  cancelledQueuedRunIds: number[];
  /** Stop requested but a run is still live → task left in pending-stop. */
  pendingStop: boolean;
  statusChanged: boolean;
  status: TaskStatus;
}

function bucketRun(buckets: ReconcileBuckets, run: LabOptimizationRun): void {
  const status = mapRunStatusFromDb(
    run.status,
    (run.checkpoint as LabCheckpointLoose | null) ?? null,
  );
  switch (status) {
    case "queued":
      buckets.queued.push(run.id);
      break;
    case "running":
      buckets.running.push(run.id);
      break;
    case "paused":
      buckets.paused.push(run.id);
      break;
    case "completed":
      buckets.completed.push(run.id);
      break;
    case "cancelled":
      buckets.cancelled.push(run.id);
      break;
    default:
      // failed / stopped / any unmapped → terminal-failed bucket.
      buckets.failed.push(run.id);
      break;
  }
}

/**
 * Reconcile one task against the live DB state of its owned runs. Returns null if
 * the task does not exist; otherwise applies the deterministic state changes and
 * returns what it found/did.
 */
export async function reconcileTask(
  storage: ReconcilerStorage,
  taskId: number,
  opts?: { pauseTtlMs?: number; now?: Date },
): Promise<ReconcileResult | null> {
  const task = await storage.getAgentTask(taskId);
  if (!task) return null;

  const now = opts?.now ?? new Date();
  const pauseTtlMs = opts?.pauseTtlMs ?? DEFAULT_PAUSE_TTL_MS;
  const status = task.status as TaskStatus;

  // Source of truth = the run rows themselves (agent_task_id + agent_owned),
  // wallet-scoped (§8). The task's ownedRunIds JSON is a cache the enqueue path
  // doesn't populate, so it is self-healed below, never read as the run set.
  const runs = await storage.getAgentRunsForTask(task.walletAddress, taskId);
  const ownedRunIds = runs.map((r) => r.id);

  const buckets: ReconcileBuckets = {
    queued: [], running: [], paused: [], completed: [], failed: [], cancelled: [],
  };
  for (const run of runs) bucketRun(buckets, run);

  // Terminal task: nothing to drive; stamp the reconcile, self-heal the cache.
  if (TERMINAL_TASK_STATUSES.has(status)) {
    await storage.updateAgentTask(taskId, { lastReconciledAt: now, ownedRunIds });
    return {
      taskId, activeRunId: null, buckets, interruptedRunIds: [...buckets.paused],
      cancelledQueuedRunIds: [], pendingStop: false, statusChanged: false, status,
    };
  }

  // --- Honour a stop request (CAS-race-safe). ---
  const cancelledQueued: number[] = [];
  const stopRequested = task.cancelRequestedAt != null;
  if (stopRequested && buckets.queued.length) {
    const casLost: number[] = [];
    for (const runId of buckets.queued) {
      const cancelled = await storage.markAgentRunCancelled(runId);
      if (cancelled) cancelledQueued.push(runId);
      else casLost.push(runId); // left 'queued' mid-cancel — recheck below
    }
    buckets.queued = [];
    if (cancelledQueued.length) buckets.cancelled.push(...cancelledQueued);

    // One authoritative re-read settles every CAS-loser into its TRUE bucket so
    // the census stays complete (bucket-every-owned-run invariant): a run that
    // actually started is treated as live (never silently dropped while work
    // runs); one transiently still 'queued' is retried next pass; a terminal
    // one (completed/failed/cancelled) is recorded, not lost.
    if (casLost.length) {
      const fresh = await storage.getAgentRunsForTask(task.walletAddress, taskId);
      const byId = new Map(fresh.map((r) => [r.id, r]));
      for (const runId of casLost) {
        const r = byId.get(runId);
        if (r) bucketRun(buckets, r);
      }
    }
  }

  // Running is preferred over queued for the one-active-run pointer.
  const liveRunId = buckets.running[0] ?? buckets.queued[0] ?? null;

  // --- Decide the new status. ---
  let newStatus: TaskStatus = status;
  let pendingStop = false;

  if (stopRequested) {
    if (buckets.running.length === 0 && buckets.queued.length === 0) {
      newStatus = "stopped"; // no live work left → clean stop
    } else {
      pendingStop = true; // a run is still live; finish the stop next pass
    }
  } else if (status === "awaiting_input") {
    // Idle-ONLY TTL. Never evict while a run is live (long-request-proxy-reap).
    const awaitingMs = task.awaitingSince ? new Date(task.awaitingSince).getTime() : null;
    const idleExpired = awaitingMs != null && now.getTime() - awaitingMs >= pauseTtlMs;
    if (idleExpired && liveRunId == null) newStatus = "stopped";
  }

  const movingToStopped = newStatus === "stopped";
  const patch: Partial<InsertLabAgentTask> = {
    activeRunId: movingToStopped ? null : liveRunId,
    lastReconciledAt: now,
    ownedRunIds, // self-heal the denormalized cache to the authoritative set
  };
  const statusChanged = newStatus !== status;
  if (statusChanged) patch.status = newStatus;
  if (movingToStopped) {
    patch.stopReason = task.stopReason ?? (stopRequested ? "user_cancelled" : "idle_timeout");
  }

  await storage.updateAgentTask(taskId, patch);

  return {
    taskId,
    activeRunId: patch.activeRunId ?? null,
    buckets,
    interruptedRunIds: [...buckets.paused],
    cancelledQueuedRunIds: cancelledQueued,
    pendingStop,
    statusChanged,
    status: newStatus,
  };
}
