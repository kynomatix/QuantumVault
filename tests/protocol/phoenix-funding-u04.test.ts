import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Transaction, SystemProgram, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { createRequire } from 'node:module';
import { PhoenixOperationStore, phoenixIntentHash } from '../../server/protocol/phoenix/operation-store';
import { PhoenixProvisioningStore } from '../../server/protocol/phoenix/provisioning-store';
import { PhoenixFundingService, type PhoenixFundingIO } from '../../server/protocol/phoenix/funding-service';
import { fundingInstructions, prepareFundingTransaction, signFundingTransaction } from '../../server/protocol/phoenix/funding-builder';
import { units, type FundingIntent, type FundingReceipt } from '../../server/protocol/phoenix/funding-contract';
import { phoenixFundingDetail } from '../../server/protocol/phoenix/funding-detail';
import { PHOENIX_PUBLIC_ADDRESSES as addresses } from '../../server/protocol/phoenix/sdk-boundary';
import { phoenixMigrationFixture } from '../helpers/phoenix-schema';
import { key, authority, identity, lifetime } from '../helpers/phoenix-registration';

// The repository's SPL declarations omit these runtime exports. Load the actual
// official library here as an independent byte/account oracle, never a mock.
const { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction, createApproveInstruction } = createRequire(import.meta.url)('@solana/spl-token');

const pin = { logAuthority: key(40).publicKey.toBase58(), globalConfiguration: key(41).publicKey.toBase58(),
  globalVault: key(42).publicKey.toBase58(), perpAssetMap: key(43).publicKey.toBase58(), withdrawQueue: key(44).publicKey.toBase58(),
  emberState: key(45).publicKey.toBase58(), emberVault: key(46).publicKey.toBase58(),
  globalTraderIndex: [key(47).publicKey.toBase58()], activeTraderBuffer: [key(48).publicKey.toBase58()] };
