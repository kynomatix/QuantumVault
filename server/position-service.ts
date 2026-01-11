import { storage } from './storage';
import { getPerpPositions, getDriftAccountInfo } from './drift-service';

// Drift maintenance margin weights by market (in decimal, e.g., 0.0625 = 6.25%)
// These affect when liquidation occurs - higher weight = liquidation at less adverse price
// Values sourced from Drift Protocol's perp market configs
const MAINTENANCE_MARGIN_WEIGHTS: Record<string, number> = {
  'SOL': 0.0625,      // 6.25% for SOL-PERP
  'BTC': 0.05,        // 5% for BTC-PERP
  'ETH': 0.05,        // 5% for ETH-PERP
  'APT': 0.10,        // 10% for smaller caps
  'MATIC': 0.10,
  'DOGE': 0.10,
  'BNB': 0.0625,
  'SUI': 0.10,
  'PEPE': 0.15,       // 15% for memecoins
  'ARB': 0.10,
  'PYTH': 0.10,
  'WIF': 0.15,
  'JUP': 0.10,
  'JTO': 0.10,
  'INJ': 0.10,
  'SEI': 0.10,
  'TIA': 0.10,
  'LINK': 0.0625,
  'AVAX': 0.0625,
  'POPCAT': 0.15,
  'ONDO': 0.10,
  'TRUMP': 0.15,
};

function getMaintenanceMarginWeight(market: string): number {
  const normalized = market.toUpperCase()
    .replace(/-PERP$/i, '')
    .replace(/PERP$/i, '')
    .replace(/USD[CT]?$/i, '')
    .replace(/[-_/]/g, '');
  return MAINTENANCE_MARGIN_WEIGHTS[normalized] ?? 0.10; // Default 10% if unknown
}

function normalizeMarket(market: string): string {
  return market.toUpperCase()
    .replace(/-PERP$/i, '')
    .replace(/PERP$/i, '')
    .replace(/USD[CT]?$/i, '')
    .replace(/[-_/]/g, '');
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
      // ALWAYS use byte-parsing for position reading to avoid SDK WebSocket memory leaks
      // The SDK creates WebSocket connections that don't properly cleanup
      console.log(`[PositionService] Using byte-parsing position fetching for ${market}`);
      const onChainPositions = await getPerpPositions(agentPublicKey, subAccountId);
      const normalizedMarket = normalizeMarket(market);
      onChainPos = onChainPositions.find(p => 
        normalizeMarket(p.market) === normalizedMarket
      ) || null;

      const dbPosition = await storage.getBotPosition(botId, market);
      const dbSize = dbPosition ? parseFloat(dbPosition.baseSize) : 0;
      const onChainSize = onChainPos?.baseAssetAmount || 0;

      if (Math.abs(dbSize - onChainSize) > 0.0001) {
        driftDetected = true;
        driftDetails = {
          onChainSize,
          databaseSize: dbSize,
          difference: onChainSize - dbSize,
        };
        console.warn(`[PositionService] DRIFT DETECTED for bot ${botId} ${market}: DB=${dbSize}, OnChain=${onChainSize}, diff=${driftDetails.difference}`);

        // SAFETY: Only auto-correct if we have a valid on-chain position OR the DB shows a position
        // that doesn't exist on-chain. Never auto-correct to 0 if DB has no position (could be wrong wallet).
        const shouldAutoCorrect = onChainPos !== null || (dbSize !== 0 && onChainSize === 0);
        
        if (shouldAutoCorrect) {
          await storage.upsertBotPosition({
            tradingBotId: botId,
            walletAddress,
            market,
            baseSize: String(onChainSize),
            avgEntryPrice: onChainPos ? String(onChainPos.entryPrice) : "0",
            costBasis: onChainPos ? String(Math.abs(onChainSize) * onChainPos.entryPrice) : "0",
            realizedPnl: dbPosition?.realizedPnl || "0",
            totalFees: dbPosition?.totalFees || "0",
            lastTradeId: dbPosition?.lastTradeId || null,
            lastTradeAt: new Date(),
          });
          console.log(`[PositionService] Auto-corrected database from on-chain data`);
        } else {
          console.warn(`[PositionService] Skipping auto-correction: on-chain empty and DB empty - possible wallet mismatch`);
        }
      }

      const hasPosition = Math.abs(onChainSize) > 0.0001;
      const realizedPnl = dbPosition ? parseFloat(dbPosition.realizedPnl) : 0;
      const totalFees = dbPosition ? parseFloat(dbPosition.totalFees || "0") : 0;

      // Use byte-parsing for health metrics - NO SDK to avoid memory leaks
      // getDriftAccountInfo now includes unrealized PnL and margin calculations
      let healthMetrics: PositionData['healthMetrics'] = undefined;
      if (hasPosition) {
        try {
          const accountInfo = await getDriftAccountInfo(agentPublicKey, subAccountId);
          
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
          if (onChainPos && Math.abs(onChainSize) > 0.0001) {
            if (accountInfo.freeCollateral <= 0) {
              // Already at or past liquidation threshold
              liquidationPrice = onChainPos.markPrice;
            } else {
              // Get market-specific maintenance margin weight
              const maintenanceWeight = getMaintenanceMarginWeight(onChainPos.market);
              
              // Adjusted formula: divide by (1 + maintenanceWeight) to account for
              // the additional margin required as position value changes
              const adjustedSize = Math.abs(onChainSize) * (1 + maintenanceWeight);
              const priceBuffer = accountInfo.freeCollateral / adjustedSize;
              
              if (onChainPos.side === 'LONG') {
                liquidationPrice = Math.max(0, onChainPos.markPrice - priceBuffer);
              } else {
                liquidationPrice = onChainPos.markPrice + priceBuffer;
              }
              
              console.log(`[PositionService] Liquidation price calc: market=${onChainPos.market}, maintenanceWeight=${(maintenanceWeight * 100).toFixed(2)}%, markPrice=${onChainPos.markPrice.toFixed(2)}, freeCollateral=${accountInfo.freeCollateral.toFixed(2)}, priceBuffer=${priceBuffer.toFixed(2)}, liqPrice=${liquidationPrice?.toFixed(2)}`);
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

      return {
        source: 'on-chain',
        timestamp,
        staleWarning: false,
        driftDetected,
        position: hasPosition ? {
          hasPosition: true,
          market: onChainPos!.market,
          side: onChainPos!.side,
          size: Math.abs(onChainSize),
          avgEntryPrice: onChainPos!.entryPrice,
          currentPrice: onChainPos!.markPrice,
          unrealizedPnl: onChainPos!.unrealizedPnl,
          unrealizedPnlPercent: onChainPos!.unrealizedPnlPercent,
          realizedPnl,
          totalFees,
        } : null,
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
          avgEntryPrice: parseFloat(dbPosition.avgEntryPrice),
          currentPrice: 0,
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
    const onChainPositions = await getPerpPositions(agentPublicKey, subAccountId);
    
    const normalizedMarket = normalizeMarket(market);
    const onChainPos = onChainPositions.find(p => 
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
        const onChainPositions = await getPerpPositions(agentPublicKey, subAccountId);
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
