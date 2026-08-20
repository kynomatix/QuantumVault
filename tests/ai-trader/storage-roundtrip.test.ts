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
  let pool: typeof import("../../server/db")["pool"];
  let journal: typeof import("../../server/ai-trader/execution-journal");
  let aiTraderBots: typeof import("@shared/schema")["aiTraderBots"];
  let aiTraderDecisions: typeof import("@shared/schema")["aiTraderDecisions"];

  let botId: string;
  let decisionId: string;
  let authorityBotId: string;

  beforeAll(async () => {
    ({ storage } = await import("../../server/storage"));
    ({ db, pool } = await import("../../server/db"));
    journal = await import("../../server/ai-trader/execution-journal");
    ({ aiTraderBots, aiTraderDecisions } = await import("@shared/schema"));
  });

  afterAll(async () => {
    // Deleting the bot cascades to its decisions (FK onDelete: 'cascade'),
    // but delete decisions explicitly first in case cascade isn't set up as expected.
    if (botId) {
      await db.delete(aiTraderDecisions).where(eq(aiTraderDecisions.botId, botId));
      await db.delete(aiTraderBots).where(eq(aiTraderBots.id, botId));
    }
    if (authorityBotId) {
      await db.delete(aiTraderDecisions).where(eq(aiTraderDecisions.botId, authorityBotId));
      await db.delete(aiTraderBots).where(eq(aiTraderBots.id, authorityBotId));
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

  it("serializes analysis, proposal, execution, and terminal release with compare-and-swap guards", async () => {
    const authorityBot = await storage.createAiTraderBot({
      walletAddress: WALLET,
      protocol: "pacifica",
      market: "BTC-PERP",
      timeframe: "15m",
      allocatedUsdc: "100.00",
      graduationCriteria: { periodDays: 30, minTrades: 10, minNetPnl: 0, maxDrawdownPct: 30 },
      policyHmac: "authority-hmac",
    } as any);
    authorityBotId = authorityBot.id;

    const claimed = await storage.claimAiTraderAnalysis({ botId: authorityBotId, expectedStatus: "idle" });
    expect(claimed?.status).toBe("analyzing");
    expect(await storage.claimAiTraderAnalysis({ botId: authorityBotId, expectedStatus: "idle" })).toBeUndefined();

    const decision = await storage.insertAiTraderDecision({
      botId: authorityBotId,
      rawDecision: { action: "long" },
      decidedAt: new Date(),
    } as any);
    const bound = await storage.bindAiTraderProposal({ botId: authorityBotId, decisionId: decision.id });
    expect(bound?.bot.status).toBe("proposed");
    expect(bound?.decision.id).toBe(decision.id);

    const executed = await storage.claimAiTraderExecution({
      botId: authorityBotId,
      decisionId: decision.id,
      expectedStatus: "proposed",
      now: new Date(),
      expiryMs: 10 * 60_000,
    });
    expect(executed?.bot.status).toBe("executing");
    expect(await storage.claimAiTraderExecution({
      botId: authorityBotId,
      decisionId: decision.id,
      expectedStatus: "proposed",
      now: new Date(),
      expiryMs: 10 * 60_000,
    })).toBeUndefined();

    const released = await storage.transitionAiTraderState({
      botId: authorityBotId,
      expectedStatus: "executing",
      expectedPauseReason: null,
      nextStatus: "idle",
      nextPauseReason: null,
      decisionId: decision.id,
      expectedDecisionOutcome: null,
      decisionOutcome: "aborted_guard",
    });
    expect(released?.status).toBe("idle");
    expect(await storage.transitionAiTraderState({
      botId: authorityBotId,
      expectedStatus: "executing",
      expectedPauseReason: null,
      nextStatus: "idle",
      nextPauseReason: null,
    })).toBeUndefined();

    const raceDecision = await storage.insertAiTraderDecision({
      botId: authorityBotId,
      rawDecision: { action: "long" },
      decidedAt: new Date(),
    } as any);
    const lostBotCas = await storage.transitionAiTraderState({
      botId: authorityBotId,
      expectedStatus: "proposed",
      expectedPauseReason: null,
      nextStatus: "idle",
      nextPauseReason: null,
      decisionId: raceDecision.id,
      expectedDecisionOutcome: null,
      decisionOutcome: "expired",
    });
    expect(lostBotCas).toBeUndefined();
    expect((await storage.getAiTraderDecision(raceDecision.id))?.outcome).toBeNull();
    expect((await storage.getUnresolvedAiTraderDecisions(authorityBotId, 2)).map((row) => row.id))
      .toContain(raceDecision.id);
  });

  it("atomically commits and exactly replays a paper decision, bot, and journal tuple", async () => {
    const atomicBot = await storage.createAiTraderBot({
      walletAddress: `${WALLET}-atomic-success`, protocol: "pacifica", market: "SOL-PERP", timeframe: "15m",
      allocatedUsdc: "100.00",
      graduationCriteria: { periodDays: 30, minTrades: 10, minNetPnl: 0, maxDrawdownPct: 30 },
      policyHmac: "atomic-success-hmac",
    } as any);
    try {
      await storage.updateAiTraderBot(atomicBot.id, { status: "executing" as any });
      const decision = await storage.insertAiTraderDecision({
        botId: atomicBot.id,
        rawDecision: { action: "long" },
        decidedAt: new Date("2026-08-19T00:00:00.000Z"),
      } as any);
      const observedAt = new Date(decision.decidedAt!);
      const attemptId = journal.entryAttemptId(decision.id);
      const base = journal.journalBase(atomicBot, decision.id);
      const journalEvents = [
        { ...base, attemptId, action: "entry", cause: "paper", eventType: "attempt_claimed", side: "long", observedAt },
        { ...base, attemptId, action: "entry", cause: "paper", eventType: "fill_observed", side: "long", price: 150.25, sizeBase: 2, observedAt },
        { ...base, attemptId, action: "entry", cause: "paper", eventType: "entry_terminal_open", side: "long", price: 150.25, sizeBase: 2, observedAt },
      ] as const;
      const params = {
        botId: atomicBot.id, decisionId: decision.id, entryPrice: 150.25, sizeBase: 2,
        side: "long" as const, observedAt, journalEvents,
      };

      const applied = await storage.commitAiTraderPaperEntryTransition(params);
      expect(applied).toMatchObject({ status: "applied", decision: { outcome: "executed", entryPrice: "150.25000000" }, bot: { status: "open", pauseReason: null } });
      const replayed = await storage.commitAiTraderPaperEntryTransition(params);
      expect(replayed).toMatchObject({ status: "replayed", decision: { outcome: "executed" }, bot: { status: "open" } });
      const rows = await pool.query(
        "SELECT event_type, count(*)::int AS count FROM ai_trader_execution_events WHERE attempt_id=$1 GROUP BY event_type ORDER BY event_type",
        [attemptId],
      );
      expect(rows.rows).toEqual([
        { event_type: "attempt_claimed", count: 1 },
        { event_type: "entry_terminal_open", count: 1 },
        { event_type: "fill_observed", count: 1 },
      ]);
    } finally {
      await db.delete(aiTraderDecisions).where(eq(aiTraderDecisions.botId, atomicBot.id));
      await db.delete(aiTraderBots).where(eq(aiTraderBots.id, atomicBot.id));
    }
  });

  it("returns exact typed conflicts for lost decision, lost bot, and partial journal state", async () => {
    for (const kind of ["decision", "bot", "journal"] as const) {
      const atomicBot = await storage.createAiTraderBot({
        walletAddress: `${WALLET}-atomic-${kind}`, protocol: "pacifica", market: "SOL-PERP", timeframe: "15m",
        allocatedUsdc: "100.00",
        graduationCriteria: { periodDays: 30, minTrades: 10, minNetPnl: 0, maxDrawdownPct: 30 },
        policyHmac: `atomic-${kind}-hmac`,
      } as any);
      try {
        await storage.updateAiTraderBot(atomicBot.id, { status: "executing" as any });
        const decision = await storage.insertAiTraderDecision({
          botId: atomicBot.id, rawDecision: { action: "short" }, decidedAt: new Date(),
        } as any);
        const observedAt = new Date(decision.decidedAt!);
        const attemptId = journal.entryAttemptId(decision.id);
        const base = journal.journalBase(atomicBot, decision.id);
        const journalEvents = [
          { ...base, attemptId, action: "entry", cause: "paper", eventType: "attempt_claimed", side: "short", observedAt },
          { ...base, attemptId, action: "entry", cause: "paper", eventType: "fill_observed", side: "short", price: 149.75, sizeBase: 1, observedAt },
          { ...base, attemptId, action: "entry", cause: "paper", eventType: "entry_terminal_open", side: "short", price: 149.75, sizeBase: 1, observedAt },
        ] as const;
        if (kind === "decision") await storage.updateAiTraderDecision(decision.id, { outcome: "flat" } as any);
        if (kind === "bot") await storage.updateAiTraderBot(atomicBot.id, { status: "idle" as any });
        if (kind === "journal") await journal.appendExecutionEvents([journalEvents[0]]);

        const result = await storage.commitAiTraderPaperEntryTransition({
          botId: atomicBot.id, decisionId: decision.id, entryPrice: 149.75, sizeBase: 1,
          side: "short", observedAt, journalEvents,
        });
        expect(result).toEqual({
          status: "conflict",
          reason: kind === "decision" ? "decision_state_conflict"
            : kind === "bot" ? "bot_state_conflict" : "journal_state_conflict",
        });
      } finally {
        await db.delete(aiTraderDecisions).where(eq(aiTraderDecisions.botId, atomicBot.id));
        await db.delete(aiTraderBots).where(eq(aiTraderBots.id, atomicBot.id));
      }
    }
  });

  it("real PostgreSQL faults after each prospective mutation roll back the whole paper tuple", async () => {
    const safeIdentifier = `qv_atomic_${Date.now()}_${Math.random().toString(36).slice(2)}`.replace(/[^a-z0-9_]/g, "");
    const cases = [
      { stage: "decision", table: "ai_trader_decisions", operation: "UPDATE", key: "id" },
      { stage: "bot", table: "ai_trader_bots", operation: "UPDATE", key: "id" },
      { stage: "journal", table: "ai_trader_execution_events", operation: "INSERT", key: "attempt_id" },
    ] as const;
    for (const testCase of cases) {
      const atomicBot = await storage.createAiTraderBot({
        walletAddress: `${WALLET}-fault-${testCase.stage}`, protocol: "pacifica", market: "SOL-PERP", timeframe: "15m",
        allocatedUsdc: "100.00",
        graduationCriteria: { periodDays: 30, minTrades: 10, minNetPnl: 0, maxDrawdownPct: 30 },
        policyHmac: `fault-${testCase.stage}-hmac`,
      } as any);
      const decision = await storage.insertAiTraderDecision({
        botId: atomicBot.id, rawDecision: { action: "long" }, decidedAt: new Date(),
      } as any);
      await storage.updateAiTraderBot(atomicBot.id, { status: "executing" as any });
      const observedAt = new Date(decision.decidedAt!);
      const attemptId = journal.entryAttemptId(decision.id);
      const base = journal.journalBase(atomicBot, decision.id);
      const journalEvents = [
        { ...base, attemptId, action: "entry", cause: "paper", eventType: "attempt_claimed", side: "long", observedAt },
        { ...base, attemptId, action: "entry", cause: "paper", eventType: "fill_observed", side: "long", price: 151, sizeBase: 1.5, observedAt },
        { ...base, attemptId, action: "entry", cause: "paper", eventType: "entry_terminal_open", side: "long", price: 151, sizeBase: 1.5, observedAt },
      ] as const;
      const functionName = `${safeIdentifier}_${testCase.stage}_fn`;
      const triggerName = `${safeIdentifier}_${testCase.stage}_trg`;
      const keyValue = (testCase.stage === "bot" ? atomicBot.id : testCase.stage === "decision" ? decision.id : attemptId)
        .replace(/'/g, "''");
      try {
        await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'atomic_fault_${testCase.stage}'; END; $$`);
        await pool.query(`CREATE TRIGGER ${triggerName} AFTER ${testCase.operation} ON ${testCase.table} FOR EACH ROW WHEN (NEW.${testCase.key} = '${keyValue}') EXECUTE FUNCTION ${functionName}()`);
        await expect(storage.commitAiTraderPaperEntryTransition({
          botId: atomicBot.id, decisionId: decision.id, entryPrice: 151, sizeBase: 1.5,
          side: "long", observedAt, journalEvents,
        })).rejects.toThrow(`atomic_fault_${testCase.stage}`);
      } finally {
        await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON ${testCase.table}`);
        await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
      }

      expect(await storage.getAiTraderDecision(decision.id)).toMatchObject({ outcome: null, entryPrice: null });
      expect(await storage.getAiTraderBot(atomicBot.id)).toMatchObject({ status: "executing", pauseReason: null });
      const rows = await pool.query(
        "SELECT count(*)::int AS count FROM ai_trader_execution_events WHERE attempt_id=$1",
        [attemptId],
      );
      expect(rows.rows[0]?.count).toBe(0);
      await db.delete(aiTraderDecisions).where(eq(aiTraderDecisions.botId, atomicBot.id));
      await db.delete(aiTraderBots).where(eq(aiTraderBots.id, atomicBot.id));
    }
  }, 30_000);

  it("atomically commits and replays each direct-live entry disposition with retained command lineage", async () => {
    for (const disposition of ["open", "quarantined", "no_land"] as const) {
      const atomicBot = await storage.createAiTraderBot({
        walletAddress: `${WALLET}-live-${disposition}`, protocol: "pacifica", market: "SOL-PERP", timeframe: "15m",
        allocatedUsdc: "100.00",
        graduationCriteria: { periodDays: 30, minTrades: 10, minNetPnl: 0, maxDrawdownPct: 30 },
        policyHmac: `live-${disposition}-hmac`,
      } as any);
      try {
        await storage.updateAiTraderBot(atomicBot.id, { status: "executing" as any });
        const decision = await storage.insertAiTraderDecision({
          botId: atomicBot.id,
          rawDecision: { action: "long" },
          decidedAt: new Date(`2026-08-19T00:0${disposition === "open" ? 1 : disposition === "quarantined" ? 2 : 3}:00.000Z`),
        } as any);
        const observedAt = new Date(decision.decidedAt!);
        const attemptId = await journal.appendRequiredEntryPrebroadcast({
          bot: atomicBot,
          decisionId: decision.id,
          side: "long",
          clientOrderId: `aitrader-${decision.id}`,
          sizeBase: 2,
        });
        const base = journal.journalBase(atomicBot, decision.id);
        const success = disposition === "open";
        const broadcast = {
          ...journal.orderResultEvent({
            base,
            attemptId,
            action: "entry",
            cause: "decision",
            order: success
              ? { success: true, status: "filled", fillPrice: 150.25, fillSize: 2, orderId: "venue-open" }
              : { success: false, status: "rejected", error: disposition === "quarantined" ? "may still land" : "price band" },
            clientOrderId: `aitrader-${decision.id}`,
            failureCode: disposition === "quarantined" ? "venue_unconfirmed" : disposition === "no_land" ? "venue_rejected" : null,
          }),
          side: "long" as const,
          observedAt,
        } as const;
        const journalEvents = disposition === "open"
          ? [
              broadcast,
              { ...base, attemptId, action: "entry", cause: "decision", eventType: "position_observed", side: "long", price: 150.24, sizeBase: 2, observedAt },
              { ...base, attemptId, action: "entry", cause: "decision", eventType: "fill_observed", side: "long", price: 150.25, sizeBase: 2, observedAt },
              { ...base, attemptId, action: "entry", cause: "decision", eventType: "bracket_verified", side: "long", observedAt },
              { ...base, attemptId, action: "entry", cause: "decision", eventType: "entry_terminal_open", side: "long", price: 150.25, sizeBase: 2, observedAt },
            ]
          : disposition === "quarantined"
            ? [broadcast]
            : [
                broadcast,
                { ...base, attemptId, action: "entry", cause: "decision", eventType: "entry_terminal_no_land", side: "long",
                  failureCode: "venue_rejected", recordedAfterBroadcast: true, observedAt },
              ];
        const params = {
          botId: atomicBot.id,
          decisionId: decision.id,
          disposition,
          side: "long" as const,
          observedAt,
          ...(disposition === "open" ? { entryPrice: 150.25, sizeBase: 2 } : {}),
          journalEvents,
        } as any;

        const applied = await storage.commitAiTraderDirectLiveEntryTransition(params);
        expect(applied).toMatchObject({
          status: "applied",
          decision: { outcome: disposition === "open" ? "executed" : disposition === "quarantined" ? "unconfirmed_landing" : "aborted_order" },
          bot: {
            status: disposition === "open" ? "open" : disposition === "quarantined" ? "paused" : "idle",
            pauseReason: disposition === "quarantined" ? "position_unconfirmed" : null,
          },
        });
        const replayed = await storage.commitAiTraderDirectLiveEntryTransition(params);
        expect(replayed).toMatchObject({ status: "replayed" });
        const rows = await pool.query(
          "SELECT event_type, count(*)::int AS count FROM ai_trader_execution_events WHERE attempt_id=$1 GROUP BY event_type ORDER BY event_type",
          [attemptId],
        );
        expect(rows.rows.reduce((sum: number, row: { count: number }) => sum + row.count, 0))
          .toBe(2 + journalEvents.length);
        expect(rows.rows.every((row: { count: number }) => row.count === 1)).toBe(true);
      } finally {
        await db.delete(aiTraderDecisions).where(eq(aiTraderDecisions.botId, atomicBot.id));
        await db.delete(aiTraderBots).where(eq(aiTraderBots.id, atomicBot.id));
      }
    }
  });

  it("refuses a direct-live terminal transition without exact phase-0/10 command lineage", async () => {
    const atomicBot = await storage.createAiTraderBot({
      walletAddress: `${WALLET}-live-lineage`, protocol: "pacifica", market: "SOL-PERP", timeframe: "15m",
      allocatedUsdc: "100.00",
      graduationCriteria: { periodDays: 30, minTrades: 10, minNetPnl: 0, maxDrawdownPct: 30 },
      policyHmac: "live-lineage-hmac",
    } as any);
    try {
      await storage.updateAiTraderBot(atomicBot.id, { status: "executing" as any });
      const decision = await storage.insertAiTraderDecision({
        botId: atomicBot.id, rawDecision: { action: "long" }, decidedAt: new Date(),
      } as any);
      const observedAt = new Date(decision.decidedAt!);
      const attemptId = journal.entryAttemptId(decision.id);
      const base = journal.journalBase(atomicBot, decision.id);
      const broadcast = {
        ...journal.orderResultEvent({
          base, attemptId, action: "entry", cause: "decision",
          order: { success: false, status: "rejected", error: "price band" },
          failureCode: "venue_rejected",
        }),
        side: "long" as const,
        observedAt,
      };
      const result = await storage.commitAiTraderDirectLiveEntryTransition({
        botId: atomicBot.id,
        decisionId: decision.id,
        disposition: "no_land",
        side: "long",
        observedAt,
        journalEvents: [
          broadcast,
          { ...base, attemptId, action: "entry", cause: "decision", eventType: "entry_terminal_no_land", side: "long",
            failureCode: "venue_rejected", recordedAfterBroadcast: true, observedAt },
        ],
      });
      expect(result).toEqual({ status: "conflict", reason: "journal_state_conflict" });
      expect(await storage.getAiTraderDecision(decision.id)).toMatchObject({ outcome: null });
      expect(await storage.getAiTraderBot(atomicBot.id)).toMatchObject({ status: "executing", pauseReason: null });
    } finally {
      await db.delete(aiTraderDecisions).where(eq(aiTraderDecisions.botId, atomicBot.id));
      await db.delete(aiTraderBots).where(eq(aiTraderBots.id, atomicBot.id));
    }
  });

  it("atomically commits a confirmed close, derives the pause under locks, and exactly replays once", async () => {
    const closeBot = await storage.createAiTraderBot({
      walletAddress: `${WALLET}-close-atomic`, protocol: "pacifica", market: "SOL-PERP", timeframe: "15m",
      allocatedUsdc: "100.00", consecutiveLosses: 2,
      graduationCriteria: { periodDays: 30, minTrades: 10, minNetPnl: 0, maxDrawdownPct: 30 },
      policyHmac: "close-atomic-hmac",
    } as any);
    try {
      await storage.updateAiTraderBot(closeBot.id, { status: "open" as any, consecutiveLosses: 2 });
      const decision = await storage.insertAiTraderDecision({
        botId: closeBot.id, rawDecision: { action: "long" }, clampedDecision: { action: "long" },
        outcome: "executed", entryPrice: "150.00000000", decidedAt: new Date("2026-08-19T01:00:00.000Z"),
      } as any);
      const closedAt = new Date("2026-08-19T02:00:00.000Z");
      const attemptId = journal.newMutationAttemptId("close", decision.id);
      const base = journal.journalBase(closeBot, decision.id);
      const close = { exitPrice: 145, exitReason: "sl", realizedPnl: -10, feesPaid: 0.2, closedAt };
      const journalEvents = [
        { ...base, attemptId, action: "close", cause: "paper", eventType: "attempt_claimed", side: "long", observedAt: closedAt },
        { ...base, attemptId, action: "close", cause: "paper", eventType: "fill_observed", side: "long",
          price: 145, sizeBase: 2, fee: 0.2, realizedPnl: -10, observedAt: closedAt },
        { ...base, attemptId, action: "close", cause: "paper", eventType: "close_terminal_confirmed", side: "long",
          price: 145, sizeBase: 2, fee: 0.2, realizedPnl: -10, observedAt: closedAt },
      ] as const;
      const params = {
        botId: closeBot.id, decisionId: decision.id, expectedBotStatus: "open", expectedPauseReason: null,
        side: "long" as const, sizeBase: 2, close, isStopLossLoss: true, forcedPauseReason: null,
        dayStart: new Date("2026-08-19T00:00:00.000Z"),
        policy: { recentClosedLimit: 60 as const, malfunctionTradesPerDay: 20, consecutiveSlLimit: 3, dailyLossBreakerPct: 15 },
        journalEvents,
      };

      const applied = await storage.commitAiTraderConfirmedCloseTransition(params);
      expect(applied).toMatchObject({
        status: "applied", decision: { closedAt, realizedPnl: "-10.00", feesPaid: "0.200000" },
        bot: { status: "paused", pauseReason: "consecutive_losses", consecutiveLosses: 3, dailyRealizedPnl: "-10.00" },
        closedTodayCount: 1, knownDailyRealizedPnl: -10, dailyRealizedComplete: true,
        journal: { status: "appended", failureCode: null },
      });
      const replayed = await storage.commitAiTraderConfirmedCloseTransition(params);
      expect(replayed).toMatchObject({
        status: "replayed", bot: { consecutiveLosses: 3, dailyRealizedPnl: "-10.00" },
        journal: { status: "replayed", failureCode: null },
      });
      const rows = await pool.query(
        "SELECT count(*)::int AS count FROM ai_trader_execution_events WHERE attempt_id=$1",
        [attemptId],
      );
      expect(rows.rows[0]?.count).toBe(3);

      const otherAttempt = journalEvents.map((event) => ({ ...event, attemptId: journal.newMutationAttemptId("close", decision.id) }));
      expect(await storage.commitAiTraderConfirmedCloseTransition({ ...params, journalEvents: otherAttempt }))
        .toEqual({ status: "conflict", reason: "journal_identity_conflict" });
      expect(await storage.commitAiTraderConfirmedCloseTransition({
        ...params, close: { ...close, exitPrice: 144 },
      })).toEqual({ status: "conflict", reason: "close_state_conflict" });
      expect((await storage.getAiTraderBot(closeBot.id))?.consecutiveLosses).toBe(3);
    } finally {
      await db.delete(aiTraderDecisions).where(eq(aiTraderDecisions.botId, closeBot.id));
      await db.delete(aiTraderBots).where(eq(aiTraderBots.id, closeBot.id));
    }
  });

  it("accepts every exact risk-reducing caller state predicate and derives the idle target", async () => {
    const callerStates = [
      { status: "paused", pauseReason: "position_unconfirmed" },
      { status: "executing", pauseReason: null },
      { status: "analyzing", pauseReason: null },
      { status: "proposed", pauseReason: null },
    ] as const;

    for (const [index, callerState] of callerStates.entries()) {
      const closeBot = await storage.createAiTraderBot({
        walletAddress: `${WALLET}-close-caller-state-${callerState.status}-${index}`,
        protocol: "pacifica", market: "SOL-PERP", timeframe: "15m", allocatedUsdc: "100.00",
        graduationCriteria: { periodDays: 30, minTrades: 10, minNetPnl: 0, maxDrawdownPct: 30 },
        policyHmac: `close-caller-state-${callerState.status}-${index}-hmac`,
      } as any);
      try {
        await storage.updateAiTraderBot(closeBot.id, {
          status: callerState.status as any,
          pauseReason: callerState.pauseReason,
        });
        const decision = await storage.insertAiTraderDecision({
          botId: closeBot.id, rawDecision: { action: "long" }, outcome: "executed",
          entryPrice: "150.00000000", decidedAt: new Date(`2026-08-19T${String(index + 7).padStart(2, "0")}:00:00.000Z`),
        } as any);
        const closedAt = new Date(`2026-08-19T${String(index + 11).padStart(2, "0")}:00:00.000Z`);
        const attemptId = journal.newMutationAttemptId("close", decision.id);
        const base = journal.journalBase(closeBot, decision.id);
        const journalEvents = [
          { ...base, attemptId, action: "close", cause: "venue_detected", eventType: "attempt_claimed", side: "long", observedAt: closedAt },
          { ...base, attemptId, action: "close", cause: "venue_detected", eventType: "fill_observed", side: "long",
            price: 151, sizeBase: 1, fee: 0.1, realizedPnl: 0.9, observedAt: closedAt },
          { ...base, attemptId, action: "close", cause: "venue_detected", eventType: "close_terminal_confirmed", side: "long",
            price: 151, sizeBase: 1, fee: 0.1, realizedPnl: 0.9, observedAt: closedAt },
        ] as const;

        const result = await storage.commitAiTraderConfirmedCloseTransition({
          botId: closeBot.id, decisionId: decision.id,
          expectedBotStatus: callerState.status, expectedPauseReason: callerState.pauseReason,
          side: "long", sizeBase: 1,
          close: { exitPrice: 151, exitReason: "tp", realizedPnl: 0.9, feesPaid: 0.1, closedAt },
          isStopLossLoss: false, forcedPauseReason: null,
          dayStart: new Date("2026-08-19T00:00:00.000Z"),
          policy: { recentClosedLimit: 60, malfunctionTradesPerDay: 20, consecutiveSlLimit: 3, dailyLossBreakerPct: 15 },
          journalEvents,
        });

        expect(result).toMatchObject({
          status: "applied",
          bot: { status: "idle", pauseReason: null },
          journal: { status: "appended", failureCode: null },
        });
      } finally {
        await db.delete(aiTraderDecisions).where(eq(aiTraderDecisions.botId, closeBot.id));
        await db.delete(aiTraderBots).where(eq(aiTraderBots.id, closeBot.id));
      }
    }
  });

  it("commits confirmed close truth with null completeness when journal validation degrades", async () => {
    const closeBot = await storage.createAiTraderBot({
      walletAddress: `${WALLET}-close-degraded-validation`, protocol: "pacifica", market: "SOL-PERP", timeframe: "15m",
      allocatedUsdc: "100.00",
      graduationCriteria: { periodDays: 30, minTrades: 10, minNetPnl: 0, maxDrawdownPct: 30 },
      policyHmac: "close-degraded-validation-hmac",
    } as any);
    try {
      await storage.updateAiTraderBot(closeBot.id, { status: "paused" as any, pauseReason: "user_requested" });
      const decision = await storage.insertAiTraderDecision({
        botId: closeBot.id, rawDecision: { action: "short" }, outcome: "executed",
        entryPrice: "150.00000000", decidedAt: new Date("2026-08-19T03:00:00.000Z"),
      } as any);
      const closedAt = new Date("2026-08-19T04:00:00.000Z");
      const attemptId = journal.newMutationAttemptId("close", decision.id);
      const base = journal.journalBase(closeBot, decision.id);
      const close = { exitPrice: 151, exitReason: "user_close", realizedPnl: null, feesPaid: null, closedAt };
      const malformed = [
        { ...base, attemptId, action: "close", cause: "paper", eventType: "attempt_claimed", side: "short", observedAt: closedAt },
        { ...base, attemptId, action: "close", cause: "paper", eventType: "close_terminal_failed", side: "short", observedAt: closedAt },
      ] as any;
      const result = await storage.commitAiTraderConfirmedCloseTransition({
        botId: closeBot.id, decisionId: decision.id, expectedBotStatus: "paused", expectedPauseReason: "user_requested",
        side: "short", sizeBase: 1, close, isStopLossLoss: false, forcedPauseReason: null,
        dayStart: new Date("2026-08-19T00:00:00.000Z"),
        policy: { recentClosedLimit: 60, malfunctionTradesPerDay: 20, consecutiveSlLimit: 3, dailyLossBreakerPct: 15 },
        journalEvents: malformed,
      });
      expect(result).toMatchObject({
        status: "applied", decision: { closedAt, realizedPnl: null, feesPaid: null },
        bot: { status: "idle", pauseReason: null, dailyRealizedPnl: null },
        dailyRealizedComplete: false,
        journal: { status: "degraded", failureCode: "validation_conflict" },
      });
      const rows = await pool.query("SELECT count(*)::int AS count FROM ai_trader_execution_events WHERE attempt_id=$1", [attemptId]);
      expect(rows.rows[0]?.count).toBe(0);
    } finally {
      await db.delete(aiTraderDecisions).where(eq(aiTraderDecisions.botId, closeBot.id));
      await db.delete(aiTraderBots).where(eq(aiTraderBots.id, closeBot.id));
    }
  });

  it("isolates a real journal insert fault to a savepoint while retaining the confirmed close", async () => {
    const closeBot = await storage.createAiTraderBot({
      walletAddress: `${WALLET}-close-journal-fault`, protocol: "pacifica", market: "SOL-PERP", timeframe: "15m",
      allocatedUsdc: "100.00",
      graduationCriteria: { periodDays: 30, minTrades: 10, minNetPnl: 0, maxDrawdownPct: 30 },
      policyHmac: "close-journal-fault-hmac",
    } as any);
    const safeIdentifier = `qv_close_journal_${Date.now()}_${Math.random().toString(36).slice(2)}`.replace(/[^a-z0-9_]/g, "");
    const functionName = `${safeIdentifier}_fn`;
    const triggerName = `${safeIdentifier}_trg`;
    try {
      await storage.updateAiTraderBot(closeBot.id, { status: "open" as any });
      const decision = await storage.insertAiTraderDecision({
        botId: closeBot.id, rawDecision: { action: "long" }, outcome: "executed",
        entryPrice: "150.00000000", decidedAt: new Date("2026-08-19T05:00:00.000Z"),
      } as any);
      const closedAt = new Date("2026-08-19T06:00:00.000Z");
      const attemptId = journal.newMutationAttemptId("close", decision.id);
      const base = journal.journalBase(closeBot, decision.id);
      const journalEvents = [
        { ...base, attemptId, action: "close", cause: "paper", eventType: "attempt_claimed", side: "long", observedAt: closedAt },
        { ...base, attemptId, action: "close", cause: "paper", eventType: "fill_observed", side: "long", price: 151,
          sizeBase: 1, fee: 0.1, realizedPnl: 0.9, observedAt: closedAt },
        { ...base, attemptId, action: "close", cause: "paper", eventType: "close_terminal_confirmed", side: "long", price: 151,
          sizeBase: 1, fee: 0.1, realizedPnl: 0.9, observedAt: closedAt },
      ] as const;
      const keyValue = attemptId.replace(/'/g, "''");
      await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'close_journal_insert_fault'; END; $$`);
      await pool.query(`CREATE TRIGGER ${triggerName} AFTER INSERT ON ai_trader_execution_events FOR EACH ROW WHEN (NEW.attempt_id = '${keyValue}') EXECUTE FUNCTION ${functionName}()`);
      const params = {
        botId: closeBot.id, decisionId: decision.id, expectedBotStatus: "open", expectedPauseReason: null,
        side: "long", sizeBase: 1,
        close: { exitPrice: 151, exitReason: "tp", realizedPnl: 0.9, feesPaid: 0.1, closedAt },
        isStopLossLoss: false, forcedPauseReason: null, dayStart: new Date("2026-08-19T00:00:00.000Z"),
        policy: { recentClosedLimit: 60, malfunctionTradesPerDay: 20, consecutiveSlLimit: 3, dailyLossBreakerPct: 15 },
        journalEvents,
      } as const;
      const result = await storage.commitAiTraderConfirmedCloseTransition(params);
      expect(result).toMatchObject({
        status: "applied", decision: { closedAt }, bot: { status: "idle" },
        journal: { status: "degraded", failureCode: "insert_failed" },
      });
      expect((await storage.getAiTraderDecision(decision.id))?.closedAt).toEqual(closedAt);
      expect((await storage.getAiTraderBot(closeBot.id))?.status).toBe("idle");
      const rows = await pool.query("SELECT count(*)::int AS count FROM ai_trader_execution_events WHERE attempt_id=$1", [attemptId]);
      expect(rows.rows[0]?.count).toBe(0);
      expect(await storage.commitAiTraderConfirmedCloseTransition(params))
        .toEqual({ status: "conflict", reason: "journal_identity_conflict" });
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON ai_trader_execution_events`);
      await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
      await db.delete(aiTraderDecisions).where(eq(aiTraderDecisions.botId, closeBot.id));
      await db.delete(aiTraderBots).where(eq(aiTraderBots.id, closeBot.id));
    }
  }, 30_000);

  it("rolls back both decision and bot close state on real non-journal database faults", async () => {
    for (const stage of ["decision", "bot"] as const) {
      const closeBot = await storage.createAiTraderBot({
        walletAddress: `${WALLET}-close-outer-fault-${stage}`, protocol: "pacifica", market: "SOL-PERP", timeframe: "15m",
        allocatedUsdc: "100.00",
        graduationCriteria: { periodDays: 30, minTrades: 10, minNetPnl: 0, maxDrawdownPct: 30 },
        policyHmac: `close-outer-fault-${stage}-hmac`,
      } as any);
      const decision = await storage.insertAiTraderDecision({
        botId: closeBot.id, rawDecision: { action: "long" }, outcome: "executed",
        entryPrice: "150.00000000", decidedAt: new Date(),
      } as any);
      await storage.updateAiTraderBot(closeBot.id, { status: "open" as any });
      const closedAt = new Date();
      const attemptId = journal.newMutationAttemptId("close", decision.id);
      const base = journal.journalBase(closeBot, decision.id);
      const events = [
        { ...base, attemptId, action: "close", cause: "paper", eventType: "attempt_claimed", side: "long", observedAt: closedAt },
        { ...base, attemptId, action: "close", cause: "paper", eventType: "fill_observed", side: "long", price: 151, sizeBase: 1, fee: 0.1, realizedPnl: 0.9, observedAt: closedAt },
        { ...base, attemptId, action: "close", cause: "paper", eventType: "close_terminal_confirmed", side: "long", price: 151, sizeBase: 1, fee: 0.1, realizedPnl: 0.9, observedAt: closedAt },
      ] as const;
      const safeIdentifier = `qv_close_outer_${stage}_${Date.now()}_${Math.random().toString(36).slice(2)}`.replace(/[^a-z0-9_]/g, "");
      const functionName = `${safeIdentifier}_fn`;
      const triggerName = `${safeIdentifier}_trg`;
      const table = stage === "decision" ? "ai_trader_decisions" : "ai_trader_bots";
      const key = stage === "decision" ? decision.id : closeBot.id;
      try {
        await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'close_outer_${stage}_fault'; END; $$`);
        await pool.query(`CREATE TRIGGER ${triggerName} AFTER UPDATE ON ${table} FOR EACH ROW WHEN (NEW.id = '${key.replace(/'/g, "''")}') EXECUTE FUNCTION ${functionName}()`);
        await expect(storage.commitAiTraderConfirmedCloseTransition({
          botId: closeBot.id, decisionId: decision.id, expectedBotStatus: "open", expectedPauseReason: null,
          side: "long", sizeBase: 1,
          close: { exitPrice: 151, exitReason: "tp", realizedPnl: 0.9, feesPaid: 0.1, closedAt },
          isStopLossLoss: false, forcedPauseReason: null, dayStart: new Date(0),
          policy: { recentClosedLimit: 60, malfunctionTradesPerDay: 20, consecutiveSlLimit: 3, dailyLossBreakerPct: 15 },
          journalEvents: events,
        })).rejects.toThrow(`close_outer_${stage}_fault`);
      } finally {
        await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON ${table}`);
        await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
      }
      expect(await storage.getAiTraderDecision(decision.id)).toMatchObject({ closedAt: null, exitReason: null });
      expect(await storage.getAiTraderBot(closeBot.id)).toMatchObject({ status: "open", pauseReason: null });
      await db.delete(aiTraderDecisions).where(eq(aiTraderDecisions.botId, closeBot.id));
      await db.delete(aiTraderBots).where(eq(aiTraderBots.id, closeBot.id));
    }
  }, 30_000);

  it("returns exact typed conflicts for every direct-live predicate, lineage, and replay contradiction", async () => {
    const cases = [
      { kind: "decision_outcome", reason: "decision_state_conflict" },
      { kind: "decision_timestamp", reason: "decision_state_conflict" },
      { kind: "bot_status", reason: "bot_state_conflict" },
      { kind: "bot_pause", reason: "bot_state_conflict" },
      { kind: "lineage_identity", reason: "journal_state_conflict" },
      { kind: "phase20", reason: "journal_state_conflict" },
      { kind: "terminal", reason: "journal_state_conflict" },
      { kind: "decision_at_target_only", reason: "bot_state_conflict" },
      { kind: "bot_at_target_only", reason: "decision_state_conflict" },
    ] as const;

    for (const testCase of cases) {
      const atomicBot = await storage.createAiTraderBot({
        walletAddress: `${WALLET}-live-conflict-${testCase.kind}`,
        protocol: "pacifica",
        market: "SOL-PERP",
        timeframe: "15m",
        allocatedUsdc: "100.00",
        graduationCriteria: { periodDays: 30, minTrades: 10, minNetPnl: 0, maxDrawdownPct: 30 },
        policyHmac: `live-conflict-${testCase.kind}-hmac`,
      } as any);
      try {
        await storage.updateAiTraderBot(atomicBot.id, { status: "executing" as any });
        const decision = await storage.insertAiTraderDecision({
          botId: atomicBot.id,
          rawDecision: { action: "long" },
          decidedAt: new Date(),
        } as any);
        const decidedAt = new Date(decision.decidedAt!);
        const observedAt = testCase.kind === "decision_timestamp"
          ? new Date(decidedAt.getTime() + 1)
          : decidedAt;
        const attemptId = await journal.appendRequiredEntryPrebroadcast({
          bot: testCase.kind === "lineage_identity" ? { ...atomicBot, market: "BTC-PERP" } : atomicBot,
          decisionId: decision.id,
          side: "long",
          clientOrderId: `aitrader-${decision.id}`,
          sizeBase: 2,
        });
        const base = journal.journalBase(atomicBot, decision.id);
        const broadcast = {
          ...journal.orderResultEvent({
            base,
            attemptId,
            action: "entry",
            cause: "decision",
            order: { success: true, status: "filled", fillPrice: 150.25, fillSize: 2, orderId: "venue-target" },
            failureCode: null,
          }),
          side: "long" as const,
          observedAt,
        };
        const journalEvents = [
          broadcast,
          { ...base, attemptId, action: "entry", cause: "decision", eventType: "position_observed", side: "long", price: 150.24, sizeBase: 2, observedAt },
          { ...base, attemptId, action: "entry", cause: "decision", eventType: "fill_observed", side: "long", price: 150.25, sizeBase: 2, observedAt },
          { ...base, attemptId, action: "entry", cause: "decision", eventType: "bracket_verified", side: "long", observedAt },
          { ...base, attemptId, action: "entry", cause: "decision", eventType: "entry_terminal_open", side: "long", price: 150.25, sizeBase: 2, observedAt },
        ] as const;

        if (testCase.kind === "decision_outcome") {
          await storage.updateAiTraderDecision(decision.id, { outcome: "flat" } as any);
        } else if (testCase.kind === "bot_status") {
          await storage.updateAiTraderBot(atomicBot.id, { status: "idle" as any });
        } else if (testCase.kind === "bot_pause") {
          await storage.updateAiTraderBot(atomicBot.id, { pauseReason: "position_unconfirmed" } as any);
        } else if (testCase.kind === "phase20" || testCase.kind === "terminal") {
          const preexistingBroadcast = {
            ...journal.orderResultEvent({
              base,
              attemptId,
              action: "entry",
              cause: "decision",
              order: { success: true, status: "filled", fillPrice: 149.5, fillSize: 2, orderId: "venue-preexisting" },
              failureCode: null,
            }),
            side: "long" as const,
            observedAt: decidedAt,
          };
          await journal.appendExecutionEvents(testCase.kind === "terminal"
            ? [
                preexistingBroadcast,
                { ...base, attemptId, action: "entry", cause: "decision", eventType: "entry_terminal_no_land", side: "long",
                  failureCode: "venue_rejected", recordedAfterBroadcast: true, observedAt: decidedAt },
              ]
            : [preexistingBroadcast]);
        } else if (testCase.kind === "decision_at_target_only") {
          await storage.updateAiTraderDecision(decision.id, { outcome: "executed", entryPrice: "150.25000000" } as any);
        } else if (testCase.kind === "bot_at_target_only") {
          await storage.updateAiTraderBot(atomicBot.id, { status: "open" as any, pauseReason: null });
        }

        const snapshot = async () => {
          const currentDecision = await storage.getAiTraderDecision(decision.id);
          const currentBot = await storage.getAiTraderBot(atomicBot.id);
          const rows = await pool.query(
            "SELECT event_identity, event_type, phase, market, venue_order_id FROM ai_trader_execution_events WHERE attempt_id=$1 ORDER BY phase NULLS LAST, event_identity",
            [attemptId],
          );
          return {
            decision: { outcome: currentDecision?.outcome ?? null, entryPrice: currentDecision?.entryPrice ?? null },
            bot: { status: currentBot?.status, pauseReason: currentBot?.pauseReason ?? null },
            rows: rows.rows,
          };
        };
        const before = await snapshot();
        const result = await storage.commitAiTraderDirectLiveEntryTransition({
          botId: atomicBot.id,
          decisionId: decision.id,
          disposition: "open",
          side: "long",
          observedAt,
          entryPrice: 150.25,
          sizeBase: 2,
          journalEvents,
        });
        expect(result).toEqual({ status: "conflict", reason: testCase.reason });
        expect(await snapshot()).toEqual(before);
      } finally {
        await db.delete(aiTraderDecisions).where(eq(aiTraderDecisions.botId, atomicBot.id));
        await db.delete(aiTraderBots).where(eq(aiTraderBots.id, atomicBot.id));
      }
    }
  }, 30_000);

  it("real PostgreSQL faults after each direct-live mutation roll back decision, bot, and suffix together", async () => {
    const safeIdentifier = `qv_live_atomic_${Date.now()}_${Math.random().toString(36).slice(2)}`.replace(/[^a-z0-9_]/g, "");
    const cases = [
      { stage: "decision", table: "ai_trader_decisions", operation: "UPDATE", key: "id" },
      { stage: "bot", table: "ai_trader_bots", operation: "UPDATE", key: "id" },
      { stage: "journal", table: "ai_trader_execution_events", operation: "INSERT", key: "attempt_id" },
    ] as const;
    for (const disposition of ["open", "quarantined", "no_land"] as const) {
      for (const testCase of cases) {
        const atomicBot = await storage.createAiTraderBot({
          walletAddress: `${WALLET}-live-fault-${disposition}-${testCase.stage}`, protocol: "pacifica", market: "SOL-PERP", timeframe: "15m",
          allocatedUsdc: "100.00",
          graduationCriteria: { periodDays: 30, minTrades: 10, minNetPnl: 0, maxDrawdownPct: 30 },
          policyHmac: `live-fault-${disposition}-${testCase.stage}-hmac`,
        } as any);
        const decision = await storage.insertAiTraderDecision({
          botId: atomicBot.id, rawDecision: { action: "long" }, decidedAt: new Date(),
        } as any);
        await storage.updateAiTraderBot(atomicBot.id, { status: "executing" as any });
        const observedAt = new Date(decision.decidedAt!);
        const attemptId = await journal.appendRequiredEntryPrebroadcast({
          bot: atomicBot, decisionId: decision.id, side: "long",
          clientOrderId: `aitrader-${decision.id}`, sizeBase: 1.5,
        });
        const base = journal.journalBase(atomicBot, decision.id);
        const success = disposition === "open";
        const broadcast = {
          ...journal.orderResultEvent({
            base, attemptId, action: "entry", cause: "decision",
            order: success
              ? { success: true, status: "filled", fillPrice: 151, fillSize: 1.5, orderId: `venue-fault-${disposition}` }
              : { success: false, status: "rejected", error: disposition === "quarantined" ? "may still land" : "price band" },
            failureCode: disposition === "quarantined" ? "venue_unconfirmed" : disposition === "no_land" ? "venue_rejected" : null,
          }),
          side: "long" as const,
          observedAt,
        } as const;
        const journalEvents = disposition === "open"
          ? [
              broadcast,
              { ...base, attemptId, action: "entry", cause: "decision", eventType: "position_observed", side: "long", price: 151, sizeBase: 1.5, observedAt },
              { ...base, attemptId, action: "entry", cause: "decision", eventType: "fill_observed", side: "long", price: 151, sizeBase: 1.5, observedAt },
              { ...base, attemptId, action: "entry", cause: "decision", eventType: "bracket_verified", side: "long", observedAt },
              { ...base, attemptId, action: "entry", cause: "decision", eventType: "entry_terminal_open", side: "long", price: 151, sizeBase: 1.5, observedAt },
            ]
          : disposition === "quarantined"
            ? [broadcast]
            : [
                broadcast,
                { ...base, attemptId, action: "entry", cause: "decision", eventType: "entry_terminal_no_land", side: "long",
                  failureCode: "venue_rejected", recordedAfterBroadcast: true, observedAt },
              ];
        const functionName = `${safeIdentifier}_${disposition}_${testCase.stage}_fn`;
        const triggerName = `${safeIdentifier}_${disposition}_${testCase.stage}_trg`;
        const keyValue = (testCase.stage === "bot" ? atomicBot.id : testCase.stage === "decision" ? decision.id : attemptId)
          .replace(/'/g, "''");
        try {
          await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'live_atomic_fault_${disposition}_${testCase.stage}'; END; $$`);
          await pool.query(`CREATE TRIGGER ${triggerName} AFTER ${testCase.operation} ON ${testCase.table} FOR EACH ROW WHEN (NEW.${testCase.key} = '${keyValue}') EXECUTE FUNCTION ${functionName}()`);
          await expect(storage.commitAiTraderDirectLiveEntryTransition({
            botId: atomicBot.id,
            decisionId: decision.id,
            disposition,
            side: "long",
            observedAt,
            ...(disposition === "open" ? { entryPrice: 151, sizeBase: 1.5 } : {}),
            journalEvents,
          } as any)).rejects.toThrow(`live_atomic_fault_${disposition}_${testCase.stage}`);
        } finally {
          await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON ${testCase.table}`);
          await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
        }

        expect(await storage.getAiTraderDecision(decision.id)).toMatchObject({ outcome: null, entryPrice: null });
        expect(await storage.getAiTraderBot(atomicBot.id)).toMatchObject({ status: "executing", pauseReason: null });
        const rows = await pool.query(
          "SELECT event_type FROM ai_trader_execution_events WHERE attempt_id=$1 ORDER BY phase NULLS LAST, event_type",
          [attemptId],
        );
        expect(rows.rows.map((row: { event_type: string }) => row.event_type)).toEqual(["attempt_claimed", "prebroadcast_authorized"]);
        await db.delete(aiTraderDecisions).where(eq(aiTraderDecisions.botId, atomicBot.id));
        await db.delete(aiTraderBots).where(eq(aiTraderBots.id, atomicBot.id));
      }
    }
  }, 60_000);

  it("atomically commits and replays every recovery disposition with deterministic multi-decision ordering", async () => {
    const createdBotIds: string[] = [];
    const makeRecoveryBot = async (suffix: string, status: string, pauseReason: string | null) => {
      const bot = await storage.createAiTraderBot({
        walletAddress: `${WALLET}-recovery-${suffix}`, protocol: "pacifica", market: "SOL-PERP", timeframe: "15m",
        allocatedUsdc: "100.00",
        graduationCriteria: { periodDays: 30, minTrades: 10, minNetPnl: 0, maxDrawdownPct: 30 },
        policyHmac: `recovery-${suffix}-hmac`,
      } as any);
      createdBotIds.push(bot.id);
      await storage.updateAiTraderBot(bot.id, { status: status as any, pauseReason });
      return { ...bot, status, pauseReason } as any;
    };
    const makeDecision = (botId: string, suffix: string, outcome: string | null) => storage.insertAiTraderDecision({
      botId, rawDecision: { action: "long" }, clampedDecision: { action: "long" }, outcome,
      decidedAt: new Date(`2026-08-19T${suffix.padStart(2, "0")}:00:00.000Z`),
    } as any);
    const observedAt = new Date("2026-08-19T20:00:00.000Z");
    try {
      const adoptBot = await makeRecoveryBot("adopt-open", "paused", "position_unconfirmed");
      const adoptDecision = await makeDecision(adoptBot.id, "01", "unconfirmed_landing");
      const adoptAttempt = await journal.appendRequiredEntryPrebroadcast({
        bot: adoptBot, decisionId: adoptDecision.id, side: "long", clientOrderId: `adopt-${WALLET}`, sizeBase: 2,
      });
      const adoptBase = journal.journalBase(adoptBot, adoptDecision.id);
      const adoptEvents = [
        { ...adoptBase, attemptId: adoptAttempt, action: "entry", cause: "decision", eventType: "position_observed",
          side: "long", price: 150.25, sizeBase: 2, observedAt },
        { ...adoptBase, attemptId: adoptAttempt, action: "entry", cause: "decision", eventType: "bracket_verified",
          side: "long", observedAt },
        ...journal.buildEntryReconciliationTerminalEvents({
          base: adoptBase, attemptId: adoptAttempt, terminal: "entry_terminal_open",
          proof: { kind: "landed_position", side: "long", price: 150.25, sizeBase: 2 }, observedAt,
        }),
      ] as any;
      const adoptParams = {
        disposition: "adopt_open", botId: adoptBot.id, expectedBotStatus: "paused", expectedPauseReason: "position_unconfirmed",
        decisionId: adoptDecision.id, expectedDecisionOutcome: "unconfirmed_landing", entryPrice: 150.25,
        targetBotStatus: "open", targetPauseReason: null, journalBatches: [adoptEvents],
      } as const;
      await db.transaction(async (tx) => {
        expect(await journal.acquireExecutionJournalAttemptLocksInTransaction(tx, [adoptEvents]))
          .toEqual([adoptAttempt]);
        expect(await journal.prepareExecutionJournalEventsInTransaction(tx, adoptEvents, {
          requireEntryCommandLineage: true,
          requireExactRequestedReplay: true,
          attemptLockAlreadyHeld: true,
        })).toMatchObject({ status: "pending" });
      });
      expect(await storage.commitAiTraderRecoveryTransition(adoptParams)).toMatchObject({
        status: "applied", bot: { status: "open", pauseReason: null },
        decisions: [{ outcome: "executed", entryPrice: "150.25000000" }],
        journal: { status: "appended", failureCode: null },
      });
      const restartedAdoptEvents = adoptEvents.map((event) => ({
        ...event,
        observedAt: new Date("2026-08-19T20:01:00.000Z"),
      }));
      expect(await storage.commitAiTraderRecoveryTransition({
        ...adoptParams,
        journalBatches: [restartedAdoptEvents],
      })).toMatchObject({
        status: "replayed", journal: { status: "replayed", failureCode: null },
      });

      // A healthy direct-live entry already has position, bracket, and the
      // phase-90 terminal, but not the recovery-only reconciliation_observed
      // row. A restart must accept those stable facts even though the monitor
      // necessarily reconstructs them with a fresh observedAt.
      const healthyBot = await makeRecoveryBot("healthy-open", "open", null);
      const healthyDecision = await makeDecision(healthyBot.id, "07", "executed");
      await storage.updateAiTraderDecision(healthyDecision.id, {
        outcome: "executed", entryPrice: "151.25000000",
      } as any);
      const healthyAttempt = await journal.appendRequiredEntryPrebroadcast({
        bot: healthyBot, decisionId: healthyDecision.id, side: "long",
        clientOrderId: `healthy-${WALLET}`, sizeBase: 1,
      });
      const healthyBase = journal.journalBase(healthyBot, healthyDecision.id);
      const healthyObservedAt = new Date("2026-08-19T20:02:00.000Z");
      await journal.appendExecutionEvents([
        { ...healthyBase, attemptId: healthyAttempt, action: "entry", cause: "decision",
          eventType: "broadcast_result", side: "long", venueStatus: "filled",
          price: 151.25, sizeBase: 1, recordedAfterBroadcast: true, observedAt: healthyObservedAt },
        { ...healthyBase, attemptId: healthyAttempt, action: "entry", cause: "decision",
          eventType: "position_observed", side: "long", price: 151.25,
          sizeBase: 1, observedAt: healthyObservedAt },
        { ...healthyBase, attemptId: healthyAttempt, action: "entry", cause: "decision",
          eventType: "bracket_verified", side: "long", observedAt: healthyObservedAt },
        { ...healthyBase, attemptId: healthyAttempt, action: "entry", cause: "decision",
          eventType: "entry_terminal_open", side: "long", price: 151.25,
          sizeBase: 1, recordedAfterBroadcast: true, observedAt: healthyObservedAt },
      ] as any);
      const restartedHealthyObservedAt = new Date("2026-08-19T20:03:00.000Z");
      const restartedHealthyEvents = [
        { ...healthyBase, attemptId: healthyAttempt, action: "entry", cause: "decision",
          eventType: "position_observed", side: "long", price: 151.25,
          sizeBase: 1, observedAt: restartedHealthyObservedAt },
        { ...healthyBase, attemptId: healthyAttempt, action: "entry", cause: "decision",
          eventType: "bracket_verified", side: "long", observedAt: restartedHealthyObservedAt },
        ...journal.buildEntryReconciliationTerminalEvents({
          base: healthyBase, attemptId: healthyAttempt, terminal: "entry_terminal_open",
          proof: { kind: "landed_position", side: "long", price: 151.25, sizeBase: 1 },
          observedAt: restartedHealthyObservedAt,
        }),
      ] as any;
      expect(await storage.commitAiTraderRecoveryTransition({
        disposition: "adopt_open", botId: healthyBot.id,
        expectedBotStatus: "open", expectedPauseReason: null,
        decisionId: healthyDecision.id, expectedDecisionOutcome: "executed",
        entryPrice: 151.25, targetBotStatus: "open", targetPauseReason: null,
        journalBatches: [restartedHealthyEvents],
      })).toMatchObject({
        status: "replayed", journal: { status: "replayed", failureCode: null },
      });
      expect(await storage.commitAiTraderRecoveryTransition({
        disposition: "adopt_open", botId: healthyBot.id,
        expectedBotStatus: "open", expectedPauseReason: null,
        decisionId: healthyDecision.id, expectedDecisionOutcome: "executed",
        entryPrice: 151.25, targetBotStatus: "open", targetPauseReason: null,
        journalBatches: [[
          { ...restartedHealthyEvents[0], price: 999.25 },
          ...restartedHealthyEvents.slice(1),
        ]],
      })).toEqual({ status: "conflict", reason: "journal_identity_conflict" });

      const protectBot = await makeRecoveryBot("adopt-protect", "paused", "position_unconfirmed");
      const protectDecision = await makeDecision(protectBot.id, "02", "unconfirmed_landing");
      const protectAttempt = await journal.appendRequiredEntryPrebroadcast({
        bot: protectBot, decisionId: protectDecision.id, side: "long", clientOrderId: `protect-${WALLET}`, sizeBase: 1,
      });
      const protectBase = journal.journalBase(protectBot, protectDecision.id);
      const protectEvents = [{ ...protectBase, attemptId: protectAttempt, action: "entry", cause: "decision",
        eventType: "position_observed", side: "long", price: 149.75, sizeBase: 1, observedAt }] as any;
      const protectParams = {
        disposition: "adopt_for_protective_close", botId: protectBot.id,
        expectedBotStatus: "paused", expectedPauseReason: "position_unconfirmed",
        decisionId: protectDecision.id, expectedDecisionOutcome: "unconfirmed_landing", entryPrice: 149.75,
        targetBotStatus: "paused", targetPauseReason: "bracket_failed",
        journalBatches: [protectEvents],
      } as const;
      expect(await storage.commitAiTraderRecoveryTransition(protectParams)).toMatchObject({
        status: "applied", bot: { status: "paused", pauseReason: "bracket_failed" },
        decisions: [{ outcome: "executed", entryPrice: "149.75000000" }],
      });
      expect(await storage.commitAiTraderRecoveryTransition({
        ...protectParams,
        expectedPauseReason: "bracket_failed",
        expectedDecisionOutcome: "executed",
        journalBatches: [[{ ...protectEvents[0], observedAt: new Date("2026-08-19T20:04:00.000Z") }]],
      })).toMatchObject({
        status: "replayed", journal: { status: "replayed", failureCode: null },
      });

      const noLandBot = await makeRecoveryBot("no-land", "paused", "position_unconfirmed");
      const noLandDecision = await makeDecision(noLandBot.id, "03", "unconfirmed_landing");
      const noLandAttempt = await journal.appendRequiredEntryPrebroadcast({
        bot: noLandBot, decisionId: noLandDecision.id, side: "long", clientOrderId: `no-land-${WALLET}`, sizeBase: 1,
      });
      const noLandEvents = journal.buildEntryReconciliationTerminalEvents({
        base: journal.journalBase(noLandBot, noLandDecision.id), attemptId: noLandAttempt,
        terminal: "entry_terminal_no_land", proof: { kind: "flat_after_landing_window" }, observedAt,
      });
      expect(await storage.commitAiTraderRecoveryTransition({
        disposition: "no_land", botId: noLandBot.id, expectedBotStatus: "paused",
        expectedPauseReason: "position_unconfirmed", decisionId: noLandDecision.id,
        expectedDecisionOutcome: "unconfirmed_landing", journalBatches: [noLandEvents],
      })).toMatchObject({
        status: "applied", bot: { status: "paused", pauseReason: "position_unconfirmed_expired" },
        decisions: [{ outcome: "aborted_order" }],
      });

      const crashBot = await makeRecoveryBot("abort-crash", "executing", null);
      const crashB = await makeDecision(crashBot.id, "05", null);
      const crashA = await makeDecision(crashBot.id, "04", null);
      const crash = await storage.commitAiTraderRecoveryTransition({
        disposition: "abort_crash", botId: crashBot.id, expectedBotStatus: "executing", expectedPauseReason: null,
        decisionIds: [crashB.id, crashA.id], targetBotStatus: "idle", targetPauseReason: null, journalBatches: [],
      });
      expect(crash).toMatchObject({ status: "applied", bot: { status: "idle", pauseReason: null } });
      if (crash.status === "conflict") throw new Error("expected applied crash recovery");
      expect(crash.decisions.map((row) => row.id)).toEqual([crashA.id, crashB.id].sort());
      expect(crash.decisions.every((row) => row.outcome === "aborted_crash")).toBe(true);

      const orphanBot = await makeRecoveryBot("orphan", "open", null);
      const orphanAttempt = journal.newMutationAttemptId("close", null);
      expect(await storage.commitAiTraderRecoveryTransition({
        disposition: "orphan_paused", botId: orphanBot.id, expectedBotStatus: "open", expectedPauseReason: null,
        decisionId: null, expectedDecisionOutcome: null, closeAttemptId: orphanAttempt,
        journalBatches: [[{ ...journal.journalBase(orphanBot, null), attemptId: orphanAttempt,
          action: "close", cause: "startup_orphan", eventType: "attempt_claimed", observedAt }]],
      })).toMatchObject({
        status: "applied", bot: { status: "paused", pauseReason: "reconcile_orphan_position" },
        decisions: [], journal: { status: "appended", failureCode: null },
      });

      const unwindBot = await makeRecoveryBot("emergency", "executing", null);
      const unwindDecision = await makeDecision(unwindBot.id, "06", null);
      const entryAttempt = await journal.appendRequiredEntryPrebroadcast({
        bot: unwindBot, decisionId: unwindDecision.id, side: "long", clientOrderId: `unwind-entry-${WALLET}`, sizeBase: 1,
      });
      const entryBase = journal.journalBase(unwindBot, unwindDecision.id);
      await journal.appendExecutionEvents([{ ...entryBase, attemptId: entryAttempt, action: "entry", cause: "decision",
        eventType: "broadcast_result", side: "long", venueStatus: "filled", price: 150, sizeBase: 1,
        recordedAfterBroadcast: true, observedAt }]);
      const closeAttempt = journal.newMutationAttemptId("close", unwindDecision.id);
      const closeBase = journal.journalBase(unwindBot, unwindDecision.id);
      const closeEvents = [
        { ...closeBase, attemptId: closeAttempt, action: "close", cause: "emergency_unwind", eventType: "attempt_claimed", side: "long", observedAt },
        { ...closeBase, attemptId: closeAttempt, action: "close", cause: "emergency_unwind", eventType: "broadcast_attempted", side: "long", recordedAfterBroadcast: true, observedAt },
        { ...closeBase, attemptId: closeAttempt, action: "close", cause: "emergency_unwind", eventType: "broadcast_result", side: "long", venueStatus: "filled", price: 151, recordedAfterBroadcast: true, observedAt },
        { ...closeBase, attemptId: closeAttempt, action: "close", cause: "emergency_unwind", eventType: "close_terminal_confirmed", side: "long", venueStatus: "filled", price: 151, recordedAfterBroadcast: true, observedAt },
      ] as any;
      const entryTerminal = [{ ...entryBase, attemptId: entryAttempt, action: "entry", cause: "decision",
        eventType: "entry_terminal_unwound", side: "long", price: 151, sizeBase: 1,
        failureCode: "bracket_failed", recordedAfterBroadcast: true, observedAt }] as any;
      const unwindParams = {
        disposition: "emergency_unwind", botId: unwindBot.id, expectedBotStatus: "executing", expectedPauseReason: null,
        decisionId: unwindDecision.id, expectedDecisionOutcome: null, closeAttemptId: closeAttempt,
        pauseReason: "bracket_failed", entryFillPrice: 150, closeSucceeded: true, closeFillPrice: 151,
        closedAt: observedAt, journalBatches: [closeEvents, entryTerminal],
      } as const;
      expect(await storage.commitAiTraderRecoveryTransition(unwindParams)).toMatchObject({
        status: "applied", bot: { status: "paused", pauseReason: "bracket_failed" },
        decisions: [{ outcome: "executed", entryPrice: "150.00000000", exitPrice: "151.00000000",
          exitReason: "bracket_failed", realizedPnl: null, feesPaid: null, closedAt: observedAt }],
        journal: { status: "appended", failureCode: null },
      });
      expect(await storage.commitAiTraderRecoveryTransition(unwindParams)).toMatchObject({
        status: "replayed", journal: { status: "replayed", failureCode: null },
      });
      const otherCloseAttempt = journal.newMutationAttemptId("close", unwindDecision.id);
      const otherCloseEvents = closeEvents.map((event: any) => ({ ...event, attemptId: otherCloseAttempt }));
      expect(await storage.commitAiTraderRecoveryTransition({
        ...unwindParams, closeAttemptId: otherCloseAttempt, journalBatches: [otherCloseEvents, entryTerminal],
      })).toEqual({ status: "conflict", reason: "recovery_state_conflict" });
    } finally {
      for (const id of createdBotIds) {
        await db.delete(aiTraderDecisions).where(eq(aiTraderDecisions.botId, id));
        await db.delete(aiTraderBots).where(eq(aiTraderBots.id, id));
      }
    }
  }, 60_000);

  it("keeps recovered state when journal validation or insert degrades, but rolls back on a state-row fault", async () => {
    const createdBotIds: string[] = [];
    const create = async (suffix: string) => {
      const bot = await storage.createAiTraderBot({
        walletAddress: `${WALLET}-recovery-fault-${suffix}`, protocol: "pacifica", market: "SOL-PERP", timeframe: "15m",
        allocatedUsdc: "100.00", graduationCriteria: { periodDays: 30, minTrades: 10, minNetPnl: 0, maxDrawdownPct: 30 },
        policyHmac: `recovery-fault-${suffix}-hmac`,
      } as any);
      createdBotIds.push(bot.id);
      await storage.updateAiTraderBot(bot.id, { status: "open" as any, pauseReason: null });
      return { ...bot, status: "open", pauseReason: null } as any;
    };
    const observedAt = new Date("2026-08-19T21:00:00.000Z");
    let triggerName: string | null = null;
    let functionName: string | null = null;
    let triggerTable: "ai_trader_execution_events" | "ai_trader_bots" | null = null;
    try {
      const malformedBot = await create("validation");
      const requestedAttempt = journal.newMutationAttemptId("close", null);
      const mismatchedAttempt = journal.newMutationAttemptId("close", null);
      expect(await storage.commitAiTraderRecoveryTransition({
        disposition: "orphan_paused", botId: malformedBot.id, expectedBotStatus: "open", expectedPauseReason: null,
        decisionId: null, expectedDecisionOutcome: null, closeAttemptId: requestedAttempt,
        journalBatches: [[{ ...journal.journalBase(malformedBot, null), attemptId: mismatchedAttempt,
          action: "close", cause: "startup_orphan", eventType: "attempt_claimed", observedAt }]],
      })).toMatchObject({
        status: "applied", bot: { status: "paused", pauseReason: "reconcile_orphan_position" },
        journal: { status: "degraded", failureCode: "validation_conflict" },
      });

      const insertBot = await create("insert");
      const insertAttempt = journal.newMutationAttemptId("close", null);
      const safe = `qv_recovery_insert_${Date.now()}_${Math.random().toString(36).slice(2)}`.replace(/[^a-z0-9_]/g, "");
      functionName = `${safe}_fn`;
      triggerName = `${safe}_trg`;
      triggerTable = "ai_trader_execution_events";
      const key = insertAttempt.replace(/'/g, "''");
      await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'recovery_journal_insert_fault'; END; $$`);
      await pool.query(`CREATE TRIGGER ${triggerName} AFTER INSERT ON ai_trader_execution_events FOR EACH ROW WHEN (NEW.attempt_id = '${key}') EXECUTE FUNCTION ${functionName}()`);
      expect(await storage.commitAiTraderRecoveryTransition({
        disposition: "orphan_paused", botId: insertBot.id, expectedBotStatus: "open", expectedPauseReason: null,
        decisionId: null, expectedDecisionOutcome: null, closeAttemptId: insertAttempt,
        journalBatches: [[{ ...journal.journalBase(insertBot, null), attemptId: insertAttempt,
          action: "close", cause: "startup_orphan", eventType: "attempt_claimed", observedAt }]],
      })).toMatchObject({
        status: "applied", bot: { status: "paused", pauseReason: "reconcile_orphan_position" },
        journal: { status: "degraded", failureCode: "insert_failed" },
      });
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON ai_trader_execution_events`);
      await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
      triggerName = null;
      functionName = null;
      triggerTable = null;

      const stateFaultBot = await create("state");
      const stateAttempt = journal.newMutationAttemptId("close", null);
      const stateSafe = `qv_recovery_state_${Date.now()}_${Math.random().toString(36).slice(2)}`.replace(/[^a-z0-9_]/g, "");
      functionName = `${stateSafe}_fn`;
      triggerName = `${stateSafe}_trg`;
      triggerTable = "ai_trader_bots";
      const botKey = stateFaultBot.id.replace(/'/g, "''");
      await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'recovery_state_fault'; END; $$`);
      await pool.query(`CREATE TRIGGER ${triggerName} AFTER UPDATE ON ai_trader_bots FOR EACH ROW WHEN (NEW.id = '${botKey}') EXECUTE FUNCTION ${functionName}()`);
      await expect(storage.commitAiTraderRecoveryTransition({
        disposition: "orphan_paused", botId: stateFaultBot.id, expectedBotStatus: "open", expectedPauseReason: null,
        decisionId: null, expectedDecisionOutcome: null, closeAttemptId: stateAttempt,
        journalBatches: [[{ ...journal.journalBase(stateFaultBot, null), attemptId: stateAttempt,
          action: "close", cause: "startup_orphan", eventType: "attempt_claimed", observedAt }]],
      })).rejects.toThrow("recovery_state_fault");
      expect(await storage.getAiTraderBot(stateFaultBot.id)).toMatchObject({ status: "open", pauseReason: null });
      const journalRows = await pool.query(
        "SELECT count(*)::int AS count FROM ai_trader_execution_events WHERE attempt_id=$1", [stateAttempt],
      );
      expect(journalRows.rows[0]?.count).toBe(0);
    } finally {
      if (triggerName && triggerTable) await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON ${triggerTable}`);
      if (functionName) await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
      for (const id of createdBotIds) {
        await db.delete(aiTraderDecisions).where(eq(aiTraderDecisions.botId, id));
        await db.delete(aiTraderBots).where(eq(aiTraderBots.id, id));
      }
    }
  }, 60_000);

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

  it("getOpenAiTraderDecisions returns only unclosed executed rows, newest first, honoring limit", async () => {
    const openBot = await storage.createAiTraderBot({
      walletAddress: "ai-trader-open-test-" + Math.random().toString(36).slice(2),
      protocol: "pacifica",
      market: "SOL-PERP",
      timeframe: "15m",
      allocatedUsdc: "100.00",
      graduationCriteria: { periodDays: 30, minTrades: 10, minNetPnl: 0, maxDrawdownPct: 30 },
      policyHmac: "open-test-hmac",
    } as any);
    try {
      const baseTime = Date.now() - 60_000;
      await storage.insertAiTraderDecision({
        botId: openBot.id,
        rawDecision: { action: "long" },
        outcome: "executed",
        closedAt: new Date(baseTime + 50_000),
        decidedAt: new Date(baseTime + 1_000),
      } as any);
      await storage.insertAiTraderDecision({
        botId: openBot.id,
        rawDecision: { action: "flat" },
        outcome: "flat",
        decidedAt: new Date(baseTime + 40_000),
      } as any);
      const oldest = await storage.insertAiTraderDecision({
        botId: openBot.id,
        rawDecision: { action: "long" },
        outcome: "executed",
        decidedAt: new Date(baseTime + 10_000),
      } as any);
      const middle = await storage.insertAiTraderDecision({
        botId: openBot.id,
        rawDecision: { action: "long" },
        outcome: "executed",
        decidedAt: new Date(baseTime + 20_000),
      } as any);
      const newest = await storage.insertAiTraderDecision({
        botId: openBot.id,
        rawDecision: { action: "short" },
        outcome: "executed",
        decidedAt: new Date(baseTime + 30_000),
      } as any);

      const rows = await storage.getOpenAiTraderDecisions(openBot.id, 2);
      expect(rows.map((row) => row.id)).toEqual([newest.id, middle.id]);
      expect(rows).not.toContainEqual(expect.objectContaining({ id: oldest.id }));
      expect(rows.every((row) => row.outcome === "executed" && row.closedAt === null)).toBe(true);
    } finally {
      await db.delete(aiTraderDecisions).where(eq(aiTraderDecisions.botId, openBot.id));
      await db.delete(aiTraderBots).where(eq(aiTraderBots.id, openBot.id));
    }
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
  // Also verifies the stub retains action + rationaleExcerpt for Activity-feed rendering.
  it("compressOldAiTraderDecisions thins old flat rows but never executed rows, preserves action/rationaleExcerpt, is idempotent, and leaves recent rows untouched", async () => {
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
      const LONG_RATIONALE = "A".repeat(200); // 200-char rationale — excerpt must be capped at 120

      // Old flat row (should be thinned). clampedDecision carries action + rationale.
      const oldFlat = await storage.insertAiTraderDecision({
        botId: compBotId,
        rawDecision: { action: "flat", rationale: "raw rationale" },
        contextDigest: { price: 150, rsi: 55 },
        clampedDecision: { action: "flat", rationale: LONG_RATIONALE },
        guardrailViolations: [{ code: "MAX_LOSS" }],
        outcome: "flat",
        llmCostUsd: SCALAR_COST,
        feesPaid: SCALAR_FEE,
      } as any);
      // Backdate decidedAt (defaultNow is set at insert, so update after).
      await db.update(aiTraderDecisions).set({ decidedAt: OLD_DATE }).where(eq(aiTraderDecisions.id, oldFlat.id));

      // Old executed row (must NEVER be thinned — full jsonb preserved forever).
      const oldExec = await storage.insertAiTraderDecision({
        botId: compBotId,
        rawDecision: { action: "open_long", confidence: 0.9 },
        contextDigest: { price: 148 },
        clampedDecision: { action: "long", rationale: "strong setup" },
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
        clampedDecision: { action: "flat", rationale: "recent rationale" },
        outcome: "flat",
        llmCostUsd: SCALAR_COST,
        feesPaid: SCALAR_FEE,
      } as any);

      // Run the sweep.
      const n = await storage.compressOldAiTraderDecisions(30, 500);
      expect(n).toBeGreaterThanOrEqual(1); // at least the old flat row

      // Old flat row: heavy jsonb stripped; stub retains action + rationaleExcerpt (≤120 chars).
      const [thinned] = await db.select().from(aiTraderDecisions).where(eq(aiTraderDecisions.id, oldFlat.id));
      expect(thinned.contextDigest).toBeNull();
      expect(thinned.clampedDecision).toBeNull();
      expect(thinned.guardrailViolations).toBeNull();
      expect((thinned.rawDecision as any)?.compressed).toBe(true);
      expect((thinned.rawDecision as any)?.action).toBe("flat");
      // rationaleExcerpt must be capped at 120 chars (LONG_RATIONALE is 200 chars).
      expect(typeof (thinned.rawDecision as any)?.rationaleExcerpt).toBe("string");
      expect((thinned.rawDecision as any).rationaleExcerpt.length).toBeLessThanOrEqual(120);
      // Scalars survive intact.
      expect(thinned.outcome).toBe("flat");
      expect(thinned.llmCostUsd).toBe(SCALAR_COST);
      expect(thinned.feesPaid).toBe(SCALAR_FEE);

      // Old executed row: byte-identical — compressed flag absent, contextDigest intact.
      // INVARIANT: executed rows feed graduation, net PnL, calibration, ZEC counter, playbook.
      const [execRow] = await db.select().from(aiTraderDecisions).where(eq(aiTraderDecisions.id, oldExec.id));
      expect((execRow.rawDecision as any)?.compressed).toBeUndefined();
      expect(execRow.contextDigest).not.toBeNull();
      expect(execRow.clampedDecision).not.toBeNull();
      expect(execRow.realizedPnl).toBe("12.50");

      // Old null-outcome row: untouched (not in allowlist).
      const [nullRow] = await db.select().from(aiTraderDecisions).where(eq(aiTraderDecisions.id, oldNull.id));
      expect((nullRow.rawDecision as any)?.compressed).toBeUndefined();

      // Recent flat row: untouched (not old enough).
      const [recentRow] = await db.select().from(aiTraderDecisions).where(eq(aiTraderDecisions.id, recentFlat.id));
      expect((recentRow.rawDecision as any)?.compressed).toBeUndefined();
      expect(recentRow.contextDigest).not.toBeNull();

      // Idempotency: second run skips already-compressed rows (NOT (raw_decision ? 'compressed') guard).
      const n2 = await storage.compressOldAiTraderDecisions(30, 500);
      const [thinnedAgain] = await db.select().from(aiTraderDecisions).where(eq(aiTraderDecisions.id, oldFlat.id));
      expect((thinnedAgain.rawDecision as any)?.compressed).toBe(true); // still stub, not re-processed
      void n2;
    } finally {
      if (compBotId) {
        await db.delete(aiTraderDecisions).where(eq(aiTraderDecisions.botId, compBotId));
        await db.delete(aiTraderBots).where(eq(aiTraderBots.id, compBotId));
      }
    }
  });

  // getAiTraderDecisionsPaged: outcomes filter (all/executed/non_flat) + keyset pagination.
  it("getAiTraderDecisionsPaged filters by outcomes and paginates with keyset cursor", async () => {
    const PAGE_WALLET = "ai-trader-page-test-" + Math.random().toString(36).slice(2);
    let pageBotId: string | undefined;
    try {
      const pageBot = await storage.createAiTraderBot({
        walletAddress: PAGE_WALLET,
        protocol: "pacifica",
        market: "SOL-PERP",
        timeframe: "15m",
        allocatedUsdc: "100.00",
        graduationCriteria: { periodDays: 30, minTrades: 10, minNetPnl: 0, maxDrawdownPct: 30 },
        policyHmac: "page-test-hmac",
      } as any);
      pageBotId = pageBot.id;

      // Insert 3 flat + 2 executed rows in a known order.
      const rows: Array<{ id: string; outcome: string }> = [];
      for (let i = 0; i < 3; i++) {
        const r = await storage.insertAiTraderDecision({
          botId: pageBotId,
          rawDecision: { action: "flat", i },
          outcome: "flat",
        } as any);
        rows.push({ id: r.id, outcome: "flat" });
      }
      for (let i = 0; i < 2; i++) {
        const r = await storage.insertAiTraderDecision({
          botId: pageBotId,
          rawDecision: { action: "open_long" },
          outcome: "executed",
        } as any);
        rows.push({ id: r.id, outcome: "executed" });
      }

      // outcomes='all': returns all 5 rows.
      const all = await storage.getAiTraderDecisionsPaged(pageBotId, 10, { outcomes: 'all' });
      expect(all.rows.length).toBe(5);
      expect(all.nextCursor).toBeNull();

      // outcomes='executed': returns only the 2 executed rows, no flats.
      const execOnly = await storage.getAiTraderDecisionsPaged(pageBotId, 10, { outcomes: 'executed' });
      expect(execOnly.rows.length).toBe(2);
      expect(execOnly.rows.every(r => r.outcome === 'executed')).toBe(true);
      expect(execOnly.nextCursor).toBeNull();

      // outcomes='non_flat': returns the 2 executed rows (excludes all 3 flats).
      const nonFlat = await storage.getAiTraderDecisionsPaged(pageBotId, 10, { outcomes: 'non_flat' });
      expect(nonFlat.rows.length).toBe(2);
      expect(nonFlat.rows.every(r => r.outcome !== 'flat')).toBe(true);

      // Pagination: limit=2 on 'all' returns first page + non-null nextCursor.
      const page1 = await storage.getAiTraderDecisionsPaged(pageBotId, 2, { outcomes: 'all' });
      expect(page1.rows.length).toBe(2);
      expect(page1.nextCursor).not.toBeNull();

      // Page 2 via cursor: gets the next 2 rows, no overlap with page 1.
      const page1Ids = new Set(page1.rows.map(r => r.id));
      const page2 = await storage.getAiTraderDecisionsPaged(pageBotId, 2, {
        outcomes: 'all',
        before: new Date(page1.nextCursor!.before),
        beforeId: page1.nextCursor!.beforeId,
      });
      expect(page2.rows.length).toBe(2);
      expect(page2.rows.every(r => !page1Ids.has(r.id))).toBe(true); // no overlap

      // Page 3: last row, nextCursor = null.
      const page2Ids = new Set(page2.rows.map(r => r.id));
      const page3 = await storage.getAiTraderDecisionsPaged(pageBotId, 2, {
        outcomes: 'all',
        before: new Date(page2.nextCursor!.before),
        beforeId: page2.nextCursor!.beforeId,
      });
      expect(page3.rows.length).toBe(1);
      expect(page3.rows.every(r => !page1Ids.has(r.id) && !page2Ids.has(r.id))).toBe(true);
      expect(page3.nextCursor).toBeNull();
    } finally {
      if (pageBotId) {
        await db.delete(aiTraderDecisions).where(eq(aiTraderDecisions.botId, pageBotId));
        await db.delete(aiTraderBots).where(eq(aiTraderBots.id, pageBotId));
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
