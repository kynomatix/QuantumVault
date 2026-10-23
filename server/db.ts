import { SCHEMA_MIGRATION_MANIFEST } from "./schema-migration-manifest";
export { SCHEMA_MIGRATION_MANIFEST } from "./schema-migration-manifest";
import "./db-error-sanitize";
import { recordDatabaseCheck, recordDatabaseConnectionError } from "./database-readiness";
import { drizzle } from "drizzle-orm/node-postgres";
import pkg from "pg";
const { Pool } = pkg;
import * as schema from "@shared/schema";
import { appendTelemetry } from "./telemetry";
import { formatPoolLoadTags, registerPoolLoadTag } from "./pool-load";
import {
  applySchemaMigrationManifest,
  installSchemaReadinessSnapshot,
  probeSchemaMigrationManifest,
  registerSchemaMigrationManifest,
  reportSchemaReadiness,
  scheduleSchemaReadinessVerificationReprobe,
  type SchemaReadinessSnapshot,
} from "./schema-readiness";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

const poolSize = parseInt(process.env.DB_POOL_SIZE || "8", 10);
// Pool label for telemetry. The QuantumLab child process runs its own copy of
// this module (own pg.Pool, DB_POOL_SIZE=5) and both processes' stdout are
// interleaved in deployment logs — unlabeled "[DB Pool]" lines from the two
// pools read as one incoherent pool (2026-07-19 incident: external reviewers
// concluded max flapped between 8 and 5). The supervisor sets DB_POOL_NAME=lab.
const poolName = process.env.DB_POOL_NAME || "web";
const POOL_TAG = `[DB Pool:${poolName}]`;
// 30s default: prod (2026-07-16) showed new-connection establishment to the DB
// intermittently exceeding 10s while established connections kept working —
// a 10s acquire timeout turned every slow handshake into a failed background
// tick. 30s rides out slow establishment without masking a truly dead DB.
const connTimeoutMs = parseInt(process.env.DB_CONN_TIMEOUT_MS || "30000", 10);
// Client-side query timeout (2026-07-19 incident). The server-side
// statement_timeout below (30s) only protects while the TCP socket is alive:
// when a socket to Neon half-dies mid-query, the server's timeout error can
// never reach us, the checked-out client hangs forever, and the pool
// permanently drains ([DB Pool] total=8 idle=0 waiting=10 — only a restart
// recovered). query_timeout is enforced in-process, so it fires even on a
// dead socket; pg then releases-with-error, which DESTROYS the client and
// frees the slot → the pool self-heals. 60s is deliberately 2× the
// statement_timeout: on a healthy socket the server always wins first, so
// this can only fire on dead sockets (or ops that exempt themselves with a
// per-query `query_timeout: 0` override — see clearCandleCache).
const queryTimeoutMs = parseInt(process.env.DB_QUERY_TIMEOUT_MS || "60000", 10);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: poolSize,
  connectionTimeoutMillis: connTimeoutMs,
  query_timeout: queryTimeoutMs,
  // 60s: Neon's serverless compute suspends after ~30s of zero connections; we
  // previously evicted at 15s, meaning nearly every background-tick interval
  // paid a fresh TLS+auth handshake. Raising to 60s keeps one warm connection
  // alive across the typical 30–45s quiet gap between background scans and the
  // keep-warm heartbeat below covers the rest. The Neon idle cutoff is ~300s
  // on serverless plans, so 60s is safely below that.
  // keepAlive guards against silent TCP drops by intermediate proxies.
  idleTimeoutMillis: 60_000,
  keepAlive: true,
});

// The scanner's one batch candle-cache SELECT is availability-critical but
// historically competed with every API/monitor query for the web pool's eight
// slots. Production 2026-08-31 proved both shared-pool admission starvation
// and event-loop-delayed observation of otherwise bounded backend work. Give
// that single SELECT an independent max-1 lane in the web process. The Lab
// child never runs the scanner, so it deliberately aliases the ordinary pool
// rather than opening a useless extra database connection.
export const scannerCandlePool = poolName === "web"
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 5_000,
      query_timeout: queryTimeoutMs,
      idleTimeoutMillis: 0,
      keepAlive: true,
      application_name: "qv-scanner-candle",
    })
  : pool;
const hasDedicatedScannerCandlePool = scannerCandlePool !== pool;
const SCANNER_POOL_TAG = `[DB Pool:${poolName}:scanner-candle]`;

