import { SCHEMA_MIGRATION_MANIFEST } from '../schema-migration-manifest';
import { probeSchemaMigrationManifest, installSchemaReadinessSnapshot } from '../schema-readiness-probe';
import type { CatalogQuery, SchemaReadinessSnapshot } from '../schema-readiness-probe';

export const GRID_WORKER_REQUIRED_CAPABILITIES = ['grid_bot', 'wallet_security', 'grid_worker'] as const;
export interface GridWorkerSchemaSnapshot extends SchemaReadinessSnapshot {
  readonly checkedAt: string;
  readonly expiresAt: string;
}
export const GRID_WORKER_CLOCK_SQL = `WITH now AS (SELECT clock_timestamp() AS at) SELECT at AS "checkedAt", at + interval '60 seconds' AS "expiresAt" FROM now`;

// Transaction read-only mode also protects against an accidentally mutating probe.
export async function probeGridWorkerSchema(query: CatalogQuery): Promise<GridWorkerSchemaSnapshot> {
  await query('BEGIN READ ONLY');
  try {
    const required = new Set<string>(GRID_WORKER_REQUIRED_CAPABILITIES);
    const manifest = SCHEMA_MIGRATION_MANIFEST.filter(entry => entry.capabilities.some(capability => required.has(capability)));
    const snapshot = await probeSchemaMigrationManifest(query, manifest);
    installSchemaReadinessSnapshot(snapshot);
    if (snapshot.unavailableCapabilities.some(capability => required.has(capability))) throw new Error('GRID_WORKER_SCHEMA_UNAVAILABLE');
    const row = (await query(GRID_WORKER_CLOCK_SQL)).rows[0];
    const checkedAt = row?.checkedAt instanceof Date ? row.checkedAt.toISOString() : String(row?.checkedAt);
    const expiresAt = row?.expiresAt instanceof Date ? row.expiresAt.toISOString() : String(row?.expiresAt);
    if (!Number.isFinite(Date.parse(checkedAt)) || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) - Date.parse(checkedAt) !== 60_000) throw new Error('GRID_WORKER_SCHEMA_CLOCK');
    await query('COMMIT');
    return Object.freeze({ ...snapshot, checkedAt, expiresAt });
  } catch {
    await query('ROLLBACK');
    throw new Error('GRID_WORKER_SCHEMA_UNAVAILABLE');
  }
}
