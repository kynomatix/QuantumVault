/** Only the exact, explicit value enables a release switch. */
export const gridFlag = (value: string | undefined): boolean => value === 'true';
let workerRunning = false;
export function gridWorkerState(running: boolean) { workerRunning = running; }
export function gridRuntimeGates(env: NodeJS.ProcessEnv = process.env) {
  const startConfigured = gridFlag(env.GRID_START_ENABLED), workerEnabled = gridFlag(env.GRID_WORKER_ENABLED);
  const running = workerRunning;
  const draftEnabled = gridFlag(env.GRID_BOT_ENABLED);
  const startEnabled = draftEnabled && startConfigured && workerEnabled && running;
  return { draftEnabled, startConfigured, workerEnabled, workerRunning: running, startEnabled, draftOnly: !running };
}
export type GridRuntimeGates = ReturnType<typeof gridRuntimeGates>;
/** Session-only security is intentionally excluded from unattended Grid execution. */
export async function durableGridUmk(wallet:string){
  const {getUmkForWebhook}=await import('../session-v3');
  return getUmkForWebhook(wallet);
}
