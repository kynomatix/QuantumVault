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
import type { ProtocolAdapter } from "../protocol/adapter";
import type { ClampedDecision } from "./guardrails";
import { paperEntryPrice, type PaperSide } from "./paper-math";

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
  | "capability_missing"   // adapter lacks setTpSl/getOpenStopOrders — G10 unverifiable, refuse BEFORE entry
  | "auth_unavailable"     // wallet envelope/UMK/agent-key unavailable (execution disabled, e-stop, decrypt fail)
  | "policy_hmac_mismatch" // G15: bot row fails HMAC — paused, nothing sent
  | "insufficient_funding" // G11: free collateral below required margin
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
    return { ok: false, reason: "not_entry", detail: `action '${clamped.action}' is not an entry` };
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
    return {
      ok: false,
      reason: "invalid_clamp",
      detail: "ClampedDecision missing/invalid sizeBase, marginUsdc, leverage, stopLossPrice or takeProfitPrice",
    };
  }

  // Already-open guard (architect, WO-5 review): a retried or mis-orchestrated
  // call against a bot that holds (or MAY hold — 'executing' is the crash
  // marker) a position must never stack a second market order on top of it.
  // G6 only counts CLOSED decisions, so it cannot catch this.
  if (bot.status === "open" || bot.status === "executing" || bot.status === "proposed") {
    return {
      ok: false,
      reason: "bot_busy",
      detail: `bot status '${bot.status}' — refusing a new entry while a position is (or may be) open`,
    };
  }

  // G6 — enforced on BOTH paths: the paper record feeds graduation, so paper
  // must obey the same cadence it will be held to live.
  const recentClosed = await storage.getRecentClosedDecisions(bot.id, 30);
  const g6 = checkCooldownAndCaps(bot.timeframe, recentClosed, Date.now());
  if (!g6.ok) return { ok: false, reason: g6.reason, detail: g6.detail };

  if (bot.paperMode) {
    return executePaperEntry(input, side);
  }
  return executeLiveEntry(input, side, {
    sizeBase: sizeBase as number,
    marginUsdc: marginUsdc as number,
    leverage: leverage as number,
    stopLossPrice: stopLossPrice as number,
    takeProfitPrice: takeProfitPrice as number,
  });
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
  const entryPrice = paperEntryPrice(markPrice, side);
  await storage.updateAiTraderDecision(decisionId, {
    outcome: "executed",
    entryPrice: entryPrice.toFixed(8),
  });
  await storage.updateAiTraderBot(bot.id, { status: "open", pauseReason: null });
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

  // Capability pre-flight (BEFORE any order): if the adapter cannot place or
  // verify a native bracket, G10 is unenforceable — refuse to open at all.
  // This intentionally blocks Flash-style adapters (no getOpenStopOrders);
  // the MVP is Pacifica-only for exactly this reason.
  if (typeof adapter.setTpSl !== "function" || typeof adapter.getOpenStopOrders !== "function") {
    return {
      ok: false,
      reason: "capability_missing",
      detail: `adapter for protocol '${bot.protocol}' lacks setTpSl/getOpenStopOrders — G10 bracket guarantee unenforceable`,
    };
  }

  // --- Signing context (canonical headless pattern, trade-retry-service) ----------
  const wallet = await storage.getWallet(bot.walletAddress);
  if (!wallet?.agentPublicKey || !wallet?.agentPrivateKeyEncryptedV3) {
    return { ok: false, reason: "auth_unavailable", detail: "wallet missing V3 envelope or agent public key" };
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
      await storage.updateAiTraderBot(bot.id, { status: "paused", pauseReason: "policy_hmac_mismatch" });
      await storage.updateAiTraderDecision(decisionId, { outcome: "aborted_policy" });
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
    if (!Number.isFinite(balances.freeCollateral) || balances.freeCollateral < n.marginUsdc) {
      await storage.updateAiTraderDecision(decisionId, { outcome: "aborted_funding" });
      await storage.updateAiTraderBot(bot.id, { status: "idle" });
      return {
        ok: false,
        reason: "insufficient_funding",
        detail: `G11: free collateral ${balances.freeCollateral} < required margin ${n.marginUsdc}`,
      };
    }

    // Step 3 — crash marker FIRST (a crash between order-send and the status
    // write must leave a state the WO-6 startup reconciliation treats as
    // "possibly holding a live position").
    await storage.updateAiTraderBot(bot.id, { status: "executing" });

    // setLeverage throw = clean abort (architect, WO-5 review): nothing has
    // been sent to the venue yet, so idle + 'aborted_order' is provably safe —
    // but it must be a STRUCTURED result, not a raw throw that strands the bot
    // in 'executing'.
    try {
      await adapter.setLeverage({ ...keyTrio, internalSymbol: bot.market, leverage: n.leverage, subaccountId });
    } catch (err) {
      await storage.updateAiTraderDecision(decisionId, { outcome: "aborted_order" });
      await storage.updateAiTraderBot(bot.id, { status: "idle" });
      return {
        ok: false,
        reason: "order_failed",
        detail: `setLeverage failed before any order was sent: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    let orderResult;
    try {
      orderResult = await adapter.placeMarketOrder({
        ...keyTrio,
        internalSymbol: bot.market,
        side,
        sizeBase: n.sizeBase,
        clientOrderId: `aitrader-${decisionId}`,
        subaccountId,
        maxSlippagePct: ENTRY_MAX_SLIPPAGE_PCT,
        leverage: n.leverage,
      });
    } catch (err) {
      orderResult = { success: false, status: "rejected" as const, error: err instanceof Error ? err.message : String(err) };
    }

    if (!orderResult.success) {
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
        await storage.updateAiTraderDecision(decisionId, { outcome: "aborted_order" });
        await storage.updateAiTraderBot(bot.id, { status: "idle" });
        return { ok: false, reason: "order_failed", detail: `entry order failed cleanly (no position): ${orderResult.error ?? "unknown"}` };
      }
      // Can't prove we're flat — treat like an unconfirmed position: try to
      // close whatever might exist, pause for human eyes.
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
    let confirmed: { entryPrice: number } | null = null;
    for (let attempt = 1; attempt <= POSITION_CONFIRM_ATTEMPTS; attempt++) {
      try {
        const positions = await adapter.getPositions(agentPublicKey, subaccountId);
        const pos = findPosition(positions, bot.market);
        if (pos) { confirmed = pos; break; }
      } catch { /* transient read failure — retry */ }
      if (attempt < POSITION_CONFIRM_ATTEMPTS) await sleep(POSITION_CONFIRM_DELAY_MS);
    }
    if (!confirmed) {
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
    });
    if (!bracketOk.ok) {
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
    await storage.updateAiTraderDecision(decisionId, {
      outcome: "executed",
      entryPrice: entryPrice.toFixed(8),
    });
    await storage.updateAiTraderBot(bot.id, { status: "open", pauseReason: null });
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
): { entryPrice: number } | null {
  const pos = positions.find(
    (p) => p.internalSymbol.toUpperCase() === market.toUpperCase() && Math.abs(p.baseSize) > 0
  );
  return pos ? { entryPrice: pos.entryPrice } : null;
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
}): Promise<{ ok: true } | { ok: false; detail: string }> {
  const { bot, adapter, keyTrio, subaccountId, stopLossPrice, takeProfitPrice } = args;

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

  // G10 — the bracket must be VISIBLE on the venue, not just acknowledged.
  for (let attempt = 1; attempt <= BRACKET_VERIFY_ATTEMPTS; attempt++) {
    try {
      const stops = await adapter.getOpenStopOrders!(keyTrio.agentPublicKey, subaccountId, bot.market);
      if (stops.length > 0) return { ok: true };
    } catch { /* transient read failure — retry */ }
    if (attempt < BRACKET_VERIFY_ATTEMPTS) await sleep(BRACKET_VERIFY_DELAY_MS);
  }
  return { ok: false, detail: `G10: no resting stop orders visible for ${bot.market} after ${BRACKET_VERIFY_ATTEMPTS} checks` };
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
  try {
    const closeResult = await adapter.closePosition({
      ...keyTrio,
      internalSymbol: bot.market,
      subaccountId,
      clientOrderId: `aitrader-close-${decisionId}`,
      maxSlippagePct: ENTRY_MAX_SLIPPAGE_PCT,
    });
    closeSucceeded = closeResult.success;
    closeFill = closeResult.fillPrice;
  } catch (err) {
    console.error(`[AiTrader] Emergency close failed for bot ${bot.id.slice(0, 8)} (${pauseReason}):`, err);
  }

  await storage.updateAiTraderBot(bot.id, { status: "paused", pauseReason });

  if (entryFillPrice !== undefined && Number.isFinite(entryFillPrice)) {
    // The entry DID execute; record it honestly with the failure exit.
    await storage.updateAiTraderDecision(decisionId, {
      outcome: "executed",
      entryPrice: entryFillPrice.toFixed(8),
      ...(closeSucceeded && closeFill !== undefined && Number.isFinite(closeFill)
        ? {
            exitPrice: closeFill.toFixed(8),
            exitReason: pauseReason,
            closedAt: new Date(),
            realizedPnl: ((closeFill - entryFillPrice) * sizeBase * (side === "long" ? 1 : -1)).toFixed(2),
          }
        : { exitReason: pauseReason }),
    });
  } else {
    await storage.updateAiTraderDecision(decisionId, { outcome: "aborted_order" });
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
