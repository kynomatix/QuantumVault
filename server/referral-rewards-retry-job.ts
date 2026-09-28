import { storage } from './storage';
import { payDurableReferralLeg, reconcileSignedSubmitAttempt } from './profit-share-payment';
import { getUmkForWebhook, decryptAgentKeyStrict } from './session-v3';
import { requireSchemaCapabilityReady } from './schema-readiness';

const RETRY_INTERVAL_MS = 5 * 60 * 1000;
const MAX_RETRIES = 50;
const MAX_AGE_DAYS = 7;
const PROCESSING_STALE_THRESHOLD_MS = 10 * 60 * 1000;

async function reconcileProcessingReferralRewards(): Promise<Set<string>> {
  const doNotResend = new Set<string>();
  const staleBefore = new Date(Date.now() - PROCESSING_STALE_THRESHOLD_MS);
  for (const event of await storage.getProcessingReferralRewardEvents()) {
    const result = await reconcileSignedSubmitAttempt('referral_reward', event.id);
    if (result) {
      doNotResend.add(event.id);
      continue;
    }
    if (await storage.resetStaleReferralClaim(event.id, staleBefore)) doNotResend.add(event.id);
  }
  return doNotResend;
}

export async function retryPendingReferralRewards(): Promise<{ processed: number; paid: number; voided: number; failed: number }> {
  const doNotResend = await reconcileProcessingReferralRewards();
  const results = { processed: 0, paid: 0, voided: 0, failed: 0 };
  for (const event of await storage.getPendingReferralRewardEvents()) {
    if (doNotResend.has(event.id)) continue;
    results.processed += 1;
    const ageOrigin = event.releasedAt ?? event.createdAt;
    const ageInDays = (Date.now() - new Date(ageOrigin).getTime()) / 86_400_000;
    if ((event.retryCount ?? 0) >= MAX_RETRIES || ageInDays > MAX_AGE_DAYS || !event.fundingWallet) {
      const reason = !event.fundingWallet
        ? 'Legacy event missing funding wallet'
        : `Expired: ${event.retryCount} retries over ${ageInDays.toFixed(1)} days`;
      if (await storage.voidReferralRewardEvent(event.id, reason)) results.voided += 1;
      continue;
    }

    const wallet = await storage.getWallet(event.fundingWallet);
    if (!wallet?.agentPublicKey || !wallet.agentPrivateKeyEncryptedV3) {
      await storage.updateReferralRewardEventStatus(event.id, { lastError: 'Funding agent authorization unavailable (paused, retry budget preserved)' });
      results.failed += 1;
      continue;
    }
    const umkResult = await getUmkForWebhook(event.fundingWallet);
    if (!umkResult) {
      await storage.updateReferralRewardEventStatus(event.id, { lastError: 'Funding wallet execution authorization unavailable (paused, retry budget preserved)' });
      results.failed += 1;
      continue;
    }
    const key = await decryptAgentKeyStrict(event.fundingWallet, umkResult.umk, wallet, wallet.agentPublicKey);
    if (!key) {
      umkResult.cleanup();
      await storage.updateReferralRewardEventStatus(event.id, { lastError: 'Funding agent key decryption unavailable (paused, retry budget preserved)' });
      results.failed += 1;
      continue;
    }
    try {
      await requireSchemaCapabilityReady('referrals');
      const claimToken = await storage.claimReferralRewardEventForProcessing(event.id, ['pending', 'failed']);
      if (!claimToken) continue;
      const result = await payDurableReferralLeg({
        eventId: event.id,
        claimToken,
        subscriberAgentPublicKey: wallet.agentPublicKey,
        subscriberEncryptedPrivateKey: key.secretKey,
        recipientWallet: event.earnerWallet,
        amountUsdc: Number(event.amountUsdc),
      });
      if (result.outcome === 'confirmed_success') results.paid += 1;
      else results.failed += 1;
    } finally {
      key.cleanup();
      umkResult.cleanup();
    }
  }
  return results;
}

export function startReferralRewardsRetryJob(): void {
  console.log('[ReferralRetry] Starting referral rewards retry service (every 5 minutes)');
  const run = () => void retryPendingReferralRewards().catch((error) => console.error('[ReferralRetry] Cycle failed:', error));
  setTimeout(run, 35_000);
  setInterval(run, RETRY_INTERVAL_MS);
}
