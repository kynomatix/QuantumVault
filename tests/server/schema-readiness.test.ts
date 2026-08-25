import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  SCHEMA_CAPABILITIES,
  SCHEMA_FAILURE_CLASSES,
  SCHEMA_READINESS_REPROBE_DELAY_MS,
  SchemaCapabilityUnavailableError,
  applySchemaMigrationManifest,
  createSchemaReadinessAlert,
  getInstalledSchemaReadinessSnapshot,
  installSchemaReadinessSnapshot,
  probeSchemaMigrationManifest,
  registerSchemaMigrationManifest,
  reportSchemaReadiness,
  requireSchemaCapabilityReady,
  resetSchemaReadinessForTests,
  scheduleSchemaReadinessVerificationReprobe,
  type CatalogQuery,
  type SchemaMigrationDefinition,
} from "../../server/schema-readiness";

const recordErrorMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../server/storage", () => ({
  storage: { recordError: recordErrorMock },
}));

const labManifest: readonly SchemaMigrationDefinition[] = [
  {
    id: "000-lab-table",
    sql: "CREATE TABLE lab_candle_cache_v2",
    capabilities: ["lab_scanner"],
    operation: "ddl",
    requirements: [{
      kind: "table",
      table: "lab_candle_cache_v2",
      columns: ["id", "symbol", "timeframe"],
      constraintDefinitions: ["PRIMARY KEY (id)"],
    }],
  },
  {
    id: "001-lab-identity-index",
    sql: "CREATE UNIQUE INDEX lab_candle_cache_v2_identity_unique",
    capabilities: ["lab_scanner"],
    operation: "ddl",
    requirements: [{
      kind: "index",
      table: "lab_candle_cache_v2",
      index: "lab_candle_cache_v2_identity_unique",
      columns: ["symbol", "timeframe"],
      unique: true,
    }],
  },
  {
    id: "002-lab-lookup-index",
    sql: "CREATE INDEX lab_candle_cache_v2_lookup",
    capabilities: ["lab_scanner"],
    operation: "ddl",
    requirements: [{
      kind: "index",
      table: "lab_candle_cache_v2",
      index: "lab_candle_cache_v2_lookup",
      columns: ["symbol", "timeframe"],
      unique: false,
    }],
  },
];

function makeCatalog(options: {
  table?: boolean;
  identityIndex?: boolean;
  lookupIndex?: boolean;
  failSql?: string;
} = {}): CatalogQuery & ReturnType<typeof vi.fn> {
  const {
    table = true,
    identityIndex = true,
    lookupIndex = true,
    failSql,
  } = options;
  return vi.fn(async (text: string, values?: readonly unknown[]) => {
    if (failSql && text === failSql) throw new Error("raw storage failure must not escape");
    if (/^(CREATE|ALTER|UPDATE|INSERT)/.test(text)) return { rows: [] };
    if (text.includes("to_regclass")) return { rows: [{ relation: table ? "lab_candle_cache_v2" : null }] };
    if (text.includes("information_schema.columns")) {
      return { rows: table ? [{ column_name: "id" }, { column_name: "symbol" }, { column_name: "timeframe" }] : [] };
    }
    if (text.includes("pg_get_constraintdef") && !text.includes("c.conname=$2")) {
      return { rows: table ? [{ definition: "PRIMARY KEY (id)" }] : [] };
    }
    if (text.includes("FROM pg_index")) {
      const index = String(values?.[0]);
      const exists = index === "lab_candle_cache_v2_identity_unique" ? identityIndex : lookupIndex;
      return { rows: exists ? [{
        table_name: "lab_candle_cache_v2",
        is_unique: index === "lab_candle_cache_v2_identity_unique",
        predicate: null,
        columns: ["symbol", "timeframe"],
      }] : [] };
    }
    throw new Error(`unexpected catalog SQL: ${text}`);
  }) as CatalogQuery & ReturnType<typeof vi.fn>;
}

