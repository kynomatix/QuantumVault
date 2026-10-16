import { describe, expect, it, vi } from 'vitest';
import { PublicKey, SystemProgram, Transaction, type Connection } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { createHash } from 'node:crypto';
import { key, identity, lifetime, traderData } from '../helpers/phoenix-registration';
import { PHOENIX_PUBLIC_ADDRESSES as addresses } from '../../server/protocol/phoenix/sdk-boundary';
import { decodeFundingQueue, fundingAta, fundingTag, observeFundingQueue, verifyFundingWithdrawal, type FundingChainInstruction } from '../../server/protocol/phoenix/funding-chain';
import { fundingInstructions, prepareFundingTransaction, signFundingTransaction } from '../../server/protocol/phoenix/funding-builder';
import { createPhoenixFundingIO } from '../../server/protocol/phoenix/funding-io';
import type { FundingIntent } from '../../server/protocol/phoenix/funding-contract';

const address = (n: number) => key(n).publicKey.toBase58();
const pin = { logAuthority: address(40), globalConfiguration: address(41), globalVault: address(42), perpAssetMap: address(43),
  withdrawQueue: address(44), emberState: address(45), emberVault: address(46), globalTraderIndex: [address(47)], activeTraderBuffer: [address(48)] };
function intent(leg: FundingIntent['funding']['leg'] = 'withdraw'): FundingIntent {
  return { botId: 'EXAMPLE-bot', ownerWallet: 'EXAMPLE-owner', requestKey: `EXAMPLE-${leg}`, identity,
    kind: leg === 'deposit' ? 'deposit' : leg === 'withdraw' ? 'withdraw' : 'transfer', mint: addresses.usdcMint,
    amountBaseUnits: '1000000', feeBaseUnits: leg === 'withdraw' ? '500000' : '0',
    destination: leg === 'deposit' ? identity.traderAccountAddress : identity.authorityWalletAddress,
    funding: { leg, sourceWallet: leg === 'wallet_funding' ? address(50) : identity.authorityWalletAddress,
      grossBaseUnits: leg === 'withdraw' ? '1500000' : '1000000', minimumBaseUnits: '1', maxGasLamports: '10000000',
      quoteSource: 'EXAMPLE', quoteReference: 'EXAMPLE', quoteExpiresAt: Date.now() + 60000,
      ...(leg === 'withdraw' ? { withdrawWithFee: true } : {}) } };
}
function queue(node = false) {
  const d = Buffer.alloc(213136); fundingTag('account:withdraw_queue').copy(d);
  d.writeBigUInt64LE(500000n, 64); d.writeBigUInt64LE(500000n, 72); d.writeBigUInt64LE(1000000000n, 32); d.writeUInt32LE(1, 136);
  if (node) {
    d.writeUInt32LE(1, 120); d.writeUInt32LE(1, 124); d.writeBigUInt64LE(1n, 128); d.writeUInt32LE(2, 136);
    new PublicKey(identity.traderAccountAddress).toBuffer().copy(d, 152); new PublicKey(identity.authorityWalletAddress).toBuffer().copy(d, 184);
    d.writeBigUInt64LE(1000000n, 216); d.writeBigUInt64LE(100n, 224); d.writeUInt16LE(1, 240); d[242] = 1;
  }
  return d;
}
function events(queued = false, fee = 500000n): FundingChainInstruction[] {
  const transition = Buffer.alloc(50); transition[0] = 36;
  new PublicKey(identity.traderAccountAddress).toBuffer().copy(transition, 1); transition.writeBigUInt64LE(1000000n, 33);
  transition[42] = queued ? 1 : 4; transition[43] = queued ? 1 : 0; transition.writeUInt16LE(1, 44); transition.writeUInt32LE(queued ? 1 : 0, 46);
  const feeEvent = Buffer.alloc(105); feeEvent[0] = 43;
  const payout = Buffer.alloc(129); payout[0] = queued ? 15 : 14;
  for (const e of [feeEvent, payout]) {
    new PublicKey(identity.traderAccountAddress).toBuffer().copy(e, 1); new PublicKey(identity.authorityWalletAddress).toBuffer().copy(e, 33);
    e.writeBigUInt64LE(e === feeEvent ? fee : 1000000n, 65);
  }
  const payload = [transition, feeEvent, payout];
  const lengths = Buffer.alloc(22); fundingTag('global:log_event_lengths').copy(lengths); lengths.writeUInt32LE(3, 12);
  payload.forEach((e, n) => lengths.writeUInt16LE(e.length, 16 + n * 2));
  const header = Buffer.alloc(16); fundingTag('global:log').copy(header); header.writeUInt32LE(3, 12);
  const log = (data: Buffer): FundingChainInstruction => ({ program: addresses.program, accounts: [pin.logAuthority], data, depth: 2 });
  const transfer = Buffer.alloc(9); transfer[0] = 3; transfer.writeBigUInt64LE(1000000n, 1);
  return [...(queued ? [] : [{ program: TOKEN_PROGRAM_ID.toBase58(), accounts: [pin.globalVault, fundingAta(identity.authorityWalletAddress, addresses.collateralMint), pin.globalVault], data: transfer, depth: 2 }]), log(lengths), log(Buffer.concat([header, ...payload]))];
}
const expected = { trader: identity.traderAccountAddress, wallet: identity.authorityWalletAddress, amount: '1000000', fee: '500000', signature: 'EXAMPLE', slot: '100', instructionIndex: 1 };

