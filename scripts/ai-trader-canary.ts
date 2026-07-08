#!/usr/bin/env tsx
/**
 * AI Trader — WO-5 live-canary driver (plan docs/AGENTIC_TRADER_PLAN.md, WO-5 Accept).
 *
 * Drives ONE $10 live trade on Pacifica through the REAL executor
 * (server/ai-trader/executor.ts) from a founder wallet, plus the forced
 * bracket-failure drill. This is the only true go-live gate for the live path;
 * the paper path is already CI-covered (tests/ai-trader/paper-math.test.ts,
 * executor.test.ts).
 *
 * ── SAFETY GATES (all required, in order) ─────────────────────────────────────
 *   1. Default is DRY-RUN: prints the exact bot row, decision, and order it
 *      WOULD send, then exits. Nothing touches the DB or the venue.
 *   2. `--live` flag AND env `CANARY_CONFIRM=TRADE_REAL_FUNDS` are both
 *      required to execute. Either alone refuses.
 *   3. Hard caps enforced HERE regardless of flags: allocation ≤ $15,
 *      leverage ≤ 2, market must be SOL-PERP.
 *   4. The wallet must already have execution authorization enabled
 *      (getUmkForWebhook returns non-null) and a funded Pacifica subaccount
 *      holding the allocation. This script does NOT move funds into place —
 *      do that through the normal app UI first (see runbook).
 *
 * ── USAGE ─────────────────────────────────────────────────────────────────────
 *   Dry run (always safe):
 *     tsx scripts/ai-trader-canary.ts --wallet <FOUNDER_WALLET> --subaccount <SUB_ID>
 *
 *   Live entry (canary trade #1 — TP-close leg of the drill):
 *     CANARY_CONFIRM=TRADE_REAL_FUNDS tsx scripts/ai-trader-canary.ts \
 *       --wallet <FOUNDER_WALLET> --subaccount <SUB_ID> --live --side long
 *
 *   Bracket-failure drill (G10 close-and-pause proof — sends an entry whose TP
 *   is deliberately on the WRONG side of the mark so setTpSl/G10 must fail,
 *   proving the executor closes the position at market and pauses the bot):
 *     CANARY_CONFIRM=TRADE_REAL_FUNDS tsx scripts/ai-trader-canary.ts \
 *       --wallet <FOUNDER_WALLET> --subaccount <SUB_ID> --live --drill bracket-fail
 *
 *   Flags:
 *     --wallet <addr>       (required) founder main wallet address
 *     --subaccount <id>     (required) funded Pacifica subaccount id
 *     --side long|short     entry side (default long)
 *     --alloc <usdc>        allocation, ≤ 15 (default 10)
 *     --leverage <n>        1 or 2 (default 1)
 *     --sl-pct <p>          SL distance % from mark (default 1.5, band 0.5–10)
 *     --tp-pct <p>          TP distance % from mark (default 3)
 *     --drill bracket-fail  invalid-TP drill instead of a normal entry
 *     --bot-id <id>         reuse an existing canary bot row instead of creating
 *     --live                actually execute (with CANARY_CONFIRM env)
 *
 * SL-close and TP-close legs are exercised by price movement / manual exchange
 * action per the runbook (docs/AI_TRADER_CANARY_RUNBOOK.md) — WO-6's monitor is
 * not built yet, so exit detection during the canary is manual by design.
 */
import { storage } from "../server/storage";
import { getAdapter } from "../server/protocol/adapter-registry";
import { getUmkForWebhook, computeBotPolicyHmac } from "../server/session-v3";
import { executeDecision, aiTraderPolicyObject } from "../server/ai-trader/executor";
import type { ClampedDecision } from "../server/ai-trader/guardrails";

