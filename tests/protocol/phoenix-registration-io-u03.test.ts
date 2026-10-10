import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { createPhoenixRegistrationIO } from '../../server/protocol/phoenix/registration-io';
import { prepareRegistration } from '../../server/protocol/phoenix/registration';
import { identity, instructions, lifetime, pin, traderData } from '../helpers/phoenix-registration';

const metadata = () => ({ traderPda: identity.traderAccountAddress, traderOnboarder: pin.onboarder,
  txFeePayer: identity.authorityWalletAddress, maxPositions: 32, includeRegisterTrader: true });
const fetcher = vi.fn();
const rpc = { getLatestBlockhash: vi.fn(), getMinimumBalanceForRentExemption: vi.fn(), getFeeForMessage: vi.fn(),
  getBalance: vi.fn(), getAccountInfo: vi.fn(), simulateTransaction: vi.fn(), getSignatureStatuses: vi.fn() };
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
    [{ gated: true, active: true, runningState: 'active' }, 'gated'],
    [{ gated: false, active: true, runningState: 'active' }, 'eligible'],
    [{ active: true }, 'unknown'], [{ gated: false, active: false }, 'unknown'],
  ])('fails closed for status %j', async (status, expected) => {
    fetcher.mockResolvedValue(response(status)); expect(await io().eligibility()).toBe(expected);
  });
  it('exposes denied activation without treating it as a transport timeout', async () => {
    fetcher.mockResolvedValue(response({}, 403)); expect(await io().eligibility()).toBe('denied');
    await expect(io().build(identity, 32)).rejects.toMatchObject({ code: 'denied' });
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
