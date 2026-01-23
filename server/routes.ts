import type { Express } from "express";
import { createServer, type Server } from "http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pg from "pg";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { encrypt as legacyEncrypt } from "./crypto";
import { storage } from "./storage";
import { insertUserSchema, insertTradingBotSchema, type TradingBot } from "@shared/schema";
import { ZodError } from "zod";
import { getMarketPrice, getAllPrices, forceRefreshPrices } from "./drift-price";
import { buildDepositTransaction, buildWithdrawTransaction, getUsdcBalance, getDriftBalance, buildTransferToSubaccountTransaction, buildTransferFromSubaccountTransaction, subaccountExists, buildAgentDriftDepositTransaction, buildAgentDriftWithdrawTransaction, executeAgentDriftDeposit, executeAgentDriftWithdraw, executeAgentTransferBetweenSubaccounts, getAgentDriftBalance, getDriftAccountInfo, getBatchDriftAccountInfo, getBatchPerpPositions, executePerpOrder, getPerpPositions, closePerpPosition, getNextOnChainSubaccountId, discoverOnChainSubaccounts, closeDriftSubaccount, settleAllPnl } from "./drift-service";
import { reconcileBotPosition, syncPositionFromOnChain } from "./reconciliation-service";
import { PositionService } from "./position-service";
import { getAgentUsdcBalance, getAgentSolBalance, buildTransferToAgentTransaction, buildWithdrawFromAgentTransaction, buildSolTransferToAgentTransaction, buildWithdrawSolFromAgentTransaction, executeAgentWithdraw, executeAgentSolWithdraw, transferUsdcToWallet } from "./agent-wallet";
import { getAllPerpMarkets, getMarketBySymbol, getRiskTierInfo, isValidMarket, refreshMarketData, getCacheStatus, getMinOrderSize, getMarketMaxLeverage } from "./market-liquidity-service";
import { sendTradeNotification, type TradeNotification } from "./notification-service";
import { createSigningNonce, verifySignatureAndConsumeNonce, initializeWalletSecurity, getSession, getSessionByWalletAddress, invalidateSession, cleanupExpiredNonces, revealMnemonic, enableExecution, revokeExecution, emergencyStopWallet, getUmkForWebhook, computeBotPolicyHmac, verifyBotPolicyHmac, decryptAgentKeyWithFallback, generateAgentWalletWithMnemonic, encryptAndStoreMnemonic, encryptAgentKeyV3 } from "./session-v3";
import { queueTradeRetry, isRateLimitError, isTransientError, getQueueStatus } from "./trade-retry-service";
import { startAnalyticsIndexer, getMetrics } from "./analytics-indexer";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";

// Drift trading fee rate (0.05% base - 10% referral discount = 0.045%)
const DRIFT_FEE_RATE = 0.00045;

declare module "express-session" {
  interface SessionData {
    userId: string;
    walletAddress: string;
  }
}

declare global {
  namespace Express {
    interface Request {
      walletAddress?: string;
    }
  }
}

function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

function generateSignalHash(botId: string, payload: any): string {
  // Create a deterministic hash from botId + key signal data
  // This prevents duplicate orders from the same TradingView alert
  const signalData = {
    botId,
    action: payload?.data?.action || payload?.action || '',
    contracts: payload?.data?.contracts || payload?.contracts || '',
    symbol: payload?.symbol || '',
    time: payload?.time || '',
    // Include price to distinguish different signals (rounded to reduce noise)
    price: payload?.price ? Math.round(parseFloat(payload.price) * 100) / 100 : 0,
  };
  return crypto.createHash('sha256').update(JSON.stringify(signalData)).digest('hex').substring(0, 32);
}

function generateWebhookUrl(botId: string, secret: string): string {
  // Use production domain for webhooks, falling back to Replit domains for dev
  const baseUrl = process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT_DOMAIN
    ? 'https://myquantumvault.com'
    : process.env.REPLIT_DEV_DOMAIN 
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : 'http://localhost:5000';
  return `${baseUrl}/api/webhook/tradingview/${botId}?secret=${secret}`;
}

// Parse Drift protocol errors into user-friendly messages
function parseDriftError(error: string | undefined): string {
  if (!error) return "Trade execution failed";
  
  // Always log the full error for debugging
  console.log(`[Drift Error] Full error: ${error}`);
  
  // Check for common Drift errors and provide clear messages
  if (error.includes("InsufficientCollateral")) {
    return "Insufficient capital in bot's account. Add more funds or reduce your Max Position Size.";
  }
  if (error.includes("OracleNotFound") || error.includes("Stale")) {
    return "Price feed temporarily unavailable. Try again in a few seconds.";
  }
  if (error.includes("MaxNumberOfPositions")) {
    return "Maximum positions reached. Close existing positions first.";
  }
  if (error.includes("InvalidOracle")) {
    return "Market price data unavailable. Try again later.";
  }
  if (error.includes("MarketWrongMutability") || error.includes("MarketNotActive")) {
    return "Market is currently paused or unavailable.";
  }
  if (error.includes("ReduceOnlyOrderIncreasedRisk")) {
    return "Cannot increase position size with reduce-only order.";
  }
  if (error.includes("timeout") || error.includes("Timeout")) {
    return "Transaction timed out. The trade may have executed - check Drift.";
  }
  // Additional common Drift/Anchor errors
  if (error.includes("ReduceOnly") || error.includes("FillPaused")) {
    return "Market is in reduce-only mode. Only closing positions is allowed.";
  }
  if (error.includes("AMMPaused")) {
    return "Market trading is temporarily paused. Try again later.";
  }
  if (error.includes("AccountOwnedByWrongProgram") || error.includes("wrong owner")) {
    return "Account initialization issue. Try resetting your Drift account in Settings.";
  }
  if (error.includes("userStats account") || error.includes("Main account") || error.includes("account does not exist")) {
    return "Drift account not properly initialized. Please deposit funds first.";
  }
  if (error.includes("Key mismatch") || error.includes("decrypted key")) {
    return "Wallet key error. Please contact support.";
  }
  if (error.includes("subscription failed") || error.includes("Market data could not be loaded")) {
    return "Could not load market data. Try again in a few seconds.";
  }
  if (error.includes("0x1") || error.includes("InstructionError")) {
    // Try to extract more specific info from Anchor/instruction errors
    const hexMatch = error.match(/0x([0-9a-fA-F]+)/);
    if (hexMatch) {
      return `Trade rejected by Drift (code: ${hexMatch[0]}). Check account balance.`;
    }
    return "Trade instruction rejected. Check account balance and try again.";
  }
  if (error.includes("SlippageToleranceExceeded") || error.includes("slippage")) {
    return "Price moved too much. Try increasing slippage in Settings.";
  }
  if (error.includes("BorrowLimitExceeded")) {
    return "Borrow limit exceeded. Reduce position size or add more collateral.";
  }
  
  // For other errors, extract a useful portion instead of hiding it
  if (error.length > 150) {
    // Try to extract the main error message
    const errMsgMatch = error.match(/Error Message: ([^.]+)/);
    if (errMsgMatch) return errMsgMatch[1].trim();
    
    // Try to extract Anchor error names
    const anchorMatch = error.match(/Error Name: (\w+)/);
    if (anchorMatch) return `Drift error: ${anchorMatch[1]}`;
    
    // Try to extract the key part of the error
    const errorMatch = error.match(/Error: ([^.]+)/);
    if (errorMatch) return errorMatch[1].trim().slice(0, 100);
    
    // Return a truncated version with the start of the error, not a generic message
    return `Trade failed: ${error.slice(0, 120)}...`;
  }
  
  return error;
}

// Distribute profit share from subscriber bot to signal creator
// Called after a profitable close trade on subscriber bots
async function distributeCreatorProfitShare(params: {
  subscriberBotId: string;
  subscriberWalletAddress: string;
  subscriberAgentPublicKey: string;
  subscriberEncryptedPrivateKey: string;
  driftSubaccountId: number;
  realizedPnl: number;
  tradeId: string;
}): Promise<{ success: boolean; amount?: number; signature?: string; error?: string }> {
  const { 
    subscriberBotId, 
    subscriberWalletAddress,
    subscriberAgentPublicKey,
    subscriberEncryptedPrivateKey,
    driftSubaccountId,
    realizedPnl, 
    tradeId 
  } = params;

  // Validation 1: Only process profitable trades
  if (realizedPnl <= 0) {
    return { success: true }; // No profit = no share to distribute
  }

  // Validation 2: Check if this is a subscriber bot
  const subscription = await storage.getBotSubscriptionBySubscriberBotId(subscriberBotId);
  if (!subscription) {
    return { success: true }; // Not a subscriber bot, no profit share
  }

  const { publishedBot } = subscription;
  const profitSharePercent = parseFloat(String(publishedBot.profitSharePercent ?? 0));

  // Validation 3: Check if profit sharing is enabled
  if (profitSharePercent <= 0 || isNaN(profitSharePercent)) {
    console.log(`[ProfitShare] No profit share configured for published bot ${publishedBot.id}`);
    return { success: true };
  }

  // Calculate profit share amount
  const profitShareAmount = (realizedPnl * profitSharePercent) / 100;
  
  // Validation 4: Dust check - don't process amounts below $0.01
  if (profitShareAmount < 0.01) {
    console.log(`[ProfitShare] Dust amount $${profitShareAmount.toFixed(4)}, skipping for trade ${tradeId}`);
    return { success: true };
  }

  // Get creator's wallet address directly from published bot
  const creatorWalletAddress = publishedBot.creatorWalletAddress;
  if (!creatorWalletAddress) {
    console.error(`[ProfitShare] Creator wallet address not found for published bot ${publishedBot.id}`);
    return { success: false, error: 'Creator wallet address not found' };
  }

  // Validation 5: Validate creator wallet address
  try {
    new PublicKey(creatorWalletAddress);
  } catch (e) {
    console.error(`[ProfitShare] Invalid creator wallet address: ${creatorWalletAddress}`);
    return { success: false, error: 'Invalid creator wallet address' };
  }

  console.log(`[ProfitShare] Processing: trade=${tradeId}, pnl=$${realizedPnl.toFixed(4)}, share=${profitSharePercent}%, amount=$${profitShareAmount.toFixed(4)}, creator=${creatorWalletAddress}`);

  // Helper function to create IOU on failure
  const createIouOnFailure = async (errorMsg: string) => {
    try {
      await storage.createPendingProfitShare({
        subscriberBotId,
        subscriberWalletAddress,
        creatorWalletAddress,
        amount: profitShareAmount.toString(),
        realizedPnl: realizedPnl.toString(),
        profitSharePercent: profitSharePercent.toString(),
        tradeId,
        publishedBotId: publishedBot.id,
        driftSubaccountId,
      });
      console.log(`[ProfitShare] IOU created for $${profitShareAmount.toFixed(4)} to ${creatorWalletAddress} (trade: ${tradeId})`);
    } catch (iouErr: any) {
      console.error(`[ProfitShare] Failed to create IOU: ${iouErr.message}`);
    }
  };

  // Step 1: Settle PnL from on-chain position
  const settleResult = await settleAllPnl(subscriberEncryptedPrivateKey, driftSubaccountId);
  if (!settleResult.success) {
    console.error(`[ProfitShare] Failed to settle PnL: ${settleResult.error}`);
    await createIouOnFailure(`Settle PnL failed: ${settleResult.error}`);
    return { success: false, error: `Settle PnL failed: ${settleResult.error}` };
  }

  // Step 2: Withdraw from Drift subaccount to agent wallet
  const withdrawResult = await executeAgentDriftWithdraw(
    subscriberAgentPublicKey,
    subscriberEncryptedPrivateKey,
    profitShareAmount,
    driftSubaccountId
  );

  if (!withdrawResult.success) {
    // Handle cross-margin collateral and other withdrawal failures
    const errorMsg = withdrawResult.error || 'Unknown withdrawal error';
    console.error(`[ProfitShare] Drift withdrawal failed: ${errorMsg}`);
    
    // Check for dust error and retry with slightly less
    if (errorMsg.includes('Withdraw leaves user negative USDC') || errorMsg.includes('6088')) {
      const dustAdjustedAmount = profitShareAmount - 0.000001;
      if (dustAdjustedAmount >= 0.01) {
        console.log(`[ProfitShare] Retrying withdrawal with dust-adjusted amount: $${dustAdjustedAmount.toFixed(6)}`);
        const retryResult = await executeAgentDriftWithdraw(
          subscriberAgentPublicKey,
          subscriberEncryptedPrivateKey,
          dustAdjustedAmount,
          driftSubaccountId
        );
        if (!retryResult.success) {
          await createIouOnFailure(`Drift withdrawal failed after dust adjustment: ${retryResult.error}`);
          return { success: false, error: `Drift withdrawal failed after dust adjustment: ${retryResult.error}`, amount: profitShareAmount };
        }
      } else {
        await createIouOnFailure('Amount too small after dust adjustment');
        return { success: false, error: 'Amount too small after dust adjustment', amount: profitShareAmount };
      }
    } else {
      await createIouOnFailure(`Drift withdrawal failed: ${errorMsg}`);
      return { success: false, error: `Drift withdrawal failed: ${errorMsg}`, amount: profitShareAmount };
    }
  }

  // Step 3: Transfer USDC from agent wallet to creator's main wallet
  const transferResult = await transferUsdcToWallet(
    subscriberAgentPublicKey,
    subscriberEncryptedPrivateKey,
    creatorWalletAddress,
    profitShareAmount
  );

  if (!transferResult.success) {
    const errorMsg = transferResult.error || 'Unknown transfer error';
    console.error(`[ProfitShare] Transfer to creator failed: ${errorMsg}`);
    
    // Create IOU for failed transfers (SOL starvation, RPC errors, etc.)
    await createIouOnFailure(errorMsg);
    
    // SOL starvation is a specific condition to surface in error message
    if (errorMsg.includes('Insufficient SOL')) {
      return { 
        success: false, 
        error: `Transfer failed - agent wallet needs SOL for gas (balance: ${transferResult.solBalance?.toFixed(6) || '0'} SOL)`, 
        amount: profitShareAmount 
      };
    }
    
    return { success: false, error: `Transfer failed: ${errorMsg}`, amount: profitShareAmount };
  }

  console.log(`[ProfitShare] SUCCESS: $${profitShareAmount.toFixed(4)} sent to ${creatorWalletAddress}, signature: ${transferResult.signature}`);
  
  return { 
    success: true, 
    amount: profitShareAmount, 
    signature: transferResult.signature 
  };
}

// PHASE 6.2 SECURITY NOTE: Subscriber Routing uses LEGACY encrypted key path
// This is INTENTIONAL because subscriber wallets belong to DIFFERENT users who do not have
// active sessions during webhook processing. The source bot's owner has an active session,
// but subscriber bot owners are different users whose UMK is not available.
// Subscriber wallets must use the encrypted agent key stored in the database.
// Future enhancement: Subscribers could enable their own execution authorization for v3 path.
async function routeSignalToSubscribers(
  sourceBotId: string,
  signal: {
    action: 'buy' | 'sell';
    contracts: string;
    positionSize: string;
    price: string;
    isCloseSignal: boolean;
    strategyPositionSize: string | null;
  }
): Promise<void> {
  try {
    const publishedBot = await storage.getPublishedBotByTradingBotId(sourceBotId);
    if (!publishedBot || !publishedBot.isActive) {
      return;
    }

    const subscriberBots = await storage.getSubscriberBotsBySourceId(publishedBot.id);
    if (!subscriberBots || subscriberBots.length === 0) {
      return;
    }

    console.log(`[Subscriber Routing] Source bot ${sourceBotId} is published, routing signal to ${subscriberBots.length} subscribers`);

    for (const subBot of subscriberBots) {
      if (!subBot.isActive) {
        console.log(`[Subscriber Routing] Skipping inactive subscriber bot ${subBot.id}`);
        continue;
      }

      try {
        const subWallet = await storage.getWallet(subBot.walletAddress);
        if (!subWallet?.agentPrivateKeyEncrypted || !subWallet?.agentPublicKey) {
          console.log(`[Subscriber Routing] Subscriber bot ${subBot.id} has no agent wallet configured`);
          continue;
        }

        const subAccountId = subBot.driftSubaccountId ?? 0;

        if (signal.isCloseSignal) {
          const position = await PositionService.getPositionForExecution(
            subBot.id,
            subWallet.agentPublicKey,
            subAccountId,
            subBot.market,
            subWallet.agentPrivateKeyEncrypted
          );

          if (position.side === 'FLAT' || Math.abs(position.size) < 0.0001) {
            console.log(`[Subscriber Routing] No position to close for subscriber bot ${subBot.id}`);
            continue;
          }

          console.log(`[Subscriber Routing] Closing position for subscriber bot ${subBot.id}: size=${position.size}`);
          
          // NOTE: Uses legacy encrypted key - subscriber wallet's UMK not available (see function header comment)
          const subCloseSlippageBps = subWallet.slippageBps ?? 50;
          const closeResult = await closePerpPosition(
            subWallet.agentPrivateKeyEncrypted,
            subBot.market,
            subAccountId,
            undefined,
            subCloseSlippageBps
          );

          if (closeResult.success) {
            const fillPrice = parseFloat(signal.price);
            const stats = subBot.stats as TradingBot['stats'] || { totalTrades: 0, winningTrades: 0, losingTrades: 0, totalPnl: 0, totalVolume: 0 };
            await storage.createBotTrade({
              tradingBotId: subBot.id,
              walletAddress: subBot.walletAddress,
              market: subBot.market,
              side: position.side === 'LONG' ? 'SHORT' : 'LONG',
              size: Math.abs(position.size).toFixed(8),
              price: fillPrice.toFixed(6),
              status: 'executed',
              fee: '0',
              txSignature: closeResult.signature || null,
              webhookPayload: { source: 'marketplace_routing', signalFrom: sourceBotId },
            });
            
            await storage.updateTradingBotStats(subBot.id, {
              ...stats,
              totalTrades: (stats.totalTrades || 0) + 1,
              totalVolume: (stats.totalVolume || 0) + Math.abs(position.size) * fillPrice,
              lastTradeAt: new Date().toISOString(),
            });

            sendTradeNotification(subWallet.address, {
              type: 'trade_executed',
              botName: subBot.name,
              market: subBot.market,
              side: position.side === 'LONG' ? 'SHORT' : 'LONG',
              size: Math.abs(position.size) * fillPrice,
              price: fillPrice,
            }).catch(err => console.error('[Subscriber Routing] Notification error:', err));
          } else {
            console.error(`[Subscriber Routing] Close failed for subscriber bot ${subBot.id}:`, closeResult.error);
          }
        } else {
          const oraclePrice = parseFloat(signal.price);
          const maxPos = parseFloat(subBot.maxPositionSize || '0');
          if (maxPos <= 0) {
            console.log(`[Subscriber Routing] Subscriber bot ${subBot.id} has no maxPositionSize configured`);
            continue;
          }

          const sourceContracts = parseFloat(signal.contracts);
          const sourcePositionSize = parseFloat(signal.positionSize) || 100;
          const tradePercent = Math.min(sourceContracts / sourcePositionSize, 1);
          let tradeAmountUsd = maxPos * tradePercent;
          
          // DYNAMIC ORDER SCALING: Scale trade size based on available margin
          // This allows trades to execute after losses by scaling down proportionally
          const botLeverage = Math.max(1, subBot.leverage || 1); // Ensure leverage >= 1
          const marketMaxLeverage = getMarketMaxLeverage(subBot.market);
          const effectiveLeverage = Math.min(botLeverage, marketMaxLeverage); // Use the lower of bot's setting or market's limit
          try {
            const accountInfo = await getDriftAccountInfo(subWallet.agentPublicKey!, subAccountId);
            const freeCollateral = Math.max(0, accountInfo.freeCollateral); // Clamp to >= 0
            
            // freeCollateral is margin capacity (USD), multiply by leverage to get max notional position size
            // CRITICAL: Use effectiveLeverage (capped by market's max) to avoid InsufficientCollateral errors
            const maxNotionalCapacity = freeCollateral * effectiveLeverage;
            const maxTradeableValue = maxNotionalCapacity * 0.90; // 90% buffer for fees/slippage
            
            if (botLeverage > marketMaxLeverage) {
              console.log(`[Subscriber Routing] Bot ${subBot.id}: Leverage capped ${botLeverage}x → ${marketMaxLeverage}x (${subBot.market} max)`);
            }
            console.log(`[Subscriber Routing] Bot ${subBot.id}: freeCollateral=$${freeCollateral.toFixed(2)} × ${effectiveLeverage}x = $${maxNotionalCapacity.toFixed(2)} max notional`);
            
            if (maxTradeableValue <= 0) {
              console.log(`[Subscriber Routing] Bot ${subBot.id}: No margin available, skipping`);
              continue;
            } else if (tradeAmountUsd > maxTradeableValue) {
              const originalAmount = tradeAmountUsd;
              tradeAmountUsd = maxTradeableValue;
              const scalePercent = ((tradeAmountUsd / originalAmount) * 100).toFixed(1);
              console.log(`[Subscriber Routing] Bot ${subBot.id} SCALED DOWN: $${originalAmount.toFixed(2)} → $${tradeAmountUsd.toFixed(2)} (${scalePercent}%)`);
            }
          } catch (collateralErr: any) {
            console.warn(`[Subscriber Routing] Could not check collateral for bot ${subBot.id}: ${collateralErr.message}`);
          }
          
          const contractSize = tradeAmountUsd / oraclePrice;

          if (contractSize < 0.001) {
            console.log(`[Subscriber Routing] Trade size too small for subscriber bot ${subBot.id} ($${tradeAmountUsd.toFixed(2)} = ${contractSize.toFixed(6)} contracts)`);
            continue;
          }

          console.log(`[Subscriber Routing] Executing ${signal.action} for subscriber bot ${subBot.id}: $${tradeAmountUsd.toFixed(2)} = ${contractSize.toFixed(6)} contracts`);

          // NOTE: Uses legacy encrypted key - subscriber wallet's UMK not available (see function header comment)
          const side = signal.action === 'buy' ? 'long' : 'short';
          const subSlippageBps = subWallet.slippageBps ?? 50;
          const orderResult = await executePerpOrder(
            subWallet.agentPrivateKeyEncrypted,
            subBot.market,
            side,
            contractSize,
            subAccountId,
            false,
            subSlippageBps
          );

          if (orderResult.success) {
            const fillPrice = orderResult.fillPrice ?? oraclePrice;
            const stats = subBot.stats as TradingBot['stats'] || { totalTrades: 0, winningTrades: 0, losingTrades: 0, totalPnl: 0, totalVolume: 0 };

            await storage.createBotTrade({
              tradingBotId: subBot.id,
              walletAddress: subBot.walletAddress,
              market: subBot.market,
              side: side === 'long' ? 'LONG' : 'SHORT',
              size: contractSize.toFixed(8),
              price: fillPrice.toFixed(6),
              status: 'executed',
              fee: '0',
              txSignature: orderResult.txSignature || orderResult.signature || null,
              webhookPayload: { source: 'marketplace_routing', signalFrom: sourceBotId },
            });

            await storage.updateTradingBotStats(subBot.id, {
              ...stats,
              totalTrades: (stats.totalTrades || 0) + 1,
              totalVolume: (stats.totalVolume || 0) + contractSize * fillPrice,
              lastTradeAt: new Date().toISOString(),
            });

            sendTradeNotification(subWallet.address, {
              type: 'trade_executed',
              botName: subBot.name,
              market: subBot.market,
              side: side === 'long' ? 'LONG' : 'SHORT',
              size: contractSize * fillPrice,
              price: fillPrice,
            }).catch(err => console.error('[Subscriber Routing] Notification error:', err));
          } else {
            console.error(`[Subscriber Routing] Order failed for subscriber bot ${subBot.id}:`, orderResult.error);
            
            await storage.createBotTrade({
              tradingBotId: subBot.id,
              walletAddress: subBot.walletAddress,
              market: subBot.market,
              side: side === 'long' ? 'LONG' : 'SHORT',
              size: contractSize.toFixed(8),
              price: oraclePrice.toFixed(6),
              status: 'failed',
              fee: '0',
              errorMessage: parseDriftError(orderResult.error),
              webhookPayload: { source: 'marketplace_routing', signalFrom: sourceBotId },
            });

            sendTradeNotification(subWallet.address, {
              type: 'trade_failed',
              botName: subBot.name,
              market: subBot.market,
              side: side === 'long' ? 'LONG' : 'SHORT',
              size: contractSize * oraclePrice,
              price: oraclePrice,
              error: parseDriftError(orderResult.error),
            }).catch(err => console.error('[Subscriber Routing] Notification error:', err));
          }
        }
      } catch (subError) {
        console.error(`[Subscriber Routing] Error processing subscriber bot ${subBot.id}:`, subError);
      }
    }
  } catch (error) {
    console.error('[Subscriber Routing] Error:', error);
  }
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Trust proxy for secure cookies behind Replit's reverse proxy
  if (process.env.NODE_ENV === "production") {
    app.set('trust proxy', 1);
  }

  const PgStore = connectPgSimple(session);
  const pgPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
  });
  
  app.use(
    session({
      store: new PgStore({
        pool: pgPool,
        tableName: 'user_sessions',
        createTableIfMissing: true,
      }),
      secret: process.env.SESSION_SECRET || "quantum-vault-secret-change-in-production",
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: process.env.NODE_ENV === "production" ? 'lax' : undefined,
        maxAge: 1000 * 60 * 60 * 24 * 7,
      },
    })
  );

  const requireAuth = (req: any, res: any, next: any) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  };

  const requireWallet = (req: any, res: any, next: any) => {
    const headerWallet = req.query.wallet || req.body.walletAddress || req.headers['x-wallet-address'];
    const sessionWallet = req.session?.walletAddress;
    
    // Debug logging for close-position requests
    if (req.path.includes('close-position')) {
      console.log(`[requireWallet] close-position request - sessionWallet: ${sessionWallet}, headerWallet: ${headerWallet}`);
    }
    
    if (!sessionWallet) {
      console.log(`[requireWallet] Rejecting - no session wallet for ${req.method} ${req.path}`);
      return res.status(401).json({ error: "Wallet not connected - please connect your wallet first" });
    }
    
    if (headerWallet && sessionWallet !== headerWallet) {
      console.log(`[requireWallet] Rejecting - wallet mismatch for ${req.method} ${req.path}: session=${sessionWallet}, header=${headerWallet}`);
      return res.status(403).json({ error: "Wallet mismatch - please reconnect wallet" });
    }
    
    req.walletAddress = sessionWallet;
    next();
  };

  // Helper to generate a unique referral code
  const generateReferralCode = (): string => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  };

  async function verifySolanaSignature(message: string, signature: Uint8Array, publicKey: string): Promise<boolean> {
    try {
      const messageBytes = new TextEncoder().encode(message);
      const pubkeyBytes = bs58.decode(publicKey);
      return nacl.sign.detached.verify(messageBytes, signature, pubkeyBytes);
    } catch {
      return false;
    }
  }

  // Start analytics indexer for platform metrics
  startAnalyticsIndexer();

  // Public API: Platform metrics (no auth required) - for landing page
  app.get("/api/metrics", async (req, res) => {
    try {
      const metrics = await getMetrics();
      res.json({
        tvl: metrics.tvl,
        totalVolume: metrics.totalVolume,
        volume24h: metrics.volume24h,
        volume7d: metrics.volume7d,
        activeBots: metrics.activeBots,
        activeUsers: metrics.activeUsers,
        totalTrades: metrics.totalTrades,
        lastUpdated: metrics.lastUpdated.toISOString(),
      });
    } catch (error) {
      console.error("[Metrics] Error fetching platform metrics:", error);
      res.status(500).json({ error: "Failed to fetch platform metrics" });
    }
  });

  // Public API: Historical metrics for charts (no auth required)
  app.get("/api/metrics/history", async (req, res) => {
    try {
      const days = Math.min(parseInt(req.query.days as string) || 7, 30);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      
      const tvlHistory = await storage.getPlatformMetricHistory('tvl', since, 100);
      const volumeHistory = await storage.getPlatformMetricHistory('total_volume', since, 100);
      
      res.json({
        tvl: tvlHistory.map(m => ({
          timestamp: m.calculatedAt.toISOString(),
          value: parseFloat(m.value),
        })),
        volume: volumeHistory.map(m => ({
          timestamp: m.calculatedAt.toISOString(),
          value: parseFloat(m.value),
        })),
      });
    } catch (error) {
      console.error("[Metrics] Error fetching metrics history:", error);
      res.status(500).json({ error: "Failed to fetch metrics history" });
    }
  });

  app.post("/api/auth/nonce", async (req, res) => {
    try {
      const { walletAddress, purpose } = req.body;
      if (!walletAddress || !purpose) {
        return res.status(400).json({ error: "Wallet address and purpose required" });
      }

      const validPurposes = ['unlock_umk', 'authorize_trade', 'enable_execution', 'revoke_execution', 'reveal_mnemonic'];
      if (!validPurposes.includes(purpose)) {
        return res.status(400).json({ error: "Invalid purpose" });
      }

      const { nonce, message } = await createSigningNonce(walletAddress, purpose);
      res.json({ nonce, message });
    } catch (error) {
      console.error("Nonce creation error:", error);
      res.status(500).json({ error: "Failed to create nonce" });
    }
  });

  app.post("/api/auth/verify", async (req, res) => {
    try {
      const { walletAddress, nonce, signature, purpose } = req.body;
      if (!walletAddress || !nonce || !signature || !purpose) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const signatureBytes = Uint8Array.from(
        typeof signature === 'string' ? bs58.decode(signature) : signature
      );

      const result = await verifySignatureAndConsumeNonce(
        walletAddress,
        nonce,
        purpose,
        signatureBytes,
        verifySolanaSignature
      );

      if (!result.success) {
        return res.status(401).json({ error: result.error });
      }

      if (purpose === 'unlock_umk') {
        const initResult = await initializeWalletSecurity(walletAddress, signatureBytes);
        req.session.walletAddress = walletAddress;
        
        // Create agent wallet with mnemonic if one doesn't exist yet
        let wallet = await storage.getWallet(walletAddress);
        if (wallet && !wallet.agentPublicKey) {
          const session = getSession(initResult.sessionId);
          if (session) {
            const generatedWallet = generateAgentWalletWithMnemonic();
            const agentPublicKey = generatedWallet.keypair.publicKey.toString();
            
            // Encrypt private key with legacy method for backward compatibility
            const privateKeyBase58 = bs58.encode(generatedWallet.secretKeyBuffer);
            const encryptedPrivateKey = legacyEncrypt(privateKeyBase58);
            
            // Encrypt the private key with v3 encryption (UMK-based)
            const encryptedV3 = encryptAgentKeyV3(session.umk, generatedWallet.secretKeyBuffer, walletAddress);
            
            // Store the mnemonic encrypted with UMK
            await encryptAndStoreMnemonic(walletAddress, generatedWallet.mnemonicBuffer, session.umk);
            
            // Store both legacy and v3 encrypted keys (same keypair, different encryption methods)
            await storage.updateWalletAgentKeys(walletAddress, agentPublicKey, encryptedPrivateKey);
            await storage.updateWalletAgentKeyV3(walletAddress, encryptedV3);
            
            console.log(`[Agent] Generated new agent wallet with mnemonic for ${walletAddress}: ${agentPublicKey}`);
          }
        }
        
        return res.json({ 
          success: true, 
          sessionId: initResult.sessionId,
          isNewWallet: initResult.isNewWallet 
        });
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Signature verification error:", error);
      res.status(500).json({ error: "Verification failed" });
    }
  });

  app.get("/api/auth/session", requireWallet, async (req, res) => {
    try {
      const result = getSessionByWalletAddress(req.walletAddress!);
      if (!result) {
        return res.json({
          hasSession: false,
          sessionMissing: true,
          sessionId: null,
          walletAddress: req.walletAddress,
          message: 'Session expired. Please reconnect your wallet.',
        });
      }
      res.json({
        hasSession: true,
        sessionMissing: false,
        sessionId: result.sessionId,
        walletAddress: result.session.walletAddress,
      });
    } catch (error) {
      console.error("Session check error:", error);
      res.status(500).json({ error: "Session check failed" });
    }
  });

  // Public endpoint to check if a wallet has an active session (no auth required)
  // Used by frontend to skip signature prompt if already authenticated
  app.post("/api/auth/status", async (req, res) => {
    try {
      const { walletAddress } = req.body;
      if (!walletAddress) {
        return res.status(400).json({ error: "Wallet address required" });
      }
      
      // Check if this wallet has an active session in express-session
      const sessionWallet = req.session?.walletAddress;
      const hasSession = sessionWallet === walletAddress;
      
      res.json({
        authenticated: hasSession,
        walletAddress: hasSession ? sessionWallet : null,
      });
    } catch (error) {
      console.error("Auth status check error:", error);
      res.status(500).json({ error: "Status check failed" });
    }
  });

  app.post("/api/auth/logout", requireWallet, async (req, res) => {
    try {
      invalidateSession(req.walletAddress!);
      req.session.destroy((err) => {
        if (err) {
          console.error("Session destroy error:", err);
        }
        res.json({ success: true });
      });
    } catch (error) {
      console.error("Logout error:", error);
      res.status(500).json({ error: "Logout failed" });
    }
  });

  app.post("/api/auth/reveal-mnemonic", requireWallet, async (req, res) => {
    try {
      const { sessionId, nonce, signature } = req.body;
      if (!sessionId || !nonce || !signature) {
        return res.status(400).json({ error: "Session ID, nonce, and signature required" });
      }

      const signatureBytes = Uint8Array.from(
        typeof signature === 'string' ? bs58.decode(signature) : signature
      );

      const sigResult = await verifySignatureAndConsumeNonce(
        req.walletAddress!,
        nonce,
        'reveal_mnemonic',
        signatureBytes,
        verifySolanaSignature
      );

      if (!sigResult.success) {
        return res.status(401).json({ error: sigResult.error });
      }

      const result = await revealMnemonic(req.walletAddress!, sessionId);
      
      if (!result.success) {
        const status = 'retryAfterMs' in result && result.retryAfterMs ? 429 : 400;
        return res.status(status).json({
          error: result.error,
          retryAfterMs: 'retryAfterMs' in result ? result.retryAfterMs : undefined,
        });
      }
      
      res.json({
        mnemonic: result.mnemonic,
        expiresAt: result.expiresAt,
      });
    } catch (error) {
      console.error("Mnemonic reveal error:", error);
      res.status(500).json({ error: "Failed to reveal recovery phrase" });
    }
  });

  // Enable execution - allows headless trade execution via webhooks
  app.post("/api/auth/enable-execution", requireWallet, async (req, res) => {
    console.log(`[Enable Execution] Request received for wallet ${req.walletAddress?.slice(0, 8)}...`);
    try {
      const { sessionId, nonce, signature } = req.body;
      if (!sessionId || !nonce || !signature) {
        console.log(`[Enable Execution] Missing fields - sessionId: ${!!sessionId}, nonce: ${!!nonce}, signature: ${!!signature}`);
        return res.status(400).json({ error: "Missing required fields" });
      }

      const signatureBytes = typeof signature === 'string' 
        ? bs58.decode(signature) 
        : new Uint8Array(Object.values(signature));

      console.log(`[Enable Execution] Verifying signature for nonce: ${nonce.slice(0, 8)}...`);
      const sigResult = await verifySignatureAndConsumeNonce(
        req.walletAddress!,
        nonce,
        'enable_execution',
        signatureBytes,
        verifySolanaSignature
      );

      if (!sigResult.success) {
        console.log(`[Enable Execution] Signature verification failed: ${sigResult.error}`);
        return res.status(401).json({ error: sigResult.error });
      }

      console.log(`[Enable Execution] Signature verified, calling enableExecution with sessionId: ${sessionId.slice(0, 8)}...`);
      const result = await enableExecution(sessionId, req.walletAddress!);
      
      if (!result.success) {
        console.log(`[Enable Execution] enableExecution failed: ${result.error}`);
        return res.status(400).json({ error: result.error });
      }
      
      console.log(`[Enable Execution] Success for wallet ${req.walletAddress?.slice(0, 8)}...`);
      res.json({
        success: true,
        expiresAt: result.expiresAt,
      });
    } catch (error) {
      console.error("[Enable Execution] Error:", error);
      res.status(500).json({ error: "Failed to enable execution" });
    }
  });

  // Revoke execution - disables headless trade execution
  app.post("/api/auth/revoke-execution", requireWallet, async (req, res) => {
    try {
      const { sessionId, nonce, signature } = req.body;
      if (!sessionId || !nonce || !signature) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const signatureBytes = typeof signature === 'string' 
        ? bs58.decode(signature) 
        : new Uint8Array(Object.values(signature));

      const sigResult = await verifySignatureAndConsumeNonce(
        req.walletAddress!,
        nonce,
        'revoke_execution',
        signatureBytes,
        verifySolanaSignature
      );

      if (!sigResult.success) {
        return res.status(401).json({ error: sigResult.error });
      }

      const result = await revokeExecution(sessionId, req.walletAddress!);
      
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
      
      res.json({ success: true });
    } catch (error) {
      console.error("Revoke execution error:", error);
      res.status(500).json({ error: "Failed to revoke execution" });
    }
  });

  // Get execution status
  app.get("/api/auth/execution-status", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }

      const isExpired = wallet.executionExpiresAt && new Date() > wallet.executionExpiresAt;
      
      res.json({
        executionEnabled: wallet.executionEnabled && !isExpired,
        executionExpiresAt: wallet.executionExpiresAt,
        emergencyStopTriggered: wallet.emergencyStopTriggered,
        emergencyStopAt: wallet.emergencyStopAt,
      });
    } catch (error) {
      console.error("Execution status error:", error);
      res.status(500).json({ error: "Failed to get execution status" });
    }
  });

  setInterval(() => {
    cleanupExpiredNonces().catch(console.error);
  }, 60 * 1000);

  // Emergency admin stop - immediately disables all execution for a wallet
  // Requires ADMIN_SECRET environment variable for authorization
  app.post("/api/admin/emergency-stop", async (req, res) => {
    try {
      const adminSecret = process.env.ADMIN_SECRET;
      if (!adminSecret) {
        console.error("[Emergency Stop] ADMIN_SECRET not configured");
        return res.status(503).json({ error: "Admin operations not configured" });
      }

      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Admin authorization required" });
      }

      const providedSecret = authHeader.slice(7);
      if (providedSecret !== adminSecret) {
        console.warn("[Emergency Stop] Invalid admin secret attempted");
        return res.status(403).json({ error: "Invalid admin authorization" });
      }

      const { walletAddress } = req.body;
      if (!walletAddress) {
        return res.status(400).json({ error: "Wallet address required" });
      }

      const wallet = await storage.getWallet(walletAddress);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }

      // Use fixed admin ID for audit trail - adminId is not client-supplied to prevent spoofing
      const adminId = "platform_admin";
      const requestIp = req.ip || req.headers['x-forwarded-for'] || 'unknown';
      
      const result = await emergencyStopWallet(walletAddress, adminId);
      
      if (!result.success) {
        return res.status(500).json({ error: result.error });
      }

      console.log(`[Emergency Stop] Admin triggered emergency stop for wallet ${walletAddress.slice(0, 8)}... from IP: ${requestIp}`);
      
      res.json({ 
        success: true, 
        message: "Emergency stop activated. All execution disabled for this wallet." 
      });
    } catch (error) {
      console.error("Emergency stop error:", error);
      res.status(500).json({ error: "Failed to trigger emergency stop" });
    }
  });

  // Update policy HMAC for a bot (requires active session)
  app.post("/api/trading-bots/:id/update-policy-hmac", requireWallet, async (req, res) => {
    try {
      const { sessionId } = req.body;
      if (!sessionId) {
        return res.status(400).json({ error: "Active session required" });
      }

      const session = getSession(sessionId);
      if (!session || session.walletAddress !== req.walletAddress) {
        return res.status(401).json({ error: "Invalid or expired session" });
      }

      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const policyHmac = computeBotPolicyHmac(
        session.umk,
        { market: bot.market, leverage: bot.leverage || 1, maxPositionSize: bot.maxPositionSize }
      );

      await storage.updateTradingBot(bot.id, { policyHmac } as any);

      res.json({ success: true, policyHmac });
    } catch (error) {
      console.error("Update policy HMAC error:", error);
      res.status(500).json({ error: "Failed to update policy HMAC" });
    }
  });

  // Update policy HMAC for all user's bots (requires active session)
  app.post("/api/trading-bots/update-all-policy-hmacs", requireWallet, async (req, res) => {
    try {
      const { sessionId } = req.body;
      if (!sessionId) {
        return res.status(400).json({ error: "Active session required" });
      }

      const session = getSession(sessionId);
      if (!session || session.walletAddress !== req.walletAddress) {
        return res.status(401).json({ error: "Invalid or expired session" });
      }

      const bots = await storage.getTradingBots(req.walletAddress!);
      let updated = 0;

      for (const bot of bots) {
        const policyHmac = computeBotPolicyHmac(
          session.umk,
          { market: bot.market, leverage: bot.leverage || 1, maxPositionSize: bot.maxPositionSize }
        );
        await storage.updateTradingBot(bot.id, { policyHmac } as any);
        updated++;
      }

      res.json({ success: true, updatedCount: updated });
    } catch (error) {
      console.error("Update all policy HMACs error:", error);
      res.status(500).json({ error: "Failed to update policy HMACs" });
    }
  });

  // Wallet auth routes
  app.post("/api/wallet/connect", async (req, res) => {
    try {
      const { walletAddress, referredByCode } = req.body;
      if (!walletAddress) {
        return res.status(400).json({ error: "Wallet address required" });
      }

      const isNewWallet = !(await storage.getWallet(walletAddress));
      let wallet = await storage.getOrCreateWallet(walletAddress);
      
      // Agent wallet is now created in /api/auth/verify after security initialization
      // This ensures the mnemonic can be encrypted with the UMK

      // Generate user webhook secret if not already set
      if (!wallet.userWebhookSecret) {
        const userWebhookSecret = generateWebhookSecret();
        await storage.updateWalletWebhookSecret(walletAddress, userWebhookSecret);
        wallet = (await storage.getWallet(walletAddress))!;
        console.log(`[Webhook] Generated user webhook secret for ${walletAddress}`);
      }

      // Generate referral code if not already set
      if (!wallet.referralCode) {
        let referralCode = generateReferralCode();
        let attempts = 0;
        while (attempts < 10) {
          const existing = await storage.getWalletByReferralCode(referralCode);
          if (!existing) break;
          referralCode = generateReferralCode();
          attempts++;
        }
        await storage.updateWallet(walletAddress, { referralCode });
        wallet = (await storage.getWallet(walletAddress))!;
        console.log(`[Referral] Generated referral code for ${walletAddress}: ${referralCode}`);
      }

      // Track referral if this is a new wallet and referral code was provided
      if (isNewWallet && referredByCode && !wallet.referredBy) {
        const referrer = await storage.getWalletByReferralCode(referredByCode);
        if (referrer && referrer.address !== walletAddress) {
          await storage.updateWallet(walletAddress, { referredBy: referrer.address });
          wallet = (await storage.getWallet(walletAddress))!;
          console.log(`[Referral] ${walletAddress} was referred by ${referrer.address} (code: ${referredByCode})`);
        }
      }
      
      req.session.walletAddress = walletAddress;

      res.json({
        address: wallet.address,
        displayName: wallet.displayName,
        driftSubaccount: wallet.driftSubaccount,
        agentPublicKey: wallet.agentPublicKey,
        referralCode: wallet.referralCode,
      });
    } catch (error) {
      console.error("Wallet connect error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/wallet/me", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      res.json(wallet);
    } catch (error) {
      console.error("Get wallet error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/wallet/settings", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      res.json({
        displayName: wallet.displayName,
        xUsername: wallet.xUsername,
        defaultLeverage: wallet.defaultLeverage,
        slippageBps: wallet.slippageBps,
        notificationsEnabled: wallet.notificationsEnabled ?? false,
        notifyTradeExecuted: wallet.notifyTradeExecuted ?? true,
        notifyTradeFailed: wallet.notifyTradeFailed ?? true,
        notifyPositionClosed: wallet.notifyPositionClosed ?? true,
        telegramConnected: wallet.telegramConnected ?? false,
        referralCode: wallet.referralCode,
        referredBy: wallet.referredBy,
      });
    } catch (error) {
      console.error("Get wallet settings error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.put("/api/wallet/settings", requireWallet, async (req, res) => {
    try {
      const { displayName, xUsername, defaultLeverage, slippageBps, notificationsEnabled, notifyTradeExecuted, notifyTradeFailed, notifyPositionClosed } = req.body;
      
      const updates: any = {};
      if (displayName !== undefined) updates.displayName = displayName;
      if (xUsername !== undefined) updates.xUsername = xUsername;
      if (defaultLeverage !== undefined) {
        const leverage = parseInt(defaultLeverage);
        if (isNaN(leverage) || leverage < 1 || leverage > 20) {
          return res.status(400).json({ error: "Invalid leverage (must be 1-20)" });
        }
        updates.defaultLeverage = leverage;
      }
      if (slippageBps !== undefined) {
        const slippage = parseInt(slippageBps);
        if (isNaN(slippage) || slippage < 1 || slippage > 500) {
          return res.status(400).json({ error: "Invalid slippage (must be 1-500 bps)" });
        }
        updates.slippageBps = slippage;
      }
      if (notificationsEnabled !== undefined) updates.notificationsEnabled = !!notificationsEnabled;
      if (notifyTradeExecuted !== undefined) updates.notifyTradeExecuted = !!notifyTradeExecuted;
      if (notifyTradeFailed !== undefined) updates.notifyTradeFailed = !!notifyTradeFailed;
      if (notifyPositionClosed !== undefined) updates.notifyPositionClosed = !!notifyPositionClosed;

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No valid updates provided" });
      }

      const wallet = await storage.updateWallet(req.walletAddress!, updates);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      res.json({
        displayName: wallet.displayName,
        xUsername: wallet.xUsername,
        defaultLeverage: wallet.defaultLeverage,
        slippageBps: wallet.slippageBps,
        notificationsEnabled: wallet.notificationsEnabled ?? false,
        notifyTradeExecuted: wallet.notifyTradeExecuted ?? true,
        notifyTradeFailed: wallet.notifyTradeFailed ?? true,
        notifyPositionClosed: wallet.notifyPositionClosed ?? true,
        telegramConnected: wallet.telegramConnected ?? false,
      });
    } catch (error) {
      console.error("Update wallet settings error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Reset Drift Account - Fully automated: closes positions, sweeps funds, deletes subaccounts
  app.post("/api/wallet/reset-drift-account", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey || !wallet.agentPrivateKeyEncrypted) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const agentKey = wallet.agentPrivateKeyEncrypted;
      const agentPubKey = wallet.agentPublicKey;
      const log = (msg: string) => console.log(`[Reset Drift] ${msg}`);
      const progress: string[] = [];

      log(`Starting automated Drift account reset for ${agentPubKey}`);
      progress.push("Starting reset process...");

      // 1. Discover all existing subaccounts on-chain
      const existingSubaccounts = await discoverOnChainSubaccounts(agentPubKey);
      if (existingSubaccounts.length === 0) {
        return res.json({ 
          success: true, 
          message: "No Drift accounts found",
          progress: ["No Drift accounts to reset"]
        });
      }

      log(`Found ${existingSubaccounts.length} subaccounts: [${existingSubaccounts.join(', ')}]`);
      progress.push(`Found ${existingSubaccounts.length} subaccount(s)`);

      // Sort: process higher subaccounts first, subaccount 0 last
      const sortedSubaccounts = [...existingSubaccounts].sort((a, b) => b - a);
      const deletedSubaccounts: number[] = [];
      const errors: string[] = [];
      let totalSwept = 0;

      // 2. For each subaccount: close positions, sweep funds to subaccount 0
      for (const subId of sortedSubaccounts) {
        if (subId === 0) continue; // Handle subaccount 0 separately at the end

        log(`Processing subaccount ${subId}...`);
        
        try {
          // 2a. Close all open positions in this subaccount
          const positions = await getPerpPositions(agentPubKey, subId);
          const openPositions = positions.filter(p => Math.abs(p.baseAssetAmount) > 0.0001);
          
          if (openPositions.length > 0) {
            log(`Closing ${openPositions.length} position(s) in subaccount ${subId}`);
            progress.push(`Closing ${openPositions.length} position(s) in bot subaccount ${subId}...`);
            
            for (const pos of openPositions) {
              try {
                const closeResult = await closePerpPosition(agentKey, pos.market, subId);
                if (closeResult.success) {
                  log(`Closed ${pos.market} position in subaccount ${subId}: ${closeResult.signature}`);
                } else {
                  log(`Failed to close ${pos.market}: ${closeResult.error}`);
                  errors.push(`Failed to close ${pos.market} in subaccount ${subId}: ${closeResult.error}`);
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
              } catch (e: any) {
                log(`Error closing ${pos.market}: ${e.message}`);
                errors.push(`Error closing ${pos.market} in subaccount ${subId}: ${e.message}`);
              }
            }
            
            // Wait for positions to settle
            await new Promise(resolve => setTimeout(resolve, 3000));
          }

          // 2b. Settle any unrealized PnL to make it sweepable
          log(`Settling PnL for subaccount ${subId}...`);
          try {
            const settleResult = await settleAllPnl(agentKey, subId);
            if (settleResult.success) {
              log(`Settled PnL for subaccount ${subId}`);
            } else {
              log(`No PnL to settle for subaccount ${subId}: ${settleResult.error || 'none'}`);
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
          } catch (settleErr: any) {
            log(`PnL settlement error (non-fatal): ${settleErr.message}`);
          }

          // 2c. Get balance and sweep to subaccount 0
          const accountInfo = await getDriftAccountInfo(agentPubKey, subId);
          const balance = accountInfo.usdcBalance;
          
          if (balance > 0.001) {
            log(`Sweeping $${balance.toFixed(2)} from subaccount ${subId} to main account`);
            progress.push(`Sweeping $${balance.toFixed(2)} from subaccount ${subId}...`);
            
            try {
              const transferResult = await executeAgentTransferBetweenSubaccounts(agentPubKey, agentKey, subId, 0, balance);
              if (transferResult.success) {
                totalSwept += balance;
                log(`Swept $${balance.toFixed(2)} to subaccount 0: ${transferResult.signature}`);
              } else {
                log(`Failed to sweep from subaccount ${subId}: ${transferResult.error}`);
                errors.push(`Failed to sweep from subaccount ${subId}: ${transferResult.error}`);
              }
              await new Promise(resolve => setTimeout(resolve, 1500));
            } catch (e: any) {
              log(`Error sweeping from subaccount ${subId}: ${e.message}`);
              errors.push(`Error sweeping from subaccount ${subId}: ${e.message}`);
            }
          }

          // 2d. Verify subaccount is empty before deletion
          const verifyInfo = await getDriftAccountInfo(agentPubKey, subId);
          if (verifyInfo.hasOpenPositions || verifyInfo.usdcBalance > 0.001 || verifyInfo.totalCollateral > 0.001) {
            log(`Subaccount ${subId} still has funds or positions, skipping deletion`);
            errors.push(`Subaccount ${subId} still has funds ($${verifyInfo.usdcBalance.toFixed(2)}) or positions - cannot delete`);
            continue; // Skip deletion, move to next subaccount
          }

          // 2e. Delete the subaccount (only if verified empty)
          log(`Deleting subaccount ${subId}...`);
          const deleteResult = await closeDriftSubaccount(agentKey, subId);
          if (deleteResult.success) {
            deletedSubaccounts.push(subId);
            log(`Deleted subaccount ${subId}: ${deleteResult.signature}`);
            progress.push(`Deleted subaccount ${subId}`);
          } else {
            log(`Failed to delete subaccount ${subId}: ${deleteResult.error}`);
            errors.push(`Failed to delete subaccount ${subId}: ${deleteResult.error}`);
          }
          await new Promise(resolve => setTimeout(resolve, 1500));
          
        } catch (e: any) {
          log(`Error processing subaccount ${subId}: ${e.message}`);
          errors.push(`Error processing subaccount ${subId}: ${e.message}`);
        }
      }

      // 3. Handle subaccount 0 (main account)
      if (existingSubaccounts.includes(0)) {
        log(`Processing main account (subaccount 0)...`);
        
        try {
          // 3a. Close any positions in subaccount 0
          const positions = await getPerpPositions(agentPubKey, 0);
          const openPositions = positions.filter(p => Math.abs(p.baseAssetAmount) > 0.0001);
          
          if (openPositions.length > 0) {
            log(`Closing ${openPositions.length} position(s) in main account`);
            progress.push(`Closing ${openPositions.length} position(s) in main account...`);
            
            for (const pos of openPositions) {
              try {
                const closeResult = await closePerpPosition(agentKey, pos.market, 0);
                if (closeResult.success) {
                  log(`Closed ${pos.market} in main account: ${closeResult.signature}`);
                } else {
                  errors.push(`Failed to close ${pos.market} in main account: ${closeResult.error}`);
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
              } catch (e: any) {
                errors.push(`Error closing ${pos.market} in main account: ${e.message}`);
              }
            }
            await new Promise(resolve => setTimeout(resolve, 3000));
          }

          // 3b. Settle any unrealized PnL for main account
          log(`Settling PnL for main account...`);
          try {
            const settleResult = await settleAllPnl(agentKey, 0);
            if (settleResult.success) {
              log(`Settled PnL for main account`);
            } else {
              log(`No PnL to settle for main account: ${settleResult.error || 'none'}`);
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
          } catch (settleErr: any) {
            log(`PnL settlement error (non-fatal): ${settleErr.message}`);
          }

          // 3c. Withdraw all funds from Drift to agent wallet
          const accountInfo = await getDriftAccountInfo(agentPubKey, 0);
          const balance = accountInfo.usdcBalance;
          
          if (balance > 0.001) {
            log(`Withdrawing $${balance.toFixed(2)} from Drift to agent wallet`);
            progress.push(`Withdrawing $${balance.toFixed(2)} to agent wallet...`);
            
            try {
              const withdrawResult = await executeAgentDriftWithdraw(agentPubKey, agentKey, balance, 0);
              if (withdrawResult.success) {
                log(`Withdrawn $${balance.toFixed(2)}: ${withdrawResult.signature}`);
              } else {
                log(`Failed to withdraw: ${withdrawResult.error}`);
                errors.push(`Failed to withdraw from Drift: ${withdrawResult.error}`);
              }
              await new Promise(resolve => setTimeout(resolve, 2000));
            } catch (e: any) {
              log(`Error withdrawing: ${e.message}`);
              errors.push(`Error withdrawing from Drift: ${e.message}`);
            }
          }

          // 3d. Note: Main account (subaccount 0) cannot be deleted because it was created with a referral code.
          // Drift protocol prevents deletion of referred accounts. The ~0.035 SOL rent is forfeited,
          // but the account can be reused for future trading without needing to recreate it.
          log(`Main account (subaccount 0) kept active - referred accounts cannot be deleted by Drift protocol rules`);
          progress.push(`Main Drift account preserved (can be reused for trading)`);
          
        } catch (e: any) {
          log(`Error processing main account: ${e.message}`);
          errors.push(`Error processing main account: ${e.message}`);
        }
      }

      // 4. Check results and determine response
      if (errors.length > 0 && deletedSubaccounts.length === 0) {
        progress.push("Reset failed - see errors for details");
        return res.status(400).json({
          success: false,
          message: "Reset failed - could not delete any accounts. Your funds are safe, please try again or close positions manually.",
          progress,
          errors
        });
      }

      if (errors.length > 0) {
        // Partial success - only clear assignments for bots whose subaccounts were actually deleted
        const bots = await storage.getTradingBots(req.walletAddress!);
        for (const bot of bots) {
          if (bot.driftSubaccountId !== null && deletedSubaccounts.includes(bot.driftSubaccountId)) {
            await storage.clearTradingBotSubaccount(bot.id);
            log(`Cleared driftSubaccountId for bot ${bot.id} (subaccount ${bot.driftSubaccountId} was deleted)`);
          }
        }
        
        progress.push(`Partially completed with ${errors.length} issue(s)`);
        return res.status(207).json({
          success: false,
          partialSuccess: true,
          message: `Partial reset: Deleted ${deletedSubaccounts.length} subaccount(s) but some operations failed. Check the errors and try again if needed.`,
          progress,
          deletedSubaccounts,
          totalSwept,
          errors
        });
      }

      // Full success - clear all bot subaccount assignments
      const bots = await storage.getTradingBots(req.walletAddress!);
      for (const bot of bots) {
        if (bot.driftSubaccountId !== null) {
          await storage.clearTradingBotSubaccount(bot.id);
          log(`Cleared driftSubaccountId for bot ${bot.id}`);
        }
      }

      progress.push("Reset complete!");
      log(`Successfully reset Drift account. Deleted ${deletedSubaccounts.length} subaccounts, swept $${totalSwept.toFixed(2)}`);
      
      res.json({
        success: true,
        message: `Successfully reset Drift account. Deleted ${deletedSubaccounts.length} subaccount(s).`,
        progress,
        deletedSubaccounts,
        totalSwept
      });

    } catch (error: any) {
      console.error("Reset Drift account error:", error);
      res.status(500).json({ error: error.message || "Failed to reset Drift account" });
    }
  });

  // Reset Agent Wallet - Withdraw all funds to user wallet and generate a new agent wallet
  app.post("/api/wallet/reset-agent-wallet", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey || !wallet.agentPrivateKeyEncrypted) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const { sessionId } = req.body;
      if (!sessionId) {
        return res.status(400).json({ error: "Session ID required for security verification" });
      }

      const session = getSession(sessionId);
      if (!session || session.walletAddress !== req.walletAddress) {
        return res.status(401).json({ error: "Invalid or expired session" });
      }
      if (!session.umk) {
        return res.status(401).json({ error: "Security session not initialized. Please reconnect your wallet." });
      }

      const agentPubKey = wallet.agentPublicKey;
      const agentKey = wallet.agentPrivateKeyEncrypted;
      const userWallet = req.walletAddress!;
      const log = (msg: string) => console.log(`[Reset Agent] ${msg}`);
      const progress: string[] = [];

      log(`Starting agent wallet reset for ${agentPubKey.slice(0, 8)}...`);
      progress.push("Checking Drift account status...");

      // Step 1: Check if there are any Drift subaccounts with positions or funds
      const existingSubaccounts = await discoverOnChainSubaccounts(agentPubKey);
      
      for (const subId of existingSubaccounts) {
        const positions = await getPerpPositions(agentPubKey, subId);
        const openPositions = positions.filter(p => Math.abs(p.baseAssetAmount) > 0.0001);
        
        if (openPositions.length > 0) {
          return res.status(400).json({ 
            error: "Cannot reset: You have open positions on Drift. Please close all positions first using 'Close All Positions' or 'Reset Drift Account'.",
            hasOpenPositions: true 
          });
        }

        const accountInfo = await getDriftAccountInfo(agentPubKey, subId);
        if (accountInfo.usdcBalance > 0.01) {
          return res.status(400).json({ 
            error: `Cannot reset: You have $${accountInfo.usdcBalance.toFixed(2)} in Drift subaccount ${subId}. Please use 'Reset Drift Account' to withdraw funds first.`,
            hasDriftFunds: true 
          });
        }
      }

      progress.push("Drift account verified clean");
      log("Drift account is clean, proceeding with agent wallet reset");

      // Step 2: Check agent wallet balances
      const usdcBalance = await getAgentUsdcBalance(agentPubKey);
      const solBalance = await getAgentSolBalance(agentPubKey);
      
      log(`Agent wallet balances: ${usdcBalance} USDC, ${solBalance} SOL`);
      progress.push(`Found ${usdcBalance.toFixed(2)} USDC, ${solBalance.toFixed(4)} SOL in agent wallet`);

      // Step 3: Withdraw USDC to user wallet
      if (usdcBalance > 0.001) {
        progress.push(`Withdrawing ${usdcBalance.toFixed(2)} USDC to your wallet...`);
        log(`Withdrawing ${usdcBalance} USDC to ${userWallet.slice(0, 8)}...`);
        
        try {
          const usdcWithdrawResult = await executeAgentWithdraw(agentPubKey, agentKey, userWallet, usdcBalance);
          if (!usdcWithdrawResult.success) {
            return res.status(400).json({ 
              error: `USDC withdrawal failed: ${usdcWithdrawResult.error}. Your funds are safe, please try again.`,
              step: 'usdc_withdrawal' 
            });
          }
          log(`USDC withdrawal successful: ${usdcWithdrawResult.signature}`);
          progress.push(`USDC withdrawn successfully`);
          
          // Wait for confirmation
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (e: any) {
          return res.status(400).json({ 
            error: `USDC withdrawal error: ${e.message}. Your funds are safe, please try again.`,
            step: 'usdc_withdrawal' 
          });
        }
      }

      // Step 4: Withdraw SOL to user wallet (leave minimum for rent-exempt)
      const solToWithdraw = solBalance - 0.002; // Leave 0.002 SOL for final transaction fees
      if (solToWithdraw > 0.001) {
        progress.push(`Withdrawing ${solToWithdraw.toFixed(4)} SOL to your wallet...`);
        log(`Withdrawing ${solToWithdraw} SOL to ${userWallet.slice(0, 8)}...`);
        
        try {
          const solWithdrawResult = await executeAgentSolWithdraw(agentPubKey, agentKey, userWallet, solToWithdraw);
          if (!solWithdrawResult.success) {
            log(`SOL withdrawal failed (non-critical): ${solWithdrawResult.error}`);
            progress.push(`SOL withdrawal failed (non-critical): Small amount may remain`);
          } else {
            log(`SOL withdrawal successful: ${solWithdrawResult.signature}`);
            progress.push(`SOL withdrawn successfully`);
          }
          
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (e: any) {
          log(`SOL withdrawal error (non-critical): ${e.message}`);
          progress.push(`SOL withdrawal error (non-critical): Small amount may remain`);
        }
      }

      // Step 5: Generate new agent wallet with mnemonic
      progress.push("Generating new agent wallet...");
      log("Generating new agent wallet with mnemonic");

      const generatedWallet = generateAgentWalletWithMnemonic();
      const newAgentPublicKey = generatedWallet.keypair.publicKey.toString();
      
      // Encrypt private key with legacy method for backward compatibility
      const privateKeyBase58 = bs58.encode(generatedWallet.secretKeyBuffer);
      const encryptedPrivateKey = legacyEncrypt(privateKeyBase58);
      
      // Encrypt with v3 encryption (UMK-based)
      const encryptedV3 = encryptAgentKeyV3(session.umk, generatedWallet.secretKeyBuffer, userWallet);
      
      // Store mnemonic encrypted with UMK
      await encryptAndStoreMnemonic(userWallet, generatedWallet.mnemonicBuffer, session.umk);
      
      // Update database with new agent wallet
      await storage.updateWalletAgentKeys(userWallet, newAgentPublicKey, encryptedPrivateKey);
      await storage.updateWalletAgentKeyV3(userWallet, encryptedV3);
      
      log(`New agent wallet generated: ${newAgentPublicKey.slice(0, 8)}...`);
      progress.push(`New agent wallet created: ${newAgentPublicKey.slice(0, 8)}...`);

      // Step 6: Clear all bot subaccount assignments (they're linked to old wallet)
      const bots = await storage.getTradingBots(userWallet);
      for (const bot of bots) {
        if (bot.driftSubaccountId !== null) {
          await storage.clearTradingBotSubaccount(bot.id);
          log(`Cleared driftSubaccountId for bot ${bot.id}`);
        }
      }

      progress.push("Agent wallet reset complete!");
      log(`Successfully reset agent wallet. Old: ${agentPubKey.slice(0, 8)}..., New: ${newAgentPublicKey.slice(0, 8)}...`);

      res.json({
        success: true,
        message: "Agent wallet has been reset. A new wallet has been generated.",
        oldAgentWallet: agentPubKey,
        newAgentWallet: newAgentPublicKey,
        progress,
        withdrawnUsdc: usdcBalance,
        withdrawnSol: solToWithdraw > 0.001 ? solToWithdraw : 0
      });

    } catch (error: any) {
      console.error("Reset agent wallet error:", error);
      res.status(500).json({ error: error.message || "Failed to reset agent wallet" });
    }
  });

  app.post("/api/close-all-positions", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey || !wallet.agentPrivateKeyEncrypted) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const bots = await storage.getTradingBots(req.walletAddress!);
      const activeBots = bots.filter(b => b.isActive);

      const results: Array<{
        botId: string;
        botName: string;
        market: string;
        success: boolean;
        closed?: { side: string; size: number };
        error?: string;
      }> = [];

      for (const bot of activeBots) {
        const subAccountId = bot.driftSubaccountId ?? 0;
        
        try {
          const onChainPositions = await getPerpPositions(wallet.agentPublicKey, subAccountId);
          const position = onChainPositions.find(p => p.market === bot.market);
          
          if (!position || Math.abs(position.baseAssetAmount) < 0.0001) {
            continue;
          }

          const closeAllSlippageBps = wallet.slippageBps ?? 50;
          const result = await closePerpPosition(
            wallet.agentPrivateKeyEncrypted,
            bot.market,
            subAccountId,
            undefined,
            closeAllSlippageBps
          );

          if (result.success) {
            results.push({
              botId: bot.id,
              botName: bot.name,
              market: bot.market,
              success: true,
              closed: { side: position.side, size: Math.abs(position.baseAssetAmount) },
            });
          } else {
            results.push({
              botId: bot.id,
              botName: bot.name,
              market: bot.market,
              success: false,
              error: result.error || "Unknown error",
            });
          }
        } catch (error: any) {
          results.push({
            botId: bot.id,
            botName: bot.name,
            market: bot.market,
            success: false,
            error: error.message || "Unknown error",
          });
        }
      }

      res.json({
        success: true,
        totalBotsChecked: activeBots.length,
        positionsClosed: results.filter(r => r.success).length,
        results,
      });
    } catch (error) {
      console.error("Close all positions error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/wallet/capital", requireWallet, async (req, res) => {
    try {
      const walletAddress = req.walletAddress!;
      
      // Get agent wallet - Drift accounts are created from agent wallet, not user wallet
      const wallet = await storage.getWallet(walletAddress);
      const agentAddress = wallet?.agentPublicKey;
      
      const mainAccountBalance = agentAddress ? await getDriftBalance(agentAddress, 0) : 0;
      
      const bots = await storage.getTradingBots(walletAddress);
      
      const botAllocations: Array<{
        botId: string;
        botName: string;
        subaccountId: number;
        balance: number;
      }> = [];
      
      let allocatedToBot = 0;
      let hasLegacyBots = false;
      
      for (const bot of bots) {
        if (bot.driftSubaccountId === null || bot.driftSubaccountId === undefined) {
          hasLegacyBots = true;
          continue;
        }
        
        const balance = agentAddress ? await getDriftBalance(agentAddress, bot.driftSubaccountId) : 0;
        
        // Only add to allocatedToBot if not subaccount 0 (already counted in mainAccountBalance)
        if (bot.driftSubaccountId !== 0) {
          allocatedToBot += balance;
        }
        
        botAllocations.push({
          botId: bot.id,
          botName: bot.name,
          subaccountId: bot.driftSubaccountId,
          balance,
        });
      }
      
      // Total equity = main account (subaccount 0) + allocated to other bot subaccounts
      const totalEquity = mainAccountBalance + allocatedToBot;
      
      res.json({
        mainAccountBalance,
        allocatedToBot,
        totalEquity,
        botAllocations,
        ...(hasLegacyBots && { warning: "Some legacy bots without subaccounts exist and are not included in the capital breakdown" }),
      });
    } catch (error) {
      console.error("Get capital pool error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Agent wallet routes
  app.get("/api/agent/balance", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const [balance, solBalance, bots, driftAccountExists] = await Promise.all([
        getAgentUsdcBalance(wallet.agentPublicKey),
        getAgentSolBalance(wallet.agentPublicKey),
        storage.getTradingBots(req.walletAddress!),
        subaccountExists(wallet.agentPublicKey, 0),
      ]);
      
      // Existing user = has at least one bot (they've completed onboarding before)
      const isExistingUser = bots.length > 0;
      
      // SOL requirements for bot creation:
      // - 0.035 SOL per subaccount rent
      // - 0.005 SOL for trading gas
      // If no Drift account exists: need 2x rent (subaccount 0 + bot subaccount) = 0.075 SOL
      // If Drift account exists: need 1x rent (just bot subaccount) = 0.04 SOL
      const SUBACCOUNT_RENT = 0.035;
      const TRADING_GAS = 0.005;
      const requiredSolForBot = driftAccountExists 
        ? SUBACCOUNT_RENT + TRADING_GAS  // 0.04 SOL
        : (SUBACCOUNT_RENT * 2) + TRADING_GAS; // 0.075 SOL
      
      const solDeficit = Math.max(0, requiredSolForBot - solBalance);
      const canCreateBot = solBalance >= requiredSolForBot;
      
      res.json({
        agentPublicKey: wallet.agentPublicKey,
        balance,
        solBalance,
        isExistingUser,
        driftAccountExists,
        botCreationSolRequirement: {
          required: requiredSolForBot,
          current: solBalance,
          deficit: solDeficit,
          canCreate: canCreateBot,
        },
      });
    } catch (error) {
      console.error("Get agent balance error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agent/deposit-sol", requireWallet, async (req, res) => {
    try {
      const { amount } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }

      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const txData = await buildSolTransferToAgentTransaction(
        req.walletAddress!,
        wallet.agentPublicKey,
        amount
      );

      res.json(txData);
    } catch (error) {
      console.error("Build SOL deposit error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agent/deposit", requireWallet, async (req, res) => {
    try {
      const { amount } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }

      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const txData = await buildTransferToAgentTransaction(
        req.walletAddress!,
        wallet.agentPublicKey,
        amount
      );

      res.json(txData);
    } catch (error) {
      console.error("Build agent deposit error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agent/withdraw", requireWallet, async (req, res) => {
    try {
      const { amount } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }

      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey || !wallet.agentPrivateKeyEncrypted) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const txData = await buildWithdrawFromAgentTransaction(
        req.walletAddress!,
        wallet.agentPublicKey,
        wallet.agentPrivateKeyEncrypted,
        amount
      );

      res.json(txData);
    } catch (error) {
      console.error("Build agent withdraw error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agent/drift-deposit", requireWallet, async (req, res) => {
    try {
      const { amount, botId } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }

      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey || !wallet.agentPrivateKeyEncrypted) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      // If botId provided, verify ownership and get subaccount
      let tradingBotId: string | null = null;
      let subAccountId = 0;
      if (botId) {
        const bot = await storage.getTradingBotById(botId);
        if (!bot || bot.walletAddress !== req.walletAddress) {
          return res.status(403).json({ error: "Bot not found or not owned" });
        }
        tradingBotId = botId;
        subAccountId = bot.driftSubaccountId ?? 0;
        console.log(`[Drift Deposit] Bot ${bot.name} (${botId}) has driftSubaccountId=${bot.driftSubaccountId}, using subAccountId=${subAccountId}`);
      } else {
        console.log(`[Drift Deposit] No botId provided, depositing to main account (subaccount 0)`);
      }

      // Security v3: Get UMK and decrypt agent key (same path as webhooks)
      const umkResult = await getUmkForWebhook(req.walletAddress!);
      if (!umkResult) {
        return res.status(403).json({ 
          error: "Execution not enabled. Please enable execution authorization in Settings first." 
        });
      }
      
      const agentKeyResult = await decryptAgentKeyWithFallback(
        req.walletAddress!,
        umkResult.umk,
        wallet
      );
      
      umkResult.cleanup();
      
      if (!agentKeyResult) {
        return res.status(500).json({ error: "Agent key decryption failed. Please reconfigure your agent wallet." });
      }
      
      // CRITICAL: Copy secret key bytes immediately to prevent buffer zeroization issues
      // The cleanup() function will zero the original buffer, so we must copy before any async operations
      const secretKeyCopy = Buffer.from(agentKeyResult.secretKey);
      
      // DEBUG: Check if secretKey has valid data
      const nonZeroBytes = secretKeyCopy.filter(b => b !== 0).length;
      console.log(`[Drift Deposit] Secret key stats: length=${secretKeyCopy.length}, nonZeroBytes=${nonZeroBytes}`);
      
      if (nonZeroBytes === 0) {
        console.error(`[Drift Deposit] CRITICAL: Decrypted key is all zeros! This indicates a decryption failure.`);
        agentKeyResult.cleanup();
        return res.status(500).json({ 
          error: "Decryption failed - key data is corrupted. Please reconfigure your agent wallet in Settings." 
        });
      }
      
      const privateKeyBase58 = bs58.encode(secretKeyCopy);
      console.log(`[Drift Deposit] Base58 key length: ${privateKeyBase58.length} chars`);
      
      // Validate the decrypted key matches stored agentPublicKey before sending to executor
      // This catches key mismatches early with clear error messages
      const decryptedKeypair = nacl.sign.keyPair.fromSecretKey(secretKeyCopy);
      const derivedPubkey = bs58.encode(decryptedKeypair.publicKey);
      
      if (derivedPubkey !== wallet.agentPublicKey) {
        console.error(`[Drift Deposit] CRITICAL: Keypair mismatch detected!`);
        console.error(`  Stored agentPublicKey: ${wallet.agentPublicKey}`);
        console.error(`  Derived from decrypted key: ${derivedPubkey}`);
        console.error(`  Wallet has v3 key: ${!!wallet.agentPrivateKeyEncryptedV3}`);
        console.error(`  Wallet has legacy key: ${!!wallet.agentPrivateKeyEncrypted}`);
        agentKeyResult.cleanup();
        return res.status(500).json({ 
          error: "Agent key mismatch detected. Your agent wallet security may be corrupted. Please reconfigure your agent wallet in Settings." 
        });
      }
      
      console.log(`[Drift Deposit] Key validation passed. Executing deposit: amount=${amount}, subAccountId=${subAccountId} (v3 security)`);
      
      const result = await executeAgentDriftDeposit(
        wallet.agentPublicKey,
        privateKeyBase58,
        amount,
        subAccountId,
        true // isPreDecrypted
      );
      
      agentKeyResult.cleanup();

      if (!result.success) {
        return res.status(400).json({ error: result.error || "Deposit failed" });
      }

      await storage.createEquityEvent({
        walletAddress: req.walletAddress!,
        tradingBotId,
        eventType: 'drift_deposit',
        amount: String(amount),
        txSignature: result.signature || null,
        notes: tradingBotId ? `Deposit to bot` : 'Deposit to Drift Protocol',
      });

      res.json(result);
    } catch (error) {
      console.error("Agent drift deposit error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agent/drift-withdraw", requireWallet, async (req, res) => {
    try {
      const { amount, botId } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }

      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey || !wallet.agentPrivateKeyEncrypted) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      // If botId provided, verify ownership and get subaccount
      let tradingBotId: string | null = null;
      let subAccountId = 0; // Default to main account
      if (botId) {
        const bot = await storage.getTradingBotById(botId);
        if (!bot || bot.walletAddress !== req.walletAddress) {
          return res.status(403).json({ error: "Bot not found or not owned" });
        }
        tradingBotId = botId;
        // Use bot's specific subaccount, not the main account
        if (bot.driftSubaccountId !== null && bot.driftSubaccountId !== undefined) {
          subAccountId = bot.driftSubaccountId;
        }
        
        // Check for pending profit share IOUs before allowing withdrawal
        const pendingIOUs = await storage.getPendingProfitSharesBySubscriberBot(botId);
        if (pendingIOUs.length > 0) {
          const totalOwed = pendingIOUs.reduce((sum, iou) => sum + parseFloat(iou.amount), 0);
          console.log(`[Drift Withdraw] Bot ${botId} has ${pendingIOUs.length} pending IOUs totaling $${totalOwed.toFixed(4)}`);
          
          // Try to pay IOUs first
          let allPaid = true;
          for (const iou of pendingIOUs) {
            const iouAmount = parseFloat(iou.amount);
            const transferResult = await transferUsdcToWallet(
              wallet.agentPublicKey,
              wallet.agentPrivateKeyEncrypted,
              iou.creatorWalletAddress,
              iouAmount
            );
            
            if (transferResult.success) {
              await storage.updatePendingProfitShareStatus(iou.id, { status: 'paid', lastAttemptAt: new Date() });
              console.log(`[Drift Withdraw] Paid IOU ${iou.id}: $${iouAmount.toFixed(4)} to ${iou.creatorWalletAddress}`);
            } else {
              allPaid = false;
              console.error(`[Drift Withdraw] Failed to pay IOU ${iou.id}: ${transferResult.error}`);
              // Check if it's SOL starvation
              if (transferResult.error?.includes('Insufficient SOL')) {
                return res.status(400).json({
                  error: `Cannot withdraw - pending creator profit share of $${totalOwed.toFixed(2)} cannot be paid. Agent wallet needs more SOL for transaction fees (current: ${transferResult.solBalance?.toFixed(4) || '0'} SOL)`,
                  pendingIOUs: pendingIOUs.length,
                  totalOwed
                });
              }
              break;
            }
          }
          
          if (!allPaid) {
            return res.status(400).json({
              error: `Cannot withdraw - you have $${totalOwed.toFixed(2)} in pending profit share payments to signal creators. Please ensure your agent wallet has enough USDC to cover these payments.`,
              pendingIOUs: pendingIOUs.length,
              totalOwed
            });
          }
        }
      }

      const result = await executeAgentDriftWithdraw(
        wallet.agentPublicKey,
        wallet.agentPrivateKeyEncrypted,
        amount,
        subAccountId
      );

      if (!result.success) {
        return res.status(400).json({ error: result.error || "Withdraw failed" });
      }

      await storage.createEquityEvent({
        walletAddress: req.walletAddress!,
        tradingBotId,
        eventType: 'drift_withdraw',
        amount: String(-amount),
        txSignature: result.signature || null,
        notes: tradingBotId ? `Withdraw from bot` : 'Withdraw from Drift Protocol',
      });

      res.json(result);
    } catch (error) {
      console.error("Agent drift withdraw error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/agent/drift-balance", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const accountInfo = await getDriftAccountInfo(wallet.agentPublicKey, 0);
      res.json({ 
        balance: accountInfo.usdcBalance,
        freeCollateral: accountInfo.freeCollateral,
        hasOpenPositions: accountInfo.hasOpenPositions,
        marginUsed: accountInfo.marginUsed,
      });
    } catch (error) {
      console.error("Get agent drift balance error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/positions", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet || !wallet.agentPublicKey) {
        return res.json({ positions: [] });
      }

      // Use database positions (tracked from actual trade executions with real fill prices)
      const botPositions = await storage.getBotPositions(req.walletAddress!);
      const bots = await storage.getTradingBots(req.walletAddress!);
      const botMap = new Map(bots.map(b => [b.id, b]));
      
      let prices: Record<string, number> = {};
      try {
        prices = await getAllPrices();
      } catch (e) {
        console.log('[Positions] Failed to fetch prices');
      }

      const positions: any[] = [];

      for (const pos of botPositions) {
        const baseSize = parseFloat(pos.baseSize);
        if (Math.abs(baseSize) < 0.0001) continue;

        const bot = botMap.get(pos.tradingBotId);
        if (!bot) continue;

        const side = baseSize > 0 ? 'LONG' : 'SHORT';
        const markPrice = prices[pos.market] || 0;
        const entryPrice = parseFloat(pos.avgEntryPrice);
        const sizeUsd = Math.abs(baseSize) * markPrice;
        const realizedPnl = parseFloat(pos.realizedPnl);
        const totalFees = parseFloat(pos.totalFees || "0");
        
        const unrealizedPnl = side === 'LONG'
          ? (markPrice - entryPrice) * Math.abs(baseSize)
          : (entryPrice - markPrice) * Math.abs(baseSize);
        
        const unrealizedPnlPercent = Math.abs(entryPrice * Math.abs(baseSize)) > 0
          ? (unrealizedPnl / (entryPrice * Math.abs(baseSize))) * 100
          : 0;

        positions.push({
          botId: bot.id,
          botName: bot.name,
          market: pos.market,
          side,
          baseAssetAmount: baseSize,
          sizeUsd,
          entryPrice,
          markPrice,
          unrealizedPnl,
          unrealizedPnlPercent,
          realizedPnl,
          totalFees,
          lastTradeAt: pos.lastTradeAt,
        });
      }

      res.json({ positions });
    } catch (error) {
      console.error("Get positions error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Reconcile endpoint - sync database with on-chain Drift positions
  // OPTIMIZED: Uses batch RPC call instead of N sequential calls
  app.post("/api/positions/reconcile", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet || !wallet.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not found" });
      }

      // Get all bots for this wallet
      const bots = await storage.getTradingBots(req.walletAddress!);
      const reconciled: any[] = [];
      const discrepancies: any[] = [];
      let totalOnChainPositions = 0;

      // BATCH OPTIMIZATION: Fetch all positions in single RPC call (deduplicated)
      const subAccountIds = Array.from(new Set(bots.map(b => b.driftSubaccountId ?? 0)));
      const batchPositions = await getBatchPerpPositions(wallet.agentPublicKey, subAccountIds);

      // Process each bot using batch-fetched positions
      for (const bot of bots) {
        const subAccountId = bot.driftSubaccountId ?? 0;
        const onChainPositions = batchPositions.get(subAccountId) || [];
        totalOnChainPositions += onChainPositions.length;
        console.log(`[Reconcile] Bot ${bot.name} (subaccount ${subAccountId}): Found ${onChainPositions.length} on-chain positions`);

        // Find position matching this bot's market
        const pos = onChainPositions.find(p => p.market === bot.market);
        const dbPosition = await storage.getBotPosition(bot.id, bot.market);
        const dbBaseSize = dbPosition ? parseFloat(dbPosition.baseSize) : 0;

        if (pos) {
          const onChainBaseSize = pos.baseAssetAmount;
          
          // Check for discrepancy
          if (Math.abs(dbBaseSize - onChainBaseSize) > 0.0001) {
            discrepancies.push({
              botId: bot.id,
              botName: bot.name,
              market: pos.market,
              subAccountId,
              database: { baseSize: dbBaseSize },
              onChain: { 
                baseSize: onChainBaseSize, 
                side: pos.side,
                entryPrice: pos.entryPrice 
              }
            });

            // Update database with on-chain data
            await storage.upsertBotPosition({
              tradingBotId: bot.id,
              walletAddress: bot.walletAddress,
              market: pos.market,
              baseSize: String(onChainBaseSize),
              avgEntryPrice: String(pos.entryPrice),
              costBasis: String(Math.abs(onChainBaseSize) * pos.entryPrice),
              realizedPnl: dbPosition?.realizedPnl || "0",
              totalFees: dbPosition?.totalFees || "0",
              lastTradeId: dbPosition?.lastTradeId || null,
              lastTradeAt: new Date(),
            });

            reconciled.push({
              botId: bot.id,
              botName: bot.name,
              market: pos.market,
              subAccountId,
              newPosition: {
                baseSize: onChainBaseSize,
                side: pos.side,
                entryPrice: pos.entryPrice
              }
            });
          }
        } else if (dbPosition && Math.abs(dbBaseSize) > 0.0001) {
          // Position in DB but not on-chain (closed position)
          discrepancies.push({
            botId: bot.id,
            botName: bot.name,
            market: bot.market,
            subAccountId,
            database: { baseSize: dbBaseSize },
            onChain: { baseSize: 0, side: 'FLAT' }
          });

          // Zero out the database position
          await storage.upsertBotPosition({
            tradingBotId: bot.id,
            walletAddress: bot.walletAddress,
            market: bot.market,
            baseSize: "0",
            avgEntryPrice: "0",
            costBasis: "0",
            realizedPnl: dbPosition.realizedPnl,
            totalFees: dbPosition.totalFees,
            lastTradeId: dbPosition.lastTradeId,
            lastTradeAt: new Date(),
          });

          reconciled.push({
            botId: bot.id,
            botName: bot.name,
            market: bot.market,
            subAccountId,
            newPosition: { baseSize: 0, side: 'FLAT' }
          });
        }
      }

      res.json({ 
        success: true,
        totalOnChainPositions,
        botsChecked: bots.length,
        discrepancies,
        reconciled,
      });
    } catch (error) {
      console.error("Reconcile positions error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Health metrics endpoint - uses byte-parsing only to avoid SDK memory leaks
  app.get("/api/health-metrics", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet?.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not configured" });
      }

      const subAccountId = req.query.subaccount ? parseInt(req.query.subaccount as string) : 0;
      
      // Use byte-parsing to get positions and account info - NO SDK to avoid memory leaks
      const positions = await getPerpPositions(wallet.agentPublicKey, subAccountId);
      const accountInfo = await getDriftAccountInfo(wallet.agentPublicKey, subAccountId);
      
      // Calculate metrics from byte-parsed data
      const totalCollateral = accountInfo.totalCollateral;
      const freeCollateral = accountInfo.freeCollateral;
      let unrealizedPnl = 0;
      
      const formattedPositions = positions.map(pos => {
        unrealizedPnl += pos.unrealizedPnl;
        return {
          marketIndex: pos.marketIndex,
          market: pos.market,
          baseSize: pos.baseAssetAmount,
          notionalValue: pos.sizeUsd,
          liquidationPrice: null, // Would require more complex calculation
          entryPrice: pos.entryPrice,
          unrealizedPnl: pos.unrealizedPnl,
        };
      });
      
      // Health factor: Use freeCollateral/totalCollateral ratio (closer to Drift's approach)
      // Drift shows health as remaining margin capacity - when freeCollateral drops, health drops
      let healthFactor = 100;
      if (formattedPositions.length > 0 && totalCollateral > 0) {
        // Health = (freeCollateral / totalCollateral) * 100
        // This matches Drift's approach: 100% when fully free, 0% when all margin is used
        healthFactor = Math.max(0, Math.min(100, (freeCollateral / totalCollateral) * 100));
      }
      
      res.json({
        healthFactor,
        marginRatio: totalCollateral > 0 ? (totalCollateral - freeCollateral) / totalCollateral : 0,
        totalCollateral,
        freeCollateral,
        unrealizedPnl,
        positions: formattedPositions,
        subAccountId,
        isEstimate: true, // Health metrics are estimates - check Drift UI for precise values
        estimateNote: "Using per-market maintenance margins (SOL: 3.3%, BTC/ETH: 2.5%)",
      });
    } catch (error) {
      console.error("Health metrics error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Manual close position endpoint - query on-chain and close with reduce-only order
  app.post("/api/trading-bots/:id/close-position", requireWallet, async (req, res) => {
    console.log(`[ClosePosition] *** CLOSE POSITION REQUEST RECEIVED *** botId=${req.params.id}`);
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const wallet = await storage.getWallet(bot.walletAddress);
      if (!wallet?.agentPrivateKeyEncrypted || !wallet?.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not configured" });
      }

      const subAccountId = bot.driftSubaccountId ?? 0;

      // Query actual on-chain position from Drift using PositionService for normalized market matching
      let onChainPosition;
      try {
        onChainPosition = await PositionService.getPositionForExecution(
          bot.id,
          wallet.agentPublicKey,
          subAccountId,
          bot.market,
          wallet.agentPrivateKeyEncrypted
        );
        console.log(`[ClosePosition] On-chain position for ${bot.market}: ${onChainPosition.side} ${onChainPosition.size}`);
      } catch (err) {
        console.error(`[ClosePosition] Failed to query on-chain position:`, err);
        return res.status(500).json({ 
          error: "Failed to query on-chain position from Drift",
          details: err instanceof Error ? err.message : "Unknown error"
        });
      }

      // Check if there's actually a position to close
      if (onChainPosition.side === 'FLAT' || Math.abs(onChainPosition.size) < 0.0001) {
        return res.status(400).json({ 
          error: "No open position to close",
          onChainPositionSize: 0,
          side: 'FLAT'
        });
      }

      // Determine close side (opposite of current position)
      const closeSide: 'long' | 'short' = onChainPosition.side === 'LONG' ? 'short' : 'long';
      const closeSize = Math.abs(onChainPosition.size);

      console.log(`[ClosePosition] Closing ${closeSize} ${bot.market} (${closeSide}) with closePerpPosition (exact BN precision)`);

      // Execute close order using closePerpPosition for exact BN precision
      // This prevents JavaScript float precision issues (e.g., 0.4374 → 437399999 instead of 437400000)
      const closeSlippageBps = wallet.slippageBps ?? 50;
      const result = await closePerpPosition(
        wallet.agentPrivateKeyEncrypted,
        bot.market,
        subAccountId,
        undefined,
        closeSlippageBps
      );

      // Map closePerpPosition result format (signature) to expected format (txSignature)
      const txSignature = result.signature || null;

      // Handle error case
      if (!result.success) {
        // Check if this is a transient error (rate limit, price feed, etc.) - queue for CRITICAL automatic retry
        if (isTransientError(result.error || '')) {
          console.log(`[ClosePosition] CRITICAL: Transient error on close order, queueing for priority retry`);
          
          const retryJobId = queueTradeRetry({
            botId: bot.id,
            walletAddress: wallet.address,
            agentPrivateKeyEncrypted: wallet.agentPrivateKeyEncrypted,
            agentPublicKey: wallet.agentPublicKey!,
            market: bot.market,
            side: 'close',
            size: closeSize,
            subAccountId,
            reduceOnly: true,
            slippageBps: closeSlippageBps,
            priority: 'critical', // CLOSE orders get highest priority
            lastError: result.error,
            entryPrice: onChainPosition.entryPrice || 0, // For profit share calculation on retry success
          });
          
          return res.status(202).json({ 
            status: "queued_for_retry",
            retryJobId,
            message: "Close order rate limited - CRITICAL auto-retry scheduled (priority queue)",
            warning: "Position may remain open until retry succeeds"
          });
        }
        
        return res.status(500).json({ 
          error: "Failed to execute close order",
          details: result.error || "Unknown error"
        });
      }
      
      // Handle case where subprocess found no position to close (success=true, signature=null)
      // This can happen if position was closed by another process (e.g., liquidation, webhook)
      if (result.success && !txSignature) {
        console.log(`[ClosePosition] closePerpPosition returned success but no signature - position was already closed`);
        
        // Still run a reconciliation to ensure database matches on-chain state
        // This handles the case where liquidation or another process closed the position
        // but the database wasn't updated
        try {
          const { reconcileBotPosition } = await import("./reconciliation-service.js");
          await reconcileBotPosition(bot.id, wallet.address, wallet.agentPublicKey, subAccountId, bot.market);
          console.log(`[ClosePosition] Ran reconciliation after "already closed" scenario`);
        } catch (reconcileErr) {
          console.warn(`[ClosePosition] Reconciliation failed (non-critical):`, reconcileErr);
        }
        
        return res.json({ 
          success: true,
          message: "Position was already closed (no trade executed)",
          warning: null,
          closedSize: 0,
          closeSide,
          fillPrice: 0,
          fee: 0,
          txSignature: null,
          tradeId: null,
        });
      }

      console.log(`[ClosePosition] Close order executed: ${txSignature}`);

      // Get entry price FIRST from on-chain position (captured before close)
      const entryPrice = onChainPosition.entryPrice || 0;
      console.log(`[ClosePosition] Entry price from on-chain: $${entryPrice}`);

      // Fetch current ticker price for accurate exit price
      let fillPrice = 0;
      try {
        const priceRes = await fetch(`http://localhost:5000/api/prices`);
        if (priceRes.ok) {
          const priceData = await priceRes.json();
          console.log(`[ClosePosition] Price data keys: ${Object.keys(priceData).join(', ')}, looking for: ${bot.market}`);
          fillPrice = priceData[bot.market] || 0;
          if (fillPrice > 0) {
            console.log(`[ClosePosition] Fetched ticker price for ${bot.market}: $${fillPrice}`);
          } else {
            console.warn(`[ClosePosition] Market ${bot.market} not found in price data`);
          }
        } else {
          console.warn(`[ClosePosition] Price fetch failed with status: ${priceRes.status}`);
        }
      } catch (priceErr) {
        console.warn(`[ClosePosition] Could not fetch ticker price:`, priceErr);
      }
      
      // Fallback: use entry price if ticker fetch failed (price will be close enough for PnL estimate)
      if (!fillPrice && entryPrice > 0) {
        fillPrice = entryPrice;
        console.log(`[ClosePosition] Using entry price as fallback exit price: $${fillPrice}`);
      }

      // Calculate fee (0.05% taker fee on notional value)
      const closeNotional = closeSize * fillPrice;
      const closeFee = closeNotional * DRIFT_FEE_RATE;

      // Calculate trade PnL based on entry and exit prices
      // closeSide = 'short' means we're closing a LONG (bought low, selling high)
      // closeSide = 'long' means we're closing a SHORT (sold high, buying low)
      let tradePnl = 0;
      if (entryPrice > 0 && fillPrice > 0) {
        if (closeSide === 'short') {
          // Closing LONG: profit if exitPrice > entryPrice
          tradePnl = (fillPrice - entryPrice) * closeSize - closeFee;
        } else {
          // Closing SHORT: profit if entryPrice > exitPrice
          tradePnl = (entryPrice - fillPrice) * closeSize - closeFee;
        }
        console.log(`[ClosePosition] Trade PnL: entry=$${entryPrice.toFixed(2)}, exit=$${fillPrice.toFixed(2)}, size=${closeSize}, fee=$${closeFee.toFixed(4)}, pnl=$${tradePnl.toFixed(4)}`);
      } else {
        console.warn(`[ClosePosition] Cannot calculate PnL - entryPrice=$${entryPrice}, fillPrice=$${fillPrice}`);
      }

      // CRITICAL: Verify on-chain that position is actually closed and retry if dust remains
      // This handles partial fills and ensures position is truly flat
      // Use 1s delays with 5 retries (~5s total to stay within HTTP timeout)
      let verificationWarning: string | null = null;
      let finalTxSignature = txSignature;
      let retryCount = 0;
      const maxRetries = 5; // Increased from 3 to 5 for stubborn dust
      
      while (retryCount < maxRetries) {
        try {
          // Wait 1s for on-chain state to settle - consistent delay keeps total under HTTP timeout
          const delayMs = 1000;
          console.log(`[ClosePosition] Waiting ${delayMs}ms for on-chain state to settle (attempt ${retryCount + 1}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          
          const postClosePosition = await PositionService.getPositionForExecution(
            bot.id,
            wallet.agentPublicKey,
            subAccountId,
            bot.market,
            wallet.agentPrivateKeyEncrypted
          );
          
          if (postClosePosition.side === 'FLAT' || Math.abs(postClosePosition.size) < 0.0001) {
            console.log(`[ClosePosition] Post-close verification: Position confirmed FLAT`);
            break; // Position fully closed, exit retry loop
          }
          
          // Position still exists - this is dust that needs cleanup
          console.warn(`[ClosePosition] Position NOT fully closed (attempt ${retryCount + 1}/${maxRetries})`);
          console.warn(`[ClosePosition] Remaining dust: ${postClosePosition.side} ${Math.abs(postClosePosition.size).toFixed(6)} contracts - attempting cleanup...`);
          
          // Retry closePerpPosition to clean up the dust
          const dustSlippageBps = wallet.slippageBps ?? 50;
          const retryResult = await closePerpPosition(
            wallet.agentPrivateKeyEncrypted,
            bot.market,
            subAccountId,
            undefined,
            dustSlippageBps
          );
          
          if (retryResult.success && retryResult.signature) {
            console.log(`[ClosePosition] Dust cleanup attempt ${retryCount + 1} succeeded: ${retryResult.signature}`);
            finalTxSignature = retryResult.signature;
          } else if (retryResult.success && !retryResult.signature) {
            console.log(`[ClosePosition] Dust cleanup: position already closed`);
            break;
          } else {
            console.error(`[ClosePosition] Dust cleanup attempt ${retryCount + 1} failed:`, retryResult.error);
          }
          
          retryCount++;
        } catch (verifyErr) {
          console.warn(`[ClosePosition] Could not verify/cleanup post-close position (attempt ${retryCount + 1}):`, verifyErr);
          retryCount++;
        }
      }
      
      // Final verification after all retries
      try {
        const finalCheck = await PositionService.getPositionForExecution(
          bot.id,
          wallet.agentPublicKey,
          subAccountId,
          bot.market,
          wallet.agentPrivateKeyEncrypted
        );
        if (finalCheck.side !== 'FLAT' && Math.abs(finalCheck.size) > 0.0001) {
          verificationWarning = `Position not fully closed after ${maxRetries} attempts. Remaining: ${finalCheck.side} ${finalCheck.size}`;
          console.error(`[ClosePosition] CRITICAL: ${verificationWarning}`);
        }
      } catch (finalVerifyErr) {
        console.warn(`[ClosePosition] Could not perform final position verification:`, finalVerifyErr);
      }

      // Create trade record for the close with PnL
      const closeTrade = await storage.createBotTrade({
        tradingBotId: bot.id,
        walletAddress: bot.walletAddress,
        market: bot.market,
        side: "CLOSE",
        size: String(closeSize),
        price: String(fillPrice),
        fee: String(closeFee),
        pnl: tradePnl !== 0 ? String(tradePnl) : null,
        status: "executed",
        txSignature: finalTxSignature,
        webhookPayload: { action: "manual_close", reason: "User requested position close", entryPrice, exitPrice: fillPrice },
        errorMessage: verificationWarning,
      });

      // Sync position from on-chain (updates database with actual Drift state)
      await syncPositionFromOnChain(
        bot.id,
        bot.walletAddress,
        wallet.agentPublicKey,
        subAccountId,
        bot.market,
        closeTrade.id,
        closeFee,
        fillPrice,
        closeSide,
        closeSize
      );
      
      // PROFIT SHARE: If this is a subscriber bot with profitable close, distribute to creator
      // This must happen BEFORE auto-withdraw to ensure creator gets their share
      if (tradePnl > 0) {
        const tradeId = `${bot.id}-${Date.now()}`;
        distributeCreatorProfitShare({
          subscriberBotId: bot.id,
          subscriberWalletAddress: wallet.address,
          subscriberAgentPublicKey: wallet.agentPublicKey!,
          subscriberEncryptedPrivateKey: wallet.agentPrivateKeyEncrypted,
          driftSubaccountId: subAccountId,
          realizedPnl: tradePnl,
          tradeId,
        }).then(result => {
          if (result.success && result.amount) {
            console.log(`[ClosePosition] Profit share distributed: $${result.amount.toFixed(4)}`);
          } else if (!result.success && result.error) {
            console.error(`[ClosePosition] Profit share failed: ${result.error}`);
            // IOU is now created inside distributeCreatorProfitShare
          }
        }).catch(err => console.error('[ClosePosition] Profit share error:', err));
      }

      res.json({ 
        success: true,
        message: verificationWarning ? "Position closed with warning" : "Position closed successfully",
        warning: verificationWarning,
        closedSize: closeSize,
        closeSide,
        fillPrice,
        fee: closeFee,
        txSignature: finalTxSignature,
        tradeId: closeTrade.id
      });
    } catch (error) {
      console.error("Close position error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Close a specific market position in a bot's subaccount (for cleaning up dust/misrouted positions)
  app.post("/api/trading-bots/:id/close-market-position", requireWallet, async (req, res) => {
    console.log(`[CloseMarketPosition] *** CLOSE MARKET POSITION REQUEST *** botId=${req.params.id}`);
    try {
      const { market } = req.body;
      if (!market || typeof market !== 'string') {
        return res.status(400).json({ error: "Market parameter required (e.g., SOL-PERP)" });
      }

      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const wallet = await storage.getWallet(bot.walletAddress);
      if (!wallet?.agentPrivateKeyEncrypted || !wallet?.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not configured" });
      }

      const subAccountId = bot.driftSubaccountId ?? 0;
      console.log(`[CloseMarketPosition] Closing ${market} in subaccount ${subAccountId} (bot: ${bot.name})`);

      // Execute close order using closePerpPosition
      const marketCloseSlippageBps = wallet.slippageBps ?? 50;
      const result = await closePerpPosition(
        wallet.agentPrivateKeyEncrypted,
        market,
        subAccountId,
        undefined,
        marketCloseSlippageBps
      );

      if (!result.success) {
        return res.status(500).json({ 
          error: "Failed to close position",
          details: result.error || "Unknown error"
        });
      }

      if (result.success && !result.signature) {
        return res.json({ 
          success: true,
          message: "Position was already closed or doesn't exist",
          market,
          txSignature: null,
        });
      }

      console.log(`[CloseMarketPosition] Position closed: ${result.signature}`);
      res.json({ 
        success: true,
        message: `${market} position closed successfully`,
        market,
        txSignature: result.signature,
      });
    } catch (error) {
      console.error("Close market position error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Manual trade - trigger a trade without webhook (uses bot's config)
  app.post("/api/trading-bots/:id/manual-trade", requireWallet, async (req, res) => {
    console.log(`[ManualTrade] *** MANUAL TRADE REQUEST *** botId=${req.params.id}`);
    try {
      const { side } = req.body;
      if (!side || !['long', 'short'].includes(side)) {
        return res.status(400).json({ error: "Side must be 'long' or 'short'" });
      }

      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }
      if (!bot.isActive) {
        return res.status(400).json({ error: "Bot is paused. Activate it first." });
      }

      const wallet = await storage.getWallet(bot.walletAddress);
      if (!wallet?.agentPrivateKeyEncrypted || !wallet?.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not configured" });
      }

      const subAccountId = bot.driftSubaccountId ?? 0;
      const botLeverage = Math.max(1, bot.leverage || 1);
      const marketMaxLeverage = getMarketMaxLeverage(bot.market);
      const effectiveLeverage = Math.min(botLeverage, marketMaxLeverage); // Use the lower of bot's setting or market's limit
      const baseCapital = parseFloat(bot.maxPositionSize || "0");
      const profitReinvestEnabled = bot.profitReinvest === true;

      if (botLeverage > marketMaxLeverage) {
        console.log(`[ManualTrade] Leverage capped: ${botLeverage}x → ${marketMaxLeverage}x (${bot.market} max)`);
      }

      // Get oracle price
      const oraclePrice = await getMarketPrice(bot.market);
      if (!oraclePrice || oraclePrice <= 0) {
        return res.status(500).json({ error: "Could not get market price" });
      }

      // Calculate trade amount (100% of available capacity)
      let tradeAmountUsd = 0;
      let maxTradeableValue = 0;
      let freeCollateral = 0;

      try {
        const accountInfo = await getDriftAccountInfo(wallet.agentPublicKey, subAccountId);
        freeCollateral = Math.max(0, accountInfo.freeCollateral);
        // CRITICAL: Use effectiveLeverage (capped by market's max) to avoid InsufficientCollateral errors
        const maxNotionalCapacity = freeCollateral * effectiveLeverage;
        maxTradeableValue = maxNotionalCapacity * 0.90;

        if (profitReinvestEnabled) {
          if (maxTradeableValue <= 0) {
            return res.status(400).json({ error: `No margin available (freeCollateral=$${freeCollateral.toFixed(2)})` });
          }
          tradeAmountUsd = maxTradeableValue;
          console.log(`[ManualTrade] PROFIT REINVEST: $${tradeAmountUsd.toFixed(2)} (100% of available margin)`);
        } else {
          if (baseCapital <= 0) {
            return res.status(400).json({ error: "Bot has no capital configured. Set Max Position Size." });
          }
          
          // Check if auto top-up can help reach full investment amount
          if (bot.autoTopUp && baseCapital > maxTradeableValue && maxTradeableValue > 0) {
            const requiredCollateralForFullTrade = (baseCapital / effectiveLeverage) * 1.15; // 15% buffer
            const topUpNeeded = Math.max(0, requiredCollateralForFullTrade - freeCollateral);
            const botSubaccountId = bot.driftSubaccountId ?? 0;
            
            console.log(`[ManualTrade] Auto top-up check: need $${requiredCollateralForFullTrade.toFixed(2)} collateral for $${baseCapital.toFixed(2)} trade, have $${freeCollateral.toFixed(2)}, shortfall: $${topUpNeeded.toFixed(2)}`);
            
            if (topUpNeeded > 0) {
              try {
                const agentUsdcBalance = await getAgentUsdcBalance(wallet.agentPublicKey!);
                console.log(`[ManualTrade] Agent wallet USDC balance: $${agentUsdcBalance.toFixed(2)}, need: $${topUpNeeded.toFixed(2)}`);
                
                if (agentUsdcBalance >= topUpNeeded) {
                  const depositAmount = Math.ceil(topUpNeeded * 100) / 100;
                  const depositResult = await executeAgentDriftDeposit(
                    wallet.agentPublicKey!,
                    wallet.agentPrivateKeyEncrypted,
                    depositAmount,
                    botSubaccountId,
                    false
                  );
                  
                  if (depositResult.success) {
                    console.log(`[ManualTrade] Auto top-up successful: deposited $${depositAmount.toFixed(2)}, tx: ${depositResult.signature}`);
                    freeCollateral += depositAmount;
                    maxTradeableValue = freeCollateral * effectiveLeverage * 0.90;
                    
                    await storage.createEquityEvent({
                      walletAddress: bot.walletAddress,
                      tradingBotId: bot.id,
                      eventType: 'auto_topup',
                      amount: String(depositAmount),
                      txSignature: depositResult.signature || null,
                      notes: `Auto top-up: deposited $${depositAmount.toFixed(2)} for manual ${side} trade`,
                    });
                  } else {
                    console.log(`[ManualTrade] Auto top-up failed: ${depositResult.error}`);
                  }
                } else {
                  console.log(`[ManualTrade] Agent wallet ($${agentUsdcBalance.toFixed(2)}) insufficient for top-up ($${topUpNeeded.toFixed(2)})`);
                }
              } catch (topUpErr: any) {
                console.log(`[ManualTrade] Auto top-up error: ${topUpErr.message}`);
              }
            }
          }
          
          tradeAmountUsd = Math.min(baseCapital, maxTradeableValue);
          console.log(`[ManualTrade] Using ${tradeAmountUsd === baseCapital ? 'full' : 'scaled'} position: $${tradeAmountUsd.toFixed(2)}`);
        }
      } catch (collateralErr: any) {
        console.warn(`[ManualTrade] Could not check collateral: ${collateralErr.message}`);
        if (profitReinvestEnabled) {
          return res.status(500).json({ error: "Profit reinvest requires collateral check" });
        }
        tradeAmountUsd = baseCapital;
      }

      // Calculate contract size
      let contractSize = tradeAmountUsd / oraclePrice;
      const minOrderSize = getMinOrderSize(bot.market);

      // Bump up to minimum if needed
      if (contractSize < minOrderSize) {
        const minCapitalNeeded = minOrderSize * oraclePrice;
        let maxCapacity = (freeCollateral || baseCapital / effectiveLeverage) * effectiveLeverage * 0.9;
        
        // Try auto top-up if enabled and can't meet minimum
        if (bot.autoTopUp && minCapitalNeeded > maxCapacity) {
          const requiredCollateral = (minCapitalNeeded / effectiveLeverage) * 1.2;
          const shortfall = Math.max(0, requiredCollateral - freeCollateral);
          const botSubaccountId = bot.driftSubaccountId ?? 0;
          
          console.log(`[ManualTrade] Min order auto top-up check: need $${requiredCollateral.toFixed(2)}, have $${freeCollateral.toFixed(2)}, shortfall: $${shortfall.toFixed(2)}`);
          
          if (shortfall > 0) {
            try {
              const agentUsdcBalance = await getAgentUsdcBalance(wallet.agentPublicKey!);
              if (agentUsdcBalance >= shortfall) {
                const depositAmount = Math.ceil(shortfall * 100) / 100;
                const depositResult = await executeAgentDriftDeposit(
                  wallet.agentPublicKey!,
                  wallet.agentPrivateKeyEncrypted,
                  depositAmount,
                  botSubaccountId,
                  false
                );
                
                if (depositResult.success) {
                  console.log(`[ManualTrade] Min order auto top-up successful: deposited $${depositAmount.toFixed(2)}`);
                  freeCollateral += depositAmount;
                  maxCapacity = freeCollateral * effectiveLeverage * 0.9;
                  
                  await storage.createEquityEvent({
                    walletAddress: bot.walletAddress,
                    tradingBotId: bot.id,
                    eventType: 'auto_topup',
                    amount: String(depositAmount),
                    txSignature: depositResult.signature || null,
                    notes: `Auto top-up: deposited $${depositAmount.toFixed(2)} to meet ${minOrderSize} min order for ${bot.market}`,
                  });
                }
              }
            } catch (topUpErr: any) {
              console.log(`[ManualTrade] Min order auto top-up error: ${topUpErr.message}`);
            }
          }
        }
        
        if (minCapitalNeeded <= maxCapacity) {
          contractSize = minOrderSize;
          console.log(`[ManualTrade] BUMPED UP to minimum: ${minOrderSize} contracts`);
        } else {
          return res.status(400).json({ 
            error: `Order too small. Minimum ${minOrderSize} contracts ($${minCapitalNeeded.toFixed(2)}) required, but only $${maxCapacity.toFixed(2)} capacity available.${bot.autoTopUp ? ' Auto top-up attempted but insufficient funds in agent wallet.' : ' Enable Auto Top-Up to automatically fund from agent wallet.'}` 
          });
        }
      }

      console.log(`[ManualTrade] Executing ${side.toUpperCase()} ${contractSize.toFixed(4)} contracts @ $${oraclePrice.toFixed(2)}`);

      // Create trade record
      const trade = await storage.createBotTrade({
        tradingBotId: bot.id,
        walletAddress: bot.walletAddress,
        market: bot.market,
        side: side,
        size: contractSize.toFixed(8),
        price: oraclePrice.toString(),
        status: "pending",
        webhookPayload: { manual: true, action: side === 'long' ? 'buy' : 'sell' },
      });

      // Execute trade
      const userSlippageBps = wallet.slippageBps ?? 50;
      const orderResult = await executePerpOrder(
        wallet.agentPrivateKeyEncrypted,
        bot.market,
        side,
        contractSize,
        subAccountId,
        false,
        userSlippageBps,
        undefined,
        wallet.agentPublicKey
      );

      if (!orderResult.success) {
        const userFriendlyError = parseDriftError(orderResult.error);
        await storage.updateBotTrade(trade.id, {
          status: "failed",
          txSignature: null,
          errorMessage: userFriendlyError,
        });
        return res.status(500).json({ error: userFriendlyError });
      }

      const fillPrice = orderResult.fillPrice || oraclePrice;
      const tradeNotional = contractSize * fillPrice;
      // Use actual fee from executor if available, otherwise estimate
      const tradeFee = orderResult.actualFee ?? (tradeNotional * DRIFT_FEE_RATE);

      await storage.updateBotTrade(trade.id, {
        status: "executed",
        price: fillPrice.toString(),
        fee: tradeFee.toString(),
        txSignature: orderResult.txSignature || orderResult.signature || null,
        size: contractSize.toFixed(8),
      });

      // Sync position
      await syncPositionFromOnChain(
        bot.id,
        bot.walletAddress,
        wallet.agentPublicKey,
        subAccountId,
        bot.market,
        trade.id,
        tradeFee,
        fillPrice,
        side,
        contractSize
      );

      // Update stats
      const stats = bot.stats as TradingBot['stats'] || { totalTrades: 0, winningTrades: 0, losingTrades: 0, totalPnl: 0, totalVolume: 0 };
      await storage.updateTradingBotStats(bot.id, {
        ...stats,
        totalTrades: (stats.totalTrades || 0) + 1,
        totalVolume: (stats.totalVolume || 0) + tradeNotional,
        lastTradeAt: new Date().toISOString(),
      });

      console.log(`[ManualTrade] Trade executed: ${side.toUpperCase()} ${contractSize.toFixed(4)} @ $${fillPrice.toFixed(2)}`);
      res.json({
        success: true,
        side,
        size: contractSize,
        price: fillPrice,
        notional: tradeNotional,
        fee: tradeFee,
        txSignature: orderResult.txSignature || orderResult.signature,
        tradeId: trade.id,
      });
    } catch (error) {
      console.error("Manual trade error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Force refresh position from blockchain - updates cached database entry price AND oracle prices
  app.post("/api/trading-bots/:id/refresh-position", requireWallet, async (req, res) => {
    console.log(`[RefreshPosition] Force refresh request for botId=${req.params.id}`);
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet?.agentPublicKey) {
        return res.status(400).json({ error: "No agent wallet" });
      }

      const subAccountId = bot.driftSubaccountId ?? 0;
      
      // Also force refresh oracle prices while we're at it
      const freshPrices = await forceRefreshPrices();
      console.log(`[RefreshPosition] Refreshed ${Object.keys(freshPrices).length} oracle prices`);
      
      // Force sync from on-chain with zero trade params - this just updates entry price
      const syncResult = await syncPositionFromOnChain(
        bot.id,
        bot.walletAddress,
        wallet.agentPublicKey,
        subAccountId,
        bot.market,
        `refresh-${Date.now()}`,
        0, // no fee
        0, // no fill price
        '', // no side
        0  // no size
      );

      if (syncResult.success) {
        console.log(`[RefreshPosition] Successfully refreshed position from blockchain`);
        res.json({ 
          success: true, 
          message: "Position refreshed from blockchain",
          position: syncResult.position
        });
      } else {
        res.status(500).json({ error: syncResult.error || "Failed to refresh" });
      }
    } catch (error) {
      console.error("Refresh position error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agent/confirm-deposit", requireWallet, async (req, res) => {
    try {
      const { amount, txSignature } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }
      if (!txSignature || typeof txSignature !== 'string' || txSignature.length < 20) {
        return res.status(400).json({ error: "Valid transaction signature required" });
      }

      const existingEvents = await storage.getEquityEvents(req.walletAddress!, 100);
      if (existingEvents.some(e => e.txSignature === txSignature)) {
        return res.json({ success: true, duplicate: true });
      }

      await storage.createEquityEvent({
        walletAddress: req.walletAddress!,
        eventType: 'agent_deposit',
        amount: String(amount),
        txSignature,
        notes: 'Deposit to agent wallet',
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Confirm deposit error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agent/confirm-withdraw", requireWallet, async (req, res) => {
    try {
      const { amount, txSignature } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }
      if (!txSignature || typeof txSignature !== 'string' || txSignature.length < 20) {
        return res.status(400).json({ error: "Valid transaction signature required" });
      }

      const existingEvents = await storage.getEquityEvents(req.walletAddress!, 100);
      if (existingEvents.some(e => e.txSignature === txSignature)) {
        return res.json({ success: true, duplicate: true });
      }

      await storage.createEquityEvent({
        walletAddress: req.walletAddress!,
        eventType: 'agent_withdraw',
        amount: String(-amount),
        txSignature,
        notes: 'Withdraw from agent wallet',
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Confirm withdraw error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agent/confirm-sol-deposit", requireWallet, async (req, res) => {
    try {
      const { amount, txSignature } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }
      if (!txSignature || typeof txSignature !== 'string' || txSignature.length < 20) {
        return res.status(400).json({ error: "Valid transaction signature required" });
      }

      const existingEvents = await storage.getEquityEvents(req.walletAddress!, 100);
      if (existingEvents.some(e => e.txSignature === txSignature)) {
        return res.json({ success: true, duplicate: true });
      }

      await storage.createEquityEvent({
        walletAddress: req.walletAddress!,
        eventType: 'sol_deposit',
        amount: String(amount),
        assetType: 'SOL',
        txSignature,
        notes: 'SOL deposit to agent wallet for gas',
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Confirm SOL deposit error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agent/withdraw-sol", requireWallet, async (req, res) => {
    try {
      const { amount } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }

      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      if (!wallet.agentPublicKey || !wallet.agentPrivateKeyEncrypted) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const solBalance = await getAgentSolBalance(wallet.agentPublicKey);
      const SOL_RESERVE = 0.005;
      
      if (amount > (solBalance - SOL_RESERVE)) {
        return res.status(400).json({ error: "Insufficient SOL balance (must keep 0.005 SOL reserve for gas)" });
      }

      const txData = await buildWithdrawSolFromAgentTransaction(
        wallet.agentPublicKey,
        req.walletAddress!,
        wallet.agentPrivateKeyEncrypted,
        amount
      );

      res.json(txData);
    } catch (error) {
      console.error("Build agent SOL withdraw error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/agent/confirm-sol-withdraw", requireWallet, async (req, res) => {
    try {
      const { amount, txSignature } = req.body;
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }
      if (!txSignature || typeof txSignature !== 'string' || txSignature.length < 20) {
        return res.status(400).json({ error: "Valid transaction signature required" });
      }

      const existingEvents = await storage.getEquityEvents(req.walletAddress!, 100);
      if (existingEvents.some(e => e.txSignature === txSignature)) {
        return res.json({ success: true, duplicate: true });
      }

      await storage.createEquityEvent({
        walletAddress: req.walletAddress!,
        eventType: 'sol_withdraw',
        amount: String(-amount),
        assetType: 'SOL',
        txSignature,
        notes: 'SOL withdraw from agent wallet',
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Confirm SOL withdraw error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/equity-events", requireWallet, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const botId = req.query.botId as string | undefined;
      
      let events;
      if (botId) {
        // Verify bot ownership
        const bot = await storage.getTradingBotById(botId);
        if (!bot || bot.walletAddress !== req.walletAddress) {
          return res.status(403).json({ error: "Forbidden" });
        }
        events = await storage.getBotEquityEvents(botId, limit);
      } else {
        events = await storage.getEquityEvents(req.walletAddress!, limit);
      }
      
      res.json(events);
    } catch (error) {
      console.error("Get equity events error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/bots/:botId/net-deposited", requireWallet, async (req, res) => {
    try {
      const { botId } = req.params;
      const bot = await storage.getTradingBotById(botId);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }
      
      // First try bot-specific deposits
      let netDeposited = await storage.getBotNetDeposited(botId);
      
      // For legacy bots on subaccount 0 with no bot-specific deposits,
      // fall back to wallet-level deposits
      if (netDeposited === 0 && (bot.driftSubaccountId === 0 || bot.driftSubaccountId === null)) {
        netDeposited = await storage.getWalletNetDeposited(req.walletAddress!);
      }
      
      // Reconciliation: If bot has on-chain funds but no recorded deposits,
      // auto-create a reconciliation equity event (handles server restart during deposit)
      if (netDeposited === 0 && bot.driftSubaccountId && bot.driftSubaccountId > 0) {
        try {
          const wallet = await storage.getWallet(req.walletAddress!);
          if (wallet?.agentPublicKey) {
            const accountInfo = await getDriftAccountInfo(wallet.agentPublicKey, bot.driftSubaccountId);
            const onChainBalance = accountInfo.totalCollateral;
            
            if (onChainBalance > 0.01) {
              console.log(`[Reconciliation] Bot ${bot.name} has $${onChainBalance.toFixed(2)} on-chain but no recorded deposits - creating reconciliation event`);
              await storage.createEquityEvent({
                walletAddress: req.walletAddress!,
                tradingBotId: botId,
                eventType: 'drift_deposit',
                amount: String(onChainBalance),
                txSignature: null,
                notes: 'Deposit reconciled from on-chain state',
              });
              netDeposited = onChainBalance;
            }
          }
        } catch (reconcileErr) {
          console.warn(`[Reconciliation] Failed to check on-chain balance for bot ${botId}:`, reconcileErr);
        }
      }
      
      res.json({ netDeposited });
    } catch (error) {
      console.error("Get bot net deposited error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get bot-specific Drift account info from its subaccount
  app.get("/api/bots/:botId/drift-balance", requireWallet, async (req, res) => {
    try {
      const { botId } = req.params;
      const bot = await storage.getTradingBotById(botId);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }
      
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet?.agentPrivateKeyEncrypted) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const subAccountId = bot.driftSubaccountId ?? 0;
      
      // Use byte-parsing only - no SDK to avoid memory leaks
      const accountInfo = await getDriftAccountInfo(wallet.agentPublicKey!, subAccountId);
      res.json({ 
        balance: accountInfo.usdcBalance,
        totalCollateral: accountInfo.totalCollateral,
        freeCollateral: accountInfo.freeCollateral,
        hasOpenPositions: accountInfo.hasOpenPositions,
        subAccountId,
      });
    } catch (error) {
      console.error("Get bot drift balance error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Consolidated bot overview endpoint - reduces RPC calls from 7-8 to 2-3
  // Combines: /api/bot/:id/balance, /api/bots/:id/drift-balance, /api/bots/:id/net-deposited,
  //           /api/agent/balance, /api/trading-bots/:id/position, /api/user/webhook-url
  app.get("/api/bots/:botId/overview", requireWallet, async (req, res) => {
    try {
      const { botId } = req.params;
      const bot = await storage.getTradingBotById(botId);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }
      
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet?.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }

      const subAccountId = bot.driftSubaccountId ?? 0;
      
      // Parallel fetch with graceful degradation using Promise.allSettled
      // This allows partial data if some calls fail (e.g., RPC rate limits)
      const results = await Promise.allSettled([
        getDriftAccountInfo(wallet.agentPublicKey, subAccountId),
        getAgentUsdcBalance(wallet.agentPublicKey),
        PositionService.getPosition(
          bot.id,
          bot.walletAddress,
          wallet.agentPublicKey,
          subAccountId,
          bot.market,
          wallet.agentPrivateKeyEncrypted ?? undefined
        ),
        storage.getBotNetDeposited(botId),
        storage.getBotTradeCount(botId),
        storage.getBotPosition(botId, bot.market),
        getUsdcApy(),
      ]);
      
      // Extract results with defaults for failed calls
      const accountInfo = results[0].status === 'fulfilled' ? results[0].value : { 
        usdcBalance: 0, totalCollateral: 0, freeCollateral: 0, hasOpenPositions: false 
      };
      const mainAccountBalance = results[1].status === 'fulfilled' ? results[1].value : 0;
      const posData = results[2].status === 'fulfilled' ? results[2].value : { 
        position: null, 
        source: 'error', 
        driftDetected: false,
        staleWarning: false,
        driftDetails: null,
        healthMetrics: null,
      };
      const netDeposited = results[3].status === 'fulfilled' ? results[3].value : 0;
      const tradeCount = results[4].status === 'fulfilled' ? results[4].value : 0;
      const dbPosition = results[5].status === 'fulfilled' ? results[5].value : null;
      const apyResult = results[6].status === 'fulfilled' ? results[6].value : { apy: 5.3, stale: true };
      
      // Log any failures for debugging
      const failures = results.filter(r => r.status === 'rejected');
      if (failures.length > 0) {
        console.warn(`[Bot Overview] ${failures.length} calls failed:`, 
          failures.map((f, i) => `[${i}]: ${(f as PromiseRejectedResult).reason}`).join(', '));
      }
      
      // Calculate interest
      const currentApy = apyResult.apy / 100;
      const dailyInterestRate = currentApy / 365;
      const estimatedDailyInterest = accountInfo.usdcBalance * dailyInterestRate;
      
      // Build position response
      const position = posData.position?.hasPosition ? {
        hasPosition: true,
        side: posData.position.side,
        size: posData.position.size,
        avgEntryPrice: posData.position.avgEntryPrice,
        currentPrice: posData.position.currentPrice,
        unrealizedPnl: posData.position.unrealizedPnl,
        realizedPnl: posData.position.realizedPnl,
        market: posData.position.market,
        source: posData.source,
        staleWarning: posData.staleWarning,
        driftDetected: posData.driftDetected,
        driftDetails: posData.driftDetails,
        healthFactor: posData.healthMetrics?.healthFactor,
        liquidationPrice: posData.healthMetrics?.liquidationPrice,
      } : {
        hasPosition: false,
        source: posData.source,
        driftDetected: posData.driftDetected,
      };
      
      // Construct webhook URL dynamically
      const baseUrl = process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT_DOMAIN
        ? 'https://myquantumvault.com'
        : process.env.REPLIT_DEV_DOMAIN 
        ? `https://${process.env.REPLIT_DEV_DOMAIN}`
        : 'http://localhost:5000';
      const webhookUrl = wallet.userWebhookSecret 
        ? `${baseUrl}/api/webhook/user/${req.walletAddress}?secret=${wallet.userWebhookSecret}`
        : null;
      
      res.json({
        // Bot status (for auto-pause detection)
        isActive: bot.isActive,
        pauseReason: bot.pauseReason,
        autoTopUp: bot.autoTopUp,
        
        // From getDriftAccountInfo (1 RPC)
        usdcBalance: accountInfo.usdcBalance,
        totalCollateral: accountInfo.totalCollateral,
        freeCollateral: accountInfo.freeCollateral,
        hasOpenPositions: accountInfo.hasOpenPositions,
        subAccountId,
        
        // From getAgentUsdcBalance (1 RPC)
        mainAccountBalance,
        
        // From PositionService (reuses on-chain data, may add 1 RPC for oracle price)
        position,
        
        // From database (no RPC)
        netDeposited,
        tradeCount,
        realizedPnl: parseFloat(dbPosition?.realizedPnl || "0"),
        totalFees: parseFloat(dbPosition?.totalFees || "0"),
        
        // Calculated
        estimatedDailyInterest: Math.max(0, estimatedDailyInterest),
        driftApy: currentApy,
        apyStale: apyResult.stale || false,
        
        // Webhook URL (constructed dynamically)
        webhookUrl,
        
        // Indicates if some data may be stale due to failed calls
        partialData: failures.length > 0,
      });
    } catch (error) {
      console.error("Get bot overview error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Trading bot CRUD routes
  app.get("/api/trading-bots", requireWallet, async (req, res) => {
    try {
      const bots = await storage.getTradingBots(req.walletAddress!);
      const wallet = await storage.getWallet(req.walletAddress!);
      
      // Enrich with actual trade counts, position data, and net PnL from database
      const enrichedBots = await Promise.all(bots.map(async (bot) => {
        const [tradeCount, position] = await Promise.all([
          storage.getBotTradeCount(bot.id),
          storage.getBotPosition(bot.id, bot.market),
        ]);
        
        // Calculate net deposited from equity events for this bot's subaccount
        let netDeposited = 0;
        let driftBalance = 0;
        let netPnl = 0;
        let netPnlPercent = 0;
        
        try {
          // Get equity events for THIS specific bot using the trading_bot_id
          const botEvents = await storage.getBotEquityEvents(bot.id, 1000);
          netDeposited = botEvents.reduce((sum, e) => sum + parseFloat(e.amount || '0'), 0);
          
          // Get drift balance for this bot's subaccount
          if (wallet?.agentPublicKey) {
            const accountInfo = await getDriftAccountInfo(wallet.agentPublicKey, bot.driftSubaccountId ?? 0);
            driftBalance = accountInfo.totalCollateral;
          }
          
          // Calculate true Net P&L = drift balance - net deposited
          netPnl = driftBalance - netDeposited;
          netPnlPercent = netDeposited > 0 ? (netPnl / netDeposited) * 100 : 0;
        } catch (err) {
          console.warn(`[trading-bots] Failed to calculate net PnL for bot ${bot.id}:`, err);
        }
        
        return {
          ...bot,
          actualTradeCount: tradeCount,
          realizedPnl: position?.realizedPnl || "0",
          totalFees: position?.totalFees || "0",
          driftBalance,
          netDeposited,
          netPnl,
          netPnlPercent,
        };
      }));
      
      res.json(enrichedBots);
    } catch (error) {
      console.error("Get trading bots error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/trading-bots/:id", requireWallet, async (req, res) => {
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }
      res.json(bot);
    } catch (error) {
      console.error("Get trading bot error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/trading-bots", requireWallet, async (req, res) => {
    try {
      const { name, market, side, leverage, maxPositionSize, totalInvestment, signalConfig, riskConfig } = req.body;
      
      if (!name || !market) {
        return res.status(400).json({ error: "Name and market are required" });
      }

      // Ensure wallet exists before creating bot
      const wallet = await storage.getOrCreateWallet(req.walletAddress!);
      
      // Server-side SOL balance check for bot creation
      if (wallet.agentPublicKey) {
        const [solBalance, driftAccountExists] = await Promise.all([
          getAgentSolBalance(wallet.agentPublicKey),
          subaccountExists(wallet.agentPublicKey, 0),
        ]);
        
        // 0.035 SOL per subaccount rent + 0.005 SOL for trading gas
        const SUBACCOUNT_RENT = 0.035;
        const TRADING_GAS = 0.005;
        const requiredSol = driftAccountExists 
          ? SUBACCOUNT_RENT + TRADING_GAS  // 0.04 SOL
          : (SUBACCOUNT_RENT * 2) + TRADING_GAS; // 0.075 SOL (need to create subaccount 0 + bot subaccount)
        
        if (solBalance < requiredSol) {
          const deficit = requiredSol - solBalance;
          return res.status(400).json({ 
            error: `Insufficient SOL for bot creation. Need ${requiredSol.toFixed(3)} SOL, have ${solBalance.toFixed(4)} SOL. Please deposit at least ${deficit.toFixed(3)} SOL to your agent wallet.` 
          });
        }
      }

      const webhookSecret = generateWebhookSecret();
      
      // Use on-chain discovery combined with database state to find the next valid sequential subaccount ID
      // This ensures Drift's sequential requirement is met and avoids conflicts with pending creations
      let nextSubaccountId: number;
      try {
        // Get all subaccount IDs currently allocated in the database for this wallet
        const dbAllocatedIds = await storage.getAllocatedSubaccountIds(req.walletAddress!);
        
        if (wallet.agentPublicKey) {
          // SYNC: Create placeholder bots for any orphaned on-chain subaccounts
          // This keeps DB in sync with on-chain state and prevents ID conflicts
          const { syncOnChainSubaccounts } = await import('./drift-service');
          await syncOnChainSubaccounts(
            wallet.agentPublicKey,
            req.walletAddress!,
            dbAllocatedIds,
            async (orphanedSubaccountId: number) => {
              // Create a placeholder bot for the orphaned subaccount
              const orphanedWebhookSecret = generateWebhookSecret();
              const orphanedBot = await storage.createTradingBot({
                walletAddress: req.walletAddress!,
                name: `Recovered Bot (SA${orphanedSubaccountId})`,
                market: 'SOL-PERP',
                webhookSecret: orphanedWebhookSecret,
                driftSubaccountId: orphanedSubaccountId,
                isActive: false, // Paused by default - user can configure
                side: 'both',
                leverage: 1,
                totalInvestment: '0',
                maxPositionSize: null,
                signalConfig: { longKeyword: 'LONG', shortKeyword: 'SHORT', exitKeyword: 'CLOSE' },
                riskConfig: {},
              } as any);
              console.log(`[Bot Creation] Created recovered bot ${orphanedBot.id} for orphaned subaccount ${orphanedSubaccountId}`);
            }
          );
          
          // Re-fetch allocated IDs after sync (may have added orphaned bots)
          const updatedDbAllocatedIds = await storage.getAllocatedSubaccountIds(req.walletAddress!);
          
          nextSubaccountId = await getNextOnChainSubaccountId(wallet.agentPublicKey, updatedDbAllocatedIds);
          console.log(`[Bot Creation] On-chain discovery returned subaccount ID: ${nextSubaccountId}`);
        } else {
          // No agent wallet yet - find next ID not in database
          const usedSet = new Set(dbAllocatedIds);
          nextSubaccountId = 1;
          while (usedSet.has(nextSubaccountId)) {
            nextSubaccountId++;
          }
          console.log(`[Bot Creation] No agent wallet, using next available ID: ${nextSubaccountId}`);
        }
      } catch (error) {
        console.error(`[Bot Creation] On-chain discovery failed, falling back to database:`, error);
        nextSubaccountId = await storage.getNextSubaccountId(req.walletAddress!);
      }

      const bot = await storage.createTradingBot({
        walletAddress: req.walletAddress!,
        name,
        market,
        webhookSecret,
        driftSubaccountId: nextSubaccountId,
        isActive: true,
        side: side || 'both',
        leverage: leverage || 1,
        totalInvestment: totalInvestment ? String(totalInvestment) : '100',
        maxPositionSize: maxPositionSize || null,
        signalConfig: signalConfig || { longKeyword: 'LONG', shortKeyword: 'SHORT', exitKeyword: 'CLOSE' },
        riskConfig: riskConfig || {},
      } as any);

      const webhookUrl = generateWebhookUrl(bot.id, webhookSecret);
      await storage.updateTradingBot(bot.id, { webhookUrl } as any);

      res.json({
        ...bot,
        webhookUrl,
      });
    } catch (error) {
      console.error("Create trading bot error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.patch("/api/trading-bots/:id", requireWallet, async (req, res) => {
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const { name, market, side, leverage, maxPositionSize, totalInvestment, signalConfig, riskConfig, isActive, profitReinvest, autoWithdrawThreshold, autoTopUp } = req.body;
      
      if (leverage !== undefined) {
        const leverageNum = Number(leverage);
        if (isNaN(leverageNum) || leverageNum < 1 || leverageNum > 20 || !Number.isInteger(leverageNum)) {
          return res.status(400).json({ error: "Leverage must be an integer between 1 and 20" });
        }
      }
      
      // PAUSE BOT = CLOSE POSITION: If bot is being paused (isActive changing to false)
      // close any open position on Drift first
      let positionClosed = false;
      let closeError: string | null = null;
      
      if (isActive === false && bot.isActive === true) {
        console.log(`[Bot] Pausing bot ${bot.name} - checking for open positions to close`);
        
        // Get wallet for execution
        const wallet = await storage.getWallet(bot.walletAddress);
        if (!wallet?.agentPrivateKeyEncrypted || !wallet?.agentPublicKey) {
          // No agent wallet - check if there's a DB position we can't close
          const dbPosition = await storage.getBotPosition(bot.id, bot.market);
          if (dbPosition && parseFloat(dbPosition.baseSize) !== 0) {
            return res.status(400).json({ 
              error: "Cannot pause: Agent wallet not configured to close position",
              hasPosition: true,
              positionSize: dbPosition.baseSize,
            });
          }
        }
        
        // Query ACTUAL on-chain Drift position - NEVER fall back to database
        // This ensures we close the EXACT amount that exists on-chain
        const pauseSubAccountId = bot.driftSubaccountId ?? 0;
        let actualPositionSize = 0;
        
        let pauseEntryPrice = 0;
        let pauseOnChainPosition: any = null;
        try {
          const onChainPositions = await getPerpPositions(wallet!.agentPublicKey!, pauseSubAccountId);
          const marketName = bot.market.toUpperCase();
          pauseOnChainPosition = onChainPositions.find(p => 
            p.market.toUpperCase() === marketName || 
            p.market.toUpperCase().replace('-', '-') === marketName
          );
          actualPositionSize = pauseOnChainPosition?.baseAssetAmount || 0;
          pauseEntryPrice = pauseOnChainPosition?.entryPrice || 0;
          console.log(`[Bot] On-chain position for ${bot.market}: ${actualPositionSize} @ entry $${pauseEntryPrice}`);
        } catch (err) {
          console.error(`[Bot] CRITICAL: Failed to query on-chain position:`, err);
          // DO NOT fall back to database - that's what caused the bug!
          // Instead, fail the pause so user knows there's a problem
          return res.status(500).json({ 
            error: "Cannot pause: Failed to query on-chain position from Drift. Please try again.",
            details: err instanceof Error ? err.message : "Unknown error"
          });
        }
        
        if (Math.abs(actualPositionSize) > 0.0001 && wallet?.agentPrivateKeyEncrypted) {
          console.log(`[Bot] Found open position: ${actualPositionSize} ${bot.market} - closing before pause`);
          
          try {
            // Determine close side (opposite of current position)
            const closeSide: 'long' | 'short' = actualPositionSize > 0 ? 'short' : 'long';
            const closeSize = Math.abs(actualPositionSize);
            
            // Execute close order on Drift (reduce-only)
            const result = await executePerpOrder(
              wallet.agentPrivateKeyEncrypted,
              bot.market,
              closeSide,
              closeSize,
              pauseSubAccountId,
              true // reduceOnly
            );
            
            if (result.success && result.txSignature) {
              console.log(`[Bot] Position closed successfully: ${result.txSignature}`);
              
              // VERIFY position is actually closed by re-querying on-chain
              let verifyAttempts = 0;
              let positionVerified = false;
              while (verifyAttempts < 3 && !positionVerified) {
                try {
                  await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s for blockchain confirmation
                  const verifyPositions = await getPerpPositions(wallet.agentPublicKey!, pauseSubAccountId);
                  const verifyPosition = verifyPositions.find(p => 
                    p.market.toUpperCase() === bot.market.toUpperCase()
                  );
                  const remainingSize = Math.abs(verifyPosition?.baseAssetAmount || 0);
                  if (remainingSize < 0.0001) {
                    positionVerified = true;
                    console.log(`[Bot] Position verified closed on-chain`);
                  } else {
                    console.log(`[Bot] Position still shows ${remainingSize} on-chain, attempt ${verifyAttempts + 1}/3`);
                  }
                } catch (verifyErr) {
                  console.error(`[Bot] Position verify attempt ${verifyAttempts + 1} failed:`, verifyErr);
                }
                verifyAttempts++;
              }
              
              if (!positionVerified) {
                console.error(`[Bot] WARNING: Position close tx succeeded but verification failed - position may still be open`);
                closeError = "Close order sent but verification failed - please check Drift manually";
              }
              
              // Calculate fee (0.05% taker fee on notional value)
              const pauseFillPrice = result.fillPrice || 0;
              const closeNotional = closeSize * pauseFillPrice;
              const closeFee = closeNotional * DRIFT_FEE_RATE;
              
              // Calculate trade PnL for pause close
              let pauseClosePnl = 0;
              if (pauseEntryPrice > 0 && pauseFillPrice > 0) {
                if (closeSide === 'short') {
                  // Closing LONG: profit if exitPrice > entryPrice
                  pauseClosePnl = (pauseFillPrice - pauseEntryPrice) * closeSize - closeFee;
                } else {
                  // Closing SHORT: profit if entryPrice > exitPrice
                  pauseClosePnl = (pauseEntryPrice - pauseFillPrice) * closeSize - closeFee;
                }
                console.log(`[Bot] Pause close PnL: entry=$${pauseEntryPrice.toFixed(2)}, exit=$${pauseFillPrice.toFixed(2)}, size=${closeSize}, fee=$${closeFee.toFixed(4)}, pnl=$${pauseClosePnl.toFixed(4)}`);
              }
              
              // Create trade record for the close with PnL
              const closeTrade = await storage.createBotTrade({
                tradingBotId: bot.id,
                walletAddress: bot.walletAddress,
                market: bot.market,
                side: "CLOSE",
                size: String(closeSize),
                price: pauseFillPrice ? String(pauseFillPrice) : "0",
                fee: String(closeFee),
                pnl: pauseClosePnl !== 0 ? String(pauseClosePnl) : null,
                status: "executed",
                txSignature: result.txSignature,
                webhookPayload: { action: "pause_close", reason: "Bot paused by user", entryPrice: pauseEntryPrice, exitPrice: pauseFillPrice },
              });
              
              // Sync position from on-chain (replaces client-side math with actual Drift state)
              await syncPositionFromOnChain(
                bot.id,
                bot.walletAddress,
                wallet.agentPublicKey!,
                pauseSubAccountId,
                bot.market,
                closeTrade.id,
                closeFee,
                result.fillPrice || 0,
                closeSide,
                closeSize
              );
              
              positionClosed = positionVerified;
            } else {
              throw new Error(result.error || "Close order execution failed");
            }
          } catch (err: any) {
            console.error(`[Bot] Failed to close position on pause:`, err);
            closeError = err.message || "Failed to close position";
            // DON'T pause the bot if close failed - position is still open!
            return res.status(500).json({ 
              error: "Cannot pause: Failed to close open position on Drift",
              details: closeError,
              hasPosition: true,
              positionSize: actualPositionSize
            });
          }
        }
      }
      
      const updated = await storage.updateTradingBot(req.params.id, {
        ...(name && { name }),
        ...(market && { market }),
        ...(side && { side }),
        ...(leverage !== undefined && { leverage: Number(leverage) }),
        ...(totalInvestment !== undefined && { totalInvestment: String(totalInvestment) }),
        ...(maxPositionSize !== undefined && { maxPositionSize }),
        ...(signalConfig && { signalConfig }),
        ...(riskConfig && { riskConfig }),
        ...(isActive !== undefined && { isActive }),
        ...(isActive === true && { pauseReason: null }), // Clear pause reason when reactivating
        ...(profitReinvest !== undefined && { profitReinvest }),
        ...(autoWithdrawThreshold !== undefined && { autoWithdrawThreshold: autoWithdrawThreshold !== null ? String(autoWithdrawThreshold) : null }),
        ...(autoTopUp !== undefined && { autoTopUp }),
      });

      // Include position close info in response
      const response: any = { ...updated };
      if (positionClosed) {
        response.positionClosed = true;
        response.message = "Bot paused and open position was closed on Drift";
      } else if (closeError) {
        response.positionCloseError = closeError;
        response.message = "Bot paused but position close failed - please close manually";
      }

      res.json(response);
    } catch (error) {
      console.error("Update trading bot error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.delete("/api/trading-bots/:id", requireWallet, async (req, res) => {
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      // Get the wallet's agent public key - Drift accounts are under the AGENT wallet
      const wallet = await storage.getWallet(req.walletAddress!);
      const agentAddress = wallet?.agentPublicKey;
      
      // Check for pending profit share IOUs before allowing deletion
      const pendingIOUs = await storage.getPendingProfitSharesBySubscriberBot(req.params.id);
      if (pendingIOUs.length > 0) {
        const totalOwed = pendingIOUs.reduce((sum, iou) => sum + parseFloat(iou.amount), 0);
        console.log(`[Delete] Bot ${req.params.id} has ${pendingIOUs.length} pending IOUs totaling $${totalOwed.toFixed(4)}`);
        
        // Try to pay IOUs first if we have wallet access
        if (wallet?.agentPublicKey && wallet?.agentPrivateKeyEncrypted) {
          let allPaid = true;
          for (const iou of pendingIOUs) {
            const iouAmount = parseFloat(iou.amount);
            const transferResult = await transferUsdcToWallet(
              wallet.agentPublicKey,
              wallet.agentPrivateKeyEncrypted,
              iou.creatorWalletAddress,
              iouAmount
            );
            
            if (transferResult.success) {
              await storage.updatePendingProfitShareStatus(iou.id, { status: 'paid', lastAttemptAt: new Date() });
              console.log(`[Delete] Paid IOU ${iou.id}: $${iouAmount.toFixed(4)} to ${iou.creatorWalletAddress}`);
            } else {
              allPaid = false;
              console.error(`[Delete] Failed to pay IOU ${iou.id}: ${transferResult.error}`);
              break;
            }
          }
          
          if (!allPaid) {
            return res.status(400).json({
              error: `Cannot delete bot - you have $${totalOwed.toFixed(2)} in pending profit share payments to signal creators. Please fund your agent wallet and try again.`,
              pendingIOUs: pendingIOUs.length,
              totalOwed
            });
          }
        } else {
          return res.status(400).json({
            error: `Cannot delete bot - you have $${totalOwed.toFixed(2)} in pending profit share payments. Agent wallet access is required to pay these.`,
            pendingIOUs: pendingIOUs.length,
            totalOwed
          });
        }
      }
      
      // CRITICAL: If bot has a subaccount but wallet/agent is missing, refuse to delete
      // This prevents orphaning funds when wallet record is corrupted or missing
      if (bot.driftSubaccountId !== null && bot.driftSubaccountId !== undefined) {
        if (!wallet || !agentAddress) {
          console.error(`[Delete] CRITICAL: Bot ${bot.id} has subaccount ${bot.driftSubaccountId} but wallet/agent is missing`);
          return res.status(500).json({
            error: "Cannot verify bot funds - wallet data missing",
            driftSubaccountId: bot.driftSubaccountId,
            message: "Unable to check if this bot has funds. Please contact support."
          });
        }
      }
      
      if (!agentAddress) {
        // No agent wallet AND no subaccount assigned, safe to delete
        await storage.deleteTradingBot(req.params.id);
        return res.json({ success: true });
      }

      // Check if bot has a drift subaccount with potential funds
      if (bot.driftSubaccountId !== null && bot.driftSubaccountId !== undefined) {
        // Check if subaccount exists and has balance - use AGENT wallet address, not user wallet
        const exists = await subaccountExists(agentAddress, bot.driftSubaccountId);
        let withdrawnAmount = 0;
        let withdrawTxSignature: string | undefined;
        
        if (exists) {
          const balance = await getDriftBalance(agentAddress, bot.driftSubaccountId);
          
          // Only auto-withdraw for bots with ISOLATED subaccounts (non-zero)
          // Subaccount 0 is the shared main account - don't auto-withdraw from it
          if (bot.driftSubaccountId > 0) {
            // CRITICAL: Require encrypted key to withdraw, abort if missing
            if (!wallet.agentPrivateKeyEncrypted) {
              console.error(`[Delete] Cannot withdraw - agent key missing for bot ${bot.id}`);
              return res.status(500).json({
                error: "Cannot withdraw funds - wallet key missing",
                balance,
                driftSubaccountId: bot.driftSubaccountId,
                message: "Unable to access agent wallet to withdraw funds. Please contact support."
              });
            }

            // Always attempt to sweep funds from isolated subaccounts before deletion
            // Even tiny dust amounts can prevent subaccount closure on Drift
            console.log(`[Delete] Sweeping funds from isolated subaccount ${bot.driftSubaccountId} (reported balance: $${balance.toFixed(6)})`);
            
            try {
              // Step 1: Transfer ALL funds from bot's isolated subaccount to main account
              // Use a minimum of 0.000001 or the reported balance, whichever is higher
              const sweepAmount = Math.max(balance, 0.000001);
              console.log(`[Delete] Transferring $${sweepAmount.toFixed(6)} from subaccount ${bot.driftSubaccountId} to main account`);
              const transferResult = await executeAgentTransferBetweenSubaccounts(
                agentAddress,
                wallet.agentPrivateKeyEncrypted,
                bot.driftSubaccountId,
                0, // to main account
                sweepAmount
              );
              if (!transferResult.success) {
                // Transfer might fail if balance is already truly 0
                console.warn(`[Delete] Transfer warning: ${transferResult.error}`);
                // Continue to close attempt - might work if balance was already 0
              } else {
                console.log(`[Delete] Transfer successful: ${transferResult.signature}`);
                
                // Step 2: Withdraw the transferred amount from main account to agent wallet
                // Only withdraw if it's a meaningful amount (> $0.01 to save on tx fees)
                if (balance > 0.01) {
                  console.log(`[Delete] Withdrawing $${balance.toFixed(2)} from Drift to agent wallet`);
                  const withdrawResult = await executeAgentDriftWithdraw(
                    agentAddress,
                    wallet.agentPrivateKeyEncrypted,
                    balance,
                    0 // withdraw from main account
                  );
                  
                  if (withdrawResult.success) {
                    withdrawnAmount = balance;
                    withdrawTxSignature = withdrawResult.signature;
                    console.log(`[Delete] Withdrawal successful: ${withdrawResult.signature}`);
                  } else {
                    console.warn(`[Delete] Withdrawal warning: ${withdrawResult.error}`);
                    // Don't fail - funds are still in main Drift account, not lost
                  }
                } else if (balance > 0) {
                  console.log(`[Delete] Dust amount $${balance.toFixed(6)} transferred to main account (not withdrawing to save fees)`);
                }
              }
            } catch (err: any) {
              console.warn(`[Delete] Sweep error (continuing to close attempt):`, err.message);
              // Continue to close attempt - might work
            }
          } else if (balance > 0.01 && bot.driftSubaccountId === 0) {
            // Bot is on shared main account (subaccount 0) - warn but don't auto-withdraw
            console.log(`[Delete] Bot ${bot.id} is on shared subaccount 0 with $${balance.toFixed(2)} - not auto-withdrawing`);
          }
        }
        
        // Try to close the subaccount to reclaim rent (~0.023 SOL)
        let rentReclaimed = false;
        let rentReclaimError: string | undefined;
        
        // Edge case: subaccount exists but agent keys are missing (data corruption)
        if (exists && !wallet.agentPrivateKeyEncrypted && bot.driftSubaccountId > 0) {
          console.error(`[Delete] CRITICAL: Subaccount ${bot.driftSubaccountId} exists but agent keys missing - cannot auto-recover!`);
          console.error(`[Delete] User must use "Reset Drift Account" in Settings or manually close on Drift`);
          rentReclaimError = "Agent keys missing - manual recovery required";
        }
        
        if (exists && wallet.agentPrivateKeyEncrypted && bot.driftSubaccountId > 0) {
          console.log(`[Delete] Attempting to close subaccount ${bot.driftSubaccountId} to reclaim rent...`);
          try {
            const closeResult = await closeDriftSubaccount(
              wallet.agentPrivateKeyEncrypted,
              bot.driftSubaccountId
            );
            if (closeResult.success) {
              console.log(`[Delete] Subaccount ${bot.driftSubaccountId} closed, rent reclaimed: ${closeResult.signature}`);
              rentReclaimed = true;
            } else {
              console.error(`[Delete] RENT NOT RECLAIMED - subaccount ${bot.driftSubaccountId}: ${closeResult.error}`);
              rentReclaimError = closeResult.error;
            }
          } catch (closeErr: any) {
            console.error(`[Delete] RENT RECLAIM FAILED - subaccount ${bot.driftSubaccountId}:`, closeErr.message);
            rentReclaimError = closeErr.message;
          }
          
          // Track orphaned subaccount if rent could not be reclaimed
          if (!rentReclaimed && wallet.agentPrivateKeyEncrypted) {
            console.warn(`[Delete] Tracking orphaned subaccount ${bot.driftSubaccountId} for later cleanup`);
            try {
              await storage.createOrphanedSubaccount({
                walletAddress: req.walletAddress!,
                agentPublicKey: agentAddress,
                agentPrivateKeyEncrypted: wallet.agentPrivateKeyEncrypted,
                driftSubaccountId: bot.driftSubaccountId,
                reason: rentReclaimError,
              });
            } catch (orphanErr: any) {
              console.error(`[Delete] Failed to track orphaned subaccount:`, orphanErr.message);
            }
          }
        }
        
        await storage.deleteTradingBot(req.params.id);
        const rentReclaimPending = !rentReclaimed && bot.driftSubaccountId > 0;
        const needsManualRecovery = rentReclaimError?.includes('Agent keys missing');
        
        let message = 'Bot deleted';
        if (withdrawnAmount > 0) {
          message = `Automatically withdrew $${withdrawnAmount.toFixed(2)} USDC to your agent wallet`;
          if (rentReclaimed) {
            message += ' and reclaimed subaccount rent';
          } else if (needsManualRecovery) {
            message += '. Subaccount requires manual recovery via Settings.';
          } else if (rentReclaimPending) {
            message += '. Rent reclaim pending.';
          }
        } else if (rentReclaimed) {
          message = 'Subaccount closed and rent reclaimed';
        } else if (needsManualRecovery) {
          message = 'Bot deleted. Subaccount requires manual recovery - use "Reset Drift Account" in Settings.';
        } else if (rentReclaimPending) {
          message = 'Bot deleted. Subaccount rent reclaim pending.';
        }
        
        return res.json({ 
          success: true, 
          rentReclaimed,
          rentReclaimPending,
          needsManualRecovery,
          withdrawn: withdrawnAmount > 0,
          withdrawnAmount,
          withdrawTxSignature,
          message
        });
      }

      // Bot without driftSubaccountId - check subaccount 0 (main account) for safety
      // This prevents orphaning funds in the main Drift account
      const mainBalance = await getDriftBalance(agentAddress, 0);
      if (mainBalance > 0.01) {
        console.log(`[Delete] Warning: Main Drift account has $${mainBalance.toFixed(2)} - may be from this bot`);
        // Don't block deletion for main account funds, but log warning
        // Main account funds can still be withdrawn via wallet management
      }

      await storage.deleteTradingBot(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Delete trading bot error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Force delete with sweep - auto-withdraws funds before deletion
  app.delete("/api/trading-bots/:id/force", requireWallet, async (req, res) => {
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      // Get the wallet's agent public key - Drift accounts are under the AGENT wallet
      const wallet = await storage.getWallet(req.walletAddress!);
      const agentAddress = wallet?.agentPublicKey;
      
      // Check for pending profit share IOUs before allowing deletion
      const pendingIOUs = await storage.getPendingProfitSharesBySubscriberBot(req.params.id);
      if (pendingIOUs.length > 0) {
        const totalOwed = pendingIOUs.reduce((sum, iou) => sum + parseFloat(iou.amount), 0);
        console.log(`[ForceDelete] Bot ${req.params.id} has ${pendingIOUs.length} pending IOUs totaling $${totalOwed.toFixed(4)}`);
        
        // Try to pay IOUs first if we have wallet access
        if (wallet?.agentPublicKey && wallet?.agentPrivateKeyEncrypted) {
          let allPaid = true;
          for (const iou of pendingIOUs) {
            const iouAmount = parseFloat(iou.amount);
            const transferResult = await transferUsdcToWallet(
              wallet.agentPublicKey,
              wallet.agentPrivateKeyEncrypted,
              iou.creatorWalletAddress,
              iouAmount
            );
            
            if (transferResult.success) {
              await storage.updatePendingProfitShareStatus(iou.id, { status: 'paid', lastAttemptAt: new Date() });
              console.log(`[ForceDelete] Paid IOU ${iou.id}: $${iouAmount.toFixed(4)} to ${iou.creatorWalletAddress}`);
            } else {
              allPaid = false;
              console.error(`[ForceDelete] Failed to pay IOU ${iou.id}: ${transferResult.error}`);
              break;
            }
          }
          
          if (!allPaid) {
            return res.status(400).json({
              error: `Cannot delete bot - you have $${totalOwed.toFixed(2)} in pending profit share payments to signal creators. Please fund your agent wallet and try again.`,
              pendingIOUs: pendingIOUs.length,
              totalOwed
            });
          }
        } else {
          return res.status(400).json({
            error: `Cannot delete bot - you have $${totalOwed.toFixed(2)} in pending profit share payments. Agent wallet access is required to pay these.`,
            pendingIOUs: pendingIOUs.length,
            totalOwed
          });
        }
      }
      
      // CRITICAL: If bot has a subaccount but wallet/agent is missing, refuse to delete
      if (bot.driftSubaccountId !== null && bot.driftSubaccountId !== undefined) {
        if (!wallet || !agentAddress || !wallet.agentPrivateKeyEncrypted) {
          console.error(`[ForceDelete] CRITICAL: Bot ${bot.id} has subaccount ${bot.driftSubaccountId} but wallet/agent keys are missing`);
          return res.status(500).json({
            error: "Cannot sweep bot funds - wallet data missing",
            driftSubaccountId: bot.driftSubaccountId,
            message: "Unable to access the agent wallet to sweep funds. Please contact support."
          });
        }
      }
      
      if (!agentAddress) {
        // No agent wallet AND no subaccount assigned, safe to delete
        await storage.deleteTradingBot(req.params.id);
        return res.json({ success: true, swept: false });
      }

      // Must have a subaccount to sweep
      if (bot.driftSubaccountId === null || bot.driftSubaccountId === undefined) {
        // No subaccount, just delete directly
        await storage.deleteTradingBot(req.params.id);
        return res.json({ success: true, swept: false });
      }

      // Check balance using correct agent wallet address
      const balance = await getDriftBalance(agentAddress, bot.driftSubaccountId);
      
      if (balance <= 0.01) {
        // No meaningful balance, try to close subaccount to reclaim rent
        let rentReclaimed = false;
        if (wallet.agentPrivateKeyEncrypted) {
          try {
            const closeResult = await closeDriftSubaccount(
              wallet.agentPrivateKeyEncrypted,
              bot.driftSubaccountId
            );
            if (closeResult.success) {
              console.log(`[Delete] Subaccount ${bot.driftSubaccountId} closed, rent reclaimed`);
              rentReclaimed = true;
            }
          } catch (closeErr) {
            console.warn(`[Delete] Rent reclaim failed:`, closeErr);
          }
        }
        await storage.deleteTradingBot(req.params.id);
        return res.json({ success: true, swept: false, rentReclaimed });
      }

      // Auto-sweep: Transfer funds from bot's subaccount to main account (subaccount 0)
      // This is done server-side using the agent wallet
      if (wallet.agentPrivateKeyEncrypted && bot.driftSubaccountId !== 0) {
        try {
          console.log(`[Delete] Auto-sweeping $${balance.toFixed(2)} from subaccount ${bot.driftSubaccountId} to main account`);
          const sweepResult = await executeAgentTransferBetweenSubaccounts(
            agentAddress,
            wallet.agentPrivateKeyEncrypted,
            bot.driftSubaccountId,
            0, // to main account
            balance
          );
          
          if (sweepResult.success) {
            console.log(`[Delete] Sweep successful: ${sweepResult.signature}`);
            
            // Try to close the now-empty subaccount
            let rentReclaimed = false;
            try {
              const closeResult = await closeDriftSubaccount(
                wallet.agentPrivateKeyEncrypted,
                bot.driftSubaccountId
              );
              if (closeResult.success) {
                console.log(`[Delete] Subaccount ${bot.driftSubaccountId} closed, rent reclaimed`);
                rentReclaimed = true;
              }
            } catch (closeErr) {
              console.warn(`[Delete] Rent reclaim failed:`, closeErr);
            }
            
            await storage.deleteTradingBot(req.params.id);
            return res.json({ 
              success: true, 
              swept: true, 
              amount: balance,
              txSignature: sweepResult.signature,
              rentReclaimed,
              message: `Swept $${balance.toFixed(2)} USDC to main account before deletion`
            });
          } else {
            // Sweep failed - don't delete, let user know
            return res.status(500).json({
              error: "Failed to sweep funds before deletion",
              sweepError: sweepResult.error,
              balance,
              driftSubaccountId: bot.driftSubaccountId,
              message: `Could not transfer $${balance.toFixed(2)} from subaccount. Please withdraw manually first.`
            });
          }
        } catch (sweepErr: any) {
          console.error(`[Delete] Sweep error:`, sweepErr);
          return res.status(500).json({
            error: "Sweep transaction failed",
            details: sweepErr.message,
            balance,
            driftSubaccountId: bot.driftSubaccountId
          });
        }
      }

      // Subaccount 0 or no encrypted key - can't auto-sweep, inform user
      return res.status(409).json({
        error: "Bot has funds in main Drift account",
        balance,
        driftSubaccountId: bot.driftSubaccountId,
        message: `This bot has $${balance.toFixed(2)} USDC. Please withdraw from Drift to Agent Wallet first via Wallet Management.`
      });
    } catch (error) {
      console.error("Force delete trading bot error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Confirm deletion after sweep transaction is confirmed (legacy endpoint)
  app.post("/api/trading-bots/:id/confirm-delete", requireWallet, async (req, res) => {
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const { txSignature } = req.body;
      
      // Get the wallet's agent key for subaccount operations
      const wallet = await storage.getWallet(req.walletAddress!);

      // Safety check: verify wallet exists for bots with subaccounts
      if (bot.driftSubaccountId !== null && bot.driftSubaccountId !== undefined && !wallet?.agentPublicKey) {
        console.error(`[ConfirmDelete] Warning: Bot ${bot.id} has subaccount but wallet is missing`);
        // Still allow deletion since this is a confirmation after user signed sweep tx
      }

      // Try to close the subaccount to reclaim rent (~0.035 SOL)
      let rentReclaimed = false;
      if (bot.driftSubaccountId !== null && bot.driftSubaccountId !== undefined && wallet?.agentPrivateKeyEncrypted) {
        try {
          const closeResult = await closeDriftSubaccount(
            wallet.agentPrivateKeyEncrypted,
            bot.driftSubaccountId
          );
          if (closeResult.success) {
            console.log(`[Delete] Subaccount ${bot.driftSubaccountId} closed after sweep, rent reclaimed`);
            rentReclaimed = true;
          } else {
            console.warn(`[Delete] Could not reclaim rent after sweep: ${closeResult.error}`);
          }
        } catch (closeErr) {
          console.warn(`[Delete] Rent reclaim failed after sweep:`, closeErr);
        }
      }

      await storage.deleteTradingBot(req.params.id);
      res.json({ success: true, txSignature, rentReclaimed });
    } catch (error) {
      console.error("Confirm delete trading bot error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Bot trades routes
  app.get("/api/trading-bots/:id/trades", requireWallet, async (req, res) => {
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
      const trades = await storage.getBotTrades(req.params.id, limit);
      res.json(trades);
    } catch (error) {
      console.error("Get bot trades error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/trading-bots/:id/performance", requireWallet, async (req, res) => {
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const timeframe = (req.query.timeframe as string) || '7d';
      let since: Date | undefined;
      const now = new Date();
      switch (timeframe) {
        case '7d':
          since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case '30d':
          since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
        case '90d':
          since = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
          break;
        case 'all':
        default:
          since = undefined;
          break;
      }

      const tradeSeries = await storage.getBotPerformanceSeries(req.params.id, since);
      
      // Add initial 0 point at bot creation date for proper chart baseline
      const botCreatedAt = new Date(bot.createdAt);
      const initialPoint = {
        timestamp: botCreatedAt,
        pnl: 0,
        cumulativePnl: 0,
      };
      
      // Only add initial point if it's before the first trade and within requested timeframe
      let series = tradeSeries;
      const shouldAddInitialPoint = !since || botCreatedAt >= since;
      if (shouldAddInitialPoint) {
        if (tradeSeries.length === 0 || botCreatedAt < tradeSeries[0].timestamp) {
          series = [initialPoint, ...tradeSeries];
        }
      }
      
      const totalPnl = tradeSeries.length > 0 ? tradeSeries[tradeSeries.length - 1].cumulativePnl : 0;
      res.json({
        series,
        totalPnl,
        tradeCount: tradeSeries.length,
      });
    } catch (error) {
      console.error("Get bot performance error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/bot-trades", requireWallet, async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
      const trades = await storage.getWalletBotTrades(req.walletAddress!, limit);
      res.json(trades);
    } catch (error) {
      console.error("Get wallet bot trades error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get bot's current position
  app.get("/api/trading-bots/:id/position", requireWallet, async (req, res) => {
    try {
      const bot = await storage.getTradingBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const wallet = await storage.getWallet(bot.walletAddress);
      if (!wallet?.agentPublicKey) {
        return res.json({ hasPosition: false, source: 'none' });
      }

      const subAccountId = bot.driftSubaccountId ?? 0;
      
      // Use PositionService - always queries on-chain first, auto-corrects database drift
      const posData = await PositionService.getPosition(
        bot.id,
        bot.walletAddress,
        wallet.agentPublicKey,
        subAccountId,
        bot.market,
        wallet.agentPrivateKeyEncrypted ?? undefined
      );

      if (!posData.position?.hasPosition) {
        return res.json({ 
          hasPosition: false, 
          source: posData.source,
          driftDetected: posData.driftDetected,
        });
      }

      res.json({
        hasPosition: true,
        side: posData.position.side,
        size: posData.position.size,
        avgEntryPrice: posData.position.avgEntryPrice,
        currentPrice: posData.position.currentPrice,
        unrealizedPnl: posData.position.unrealizedPnl,
        realizedPnl: posData.position.realizedPnl,
        market: posData.position.market,
        source: posData.source,
        staleWarning: posData.staleWarning,
        driftDetected: posData.driftDetected,
        driftDetails: posData.driftDetails,
        healthFactor: posData.healthMetrics?.healthFactor,
        liquidationPrice: posData.healthMetrics?.liquidationPrice,
        totalCollateral: posData.healthMetrics?.totalCollateral,
        freeCollateral: posData.healthMetrics?.freeCollateral,
      });
    } catch (error) {
      console.error("Get bot position error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // TradingView Webhook endpoint - receives signals from TradingView strategy alerts
  app.post("/api/webhook/tradingview/:botId", async (req, res) => {
    const { botId } = req.params;
    const { secret } = req.query;

    // Generate signal hash for deduplication
    const signalHash = generateSignalHash(botId, req.body);
    
    // Log webhook with signal hash - unique index prevents concurrent duplicates
    let log;
    try {
      log = await storage.createWebhookLog({
        tradingBotId: botId,
        payload: req.body,
        headers: req.headers as any,
        ipAddress: req.ip || req.headers['x-forwarded-for'] as string,
        processed: false,
        signalHash,
      });
    } catch (dbError: any) {
      // Unique constraint violation means this signal was already received
      if (dbError?.code === '23505') {
        console.log(`[Webhook] Duplicate signal blocked at creation: hash=${signalHash}`);
        return res.status(200).json({ status: "skipped", reason: "duplicate signal" });
      }
      // Foreign key violation means the bot was deleted
      if (dbError?.code === '23503') {
        console.log(`[Webhook] Bot ${botId} not found (deleted) - ignoring signal`);
        return res.status(404).json({ error: "Bot not found - it may have been deleted. Please remove this alert from TradingView." });
      }
      throw dbError;
    }

    try {
      // Get bot
      const bot = await storage.getTradingBotById(botId);
      if (!bot) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Bot not found" });
        return res.status(404).json({ error: "Bot not found" });
      }

      // Validate secret
      if (secret !== bot.webhookSecret) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Invalid secret" });
        return res.status(401).json({ error: "Invalid secret" });
      }

      // Check if bot is active
      if (!bot.isActive) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Bot is paused" });
        return res.status(400).json({ error: "Bot is paused" });
      }

      // Security v3: Check execution authorization
      const ownerWallet = await storage.getWallet(bot.walletAddress);
      if (!ownerWallet) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Wallet not found" });
        return res.status(404).json({ error: "Wallet not found" });
      }
      
      if (ownerWallet.emergencyStopTriggered) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Execution blocked: Emergency stop active" });
        return res.status(403).json({ error: "Trade execution blocked: Emergency stop is active for this wallet" });
      }
      
      if (!ownerWallet.executionEnabled) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Execution blocked: Authorization required" });
        return res.status(403).json({ error: "Trade execution disabled. Please enable automated trading in the app." });
      }
      
      if (ownerWallet.executionExpiresAt && new Date() > ownerWallet.executionExpiresAt) {
        // Clear expired execution authorization
        await storage.updateWalletExecution(bot.walletAddress, {
          executionEnabled: false,
          umkEncryptedForExecution: null,
          executionExpiresAt: null,
        });
        await storage.updateWebhookLog(log.id, { errorMessage: "Execution blocked: Authorization expired" });
        return res.status(403).json({ error: "Trade execution authorization expired. Please re-enable automated trading." });
      }

      // Security v3: Verify execution key can be unwrapped (validates SERVER_EXECUTION_KEY is correct)
      // This ensures the EUMK_exec is valid and the server has the correct key material
      const umkResult = await getUmkForWebhook(bot.walletAddress);
      if (!umkResult) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Execution blocked: Invalid execution authorization" });
        return res.status(403).json({ error: "Invalid execution authorization. Please re-enable automated trading." });
      }
      
      // Security v3: Verify bot policy HMAC if one exists (detects tampering with critical settings)
      if (bot.policyHmac) {
        const policyValid = verifyBotPolicyHmac(
          umkResult.umk,
          { market: bot.market, leverage: bot.leverage || 1, maxPositionSize: bot.maxPositionSize },
          bot.policyHmac
        );
        if (!policyValid) {
          umkResult.cleanup();
          await storage.updateWebhookLog(log.id, { errorMessage: "Execution blocked: Bot policy tampered" });
          return res.status(403).json({ error: "Bot configuration has been tampered with. Please reconfigure the bot." });
        }
      }
      
      // Security v3: Decrypt agent key via v3 path (Phase 6.2 - use pre-decrypted key)
      const agentKeyResult = await decryptAgentKeyWithFallback(
        bot.walletAddress,
        umkResult.umk,
        ownerWallet
      );
      
      // Cleanup the unwrapped UMK immediately after deriving agent key
      umkResult.cleanup();
      
      if (!agentKeyResult) {
        // Agent key decryption failed - this is a critical error
        await storage.updateWebhookLog(log.id, { errorMessage: "Execution blocked: Agent key decryption failed" });
        return res.status(403).json({ error: "Agent key decryption failed. Please reconfigure your agent wallet." });
      }
      
      // Log migration status for tracking
      const usedV3 = ownerWallet.agentPrivateKeyEncryptedV3 ? true : false;
      if (usedV3) {
        console.log(`[Webhook] Agent key decryption: v3 path used for ${bot.walletAddress.slice(0, 8)}...`);
      } else {
        console.log(`[Webhook] Agent key decryption: legacy fallback used for ${bot.walletAddress.slice(0, 8)}... (v3 not yet migrated)`);
      }
      
      // Helper to cleanup agent key after use (defined early for use in error paths)
      const cleanupAgentKey = () => {
        agentKeyResult.cleanup();
      };
      
      // DEBUG: Validate secret key bytes before encoding
      const nonZeroBytes = Array.from(agentKeyResult.secretKey).filter(b => b !== 0).length;
      console.log(`[Webhook] Secret key validation: length=${agentKeyResult.secretKey.length}, nonZeroBytes=${nonZeroBytes}`);
      if (nonZeroBytes === 0) {
        cleanupAgentKey();
        await storage.updateWebhookLog(log.id, { errorMessage: "Agent key is all zeros - possible encryption/decryption issue" });
        return res.status(500).json({ error: "Agent key decryption produced invalid key (all zeros). Please reconfigure your agent wallet." });
      }
      
      // Convert secretKey (Uint8Array) to base58 for passing to executor
      const privateKeyBase58 = bs58.encode(agentKeyResult.secretKey);
      
      // DEBUG: Log base58 key length and first few chars (not the full key for security)
      console.log(`[Webhook] Base58 key: length=${privateKeyBase58.length}, starts=${privateKeyBase58.slice(0, 4)}...`);

      // PHASE 6.2: Wrap execution in try/finally to ensure agent key cleanup
      try {

      // Parse TradingView strategy signal
      // Expected JSON format:
      // {
      //   "signalType": "trade",
      //   "data": { "action": "buy", "contracts": "33.33", "positionSize": "100" },
      //   "symbol": "SOLUSD",
      //   "price": "195.50",
      //   "time": "2025-01-09T12:00:00Z",
      //   "position_size": "0"  // NEW: strategy.position_size - 0 means closing position (SL/TP)
      // }
      const payload = req.body;
      let action: string | null = null;
      let contracts: string = "0";
      let positionSize: string = bot.maxPositionSize || "100";
      let strategyPositionSize: string | null = null; // NEW: Track strategy.position_size for close detection
      let ticker: string = "";
      let signalPrice: string = "0";
      let signalTime: string | null = null;

      // CRITICAL FIX: Extract position_size from payload FIRST, before any format-specific parsing
      // This ensures close signal detection works regardless of payload format
      if (typeof payload === 'object' && payload !== null) {
        // Check for position_size at root level (most common format)
        if (payload.position_size !== undefined) {
          strategyPositionSize = String(payload.position_size);
          console.log(`[Webhook] Extracted position_size from root: "${strategyPositionSize}"`);
        }
        // Also check nested data.position_size
        if (payload.data && payload.data.position_size !== undefined) {
          strategyPositionSize = String(payload.data.position_size);
          console.log(`[Webhook] Extracted position_size from data: "${strategyPositionSize}"`);
        }
        // Extract other common fields from root level
        if (payload.action) action = String(payload.action).toLowerCase();
        if (payload.contracts) contracts = String(payload.contracts);
        if (payload.price) signalPrice = String(payload.price);
        if (payload.time) signalTime = String(payload.time);
        if (payload.symbol) ticker = String(payload.symbol);
      }

      // Try parsing as the new JSON format first
      if (typeof payload === 'object' && payload.signalType === 'trade' && payload.data) {
        // New JSON format
        if (payload.data.action) action = payload.data.action.toLowerCase();
        if (payload.data.contracts) contracts = String(payload.data.contracts);
        if (payload.data.positionSize) positionSize = String(payload.data.positionSize);
        if (payload.symbol) ticker = String(payload.symbol);
        if (payload.price) signalPrice = String(payload.price);
        if (payload.time) signalTime = String(payload.time);
        // Parse strategy.position_size for close signal detection
        if (payload.position_size !== undefined) strategyPositionSize = String(payload.position_size);
        if (payload.data.position_size !== undefined) strategyPositionSize = String(payload.data.position_size);
        console.log(`[Webhook] Parsed JSON signal: action=${action}, contracts=${contracts}, symbol=${ticker}, price=${signalPrice}, time=${signalTime}, strategyPositionSize=${strategyPositionSize}`);
      } else {
        // Fallback: legacy format parsing
        const message = typeof payload === 'string' ? payload : 
                        typeof payload === 'object' && payload.message ? payload.message :
                        typeof payload === 'object' ? JSON.stringify(payload) : String(payload);

        // Try regex parsing for legacy format: "order buy @ 33.33 filled on TICKER. New strategy position is 100"
        const regex = /order\s+(buy|sell)\s+@\s+([\d.]+)\s+filled\s+on\s+([A-Za-z0-9:\-/]+).*position\s+is\s+([-\d.]+)/i;
        const match = message.match(regex);

        if (match) {
          action = match[1].toLowerCase();
          contracts = match[2];
          ticker = match[3];
          positionSize = match[4];
          strategyPositionSize = match[4]; // Legacy format includes position size
        } else {
          // Fallback: try simple JSON parsing
          try {
            const parsed = typeof payload === 'object' ? payload : JSON.parse(message);
            if (parsed.action) action = parsed.action.toLowerCase();
            if (parsed.contracts) contracts = String(parsed.contracts);
            if (parsed.position_size !== undefined) {
              positionSize = String(parsed.position_size);
              strategyPositionSize = String(parsed.position_size);
            }
          } catch {
            // Last resort: simple keyword detection
            const text = message.toLowerCase();
            if (text.includes('buy')) action = 'buy';
            else if (text.includes('sell')) action = 'sell';
          }
        }
        console.log(`[Webhook] Parsed legacy signal: action=${action}, contracts=${contracts}, strategyPositionSize=${strategyPositionSize}`);
      }

      // Map TradingView action to trade side
      let side: 'long' | 'short' | null = null;
      if (action === 'buy') {
        side = 'long';
      } else if (action === 'sell') {
        side = 'short';
      }

      // Check if bot allows this side
      if (side && bot.side !== 'both') {
        if (bot.side === 'long' && side !== 'long') {
          await storage.updateWebhookLog(log.id, { errorMessage: "Bot only accepts long signals", processed: true });
          return res.status(400).json({ error: "Bot only accepts long signals" });
        }
        if (bot.side === 'short' && side !== 'short') {
          await storage.updateWebhookLog(log.id, { errorMessage: "Bot only accepts short signals", processed: true });
          return res.status(400).json({ error: "Bot only accepts short signals" });
        }
      }

      if (!side) {
        await storage.updateWebhookLog(log.id, { errorMessage: "No valid action found (expected buy or sell)", processed: true });
        return res.status(400).json({ error: "No valid action found", received: payload });
      }

      // CLOSE SIGNAL DETECTION: Check if this is a position close signal (SL/TP)
      // TradingView sends strategy.position_size = 0 when closing a position
      const isCloseSignal = strategyPositionSize !== null && 
        (strategyPositionSize === "0" || parseFloat(strategyPositionSize) === 0);
      
      console.log(`[Webhook] Signal analysis: action=${action}, contracts=${contracts}, strategyPositionSize=${strategyPositionSize}, isCloseSignal=${isCloseSignal}`);
      
      // CRITICAL FIX: Wrap entire close signal handling in outer try/catch to guarantee no fallthrough
      // to open-order logic. Any exception inside this block MUST return, not continue to open-order flow.
      if (isCloseSignal) {
        console.log(`[Webhook] *** CLOSE SIGNAL DETECTED *** (strategyPositionSize=${strategyPositionSize}) - Entering close handler (GUARANTEED RETURN)`);
        
        try {
          // === BEGIN CLOSE SIGNAL HANDLING - All paths must return ===
        
        // Get wallet for execution
        const wallet = await storage.getWallet(bot.walletAddress);
        if (!wallet?.agentPrivateKeyEncrypted || !wallet?.agentPublicKey) {
          await storage.updateWebhookLog(log.id, { errorMessage: "Agent wallet not configured for close", processed: true });
          return res.status(400).json({ error: "Agent wallet not configured" });
        }
        
        const subAccountId = bot.driftSubaccountId ?? 0;
        console.log(`[Webhook] Close signal: querying on-chain position for bot=${bot.name}, market=${bot.market}, subaccount=${subAccountId}`);
        
        // CRITICAL: Query on-chain position directly - NEVER trust database for close signals
        let onChainPosition;
        try {
          onChainPosition = await PositionService.getPositionForExecution(
            botId,
            wallet.agentPublicKey,
            subAccountId,
            bot.market,
            wallet.agentPrivateKeyEncrypted
          );
          console.log(`[Webhook] On-chain position query result: size=${onChainPosition.size}, side=${onChainPosition.side}, entryPrice=${onChainPosition.entryPrice}`);
        } catch (onChainErr) {
          console.error(`[Webhook] CRITICAL: Failed to query on-chain position for close:`, onChainErr);
          await storage.updateWebhookLog(log.id, { 
            errorMessage: "Failed to query on-chain position - cannot safely close", 
            processed: true 
          });
          return res.status(500).json({ error: "Failed to query on-chain position" });
        }
        
        if (onChainPosition.side === 'FLAT' || Math.abs(onChainPosition.size) < 0.0001) {
          // No position to close - this is likely a SL/TP for a position that doesn't exist in this bot
          console.log(`[Webhook] Close signal SKIPPED - no on-chain position found for bot ${bot.name} on ${bot.market} (subaccount ${subAccountId})`);
          await storage.updateWebhookLog(log.id, { 
            errorMessage: "Close signal ignored - no on-chain position", 
            processed: true 
          });
          return res.status(200).json({ 
            status: "skipped", 
            reason: "No on-chain position to close - this may be a stale SL/TP signal" 
          });
        }
        
        // There IS an on-chain position to close - use ACTUAL on-chain size
        const currentPositionSize = onChainPosition.size;
        console.log(`[Webhook] *** EXECUTING CLOSE *** ON-CHAIN position: ${onChainPosition.side} ${Math.abs(currentPositionSize)} contracts on ${bot.market}`);
        
        // Determine close side (opposite of current position)
        const closeSide = onChainPosition.side === 'LONG' ? 'short' : 'long';
        const closeSize = Math.abs(currentPositionSize);
        
        // Capture entry price BEFORE trying to close (needed for retry queue if close fails)
        const closeEntryPrice = onChainPosition.entryPrice || 0;
        
        // Create trade record for the close
        const closeTrade = await storage.createBotTrade({
          tradingBotId: botId,
          walletAddress: bot.walletAddress,
          market: bot.market,
          side: "CLOSE",
          size: String(closeSize),
          price: signalPrice,
          status: "pending",
          webhookPayload: payload,
        });
        
        try {
          // Execute close order on Drift using closePerpPosition
          // CRITICAL: Do NOT pass closeSize - let the subprocess query exact BN from DriftClient
          // This prevents JavaScript float precision loss (e.g., 0.4374 → 437399999 instead of 437400000)
          const subAccountId = bot.driftSubaccountId ?? 0;
          const closeSlippageBps2 = wallet.slippageBps ?? 50;
          console.log(`[Webhook] Using closePerpPosition (exact BN precision) for closeSize=${closeSize}, slippage=${closeSlippageBps2}bps`);
          const result = await closePerpPosition(
            wallet.agentPrivateKeyEncrypted,
            bot.market,
            subAccountId,
            undefined,
            closeSlippageBps2,
            privateKeyBase58
          );
          
          // closePerpPosition returns { success, signature, error } - map to expected format
          const txSignature = result.signature || null;
          
          // Handle case where subprocess found no position to close (success=true, signature=null)
          // This is a benign case - position was already flat or closed by another process
          if (result.success && !txSignature) {
            console.log(`[Webhook] closePerpPosition returned success but no signature - position was already closed`);
            await storage.updateBotTrade(closeTrade.id, { 
              status: "executed",
              txSignature: null,
              errorMessage: "Position already closed (no trade executed)"
            });
            await storage.updateWebhookLog(log.id, { 
              processed: true, 
              tradeExecuted: false,
              errorMessage: "Close signal processed - position was already flat"
            });
            return res.json({
              status: "success",
              type: "close",
              trade: closeTrade.id,
              message: "Position was already closed (no trade executed)",
            });
          }
          
          if (result.success && txSignature) {
            // Calculate fee (0.05% taker fee on notional value)
            // Since closePerpPosition doesn't return fillPrice, use the signal price as estimate
            const closeFillPrice = parseFloat(signalPrice) || 0;
            const closeNotional = closeSize * closeFillPrice;
            const closeFee = closeNotional * DRIFT_FEE_RATE;
            
            // Calculate trade PnL based on entry and exit prices
            // IMPORTANT: closeEntryPrice was captured BEFORE close attempt
            console.log(`[Webhook] PnL calculation inputs: entryPrice=${closeEntryPrice}, fillPrice=${closeFillPrice}, closeSide=${closeSide}, closeSize=${closeSize}`);
            
            let closeTradePnl = 0;
            if (closeEntryPrice > 0 && closeFillPrice > 0) {
              if (closeSide === 'short') {
                // Closing LONG: profit if exitPrice > entryPrice
                closeTradePnl = (closeFillPrice - closeEntryPrice) * closeSize - closeFee;
              } else {
                // Closing SHORT: profit if entryPrice > exitPrice
                closeTradePnl = (closeEntryPrice - closeFillPrice) * closeSize - closeFee;
              }
              console.log(`[Webhook] Close PnL CALCULATED: entry=$${closeEntryPrice.toFixed(2)}, exit=$${closeFillPrice.toFixed(2)}, size=${closeSize}, fee=$${closeFee.toFixed(4)}, pnl=$${closeTradePnl.toFixed(4)}`);
            } else {
              console.warn(`[Webhook] PnL NOT calculated: entryPrice=${closeEntryPrice}, fillPrice=${closeFillPrice} - one or both are zero`);
            }
            
            // CRITICAL: Verify on-chain that position is actually closed and retry if dust remains
            // This handles partial fills and ensures position is truly flat
            // Use 1s delays with 5 retries (~5s total to stay within HTTP timeout)
            let finalTxSignature = txSignature;
            let retryCount = 0;
            const maxRetries = 5; // Increased from 3 to 5 for stubborn dust
            
            while (retryCount < maxRetries) {
              try {
                // Wait 1s for on-chain state to settle - consistent delay keeps total under HTTP timeout
                const delayMs = 1000;
                console.log(`[Webhook] Waiting ${delayMs}ms for on-chain state to settle (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
                
                const postClosePosition = await PositionService.getPositionForExecution(
                  botId,
                  wallet.agentPublicKey,
                  subAccountId,
                  bot.market,
                  wallet.agentPrivateKeyEncrypted
                );
                
                if (postClosePosition.side === 'FLAT' || Math.abs(postClosePosition.size) < 0.0001) {
                  console.log(`[Webhook] Post-close verification: Position confirmed FLAT`);
                  break; // Position fully closed, exit retry loop
                }
                
                // Position still exists - this is dust that needs cleanup
                console.warn(`[Webhook] Position NOT fully closed after close order (attempt ${retryCount + 1}/${maxRetries})`);
                console.warn(`[Webhook] Remaining dust: ${postClosePosition.side} ${Math.abs(postClosePosition.size).toFixed(6)} contracts - attempting cleanup...`);
                
                // Retry closePerpPosition to clean up the dust
                const webhookDustSlippageBps = wallet.slippageBps ?? 50;
                const retryResult = await closePerpPosition(
                  wallet.agentPrivateKeyEncrypted,
                  bot.market,
                  subAccountId,
                  undefined,
                  webhookDustSlippageBps,
                  privateKeyBase58
                );
                
                if (retryResult.success && retryResult.signature) {
                  console.log(`[Webhook] Dust cleanup attempt ${retryCount + 1} succeeded: ${retryResult.signature}`);
                  finalTxSignature = retryResult.signature; // Use the latest successful signature
                } else if (retryResult.success && !retryResult.signature) {
                  console.log(`[Webhook] Dust cleanup: position already closed`);
                  break;
                } else {
                  console.error(`[Webhook] Dust cleanup attempt ${retryCount + 1} failed:`, retryResult.error);
                }
                
                retryCount++;
              } catch (verifyErr) {
                console.warn(`[Webhook] Could not verify/cleanup post-close position (attempt ${retryCount + 1}):`, verifyErr);
                retryCount++;
              }
            }
            
            // Final verification after all retries
            let finalPositionRemaining = null;
            try {
              const finalCheck = await PositionService.getPositionForExecution(
                botId,
                wallet.agentPublicKey,
                subAccountId,
                bot.market,
                wallet.agentPrivateKeyEncrypted
              );
              if (finalCheck.side !== 'FLAT' && Math.abs(finalCheck.size) > 0.0001) {
                finalPositionRemaining = { side: finalCheck.side, size: finalCheck.size };
                console.error(`[Webhook] CRITICAL: Position still not flat after ${maxRetries} cleanup attempts!`);
                console.error(`[Webhook] Final remaining: ${finalCheck.side} ${finalCheck.size}`);
              }
            } catch (finalVerifyErr) {
              console.warn(`[Webhook] Could not perform final position verification:`, finalVerifyErr);
            }
            
            // If dust still remains after all retries, log error but continue
            if (finalPositionRemaining) {
              await storage.updateBotTrade(closeTrade.id, {
                status: "executed",
                txSignature: finalTxSignature,
                price: signalPrice,
                fee: String(closeFee),
                pnl: closeTradePnl !== 0 ? String(closeTradePnl) : null,
                errorMessage: `WARNING: Position not fully closed after ${maxRetries} attempts. Remaining: ${finalPositionRemaining.side} ${finalPositionRemaining.size}`,
              });
              
              await storage.updateWebhookLog(log.id, { 
                processed: true, 
                tradeExecuted: true,
                errorMessage: `Close executed but dust remains after ${maxRetries} attempts: ${finalPositionRemaining.side} ${finalPositionRemaining.size}`
              });
              
              return res.json({
                status: "partial",
                warning: `Position not fully closed after ${maxRetries} attempts - dust remains`,
                type: "close",
                trade: closeTrade.id,
                txSignature: finalTxSignature,
                closedSize: closeSize,
                side: closeSide,
                remainingPosition: finalPositionRemaining,
              });
            }
            
            // Update trade record with execution details and PnL (use finalTxSignature which may include retry signatures)
            await storage.updateBotTrade(closeTrade.id, {
              status: "executed",
              txSignature: finalTxSignature,
              price: signalPrice,
              fee: String(closeFee),
              pnl: closeTradePnl !== 0 ? String(closeTradePnl) : null,
            });
            
            // Sync position from on-chain (replaces client-side math with actual Drift state)
            const syncResult = await syncPositionFromOnChain(
              botId,
              bot.walletAddress,
              wallet.agentPublicKey!,
              subAccountId,
              bot.market,
              closeTrade.id,
              closeFee,
              closeFillPrice,
              closeSide,
              closeSize
            );
            
            // Update bot stats (including volume for FUEL tracking)
            const closeNotionalVolume = closeSize * closeFillPrice;
            const stats = bot.stats as TradingBot['stats'] || { totalTrades: 0, winningTrades: 0, losingTrades: 0, totalPnl: 0, totalVolume: 0 };
            await storage.updateTradingBotStats(botId, {
              ...stats,
              totalTrades: (stats.totalTrades || 0) + 1,
              winningTrades: syncResult.isClosingTrade && (syncResult.tradePnl ?? 0) > 0 ? (stats.winningTrades || 0) + 1 : (stats.winningTrades || 0),
              losingTrades: syncResult.isClosingTrade && (syncResult.tradePnl ?? 0) < 0 ? (stats.losingTrades || 0) + 1 : (stats.losingTrades || 0),
              totalPnl: (stats.totalPnl || 0) + (syncResult.tradePnl ?? 0),
              totalVolume: (stats.totalVolume || 0) + closeNotionalVolume,
              lastTradeAt: new Date().toISOString(),
            });
            
            await storage.updateWebhookLog(log.id, { processed: true, tradeExecuted: true });
            
            // Send position closed notification
            sendTradeNotification(wallet.address, {
              type: 'position_closed',
              botName: bot.name,
              market: bot.market,
              pnl: closeTradePnl,
            }).catch(err => console.error('[Notifications] Failed to send position_closed notification:', err));
            
            // Route close signal to subscriber bots (async, don't block response)
            routeSignalToSubscribers(botId, {
              action: action as 'buy' | 'sell',
              contracts,
              positionSize,
              price: signalPrice || closeFillPrice.toString(),
              isCloseSignal: true,
              strategyPositionSize,
            }).catch(err => console.error('[Subscriber Routing] Error routing close to subscribers:', err));
            
            // PROFIT SHARE: If this is a subscriber bot with profitable close, distribute to creator
            // This must happen BEFORE auto-withdraw to ensure creator gets their share
            if (closeTradePnl > 0) {
              const tradeId = `${botId}-${Date.now()}`;
              distributeCreatorProfitShare({
                subscriberBotId: botId,
                subscriberWalletAddress: wallet.address,
                subscriberAgentPublicKey: wallet.agentPublicKey!,
                subscriberEncryptedPrivateKey: wallet.agentPrivateKeyEncrypted,
                driftSubaccountId: subAccountId,
                realizedPnl: closeTradePnl,
                tradeId,
              }).then(result => {
                if (result.success && result.amount) {
                  console.log(`[Webhook] Profit share distributed: $${result.amount.toFixed(4)}`);
                } else if (!result.success && result.error) {
                  console.error(`[Webhook] Profit share failed: ${result.error}`);
                  // IOU is now created inside distributeCreatorProfitShare
                }
              }).catch(err => console.error('[Webhook] Profit share error:', err));
            }
            
            // SETTLE PNL: Convert realized PnL to usable USDC balance for profit reinvest
            // This must happen after close so profits can be used as margin for the next trade
            if (bot.profitReinvest) {
              try {
                console.log(`[Webhook] Settling PnL for subaccount ${subAccountId} (profit reinvest enabled)`);
                const settleResult = await settleAllPnl(wallet.agentPublicKey!, subAccountId);
                if (settleResult.success) {
                  console.log(`[Webhook] PnL settled for ${settleResult.settledMarkets?.length || 0} market(s)`);
                } else {
                  console.warn(`[Webhook] PnL settlement failed (non-blocking): ${settleResult.error}`);
                }
              } catch (settleErr: any) {
                console.warn(`[Webhook] PnL settlement error (non-blocking): ${settleErr.message}`);
              }
            }
            
            // AUTO-WITHDRAW: Check if equity exceeds threshold and withdraw excess profits
            let autoWithdrawInfo = null;
            const autoWithdrawThreshold = parseFloat(bot.autoWithdrawThreshold || "0");
            if (autoWithdrawThreshold > 0) {
              try {
                const accountInfo = await getDriftAccountInfo(wallet.agentPublicKey!, subAccountId);
                const currentEquity = accountInfo.totalCollateral;
                
                if (currentEquity > autoWithdrawThreshold) {
                  const excessAmount = currentEquity - autoWithdrawThreshold;
                  // Leave a small buffer to avoid rounding issues
                  const withdrawAmount = Math.max(0, excessAmount - 0.01);
                  
                  if (withdrawAmount > 0.1) { // Minimum $0.10 to avoid dust withdrawals
                    console.log(`[Webhook] AUTO-WITHDRAW: Equity $${currentEquity.toFixed(2)} exceeds threshold $${autoWithdrawThreshold.toFixed(2)}, withdrawing $${withdrawAmount.toFixed(2)}`);
                    
                    const withdrawResult = await executeAgentDriftWithdraw(
                      wallet.agentPublicKey!,
                      wallet.agentPrivateKeyEncrypted,
                      withdrawAmount,
                      subAccountId
                    );
                    
                    if (withdrawResult.success) {
                      console.log(`[Webhook] AUTO-WITHDRAW SUCCESS: $${withdrawAmount.toFixed(2)} withdrawn, tx: ${withdrawResult.signature}`);
                      autoWithdrawInfo = {
                        amount: withdrawAmount,
                        txSignature: withdrawResult.signature,
                      };
                      
                      // Record the withdrawal as an equity event
                      await storage.createEquityEvent({
                        walletAddress: bot.walletAddress,
                        tradingBotId: botId,
                        eventType: 'auto_withdraw',
                        amount: String(withdrawAmount),
                        txSignature: withdrawResult.signature || null,
                        notes: `Auto-withdraw triggered: equity $${currentEquity.toFixed(2)} exceeded threshold $${autoWithdrawThreshold.toFixed(2)}`,
                      });
                    } else {
                      console.error(`[Webhook] AUTO-WITHDRAW FAILED: ${withdrawResult.error}`);
                    }
                  }
                }
              } catch (autoWithdrawErr: any) {
                console.error(`[Webhook] AUTO-WITHDRAW check error (non-blocking):`, autoWithdrawErr.message);
              }
            }
            
            console.log(`[Webhook] Position closed successfully: ${closeSize} ${bot.market} ${closeSide.toUpperCase()}`);
            return res.json({
              status: "success",
              type: "close",
              trade: closeTrade.id,
              txSignature: finalTxSignature,
              closedSize: closeSize,
              side: closeSide,
              ...(autoWithdrawInfo && { autoWithdraw: autoWithdrawInfo }),
            });
          } else {
            throw new Error(result.error || "Close order execution failed");
          }
        } catch (closeError: any) {
          console.error(`[Webhook] Close order failed:`, closeError);
          
          // Check if this is a transient error (rate limit, price feed, etc.) - queue for CRITICAL automatic retry
          if (isTransientError(closeError.message || String(closeError))) {
            console.log(`[Webhook] CRITICAL: Transient error on close order, queueing for priority retry`);
            
            const retryJobId = queueTradeRetry({
              botId: bot.id,
              walletAddress: wallet.address,
              agentPrivateKeyEncrypted: wallet.agentPrivateKeyEncrypted,
              agentPublicKey: wallet.agentPublicKey!,
              market: bot.market,
              side: 'close',
              size: closeSize,
              subAccountId,
              reduceOnly: true,
              slippageBps: wallet.slippageBps ?? 50,
              priority: 'critical', // CLOSE orders get highest priority
              lastError: closeError.message,
              originalTradeId: closeTrade.id,
              entryPrice: closeEntryPrice, // For profit share calculation on retry success
            });
            
            await storage.updateBotTrade(closeTrade.id, {
              status: "pending",
              txSignature: null,
              errorMessage: `Rate limited - CRITICAL auto-retry queued (job: ${retryJobId})`,
            });
            await storage.updateWebhookLog(log.id, { 
              errorMessage: `Rate limited on close - CRITICAL retry queued: ${retryJobId}`, 
              processed: true 
            });
            
            return res.status(202).json({ 
              status: "queued_for_retry",
              retryJobId,
              type: "close",
              message: "CRITICAL: Close order rate limited - auto-retry scheduled with highest priority",
              warning: "Position may remain open until retry succeeds"
            });
          }
          
          await storage.updateBotTrade(closeTrade.id, {
            status: "failed",
            txSignature: null,
          });
          await storage.updateWebhookLog(log.id, { 
            errorMessage: `Close order failed: ${closeError.message}`, 
            processed: true 
          });
          return res.status(500).json({ error: "Close order execution failed", details: closeError.message });
        }
        // === END INNER TRY/CATCH ===
        
        } catch (closeHandlerError: any) {
          // CRITICAL: This outer catch ensures NO exception escapes the close signal handler
          // Any error here MUST return to prevent fallthrough to open-order logic
          console.error(`[Webhook] CRITICAL: Unexpected error in close signal handler - returning to prevent fallthrough:`, closeHandlerError);
          await storage.updateWebhookLog(log.id, { 
            errorMessage: `Close handler unexpected error: ${closeHandlerError.message}`, 
            processed: true 
          });
          return res.status(500).json({ 
            error: "Close signal processing failed unexpectedly", 
            details: closeHandlerError.message 
          });
        }
        // === END OUTER TRY/CATCH FOR CLOSE SIGNAL HANDLING ===
      }

      // DEFENSE-IN-DEPTH: Double-check we're not proceeding with a close signal
      // If isCloseSignal was true, all code paths above should have returned
      // This is a safety net to prevent any edge case from opening new positions on close signals
      if (isCloseSignal) {
        console.error(`[Webhook] CRITICAL: Close signal fell through without returning! This should never happen.`);
        await storage.updateWebhookLog(log.id, { 
          errorMessage: "Close signal fell through to regular execution - blocked for safety", 
          processed: true 
        });
        return res.status(500).json({ 
          error: "Internal error: close signal processing failed",
          details: "Close signal did not complete properly - blocked to prevent unintended position"
        });
      }

      // POSITION FLIP DETECTION: Check if signal direction conflicts with existing position
      // If we're LONG and receive a SHORT signal (or vice versa), we need to:
      // 1. First close the existing position completely
      // 2. Then execute the new order in the opposite direction
      
      // Get wallet for execution (needed for on-chain position check)
      const wallet = await storage.getWallet(bot.walletAddress);
      if (!wallet?.agentPrivateKeyEncrypted || !wallet?.agentPublicKey) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Agent wallet not configured", processed: true });
        return res.status(400).json({ error: "Agent wallet not configured" });
      }
      
      // Query ACTUAL on-chain Drift position using PositionService for consistent market normalization
      const subAccountId = bot.driftSubaccountId ?? 0;
      let onChainPosition;
      try {
        onChainPosition = await PositionService.getPositionForExecution(
          botId,
          wallet.agentPublicKey,
          subAccountId,
          bot.market,
          wallet.agentPrivateKeyEncrypted
        );
        console.log(`[Webhook] Position flip check: on-chain position is ${onChainPosition.side} ${Math.abs(onChainPosition.size).toFixed(6)} on ${bot.market}`);
      } catch (posErr) {
        console.warn(`[Webhook] Could not query on-chain position for flip detection:`, posErr);
        onChainPosition = { side: 'FLAT', size: 0 };
      }
      
      // Use on-chain position size for accurate flip detection
      const actualOnChainSize = onChainPosition.side === 'LONG' ? onChainPosition.size : 
                                onChainPosition.side === 'SHORT' ? -onChainPosition.size : 0;
      const isCurrentlyLong = onChainPosition.side === 'LONG';
      const isCurrentlyShort = onChainPosition.side === 'SHORT';
      const signalIsLong = side === 'long';
      const signalIsShort = side === 'short';
      
      console.log(`[Webhook] On-chain position check: ${bot.market} size=${actualOnChainSize.toFixed(6)} (${isCurrentlyLong ? 'LONG' : isCurrentlyShort ? 'SHORT' : 'FLAT'})`);
      
      // Detect position flip: signal direction opposite to current position
      const isPositionFlip = (isCurrentlyLong && signalIsShort) || (isCurrentlyShort && signalIsLong);
      
      if (isPositionFlip && Math.abs(actualOnChainSize) > 0) {
        console.log(`[Webhook] POSITION FLIP detected: On-chain ${isCurrentlyLong ? 'LONG' : 'SHORT'} ${Math.abs(actualOnChainSize).toFixed(6)} contracts, signal wants to go ${side.toUpperCase()}`);
        
        // Step 1: Close existing position first using ACTUAL on-chain size
        const closeSide = isCurrentlyLong ? 'short' : 'long';
        const closeSize = Math.abs(actualOnChainSize); // Use actual on-chain size, not tracked
        
        console.log(`[Webhook] Step 1: Closing existing ${isCurrentlyLong ? 'LONG' : 'SHORT'} position of ${closeSize} contracts`);
        
        // Create close trade record
        const closeTrade = await storage.createBotTrade({
          tradingBotId: botId,
          walletAddress: bot.walletAddress,
          market: bot.market,
          side: "CLOSE",
          size: String(closeSize),
          price: signalPrice,
          status: "pending",
          webhookPayload: { ...payload, _flipClose: true },
        });
        
        try {
          // Use closePerpPosition for exact BN precision (prevents float precision dust)
          const flipSlippageBps = wallet.slippageBps ?? 50;
          console.log(`[Webhook] Using closePerpPosition (exact BN) for position flip close, slippage=${flipSlippageBps}bps`);
          const closeResult = await closePerpPosition(
            wallet.agentPrivateKeyEncrypted,
            bot.market,
            subAccountId,
            undefined,
            flipSlippageBps,
            privateKeyBase58
          );
          
          if (!closeResult.success) {
            await storage.updateBotTrade(closeTrade.id, { status: "failed", errorMessage: `Position flip close failed: ${closeResult.error}` });
            await storage.updateWebhookLog(log.id, { errorMessage: `Position flip close failed: ${closeResult.error}`, processed: true });
            return res.status(500).json({ error: `Position flip close failed: ${closeResult.error}` });
          }
          
          // closePerpPosition returns signature, not txSignature
          const flipTxSignature = closeResult.signature || null;
          
          // Calculate PnL for the flip close regardless of whether we have a signature
          // This ensures PnL is recorded even if position was closed by another process
          const closeFillPrice = parseFloat(signalPrice || "0");
          const closeNotional = closeSize * closeFillPrice;
          const closeFee = closeNotional * DRIFT_FEE_RATE;
          
          // Calculate trade PnL for position flip close
          const flipEntryPrice = onChainPosition.entryPrice || 0;
          let flipClosePnl = 0;
          if (flipEntryPrice > 0 && closeFillPrice > 0) {
            if (closeSide === 'short') {
              // Closing LONG: profit if exitPrice > entryPrice
              flipClosePnl = (closeFillPrice - flipEntryPrice) * closeSize - closeFee;
            } else {
              // Closing SHORT: profit if entryPrice > exitPrice
              flipClosePnl = (flipEntryPrice - closeFillPrice) * closeSize - closeFee;
            }
            console.log(`[Webhook] Flip close PnL: entry=$${flipEntryPrice.toFixed(2)}, exit=$${closeFillPrice.toFixed(2)}, size=${closeSize}, fee=$${closeFee.toFixed(4)}, pnl=$${flipClosePnl.toFixed(4)}`);
          }

          // Handle case where subprocess found no position to close (success=true, signature=null)
          // This is unexpected for flip since we verified position exists, but handle gracefully
          if (closeResult.success && !flipTxSignature) {
            console.warn(`[Webhook] Position flip close: success but no signature - position may have been closed by another process`);
            // Still save the PnL calculation based on the position we queried before
            await storage.updateBotTrade(closeTrade.id, { 
              status: "executed",
              txSignature: null,
              price: String(closeFillPrice),
              fee: String(closeFee),
              pnl: flipClosePnl !== 0 ? String(flipClosePnl) : null,
              errorMessage: "Position was already closed (no trade executed)"
            });
            
            // Sync position from on-chain to keep DB aligned
            await syncPositionFromOnChain(
              botId,
              bot.walletAddress,
              wallet.agentPublicKey!,
              subAccountId,
              bot.market,
              closeTrade.id,
              closeFee,
              closeFillPrice,
              closeSide,
              closeSize
            );
            
            // Continue to execute the new position anyway
            console.log(`[Webhook] Proceeding to open ${side.toUpperCase()} position despite no close signature`);
          } else {
            // Update close trade with execution details
            await storage.updateBotTrade(closeTrade.id, {
              status: "executed",
              txSignature: flipTxSignature,
              price: String(closeFillPrice),
              fee: String(closeFee),
              pnl: flipClosePnl !== 0 ? String(flipClosePnl) : null,
            });
          
            // Sync position from on-chain (replaces client-side math with actual Drift state)
            await syncPositionFromOnChain(
              botId,
              bot.walletAddress,
              wallet.agentPublicKey!,
              subAccountId,
              bot.market,
              closeTrade.id,
              closeFee,
              closeFillPrice,
              closeSide,
              closeSize
            );
          
            console.log(`[Webhook] Position closed successfully. Now proceeding to open ${side.toUpperCase()} position.`);
            
            // SETTLE PNL after flip close to make profits available for the new position
            if (bot.profitReinvest) {
              try {
                console.log(`[Webhook] Settling PnL for subaccount ${subAccountId} after flip close (profit reinvest enabled)`);
                const settleResult = await settleAllPnl(wallet.agentPublicKey!, subAccountId);
                if (settleResult.success) {
                  console.log(`[Webhook] PnL settled for ${settleResult.settledMarkets?.length || 0} market(s)`);
                } else {
                  console.warn(`[Webhook] PnL settlement failed (non-blocking): ${settleResult.error}`);
                }
              } catch (settleErr: any) {
                console.warn(`[Webhook] PnL settlement error (non-blocking): ${settleErr.message}`);
              }
            }
          
            // Update stats for close trade (including volume for FUEL tracking)
            const flipCloseVolume = closeSize * closeFillPrice;
            const stats1 = bot.stats as any || { totalTrades: 0, winningTrades: 0, losingTrades: 0, totalPnl: 0, totalVolume: 0 };
            await storage.updateTradingBotStats(botId, {
              ...stats1,
              totalTrades: (stats1.totalTrades || 0) + 1,
              totalVolume: (stats1.totalVolume || 0) + flipCloseVolume,
              lastTradeAt: new Date().toISOString(),
            });
          }
          
        } catch (closeError: any) {
          console.error(`[Webhook] Position flip close failed:`, closeError);
          await storage.updateBotTrade(closeTrade.id, { status: "failed", errorMessage: `Position flip close failed: ${closeError.message}` });
          await storage.updateWebhookLog(log.id, { errorMessage: `Position flip close failed: ${closeError.message}`, processed: true });
          return res.status(500).json({ error: `Position flip close failed: ${closeError.message}` });
        }
        
        // Step 2: Now fall through to execute the new position in the opposite direction
        console.log(`[Webhook] Step 2: Opening new ${side.toUpperCase()} position`);
      }

      // Regular order execution (not a close signal)
      // Create trade record (pending execution)
      // Use contracts as the trade size (what TradingView sent for this order)
      // Include the signal price and time from TradingView
      const trade = await storage.createBotTrade({
        tradingBotId: botId,
        walletAddress: bot.walletAddress,
        market: bot.market,
        side: side.toUpperCase(),
        size: contracts || positionSize,
        price: signalPrice,
        status: "pending",
        webhookPayload: payload,
      });

      // Store signal time in webhook log for reference
      if (signalTime) {
        console.log(`[Webhook] Signal time from TradingView: ${signalTime}`);
      }

      // NOTE: Auto-deposit has been disabled per user request
      // Funds should be manually deposited to Drift before trading
      // Auto-deposit would only make sense for liquidation protection (future feature)

      // Execute trade on Drift Protocol
      // Wallet was already fetched earlier for position check

      // Get current market price from oracle (used for order execution)
      const oraclePrice = await getMarketPrice(bot.market);
      if (!oraclePrice || oraclePrice <= 0) {
        await storage.updateBotTrade(trade.id, {
          status: "failed",
          txSignature: null,
        });
        await storage.updateWebhookLog(log.id, { errorMessage: "Could not get market price", processed: true });
        return res.status(500).json({ error: "Could not get market price" });
      }

      // USDT-to-Percentage Translation:
      // TradingView is configured with USDT order size (e.g., 33.33 USDT)
      // TradingView sends contracts = USDT / price (e.g., 33.33 / 136 = 0.245)
      // We reverse this using TradingView's price to recover exact USDT value
      const contractsFromTV = parseFloat(contracts || "0");
      
      // Use TradingView's signal price for reverse calculation (more accurate)
      // Fall back to oracle price if signal price is invalid
      const tvPrice = parseFloat(signalPrice) || 0;
      const priceForReversal = (tvPrice > 0 && Math.abs(tvPrice - oraclePrice) / oraclePrice < 0.10) 
        ? tvPrice 
        : oraclePrice;
      
      const usdtValue = contractsFromTV * priceForReversal; // Reverse TradingView's calculation
      const rawSignalPercent = usdtValue; // Treat USDT value as percentage
      const signalPercent = Math.min(rawSignalPercent, 100); // Cap at 100% to prevent accidental oversized orders
      
      console.log(`[Webhook] TradingView sent ${contractsFromTV} contracts × $${priceForReversal.toFixed(2)} (TV price) = ${usdtValue.toFixed(2)} USDT → ${rawSignalPercent > 100 ? `capped from ${rawSignalPercent.toFixed(2)}% to ` : ''}${signalPercent.toFixed(2)}%`);
      if (Math.abs(tvPrice - oraclePrice) > 0.01) {
        console.log(`[Webhook] Price comparison: TradingView=$${tvPrice.toFixed(2)}, Oracle=$${oraclePrice.toFixed(2)}, using ${tvPrice === priceForReversal ? 'TradingView' : 'Oracle'}`);
      }

      const baseCapital = parseFloat(bot.maxPositionSize || "0");
      const profitReinvestEnabled = bot.profitReinvest === true;
      const botLeverage = Math.max(1, bot.leverage || 1); // Ensure leverage >= 1
      const marketMaxLeverage = getMarketMaxLeverage(bot.market);
      const effectiveLeverage = Math.min(botLeverage, marketMaxLeverage); // Use the lower of bot's setting or market's limit
      
      if (botLeverage > marketMaxLeverage) {
        console.log(`[Webhook] Leverage capped: ${botLeverage}x → ${marketMaxLeverage}x (${bot.market} max)`);
      }
      
      if (baseCapital <= 0 && !profitReinvestEnabled) {
        await storage.updateBotTrade(trade.id, {
          status: "failed",
          txSignature: null,
        });
        await storage.updateWebhookLog(log.id, { errorMessage: `Bot has no capital configured`, processed: true });
        return res.status(400).json({ error: `Bot has no capital configured. Set Max Position Size on the bot.` });
      }
      
      // Calculate trade amount based on profit reinvest setting
      let tradeAmountUsd: number = 0; // Initialize to 0 for safety
      let maxTradeableValue = 0;
      let freeCollateral = 0; // Declare outside try block so it's accessible for min order size check
      
      // First get available collateral (needed for both modes)
      try {
        const accountInfo = await getDriftAccountInfo(wallet.agentPublicKey!, subAccountId);
        freeCollateral = Math.max(0, accountInfo.freeCollateral);
        // CRITICAL: Use effectiveLeverage (capped by market's max) to avoid InsufficientCollateral errors
        const maxNotionalCapacity = freeCollateral * effectiveLeverage;
        maxTradeableValue = maxNotionalCapacity * 0.90; // 90% buffer for fees/slippage
        
        if (profitReinvestEnabled) {
          // PROFIT REINVEST MODE: Use full available margin instead of fixed maxPositionSize
          // This allows the bot to automatically compound profits by trading with all available equity
          if (maxTradeableValue <= 0) {
            await storage.updateBotTrade(trade.id, { status: "failed", txSignature: null });
            await storage.updateWebhookLog(log.id, { errorMessage: `Profit reinvest: no margin available`, processed: true });
            return res.status(400).json({ error: `Cannot trade: profit reinvest enabled but no margin available (freeCollateral=$${freeCollateral.toFixed(2)})` });
          }
          // Calculate requested trade size, then cap to available margin
          const requestedAmount = signalPercent > 0 ? (signalPercent / 100) * maxTradeableValue : maxTradeableValue;
          tradeAmountUsd = Math.min(requestedAmount, maxTradeableValue); // CRITICAL: Never exceed available margin
          console.log(`[Webhook] PROFIT REINVEST: freeCollateral=$${freeCollateral.toFixed(2)} × ${effectiveLeverage}x × 90% = $${maxTradeableValue.toFixed(2)} max`);
          if (requestedAmount > maxTradeableValue) {
            console.log(`[Webhook] Requested $${requestedAmount.toFixed(2)} exceeds available, capped to $${tradeAmountUsd.toFixed(2)}`);
          } else {
            console.log(`[Webhook] ${signalPercent.toFixed(2)}% of $${maxTradeableValue.toFixed(2)} available margin = $${tradeAmountUsd.toFixed(2)} trade`);
          }
        } else {
          // NORMAL MODE: Use fixed maxPositionSize, scale down if needed
          tradeAmountUsd = signalPercent > 0 ? (signalPercent / 100) * baseCapital : baseCapital;
          console.log(`[Webhook] ${signalPercent.toFixed(2)}% of $${baseCapital} maxPositionSize = $${tradeAmountUsd.toFixed(2)} trade (before collateral check)`);
          console.log(`[Webhook] Dynamic scaling: freeCollateral=$${freeCollateral.toFixed(2)} × ${effectiveLeverage}x leverage = $${maxNotionalCapacity.toFixed(2)} max notional (using $${maxTradeableValue.toFixed(2)} with 90% buffer)`);
          
          if (maxTradeableValue <= 0) {
            console.log(`[Webhook] No margin available (freeCollateral=$${freeCollateral.toFixed(2)}), will attempt minimum viable trade`);
          } else if (tradeAmountUsd > maxTradeableValue) {
            // BEFORE SCALING DOWN: Check if auto top-up can help reach full investment amount
            if (bot.autoTopUp && !profitReinvestEnabled) {
              const requiredCollateralForFullTrade = (tradeAmountUsd / effectiveLeverage) * 1.15; // 15% buffer
              const topUpNeeded = Math.max(0, requiredCollateralForFullTrade - freeCollateral);
              const botSubaccountId = bot.driftSubaccountId ?? 0;
              
              console.log(`[Webhook] Auto top-up check: need $${requiredCollateralForFullTrade.toFixed(2)} collateral for $${tradeAmountUsd.toFixed(2)} trade, have $${freeCollateral.toFixed(2)}, shortfall: $${topUpNeeded.toFixed(2)}`);
              
              if (topUpNeeded > 0) {
                try {
                  const agentUsdcBalance = await getAgentUsdcBalance(wallet.agentPublicKey!);
                  console.log(`[Webhook] Agent wallet USDC balance: $${agentUsdcBalance.toFixed(2)}, need: $${topUpNeeded.toFixed(2)}`);
                  
                  if (agentUsdcBalance >= topUpNeeded) {
                    const depositAmount = Math.ceil(topUpNeeded * 100) / 100; // Round up to nearest cent
                    const depositResult = await executeAgentDriftDeposit(
                      wallet.agentPublicKey!,
                      wallet.agentPrivateKeyEncrypted,
                      depositAmount,
                      botSubaccountId,
                      false
                    );
                    
                    if (depositResult.success) {
                      console.log(`[Webhook] Auto top-up successful: deposited $${depositAmount.toFixed(2)} to reach full investment, tx: ${depositResult.signature}`);
                      // Update freeCollateral and maxTradeableValue after deposit
                      freeCollateral += depositAmount;
                      maxTradeableValue = freeCollateral * effectiveLeverage * 0.90;
                      
                      // Record auto top-up event
                      await storage.createEquityEvent({
                        walletAddress: bot.walletAddress,
                        tradingBotId: bot.id,
                        eventType: 'auto_topup',
                        amount: String(depositAmount),
                        txSignature: depositResult.signature || null,
                        notes: `Auto top-up: deposited $${depositAmount.toFixed(2)} to enable full $${tradeAmountUsd.toFixed(2)} trade (was limited to $${maxTradeableValue.toFixed(2)})`,
                      });
                      
                      console.log(`[Webhook] Updated: freeCollateral=$${freeCollateral.toFixed(2)}, maxTradeableValue=$${maxTradeableValue.toFixed(2)}`);
                    } else {
                      console.log(`[Webhook] Auto top-up deposit failed: ${depositResult.error}, falling back to scaled trade`);
                    }
                  } else {
                    console.log(`[Webhook] Agent wallet ($${agentUsdcBalance.toFixed(2)}) insufficient for full top-up ($${topUpNeeded.toFixed(2)}), will scale down trade`);
                  }
                } catch (topUpErr: any) {
                  console.log(`[Webhook] Auto top-up error: ${topUpErr.message}, falling back to scaled trade`);
                }
              }
            }
            
            // Re-check after potential top-up
            if (tradeAmountUsd > maxTradeableValue) {
              const originalAmount = tradeAmountUsd;
              tradeAmountUsd = maxTradeableValue;
              const scalePercent = ((tradeAmountUsd / originalAmount) * 100).toFixed(1);
              console.log(`[Webhook] SCALED DOWN: Trade reduced from $${originalAmount.toFixed(2)} to $${tradeAmountUsd.toFixed(2)} (${scalePercent}% of requested, will scale back up as equity recovers)`);
            } else {
              console.log(`[Webhook] Full size now available after top-up: $${tradeAmountUsd.toFixed(2)} within $${maxTradeableValue.toFixed(2)} capacity`);
            }
          } else {
            console.log(`[Webhook] Full size available: $${tradeAmountUsd.toFixed(2)} within $${maxTradeableValue.toFixed(2)} capacity`);
          }
        }
      } catch (collateralErr: any) {
        // If we can't check collateral, fall back to baseCapital (only works if profitReinvest is off)
        console.warn(`[Webhook] Could not check collateral: ${collateralErr.message}`);
        if (profitReinvestEnabled) {
          await storage.updateWebhookLog(log.id, { errorMessage: `Profit reinvest requires collateral check`, processed: true });
          return res.status(500).json({ error: `Cannot execute trade: profit reinvest enabled but collateral check failed` });
        }
        tradeAmountUsd = signalPercent > 0 ? (signalPercent / 100) * baseCapital : baseCapital;
        console.log(`[Webhook] Fallback to fixed size: $${tradeAmountUsd.toFixed(2)}`);
      }
      
      console.log(`[Webhook] Final trade amount: $${tradeAmountUsd.toFixed(2)}`);

      // Calculate contract size - maxPositionSize already includes leverage (set during bot creation)
      // So we just divide by price to get contracts, no additional leverage multiplication needed
      const contractSize = tradeAmountUsd / oraclePrice;
      
      console.log(`[Webhook] $${tradeAmountUsd.toFixed(2)} / $${oraclePrice.toFixed(2)} = ${contractSize.toFixed(6)} contracts`);

      // Get minimum order size for this market from market metadata
      const minOrderSize = getMinOrderSize(bot.market);
      let finalContractSize = contractSize;
      
      if (contractSize < minOrderSize) {
        const minCapitalNeeded = minOrderSize * oraclePrice;
        const maxCapacity = (freeCollateral ?? baseCapital) * effectiveLeverage * 0.9;
        
        if (minCapitalNeeded <= maxCapacity) {
          finalContractSize = minOrderSize;
          console.log(`[Webhook] BUMPED UP: ${contractSize.toFixed(4)} contracts → ${minOrderSize} minimum (requires $${minCapitalNeeded.toFixed(2)}, you have $${maxCapacity.toFixed(2)} capacity)`);
        } else {
          // Cannot meet minimum order size with current margin
          // Calculate required deposit to meet minimum (with 20% buffer for safety)
          const requiredCollateral = (minCapitalNeeded / effectiveLeverage) * 1.2;
          const shortfall = Math.max(0, requiredCollateral - freeCollateral); // Clamp to non-negative
          const botSubaccountId = bot.driftSubaccountId ?? 0;
          
          console.log(`[Webhook] Insufficient margin: need $${requiredCollateral.toFixed(2)} collateral, have $${freeCollateral.toFixed(2)}, shortfall: $${shortfall.toFixed(2)}, botSubaccount: ${botSubaccountId}`);
          
          // Check if auto top-up is enabled
          if (bot.autoTopUp) {
            console.log(`[Webhook] Auto top-up enabled, attempting to deposit from agent wallet`);
            
            try {
              // Check agent wallet USDC balance (not Drift subaccount 0 - that's just a placeholder)
              const agentUsdcBalance = await getAgentUsdcBalance(wallet.agentPublicKey!);
              console.log(`[Webhook] Agent wallet USDC balance: $${agentUsdcBalance.toFixed(2)}, shortfall: $${shortfall.toFixed(2)}`);
              
              if (agentUsdcBalance >= shortfall) {
                // Deposit required amount from agent wallet to bot's Drift subaccount
                const depositAmount = Math.ceil(shortfall * 100) / 100; // Round up to nearest cent
                const depositResult = await executeAgentDriftDeposit(
                  wallet.agentPublicKey!,
                  wallet.agentPrivateKeyEncrypted,
                  depositAmount,
                  botSubaccountId,
                  false // not pre-decrypted
                );
                
                if (depositResult.success) {
                  console.log(`[Webhook] Auto top-up successful: deposited $${depositAmount.toFixed(2)} to bot subaccount ${botSubaccountId}, tx: ${depositResult.signature}`);
                  // Clear pause reason since we topped up
                  await storage.updateTradingBot(bot.id, { pauseReason: null } as any);
                  
                  // Record auto top-up as equity event for monitoring
                  await storage.createEquityEvent({
                    walletAddress: bot.walletAddress,
                    tradingBotId: bot.id,
                    eventType: 'auto_topup',
                    amount: String(depositAmount),
                    txSignature: depositResult.signature || null,
                    notes: `Auto top-up triggered: margin $${freeCollateral.toFixed(2)} insufficient for ${minOrderSize} ${bot.market} (need $${requiredCollateral.toFixed(2)})`,
                  });
                  
                  // Update freeCollateral and recalculate
                  freeCollateral += depositAmount;
                  finalContractSize = minOrderSize;
                  console.log(`[Webhook] Proceeding with trade after auto top-up: ${finalContractSize} contracts`);
                } else {
                  console.log(`[Webhook] Auto top-up deposit failed: ${depositResult.error}`);
                  const pauseReason = `Insufficient margin: need $${requiredCollateral.toFixed(2)} to trade ${minOrderSize} ${bot.market}. Auto top-up failed: ${depositResult.error}`;
                  await storage.updateTradingBot(bot.id, { isActive: false, pauseReason } as any);
                  await storage.updateBotTrade(trade.id, { status: "failed", txSignature: null, size: contractSize.toFixed(8), errorMessage: pauseReason });
                  await storage.updateWebhookLog(log.id, { errorMessage: pauseReason, processed: true });
                  return res.status(400).json({ error: pauseReason });
                }
              } else {
                // Not enough in agent wallet
                const pauseReason = `Insufficient margin: need $${requiredCollateral.toFixed(2)} to trade ${minOrderSize} ${bot.market}. Agent wallet only has $${agentUsdcBalance.toFixed(2)} USDC available for top-up.`;
                console.log(`[Webhook] ${pauseReason}`);
                await storage.updateTradingBot(bot.id, { isActive: false, pauseReason } as any);
                await storage.updateBotTrade(trade.id, { status: "failed", txSignature: null, size: contractSize.toFixed(8), errorMessage: pauseReason });
                await storage.updateWebhookLog(log.id, { errorMessage: pauseReason, processed: true });
                return res.status(400).json({ error: pauseReason });
              }
            } catch (topUpErr: any) {
              console.log(`[Webhook] Auto top-up error: ${topUpErr.message}`);
              const pauseReason = `Insufficient margin: need $${requiredCollateral.toFixed(2)} to trade ${minOrderSize} ${bot.market}. Auto top-up failed: ${topUpErr.message}`;
              await storage.updateTradingBot(bot.id, { isActive: false, pauseReason } as any);
              await storage.updateBotTrade(trade.id, { status: "failed", txSignature: null, size: contractSize.toFixed(8), errorMessage: pauseReason });
              await storage.updateWebhookLog(log.id, { errorMessage: pauseReason, processed: true });
              return res.status(400).json({ error: pauseReason });
            }
          } else {
            // Auto top-up disabled - pause the bot
            const pauseReason = `Insufficient margin: need $${requiredCollateral.toFixed(2)} to trade ${minOrderSize} ${bot.market}, but only $${freeCollateral.toFixed(2)} available. Top up your bot to continue trading.`;
            console.log(`[Webhook] Auto-pausing bot: ${pauseReason}`);
            await storage.updateTradingBot(bot.id, { isActive: false, pauseReason } as any);
            await storage.updateBotTrade(trade.id, { status: "failed", txSignature: null, size: contractSize.toFixed(8), errorMessage: pauseReason });
            await storage.updateWebhookLog(log.id, { errorMessage: pauseReason, processed: true });
            return res.status(400).json({ error: pauseReason });
          }
        }
      }

      // Execute on Drift using the subAccountId already declared for position check
      const userSlippageBps = wallet.slippageBps ?? 50;
      const orderResult = await executePerpOrder(
        wallet.agentPrivateKeyEncrypted,
        bot.market,
        side,
        finalContractSize,
        subAccountId,
        false,
        userSlippageBps,
        privateKeyBase58,
        wallet.agentPublicKey || undefined
      );

      if (!orderResult.success) {
        const userFriendlyError = parseDriftError(orderResult.error);
        console.log(`[Webhook] Trade failed: ${orderResult.error}`);
        console.log(`[Webhook] TRADE FAILURE CONTEXT: freeCollateral=$${freeCollateral.toFixed(2)}, maxTradeableValue=$${maxTradeableValue.toFixed(2)}, tradeAmountUsd=$${tradeAmountUsd.toFixed(2)}, finalContractSize=${finalContractSize}, oraclePrice=$${oraclePrice.toFixed(2)}, notional=$${(finalContractSize * oraclePrice).toFixed(2)}`);
        
        // Check if this is a transient error (rate limit, price feed, oracle) or temporary collateral issue - queue for automatic retry
        const errorToCheck = orderResult.error || '';
        const isTransient = isTransientError(errorToCheck);
        const isCollateralError = errorToCheck.includes('InsufficientCollateral') || errorToCheck.includes('6010');
        console.log(`[Webhook] Retry eligibility: isTransient=${isTransient}, isCollateralError=${isCollateralError}, error="${errorToCheck.slice(0, 100)}..."`);
        
        // Also retry on InsufficientCollateral - sometimes it's a temporary condition due to oracle price spikes
        if (isTransient || isCollateralError) {
          console.log(`[Webhook] Retryable error detected (transient=${isTransient}, collateral=${isCollateralError}), queueing trade for automatic retry`);
          
          const retryJobId = queueTradeRetry({
            botId: bot.id,
            walletAddress: wallet.address,
            agentPrivateKeyEncrypted: wallet.agentPrivateKeyEncrypted,
            agentPublicKey: wallet.agentPublicKey!,
            market: bot.market,
            side: side,
            size: finalContractSize,
            subAccountId,
            reduceOnly: false,
            slippageBps: userSlippageBps,
            privateKeyBase58,
            priority: 'normal',
            lastError: orderResult.error,
            originalTradeId: trade.id,
            webhookPayload: { action, contracts, market: bot.market },
          });
          
          const retryReason = isCollateralError ? 'Temporary margin issue' : 'Rate limited';
          await storage.updateBotTrade(trade.id, {
            status: "pending",
            txSignature: null,
            size: finalContractSize.toFixed(8),
            errorMessage: `${retryReason} - auto-retry queued (job: ${retryJobId})`,
          });
          await storage.updateWebhookLog(log.id, { errorMessage: `${retryReason} - retry queued: ${retryJobId}`, processed: true });
          
          return res.status(202).json({ 
            status: "queued_for_retry",
            retryJobId,
            message: `${retryReason} - automatic retry scheduled`
          });
        }
        
        await storage.updateBotTrade(trade.id, {
          status: "failed",
          txSignature: null,
          size: finalContractSize.toFixed(8),
          errorMessage: userFriendlyError,
        });
        await storage.updateWebhookLog(log.id, { errorMessage: orderResult.error || "Order execution failed", processed: true });
        
        // Send trade failed notification
        sendTradeNotification(wallet.address, {
          type: 'trade_failed',
          botName: bot.name,
          market: bot.market,
          side: side === 'long' ? 'LONG' : 'SHORT',
          error: userFriendlyError,
        }).catch(err => console.error('[Notifications] Failed to send trade_failed notification:', err));
        
        return res.status(500).json({ error: userFriendlyError });
      }

      const fillPrice = orderResult.fillPrice || parseFloat(signalPrice || "0");
      
      // Calculate fee - use actual fee from executor if available
      const tradeNotional = finalContractSize * fillPrice;
      const tradeFee = orderResult.actualFee ?? (tradeNotional * DRIFT_FEE_RATE);
      
      await storage.updateBotTrade(trade.id, {
        status: "executed",
        price: fillPrice.toString(),
        fee: tradeFee.toString(),
        txSignature: orderResult.txSignature || orderResult.signature || null,
        size: finalContractSize.toFixed(8), // Store calculated size, not raw TradingView value
      });

      // Sync position from on-chain (replaces client-side math with actual Drift state)
      const syncResult = await syncPositionFromOnChain(
        botId,
        bot.walletAddress,
        wallet.agentPublicKey!,
        subAccountId,
        bot.market,
        trade.id,
        tradeFee,
        fillPrice,
        side,
        finalContractSize
      );

      // Update bot stats (including volume for FUEL tracking)
      const stats = bot.stats as TradingBot['stats'] || { totalTrades: 0, winningTrades: 0, losingTrades: 0, totalPnl: 0, totalVolume: 0 };
      await storage.updateTradingBotStats(botId, {
        ...stats,
        totalTrades: (stats.totalTrades || 0) + 1,
        winningTrades: syncResult.isClosingTrade && (syncResult.tradePnl ?? 0) > 0 ? (stats.winningTrades || 0) + 1 : (stats.winningTrades || 0),
        losingTrades: syncResult.isClosingTrade && (syncResult.tradePnl ?? 0) < 0 ? (stats.losingTrades || 0) + 1 : (stats.losingTrades || 0),
        totalPnl: (stats.totalPnl || 0) + (syncResult.tradePnl ?? 0),
        totalVolume: (stats.totalVolume || 0) + tradeNotional,
        lastTradeAt: new Date().toISOString(),
      });

      // Send trade notification (async, don't block response)
      sendTradeNotification(wallet.address, {
        type: 'trade_executed',
        botName: bot.name,
        market: bot.market,
        side: side === 'long' ? 'LONG' : 'SHORT',
        size: tradeNotional,
        price: fillPrice,
      }).catch(err => console.error('[Notifications] Failed to send trade_executed notification:', err));

      // Route signal to subscriber bots (async, don't block response)
      routeSignalToSubscribers(botId, {
        action: action as 'buy' | 'sell',
        contracts,
        positionSize,
        price: signalPrice || fillPrice.toString(),
        isCloseSignal: false,
        strategyPositionSize,
      }).catch(err => console.error('[Subscriber Routing] Error routing to subscribers:', err));

      // Mark signal as executed (unique index prevents concurrent duplicates)
      try {
        await storage.updateWebhookLog(log.id, { processed: true, tradeExecuted: true });
      } catch (dbError: any) {
        // Unique constraint violation means another request already executed this signal
        if (dbError?.code === '23505') {
          console.log(`[Webhook] Concurrent duplicate detected at DB level, signal already executed: hash=${signalHash}`);
          return res.status(200).json({ status: "skipped", reason: "concurrent duplicate" });
        }
        throw dbError;
      }

      res.json({
        success: true,
        action: action,
        side: side,
        tradeId: trade.id,
        market: bot.market,
        size: positionSize,
        signalHash,
      });
      } finally {
        // PHASE 6.2: Ensure agent key is cleaned up after execution
        cleanupAgentKey();
      }
    } catch (error) {
      console.error("Webhook processing error:", error);
      await storage.updateWebhookLog(log.id, { errorMessage: String(error) });
      res.status(500).json({ error: "Failed to process webhook" });
    }
  });

  // User-level webhook endpoint - single URL for all bots, routes based on botId in payload
  app.post("/api/webhook/user/:walletAddress", async (req, res) => {
    const { walletAddress } = req.params;
    const { secret } = req.query;
    const payload = req.body;

    // Extract botId early for signal hash generation
    const botId = payload?.botId;
    
    // Generate signal hash for deduplication (only if botId exists)
    const signalHash = botId ? generateSignalHash(botId, payload) : null;

    // Log webhook with signal hash - unique index prevents concurrent duplicates
    let log;
    try {
      log = await storage.createWebhookLog({
        tradingBotId: botId || null,
        payload: payload,
        headers: req.headers as any,
        ipAddress: req.ip || req.headers['x-forwarded-for'] as string,
        processed: false,
        signalHash,
      });
    } catch (dbError: any) {
      // Unique constraint violation means this signal was already received
      if (dbError?.code === '23505') {
        console.log(`[User Webhook] Duplicate signal blocked at creation: hash=${signalHash}`);
        return res.status(200).json({ status: "skipped", reason: "duplicate signal" });
      }
      // Foreign key violation means the bot was deleted
      if (dbError?.code === '23503') {
        console.log(`[User Webhook] Bot no longer exists: ${botId}`);
        return res.status(404).json({ error: "Bot not found - it may have been deleted" });
      }
      throw dbError;
    }

    try {
      // Get wallet
      const wallet = await storage.getWallet(walletAddress);
      if (!wallet) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Wallet not found" });
        return res.status(404).json({ error: "Wallet not found" });
      }

      // Validate secret
      if (secret !== wallet.userWebhookSecret) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Invalid secret" });
        return res.status(401).json({ error: "Invalid secret" });
      }

      // Verify botId exists
      if (!botId) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Missing botId in payload" });
        return res.status(400).json({ error: "Missing botId in payload" });
      }

      // Get bot and verify ownership
      const bot = await storage.getTradingBotById(botId);
      if (!bot) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Bot not found" });
        return res.status(404).json({ error: "Bot not found" });
      }

      if (bot.walletAddress !== walletAddress) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Bot does not belong to this wallet" });
        return res.status(403).json({ error: "Bot does not belong to this wallet" });
      }

      // Security v3: Check execution authorization
      if (wallet.emergencyStopTriggered) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Execution blocked: Emergency stop active" });
        return res.status(403).json({ error: "Trade execution blocked: Emergency stop is active for this wallet" });
      }
      
      if (!wallet.executionEnabled) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Execution blocked: Authorization required" });
        return res.status(403).json({ error: "Trade execution disabled. Please enable automated trading in the app." });
      }
      
      if (wallet.executionExpiresAt && new Date() > wallet.executionExpiresAt) {
        // Clear expired execution authorization
        await storage.updateWalletExecution(walletAddress, {
          executionEnabled: false,
          umkEncryptedForExecution: null,
          executionExpiresAt: null,
        });
        await storage.updateWebhookLog(log.id, { errorMessage: "Execution blocked: Authorization expired" });
        return res.status(403).json({ error: "Trade execution authorization expired. Please re-enable automated trading." });
      }

      // Security v3: Verify execution key can be unwrapped (validates SERVER_EXECUTION_KEY is correct)
      const umkResult = await getUmkForWebhook(walletAddress);
      if (!umkResult) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Execution blocked: Invalid execution authorization" });
        return res.status(403).json({ error: "Invalid execution authorization. Please re-enable automated trading." });
      }
      
      // Security v3: Verify bot policy HMAC if one exists (detects tampering with critical settings)
      if (bot.policyHmac) {
        const policyValid = verifyBotPolicyHmac(
          umkResult.umk,
          { market: bot.market, leverage: bot.leverage || 1, maxPositionSize: bot.maxPositionSize },
          bot.policyHmac
        );
        if (!policyValid) {
          umkResult.cleanup();
          await storage.updateWebhookLog(log.id, { errorMessage: "Execution blocked: Bot policy tampered" });
          return res.status(403).json({ error: "Bot configuration has been tampered with. Please reconfigure the bot." });
        }
      }
      
      // Security v3: Decrypt agent key via v3 path (Phase 6.2 - use pre-decrypted key)
      const agentKeyResult = await decryptAgentKeyWithFallback(
        walletAddress,
        umkResult.umk,
        wallet
      );
      
      // Cleanup the unwrapped UMK immediately after deriving agent key
      umkResult.cleanup();
      
      if (!agentKeyResult) {
        // Agent key decryption failed - this is a critical error
        await storage.updateWebhookLog(log.id, { errorMessage: "Execution blocked: Agent key decryption failed" });
        return res.status(403).json({ error: "Agent key decryption failed. Please reconfigure your agent wallet." });
      }
      
      // Log migration status for tracking
      const usedV3 = wallet.agentPrivateKeyEncryptedV3 ? true : false;
      if (usedV3) {
        console.log(`[User Webhook] Agent key decryption: v3 path used for ${walletAddress.slice(0, 8)}...`);
      } else {
        console.log(`[User Webhook] Agent key decryption: legacy fallback used for ${walletAddress.slice(0, 8)}... (v3 not yet migrated)`);
      }
      
      // Convert secretKey (Uint8Array) to base58 for passing to executor
      const privateKeyBase58 = bs58.encode(agentKeyResult.secretKey);
      
      // CRITICAL: Verify decrypted key matches stored public key before proceeding
      // This catches key corruption, wrong UMK, or v3/legacy mismatch issues
      try {
        const { Keypair } = await import("@solana/web3.js");
        const derivedKeypair = Keypair.fromSecretKey(agentKeyResult.secretKey);
        const derivedPubkey = derivedKeypair.publicKey.toBase58();
        
        if (derivedPubkey !== wallet.agentPublicKey) {
          console.error(`[User Webhook] CRITICAL: Agent key mismatch!`);
          console.error(`  Derived pubkey: ${derivedPubkey}`);
          console.error(`  Expected pubkey: ${wallet.agentPublicKey}`);
          console.error(`  Wallet has v3 key: ${!!wallet.agentPrivateKeyEncryptedV3}`);
          console.error(`  Wallet has legacy key: ${!!wallet.agentPrivateKeyEncrypted}`);
          agentKeyResult.cleanup();
          await storage.updateWebhookLog(log.id, { errorMessage: "Agent key mismatch - security error" });
          return res.status(500).json({ error: "Agent key verification failed. Please reconfigure your agent wallet in Settings." });
        }
        console.log(`[User Webhook] Agent key verified: ${derivedPubkey.slice(0, 8)}... matches stored pubkey`);
      } catch (verifyErr: any) {
        console.error(`[User Webhook] Agent key verification failed: ${verifyErr.message}`);
        agentKeyResult.cleanup();
        await storage.updateWebhookLog(log.id, { errorMessage: `Agent key verification failed: ${verifyErr.message}` });
        return res.status(500).json({ error: "Agent key verification failed. Please reconfigure your agent wallet." });
      }
      
      // Helper to cleanup agent key after use
      const cleanupAgentKey = () => {
        agentKeyResult.cleanup();
      };

      // PHASE 6.2: Wrap execution in try/finally to ensure agent key cleanup
      try {

      // Check if bot is active
      if (!bot.isActive) {
        await storage.updateWebhookLog(log.id, { errorMessage: "Bot is paused" });
        return res.status(400).json({ error: "Bot is paused" });
      }

      // Parse TradingView strategy signal - reuse existing parsing logic
      let action: string | null = null;
      let contracts: string = "0";
      let positionSize: string = bot.maxPositionSize || "100";
      let strategyPositionSize: string | null = null; // Track strategy.position_size for close detection
      let ticker: string = "";
      let signalPrice: string = "0";
      let signalTime: string | null = null;

      // CRITICAL FIX: Extract position_size from payload FIRST, before any format-specific parsing
      if (typeof payload === 'object' && payload !== null) {
        if (payload.position_size !== undefined) {
          strategyPositionSize = String(payload.position_size);
          console.log(`[User Webhook] Extracted position_size from root: "${strategyPositionSize}"`);
        }
        if (payload.data && payload.data.position_size !== undefined) {
          strategyPositionSize = String(payload.data.position_size);
          console.log(`[User Webhook] Extracted position_size from data: "${strategyPositionSize}"`);
        }
        if (payload.action) action = String(payload.action).toLowerCase();
        if (payload.contracts) contracts = String(payload.contracts);
        if (payload.price) signalPrice = String(payload.price);
        if (payload.time) signalTime = String(payload.time);
        if (payload.symbol) ticker = String(payload.symbol);
      }

      if (typeof payload === 'object' && payload.signalType === 'trade' && payload.data) {
        if (payload.data.action) action = payload.data.action.toLowerCase();
        if (payload.data.contracts) contracts = String(payload.data.contracts);
        if (payload.data.positionSize) positionSize = String(payload.data.positionSize);
        if (payload.symbol) ticker = String(payload.symbol);
        if (payload.price) signalPrice = String(payload.price);
        if (payload.time) signalTime = String(payload.time);
        console.log(`[User Webhook] Parsed JSON signal: botId=${botId}, action=${action}, contracts=${contracts}, symbol=${ticker}, price=${signalPrice}`);
      } else {
        const message = typeof payload === 'string' ? payload : 
                        typeof payload === 'object' && payload.message ? payload.message :
                        typeof payload === 'object' ? JSON.stringify(payload) : String(payload);

        const regex = /order\s+(buy|sell)\s+@\s+([\d.]+)\s+filled\s+on\s+([A-Za-z0-9:\-/]+).*position\s+is\s+([-\d.]+)/i;
        const match = message.match(regex);

        if (match) {
          action = match[1].toLowerCase();
          contracts = match[2];
          ticker = match[3];
          positionSize = match[4];
        } else {
          try {
            const parsed = typeof payload === 'object' ? payload : JSON.parse(message);
            if (parsed.action) action = parsed.action.toLowerCase();
            if (parsed.contracts) contracts = String(parsed.contracts);
            if (parsed.position_size) positionSize = String(parsed.position_size);
          } catch {
            const text = message.toLowerCase();
            if (text.includes('buy')) action = 'buy';
            else if (text.includes('sell')) action = 'sell';
          }
        }
      }

      // Map action to side
      let side: 'long' | 'short' | null = null;
      if (action === 'buy') {
        side = 'long';
      } else if (action === 'sell') {
        side = 'short';
      }

      // Check bot side restrictions
      if (side && bot.side !== 'both') {
        if (bot.side === 'long' && side !== 'long') {
          await storage.updateWebhookLog(log.id, { errorMessage: "Bot only accepts long signals", processed: true });
          return res.status(400).json({ error: "Bot only accepts long signals" });
        }
        if (bot.side === 'short' && side !== 'short') {
          await storage.updateWebhookLog(log.id, { errorMessage: "Bot only accepts short signals", processed: true });
          return res.status(400).json({ error: "Bot only accepts short signals" });
        }
      }

      if (!side) {
        await storage.updateWebhookLog(log.id, { errorMessage: "No valid action found (expected buy or sell)", processed: true });
        return res.status(400).json({ error: "No valid action found", received: payload });
      }

      // CLOSE SIGNAL DETECTION: Check if this is a position close signal (SL/TP)
      // TradingView sends strategy.position_size = 0 when closing a position
      const isCloseSignal = strategyPositionSize !== null && 
        (strategyPositionSize === "0" || parseFloat(strategyPositionSize) === 0);
      
      console.log(`[User Webhook] Signal analysis: action=${action}, contracts=${contracts}, strategyPositionSize=${strategyPositionSize}, isCloseSignal=${isCloseSignal}`);
      
      // CLOSE SIGNAL HANDLING - mirrors logic from /api/webhook/tradingview/:botId
      if (isCloseSignal) {
        console.log(`[User Webhook] *** CLOSE SIGNAL DETECTED *** (strategyPositionSize=${strategyPositionSize}) - Entering close handler`);
        
        try {
          // Get wallet for execution
          const wallet = await storage.getWallet(walletAddress);
          if (!wallet?.agentPrivateKeyEncrypted || !wallet?.agentPublicKey) {
            await storage.updateWebhookLog(log.id, { errorMessage: "Agent wallet not configured for close", processed: true });
            return res.status(400).json({ error: "Agent wallet not configured" });
          }
          
          const subAccountId = bot.driftSubaccountId ?? 0;
          console.log(`[User Webhook] Close signal: querying on-chain position for bot=${bot.name}, market=${bot.market}, subaccount=${subAccountId}`);
          
          // Query on-chain position directly
          let onChainPosition;
          try {
            onChainPosition = await PositionService.getPositionForExecution(
              botId,
              wallet.agentPublicKey,
              subAccountId,
              bot.market,
              wallet.agentPrivateKeyEncrypted
            );
            console.log(`[User Webhook] On-chain position query result: size=${onChainPosition.size}, side=${onChainPosition.side}, entryPrice=${onChainPosition.entryPrice}`);
          } catch (onChainErr) {
            console.error(`[User Webhook] CRITICAL: Failed to query on-chain position for close:`, onChainErr);
            await storage.updateWebhookLog(log.id, { 
              errorMessage: "Failed to query on-chain position - cannot safely close", 
              processed: true 
            });
            return res.status(500).json({ error: "Failed to query on-chain position" });
          }
          
          if (onChainPosition.side === 'FLAT' || Math.abs(onChainPosition.size) < 0.0001) {
            console.log(`[User Webhook] Close signal SKIPPED - no on-chain position found for bot ${bot.name} on ${bot.market} (subaccount ${subAccountId})`);
            await storage.updateWebhookLog(log.id, { 
              errorMessage: "Close signal ignored - no on-chain position", 
              processed: true 
            });
            return res.status(200).json({ 
              status: "skipped", 
              reason: "No on-chain position to close - this may be a stale SL/TP signal" 
            });
          }
          
          // Execute close using closePerpPosition
          const currentPositionSize = onChainPosition.size;
          console.log(`[User Webhook] *** EXECUTING CLOSE *** ON-CHAIN position: ${onChainPosition.side} ${Math.abs(currentPositionSize)} contracts on ${bot.market}`);
          
          const closeSide = onChainPosition.side === 'LONG' ? 'short' : 'long';
          const closeSize = Math.abs(currentPositionSize);
          
          // Create trade record for close
          const closeTrade = await storage.createBotTrade({
            tradingBotId: botId,
            walletAddress: bot.walletAddress,
            market: bot.market,
            side: "CLOSE",
            size: String(closeSize),
            price: signalPrice,
            status: "pending",
            webhookPayload: payload,
          });
          
          // Execute close
          const userCloseSlippageBps = wallet.slippageBps ?? 50;
          const result = await closePerpPosition(
            wallet.agentPrivateKeyEncrypted,
            bot.market,
            subAccountId,
            undefined,
            userCloseSlippageBps,
            privateKeyBase58,
            wallet.agentPublicKey || undefined
          );
          
          if (result.success && !result.signature) {
            console.log(`[User Webhook] closePerpPosition returned success but no signature - position was already closed`);
            await storage.updateBotTrade(closeTrade.id, { 
              status: "executed",
              txSignature: null,
              errorMessage: "Position already closed (no trade executed)"
            });
            await storage.updateWebhookLog(log.id, { 
              processed: true, 
              tradeExecuted: false,
              errorMessage: "Close signal processed - position was already flat"
            });
            return res.json({
              status: "success",
              type: "close",
              trade: closeTrade.id,
              message: "Position was already closed (no trade executed)",
            });
          }
          
          if (result.success && result.signature) {
            const closeFillPrice = parseFloat(signalPrice) || 0;
            const closeNotional = closeSize * closeFillPrice;
            const closeFee = closeNotional * DRIFT_FEE_RATE;
            
            // Calculate PnL
            const closeEntryPrice = onChainPosition.entryPrice || 0;
            let closeTradePnl = 0;
            if (closeEntryPrice > 0 && closeFillPrice > 0) {
              if (closeSide === 'short') {
                closeTradePnl = (closeFillPrice - closeEntryPrice) * closeSize - closeFee;
              } else {
                closeTradePnl = (closeEntryPrice - closeFillPrice) * closeSize - closeFee;
              }
              console.log(`[User Webhook] Close PnL: entry=$${closeEntryPrice.toFixed(2)}, exit=$${closeFillPrice.toFixed(2)}, pnl=$${closeTradePnl.toFixed(4)}`);
            }
            
            await storage.updateBotTrade(closeTrade.id, {
              status: "executed",
              txSignature: result.signature,
              price: closeFillPrice.toString(),
              fee: closeFee.toString(),
              pnl: closeTradePnl.toString(),
            });
            
            // Sync position from on-chain (this will clear the position since we just closed it)
            await syncPositionFromOnChain(
              botId,
              bot.walletAddress,
              wallet.agentPublicKey,
              subAccountId,
              bot.market,
              closeTrade.id,
              closeFee,
              closeFillPrice,
              closeSide,
              closeSize
            );
            
            // Update bot stats
            const stats = bot.stats as TradingBot['stats'] || { totalTrades: 0, winningTrades: 0, losingTrades: 0, totalPnl: 0, totalVolume: 0 };
            await storage.updateTradingBotStats(botId, {
              ...stats,
              totalTrades: (stats.totalTrades || 0) + 1,
              winningTrades: closeTradePnl > 0 ? (stats.winningTrades || 0) + 1 : (stats.winningTrades || 0),
              losingTrades: closeTradePnl < 0 ? (stats.losingTrades || 0) + 1 : (stats.losingTrades || 0),
              totalPnl: (stats.totalPnl || 0) + closeTradePnl,
              totalVolume: (stats.totalVolume || 0) + closeNotional,
              lastTradeAt: new Date().toISOString(),
            });
            
            await storage.updateWebhookLog(log.id, { processed: true, tradeExecuted: true });
            
            // Send position closed notification
            sendTradeNotification(walletAddress, {
              type: 'position_closed',
              botName: bot.name,
              market: bot.market,
              pnl: closeTradePnl,
            }).catch(err => console.error('[Notifications] Failed to send position_closed notification:', err));
            
            // PROFIT SHARE: If this is a subscriber bot with profitable close, distribute to creator
            // This must happen BEFORE auto-withdraw to ensure creator gets their share
            if (closeTradePnl > 0) {
              const tradeId = `${botId}-${Date.now()}`;
              distributeCreatorProfitShare({
                subscriberBotId: botId,
                subscriberWalletAddress: walletAddress,
                subscriberAgentPublicKey: wallet.agentPublicKey,
                subscriberEncryptedPrivateKey: wallet.agentPrivateKeyEncrypted,
                driftSubaccountId: subAccountId,
                realizedPnl: closeTradePnl,
                tradeId,
              }).then(result => {
                if (result.success && result.amount) {
                  console.log(`[User Webhook] Profit share distributed: $${result.amount.toFixed(4)}`);
                } else if (!result.success && result.error) {
                  console.error(`[User Webhook] Profit share failed: ${result.error}`);
                  // IOU is now created inside distributeCreatorProfitShare
                }
              }).catch(err => console.error('[User Webhook] Profit share error:', err));
            }
            
            // SETTLE PNL: Convert realized PnL to usable USDC balance for profit reinvest
            if (bot.profitReinvest) {
              try {
                console.log(`[User Webhook] Settling PnL for subaccount ${subAccountId} (profit reinvest enabled)`);
                const settleResult = await settleAllPnl(wallet.agentPublicKey, subAccountId);
                if (settleResult.success) {
                  console.log(`[User Webhook] PnL settled for ${settleResult.settledMarkets?.length || 0} market(s)`);
                } else {
                  console.warn(`[User Webhook] PnL settlement failed (non-blocking): ${settleResult.error}`);
                }
              } catch (settleErr: any) {
                console.warn(`[User Webhook] PnL settlement error (non-blocking): ${settleErr.message}`);
              }
            }
            
            // AUTO-WITHDRAW: Check if equity exceeds threshold and withdraw excess profits
            let autoWithdrawInfo = null;
            const autoWithdrawThreshold = parseFloat(bot.autoWithdrawThreshold || "0");
            if (autoWithdrawThreshold > 0) {
              try {
                const accountInfo = await getDriftAccountInfo(wallet.agentPublicKey, subAccountId);
                const currentEquity = accountInfo.totalCollateral;
                
                if (currentEquity > autoWithdrawThreshold) {
                  const excessAmount = currentEquity - autoWithdrawThreshold;
                  const withdrawAmount = Math.max(0, excessAmount - 0.01);
                  
                  if (withdrawAmount > 0.1) {
                    console.log(`[User Webhook] AUTO-WITHDRAW: Equity $${currentEquity.toFixed(2)} exceeds threshold $${autoWithdrawThreshold.toFixed(2)}, withdrawing $${withdrawAmount.toFixed(2)}`);
                    
                    const withdrawResult = await executeAgentDriftWithdraw(
                      wallet.agentPublicKey,
                      wallet.agentPrivateKeyEncrypted!,
                      withdrawAmount,
                      subAccountId
                    );
                    
                    if (withdrawResult.success) {
                      console.log(`[User Webhook] AUTO-WITHDRAW SUCCESS: $${withdrawAmount.toFixed(2)} withdrawn, tx: ${withdrawResult.signature}`);
                      autoWithdrawInfo = {
                        amount: withdrawAmount,
                        txSignature: withdrawResult.signature,
                      };
                      
                      await storage.createEquityEvent({
                        walletAddress: bot.walletAddress,
                        tradingBotId: botId,
                        eventType: 'auto_withdraw',
                        amount: String(withdrawAmount),
                        txSignature: withdrawResult.signature || null,
                        notes: `Auto-withdraw triggered: equity $${currentEquity.toFixed(2)} exceeded threshold $${autoWithdrawThreshold.toFixed(2)}`,
                      });
                    } else {
                      console.error(`[User Webhook] AUTO-WITHDRAW FAILED: ${withdrawResult.error}`);
                    }
                  }
                }
              } catch (autoWithdrawErr: any) {
                console.error(`[User Webhook] AUTO-WITHDRAW check error (non-blocking):`, autoWithdrawErr.message);
              }
            }
            
            return res.json({
              status: "success",
              type: "close",
              trade: closeTrade.id,
              txSignature: result.signature,
              closedSize: closeSize,
              pnl: closeTradePnl,
              ...(autoWithdrawInfo && { autoWithdraw: autoWithdrawInfo }),
            });
          }
          
          // Close failed
          console.error(`[User Webhook] Close order failed:`, result.error);
          await storage.updateBotTrade(closeTrade.id, {
            status: "failed",
            txSignature: null,
            errorMessage: result.error || "Close order failed",
          });
          await storage.updateWebhookLog(log.id, { 
            errorMessage: result.error || "Close order failed", 
            processed: true 
          });
          return res.status(500).json({ error: result.error || "Close order failed" });
          
        } catch (closeHandlerError: any) {
          console.error(`[User Webhook] Close handler error:`, closeHandlerError);
          await storage.updateWebhookLog(log.id, { 
            errorMessage: closeHandlerError.message || "Close signal processing failed", 
            processed: true 
          });
          return res.status(500).json({ 
            error: "Close signal processing failed", 
            details: closeHandlerError.message 
          });
        }
      }

      // Create trade record
      const trade = await storage.createBotTrade({
        tradingBotId: botId,
        walletAddress: bot.walletAddress,
        market: bot.market,
        side: side.toUpperCase(),
        size: contracts || positionSize,
        price: signalPrice,
        status: "pending",
        webhookPayload: payload,
      });

      if (signalTime) {
        console.log(`[User Webhook] Signal time from TradingView: ${signalTime}`);
      }

      // NOTE: Auto-deposit has been disabled per user request
      // Funds should be manually deposited to Drift before trading

      // Execute trade on Drift Protocol
      // Get wallet's agent private key for signing
      const userWallet = await storage.getWallet(walletAddress);
      if (!userWallet?.agentPrivateKeyEncrypted) {
        await storage.updateBotTrade(trade.id, {
          status: "failed",
          txSignature: null,
        });
        await storage.updateWebhookLog(log.id, { errorMessage: "Agent wallet not configured", processed: true });
        return res.status(400).json({ error: "Agent wallet not configured" });
      }

      // Get current market price from oracle (used for order execution)
      const oraclePrice = await getMarketPrice(bot.market);
      if (!oraclePrice || oraclePrice <= 0) {
        await storage.updateBotTrade(trade.id, {
          status: "failed",
          txSignature: null,
        });
        await storage.updateWebhookLog(log.id, { errorMessage: "Could not get market price", processed: true });
        return res.status(500).json({ error: "Could not get market price" });
      }

      // USDT-to-Percentage Translation:
      // TradingView is configured with USDT order size (e.g., 33.33 USDT)
      // TradingView sends contracts = USDT / price (e.g., 33.33 / 136 = 0.245)
      // We reverse this using TradingView's price to recover exact USDT value
      const contractsFromTV = parseFloat(contracts || "0");
      
      // Use TradingView's signal price for reverse calculation (more accurate)
      // Fall back to oracle price if signal price is invalid
      const tvPrice = parseFloat(signalPrice) || 0;
      const priceForReversal = (tvPrice > 0 && Math.abs(tvPrice - oraclePrice) / oraclePrice < 0.10) 
        ? tvPrice 
        : oraclePrice;
      
      const usdtValue = contractsFromTV * priceForReversal; // Reverse TradingView's calculation
      const rawSignalPercent = usdtValue; // Treat USDT value as percentage
      const signalPercent = Math.min(rawSignalPercent, 100); // Cap at 100% to prevent accidental oversized orders
      
      console.log(`[User Webhook] TradingView sent ${contractsFromTV} contracts × $${priceForReversal.toFixed(2)} (TV price) = ${usdtValue.toFixed(2)} USDT → ${rawSignalPercent > 100 ? `capped from ${rawSignalPercent.toFixed(2)}% to ` : ''}${signalPercent.toFixed(2)}%`);
      if (Math.abs(tvPrice - oraclePrice) > 0.01) {
        console.log(`[User Webhook] Price comparison: TradingView=$${tvPrice.toFixed(2)}, Oracle=$${oraclePrice.toFixed(2)}, using ${tvPrice === priceForReversal ? 'TradingView' : 'Oracle'}`);
      }

      const baseCapital = parseFloat(bot.maxPositionSize || "0");
      const profitReinvestEnabled = bot.profitReinvest === true;
      const botLeverage = Math.max(1, bot.leverage || 1); // Ensure leverage >= 1
      const marketMaxLeverage = getMarketMaxLeverage(bot.market);
      const effectiveLeverage = Math.min(botLeverage, marketMaxLeverage); // Use the lower of bot's setting or market's limit
      const subAccountId = bot.driftSubaccountId ?? 0;
      
      if (botLeverage > marketMaxLeverage) {
        console.log(`[User Webhook] Leverage capped: ${botLeverage}x → ${marketMaxLeverage}x (${bot.market} max)`);
      }
      
      if (baseCapital <= 0 && !profitReinvestEnabled) {
        await storage.updateBotTrade(trade.id, {
          status: "failed",
          txSignature: null,
        });
        await storage.updateWebhookLog(log.id, { errorMessage: `Bot has no capital configured`, processed: true });
        return res.status(400).json({ error: `Bot has no capital configured. Set Max Position Size on the bot.` });
      }
      
      // Calculate trade amount based on profit reinvest setting
      let tradeAmountUsd: number = 0; // Initialize to 0 for safety
      let maxTradeableValue = 0;
      
      try {
        const accountInfo = await getDriftAccountInfo(userWallet.agentPublicKey!, subAccountId);
        const freeCollateral = Math.max(0, accountInfo.freeCollateral);
        // CRITICAL: Use effectiveLeverage (capped by market's max) to avoid InsufficientCollateral errors
        const maxNotionalCapacity = freeCollateral * effectiveLeverage;
        maxTradeableValue = maxNotionalCapacity * 0.90;
        
        if (profitReinvestEnabled) {
          // PROFIT REINVEST MODE: Use full available margin instead of fixed maxPositionSize
          if (maxTradeableValue <= 0) {
            await storage.updateBotTrade(trade.id, { status: "failed", txSignature: null });
            await storage.updateWebhookLog(log.id, { errorMessage: `Profit reinvest: no margin available`, processed: true });
            return res.status(400).json({ error: `Cannot trade: profit reinvest enabled but no margin available (freeCollateral=$${freeCollateral.toFixed(2)})` });
          }
          // Calculate requested trade size, then cap to available margin
          const requestedAmount = signalPercent > 0 ? (signalPercent / 100) * maxTradeableValue : maxTradeableValue;
          tradeAmountUsd = Math.min(requestedAmount, maxTradeableValue); // CRITICAL: Never exceed available margin
          console.log(`[User Webhook] PROFIT REINVEST: freeCollateral=$${freeCollateral.toFixed(2)} × ${effectiveLeverage}x × 90% = $${maxTradeableValue.toFixed(2)} max`);
          if (requestedAmount > maxTradeableValue) {
            console.log(`[User Webhook] Requested $${requestedAmount.toFixed(2)} exceeds available, capped to $${tradeAmountUsd.toFixed(2)}`);
          } else {
            console.log(`[User Webhook] ${signalPercent.toFixed(2)}% of $${maxTradeableValue.toFixed(2)} available margin = $${tradeAmountUsd.toFixed(2)} trade`);
          }
        } else {
          // NORMAL MODE: Use fixed maxPositionSize, scale down if needed
          tradeAmountUsd = signalPercent > 0 ? (signalPercent / 100) * baseCapital : baseCapital;
          console.log(`[User Webhook] ${signalPercent.toFixed(2)}% of $${baseCapital} maxPositionSize = $${tradeAmountUsd.toFixed(2)} trade (before collateral check)`);
          console.log(`[User Webhook] Dynamic scaling: freeCollateral=$${freeCollateral.toFixed(2)} × ${effectiveLeverage}x leverage = $${maxNotionalCapacity.toFixed(2)} max notional (using $${maxTradeableValue.toFixed(2)} with 90% buffer)`);
          
          if (maxTradeableValue <= 0) {
            console.log(`[User Webhook] No margin available (freeCollateral=$${freeCollateral.toFixed(2)}), will attempt minimum viable trade`);
          } else if (tradeAmountUsd > maxTradeableValue) {
            const originalAmount = tradeAmountUsd;
            tradeAmountUsd = maxTradeableValue;
            const scalePercent = ((tradeAmountUsd / originalAmount) * 100).toFixed(1);
            console.log(`[User Webhook] SCALED DOWN: Trade reduced from $${originalAmount.toFixed(2)} to $${tradeAmountUsd.toFixed(2)} (${scalePercent}% of requested, will scale back up as equity recovers)`);
          } else {
            console.log(`[User Webhook] Full size available: $${tradeAmountUsd.toFixed(2)} within $${maxTradeableValue.toFixed(2)} capacity`);
          }
        }
      } catch (collateralErr: any) {
        console.warn(`[User Webhook] Could not check collateral: ${collateralErr.message}`);
        if (profitReinvestEnabled) {
          await storage.updateWebhookLog(log.id, { errorMessage: `Profit reinvest requires collateral check`, processed: true });
          return res.status(500).json({ error: `Cannot execute trade: profit reinvest enabled but collateral check failed` });
        }
        tradeAmountUsd = signalPercent > 0 ? (signalPercent / 100) * baseCapital : baseCapital;
        console.log(`[User Webhook] Fallback to fixed size: $${tradeAmountUsd.toFixed(2)}`);
      }
      
      console.log(`[User Webhook] Final trade amount: $${tradeAmountUsd.toFixed(2)}`);

      // Calculate contract size - maxPositionSize already includes leverage (set during bot creation)
      // So we just divide by price to get contracts, no additional leverage multiplication needed
      const contractSize = tradeAmountUsd / oraclePrice;
      
      console.log(`[User Webhook] $${tradeAmountUsd.toFixed(2)} / $${oraclePrice.toFixed(2)} = ${contractSize.toFixed(6)} contracts`);

      // Get minimum order size for this market from market metadata
      const minOrderSize = getMinOrderSize(bot.market);
      
      if (contractSize < minOrderSize) {
        const minCapitalNeeded = minOrderSize * oraclePrice;
        const errorMsg = `Order too small: ${contractSize.toFixed(6)} contracts is below minimum ${minOrderSize} for ${bot.market}. At $${oraclePrice.toFixed(2)}, you need at least $${minCapitalNeeded.toFixed(2)} Max Position Size. Increase your investment or reduce pyramid entries.`;
        console.log(`[User Webhook] ${errorMsg}`);
        await storage.updateBotTrade(trade.id, {
          status: "failed",
          txSignature: null,
          size: contractSize.toFixed(8),
        });
        await storage.updateWebhookLog(log.id, { errorMessage: errorMsg, processed: true });
        return res.status(400).json({ error: errorMsg });
      }

      // Execute on Drift (subAccountId already declared above for collateral check)
      const userSlippageBps2 = userWallet.slippageBps ?? 50;
      const orderResult = await executePerpOrder(
        userWallet.agentPrivateKeyEncrypted,
        bot.market,
        side,
        contractSize,
        subAccountId,
        false,
        userSlippageBps2,
        privateKeyBase58,
        userWallet.agentPublicKey || undefined
      );

      if (!orderResult.success) {
        const userFriendlyError = parseDriftError(orderResult.error);
        console.log(`[User Webhook] Trade failed: ${orderResult.error}`);
        await storage.updateBotTrade(trade.id, {
          status: "failed",
          txSignature: null,
          size: contractSize.toFixed(8),
          errorMessage: userFriendlyError,
        });
        await storage.updateWebhookLog(log.id, { errorMessage: orderResult.error || "Order execution failed", processed: true });
        
        // Send trade failed notification
        sendTradeNotification(walletAddress, {
          type: 'trade_failed',
          botName: bot.name,
          market: bot.market,
          side: side === 'long' ? 'LONG' : 'SHORT',
          error: userFriendlyError,
        }).catch(err => console.error('[Notifications] Failed to send trade_failed notification:', err));
        
        return res.status(500).json({ error: userFriendlyError });
      }

      const userFillPrice = orderResult.fillPrice || parseFloat(signalPrice || "0");
      
      // Calculate fee (0.05% taker fee on notional value)
      const userTradeNotional = contractSize * userFillPrice;
      const userTradeFee = userTradeNotional * DRIFT_FEE_RATE;
      
      await storage.updateBotTrade(trade.id, {
        status: "executed",
        price: userFillPrice.toString(),
        fee: userTradeFee.toString(),
        txSignature: orderResult.txSignature || orderResult.signature || null,
        size: contractSize.toFixed(8), // Store calculated size, not raw TradingView value
      });

      // Sync position from on-chain (replaces client-side math with actual Drift state)
      const syncResult = await syncPositionFromOnChain(
        botId,
        bot.walletAddress,
        userWallet.agentPublicKey!,
        subAccountId,
        bot.market,
        trade.id,
        userTradeFee,
        userFillPrice,
        side,
        contractSize
      );

      // Update bot stats (including volume for FUEL tracking)
      const stats = bot.stats as TradingBot['stats'] || { totalTrades: 0, winningTrades: 0, losingTrades: 0, totalPnl: 0, totalVolume: 0 };
      await storage.updateTradingBotStats(botId, {
        ...stats,
        totalTrades: (stats.totalTrades || 0) + 1,
        winningTrades: syncResult.isClosingTrade && (syncResult.tradePnl ?? 0) > 0 ? (stats.winningTrades || 0) + 1 : (stats.winningTrades || 0),
        losingTrades: syncResult.isClosingTrade && (syncResult.tradePnl ?? 0) < 0 ? (stats.losingTrades || 0) + 1 : (stats.losingTrades || 0),
        totalPnl: (stats.totalPnl || 0) + (syncResult.tradePnl ?? 0),
        totalVolume: (stats.totalVolume || 0) + userTradeNotional,
        lastTradeAt: new Date().toISOString(),
      });

      // Send trade notification (async, don't block response)
      sendTradeNotification(walletAddress, {
        type: 'trade_executed',
        botName: bot.name,
        market: bot.market,
        side: side === 'long' ? 'LONG' : 'SHORT',
        size: userTradeNotional,
        price: userFillPrice,
      }).catch(err => console.error('[Notifications] Failed to send trade_executed notification:', err));

      // Mark signal as executed (unique index prevents concurrent duplicates)
      try {
        await storage.updateWebhookLog(log.id, { processed: true, tradeExecuted: true });
      } catch (dbError: any) {
        // Unique constraint violation means another request already executed this signal
        if (dbError?.code === '23505') {
          console.log(`[User Webhook] Concurrent duplicate detected at DB level, signal already executed: hash=${signalHash}`);
          return res.status(200).json({ status: "skipped", reason: "concurrent duplicate" });
        }
        throw dbError;
      }

      res.json({
        success: true,
        action: action,
        side: side,
        tradeId: trade.id,
        market: bot.market,
        size: positionSize,
        botId: botId,
        txSignature: orderResult.txSignature || orderResult.signature,
        signalHash,
      });
      } finally {
        // PHASE 6.2: Ensure agent key is cleaned up after execution
        cleanupAgentKey();
      }
    } catch (error) {
      console.error("User webhook processing error:", error);
      await storage.updateWebhookLog(log.id, { errorMessage: String(error) });
      res.status(500).json({ error: "Failed to process webhook" });
    }
  });

  // Get user webhook URL
  app.get("/api/user/webhook-url", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }

      // Use production domain for webhooks, falling back to Replit domains for dev
      const baseUrl = process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT_DOMAIN
        ? 'https://myquantumvault.com'
        : process.env.REPLIT_DEV_DOMAIN 
        ? `https://${process.env.REPLIT_DEV_DOMAIN}`
        : 'http://localhost:5000';

      // Generate secret if not exists
      if (!wallet.userWebhookSecret) {
        const userWebhookSecret = generateWebhookSecret();
        await storage.updateWalletWebhookSecret(req.walletAddress!, userWebhookSecret);
        const updatedWallet = await storage.getWallet(req.walletAddress!);
        if (!updatedWallet?.userWebhookSecret) {
          return res.status(500).json({ error: "Failed to generate webhook secret" });
        }
        
        return res.json({
          webhookUrl: `${baseUrl}/api/webhook/user/${req.walletAddress}?secret=${updatedWallet.userWebhookSecret}`,
        });
      }

      res.json({
        webhookUrl: `${baseUrl}/api/webhook/user/${req.walletAddress}?secret=${wallet.userWebhookSecret}`,
      });
    } catch (error) {
      console.error("Get user webhook URL error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Legacy auth routes (kept for compatibility)
  app.post("/api/auth/register", async (req, res) => {
    try {
      const { username, password } = insertUserSchema.parse(req.body);
      const existingUser = await storage.getUserByUsername(username);
      if (existingUser) {
        return res.status(400).json({ error: "Username already taken" });
      }
      const passwordHash = await bcrypt.hash(password, 10);
      const user = await storage.createUser({ username, password: passwordHash });
      await storage.upsertPortfolio({
        userId: user.id,
        totalValue: "10000",
        unrealizedPnl: "0",
        realizedPnl: "0",
        solBalance: "0",
        usdcBalance: "10000",
      });
      await storage.upsertLeaderboardStats({
        userId: user.id,
        totalVolume: "0",
        totalPnl: "0",
        winRate: "0",
        totalTrades: 0,
      });
      req.session.userId = user.id;
      res.json({ id: user.id, username: user.username, displayName: user.displayName });
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({ error: "Invalid input", details: error.errors });
      }
      console.error("Registration error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const { username, password } = req.body;
      const user = await storage.getUserByUsername(username);
      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      const validPassword = await bcrypt.compare(password, user.password);
      if (!validPassword) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      req.session.userId = user.id;
      res.json({ id: user.id, username: user.username, displayName: user.displayName });
    } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ error: "Failed to logout" });
      }
      res.json({ success: true });
    });
  });

  app.get("/api/auth/me", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json({ id: user.id, username: user.username, displayName: user.displayName });
    } catch (error) {
      console.error("Get user error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Bot marketplace routes
  app.get("/api/bots", async (req, res) => {
    try {
      const featured = req.query.featured === "true";
      const bots = featured ? await storage.getFeaturedBots() : await storage.getAllBots();
      res.json(bots);
    } catch (error) {
      console.error("Get bots error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/bots/:id", async (req, res) => {
    try {
      const bot = await storage.getBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      res.json(bot);
    } catch (error) {
      console.error("Get bot error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/subscriptions", requireAuth, async (req, res) => {
    try {
      const { botId } = req.body;
      const userId = req.session.userId!;
      const existingSubs = await storage.getUserSubscriptions(userId);
      if (existingSubs.some((sub) => sub.botId === botId && sub.status === "active")) {
        return res.status(400).json({ error: "Already subscribed to this bot" });
      }
      const subscription = await storage.createSubscription({ userId, botId, status: "active" });
      await storage.incrementBotSubscribers(botId, 1);
      res.json(subscription);
    } catch (error) {
      console.error("Subscribe error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/subscriptions", requireAuth, async (req, res) => {
    try {
      const subscriptions = await storage.getUserSubscriptions(req.session.userId!);
      res.json(subscriptions);
    } catch (error) {
      console.error("Get subscriptions error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.patch("/api/subscriptions/:id", requireAuth, async (req, res) => {
    try {
      const { status } = req.body;
      await storage.updateSubscriptionStatus(req.params.id, status);
      res.json({ success: true });
    } catch (error) {
      console.error("Update subscription error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/portfolio", requireAuth, async (req, res) => {
    try {
      const portfolio = await storage.getPortfolio(req.session.userId!);
      res.json(portfolio);
    } catch (error) {
      console.error("Get portfolio error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/positions", requireAuth, async (req, res) => {
    try {
      const positions = await storage.getUserPositions(req.session.userId!);
      res.json(positions);
    } catch (error) {
      console.error("Get positions error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/trades", requireAuth, async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
      const trades = await storage.getUserTrades(req.session.userId!, limit);
      res.json(trades);
    } catch (error) {
      console.error("Get trades error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/leaderboard", async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;
      const leaderboard = await storage.getWalletLeaderboard(limit);
      res.json(leaderboard);
    } catch (error) {
      console.error("Get leaderboard error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/prices", async (req, res) => {
    try {
      const prices = await getAllPrices();
      res.json(prices);
    } catch (error) {
      console.error("Get prices error:", error);
      res.status(500).json({ error: "Failed to fetch prices" });
    }
  });

  // Get all available Drift perp markets with liquidity info
  app.get("/api/drift/markets", async (req, res) => {
    try {
      const forceRefresh = req.query.refresh === 'true';
      const markets = await getAllPerpMarkets(forceRefresh);
      
      // Add risk tier info to each market
      const marketsWithInfo = markets.map(market => ({
        ...market,
        riskTierInfo: getRiskTierInfo(market.riskTier),
      }));
      
      res.json({
        markets: marketsWithInfo,
        totalMarkets: markets.length,
        recommended: markets.filter(m => m.riskTier === 'recommended').length,
        caution: markets.filter(m => m.riskTier === 'caution').length,
        highRisk: markets.filter(m => m.riskTier === 'high_risk').length,
      });
    } catch (error) {
      console.error("Get Drift markets error:", error);
      res.status(500).json({ error: "Failed to fetch markets" });
    }
  });

  // Get single market info
  app.get("/api/drift/markets/:symbol", async (req, res) => {
    try {
      const { symbol } = req.params;
      const market = await getMarketBySymbol(symbol);
      
      if (!market) {
        return res.status(404).json({ error: "Market not found" });
      }
      
      res.json({
        ...market,
        riskTierInfo: getRiskTierInfo(market.riskTier),
      });
    } catch (error) {
      console.error("Get market error:", error);
      res.status(500).json({ error: "Failed to fetch market" });
    }
  });

  // Get market liquidity cache status
  app.get("/api/drift/markets/cache/status", async (req, res) => {
    try {
      const status = getCacheStatus();
      res.json(status);
    } catch (error) {
      console.error("Get cache status error:", error);
      res.status(500).json({ error: "Failed to get cache status" });
    }
  });

  // USDC APY cache and shared helper function
  let usdcApyCache: { apy: number; timestamp: number } | null = null;
  const USDC_APY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  const USDC_APY_FALLBACK = 5.3; // Fallback APY percentage if fetch fails

  // Shared helper to get current USDC APY (fetches fresh if cache expired)
  async function getUsdcApy(): Promise<{ apy: number; cached: boolean; stale?: boolean }> {
    // Return cached value if still valid
    if (usdcApyCache && Date.now() - usdcApyCache.timestamp < USDC_APY_CACHE_TTL) {
      return { apy: usdcApyCache.apy, cached: true };
    }

    try {
      // Fetch fresh data from Drift Data API
      const response = await fetch('https://data.api.drift.trade/rateHistory?marketIndex=0&marketType=spot');
      if (!response.ok) {
        throw new Error(`Drift API returned ${response.status}`);
      }

      const data = await response.json();
      if (!data.success || !data.data || data.data.length === 0) {
        throw new Error('Invalid response from Drift API');
      }

      // Get the latest APY (last entry in array)
      const latestEntry = data.data[data.data.length - 1];
      const apy = parseFloat(latestEntry[1]) * 100; // Convert to percentage

      // Cache the result
      usdcApyCache = { apy, timestamp: Date.now() };

      return { apy, cached: false };
    } catch (error) {
      console.error("Get USDC APY error:", error);
      // Return cached value on error if available, otherwise fallback
      if (usdcApyCache) {
        return { apy: usdcApyCache.apy, cached: true, stale: true };
      }
      return { apy: USDC_APY_FALLBACK, cached: false, stale: true };
    }
  }

  // Get current USDC deposit APY from Drift Data API
  app.get("/api/drift/usdc-apy", async (req, res) => {
    try {
      const result = await getUsdcApy();
      res.json(result);
    } catch (error) {
      console.error("Get USDC APY endpoint error:", error);
      res.status(500).json({ error: "Failed to fetch USDC APY" });
    }
  });

  // Force refresh market OI data (admin endpoint)
  app.post("/api/admin/liquidity/refresh", async (req, res) => {
    try {
      console.log('[Admin] Force refreshing market liquidity data...');
      const result = await refreshMarketData();
      res.json(result);
    } catch (error: any) {
      console.error("Refresh market data error:", error);
      res.status(500).json({ error: error.message || "Failed to refresh market data" });
    }
  });

  // SSE endpoint for real-time price streaming (must come BEFORE :market route)
  app.get("/api/prices/stream", async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    const sendPrices = async () => {
      try {
        const prices = await getAllPrices();
        res.write(`data: ${JSON.stringify(prices)}\n\n`);
      } catch (e) {
        console.error('[SSE] Price fetch error:', e);
      }
    };

    await sendPrices();
    const interval = setInterval(sendPrices, 3000);
    req.on('close', () => clearInterval(interval));
  });

  app.get("/api/prices/:market", async (req, res) => {
    try {
      const { market } = req.params;
      const price = await getMarketPrice(market);
      if (price === null) {
        return res.status(404).json({ error: "Market not found or price unavailable" });
      }
      res.json({ market, price });
    } catch (error) {
      console.error("Get price error:", error);
      res.status(500).json({ error: "Failed to fetch price" });
    }
  });

  app.post("/api/drift/deposit", async (req, res) => {
    try {
      const { walletAddress, amount } = req.body;
      if (!walletAddress) {
        return res.status(400).json({ error: "Wallet address required" });
      }
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }
      const result = await buildDepositTransaction(walletAddress, amount);
      res.json(result);
    } catch (error) {
      console.error("Drift deposit error:", error);
      res.status(500).json({ error: "Failed to build deposit transaction" });
    }
  });

  app.post("/api/drift/withdraw", async (req, res) => {
    try {
      const { walletAddress, amount } = req.body;
      if (!walletAddress) {
        return res.status(400).json({ error: "Wallet address required" });
      }
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }
      const result = await buildWithdrawTransaction(walletAddress, amount);
      res.json(result);
    } catch (error) {
      console.error("Drift withdraw error:", error);
      res.status(500).json({ error: "Failed to build withdraw transaction" });
    }
  });

  app.get("/api/drift/balance", async (req, res) => {
    try {
      const walletAddress = req.query.wallet as string;
      if (!walletAddress) {
        return res.status(400).json({ error: "Wallet address required" });
      }
      const [usdcBalance, driftBalance] = await Promise.all([
        getUsdcBalance(walletAddress),
        getDriftBalance(walletAddress),
      ]);
      res.json({ usdcBalance, driftBalance });
    } catch (error) {
      console.error("Drift balance error:", error);
      res.status(500).json({ error: "Failed to fetch balances" });
    }
  });

  // Get total equity across all bot subaccounts and agent wallet
  // OPTIMIZED: Uses batch RPC call instead of N sequential calls
  app.get("/api/total-equity", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      const bots = await storage.getTradingBots(req.walletAddress!);
      const agentAddress = wallet?.agentPublicKey;
      
      // Collect all subaccount IDs that need to be fetched (deduplicated)
      const subAccountIdSet = new Set<number>();
      for (const bot of bots) {
        if (bot.driftSubaccountId !== null && bot.driftSubaccountId !== undefined) {
          subAccountIdSet.add(bot.driftSubaccountId);
        }
      }
      const subAccountIds = Array.from(subAccountIdSet);
      
      // BATCH OPTIMIZATION: Fetch all data in parallel
      // Previously: N bots × 3 RPC calls = 3N RPC calls
      // Now: 2 RPC for agent balances + 2 RPC for all subaccounts = 4 RPC total
      const [agentBalance, solBalance, batchAccountInfo] = await Promise.all([
        agentAddress ? getAgentUsdcBalance(agentAddress) : Promise.resolve(0),
        agentAddress ? getAgentSolBalance(agentAddress) : Promise.resolve(0),
        agentAddress && subAccountIds.length > 0 
          ? getBatchDriftAccountInfo(agentAddress, subAccountIds)
          : Promise.resolve(new Map()),
      ]);
      
      // Build subaccount balances from batch result
      let driftBalance = 0;
      const subaccountBalances: { botId: string; botName: string; subaccountId: number; balance: number }[] = [];
      
      for (const bot of bots) {
        if (bot.driftSubaccountId !== null && bot.driftSubaccountId !== undefined) {
          const accountInfo = batchAccountInfo.get(bot.driftSubaccountId);
          if (accountInfo) {
            driftBalance += accountInfo.totalCollateral;
            subaccountBalances.push({
              botId: bot.id,
              botName: bot.name,
              subaccountId: bot.driftSubaccountId,
              balance: accountInfo.totalCollateral,
            });
          } else {
            // Subaccount doesn't exist or failed to fetch
            subaccountBalances.push({
              botId: bot.id,
              botName: bot.name,
              subaccountId: bot.driftSubaccountId,
              balance: 0,
            });
          }
        }
      }
      
      const totalEquity = agentBalance + driftBalance;
      
      res.json({ 
        agentBalance,
        driftBalance,
        totalEquity,
        solBalance,
        botCount: bots.length,
        subaccountBalances,
      });
    } catch (error) {
      console.error("Total equity error:", error);
      res.status(500).json({ error: "Failed to fetch total equity" });
    }
  });

  // Bot deposit - transfer from main Drift account to bot's subaccount
  app.post("/api/bot/:botId/deposit", requireWallet, async (req, res) => {
    try {
      const { botId } = req.params;
      const { amount } = req.body;
      
      const bot = await storage.getTradingBotById(botId);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }
      if (bot.driftSubaccountId === null || bot.driftSubaccountId === undefined) {
        return res.status(400).json({ error: "Bot has no Drift subaccount assigned" });
      }
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }

      const result = await buildTransferToSubaccountTransaction(
        req.walletAddress!,
        0, // from main account
        bot.driftSubaccountId,
        amount
      );
      res.json(result);
    } catch (error: any) {
      console.error("Bot deposit error:", error);
      res.status(500).json({ error: error.message || "Failed to build deposit transaction" });
    }
  });

  // Bot withdraw - transfer from bot's subaccount back to main Drift account
  app.post("/api/bot/:botId/withdraw", requireWallet, async (req, res) => {
    try {
      const { botId } = req.params;
      const { amount } = req.body;
      
      const bot = await storage.getTradingBotById(botId);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }
      if (bot.driftSubaccountId === null || bot.driftSubaccountId === undefined) {
        return res.status(400).json({ error: "Bot has no Drift subaccount assigned" });
      }
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }

      const result = await buildTransferFromSubaccountTransaction(
        req.walletAddress!,
        bot.driftSubaccountId,
        0, // to main account
        amount
      );
      res.json(result);
    } catch (error: any) {
      console.error("Bot withdraw error:", error);
      res.status(500).json({ error: error.message || "Failed to build withdraw transaction" });
    }
  });

  // RPC Status endpoint - check health of primary and backup RPC providers
  app.get("/api/rpc-status", async (req, res) => {
    try {
      const IS_MAINNET = process.env.DRIFT_ENV !== 'devnet';
      
      // Determine RPC URLs
      let primaryUrl: string;
      let primaryName: string;
      
      if (process.env.SOLANA_RPC_URL) {
        primaryUrl = process.env.SOLANA_RPC_URL;
        primaryName = 'Custom RPC';
      } else if (IS_MAINNET && process.env.HELIUS_API_KEY) {
        primaryUrl = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
        primaryName = 'Helius';
      } else {
        primaryUrl = IS_MAINNET ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com';
        primaryName = 'Solana Public';
      }
      
      let backupUrl = process.env.TRITON_ONE_RPC || null;
      // Ensure backup URL has protocol prefix
      if (backupUrl && !backupUrl.startsWith('http://') && !backupUrl.startsWith('https://')) {
        backupUrl = `https://${backupUrl}`;
      }
      const backupName = backupUrl ? 'Triton One' : null;
      
      // Helper to check RPC health
      const checkRpcHealth = async (url: string): Promise<{ healthy: boolean; latency: number | null; slot: number | null; error?: string }> => {
        const start = Date.now();
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }),
            signal: AbortSignal.timeout(5000),
          });
          const data = await response.json() as any;
          const latency = Date.now() - start;
          
          if (data.result) {
            return { healthy: true, latency, slot: data.result };
          } else {
            return { healthy: false, latency: null, slot: null, error: data.error?.message || 'Unknown error' };
          }
        } catch (err: any) {
          return { healthy: false, latency: null, slot: null, error: err.message || 'Connection failed' };
        }
      };
      
      // Check both RPCs in parallel
      const [primaryStatus, backupStatus] = await Promise.all([
        checkRpcHealth(primaryUrl),
        backupUrl ? checkRpcHealth(backupUrl) : Promise.resolve(null),
      ]);
      
      res.json({
        primary: {
          name: primaryName,
          configured: true,
          ...primaryStatus,
        },
        backup: backupUrl ? {
          name: backupName,
          configured: true,
          ...backupStatus,
        } : {
          name: null,
          configured: false,
          healthy: false,
          latency: null,
          slot: null,
        },
        network: IS_MAINNET ? 'mainnet-beta' : 'devnet',
      });
    } catch (error: any) {
      console.error("RPC status error:", error);
      res.status(500).json({ error: "Failed to check RPC status" });
    }
  });

  // Solana RPC proxy - forwards requests to Helius securely with rate limiting and caching
  const rpcCache = new Map<string, { data: any; timestamp: number }>();
  const RPC_CACHE_TTL = 2000; // 2 second cache for balance/account queries
  const RPC_RATE_LIMIT_WINDOW = 1000; // 1 second window
  const RPC_MAX_REQUESTS_PER_WINDOW = 25; // Max requests per second
  let rpcRequestCount = 0;
  let rpcWindowStart = Date.now();
  
  app.post("/api/solana-rpc", async (req, res) => {
    try {
      const IS_MAINNET = process.env.DRIFT_ENV !== 'devnet';
      let rpcUrl: string;
      
      if (process.env.SOLANA_RPC_URL) {
        rpcUrl = process.env.SOLANA_RPC_URL;
      } else if (IS_MAINNET && process.env.HELIUS_API_KEY) {
        rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
      } else {
        rpcUrl = IS_MAINNET ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com';
      }
      
      // Create cache key from request body (excluding id which changes per request)
      const { id, ...bodyWithoutId } = req.body;
      const cacheKey = JSON.stringify(bodyWithoutId);
      
      // Check cache first for read-only methods
      const readOnlyMethods = ['getAccountInfo', 'getBalance', 'getTokenAccountBalance', 'getMultipleAccounts'];
      const method = req.body?.method;
      if (readOnlyMethods.includes(method)) {
        const cached = rpcCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < RPC_CACHE_TTL) {
          // Return cached response with the current request's id
          return res.json({ ...cached.data, id });
        }
      }
      
      // Rate limiting check
      const now = Date.now();
      if (now - rpcWindowStart > RPC_RATE_LIMIT_WINDOW) {
        rpcWindowStart = now;
        rpcRequestCount = 0;
      }
      
      if (rpcRequestCount >= RPC_MAX_REQUESTS_PER_WINDOW) {
        // Return rate limited response without crashing
        return res.json({
          jsonrpc: "2.0",
          error: { code: -32429, message: "rate limited" },
          id
        });
      }
      
      rpcRequestCount++;
      
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
      });
      
      const data = await response.json();
      
      // Cache successful responses for read-only methods
      if (readOnlyMethods.includes(method) && !data.error) {
        rpcCache.set(cacheKey, { data, timestamp: Date.now() });
        // Cleanup old cache entries periodically
        if (rpcCache.size > 500) {
          const cutoff = Date.now() - RPC_CACHE_TTL;
          const keysToDelete: string[] = [];
          rpcCache.forEach((value, key) => {
            if (value.timestamp < cutoff) keysToDelete.push(key);
          });
          keysToDelete.forEach(key => rpcCache.delete(key));
        }
      }
      
      res.json(data);
    } catch (error: any) {
      console.error("RPC proxy error:", error);
      res.status(500).json({ 
        jsonrpc: "2.0",
        error: { code: -32603, message: "RPC request failed" },
        id: req.body?.id || null 
      });
    }
  });

  // Bot balance - get subaccount balance from Drift plus realized PnL from positions
  app.get("/api/bot/:botId/balance", requireWallet, async (req, res) => {
    try {
      const { botId } = req.params;
      
      const bot = await storage.getTradingBotById(botId);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (bot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Forbidden" });
      }
      if (bot.driftSubaccountId === null || bot.driftSubaccountId === undefined) {
        return res.status(400).json({ error: "Bot has no Drift subaccount assigned" });
      }

      // Get the agent wallet address - this is where Drift funds are held
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet || !wallet.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }
      const agentAddress = wallet.agentPublicKey;

      // Get bot position for realized PnL and trade count
      const [position, tradeCount] = await Promise.all([
        storage.getBotPosition(botId, bot.market),
        storage.getBotTradeCount(botId),
      ]);

      // Check if subaccount exists on-chain using agent wallet (not user wallet)
      const exists = await subaccountExists(agentAddress, bot.driftSubaccountId);
      const balance = exists ? await getDriftBalance(agentAddress, bot.driftSubaccountId) : 0;
      
      // Calculate realized PnL and fees from position tracking
      const realizedPnl = parseFloat(position?.realizedPnl || "0");
      const totalFees = parseFloat(position?.totalFees || "0");
      
      // Interest calculation: Use the current Drift balance to estimate daily interest
      // Note: We don't have per-bot deposit tracking, so we can't calculate exact interest
      // Use dynamic APY from shared helper (fetches fresh if cache expired)
      const apyResult = await getUsdcApy();
      const currentApy = apyResult.apy / 100; // Convert percentage to decimal
      const dailyInterestRate = currentApy / 365;
      const estimatedDailyInterest = balance * dailyInterestRate;
      
      res.json({ 
        driftSubaccountId: bot.driftSubaccountId,
        subaccountExists: exists,
        usdcBalance: balance,
        realizedPnl,
        totalFees,
        tradeCount,
        estimatedDailyInterest: Math.max(0, estimatedDailyInterest),
        driftApy: currentApy,
        apyStale: apyResult.stale || false,
      });
    } catch (error) {
      console.error("Bot balance error:", error);
      res.status(500).json({ error: "Failed to fetch balance" });
    }
  });

  // ==================== MARKETPLACE ROUTES ====================

  // Get marketplace listings
  app.get("/api/marketplace", async (req, res) => {
    try {
      const { search, market, sortBy, limit } = req.query;
      const bots = await storage.getPublishedBots({
        search: search as string,
        market: market as string,
        sortBy: sortBy as string,
        limit: limit ? parseInt(limit as string) : undefined,
      });
      res.json(bots);
    } catch (error) {
      console.error("Get marketplace error:", error);
      res.status(500).json({ error: "Failed to fetch marketplace" });
    }
  });

  // Get user's own published bots (must be before :id route)
  app.get("/api/marketplace/my-published", requireWallet, async (req, res) => {
    try {
      const bots = await storage.getPublishedBotsByCreator(req.walletAddress!);
      res.json(bots);
    } catch (error) {
      console.error("Get my published bots error:", error);
      res.status(500).json({ error: "Failed to fetch published bots" });
    }
  });

  // Get single published bot details
  app.get("/api/marketplace/:id", async (req, res) => {
    try {
      const bot = await storage.getPublishedBotById(req.params.id);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      res.json(bot);
    } catch (error) {
      console.error("Get published bot error:", error);
      res.status(500).json({ error: "Failed to fetch bot" });
    }
  });

  // Get public performance data for a published bot (trade-based chart like bot management drawer)
  app.get("/api/marketplace/:id/performance", async (req, res) => {
    try {
      const publishedBot = await storage.getPublishedBotById(req.params.id);
      if (!publishedBot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      
      // Get performance series from trades (same as bot management drawer)
      const publishedAt = new Date(publishedBot.publishedAt);
      const tradeSeries = await storage.getBotPerformanceSeries(publishedBot.tradingBotId, publishedAt);
      
      // Get the creator's net deposited amount for percentage calculations
      const tradingBot = await storage.getTradingBotById(publishedBot.tradingBotId);
      let netDeposited = 0;
      if (tradingBot) {
        const equityEvents = await storage.getBotEquityEvents(publishedBot.tradingBotId, 1000);
        netDeposited = equityEvents.reduce((sum, e) => {
          const amount = parseFloat(e.amount || '0');
          const isDeposit = e.eventType === 'deposit' || e.eventType === 'drift_deposit';
          return isDeposit ? sum + amount : sum - amount;
        }, 0);
      }
      
      // Build chart data showing performance since publish (starts at 0%)
      const performanceData: { date: Date; pnl: number; pnlDollar: number }[] = [];
      
      // Add initial 0 point at publish date
      performanceData.push({
        date: publishedAt,
        pnl: 0,
        pnlDollar: 0,
      });
      
      // Add trade points with cumulative PnL as percentage of net deposited
      tradeSeries.forEach(trade => {
        const pnlPercent = netDeposited > 0 
          ? (trade.cumulativePnl / netDeposited) * 100 
          : 0;
        performanceData.push({
          date: trade.timestamp,
          pnl: parseFloat(pnlPercent.toFixed(4)),
          pnlDollar: trade.cumulativePnl,
        });
      });
      
      res.json({
        botId: publishedBot.id,
        market: publishedBot.market,
        totalTrades: publishedBot.totalTrades,
        winningTrades: publishedBot.winningTrades,
        winRate: publishedBot.totalTrades > 0 
          ? ((publishedBot.winningTrades / publishedBot.totalTrades) * 100).toFixed(1)
          : '0',
        pnlPercent7d: publishedBot.pnlPercent7d,
        pnlPercent30d: publishedBot.pnlPercent30d,
        pnlPercent90d: publishedBot.pnlPercent90d,
        pnlPercentAllTime: publishedBot.pnlPercentAllTime,
        profitSharePercent: publishedBot.profitSharePercent,
        subscriberCount: publishedBot.subscriberCount,
        creatorCapital: publishedBot.creatorCapital,
        totalCapitalInvested: publishedBot.totalCapitalInvested,
        equityHistory: performanceData,
      });
    } catch (error) {
      console.error("Get bot performance error:", error);
      res.status(500).json({ error: "Failed to fetch performance data" });
    }
  });

  // Publish a bot to marketplace
  app.post("/api/trading-bots/:id/publish", requireWallet, async (req, res) => {
    try {
      const { id } = req.params;
      const { name, description, profitSharePercent } = req.body;

      const tradingBot = await storage.getTradingBotById(id);
      if (!tradingBot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      if (tradingBot.walletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Not your bot" });
      }

      // Check if already published
      const existing = await storage.getPublishedBotByTradingBotId(id);
      if (existing) {
        return res.status(400).json({ error: "Bot is already published" });
      }

      // Must be a signal bot (not grid)
      if (tradingBot.botType !== 'signal') {
        return res.status(400).json({ error: "Only signal bots can be published to the marketplace" });
      }

      // Validate profit share percentage (0-10%)
      const rawProfitShare = Number(profitSharePercent);
      const validProfitShare = isNaN(rawProfitShare) ? 0 : Math.min(10, Math.max(0, rawProfitShare));

      // Create published bot entry
      const publishedBot = await storage.createPublishedBot({
        tradingBotId: id,
        creatorWalletAddress: req.walletAddress!,
        name: name || tradingBot.name,
        description: description || null,
        market: tradingBot.market,
        isActive: true,
        isFeatured: false,
        profitSharePercent: validProfitShare.toString(),
      });

      // Sync initial stats from trading bot to published bot
      const stats = tradingBot.stats as any || {};
      const totalTrades = stats.totalTrades || 0;
      const winningTrades = stats.winningTrades || 0;
      
      // Get creator's current equity from Drift
      let creatorEquity = 0;
      try {
        const wallet = await storage.getWallet(req.walletAddress!);
        if (wallet?.agentPublicKey && tradingBot.driftSubaccountId) {
          const accountInfo = await getDriftAccountInfo(
            wallet.agentPublicKey,
            tradingBot.driftSubaccountId
          );
          creatorEquity = accountInfo.usdcBalance || 0;
        }
      } catch (equityError) {
        console.error(`[Marketplace] Failed to get creator equity:`, equityError);
      }
      
      // Update published bot stats including creator capital
      await storage.updatePublishedBotStats(publishedBot.id, {
        totalTrades,
        winningTrades,
        creatorCapital: String(creatorEquity),
      });
      
      // Also update totalCapitalInvested to include creator's capital
      if (creatorEquity > 0) {
        await storage.incrementPublishedBotSubscribers(publishedBot.id, 0, creatorEquity);
      }
      
      // Create initial marketplace equity snapshot
      if (creatorEquity > 0) {
        await storage.createMarketplaceEquitySnapshot({
          publishedBotId: publishedBot.id,
          snapshotDate: new Date(),
          equity: String(creatorEquity),
          pnlPercent: "0",
        });
      }
      
      console.log(`[Marketplace] Bot ${id} published with stats: ${totalTrades} trades, ${winningTrades} wins, creator capital: $${creatorEquity.toFixed(2)}`);
      res.json(publishedBot);
    } catch (error) {
      console.error("Publish bot error:", error);
      res.status(500).json({ error: "Failed to publish bot" });
    }
  });

  // Unpublish a bot from marketplace
  app.delete("/api/marketplace/:id", requireWallet, async (req, res) => {
    try {
      const publishedBot = await storage.getPublishedBotById(req.params.id);
      if (!publishedBot) {
        return res.status(404).json({ error: "Published bot not found" });
      }
      if (publishedBot.creatorWalletAddress !== req.walletAddress) {
        return res.status(403).json({ error: "Not your bot" });
      }

      // Mark as inactive instead of deleting (preserves subscriber data)
      await storage.updatePublishedBot(req.params.id, { isActive: false });
      
      console.log(`[Marketplace] Bot ${req.params.id} unpublished by ${req.walletAddress}`);
      res.json({ success: true });
    } catch (error) {
      console.error("Unpublish bot error:", error);
      res.status(500).json({ error: "Failed to unpublish bot" });
    }
  });

  // Subscribe to a published bot (creates a new trading bot that mirrors signals)
  app.post("/api/marketplace/:id/subscribe", requireWallet, async (req, res) => {
    try {
      const { capitalInvested, leverage } = req.body;
      
      if (!capitalInvested || capitalInvested <= 0) {
        return res.status(400).json({ error: "Capital investment amount required" });
      }

      const publishedBot = await storage.getPublishedBotById(req.params.id);
      if (!publishedBot) {
        return res.status(404).json({ error: "Published bot not found" });
      }
      if (!publishedBot.isActive) {
        return res.status(400).json({ error: "This bot is no longer available" });
      }

      // Check if already subscribed
      const existingSub = await storage.getBotSubscription(req.params.id, req.walletAddress!);
      if (existingSub && existingSub.status === 'active') {
        return res.status(400).json({ error: "Already subscribed to this bot" });
      }

      // Get the original trading bot to clone settings
      const originalBot = await storage.getTradingBotById(publishedBot.tradingBotId);
      if (!originalBot) {
        return res.status(404).json({ error: "Original bot not found" });
      }
      
      // Get wallet to check for agent wallet and available balance
      const wallet = await storage.getWallet(req.walletAddress!);
      if (!wallet?.agentPublicKey || !wallet?.agentPrivateKeyEncrypted) {
        return res.status(400).json({ error: "Agent wallet not set up. Please set up your agent wallet first." });
      }
      
      // Check available balance in main Drift account (subaccount 0)
      const mainAccountBalance = await getDriftBalance(wallet.agentPublicKey, 0);
      if (mainAccountBalance < capitalInvested) {
        return res.status(400).json({ 
          error: `Insufficient balance. You have $${mainAccountBalance.toFixed(2)} available but need $${capitalInvested.toFixed(2)}. Please deposit more USDC to your main Drift account first.` 
        });
      }

      // Create subscriber's bot with same settings but their own capital
      const webhookSecret = generateWebhookSecret();
      let subscriberBot = await storage.createTradingBot({
        name: `${publishedBot.name} (Copy)`,
        market: originalBot.market,
        walletAddress: req.walletAddress!,
        botType: 'signal',
        maxPositionSize: capitalInvested.toString(),
        leverage: leverage || originalBot.leverage,
        webhookSecret,
        isActive: true,
        sourcePublishedBotId: publishedBot.id,
      });

      // Assign subaccount ID (done separately since it's auto-managed)
      const nextSubaccountId = await storage.getNextSubaccountId(req.walletAddress!);
      subscriberBot = (await storage.updateTradingBot(subscriberBot.id, { 
        driftSubaccountId: nextSubaccountId 
      } as any))!;
      
      // Transfer USDC from main account (subaccount 0) to the new bot's subaccount
      console.log(`[Marketplace] Transferring $${capitalInvested} from main account to subaccount ${nextSubaccountId} for subscriber bot`);
      const transferResult = await executeAgentTransferBetweenSubaccounts(
        wallet.agentPublicKey,
        wallet.agentPrivateKeyEncrypted,
        0, // from main account
        nextSubaccountId,
        capitalInvested
      );
      
      if (!transferResult.success) {
        // Rollback: delete the created bot
        console.error(`[Marketplace] Transfer failed, rolling back bot creation: ${transferResult.error}`);
        await storage.deleteTradingBot(subscriberBot.id);
        return res.status(500).json({ 
          error: `Failed to fund bot: ${transferResult.error}. Bot creation rolled back.` 
        });
      }
      
      console.log(`[Marketplace] Transfer successful: ${transferResult.signature}`);
      
      // Record the deposit as an equity event
      await storage.createEquityEvent({
        walletAddress: req.walletAddress!,
        tradingBotId: subscriberBot.id,
        eventType: 'deposit',
        amount: String(capitalInvested),
        txSignature: transferResult.signature || null,
        notes: `Initial deposit for subscription to ${publishedBot.name}`,
      });

      // Create subscription record
      const subscription = await storage.createBotSubscription({
        publishedBotId: req.params.id,
        subscriberWalletAddress: req.walletAddress!,
        subscriberBotId: subscriberBot.id,
        capitalInvested: capitalInvested.toString(),
        status: 'active',
      });

      // Update published bot stats
      await storage.incrementPublishedBotSubscribers(req.params.id, 1, capitalInvested);

      console.log(`[Marketplace] ${req.walletAddress} subscribed to ${publishedBot.name} with $${capitalInvested}`);
      res.json({
        subscription,
        tradingBot: subscriberBot,
        webhookUrl: generateWebhookUrl(subscriberBot.id, webhookSecret),
        depositTxSignature: transferResult.signature,
      });
    } catch (error) {
      console.error("Subscribe error:", error);
      res.status(500).json({ error: "Failed to subscribe" });
    }
  });

  // Unsubscribe from a published bot
  app.delete("/api/marketplace/:id/unsubscribe", requireWallet, async (req, res) => {
    try {
      const subscription = await storage.getBotSubscription(req.params.id, req.walletAddress!);
      if (!subscription) {
        return res.status(404).json({ error: "Subscription not found" });
      }
      if (subscription.status !== 'active') {
        return res.status(400).json({ error: "Subscription is not active" });
      }

      // Cancel subscription
      await storage.cancelBotSubscription(subscription.id);

      // Update published bot stats
      const capitalInvested = parseFloat(subscription.capitalInvested);
      await storage.incrementPublishedBotSubscribers(req.params.id, -1, -capitalInvested);

      console.log(`[Marketplace] ${req.walletAddress} unsubscribed from ${req.params.id}`);
      res.json({ success: true });
    } catch (error) {
      console.error("Unsubscribe error:", error);
      res.status(500).json({ error: "Failed to unsubscribe" });
    }
  });

  // Get user's subscriptions
  app.get("/api/my-subscriptions", requireWallet, async (req, res) => {
    try {
      const subscriptions = await storage.getBotSubscriptionsByWallet(req.walletAddress!);
      res.json(subscriptions);
    } catch (error) {
      console.error("Get subscriptions error:", error);
      res.status(500).json({ error: "Failed to fetch subscriptions" });
    }
  });

  // Check if a trading bot is published
  app.get("/api/trading-bots/:id/published", requireWallet, async (req, res) => {
    try {
      const publishedBot = await storage.getPublishedBotByTradingBotId(req.params.id);
      res.json({ 
        isPublished: !!publishedBot && publishedBot.isActive,
        publishedBot: publishedBot || null,
      });
    } catch (error) {
      console.error("Check published error:", error);
      res.status(500).json({ error: "Failed to check published status" });
    }
  });

  // ==================== TELEGRAM INTEGRATION ====================

  // Generate a connection token and return deep link for Telegram
  app.post("/api/telegram/connect", requireWallet, async (req, res) => {
    try {
      const walletAddress = req.walletAddress!;
      
      // Generate a random 32-character token
      const token = crypto.randomBytes(16).toString('hex');
      
      // Set expiry to 15 minutes from now
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
      
      // Delete any existing tokens for this wallet
      await storage.deleteExpiredTelegramTokens();
      
      // Create new token
      await storage.createTelegramConnectionToken({
        walletAddress,
        token,
        expiresAt,
      });
      
      // Get bot username from environment (fallback to a default)
      const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'QuantumVaultBot';
      
      // Generate deep link
      const deepLink = `https://t.me/${botUsername}?start=${token}`;
      
      console.log(`[Telegram] Generated connection token for ${walletAddress}, expires at ${expiresAt.toISOString()}`);
      
      res.json({
        success: true,
        deepLink,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (error) {
      console.error("[Telegram] Connect error:", error);
      res.status(500).json({ error: "Failed to generate Telegram connection link" });
    }
  });

  // Webhook endpoint for Telegram bot updates
  app.post("/api/telegram/webhook", async (req, res) => {
    try {
      const update = req.body;
      
      // Handle /start command with token
      if (update.message?.text?.startsWith('/start')) {
        const chatId = update.message.chat.id.toString();
        const text = update.message.text;
        const parts = text.split(' ');
        
        if (parts.length >= 2) {
          const token = parts[1];
          
          console.log(`[Telegram] Received /start with token ${token.substring(0, 8)}... from chat ${chatId}`);
          
          // Look up the token
          const connectionToken = await storage.getTelegramConnectionTokenByToken(token);
          
          if (!connectionToken) {
            console.log(`[Telegram] Token not found: ${token.substring(0, 8)}...`);
            await sendTelegramResponse(chatId, "❌ Invalid or expired connection link. Please generate a new one from QuantumVault.");
            return res.json({ ok: true });
          }
          
          // Check if token is expired
          if (new Date() > connectionToken.expiresAt) {
            console.log(`[Telegram] Token expired for wallet ${connectionToken.walletAddress}`);
            await storage.deleteTelegramConnectionToken(connectionToken.id);
            await sendTelegramResponse(chatId, "❌ This connection link has expired. Please generate a new one from QuantumVault.");
            return res.json({ ok: true });
          }
          
          // Link the Telegram chat to the wallet
          await storage.updateWallet(connectionToken.walletAddress, {
            telegramConnected: true,
            telegramChatId: chatId,
            notificationsEnabled: true,
          });
          
          // Delete the used token
          await storage.deleteTelegramConnectionToken(connectionToken.id);
          
          console.log(`[Telegram] Successfully linked chat ${chatId} to wallet ${connectionToken.walletAddress}`);
          
          await sendTelegramResponse(chatId, 
            "✅ <b>Successfully connected to QuantumVault!</b>\n\n" +
            "You will now receive trading notifications:\n" +
            "• Trade executions\n" +
            "• Failed trades\n" +
            "• Position closures\n\n" +
            "To disconnect, use the settings in QuantumVault."
          );
        } else {
          // /start without token
          await sendTelegramResponse(chatId,
            "👋 <b>Welcome to QuantumVault Bot!</b>\n\n" +
            "To connect your wallet, please use the connection link from the QuantumVault settings page."
          );
        }
      }
      
      res.json({ ok: true });
    } catch (error) {
      console.error("[Telegram] Webhook error:", error);
      res.json({ ok: true }); // Always return ok to Telegram
    }
  });

  // Get retry queue status (for monitoring rate-limited trade retries)
  app.get("/api/retry-queue/status", requireWallet, async (req, res) => {
    try {
      const status = getQueueStatus();
      res.json(status);
    } catch (error) {
      console.error("[RetryQueue] Status check error:", error);
      res.status(500).json({ error: "Failed to check retry queue status" });
    }
  });

  // Check Telegram connection status
  app.get("/api/telegram/status", requireWallet, async (req, res) => {
    try {
      const wallet = await storage.getWallet(req.walletAddress!);
      
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      
      res.json({
        connected: wallet.telegramConnected || false,
        hasChatId: !!wallet.telegramChatId,
        notificationsEnabled: wallet.notificationsEnabled || false,
      });
    } catch (error) {
      console.error("[Telegram] Status check error:", error);
      res.status(500).json({ error: "Failed to check Telegram status" });
    }
  });

  // Retry a failed trade
  app.post("/api/trades/:tradeId/retry", requireWallet, async (req, res) => {
    try {
      const { tradeId } = req.params;
      const walletAddress = req.walletAddress!;
      
      // Get the failed trade
      const trade = await storage.getBotTrade(tradeId);
      
      if (!trade) {
        return res.status(404).json({ error: "Trade not found" });
      }
      
      if (trade.walletAddress !== walletAddress) {
        return res.status(403).json({ error: "Unauthorized" });
      }
      
      if (trade.status !== 'failed') {
        return res.status(400).json({ error: "Only failed trades can be retried" });
      }
      
      // Get the bot and wallet
      const bots = await storage.getTradingBots(walletAddress);
      const bot = bots.find(b => b.id === trade.tradingBotId);
      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }
      
      // Additional validations
      if (!bot.isActive) {
        return res.status(400).json({ error: "Cannot retry - bot is paused" });
      }
      
      // Check trade is not too old (24 hours max)
      const tradeAge = Date.now() - new Date(trade.executedAt).getTime();
      const MAX_RETRY_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
      if (tradeAge > MAX_RETRY_AGE_MS) {
        return res.status(400).json({ error: "Cannot retry trades older than 24 hours" });
      }
      
      // Verify trade market matches bot's configured market
      if (trade.market && bot.market && trade.market !== bot.market) {
        return res.status(400).json({ error: "Trade market doesn't match bot configuration" });
      }
      
      const wallet = await storage.getWallet(walletAddress);
      if (!wallet || !wallet.agentPrivateKeyEncrypted) {
        return res.status(400).json({ error: "Agent wallet not initialized" });
      }
      
      // Check execution authorization
      if (!wallet.executionEnabled || wallet.emergencyStopTriggered) {
        return res.status(403).json({ error: "Execution not authorized. Please enable execution first." });
      }
      
      // Determine the side from the original trade
      const side = trade.side?.toUpperCase();
      if (!side || side === 'CLOSE') {
        return res.status(400).json({ error: "Cannot retry close orders - position may have changed" });
      }
      
      const isLong = side === 'LONG';
      const market = trade.market;
      const size = parseFloat(trade.size?.toString() || '0');
      
      if (size <= 0) {
        return res.status(400).json({ error: "Invalid trade size" });
      }
      
      console.log(`[Retry Trade] Retrying ${side} ${market} x${size} for bot ${bot.name}`);
      
      // Check if auto top-up is needed before retrying
      const subAccountId = bot.driftSubaccountId ?? 0;
      const baseCapital = parseFloat(bot.maxPositionSize?.toString() || '0');
      const effectiveLeverage = Math.min(Number(bot.leverage) || 10, getMarketMaxLeverage(market) || 10);
      
      if (bot.autoTopUp && baseCapital > 0) {
        try {
          const accountInfo = await getDriftAccountInfo(wallet.agentPublicKey!, subAccountId);
          let freeCollateral = Math.max(0, accountInfo.freeCollateral);
          const maxTradeableValue = freeCollateral * effectiveLeverage * 0.90;
          
          // Check if we need top-up to reach full investment amount
          if (baseCapital > maxTradeableValue && maxTradeableValue > 0) {
            const requiredCollateral = (baseCapital / effectiveLeverage) * 1.15;
            const topUpNeeded = Math.max(0, requiredCollateral - freeCollateral);
            
            console.log(`[Retry Trade] Auto top-up check: need $${requiredCollateral.toFixed(2)}, have $${freeCollateral.toFixed(2)}, shortfall: $${topUpNeeded.toFixed(2)}`);
            
            if (topUpNeeded > 0) {
              const agentUsdcBalance = await getAgentUsdcBalance(wallet.agentPublicKey!);
              console.log(`[Retry Trade] Agent wallet: $${agentUsdcBalance.toFixed(2)}, need: $${topUpNeeded.toFixed(2)}`);
              
              if (agentUsdcBalance >= topUpNeeded) {
                const depositAmount = Math.ceil(topUpNeeded * 100) / 100;
                const depositResult = await executeAgentDriftDeposit(
                  wallet.agentPublicKey!,
                  wallet.agentPrivateKeyEncrypted,
                  depositAmount,
                  subAccountId,
                  false
                );
                
                if (depositResult.success) {
                  console.log(`[Retry Trade] Auto top-up successful: deposited $${depositAmount.toFixed(2)}, tx: ${depositResult.signature}`);
                  
                  await storage.createEquityEvent({
                    walletAddress,
                    tradingBotId: bot.id,
                    eventType: 'auto_topup',
                    amount: String(depositAmount),
                    txSignature: depositResult.signature || null,
                    notes: `Auto top-up for retry: deposited $${depositAmount.toFixed(2)}`,
                  });
                } else {
                  console.log(`[Retry Trade] Auto top-up failed: ${depositResult.error}`);
                }
              } else {
                console.log(`[Retry Trade] Agent wallet insufficient for top-up`);
              }
            }
          }
        } catch (topUpErr: any) {
          console.log(`[Retry Trade] Auto top-up check error: ${topUpErr.message}`);
        }
      }
      
      // Get private key
      const { getAgentKeypair } = await import('./agent-wallet');
      const agentKeypair = getAgentKeypair(wallet.agentPrivateKeyEncrypted);
      const bs58 = await import('bs58');
      const privateKeyBase58 = bs58.default.encode(agentKeypair.secretKey);
      
      // Execute the trade
      const result = await executePerpOrder(
        wallet.agentPrivateKeyEncrypted,
        market,
        isLong ? 'long' : 'short',
        size,
        bot.driftSubaccountId ?? 0,
        false, // not reduce only
        wallet.slippageBps ?? 50,
        privateKeyBase58,
        wallet.agentPublicKey ?? undefined
      );
      
      if (result.success) {
        // Get fill price for trade record
        const fillPrice = result.fillPrice || 0;
        
        // Estimate fee (0.05% taker fee)
        const notionalValue = size * fillPrice;
        const estimatedFee = notionalValue * DRIFT_FEE_RATE;
        
        // Create a new trade record for the retry
        const newTrade = await storage.createBotTrade({
          tradingBotId: bot.id,
          walletAddress,
          market,
          side,
          size: size.toString(),
          price: fillPrice.toString(),
          fee: estimatedFee.toString(),
          status: 'executed',
          txSignature: result.signature || result.txSignature,
          webhookPayload: { retryOf: tradeId },
        });
        
        console.log(`[Retry Trade] Success! New trade ID: ${newTrade.id}, tx: ${result.signature || result.txSignature}`);
        
        // CRITICAL: Sync position from on-chain to update entry price in database
        // This ensures PnL calculations use the actual on-chain entry price, not stale data
        try {
          await syncPositionFromOnChain(
            bot.id,
            walletAddress,
            wallet.agentPublicKey!,
            bot.driftSubaccountId ?? 0,
            market,
            newTrade.id,
            estimatedFee,
            fillPrice,
            side.toLowerCase() as 'long' | 'short',
            size
          );
          console.log(`[Retry Trade] Position synced from on-chain with correct entry price`);
        } catch (syncErr) {
          console.warn(`[Retry Trade] Position sync failed (non-critical):`, syncErr);
        }
        
        res.json({
          success: true,
          message: "Trade executed successfully",
          tradeId: newTrade.id,
          txSignature: result.signature || result.txSignature,
          fillPrice,
        });
      } else {
        console.error(`[Retry Trade] Failed:`, result.error);
        res.status(500).json({
          success: false,
          error: result.error || "Trade execution failed",
        });
      }
    } catch (error) {
      console.error("[Retry Trade] Error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to retry trade" });
    }
  });

  // Disconnect Telegram
  app.post("/api/telegram/disconnect", requireWallet, async (req, res) => {
    try {
      const walletAddress = req.walletAddress!;
      
      await storage.updateWallet(walletAddress, {
        telegramConnected: false,
        telegramChatId: null,
        notificationsEnabled: false,
      });
      
      console.log(`[Telegram] Disconnected for wallet ${walletAddress}`);
      
      res.json({ success: true });
    } catch (error) {
      console.error("[Telegram] Disconnect error:", error);
      res.status(500).json({ error: "Failed to disconnect Telegram" });
    }
  });

  // Debug endpoint to close positions by subaccount directly (for dust cleanup)
  // This is useful when a bot is deleted but positions remain on-chain
  app.post("/api/debug/close-subaccount-position", requireWallet, async (req, res) => {
    console.log(`[Debug] *** CLOSE SUBACCOUNT POSITION REQUEST ***`);
    try {
      const { subAccountId, market } = req.body;
      
      if (typeof subAccountId !== 'number' || !market) {
        return res.status(400).json({ error: "Missing required fields: subAccountId (number), market (string)" });
      }
      
      if (!req.walletAddress) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      
      const wallet = await storage.getWallet(req.walletAddress);
      if (!wallet?.agentPrivateKeyEncrypted || !wallet?.agentPublicKey) {
        return res.status(400).json({ error: "Agent wallet not configured" });
      }
      
      console.log(`[Debug] Closing position on ${market} in subaccount ${subAccountId} for wallet ${wallet.agentPublicKey}`);
      
      // Use closePerpPosition to close the position
      const { closePerpPosition } = await import("./drift-service.js");
      const slippageBps = wallet.slippageBps ?? 100; // Higher slippage for dust
      
      const result = await closePerpPosition(
        wallet.agentPrivateKeyEncrypted,
        market,
        subAccountId,
        undefined, // Let SDK determine position size from on-chain
        slippageBps
      );
      
      console.log(`[Debug] Close result:`, result);
      
      if (result.success) {
        res.json({
          success: true,
          message: result.signature ? `Position closed successfully` : "Position was already closed",
          signature: result.signature || null,
          subAccountId,
          market
        });
      } else {
        res.status(500).json({
          success: false,
          error: result.error || "Failed to close position",
          subAccountId,
          market
        });
      }
    } catch (error) {
      console.error("[Debug] Close subaccount position error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
    }
  });

  return httpServer;
}

// Helper function to send Telegram messages (for webhook responses)
async function sendTelegramResponse(chatId: string, text: string): Promise<boolean> {
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  
  if (!TELEGRAM_BOT_TOKEN) {
    console.log('[Telegram] Bot token not configured');
    return false;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error(`[Telegram] API error ${response.status}:`, errorData);
      return false;
    }

    return true;
  } catch (error) {
    console.error('[Telegram] Error sending message:', error);
    return false;
  }
}