pool.on("error", (err) => {
  recordDatabaseConnectionError();
  console.error(`${POOL_TAG} Idle client error (suppressed crash):`, err.message);
});
if (hasDedicatedScannerCandlePool) {
  scannerCandlePool.on("error", (err) => {
    console.error(`${SCANNER_POOL_TAG} Idle client error (suppressed crash):`, err.message);
  });
}

// Safety net: no single statement may hold a pool connection indefinitely
// (pool max is 8 — a few stuck statements would starve every DB consumer).
// 30s matches the acquire timeout above. DATABASE_URL is a direct connection
// (verified non-pooler), so a session-level SET on connect is safe.
pool.on("connect", (client) => {
  // Checked-out clients can emit errors between queries; keep the process alive.
  client.on("error", (err) => {
    recordDatabaseConnectionError();
    console.error(`${POOL_TAG} Client connection error:`, err.message);
  });
  client.query("SET statement_timeout = 30000").catch((err) => {
    console.error(`${POOL_TAG} Failed to set statement_timeout:`, err.message);
  });
});
if (hasDedicatedScannerCandlePool) {
  scannerCandlePool.on("connect", (client) => {
    // Checked-out clients can emit errors between queries; keep the process alive.
    client.on("error", (err) => {
      console.error(`${SCANNER_POOL_TAG} Client connection error:`, err.message);
    });
    client.query("SET statement_timeout = 30000").catch((err) => {
      console.error(`${SCANNER_POOL_TAG} Failed to set statement_timeout:`, err.message);
    });
  });
}

// ----- keep-warm heartbeat ------------------------------------------------
// SELECT 1 every 20s keeps at least one connection alive through Neon's idle
// window so background tasks don't always pay a fresh TLS+auth handshake.
// Errors are counted (not thrown) so an unresponsive DB never causes an
// unhandled rejection; the count surfaces in the [DB Pool] telemetry line.
let _hbFailCount = 0;
let _hbFailStreak = 0;
let _scannerHbFailCount = 0;
let _scannerKeepWarmActive = false;
const activeKeepWarm = new Set<symbol>();
registerPoolLoadTag("db_maintenance", () => ({
  hb: activeKeepWarm.size,
  shb: _scannerKeepWarmActive ? 1 : 0,
}));

function claimKeepWarm(): () => void {
  const claim = Symbol();
  activeKeepWarm.add(claim);
  return () => {
    activeKeepWarm.delete(claim);
  };
}

function keepScannerCandlePoolWarm(): void {
  if (!hasDedicatedScannerCandlePool || _scannerKeepWarmActive) return;
  // idleTimeoutMillis=0 already retains a healthy idle client. Do not run a
  // periodic SELECT 1 on that max-one lane: production proved that the probe
  // can still own the only checkout when a boundary batch arrives. Only build
  // a missing physical connection, and release it immediately without SQL.
  // An idle-client transport error removes the client from pg-pool, so a later
  // cadence re-establishes it when totalCount returns to zero.
  if (scannerCandlePool.waitingCount !== 0 || scannerCandlePool.totalCount !== 0) return;

  _scannerKeepWarmActive = true;
  const startedAt = Date.now();
  scannerCandlePool.connect()
    .then((client) => {
      client.release();
      const elapsed = Date.now() - startedAt;
      // Reuse the established main-pool connect_slow threshold below.
      if (elapsed > 2_000) {
        const line = `${SCANNER_POOL_TAG} warm_connect outcome=success elapsed=${elapsed}ms`;
        console.warn(line);
        appendTelemetry(line);
      }
    })
    .catch(() => { _scannerHbFailCount++; })
    .finally(() => { _scannerKeepWarmActive = false; });
}

// Establish the dedicated lane at module initialization. The pool's bounded
// connection timeout and query timeout keep this attempt below the heartbeat
// cadence, while the active flag prevents overlap if a transport misbehaves.
keepScannerCandlePoolWarm();

