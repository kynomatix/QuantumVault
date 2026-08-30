// Agentic Trader Plan Part B, WO-5 — the execution layer. Takes a guardrail-
// clamped entry decision (WO-4 output, already persisted as a decision row) and
// either executes it live on the bot's venue or records a hypothetical paper
// fill. This module NEVER re-derives trade parameters — it executes exactly the
// ClampedDecision it is given, or refuses.
//
// Live-path ordering is binding (plan WO-5 steps 1–7):
//   1. Policy HMAC (G15) + cooldown/trade-count (G6)
//   2. Funding check (G11)
//   3. status='executing' persisted BEFORE any order (crash marker, Qwen #1)
//      → setLeverage → placeMarketOrder
//   4. Confirm position (getPositions, retry 3× / 2s)
//   5. Bracket via the StopPolicy seam (MVP: 'static' → adapter.setTpSl)
//   6. Verify bracket (G10) via getOpenStopOrders; any failure in 5–6 ⇒
//      closePosition at market + pause ('bracket_failed') + Telegram + record
//   7. Decision row entryPrice from fill, bot status 'open'
//
// Decision `outcome` values written here beyond the WO-2 schema-comment enum
// (text column; additions documented here and in the schema comment's spirit):
//   'aborted_policy'  — G15 policy-HMAC mismatch (bot paused, nothing sent)
//   'aborted_order'   — entry order rejected/failed before any confirmed position
// A bracket-failure emergency close records outcome='executed' with
// exitReason='bracket_failed' — the entry DID execute; the exit reason says why
// it was immediately closed.
import { storage } from "../storage";
import { getUmkForWebhook, decryptAgentKeyStrict, verifyBotPolicyHmac, healExecutionUmkFromStorage } from "../session-v3";
import { resolveAiTraderSubaccountSigner } from "./signing";
import { sendTradeNotification } from "../notification-service";
import type { AiTraderBot, AiTraderDecision } from "@shared/schema";
import {
  builderAttachmentFromFeeQuote,
  validateFeeRateQuote,
  type ProtocolAdapter,
} from "../protocol/adapter";
import { isUnconfirmedLandingResult } from "../protocol/tx-verdicts";
import {
  applyGuardrails,
  type ClampedDecision,
  type GuardrailTimeframe,
  type TradeDecisionLike,
} from "./guardrails";
import { paperEntryPrice, type PaperSide } from "./paper-math";
import { isTerminalCloseResult } from "./close-truth";
import { isAiTraderMarketAdmitted, SCANNER_MARKET_UNADMITTED_REASON } from "./market-admission";
import { SCANNER_CAPABILITIES } from "./scanner-capabilities";
import {
  AI_TRADER_PROPOSAL_EXPIRY_MS,
  evaluateAiTraderStateAuthority,
  type AiTraderAuthoritySource,
} from "./state-authority";
import type { BuilderAttachmentPolicy, OrderResult } from "../protocol/protocol-types";
import { appendTelemetry } from "../telemetry";
import {
  appendExecutionEvents,
  appendRequiredEntryPrebroadcast,
  entryAttemptId,
  journalBase,
  newMutationAttemptId,
  orderResultEvent,
  safeAppendExecutionEvents,
  type JournalEventInput,
} from "./execution-journal";
import {
  protectiveReadNeedsTelemetry,
  verifyLiveProtectiveStop,
  type LiveProtectiveStopProof,
} from "./bracket-verification";

// --- G6 cadence rules (mirror of context-builder's advisory echo; THIS is the
// enforcement point). Module-private there, so the values are pinned here too —
// a drift between the two only ever makes the echo wrong, never the enforcement.
const TIMEFRAME_MS: Record<string, number> = {
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};
const LTF_TIMEFRAMES = new Set(["15m", "1h"]);
const MAX_TRADES_PER_DAY_LTF = 6;
const MAX_TRADES_PER_DAY_HTF = 2;

/** Entry-order slippage bound (plan WO-5 step 3, binding). */
export const ENTRY_MAX_SLIPPAGE_PCT = 0.5;
/** Definitional mirror of decide.ts: fees are retained for accounting, never entry admission. */
const NON_ADMISSION_TAKER_FEE_RATE = 0;
/** Position-confirmation retries (plan WO-5 step 4: 3× / 2s). */
const POSITION_CONFIRM_ATTEMPTS = 3;
const POSITION_CONFIRM_DELAY_MS = 2_000;
/** G10 bracket-verification retries (~5s window). */
const BRACKET_VERIFY_ATTEMPTS = 3;
const BRACKET_VERIFY_DELAY_MS = 2_500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The G15 policy object for an AI Trader bot, single-sourced so the WO-7
 * creation route (computeBotPolicyHmac) and this executor (verifyBotPolicyHmac)
 * can never drift: market + max leverage + allocated collateral are the fields
 * a DB-tamperer would edit to make a bot trade bigger than the user authorized.
 */
export function aiTraderPolicyObject(bot: Pick<AiTraderBot, "market" | "maxLeverage" | "allocatedUsdc">): {
  market: string;
  leverage: number;
  maxPositionSize: string | null;
} {
  return { market: bot.market, leverage: bot.maxLeverage, maxPositionSize: bot.allocatedUsdc };
}

export type ExecuteFailureReason =
  | "not_entry"            // clamped.action is not long/short — nothing to execute
  | "invalid_clamp"        // ClampedDecision missing required numeric fields
  | "cooldown_active"      // G6: one-candle cooldown since last close not elapsed
  | "daily_cap_reached"    // G6: LTF 6 / HTF 2 trades already closed today (UTC)
  | "scanner_market_unadmitted" // scanner-source bot's exact market is absent from the AI Trader registry
  | "capability_missing"   // adapter lacks setTpSl/getOpenStopOrders — G10 unverifiable, refuse BEFORE entry
  | "auth_unavailable"     // wallet envelope/UMK/agent-key unavailable (execution disabled, e-stop, decrypt fail)
  | "policy_hmac_mismatch" // G15: bot row fails HMAC — paused, nothing sent
  | "scanner_live_execution_disabled" // scanner-source live entry capability is off for this process
  | "insufficient_funding" // G11: free collateral below required margin
  | "execution_identity_changed" // wallet execution account changed across the live-entry TOCTOU seam
  | "execution_revalidation_failed" // fresh venue-price read or repeated guardrail validation refused live entry
  | "journal_unavailable"  // required pre-broadcast evidence failed; no entry sent
  | "bot_busy"             // bot already holds (or may hold) a position — refuse to stack a second entry
  | "order_failed"         // entry order rejected/failed, no position confirmed
  | "position_unconfirmed" // order accepted but position never appeared — emergency close attempted, bot paused
  | "bracket_failed"       // setTpSl or G10 verification failed — position closed at market, bot paused
  | "invalid_mark";        // paper path: no usable mark price

export type ExecuteDecisionResult =
  | { ok: true; mode: "paper" | "live"; entryPrice: number }
  | { ok: false; reason: ExecuteFailureReason; detail: string };

export interface ExecuteDecisionInput {
  bot: AiTraderBot;
  /** The already-persisted aiTraderDecisions row id (WO-4 wrote it). */
  decisionId: string;
  clamped: ClampedDecision;
  adapter: ProtocolAdapter;
  /**
   * Mark price from the decision context (contextDigest.price). Paper entries
   * fill from this; the live path only sanity-logs it (live fills come from
   * the venue).
   */
  markPrice: number;
  /**
   * Distinguishes a user-owned proposal from the exact internal analysis claim.
   * Legacy callers that omit it are treated as external and therefore cannot
   * bypass the required durable `proposed` state.
   */
  authoritySource?: Extract<AiTraderAuthoritySource, "external_http" | "internal_cycle">;
}

