import pg from 'pg';
import type { PoolClient } from 'pg';

function connectionString(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || url.pathname.length < 2) throw new Error();
    // pg connection-string SSL parameters override the Pool SSL object. Remove the
    // accepted mode and refuse file/weak-mode overrides so certificate checks stay on.
    for (const [name, value] of url.searchParams) {
      if (name.startsWith('ssl') && (name !== 'sslmode' || !['require', 'verify-full'].includes(value))) throw new Error();
    }
    url.searchParams.delete('sslmode');
    return url.toString();
  } catch {
    throw new Error('GRID_WORKER_DATABASE_CONFIG_INVALID');
  }
}

export function createGridWorkerDatabase(databaseUrl: string) {
  const pool = new pg.Pool({
    connectionString: connectionString(databaseUrl),
    ssl: { rejectUnauthorized: true },
    max: 4,
    connectionTimeoutMillis: 2_000,
    query_timeout: 2_000,
    idleTimeoutMillis: 12_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5_000,
    application_name: 'qv-grid-worker',
    options: '-c statement_timeout=2000 -c idle_in_transaction_session_timeout=12000 -c tcp_keepalives_idle=5',
  });
  pool.on('error', () => { console.error('GRID_WORKER_DATABASE_IDLE_ERROR'); });
  pool.on('connect', client => {
    client.on('error', () => { console.error('GRID_WORKER_DATABASE_CLIENT_ERROR'); });
  });
  return {
    pool,
    async connect(): Promise<PoolClient> {
      const client = await pool.connect();
      try {
        const result = await client.query(`SELECT
          current_setting('statement_timeout') AS statement_timeout,
          current_setting('idle_in_transaction_session_timeout') AS idle_timeout,
          current_setting('tcp_keepalives_idle') AS keepalive_idle`);
        const settings = result.rows[0];
        if (!['2s', '2000ms'].includes(settings?.statement_timeout)
            || !['12s', '12000ms'].includes(settings?.idle_timeout)
            || settings?.keepalive_idle !== '5') throw new Error();
        return client;
      } catch {
        client.release(true);
        throw new Error('GRID_WORKER_DATABASE_BOUNDS_INVALID');
      }
    },
    close: () => pool.end(),
  };
}
