import { storage, DatabaseStorage } from "./storage";
import { normalizeMarket } from "./protocol/symbol-registry";
import { getDefaultAdapter, getAdapterForBot } from "./protocol/adapter-registry";
import type { TradeRecord } from "./protocol/protocol-types";
import type { ProtocolAdapter } from "./protocol/adapter";
import { sendTradeNotification, getCloseReasonLabel, schedulePartialCloseNotification } from "./notification-service";

function _subIdStr(subAccountId: number): string | undefined {
  return subAccountId > 0 ? String(subAccountId) : undefined;
}

async function fetchPerpPositions(agentPublicKey: string, subaccountId: number, adapter: ProtocolAdapter = getDefaultAdapter()): Promise<{ positions: any[]; fetchFailed: boolean }> {
  try {
    const positions = await adapter.getPositions(agentPublicKey, _subIdStr(subaccountId));
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

async function fetchMarketPrice(market: string, adapter: ProtocolAdapter = getDefaultAdapter()): Promise<number | null> {
  try {
    return await adapter.getPrice(market);
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
  /** First matched protocol fill ID (single canonical identifier — NOT a
   * joined string). Used as the canonical close-event signature input
   * for cross-path dedup with webhook/retry writers. */
  protocolFillId?: string;
  /** Comma-joined matched fill IDs, for diagnostics ONLY. Never use as
   * a dedup key — joined strings are not stable identifiers. */
  matchedFillIdsForDiagnostics?: string;
  /** Timestamp of the matched closing fill, used for the deterministic
   * nosig fallback hash so repeated reconciler runs against the same
   * close hit the same time bucket. */
  fillTimestampMs?: number;
  /** When `reason === 'tpsl'`, which side was hit (used for notification text). */
  tpslSubtype?: 'TP' | 'SL';
}

async function detectOnChainClose(
  botId: string,
  agentPublicKey: string,
  market: string,
  dbPosition: { baseSize: string; avgEntryPrice: string; realizedPnl?: string; totalFees?: string; lastTradeId?: string | null; lastTradeAt?: Date | null },
  botSubaccountPublicKey?: string,
  adapter: ProtocolAdapter = getDefaultAdapter(),
): Promise<CloseDetectionResult> {
  const noDetection: CloseDetectionResult = { detected: false, reason: 'external_close' };

  try {
    const normalizedMarket = normalizeMarket(market);
    const dbBaseSize = parseFloat(dbPosition.baseSize);
    const entryPrice = parseFloat(dbPosition.avgEntryPrice);
    const positionSide = dbBaseSize > 0 ? 'long' : 'short';
    const closeSide = positionSide === 'long' ? 'short' : 'long';
    const absSize = Math.abs(dbBaseSize);

    // For Pacifica external_key bots (where each bot has its own subaccount key),
    // the funded "account" on Pacifica IS the bot subaccount key itself — the
    // agent key is just a delegated signer with $0 balance. Querying with the
    // agent key returns 200 with zeros and falsely trips the liquidation
    // classifier. For Drift (no botSubaccountPublicKey) we keep the original
    // agent+subaccountId behavior unchanged.
    const readAccount = botSubaccountPublicKey || agentPublicKey;
    const readSubaccountId = botSubaccountPublicKey ? undefined : undefined; // Pacifica direct-sub mode doesn't need subaccount_id; Drift path also passes undefined here for /account-style reads

    let tradeHistoryFetchFailed = false;
    const fetchClosingFills = async (windowMs: number): Promise<TradeRecord[]> => {
      try {
        const startTime = Date.now() - windowMs;
        const trades = await adapter.getTradeHistory(readAccount, {
          limit: 200,
          startTime,
          ...(readSubaccountId ? { subaccountId: readSubaccountId } : {}),
        });
        return trades
          .filter(t =>
            normalizeMarket(t.internalSymbol) === normalizedMarket &&
            t.side === closeSide
          )
          .sort((a, b) => b.timestamp - a.timestamp);
      } catch (err) {
        tradeHistoryFetchFailed = true;
        console.log(`[Reconcile] Trade history fetch failed for ${botId} (window=${windowMs}ms): ${err instanceof Error ? err.message : err}`);
        return [];
      }
    };

    const sumFillSize = (fills: TradeRecord[]) => fills.reduce((s, f) => s + f.size, 0);

    let closingFills = await fetchClosingFills(5 * 60 * 1000);
    if (sumFillSize(closingFills) < absSize * 0.80) {
      console.log(`[Reconcile] Closing fills in 5min window insufficient for bot ${botId} (got ${sumFillSize(closingFills).toFixed(6)} of ${absSize.toFixed(6)}), retrying with 60min window`);
      const widerFills = await fetchClosingFills(60 * 60 * 1000);
      if (sumFillSize(widerFills) > sumFillSize(closingFills)) {
        closingFills = widerFills;
      }
    }
    // Final fallback: 24h window. Catches closes that happened well before the
    // reconciler ran (e.g. when bot was offline, or our previous tick was
    // blocked by a bug). Without this, we'd fall through to the market-price
    // estimate in the account-info path and record an incorrect fill price.
    if (sumFillSize(closingFills) < absSize * 0.80) {
      console.log(`[Reconcile] Closing fills in 60min window still insufficient for bot ${botId}, retrying with 24h window`);
      const widestFills = await fetchClosingFills(24 * 60 * 60 * 1000);
      if (sumFillSize(widestFills) > sumFillSize(closingFills)) {
        closingFills = widestFills;
      }
    }

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
    let tpslSubtype: 'TP' | 'SL' | undefined;

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
          tpslSubtype = hitTp ? 'TP' : 'SL';
          console.log(`[Reconcile] TP/SL detected for bot ${botId}: ${hitTp ? 'TP' : 'SL'} hit at $${avgFillPrice.toFixed(4)} (entry=$${entryPrice.toFixed(4)}, TP=$${tpPrice.toFixed(4)}, SL=$${slPrice.toFixed(4)})`);
        }
      }

      const pnl = positionSide === 'long'
        ? (avgFillPrice - entryPrice) * absSize
        : (entryPrice - avgFillPrice) * absSize;

      if (closeReason === 'external_close') {
        try {
          const accountInfo = await adapter.getAccountInfo(readAccount, readSubaccountId);
          if (accountInfo.exists !== false && accountInfo.equity < 1 && accountInfo.balance < 1) {
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
        // Canonical: FIRST matched protocol fill ID is a single stable
        // identifier suitable as the cross-path dedup key. Joined IDs
        // are diagnostic-only.
        protocolFillId: matchedTradeIds[0],
        matchedFillIdsForDiagnostics: matchedTradeIds.join(','),
        fillTimestampMs: closingFills[0]?.timestamp,
        tpslSubtype,
      };
    }

    // No closing fills found via trade history (either the API returned 404
    // for this account, or the fills didn't match). Fall through to the
    // account-info check, which can still detect the close via balance/equity.
    // NOTE: A Pacifica /account/trades 404 is itself meaningful signal —
    // it often means the account was stopped out and has no open trades.
    // Refusing to fall through here (the old CRITICAL GUARD) caused the
    // periodic reconciler to permanently stall on stopped-out positions.
    if (tradeHistoryFetchFailed && botSubaccountPublicKey) {
      console.log(`[Reconcile] Trade history unavailable for Pacifica bot ${botId} ${market} — falling through to account-info check`);
    }

    // No closing fills found. Before falling back to account-info estimation,
    // check position age. If the position was opened within the last 3 minutes,
    // the adapter's positions API may still be propagating (observed: Pacifica
    // shows 0 size for ~10s after an entry fills). Estimating a close price in
    // that window produces phantom trades. Return noDetection and let the next
    // reconcile tick (60s) retry — by then propagation lag has resolved.
    //
    // The 3-minute threshold gives an 18× safety margin over the worst observed
    // Pacifica lag (~10s) while being short enough that real closes (TP/SL,
    // manual) still get estimated fill prices within a couple of reconcile ticks.
    //
    // Liquidation is exempt: equity+balance both near zero is unambiguous signal
    // regardless of position age.
    const positionAgeMs = dbPosition.lastTradeAt
      ? Date.now() - new Date(dbPosition.lastTradeAt).getTime()
      : Infinity;
    const MIN_AGE_FOR_ESTIMATION_MS = 3 * 60 * 1000; // 3 minutes

    try {
      const accountInfo = await adapter.getAccountInfo(readAccount, readSubaccountId);

      if (accountInfo.exists === false) {
        console.log(`[Reconcile] Account info unavailable for bot ${botId} ${market} (exists=false) — preserving DB position`);
        return noDetection;
      }

      // Stable timestamp anchor for the canonical close ID across reconciler ticks.
      const fallbackAnchorMs = dbPosition.lastTradeAt
        ? new Date(dbPosition.lastTradeAt).getTime()
        : undefined;

      if (accountInfo.equity < 1 && accountInfo.balance < 1) {
        console.log(`[Reconcile] Likely liquidation for bot ${botId} (no closing trades): equity=$${accountInfo.equity.toFixed(2)}, balance=$${accountInfo.balance.toFixed(2)}`);
        return {
          detected: true,
          reason: 'liquidation',
          fillPrice: entryPrice,
          pnl: 0,
          fee: 0,
          fillTimestampMs: fallbackAnchorMs,
        };
      }

      if (positionAgeMs < MIN_AGE_FOR_ESTIMATION_MS) {
        console.log(`[Reconcile] No closing fills for bot ${botId} ${market} but position is only ${(positionAgeMs / 1000).toFixed(0)}s old — treating as propagation lag, preserving DB position`);
        return noDetection;
      }

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

      const hasTpSlConfig = tpPrice > 0 || slPrice > 0;

      const computePnl = (fillPrice: number): number => positionSide === 'long'
        ? (fillPrice - entryPrice) * absSize
        : (entryPrice - fillPrice) * absSize;

      if (hasTpSlConfig) {
        const marketPrice = await fetchMarketPrice(market, adapter);

        let estimatedFillPrice: number;
        let chosenLabel: string;

        if (tpPrice > 0 && slPrice > 0 && marketPrice && marketPrice > 0) {
          const distToTp = Math.abs(marketPrice - tpPrice);
          const distToSl = Math.abs(marketPrice - slPrice);
          if (distToTp <= distToSl) {
            estimatedFillPrice = tpPrice;
            chosenLabel = 'TP';
          } else {
            estimatedFillPrice = slPrice;
            chosenLabel = 'SL';
          }
        } else if (tpPrice > 0) {
          estimatedFillPrice = tpPrice;
          chosenLabel = 'TP';
        } else {
          estimatedFillPrice = slPrice;
          chosenLabel = 'SL';
        }

        const pnl = computePnl(estimatedFillPrice);
        console.log(`[Reconcile] Position closed for bot ${botId} with TP/SL configured (no trade history, age=${(positionAgeMs / 1000).toFixed(0)}s, balance=$${accountInfo.balance.toFixed(2)}): classified as tpsl, estimated ${chosenLabel} fill=$${estimatedFillPrice.toFixed(4)}, pnl=$${pnl.toFixed(4)}`);
        return {
          detected: true,
          reason: 'tpsl',
          fillPrice: estimatedFillPrice,
          pnl,
          fee: 0,
          fillTimestampMs: fallbackAnchorMs,
          tpslSubtype: chosenLabel as 'TP' | 'SL',
        };
      }

      if (accountInfo.balance > 1 || accountInfo.equity > 1) {
        const marketPrice = await fetchMarketPrice(market, adapter);
        const fillPrice = marketPrice && marketPrice > 0 ? marketPrice : entryPrice;
        const pnl = marketPrice && marketPrice > 0 ? computePnl(marketPrice) : 0;
        console.log(`[Reconcile] Position closed for bot ${botId} (no trade history, age=${(positionAgeMs / 1000).toFixed(0)}s, balance=$${accountInfo.balance.toFixed(2)}): classified as external_close, estimated fill=$${fillPrice.toFixed(4)} (${marketPrice ? 'market' : 'entry-fallback'}), pnl=$${pnl.toFixed(4)}`);
        return {
          detected: true,
          reason: 'external_close',
          fillPrice,
          pnl,
          fee: 0,
          fillTimestampMs: fallbackAnchorMs,
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
    
    const botRowForAdapter = await storage.getTradingBotById(botId);
    if (!botRowForAdapter) {
      throw new Error(`Reconciliation: bot ${botId} not found — cannot resolve protocol adapter (fail-closed)`);
    }
    const adapter = getAdapterForBot(botRowForAdapter);
    const fetchOnce = async () => {
      if (botSubaccountPublicKey) {
        try {
          const positions = await adapter.getPositions(botSubaccountPublicKey);
          return { positions: positions.map(p => ({
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
          return { positions: [], fetchFailed: true };
        }
      } else {
        return await fetchPerpPositions(agentPublicKey, subAccountId, adapter);
      }
    };

    let fetchResult = await fetchOnce();
    const normalizedMarket = normalizeMarket(market);
    let onChainPos = fetchResult.positions.find(p => normalizeMarket(p.market) === normalizedMarket);

    const dbPosition = await storage.getBotPosition(botId, market);
    const existingRealizedPnl = dbPosition ? parseFloat(dbPosition.realizedPnl) : 0;
    const existingFees = dbPosition ? parseFloat(dbPosition.totalFees) : 0;
    const previousBaseSize = dbPosition ? parseFloat(dbPosition.baseSize) : 0;
    const previousAvgEntry = dbPosition ? parseFloat(dbPosition.avgEntryPrice) : 0;

    // STALE-READ GUARD: After a close/reduce trade, the protocol's positions
    // endpoint may still return the pre-close position for a brief window
    // (Pacifica in particular has propagation lag of a few seconds). If we
    // overwrite the DB with that stale read, the next reconcile tick will see
    // DB=full-size, on-chain=empty, and wrongly classify it as a liquidation.
    // So: when the trade is reducing AND on-chain still mirrors the pre-trade
    // size+side, retry the fetch a few times. If it still mirrors, skip the
    // overwrite and let the trade-data fallback path compute the new state.
    const normalizedTradeSide = tradeSide.toLowerCase();
    const isReducingTrade = tradeSize > 0 && Math.abs(previousBaseSize) > 0.0001 && (
      (previousBaseSize > 0 && normalizedTradeSide === 'short') ||
      (previousBaseSize < 0 && normalizedTradeSide === 'long')
    );
    const stillMirrorsPrev = (pos: typeof onChainPos) => {
      if (!pos) return false;
      const sameSign = (previousBaseSize > 0 && pos.baseAssetAmount > 0) ||
                       (previousBaseSize < 0 && pos.baseAssetAmount < 0);
      const sizeRatio = Math.abs(pos.baseAssetAmount) / Math.abs(previousBaseSize);
      return sameSign && sizeRatio >= 0.95;
    };
    if (isReducingTrade && stillMirrorsPrev(onChainPos)) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        await new Promise(r => setTimeout(r, 1500));
        const retry = await fetchOnce();
        const retryPos = retry.positions.find(p => normalizeMarket(p.market) === normalizedMarket);
        console.log(`[Sync] Stale-read guard attempt ${attempt}: on-chain size=${retryPos?.baseAssetAmount?.toFixed(4) ?? '0'} (previous=${previousBaseSize.toFixed(4)})`);
        if (!stillMirrorsPrev(retryPos)) {
          fetchResult = retry;
          onChainPos = retryPos;
          break;
        }
      }
      if (stillMirrorsPrev(onChainPos)) {
        console.log(`[Sync] On-chain still mirrors pre-close state after retries — skipping overwrite to prevent stale write. Falling back to trade-data computation.`);
        fetchResult = { positions: [], fetchFailed: true };
        onChainPos = undefined;
      }
    }
    
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


/**
 * Book realized PnL for a slice of a position that was partially closed
 * on-chain without going through the webhook path (e.g. manual partial TP
 * on the exchange, or an external order manager).
 *
 * Uses the existing `recordCloseEventAtomic` idempotency model:
 * - Key: `partial-<botId>-<market>-<fillId>` (or a deterministic nosig hash)
 * - Safe to re-run: second call hits the unique index and returns isNew=false
 * - The webhook path uses `tx-<sig>` keys so the two paths never collide
 */
async function bookPartialReduction(opts: {
  botId: string;
  walletAddress: string;
  market: string;
  agentPublicKey: string;
  botSubaccountPublicKey?: string;
  dbBaseSize: number;
  dbPosition: { avgEntryPrice: string; realizedPnl: string; totalFees: string; lastTradeAt?: Date | null };
  closedSlice: number;
  onChainBaseSize: number;
  adapter: ProtocolAdapter;
}): Promise<void> {
  const {
    botId, walletAddress, market, agentPublicKey, botSubaccountPublicKey,
    dbBaseSize, dbPosition, closedSlice, adapter,
  } = opts;

  const positionSide = dbBaseSize > 0 ? 'long' : 'short';
  const closeSide = positionSide === 'long' ? 'short' : 'long';
  const entryPrice = parseFloat(dbPosition.avgEntryPrice);
  const normalizedMarket = normalizeMarket(market);
  const readAccount = botSubaccountPublicKey || agentPublicKey;

  // Fetch recent closing fills to price the slice.
  let closingFills: TradeRecord[] = [];
  for (const windowMs of [5 * 60 * 1000, 60 * 60 * 1000]) {
    try {
      const startTime = Date.now() - windowMs;
      const trades = await adapter.getTradeHistory(readAccount, {
        limit: 200,
        startTime,
      });
      closingFills = trades
        .filter(t =>
          normalizeMarket(t.internalSymbol) === normalizedMarket &&
          t.side === closeSide
        )
        .sort((a, b) => b.timestamp - a.timestamp);

      const sumSize = closingFills.reduce((s, f) => s + f.size, 0);
      if (sumSize >= closedSlice * 0.80) break;
    } catch (err) {
      console.log(`[Reconcile] Partial-reduction fill fetch failed for ${botId}: ${err instanceof Error ? err.message : err}`);
      break;
    }
  }

  // Accumulate fills that cover the slice.
  let aggregatedSize = 0;
  let weightedPriceSum = 0;
  let totalFee = 0;
  const matchedIds: string[] = [];
  for (const fill of closingFills) {
    aggregatedSize += fill.size;
    weightedPriceSum += fill.price * fill.size;
    totalFee += fill.fee;
    matchedIds.push(fill.tradeId);
    if (aggregatedSize >= closedSlice * 0.95) break;
  }

  const hasFills = aggregatedSize >= closedSlice * 0.80;
  const avgFillPrice = hasFills && aggregatedSize > 0
    ? weightedPriceSum / aggregatedSize
    : entryPrice; // fallback: assume entry price (breakeven) when no fills

  // PnL on the closed slice using average-entry semantics.
  const slicePnl = positionSide === 'long'
    ? (avgFillPrice - entryPrice) * closedSlice - totalFee
    : (entryPrice - avgFillPrice) * closedSlice - totalFee;

  // Classify as partial_tp or partial_sl based on sign of PnL.
  const partialSubtype = slicePnl >= 0 ? 'partial_tp' : 'partial_sl';

  // Canonical dedup key for reconciler-detected partials.
  const dedupKey = DatabaseStorage.canonicalCloseFillId({
    signature: matchedIds[0] ? `partial-${matchedIds[0]}` : undefined,
    botId,
    side: closeSide,
    size: closedSlice,
    market,
    fillPrice: avgFillPrice,
    timestampMs: closingFills[0]?.timestamp,
  });

  console.log(`[Reconcile] Partial reduction for bot ${botId} ${market}: slice=${closedSlice.toFixed(4)}, price=$${avgFillPrice.toFixed(4)}, pnl=$${slicePnl.toFixed(4)}, hasFills=${hasFills}, dedup=${dedupKey}`);

  const { isNew } = await storage.recordCloseEventAtomic({
    botId,
    insert: {
      tradingBotId: botId,
      walletAddress,
      market,
      side: closeSide,
      size: String(closedSlice),
      price: String(avgFillPrice),
      fee: String(totalFee),
      pnl: String(slicePnl),
      status: 'executed',
      protocolFillId: dedupKey,
      webhookPayload: {
        reconciled: true,
        closeReason: partialSubtype,
        detectedAt: new Date().toISOString(),
        matchedFillIds: matchedIds.join(','),
        hasFills,
      },
      executionMethod: 'on-chain-detected',
    },
    deltas: {
      totalPnlDelta: slicePnl,
      totalVolumeDelta: closedSlice * avgFillPrice,
      lastTradeAt: new Date().toISOString(),
    },
  });

  if (!isNew) {
    console.log(`[Reconcile] Partial reduction already booked for ${botId} ${market} (dedupKey=${dedupKey})`);
    return;
  }

  // Fire notification (debounced so multi-stage exits don't spam).
  try {
    const botRow = await storage.getTradingBotById(botId);
    schedulePartialCloseNotification({
      walletAddress,
      botId,
      botName: botRow?.name ?? 'Bot',
      market,
      side: dbBaseSize > 0 ? 'LONG' : 'SHORT',
      closedFraction: closedSlice / Math.abs(dbBaseSize),
      realizedPnl: slicePnl,
      price: avgFillPrice,
    });
  } catch (notifErr) {
    console.error(`[Reconcile] Partial-reduction notification error for ${botId}:`, notifErr);
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
    const botRowForAdapter = await storage.getTradingBotById(botId);
    if (!botRowForAdapter) {
      throw new Error(`Reconciliation: bot ${botId} not found — cannot resolve protocol adapter (fail-closed)`);
    }
    const adapter = getAdapterForBot(botRowForAdapter);
    let fetchResult;
    if (botSubaccountPublicKey) {
      try {
        const positions = await adapter.getPositions(botSubaccountPublicKey);
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
      fetchResult = await fetchPerpPositions(agentPublicKey, subAccountId, adapter);
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
        botId, agentPublicKey, market, dbPosition!, botSubaccountPublicKey, adapter
      );

      if (closeDetection.detected) {
        // Back-stop dedup: the webhook/manual/pause/subscriber close path may
        // have ALREADY booked this close under a different canonical id
        // (`tx-<close-tx-signature>` vs the reconciler's `tx-<exchange-fill-id>`),
        // which the protocolFillId unique index can't collapse. If a recent
        // canonical close from a non-reconciler path already exists for this
        // bot+market+approx size (at/after this position's last activity), the
        // close is already counted — skip the duplicate insert (which would
        // double-count realized PnL) but STILL flatten the stale DB position.
        const alreadyBooked = await storage.getRecentCanonicalCloseForBot({
          botId,
          market,
          // Wide window so delayed reconciliation (server restart / backlog)
          // still matches a close booked by another path; afterTimestamp keeps
          // the effective floor at this position's last activity.
          sinceMs: 60 * 60 * 1000,
          afterTimestamp: dbPosition!.lastTradeAt ?? null,
          sizeApprox: Math.abs(dbBaseSize),
          sizeTolerancePct: 0.10,
          excludeReconciled: true,
          // Close side opposite the open position; matches 'CLOSE' rows too.
          closeSide: dbBaseSize > 0 ? 'short' : 'long',
        });
        if (alreadyBooked) {
          console.log(`[Reconcile] Close for bot ${botId} ${market} already booked by another path (tradeId=${alreadyBooked.id}, fillId=${alreadyBooked.protocolFillId ?? 'null'}, status=${alreadyBooked.status}) — skipping duplicate insert, flattening stale position only`);
          // Flatten WITHOUT re-adding PnL/fees: the other path already booked
          // them into bot_trades + stats. Re-adding here would double-count.
          await storage.upsertBotPosition({
            tradingBotId: botId,
            walletAddress,
            market,
            baseSize: "0",
            avgEntryPrice: dbPosition!.avgEntryPrice,
            costBasis: "0",
            realizedPnl: dbPosition!.realizedPnl || "0",
            totalFees: dbPosition!.totalFees || "0",
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
          return { synced: true, discrepancy: true };
        }

        // Canonical close-event ID. Reconciler-detected closes are keyed on
        // the protocol's fill ID when available so retries / racing reconciler
        // runs can never double-write. Falls back to a deterministic synthetic
        // ID derived from bot+market+price+size when the protocol has no fill
        // ID (so re-runs against the same on-chain state are still idempotent).
        const closePnl = closeDetection.pnl ?? 0;
        const closeFillPrice = closeDetection.fillPrice ?? parseFloat(dbPosition!.avgEntryPrice);
        const closeNotional = closeFillPrice * Math.abs(dbBaseSize);
        // Use the SAME canonical identity scheme as every other close
        // writer. Primary input is the FIRST protocol fill ID (a single
        // stable identifier), NOT the legacy joined-IDs string. When no
        // fill ID is available (account-info-derived liquidation), we
        // fall through to the deterministic nosig hash which includes
        // market+side+size+price+5min-time-bucket so repeated reconciler
        // runs against the same close still collide on the unique index.
        const closeSideForId = dbBaseSize > 0 ? 'short' : 'long';
        const dedupKey = DatabaseStorage.canonicalCloseFillId({
          signature: closeDetection.protocolFillId,
          botId,
          side: closeSideForId,
          size: Math.abs(dbBaseSize),
          market,
          fillPrice: closeFillPrice,
          timestampMs: closeDetection.fillTimestampMs,
        });

        console.log(`[Reconcile] Position closed on-chain for bot ${botId} ${market}: reason=${closeDetection.reason}, fill=$${closeFillPrice.toFixed(4)}, pnl=$${closePnl.toFixed(4)}`);

        // Atomic: insert canonical close row + recompute stats in ONE
        // DB transaction (task #67 requirement). Idempotency hits skip
        // the recompute internally so racing reconciler/webhook/retry
        // writes converge without double-counting deltas.
        const { isNew } = await storage.recordCloseEventAtomic({
          botId,
          insert: {
            tradingBotId: botId,
            walletAddress,
            market,
            side: dbBaseSize > 0 ? 'short' : 'long',
            size: String(Math.abs(dbBaseSize)),
            price: String(closeFillPrice),
            fee: String(closeDetection.fee ?? 0),
            // Canonical close: realized PnL is required (breakeven uses '0', never null).
            pnl: String(closePnl),
            status: closeDetection.reason === 'liquidation' ? 'liquidated' : 'executed',
            protocolFillId: dedupKey,
            webhookPayload: {
              reconciled: true,
              closeReason: closeDetection.reason,
              detectedAt: new Date().toISOString(),
              protocolFillId: closeDetection.protocolFillId,
              matchedFillIdsForDiagnostics: closeDetection.matchedFillIdsForDiagnostics,
            },
            executionMethod: 'on-chain-detected',
          },
          deltas: {
            totalPnlDelta: closePnl,
            totalVolumeDelta: closeNotional,
            lastTradeAt: new Date().toISOString(),
          },
        });

        if (!isNew) {
          console.log(`[Reconcile] Close already recorded for bot ${botId} ${market} (dedupKey=${dedupKey}), skipping duplicate stats update`);
          lastReconcileTime.set(botId, Date.now());
          return { synced: true, discrepancy: false };
        }

        // Fire Telegram notification exactly once per detected close: gated on
        // `isNew=true` so racing reconciler ticks / cross-path replays
        // (manual-close already wrote the canonical row) never double-fire.
        // Fire-and-forget; never let a Telegram failure mask reconciliation.
        try {
          const reasonLabel = getCloseReasonLabel(closeDetection.reason, closeDetection.tpslSubtype);
          const botRow = await storage.getTradingBotById(botId);
          const botName = botRow?.name ?? 'Bot';
          sendTradeNotification(walletAddress, {
            type: 'position_closed',
            botName,
            market,
            side: dbBaseSize > 0 ? 'LONG' : 'SHORT',
            size: Math.abs(dbBaseSize),
            price: closeFillPrice,
            pnl: closePnl,
            closeReason: reasonLabel,
          }).catch(err => console.error(`[Reconcile] Notification error for bot ${botId}:`, err));
        } catch (notifErr) {
          console.error(`[Reconcile] Failed to dispatch close notification for bot ${botId}:`, notifErr);
        }

        await storage.upsertBotPosition({
          tradingBotId: botId,
          walletAddress,
          market,
          baseSize: "0",
          avgEntryPrice: dbPosition!.avgEntryPrice,
          costBasis: "0",
          realizedPnl: String(parseFloat(dbPosition!.realizedPnl || "0") + closePnl),
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
        // ── Partial-reduction detection ─────────────────────────────────────
        // Same sign but on-chain is meaningfully smaller → some contracts were
        // closed externally (partial TP/SL, manual partial reduce). Book PnL
        // for the closed slice using the average-entry price from the DB.
        // Guard: 3-minute propagation lag (same as full-close path) prevents
        // false positives right after an entry.
        const sameSide =
          (dbBaseSize > 0 && onChainBaseSize > 0) ||
          (dbBaseSize < 0 && onChainBaseSize < 0);
        const closedSlice = Math.abs(dbBaseSize) - Math.abs(onChainBaseSize);
        const isPartialReduction =
          sameSide &&
          closedSlice / Math.abs(dbBaseSize) > 0.03 && // >3% reduction
          closedSlice > 0.0001;

        if (isPartialReduction) {
          const positionAgeMs = dbPosition?.lastTradeAt
            ? Date.now() - new Date(dbPosition.lastTradeAt).getTime()
            : Infinity;

          if (positionAgeMs >= 3 * 60 * 1000) {
            await bookPartialReduction({
              botId,
              walletAddress,
              market,
              agentPublicKey,
              botSubaccountPublicKey,
              dbBaseSize,
              dbPosition: dbPosition!,
              closedSlice,
              onChainBaseSize,
              adapter,
            });
          } else {
            console.log(`[Reconcile] Partial reduction detected for bot ${botId} ${market} but position is only ${(positionAgeMs / 1000).toFixed(0)}s old — likely propagation lag, skipping`);
          }
        }

        // Always sync position to on-chain state (with accumulated PnL from bookPartialReduction).
        const refreshedDbPos = await storage.getBotPosition(botId, market);
        await storage.upsertBotPosition({
          tradingBotId: botId,
          walletAddress,
          market,
          baseSize: String(onChainBaseSize),
          avgEntryPrice: String(onChainPos!.entryPrice),
          costBasis: String(Math.abs(onChainBaseSize) * onChainPos!.entryPrice),
          realizedPnl: refreshedDbPos?.realizedPnl ?? dbPosition?.realizedPnl ?? "0",
          totalFees: refreshedDbPos?.totalFees ?? dbPosition?.totalFees ?? "0",
          lastTradeId: refreshedDbPos?.lastTradeId ?? dbPosition?.lastTradeId ?? null,
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
    const botSubPubKey = (bot.subaccountAuthMode === 'external_key' && bot.subaccountStatus === 'active' && bot.protocolSubaccountId)
      ? bot.protocolSubaccountId
      : undefined;
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
          const botSubPubKey = (bot.subaccountAuthMode === 'external_key' && bot.subaccountStatus === 'active' && bot.protocolSubaccountId)
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
