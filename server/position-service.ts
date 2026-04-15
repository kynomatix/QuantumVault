import { storage } from './storage';
import { normalizeMarket } from './protocol/symbol-registry';
import { getMarketInfo } from './market-registry';
import { getDefaultAdapter } from './protocol/adapter-registry';

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
    console.log(`[PositionService] fetchPerpPositions failed: ${err instanceof Error ? err.message : err}`);
    return { positions: [], fetchFailed: true };
  }
}

async function fetchDriftAccountInfo(agentPublicKey: string, subaccountId: number): Promise<any> {
  try {
    const info = await getDefaultAdapter().getAccountInfo(agentPublicKey, _subIdStr(subaccountId));
    return {
      usdcBalance: info.balance,
      totalCollateral: info.equity,
      freeCollateral: info.availableMargin,
      marginUsed: info.maintenanceMargin,
      unrealizedPnl: info.unrealizedPnl,
    };
  } catch {
    return { usdcBalance: 0, unrealizedPnl: 0 };
  }
}

const DEFAULT_MARGIN_WEIGHT = 0.10;

function getMaintenanceMarginWeight(market: string): number {
  const normalized = normalizeMarket(market);
  const internalSymbol = normalized.includes('-PERP') ? normalized : `${normalized}-PERP`;
  const info = getMarketInfo(internalSymbol);
  if (info) return info.maintenanceMarginWeight;
  return DEFAULT_MARGIN_WEIGHT;
}

export interface OnChainPosition {
  market: string;
  side: 'LONG' | 'SHORT' | 'FLAT';
  baseAssetAmount: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
}

export interface PositionData {
  source: 'on-chain' | 'database' | 'none';
  timestamp: Date;
  staleWarning: boolean;
  driftDetected: boolean;
  position: {
    hasPosition: boolean;
    market: string;
    side: 'LONG' | 'SHORT' | 'FLAT';
    size: number;
    avgEntryPrice: number;
    currentPrice: number;
    unrealizedPnl: number;
    unrealizedPnlPercent: number;
    realizedPnl: number;
    totalFees: number;
  } | null;
  healthMetrics?: {
    healthFactor: number;
    liquidationPrice: number | null;
    totalCollateral: number;
    freeCollateral: number;
  };
  driftDetails?: {
    onChainSize: number;
    databaseSize: number;
    difference: number;
  };
}

export class PositionService {
  private static readonly STALE_THRESHOLD_MS = 30000;

