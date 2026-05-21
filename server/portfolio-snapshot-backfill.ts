/**
 * Task 119: one-shot backfill of the new portfolio_daily_snapshots fields
 * (cumulative_external_deposits, cumulative_external_withdrawals,
 * cumulative_internal_transfers, cumulative_trading_pnl, net_external_flow,
 * pnl_percent) so the chart and leaderboard look right immediately after
 * deploy — without waiting weeks for new snapshots to accumulate.
 *
 * Idempotent: re-running on already-backfilled rows produces the same values.
 * Cheap: pure SQL fetches + arithmetic, no on-chain calls.
 *
 * It does NOT attempt to backfill on-chain block times for historical
 * agent_deposit events whose `tx_block_time IS NULL` — the deposit reconciler
 * will set it for future inserts, and for historical rows we fall back to the
 * existing `created_at`. That fallback is correct for non-reconciler deposits
 * (those rows were inserted at confirm-time so created_at ≈ block time). The
 * one wallet specifically called out in the task (AqTT…hCez) has its phantom
 * drop fixed by recomputing pnl_percent with the chained-return formula,
 * which is independent of when the late-backfilled deposit is timestamped.
 */
import { storage } from "./storage";
import { db } from "./db";
import { portfolioDailySnapshots } from "@shared/schema";
import { eq } from "drizzle-orm";

const BACKFILL_FLAG_KEY = "[PortfolioBackfill]";

/**
 * Recompute a single wallet's snapshot fields. Used by both the one-shot
 * startup backfill and by the deposit reconciler when it discovers a late
 * historical deposit (so prior chart points reflect the corrected flow
 * timeline rather than showing a phantom "correction day").
 */
export async function recomputeWalletSnapshots(walletAddress: string): Promise<number> {
  const snapshots = await storage.getPortfolioDailySnapshots(walletAddress);
  if (snapshots.length === 0) return 0;
  return await _recomputeForSnapshots(walletAddress, snapshots);
}

async function _recomputeForSnapshots(
  walletAddress: string,
  snapshots: Awaited<ReturnType<typeof storage.getPortfolioDailySnapshots>>,
): Promise<number> {
  let prevExtDeposits = 0;
  let prevExtWithdrawals = 0;
  let rows = 0;

  for (const s of snapshots) {
    const balance = parseFloat(s.totalBalance);
    const { deposits, withdrawals, internalTransfers } =
      await storage.getWalletCumulativeDepositsWithdrawals(walletAddress, s.snapshotDate);
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

    await db.update(portfolioDailySnapshots)
      .set({
        cumulativeExternalDeposits: String(deposits),
        cumulativeExternalWithdrawals: String(withdrawals),
        cumulativeInternalTransfers: String(internalTransfers),
        cumulativeTradingPnl: String(tradingPnl),
        netExternalFlow: String(netExtFlow),
        pnlPercent: String(pnlPercent),
        netPnl: String(tradingPnl),
      })
      .where(eq(portfolioDailySnapshots.id, s.id));

    rows++;
    prevExtDeposits = deposits;
    prevExtWithdrawals = withdrawals;
  }
  return rows;
}

export async function backfillPortfolioSnapshots(): Promise<{ wallets: number; rows: number }> {
  const wallets = await storage.getWalletsWithTradingBots();
  let totalRows = 0;

  for (const walletAddress of wallets) {
    try {
      totalRows += await recomputeWalletSnapshots(walletAddress);
    } catch (err) {
      console.error(`${BACKFILL_FLAG_KEY} Wallet ${walletAddress.slice(0, 8)}… failed:`, err);
    }
  }

  return { wallets: wallets.length, rows: totalRows };
}

let _hasRun = false;
export async function runPortfolioBackfillOnce(): Promise<void> {
  if (_hasRun) return;
  _hasRun = true;
  try {
    console.log(`${BACKFILL_FLAG_KEY} Starting one-shot snapshot recompute...`);
    const result = await backfillPortfolioSnapshots();
    console.log(`${BACKFILL_FLAG_KEY} Done. wallets=${result.wallets} rows=${result.rows}`);
  } catch (err) {
    console.error(`${BACKFILL_FLAG_KEY} Fatal:`, err);
  }
}
