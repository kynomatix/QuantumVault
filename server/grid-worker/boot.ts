import { SCHEMA_MIGRATION_MANIFEST } from '../schema-migration-manifest';
import { probeSchemaMigrationManifest, installSchemaReadinessSnapshot } from '../schema-readiness-probe';
import type { CatalogQuery } from '../schema-readiness-probe';

// Transaction read-only mode also protects against an accidentally mutating probe.
export async function probeGridWorkerSchema(query: CatalogQuery): Promise<void> {
  await query('BEGIN READ ONLY');
  try {
    const snapshot = await probeSchemaMigrationManifest(query, SCHEMA_MIGRATION_MANIFEST);
    installSchemaReadinessSnapshot(snapshot);
    if (snapshot.unavailableCapabilities.length) throw new Error('GRID_WORKER_SCHEMA_UNAVAILABLE');
    await query('COMMIT');
  } catch {
    await query('ROLLBACK');
    throw new Error('GRID_WORKER_SCHEMA_UNAVAILABLE');
  }
}
