import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type { ClientLane } from './transaction';
/** A fresh, single-client control lane cannot queue behind execution-pool admission. */
export function independentLane(source: Pool): ClientLane {
  return { async connect(): Promise<PoolClient> {
    // pg exposes the effective pool configuration at runtime; @types/pg omits it.
    const config = (source as Pool & { options: PoolConfig }).options;
    const pool = new Pool({ ...config, max: 1, connectionTimeoutMillis: 2_000, query_timeout: 2_000,
      options: (config.options ?? '') + ' -c statement_timeout=2000 -c idle_in_transaction_session_timeout=12000' });
    try {
      const client = await pool.connect();
      const release = client.release.bind(client);
      client.release = (error?: boolean | Error) => { release(error); void pool.end(); };
      return client;
    } catch (error) { await pool.end(); throw error; }
  } };
}
export function backendTerminator(lane: ClientLane) {
  return async (pid: number): Promise<void> => {
    const client = await lane.connect();
    try { await client.query('SELECT pg_terminate_backend($1)', [pid]); } finally { client.release(true); }
  };
}
