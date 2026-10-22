import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import { readDbSchemaMigrationManifest } from "../helpers/schema-migration-manifest";
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

const recordErrorMock = vi.hoisted(() => vi.fn(async (_input: { fingerprint: string }) => undefined));
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

// PostgreSQL catalog output includes casts, ANY ARRAY forms, and canonical intervals.
const plannerWeeklyCatalog: Record<string, { columns: string[]; constraints: Record<string, string> }> = {
  planner_btc_weekly_closes: {
    columns: ["market", "week_start", "close", "source", "basis", "aggregation", "finalized", "fetched_at"],
    constraints: {
      planner_btc_weekly_identity_unique: "UNIQUE (market, week_start)",
      planner_btc_weekly_market_check: "CHECK (market = 'BTC'::text)",
      planner_btc_weekly_utc_check: "CHECK (week_start >= '1970-01-05 00:00:00+00'::timestamp with time zone AND EXTRACT(isodow FROM (week_start AT TIME ZONE 'UTC'::text)) = 1::numeric AND (week_start AT TIME ZONE 'UTC'::text)::time without time zone = '00:00:00'::time without time zone)",
      planner_btc_weekly_close_check: "CHECK (CASE WHEN close ~ '^[0-9]{1,12}(\\.[0-9]{1,18})?$'::text THEN close::numeric > 0::numeric ELSE false END)",
      planner_btc_weekly_source_check: "CHECK (source = 'okx-index'::text AND basis = 'index'::text OR (source = ANY (ARRAY['gate-spot'::text, 'kraken-spot'::text, 'coinbase-spot'::text])) AND basis = 'spot'::text OR (source = ANY (ARRAY['pacifica-mark'::text, 'hyperliquid-perp'::text, 'pacifica-perp'::text, 'okx-perp'::text])) AND basis = 'perp'::text)",
      planner_btc_weekly_aggregation_check: "CHECK (aggregation = ANY (ARRAY['native'::text, 'daily'::text]))",
      planner_btc_weekly_finalized_check: "CHECK (finalized AND fetched_at >= (week_start + '168:00:00'::interval))",
    },
  },
  planner_btc_weekly_refresh: {
    columns: ["market", "last_attempt_at"],
    constraints: {
      planner_btc_weekly_refresh_pkey: "PRIMARY KEY (market)",
      planner_btc_weekly_refresh_market_check: "CHECK (market = 'BTC'::text)",
    },
  },
};