setInterval(() => {
  // Serialize evidence: a slow check must not create overlapping failures.
  if (activeKeepWarm.size === 0) {
    const releaseKeepWarm = claimKeepWarm();
    pool.query("SELECT 1")
      .then(() => { _hbFailStreak = 0; recordDatabaseCheck(true); })
      .catch(() => { _hbFailCount++; _hbFailStreak++; recordDatabaseCheck(false); })
      .finally(releaseKeepWarm);
  }

  // Reuse the existing heartbeat cadence: no new timer. Re-establish only a
  // physically empty lane; a healthy idle lane is left untouched for scanner
  // work, and connection establishment never executes a maintenance query.
  keepScannerCandlePoolWarm();
}, 20_000).unref();

// ----- connect-slow visibility --------------------------------------------
// Record when the pool first has requests waiting on a new connection; the
// 'connect' event fires when the physical TCP+auth handshake finishes. The
// delta is a direct measure of Neon handshake latency (the root cause of the
// 07:31:24Z production cluster — multiple background tasks crashing because
// fresh-handshake duration exceeded their DB query timeout).
let _waitingSince: number | null = null;
setInterval(() => {
  if (pool.waitingCount > 0 && _waitingSince === null) {
    _waitingSince = Date.now();
  } else if (pool.waitingCount === 0) {
    _waitingSince = null;
  }
}, 2_000).unref();

pool.on("connect", () => {
  if (_waitingSince !== null) {
    const elapsed = Date.now() - _waitingSince;
    _waitingSince = null;
    if (elapsed > 2_000) {
      const line = `${POOL_TAG} connect_slow elapsed=${elapsed}ms`;
      console.warn(line);
      appendTelemetry(line);
    }
  }
});

// ----- pool telemetry (30s) -----------------------------------------------
// Starvation → error_log visibility (2026-07-19 incident): a wedged pool made
// the whole app unusable while /api/logs/summary reported errorStats:[] —
// external monitors were structurally blind because infra failures never
// reached error_log (and the noise denylist there intentionally drops raw
// "connection timeout" chatter). Record ONE deduped row when the pool has
// been starved (all clients out + waiters queued) for 60s+, or the keep-warm
// heartbeat has failed 3+ times in a row. Lazy import avoids a boot-time
// import cycle (error-log → storage → db). Wording deliberately avoids the
// error-log noise patterns.
let _starvedSince: number | null = null;
let _lastInfraRecordAt = 0;
const INFRA_RECORD_COOLDOWN_MS = 10 * 60 * 1000;
setInterval(() => {
  const hbPart = _hbFailCount > 0 ? ` hb_fail=${_hbFailCount}` : "";
  const scannerHbPart = _scannerHbFailCount > 0 ? ` scanner_hb_fail=${_scannerHbFailCount}` : "";
  _hbFailCount = 0; // reset window counter after each log
  _scannerHbFailCount = 0;
  const scannerPart = hasDedicatedScannerCandlePool
    ? ` scanner=${scannerCandlePool.totalCount}/${scannerCandlePool.idleCount}i/${scannerCandlePool.waitingCount}w/1max`
    : "";
  const dbLine = `${POOL_TAG} total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount} max=${poolSize}${hbPart}${scannerHbPart}${scannerPart}${formatPoolLoadTags()}`;
  console.log(dbLine);
  appendTelemetry(dbLine);

  const starved = pool.totalCount >= poolSize && pool.idleCount === 0 && pool.waitingCount > 0;
  if (!starved) {
    _starvedSince = null;
  } else if (_starvedSince === null) {
    _starvedSince = Date.now();
  }
  const starvedForMs = _starvedSince === null ? 0 : Date.now() - _starvedSince;
  const shouldRecord =
    (starvedForMs >= 60_000 || _hbFailStreak >= 3) &&
    Date.now() - _lastInfraRecordAt >= INFRA_RECORD_COOLDOWN_MS;
  if (shouldRecord) {
    _lastInfraRecordAt = Date.now();
    const msg = starvedForMs >= 60_000
      ? `${POOL_TAG} starved for ${Math.round(starvedForMs / 1000)}s: all ${poolSize} clients checked out, ${pool.waitingCount} waiting — API reads are failing`
      : `${POOL_TAG} keep-warm heartbeat failed ${_hbFailStreak} times in a row — database unreachable or pool wedged`;
    import("./error-log")
      .then(({ recordCriticalError }) => {
        recordCriticalError({
          category: "server_500",
          severity: "critical",
          source: "db-pool",
          message: msg,
          fingerprint: "db-pool-starvation",
          context: {
            total: pool.totalCount,
            idle: pool.idleCount,
            waiting: pool.waitingCount,
            max: poolSize,
            hbFailStreak: _hbFailStreak,
            starvedForMs,
          },
        });
      })
      .catch(() => {}); // visibility must never break the pool path
  }
}, 30_000);

