export const SCHEMA_CAPABILITIES = [
  "platform",
  "lab",
  "lab_scanner",
  "signal_bot",
  "referrals",
  "portfolio",
  "notifications",
  "wallet_security",
  "vault",
  "sol_loop",
  "oracle",
  "ai_trader",
] as const;

export type SchemaCapability = (typeof SCHEMA_CAPABILITIES)[number];
export const SCHEMA_FAILURE_CLASSES = [
  "ddl_failed",
  "postcondition_missing",
  "backfill_failed",
  "index_missing",
] as const;
export type SchemaFailureClass = (typeof SCHEMA_FAILURE_CLASSES)[number];

export type CatalogQuery = (
  text: string,
  values?: readonly unknown[],
) => Promise<{ rows: readonly Record<string, unknown>[] }>;

export type SchemaRequirement =
  | {
      readonly kind: "table";
      readonly table: string;
      readonly columns: readonly string[];
      readonly constraintDefinitions?: readonly string[];
    }
  | {
      readonly kind: "column";
      readonly table: string;
      readonly column: string;
    }
  | {
      readonly kind: "constraint";
      readonly table: string;
      readonly constraint: string;
      readonly definitionIncludes?: readonly string[];
    }
  | {
      readonly kind: "constraint_absent";
      readonly table: string;
      readonly constraint: string;
    }
  | {
      readonly kind: "index";
      readonly table: string;
      readonly index: string;
      readonly columns: readonly string[];
      readonly unique: boolean;
      readonly predicateIncludes?: readonly string[];
    }
  | {
      readonly kind: "data";
      readonly identity: string;
      readonly checkSql: string;
    };

export interface SchemaMigrationDefinition {
  readonly id: string;
  readonly sql: string;
  readonly capabilities: readonly SchemaCapability[];
  readonly requirements: readonly SchemaRequirement[];
  readonly operation: "ddl" | "backfill";
}

export interface SchemaReadinessEvidence {
  readonly capability: SchemaCapability;
  readonly failureClass: SchemaFailureClass;
  readonly objectIdentity: string;
}

export interface SchemaReadinessSnapshot {
  readonly evaluated: true;
  readonly capabilities: readonly SchemaCapability[];
  readonly unavailableCapabilities: readonly SchemaCapability[];
  readonly evidence: readonly SchemaReadinessEvidence[];
}

export interface SchemaReadinessHealth {
  readonly evaluated: boolean;
  readonly unavailableCapabilities: readonly SchemaCapability[];
}

const CAPABILITY_SET = new Set<string>(SCHEMA_CAPABILITIES);
let registeredManifest: readonly SchemaMigrationDefinition[] | null = null;
let installedSnapshot: SchemaReadinessSnapshot | null = null;
const processProbePromises = new Map<SchemaCapability, Promise<SchemaReadinessEvidence[]>>();

function freezeEvidence(evidence: SchemaReadinessEvidence): SchemaReadinessEvidence {
  return Object.freeze({ ...evidence });
}

