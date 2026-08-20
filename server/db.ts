import { drizzle } from "drizzle-orm/node-postgres";
import pkg from "pg";
const { Pool } = pkg;
import * as schema from "@shared/schema";
import { appendTelemetry } from "./telemetry";
import { formatPoolLoadTags, registerPoolLoadTag } from "./pool-load";
import {
  applySchemaMigrationManifest,
  installSchemaReadinessSnapshot,
  registerSchemaMigrationManifest,
  reportSchemaReadiness,
  type SchemaMigrationDefinition,
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

pool.on("error", (err) => {
  console.error(`${POOL_TAG} Idle client error (suppressed crash):`, err.message);
});

// Safety net: no single statement may hold a pool connection indefinitely
// (pool max is 8 — a few stuck statements would starve every DB consumer).
// 30s matches the acquire timeout above. DATABASE_URL is a direct connection
// (verified non-pooler), so a session-level SET on connect is safe.
pool.on("connect", (client) => {
  client.query("SET statement_timeout = 30000").catch((err) => {
    console.error(`${POOL_TAG} Failed to set statement_timeout:`, err.message);
  });
});

// ----- keep-warm heartbeat ------------------------------------------------
// SELECT 1 every 20s keeps at least one connection alive through Neon's idle
// window so background tasks don't always pay a fresh TLS+auth handshake.
// Errors are counted (not thrown) so an unresponsive DB never causes an
// unhandled rejection; the count surfaces in the [DB Pool] telemetry line.
let _hbFailCount = 0;
let _hbFailStreak = 0;
const activeKeepWarm = new Set<symbol>();
registerPoolLoadTag("db_maintenance", () => ({ hb: activeKeepWarm.size }));

function claimKeepWarm(): () => void {
  const claim = Symbol();
  activeKeepWarm.add(claim);
  return () => {
    activeKeepWarm.delete(claim);
  };
}

setInterval(() => {
  const releaseKeepWarm = claimKeepWarm();
  pool.query("SELECT 1")
    .then(() => { _hbFailStreak = 0; })
    .catch(() => { _hbFailCount++; _hbFailStreak++; })
    .finally(releaseKeepWarm);
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
  _hbFailCount = 0; // reset window counter after each log
  const dbLine = `${POOL_TAG} total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount} max=${poolSize}${hbPart}${formatPoolLoadTags()}`;
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
/** @internal — exported for standalone analysis scripts only; do not import from production code paths. */
export { pool };

export async function closePool(): Promise<void> {
  await pool.end();
}
const schemaMigrationSql = [
      `CREATE TABLE IF NOT EXISTS lab_candle_cache_v2 (
        id serial PRIMARY KEY,
        symbol text NOT NULL,
        timeframe text NOT NULL,
        time numeric(20,0) NOT NULL,
        open real NOT NULL,
        high real NOT NULL,
        low real NOT NULL,
        close real NOT NULL,
        volume real NOT NULL,
        source text NOT NULL CHECK (source IN ('okx', 'gate', 'pyth', 'unknown')),
        venue text NOT NULL CHECK (venue IN ('okx', 'gate', 'none', 'unknown')),
        basis text NOT NULL CHECK (basis IN ('perp', 'spot', 'index', 'unknown')),
        proxy text NOT NULL CHECK (proxy IN ('direct', 'proxy', 'unknown')),
        finality text NOT NULL CHECK (finality IN ('finalized', 'forming', 'unknown')),
        time_semantic text NOT NULL CHECK (time_semantic IN ('open_time', 'unknown'))
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS lab_candle_cache_v2_identity_unique
         ON lab_candle_cache_v2
         (symbol, timeframe, time, source, venue, basis, proxy, finality, time_semantic)`,
      `CREATE INDEX IF NOT EXISTS lab_candle_cache_v2_lookup
         ON lab_candle_cache_v2
         (symbol, timeframe, basis, finality, proxy, time)`,
      `ALTER TABLE lab_optimization_runs ADD COLUMN IF NOT EXISTS queue_order integer`,
      `ALTER TABLE lab_optimization_runs ADD COLUMN IF NOT EXISTS config_snapshot jsonb`,
      `CREATE TABLE IF NOT EXISTS ai_trader_execution_events (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        event_identity text NOT NULL UNIQUE,
        attempt_id text NOT NULL,
        bot_id varchar NOT NULL,
        decision_id varchar,
        action text NOT NULL CHECK (action IN ('entry','close','cancel')),
        cause text NOT NULL CHECK (cause IN ('decision','paper','emergency_unwind','protective','user_requested','venue_detected','unconfirmed_orphan','startup_orphan','pre_close_bracket','survivor_leg')),
        event_type text NOT NULL,
        phase smallint,
        protocol text NOT NULL,
        account_scope text NOT NULL CHECK (account_scope IN ('main','bot_subaccount','unknown')),
        account_ref text,
        market text NOT NULL,
        side text CHECK (side IS NULL OR side IN ('long','short')),
        client_order_id text,
        venue_order_id text,
        transaction_signature text,
        venue_status text CHECK (venue_status IS NULL OR venue_status IN ('submitted','acknowledged','filled','partial_fill','canceled','expired','rejected','unknown')),
        price numeric(30,12) CHECK (price IS NULL OR price <> 'NaN'::numeric),
        size_base numeric(30,12) CHECK (size_base IS NULL OR (size_base >= 0 AND size_base <> 'NaN'::numeric)),
        fee numeric(30,12) CHECK (fee IS NULL OR (fee >= 0 AND fee <> 'NaN'::numeric)),
        realized_pnl numeric(30,12) CHECK (realized_pnl IS NULL OR realized_pnl <> 'NaN'::numeric),
        failure_code text CHECK (failure_code IS NULL OR failure_code IN ('venue_rejected','venue_unconfirmed','venue_error','identity_mismatch','signing_unavailable','position_not_confirmed','bracket_failed','unknown')),
        recorded_after_broadcast boolean NOT NULL DEFAULT false,
        observed_at timestamp NOT NULL,
        recorded_at timestamp NOT NULL DEFAULT now(),
        CONSTRAINT ai_trader_execution_phase_check CHECK (
          (event_type = 'attempt_claimed' AND phase = 0) OR
          (event_type = 'prebroadcast_authorized' AND action = 'entry' AND phase = 10) OR
          (event_type = 'broadcast_attempted' AND action IN ('close','cancel') AND phase = 10) OR
          (event_type = 'broadcast_result' AND phase = 20) OR
          (event_type IN ('position_observed','fill_observed','bracket_verified','reconciliation_observed') AND phase IS NULL) OR
          (event_type IN ('entry_terminal_open','entry_terminal_no_land','entry_terminal_unwound') AND action = 'entry' AND phase = 90) OR
          (event_type IN ('close_terminal_confirmed','close_terminal_failed') AND action = 'close' AND phase = 90) OR
          (event_type IN ('cancel_terminal_confirmed','cancel_terminal_failed') AND action = 'cancel' AND phase = 90)
        )
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ai_trader_execution_attempt ON ai_trader_execution_events (attempt_id, phase, observed_at, id)`,
      `CREATE INDEX IF NOT EXISTS idx_ai_trader_execution_bot ON ai_trader_execution_events (bot_id, recorded_at DESC, id DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_ai_trader_execution_decision ON ai_trader_execution_events (decision_id, recorded_at, id)`,
      `CREATE OR REPLACE FUNCTION qv_reject_ai_trader_execution_event_mutation()
        RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          RAISE EXCEPTION 'ai_trader_execution_events is append-only';
        END $$`,
      `DO $$ BEGIN
         CREATE TRIGGER ai_trader_execution_events_append_only
           BEFORE UPDATE OR DELETE ON ai_trader_execution_events
           FOR EACH ROW EXECUTE FUNCTION qv_reject_ai_trader_execution_event_mutation();
       EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
      `CREATE TABLE IF NOT EXISTS platform_cumulative_stats (
        id text PRIMARY KEY DEFAULT 'singleton',
        cumulative_volume numeric(20,2) NOT NULL DEFAULT 0,
        cumulative_trades integer NOT NULL DEFAULT 0,
        updated_at timestamp DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_lab_opt_runs_user_status ON lab_optimization_runs (user_id, status, id)`,
      `CREATE INDEX IF NOT EXISTS idx_lab_opt_results_run_id ON lab_optimization_results (run_id)`,

      // --- Phase 7 / Item 12g: per-bot subaccount auth mode (Drift-blocker). ---
      // Idempotent: safe to run on fresh DB, partially-migrated DB, or fully-migrated DB.
      // Backfill rule (one-time historical reconstruction): a bot with a stored
      // subaccount keypair (bot_subaccount_key_encrypted IS NOT NULL) was using
      // external_key auth (Pacifica-style); everything else used main_plus_id (Drift-style).
      `ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS subaccount_auth_mode text`,
      `UPDATE trading_bots SET subaccount_auth_mode = 'external_key'
         WHERE subaccount_auth_mode IS NULL AND bot_subaccount_key_encrypted IS NOT NULL`,
      `UPDATE trading_bots SET subaccount_auth_mode = 'main_plus_id'
         WHERE subaccount_auth_mode IS NULL`,
      `DO $$ BEGIN
         ALTER TABLE trading_bots ADD CONSTRAINT trading_bots_subaccount_auth_mode_check
           CHECK (subaccount_auth_mode IN ('external_key', 'main_plus_id'));
       EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
      `DO $$ BEGIN
         ALTER TABLE trading_bots ADD CONSTRAINT trading_bots_external_key_invariant
           CHECK (
             NOT (subaccount_auth_mode = 'external_key' AND subaccount_status = 'active')
             OR (protocol_subaccount_id IS NOT NULL AND bot_subaccount_key_encrypted IS NOT NULL)
           );
       EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
      `ALTER TABLE trading_bots ALTER COLUMN subaccount_auth_mode SET NOT NULL`,

      // --- Phase 4b (Task 99): per-bot subaccount key V3 encryption column. ---
      // Idempotent. Adds the v3 column and relaxes the external-key invariant
      // so it accepts either the legacy or v3 ciphertext. Login backfills any
      // legacy-only rows on the owner's next sign-in.
      `ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS bot_subaccount_key_encrypted_v3 text`,
      `DO $$ BEGIN
         ALTER TABLE trading_bots DROP CONSTRAINT IF EXISTS trading_bots_external_key_invariant;
         ALTER TABLE trading_bots ADD CONSTRAINT trading_bots_external_key_invariant
           CHECK (
             NOT (subaccount_auth_mode = 'external_key' AND subaccount_status = 'active')
             OR (
               protocol_subaccount_id IS NOT NULL
               AND (bot_subaccount_key_encrypted IS NOT NULL OR bot_subaccount_key_encrypted_v3 IS NOT NULL)
             )
           );
       END $$`,

      // --- Phase 7 / Group D item 18: formalize active_protocol allowed values. ---
      // Idempotent: safe to run on fresh DB, partially-migrated DB, or fully-migrated DB.
      // Backfill rule (one-time historical reconstruction): the only NULL rows in
      // production today are the dormant pre-adapter Drift bots described in item 12d
      // (legacy bots with no Pacifica subaccount and no migrated collateral; they
      // cannot be re-pointed to Pacifica). They are by definition Drift. New bots
      // always set active_protocol explicitly at creation (item 18 fixed the four
      // insert sites in routes.ts). After backfill, the column is constrained to
      // ('pacifica', 'drift') and made NOT NULL — this lets `getAdapterForBot()`
      // drop its warn-logging null fallback (removed in the item-18 closeout commit).
      //
      // ATOMICITY: the three steps (UPDATE → ADD CONSTRAINT → SET NOT NULL) are
      // wrapped in a single PL/pgSQL DO block so they execute in one transaction.
      // Without this, a concurrent writer (e.g. an old instance during rolling
      // deploy) could insert a NULL row between the UPDATE and the SET NOT NULL,
      // causing the latter to fail and leaving the schema partially tightened.
      // The inner BEGIN/EXCEPTION handles the duplicate-constraint case on re-run.
      `DO $$ BEGIN
         UPDATE trading_bots SET active_protocol = 'drift' WHERE active_protocol IS NULL;
         BEGIN
           ALTER TABLE trading_bots ADD CONSTRAINT trading_bots_active_protocol_check
             CHECK (active_protocol IN ('pacifica', 'drift'));
         EXCEPTION WHEN duplicate_object THEN NULL; END;
         ALTER TABLE trading_bots ALTER COLUMN active_protocol SET NOT NULL;
       END $$`,

      // --- Clone the two native-engine community strategies (SBR v1 and
      // Adaptive Regime V3.8) from the BuhE wallet to the AqTT wallet.
      // Idempotent: NOT EXISTS guard means re-running is a no-op once the
      // AqTT-owned copies are present. Copies share Pine source, parsed
      // inputs, groups, and strategy_settings (including nativeEngine=true),
      // so the AqTT copies route through the same native engine path as
      // the originals.
      // --- MLM referral chain & rewards (Task 70) ---
      `CREATE TABLE IF NOT EXISTS referral_links (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        descendant_wallet text NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
        ancestor_wallet text NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
        level integer NOT NULL,
        created_at timestamp NOT NULL DEFAULT now(),
        CONSTRAINT referral_links_descendant_level_unique UNIQUE (descendant_wallet, level),
        CONSTRAINT referral_links_no_self CHECK (descendant_wallet <> ancestor_wallet),
        CONSTRAINT referral_links_level_range CHECK (level BETWEEN 1 AND 3)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_referral_links_ancestor ON referral_links (ancestor_wallet)`,
      `CREATE INDEX IF NOT EXISTS idx_referral_links_descendant ON referral_links (descendant_wallet)`,
      `CREATE TABLE IF NOT EXISTS referral_reward_events (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        source_type text NOT NULL,
        source_id text NOT NULL,
        earner_wallet text NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
        referee_wallet text NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
        level integer NOT NULL,
        amount_usdc numeric(20, 6) NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        created_at timestamp NOT NULL DEFAULT now(),
        CONSTRAINT referral_reward_events_unique UNIQUE (source_type, source_id, earner_wallet, level),
        CONSTRAINT referral_reward_events_level_range CHECK (level BETWEEN 1 AND 3),
        CONSTRAINT referral_reward_events_status_valid CHECK (status IN ('pending','confirmed','paid','failed'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_referral_reward_events_earner ON referral_reward_events (earner_wallet)`,
      `DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'referral_reward_events_status_valid'
        ) THEN
          ALTER TABLE referral_reward_events
            ADD CONSTRAINT referral_reward_events_status_valid
            CHECK (status IN ('pending','confirmed','paid','failed','processing','voided'));
        ELSE
          ALTER TABLE referral_reward_events
            DROP CONSTRAINT referral_reward_events_status_valid;
          ALTER TABLE referral_reward_events
            ADD CONSTRAINT referral_reward_events_status_valid
            CHECK (status IN ('pending','confirmed','paid','failed','processing','voided'));
        END IF;
      END $$;`,
      `ALTER TABLE referral_reward_events ADD COLUMN IF NOT EXISTS funding_wallet text`,
      `ALTER TABLE referral_reward_events ADD COLUMN IF NOT EXISTS transfer_signature text`,
      `ALTER TABLE referral_reward_events ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0`,
      `ALTER TABLE referral_reward_events ADD COLUMN IF NOT EXISTS last_error text`,
      `ALTER TABLE referral_reward_events ADD COLUMN IF NOT EXISTS last_attempt_at timestamp`,
      `CREATE INDEX IF NOT EXISTS idx_referral_reward_events_status_created ON referral_reward_events (status, created_at)`,
      // Backfill: existing wallets.referred_by -> referral_links level 1 (and L2/L3 if resolvable),
      // skipping rows that already exist. Idempotent.
      `INSERT INTO referral_links (descendant_wallet, ancestor_wallet, level)
       SELECT w.address, w.referred_by, 1
         FROM wallets w
        WHERE w.referred_by IS NOT NULL
          AND w.referred_by <> w.address
          AND EXISTS (SELECT 1 FROM wallets a WHERE a.address = w.referred_by)
       ON CONFLICT (descendant_wallet, level) DO NOTHING`,
      `INSERT INTO referral_links (descendant_wallet, ancestor_wallet, level)
       SELECT w.address, w2.referred_by, 2
         FROM wallets w
         JOIN wallets w2 ON w2.address = w.referred_by
        WHERE w2.referred_by IS NOT NULL
          AND w2.referred_by <> w.address
          AND EXISTS (SELECT 1 FROM wallets a WHERE a.address = w2.referred_by)
       ON CONFLICT (descendant_wallet, level) DO NOTHING`,
      `INSERT INTO referral_links (descendant_wallet, ancestor_wallet, level)
       SELECT w.address, w3.referred_by, 3
         FROM wallets w
         JOIN wallets w2 ON w2.address = w.referred_by
         JOIN wallets w3 ON w3.address = w2.referred_by
        WHERE w3.referred_by IS NOT NULL
          AND w3.referred_by <> w.address
          AND EXISTS (SELECT 1 FROM wallets a WHERE a.address = w3.referred_by)
       ON CONFLICT (descendant_wallet, level) DO NOTHING`,

      // --- Task 119: portfolio P&L correctness ---
      // Add on-chain block time to equity_events so the reconciler can
      // attribute late-discovered deposits to when they actually happened.
      `ALTER TABLE equity_events ADD COLUMN IF NOT EXISTS tx_block_time timestamp`,
      // Add trading-P&L fields to portfolio_daily_snapshots. All columns are
      // additive with safe defaults so this migration is reversible and
      // backwards-compatible with the existing reader.
      `ALTER TABLE portfolio_daily_snapshots ADD COLUMN IF NOT EXISTS cumulative_external_deposits numeric(20,6) NOT NULL DEFAULT 0`,
      `ALTER TABLE portfolio_daily_snapshots ADD COLUMN IF NOT EXISTS cumulative_external_withdrawals numeric(20,6) NOT NULL DEFAULT 0`,
      `ALTER TABLE portfolio_daily_snapshots ADD COLUMN IF NOT EXISTS cumulative_internal_transfers numeric(20,6) NOT NULL DEFAULT 0`,
      `ALTER TABLE portfolio_daily_snapshots ADD COLUMN IF NOT EXISTS cumulative_trading_pnl numeric(20,6) NOT NULL DEFAULT 0`,
      `ALTER TABLE portfolio_daily_snapshots ADD COLUMN IF NOT EXISTS net_external_flow numeric(20,6) NOT NULL DEFAULT 0`,
      `ALTER TABLE portfolio_daily_snapshots ADD COLUMN IF NOT EXISTS pnl_percent numeric(12,6) NOT NULL DEFAULT 0`,

      // --- Task 129: Telegram daily summary opt-in toggle + idempotency marker ---
      `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS daily_summary_enabled boolean NOT NULL DEFAULT false`,
      `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS daily_summary_last_sent_date text`,

      // --- Task 143: Pacifica Builder Code & Referral idempotency flags ---
      // Idempotent ALTERs. Default false so existing rows are migrated lazily on
      // the next trade (the adapter's ensurePacificaEnrollment hook fires).
      `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS pacifica_builder_approved boolean NOT NULL DEFAULT false`,
      `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS pacifica_referral_claimed boolean NOT NULL DEFAULT false`,

      // --- Task 201: hands-off auto-mode admin whitelist (additive, idempotent). ---
      // Default false → every wallet starts in watched mode; an admin flips it on.
      `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS hands_off_approved boolean NOT NULL DEFAULT false`,

      // --- Task 149: per-bot Pacifica enrollment flags ---
      // Phase 4b bots are their own Pacifica main accounts (keypair behind
      // bot_subaccount_key_encrypted_v3, pubkey in protocol_subaccount_id),
      // so enrollment must be tracked per-bot. Mirrors the wallets flags
      // above. Default false → migrated lazily on the bot's next trade.
      `ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS pacifica_builder_approved boolean NOT NULL DEFAULT false`,
      `ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS pacifica_referral_claimed boolean NOT NULL DEFAULT false`,

      // Auto-repark idle funds (Task: per-bot persistent setting + server-managed
      // debounce deadline). Additive + idempotent. auto_park_idle defaults OFF;
      // auto_park_due_at is set when a position fully closes and cleared on open,
      // then consumed by the periodic repark scanner. See server/vault/auto-repark.ts.
      `ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS auto_park_idle boolean NOT NULL DEFAULT false`,
      `ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS auto_park_due_at timestamp`,

      // Per-bot park DESTINATION (Task: persisted picker + migrate-on-save). Additive +
      // idempotent. NULL = legacy inference. When set on a Flash bot the auto-repark
      // executor treats it as authoritative and migrates parked funds into it.
      `ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS park_destination_asset text`,
      // On-open unpark mode (Flash vaults). Defaults TRUE = all-out (safest): existing
      // auto-park bots become full-buffer-on-open automatically. Additive + idempotent.
      `ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS vault_all_out boolean NOT NULL DEFAULT true`,

      // Defend-the-loan auto collateral top-up (Task: opt-in per-bot setting). Additive +
      // idempotent. Defaults OFF → the scanner never tops up a loan the user didn't opt in.
      // See server/vault/jupiter-lend-perbot-carve.ts (runPerbotCollateralTopUp).
      `ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS auto_collateral_top_up boolean NOT NULL DEFAULT false`,

      // Defend-the-loan auto repay (opt-in per-bot setting). Additive + idempotent.
      // Defaults OFF → the scanner never repays a loan the user didn't opt in.
      // See server/vault/auto-topup.ts (decideAutoRepay).
      `ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS auto_repay_enabled boolean NOT NULL DEFAULT false`,

      // --- Phase 4b (Flash agent-HD wallets): recoverable per-bot wallet indices. ---
      // Additive + idempotent. The allocator lives on `wallets` (burn-on-allocate,
      // never reused). Each agent_hd bot stores its non-secret HD index + path version;
      // legacy random bots leave both NULL. DB-level CHECK/UNIQUE are the real fund-safety
      // enforcement so a manual or buggy write can never commingle two bots on one wallet.
      `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS next_bot_derivation_index integer NOT NULL DEFAULT 1`,
      // Orphan slots verified empty (swept or live-bot drift) — excluded from the
      // stranded-funds indicator so the recovery button clears once nothing remains.
      `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS recovered_orphan_indices integer[] NOT NULL DEFAULT '{}'`,

      // QuantumLab AI Strategy Creator (Task 187): BYO OpenRouter key, V3-encrypted
      // (UMK-wrapped only, interactive-only). Additive + idempotent. Plaintext is
      // never stored; only the ciphertext, a display-only last4, provider, and mtime.
      `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS llm_api_key_encrypted text`,
      `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS llm_api_key_last4 text`,
      `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS llm_api_key_provider text`,
      `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS llm_api_key_updated_at timestamp`,

      // Vaults Phase 0a: account-level manual park/unpark settings. Additive + idempotent.
      `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS vault_enabled boolean NOT NULL DEFAULT false`,
      `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS vault_default_asset text`,

      `ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS derivation_index integer`,
      `ALTER TABLE trading_bots ADD COLUMN IF NOT EXISTS derivation_path_version integer`,
      `DO $$ BEGIN
         ALTER TABLE trading_bots ADD CONSTRAINT trading_bots_derivation_index_positive
           CHECK (derivation_index IS NULL OR derivation_index >= 1);
       EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
      `DO $$ BEGIN
         ALTER TABLE trading_bots ADD CONSTRAINT trading_bots_derivation_dual_model
           CHECK (
             (derivation_index IS NULL AND derivation_path_version IS NULL)
             OR (derivation_index IS NOT NULL AND derivation_path_version IS NOT NULL)
           );
       EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
      `DO $$ BEGIN
         ALTER TABLE trading_bots ADD CONSTRAINT trading_bots_wallet_derivation_index_unique
           UNIQUE (wallet_address, derivation_index);
       EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

      // --- HD-derivation metadata on the spare pool (Pacifica agent_hd reuse). ---
      // When a Pacifica bot is deleted its subaccount is swept-empty and pooled as a
      // spare. On reuse the new bot MUST inherit the spare's ORIGINAL derivation index
      // so the seed fallback re-derives the SAME pubkey (else pubkey-mismatch →
      // fail-closed → the reused slot silently loses recoverability). Additive +
      // idempotent. Legacy random-key spares carry NULL/NULL → blob-only, as before.
      `ALTER TABLE protocol_subaccounts ADD COLUMN IF NOT EXISTS derivation_index integer`,
      `ALTER TABLE protocol_subaccounts ADD COLUMN IF NOT EXISTS derivation_path_version integer`,
      `DO $$ BEGIN
         ALTER TABLE protocol_subaccounts ADD CONSTRAINT protocol_subaccounts_derivation_index_positive
           CHECK (derivation_index IS NULL OR derivation_index >= 1);
       EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
      `DO $$ BEGIN
         ALTER TABLE protocol_subaccounts ADD CONSTRAINT protocol_subaccounts_derivation_dual_model
           CHECK (
             (derivation_index IS NULL AND derivation_path_version IS NULL)
             OR (derivation_index IS NOT NULL AND derivation_path_version IS NOT NULL)
           );
       EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

      `INSERT INTO lab_strategies (user_id, name, description, pine_script, parsed_inputs, groups, strategy_settings)
       SELECT 'AqTTQQajeKDjbDU5sb6JoQfTJ8HfHzpjne2sFmYthCez',
              src.name, src.description, src.pine_script, src.parsed_inputs, src.groups, src.strategy_settings
         FROM lab_strategies src
        WHERE src.user_id = 'BuhEYpvrWV1y18jZoY8Hgfyf2pj3nqYXvmPefvBVzk41'
          AND src.name IN ('SBR v1 – Structure Break & Retest', 'Adaptive Regime V3.8')
          AND NOT EXISTS (
            SELECT 1 FROM lab_strategies dest
             WHERE dest.user_id = 'AqTTQQajeKDjbDU5sb6JoQfTJ8HfHzpjne2sFmYthCez'
               AND dest.name = src.name
          )`,

      // --- Flash Trade adapter Phase 1: expand active_protocol CHECK to include 'flash'. ---
      // The original constraint (added in Group D item 18) only allowed ('pacifica', 'drift').
      // Drop-and-recreate is required because PostgreSQL does not support ALTER CONSTRAINT for
      // CHECK constraints. Idempotent: the DO block re-drops before adding, so re-running
      // against an already-migrated DB is safe and produces the final desired constraint.
      // No data backfill needed — no 'flash' rows exist yet; the constraint is broadened,
      // not narrowed, so existing rows are unaffected.
      `DO $$ BEGIN
         ALTER TABLE trading_bots DROP CONSTRAINT IF EXISTS trading_bots_active_protocol_check;
         ALTER TABLE trading_bots ADD CONSTRAINT trading_bots_active_protocol_check
           CHECK (active_protocol IN ('pacifica', 'drift', 'flash'));
       END $$`,

      // --- bot_trades protocol label honesty. ---
      // The column originally defaulted to 'pacifica', so any insert that
      // omitted `protocol` was silently mislabeled as Pacifica regardless of
      // the actual venue (Flash/Drift). createBotTrade() now stamps the real
      // protocol from the owning bot, so drop the misleading default — a
      // genuinely unknown protocol should read NULL, never a wrong venue.
      // Idempotent: DROP DEFAULT is a no-op once the default is already gone.
      `ALTER TABLE bot_trades ALTER COLUMN protocol DROP DEFAULT`,

      // --- Task 188: QuantumLab backtest accuracy foundation. ---
      // Validity (out-of-sample holdout) + fidelity (slippage friction + engine
      // self-consistency check). All columns nullable / backward-compatible:
      // legacy runs read NULL (holdout disabled, no friction record, no parity),
      // and legacy result rows read NULL is/oos metrics. Each statement is
      // additive ADD COLUMN IF NOT EXISTS — idempotent, never drops anything.
      `ALTER TABLE lab_optimization_runs ADD COLUMN IF NOT EXISTS oos_fraction real`,
      `ALTER TABLE lab_optimization_runs ADD COLUMN IF NOT EXISTS slippage real`,
      `ALTER TABLE lab_optimization_runs ADD COLUMN IF NOT EXISTS parity_match boolean`,
      `ALTER TABLE lab_optimization_runs ADD COLUMN IF NOT EXISTS parity_diffs jsonb`,
      `ALTER TABLE lab_optimization_results ADD COLUMN IF NOT EXISTS is_metrics jsonb`,
      `ALTER TABLE lab_optimization_results ADD COLUMN IF NOT EXISTS oos_metrics jsonb`,

      // --- QuantumLab Sandbox Agent (Phase A): agent task state + run idempotency. ---
      // Additive + idempotent. lab_agent_tasks is the agent's durable working
      // memory (goal / plan / owned runs / leash counters). The agent_* columns on
      // lab_optimization_runs link a run to its owning task and make a resumed task
      // safe to retry: the partial UNIQUE index maps each
      // (user_id, agent_task_id, agent_idempotency_key) to ONE run, so a reconnect
      // can never double-queue on the single shared worker. Runs are the source of
      // truth; every non-agent (manual/UI) run leaves all agent_* columns NULL/false.
      `CREATE TABLE IF NOT EXISTS lab_agent_tasks (
        id serial PRIMARY KEY,
        wallet_address text NOT NULL,
        status text NOT NULL DEFAULT 'active',
        mode text NOT NULL DEFAULT 'chat',
        goal text,
        plan jsonb,
        memory jsonb,
        active_run_id integer,
        owned_run_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
        loop_count integer NOT NULL DEFAULT 0,
        spend_estimate_usd real NOT NULL DEFAULT 0,
        stop_reason text,
        last_reconciled_at timestamp,
        awaiting_since timestamp,
        cancel_requested_at timestamp,
        toolkit_version integer NOT NULL DEFAULT 1,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_lab_agent_tasks_wallet_status ON lab_agent_tasks (wallet_address, status)`,
      `ALTER TABLE lab_optimization_runs ADD COLUMN IF NOT EXISTS agent_task_id integer`,
      `ALTER TABLE lab_optimization_runs ADD COLUMN IF NOT EXISTS agent_idempotency_key text`,
      `ALTER TABLE lab_optimization_runs ADD COLUMN IF NOT EXISTS agent_correlation_id text`,
      `ALTER TABLE lab_optimization_runs ADD COLUMN IF NOT EXISTS agent_owned boolean NOT NULL DEFAULT false`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_lab_opt_runs_agent_idem
         ON lab_optimization_runs (user_id, agent_task_id, agent_idempotency_key)
         WHERE agent_idempotency_key IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_lab_opt_runs_agent_task
         ON lab_optimization_runs (agent_task_id)
         WHERE agent_task_id IS NOT NULL`,

      // --- QuantumLab Sandbox Agent (Phase B): chat transcript. ---
      // Additive + idempotent. Wallet-scoping is enforced in the storage layer
      // through the owning lab_agent_tasks row, never by task_id alone. The CHECK
      // lives INSIDE the CREATE so it ships atomically with a brand-new table and
      // never runs as a standalone ADD CONSTRAINT (which throws 42P07 on re-run
      // and would silently skip later migrations — see the per-statement note below).
      `CREATE TABLE IF NOT EXISTS lab_agent_messages (
        id serial PRIMARY KEY,
        task_id integer NOT NULL,
        role text NOT NULL CHECK (role IN ('user','agent','tool')),
        content text NOT NULL,
        suggested_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_lab_agent_messages_task_created ON lab_agent_messages (task_id, created_at, id)`,

      // --- QuantumLab Sandbox Agent (Phase C): turn-loop orchestration state. ---
      // Additive + idempotent. The DB is the source of truth for the turn loop so a
      // turn can be resumed crash-safely; see server/lab-agent/orchestrator.ts.
      `ALTER TABLE lab_agent_tasks ADD COLUMN IF NOT EXISTS turn_state text NOT NULL DEFAULT 'ready'`,
      `ALTER TABLE lab_agent_tasks ADD COLUMN IF NOT EXISTS turn_lease text`,
      `ALTER TABLE lab_agent_tasks ADD COLUMN IF NOT EXISTS turn_lease_expires_at timestamp`,
      `ALTER TABLE lab_agent_tasks ADD COLUMN IF NOT EXISTS turn_state_changed_at timestamp`,
      `ALTER TABLE lab_agent_tasks ADD COLUMN IF NOT EXISTS step_index integer NOT NULL DEFAULT 0`,
      `ALTER TABLE lab_agent_tasks ADD COLUMN IF NOT EXISTS current_step jsonb`,

      // --- Phase 0a Vaults: per-wallet parked yield-asset positions. ---
      // Cost-basis accounting cache; on-chain token balance is display truth.
      // One row per (wallet, asset). Idempotent: safe on fresh / migrated DBs.
      `CREATE TABLE IF NOT EXISTS vault_positions (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        wallet_address text NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
        asset_key text NOT NULL,
        mint text NOT NULL,
        token_amount_raw text NOT NULL DEFAULT '0',
        usdc_cost_basis numeric(20, 6) NOT NULL DEFAULT 0,
        status text NOT NULL DEFAULT 'active',
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now(),
        CONSTRAINT vault_positions_wallet_asset_unique UNIQUE (wallet_address, asset_key)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_vault_positions_wallet ON vault_positions (wallet_address)`,

      // --- Phase 4 Vaults: per-bot scoping for vault_positions. ---
      // trading_bot_id NULL = account-level vault (main agent wallet); non-null =
      // a specific bot's own per-bot wallet (Flash independent_trader). Additive +
      // idempotent. ORDER MATTERS: create the new partial unique indexes BEFORE
      // dropping the old blanket unique constraint, so uniqueness is never briefly
      // unenforced if a later statement fails. Plain column (no FK): on-chain is
      // truth, so an orphan cost-basis row after a bot delete is benign clutter.
      `ALTER TABLE vault_positions ADD COLUMN IF NOT EXISTS trading_bot_id varchar`,
      `CREATE UNIQUE INDEX IF NOT EXISTS vault_positions_account_unique ON vault_positions (wallet_address, asset_key) WHERE trading_bot_id IS NULL`,
      `CREATE UNIQUE INDEX IF NOT EXISTS vault_positions_bot_unique ON vault_positions (wallet_address, trading_bot_id, asset_key) WHERE trading_bot_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_vault_positions_bot ON vault_positions (trading_bot_id) WHERE trading_bot_id IS NOT NULL`,
      `ALTER TABLE vault_positions DROP CONSTRAINT IF EXISTS vault_positions_wallet_asset_unique`,

      // --- Phase 1 Vaults: yield-oracle realized-APY price snapshots. ---
      // Display-only series; the yield oracle annualizes the movement of each
      // asset's on-chain price over time. One row per (asset, sample). Additive +
      // idempotent. Compound index serves the per-asset trailing-window scan.
      `CREATE TABLE IF NOT EXISTS yield_price_snapshots (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        asset_key text NOT NULL,
        price_usdc_per_token numeric(30, 12) NOT NULL,
        as_of timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_yield_price_snapshots_asset_time ON yield_price_snapshots (asset_key, as_of)`,

      // --- Vaults: external (DeFiLlama) realized-APY cache. ---
      // One upserted row per asset_key holding the last-good REAL APY from the
      // external yield index, so a cold process / restart serves a measured number
      // immediately and the UI never regresses to an estimate during a brief upstream
      // outage. Display-only (no money). Additive + idempotent.
      `CREATE TABLE IF NOT EXISTS yield_apy_cache (
        asset_key text PRIMARY KEY,
        apy numeric(10, 4),
        apy_base numeric(10, 4),
        apy_reward numeric(10, 4),
        apy_mean_30d numeric(10, 4),
        source text NOT NULL,
        pool_id text,
        as_of timestamp NOT NULL DEFAULT now()
      )`,

      // --- SOL Loop Vault P3: hourly rate telemetry (allocation-tick input). ---
      // Rates are FRACTIONS (0.08 = 8%), nullable per-field (partial upstream
      // outage still records readable fields; policy fails closed on null at
      // read time). Telemetry/policy input only — money paths re-read live.
      // Bounded retention (pruned by the sampler). Additive + idempotent.
      `CREATE TABLE IF NOT EXISTS loop_rate_samples (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        vault_id integer NOT NULL,
        symbol text NOT NULL,
        staking_apy numeric(12, 8),
        staking_apy_mean_30d numeric(12, 8),
        borrow_apr numeric(12, 8),
        withdraw_utilization numeric(8, 6),
        net_carry_2x numeric(12, 8),
        liquidation_threshold numeric(8, 6),
        as_of timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_loop_rate_samples_vault_time ON loop_rate_samples (vault_id, as_of)`,
      // Dynamic-leverage input: vault LT sampled into the rate row (additive;
      // pre-migration rows stay null → consumers fail closed, self-heals on
      // the next hourly sample).
      `ALTER TABLE loop_rate_samples ADD COLUMN IF NOT EXISTS liquidation_threshold numeric(8, 6)`,

      // --- Vaults borrow engine (Phase A scaffold): debt LEDGER. ---
      // Empty + additive; NO writers wired yet (Phase A = spec & hard gates, no
      // money moves). One row per isolated borrow position. Scope mirrors
      // vault_positions / server/vault/scope.ts: trading_bot_id NULL = account
      // level (agent-main wallet pledges to Jupiter Lend/Fluid); non-null = a
      // bot's own per-bot wallet (Flash). MONEY-SAFETY: debt is a LIABILITY — it
      // is NEVER folded into equity_events / sumNetDepositedFromEvents (that
      // would fabricate PnL); displayed equity = assets − debt. Health is read
      // AUTHORITATIVELY on-chain (REST = cross-check only); health_as_of is the
      // ORACLE publish time, never the pool liquidity lastUpdateTimestamp. The
      // active-position uniqueness model is deferred to the build phase (no
      // writers exist to constrain yet); only non-unique scope indexes here.
      // Policy-neutral columns only: hard max-LTV cap and fee/monetization model
      // are PENDING owner decisions and live in config/policy, not this schema.
      `CREATE TABLE IF NOT EXISTS borrow_positions (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        wallet_address text NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
        trading_bot_id varchar,
        debt_venue text NOT NULL,
        venue_vault_id text,
        venue_position_id text,
        collateral_asset_key text NOT NULL,
        collateral_mint text NOT NULL,
        collateral_amount_raw text NOT NULL DEFAULT '0',
        debt_asset_key text NOT NULL DEFAULT 'usdc',
        debt_mint text NOT NULL,
        debt_amount_raw text NOT NULL DEFAULT '0',
        attributed_bot_id varchar,
        status text NOT NULL DEFAULT 'pending',
        health_snapshot jsonb,
        health_as_of timestamp,
        health_source text,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_borrow_positions_wallet ON borrow_positions (wallet_address)`,
      `CREATE INDEX IF NOT EXISTS idx_borrow_positions_bot ON borrow_positions (trading_bot_id) WHERE trading_bot_id IS NOT NULL`,
      // Additive: persist the venue's position id (Jupiter Lend NFT) for repay/
      // close/monitor. Idempotent for DBs created before this column existed.
      `ALTER TABLE borrow_positions ADD COLUMN IF NOT EXISTS venue_position_id text`,
      // Additive (FC-2): durable borrow-health alert state so band-crossing
      // Telegram alerts survive restarts, never repeat for the same band, and
      // only reset downward after anti-flap hysteresis. Mirrors schema.ts.
      `ALTER TABLE borrow_positions ADD COLUMN IF NOT EXISTS last_observed_health_band text`,
      `ALTER TABLE borrow_positions ADD COLUMN IF NOT EXISTS health_band_changed_at timestamp`,
      `ALTER TABLE borrow_positions ADD COLUMN IF NOT EXISTS last_health_alert_band text`,
      `ALTER TABLE borrow_positions ADD COLUMN IF NOT EXISTS last_health_alert_at timestamp`,
      // Additive: auto collateral top-up ("defend the loan") throttle timestamp.
      // The autonomous scanner claims a position by stamping this, so a loan that
      // stays urgent can't re-fire (top-up OR alert) within the cooldown window.
      `ALTER TABLE borrow_positions ADD COLUMN IF NOT EXISTS last_auto_topup_attempt_at timestamp`,
      // Additive (SOL Loop Vault P2): position-family discriminator. 'borrow' =
      // the shipped LST→stable engine; 'loop' = leveraged LST→WSOL staking loop.
      // Existing rows are borrow rows, so the default backfills correctly.
      `ALTER TABLE borrow_positions ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'borrow'`,
      // Additive (SOL Loop Vault P3): policy brain state on kind='loop' rows.
      // 'levered' (has debt, safety-tick eligible) | 'holding' (zero debt, HF
      // null — excluded from keeper decideDeleverage). Null on borrow rows.
      `ALTER TABLE borrow_positions ADD COLUMN IF NOT EXISTS policy_state text`,
      `ALTER TABLE borrow_positions ADD COLUMN IF NOT EXISTS policy_reason text`,
      `ALTER TABLE borrow_positions ADD COLUMN IF NOT EXISTS policy_state_changed_at timestamp`,
      // Additive (SOL Loop Vault P3): safety-tick action throttle on loop rows.
      // The reflex claims a position by stamping this atomically, so an unhealthy
      // loop is handed to the executor at most once per cooldown window.
      `ALTER TABLE borrow_positions ADD COLUMN IF NOT EXISTS last_policy_action_at timestamp`,

      // --- SOL Loop Vault P3: append-only policy decision journal. ---
      // One row per tick evaluation (including outcome 'none') so hysteresis is
      // DB-derived and the observation gate is one SQL pass. Never a money gate.
      `CREATE TABLE IF NOT EXISTS loop_policy_decisions (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        wallet_address text NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
        borrow_position_id varchar,
        vault_id integer NOT NULL,
        tick text NOT NULL,
        action text NOT NULL,
        fraction numeric(8, 6),
        reason text NOT NULL,
        details jsonb,
        created_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_loop_policy_decisions_vault_time ON loop_policy_decisions (vault_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_loop_policy_decisions_wallet ON loop_policy_decisions (wallet_address)`,

      // --- SOL Loop Vault P3 (T106): tick heartbeats for the observation gate. ---
      // One row per completed safety/allocation pass; lets the admin status
      // route measure tick coverage even with zero loop positions. Pruned.
      `CREATE TABLE IF NOT EXISTS loop_tick_heartbeats (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        tick text NOT NULL,
        evaluated integer NOT NULL DEFAULT 0,
        acted integer NOT NULL DEFAULT 0,
        failed integer NOT NULL DEFAULT 0,
        skipped integer,
        skip_reason_counts jsonb,
        created_at timestamp NOT NULL DEFAULT now()
      )`,
      `ALTER TABLE loop_tick_heartbeats ADD COLUMN IF NOT EXISTS skipped integer`,
      `ALTER TABLE loop_tick_heartbeats ADD COLUMN IF NOT EXISTS skip_reason_counts jsonb`,
      `CREATE INDEX IF NOT EXISTS idx_loop_tick_heartbeats_tick_time ON loop_tick_heartbeats (tick, created_at)`,

      // --- Vaults borrow engine (Phase A scaffold): money-op AUDIT log. ---
      // Append-only record of every multi-hop borrow/repay/carry operation, so
      // the (future) money state machine is resumable + idempotent: DB-unique
      // operation id + per-step on-chain tx signatures + status/step, mirroring
      // the audited park/unpark safety model. Empty + additive; no writers yet.
      `CREATE TABLE IF NOT EXISTS borrow_operations (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        wallet_address text NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
        borrow_position_id varchar,
        operation_type text NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        step text,
        tx_signatures jsonb NOT NULL DEFAULT '[]',
        error text,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_borrow_operations_wallet ON borrow_operations (wallet_address)`,
      `CREATE INDEX IF NOT EXISTS idx_borrow_operations_position ON borrow_operations (borrow_position_id) WHERE borrow_position_id IS NOT NULL`,
      // Additive (resumable + idempotent multi-hop repays): caller idempotency
      // key + resume-context metadata + immutable result payload. Idempotent for
      // DBs created before these columns existed. Each ALTER is its own statement
      // so a re-run that no-ops one never skips a later migration.
      `ALTER TABLE borrow_operations ADD COLUMN IF NOT EXISTS client_request_id text`,
      `ALTER TABLE borrow_operations ADD COLUMN IF NOT EXISTS metadata jsonb`,
      `ALTER TABLE borrow_operations ADD COLUMN IF NOT EXISTS result jsonb`,
      // UNIQUE per (wallet, client_request_id) so a retried logical op reuses its
      // row instead of double-executing. Partial: only enforced on non-null keys.
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_borrow_operations_client_req ON borrow_operations (wallet_address, client_request_id) WHERE client_request_id IS NOT NULL`,

      // --- Fixed Yield vault: PT holdings bought on a fixed-rate venue. ---
      // One row per open PT position (Exponent first). On-chain PT balance is
      // the display truth; this row is cost-basis + maturity bookkeeping. Ops
      // audit through borrow_operations (fy_deposit / fy_exit / fy_redeem).
      `CREATE TABLE IF NOT EXISTS fy_positions (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        wallet_address text NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
        venue text NOT NULL DEFAULT 'exponent',
        market_address text NOT NULL,
        venue_vault_address text,
        pt_mint text NOT NULL,
        pt_decimals integer NOT NULL DEFAULT 9,
        underlying_mint text NOT NULL,
        underlying_symbol text NOT NULL,
        pt_amount_raw text NOT NULL DEFAULT '0',
        cost_basis_usdc numeric(20, 6) NOT NULL DEFAULT '0',
        implied_apy_at_entry numeric(10, 6),
        maturity_at timestamp NOT NULL,
        status text NOT NULL DEFAULT 'active',
        notified_maturity_at timestamp,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_fy_positions_wallet ON fy_positions (wallet_address)`,

      // --- HERMES_EXIT_PLAN Phase 3b: on-chain Pyth oracle snapshot store. ---
      // Append-only 26h ring for on-chain Pyth price readings (borrow-gate feeds
      // + Flash crypto feeds). Pruned by oracle-snapshot-recorder.ts on every
      // tick. Additive + idempotent. No foreign keys — purely observational.
      `CREATE TABLE IF NOT EXISTS oracle_price_snapshots (
        id serial PRIMARY KEY,
        feed_id text NOT NULL,
        symbol text NOT NULL,
        price_usd real NOT NULL,
        publish_time_sec integer NOT NULL,
        taken_at timestamp NOT NULL DEFAULT now(),
        source text NOT NULL DEFAULT 'onchain'
      )`,
      `CREATE INDEX IF NOT EXISTS idx_oracle_snapshots_feed_taken ON oracle_price_snapshots (feed_id, taken_at)`,

      // --- Controlled scanner incident evidence retention. ---
      // Independent of error_log coalescing and pruneErrors. active_slot=1 is
      // unique for every unreleased hold; released rows clear it to NULL.
      `CREATE TABLE IF NOT EXISTS scanner_incident_holds (
        id text PRIMARY KEY,
        state text NOT NULL CHECK (state IN ('baseline', 'canary', 'exported', 'released')),
        active_slot integer DEFAULT 1,
        export_row_count integer,
        export_digest text,
        created_at timestamptz NOT NULL DEFAULT now(),
        canary_started_at timestamptz,
        exported_at timestamptz,
        released_at timestamptz,
        CONSTRAINT scanner_incident_holds_active_slot_check CHECK (
          (state = 'released' AND active_slot IS NULL)
          OR (state <> 'released' AND active_slot = 1)
        ),
        CONSTRAINT scanner_incident_holds_export_proof_check CHECK (
          (state IN ('exported', 'released') AND export_row_count IS NOT NULL AND export_digest IS NOT NULL)
          OR (state IN ('baseline', 'canary') AND export_row_count IS NULL AND export_digest IS NULL)
        )
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS scanner_incident_holds_active_slot_unique
         ON scanner_incident_holds (active_slot)`,
      `CREATE TABLE IF NOT EXISTS scanner_incident_occurrences (
        event_id varchar PRIMARY KEY,
        hold_id text NOT NULL REFERENCES scanner_incident_holds(id) ON DELETE CASCADE,
        "window" text NOT NULL CHECK ("window" IN ('baseline', 'canary')),
        fingerprint text NOT NULL,
        observed_at timestamptz NOT NULL,
        category text NOT NULL DEFAULT 'scanner' CHECK (category = 'scanner'),
        source text NOT NULL,
        summary text NOT NULL,
        context jsonb NOT NULL DEFAULT '{}'::jsonb
      )`,
      `CREATE INDEX IF NOT EXISTS scanner_incident_occurrences_hold_order_idx
         ON scanner_incident_occurrences (hold_id, observed_at, event_id)`,
      `CREATE INDEX IF NOT EXISTS scanner_incident_occurrences_hold_fingerprint_idx
         ON scanner_incident_occurrences (hold_id, fingerprint)`,

      // --- AGENTIC_TRADER_PLAN WO-2: AI Trader bots + decision audit trail. ---
      // Additive + idempotent, mirrors the shared/schema.ts pgTable definitions
      // verbatim (see AGENTIC_TRADER_PLAN.md §7). Schema/storage only for WO-2 —
      // no routes/executor/monitor read or write these tables yet. FK is inline
      // (created atomically with the table) to avoid the separate
      // ADD CONSTRAINT 42P07-vs-42710 trap described above.
      `CREATE TABLE IF NOT EXISTS ai_trader_bots (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        wallet_address text NOT NULL,
        protocol text NOT NULL,
        protocol_subaccount_id text,
        market text NOT NULL,
        timeframe text NOT NULL,
        mode text NOT NULL DEFAULT 'suggest',
        risk_profile text NOT NULL DEFAULT 'guarded',
        paper_mode boolean NOT NULL DEFAULT true,
        auto_next boolean NOT NULL DEFAULT false,
        model text NOT NULL DEFAULT 'anthropic/claude-opus-4.8',
        allocated_usdc numeric(20, 2) NOT NULL,
        max_leverage integer NOT NULL DEFAULT 3,
        stop_policy text NOT NULL DEFAULT 'static',
        park_when_idle boolean NOT NULL DEFAULT false,
        graduation_state text NOT NULL DEFAULT 'in_trial',
        graduation_criteria jsonb NOT NULL,
        trial_started_at timestamp DEFAULT now(),
        graduated_at timestamp,
        policy_hmac text NOT NULL,
        status text NOT NULL DEFAULT 'idle',
        pause_reason text,
        daily_realized_pnl numeric(20, 2) DEFAULT '0',
        consecutive_losses integer NOT NULL DEFAULT 0,
        created_at timestamp DEFAULT now(),
        updated_at timestamp DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ai_trader_bots_wallet ON ai_trader_bots (wallet_address)`,
      `CREATE INDEX IF NOT EXISTS idx_ai_trader_bots_status ON ai_trader_bots (status)`,
      `CREATE TABLE IF NOT EXISTS ai_trader_decisions (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        bot_id varchar REFERENCES ai_trader_bots(id) ON DELETE CASCADE,
        context_digest jsonb,
        raw_decision jsonb NOT NULL,
        clamped_decision jsonb,
        guardrail_violations jsonb,
        outcome text,
        entry_price numeric(20, 8),
        exit_price numeric(20, 8),
        exit_reason text,
        realized_pnl numeric(20, 2),
        fees_paid numeric(20, 6),
        llm_cost_usd numeric(10, 6),
        llm_latency_ms integer,
        decided_at timestamp DEFAULT now(),
        closed_at timestamp
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ai_trader_decisions_bot_decided ON ai_trader_decisions (bot_id, decided_at DESC)`,
      // Partial index for the trades-only query path (outcome='executed' filter).
      // Covers getAiTraderDecisionsPaged with outcomes='executed', avoids full-table seq scan
      // on bots with thousands of flat rows. Deferred 60-day rollup — slim compressed rows
      // are cheap; revisit if row counts cause measurable query latency.
      `CREATE INDEX IF NOT EXISTS idx_ai_trader_decisions_executed ON ai_trader_decisions (bot_id, decided_at DESC) WHERE outcome = 'executed'`,

      // WO-7: free paper-trial counter for wallets with no BYO OpenRouter key.
      `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS ai_trader_free_calls_used integer NOT NULL DEFAULT 0`,

      // WO-7.1 go-live: per-bot venue subaccount key (V3 ciphertext) + HD
      // derivation metadata on ai_trader_bots, mirroring trading_bots. Additive
      // + idempotent; live signing fails closed when the key is absent.
      `ALTER TABLE ai_trader_bots ADD COLUMN IF NOT EXISTS bot_subaccount_key_encrypted_v3 text`,
      `ALTER TABLE ai_trader_bots ADD COLUMN IF NOT EXISTS derivation_index integer`,
      `ALTER TABLE ai_trader_bots ADD COLUMN IF NOT EXISTS derivation_path_version integer`,

      // WO-8h item 3: model attribution on every decision row (stamps the model
      // used at decision time so track records stay attributable when models change
      // mid-flight). Backfill existing rows from the bot's current model.
      `ALTER TABLE ai_trader_decisions ADD COLUMN IF NOT EXISTS model_used text`,
      `UPDATE ai_trader_decisions d
         SET model_used = b.model
         FROM ai_trader_bots b
         WHERE d.bot_id = b.id
           AND d.model_used IS NULL`,

      // risk-based-sizing-spec Phase A: optional confidence-scaled risk-based
      // sizing (per-bot, off by default). Additive + idempotent, mirrors
      // shared/schema.ts. sizing_mode: 'discretionary' | 'risk_based'; the
      // risk band is % of the sizing base per trade (validated 0.1–3.0 at the
      // API layer; guardrails.ts re-validates and fails closed at runtime).
      `ALTER TABLE ai_trader_bots ADD COLUMN IF NOT EXISTS sizing_mode text NOT NULL DEFAULT 'discretionary'`,
      `ALTER TABLE ai_trader_bots ADD COLUMN IF NOT EXISTS risk_min_pct numeric(5, 2) NOT NULL DEFAULT 0.50`,
      `ALTER TABLE ai_trader_bots ADD COLUMN IF NOT EXISTS risk_max_pct numeric(5, 2) NOT NULL DEFAULT 1.50`,

      // COT-A: CFTC Bitcoin Legacy futures-only COT positioning cache.
      // Idempotent startup DDL — never db:push. Single global BTC signal, one row per
      // weekly CFTC release. report_date is a date column held as text in Drizzle.
      `CREATE TABLE IF NOT EXISTS cot_snapshots (
        id serial PRIMARY KEY,
        report_date date NOT NULL UNIQUE,
        commercial_net integer NOT NULL,
        noncomm_net integer NOT NULL,
        nonrept_net integer NOT NULL,
        dumb_net integer NOT NULL,
        comm_index numeric(6,2),
        noncomm_index numeric(6,2),
        nonrept_index numeric(6,2),
        dumb_index numeric(6,2),
        state text NOT NULL DEFAULT 'insufficient_data',
        weeks_in_window integer NOT NULL DEFAULT 0,
        fetched_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_cot_snapshots_report_date ON cot_snapshots (report_date DESC)`,

      // Reflection-playbook-spec Phase A: per-bot accumulated lesson playbook.
      // Accumulate-only — injection gated behind calibration precondition + structure-bricks
      // keep-gate review. Idempotent startup DDL; never db:push.
      `ALTER TABLE ai_trader_bots ADD COLUMN IF NOT EXISTS playbook jsonb`,
      `ALTER TABLE ai_trader_bots ADD COLUMN IF NOT EXISTS playbook_version integer NOT NULL DEFAULT 0`,
      `ALTER TABLE ai_trader_bots ADD COLUMN IF NOT EXISTS playbook_updated_at timestamp`,

      // --- WO-B: scanner bot mode. ---
      // 'fixed' (default) preserves today's behaviour byte-for-byte for all existing bots.
      // 'scanner' makes the bot pick from the shortlist each 15m boundary via runAutoCycle.
      // market/timeframe stay NOT NULL; scanner bots write the chosen values before each
      // decision so all downstream readers (monitor 15s loop, executor, UI) work unmodified.
      // Rollback: DROP COLUMN market_source is safe — every reader treats missing/default as 'fixed'.
      `ALTER TABLE ai_trader_bots ADD COLUMN IF NOT EXISTS market_source text NOT NULL DEFAULT 'fixed'`,

      // --- WO-15A: batch financial-enrichment index on equity_events. ---
      // Additive: never changes any row or constraint. Idempotent CREATE INDEX IF NOT EXISTS.
      // Rollback: DROP INDEX IF EXISTS idx_equity_events_bot_created
      `CREATE INDEX IF NOT EXISTS idx_equity_events_bot_created ON equity_events(trading_bot_id, created_at DESC)`,

      // --- One-time rogue AVAX close correction. ---
      // A no-fill reconciler observation was persisted as a second close for a
      // position that had already closed. Pin every immutable/economic field so
      // a reused ID or changed row fails closed instead of deleting history.
      // The anonymous block is one transaction: delete + stats repair commit
      // together. Once the row is absent, every later startup is a no-op.
      `DO $qv$
       DECLARE
         target_trade bot_trades%ROWTYPE;
         canonical_stats RECORD;
       BEGIN
         IF NOT EXISTS (
           SELECT 1 FROM bot_trades
            WHERE id = '491abec1-39c2-42c5-8963-e5f4fb644b3a'
         ) THEN
           RETURN;
         END IF;

         -- Blue/green publish overlap can leave the outgoing instance trading.
         -- Serialize with every bot_trades reader/writer before taking the
         -- canonical stats snapshot. Existing stats recomputes read this table
         -- inside their transaction, so ACCESS EXCLUSIVE also drains any stale
         -- read/merge/write already running on the outgoing process.
         LOCK TABLE bot_trades IN ACCESS EXCLUSIVE MODE;

         SELECT *
           INTO target_trade
           FROM bot_trades
          WHERE id = '491abec1-39c2-42c5-8963-e5f4fb644b3a'
            AND trading_bot_id = 'c74f5d5a-be0f-4db9-8909-0605ece3a49d'
            AND wallet_address = 'AqTTQQajeKDjbDU5sb6JoQfTJ8HfHzpjne2sFmYthCez'
            AND market = 'AVAX-PERP'
            AND side = 'long'
            AND size = 38.63000000
            AND price = 8.927900
            AND fee = 0
            AND pnl = -105.84
            AND status = 'executed'
            AND protocol = 'pacifica'
            AND protocol_fill_id = 'tx-reconciler-position-epoch|c74f5d5a-be0f-4db9-8909-0605ece3a49d|AVAX|527034b2-6a0f-457b-a962-4b78aa890774'
            AND tx_signature IS NULL
            AND execution_method = 'on-chain-detected'
            AND executed_at = TIMESTAMP '2026-08-13 05:27:28.496574'
          FOR UPDATE;

         IF NOT FOUND THEN
           RAISE EXCEPTION 'rogue AVAX trade fingerprint mismatch';
         END IF;

         PERFORM 1
           FROM trading_bots
          WHERE id = target_trade.trading_bot_id
            AND wallet_address = target_trade.wallet_address
            AND name = 'AVAX 4H FLUX MOMENTUM'
          FOR UPDATE;
         IF NOT FOUND THEN
           RAISE EXCEPTION 'rogue AVAX trade owner fingerprint mismatch';
         END IF;

         DELETE FROM bot_trades
          WHERE id = target_trade.id;

         SELECT
           COALESCE(SUM(bt.pnl::numeric), 0) AS total_pnl,
           COUNT(*)::int AS total_trades,
           COUNT(*) FILTER (WHERE bt.pnl::numeric > 0)::int AS winning_trades,
           COUNT(*) FILTER (WHERE bt.pnl::numeric < 0)::int AS losing_trades,
           MAX(bt.executed_at) AS last_trade_at
           INTO canonical_stats
           FROM bot_trades bt
          WHERE bt.trading_bot_id = target_trade.trading_bot_id
            AND bt.pnl IS NOT NULL
            AND bt.status IN ('executed', 'liquidated', 'recovered')
            AND NOT (
              bt.tx_signature IS NULL
              AND COALESCE(bt.fee, 0) = 0
              AND EXISTS (
                SELECT 1 FROM bot_trades sibling
                 WHERE sibling.trading_bot_id = bt.trading_bot_id
                   AND sibling.market = bt.market
                   AND sibling.id <> bt.id
                   AND sibling.pnl IS NOT NULL
                   AND sibling.status IN ('executed', 'liquidated', 'recovered')
                   AND ABS(EXTRACT(EPOCH FROM (sibling.executed_at - bt.executed_at))) <= 120
                   AND ABS(ABS(sibling.size) - ABS(bt.size)) <= 0.01 * ABS(bt.size)
                   AND (sibling.tx_signature IS NOT NULL OR COALESCE(sibling.fee, 0) > 0)
              )
            );

         UPDATE trading_bots
            SET stats = COALESCE(stats, '{}'::jsonb) || jsonb_build_object(
                  'totalPnl', canonical_stats.total_pnl,
                  'totalTrades', canonical_stats.total_trades,
                  'winningTrades', canonical_stats.winning_trades,
                  'losingTrades', canonical_stats.losing_trades,
                  'totalVolume', GREATEST(
                    0,
                    COALESCE((stats->>'totalVolume')::numeric, 0)
                      - ABS(target_trade.size::numeric) * target_trade.price::numeric
                  ),
                  'lastTradeAt', CASE
                    WHEN canonical_stats.last_trade_at IS NULL THEN NULL
                    ELSE to_char(canonical_stats.last_trade_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                  END
                ),
                updated_at = NOW()
          WHERE id = target_trade.trading_bot_id;

         IF NOT FOUND THEN
           RAISE EXCEPTION 'rogue AVAX trade stats repair missed owner';
         END IF;
       END
       $qv$`,
    ] as const;

const schemaMigrationMetadata = [
  {
    "id": "000-create-table-if-not",
    "capabilities": [
      "lab_scanner"
    ],
    "requirements": [
      {
        "kind": "table",
        "table": "lab_candle_cache_v2",
        "columns": [
          "id",
          "symbol",
          "timeframe",
          "time",
          "open",
          "high",
          "low",
          "close",
          "volume",
          "source",
          "venue",
          "basis",
          "proxy",
          "finality",
          "time_semantic"
        ],
        "constraintDefinitions": [
          "PRIMARY KEY (id)",
          "source IN ('okx', 'gate', 'pyth', 'unknown')",
          "venue IN ('okx', 'gate', 'none', 'unknown')",
          "basis IN ('perp', 'spot', 'index', 'unknown')",
          "proxy IN ('direct', 'proxy', 'unknown')",
          "finality IN ('finalized', 'forming', 'unknown')",
          "time_semantic IN ('open_time', 'unknown')"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "001-create-unique-index-if",
    "capabilities": [
      "lab_scanner"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "lab_candle_cache_v2",
        "index": "lab_candle_cache_v2_identity_unique",
        "columns": [
          "symbol",
          "timeframe",
          "time",
          "source",
          "venue",
          "basis",
          "proxy",
          "finality",
          "time_semantic"
        ],
        "unique": true
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "002-create-index-if-not",
    "capabilities": [
      "lab_scanner"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "lab_candle_cache_v2",
        "index": "lab_candle_cache_v2_lookup",
        "columns": [
          "symbol",
          "timeframe",
          "basis",
          "finality",
          "proxy",
          "time"
        ],
        "unique": false
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "003-alter-table-lab_optimization_runs-add",
    "capabilities": [
      "lab"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "lab_optimization_runs",
        "column": "queue_order"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "004-alter-table-lab_optimization_runs-add",
    "capabilities": [
      "lab"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "lab_optimization_runs",
        "column": "config_snapshot"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "005-create-table-if-not",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "table",
        "table": "ai_trader_execution_events",
        "columns": [
          "id",
          "event_identity",
          "attempt_id",
          "bot_id",
          "decision_id",
          "action",
          "cause",
          "event_type",
          "phase",
          "protocol",
          "account_scope",
          "account_ref",
          "market",
          "side",
          "client_order_id",
          "venue_order_id",
          "transaction_signature",
          "venue_status",
          "price",
          "size_base",
          "fee",
          "realized_pnl",
          "failure_code",
          "recorded_after_broadcast",
          "observed_at",
          "recorded_at"
        ],
        "constraintDefinitions": [
          "PRIMARY KEY (id)",
          "action IN ('entry','close','cancel')",
          "cause IN ('decision','paper','emergency_unwind','protective','user_requested','venue_detected','unconfirmed_orphan','startup_orphan','pre_close_bracket','survivor_leg')",
          "account_scope IN ('main','bot_subaccount','unknown')",
          "side IS NULL OR side IN ('long','short')",
          "venue_status IS NULL OR venue_status IN ('submitted','acknowledged','filled','partial_fill','canceled','expired','rejected','unknown')",
          "price IS NULL OR price <> 'NaN'::numeric",
          "size_base IS NULL OR (size_base >= 0 AND size_base <> 'NaN'::numeric)",
          "fee IS NULL OR (fee >= 0 AND fee <> 'NaN'::numeric)",
          "realized_pnl IS NULL OR realized_pnl <> 'NaN'::numeric",
          "failure_code IS NULL OR failure_code IN ('venue_rejected','venue_unconfirmed','venue_error','identity_mismatch','signing_unavailable','position_not_confirmed','bracket_failed','unknown')",
          "CHECK ( (event_type = 'attempt_claimed' AND phase = 0) OR (event_type = 'prebroadcast_authorized' AND action = 'entry' AND phase = 10) OR (event_type = 'broadcast_attempted' AND action IN ('close','cancel') AND phase = 10) OR (event_type = 'broadcast_result' AND phase = 20) OR (event_type IN ('position_observed','fill_observed','bracket_verified','reconciliation_observed') AND phase IS NULL) OR (event_type IN ('entry_terminal_open','entry_terminal_no_land','entry_terminal_unwound') AND action = 'entry' AND phase = 90) OR (event_type IN ('close_terminal_confirmed','close_terminal_failed') AND action = 'close' AND phase = 90) OR (event_type IN ('cancel_terminal_confirmed','cancel_terminal_failed') AND action = 'cancel' AND phase = 90) )"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "006-create-index-if-not",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "ai_trader_execution_events",
        "index": "idx_ai_trader_execution_attempt",
        "columns": [
          "attempt_id",
          "phase",
          "observed_at",
          "id"
        ],
        "unique": false
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "007-create-index-if-not",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "ai_trader_execution_events",
        "index": "idx_ai_trader_execution_bot",
        "columns": [
          "bot_id",
          "recorded_at DESC",
          "id DESC"
        ],
        "unique": false
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "008-create-index-if-not",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "ai_trader_execution_events",
        "index": "idx_ai_trader_execution_decision",
        "columns": [
          "decision_id",
          "recorded_at",
          "id"
        ],
        "unique": false
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "009-create-or-replace-function",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "data",
        "identity": "function:qv_reject_ai_trader_execution_event_mutation",
        "checkSql": "SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname='qv_reject_ai_trader_execution_event_mutation') AS ok"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "010-do--begin-create",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "data",
        "identity": "trigger:ai_trader_execution_events_append_only",
        "checkSql": "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='ai_trader_execution_events_append_only' AND NOT tgisinternal) AS ok"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "011-create-table-if-not",
    "capabilities": [
      "platform"
    ],
    "requirements": [
      {
        "kind": "table",
        "table": "platform_cumulative_stats",
        "columns": [
          "id",
          "cumulative_volume",
          "cumulative_trades",
          "updated_at"
        ],
        "constraintDefinitions": [
          "PRIMARY KEY (id)"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "012-create-index-if-not",
    "capabilities": [
      "lab"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "lab_optimization_runs",
        "index": "idx_lab_opt_runs_user_status",
        "columns": [
          "user_id",
          "status",
          "id"
        ],
        "unique": false
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "013-create-index-if-not",
    "capabilities": [
      "lab"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "lab_optimization_results",
        "index": "idx_lab_opt_results_run_id",
        "columns": [
          "run_id"
        ],
        "unique": false
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "014-alter-table-trading_bots-add",
    "capabilities": [
      "signal_bot"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "trading_bots",
        "column": "subaccount_auth_mode"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "015-update-trading_bots-set-subaccount_auth_mode",
    "capabilities": [
      "signal_bot"
    ],
    "requirements": [
      {
        "kind": "data",
        "identity": "migration-009-backfill",
        "checkSql": "SELECT NOT EXISTS (SELECT 1 FROM trading_bots WHERE subaccount_auth_mode IS NULL AND bot_subaccount_key_encrypted IS NOT NULL) AS ok"
      }
    ],
    "operation": "backfill"
  },
  {
    "id": "016-update-trading_bots-set-subaccount_auth_mode",
    "capabilities": [
      "signal_bot"
    ],
    "requirements": [
      {
        "kind": "data",
        "identity": "migration-010-backfill",
        "checkSql": "SELECT NOT EXISTS (SELECT 1 FROM trading_bots WHERE subaccount_auth_mode IS NULL) AS ok"
      }
    ],
    "operation": "backfill"
  },
  {
    "id": "017-do--begin-alter",
    "capabilities": [
      "signal_bot"
    ],
    "requirements": [
      {
        "kind": "constraint",
        "table": "trading_bots",
        "constraint": "trading_bots_subaccount_auth_mode_check",
        "definitionIncludes": [
          "CHECK (subaccount_auth_mode IN ('external_key', 'main_plus_id'))"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "018-do--begin-alter",
    "capabilities": [
      "signal_bot"
    ],
    "requirements": [
      {
        "kind": "constraint",
        "table": "trading_bots",
        "constraint": "trading_bots_external_key_invariant",
        "definitionIncludes": [
          "CHECK ( NOT (subaccount_auth_mode = 'external_key' AND subaccount_status = 'active') OR (protocol_subaccount_id IS NOT NULL AND bot_subaccount_key_encrypted IS NOT NULL) )"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "019-alter-table-trading_bots-alter",
    "capabilities": [
      "signal_bot"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "trading_bots",
        "column": "subaccount_auth_mode"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "020-alter-table-trading_bots-add",
    "capabilities": [
      "signal_bot"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "trading_bots",
        "column": "bot_subaccount_key_encrypted_v3"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "021-do--begin-alter",
    "capabilities": [
      "signal_bot"
    ],
    "requirements": [
      {
        "kind": "constraint",
        "table": "trading_bots",
        "constraint": "trading_bots_external_key_invariant",
        "definitionIncludes": [
          "CHECK ( NOT (subaccount_auth_mode = 'external_key' AND subaccount_status = 'active') OR ( protocol_subaccount_id IS NOT NULL AND (bot_subaccount_key_encrypted IS NOT NULL OR bot_subaccount_key_encrypted_v3 IS NOT NULL) ) )"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "022-do--begin-update",
    "capabilities": [
      "signal_bot"
    ],
    "requirements": [
      {
        "kind": "constraint",
        "table": "trading_bots",
        "constraint": "trading_bots_active_protocol_check",
        "definitionIncludes": [
          "CHECK (active_protocol IN ('pacifica', 'drift'))"
        ]
      },
      {
        "kind": "column",
        "table": "trading_bots",
        "column": "active_protocol"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "023-create-table-if-not",
    "capabilities": [
      "referrals"
    ],
    "requirements": [
      {
        "kind": "table",
        "table": "referral_links",
        "columns": [
          "id",
          "descendant_wallet",
          "ancestor_wallet",
          "level",
          "created_at"
        ],
        "constraintDefinitions": [
          "PRIMARY KEY (id)",
          "FOREIGN KEY (descendant_wallet) REFERENCES wallets(address) ON DELETE CASCADE",
          "FOREIGN KEY (ancestor_wallet) REFERENCES wallets(address) ON DELETE CASCADE",
          "UNIQUE (descendant_wallet, level)",
          "CHECK (descendant_wallet <> ancestor_wallet)",
          "CHECK (level BETWEEN 1 AND 3)"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "024-create-index-if-not",
    "capabilities": [
      "referrals"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "referral_links",
        "index": "idx_referral_links_ancestor",
        "columns": [
          "ancestor_wallet"
        ],
        "unique": false
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "025-create-index-if-not",
    "capabilities": [
      "referrals"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "referral_links",
        "index": "idx_referral_links_descendant",
        "columns": [
          "descendant_wallet"
        ],
        "unique": false
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "026-create-table-if-not",
    "capabilities": [
      "referrals"
    ],
    "requirements": [
      {
        "kind": "table",
        "table": "referral_reward_events",
        "columns": [
          "id",
          "source_type",
          "source_id",
          "earner_wallet",
          "referee_wallet",
          "level",
          "amount_usdc",
          "status",
          "created_at"
        ],
        "constraintDefinitions": [
          "PRIMARY KEY (id)",
          "FOREIGN KEY (earner_wallet) REFERENCES wallets(address) ON DELETE CASCADE",
          "FOREIGN KEY (referee_wallet) REFERENCES wallets(address) ON DELETE CASCADE",
          "UNIQUE (source_type, source_id, earner_wallet, level)",
          "CHECK (level BETWEEN 1 AND 3)",
          "CHECK (status IN ('pending','confirmed','paid','failed'))"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "027-create-index-if-not",
    "capabilities": [
      "referrals"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "referral_reward_events",
        "index": "idx_referral_reward_events_earner",
        "columns": [
          "earner_wallet"
        ],
        "unique": false
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "028-do--begin-if",
    "capabilities": [
      "referrals"
    ],
    "requirements": [
      {
        "kind": "constraint",
        "table": "referral_reward_events",
        "constraint": "referral_reward_events_status_valid",
        "definitionIncludes": [
          "CHECK (status IN ('pending','confirmed','paid','failed','processing','voided'))"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "029-alter-table-referral_reward_events-add",
    "capabilities": [
      "referrals"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "referral_reward_events",
        "column": "funding_wallet"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "030-alter-table-referral_reward_events-add",
    "capabilities": [
      "referrals"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "referral_reward_events",
        "column": "transfer_signature"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "031-alter-table-referral_reward_events-add",
    "capabilities": [
      "referrals"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "referral_reward_events",
        "column": "retry_count"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "032-alter-table-referral_reward_events-add",
    "capabilities": [
      "referrals"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "referral_reward_events",
        "column": "last_error"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "033-alter-table-referral_reward_events-add",
    "capabilities": [
      "referrals"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "referral_reward_events",
        "column": "last_attempt_at"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "034-create-index-if-not",
    "capabilities": [
      "referrals"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "referral_reward_events",
        "index": "idx_referral_reward_events_status_created",
        "columns": [
          "status",
          "created_at"
        ],
        "unique": false
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "035-insert-into-referral_links-descendant_wallet",
    "capabilities": [
      "referrals"
    ],
    "requirements": [
      {
        "kind": "data",
        "identity": "migration-029-backfill",
        "checkSql": "SELECT NOT EXISTS (SELECT 1 FROM wallets w WHERE w.referred_by IS NOT NULL AND w.referred_by <> w.address AND EXISTS (SELECT 1 FROM wallets a WHERE a.address=w.referred_by) AND NOT EXISTS (SELECT 1 FROM referral_links r WHERE r.descendant_wallet=w.address AND r.level=1 AND r.ancestor_wallet=w.referred_by)) AS ok"
      }
    ],
    "operation": "backfill"
  },
  {
    "id": "036-insert-into-referral_links-descendant_wallet",
    "capabilities": [
      "referrals"
    ],
    "requirements": [
      {
        "kind": "data",
        "identity": "migration-030-backfill",
        "checkSql": "SELECT NOT EXISTS (SELECT 1 FROM wallets w JOIN wallets w2 ON w2.address=w.referred_by WHERE w2.referred_by IS NOT NULL AND w2.referred_by <> w.address AND EXISTS (SELECT 1 FROM wallets a WHERE a.address=w2.referred_by) AND NOT EXISTS (SELECT 1 FROM referral_links r WHERE r.descendant_wallet=w.address AND r.level=2 AND r.ancestor_wallet=w2.referred_by)) AS ok"
      }
    ],
    "operation": "backfill"
  },
  {
    "id": "037-insert-into-referral_links-descendant_wallet",
    "capabilities": [
      "referrals"
    ],
    "requirements": [
      {
        "kind": "data",
        "identity": "migration-031-backfill",
        "checkSql": "SELECT NOT EXISTS (SELECT 1 FROM wallets w JOIN wallets w2 ON w2.address=w.referred_by JOIN wallets w3 ON w3.address=w2.referred_by WHERE w3.referred_by IS NOT NULL AND w3.referred_by <> w.address AND EXISTS (SELECT 1 FROM wallets a WHERE a.address=w3.referred_by) AND NOT EXISTS (SELECT 1 FROM referral_links r WHERE r.descendant_wallet=w.address AND r.level=3 AND r.ancestor_wallet=w3.referred_by)) AS ok"
      }
    ],
    "operation": "backfill"
  },
  {
    "id": "038-alter-table-equity_events-add",
    "capabilities": [
      "portfolio"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "equity_events",
        "column": "tx_block_time"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "039-alter-table-portfolio_daily_snapshots-add",
    "capabilities": [
      "portfolio"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "portfolio_daily_snapshots",
        "column": "cumulative_external_deposits"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "040-alter-table-portfolio_daily_snapshots-add",
    "capabilities": [
      "portfolio"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "portfolio_daily_snapshots",
        "column": "cumulative_external_withdrawals"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "041-alter-table-portfolio_daily_snapshots-add",
    "capabilities": [
      "portfolio"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "portfolio_daily_snapshots",
        "column": "cumulative_internal_transfers"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "042-alter-table-portfolio_daily_snapshots-add",
    "capabilities": [
      "portfolio"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "portfolio_daily_snapshots",
        "column": "cumulative_trading_pnl"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "043-alter-table-portfolio_daily_snapshots-add",
    "capabilities": [
      "portfolio"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "portfolio_daily_snapshots",
        "column": "net_external_flow"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "044-alter-table-portfolio_daily_snapshots-add",
    "capabilities": [
      "portfolio"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "portfolio_daily_snapshots",
        "column": "pnl_percent"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "045-alter-table-wallets-add",
    "capabilities": [
      "notifications"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "wallets",
        "column": "daily_summary_enabled"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "046-alter-table-wallets-add",
    "capabilities": [
      "notifications"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "wallets",
        "column": "daily_summary_last_sent_date"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "047-alter-table-wallets-add",
    "capabilities": [
      "signal_bot"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "wallets",
        "column": "pacifica_builder_approved"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "048-alter-table-wallets-add",
    "capabilities": [
      "signal_bot"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "wallets",
        "column": "pacifica_referral_claimed"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "049-alter-table-wallets-add",
    "capabilities": [
      "signal_bot"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "wallets",
        "column": "hands_off_approved"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "050-alter-table-trading_bots-add",
    "capabilities": [
      "signal_bot"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "trading_bots",
        "column": "pacifica_builder_approved"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "051-alter-table-trading_bots-add",
    "capabilities": [
      "signal_bot"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "trading_bots",
        "column": "pacifica_referral_claimed"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "052-alter-table-trading_bots-add",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "trading_bots",
        "column": "auto_park_idle"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "053-alter-table-trading_bots-add",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "trading_bots",
        "column": "auto_park_due_at"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "054-alter-table-trading_bots-add",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "trading_bots",
        "column": "park_destination_asset"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "055-alter-table-trading_bots-add",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "trading_bots",
        "column": "vault_all_out"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "056-alter-table-trading_bots-add",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "trading_bots",
        "column": "auto_collateral_top_up"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "057-alter-table-trading_bots-add",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "trading_bots",
        "column": "auto_repay_enabled"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "058-alter-table-wallets-add",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "wallets",
        "column": "next_bot_derivation_index"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "059-alter-table-wallets-add",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "wallets",
        "column": "recovered_orphan_indices"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "060-alter-table-wallets-add",
    "capabilities": [
      "wallet_security"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "wallets",
        "column": "llm_api_key_encrypted"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "061-alter-table-wallets-add",
    "capabilities": [
      "wallet_security"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "wallets",
        "column": "llm_api_key_last4"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "062-alter-table-wallets-add",
    "capabilities": [
      "wallet_security"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "wallets",
        "column": "llm_api_key_provider"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "063-alter-table-wallets-add",
    "capabilities": [
      "wallet_security"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "wallets",
        "column": "llm_api_key_updated_at"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "064-alter-table-wallets-add",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "wallets",
        "column": "vault_enabled"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "065-alter-table-wallets-add",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "wallets",
        "column": "vault_default_asset"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "066-alter-table-trading_bots-add",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "trading_bots",
        "column": "derivation_index"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "067-alter-table-trading_bots-add",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "trading_bots",
        "column": "derivation_path_version"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "068-do--begin-alter",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "constraint",
        "table": "trading_bots",
        "constraint": "trading_bots_derivation_index_positive",
        "definitionIncludes": [
          "CHECK (derivation_index IS NULL OR derivation_index >= 1)"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "069-do--begin-alter",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "constraint",
        "table": "trading_bots",
        "constraint": "trading_bots_derivation_dual_model",
        "definitionIncludes": [
          "CHECK ( (derivation_index IS NULL AND derivation_path_version IS NULL) OR (derivation_index IS NOT NULL AND derivation_path_version IS NOT NULL) )"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "070-do--begin-alter",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "constraint",
        "table": "trading_bots",
        "constraint": "trading_bots_wallet_derivation_index_unique",
        "definitionIncludes": [
          "UNIQUE (wallet_address, derivation_index)"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "071-alter-table-protocol_subaccounts-add",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "protocol_subaccounts",
        "column": "derivation_index"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "072-alter-table-protocol_subaccounts-add",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "protocol_subaccounts",
        "column": "derivation_path_version"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "073-do--begin-alter",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "constraint",
        "table": "protocol_subaccounts",
        "constraint": "protocol_subaccounts_derivation_index_positive",
        "definitionIncludes": [
          "CHECK (derivation_index IS NULL OR derivation_index >= 1)"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "074-do--begin-alter",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "constraint",
        "table": "protocol_subaccounts",
        "constraint": "protocol_subaccounts_derivation_dual_model",
        "definitionIncludes": [
          "CHECK ( (derivation_index IS NULL AND derivation_path_version IS NULL) OR (derivation_index IS NOT NULL AND derivation_path_version IS NOT NULL) )"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "075-insert-into-lab_strategies-user_id",
    "capabilities": [
      "lab"
    ],
    "requirements": [
      {
        "kind": "data",
        "identity": "migration-069-backfill",
        "checkSql": "SELECT NOT EXISTS (SELECT 1 FROM lab_strategies src WHERE src.user_id='BuhEYpvrWV1y18jZoY8Hgfyf2pj3nqYXvmPefvBVzk41' AND src.name IN ('SBR v1 – Structure Break & Retest','Adaptive Regime V3.8') AND NOT EXISTS (SELECT 1 FROM lab_strategies dest WHERE dest.user_id='AqTTQQajeKDjbDU5sb6JoQfTJ8HfHzpjne2sFmYthCez' AND dest.name=src.name)) AS ok"
      }
    ],
    "operation": "backfill"
  },
  {
    "id": "076-do--begin-alter",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "constraint",
        "table": "trading_bots",
        "constraint": "trading_bots_active_protocol_check",
        "definitionIncludes": [
          "CHECK (active_protocol IN ('pacifica', 'drift', 'flash'))"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "077-alter-table-bot_trades-alter",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "bot_trades",
        "column": "protocol"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "078-alter-table-lab_optimization_runs-add",
    "capabilities": [
      "lab"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "lab_optimization_runs",
        "column": "oos_fraction"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "079-alter-table-lab_optimization_runs-add",
    "capabilities": [
      "lab"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "lab_optimization_runs",
        "column": "slippage"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "080-alter-table-lab_optimization_runs-add",
    "capabilities": [
      "lab"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "lab_optimization_runs",
        "column": "parity_match"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "081-alter-table-lab_optimization_runs-add",
    "capabilities": [
      "lab"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "lab_optimization_runs",
        "column": "parity_diffs"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "082-alter-table-lab_optimization_results-add",
    "capabilities": [
      "lab"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "lab_optimization_results",
        "column": "is_metrics"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "083-alter-table-lab_optimization_results-add",
    "capabilities": [
      "lab"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "lab_optimization_results",
        "column": "oos_metrics"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "084-create-table-if-not",
    "capabilities": [
      "lab"
    ],
    "requirements": [
      {
        "kind": "table",
        "table": "lab_agent_tasks",
        "columns": [
          "id",
          "wallet_address",
          "status",
          "mode",
          "goal",
          "plan",
          "memory",
          "active_run_id",
          "owned_run_ids",
          "loop_count",
          "spend_estimate_usd",
          "stop_reason",
          "last_reconciled_at",
          "awaiting_since",
          "cancel_requested_at",
          "toolkit_version",
          "created_at",
          "updated_at"
        ],
        "constraintDefinitions": [
          "PRIMARY KEY (id)"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "085-create-index-if-not",
    "capabilities": [
      "lab"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "lab_agent_tasks",
        "index": "idx_lab_agent_tasks_wallet_status",
        "columns": [
          "wallet_address",
          "status"
        ],
        "unique": false
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "086-alter-table-lab_optimization_runs-add",
    "capabilities": [
      "lab"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "lab_optimization_runs",
        "column": "agent_task_id"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "087-alter-table-lab_optimization_runs-add",
    "capabilities": [
      "lab"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "lab_optimization_runs",
        "column": "agent_idempotency_key"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "088-alter-table-lab_optimization_runs-add",
    "capabilities": [
      "lab"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "lab_optimization_runs",
        "column": "agent_correlation_id"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "089-alter-table-lab_optimization_runs-add",
    "capabilities": [
      "lab"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "lab_optimization_runs",
        "column": "agent_owned"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "090-create-unique-index-if",
    "capabilities": [
      "lab"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "lab_optimization_runs",
        "index": "uq_lab_opt_runs_agent_idem",
        "columns": [
          "user_id",
          "agent_task_id",
          "agent_idempotency_key"
        ],
        "unique": true,
        "predicateIncludes": [
          "agent_idempotency_key IS NOT NULL"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "091-create-index-if-not",
    "capabilities": [
      "lab"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "lab_optimization_runs",
        "index": "idx_lab_opt_runs_agent_task",
        "columns": [
          "agent_task_id"
        ],
        "unique": false,
        "predicateIncludes": [
          "agent_task_id IS NOT NULL"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "092-create-table-if-not",
    "capabilities": [
      "lab"
    ],
    "requirements": [
      {
        "kind": "table",
        "table": "lab_agent_messages",
        "columns": [
          "id",
          "task_id",
          "role",
          "content",
          "suggested_actions",
          "created_at"
        ],
        "constraintDefinitions": [
          "PRIMARY KEY (id)",
          "role IN ('user','agent','tool')"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "093-create-index-if-not",
    "capabilities": [
      "lab"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "lab_agent_messages",
        "index": "idx_lab_agent_messages_task_created",
        "columns": [
          "task_id",
          "created_at",
          "id"
        ],
        "unique": false
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "094-alter-table-lab_agent_tasks-add",
    "capabilities": [
      "lab"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "lab_agent_tasks",
        "column": "turn_state"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "095-alter-table-lab_agent_tasks-add",
    "capabilities": [
      "lab"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "lab_agent_tasks",
        "column": "turn_lease"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "096-alter-table-lab_agent_tasks-add",
    "capabilities": [
      "lab"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "lab_agent_tasks",
        "column": "turn_lease_expires_at"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "097-alter-table-lab_agent_tasks-add",
    "capabilities": [
      "lab"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "lab_agent_tasks",
        "column": "turn_state_changed_at"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "098-alter-table-lab_agent_tasks-add",
    "capabilities": [
      "lab"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "lab_agent_tasks",
        "column": "step_index"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "099-alter-table-lab_agent_tasks-add",
    "capabilities": [
      "lab"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "lab_agent_tasks",
        "column": "current_step"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "100-create-table-if-not",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "table",
        "table": "vault_positions",
        "columns": [
          "id",
          "wallet_address",
          "asset_key",
          "mint",
          "token_amount_raw",
          "usdc_cost_basis",
          "status",
          "created_at",
          "updated_at"
        ],
        "constraintDefinitions": [
          "PRIMARY KEY (id)",
          "FOREIGN KEY (wallet_address) REFERENCES wallets(address) ON DELETE CASCADE",
          "UNIQUE (wallet_address, asset_key)"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "101-create-index-if-not",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "vault_positions",
        "index": "idx_vault_positions_wallet",
        "columns": [
          "wallet_address"
        ],
        "unique": false
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "102-alter-table-vault_positions-add",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "vault_positions",
        "column": "trading_bot_id"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "103-create-unique-index-if",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "vault_positions",
        "index": "vault_positions_account_unique",
        "columns": [
          "wallet_address",
          "asset_key"
        ],
        "unique": true,
        "predicateIncludes": [
          "trading_bot_id IS NULL"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "104-create-unique-index-if",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "vault_positions",
        "index": "vault_positions_bot_unique",
        "columns": [
          "wallet_address",
          "trading_bot_id",
          "asset_key"
        ],
        "unique": true,
        "predicateIncludes": [
          "trading_bot_id IS NOT NULL"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "105-create-index-if-not",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "vault_positions",
        "index": "idx_vault_positions_bot",
        "columns": [
          "trading_bot_id"
        ],
        "unique": false,
        "predicateIncludes": [
          "trading_bot_id IS NOT NULL"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "106-alter-table-vault_positions-drop",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "constraint_absent",
        "table": "vault_positions",
        "constraint": "vault_positions_wallet_asset_unique"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "107-create-table-if-not",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "table",
        "table": "yield_price_snapshots",
        "columns": [
          "id",
          "asset_key",
          "price_usdc_per_token",
          "as_of"
        ],
        "constraintDefinitions": [
          "PRIMARY KEY (id)"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "108-create-index-if-not",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "yield_price_snapshots",
        "index": "idx_yield_price_snapshots_asset_time",
        "columns": [
          "asset_key",
          "as_of"
        ],
        "unique": false
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "109-create-table-if-not",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "table",
        "table": "yield_apy_cache",
        "columns": [
          "asset_key",
          "apy",
          "apy_base",
          "apy_reward",
          "apy_mean_30d",
          "source",
          "pool_id",
          "as_of"
        ],
        "constraintDefinitions": [
          "PRIMARY KEY (asset_key)"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "110-create-table-if-not",
    "capabilities": [
      "sol_loop"
    ],
    "requirements": [
      {
        "kind": "table",
        "table": "loop_rate_samples",
        "columns": [
          "id",
          "vault_id",
          "symbol",
          "staking_apy",
          "staking_apy_mean_30d",
          "borrow_apr",
          "withdraw_utilization",
          "net_carry_2x",
          "liquidation_threshold",
          "as_of"
        ],
        "constraintDefinitions": [
          "PRIMARY KEY (id)"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "111-create-index-if-not",
    "capabilities": [
      "sol_loop"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "loop_rate_samples",
        "index": "idx_loop_rate_samples_vault_time",
        "columns": [
          "vault_id",
          "as_of"
        ],
        "unique": false
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "112-alter-table-loop_rate_samples-add",
    "capabilities": [
      "sol_loop"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "loop_rate_samples",
        "column": "liquidation_threshold"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "113-create-table-if-not",
    "capabilities": [
      "sol_loop"
    ],
    "requirements": [
      {
        "kind": "table",
        "table": "borrow_positions",
        "columns": [
          "id",
          "wallet_address",
          "trading_bot_id",
          "debt_venue",
          "venue_vault_id",
          "venue_position_id",
          "collateral_asset_key",
          "collateral_mint",
          "collateral_amount_raw",
          "debt_asset_key",
          "debt_mint",
          "debt_amount_raw",
          "attributed_bot_id",
          "status",
          "health_snapshot",
          "health_as_of",
          "health_source",
          "created_at",
          "updated_at"
        ],
        "constraintDefinitions": [
          "PRIMARY KEY (id)",
          "FOREIGN KEY (wallet_address) REFERENCES wallets(address) ON DELETE CASCADE"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "114-create-index-if-not",
    "capabilities": [
      "sol_loop"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "borrow_positions",
        "index": "idx_borrow_positions_wallet",
        "columns": [
          "wallet_address"
        ],
        "unique": false
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "115-create-index-if-not",
    "capabilities": [
      "sol_loop"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "borrow_positions",
        "index": "idx_borrow_positions_bot",
        "columns": [
          "trading_bot_id"
        ],
        "unique": false,
        "predicateIncludes": [
          "trading_bot_id IS NOT NULL"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "116-alter-table-borrow_positions-add",
    "capabilities": [
      "sol_loop"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "borrow_positions",
        "column": "venue_position_id"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "117-alter-table-borrow_positions-add",
    "capabilities": [
      "sol_loop"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "borrow_positions",
        "column": "last_observed_health_band"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "118-alter-table-borrow_positions-add",
    "capabilities": [
      "sol_loop"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "borrow_positions",
        "column": "health_band_changed_at"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "119-alter-table-borrow_positions-add",
    "capabilities": [
      "sol_loop"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "borrow_positions",
        "column": "last_health_alert_band"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "120-alter-table-borrow_positions-add",
    "capabilities": [
      "sol_loop"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "borrow_positions",
        "column": "last_health_alert_at"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "121-alter-table-borrow_positions-add",
    "capabilities": [
      "sol_loop"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "borrow_positions",
        "column": "last_auto_topup_attempt_at"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "122-alter-table-borrow_positions-add",
    "capabilities": [
      "sol_loop"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "borrow_positions",
        "column": "kind"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "123-alter-table-borrow_positions-add",
    "capabilities": [
      "sol_loop"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "borrow_positions",
        "column": "policy_state"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "124-alter-table-borrow_positions-add",
    "capabilities": [
      "sol_loop"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "borrow_positions",
        "column": "policy_reason"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "125-alter-table-borrow_positions-add",
    "capabilities": [
      "sol_loop"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "borrow_positions",
        "column": "policy_state_changed_at"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "126-alter-table-borrow_positions-add",
    "capabilities": [
      "sol_loop"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "borrow_positions",
        "column": "last_policy_action_at"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "127-create-table-if-not",
    "capabilities": [
      "sol_loop"
    ],
    "requirements": [
      {
        "kind": "table",
        "table": "loop_policy_decisions",
        "columns": [
          "id",
          "wallet_address",
          "borrow_position_id",
          "vault_id",
          "tick",
          "action",
          "fraction",
          "reason",
          "details",
          "created_at"
        ],
        "constraintDefinitions": [
          "PRIMARY KEY (id)",
          "FOREIGN KEY (wallet_address) REFERENCES wallets(address) ON DELETE CASCADE"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "128-create-index-if-not",
    "capabilities": [
      "sol_loop"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "loop_policy_decisions",
        "index": "idx_loop_policy_decisions_vault_time",
        "columns": [
          "vault_id",
          "created_at"
        ],
        "unique": false
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "129-create-index-if-not",
    "capabilities": [
      "sol_loop"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "loop_policy_decisions",
        "index": "idx_loop_policy_decisions_wallet",
        "columns": [
          "wallet_address"
        ],
        "unique": false
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "130-create-table-if-not",
    "capabilities": [
      "sol_loop"
    ],
    "requirements": [
      {
        "kind": "table",
        "table": "loop_tick_heartbeats",
        "columns": [
          "id",
          "tick",
          "evaluated",
          "acted",
          "failed",
          "skipped",
          "skip_reason_counts",
          "created_at"
        ],
        "constraintDefinitions": [
          "PRIMARY KEY (id)"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "131-alter-table-loop_tick_heartbeats-add",
    "capabilities": [
      "sol_loop"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "loop_tick_heartbeats",
        "column": "skipped"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "132-alter-table-loop_tick_heartbeats-add",
    "capabilities": [
      "sol_loop"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "loop_tick_heartbeats",
        "column": "skip_reason_counts"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "133-create-index-if-not",
    "capabilities": [
      "sol_loop"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "loop_tick_heartbeats",
        "index": "idx_loop_tick_heartbeats_tick_time",
        "columns": [
          "tick",
          "created_at"
        ],
        "unique": false
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "134-create-table-if-not",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "table",
        "table": "borrow_operations",
        "columns": [
          "id",
          "wallet_address",
          "borrow_position_id",
          "operation_type",
          "status",
          "step",
          "tx_signatures",
          "error",
          "created_at",
          "updated_at"
        ],
        "constraintDefinitions": [
          "PRIMARY KEY (id)",
          "FOREIGN KEY (wallet_address) REFERENCES wallets(address) ON DELETE CASCADE"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "135-create-index-if-not",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "borrow_operations",
        "index": "idx_borrow_operations_wallet",
        "columns": [
          "wallet_address"
        ],
        "unique": false
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "136-create-index-if-not",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "borrow_operations",
        "index": "idx_borrow_operations_position",
        "columns": [
          "borrow_position_id"
        ],
        "unique": false,
        "predicateIncludes": [
          "borrow_position_id IS NOT NULL"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "137-alter-table-borrow_operations-add",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "borrow_operations",
        "column": "client_request_id"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "138-alter-table-borrow_operations-add",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "borrow_operations",
        "column": "metadata"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "139-alter-table-borrow_operations-add",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "borrow_operations",
        "column": "result"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "140-create-unique-index-if",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "borrow_operations",
        "index": "uq_borrow_operations_client_req",
        "columns": [
          "wallet_address",
          "client_request_id"
        ],
        "unique": true,
        "predicateIncludes": [
          "client_request_id IS NOT NULL"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "141-create-table-if-not",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "table",
        "table": "fy_positions",
        "columns": [
          "id",
          "wallet_address",
          "venue",
          "market_address",
          "venue_vault_address",
          "pt_mint",
          "pt_decimals",
          "underlying_mint",
          "underlying_symbol",
          "pt_amount_raw",
          "cost_basis_usdc",
          "implied_apy_at_entry",
          "maturity_at",
          "status",
          "notified_maturity_at",
          "created_at",
          "updated_at"
        ],
        "constraintDefinitions": [
          "PRIMARY KEY (id)",
          "FOREIGN KEY (wallet_address) REFERENCES wallets(address) ON DELETE CASCADE"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "142-create-index-if-not",
    "capabilities": [
      "vault"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "fy_positions",
        "index": "idx_fy_positions_wallet",
        "columns": [
          "wallet_address"
        ],
        "unique": false
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "143-create-table-if-not",
    "capabilities": [
      "oracle"
    ],
    "requirements": [
      {
        "kind": "table",
        "table": "oracle_price_snapshots",
        "columns": [
          "id",
          "feed_id",
          "symbol",
          "price_usd",
          "publish_time_sec",
          "taken_at",
          "source"
        ],
        "constraintDefinitions": [
          "PRIMARY KEY (id)"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "144-create-index-if-not",
    "capabilities": [
      "oracle"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "oracle_price_snapshots",
        "index": "idx_oracle_snapshots_feed_taken",
        "columns": [
          "feed_id",
          "taken_at"
        ],
        "unique": false
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "145-create-table-if-not",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "table",
        "table": "scanner_incident_holds",
        "columns": [
          "id",
          "state",
          "active_slot",
          "export_row_count",
          "export_digest",
          "created_at",
          "canary_started_at",
          "exported_at",
          "released_at"
        ],
        "constraintDefinitions": [
          "PRIMARY KEY (id)",
          "state IN ('baseline', 'canary', 'exported', 'released')",
          "CHECK ( (state = 'released' AND active_slot IS NULL) OR (state <> 'released' AND active_slot = 1) )",
          "CHECK ( (state IN ('exported', 'released') AND export_row_count IS NOT NULL AND export_digest IS NOT NULL) OR (state IN ('baseline', 'canary') AND export_row_count IS NULL AND export_digest IS NULL) )"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "146-create-unique-index-if",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "scanner_incident_holds",
        "index": "scanner_incident_holds_active_slot_unique",
        "columns": [
          "active_slot"
        ],
        "unique": true
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "147-create-table-if-not",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "table",
        "table": "scanner_incident_occurrences",
        "columns": [
          "event_id",
          "hold_id",
          "window",
          "fingerprint",
          "observed_at",
          "category",
          "source",
          "summary",
          "context"
        ],
        "constraintDefinitions": [
          "PRIMARY KEY (event_id)",
          "FOREIGN KEY (hold_id) REFERENCES scanner_incident_holds(id) ON DELETE CASCADE",
          "\"window\" IN ('baseline', 'canary')",
          "category = 'scanner'"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "148-create-index-if-not",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "scanner_incident_occurrences",
        "index": "scanner_incident_occurrences_hold_order_idx",
        "columns": [
          "hold_id",
          "observed_at",
          "event_id"
        ],
        "unique": false
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "149-create-index-if-not",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "scanner_incident_occurrences",
        "index": "scanner_incident_occurrences_hold_fingerprint_idx",
        "columns": [
          "hold_id",
          "fingerprint"
        ],
        "unique": false
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "150-create-table-if-not",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "table",
        "table": "ai_trader_bots",
        "columns": [
          "id",
          "wallet_address",
          "protocol",
          "protocol_subaccount_id",
          "market",
          "timeframe",
          "mode",
          "risk_profile",
          "paper_mode",
          "auto_next",
          "model",
          "allocated_usdc",
          "max_leverage",
          "stop_policy",
          "park_when_idle",
          "graduation_state",
          "graduation_criteria",
          "trial_started_at",
          "graduated_at",
          "policy_hmac",
          "status",
          "pause_reason",
          "daily_realized_pnl",
          "consecutive_losses",
          "created_at",
          "updated_at"
        ],
        "constraintDefinitions": [
          "PRIMARY KEY (id)"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "151-create-index-if-not",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "ai_trader_bots",
        "index": "idx_ai_trader_bots_wallet",
        "columns": [
          "wallet_address"
        ],
        "unique": false
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "152-create-index-if-not",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "ai_trader_bots",
        "index": "idx_ai_trader_bots_status",
        "columns": [
          "status"
        ],
        "unique": false
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "153-create-table-if-not",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "table",
        "table": "ai_trader_decisions",
        "columns": [
          "id",
          "bot_id",
          "context_digest",
          "raw_decision",
          "clamped_decision",
          "guardrail_violations",
          "outcome",
          "entry_price",
          "exit_price",
          "exit_reason",
          "realized_pnl",
          "fees_paid",
          "llm_cost_usd",
          "llm_latency_ms",
          "decided_at",
          "closed_at"
        ],
        "constraintDefinitions": [
          "PRIMARY KEY (id)",
          "FOREIGN KEY (bot_id) REFERENCES ai_trader_bots(id) ON DELETE CASCADE"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "154-create-index-if-not",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "ai_trader_decisions",
        "index": "idx_ai_trader_decisions_bot_decided",
        "columns": [
          "bot_id",
          "decided_at DESC"
        ],
        "unique": false
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "155-create-index-if-not",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "ai_trader_decisions",
        "index": "idx_ai_trader_decisions_executed",
        "columns": [
          "bot_id",
          "decided_at DESC"
        ],
        "unique": false,
        "predicateIncludes": [
          "outcome = 'executed'"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "156-alter-table-wallets-add",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "wallets",
        "column": "ai_trader_free_calls_used"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "157-alter-table-ai_trader_bots-add",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "ai_trader_bots",
        "column": "bot_subaccount_key_encrypted_v3"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "158-alter-table-ai_trader_bots-add",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "ai_trader_bots",
        "column": "derivation_index"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "159-alter-table-ai_trader_bots-add",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "ai_trader_bots",
        "column": "derivation_path_version"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "160-alter-table-ai_trader_decisions-add",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "ai_trader_decisions",
        "column": "model_used"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "161-update-ai_trader_decisions-d-set",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "data",
        "identity": "migration-150-backfill",
        "checkSql": "SELECT NOT EXISTS (SELECT 1 FROM ai_trader_decisions d JOIN ai_trader_bots b ON b.id=d.bot_id WHERE d.model_used IS NULL) AS ok"
      }
    ],
    "operation": "backfill"
  },
  {
    "id": "162-alter-table-ai_trader_bots-add",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "ai_trader_bots",
        "column": "sizing_mode"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "163-alter-table-ai_trader_bots-add",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "ai_trader_bots",
        "column": "risk_min_pct"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "164-alter-table-ai_trader_bots-add",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "ai_trader_bots",
        "column": "risk_max_pct"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "165-create-table-if-not",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "table",
        "table": "cot_snapshots",
        "columns": [
          "id",
          "report_date",
          "commercial_net",
          "noncomm_net",
          "nonrept_net",
          "dumb_net",
          "comm_index",
          "noncomm_index",
          "nonrept_index",
          "dumb_index",
          "state",
          "weeks_in_window",
          "fetched_at"
        ],
        "constraintDefinitions": [
          "PRIMARY KEY (id)"
        ]
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "166-create-index-if-not",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "cot_snapshots",
        "index": "idx_cot_snapshots_report_date",
        "columns": [
          "report_date DESC"
        ],
        "unique": false
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "167-alter-table-ai_trader_bots-add",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "ai_trader_bots",
        "column": "playbook"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "168-alter-table-ai_trader_bots-add",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "ai_trader_bots",
        "column": "playbook_version"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "169-alter-table-ai_trader_bots-add",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "ai_trader_bots",
        "column": "playbook_updated_at"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "170-alter-table-ai_trader_bots-add",
    "capabilities": [
      "ai_trader"
    ],
    "requirements": [
      {
        "kind": "column",
        "table": "ai_trader_bots",
        "column": "market_source"
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "171-create-index-if-not",
    "capabilities": [
      "portfolio"
    ],
    "requirements": [
      {
        "kind": "index",
        "table": "equity_events",
        "index": "idx_equity_events_bot_created",
        "columns": [
          "trading_bot_id",
          "created_at DESC"
        ],
        "unique": false
      }
    ],
    "operation": "ddl"
  },
  {
    "id": "172-scrub-rogue-avax-close",
    "capabilities": [
      "signal_bot"
    ],
    "requirements": [
      {
        "kind": "data",
        "identity": "rogue-avax-close-491abec1-absent",
        "checkSql": "SELECT NOT EXISTS (SELECT 1 FROM bot_trades WHERE id='491abec1-39c2-42c5-8963-e5f4fb644b3a') AS ok"
      }
    ],
    "operation": "backfill"
  }
] as const;

export const SCHEMA_MIGRATION_MANIFEST: readonly SchemaMigrationDefinition[] =
  schemaMigrationSql.map((sql, index) => {
    const metadataEntry = schemaMigrationMetadata[index];
    if (!metadataEntry) throw new Error(`missing schema migration metadata at index ${index}`);
    return { ...metadataEntry, sql } as SchemaMigrationDefinition;
  });

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
