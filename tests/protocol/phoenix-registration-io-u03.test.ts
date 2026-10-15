import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { createPhoenixRegistrationIO } from '../../server/protocol/phoenix/registration-io';
import { prepareRegistration } from '../../server/protocol/phoenix/registration';
import { prepareReferralActivation, signReferralActivation, referralIdentityHash, type ReferralBinding } from '../../server/protocol/phoenix/referral-activation';
import { readPhoenixReferralConfig } from '../../server/protocol/phoenix/referral-config';
import { identity, authority, key, instructions, lifetime, pin, traderData } from '../helpers/phoenix-registration';

const metadata = () => ({ traderPda: identity.traderAccountAddress, traderOnboarder: pin.onboarder,
  txFeePayer: identity.authorityWalletAddress, maxPositions: 32, includeRegisterTrader: true });
const fetcher = vi.fn();
const rpc = { getLatestBlockhash: vi.fn(), getMinimumBalanceForRentExemption: vi.fn(), getFeeForMessage: vi.fn(),
  getBalance: vi.fn(), getAccountInfo: vi.fn(), simulateTransaction: vi.fn(), getSignatureStatuses: vi.fn(), getBlockHeight: vi.fn() };
const signer = vi.fn();
const io = () => createPhoenixRegistrationIO(rpc as any, pin, signer, fetcher);
const transaction = () => prepareRegistration(instructions(), identity, pin, 32, lifetime);
const response = (value: object, status = 200) => new Response(JSON.stringify(value), { status });
const simulation = () => ({ value: { err: null, accounts: [
  { lamports: 89000 }, { owner: identity.programAddress, executable: false, lamports: 1000, data: [traderData().toString('base64'), 'base64'] },
] } });
beforeEach(() => {
  vi.resetAllMocks();
  rpc.getLatestBlockhash.mockResolvedValue(lifetime);
  rpc.getMinimumBalanceForRentExemption.mockResolvedValue(1000);
  rpc.getFeeForMessage.mockResolvedValue({ value: 10000 });
  rpc.getBalance.mockResolvedValue(100000);
  rpc.getAccountInfo.mockResolvedValue(null);
  rpc.simulateTransaction.mockResolvedValue(simulation());
});
describe('U03 current API and RPC adapter (no network)', () => {
  it.each([
    { gated: true, active: false, runningState: 'active' },
    { gated: true, active: true, runningState: 'halted' },
    { gated: true, active: true, runningState: 'unknown' },
    { gated: 'true', active: true, runningState: 'active' },
    { gated: true, active: 'true', runningState: 'active' },
  ])('requires a fresh explicit active gated status %j', async status => {
    fetcher.mockResolvedValue(response(status)); expect(await io().eligibility()).toBe('unknown');
    fetcher.mockResolvedValue(response({ gated: false, active: true, runningState: 'active' }));
    expect(await io().eligibility()).toBe('eligible');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('reads finalized identity and all six bits, without an empty/deposit-bit shortcut', async () => {
    const adapter = io().referral!;
    expect((await adapter.state(identity)).state).toBe('missing');
    const data = traderData(), account = { data, owner: new PublicKey(identity.programAddress), executable: false, lamports: 1000 };
    for (const flags of [0,1,2,4,8,16,32,31,62]) {
      data.writeUInt32LE(flags,96); rpc.getAccountInfo.mockResolvedValue(account);
      expect((await adapter.state(identity)).state).toBe('inactive');
    }
    data.writeUInt32LE(63,96);
    expect(await adapter.state(identity)).toMatchObject({ state: 'ready', identityHash: referralIdentityHash(identity) });
    expect(rpc.getAccountInfo).toHaveBeenLastCalledWith(new PublicKey(identity.traderAccountAddress), 'finalized');
    for (const bad of [{ ...account, data: Buffer.alloc(0) }, { ...account, executable: true }, { ...account, owner: key(20).publicKey }]) {
      rpc.getAccountInfo.mockResolvedValue(bad); expect((await adapter.state(identity)).state).toBe('unknown');
    }
    for (const offset of [24,56,154,155]) {
      const bad = traderData(); bad[offset] ^= 1;
      rpc.getAccountInfo.mockResolvedValue({ ...account, data: bad }); expect((await adapter.state(identity)).state).toBe('unknown');
    }
    rpc.getAccountInfo.mockRejectedValue(new Error('EXAMPLE-rpc-timeout'));
    expect((await adapter.state(identity)).state).toBe('unknown');
  });
  it.each(['missing','inactive'] as const)('quotes exact two-signature fees and rent only for %s accounts', async state => {
    const adapter = io().referral!, tx = prepareReferralActivation(identity, adapter.pin, 32, state, lifetime);
    if (state === 'inactive') {
      const data = traderData(); data.writeUInt32LE(0,96);
      rpc.getAccountInfo.mockResolvedValue({ data, owner: new PublicKey(identity.programAddress), executable: false, lamports: 1000 });
      const after = simulation(); after.value.accounts[0].lamports = 90000; rpc.simulateTransaction.mockResolvedValue(after);
    }
    expect(await adapter.estimate(tx,identity,state,32)).toEqual({ rentLamports: state === 'missing' ? '1000' : '0', feeLamports: '10000', balanceLamports: '100000' });
    expect(rpc.getFeeForMessage.mock.calls[0][0].header.numRequiredSignatures).toBe(2);
    expect(rpc.getMinimumBalanceForRentExemption).toHaveBeenCalledTimes(state === 'missing' ? 1 : 0);
    rpc.getFeeForMessage.mockResolvedValue({ value: null });
    await expect(adapter.estimate(tx,identity,state,32)).rejects.toThrow();
  });
  it('refuses unknown rent, account changes and simulation transfers before signing', async () => {
    const adapter = io().referral!, tx = prepareReferralActivation(identity,adapter.pin,32,'missing',lifetime);
    rpc.getMinimumBalanceForRentExemption.mockResolvedValue(0);
    await expect(adapter.estimate(tx,identity,'missing',32)).rejects.toThrow();
    rpc.getMinimumBalanceForRentExemption.mockResolvedValue(1000);
    const after = simulation(); after.value.accounts[0].lamports = 1; rpc.simulateTransaction.mockResolvedValue(after);
    await expect(adapter.estimate(tx,identity,'missing',32)).rejects.toThrow();
    rpc.getAccountInfo.mockResolvedValue({ data: traderData(), owner: new PublicKey(identity.programAddress), executable: false, lamports: 1000 });
    await expect(adapter.estimate(tx,identity,'missing',32)).rejects.toThrow();
    expect(signer).not.toHaveBeenCalled();
  });
  it.each(['activated','submitted','already_activated'])('authenticates one POST for %s, including a missing response signature', async status => {
    const adapter = io().referral!, config = readPhoenixReferralConfig({ PHOENIX_REFERRAL_CODE: 'EXAMPLE-Referral' });
    if (config.state !== 'enabled') throw new Error('EXAMPLE-config');
    const signed = signReferralActivation(prepareReferralActivation(identity,adapter.pin,32,'missing',lifetime),identity,adapter.pin,32,'missing',lifetime,authority.secretKey);
    const binding: ReferralBinding = { route: 'referral', expectedState: 'missing', maxPositions:32, identityHash:referralIdentityHash(identity),
      referralCodeSha256:config.referralCodeSha256, deploymentPinSha256:adapter.pin.deploymentPinSha256,
      signature:signed.signature,transactionHash:signed.transactionHash,blockhash:signed.blockhash,lastValidBlockHeight:signed.lastValidBlockHeight };
    fetcher.mockResolvedValue(response({ status, trader_pda: identity.traderAccountAddress, referral_code: config.code }));
    expect(await adapter.submit(signed,binding,identity,config,{ authority:identity.authorityWalletAddress,bearer:'EXAMPLE',expiresAt:Date.now()+60000 })).toEqual({ status });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('https://perp-api.phoenix.trade/v1/referral/activate-tx');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method:'POST', redirect:'error', credentials:'omit', headers:{Authorization:'Bearer EXAMPLE'} });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ trader_pda_index:0, trader_subaccount_index:0, transaction:signed.transaction });
    expect(rpc.getSignatureStatuses).not.toHaveBeenCalled();
    await expect(adapter.submit(signed,binding,identity,config,{authority:key(20).publicKey.toBase58(),bearer:'EXAMPLE',expiresAt:Date.now()+60000})).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([401,403])('keeps public eligibility HTTP %s unknown', async status => {
    fetcher.mockResolvedValue(response({}, status));
    expect(await io().eligibility()).toBe('unknown');
  });
  it('expires only an absent signature beyond its last valid height', async () => {
    rpc.getSignatureStatuses.mockResolvedValue({value:[null]});
    rpc.getBlockHeight.mockResolvedValue(100);
    expect(await io().confirm('EXAMPLE-signature',identity,'100')).toBe('unknown');
    rpc.getBlockHeight.mockResolvedValue(101);
    expect(await io().confirm('EXAMPLE-signature',identity,'100')).toBe('expired');
    rpc.getSignatureStatuses.mockResolvedValueOnce({value:[null]}).mockResolvedValueOnce({value:[{confirmationStatus:'confirmed',err:null}]});
    expect(await io().confirm('EXAMPLE-signature',identity,'100')).toBe('unknown');
  });
  it.each([
    [{ gated: true, active: true, runningState: 'active' }, 'gated'],
    [{ gated: false, active: true, runningState: 'active' }, 'eligible'],
    [{ active: true }, 'unknown'], [{ gated: false, active: false }, 'unknown'],
  ])('fails closed for status %j', async (status, expected) => {
    fetcher.mockResolvedValue(response(status)); expect(await io().eligibility()).toBe(expected);
  });
  it('exposes denied activation without treating it as a transport timeout', async () => {
    fetcher.mockResolvedValueOnce(response({}, 403)).mockResolvedValueOnce(response({}, 403));
    expect(await io().eligibility()).toBe('unknown');
    await expect(io().build(identity, 32)).rejects.toMatchObject({ code: 'denied' });
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      'https://perp-api.phoenix.trade/v1/view/exchange/status',
      'https://perp-api.phoenix.trade/v1/exchange/build-register-ixs',
    ]);
    expect(signer).not.toHaveBeenCalled();
  });
  it('uses only the current build and onboarder-send endpoints, with no retries', async () => {
    fetcher.mockResolvedValueOnce(response({ ...metadata(), instructions: instructions() }));
    expect(await io().build(identity, 32)).toEqual(instructions());
    fetcher.mockResolvedValueOnce(response({ ...metadata(), signature: 'EXAMPLE-signature' }));
    await io().submit('EXAMPLE-partial-transaction', identity, 32);
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      'https://perp-api.phoenix.trade/v1/exchange/build-register-ixs', 'https://perp-api.phoenix.trade/v1/exchange/send-register-ixs']);
    const body = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(body).toMatchObject({ traderAuthority: identity.authorityWalletAddress, txFeePayer: identity.authorityWalletAddress, traderPdaIndex: 0, traderSubaccountIndex: 0 });
    fetcher.mockRejectedValue(new Error('EXAMPLE-timeout'));
    await expect(io().submit('EXAMPLE-partial', identity, 32)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it.each(['traderPda', 'traderOnboarder', 'txFeePayer', 'maxPositions', 'includeRegisterTrader'])('rejects metadata tampering in %s', async field => {
    fetcher.mockResolvedValue(response({ ...metadata(), [field]: 'EXAMPLE-wrong', instructions: instructions() }));
    await expect(io().build(identity, 32)).rejects.toThrow('metadata');
  });
  it('quotes actual RPC rent and both signature fees, then verifies unsigned simulated effects', async () => {
    expect(await io().estimate(transaction(), identity)).toEqual({ rentLamports: '1000', feeLamports: '10000', balanceLamports: '100000' });
    expect(rpc.getMinimumBalanceForRentExemption).toHaveBeenCalledWith(1520, 'finalized');
    expect(rpc.getFeeForMessage.mock.calls[0][0].header.numRequiredSignatures).toBe(2);
    expect(rpc.simulateTransaction.mock.calls[0][1].sigVerify).toBe(false);
    expect(signer).not.toHaveBeenCalled();
  });
  it('returns an insufficient-gas quote without pretending an unfunded simulation passed', async () => {
    rpc.getBalance.mockResolvedValue(0);
    expect((await io().estimate(transaction(), identity)).balanceLamports).toBe('0');
    expect(rpc.simulateTransaction).not.toHaveBeenCalled();
  });
  it.each(['fee-null', 'existing', 'simulation-error', 'overspend', 'wrong-trader', 'wrong-size', 'not-active'])('rejects unsafe estimate %s', async fault => {
    if (fault === 'fee-null') rpc.getFeeForMessage.mockResolvedValue({ value: null });
    if (fault === 'existing') rpc.getAccountInfo.mockResolvedValue({ data: traderData() });
    const simulated = simulation();
    if (fault === 'simulation-error') (simulated.value as any).err = 'EXAMPLE-error';
    if (fault === 'overspend') simulated.value.accounts[0].lamports = 1;
    const data = traderData();
    if (fault === 'wrong-trader') data[24] ^= 1;
    if (fault === 'not-active') data[96] = 0;
    simulated.value.accounts[1].data = [(fault === 'wrong-size' ? data.subarray(0, 224) : data).toString('base64'), 'base64'];
    rpc.simulateTransaction.mockResolvedValue(simulated);
    await expect(io().estimate(transaction(), identity)).rejects.toThrow();
  });
  it('requires reviewed account space rather than trusting the server', async () => {
    const instance = createPhoenixRegistrationIO(rpc as any, { ...pin, traderBytesByMaxPositions: {} }, signer, fetcher);
    await expect(instance.estimate(transaction(), identity)).rejects.toThrow('Unreviewed');
  });
  it.each([null, { confirmationStatus: 'processed', err: null }, { confirmationStatus: 'confirmed', err: null }])('keeps nonfinal signature %j unknown', async status => {
    rpc.getSignatureStatuses.mockResolvedValue({ value: [status] });
    expect(await io().confirm('EXAMPLE-signature', identity)).toBe('unknown');
  });
  it('distinguishes finalized failure from finalized active trader success', async () => {
    rpc.getSignatureStatuses.mockResolvedValue({ value: [{ confirmationStatus: 'finalized', err: 'EXAMPLE-error' }] });
    expect(await io().confirm('EXAMPLE-signature', identity)).toBe('failed');
    rpc.getSignatureStatuses.mockResolvedValue({ value: [{ confirmationStatus: 'finalized', err: null }] });
    expect(await io().confirm('EXAMPLE-signature', identity)).toBe('unknown');
    rpc.getAccountInfo.mockResolvedValue({ owner: new PublicKey(identity.programAddress), executable: false, data: traderData() });
    expect(await io().confirm('EXAMPLE-signature', identity)).toBe('confirmed');
  });
});
