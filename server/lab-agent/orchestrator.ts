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
  PAID_TOOLS,
  MalformedDecisionError,
  defaultAutoMemory,
  type AutoMemory,
  type BrainDecision,
  type BrainFn,
  type BrainTurnContext,
  type WorkingTool,
} from "./chat-brain";
import type { NextStepContext } from "./chat-replies";

// --- tunables (§7; per docs §13 these are the safety nets, not budgets) ----------
const LEASE_MS = 4 * 60_000; // covers one advance() segment's worst-case brain calls

/** The leash limits. Injectable so they can be tuned (env) and unit-tested cheaply. */
export interface OrchestratorLimits {
  maxBrainCalls: number; // GLOBAL per-turn cap (persisted via loop_count)
  maxSegmentIterations: number; // local: bound a single advance() before yielding
  hardSpendCapUsd: number; // per-task runaway net (matches the C0 chat cap)
  maxMalformedRetries: number; // consecutive malformed decisions before degrade
  maxToolErrorRetries: number; // consecutive tool failures before degrade
  maxAutoSteps: number; // auto mode: pipeline-tick safety net (deterministic ticks aren't brain calls)
}
const DEFAULT_LIMITS: OrchestratorLimits = {
  maxBrainCalls: 16,
  maxSegmentIterations: 10,
  hardSpendCapUsd: 2.0,
  maxMalformedRetries: 2,
  maxToolErrorRetries: 3,
  maxAutoSteps: 20, // sits above the planner's own cap (18) so its graceful final fires first
};

const LEDGER_CAP = 40; // bound the working-memory step ledger
const TOOL_RESULT_CHARS = 1800; // cap a folded tool result in the transcript
const RECENT_MESSAGES = 24; // transcript window handed to the brain
const AUTO_TOOL_DATA_CAP = 16000; // cap the auto stashed tool result (still holds 10 top results)

// Sentinel prefixes for the auto-mode confirm/decline chips. The client routes a chip
// to the dedicated confirm endpoint by its id prefix; the message is a plain-chat
// fallback the Phase 3 route also understands. The token after the prefix is the
// pendingConfirm token that must match for a paid step to run.
export const AUTO_CONFIRM_PREFIX = "__auto_confirm__:";
export const AUTO_DECLINE_PREFIX = "__auto_decline__:";

// A task is terminal when it can no longer think. Mirrors task-store's set but kept
// local so the orchestrator does not depend on the auto-loop task store.
const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(["completed", "stopped", "failed"]);

// --- persisted shapes (stored in lab_agent_tasks jsonb columns) ------------------

