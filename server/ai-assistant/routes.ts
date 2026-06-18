// HTTP layer for the QuantumLab AI Strategy Creator (Task 187).
//
// IMPORTANT ARCHITECTURE NOTE: these routes are registered in the MAIN server
// process (server/index.ts), BEFORE the `/api/lab` proxy catch-all. They CANNOT
// live in server/lab/routes.ts because that file runs in the QuantumLab CHILD
// process, which authenticates via x-lab-auth/x-lab-wallet and has neither an
// Express session nor the V3 UMK (the UMK lives only in main-process memory).
//
// SECURITY: the caller's wallet is taken ONLY from the Express session here — never
// from a Bearer API token or the LAB_AUTH_SECRET header — so a stolen API token
// cannot drive the Creator on the user's OpenRouter bill. The BYO key is decrypted
// transiently per request (UMK-derived subkey, AAD-bound to the wallet), used, and
// the plaintext buffer is zeroized; it is never returned to the client and never
// logged.

import type { Express, Request, Response, NextFunction, RequestHandler } from "express";
import express from "express";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { labStrategies, type LabAgentTask } from "@shared/schema";
import { storage } from "../storage";
import {
  getSessionByWalletAddress,
  encryptLlmApiKeyV3,
  decryptLlmApiKeyV3,
} from "../session-v3";
import { parsePineScript } from "../lab/pine-parser";
import { draftStrategy, improveStrategy } from "./creator";
import { getCreatorModelCatalog, isSelectableModel, estimateCallCostUsd, getModelPrice } from "./models-catalog";
import { LlmGatewayError, checkRateLimit } from "./router";
import { startCreatorJob, getCreatorJob, CreatorJobConflictError } from "./creator-jobs";
import { labStorage } from "../lab/storage";
import { SEED_GREETING, composeAgentReply, SESSION_LOCKED_REPLY, REAUTH_PAUSED_REPLY, KEY_MISSING_REPLY } from "../lab-agent/chat-replies";
import { decideTurnAction, defaultAutoMemory, type BrainFn, type AutoMemory, type PaidTool } from "../lab-agent/chat-brain";
import { createAutoPlanner } from "../lab-agent/auto-planner";
import { selectDeployableResult, type AutoDeployableResultView } from "./deployable-result";
import { looksLikeApiKey } from "@shared/api-key-detect";
import { createLabTurnOrchestrator, AUTO_CONFIRM_PREFIX, AUTO_DECLINE_PREFIX, AUTO_STYLE_PREFIX } from "../lab-agent/orchestrator";
import { styleById } from "../lab-agent/strategy-styles";
import { LabAgentToolkit } from "../lab-agent/toolkit";
import { createCurrentLabAdapter } from "../lab-agent/current-lab-adapter";
import { reconcileTask } from "../lab-agent/reconciler";
import { startLabTurn, isLabTurnRunning } from "./lab-turn-jobs";
import { getLabAuthSecret } from "../lab/supervisor";

// Creator payloads are tiny (idea/insights are capped at 4KB in the gateway). Keep a
// small per-route body limit — these routes are registered before the global parser.
const jsonParser = express.json({ limit: "256kb" });

// Interactive-session gate. The wallet is read ONLY from req.session; we also
// defensively reject any request carrying API-token / lab-secret markers.
const requireCreatorSession: RequestHandler = (req: any, res: Response, next: NextFunction) => {
  if (req.apiTokenId || req.headers["x-lab-auth"]) {
    return res.status(403).json({ error: "The AI Creator requires an interactive sign-in." });
  }
  const walletAddress = req.session?.walletAddress;
  if (!walletAddress || typeof walletAddress !== "string") {
    return res.status(401).json({ error: "Please sign in to use the AI Creator." });
  }
  req.walletAddress = walletAddress;
  next();
};

// Resolve the live interactive UMK for the session-bound wallet, or fail closed.
function getInteractiveUmk(req: any, res: Response): Buffer | null {
  const sessionRes = getSessionByWalletAddress(req.walletAddress);
  const umk = sessionRes?.session?.umk;
  if (!umk) {
    res.status(401).json({ error: "Your session is locked. Sign in again to use the AI Creator." });
    return null;
  }
  return umk;
}

function sendError(res: Response, err: any, fallback: string): void {
  if (err instanceof LlmGatewayError) {
    res.status(err.status && Number.isInteger(err.status) ? err.status : 502).json({ error: err.message });
    return;
  }
  // Never surface raw error text/stack for these routes — it could be noisy or
  // reference internals. The BYO key never appears in any thrown error.
  res.status(500).json({ error: fallback });
}

// Run the drafted Pine through the lab parser so the client can save it with the same
// shape the existing Setup flow uses ({ inputs, groups, strategyName, strategySettings }).
function safeParse(pine: string): ReturnType<typeof parsePineScript> | null {
  try {
    return parsePineScript(pine);
  } catch {
    return null;
  }
}

