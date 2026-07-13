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
// GO-LIVE (WO-7.1): the accept path is now wired up. It reuses the SAME
// provisioning + fail-closed sweep helpers as regular bot creation
// (provisionExternalKeyBotSubaccount / sweepProvisionedExternalKeyFunds,
// imported lazily from ../routes to avoid a module-load cycle). See the
// handler's own comment block for the exact flow, ordering guarantees, and
// the two documented deviations (no spare-pool recycling; no policyHmac
// recompute — paperMode is outside the HMAC envelope by design).

import type { Express, Response } from "express";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
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
  getUmkForWebhook,
  healExecutionUmkFromStorage,
  decryptAgentKeyStrict,
  decryptMnemonic,
  encryptBotSubaccountKeyV3,
} from "../session-v3";
import { resolveAgentKeypair } from "../agent-wallet";
import { getAdapter, getDefaultAdapter } from "../protocol/adapter-registry";
import { getMarketInfo } from "../market-registry";
import { isSelectableModel } from "../ai-assistant/models-catalog";
import { buildMarketContext, marketToDatafeedTicker } from "./context-builder";
import { fetchOHLCV } from "../lab/datafeed";
import { runDecision } from "./decide";
import { executeDecision, aiTraderPolicyObject } from "./executor";
import { userInitiatedClose, parseOpenDecision, computeUnrealizedPnl } from "./monitor";
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

const DEGEN_CONFIRM_PHRASE = "send it";
const MIN_ALLOCATED_USDC = 10;
const MAX_ALLOCATED_USDC = 1_000_000; // sanity ceiling only — paper allocation moves no real funds

// Plan L751: "Proposals expire after N minutes or ±0.5% price drift; re-analyze on
// execute if stale." N is left an open question in the plan (open question #5) — 10
// minutes is this WO's chosen default, documented here rather than silently picked.
const DECISION_EXPIRY_MS = 10 * 60 * 1000;
const PRICE_DRIFT_STALE_PCT = 0.5;

// Per-bot go-live in-flight guard (WO-7.1). Two overlapping go-live requests
// would otherwise both read the bot pre-provision → double provision + double
// fund (fresh path) or double funding transfer (retry path). Module-level Set
// matches the single-process model — same pattern as other money-path locks.
const goLiveInFlight = new Set<string>();

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

const RISK_BAND_BOUNDS = { min: 0.1, max: 3.0 } as const;

const createBotBodySchema = z
  .object({
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
    sizingMode: z.enum(["discretionary", "risk_based"]).default("discretionary"),
    riskMinPct: z.number().min(RISK_BAND_BOUNDS.min).max(RISK_BAND_BOUNDS.max).default(0.5),
    riskMaxPct: z.number().min(RISK_BAND_BOUNDS.min).max(RISK_BAND_BOUNDS.max).default(1.5),
  })
  .superRefine((data, ctx) => {
    if (data.sizingMode === "risk_based" && data.riskMinPct > data.riskMaxPct) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["riskMinPct"],
        message: `riskMinPct (${data.riskMinPct}) must be ≤ riskMaxPct (${data.riskMaxPct})`,
      });
    }
  });

