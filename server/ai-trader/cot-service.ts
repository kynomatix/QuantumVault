// COT-A: CFTC Bitcoin Legacy futures-only COT positioning signal.
// Fetches, computes 120-week rolling indices, classifies crossover state,
// and caches with lazy refresh on read. Fail-open: any fetch/parse/DB error
// means the signal is absent; nothing blocks a decision.
//
// Phase B integration note: getCotSnapshot() consumers MUST also add the
// snapshot to the decision's contextDigest:
//   contextDigest.cotSignal = { state, commIndex, dumbIndex, reportDate }
// The context-builder does this in Phase B. The field is already defined on
// CotSnapshot so the interface is stable across phases.
//
// Verified live against publicreporting.cftc.gov 2026-07-12:
//   Dataset: 6dca-aqww
//   Fields:  comm_positions_long_all, comm_positions_short_all,
//            noncomm_positions_long_all, noncomm_positions_short_all,
//            nonrept_positions_long_all, nonrept_positions_short_all
//   Filter:  cftc_contract_market_code='133741' AND futonly_or_combined='FutOnly'
//   Date:    report_date_as_yyyy_mm_dd (ISO string — slice to 10 chars)

import { db } from '../db.js';
import { cotSnapshots } from '../../shared/schema.js';
import { desc, sql } from 'drizzle-orm';

// ─── Constants ───────────────────────────────────────────────────────────────

const DATASET_ID = '6dca-aqww';
const CONTRACT_CODE = '133741';
const SOCRATA_URL = `https://publicreporting.cftc.gov/resource/${DATASET_ID}.json`;

export const INDEX_WINDOW = 120;       // weeks required for a valid index
const BACKFILL_LIMIT = 135;            // fetch 135 rows: 120 window + 15 buffer
const STALE_THRESHOLD_MS = 9 * 24 * 60 * 60 * 1000;  // 9 days (tolerates holiday shifts)

// ─── Public types ─────────────────────────────────────────────────────────────

export type CotState = 'bullish_flip' | 'bearish_flip' | 'neutral' | 'insufficient_data';

/** Snapshot returned to callers. null means fail-open: signal absent this cycle. */
export interface CotSnapshot {
  reportDate: string;          // YYYY-MM-DD of the CFTC report
  commercialNet: number;       // comm long − short (smart money net position)
  noncommNet: number;          // non-commercial net
  nonreptNet: number;          // non-reportable net
  dumbNet: number;             // noncomm + nonrept combined ("dumb money" net)
  commIndex: number;           // smart line 0–100 (120-week COT index)
  dumbIndex: number;           // dumb line 0–100
  noncommIndex: number;        // individual noncomm index (for transparency)
  nonreptIndex: number;        // individual nonrept index (for transparency)
  state: CotState;
  weeksInWindow: number;       // always >= INDEX_WINDOW for valid snapshots
  fetchedAt: Date;
  // Phase B: inject into contextDigest.cotSignal = { state, commIndex, dumbIndex, reportDate }
}

// ─── Internal types ───────────────────────────────────────────────────────────

/** Raw row parsed from the CFTC Socrata API response. */
export interface CftcRawRow {
  reportDate: string;    // YYYY-MM-DD
  commLong: number;
  commShort: number;
  noncommLong: number;
  noncommShort: number;
  nonreptLong: number;
  nonreptShort: number;
}

/** Computed row with rolling indices (null if window < INDEX_WINDOW). */
export interface ComputedRow {
  reportDate: string;
  commercialNet: number;
  noncommNet: number;
  nonreptNet: number;
  dumbNet: number;
  commIndex: number | null;
  noncommIndex: number | null;
  nonreptIndex: number | null;
  dumbIndex: number | null;
  weeksInWindow: number;
}

// ─── Pure math (exported for unit tests) ─────────────────────────────────────

