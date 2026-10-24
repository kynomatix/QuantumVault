import { afterAll } from 'vitest';
import { Client } from 'pg';

// setupFiles runs before suite imports, including public manifest DDL.
// A dedicated session owns the lock; suite clients can still race deliberately.
if (process.env.DATABASE_URL) {
  const lockClient = new Client({
    connectionString: process.env.DATABASE_URL,
    application_name: 'vitest-real-database-suite',
  });
  try {
    await lockClient.connect();
    await lockClient.query('SELECT pg_advisory_lock(188659, 1)');
  } catch (error) {
    await lockClient.end();
    throw error;
  }
  // Stack ordering makes this the final root hook, after suite pool cleanup.
  // Closing the owning session releases the lock even when a suite fails.
  afterAll(async () => { await lockClient.end(); });
}
