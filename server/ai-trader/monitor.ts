// AI Trader — position monitor + lifecycle loop (WO-6, docs/AGENTIC_TRADER_PLAN.md §6).
//
// Responsibilities (plan WO-6 items 1–6):
//   1. Close detection — paper (candle vs bracket via paper-math) and live
//      (position gone → classify exit from venue fills; cancel the survivor leg).
//   2. Bracket re-verification (G10) — live open bots: SL/TP orders must stay
//      resting; re-place ONCE if missing, close-and-pause on a second miss.
//   3. Circuit breakers — G7 daily-loss force-flat and G8 consecutive-SL pause
//      ('guarded' profile only; §5a), plus the ALWAYS-ON malfunction ceiling
//      (≥20 closed trades/day pauses even 'degen' bots).
//   4. Auto-next — after a clean close on an auto-mode bot with autoNext, run
//      the next decision cycle at the next candle boundary (G6 checked BEFORE
//      any LLM spend; UMK unavailable ⇒ pause 'reauth_required' + Telegram).
//   5. Startup reconciliation — crash-marker statuses ('executing'/'analyzing'/
//      'proposed') are resolved against the exchange: live position found ⇒
//      complete the bracket or close-and-pause; provably flat ⇒ idle +
//      decision 'aborted_crash'.
//   6. Graduation — after every paper close (and via a daily sweep that also
//      catches period-elapsed-with-no-trades), evaluate §2e and flip
//      graduationState; Telegram on 'graduated'.
//
// NO LLM calls happen in the monitor loop itself (§6 — deterministic); the
// only LLM entry point is the auto-next cycle, which is a scheduled decision
// cycle identical to a user-triggered one.
//
// Deliberate omission (§6 step 4 "funding flag"): the funding-cost advisory is
// context-builder's job at decision time (WO-3 already surfaces funding to the
// model); a 15s-loop REST poll of getFundingRate would burn Pacifica's
// 300-credit budget for a log line. The binding WO-6 checklist (plan L647–662)
// does not include it.
//
// Money-op note: monitor money paths (cancel survivor leg, re-place bracket,
// force-flat, reconciliation close) are PROTECTIVE — they only ever reduce or
// close exposure, never open it — so they intentionally skip the G15 policy
// HMAC check (which gates new entries in the executor). A tampered bot row
// must never block an emergency close.

import { storage } from "../storage";
import { getAdapter } from "../protocol/adapter-registry";
import {
  getUmkForWebhook,
  decryptAgentKeyStrict,
  healExecutionUmkFromStorage,
  getSessionByWalletAddress,
  restoreWalletSecurityFromStorage,
  decryptLlmApiKeyV3,
} from "../session-v3";
import { fireReflection } from "./reflection-service";
import { sendTradeNotification, getCloseReasonLabel } from "../notification-service";
import { resolveAiTraderSubaccountSigner, liveReadAccount } from "./signing";
import { evaluatePaperBracket, paperRealizedPnl, paperExitPrice, type PaperSide } from "./paper-math";
import { fetchOHLCV } from "../lab/datafeed";
import { buildMarketContext, marketToDatafeedTicker, type AiTraderTimeframe } from "./context-builder";
import { runDecision } from "./decide";
import { isSelectableModel } from "../ai-assistant/models-catalog";
import { executeDecision, checkCooldownAndCaps } from "./executor";
import { evaluateGraduation, type GraduationTradeRecord } from "./graduation";
import type { AiTraderBot, AiTraderDecision } from "@shared/schema";
import type { ProtocolAdapter } from "../protocol/adapter";
import type { ProtocolPosition, TradeRecord } from "../protocol/protocol-types";

// --- Constants ---------------------------------------------------------------------

