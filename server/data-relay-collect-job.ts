import { dataRelayClient } from './data-relay-client';
import type { CollectResult } from './market-stats/liquidations-relay';

const HOUR = 3_600_000;
export function nextCollectionTime(now: number): number {
  const minute3 = Math.floor(now / HOUR) * HOUR + 3 * 60_000;
  return minute3 > now ? minute3 : minute3 + HOUR;
}
type Options = {
  deployment?: string; collect: () => Promise<CollectResult>; now: () => number;
  log: (result: CollectResult) => void;
};
// Module ownership also protects against a second starter within this process.
let processInFlight = false;
let processStop: (() => void) | undefined;

/** No startup collection, catch-up loop, retries, database or heatmap invalidation. */
export function startDataRelayCollectJob(options: Options): () => void {
  if (options.deployment !== '1') return () => {};
  if (processStop) return processStop;
  let stopped = false, lastLoggedHour = -Infinity;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    timer = setTimeout(tick, Math.max(1, nextCollectionTime(options.now()) - options.now()));
    timer.unref?.();
  };
  const tick = () => {
    if (stopped) return;
    schedule();
    if (processInFlight) return;
    processInFlight = true;
    const started = options.now();
    void (async () => {
      let result: CollectResult;
      try { result = await options.collect(); }
      catch { result = { status: 'malformed', durationMs: Math.max(0, options.now() - started) }; }
      processInFlight = false;
      // Safe fixed fields only; never pass through exceptions, URLs, bodies or credentials.
      const hour = Math.floor(started / HOUR);
      if (stopped || hour <= lastLoggedHour) return;
      lastLoggedHour = hour;
      try { options.log({ status: result.status, durationMs: result.durationMs,
        ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
        ...(typeof result.partial === 'boolean' ? { partial: result.partial } : {}) }); }
      catch { /* Logging cannot strand the collection owner. */ }
    })();
  };
  processStop = () => { stopped = true; clearTimeout(timer); processStop = undefined; };
  schedule();
  return processStop;
}

export function startDefaultDataRelayCollectJob() {
  return startDataRelayCollectJob({ deployment: process.env.REPLIT_DEPLOYMENT, collect: dataRelayClient.collect, now: Date.now,
    log: result => console.info('[DataRelay collect]', JSON.stringify(result)) });
}
