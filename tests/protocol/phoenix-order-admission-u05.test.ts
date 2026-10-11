import { describe, it, expect } from 'vitest';
import { Transaction } from '@solana/web3.js';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { admitPhoenixOrder } from '../../server/protocol/phoenix/order-contract';
import { encodePhoenixOrder, signOrderTransaction } from '../../server/protocol/phoenix/order-builder';
import { phoenixOrderDisabled } from '../../server/protocol/phoenix/order-routes';
import { authority, intent, now, key, pin, lifetime } from '../helpers/phoenix-orders';

describe('Phoenix U05 exact admission and explicit wire policy', () => {
  it('sizes exact lots, ticks, maximum slippage notional and account-tier fees', () => {
    const a = admitPhoenixOrder(intent(), authority(), now);
    expect(a.packet).toMatchObject({ numBaseLots: '200', priceInTicks: '15150', minBaseLotsToFill: '0',
      minQuoteLotsToFill: '0', selfTradeBehavior: 'Abort', lastValidSlot: '150', orderFlags: 0 });
    expect(a.notionalMicros).toBe('303000000'); expect(a.requiredMarginMicros).toBe('151606050');
  });
  it.each(['0', '0.001', '0.009999999999999999'])('refuses rounded dust %s', baseUnits => {
    expect(() => admitPhoenixOrder(intent({ baseUnits }), authority(), now)).toThrow();
  });
  it('preserves quantities above Number.MAX_SAFE_INTEGER and signed negative lot decimals', () => {
    const a = authority(); a.baseLotsDecimals = 0; a.tickSize = '1'; a.price.usd = '0.000001';
    a.entry!.maxNotionalMicros = '18446744073709551615'; a.entry!.freeMarginMicros = '18446744073709551615';
    const result = admitPhoenixOrder(intent({ baseUnits: '9007199254740993', maxNotionalMicros: '18446744073709551615', slippageBps: 0 }), a, now);
    expect(result.packet.numBaseLots).toBe('9007199254740993');
    a.baseLotsDecimals = -1; a.price.usd = '1';
    expect(admitPhoenixOrder(intent({ baseUnits: '20', slippageBps: 0 }), a, now).packet.numBaseLots).toBe('2');
  });
  it.each(['price', 'fee', 'margin', 'market', 'failed', 'unknown-margin', 'leverage', 'minimum', 'isolated', 'mint', 'position'])('denies invalid %s authority', defect => {
    const a = authority();
    if (defect === 'price') a.price.observedAt -= 5000;
    if (defect === 'fee') a.entry!.feeObservedAt -= 5000;
    if (defect === 'margin') a.entry!.marginObservedAt -= 5000;
    if (defect === 'market') a.observedAt -= 5000;
    if (defect === 'failed') a.refreshFailed = true;
    if (defect === 'unknown-margin') a.entry!.freeMarginMicros = 'unknown';
    if (defect === 'leverage') a.entry!.maxLeverage = '1';
    if (defect === 'minimum') a.entry!.minimumNotionalMicros = '400000000';
    if (defect === 'isolated') a.isolatedOnly = true;
    if (defect === 'mint') a.collateralMint = 'EXAMPLE-wrong-mint';
    if (defect === 'position') a.position.side = 'long';
    expect(() => admitPhoenixOrder(intent(), a, now)).toThrow();
  });
  it('enforces explicit FOK/min-fill, wall-clock and slot expiry', () => {
    expect(() => admitPhoenixOrder(intent({ fillPolicy: 'FOK' }), authority(), now)).toThrow();
    expect(admitPhoenixOrder(intent({ fillPolicy: 'FOK', minFillLots: '200' }), authority(), now).packet.minBaseLotsToFill).toBe('200');
    for (const patch of [{ minFillLots: '201' }, { expiresAt: now }, { lastValidSlot: '100' }, { slippageBps: NaN }]) {
      expect(() => admitPhoenixOrder(intent(patch), authority(), now)).toThrow();
    }
  });
  it('does not round a sub-micro minimum violation into admission', () => {
    const a = authority(); a.price.usd = '0.9999999'; a.entry!.minimumNotionalMicros = '1000000';
    a.tickSize = '1';
    expect(() => admitPhoenixOrder(intent({ baseUnits: '1' }), a, now)).toThrow('minimum');
  });
  it('requires settled funding before signing and rounds sell bounds inward', () => {
    const a = authority(); a.entry!.freeMarginMicros = '0'; a.entry!.fundableMicros = '151606050';
    expect(admitPhoenixOrder(intent(), a, now).fundingShortfallMicros).toBe('151606050');
    expect(() => admitPhoenixOrder(intent(), a, now, true)).toThrow();
    a.entry!.freeMarginMicros = '1000000000'; a.price.usd = '150.0001';
    expect(admitPhoenixOrder(intent({ side: 'sell' }), a, now).packet.priceInTicks).toBe('14851');
  });
  it('does not apply missing entry fees/minimum/leverage to reduce-only recovery', () => {
    const a = authority(); a.entry = null; a.status = 'reduce_only'; a.position = { ...a.position, side: 'long', baseLots: '200' };
    const i = intent({ action: 'close', side: 'sell' });
    expect(admitPhoenixOrder(i, a, now).packet.orderFlags).toBe(128);
    expect(() => admitPhoenixOrder({ ...i, side: 'buy' }, a, now)).toThrow();
    expect(() => admitPhoenixOrder({ ...i, baseUnits: '2.01' }, a, now)).toThrow();
  });
  it('encodes all IOC option tags and signs only the rebuilt message with synthetic authority', () => {
    const i = intent(); const a = admitPhoenixOrder(i, authority(), now);
    const bytes = encodePhoenixOrder(a.packet);
    expect(bytes.length).toBe(73); expect([...bytes.subarray(8, 11)]).toEqual([2, 0, 1]);
    expect(bytes.readBigUInt64LE(11)).toBe(15150n); expect(bytes.readBigUInt64LE(19)).toBe(200n);
    expect(bytes[27]).toBe(0); expect(bytes.readBigUInt64LE(28)).toBe(0n); expect(bytes[62]).toBe(1);
    expect(bytes.readBigUInt64LE(63)).toBe(150n); expect([...bytes.subarray(71)]).toEqual([0, 0]);
    const signed = signOrderTransaction(i, a, pin, lifetime, key.secretKey, now);
    const tx = Transaction.from(Buffer.from(signed.transaction, 'base64'));
    expect(tx.verifySignatures()).toBe(true); expect(tx.instructions[0].data).toEqual(bytes);
    expect(tx.signatures).toHaveLength(1);
    expect(() => signOrderTransaction(i, a, pin, lifetime, new Uint8Array(64), now)).toThrow();
    expect(() => signOrderTransaction(i, a, pin, lifetime, key.secretKey, now + 5000)).toThrow();
  });
  it('preserves incumbent routes apart from Phoenix refusals and unreachable policy comparisons', () => {
    const baseCommitHash = '81aaefea60e1eb0c816b85b545c75480023f6492';
    const base = execFileSync('git', ['show', `${baseCommitHash}:server/routes.ts`], { maxBuffer: 5_000_000 }).toString().replaceAll('\r\n', '\n');
    const current = readFileSync('server/routes.ts', 'utf8').replaceAll('\r\n', '\n');
    const branch = "      if (bot.activeProtocol === 'phoenix') {\n        const { phoenixOrderDisabled } = await import('./protocol/phoenix/order-routes');\n        return res.status(503).json(phoenixOrderDisabled());\n      }\n\n";
    const oldPolicyCheck = "      if (bot.policyHmac || bot.activeProtocol === 'phoenix') {";
    const legacyPolicyCheck = "      // Phoenix was already refused before entering this legacy execution path.\n      if (bot.policyHmac) {";
    expect(base.split(oldPolicyCheck).length - 1).toBe(2);
    expect(current.split(legacyPolicyCheck).length - 1).toBe(2);
    expect(current.split(branch).length - 1).toBe(5);
    expect(current.replaceAll(branch, '')).toBe(base.replaceAll(oldPolicyCheck, legacyPolicyCheck));
    expect(phoenixOrderDisabled().code).toBe('PHOENIX_ORDERS_DISABLED');
  });
});
