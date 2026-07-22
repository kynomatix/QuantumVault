/**
 * Task 119 snapshot rollup recompute (batched, O(snapshots + events) per
 * wallet): ONE equity_events fetch + ONE classification pass, then a sorted
 * pointer walk accumulating running cumulatives.
 *
 * WO-21 history:
 * - The original implementation re-fetched and re-classified the wallet's
 *   entire event history per snapshot row — O(S×E) with ~696 full table
 *   fetches on every boot, the cause of the ~26-minute post-publish
 *   degradation windows.
 * - Per the WO-21 addendum, the automatic boot-time invocation was REMOVED
 *   entirely (see server/index.ts). Task 119 already recomputed successfully
 *   across repeated production boots; new snapshots get correct rollups at
 *   creation time (portfolio-snapshot-job.ts), and late historical deposits
 *   are handled by the deposit reconciler calling recomputeWalletSnapshots.
 *   A future formula migration must ship its own explicitly versioned,
 *   cross-process-safe work order — this module deliberately has NO
 *   process-local or persistent "run once" gate.
 *
 * Formulas are UNCHANGED from the original per-row implementation — the
 * equivalence tests in tests/portfolio-backfill/ are the proof.
 *
 * It does NOT attempt to backfill on-chain block times for historical
 * agent_deposit events whose `tx_block_time IS NULL` — the deposit reconciler
 * will set it for future inserts, and for historical rows we fall back to the
 * existing `created_at`. That fallback is correct for non-reconciler deposits
 * (those rows were inserted at confirm-time so created_at ≈ block time).
 */
import Decimal from "decimal.js";
import { storage } from "./storage";
import { db } from "./db";
import { portfolioDailySnapshots, equityEvents } from "@shared/schema";
import { asc, eq } from "drizzle-orm";
import { classifyEquityEvent, type EquityEventCategory } from "./equity-event-classifier";

const LOG_PREFIX = "[PortfolioBackfill]";

/** All seven written columns are decimal(…, 6) — normalize at this scale. */
const DB_DECIMAL_SCALE = 6;

/** A pre-classified equity-event flow. `amount` is already Math.abs()'d. */
export interface ClassifiedFlowEvent {
  time: Date;
  category: Exclude<EquityEventCategory, "ignore">;
  amount: number;
}

/** Minimal structural view of a snapshot row needed for the rollup math. */
export interface RollupSnapshotInput {
  id: string;
  snapshotDate: Date;
  totalBalance: string;
}

export interface SnapshotRollupSet {
  cumulativeExternalDeposits: string;
  cumulativeExternalWithdrawals: string;
  cumulativeInternalTransfers: string;
  cumulativeTradingPnl: string;
  netExternalFlow: string;
  pnlPercent: string;
  netPnl: string;
}

/**
 * Pure rollup math (exported for tests). Sorts both inputs ascending
 * internally — callers may pass unsorted arrays.
 *
 * Tie semantics match the original per-row code exactly: the old filter was
 * `if (asOf && eventTime > asOf) continue;`, i.e. events with
 * eventTime <= snapshotDate are INCLUDED in that snapshot's cumulative.
 *
 * Deterministic ordering for equal timestamps: Array.prototype.sort is
 * stable (ES2019+), so events with identical `time` are processed in the
 * caller's input order. getWalletClassifiedFlowEvents fetches events ordered
 * by (created_at, id), which makes the full pipeline deterministic across
 * runs. (Summation order for a tied group cannot change WHICH snapshot the
 * events land in — ties only reorder additions within one cutoff group.)
 */
export function computeSnapshotRollups(
  snapshots: RollupSnapshotInput[],
  events: ClassifiedFlowEvent[],
): Array<{ id: string; set: SnapshotRollupSet }> {
  const snaps = [...snapshots].sort(
    (a, b) => a.snapshotDate.getTime() - b.snapshotDate.getTime(),
  );
  const evts = [...events].sort((a, b) => a.time.getTime() - b.time.getTime());

  let i = 0;
  let deposits = 0;
  let withdrawals = 0;
  let internalTransfers = 0;
  let prevExtDeposits = 0;
  let prevExtWithdrawals = 0;

  const out: Array<{ id: string; set: SnapshotRollupSet }> = [];

  for (const s of snaps) {
    const cutoff = s.snapshotDate.getTime();
    while (i < evts.length && evts[i].time.getTime() <= cutoff) {
      const e = evts[i];
      if (e.category === "external_deposit") {
        deposits += e.amount;
      } else if (e.category === "external_withdraw") {
        withdrawals += e.amount;
      } else if (e.category === "internal_transfer") {
        internalTransfers += e.amount;
      }
      i++;
    }

    const balance = parseFloat(s.totalBalance);
    const netExtFlow = (deposits - prevExtDeposits) - (withdrawals - prevExtWithdrawals);
    const tradingPnl = balance - (deposits - withdrawals);

    // Task 119: simple lifetime ratio — trading PnL / total external deposits.
    // Flow-neutral (deposits don't move the line) and the only metric we've
    // shipped that the user accepts. TWR was tried but is unusable on small
    // accounts that touched $0 post-migration.
    const denom = Math.max(deposits, 1);
    let pnlPercent = (tradingPnl / denom) * 100;
    if (pnlPercent > 1000) pnlPercent = 1000;
    if (pnlPercent < -100) pnlPercent = -100;

    out.push({
      id: s.id,
      set: {
        cumulativeExternalDeposits: String(deposits),
        cumulativeExternalWithdrawals: String(withdrawals),
        cumulativeInternalTransfers: String(internalTransfers),
        cumulativeTradingPnl: String(tradingPnl),
        netExternalFlow: String(netExtFlow),
        pnlPercent: String(pnlPercent),
        netPnl: String(tradingPnl),
      },
    });

    prevExtDeposits = deposits;
    prevExtWithdrawals = withdrawals;
  }

  return out;
}

