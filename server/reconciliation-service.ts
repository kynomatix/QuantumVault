import { storage } from "./storage";
import { normalizeMarket } from "./protocol/symbol-registry";
import { getDefaultAdapter } from "./protocol/adapter-registry";
import type { TradeRecord } from "./protocol/protocol-types";

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

interface CloseDetectionResult {
  detected: boolean;
  reason: 'tpsl' | 'liquidation' | 'external_close';
  fillPrice?: number;
  pnl?: number;
  fee?: number;
  protocolTradeId?: string;
}

async function detectOnChainClose(
  botId: string,
  agentPublicKey: string,
  market: string,
  dbPosition: { baseSize: string; avgEntryPrice: string; realizedPnl?: string; totalFees?: string; lastTradeId?: string | null },
  botSubaccountPublicKey?: string,
): Promise<CloseDetectionResult> {
  const noDetection: CloseDetectionResult = { detected: false, reason: 'external_close' };

  try {
    const adapter = getDefaultAdapter();
    const normalizedMarket = normalizeMarket(market);
    const dbBaseSize = parseFloat(dbPosition.baseSize);
    const entryPrice = parseFloat(dbPosition.avgEntryPrice);
    const positionSide = dbBaseSize > 0 ? 'long' : 'short';
    const closeSide = positionSide === 'long' ? 'short' : 'long';
    const absSize = Math.abs(dbBaseSize);

    let recentTrades: TradeRecord[] = [];
    try {
      const fiveMinAgo = Date.now() - 5 * 60 * 1000;
      recentTrades = await adapter.getTradeHistory(agentPublicKey, {
        limit: 50,
        startTime: fiveMinAgo,
        ...(botSubaccountPublicKey ? { subaccountId: botSubaccountPublicKey } : {}),
      });
    } catch (err) {
      console.log(`[Reconcile] Trade history fetch failed for ${botId}: ${err instanceof Error ? err.message : err}`);
    }

    const closingFills = recentTrades
      .filter(t =>
        normalizeMarket(t.internalSymbol) === normalizedMarket &&
        t.side === closeSide
      )
      .sort((a, b) => b.timestamp - a.timestamp);

    let aggregatedSize = 0;
    let weightedPriceSum = 0;
    let totalFee = 0;
    const matchedTradeIds: string[] = [];

    for (const fill of closingFills) {
      aggregatedSize += fill.size;
      weightedPriceSum += fill.price * fill.size;
      totalFee += fill.fee;
      matchedTradeIds.push(fill.tradeId);
      if (aggregatedSize >= absSize * 0.95) break;
    }

    const hasClosingTrades = aggregatedSize >= absSize * 0.80;

    let closeReason: 'tpsl' | 'liquidation' | 'external_close' = 'external_close';

    const bot = await storage.getTradingBotById(botId);
    const riskConfig = bot?.riskConfig as Record<string, unknown> | undefined;

    if (hasClosingTrades) {
      const avgFillPrice = weightedPriceSum / aggregatedSize;

      const tpPriceAbs = Number(riskConfig?.takeProfitPrice || 0);
      const slPriceAbs = Number(riskConfig?.stopLossPrice || 0);
      const tpPct = Number(riskConfig?.takeProfitPercent || 0);
      const slPct = Number(riskConfig?.stopLossPercent || 0);

      const tpPrice = tpPriceAbs > 0 ? tpPriceAbs : (tpPct > 0
        ? (positionSide === 'long' ? entryPrice * (1 + tpPct / 100) : entryPrice * (1 - tpPct / 100))
        : 0);
      const slPrice = slPriceAbs > 0 ? slPriceAbs : (slPct > 0
        ? (positionSide === 'long' ? entryPrice * (1 - slPct / 100) : entryPrice * (1 + slPct / 100))
        : 0);

      const hasTpSl = tpPrice > 0 || slPrice > 0;

      if (hasTpSl) {
        const hitTp = tpPrice > 0 && (
          positionSide === 'long'
            ? avgFillPrice >= tpPrice * 0.99
            : avgFillPrice <= tpPrice * 1.01
        );
        const hitSl = slPrice > 0 && (
          positionSide === 'long'
            ? avgFillPrice <= slPrice * 1.01
            : avgFillPrice >= slPrice * 0.99
        );

        if (hitTp || hitSl) {
          closeReason = 'tpsl';
          console.log(`[Reconcile] TP/SL detected for bot ${botId}: ${hitTp ? 'TP' : 'SL'} hit at $${avgFillPrice.toFixed(4)} (entry=$${entryPrice.toFixed(4)}, TP=$${tpPrice.toFixed(4)}, SL=$${slPrice.toFixed(4)})`);
        }
      }

      const pnl = positionSide === 'long'
        ? (avgFillPrice - entryPrice) * absSize
        : (entryPrice - avgFillPrice) * absSize;

      if (closeReason === 'external_close') {
        try {
          const subAcct = botSubaccountPublicKey || undefined;
          const accountInfo = await adapter.getAccountInfo(agentPublicKey, subAcct);
          if (accountInfo.equity < 1 && accountInfo.balance < 1) {
            closeReason = 'liquidation';
            console.log(`[Reconcile] Likely liquidation for bot ${botId}: account equity=$${accountInfo.equity.toFixed(2)}, balance=$${accountInfo.balance.toFixed(2)}`);
          }
        } catch { /* non-critical */ }
      }

      return {
        detected: true,
        reason: closeReason,
        fillPrice: avgFillPrice,
        pnl,
        fee: totalFee,
        protocolTradeId: matchedTradeIds.join(','),
      };
    }

    try {
      const subAcct = botSubaccountPublicKey || undefined;
      const accountInfo = await adapter.getAccountInfo(agentPublicKey, subAcct);

      const hasTpSlConfig = riskConfig && (
        Number(riskConfig.takeProfitPrice || 0) > 0 ||
        Number(riskConfig.stopLossPrice || 0) > 0 ||
        Number(riskConfig.takeProfitPercent || 0) > 0 ||
        Number(riskConfig.stopLossPercent || 0) > 0
      );

      if (hasTpSlConfig) {
        console.log(`[Reconcile] Position closed for bot ${botId} with TP/SL configured (no trade history, balance=$${accountInfo.balance.toFixed(2)}): classified as tpsl`);
        return {
          detected: true,
          reason: 'tpsl',
          fillPrice: entryPrice,
          pnl: 0,
          fee: 0,
        };
      }

      if (accountInfo.equity < 1 && accountInfo.balance < 1) {
        console.log(`[Reconcile] Likely liquidation for bot ${botId} (no closing trades, no TP/SL configured): equity=$${accountInfo.equity.toFixed(2)}, balance=$${accountInfo.balance.toFixed(2)}`);
        return {
          detected: true,
          reason: 'liquidation',
          fillPrice: entryPrice,
          pnl: -(absSize * entryPrice),
          fee: 0,
        };
      }

      if (accountInfo.balance > 1 || accountInfo.equity > 1) {
        console.log(`[Reconcile] Position closed for bot ${botId} (no trade history, balance=$${accountInfo.balance.toFixed(2)}): classified as external_close`);
        return {
          detected: true,
          reason: 'external_close',
          fillPrice: entryPrice,
          pnl: 0,
          fee: 0,
        };
      }
    } catch { /* non-critical */ }

    return noDetection;
  } catch (err) {
    console.error(`[Reconcile] detectOnChainClose error for bot ${botId}:`, err);
    return noDetection;
  }
}

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
  tradeSize: number = 0,
  botSubaccountPublicKey?: string
): Promise<{ success: boolean; position?: any; error?: string; tradePnl?: number; isClosingTrade?: boolean; onChainEntryPrice?: number }> {
  try {
    console.log(`[Sync] Force syncing bot ${botId} from on-chain (market=${market}, subaccount=${subAccountId}${botSubaccountPublicKey ? ', pacifica=' + botSubaccountPublicKey.slice(0,8) + '...' : ''})`);
    
    let fetchResult;
    if (botSubaccountPublicKey) {
      try {
        const positions = await getDefaultAdapter().getPositions(botSubaccountPublicKey);
        fetchResult = { positions: positions.map(p => ({
          marketIndex: 0,
          market: p.internalSymbol,
          baseAssetAmount: p.baseSize,
          side: (p.baseSize >= 0 ? 'LONG' : 'SHORT') as 'LONG' | 'SHORT',
          entryPrice: p.entryPrice,
          markPrice: p.markPrice,
          unrealizedPnl: p.unrealizedPnl,
          unrealizedPnlPercent: p.entryPrice > 0 && p.baseSize !== 0
            ? ((p.unrealizedPnl / (Math.abs(p.baseSize) * p.entryPrice)) * 100)
            : 0,
        })), fetchFailed: false };
      } catch (err) {
        console.log(`[Sync] Bot subaccount position fetch failed: ${err instanceof Error ? err.message : err}`);
        fetchResult = { positions: [], fetchFailed: true };
      }
    } else {
      fetchResult = await fetchPerpPositions(agentPublicKey, subAccountId);
    }
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
  market: string,
  botSubaccountPublicKey?: string
): Promise<{ synced: boolean; discrepancy: boolean; liquidation?: boolean }> {
  try {
    let fetchResult;
    if (botSubaccountPublicKey) {
      try {
        const positions = await getDefaultAdapter().getPositions(botSubaccountPublicKey);
        fetchResult = { positions: positions.map(p => ({
          marketIndex: 0,
          market: p.internalSymbol,
          baseAssetAmount: p.baseSize,
          side: (p.baseSize >= 0 ? 'LONG' : 'SHORT') as 'LONG' | 'SHORT',
          entryPrice: p.entryPrice,
          markPrice: p.markPrice,
          unrealizedPnl: p.unrealizedPnl,
          unrealizedPnlPercent: p.entryPrice > 0 && p.baseSize !== 0
            ? ((p.unrealizedPnl / (Math.abs(p.baseSize) * p.entryPrice)) * 100)
            : 0,
        })), fetchFailed: false };
      } catch (err) {
        console.log(`[Reconcile] Bot subaccount position fetch failed for ${botId}: ${err instanceof Error ? err.message : err}`);
        fetchResult = { positions: [], fetchFailed: true };
      }
    } else {
      fetchResult = await fetchPerpPositions(agentPublicKey, subAccountId);
    }
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
      const closeDetection = await detectOnChainClose(
        botId, agentPublicKey, market, dbPosition!, botSubaccountPublicKey
      );

      if (closeDetection.detected) {
        const dedupKey = closeDetection.protocolTradeId
          ? `reconcile-close-${closeDetection.protocolTradeId}`
          : `reconcile-close-${botId}-${market}-${Date.now()}`;

        const existingTrades = await storage.getBotTrades(botId, 5);
        const alreadyRecorded = closeDetection.protocolTradeId && existingTrades.some(t => {
          const payload = t.webhookPayload as Record<string, unknown> | null;
          return payload?.protocolTradeId === closeDetection.protocolTradeId;
        });

        if (alreadyRecorded) {
          console.log(`[Reconcile] Close already recorded for bot ${botId} ${market} (tradeId=${closeDetection.protocolTradeId}), skipping duplicate`);
          lastReconcileTime.set(botId, Date.now());
          return { synced: true, discrepancy: false };
        }

        console.log(`[Reconcile] Position closed on-chain for bot ${botId} ${market}: reason=${closeDetection.reason}, fill=$${closeDetection.fillPrice?.toFixed(4) ?? '?'}, pnl=$${closeDetection.pnl?.toFixed(4) ?? '?'}`);

        await storage.createBotTrade({
          tradingBotId: botId,
          walletAddress,
          market,
          side: dbBaseSize > 0 ? 'short' : 'long',
          size: String(Math.abs(dbBaseSize)),
          price: String(closeDetection.fillPrice ?? parseFloat(dbPosition!.avgEntryPrice)),
          fee: String(closeDetection.fee ?? 0),
          pnl: String(closeDetection.pnl ?? 0),
          status: closeDetection.reason === 'liquidation' ? 'liquidated' : 'executed',
          protocolFillId: dedupKey,
          webhookPayload: {
            reconciled: true,
            closeReason: closeDetection.reason,
            detectedAt: new Date().toISOString(),
            protocolTradeId: closeDetection.protocolTradeId,
          },
          executionMethod: 'on-chain-detected',
        });

        await storage.upsertBotPosition({
          tradingBotId: botId,
          walletAddress,
          market,
          baseSize: "0",
          avgEntryPrice: dbPosition!.avgEntryPrice,
          costBasis: "0",
          realizedPnl: String(parseFloat(dbPosition!.realizedPnl || "0") + (closeDetection.pnl ?? 0)),
          totalFees: String(parseFloat(dbPosition!.totalFees || "0") + (closeDetection.fee ?? 0)),
          lastTradeId: dbPosition!.lastTradeId,
          lastTradeAt: new Date(),
        });

        {
          const botForClear = await storage.getTradingBotById(botId);
          if (botForClear?.riskConfig) {
            const rc = botForClear.riskConfig as Record<string, unknown>;
            delete rc.takeProfitPercent;
            delete rc.stopLossPercent;
            delete rc.takeProfitPrice;
            delete rc.stopLossPrice;
            await storage.updateTradingBot(botId, { riskConfig: rc } as any);
          }
        }

        lastReconcileTime.set(botId, Date.now());
        return { synced: true, discrepancy: true, liquidation: closeDetection.reason === 'liquidation' };
      }

      console.log(`[Reconcile] On-chain empty but DB has ${dbBaseSize} ${market} — no closing trade found on-chain, preserving DB.`);
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
    const botSubPubKey = (bot.protocolSubaccountId && bot.subaccountStatus === 'active') ? bot.protocolSubaccountId : undefined;
    const result = await reconcileBotPosition(
      bot.id,
      walletAddress,
      wallet.agentPublicKey,
      subAccountId,
      bot.market,
      botSubPubKey
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
          const botSubPubKey = (bot.subaccountStatus === 'active' && bot.protocolSubaccountId)
            ? bot.protocolSubaccountId
            : undefined;
          await reconcileBotPosition(
            bot.id,
            walletAddress,
            wallet.agentPublicKey,
            subAccountId,
            bot.market,
            botSubPubKey
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
