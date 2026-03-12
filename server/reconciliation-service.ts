import { storage } from "./storage";
import { getPerpPositions } from "./drift-service";
import { getMarketPrice } from "./drift-price";
import type { TradingBot } from "@shared/schema";

const STALE_THRESHOLD_MS = 60 * 1000; // 60 seconds
const LIQUIDATION_TRADE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function normalizeMarket(market: string): string {
  return market.toUpperCase()
    .replace(/-PERP$/i, '')
    .replace(/PERP$/i, '')
    .replace(/USD[CT]?$/i, '')
    .replace(/[-_/]/g, '');
}
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
    const onChainPositions = await getPerpPositions(agentPublicKey, subAccountId);
    const normalizedMarket = normalizeMarket(market);
    const onChainPos = onChainPositions.find(p => normalizeMarket(p.market) === normalizedMarket);
    
    // Get existing DB position to calculate realized PnL delta
    const dbPosition = await storage.getBotPosition(botId, market);
    const existingRealizedPnl = dbPosition ? parseFloat(dbPosition.realizedPnl) : 0;
    const existingFees = dbPosition ? parseFloat(dbPosition.totalFees) : 0;
    const previousBaseSize = dbPosition ? parseFloat(dbPosition.baseSize) : 0;
    const previousAvgEntry = dbPosition ? parseFloat(dbPosition.avgEntryPrice) : 0;
    
    const onChainBaseSize = onChainPos?.baseAssetAmount || 0;
    
    // Calculate realized PnL from this trade
    // Realized PnL occurs when position size decreases (closing or reducing position)
    let tradePnl = 0;
    
    if (Math.abs(previousBaseSize) > 0.0001 && tradeFillPrice > 0 && tradeSize > 0) {
      // Normalize trade side for comparison
      const normalizedSide = tradeSide.toLowerCase();
      
      // Check if this trade reduced the position (opposite side)
      const isReducing = (previousBaseSize > 0 && normalizedSide === 'short') ||
                         (previousBaseSize < 0 && normalizedSide === 'long');
      
      if (isReducing) {
        // Calculate PnL on the closed portion only
        const closedSize = Math.min(Math.abs(previousBaseSize), tradeSize);
        
        // Prorate fee: only the portion of fee for the closed size affects realized PnL
        // If trade size > closed size (flip/overclose), some fee goes to the new position
        const feeRatio = closedSize / tradeSize;
        const closeFee = tradeFee * feeRatio;
        
        if (previousBaseSize > 0) {
          // Was LONG, selling to close - PnL = (fillPrice - avgEntry) * closedSize - prorated fee
          tradePnl = (tradeFillPrice - previousAvgEntry) * closedSize - closeFee;
        } else {
          // Was SHORT, buying to close - PnL = (avgEntry - fillPrice) * closedSize - prorated fee
          tradePnl = (previousAvgEntry - tradeFillPrice) * closedSize - closeFee;
        }
        
        console.log(`[Sync] Realized PnL from close: $${tradePnl.toFixed(4)} (closed ${closedSize.toFixed(4)} @ $${tradeFillPrice.toFixed(2)}, entry was $${previousAvgEntry.toFixed(2)}, fee prorated: $${closeFee.toFixed(4)})`);
      }
    }
    
    const newRealizedPnl = existingRealizedPnl + tradePnl;
    const newTotalFees = existingFees + tradeFee;
    
    if (onChainPos && Math.abs(onChainBaseSize) > 0.0001) {
      // Position exists on-chain - update DB with actual values
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
    } else {
      // No position on-chain (position fully closed)
      const position = await storage.upsertBotPosition({
        tradingBotId: botId,
        walletAddress,
        market,
        baseSize: "0",
        avgEntryPrice: "0",
        costBasis: "0",
        realizedPnl: String(newRealizedPnl),
        totalFees: String(newTotalFees),
        lastTradeId: tradeId,
        lastTradeAt: new Date(),
      });
      
      console.log(`[Sync] Position cleared, cumulative realized PnL: $${newRealizedPnl.toFixed(4)}`);
      return { success: true, position, tradePnl, isClosingTrade: tradePnl !== 0 };
    }
  } catch (error) {
    console.error(`[Sync] Failed to sync position from on-chain:`, error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function detectAndRecordLiquidation(
  botId: string,
  walletAddress: string,
  market: string,
  dbBaseSize: number,
  onChainBaseSize: number,
  dbEntryPrice: number,
  onChainEntryPrice: number,
  dbPosition: { realizedPnl: string; totalFees: string } | null
): Promise<boolean> {
  try {
    const recentTrades = await storage.getBotTrades(botId, 10);
    const now = Date.now();
    const normalizedMkt = normalizeMarket(market);
    const recentExecutedTrades = recentTrades.filter(t => {
      const tradeTime = new Date(t.executedAt).getTime();
      return (now - tradeTime) < LIQUIDATION_TRADE_WINDOW_MS &&
        (t.status === 'executed' || t.status === 'pending') &&
        normalizeMarket(t.market) === normalizedMkt;
    });

    const sizeDelta = Math.abs(dbBaseSize) - Math.abs(onChainBaseSize);
    if (sizeDelta <= 0.0001) {
      return false;
    }

    if (recentExecutedTrades.length > 0) {
      const recentTradeVolume = recentExecutedTrades.reduce((sum, t) => sum + Math.abs(parseFloat(t.size)), 0);
      if (recentTradeVolume >= sizeDelta * 0.5) {
        return false;
      }
      console.log(`[Reconcile] Recent trades (${recentTradeVolume.toFixed(4)}) don't explain position drop (${sizeDelta.toFixed(4)}) for ${market} - likely liquidation`);
    }

    const markPrice = await getMarketPrice(market) || dbEntryPrice;
    const liquidatedSize = sizeDelta;
    let estimatedPnl = 0;

    if (dbEntryPrice > 0 && markPrice > 0) {
      if (dbBaseSize > 0) {
        estimatedPnl = (markPrice - dbEntryPrice) * liquidatedSize;
      } else {
        estimatedPnl = (dbEntryPrice - markPrice) * liquidatedSize;
      }
    }

    const side = Math.abs(onChainBaseSize) < 0.0001 ? 'CLOSE' : (dbBaseSize > 0 ? 'SHORT' : 'LONG');

    const liquidationTrade = await storage.createBotTrade({
      tradingBotId: botId,
      walletAddress,
      market,
      side,
      size: String(liquidatedSize),
      price: String(markPrice),
      fee: "0",
      pnl: String(estimatedPnl),
      status: "liquidated",
      txSignature: null,
      webhookPayload: null,
      errorMessage: `Position liquidated: ${liquidatedSize.toFixed(4)} ${market} at ~$${markPrice.toFixed(2)}. Estimated loss: $${estimatedPnl.toFixed(2)}`,
      executionMethod: "liquidation",
    });

    console.log(`[Reconcile] LIQUIDATION DETECTED for bot ${botId}: ${liquidatedSize.toFixed(4)} ${market} liquidated at ~$${markPrice.toFixed(2)}, est PnL: $${estimatedPnl.toFixed(2)}`);

    const bot = await storage.getTradingBotById(botId);
    if (bot) {
      const stats = bot.stats as TradingBot['stats'] || { totalTrades: 0, winningTrades: 0, losingTrades: 0, totalPnl: 0, totalVolume: 0 };
      await storage.updateTradingBotStats(botId, {
        ...stats,
        totalTrades: (stats.totalTrades || 0) + 1,
        losingTrades: (stats.losingTrades || 0) + 1,
        totalPnl: (stats.totalPnl || 0) + estimatedPnl,
        totalVolume: (stats.totalVolume || 0) + (liquidatedSize * markPrice),
        lastTradeAt: new Date().toISOString(),
      });
    }

    const currentPnl = dbPosition ? parseFloat(dbPosition.realizedPnl) : 0;
    const newPnl = currentPnl + estimatedPnl;

    if (Math.abs(onChainBaseSize) > 0.0001) {
      await storage.upsertBotPosition({
        tradingBotId: botId,
        walletAddress,
        market,
        baseSize: String(onChainBaseSize),
        avgEntryPrice: String(onChainEntryPrice || dbEntryPrice),
        costBasis: String(Math.abs(onChainBaseSize) * (onChainEntryPrice || dbEntryPrice)),
        realizedPnl: String(newPnl),
        totalFees: dbPosition?.totalFees || "0",
        lastTradeId: liquidationTrade.id,
        lastTradeAt: new Date(),
      });
    } else {
      await storage.upsertBotPosition({
        tradingBotId: botId,
        walletAddress,
        market,
        baseSize: "0",
        avgEntryPrice: "0",
        costBasis: "0",
        realizedPnl: String(newPnl),
        totalFees: dbPosition?.totalFees || "0",
        lastTradeId: liquidationTrade.id,
        lastTradeAt: new Date(),
      });
    }

    return true;
  } catch (error) {
    console.error(`[Reconcile] Error detecting liquidation for bot ${botId}:`, error);
    return false;
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
    const onChainPositions = await getPerpPositions(agentPublicKey, subAccountId);
    const normalizedMarket = normalizeMarket(market);
    const onChainPos = onChainPositions.find(p => normalizeMarket(p.market) === normalizedMarket);
    const dbPosition = await storage.getBotPosition(botId, market);
    
    const dbBaseSize = dbPosition ? parseFloat(dbPosition.baseSize) : 0;
    const onChainBaseSize = onChainPos?.baseAssetAmount || 0;
    
    const hasDiscrepancy = Math.abs(dbBaseSize - onChainBaseSize) > 0.0001;
    
    if (hasDiscrepancy) {
      console.log(`[Reconcile] Bot ${botId}: DB=${dbBaseSize}, OnChain=${onChainBaseSize} - syncing`);
      
      const positionDecreased = Math.abs(dbBaseSize) > Math.abs(onChainBaseSize) + 0.0001;
      if (positionDecreased && Math.abs(dbBaseSize) > 0.0001) {
        const dbEntryPrice = dbPosition ? parseFloat(dbPosition.avgEntryPrice) : 0;
        const onChainEntryPrice = onChainPos?.entryPrice || 0;
        const wasLiquidation = await detectAndRecordLiquidation(
          botId, walletAddress, market,
          dbBaseSize, onChainBaseSize, dbEntryPrice, onChainEntryPrice,
          dbPosition ? { realizedPnl: dbPosition.realizedPnl, totalFees: dbPosition.totalFees } : null
        );

        if (wasLiquidation) {
          lastReconcileTime.set(botId, Date.now());
          return { synced: true, discrepancy: true, liquidation: true };
        }
      }

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
        
        // Reconcile active bots AND any bots that have non-zero positions (even if paused)
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
