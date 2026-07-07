/**
 * Oracle Snapshot Recorder — HERMES_EXIT_PLAN Phase 3b (READ-ONLY, additive).
 *
 * Every 5 minutes:
 *   1. Reads on-chain Pyth prices for all borrow-gate feeds + Flash crypto feeds
 *      (single batched getMultipleAccountsInfo RPC call via onchain-pyth-reader).
 *   2. Persists rows to oracle_price_snapshots table + bounded in-memory ring.
 *   3. [OracleShadow] logs: compares on-chain price vs Hermes for each
 *      borrow-gate feed — age, bps deviation, stale flag. Logging only.
 *   4. Prunes DB rows older than 26 hours (hourly, best-effort).
 *
 * STRICTLY READ-ONLY AND ADDITIVE:
 *   - No changes to borrow-oracle-freshness.ts, borrow-risk-policy.ts,
 *     borrow-eligibility.ts, or any money-path file.
 *   - Shadow log feeds no decision — gate logic is untouched.
 *
 * Gated by ORACLE_SNAPSHOT_DISABLED=true (default: enabled).
 * Mirrors the singleton lifecycle style of spine-service.ts.
 */

import { db } from '../db.js';
import { oraclePriceSnapshots } from '@shared/schema';
import { readFeedsAll, type OnchainPricePoint } from './onchain-pyth-reader.js';
import { getAllBorrowOracleEntries } from './borrow-oracle-registry.js';
import { FLASH_MARKET_SPECS } from '../protocol/flash/flash-constants.js';
import { getHermesBase, getHermesHeaders } from '../pricing/hermes-config.js';
import { sql } from 'drizzle-orm';

const TICK_INTERVAL_MS = 5 * 60 * 1000;   // 5 minutes
const RING_MAX_AGE_MS = 26 * 60 * 60 * 1000;  // 26 hours
const HERMES_TIMEOUT_MS = 8000;
const ORACLE_STALE_SEC = 120;

// ─── Feed descriptors, built once at module load ──────────────────────────────

export interface FeedDescriptor {
  feedId: string;  // hex, no 0x
  symbol: string;
  isBorrowFeed: boolean;
}

function buildFeedList(): FeedDescriptor[] {
  const seen = new Set<string>();
  const list: FeedDescriptor[] = [];

  // 1. Borrow-gate feeds (shadow-logged against Hermes on every tick).
  for (const entry of getAllBorrowOracleEntries()) {
    const id = entry.feedId.trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    list.push({ feedId: id, symbol: entry.symbol, isBorrowFeed: true });
  }

  // 2. Flash crypto non-virtual feeds (tracked but not shadow-logged).
  //    Skip if already covered by the borrow registry.
  for (const spec of FLASH_MARKET_SPECS) {
    if (spec.isVirtual) continue;
    if (!spec.category.includes('crypto')) continue;
    const id = spec.pythPriceId?.trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    list.push({ feedId: id, symbol: spec.flashSymbol, isBorrowFeed: false });
  }

  return list;
}

export const FEED_LIST: FeedDescriptor[] = buildFeedList();
const BORROW_FEEDS: FeedDescriptor[] = FEED_LIST.filter((f) => f.isBorrowFeed);

// Expose for testing (shape / deduplication / content checks).
export function getFeedList(): FeedDescriptor[] {
  return FEED_LIST;
}

// ─── In-memory ring ───────────────────────────────────────────────────────────

export interface SnapshotEntry {
  feedId: string;
  symbol: string;
  priceUsd: number;
  publishTimeSec: number;
  takenAt: Date;
}

const _ring: SnapshotEntry[] = [];

function pruneRing(): void {
  const cutoff = Date.now() - RING_MAX_AGE_MS;
  let i = 0;
  while (i < _ring.length && _ring[i].takenAt.getTime() < cutoff) i++;
  if (i > 0) _ring.splice(0, i);
}

/**
 * Returns ring entries matching the optional feedId and sinceMs filters.
 * Results are in insertion order (oldest first).
 */
export function getRecentSnapshots(
  feedId?: string,
  sinceMs: number = Date.now() - RING_MAX_AGE_MS,
): SnapshotEntry[] {
  return _ring.filter(
    (e) =>
      e.takenAt.getTime() >= sinceMs &&
      (feedId == null || e.feedId === feedId),
  );
}

/** Test-only: clear the ring to isolate tests. */
export function _clearRingForTest(): void {
  _ring.splice(0, _ring.length);
}

/** Test-only: push a synthetic entry to the ring. */
export function _pushRingForTest(entry: SnapshotEntry): void {
  _ring.push(entry);
}

// ─── Hermes shadow fetch ──────────────────────────────────────────────────────

interface HermesPricePoint {
  priceUsd: number;
  publishTimeSec: number;
}

async function fetchHermesBatch(
  feeds: FeedDescriptor[],
): Promise<Map<string, HermesPricePoint>> {
  const out = new Map<string, HermesPricePoint>();
  if (feeds.length === 0) return out;

  const hermesBase = getHermesBase().replace(/\/+$/, '');
  const idsQuery = feeds.map((f) => `ids[]=${f.feedId}`).join('&');
  const url = `${hermesBase}/v2/updates/price/latest?${idsQuery}&parsed=true`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HERMES_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: getHermesHeaders() });
    clearTimeout(timer);
    if (!res.ok) return out;
    const json: unknown = await res.json();
    const parsed = Array.isArray((json as any)?.parsed) ? (json as any).parsed : [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const rawId = typeof entry.id === 'string'
        ? entry.id.toLowerCase().replace(/^0x/, '')
        : null;
      if (!rawId) continue;
      const p = entry.price;
      if (!p || typeof p !== 'object') continue;
      const price = Number(p.price);
      const expo = Number(p.expo);
      const pub = Number(p.publish_time);
      if (!Number.isFinite(price) || !Number.isFinite(expo) || !Number.isFinite(pub)) continue;
      const priceUsd = price * Math.pow(10, expo);
      if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;
      out.set(rawId, { priceUsd, publishTimeSec: pub });
    }
  } catch {
    clearTimeout(timer);
    // Hermes unavailable — shadow log shows hermes=n/a for all affected feeds.
  }
  return out;
}