describe('Unit 2B native withdrawal proof', () => {
  it('requests payout independently of the live withdrawal fee and preserves Ember caller order', () => {
    const ix = fundingInstructions(intent(), pin)[1];
    expect(ix.data.subarray(0, 8)).toEqual(fundingTag('global:withdraw_funds_with_fee'));
    expect(ix.data.readBigUInt64LE(8)).toBe(1000000n);
    const unwrap = intent('unwrap'); unwrap.funding.parentOperationId = 'EXAMPLE-parent';
    const ember = fundingInstructions(unwrap, pin)[2];
    expect(ember.keys.map(k => k.pubkey.toBase58())).toEqual([identity.authorityWalletAddress, pin.emberState, addresses.usdcMint, addresses.collateralMint,
      fundingAta(identity.authorityWalletAddress, addresses.usdcMint), fundingAta(identity.authorityWalletAddress, addresses.collateralMint), pin.emberVault, TOKEN_PROGRAM_ID.toBase58()]);
  });
  it('requires the immediate transition, exact Withdrawn and exact vault transfer together', () => {
    expect(verifyFundingWithdrawal(events(), pin, expected).outcome).toBe('settled');
    expect(() => verifyFundingWithdrawal(events().slice(1), pin, expected)).toThrow('PHOENIX_WITHDRAW_TRANSFER');
    const wrong = events(); wrong[0].accounts[1] = address(50);
    expect(() => verifyFundingWithdrawal(wrong, pin, expected)).toThrow();
    expect(() => verifyFundingWithdrawal(events(false, 0n), pin, expected)).toThrow();
  });
  it('refuses unframed, wrongly parented, or malformed events', () => {
    const bad = events(); bad[1].depth = 3;
    expect(() => verifyFundingWithdrawal(bad, pin, expected)).toThrow('PHOENIX_EVENT_PARENT');
    const framed = events(); framed[1].data.writeUInt16LE(49, 16);
    expect(() => verifyFundingWithdrawal(framed, pin, expected)).toThrow();
  });
  it('keeps a generation anchor for queue races, including unexpected measured fees', () => {
    const proof = verifyFundingWithdrawal(events(true, 1000000n), pin, expected);
    expect(proof.outcome).toBe('queued'); expect(proof.queueAnchor).toMatchObject({ signature: 'EXAMPLE', enqueueSlot: '100', nodeIndex: 1, amount: '1000000' });
    expect(proof).toMatchObject({ observedFeeBaseUnits: '1000000', feeUnexpected: true });
    const observed = observeFundingQueue(decodeFundingQueue(queue(true)), proof.queueAnchor!, '101');
    expect(observed).toMatchObject({ position: 1, state: 'Queued' });
    expect(observeFundingQueue(decodeFundingQueue(queue()), proof.queueAnchor!, '102').state).toContain('generation not established');
    const reused = queue(true); reused.writeBigUInt64LE(101n, 224);
    expect(observeFundingQueue(decodeFundingQueue(reused), proof.queueAnchor!, '103').position).toBeNull();
    const processed = queue(true); processed[242] = 4;
    expect(observeFundingQueue(decodeFundingQueue(processed), proof.queueAnchor!, '104').state).toBe('Processed'); // Read-only; never settlement proof.
  });
  it('validates live fees and deque links, ignoring stale freed node bytes', () => {
    const empty = queue(); empty[242] = 4;
    expect(decodeFundingQueue(empty)).toMatchObject({ withdrawalFee: '500000', enqueuingFee: '500000', nodes: [] });
    const corrupt = queue(true); corrupt.writeUInt32LE(1, 148);
    expect(() => decodeFundingQueue(corrupt)).toThrow('PHOENIX_QUEUE_LINKS');
  });
});

