// QuantumLab Lab Assistant — Phase C turn orchestrator.
//
// This is the brain-driven turn loop that sits between the HTTP route (which only
// starts/resumes a turn and polls) and the deterministic toolkit. It is a SINGLE
// pure-ish engine with injected seams (storage, toolkit, brain, reconcile,
// composeReply, cost estimator, clock, token gen) so the whole thing is unit
// testable with fakes — no DB, no network.
//
// DESIGN INVARIANTS (architect-confirmed, docs/LAB_AGENT_SANDBOX_PLAN.md §7):
//   - SINGLE-FLIGHT: a CAS turn lease means two concurrent advance() calls run at
//     most ONE turn; the loser no-ops. Expiry lets a crashed turn be reclaimed.
//   - CRASH-SAFE / NO DOUBLE-SPEND: before an async (run-queuing) tool we persist
//     current_step={phase:'executing',…} and inject a DETERMINISTIC idempotency key
//     derived from (taskId, stepIndex, tool, canonical args). On recovery we replay
//     the STORED tool (not the brain); the adapter's (wallet,taskId,key) dedupe means
//     a replay can never enqueue a second run. step_index only advances once a step
//     is fully consumed (its run reaches a terminal state), so the key is stable.
//   - DB IS SOURCE OF TRUTH: reconcileTask runs at the START of every advance() (so
//     both a fresh turn and a /step resume see live run state); if the task is
//     terminal or a stop was requested we do NOT call the brain.
//   - BOUNDED: one global per-turn brain-call cap (persisted as loop_count) and a
//     hard per-task spend cap. Malformed-decision and tool-error repair budgets are
//     local/consecutive and each repair attempt still counts toward the global cap.
//   - CLIENT-DRIVEN RESUME: an async tool parks the turn in 'waiting_for_tool' and
//     returns; the client polls and POSTs /step, which re-enters advance() to fold
//     the finished run and let the brain continue. The resume LLM cost is expected.

import { createHash } from "crypto";
import type {
  LabAgentTask,
  LabAgentMessage,
  InsertLabAgentTask,
  AgentSuggestedAction,
} from "@shared/schema";
import type { RunQueuedDto, RunStatusDto } from "@shared/lab-agent-contract";
import { TERMINAL_RUN_STATUSES } from "@shared/lab-agent-contract";
import type { ILabStorage } from "../lab/storage";
import type { LabAgentToolkit, ToolkitContext } from "./toolkit";
import {
  ASYNC_TOOLS,
  MalformedDecisionError,
  type BrainFn,
  type BrainTurnContext,
  type WorkingTool,
} from "./chat-brain";

// --- tunables (§7; per docs §13 these are the safety nets, not budgets) ----------
const LEASE_MS = 4 * 60_000; // covers one advance() segment's worst-case brain calls

/** The leash limits. Injectable so they can be tuned (env) and unit-tested cheaply. */
export interface OrchestratorLimits {
  maxBrainCalls: number; // GLOBAL per-turn cap (persisted via loop_count)
  maxSegmentIterations: number; // local: bound a single advance() before yielding
  hardSpendCapUsd: number; // per-task runaway net (matches the C0 chat cap)
  maxMalformedRetries: number; // consecutive malformed decisions before degrade
  maxToolErrorRetries: number; // consecutive tool failures before degrade
}
const DEFAULT_LIMITS: OrchestratorLimits = {
  maxBrainCalls: 16,
  maxSegmentIterations: 10,
  hardSpendCapUsd: 2.0,
  maxMalformedRetries: 2,
  maxToolErrorRetries: 3,
};

const LEDGER_CAP = 40; // bound the working-memory step ledger
const TOOL_RESULT_CHARS = 1800; // cap a folded tool result in the transcript
const RECENT_MESSAGES = 24; // transcript window handed to the brain

