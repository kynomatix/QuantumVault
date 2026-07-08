// HTTP layer for the AI Trader (Agentic Trader plan, WO-7).
//
// Registered from server/routes.ts (registerAiTraderRoutes(app), called right
// before `return httpServer;`) — NOT from server/index.ts. Unlike the AI
// Creator (server/ai-assistant/routes.ts), these routes run behind the
// existing session-cookie `requireWallet` gate already used across
// server/routes.ts, so we duplicate that exact closure here rather than
// inventing a second auth convention.
//
// SECURITY: the caller's wallet is taken ONLY from the Express session
// (requireWallet), matching every other money-adjacent route in the app. The
// BYO OpenRouter key (when present) is decrypted transiently per request
// (UMK-derived subkey, AAD-bound to the wallet), used, and the plaintext
// buffer is zeroized; it is never returned to the client and never logged.
//
// SCOPE (documented deviation — see the go-live handler below): flipping a
// bot from paper to live requires allocating/funding a real venue subaccount,
// which is a separate money-moving flow (recycler → transferBetweenSubaccounts
// → HMAC) not wired up in this work order. The go-live route fully implements
// the REJECT path (canGoLive gate) but fails closed with 501 on the accept
// path rather than half-building fund movement.

import type { Express, Response } from "express";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { fromZodError } from "zod-validation-error";
import { db } from "../db";
import { aiTraderDecisions, type AiTraderBot } from "@shared/schema";
import { storage } from "../storage";
import {
  getSessionByWalletAddress,
  restoreWalletSecurityFromStorage,
  decryptLlmApiKeyV3,
  computeBotPolicyHmac,
} from "../session-v3";
import { getAdapter, getDefaultAdapter } from "../protocol/adapter-registry";
import { getMarketInfo } from "../market-registry";
import { isSelectableModel } from "../ai-assistant/models-catalog";
import { buildMarketContext } from "./context-builder";
import { runDecision } from "./decide";
import { executeDecision, aiTraderPolicyObject } from "./executor";
import { userInitiatedClose, parseOpenDecision } from "./monitor";
import { sanitizeGraduationCriteria, canGoLive } from "./graduation";
import type { ClampedDecision } from "./guardrails";

// --- Auth (duplicated verbatim from server/routes.ts requireWallet) --------------------
// Kept as an exact copy rather than an import: server/routes.ts defines it as a
// local closure inside registerRoutes(), not an exported function.

const requireWallet = (req: any, res: any, next: any) => {
  const headerWallet = req.query.wallet || req.body.walletAddress || req.headers['x-wallet-address'];
  const sessionWallet = req.session?.walletAddress;

  if (!sessionWallet) {
    return res.status(401).json({ error: "Wallet not connected - please connect your wallet first" });
  }

  if (headerWallet && sessionWallet !== headerWallet) {
    return res.status(403).json({ error: "Wallet mismatch - please reconnect wallet" });
  }

  req.walletAddress = sessionWallet;
  next();
};

// --- Interactive UMK (adapted from server/ai-assistant/routes.ts L68-85) ---------------

async function tryRestoreUmk(walletAddress: string): Promise<void> {
  if (getSessionByWalletAddress(walletAddress)?.session?.umk) return;
  await restoreWalletSecurityFromStorage(walletAddress);
}

async function getInteractiveUmk(walletAddress: string, res: Response): Promise<Buffer | null> {
  await tryRestoreUmk(walletAddress);
  const sessionRes = getSessionByWalletAddress(walletAddress);
  const umk = sessionRes?.session?.umk;
  if (!umk) {
    res.status(401).json({ error: "Your session is locked. Sign in again to continue." });
    return null;
  }
  return umk;
}

// --- Free paper trial (plan §8.3 / L666, L697) ------------------------------------------
// Wallets with no BYO OpenRouter key get FREE_PAPER_TRIAL_LIMIT /analyze calls on the
// platform's own key, paper bots only, on a fixed cheap model — never for live bots
// (enforced here: resolution only ever runs from the /analyze handler, which only ever
// operates on the caller's own paper or live bot, and the platform-key branch below is
// gated on `bot.paperMode`).
const FREE_PAPER_TRIALS = true;
const FREE_PAPER_TRIAL_LIMIT = 3;
const FREE_TRIAL_MODEL = "deepseek/deepseek-v4-flash"; // cheapest curated model (models-catalog.ts)

