// Real PostgreSQL consumers, including indirect cooldown imports.
// Keep injected/mocked clients parallel; classify new real-database suites here.
// Shared public DDL/rows finish in a serial phase before private-schema catalog work.
export const sharedDatabaseSuites = [
  'tests/ai-trader/cycle-retention.test.ts',
  'tests/ai-trader/execution-journal.test.ts',
  'tests/ai-trader/executor.test.ts',
  'tests/ai-trader/failure-drills.test.ts',
  'tests/ai-trader/history-cursor.test.ts',
  'tests/ai-trader/monitor-pool-load-attribution.test.ts',
  'tests/ai-trader/scanner-bot.test.ts',
  'tests/ai-trader/storage-roundtrip.test.ts',
  'tests/lab-agent/turn-lease.test.ts',
  'tests/lab/candle-store-provenance.test.ts',
  'tests/lab/cleanup-checkpoint.test.ts',
  'tests/storage/error-log-retention.test.ts',
  'tests/vault/agent-sol-withdraw-db-lock.test.ts',
  'tests/vault/reset-agent-wallet-db-lock.test.ts',
];

// These suites use unique schemas or transaction-local temporary tables.
// Their bounded phase runs only after all shared-public fixtures have finished.
export const isolatedDatabaseSuites = [
  'tests/ai-trader/market-entry-cooldown.test.ts',
  'tests/ai-trader/phoenix-persistence-u14.test.ts',
  'tests/grid-bot/auto-resume-storage.test.ts',
  'tests/grid-bot/cycle-runtime.test.ts',
  'tests/grid-bot/draft-storage.test.ts',
  'tests/grid-bot/launch-storage.test.ts',
  'tests/grid-bot/lean-capacity-storage.test.ts',
  'tests/grid-bot/monitor-storage.test.ts',
  'tests/grid-bot/range-move-storage.test.ts',
  'tests/grid-bot/range-publish-schema.test.ts',
  'tests/protocol/phoenix-accounting-persistence-u0708.test.ts',
  'tests/protocol/phoenix-auto-defense-persistence-u12.test.ts',
  'tests/protocol/phoenix-borrow-journal-u11.test.ts',
  'tests/protocol/phoenix-carry-persistence-u13.test.ts',
  'tests/protocol/phoenix-funding-u04.test.ts',
  'tests/protocol/phoenix-lifecycle-persistence-u09.test.ts',
  'tests/protocol/phoenix-order-persistence-u05.test.ts',
  'tests/protocol/phoenix-parking-persistence-u10.test.ts',
  'tests/protocol/phoenix-persistence.test.ts',
  'tests/protocol/phoenix-protection-persistence-u06.test.ts',
  'tests/protocol/phoenix-provisioning-u03.test.ts',
  'tests/server/grid-worker-package-final.test.ts',
  'tests/server/grid-worker-u2a-schema.test.ts',
  'tests/server/grid-worker-u2a-wallets.test.ts',
  'tests/server/grid-worker-u2b-postgres.test.ts',
  'tests/server/grid-worker-u2c-oracle.test.ts',
  'tests/server/grid-worker-u2c-postgres.test.ts',
  'tests/server/grid-worker-u3-postgres.test.ts',
  'tests/server/grid-worker-u5a-postgres.test.ts',
  'tests/server/lab-provenance-postgres.test.ts',
  'tests/server/marketplace-subscriber-repair-postgres.test.ts',
  'tests/server/planner-weekly-postgres.test.ts',
  'tests/server/schema-readiness.test.ts',
];

export const realDatabaseSuites = [...sharedDatabaseSuites, ...isolatedDatabaseSuites];
