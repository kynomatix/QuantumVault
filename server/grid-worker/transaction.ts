import type { PoolClient } from 'pg';
import { performance } from 'node:perf_hooks';

export interface ClientLane { connect(): Promise<PoolClient> }
export interface TransactionOutcome { commitIssued:boolean; committed:boolean; rolledBack:boolean }
export interface FenceOptions {
  mode?: 'shared' | 'exclusive' | 'none'; pause?: boolean; tightening?: boolean;
  terminate: (pid: number) => Promise<void>;
  unknown?: () => Promise<void>;
  budget?: GridDeadline;
  outcome?: TransactionOutcome;
}
export class GridDeadline {
  readonly started = performance.now();
  readonly wallStarted = Date.now();
  readonly abort = new AbortController();
  closed = false;
  constructor(readonly milliseconds = 20_000) {}
  remaining() { return Math.min(this.milliseconds - (performance.now() - this.started), this.milliseconds - (Date.now() - this.wallStarted)); }
  check() {
    const clockDrift = Math.abs((Date.now() - this.wallStarted) - (performance.now() - this.started));
    if (this.closed || this.remaining() <= 0 || clockDrift > 1_000) { this.closed = true; this.abort.abort(); throw Error('GRID_TRANSACTION_UNKNOWN'); }
  }
  beforeTransport(signedAt: number, expiresAt: number) {
    this.check();
    if (!Number.isSafeInteger(signedAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= signedAt || expiresAt - signedAt > 15_000
      || Date.now() < signedAt || Date.now() >= expiresAt) throw Error('GRID_SIGNED_WINDOW_INVALID');
  }
}
export async function hostFence(client: PoolClient, mode: 'shared' | 'exclusive') {
  await client.query(mode === 'shared'
    ? "SELECT pg_advisory_xact_lock_shared(hashtextextended('qv:grid-worker:v3:host',0))"
    : "SELECT pg_advisory_xact_lock(hashtextextended('qv:grid-worker:v3:host',0))");
}
export async function walletFences(client: PoolClient, wallets: readonly string[]) {
  // Each wallet is a scalar binding; no list is expanded by a query adapter.
  const sorted = [...new Set(wallets)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const wallet of sorted) await client.query('SELECT pg_advisory_xact_lock(927412,hashtext($1))', [wallet]);
}
/** The destruction path closes admission before terminating SQL. Late admission is disposed. */
export async function fencedTransaction<T>(lane: ClientLane, work: (c: PoolClient, deadline: GridDeadline) => Promise<T>, options: FenceOptions): Promise<T> {
  const deadline = options.budget ?? new GridDeadline();
  let client: PoolClient | undefined, pid: number | undefined, released = false, cleanup: Promise<void> | undefined;
  const destroy = () => { if (client && !released) { released = true; client.release(true); } };
  const expire = () => {
    if (!cleanup) {
      deadline.closed = true; deadline.abort.abort();
      cleanup = (async () => {
        // Destroy locally even when the independent termination lane is unavailable.
        const termination = pid ? options.terminate(pid).catch(() => undefined) : Promise.resolve();
        destroy();
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([termination.then(() => options.unknown?.()), new Promise<void>(resolve => {
            cleanupTimer = setTimeout(resolve, Math.max(0, deadline.remaining()));
          })]);
        } finally { if (cleanupTimer) clearTimeout(cleanupTimer); }
      })();
    }
    return cleanup;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    // Reserve cleanup time inside, rather than after, the twenty-second envelope.
    timer = setTimeout(() => { void expire().then(() => reject(Error('GRID_TRANSACTION_UNKNOWN')), reject); }, Math.max(0, deadline.remaining() - Math.min(2_000, deadline.milliseconds / 10)));
  });
  const operation = (async () => {
    deadline.check();
    client = await lane.connect();
    if (deadline.closed) { destroy(); throw Error('GRID_TRANSACTION_UNKNOWN'); }
    // pg exposes the backend identity before the first SQL statement.
    pid = (client as PoolClient & { processID?: number }).processID;
    if (!Number.isInteger(pid)) throw Error('GRID_BACKEND_IDENTITY_MISSING');
    const raw = client;
    const guarded = new Proxy(raw, { get(target, key) {
      if (key === 'query') return (...args: unknown[]) => { deadline.check(); return (target.query as Function).apply(target, args); };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await guarded.query('BEGIN');
    await guarded.query(options.pause || options.tightening
      ? "SET LOCAL lock_timeout='8s'; SET LOCAL statement_timeout='9s'; SET LOCAL idle_in_transaction_session_timeout='12s'"
      : "SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='2s'; SET LOCAL idle_in_transaction_session_timeout='12s'");
    if (options.mode !== 'none') await hostFence(guarded, options.mode ?? 'shared');
    if (options.pause) await guarded.query("SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='1s'");
    const result = await work(guarded, deadline);
    deadline.check();
    if(options.outcome)options.outcome.commitIssued=true;
    await guarded.query('COMMIT');
    if(options.outcome)options.outcome.committed=true;
    deadline.check();
    return result;
  })();
  try { return await Promise.race([operation, expired]); }
  catch (error) {
    if (deadline.closed || deadline.remaining() <= 0) await expire();
    else if (client && !released) { try { await client.query('ROLLBACK'); if(options.outcome)options.outcome.rolledBack=true; } catch { destroy(); } }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (client && !released) { released = true; client.release(); }
  }
}
