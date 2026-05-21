import { storage } from "./storage";
import { getDefaultAdapter } from "./protocol/adapter-registry";
import { getAgentUsdcBalance } from "./agent-wallet";
import { reconcileWalletDeposits } from "./deposit-reconciler";
import type { TradingBot, Wallet } from "@shared/schema";

function _subIdStr(subAccountId: number): string | undefined {
  return subAccountId > 0 ? String(subAccountId) : undefined;
}

/**
 * Resolves the correct (account, subaccountId) pair to query the perp adapter for a bot.
 * - Pacifica bots: protocolSubaccountId is a Solana keypair pubkey passed as `account`.
 * - Drift bots: wallet.agentPublicKey + numeric driftSubaccountId.
 * Returns null when neither path is viable (skip).
 */
function resolveBotAdapterArgs(bot: TradingBot, wallet: Wallet): { account: string; subaccountId?: string } | null {
  if (bot.subaccountAuthMode === 'external_key') {
    if (bot.subaccountStatus !== 'active' || !bot.protocolSubaccountId) return null;
    return { account: bot.protocolSubaccountId };
  }
  if (bot.subaccountAuthMode === 'main_plus_id') {
    if (!wallet.agentPublicKey || bot.driftSubaccountId == null) return null;
    return { account: wallet.agentPublicKey, subaccountId: _subIdStr(bot.driftSubaccountId) };
  }
  return null;
}

async function getAccountBalance(account: string, subaccountId: string | undefined): Promise<number> {
  try {
    const info = await getDefaultAdapter().getAccountInfo(account, subaccountId);
    return info.balance || 0;
  } catch {
    return 0;
  }
}

async function getAgentSplBalance(agentPublicKey: string): Promise<number> {
  try {
    return await getAgentUsdcBalance(agentPublicKey);
  } catch {
    return 0;
  }
}

const SNAPSHOT_INTERVAL_MS = 12 * 60 * 60 * 1000; // Every 12 hours (00:00 and 12:00 UTC)

export async function takePortfolioSnapshots(): Promise<void> {
  console.log("[Portfolio Snapshots] Starting 12-hour snapshot run...");
  
  try {
    const walletAddresses = await storage.getWalletsWithTradingBots();
    
    console.log(`[Portfolio Snapshots] Processing ${walletAddresses.length} wallets`);
    
    for (const walletAddress of walletAddresses) {
      try {
        await processWalletSnapshot(walletAddress);
      } catch (error) {
        console.error(`[Portfolio Snapshots] Error processing wallet ${walletAddress.slice(0, 8)}...`, error);
      }
    }
    
    console.log("[Portfolio Snapshots] Completed 12-hour snapshot run");
  } catch (error) {
    console.error("[Portfolio Snapshots] Fatal error during snapshot run:", error);
  }
}

/**
 * Task 119: shared balance aggregator. The portfolio endpoint and the snapshot
 * writer MUST sum across the same account universe (agent SPL + every bot's
 * own subaccount via the adapter) so the leaderboard (which reads from the
 * latest snapshot) agrees with the live portfolio number. Previously the
 * endpoint only queried agent subaccount 0 + external_key Pacifica bots and
 * missed main_plus_id Drift bots with subaccountId != 0, causing leaderboard
 * <-> portfolio drift.
 */
export async function computeWalletTotalBalance(
  walletAddress: string,
): Promise<{ totalBalance: number; activeBotCount: number }> {
  const wallet = await storage.getWallet(walletAddress);
  if (!wallet) return { totalBalance: 0, activeBotCount: 0 };

  const bots = await storage.getTradingBots(walletAddress);
  let totalBalance = 0;
  let activeBotCount = 0;

  if (wallet.agentPublicKey) {
    try {
      totalBalance += await getAgentSplBalance(wallet.agentPublicKey);
    } catch (error) {
      console.error(`[computeWalletTotalBalance] agent SPL balance error:`, error);
    }
  }

  for (const bot of bots) {
    try {
      if (bot.isActive) activeBotCount++;
      const adapterArgs = resolveBotAdapterArgs(bot, wallet);
      if (adapterArgs) {
        totalBalance += await getAccountBalance(adapterArgs.account, adapterArgs.subaccountId);
      }
    } catch (error) {
      console.error(`[computeWalletTotalBalance] bot ${bot.id} balance error:`, error);
    }
  }

  return { totalBalance, activeBotCount };
}

