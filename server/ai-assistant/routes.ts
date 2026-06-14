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
import { getCreatorModelCatalog, isSelectableModel, estimateCallCostUsd } from "./models-catalog";
import { LlmGatewayError, checkRateLimit } from "./router";
import { startCreatorJob, getCreatorJob, CreatorJobConflictError } from "./creator-jobs";
import { labStorage } from "../lab/storage";
import { SEED_GREETING, composeAgentReply } from "../lab-agent/chat-replies";
import { decideTurnAction, type BrainFn } from "../lab-agent/chat-brain";
import { looksLikeApiKey } from "@shared/api-key-detect";
import { createLabTurnOrchestrator } from "../lab-agent/orchestrator";
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
  // The turn-loop view the client polls on: enough to decide whether to keep
  // polling (running_turn), drive a resume (waiting_for_tool), or stop (ready).
  const toTurnTaskDto = (t: LabAgentTask) => ({
    id: t.id,
    status: t.status,
    turnState: t.turnState,
    activeRunId: t.activeRunId ?? null,
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
  const labOrchestrator = createLabTurnOrchestrator({
    storage: labStorage,
    toolkit: new LabAgentToolkit(createCurrentLabAdapter(labStorage, kickLabQueue, resolveLlmKey)),
    reconcile: (taskId: number) => reconcileTask(labStorage, taskId),
    composeReply: composeAgentReply,
    estimateCost: estimateCallCostUsd,
    limits: { hardSpendCapUsd: LAB_CHAT_TASK_SPEND_CAP_USD },
  });

  // Decrypt the BYO key transiently, bind it (+ optional model) into a brain seam,
  // and kick off a background turn. The key buffer is zeroized before returning —
  // the brain closure holds only the immutable string copy (same pattern as
  // /draft). "no-key" means the key was deleted or the session is locked between
  // the meta read and now; the caller degrades to the deterministic shell.
  const startTurnWithKey = async (
    walletAddress: string,
    taskId: number,
    model: string | undefined,
  ): Promise<"started" | "already" | "no-key"> => {
    const ciphertext = await storage.getWalletLlmApiKeyCiphertext(walletAddress);
    if (!ciphertext) return "no-key";
    const sessionRes = getSessionByWalletAddress(walletAddress);
    const umk = sessionRes?.session?.umk;
    if (!umk) return "no-key";
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
      res.json({ messages, task: toTurnTaskDto(task) });
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
      const degradeToShell = async () => {
        const reply = composeAgentReply(content, keyMeta.hasKey);
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

        const outcome = await startTurnWithKey(r.walletAddress, taskId, model);
        if (outcome === "no-key") {
          // Key deleted or session locked between the meta read and the decrypt.
          await labStorage.updateAgentTask(taskId, {
            turnState: "ready", turnStateChangedAt: new Date(),
          });
          return await degradeToShell();
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

      // Nothing to resume once the turn is back to ready (or never started).
      if (task.turnState !== "running_turn" && task.turnState !== "waiting_for_tool") {
        return res.status(202).json({ task: toTurnTaskDto(task), resumed: false });
      }
      // A turn is already advancing in this process: cheap no-op (the CAS lease would
      // reject a second advance anyway). Avoids a needless key decrypt per poll.
      if (isLabTurnRunning(taskId)) {
        return res.status(202).json({ task: toTurnTaskDto(task), resumed: false });
      }

      const rawModel = typeof req.body?.model === "string" ? req.body.model.trim() : "";
      const model = rawModel && rawModel !== "auto" ? rawModel : undefined;
      if (model && !isSelectableModel(model)) {
        return res.status(400).json({ error: "That model isn't available to choose." });
      }

      const outcome = await startTurnWithKey(r.walletAddress, taskId, model);
      if (outcome === "no-key") {
        // Key/session gone mid-turn: the orchestrator needs the key to interpret a
        // finished run, so end the parked turn cleanly (ready) rather than hang. A
        // pending run, if any, is folded later if the user re-adds their key.
        await labStorage.updateAgentTask(taskId, {
          turnState: "ready", turnStateChangedAt: new Date(),
        });
        const updated = await labStorage.getAgentTaskForWallet(r.walletAddress, taskId);
        return res.status(202).json({ task: updated ? toTurnTaskDto(updated) : null, resumed: false });
      }
      const updated = await labStorage.getAgentTaskForWallet(r.walletAddress, taskId);
      return res.status(202).json({ task: updated ? toTurnTaskDto(updated) : null, resumed: true });
    } catch (err: any) {
      sendError(res, err, "Could not resume the assistant.");
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