function plannerWeeklyCatalogQuery(closeDefinition?: string): CatalogQuery {
  return async (text, values) => {
    const table = String(values?.[0] ?? "").replace(/^public\./, "");
    const catalog = plannerWeeklyCatalog[table];
    if (!catalog) throw new Error(`unexpected weekly catalog table: ${table}`);
    if (text.includes("to_regclass")) return { rows: [{ relation: table }] };
    if (text.includes("information_schema.columns")) {
      return { rows: catalog.columns.map(column_name => ({ column_name })) };
    }
    if (text.includes("pg_get_constraintdef")) {
      const constraints = { ...catalog.constraints };
      if (table === "planner_btc_weekly_closes" && closeDefinition !== undefined) {
        constraints.planner_btc_weekly_close_check = closeDefinition;
      }
      const definitions = text.includes("c.conname=$2")
        ? [constraints[String(values?.[1])]].filter(definition => definition !== undefined)
        : Object.values(constraints);
      return { rows: definitions.map(definition => ({ definition })) };
    }
    throw new Error(`unexpected weekly catalog SQL: ${text}`);
  };
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

  it("retains the 203-entry SQL prefix and appends migrations 203 and 204 exactly once", () => {
    const { sqlEntries, metadata } = readDbSchemaMigrationManifest();
    expect(sqlEntries).toHaveLength(205);
    expect(metadata).toHaveLength(205);
    expect(new Set(metadata.map((entry) => entry.id)).size).toBe(205);
    expect(metadata.every((entry) => entry.capabilities.length > 0 && entry.requirements.length > 0)).toBe(true);
    // SHA-256 of every SQL entry on the rebase baseline, including later migrations.
    const preservedSqlPrefixDigest = createHash("sha256").update(JSON.stringify(sqlEntries.slice(0, 203))).digest("hex").toUpperCase();
    expect(preservedSqlPrefixDigest).toBe("7938D85BB5BB58640C19D18A5889677D508920D509A8D6F31FDCF11D9F8941B9");
    // Epoch migration preserves historical SQL; readiness metadata now describes epoch-scoped uniqueness and regrid controls.
    const preservedManifestDigest = createHash("sha256").update(JSON.stringify(
      metadata.slice(0, 197).map((entry, index) => ({ ...entry, sql: sqlEntries[index] })),
    )).digest("hex").toUpperCase();
    expect(preservedManifestDigest).toBe("7906B690FF7C3DD84BAF7A0FE4674EE85ED72A4243FF30B73A47668A13617F9D");
    const epochPrefixDigest = createHash("sha256").update(JSON.stringify(
      metadata.slice(0, 202).map((entry, index) => ({ ...entry, sql: sqlEntries[index] })),
    )).digest("hex").toUpperCase();
    expect(epochPrefixDigest).toBe("A2235A688E2503041A48CAA3A367104DA148511FD6FF674D76B76CDE72477DC3");
    expect(metadata[202].id).toBe('202-grid-epoch-publish-safe');
    expect(sqlEntries[202].trim()).toBe(readFileSync('migrations/0013_grid_epoch_publish_safe.sql','utf8').trim());
    expect(metadata[191]).toMatchObject({ id: '191-phoenix-ai-trader', capabilities: ['phoenix'], operation: 'ddl' });
    expect(sqlEntries[191]).toContain('phoenix_ai_executions');
    const gridMigrations = [
      ['192-grid-bot-drafts', '0004_grid_bot_drafts.sql'],
      ['193-grid-launch-ledger', '0005_grid_launch.sql'],
      ['194-grid-monitor-ledger', '0006_grid_monitor.sql'],
      ['195-grid-lifecycle-controls', '0007_grid_lifecycle.sql'],
      ['196-planner-btc-weekly', '0008_planner_btc_weekly.sql'],
      ['197-planner-btc-weekly-close-check', '0009_planner_btc_weekly_close_check.sql'],
    ];
    for (const [offset, [id, file]] of gridMigrations.entries()) {
      expect(metadata[192 + offset]).toMatchObject({ id, capabilities: ['grid_bot'], operation: 'ddl' });
      const fileSql = readFileSync(new URL(`../../migrations/${file}`, import.meta.url), 'utf8');
      expect(sqlEntries[192 + offset].trim()).toBe(fileSql.replaceAll('\r\n', '\n').trim());
    }
    const epochSql=readFileSync(new URL('../../migrations/0012_grid_range_epochs.sql',import.meta.url),'utf8').replaceAll('\r\n','\n').trim();
    expect(metadata[201]).toMatchObject({id:'201-grid-range-epochs',capabilities:['grid_bot'],operation:'ddl'});
    expect(sqlEntries[201].trim()).toBe(epochSql);
    expect(epochSql).not.toMatch(/\bCASE\b/i);
    for(const line of epochSql.split('\n').filter(line=>line.includes('CHECK')))expect(line).toMatch(/CHECK \(.*\)[,;]?$/);
    expect(metadata[200]).toMatchObject({id:'200-grid-auto-resume',capabilities:['grid_bot'],operation:'ddl'});
    const autoSql=readFileSync(new URL('../../migrations/0011_grid_auto_resume.sql',import.meta.url),'utf8').replaceAll('\r\n','\n').trim();
    expect(sqlEntries[200].trim()).toBe(autoSql);
    expect(autoSql).toContain('enabled boolean NOT NULL DEFAULT true');
    expect(autoSql).toContain('ALTER TABLE grid_auto_resume ALTER COLUMN enabled SET DEFAULT true');
    expect(metadata[200].requirements).toContainEqual({kind:'data',identity:'grid_auto_resume.enabled.default',checkSql:"SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='grid_auto_resume' AND column_name='enabled' AND column_default='true' AND is_nullable='NO') AS ok"});
    expect(autoSql).not.toMatch(/CASE/i);
    expect(autoSql.split('\n').filter(line=>line.includes('CHECK'))).toHaveLength(5);
    for(const line of autoSql.split('\n').filter(line=>line.includes('CHECK')))expect(line).toMatch(/CHECK \(.*\)[,;]?$/);
    expect(metadata[200].requirements.filter(r=>r.kind==='constraint')).toHaveLength(8);
    expect(metadata[198]).toMatchObject({ id: '198-lab-signal-provenance', capabilities: ['signal_bot', 'lab', 'phoenix'], operation: 'ddl' });
    expect(sqlEntries[198].trim()).toBe(readFileSync(new URL('../../migrations/0010_lab_signal_provenance.sql', import.meta.url), 'utf8').replaceAll('\r\n', '\n').trim());
    expect(sqlEntries[198]).toContain("CHECK (lab_link_state IN ('linked','owner_confirmed','unlinked'))");
    expect(sqlEntries[198]).not.toMatch(/UPDATE\s+trading_bots|CASE/i);
    // Entries 028 and 076 preserve later superset constraints on every boot.
    // Pin the other pre-existing SQL bytes, including entry 185.
    const preExistingUnchanged = sqlEntries.slice(0, 186).filter((_, index) => index !== 28 && index !== 76);
    const sqlDigest = createHash("sha256").update(preExistingUnchanged.join("\u0000"), "utf8").digest("hex").toUpperCase();
    expect(sqlDigest).toBe("6F74C8CBC20E676AE95DD17408CB93EFF468FF5479519FDEFE0CEFEF4702AD3D");
    const normalizedMigration028 = sqlEntries[28].split("\n").map((line) => line.trim()).join("\n");
    expect(normalizedMigration028).toBe([
      "DO $$",
      "DECLARE",
      "current_definition text;",
      "BEGIN",
      "SELECT pg_get_constraintdef(oid, true)",
      "INTO current_definition",
      "FROM pg_constraint",
      "WHERE conrelid = 'referral_reward_events'::regclass",
      "AND conname = 'referral_reward_events_status_valid';",
      "IF current_definition IS NULL OR position('awaiting_creator' in current_definition) = 0 THEN",
      "ALTER TABLE referral_reward_events",
      "DROP CONSTRAINT IF EXISTS referral_reward_events_status_valid;",
      "ALTER TABLE referral_reward_events",
      "ADD CONSTRAINT referral_reward_events_status_valid",
      "CHECK (status IN ('pending','confirmed','paid','failed','processing','voided'));",
      "END IF;",
      "END $$;",
    ].join("\n"));
    expect(metadata[28]).toEqual({
      id: "028-do--begin-if",
      capabilities: ["referrals"],
      requirements: [{
        kind: "constraint",
        table: "referral_reward_events",
        constraint: "referral_reward_events_status_valid",
        definitionIncludes: ["CHECK (status IN ('pending','confirmed','paid','failed','processing','voided'))"],
      }],
      operation: "ddl",
    });
    expect(sqlEntries[76]).toContain("position('phoenix' in pg_get_constraintdef(oid)) > 0");
    expect(sqlEntries[76]).toContain("CHECK (active_protocol IN ('pacifica', 'drift', 'flash'))");
    expect(metadata[76].requirements[0]).toMatchObject({ definitionIncludes: ["'pacifica'", "'drift'", "'flash'"] });
    expect(metadata[22].requirements[0]).toMatchObject({ definitionIncludes: ["'pacifica'", "'drift'"] });
    expect(metadata[186].requirements[0]).toMatchObject({ kind: 'constraint',
      constraint: 'trading_bots_active_protocol_check', definitionIncludes: ["'phoenix'"] });

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

    const avaxCorrectionSql = sqlEntries[176];
    expect(metadata[176]).toMatchObject({
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

    const venueTruthSql = sqlEntries[177];
    expect(metadata[177]).toMatchObject({
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
    const qualificationRecordSql = sqlEntries[178];
    expect(metadata[178]).toMatchObject({
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

    const conventionSql = sqlEntries[179];
    expect(metadata[179]).toMatchObject({
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

    const scannerClaimTableSql = sqlEntries[180];
    expect(metadata[180]).toEqual({
      id: "180-create-ai-trader-scanner-candidate-claims",
      capabilities: ["ai_trader"],
      requirements: [{
        kind: "table",
        table: "ai_trader_scanner_candidate_claims",
        columns: [
          "id", "wallet_address", "boundary_start", "market", "bot_id",
          "protocol", "candidate_timeframe", "expires_at", "created_at",
        ],
        constraintDefinitions: ["PRIMARY KEY (id)"],
      }],
      operation: "ddl",
    });
    expect(scannerClaimTableSql).toContain("CREATE TABLE IF NOT EXISTS ai_trader_scanner_candidate_claims");
    expect(scannerClaimTableSql).toContain("boundary_start timestamptz NOT NULL");
    expect(scannerClaimTableSql).toContain("expires_at timestamptz NOT NULL");

    const scannerClaimIndexSql = sqlEntries[181];
    expect(metadata[181]).toEqual({
      id: "181-create-ai-trader-scanner-candidate-claim-indexes",
      capabilities: ["ai_trader"],
      requirements: [
        {
          kind: "index",
          table: "ai_trader_scanner_candidate_claims",
          index: "ai_trader_scanner_claims_wallet_boundary_market_unique",
          columns: ["wallet_address", "boundary_start", "market"],
          unique: true,
        },
        {
          kind: "index",
          table: "ai_trader_scanner_candidate_claims",
          index: "ai_trader_scanner_candidate_claims_expires_at_idx",
          columns: ["expires_at"],
          unique: false,
        },
      ],
      operation: "ddl",
    });
    expect(scannerClaimIndexSql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS ai_trader_scanner_claims_wallet_boundary_market_unique");
    expect(scannerClaimIndexSql).toContain("CREATE INDEX IF NOT EXISTS ai_trader_scanner_candidate_claims_expires_at_idx");

    const hyperliquidConstraintSql = sqlEntries[182];
    expect(metadata[182]).toEqual({
      id: "182-extend-lab-candle-cache-hyperliquid-provenance",
      capabilities: ["lab_scanner"],
      requirements: [
        {
          kind: "constraint",
          table: "lab_candle_cache_v2",
          constraint: "lab_candle_cache_v2_source_check",
          definitionIncludes: [
            "source IN ('okx', 'gate', 'pyth', 'hyperliquid', 'unknown')",
          ],
        },
        {
          kind: "constraint",
          table: "lab_candle_cache_v2",
          constraint: "lab_candle_cache_v2_venue_check",
          definitionIncludes: [
            "venue IN ('okx', 'gate', 'hyperliquid', 'none', 'unknown')",
          ],
        },
      ],
      operation: "ddl",
    });
    expect(hyperliquidConstraintSql).toContain("DROP CONSTRAINT IF EXISTS lab_candle_cache_v2_source_check");
    expect(hyperliquidConstraintSql).toContain("DROP CONSTRAINT IF EXISTS lab_candle_cache_v2_venue_check");
    expect(hyperliquidConstraintSql).toContain("'hyperliquid'");
    expect(sqlEntries[183]).toBe("ALTER TABLE ai_trader_decisions ADD COLUMN IF NOT EXISTS price_excursion jsonb");
    expect(metadata[183]).toEqual({
      id: "183-add-ai-trader-price-excursion-observation",
      capabilities: ["ai_trader"],
      requirements: [
        { kind: "column", table: "ai_trader_decisions", column: "price_excursion" },
        {
          kind: "data", identity: "ai-trader-price-excursion-nullable-jsonb",
          checkSql: "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_trader_decisions' AND column_name = 'price_excursion' AND data_type = 'jsonb' AND is_nullable = 'YES') AS ok",
        },
      ],
      operation: "ddl",
    });
    const liveBreakevenJournalSql = sqlEntries[184];
    expect(metadata[184]).toMatchObject({
      id: "184-add-live-breakeven-protective-journal-claim",
      capabilities: ["ai_trader"],
      operation: "ddl",
    });
    expect(metadata[184].requirements).toHaveLength(9);
    expect(metadata[184].requirements).toContainEqual({
      kind: "data",
      identity: "ai-trader-live-breakeven-claim-column-shape",
      checkSql: expect.stringContaining("('attempt_ordinal','smallint')"),
    });
    expect(metadata[184].requirements).toContainEqual({
      kind: "constraint",
      table: "ai_trader_execution_events",
      constraint: "ai_trader_execution_events_cause_check",
      definitionIncludes: [
        "cause IN ('decision', 'paper', 'emergency_unwind', 'protective', 'user_requested', 'venue_detected', 'unconfirmed_orphan', 'startup_orphan', 'pre_close_bracket', 'survivor_leg')",
      ],
    });
    expect(liveBreakevenJournalSql).toContain("ADD COLUMN IF NOT EXISTS authority_fingerprint text");
    expect(liveBreakevenJournalSql).toContain("DO $qv$");
    expect(liveBreakevenJournalSql).toContain("SELECT pg_get_constraintdef(oid, true)");
    expect(liveBreakevenJournalSql).toContain("action_definition IS DISTINCT FROM $constraint$");
    expect(liveBreakevenJournalSql).toContain("phase_definition IS DISTINCT FROM $constraint$");
    expect(liveBreakevenJournalSql).toContain("cause_definition IS DISTINCT FROM $constraint$");
    expect(liveBreakevenJournalSql).toContain("protective_claim_definition IS DISTINCT FROM $constraint$");
    expect(liveBreakevenJournalSql).toContain("DROP CONSTRAINT IF EXISTS ai_trader_execution_events_action_check");
    expect(liveBreakevenJournalSql).toContain("DROP CONSTRAINT ai_trader_execution_action_check");
    expect(liveBreakevenJournalSql).toContain("CHECK (action IN ('entry','close','cancel','protective'))");
    expect(liveBreakevenJournalSql).toContain("DROP CONSTRAINT IF EXISTS ai_trader_execution_phase_check");
    expect(liveBreakevenJournalSql).toContain("ADD CONSTRAINT ai_trader_execution_phase_check CHECK");
    expect(liveBreakevenJournalSql).toContain("event_type = 'attempt_claimed' AND phase = 0");
    expect(liveBreakevenJournalSql).toContain("DROP CONSTRAINT IF EXISTS ai_trader_execution_events_cause_check");
    expect(liveBreakevenJournalSql).toContain("DROP CONSTRAINT ai_trader_execution_cause_check");
    expect(liveBreakevenJournalSql).toContain("CHECK (cause IN ('decision','paper','emergency_unwind','protective'");
    expect(liveBreakevenJournalSql).toContain("event_type = 'attempt_claimed' AND phase = 0 AND decision_id IS NOT NULL");
    expect(liveBreakevenJournalSql).toContain("attempt_ordinal BETWEEN 1 AND 5");
    expect(liveBreakevenJournalSql).toContain("action <> 'protective'");
    expect(liveBreakevenJournalSql).toContain("AND authority_fingerprint IS NULL AND position_fingerprint IS NULL");

    const signedSubmitSql = sqlEntries[185];
    expect(metadata[185]).toMatchObject({
      id: "185-add-solana-signed-submit-durability",
      capabilities: ["referrals"],
      operation: "ddl",
    });
    expect(signedSubmitSql).toContain("CREATE TABLE IF NOT EXISTS solana_signed_submit_attempts");
    expect(signedSubmitSql).toContain("UNIQUE (operation_type, operation_id, deterministic_signature)");
    expect(signedSubmitSql).toContain("WHERE status = 'confirmation_pending'");
    expect(signedSubmitSql).toContain("'awaiting_creator'");
    expect(signedSubmitSql).toContain("ADD COLUMN IF NOT EXISTS processing_claimed_from_status text");
    expect(signedSubmitSql).toContain("referral_reward_events_processing_claimed_from_status_valid");
    expect(metadata[185].requirements).toContainEqual({
      kind: "column",
      table: "referral_reward_events",
      column: "processing_claimed_from_status",
    });
    expect(metadata[185].requirements).toContainEqual({
      kind: "constraint",
      table: "referral_reward_events",
      constraint: "referral_reward_events_processing_claimed_from_status_valid",
      definitionIncludes: ["processing_claimed_from_status IS NULL", "processing_claimed_from_status IN ('pending', 'failed')"],
    });
    expect(metadata[185].requirements).toContainEqual({
      kind: "index",
      table: "solana_signed_submit_attempts",
      index: "solana_signed_submit_attempts_active_unique",
      columns: ["operation_type", "operation_id"],
      unique: true,
      predicateIncludes: ["status = 'confirmation_pending'"],
    });
    expect(metadata[185].requirements).toContainEqual({
      kind: "constraint", table: "solana_signed_submit_attempts",
      constraint: "solana_signed_submit_attempts_provider_valid",
    });
    expect(metadata[203]).toMatchObject({ id: "203-enable-signed-submit-backup-provider", capabilities: ["referrals"] });
    expect(metadata[203].requirements).toContainEqual({
      kind: "constraint", table: "solana_signed_submit_attempts",
      constraint: "solana_signed_submit_attempts_provider_valid",
    });
    expect(metadata[203].requirements).toContainEqual({
      kind: "data", identity: "solana-signed-submit-exact-provider-domain",
      checkSql: `SELECT EXISTS (
  SELECT 1
  FROM pg_constraint AS c
  JOIN pg_class AS t ON t.oid = c.conrelid
  JOIN pg_namespace AS n ON n.oid = t.relnamespace
  WHERE n.nspname = current_schema()
    AND t.relname = 'solana_signed_submit_attempts'
    AND c.conname = 'solana_signed_submit_attempts_provider_valid'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) = 'CHECK ((rpc_provider = ANY (ARRAY[''configured_primary''::text, ''configured_backup''::text])))'
) AS ok;`,
    });
    expect(sqlEntries[203]).toContain("CHECK (rpc_provider IN ('configured_primary', 'configured_backup'))");
  });

  it('keeps runtime epoch foreign keys out of publish metadata while retaining epoch columns and index identity',()=>{
    const schema=readFileSync('shared/schema.ts','utf8'),migration=readFileSync('migrations/0012_grid_range_epochs.sql','utf8');
    expect(schema).not.toContain('gridEpochReferences');
    for(const name of ['grid_bots_active_epoch_fk','grid_levels_epoch_fk','grid_operations_epoch_fk']){
      expect(schema).not.toContain(name);expect(migration).toContain('ADD CONSTRAINT '+name);
    }
    expect(schema).toContain('activeEpochId: uuid("active_epoch_id")');
    expect(schema).toContain('epochId: uuid("epoch_id")');
    expect(schema).toContain('uniqueIndex("grid_levels_bot_ordinal_unique").on(t.botId, t.epochId, t.ordinal)');
    expect(migration).toContain('CREATE UNIQUE INDEX grid_levels_bot_ordinal_unique ON grid_levels(bot_id,epoch_id,ordinal)');
  });

  it("re-runs migration 028 with an awaiting_creator row and preserves the forward seven-state constraint", async () => {
    const { manifest } = readDbSchemaMigrationManifest();
    let constraintDefinition = "CHECK (status IN ('pending','confirmed','paid','failed','processing','voided','awaiting_creator'))";
    let awaitingCreatorRowPresent = true;
    const query: CatalogQuery = async (text, values) => {
      if (text === manifest[28].sql) {
        expect(text).toContain("position('awaiting_creator' in current_definition) = 0");
        if (!text.includes("position('awaiting_creator' in current_definition) = 0")) {
          awaitingCreatorRowPresent = false;
          throw new Error("legacy constraint replacement rejected awaiting_creator fixture");
        }
        return { rows: [] };
      }
      if (text === manifest[185].sql) {
        constraintDefinition = "CHECK (status IN ('pending','confirmed','paid','failed','processing','voided','awaiting_creator'))";
        return { rows: [] };
      }
      if (text.includes("information_schema.columns") && text.includes("column_name=$2")) return { rows: [{ present: 1 }] };
      if (text.includes("information_schema.columns")) return { rows: [
        "id", "operation_type", "operation_id", "deterministic_signature", "blockhash",
        "last_valid_block_height", "rpc_provider", "status", "last_error", "created_at", "updated_at",
      ].map((column_name) => ({ column_name })) };
      if (text.includes("to_regclass")) return { rows: [{ relation: "solana_signed_submit_attempts" }] };
      if (text.includes("c.conname=$2")) {
        const name = String(values?.[1] ?? "");
        if (name === "referral_reward_events_status_valid") return { rows: [{ definition: constraintDefinition }] };
        if (name === "pending_profit_shares_processing_claimed_from_status_valid") {
          return { rows: [{ definition: "CHECK (processing_claimed_from_status IS NULL OR processing_claimed_from_status IN ('pending','deferred'))" }] };
        }
        if (name === "referral_reward_events_processing_claimed_from_status_valid") {
          return { rows: [{ definition: "CHECK (processing_claimed_from_status IS NULL OR processing_claimed_from_status IN ('pending','failed'))" }] };
        }
        if (name === "solana_signed_submit_attempts_provider_valid") {
          return { rows: [{ definition: "CHECK (rpc_provider = 'configured_primary')" }] };
        }
        return { rows: [] };
      }
      if (text.includes("pg_get_constraintdef") && !text.includes("c.conname=$2")) {
        return { rows: [
          { definition: "PRIMARY KEY (id)" },
          { definition: "CHECK (operation_type IN ('profit_share_creator','referral_reward'))" },
          { definition: "CHECK (rpc_provider = 'configured_primary')" },
          { definition: "CHECK (status IN ('confirmation_pending','confirmed_success','confirmed_failure','expired_without_status'))" },
          { definition: "UNIQUE (operation_type, operation_id, deterministic_signature)" },
        ] };
      }
      if (text.includes("FROM pg_index")) return { rows: [{
        table_name: "solana_signed_submit_attempts", is_unique: true,
        predicate: "status = 'confirmation_pending'", columns: ["operation_type", "operation_id"],
      }] };
      throw new Error(`unexpected signed-submit manifest fixture SQL: ${text}`);
    };

    const result = await applySchemaMigrationManifest(query, [manifest[28], manifest[185]]);
    expect(awaitingCreatorRowPresent).toBe(true);
    expect(result.unavailableCapabilities).toEqual([]);
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

  it("matches all migration 196 postconditions against PostgreSQL catalog renderings", async () => {
    const { manifest } = readDbSchemaMigrationManifest();
    const migration = manifest.find(entry => entry.id === "196-planner-btc-weekly")!;
    expect(migration.requirements).toHaveLength(9); // Two table identities plus seven named CHECKs; no index requirements.
    const snapshot = await probeSchemaMigrationManifest(plannerWeeklyCatalogQuery(), [migration]);
    expect(snapshot.unavailableCapabilities).toEqual([]);
    expect(snapshot.evidence).toEqual([]);

    // The original tokens cannot match, even though PostgreSQL emits ::numeric twice.
    const closeRequirement = migration.requirements.find(requirement =>
      requirement.kind === "constraint" && requirement.constraint === "planner_btc_weekly_close_check",
    );
    if (!closeRequirement || closeRequirement.kind !== "constraint") throw new Error("close postcondition missing");
    const original = await probeSchemaMigrationManifest(plannerWeeklyCatalogQuery(), [{
      ...migration, requirements: [{ ...closeRequirement, definitionIncludes: ["numeric", "0"] }],
    }]);
    expect(original.evidence).toEqual([{
      capability: "grid_bot", failureClass: "postcondition_missing",
      objectIdentity: "constraint:planner_btc_weekly_closes.planner_btc_weekly_close_check",
    }]);
  });

  it("matches migration 197's cast-stripped catalog rendering and supersedes only the 196 close postcondition", async () => {
    const migrations = readDbSchemaMigrationManifest().manifest.slice(196, 198);
    const definition = "CHECK (close ~ '^[0-9]{1,12}(\\.[0-9]{1,18})?$'::text AND close !~ '^0{1,12}(\\.0{1,18})?$'::text)";
    const snapshot = await probeSchemaMigrationManifest(plannerWeeklyCatalogQuery(definition), migrations);
    expect(snapshot.unavailableCapabilities).toEqual([]);
    expect(snapshot.evidence).toEqual([]);
    const obsolete = await probeSchemaMigrationManifest(plannerWeeklyCatalogQuery(), migrations);
    expect(obsolete.evidence).toEqual([{
      capability: "grid_bot", failureClass: "postcondition_missing",
      objectIdentity: "constraint:planner_btc_weekly_closes.planner_btc_weekly_close_check",
    }]);
  });

  it.each([
    ["decimal grammar", "CHECK (close !~ '^0{1,12}(\\.0{1,18})?$'::text)"],
    ["zero rejection", "CHECK (close ~ '^[0-9]{1,12}(\\.[0-9]{1,18})?$'::text)"],
    ["conjunction", "CHECK (close ~ '^[0-9]{1,12}(\\.[0-9]{1,18})?$'::text OR close !~ '^0{1,12}(\\.0{1,18})?$'::text)"],
  ])("rejects migration 197 when the close CHECK loses %s", async (_missing, definition) => {
    const migrations = readDbSchemaMigrationManifest().manifest.slice(196, 198);
    const snapshot = await probeSchemaMigrationManifest(plannerWeeklyCatalogQuery(definition), migrations);
    expect(snapshot.unavailableCapabilities).toEqual(["grid_bot"]);
    expect(snapshot.evidence).toEqual([{
      capability: "grid_bot", failureClass: "postcondition_missing",
      objectIdentity: "constraint:planner_btc_weekly_closes.planner_btc_weekly_close_check",
    }]);
  });

  it.each([
    ["decimal grammar", "CHECK (CASE WHEN true THEN close::numeric > 0::numeric ELSE false END)"],
    ["positive close", "CHECK (CASE WHEN close ~ '^[0-9]{1,12}(\\.[0-9]{1,18})?$'::text THEN true ELSE false END)"],
    ["invalid-close rejection", "CHECK (CASE WHEN close ~ '^[0-9]{1,12}(\\.[0-9]{1,18})?$'::text THEN close::numeric > 0::numeric ELSE true END)"],
  ])("rejects migration 196 when the close CHECK loses %s", async (_missing, definition) => {
    const migration = readDbSchemaMigrationManifest().manifest.find(entry => entry.id === "196-planner-btc-weekly")!;
    const snapshot = await probeSchemaMigrationManifest(plannerWeeklyCatalogQuery(definition), [migration]);
    expect(snapshot.unavailableCapabilities).toEqual(["grid_bot"]);
    expect(snapshot.evidence).toEqual([{
      capability: "grid_bot", failureClass: "postcondition_missing",
      objectIdentity: "constraint:planner_btc_weekly_closes.planner_btc_weekly_close_check",
    }]);
  });

  it("matches the complete migration 184 cause vocabulary against PostgreSQL ANY ARRAY rendering", async () => {
    const { manifest, sqlEntries } = readDbSchemaMigrationManifest();
    const migration184 = manifest[184];
    expect(migration184.id).toBe("184-add-live-breakeven-protective-journal-claim");
    const sql = sqlEntries[184];
    const canonicalDefinition = (variable: string): string => {
      const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = sql.match(new RegExp(`${escaped} IS DISTINCT FROM \\$constraint\\$(CHECK \\([\\s\\S]*?\\))\\$constraint\\$ THEN`));
      if (!match) throw new Error(`canonical definition missing for ${variable}`);
      return match[1];
    };
    const definitions: Record<string, string> = {
      ai_trader_execution_events_action_check: canonicalDefinition("action_definition"),
      ai_trader_execution_phase_check: canonicalDefinition("phase_definition"),
      ai_trader_execution_events_cause_check: canonicalDefinition("cause_definition"),
      ai_trader_execution_protective_claim_check: canonicalDefinition("protective_claim_definition"),
    };
    const narrowerCause = definitions.ai_trader_execution_events_cause_check
      .replace(", 'survivor_leg'::text", "");
    const catalog = (causeDefinition: string | null): CatalogQuery => async (text, values) => {
      if (text.includes("information_schema.columns") && values?.length === 2) {
        return { rows: [{ present: 1 }] };
      }
      if (text === migration184.requirements.find((entry) => entry.kind === "data")?.checkSql) {
        return { rows: [{ ok: true }] };
      }
      if (text.includes("c.conname=$2")) {
        const constraint = String(values?.[1] ?? "");
        if (constraint === "ai_trader_execution_events_cause_check" && causeDefinition === null) {
          return { rows: [] };
        }
        const definition = constraint === "ai_trader_execution_events_cause_check"
          ? causeDefinition
          : definitions[constraint];
        return { rows: definition ? [{ definition }] : [] };
      }
      throw new Error(`unexpected migration 184 catalog SQL: ${text}`);
    };

    const ready = await probeSchemaMigrationManifest(catalog(definitions.ai_trader_execution_events_cause_check), [migration184]);
    const narrower = await probeSchemaMigrationManifest(catalog(narrowerCause), [migration184]);
    const absent = await probeSchemaMigrationManifest(catalog(null), [migration184]);
    const expectedFailure = {
      capability: "ai_trader" as const,
      failureClass: "postcondition_missing" as const,
      objectIdentity: "constraint:ai_trader_execution_events.ai_trader_execution_events_cause_check",
    };

    expect(ready.unavailableCapabilities).toEqual([]);
    expect(ready.evidence).toEqual([]);
    expect(narrower.unavailableCapabilities).toEqual(["ai_trader"]);
    expect(narrower.evidence).toEqual([expectedFailure]);
    expect(absent.unavailableCapabilities).toEqual(["ai_trader"]);
    expect(absent.evidence).toEqual([expectedFailure]);
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

  it("refuses an absent, primary-only, or broader signed-submit provider constraint", async () => {
    const { manifest } = readDbSchemaMigrationManifest();
    const migration = manifest[203];
    const exactDefinition = "CHECK ((rpc_provider = ANY (ARRAY['configured_primary'::text, 'configured_backup'::text])))";
    const probe = (definition: string | null) => probeSchemaMigrationManifest(
      async (sql) => sql.includes("AS ok")
        ? { rows: [{ ok: definition === exactDefinition }] }
        : { rows: definition === null ? [] : [{ definition }] },
      [migration],
    );
    expect((await probe(exactDefinition)).unavailableCapabilities).toEqual([]);
    for (const definition of [null, "CHECK (rpc_provider = 'configured_primary')",
      "CHECK (rpc_provider IN ('configured_primary', 'configured_backup', 'other'))"]) {
      const result = await probe(definition);
      expect(result.unavailableCapabilities).toEqual(['referrals']);
    }
  });

  it("proves the exact provider CHECK rendering against real PostgreSQL", async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the PostgreSQL rendering proof");
    const { sqlEntries, metadata } = readDbSchemaMigrationManifest();
    const checkSql = metadata[203].requirements.find((entry) => entry.kind === "data")?.checkSql;
    expect(checkSql).toBeTruthy();
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query("BEGIN");
      const schema = `rpc_provider_proof_${process.pid}_${Date.now()}`;
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}`);
      await client.query("CREATE TABLE solana_signed_submit_attempts (rpc_provider text NOT NULL)");
      await client.query(sqlEntries[203]);
      const definition = await client.query(`SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint AS c JOIN pg_class AS t ON t.oid = c.conrelid JOIN pg_namespace AS n ON n.oid = t.relnamespace WHERE n.nspname = $1 AND t.relname = 'solana_signed_submit_attempts' AND c.conname = 'solana_signed_submit_attempts_provider_valid'`, [schema]);
      expect(definition.rows).toHaveLength(1);
      expect(definition.rows[0].definition).toBe("CHECK ((rpc_provider = ANY (ARRAY['configured_primary'::text, 'configured_backup'::text])))");
      const readCheck = async () => {
        const result = await client.query(checkSql!);
        expect(result.rows).toHaveLength(1);
        return result.rows[0].ok;
      };
      expect(await readCheck()).toBe(true);
      for (const domain of ["'configured_primary'", "'configured_primary', 'configured_backup', 'other'"]) {
        await client.query("ALTER TABLE solana_signed_submit_attempts DROP CONSTRAINT solana_signed_submit_attempts_provider_valid");
        await client.query(`ALTER TABLE solana_signed_submit_attempts ADD CONSTRAINT solana_signed_submit_attempts_provider_valid CHECK (rpc_provider IN (${domain}))`);
        expect(await readCheck()).toBe(false);
      }
      await client.query("ALTER TABLE solana_signed_submit_attempts DROP CONSTRAINT solana_signed_submit_attempts_provider_valid");
      expect(await readCheck()).toBe(false);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
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

describe("append-only automatic cycle ledger schema", () => {
  it("appends exactly one isolated table migration with single-line CHECKs", () => {
    const { manifest, sqlEntries } = readDbSchemaMigrationManifest();
    const migration = manifest[199]; const ddl = sqlEntries[199];
    expect(migration.id).toBe("199-ai-trader-cycles");
    expect(migration.capabilities).toEqual(["ai_trader_cycles"]);
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS ai_trader_cycles");
    expect(ddl).not.toMatch(/ALTER TABLE|CASE/i);
    expect(ddl.match(/CREATE INDEX IF NOT EXISTS/g)).toHaveLength(2);
    const checks = ddl.split("\n").filter(line => line.includes(" CHECK "));
    expect(checks.length).toBeGreaterThan(10);
    expect(checks.every(line => /CHECK \(.*\)/.test(line))).toBe(true);
    expect(migration.requirements.filter(r => r.kind === "constraint").every(r => (r.definitionIncludes?.length ?? 0) > 0)).toBe(true);
  });
  it("readiness refuses a narrowed outcome/reason contract", async () => {
    const migration = readDbSchemaMigrationManifest().manifest[199];
    const checks = migration.requirements.filter(r => r.kind === "constraint");
    const subset = { ...migration, requirements: checks };
    const catalog = (narrow: boolean): CatalogQuery => async (_text, values) => {
      const requirement = checks.find(r => r.constraint === values?.[1])!;
      const definition = (requirement.definitionIncludes ?? []).join(" ");
      return { rows: [{ definition: narrow && requirement.constraint === "ai_cycles_reason_ck" ? definition.replace("'model_flat',", "") : definition }] };
    };
    expect((await probeSchemaMigrationManifest(catalog(false), [subset])).unavailableCapabilities).toEqual([]);
    expect((await probeSchemaMigrationManifest(catalog(true), [subset])).unavailableCapabilities).toEqual(["ai_trader_cycles"]);
  });
});


describe.skipIf(!process.env.DATABASE_URL)("automatic cycle readiness on PostgreSQL", () => {
  it("reports migration 199 available on a fresh schema and verifies its complete catalog", async () => {
    const migration = readDbSchemaMigrationManifest().manifest.find(entry => entry.id === "199-ai-trader-cycles")!;
    const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000,
      query_timeout: 5000, statement_timeout: 5000 });
    const schema = "cycle_readiness_" + randomUUID().replaceAll("-", "");
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}`);
      await client.query("CREATE TABLE ai_trader_bots (id varchar PRIMARY KEY)");
      await client.query(migration.sql);
      // Redirect both namespace literals and bound relation names used by the real verifier.
      const catalogQuery: CatalogQuery = (text, values) => client.query(
        text.replaceAll("'public'", `'${schema}'`),
        values?.map(value => typeof value === "string" ? value.replace(/^public\./, schema + ".") : value),
      );
      const readiness = await probeSchemaMigrationManifest(catalogQuery, [migration]);
      expect(readiness.capabilities).toContain("ai_trader_cycles");
      expect(readiness.unavailableCapabilities).toEqual([]);
      expect(readiness.evidence).toEqual([]);

      const columns = await client.query(`SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns WHERE table_schema=$1 AND table_name='ai_trader_cycles'
        ORDER BY ordinal_position`, [schema]);
      const expectedColumns = [
        ["id", "uuid", "NO", "gen_random_uuid()"],
        ["bot_id", "character varying", "NO", null],
        ["schema_version", "smallint", "NO", "1"],
        ["reason_version", "smallint", "NO", "1"],
        ["trigger", "text", "NO", "'auto'::text"],
        ["planned_boundary", "timestamp with time zone", "YES", null],
        ["started_at", "timestamp with time zone", "NO", "clock_timestamp()"],
        ["finished_at", "timestamp with time zone", "YES", null],
        ["phase", "text", "NO", "'initial'::text"],
        ["outcome", "text", "NO", "'running'::text"],
        ["reason_code", "text", "YES", null],
        ["rearmed", "boolean", "YES", null],
        ["next_planned_boundary", "timestamp with time zone", "YES", null],
        ["candidate_count", "integer", "NO", "0"],
        ["model_call_count", "integer", "NO", "0"],
        ["decision_ids", "jsonb", "NO", "'[]'::jsonb"],
        ["bot_updated_at", "timestamp without time zone", "YES", null],
        ["protocol", "text", "NO", null],
        ["market", "text", "NO", null],
        ["timeframe", "text", "NO", null],
        ["market_source", "text", "NO", null],
        ["paper_mode", "boolean", "NO", null],
        ["model", "text", "NO", null],
        ["prompt_version_hash", "text", "YES", null],
        ["context_version_hash", "text", "YES", null],
        ["owner_boot_id", "uuid", "NO", null],
        ["details", "jsonb", "NO", "'{}'::jsonb"],
      ];
      expect(columns.rows.map(row => [row.column_name, row.data_type, row.is_nullable, row.column_default]))
        .toEqual(expectedColumns);
      const tableRequirement = migration.requirements.find(r => r.kind === "table")!;
      expect(tableRequirement.columns).toEqual(expectedColumns.map(row => row[0]));

      const checks = await client.query(`SELECT c.conname FROM pg_constraint c
        WHERE c.conrelid=$1::regclass AND c.contype='c' ORDER BY c.conname`, [schema + ".ai_trader_cycles"]);
      const checkRequirements = migration.requirements.filter(r => r.kind === "constraint");
      expect(checks.rows).toHaveLength(16);
      expect(checks.rows.map(row => row.conname)).toEqual(checkRequirements.map(r => r.constraint).sort());
      // All sixteen definitions are checked against pg_get_constraintdef by the readiness probe above.
      const indexes = await client.query(`SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname=$1 AND tablename='ai_trader_cycles' ORDER BY indexname`, [schema]);
      expect(indexes.rows.map(row => row.indexname)).toEqual([
        "ai_trader_cycles_bot_latest_idx", "ai_trader_cycles_pkey", "ai_trader_cycles_running_idx",
      ]);
      expect(indexes.rows[0].indexdef).toContain("USING btree (bot_id, started_at DESC, id DESC)");
      expect(indexes.rows[1].indexdef).toContain("CREATE UNIQUE INDEX");
      expect(indexes.rows[1].indexdef).toContain("USING btree (id)");
      expect(indexes.rows[2].indexdef).toContain("USING btree (started_at) WHERE (outcome = 'running'::text)");

      // Reproduce the incident: the original ascending expectations must fail against this same DDL.
      const stale = { ...migration, requirements: migration.requirements.map(requirement =>
        requirement.kind === "index" && requirement.index === "ai_trader_cycles_bot_latest_idx"
          ? { ...requirement, columns: ["bot_id", "started_at", "id"] } : requirement) };
      const unavailable = await probeSchemaMigrationManifest(catalogQuery, [stale]);
      expect(unavailable.unavailableCapabilities).toEqual(["ai_trader_cycles"]);
      expect(unavailable.evidence).toEqual([expect.objectContaining({
        capability: "ai_trader_cycles", failureClass: "index_missing",
      })]);
    } finally {
      try { await client.query("ROLLBACK"); } finally { await client.end(); }
    }
  }, 30000);
});
