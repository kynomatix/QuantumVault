import { assertGridWorkerEnvironment } from '../process-role';

export const WORKER_ENVIRONMENT_READS = Object.freeze([
  'QV_PROCESS_ROLE', 'REPLIT_DEPLOYMENT', 'DATABASE_URL', 'SERVER_EXECUTION_KEY',
  'PORT', 'SOLANA_ENV', 'DRIFT_ENV', 'PACIFICA_API_KEY', 'HELIUS_API_KEY',
  'GRID_REMOTE_WORKER_ENABLED', 'GRID_ENTRIES_PAUSED', 'REUSE_ON_CREATE', 'RECYCLE_ON_DELETE', 'GRID_RECYCLER_DEPLOYMENT',
] as const);
export type WorkerEnvironment = Readonly<Partial<Record<typeof WORKER_ENVIRONMENT_READS[number], string>>>;
/** Enumerate names without touching unknown values or accessors (conductor R1). */
export function workerEnvironment(source: Readonly<Record<string, string | undefined>>, log: (names: string) => void): WorkerEnvironment {
  const names = Object.keys(source).sort();
  log('GRID_WORKER_ENV_NAMES ' + names.join(','));
  const forbidden = names.filter(name => /^(?:PG.*|UMK_.*|AGENT_.*|SESSION_SECRET|ADMIN_PASSWORD|LOG_READ_TOKEN|TELEGRAM_.*|DATA_RELAY_.*|QV_PROD_DATABASE_URL)$/.test(name));
  if (forbidden.length) { log('GRID_WORKER_SECRET_BOUNDARY ' + forbidden.join(',')); throw Error('GRID_WORKER_SECRET_BOUNDARY'); }
  const env = Object.fromEntries(WORKER_ENVIRONMENT_READS.map(name => [name, source[name]]));
  assertGridWorkerEnvironment(env);
  if (env.PORT !== undefined && (!/^\d{1,5}$/.test(env.PORT) || Number(env.PORT) < 1 || Number(env.PORT) > 65535)) throw Error('GRID_WORKER_PORT_INVALID');
  return Object.freeze(env);
}
