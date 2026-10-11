import { describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { Transaction } from '@solana/web3.js';
import { PhoenixParkingExecutor } from '../../server/protocol/phoenix/parking-executor';
import type { ParkingRecord, ParkingSnapshot } from '../../server/protocol/phoenix/parking-contract';
import type { StoredPhoenixOperation } from '../../server/protocol/phoenix/operation-store';
import type { FundingIntent } from '../../server/protocol/phoenix/funding-contract';
import { PhoenixOrderService } from '../../server/protocol/phoenix/order-service';
import { admitPhoenixOrder, orderIntentHash } from '../../server/protocol/phoenix/order-contract';
import type { PhoenixOrderRecord, OrderRepository } from '../../server/protocol/phoenix/order-store';
import { parkingIntentForOrder } from '../../server/protocol/phoenix/parking-order-funding';
import { PHOENIX_PUBLIC_ADDRESSES } from '../../server/protocol/phoenix/sdk-boundary';
import { authority, identity, intent, key, lifetime, now, pin } from '../helpers/phoenix-orders';

function fixture(kind: 'park' | 'withdraw' = 'park') {
  let r: ParkingRecord = { id: 'EXAMPLE-park-id', revision: 1, state: 'active', intent_hash: orderIntentHash('EXAMPLE-intent'),
    intent: { botId: intent().botId, ownerWallet: intent().ownerWallet, requestKey: 'EXAMPLE-park', identity,
      action: 'idle', maxUsdc: '100', destination: 'EXAMPLE-yield', mode: 'shortfall' },
    legs: [{ leg: { key: 'EXAMPLE-park-id:0', kind, amount: '100', asset: kind === 'park' ? 'EXAMPLE-yield' : null } }] };
  const s: ParkingSnapshot = { botId: r.intent.botId, authority: identity.authorityWalletAddress, trader: identity.traderAccountAddress,
    observedAt: now, slot: '100', complete: true, source: 'EXAMPLE-reader', reference: 'EXAMPLE-proof', autoPark: true,
    entryAuthorized: false, lifecycleActive: true, destination: 'EXAMPLE-yield', destinationEnabled: true,
    walletUsdc: '100', withdrawableUsdc: '0', pendingReturnUsdc: '0', freeMarginUsdc: '0', marketsComplete: true,
    protections: [authority().protection!], holdings: [] };
  const signature = bs58.encode(new Uint8Array(64).fill(9));
  const snapshot = vi.fn(async () => structuredClone(s));
  const store = { recordVaultAttempt: vi.fn(async (_r: ParkingRecord, attempt: any) => {
    r = structuredClone(_r); r.legs[0].attempt = attempt; r.revision++; return structuredClone(r);
  }) };
  const vault = { prepare: vi.fn(async () => ({ transaction: Buffer.from('EXAMPLE-synthetic-transaction').toString('base64'), signature, lastValidBlockHeight: '500' })),
    submit: vi.fn(async () => { expect(r.legs[0].attempt?.signature).toBe(signature); return signature; }),
    receipt: vi.fn(async () => ({ key: r.legs[0].leg.key, state: 'settled' as const, signature, finalized: true as const,
      spent: '100', received: '98', slot: '100', source: 'EXAMPLE-chain', reference: 'EXAMPLE-receipt' })) };
  let history: StoredPhoenixOperation[] = [];
  const operations = { fundingHistory: vi.fn(async () => history) };
  const funding = { create: vi.fn(async () => ({} as any)), resume: vi.fn(async () => history[0]) };
  const build = vi.fn(async (record: ParkingRecord, leg: ParkingRecord['legs'][number]['leg']): Promise<FundingIntent> => ({
    botId: record.intent.botId, ownerWallet: record.intent.ownerWallet, requestKey: leg.key, kind: 'withdraw', identity,
    parkingIntentId: record.id, destination: identity.authorityWalletAddress, mint: PHOENIX_PUBLIC_ADDRESSES.usdcMint,
    amountBaseUnits: leg.amount, feeBaseUnits: '0', funding: { leg: 'withdraw', grossBaseUnits: leg.amount,
      sourceWallet: identity.authorityWalletAddress, minimumBaseUnits: '1', maxGasLamports: '1000',
      quoteSource: 'EXAMPLE-quote', quoteReference: 'EXAMPLE-reference', quoteExpiresAt: now + 5000 } }));
  let enabled = true;
  const executor = new PhoenixParkingExecutor(snapshot, store, funding, operations, build, vault, () => enabled, () => now);
  return { executor, snapshot, s, store, vault, funding, build, record: () => structuredClone(r), leg: () => r.legs[0].leg,
    setHistory: (value: StoredPhoenixOperation[]) => { history = value; }, disable: () => { enabled = false; } };
}
describe('U10 transfer boundary, mocked RPC/API only', () => {
  it('persists the signed vault attempt before any broadcast', async () => {
    const f = fixture(); await f.executor.submit(f.record(), f.leg());
    expect(f.store.recordVaultAttempt).toHaveBeenCalledTimes(1); expect(f.vault.submit).toHaveBeenCalledTimes(1);
    expect(f.record().legs[0].attempt?.transactionHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it('never broadcasts after losing attempt persistence acknowledgement', async () => {
    const f = fixture(); f.store.recordVaultAttempt.mockRejectedValue(new Error('EXAMPLE-lost-ack'));
    await expect(f.executor.submit(f.record(), f.leg())).rejects.toThrow(); expect(f.vault.submit).not.toHaveBeenCalled();
  });
  it.each(['optout','gate'])('rechecks %s after preparing a transaction', async mode => {
    const f = fixture(), original = f.vault.prepare.getMockImplementation()!;
    f.vault.prepare.mockImplementation(async () => { const result = await original(); if (mode === 'optout') f.s.autoPark = false; else f.disable(); return result; });
    await expect(f.executor.submit(f.record(), f.leg())).rejects.toThrow(); expect(f.vault.submit).not.toHaveBeenCalled();
    expect(f.store.recordVaultAttempt).not.toHaveBeenCalled();
  });
  it('observes only the persisted signature and never trusts an unclaimed vault receipt', async () => {
    const f = fixture(); expect(await f.executor.receipt(f.record(), f.leg())).toBeNull();
    expect(f.vault.receipt).not.toHaveBeenCalled(); await f.executor.submit(f.record(), f.leg()); f.disable();
    expect((await f.executor.receipt(f.record(), f.leg()))?.received).toBe('98');
    f.vault.receipt.mockResolvedValue({ ...(await f.vault.receipt()), signature: bs58.encode(new Uint8Array(64).fill(10)) });
    await expect(f.executor.receipt(f.record(), f.leg())).rejects.toThrow('Unbound');
  });
  it('binds each U04 child to exact amount, bot and durable park identity', async () => {
    const f = fixture('withdraw'); await f.executor.submit(f.record(), f.leg());
    expect(f.funding.create).toHaveBeenCalledTimes(1);
    const original = f.build.getMockImplementation()!;
    f.build.mockImplementation(async (r, l) => ({ ...await original(r, l), parkingIntentId: 'EXAMPLE-other' }));
    await expect(f.executor.submit(f.record(), f.leg())).rejects.toThrow('mismatch');
    expect(f.funding.create).toHaveBeenCalledTimes(1);
  });
  it('observes queued funding without cash credit and never signs a prepared child during recovery', async () => {
    const f = fixture('withdraw'), i = await f.build(f.record(), f.leg());
    const op = { id: 'EXAMPLE-operation', request_key: f.leg().key, intent: i, state: 'prepared' } as StoredPhoenixOperation;
    f.setHistory([op]); expect(await f.executor.receipt(f.record(), f.leg())).toBeNull(); expect(f.funding.resume).not.toHaveBeenCalled();
    op.state = 'queued'; op.observation = { funding: { receipt: { source: 'EXAMPLE-observer', reference: 'EXAMPLE-queue', slot: '100', creditedBaseUnits: '0' } } };
    f.disable(); expect(await f.executor.receipt(f.record(), f.leg())).toMatchObject({ state: 'pending', received: '0', spent: '0' });
    expect(f.funding.resume).toHaveBeenCalledTimes(1); expect(f.funding.create).not.toHaveBeenCalled();
  });
});

describe('U10 signal funding resumes U05 before signing', () => {
  it('keeps the original order identity across queue delay and refreshes margin after settlement', async () => {
    const a = authority(); a.entry!.freeMarginMicros = '0'; a.entry!.fundableMicros = '200000000';
    let r: PhoenixOrderRecord | null = null;
    const store: OrderRepository = {
      find: async () => structuredClone(r), read: async () => structuredClone(r!),
      prepare: async (i, admission) => { r = { id: 'EXAMPLE-order', intent: i, intent_hash: orderIntentHash(i), revision: 0, state: 'admitted', data: { admission } };
        return { record: structuredClone(r), created: true }; },
      change: async (record, state, data) => { if (record.revision !== r!.revision) throw new Error('EXAMPLE-stale');
        r = { ...r!, state, revision: r!.revision + 1, data: { ...r!.data, ...data } }; return structuredClone(r); },
    };
    let settled = false;
    const io = { snapshot: vi.fn(async () => structuredClone(a)),
      fund: vi.fn(async (order: PhoenixOrderRecord) => { expect(parkingIntentForOrder(order, 'shortfall').executionOrderId).toBe('EXAMPLE-order');
        if (!settled) throw new Error('EXAMPLE-queued'); a.entry!.freeMarginMicros = '200000000'; }),
      lifetime: async () => lifetime, blockHeight: async () => 400,
      withSigner: vi.fn(async (_i: any, fn: any) => fn(key.secretKey)),
      submit: vi.fn(async (tx: string) => bs58.encode(Transaction.from(Buffer.from(tx, 'base64')).signature!)), receipt: async () => null };
    const service = () => new PhoenixOrderService(store, io, pin, () => true, () => now);
    expect((await service().execute(intent())).state).toBe('funding'); expect(io.withSigner).not.toHaveBeenCalled();
    expect((await service().execute(intent())).state).toBe('funding');
    settled = true; expect((await service().execute(intent())).state).toBe('accepted');
    expect(io.withSigner).toHaveBeenCalledTimes(1); expect(io.submit).toHaveBeenCalledTimes(1);
    expect(r!.data.admission.authority.entry!.freeMarginMicros).toBe('200000000');
  });
});
