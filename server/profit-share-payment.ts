import {
  getFinalizedEpochPositionStrict,
  getSignatureStatusStrict,
  transferUsdcToWallet,
} from './agent-wallet';
import { requireSchemaCapabilityReady } from './schema-readiness';
import {
  storage,
  type SignedSubmitOperationType,
} from './storage';
import type {
  InsertPendingProfitShare,
  InsertReferralRewardEvent,
  PendingProfitShare,
  ReferralRewardEvent,
  SolanaSignedSubmitAttempt,
} from '@shared/schema';
import { SOL_WITHDRAW_EXPIRY_SLACK_BLOCKS } from './vault/agent-sol-withdraw';

export type SignedSubmitOutcome =
  | 'rejected_before_broadcast'
  | 'confirmed_success'
  | 'confirmed_failure'
  | 'ambiguous';

export interface ProfitShareObligationInput {
  subscriberBotId: string;
  subscriberWalletAddress: string;
  creatorWalletAddress: string;
  amount: string;
  realizedPnl: string;
  profitSharePercent: string;
  tradeId: string;
  publishedBotId: string | null;
  driftSubaccountId: number | null;
  protocolSubaccountId: string | null;
  protocol: string | null;
}

export interface DurableProfitShareLegParams {
  shareId: string;
  claimToken: string;
  subscriberAgentPublicKey: string;
  subscriberEncryptedPrivateKey: Uint8Array;
  recipientWallet: string;
  amountUsdc: number;
  operationType: 'profit_share_creator';
}

export const REFERRAL_LEVEL_PERCENTS: Record<1 | 2 | 3, number> = { 1: 5, 2: 2, 3: 1 };
export const MIN_PAYABLE_MICRO_USDC = 10_000;

export interface ClaimedProfitShare {
  share: PendingProfitShare;
  claimed: true;
  claimToken: string;
}

type ResolverResult =
  | { outcome: 'confirmed_success' | 'confirmed_failure' | 'expired_without_status'; error?: string }
  | { outcome: 'ambiguous'; error?: string };

export async function resolveSignedSubmitAttempt(attempt: SolanaSignedSubmitAttempt): Promise<ResolverResult> {
  try {
    const epoch = await getFinalizedEpochPositionStrict();
    const lastValid = Number(attempt.lastValidBlockHeight);
    if (!Number.isSafeInteger(lastValid) || lastValid < 0) {
      return { outcome: 'ambiguous', error: 'Stored last-valid block height is malformed' };
    }
    if (epoch.blockHeight <= lastValid + SOL_WITHDRAW_EXPIRY_SLACK_BLOCKS) {
      return { outcome: 'ambiguous' };
    }
    const observed = await getSignatureStatusStrict(attempt.deterministicSignature, { withContext: true });
    if (observed.contextSlot < epoch.contextSlot) return { outcome: 'ambiguous' };
    if (!observed.status) {
      return { outcome: 'expired_without_status', error: 'Blockhash expired without signature status' };
    }
    if (observed.status.err != null) {
      return { outcome: 'confirmed_failure', error: `Transaction failed on-chain: ${JSON.stringify(observed.status.err)}` };
    }
    if (observed.status.confirmationStatus === 'confirmed' || observed.status.confirmationStatus === 'finalized') {
      return { outcome: 'confirmed_success' };
    }
    return { outcome: 'ambiguous' };
  } catch (error: any) {
    return { outcome: 'ambiguous', error: error?.message ?? String(error) };
  }
}

export async function reconcileSignedSubmitAttempt(
  operationType: SignedSubmitOperationType,
  operationId: string,
): Promise<ResolverResult | null> {
  const attempt = await storage.getActiveSignedSubmitAttempt(operationType, operationId);
  if (!attempt) return null;
  const result = await resolveSignedSubmitAttempt(attempt);
  if (result.outcome !== 'ambiguous') {
    await storage.settleSignedSubmitAttempt(attempt, result.outcome, result.error ?? null);
  }
  return result;
}

