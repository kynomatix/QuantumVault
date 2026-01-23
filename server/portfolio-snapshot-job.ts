import { storage } from "./storage";
import { getDriftAccountInfo, getUsdcBalance } from "./drift-service";

const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000; // Once per day

export async function takePortfolioSnapshots(): Promise<void> {
  console.log("[Portfolio Snapshots] Starting daily snapshot run...");
  
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
    
    console.log("[Portfolio Snapshots] Completed daily snapshot run");
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
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  await storage.upsertPortfolioDailySnapshot({
    walletAddress,
    snapshotDate: today,
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
  console.log("[Portfolio Snapshots] Starting daily snapshot job (24h interval)");
  
  setTimeout(async () => {
    await takePortfolioSnapshots();
    setInterval(takePortfolioSnapshots, SNAPSHOT_INTERVAL_MS);
  }, 5000);
}