const MARKET = "SOL-PERP";
const MAX_ALLOC = 15;
const MAX_LEVERAGE = 2;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const wallet = arg("wallet");
  const subaccountId = arg("subaccount");
  const side = (arg("side") ?? "long") as "long" | "short";
  const alloc = Number(arg("alloc") ?? 10);
  const leverage = Number(arg("leverage") ?? 1);
  const slPct = Number(arg("sl-pct") ?? 1.5);
  const tpPct = Number(arg("tp-pct") ?? 3);
  const drill = arg("drill");
  const reuseBotId = arg("bot-id");
  const live = flag("live");
  const confirmed = process.env.CANARY_CONFIRM === "TRADE_REAL_FUNDS";

  // ── Gate 3: hard caps, no flag overrides them ──────────────────────────────
  if (!wallet || !subaccountId) throw new Error("--wallet and --subaccount are required");
  if (!["long", "short"].includes(side)) throw new Error("--side must be long|short");
  if (!(alloc > 0 && alloc <= MAX_ALLOC)) throw new Error(`--alloc must be 0<a≤${MAX_ALLOC} (canary hard cap)`);
  if (!(leverage >= 1 && leverage <= MAX_LEVERAGE)) throw new Error(`--leverage must be 1..${MAX_LEVERAGE} (canary hard cap)`);
  if (!(slPct >= 0.5 && slPct <= 10)) throw new Error("--sl-pct must be in the G2 band 0.5–10");
  if (drill && drill !== "bracket-fail") throw new Error("--drill only supports 'bracket-fail'");

  const adapter = getAdapter("pacifica");
  const mark = await adapter.getPrice(MARKET);
  if (!mark || !Number.isFinite(mark) || mark <= 0) throw new Error(`No usable mark price for ${MARKET}`);

  // ── Build the hand-authored clamped decision (guardrail-shaped) ────────────
  const marginUsdc = alloc * 0.9; // sizePct 90 — the G5 ceiling, keeps the math visible
  const notionalUsdc = marginUsdc * leverage;
  const sizeBase = adapter.quantizeOrderSize(MARKET, notionalUsdc / mark);
  const stopLossPrice = side === "long" ? mark * (1 - slPct / 100) : mark * (1 + slPct / 100);
  // bracket-fail drill: TP on the WRONG side of the mark → venue must reject →
  // proves G10 emergency close + pause. Normal run: TP on the correct side.
  const takeProfitPrice =
    drill === "bracket-fail"
      ? side === "long"
        ? mark * (1 - tpPct / 100) // TP below mark on a long = invalid
        : mark * (1 + tpPct / 100)
      : side === "long"
        ? mark * (1 + tpPct / 100)
        : mark * (1 - tpPct / 100);

  const clamped: ClampedDecision = {
    action: side,
    entryType: "market",
    leverage,
    sizePct: 90,
    marginUsdc,
    notionalUsdc,
    sizeBase,
    stopLossPrice,
    takeProfitPrice,
    confidence: 10,
    invalidation: "canary drill — manually authored, no LLM involved",
    rationale: drill === "bracket-fail" ? "WO-5 G10 bracket-failure drill (deliberate invalid TP)" : "WO-5 live canary entry",
  };

  console.log("=== AI Trader canary ===");
  console.log(`mode:        ${live && confirmed ? "LIVE" : "DRY-RUN"}${drill ? ` (drill: ${drill})` : ""}`);
  console.log(`wallet:      ${wallet}`);
  console.log(`subaccount:  ${subaccountId}`);
  console.log(`market/mark: ${MARKET} @ ${mark}`);
  console.log(`clamped:     ${JSON.stringify(clamped, null, 2)}`);

  if (!live || !confirmed) {
    if (live && !confirmed) console.log("\nREFUSED: --live given but CANARY_CONFIRM env is not 'TRADE_REAL_FUNDS'.");
    if (!live && confirmed) console.log("\nDry run (add --live to execute).");
    console.log("\nDry run complete — nothing was written or sent.");
    return;
  }

  // ── Gate 4: execution authorization + HMAC ─────────────────────────────────
  const umkResult = await getUmkForWebhook(wallet);
  if (!umkResult) throw new Error("Wallet has no execution authorization (enable it in the app first — see runbook)");

  let botId = reuseBotId;
  try {
    if (!botId) {
      const policyHmac = computeBotPolicyHmac(umkResult.umk, {
        market: MARKET,
        leverage: MAX_LEVERAGE,
        maxPositionSize: alloc.toFixed(2),
      });
      const bot = await storage.createAiTraderBot({
        walletAddress: wallet,
        protocol: "pacifica",
        protocolSubaccountId: subaccountId,
        market: MARKET,
        timeframe: "15m",
        mode: "suggest",
        riskProfile: "guarded",
        paperMode: false, // live canary
        model: "manual/canary",
        allocatedUsdc: alloc.toFixed(2),
        maxLeverage: MAX_LEVERAGE,
        stopPolicy: "static",
        graduationState: "waived", // plan: canary must not depend on the WO-6 gate
        graduationCriteria: { periodDays: 30, minTrades: 10, minNetPnl: 0, maxDrawdownPct: 30 },
        policyHmac,
        status: "idle",
      });
      botId = bot.id;
      console.log(`created canary bot ${botId} (graduationState=waived)`);
    }

    const bot = await storage.getAiTraderBot(botId!);
    if (!bot) throw new Error(`bot ${botId} not found`);
    if (bot.walletAddress !== wallet) throw new Error("bot/wallet mismatch — refusing");

    const decision = await storage.insertAiTraderDecision({
      botId: bot.id,
      rawDecision: { ...clamped, source: "canary-script" },
      clampedDecision: clamped,
      contextDigest: { market: MARKET, price: mark, canary: true },
    });
    console.log(`decision row ${decision.id} inserted — executing…`);

    const result = await executeDecision({ bot, decisionId: decision.id, clamped, adapter, markPrice: mark });
    console.log(`\nexecuteDecision → ${JSON.stringify(result, null, 2)}`);
    console.log(
      drill === "bracket-fail"
        ? "\nEXPECTED for this drill: ok:false reason:'bracket_failed', bot paused, position CLOSED at market. Verify flat on the exchange NOW."
        : "\nVerify on the exchange: position open, BOTH bracket legs resting. Then follow the runbook for the SL/TP close legs."
    );
    console.log(`policy object used: ${JSON.stringify(aiTraderPolicyObject(bot))}`);
  } finally {
    umkResult.cleanup();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\nCANARY ABORTED: ${err?.message ?? err}`);
    process.exit(1);
  });
