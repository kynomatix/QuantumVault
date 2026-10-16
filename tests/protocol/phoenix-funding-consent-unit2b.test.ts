import { beforeEach, describe, expect, it, vi } from 'vitest';
import { key, identity } from '../helpers/phoenix-registration';
import { phoenixCreationId } from '../../server/protocol/phoenix/provisioning-store';
import { phoenixIdentityColumns } from '../../server/protocol/phoenix/identity';
import type { FundingIntent } from '../../server/protocol/phoenix/funding-contract';

const hooks = vi.hoisted(() => ({ enabled: true, allows: true, signer: null as any, snapshot: vi.fn(), quote: vi.fn(),
  umk: vi.fn(), decrypt: vi.fn(), policy: vi.fn(), keyCleanup: vi.fn(), umkCleanup: vi.fn() }));
vi.mock('../../server/protocol/phoenix/rollout', () => ({ phoenixFeatureEnabled: () => hooks.enabled, phoenixCanaryAllows: () => hooks.allows }));
vi.mock('../../server/session-v3', () => ({ getUmkForWebhook: hooks.umk, decryptAgentKeyStrict: hooks.decrypt, verifyBotPolicyHmac: hooks.policy }));
vi.mock('../../server/protocol/phoenix/funding-io', () => ({ createPhoenixFundingIO: (_rpc: any, _pin: any, _verify: any, signer: any) => {
  hooks.signer = signer; return { snapshot: hooks.snapshot, io: { quote: hooks.quote,
    lifetime: async () => ({ blockhash: key(16).publicKey.toBase58(), lastValidBlockHeight: 100 }), withSigner: signer } };
} }));
import { createPhoenixFundingProduction, PHOENIX_EXIT_DISCLOSURE } from '../../server/protocol/phoenix/funding-production';

const owner = 'EXAMPLE-owner', requestId = 'EXAMPLE-request', botId = phoenixCreationId(owner, requestId);
const address = (n: number) => key(n).publicKey.toBase58();
const pin = { logAuthority: address(40), globalConfiguration: address(41), globalVault: address(42), perpAssetMap: address(43),
  withdrawQueue: address(44), emberState: address(45), emberVault: address(46), globalTraderIndex: [address(47)], activeTraderBuffer: [address(48)] };