const owner = 'EXAMPLE-owner';
const schemaName = `phoenix_u04_${randomUUID().replaceAll('-', '')}`;
let pool: pg.Pool, bootstrap: pg.Pool, operations: PhoenixOperationStore, botId: string, enabled: boolean;
let outcome: FundingReceipt['outcome'], fee: string;
const io = { quote: vi.fn(), lifetime: vi.fn(), blockHeight: vi.fn(), withSigner: vi.fn(), submit: vi.fn(), signature: vi.fn(), receipt: vi.fn() };
const service = () => new PhoenixFundingService(operations, io as PhoenixFundingIO, pin, () => enabled);
function intent(leg: FundingIntent['funding']['leg'] = 'deposit', parentOperationId?: string): FundingIntent {
  return { botId, ownerWallet: owner, requestKey: `EXAMPLE-${leg}`, identity, kind: leg === 'deposit' ? 'deposit' : leg === 'withdraw' ? 'withdraw' : 'transfer',
    mint: addresses.usdcMint, amountBaseUnits: '1000000', feeBaseUnits: leg === 'withdraw' ? fee : '0',
    destination: leg === 'deposit' ? identity.traderAccountAddress : leg === 'wallet_return' ? key(50).publicKey.toBase58() : identity.authorityWalletAddress,
    funding: { leg, ...(parentOperationId ? { parentOperationId } : {}),
      sourceWallet: leg === 'wallet_funding' ? key(50).publicKey.toBase58() : identity.authorityWalletAddress,
      grossBaseUnits: String(1000000n + BigInt(leg === 'withdraw' ? fee : '0')), minimumBaseUnits: '1', maxGasLamports: '20000',
      quoteSource: 'EXAMPLE-reviewed-observer', quoteReference: 'EXAMPLE-quote', quoteExpiresAt: Date.now() + 600000 } };
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url || new URL(url).pathname !== '/qvtest') throw new Error('U04 tests require FRACTAL qvtest');
  bootstrap = new pg.Pool({ connectionString: url }); await bootstrap.query(`CREATE SCHEMA ${schemaName}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schemaName}`, max: 10 });
  await pool.query(`CREATE TABLE wallets (address text PRIMARY KEY, next_bot_derivation_index integer NOT NULL DEFAULT 1);
    CREATE TABLE trading_bots (id varchar PRIMARY KEY, wallet_address text NOT NULL REFERENCES wallets(address),
      name text, market text, webhook_secret text, is_active boolean, total_investment numeric, leverage integer,
      max_position_size numeric(20,2), subaccount_auth_mode text, subaccount_status text, policy_hmac text, updated_at timestamptz,
      active_protocol text NOT NULL, protocol_subaccount_id text, derivation_index integer, derivation_path_version integer,
      bot_subaccount_key_encrypted text, bot_subaccount_key_encrypted_v3 text,
      CONSTRAINT trading_bots_active_protocol_check CHECK (active_protocol IN ('pacifica','drift','flash')),
      CONSTRAINT trading_bots_wallet_derivation_index_unique UNIQUE(wallet_address, derivation_index));`);
  await pool.query(phoenixMigrationFixture().phoenix.sql); operations = new PhoenixOperationStore(pool);
}, 30000);
afterAll(async () => { await pool?.end(); if (bootstrap) { await bootstrap.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`); await bootstrap.end(); } });
beforeEach(async () => {
  vi.resetAllMocks(); enabled = true; outcome = 'settled'; fee = '0';
  await pool.query('TRUNCATE phoenix_operation_attempts, phoenix_operations, trading_bots, wallets');
  await pool.query('INSERT INTO wallets(address) VALUES ($1)', [owner]);
  const register = await new PhoenixProvisioningStore(pool).allocateAndDerive({ ownerWallet: owner, requestId: 'EXAMPLE-registration',
    name: 'EXAMPLE-bot', market: 'SOL', maxPositions: 32, maxCostLamports: '20000' }, async () => ({ authority: authority.publicKey.toBase58(),
    encryptedKey: 'EXAMPLE-ciphertext', policyHmac: 'EXAMPLE-policy' }));
  botId = register.bot_id;
  // U03's accepted registration is the fixture precondition, not a simulated network send.
  await pool.query("UPDATE phoenix_operations SET state = 'completed' WHERE id = $1", [register.id]);
  io.lifetime.mockResolvedValue(lifetime); io.blockHeight.mockResolvedValue(1); io.signature.mockResolvedValue('confirmed');
  io.quote.mockImplementation(async (i: FundingIntent) => ({ minimumBaseUnits: i.funding.minimumBaseUnits, feeBaseUnits: i.feeBaseUnits,
    grossBaseUnits: i.funding.grossBaseUnits, netBaseUnits: i.amountBaseUnits, gasLamports: '5000', rentLamports: '1000',
    availableLamports: '100000', availableBaseUnits: '10000000', source: i.funding.quoteSource, reference: i.funding.quoteReference, expiresAt: i.funding.quoteExpiresAt }));
  io.withSigner.mockImplementation(async (i: FundingIntent, sign: (secret: Uint8Array) => unknown) => {
    const secret = key(i.funding.leg === 'wallet_funding' ? 50 : 11).secretKey;
    try { return sign(secret); } finally { secret.fill(0); }
  });
  io.submit.mockImplementation(async wire => bs58.encode(Transaction.from(Buffer.from(wire, 'base64')).signature!));
  io.receipt.mockImplementation(async (op, signature): Promise<FundingReceipt> => ({ source: 'EXAMPLE-finalized-observer', reference: 'EXAMPLE-receipt',
    signature, intentHash: op.intent_hash, outcome, finalized: true, slot: '100', observedAt: Date.now(),
    ...(op.kind === 'withdraw' ? { queueRequestId: 'EXAMPLE-queue-id' } : {}),
    balances: { sourceWalletUsdc: op.intent.funding.leg === 'wallet_funding' ? '8000000' : '1000000', botWalletUsdc: '1000000', botWalletCollateral: '1000000', venueCollateral: '5000000',
      destinationWalletUsdc: ['wallet_funding', 'wallet_return'].includes(op.intent.funding.leg) ? '1000000' : null,
      withdrawable: '4000000', queued: outcome === 'queued' ? '1000000' : '0' }, creditedBaseUnits: outcome === 'settled' ? '1000000' : '0' }));
});

describe('U04 atomic funding builders', () => {
  it('matches official SPL bytes, account order and signer/writable flags for ATA, transfer and approve', () => {
    const mint = new PublicKey(addresses.usdcMint), a = authority.publicKey, source = key(50).publicKey;
    const destAta = getAssociatedTokenAddressSync(mint, a);
    expect(fundingInstructions(intent('wallet_funding'), pin)).toEqual([
      createAssociatedTokenAccountIdempotentInstruction(source, destAta, a, mint),
      createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint, source), mint, destAta, source, 1000000n, 6),
    ]);
    expect(fundingInstructions(intent('unwrap', 'EXAMPLE-parent'), pin)[1]).toEqual(createApproveInstruction(
      getAssociatedTokenAddressSync(new PublicKey(addresses.collateralMint), a), new PublicKey(pin.emberState), a, 1000000n));
  });
  it('wraps and deposits in one atomic transaction with one signer and idempotent ATA creation', () => {
    const i = intent(); const tx = prepareFundingTransaction(i, pin, lifetime); const signed = signFundingTransaction(tx, i, pin, key(11).secretKey);
    expect(tx.instructions.map(ix => ix.programId.toBase58())).toEqual([ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), addresses.emberProgram, addresses.program]);
    expect(tx.instructions[0].data[0]).toBe(1); expect(tx.instructions[1].data.readBigUInt64LE(8)).toBe(1000000n);
    expect(tx.instructions[2].data.readBigUInt64LE(8)).toBe(1000000n);
    expect(Transaction.from(Buffer.from(signed.transaction, 'base64')).verifySignatures()).toBe(true);
    expect(tx.instructions[2].keys[5].pubkey.toBase58()).toBe(identity.traderAccountAddress);
  });
  it('does not unwrap a queued request; a separately parent-bound unwrap uses approve and Ember Some(amount)', () => {
    expect(fundingInstructions(intent('withdraw'), pin).map(ix => ix.programId.toBase58())).toEqual([ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), addresses.program]);
    const unwrap = fundingInstructions(intent('unwrap', 'EXAMPLE-parent'), pin);
    expect(unwrap.map(ix => ix.programId.toBase58())).toEqual([ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), TOKEN_PROGRAM_ID.toBase58(), addresses.emberProgram]);
    expect(unwrap[2].data.length).toBe(17); expect(unwrap[2].data[8]).toBe(1); expect(unwrap[2].data.readBigUInt64LE(9)).toBe(1000000n);
  });
  it('rejects wrong authority, mint, net/fee arithmetic, u64 overflow, destination and injected instructions', () => {
    const i = intent();
    expect(() => fundingInstructions({ ...i, mint: addresses.collateralMint }, pin)).toThrow();
    expect(() => fundingInstructions({ ...i, destination: key(60).publicKey.toBase58() }, pin)).toThrow();
    expect(() => fundingInstructions({ ...i, feeBaseUnits: '1' }, pin)).toThrow();
    expect(() => units('18446744073709551616')).toThrow();
    const tx = prepareFundingTransaction(i, pin, lifetime);
    expect(() => signFundingTransaction(tx, i, pin, key(60).secretKey)).toThrow();
    tx.add(SystemProgram.transfer({ fromPubkey: key(11).publicKey, toPubkey: key(60).publicKey, lamports: 1 }));
    expect(() => signFundingTransaction(tx, i, pin, key(11).secretKey)).toThrow('message mismatch');
  });
});

describe('U04 durable recovery on isolated PostgreSQL', () => {
  it('persists the signature before submission and binds replay identity to every immutable field', async () => {
    const i = intent();
    io.submit.mockImplementation(async wire => { expect((await operations.fundingHistory(botId, owner))[0].state).toBe('submission_pending');
      return bs58.encode(Transaction.from(Buffer.from(wire, 'base64')).signature!); });
    const op = await service().create(i); expect(op.state).toBe('completed');
    expect((await service().create(i)).id).toBe(op.id); expect(io.submit).toHaveBeenCalledTimes(1);
    await expect(service().create({ ...i, feeBaseUnits: '1' })).rejects.toThrow();
    await expect(service().create({ ...i, funding: { ...i.funding, maxGasLamports: '30000' } })).rejects.toThrow('replay payload mismatch');
    await expect(operations.read(botId, 'EXAMPLE-other-owner', op.id)).rejects.toThrow('not owned');
  });
  it('reconciles ambiguous broadcast after restart with new risk disabled without signing or sending twice', async () => {
    io.submit.mockRejectedValue(new Error('EXAMPLE-timeout')); const op = await service().create(intent()); expect(op.state).toBe('submission_pending');
    enabled = false; io.signature.mockResolvedValue('unknown');
    expect((await service().recover(botId, owner))[0].state).toBe('unknown');
    io.signature.mockRejectedValueOnce(new Error('EXAMPLE-rpc-outage')); expect((await service().recover(botId, owner))[0].state).toBe('unknown');
    io.signature.mockResolvedValue('confirmed'); expect((await service().recover(botId, owner))[0].state).toBe('completed');
    expect(io.withSigner).toHaveBeenCalledTimes(1); expect(io.submit).toHaveBeenCalledTimes(1);
  });
  it('survives queue restart and duplicate receipts, measures release, and keeps unwrap distinct from cash return', async () => {
    outcome = 'queued'; const withdrawal = await service().create(intent('withdraw')); expect(withdrawal.state).toBe('queued');
    enabled = false; await service().recover(botId, owner);
    let h = (await operations.fundingHistory(botId, owner))[0].observation!.funding as any;
    expect(h.events).toHaveLength(1); const queuedAt = h.queuedAt;
    io.signature.mockRejectedValue(new Error('EXAMPLE-signature-rpc-outage')); outcome = 'settled';
    const released = (await service().recover(botId, owner))[0]; expect(released.state).toBe('completed');
    h = released.observation!.funding as any; expect(h.queuedAt).toBe(queuedAt); expect(h.events).toHaveLength(2);
    const detail = phoenixFundingDetail([released]); expect(detail.measured?.samples).toBe(1); expect(detail.operations[0].walletCashConfirmed).toBe(false);
    enabled = true; io.signature.mockResolvedValue('confirmed'); const unwrapped = await service().create(intent('unwrap', withdrawal.id));
    expect(unwrapped.state).toBe('completed'); expect(phoenixFundingDetail([unwrapped]).operations[0].walletCashConfirmed).toBe(true);
    const returned = await service().create(intent('wallet_return', unwrapped.id)); expect(returned.state).toBe('completed');
    expect(phoenixFundingDetail([returned]).lastSnapshot).toMatchObject({ destinationWallet: key(50).publicKey.toBase58(), balances: { destinationWalletUsdc: '1000000' } });
    await expect(service().create({ ...intent('unwrap', withdrawal.id), requestKey: 'EXAMPLE-second-unwrap' })).rejects.toThrow('already consumed');
  });
  it('records insufficient margin at queue head as dropped, never completed, with no invented queue timestamp', async () => {
    outcome = 'dropped'; const op = await service().create(intent('withdraw')); expect(op.state).toBe('dropped');
    const detail = phoenixFundingDetail([op]); expect(detail.measured).toBeNull(); expect(detail.droppedSamples).toBe(1);
    expect(detail.operations[0].queuedAt).toBeUndefined(); expect(detail.operations[0].completedAt).toBeUndefined();
    await expect(service().create(intent('unwrap', op.id))).rejects.toThrow('parent not settled');
  });
  it('rejects mismatched receipt identity, queue id, state and double-counted custody evidence', async () => {
    outcome = 'queued'; const op = await service().create(intent('withdraw'));
    const valid = await io.receipt(op, (await operations.read(botId, owner, op.id)).attempt!.signature);
    for (const changed of [{ ...valid, queueRequestId: 'EXAMPLE-other' }, { ...valid, creditedBaseUnits: '1' },
      { ...valid, slot: '99' }, { ...valid, balances: { ...valid.balances, sourceWalletUsdc: '2' } },
      { ...valid, balances: { ...valid.balances, queued: '999999999' } }, { ...valid, intentHash: 'EXAMPLE-invalid-hash' }]) {
      io.receipt.mockResolvedValueOnce(changed); expect((await service().recover(botId, owner))[0].state).toBe('queued');
    }
    await expect(operations.observe(botId, owner, op.id, (await operations.read(botId, owner, op.id)).operation.revision,
      'completed', { source: valid.source, reference: valid.reference, fundingReceipt: valid })).rejects.toThrow('state mismatch');
  });
  it('requires the actual wallet destination balance and rejects contradictory aliases', async () => {
    io.submit.mockRejectedValue(new Error('EXAMPLE-timeout')); const op = await service().create(intent('wallet_funding'));
    const valid = await io.receipt(op, (await operations.read(botId, owner, op.id)).attempt!.signature);
    for (const destinationWalletUsdc of [null, '2']) {
      io.receipt.mockResolvedValueOnce({ ...valid, balances: { ...valid.balances, destinationWalletUsdc } });
      expect((await service().recover(botId, owner))[0].state).toBe('unknown');
    }
    expect((await service().recover(botId, owner))[0].state).toBe('completed');
    expect(io.submit).toHaveBeenCalledTimes(1);
  });
  it('uses durable UTC request time even when legacy database timestamps have a different timezone', async () => {
    const i = intent(); const { operation } = await operations.prepare(i);
    await pool.query("UPDATE phoenix_operations SET created_at = now() + interval '11 hours' WHERE id = $1", [operation.id]);
    const op = await service().resume(botId, owner, operation.id); expect(op.state).toBe('completed');
    expect((op.observation!.funding as any).requestedAt).toBe((operation.observation!.funding as any).requestedAt);
  });
  it('retains a real queue timestamp when a later head-of-queue check drops the request', async () => {
    outcome = 'queued'; const op = await service().create(intent('withdraw'));
    outcome = 'dropped'; enabled = false; const dropped = (await service().recover(botId, owner))[0];
    expect(dropped.state).toBe('dropped'); expect((dropped.observation!.funding as any).queuedAt).toBe((op.observation!.funding as any).queuedAt);
    expect(phoenixFundingDetail([dropped]).measured).toBeNull(); expect(io.submit).toHaveBeenCalledTimes(1);
  });
  it('allows a new signature only after finalized failure, preserves identity, and bounds attempts', async () => {
    const i = intent(); io.signature.mockResolvedValue('expired_absent');
    let op = await service().create(i); expect(op.state).toBe('prepared');
    for (let n = 1; n < 5; n++) { io.lifetime.mockResolvedValue({ ...lifetime, blockhash: key(60 + n).publicKey.toBase58() }); op = await service().resume(botId, owner, op.id); }
    io.lifetime.mockResolvedValue({ ...lifetime, blockhash: key(70).publicKey.toBase58() }); await service().resume(botId, owner, op.id);
    expect(io.submit).toHaveBeenCalledTimes(5); expect(op.intent_hash).toBe(phoenixIntentHash(i));
  });
  it('serializes duplicate sends under database locks', async () => {
    const i = intent(); const result = await Promise.allSettled(Array.from({ length: 4 }, () => service().create(i)));
    expect(result.some(r => r.status === 'fulfilled')).toBe(true); expect(io.submit).toHaveBeenCalledTimes(1);
    expect((await operations.fundingHistory(botId, owner))).toHaveLength(1);
  });
  it('recovers wallet-funded but not deposited workflow without crediting venue margin', async () => {
    const wallet = await service().create(intent('wallet_funding')); expect(wallet.state).toBe('completed');
    enabled = false; expect((await service().recover(botId, owner))).toHaveLength(1);
    expect(io.submit).toHaveBeenCalledTimes(1); enabled = true;
    const deposit = await service().create(intent('deposit', wallet.id)); expect(deposit.state).toBe('completed');
    expect((await operations.fundingHistory(botId, owner))).toHaveLength(2);
  });
  it('uses verified quote values for minimum, fee, net and gas, without an app fee constant', async () => {
    fee = '37'; const i = intent('withdraw'); const quote = await service().preview(i);
    expect(quote).toMatchObject({ feeBaseUnits: '37', netBaseUnits: '1000000', grossBaseUnits: '1000037', gasLamports: '5000', rentLamports: '1000' });
    expect(fundingInstructions(i, pin)[1].data.readBigUInt64LE(8)).toBe(1000037n);
    io.quote.mockResolvedValueOnce({ ...quote, feeBaseUnits: '500000' }); await expect(service().create(i)).rejects.toThrow('changed');
    expect(io.withSigner).not.toHaveBeenCalled();
  });
  it.each(['gas', 'margin', 'expired', 'height', 'revoked'])('refuses %s before sending', async reason => {
    const i = intent(); const quote = await service().preview(i);
    if (reason === 'gas') io.quote.mockResolvedValue({ ...quote, availableLamports: '1' });
    if (reason === 'margin') io.quote.mockResolvedValue({ ...quote, availableBaseUnits: '1' });
    if (reason === 'expired') i.funding.quoteExpiresAt = Date.now() - 1;
    if (reason === 'height') io.blockHeight.mockResolvedValue(101);
    if (reason === 'revoked') io.blockHeight.mockImplementation(async () => { enabled = false; return 1; });
    await service().create(i).catch(() => {}); expect(io.submit).not.toHaveBeenCalled();
  });
});
