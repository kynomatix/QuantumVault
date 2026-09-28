import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const agentMocks = vi.hoisted(() => ({
  getFinalizedEpochPositionStrict: vi.fn(),
  getSignatureStatusStrict: vi.fn(),
  transferUsdcToWallet: vi.fn(),
}));
const storageMocks = vi.hoisted(() => ({
  persistCreatorSignedSubmitAttempt: vi.fn(),
  resetCreatorClaimBeforeBroadcast: vi.fn(),
  getActiveSignedSubmitAttempt: vi.fn(),
  settleSignedSubmitAttempt: vi.fn(),
  createPendingProfitShare: vi.fn(),
  getProfitShareByBotAndTrade: vi.fn(),
  getReferralRewardEventsForSource: vi.fn(),
  getReferralChain: vi.fn(),
  createOrClaimPendingProfitShare: vi.fn(),
  claimReferralRewardEventForProcessing: vi.fn(),
  getPendingProfitSharesProcessing: vi.fn(),
  getAllPendingProfitShares: vi.fn(),
  resetStaleProfitShareClaim: vi.fn(),
  voidProfitShareWithReferrals: vi.fn(),
  getTradingBotById: vi.fn(),
  getWallet: vi.fn(),
  updatePendingProfitShareStatus: vi.fn(),
  hasJoinedActiveSignedSubmitAttempt: vi.fn(),
}));
const schemaMocks = vi.hoisted(() => ({ requireSchemaCapabilityReady: vi.fn() }));
const sessionMocks = vi.hoisted(() => ({
  getUmkForWebhook: vi.fn(),
  decryptAgentKeyStrict: vi.fn(),
}));

vi.mock('../../server/agent-wallet', () => agentMocks);
vi.mock('../../server/storage', () => ({ storage: storageMocks }));
vi.mock('../../server/schema-readiness', () => schemaMocks);
vi.mock('../../server/session-v3', () => sessionMocks);
vi.mock('../../server/vault/agent-sol-withdraw', () => ({ SOL_WITHDRAW_EXPIRY_SLACK_BLOCKS: 30 }));

import {
  payDurableProfitShareLeg,
  payGrossCreatorObligation,
  payCreatorAndReferrals,
  reconcileSignedSubmitAttempt,
  resolveSignedSubmitAttempt,
  settleManagementProfitShare,
} from '../../server/profit-share-payment';
import { retryPendingProfitShares } from '../../server/profit-share-retry-job';

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    id: 'attempt-1',
    operationType: 'profit_share_creator',
    operationId: 'share-1',
    deterministicSignature: 'deterministic-signature',
    blockhash: 'blockhash',
    lastValidBlockHeight: '500',
    rpcProvider: 'configured_primary',
    status: 'confirmation_pending',
    lastError: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as any;
}

function share(overrides: Record<string, unknown> = {}) {
  return {
    id: 'share-1',
    subscriberBotId: 'bot-1',
    subscriberWalletAddress: 'subscriber',
    creatorWalletAddress: 'creator',
    amount: '10.000000',
    realizedPnl: '100.000000',
    profitSharePercent: '10.00',
    tradeId: 'trade-1',
    publishedBotId: null,
    driftSubaccountId: null,
    protocolSubaccountId: null,
    protocol: 'drift',
    status: 'pending',
    retryCount: 0,
    lastError: null,
    lastAttemptAt: null,
    referralLegsInitializedAt: null,
    processingClaimToken: null,
    processingClaimedFromStatus: null,
    createdAt: new Date(0),
    ...overrides,
  } as any;
}

function obligation() {
  const value = share();
  const { id: _id, status: _status, retryCount: _retryCount, lastError: _lastError,
    lastAttemptAt: _lastAttemptAt, referralLegsInitializedAt: _marker,
    processingClaimToken: _token, processingClaimedFromStatus: _source,
    createdAt: _createdAt, ...input } = value;
  return input as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  storageMocks.persistCreatorSignedSubmitAttempt.mockResolvedValue(true);
  storageMocks.resetCreatorClaimBeforeBroadcast.mockResolvedValue(true);
  storageMocks.settleSignedSubmitAttempt.mockResolvedValue(true);
  storageMocks.createPendingProfitShare.mockResolvedValue(share());
  storageMocks.getProfitShareByBotAndTrade.mockResolvedValue(undefined);
  storageMocks.getReferralRewardEventsForSource.mockResolvedValue([]);
  storageMocks.getReferralChain.mockResolvedValue([]);
  storageMocks.createOrClaimPendingProfitShare.mockResolvedValue({
    share: share({ status: 'processing', processingClaimToken: 'claim-1', processingClaimedFromStatus: 'pending', referralLegsInitializedAt: new Date(1) }),
    claimed: true,
    claimToken: 'claim-1',
  });
  storageMocks.claimReferralRewardEventForProcessing.mockResolvedValue(null);
  storageMocks.getPendingProfitSharesProcessing.mockResolvedValue([]);
  storageMocks.getAllPendingProfitShares.mockResolvedValue([]);
  storageMocks.resetStaleProfitShareClaim.mockResolvedValue(false);
  storageMocks.voidProfitShareWithReferrals.mockResolvedValue(false);
  storageMocks.updatePendingProfitShareStatus.mockResolvedValue(undefined);
  storageMocks.hasJoinedActiveSignedSubmitAttempt.mockResolvedValue(false);
  schemaMocks.requireSchemaCapabilityReady.mockResolvedValue(undefined);
});

