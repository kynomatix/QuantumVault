import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Transaction } from '@solana/web3.js';
import { authority, identity, intent, key, lifetime, now, pin } from '../helpers/phoenix-orders';
import { admitPhoenixOrder } from '../../server/protocol/phoenix/order-contract';
import { prepareOrderTransaction, signOrderTransaction } from '../../server/protocol/phoenix/order-builder';
import { protectionInstruction, signProtectionTransaction } from '../../server/protocol/phoenix/protection-builder';
import { assertProtectionSnapshot, desiredProtection, planProtection, protectionExecutionTicks, protectionStatus,
  type ProtectionLeg, type ProtectionRequest, type ProtectionSnapshot } from '../../server/protocol/phoenix/protection-contract';
import { readProtectionAccounts, type DecodedProtectionAccounts } from '../../server/protocol/phoenix/protection-reader';
import { PHOENIX_PUBLIC_ADDRESSES } from '../../server/protocol/phoenix/sdk-boundary';

import { snapshot, request, leg } from '../helpers/phoenix-protection';
function decoded(): DecodedProtectionAccounts {
  const s = snapshot();
  const trigger = { triggerPrice: 14000n, executionPrice: 13860n, positionSequenceNumber: 1,
    isActive: true, executionDirection: 1, tradeSide: 1, orderKind: 0 };
  const order = { sequenceNumber: 1n, orderId: { priceInTicks: 15000n, orderSequenceNumber: 2n }, maxSize: 200n, fillableSize: 80n,
    filledSize: 30n, assetId: 3, usePercent: false, percent: 0, isActive: true,
    greaterTriggerOrder: { ...trigger, isActive: false }, lessTriggerOrder: trigger };
  return { context: { slot: s.slot, observedAt: now, source: s.source, reference: s.reference, finalized: true, complete: true, refreshFailed: false },
    position: s.position, markTicks: s.markTicks, orderbookOrderIds: ['15000:2'], standalone: null,
    collection: { address: s.conditionalAccount, owner: PHOENIX_PUBLIC_ADDRESSES.program,
      header: { traderKey: s.trader, sequenceNumber: 2n, len: 1, capacity: 2 }, activeOrderIndices: [1],
      orders: [{ ...order, isActive: false }, order] } };
}