export function registerCreatorRoutes(
  app: Express,
  sessionMiddleware: RequestHandler,
  // Live QuantumLab child port for the best-effort queue kick. Defaults to the
  // standard child port; index.ts passes the supervisor's live port (it can shift
  // on an EADDRINUSE retry). The kick is best-effort, so a stale port is harmless.
  getLabPort: () => number = () => 5050,
): void {
  const guards: RequestHandler[] = [sessionMiddleware, jsonParser, requireCreatorSession];
  // The job-status poll carries no body, so it skips the JSON parser.
  const getGuards: RequestHandler[] = [sessionMiddleware, requireCreatorSession];

  // --- Lab Assistant chat (Phase B): a persisted conversational SHELL ----------
  // No LLM and no toolkit calls here — replies are deterministic and synchronous
  // (composeAgentReply), so there is no job/poll. The wallet comes ONLY from the
  // session; every task/message access is wallet-scoped in the storage layer, and
  // a task owned by another wallet returns 404 (no existence leak).
  const MAX_CHAT_CONTENT = 4000;
  // Per-task BYO-key safety cap for C0 chat (§7; tunable per §13). One chat turn
  // costs a fraction of a cent, so this is a runaway/abuse net — NOT a budget the
  // user is meant to hit. Over it, the assistant degrades to the free shell reply.
  const LAB_CHAT_TASK_SPEND_CAP_USD = 2.0;
  const toChatTaskDto = (t: { id: number; status: string; mode: string; createdAt: Date }) => ({
    id: t.id, status: t.status, mode: t.mode, createdAt: t.createdAt,
  });
  const parseTaskId = (raw: string): number | null => {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  // Read the typed `auto` sub-object out of a task's memory jsonb (null when absent).
  const readAutoMemory = (task: LabAgentTask): AutoMemory | null => {
    const mem = task.memory as { auto?: AutoMemory } | null;
    return mem?.auto ?? null;
  };

  // The live run's status as the quant-agent checklist needs it (filled in by the GET
  // messages route, which can do the async run-status read). Bounded on purpose.
  type AutoActiveRunView = {
    status: string;
    stage: string | null;
    progressPct: number | null;
    jobsAhead: number | null;
  };

  // AutoDeployableResultView + selectDeployableResult live in ./deployable-result
  // (pure + unit-tested). Filled in by the GET messages route (async getTopResults
  // read) so the dock can render a real result card + Deploy button.

  // The "quant agent" progress view the dock renders as an animated checklist while an
  // auto run is in flight (and as a completed record once it lands). Derived ONLY from
  // the persisted planner memory; we expose the phase + loop counters + a pending paid
  // confirm, never the confirm token or its raw args. `activeRun` is left null here and
  // enriched by the GET messages route.
  const toAutoChecklistDto = (t: LabAgentTask) => {
    const auto = readAutoMemory(t);
    // Only surface the checklist when it's relevant: a live auto run, or a finished one
    // whose terminal state we still want to show. A plain chat task carries no checklist.
    if (!auto || (t.mode !== "auto" && auto.phase !== "done")) return null;
    return {
      phase: auto.phase,
      improveCount: auto.improveCount ?? 0,
      graduated: auto.graduated === true,
      pausedForReauth: auto.pausedForReauth === true,
      pendingConfirm: auto.pendingConfirm
        ? { tool: auto.pendingConfirm.tool, estCostUsd: auto.pendingConfirm.estCostUsd }
        : null,
      activeRun: null as AutoActiveRunView | null,
      deployableResult: null as AutoDeployableResultView | null,
    };
  };

  // The turn-loop view the client polls on: enough to decide whether to keep
  // polling (running_turn), drive a resume (waiting_for_tool), or stop (ready).
  const toTurnTaskDto = (t: LabAgentTask) => ({
    id: t.id,
    status: t.status,
    turnState: t.turnState,
    activeRunId: t.activeRunId ?? null,
    // Auto-mode watchability (Task #200): the dock shows the Stop control + spend-so-far
    // while mode==="auto", and reflects a pending stop the instant it's requested.
    mode: t.mode,
    spendEstimateUsd: t.spendEstimateUsd ?? 0,
    cancelRequested: t.cancelRequestedAt != null,
    // The quant-agent checklist view (null for a plain chat task).
    auto: toAutoChecklistDto(t),
  });

  // --- Phase C turn orchestrator (one shared instance) -------------------------
  // The toolkit writes queued-run rows straight into the shared lab DB; a
  // best-effort cross-process kick nudges the child's queue so a run starts within
  // ~1s instead of waiting up to 30s for the child's unified scheduler sweep. The
  // sweep is the guaranteed backstop, so a failed kick is harmless. onRunQueued is
  // called SYNCHRONOUSLY inside the adapter's enqueue try-block, so it must NEVER
  // throw — everything here is wrapped and the fetch is fire-and-forget.
  const kickLabQueue = (_runId: number): void => {
    try {
      const port = getLabPort();
      const secret = getLabAuthSecret();
      void fetch(`http://127.0.0.1:${port}/api/lab/queue/kick`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-lab-auth": secret },
        body: "{}",
      }).catch(() => {});
    } catch {
      /* never let a kick failure break the enqueue */
    }
  };
  // BYO-key resolver for the adapter's LLM-backed tools (createStrategyFromText /
  // improve). Decrypts the wallet's stored OpenRouter key transiently; the adapter
  // zeroizes the returned buffer after use. null = key deleted or session locked
  // (mirrors startTurnWithKey's "no-key" degrade) → the tool returns a typed
  // conflict, never a crash.
  const resolveLlmKey = async (walletAddress: string): Promise<Buffer | null> => {
    const ciphertext = await storage.getWalletLlmApiKeyCiphertext(walletAddress);
    if (!ciphertext) return null;
    const sessionRes = getSessionByWalletAddress(walletAddress);
    const umk = sessionRes?.session?.umk;
    if (!umk) return null;
    return decryptLlmApiKeyV3(umk, ciphertext, walletAddress);
  };
  // Hands-off auto-approval policy. Open to everyone by default: any user with their own
  // AI key can run the agent end to end without approval taps. The only thing it auto-approves
  // is the user's own AI-key spend (already hard-capped); it never auto-trades real funds or
  // deploys live bots on its own. To lock it back down later set HANDSOFF_OPEN_TO_ALL=false,
  // and it falls back to the admin whitelist (wallets.hands_off_approved). Checked live.
  // Tolerant of case/whitespace so a mistyped "FALSE" or " false " still locks down.
  const handsOffOpenToAll = () => (process.env.HANDSOFF_OPEN_TO_ALL ?? "").trim().toLowerCase() !== "false";
  const isHandsOffEligible = async (wallet: string): Promise<boolean> => {
    if (handsOffOpenToAll()) return true;
    return storage.isHandsOffApproved(wallet);
  };

  const labToolkit = new LabAgentToolkit(createCurrentLabAdapter(labStorage, kickLabQueue, resolveLlmKey));
  const labOrchestrator = createLabTurnOrchestrator({
    storage: labStorage,
    toolkit: labToolkit,
    reconcile: (taskId: number) => reconcileTask(labStorage, taskId),
    composeReply: composeAgentReply,
    estimateCost: estimateCallCostUsd,
    limits: { hardSpendCapUsd: LAB_CHAT_TASK_SPEND_CAP_USD },
    // LIVE hands-off gate: re-checked before EVERY auto-approval. Open to all by default;
    // when locked down it falls back to the admin whitelist, so revoking a wallet then
    // instantly drops its running auto run back to watched mode.
    isHandsOffApproved: (wallet: string) => isHandsOffEligible(wallet),
  });

  // --- auto-mode (Task #200) paid-cost estimator -------------------------------
  // The deterministic planner has no LLM usage, so it can't price a paid step from
  // real token counts. Instead it asks for a CONSERVATIVE pre-call estimate: a fixed
  // token assumption × the live catalog price for the default drafter model (the same
  // model the Creator uses for createStrategyFromText / improve). The estimate is the
  // number shown in the confirm prompt and the value billed against the spend cap.
  const AUTO_DRAFTER_MODEL = "moonshotai/kimi-k2.6";
  // Conservative token assumptions per paid tool (prompt + completion). Sized a touch
  // high so the confirm est never UNDER-states the spend the user is approving.
  const PAID_TOOL_TOKENS: Record<PaidTool, { prompt: number; completion: number }> = {
    createStrategyFromText: { prompt: 6000, completion: 10000 },
    improve: { prompt: 12000, completion: 10000 },
  };
  // Fallback per-million prices when the live catalog has no entry (fail-soft) — set
  // above kimi-k2.6's real price so a missing quote still over-estimates, never under.
  const FALLBACK_PROMPT_PER_M = 1.0;
  const FALLBACK_COMPLETION_PER_M = 4.0;
  // Fetch the drafter price ONCE per turn, then return a SYNC estimator the pure
  // planner can call. (getModelPrice is async + cached; the planner must stay pure.)
  const buildPaidCostEstimator = async (): Promise<(tool: PaidTool) => number> => {
    let pPerM = FALLBACK_PROMPT_PER_M;
    let cPerM = FALLBACK_COMPLETION_PER_M;
    try {
      const price = await getModelPrice(AUTO_DRAFTER_MODEL);
      if (price.promptPerM != null) pPerM = price.promptPerM;
      if (price.completionPerM != null) cPerM = price.completionPerM;
    } catch {
      /* live pricing unavailable → keep the conservative fallback */
    }
    return (tool: PaidTool): number => {
      const t = PAID_TOOL_TOKENS[tool];
      const cost = (t.prompt / 1e6) * pPerM + (t.completion / 1e6) * cPerM;
      return Math.round(cost * 100) / 100;
    };
  };

  // Start a background turn for a task, picking the brain by the task's MODE.
  //
  //   chat → decrypt the BYO key transiently and bind it (+ optional model) into the
  //          LLM brain seam. The buffer is zeroized before returning; the closure
  //          holds only the immutable string copy (same pattern as /draft).
  //   auto → the DETERMINISTIC planner (no key bound — it's LLM-free). The PAID tools
  //          it schedules resolve the key per-call via the adapter's resolveLlmKey, so
  //          we still require ciphertext + umk here so those tools CAN run.
  //
  // "no-key" means the key was deleted or the session is locked between the meta read
  // and now; the caller degrades to the deterministic shell (chat) or ends the run.
  const startTaskTurn = async (
    walletAddress: string,
    taskId: number,
    model: string | undefined,
    mode: string,
  ): Promise<"started" | "already" | "no-key"> => {
    const ciphertext = await storage.getWalletLlmApiKeyCiphertext(walletAddress);
    if (!ciphertext) return "no-key";
    const sessionRes = getSessionByWalletAddress(walletAddress);
    const umk = sessionRes?.session?.umk;
    if (!umk) return "no-key";

    if (mode === "auto") {
      const estimatePaidCostUsd = await buildPaidCostEstimator();
      const brain = createAutoPlanner({ estimatePaidCostUsd });
      const started = startLabTurn({
        taskId,
        walletAddress,
        orchestrator: labOrchestrator,
        opts: { brain, hasKey: true },
      });
      return started ? "started" : "already";
    }

    let keyBuf: Buffer | null = null;
    try {
      keyBuf = decryptLlmApiKeyV3(umk, ciphertext, walletAddress);
      const apiKey = keyBuf.toString("utf8");
      const brain: BrainFn = (ctx) => decideTurnAction({ ...ctx, apiKey, model });
      const started = startLabTurn({
        taskId,
        walletAddress,
        orchestrator: labOrchestrator,
        opts: { brain, hasKey: true },
      });
      return started ? "started" : "already";
    } finally {
      if (keyBuf) keyBuf.fill(0);
    }
  };

  // Park a locked AUTO run instead of killing it. The 30-min session UMK expired mid-flight,
  // so keep the run's full state and wait for a wallet re-sign (POST .../auto/resume). The task
  // STAYS in auto mode (the dock keeps the checklist + a disabled composer) at
  // status="awaiting_input" / turnState="ready" so the client stops driving /step. Every
  // pipeline field (currentStep, activeRunId, loopCount, pendingConfirm, confirmedToken) is
  // PRESERVED by the partial updateAgentTask; only auto.pausedForReauth flips true. Posts the
  // two-chip REAUTH_PAUSED_REPLY once (dup-guarded) so a second no-key site for the same park
  // doesn't stack duplicate prompts.
  const pauseAutoForReauth = async (
    walletAddress: string,
    taskId: number,
    task: LabAgentTask,
    auto: AutoMemory,
  ): Promise<void> => {
    const nextAuto: AutoMemory = { ...auto, pausedForReauth: true };
    await labStorage.updateAgentTask(taskId, {
      memory: { ...((task.memory as Record<string, unknown>) ?? {}), auto: nextAuto },
      mode: "auto",
      status: "awaiting_input",
      turnState: "ready",
      turnStateChangedAt: new Date(),
    });
    // Dup-guard: if the latest agent message already carries the reauth-continue chip, this
    // park was already announced (e.g. /step posted it, then an auto-confirm re-hit the same
    // lock), don't stack a second identical prompt.
    const msgs = await labStorage.listAgentMessagesForWallet(walletAddress, taskId);
    const last = msgs[msgs.length - 1] as
      | { role?: string; suggestedActions?: Array<{ id?: string }> }
      | undefined;
    const alreadyPrompted =
      last?.role === "agent" &&
      Array.isArray(last.suggestedActions) &&
      last.suggestedActions.some((a) => a?.id === "reauth-continue");
    if (alreadyPrompted) return;
    await labStorage.createAgentMessageForWallet(walletAddress, taskId, {
      role: "agent",
      content: REAUTH_PAUSED_REPLY.content,
      suggestedActions: REAUTH_PAUSED_REPLY.suggestedActions,
    });
  };

  // Instant-Stop / decline helper: cancel this task's agent-owned QUEUED runs so the
  // shared worker frees up immediately. markAgentRunCancelled CAS's on status='queued',
  // so a run the worker already claimed is left alone (the child owns its lifecycle).
  const cancelAgentQueuedRuns = async (walletAddress: string, taskId: number): Promise<number> => {
    const runs = await labStorage.getAgentRunsForTask(walletAddress, taskId);
    let cancelled = 0;
    for (const run of runs) {
      if (run.status === "queued") {
        const ok = await labStorage.markAgentRunCancelled(run.id);
        if (ok) cancelled++;
      }
    }
    return cancelled;
  };

  // Find-or-create this wallet's active chat task (seeded with a greeting on first
  // open) and return it with its messages. Atomic + race-free in the storage layer.
  app.post("/api/lab/agent/chat/ensure", ...guards, async (req: Request, res: Response) => {
    const r = req as any;
    try {
      const { task, messages } = await labStorage.ensureActiveChatTask(
        r.walletAddress as string,
        SEED_GREETING,
      );
      res.json({ task: toChatTaskDto(task), messages });
    } catch (err: any) {
      sendError(res, err, "Could not open the assistant. Please try again.");
    }
  });

  app.get("/api/lab/agent/chat/:taskId/messages", ...getGuards, async (req: Request, res: Response) => {
    const r = req as any;
    try {
      const taskId = parseTaskId(req.params.taskId);
      if (taskId === null) return res.status(400).json({ error: "Invalid conversation id." });
      // Wallet-scoped lookup (§8): never resolve a task by id alone.
      const task = await labStorage.getAgentTaskForWallet(r.walletAddress, taskId);
      if (!task) {
        return res.status(404).json({ error: "Conversation not found." });
      }
      const messages = await labStorage.listAgentMessagesForWallet(r.walletAddress, taskId);
      const taskDto = toTurnTaskDto(task);
      // Enrich the quant-agent checklist with the live run's status (queue position /
      // progress) so the dock can honestly show "backtest running" even after the planner
      // has advanced phase to "evaluate". Best-effort: a missing run status never breaks
      // the poll, and exposes nothing beyond status/stage/progress/queue position.
      if (taskDto.auto && task.mode === "auto" && task.activeRunId != null) {
        try {
          const statusRes = await labToolkit.call(
            {
              walletAddress: r.walletAddress,
              taskId,
              correlationId: `task-${taskId}`,
              allow: { read: true, write: false },
            },
            "getRunStatus",
            { runId: task.activeRunId },
          );
          if (statusRes.ok) {
            taskDto.auto.activeRun = {
              status: statusRes.data.status,
              stage: statusRes.data.stage,
              progressPct: statusRes.data.progressPct,
              jobsAhead: statusRes.data.jobsAhead,
            };
          }
        } catch {
          /* run-status read is best-effort; never fail the messages poll over it */
        }
      }
      // Enrich the deployable-result card: the best result the agent has for its current
      // strategy, so the dock can show a real result card + Deploy button (which only
      // OPENS the deploy modal, a money path). Best-effort; never breaks the poll.
      if (taskDto.auto && task.mode === "auto") {
        const currentStrategyId =
          typeof (task.memory as { currentStrategyId?: unknown } | null)?.currentStrategyId === "number"
            ? ((task.memory as { currentStrategyId: number }).currentStrategyId)
            : null;
        if (currentStrategyId != null) {
          try {
            const topRes = await labToolkit.call(
              {
                walletAddress: r.walletAddress,
                taskId,
                correlationId: `task-${taskId}`,
                allow: { read: true, write: false },
              },
              "getTopResults",
              { strategyId: currentStrategyId, limit: 20 },
            );
            if (topRes.ok) {
              const results = Array.isArray(topRes.data?.results) ? topRes.data.results : [];
              taskDto.auto.deployableResult = selectDeployableResult(results, {
                strategyId: currentStrategyId,
                runActive: task.activeRunId != null,
              });
            }
          } catch {
            /* deployable-result read is best-effort; never fail the messages poll over it */
          }
        }
      }
      res.json({ messages, task: taskDto });
    } catch (err: any) {
      sendError(res, err, "Could not load messages.");
    }
  });

  app.post("/api/lab/agent/chat/:taskId/messages", ...guards, async (req: Request, res: Response) => {
    const r = req as any;
    try {
      const taskId = parseTaskId(req.params.taskId);
      if (taskId === null) return res.status(400).json({ error: "Invalid conversation id." });
      const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
      if (!content) return res.status(400).json({ error: "Type a message first." });
      if (content.length > MAX_CHAT_CONTENT) {
        return res.status(400).json({ error: "That message is too long." });
      }

      // --- auto-mode control signals (Task #200) -------------------------------
      // The orchestrator's confirm prompt renders "Yes, spend ~$X" / "No, stop here"
      // as kind:"send" chips carrying these sentinels (see requestConfirmation). They
      // are CONTROL signals, not chat the user typed — intercept them HERE, before the
      // secret guard and before persisting, so they never land in the transcript.
      if (content.startsWith(AUTO_CONFIRM_PREFIX) || content.startsWith(AUTO_DECLINE_PREFIX)) {
        const isConfirm = content.startsWith(AUTO_CONFIRM_PREFIX);
        const prefix = isConfirm ? AUTO_CONFIRM_PREFIX : AUTO_DECLINE_PREFIX;
        const token = content.slice(prefix.length).trim();
        const task = await labStorage.getAgentTaskForWallet(r.walletAddress, taskId);
        if (!task) return res.status(404).json({ error: "Conversation not found." });
        const auto = readAutoMemory(task);
        const pendingToken = auto?.pendingConfirm?.token;
        // CAS: act only when THIS exact pending token is still outstanding (and not
        // already confirmed). A stale/duplicate chip — double-click, retry, an old
        // transcript — is an idempotent no-op: return the current state untouched.
        const matches =
          task.mode === "auto" &&
          !!pendingToken &&
          pendingToken === token &&
          auto?.confirmedToken !== token;
        if (!matches) {
          const current = await labStorage.listAgentMessagesForWallet(r.walletAddress, taskId);
          return res.status(202).json({ messages: current, task: toTurnTaskDto(task) });
        }

        if (isConfirm) {
          // Approve the paid step: persist confirmedToken (KEEP pendingConfirm so the
          // orchestrator can still read its estCostUsd to bill the spend cap), flip to a
          // running turn, and re-drive the deterministic planner — which now sees a
          // matching token and runs the paid tool.
          const nextAuto: AutoMemory = { ...(auto as AutoMemory), confirmedToken: token };
          await labStorage.updateAgentTask(taskId, {
            memory: { ...((task.memory as Record<string, unknown>) ?? {}), auto: nextAuto },
            status: "active",
            turnState: "running_turn",
            turnStateChangedAt: new Date(),
          });
          const outcome = await startTaskTurn(r.walletAddress, taskId, undefined, "auto");
          if (outcome === "no-key") {
            // Key/session gone between approve and re-drive (UMK dropped after an idle
            // reconnect). If the key still EXISTS this is just a locked session: PARK the run
            // for a re-sign (keeping the approval) rather than dropping the paid step the user
            // just OK'd. If the key was DELETED, re-signing can't help, so drop to chat with a
            // re-add note. Pass nextAuto so the confirmedToken/pendingConfirm survive the park.
            const keyMeta = await storage.getWalletLlmApiKeyMeta(r.walletAddress);
            if (!keyMeta.hasKey) {
              await labStorage.updateAgentTask(taskId, {
                mode: "chat", status: "active", turnState: "ready", turnStateChangedAt: new Date(),
              });
              await labStorage.createAgentMessageForWallet(r.walletAddress, taskId, {
                role: "agent",
                content: KEY_MISSING_REPLY.content,
                suggestedActions: KEY_MISSING_REPLY.suggestedActions,
              });
            } else {
              await pauseAutoForReauth(r.walletAddress, taskId, task, nextAuto);
            }
          }
          const updated = await labStorage.getAgentTaskForWallet(r.walletAddress, taskId);
          const msgs = await labStorage.listAgentMessagesForWallet(r.walletAddress, taskId);
          return res.status(202).json({ messages: msgs, task: updated ? toTurnTaskDto(updated) : null });
        }

        // Decline: cancel agent-owned QUEUED runs (free the shared worker), clear the
        // confirm gate, drop back to chat, and post a plain agent note so the transcript
        // shows the run stopped. Nothing was spent — the paid tool never ran. Decline IS a
        // stop, so also clear any pending cancelRequestedAt (closes the ultra-narrow window
        // where a Stop raced this very park and would otherwise leave a stale flag on the
        // now chat-mode task until the next orchestrator entry).
        await cancelAgentQueuedRuns(r.walletAddress, taskId);
        const nextAuto: AutoMemory = { ...(auto as AutoMemory), pendingConfirm: null, confirmedToken: null };
        await labStorage.updateAgentTask(taskId, {
          memory: { ...((task.memory as Record<string, unknown>) ?? {}), auto: nextAuto },
          mode: "chat",
          status: "active",
          turnState: "ready",
          cancelRequestedAt: null,
          turnStateChangedAt: new Date(),
        });
        await labStorage.createAgentMessageForWallet(r.walletAddress, taskId, {
          role: "agent",
          content:
            "Stopped before the paid step — nothing was spent. You're back in chat. Ask me anything, or start a new auto run when you're ready.",
        });
        const updated = await labStorage.getAgentTaskForWallet(r.walletAddress, taskId);
        const msgs = await labStorage.listAgentMessagesForWallet(r.walletAddress, taskId);
        return res.status(200).json({ messages: msgs, task: updated ? toTurnTaskDto(updated) : null });
      }

      // --- auto-mode style gate signal (create phase) --------------------------
      // The planner's "what kind of strategy?" prompt renders each option as a kind:"send"
      // chip carrying this sentinel + a style id. Like the confirm sentinels it's a CONTROL
      // signal, not chat the user typed: intercept it HERE, before the secret guard. Record
      // the chosen style on memory, then re-drive the planner so it drafts with that style.
      if (content.startsWith(AUTO_STYLE_PREFIX)) {
        const styleId = content.slice(AUTO_STYLE_PREFIX.length).trim();
        const task = await labStorage.getAgentTaskForWallet(r.walletAddress, taskId);
        if (!task) return res.status(404).json({ error: "Conversation not found." });
        const auto = readAutoMemory(task);
        const style = styleById(styleId);
        // CAS: act only while THIS run is genuinely awaiting a style and the id is known. A
        // stale/duplicate chip (double-click, an old transcript) is an idempotent no-op.
        const matches =
          task.mode === "auto" && auto?.awaitingStyle === true && !auto?.style && !!style;
        if (!matches) {
          const current = await labStorage.listAgentMessagesForWallet(r.walletAddress, taskId);
          return res.status(202).json({ messages: current, task: toTurnTaskDto(task) });
        }
        // Record the choice as a readable user line (unlike the confirm sentinel, the style
        // pick is a real decision worth showing), apply it, and re-drive the planner.
        await labStorage.createAgentMessageForWallet(r.walletAddress, taskId, {
          role: "user",
          content: style!.label,
        });
        const nextAuto: AutoMemory = { ...(auto as AutoMemory), style: styleId, awaitingStyle: false };
        await labStorage.updateAgentTask(taskId, {
          memory: { ...((task.memory as Record<string, unknown>) ?? {}), auto: nextAuto },
          status: "active",
          turnState: "running_turn",
          turnStateChangedAt: new Date(),
        });
        const outcome = await startTaskTurn(r.walletAddress, taskId, undefined, "auto");
        if (outcome === "no-key") {
          // Key/session gone between the pick and the re-drive. If the key still EXISTS this
          // is a locked session: PARK for a re-sign (keeping the chosen style). If it was
          // DELETED, re-signing can't help, so drop to chat with a re-add note.
          const keyMeta = await storage.getWalletLlmApiKeyMeta(r.walletAddress);
          if (!keyMeta.hasKey) {
            await labStorage.updateAgentTask(taskId, {
              mode: "chat", status: "active", turnState: "ready", turnStateChangedAt: new Date(),
            });
            await labStorage.createAgentMessageForWallet(r.walletAddress, taskId, {
              role: "agent",
              content: KEY_MISSING_REPLY.content,
              suggestedActions: KEY_MISSING_REPLY.suggestedActions,
            });
          } else {
            await pauseAutoForReauth(r.walletAddress, taskId, task, nextAuto);
          }
        }
        const updated = await labStorage.getAgentTaskForWallet(r.walletAddress, taskId);
        const msgs = await labStorage.listAgentMessagesForWallet(r.walletAddress, taskId);
        return res.status(202).json({ messages: msgs, task: updated ? toTurnTaskDto(updated) : null });
      }

      // Pasted-secret guard (security): a pasted API key must NEVER be persisted
      // as a chat message. Reject BEFORE createAgentMessageForWallet so the secret
      // never lands in lab_agent_messages. The error echoes no key material and
      // points the user to the encrypted key entry in the Creator.
      if (looksLikeApiKey(content)) {
        return res.status(400).json({
          error:
            "Don't paste your API key here. Add it securely in the Creator — it goes straight to encrypted storage and is never saved in this chat.",
        });
      }
      // Single-flight at the route, too (defense in depth — the client also disables
      // the composer while a turn runs). If a turn is already live for this task — a
      // second tab, a POST retry, or a stale client that missed the turn_state — do
      // NOT append another user message or start a second (spending) turn: that
      // message could be folded unpredictably into the running turn or stranded with
      // no reply. Return the current transcript + task so the caller syncs to the
      // in-progress turn and keeps polling. Wallet-scoped, so this also 404s a
      // non-owner before any write.
      const existing = await labStorage.getAgentTaskForWallet(r.walletAddress, taskId);
      if (!existing) return res.status(404).json({ error: "Conversation not found." });
      if (existing.turnState !== "ready") {
        const current = await labStorage.listAgentMessagesForWallet(r.walletAddress, taskId);
        return res.status(202).json({ messages: current, task: toTurnTaskDto(existing) });
      }
      // The user message both records the turn AND re-confirms ownership: undefined
      // means the task isn't this wallet's, so don't compose or leak a reply.
      const userMsg = await labStorage.createAgentMessageForWallet(r.walletAddress, taskId, {
        role: "user", content,
      });
      if (!userMsg) return res.status(404).json({ error: "Conversation not found." });

      // Reply composition (Phase C): the turn-loop brain.
      //
      // NO KEY → synchronous deterministic shell reply (no LLM, no turn): the chat
      // still navigates the user around the lab. The shell (composeAgentReply) is
      // ALSO the graceful-degrade fallback below.
      //
      // HAS KEY → start a background turn (lab-turn-jobs) and return 202 at once;
      // the orchestrator drives the toolkit on the user's key, parks on async runs,
      // and the client polls GET .../messages + POSTs .../step. The turn can take
      // far longer than the ~60s proxy-reap window, so it MUST NOT run inline.
      const keyMeta = await storage.getWalletLlmApiKeyMeta(r.walletAddress);

      // Compose-and-return the deterministic shell synchronously. Shared by the
      // no-key path and every has-key degrade (rate-limited, locked session, etc.).
      // `sessionLocked` distinguishes "key saved but the idle session can't unlock it"
      // (offer a one-tap re-sign) from a true keyless wallet / transient degrade (the
      // generic capability shell). Without this the locked user gets the SAME canned
      // reply as a keyless one — silent, with no way back to the full assistant.
      const degradeToShell = async (opts?: { sessionLocked?: boolean }) => {
        const reply = opts?.sessionLocked
          ? SESSION_LOCKED_REPLY
          : composeAgentReply(content, keyMeta.hasKey);
        const agentMsg = await labStorage.createAgentMessageForWallet(r.walletAddress, taskId, {
          role: "agent", content: reply.content, suggestedActions: reply.suggestedActions,
        });
        const task = await labStorage.getAgentTaskForWallet(r.walletAddress, taskId);
        return res.json({
          messages: agentMsg ? [userMsg, agentMsg] : [userMsg],
          task: task ? toTurnTaskDto(task) : null,
        });
      };

      if (!keyMeta.hasKey) return await degradeToShell();

      try {
        // Validate an optional model override before doing any work.
        const rawModel = typeof req.body?.model === "string" ? req.body.model.trim() : "";
        const model = rawModel && rawModel !== "auto" ? rawModel : undefined;
        if (model && !isSelectableModel(model)) {
          return res.status(400).json({ error: "That model isn't available to choose." });
        }
        // Bound new-turn abuse (reconnect, polling retry, two open tabs). Shares the
        // Creator's per-wallet limiter; over the limit we degrade rather than error.
        checkRateLimit(r.walletAddress);

        // Reflect the running turn immediately so a fast GET poll can't see "ready"
        // before the background job flips it (which would stop polling prematurely).
        // The per-task spend cap is enforced inside the orchestrator, which degrades
        // to the shell on its first iteration once at/over the cap.
        await labStorage.updateAgentTask(taskId, {
          turnState: "running_turn", turnStateChangedAt: new Date(),
        });

        const outcome = await startTaskTurn(r.walletAddress, taskId, model, existing.mode);
        if (outcome === "no-key") {
          // We only reach here when keyMeta.hasKey was true (the keyless path returned
          // above), so "no-key" now means the SESSION can't unlock a saved key — the UMK
          // is gone after an idle reconnect. Surface the locked state + a re-sign chip
          // instead of pretending there's no key (which read as "the assistant degraded").
          await labStorage.updateAgentTask(taskId, {
            turnState: "ready", turnStateChangedAt: new Date(),
          });
          return await degradeToShell({ sessionLocked: true });
        }
        const task = await labStorage.getAgentTaskForWallet(r.walletAddress, taskId);
        return res.status(202).json({ messages: [userMsg], task: task ? toTurnTaskDto(task) : null });
      } catch (err) {
        // Rate-limit (429) or any pre-flight failure: degrade so the chat never
        // hard-errors. Reset turnState in case we optimistically set running_turn.
        await labStorage
          .updateAgentTask(taskId, { turnState: "ready", turnStateChangedAt: new Date() })
          .catch(() => {});
        return await degradeToShell();
      }
    } catch (err: any) {
      sendError(res, err, "Could not send your message.");
    }
  });

  // Resume a parked turn (client-driven /step). After an async run finishes, this
  // re-enters the orchestrator: it reconciles live run state, folds the result into
  // the transcript, and lets the brain continue. Single-flight via the job store +
  // the orchestrator's CAS lease, so a /step racing the start job (or a duplicate
  // /step) is a safe no-op. Returns 202; the client keeps polling GET .../messages.
  app.post("/api/lab/agent/chat/:taskId/step", ...guards, async (req: Request, res: Response) => {
    const r = req as any;
    try {
      const taskId = parseTaskId(req.params.taskId);
      if (taskId === null) return res.status(400).json({ error: "Invalid conversation id." });
      // Wallet-scoped (§8): never resolve a task by id alone; 404 (no existence leak).
      const task = await labStorage.getAgentTaskForWallet(r.walletAddress, taskId);
      if (!task) return res.status(404).json({ error: "Conversation not found." });

      // A turn is already advancing in this process: cheap no-op (the CAS lease would
      // reject a second advance anyway). Avoids a needless key decrypt per poll. A running
      // loop also consumes any pending Stop itself, at its gate (before the brain), so leave
      // it alone — don't consume its flag from here.
      if (isLabTurnRunning(taskId)) {
        return res.status(202).json({ task: toTurnTaskDto(task), resumed: false });
      }

      // No live loop, but a Stop is pending: consume it HERE, key-free, BEFORE the
      // "nothing to resume" check below — an await_confirm park sits at turnState=ready, so
      // gating consumption on a live turnState would miss it. Stopping never runs a tool, so
      // it must not hinge on the LLM key that startTaskTurn (below) needs. Primary stop
      // consumption is in the orchestrator + /auto/stop; this is defense-in-depth for any
      // stray /step. Drop back to chat + clear the parked-run marker.
      if (task.cancelRequestedAt) {
        await labStorage.updateAgentTask(taskId, {
          cancelRequestedAt: null,
          mode: "chat",
          status: "active",
          turnState: "ready",
          turnStateChangedAt: new Date(),
          currentStep: null,
          activeRunId: null,
          loopCount: 0,
        });
        const updated = await labStorage.getAgentTaskForWallet(r.walletAddress, taskId);
        return res.status(202).json({ task: updated ? toTurnTaskDto(updated) : null, resumed: false });
      }

      // Nothing to resume once the turn is back to ready (or never started).
      if (task.turnState !== "running_turn" && task.turnState !== "waiting_for_tool") {
        return res.status(202).json({ task: toTurnTaskDto(task), resumed: false });
      }

      const rawModel = typeof req.body?.model === "string" ? req.body.model.trim() : "";
      const model = rawModel && rawModel !== "auto" ? rawModel : undefined;
      if (model && !isSelectableModel(model)) {
        return res.status(400).json({ error: "That model isn't available to choose." });
      }

      const outcome = await startTaskTurn(r.walletAddress, taskId, model, task.mode);
      if (outcome === "no-key") {
        if (task.mode === "auto") {
          // An AUTO run lost the key mid-flight (the UMK dropped after an idle reconnect).
          // Don't kill it: if the key still EXISTS it's just a locked session, so PARK the run
          // for a re-sign. Parking preserves currentStep/activeRunId so resume picks the
          // in-flight run up exactly where it left off (a queued backtest keeps running and is
          // folded once we resume). If the key was DELETED, re-signing can't help, so drop to
          // chat with a re-add note.
          const keyMeta = await storage.getWalletLlmApiKeyMeta(r.walletAddress);
          const auto = readAutoMemory(task);
          if (!keyMeta.hasKey || !auto) {
            await labStorage.updateAgentTask(taskId, {
              mode: "chat", status: "active", turnState: "ready", turnStateChangedAt: new Date(),
            });
            await labStorage.createAgentMessageForWallet(r.walletAddress, taskId, {
              role: "agent",
              content: KEY_MISSING_REPLY.content,
              suggestedActions: KEY_MISSING_REPLY.suggestedActions,
            });
          } else {
            await pauseAutoForReauth(r.walletAddress, taskId, task, auto);
          }
          const updatedAuto = await labStorage.getAgentTaskForWallet(r.walletAddress, taskId);
          const msgsAuto = await labStorage.listAgentMessagesForWallet(r.walletAddress, taskId);
          return res.status(202).json({
            task: updatedAuto ? toTurnTaskDto(updatedAuto) : null,
            resumed: false,
            messages: msgsAuto,
          });
        }
        // Chat-mode degrade (unchanged): the orchestrator needs the key to interpret a finished
        // run, so end the parked turn rather than hang. POST the locked-session note + re-sign
        // chip. This is the exact "no reply" symptom when a turn loses the key, and a silent
        // reset to ready leaves the user staring at nothing. Drop back to chat so the dock isn't
        // stranded. Posted once: the next /step early-returns at the ready guard above.
        await labStorage.updateAgentTask(taskId, {
          mode: "chat",
          status: "active",
          turnState: "ready",
          turnStateChangedAt: new Date(),
        });
        const lockedMsg = await labStorage.createAgentMessageForWallet(r.walletAddress, taskId, {
          role: "agent",
          content: SESSION_LOCKED_REPLY.content,
          suggestedActions: SESSION_LOCKED_REPLY.suggestedActions,
        });
        const updated = await labStorage.getAgentTaskForWallet(r.walletAddress, taskId);
        return res.status(202).json({
          task: updated ? toTurnTaskDto(updated) : null,
          resumed: false,
          messages: lockedMsg ? [lockedMsg] : [],
        });
      }
      const updated = await labStorage.getAgentTaskForWallet(r.walletAddress, taskId);
      return res.status(202).json({ task: updated ? toTurnTaskDto(updated) : null, resumed: true });
    } catch (err: any) {
      sendError(res, err, "Could not resume the assistant.");
    }
  });

  // --- auto mode (Task #200): watched auto-grind loop --------------------------
  // Start a watched auto run on this task: reset the pipeline state, set a goal, flip
  // the task into "auto" mode, and kick off the deterministic planner. The planner
  // auto-flows the FREE pipeline (create → backtest sweep across the asset basket →
  // insights) and STOPS with a confirm prompt before each PAID step.
  app.post("/api/lab/agent/chat/:taskId/auto/start", ...guards, async (req: Request, res: Response) => {
    const r = req as any;
    try {
      const taskId = parseTaskId(req.params.taskId);
      if (taskId === null) return res.status(400).json({ error: "Invalid conversation id." });
      const goal = typeof req.body?.goal === "string" ? req.body.goal.trim() : "";
      if (!goal) return res.status(400).json({ error: "Describe the strategy you want me to build first." });
      if (goal.length > MAX_CHAT_CONTENT) {
        return res.status(400).json({ error: "That description is too long." });
      }
      // Pasted-secret guard: the goal is persisted (and echoed in the transcript), so a
      // pasted key must never land here. Same rule as a chat message.
      if (looksLikeApiKey(goal)) {
        return res.status(400).json({
          error:
            "Don't paste your API key here. Add it securely in the Creator — it goes straight to encrypted storage and is never saved in this chat.",
        });
      }
      // Auto needs the BYO key: even though the planner is LLM-free, the PAID steps it
      // schedules spend the user's OpenRouter key. Refuse up front (clear message) if
      // there's no key, rather than starting a run that can't reach its paid steps.
      const keyMeta = await storage.getWalletLlmApiKeyMeta(r.walletAddress);
      if (!keyMeta.hasKey) {
        return res.status(400).json({
          error: "Add your OpenRouter key in the Creator first — auto mode uses it for the AI build/improve steps.",
        });
      }

      const task = await labStorage.getAgentTaskForWallet(r.walletAddress, taskId);
      if (!task) return res.status(404).json({ error: "Conversation not found." });
      // Single-flight: block a new auto run only over a turn that is ACTIVELY advancing.
      // "Active" = a live in-process loop (isLabTurnRunning) OR an unexpired DB turn-lease
      // (the cross-process CAS guard; a parked turn RELEASES its lease in advance()'s
      // finally, so a non-null unexpired lease means a segment is mid-flight right now). A
      // non-ready turnState with NEITHER is an ORPHANED/parked turn — the client stopped
      // polling /step, or a turn ended without resetting state — and nothing will ever
      // finish it. Starting fresh RECLAIMS it instead of wedging the user behind a
      // permanent "finish the current turn" 409. Routes by liveness, like /stop.
      const leaseActive =
        task.turnLeaseExpiresAt != null && task.turnLeaseExpiresAt.getTime() > Date.now();
      if (task.turnState !== "ready" && (isLabTurnRunning(taskId) || leaseActive)) {
        return res.status(409).json({ error: "Finish the current turn before starting an auto run." });
      }
      // Reclaiming an orphaned/parked turn: cancel any agent-owned run it left queued so a
      // stale backtest can't keep consuming the shared worker under the fresh run.
      if (task.turnState !== "ready") {
        await cancelAgentQueuedRuns(r.walletAddress, taskId);
      }

      // Hands-off intent: the client may ASK for hands-off; whether it takes effect is
      // decided live by isHandsOffEligible (open to all by default, else admin whitelist).
      // A non-eligible request silently falls back to watched mode, same run with confirm chips.
      const wantsHandsOff = req.body?.handsOff === true;
      let effectiveHandsOff = false;
      if (wantsHandsOff) {
        try {
          effectiveHandsOff = await isHandsOffEligible(r.walletAddress);
        } catch {
          effectiveHandsOff = false; // fail-closed: eligibility read failed, use watched mode
        }
      }

      // Record the goal in the transcript so the watcher sees what was asked, then reset
      // the pipeline to a clean slate so a fresh auto run starts at the create phase (and
      // its style gate). EVERY per-run pipeline pointer is cleared: a leftover
      // currentStrategyId from a previous strategy makes the planner SKIP create — and
      // thus the style gate — to optimize the OLD strategy without confirmation; a leftover
      // currentStep/activeRunId would replay or reconcile a stale step instead of starting
      // fresh. (The reauth PARK deliberately PRESERVES these for resume; a new START clears
      // them.) The fresh budget also gives each watched run its own spend + step leashes.
      await labStorage.createAgentMessageForWallet(r.walletAddress, taskId, { role: "user", content: goal });
      await labStorage.updateAgentTask(taskId, {
        goal,
        mode: "auto",
        status: "active",
        memory: {
          ...((task.memory as Record<string, unknown>) ?? {}),
          currentStrategyId: null,
          lastFinishedRunId: null,
          autoLastTool: null,
          auto: { ...defaultAutoMemory(), handsOff: effectiveHandsOff },
        },
        spendEstimateUsd: 0,
        cancelRequestedAt: null,
        currentStep: null,
        activeRunId: null,
        loopCount: 0,
        turnState: "running_turn",
        turnStateChangedAt: new Date(),
      });

      const outcome = await startTaskTurn(r.walletAddress, taskId, undefined, "auto");
      if (outcome === "no-key") {
        // hasKey was true moments ago (checked above), so this is a locked session: the UMK
        // dropped between the meta read and the decrypt (an idle reconnect). PARK the
        // just-started run for a re-sign rather than discarding the goal the user just gave;
        // resume kicks the pipeline off from this fresh state. The composer is visible here
        // (signedIn=true), so the signed-out Reconnect panel is NOT rendered. The parked
        // checklist's "Continue session" chip gives the one-tap re-sign. (If the key was
        // actually deleted in that sliver, resume re-detects it and posts the re-add note.)
        // Use the POST-RESET task so the park spreads the just-cleared memory (it merges
        // ...task.memory). Passing the stale pre-reset `task` would reintroduce the leaked
        // currentStrategyId/autoLastTool and skip the style gate again after re-sign.
        const afterReset = await labStorage.getAgentTaskForWallet(r.walletAddress, taskId);
        await pauseAutoForReauth(r.walletAddress, taskId, afterReset ?? task, {
          ...defaultAutoMemory(),
          handsOff: effectiveHandsOff,
        });
        const updated = await labStorage.getAgentTaskForWallet(r.walletAddress, taskId);
        const msgs = await labStorage.listAgentMessagesForWallet(r.walletAddress, taskId);
        return res.status(202).json({ messages: msgs, task: updated ? toTurnTaskDto(updated) : null });
      }
      const updated = await labStorage.getAgentTaskForWallet(r.walletAddress, taskId);
      const msgs = await labStorage.listAgentMessagesForWallet(r.walletAddress, taskId);
      return res.status(202).json({ messages: msgs, task: updated ? toTurnTaskDto(updated) : null });
    } catch (err: any) {
      sendError(res, err, "Could not start the auto run.");
    }
  });

  // Instant Stop: cancel agent-owned QUEUED runs (free the shared worker now), signal a
  // running segment to wind down, clear any confirm gate, and drop back to chat. Safe to
  // call at any point — idempotent if the run already ended.
  app.post("/api/lab/agent/chat/:taskId/auto/stop", ...guards, async (req: Request, res: Response) => {
    const r = req as any;
    try {
      const taskId = parseTaskId(req.params.taskId);
      if (taskId === null) return res.status(400).json({ error: "Invalid conversation id." });
      const task = await labStorage.getAgentTaskForWallet(r.walletAddress, taskId);
      if (!task) return res.status(404).json({ error: "Conversation not found." });

      const cancelled = await cancelAgentQueuedRuns(r.walletAddress, taskId);
      const auto = readAutoMemory(task);
      const nextAuto: AutoMemory | undefined = auto
        ? { ...auto, pendingConfirm: null, confirmedToken: null }
        : undefined;
      const memoryPatch = nextAuto
        ? { memory: { ...((task.memory as Record<string, unknown>) ?? {}), auto: nextAuto } }
        : {};
      // Route by whether a segment is ACTIVELY advancing in this process — NOT by
      // turnState. Only a live loop can consume cancelRequestedAt at its gate (before the
      // brain, no LLM key needed). A PARKED/orphaned/idle auto turn has no such loop, and
      // its only re-entry (/step) needs the key — a stop must never depend on that. So we
      // finalize those directly here; only a truly-running loop is signalled + consumed.
      if (isLabTurnRunning(taskId)) {
        // Signal the running loop; it winds down + flips mode→chat at its next gate. If it
        // parks before seeing the flag, the /step poll consumes it key-free (top of /step).
        await labStorage.updateAgentTask(taskId, { cancelRequestedAt: new Date(), ...memoryPatch });
      } else {
        // No live loop: drop straight back to chat, clearing any parked-run marker AND the
        // flag, so nothing strands and the next turn isn't poisoned. Queued agent runs were
        // already cancelled above; a run the worker already claimed finishes on its own.
        await labStorage.updateAgentTask(taskId, {
          mode: "chat",
          status: "active",
          turnState: "ready",
          turnStateChangedAt: new Date(),
          currentStep: null,
          activeRunId: null,
          cancelRequestedAt: null,
          loopCount: 0,
          ...memoryPatch,
        });
      }
      await labStorage.createAgentMessageForWallet(r.walletAddress, taskId, {
        role: "agent",
        content:
          cancelled > 0
            ? `Stopped. I cancelled ${cancelled} queued backtest${cancelled === 1 ? "" : "s"} and freed the worker. You're back in chat.`
            : "Stopped. You're back in chat — ask me anything, or start a new auto run when you're ready.",
      });
      const updated = await labStorage.getAgentTaskForWallet(r.walletAddress, taskId);
      const msgs = await labStorage.listAgentMessagesForWallet(r.walletAddress, taskId);
      return res.status(200).json({ messages: msgs, task: updated ? toTurnTaskDto(updated) : null });
    } catch (err: any) {
      sendError(res, err, "Could not stop the auto run.");
    }
  });

  // Resume a PARKED auto run after a wallet re-sign. The 30-min session UMK expired mid-run and
  // we parked instead of killing, so the dock calls this once the user taps "Continue session"
  // and the re-sign has reloaded the session UMK. Wallet-scoped. Stop wins: a pending
  // cancelRequestedAt is honored first (the user changed their mind). If the run isn't actually
  // parked it's an idempotent no-op. Otherwise: re-validate a stale hands-off approval, clear the
  // pause flag, flip back to a running turn, and re-enter the orchestrator, which reconciles +
  // resumes from the preserved currentStep/activeRunId. A still-locked session re-parks; a
  // deleted key drops to chat with the re-add note.
  app.post("/api/lab/agent/chat/:taskId/auto/resume", ...guards, async (req: Request, res: Response) => {
    const r = req as any;
    try {
      const taskId = parseTaskId(req.params.taskId);
      if (taskId === null) return res.status(400).json({ error: "Invalid conversation id." });
      const task = await labStorage.getAgentTaskForWallet(r.walletAddress, taskId);
      if (!task) return res.status(404).json({ error: "Conversation not found." });

      // Stop wins: a Stop requested while parked (or racing this resume) is honored. Consume the
      // flag, cancel agent-owned queued runs, drop back to chat. Mirrors /auto/stop's no-live-loop
      // branch (a parked run has no running loop).
      if (task.cancelRequestedAt) {
        const cancelled = await cancelAgentQueuedRuns(r.walletAddress, taskId);
        const stopAuto = readAutoMemory(task);
        const stopPatch = stopAuto
          ? {
              memory: {
                ...((task.memory as Record<string, unknown>) ?? {}),
                auto: { ...stopAuto, pendingConfirm: null, confirmedToken: null, pausedForReauth: false },
              },
            }
          : {};
        await labStorage.updateAgentTask(taskId, {
          cancelRequestedAt: null,
          mode: "chat",
          status: "active",
          turnState: "ready",
          turnStateChangedAt: new Date(),
          currentStep: null,
          activeRunId: null,
          loopCount: 0,
          ...stopPatch,
        });
        await labStorage.createAgentMessageForWallet(r.walletAddress, taskId, {
          role: "agent",
          content:
            cancelled > 0
              ? `Stopped. I cancelled ${cancelled} queued backtest${cancelled === 1 ? "" : "s"} and freed the worker. You're back in chat.`
              : "Stopped. You're back in chat — ask me anything, or start a new auto run when you're ready.",
        });
        const updated = await labStorage.getAgentTaskForWallet(r.walletAddress, taskId);
        const msgs = await labStorage.listAgentMessagesForWallet(r.walletAddress, taskId);
        return res.status(200).json({ messages: msgs, task: updated ? toTurnTaskDto(updated) : null });
      }

      const auto = readAutoMemory(task);
      // Idempotent: only a parked run resumes. A double-tap, or a resume on a run that's already
      // moving, is a harmless no-op.
      if (!auto || auto.pausedForReauth !== true) {
        const msgs = await labStorage.listAgentMessagesForWallet(r.walletAddress, taskId);
        return res.status(202).json({ messages: msgs, task: toTurnTaskDto(task) });
      }

      // Re-validate a stale hands-off approval: if this run auto-approved a paid step
      // (confirmedToken on a pendingConfirm) under hands-off and the wallet's eligibility was
      // revoked while parked, DON'T silently spend on resume: clear the approval so the pending
      // confirm surfaces a watched-mode chip again. A human-approved (watched) token is kept.
      let nextAuto: AutoMemory = { ...auto, pausedForReauth: false };
      if (auto.handsOff && auto.confirmedToken && auto.pendingConfirm) {
        let stillEligible = false;
        try {
          stillEligible = await isHandsOffEligible(r.walletAddress);
        } catch {
          stillEligible = false; // fail-closed: eligibility read failed, require a fresh confirm
        }
        if (!stillEligible) nextAuto = { ...nextAuto, confirmedToken: null };
      }
      await labStorage.updateAgentTask(taskId, {
        memory: { ...((task.memory as Record<string, unknown>) ?? {}), auto: nextAuto },
        mode: "auto",
        status: "active",
        turnState: "running_turn",
        turnStateChangedAt: new Date(),
      });

      const outcome = await startTaskTurn(r.walletAddress, taskId, undefined, "auto");
      if (outcome === "no-key") {
        // Still no key right after the re-sign. If the key was DELETED, re-signing can't bring it
        // back, so drop to chat with the re-add note. If it's just STILL locked, re-park (the
        // existing prompt stays via the dup-guard) so the user can try the re-sign again.
        const keyMeta = await storage.getWalletLlmApiKeyMeta(r.walletAddress);
        const reread = await labStorage.getAgentTaskForWallet(r.walletAddress, taskId);
        if (!keyMeta.hasKey || !reread) {
          await labStorage.updateAgentTask(taskId, {
            mode: "chat",
            status: "active",
            turnState: "ready",
            turnStateChangedAt: new Date(),
          });
          await labStorage.createAgentMessageForWallet(r.walletAddress, taskId, {
            role: "agent",
            content: KEY_MISSING_REPLY.content,
            suggestedActions: KEY_MISSING_REPLY.suggestedActions,
          });
        } else {
          await pauseAutoForReauth(r.walletAddress, taskId, reread, readAutoMemory(reread) ?? nextAuto);
        }
      }
      const updated = await labStorage.getAgentTaskForWallet(r.walletAddress, taskId);
      const msgs = await labStorage.listAgentMessagesForWallet(r.walletAddress, taskId);
      return res.status(202).json({ messages: msgs, task: updated ? toTurnTaskDto(updated) : null });
    } catch (err: any) {
      sendError(res, err, "Could not resume the auto run.");
    }
  });

  // Is THIS wallet allowed to run hands-off (auto-approve paid steps without check-ins)?
  // Drives the dock's hands-off toggle. Open to all by default, else the admin whitelist.
  // Fail-closed: any read error reports ineligible, so the UI never offers what it can't grant.
  app.get("/api/lab/agent/handsoff-eligibility", ...guards, async (req: Request, res: Response) => {
    const r = req as any;
    try {
      const eligible = await isHandsOffEligible(r.walletAddress);
      return res.status(200).json({ eligible: !!eligible });
    } catch {
      return res.status(200).json({ eligible: false });
    }
  });

  // --- BYO key management -------------------------------------------------------
  app.post("/api/lab/creator/key", ...guards, async (req: Request, res: Response) => {
    const r = req as any;
    let keyBuf: Buffer | null = null;
    try {
      const apiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
      if (!apiKey) return res.status(400).json({ error: "An API key is required." });
      if (!apiKey.startsWith("sk-or-")) {
        return res.status(400).json({ error: "That doesn't look like an OpenRouter key (it should start with sk-or-)." });
      }
      if (apiKey.length < 16 || apiKey.length > 400) {
        return res.status(400).json({ error: "That key length looks wrong — double-check and paste it again." });
      }
      const umk = getInteractiveUmk(r, res);
      if (!umk) return;
      keyBuf = Buffer.from(apiKey, "utf8");
      const encrypted = encryptLlmApiKeyV3(umk, keyBuf, r.walletAddress);
      const last4 = apiKey.slice(-4);
      await storage.setWalletLlmApiKey(r.walletAddress, encrypted, last4, "openrouter");
      res.json({ hasKey: true, last4, provider: "openrouter" });
    } catch (err: any) {
      sendError(res, err, "Could not save your key. Please try again.");
    } finally {
      if (keyBuf) keyBuf.fill(0);
    }
  });

  app.get("/api/lab/creator/key", ...guards, async (req: Request, res: Response) => {
    const r = req as any;
    try {
      const meta = await storage.getWalletLlmApiKeyMeta(r.walletAddress);
      res.json(meta);
    } catch (err: any) {
      sendError(res, err, "Could not read key status.");
    }
  });

  app.delete("/api/lab/creator/key", ...guards, async (req: Request, res: Response) => {
    const r = req as any;
    try {
      await storage.clearWalletLlmApiKey(r.walletAddress);
      res.json({ hasKey: false });
    } catch (err: any) {
      sendError(res, err, "Could not clear your key.");
    }
  });

  // --- Selectable model catalog (Auto blend + overrides, with live pricing) -----
  app.get("/api/lab/creator/models", ...guards, async (_req: Request, res: Response) => {
    try {
      res.json(await getCreatorModelCatalog());
    } catch (err: any) {
      sendError(res, err, "Could not load the model list.");
    }
  });

  // --- Draft a strategy from a plain-English idea -------------------------------
  app.post("/api/lab/creator/draft", ...guards, async (req: Request, res: Response) => {
    const r = req as any;
    let keyBuf: Buffer | null = null;
    try {
      const idea = typeof req.body?.idea === "string" ? req.body.idea : "";
      if (!idea.trim()) return res.status(400).json({ error: "Describe the strategy you want first." });

      const rawModel = typeof req.body?.model === "string" ? req.body.model.trim() : "";
      const model = rawModel && rawModel !== "auto" ? rawModel : undefined;
      if (model && !isSelectableModel(model)) {
        return res.status(400).json({ error: "That model isn't available to choose." });
      }

      const ciphertext = await storage.getWalletLlmApiKeyCiphertext(r.walletAddress);
      if (!ciphertext) return res.status(400).json({ error: "Add your OpenRouter API key first." });

      const umk = getInteractiveUmk(r, res);
      if (!umk) return;
      keyBuf = decryptLlmApiKeyV3(umk, ciphertext, r.walletAddress);
      // Capture the key as an (immutable) string the background job can hold, then
      // zero the buffer in this request's finally. The LLM chain outlives the HTTP
      // request, so it runs as a job and the client polls for the result. Zeroing the
      // buffer here is safe — the string copy can't be zeroed anyway and is the only
      // thing the job keeps; the request never holds the connection open.
      const apiKey = keyBuf.toString("utf8");
      const walletAddress = r.walletAddress as string;

      const jobId = startCreatorJob(
        walletAddress,
        "draft",
        "Could not draft a strategy. Please try again.",
        async () => {
          const result = await draftStrategy({ idea, apiKey, walletAddress, model });
          const parse = result.compileOk ? safeParse(result.pineScript) : null;
          return { ...result, parse };
        },
      );
      res.status(202).json({ jobId });
    } catch (err: any) {
      if (err instanceof CreatorJobConflictError) {
        return res.status(409).json({ error: err.message, jobId: err.jobId });
      }
      sendError(res, err, "Could not draft a strategy. Please try again.");
    } finally {
      if (keyBuf) keyBuf.fill(0);
    }
  });

  // --- Improve an existing strategy from a backtest insights report -------------
  app.post("/api/lab/creator/improve", ...guards, async (req: Request, res: Response) => {
    const r = req as any;
    let keyBuf: Buffer | null = null;
    try {
      const body = req.body ?? {};
      let pine = typeof body.currentPine === "string" ? body.currentPine : "";

      // If a saved strategy id is provided, load it and enforce ownership.
      if (body.strategyId !== undefined && body.strategyId !== null && `${body.strategyId}` !== "") {
        const sid = parseInt(String(body.strategyId), 10);
        if (Number.isNaN(sid)) return res.status(400).json({ error: "Invalid strategy id." });
        const [strat] = await db.select().from(labStrategies).where(eq(labStrategies.id, sid)).limit(1);
        if (!strat) return res.status(404).json({ error: "Strategy not found." });
        if (strat.userId && strat.userId !== r.walletAddress) {
          return res.status(403).json({ error: "Access denied." });
        }
        pine = strat.pineScript || pine;
      }

      if (!pine.trim()) return res.status(400).json({ error: "No strategy to improve." });

      const insights = typeof body.insights === "string" ? body.insights : "";
      const idea = typeof body.idea === "string" ? body.idea : undefined;

      const rawModel = typeof body.model === "string" ? body.model.trim() : "";
      const model = rawModel && rawModel !== "auto" ? rawModel : undefined;
      if (model && !isSelectableModel(model)) {
        return res.status(400).json({ error: "That model isn't available to choose." });
      }

      const ciphertext = await storage.getWalletLlmApiKeyCiphertext(r.walletAddress);
      if (!ciphertext) return res.status(400).json({ error: "Add your OpenRouter API key first." });

      const umk = getInteractiveUmk(r, res);
      if (!umk) return;
      keyBuf = decryptLlmApiKeyV3(umk, ciphertext, r.walletAddress);
      // See /draft above for why the key is captured as a string and the buffer is
      // zeroed here while the chain runs as a background job.
      const apiKey = keyBuf.toString("utf8");
      const walletAddress = r.walletAddress as string;
      const currentPine = pine;

      const jobId = startCreatorJob(
        walletAddress,
        "improve",
        "Could not improve the strategy. Please try again.",
        async () => {
          const result = await improveStrategy({
            currentPine,
            insights,
            apiKey,
            walletAddress,
            idea,
            model,
          });
          const parse = result.compileOk ? safeParse(result.pineScript) : null;
          return { ...result, parse };
        },
      );
      res.status(202).json({ jobId });
    } catch (err: any) {
      if (err instanceof CreatorJobConflictError) {
        return res.status(409).json({ error: err.message, jobId: err.jobId });
      }
      sendError(res, err, "Could not improve the strategy. Please try again.");
    } finally {
      if (keyBuf) keyBuf.fill(0);
    }
  });

  // --- Poll a draft/improve job ------------------------------------------------
  // The generation chain runs in the background (see creator-jobs.ts); the client
  // polls here until status flips to "done" or "error". Ownership is enforced so one
  // wallet can't read another's job — 404 (not 403) so job existence isn't leaked.
  app.get("/api/lab/creator/job/:jobId", ...getGuards, (req: Request, res: Response) => {
    const r = req as any;
    const job = getCreatorJob(req.params.jobId);
    if (!job || job.walletAddress !== r.walletAddress) {
      return res.status(404).json({ error: "That generation wasn't found — it may have expired. Try again." });
    }
    res.json({
      status: job.status,
      result: job.result ?? null,
      error: job.error ?? null,
    });
  });
}
