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

  it("requires retained phase-20 venue evidence before an emergency-unwind entry terminal", async () => {
    const observedAt = new Date("2026-08-19T01:00:00.000Z");
    const decisionId = `decision-unwind-lineage-${RUN}`;
    const attemptId = await journal.appendRequiredEntryPrebroadcast({
      bot,
      decisionId,
      side: "long",
      clientOrderId: `client-unwind-${RUN}`,
      sizeBase: 1.5,
    });
    const base = journal.journalBase(bot, decisionId);
    await journal.appendExecutionEvents([{
      ...base,
      attemptId,
      action: "entry",
      cause: "decision",
      eventType: "broadcast_result",
      side: "long",
      clientOrderId: `client-unwind-${RUN}`,
      venueStatus: "filled",
      price: 150.25,
      sizeBase: 1.5,
      recordedAfterBroadcast: true,
      observedAt,
    }]);
    await journal.appendExecutionEvents([{
      ...base,
      attemptId,
      action: "entry",
      cause: "decision",
      eventType: "entry_terminal_unwound",
      side: "long",
      price: 150.1,
      sizeBase: 1.5,
      failureCode: "bracket_failed",
      recordedAfterBroadcast: true,
      observedAt,
    }]);
    const rows = await dbModule.pool.query(
      "SELECT event_type, phase FROM ai_trader_execution_events WHERE attempt_id=$1 ORDER BY phase",
      [attemptId],
    );
    expect(rows.rows.map((row) => row.event_type)).toEqual([
      "attempt_claimed",
      "prebroadcast_authorized",
      "broadcast_result",
      "entry_terminal_unwound",
    ]);

    const missingDecisionId = `decision-unwind-missing-20-${RUN}`;
    const missingAttemptId = await journal.appendRequiredEntryPrebroadcast({
      bot,
      decisionId: missingDecisionId,
      side: "short",
      clientOrderId: `client-unwind-missing-${RUN}`,
      sizeBase: 1,
    });
    await expect(journal.appendExecutionEvents([{
      ...journal.journalBase(bot, missingDecisionId),
      attemptId: missingAttemptId,
      action: "entry",
      cause: "decision",
      eventType: "entry_terminal_unwound",
      side: "short",
      price: 149.5,
      sizeBase: 1,
      failureCode: "position_not_confirmed",
      recordedAfterBroadcast: true,
      observedAt,
    }])).rejects.toThrow("execution_journal_command_phase_conflict");
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

  it("transaction-scoped exact batches distinguish pending, replayed, and partial conflict", async () => {
    const decisionId = `decision-atomic-${RUN}`;
    const attemptId = journal.entryAttemptId(decisionId);
    const observedAt = new Date("2026-08-19T00:00:00.000Z");
    const base = journal.journalBase(bot, decisionId);
    const events = [
      { ...base, attemptId, action: "entry", cause: "paper", eventType: "attempt_claimed", side: "long", observedAt },
      { ...base, attemptId, action: "entry", cause: "paper", eventType: "fill_observed", side: "long", price: 150, sizeBase: 1, observedAt },
      { ...base, attemptId, action: "entry", cause: "paper", eventType: "entry_terminal_open", side: "long", price: 150, sizeBase: 1, observedAt },
    ] as const;
    await dbModule.db.transaction(async (tx) => {
      const prepared = await journal.prepareExecutionJournalEventsInTransaction(
        tx, events, { requireExactBatchReplay: true },
      );
      expect(prepared.status).toBe("pending");
      await prepared.insert();
    });
    await dbModule.db.transaction(async (tx) => {
      const prepared = await journal.prepareExecutionJournalEventsInTransaction(
        tx, events, { requireExactBatchReplay: true },
      );
      expect(prepared.status).toBe("replayed");
      await prepared.insert();
    });

    const partialDecisionId = `decision-atomic-partial-${RUN}`;
    const partialAttemptId = journal.entryAttemptId(partialDecisionId);
    const partialBase = journal.journalBase(bot, partialDecisionId);
    const partialEvents = [
      { ...partialBase, attemptId: partialAttemptId, action: "entry", cause: "paper", eventType: "attempt_claimed", side: "short", observedAt },
      { ...partialBase, attemptId: partialAttemptId, action: "entry", cause: "paper", eventType: "fill_observed", side: "short", price: 149, sizeBase: 2, observedAt },
      { ...partialBase, attemptId: partialAttemptId, action: "entry", cause: "paper", eventType: "entry_terminal_open", side: "short", price: 149, sizeBase: 2, observedAt },
    ] as const;
    await journal.appendExecutionEvents([partialEvents[0]]);
    await expect(dbModule.db.transaction(async (tx) => {
      await journal.prepareExecutionJournalEventsInTransaction(
        tx, partialEvents, { requireExactBatchReplay: true },
      );
    })).rejects.toThrow("execution_journal_atomic_replay_conflict");
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

  it("atomically records Journal A recovery terminals without fabricating phase 20", async () => {
    const cases = [
      {
        suffix: "open",
        terminal: "entry_terminal_open" as const,
        proof: { kind: "landed_position" as const, side: "long" as const, price: 151.25, sizeBase: 2 },
        recordedAfterBroadcast: true,
      },
      {
        suffix: "unwound",
        terminal: "entry_terminal_unwound" as const,
        proof: { kind: "landed_then_unwound" as const, side: "short" as const, price: 149.5, sizeBase: 1.5 },
        recordedAfterBroadcast: true,
      },
      {
        suffix: "no-land",
        terminal: "entry_terminal_no_land" as const,
        proof: { kind: "flat_after_landing_window" as const },
        recordedAfterBroadcast: false,
      },
    ];
    for (const testCase of cases) {
      const decisionId = `decision-recovery-${testCase.suffix}-${RUN}`;
      const attemptId = await journal.appendRequiredEntryPrebroadcast({
        bot, decisionId, side: "long", clientOrderId: `client-${testCase.suffix}-${RUN}`, sizeBase: 2,
      });
      const observedAt = new Date(`2026-08-05T00:00:0${cases.indexOf(testCase)}.000Z`);
      await journal.appendEntryReconciliationTerminal({
        base: journal.journalBase(bot, decisionId),
        attemptId,
        terminal: testCase.terminal,
        proof: testCase.proof as any,
        observedAt,
      } as any);
      // Exact replay is idempotent only because both event identities committed.
      await journal.appendEntryReconciliationTerminal({
        base: journal.journalBase(bot, decisionId), attemptId,
        terminal: testCase.terminal, proof: testCase.proof as any, observedAt,
      } as any);
      const rows = await dbModule.pool.query(
        `SELECT event_type, phase, recorded_after_broadcast
           FROM ai_trader_execution_events WHERE attempt_id=$1 ORDER BY phase NULLS LAST, event_type`,
        [attemptId],
      );
      expect(rows.rows.filter((row) => row.event_type === "reconciliation_observed")).toHaveLength(1);
      expect(rows.rows.filter((row) => row.event_type === testCase.terminal)).toEqual([
        expect.objectContaining({ recorded_after_broadcast: testCase.recordedAfterBroadcast }),
      ]);
      expect(rows.rows.some((row) => row.phase === 20)).toBe(false);
    }
  });

  it("rejects missing command lineage, phase 20, and an existing phase-90 terminal with no partial append", async () => {
    const makeArgs = (decisionId: string) => ({
      base: journal.journalBase(bot, decisionId),
      attemptId: journal.entryAttemptId(decisionId),
      terminal: "entry_terminal_open" as const,
      proof: { kind: "landed_position" as const, side: "long" as const, price: 150, sizeBase: 1 },
    });

    const missingTen = `decision-missing-ten-${RUN}`;
    await journal.appendExecutionEvents([{
      ...journal.journalBase(bot, missingTen), attemptId: journal.entryAttemptId(missingTen),
      action: "entry", cause: "decision", eventType: "attempt_claimed", side: "long",
    }]);
    await expect(journal.appendEntryReconciliationTerminal(makeArgs(missingTen)))
      .rejects.toThrow("execution_journal_recovery_missing_command_lineage");

    const missingZero = `decision-missing-zero-${RUN}`;
    const missingZeroAttempt = journal.entryAttemptId(missingZero);
    await dbModule.pool.query(
      `INSERT INTO ai_trader_execution_events
        (event_identity, attempt_id, bot_id, decision_id, action, cause, event_type, phase,
         protocol, account_scope, account_ref, market, side, observed_at)
       VALUES ($1,$2,$3,$4,'entry','decision','prebroadcast_authorized',10,
         'pacifica','main',$5,'SOL-PERP','long',now())`,
      [`identity-missing-zero-${RUN}`, missingZeroAttempt, bot.id, missingZero, bot.walletAddress],
    );
    await expect(journal.appendEntryReconciliationTerminal(makeArgs(missingZero)))
      .rejects.toThrow("execution_journal_recovery_missing_command_lineage");

    const withTwenty = `decision-with-twenty-${RUN}`;
    const withTwentyAttempt = await journal.appendRequiredEntryPrebroadcast({
      bot, decisionId: withTwenty, side: "long", clientOrderId: `client-20-${RUN}`, sizeBase: 1,
    });
    await journal.appendExecutionEvents([{
      ...journal.journalBase(bot, withTwenty), attemptId: withTwentyAttempt,
      action: "entry", cause: "decision", eventType: "broadcast_result", venueStatus: "unknown",
      recordedAfterBroadcast: true,
    }]);
    await expect(journal.appendEntryReconciliationTerminal(makeArgs(withTwenty)))
      .rejects.toThrow("execution_journal_recovery_phase20_present");

    const withTerminal = `decision-with-terminal-${RUN}`;
    const withTerminalAttempt = await journal.appendRequiredEntryPrebroadcast({
      bot, decisionId: withTerminal, side: "long", clientOrderId: `client-90-${RUN}`, sizeBase: 1,
    });
    await dbModule.pool.query(
      `INSERT INTO ai_trader_execution_events
        (event_identity, attempt_id, bot_id, decision_id, action, cause, event_type, phase,
         protocol, account_scope, account_ref, market, side, price, size_base, recorded_after_broadcast, observed_at)
       VALUES ($1,$2,$3,$4,'entry','decision','entry_terminal_open',90,
         'pacifica','main',$5,'SOL-PERP','long',150,1,true,now())`,
      [`identity-existing-terminal-${RUN}`, withTerminalAttempt, bot.id, withTerminal, bot.walletAddress],
    );
    await expect(journal.appendEntryReconciliationTerminal(makeArgs(withTerminal)))
      .rejects.toThrow("execution_journal_recovery_terminal_present");

    for (const attemptId of [journal.entryAttemptId(missingTen), missingZeroAttempt, withTwentyAttempt, withTerminalAttempt]) {
      const result = await dbModule.pool.query(
        "SELECT count(*)::int AS count FROM ai_trader_execution_events WHERE attempt_id=$1 AND event_type='reconciliation_observed'",
        [attemptId],
      );
      expect(result.rows[0]?.count).toBe(0);
    }
  });

  it("rejects every recovery identity mismatch and ambiguous evidence with no partial terminal", async () => {
    const requestedBot = { ...bot };
    const mismatches = [
      { label: "decision", storedBot: requestedBot, storedDecision: `other-decision-${RUN}` },
      { label: "bot", storedBot: { ...requestedBot, id: `other-bot-id-${RUN}` } },
      { label: "account", storedBot: { ...requestedBot, walletAddress: `other-wallet-${RUN}` } },
      { label: "protocol", storedBot: { ...requestedBot, protocol: "drift" } },
      { label: "market", storedBot: { ...requestedBot, market: "BTC-PERP" } },
    ];
    for (const mismatch of mismatches) {
      const requestedDecision = `decision-mismatch-${mismatch.label}-${RUN}`;
      const storedDecision = mismatch.storedDecision ?? requestedDecision;
      const attemptId = journal.entryAttemptId(requestedDecision);
      const storedBase = journal.journalBase(mismatch.storedBot as any, storedDecision);
      await journal.appendExecutionEvents([
        { ...storedBase, attemptId, action: "entry", cause: "decision", eventType: "attempt_claimed", side: "long" },
        { ...storedBase, attemptId, action: "entry", cause: "decision", eventType: "prebroadcast_authorized",
          side: "long", clientOrderId: `client-mismatch-${mismatch.label}-${RUN}`, sizeBase: 1 },
      ]);
      await expect(journal.appendEntryReconciliationTerminal({
        base: journal.journalBase(requestedBot as any, requestedDecision), attemptId,
        terminal: "entry_terminal_open",
        proof: { kind: "landed_position", side: "long", price: 150, sizeBase: 1 },
      })).rejects.toThrow("execution_journal_recovery_identity_mismatch");
    }

    await expect(journal.appendEntryReconciliationTerminal({
      base: journal.journalBase(bot, `decision-attempt-mismatch-${RUN}`),
      attemptId: `entry:wrong-attempt-${RUN}`,
      terminal: "entry_terminal_open",
      proof: { kind: "landed_position", side: "long", price: 150, sizeBase: 1 },
    })).rejects.toThrow("execution_journal_recovery_identity_mismatch");

    const ambiguous = `decision-ambiguous-${RUN}`;
    const ambiguousAttempt = await journal.appendRequiredEntryPrebroadcast({
      bot, decisionId: ambiguous, side: "long", clientOrderId: `client-ambiguous-${RUN}`, sizeBase: 1,
    });
    await expect(journal.appendEntryReconciliationTerminal({
      base: journal.journalBase(bot, ambiguous), attemptId: ambiguousAttempt,
      terminal: "entry_terminal_open",
      proof: { kind: "landed_position", side: "long", price: 0, sizeBase: 1 },
    })).rejects.toThrow("execution_journal_recovery_ambiguous_evidence");
  });

  it("rejects a partially pre-existing recovery pair instead of completing it", async () => {
    const decisionId = `decision-partial-${RUN}`;
    const attemptId = await journal.appendRequiredEntryPrebroadcast({
      bot, decisionId, side: "long", clientOrderId: `client-partial-${RUN}`, sizeBase: 1,
    });
    const observedAt = new Date("2026-08-05T00:01:00.000Z");
    await journal.appendExecutionEvents([{
      ...journal.journalBase(bot, decisionId), attemptId,
      action: "entry", cause: "decision", eventType: "reconciliation_observed",
      side: "long", price: 150, sizeBase: 1, observedAt,
    }]);
    await expect(journal.appendEntryReconciliationTerminal({
      base: journal.journalBase(bot, decisionId), attemptId, observedAt,
      terminal: "entry_terminal_open",
      proof: { kind: "landed_position", side: "long", price: 150, sizeBase: 1 },
    })).rejects.toThrow("execution_journal_recovery_partial_transaction");
    const terminals = await dbModule.pool.query(
      "SELECT count(*)::int AS count FROM ai_trader_execution_events WHERE attempt_id=$1 AND phase=90",
      [attemptId],
    );
    expect(terminals.rows[0]?.count).toBe(0);
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
