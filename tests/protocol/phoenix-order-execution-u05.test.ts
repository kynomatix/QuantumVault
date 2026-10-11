import { describe, expect, it, vi } from 'vitest';
import { Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { PhoenixOrderService, type PhoenixOrderIO, type PhoenixOrderReceipt } from '../../server/protocol/phoenix/order-service';
import { orderIntentHash, type PhoenixOrderIntent } from '../../server/protocol/phoenix/order-contract';
import type { OrderRepository, PhoenixOrderRecord } from '../../server/protocol/phoenix/order-store';
import { authority, intent, key, lifetime, now, pin } from '../helpers/phoenix-orders';

function harness(enabled = true) {
  let row: PhoenixOrderRecord | undefined, time = now;
  let snapshot = authority();
  let receipt: PhoenixOrderReceipt | null = null;
  const store: OrderRepository = {
    async find(i) {
      if (row && row.intent_hash !== orderIntentHash(i)) throw new Error('Replay payload mismatch');
      return row ? structuredClone(row) : null;
    },
    async read(i) { return (await this.find(i))!; },
    async prepare(i, admission) {
      if (row) return { record: structuredClone(row), created: false };
      row = { id: 'EXAMPLE-intent', intent: i, intent_hash: orderIntentHash(i), state: 'admitted', revision: 0, data: { admission } };
      return { record: structuredClone(row), created: true };
    },
    async change(record, state, patch) {
      if (row!.revision !== record.revision) throw new Error('Stale transition');
      row = { ...row!, state, revision: row!.revision + 1, data: { ...row!.data, ...patch } };
      return structuredClone(row);
    },
  };
  const io: PhoenixOrderIO = {
    snapshot: vi.fn(async () => structuredClone(snapshot)),
    fund: vi.fn(async () => { snapshot.entry!.freeMarginMicros = '1000000000'; }),
    lifetime: vi.fn(async () => lifetime), blockHeight: vi.fn(async () => 400),
    withSigner: vi.fn(async (_i, fn) => fn(key.secretKey)),
    submit: vi.fn(async tx => {
      const signature = bs58.encode(Transaction.from(Buffer.from(tx, 'base64')).signature!);
      expect(row!.state).toBe('submission_pending'); expect(row!.data.attempt!.signature).toBe(signature);
      return signature;
    }),
    receipt: vi.fn(async () => receipt),
  };
  const service = new PhoenixOrderService(store, io, pin, () => enabled, () => time);
  return { service, store, io, setTime: (n: number) => { time = n; }, disable: () => { enabled = false; },
    snapshot, setSnapshot: (a: typeof snapshot) => { snapshot = a; }, row: () => row!,
    setReceipt: (patch: Partial<PhoenixOrderReceipt> = {}) => {
      receipt = { venue: 'phoenix', trader: row!.intent.identity.traderAccountAddress, market: 'SOL',
        intentId: row!.id, signature: row!.data.attempt!.signature, orderId: 'EXAMPLE-order',
        positionEpoch: snapshot.position.epoch, source: 'EXAMPLE-observer', reference: 'EXAMPLE-receipt',
        landed: true, complete: true, fills: [], ...patch };
    } };
}
const fill = (baseLots = '80', quoteMicros = '119500000') => ({ fillId: 'EXAMPLE-fill', orderId: 'EXAMPLE-order', baseLots, quoteMicros, feeMicros: '40000' });

describe('Phoenix authoritative execution, synthetic signer and mocked IO only', () => {
  it('persists before sending and separates acceptance from actual fills', async () => {
    const h = harness(), i = intent();
    expect((await h.service.execute(i)).state).toBe('accepted');
    expect(h.row().data.fills).toBeUndefined();
    h.setReceipt({ fills: [fill(), fill()] });
    const r = await h.service.execute(i);
    expect(r.state).toBe('settled'); expect(r.data.fills).toEqual([fill()]);
    expect(r.data.remainingLots).toBe('120');
    // Actual execution value is explicitly different from either mark or submit limit.
    expect(r.data.fills![0].quoteMicros).toBe('119500000');
    expect(r.data.outcomeSource).toBe('EXAMPLE-observer');
    await h.service.execute(i); expect(h.io.submit).toHaveBeenCalledTimes(1); expect(h.io.fund).not.toHaveBeenCalled();
  });
  it('retains unknown sends across retries and reconciles without resubmission', async () => {
    const h = harness(); vi.mocked(h.io.submit).mockRejectedValue(new Error('EXAMPLE timeout'));
    expect((await h.service.execute(intent())).state).toBe('unknown');
    expect(h.row().data.attempt?.signature).toBeTruthy();
    await h.service.execute(intent()); expect(h.io.submit).toHaveBeenCalledTimes(1);
    h.setReceipt({ fills: [fill()] });
    expect((await h.service.execute(intent())).state).toBe('settled');
  });
  it('claims only one signing attempt during simultaneous duplicate ingress', async () => {
    const h = harness();
    await Promise.all([h.service.execute(intent()), h.service.execute(intent()), h.service.execute(intent())]);
    expect(h.io.withSigner).toHaveBeenCalledTimes(1); expect(h.io.submit).toHaveBeenCalledTimes(1);
    await expect(h.service.execute(intent({ baseUnits: '3' }))).rejects.toThrow('Replay');
  });
  it('denies a bad deployment pin before funding or signing', async () => {
    const h = harness(); h.snapshot.entry!.freeMarginMicros = '0'; h.snapshot.entry!.fundableMicros = '200000000';
    const bad = new PhoenixOrderService(h.store, h.io, { ...pin, assetId: 9 }, () => true, () => now);
    await expect(bad.execute(intent())).rejects.toThrow('pin');
    expect(h.io.fund).not.toHaveBeenCalled(); expect(h.io.withSigner).not.toHaveBeenCalled();
  });
  it('refreshes after the durable claim, before any funding side effect', async () => {
    const h = harness(); h.snapshot.entry!.freeMarginMicros = '0'; h.snapshot.entry!.fundableMicros = '200000000';
    vi.mocked(h.io.snapshot).mockResolvedValueOnce(structuredClone(h.snapshot)).mockImplementation(async () => {
      const stale = structuredClone(h.snapshot); stale.entry!.feeObservedAt -= 5000; return stale;
    });
    expect((await h.service.execute(intent())).state).toBe('rejected');
    expect(h.io.fund).not.toHaveBeenCalled(); expect(h.io.withSigner).not.toHaveBeenCalled();
  });
  it('rejects quote expiry across funding without signing or resending funds', async () => {
    const h = harness(); h.snapshot.entry!.freeMarginMicros = '0'; h.snapshot.entry!.fundableMicros = '200000000';
    vi.mocked(h.io.fund).mockImplementation(async () => { h.snapshot.entry!.freeMarginMicros = '200000000'; h.setTime(now + 5000); });
    expect((await h.service.execute(intent())).state).toBe('unknown');
    await h.service.execute(intent());
    expect(h.io.fund).toHaveBeenCalledTimes(1); expect(h.io.withSigner).not.toHaveBeenCalled(); expect(h.io.submit).not.toHaveBeenCalled();
  });
  it.each(['price', 'fee', 'margin', 'switch', 'position'] as const)('rechecks %s authority before signing', async changed => {
    const h = harness(); h.snapshot.entry!.freeMarginMicros = '0'; h.snapshot.entry!.fundableMicros = '200000000';
    vi.mocked(h.io.fund).mockImplementation(async () => {
      h.snapshot.entry!.freeMarginMicros = '200000000';
      if (changed === 'price') h.snapshot.price.observedAt -= 5000;
      if (changed === 'fee') h.snapshot.entry!.feeObservedAt -= 5000;
      if (changed === 'margin') h.snapshot.entry!.freeMarginMicros = '0';
      if (changed === 'switch') h.disable();
      if (changed === 'position') h.snapshot.position.epoch = 'EXAMPLE-new-position';
    });
    expect((await h.service.execute(intent())).state).toBe('unknown');
    expect(h.io.withSigner).not.toHaveBeenCalled(); expect(h.io.submit).not.toHaveBeenCalled();
  });
  it('checks freshness again inside the custody callback and never sends expired signatures', async () => {
    const h = harness();
    vi.mocked(h.io.withSigner).mockImplementation(async (_i, fn) => { h.setTime(now + 5000); return fn(key.secretKey); });
    expect((await h.service.execute(intent())).state).toBe('unknown'); expect(h.io.submit).not.toHaveBeenCalled();
    const j = harness(); vi.mocked(j.io.blockHeight).mockResolvedValue(501);
    expect((await j.service.execute(intent())).state).toBe('unknown'); expect(j.io.submit).not.toHaveBeenCalled();
  });
  it('never sends after losing acknowledgement of signature persistence', async () => {
    const h = harness(), save = h.store.change.bind(h.store);
    h.store.change = async (r, state, data) => { const result = await save(r, state, data); if (state === 'submission_pending') throw new Error('EXAMPLE lost acknowledgement'); return result; };
    expect((await h.service.execute(intent())).state).toBe('unknown');
    expect(h.row().data.attempt).toBeDefined(); expect(h.io.submit).not.toHaveBeenCalled();
  });
  it.each(['signature', 'trader', 'market', 'intentId', 'positionEpoch'] as const)('ignores a receipt with wrong %s', async field => {
    const h = harness(); await h.service.execute(intent()); h.setReceipt({ [field]: 'EXAMPLE-wrong', fills: [fill()] });
    expect((await h.service.execute(intent())).state).toBe('accepted'); expect(h.row().data.fills).toBeUndefined();
  });
  it('carries incremental partial reduce-only outcomes forward while entries are disabled', async () => {
    const h = harness(false), i = intent({ action: 'close', side: 'sell' });
    h.snapshot.entry = null; h.snapshot.status = 'reduce_only'; h.snapshot.position.side = 'long'; h.snapshot.position.baseLots = '300';
    expect((await h.service.execute(i)).state).toBe('accepted');
    expect(h.row().data.admission.packet.orderFlags).toBe(128);
    h.setReceipt({ complete: false, fills: [fill()] });
    expect((await h.service.execute(i)).state).toBe('landed');
    h.setReceipt({ complete: true, fills: [{ ...fill('20', '30000000'), fillId: 'EXAMPLE-fill-2' }] });
    const r = await h.service.execute(i);
    expect(r.state).toBe('settled'); expect(r.data.fills).toHaveLength(2);
    expect(r.data.remainingLots).toBe('100'); expect(r.data.remainingPositionLots).toBe('200');
    expect(h.io.submit).toHaveBeenCalledTimes(1); expect(h.io.fund).not.toHaveBeenCalled();
  });
  it('keeps contradictory fills ambiguous and denies disabled entry', async () => {
    const h = harness(); await h.service.execute(intent()); h.setReceipt({ fills: [fill(), fill('81')] });
    expect((await h.service.execute(intent())).state).toBe('accepted');
    h.setReceipt({ fills: [fill('201')] }); expect((await h.service.execute(intent())).state).toBe('accepted');
    const off = harness(false); await expect(off.service.execute(intent())).rejects.toThrow('disabled');
    expect(off.io.snapshot).not.toHaveBeenCalled();
  });
});
