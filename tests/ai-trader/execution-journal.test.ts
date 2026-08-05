import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `journal-${Date.now()}-${Math.random().toString(36).slice(2)}`;

describe.skipIf(!HAS_DB)("AI Trader immutable execution journal", () => {
  let dbModule: typeof import("../../server/db");
  let journal: typeof import("../../server/ai-trader/execution-journal");

  const bot = {
    id: `bot-${RUN}`,
    walletAddress: `wallet-public-${RUN}`,
    protocol: "pacifica",
    protocolSubaccountId: null,
    market: "SOL-PERP",
  } as any;

  beforeAll(async () => {
    dbModule = await import("../../server/db");
    journal = await import("../../server/ai-trader/execution-journal");
  });

  afterAll(async () => {
    // Rows are deliberately immutable and have no product-row FK. The
    // authorized test database retains these uniquely-prefixed audit rows.
  });

  it("creates the journal schema and append-only trigger idempotently in real PostgreSQL", async () => {
    await dbModule.ensureSchema();
    await dbModule.ensureSchema();
    const table = await dbModule.pool.query(
      "SELECT to_regclass('public.ai_trader_execution_events') AS name",
    );
    const trigger = await dbModule.pool.query(
      "SELECT tgname FROM pg_trigger WHERE tgrelid = 'ai_trader_execution_events'::regclass AND NOT tgisinternal",
    );
    expect(table.rows[0]?.name).toBe("ai_trader_execution_events");
    expect(trigger.rows.map((row) => row.tgname)).toContain("ai_trader_execution_events_append_only");
  }, 30_000);

  it("required entry prebroadcast appends claim and authorization atomically", async () => {
    const decisionId = `decision-required-${RUN}`;
    await journal.appendRequiredEntryPrebroadcast({
      bot,
      decisionId,
      side: "long",
      clientOrderId: `client-${RUN}`,
      sizeBase: 1.25,
    });
    const rows = await dbModule.pool.query(
      "SELECT event_type, phase FROM ai_trader_execution_events WHERE attempt_id=$1 ORDER BY phase",
      [`entry:${decisionId}`],
    );
    expect(rows.rows).toEqual([
      { event_type: "attempt_claimed", phase: 0 },
      { event_type: "prebroadcast_authorized", phase: 10 },
    ]);
  });

  it("same event identity is idempotent and conflicting content is rejected", async () => {
    const attemptId = `close-idempotent-${RUN}`;
    const base = journal.journalBase(bot, null);
    const observedAt = new Date("2026-08-05T00:00:00.000Z");
    const event = { ...base, attemptId, action: "close", cause: "startup_orphan", eventType: "attempt_claimed", observedAt } as const;
    await journal.appendExecutionEvents([event]);
    await journal.appendExecutionEvents([event]);
    const count = await dbModule.pool.query(
      "SELECT count(*)::int AS count FROM ai_trader_execution_events WHERE attempt_id=$1",
      [attemptId],
    );
    expect(count.rows[0]?.count).toBe(1);
    await expect(journal.appendExecutionEvents([
      { ...event, cause: "unconfirmed_orphan" },
    ])).rejects.toThrow("execution_journal_command_phase_conflict");
  });

  it("rejects decreasing or conflicting command phases but accepts late evidence after terminal", async () => {
    const attemptId = `close-phases-${RUN}`;
    const base = journal.journalBase(bot, null);
    await journal.appendExecutionEvents([
      { ...base, attemptId, action: "close", cause: "startup_orphan", eventType: "attempt_claimed" },
      { ...base, attemptId, action: "close", cause: "startup_orphan", eventType: "broadcast_attempted", recordedAfterBroadcast: true },
      { ...base, attemptId, action: "close", cause: "startup_orphan", eventType: "broadcast_result", venueStatus: "unknown", recordedAfterBroadcast: true },
      { ...base, attemptId, action: "close", cause: "startup_orphan", eventType: "close_terminal_failed", failureCode: "venue_unconfirmed", recordedAfterBroadcast: true },
    ]);
    await journal.appendExecutionEvents([
      { ...base, attemptId, action: "close", cause: "startup_orphan", eventType: "reconciliation_observed", failureCode: "position_not_confirmed" },
    ]);
    await expect(journal.appendExecutionEvents([
      { ...base, attemptId, action: "close", cause: "startup_orphan", eventType: "broadcast_result", venueStatus: "rejected", failureCode: "venue_rejected" },
    ])).rejects.toThrow("execution_journal_command_phase_conflict");
  });

  it("database trigger rejects update and delete", async () => {
    const attemptId = `close-trigger-${RUN}`;
    const base = journal.journalBase(bot, null);
    await journal.appendExecutionEvents([
      { ...base, attemptId, action: "close", cause: "startup_orphan", eventType: "attempt_claimed" },
    ]);
    const row = await dbModule.pool.query(
      "SELECT id FROM ai_trader_execution_events WHERE attempt_id=$1 LIMIT 1",
      [attemptId],
    );
    const id = row.rows[0]?.id;
    await expect(dbModule.pool.query(
      "UPDATE ai_trader_execution_events SET market=market WHERE id=$1",
      [id],
    )).rejects.toThrow(/append-only/i);
    await expect(dbModule.pool.query(
      "DELETE FROM ai_trader_execution_events WHERE id=$1",
      [id],
    )).rejects.toThrow(/append-only/i);
  });

  it("typed builder rejects non-allowlisted identifiers and has no raw or error field", async () => {
    const base = journal.journalBase(bot, null);
    await expect(journal.appendExecutionEvents([{
      ...base,
      attemptId: `close-invalid-${RUN}`,
      action: "close",
      cause: "startup_orphan",
      eventType: "attempt_claimed",
      accountRef: "not\nprintable",
    }])).rejects.toThrow("execution_journal_invalid_account_ref");
    const event = journal.orderResultEvent({
      base,
      attemptId: `close-builder-${RUN}`,
      action: "close",
      cause: "startup_orphan",
      order: { success: false, status: "rejected", error: "secret provider body", rawResponse: { secret: true } },
    });
    expect(event).not.toHaveProperty("error");
    expect(event).not.toHaveProperty("rawResponse");
    expect(JSON.stringify(event)).not.toContain("secret provider body");
  });

  it("owner-scoped read rejects another wallet and paginates by recordedAt plus id", async () => {
    const firstAttempt = `close-page-a-${RUN}`;
    const secondAttempt = `close-page-b-${RUN}`;
    const otherBot = { ...bot, id: `other-bot-${RUN}`, walletAddress: `other-wallet-${RUN}` };
    await journal.appendExecutionEvents([{
      ...journal.journalBase(bot, null), attemptId: firstAttempt, action: "close", cause: "startup_orphan", eventType: "attempt_claimed",
    }]);
    await dbModule.pool.query("SELECT pg_sleep(0.01)");
    await journal.appendExecutionEvents([{
      ...journal.journalBase(bot, null), attemptId: secondAttempt, action: "close", cause: "startup_orphan", eventType: "attempt_claimed",
    }]);
    await journal.appendExecutionEvents([{
      ...journal.journalBase(otherBot as any, null), attemptId: `other-close-${RUN}`, action: "close", cause: "startup_orphan", eventType: "attempt_claimed",
    }]);

    const page1 = await journal.readExecutionJournalPage({ botId: bot.id, limit: 1 });
    expect(page1.events).toHaveLength(1);
    expect(page1.events[0]).not.toHaveProperty("accountRef");
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await journal.readExecutionJournalPage({
      botId: bot.id,
      limit: 1,
      before: new Date(page1.nextCursor!.before),
      beforeId: page1.nextCursor!.beforeId,
    });
    expect(page2.events).toHaveLength(1);
    expect(page2.events[0].id).not.toBe(page1.events[0].id);
    expect([...page1.events, ...page2.events].every((event) => event.botId === bot.id)).toBe(true);
  });
});
