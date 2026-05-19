import { storage } from "./storage";
import { payCreatorAndReferrals } from "./routes";
import { getUmkForWebhook, decryptAgentKeyStrict } from "./session-v3";

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
    // V3 Phase 3b: readiness check is V3-only. We require an agent public key
    // and a V3 envelope; the legacy encrypted blob is intentionally NOT part
    // of the gate so wallets that have already retired their legacy key still
    // qualify for retry. The strict decrypt below is the source of truth.
    if (!wallet?.agentPublicKey || !wallet?.agentPrivateKeyEncryptedV3) {
      // V3 Phase 4: auth-unavailable states (missing V3 envelope) DO NOT
      // burn the IOU's retry budget — pause until the subscriber's wallet
      // is re-configured. Matches trade-retry / orphan-cleanup semantics.
      console.error(`[ProfitShare Retry] Agent wallet not V3-configured for bot ${subscriberBot.id}; deferring (retry budget preserved)`);
      await storage.updatePendingProfitShareStatus(iou.id, {
        status: 'pending',
        lastError: 'Agent wallet missing V3 envelope or public key (paused, retry budget preserved)'
      });
      results.failed++;
      continue;
    }
    
    const amount = parseFloat(iou.amount);
    console.log(`[ProfitShare Retry] Attempting payout via shared helper: gross $${amount.toFixed(4)} for trade ${iou.tradeId} (creator ${iou.creatorWalletAddress})`);

    // V3 Phase 3b: never touch the legacy encrypted blob. The retry worker
    // must strict-decrypt the subscriber's agent key via UMK_STORAGE_SECRET +
    // the wallet's stored v3 envelope, just like the live fan-out. If the
    // subscriber has revoked execution / emergency-stopped, keep the IOU
    // pending so it retries again once execution is re-enabled.
    const umkResult = await getUmkForWebhook(subscriberBot.walletAddress);
    if (!umkResult) {
      const reason = wallet.emergencyStopTriggered
        ? 'subscriber_emergency_stopped'
        : 'subscriber_execution_disabled';
      // V3 Phase 4: do not burn the retry budget while the subscriber has
      // execution disabled / emergency-stopped — the IOU should fire as
      // soon as execution is re-enabled.
      console.warn(`[ProfitShare Retry] IOU ${iou.id}: ${reason}; keeping pending (retry budget preserved)`);
      await storage.updatePendingProfitShareStatus(iou.id, {
        status: 'pending',
        lastError: `Subscriber execution authorization unavailable (${reason}); paused, retry budget preserved`,
      });
      results.failed++;
      continue;
    }
    const agentKeyResult = await decryptAgentKeyStrict(
      subscriberBot.walletAddress,
      umkResult.umk,
      wallet,
      wallet.agentPublicKey,
    );
    if (!agentKeyResult) {
      umkResult.cleanup();
      // V3 Phase 4: strict-decrypt failure is an auth-unavailable state;
      // preserve retry budget so the IOU can fire once decryption recovers.
      console.error(`[ProfitShare Retry] IOU ${iou.id}: V3 strict decrypt failed for subscriber ${subscriberBot.walletAddress.slice(0,8)}...; keeping pending (retry budget preserved)`);
      await storage.updatePendingProfitShareStatus(iou.id, {
        status: 'pending',
        lastError: 'V3 strict decrypt failed for subscriber agent key (paused, retry budget preserved)',
      });
      results.failed++;
      continue;
    }

    let payoutResult;
    try {
      // Route through the shared payout helper so referral cuts are netted out
      // exactly the same way as the live path (Model A). The helper is idempotent
      // on (sourceType, sourceId), so this is safe to retry.
      payoutResult = await payCreatorAndReferrals({
        subscriberAgentPublicKey: wallet.agentPublicKey,
        subscriberEncryptedPrivateKey: agentKeyResult.secretKey,
        creatorWalletAddress: iou.creatorWalletAddress,
        profitShareAmount: amount,
        sourceType: 'profit_share_paid',
        sourceId: iou.tradeId,
        fundingWallet: iou.subscriberWalletAddress,
      });
    } finally {
      agentKeyResult.cleanup();
      umkResult.cleanup();
    }

    if (payoutResult.success) {
      console.log(`[ProfitShare Retry] SUCCESS: IOU ${iou.id} paid (creator $${(payoutResult.creatorAmount ?? 0).toFixed(4)}, sig=${payoutResult.creatorSignature}, referrals: ${payoutResult.referralSummary})`);
      await storage.updatePendingProfitShareStatus(iou.id, { 
        status: 'paid',
        lastAttemptAt: new Date()
      });
      results.paid++;
    } else {
      console.error(`[ProfitShare Retry] Failed: ${payoutResult.error}`);
      await storage.updatePendingProfitShareStatus(iou.id, { 
        status: 'pending',
        retryCount: iou.retryCount + 1,
        lastError: payoutResult.error || 'Transfer failed'
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
      const msg = err?.message || "";
      if (msg.includes("Authentication timed out") || msg.includes("connection timeout") || msg.includes("timeout exceeded") || msg.includes("too many clients") || msg.includes("Connection terminated")) {
        console.warn("[ProfitShare Retry] DB timeout on initial run — will retry next cycle");
      } else {
        console.error("[ProfitShare Retry] Initial run failed:", err.message);
      }
    }
  }, 30000);
  
  setInterval(async () => {
    try {
      await resetStaleProcessingEntries();
      await retryPendingProfitShares();
    } catch (err: any) {
      const msg = err?.message || "";
      if (msg.includes("Authentication timed out") || msg.includes("connection timeout") || msg.includes("timeout exceeded") || msg.includes("too many clients") || msg.includes("Connection terminated")) {
        console.warn("[ProfitShare Retry] DB timeout — will retry next cycle");
      } else {
        console.error("[ProfitShare Retry] Periodic run failed:", err.message);
      }
    }
  }, RETRY_INTERVAL_MS);
}
