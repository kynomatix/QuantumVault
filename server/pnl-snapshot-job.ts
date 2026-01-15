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
        
        await storage.createPnlSnapshot({
          tradingBotId: sourceTradingBot.id,
          snapshotDate: new Date(),
          equity: String(accountInfo.usdcBalance || 0),
          realizedPnl: String(realizedPnl),
          unrealizedPnl: String(accountInfo.unrealizedPnl || 0),
          totalDeposited: String(sourceTradingBot.maxPositionSize || 0),
        });
        
        console.log(`[PnL Snapshots] Saved snapshot for bot ${sourceTradingBot.name}: equity=${accountInfo.usdcBalance?.toFixed(2)}, pnl=${realizedPnl.toFixed(2)}`);
      } catch (botError) {
        console.error(`[PnL Snapshots] Error taking snapshot for published bot ${publishedBot.id}:`, botError);
      }
    }
    
    console.log("[PnL Snapshots] Snapshot run completed");
  } catch (error) {
    console.error("[PnL Snapshots] Error in snapshot job:", error);
  }
}

export function startPnlSnapshotJob(): void {
  console.log("[PnL Snapshots] Starting PnL snapshot service (every 6 hours)");
  
  setTimeout(() => takePnlSnapshots(), 10000);
  
  setInterval(() => {
    takePnlSnapshots();
  }, SNAPSHOT_INTERVAL_MS);
}