describe('signed-submit resolver proof ordering', () => {
  it('does not read status until strict expiry is beyond the full slack margin', async () => {
    agentMocks.getFinalizedEpochPositionStrict.mockResolvedValue({ blockHeight: 490, contextSlot: 100 });
    agentMocks.getSignatureStatusStrict.mockResolvedValue({
      contextSlot: 101,
      status: { err: null, confirmationStatus: 'confirmed' },
    });
    await expect(resolveSignedSubmitAttempt(attempt())).resolves.toEqual({ outcome: 'ambiguous' });
    expect(agentMocks.getSignatureStatusStrict).not.toHaveBeenCalled();
  });

  it('accepts terminal success only from a non-regressed view after strict expiry', async () => {
    agentMocks.getFinalizedEpochPositionStrict.mockResolvedValue({ blockHeight: 531, contextSlot: 100 });
    agentMocks.getSignatureStatusStrict.mockResolvedValue({
      contextSlot: 101,
      status: { err: null, confirmationStatus: 'confirmed' },
    });
    await expect(resolveSignedSubmitAttempt(attempt())).resolves.toEqual({ outcome: 'confirmed_success' });
  });

  it('classifies an explicit on-chain error as confirmed failure after strict expiry', async () => {
    agentMocks.getFinalizedEpochPositionStrict.mockResolvedValue({ blockHeight: 531, contextSlot: 100 });
    agentMocks.getSignatureStatusStrict.mockResolvedValue({
      contextSlot: 100,
      status: { err: { InstructionError: [0, 'custom'] }, confirmationStatus: 'confirmed' },
    });
    await expect(resolveSignedSubmitAttempt(attempt())).resolves.toMatchObject({ outcome: 'confirmed_failure' });
  });

  it('keeps processed, malformed, and unreadable observations ambiguous', async () => {
    agentMocks.getFinalizedEpochPositionStrict.mockResolvedValue({ blockHeight: 531, contextSlot: 100 });
    agentMocks.getSignatureStatusStrict.mockResolvedValue({
      contextSlot: 100,
      status: { err: null, confirmationStatus: 'processed' },
    });
    await expect(resolveSignedSubmitAttempt(attempt())).resolves.toEqual({ outcome: 'ambiguous' });

    await expect(resolveSignedSubmitAttempt(attempt({ lastValidBlockHeight: 'not-a-height' }))).resolves.toMatchObject({
      outcome: 'ambiguous',
      error: 'Stored last-valid block height is malformed',
    });

    agentMocks.getFinalizedEpochPositionStrict.mockRejectedValueOnce(new Error('configured primary unavailable'));
    await expect(resolveSignedSubmitAttempt(attempt())).resolves.toEqual({
      outcome: 'ambiguous',
      error: 'configured primary unavailable',
    });
  });

  it('requires both strict expiry and a later primary status absence before declaring expiry', async () => {
    agentMocks.getFinalizedEpochPositionStrict.mockResolvedValue({ blockHeight: 531, contextSlot: 100 });
    agentMocks.getSignatureStatusStrict.mockResolvedValue({ contextSlot: 101, status: null });
    await expect(resolveSignedSubmitAttempt(attempt())).resolves.toMatchObject({ outcome: 'expired_without_status' });
  });

  it('keeps an absence ambiguous inside the slack window or from a stale status context', async () => {
    agentMocks.getFinalizedEpochPositionStrict.mockResolvedValue({ blockHeight: 530, contextSlot: 100 });
    agentMocks.getSignatureStatusStrict.mockResolvedValue({ contextSlot: 101, status: null });
    await expect(resolveSignedSubmitAttempt(attempt())).resolves.toEqual({ outcome: 'ambiguous' });
    expect(agentMocks.getSignatureStatusStrict).not.toHaveBeenCalled();

    agentMocks.getSignatureStatusStrict.mockClear();
    agentMocks.getFinalizedEpochPositionStrict.mockResolvedValue({ blockHeight: 900, contextSlot: 200 });
    agentMocks.getSignatureStatusStrict.mockResolvedValue({ contextSlot: 199, status: null });
    await expect(resolveSignedSubmitAttempt(attempt())).resolves.toEqual({ outcome: 'ambiguous' });
  });
});

