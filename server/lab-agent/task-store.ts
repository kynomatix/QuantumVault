// QuantumLab Sandbox Agent — task state machine (Phase A, T6).
//
// The lifecycle WRITER half of the §7b reliability spine. It owns:
//  - the closed status-transition graph (a task can only move along legal edges),
//  - the one-active-task-per-wallet leash (§7), enforced atomically by storage,
//  - wallet-scoped reads (cross-wallet leak guard, §8 —
//    .agents/memory/cross-wallet-session-leak.md),
//  - owned-run bookkeeping (the run ids the reconciler reads as source of truth).
//
// reconciler.ts is the READER half: it drives most transitions FROM the DB. There
// is no LLM and no chat here — this is the plumbing a later phase's brain drives.

import type { LabAgentTask, InsertLabAgentTask } from "@shared/schema";

/** Mirrors `lab_agent_tasks.status`. */
export type TaskStatus =
  | "active"
  | "awaiting_input"
  | "paused"
  | "completed"
  | "stopped"
  | "failed";

/** Mirrors `lab_agent_tasks.mode` (the schema's values — NOT the plan's older "watched|handsoff"). */
export type TaskMode = "chat" | "auto";

/** No more work will ever happen on a task in one of these states. */
export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "completed",
  "stopped",
  "failed",
]);

/** Non-terminal statuses count against the one-active-task-per-wallet leash (§7). */
export const ACTIVE_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "active",
  "awaiting_input",
  "paused",
]);

/**
 * The closed transition graph: each status maps to the set it may legally move
 * to. Terminal statuses map to the empty set — once a task is done it never
 * re-opens; a new task is created instead.
 */
export const TASK_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  active: new Set<TaskStatus>(["awaiting_input", "paused", "completed", "stopped", "failed"]),
  awaiting_input: new Set<TaskStatus>(["active", "paused", "completed", "stopped", "failed"]),
  paused: new Set<TaskStatus>(["active", "stopped", "failed"]),
  completed: new Set<TaskStatus>([]),
  stopped: new Set<TaskStatus>([]),
  failed: new Set<TaskStatus>([]),
};

/** Re-asserting the same status is a legal no-op (idempotent terminal writes). */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return TASK_TRANSITIONS[from]?.has(to) ?? false;
}

// ---------------------------------------------------------------------------
// Storage seam — the narrow slice of ILabStorage the task store needs.
// ---------------------------------------------------------------------------

export interface TaskStoreStorage {
  createAgentTaskExclusive(
    data: InsertLabAgentTask,
  ): Promise<{ created: LabAgentTask } | { conflict: LabAgentTask }>;
  getAgentTask(id: number): Promise<LabAgentTask | undefined>;
  updateAgentTask(id: number, patch: Partial<InsertLabAgentTask>): Promise<LabAgentTask | undefined>;
}

export type CreateTaskResult =
  | { ok: true; task: LabAgentTask }
  | { ok: false; reason: "active_task_exists"; existing: LabAgentTask };

export type TransitionResult =
  | { ok: true; task: LabAgentTask }
  | { ok: false; reason: "not_found" | "forbidden" }
  | { ok: false; reason: "invalid_transition"; from: TaskStatus; to: TaskStatus };

export type MutateResult =
  | { ok: true; task: LabAgentTask }
  | { ok: false; reason: "not_found" | "forbidden" };

// ---------------------------------------------------------------------------
// TaskStore
// ---------------------------------------------------------------------------

