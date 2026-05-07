import { storage } from "./storage";
import { transferUsdcToWallet } from "./agent-wallet";

const RETRY_INTERVAL_MS = 5 * 60 * 1000; // Every 5 minutes
const MAX_RETRIES = 50;
const MAX_AGE_DAYS = 7;
const PROCESSING_STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Retry payment of failed/pending referral_reward_events. Each event already
 * encodes the funding wallet (subscriber whose agent wallet pays) and the
 * amount/recipient, so retries are self-contained. Mirrors the IOU retry
 * worker's TTL/processing semantics for parity.
 */
export async function retryPendingReferralRewards(): Promise<{ processed: number; paid: number; voided: number; failed: number }> {
  const pending = await storage.getPendingReferralRewardEvents();
  const results = { processed: 0, paid: 0, voided: 0, failed: 0 };
  if (pending.length === 0) return results;

  console.log(`[ReferralRetry] Processing ${pending.length} pending referral reward events`);

  for (const event of pending) {
    results.processed++;
    const ageInDays = (Date.now() - new Date(event.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    if ((event.retryCount ?? 0) >= MAX_RETRIES || ageInDays > MAX_AGE_DAYS) {
      console.log(`[ReferralRetry] Voiding event ${event.id}: retries=${event.retryCount}, age=${ageInDays.toFixed(1)} days`);
      await storage.updateReferralRewardEventStatus(event.id, {
        status: 'voided',
        lastError: `Expired: ${event.retryCount} retries over ${ageInDays.toFixed(1)} days`,
        lastAttemptAt: new Date(),
      });
      results.voided++;
      continue;
    }

    if (!event.fundingWallet) {
      console.warn(`[ReferralRetry] Event ${event.id} has no funding_wallet (likely legacy); marking voided`);
      await storage.updateReferralRewardEventStatus(event.id, {
        status: 'voided',
        lastError: 'Legacy event missing funding_wallet — cannot derive payer agent wallet',
        lastAttemptAt: new Date(),
      });
      results.voided++;
      continue;
    }

    // Atomic CAS: only one worker can claim this row. If another worker (or the
    // live path) already transitioned it out of pending/failed, skip this round.
    const claimed = await storage.claimReferralRewardEventForProcessing(event.id, ['pending', 'failed']);
    if (!claimed) {
      console.log(`[ReferralRetry] Skipping event ${event.id} — already claimed by another worker or status changed`);
      continue;
    }

    const wallet = await storage.getWallet(event.fundingWallet);
    if (!wallet?.agentPublicKey || !wallet?.agentPrivateKeyEncrypted) {
      console.error(`[ReferralRetry] Agent wallet not configured for funding wallet ${event.fundingWallet} (event ${event.id})`);
      await storage.updateReferralRewardEventStatus(event.id, {
        status: 'pending',
        retryCount: (event.retryCount ?? 0) + 1,
        lastError: 'Agent wallet not configured for funding wallet',
      });
      results.failed++;
      continue;
    }

    const amountUsdc = parseFloat(event.amountUsdc);
    console.log(`[ReferralRetry] Attempting L${event.level} $${amountUsdc.toFixed(4)} → ${event.earnerWallet} from ${event.fundingWallet} (event ${event.id})`);

    const transferResult = await transferUsdcToWallet(
      wallet.agentPublicKey,
      wallet.agentPrivateKeyEncrypted,
      event.earnerWallet,
      amountUsdc,
    );

    if (transferResult.success) {
      await storage.updateReferralRewardEventStatus(event.id, {
        status: 'paid',
        transferSignature: transferResult.signature ?? null,
        lastError: null,
        lastAttemptAt: new Date(),
      });
      console.log(`[ReferralRetry] PAID event ${event.id} (sig=${transferResult.signature})`);
      results.paid++;
    } else {
      const errMsg = transferResult.error || 'Transfer failed';
      await storage.updateReferralRewardEventStatus(event.id, {
        status: 'pending',
        retryCount: (event.retryCount ?? 0) + 1,
        lastError: errMsg,
      });
      console.warn(`[ReferralRetry] Failed event ${event.id}: ${errMsg}`);
      results.failed++;
    }
  }

  console.log(`[ReferralRetry] Complete: ${results.paid} paid, ${results.voided} voided, ${results.failed} failed`);
  return results;
}

async function resetStaleProcessingReferralEvents(): Promise<void> {
  const processing = await storage.getProcessingReferralRewardEvents();
  const staleThreshold = new Date(Date.now() - PROCESSING_STALE_THRESHOLD_MS);
  for (const event of processing) {
    if (event.lastAttemptAt && new Date(event.lastAttemptAt) < staleThreshold) {
      console.log(`[ReferralRetry] Resetting stale processing event: ${event.id}`);
      await storage.updateReferralRewardEventStatus(event.id, {
        status: 'pending',
        lastError: 'Reset from stale processing state',
      });
    }
  }
}

export function startReferralRewardsRetryJob(): void {
  console.log("[ReferralRetry] Starting referral rewards retry service (every 5 minutes)");

  setTimeout(async () => {
    try {
      await resetStaleProcessingReferralEvents();
      await retryPendingReferralRewards();
    } catch (err: any) {
      const msg = err?.message || "";
      if (msg.includes("Authentication timed out") || msg.includes("connection timeout") || msg.includes("timeout exceeded") || msg.includes("too many clients") || msg.includes("Connection terminated")) {
        console.warn("[ReferralRetry] DB timeout on initial run — will retry next cycle");
      } else {
        console.error("[ReferralRetry] Initial run failed:", err?.message || err);
      }
    }
  }, 35000);

  setInterval(async () => {
    try {
      await resetStaleProcessingReferralEvents();
      await retryPendingReferralRewards();
    } catch (err: any) {
      const msg = err?.message || "";
      if (msg.includes("Authentication timed out") || msg.includes("connection timeout") || msg.includes("timeout exceeded") || msg.includes("too many clients") || msg.includes("Connection terminated")) {
        console.warn("[ReferralRetry] DB timeout — will retry next cycle");
      } else {
        console.error("[ReferralRetry] Periodic run failed:", err?.message || err);
      }
    }
  }, RETRY_INTERVAL_MS);
}
