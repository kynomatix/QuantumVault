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
  getRunsByIds(ids: number[]): Promise<LabOptimizationRun[]>;
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

  const ownedIds = Array.isArray(task.ownedRunIds) ? task.ownedRunIds : [];
  const runs = ownedIds.length ? await storage.getRunsByIds(ownedIds) : [];

  const buckets: ReconcileBuckets = {
    queued: [], running: [], paused: [], completed: [], failed: [], cancelled: [],
  };
  for (const run of runs) bucketRun(buckets, run);

  // Terminal task: nothing to drive; just stamp the reconcile and report.
  if (TERMINAL_TASK_STATUSES.has(status)) {
    await storage.updateAgentTask(taskId, { lastReconciledAt: now });
    return {
      taskId, activeRunId: null, buckets, interruptedRunIds: [...buckets.paused],
      cancelledQueuedRunIds: [], pendingStop: false, statusChanged: false, status,
    };
  }

  // --- Honour a stop request (CAS-race-safe). ---
  const cancelledQueued: number[] = [];
  const stopRequested = task.cancelRequestedAt != null;
  if (stopRequested && buckets.queued.length) {
    const stillQueued: number[] = [];
    const racedToRunning: number[] = [];
    for (const runId of buckets.queued) {
      const cancelled = await storage.markAgentRunCancelled(runId);
      if (cancelled) {
        cancelledQueued.push(runId);
        continue;
      }
      // CAS lost: the run left `queued` between bucketing and cancel. Reload to
      // see if it actually started — a now-running run must be treated as live,
      // never silently dropped while work continues.
      const [fresh] = await storage.getRunsByIds([runId]);
      if (fresh) {
        const s = mapRunStatusFromDb(fresh.status, (fresh.checkpoint as LabCheckpointLoose | null) ?? null);
        if (s === "running") racedToRunning.push(runId);
        else if (s === "queued") stillQueued.push(runId);
        // any terminal/cancelled state: nothing more to do for this run
      }
    }
    buckets.queued = stillQueued;
    if (cancelledQueued.length) buckets.cancelled.push(...cancelledQueued);
    if (racedToRunning.length) buckets.running.push(...racedToRunning);
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