// ----- shared connection-class error classifier ---------------------------
// Used by background tasks to distinguish Neon handshake/timeout failures
// (safe to retry once) from query/constraint errors (must not retry).
export function isConnectionClassError(err: any): boolean {
  const msg = (err?.message || "") as string;
  return (
    msg.includes("Authentication timed out") ||
    msg.includes("connection timeout") ||
    msg.includes("Connection terminated") ||
    msg.includes("timeout exceeded") ||
    msg.includes("too many clients") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT")
  );
}

// ----- lower-tier pool pressure incident (5s sampler) ----------------------
// 2026-07-20 incident follow-up: the critical starvation row above needs 60s
// of sustained full starvation, and the 30s snapshot cadence never captured
// waitingCount > 0 — so a sweep that pinned the pool for "only" tens of
// seconds left zero formal evidence. This faster sampler records ONE deduped
// lower-tier row when the pool shows pressure (any waiter queued, or all
// clients checked out with zero idle) sustained for 10s+. It reads counters
// only — no DB traffic. Wording deliberately avoids the error-log noise
// denylist patterns (never says "connection timeout").
let _pressureSince: number | null = null;
let _lastPressureRecordAt = 0;
const PRESSURE_SUSTAIN_MS = 10_000;
const PRESSURE_RECORD_COOLDOWN_MS = 10 * 60 * 1000;
setInterval(() => {
  const pressured =
    pool.waitingCount > 0 || (pool.totalCount >= poolSize && pool.idleCount === 0);
  if (!pressured) {
    _pressureSince = null;
    return;
  }
  if (_pressureSince === null) _pressureSince = Date.now();
  const pressuredForMs = Date.now() - _pressureSince;
  if (
    pressuredForMs >= PRESSURE_SUSTAIN_MS &&
    Date.now() - _lastPressureRecordAt >= PRESSURE_RECORD_COOLDOWN_MS
  ) {
    _lastPressureRecordAt = Date.now();
    const workload = formatPoolLoadTags().trim();
    const msg =
      `${POOL_TAG} pressure sustained ${Math.round(pressuredForMs / 1000)}s: ` +
      `${pool.waitingCount} waiting, ${pool.idleCount} idle of ${pool.totalCount}/${poolSize} clients` +
      (workload ? ` — workload ${workload}` : "");
    const line = `${msg}`;
    console.warn(line);
    appendTelemetry(line);
    import("./error-log")
      .then(({ recordCriticalError }) => {
        recordCriticalError({
          category: "server_500",
          severity: "error", // lower tier — the 60s starvation row above stays "critical"
          source: "db-pool",
          message: msg,
          fingerprint: "db-pool-pressure",
          context: {
            total: pool.totalCount,
            idle: pool.idleCount,
            waiting: pool.waitingCount,
            max: poolSize,
            pressuredForMs,
            workloadTags: workload,
          },
        });
      })
      .catch(() => {}); // visibility must never break the pool path
  }
}, 5_000).unref();