function executionAuthoritySource(input: ExecuteDecisionInput): Extract<AiTraderAuthoritySource, "external_http" | "internal_cycle"> {
  return input.authoritySource ?? "external_http";
}

const NON_RACE_GUARD_REASONS = new Set<ExecuteFailureReason>([
  "bot_busy",
  "cooldown_active",
  "daily_cap_reached",
  "execution_identity_changed",
  "execution_revalidation_failed",
  "capability_missing",
  "auth_unavailable",
  "invalid_clamp",
  "invalid_mark",
  "not_entry",
  "scanner_market_unadmitted",
  "scanner_live_execution_disabled",
  "insufficient_funding",
]);

type StoredEntryClamp = ClampedDecision & Required<Pick<
  ClampedDecision,
  "leverage" | "marginUsdc" | "notionalUsdc" | "sizeBase" | "stopLossPrice" | "takeProfitPrice"
>>;

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function storedEntryClamp(value: unknown, side: PaperSide): StoredEntryClamp | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as ClampedDecision;
  if (candidate.action !== side
      || !finitePositive(candidate.leverage)
      || !finitePositive(candidate.marginUsdc)
      || !finitePositive(candidate.notionalUsdc)
      || !finitePositive(candidate.sizeBase)
      || !finitePositive(candidate.stopLossPrice)
      || !finitePositive(candidate.takeProfitPrice)) return null;
  return candidate as StoredEntryClamp;
}

function storedEntryDecision(value: unknown, side: PaperSide): TradeDecisionLike | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as TradeDecisionLike;
  if (candidate.action !== side
      || !Number.isFinite(candidate.confidence)
      || typeof candidate.invalidation !== "string"
      || typeof candidate.rationale !== "string") return null;
  return candidate;
}

async function unwindRejectedInternalDecision(
  input: ExecuteDecisionInput,
  result: Extract<ExecuteDecisionResult, { ok: false }>,
): Promise<Extract<ExecuteDecisionResult, { ok: false }>> {
  if (executionAuthoritySource(input) === "internal_cycle" && NON_RACE_GUARD_REASONS.has(result.reason)) {
    await storage.transitionAiTraderState({
      botId: input.bot.id,
      expectedStatus: "analyzing",
      expectedPauseReason: null,
      nextStatus: "idle",
      nextPauseReason: null,
      decisionId: input.decisionId,
      expectedDecisionOutcome: null,
      decisionOutcome: "aborted_guard",
    });
  }
  return result;
}

async function claimExecution(input: ExecuteDecisionInput): Promise<AiTraderBot | null> {
  const freshBot = await storage.getAiTraderBot(input.bot.id);
  if (!freshBot) return null;
  const authoritySource = executionAuthoritySource(input);
  // The storage claim below re-reads and proves exact-one unresolved decision
  // identity transactionally. This pure preflight cannot grant authority.
  const decision = {
    id: input.decisionId,
    botId: input.bot.id,
    outcome: null,
    decidedAtMs: Date.now(),
  };
  const verdict = evaluateAiTraderStateAuthority({
    action: "execute",
    source: authoritySource,
    bot: freshBot,
    requestedDecisionId: input.decisionId,
    decision,
    unresolvedDecisionCount: 1,
    positionTruth: "flat",
    internalAnalysisClaimHeld: authoritySource === "internal_cycle",
    nowMs: Date.now(),
    proposalExpiryMs: AI_TRADER_PROPOSAL_EXPIRY_MS,
  });
  if (!verdict.allowed) return null;
  const claimed = await storage.claimAiTraderExecution({
    botId: input.bot.id,
    decisionId: input.decisionId,
    expectedStatus: authoritySource === "external_http" ? "proposed" : "analyzing",
    now: new Date(),
    expiryMs: AI_TRADER_PROPOSAL_EXPIRY_MS,
  });
  return claimed?.bot ?? null;
}

/** G6 check result, exported pure for tests. Mirrors context-builder's advisory math. */
export function checkCooldownAndCaps(
  timeframe: string,
  closedDecisions: Pick<AiTraderDecision, "closedAt">[],
  now: number
): { ok: true } | { ok: false; reason: "cooldown_active" | "daily_cap_reached"; detail: string } {
  const tfMs = TIMEFRAME_MS[timeframe];
  if (!tfMs) {
    // Unknown timeframe: fail closed to the strictest cadence rather than skipping G6.
    return { ok: false, reason: "cooldown_active", detail: `unknown timeframe '${timeframe}' — G6 cannot be evaluated, refusing` };
  }
  const closedTimes = closedDecisions
    .filter((d) => d.closedAt)
    .map((d) => new Date(d.closedAt as Date).getTime())
    .filter((t) => Number.isFinite(t));
  const lastClosedAt = closedTimes.length > 0 ? Math.max(...closedTimes) : null;
  if (lastClosedAt !== null && now - lastClosedAt < tfMs) {
    const remainMs = tfMs - (now - lastClosedAt);
    return {
      ok: false,
      reason: "cooldown_active",
      detail: `G6 cooldown: ${Math.ceil(remainMs / 60_000)}m remaining (one ${timeframe} candle since last close)`,
    };
  }
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const tradesToday = closedTimes.filter((t) => t >= startOfDay.getTime()).length;
  const cap = LTF_TIMEFRAMES.has(timeframe) ? MAX_TRADES_PER_DAY_LTF : MAX_TRADES_PER_DAY_HTF;
  if (tradesToday >= cap) {
    return {
      ok: false,
      reason: "daily_cap_reached",
      detail: `G6 daily cap: ${tradesToday}/${cap} trades already closed today (${LTF_TIMEFRAMES.has(timeframe) ? "LTF" : "HTF"})`,
    };
  }
  return { ok: true };
}

/**
 * Execute a clamped ENTRY decision (action long/short). 'flat' records nothing
 * here (WO-4 already recorded outcome='flat'); 'close' exits are the WO-6
 * monitor's / WO-7 route's job — this module only opens bracket-protected
 * positions.
 */