function account(data: Buffer, owner: string, lamports = 2039280) { return { data, owner: new PublicKey(owner), lamports, executable: false, rentEpoch: 0 }; }
function token(mint: string, owner: string, value: bigint) {
  const d = Buffer.alloc(165); new PublicKey(mint).toBuffer().copy(d); new PublicKey(owner).toBuffer().copy(d, 32); d.writeBigUInt64LE(value, 64); d[108] = 1;
  return account(d, TOKEN_PROGRAM_ID.toBase58());
}
function fixture() {
  const i = intent(), wallet = identity.authorityWalletAddress;
  const trader = traderData(); trader.writeBigInt64LE(10000000n, 88);
  const map = new Map<string, ReturnType<typeof account>>([
    [wallet, account(Buffer.alloc(0), SystemProgram.programId.toBase58(), 100000000)], [identity.traderAccountAddress, account(trader, addresses.program)],
    [fundingAta(wallet, addresses.usdcMint), token(addresses.usdcMint, wallet, 2000000n)],
    [fundingAta(wallet, addresses.collateralMint), token(addresses.collateralMint, wallet, 0n)],
    [pin.globalVault, token(addresses.collateralMint, pin.globalVault, 100000000n)], [pin.emberVault, token(addresses.usdcMint, pin.emberState, 100000000n)],
    [pin.withdrawQueue, account(queue(), addresses.program)],
  ]);
  const rpc = { getMultipleAccountsInfoAndContext: vi.fn(async (keys: PublicKey[], _config?: { commitment?: string; minContextSlot?: number }) => ({ context: { slot: 100 }, value: keys.map(k => map.get(k.toBase58()) ?? null) })),
    getFeeForMessage: vi.fn().mockResolvedValue({ value: 5000 }), getMinimumBalanceForRentExemption: vi.fn().mockResolvedValue(2039280),
    simulateTransaction: vi.fn(async (_tx, config) => ({ context: { slot: 100 }, value: { err: null, accounts: config.accounts.addresses.map((k: string) => {
      const original = map.get(k); if (!original) return null;
      const a = { ...original, data: Buffer.from(original.data) };
      if (k === wallet) a.lamports -= 5000;
      if (k === identity.traderAccountAddress) a.data.writeBigInt64LE(8500000n, 88);
      if (k === fundingAta(wallet, addresses.collateralMint)) a.data.writeBigUInt64LE(1000000n, 64);
      if (k === pin.globalVault) a.data.writeBigUInt64LE(99000000n, 64);
      return { ...a, owner: a.owner.toBase58(), data: [a.data.toString('base64'), 'base64'] };
    }) } })), getSignatureStatuses: vi.fn(), getBlockHeight: vi.fn(), getTransaction: vi.fn(), sendRawTransaction: vi.fn() };
  const verify = vi.fn().mockResolvedValue(undefined), operations = { read: vi.fn() };
  return { i, rpc, map, verify, operations, native: createPhoenixFundingIO(rpc as unknown as Connection, pin, verify, vi.fn(), operations) };
}
describe('Unit 2B finalized funding IO', () => {
  it.each(['wallet_funding', 'deposit', 'unwrap', 'wallet_return'] as const)('checks exact simulation and transaction-bound receipts for %s', async leg => {
    const f = fixture(), i = intent(leg), wallet = identity.authorityWalletAddress;
    if (leg === 'wallet_return') i.destination = address(50);
    if (['deposit', 'unwrap', 'wallet_return'].includes(leg)) i.funding.parentOperationId = 'EXAMPLE-parent';
    f.map.set(address(50), account(Buffer.alloc(0), SystemProgram.programId.toBase58(), 100000000));
    f.map.set(fundingAta(address(50), addresses.usdcMint), token(addresses.usdcMint, address(50), 5000000n));
    f.map.get(fundingAta(wallet, addresses.collateralMint))!.data.writeBigUInt64LE(2000000n, 64);
    const changes = new Map<string, bigint>();
    if (leg === 'wallet_funding' || leg === 'wallet_return') {
      changes.set(fundingAta(i.funding.sourceWallet, addresses.usdcMint), -1000000n); changes.set(fundingAta(i.destination, addresses.usdcMint), 1000000n);
    } else if (leg === 'deposit') {
      changes.set(fundingAta(wallet, addresses.usdcMint), -1000000n); changes.set(pin.emberVault, 1000000n); changes.set(pin.globalVault, 1000000n); changes.set(fundingAta(wallet, addresses.collateralMint), 0n);
    } else {
      changes.set(fundingAta(wallet, addresses.collateralMint), -1000000n); changes.set(fundingAta(wallet, addresses.usdcMint), 1000000n); changes.set(pin.emberVault, -1000000n);
    }
    f.rpc.simulateTransaction.mockImplementationOnce(async (_tx, config) => ({ value: { err: null, accounts: config.accounts.addresses.map((k: string) => {
      const original = f.map.get(k); if (!original) return null;
      const a = { ...original, data: Buffer.from(original.data) };
      if (k === i.funding.sourceWallet) a.lamports -= 5000;
      if (changes.has(k)) a.data.writeBigUInt64LE(a.data.readBigUInt64LE(64) + changes.get(k)!, 64);
      if (leg === 'deposit' && k === identity.traderAccountAddress) a.data.writeBigInt64LE(11000000n, 88);
      return { ...a, owner: a.owner.toBase58(), data: [a.data.toString('base64'), 'base64'] };
    }) } } as any));
    const tx = prepareFundingTransaction(i, pin, lifetime);
    expect(await f.native.io.quote(i, tx)).toMatchObject({ feeBaseUnits: '0', netBaseUnits: '1000000' });
    const signed = signFundingTransaction(tx, i, pin, key(leg === 'wallet_funding' ? 50 : 11).secretKey), message = tx.compileMessage();
    const keys = message.accountKeys.map(k => k.toBase58());
    const amounts = (after: boolean) => [...changes].map(([k, delta]) => ({ accountIndex: keys.indexOf(k), mint: new PublicKey(f.map.get(k)!.data.subarray(0, 32)).toBase58(),
      owner: new PublicKey(f.map.get(k)!.data.subarray(32, 64)).toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(),
      uiTokenAmount: { amount: (f.map.get(k)!.data.readBigUInt64LE(64) + (after ? delta : 0n)).toString(), decimals: 6 } }));
    const meta = { err: null, preTokenBalances: amounts(false), postTokenBalances: amounts(true) };
    f.rpc.getTransaction.mockResolvedValue({ slot: 100, transaction: { signatures: [signed.signature], message }, meta });
    f.operations.read.mockResolvedValue({ attempt: signed });
    const op = { id: 'EXAMPLE', bot_id: i.botId, intent: i, intent_hash: 'EXAMPLE', observation: {} } as any;
    expect(await f.native.io.receipt(op, signed.signature)).toMatchObject({ outcome: 'settled', creditedBaseUnits: '1000000' });
    meta.postTokenBalances[0].uiTokenAmount.amount = 'EXAMPLE';
    await expect(f.native.io.receipt(op, signed.signature)).rejects.toThrow();
  });
  it('keeps a queued generation pending even if its amount exceeds remaining collateral or its node vanishes', async () => {
    const f = fixture(), anchor = verifyFundingWithdrawal(events(true), pin, expected).queueAnchor!;
    f.map.set(pin.withdrawQueue, account(queue(true), addresses.program));
    f.map.get(identity.traderAccountAddress)!.data.writeBigInt64LE(0n, 88);
    const prior = { queueAnchor: anchor, slot: '100', outcome: 'queued', signature: 'EXAMPLE', creditedBaseUnits: '0' };
    const op = { intent: f.i, observation: { funding: { receipt: prior } } } as any;
    expect(await f.native.io.receipt(op, 'EXAMPLE')).toMatchObject({ outcome: 'queued', queueObservation: { position: 1, state: 'Queued' }, balances: { queued: '0', withdrawable: '0' } });
    f.map.set(pin.withdrawQueue, account(queue(), addresses.program));
    expect(await f.native.io.receipt(op, 'EXAMPLE')).toMatchObject({ outcome: 'queued', queueAnchor: anchor, queueObservation: { position: null } });
    expect(f.rpc.getTransaction).not.toHaveBeenCalled();
  });
  it('quotes finalized balances, simulation and exact gas, and rejects extra venue debit', async () => {
    const f = fixture(), tx = prepareFundingTransaction(f.i, pin, lifetime);
    expect(await f.native.io.quote(f.i, tx)).toMatchObject({ feeBaseUnits: '500000', netBaseUnits: '1000000', gasLamports: '5000', rentLamports: '0' });
    expect(f.rpc.getMultipleAccountsInfoAndContext.mock.calls[0][1]).toMatchObject({ commitment: 'finalized' });
    f.i.feeBaseUnits = '0'; f.i.funding.grossBaseUnits = '1000000';
    await expect(f.native.io.quote(f.i, tx)).rejects.toThrow('PHOENIX_LIVE_WITHDRAWAL_FEE_CHANGED');
    f.i.feeBaseUnits = '500000'; f.i.funding.grossBaseUnits = '1500001';
    await expect(f.native.io.quote(f.i, tx)).rejects.toThrow('PHOENIX_UNQUOTED_VENUE_DEBIT');
  });
  it('refuses predicted queues and unknown simulation, rather than assuming zero fees', async () => {
    const f = fixture(); f.map.get(pin.withdrawQueue)!.data.writeBigUInt64LE(0n, 32);
    await expect(f.native.io.quote(f.i, prepareFundingTransaction(f.i, pin, lifetime))).rejects.toThrow('PHOENIX_ENQUEUE_FEE_UNVERIFIED');
    f.map.get(pin.withdrawQueue)!.data.writeBigUInt64LE(100000000n, 32);
    f.rpc.simulateTransaction.mockResolvedValueOnce({ value: { err: { EXAMPLE: true }, accounts: null } } as any);
    await expect(f.native.io.quote(f.i, prepareFundingTransaction(f.i, pin, lifetime))).rejects.toThrow('PHOENIX_FUNDING_SIMULATION_FAILED');
  });
  it('requires history absence beyond expiry, not a cache miss or unfinalized failure', async () => {
    const f = fixture(); f.rpc.getSignatureStatuses.mockResolvedValue({ value: [null] }); f.rpc.getBlockHeight.mockResolvedValue(99);
    const attempt = { signature: 'EXAMPLE', transactionHash: 'EXAMPLE', blockhash: lifetime.blockhash, lastValidBlockHeight: '100' };
    expect(await f.native.io.signature(attempt)).toBe('unknown');
    f.rpc.getBlockHeight.mockResolvedValue(101); expect(await f.native.io.signature(attempt)).toBe('expired_absent');
    f.rpc.getSignatureStatuses.mockResolvedValue({ value: [{ confirmationStatus: 'confirmed', err: { EXAMPLE: true } }] });
    expect(await f.native.io.signature(attempt)).toBe('unknown');
  });
  it('requires the saved message hash and exact finalized token movements to settle', async () => {
    const f = fixture(), signed = signFundingTransaction(prepareFundingTransaction(f.i, pin, lifetime), f.i, pin, key(11).secretKey);
    const tx = Transaction.from(Buffer.from(signed.transaction, 'base64')), message = tx.compileMessage();
    const keys = message.accountKeys.map(k => k.toBase58());
    const tokenBalances = (after: boolean) => [pin.globalVault, fundingAta(identity.authorityWalletAddress, addresses.collateralMint)].map((k, n) => ({
      accountIndex: keys.indexOf(k), mint: addresses.collateralMint, owner: n ? identity.authorityWalletAddress : pin.globalVault,
      programId: TOKEN_PROGRAM_ID.toBase58(), uiTokenAmount: { amount: String(n ? after ? 1000000 : 0 : after ? 99000000 : 100000000), decimals: 6 } }));
    f.rpc.getTransaction.mockResolvedValue({ slot: 100, transaction: { signatures: [signed.signature], message }, meta: { err: null,
      preTokenBalances: tokenBalances(false), postTokenBalances: tokenBalances(true), innerInstructions: [{ index: 1, instructions: events().map(ix => ({
        programIdIndex: keys.indexOf(ix.program), accounts: ix.accounts.map(k => keys.indexOf(k)), data: bs58.encode(ix.data), stackHeight: ix.depth })) }] } });
    f.operations.read.mockResolvedValue({ attempt: signed });
    const op = { id: 'EXAMPLE', bot_id: f.i.botId, intent: f.i, intent_hash: 'EXAMPLE', observation: {} } as any;
    expect(await f.native.io.receipt(op, signed.signature)).toMatchObject({ outcome: 'settled', creditedBaseUnits: '1000000' });
    f.operations.read.mockResolvedValue({ attempt: { ...signed, transactionHash: createHash('sha256').update('EXAMPLE-altered').digest('hex') } });
    await expect(f.native.io.receipt(op, signed.signature)).rejects.toThrow('PHOENIX_RECEIPT_MESSAGE_HASH');
  });
});
