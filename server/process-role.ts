type Environment = Readonly<Record<string, string | undefined>>;

export function assertWebProcessRole(env: Environment): void {
  if (env.QV_PROCESS_ROLE && env.QV_PROCESS_ROLE !== 'web') throw new Error('WEB_PROCESS_ROLE_INVALID');
}

export function assertGridWorkerEnvironment(env: Environment): void {
  if (env.QV_PROCESS_ROLE !== 'grid-worker' || env.REPLIT_DEPLOYMENT !== '1') {
    throw new Error('GRID_WORKER_ROLE_INVALID');
  }
  const forbidden = /^(?:PG.*|AGENT_.*|UMK_.*|SESSION_SECRET|ADMIN_PASSWORD|LOG_READ_TOKEN|TELEGRAM_.*|DATA_RELAY_.*|QV_PROD_DATABASE_URL)$/;
  if (Object.keys(env).some(name => forbidden.test(name))) {
    throw new Error('GRID_WORKER_SECRET_BOUNDARY');
  }
  if (!/^[a-fA-F0-9]{64}$/.test(env.SERVER_EXECUTION_KEY ?? '')) throw new Error('GRID_WORKER_EXECUTION_KEY_INVALID');
  if (!env.DATABASE_URL) throw new Error('GRID_WORKER_DATABASE_REQUIRED');
  for (const name of ['SOLANA_ENV', 'DRIFT_ENV']) {
    if (env[name] && env[name] !== 'mainnet-beta') throw new Error('GRID_WORKER_NETWORK_INVALID');
  }
}
