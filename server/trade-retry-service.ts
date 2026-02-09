import { sendTradeNotification } from "./notification-service";
import { executePerpOrder, closePerpPosition, getPerpPositions, settleAllPnl, executeAgentDriftWithdraw } from "./drift-service";
import { syncPositionFromOnChain } from "./reconciliation-service";
import { storage } from "./storage";
import { getMarketBySymbol } from "./market-liquidity-service";
import { transferUsdcToWallet } from "./agent-wallet";
import { PublicKey } from "@solana/web3.js";
import { isSwiftAvailable, classifySwiftError } from './swift-config';

export interface RetryJob {
  id: string;
  botId: string;
  walletAddress: string;
  agentPrivateKeyEncrypted: string;
  agentPublicKey: string;
  market: string;
  side: 'long' | 'short' | 'close';
  size: number;
  subAccountId: number;
  reduceOnly: boolean;
  slippageBps: number;
  privateKeyBase58?: string;
  priority: 'critical' | 'normal';
  attempts: number;
  maxAttempts: number;
  nextRetryAt: number;
  createdAt: number;
  lastError?: string;
  originalTradeId?: string;
  webhookPayload?: unknown;
  entryPrice?: number; // For close orders: entry price to calculate PnL for profit sharing
  cooldownRetries?: number; // Number of delayed re-queue attempts after exhausting normal retries
  swiftAttempts?: number;        // Swift-specific retry count
  originalExecMethod?: string;   // What method was tried first ('swift' | 'legacy')
}

const retryQueue: Map<string, RetryJob> = new Map();
let workerInterval: NodeJS.Timeout | null = null;

// Callback for routing signals to subscribers after successful retry
// This allows routes.ts to register the routing function without circular dependencies
type RoutingCallback = (
  botId: string,
  signal: {
    action: 'buy' | 'sell';
    contracts: string;
    positionSize: string;
    price: string;
    isCloseSignal: boolean;
    strategyPositionSize: string | null;
  }
) => Promise<void>;

let routingCallback: RoutingCallback | null = null;

export function registerRoutingCallback(callback: RoutingCallback): void {
  routingCallback = callback;
  console.log('[TradeRetry] Routing callback registered');
}

const BACKOFF_BASE_MS = 5000;
const BACKOFF_MAX_MS = 60000;
const MAX_ATTEMPTS_NORMAL = 5;
const MAX_ATTEMPTS_CRITICAL = 10;
const COOLDOWN_DELAY_MS = 2 * 60 * 1000; // 2 minutes cooldown before re-queue
const MAX_COOLDOWN_RETRIES = 2; // Max times to re-queue after exhausting normal retries

export function isRateLimitError(error: string | Error | unknown): boolean {
  const errorStr = error instanceof Error ? error.message : String(error);
  const lowerError = errorStr.toLowerCase();
  return (
    lowerError.includes('-32429') ||
    lowerError.includes('rate limit') ||
    lowerError.includes('429') ||
    lowerError.includes('too many requests') ||
    lowerError.includes('timeout') ||
    lowerError.includes('timed out') ||
    lowerError.includes('please wait') ||
    lowerError.includes('credit')
  );
}

// Transient errors that should be retried (price feed issues, oracle staleness, RPC issues)
export function isTransientError(error: string | Error | unknown): boolean {
  const errorStr = error instanceof Error ? error.message : String(error);
  const lowerError = errorStr.toLowerCase();
  return (
    // Price feed / Oracle issues (temporary, usually resolve in seconds)
    lowerError.includes('oraclenotfound') ||
    lowerError.includes('oracle not found') ||
    lowerError.includes('stale') ||
    lowerError.includes('price feed') ||
    lowerError.includes('invalid oracle') ||
    lowerError.includes('invalidoracle') ||
    // RPC connection issues (temporary, may resolve with retry or failover)
    lowerError.includes('connection terminated') ||
    lowerError.includes('terminated unexpectedly') ||
    lowerError.includes('econnrefused') ||
    lowerError.includes('econnreset') ||
    lowerError.includes('socket hang up') ||
    // Timeout errors (may succeed on retry)
    lowerError.includes('timeout_subprocess') ||
    lowerError.includes('timeout_trade') ||
    lowerError.includes('timeout_close') ||
    lowerError.includes('timed out') ||
    // Also check for rate limit errors
    isRateLimitError(error)
  );
}

// Check if error is specifically a timeout error (eligible for cooldown re-queue)
export function isTimeoutError(error: string | Error | unknown): boolean {
  const errorStr = error instanceof Error ? error.message : String(error);
  const lowerError = errorStr.toLowerCase();
  return (
    lowerError.includes('timeout') ||
    lowerError.includes('timed out') ||
    lowerError.includes('timeout_subprocess') ||
    lowerError.includes('timeout_trade') ||
    lowerError.includes('timeout_close')
  );
}

// Check if error is an insufficient margin/balance error
export function isInsufficientMarginError(error: string | Error | unknown): boolean {
  const errorStr = error instanceof Error ? error.message : String(error);
  const lowerError = errorStr.toLowerCase();
  return (
    lowerError.includes('insufficient margin') ||
    lowerError.includes('insufficient collateral') ||
    lowerError.includes('insufficient balance') ||
    lowerError.includes('not enough') ||
    lowerError.includes('below minimum')
  );
}

