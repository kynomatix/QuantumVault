import { storage } from "./storage";
import { db } from "./db";
import { botTrades } from "@shared/schema";
import { eq, and, or, sql, gte } from "drizzle-orm";
import { getPerpPositions } from "./drift-service";
import { getMarketPrice } from "./drift-price";
import type { TradingBot } from "@shared/schema";
import { normalizeMarket } from "./protocol/symbol-registry";

const STALE_THRESHOLD_MS = 60 * 1000; // 60 seconds
const LIQUIDATION_TRADE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const RECENT_TRADE_COOLDOWN_MS = 30 * 1000; // 30 seconds cooldown after recent trade activity
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

const PENDING_TRADE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes max age for pending trades to block liquidation detection

async function hasInFlightOrRecentCloseTrade(
  botId: string,
  market: string
): Promise<boolean> {
  const recentTrades = await storage.getBotTrades(botId, 20);
  const now = Date.now();
  const normalizedMkt = normalizeMarket(market);

  for (const t of recentTrades) {
    const tradeTime = new Date(t.executedAt).getTime();
    const tradeMarket = normalizeMarket(t.market);
    if (tradeMarket !== normalizedMkt) continue;

    const isCloseTrade = t.side === 'CLOSE' || t.side === 'close';

    if (!isCloseTrade) continue;

    if (t.status === 'pending' && (now - tradeTime) < PENDING_TRADE_MAX_AGE_MS) {
      console.log(`[Reconcile] Skipping liquidation check — pending CLOSE trade ${t.id} (${((now - tradeTime) / 1000).toFixed(0)}s old) exists for ${market}`);
      return true;
    }

    if ((t.status === 'executed' || t.status === 'recovered') && (now - tradeTime) < RECENT_TRADE_COOLDOWN_MS) {
      console.log(`[Reconcile] Skipping liquidation check — recently ${t.status} CLOSE trade ${t.id} (${((now - tradeTime) / 1000).toFixed(0)}s ago) for ${market}`);
      return true;
    }
  }
  return false;
}

type LiquidationResult = 'liquidated' | 'skipped_in_flight' | 'not_liquidation';