/** The agent's small structured working memory (task.memory jsonb). */
export interface OrchestratorMemory {
  currentStrategyId?: number | null;
  /** The most recent COMPLETED run this task produced — drives result-aware
   *  next-step chips (refine / improve / try-another-asset) on the final reply. */
  lastFinishedRunId?: number | null;
  ledger: LedgerEntry[];
  /** Auto mode (Task #200): the deterministic pipeline's typed state. Planner-owned —
   *  the orchestrator persists whatever the planner returns (plus the confirm token). */
  auto?: AutoMemory | null;
  /** Auto mode: the most recent SYNC tool's structured result, so the next planner tick
   *  can branch on robustness without re-reading the transcript. */
  autoLastTool?: { tool: string; data: unknown } | null;
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
  | "awaiting_confirm" // auto mode parked on a PAID step; the user must confirm/decline
  | "stopped" // task terminal or stop requested; brain not called
  | "halted_iterations" // hit the global brain-call cap; degraded
  | "halted_spend" // hit the hard spend cap; degraded
  | "halted_auto_steps" // auto mode: hit the pipeline-tick safety net; degraded
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
    resultCtx?: NextStepContext,
  ) => { content: string; suggestedActions: AgentSuggestedAction[] };
  /** Live per-call USD estimate; null = unknown (record nothing). */
  estimateCost?: (model: string, promptTokens: number, completionTokens: number) => Promise<number | null>;
  /** Override any leash limit; omitted fields fall back to DEFAULT_LIMITS. */
  limits?: Partial<OrchestratorLimits>;
  now?: () => Date;
  genToken?: () => string;
  /**
   * Task 201: LIVE hands-off authorization for a wallet (admin whitelist). The
   * orchestrator calls this fail-closed before EVERY auto-approval — if it's absent,
   * returns false, or throws, the run stays in watched mode (parks on a confirm chip).
   * Persisted `auto.handsOff` only records the user's intent; this is the real gate.
   */
  isHandsOffApproved?: (walletAddress: string) => Promise<boolean>;
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
  const auto = raw?.auto && typeof raw.auto === "object" ? (raw.auto as AutoMemory) : null;
  const autoLastTool =
    raw?.autoLastTool && typeof raw.autoLastTool === "object"
      ? (raw.autoLastTool as { tool: string; data: unknown })
      : null;
  return {
    currentStrategyId: typeof raw?.currentStrategyId === "number" ? raw!.currentStrategyId : null,
    lastFinishedRunId: typeof raw?.lastFinishedRunId === "number" ? raw!.lastFinishedRunId : null,
    ledger,
    auto,
    autoLastTool,
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
  private readonly isHandsOffApproved: (walletAddress: string) => Promise<boolean>;

  constructor(deps: OrchestratorDeps) {
    this.storage = deps.storage;
    this.toolkit = deps.toolkit;
    this.reconcile = deps.reconcile;
    this.composeReply = deps.composeReply;
    this.estimateCost = deps.estimateCost;
    this.limits = { ...DEFAULT_LIMITS, ...(deps.limits ?? {}) };
    this.now = deps.now ?? (() => new Date());
    this.genToken = deps.genToken ?? (() => createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex"));
    // Fail-closed default: no injected gate ⇒ hands-off is never authorized.
    this.isHandsOffApproved = deps.isHandsOffApproved ?? (async () => false);
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

      // Honor a terminal status WITHOUT calling the brain.
      if (TERMINAL_TASK_STATUSES.has(task.status)) {
        await this.finishTurn(taskId);
        return { outcome: "stopped" };
      }
      // A stop signal winds an AUTO run down: CONSUME it (clear the flag), drop back to
      // chat, and end the turn so a later /step or message can't re-drive the planner.
      if (task.cancelRequestedAt) {
        if (task.mode === "auto") {
          await this.storage.updateAgentTask(taskId, { cancelRequestedAt: null, mode: "chat" });
          await this.finishTurn(taskId);
          return { outcome: "stopped" };
        }
        // Stale flag: a stop landed in the tiny window AFTER the auto turn already
        // finished and flipped to chat (mode==="chat" here). Clear it and fall through
        // to answer this turn normally — winding down would swallow the user's message.
        await this.storage.updateAgentTask(taskId, { cancelRequestedAt: null });
        (task as { cancelRequestedAt?: Date | null }).cancelRequestedAt = null;
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
      if (task.mode === "auto") {
        // Deterministic ticks don't bump loopCount, so the pipeline gets its own safety
        // net. Set a touch above the planner's own cap so its graceful final fires first;
        // this only trips if the planner somehow fails to terminate.
        const steps = readMemory(task).auto?.autoStepCount ?? 0;
        if (steps >= this.limits.maxAutoSteps) {
          await this.degrade(task, opts.hasKey, userText);
          return { outcome: "halted_auto_steps" };
        }
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
      // Auto mode: the planner returns its NEXT pipeline state. We do NOT persist it
      // eagerly — a crash AFTER the persist but BEFORE the tool ran would resume from
      // an advanced phase and SKIP the tool. Instead each branch folds nextAuto into
      // the SAME write that records the step's effect, so the phase advances iff the
      // step actually happened (and async PHASE-1 rolls it back on a failed enqueue).
      const nextAuto = result.auto;
      // If this is the just-approved PAID step, capture its confirmed estimate to bill
      // once it runs. The planner clears pendingConfirm in nextAuto, so read it from the
      // STILL-persisted memory before we act. Only the confirmed paid tool reaches here
      // as action:"tool" (paid steps otherwise stop at await_confirm).
      const paidEstUsd =
        decision.action === "tool" && (PAID_TOOLS as readonly string[]).includes(decision.tool)
          ? readMemory(task).auto?.pendingConfirm?.estCostUsd
          : undefined;

      if (decision.action === "final") {
        await this.finalReply(task, decision.message, opts.hasKey, userText, nextAuto);
        return { outcome: "final" };
      }
      if (decision.action === "update_plan") {
        await this.applyPlan(task, decision.plan, decision.note);
        continue;
      }
      if (decision.action === "await_confirm") {
        // A Stop can land AFTER this iteration's top gate but before we park. This is the
        // ONLY park that stays in auto + ready (final/degrade flip to chat), and the client
        // stops polling once ready — so nothing else would consume the flag. Check BEFORE
        // asking/approving (so we don't post a prompt — or spend — we're about to moot)...
        if (await this.stopAutoIfRequested(taskId)) return { outcome: "stopped" };

        // Task 201 — hands-off mode: skip the human confirm and approve the paid step
        // ourselves. Gated by BOTH the user's persisted intent AND a LIVE whitelist
        // re-check (fail-closed: a throw or a removed wallet falls through to the watched
        // park below). Every other cap is untouched — the planner's 90% guard already ran
        // INSIDE requestPaid before this await_confirm, and the loop's top gates (Stop,
        // spend cap, maxAutoSteps) re-fire next iteration before the approved tool runs.
        if (readMemory(task).auto?.handsOff === true && (await this.handsOffAllowed(task))) {
          await this.autoApproveConfirmation(task, decision, nextAuto);
          // A Stop could have raced the approval write; honor it before looping back.
          if (await this.stopAutoIfRequested(taskId)) return { outcome: "stopped" };
          continue; // next planner tick sees the confirmed token and runs the paid tool
        }

        // Auto mode paid-step gate (watched): park the turn until the user confirms.
        await this.requestConfirmation(task, decision, nextAuto);
        // ...and once more AFTER the park write, to catch a Stop that raced it.
        if (await this.stopAutoIfRequested(taskId)) return { outcome: "stopped" };
        return { outcome: "awaiting_confirm" };
      }

      // decision.action === "tool"
      if (ASYNC_TOOLS.has(decision.tool)) {
        const exec = await this.executeAsyncTool(
          task, decision.tool, decision.args, task.stepIndex, nextAuto, paidEstUsd,
        );
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
      const sync = await this.executeSyncTool(task, decision.tool, decision.args, nextAuto, paidEstUsd);
      if (!sync.ok) {
        toolErrorStreak++;
        if (toolErrorStreak > this.limits.maxToolErrorRetries) {
          await this.degrade(task, opts.hasKey, userText);
          return { outcome: "halted_tool_errors" };
        }
        continue;
      }
      toolErrorStreak = 0;
      // A successful createStrategyFromText returns its own deterministic confirmation and
      // ENDS the turn here — we never ask the brain to summarize a known-good outcome.
      if (sync.finalMessage) {
        await this.finalReply(task, sync.finalMessage, opts.hasKey, userText, nextAuto);
        return { outcome: "final" };
      }
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
    nextAuto?: AutoMemory,
    paidEstUsd?: number,
  ): Promise<{ outcome: "waiting"; runId: number } | { outcome: "tool_error" }> {
    // Reuse a stored key on replay; derive a fresh deterministic one otherwise. The
    // key is part of the args so the adapter dedupes (no double-enqueue on resume).
    const existingKey = typeof args.idempotencyKey === "string" ? (args.idempotencyKey as string) : undefined;
    const key = existingKey ?? deriveIdempotencyKey(task.id, stepIndex, tool, args);
    const finalArgs: Record<string, unknown> = { ...args, idempotencyKey: key };

    // PHASE 1: persist the intent BEFORE the call so a crash replays the stored tool.
    // Auto mode: advance the pipeline phase ATOMICALLY with the 'executing' commit, so
    // a crash-replay re-runs THIS stored tool (idempotent) instead of re-deciding from
    // a fresh planner tick on the old phase (which would double-enqueue). The replay
    // path passes nextAuto undefined (the phase is already advanced from the first try).
    const priorMemory = readMemory(task);
    const priorAuto = priorMemory.auto ?? null;
    const p1: Partial<LabAgentTask> = {
      currentStep: { phase: "executing", stepIndex, tool, args: finalArgs } as unknown as Record<string, unknown>,
    };
    if (nextAuto !== undefined) {
      priorMemory.auto = nextAuto;
      // A fresh async run (runOptimization/improve) makes any previously stashed read
      // result STALE: the next evaluate tick MUST re-fetch getTopResults so it branches on
      // THIS run's results, not the prior stage's. The planner's evaluate gate keys off
      // lastToolResult.tool === "getTopResults"; without clearing here, a graduation run
      // would be evaluated against the proving stage's stale getTopResults and never read
      // its own results. Clearing autoLastTool forces the re-fetch.
      priorMemory.autoLastTool = null;
      (task as { memory?: unknown }).memory = priorMemory;
      p1.memory = priorMemory as unknown as Record<string, unknown>;
    }
    await this.storage.updateAgentTask(task.id, p1);

    const res = await this.toolkit.call(this.ctx(task), tool, finalArgs);
    if (!res.ok) {
      // The call did not queue, so the brain may safely re-decide. Roll the phase back
      // to its pre-advance value (clearing the marker alone would strand the advance).
      const clear: Partial<LabAgentTask> = { currentStep: null };
      if (nextAuto !== undefined) {
        const m = readMemory(task);
        m.auto = priorAuto;
        (task as { memory?: unknown }).memory = m;
        clear.memory = m as unknown as Record<string, unknown>;
      }
      await this.storage.updateAgentTask(task.id, clear);
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
    // Bill the approved estimate ONLY on a fresh enqueue — a replay re-attaches to the
    // same run (dto.idempotent) and must not double-charge. The adapter does not meter
    // improve's own LLM spend, so this estimate is the spend signal for the cap.
    if (paidEstUsd != null && !dto.idempotent) await this.recordPaidEstimate(task, paidEstUsd);
    return { outcome: "waiting", runId: dto.runId };
  }

  // Sync tool (reads + cancelRun). Folds the result into the transcript + ledger and
  // advances step_index. Returns false on a clean toolkit failure. Auto mode folds the
  // planner's next phase + bills any approved paid estimate atomically with the success
  // write, so the phase advances iff the tool actually ran.
  private async executeSyncTool(
    task: LabAgentTask,
    tool: WorkingTool,
    args: Record<string, unknown>,
    nextAuto?: AutoMemory,
    paidEstUsd?: number,
  ): Promise<{ ok: false } | { ok: true; finalMessage?: string }> {
    const stepIndex = task.stepIndex;
    const res = await this.toolkit.call(this.ctx(task), tool, args);
    if (!res.ok) {
      await this.foldToolError(task, tool, res.error.message, stepIndex);
      return { ok: false };
    }
    const summary = `${tool} result: ${capJson(res.data, TOOL_RESULT_CHARS)}`;
    await this.appendToolMessage(task, summary);
    this.pushLedger(task, { step: stepIndex, tool, ok: true, summary: `${tool} ok` });
    // Auto mode: stash the structured result so the next planner tick can branch on
    // robustness (and pick up a new strategyId from a create/improve) without parsing
    // the transcript. Mutates the in-memory task so the memoryPatch below persists it.
    if (task.mode === "auto") this.stashAutoToolResult(task, tool, res.data);
    // Build the memory patch (picks up the stashed result + any strategyId from args),
    // then overlay the planner's next phase so it advances atomically with this success.
    const memory = readMemory(task);
    if (args && typeof args.strategyId === "number") memory.currentStrategyId = args.strategyId;
    // A tool that RETURNS a strategyId (createStrategyFromText drafts a new one; findStrategy
    // resolves one) makes that the strategy the user is now working with — lift it so the
    // result-aware chips (and the deterministic draft confirmation below) point at it. The
    // args-based lift above only covers tools that take strategyId as INPUT.
    const newStrategyId =
      res.data && typeof res.data === "object" &&
      typeof (res.data as { strategyId?: unknown }).strategyId === "number"
        ? (res.data as { strategyId: number }).strategyId
        : null;
    if (newStrategyId != null) memory.currentStrategyId = newStrategyId;
    if (nextAuto !== undefined) memory.auto = nextAuto;
    (task as { memory?: unknown }).memory = memory;
    await this.storage.updateAgentTask(task.id, {
      stepIndex: stepIndex + 1,
      memory: memory as unknown as Record<string, unknown>,
    });
    // Bill the approved estimate for a sync paid step (createStrategyFromText). The
    // tiny window between the tool's side-effect and this write is the pre-existing
    // sync-tool replay risk (shared with the chat path) — a crash there can re-draft;
    // the planner's post-success currentStrategyId guard covers the common case.
    if (paidEstUsd != null) await this.recordPaidEstimate(task, paidEstUsd);

    // createStrategyFromText has a KNOWN, structured outcome (a new strategyId + name).
    // Report it DETERMINISTICALLY in chat mode instead of running a brain summary turn — a
    // hallucinated post-tool summary must never tell the user a real, successful draft
    // "failed" (prod incident: a fabricated "X is not a valid model for this request").
    // Auto mode is excluded on purpose: its planner continues past the create to queue the
    // backtest, and its tests assert that path.
    let finalMessage: string | undefined;
    if (task.mode !== "auto" && tool === "createStrategyFromText" && newStrategyId != null) {
      const name =
        res.data && typeof res.data === "object" &&
        typeof (res.data as { name?: unknown }).name === "string"
          ? (res.data as { name: string }).name.trim()
          : "";
      if (name) {
        finalMessage = `Drafted "${name}" (#${newStrategyId}). Want me to backtest it across a few markets next?`;
      }
    }
    return { ok: true, finalMessage };
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
    const memory = this.memoryPatch(task);
    // Only a COMPLETED run unlocks result-aware next-step chips; a failed/cancelled
    // run leaves the prior value untouched so chips still reflect the last GOOD run.
    if (ok) (memory as { lastFinishedRunId?: number | null }).lastFinishedRunId = step.runId;
    await this.storage.updateAgentTask(task.id, {
      currentStep: null,
      stepIndex: step.stepIndex + 1,
      activeRunId: null,
      memory,
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
    nextAuto?: AutoMemory,
  ): Promise<void> {
    // LLM prose, DETERMINISTIC chips (the model never authors client actions).
    // Result-aware: pass the task's current strategy + last finished run so the
    // reply can append refine / improve / try-another-asset next-step chips.
    const memory = readMemory(task);
    if (nextAuto !== undefined) memory.auto = nextAuto;
    const chips = this.composeReply(userText, hasKey, {
      strategyId: memory.currentStrategyId ?? null,
      lastRunId: memory.lastFinishedRunId ?? null,
    }).suggestedActions;
    await this.storage.createAgentMessageForWallet(task.walletAddress, task.id, {
      role: "agent",
      content: message.trim(),
      suggestedActions: chips,
    });
    // The auto pipeline reached a terminal end (done / caps / no goal). Persist the
    // final phase AND drop back to chat mode so a stray /step can't re-drive the
    // planner and the user can converse normally again.
    const patch: Record<string, unknown> = { memory: memory as unknown as Record<string, unknown> };
    if (task.mode === "auto") {
      patch.mode = "chat";
      (task as { mode?: string }).mode = "chat";
    }
    await this.storage.updateAgentTask(task.id, patch);
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
    // A halt on an orchestrator safety net (iterations / spend / auto-steps / malformed
    // / tool errors / transport) ends the auto run — drop back to chat so a later /step
    // can't re-drive the planner.
    if (task.mode === "auto") {
      (task as { mode?: string }).mode = "chat";
      await this.storage.updateAgentTask(task.id, { mode: "chat" });
    }
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

  // Wind an auto run down if a Stop landed mid-iteration. Re-reads the LIVE row (the
  // caller's snapshot predates the race) and, on a pending cancel, clears the flag, drops
  // to chat, and resets the turn. Guards the await_confirm park — the one park that stays
  // in auto + ready, where the task would otherwise sit with the flag set while the client
  // has stopped polling. Returns true if it stopped (caller returns outcome:"stopped").
  private async stopAutoIfRequested(taskId: number): Promise<boolean> {
    const fresh = await this.storage.getAgentTask(taskId);
    if (fresh?.mode === "auto" && fresh.cancelRequestedAt) {
      await this.storage.updateAgentTask(taskId, {
        cancelRequestedAt: null,
        mode: "chat",
        status: "active",
      });
      await this.finishTurn(taskId);
      return true;
    }
    return false;
  }

  // --- brain context + cost -------------------------------------------------------

  private buildBrainContext(task: LabAgentTask, messages: LabAgentMessage[]): BrainTurnContext {
    const memory = readMemory(task);
    const plan = readPlan(task);
    const ctx: BrainTurnContext = {
      goal: task.goal ?? null,
      recentMessages: messages.map((m) => ({
        role: m.role as "user" | "agent" | "tool",
        content: m.content,
      })),
      memoryDigest: renderMemoryDigest(memory, plan),
    };
    // Auto mode: assemble the deterministic planner's view from persisted memory + live
    // task fields. The planner is pure — everything it branches on lives here.
    if (task.mode === "auto") {
      ctx.auto = {
        memory: memory.auto ?? defaultAutoMemory(),
        goal: task.goal ?? null,
        currentStrategyId: memory.currentStrategyId ?? null,
        lastFinishedRunId: memory.lastFinishedRunId ?? null,
        lastToolResult: memory.autoLastTool ?? null,
        spendSoFarUsd: task.spendEstimateUsd ?? 0,
        hardSpendCapUsd: this.limits.hardSpendCapUsd,
      };
    }
    return ctx;
  }

  private async recordBrainCost(
    task: LabAgentTask,
    model: string,
    usage?: { promptTokens: number; completionTokens: number },
  ): Promise<void> {
    // Deterministic ticks (the auto-planner) carry NO usage — they are not LLM brain
    // calls, so they must not bump the brain-call leash or charge spend. Only a real
    // LLM turn (usage present) counts.
    if (!usage) return;
    await this.bumpLoopCount(task);
    if (this.estimateCost) {
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

  // --- auto mode (Task #200) ------------------------------------------------------

  // Stash a sync tool's structured result for the next planner tick. Bounds the blob
  // and lifts a returned strategyId (create/improve) into currentStrategyId.
  private stashAutoToolResult(task: LabAgentTask, tool: WorkingTool, data: unknown): void {
    const memory = readMemory(task);
    memory.autoLastTool = { tool, data: this.boundAutoData(data) };
    if (data && typeof (data as { strategyId?: unknown }).strategyId === "number") {
      memory.currentStrategyId = (data as { strategyId: number }).strategyId;
    }
    (task as { memory?: unknown }).memory = memory;
  }

  private boundAutoData(data: unknown): unknown {
    try {
      if (JSON.stringify(data).length <= AUTO_TOOL_DATA_CAP) return data;
    } catch {
      /* unserializable — drop it; the planner re-reads via a tool next tick */
    }
    return null;
  }

  // Bill the user-approved estimate for a PAID auto step. The deterministic planner
  // has no LLM usage, so paid spend is recorded HERE (not in recordBrainCost) from the
  // pre-call estimate. Best-effort: never fail a turn over spend accounting. Also syncs
  // the in-memory task so a later spend-cap check in the SAME segment sees the new total.
  private async recordPaidEstimate(task: LabAgentTask, estUsd: number): Promise<void> {
    if (!(estUsd > 0)) return;
    try {
      await this.storage.incrementAgentTaskSpend(task.walletAddress, task.id, estUsd);
      (task as { spendEstimateUsd?: number }).spendEstimateUsd = (task.spendEstimateUsd ?? 0) + estUsd;
    } catch {
      /* spend accounting is best-effort — never fail a turn over it */
    }
  }

  // Park an auto turn on a PAID step: mint a confirm token, post the confirm/decline
  // prompt once (idempotent on re-drive), and move the task to awaiting_input. The
  // paid tool only runs once the confirm route writes a matching confirmedToken.
  private async requestConfirmation(
    task: LabAgentTask,
    decision: Extract<BrainDecision, { action: "await_confirm" }>,
    nextAuto?: AutoMemory,
  ): Promise<void> {
    const memory = readMemory(task);
    // Idempotency reads the PERSISTED pendingConfirm (a re-drive must not re-ask); the
    // base for a fresh ask is the planner's nextAuto so the advanced step count sticks.
    const persisted = memory.auto;
    const base = nextAuto ?? persisted ?? defaultAutoMemory();
    const alreadyAsked = persisted?.pendingConfirm?.tool === decision.tool && !persisted?.confirmedToken;
    if (!alreadyAsked) {
      const token = this.genToken();
      memory.auto = {
        ...base,
        pendingConfirm: { tool: decision.tool, token, estCostUsd: decision.estCostUsd, args: decision.args },
        confirmedToken: null,
      };
      (task as { memory?: unknown }).memory = memory;
      const est = `$${decision.estCostUsd.toFixed(2)}`;
      const chips: AgentSuggestedAction[] = [
        { id: `auto-confirm-${token}`, label: `Yes, spend ~${est}`, kind: "send", message: `${AUTO_CONFIRM_PREFIX}${token}` },
        { id: `auto-decline-${token}`, label: "No, stop here", kind: "send", message: `${AUTO_DECLINE_PREFIX}${token}` },
      ];
      await this.storage.createAgentMessageForWallet(task.walletAddress, task.id, {
        role: "agent",
        content: `${decision.reason} This step uses your OpenRouter key (est. ${est}). Want me to go ahead?`,
        suggestedActions: chips,
      });
      await this.storage.updateAgentTask(task.id, { memory: memory as unknown as Record<string, unknown> });
    }
    await this.storage.updateAgentTask(task.id, {
      status: "awaiting_input",
      turnState: "ready",
      currentStep: null,
      loopCount: 0,
      turnStateChangedAt: this.now(),
    });
  }

  // Task 201 — LIVE, fail-closed hands-off gate. Wraps the injected whitelist check so a
  // throw (DB blip, missing dep) can NEVER auto-approve a spend: any error → watched mode.
  private async handsOffAllowed(task: LabAgentTask): Promise<boolean> {
    try {
      return await this.isHandsOffApproved(task.walletAddress);
    } catch {
      return false;
    }
  }

  // Task 201 — hands-off counterpart to requestConfirmation. Instead of parking on a
  // confirm chip, we approve the paid step ourselves: persist pendingConfirm AND a matching
  // confirmedToken in ONE write (collapsing the watched ask + user-confirm into one), so the
  // very next planner tick's confirmed-token path runs the paid tool. The turn keeps running
  // (caller `continue`s); status/turnState are intentionally left as the live running turn.
  private async autoApproveConfirmation(
    task: LabAgentTask,
    decision: Extract<BrainDecision, { action: "await_confirm" }>,
    nextAuto?: AutoMemory,
  ): Promise<void> {
    const memory = readMemory(task);
    const persisted = memory.auto;
    // Idempotency: a crash-replay that already approved THIS exact pending step must not
    // re-mint a token or post a second note. (Normally unreachable — the planner clears
    // pendingConfirm the moment the tool runs — but defensive against a re-drive.)
    if (
      persisted?.pendingConfirm?.tool === decision.tool &&
      !!persisted?.confirmedToken &&
      persisted.confirmedToken === persisted.pendingConfirm.token
    ) {
      return;
    }
    // Base off the planner's nextAuto so the advanced autoStepCount sticks (mirrors the
    // watched requestConfirmation base), then set BOTH the pending gate and its approval.
    const base = nextAuto ?? persisted ?? defaultAutoMemory();
    const token = this.genToken();
    memory.auto = {
      ...base,
      pendingConfirm: { tool: decision.tool, token, estCostUsd: decision.estCostUsd, args: decision.args },
      confirmedToken: token,
    };
    (task as { memory?: unknown }).memory = memory;
    // Persist the approval FIRST: a crash before the note resumes as confirmed (planner
    // runs the tool) — at worst the cosmetic log line is missing, never doubled.
    await this.storage.updateAgentTask(task.id, { memory: memory as unknown as Record<string, unknown> });
    const est = `$${decision.estCostUsd.toFixed(2)}`;
    await this.appendToolMessage(
      task,
      `Hands-off: auto-approved ${decision.tool} (est. ${est}). No check-in needed — running it now.`,
    );
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
