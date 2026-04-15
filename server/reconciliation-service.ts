import { storage } from "./storage";
import { normalizeMarket } from "./protocol/symbol-registry";
import { getDefaultAdapter } from "./protocol/adapter-registry";

function _subIdStr(subAccountId: number): string | undefined {
  return subAccountId > 0 ? String(subAccountId) : undefined;
}

async function fetchPerpPositions(agentPublicKey: string, subaccountId: number): Promise<{ positions: any[]; fetchFailed: boolean }> {
  try {
    const positions = await getDefaultAdapter().getPositions(agentPublicKey, _subIdStr(subaccountId));
    return { positions: positions.map(p => ({
      marketIndex: 0,
      market: p.internalSymbol,
      baseAssetAmount: p.baseSize,
      side: (p.baseSize >= 0 ? 'LONG' : 'SHORT') as 'LONG' | 'SHORT',
      entryPrice: p.entryPrice,
      markPrice: p.markPrice,
      unrealizedPnl: p.unrealizedPnl,
      unrealizedPnlPercent: p.entryPrice > 0
        ? ((p.markPrice - p.entryPrice) / p.entryPrice) * 100 * (p.baseSize >= 0 ? 1 : -1)
        : 0,
    })), fetchFailed: false };
  } catch (err) {
    console.log(`[fetchPerpPositions] Failed to fetch positions: ${err instanceof Error ? err.message : err}`);
    return { positions: [], fetchFailed: true };
  }
}

async function fetchMarketPrice(market: string): Promise<number | null> {
  try {
    return await getDefaultAdapter().getPrice(market);
  } catch {
    return null;
  }
}

const STALE_THRESHOLD_MS = 60 * 1000; // 60 seconds
const RECONCILE_INTERVAL_MS = 60 * 1000; // 60 seconds

let reconcileInterval: NodeJS.Timeout | null = null;
const lastReconcileTime = new Map<string, number>();

/**
 * Force sync position from on-chain Drift to database
 * This should be called AFTER every trade to ensure DB matches on-chain truth
 * Unlike updateBotPositionFromTrade which does client-side math, this queries actual on-chain state
 * 
 * @param tradeFillPrice - Fill price of the trade (for realized PnL calculation)
 * @param tradeSide - 'long' or 'short' for the trade that was just executed
 * @param tradeSize - Size of the trade in base units
 */
