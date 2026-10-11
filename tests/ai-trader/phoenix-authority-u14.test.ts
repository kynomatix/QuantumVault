import { describe, expect, it } from 'vitest';
import { aiBot, aiAuthority, clamped, filled, identity, now, custody } from '../helpers/phoenix-ai';
import { aiTraderPolicyObject, assertPhoenixAiBinding, assertPhoenixAiCustody } from '../../server/ai-trader/phoenix-policy';
import { buildPhoenixAiEntry, phoenixAiFill } from '../../server/ai-trader/phoenix-sizing';
import { orderIntentHash } from '../../server/protocol/phoenix/order-contract';
import { botPolicyRecord } from '../../server/protocol/phoenix/policy';
import { phoenixAiFlags, phoenixAiOptions } from '../../server/ai-trader/phoenix-capabilities';
describe('U14 bound AI policy and execution authority', () => {
 it('preserves the legacy Pacifica policy record', () => {
  expect(aiTraderPolicyObject(aiBot({ protocol: 'pacifica' }))).toEqual({ market: 'SOL-PERP', leverage: 2, maxPositionSize: '100.00' });
 });
 it('signs venue, owner, both identities, HD, risk band and paper/live status', () => {
  const b = aiBot(), policy = aiTraderPolicyObject(b), policyHash = orderIntentHash(botPolicyRecord(policy));
  expect(botPolicyRecord(policy)).toMatchObject({ policyVersion: 'phoenix-ai-v1', venue: 'phoenix', ownerWallet: b.walletAddress, paperMode: false });
  for (const change of [{ walletAddress: 'EXAMPLE-other' }, { sizingMode: 'risk_based' }, { riskMaxPct: '2.00' },
    { paperMode: true }, { market: 'BTC-PERP' }, { maxLeverage: 3 }]) {
   expect(orderIntentHash(botPolicyRecord(aiTraderPolicyObject({ ...b, ...change } as any)))).not.toBe(policyHash);
  }
  expect(aiTraderPolicyObject({ ...b, riskMinPct: '0.5' })).toEqual(policy);
  const altered = { ...b, phoenixBinding: { ...b.phoenixBinding!, derivationIndex: 2 } };
  expect(orderIntentHash(botPolicyRecord(aiTraderPolicyObject(altered)))).not.toBe(policyHash);
 });
 it.each(['link', 'pda', 'authority', 'hd', 'owner'])('rejects %s custody substitution', defect => {
  const b = aiBot(), c = custody();
  if (defect === 'link') c.id = 'EXAMPLE-other';
  if (defect === 'pda') b.protocolSubaccountId = identity.authorityWalletAddress;
  if (defect === 'authority') c.phoenixAuthorityWallet = identity.traderAccountAddress;
  if (defect === 'hd') c.derivationIndex = 2;
  if (defect === 'owner') c.walletAddress = 'EXAMPLE-other';
  expect(() => assertPhoenixAiCustody(b, c)).toThrow();
 });
 it('fails closed for absent live binding, including missing bot-key metadata', () => {
  expect(() => assertPhoenixAiBinding(aiBot({ phoenixBinding: null }))).toThrow();
  const b = aiBot(); b.phoenixBinding!.derivationIndex = 0;
  expect(() => assertPhoenixAiBinding(b)).toThrow();
 });
 it('defaults every AI live and optional money gate off independently of Signal Bots', () => {
  expect(phoenixAiFlags({ PHOENIX_ENABLED: 'true', SIGNAL_BOTS_ENABLED: 'true' })).toEqual({ live: false, scan: false, paper: false });
  expect(phoenixAiFlags({ PHOENIX_AI_SCANNER_ENABLED: 'true' })).toEqual({ live: false, scan: true, paper: false });
  expect(phoenixAiOptions()).toEqual({ parking: false, borrow: false, carry: false });
 });
 it('recomputes size from fresh execution price, ignoring reference price and claimed size/margin', () => {
  const i = buildPhoenixAiEntry(aiBot(), 'EXAMPLE-decision', clamped(), aiAuthority(), '1', now);
  expect(i.baseUnits).toBe('0.66'); expect(i.botId).toBe('EXAMPLE-bot'); expect(i.market).toBe('SOL-PERP');
  expect(i.identity.traderAccountAddress).toBe(identity.traderAccountAddress);
  const a = aiAuthority(); a.price.usd = '160'; a.price.reference = 'EXAMPLE-new-book';
  expect(buildPhoenixAiEntry(aiBot(), 'EXAMPLE-decision', clamped(), a, '1', now).baseUnits).toBe('0.62');
 });
 it.each(['reference', 'stale', 'future', 'margin', 'bracket', 'market', 'protection', 'leverage', 'newline'])('denies %s execution authority', defect => {
  const b = aiBot(), a = aiAuthority(), c = clamped();
  if (defect === 'reference') (a.price as { source: string }).source = 'hyperliquid-reference';
  if (defect === 'stale') a.price.observedAt = now - 5000;
  if (defect === 'future') a.price.observedAt = now + 1;
  if (defect === 'margin') { a.entry!.freeMarginMicros = '0'; a.entry!.fundableMicros = '0'; }
  if (defect === 'bracket') c.takeProfitPrice = 130;
  if (defect === 'market') a.market = 'SOL';
  if (defect === 'protection') a.protection = null as any;
  if (defect === 'leverage') c.leverage = 3;
  if (defect === 'newline') b.allocatedUsdc = '100.00\n';
  expect(() => buildPhoenixAiEntry(b, 'EXAMPLE-decision', c, a, '1', now)).toThrow();
 });
 it('risk sizing uses bounded fresh equity and fails on unknown equity', () => {
  const b = aiBot({ sizingMode: 'risk_based' });
  expect(() => buildPhoenixAiEntry(b, 'EXAMPLE-decision', clamped(), aiAuthority(), '1', now)).toThrow('equity');
  const low = buildPhoenixAiEntry(b, 'EXAMPLE-decision', clamped(), aiAuthority(), '1', now, '50000000');
  const high = buildPhoenixAiEntry(b, 'EXAMPLE-decision', clamped(), aiAuthority(), '1', now, '999000000');
  expect(Number(low.baseUnits)).toBeLessThan(Number(high.baseUnits));
 });
 it('uses confirmed fill price and refuses acknowledgements or duplicated fills', () => {
  const i = buildPhoenixAiEntry(aiBot(), 'EXAMPLE-decision', clamped(), aiAuthority(), '1', now), r = filled(i);
  expect(phoenixAiFill(r)).toMatchObject({ entryPrice: 150, sizeBase: 0.66, lots: '66' });
  expect(() => phoenixAiFill({ ...r, state: 'accepted' })).toThrow('unknown');
  r.data.fills!.push(r.data.fills![0]); expect(() => phoenixAiFill(r)).toThrow('identity');
 });
});
