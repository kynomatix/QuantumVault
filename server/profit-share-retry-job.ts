import { storage } from './storage';
import { payCreatorAndReferrals, reconcileSignedSubmitAttempt, type ProfitShareObligationInput } from './profit-share-payment';
import { getUmkForWebhook, decryptAgentKeyStrict } from './session-v3';
import { requireSchemaCapabilityReady } from './schema-readiness';

const RETRY_INTERVAL_MS = 5 * 60 * 1000;
const MAX_IOU_RETRIES = 50;
const MAX_IOU_AGE_DAYS = 7;
const PROCESSING_STALE_THRESHOLD_MS = 10 * 60 * 1000;

async function reconcileProcessingProfitShares(): Promise<Set<string>> {
  const doNotResend = new Set<string>();
  const staleBefore = new Date(Date.now() - PROCESSING_STALE_THRESHOLD_MS);
  for (const share of await storage.getPendingProfitSharesProcessing()) {
    const result = await reconcileSignedSubmitAttempt('profit_share_creator', share.id);
    if (result) {
      doNotResend.add(share.id);
      continue;
    }
    if (await storage.resetStaleProfitShareClaim(share.id, staleBefore)) doNotResend.add(share.id);
  }
  return doNotResend;
}

function obligationFromShare(share: Awaited<ReturnType<typeof storage.getAllPendingProfitShares>>[number]): ProfitShareObligationInput {
  return {
    subscriberBotId: share.subscriberBotId,
    subscriberWalletAddress: share.subscriberWalletAddress,
    creatorWalletAddress: share.creatorWalletAddress,
    amount: share.amount,
    realizedPnl: share.realizedPnl,
    profitSharePercent: share.profitSharePercent,
    tradeId: share.tradeId,
    publishedBotId: share.publishedBotId,
    driftSubaccountId: share.driftSubaccountId,
    protocolSubaccountId: share.protocolSubaccountId,
    protocol: share.protocol,
  };
}

export async function retryPendingProfitShares(): Promise<{ processed: number; paid: number; voided: number; failed: number }> {
  const doNotResend = await reconcileProcessingProfitShares();
  const results = { processed: 0, paid: 0, voided: 0, failed: 0 };
  for (const iou of await storage.getAllPendingProfitShares()) {
    if (doNotResend.has(iou.id)) continue;
    results.processed += 1;
    const ageInDays = (Date.now() - new Date(iou.createdAt).getTime()) / 86_400_000;
    if (iou.retryCount >= MAX_IOU_RETRIES || ageInDays > MAX_IOU_AGE_DAYS) {
      if (await storage.voidProfitShareWithReferrals(iou.id, `Expired: ${iou.retryCount} retries over ${ageInDays.toFixed(1)} days`)) {
        results.voided += 1;
      }
      continue;
    }

    const subscriberBot = await storage.getTradingBotById(iou.subscriberBotId);
    if (!subscriberBot) {
      await storage.updatePendingProfitShareStatus(iou.id, {
        retryCount: iou.retryCount + 1,
        lastError: 'Subscriber bot not found',
        lastAttemptAt: new Date(),
      });
      results.failed += 1;
      continue;
    }
    const wallet = await storage.getWallet(subscriberBot.walletAddress);
    if (!wallet?.agentPublicKey || !wallet.agentPrivateKeyEncryptedV3) {
      await storage.updatePendingProfitShareStatus(iou.id, { lastError: 'Subscriber agent authorization unavailable (paused, retry budget preserved)' });
      results.failed += 1;
      continue;
    }
    const umkResult = await getUmkForWebhook(subscriberBot.walletAddress);
    if (!umkResult) {
      await storage.updatePendingProfitShareStatus(iou.id, { lastError: 'Subscriber execution authorization unavailable (paused, retry budget preserved)' });
      results.failed += 1;
      continue;
    }
    const key = await decryptAgentKeyStrict(subscriberBot.walletAddress, umkResult.umk, wallet, wallet.agentPublicKey);
    if (!key) {
      umkResult.cleanup();
      await storage.updatePendingProfitShareStatus(iou.id, { lastError: 'Subscriber agent key decryption unavailable (paused, retry budget preserved)' });
      results.failed += 1;
      continue;
    }
    try {
      await requireSchemaCapabilityReady('referrals');
      const payout = await payCreatorAndReferrals({
        obligation: obligationFromShare(iou),
        subscriberAgentPublicKey: wallet.agentPublicKey,
        subscriberEncryptedPrivateKey: key.secretKey,
        sourceType: 'profit_share_paid',
        sourceId: iou.tradeId,
        fundingWallet: iou.subscriberWalletAddress,
        allowedSourceStatuses: ['pending'],
      });
      if (payout.outcome === 'confirmed_success') results.paid += 1;
      else results.failed += 1;
    } finally {
      key.cleanup();
      umkResult.cleanup();
    }
  }
  return results;
}

export function startProfitShareRetryJob(): void {
  console.log('[ProfitShare Retry] Starting profit share retry service (every 5 minutes)');
  const run = () => void retryPendingProfitShares().catch((error) => console.error('[ProfitShare Retry] Cycle failed:', error));
  setTimeout(run, 30_000);
  setInterval(run, RETRY_INTERVAL_MS);
}