describe('U06 native protection authority and bounded packets', () => {
  it('rounds execution prices inside explicit bounds for both directions', () => {
    expect(protectionExecutionTicks('tp', 'sell', '101', 25)).toBe('101');
    expect(protectionExecutionTicks('tp', 'buy', '101', 25)).toBe('101');
    expect(protectionExecutionTicks('sl', 'sell', '10000', 1000)).toBe('9000');
    expect(() => protectionExecutionTicks('tp', 'sell', '10000', 26)).toThrow('bound');
    expect(() => protectionExecutionTicks('sl', 'buy', '10000', 1001)).toThrow('bound');
    expect(() => protectionExecutionTicks('sl', 'buy', '10000', NaN)).toThrow('bound');
  });
  it('uses opposite-side IOC triggers with both explicit prices and no crossed trigger', () => {
    const long = desiredProtection(intent().protection!, 'long', '200', '15000');
    expect(long.map(l => [l.side, l.direction])).toEqual([['sell', 'greater'], ['sell', 'less']]);
    const prices = { tp: { triggerTicks: '14000', slippageBps: 25 }, sl: { triggerTicks: '17000', slippageBps: 100 } };
    expect(desiredProtection(prices, 'short', '200', '15000').map(l => [l.side, l.direction])).toEqual([['buy', 'less'], ['buy', 'greater']]);
    expect(() => desiredProtection(prices, 'long', '200', '15000')).toThrow('crossed');
    expect(() => desiredProtection({ sl: prices.sl } as any, 'short', '200', '15000')).toThrow('Both');
  });
  it('reads partial parent fills and remaining quantity without treating requested quantity as filled', () => {
    const s = readProtectionAccounts(request(), decoded(), now);
    expect(s.legs[0]).toMatchObject({ parentOrderId: '15000:2', remainingLots: '50', rawFillableLots: '80', rawFilledLots: '30' });
    expect(protectionStatus(s).orphanLegs).toHaveLength(0);
  });
  it('retains detached full-fill and orphan triggers after the parent leaves the book', () => {
    const a = decoded(); a.orderbookOrderIds = [];
    expect(protectionStatus(readProtectionAccounts(request(), a, now)).orphanLegs).toHaveLength(1);
    a.collection!.orders[1].orderId = null; a.collection!.orders[1].fillableSize = 200n;
    const s = readProtectionAccounts(request(), a, now);
    expect(s.legs[0]).toMatchObject({ parentOrderId: null, remainingLots: '170' });
    expect(planProtection(request({ action: 'cancel' }), s, now).commands).toEqual([{ kind: 'cancel-conditional', index: 1, sequence: '1' }]);
  });
  it('caps standalone and percent protection by the remaining position', () => {
    const a = decoded(); const s = snapshot(); a.collection!.orders[1].orderId = null;
    a.collection!.orders[1].usePercent = true; a.collection!.orders[1].percent = 100;
    a.position.baseLots = '30';
    a.standalone = { address: s.standaloneAccount, owner: PHOENIX_PUBLIC_ADDRESSES.program, traderKey: s.trader,
      assetId: 3n, fundingKey: identity.authorityWalletAddress, isInitialized: true,
      stopLosses: [{ ...a.collection!.orders[1].lessTriggerOrder, sequenceNumber: 2n, tradeSize: 100n },
        { ...a.collection!.orders[1].greaterTriggerOrder, sequenceNumber: 3n, tradeSize: 100n }] };
    const read = readProtectionAccounts(request(), a, now);
    expect(read.legs.map(l => l.remainingLots)).toEqual(['30', '30']);
    expect(planProtection(request({ action: 'cancel' }), read, now).commands.map(c => c.kind)).toContain('cancel-standalone');
  });
  it('invalidates protection on side flip, position sequence change, and stale reads', () => {
    const s = snapshot(); s.legs = [leg()]; s.position.side = 'short'; s.position.sequence = 2;
    expect(protectionStatus(s, intent().protection).staleLegs).toHaveLength(1);
    expect(protectionStatus(s, intent().protection).protected).toBe(false);
    expect(() => assertProtectionSnapshot(s, request(), now + 5000)).toThrow('unavailable');
    s.complete = false as any; expect(() => assertProtectionSnapshot(s, request(), now)).toThrow('unavailable');
  });
  it('refuses missing pages, wrong account owner, duplicated indexes and inconsistent quantities', () => {
    for (const change of [
      (a: DecodedProtectionAccounts) => { a.collection!.header.len = 2; },
      (a: DecodedProtectionAccounts) => { a.collection!.owner = identity.authorityWalletAddress; },
      (a: DecodedProtectionAccounts) => { a.collection!.activeOrderIndices = [1, 1]; },
      (a: DecodedProtectionAccounts) => { a.collection!.orders[1].filledSize = 100n; },
    ]) { const a = decoded(); change(a); expect(() => readProtectionAccounts(request(), a, now)).toThrow(); }
  });
  it('places SL before TP and forbids loosening a breakeven stop', () => {
    const s = snapshot(); s.legs = [leg()];
    expect(planProtection(request(), s, now).commands.map(c => c.kind === 'place' ? c.role : c.kind)).toEqual(['cancel-conditional', 'sl', 'tp']);
    const r = request({ action: 'breakeven' }); r.prices!.sl.triggerTicks = '13000';
    expect(() => planProtection(r, s, now)).toThrow('loosen');
  });
  it('does not equate book cancellation with cancelling conditional or standalone accounts', () => {
    const s = snapshot(); s.legs = [leg(), leg({ surface: 'standalone', index: 0, sequence: '2' })];
    s.standaloneFunder = identity.authorityWalletAddress; s.orderbookOrderIds = ['EXAMPLE-order'];
    const p = planProtection(request({ action: 'pause' }), s, now);
    expect(p.commands.map(c => c.kind)).toEqual(['cancel-book', 'cancel-standalone', 'cancel-conditional']);
    s.orderbookOrderIds = []; expect(protectionStatus(s).allOrdersCancelled).toBe(false);
  });
  it('encodes the SDK account order, explicit enums and bounded prices', () => {
    const c = desiredProtection(intent().protection!, 'long', '200', '15000')[1];
    const ix = protectionInstruction(request(), pin, c);
    expect(ix.data.subarray(0, 8)).toEqual(createHash('sha256').update('global:place_position_conditional_order').digest().subarray(0, 8));
    expect(ix.data.readUInt32LE(8)).toBe(3); expect([...ix.data.subarray(12, 17)]).toEqual([0, 1, 1, 1, 0]);
    expect(ix.data.readBigUInt64LE(17)).toBe(14000n); expect(ix.data.readBigUInt64LE(25)).toBe(13860n);
    expect(ix.data.readBigUInt64LE(34)).toBe(200n);
    expect(ix.keys[3].isSigner).toBe(true); expect(ix.keys.at(-2)!.pubkey.toBase58()).toBe(snapshot().conditionalAccount);
    const cancel = protectionInstruction(request(), pin, { kind: 'cancel-conditional', index: 191, sequence: '1' });
    expect([...cancel.data.subarray(8)]).toEqual([191, 1, 1]);
    expect(cancel.keys.map(k => k.pubkey.toBase58())).toEqual([PHOENIX_PUBLIC_ADDRESSES.program, pin.logAuthority,
      pin.globalConfiguration, identity.traderAccountAddress, identity.authorityWalletAddress, pin.orderbook, snapshot().conditionalAccount]);
    const standalone = protectionInstruction(request(), pin, { kind: 'cancel-standalone', direction: 'less', sequence: '1', funder: identity.authorityWalletAddress });
    expect(standalone.data[8]).toBe(1); expect(standalone.keys[6].pubkey.toBase58()).toBe(snapshot().standaloneAccount);
    expect(protectionInstruction(request(), pin, { kind: 'cancel-book' }).data).toHaveLength(8);
  });
  it('signs only synthetic keys and produces verifiable native cancellation transactions', () => {
    const signed = signProtectionTransaction(request(), pin, { kind: 'cancel-book' }, lifetime, key.secretKey);
    expect(Transaction.from(Buffer.from(signed.transaction, 'base64')).verifySignatures()).toBe(true);
    expect(() => signProtectionTransaction(request(), pin, { kind: 'cancel-book' }, lifetime, new Uint8Array(64))).toThrow('signer');
  });
  it('requires fresh complete protection for entry and adds both 100% legs atomically', () => {
    const i = intent(), a = authority(); const admitted = admitPhoenixOrder(i, a, now);
    const tx = prepareOrderTransaction(i, admitted, pin, lifetime);
    expect(tx.instructions).toHaveLength(3);
    for (const ix of tx.instructions.slice(1)) expect([...ix.data.subarray(-3)]).toEqual([0, 1, 100]);
    const signed = signOrderTransaction(i, admitted, pin, lifetime, key.secretKey, now);
    expect(Transaction.from(Buffer.from(signed.transaction, 'base64')).verifySignatures()).toBe(true);
    delete a.protection; expect(() => admitPhoenixOrder(i, a, now)).toThrow('protection unknown');
  });
  it('keeps reduce-only close available with missing or failed protection', () => {
    const i = intent({ action: 'close', side: 'sell', protection: undefined });
    const a = authority(); delete a.protection; a.entry = null; a.status = 'reduce_only';
    a.position = { observedAt: now, side: 'long', baseLots: '200', epoch: 'EXAMPLE-position-epoch' };
    const admitted = admitPhoenixOrder(i, a, now);
    expect(admitted.packet.orderFlags).toBe(128);
    expect(prepareOrderTransaction(i, admitted, pin, lifetime).instructions).toHaveLength(1);
  });
});