export async function payDurableProfitShareLeg(
  params: DurableProfitShareLegParams,
): Promise<{ outcome: SignedSubmitOutcome; signature?: string; error?: string }> {
  await requireSchemaCapabilityReady('referrals');
  let attemptPersistenceLost = false;
  const transfer = await transferUsdcToWallet(
    params.subscriberAgentPublicKey,
    params.subscriberEncryptedPrivateKey,
    params.recipientWallet,
    params.amountUsdc,
    async (attempt) => {
      const persisted = await storage.persistCreatorSignedSubmitAttempt(
        params.shareId,
        params.claimToken,
        {
          operationType: params.operationType,
          operationId: params.shareId,
          deterministicSignature: attempt.signature,
          blockhash: attempt.blockhash,
          lastValidBlockHeight: attempt.lastValidBlockHeight,
          rpcProvider: attempt.rpcProvider,
        },
      );
      if (!persisted) {
        attemptPersistenceLost = true;
        throw new Error('Creator payout claim was lost before broadcast');
      }
    },
  );
  if (transfer.outcome === 'rejected_before_broadcast' && !attemptPersistenceLost) {
    await storage.resetCreatorClaimBeforeBroadcast(params.shareId, params.claimToken, transfer.error ?? 'Rejected before broadcast');
  } else if (transfer.outcome === 'confirmed_success' || transfer.outcome === 'confirmed_failure') {
    const active = await storage.getActiveSignedSubmitAttempt(params.operationType, params.shareId);
    if (active) await storage.settleSignedSubmitAttempt(active, transfer.outcome, transfer.error ?? null);
  }
  return { outcome: transfer.outcome, signature: transfer.signature, error: transfer.error };
}

export async function payDurableReferralLeg(params: {
  eventId: string;
  claimToken: string;
  subscriberAgentPublicKey: string;
  subscriberEncryptedPrivateKey: Uint8Array;
  recipientWallet: string;
  amountUsdc: number;
}): Promise<{ outcome: SignedSubmitOutcome; signature?: string; error?: string }> {
  await requireSchemaCapabilityReady('referrals');
  let attemptPersistenceLost = false;
  const transfer = await transferUsdcToWallet(
    params.subscriberAgentPublicKey,
    params.subscriberEncryptedPrivateKey,
    params.recipientWallet,
    params.amountUsdc,
    async (attempt) => {
      const persisted = await storage.persistReferralSignedSubmitAttempt(
        params.eventId,
        params.claimToken,
        {
          operationType: 'referral_reward',
          operationId: params.eventId,
          deterministicSignature: attempt.signature,
          blockhash: attempt.blockhash,
          lastValidBlockHeight: attempt.lastValidBlockHeight,
          rpcProvider: attempt.rpcProvider,
        },
      );
      if (!persisted) {
        attemptPersistenceLost = true;
        throw new Error('Referral payout claim was lost before broadcast');
      }
    },
  );
  if (transfer.outcome === 'rejected_before_broadcast' && !attemptPersistenceLost) {
    await storage.resetReferralClaimBeforeBroadcast(params.eventId, params.claimToken, transfer.error ?? 'Rejected before broadcast');
  } else if (transfer.outcome === 'confirmed_success' || transfer.outcome === 'confirmed_failure') {
    const active = await storage.getActiveSignedSubmitAttempt('referral_reward', params.eventId);
    if (active) await storage.settleSignedSubmitAttempt(active, transfer.outcome, transfer.error ?? null);
  }
  return { outcome: transfer.outcome, signature: transfer.signature, error: transfer.error };
}

