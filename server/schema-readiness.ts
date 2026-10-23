// Pure catalog checks are shared with the worker; reporting and DDL stay here.
export * from './schema-readiness-probe';
import { CAPABILITY_SET, installedSnapshot, makeSnapshot, assertManifest, evaluateRequirements, evidenceFromChecks, checkRequirements, installSchemaReadinessSnapshot, SchemaCapabilityUnavailableError, resetInstalledSchemaReadinessForTests } from './schema-readiness-probe';
import type { SchemaMigrationDefinition, SchemaCapability, SchemaReadinessEvidence, SchemaReadinessSnapshot, SchemaFailureClass, CatalogQuery } from './schema-readiness-probe';

let registeredManifest: readonly SchemaMigrationDefinition[] | null = null;
const processProbePromises = new Map<SchemaCapability, Promise<SchemaReadinessEvidence[]>>();
let verificationReprobeAttempted = false;
let verificationReprobeTimer: ReturnType<typeof setTimeout> | null = null;

export function registerSchemaMigrationManifest(
  manifest: readonly SchemaMigrationDefinition[],
): void {
  assertManifest(manifest);
  registeredManifest = Object.freeze([...manifest]);
}

export async function applySchemaMigrationManifest(
  query: CatalogQuery,
  manifest: readonly SchemaMigrationDefinition[],
): Promise<SchemaReadinessSnapshot> {
  assertManifest(manifest);
  const executionFailures = new Map<string, SchemaFailureClass>();
  for (const migration of manifest) {
    try {
      await query(migration.sql);
    } catch {
      executionFailures.set(migration.id, migration.operation === "backfill"
        ? "backfill_failed"
        : "ddl_failed");
    }
  }

  const checks = await evaluateRequirements(query, manifest);
  const evidence = evidenceFromChecks(checks);
  for (const migration of manifest) {
    const failureClass = executionFailures.get(migration.id);
    if (!failureClass) continue;
    const activeChecks = checks.filter((check) => check.migration.id === migration.id);
    if (activeChecks.length === 0 || activeChecks.every((check) => check.ready)) continue;
    for (const capability of migration.capabilities) {
      evidence.push({ capability, failureClass, objectIdentity: `migration:${migration.id}` });
    }
  }
  return makeSnapshot(evidence);
}

export const SCHEMA_READINESS_REPROBE_DELAY_MS = 30_000;

export function scheduleSchemaReadinessVerificationReprobe(
  initialSnapshot: SchemaReadinessSnapshot,
  reprobe: () => Promise<SchemaReadinessSnapshot>,
): boolean {
  if (verificationReprobeAttempted
      || !initialSnapshot.evidence.some((item) => item.failureClass === "verification_failed")) {
    return false;
  }
  verificationReprobeAttempted = true;
  verificationReprobeTimer = setTimeout(() => {
    verificationReprobeTimer = null;
    void reprobe()
      .then(async (snapshot) => {
        installSchemaReadinessSnapshot(snapshot);
        await reportSchemaReadiness(snapshot);
      })
      .catch(() => {
        // The original fail-closed snapshot stays authoritative. The retry is one-shot.
      });
  }, SCHEMA_READINESS_REPROBE_DELAY_MS);
  verificationReprobeTimer.unref?.();
  return true;
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
  resetInstalledSchemaReadinessForTests();
  registeredManifest = null;
  processProbePromises.clear();
  verificationReprobeAttempted = false;
  if (verificationReprobeTimer) clearTimeout(verificationReprobeTimer);
  verificationReprobeTimer = null;
}