const DEGEN_CONFIRM_PHRASE = "this bot can lose the full allocation without pausing";
const MIN_ALLOCATED_USDC = 10;
const MAX_ALLOCATED_USDC = 1_000_000; // sanity ceiling only — paper allocation moves no real funds

// Plan L751: "Proposals expire after N minutes or ±0.5% price drift; re-analyze on
// execute if stale." N is left an open question in the plan (open question #5) — 10
// minutes is this WO's chosen default, documented here rather than silently picked.
const DECISION_EXPIRY_MS = 10 * 60 * 1000;
const PRICE_DRIFT_STALE_PCT = 0.5;

function toBotDto(bot: AiTraderBot): Omit<AiTraderBot, "policyHmac"> {
  const { policyHmac, ...rest } = bot;
  return rest;
}

async function loadOwnedBot(req: any, res: Response): Promise<AiTraderBot | null> {
  const bot = await storage.getAiTraderBot(req.params.id);
  if (!bot || bot.walletAddress !== req.walletAddress) {
    res.status(404).json({ error: "Bot not found" });
    return null;
  }
  return bot;
}

type ApiKeyResolution =
  | { ok: true; apiKey: string; cleanup: () => void; modelOverride?: string; usedFreeTrial: boolean }
  | { ok: false; status: number; error: string };

/**
 * Resolve the OpenRouter key for an /analyze call: BYO key first, else (paper
 * bots only, wallet under the free-trial cap) the platform key on a pinned
 * cheap model. `incrementAiTraderFreeCalls` is atomic (WHERE ... < limit), so
 * concurrent requests can never exceed the cap; a failed pre-LLM step (stale
 * context, missing wallet/adapter) refunds via decrementAiTraderFreeCalls
 * (storage.ts: "never actually reached the LLM").
 */
async function resolveApiKeyForAnalyze(
  walletAddress: string,
  bot: AiTraderBot,
  res: Response
): Promise<ApiKeyResolution | null> {
  const ciphertext = await storage.getWalletLlmApiKeyCiphertext(walletAddress);
  if (ciphertext) {
    const umk = await getInteractiveUmk(walletAddress, res);
    if (!umk) return null; // getInteractiveUmk already responded 401
    const keyBuf = decryptLlmApiKeyV3(umk, ciphertext, walletAddress);
    const apiKey = keyBuf.toString("utf8");
    return { ok: true, apiKey, cleanup: () => keyBuf.fill(0), usedFreeTrial: false };
  }

  if (FREE_PAPER_TRIALS && bot.paperMode) {
    const platformKey = process.env.OPENROUTER_PLATFORM_KEY;
    if (!platformKey) {
      return { ok: false, status: 500, error: "Free trial is temporarily unavailable." };
    }
    const newCount = await storage.incrementAiTraderFreeCalls(walletAddress, FREE_PAPER_TRIAL_LIMIT);
    if (newCount === null) {
      return {
        ok: false,
        status: 402,
        error: `You've used all ${FREE_PAPER_TRIAL_LIMIT} free paper trial calls. Add your own OpenRouter key in Settings to keep going.`,
      };
    }
    return {
      ok: true,
      apiKey: platformKey,
      cleanup: () => {},
      modelOverride: FREE_TRIAL_MODEL,
      usedFreeTrial: true,
    };
  }

  return {
    ok: false,
    status: 400,
    error: "No API key configured. Add your OpenRouter key in Settings, or try a free paper trial.",
  };
}

// --- Create-bot body validation ---------------------------------------------------------

const createBotBodySchema = z.object({
  market: z.string().min(1),
  timeframe: z.enum(["15m", "1h", "4h", "1d"]),
  mode: z.enum(["suggest", "auto"]).default("suggest"),
  riskProfile: z.enum(["guarded", "degen"]).default("guarded"),
  model: z.string().min(1).default("anthropic/claude-opus-4.8"),
  allocatedUsdc: z.union([z.string(), z.number()]),
  maxLeverage: z.coerce.number().int().min(1).max(5).default(3),
  parkWhenIdle: z.boolean().default(false),
  autoNext: z.boolean().default(false),
  protocol: z.string().optional(),
  graduationCriteria: z
    .object({
      periodDays: z.number().optional(),
      minTrades: z.number().optional(),
      minNetPnl: z.number().optional(),
      maxDrawdownPct: z.number().optional(),
      minProfitFactor: z.number().optional(),
    })
    .partial()
    .optional(),
  degenConfirm: z.string().optional(),
});