export async function executeDecision(input: ExecuteDecisionInput): Promise<ExecuteDecisionResult> {
  const { bot, decisionId, clamped } = input;

  if (clamped.action !== "long" && clamped.action !== "short") {
    return unwindRejectedInternalDecision(input, { ok: false, reason: "not_entry", detail: `action '${clamped.action}' is not an entry` });
  }
  if (
    !bot.paperMode &&
    bot.marketSource === "scanner" &&
    !SCANNER_CAPABILITIES.liveExecutionEnabled
  ) {
    return unwindRejectedInternalDecision(input, {
      ok: false,
      reason: "scanner_live_execution_disabled",
      detail: "Live execution for scanner-source bots is disabled for this process.",
    });
  }
  const side: PaperSide = clamped.action;
  const { sizeBase, marginUsdc, leverage, stopLossPrice, takeProfitPrice } = clamped;
  if (
    !Number.isFinite(sizeBase) || (sizeBase as number) <= 0 ||
    !Number.isFinite(marginUsdc) || (marginUsdc as number) <= 0 ||
    !Number.isFinite(leverage) || (leverage as number) < 1 ||
    !Number.isFinite(stopLossPrice) || (stopLossPrice as number) <= 0 ||
    !Number.isFinite(takeProfitPrice) || (takeProfitPrice as number) <= 0
  ) {
    return unwindRejectedInternalDecision(input, {
      ok: false,
      reason: "invalid_clamp",
      detail: "ClampedDecision missing/invalid sizeBase, marginUsdc, leverage, stopLossPrice or takeProfitPrice",
    });
  }

  // Already-open guard (architect, WO-5 review): a retried or mis-orchestrated
  // call against a bot that holds (or MAY hold — 'executing' is the crash
  // marker) a position must never stack a second market order on top of it.
  // G6 only counts CLOSED decisions, so it cannot catch this. Checked against
  // BOTH the caller's snapshot AND a fresh DB read: callers legitimately force
  // status 'analyzing' on the snapshot, so the fresh read is what catches an
  // 'executing'/'open' row written by a concurrent or crashed pass.
  const freshBot = await storage.getAiTraderBot(bot.id);
  if (!freshBot) {
    return {
      ok: false,
      reason: "bot_busy",
      detail: "bot row missing on fresh re-read — refusing a new entry",
    };
  }
  if (
    (bot.marketSource === "scanner" || freshBot.marketSource === "scanner")
    && !isAiTraderMarketAdmitted(bot.market)
  ) {
    return unwindRejectedInternalDecision(input, {
      ok: false,
      reason: SCANNER_MARKET_UNADMITTED_REASON,
      detail: "scanner-source market '" + bot.market + "' is not admitted by the exact AI Trader market registry",
    });
  }
  const expectedAuthorityStatus = executionAuthoritySource(input) === "external_http" ? "proposed" : "analyzing";
  const busyStatus = freshBot.status !== expectedAuthorityStatus ? freshBot.status : null;
  if (busyStatus) {
    return {
      ok: false,
      reason: "bot_busy",
      detail: `bot status '${busyStatus}' — refusing a new entry while a position is (or may be) open`,
    };
  }

  // G6 — enforced on BOTH paths: the paper record feeds graduation, so paper
  // must obey the same cadence it will be held to live.
  const recentClosed = await storage.getRecentClosedDecisions(bot.id, 30);
  const g6 = checkCooldownAndCaps(bot.timeframe, recentClosed, Date.now());
  if (!g6.ok) return unwindRejectedInternalDecision(input, { ok: false, reason: g6.reason, detail: g6.detail });

  // Preserve the existing live bracket-capability refusal ahead of any wallet
  // or retained fee-context read. It is a structural property of the adapter.
  if (
    !bot.paperMode &&
    (typeof input.adapter.setTpSl !== "function" || typeof input.adapter.getOpenStopOrders !== "function")
  ) {
    return unwindRejectedInternalDecision(input, {
      ok: false,
      reason: "capability_missing",
      detail: `adapter for protocol '${bot.protocol}' lacks setTpSl/getOpenStopOrders — G10 bracket guarantee unenforceable`,
    });
  }

  // Paper entries move no funds. Fee truth is retained on the decision for
  // later accounting, but missing fee context never blocks the atomic paper
  // entry. The close path records null fee/net-PnL when no truthful rate exists.
  if (bot.paperMode) {
    const result = await executePaperEntry(input, side);
    return result.ok ? result : unwindRejectedInternalDecision(input, result);
  }

  // Live entries retain the quote only to recover an explicitly validated
  // builder attach/suppress policy. If it is unavailable or invalid, suppress
  // the optional builder attachment and continue; never fabricate a fee rate.
  const [persistedDecision, wallet] = await Promise.all([
    storage.getAiTraderDecision(decisionId),
    storage.getWallet(bot.walletAddress),
  ]);
  if (typeof wallet?.agentPublicKey !== "string" || wallet.agentPublicKey.length === 0) {
    return unwindRejectedInternalDecision(input, {
      ok: false,
      reason: "auth_unavailable",
      detail: "wallet missing the execution account required for live entry",
    });
  }
  const digest = persistedDecision?.contextDigest as Record<string, any> | null | undefined;
  const persistedRawDecision = storedEntryDecision(persistedDecision?.rawDecision, side);
  const persistedClampedDecision = storedEntryClamp(persistedDecision?.clampedDecision, side);
  if (persistedDecision?.id !== decisionId
      || persistedDecision.botId !== bot.id
      || !digest
      || !persistedRawDecision
      || !persistedClampedDecision) {
    return unwindRejectedInternalDecision(input, {
      ok: false,
      reason: "invalid_clamp",
      detail: "persisted live decision is missing its exact raw/clamped/context identity",
    });
  }
  const retainedIdentity = digest?.feeRateIdentity as Record<string, unknown> | null | undefined;
  const expectedSubaccountId = bot.protocolSubaccountId ?? null;
  const retainedIdentityMatchesBot =
    persistedDecision?.id === decisionId &&
    persistedDecision?.botId === bot.id &&
    retainedIdentity?.protocol === bot.protocol &&
    retainedIdentity?.account === wallet.agentPublicKey &&
    retainedIdentity?.subaccountId === expectedSubaccountId &&
    retainedIdentity?.liquidityRole === "taker";
  const feeRateQuote = retainedIdentityMatchesBot
    ? validateFeeRateQuote(
        digest?.feeRateQuote,
        {
          protocol: bot.protocol,
          account: wallet.agentPublicKey as string,
          subaccountId: expectedSubaccountId,
          liquidityRole: "taker",
        },
        { now: Date.now() },
      )
    : { availability: "unavailable" as const, reason: "identity_mismatch" as const };
  const builderAttachment: BuilderAttachmentPolicy = feeRateQuote.availability === "available"
    ? builderAttachmentFromFeeQuote(feeRateQuote)
    : { mode: "suppress" };

  const liveJournalObservedAt = persistedDecision?.decidedAt
    ? new Date(persistedDecision.decidedAt)
    : null;
  if (!bot.paperMode && (!liveJournalObservedAt || !Number.isFinite(liveJournalObservedAt.getTime()))) {
    return unwindRejectedInternalDecision(input, {
      ok: false,
      reason: "bot_busy",
      detail: "persisted live decision has no finite decidedAt identity anchor",
    });
  }

  const result = await executeLiveEntry(input, side, {
    sizeBase: sizeBase as number,
    marginUsdc: marginUsdc as number,
    leverage: leverage as number,
    stopLossPrice: stopLossPrice as number,
    takeProfitPrice: takeProfitPrice as number,
    executionAccount: wallet.agentPublicKey,
    builderAttachment,
    journalObservedAt: liveJournalObservedAt as Date,
    expectedAuthorityStatus,
    persistedRawDecision,
    persistedClampedDecision,
    contextDigest: digest,
  });
  return result.ok ? result : unwindRejectedInternalDecision(input, result);
}

// --- Paper path -------------------------------------------------------------------

/**
 * Paper entry: no adapter calls, no keys, no HMAC (G15 protects money paths —
 * a paper bot moves no funds, and paper bots have no execution authorization
 * to verify against). Entry fills at the decision-context mark price plus the
 * 0.05% adverse slippage penalty (plan §2e). The WO-6 monitor marks SL/TP
 * outcomes from subsequent candles via paper-math.
 */