// ----- boot-time pool headroom gate -----------------------------------------
// 2026-07-19 incident: the staggered-startup jobs in server/index.ts all landed
// on the pool inside one ~45s window while Neon handshakes were slow; the pool
// hit total=8 idle=0 waiting=19 and every job (plus all dashboard API reads)
// failed on acquire timeouts. A fixed stagger cannot survive a slow-handshake
// day, so deferrable boot work polls this gate first: it resolves when the pool
// has genuine headroom (no waiters AND a free slot), or after maxWaitMs so a
// persistently busy pool can never postpone a job forever.
export async function whenPoolHasHeadroom(maxWaitMs = 180_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    const hasHeadroom =
      pool.waitingCount === 0 && (pool.idleCount > 0 || pool.totalCount < poolSize);
    if (hasHeadroom) return;
    if (Date.now() - started >= maxWaitMs) {
      console.warn(
        `${POOL_TAG} headroom gate timed out after ${Math.round((Date.now() - started) / 1000)}s (total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}) — proceeding anyway`
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

// ----- serialized boot-work coordinator -------------------------------------
// 2026-07-20 incident follow-up: whenPoolHasHeadroom() is a point-in-time
// check — it does not RESERVE capacity, so several deferred boot jobs could
// all observe headroom in the same instant and land on the pool together
// (scanner catch-up ~+200s, stats monitor ~+195s, portfolio backfill ~+240s,
// error prune ~+300s). This coordinator serializes the heavy INITIAL runs:
// at most ONE boot job executes at a time, each re-checking headroom right
// before it starts. Steady-state/interval reruns and boundary sweeps are
// deliberately NOT routed through it — it exists only to flatten the boot
// collision window. Jobs may pass maxWaitMs to be SKIPPED (never run) if the
// slot doesn't free up in time — used by the scanner boot catch-up, which is
// worthless once the next boundary sweep is imminent anyway.
let _bootWorkTail: Promise<void> = Promise.resolve();
export function runSerializedBootWork(
  tag: string,
  fn: () => Promise<void>,
  opts?: { maxWaitMs?: number }
): Promise<{ ran: boolean }> {
  return new Promise<{ ran: boolean }>((resolveOuter) => {
    let skipped = false;
    let timer: NodeJS.Timeout | null = null;
    if (opts?.maxWaitMs && Number.isFinite(opts.maxWaitMs) && opts.maxWaitMs > 0) {
      timer = setTimeout(() => {
        skipped = true;
        console.warn(
          `${POOL_TAG} boot-work "${tag}" skipped — slot not free within ${Math.round(
            opts.maxWaitMs! / 1000
          )}s`
        );
        resolveOuter({ ran: false });
      }, opts.maxWaitMs);
      timer.unref?.();
    }
    _bootWorkTail = _bootWorkTail.then(async () => {
      if (skipped) return;
      await whenPoolHasHeadroom();
      if (skipped) return; // budget expired during the headroom wait
      if (timer) clearTimeout(timer);
      const started = Date.now();
      console.log(`${POOL_TAG} boot-work "${tag}" starting`);
      try {
        await fn();
      } catch (err: any) {
        // A failed boot job must never wedge the chain for the jobs behind it.
        console.error(`${POOL_TAG} boot-work "${tag}" failed:`, err?.message ?? err);
      }
      console.log(
        `${POOL_TAG} boot-work "${tag}" done in ${Math.round((Date.now() - started) / 1000)}s`
      );
      resolveOuter({ ran: true });
    });
  });
}

export const db = drizzle(pool, { schema });
// Drizzle 0.39.3 issues BEGIN before its pooled-session release finally.
// Own the lease here; a client-bound session neither acquires nor releases it.
const runPooledTransaction: typeof db.transaction = async (transaction, config) => {
  const client = await pool.connect();
  let discardClient = false;
  try {
    return await drizzle(client, { schema }).transaction(transaction, config);
  } catch (error) {
    discardClient = true;
    throw error;
  } finally {
    client.release(discardClient);
  }
};
db.transaction = runPooledTransaction;
/** @internal — exported for standalone analysis scripts only; do not import from production code paths. */
export { pool };

export async function closePool(): Promise<void> {
  if (hasDedicatedScannerCandlePool) {
    await Promise.all([pool.end(), scannerCandlePool.end()]);
    return;
  }
  await pool.end();
}
registerSchemaMigrationManifest(SCHEMA_MIGRATION_MANIFEST);

export async function ensureSchema(): Promise<SchemaReadinessSnapshot> {
  const client = await pool.connect();
  try {
    const snapshot = await applySchemaMigrationManifest(
      async (text, values) => {
        const result = await client.query(text, values ? [...values] : undefined);
        return { rows: result.rows as readonly Record<string, unknown>[] };
      },
      SCHEMA_MIGRATION_MANIFEST,
    );
    installSchemaReadinessSnapshot(snapshot);
    scheduleSchemaReadinessVerificationReprobe(snapshot, async () => {
      const reprobeClient = await pool.connect();
      try {
        return await probeSchemaMigrationManifest(
          async (text, values) => {
            const result = await reprobeClient.query(text, values ? [...values] : undefined);
            return { rows: result.rows as readonly Record<string, unknown>[] };
          },
          SCHEMA_MIGRATION_MANIFEST,
        );
      } finally {
        reprobeClient.release();
      }
    });
    await reportSchemaReadiness(snapshot);
    if (snapshot.unavailableCapabilities.length === 0) {
      console.log("[DB] Schema check complete");
    } else {
      console.warn(`[DB] Schema readiness unavailable capabilities=${snapshot.unavailableCapabilities.join(",")}`);
    }
    return snapshot;
  } finally {
    client.release();
  }
}


/**
 * V3 Phase 0 startup health-check.
 *
 * Once any wallet row has been re-keyed to umk_version >= 3, the server MUST
 * have a valid UMK_STORAGE_SECRET configured or those users will be unable to
 * decrypt their UMK at all. Fail fast at startup rather than at first login.
 *
 * On a fresh DB (no v3 rows yet) the check is a no-op so the very first deploy
 * of Phase 0 doesn't refuse to boot before any user has signed in.
 */
export async function checkUmkStorageSecretHealth(): Promise<void> {
  // Strict, shared validator — matches the runtime v3 storage-key derivation
  // exactly (regex + hex decode + 32-byte length check). Never accept a
  // weaker definition of "configured" here than the crypto code uses.
  const { isUmkStorageSecretValid } = await import('./session-v3');
  const { storage } = await import('./storage');
  const secretOk = isUmkStorageSecretValid();

  // Fail-CLOSED. If the DB lookup can't be completed we cannot prove the
  // safety invariant (no v3 rows without a valid secret), so we refuse to
  // boot rather than risk silently locking re-keyed users out of their UMK.
  // The previous fail-open path was a high-severity gap flagged in review.
  // Delegated to the IStorage method so the check and any future
  // operator-facing surface (e.g. /admin/umk-status) cannot drift apart.
  let hasV3: boolean;
  try {
    hasV3 = await storage.hasAnyUmkV3OrAbove();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      '[Startup] FATAL: UMK health check could not query wallets table: ' +
      msg +
      '. Refusing to boot - cannot prove UMK_STORAGE_SECRET safety invariant.'
    );
  }

  if (hasV3 && !secretOk) {
    throw new Error(
      '[Startup] FATAL: UMK_STORAGE_SECRET is missing or malformed but at least one wallet ' +
      'has umk_version >= 3. Refusing to boot - users would lose UMK access. ' +
      'Set UMK_STORAGE_SECRET to the original 64-hex value used at re-keying.'
    );
  }

  if (secretOk) {
    console.log(`[Startup] UMK_STORAGE_SECRET configured (v3 rows present: ${hasV3 ? 'yes' : 'no'})`);
  } else {
    console.warn('[Startup] UMK_STORAGE_SECRET not configured. Safe for now (no v3 rows), but Phase 0 will require it once any wallet signs in.');
  }
}

/**
 * V3 Phase 1 startup config summary.
 *
 * One-shot INFO log summarizing the encryption-key configuration surface so
 * operators can spot config drift between dev / staging / prod at a glance.
 * Reports presence (never values) of the three security env vars and the
 * presence of every V3-related wallet column. Prints once per boot, right
 * after the UMK health check.
 *
 * Intentionally read-only and side-effect-free beyond the log line.
 */
export async function logSecurityConfigSummary(): Promise<void> {
  const envPresence = {
    AGENT_ENCRYPTION_KEY: Boolean(process.env.AGENT_ENCRYPTION_KEY),
    UMK_STORAGE_SECRET: Boolean(process.env.UMK_STORAGE_SECRET),
    SERVER_EXECUTION_KEY: Boolean(process.env.SERVER_EXECUTION_KEY),
  };

  // Inspect the live `wallets` schema rather than trusting the ORM definition,
  // so a column that was dropped/renamed in production but still referenced
  // in code is surfaced loudly here at boot.
  const client = await pool.connect();
  let columns: string[] = [];
  try {
    const result = await client.query<{ column_name: string }>(`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'wallets'
         AND column_name IN (
           'agent_private_key_encrypted',
           'agent_private_key_encrypted_v3',
           'encrypted_user_master_key',
           'encrypted_mnemonic_words',
           'umk_encrypted_for_execution',
           'umk_version',
           'user_salt',
           'execution_enabled'
         )
    `);
    columns = result.rows.map(r => r.column_name).sort();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[Startup][SecurityConfig] Could not inspect wallets schema: ' + msg);
  } finally {
    client.release();
  }

  console.log(
    '[Startup][SecurityConfig] envVars=' + JSON.stringify(envPresence) +
    ' walletColumns=' + JSON.stringify(columns)
  );
}
