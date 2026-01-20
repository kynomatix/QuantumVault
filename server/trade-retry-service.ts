import { sendTradeNotification } from "./notification-service";
import { executePerpOrder, closePerpPosition, getPerpPositions } from "./drift-service";
import { syncPositionFromOnChain } from "./reconciliation-service";
import { storage } from "./storage";
import { getMarketBySymbol } from "./market-liquidity-service";

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
}

const retryQueue: Map<string, RetryJob> = new Map();
let workerInterval: NodeJS.Timeout | null = null;

const BACKOFF_BASE_MS = 5000;
const BACKOFF_MAX_MS = 60000;
const MAX_ATTEMPTS_NORMAL = 5;
const MAX_ATTEMPTS_CRITICAL = 10;

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

// Transient errors that should be retried (price feed issues, oracle staleness)
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
    // Also check for rate limit errors
    isRateLimitError(error)
  );
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
  const id = generateJobId();
  const maxAttempts = job.priority === 'critical' ? MAX_ATTEMPTS_CRITICAL : MAX_ATTEMPTS_NORMAL;
  const backoff = calculateBackoff(0, job.priority);
  
  const fullJob: RetryJob = {
    ...job,
    id,
    attempts: 0,
    maxAttempts,
    nextRetryAt: Date.now() + backoff,
    createdAt: Date.now(),
  };
  
  retryQueue.set(id, fullJob);
  
  // Persist to database for survival across server restarts
  try {
    await storage.createTradeRetryJob({
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
      nextRetryAt: new Date(fullJob.nextRetryAt),
      status: 'pending',
    });
    console.log(`[TradeRetry] Persisted job ${id} to database`);
  } catch (dbErr) {
    console.warn(`[TradeRetry] Failed to persist job to database:`, dbErr);
  }
  
  console.log(`[TradeRetry] Queued ${job.priority} ${job.side} ${job.market} retry, first attempt in ${Math.round(backoff / 1000)}s (job ${id})`);
  
  notifyRetryQueued(fullJob);
  
  return id;
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
    
    await sendTradeNotification(job.walletAddress, {
      type: 'trade_failed',
      botName,
      market: job.market,
      side: sideLabel as 'LONG' | 'SHORT',
      size: job.size,
      error: `Rate limited - auto-retry scheduled in ${nextRetrySeconds}s ${priorityEmoji}`,
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
      await sendTradeNotification(job.walletAddress, {
        type: 'trade_failed',
        botName,
        market: job.market,
        side: sideLabel as 'LONG' | 'SHORT',
        size: job.size,
        error: `❌ Auto-retry exhausted after ${job.attempts} attempts: ${error || 'Unknown error'}`,
      });
    }
  } catch (err) {
    console.warn('[TradeRetry] Failed to send result notification:', err);
  }
}

async function processRetryJob(job: RetryJob): Promise<void> {
  job.attempts++;
  console.log(`[TradeRetry] Processing ${job.priority} job ${job.id}: ${job.side} ${job.market} (attempt ${job.attempts}/${job.maxAttempts})`);
  
  try {
    let result: { success: boolean; signature?: string; error?: string; fillPrice?: number };
    let actualCloseSide: 'long' | 'short' = 'short';
    
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
      console.log(`[TradeRetry] ✅ Job ${job.id} succeeded on attempt ${job.attempts}: ${result.signature}`);
      
      const wallet = await storage.getWallet(job.walletAddress);
      const bot = await storage.getTradingBotById(job.botId);
      
      if (bot && wallet) {
        const fillPrice = result.fillPrice || 0;
        const notional = job.size * fillPrice;
        const fee = notional * 0.0005;
        
        // Update original trade if it exists, otherwise create new
        let tradeId: string;
        if (job.originalTradeId) {
          await storage.updateBotTrade(job.originalTradeId, {
            status: 'executed',
            price: fillPrice.toString(),
            fee: fee.toString(),
            txSignature: result.signature || null,
            errorMessage: `Auto-retry succeeded after ${job.attempts} attempt(s)`,
          });
          tradeId = job.originalTradeId;
          console.log(`[TradeRetry] Updated original trade ${tradeId} to executed`);
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
    
    // Retry if transient error (rate limit, price feed, oracle issues) and attempts remaining
    if (isTransientError(job.lastError) && job.attempts < job.maxAttempts) {
      const backoff = calculateBackoff(job.attempts, job.priority);
      job.nextRetryAt = Date.now() + backoff;
      console.log(`[TradeRetry] Job ${job.id} transient error, retry in ${Math.round(backoff / 1000)}s`);
      return;
    }
    
    // Mark as permanently failed
    console.error(`[TradeRetry] ❌ Job ${job.id} failed permanently: ${job.lastError}`);
    
    // Update original trade to failed if exists
    if (job.originalTradeId) {
      await storage.updateBotTrade(job.originalTradeId, {
        status: 'failed',
        errorMessage: `Auto-retry exhausted after ${job.attempts} attempts: ${job.lastError}`,
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
    
    if (isTransientError(errorMsg) && job.attempts < job.maxAttempts) {
      const backoff = calculateBackoff(job.attempts, job.priority);
      job.nextRetryAt = Date.now() + backoff;
      console.log(`[TradeRetry] Job ${job.id} threw transient error, retry in ${Math.round(backoff / 1000)}s`);
      return;
    }
    
    console.error(`[TradeRetry] ❌ Job ${job.id} threw error: ${errorMsg}`);
    
    if (job.attempts >= job.maxAttempts) {
      // Update original trade to failed
      if (job.originalTradeId) {
        await storage.updateBotTrade(job.originalTradeId, {
          status: 'failed',
          errorMessage: `Auto-retry exhausted after ${job.attempts} attempts: ${errorMsg}`,
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
  
  for (const job of readyJobs) {
    await processRetryJob(job);
  }
}

export async function startRetryWorker(): Promise<void> {
  if (workerInterval) {
    console.log('[TradeRetry] Worker already running');
    return;
  }
  
  // Load pending jobs from database on startup (survive server restarts)
  try {
    const pendingJobs = await storage.getPendingTradeRetryJobs();
    if (pendingJobs.length > 0) {
      console.log(`[TradeRetry] Loading ${pendingJobs.length} pending jobs from database`);
      for (const dbJob of pendingJobs) {
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
          nextRetryAt: new Date(dbJob.nextRetryAt).getTime(),
          createdAt: new Date(dbJob.createdAt).getTime(),
          lastError: dbJob.lastError || undefined,
          originalTradeId: dbJob.originalTradeId,
        };
        retryQueue.set(dbJob.id, fullJob);
      }
      console.log(`[TradeRetry] Restored ${retryQueue.size} jobs from database`);
    }
  } catch (dbErr) {
    console.warn('[TradeRetry] Failed to load pending jobs from database:', dbErr);
  }
  
  console.log('[TradeRetry] Starting retry worker (checking every 2s)');
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