async function executePaperEntry(input: ExecuteDecisionInput, side: PaperSide): Promise<ExecuteDecisionResult> {
  const { bot, decisionId, markPrice } = input;
  if (!Number.isFinite(markPrice) || markPrice <= 0) {
    return { ok: false, reason: "invalid_mark", detail: `paper entry needs a positive mark price, got ${markPrice}` };
  }
  const claimedBot = await claimExecution(input);
  if (!claimedBot) {
    return { ok: false, reason: "bot_busy", detail: "exact decision/status execution claim was lost" };
  }
  const entryPrice = paperEntryPrice(markPrice, side);
  const persistedDecision = await storage.getAiTraderDecision(decisionId);
  if (!persistedDecision?.decidedAt || persistedDecision.botId !== bot.id) {
    return { ok: false, reason: "bot_busy", detail: "claimed paper decision identity was lost before terminal commit" };
  }
  const observedAt = new Date(persistedDecision.decidedAt);
  const attemptId = entryAttemptId(decisionId);
  const journal = journalBase(bot, decisionId);
  const journalEvents = [
    { ...journal, attemptId, action: "entry" as const, cause: "paper" as const,
      eventType: "attempt_claimed" as const, side, observedAt },
    { ...journal, attemptId, action: "entry", cause: "paper", eventType: "fill_observed", side,
      price: entryPrice, sizeBase: Number(input.clamped.sizeBase), observedAt },
    { ...journal, attemptId, action: "entry", cause: "paper", eventType: "entry_terminal_open", side,
      price: entryPrice, sizeBase: Number(input.clamped.sizeBase), observedAt },
  ] as const;
  const transition = await storage.commitAiTraderPaperEntryTransition({
    botId: bot.id,
    decisionId,
    entryPrice,
    sizeBase: Number(input.clamped.sizeBase),
    side,
    observedAt,
    journalEvents,
  });
  if (transition.status === "conflict") {
    if (transition.reason === "journal_state_conflict") {
      return { ok: false, reason: "journal_unavailable", detail: "paper entry journal tuple conflicted; no terminal state committed" };
    }
    return { ok: false, reason: "bot_busy", detail: `paper entry terminal predicate lost (${transition.reason})` };
  }
  await sendTradeNotification(bot.walletAddress, {
    type: "trade_executed",
    botName: `AI Trader ${bot.market} (Paper)`,
    market: bot.market,
    side: side === "long" ? "LONG" : "SHORT",
    price: entryPrice,
  });
  console.log(
    `[AiTrader] Paper entry: bot ${bot.id.slice(0, 8)} ${side} ${bot.market} @ ${entryPrice.toFixed(6)} (mark ${markPrice}, +slippage)`
  );
  return { ok: true, mode: "paper", entryPrice };
}

// --- Live path --------------------------------------------------------------------

interface LiveEntryNumbers {
  sizeBase: number;
  marginUsdc: number;
  leverage: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  /** Root venue account captured before live mutation for the TOCTOU re-check. */
  executionAccount: string;
  /** Exact validated attach policy, or safe suppression when fee context is unavailable. */
  builderAttachment: BuilderAttachmentPolicy;
  /** Durable decision-time anchor used for every event in this entry attempt. */
  journalObservedAt: Date;
  /** Exact state that is authorized to fail before the execution claim. */
  expectedAuthorityStatus: "proposed" | "analyzing";
  /** Exact persisted raw request reviewed by guardrails at decision time. */
  persistedRawDecision: TradeDecisionLike;
  /** Exact persisted reviewed clamp; live revalidation may only reduce it. */
  persistedClampedDecision: StoredEntryClamp;
  /** Retained non-price guardrail inputs from the reviewed decision context. */
  contextDigest: Record<string, any>;
}