describe("schema readiness", () => {
  beforeEach(async () => {
    resetSchemaReadinessForTests();
    recordErrorMock.mockClear();
    const { flushErrorLog } = await import("../../server/error-log");
    await flushErrorLog();
  });

  it("attempts every statement while localizing a DDL failure whose final postcondition is absent", async () => {
    const query = makeCatalog({ failSql: labManifest[0].sql, table: false });
    const snapshot = await applySchemaMigrationManifest(query, labManifest);

    expect(query.mock.calls.some(([text]) => text === labManifest[1].sql)).toBe(true);
    expect(query.mock.calls.some(([text]) => text === labManifest[2].sql)).toBe(true);
    expect(snapshot.capabilities).toEqual(SCHEMA_CAPABILITIES);
    expect(snapshot.unavailableCapabilities).toEqual(["lab_scanner"]);
    expect(snapshot.evidence).toContainEqual({
      capability: "lab_scanner",
      failureClass: "ddl_failed",
      objectIdentity: "migration:000-lab-table",
    });
    expect(snapshot.evidence).toContainEqual({
      capability: "lab_scanner",
      failureClass: "postcondition_missing",
      objectIdentity: "table:lab_candle_cache_v2",
    });
  });

  it("does not poison readiness when idempotent DDL errors but its final postcondition is satisfied", async () => {
    const query = makeCatalog({ failSql: labManifest[0].sql });
    const snapshot = await applySchemaMigrationManifest(query, labManifest);

    expect(snapshot.unavailableCapabilities).toEqual([]);
    expect(snapshot.evidence).toEqual([]);
    expect(query.mock.calls.filter(([text]) => String(text).startsWith("CREATE"))).toHaveLength(3);
  });

  it("retains all 180 SQL entries exactly once, in order, with explicit metadata", () => {
    const sourcePath = new URL("../../server/db.ts", import.meta.url);
    const sourceText = readFileSync(sourcePath, "utf8");
    const source = ts.createSourceFile(sourcePath.pathname, sourceText, ts.ScriptTarget.Latest, true);
    let sqlArray: ts.ArrayLiteralExpression | undefined;
    let metadataArray: ts.ArrayLiteralExpression | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node)) {
        const name = node.name.getText(source);
        const expression = node.initializer && ts.isAsExpression(node.initializer)
          ? node.initializer.expression
          : node.initializer;
        if (expression && ts.isArrayLiteralExpression(expression)) {
          if (name === "schemaMigrationSql") sqlArray = expression;
          if (name === "schemaMigrationMetadata") metadataArray = expression;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(sqlArray).toBeDefined();
    expect(metadataArray).toBeDefined();

    const sqlEntries = sqlArray!.elements.map((element) => {
      expect(ts.isNoSubstitutionTemplateLiteral(element) || ts.isStringLiteral(element)).toBe(true);
      return (element as ts.NoSubstitutionTemplateLiteral).text;
    });
    const metadata = JSON.parse(metadataArray!.getText(source)) as Array<{
      id: string;
      capabilities: string[];
      requirements: unknown[];
      operation: "ddl" | "backfill";
    }>;
    expect(sqlEntries).toHaveLength(180);
    expect(metadata).toHaveLength(180);
    expect(new Set(metadata.map((entry) => entry.id)).size).toBe(180);
    expect(metadata.every((entry) => entry.capabilities.length > 0 && entry.requirements.length > 0)).toBe(true);
    const sqlDigest = createHash("sha256").update(sqlEntries.join("\u0000"), "utf8").digest("hex").toUpperCase();
    expect(sqlDigest).toBe("5C715B0BD0D2B4B0CF7B762429E2508658167FFD6A4E8332FED53E83B023592A");

    expect(sqlEntries[11]).toContain("total_volume numeric(30,6)");
    expect(sqlEntries[11]).toContain("total_trades integer");
    expect(sqlEntries[11]).not.toContain("cumulative_volume");
    expect(sqlEntries[70]).toContain("duplicate_object OR duplicate_table");
    expect(metadata[11]).toMatchObject({
      requirements: [{ kind: "table", columns: ["id", "total_volume", "total_trades", "updated_at"] }],
    });
    expect(JSON.stringify(metadata[26])).not.toContain("pending','confirmed','paid','failed");
    expect(JSON.stringify(metadata[100])).not.toContain("UNIQUE (wallet_address, asset_key)");
    expect(metadata[106]).toMatchObject({
      requirements: [{
        kind: "constraint_absent",
        table: "vault_positions",
        constraint: "vault_positions_wallet_asset_unique",
      }],
    });

    const avaxCorrectionSql = sqlEntries.at(-4)!;
    expect(metadata.at(-4)).toMatchObject({
      id: "176-scrub-rogue-avax-close",
      capabilities: ["signal_bot"],
      operation: "backfill",
    });
    expect(avaxCorrectionSql).toContain("491abec1-39c2-42c5-8963-e5f4fb644b3a");
    expect(avaxCorrectionSql).toContain("LOCK TABLE bot_trades IN ACCESS EXCLUSIVE MODE");
    expect(avaxCorrectionSql).toContain("FOR UPDATE");
    expect(avaxCorrectionSql).toContain("DELETE FROM bot_trades");
    expect(avaxCorrectionSql).toContain("jsonb_build_object");
    expect(avaxCorrectionSql).toContain("rogue AVAX trade fingerprint mismatch");

    const venueTruthSql = sqlEntries.at(-3)!;
    expect(metadata.at(-3)).toMatchObject({
      id: "177-repair-zec-link-close-fee-pnl",
      capabilities: ["signal_bot"],
      operation: "backfill",
      requirements: [{
        kind: "data",
        identity: "zec-link-close-fee-pnl-venue-truth",
        checkSql: expect.stringContaining("fee=1.907666 AND pnl=382.03"),
      }],
    });
    expect(venueTruthSql).toContain("LOCK TABLE bot_trades IN ACCESS EXCLUSIVE MODE");
    expect(venueTruthSql.match(/FOR UPDATE/g)).toHaveLength(4);
    expect(venueTruthSql.match(/UPDATE bot_trades/g)).toHaveLength(3);
    expect(venueTruthSql).toContain("jsonb_build_object");
    expect(venueTruthSql).toContain("target_trade.protocol_fill_id IS NOT NULL");
    expect(venueTruthSql.match(/target_trade.error_message IS NOT NULL/g)).toHaveLength(2);
    expect(venueTruthSql).toContain("md5(COALESCE(target_trade.webhook_payload::text, ''))");
    const qualificationRecordSql = sqlEntries.at(-2)!;
    expect(metadata.at(-2)).toMatchObject({
      id: "178-create-ai-trader-qualification-records",
      capabilities: ["ai_trader"],
      operation: "ddl",
    });
    expect(qualificationRecordSql).toContain("CREATE TABLE IF NOT EXISTS ai_trader_qualification_records");
    expect(qualificationRecordSql).toContain("UNIQUE (bot_id, qualification_era_digest)");
    expect(qualificationRecordSql).toContain("ON DELETE CASCADE");
    expect(qualificationRecordSql).toContain("BEFORE UPDATE ON ai_trader_qualification_records");
    expect(qualificationRecordSql).not.toContain("BEFORE DELETE");

    for (const identity of [
      "d1d024a2-05b2-4d4b-8648-2ee445534716",
      "e31fba28-bba3-4be1-85a0-b5b5c96d6825",
      "b35049e2-44d2-4137-9259-6bbd1a7a75d0",
      "cbf14cd4-3243-4ac5-9c6f-e09d0da5f0a0",
      "e74e9c11-538b-4ed4-9872-d8157486b784",
      "11727250059",
      "11823286221",
      "11872514945",
    ]) {
      expect(venueTruthSql).toContain(identity);
    }

    for (const venueLiteral of [
      "fee = 1.113780",
      "pnl = -1.215979",
      "fee = 0.195549",
      "pnl = -1.391149",
      "fee = 1.907666",
      "pnl = 382.030534",
    ]) {
      expect(venueTruthSql).toContain(venueLiteral);
    }

    for (const storedScaleNoOp of [
      "target_trade.fee = 1.113780 AND target_trade.pnl = -1.22",
      "target_trade.fee = 0.195549 AND target_trade.pnl = -1.39",
      "target_trade.fee = 1.907666 AND target_trade.pnl = 382.03",
    ]) {
      expect(venueTruthSql).toContain(storedScaleNoOp);
    }

    expect(venueTruthSql.match(/close repair fingerprint mismatch:/g)).toHaveLength(3);
    expect(venueTruthSql.match(/stored values mismatch:/g)).toHaveLength(3);
    expect(venueTruthSql).toContain("owner fingerprint mismatch:");
    expect(venueTruthSql).toContain("stats update missed owner:");

    const conventionSql = sqlEntries.at(-1)!;
    expect(metadata.at(-1)).toMatchObject({
      id: "179-pin-bot-trades-pnl-convention",
      capabilities: ["signal_bot", "portfolio"],
      operation: "backfill",
    });
    expect(conventionSql).toContain("LOCK TABLE bot_trades IN ACCESS EXCLUSIVE MODE");
    expect(conventionSql).toContain("ADD COLUMN IF NOT EXISTS pnl_convention text");
    expect(conventionSql).toContain("ADD COLUMN IF NOT EXISTS fee_truth_status text");
    expect(conventionSql).toContain("pnl_convention = CASE");
    expect(conventionSql).toContain("webhook_payload->>'closeReason' IN ('external_close', 'tpsl', 'liquidation')");
    expect(conventionSql).not.toMatch(/closeReason' IN \([^)]*partial_(?:tp|sl)/);
    expect(conventionSql).toContain("fee_truth_status = CASE");
    expect(conventionSql).toContain("venue_exact_repaired");
    expect(conventionSql).toContain("legacy_unverified");
    expect(conventionSql).toContain("current_pipeline");
    expect(conventionSql).toContain("ALTER COLUMN pnl_convention SET NOT NULL");
    expect(conventionSql).toContain("ALTER COLUMN fee_truth_status SET NOT NULL");
    expect(conventionSql).toContain("WITH canonical_rows AS");
    expect(conventionSql).toContain("bt.pnl::numeric - bt.fee::numeric");
    expect(conventionSql).toContain("UPDATE trading_bots bot");
    expect(conventionSql).not.toMatch(/UPDATE bot_trades[\s\S]*SET\s+(?:pnl|fee)\s*=/);
    for (const field of ["totalPnl", "totalTrades", "winningTrades", "losingTrades"]) {
      expect(conventionSql).toContain(`'${field}'`);
    }
  });

  it("matches exact production CHECK renderings without consuming SQL after casts", async () => {
    const manifest: readonly SchemaMigrationDefinition[] = [
      {
        id: "external-key",
        sql: "NOOP_EXTERNAL",
        capabilities: ["signal_bot"],
        operation: "ddl",
        requirements: [{
          kind: "constraint",
          table: "trading_bots",
          constraint: "trading_bots_external_key_invariant",
          definitionIncludes: [
            "CHECK (NOT (subaccount_auth_mode = 'external_key' AND subaccount_status = 'active') OR protocol_subaccount_id IS NOT NULL AND (bot_subaccount_key_encrypted IS NOT NULL OR bot_subaccount_key_encrypted_v3 IS NOT NULL))",
          ],
        }],
      },
      {
        id: "referral-level",
        sql: "NOOP_REFERRAL",
        capabilities: ["referrals"],
        operation: "ddl",
        requirements: [{
          kind: "table",
          table: "referral_reward_events",
          columns: ["id", "level"],
          constraintDefinitions: ["CHECK (level BETWEEN 1 AND 3)"],
        }],
      },
      {
        id: "scanner-hold",
        sql: "NOOP_HOLD",
        capabilities: ["ai_trader"],
        operation: "ddl",
        requirements: [{
          kind: "table",
          table: "scanner_incident_holds",
          columns: ["id", "state", "active_slot", "export_row_count", "export_digest"],
          constraintDefinitions: [
            "state IN ('baseline', 'canary', 'exported', 'released')",
            "CHECK ((state = 'released' AND active_slot IS NULL) OR (state <> 'released' AND active_slot = 1))",
            "CHECK ((state IN ('exported', 'released') AND export_row_count IS NOT NULL AND export_digest IS NOT NULL) OR (state IN ('baseline', 'canary') AND export_row_count IS NULL AND export_digest IS NULL))",
          ],
        }],
      },
    ];
    const query: CatalogQuery = async (text, values) => {
      if (text.startsWith("NOOP_")) return { rows: [] };
      const table = String(values?.[0] ?? "").replace("public.", "");
      if (text.includes("c.conname=$2")) {
        return { rows: [{
          definition: "CHECK (NOT (subaccount_auth_mode = 'external_key'::text AND subaccount_status = 'active'::text) OR protocol_subaccount_id IS NOT NULL AND (bot_subaccount_key_encrypted IS NOT NULL OR bot_subaccount_key_encrypted_v3 IS NOT NULL))",
        }] };
      }
      if (text.includes("to_regclass")) return { rows: [{ relation: table }] };
      if (text.includes("information_schema.columns")) {
        const names = table === "referral_reward_events"
          ? ["id", "level"]
          : ["id", "state", "active_slot", "export_row_count", "export_digest"];
        return { rows: names.map((column_name) => ({ column_name })) };
      }
      if (table === "referral_reward_events") {
        return { rows: [{ definition: "CHECK (level >= 1 AND level <= 3)" }] };
      }
      return { rows: [
        { definition: "CHECK (state = ANY (ARRAY['baseline'::text, 'canary'::text, 'exported'::text, 'released'::text]))" },
        { definition: "CHECK (state = 'released'::text AND active_slot IS NULL OR state <> 'released'::text AND active_slot = 1)" },
        { definition: "CHECK ((state = ANY (ARRAY['exported'::text, 'released'::text])) AND export_row_count IS NOT NULL AND export_digest IS NOT NULL OR (state = ANY (ARRAY['baseline'::text, 'canary'::text])) AND export_row_count IS NULL AND export_digest IS NULL)" },
      ] };
    };

    const snapshot = await applySchemaMigrationManifest(query, manifest);
    expect(snapshot.unavailableCapabilities).toEqual([]);
    expect(snapshot.evidence).toEqual([]);
  });

  it("uses only the latest requirement for the same final object identity", async () => {
    const manifest: readonly SchemaMigrationDefinition[] = [
      {
        id: "legacy-constraint",
        sql: "NOOP_LEGACY",
        capabilities: ["signal_bot"],
        operation: "ddl",
        requirements: [{
          kind: "constraint",
          table: "trading_bots",
          constraint: "shared_constraint",
          definitionIncludes: ["CHECK (legacy_value IS NOT NULL)"],
        }],
      },
      {
        id: "final-constraint",
        sql: "NOOP_FINAL",
        capabilities: ["signal_bot"],
        operation: "ddl",
        requirements: [{
          kind: "constraint",
          table: "trading_bots",
          constraint: "shared_constraint",
          definitionIncludes: ["CHECK (final_value IS NOT NULL)"],
        }],
      },
    ];
    const query = vi.fn(async (text: string) => text.startsWith("NOOP_")
      ? { rows: [] }
      : { rows: [{ definition: "CHECK (final_value IS NOT NULL)" }] });

    const snapshot = await applySchemaMigrationManifest(query, manifest);
    expect(snapshot.unavailableCapabilities).toEqual([]);
    expect(query.mock.calls.filter(([text]) => String(text).includes("pg_get_constraintdef"))).toHaveLength(1);
  });

  it("distinguishes catalog-query failure from a genuinely absent object", async () => {
    const manifest: readonly SchemaMigrationDefinition[] = [{
      id: "catalog-column",
      sql: "MUTATION_MUST_NOT_RUN",
      capabilities: ["platform"],
      operation: "ddl",
      requirements: [{ kind: "column", table: "platform_table", column: "ready_column" }],
    }];
    const failed = await probeSchemaMigrationManifest(async () => {
      throw new Error("catalog timeout");
    }, manifest);
    const missing = await probeSchemaMigrationManifest(async () => ({ rows: [] }), manifest);

    expect(failed.evidence).toEqual([{
      capability: "platform",
      failureClass: "verification_failed",
      objectIdentity: "column:platform_table.ready_column",
    }]);
    expect(missing.evidence).toEqual([{
      capability: "platform",
      failureClass: "postcondition_missing",
      objectIdentity: "column:platform_table.ready_column",
    }]);
  });

  it("preserves descending index direction from the catalog query", async () => {
    const manifest: readonly SchemaMigrationDefinition[] = [
      {
        id: "equity-index",
        sql: "NOOP_EQUITY",
        capabilities: ["portfolio"],
        operation: "ddl",
        requirements: [{
          kind: "index",
          table: "equity_events",
          index: "idx_equity_events_bot_created",
          columns: ["trading_bot_id", "created_at DESC"],
          unique: false,
        }],
      },
      {
        id: "qualification-index",
        sql: "NOOP_QUALIFICATION",
        capabilities: ["ai_trader"],
        operation: "ddl",
        requirements: [{
          kind: "index",
          table: "ai_trader_qualification_records",
          index: "idx_ai_trader_qualification_records_bot_evaluated",
          columns: ["bot_id", "evaluated_at DESC"],
          unique: false,
        }],
      },
    ];
    const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
      if (text.startsWith("NOOP_")) return { rows: [] };
      expect(text).toContain("i.indoption[k - 1] & 1");
      const qualification = values?.[0] === "idx_ai_trader_qualification_records_bot_evaluated";
      return { rows: [{
        table_name: qualification ? "ai_trader_qualification_records" : "equity_events",
        is_unique: false,
        predicate: null,
        columns: qualification ? ["bot_id", "evaluated_at DESC"] : ["trading_bot_id", "created_at DESC"],
      }] };
    });

    const snapshot = await applySchemaMigrationManifest(query, manifest);
    expect(snapshot.unavailableCapabilities).toEqual([]);
  });

  it("runs one 30-second postcondition-only re-probe for verification failure and replaces the snapshot", async () => {
    vi.useFakeTimers();
    try {
      const manifest: readonly SchemaMigrationDefinition[] = [{
        id: "reprobe-column",
        sql: "MUTATION_MUST_NOT_RUN",
        capabilities: ["platform"],
        operation: "ddl",
        requirements: [{ kind: "column", table: "platform_table", column: "ready_column" }],
      }];
      const initial = await probeSchemaMigrationManifest(async () => {
        throw new Error("catalog timeout");
      }, manifest);
      installSchemaReadinessSnapshot(initial);
      const reprobeQuery = vi.fn(async (text: string) => {
        expect(text).not.toBe("MUTATION_MUST_NOT_RUN");
        return { rows: [{ present: 1 }] };
      });
      const reprobe = vi.fn(() => probeSchemaMigrationManifest(reprobeQuery, manifest));

      expect(scheduleSchemaReadinessVerificationReprobe(initial, reprobe)).toBe(true);
      expect(scheduleSchemaReadinessVerificationReprobe(initial, reprobe)).toBe(false);
      await vi.advanceTimersByTimeAsync(SCHEMA_READINESS_REPROBE_DELAY_MS - 1);
      expect(reprobe).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(reprobe).toHaveBeenCalledTimes(1);
      expect(reprobeQuery).toHaveBeenCalledTimes(1);
      expect(getInstalledSchemaReadinessSnapshot()?.unavailableCapabilities).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not schedule the recovery timer for a genuine missing object", async () => {
    vi.useFakeTimers();
    try {
      const manifest: readonly SchemaMigrationDefinition[] = [{
        id: "missing-column",
        sql: "MUTATION_MUST_NOT_RUN",
        capabilities: ["platform"],
        operation: "ddl",
        requirements: [{ kind: "column", table: "platform_table", column: "missing_column" }],
      }];
      const missing = await probeSchemaMigrationManifest(async () => ({ rows: [] }), manifest);
      const reprobe = vi.fn(async () => missing);

      expect(scheduleSchemaReadinessVerificationReprobe(missing, reprobe)).toBe(false);
      await vi.advanceTimersByTimeAsync(SCHEMA_READINESS_REPROBE_DELAY_MS);
      expect(reprobe).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs one memoized postcondition-only probe when the Lab child has no snapshot", async () => {
    registerSchemaMigrationManifest(labManifest);
    const query = makeCatalog();

    await Promise.all([
      requireSchemaCapabilityReady("lab_scanner", query),
      requireSchemaCapabilityReady("lab_scanner", query),
      requireSchemaCapabilityReady("lab_scanner", query),
    ]);

    expect(query.mock.calls.every(([text]) => !/^(CREATE|ALTER|UPDATE|INSERT)/.test(String(text)))).toBe(true);
    expect(query).toHaveBeenCalledTimes(5);
  });

  it.each([
    ["missing table", { table: false }],
    ["missing identity index", { identityIndex: false }],
    ["missing lookup index", { lookupIndex: false }],
  ])("fails closed on %s in the child-process probe", async (_label, options) => {
    registerSchemaMigrationManifest(labManifest);
    await expect(requireSchemaCapabilityReady("lab_scanner", makeCatalog(options)))
      .rejects.toBeInstanceOf(SchemaCapabilityUnavailableError);
  });

  it("treats an installed unavailable snapshot as authoritative over a successful fallback", async () => {
    const snapshot = await applySchemaMigrationManifest(
      makeCatalog({ failSql: labManifest[0].sql, table: false }),
      labManifest,
    );
    installSchemaReadinessSnapshot(snapshot);
    const fallback = makeCatalog();

    await expect(requireSchemaCapabilityReady("lab_scanner", fallback))
      .rejects.toBeInstanceOf(SchemaCapabilityUnavailableError);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("rejects absent executors, unknown capabilities and incomplete manifests", async () => {
    await expect(requireSchemaCapabilityReady("lab_scanner"))
      .rejects.toBeInstanceOf(SchemaCapabilityUnavailableError);
    await expect(requireSchemaCapabilityReady("not_real" as never, makeCatalog()))
      .rejects.toBeInstanceOf(SchemaCapabilityUnavailableError);
    expect(() => registerSchemaMigrationManifest([])).toThrow("manifest is empty");
  });

  it("constructs and persists every finite failure class without denylist collision", async () => {
    const denylist = [
      /ws error:\s*null/i,
      /DriftClient has no user/i,
      /drift.*(subscription|subscribe|decode|account update)/i,
      /failover|switching rpc|rpc switch/i,
      /\b429\b|rate.?limit/i,
      /Connection terminated|connection timeout|too many clients|ECONNREFUSED/i,
    ];
    const manifest: readonly SchemaMigrationDefinition[] = SCHEMA_FAILURE_CLASSES.map((failureClass, index) => ({
      id: `failure-${failureClass}`,
      sql: failureClass === "ddl_failed" ? "DDL_FAIL"
        : failureClass === "backfill_failed" ? "BACKFILL_FAIL"
        : `NOOP_${index}`,
      capabilities: ["lab_scanner"],
      operation: failureClass === "backfill_failed" ? "backfill" : "ddl",
      requirements: failureClass === "index_missing" ? [{
        kind: "index",
        table: "lab_candle_cache_v2",
        index: "missing_index",
        columns: ["symbol"],
        unique: false,
      }] : failureClass === "postcondition_missing" ? [{
        kind: "column",
        table: "lab_candle_cache_v2",
        column: "missing_column",
      }] : [{
        kind: "data",
        identity: `execution-${failureClass}`,
        checkSql: `CHECK_${failureClass}`,
      }],
    }));
    const query: CatalogQuery = async (text) => {
      if (text === "DDL_FAIL" || text === "BACKFILL_FAIL") throw new Error("connection timeout raw secret-ish detail");
      if (text === "CHECK_verification_failed") throw new Error("catalog timeout raw detail");
      if (text === "CHECK_ddl_failed" || text === "CHECK_backfill_failed") return { rows: [{ ok: false }] };
      if (text.includes("information_schema.columns") || text.includes("FROM pg_index")) return { rows: [] };
      return { rows: [] };
    };
    const snapshot = await applySchemaMigrationManifest(query, manifest);
    expect(new Set(snapshot.evidence.map((item) => item.failureClass)))
      .toEqual(new Set(SCHEMA_FAILURE_CLASSES));

    for (const failureClass of SCHEMA_FAILURE_CLASSES) {
      const alert = createSchemaReadinessAlert({
        capability: "lab_scanner",
        failureClass,
        objectIdentity: "bounded-object",
      });
      expect(denylist.some((pattern) => pattern.test(`${alert.message}\n${alert.detail}`))).toBe(false);
      expect(alert.fingerprint).toBe(`schema-readiness:lab_scanner:${failureClass}`);
    }

    await reportSchemaReadiness(snapshot);
    const { flushErrorLog } = await import("../../server/error-log");
    await flushErrorLog();
    expect(recordErrorMock).toHaveBeenCalledTimes(SCHEMA_FAILURE_CLASSES.length);
    expect(new Set(recordErrorMock.mock.calls.map(([input]) => input.fingerprint)))
      .toEqual(new Set(SCHEMA_FAILURE_CLASSES.map((failureClass) =>
        `schema-readiness:lab_scanner:${failureClass}`,
      )));
  });
});