/**
 * COT Index formula: (net − lowest_N) / (highest_N − lowest_N) × 100.
 * Returns null when the window is flat (max === min) — undefined in that case.
 * windowNets must include the current row's net as its last element.
 */
export function cotIndex(net: number, windowNets: number[]): number | null {
  const lo = Math.min(...windowNets);
  const hi = Math.max(...windowNets);
  if (hi === lo) return null;
  return ((net - lo) / (hi - lo)) * 100;
}

/**
 * Given rows sorted ASC (oldest first), compute rolling INDEX_WINDOW-week
 * COT indices for each row.
 *
 * Rows where the available window is < INDEX_WINDOW get null indices and
 * state 'insufficient_data' — these rows are stored in the DB for history
 * but must never be returned as a valid snapshot.
 */
export function computeRollingIndices(rows: CftcRawRow[]): ComputedRow[] {
  return rows.map((row, i) => {
    const windowStart = Math.max(0, i - INDEX_WINDOW + 1);
    const window = rows.slice(windowStart, i + 1);
    const weeksInWindow = window.length;

    const commNet    = row.commLong    - row.commShort;
    const noncommNet = row.noncommLong - row.noncommShort;
    const nonreptNet = row.nonreptLong - row.nonreptShort;
    const dumbNet    = noncommNet + nonreptNet;

    if (weeksInWindow < INDEX_WINDOW) {
      return {
        reportDate: row.reportDate,
        commercialNet: commNet, noncommNet, nonreptNet, dumbNet,
        commIndex: null, noncommIndex: null, nonreptIndex: null, dumbIndex: null,
        weeksInWindow,
      };
    }

    const commNets    = window.map(r => r.commLong    - r.commShort);
    const noncommNets = window.map(r => r.noncommLong - r.noncommShort);
    const nonreptNets = window.map(r => r.nonreptLong - r.nonreptShort);
    const dumbNets    = window.map(r => (r.noncommLong - r.noncommShort) + (r.nonreptLong - r.nonreptShort));

    return {
      reportDate: row.reportDate,
      commercialNet: commNet, noncommNet, nonreptNet, dumbNet,
      commIndex:    cotIndex(commNet,    commNets),
      noncommIndex: cotIndex(noncommNet, noncommNets),
      nonreptIndex: cotIndex(nonreptNet, nonreptNets),
      dumbIndex:    cotIndex(dumbNet,    dumbNets),
      weeksInWindow,
    };
  });
}

/**
 * Classify the COT state for a row given the PREVIOUS row's indices.
 * - bearish_flip: smart was ≥ dumb last week, now smart < dumb (distribution into retail)
 * - bullish_flip: smart was ≤ dumb last week, now smart > dumb (accumulation vs retail exit)
 * - neutral:      no crossover this week
 * - insufficient_data: current indices are null (window < INDEX_WINDOW)
 */
export function classifyState(
  curr: { commIndex: number | null; dumbIndex: number | null },
  prev: { commIndex: number | null; dumbIndex: number | null } | null,
): CotState {
  if (curr.commIndex === null || curr.dumbIndex === null) return 'insufficient_data';
  if (!prev || prev.commIndex === null || prev.dumbIndex === null) return 'neutral';

  const wasSmartAbove = prev.commIndex >= prev.dumbIndex;
  const isSmartAbove  = curr.commIndex >= curr.dumbIndex;

  if (wasSmartAbove && !isSmartAbove) return 'bearish_flip';
  if (!wasSmartAbove && isSmartAbove)  return 'bullish_flip';
  return 'neutral';
}

// ─── CFTC API fetch ───────────────────────────────────────────────────────────

function parseCftcRow(raw: Record<string, string>): CftcRawRow {
  return {
    reportDate:  raw.report_date_as_yyyy_mm_dd.slice(0, 10),
    commLong:    parseInt(raw.comm_positions_long_all,    10),
    commShort:   parseInt(raw.comm_positions_short_all,   10),
    noncommLong: parseInt(raw.noncomm_positions_long_all, 10),
    noncommShort:parseInt(raw.noncomm_positions_short_all,10),
    nonreptLong: parseInt(raw.nonrept_positions_long_all, 10),
    nonreptShort:parseInt(raw.nonrept_positions_short_all,10),
  };
}