// Check if error is a Drift protocol error (usually non-retryable)
export function isDriftProtocolError(error: string | Error | unknown): boolean {
  const errorStr = error instanceof Error ? error.message : String(error);
  const lowerError = errorStr.toLowerCase();
  return (
    lowerError.includes('referrernotfound') ||
    lowerError.includes('usernotfound') ||
    lowerError.includes('marketnotfound') ||
    lowerError.includes('orderdoesnotexist') ||
    lowerError.includes('positiondoesnotexist')
  );
}

// Error category types for clear logging
export type ErrorCategory = 
  | 'TIMEOUT'      // Timeout errors - eligible for cooldown re-queue
  | 'RATE_LIMIT'   // Rate limit / 429 errors - eligible for retry
  | 'ORACLE'       // Oracle/price feed issues - transient, retryable
  | 'RPC'          // RPC connection issues - transient, retryable
  | 'MARGIN'       // Insufficient margin/balance - usually non-retryable
  | 'PROTOCOL'     // Drift protocol errors - usually non-retryable
  | 'UNKNOWN';     // Unknown errors

// Categorize an error for clear logging
// Priority: TIMEOUT > ORACLE > RPC > RATE_LIMIT > MARGIN > PROTOCOL > UNKNOWN
// Timeout is checked first because it's eligible for cooldown re-queue
export function categorizeError(error: string | Error | unknown): { category: ErrorCategory; emoji: string; retryable: boolean } {
  const errorStr = error instanceof Error ? error.message : String(error);
  const lowerError = errorStr.toLowerCase();
  
  // TIMEOUT: Check first - eligible for cooldown re-queue (highest priority)
  if (isTimeoutError(error)) {
    return { category: 'TIMEOUT', emoji: '⏱️', retryable: true };
  }
  
  // ORACLE: All oracle/price feed issues (aligns with isTransientError patterns)
  if (lowerError.includes('oraclenotfound') || 
      lowerError.includes('oracle not found') ||
      lowerError.includes('invalidoracle') ||
      lowerError.includes('invalid oracle') ||
      lowerError.includes('price feed') || 
      lowerError.includes('stale')) {
    return { category: 'ORACLE', emoji: '📡', retryable: true };
  }
  
  // RPC: All connection issues (aligns with isTransientError patterns)
  if (lowerError.includes('econnrefused') || 
      lowerError.includes('econnreset') || 
      lowerError.includes('socket hang up') || 
      lowerError.includes('connection terminated') ||
      lowerError.includes('terminated unexpectedly')) {
    return { category: 'RPC', emoji: '🔌', retryable: true };
  }
  
  // RATE_LIMIT: 429 errors and rate limiting (excluding timeout which is checked above)
  if (lowerError.includes('-32429') ||
      lowerError.includes('rate limit') ||
      lowerError.includes('429') ||
      lowerError.includes('too many requests') ||
      lowerError.includes('please wait') ||
      lowerError.includes('credit')) {
    return { category: 'RATE_LIMIT', emoji: '🚦', retryable: true };
  }
  
  // MARGIN: Insufficient funds (usually non-retryable without top-up)
  if (isInsufficientMarginError(error)) {
    return { category: 'MARGIN', emoji: '💰', retryable: false };
  }
  
  // PROTOCOL: Drift protocol errors (usually non-retryable)
  if (isDriftProtocolError(error)) {
    return { category: 'PROTOCOL', emoji: '⚠️', retryable: false };
  }
  
  return { category: 'UNKNOWN', emoji: '❓', retryable: false };
}