describe('creator payout ambiguity durability', () => {
  it('records the deterministic attempt before an ambiguous send and does not release the claim', async () => {
    agentMocks.transferUsdcToWallet.mockImplementation(async (_from: string, _key: Uint8Array, _to: string, _amount: number, before: Function) => {
      await before({
        signature: 'sig-1',
        blockhash: 'hash-1',
        lastValidBlockHeight: 700,
        rpcProvider: 'configured_primary',
      });
      return { success: false, outcome: 'ambiguous', signature: 'sig-1', error: 'transport dropped' };
    });

    const result = await payDurableProfitShareLeg({
      shareId: 'share-1',
      claimToken: 'claim-1',
      subscriberAgentPublicKey: 'agent',
      subscriberEncryptedPrivateKey: new Uint8Array([1]),
      recipientWallet: 'creator',
      amountUsdc: 1,
      operationType: 'profit_share_creator',
    });

    expect(storageMocks.persistCreatorSignedSubmitAttempt).toHaveBeenCalledWith('share-1', 'claim-1', {
      operationType: 'profit_share_creator',
      operationId: 'share-1',
      deterministicSignature: 'sig-1',
      blockhash: 'hash-1',
      lastValidBlockHeight: 700,
      rpcProvider: 'configured_primary',
    });
    expect(result).toMatchObject({ outcome: 'ambiguous', signature: 'sig-1' });
    expect(storageMocks.resetCreatorClaimBeforeBroadcast).not.toHaveBeenCalled();
    expect(storageMocks.settleSignedSubmitAttempt).not.toHaveBeenCalled();
  });

  it('releases only the exact claim token after a proven pre-broadcast rejection', async () => {
    agentMocks.transferUsdcToWallet.mockResolvedValue({
      success: false,
      outcome: 'rejected_before_broadcast',
      error: 'insufficient gas',
    });
    await payDurableProfitShareLeg({
      shareId: 'share-1',
      claimToken: 'claim-1',
      subscriberAgentPublicKey: 'agent',
      subscriberEncryptedPrivateKey: new Uint8Array([1]),
      recipientWallet: 'creator',
      amountUsdc: 1,
      operationType: 'profit_share_creator',
    });
    expect(storageMocks.resetCreatorClaimBeforeBroadcast).toHaveBeenCalledWith('share-1', 'claim-1', 'insufficient gas');
  });

  it('does not reset or spend retry budget when attempt persistence loses to another active signer', async () => {
    storageMocks.persistCreatorSignedSubmitAttempt.mockResolvedValue(false);
    agentMocks.transferUsdcToWallet.mockImplementation(async (_from: string, _key: Uint8Array, _to: string, _amount: number, before: Function) => {
      try {
        await before({ signature: 'losing-sig', blockhash: 'hash', lastValidBlockHeight: 500, rpcProvider: 'configured_primary' });
      } catch (error: any) {
        return { success: false, outcome: 'rejected_before_broadcast', error: error.message };
      }
      throw new Error('unexpected persistence success');
    });
    await expect(payDurableProfitShareLeg({
      shareId: 'share-1', claimToken: 'losing-claim', subscriberAgentPublicKey: 'agent',
      subscriberEncryptedPrivateKey: new Uint8Array([1]), recipientWallet: 'creator', amountUsdc: 10,
      operationType: 'profit_share_creator',
    })).resolves.toMatchObject({ outcome: 'rejected_before_broadcast', error: 'Creator payout claim was lost before broadcast' });
    expect(storageMocks.resetCreatorClaimBeforeBroadcast).not.toHaveBeenCalled();
    expect(storageMocks.settleSignedSubmitAttempt).not.toHaveBeenCalled();
  });

  it('keeps the original signature bound through a simulated restart and never sends again before strict expiry', async () => {
    agentMocks.transferUsdcToWallet.mockImplementationOnce(async (_from: string, _key: Uint8Array, _to: string, _amount: number, before: Function) => {
      await before({ signature: 'restart-sig', blockhash: 'restart-hash', lastValidBlockHeight: 500, rpcProvider: 'configured_primary' });
      return { success: false, outcome: 'ambiguous', signature: 'restart-sig', error: 'process exited after send' };
    });
    await payDurableProfitShareLeg({
      shareId: 'share-1', claimToken: 'claim-1', subscriberAgentPublicKey: 'agent',
      subscriberEncryptedPrivateKey: new Uint8Array([1]), recipientWallet: 'creator', amountUsdc: 10,
      operationType: 'profit_share_creator',
    });

    const durableAttempt = attempt({ deterministicSignature: 'restart-sig', blockhash: 'restart-hash' });
    storageMocks.createOrClaimPendingProfitShare.mockResolvedValue({
      share: share({ status: 'processing', processingClaimToken: 'claim-1', lastAttemptAt: new Date() }),
      claimed: false,
      claimToken: null,
    });
    storageMocks.getActiveSignedSubmitAttempt.mockResolvedValue(durableAttempt);
    agentMocks.getFinalizedEpochPositionStrict.mockResolvedValue({ blockHeight: 530, contextSlot: 100 });

    await expect(payCreatorAndReferrals({
      obligation: obligation(), subscriberAgentPublicKey: 'agent', subscriberEncryptedPrivateKey: new Uint8Array([1]),
      sourceType: 'profit_share_paid', sourceId: 'trade-1', fundingWallet: 'subscriber',
    })).resolves.toMatchObject({ outcome: 'ambiguous' });
    expect(agentMocks.transferUsdcToWallet).toHaveBeenCalledTimes(1);
    expect(storageMocks.settleSignedSubmitAttempt).not.toHaveBeenCalled();

    agentMocks.getFinalizedEpochPositionStrict.mockResolvedValue({ blockHeight: 531, contextSlot: 100 });
    agentMocks.getSignatureStatusStrict.mockResolvedValue({ contextSlot: 101, status: null });
    await reconcileSignedSubmitAttempt('profit_share_creator', 'share-1');
    expect(storageMocks.settleSignedSubmitAttempt).toHaveBeenCalledTimes(1);
    expect(storageMocks.settleSignedSubmitAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ deterministicSignature: 'restart-sig' }),
      'expired_without_status',
      expect.any(String),
    );
    expect(agentMocks.transferUsdcToWallet).toHaveBeenCalledTimes(1);
  });

  it('leaves only a pending obligation when schema capability is unavailable, before claim or signing', async () => {
    schemaMocks.requireSchemaCapabilityReady.mockRejectedValueOnce(new Error('referrals schema unavailable'));
    await expect(payCreatorAndReferrals({
      obligation: obligation(), subscriberAgentPublicKey: 'agent', subscriberEncryptedPrivateKey: new Uint8Array([1]),
      sourceType: 'profit_share_paid', sourceId: 'trade-1', fundingWallet: 'subscriber',
    })).resolves.toMatchObject({ outcome: 'rejected_before_broadcast', error: 'referrals schema unavailable' });
    expect(storageMocks.createPendingProfitShare).toHaveBeenCalledTimes(1);
    expect(storageMocks.createOrClaimPendingProfitShare).not.toHaveBeenCalled();
    expect(agentMocks.transferUsdcToWallet).not.toHaveBeenCalled();
  });

  it('uses only the persisted referral set and amount after initialization, even if the live chain changes', async () => {
    const marked = share({ status: 'processing', referralLegsInitializedAt: new Date(1), processingClaimToken: 'claim-2' });
    const persistedLeg = { id: 'leg-1', status: 'awaiting_creator', amountUsdc: '0.500000', earnerWallet: 'old-earner', level: 1 };
    storageMocks.getProfitShareByBotAndTrade.mockResolvedValue(marked);
    storageMocks.getReferralRewardEventsForSource.mockResolvedValue([persistedLeg]);
    storageMocks.getReferralChain.mockResolvedValue([{ ancestorWallet: 'new-earner', level: 1 }]);
    storageMocks.createOrClaimPendingProfitShare.mockResolvedValue({ share: marked, claimed: true, claimToken: 'claim-2' });
    agentMocks.transferUsdcToWallet.mockImplementation(async (_from: string, _key: Uint8Array, _to: string, _amount: number, before: Function) => {
      await before({ signature: 'paid-sig', blockhash: 'hash', lastValidBlockHeight: 500, rpcProvider: 'configured_primary' });
      return { success: true, outcome: 'confirmed_success', signature: 'paid-sig' };
    });

    const result = await payCreatorAndReferrals({
      obligation: obligation(), subscriberAgentPublicKey: 'agent', subscriberEncryptedPrivateKey: new Uint8Array([1]),
      sourceType: 'profit_share_paid', sourceId: 'trade-1', fundingWallet: 'subscriber',
    });
    expect(result.creatorAmount).toBe(9.5);
    expect(agentMocks.transferUsdcToWallet.mock.calls[0][3]).toBe(9.5);
    expect(storageMocks.getReferralChain).not.toHaveBeenCalled();
    expect(storageMocks.createOrClaimPendingProfitShare.mock.calls[0][1]).toBeUndefined();
    expect(storageMocks.claimReferralRewardEventForProcessing).not.toHaveBeenCalled();
  });

  it('settles an already-owned management claim without re-claiming or recomputing its persisted split', async () => {
    const claimed = share({ status: 'processing', referralLegsInitializedAt: new Date(1), processingClaimToken: 'management-claim' });
    storageMocks.getReferralRewardEventsForSource.mockResolvedValue([
      { id: 'leg-1', status: 'awaiting_creator', amountUsdc: '0.800000', earnerWallet: 'earner', level: 1 },
    ]);
    agentMocks.transferUsdcToWallet.mockResolvedValue({ success: false, outcome: 'ambiguous', signature: 'management-sig' });
    const result = await payCreatorAndReferrals({
      obligation: obligation(), subscriberAgentPublicKey: 'agent', subscriberEncryptedPrivateKey: new Uint8Array([1]),
      sourceType: 'profit_share_paid', sourceId: 'trade-1', fundingWallet: 'subscriber',
      existingClaim: { share: claimed, claimed: true, claimToken: 'management-claim' },
    });
    expect(result.creatorAmount).toBe(9.2);
    expect(storageMocks.createOrClaimPendingProfitShare).not.toHaveBeenCalled();
    expect(storageMocks.getReferralChain).not.toHaveBeenCalled();
    expect(agentMocks.transferUsdcToWallet.mock.calls[0][3]).toBe(9.2);
  });

  it('management claims first and obeys the marker on the claimed row rather than a stale route snapshot', async () => {
    const staleListed = share({ referralLegsInitializedAt: null });
    const claimedMarked = share({
      status: 'processing', referralLegsInitializedAt: new Date(2),
      processingClaimToken: 'management-claim', processingClaimedFromStatus: 'pending',
    });
    storageMocks.createOrClaimPendingProfitShare.mockResolvedValue({
      share: claimedMarked, claimed: true, claimToken: 'management-claim',
    });
    storageMocks.getReferralRewardEventsForSource.mockResolvedValue([
      { id: 'persisted-leg', status: 'awaiting_creator', amountUsdc: '0.500000', earnerWallet: 'earner', level: 1 },
    ]);
    agentMocks.transferUsdcToWallet.mockResolvedValue({ success: false, outcome: 'ambiguous', signature: 'management-sig' });

    const result = await settleManagementProfitShare({
      share: staleListed, agentPublicKey: 'agent', agentSecret: new Uint8Array([1]), allowedSourceStatuses: ['pending'],
    });
    expect(result.outcome).toBe('ambiguous');
    expect(agentMocks.transferUsdcToWallet.mock.calls[0][3]).toBe(9.5);
    expect(storageMocks.getReferralChain).not.toHaveBeenCalled();
  });

  it('management pays an uninitialized obligation gross and creates no referral leg', async () => {
    const unmarkedClaim = share({ status: 'processing', processingClaimToken: 'gross-claim', processingClaimedFromStatus: 'pending' });
    storageMocks.createOrClaimPendingProfitShare.mockResolvedValue({ share: unmarkedClaim, claimed: true, claimToken: 'gross-claim' });
    agentMocks.transferUsdcToWallet.mockResolvedValue({ success: false, outcome: 'ambiguous', signature: 'gross-sig' });
    await settleManagementProfitShare({
      share: share(), agentPublicKey: 'agent', agentSecret: new Uint8Array([1]), allowedSourceStatuses: ['pending'],
    });
    expect(agentMocks.transferUsdcToWallet.mock.calls[0][3]).toBe(10);
    expect(storageMocks.getReferralRewardEventsForSource).not.toHaveBeenCalled();
    expect(storageMocks.getReferralChain).not.toHaveBeenCalled();
  });

  it('parks every management exit while any joined creator or referral attempt is active', async () => {
    storageMocks.hasJoinedActiveSignedSubmitAttempt.mockResolvedValue(true);
    await expect(settleManagementProfitShare({
      share: share(), agentPublicKey: 'agent', agentSecret: new Uint8Array([1]), allowedSourceStatuses: ['pending'],
    })).resolves.toEqual({
      success: false, outcome: 'ambiguous', error: 'A prior payout submission is awaiting on-chain resolution',
    });
    expect(storageMocks.createOrClaimPendingProfitShare).not.toHaveBeenCalled();
    expect(agentMocks.transferUsdcToWallet).not.toHaveBeenCalled();
  });

  it('does not report management settlement success while a referral attempt remains active', async () => {
    storageMocks.hasJoinedActiveSignedSubmitAttempt
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    storageMocks.getReferralRewardEventsForSource.mockResolvedValue([
      { id: 'leg-1', status: 'pending', amountUsdc: '0.500000', earnerWallet: 'earner', level: 1 },
    ]);
    agentMocks.transferUsdcToWallet.mockResolvedValue({
      success: true, outcome: 'confirmed_success', signature: 'creator-paid',
    });

    await expect(settleManagementProfitShare({
      share: share(), agentPublicKey: 'agent', agentSecret: new Uint8Array([1]), allowedSourceStatuses: ['pending'],
    })).resolves.toEqual({
      success: false,
      outcome: 'ambiguous',
      error: 'A referral payout submission is awaiting on-chain resolution',
    });
    expect(storageMocks.hasJoinedActiveSignedSubmitAttempt).toHaveBeenCalledTimes(2);
  });

  it('uses unsubscribe authority to claim deferred and preserves the exact claim on pre-broadcast failure', async () => {
    const deferredClaim = share({
      status: 'processing', processingClaimToken: 'deferred-claim', processingClaimedFromStatus: 'deferred',
    });
    storageMocks.createOrClaimPendingProfitShare.mockResolvedValue({ share: deferredClaim, claimed: true, claimToken: 'deferred-claim' });
    agentMocks.transferUsdcToWallet.mockResolvedValue({
      success: false, outcome: 'rejected_before_broadcast', error: 'insufficient gas',
    });
    await settleManagementProfitShare({
      share: share({ status: 'deferred' }), agentPublicKey: 'agent', agentSecret: new Uint8Array([1]),
      allowedSourceStatuses: ['pending', 'deferred'],
    });
    expect(storageMocks.createOrClaimPendingProfitShare).toHaveBeenCalledWith(
      expect.objectContaining({ tradeId: 'trade-1' }), undefined, ['pending', 'deferred'],
    );
    expect(storageMocks.resetCreatorClaimBeforeBroadcast).toHaveBeenCalledWith(
      'share-1', 'deferred-claim', 'insufficient gas',
    );
  });

  it.each([
    ['confirmed_failure', { contextSlot: 101, status: { err: { Custom: 1 }, confirmationStatus: 'confirmed' } }],
    ['expired_without_status', { contextSlot: 101, status: null }],
  ] as const)('reconciles deferred management %s without sending again', async (expected, statusObservation) => {
    const deferredProcessing = share({
      status: 'processing', processingClaimToken: 'deferred-claim', processingClaimedFromStatus: 'deferred',
    });
    storageMocks.createOrClaimPendingProfitShare.mockResolvedValue({ share: deferredProcessing, claimed: false, claimToken: null });
    storageMocks.getActiveSignedSubmitAttempt.mockResolvedValue(attempt());
    agentMocks.getFinalizedEpochPositionStrict.mockResolvedValue({ blockHeight: 531, contextSlot: 100 });
    agentMocks.getSignatureStatusStrict.mockResolvedValue(statusObservation);
    const result = await settleManagementProfitShare({
      share: share({ status: 'deferred' }), agentPublicKey: 'agent', agentSecret: new Uint8Array([1]),
      allowedSourceStatuses: ['pending', 'deferred'],
    });
    expect(result.outcome).toBe('confirmed_failure');
    expect(storageMocks.settleSignedSubmitAttempt).toHaveBeenCalledWith(
      expect.anything(), expected, expect.any(String),
    );
    expect(agentMocks.transferUsdcToWallet).not.toHaveBeenCalled();
  });

  it('treats a lost claim on an existing processing row as in-flight without send or retry mutation', async () => {
    storageMocks.createOrClaimPendingProfitShare.mockResolvedValue({
      share: share({ status: 'processing', processingClaimToken: 'other-claim' }), claimed: false, claimToken: null,
    });
    storageMocks.getActiveSignedSubmitAttempt.mockResolvedValue(undefined);
    await expect(payCreatorAndReferrals({
      obligation: obligation(), subscriberAgentPublicKey: 'agent', subscriberEncryptedPrivateKey: new Uint8Array([1]),
      sourceType: 'profit_share_paid', sourceId: 'trade-1', fundingWallet: 'subscriber',
    })).resolves.toMatchObject({ outcome: 'ambiguous', error: 'A prior payout submission is awaiting on-chain resolution' });
    expect(agentMocks.transferUsdcToWallet).not.toHaveBeenCalled();
    expect(storageMocks.createPendingProfitShare).not.toHaveBeenCalled();
    expect(storageMocks.updatePendingProfitShareStatus).not.toHaveBeenCalled();
  });

  it('gives concurrent trade-retry callers one signer, keeps gross economics, and creates no second IOU after ambiguity', async () => {
    const processing = share({ status: 'processing', processingClaimToken: 'trade-claim' });
    storageMocks.createOrClaimPendingProfitShare
      .mockResolvedValueOnce({ share: processing, claimed: true, claimToken: 'trade-claim' })
      .mockResolvedValueOnce({ share: processing, claimed: false, claimToken: null });
    agentMocks.transferUsdcToWallet.mockImplementationOnce(async (_from: string, _key: Uint8Array, _to: string, amount: number, before: Function) => {
      expect(amount).toBe(10);
      await before({ signature: 'trade-retry-sig', blockhash: 'hash', lastValidBlockHeight: 700, rpcProvider: 'configured_primary' });
      return { success: false, outcome: 'ambiguous', signature: 'trade-retry-sig', error: 'confirmation timeout' };
    });
    storageMocks.getActiveSignedSubmitAttempt.mockResolvedValue(attempt({ deterministicSignature: 'trade-retry-sig', lastValidBlockHeight: '700' }));
    agentMocks.getFinalizedEpochPositionStrict.mockResolvedValue({ blockHeight: 700, contextSlot: 10 });

    const results = await Promise.all([
      payGrossCreatorObligation({
        obligation: obligation(), subscriberAgentPublicKey: 'agent', subscriberEncryptedPrivateKey: new Uint8Array([1]),
      }),
      payGrossCreatorObligation({
        obligation: obligation(), subscriberAgentPublicKey: 'agent', subscriberEncryptedPrivateKey: new Uint8Array([1]),
      }),
    ]);
    expect(results).toEqual([
      expect.objectContaining({ outcome: 'ambiguous', signature: 'trade-retry-sig' }),
      expect.objectContaining({ outcome: 'ambiguous' }),
    ]);

    expect(agentMocks.transferUsdcToWallet).toHaveBeenCalledTimes(1);
    expect(storageMocks.createPendingProfitShare).not.toHaveBeenCalled();
    expect(storageMocks.createOrClaimPendingProfitShare).toHaveBeenNthCalledWith(
      1, expect.objectContaining({ amount: '10.000000' }), undefined, ['pending'],
    );
  });

  it('settles one terminal observation once and leaves repeated reconciliation idempotent', async () => {
    const active = attempt();
    storageMocks.getActiveSignedSubmitAttempt.mockResolvedValueOnce(active).mockResolvedValueOnce(undefined);
    agentMocks.getFinalizedEpochPositionStrict.mockResolvedValue({ blockHeight: 531, contextSlot: 100 });
    agentMocks.getSignatureStatusStrict.mockResolvedValue({ contextSlot: 100, status: { err: { Custom: 1 }, confirmationStatus: 'confirmed' } });
    await reconcileSignedSubmitAttempt('profit_share_creator', 'share-1');
    await reconcileSignedSubmitAttempt('profit_share_creator', 'share-1');
    expect(storageMocks.settleSignedSubmitAttempt).toHaveBeenCalledTimes(1);
  });

  it('restores a pre-callback processing crash once by claim age and uses createdAt for legacy null timestamps', async () => {
    const legacyCrash = share({
      status: 'processing', processingClaimToken: 'orphaned-claim', processingClaimedFromStatus: 'pending',
      lastAttemptAt: null, createdAt: new Date(Date.now() - 20 * 60_000),
    });
    storageMocks.getPendingProfitSharesProcessing
      .mockResolvedValueOnce([legacyCrash])
      .mockResolvedValueOnce([]);
    storageMocks.getActiveSignedSubmitAttempt.mockResolvedValue(undefined);
    storageMocks.resetStaleProfitShareClaim.mockResolvedValue(true);
    storageMocks.getAllPendingProfitShares.mockResolvedValue([]);
    await retryPendingProfitShares();
    await retryPendingProfitShares();
    expect(storageMocks.resetStaleProfitShareClaim).toHaveBeenCalledTimes(1);
    expect(storageMocks.resetStaleProfitShareClaim).toHaveBeenCalledWith('share-1', expect.any(Date));
    expect(agentMocks.transferUsdcToWallet).not.toHaveBeenCalled();
  });

  it('preserves auth/key/decryption retry budget but increments a genuinely missing bot', async () => {
    storageMocks.getAllPendingProfitShares.mockResolvedValue([share({ retryCount: 4, createdAt: new Date() })]);
    storageMocks.getTradingBotById.mockResolvedValue(undefined);
    await retryPendingProfitShares();
    expect(storageMocks.updatePendingProfitShareStatus).toHaveBeenCalledWith('share-1', expect.objectContaining({
      retryCount: 5,
      lastError: 'Subscriber bot not found',
    }));
    expect(storageMocks.createOrClaimPendingProfitShare).not.toHaveBeenCalled();

    vi.clearAllMocks();
    storageMocks.getPendingProfitSharesProcessing.mockResolvedValue([]);
    storageMocks.getAllPendingProfitShares.mockResolvedValue([share({ retryCount: 4, createdAt: new Date() })]);
    storageMocks.getTradingBotById.mockResolvedValue({ id: 'bot-1', walletAddress: 'subscriber' });
    storageMocks.getWallet.mockResolvedValue(undefined);
    await retryPendingProfitShares();
    expect(storageMocks.updatePendingProfitShareStatus).toHaveBeenCalledWith('share-1', {
      lastError: 'Subscriber agent authorization unavailable (paused, retry budget preserved)',
    });
    expect(storageMocks.createOrClaimPendingProfitShare).not.toHaveBeenCalled();
  });

  it.each(['wallet', 'umk', 'decrypt'] as const)('checks %s availability before a creator claim and preserves retry budget', async (unavailable) => {
    storageMocks.getPendingProfitSharesProcessing.mockResolvedValue([]);
    storageMocks.getAllPendingProfitShares.mockResolvedValue([share({ retryCount: 4, createdAt: new Date() })]);
    storageMocks.getTradingBotById.mockResolvedValue({ id: 'bot-1', walletAddress: 'subscriber' });
    storageMocks.getWallet.mockResolvedValue(unavailable === 'wallet'
      ? undefined
      : { agentPublicKey: 'agent', agentPrivateKeyEncryptedV3: 'cipher' });
    sessionMocks.getUmkForWebhook.mockResolvedValue(unavailable === 'umk'
      ? undefined
      : { umk: new Uint8Array([1]), cleanup: vi.fn() });
    sessionMocks.decryptAgentKeyStrict.mockResolvedValue(unavailable === 'decrypt'
      ? undefined
      : { secretKey: new Uint8Array([1]), cleanup: vi.fn() });
    await retryPendingProfitShares();
    expect(storageMocks.createOrClaimPendingProfitShare).not.toHaveBeenCalled();
    expect(agentMocks.transferUsdcToWallet).not.toHaveBeenCalled();
    const patch = storageMocks.updatePendingProfitShareStatus.mock.calls.at(-1)?.[1];
    expect(patch?.retryCount).toBeUndefined();
    expect(patch?.lastError).toContain('retry budget preserved');
  });

  it('pins the database-side admission and terminal transitions to compare-and-set predicates', () => {
    const storageSource = readFileSync(new URL('../../server/storage.ts', import.meta.url), 'utf8');
    expect(storageSource).toContain("values({ ...data, status: 'deferred' })");
    expect(storageSource).toContain("eq(pendingProfitShares.status, 'pending')");
    expect(storageSource).toContain("if (!allowedSourceStatuses.includes(share.status as 'pending' | 'deferred'))");
    expect(storageSource).toContain("eq(pendingProfitShares.processingClaimToken, claimToken)");
    expect(storageSource).toContain("a.status='confirmation_pending'");
    expect(storageSource).toContain("inArray(pendingProfitShares.status, ['pending', 'processing'])");
    expect(storageSource).toContain('if (paid[0]?.referralLegsInitializedAt)');
    expect(storageSource).toContain("status: 'pending', releasedAt: now");
    expect(storageSource).not.toContain("status: 'pending', releasedAt: now, createdAt:");
    expect(storageSource).toContain("status: sql`COALESCE(${pendingProfitShares.processingClaimedFromStatus}, 'pending')`");
    expect(storageSource).toContain('retryCount: sql`${pendingProfitShares.retryCount} + 1`');
    expect(storageSource).toContain('retryCount: sql`${referralRewardEvents.retryCount} + 1`');
    expect(storageSource).toContain("inArray(referralRewardEvents.status, ['pending', 'failed'])");
    expect(storageSource).toContain("processingClaimedFromStatus: sql`${referralRewardEvents.status}`");
    expect(storageSource).toContain("status: sql`COALESCE(${referralRewardEvents.processingClaimedFromStatus}, 'pending')`");
    expect(storageSource).toContain("target: [pendingProfitShares.subscriberBotId, pendingProfitShares.tradeId]");
    expect(storageSource).toContain("if (await this.hasBotJoinedActiveSignedSubmitAttempt(id))");
    expect(storageSource).toContain("a.operation_type='referral_reward'");
    expect(storageSource).toContain("eq(solanaSignedSubmitAttempts.operationType, 'profit_share_creator')");
    expect(storageSource).toContain("eq(solanaSignedSubmitAttempts.operationType, 'referral_reward')");
    expect(storageSource).toContain("lt(sql`COALESCE(${pendingProfitShares.lastAttemptAt}, ${pendingProfitShares.createdAt})`, staleBefore)");
  });

  it('keeps ordinary deletion pending-only while unsubscribe alone may claim deferred obligations', () => {
    const routeSource = readFileSync(new URL('../../server/routes.ts', import.meta.url), 'utf8');
    expect(routeSource.match(/getPendingProfitSharesByBot\(req\.params\.id\)/g)).toHaveLength(2);
    expect(routeSource.match(/await settleManagementProfitShare\(/g)).toHaveLength(4);
    expect(routeSource.match(/allowedSourceStatuses: \['pending'\]/g)).toHaveLength(3);
    expect(routeSource.match(/allowedSourceStatuses: \['pending', 'deferred'\]/g)).toHaveLength(1);
    expect(routeSource).toContain('const owedIOUs = await storage.getUnsettledProfitSharesByBot(bot.id)');
    expect(routeSource.match(/await storage\.hasBotJoinedActiveSignedSubmitAttempt\(/g)).toHaveLength(4);
  });

  it('initializes an unmarked Model A row in the atomic create-or-claim input', async () => {
    storageMocks.getProfitShareByBotAndTrade.mockResolvedValue(share());
    storageMocks.getReferralChain.mockResolvedValue([{ ancestorWallet: 'earner', level: 1 }]);
    agentMocks.transferUsdcToWallet.mockResolvedValue({ success: false, outcome: 'ambiguous', signature: 'sig' });
    await payCreatorAndReferrals({
      obligation: obligation(), subscriberAgentPublicKey: 'agent', subscriberEncryptedPrivateKey: new Uint8Array([1]),
      sourceType: 'profit_share_paid', sourceId: 'trade-1', fundingWallet: 'subscriber',
    });
    expect(storageMocks.createOrClaimPendingProfitShare).toHaveBeenCalledWith(
      expect.objectContaining({ tradeId: 'trade-1' }),
      { referralLegs: [expect.objectContaining({ earnerWallet: 'earner', amountUsdc: '0.500000', status: 'awaiting_creator' })] },
      ['pending'],
    );
  });
});