async function processWalletSnapshot(walletAddress: string): Promise<void> {
  const wallet = await storage.getWallet(walletAddress);
  if (!wallet) return;

  const bots = await storage.getTradingBots(walletAddress);
  if (bots.length === 0) return;

  const { totalBalance, activeBotCount } = await computeWalletTotalBalance(walletAddress);
  
  // Backfill any deposits the client-side confirmation missed before reading totals.
  await reconcileWalletDeposits(walletAddress);
  const { totalTrades, totalVolume } = await storage.getWalletTradeStats(walletAddress);
  const creatorEarnings = await storage.getWalletCreatorEarnings(walletAddress);

  // Round to nearest 12-hour mark (00:00 or 12:00 UTC)
  const now = new Date();
  const snapshotTime = new Date(now);
  snapshotTime.setMinutes(0, 0, 0);
  const hour = snapshotTime.getUTCHours();
  if (hour < 12) {
    snapshotTime.setUTCHours(0);
  } else {
    snapshotTime.setUTCHours(12);
  }

  // Use as-of-snapshot cumulative flows (block-time aware) so a late-backfilled
  // deposit gets attributed to the snapshot when it actually happened.
  const { deposits, withdrawals, internalTransfers } =
    await storage.getWalletCumulativeDepositsWithdrawals(walletAddress, snapshotTime);

  const netExternalFlowCum = deposits - withdrawals;
  const tradingPnl = totalBalance - netExternalFlowCum;

  // Compute day's net external flow against the previous snapshot.
  const prev = await storage.getLatestPortfolioDailySnapshot(walletAddress);
  let prevCumExtDeposits = 0;
  let prevCumExtWithdrawals = 0;
  if (prev) {
    prevCumExtDeposits = parseFloat(prev.cumulativeExternalDeposits ?? prev.cumulativeDeposits);
    prevCumExtWithdrawals = parseFloat(prev.cumulativeExternalWithdrawals ?? prev.cumulativeWithdrawals);
  }
  const netExternalFlow = (deposits - prevCumExtDeposits) - (withdrawals - prevCumExtWithdrawals);

  // Task 119: simple lifetime ratio — trading PnL / cumulative external
  // deposits. Flow-neutral and matches the backfill + live endpoint.
  let pnlPercent = (tradingPnl / Math.max(deposits, 1)) * 100;
  if (pnlPercent > 1000) pnlPercent = 1000;
  if (pnlPercent < -100) pnlPercent = -100;

  // Keep legacy `netPnl` writing the same value as trading P&L for read-compat,
  // so any pre-Task-119 consumer still sees a coherent number.
  await storage.upsertPortfolioDailySnapshot({
    walletAddress,
    snapshotDate: snapshotTime,
    totalBalance: String(totalBalance),
    cumulativeDeposits: String(deposits),
    cumulativeWithdrawals: String(withdrawals),
    netPnl: String(tradingPnl),
    activeBotCount,
    totalTrades,
    totalVolume: String(totalVolume),
    creatorEarnings: String(creatorEarnings),
    cumulativeExternalDeposits: String(deposits),
    cumulativeExternalWithdrawals: String(withdrawals),
    cumulativeInternalTransfers: String(internalTransfers),
    cumulativeTradingPnl: String(tradingPnl),
    netExternalFlow: String(netExternalFlow),
    pnlPercent: String(pnlPercent),
  });

  console.log(`[Portfolio Snapshots] Saved snapshot for ${walletAddress.slice(0, 8)}...: balance=${totalBalance.toFixed(2)}, tradingPnl=${tradingPnl.toFixed(2)}, pnlPct=${pnlPercent.toFixed(2)}%, netFlow=${netExternalFlow.toFixed(2)}`);
}

export function startPortfolioSnapshotJob(): void {
  console.log("[Portfolio Snapshots] Starting snapshot job (12h interval, 00:00 and 12:00 UTC)");
  
  // Calculate time until next 00:00 or 12:00 UTC
  const now = new Date();
  const currentHour = now.getUTCHours();
  const currentMinutes = now.getUTCMinutes();
  
  let hoursUntilNext: number;
  if (currentHour < 12) {
    hoursUntilNext = 12 - currentHour;
  } else {
    hoursUntilNext = 24 - currentHour;
  }
  // Subtract current minutes to get exact time
  const msUntilNext = (hoursUntilNext * 60 - currentMinutes) * 60 * 1000;
  
  console.log(`[Portfolio Snapshots] Next snapshot in ${(msUntilNext / 3600000).toFixed(1)} hours`);
  
  // Take an initial snapshot after 5 seconds, then schedule at 00:00/12:00 UTC
  setTimeout(async () => {
    await takePortfolioSnapshots();
    
    // Schedule to run at next 00:00 or 12:00 UTC, then every 12 hours
    setTimeout(() => {
      takePortfolioSnapshots();
      setInterval(takePortfolioSnapshots, SNAPSHOT_INTERVAL_MS);
    }, msUntilNext);
  }, 5000);
}