function generateJobId(): string {
  return `retry_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

function calculateBackoff(attempts: number, priority: 'critical' | 'normal'): number {
  const base = priority === 'critical' ? BACKOFF_BASE_MS / 2 : BACKOFF_BASE_MS;
  const backoff = Math.min(base * Math.pow(2, attempts), BACKOFF_MAX_MS);
  const jitter = Math.random() * 1000;
  return backoff + jitter;
}

export async function queueTradeRetry(job: Omit<RetryJob, 'id' | 'attempts' | 'maxAttempts' | 'nextRetryAt' | 'createdAt'>): Promise<string> {
  const maxAttempts = job.priority === 'critical' ? MAX_ATTEMPTS_CRITICAL : MAX_ATTEMPTS_NORMAL;
  const backoff = calculateBackoff(0, job.priority);
  const nextRetryAt = Date.now() + backoff;
  const createdAt = Date.now();
  
  // Persist to database FIRST to get the database-generated ID
  // This ensures in-memory and database IDs match for updates/restarts
  let dbJobId: string;
  try {
    const dbJob = await storage.createTradeRetryJob({
      originalTradeId: job.originalTradeId || '',
      botId: job.botId,
      walletAddress: job.walletAddress,
      market: job.market,
      side: job.side,
      size: job.size.toString(),
      leverage: 1,
      priority: job.priority,
      attempts: 0,
      maxAttempts,
      cooldownRetries: 0,
      nextRetryAt: new Date(nextRetryAt),
      status: 'pending',
      webhookPayload: job.webhookPayload || null,
      entryPrice: job.entryPrice?.toString() || null,
    });
    dbJobId = dbJob.id;
    console.log(`[TradeRetry] Persisted job ${dbJobId} to database`);
  } catch (dbErr) {
    // Fallback to generated ID if database fails (job won't survive restart)
    dbJobId = generateJobId();
    console.warn(`[TradeRetry] Failed to persist job to database, using fallback ID ${dbJobId}:`, dbErr);
  }
  
  const fullJob: RetryJob = {
    ...job,
    id: dbJobId,
    attempts: 0,
    maxAttempts,
    nextRetryAt,
    createdAt,
    swiftAttempts: 0,
    originalExecMethod: 'legacy',
  };
  
  retryQueue.set(dbJobId, fullJob);
  
  console.log(`[TradeRetry] Queued ${job.priority} ${job.side} ${job.market} retry, first attempt in ${Math.round(backoff / 1000)}s (job ${dbJobId})`);
  
  notifyRetryQueued(fullJob);
  
  return dbJobId;
}

async function notifyRetryQueued(job: RetryJob): Promise<void> {
  try {
    const wallet = await storage.getWallet(job.walletAddress);
    if (!wallet?.telegramChatId || !wallet.notificationsEnabled) return;
    
    const bot = await storage.getTradingBotById(job.botId);
    const botName = bot?.name || 'Unknown Bot';
    
    const priorityEmoji = job.priority === 'critical' ? '🚨' : '⏳';
    const sideLabel = job.side === 'close' ? 'CLOSE' : job.side.toUpperCase();
    const nextRetrySeconds = Math.round((job.nextRetryAt - Date.now()) / 1000);
    
    // Use error categorization for consistent messaging
    const errorInfo = job.lastError ? categorizeError(job.lastError) : { category: 'UNKNOWN', emoji: '❓' };
    const errorReason = job.lastError ? `[${errorInfo.category}]` : 'Transient error';
    
    await sendTradeNotification(job.walletAddress, {
      type: 'trade_failed',
      botName,
      market: job.market,
      side: sideLabel as 'LONG' | 'SHORT',
      size: job.size,
      error: `${errorReason} - auto-retry scheduled in ${nextRetrySeconds}s ${priorityEmoji}`,
    });
  } catch (err) {
    console.warn('[TradeRetry] Failed to send retry notification:', err);
  }
}

async function notifyRetryResult(job: RetryJob, success: boolean, error?: string): Promise<void> {
  try {
    const wallet = await storage.getWallet(job.walletAddress);
    if (!wallet?.telegramChatId || !wallet.notificationsEnabled) return;
    
    const bot = await storage.getTradingBotById(job.botId);
    const botName = bot?.name || 'Unknown Bot';
    const sideLabel = job.side === 'close' ? 'CLOSE' : job.side.toUpperCase();
    
    if (success) {
      await sendTradeNotification(job.walletAddress, {
        type: 'trade_executed',
        botName,
        market: job.market,
        side: sideLabel as 'LONG' | 'SHORT',
        size: job.size,
        price: 0,
      });
    } else {
      // Use error categorization for consistent messaging
      const errorInfo = error ? categorizeError(error) : { category: 'UNKNOWN', emoji: '❓' };
      const cooldownNote = (job.cooldownRetries || 0) > 0 ? ` (+${job.cooldownRetries} cooldowns)` : '';
      
      await sendTradeNotification(job.walletAddress, {
        type: 'trade_failed',
        botName,
        market: job.market,
        side: sideLabel as 'LONG' | 'SHORT',
        size: job.size,
        error: `❌ [${errorInfo.category}] Auto-retry exhausted after ${job.attempts} attempts${cooldownNote}: ${error || 'Unknown error'}`,
      });
    }
  } catch (err) {
    console.warn('[TradeRetry] Failed to send result notification:', err);
  }
}

async function processRetryJob(job: RetryJob): Promise<void> {
  job.attempts++;
  console.log(`[TradeRetry] Processing ${job.priority} job ${job.id}: ${job.side} ${job.market} (attempt ${job.attempts}/${job.maxAttempts})`);
  
  // CRITICAL: Persist attempts to database to prevent infinite retries across server restarts
  try {
    await storage.updateTradeRetryJob(job.id, { attempts: job.attempts });
  } catch (dbErr) {
    console.warn(`[TradeRetry] Failed to persist attempts count:`, dbErr);
  }
  
  try {
    let result: { success: boolean; signature?: string; error?: string; fillPrice?: number; actualFee?: number; executionMethod?: string; swiftOrderId?: string };
    let actualCloseSide: 'long' | 'short' = 'short';
    const swiftAvailable = isSwiftAvailable();
    const jobSwiftAttempts = job.swiftAttempts || 0;
    console.log(`[TradeRetry] Swift status: available=${swiftAvailable}, swiftAttempts=${jobSwiftAttempts}, originalMethod=${job.originalExecMethod || 'legacy'}`);
    
    if (job.side === 'close') {
      // CRITICAL: Check on-chain position before close retry to prevent duplicate closes
      try {
        const positions = await getPerpPositions(job.agentPublicKey, job.subAccountId);
        const normalizedMarket = job.market.toUpperCase().replace('-PERP', '').replace('PERP', '');
        const position = positions.find(p => {
          const posMarket = p.market.toUpperCase().replace('-PERP', '').replace('PERP', '');
          return posMarket === normalizedMarket;
        });
        
        if (!position || Math.abs(position.baseAssetAmount) < 0.0001) {
          console.log(`[TradeRetry] Position already closed for ${job.market}, skipping retry`);
          
          // Update original trade if exists
          if (job.originalTradeId) {
            await storage.updateBotTrade(job.originalTradeId, {
              status: 'executed',
              errorMessage: 'Position was already closed (retry skipped)',
            });
          }
          
          await notifyRetryResult(job, true);
          retryQueue.delete(job.id);
          return;
        }
        
        // Determine actual close side based on current position
        actualCloseSide = position.side === 'LONG' ? 'short' : 'long';
        console.log(`[TradeRetry] Position exists: ${position.side} ${Math.abs(position.baseAssetAmount).toFixed(6)}, proceeding with close`);
      } catch (posCheckErr) {
        console.warn(`[TradeRetry] Could not verify position, proceeding with close attempt:`, posCheckErr);
      }
      
      result = await closePerpPosition(
        job.agentPrivateKeyEncrypted,
        job.market,
        job.subAccountId,
        undefined,
        job.slippageBps
      );
    } else {
      // For OPEN trades (long/short): Check on-chain if position already exists
      // This prevents marking trades as "failed" when a previous timeout actually succeeded
      try {
        const positions = await getPerpPositions(job.agentPublicKey, job.subAccountId);
        const normalizedMarket = job.market.toUpperCase().replace('-PERP', '').replace('PERP', '');
        const position = positions.find(p => {
          const posMarket = p.market.toUpperCase().replace('-PERP', '').replace('PERP', '');
          return posMarket === normalizedMarket;
        });
        
        // Check if position exists and matches the intended direction
        if (position && Math.abs(position.baseAssetAmount) >= 0.0001) {
          const positionSide = position.side.toLowerCase();
          const intendedSide = job.side.toLowerCase();
          
          // If position exists in the same direction, trade was already executed
          if (positionSide === intendedSide) {
            console.log(`[TradeRetry] Position already exists: ${position.side} ${Math.abs(position.baseAssetAmount).toFixed(6)} ${job.market} - previous attempt likely succeeded`);
            
            // Update original trade to recovered since it actually succeeded
            if (job.originalTradeId) {
              await storage.updateBotTrade(job.originalTradeId, {
                status: 'recovered',
                errorMessage: null,
                recoveredFromError: 'Trade succeeded on-chain despite timeout (verified on retry)',
                retryAttempts: job.attempts,
              });
            }
            
            await notifyRetryResult(job, true);
            retryQueue.delete(job.id);
            try {
              await storage.markTradeRetryJobCompleted(job.id);
            } catch (dbErr) {
              console.warn(`[TradeRetry] Failed to mark job as completed in DB:`, dbErr);
            }
            return;
          }
        }
      } catch (posCheckErr) {
        console.warn(`[TradeRetry] Could not verify existing position, proceeding with trade attempt:`, posCheckErr);
      }
      
      result = await executePerpOrder(
        job.agentPrivateKeyEncrypted,
        job.market,
        job.side,
        job.size,
        job.subAccountId,
        job.reduceOnly,
        job.slippageBps,
        job.privateKeyBase58,
        job.agentPublicKey
      );
    }
    
    if (result.success) {
      const execMethod = result.executionMethod || 'legacy';
      if (job.attempts === 1 && !job.originalExecMethod) {
        job.originalExecMethod = execMethod;
      }
      if (execMethod === 'swift') {
        job.swiftAttempts = (job.swiftAttempts || 0) + 1;
      }
      console.log(`[TradeRetry] ✅ Job ${job.id} succeeded via ${execMethod} on attempt ${job.attempts}: ${result.signature}`);
      
      const wallet = await storage.getWallet(job.walletAddress);
      const bot = await storage.getTradingBotById(job.botId);
      
      if (bot && wallet) {
        const fillPrice = result.fillPrice || 0;
        const notional = job.size * fillPrice;
        const fee = result.actualFee || notional * 0.00045;
        
        // Update original trade if it exists, otherwise create new
        let tradeId: string;
        if (job.originalTradeId) {
          // Get the original trade to preserve the error message
          const originalTrade = await storage.getBotTrade(job.originalTradeId);
          const originalError = originalTrade?.errorMessage || 'Unknown error';
          
          // Mark as "recovered" instead of "executed" to show there was an issue that was fixed
          await storage.updateBotTrade(job.originalTradeId, {
            status: 'recovered',
            price: fillPrice.toString(),
            fee: fee.toString(),
            txSignature: result.signature || null,
            errorMessage: null,
            recoveredFromError: originalError,
            retryAttempts: job.attempts,
            executionMethod: result.executionMethod || 'legacy',
            swiftOrderId: result.swiftOrderId || null,
          });
          tradeId = job.originalTradeId;
          console.log(`[TradeRetry] Updated original trade ${tradeId} to RECOVERED via ${result.executionMethod || 'legacy'} (was: ${originalError.slice(0, 50)}...)`);
        } else {
          const newTrade = await storage.createBotTrade({
            tradingBotId: job.botId,
            walletAddress: job.walletAddress,
            market: job.market,
            side: job.side === 'close' ? 'CLOSE' : job.side.toUpperCase(),
            size: job.size.toString(),
            price: fillPrice.toString(),
            fee: fee.toString(),
            status: 'executed',
            txSignature: result.signature,
            webhookPayload: { autoRetry: true, attempts: job.attempts, originalJobId: job.id },
            executionMethod: result.executionMethod || 'legacy',
            swiftOrderId: result.swiftOrderId || null,
          });
          tradeId = newTrade.id;
          console.log(`[TradeRetry] Created new trade ${tradeId}`);
        }
        
        try {
          // Use correct side for close orders based on actual position
          const syncSide = job.side === 'close' ? actualCloseSide : job.side;
          await syncPositionFromOnChain(
            job.botId,
            job.walletAddress,
            job.agentPublicKey,
            job.subAccountId,
            job.market,
            tradeId,
            fee,
            fillPrice,
            syncSide,
            job.size
          );
        } catch (syncErr) {
          console.warn(`[TradeRetry] Position sync failed:`, syncErr);
        }
        
        // ROUTING: Route signal to subscribers after successful source bot trade
        // This is critical for the marketplace feature - subscribers need to copy the trade
        // Routes both OPEN (long/short) and CLOSE signals
        if (routingCallback && job.webhookPayload) {
          try {
            const payload = job.webhookPayload as { action?: string; contracts?: string | number; market?: string; positionSize?: string | number };
            const isCloseSignal = job.side === 'close';
            if (payload.action && (payload.contracts !== undefined || isCloseSignal)) {
              console.log(`[TradeRetry] Routing ${isCloseSignal ? 'CLOSE' : 'OPEN'} signal to subscribers for source bot ${job.botId}: ${payload.action}`);
              await routingCallback(job.botId, {
                action: payload.action as 'buy' | 'sell',
                contracts: isCloseSignal ? '0' : String(payload.contracts),
                positionSize: String(payload.positionSize ?? '100'),
                price: String(fillPrice),
                isCloseSignal,
                strategyPositionSize: null,
              });
              console.log(`[TradeRetry] Routing completed for bot ${job.botId}`);
            } else {
              console.log(`[TradeRetry] Skipping routing: incomplete webhook payload (action=${payload.action}, contracts=${payload.contracts})`);
            }
          } catch (routingErr: any) {
            console.error(`[TradeRetry] Routing to subscribers failed (non-blocking): ${routingErr.message}`);
          }
        } else if (!routingCallback) {
          console.warn(`[TradeRetry] Routing callback not registered - subscribers may not receive signal for bot ${job.botId}`);
        }
        
        // PROFIT SHARE: Distribute creator's share of realized profit for subscriber bots
        if (job.side === 'close' && job.entryPrice && job.entryPrice > 0 && fillPrice > 0) {
          try {
            // Calculate PnL based on position side
            const positionWasLong = actualCloseSide === 'short'; // If we closed with short, position was long
            let closePnl: number;
            if (positionWasLong) {
              closePnl = (fillPrice - job.entryPrice) * job.size - fee;
            } else {
              closePnl = (job.entryPrice - fillPrice) * job.size - fee;
            }
            
            console.log(`[TradeRetry] PnL calculated: entry=$${job.entryPrice.toFixed(2)}, exit=$${fillPrice.toFixed(2)}, size=${job.size}, fee=$${fee.toFixed(4)}, pnl=$${closePnl.toFixed(4)}`);
            
            if (closePnl > 0) {
              // Check if this is a subscriber bot
              const subscription = await storage.getBotSubscriptionBySubscriberBotId(job.botId);
              if (subscription) {
                const profitSharePercent = parseFloat(String(subscription.publishedBot.profitSharePercent ?? 0));
                if (profitSharePercent > 0) {
                  const profitShareAmount = (closePnl * profitSharePercent) / 100;
                  
                  if (profitShareAmount >= 0.01) {
                    const creatorWallet = subscription.publishedBot.creatorWalletAddress;
                    
                    // Validate creator wallet
                    try {
                      new PublicKey(creatorWallet);
                    } catch {
                      console.error(`[TradeRetry] Invalid creator wallet: ${creatorWallet}`);
                      throw new Error('Invalid creator wallet address');
                    }
                    
                    console.log(`[TradeRetry] Processing profit share: $${profitShareAmount.toFixed(4)} (${profitSharePercent}%) to ${creatorWallet}`);
                    
                    // Helper to create IOU on failure
                    const createIouOnFailure = async (errorMsg: string) => {
                      try {
                        await storage.createPendingProfitShare({
                          subscriberBotId: job.botId,
                          subscriberWalletAddress: job.walletAddress,
                          creatorWalletAddress: creatorWallet,
                          amount: profitShareAmount.toString(),
                          realizedPnl: closePnl.toString(),
                          profitSharePercent: profitSharePercent.toString(),
                          tradeId: tradeId || `retry-${job.id}`,
                          publishedBotId: subscription.publishedBot.id,
                          driftSubaccountId: job.subAccountId,
                        });
                        console.log(`[TradeRetry] IOU created for $${profitShareAmount.toFixed(4)} to ${creatorWallet}`);
                      } catch (iouErr: any) {
                        console.error(`[TradeRetry] Failed to create IOU: ${iouErr.message}`);
                      }
                    };
                    
                    // Step 1: Settle PnL
                    const settleResult = await settleAllPnl(job.agentPrivateKeyEncrypted, job.subAccountId);
                    if (!settleResult.success) {
                      console.error(`[TradeRetry] Settle PnL failed: ${settleResult.error}`);
                      await createIouOnFailure(`Settle PnL failed: ${settleResult.error}`);
                    } else {
                      // Step 2: Withdraw from Drift
                      const withdrawResult = await executeAgentDriftWithdraw(
                        job.agentPublicKey,
                        job.agentPrivateKeyEncrypted,
                        profitShareAmount,
                        job.subAccountId
                      );
                      
                      if (!withdrawResult.success) {
                        console.error(`[TradeRetry] Drift withdrawal failed: ${withdrawResult.error}`);
                        await createIouOnFailure(`Drift withdrawal failed: ${withdrawResult.error}`);
                      } else {
                        // Step 3: Transfer to creator
                        const transferResult = await transferUsdcToWallet(
                          job.agentPublicKey,
                          job.agentPrivateKeyEncrypted,
                          creatorWallet,
                          profitShareAmount
                        );
                        
                        if (transferResult.success) {
                          console.log(`[TradeRetry] Profit share SUCCESS: $${profitShareAmount.toFixed(4)} sent to ${creatorWallet}, tx: ${transferResult.signature}`);
                        } else {
                          console.error(`[TradeRetry] Transfer failed: ${transferResult.error}`);
                          await createIouOnFailure(`Transfer failed: ${transferResult.error}`);
                        }
                      }
                    }
                  } else {
                    console.log(`[TradeRetry] Profit share skipped: dust amount $${profitShareAmount.toFixed(4)}`);
                  }
                }
              }
            }
          } catch (profitShareErr: any) {
            console.error(`[TradeRetry] Profit share error (non-blocking): ${profitShareErr.message}`);
          }
        }
      }
      
      await notifyRetryResult(job, true);
      retryQueue.delete(job.id);
      // Remove from database
      try {
        await storage.deleteTradeRetryJob(job.id);
      } catch (dbErr) {
        console.warn(`[TradeRetry] Failed to delete completed job from DB:`, dbErr);
      }
      return;
    }
    
    job.lastError = result.error || 'Unknown error';
    const failedExecMethod = result.executionMethod || 'legacy';
    if (job.attempts === 1 && !job.originalExecMethod) {
      job.originalExecMethod = failedExecMethod;
    }
    if (failedExecMethod === 'swift') {
      job.swiftAttempts = (job.swiftAttempts || 0) + 1;
      const swiftClassification = classifySwiftError(job.lastError);
      console.log(`[TradeRetry] Swift attempt failed (swiftAttempts=${job.swiftAttempts}, classification=${swiftClassification}): ${job.lastError.slice(0, 100)}`);
    }
    const errorInfo = categorizeError(job.lastError);
    
    // Retry if transient error (rate limit, price feed, oracle issues) and attempts remaining
    if (isTransientError(job.lastError) && job.attempts < job.maxAttempts) {
      const backoff = calculateBackoff(job.attempts, job.priority);
      job.nextRetryAt = Date.now() + backoff;
      console.log(`[TradeRetry] ${errorInfo.emoji} [${errorInfo.category}] Job ${job.id} error (retryable=${errorInfo.retryable}), retry #${job.attempts + 1} in ${Math.round(backoff / 1000)}s: ${job.lastError.slice(0, 100)}`);
      return;
    }
    
    // DELAYED RE-QUEUE: If this is a timeout error and we haven't exhausted cooldown retries,
    // schedule a delayed re-queue after 2 minutes instead of marking as permanently failed
    const cooldownRetries = job.cooldownRetries || 0;
    if (isTimeoutError(job.lastError) && cooldownRetries < MAX_COOLDOWN_RETRIES) {
      job.cooldownRetries = cooldownRetries + 1;
      job.attempts = 0; // Reset attempts for fresh retry cycle
      job.nextRetryAt = Date.now() + COOLDOWN_DELAY_MS;
      console.log(`[TradeRetry] ${errorInfo.emoji} [${errorInfo.category}] Job ${job.id} - scheduling cooldown re-queue #${job.cooldownRetries}/${MAX_COOLDOWN_RETRIES} in 2min`);
      
      // Persist cooldown state to database (including cooldownRetries)
      try {
        await storage.updateTradeRetryJob(job.id, { 
          attempts: job.attempts,
          cooldownRetries: job.cooldownRetries,
          nextRetryAt: new Date(job.nextRetryAt),
          lastError: job.lastError,
        });
      } catch (dbErr) {
        console.warn(`[TradeRetry] Failed to persist cooldown state:`, dbErr);
      }
      return;
    }
    
    // Mark as permanently failed
    console.error(`[TradeRetry] ❌ [${errorInfo.category}] Job ${job.id} FAILED PERMANENTLY after ${job.attempts} attempts: ${job.lastError}`);
    
    // Update original trade to failed if exists
    if (job.originalTradeId) {
      await storage.updateBotTrade(job.originalTradeId, {
        status: 'failed',
        errorMessage: `Auto-retry exhausted after ${job.attempts} attempts (${cooldownRetries} cooldown retries): ${job.lastError}`,
      });
    }
    
    await notifyRetryResult(job, false, job.lastError);
    retryQueue.delete(job.id);
    // Mark as failed in database
    try {
      await storage.markTradeRetryJobFailed(job.id, job.lastError || 'Unknown error');
    } catch (dbErr) {
      console.warn(`[TradeRetry] Failed to mark job as failed in DB:`, dbErr);
    }
    
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    job.lastError = errorMsg;
    const catchErrorInfo = categorizeError(errorMsg);
    
    if (isTransientError(errorMsg) && job.attempts < job.maxAttempts) {
      const backoff = calculateBackoff(job.attempts, job.priority);
      job.nextRetryAt = Date.now() + backoff;
      console.log(`[TradeRetry] ${catchErrorInfo.emoji} [${catchErrorInfo.category}] Job ${job.id} threw error (retryable=${catchErrorInfo.retryable}), retry #${job.attempts + 1} in ${Math.round(backoff / 1000)}s: ${errorMsg.slice(0, 100)}`);
      return;
    }
    
    console.error(`[TradeRetry] ❌ [${catchErrorInfo.category}] Job ${job.id} threw error: ${errorMsg}`);
    
    if (job.attempts >= job.maxAttempts) {
      // DELAYED RE-QUEUE: If this is a timeout error and we haven't exhausted cooldown retries,
      // schedule a delayed re-queue after 2 minutes instead of marking as permanently failed
      const cooldownRetries = job.cooldownRetries || 0;
      if (isTimeoutError(errorMsg) && cooldownRetries < MAX_COOLDOWN_RETRIES) {
        job.cooldownRetries = cooldownRetries + 1;
        job.attempts = 0; // Reset attempts for fresh retry cycle
        job.nextRetryAt = Date.now() + COOLDOWN_DELAY_MS;
        console.log(`[TradeRetry] ${catchErrorInfo.emoji} [${catchErrorInfo.category}] Job ${job.id} - scheduling cooldown re-queue #${job.cooldownRetries}/${MAX_COOLDOWN_RETRIES} in 2min`);
        
        // Persist cooldown state to database (including cooldownRetries)
        try {
          await storage.updateTradeRetryJob(job.id, { 
            attempts: job.attempts,
            cooldownRetries: job.cooldownRetries,
            nextRetryAt: new Date(job.nextRetryAt),
            lastError: errorMsg,
          });
        } catch (dbErr) {
          console.warn(`[TradeRetry] Failed to persist cooldown state:`, dbErr);
        }
        return;
      }
      
      // Update original trade to failed
      if (job.originalTradeId) {
        await storage.updateBotTrade(job.originalTradeId, {
          status: 'failed',
          errorMessage: `Auto-retry exhausted after ${job.attempts} attempts (${cooldownRetries} cooldown retries): ${errorMsg}`,
        });
      }
      await notifyRetryResult(job, false, errorMsg);
      retryQueue.delete(job.id);
    } else {
      const backoff = calculateBackoff(job.attempts, job.priority);
      job.nextRetryAt = Date.now() + backoff;
    }
  }
}

