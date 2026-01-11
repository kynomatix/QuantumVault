import { storage } from "./storage";
import { getPerpPositions } from "./drift-service";

const STALE_THRESHOLD_MS = 60 * 1000; // 60 seconds
const RECONCILE_INTERVAL_MS = 60 * 1000; // 60 seconds

let reconcileInterval: NodeJS.Timeout | null = null;
const lastReconcileTime = new Map<string, number>();

export async function reconcileBotPosition(
  botId: string,
  walletAddress: string,
  agentPublicKey: string,
  subAccountId: number,
  market: string
): Promise<{ synced: boolean; discrepancy: boolean }> {
  try {
    const onChainPositions = await getPerpPositions(agentPublicKey, subAccountId);
    const onChainPos = onChainPositions.find(p => p.market === market);
    const dbPosition = await storage.getBotPosition(botId, market);
    
    const dbBaseSize = dbPosition ? parseFloat(dbPosition.baseSize) : 0;
    const onChainBaseSize = onChainPos?.baseAssetAmount || 0;
    
    const hasDiscrepancy = Math.abs(dbBaseSize - onChainBaseSize) > 0.0001;
    
    if (hasDiscrepancy) {
      console.log(`[Reconcile] Bot ${botId}: DB=${dbBaseSize}, OnChain=${onChainBaseSize} - syncing`);
      
      if (onChainPos && Math.abs(onChainBaseSize) > 0.0001) {
        await storage.upsertBotPosition({
          tradingBotId: botId,
          walletAddress,
          market,
          baseSize: String(onChainBaseSize),
          avgEntryPrice: String(onChainPos.entryPrice),
          costBasis: String(Math.abs(onChainBaseSize) * onChainPos.entryPrice),
          realizedPnl: dbPosition?.realizedPnl || "0",
          totalFees: dbPosition?.totalFees || "0",
          lastTradeId: dbPosition?.lastTradeId || null,
          lastTradeAt: new Date(),
        });
      } else if (dbPosition && Math.abs(dbBaseSize) > 0.0001) {
        await storage.upsertBotPosition({
          tradingBotId: botId,
          walletAddress,
          market,
          baseSize: "0",
          avgEntryPrice: "0",
          costBasis: "0",
          realizedPnl: dbPosition.realizedPnl,
          totalFees: dbPosition.totalFees,
          lastTradeId: dbPosition.lastTradeId,
          lastTradeAt: new Date(),
        });
      }
    }
    
    lastReconcileTime.set(botId, Date.now());
    return { synced: true, discrepancy: hasDiscrepancy };
  } catch (error) {
    console.error(`[Reconcile] Error for bot ${botId}:`, error);
    return { synced: false, discrepancy: false };
  }
}

export async function reconcileAllBotsForWallet(walletAddress: string): Promise<{
  botsChecked: number;
  discrepancies: number;
}> {
  const wallet = await storage.getWallet(walletAddress);
  if (!wallet?.agentPublicKey) {
    return { botsChecked: 0, discrepancies: 0 };
  }
  
  const bots = await storage.getTradingBots(walletAddress);
  let discrepancies = 0;
  
  for (const bot of bots) {
    const subAccountId = bot.driftSubaccountId ?? 0;
    const result = await reconcileBotPosition(
      bot.id,
      walletAddress,
      wallet.agentPublicKey,
      subAccountId,
      bot.market
    );
    if (result.discrepancy) discrepancies++;
  }
  
  return { botsChecked: bots.length, discrepancies };
}

export function isPositionStale(botId: string): boolean {
  const lastTime = lastReconcileTime.get(botId);
  if (!lastTime) return true;
  return Date.now() - lastTime > STALE_THRESHOLD_MS;
}

export async function reconcileIfStale(
  botId: string,
  walletAddress: string,
  agentPublicKey: string,
  subAccountId: number,
  market: string
): Promise<void> {
  if (isPositionStale(botId)) {
    await reconcileBotPosition(botId, walletAddress, agentPublicKey, subAccountId, market);
  }
}

export function startPeriodicReconciliation(): void {
  if (reconcileInterval) return;
  
  console.log("[Reconcile] Starting periodic reconciliation (every 60s)");
  
  reconcileInterval = setInterval(async () => {
    try {
      const allWallets = await storage.getWalletsWithActiveBots();
      
      for (const walletAddress of allWallets) {
        const wallet = await storage.getWallet(walletAddress);
        if (!wallet?.agentPublicKey) continue;
        
        const bots = await storage.getTradingBots(walletAddress);
        const activeBots = bots.filter(b => b.isActive);
        
        if (activeBots.length === 0) continue;
        
        for (const bot of activeBots) {
          const subAccountId = bot.driftSubaccountId ?? 0;
          await reconcileBotPosition(
            bot.id,
            walletAddress,
            wallet.agentPublicKey,
            subAccountId,
            bot.market
          );
        }
      }
    } catch (error) {
      console.error("[Reconcile] Periodic reconciliation error:", error);
    }
  }, RECONCILE_INTERVAL_MS);
}

export function stopPeriodicReconciliation(): void {
  if (reconcileInterval) {
    clearInterval(reconcileInterval);
    reconcileInterval = null;
    console.log("[Reconcile] Stopped periodic reconciliation");
  }
}