// A task is terminal when it can no longer think. Mirrors task-store's set but kept
// local so the orchestrator does not depend on the auto-loop task store.
const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(["completed", "stopped", "failed"]);

// --- persisted shapes (stored in lab_agent_tasks jsonb columns) ------------------

/** The agent's small structured working memory (task.memory jsonb). */
export interface OrchestratorMemory {
  currentStrategyId?: number | null;
  ledger: LedgerEntry[];
}
interface LedgerEntry {
  step: number;
  tool?: string;
  ok?: boolean;
  summary: string;
}

/** The plan checklist (task.plan jsonb). */
interface OrchestratorPlan {
  steps: string[];
  note?: string;
  updatedAt: string;
}

/**
 * The two-phase async-step record (task.current_step jsonb). 'executing' is written
 * BEFORE the queuing call so a crash replays the stored tool; 'waiting' holds the
 * queued run while the turn is parked. Null when no async step is pending.
 */
type CurrentStep =
  | { phase: "executing"; stepIndex: number; tool: WorkingTool; args: Record<string, unknown> }
  | { phase: "waiting"; stepIndex: number; tool: WorkingTool; runId: number; correlationId?: string };

// --- public surface --------------------------------------------------------------

export type AdvanceOutcome =
  | "busy" // lost the single-flight lease; another runner owns the turn
  | "gone" // the task no longer exists
  | "final" // the brain finished the turn with a reply
  | "waiting" // parked on an async run; the client should POST /step
  | "stopped" // task terminal or stop requested; brain not called
  | "halted_iterations" // hit the global brain-call cap; degraded
  | "halted_spend" // hit the hard spend cap; degraded
  | "halted_malformed" // ran out of malformed-decision repair budget; degraded
  | "halted_tool_errors" // ran out of tool-error repair budget; degraded
  | "error" // brain transport error; degraded
  | "yield"; // segment cap reached; client should re-poll/step

export interface AdvanceResult {
  outcome: AdvanceOutcome;
  runId?: number;
}

export interface AdvanceOptions {
  /** The brain seam, with the user's key + model already bound by the caller (job). */
  brain: BrainFn;
  /** Whether the wallet has a saved key — feeds the deterministic degrade reply. */
  hasKey: boolean;
}

/** The storage subset the orchestrator touches. LabStorage satisfies it structurally. */
export type OrchestratorStorage = Pick<
  ILabStorage,
  | "claimTurnLease"
  | "releaseTurnLease"
  | "getAgentTask"
  | "updateAgentTask"
  | "incrementAgentTaskSpend"
  | "createAgentMessageForWallet"
  | "listRecentAgentMessagesForWallet"
>;

export interface OrchestratorDeps {
  storage: OrchestratorStorage;
  /** Only `.call` is used; tests pass a structural fake. */
  toolkit: Pick<LabAgentToolkit, "call">;
  /** Wraps reconcileTask(storage, taskId); the result is ignored (we re-read the task). */
  reconcile: (taskId: number) => Promise<unknown>;
  /** Deterministic shell reply — the source of client chips AND the degrade fallback. */
  composeReply: (
    userContent: string,
    hasKey: boolean,
  ) => { content: string; suggestedActions: AgentSuggestedAction[] };
  /** Live per-call USD estimate; null = unknown (record nothing). */
  estimateCost?: (model: string, promptTokens: number, completionTokens: number) => Promise<number | null>;
  /** Override any leash limit; omitted fields fall back to DEFAULT_LIMITS. */
  limits?: Partial<OrchestratorLimits>;
  now?: () => Date;
  genToken?: () => string;
}

// --- helpers (pure) --------------------------------------------------------------