export async function payGrossCreatorObligation(params: {
  obligation: ProfitShareObligationInput;
  subscriberAgentPublicKey: string;
  subscriberEncryptedPrivateKey: Uint8Array;
}): Promise<{ outcome: SignedSubmitOutcome; signature?: string; error?: string }> {
  try {
    await requireSchemaCapabilityReady('referrals');
  } catch (error: any) {
    await storage.createPendingProfitShare({ ...params.obligation });
    return { outcome: 'rejected_before_broadcast', error: error?.message ?? String(error) };
  }
  const claim = await storage.createOrClaimPendingProfitShare(
    { ...params.obligation },
    undefined,
    ['pending'],
  );
  if (!claim.claimed || !claim.claimToken) {
    if (claim.share.status === 'paid') return { outcome: 'confirmed_success' };
    const active = await reconcileSignedSubmitAttempt('profit_share_creator', claim.share.id);
    return {
      outcome: active?.outcome === 'expired_without_status'
        ? 'confirmed_failure'
        : active?.outcome ?? (claim.share.status === 'processing' ? 'ambiguous' : 'rejected_before_broadcast'),
      error: active?.error ?? (claim.share.status === 'processing'
        ? 'A prior payout submission is awaiting on-chain resolution'
        : `Profit-share obligation is ${claim.share.status}`),
    };
  }
  const transfer = await payDurableProfitShareLeg({
    shareId: claim.share.id,
    claimToken: claim.claimToken,
    subscriberAgentPublicKey: params.subscriberAgentPublicKey,
    subscriberEncryptedPrivateKey: params.subscriberEncryptedPrivateKey,
    recipientWallet: claim.share.creatorWalletAddress,
    amountUsdc: Number(claim.share.amount),
    operationType: 'profit_share_creator',
  });
  return { outcome: transfer.outcome, signature: transfer.signature, error: transfer.error };
}

function buildReferralLegs(
  chain: readonly { ancestorWallet: string; level: number }[],
  obligation: ProfitShareObligationInput,
  fundingWallet: string,
  sourceType: string,
  sourceId: string,
): InsertReferralRewardEvent[] {
  const grossMicro = Math.round(Number(obligation.amount) * 1_000_000);
  if (grossMicro <= 0) return [];
  const seen = new Set([obligation.creatorWalletAddress]);
  const provisional: Array<{ level: 1 | 2 | 3; earnerWallet: string; amountMicro: number }> = [];
  for (const link of chain) {
    const level = link.level as 1 | 2 | 3;
    const percent = REFERRAL_LEVEL_PERCENTS[level];
    if (!percent || seen.has(link.ancestorWallet)) continue;
    const amountMicro = Math.floor((grossMicro * percent) / 100);
    if (amountMicro < MIN_PAYABLE_MICRO_USDC) continue;
    seen.add(link.ancestorWallet);
    provisional.push({ level, earnerWallet: link.ancestorWallet, amountMicro });
  }
  const totalCut = provisional.reduce((sum, leg) => sum + leg.amountMicro, 0);
  if (grossMicro - totalCut < MIN_PAYABLE_MICRO_USDC) return [];
  return provisional.map((leg) => ({
    sourceType,
    sourceId,
    earnerWallet: leg.earnerWallet,
    refereeWallet: obligation.creatorWalletAddress,
    fundingWallet,
    level: leg.level,
    amountUsdc: (leg.amountMicro / 1_000_000).toFixed(6),
    status: 'awaiting_creator',
  }));
}

async function payReleasedReferralRows(params: {
  rows: readonly ReferralRewardEvent[];
  subscriberAgentPublicKey: string;
  subscriberEncryptedPrivateKey: Uint8Array;
}): Promise<string> {
  let paid = 0;
  let pending = 0;
  for (const row of params.rows) {
    if (row.status === 'paid' || row.status === 'confirmed') {
      paid += 1;
      continue;
    }
    if (row.status === 'awaiting_creator' || row.status === 'voided') continue;
    const claimToken = await storage.claimReferralRewardEventForProcessing(row.id, ['pending', 'failed']);
    if (!claimToken) {
      pending += 1;
      continue;
    }
    const result = await payDurableReferralLeg({
      eventId: row.id,
      claimToken,
      subscriberAgentPublicKey: params.subscriberAgentPublicKey,
      subscriberEncryptedPrivateKey: params.subscriberEncryptedPrivateKey,
      recipientWallet: row.earnerWallet,
      amountUsdc: Number(row.amountUsdc),
    });
    if (result.outcome === 'confirmed_success') paid += 1;
    else pending += 1;
  }
  return `${paid} paid, ${pending} pending (of ${params.rows.length})`;
}

