import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  SCHEMA_CAPABILITIES,
  SCHEMA_FAILURE_CLASSES,
  SchemaCapabilityUnavailableError,
  applySchemaMigrationManifest,
  createSchemaReadinessAlert,
  installSchemaReadinessSnapshot,
  registerSchemaMigrationManifest,
  reportSchemaReadiness,
  requireSchemaCapabilityReady,
  resetSchemaReadinessForTests,
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

  it("attempts every statement and postcondition while localizing a DDL failure", async () => {
    const query = makeCatalog({ failSql: labManifest[0].sql });
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
  });

  it("retains all 179 SQL entries exactly once, in order, with explicit metadata", () => {
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
    expect(createHash("sha256").update(sqlEntries.join("\u0000"), "utf8").digest("hex").toUpperCase())
      .toBe("F6CBE65BEA409C8E0AD935A37CCC49A7112BF361A4138626D819EC5D8B738FDE");

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
      makeCatalog({ failSql: labManifest[0].sql }),
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
        identity: `satisfied-${failureClass}`,
        checkSql: `CHECK_${failureClass}`,
      }],
    }));
    const query: CatalogQuery = async (text) => {
      if (text === "DDL_FAIL" || text === "BACKFILL_FAIL") throw new Error("connection timeout raw secret-ish detail");
      if (text.startsWith("CHECK_")) return { rows: [{ ok: true }] };
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
    expect(recordErrorMock).toHaveBeenCalledTimes(4);
    expect(new Set(recordErrorMock.mock.calls.map(([input]) => input.fingerprint)))
      .toEqual(new Set(SCHEMA_FAILURE_CLASSES.map((failureClass) =>
        `schema-readiness:lab_scanner:${failureClass}`,
      )));
  });
});