export function registerAiTraderRoutes(app: Express): void {
  // --- Create -----------------------------------------------------------------------
  app.post("/api/ai-trader", requireWallet, async (req: any, res) => {
    try {
      const parsed = createBotBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: fromZodError(parsed.error).message });
      }
      const body = parsed.data;

      if (body.riskProfile === "degen") {
        const confirm = (body.degenConfirm ?? "").trim().toLowerCase();
        if (confirm !== DEGEN_CONFIRM_PHRASE) {
          return res.status(400).json({
            error: `Degen mode requires typed confirmation: "${DEGEN_CONFIRM_PHRASE}"`,
          });
        }
      }

      if (!getMarketInfo(body.market)) {
        return res.status(400).json({ error: `Unknown market '${body.market}'.` });
      }
      if (!isSelectableModel(body.model)) {
        return res.status(400).json({ error: `Unknown or unsupported model '${body.model}'.` });
      }

      const allocatedNum = Number(body.allocatedUsdc);
      if (!Number.isFinite(allocatedNum) || allocatedNum < MIN_ALLOCATED_USDC || allocatedNum > MAX_ALLOCATED_USDC) {
        return res.status(400).json({
          error: `allocatedUsdc must be between $${MIN_ALLOCATED_USDC} and $${MAX_ALLOCATED_USDC}.`,
        });
      }
      const allocatedUsdc = allocatedNum.toFixed(2);

      let protocol: string;
      if (body.protocol) {
        try {
          protocol = getAdapter(body.protocol).protocolName;
        } catch {
          return res.status(400).json({ error: `Unknown protocol '${body.protocol}'.` });
        }
      } else {
        protocol = getDefaultAdapter().protocolName;
      }

      const umk = await getInteractiveUmk(req.walletAddress, res);
      if (!umk) return; // getInteractiveUmk already responded 401

      const graduationCriteria = sanitizeGraduationCriteria(body.graduationCriteria);
      const policyHmac = computeBotPolicyHmac(
        umk,
        aiTraderPolicyObject({ market: body.market, maxLeverage: body.maxLeverage, allocatedUsdc })
      );

      const bot = await storage.createAiTraderBot({
        walletAddress: req.walletAddress,
        protocol,
        protocolSubaccountId: null, // paper mode: no venue subaccount until go-live (plan L664)
        market: body.market,
        timeframe: body.timeframe,
        mode: body.mode,
        riskProfile: body.riskProfile,
        paperMode: true, // WO-7 only ever creates paper bots; go-live is a separate gated flip
        autoNext: body.autoNext,
        model: body.model,
        allocatedUsdc,
        maxLeverage: body.maxLeverage,
        stopPolicy: "static",
        parkWhenIdle: body.parkWhenIdle,
        graduationState: "in_trial",
        graduationCriteria,
        policyHmac,
        status: "idle",
        pauseReason: null,
        dailyRealizedPnl: "0",
        consecutiveLosses: 0,
      });

      res.status(201).json({ bot: toBotDto(bot) });
    } catch (err) {
      console.error("[AiTrader] create error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // --- List (own wallet) -------------------------------------------------------------
  app.get("/api/ai-trader", requireWallet, async (req: any, res) => {
    try {
      const bots = await storage.getAiTraderBotsByWallet(req.walletAddress);
      res.json({ bots: bots.map(toBotDto) });
    } catch (err) {
      console.error("[AiTrader] list error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // --- Public aggregate track record (registered BEFORE /:id — see routing note) ----
  // CAVEAT: deleting a bot cascades its decision rows (schema onDelete:'cascade'), so
  // a deleted bot's trades silently drop out of this aggregate. Documented, not fixed
  // here — a real "immutable public track record" needs its own retention design.
  app.get("/api/ai-trader/track-record", async (_req, res) => {
    try {
      const rows = await db
        .select({
          realizedPnl: aiTraderDecisions.realizedPnl,
          closedAt: aiTraderDecisions.closedAt,
        })
        .from(aiTraderDecisions)
        .where(and(eq(aiTraderDecisions.outcome, "executed"), isNotNull(aiTraderDecisions.closedAt)))
        .orderBy(desc(aiTraderDecisions.closedAt))
        .limit(500);

      const closed = rows.filter((r) => r.realizedPnl !== null);
      const wins = closed.filter((r) => Number(r.realizedPnl) > 0).length;
      const totalPnl = closed.reduce((sum, r) => sum + Number(r.realizedPnl ?? 0), 0);

      res.json({
        totalClosedTrades: closed.length,
        wins,
        losses: closed.length - wins,
        winRatePct: closed.length > 0 ? (wins / closed.length) * 100 : null,
        totalRealizedPnlUsd: totalPnl,
        note:
          "Aggregated across all AI Trader bots on the platform (paper and live). Deleting a bot removes its trades from this record.",
      });
    } catch (err) {
      console.error("[AiTrader] track-record error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // --- Detail -------------------------------------------------------------------------
  app.get("/api/ai-trader/:id", requireWallet, async (req: any, res) => {
    try {
      const bot = await loadOwnedBot(req, res);
      if (!bot) return;
      const decisions = await storage.getAiTraderDecisions(bot.id, 10);
      const openPosition = parseOpenDecision(decisions);
      res.json({ bot: toBotDto(bot), openPosition, recentDecisions: decisions });
    } catch (err) {
      console.error("[AiTrader] get error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // --- Delete ---------------------------------------------------------------------------
  app.delete("/api/ai-trader/:id", requireWallet, async (req: any, res) => {
    try {
      const bot = await loadOwnedBot(req, res);
      if (!bot) return;
      if (bot.status === "executing" || bot.status === "analyzing") {
        return res.status(409).json({ error: "An operation is in flight for this bot — try again in a moment." });
      }
      if (bot.status === "open") {
        return res.status(409).json({ error: "This bot has an open position — close it before deleting." });
      }
      await storage.deleteAiTraderBot(bot.id);
      res.json({ ok: true });
    } catch (err) {
      console.error("[AiTrader] delete error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // --- Analyze (run one decision cycle) ------------------------------------------------
  app.post("/api/ai-trader/:id/analyze", requireWallet, async (req: any, res) => {
    try {
      const bot = await loadOwnedBot(req, res);
      if (!bot) return;
      if (bot.status === "executing" || bot.status === "analyzing") {
        return res.status(409).json({ error: "An operation is already in flight for this bot." });
      }
      if (bot.status === "open") {
        return res.status(409).json({ error: "This bot already has an open position — close it before analyzing again." });
      }

      const keyRes = await resolveApiKeyForAnalyze(req.walletAddress, bot, res);
      if (!keyRes) return; // getInteractiveUmk already responded 401
      if (!keyRes.ok) {
        return res.status(keyRes.status).json({ error: keyRes.error });
      }

      try {
        const wallet = await storage.getWallet(bot.walletAddress);
        if (!wallet?.agentPublicKey) {
          if (keyRes.usedFreeTrial) await storage.decrementAiTraderFreeCalls(req.walletAddress);
          return res.status(400).json({ error: "Agent wallet not initialized for this account." });
        }

        let adapter;
        try {
          adapter = getAdapter(bot.protocol);
        } catch {
          if (keyRes.usedFreeTrial) await storage.decrementAiTraderFreeCalls(req.walletAddress);
          return res.status(400).json({ error: `Unknown protocol '${bot.protocol}'.` });
        }

        const recentDecisions = await storage.getAiTraderDecisions(bot.id, 20);
        const context = await buildMarketContext({
          market: bot.market,
          timeframe: bot.timeframe as "15m" | "1h" | "4h" | "1d",
          adapter,
          bot,
          recentDecisions,
          agentPublicKey: wallet.agentPublicKey,
        });
        if ("stale" in context) {
          if (keyRes.usedFreeTrial) await storage.decrementAiTraderFreeCalls(req.walletAddress);
          return res.status(409).json({ error: "stale_context", detail: context.reason });
        }

        // Free-trial calls always run the pinned cheap model — never the bot's
        // configured (possibly expensive) model.
        const effectiveBot = keyRes.modelOverride ? { ...bot, model: keyRes.modelOverride } : bot;
        const result = await runDecision({ bot: effectiveBot, apiKey: keyRes.apiKey, context, adapter });

        // From here on the call reached the LLM gateway — no refund, win or lose
        // (matches storage.ts's decrementAiTraderFreeCalls contract).
        if (!result.ok) {
          const status = result.reason === "timeout" ? 504 : result.reason === "gateway" ? 502 : 422;
          return res.status(status).json({ error: result.reason, detail: result.detail });
        }

        res.json({
          decisionId: result.decisionId,
          decision: result.decision,
          clamped: result.clamped,
          rejected: result.rejected,
          violations: result.violations,
          usedFreeTrial: keyRes.usedFreeTrial,
        });
      } finally {
        keyRes.cleanup();
      }
    } catch (err) {
      console.error("[AiTrader] analyze error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // --- Execute a proposed decision ------------------------------------------------------
  app.post("/api/ai-trader/:id/execute", requireWallet, async (req: any, res) => {
    try {
      const bot = await loadOwnedBot(req, res);
      if (!bot) return;

      const decisionId = req.body?.decisionId;
      if (!decisionId || typeof decisionId !== "string") {
        return res.status(400).json({ error: "decisionId is required" });
      }

      const decision = await storage.getAiTraderDecision(decisionId);
      if (!decision || decision.botId !== bot.id) {
        return res.status(404).json({ error: "Decision not found" });
      }
      if (decision.outcome !== null && decision.outcome !== undefined) {
        return res.status(409).json({ error: `Decision already resolved (${decision.outcome}).` });
      }

      const clamped = decision.clampedDecision as ClampedDecision | null;
      if (!clamped || (clamped.action !== "long" && clamped.action !== "short")) {
        return res.status(400).json({ error: "This decision has nothing actionable to execute." });
      }

      // Staleness gate (plan L751): N minutes OR ±0.5% price drift since the
      // decision was recorded. Re-check live price rather than trusting the
      // clock alone — a fast-moving market can invalidate a proposal in seconds.
      const decidedAtMs = decision.decidedAt ? new Date(decision.decidedAt).getTime() : 0;
      const ageMs = Date.now() - decidedAtMs;
      const timeStale = !decidedAtMs || ageMs > DECISION_EXPIRY_MS;

      let adapter;
      try {
        adapter = getAdapter(bot.protocol);
      } catch {
        return res.status(400).json({ error: `Unknown protocol '${bot.protocol}'.` });
      }

      const recordedPrice = Number((decision.contextDigest as any)?.price);
      let livePrice: number | null = null;
      try {
        livePrice = await adapter.getPrice(bot.market);
      } catch {
        livePrice = null; // fail open on the price-drift check only — time-based expiry still applies
      }
      const priceStale =
        livePrice !== null &&
        Number.isFinite(recordedPrice) &&
        recordedPrice > 0 &&
        Math.abs(livePrice - recordedPrice) / recordedPrice * 100 > PRICE_DRIFT_STALE_PCT;

      if (timeStale || priceStale) {
        await storage.updateAiTraderDecision(decision.id, { outcome: "expired" });
        return res.status(409).json({
          error: "expired",
          detail: timeStale
            ? "This proposal has expired — analyze again for a fresh decision."
            : `Price has moved more than ${PRICE_DRIFT_STALE_PCT}% since this proposal — analyze again.`,
        });
      }

      const markPrice = livePrice ?? recordedPrice;
      if (!Number.isFinite(markPrice) || markPrice <= 0) {
        return res.status(400).json({ error: "No usable mark price available to execute this decision." });
      }

      const result = await executeDecision({ bot, decisionId: decision.id, clamped, adapter, markPrice });
      if (!result.ok) {
        const status =
          result.reason === "cooldown_active" || result.reason === "daily_cap_reached" || result.reason === "bot_busy"
            ? 409
            : result.reason === "auth_unavailable"
              ? 401
              : result.reason === "policy_hmac_mismatch"
                ? 403
                : 422;
        return res.status(status).json({ error: result.reason, detail: result.detail });
      }

      res.json({ ok: true, mode: result.mode, entryPrice: result.entryPrice });
    } catch (err) {
      console.error("[AiTrader] execute error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // --- Close (user-initiated) -----------------------------------------------------------
  app.post("/api/ai-trader/:id/close", requireWallet, async (req: any, res) => {
    try {
      const bot = await loadOwnedBot(req, res);
      if (!bot) return;
      const result = await userInitiatedClose(bot);
      if (!result.ok) {
        return res.status(422).json({ error: result.detail });
      }
      if (!result.closed) {
        return res.json({ ok: true, closed: false });
      }
      res.json({ ok: true, closed: true, exitPrice: result.exitPrice, realizedPnl: result.realizedPnl });
    } catch (err) {
      console.error("[AiTrader] close error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // --- Skip a proposed decision ----------------------------------------------------------
  app.post("/api/ai-trader/:id/skip", requireWallet, async (req: any, res) => {
    try {
      const bot = await loadOwnedBot(req, res);
      if (!bot) return;
      const decisionId = req.body?.decisionId;
      if (!decisionId || typeof decisionId !== "string") {
        return res.status(400).json({ error: "decisionId is required" });
      }
      const decision = await storage.getAiTraderDecision(decisionId);
      if (!decision || decision.botId !== bot.id) {
        return res.status(404).json({ error: "Decision not found" });
      }
      if (decision.outcome !== null && decision.outcome !== undefined) {
        return res.status(409).json({ error: `Decision already resolved (${decision.outcome}).` });
      }
      await storage.updateAiTraderDecision(decision.id, { outcome: "user_skipped" });
      res.json({ ok: true });
    } catch (err) {
      console.error("[AiTrader] skip error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // --- Pause / Resume ----------------------------------------------------------------------
  // Pause only stops future analyze/auto-next cycling (monitor.ts L1263). It deliberately
  // cannot be applied while a position is open: monitorBotOnce() only runs paper P&L / SL-TP
  // tracking when status==='open', so pausing an open position would freeze its tracking
  // rather than protect it (live positions stay protected by their resting venue bracket
  // either way, but paper positions have no venue — freezing them would be a silent bug).
  app.post("/api/ai-trader/:id/pause", requireWallet, async (req: any, res) => {
    try {
      const bot = await loadOwnedBot(req, res);
      if (!bot) return;
      if (bot.status === "open") {
        return res.status(409).json({
          error: "Can't pause while a position is open — close it first, then pause.",
        });
      }
      if (bot.status === "executing" || bot.status === "analyzing") {
        return res.status(409).json({ error: "An operation is in flight — try again in a moment." });
      }
      const updated = await storage.updateAiTraderBot(bot.id, { status: "paused", pauseReason: "user_requested" });
      res.json({ bot: updated ? toBotDto(updated) : null });
    } catch (err) {
      console.error("[AiTrader] pause error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/ai-trader/:id/resume", requireWallet, async (req: any, res) => {
    try {
      const bot = await loadOwnedBot(req, res);
      if (!bot) return;
      if (bot.status !== "paused") {
        return res.status(409).json({ error: `Bot is not paused (status: ${bot.status}).` });
      }
      const updated = await storage.updateAiTraderBot(bot.id, { status: "idle", pauseReason: null });
      res.json({ bot: updated ? toBotDto(updated) : null });
    } catch (err) {
      console.error("[AiTrader] resume error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // --- Restart trial (§2e: a failed trial can be restarted) --------------------------------
  app.post("/api/ai-trader/:id/restart-trial", requireWallet, async (req: any, res) => {
    try {
      const bot = await loadOwnedBot(req, res);
      if (!bot) return;
      if (bot.status === "open" || bot.status === "executing" || bot.status === "analyzing") {
        return res.status(409).json({ error: "Close the open position (or wait for it to finish) before restarting the trial." });
      }
      const updated = await storage.updateAiTraderBot(bot.id, {
        graduationState: "in_trial",
        status: "idle",
        pauseReason: null,
        dailyRealizedPnl: "0",
        consecutiveLosses: 0,
        trialStartedAt: new Date(),
      });
      res.json({ bot: updated ? toBotDto(updated) : null });
    } catch (err) {
      console.error("[AiTrader] restart-trial error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // --- Go live -------------------------------------------------------------------------
  app.post("/api/ai-trader/:id/go-live", requireWallet, async (req: any, res) => {
    try {
      const bot = await loadOwnedBot(req, res);
      if (!bot) return;
      if (!bot.paperMode) {
        return res.status(409).json({ error: "This bot is already live." });
      }
      const gate = canGoLive(bot.graduationState);
      if (!gate.ok) {
        return res.status(403).json({ error: gate.error });
      }
      // Deliberate WO-7 scope boundary (see file header): flipping paperMode
      // requires allocating/funding a real venue subaccount first (the same
      // recycler → transferBetweenSubaccounts → HMAC path used by regular bot
      // creation, plan L664). That money-moving flow is not wired up here —
      // shipping "live" with protocolSubaccountId still null would let the
      // executor's live path silently operate on the wrong account. Fail
      // closed until funding has its own dedicated review.
      res.status(501).json({
        error: "live_funding_not_implemented",
        detail: "This bot has graduated and is eligible to go live, but live-funding setup isn't wired up yet.",
      });
    } catch (err) {
      console.error("[AiTrader] go-live error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // --- History --------------------------------------------------------------------------
  app.get("/api/ai-trader/:id/history", requireWallet, async (req: any, res) => {
    try {
      const bot = await loadOwnedBot(req, res);
      if (!bot) return;
      const limitRaw = parseInt(String(req.query.limit ?? "50"), 10);
      const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 50, 1), 200);
      const decisions = await storage.getAiTraderDecisions(bot.id, limit);
      res.json({ decisions });
    } catch (err) {
      console.error("[AiTrader] history error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });
}