  static async getPosition(
    botId: string,
    walletAddress: string,
    agentPublicKey: string,
    subAccountId: number,
    market: string,
    agentPrivateKeyEncrypted?: string
  ): Promise<PositionData> {
    const timestamp = new Date();
    let onChainPos: OnChainPosition | null = null;
    let driftDetected = false;
    let driftDetails: PositionData['driftDetails'] = undefined;

    try {
      console.log(`[PositionService] Using byte-parsing position fetching for ${market}`);
      const fetchResult = await fetchPerpPositions(agentPublicKey, subAccountId);
      const normalizedMarket = normalizeMarket(market);
      onChainPos = fetchResult.positions.find(p => 
        normalizeMarket(p.market) === normalizedMarket
      ) || null;

      const dbPosition = await storage.getBotPosition(botId, market);
      const dbSize = dbPosition ? parseFloat(dbPosition.baseSize) : 0;
      const onChainSize = onChainPos?.baseAssetAmount || 0;

      if (!fetchResult.fetchFailed && Math.abs(dbSize - onChainSize) > 0.0001) {
        driftDetected = true;
        driftDetails = {
          onChainSize,
          databaseSize: dbSize,
          difference: onChainSize - dbSize,
        };
        console.warn(`[PositionService] DRIFT DETECTED for bot ${botId} ${market}: DB=${dbSize}, OnChain=${onChainSize}, diff=${driftDetails.difference}`);

        if (onChainPos !== null && Math.abs(onChainSize) > 0.0001) {
          await storage.upsertBotPosition({
            tradingBotId: botId,
            walletAddress,
            market,
            baseSize: String(onChainSize),
            avgEntryPrice: String(onChainPos.entryPrice),
            costBasis: String(Math.abs(onChainSize) * onChainPos.entryPrice),
            realizedPnl: dbPosition?.realizedPnl || "0",
            totalFees: dbPosition?.totalFees || "0",
            lastTradeId: dbPosition?.lastTradeId || null,
            lastTradeAt: new Date(),
          });
          console.log(`[PositionService] Auto-corrected database from on-chain data`);
        } else if (dbSize !== 0 && onChainSize === 0) {
          console.log(`[PositionService] On-chain empty but DB has position (${dbSize} ${market}) — preserving DB as source of truth`);
        }
      } else if (fetchResult.fetchFailed && Math.abs(dbSize) > 0.0001) {
        console.log(`[PositionService] Position fetch failed — preserving DB position (${dbSize} ${market})`);
      }

      const hasPosition = (onChainPos && Math.abs(onChainSize) > 0.0001) || Math.abs(dbSize) > 0.0001;
      const realizedPnl = dbPosition ? parseFloat(dbPosition.realizedPnl) : 0;
      const totalFees = dbPosition ? parseFloat(dbPosition.totalFees || "0") : 0;

      // Use byte-parsing for health metrics - NO SDK to avoid memory leaks
      // getDriftAccountInfo now includes unrealized PnL and margin calculations
      let healthMetrics: PositionData['healthMetrics'] = undefined;
      if (hasPosition) {
        try {
          const accountInfo = await fetchDriftAccountInfo(agentPublicKey, subAccountId);
          
          // Health Factor = (freeCollateral / totalCollateral) * 100
          // This matches Drift's approach: 100% when fully free, lower as margin is used
          let healthFactor = 100;
          if (accountInfo.totalCollateral > 0) {
            healthFactor = Math.max(0, Math.min(100, (accountInfo.freeCollateral / accountInfo.totalCollateral) * 100));
          } else if (accountInfo.totalCollateral <= 0 && hasPosition) {
            healthFactor = 0; // Negative collateral = critical
          }
          
          // Estimate liquidation price with maintenance margin weight
          // Liquidation occurs when freeCollateral is consumed by price movement
          // The maintenance margin weight affects how quickly margin is consumed:
          // - Higher weight (e.g., 15% for memecoins) = liquidation at less adverse price
          // - Lower weight (e.g., 5% for BTC) = can withstand larger price moves
          // 
          // Formula incorporates maintenance margin:
          // priceBuffer = freeCollateral / (|size| * (1 + maintenanceWeight))
          // This gives a more conservative (safer) liquidation price estimate
          let liquidationPrice: number | null = null;
          const posSize = (onChainPos && Math.abs(onChainSize) > 0.0001) ? onChainSize : dbSize;
          const posMarket = onChainPos?.market || dbPosition?.market || market;
          const posSide = (onChainPos && Math.abs(onChainSize) > 0.0001) ? onChainPos.side : (dbSize > 0 ? 'LONG' : 'SHORT');
          const posMarkPrice = (onChainPos && Math.abs(onChainSize) > 0.0001) ? onChainPos.markPrice : (dbPosition ? parseFloat(dbPosition.avgEntryPrice) : 0);

          if (Math.abs(posSize) > 0.0001 && posMarkPrice > 0) {
            if (accountInfo.freeCollateral <= 0) {
              liquidationPrice = posMarkPrice;
            } else {
              const maintenanceWeight = getMaintenanceMarginWeight(posMarket);
              const adjustedSize = Math.abs(posSize) * (1 + maintenanceWeight);
              const priceBuffer = accountInfo.freeCollateral / adjustedSize;
              
              if (posSide === 'LONG') {
                liquidationPrice = Math.max(0, posMarkPrice - priceBuffer);
              } else {
                liquidationPrice = posMarkPrice + priceBuffer;
              }
              
              console.log(`[PositionService] Liquidation price calc: market=${posMarket}, maintenanceWeight=${(maintenanceWeight * 100).toFixed(2)}%, markPrice=${posMarkPrice.toFixed(2)}, freeCollateral=${accountInfo.freeCollateral.toFixed(2)}, priceBuffer=${priceBuffer.toFixed(2)}, liqPrice=${liquidationPrice?.toFixed(2)}`);
            }
          }
          
          healthMetrics = {
            healthFactor,
            liquidationPrice,
            totalCollateral: accountInfo.totalCollateral,
            freeCollateral: accountInfo.freeCollateral,
          };
        } catch (healthErr) {
          console.error(`[PositionService] Failed to get health metrics:`, healthErr);
        }
      }

      let positionResult: PositionData['position'] = null;
      if (onChainPos && Math.abs(onChainSize) > 0.0001) {
        positionResult = {
          hasPosition: true,
          market: onChainPos.market,
          side: onChainPos.side,
          size: Math.abs(onChainSize),
          avgEntryPrice: onChainPos.entryPrice,
          currentPrice: onChainPos.markPrice,
          unrealizedPnl: onChainPos.unrealizedPnl,
          unrealizedPnlPercent: onChainPos.unrealizedPnlPercent,
          realizedPnl,
          totalFees,
        };
      } else if (dbPosition && Math.abs(dbSize) > 0.0001) {
        const entryPrice = parseFloat(dbPosition.avgEntryPrice);
        positionResult = {
          hasPosition: true,
          market: dbPosition.market,
          side: dbSize > 0 ? 'LONG' : 'SHORT',
          size: Math.abs(dbSize),
          avgEntryPrice: entryPrice,
          currentPrice: entryPrice,
          unrealizedPnl: 0,
          unrealizedPnlPercent: 0,
          realizedPnl,
          totalFees,
        };
      }

      return {
        source: onChainPos ? 'on-chain' : 'database',
        timestamp,
        staleWarning: false,
        driftDetected,
        position: positionResult,
        healthMetrics,
        driftDetails,
      };

    } catch (onChainError) {
      console.error(`[PositionService] On-chain query failed, falling back to database:`, onChainError);

      const dbPosition = await storage.getBotPosition(botId, market);
      if (!dbPosition) {
        return {
          source: 'none',
          timestamp,
          staleWarning: true,
          driftDetected: false,
          position: null,
        };
      }

      const baseSize = parseFloat(dbPosition.baseSize);
      const hasPosition = Math.abs(baseSize) > 0.0001;
      const lastTradeAt = dbPosition.lastTradeAt ? new Date(dbPosition.lastTradeAt) : new Date(0);
      const isStale = (Date.now() - lastTradeAt.getTime()) > this.STALE_THRESHOLD_MS;

      const fallbackEntryPrice = parseFloat(dbPosition.avgEntryPrice);
      return {
        source: 'database',
        timestamp,
        staleWarning: isStale,
        driftDetected: false,
        position: hasPosition ? {
          hasPosition: true,
          market: dbPosition.market,
          side: baseSize > 0 ? 'LONG' : 'SHORT',
          size: Math.abs(baseSize),
          avgEntryPrice: fallbackEntryPrice,
          currentPrice: fallbackEntryPrice,
          unrealizedPnl: 0,
          unrealizedPnlPercent: 0,
          realizedPnl: parseFloat(dbPosition.realizedPnl),
          totalFees: parseFloat(dbPosition.totalFees || "0"),
        } : null,
      };
    }
  }

