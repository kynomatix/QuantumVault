import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { CycleFinish, CycleStart } from "@shared/ai-trader-cycle";

// bundle-v1 uses the shared database: create and delete only this suite's bots.
describe.skipIf(!process.env.DATABASE_URL)("durable cycle admission and retention", () => {
  let storage: typeof import("../../server/storage")["storage"];
  let db: typeof import("../../server/db")["db"];
  let schema: typeof import("@shared/schema");
  const bots: string[] = [];
  const ownerBootId = randomUUID();
  const terminal: CycleFinish = { phase: "preflight", outcome: "skipped", reasonCode: "paused", finishedAt: new Date(),
    rearmed: false, nextPlannedBoundary: null, candidateCount: 0, modelCallCount: 0, decisionIds: [],
    promptVersionHash: null, contextVersionHash: null, details: {} };
  beforeAll(async () => {
    ({ storage } = await import("../../server/storage"));
    const database = await import("../../server/db"); db = database.db;
    await database.ensureSchema(); schema = await import("@shared/schema");
  }, 120_000);
  afterAll(async () => {
    for (const id of bots) await db.delete(schema.aiTraderBots).where(eq(schema.aiTraderBots.id, id));
  });
  async function newBot() {
    const bot = await storage.createAiTraderBot({ walletAddress: `cycle-test-${randomUUID()}`, protocol: "pacifica", market: "SOL-PERP",
      timeframe: "4h", allocatedUsdc: "100", graduationCriteria: { periodDays: 30, minTrades: 10, minNetPnl: 0, maxDrawdownPct: 30 }, policyHmac: "EXAMPLE" } as any);
    bots.push(bot.id); return bot.id;
  }
  function start(botId: string, startedAt = new Date()): CycleStart {
    return { id: randomUUID(), botId, plannedBoundary: startedAt, startedAt, botUpdatedAt: null, protocol: "pacifica",
      market: "SOL-PERP", timeframe: "4h", marketSource: "fixed", paperMode: true, model: "EXAMPLE", ownerBootId, details: {} };
  }
  it("starts and finalizes idempotently, enforces owners, and cascades bot deletion", async () => {
    const botId = await newBot(); const value = start(botId);
    await storage.startAiTraderCycle(value); await storage.startAiTraderCycle(value);
    await expect(storage.startAiTraderCycle({ ...value, botId: await newBot() })).rejects.toThrow("cycle_receipt_owner_mismatch");
    await expect(storage.startAiTraderCycle({ ...value, ownerBootId: randomUUID() })).rejects.toThrow("cycle_receipt_owner_mismatch");
    await expect(storage.finishAiTraderCycle(value.id, botId, randomUUID(), { ...terminal, finishedAt: new Date() })).rejects.toThrow();
    await storage.finishAiTraderCycle(value.id, botId, ownerBootId, { ...terminal, finishedAt: new Date() });
    await storage.finishAiTraderCycle(value.id, botId, ownerBootId, { ...terminal, finishedAt: new Date() });
    expect((await storage.getLatestAiTraderCycle(botId))?.reasonCode).toBe("paused");
    await expect(storage.finishAiTraderCycle(value.id, botId, ownerBootId, { ...terminal, outcome: "executed" })).rejects.toThrow();
    await db.delete(schema.aiTraderBots).where(eq(schema.aiTraderBots.id, botId));
    expect(await storage.getLatestAiTraderCycle(botId)).toBeUndefined();
  });
  it("serializes concurrent admission at 1024 and never deletes running rows", async () => {
    const botId = await newBot(); const running = start(botId, new Date(Date.now() - 1000));
    await db.insert(schema.aiTraderCycles).values([running, ...Array.from({ length: 1023 }, () => ({ ...start(botId, new Date(Date.now() - 5000)), ...terminal, finishedAt: new Date() }))]);
    const entrants = [start(botId), start(botId)];
    await Promise.all(entrants.map(value => storage.startAiTraderCycle(value)));
    const rows = await db.select().from(schema.aiTraderCycles).where(eq(schema.aiTraderCycles.botId, botId));
    expect(rows).toHaveLength(1024); expect(rows.filter(row => row.outcome === "running")).toHaveLength(3);
    expect(rows.some(row => row.id === running.id)).toBe(true);
  });
  it("refuses an all-running ledger and retains sole old evidence without age-only recovery", async () => {
    const botId = await newBot(); const old = start(botId, new Date(Date.now() - 40 * 86_400_000));
    await db.insert(schema.aiTraderCycles).values({ ...old, ...terminal });
    const latest = start(botId); await storage.startAiTraderCycle(latest);
    expect((await db.select().from(schema.aiTraderCycles).where(eq(schema.aiTraderCycles.botId, botId))).some(row => row.id === old.id)).toBe(true);
    await storage.startAiTraderCycle(start(botId));
    expect((await db.select().from(schema.aiTraderCycles).where(eq(schema.aiTraderCycles.botId, botId))).some(row => row.id === old.id)).toBe(false);
    const fullBot = await newBot(); const starts = Array.from({ length: 1024 }, () => start(fullBot, old.startedAt));
    await db.insert(schema.aiTraderCycles).values(starts);
    await expect(storage.startAiTraderCycle(start(fullBot))).rejects.toThrow("cycle_ledger_all_running");
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.aiTraderCycles).where(eq(schema.aiTraderCycles.botId, fullBot));
    expect(count).toBe(1024);
  });
  it("rejects cross-bot decision links and malformed/oversized receipt shapes", async () => {
    const botId = await newBot(); const value = start(botId); await storage.startAiTraderCycle(value);
    const otherBot = await newBot();
    const decision = await storage.insertAiTraderDecision({ botId: otherBot, market: "SOL-PERP", rawDecision: { action: "flat" }, outcome: "flat" } as any);
    await expect(storage.finishAiTraderCycle(value.id, botId, ownerBootId, { ...terminal, finishedAt: new Date(), decisionIds: [decision.id] })).rejects.toThrow("cycle_decision_owner_mismatch");
    await expect(storage.startAiTraderCycle({ ...start(botId), details: { text: "x".repeat(8193) } })).rejects.toThrow();
    await expect(db.execute(sql`UPDATE ai_trader_cycles SET outcome = 'executed', finished_at = clock_timestamp(), rearmed = false, reason_code = 'not_a_cycle_reason' WHERE id = ${value.id}`)).rejects.toThrow();
  });
});