/** Stable, key-sorted JSON minus idempotencyKey, so a replay derives the same key. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      if (k === "idempotencyKey") continue;
      out[k] = canonicalize(src[k]);
    }
    return out;
  }
  return value;
}

function deriveIdempotencyKey(
  taskId: number,
  stepIndex: number,
  tool: string,
  args: Record<string, unknown>,
): string {
  const canonical = JSON.stringify(canonicalize(args));
  return createHash("sha256").update(`${taskId}:${stepIndex}:${tool}:${canonical}`).digest("hex");
}

function capJson(data: unknown, max: number): string {
  let s: string;
  try {
    s = JSON.stringify(data);
  } catch {
    s = String(data);
  }
  if (typeof s !== "string") s = String(s);
  return s.length <= max ? s : `${s.slice(0, max)}…(truncated)`;
}

function sortedChronological(messages: LabAgentMessage[]): LabAgentMessage[] {
  return [...messages].sort((a, b) => {
    const at = a.createdAt instanceof Date ? a.createdAt.getTime() : new Date(a.createdAt).getTime();
    const bt = b.createdAt instanceof Date ? b.createdAt.getTime() : new Date(b.createdAt).getTime();
    return at !== bt ? at - bt : a.id - b.id;
  });
}

function lastUserContent(messages: LabAgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return "";
}

function readMemory(task: LabAgentTask): OrchestratorMemory {
  const raw = task.memory as Partial<OrchestratorMemory> | null | undefined;
  const ledger = Array.isArray(raw?.ledger) ? (raw!.ledger as LedgerEntry[]) : [];
  return {
    currentStrategyId: typeof raw?.currentStrategyId === "number" ? raw!.currentStrategyId : null,
    ledger,
  };
}

function readPlan(task: LabAgentTask): OrchestratorPlan | null {
  const raw = task.plan as Partial<OrchestratorPlan> | null | undefined;
  if (raw && Array.isArray(raw.steps)) {
    return { steps: raw.steps as string[], note: raw.note, updatedAt: raw.updatedAt ?? "" };
  }
  return null;
}

function renderMemoryDigest(memory: OrchestratorMemory, plan: OrchestratorPlan | null): string {
  const parts: string[] = [];
  if (memory.currentStrategyId) parts.push(`Current strategy: #${memory.currentStrategyId}`);
  if (plan?.steps.length) {
    parts.push(`Plan:\n${plan.steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`);
  }
  if (memory.ledger.length) {
    const recent = memory.ledger.slice(-8);
    parts.push(
      `Recent steps:\n${recent
        .map((e) => `  - [${e.step}] ${e.tool ?? ""}${e.ok === false ? " FAILED" : ""}: ${e.summary}`)
        .join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

// --- the orchestrator ------------------------------------------------------------

export class LabTurnOrchestrator {
  private readonly storage: OrchestratorStorage;
  private readonly toolkit: Pick<LabAgentToolkit, "call">;
  private readonly reconcile: (taskId: number) => Promise<unknown>;
  private readonly composeReply: OrchestratorDeps["composeReply"];
  private readonly estimateCost?: OrchestratorDeps["estimateCost"];
  private readonly limits: OrchestratorLimits;
  private readonly now: () => Date;
  private readonly genToken: () => string;

  constructor(deps: OrchestratorDeps) {
    this.storage = deps.storage;
    this.toolkit = deps.toolkit;
    this.reconcile = deps.reconcile;
    this.composeReply = deps.composeReply;
    this.estimateCost = deps.estimateCost;
    this.limits = { ...DEFAULT_LIMITS, ...(deps.limits ?? {}) };
    this.now = deps.now ?? (() => new Date());
    this.genToken = deps.genToken ?? (() => createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex"));
  }

  /**
   * Start OR resume a turn for `taskId`. Single entry point for both the initial
   * POST .../messages (start) and POST .../step (resume) — the persisted turn state
   * decides what actually happens. Acquires the CAS lease; the loser no-ops ("busy").
   */
  async advance(taskId: number, opts: AdvanceOptions): Promise<AdvanceResult> {
    const token = this.genToken();
    const claimed = await this.storage.claimTurnLease(taskId, token, LEASE_MS, this.now());
    if (!claimed) return { outcome: "busy" };
    try {
      return await this.runSegment(taskId, opts);
    } finally {
      await this.storage.releaseTurnLease(taskId, token);
    }
  }

  // One leased segment: loops until the turn finishes (final/degrade), parks on an
  // async run (waiting), is stopped, or yields at the segment cap.
  private async runSegment(taskId: number, opts: AdvanceOptions): Promise<AdvanceResult> {
    // Reconcile at the START of every segment so both a fresh turn and a /step
    // resume act on live run state (DB is source of truth, §7b).
    await this.safeReconcile(taskId);

    let segmentIters = 0;
    let malformedStreak = 0;
    let toolErrorStreak = 0;

    while (true) {
      const task = await this.storage.getAgentTask(taskId);
      if (!task) return { outcome: "gone" };

      // Honor stop/terminal WITHOUT calling the brain.
      if (TERMINAL_TASK_STATUSES.has(task.status) || task.cancelRequestedAt) {
        await this.finishTurn(taskId);
        return { outcome: "stopped" };
      }

      // Mark the turn running on first useful iteration.
      if (task.turnState !== "running_turn") {
        await this.storage.updateAgentTask(taskId, {
          turnState: "running_turn",
          turnStateChangedAt: this.now(),
        });
      }

      // --- pending step takes priority over asking the brain --------------------
      const step = task.currentStep as CurrentStep | null;
      if (step?.phase === "executing") {
        // Crash replay: re-run the STORED async tool (idempotency key in the args
        // makes the adapter dedupe), never the brain.
        const replayed = await this.executeAsyncTool(task, step.tool, step.args, step.stepIndex);
        if (replayed.outcome === "waiting") return { outcome: "waiting", runId: replayed.runId };
        if (replayed.outcome === "tool_error") {
          // The replay failed cleanly; clear it and let the brain re-decide.
          toolErrorStreak++;
          if (toolErrorStreak > this.limits.maxToolErrorRetries) {
            await this.degrade(task, opts.hasKey);
            return { outcome: "halted_tool_errors" };
          }
        }
        continue;
      }
      if (step?.phase === "waiting") {
        const res = await this.toolkit.call(this.ctx(task), "getRunStatus", { runId: step.runId });
        if (res.ok && TERMINAL_RUN_STATUSES.has((res.data as RunStatusDto).status)) {
          await this.consumeFinishedRun(task, step, res.data as RunStatusDto);
          continue; // brain decides what to do with the finished run next
        }
        // Still running (or a transient read failure): stay parked; /step resumes.
        await this.storage.updateAgentTask(taskId, {
          turnState: "waiting_for_tool",
          turnStateChangedAt: this.now(),
        });
        return { outcome: "waiting", runId: step.runId };
      }

      // --- about to think: gather transcript + caps -----------------------------
      const messages = sortedChronological(
        await this.storage.listRecentAgentMessagesForWallet(task.walletAddress, taskId, RECENT_MESSAGES),
      );
      const userText = lastUserContent(messages);

      if (task.loopCount >= this.limits.maxBrainCalls) {
        await this.degrade(task, opts.hasKey, userText);
        return { outcome: "halted_iterations" };
      }
      if ((task.spendEstimateUsd ?? 0) >= this.limits.hardSpendCapUsd) {
        await this.degrade(task, opts.hasKey, userText);
        return { outcome: "halted_spend" };
      }
      if (segmentIters >= this.limits.maxSegmentIterations) {
        // Long, non-pausing segment: yield the lease so the client can re-poll.
        return { outcome: "yield" };
      }
      segmentIters++;

      // --- ask the brain --------------------------------------------------------
      let result;
      try {
        result = await opts.brain(this.buildBrainContext(task, messages));
      } catch (e) {
        await this.bumpLoopCount(task); // a failed attempt still counts (no usage to price)
        if (e instanceof MalformedDecisionError) {
          malformedStreak++;
          if (malformedStreak <= this.limits.maxMalformedRetries) continue; // bounded repair
          await this.degrade(task, opts.hasKey, userText);
          return { outcome: "halted_malformed" };
        }
        // Transport / gateway error (key rejected, rate-limited, timeout, …).
        await this.degrade(task, opts.hasKey, userText);
        return { outcome: "error" };
      }
      malformedStreak = 0;
      await this.recordBrainCost(task, result.model, result.usage);

      const decision = result.decision;
      if (decision.action === "final") {
        await this.finalReply(task, decision.message, opts.hasKey, userText);
        return { outcome: "final" };
      }
      if (decision.action === "update_plan") {
        await this.applyPlan(task, decision.plan, decision.note);
        continue;
      }

      // decision.action === "tool"
      if (ASYNC_TOOLS.has(decision.tool)) {
        const exec = await this.executeAsyncTool(task, decision.tool, decision.args, task.stepIndex);
        if (exec.outcome === "waiting") return { outcome: "waiting", runId: exec.runId };
        // queue failed: fold the error and let the brain retry within budget
        toolErrorStreak++;
        if (toolErrorStreak > this.limits.maxToolErrorRetries) {
          await this.degrade(task, opts.hasKey, userText);
          return { outcome: "halted_tool_errors" };
        }
        continue;
      }

      // sync tool (reads + cancelRun)
      const ok = await this.executeSyncTool(task, decision.tool, decision.args);
      if (!ok) {
        toolErrorStreak++;
        if (toolErrorStreak > this.limits.maxToolErrorRetries) {
          await this.degrade(task, opts.hasKey, userText);
          return { outcome: "halted_tool_errors" };
        }
        continue;
      }
      toolErrorStreak = 0;
    }
  }

  // --- tool execution -------------------------------------------------------------

  // Async (run-queuing) tool with the two-phase crash-safe record. Returns 'waiting'
  // on a successful queue (turn parks), or 'tool_error' on a clean toolkit failure.
  private async executeAsyncTool(
    task: LabAgentTask,
    tool: WorkingTool,
    args: Record<string, unknown>,
    stepIndex: number,
  ): Promise<{ outcome: "waiting"; runId: number } | { outcome: "tool_error" }> {
    // Reuse a stored key on replay; derive a fresh deterministic one otherwise. The
    // key is part of the args so the adapter dedupes (no double-enqueue on resume).
    const existingKey = typeof args.idempotencyKey === "string" ? (args.idempotencyKey as string) : undefined;
    const key = existingKey ?? deriveIdempotencyKey(task.id, stepIndex, tool, args);
    const finalArgs: Record<string, unknown> = { ...args, idempotencyKey: key };

    // PHASE 1: persist the intent BEFORE the call so a crash replays the stored tool.
    await this.storage.updateAgentTask(task.id, {
      currentStep: { phase: "executing", stepIndex, tool, args: finalArgs } as unknown as Record<string, unknown>,
    });

    const res = await this.toolkit.call(this.ctx(task), tool, finalArgs);
    if (!res.ok) {
      // Clear the marker; the call did not queue, so the brain may safely re-decide.
      await this.storage.updateAgentTask(task.id, { currentStep: null });
      await this.foldToolError(task, tool, res.error.message, stepIndex);
      return { outcome: "tool_error" };
    }

    // PHASE 2: flip to 'waiting' with the queued run; park the turn. step_index is
    // NOT advanced yet — the step is consumed only when the run reaches terminal.
    const dto = res.data as RunQueuedDto;
    await this.storage.updateAgentTask(task.id, {
      currentStep: {
        phase: "waiting",
        stepIndex,
        tool,
        runId: dto.runId,
        correlationId: dto.correlationId,
      } as unknown as Record<string, unknown>,
      activeRunId: dto.runId,
      turnState: "waiting_for_tool",
      turnStateChangedAt: this.now(),
    });
    const note = dto.idempotent
      ? `Re-attached to run #${dto.runId} (${tool}, already queued).`
      : `Queued run #${dto.runId} (${tool})${dto.jobsAhead != null ? `, ${dto.jobsAhead} jobs ahead` : ""}.`;
    await this.appendToolMessage(task, note);
    this.pushLedger(task, { step: stepIndex, tool, ok: true, summary: note });
    await this.storage.updateAgentTask(task.id, { memory: this.memoryPatch(task, args) });
    return { outcome: "waiting", runId: dto.runId };
  }

  // Sync tool (reads + cancelRun). Folds the result into the transcript + ledger and
  // advances step_index. Returns false on a clean toolkit failure.
  private async executeSyncTool(
    task: LabAgentTask,
    tool: WorkingTool,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    const stepIndex = task.stepIndex;
    const res = await this.toolkit.call(this.ctx(task), tool, args);
    if (!res.ok) {
      await this.foldToolError(task, tool, res.error.message, stepIndex);
      return false;
    }
    const summary = `${tool} result: ${capJson(res.data, TOOL_RESULT_CHARS)}`;
    await this.appendToolMessage(task, summary);
    this.pushLedger(task, { step: stepIndex, tool, ok: true, summary: `${tool} ok` });
    await this.storage.updateAgentTask(task.id, {
      stepIndex: stepIndex + 1,
      memory: this.memoryPatch(task, args),
    });
    return true;
  }

  // Fold a finished async run: record the outcome, clear the step, advance step_index.
  private async consumeFinishedRun(
    task: LabAgentTask,
    step: Extract<CurrentStep, { phase: "waiting" }>,
    dto: RunStatusDto,
  ): Promise<void> {
    const ok = dto.status === "completed";
    const oos = dto.oosFraction != null ? `oos=${dto.oosFraction}` : "oos=none (unvalidated)";
    const reason = dto.status === "failed" && dto.errorReason ? `, reason: ${dto.errorReason}` : "";
    const configs = dto.totalConfigsTested != null ? `, configs=${dto.totalConfigsTested}` : "";
    const summary = `Run #${step.runId} (${step.tool}) finished: status=${dto.status}${reason}${configs}, ${oos}`;
    await this.appendToolMessage(task, summary);
    this.pushLedger(task, { step: step.stepIndex, tool: step.tool, ok, summary });
    await this.storage.updateAgentTask(task.id, {
      currentStep: null,
      stepIndex: step.stepIndex + 1,
      activeRunId: null,
      memory: this.memoryPatch(task),
    });
  }

  private async foldToolError(
    task: LabAgentTask,
    tool: WorkingTool,
    message: string,
    stepIndex: number,
  ): Promise<void> {
    const summary = `${tool} failed: ${message}`;
    await this.appendToolMessage(task, summary);
    this.pushLedger(task, { step: stepIndex, tool, ok: false, summary });
    await this.storage.updateAgentTask(task.id, { memory: this.memoryPatch(task) });
  }

  // --- turn finishing -------------------------------------------------------------

  private async finalReply(
    task: LabAgentTask,
    message: string,
    hasKey: boolean,
    userText: string,
  ): Promise<void> {
    // LLM prose, DETERMINISTIC chips (the model never authors client actions).
    const chips = this.composeReply(userText, hasKey).suggestedActions;
    await this.storage.createAgentMessageForWallet(task.walletAddress, task.id, {
      role: "agent",
      content: message.trim(),
      suggestedActions: chips,
    });
    await this.finishTurn(task.id);
  }

  // Degrade to the fully-deterministic shell reply (§7c). Never fabricates content.
  private async degrade(task: LabAgentTask, hasKey: boolean, userText?: string): Promise<void> {
    const text = userText ?? lastUserContent(
      sortedChronological(
        await this.storage.listRecentAgentMessagesForWallet(task.walletAddress, task.id, RECENT_MESSAGES),
      ),
    );
    const reply = this.composeReply(text, hasKey);
    await this.storage.createAgentMessageForWallet(task.walletAddress, task.id, {
      role: "agent",
      content: reply.content,
      suggestedActions: reply.suggestedActions,
    });
    await this.finishTurn(task.id);
  }

  private async finishTurn(taskId: number): Promise<void> {
    // Reset the per-turn leash so the next user message starts fresh.
    await this.storage.updateAgentTask(taskId, {
      turnState: "ready",
      currentStep: null,
      loopCount: 0,
      turnStateChangedAt: this.now(),
    });
  }

  // --- brain context + cost -------------------------------------------------------

  private buildBrainContext(task: LabAgentTask, messages: LabAgentMessage[]): BrainTurnContext {
    const memory = readMemory(task);
    const plan = readPlan(task);
    return {
      goal: task.goal ?? null,
      recentMessages: messages.map((m) => ({
        role: m.role as "user" | "agent" | "tool",
        content: m.content,
      })),
      memoryDigest: renderMemoryDigest(memory, plan),
    };
  }

  private async recordBrainCost(
    task: LabAgentTask,
    model: string,
    usage?: { promptTokens: number; completionTokens: number },
  ): Promise<void> {
    await this.bumpLoopCount(task);
    if (usage && this.estimateCost) {
      try {
        const cost = await this.estimateCost(model, usage.promptTokens, usage.completionTokens);
        if (cost) await this.storage.incrementAgentTaskSpend(task.walletAddress, task.id, cost);
      } catch {
        /* spend accounting is best-effort — never fail a turn over it */
      }
    }
  }

  private async bumpLoopCount(task: LabAgentTask): Promise<void> {
    // Safe read-modify-write: we hold the single-flight lease for this task.
    await this.storage.updateAgentTask(task.id, { loopCount: (task.loopCount ?? 0) + 1 });
  }

  private async applyPlan(task: LabAgentTask, steps: string[], note?: string): Promise<void> {
    const plan: OrchestratorPlan = { steps, note, updatedAt: this.now().toISOString() };
    await this.storage.updateAgentTask(task.id, { plan: plan as unknown as Record<string, unknown> });
  }

  // --- small shared helpers -------------------------------------------------------

  private ctx(task: LabAgentTask): ToolkitContext {
    return {
      walletAddress: task.walletAddress,
      taskId: task.id,
      correlationId: `task-${task.id}`,
      allow: { read: true, write: true },
    };
  }

  private async appendToolMessage(task: LabAgentTask, content: string): Promise<void> {
    await this.storage.createAgentMessageForWallet(task.walletAddress, task.id, {
      role: "tool",
      content,
    });
  }

  private pushLedger(task: LabAgentTask, entry: LedgerEntry): void {
    const memory = readMemory(task);
    memory.ledger.push(entry);
    if (memory.ledger.length > LEDGER_CAP) memory.ledger = memory.ledger.slice(-LEDGER_CAP);
    // Stash on the in-memory task so memoryPatch reads the latest ledger this segment.
    (task as { memory?: unknown }).memory = memory;
  }

  // Build the memory jsonb patch, optionally picking up a strategyId the brain used.
  private memoryPatch(task: LabAgentTask, args?: Record<string, unknown>): Record<string, unknown> {
    const memory = readMemory(task);
    if (args && typeof args.strategyId === "number") memory.currentStrategyId = args.strategyId;
    return memory as unknown as Record<string, unknown>;
  }

  private async safeReconcile(taskId: number): Promise<void> {
    try {
      await this.reconcile(taskId);
    } catch {
      /* reconcile is advisory; a failure must not block the turn */
    }
  }
}

/** Factory mirroring the codebase's create* convention. */
export function createLabTurnOrchestrator(deps: OrchestratorDeps): LabTurnOrchestrator {
  return new LabTurnOrchestrator(deps);
}
