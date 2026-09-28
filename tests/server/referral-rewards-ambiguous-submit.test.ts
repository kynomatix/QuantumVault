import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const agentMocks = vi.hoisted(() => ({
  getFinalizedEpochPositionStrict: vi.fn(),
  getSignatureStatusStrict: vi.fn(),
  transferUsdcToWallet: vi.fn(),
}));
const storageMocks = vi.hoisted(() => ({
  persistReferralSignedSubmitAttempt: vi.fn(),
  resetReferralClaimBeforeBroadcast: vi.fn(),
  getActiveSignedSubmitAttempt: vi.fn(),
  settleSignedSubmitAttempt: vi.fn(),
  getProcessingReferralRewardEvents: vi.fn(),
  getPendingReferralRewardEvents: vi.fn(),
  resetStaleReferralClaim: vi.fn(),
  voidReferralRewardEvent: vi.fn(),
  getWallet: vi.fn(),
  updateReferralRewardEventStatus: vi.fn(),
  claimReferralRewardEventForProcessing: vi.fn(),
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

import { payDurableReferralLeg, reconcileSignedSubmitAttempt } from '../../server/profit-share-payment';
import { retryPendingReferralRewards } from '../../server/referral-rewards-retry-job';

function reward(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-1', sourceType: 'profit_share_paid', sourceId: 'trade-1',
    earnerWallet: 'earner', refereeWallet: 'creator', fundingWallet: 'subscriber',
    level: 1, amountUsdc: '0.500000', status: 'pending', transferSignature: null,
    retryCount: 0, lastError: null, lastAttemptAt: null, processingClaimToken: null,
    processingClaimedFromStatus: null,
    releasedAt: new Date(), createdAt: new Date(0), ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  storageMocks.persistReferralSignedSubmitAttempt.mockResolvedValue(true);
  storageMocks.resetReferralClaimBeforeBroadcast.mockResolvedValue(true);
  storageMocks.settleSignedSubmitAttempt.mockResolvedValue(true);
  storageMocks.getProcessingReferralRewardEvents.mockResolvedValue([]);
  storageMocks.getPendingReferralRewardEvents.mockResolvedValue([]);
  storageMocks.resetStaleReferralClaim.mockResolvedValue(false);
  storageMocks.voidReferralRewardEvent.mockResolvedValue(true);
  storageMocks.claimReferralRewardEventForProcessing.mockResolvedValue('claim-1');
  schemaMocks.requireSchemaCapabilityReady.mockResolvedValue(undefined);
});

describe('referral payout ambiguity durability', () => {
  it('keeps an ambiguous signed attempt in flight instead of permitting a second send', async () => {
    agentMocks.transferUsdcToWallet.mockImplementation(async (_from: string, _key: Uint8Array, _to: string, _amount: number, before: Function) => {
      await before({
        signature: 'referral-sig',
        blockhash: 'referral-hash',
        lastValidBlockHeight: 900,
        rpcProvider: 'configured_primary',
      });
      return { success: false, outcome: 'ambiguous', signature: 'referral-sig', error: 'confirmation timeout' };
    });

    const result = await payDurableReferralLeg({
      eventId: 'event-1',
      claimToken: 'claim-1',
      subscriberAgentPublicKey: 'agent',
      subscriberEncryptedPrivateKey: new Uint8Array([1]),
      recipientWallet: 'earner',
      amountUsdc: 0.5,
    });

    expect(storageMocks.persistReferralSignedSubmitAttempt).toHaveBeenCalledWith('event-1', 'claim-1', {
      operationType: 'referral_reward',
      operationId: 'event-1',
      deterministicSignature: 'referral-sig',
      blockhash: 'referral-hash',
      lastValidBlockHeight: 900,
      rpcProvider: 'configured_primary',
    });
    expect(result).toMatchObject({ outcome: 'ambiguous', signature: 'referral-sig' });
    expect(storageMocks.resetReferralClaimBeforeBroadcast).not.toHaveBeenCalled();
    expect(storageMocks.settleSignedSubmitAttempt).not.toHaveBeenCalled();
  });

  it('does not terminalize a prior attempt when primary evidence remains unreadable', async () => {
    const active = {
      id: 'attempt-1',
      operationType: 'referral_reward',
      operationId: 'event-1',
      deterministicSignature: 'referral-sig',
      blockhash: 'referral-hash',
      lastValidBlockHeight: '900',
      rpcProvider: 'configured_primary',
      status: 'confirmation_pending',
      lastError: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    storageMocks.getActiveSignedSubmitAttempt.mockResolvedValue(active);
    agentMocks.getFinalizedEpochPositionStrict.mockRejectedValue(new Error('primary RPC unavailable'));

    await expect(reconcileSignedSubmitAttempt('referral_reward', 'event-1')).resolves.toMatchObject({
      outcome: 'ambiguous',
      error: 'primary RPC unavailable',
    });
    expect(storageMocks.settleSignedSubmitAttempt).not.toHaveBeenCalled();
  });

  it('returns a pre-broadcast rejection to pending using only the owning claim token', async () => {
    agentMocks.transferUsdcToWallet.mockResolvedValue({
      success: false,
      outcome: 'rejected_before_broadcast',
      error: 'wallet balance unavailable',
    });
    await payDurableReferralLeg({
      eventId: 'event-1',
      claimToken: 'claim-1',
      subscriberAgentPublicKey: 'agent',
      subscriberEncryptedPrivateKey: new Uint8Array([1]),
      recipientWallet: 'earner',
      amountUsdc: 0.5,
    });
    expect(storageMocks.resetReferralClaimBeforeBroadcast).toHaveBeenCalledWith(
      'event-1',
      'claim-1',
      'wallet balance unavailable',
    );
  });

  it('does not reset a referral row when attempt persistence loses to another active signer', async () => {
    storageMocks.persistReferralSignedSubmitAttempt.mockResolvedValue(false);
    agentMocks.transferUsdcToWallet.mockImplementation(async (_from: string, _key: Uint8Array, _to: string, _amount: number, before: Function) => {
      try {
        await before({ signature: 'losing-referral-sig', blockhash: 'hash', lastValidBlockHeight: 900, rpcProvider: 'configured_primary' });
      } catch (error: any) {
        return { success: false, outcome: 'rejected_before_broadcast', error: error.message };
      }
      throw new Error('unexpected persistence success');
    });
    await payDurableReferralLeg({
      eventId: 'event-1', claimToken: 'losing-claim', subscriberAgentPublicKey: 'agent',
      subscriberEncryptedPrivateKey: new Uint8Array([1]), recipientWallet: 'earner', amountUsdc: 0.5,
    });
    expect(storageMocks.resetReferralClaimBeforeBroadcast).not.toHaveBeenCalled();
    expect(storageMocks.settleSignedSubmitAttempt).not.toHaveBeenCalled();
  });

  it('reconciles active attempts every cycle and does not claim or resend the same row', async () => {
    const event = reward({ status: 'processing', processingClaimToken: 'claim-1' });
    storageMocks.getProcessingReferralRewardEvents.mockResolvedValue([event]);
    storageMocks.getPendingReferralRewardEvents.mockResolvedValue([event]);
    storageMocks.getActiveSignedSubmitAttempt.mockResolvedValue({
      id: 'attempt-1', operationType: 'referral_reward', operationId: 'event-1',
      deterministicSignature: 'sig', blockhash: 'hash', lastValidBlockHeight: '900',
      rpcProvider: 'configured_primary', status: 'confirmation_pending', lastError: null,
      createdAt: new Date(), updatedAt: new Date(),
    });
    agentMocks.getFinalizedEpochPositionStrict.mockRejectedValue(new Error('primary unavailable'));
    await retryPendingReferralRewards();
    expect(storageMocks.claimReferralRewardEventForProcessing).not.toHaveBeenCalled();
    expect(agentMocks.transferUsdcToWallet).not.toHaveBeenCalled();
    expect(storageMocks.resetStaleReferralClaim).not.toHaveBeenCalled();
  });

  it('uses release time for age so an old awaiting leg gets its full retry window after creator success', async () => {
    const event = reward({ createdAt: new Date(Date.now() - 9 * 86_400_000), releasedAt: new Date() });
    storageMocks.getPendingReferralRewardEvents.mockResolvedValue([event]);
    storageMocks.getWallet.mockResolvedValue({ agentPublicKey: 'agent', agentPrivateKeyEncryptedV3: 'cipher' });
    sessionMocks.getUmkForWebhook.mockResolvedValue({ umk: new Uint8Array([1]), cleanup: vi.fn() });
    sessionMocks.decryptAgentKeyStrict.mockResolvedValue({ secretKey: new Uint8Array([1]), cleanup: vi.fn() });
    agentMocks.transferUsdcToWallet.mockImplementation(async (_from: string, _key: Uint8Array, _to: string, _amount: number, before: Function) => {
      await before({ signature: 'referral-paid', blockhash: 'hash', lastValidBlockHeight: 900, rpcProvider: 'configured_primary' });
      return { success: true, outcome: 'confirmed_success', signature: 'referral-paid' };
    });
    storageMocks.getActiveSignedSubmitAttempt.mockResolvedValue({
      id: 'attempt-1', operationType: 'referral_reward', operationId: 'event-1', deterministicSignature: 'referral-paid',
    });
    const result = await retryPendingReferralRewards();
    expect(result).toMatchObject({ processed: 1, paid: 1, voided: 0 });
    expect(storageMocks.voidReferralRewardEvent).not.toHaveBeenCalled();
    expect(storageMocks.claimReferralRewardEventForProcessing).toHaveBeenCalledWith('event-1', ['pending', 'failed']);
  });

  it('voids only through the guarded compare-and-set storage operation', async () => {
    const event = reward({ retryCount: 50, releasedAt: new Date() });
    storageMocks.getPendingReferralRewardEvents.mockResolvedValue([event]);
    await retryPendingReferralRewards();
    expect(storageMocks.voidReferralRewardEvent).toHaveBeenCalledWith('event-1', expect.stringContaining('Expired: 50 retries'));
    expect(storageMocks.updateReferralRewardEventStatus).not.toHaveBeenCalledWith(
      'event-1', expect.objectContaining({ status: 'voided' }),
    );
  });

  it('checks funding authorization before claiming and preserves retry budget when unavailable', async () => {
    storageMocks.getPendingReferralRewardEvents.mockResolvedValue([reward()]);
    storageMocks.getWallet.mockResolvedValue(undefined);
    await retryPendingReferralRewards();
    expect(storageMocks.updateReferralRewardEventStatus).toHaveBeenCalledWith('event-1', {
      lastError: 'Funding agent authorization unavailable (paused, retry budget preserved)',
    });
    expect(storageMocks.claimReferralRewardEventForProcessing).not.toHaveBeenCalled();
  });

  it.each(['wallet', 'umk', 'decrypt'] as const)('checks referral %s availability before claim and preserves retry budget', async (unavailable) => {
    storageMocks.getPendingReferralRewardEvents.mockResolvedValue([reward()]);
    storageMocks.getWallet.mockResolvedValue(unavailable === 'wallet'
      ? undefined
      : { agentPublicKey: 'agent', agentPrivateKeyEncryptedV3: 'cipher' });
    sessionMocks.getUmkForWebhook.mockResolvedValue(unavailable === 'umk'
      ? undefined
      : { umk: new Uint8Array([1]), cleanup: vi.fn() });
    sessionMocks.decryptAgentKeyStrict.mockResolvedValue(unavailable === 'decrypt'
      ? undefined
      : { secretKey: new Uint8Array([1]), cleanup: vi.fn() });
    await retryPendingReferralRewards();
    expect(storageMocks.claimReferralRewardEventForProcessing).not.toHaveBeenCalled();
    expect(agentMocks.transferUsdcToWallet).not.toHaveBeenCalled();
    const patch = storageMocks.updateReferralRewardEventStatus.mock.calls.at(-1)?.[1];
    expect(patch?.retryCount).toBeUndefined();
    expect(patch?.lastError).toContain('retry budget preserved');
  });

  it('keeps stale recovery and creator-first release fail-closed in storage', () => {
    const storageSource = readFileSync(new URL('../../server/storage.ts', import.meta.url), 'utf8');
    expect(storageSource).toContain("status: 'pending', releasedAt: now");
    expect(storageSource).toContain("eq(referralRewardEvents.status, 'awaiting_creator')");
    expect(storageSource).toContain("eq(referralRewardEvents.processingClaimToken, claimToken)");
    expect(storageSource).toContain("a.operation_type='referral_reward'");
    expect(storageSource).toContain("a.status='confirmation_pending'");
    expect(storageSource).toContain("processingClaimedFromStatus: sql`${referralRewardEvents.status}`");
    expect(storageSource).toContain("status: sql`COALESCE(${referralRewardEvents.processingClaimedFromStatus}, 'pending')`");
  });
});