async function processQueue(): Promise<void> {
  const now = Date.now();
  const readyJobs: RetryJob[] = [];
  
  const allJobs = Array.from(retryQueue.values());
  for (const job of allJobs) {
    if (job.nextRetryAt <= now) {
      readyJobs.push(job);
    }
  }
  
  readyJobs.sort((a, b) => {
    if (a.priority === 'critical' && b.priority !== 'critical') return -1;
    if (b.priority === 'critical' && a.priority !== 'critical') return 1;
    return a.nextRetryAt - b.nextRetryAt;
  });
  
  // Limit concurrent processing to prevent RPC bunching
  // Process max 2 jobs per cycle with staggered delays
  const maxJobsPerCycle = 2;
  const jobsToProcess = readyJobs.slice(0, maxJobsPerCycle);
  
  for (let i = 0; i < jobsToProcess.length; i++) {
    const job = jobsToProcess[i];
    
    // Add 3-second delay between jobs to prevent RPC rate limiting
    if (i > 0) {
      await new Promise(r => setTimeout(r, 3000));
    }
    
    await processRetryJob(job);
  }
  
  // If more jobs are waiting, they'll be picked up in the next cycle
  if (readyJobs.length > maxJobsPerCycle) {
    console.log(`[TradeRetry] ${readyJobs.length - maxJobsPerCycle} more jobs waiting, will process next cycle`);
  }
}

