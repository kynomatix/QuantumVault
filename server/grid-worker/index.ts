import { assertGridWorkerEnvironment } from '../process-role';
export { getExecutionUmk, readExecutionWallet } from '../execution/umk';
export { decryptAgentKeyV3 } from '../execution/agent-key';

// Retained read-only probe API for offline schema verification. The executable uses the U4 service below.
export async function bootGridWorker(
  databaseFactory?: (url:string)=>Pick<ReturnType<typeof import('./database').createGridWorkerDatabase>,'connect'|'close'>,
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

export async function bootGridWorkerService() {
  const {workerEnvironment} = await import('./environment');
  const env = workerEnvironment(process.env, line => console.log(line));
  const {startWorkerRuntime} = await import('./runtime');
  return startWorkerRuntime(env);
}
if (require.main === module) {
  const fatal = () => { console.error('GRID_WORKER_BOOT_FAILED'); process.exit(1); };
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
  let stopping=false,runtime:Awaited<ReturnType<typeof bootGridWorkerService>>|undefined;
  const stop=()=>{stopping=true;if(runtime)void runtime.stop().catch(fatal);};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  void bootGridWorkerService().then(value=>{runtime=value;if(stopping)stop();}).catch(fatal);
}