export async function payCreatorAndReferrals(params: {
  obligation: ProfitShareObligationInput;
  subscriberAgentPublicKey: string;
  subscriberEncryptedPrivateKey: Uint8Array;
  sourceType: string;
  sourceId: string;
  fundingWallet: string;
  allowedSourceStatuses?: readonly ('pending' | 'deferred')[];
  existingClaim?: ClaimedProfitShare;
}): Promise<{
  success: boolean;
  outcome: SignedSubmitOutcome;
  creatorAmount?: number;
  creatorSignature?: string;
  referralSummary?: string;
  error?: string;
}> {
  const allowed = params.allowedSourceStatuses ?? ['pending'];
  const pendingInput: InsertPendingProfitShare = { ...params.obligation };
  let claim: Awaited<ReturnType<typeof storage.createOrClaimPendingProfitShare>>;
  if (params.existingClaim) {
    claim = params.existingClaim;
  } else {
    try {
      await requireSchemaCapabilityReady('referrals');
    } catch (error: any) {
      await storage.createPendingProfitShare(pendingInput);
      return { success: false, outcome: 'rejected_before_broadcast', error: error?.message ?? String(error) };
    }

    const persistedShare = await storage.getProfitShareByBotAndTrade(
      params.obligation.subscriberBotId,
      params.obligation.tradeId,
    );
    let initialization: { referralLegs: InsertReferralRewardEvent[] } | undefined;
    if (!persistedShare?.referralLegsInitializedAt) {
      const existingRows = await storage.getReferralRewardEventsForSource(params.sourceType, params.sourceId);
      const chain = existingRows.length === 0
        ? await storage.getReferralChain(params.obligation.creatorWalletAddress)
        : [];
      initialization = {
        referralLegs: existingRows.length === 0
          ? buildReferralLegs(chain, params.obligation, params.fundingWallet, params.sourceType, params.sourceId)
          : [],
      };
    }
    claim = await storage.createOrClaimPendingProfitShare(pendingInput, initialization, allowed);
  }

  if (!claim.claimed || !claim.claimToken) {
    if (claim.share.status === 'paid') {
      const rows = await storage.getReferralRewardEventsForSource(params.sourceType, params.sourceId);
      const referralSummary = await payReleasedReferralRows({
        rows,
        subscriberAgentPublicKey: params.subscriberAgentPublicKey,
        subscriberEncryptedPrivateKey: params.subscriberEncryptedPrivateKey,
      });
      return { success: true, outcome: 'confirmed_success', creatorAmount: Number(claim.share.amount), referralSummary };
    }
    const activeResult = await reconcileSignedSubmitAttempt('profit_share_creator', claim.share.id);
    if (activeResult?.outcome === 'confirmed_success') {
      const rows = await storage.getReferralRewardEventsForSource(params.sourceType, params.sourceId);
      const referralSummary = await payReleasedReferralRows({
        rows,
        subscriberAgentPublicKey: params.subscriberAgentPublicKey,
        subscriberEncryptedPrivateKey: params.subscriberEncryptedPrivateKey,
      });
      return { success: true, outcome: 'confirmed_success', creatorAmount: Number(claim.share.amount), referralSummary };
    }
    return {
      success: false,
      outcome: activeResult?.outcome === 'expired_without_status'
        ? 'confirmed_failure'
        : activeResult?.outcome ?? (claim.share.status === 'processing' ? 'ambiguous' : 'rejected_before_broadcast'),
      error: activeResult?.error ?? (claim.share.status === 'processing'
        ? 'A prior payout submission is awaiting on-chain resolution'
        : `Profit-share obligation is ${claim.share.status}`),
    };
  }

  const rows = await storage.getReferralRewardEventsForSource(params.sourceType, params.sourceId);
  const totalReferral = rows.reduce((sum, row) => sum + Math.round(Number(row.amountUsdc) * 1_000_000), 0);
  const creatorAmount = (Math.round(Number(claim.share.amount) * 1_000_000) - totalReferral) / 1_000_000;
  const creator = await payDurableProfitShareLeg({
    shareId: claim.share.id,
    claimToken: claim.claimToken,
    subscriberAgentPublicKey: params.subscriberAgentPublicKey,
    subscriberEncryptedPrivateKey: params.subscriberEncryptedPrivateKey,
    recipientWallet: claim.share.creatorWalletAddress,
    amountUsdc: creatorAmount,
    operationType: 'profit_share_creator',
  });
  if (creator.outcome !== 'confirmed_success') {
    return { success: false, outcome: creator.outcome, creatorAmount, creatorSignature: creator.signature, error: creator.error };
  }

  const released = await storage.getReferralRewardEventsForSource(params.sourceType, params.sourceId);
  const referralSummary = await payReleasedReferralRows({
    rows: released,
    subscriberAgentPublicKey: params.subscriberAgentPublicKey,
    subscriberEncryptedPrivateKey: params.subscriberEncryptedPrivateKey,
  });
  return {
    success: true,
    outcome: 'confirmed_success',
    creatorAmount,
    creatorSignature: creator.signature,
    referralSummary,
  };
}

