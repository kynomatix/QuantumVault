import { assertGridWorkerEnvironment } from '../process-role';
export { getExecutionUmk, readExecutionWallet } from '../execution/umk';
export { decryptAgentKeyV3 } from '../execution/agent-key';

// U1 is a boot-check executable. It never schedules work or opens a listener.
export async function bootGridWorker(
  databaseFactory?: typeof import('./database').createGridWorkerDatabase,
): Promise<void> {
  assertGridWorkerEnvironment(process.env);
  const [{ createGridWorkerDatabase }, { probeGridWorkerSchema }] = await Promise.all([
    import('./database'), import('./boot'),
  ]);
  const database = (databaseFactory ?? createGridWorkerDatabase)(process.env.DATABASE_URL!);
  const watchdog = setTimeout(() => {
    console.error('GRID_WORKER_U1_WATCHDOG');
    process.exit(1);
  }, 20_000);
  try {
    const client = await database.connect();
    try {
      await probeGridWorkerSchema(async (text, values) => client.query(text, values ? [...values] : undefined));
    } finally {
      client.release();
    }
  } finally {
    try { await database.close(); } finally { clearTimeout(watchdog); }
  }
  console.log('GRID_WORKER_U1_BOOT_OK');
}

if (require.main === module) {
  const fatal = () => { console.error('GRID_WORKER_U1_BOOT_FAILED'); process.exit(1); };
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
  void bootGridWorker().catch(fatal);
}