/**
 * ONE equity_events fetch + ONE classification pass per wallet.
 * Classification stays single-sourced on classifyEquityEvent — the category
 * rules (SOL-asset ignore, unknown→internal_transfer) must not be
 * re-implemented in SQL.
 *
 * Ordered by (created_at, id) so the stable time-sort in
 * computeSnapshotRollups resolves equal-timestamp ties deterministically
 * across runs.
 */
async function getWalletClassifiedFlowEvents(
  walletAddress: string,
): Promise<ClassifiedFlowEvent[]> {
  const rows = await db.select().from(equityEvents)
    .where(eq(equityEvents.walletAddress, walletAddress))
    .orderBy(asc(equityEvents.createdAt), asc(equityEvents.id));

  const out: ClassifiedFlowEvent[] = [];
  for (const event of rows) {
    const category = classifyEquityEvent(event);
    if (category === "ignore") continue;
    out.push({
      // On-chain block time when available — critical so the deposit
      // reconciler backfilling a deposit weeks later still attributes it to
      // when it actually happened on-chain, not when we discovered it.
      time: event.txBlockTime ?? event.createdAt,
      category,
      amount: Math.abs(parseFloat(event.amount)),
    });
  }
  return out;
}

/**
 * decimal(…,6) columns come back from PG as padded strings (e.g.
 * "100.000000") while our computed values are String(number) (e.g. "100").
 * Normalize both sides to the destination column's six-decimal scale with
 * decimal.js (exact decimal arithmetic — no float tolerance) and compare.
 * A mathematically unchanged row must issue no UPDATE. Exported for tests.
 */
export function sameAtDbScale(stored: string, computed: string): boolean {
  try {
    return new Decimal(stored)
      .toDecimalPlaces(DB_DECIMAL_SCALE)
      .equals(new Decimal(computed).toDecimalPlaces(DB_DECIMAL_SCALE));
  } catch {
    // Non-numeric input (should not happen for NOT NULL decimal columns) —
    // fall back to literal comparison, which fails toward writing the row.
    return stored === computed;
  }
}

function rollupDiffers(
  current: {
    cumulativeExternalDeposits: string;
    cumulativeExternalWithdrawals: string;
    cumulativeInternalTransfers: string;
    cumulativeTradingPnl: string;
    netExternalFlow: string;
    pnlPercent: string;
    netPnl: string;
  },
  next: SnapshotRollupSet,
): boolean {
  return (
    !sameAtDbScale(current.cumulativeExternalDeposits, next.cumulativeExternalDeposits) ||
    !sameAtDbScale(current.cumulativeExternalWithdrawals, next.cumulativeExternalWithdrawals) ||
    !sameAtDbScale(current.cumulativeInternalTransfers, next.cumulativeInternalTransfers) ||
    !sameAtDbScale(current.cumulativeTradingPnl, next.cumulativeTradingPnl) ||
    !sameAtDbScale(current.netExternalFlow, next.netExternalFlow) ||
    !sameAtDbScale(current.pnlPercent, next.pnlPercent) ||
    !sameAtDbScale(current.netPnl, next.netPnl)
  );
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Yield to the event loop after examining this many snapshot rows. */
const YIELD_EVERY_SNAPSHOTS_EXAMINED = 25;

/**
 * Recompute a single wallet's snapshot fields (batched: one snapshot fetch,
 * one event fetch, pure in-memory walk, only-changed UPDATEs). Called by the
 * deposit reconciler when it discovers a late historical deposit.
 *
 * Yields based on snapshots EXAMINED (not only updates issued) so an
 * unchanged large wallet still yields to the event loop.
 *
 * Returns the number of rows actually written.
 */
export async function recomputeWalletSnapshots(walletAddress: string): Promise<number> {
  const snapshots = await storage.getPortfolioDailySnapshots(walletAddress);
  if (snapshots.length === 0) return 0;

  const events = await getWalletClassifiedFlowEvents(walletAddress);
  const rollups = computeSnapshotRollups(snapshots, events);
  const byId = new Map(snapshots.map((s) => [s.id, s]));

  let written = 0;
  let examinedSinceYield = 0;
  for (const r of rollups) {
    if (++examinedSinceYield >= YIELD_EVERY_SNAPSHOTS_EXAMINED) {
      examinedSinceYield = 0;
      await yieldToEventLoop();
    }

    const current = byId.get(r.id);
    if (current && !rollupDiffers(current, r.set)) continue;

    await db.update(portfolioDailySnapshots)
      .set(r.set)
      .where(eq(portfolioDailySnapshots.id, r.id));
    written++;
  }

  if (written > 0) {
    console.log(
      `${LOG_PREFIX} Wallet ${walletAddress.slice(0, 8)}… recomputed: ${written}/${rollups.length} rows written.`,
    );
  }
  return written;
}
