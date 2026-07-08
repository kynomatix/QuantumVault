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
});
