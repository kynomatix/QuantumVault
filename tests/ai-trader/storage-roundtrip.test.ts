// WO-2 acceptance test: exercises the real Postgres-backed AI Trader storage
// methods (aiTraderBots / aiTraderDecisions, Agentic Trader plan §7) against a
// throwaway bot + decision row. Skipped when DATABASE_URL is absent so the
// suite still runs in a DB-less environment (mirrors tests/lab-agent/turn-lease.test.ts).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const HAS_DB = !!process.env.DATABASE_URL;
const WALLET = "ai-trader-test-" + Math.random().toString(36).slice(2);

describe.skipIf(!HAS_DB)("AI Trader storage round-trip (WO-2)", () => {
  let storage: typeof import("../../server/storage")["storage"];
  let db: typeof import("../../server/db")["db"];
  let aiTraderBots: typeof import("@shared/schema")["aiTraderBots"];
  let aiTraderDecisions: typeof import("@shared/schema")["aiTraderDecisions"];

  let botId: string;
  let decisionId: string;

  beforeAll(async () => {
    ({ storage } = await import("../../server/storage"));
    ({ db } = await import("../../server/db"));
    ({ aiTraderBots, aiTraderDecisions } = await import("@shared/schema"));
  });

  afterAll(async () => {
    // Deleting the bot cascades to its decisions (FK onDelete: 'cascade'),
    // but delete decisions explicitly first in case cascade isn't set up as expected.
    if (botId) {
      await db.delete(aiTraderDecisions).where(eq(aiTraderDecisions.botId, botId));
      await db.delete(aiTraderBots).where(eq(aiTraderBots.id, botId));
    }
  });

  it("createAiTraderBot inserts a row with the given fields", async () => {
    const bot = await storage.createAiTraderBot({
      walletAddress: WALLET,
      protocol: "pacifica",
      market: "SOL-PERP",
      timeframe: "1h",
      allocatedUsdc: "100.00",
      graduationCriteria: { periodDays: 30, minTrades: 10, minNetPnl: 0, maxDrawdownPct: 30 },
      policyHmac: "test-hmac-signature",
    } as any);

    expect(bot.id).toBeTruthy();
    expect(bot.walletAddress).toBe(WALLET);
    expect(bot.protocol).toBe("pacifica");
    expect(bot.status).toBe("idle"); // default
    expect(bot.mode).toBe("suggest"); // default
    expect(bot.paperMode).toBe(true); // default
    botId = bot.id;
  });

  it("getAiTraderBot returns the row by id", async () => {
    const bot = await storage.getAiTraderBot(botId);
    expect(bot).toBeDefined();
    expect(bot!.id).toBe(botId);
  });

  it("getAiTraderBotsByWallet returns the bot for its wallet", async () => {
    const bots = await storage.getAiTraderBotsByWallet(WALLET);
    expect(bots.some((b) => b.id === botId)).toBe(true);
  });

  it("getActiveAiTraderBots includes a non-stopped bot", async () => {
    const active = await storage.getActiveAiTraderBots();
    expect(active.some((b) => b.id === botId)).toBe(true);
  });

  it("updateAiTraderBot updates fields and bumps updatedAt", async () => {
    const before = await storage.getAiTraderBot(botId);
    const updated = await storage.updateAiTraderBot(botId, { status: "open" as any });
    expect(updated).toBeDefined();
    expect(updated!.status).toBe("open");
    expect(new Date(updated!.updatedAt!).getTime()).toBeGreaterThanOrEqual(
      new Date(before!.updatedAt!).getTime()
    );
  });

  it("getActiveAiTraderBots excludes a stopped bot", async () => {
    await storage.updateAiTraderBot(botId, { status: "stopped" as any });
    const active = await storage.getActiveAiTraderBots();
    expect(active.some((b) => b.id === botId)).toBe(false);
    // restore for subsequent tests
    await storage.updateAiTraderBot(botId, { status: "open" as any });
  });

  it("insertAiTraderDecision creates a decision row tied to the bot", async () => {
    const decision = await storage.insertAiTraderDecision({
      botId,
      rawDecision: { action: "open_long", confidence: 0.8 },
    } as any);
    expect(decision.id).toBeTruthy();
    expect(decision.botId).toBe(botId);
    decisionId = decision.id;
  });

  it("getAiTraderDecisions returns decisions for the bot, most recent first", async () => {
    const decisions = await storage.getAiTraderDecisions(botId, 10);
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    expect(decisions[0].id).toBe(decisionId);
  });

  it("updateAiTraderDecision updates outcome/closedAt", async () => {
    const closedAt = new Date();
    const updated = await storage.updateAiTraderDecision(decisionId, {
      outcome: "executed" as any,
      realizedPnl: "12.50" as any,
      closedAt,
    } as any);
    expect(updated).toBeDefined();
    expect(updated!.outcome).toBe("executed");
    expect(updated!.closedAt).toBeTruthy();
  });

  it("getRecentClosedDecisions only returns decisions with closedAt set", async () => {
    // Add a second, never-closed decision to prove the filter excludes it.
    await storage.insertAiTraderDecision({
      botId,
      rawDecision: { action: "flat" },
    } as any);

    const closed = await storage.getRecentClosedDecisions(botId, 10);
    expect(closed.length).toBe(1);
    expect(closed[0].id).toBe(decisionId);
    expect(closed.every((d) => d.closedAt !== null)).toBe(true);
  });

  // getExecutedDecisions: returns only executed rows (including open trades with closedAt null),
  // and surfaces a trade buried under many flat rows.
  it("getExecutedDecisions returns executed rows and surfaces trades beyond flat-row window", async () => {
    const EXEC_WALLET = "ai-trader-exec-test-" + Math.random().toString(36).slice(2);
    let execBotId: string | undefined;
    try {
      const execBot = await storage.createAiTraderBot({
        walletAddress: EXEC_WALLET,
        protocol: "pacifica",
        market: "SOL-PERP",
        timeframe: "15m",
        allocatedUsdc: "100.00",
        graduationCriteria: { periodDays: 30, minTrades: 10, minNetPnl: 0, maxDrawdownPct: 30 },
        policyHmac: "exec-test-hmac",
      } as any);
      execBotId = execBot.id;

      // Insert 5 flat decisions (will crowd the top of the recency window).
      for (let i = 0; i < 5; i++) {
        await storage.insertAiTraderDecision({
          botId: execBotId,
          rawDecision: { action: "flat", i },
          outcome: "flat",
        } as any);
      }
      // Insert 1 executed trade (no closedAt — open position).
      const openTrade = await storage.insertAiTraderDecision({
        botId: execBotId,
        rawDecision: { action: "open_long" },
        outcome: "executed",
      } as any);
      // Insert 1 executed trade with closedAt set.
      const closedTrade = await storage.insertAiTraderDecision({
        botId: execBotId,
        rawDecision: { action: "open_long" },
        outcome: "executed",
        closedAt: new Date(),
        realizedPnl: "5.00",
      } as any);

      const execDecisions = await storage.getExecutedDecisions(execBotId, 100);
      const ids = execDecisions.map((d) => d.id);
      // Must include both executed rows regardless of closedAt.
      expect(ids).toContain(openTrade.id);
      expect(ids).toContain(closedTrade.id);
      // Must NOT include any flat rows.
      expect(execDecisions.every((d) => d.outcome === "executed")).toBe(true);
      // With limit=2 the 5 flat rows don't crowd out the trades.
      const limitedExec = await storage.getExecutedDecisions(execBotId, 2);
      expect(limitedExec.length).toBe(2);
      expect(limitedExec.every((d) => d.outcome === "executed")).toBe(true);
    } finally {
      if (execBotId) {
        await db.delete(aiTraderDecisions).where(eq(aiTraderDecisions.botId, execBotId));
        await db.delete(aiTraderBots).where(eq(aiTraderBots.id, execBotId));
      }
    }
  });

  // compressOldAiTraderDecisions: strips jsonb from old non-trade rows, never touches executed rows.
  it("compressOldAiTraderDecisions thins old flat rows but never executed rows, is idempotent, and leaves recent rows untouched", async () => {
    const COMP_WALLET = "ai-trader-comp-test-" + Math.random().toString(36).slice(2);
    let compBotId: string | undefined;
    try {
      const compBot = await storage.createAiTraderBot({
        walletAddress: COMP_WALLET,
        protocol: "pacifica",
        market: "SOL-PERP",
        timeframe: "15m",
        allocatedUsdc: "100.00",
        graduationCriteria: { periodDays: 30, minTrades: 10, minNetPnl: 0, maxDrawdownPct: 30 },
        policyHmac: "comp-test-hmac",
      } as any);
      compBotId = compBot.id;

      const OLD_DATE = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000); // 35 days ago
      const SCALAR_COST = "0.001200";
      const SCALAR_FEE  = "0.005000";

      // Old flat row (should be thinned).
      const oldFlat = await storage.insertAiTraderDecision({
        botId: compBotId,
        rawDecision: { action: "flat", rationale: "no signal" },
        contextDigest: { price: 150, rsi: 55 },
        clampedDecision: { action: "flat" },
        guardrailViolations: [{ code: "MAX_LOSS" }],
        outcome: "flat",
        llmCostUsd: SCALAR_COST,
        feesPaid: SCALAR_FEE,
      } as any);
      // Backdate decidedAt (defaultNow is set at insert, so update after).
      await db.update(aiTraderDecisions).set({ decidedAt: OLD_DATE }).where(eq(aiTraderDecisions.id, oldFlat.id));

      // Old executed row (must NEVER be thinned).
      const oldExec = await storage.insertAiTraderDecision({
        botId: compBotId,
        rawDecision: { action: "open_long", confidence: 0.9 },
        contextDigest: { price: 148 },
        outcome: "executed",
        closedAt: OLD_DATE,
        realizedPnl: "12.50",
        llmCostUsd: SCALAR_COST,
        feesPaid: SCALAR_FEE,
      } as any);
      await db.update(aiTraderDecisions).set({ decidedAt: OLD_DATE }).where(eq(aiTraderDecisions.id, oldExec.id));

      // Old null-outcome row (in-flight, must NOT be thinned).
      const oldNull = await storage.insertAiTraderDecision({
        botId: compBotId,
        rawDecision: { action: "open_long" },
      } as any);
      await db.update(aiTraderDecisions).set({ decidedAt: OLD_DATE }).where(eq(aiTraderDecisions.id, oldNull.id));

      // Recent flat row (NOT old enough, must be untouched).
      const recentFlat = await storage.insertAiTraderDecision({
        botId: compBotId,
        rawDecision: { action: "flat", rationale: "recent" },
        contextDigest: { price: 151 },
        outcome: "flat",
        llmCostUsd: SCALAR_COST,
        feesPaid: SCALAR_FEE,
      } as any);

      // Run the sweep.
      const n = await storage.compressOldAiTraderDecisions(30, 500);
      expect(n).toBeGreaterThanOrEqual(1); // at least the old flat row

      // Old flat row: heavy jsonb stripped, raw_decision = stub, scalars preserved.
      const [thinned] = await db.select().from(aiTraderDecisions).where(eq(aiTraderDecisions.id, oldFlat.id));
      expect(thinned.contextDigest).toBeNull();
      expect(thinned.clampedDecision).toBeNull();
      expect(thinned.guardrailViolations).toBeNull();
      expect((thinned.rawDecision as any)?.compressed).toBe(true);
      expect(thinned.outcome).toBe("flat");
      expect(thinned.llmCostUsd).toBe(SCALAR_COST);
      expect(thinned.feesPaid).toBe(SCALAR_FEE);

      // Old executed row: byte-identical (never thinned).
      const [execRow] = await db.select().from(aiTraderDecisions).where(eq(aiTraderDecisions.id, oldExec.id));
      expect((execRow.rawDecision as any)?.compressed).toBeUndefined();
      expect(execRow.contextDigest).not.toBeNull();

      // Old null-outcome row: untouched (not in allowlist).
      const [nullRow] = await db.select().from(aiTraderDecisions).where(eq(aiTraderDecisions.id, oldNull.id));
      expect((nullRow.rawDecision as any)?.compressed).toBeUndefined();

      // Recent flat row: untouched (not old enough).
      const [recentRow] = await db.select().from(aiTraderDecisions).where(eq(aiTraderDecisions.id, recentFlat.id));
      expect((recentRow.rawDecision as any)?.compressed).toBeUndefined();
      expect(recentRow.contextDigest).not.toBeNull();

      // Idempotency: second run returns 0 for already-thinned rows.
      const n2 = await storage.compressOldAiTraderDecisions(30, 500);
      // n2 may be > 0 if there are other old flat rows in the DB from prior tests,
      // but the already-thinned row must NOT be updated again — confirm by re-reading.
      const [thinnedAgain] = await db.select().from(aiTraderDecisions).where(eq(aiTraderDecisions.id, oldFlat.id));
      expect((thinnedAgain.rawDecision as any)?.compressed).toBe(true); // still stub, not double-processed
      void n2; // suppress unused warning
    } finally {
      if (compBotId) {
        await db.delete(aiTraderDecisions).where(eq(aiTraderDecisions.botId, compBotId));
        await db.delete(aiTraderBots).where(eq(aiTraderBots.id, compBotId));
      }
    }
  });

  // WO-8e: degen-persistence proof — createAiTraderBot must store riskProfile:'degen'
  // in the DB row, not silently fall back to the column default ('guarded').
  it("createAiTraderBot persists a non-default riskProfile ('degen')", async () => {
    const DEGEN_WALLET = "ai-trader-degen-test-" + Math.random().toString(36).slice(2);
    let degenBotId: string | undefined;
    try {
      const bot = await storage.createAiTraderBot({
        walletAddress: DEGEN_WALLET,
        protocol: "pacifica",
        market: "SOL-PERP",
        timeframe: "15m",
        mode: "suggest",
        riskProfile: "degen",
        paperMode: true,
        autoNext: false,
        model: "test/model",
        allocatedUsdc: "100.00",
        maxLeverage: 3,
        stopPolicy: "static",
        parkWhenIdle: false,
        graduationState: "in_trial",
        graduationCriteria: { periodDays: 30, minTrades: 10, minNetPnl: 0, maxDrawdownPct: 30 },
        policyHmac: "test-hmac-degen",
        status: "idle",
        pauseReason: null,
        dailyRealizedPnl: "0",
        consecutiveLosses: 0,
      } as any);
      degenBotId = bot.id;

      // Both the RETURNING row from INSERT and a fresh SELECT must carry 'degen'.
      expect(bot.riskProfile).toBe("degen");
      const fetched = await storage.getAiTraderBot(bot.id);
      expect(fetched?.riskProfile).toBe("degen");
    } finally {
      if (degenBotId) {
        await db.delete(aiTraderBots).where(eq(aiTraderBots.id, degenBotId));
      }
    }
  });
});