const MONITOR_TICK_MS = 15_000;
const DAILY_SWEEP_MS = 6 * 60 * 60 * 1000; // graduation sweep every 6h (cheap; catches period-elapsed)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Mirrors context-builder/decide (module-private there by WO scoping).
const TIMEFRAME_MS: Record<string, number> = {
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

/** Platform-wide taker fee convention (context-builder L73, decide L35). */
const EXCHANGE_TAKER_FEE_RATE = 0.0004;

/** G7 — daily loss breaker: realized-today + open MTM ≤ −15% of allocation ⇒ force flat + pause. */
const DAILY_LOSS_BREAKER_PCT = 15;
/** G8 — pause after 3 consecutive stop-loss exits ('guarded' only). */
const CONSECUTIVE_SL_LIMIT = 3;
/** Always-on malfunction ceiling (§5a): ≥20 closed trades/day pauses ANY profile. */
const MALFUNCTION_TRADES_PER_DAY = 20;
/** Exit-classification tolerance: a fill within ±0.5% of a bracket level is that leg. */
const EXIT_CLASSIFY_TOLERANCE_PCT = 0.5;
/** Slippage cap forwarded to protective closePosition calls. */
const PROTECTIVE_CLOSE_MAX_SLIPPAGE_PCT = 1.0;

// --- Module state --------------------------------------------------------------------

let tickTimer: NodeJS.Timeout | null = null;
let sweepTimer: NodeJS.Timeout | null = null;
let tickInFlight = false;

/** Bots whose startup reconciliation hit a venue read failure — retried each tick. */
const pendingReconciliation = new Set<string>();
/** decisionIds whose missing bracket was already re-placed once (2nd miss ⇒ close+pause). */
const bracketReplaceAttempted = new Set<string>();
/** Per-bot auto-next timers (cleared on re-schedule / pause / stop). */
const autoNextTimers = new Map<string, NodeJS.Timeout>();
/** Per-bot re-entrancy guard so a slow bot can't be processed by two ticks at once. */
const botInFlight = new Set<string>();

// --- Small helpers -------------------------------------------------------------------

function utcDayStartMs(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function botLabel(bot: AiTraderBot): string {
  return `AI Trader ${bot.market}`;
}

function matchPosition(positions: ProtocolPosition[], market: string): ProtocolPosition | null {
  return (
    positions.find(
      (p) => p.internalSymbol.toUpperCase() === market.toUpperCase() && Math.abs(p.baseSize) > 0
    ) ?? null
  );
}

// --- Open-decision view ---------------------------------------------------------------

export interface OpenDecisionView {
  decision: AiTraderDecision;
  side: PaperSide;
  sizeBase: number;
  marginUsdc: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  /** Recorded entry fill (may be null pre-reconciliation for crashed live entries). */
  entryPrice: number | null;
  decidedAtMs: number;
}

/**
 * Parse the bot's currently-open decision row (outcome 'executed', not yet
 * closed) into validated numbers. Returns null when there is no such row or
 * the clamped payload is unusable — callers treat that as an inconsistency to
 * self-heal, never as "everything is fine".
 */
export function parseOpenDecision(decisions: AiTraderDecision[]): OpenDecisionView | null {
  const row = decisions.find((d) => d.outcome === "executed" && !d.closedAt);
  if (!row) return null;
  const clamped = (row.clampedDecision ?? {}) as Record<string, unknown>;
  const action = clamped.action;
  if (action !== "long" && action !== "short") return null;
  const sizeBase = num(clamped.sizeBase);
  const marginUsdc = num(clamped.marginUsdc);
  const stopLossPrice = num(clamped.stopLossPrice);
  const takeProfitPrice = num(clamped.takeProfitPrice);
  if (!sizeBase || sizeBase <= 0 || !stopLossPrice || stopLossPrice <= 0 || !takeProfitPrice || takeProfitPrice <= 0) {
    return null;
  }
  const decidedAtMs = row.decidedAt ? new Date(row.decidedAt).getTime() : Date.now();
  return {
    decision: row,
    side: action,
    sizeBase,
    marginUsdc: marginUsdc ?? 0,
    stopLossPrice,
    takeProfitPrice,
    entryPrice: num(row.entryPrice),
    decidedAtMs,
  };
}

/**
 * Display-grade mark-to-market for an open paper or live position.
 *
 * Shared by the list-route and detail-route PnL DTO blocks so both endpoints
 * use the same arithmetic. The monitor's internal G7 breaker and graduation
 * sweep keep their own inline copies — different input sources, different call
 * sites — so do not attempt to unify them here.
 *
 * Returns null when:
 *   - entryPrice is null (live bot pre-reconciliation) or ≤ 0 (bad data)
 *   - markPrice is non-finite or ≤ 0 (price feed unavailable)
 *   - sizeBase is non-positive (invalid view)
 */
export function computeUnrealizedPnl(view: OpenDecisionView, markPrice: number): number | null {
  if (
    view.entryPrice === null ||
    !Number.isFinite(view.entryPrice) ||
    view.entryPrice <= 0 ||
    !Number.isFinite(markPrice) ||
    markPrice <= 0 ||
    !Number.isFinite(view.sizeBase) ||
    view.sizeBase <= 0
  ) {
    return null;
  }
  const direction = view.side === "long" ? 1 : -1;
  return (markPrice - view.entryPrice) * view.sizeBase * direction;
}

// --- Live exit classification (pure, exported for tests) --------------------------------

/**
 * Classify a vanished live position from its average exit fill price relative
 * to the stored bracket. Plan §6: a fill near a bracket leg is that leg; a
 * position that is gone with NEITHER leg matching is treated as an
 * exchange-side liquidation (pause + human eyes). `null` avgExitPrice (no
 * fills found at all) is also the liquidation branch — an exit we cannot
 * account for is never a clean close.
 */
export function classifyLiveExit(args: {
  side: PaperSide;
  avgExitPrice: number | null;
  stopLossPrice: number;
  takeProfitPrice: number;
  tolerancePct?: number;
}): "sl" | "tp" | "liquidation" {
  const { side, avgExitPrice, stopLossPrice, takeProfitPrice } = args;
  const tol = (args.tolerancePct ?? EXIT_CLASSIFY_TOLERANCE_PCT) / 100;
  if (avgExitPrice === null || !Number.isFinite(avgExitPrice)) return "liquidation";
  const nearSl = Math.abs(avgExitPrice - stopLossPrice) / stopLossPrice <= tol;
  // TP triggers on touch and can fill BEYOND the level (favorably); anything at
  // or past tp-within-tolerance in the favorable direction is a TP fill.
  const atOrBeyondTp =
    side === "long"
      ? avgExitPrice >= takeProfitPrice * (1 - tol)
      : avgExitPrice <= takeProfitPrice * (1 + tol);
  if (atOrBeyondTp) return "tp";
  if (nearSl) return "sl";
  return "liquidation";
}

/** Aggregate exit fills for a vanished position from venue trade history. */
export function extractExitFills(
  trades: TradeRecord[],
  args: { market: string; entrySide: PaperSide; decisionId: string; sinceMs: number; subaccountId?: string | null }
): { avgExitPrice: number | null; exitFees: number; entryFees: number } {
  const exitSide: PaperSide = args.entrySide === "long" ? "short" : "long";
  const entryClientId = `aitrader-${args.decisionId}`;
  let notional = 0;
  let sizeSum = 0;
  let exitFees = 0;
  let entryFees = 0;
  for (const t of trades) {
    if (t.internalSymbol.toUpperCase() !== args.market.toUpperCase()) continue;
    if (t.timestamp < args.sinceMs) continue;
    if (args.subaccountId && t.subaccountId && t.subaccountId !== args.subaccountId) continue;
    if (t.clientOrderId === entryClientId) {
      entryFees += t.fee;
      continue;
    }
    if (t.side !== exitSide) continue;
    notional += t.price * t.size;
    sizeSum += t.size;
    exitFees += t.fee;
  }
  return {
    avgExitPrice: sizeSum > 0 ? notional / sizeSum : null,
    exitFees,
    entryFees,
  };
}

// --- Signing context (canonical headless pattern — executor L256–304) --------------------
// WO-7.1: takes the BOT, not just the wallet address. A bot with its own venue
// subaccount signs with the bot's OWN sub key (the signed account IS the sub
// pubkey; adapter subaccountId stays undefined) and fails closed when that key
// is unavailable — it NEVER downgrades to the main agent key, which would act
// on the user's main account. Legacy canary bots (protocolSubaccountId=null)
// keep the main-agent-key path.

type KeyTrio = { agentPublicKey: string; agentSecretKey: Uint8Array; mainWalletAddress: string };

async function withSigningContext<T>(
  bot: AiTraderBot,
  fn: (keyTrio: KeyTrio) => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; detail: string }> {
  const walletAddress = bot.walletAddress;
  const wallet = await storage.getWallet(walletAddress);
  if (!wallet?.agentPublicKey || !wallet?.agentPrivateKeyEncryptedV3) {
    return { ok: false, detail: "wallet missing V3 envelope or agent public key" };
  }
  let umkResult = await getUmkForWebhook(walletAddress);
  if (!umkResult) {
    const why = wallet.emergencyStopTriggered ? "emergency_stopped" : "execution_disabled";
    return { ok: false, detail: `execution authorization unavailable (${why})` };
  }
  let agentKeyResult: { secretKey: Uint8Array; cleanup: () => void } | null = null;
  try {
    if (bot.protocolSubaccountId) {
      agentKeyResult = await resolveAiTraderSubaccountSigner(bot, umkResult.umk);
      if (!agentKeyResult) {
        // Same heal-once as the agent-key path (execution-UMK drift).
        umkResult.cleanup();
        umkResult = null;
        await healExecutionUmkFromStorage(walletAddress);
        umkResult = await getUmkForWebhook(walletAddress);
        if (umkResult) {
          agentKeyResult = await resolveAiTraderSubaccountSigner(bot, umkResult.umk);
        }
        if (!agentKeyResult) {
          return { ok: false, detail: `bot subaccount key unavailable for ${bot.protocolSubaccountId} (fail closed — will NOT sign with the main agent key)` };
        }
      }
    } else {
      agentKeyResult = await decryptAgentKeyStrict(walletAddress, umkResult.umk, wallet, wallet.agentPublicKey);
      if (!agentKeyResult) {
        // Self-heal path shared with the executor/webhook: the execution-wrapped
        // UMK copy can drift from canonical — heal once, retry once.
        umkResult.cleanup();
        umkResult = null;
        await healExecutionUmkFromStorage(walletAddress);
        umkResult = await getUmkForWebhook(walletAddress);
        if (umkResult) {
          agentKeyResult = await decryptAgentKeyStrict(walletAddress, umkResult.umk, wallet, wallet.agentPublicKey);
        }
        if (!agentKeyResult) {
          return { ok: false, detail: "V3 strict agent-key decrypt failed (after execution-UMK heal attempt)" };
        }
      }
    }
    const value = await fn({
      agentPublicKey: liveReadAccount(bot, wallet.agentPublicKey),
      agentSecretKey: agentKeyResult.secretKey,
      mainWalletAddress: walletAddress,
    });
    return { ok: true, value };
  } finally {
    agentKeyResult?.cleanup();
    umkResult?.cleanup();
  }
}

// --- Close bookkeeping (shared paper + live) ----------------------------------------------

interface CloseRecord {
  exitPrice: number | null;
  exitReason: string;
  realizedPnl: number | null;
  feesPaid: number | null;
  closedAt: Date;
}

async function recordClose(bot: AiTraderBot, view: OpenDecisionView, close: CloseRecord): Promise<void> {
  await storage.updateAiTraderDecision(view.decision.id, {
    exitPrice: close.exitPrice !== null ? close.exitPrice.toFixed(8) : null,
    exitReason: close.exitReason,
    realizedPnl: close.realizedPnl !== null ? close.realizedPnl.toFixed(2) : null,
    feesPaid: close.feesPaid !== null ? close.feesPaid.toFixed(6) : null,
    closedAt: close.closedAt,
  });
}

/**
 * Post-close bookkeeping shared by every close path: daily PnL column,
 * consecutive-loss streak, circuit-breaker pauses, graduation (paper), and
 * auto-next scheduling. `alreadyPaused` short-circuits the eligibility parts
 * when the close itself was a pause (liquidation / force-flat / bracket fail).
 */
async function afterClose(
  bot: AiTraderBot,
  close: CloseRecord,
  opts: { alreadyPaused: boolean }
): Promise<void> {
  const now = Date.now();
  const dayStart = utcDayStartMs(now);
  const recentClosed = await storage.getRecentClosedDecisions(bot.id, 60);
  const closedToday = recentClosed.filter(
    (d) => d.closedAt && new Date(d.closedAt).getTime() >= dayStart
  );
  const dailyRealized = closedToday.reduce((sum, d) => sum + (num(d.realizedPnl) ?? 0), 0);
  const isSl = close.exitReason === "sl";
  const consecutiveLosses = isSl ? (bot.consecutiveLosses ?? 0) + 1 : 0;

  await storage.updateAiTraderBot(bot.id, {
    dailyRealizedPnl: dailyRealized.toFixed(2),
    consecutiveLosses,
    ...(opts.alreadyPaused ? {} : { status: "idle", pauseReason: null }),
  });

  // Fire reflection async — never blocks close-out, one in-flight per bot.
  // INJECTION NOT YET ACTIVE: lessons accumulate only (see reflection-service.ts header).
  fireReflection(bot);

  // Graduation runs on EVERY paper close, before pause checks — a pause must
  // not hide a completed record from the evaluator.
  if (bot.paperMode) {
    await evaluateBotGraduation({ ...bot, consecutiveLosses }, 0);
  }

  if (opts.alreadyPaused) {
    clearAutoNext(bot.id);
    return;
  }

  const allocation = num(bot.allocatedUsdc) ?? 0;

  // Malfunction ceiling — ALWAYS on, every profile (§5a).
  if (closedToday.length >= MALFUNCTION_TRADES_PER_DAY) {
    await pauseBot(bot, "malfunction_ceiling", `closed ${closedToday.length} trades today (ceiling ${MALFUNCTION_TRADES_PER_DAY}) — pausing for inspection`);
    return;
  }

  if (bot.riskProfile !== "degen") {
    // G8 — consecutive stop-losses.
    if (consecutiveLosses >= CONSECUTIVE_SL_LIMIT) {
      await pauseBot(bot, "consecutive_losses", `${consecutiveLosses} consecutive stop-loss exits — pausing (G8)`);
      return;
    }
    // G7 — daily loss (fully realized at this point; MTM branch handled while open).
    if (allocation > 0 && dailyRealized <= -(DAILY_LOSS_BREAKER_PCT / 100) * allocation) {
      await pauseBot(bot, "daily_loss_breaker", `daily realized PnL ${dailyRealized.toFixed(2)} breached −${DAILY_LOSS_BREAKER_PCT}% of allocation — pausing (G7)`);
      return;
    }
  }

  if (bot.mode === "auto" && bot.autoNext) {
    scheduleAutoNext(bot.id, bot.timeframe);
  }
}

async function pauseBot(bot: AiTraderBot, pauseReason: string, detail: string): Promise<void> {
  clearAutoNext(bot.id);
  await storage.updateAiTraderBot(bot.id, { status: "paused", pauseReason });
  console.warn(`[AiTraderMonitor] Bot ${bot.id.slice(0, 8)} paused (${pauseReason}): ${detail}`);
  await sendTradeNotification(bot.walletAddress, {
    type: "trade_failed",
    botName: botLabel(bot),
    market: bot.market,
    error: `Bot paused: ${detail}`,
  });
}

async function notifyClosed(bot: AiTraderBot, close: CloseRecord, closeReason: string): Promise<void> {
  await sendTradeNotification(bot.walletAddress, {
    type: "position_closed",
    botName: botLabel(bot),
    market: bot.market,
    pnl: close.realizedPnl ?? undefined,
    closeReason,
  });
}

// --- Paper monitoring -----------------------------------------------------------------

/**
 * One monitoring pass for an OPEN paper bot: fetch candles since entry,
 * evaluate the bracket (entry candle excluded per the WO-5 fill convention —
 * the entry filled at decision-time mark, so only LATER candles can trigger),
 * close on a hit, else run the G7 mark-to-market breaker.
 */
async function monitorPaperBot(bot: AiTraderBot, view: OpenDecisionView): Promise<void> {
  const tfMs = TIMEFRAME_MS[bot.timeframe];
  if (!tfMs) {
    console.error(`[AiTraderMonitor] Bot ${bot.id.slice(0, 8)}: unknown timeframe '${bot.timeframe}' — cannot monitor`);
    return;
  }
  if (view.entryPrice === null) {
    // Paper entries always record entryPrice at fill; a null here is corrupt state.
    await pauseBot(bot, "inconsistent_state", "open paper decision has no entry price");
    return;
  }
  const now = Date.now();
  const entryCandleOpen = Math.floor(view.decidedAtMs / tfMs) * tfMs;

  let candles;
  try {
    candles = await fetchOHLCV(
      marketToDatafeedTicker(bot.market),
      bot.timeframe,
      new Date(entryCandleOpen).toISOString(),
      new Date(now).toISOString()
    );
  } catch (err) {
    console.warn(`[AiTraderMonitor] Bot ${bot.id.slice(0, 8)}: candle fetch failed (${err instanceof Error ? err.message : err}) — retrying next tick`);
    return;
  }
  // Strictly AFTER the entry candle: the entry candle's extremes predate the
  // fill (or contain it ambiguously), so it can never trigger the bracket.
  // The currently-forming candle IS included — a live stop would already have
  // triggered on an intra-candle touch.
  const post = candles.filter((c) => c.time > entryCandleOpen);

  const hit = evaluatePaperBracket(post, view.side, view.stopLossPrice, view.takeProfitPrice);
  if (hit) {
    const pnl = paperRealizedPnl({
      side: view.side,
      entryPrice: view.entryPrice,
      exitPrice: hit.exitPrice,
      sizeBase: view.sizeBase,
      takerFeeRate: EXCHANGE_TAKER_FEE_RATE,
    });
    const close: CloseRecord = {
      exitPrice: hit.exitPrice,
      exitReason: hit.leg,
      realizedPnl: pnl.netPnl,
      feesPaid: pnl.fees,
      closedAt: new Date(hit.candleTime),
    };
    await recordClose(bot, view, close);
    console.log(
      `[AiTraderMonitor] Paper close: bot ${bot.id.slice(0, 8)} ${view.side} ${bot.market} ${hit.leg.toUpperCase()} @ ${hit.exitPrice.toFixed(6)} pnl ${pnl.netPnl.toFixed(2)}`
    );
    await notifyClosed(bot, close, getCloseReasonLabel("tpsl", hit.leg === "tp" ? "TP" : "SL"));
    await afterClose(bot, close, { alreadyPaused: false });
    return;
  }

  // Still open — G7 mark-to-market breaker ('guarded' only).
  if (bot.riskProfile === "degen") return;
  const allocation = num(bot.allocatedUsdc) ?? 0;
  if (allocation <= 0) return;
  const lastClose = post.length > 0 ? post[post.length - 1].close : candles.length > 0 ? candles[candles.length - 1].close : null;
  if (lastClose === null) return;
  const direction = view.side === "long" ? 1 : -1;
  const unrealized = (lastClose - view.entryPrice) * view.sizeBase * direction;

  const dayStart = utcDayStartMs(now);
  const recentClosed = await storage.getRecentClosedDecisions(bot.id, 60);
  const dailyRealized = recentClosed
    .filter((d) => d.closedAt && new Date(d.closedAt).getTime() >= dayStart)
    .reduce((sum, d) => sum + (num(d.realizedPnl) ?? 0), 0);

  if (dailyRealized + unrealized <= -(DAILY_LOSS_BREAKER_PCT / 100) * allocation) {
    // Force-flat at the last known price with the adverse exit-slippage penalty.
    const exitPrice = paperExitPrice(lastClose, view.side);
    const pnl = paperRealizedPnl({
      side: view.side,
      entryPrice: view.entryPrice,
      exitPrice,
      sizeBase: view.sizeBase,
      takerFeeRate: EXCHANGE_TAKER_FEE_RATE,
    });
    const close: CloseRecord = {
      exitPrice,
      exitReason: "circuit_breaker",
      realizedPnl: pnl.netPnl,
      feesPaid: pnl.fees,
      closedAt: new Date(now),
    };
    await recordClose(bot, view, close);
    await pauseBot(
      bot,
      "daily_loss_breaker",
      `G7 daily-loss breaker: realized ${dailyRealized.toFixed(2)} + open MTM ${unrealized.toFixed(2)} breached −${DAILY_LOSS_BREAKER_PCT}% of allocation — paper position force-flattened`
    );
    await notifyClosed(bot, close, "Circuit Breaker (Daily Loss)");
    await afterClose(bot, close, { alreadyPaused: true });
  }
}

// --- Live monitoring ------------------------------------------------------------------

/**
 * Protective close of a live position + pause. Used by G7 force-flat, the
 * bracket-failure path and reconciliation. Records an HONEST decision close:
 * fill price from the close order when the venue returns one; realizedPnl is
 * an estimate (price PnL minus a 2× taker-fee estimate) only when both entry
 * and exit prices are known, otherwise null.
 */
async function closeLivePositionAndPause(
  bot: AiTraderBot,
  view: OpenDecisionView,
  adapter: ProtocolAdapter,
  args: { pauseReason: string; exitReason: string; detail: string }
): Promise<void> {
  // WO-7.1: subaccountId is always undefined — a sub-provisioned bot signs AS
  // its subaccount (keyTrio.agentPublicKey is the sub pubkey).
  const subaccountId = undefined;
  const result = await withSigningContext(bot, async (keyTrio) => {
    try {
      await adapter.cancelTpSlOrders?.({ ...keyTrio, internalSymbol: bot.market, subaccountId });
    } catch (err) {
      console.warn(`[AiTraderMonitor] cancelTpSlOrders failed before protective close: ${err instanceof Error ? err.message : err}`);
    }
    return adapter.closePosition({
      ...keyTrio,
      internalSymbol: bot.market,
      subaccountId,
      maxSlippagePct: PROTECTIVE_CLOSE_MAX_SLIPPAGE_PCT,
    });
  });

  if (!result.ok) {
    // Could not even sign — pause anyway (fail closed) and say so loudly. The
    // position (if any) is still protected by its venue-side bracket.
    await pauseBot(bot, args.pauseReason, `${args.detail}; PROTECTIVE CLOSE FAILED (${result.detail}) — check the venue manually`);
    return;
  }

  const order = result.value;
  const fillPrice = order.success && typeof order.fillPrice === "number" && Number.isFinite(order.fillPrice) ? order.fillPrice : null;
  let realizedPnl: number | null = null;
  let feesPaid: number | null = null;
  if (fillPrice !== null && view.entryPrice !== null) {
    const direction = view.side === "long" ? 1 : -1;
    const grossPnl = (fillPrice - view.entryPrice) * view.sizeBase * direction;
    feesPaid = EXCHANGE_TAKER_FEE_RATE * (view.entryPrice + fillPrice) * view.sizeBase;
    realizedPnl = grossPnl - feesPaid;
  }
  const close: CloseRecord = {
    exitPrice: fillPrice,
    exitReason: args.exitReason,
    realizedPnl,
    feesPaid,
    closedAt: new Date(),
  };
  await recordClose(bot, view, close);
  await pauseBot(bot, args.pauseReason, args.detail);
  await notifyClosed(bot, close, "Closed by Circuit Breaker");
  await afterClose(bot, close, { alreadyPaused: true });
}

/**
 * User-initiated manual close (WO-7 `/api/ai-trader/:id/close`). Mirrors the
 * paper close math in `monitorPaperBot` and the live protective-close
 * template in `closeLivePositionAndPause`, but is caller-invoked rather than
 * monitor-tick-invoked, and — unlike every other close path — must NOT
 * record or pause the bot on a live order FAILURE: a failed close leaves the
 * position exactly where it was (still protected by its resting venue-side
 * bracket), so the bot must stay exactly as it was rather than be silently
 * paused out from under the user. `exitReason: "user_close"` is already a
 * documented enum value in the decisions table (schema comment, WO-2).
 */
export async function userInitiatedClose(
  bot: AiTraderBot
): Promise<
  | { ok: true; closed: false }
  | { ok: true; closed: true; exitPrice: number | null; realizedPnl: number | null }
  | { ok: false; detail: string }
> {
  const decisions = await storage.getAiTraderDecisions(bot.id, 20);
  const view = parseOpenDecision(decisions);
  if (!view) {
    // Nothing open to close — not an error, just a no-op the route can 200 on.
    return { ok: true, closed: false };
  }

  const adapter = getAdapter(bot.protocol);

  if (bot.paperMode) {
    let markPrice: number | null;
    try {
      markPrice = await adapter.getPrice(bot.market);
    } catch (err) {
      return { ok: false, detail: `price read failed: ${err instanceof Error ? err.message : err}` };
    }
    if (markPrice === null || view.entryPrice === null) {
      return { ok: false, detail: "no live price available to close the paper position" };
    }
    const exitPrice = paperExitPrice(markPrice, view.side);
    const pnl = paperRealizedPnl({
      side: view.side,
      entryPrice: view.entryPrice,
      exitPrice,
      sizeBase: view.sizeBase,
      takerFeeRate: EXCHANGE_TAKER_FEE_RATE,
    });
    const close: CloseRecord = {
      exitPrice,
      exitReason: "user_close",
      realizedPnl: pnl.netPnl,
      feesPaid: pnl.fees,
      closedAt: new Date(),
    };
    await recordClose(bot, view, close);
    await notifyClosed(bot, close, "Closed by You");
    await afterClose(bot, close, { alreadyPaused: false });
    return { ok: true, closed: true, exitPrice, realizedPnl: pnl.netPnl };
  }

  // Live: same cancel-survivor-leg + closePosition template as
  // closeLivePositionAndPause, but ok:false on failure instead of pausing —
  // an unclosed live position is still bracket-protected.
  const subaccountId = undefined; // WO-7.1: sub-provisioned bots sign AS the subaccount
  const result = await withSigningContext(bot, async (keyTrio) => {
    try {
      await adapter.cancelTpSlOrders?.({ ...keyTrio, internalSymbol: bot.market, subaccountId });
    } catch (err) {
      console.warn(`[AiTraderMonitor] cancelTpSlOrders failed before user-initiated close: ${err instanceof Error ? err.message : err}`);
    }
    return adapter.closePosition({
      ...keyTrio,
      internalSymbol: bot.market,
      subaccountId,
      maxSlippagePct: PROTECTIVE_CLOSE_MAX_SLIPPAGE_PCT,
    });
  });

  if (!result.ok) {
    return { ok: false, detail: result.detail };
  }
  const order = result.value;
  if (!order.success) {
    return { ok: false, detail: order.error ?? "close order failed" };
  }

  const fillPrice = typeof order.fillPrice === "number" && Number.isFinite(order.fillPrice) ? order.fillPrice : null;
  let realizedPnl: number | null = null;
  let feesPaid: number | null = null;
  if (fillPrice !== null && view.entryPrice !== null) {
    const direction = view.side === "long" ? 1 : -1;
    const grossPnl = (fillPrice - view.entryPrice) * view.sizeBase * direction;
    feesPaid = EXCHANGE_TAKER_FEE_RATE * (view.entryPrice + fillPrice) * view.sizeBase;
    realizedPnl = grossPnl - feesPaid;
  }
  const close: CloseRecord = {
    exitPrice: fillPrice,
    exitReason: "user_close",
    realizedPnl,
    feesPaid,
    closedAt: new Date(),
  };
  await recordClose(bot, view, close);
  await notifyClosed(bot, close, "Closed by You");
  await afterClose(bot, close, { alreadyPaused: false });
  return { ok: true, closed: true, exitPrice: fillPrice, realizedPnl };
}

/** Live close detection: position is GONE — classify from fills, cancel survivor leg. */
async function handleLiveClose(
  bot: AiTraderBot,
  view: OpenDecisionView,
  adapter: ProtocolAdapter,
  agentPublicKey: string
): Promise<void> {
  const subaccountId = undefined; // WO-7.1: reads target the bot's own account directly

  let trades: TradeRecord[];
  try {
    trades = await adapter.getTradeHistory(liveReadAccount(bot, agentPublicKey), {
      startTime: view.decidedAtMs,
      limit: 200,
    });
  } catch (err) {
    // Read failure ≠ "no fills". Retry next tick rather than misclassifying.
    console.warn(`[AiTraderMonitor] Bot ${bot.id.slice(0, 8)}: getTradeHistory failed (${err instanceof Error ? err.message : err}) — close handling deferred`);
    return;
  }

  const fills = extractExitFills(trades, {
    market: bot.market,
    entrySide: view.side,
    decisionId: view.decision.id,
    sinceMs: view.decidedAtMs,
    subaccountId,
  });
  const exitReason = classifyLiveExit({
    side: view.side,
    avgExitPrice: fills.avgExitPrice,
    stopLossPrice: view.stopLossPrice,
    takeProfitPrice: view.takeProfitPrice,
  });

  // Cancel the surviving bracket leg (best-effort; reduce-only orders on a
  // flat account are inert, but leaving them resting is sloppy and confusing).
  const cancelRes = await withSigningContext(bot, async (keyTrio) => {
    try {
      await adapter.cancelTpSlOrders?.({ ...keyTrio, internalSymbol: bot.market, subaccountId });
      return true;
    } catch (err) {
      console.warn(`[AiTraderMonitor] survivor-leg cancel failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  });
  if (!cancelRes.ok) {
    console.warn(`[AiTraderMonitor] survivor-leg cancel unavailable (${cancelRes.detail})`);
  }

  let realizedPnl: number | null = null;
  const totalFees = fills.exitFees + fills.entryFees;
  if (fills.avgExitPrice !== null && view.entryPrice !== null) {
    const direction = view.side === "long" ? 1 : -1;
    realizedPnl = (fills.avgExitPrice - view.entryPrice) * view.sizeBase * direction - totalFees;
  }
  const close: CloseRecord = {
    exitPrice: fills.avgExitPrice,
    exitReason,
    realizedPnl,
    feesPaid: fills.avgExitPrice !== null ? totalFees : null,
    closedAt: new Date(),
  };
  await recordClose(bot, view, close);
  bracketReplaceAttempted.delete(view.decision.id);

  if (exitReason === "liquidation") {
    // Plan §6: unattributable exit ⇒ treat as exchange-side liquidation, pause,
    // alert. (A manual close on the venue lands here too — pause + human eyes
    // is the safe response either way.)
    await storage.updateAiTraderBot(bot.id, { status: "paused", pauseReason: "liquidation" });
    clearAutoNext(bot.id);
    await notifyClosed(bot, close, `${getCloseReasonLabel("liquidation")} (or closed outside the app) — Bot Paused`);
    await afterClose(bot, close, { alreadyPaused: true });
    return;
  }

  console.log(
    `[AiTraderMonitor] Live close: bot ${bot.id.slice(0, 8)} ${view.side} ${bot.market} ${exitReason.toUpperCase()} @ ${fills.avgExitPrice?.toFixed(6)} pnl ${realizedPnl?.toFixed(2)}`
  );
  await notifyClosed(bot, close, getCloseReasonLabel("tpsl", exitReason === "tp" ? "TP" : "SL"));
  await afterClose(bot, close, { alreadyPaused: false });
}

/** One monitoring pass for an OPEN live bot. */
async function monitorLiveBot(bot: AiTraderBot, view: OpenDecisionView): Promise<void> {
  const adapter = getAdapter(bot.protocol);
  const wallet = await storage.getWallet(bot.walletAddress);
  if (!wallet?.agentPublicKey) {
    console.error(`[AiTraderMonitor] Bot ${bot.id.slice(0, 8)}: wallet has no agentPublicKey — cannot monitor live position`);
    return;
  }
  // WO-7.1: all reads target the bot's own account (sub pubkey when
  // provisioned); adapter subaccountId stays undefined.
  const agentPublicKey = liveReadAccount(bot, wallet.agentPublicKey);
  const subaccountId = undefined;

  let positions: ProtocolPosition[];
  try {
    positions = await adapter.getPositions(agentPublicKey, subaccountId);
  } catch (err) {
    // NEVER treat a read failure as "position closed" (fail-open trap).
    console.warn(`[AiTraderMonitor] Bot ${bot.id.slice(0, 8)}: getPositions failed (${err instanceof Error ? err.message : err}) — skipping cycle`);
    return;
  }
  const position = matchPosition(positions, bot.market);

  if (!position) {
    await handleLiveClose(bot, view, adapter, agentPublicKey);
    return;
  }

  // G10 — bracket must stay resting. The minimal getOpenStopOrders shape can't
  // distinguish legs, so only a fully-EMPTY book counts as "missing".
  if (typeof adapter.getOpenStopOrders === "function" && typeof adapter.setTpSl === "function") {
    let stopOrders: Array<{ order_id: string; symbol: string }>;
    try {
      stopOrders = await adapter.getOpenStopOrders(agentPublicKey, subaccountId, bot.market);
    } catch (err) {
      console.warn(`[AiTraderMonitor] Bot ${bot.id.slice(0, 8)}: getOpenStopOrders failed (${err instanceof Error ? err.message : err}) — skipping bracket check`);
      stopOrders = [{ order_id: "unknown", symbol: bot.market }]; // read failure ≠ missing bracket
    }
    if (stopOrders.length === 0) {
      if (bracketReplaceAttempted.has(view.decision.id)) {
        await closeLivePositionAndPause(bot, view, adapter, {
          pauseReason: "bracket_failed",
          exitReason: "circuit_breaker",
          detail: "G10: bracket missing again after one re-place — position closed for safety",
        });
        return;
      }
      bracketReplaceAttempted.add(view.decision.id);
      console.warn(`[AiTraderMonitor] Bot ${bot.id.slice(0, 8)}: bracket MISSING — re-placing once (G10)`);
      const replaceRes = await withSigningContext(bot, (keyTrio) =>
        adapter.setTpSl!({
          ...keyTrio,
          internalSymbol: bot.market,
          stopLossPrice: view.stopLossPrice,
          takeProfitPrice: view.takeProfitPrice,
          subaccountId,
        })
      );
      let verified = false;
      if (replaceRes.ok && replaceRes.value.success) {
        try {
          const after = await adapter.getOpenStopOrders(agentPublicKey, subaccountId, bot.market);
          verified = after.length > 0;
        } catch {
          verified = false;
        }
      }
      if (!verified) {
        await closeLivePositionAndPause(bot, view, adapter, {
          pauseReason: "bracket_failed",
          exitReason: "circuit_breaker",
          detail: "G10: bracket re-place could not be verified — position closed for safety",
        });
        return;
      }
      console.log(`[AiTraderMonitor] Bot ${bot.id.slice(0, 8)}: bracket re-placed and verified (G10)`);
    }
  }

  // G7 — daily loss breaker with open-position MTM ('guarded' only).
  if (bot.riskProfile === "degen") return;
  const allocation = num(bot.allocatedUsdc) ?? 0;
  if (allocation <= 0) return;
  const dayStart = utcDayStartMs(Date.now());
  const recentClosed = await storage.getRecentClosedDecisions(bot.id, 60);
  const dailyRealized = recentClosed
    .filter((d) => d.closedAt && new Date(d.closedAt).getTime() >= dayStart)
    .reduce((sum, d) => sum + (num(d.realizedPnl) ?? 0), 0);
  const unrealized = Number.isFinite(position.unrealizedPnl) ? position.unrealizedPnl : 0;
  if (dailyRealized + unrealized <= -(DAILY_LOSS_BREAKER_PCT / 100) * allocation) {
    await closeLivePositionAndPause(bot, view, adapter, {
      pauseReason: "daily_loss_breaker",
      exitReason: "circuit_breaker",
      detail: `G7 daily-loss breaker: realized ${dailyRealized.toFixed(2)} + open MTM ${unrealized.toFixed(2)} breached −${DAILY_LOSS_BREAKER_PCT}% of allocation — force-flat`,
    });
  }
}

// --- Graduation -----------------------------------------------------------------------

/**
 * Evaluate §2e for a paper bot and persist a verdict change. Called after
 * every paper close (MTM 0 — just closed) and from the periodic sweep (which
 * passes live open-position MTM so a floating loss counts against drawdown).
 */
async function evaluateBotGraduation(bot: AiTraderBot, openPositionMtm: number): Promise<void> {
  if (!bot.paperMode || bot.graduationState !== "in_trial") return;
  const allocation = num(bot.allocatedUsdc);
  if (!allocation || allocation <= 0) return;
  const trialStartedAt = bot.trialStartedAt ? new Date(bot.trialStartedAt).getTime() : null;
  if (!trialStartedAt) return;

  const recentClosed = await storage.getRecentClosedDecisions(bot.id, 500);
  const trades: GraduationTradeRecord[] = recentClosed
    .filter((d) => d.closedAt && new Date(d.closedAt).getTime() >= trialStartedAt && num(d.realizedPnl) !== null)
    .map((d) => ({ closedAt: new Date(d.closedAt!).getTime(), netPnl: num(d.realizedPnl)! }));

  let result;
  try {
    result = evaluateGraduation({
      criteria: bot.graduationCriteria,
      trades,
      trialStartedAt,
      allocation,
      openPositionMtm,
    });
  } catch (err) {
    console.error(`[AiTraderMonitor] graduation evaluation failed for bot ${bot.id.slice(0, 8)}: ${err instanceof Error ? err.message : err}`);
    return;
  }

  if (result.verdict === "graduated") {
    await storage.updateAiTraderBot(bot.id, { graduationState: "graduated", graduatedAt: new Date() });
    console.log(`[AiTraderMonitor] Bot ${bot.id.slice(0, 8)} GRADUATED: ${result.tradeCount} trades, net ${result.netPnl.toFixed(2)}, PF ${Number.isFinite(result.profitFactor) ? result.profitFactor.toFixed(2) : "∞"}, maxDD ${result.maxDrawdownPct.toFixed(1)}%`);
    await sendTradeNotification(bot.walletAddress, {
      type: "ai_trader_graduation",
      botName: botLabel(bot),
      market: bot.market,
      pnl: result.netPnl,
      error: undefined,
      closeReason: `${result.tradeCount} trades, PF ${Number.isFinite(result.profitFactor) ? result.profitFactor.toFixed(2) : "∞"}, max drawdown ${result.maxDrawdownPct.toFixed(1)}%`,
    });
  } else if (result.verdict === "failed") {
    await storage.updateAiTraderBot(bot.id, { graduationState: "failed" });
    console.log(`[AiTraderMonitor] Bot ${bot.id.slice(0, 8)} paper trial FAILED: ${result.failures.join("; ")}`);
  }
  // 'in_trial' — nothing to persist.
}

/** Periodic sweep: catches period-elapsed verdicts even for bots that never trade. */
export async function runGraduationSweep(): Promise<void> {
  let bots: AiTraderBot[];
  try {
    bots = await storage.getActiveAiTraderBots();
  } catch (err) {
    console.error(`[AiTraderMonitor] graduation sweep: getActiveAiTraderBots failed: ${err instanceof Error ? err.message : err}`);
    return;
  }
  for (const bot of bots) {
    if (!bot.paperMode || bot.graduationState !== "in_trial") continue;
    try {
      let mtm = 0;
      if (bot.status === "open") {
        const decisions = await storage.getAiTraderDecisions(bot.id, 10);
        const view = parseOpenDecision(decisions);
        if (view && view.entryPrice !== null) {
          const adapter = getAdapter(bot.protocol);
          const price = await adapter.getPrice(bot.market);
          if (price !== null && Number.isFinite(price)) {
            const direction = view.side === "long" ? 1 : -1;
            mtm = (price - view.entryPrice) * view.sizeBase * direction;
          }
        }
      }
      await evaluateBotGraduation(bot, mtm);
    } catch (err) {
      console.error(`[AiTraderMonitor] graduation sweep failed for bot ${bot.id.slice(0, 8)}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

// --- Auto-next ------------------------------------------------------------------------

function clearAutoNext(botId: string): void {
  const t = autoNextTimers.get(botId);
  if (t) {
    clearTimeout(t);
    autoNextTimers.delete(botId);
  }
}

/** Schedule the next decision cycle at the next candle boundary (+2s settle). */
export function scheduleAutoNext(botId: string, timeframe: string): void {
  const tfMs = TIMEFRAME_MS[timeframe];
  if (!tfMs) return;
  clearAutoNext(botId);
  const now = Date.now();
  const delay = (Math.floor(now / tfMs) + 1) * tfMs - now + 2_000;
  const timer = setTimeout(() => {
    autoNextTimers.delete(botId);
    runAutoCycle(botId).catch((err) =>
      console.error(`[AiTraderMonitor] auto cycle crashed for bot ${botId.slice(0, 8)}: ${err instanceof Error ? err.message : err}`)
    );
  }, delay);
  // Don't hold the process open for a bot timer.
  if (typeof timer.unref === "function") timer.unref();
  autoNextTimers.set(botId, timer);
  console.log(`[AiTraderMonitor] auto-next scheduled for bot ${botId.slice(0, 8)} in ${Math.round(delay / 1000)}s`);
}

/**
 * One hands-off decision cycle. Re-validates EVERYTHING from a fresh DB row
 * (the schedule-time bot may be stale), checks G6 + the malfunction ceiling
 * BEFORE any LLM spend, and resolves the user's BYO LLM key from the restored
 * session UMK (unrestorable ⇒ pause 'reauth_required' + Telegram nudge).
 */
export async function runAutoCycle(botId: string): Promise<void> {
  const bot = await storage.getAiTraderBot(botId);
  if (!bot) return;
  if (bot.status !== "idle" || bot.mode !== "auto" || !bot.autoNext) return;

  let adapter: ProtocolAdapter;
  try {
    adapter = getAdapter(bot.protocol);
  } catch (err) {
    console.error(`[AiTraderMonitor] auto cycle: no adapter for '${bot.protocol}' — skipping`);
    return;
  }

  // Cheap gates BEFORE LLM spend (G6 + always-on ceiling).
  const recentClosed = await storage.getRecentClosedDecisions(bot.id, 60);
  const g6 = checkCooldownAndCaps(bot.timeframe, recentClosed, Date.now());
  if (!g6.ok) {
    // Log the skip — a silent reschedule here made cadence gaps undiagnosable.
    console.log(`[AiTraderMonitor] auto cycle: bot ${bot.id.slice(0, 8)} skipped (${g6.reason}): ${g6.detail}`);
    scheduleAutoNext(bot.id, bot.timeframe);
    return;
  }
  const dayStart = utcDayStartMs(Date.now());
  const closedToday = recentClosed.filter((d) => d.closedAt && new Date(d.closedAt).getTime() >= dayStart);
  if (closedToday.length >= MALFUNCTION_TRADES_PER_DAY) {
    await pauseBot(bot, "malfunction_ceiling", `closed ${closedToday.length} trades today (ceiling ${MALFUNCTION_TRADES_PER_DAY}) — pausing before next cycle`);
    return;
  }

  const wallet = await storage.getWallet(bot.walletAddress);
  if (!wallet?.agentPublicKey) {
    console.error(`[AiTraderMonitor] auto cycle: wallet has no agentPublicKey for bot ${bot.id.slice(0, 8)} — skipping`);
    scheduleAutoNext(bot.id, bot.timeframe);
    return;
  }

  // BYO LLM key: session UMK (auto-restored from storage), then V3 decrypt.
  if (!getSessionByWalletAddress(bot.walletAddress)?.session?.umk) {
    try {
      await restoreWalletSecurityFromStorage(bot.walletAddress);
    } catch (err) {
      console.warn(`[AiTraderMonitor] auto cycle: UMK restore threw: ${err instanceof Error ? err.message : err}`);
    }
  }
  const umk = getSessionByWalletAddress(bot.walletAddress)?.session?.umk;
  if (!umk) {
    await pauseBot(bot, "reauth_required", "session locked — reconnect your wallet in the app so the bot can keep trading hands-off");
    return;
  }
  const ciphertext = await storage.getWalletLlmApiKeyCiphertext(bot.walletAddress);
  if (!ciphertext) {
    await pauseBot(bot, "no_api_key", "no LLM API key on file — add an OpenRouter key in the app to resume");
    return;
  }
  // Same gate as the /analyze route: never send a non-catalog model (e.g. a
  // hand-inserted sentinel like 'manual/canary') to OpenRouter — it 400s every
  // candle. Pause with an honest reason instead of burning cycles.
  if (!isSelectableModel(bot.model)) {
    await pauseBot(bot, "unsupported_model", `model '${bot.model}' isn't available for AI analysis — recreate the bot with a supported model`);
    return;
  }
  let keyBuf: Buffer;
  try {
    keyBuf = decryptLlmApiKeyV3(umk, ciphertext, bot.walletAddress);
  } catch (err) {
    await pauseBot(bot, "reauth_required", "stored LLM API key could not be decrypted — reconnect your wallet and re-save the key");
    return;
  }

  try {
    const apiKey = keyBuf.toString("utf8");
    await storage.updateAiTraderBot(bot.id, { status: "analyzing" });

    const context = await buildMarketContext({
      market: bot.market,
      timeframe: bot.timeframe as AiTraderTimeframe,
      adapter,
      bot,
      recentDecisions: recentClosed.slice(0, 5),
      agentPublicKey: wallet.agentPublicKey,
    });
    if ("stale" in context) {
      // G9 — never decide on stale data; retry at the next boundary.
      console.warn(`[AiTraderMonitor] auto cycle: stale context for bot ${bot.id.slice(0, 8)} (${context.reason})`);
      await storage.updateAiTraderBot(bot.id, { status: "idle" });
      scheduleAutoNext(bot.id, bot.timeframe);
      return;
    }

    const decision = await runDecision({ bot, apiKey, context, adapter });
    if (!decision.ok || decision.rejected || !decision.clamped || (decision.clamped.action !== "long" && decision.clamped.action !== "short")) {
      // Malformed / guardrail-rejected / flat / close-with-no-position — all
      // clean no-trade cycles: back to idle, try again next candle.
      await storage.updateAiTraderBot(bot.id, { status: "idle" });
      scheduleAutoNext(bot.id, bot.timeframe);
      return;
    }

    const markPrice = num(context.contextDigest.price);
    const exec = await executeDecision({
      bot: { ...bot, status: "analyzing" },
      decisionId: decision.decisionId,
      clamped: decision.clamped,
      adapter,
      markPrice: markPrice ?? NaN,
    });
    if (!exec.ok) {
      // The executor writes terminal statuses (idle/paused) on its abort paths;
      // for result-only rejections make sure the bot isn't stranded in 'analyzing'.
      const fresh = await storage.getAiTraderBot(bot.id);
      if (fresh?.status === "analyzing") {
        await storage.updateAiTraderBot(bot.id, { status: "idle" });
      }
      console.warn(`[AiTraderMonitor] auto cycle: entry not executed for bot ${bot.id.slice(0, 8)}: ${exec.reason} — ${exec.detail}`);
      const after = await storage.getAiTraderBot(bot.id);
      if (after && after.status === "idle" && after.autoNext && after.mode === "auto") {
        scheduleAutoNext(bot.id, bot.timeframe);
      }
      return;
    }
    console.log(`[AiTraderMonitor] auto cycle: bot ${bot.id.slice(0, 8)} entered ${decision.clamped.action} ${bot.market} (${exec.mode})`);
    // Position now open — the 15s loop takes over; next auto cycle fires after the close.
  } finally {
    keyBuf.fill(0);
  }
}

// --- Startup reconciliation --------------------------------------------------------------

async function markUnfinishedDecisionsCrashed(botId: string): Promise<void> {
  const decisions = await storage.getAiTraderDecisions(botId, 10);
  for (const d of decisions) {
    if (!d.outcome && !d.closedAt) {
      await storage.updateAiTraderDecision(d.id, { outcome: "aborted_crash" });
    }
  }
}

/**
 * Resolve one bot's crash-marker status against reality. Returns true when
 * resolved (false ⇒ venue read failed; caller keeps it pending for retry).
 */
export async function reconcileBotOnStartup(bot: AiTraderBot): Promise<boolean> {
  const preOpen = bot.status === "executing" || bot.status === "analyzing" || bot.status === "proposed";
  if (!preOpen && bot.status !== "open") return true;

  // Paper bots hold no venue position: pre-open crash markers reset cleanly;
  // 'open' paper bots are handled by the normal tick (candle close detection).
  if (bot.paperMode) {
    if (preOpen) {
      await markUnfinishedDecisionsCrashed(bot.id);
      await storage.updateAiTraderBot(bot.id, { status: "idle" });
      console.log(`[AiTraderMonitor] reconcile: paper bot ${bot.id.slice(0, 8)} '${bot.status}' → idle (aborted_crash)`);
    }
    return true;
  }

  const adapter = getAdapter(bot.protocol);
  const wallet = await storage.getWallet(bot.walletAddress);
  if (!wallet?.agentPublicKey) {
    console.error(`[AiTraderMonitor] reconcile: bot ${bot.id.slice(0, 8)} wallet has no agentPublicKey`);
    return false;
  }
  // WO-7.1: reads target the bot's own account (sub pubkey when provisioned).
  const readAccount = liveReadAccount(bot, wallet.agentPublicKey);
  const subaccountId = undefined;

  let positions: ProtocolPosition[];
  try {
    positions = await adapter.getPositions(readAccount, subaccountId);
  } catch (err) {
    console.warn(`[AiTraderMonitor] reconcile: getPositions failed for bot ${bot.id.slice(0, 8)} (${err instanceof Error ? err.message : err}) — will retry`);
    return false;
  }
  const position = matchPosition(positions, bot.market);

  if (!position) {
    if (preOpen) {
      // Provably flat: the crash happened before (or the order never filled).
      await markUnfinishedDecisionsCrashed(bot.id);
      await storage.updateAiTraderBot(bot.id, { status: "idle" });
      console.log(`[AiTraderMonitor] reconcile: live bot ${bot.id.slice(0, 8)} '${bot.status}' flat → idle (aborted_crash)`);
      return true;
    }
    // status 'open' but no position — the close happened while we were down.
    const decisions = await storage.getAiTraderDecisions(bot.id, 10);
    const view = parseOpenDecision(decisions);
    if (!view) {
      await storage.updateAiTraderBot(bot.id, { status: "idle" });
      return true;
    }
    await handleLiveClose(bot, view, adapter, wallet.agentPublicKey);
    return true;
  }

  // Position EXISTS. Find the decision that carries its bracket.
  const decisions = await storage.getAiTraderDecisions(bot.id, 10);
  const executedView = parseOpenDecision(decisions);
  const pendingRow = decisions.find((d) => !d.outcome && !d.closedAt);
  const pendingView = pendingRow ? parseOpenDecision([{ ...pendingRow, outcome: "executed" }]) : null;
  const view = executedView ?? pendingView;

  if (!view) {
    // A live position we cannot attribute to any decision: fail closed — flatten.
    console.error(`[AiTraderMonitor] reconcile: bot ${bot.id.slice(0, 8)} holds a position with NO usable decision row — closing for safety`);
    const fallbackView: OpenDecisionView = {
      decision: { id: `unknown-${bot.id}` } as AiTraderDecision,
      side: position.baseSize > 0 ? "long" : "short",
      sizeBase: Math.abs(position.baseSize),
      marginUsdc: 0,
      stopLossPrice: 0,
      takeProfitPrice: 0,
      entryPrice: position.entryPrice,
      decidedAtMs: Date.now(),
    };
    const res = await withSigningContext(bot, (keyTrio) =>
      adapter.closePosition({ ...keyTrio, internalSymbol: bot.market, subaccountId: undefined, maxSlippagePct: PROTECTIVE_CLOSE_MAX_SLIPPAGE_PCT })
    );
    await storage.updateAiTraderBot(bot.id, { status: "paused", pauseReason: "reconcile_orphan_position" });
    await sendTradeNotification(bot.walletAddress, {
      type: "trade_failed",
      botName: botLabel(bot),
      market: bot.market,
      error: res.ok && res.value.success
        ? "Recovered from a crash: an untracked position was closed and the bot paused."
        : "Recovered from a crash: an untracked position was found and COULD NOT be closed — check the venue.",
    });
    return true;
  }

  // Complete the bracket (the crash may have hit between order and setTpSl).
  if (typeof adapter.setTpSl !== "function" || typeof adapter.getOpenStopOrders !== "function") {
    await closeLivePositionAndPause(bot, view, adapter, {
      pauseReason: "bracket_failed",
      exitReason: "circuit_breaker",
      detail: "reconcile: adapter cannot guarantee a bracket (G10) — position closed",
    });
    return true;
  }
  let bracketOk = false;
  try {
    const resting = await adapter.getOpenStopOrders(readAccount, subaccountId, bot.market);
    bracketOk = resting.length > 0;
  } catch {
    bracketOk = false;
  }
  if (!bracketOk) {
    const placed = await withSigningContext(bot, (keyTrio) =>
      adapter.setTpSl!({
        ...keyTrio,
        internalSymbol: bot.market,
        stopLossPrice: view.stopLossPrice,
        takeProfitPrice: view.takeProfitPrice,
        subaccountId,
      })
    );
    let verified = false;
    if (placed.ok && placed.value.success) {
      try {
        const after = await adapter.getOpenStopOrders(readAccount, subaccountId, bot.market);
        verified = after.length > 0;
      } catch {
        verified = false;
      }
    }
    if (!verified) {
      await closeLivePositionAndPause(bot, view, adapter, {
        pauseReason: "bracket_failed",
        exitReason: "circuit_breaker",
        detail: "reconcile: could not restore the bracket after a crash — position closed for safety (G10)",
      });
      return true;
    }
  }

  // Bracket confirmed: promote the decision + bot to a clean 'open' state.
  await storage.updateAiTraderDecision(view.decision.id, {
    outcome: "executed",
    entryPrice: (view.entryPrice ?? position.entryPrice).toFixed(8),
  });
  await storage.updateAiTraderBot(bot.id, { status: "open", pauseReason: null });
  console.log(`[AiTraderMonitor] reconcile: live bot ${bot.id.slice(0, 8)} '${bot.status}' → open (position + bracket verified)`);
  return true;
}

export async function reconcileOnStartup(): Promise<void> {
  let bots: AiTraderBot[];
  try {
    bots = await storage.getActiveAiTraderBots();
  } catch (err) {
    console.error(`[AiTraderMonitor] startup reconciliation: getActiveAiTraderBots failed: ${err instanceof Error ? err.message : err}`);
    return;
  }
  for (const bot of bots) {
    try {
      const resolved = await reconcileBotOnStartup(bot);
      if (!resolved) pendingReconciliation.add(bot.id);
    } catch (err) {
      console.error(`[AiTraderMonitor] startup reconciliation failed for bot ${bot.id.slice(0, 8)}: ${err instanceof Error ? err.message : err}`);
      pendingReconciliation.add(bot.id);
    }
  }
  if (pendingReconciliation.size > 0) {
    console.warn(`[AiTraderMonitor] ${pendingReconciliation.size} bot(s) pending reconciliation retry`);
  }
  // Auto-next must survive restarts: scheduleAutoNext is otherwise only armed
  // from afterClose / runAutoCycle retry paths, so a deploy would silently
  // halt every hands-off bot until its next manual close. Scheduling is safe
  // to over-apply — runAutoCycle re-reads the bot and gates on
  // idle + mode:'auto' + autoNext before doing anything.
  for (const bot of bots) {
    if (bot.mode === "auto" && bot.autoNext && bot.status !== "paused") {
      scheduleAutoNext(bot.id, bot.timeframe);
    }
  }
}

// --- Tick loop -----------------------------------------------------------------------

/** One monitoring pass for a single bot (exported for tests). */
export async function monitorBotOnce(bot: AiTraderBot): Promise<void> {
  if (bot.status !== "open") return;
  const decisions = await storage.getAiTraderDecisions(bot.id, 10);
  const view = parseOpenDecision(decisions);
  if (!view) {
    // 'open' with no open decision row is inconsistent — self-heal to idle
    // for paper (no venue position can exist); for live bots run reconciliation
    // (which fails closed on an untracked position).
    console.warn(`[AiTraderMonitor] Bot ${bot.id.slice(0, 8)}: status 'open' but no open decision row — self-healing`);
    if (bot.paperMode) {
      await storage.updateAiTraderBot(bot.id, { status: "idle" });
    } else {
      const resolved = await reconcileBotOnStartup(bot);
      if (!resolved) pendingReconciliation.add(bot.id);
    }
    return;
  }
  if (bot.paperMode) {
    await monitorPaperBot(bot, view);
  } else {
    await monitorLiveBot(bot, view);
  }
}

async function tick(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    // Bounded retry-with-backoff: a single stale connection eviction should not
    // kill the whole tick.  After the first failure the pool drops the dead
    // connection; the retry lands on a fresh one (or the next open slot).
    let bots: AiTraderBot[] | undefined;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        bots = await storage.getActiveAiTraderBots();
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) await sleep(1_500);
      }
    }
    if (lastErr !== undefined || bots === undefined) {
      console.error(`[AiTraderMonitor] tick: getActiveAiTraderBots failed (3 attempts): ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
      return;
    }
    for (const bot of bots) {
      if (botInFlight.has(bot.id)) continue;
      botInFlight.add(bot.id);
      try {
        if (pendingReconciliation.has(bot.id)) {
          const resolved = await reconcileBotOnStartup(bot);
          if (resolved) pendingReconciliation.delete(bot.id);
          continue;
        }
        await monitorBotOnce(bot);
      } catch (err) {
        console.error(`[AiTraderMonitor] tick failed for bot ${bot.id.slice(0, 8)}: ${err instanceof Error ? err.message : err}`);
      } finally {
        botInFlight.delete(bot.id);
      }
    }
  } finally {
    tickInFlight = false;
  }
}

// --- Decision compression sweep ------------------------------------------------------

async function runDecisionCompressionSweep(): Promise<void> {
  let total = 0;
  const MAX_ITER = 20;
  for (let i = 0; i < MAX_ITER; i++) {
    const n = await storage.compressOldAiTraderDecisions(30, 500);
    total += n;
    if (n === 0) break;
    // Brief pause between batches so 20 consecutive 500-row UPDATEs don't
    // exhaust the pool while other background processes also need connections.
    if (i < MAX_ITER - 1) await sleep(150);
  }
  if (total > 0) {
    console.log(`[AiTraderMonitor] compression sweep: thinned ${total} old decision rows`);
  }
}

// --- Lifecycle -----------------------------------------------------------------------

export function startAiTraderMonitor(): void {
  if (tickTimer) return; // singleton
  console.log("[AiTraderMonitor] starting (15s tick + graduation sweep)");
  reconcileOnStartup()
    .catch((err) => console.error(`[AiTraderMonitor] startup reconciliation crashed: ${err instanceof Error ? err.message : err}`))
    .finally(() => {
      // Graduation sweep once on boot (catches period-elapsed during downtime).
      runGraduationSweep().catch((err) =>
        console.error(`[AiTraderMonitor] boot graduation sweep crashed: ${err instanceof Error ? err.message : err}`)
      );
      // Compression sweep deferred by one tick so it never competes with both
      // reconcileOnStartup AND the first tick simultaneously at boot.
      setTimeout(() => {
        runDecisionCompressionSweep().catch((err) =>
          console.error(`[AiTraderMonitor] boot compression sweep crashed: ${err instanceof Error ? err.message : err}`)
        );
      }, MONITOR_TICK_MS);
    });
  tickTimer = setInterval(() => {
    tick().catch((err) => console.error(`[AiTraderMonitor] tick crashed: ${err instanceof Error ? err.message : err}`));
  }, MONITOR_TICK_MS);
  sweepTimer = setInterval(() => {
    runGraduationSweep().catch((err) =>
      console.error(`[AiTraderMonitor] graduation sweep crashed: ${err instanceof Error ? err.message : err}`)
    );
    runDecisionCompressionSweep().catch((err) =>
      console.error(`[AiTraderMonitor] compression sweep crashed: ${err instanceof Error ? err.message : err}`)
    );
  }, DAILY_SWEEP_MS);
  tickTimer.unref?.();
  sweepTimer.unref?.();
}

/** Test/shutdown helper: stop timers and clear in-memory state. */
export function stopAiTraderMonitor(): void {
  if (tickTimer) clearInterval(tickTimer);
  if (sweepTimer) clearInterval(sweepTimer);
  tickTimer = null;
  sweepTimer = null;
  tickInFlight = false;
  for (const t of autoNextTimers.values()) clearTimeout(t);
  autoNextTimers.clear();
  pendingReconciliation.clear();
  bracketReplaceAttempted.clear();
  botInFlight.clear();
  // Stop the market scanner (shadow-mode; no trading) in lockstep with the monitor
  // so tests and server shutdown always tear down both subsystems together.
  import("./scanner.js").then(({ stopScanner }) => stopScanner()).catch(() => {});
}

/** Exported for tests: run one full tick synchronously. */
export async function runMonitorTickOnce(): Promise<void> {
  await tick();
}