async function executeLiveEntry(
  input: ExecuteDecisionInput,
  side: PaperSide,
  n: LiveEntryNumbers
): Promise<ExecuteDecisionResult> {
  const { bot, decisionId, adapter } = input;
  // WO-7.1: the adapter `subaccountId` param is ALWAYS undefined on the live
  // path. A bot with its own venue subaccount signs AS that subaccount (the
  // signed account field IS the sub pubkey — Phase 4b model); the unsigned
  // Pacifica `subaccount_id` body field is unverified and never relied on.
  // Legacy canary bots (protocolSubaccountId=null) trade the main account.
  const subaccountId = undefined;

  // --- Signing context (canonical headless pattern, trade-retry-service) ----------
  const wallet = await storage.getWallet(bot.walletAddress);
  if (!wallet?.agentPublicKey || !wallet?.agentPrivateKeyEncryptedV3) {
    return { ok: false, reason: "auth_unavailable", detail: "wallet missing V3 envelope or agent public key" };
  }
  if (wallet.agentPublicKey !== n.executionAccount) {
    return {
      ok: false,
      reason: "execution_identity_changed",
      detail: "Entry refused: execution account changed across the live-entry validation seam.",
    };
  }
  let umkResult = await getUmkForWebhook(bot.walletAddress);
  if (!umkResult) {
    const why = wallet.emergencyStopTriggered ? "emergency_stopped" : "execution_disabled";
    return { ok: false, reason: "auth_unavailable", detail: `execution authorization unavailable (${why})` };
  }

  let agentKeyResult: { secretKey: Uint8Array; cleanup: () => void } | null = null;
  try {
    // G15 — policy HMAC over {market, maxLeverage, allocatedUsdc}. A mismatch
    // means the bot row was altered outside the authorized creation path:
    // pause hard, notify, send nothing.
    const policyOk = verifyBotPolicyHmac(umkResult.umk, aiTraderPolicyObject(bot), bot.policyHmac);
    if (!policyOk) {
      const transitioned = await storage.transitionAiTraderState({
        botId: bot.id,
        expectedStatus: n.expectedAuthorityStatus,
        expectedPauseReason: null,
        nextStatus: "paused",
        nextPauseReason: "policy_hmac_mismatch",
        decisionId,
        expectedDecisionOutcome: null,
        decisionOutcome: "aborted_policy",
      });
      if (!transitioned) {
        return { ok: false, reason: "bot_busy", detail: "G15 refusal lost its exact decision/status predicate" };
      }
      await sendTradeNotification(bot.walletAddress, {
        type: "trade_failed",
        botName: `AI Trader ${bot.market}`,
        market: bot.market,
        error: "Bot policy failed integrity verification (G15) — bot paused. Recreate the bot or contact support.",
      });
      return { ok: false, reason: "policy_hmac_mismatch", detail: "G15 policy HMAC mismatch — bot paused" };
    }

    // --- Trade signer (WO-7.1) --------------------------------------------
    // Bot HAS a venue subaccount → sign with the bot's OWN sub key, fail
    // closed if it's missing/undecryptable (NEVER downgrade to the main agent
    // key — that would trade the user's main account). No subaccount (legacy
    // founder canary) → original main-agent-key path.
    if (bot.protocolSubaccountId) {
      agentKeyResult = await resolveAiTraderSubaccountSigner(bot, umkResult.umk);
      if (!agentKeyResult) {
        // Same heal-once as the agent-key path: the execution-wrapped UMK copy
        // can drift from canonical, which breaks the V3 subkey derivation.
        umkResult.cleanup();
        umkResult = null;
        await healExecutionUmkFromStorage(bot.walletAddress);
        umkResult = await getUmkForWebhook(bot.walletAddress);
        if (umkResult) {
          agentKeyResult = await resolveAiTraderSubaccountSigner(bot, umkResult.umk);
        }
        if (!agentKeyResult) {
          return {
            ok: false,
            reason: "auth_unavailable",
            detail: `bot subaccount key unavailable for ${bot.protocolSubaccountId} (fail closed — will NOT sign with the main agent key)`,
          };
        }
      }
    } else {
      agentKeyResult = await decryptAgentKeyStrict(bot.walletAddress, umkResult.umk, wallet, wallet.agentPublicKey);
      if (!agentKeyResult) {
        // Same self-heal as the webhook path: the execution-wrapped UMK copy can
        // drift from the canonical one (see healExecutionUmkFromStorage docs).
        // Heal once and retry with a freshly unwrapped UMK.
        umkResult.cleanup();
        umkResult = null;
        await healExecutionUmkFromStorage(bot.walletAddress);
        umkResult = await getUmkForWebhook(bot.walletAddress);
        if (umkResult) {
          agentKeyResult = await decryptAgentKeyStrict(bot.walletAddress, umkResult.umk, wallet, wallet.agentPublicKey);
        }
        if (!agentKeyResult) {
          return { ok: false, reason: "auth_unavailable", detail: "V3 strict agent-key decrypt failed (after execution-UMK heal attempt)" };
        }
      }
    }

    // The account all orders are signed for AND all reads target: the bot's
    // own subaccount when provisioned, else the main agent account.
    const agentPublicKey = bot.protocolSubaccountId ?? wallet.agentPublicKey;
    const agentSecretKey = agentKeyResult.secretKey;
    const keyTrio = { agentPublicKey, agentSecretKey, mainWalletAddress: bot.walletAddress };

    // G11 — funding: confirmed free collateral in the bot's (sub)account must
    // cover the committed margin. No vault interaction on Pacifica (plan step 2;
    // Flash parkWhenIdle unpark is deferred with the Flash live path itself,
    // which the capability pre-flight above already blocks).
    const balances = await adapter.getBalances(agentPublicKey, subaccountId);

    // Resolve venue price only after current balances are known and before the
    // execution claim or any risk-increasing venue mutation.
    let revalidationPrice: number | null = null;
    let priceReadError: unknown = null;
    try {
      revalidationPrice = await adapter.getPrice(bot.market, { priority: "critical" });
    } catch (error) {
      priceReadError = error;
    }
    const revalidationObservedAt = new Date();
    if (!finitePositive(revalidationPrice)) {
      return {
        ok: false,
        reason: "execution_revalidation_failed",
        detail: `fresh venue price unavailable before live entry${priceReadError ? `: ${priceReadError instanceof Error ? priceReadError.message : String(priceReadError)}` : ""}`,
      };
    }

    const accountDigest = n.contextDigest.account as Record<string, unknown> | null | undefined;
    const positionState = accountDigest?.positionState === "open"
      || accountDigest?.positionState === "flat"
      || accountDigest?.positionState === "unknown"
      ? accountDigest.positionState
      : "unknown";
    const positionAuthority = accountDigest?.positionAuthority === "paper_ledger"
      || accountDigest?.positionAuthority === "venue"
      || accountDigest?.positionAuthority === "unknown"
      ? accountDigest.positionAuthority
      : "unknown";
    const revalidated = applyGuardrails(n.persistedRawDecision, {
      entryPrice: revalidationPrice,
      atr14: Number(n.contextDigest.indicators?.atr14?.value),
      botMaxLeverage: bot.maxLeverage,
      timeframe: bot.timeframe as GuardrailTimeframe,
      takerFeeRate: NON_ADMISSION_TAKER_FEE_RATE,
      maintenanceMarginWeight: adapter.getMaintenanceMarginWeight(bot.market),
      allocatedUsdc: Number(bot.allocatedUsdc),
      positionAuthority,
      positionState,
      quantizeOrderSize: (value: number) => adapter.quantizeOrderSize(bot.market, value),
      sizingMode: bot.sizingMode === "risk_based" ? "risk_based" : "discretionary",
      riskMinPct: Number(bot.riskMinPct ?? "0.50"),
      riskMaxPct: Number(bot.riskMaxPct ?? "1.50"),
      currentEquity: balances.freeCollateral,
      activeRange: n.contextDigest.activeRange ?? undefined,
    });
    if (!revalidated.ok || revalidated.clamped.action !== side) {
      const codes = revalidated.violations.map((violation) => violation.code).join(",") || "action_changed";
      console.warn(`[AiTrader] execution revalidation REJECTED bot=${bot.id.slice(0, 8)} market=${bot.market} violations=${codes}`);
      return {
        ok: false,
        reason: "execution_revalidation_failed",
        detail: `fresh venue-price guardrails rejected live entry (${codes})`,
      };
    }
    const freshClamp = storedEntryClamp(revalidated.clamped, side);
    if (!freshClamp) {
      return {
        ok: false,
        reason: "execution_revalidation_failed",
        detail: "fresh venue-price guardrails produced an unusable entry clamp",
      };
    }

    const maxLeverage = Math.min(n.persistedClampedDecision.leverage, freshClamp.leverage);
    const maxMargin = Math.min(n.persistedClampedDecision.marginUsdc, freshClamp.marginUsdc);
    const maxNotional = Math.min(n.persistedClampedDecision.notionalUsdc, freshClamp.notionalUsdc);
    const rawSizeCap = Math.min(
      n.persistedClampedDecision.sizeBase,
      freshClamp.sizeBase,
      maxNotional / revalidationPrice,
      (maxMargin * maxLeverage) / revalidationPrice,
    );
    const boundedSize = adapter.quantizeOrderSize(bot.market, rawSizeCap);
    const tolerance = Math.max(1, Math.abs(rawSizeCap)) * Number.EPSILON * 8;
    if (!finitePositive(maxLeverage)
        || !finitePositive(maxMargin)
        || !finitePositive(maxNotional)
        || !finitePositive(rawSizeCap)
        || !finitePositive(boundedSize)
        || boundedSize > rawSizeCap + tolerance) {
      return {
        ok: false,
        reason: "execution_revalidation_failed",
        detail: "fresh venue-price exposure bound or venue quantization was invalid",
      };
    }
    const boundedNotional = boundedSize * revalidationPrice;
    const boundedMargin = boundedNotional / maxLeverage;
    if (boundedNotional > maxNotional + tolerance || boundedMargin > maxMargin + tolerance) {
      return {
        ok: false,
        reason: "execution_revalidation_failed",
        detail: "fresh venue-price projection exceeded the reviewed exposure bound",
      };
    }
    n.sizeBase = boundedSize;
    n.marginUsdc = boundedMargin;
    n.leverage = maxLeverage;

    // G11 now evaluates the freshly bounded margin, never the stale decision-time amount.
    if (!Number.isFinite(balances.freeCollateral) || balances.freeCollateral < n.marginUsdc) {
      const transitioned = await storage.transitionAiTraderState({
        botId: bot.id,
        expectedStatus: n.expectedAuthorityStatus,
        expectedPauseReason: null,
        nextStatus: "idle",
        nextPauseReason: null,
        decisionId,
        expectedDecisionOutcome: null,
        decisionOutcome: "aborted_funding",
      });
      if (!transitioned) {
        return { ok: false, reason: "bot_busy", detail: "G11 refusal lost its exact decision/status predicate" };
      }
      return {
        ok: false,
        reason: "insufficient_funding",
        detail: `G11: free collateral ${balances.freeCollateral} < required margin ${n.marginUsdc}`,
      };
    }

    // Step 3 — crash marker FIRST (a crash between order-send and the status
    // write must leave a state the WO-6 startup reconciliation treats as
    // "possibly holding a live position").
    const claimedBot = await claimExecution(input);
    if (!claimedBot) {
      return { ok: false, reason: "bot_busy", detail: "exact decision/status execution claim was lost before venue mutation" };
    }

    // setLeverage throw = clean abort (architect, WO-5 review): nothing has
    // been sent to the venue yet, so idle + 'aborted_order' is provably safe —
    // but it must be a STRUCTURED result, not a raw throw that strands the bot
    // in 'executing'.
    try {
      await adapter.setLeverage({ ...keyTrio, internalSymbol: bot.market, leverage: n.leverage, subaccountId });
    } catch (err) {
      const transitioned = await storage.transitionAiTraderState({
        botId: bot.id,
        expectedStatus: "executing",
        expectedPauseReason: null,
        nextStatus: "idle",
        nextPauseReason: null,
        decisionId,
        expectedDecisionOutcome: null,
        decisionOutcome: "aborted_order",
      });
      if (!transitioned) {
        return { ok: false, reason: "bot_busy", detail: "setLeverage refusal lost its exact decision/status predicate" };
      }
      return {
        ok: false,
        reason: "order_failed",
        detail: `setLeverage failed before any order was sent: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const clientOrderId = `aitrader-${decisionId}`;
    let journalAttemptId: string;
    try {
      journalAttemptId = await appendRequiredEntryPrebroadcast({
        bot,
        decisionId,
        side,
        clientOrderId,
        sizeBase: n.sizeBase,
        price: revalidationPrice,
        observedAt: revalidationObservedAt,
      });
    } catch {
      const line = "[AiTraderExecutionJournal] required pre-broadcast append failed action=entry event=prebroadcast_authorized — live entry refused";
      console.warn(line);
      appendTelemetry(line);
      const transitioned = await storage.transitionAiTraderState({
        botId: bot.id,
        expectedStatus: "executing",
        expectedPauseReason: null,
        nextStatus: "idle",
        nextPauseReason: null,
        decisionId,
        expectedDecisionOutcome: null,
        decisionOutcome: "aborted_order",
      });
      if (!transitioned) {
        return { ok: false, reason: "bot_busy", detail: "journal refusal lost its exact decision/status predicate" };
      }
      return {
        ok: false,
        reason: "journal_unavailable",
        detail: "execution journal unavailable before broadcast — entry refused",
      };
    }

    let orderResult: OrderResult;
    try {
      orderResult = await adapter.placeMarketOrder({
        ...keyTrio,
        internalSymbol: bot.market,
        side,
        sizeBase: n.sizeBase,
        clientOrderId,
        subaccountId,
        maxSlippagePct: ENTRY_MAX_SLIPPAGE_PCT,
        leverage: n.leverage,
        builderAttachment: n.builderAttachment,
      });
    } catch (err) {
      orderResult = { success: false, status: "rejected" as const, error: err instanceof Error ? err.message : String(err) };
    }
    const entryJournal = journalBase(bot, decisionId);
    const unconfirmedLanding = isUnconfirmedLandingResult(orderResult);
    const entryOrderEvent = {
      ...orderResultEvent({
        base: entryJournal,
        attemptId: journalAttemptId,
        action: "entry",
        cause: "decision",
        order: orderResult,
        clientOrderId,
        failureCode: unconfirmedLanding
          ? "venue_unconfirmed"
          : orderResult.success ? null : orderResult.status === "rejected" ? "venue_rejected" : "venue_error",
      }),
      side,
      observedAt: n.journalObservedAt,
    };

    const transitionFailure = async (detail: string, bracketProtected = false): Promise<ExecuteDecisionResult> => {
      await sendTradeNotification(bot.walletAddress, {
        type: "trade_failed",
        botName: `AI Trader ${bot.market}`,
        market: bot.market,
        side: side === "long" ? "LONG" : "SHORT",
        error: `${detail}. The durable entry transition did not commit; the bot remains in its executing crash marker. ${
          bracketProtected
            ? "The venue position is bracket-protected while reconciliation takes ownership."
            : "Verify the venue before any further entry."
        }`,
      });
      return { ok: false, reason: "position_unconfirmed", detail };
    };

    const commitLiveTransition = async (
      params: Parameters<typeof storage.commitAiTraderDirectLiveEntryTransition>[0],
      detail: string,
      bracketProtected = false,
    ): Promise<ExecuteDecisionResult | null> => {
      try {
        const transitioned = await storage.commitAiTraderDirectLiveEntryTransition(params);
        return transitioned.status === "conflict"
          ? await transitionFailure(`${detail} (${transitioned.reason})`, bracketProtected)
          : null;
      } catch (err) {
        return transitionFailure(`${detail} (${err instanceof Error ? err.message : String(err)})`, bracketProtected);
      }
    };

    if (!orderResult.success || unconfirmedLanding) {
      // Landing-verification timeout: the order tx was BROADCAST and may still
      // land inside the blockhash validity window (~60–90s) even though the
      // adapter could not confirm it. A single flat probe here is NOT proof of
      // a clean abort, and an idle verdict would let auto-next re-enter while
      // the original tx can still fill → double-open. An IMMEDIATE emergency
      // close is equally useless: if the entry has not landed yet, the venue
      // reads flat and closePosition() is a no-op — then the entry lands later
      // into a paused, unmonitored bot. Instead, persist an explicit
      // uncertain-entry state (decision outcome 'unconfirmed_landing' + bot
      // paused/position_unconfirmed) as the durable marker; the monitor's
      // reconcileUnconfirmedLanding() keeps probing the venue and either
      // brackets a late-landing position, protectively closes it, or expires
      // the marker after a conservative flat window. (Retry classification
      // also hard-excludes this verdict — see tx-verdicts.ts.)
      if (unconfirmedLanding) {
        // Quarantine decision, bot state, and the exact venue-result suffix in
        // one transaction. A conflict/throw leaves the pre-existing executing
        // crash marker intact and returns position_unconfirmed; there is no
        // split state for startup recovery to misclassify as a clean abort.
        const failedTransition = await commitLiveTransition({
          botId: bot.id,
          decisionId,
          disposition: "quarantined",
          side,
          observedAt: n.journalObservedAt,
          journalEvents: [entryOrderEvent],
        }, "Unconfirmed entry quarantine could not be committed atomically");
        if (failedTransition) return failedTransition;
        await sendTradeNotification(bot.walletAddress, {
          type: "trade_failed",
          botName: `AI Trader ${bot.market}`,
          market: bot.market,
          side: side === "long" ? "LONG" : "SHORT",
          error:
            `${orderResult.success
              ? "Entry order was acknowledged by the venue but not terminally confirmed."
              : "Entry order may have reached the venue, but no terminal outcome was confirmed."} ` +
            `The bot is quarantined from new entries while automatic reconciliation keeps checking the venue — ` +
            `a late-landing position will be stop-protected or safely closed. ` +
            `If reconciliation cannot settle it within a few minutes you'll get a final alert; verify the exchange before resuming.`,
        });
        return {
          ok: false,
          reason: "position_unconfirmed",
          detail: `entry order unconfirmed — the transaction may still land, so a flat probe is not proof of a clean abort; persisted 'unconfirmed_landing' for monitor reconciliation (${orderResult.error ?? "unknown"})`,
        };
      }
      // Order rejected. Probe once for a position anyway (a venue "failure"
      // response is not proof nothing filled); a confirmed-flat account means
      // a clean abort, anything else falls through to fail-closed handling.
      let confirmedFlat = false;
      try {
        const probe = await adapter.getPositions(agentPublicKey, subaccountId);
        confirmedFlat = !findPosition(probe, bot.market);
      } catch {
        confirmedFlat = false;
      }
      if (confirmedFlat) {
        const failedTransition = await commitLiveTransition({
          botId: bot.id,
          decisionId,
          disposition: "no_land",
          side,
          observedAt: n.journalObservedAt,
          journalEvents: [
            entryOrderEvent,
            { ...entryJournal, attemptId: journalAttemptId, action: "entry", cause: "decision",
              eventType: "entry_terminal_no_land", side, clientOrderId,
              failureCode: orderResult.status === "rejected" ? "venue_rejected" : "venue_error",
              recordedAfterBroadcast: true, observedAt: n.journalObservedAt },
          ],
        }, "Confirmed-flat no-land transition could not be committed atomically");
        if (failedTransition) return failedTransition;
        return { ok: false, reason: "order_failed", detail: `entry order failed cleanly (no position): ${orderResult.error ?? "unknown"}` };
      }
      // Can't prove we're flat — treat like an unconfirmed position: try to
      // close whatever might exist, pause for human eyes.
      // NOTE: because pauseReason is 'position_unconfirmed', bots paused here
      // (and at the no-position-appeared site below) are ALSO picked up by
      // reconcileUnconfirmedLanding every tick — intentional: flat bots get a
      // clean expiry, and a position that shows up late gets adopted or
      // orphan-flattened instead of sitting naked.
      safeAppendExecutionEvents([entryOrderEvent]);
      return await emergencyCloseAndPause({
        input, keyTrio, subaccountId,
        pauseReason: "position_unconfirmed",
        failureReason: "position_unconfirmed",
        detail: `entry order failed (${orderResult.error ?? "unknown"}) and flat state could not be confirmed`,
        entryFillPrice: undefined,
        sizeBase: n.sizeBase,
        side,
      });
    }

    // Step 4 — confirm the position actually exists (3× / 2s).
    let confirmed: { entryPrice: number; baseSize: number } | null = null;
    for (let attempt = 1; attempt <= POSITION_CONFIRM_ATTEMPTS; attempt++) {
      try {
        const positions = await adapter.getPositions(agentPublicKey, subaccountId);
        const pos = findPosition(positions, bot.market);
        if (pos) { confirmed = pos; break; }
      } catch { /* transient read failure — retry */ }
      if (attempt < POSITION_CONFIRM_ATTEMPTS) await sleep(POSITION_CONFIRM_DELAY_MS);
    }
    if (!confirmed) {
      safeAppendExecutionEvents([entryOrderEvent]);
      return await emergencyCloseAndPause({
        input, keyTrio, subaccountId,
        pauseReason: "position_unconfirmed",
        failureReason: "position_unconfirmed",
        detail: `order reported success but no ${bot.market} position appeared after ${POSITION_CONFIRM_ATTEMPTS} checks`,
        entryFillPrice: orderResult.fillPrice,
        sizeBase: n.sizeBase,
        side,
      });
    }

    const entryPrice = Number.isFinite(orderResult.fillPrice) && (orderResult.fillPrice as number) > 0
      ? (orderResult.fillPrice as number)
      : confirmed.entryPrice;

    // Steps 5–6 — bracket through the StopPolicy seam + G10 verification.
    const bracketOk = await placeAndVerifyBracket({
      bot, adapter, keyTrio, subaccountId,
      stopLossPrice: n.stopLossPrice,
      takeProfitPrice: n.takeProfitPrice,
      builderAttachment: n.builderAttachment,
      positionBaseSize: confirmed.baseSize,
      decisionId,
    });
    if (!bracketOk.ok) {
      safeAppendExecutionEvents([entryOrderEvent]);
      return await emergencyCloseAndPause({
        input, keyTrio, subaccountId,
        pauseReason: "bracket_failed",
        failureReason: "bracket_failed",
        detail: bracketOk.detail,
        entryFillPrice: entryPrice,
        sizeBase: n.sizeBase,
        side,
      });
    }

    // Step 7 — success.
    const failedTransition = await commitLiveTransition({
      botId: bot.id,
      decisionId,
      disposition: "open",
      side,
      observedAt: n.journalObservedAt,
      entryPrice,
      sizeBase: n.sizeBase,
      journalEvents: [
        entryOrderEvent,
        { ...entryJournal, attemptId: journalAttemptId, action: "entry", cause: "decision",
          eventType: "position_observed", side, price: confirmed.entryPrice, sizeBase: n.sizeBase,
          observedAt: n.journalObservedAt },
        { ...entryJournal, attemptId: journalAttemptId, action: "entry", cause: "decision",
          eventType: "fill_observed", side, clientOrderId, venueOrderId: orderResult.orderId ?? null,
          venueStatus: orderResult.status, price: entryPrice, sizeBase: orderResult.fillSize ?? n.sizeBase,
          fee: orderResult.fee ?? null, observedAt: n.journalObservedAt },
        { ...entryJournal, attemptId: journalAttemptId, action: "entry", cause: "decision",
          eventType: "bracket_verified", side, observedAt: n.journalObservedAt },
        { ...entryJournal, attemptId: journalAttemptId, action: "entry", cause: "decision",
          eventType: "entry_terminal_open", side, price: entryPrice, sizeBase: n.sizeBase,
          observedAt: n.journalObservedAt },
      ],
    }, "Bracketed open transition could not be committed atomically", true);
    if (failedTransition) return failedTransition;
    await sendTradeNotification(bot.walletAddress, {
      type: "trade_executed",
      botName: `AI Trader ${bot.market}`,
      market: bot.market,
      side: side === "long" ? "LONG" : "SHORT",
      size: n.sizeBase,
      price: entryPrice,
    });
    console.log(
      `[AiTrader] Live entry: bot ${bot.id.slice(0, 8)} ${side} ${bot.market} ${n.sizeBase} @ ${entryPrice} (bracket verified)`
    );
    return { ok: true, mode: "live", entryPrice };
  } finally {
    agentKeyResult?.cleanup();
    umkResult?.cleanup();
  }
}