function fixture() {
  const registration = { id: 'EXAMPLE-register', bot_id: botId, request_key: requestId, state: 'completed', intent: { ownerWallet: owner, identity,
    registration: { maxPositions: 128, maxCostLamports: '10000000', name: 'EXAMPLE', market: 'SOL' } } };
  const bot = { id: botId, walletAddress: owner, activeProtocol: 'phoenix', ...phoenixIdentityColumns(identity), policyHmac: 'EXAMPLE',
    protocolSubaccountId: identity.traderAccountAddress, derivationIndex: 1, derivationPathVersion: 1 };
  const wallet = { agentPublicKey: address(50), agentPrivateKeyEncryptedV3: 'EXAMPLE' };
  const getBot = vi.fn(async () => bot), getWallet = vi.fn(async () => wallet), verify = vi.fn();
  const operations = { fundingHistory: vi.fn().mockResolvedValue([]), prepare: vi.fn(), refreshFundingQuote: vi.fn(), read: vi.fn() };
  const runtime = createPhoenixFundingProduction({ rpc: {} as any, pin, verify, getBot: getBot as any, getWallet,
    retained: vi.fn(async (_bot, currentOwner) => { if (currentOwner !== owner) throw new Error('PHOENIX_OWNED_REGISTERED_BOT_REQUIRED'); return registration as any; }), operations: operations as any });
  return { runtime, getBot, getWallet, verify, operations, wallet, bot };
}
beforeEach(() => {
  vi.clearAllMocks(); hooks.enabled = true; hooks.allows = true;
  hooks.snapshot.mockResolvedValue({ queue: { withdrawalFee: '500000', enqueuingFee: '500000', remainingBudget: '100000000', nodes: [] } });
  hooks.quote.mockImplementation(async (i: FundingIntent) => ({ minimumBaseUnits: i.funding.minimumBaseUnits, feeBaseUnits: i.feeBaseUnits,
    grossBaseUnits: i.funding.grossBaseUnits, netBaseUnits: i.amountBaseUnits, gasLamports: '5000', rentLamports: '0',
    availableLamports: '100000000', availableBaseUnits: '100000000', source: i.funding.quoteSource, reference: i.funding.quoteReference, expiresAt: i.funding.quoteExpiresAt }));
  hooks.umk.mockResolvedValue({ umk: Buffer.from('EXAMPLE'), cleanup: hooks.umkCleanup });
  hooks.decrypt.mockImplementation(async () => ({ secretKey: key(50).secretKey, cleanup: hooks.keyCleanup }));
  hooks.policy.mockReturnValue(true);
});
describe('Unit 2B owned exact consent and custody', () => {
  it('server chooses the V3 source and first funding leg, with the required disclosure', async () => {
    const f = fixture(); const q = await f.runtime.preview(botId, owner, { action: 'deposit', amountBaseUnits: '1000000' });
    expect(q).toMatchObject({ leg: 'wallet_funding', sourceWallet: address(50), amountBaseUnits: '1000000', disclosure: PHOENIX_EXIT_DISCLOSURE });
    if (!('quoteId' in q)) throw new Error('Expected consent quote');
    expect(f.operations.prepare).not.toHaveBeenCalled();
    await expect(f.runtime.preview(botId, owner, { action: 'deposit', amountBaseUnits: '1000000', sourceWallet: address(51) })).rejects.toThrow('PHOENIX_INVALID_PREVIEW');
    await expect(f.runtime.execute(botId, 'EXAMPLE-stranger', 'deposit', { quoteId: q.quoteId, consent: true })).rejects.toThrow('PHOENIX_QUOTE_UNAVAILABLE');
    await expect(f.runtime.execute(botId, owner, 'deposit', { quoteId: q.quoteId, consent: false })).rejects.toThrow('PHOENIX_EXACT_CONSENT_REQUIRED');
  });
  it('revocation blocks new funding while withdrawal quotes remain available with all risk off', async () => {
    const f = fixture(); hooks.enabled = false; hooks.allows = false;
    await expect(f.runtime.preview(botId, owner, { action: 'deposit', amountBaseUnits: '1000000' })).rejects.toThrow('PHOENIX_FUNDING_DISABLED');
    expect(await f.runtime.preview(botId, owner, { action: 'withdraw', amountBaseUnits: '1000000' })).toMatchObject({ leg: 'withdraw', feeBaseUnits: '500000', grossBaseUnits: '1500000' });
  });
  it('shows both live fees and refuses a predicted enqueue without issuing consent', async () => {
    const f = fixture(); hooks.snapshot.mockResolvedValue({ queue: { withdrawalFee: '500000', enqueuingFee: '500000', remainingBudget: '0', nodes: [] } });
    expect(await f.runtime.preview(botId, owner, { action: 'withdraw', amountBaseUnits: '1000000' })).toMatchObject({ available: false, code: 'PHOENIX_ENQUEUE_FEE_UNVERIFIED', enqueuingFee: '500000' });
    expect(hooks.quote).not.toHaveBeenCalled();
  });
  it('signs only the approved V3 agent and cleans every key lifetime', async () => {
    const f = fixture(); await f.runtime.preview(botId, owner, { action: 'deposit', amountBaseUnits: '1000000' });
    const i = hooks.quote.mock.calls[0][0];
    const sign = vi.fn(() => 'EXAMPLE-signed');
    expect(await hooks.signer(i, sign)).toBe('EXAMPLE-signed');
    expect(hooks.decrypt).toHaveBeenCalledWith(owner, expect.any(Buffer), f.wallet, address(50));
    expect(hooks.keyCleanup).toHaveBeenCalledOnce(); expect(hooks.umkCleanup).toHaveBeenCalledOnce();
    hooks.decrypt.mockResolvedValueOnce({ secretKey: key(51).secretKey, cleanup: hooks.keyCleanup });
    await expect(hooks.signer(i, sign)).rejects.toThrow('PHOENIX_SOURCE_POLICY_CHANGED');
    expect(sign).toHaveBeenCalledOnce(); expect(hooks.keyCleanup).toHaveBeenCalledTimes(2); expect(hooks.umkCleanup).toHaveBeenCalledTimes(2);
  });
  it('rechecks owner, source, encrypted key and policy after opening custody', async () => {
    const f = fixture(); await f.runtime.preview(botId, owner, { action: 'deposit', amountBaseUnits: '1000000' });
    const i = hooks.quote.mock.calls[0][0], sign = vi.fn();
    hooks.decrypt.mockImplementationOnce(async () => { f.getWallet.mockResolvedValue({ ...f.wallet, agentPublicKey: address(51) }); return { secretKey: key(50).secretKey, cleanup: hooks.keyCleanup }; });
    await expect(hooks.signer(i, sign)).rejects.toThrow('PHOENIX_SOURCE_POLICY_CHANGED');
    expect(sign).not.toHaveBeenCalled(); expect(hooks.keyCleanup).toHaveBeenCalledOnce(); expect(hooks.umkCleanup).toHaveBeenCalledOnce();
    f.getWallet.mockResolvedValue(f.wallet); hooks.policy.mockReturnValue(false);
    await expect(hooks.signer(i, sign)).rejects.toThrow();
    expect(sign).not.toHaveBeenCalled();
  });
  it('needs fresh exact consent before signing retained preparations, even on resume', async () => {
    const f = fixture(); f.operations.read.mockResolvedValue({ operation: { id: 'EXAMPLE-op', state: 'prepared' } });
    expect(await f.runtime.resume(botId, owner, { operationId: 'EXAMPLE-op' })).toMatchObject({ state: 'prepared' });
    expect(f.operations.prepare).not.toHaveBeenCalled(); expect(hooks.decrypt).not.toHaveBeenCalled();
  });
});