export class TaskStore {
  constructor(
    private readonly storage: TaskStoreStorage,
    /** Injectable clock keeps the TTL/timestamp logic deterministic under test. */
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Create a task under the one-active-task-per-wallet leash. Returns
   * `active_task_exists` (with the offending task) instead of a second concurrent
   * task — the atomicity lives in storage's advisory-locked exclusive insert.
   */
  async create(input: {
    walletAddress: string;
    goal?: string | null;
    mode?: TaskMode;
    toolkitVersion?: number;
  }): Promise<CreateTaskResult> {
    const data: InsertLabAgentTask = {
      walletAddress: input.walletAddress,
      status: "active",
      mode: input.mode ?? "chat",
      goal: input.goal ?? null,
      ...(input.toolkitVersion != null ? { toolkitVersion: input.toolkitVersion } : {}),
    };
    const res = await this.storage.createAgentTaskExclusive(data);
    if ("conflict" in res) {
      return { ok: false, reason: "active_task_exists", existing: res.conflict };
    }
    return { ok: true, task: res.created };
  }

  /** Wallet-scoped read — returns undefined if the task isn't this wallet's. */
  async get(id: number, walletAddress: string): Promise<LabAgentTask | undefined> {
    const task = await this.storage.getAgentTask(id);
    if (!task || task.walletAddress !== walletAddress) return undefined;
    return task;
  }

  /**
   * Move a task along a legal edge. `awaitingSince` (the basis for the idle-only
   * pause TTL, §7b) is set on entry to `awaiting_input` and cleared on exit.
   * Entering a terminal status clears `activeRunId`.
   */
  async transition(
    id: number,
    walletAddress: string,
    to: TaskStatus,
    opts?: { stopReason?: string | null },
  ): Promise<TransitionResult> {
    const task = await this.storage.getAgentTask(id);
    if (!task) return { ok: false, reason: "not_found" };
    if (task.walletAddress !== walletAddress) return { ok: false, reason: "forbidden" };

    const from = task.status as TaskStatus;
    if (!canTransition(from, to)) return { ok: false, reason: "invalid_transition", from, to };

    const now = this.clock();
    const patch: Partial<InsertLabAgentTask> = { status: to };
    if (to === "awaiting_input") patch.awaitingSince = now;
    else if (from === "awaiting_input") patch.awaitingSince = null;
    if (opts?.stopReason !== undefined) patch.stopReason = opts.stopReason;
    if (TERMINAL_TASK_STATUSES.has(to)) patch.activeRunId = null;

    const updated = await this.storage.updateAgentTask(id, patch);
    if (!updated) return { ok: false, reason: "not_found" };
    return { ok: true, task: updated };
  }

  /**
   * Mark a stop intent. Does NOT change status — a run may still be live and the
   * main process can't force-kill child-process work; the reconciler finishes the
   * stop once no owned run is live. Idempotent and a no-op on terminal tasks.
   */
  async requestStop(id: number, walletAddress: string, reason?: string): Promise<MutateResult> {
    const task = await this.storage.getAgentTask(id);
    if (!task) return { ok: false, reason: "not_found" };
    if (task.walletAddress !== walletAddress) return { ok: false, reason: "forbidden" };
    if (TERMINAL_TASK_STATUSES.has(task.status as TaskStatus)) return { ok: true, task };

    const patch: Partial<InsertLabAgentTask> = {
      cancelRequestedAt: task.cancelRequestedAt ?? this.clock(),
    };
    if (reason !== undefined) patch.stopReason = reason;
    const updated = await this.storage.updateAgentTask(id, patch);
    return { ok: true, task: updated ?? task };
  }

  /**
   * Record a run this task owns (dedup-appended to `ownedRunIds` — the set the
   * reconciler reads as source of truth). `active:true` also points
   * `activeRunId` at it (the one-active-run gate, §7).
   */
  async addOwnedRun(
    id: number,
    walletAddress: string,
    runId: number,
    opts?: { active?: boolean },
  ): Promise<MutateResult> {
    const task = await this.storage.getAgentTask(id);
    if (!task) return { ok: false, reason: "not_found" };
    if (task.walletAddress !== walletAddress) return { ok: false, reason: "forbidden" };

    const owned = Array.isArray(task.ownedRunIds) ? task.ownedRunIds : [];
    const ownedRunIds = owned.includes(runId) ? owned : [...owned, runId];
    const patch: Partial<InsertLabAgentTask> = { ownedRunIds };
    if (opts?.active) patch.activeRunId = runId;
    const updated = await this.storage.updateAgentTask(id, patch);
    return { ok: true, task: updated ?? task };
  }
}