function findPosition(
  positions: Array<{ internalSymbol: string; baseSize: number; entryPrice: number }>,
  market: string
): { entryPrice: number; baseSize: number } | null {
  const pos = positions.find(
    (p) => p.internalSymbol.toUpperCase() === market.toUpperCase() && Math.abs(p.baseSize) > 0
  );
  return pos ? { entryPrice: pos.entryPrice, baseSize: pos.baseSize } : null;
}

/**
 * WO-5 step 5 — the StopPolicy seam. ONE switch on bot.stopPolicy; the MVP
 * implements only 'static'. When the Intelligent Stops Watchdog ships, new
 * policies register a position_stops monitor HERE and still place the native
 * bracket (widened to safety-net distance) — the G10 invariant that a native
 * bracket ALWAYS rests on the venue is non-negotiable for every policy.
 */
async function placeAndVerifyBracket(args: {
  bot: AiTraderBot;
  adapter: ProtocolAdapter;
  keyTrio: { agentPublicKey: string; agentSecretKey: Uint8Array; mainWalletAddress: string };
  subaccountId: string | undefined;
  stopLossPrice: number;
  takeProfitPrice: number;
  builderAttachment: BuilderAttachmentPolicy;
  positionBaseSize: number;
  decisionId: string;
}): Promise<{ ok: true } | { ok: false; detail: string }> {
  const {
    bot,
    adapter,
    keyTrio,
    subaccountId,
    stopLossPrice,
    takeProfitPrice,
    builderAttachment,
    positionBaseSize,
    decisionId,
  } = args;

  switch (bot.stopPolicy) {
    case "static":
    default: {
      // Unknown policies deliberately fall through to static: placing the
      // native bracket is ALWAYS correct (safety net), and a typo'd policy
      // must never mean "no stops".
      let tpslResult;
      try {
        tpslResult = await adapter.setTpSl!({
          ...keyTrio,
          internalSymbol: bot.market,
          stopLossPrice,
          takeProfitPrice,
          subaccountId,
          builderAttachment,
        });
      } catch (err) {
        return { ok: false, detail: `setTpSl threw: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!tpslResult.success) {
        return { ok: false, detail: `setTpSl failed: ${tpslResult.error ?? "unknown"}` };
      }
      const slDropped = tpslResult.droppedLegs?.some((l) => l.leg === "sl");
      if (slDropped) {
        // A dropped TP is survivable (position still stop-protected); a dropped
        // SL is not — that is exactly the naked-position scenario G10 exists for.
        return { ok: false, detail: `setTpSl dropped the SL leg: ${JSON.stringify(tpslResult.droppedLegs)}` };
      }
      break;
    }
  }

  // G10 money authority remains the proven legacy stop-order read while the
  // semantic /orders observation is calibrated against production behavior.
  let lastDetail = "protective stop not observed";
  for (let attempt = 1; attempt <= BRACKET_VERIFY_ATTEMPTS; attempt++) {
    const proof = await verifyLiveProtectiveStop({
      adapter,
      agentPublicKey: keyTrio.agentPublicKey,
      subaccountId,
      internalSymbol: bot.market,
      positionBaseSize,
      expectedStopLossPrice: stopLossPrice,
    });
    recordProtectiveReadObservation("initial_entry", bot, decisionId, proof);
    if (proof.status === "legacy_present") return { ok: true };
    lastDetail = proof.detail;
    if (attempt < BRACKET_VERIFY_ATTEMPTS) await sleep(BRACKET_VERIFY_DELAY_MS);
  }
  return { ok: false, detail: `G10: legacy protective stop presence not proven for ${bot.market} after ${BRACKET_VERIFY_ATTEMPTS} checks (${lastDetail})` };
}

function recordProtectiveReadObservation(
  seam: string,
  bot: AiTraderBot,
  decisionId: string,
  proof: LiveProtectiveStopProof,
): void {
  if (!protectiveReadNeedsTelemetry(proof)) return;
  const event = proof.status === "legacy_missing"
    ? "protective_stop_missing"
    : "protective_read_inconclusive";
  const line =
    `[AiTraderProtectiveRead] event=${event} seam=${seam}` +
    ` bot=${bot.id} market=${bot.market} decision=${decisionId}` +
    ` semantic=${proof.semantic.status}` +
    ` normalized=${proof.semantic.normalizedRowCount}` +
    ` incomplete=${proof.semantic.incompleteRowCount}` +
    ` legacy=${proof.legacyRowCount ?? "unavailable"}`;
  console.warn(line);
  appendTelemetry(line);
}

/**
 * Fail-closed unwind shared by steps 4–6: close whatever is (or might be)
 * open at market, pause the bot, notify, and record what we know. Close
 * failures are logged but never mask the original failure — a bot paused with
 * a possibly-open position is exactly what the WO-6 startup reconciliation
 * and the pause alert exist to surface.
 */
async function emergencyCloseAndPause(args: {
  input: ExecuteDecisionInput;
  keyTrio: { agentPublicKey: string; agentSecretKey: Uint8Array; mainWalletAddress: string };
  subaccountId: string | undefined;
  pauseReason: "bracket_failed" | "position_unconfirmed";
  failureReason: ExecuteFailureReason;
  detail: string;
  entryFillPrice: number | undefined;
  sizeBase: number;
  side: PaperSide;
}): Promise<ExecuteDecisionResult> {
  const { input, keyTrio, subaccountId, pauseReason, failureReason, detail, entryFillPrice, sizeBase, side } = args;
  const { bot, decisionId, adapter } = input;

  let closeFill: number | undefined;
  let closeSucceeded = false;
  let closeOrder: OrderResult | null = null;
  const closedAt = new Date();
  const closeAttemptId = newMutationAttemptId("close", decisionId);
  const closeJournal = journalBase(bot, decisionId);
  const closeClientOrderId = `aitrader-close-${decisionId}`;
  try {
    const closeResult = await adapter.closePosition({
      ...keyTrio,
      internalSymbol: bot.market,
      subaccountId,
      clientOrderId: closeClientOrderId,
      maxSlippagePct: ENTRY_MAX_SLIPPAGE_PCT,
    });
    closeSucceeded = isTerminalCloseResult(closeResult);
    closeFill = closeResult.fillPrice;
    closeOrder = closeResult;
  } catch (err) {
    console.error(`[AiTrader] Emergency close failed for bot ${bot.id.slice(0, 8)} (${pauseReason}):`, err);
  }
  const closeJournalEvents: JournalEventInput[] = [
    { ...closeJournal, attemptId: closeAttemptId, action: "close", cause: "emergency_unwind",
      eventType: "attempt_claimed", side, recordedAfterBroadcast: true, observedAt: closedAt },
    { ...closeJournal, attemptId: closeAttemptId, action: "close", cause: "emergency_unwind",
      eventType: "broadcast_attempted", side, clientOrderId: closeClientOrderId, recordedAfterBroadcast: true, observedAt: closedAt },
    { ...orderResultEvent({ base: closeJournal, attemptId: closeAttemptId, action: "close", cause: "emergency_unwind",
      order: closeOrder, clientOrderId: closeClientOrderId, recordedAfterBroadcast: true,
      failureCode: closeOrder ? null : "venue_error" }), observedAt: closedAt },
    { ...closeJournal, attemptId: closeAttemptId, action: "close", cause: "emergency_unwind",
      eventType: closeSucceeded ? "close_terminal_confirmed" : "close_terminal_failed", side,
      clientOrderId: closeClientOrderId, venueOrderId: closeOrder?.orderId ?? null,
      venueStatus: closeOrder?.status ?? "unknown", price: closeFill ?? null,
      failureCode: closeSucceeded ? null : "venue_error", recordedAfterBroadcast: true, observedAt: closedAt },
  ];
  const entryTerminalEvents: JournalEventInput[] = closeSucceeded ? [{
    ...journalBase(bot, decisionId),
    attemptId: entryAttemptId(decisionId),
    action: "entry",
    cause: "decision",
    eventType: "entry_terminal_unwound",
    side,
    price: closeFill ?? null,
    sizeBase,
    failureCode: pauseReason === "bracket_failed" ? "bracket_failed" : "position_not_confirmed",
    recordedAfterBroadcast: true,
    observedAt: closedAt,
  }] : [];
  const transition = await storage.commitAiTraderRecoveryTransition({
    disposition: "emergency_unwind",
    botId: bot.id,
    expectedBotStatus: "executing",
    expectedPauseReason: null,
    decisionId,
    expectedDecisionOutcome: null,
    closeAttemptId,
    pauseReason,
    entryFillPrice: entryFillPrice !== undefined && Number.isFinite(entryFillPrice) ? entryFillPrice : null,
    closeSucceeded,
    closeFillPrice: closeFill !== undefined && Number.isFinite(closeFill) ? closeFill : null,
    closedAt,
    journalBatches: [closeJournalEvents, entryTerminalEvents],
  });
  if (transition.status === "conflict") {
    console.error(`[AiTrader] Emergency recovery transition conflicted (${transition.reason}); bot state requires reconciliation`);
    // The venue close has already happened. A stale row predicate must not
    // erase the immutable evidence of that money-path mutation along with the
    // rolled-back recovery transaction. Persist the retained attempt outside
    // the failed state transition before notifying; the journal's own lineage
    // and phase checks still fail closed on incompatible history.
    try {
      await appendExecutionEvents(closeJournalEvents);
    } catch (error) {
      console.warn(`[AiTrader] Emergency close evidence append failed after recovery conflict: ${error instanceof Error ? error.message : "unknown"}`);
    }
    if (entryTerminalEvents.length > 0) {
      try {
        await appendExecutionEvents(entryTerminalEvents);
      } catch (error) {
        console.warn(`[AiTrader] Emergency entry-terminal append failed after recovery conflict: ${error instanceof Error ? error.message : "unknown"}`);
      }
    }
  } else if (transition.journal.status === "degraded") {
    console.warn(`[AiTrader] Emergency recovery state committed with degraded journal (${transition.journal.failureCode})`);
  }

  await sendTradeNotification(bot.walletAddress, {
    type: "trade_failed",
    botName: `AI Trader ${bot.market}`,
    market: bot.market,
    side: side === "long" ? "LONG" : "SHORT",
    error: `${detail}. ${closeSucceeded ? "Position closed at market." : "AUTOMATIC CLOSE FAILED — check the exchange NOW."} Bot paused (${pauseReason}).`,
  });

  return { ok: false, reason: failureReason, detail: `${detail}${closeSucceeded ? " (position closed at market)" : " (EMERGENCY CLOSE FAILED — manual check required)"}` };
}
