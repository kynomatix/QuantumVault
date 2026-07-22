/**
 * Task 119: one-shot backfill of the new portfolio_daily_snapshots fields
 * (cumulative_external_deposits, cumulative_external_withdrawals,
 * cumulative_internal_transfers, cumulative_trading_pnl, net_external_flow,
 * pnl_percent) so the chart and leaderboard look right immediately after
 * deploy — without waiting weeks for new snapshots to accumulate.
 *
 * WO-21 (boot backfill regression) rework:
 * - The "once" gate is now PERSISTENT (system_flags row keyed by a version
 *   string), so restarts/publishes no longer re-run the full recompute. Bump
 *   BACKFILL_VERSION to deliberately force exactly one recompute on the next
 *   boot (the right lever if the formula ever changes again).
 * - The recompute is O(snapshots + events) per wallet: ONE equity_events
 *   fetch + ONE classification pass, then a sorted pointer walk accumulating
 *   running cumulatives (previously each snapshot row re-fetched and
 *   re-classified the wallet's entire event history — O(S×E) with ~696 full
 *   table fetches on every boot, the cause of the ~26-minute post-publish
 *   degradation windows).
 * - Only changed rows are written (steady-state re-run ≈ zero UPDATEs), and
 *   the loop yields to the event loop between wallets and every 25 UPDATEs.
 *
 * Formulas are UNCHANGED from the original per-row implementation — the
 * equivalence test in tests/portfolio-backfill/ is the proof.
 *
 * It does NOT attempt to backfill on-chain block times for historical
 * agent_deposit events whose `tx_block_time IS NULL` — the deposit reconciler
 * will set it for future inserts, and for historical rows we fall back to the
 * existing `created_at`. That fallback is correct for non-reconciler deposits
 * (those rows were inserted at confirm-time so created_at ≈ block time).
 */
import { storage } from "./storage";
import { db } from "./db";
import { portfolioDailySnapshots, equityEvents } from "@shared/schema";
import { eq } from "drizzle-orm";
import { classifyEquityEvent, type EquityEventCategory } from "./equity-event-classifier";

const BACKFILL_FLAG_KEY = "[PortfolioBackfill]";
const BACKFILL_VERSION_KEY = "portfolio_backfill_version";
// Bump this string to force ONE full recompute on the next boot.
const BACKFILL_VERSION = "task119-v1";

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
 */
async function getWalletClassifiedFlowEvents(
  walletAddress: string,
): Promise<ClassifiedFlowEvent[]> {
  const rows = await db.select().from(equityEvents)
    .where(eq(equityEvents.walletAddress, walletAddress));

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
 * decimal(…,6) columns come back from PG as normalized strings (e.g.
 * "300.000000") while our computed values are String(number) (e.g. "300").
 * Compare numerically with a half-ULP-of-storage tolerance so unchanged rows
 * are recognized as unchanged.
 */
function sameDecimal(stored: string, computed: string): boolean {
  const a = parseFloat(stored);
  const b = parseFloat(computed);
  if (Number.isNaN(a) || Number.isNaN(b)) return stored === computed;
  return Math.abs(a - b) < 5e-7;
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
    !sameDecimal(current.cumulativeExternalDeposits, next.cumulativeExternalDeposits) ||
    !sameDecimal(current.cumulativeExternalWithdrawals, next.cumulativeExternalWithdrawals) ||
    !sameDecimal(current.cumulativeInternalTransfers, next.cumulativeInternalTransfers) ||
    !sameDecimal(current.cumulativeTradingPnl, next.cumulativeTradingPnl) ||
    !sameDecimal(current.netExternalFlow, next.netExternalFlow) ||
    !sameDecimal(current.pnlPercent, next.pnlPercent) ||
    !sameDecimal(current.netPnl, next.netPnl)
  );
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Recompute a single wallet's snapshot fields (batched: one snapshot fetch,
 * one event fetch, pure in-memory walk, only-changed UPDATEs). Used by both
 * the one-shot startup backfill and by the deposit reconciler when it
 * discovers a late historical deposit — the reconciler path is deliberately
 * NOT gated by the one-shot flag.
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
  let sinceYield = 0;
  for (const r of rollups) {
    const current = byId.get(r.id);
    if (current && !rollupDiffers(current, r.set)) continue;

    await db.update(portfolioDailySnapshots)
      .set(r.set)
      .where(eq(portfolioDailySnapshots.id, r.id));
    written++;

    if (++sinceYield >= 25) {
      sinceYield = 0;
      await yieldToEventLoop();
    }
  }
  return written;
}

export async function backfillPortfolioSnapshots(): Promise<{
  wallets: number;
  rows: number;
  walletsFailed: number;
}> {
  const wallets = await storage.getWalletsWithTradingBots();
  let totalRows = 0;
  let walletsFailed = 0;

  for (const walletAddress of wallets) {
    try {
      totalRows += await recomputeWalletSnapshots(walletAddress);
    } catch (err) {
      walletsFailed++;
      console.error(`${BACKFILL_FLAG_KEY} Wallet ${walletAddress.slice(0, 8)}… failed:`, err);
    }
    await yieldToEventLoop();
  }

  return { wallets: wallets.length, rows: totalRows, walletsFailed };
}

/**
 * Persistent one-shot gate: runs once EVER per BACKFILL_VERSION, across all
 * restarts and publishes. The flag is only set when every wallet succeeded —
 * a partially-failed run retries on the next boot instead of silently never
 * finishing.
 */
export async function runPortfolioBackfillOnce(): Promise<void> {
  try {
    const done = await storage.getSystemFlag(BACKFILL_VERSION_KEY);
    if (done === BACKFILL_VERSION) {
      console.log(`${BACKFILL_FLAG_KEY} Skipped — already completed (${BACKFILL_VERSION}).`);
      return;
    }
    console.log(`${BACKFILL_FLAG_KEY} Starting one-shot snapshot recompute (${BACKFILL_VERSION})...`);
    const result = await backfillPortfolioSnapshots();
    if (result.walletsFailed === 0) {
      await storage.setSystemFlag(BACKFILL_VERSION_KEY, BACKFILL_VERSION);
      console.log(
        `${BACKFILL_FLAG_KEY} Done. wallets=${result.wallets} rowsWritten=${result.rows} — flag set (${BACKFILL_VERSION}).`,
      );
    } else {
      console.warn(
        `${BACKFILL_FLAG_KEY} ${result.walletsFailed}/${result.wallets} wallet(s) failed (rowsWritten=${result.rows}) — flag NOT set, will retry next boot.`,
      );
    }
  } catch (err) {
    console.error(`${BACKFILL_FLAG_KEY} Fatal:`, err);
  }
}
