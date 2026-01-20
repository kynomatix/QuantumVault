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
        
        // Get actual net deposited from equity events (same as bot management drawer)
        const botEvents = await storage.getBotEquityEvents(sourceTradingBot.id, 1000);
        const netDeposited = botEvents.reduce((sum, e) => sum + parseFloat(e.amount || '0'), 0);
        // Fall back to maxPositionSize if no equity events (legacy data)
        const maxPosSize = typeof sourceTradingBot.maxPositionSize === 'string' 
          ? parseFloat(sourceTradingBot.maxPositionSize) 
          : (sourceTradingBot.maxPositionSize || 0);
        const totalDeposited = netDeposited > 0 ? netDeposited : maxPosSize;
        
        // Save private PnL snapshot for trading bot
        await storage.createPnlSnapshot({
          tradingBotId: sourceTradingBot.id,
          snapshotDate: new Date(),
          equity: String(creatorEquity),
          realizedPnl: String(realizedPnl),
          unrealizedPnl: String(accountInfo.unrealizedPnl || 0),
          totalDeposited: String(totalDeposited),
        });
        
        // Calculate PnL percentages from snapshots, using actual deposited for all-time
        const pnlStats = await calculatePnlPercentages(publishedBot.tradingBotId, creatorEquity, totalDeposited);
        
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

async function calculatePnlPercentages(
  tradingBotId: string,
  currentEquity: number,
  totalDeposited: number
): Promise<{
  pnlPercent7d?: string;
  pnlPercent30d?: string;
  pnlPercent90d?: string;
  pnlPercentAllTime?: string;
}> {
  try {
    // Use actual deposited for all-time PnL (matches bot management drawer calculation)
    const allTimePnl = totalDeposited > 0 ? ((currentEquity - totalDeposited) / totalDeposited) * 100 : 0;
    
    // For 7d/30d/90d, we still compare to historical snapshots
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const snapshots = await storage.getPnlSnapshots(tradingBotId, ninetyDaysAgo);
    
    const findSnapshotNearDate = (daysAgo: number) => {
      const targetDate = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
      return snapshots.find(s => {
        const snapshotDate = new Date(s.snapshotDate);
        const diffHours = Math.abs(snapshotDate.getTime() - targetDate.getTime()) / (1000 * 60 * 60);
        return diffHours < 24;
      });
    };
    
    const calculatePnlPercent = (oldSnapshot: typeof snapshots[0] | undefined) => {
      if (!oldSnapshot) return undefined;
      const oldEquity = parseFloat(oldSnapshot.equity);
      if (oldEquity === 0) return undefined;
      // Period PnL: how much equity changed from snapshot date to now
      const pnlPercent = ((currentEquity - oldEquity) / oldEquity) * 100;
      return pnlPercent.toFixed(4);
    };
    
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
