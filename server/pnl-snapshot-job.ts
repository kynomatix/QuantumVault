import { storage } from "./storage";
import { getDriftAccountInfo } from "./drift-service";

const SNAPSHOT_INTERVAL_MS = 6 * 60 * 60 * 1000; // Every 6 hours

export async function takePnlSnapshots(): Promise<void> {
  console.log("[PnL Snapshots] Starting snapshot run...");
  
  try {
    const publishedBots = await storage.getPublishedBots();
    console.log(`[PnL Snapshots] Found ${publishedBots.length} published bots`);
    
    for (const publishedBot of publishedBots) {
      if (!publishedBot.isActive) continue;
      
      try {
        const sourceTradingBot = await storage.getTradingBotById(publishedBot.tradingBotId);
        if (!sourceTradingBot || !sourceTradingBot.driftSubaccountId) continue;
        
        const wallet = await storage.getWallet(sourceTradingBot.walletAddress);
        if (!wallet?.agentPublicKey) continue;
        
        const accountInfo = await getDriftAccountInfo(
          wallet.agentPublicKey,
          sourceTradingBot.driftSubaccountId
        );
        
        const stats = sourceTradingBot.stats as any || {};
        const realizedPnl = stats.totalPnl || 0;
        const totalTrades = stats.totalTrades || 0;
        const winningTrades = stats.winningTrades || 0;
        const creatorEquity = accountInfo.usdcBalance || 0;
        
        // Save private PnL snapshot for trading bot
        await storage.createPnlSnapshot({
          tradingBotId: sourceTradingBot.id,
          snapshotDate: new Date(),
          equity: String(creatorEquity),
          realizedPnl: String(realizedPnl),
          unrealizedPnl: String(accountInfo.unrealizedPnl || 0),
          totalDeposited: String(sourceTradingBot.maxPositionSize || 0),
        });
        
        // Calculate PnL percentages from snapshots
        const pnlStats = await calculatePnlPercentages(publishedBot.tradingBotId);
        
        // Calculate total capital: creator capital + subscriber capital
        const subscriberCapital = parseFloat(publishedBot.totalCapitalInvested || '0') - parseFloat(publishedBot.creatorCapital || '0');
        const newTotalCapital = creatorEquity + Math.max(0, subscriberCapital);
        
        // Sync stats from trading_bots to published_bots including creator capital
        await storage.updatePublishedBotStats(publishedBot.id, {
          totalTrades,
          winningTrades,
          creatorCapital: String(creatorEquity),
          ...pnlStats,
        });
        
        // Update totalCapitalInvested separately if needed
        await storage.incrementPublishedBotSubscribers(publishedBot.id, 0, newTotalCapital - parseFloat(publishedBot.totalCapitalInvested || '0'));
        
        // Save public equity snapshot for marketplace
        const allTimePnl = pnlStats.pnlPercentAllTime ? parseFloat(pnlStats.pnlPercentAllTime) : 0;
        await storage.createMarketplaceEquitySnapshot({
          publishedBotId: publishedBot.id,
          snapshotDate: new Date(),
          equity: String(creatorEquity),
          pnlPercent: String(allTimePnl),
        });
        
        console.log(`[PnL Snapshots] Saved snapshot for bot ${sourceTradingBot.name}: equity=${creatorEquity.toFixed(2)}, pnl=${realizedPnl.toFixed(2)}, trades=${totalTrades}, wins=${winningTrades}`);
      } catch (botError) {
        console.error(`[PnL Snapshots] Error taking snapshot for published bot ${publishedBot.id}:`, botError);
      }
    }
    
    console.log("[PnL Snapshots] Snapshot run completed");
  } catch (error) {
    console.error("[PnL Snapshots] Error in snapshot job:", error);
  }
}

async function calculatePnlPercentages(tradingBotId: string): Promise<{
  pnlPercent7d?: string;
  pnlPercent30d?: string;
  pnlPercent90d?: string;
  pnlPercentAllTime?: string;
}> {
  try {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const snapshots = await storage.getPnlSnapshots(tradingBotId, ninetyDaysAgo);
    if (snapshots.length === 0) return {};
    
    const now = new Date();
    const latestSnapshot = snapshots[0];
    const currentEquity = parseFloat(latestSnapshot.equity);
    
    const findSnapshotNearDate = (daysAgo: number) => {
      const targetDate = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
      return snapshots.find(s => {
        const snapshotDate = new Date(s.snapshotDate);
        const diffHours = Math.abs(snapshotDate.getTime() - targetDate.getTime()) / (1000 * 60 * 60);
        return diffHours < 24; // Within 24 hours of target
      });
    };
    
    const calculatePnlPercent = (oldSnapshot: typeof snapshots[0] | undefined) => {
      if (!oldSnapshot) return undefined;
      const oldEquity = parseFloat(oldSnapshot.equity);
      const deposited = parseFloat(oldSnapshot.totalDeposited) || oldEquity;
      if (deposited === 0) return undefined;
      const pnlPercent = ((currentEquity - deposited) / deposited) * 100;
      return pnlPercent.toFixed(4);
    };
    
    const oldestSnapshot = snapshots[snapshots.length - 1];
    const deposited = parseFloat(oldestSnapshot.totalDeposited) || parseFloat(oldestSnapshot.equity);
    const allTimePnl = deposited > 0 ? ((currentEquity - deposited) / deposited) * 100 : 0;
    
    return {
      pnlPercent7d: calculatePnlPercent(findSnapshotNearDate(7)),
      pnlPercent30d: calculatePnlPercent(findSnapshotNearDate(30)),
      pnlPercent90d: calculatePnlPercent(findSnapshotNearDate(90)),
      pnlPercentAllTime: allTimePnl.toFixed(4),
    };
  } catch (error) {
    console.error("[PnL Snapshots] Error calculating PnL percentages:", error);
    return {};
  }
}

export function startPnlSnapshotJob(): void {
  console.log("[PnL Snapshots] Starting PnL snapshot service (every 6 hours)");
  
  setTimeout(() => takePnlSnapshots(), 10000);
  
  setInterval(() => {
    takePnlSnapshots();
  }, SNAPSHOT_INTERVAL_MS);
}