export async function startRetryWorker(): Promise<void> {
  if (workerInterval) {
    console.log('[TradeRetry] Worker already running');
    return;
  }
  
  // Load pending jobs from database on startup (survive server restarts)
  try {
    console.log('[TradeRetry] Checking database for pending retry jobs...');
    const pendingJobs = await storage.getPendingTradeRetryJobs();
    console.log(`[TradeRetry] Database query returned ${pendingJobs.length} pending jobs`);
    if (pendingJobs.length > 0) {
      console.log(`[TradeRetry] Loading ${pendingJobs.length} pending jobs from database`);
      
      const now = Date.now();
      const MAX_JOB_AGE_MS = 60 * 60 * 1000; // 1 hour TTL for OPEN retry jobs
      const MAX_CLOSE_JOB_AGE_MS = 5 * 60 * 1000; // 5 minute TTL for CLOSE retry jobs (stale closes are useless after market moves)
      
      for (const dbJob of pendingJobs) {
        // CLEANUP: Check if job is too old (stale)
        // CLOSE orders get a much shorter TTL - after 5 min the market has moved and retrying is pointless
        const isCloseJob = dbJob.side === 'close';
        const maxAge = isCloseJob ? MAX_CLOSE_JOB_AGE_MS : MAX_JOB_AGE_MS;
        const jobAge = now - new Date(dbJob.createdAt).getTime();
        if (jobAge > maxAge) {
          console.warn(`[TradeRetry] Job ${dbJob.id} expired (age: ${Math.round(jobAge / 60000)}min, side: ${dbJob.side || 'unknown'}) - marking as failed`);
          await storage.markTradeRetryJobFailed(dbJob.id, `Job expired after ${Math.round(jobAge / 60000)} minutes`);
          
          // Update original trade if exists
          if (dbJob.originalTradeId) {
            await storage.updateBotTrade(dbJob.originalTradeId, {
              status: 'failed',
              errorMessage: `Auto-retry expired after ${Math.round(jobAge / 60000)} minutes`,
            });
          }
          continue;
        }
        
        // CLEANUP: Check if job has already exceeded max attempts
        if (dbJob.attempts >= dbJob.maxAttempts) {
          console.warn(`[TradeRetry] Job ${dbJob.id} already at max attempts (${dbJob.attempts}/${dbJob.maxAttempts}) - marking as failed`);
          await storage.markTradeRetryJobFailed(dbJob.id, `Max attempts reached: ${dbJob.lastError || 'Unknown error'}`);
          
          if (dbJob.originalTradeId) {
            await storage.updateBotTrade(dbJob.originalTradeId, {
              status: 'failed',
              errorMessage: `Auto-retry exhausted after ${dbJob.attempts} attempts: ${dbJob.lastError || 'Unknown error'}`,
            });
          }
          continue;
        }
        
        // Get the bot to retrieve agent keys for execution
        const bot = await storage.getTradingBotById(dbJob.botId);
        const wallet = await storage.getWallet(dbJob.walletAddress);
        if (!bot || !wallet) {
          console.warn(`[TradeRetry] Skipping job ${dbJob.id} - bot or wallet not found`);
          await storage.markTradeRetryJobFailed(dbJob.id, 'Bot or wallet not found');
          continue;
        }
        
        const fullJob: RetryJob = {
          id: dbJob.id,
          botId: dbJob.botId,
          walletAddress: dbJob.walletAddress,
          agentPrivateKeyEncrypted: bot.agentPrivateKeyEncrypted || '',
          agentPublicKey: bot.agentPublicKey || wallet.agentPublicKey || '',
          market: dbJob.market,
          side: dbJob.side as 'long' | 'short' | 'close',
          size: parseFloat(dbJob.size),
          subAccountId: bot.driftSubaccountId || 0,
          reduceOnly: dbJob.side === 'close',
          slippageBps: wallet.slippageBps || 50,
          priority: dbJob.priority as 'critical' | 'normal',
          attempts: dbJob.attempts,
          maxAttempts: dbJob.maxAttempts,
          cooldownRetries: dbJob.cooldownRetries || 0,
          nextRetryAt: new Date(dbJob.nextRetryAt).getTime(),
          createdAt: new Date(dbJob.createdAt).getTime(),
          lastError: dbJob.lastError || undefined,
          originalTradeId: dbJob.originalTradeId,
          webhookPayload: dbJob.webhookPayload || undefined,
          entryPrice: dbJob.entryPrice ? parseFloat(dbJob.entryPrice) : undefined,
        };
        retryQueue.set(dbJob.id, fullJob);
      }
      const loadedCount = retryQueue.size;
      const cleanedCount = pendingJobs.length - loadedCount;
      console.log(`[TradeRetry] Startup: loaded ${loadedCount} jobs, cleaned up ${cleanedCount} stale/expired jobs`);
    }
  } catch (dbErr) {
    console.warn('[TradeRetry] Failed to load pending jobs from database:', dbErr);
  }
  
  console.log('[TradeRetry] Starting retry worker (checking every 2s, max 2 jobs/cycle, 3s stagger)');
  workerInterval = setInterval(() => {
    processQueue().catch(err => {
      console.error('[TradeRetry] Queue processing error:', err);
    });
  }, 2000);
}

export function stopRetryWorker(): void {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
    console.log('[TradeRetry] Worker stopped');
  }
}

export function getQueueStatus(): { pending: number; jobs: Array<{ id: string; market: string; side: string; priority: string; attempts: number; nextRetryIn: number }> } {
  const jobs = Array.from(retryQueue.values()).map(job => ({
    id: job.id,
    market: job.market,
    side: job.side,
    priority: job.priority,
    attempts: job.attempts,
    nextRetryIn: Math.max(0, Math.round((job.nextRetryAt - Date.now()) / 1000)),
  }));
  
  return {
    pending: jobs.length,
    jobs,
  };
}