  static async getPositionForExecution(
    botId: string,
    agentPublicKey: string,
    subAccountId: number,
    market: string,
    agentPrivateKeyEncrypted?: string
  ): Promise<{ 
    size: number; 
    side: 'LONG' | 'SHORT' | 'FLAT'; 
    source: 'on-chain';
    entryPrice: number;
  }> {
    // ALWAYS use byte-parsing for position reading - it's lightweight and doesn't create WebSocket connections
    // The SDK approach causes memory leaks due to WebSocket connections that don't cleanup
    console.log(`[PositionService] getPositionForExecution: Using byte-parsing for ${market} (subaccount ${subAccountId})`);
    const fetchResult = await fetchPerpPositions(agentPublicKey, subAccountId);
    
    const normalizedMarket = normalizeMarket(market);
    const onChainPos = fetchResult.positions.find((p: any) => 
      normalizeMarket(p.market) === normalizedMarket
    );

    const size = onChainPos?.baseAssetAmount || 0;
    const side: 'LONG' | 'SHORT' | 'FLAT' = 
      Math.abs(size) < 0.0001 ? 'FLAT' : 
      size > 0 ? 'LONG' : 'SHORT';

    console.log(`[PositionService] getPositionForExecution result: ${market} size=${size}, side=${side}`);
    
    return {
      size,
      side,
      source: 'on-chain',
      entryPrice: onChainPos?.entryPrice || 0,
    };
  }

