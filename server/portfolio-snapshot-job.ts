import { storage } from "./storage";
import { getDriftAccountInfo, getUsdcBalance } from "./drift-service";

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

async function processWalletSnapshot(walletAddress: string): Promise<void> {
  const wallet = await storage.getWallet(walletAddress);
  if (!wallet) return;
  
  const bots = await storage.getTradingBots(walletAddress);
  if (bots.length === 0) return;
  
  let totalBalance = 0;
  let activeBotCount = 0;
  
  if (wallet.agentPublicKey) {
    try {
      const agentBalance = await getUsdcBalance(wallet.agentPublicKey);
      totalBalance += agentBalance;
    } catch (error) {
      console.error(`[Portfolio Snapshots] Error getting agent wallet balance:`, error);
    }
  }
  
  for (const bot of bots) {
    try {
      if (bot.isActive) activeBotCount++;
      
      if (wallet.agentPublicKey && bot.driftSubaccountId) {
        const accountInfo = await getDriftAccountInfo(
          wallet.agentPublicKey,
          bot.driftSubaccountId
        );
        totalBalance += accountInfo.usdcBalance || 0;
      }
    } catch (error) {
      console.error(`[Portfolio Snapshots] Error getting balance for bot ${bot.id}:`, error);
    }
  }
  
  const { deposits, withdrawals } = await storage.getWalletCumulativeDepositsWithdrawals(walletAddress);
  const { totalTrades, totalVolume } = await storage.getWalletTradeStats(walletAddress);
  const creatorEarnings = await storage.getWalletCreatorEarnings(walletAddress);
  
  const netPnl = totalBalance - deposits + withdrawals;
  
  // Round to nearest 12-hour mark (00:00 or 12:00 UTC)
  const now = new Date();
  const snapshotTime = new Date(now);
  snapshotTime.setMinutes(0, 0, 0);
  // Round to 00:00 or 12:00
  const hour = snapshotTime.getUTCHours();
  if (hour < 12) {
    snapshotTime.setUTCHours(0);
  } else {
    snapshotTime.setUTCHours(12);
  }
  
  await storage.upsertPortfolioDailySnapshot({
    walletAddress,
    snapshotDate: snapshotTime,
    totalBalance: String(totalBalance),
    cumulativeDeposits: String(deposits),
    cumulativeWithdrawals: String(withdrawals),
    netPnl: String(netPnl),
    activeBotCount,
    totalTrades,
    totalVolume: String(totalVolume),
    creatorEarnings: String(creatorEarnings),
  });
  
  console.log(`[Portfolio Snapshots] Saved snapshot for ${walletAddress.slice(0, 8)}...: balance=${totalBalance.toFixed(2)}, pnl=${netPnl.toFixed(2)}`);
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