export async function settleManagementProfitShare(params: {
  share: PendingProfitShare;
  agentPublicKey: string;
  agentSecret: Uint8Array;
  allowedSourceStatuses: readonly ('pending' | 'deferred')[];
}): Promise<{ success: boolean; outcome: SignedSubmitOutcome; signature?: string; error?: string }> {
  const { share, agentPublicKey, agentSecret, allowedSourceStatuses } = params;
  await requireSchemaCapabilityReady('referrals');
  if (await storage.hasJoinedActiveSignedSubmitAttempt(share.id)) {
    return { success: false, outcome: 'ambiguous', error: 'A prior payout submission is awaiting on-chain resolution' };
  }
  const obligation: ProfitShareObligationInput = {
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
  const claim = await storage.createOrClaimPendingProfitShare(obligation, undefined, allowedSourceStatuses);
  if (!claim.claimed || !claim.claimToken) {
    if (claim.share.status === 'paid') return { success: true, outcome: 'confirmed_success' };
    const active = await reconcileSignedSubmitAttempt('profit_share_creator', claim.share.id);
    return {
      success: active?.outcome === 'confirmed_success',
      outcome: active?.outcome === 'expired_without_status'
        ? 'confirmed_failure'
        : active?.outcome ?? (claim.share.status === 'processing' ? 'ambiguous' : 'rejected_before_broadcast'),
      error: active?.error ?? (claim.share.status === 'processing'
        ? 'A prior payout submission is awaiting on-chain resolution'
        : `Profit-share obligation is ${claim.share.status}`),
    };
  }
  if (claim.share.referralLegsInitializedAt) {
    const result = await payCreatorAndReferrals({
      obligation,
      subscriberAgentPublicKey: agentPublicKey,
      subscriberEncryptedPrivateKey: agentSecret,
      sourceType: 'profit_share_paid',
      sourceId: claim.share.tradeId,
      fundingWallet: claim.share.subscriberWalletAddress,
      allowedSourceStatuses,
      existingClaim: { share: claim.share, claimed: true, claimToken: claim.claimToken },
    });
    if (result.success && await storage.hasJoinedActiveSignedSubmitAttempt(claim.share.id)) {
      return { success: false, outcome: 'ambiguous', error: 'A referral payout submission is awaiting on-chain resolution' };
    }
    return { success: result.success, outcome: result.outcome, signature: result.creatorSignature, error: result.error };
  }
  const result = await payDurableProfitShareLeg({
    shareId: claim.share.id,
    claimToken: claim.claimToken,
    subscriberAgentPublicKey: agentPublicKey,
    subscriberEncryptedPrivateKey: agentSecret,
    recipientWallet: claim.share.creatorWalletAddress,
    amountUsdc: Number(claim.share.amount),
    operationType: 'profit_share_creator',
  });
  return { success: result.outcome === 'confirmed_success', ...result };
}