  static async getAllPositionsForWallet(
    walletAddress: string,
    agentPublicKey: string,
    agentPrivateKeyEncrypted?: string
  ): Promise<{
    positions: Array<{
      botId: string;
      botName: string;
      market: string;
      subAccountId: number;
      position: PositionData['position'];
      source: 'on-chain' | 'database' | 'none';
      driftDetected: boolean;
    }>;
    totalDriftDetected: number;
  }> {
    const bots = await storage.getTradingBots(walletAddress);
    const positions: Array<{
      botId: string;
      botName: string;
      market: string;
      subAccountId: number;
      position: PositionData['position'];
      source: 'on-chain' | 'database' | 'none';
      driftDetected: boolean;
    }> = [];
    let totalDriftDetected = 0;

    for (const bot of bots) {
      const subAccountId = bot.driftSubaccountId ?? 0;
      try {
        const posData = await this.getPosition(
          bot.id,
          walletAddress,
          agentPublicKey,
          subAccountId,
          bot.market,
          agentPrivateKeyEncrypted
        );

        if (posData.driftDetected) {
          totalDriftDetected++;
        }

        if (posData.position?.hasPosition) {
          positions.push({
            botId: bot.id,
            botName: bot.name,
            market: bot.market,
            subAccountId,
            position: posData.position,
            source: posData.source,
            driftDetected: posData.driftDetected,
          });
        }
      } catch (err) {
        console.error(`[PositionService] Failed to get position for bot ${bot.id}:`, err);
      }
    }

    return { positions, totalDriftDetected };
  }

  static async reconcileAllPositions(
    walletAddress: string,
    agentPublicKey: string
  ): Promise<{
    checked: number;
    corrected: number;
    details: Array<{
      botId: string;
      market: string;
      wasCorrect: boolean;
      dbSize: number;
      onChainSize: number;
    }>;
  }> {
    const bots = await storage.getTradingBots(walletAddress);
    let checked = 0;
    let corrected = 0;
    const details: Array<{
      botId: string;
      market: string;
      wasCorrect: boolean;
      dbSize: number;
      onChainSize: number;
    }> = [];

    for (const bot of bots) {
      const subAccountId = bot.driftSubaccountId ?? 0;
      checked++;

      try {
        const onChainPositions = await fetchPerpPositions(agentPublicKey, subAccountId);
        const normalizedMarket = normalizeMarket(bot.market);
        const onChainPos = onChainPositions.find(p => 
          normalizeMarket(p.market) === normalizedMarket
        );

        const dbPosition = await storage.getBotPosition(bot.id, bot.market);
        const dbSize = dbPosition ? parseFloat(dbPosition.baseSize) : 0;
        const onChainSize = onChainPos?.baseAssetAmount || 0;

        const wasCorrect = Math.abs(dbSize - onChainSize) < 0.0001;

        if (!wasCorrect) {
          corrected++;
          await storage.upsertBotPosition({
            tradingBotId: bot.id,
            walletAddress,
            market: bot.market,
            baseSize: String(onChainSize),
            avgEntryPrice: onChainPos ? String(onChainPos.entryPrice) : "0",
            costBasis: onChainPos ? String(Math.abs(onChainSize) * onChainPos.entryPrice) : "0",
            realizedPnl: dbPosition?.realizedPnl || "0",
            totalFees: dbPosition?.totalFees || "0",
            lastTradeId: dbPosition?.lastTradeId || null,
            lastTradeAt: new Date(),
          });
          console.log(`[PositionService] Corrected bot ${bot.id} ${bot.market}: ${dbSize} -> ${onChainSize}`);
        }

        details.push({
          botId: bot.id,
          market: bot.market,
          wasCorrect,
          dbSize,
          onChainSize,
        });
      } catch (err) {
        console.error(`[PositionService] Failed to reconcile bot ${bot.id}:`, err);
      }
    }

    return { checked, corrected, details };
  }
}