// --- Chart data window sizing (read-only, view-only feature) -----------------------
// bot.timeframe is one of AiTraderTimeframe ('15m'|'1h'|'4h'|'1d' — context-builder.ts
// L15/L41-46); duplicated here rather than importing the module-private TIMEFRAME_MS
// from context-builder.ts, same "scoped to this file" convention that map already uses
// relative to datafeed.ts's own (also module-private) getTimeframeSeconds.
const CHART_TIMEFRAME_MS: Record<string, number> = {
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};
// Bars of padding on each side of the entry->exit window, and a floor on the total
// number of bars so a very short (sub-candle) trade still renders a readable chart.
const CHART_PAD_CANDLES = 100;
const CHART_MIN_TOTAL_CANDLES = 200;

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
        sizingMode: body.sizingMode,
        riskMinPct: String(body.riskMinPct),
        riskMaxPct: String(body.riskMaxPct),
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

      // --- PnL blocks (WO-8g) ----------------------------------------------------------
      // For every bot that currently has an open position, compute a server-side
      // display-grade PnL block.  Prices are fetched ONCE per unique market (shared
      // across all bots trading the same ticker) and fail-open to null — a single
      // stale price feed must never block the whole list.
      type PnlBlock = { unrealizedPnl: number; pnlPct: number; totalPnl: number };
      const pnlMap = new Map<string, PnlBlock>();

      // WO-8h item 1: lifetime stats for all bots in one batch query.
      type LifetimeStats = { totalRealized: number; totalFees: number; totalLlmCost: number; netPnlAllIn: number };
      const allBotIds = bots.map((b) => b.id);
      const lifetimeStatsMap = await storage.getAiTraderBotLifetimeStats(allBotIds);

      const openBots = bots.filter((b) => b.status === "open");
      if (openBots.length > 0) {
        const openBotIds = openBots.map((b) => b.id);

        const [openDecisions, realizedMap] = await Promise.all([
          storage.getAiTraderOpenDecisionsByBotIds(openBotIds),
          storage.getAiTraderTotalRealizedPnlMap(openBotIds),
        ]);

        // Deduplicate: one price fetch per unique (protocol, market) pair so two
        // bots on the same ticker but different venues each get the right price.
        const protoMarketKey = (bot: AiTraderBot) => `${bot.protocol ?? ''}:${bot.market}`;
        const marketToBot = new Map<string, AiTraderBot>();
        for (const bot of openBots) {
          const key = protoMarketKey(bot);
          if (!marketToBot.has(key)) marketToBot.set(key, bot);
        }
        const priceCache = new Map<string, number | null>();
        await Promise.all(
          [...marketToBot.entries()].map(async ([key, bot]) => {
            try {
              const p = await getAdapter(bot.protocol).getPrice(bot.market);
              // Reject zero/negative prices — treat as unavailable.
              priceCache.set(key, p !== null && Number.isFinite(p) && p > 0 ? p : null);
            } catch {
              priceCache.set(key, null);
            }
          }),
        );

        // Index open decisions by botId.
        const decByBot = new Map<string, (typeof openDecisions)[0]>();
        for (const d of openDecisions) {
          if (d.botId) decByBot.set(d.botId, d);
        }

        for (const bot of openBots) {
          const dec = decByBot.get(bot.id);
          if (!dec) continue;
          const view = parseOpenDecision([dec]);
          if (!view) continue;
          const mark = priceCache.get(protoMarketKey(bot)) ?? null;
          if (mark === null) continue;
          const unrealizedPnl = computeUnrealizedPnl(view, mark);
          if (unrealizedPnl === null) continue;
          const alloc = Number(bot.allocatedUsdc ?? 0);
          const pnlPct = alloc > 0 ? (unrealizedPnl / alloc) * 100 : 0;
          const totalRealized = realizedMap.get(bot.id) ?? 0;
          pnlMap.set(bot.id, { unrealizedPnl, pnlPct, totalPnl: totalRealized + unrealizedPnl });
        }
      }

      res.json({
        bots: bots.map((b) => {
          const raw = lifetimeStatsMap.get(b.id) ?? { totalRealized: 0, totalFees: 0, totalLlmCost: 0 };
          const pnlBlock = pnlMap.get(b.id) ?? null;
          const unrealized = pnlBlock?.unrealizedPnl ?? 0;
          const lifetimeStats: LifetimeStats = {
            ...raw,
            netPnlAllIn: raw.totalRealized + unrealized - raw.totalLlmCost,
          };
          return { ...toBotDto(b), pnl: pnlBlock, lifetimeStats };
        }),
      });
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

      // Live mark price for the open-position PnL banner only — display-grade,
      // not money-critical (paper bots have no on-chain position to query, so
      // client computes PnL from entryPrice/sizeBase/side + this mark price).
      // Fail OPEN to null on any adapter error; client renders "—" rather than
      // blocking the whole detail response over a display-only price fetch.
      let markPrice: number | null = null;
      if (openPosition) {
        try {
          const adapter = getAdapter(bot.protocol);
          markPrice = await adapter.getPrice(bot.market);
        } catch {
          markPrice = null;
        }
      }

      // PnL block (WO-8g) + lifetime stats (WO-8h item 1).
      // Fetch lifetime stats once; they feed both the pnl block and the lifetimeStats field.
      let pnl: { unrealizedPnl: number; pnlPct: number; totalPnl: number } | null = null;
      const rawStats = await storage.getAiTraderBotLifetimeStats([bot.id]);
      const raw = rawStats.get(bot.id) ?? { totalRealized: 0, totalFees: 0, totalLlmCost: 0 };

      if (openPosition && markPrice !== null) {
        const unrealizedPnl = computeUnrealizedPnl(openPosition, markPrice);
        if (unrealizedPnl !== null) {
          const alloc = Number(bot.allocatedUsdc ?? 0);
          const pnlPct = alloc > 0 ? (unrealizedPnl / alloc) * 100 : 0;
          pnl = { unrealizedPnl, pnlPct, totalPnl: raw.totalRealized + unrealizedPnl };
        }
      }

      const unrealized = pnl?.unrealizedPnl ?? 0;
      const lifetimeStats = {
        totalRealized: raw.totalRealized,
        totalFees: raw.totalFees,
        totalLlmCost: raw.totalLlmCost,
        netPnlAllIn: raw.totalRealized + unrealized - raw.totalLlmCost,
      };

      res.json({ bot: toBotDto(bot), openPosition, recentDecisions: decisions, markPrice, pnl, lifetimeStats });
    } catch (err) {
      console.error("[AiTrader] get error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // --- Patch mutable settings (mode / riskProfile / autoNext) --------------------------
  app.patch("/api/ai-trader/:id", requireWallet, async (req: any, res) => {
    try {
      const bot = await loadOwnedBot(req, res);
      if (!bot) return;

      const patchSchema = z
        .object({
          mode: z.enum(["suggest", "auto"]).optional(),
          riskProfile: z.enum(["guarded", "degen"]).optional(),
          autoNext: z.boolean().optional(),
          degenConfirm: z.string().optional(),
          model: z.string().optional(),
          sizingMode: z.enum(["discretionary", "risk_based"]).optional(),
          riskMinPct: z.number().min(RISK_BAND_BOUNDS.min).max(RISK_BAND_BOUNDS.max).optional(),
          riskMaxPct: z.number().min(RISK_BAND_BOUNDS.min).max(RISK_BAND_BOUNDS.max).optional(),
        })
        .superRefine((data, ctx) => {
          const newMin = data.riskMinPct;
          const newMax = data.riskMaxPct;
          if (newMin !== undefined && newMax !== undefined && newMin > newMax) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["riskMinPct"],
              message: `riskMinPct (${newMin}) must be ≤ riskMaxPct (${newMax})`,
            });
          }
        });
      const parsed = patchSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: fromZodError(parsed.error).message });
      }
      const body = parsed.data;

      // Switching TO Full Send (degen) requires the same typed phrase as creation.
      if (body.riskProfile === "degen" && bot.riskProfile !== "degen") {
        const confirm = (body.degenConfirm ?? "").trim().toLowerCase();
        if (confirm !== DEGEN_CONFIRM_PHRASE) {
          return res.status(400).json({
            error: `Switching to Full Send requires typed confirmation: "${DEGEN_CONFIRM_PHRASE}"`,
          });
        }
      }

      // Flipping a LIVE bot (paperMode=false) to risk_based requires a provisioned
      // venue subaccount so the live-equity read has a real account to query.
      // Paper bots are unaffected (their equity is simulated, not read from the venue).
      if (body.sizingMode === "risk_based" && !bot.paperMode && !bot.protocolSubaccountId) {
        return res.status(400).json({
          error:
            "risk_based sizing requires a provisioned venue account. This bot has no venue subaccount — go live first, then switch sizing mode.",
        });
      }

      // Partial risk-band PATCH: when only one bound is supplied, validate the
      // effective (merged) band so a single-field update cannot store min>max.
      // Without this, riskMinPct=2.5 against a stored riskMaxPct=1.5 would succeed
      // here and then fail-closed every cycle with risk_params_invalid — confusing.
      if (body.riskMinPct !== undefined || body.riskMaxPct !== undefined) {
        const storedMin = parseFloat(bot.riskMinPct ?? "0.5");
        const storedMax = parseFloat(bot.riskMaxPct ?? "1.5");
        const effectiveMin = body.riskMinPct ?? storedMin;
        const effectiveMax = body.riskMaxPct ?? storedMax;
        if (effectiveMin > effectiveMax) {
          return res.status(400).json({
            error: `riskMinPct (${effectiveMin}) must be ≤ riskMaxPct (${effectiveMax}) after merging with stored values.`,
          });
        }
      }

      // Model change is gated to the curated catalog. The new model takes effect
      // from the NEXT decision cycle — never mid-cycle — so no cycle-lock check needed.
      if (body.model !== undefined) {
        if (!isSelectableModel(body.model)) {
          return res.status(400).json({ error: "Model is not in the approved catalog." });
        }
      }

      const updates: Record<string, unknown> = {};
      if (body.mode !== undefined) updates.mode = body.mode;
      if (body.riskProfile !== undefined) updates.riskProfile = body.riskProfile;
      if (body.autoNext !== undefined) updates.autoNext = body.autoNext;
      if (body.model !== undefined) updates.model = body.model;
      if (body.sizingMode !== undefined) updates.sizingMode = body.sizingMode;
      if (body.riskMinPct !== undefined) updates.riskMinPct = String(body.riskMinPct);
      if (body.riskMaxPct !== undefined) updates.riskMaxPct = String(body.riskMaxPct);

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No mutable fields provided." });
      }

      const updated = await storage.updateAiTraderBot(bot.id, updates as any);
      if (!updated) return res.status(404).json({ error: "Bot not found." });

      res.json({ bot: toBotDto(updated) });
    } catch (err) {
      console.error("[AiTrader] patch error:", err);
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
        // Mirror the create-route model gate: a bot whose model isn't in the
        // curated catalog (e.g. the hand-inserted live-canary sentinel
        // 'manual/canary') must fail with an honest message here, not surface
        // as an opaque provider-400 "gateway" error. Free-trial calls are
        // overridden to the pinned (always-selectable) trial model, so only
        // the non-override path can hit this.
        const effectiveModel = keyRes.modelOverride ?? bot.model;
        if (!isSelectableModel(effectiveModel)) {
          if (keyRes.usedFreeTrial) await storage.decrementAiTraderFreeCalls(req.walletAddress);
          return res.status(400).json({
            error: `This bot's model '${bot.model}' isn't available for AI analysis. It looks like a manually managed bot — recreate it with a supported model to use Ask AI.`,
          });
        }

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

  // --- Go live (WO-7.1: live funding wire-up) -----------------------------------------
  // Flow — fail-closed at every step; the bot stays in paper mode until funding is
  // VERIFIED on-venue:
  //   1. Gates: owner (loadOwnedBot) → not already live → canGoLive(graduationState)
  //      → no open/in-flight paper cycle → Pacifica-only (executor's live path is
  //      Pacifica-only today) → allocatedUsdc ≥ venue min transfer.
  //   2. Idempotent retry: if a previous attempt already persisted subId + V3 key,
  //      SKIP provisioning — verify/complete funding only, then flip. The venue
  //      balance read throws on non-404 (fail closed), so an unreadable venue can
  //      never cause a duplicate funding transfer or a blind flip.
  //   3. Fresh path: UMK (durable execution copy, session fallback) → strict agent
  //      key decrypt → mnemonic (Pacifica is agent_hd: the per-bot key is HD-derived
  //      from the agent seed, so it stays seed-recoverable) → venue subaccount cap
  //      check → atomic provision+fund via the SAME provisionExternalKeyBotSubaccount
  //      helper regular bot-create uses → encrypt sub key under the owner's UMK
  //      (AAD = wallet + bot.id) → persist {subId, keyV3, derivation meta} with
  //      paperMode STILL true → only then flip paperMode=false.
  //   4. Key-persist failure: sweep the freshly funded subaccount back to the agent
  //      with the still-in-memory key (sweepProvisionedExternalKeyFunds, fail-closed
  //      verify-empty). The bot row is NEVER deleted and NEVER flipped live.
  // Documented deviations from regular bot-create (deliberate):
  //   - No spare-pool recycling (claimSpareSubaccount): its HD-index race guard only
  //     knows trading_bots; reusing it across tables risks index collisions for zero
  //     benefit at AI-trader volume. Fresh provision only. Spares still COUNT toward
  //     the cap below (they occupy venue slots).
  //   - policyHmac is NOT recomputed: aiTraderPolicyObject covers market/leverage/
  //     allocatedUsdc only — paperMode is deliberately outside the HMAC envelope.
  //
  // Concurrency: a per-bot in-flight guard (matches the single-process model, same
  // pattern as other money-path locks). Without it, two overlapping requests both
  // read the bot pre-provision → double provision + double fund on the fresh path
  // (the second key-persist would overwrite the first row's subId/derivationIndex,
  // stranding the first sub's funds), or a double funding transfer on the retry
  // path. The window spans several venue round-trips, so a double-click suffices.
  app.post("/api/ai-trader/:id/go-live", requireWallet, async (req: any, res) => {
    let umkHandle: { umk: Buffer; cleanup: () => void } | null = null;
    let agentKey: { secretKey: Uint8Array; cleanup: () => void } | null = null;
    let mnemonic: Buffer | null = null;
    let inFlightClaimedBotId: string | null = null;
    try {
      const bot = await loadOwnedBot(req, res);
      if (!bot) return;
      // Claim the in-flight slot BEFORE any venue read or money movement.
      if (goLiveInFlight.has(bot.id)) {
        return res.status(409).json({ error: "A go-live attempt for this bot is already in progress — wait for it to finish." });
      }
      goLiveInFlight.add(bot.id);
      inFlightClaimedBotId = bot.id;
      if (!bot.paperMode) {
        return res.status(409).json({ error: "This bot is already live." });
      }
      const gate = canGoLive(bot.graduationState);
      if (!gate.ok) {
        return res.status(403).json({ error: gate.error });
      }
      if (bot.status === "open" || bot.status === "executing" || bot.status === "analyzing" || bot.status === "proposed") {
        return res.status(409).json({ error: "Close the open paper position (or wait for the in-flight cycle to finish) before going live." });
      }

      const adapter = getAdapter(bot.protocol);
      const caps = adapter.getCapabilities();
      if (adapter.protocolName !== "pacifica" || !caps.requiresExternalSubaccountKey) {
        return res.status(501).json({ error: `Live mode currently supports Pacifica only (this bot's protocol: ${bot.protocol}).` });
      }

      const fundingAmount = Number(bot.allocatedUsdc);
      if (!(Number.isFinite(fundingAmount) && fundingAmount >= adapter.minTransferAmount)) {
        return res.status(400).json({ error: `Allocated USDC ($${bot.allocatedUsdc}) is below the venue minimum transfer ($${adapter.minTransferAmount}).` });
      }

      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet?.agentPublicKey || !wallet.agentPrivateKeyEncryptedV3) {
        return res.status(400).json({ error: "No trading account on file — set up your trading account first." });
      }
      const agentPublicKey = wallet.agentPublicKey;

      // UMK: prefer the durable execution copy (survives restarts; self-heal a stale
      // one first — mirrors bot-create), fall back to the live session UMK.
      await healExecutionUmkFromStorage(req.walletAddress!);
      umkHandle = await getUmkForWebhook(req.walletAddress!);
      let umkBuf: Buffer | null = umkHandle?.umk ?? null;
      if (!umkBuf) {
        await tryRestoreUmk(req.walletAddress!);
        umkBuf = getSessionByWalletAddress(req.walletAddress!)?.session?.umk ?? null;
      }
      if (!umkBuf) {
        return res.status(400).json({ error: "Your session has expired — please sign out and back in, then retry going live." });
      }

      agentKey = await decryptAgentKeyStrict(req.walletAddress!, umkBuf, wallet, agentPublicKey);
      if (!agentKey) {
        return res.status(400).json({ error: "Your wallet needs to be re-keyed — please sign out and sign back in." });
      }
      const agentKeypair = resolveAgentKeypair(agentKey.secretKey);

      const alreadyProvisioned = !!(bot.protocolSubaccountId && bot.botSubaccountKeyEncryptedV3);
      let subaccountId: string;
      let fundingDetail: string;

      if (alreadyProvisioned) {
        // ---- Idempotent retry: provisioned earlier, funding didn't complete ----
        subaccountId = bot.protocolSubaccountId!;
        // getAccountInfo throws on any non-404 error → caught below → 500, stays
        // paper. It NEVER silently reads 0 on an unreadable venue, so this branch
        // cannot double-fund a funded subaccount.
        const info = await adapter.getAccountInfo(subaccountId);
        const equity = info?.equity ?? info?.balance ?? 0;
        // "Already funded" means the PREVIOUS attempt's transfer landed — that
        // transfer is atomic (full allocatedUsdc or nothing), so genuine success
        // leaves ~the full allocation. Gating on the venue minimum alone would
        // let stray dust above $minTransfer flip a badly under-funded bot live;
        // half the allocation cleanly separates "funded" from "dust" without
        // false negatives from small mark-to-market drift.
        if (equity >= Math.max(adapter.minTransferAmount, fundingAmount / 2)) {
          fundingDetail = `already funded (equity $${equity.toFixed(2)})`;
        } else {
          const tr = await adapter.transferBetweenSubaccounts({
            // Normalized 64-byte secret (resolveAgentKeypair) — the raw stored key
            // may be a 32-byte seed, which PacificaSigner would mis-handle.
            agentSecretKey: agentKeypair.secretKey,
            mainWalletAddress: agentPublicKey,
            fromSubaccountId: agentPublicKey,
            toSubaccountId: subaccountId,
            amount: fundingAmount,
          });
          if (!tr.success) {
            return res.status(502).json({ error: `Funding transfer failed: ${tr.error || "venue rejected the transfer"}. The bot stays in paper mode — retry go-live.` });
          }
          // Verify the transfer landed (fail closed: read failure = not live).
          const after = await adapter.getAccountInfo(subaccountId);
          const afterEquity = after?.equity ?? after?.balance ?? 0;
          if (afterEquity < adapter.minTransferAmount) {
            return res.status(502).json({ error: "Funding transfer sent but the subaccount balance could not be verified. The bot stays in paper mode — retry go-live." });
          }
          fundingDetail = `funded $${fundingAmount.toFixed(2)} on retry (equity $${afterEquity.toFixed(2)})`;
        }
      } else {
        // ---- Fresh path: provision + fund a new venue subaccount ----
        // Pacifica is agent_hd — the recovery phrase is REQUIRED so the per-bot key
        // is derived from the agent seed (seed + index recoverable, mirrors bot-create).
        if (caps.walletDerivation === "agent_hd") {
          mnemonic = await decryptMnemonic(req.walletAddress!, umkBuf);
          if (!mnemonic) {
            return res.status(400).json({ error: "This wallet has no recovery phrase on file, which is required to go live. Please sign out and sign back in to re-key your wallet." });
          }
        }

        // Venue subaccount cap: live slots are consumed by regular bots, AI-trader
        // bots, AND pooled spares (they hold venue subaccounts too). Fail closed on
        // an unreadable count.
        const maxPerAgent = adapter.subaccountCaps?.maxPerAgent ?? null;
        if (maxPerAgent !== null) {
          const capResult = await db.execute(sql`
            SELECT
              (SELECT COUNT(*) FROM trading_bots
                WHERE wallet_address = ${req.walletAddress!} AND active_protocol = ${bot.protocol}
                  AND protocol_subaccount_id IS NOT NULL)
            + (SELECT COUNT(*) FROM ai_trader_bots
                WHERE wallet_address = ${req.walletAddress!} AND protocol = ${bot.protocol}
                  AND protocol_subaccount_id IS NOT NULL)
            + (SELECT COUNT(*) FROM protocol_subaccounts
                WHERE wallet_address = ${req.walletAddress!} AND protocol = ${bot.protocol}
                  AND status IN ('spare', 'reserving') AND protocol_subaccount_id IS NOT NULL) AS used
          `);
          const used = Number((capResult.rows?.[0] as any)?.used ?? NaN);
          if (!Number.isFinite(used)) {
            return res.status(500).json({ error: "Could not verify your venue subaccount count — try again." });
          }
          if (used >= maxPerAgent) {
            return res.status(409).json({ error: `You've reached the venue's limit of ${maxPerAgent} subaccounts. Delete an unused bot to free a slot, then retry.` });
          }
        }

        // Lazy import breaks the module-load cycle (server/routes.ts imports this file).
        const { provisionExternalKeyBotSubaccount, sweepProvisionedExternalKeyFunds } = await import("../routes");

        // Atomic provision + fund (throws on atomic failure → nothing stranded).
        // The helper consumes + zeroizes the mnemonic internally.
        const provision = await provisionExternalKeyBotSubaccount({
          walletAddress: req.walletAddress!,
          agentKeypair,
          agentMnemonic: mnemonic,
          adapter,
          fundingAmount,
        });
        mnemonic = null; // consumed (zeroized) by the helper
        subaccountId = provision.botSubaccountPublicKey;

        // Encrypt + persist the sub key BEFORE any flip, with paperMode STILL true.
        // On persist failure: sweep the funded subaccount back with the in-memory
        // key (fail-closed verify-empty), stay paper, never delete the bot row.
        const pendingKey = provision.pendingBotSecretKeyForV3;
        try {
          let persisted: AiTraderBot | undefined;
          let persistError: unknown = null;
          try {
            const keyV3 = encryptBotSubaccountKeyV3(umkBuf, Buffer.from(pendingKey), req.walletAddress!, bot.id);
            persisted = await storage.updateAiTraderBot(bot.id, {
              protocolSubaccountId: subaccountId,
              botSubaccountKeyEncryptedV3: keyV3,
              derivationIndex: provision.derivationIndex,
              derivationPathVersion: provision.derivationPathVersion,
            });
          } catch (persistErr) {
            persistError = persistErr;
          }
          if (!persisted || persistError) {
            console.error(`[AiTrader] go-live key-persist FAILED for bot ${bot.id} — sweeping subaccount ${subaccountId} back to agent:`, persistError);
            const sweep = await sweepProvisionedExternalKeyFunds({
              adapter,
              subSecretKey: pendingKey,
              subaccountPublicKey: subaccountId,
              agentPublicKey,
              logPrefix: "[AiTrader:GoLive]",
            });
            if (!sweep.swept) {
              console.error(`[AiTrader] go-live rollback sweep INCOMPLETE for bot ${bot.id}: ${sweep.detail} — funds remain on subaccount ${subaccountId}, recoverable via the agent main key`);
            }
            return res.status(500).json({
              error: sweep.swept
                ? "Could not save the bot's trading key — the funds were returned to your trading account. The bot stays in paper mode; retry go-live."
                : "Could not save the bot's trading key. Funds may still sit on the new venue subaccount — they remain recoverable from your trading account. The bot stays in paper mode; contact support if a retry doesn't resolve this.",
            });
          }
        } finally {
          try { pendingKey.fill(0); } catch { /* noop */ }
        }

        // Funding must be VERIFIED before flipping live. (Pacifica's atomic provision
        // reports transferSucceeded; ambiguous is Flash-only but handled the same.)
        if (!provision.provisionMeta.funded || provision.ambiguous) {
          return res.status(502).json({
            error: "Your live subaccount was created but the funding transfer didn't complete. The bot stays in paper mode — retry go-live to finish funding.",
            detail: provision.provisionMeta.warning,
          });
        }
        fundingDetail = `provisioned + funded $${provision.provisionMeta.fundedAmount.toFixed(2)}${provision.provisionMeta.wasNewAccount ? " (new venue account)" : ""}`;
      }

      // Everything verified — flip live. Single final write; every earlier failure
      // path returns with paperMode still true.
      const updated = await storage.updateAiTraderBot(bot.id, {
        paperMode: false,
        status: "idle",
        pauseReason: null,
      });
      console.log(`[AiTrader] Bot ${bot.id} (${bot.market}) is LIVE on ${adapter.protocolName} — subaccount=${subaccountId} ${fundingDetail}`);
      res.json({ bot: updated ? toBotDto(updated) : null, live: true, funding: fundingDetail });
    } catch (err: any) {
      console.error("[AiTrader] go-live error:", err);
      res.status(500).json({ error: `Go-live failed: ${err?.message || "internal error"}. The bot stays in paper mode.` });
    } finally {
      try { mnemonic?.fill(0); } catch { /* noop */ }
      agentKey?.cleanup();
      umkHandle?.cleanup();
      if (inFlightClaimedBotId) goLiveInFlight.delete(inFlightClaimedBotId);
    }
  });

  // --- Admin: founder waive (WO-7.1) ----------------------------------------------------
  // Marks a trial bot's graduation as 'waived' so the founder can run the live canary
  // without waiting out the 30-day paper trial (plan §2e: waived = admin override).
  // This ONLY changes eligibility — going live still runs the full funded go-live path
  // above (same gates, same fail-closed funding). Auth duplicates the Bearer
  // ADMIN_PASSWORD convention from server/routes.ts (defined there as a local closure,
  // not exportable). 503 when unset — never falls open.
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD?.trim();
  const requireAdminAuth = (req: any, res: any, next: any) => {
    if (!ADMIN_PASSWORD) {
      return res.status(503).json({ error: "Admin endpoints disabled - ADMIN_PASSWORD not configured" });
    }
    const providedToken = req.headers.authorization?.replace("Bearer ", "").trim();
    if (!providedToken || providedToken !== ADMIN_PASSWORD) {
      console.log("[AiTrader:Admin] Auth failed - invalid token");
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  };

  app.post("/api/admin/ai-trader/waive", requireAdminAuth, async (req, res) => {
    try {
      const botId = typeof req.body?.botId === "string" ? req.body.botId.trim() : "";
      if (!botId) {
        return res.status(400).json({ error: "botId is required" });
      }
      const bot = await storage.getAiTraderBot(botId);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.graduationState === "graduated" || bot.graduationState === "waived") {
        return res.status(409).json({ error: `Bot is already eligible to go live (graduationState: ${bot.graduationState}).` });
      }
      // Only in_trial / failed reach here (the four states are exhaustive).
      const updated = await storage.updateAiTraderBot(botId, { graduationState: "waived" });
      console.log(`[AiTrader:Admin] Graduation WAIVED for bot ${botId} (${bot.market}, wallet ${bot.walletAddress.slice(0, 8)}..., was ${bot.graduationState})`);
      res.json({
        ok: true,
        bot: updated ? { id: updated.id, market: updated.market, graduationState: updated.graduationState, paperMode: updated.paperMode } : null,
      });
    } catch (err) {
      console.error("[AiTrader:Admin] waive error:", err);
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

  // --- Chart data (read-only) -------------------------------------------------------
  // Candles only — the client already holds entry/exit/SL/TP/realizedPnl/exitReason
  // from the /history decision rows it keeps in state, so this deliberately does not
  // re-return any of that. Window is the decision's decidedAt->closedAt (or "now" for
  // the still-open position), padded and floored per CHART_PAD_CANDLES/
  // CHART_MIN_TOTAL_CANDLES above so a very short trade still renders a real chart.
  app.get("/api/ai-trader/:id/chart", requireWallet, async (req: any, res) => {
    try {
      const bot = await loadOwnedBot(req, res);
      if (!bot) return;

      const decisionId = req.query.decisionId;
      if (!decisionId || typeof decisionId !== "string") {
        return res.status(400).json({ error: "decisionId is required" });
      }

      const decisions = await storage.getAiTraderDecisions(bot.id, 200);
      const decision = decisions.find((d) => d.id === decisionId);
      if (!decision) {
        return res.status(404).json({ error: "Decision not found" });
      }

      const tfMs = CHART_TIMEFRAME_MS[bot.timeframe] ?? CHART_TIMEFRAME_MS["1h"];
      const now = Date.now();
      const decidedAtMs = decision.decidedAt ? new Date(decision.decidedAt).getTime() : now;
      const closedAtMs = decision.closedAt ? new Date(decision.closedAt).getTime() : now;

      let startMs = decidedAtMs - CHART_PAD_CANDLES * tfMs;
      let endMs = Math.min(closedAtMs + CHART_PAD_CANDLES * tfMs, now);
      const minSpanMs = CHART_MIN_TOTAL_CANDLES * tfMs;
      if (endMs - startMs < minSpanMs) {
        const deficit = minSpanMs - (endMs - startMs);
        startMs -= deficit / 2;
        endMs = Math.min(endMs + deficit / 2, now);
      }
      endMs = Math.min(endMs, now);

      const datafeedTicker = marketToDatafeedTicker(bot.market);
      const rawCandles = await fetchOHLCV(
        datafeedTicker,
        bot.timeframe,
        new Date(startMs).toISOString(),
        new Date(endMs).toISOString()
      );
      const candles = rawCandles.map((c) => ({
        time: Math.floor(c.time / 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));
      res.json({ candles, market: bot.market, timeframe: bot.timeframe });
    } catch (err) {
      console.error("[AiTrader] chart error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });
}