// ─── Shadow logging ───────────────────────────────────────────────────────────

function logShadow(
  onchainMap: Map<string, OnchainPricePoint | null>,
  hermesMap: Map<string, HermesPricePoint>,
  nowSec: number,
): void {
  for (const desc of BORROW_FEEDS) {
    const onchain = onchainMap.get(desc.feedId);
    const hermes = hermesMap.get(desc.feedId);

    const onchainAge = onchain != null ? nowSec - onchain.publishTimeSec : null;
    const staleFlag = onchainAge != null && onchainAge > ORACLE_STALE_SEC ? ' STALE' : '';

    let bpsDiff: string;
    if (onchain != null && hermes != null) {
      const diff = Math.abs(onchain.priceUsd / hermes.priceUsd - 1) * 10_000;
      bpsDiff = `${diff.toFixed(1)}bps`;
    } else {
      bpsDiff = 'n/a';
    }

    const onchainStr =
      onchain != null
        ? `$${onchain.priceUsd.toPrecision(6)} age=${onchainAge}s${staleFlag}`
        : 'n/a';
    const hermesStr = hermes != null ? `$${hermes.priceUsd.toPrecision(6)}` : 'n/a';

    console.log(
      `[OracleShadow] symbol=${desc.symbol} feed=${desc.feedId.slice(0, 8)}… ` +
        `onchain=${onchainStr} hermes=${hermesStr} diff=${bpsDiff}`,
    );
  }
}

// ─── Main tick ────────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  if (FEED_LIST.length === 0) return;

  const takenAt = new Date();
  const nowSec = Math.floor(takenAt.getTime() / 1000);
  const feedIds = FEED_LIST.map((f) => f.feedId);

  // One batched RPC call for all feeds.
  const priceMap = await readFeedsAll(feedIds);

  // Build DB insert batch.
  const toInsert: (typeof oraclePriceSnapshots.$inferInsert)[] = [];
  for (const desc of FEED_LIST) {
    const pt = priceMap.get(desc.feedId);
    if (pt == null) continue;
    const entry: SnapshotEntry = {
      feedId: desc.feedId,
      symbol: desc.symbol,
      priceUsd: pt.priceUsd,
      publishTimeSec: pt.publishTimeSec,
      takenAt,
    };
    _ring.push(entry);
    toInsert.push({
      feedId: desc.feedId,
      symbol: desc.symbol,
      priceUsd: pt.priceUsd,
      publishTimeSec: pt.publishTimeSec,
      takenAt,
      source: 'onchain',
    });
  }

  // Persist to DB (best-effort; a DB error does not break the ring or shadow log).
  if (toInsert.length > 0) {
    db.insert(oraclePriceSnapshots).values(toInsert).catch((err: unknown) => {
      console.error('[OracleSnapshot] DB insert error:', err);
    });
  }

  pruneRing();

  // Prune DB rows older than 26h — run roughly once per hour.
  const nowMin = Math.floor(takenAt.getTime() / 60_000);
  if (nowMin % 60 === 0) {
    db.delete(oraclePriceSnapshots)
      .where(sql`taken_at < now() - interval '26 hours'`)
      .catch((err: unknown) => {
        console.error('[OracleSnapshot] DB prune error:', err);
      });
  }

  // Shadow logging: compare on-chain vs Hermes for each borrow-gate feed.
  if (BORROW_FEEDS.length > 0) {
    const hermesMap = await fetchHermesBatch(BORROW_FEEDS);
    logShadow(priceMap, hermesMap, nowSec);
  }

  const succeeded = toInsert.length;
  const failed = FEED_LIST.length - succeeded;
  console.log(
    `[OracleSnapshot] tick done — ${succeeded}/${FEED_LIST.length} feeds read ` +
      `(${failed} null). ring=${_ring.length} entries.`,
  );
}

// ─── Singleton lifecycle ──────────────────────────────────────────────────────

let _timer: ReturnType<typeof setInterval> | null = null;

export function isOracleSnapshotRecorderEnabled(): boolean {
  return process.env.ORACLE_SNAPSHOT_DISABLED !== 'true';
}

export function initOracleSnapshotRecorder(): void {
  if (!isOracleSnapshotRecorderEnabled()) {
    console.log('[OracleSnapshot] ORACLE_SNAPSHOT_DISABLED=true — recorder disabled');
    return;
  }
  if (_timer) {
    console.warn('[OracleSnapshot] already initialized; ignoring duplicate init');
    return;
  }

  console.log(
    `[OracleSnapshot] started — ${FEED_LIST.length} feeds ` +
      `(${BORROW_FEEDS.length} borrow-gate shadow-logged, ` +
      `${FEED_LIST.length - BORROW_FEEDS.length} Flash crypto). ` +
      `Tick: 5 min. [OracleShadow] logs every tick.`,
  );

  // First tick immediately, then every 5 min.
  tick().catch((err: unknown) => console.error('[OracleSnapshot] first tick error:', err));

  _timer = setInterval(() => {
    tick().catch((err: unknown) => console.error('[OracleSnapshot] tick error:', err));
  }, TICK_INTERVAL_MS);
  _timer.unref?.();
}

export function stopOracleSnapshotRecorder(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    console.log('[OracleSnapshot] stopped');
  }
}
