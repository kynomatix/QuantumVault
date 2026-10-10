import { PhoenixReadAdapter } from './phoenix-read-adapter';
import { PhoenixRestTransport } from './transport';
import { PhoenixPublicStream } from './public-stream';

export function phoenixReadsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PHOENIX_READS_ENABLED === 'true';
}

export function phoenixReadRefreshMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.PHOENIX_READ_REFRESH_MS);
  return Number.isInteger(value) && value >= 30_000 && value <= 60_000 ? value : 60_000;
}

let reader: PhoenixReadAdapter | null = null;
let stop: (() => void) | null = null;

/** Dedicated display registry. Never registered in the money adapter registry. */
export function getPhoenixReader(): PhoenixReadAdapter | null { return reader; }

export function startPhoenixPublicReads(
  env: NodeJS.ProcessEnv = process.env,
  createReader = () => new PhoenixReadAdapter(new PhoenixRestTransport(), Date.now, 120_000, phoenixReadRefreshMs(env)),
  createStream = (target: PhoenixReadAdapter) => new PhoenixPublicStream(event => target.onPublicStreamInvalidation(event), undefined, mids => target.onPublicMids(mids)),
): void {
  if (!phoenixReadsEnabled(env) || reader) return;
  try {
    const target = createReader();
    reader = target;
    const stream = createStream(target);
    const refresh = () => { void target.refresh().catch(() => { /* retained as stale/unknown */ }); };
    const interval = setInterval(refresh, phoenixReadRefreshMs(env));
    interval.unref?.();
    stop = () => { clearInterval(interval); stream.shutdown(); target.shutdown(); };
    // A stream failure degrades only Phoenix; REST snapshots still run.
    try { stream.start(); } catch { target.onPublicStreamInvalidation('disconnect'); }
    refresh();
  } catch {
    stop?.(); stop = null; reader = null;
    console.warn('[Phoenix] Public reads unavailable');
  }
}

export function stopPhoenixPublicReads(): void { stop?.(); stop = null; reader = null; }
