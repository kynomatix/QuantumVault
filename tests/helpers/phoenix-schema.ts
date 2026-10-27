import { readDbSchemaMigrationManifest } from './schema-migration-manifest';

// Read the actual manifest, including imported reviewed DDL definitions.
export function phoenixMigrationFixture() {
  const { manifest } = readDbSchemaMigrationManifest();
  return { manifest, phoenix: manifest.find(entry => entry.id === '186-phoenix-identity-and-operations')! };
}
