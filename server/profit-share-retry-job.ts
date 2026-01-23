import { storage } from "./storage";
import { transferUsdcToWallet } from "./agent-wallet";

const RETRY_INTERVAL_MS = 5 * 60 * 1000; // Every 5 minutes
const MAX_IOU_RETRIES = 50;
const MAX_IOU_AGE_DAYS = 7;
const PROCESSING_STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

export async function retryPendingProfitShares(): Promise<{ processed: number; paid: number; voided: number; failed: number }> {
  const pendingIOUs = await storage.getAllPendingProfitShares();
  const results = { processed: 0, paid: 0, voided: 0, failed: 0 };
  
  if (pendingIOUs.length === 0) {
    return results;
  }
  
  console.log(`[ProfitShare Retry] Processing ${pendingIOUs.length} pending IOUs`);
  
  for (const iou of pendingIOUs) {
    results.processed++;
    
    // Check TTL - void if too old or too many retries
    const ageInDays = (Date.now() - new Date(iou.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    if (iou.retryCount >= MAX_IOU_RETRIES || ageInDays > MAX_IOU_AGE_DAYS) {
      console.log(`[ProfitShare Retry] Voiding IOU ${iou.id}: retries=${iou.retryCount}, age=${ageInDays.toFixed(1)} days`);
      await storage.updatePendingProfitShareStatus(iou.id, { 
        status: 'voided', 
        lastError: `Expired: ${iou.retryCount} retries over ${ageInDays.toFixed(1)} days`,
        lastAttemptAt: new Date()
      });
      results.voided++;
      continue;
    }
    
    // Mark as processing to prevent concurrent processing
    await storage.updatePendingProfitShareStatus(iou.id, { 
      status: 'processing',
      lastAttemptAt: new Date()
    });
    
    // Get subscriber bot to get agent wallet info
    const subscriberBot = await storage.getTradingBotById(iou.subscriberBotId);
    if (!subscriberBot) {
      console.error(`[ProfitShare Retry] Subscriber bot not found: ${iou.subscriberBotId}`);
      await storage.updatePendingProfitShareStatus(iou.id, { 
        status: 'pending',
        retryCount: iou.retryCount + 1,
        lastError: 'Subscriber bot not found'
      });
      results.failed++;
      continue;
    }
    
    const wallet = await storage.getWallet(subscriberBot.walletAddress);
    if (!wallet?.agentPublicKey || !wallet?.agentPrivateKeyEncrypted) {
      console.error(`[ProfitShare Retry] Agent wallet not configured for bot ${subscriberBot.id}`);
      await storage.updatePendingProfitShareStatus(iou.id, { 
        status: 'pending',
        retryCount: iou.retryCount + 1,
        lastError: 'Agent wallet not configured'
      });
      results.failed++;
      continue;
    }
    
    const amount = parseFloat(iou.amount);
    console.log(`[ProfitShare Retry] Attempting transfer: $${amount.toFixed(4)} to ${iou.creatorWalletAddress}`);
    
    // Attempt the transfer
    const transferResult = await transferUsdcToWallet(
      wallet.agentPublicKey,
      wallet.agentPrivateKeyEncrypted,
      iou.creatorWalletAddress,
      amount
    );
    
    if (transferResult.success) {
      console.log(`[ProfitShare Retry] SUCCESS: IOU ${iou.id} paid, signature: ${transferResult.signature}`);
      await storage.updatePendingProfitShareStatus(iou.id, { 
        status: 'paid',
        lastAttemptAt: new Date()
      });
      results.paid++;
    } else {
      console.error(`[ProfitShare Retry] Failed: ${transferResult.error}`);
      await storage.updatePendingProfitShareStatus(iou.id, { 
        status: 'pending',
        retryCount: iou.retryCount + 1,
        lastError: transferResult.error || 'Transfer failed'
      });
      results.failed++;
    }
  }
  
  console.log(`[ProfitShare Retry] Complete: ${results.paid} paid, ${results.voided} voided, ${results.failed} failed`);
  return results;
}

async function resetStaleProcessingEntries(): Promise<void> {
  const processingIOUs = await storage.getPendingProfitSharesProcessing();
  const staleThreshold = new Date(Date.now() - PROCESSING_STALE_THRESHOLD_MS);
  
  for (const iou of processingIOUs) {
    if (iou.lastAttemptAt && new Date(iou.lastAttemptAt) < staleThreshold) {
      console.log(`[ProfitShare Retry] Resetting stale processing entry: ${iou.id}`);
      await storage.updatePendingProfitShareStatus(iou.id, {
        status: 'pending',
        lastError: 'Reset from stale processing state'
      });
    }
  }
}

export function startProfitShareRetryJob(): void {
  console.log("[ProfitShare Retry] Starting profit share retry service (every 5 minutes)");
  
  // Run immediately on start (after a short delay to let other services initialize)
  setTimeout(async () => {
    try {
      await resetStaleProcessingEntries();
      await retryPendingProfitShares();
    } catch (err: any) {
      console.error("[ProfitShare Retry] Initial run failed:", err.message);
    }
  }, 30000); // 30 second initial delay
  
  // Then run every 5 minutes
  setInterval(async () => {
    try {
      await resetStaleProcessingEntries();
      await retryPendingProfitShares();
    } catch (err: any) {
      console.error("[ProfitShare Retry] Periodic run failed:", err.message);
    }
  }, RETRY_INTERVAL_MS);
}