export async function syncPositionFromOnChain(
  botId: string,
  walletAddress: string,
  agentPublicKey: string,
  subAccountId: number,
  market: string,
  tradeId: string,
  tradeFee: number,
  tradeFillPrice: number = 0,
  tradeSide: string = '',
  tradeSize: number = 0
): Promise<{ success: boolean; position?: any; error?: string; tradePnl?: number; isClosingTrade?: boolean; onChainEntryPrice?: number }> {
  try {
    console.log(`[Sync] Force syncing bot ${botId} from on-chain (market=${market}, subaccount=${subAccountId})`);
    
    // Query actual on-chain position using raw RPC (no WebSocket)
    const fetchResult = await fetchPerpPositions(agentPublicKey, subAccountId);
    const normalizedMarket = normalizeMarket(market);
    const onChainPos = fetchResult.positions.find(p => normalizeMarket(p.market) === normalizedMarket);
    
    const dbPosition = await storage.getBotPosition(botId, market);
    const existingRealizedPnl = dbPosition ? parseFloat(dbPosition.realizedPnl) : 0;
    const existingFees = dbPosition ? parseFloat(dbPosition.totalFees) : 0;
    const previousBaseSize = dbPosition ? parseFloat(dbPosition.baseSize) : 0;
    const previousAvgEntry = dbPosition ? parseFloat(dbPosition.avgEntryPrice) : 0;
    
    if (fetchResult.fetchFailed && tradeSize > 0 && tradeFillPrice > 0) {
      console.log(`[Sync] Position fetch failed — using trade data as fallback`);
      const normalizedSide = tradeSide.toLowerCase();
      const tradeSigned = normalizedSide === 'long' ? tradeSize : -tradeSize;
      const isSameDirection = (previousBaseSize >= 0 && normalizedSide === 'long') ||
                              (previousBaseSize <= 0 && normalizedSide === 'short');
      
      let newBaseSize: number;
      let newAvgEntry: number;
      let tradePnl = 0;
      
      if (Math.abs(previousBaseSize) < 0.0001) {
        newBaseSize = tradeSigned;
        newAvgEntry = tradeFillPrice;
      } else if (isSameDirection) {
        newBaseSize = previousBaseSize + tradeSigned;
        const totalCost = Math.abs(previousBaseSize) * previousAvgEntry + tradeSize * tradeFillPrice;
        newAvgEntry = totalCost / Math.abs(newBaseSize);
      } else {
        const closedSize = Math.min(Math.abs(previousBaseSize), tradeSize);
        const feeRatio = closedSize / tradeSize;
        const closeFee = tradeFee * feeRatio;
        tradePnl = previousBaseSize > 0
          ? (tradeFillPrice - previousAvgEntry) * closedSize - closeFee
          : (previousAvgEntry - tradeFillPrice) * closedSize - closeFee;
        newBaseSize = previousBaseSize + tradeSigned;
        newAvgEntry = Math.abs(newBaseSize) > 0.0001 ? (Math.abs(newBaseSize) > Math.abs(previousBaseSize) ? tradeFillPrice : previousAvgEntry) : 0;
      }
      
      const newRealizedPnl = existingRealizedPnl + tradePnl;
      const newTotalFees = existingFees + tradeFee;
      
      const position = await storage.upsertBotPosition({
        tradingBotId: botId,
        walletAddress,
        market,
        baseSize: String(newBaseSize),
        avgEntryPrice: String(newAvgEntry),
        costBasis: String(Math.abs(newBaseSize) * newAvgEntry),
        realizedPnl: String(newRealizedPnl),
        totalFees: String(newTotalFees),
        lastTradeId: tradeId,
        lastTradeAt: new Date(),
      });
      
      console.log(`[Sync] Fallback position: ${newBaseSize.toFixed(4)} ${market} @ $${newAvgEntry.toFixed(2)} (fetch failed, used trade data)`);
      return { success: true, position, tradePnl, isClosingTrade: tradePnl !== 0, onChainEntryPrice: tradeFillPrice };
    }
    
    const onChainBaseSize = onChainPos?.baseAssetAmount || 0;
    
    let tradePnl = 0;
    
    if (Math.abs(previousBaseSize) > 0.0001 && tradeFillPrice > 0 && tradeSize > 0) {
      const normalizedSide = tradeSide.toLowerCase();
      const isReducing = (previousBaseSize > 0 && normalizedSide === 'short') ||
                         (previousBaseSize < 0 && normalizedSide === 'long');
      
      if (isReducing) {
        const closedSize = Math.min(Math.abs(previousBaseSize), tradeSize);
        const feeRatio = closedSize / tradeSize;
        const closeFee = tradeFee * feeRatio;
        
        if (previousBaseSize > 0) {
          tradePnl = (tradeFillPrice - previousAvgEntry) * closedSize - closeFee;
        } else {
          tradePnl = (previousAvgEntry - tradeFillPrice) * closedSize - closeFee;
        }
        
        console.log(`[Sync] Realized PnL from close: $${tradePnl.toFixed(4)} (closed ${closedSize.toFixed(4)} @ $${tradeFillPrice.toFixed(2)}, entry was $${previousAvgEntry.toFixed(2)}, fee prorated: $${closeFee.toFixed(4)})`);
      }
    }
    
    const newRealizedPnl = existingRealizedPnl + tradePnl;
    const newTotalFees = existingFees + tradeFee;
    
    if (onChainPos && Math.abs(onChainBaseSize) > 0.0001) {
      const position = await storage.upsertBotPosition({
        tradingBotId: botId,
        walletAddress,
        market,
        baseSize: String(onChainBaseSize),
        avgEntryPrice: String(onChainPos.entryPrice),
        costBasis: String(Math.abs(onChainBaseSize) * onChainPos.entryPrice),
        realizedPnl: String(newRealizedPnl),
        totalFees: String(newTotalFees),
        lastTradeId: tradeId,
        lastTradeAt: new Date(),
      });
      
      console.log(`[Sync] On-chain position: ${onChainBaseSize.toFixed(4)} ${market} @ $${onChainPos.entryPrice.toFixed(2)}, cumulative PnL: $${newRealizedPnl.toFixed(4)}`);
      return { success: true, position, tradePnl, isClosingTrade: tradePnl !== 0, onChainEntryPrice: onChainPos.entryPrice };
    } else if (tradeSize > 0 && tradeFillPrice > 0) {
      const normalizedSide = tradeSide.toLowerCase();
      const tradeSigned = normalizedSide === 'long' ? tradeSize : -tradeSize;
      const isSameDirection = (previousBaseSize >= 0 && normalizedSide === 'long') ||
                              (previousBaseSize <= 0 && normalizedSide === 'short');
      
      let newBaseSize: number;
      let newAvgEntry: number;
      
      if (Math.abs(previousBaseSize) < 0.0001) {
        newBaseSize = tradeSigned;
        newAvgEntry = tradeFillPrice;
      } else if (isSameDirection) {
        newBaseSize = previousBaseSize + tradeSigned;
        const totalCost = Math.abs(previousBaseSize) * previousAvgEntry + tradeSize * tradeFillPrice;
        newAvgEntry = totalCost / Math.abs(newBaseSize);
      } else {
        newBaseSize = previousBaseSize + tradeSigned;
        newAvgEntry = Math.abs(newBaseSize) > 0.0001 ? (Math.abs(newBaseSize) > Math.abs(previousBaseSize) ? tradeFillPrice : previousAvgEntry) : 0;
      }
      
      const position = await storage.upsertBotPosition({
        tradingBotId: botId,
        walletAddress,
        market,
        baseSize: String(newBaseSize),
        avgEntryPrice: String(newAvgEntry),
        costBasis: String(Math.abs(newBaseSize) * newAvgEntry),
        realizedPnl: String(newRealizedPnl),
        totalFees: String(newTotalFees),
        lastTradeId: tradeId,
        lastTradeAt: new Date(),
      });
      
      console.log(`[Sync] On-chain empty — computed from trade data: ${newBaseSize.toFixed(4)} ${market} @ $${newAvgEntry.toFixed(2)}, PnL: $${newRealizedPnl.toFixed(4)}`);
      return { success: true, position, tradePnl, isClosingTrade: Math.abs(newBaseSize) < 0.0001, onChainEntryPrice: tradeFillPrice };
    } else {
      console.log(`[Sync] On-chain empty and no trade data — preserving DB position (${previousBaseSize} ${market})`);
      return { success: true, tradePnl: 0, isClosingTrade: false };
    }
  } catch (error) {
    console.error(`[Sync] Failed to sync position from on-chain:`, error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}


export async function reconcileBotPosition(
  botId: string,
  walletAddress: string,
  agentPublicKey: string,
  subAccountId: number,
  market: string
): Promise<{ synced: boolean; discrepancy: boolean; liquidation?: boolean }> {
  try {
    const fetchResult = await fetchPerpPositions(agentPublicKey, subAccountId);
    if (fetchResult.fetchFailed) {
      console.log(`[Reconcile] Skipping reconciliation for bot ${botId} — position fetch failed`);
      return { synced: false, discrepancy: false };
    }
    const normalizedMarket = normalizeMarket(market);
    const onChainPos = fetchResult.positions.find(p => normalizeMarket(p.market) === normalizedMarket);
    const dbPosition = await storage.getBotPosition(botId, market);
    
    const dbBaseSize = dbPosition ? parseFloat(dbPosition.baseSize) : 0;
    const onChainBaseSize = onChainPos?.baseAssetAmount || 0;
    const onChainHasRealPosition = onChainPos && Math.abs(onChainBaseSize) > 0.0001;
    
    if (Math.abs(dbBaseSize) > 0.0001 && !onChainHasRealPosition) {
      console.log(`[Reconcile] On-chain empty/zero but DB has ${dbBaseSize} ${market} — preserving DB (source of truth). Position clearing only happens via explicit trade execution.`);
      lastReconcileTime.set(botId, Date.now());
      return { synced: true, discrepancy: false };
    }

    const hasDiscrepancy = Math.abs(dbBaseSize - onChainBaseSize) > 0.0001;
    
    if (hasDiscrepancy) {
      console.log(`[Reconcile] Bot ${botId}: DB=${dbBaseSize}, OnChain=${onChainBaseSize} - syncing`);

      if (onChainHasRealPosition) {
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

let consecutiveDbTimeouts = 0;

function isDbTimeout(error: any): boolean {
  const msg = error?.message || "";
  return msg.includes("Authentication timed out") || msg.includes("connection timeout") || msg.includes("timeout exceeded") || msg.includes("too many clients") || msg.includes("Connection terminated");
}

export function startPeriodicReconciliation(): void {
  if (reconcileInterval) return;
  
  console.log("[Reconcile] Starting periodic reconciliation (every 60s)");
  
  reconcileInterval = setInterval(async () => {
    if (consecutiveDbTimeouts > 0) {
      consecutiveDbTimeouts--;
      console.log(`[Reconcile] DB pressure backoff — skipping cycle (${consecutiveDbTimeouts} remaining)`);
      return;
    }
    try {
      const allWallets = await storage.getWalletsWithActiveBots();
      
      for (const walletAddress of allWallets) {
        const wallet = await storage.getWallet(walletAddress);
        if (!wallet?.agentPublicKey) continue;
        
        const bots = await storage.getTradingBots(walletAddress);
        
        const botsWithPositions = await Promise.all(
          bots.map(async (bot) => {
            if (bot.isActive) return bot;
            const pos = await storage.getBotPosition(bot.id, bot.market);
            if (pos && Math.abs(parseFloat(pos.baseSize)) > 0.0001) return bot;
            return null;
          })
        );
        const botsToReconcile = botsWithPositions.filter((b): b is typeof bots[0] => b !== null);
        
        if (botsToReconcile.length === 0) continue;
        
        for (const bot of botsToReconcile) {
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
      consecutiveDbTimeouts = 0;
    } catch (error) {
      if (isDbTimeout(error)) {
        consecutiveDbTimeouts = Math.min(consecutiveDbTimeouts + 3, 10);
        console.warn(`[Reconcile] DB timeout — backing off ${consecutiveDbTimeouts} cycles`);
      } else {
        console.error("[Reconcile] Periodic reconciliation error:", error);
      }
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