function makeSnapshot(evidenceInput: readonly SchemaReadinessEvidence[]): SchemaReadinessSnapshot {
  const seen = new Set<string>();
  const evidence = evidenceInput
    .filter((item) => {
      const key = `${item.capability}\u0000${item.failureClass}\u0000${item.objectIdentity}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(freezeEvidence);
  const unavailable = SCHEMA_CAPABILITIES.filter((capability) =>
    evidence.some((item) => item.capability === capability),
  );
  return Object.freeze({
    evaluated: true as const,
    capabilities: Object.freeze([...SCHEMA_CAPABILITIES]),
    unavailableCapabilities: Object.freeze(unavailable),
    evidence: Object.freeze(evidence),
  });
}

function requirementIdentity(requirement: SchemaRequirement): string {
  switch (requirement.kind) {
    case "table": return `table:${requirement.table}`;
    case "column": return `column:${requirement.table}.${requirement.column}`;
    case "constraint": return `constraint:${requirement.table}.${requirement.constraint}`;
    case "constraint_absent": return `constraint_absent:${requirement.table}.${requirement.constraint}`;
    case "index": return `index:${requirement.table}.${requirement.index}`;
    case "data": return `data:${requirement.identity}`;
  }
}

function normalizeDefinition(value: unknown): string {
  return String(value ?? "")
    .replace(/["']/g, "")
    .replace(/::[a-z_ ]+(\[\])?/gi, "")
    .replace(/\b([a-z_][a-z0-9_]*)\s+in\s*\(([^)]*)\)/gi, "$1 = any array $2")
    .replace(/\bcheck\b/gi, "")
    .replace(/[()[\],]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function includesAll(definition: unknown, expected: readonly string[] | undefined): boolean {
  if (!expected?.length) return true;
  const normalized = normalizeDefinition(definition);
  return expected.every((part) => normalized.includes(normalizeDefinition(part)));
}

async function verifyRequirement(
  query: CatalogQuery,
  requirement: SchemaRequirement,
): Promise<boolean> {
  switch (requirement.kind) {
    case "table": {
      const relation = await query("SELECT to_regclass($1) AS relation", [`public.${requirement.table}`]);
      if (!relation.rows[0]?.relation) return false;
      const columns = await query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
        [requirement.table],
      );
      const actualColumns = new Set(columns.rows.map((row) => String(row.column_name)));
      if (!requirement.columns.every((column) => actualColumns.has(column))) return false;
      if (requirement.constraintDefinitions?.length) {
        const constraints = await query(
          "SELECT pg_get_constraintdef(c.oid, true) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname=$1",
          [requirement.table],
        );
        const definitions = constraints.rows.map((row) => normalizeDefinition(row.definition));
        if (!requirement.constraintDefinitions.every((expected) =>
          definitions.some((actual) => actual.includes(normalizeDefinition(expected))),
        )) return false;
      }
      return true;
    }
    case "column": {
      const result = await query(
        "SELECT 1 AS present FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2",
        [requirement.table, requirement.column],
      );
      return result.rows.length === 1;
    }
    case "constraint": {
      const result = await query(
        "SELECT pg_get_constraintdef(c.oid, true) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname=$1 AND c.conname=$2",
        [requirement.table, requirement.constraint],
      );
      return result.rows.length === 1
        && includesAll(result.rows[0]?.definition, requirement.definitionIncludes);
    }
    case "constraint_absent": {
      const result = await query(
        "SELECT 1 AS present FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname=$1 AND c.conname=$2",
        [requirement.table, requirement.constraint],
      );
      return result.rows.length === 0;
    }
    case "index": {
      const result = await query(
        "SELECT t.relname AS table_name, i.indisunique AS is_unique, pg_get_expr(i.indpred, i.indrelid) AS predicate, ARRAY(SELECT pg_get_indexdef(i.indexrelid, k, true) FROM generate_series(1, i.indnkeyatts) AS k ORDER BY k) AS columns FROM pg_index i JOIN pg_class x ON x.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND x.relname=$1",
        [requirement.index],
      );
      const row = result.rows[0];
      if (!row || row.table_name !== requirement.table || row.is_unique !== requirement.unique) return false;
      const actualColumns = Array.isArray(row.columns) ? row.columns.map(normalizeDefinition) : [];
      if (actualColumns.length !== requirement.columns.length) return false;
      if (!requirement.columns.every((column, index) =>
        actualColumns[index] === normalizeDefinition(column),
      )) return false;
      return includesAll(row.predicate, requirement.predicateIncludes);
    }
    case "data": {
      const result = await query(requirement.checkSql);
      return result.rows[0]?.ok === true;
    }
  }
}

function assertManifest(manifest: readonly SchemaMigrationDefinition[]): void {
  if (manifest.length === 0) throw new Error("schema readiness manifest is empty");
  const ids = new Set<string>();
  for (const migration of manifest) {
    if (!migration.id || ids.has(migration.id)) throw new Error(`duplicate schema migration id: ${migration.id}`);
    ids.add(migration.id);
    if (!migration.sql || migration.capabilities.length === 0 || migration.requirements.length === 0) {
      throw new Error(`incomplete schema migration manifest entry: ${migration.id}`);
    }
    for (const capability of migration.capabilities) {
      if (!CAPABILITY_SET.has(capability)) throw new Error(`unknown schema capability: ${capability}`);
    }
  }
}

export function registerSchemaMigrationManifest(
  manifest: readonly SchemaMigrationDefinition[],
): void {
  assertManifest(manifest);
  registeredManifest = Object.freeze([...manifest]);
}

async function checkRequirements(
  query: CatalogQuery,
  migrations: readonly SchemaMigrationDefinition[],
): Promise<SchemaReadinessEvidence[]> {
  const evidence: SchemaReadinessEvidence[] = [];
  for (const migration of migrations) {
    for (const requirement of migration.requirements) {
      let ready = false;
      try {
        ready = await verifyRequirement(query, requirement);
      } catch {
        ready = false;
      }
      if (ready) continue;
      const failureClass: SchemaFailureClass = requirement.kind === "index"
        ? "index_missing"
        : "postcondition_missing";
      for (const capability of migration.capabilities) {
        evidence.push({ capability, failureClass, objectIdentity: requirementIdentity(requirement) });
      }
    }
  }
  return evidence;
}

export async function applySchemaMigrationManifest(
  query: CatalogQuery,
  manifest: readonly SchemaMigrationDefinition[],
): Promise<SchemaReadinessSnapshot> {
  assertManifest(manifest);
  const evidence: SchemaReadinessEvidence[] = [];
  for (const migration of manifest) {
    try {
      await query(migration.sql);
    } catch {
      const failureClass: SchemaFailureClass = migration.operation === "backfill"
        ? "backfill_failed"
        : "ddl_failed";
      for (const capability of migration.capabilities) {
        evidence.push({ capability, failureClass, objectIdentity: `migration:${migration.id}` });
      }
    }
    evidence.push(...await checkRequirements(query, [migration]));
  }
  return makeSnapshot(evidence);
}

export function installSchemaReadinessSnapshot(snapshot: SchemaReadinessSnapshot): void {
  installedSnapshot = makeSnapshot(snapshot.evidence);
}

export function getInstalledSchemaReadinessSnapshot(): SchemaReadinessSnapshot | null {
  return installedSnapshot;
}

export function getSchemaReadinessHealth(): SchemaReadinessHealth {
  return Object.freeze({
    evaluated: installedSnapshot !== null,
    unavailableCapabilities: Object.freeze([
      ...(installedSnapshot?.unavailableCapabilities ?? []),
    ]),
  });
}

export function isSchemaCapabilityReady(capability: SchemaCapability): boolean {
  return installedSnapshot !== null
    && !installedSnapshot.unavailableCapabilities.includes(capability);
}

export class SchemaCapabilityUnavailableError extends Error {
  readonly code = "schema_capability_unavailable" as const;
  constructor(readonly capability: SchemaCapability) {
    super(`Schema capability unavailable: ${capability}`);
    this.name = "SchemaCapabilityUnavailableError";
  }
}

async function reportEvidence(evidence: readonly SchemaReadinessEvidence[]): Promise<void> {
  const pairs = new Map<string, SchemaReadinessEvidence>();
  for (const item of evidence) pairs.set(`${item.capability}\u0000${item.failureClass}`, item);
  try {
    const { recordCriticalError } = await import("./error-log");
    for (const item of pairs.values()) {
      recordCriticalError(createSchemaReadinessAlert(item));
    }
  } catch {
    // Readiness reporting is best-effort and must never widen the blast radius.
  }
}

export function createSchemaReadinessAlert(item: SchemaReadinessEvidence) {
  return Object.freeze({
    category: "server_500" as const,
    severity: "critical" as const,
    source: "schema-readiness",
    message: `Schema readiness unavailable capability=${item.capability} failure_class=${item.failureClass}`,
    detail: `object_identity=${item.objectIdentity}`,
    context: Object.freeze({
      capability: item.capability,
      failureClass: item.failureClass,
      objectIdentity: item.objectIdentity,
    }),
    fingerprint: `schema-readiness:${item.capability}:${item.failureClass}`,
  });
}

export async function reportSchemaReadiness(snapshot: SchemaReadinessSnapshot): Promise<void> {
  await reportEvidence(snapshot.evidence);
}

export async function requireSchemaCapabilityReady(
  capability: SchemaCapability,
  catalogQuery?: CatalogQuery,
): Promise<void> {
  if (!CAPABILITY_SET.has(capability)) throw new SchemaCapabilityUnavailableError(capability);
  if (installedSnapshot) {
    if (!installedSnapshot.unavailableCapabilities.includes(capability)) return;
    throw new SchemaCapabilityUnavailableError(capability);
  }
  if (!catalogQuery || !registeredManifest) throw new SchemaCapabilityUnavailableError(capability);

  let probe = processProbePromises.get(capability);
  if (!probe) {
    const migrations = registeredManifest.filter((migration) =>
      migration.capabilities.includes(capability),
    );
    probe = migrations.length === 0
      ? Promise.resolve([{ capability, failureClass: "postcondition_missing", objectIdentity: "manifest:missing" }])
      : checkRequirements(catalogQuery, migrations);
    processProbePromises.set(capability, probe);
  }
  const evidence = await probe;
  if (evidence.length === 0) return;
  await reportEvidence(evidence);
  throw new SchemaCapabilityUnavailableError(capability);
}

export function resetSchemaReadinessForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("schema readiness reset is test-only");
  installedSnapshot = null;
  registeredManifest = null;
  processProbePromises.clear();
}