async function detectAndRecordLiquidation(
  botId: string,
  walletAddress: string,
  market: string,
  dbBaseSize: number,
  onChainBaseSize: number,
  dbEntryPrice: number,
  onChainEntryPrice: number,
  dbPosition: { realizedPnl: string; totalFees: string } | null
): Promise<LiquidationResult> {
  try {
    if (await hasInFlightOrRecentCloseTrade(botId, market)) {
      return 'skipped_in_flight';
    }

    const recentTrades = await storage.getBotTrades(botId, 20);
    const now = Date.now();
    const normalizedMkt = normalizeMarket(market);
    const recentExecutedTrades = recentTrades.filter(t => {
      const tradeTime = new Date(t.executedAt).getTime();
      return (now - tradeTime) < LIQUIDATION_TRADE_WINDOW_MS &&
        (t.status === 'executed' || t.status === 'pending' || t.status === 'recovered') &&
        normalizeMarket(t.market) === normalizedMkt;
    });

    const sizeDelta = Math.abs(dbBaseSize) - Math.abs(onChainBaseSize);
    if (sizeDelta <= 0.0001) {
      return 'not_liquidation';
    }

    if (recentExecutedTrades.length > 0) {
      const recentTradeVolume = recentExecutedTrades.reduce((sum, t) => sum + Math.abs(parseFloat(t.size)), 0);
      if (recentTradeVolume >= sizeDelta * 0.3) {
        return 'not_liquidation';
      }
      console.log(`[Reconcile] Recent trades (${recentTradeVolume.toFixed(4)}) don't explain position drop (${sizeDelta.toFixed(4)}) for ${market} - checking further`);
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

    if (estimatedPnl > 0) {
      console.log(`[Reconcile] NOT a liquidation for bot ${botId} ${market}: estimated PnL is positive ($${estimatedPnl.toFixed(2)}). Likely a normal trade closure — syncing position without liquidation record.`);
      return 'not_liquidation';
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

    return 'liquidated';
  } catch (error) {
    console.error(`[Reconcile] Error detecting liquidation for bot ${botId}:`, error);
    return 'not_liquidation';
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
        const liquidationResult = await detectAndRecordLiquidation(
          botId, walletAddress, market,
          dbBaseSize, onChainBaseSize, dbEntryPrice, onChainEntryPrice,
          dbPosition ? { realizedPnl: dbPosition.realizedPnl, totalFees: dbPosition.totalFees } : null
        );

        if (liquidationResult === 'liquidated') {
          lastReconcileTime.set(botId, Date.now());
          return { synced: true, discrepancy: true, liquidation: true };
        }

        if (liquidationResult === 'skipped_in_flight') {
          console.log(`[Reconcile] Deferring position sync for bot ${botId} ${market} — trade in flight or awaiting confirmation. Will re-check next cycle.`);
          return { synced: false, discrepancy: true };
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

export async function correctFalseLiquidations(walletAddress?: string): Promise<{ corrected: number; statsFixed: number; errors: string[] }> {
  const errors: string[] = [];
  let corrected = 0;
  let statsFixed = 0;

  try {
    const conditions = [
      eq(botTrades.status, 'liquidated'),
      sql`CAST(${botTrades.pnl} AS numeric) > 0`,
    ];
    if (walletAddress) {
      conditions.push(eq(botTrades.walletAddress, walletAddress));
    }
    const falseLiquidations = await db
      .select()
      .from(botTrades)
      .where(and(...conditions));

    console.log(`[CorrectFalseLiqs] Found ${falseLiquidations.length} liquidation-tagged trades with positive PnL`);

    for (const trade of falseLiquidations) {
      try {
        await db.update(botTrades)
          .set({
            status: 'executed',
            executionMethod: 'corrected-from-liquidation',
            errorMessage: `${trade.errorMessage || ''} [Corrected: was falsely tagged as liquidation, PnL=$${trade.pnl}]`.trim(),
          })
          .where(eq(botTrades.id, trade.id));

        corrected++;
        console.log(`[CorrectFalseLiqs] Corrected trade ${trade.id} for bot ${trade.tradingBotId} (PnL: $${trade.pnl})`);

        const bot = await storage.getTradingBotById(trade.tradingBotId);
        if (bot) {
          const stats = bot.stats as TradingBot['stats'] || { totalTrades: 0, winningTrades: 0, losingTrades: 0, totalPnl: 0, totalVolume: 0 };
          await storage.updateTradingBotStats(trade.tradingBotId, {
            ...stats,
            losingTrades: Math.max(0, (stats.losingTrades || 0) - 1),
            winningTrades: (stats.winningTrades || 0) + 1,
          });
          statsFixed++;
          console.log(`[CorrectFalseLiqs] Fixed stats for bot ${trade.tradingBotId}: moved trade from losing to winning`);
        }
      } catch (err: any) {
        const msg = `Failed to correct trade ${trade.id}: ${err.message}`;
        console.error(`[CorrectFalseLiqs] ${msg}`);
        errors.push(msg);
      }
    }
  } catch (err: any) {
    const msg = `Failed to query false liquidations: ${err.message}`;
    console.error(`[CorrectFalseLiqs] ${msg}`);
    errors.push(msg);
  }

  console.log(`[CorrectFalseLiqs] Complete: ${corrected} trades corrected, ${statsFixed} bot stats fixed, ${errors.length} errors`);
  return { corrected, statsFixed, errors };
}

export async function backfillLiquidationRecords(): Promise<{ created: number; skipped: number; errors: string[] }> {
  const errors: string[] = [];
  let created = 0;
  let skipped = 0;

  interface BackfillRecord {
    botId: string;
    wallet: string;
    market: string;
    side: string;
    size: string;
    entryPrice: string;
    exitPrice: string;
    pnl: string;
    time: string;
    name: string;
    type: 'liquidation' | 'implicit_close' | 'partial_liquidation';
  }

  const records: BackfillRecord[] = [
    // ── FULL LIQUIDATIONS ──
    // Position went to zero without a CLOSE trade (on-chain liquidation ate entire remaining position)

    { botId: 'b4d43164-9b59-45bc-ba5a-747e31655a9e', wallet: '6ULLaZkuWoML1qN23TqSw9ANBBCGFXaAvKbFzXj2Kehh',
      market: 'DOGE-PERP', side: 'CLOSE', size: '202.85178424', entryPrice: '0.103303', exitPrice: '0.103303',
      pnl: '-7.25', time: '2026-02-02 10:00:00', name: 'DOGE 2H OI Skalpa', type: 'liquidation' },

    { botId: 'a69ce267-fa8b-4e48-b5d6-757b5788680d', wallet: '6ULLaZkuWoML1qN23TqSw9ANBBCGFXaAvKbFzXj2Kehh',
      market: 'SOL-PERP', side: 'CLOSE', size: '0.11505717', entryPrice: '112.226520', exitPrice: '112.226520',
      pnl: '-10.51', time: '2026-01-31 16:30:00', name: 'SOL 45m OI Skalpa V3', type: 'liquidation' },

    { botId: '5747b024-e6df-471f-a842-6ee67977cbd0', wallet: 'AqTTQQajeKDjbDU5sb6JoQfTJ8HfHzpjne2sFmYthCez',
      market: 'SOL-PERP', side: 'CLOSE', size: '0.05286352', entryPrice: '144.879464', exitPrice: '144.879464',
      pnl: '-1.80', time: '2026-01-15 21:30:00', name: 'SOL 1m AR37', type: 'liquidation' },

    { botId: '46ab51cb-9f61-40c6-9dbc-c962d8e7d8ec', wallet: 'AqTTQQajeKDjbDU5sb6JoQfTJ8HfHzpjne2sFmYthCez',
      market: 'SOL-PERP', side: 'CLOSE', size: '0.13947183', entryPrice: '145.883416', exitPrice: '145.883416',
      pnl: '-1.21', time: '2026-01-15 21:00:00', name: 'SOL 5m AR37', type: 'liquidation' },

    { botId: 'cbd05f9a-f0a6-49d6-a8c8-47ba102c284f', wallet: 'F7H3mBZRjhYeEc4HH1ry1vL9BbBs6GntHBknUGgnwrGZ',
      market: 'RENDER-PERP', side: 'CLOSE', size: '26.37013681', entryPrice: '1.450430', exitPrice: '1.450430',
      pnl: '-4.74', time: '2026-02-25 12:00:00', name: 'RNDR 45m BB Pro (Copy)', type: 'liquidation' },

    { botId: '4c7d6610-4322-4dbf-afeb-ef1dc009cb87', wallet: 'F7H3mBZRjhYeEc4HH1ry1vL9BbBs6GntHBknUGgnwrGZ',
      market: 'FARTCOIN-PERP', side: 'CLOSE', size: '22.06741024', entryPrice: '0.147129', exitPrice: '0.147129',
      pnl: '-0.22', time: '2026-02-25 00:00:00', name: 'FARTCOIN 4H OI Skalpa (Copy)', type: 'liquidation' },

    { botId: 'ce22aa00-45d0-4758-add8-9986300be854', wallet: 'F7H3mBZRjhYeEc4HH1ry1vL9BbBs6GntHBknUGgnwrGZ',
      market: 'SUI-PERP', side: 'CLOSE', size: '5.69608751', entryPrice: '0.964165', exitPrice: '0.964165',
      pnl: '-2.54', time: '2026-02-17 00:00:00', name: 'SUI 1H OI Skalpa (Copy)', type: 'liquidation' },

    // ── PARTIAL LIQUIDATION ──
    // DRIFT: LONG 4381 reduced to ~778 by on-chain partial liq before Mar 6 SHORT 190

    { botId: 'e9ac3a91-9d89-4be2-b11d-ae8e02f974e5', wallet: 'BuhEYpvrWV1y18jZoY8Hgfyf2pj3nqYXvmPefvBVzk41',
      market: 'DRIFT-PERP', side: 'CLOSE', size: '3602.86', entryPrice: '0.095500', exitPrice: '0.085000',
      pnl: '-37.83', time: '2026-03-04 00:00:00', name: 'DRIFT 8H BB Pro (partial liq)', type: 'partial_liquidation' },

    // ── IMPLICIT CLOSES (direction flips where the close was not recorded) ──
    // On Drift, sending opposite-direction order closes old position + opens new in one tx.
    // The old close PnL was never tracked. These are normal trades, not liquidations.

    // RNDR 2H OI Skalpa (Copy) — 3 direction flips
    { botId: '2afe9363-e7f1-4d3c-b32e-da2672929dba', wallet: 'F7H3mBZRjhYeEc4HH1ry1vL9BbBs6GntHBknUGgnwrGZ',
      market: 'RENDER-PERP', side: 'CLOSE', size: '34.30', entryPrice: '1.442710', exitPrice: '1.461638',
      pnl: '-0.65', time: '2026-02-17 16:00:36', name: 'RNDR 2H Copy: close SHORT before LONG flip', type: 'implicit_close' },
    { botId: '2afe9363-e7f1-4d3c-b32e-da2672929dba', wallet: 'F7H3mBZRjhYeEc4HH1ry1vL9BbBs6GntHBknUGgnwrGZ',
      market: 'RENDER-PERP', side: 'CLOSE', size: '41.68', entryPrice: '1.460558', exitPrice: '1.446603',
      pnl: '-0.58', time: '2026-02-19 02:01:10', name: 'RNDR 2H Copy: close LONG before SHORT flip', type: 'implicit_close' },
    { botId: '2afe9363-e7f1-4d3c-b32e-da2672929dba', wallet: 'F7H3mBZRjhYeEc4HH1ry1vL9BbBs6GntHBknUGgnwrGZ',
      market: 'RENDER-PERP', side: 'CLOSE', size: '28.32', entryPrice: '1.392532', exitPrice: '1.416956',
      pnl: '0.69', time: '2026-02-20 02:00:22', name: 'RNDR 2H Copy: close LONG before SHORT flip', type: 'implicit_close' },

    // RNDR 4H AR37 — 2 direction flips
    { botId: '34617bf6-df22-49b0-a86f-62d5591a1984', wallet: 'BuhEYpvrWV1y18jZoY8Hgfyf2pj3nqYXvmPefvBVzk41',
      market: 'RENDER-PERP', side: 'CLOSE', size: '72.27', entryPrice: '1.383082', exitPrice: '1.383082',
      pnl: '0.00', time: '2026-02-24 08:00:06', name: 'RNDR 4H AR37: close LONG before SHORT flip', type: 'implicit_close' },
    { botId: '34617bf6-df22-49b0-a86f-62d5591a1984', wallet: 'BuhEYpvrWV1y18jZoY8Hgfyf2pj3nqYXvmPefvBVzk41',
      market: 'RENDER-PERP', side: 'CLOSE', size: '73.78', entryPrice: '1.345176', exitPrice: '1.356984',
      pnl: '0.87', time: '2026-03-06 20:00:06', name: 'RNDR 4H AR37: close LONG before SHORT flip', type: 'implicit_close' },

    // FARTCOIN 4H OI Skalpa (Copy) — 6 direction flips
    { botId: '4c7d6610-4322-4dbf-afeb-ef1dc009cb87', wallet: 'F7H3mBZRjhYeEc4HH1ry1vL9BbBs6GntHBknUGgnwrGZ',
      market: 'FARTCOIN-PERP', side: 'CLOSE', size: '108.39', entryPrice: '0.175000', exitPrice: '0.212522',
      pnl: '4.07', time: '2026-02-15 06:00:18', name: 'FARTCOIN Copy: close LONG before SHORT flip', type: 'implicit_close' },
    { botId: '4c7d6610-4322-4dbf-afeb-ef1dc009cb87', wallet: 'F7H3mBZRjhYeEc4HH1ry1vL9BbBs6GntHBknUGgnwrGZ',
      market: 'FARTCOIN-PERP', side: 'CLOSE', size: '96.54', entryPrice: '0.198077', exitPrice: '0.194651',
      pnl: '0.33', time: '2026-02-17 10:00:26', name: 'FARTCOIN Copy: close SHORT before LONG flip', type: 'implicit_close' },
    { botId: '4c7d6610-4322-4dbf-afeb-ef1dc009cb87', wallet: 'F7H3mBZRjhYeEc4HH1ry1vL9BbBs6GntHBknUGgnwrGZ',
      market: 'FARTCOIN-PERP', side: 'CLOSE', size: '81.01', entryPrice: '0.194651', exitPrice: '0.193243',
      pnl: '-0.11', time: '2026-02-17 16:00:31', name: 'FARTCOIN Copy: close LONG before SHORT flip', type: 'implicit_close' },
    { botId: '4c7d6610-4322-4dbf-afeb-ef1dc009cb87', wallet: 'F7H3mBZRjhYeEc4HH1ry1vL9BbBs6GntHBknUGgnwrGZ',
      market: 'FARTCOIN-PERP', side: 'CLOSE', size: '74.19', entryPrice: '0.194100', exitPrice: '0.193828',
      pnl: '0.02', time: '2026-02-18 18:00:32', name: 'FARTCOIN Copy: close SHORT before LONG flip', type: 'implicit_close' },
    { botId: '4c7d6610-4322-4dbf-afeb-ef1dc009cb87', wallet: 'F7H3mBZRjhYeEc4HH1ry1vL9BbBs6GntHBknUGgnwrGZ',
      market: 'FARTCOIN-PERP', side: 'CLOSE', size: '68.08', entryPrice: '0.185599', exitPrice: '0.161917',
      pnl: '1.61', time: '2026-02-23 02:00:23', name: 'FARTCOIN Copy: close SHORT before LONG flip', type: 'implicit_close' },
    { botId: '4c7d6610-4322-4dbf-afeb-ef1dc009cb87', wallet: 'F7H3mBZRjhYeEc4HH1ry1vL9BbBs6GntHBknUGgnwrGZ',
      market: 'FARTCOIN-PERP', side: 'CLOSE', size: '33.41', entryPrice: '0.140081', exitPrice: '0.147129',
      pnl: '0.24', time: '2026-02-24 21:00:23', name: 'FARTCOIN Copy: close LONG before SHORT flip', type: 'implicit_close' },

    // SOL 1m AR37 — 2 direction flips
    { botId: '5747b024-e6df-471f-a842-6ee67977cbd0', wallet: 'AqTTQQajeKDjbDU5sb6JoQfTJ8HfHzpjne2sFmYthCez',
      market: 'SOL-PERP', side: 'CLOSE', size: '0.0587', entryPrice: '146.231506', exitPrice: '145.308006',
      pnl: '-0.05', time: '2026-01-14 04:11:00', name: 'SOL 1m AR37: close LONG before SHORT flip', type: 'implicit_close' },
    { botId: '5747b024-e6df-471f-a842-6ee67977cbd0', wallet: 'AqTTQQajeKDjbDU5sb6JoQfTJ8HfHzpjne2sFmYthCez',
      market: 'SOL-PERP', side: 'CLOSE', size: '0.0530', entryPrice: '144.475000', exitPrice: '146.776733',
      pnl: '0.12', time: '2026-01-14 17:34:01', name: 'SOL 1m AR37: close LONG before SHORT flip', type: 'implicit_close' },

    // XPL 45m Adaptive — 1 direction flip
    { botId: '62a5ff6e-d364-45ef-9b53-7bf8eadcbc67', wallet: '6ULLaZkuWoML1qN23TqSw9ANBBCGFXaAvKbFzXj2Kehh',
      market: 'XPL-PERP', side: 'CLOSE', size: '157.61', entryPrice: '0.129149', exitPrice: '0.129150',
      pnl: '0.00', time: '2026-01-21 21:00:13', name: 'XPL 45m: close LONG before SHORT flip', type: 'implicit_close' },

    // JUP 8H BB Trend Pro — direction flip, NOT a liquidation (LONG 2603 closed at $0.1704)
    { botId: '718fa880-bdfb-4d23-a498-88f32996d977', wallet: 'BuhEYpvrWV1y18jZoY8Hgfyf2pj3nqYXvmPefvBVzk41',
      market: 'JUP-PERP', side: 'CLOSE', size: '2602.95', entryPrice: '0.187364', exitPrice: '0.170400',
      pnl: '-44.16', time: '2026-03-08 00:00:05', name: 'JUP 8H BB: close LONG before SHORT flip', type: 'implicit_close' },

    // SOL 45m OI Skalpa — 3 direction flips
    { botId: '961b804b-164f-4d54-8373-3dcbbeb525e7', wallet: '6ULLaZkuWoML1qN23TqSw9ANBBCGFXaAvKbFzXj2Kehh',
      market: 'SOL-PERP', side: 'CLOSE', size: '0.3614', entryPrice: '115.358602', exitPrice: '115.187231',
      pnl: '0.06', time: '2026-01-30 07:30:01', name: 'SOL 45m Skalpa: close SHORT before LONG flip', type: 'implicit_close' },
    { botId: '961b804b-164f-4d54-8373-3dcbbeb525e7', wallet: '6ULLaZkuWoML1qN23TqSw9ANBBCGFXaAvKbFzXj2Kehh',
      market: 'SOL-PERP', side: 'CLOSE', size: '0.2115', entryPrice: '101.719611', exitPrice: '101.623643',
      pnl: '-0.02', time: '2026-02-02 01:30:00', name: 'SOL 45m Skalpa: close LONG before SHORT flip', type: 'implicit_close' },
    { botId: '961b804b-164f-4d54-8373-3dcbbeb525e7', wallet: '6ULLaZkuWoML1qN23TqSw9ANBBCGFXaAvKbFzXj2Kehh',
      market: 'SOL-PERP', side: 'CLOSE', size: '0.1839', entryPrice: '97.315000', exitPrice: '96.994772',
      pnl: '0.06', time: '2026-02-04 11:15:00', name: 'SOL 45m Skalpa: close SHORT before LONG flip', type: 'implicit_close' },

    // DOGE 4H FluxMomentum — 3 partial closes (reduce-only, not direction flips)
    { botId: '9ad9f2c1-7fb9-4668-8f4e-98abd7fb153b', wallet: 'BuhEYpvrWV1y18jZoY8Hgfyf2pj3nqYXvmPefvBVzk41',
      market: 'DOGE-PERP', side: 'CLOSE', size: '51.28', entryPrice: '0.096913', exitPrice: '0.096913',
      pnl: '0.00', time: '2026-02-23 04:00:08', name: 'DOGE FluxMom: partial close SHORT 51/977', type: 'implicit_close' },
    { botId: '9ad9f2c1-7fb9-4668-8f4e-98abd7fb153b', wallet: 'BuhEYpvrWV1y18jZoY8Hgfyf2pj3nqYXvmPefvBVzk41',
      market: 'DOGE-PERP', side: 'CLOSE', size: '849.69', entryPrice: '0.093798', exitPrice: '0.093798',
      pnl: '0.00', time: '2026-02-28 08:00:05', name: 'DOGE FluxMom: partial close SHORT 850/1063', type: 'implicit_close' },
    { botId: '9ad9f2c1-7fb9-4668-8f4e-98abd7fb153b', wallet: 'BuhEYpvrWV1y18jZoY8Hgfyf2pj3nqYXvmPefvBVzk41',
      market: 'DOGE-PERP', side: 'CLOSE', size: '212.34', entryPrice: '0.094908', exitPrice: '0.094908',
      pnl: '0.00', time: '2026-03-10 16:00:10', name: 'DOGE FluxMom: partial close LONG 212/550', type: 'implicit_close' },

    // SUI 4H FluxMomentum — 1 direction flip
    { botId: 'b703b0bf-97a8-4557-ab09-e5b132eead22', wallet: 'BuhEYpvrWV1y18jZoY8Hgfyf2pj3nqYXvmPefvBVzk41',
      market: 'SUI-PERP', side: 'CLOSE', size: '193.74', entryPrice: '0.892100', exitPrice: '0.849100',
      pnl: '8.33', time: '2026-02-28 08:00:07', name: 'SUI FluxMom: close SHORT before LONG flip', type: 'implicit_close' },

    // RNDR 45m BB Pro (Copy) — 1 direction flip (first flip already has PnL on SHORT trade, skip it)
    { botId: 'cbd05f9a-f0a6-49d6-a8c8-47ba102c284f', wallet: 'F7H3mBZRjhYeEc4HH1ry1vL9BbBs6GntHBknUGgnwrGZ',
      market: 'RENDER-PERP', side: 'CLOSE', size: '18.49', entryPrice: '1.471078', exitPrice: '1.450430',
      pnl: '0.38', time: '2026-02-20 06:45:23', name: 'RNDR 45m Copy: close SHORT before LONG flip', type: 'implicit_close' },

    // SUI 1H OI Skalpa (Copy) — 2 direction flips
    { botId: 'ce22aa00-45d0-4758-add8-9986300be854', wallet: 'F7H3mBZRjhYeEc4HH1ry1vL9BbBs6GntHBknUGgnwrGZ',
      market: 'SUI-PERP', side: 'CLOSE', size: '78.03', entryPrice: '0.931640', exitPrice: '1.005252',
      pnl: '5.74', time: '2026-02-14 12:00:13', name: 'SUI 1H Copy: close LONG before SHORT flip', type: 'implicit_close' },
    { botId: 'ce22aa00-45d0-4758-add8-9986300be854', wallet: 'F7H3mBZRjhYeEc4HH1ry1vL9BbBs6GntHBknUGgnwrGZ',
      market: 'SUI-PERP', side: 'CLOSE', size: '42.06', entryPrice: '1.023059', exitPrice: '0.962097',
      pnl: '-2.56', time: '2026-02-16 12:00:14', name: 'SUI 1H Copy: close LONG before SHORT flip', type: 'implicit_close' },

    // SOL 5m OI Scalpa V2 — 3 direction flips
    { botId: 'f4ca4805-fdcf-4744-a85b-014cb31cc50b', wallet: 'BuhEYpvrWV1y18jZoY8Hgfyf2pj3nqYXvmPefvBVzk41',
      market: 'SOL-PERP', side: 'CLOSE', size: '1.5637', entryPrice: '104.610018', exitPrice: '103.215000',
      pnl: '2.18', time: '2026-02-03 09:20:01', name: 'SOL 5m V2: close SHORT before LONG flip', type: 'implicit_close' },
    { botId: 'f4ca4805-fdcf-4744-a85b-014cb31cc50b', wallet: 'BuhEYpvrWV1y18jZoY8Hgfyf2pj3nqYXvmPefvBVzk41',
      market: 'SOL-PERP', side: 'CLOSE', size: '1.3946', entryPrice: '87.779000', exitPrice: '87.779000',
      pnl: '0.00', time: '2026-02-15 21:10:01', name: 'SOL 5m V2: close LONG before SHORT flip', type: 'implicit_close' },
    { botId: 'f4ca4805-fdcf-4744-a85b-014cb31cc50b', wallet: 'BuhEYpvrWV1y18jZoY8Hgfyf2pj3nqYXvmPefvBVzk41',
      market: 'SOL-PERP', side: 'CLOSE', size: '0.3816', entryPrice: '80.190900', exitPrice: '80.190900',
      pnl: '0.00', time: '2026-02-28 13:50:02', name: 'SOL 5m V2: close LONG before SHORT flip', type: 'implicit_close' },
  ];

  for (const r of records) {
    try {
      const existing = await storage.getBotTrades(r.botId, 200);
      const hasMatchingBackfill = existing.some(t => {
        if (r.type === 'liquidation' || r.type === 'partial_liquidation') {
          return (t.status === 'liquidated' || t.executionMethod === 'liquidation') &&
            t.errorMessage?.includes('backfilled');
        }
        return t.executionMethod === 'backfill-implicit-close' &&
          Math.abs(parseFloat(t.size) - parseFloat(r.size)) < 1 &&
          t.errorMessage?.includes(r.name);
      });

      if (hasMatchingBackfill) {
        console.log(`[Backfill] Skipping ${r.name} — already backfilled`);
        skipped++;
        continue;
      }

      const isLiq = r.type === 'liquidation' || r.type === 'partial_liquidation';
      const status = isLiq ? 'liquidated' : 'executed';
      const method = isLiq ? 'liquidation' : 'backfill-implicit-close';

      let msg: string;
      if (r.type === 'liquidation') {
        msg = `Position liquidated (backfilled): ${parseFloat(r.size).toFixed(4)} ${r.market} at ~$${parseFloat(r.exitPrice).toFixed(6)}. Estimated loss: $${Math.abs(parseFloat(r.pnl)).toFixed(2)}`;
      } else if (r.type === 'partial_liquidation') {
        msg = `Partial liquidation (backfilled): ${parseFloat(r.size).toFixed(4)} ${r.market} reduced from entry $${parseFloat(r.entryPrice).toFixed(6)} to ~$${parseFloat(r.exitPrice).toFixed(6)}. Estimated loss: $${Math.abs(parseFloat(r.pnl)).toFixed(2)}. ${r.name}`;
      } else {
        msg = `Implicit close (backfilled): ${parseFloat(r.size).toFixed(4)} ${r.market} closed at $${parseFloat(r.exitPrice).toFixed(6)} (entry $${parseFloat(r.entryPrice).toFixed(6)}). PnL: $${parseFloat(r.pnl).toFixed(2)}. ${r.name}`;
      }

      const trade = await storage.createBotTrade({
        tradingBotId: r.botId,
        walletAddress: r.wallet,
        market: r.market,
        side: r.side,
        size: r.size,
        price: r.exitPrice,
        fee: "0",
        pnl: r.pnl,
        status,
        txSignature: null,
        webhookPayload: null,
        errorMessage: msg,
        executionMethod: method,
      });

      await db.update(botTrades)
        .set({ executedAt: new Date(r.time) })
        .where(eq(botTrades.id, trade.id));

      console.log(`[Backfill] Created ${r.type} record: ${r.name} (PnL: $${r.pnl}, at: ${r.time})`);
      created++;
    } catch (err: any) {
      const msg = `Failed to backfill ${r.name}: ${err.message}`;
      console.error(`[Backfill] ${msg}`);
      errors.push(msg);
    }
  }

  console.log(`[Backfill] Complete: ${created} created, ${skipped} skipped, ${errors.length} errors`);
  return { created, skipped, errors };
}