/**
 * Fetch N rows from the CFTC Socrata API (futures-only, BTC CME).
 * Returns rows sorted ASC (oldest first) for index computation.
 * Throws on network or HTTP error — caller handles fail-open.
 */
export async function fetchCftcRows(limit: number): Promise<CftcRawRow[]> {
  const params = new URLSearchParams({
    '$where':  `cftc_contract_market_code='${CONTRACT_CODE}' AND futonly_or_combined='FutOnly'`,
    '$order':  'report_date_as_yyyy_mm_dd DESC',
    '$limit':  String(limit),
    '$select': [
      'report_date_as_yyyy_mm_dd',
      'comm_positions_long_all',  'comm_positions_short_all',
      'noncomm_positions_long_all','noncomm_positions_short_all',
      'nonrept_positions_long_all','nonrept_positions_short_all',
    ].join(','),
  });

  const res = await fetch(`${SOCRATA_URL}?${params}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`CFTC Socrata ${res.status}: ${res.statusText}`);

  const json = (await res.json()) as Record<string, string>[];
  // Sort ASC for rolling index computation
  return json.map(parseCftcRow).sort((a, b) => a.reportDate.localeCompare(b.reportDate));
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function getDbRowCount(): Promise<number> {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(cotSnapshots);
  return n;
}

async function getLatestDbRow(): Promise<typeof cotSnapshots.$inferSelect | null> {
  const rows = await db.select().from(cotSnapshots)
    .orderBy(desc(cotSnapshots.reportDate)).limit(1);
  return rows[0] ?? null;
}

async function upsertComputedRows(computed: ComputedRow[], states: CotState[]): Promise<void> {
  const now = new Date();
  for (let i = 0; i < computed.length; i++) {
    const r = computed[i];
    const v = {
      reportDate:    r.reportDate,
      commercialNet: r.commercialNet,
      noncommNet:    r.noncommNet,
      nonreptNet:    r.nonreptNet,
      dumbNet:       r.dumbNet,
      commIndex:     r.commIndex    != null ? r.commIndex.toFixed(2)    : null,
      noncommIndex:  r.noncommIndex != null ? r.noncommIndex.toFixed(2) : null,
      nonreptIndex:  r.nonreptIndex != null ? r.nonreptIndex.toFixed(2) : null,
      dumbIndex:     r.dumbIndex    != null ? r.dumbIndex.toFixed(2)    : null,
      state:         states[i],
      weeksInWindow: r.weeksInWindow,
      fetchedAt:     now,
    };
    await db.insert(cotSnapshots).values(v)
      .onConflictDoUpdate({ target: cotSnapshots.reportDate, set: v });
  }
}

// ─── Sync: fetch → compute → upsert ──────────────────────────────────────────

/** Full fetch-and-recompute. Used for both initial backfill and periodic refresh. */
async function fullSync(limit = BACKFILL_LIMIT): Promise<void> {
  const rows     = await fetchCftcRows(limit);
  const computed = computeRollingIndices(rows);
  const states   = computed.map((row, i) =>
    classifyState(
      { commIndex: row.commIndex,    dumbIndex: row.dumbIndex },
      i > 0 ? { commIndex: computed[i - 1].commIndex, dumbIndex: computed[i - 1].dumbIndex } : null,
    ),
  );
  await upsertComputedRows(computed, states);
  const valid = computed.filter(r => r.weeksInWindow >= INDEX_WINDOW).length;
  console.log(`[CotService] Synced ${computed.length} rows, ${valid} with full ${INDEX_WINDOW}-week window`);
}

// ─── In-flight deduplication ──────────────────────────────────────────────────

let _syncInFlight: Promise<void> | null = null;

function triggerSyncIfIdle(limit?: number): void {
  if (_syncInFlight) return;
  _syncInFlight = fullSync(limit).catch(err => {
    console.warn('[CotService] Background sync failed (fail-open):', err instanceof Error ? err.message : err);
  }).finally(() => {
    _syncInFlight = null;
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Return the latest valid COT snapshot (fail-open: null if unavailable).
 *
 * Lazy-refresh behaviour:
 *   - Empty DB → awaits a full backfill (first call is slow by design)
 *   - Stale DB (> 9 days) → returns stale cache AND kicks off background refresh
 *   - Fresh DB → returns cache immediately, no network
 *
 * Amendment A1 (audit): an index computed off < INDEX_WINDOW weeks of data is
 * treated as unavailable and this function returns null (fail-open).
 *
 * Amendment A2 (audit): callers that record a decision MUST add the snapshot to
 * contextDigest.cotSignal = { state, commIndex, dumbIndex, reportDate }.
 * This is Phase B's responsibility; the field is annotated on CotSnapshot above.
 */
export async function getCotSnapshot(): Promise<CotSnapshot | null> {
  try {
    // ── Step 1: backfill if we don't have enough history ──────────────────────
    const count = await getDbRowCount();
    if (count < INDEX_WINDOW) {
      // Await the backfill — we can't serve a valid index without it.
      if (_syncInFlight) {
        await _syncInFlight;
      } else {
        _syncInFlight = fullSync(BACKFILL_LIMIT);
        try { await _syncInFlight; } finally { _syncInFlight = null; }
      }
    }

    // ── Step 2: check freshness of the latest row ─────────────────────────────
    const latest = await getLatestDbRow();
    if (!latest) return null;  // DB empty even after backfill attempt

    const ageMs = Date.now() - new Date(latest.fetchedAt).getTime();
    if (ageMs > STALE_THRESHOLD_MS) {
      // Kick off background refresh; serve stale cache this cycle (fail-open)
      triggerSyncIfIdle();
    }

    // ── Step 3: return null if the latest row has insufficient history ─────────
    // Amendment A1: index computed off < 120 weeks is treated as unavailable.
    if (latest.weeksInWindow < INDEX_WINDOW) return null;
    if (latest.commIndex == null || latest.dumbIndex == null) return null;

    return {
      reportDate:    latest.reportDate,
      commercialNet: latest.commercialNet,
      noncommNet:    latest.noncommNet,
      nonreptNet:    latest.nonreptNet,
      dumbNet:       latest.dumbNet,
      commIndex:     parseFloat(latest.commIndex),
      dumbIndex:     parseFloat(latest.dumbIndex),
      noncommIndex:  parseFloat(latest.noncommIndex ?? '0'),
      nonreptIndex:  parseFloat(latest.nonreptIndex ?? '0'),
      state:         latest.state as CotState,
      weeksInWindow: latest.weeksInWindow,
      fetchedAt:     new Date(latest.fetchedAt),
    };
  } catch (err) {
    console.warn('[CotService] getCotSnapshot error (fail-open):', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Optional: call at startup/weekly schedule to warm the cache before the
 * first bot fires. Belt-and-suspenders — lazy refresh in getCotSnapshot()
 * is sufficient; this just ensures the cache is warm ahead of time.
 */
export async function warmCotCache(): Promise<void> {
  try {
    const count = await getDbRowCount();
    if (count < INDEX_WINDOW) {
      await fullSync(BACKFILL_LIMIT);
      return;
    }
    const latest = await getLatestDbRow();
    if (!latest) return;
    const ageMs = Date.now() - new Date(latest.fetchedAt).getTime();
    if (ageMs > STALE_THRESHOLD_MS) {
      await fullSync(BACKFILL_LIMIT);
    }
  } catch (err) {
    console.warn('[CotService] warmCotCache error (non-fatal):', err instanceof Error ? err.message : err);
  }
}
