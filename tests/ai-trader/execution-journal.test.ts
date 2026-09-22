import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appendExecutionEvents,
  resolveLiveBreakevenClaim,
} from "../../server/ai-trader/execution-journal";

describe("resolveLiveBreakevenClaim", () => {
  const FP = "A".repeat(64);
  const NOW = new Date("2026-09-13T00:00:00.000Z");
  const row = (ordinal: number, fingerprint = String(ordinal).padStart(64, "B"), observedAt = NOW) => ({
    authorityFingerprint: fingerprint,
    attemptOrdinal: ordinal,
    observedAt,
  });

  it("allocates the fifth and final attempt", () => {
    expect(resolveLiveBreakevenClaim([row(1), row(2), row(3), row(4)], FP, NOW)).toEqual({
      status: "claimed",
      attemptId: "",
      ordinal: 5,
    });
  });

  it("fails closed after five attempts and on duplicate authority", () => {
    expect(resolveLiveBreakevenClaim([row(1), row(2), row(3), row(4), row(5)], FP, NOW)).toEqual({ status: "exhausted" });
    expect(resolveLiveBreakevenClaim([row(1, FP)], FP, NOW)).toEqual({ status: "duplicate" });
  });

  it("rejects clock regression and malformed claim input", () => {
    expect(resolveLiveBreakevenClaim(
      [row(1, "B".repeat(64), new Date(NOW.getTime() + 1))],
      FP,
      NOW,
    )).toEqual({ status: "clock_regression" });
    expect(resolveLiveBreakevenClaim([], "not-a-fingerprint", NOW)).toEqual({ status: "unavailable" });
  });

  it("reserves protective claims for the atomic claim API before database access", async () => {
    await expect(appendExecutionEvents([{
      action: "protective",
    } as any])).rejects.toThrow("execution_journal_protective_claim_requires_atomic_api");
  });
});

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
  const PREBROADCAST_PRICE = 150;
  const PREBROADCAST_OBSERVED_AT = new Date("2026-08-19T00:00:00.000Z");

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

  it("claims five durable live-breakeven ordinals and rejects duplicate, exhausted, and regressed claims", async () => {
    await dbModule.ensureSchema();
    const decisionId = `decision-protective-${RUN}`;
    const positionFingerprint = "1".repeat(64);
    const bracketFingerprint = "2".repeat(64);
    const observedAt = new Date("2026-09-13T00:00:00.000Z");
    const authorities = ["A", "B", "C", "D", "E", "F"].map((value) => value.repeat(64));
    const claim = (authorityFingerprint: string, at = observedAt) => journal.claimLiveBreakevenAttempt({
      bot,
      decisionId,
      side: "long",
      authorityFingerprint,
      positionFingerprint,
      bracketFingerprint,
      observedAt: at,
    });

    const firstClaim = await claim(authorities[0]);
    expect(firstClaim).toMatchObject({ status: "claimed", ordinal: 1 });
    await expect(claim(authorities[0])).resolves.toEqual({ status: "duplicate" });
    for (let index = 1; index < 5; index += 1) {
      await expect(claim(authorities[index])).resolves.toMatchObject({
        status: "claimed",
        ordinal: index + 1,
      });
    }
    await expect(claim(authorities[5])).resolves.toEqual({ status: "exhausted" });
    await expect(claim("9".repeat(64), new Date(observedAt.getTime() - 1))).resolves.toEqual({
      status: "clock_regression",
    });

    const rows = await dbModule.pool.query(
      "SELECT action, cause, event_type, phase, authority_fingerprint, position_fingerprint, bracket_fingerprint, attempt_ordinal FROM ai_trader_execution_events WHERE decision_id=$1 ORDER BY attempt_ordinal",
      [decisionId],
    );
    expect(rows.rows).toHaveLength(5);
    expect(rows.rows.map((row) => Number(row.attempt_ordinal))).toEqual([1, 2, 3, 4, 5]);
    expect(rows.rows.every((row) => row.action === "protective"
      && row.cause === "protective" && row.event_type === "attempt_claimed"
      && Number(row.phase) === 0 && row.position_fingerprint === positionFingerprint
      && row.bracket_fingerprint === bracketFingerprint)).toBe(true);

    const nextEpochClaim = await journal.claimLiveBreakevenAttempt({
      bot,
      decisionId,
      side: "long",
      authorityFingerprint: "9".repeat(64),
      positionFingerprint: "3".repeat(64),
      bracketFingerprint,
      observedAt,
    });
    expect(nextEpochClaim).toMatchObject({ status: "claimed", ordinal: 1 });
    if (firstClaim.status === "claimed" && nextEpochClaim.status === "claimed") {
      expect(nextEpochClaim.attemptId).not.toBe(firstClaim.attemptId);
    }
  }, 30_000);

  it("orders epoch then attempt locks without deadlocking a concurrent close claim", async () => {
    await dbModule.ensureSchema();
    const decisionId = `decision-protective-concurrent-${RUN}`;
    const positionFingerprint = "4".repeat(64);
    const bracketFingerprint = "5".repeat(64);
    const authorityFingerprint = "6".repeat(64);
    const closeAttemptId = `close:concurrent-${RUN}`;
    const observedAt = new Date("2026-09-13T00:05:00.000Z");
    const protective = () => journal.claimLiveBreakevenAttempt({
      bot,
      decisionId,
      side: "long",
      authorityFingerprint,
      positionFingerprint,
      bracketFingerprint,
      observedAt,
    });
    const close = journal.appendExecutionEvents([{
      ...journal.journalBase(bot, decisionId),
      attemptId: closeAttemptId,
      action: "close",
      cause: "user_requested",
      eventType: "attempt_claimed",
      side: "long",
      observedAt,
    }]);

    const [first, second] = await Promise.all([protective(), protective(), close]);
    expect([first.status, second.status].sort()).toEqual(["claimed", "duplicate"]);
    const rows = await dbModule.pool.query(
      "SELECT action, attempt_id, attempt_ordinal FROM ai_trader_execution_events WHERE decision_id=$1 ORDER BY action, attempt_id",
      [decisionId],
    );
    expect(rows.rows.filter((row) => row.action === "protective")).toHaveLength(1);
    expect(rows.rows.filter((row) => row.action === "close")).toHaveLength(1);
    expect(Number(rows.rows.find((row) => row.action === "protective")?.attempt_ordinal)).toBe(1);
  }, 30_000);

  it("migrates the exact old action constraint and retains append-only enforcement", async () => {
    const schemaName = `qv_old_execution_${Date.now()}_${Math.random().toString(36).slice(2)}`
      .replace(/[^a-z0-9_]/g, "_");
    const client = await dbModule.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA "${schemaName}"`);
      await client.query(`SET LOCAL search_path TO "${schemaName}"`);
      await client.query(`CREATE TABLE ai_trader_execution_events (
        action text NOT NULL CHECK (action IN ('entry','close','cancel')),
        cause text NOT NULL CHECK (cause IN ('decision','paper','emergency_unwind','protective','user_requested','venue_detected','unconfirmed_orphan','startup_orphan','pre_close_bracket','survivor_leg')),
        event_type text NOT NULL,
        phase smallint,
        decision_id varchar,
        CONSTRAINT ai_trader_execution_phase_check CHECK (
          (event_type = 'attempt_claimed' AND phase = 0) OR
          (event_type = 'prebroadcast_authorized' AND action = 'entry' AND phase = 10) OR
          (event_type = 'broadcast_attempted' AND action IN ('close','cancel') AND phase = 10) OR
          (event_type = 'broadcast_result' AND phase = 20) OR
          (event_type IN ('position_observed','fill_observed','bracket_verified','reconciliation_observed') AND phase IS NULL) OR
          (event_type IN ('entry_terminal_open','entry_terminal_no_land','entry_terminal_unwound') AND action = 'entry' AND phase = 90) OR
          (event_type IN ('close_terminal_confirmed','close_terminal_failed') AND action = 'close' AND phase = 90) OR
          (event_type IN ('cancel_terminal_confirmed','cancel_terminal_failed') AND action = 'cancel' AND phase = 90)
        )
      )`);
      await client.query(`CREATE FUNCTION reject_execution_mutation()
        RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          RAISE EXCEPTION 'append-only';
        END $$`);
      await client.query(`CREATE TRIGGER ai_trader_execution_events_append_only
        BEFORE UPDATE OR DELETE ON ai_trader_execution_events
        FOR EACH ROW EXECUTE FUNCTION reject_execution_mutation()`);
      const migration = dbModule.SCHEMA_MIGRATION_MANIFEST.find(
        (entry) => entry.id === "184-add-live-breakeven-protective-journal-claim",
      );
      if (!migration) throw new Error("live breakeven migration missing");
      await client.query(migration.sql);
      const canonicalConstraintNames = [
        "ai_trader_execution_events_action_check",
        "ai_trader_execution_phase_check",
        "ai_trader_execution_events_cause_check",
        "ai_trader_execution_protective_claim_check",
      ];
      const constraintOids = async () => (await client.query(
        `SELECT conname, oid::text AS oid
           FROM pg_constraint
          WHERE conrelid='ai_trader_execution_events'::regclass
            AND conname = ANY($1::text[])
          ORDER BY conname`,
        [canonicalConstraintNames],
      )).rows;
      const firstConstraintOids = await constraintOids();
      expect(firstConstraintOids.map((row) => row.conname)).toEqual([...canonicalConstraintNames].sort());
      await client.query(migration.sql);
      expect(await constraintOids()).toEqual(firstConstraintOids);

      await expect(client.query(`INSERT INTO ai_trader_execution_events
        (action,cause,event_type,phase,decision_id,authority_fingerprint,position_fingerprint,bracket_fingerprint,attempt_ordinal)
        VALUES ('protective','protective','attempt_claimed',0,'decision-old',$1,$2,$3,1)`,
      ["A".repeat(64), "B".repeat(64), "C".repeat(64)])).resolves.toMatchObject({ rowCount: 1 });
      for (const [action, cause] of [["entry", "decision"], ["close", "user_requested"], ["cancel", "pre_close_bracket"]]) {
        await expect(client.query(
          "INSERT INTO ai_trader_execution_events (action,cause,event_type,phase,decision_id) VALUES ($1,$2,'attempt_claimed',0,'legacy')",
          [action, cause],
        )).resolves.toMatchObject({ rowCount: 1 });
      }
      const constraints = await client.query(`SELECT conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE conrelid='ai_trader_execution_events'::regclass ORDER BY conname`);
      const byName = new Map(constraints.rows.map((row) => [row.conname, row.definition]));
      expect(byName.get("ai_trader_execution_events_action_check")).toContain("protective");
      expect(byName.get("ai_trader_execution_phase_check")).toContain("attempt_claimed");
      expect(byName.get("ai_trader_execution_protective_claim_check")).toContain("phase = 0");
      expect(constraints.rows.filter((row) => /action_check$/.test(row.conname))).toHaveLength(1);
      await client.query("SAVEPOINT update_probe");
      await expect(client.query("UPDATE ai_trader_execution_events SET decision_id='mutated' WHERE decision_id='legacy'"))
        .rejects.toThrow(/append-only/i);
      await client.query("ROLLBACK TO SAVEPOINT update_probe");
      await client.query("SAVEPOINT delete_probe");
      await expect(client.query("DELETE FROM ai_trader_execution_events WHERE decision_id='legacy'"))
        .rejects.toThrow(/append-only/i);
      await client.query("ROLLBACK TO SAVEPOINT delete_probe");
      await client.query("ROLLBACK");
    } finally {
      try { await client.query("ROLLBACK"); } catch { /* already rolled back */ }
      client.release();
    }
  }, 30_000);

  it("retains the protective close cause while keeping claim-only fields exclusive to the protective action", async () => {
    await dbModule.ensureSchema();
    const typedAttemptId = `close-protective-cause-${RUN}`;
    await expect(journal.appendExecutionEvents([{
      ...journal.journalBase(bot, null),
      attemptId: typedAttemptId,
      action: "close",
      cause: "protective",
      eventType: "attempt_claimed",
    }])).resolves.toBeUndefined();

    const rawAttemptId = `raw-close-protective-cause-${RUN}`;
    await expect(dbModule.pool.query(
      `INSERT INTO ai_trader_execution_events
        (event_identity, attempt_id, bot_id, decision_id, action, cause, event_type, phase,
         protocol, account_scope, account_ref, market, observed_at)
       VALUES ($1,$2,$3,NULL,'close','protective','attempt_claimed',0,
         'pacifica','main',$4,'SOL-PERP',now())`,
      [`identity-${rawAttemptId}`, rawAttemptId, bot.id, bot.walletAddress],
    )).resolves.toMatchObject({ rowCount: 1 });

    await expect(journal.appendExecutionEvents([{
      ...journal.journalBase(bot, null),
      attemptId: `typed-close-with-claim-field-${RUN}`,
      action: "close",
      cause: "protective",
      eventType: "attempt_claimed",
      authorityFingerprint: "A".repeat(64),
    }])).rejects.toThrow("execution_journal_invalid_protective_claim");

    const invalidRawAttemptId = `raw-close-with-claim-field-${RUN}`;
    await expect(dbModule.pool.query(
      `INSERT INTO ai_trader_execution_events
        (event_identity, attempt_id, bot_id, decision_id, action, cause, event_type, phase,
         protocol, account_scope, account_ref, market, authority_fingerprint, observed_at)
       VALUES ($1,$2,$3,NULL,'close','protective','attempt_claimed',0,
         'pacifica','main',$4,'SOL-PERP',$5,now())`,
      [`identity-${invalidRawAttemptId}`, invalidRawAttemptId, bot.id, bot.walletAddress, "A".repeat(64)],
    )).rejects.toThrow(/protective_claim_check/i);
  }, 30_000);

  it("required entry prebroadcast appends claim and authorization atomically", async () => {
    const decisionId = `decision-required-${RUN}`;
    const observedAt = new Date("2026-08-23T00:00:00.000Z");
    await journal.appendRequiredEntryPrebroadcast({
      bot,
      decisionId,
      side: "long",
      clientOrderId: `client-${RUN}`,
      sizeBase: 1.25,
      price: 150.75,
      observedAt,
    });
    const rows = await dbModule.pool.query(
      "SELECT event_type, phase, price, observed_at FROM ai_trader_execution_events WHERE attempt_id=$1 ORDER BY phase",
      [`entry:${decisionId}`],
    );
    expect(rows.rows.map((row) => ({
      event_type: row.event_type,
      phase: row.phase,
      price: row.price === null ? null : Number(row.price),
      observed_at: new Date(row.observed_at).toISOString(),
    }))).toEqual([
      { event_type: "attempt_claimed", phase: 0, price: null, observed_at: observedAt.toISOString() },
      { event_type: "prebroadcast_authorized", phase: 10, price: 150.75, observed_at: observedAt.toISOString() },
    ]);
  });

  it("rejects missing or invalid required entry price and timestamp before appending", async () => {
    const invalidCases = [
      { suffix: "missing-price", price: undefined, observedAt: PREBROADCAST_OBSERVED_AT, error: "execution_journal_invalid_price" },
      { suffix: "nan-price", price: Number.NaN, observedAt: PREBROADCAST_OBSERVED_AT, error: "execution_journal_invalid_price" },
      { suffix: "zero-price", price: 0, observedAt: PREBROADCAST_OBSERVED_AT, error: "execution_journal_invalid_price" },
      { suffix: "negative-price", price: -1, observedAt: PREBROADCAST_OBSERVED_AT, error: "execution_journal_invalid_price" },
      { suffix: "missing-time", price: PREBROADCAST_PRICE, observedAt: undefined, error: "execution_journal_invalid_observed_at" },
      { suffix: "invalid-time", price: PREBROADCAST_PRICE, observedAt: new Date(Number.NaN), error: "execution_journal_invalid_observed_at" },
    ] as const;

    for (const testCase of invalidCases) {
      const decisionId = `decision-invalid-${testCase.suffix}-${RUN}`;
      await expect(journal.appendRequiredEntryPrebroadcast({
        bot,
        decisionId,
        side: "long",
        clientOrderId: `client-invalid-${testCase.suffix}-${RUN}`,
        sizeBase: 1,
        price: testCase.price,
        observedAt: testCase.observedAt,
      } as any)).rejects.toThrow(testCase.error);
      const rows = await dbModule.pool.query(
        "SELECT count(*)::int AS count FROM ai_trader_execution_events WHERE attempt_id=$1",
        [`entry:${decisionId}`],
      );
      expect(rows.rows[0]?.count).toBe(0);
    }
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
      price: PREBROADCAST_PRICE,
      observedAt,
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
      price: PREBROADCAST_PRICE,
      observedAt,
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
      "SELECT count(*) OVER ()::int AS count, event_identity FROM ai_trader_execution_events WHERE attempt_id=$1",
      [attemptId],
    );
    expect(count.rows[0]?.count).toBe(1);
    const legacyPreimage = [
      attemptId, bot.id, null, "close", "startup_orphan", "attempt_claimed", 0,
      "pacifica", "main", bot.walletAddress, "SOL-PERP", null, null, null, null,
      null, null, null, null, null, null, false, observedAt.toISOString(),
    ];
    const legacyIdentity = createHash("sha256")
      .update(JSON.stringify(legacyPreimage)).digest("hex").toUpperCase();
    expect(count.rows[0]?.event_identity).toBe(legacyIdentity);
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

  it("replays executor-written open history by durable identity across fresh venue measurements", async () => {
    const decisionId = `decision-direct-recovery-${RUN}`;
    const attemptId = await journal.appendRequiredEntryPrebroadcast({
      bot, decisionId, side: "long", clientOrderId: `client-direct-${RUN}`, sizeBase: 1,
      price: PREBROADCAST_PRICE, observedAt: PREBROADCAST_OBSERVED_AT,
    });
    const base = journal.journalBase(bot, decisionId);
    const enteredAt = new Date("2026-08-19T02:00:00.000Z");
    await journal.appendExecutionEvents([
      { ...base, attemptId, action: "entry", cause: "decision", eventType: "broadcast_result",
        side: "long", clientOrderId: `client-direct-${RUN}`, venueStatus: "filled",
        price: 151.25, sizeBase: 0.9, recordedAfterBroadcast: true, observedAt: enteredAt },
      { ...base, attemptId, action: "entry", cause: "decision", eventType: "position_observed",
        side: "long", price: 151.2, sizeBase: 1, observedAt: enteredAt },
      { ...base, attemptId, action: "entry", cause: "decision", eventType: "fill_observed",
        side: "long", clientOrderId: `client-direct-${RUN}`, venueStatus: "filled",
        price: 151.25, sizeBase: 0.9, observedAt: enteredAt },
      { ...base, attemptId, action: "entry", cause: "decision", eventType: "bracket_verified",
        side: "long", observedAt: enteredAt },
      { ...base, attemptId, action: "entry", cause: "decision", eventType: "entry_terminal_open",
        side: "long", price: 151.25, sizeBase: 1, observedAt: enteredAt },
    ]);

    const restartedAt = new Date("2026-08-19T02:05:00.000Z");
    const requested = [
      { ...base, attemptId, action: "entry", cause: "decision", eventType: "position_observed",
        side: "long", price: 151.18, sizeBase: 0.98, observedAt: restartedAt },
      { ...base, attemptId, action: "entry", cause: "decision", eventType: "bracket_verified",
        side: "long", observedAt: restartedAt },
      ...journal.buildEntryReconciliationTerminalEvents({
        base, attemptId, terminal: "entry_terminal_open",
        proof: { kind: "landed_position", side: "long", price: 151.25, sizeBase: 1 },
        observedAt: restartedAt,
      }),
    ] as const;

    await dbModule.db.transaction(async (tx) => {
      const prepared = await journal.prepareExecutionJournalEventsInTransaction(tx, requested, {
        requireEntryCommandLineage: true,
        requireExactRequestedReplay: true,
        requireSemanticRequestedReplay: true,
      });
      expect(prepared.status).toBe("replayed");
    });
    await expect(dbModule.db.transaction(async (tx) => {
      await journal.prepareExecutionJournalEventsInTransaction(tx, [
        { ...requested[0], side: "short" },
        ...requested.slice(1),
      ], {
        requireEntryCommandLineage: true,
        requireExactRequestedReplay: true,
        requireSemanticRequestedReplay: true,
      });
    })).rejects.toThrow("execution_journal_atomic_replay_conflict");
  });

  it("sorts multi-attempt recovery locks and an already-held lock preserves lineage, phase, and exact-suffix checks", async () => {
    const observedAt = new Date("2026-08-19T00:30:00.000Z");
    const base = journal.journalBase(bot, null);
    const attemptZ = `close:z-${RUN}`;
    const attemptA = `close:a-${RUN}`;
    const closeA = [{ ...base, attemptId: attemptA, action: "close", cause: "startup_orphan",
      eventType: "attempt_claimed", observedAt }] as const;
    const closeZ = [{ ...base, attemptId: attemptZ, action: "close", cause: "startup_orphan",
      eventType: "attempt_claimed", observedAt }] as const;
    await dbModule.db.transaction(async (tx) => {
      expect(await journal.acquireExecutionJournalAttemptLocksInTransaction(
        tx, [closeZ, closeA, closeZ],
      )).toEqual([attemptA, attemptZ]);
    });

    const missingLineageDecision = `decision-held-missing-lineage-${RUN}`;
    const missingLineageAttempt = journal.entryAttemptId(missingLineageDecision);
    const missingLineageEvent = [{
      ...journal.journalBase(bot, missingLineageDecision), attemptId: missingLineageAttempt,
      action: "entry", cause: "decision", eventType: "entry_terminal_open",
      side: "long", price: 150, sizeBase: 1, recordedAfterBroadcast: true, observedAt,
    }] as const;
    await expect(dbModule.db.transaction(async (tx) => {
      await journal.acquireExecutionJournalAttemptLocksInTransaction(tx, [missingLineageEvent]);
      await journal.prepareExecutionJournalEventsInTransaction(tx, missingLineageEvent, {
        requireEntryCommandLineage: true,
        requireExactRequestedReplay: true,
        attemptLockAlreadyHeld: true,
      });
    })).rejects.toThrow("execution_journal_entry_command_lineage_conflict");

    const phaseAttempt = `close:held-phase-${RUN}`;
    const phaseClaim = [{ ...base, attemptId: phaseAttempt, action: "close", cause: "startup_orphan",
      eventType: "attempt_claimed", observedAt }] as const;
    await journal.appendExecutionEvents(phaseClaim);
    const skippedPhase = [{ ...base, attemptId: phaseAttempt, action: "close", cause: "startup_orphan",
      eventType: "broadcast_result", venueStatus: "unknown", recordedAfterBroadcast: true, observedAt }] as const;
    await expect(dbModule.db.transaction(async (tx) => {
      await journal.acquireExecutionJournalAttemptLocksInTransaction(tx, [skippedPhase]);
      await journal.prepareExecutionJournalEventsInTransaction(tx, skippedPhase, {
        requireExactRequestedReplay: true,
        attemptLockAlreadyHeld: true,
      });
    })).rejects.toThrow("execution_journal_command_phase_conflict");

    const partialDecision = `decision-held-partial-${RUN}`;
    const partialAttempt = await journal.appendRequiredEntryPrebroadcast({
      bot, decisionId: partialDecision, side: "long", clientOrderId: `client-held-${RUN}`, sizeBase: 1,
      price: PREBROADCAST_PRICE, observedAt: PREBROADCAST_OBSERVED_AT,
    });
    const partialBase = journal.journalBase(bot, partialDecision);
    const exactSuffix = [
      { ...partialBase, attemptId: partialAttempt, action: "entry", cause: "decision",
        eventType: "position_observed", side: "long", price: 150, sizeBase: 1, observedAt },
      { ...partialBase, attemptId: partialAttempt, action: "entry", cause: "decision",
        eventType: "bracket_verified", side: "long", observedAt },
    ] as const;
    await journal.appendExecutionEvents([exactSuffix[0]]);
    await expect(dbModule.db.transaction(async (tx) => {
      await journal.acquireExecutionJournalAttemptLocksInTransaction(tx, [exactSuffix]);
      await journal.prepareExecutionJournalEventsInTransaction(tx, exactSuffix, {
        requireEntryCommandLineage: true,
        requireExactRequestedReplay: true,
        attemptLockAlreadyHeld: true,
      });
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
        price: PREBROADCAST_PRICE, observedAt: PREBROADCAST_OBSERVED_AT,
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
      price: PREBROADCAST_PRICE, observedAt: PREBROADCAST_OBSERVED_AT,
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
      price: PREBROADCAST_PRICE, observedAt: PREBROADCAST_OBSERVED_AT,
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
      price: PREBROADCAST_PRICE, observedAt: PREBROADCAST_OBSERVED_AT,
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
      price: PREBROADCAST_PRICE, observedAt: PREBROADCAST_OBSERVED_AT,
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

  it("accepts only exact stable confirmed-close batches and rejects a drifting or failed terminal", () => {
    const decisionId = `decision-close-shape-${RUN}`;
    const attemptId = `close:${decisionId}:shape`;
    const base = journal.journalBase(bot, decisionId);
    const closedAt = new Date("2026-08-19T07:00:00.000Z");
    const close = { exitPrice: 151, realizedPnl: 0.8, feesPaid: 0.2, closedAt };
    const events = [
      { ...base, attemptId, action: "close", cause: "paper", eventType: "attempt_claimed", side: "long", observedAt: closedAt },
      { ...base, attemptId, action: "close", cause: "paper", eventType: "fill_observed", side: "long",
        price: 151, sizeBase: 1, fee: 0.2, realizedPnl: 0.8, observedAt: closedAt },
      { ...base, attemptId, action: "close", cause: "paper", eventType: "close_terminal_confirmed", side: "long",
        price: 151, sizeBase: 1, fee: 0.2, realizedPnl: 0.8, observedAt: closedAt },
    ] as any;
    const expected = { botId: bot.id, decisionId, side: "long" as const, sizeBase: 1, close };
    expect(journal.isExactConfirmedCloseJournalBatch(events, expected)).toBe(true);
    expect(journal.isExactConfirmedCloseJournalBatch(
      events.map((event: any, index: number) => index === 0 ? { ...event, observedAt: new Date(closedAt.getTime() + 1) } : event),
      expected,
    )).toBe(false);
    expect(journal.isExactConfirmedCloseJournalBatch(
      events.map((event: any, index: number) => index === 2
        ? { ...event, eventType: "close_terminal_failed", failureCode: "venue_error" }
        : event),
      expected,
    )).toBe(false);
    expect(journal.isExactConfirmedCloseJournalBatch(
      events.map((event: any, index: number) => index === 2 ? { ...event, fee: 0.21 } : event),
      expected,
    )).toBe(false);
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
