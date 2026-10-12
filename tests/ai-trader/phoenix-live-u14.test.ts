// Primitive tests use an explicit trusted rollout fixture; U16 tests exercise the real owner gate.
vi.mock('../../server/protocol/phoenix/rollout', async importOriginal => ({
  ...await importOriginal<typeof import('../../server/protocol/phoenix/rollout')>(),
  phoenixCanaryAllows: () => true, phoenixExposureAllows: () => true,
}));
import { describe, expect, it, vi } from 'vitest';
import type { AiTraderBot } from '@shared/schema';
import type { ProtocolAdapter } from '../../server/protocol/adapter';
import { PhoenixAiTraderService, type PhoenixAiExecution } from '../../server/ai-trader/phoenix-live';
import { aiTraderPolicyObject } from '../../server/ai-trader/phoenix-policy';
import { buildPhoenixAiEntry } from '../../server/ai-trader/phoenix-sizing';
import { orderIntentHash } from '../../server/protocol/phoenix/order-contract';
import { desiredProtection } from '../../server/protocol/phoenix/protection-contract';
import { phoenixCreationId } from '../../server/protocol/phoenix/provisioning-store';
import { aiBot, aiAuthority, clamped, filled, decision, custody, identity, now } from '../helpers/phoenix-ai';
function fixture() {
 let bot: AiTraderBot = aiBot(), d = decision(bot), execution: PhoenixAiExecution | null = null;
 let record: ReturnType<typeof filled> | null = null, enabled = true, debtRaw = '0';
 const c = custody(), a = aiAuthority();
 const repo = {
  bot: vi.fn(async () => bot), decision: vi.fn(async () => d), execution: vi.fn(async () => execution),
  prepare: vi.fn(async (b, id, intent, authority) => execution = { botId: b.id, decisionId: id, intent, authority, policyHash: orderIntentHash(aiTraderPolicyObject(b)) }),
  claim: vi.fn(async () => { bot = { ...bot, status: 'executing' }; return true; }),
  graduate: vi.fn(async (_b, binding, hmac) => bot = { ...bot, paperMode: false, phoenixExecutionBotId: binding.executionBotId,
   phoenixBinding: binding, protocolSubaccountId: binding.identity.traderAccountAddress, policyHmac: hmac }),
  open: vi.fn(async () => { bot = { ...bot, status: 'open' }; d = { ...d, outcome: 'executed' }; return true; }),
  noLand: vi.fn(async () => { bot = { ...bot, status: 'idle' }; return true; }),
  recoverPrepared: vi.fn(async () => { execution=null; return true; }),
  unprotected: vi.fn(async () => { bot = { ...bot, status: 'paused', pauseReason: 'bracket_failed' }; }), close: vi.fn(async () => true),
 };
 const source = {
  custody: vi.fn(async () => c), verifyPolicy: vi.fn(async () => true), policyHmac: vi.fn(async () => 'EXAMPLE-live-policy'),
  debt: vi.fn(async (b, id) => ({ ownerWallet: b.walletAddress, executionBotId: id, complete: true, debtRaw, observedAt: now, source: 'EXAMPLE-debt', reference: 'EXAMPLE-complete' })),
  snapshot: vi.fn(async () => ({ authority: a, sequence: '1', equity: { micros: '100000000', observedAt: now, source: 'EXAMPLE-equity', reference: 'EXAMPLE-chain' } })),
  closeIntent: vi.fn(async (_b, e) => ({ ...e.intent, requestKey: 'EXAMPLE-close', sequence: '2', action: 'close' as const,
   side: 'sell' as const, protection: undefined })), exit: vi.fn(async () => null),
  analysis: vi.fn(() => ({ getPositions: vi.fn(async () => []), getBalances: vi.fn(async () => []) })),
  registrationTerms: { maxPositions: 32, maxCostLamports: '20000' },
 };
 const consumers = { create: vi.fn(async (_request: unknown) => ({ status: 'completed', funded: true, botId: c.id, identity })) };
 const orders = { execute: vi.fn(async i => record = filled(i)), reconcile: vi.fn(async () => record!) };
 const orderStore = { find: vi.fn(async () => record) };
 const safety = {
  protect: vi.fn(async request => {
   const after = structuredClone(a.protection!);
   after.position = { side: 'long', baseLots: record!.data.admission.packet.numBaseLots, sequence: 1, epoch: record!.data.positionEpoch! };
   after.legs = desiredProtection(request.prices, 'long', after.position.baseLots, after.markTicks).map((leg, index) => ({
    surface: 'conditional' as const, index: index + 1, sequence: String(index + 1), assetId: 3, parentOrderId: null, positionSequence: 1,
    side: leg.side, direction: leg.direction, kind: 'IOC' as const, triggerTicks: leg.triggerTicks, executionTicks: leg.executionTicks,
    remainingLots: leg.baseLots, sizePercent: null, rawMaxLots: leg.baseLots, rawFillableLots: leg.baseLots, rawFilledLots: '0' }));
   return { state: 'completed', observation: { protection: { after } } } as any;
  }),
  close: vi.fn(async i => {
   const after = aiAuthority(), before = aiAuthority(); before.position = { ...before.position, side: 'long', baseLots: '66' };
   const r = { ...record!, intent: i, state: 'settled', data: { ...record!.data, remainingPositionLots: '0' } };
   return { before, after, order: r, positionClosed: true } as any;
  }),
 };
 const service = new PhoenixAiTraderService(repo as any, source as any, consumers as any, orders, orderStore, safety, () => enabled, () => now);
 const adapter = { protocolName: 'phoenix', getPrice: vi.fn(() => { throw new Error('EXAMPLE-adapter-not-authority'); }) } as unknown as ProtocolAdapter;
 const input = () => ({ bot, decisionId: d.id, clamped: clamped(), adapter, markPrice: 9999, authoritySource: 'external_http' as const });
 return { service, repo, source, consumers, orders, orderStore, safety, c, a, input,
  bot: () => bot, setBot: (b: typeof bot) => { bot = b; }, decision: () => d, setDecision: (v: typeof d) => { d = v; },
  execution: () => execution, setExecution: (v: typeof execution) => { execution = v; }, record: () => record,
  setRecord: (v: typeof record) => { record = v; }, disable: () => { enabled = false; }, debt: (v: string) => { debtRaw = v; } };
}
describe('U14 shared-core AI live service', () => {
 it('routes idle prepared recovery through the durable repository before observing money',async()=>{
  const f=fixture(); await f.service.entry(f.input());
  const b={...f.bot(),status:'idle' as const}; f.setBot(b);
  expect(await f.service.reconcile(b)).toBe(true);
  expect(f.repo.recoverPrepared).toHaveBeenCalledWith(b,expect.any(Object));
  expect(f.source.exit).not.toHaveBeenCalled();
 });
 it('claims before money, uses fresh lots, proves bracket before recording open', async () => {
  const f = fixture(); expect(await f.service.entry(f.input())).toMatchObject({ ok: true, mode: 'live', entryPrice: 150 });
  expect(f.orders.execute.mock.calls[0][0].baseUnits).toBe('0.66');
  expect(f.input().adapter.getPrice).not.toHaveBeenCalled();
  expect(f.repo.claim.mock.invocationCallOrder[0]).toBeLessThan(f.orders.execute.mock.invocationCallOrder[0]);
  expect(f.safety.protect.mock.invocationCallOrder[0]).toBeLessThan(f.repo.open.mock.invocationCallOrder[0]);
  expect(f.source.debt).toHaveBeenCalledTimes(2);
 });
 it.each(['gate', 'policy', 'debt', 'missing_key', 'reference', 'claim', 'era', 'venue', 'other_execution', 'paused'])('denies %s before any order', async defect => {
  const f = fixture();
  if (defect === 'gate') f.disable();
  if (defect === 'policy') f.source.verifyPolicy.mockResolvedValue(false);
  if (defect === 'debt') f.debt('1');
  if (defect === 'missing_key') f.c.derivationIndex = null;
  if (defect === 'reference') (f.a.price as { source: string }).source = 'hyperliquid-reference';
  if (defect === 'claim') f.repo.claim.mockResolvedValue(false);
  if (defect === 'era') f.setDecision({ ...f.decision(), qualificationEraDigest: 'EXAMPLE-old-era' });
  if (defect === 'venue') f.setDecision({ ...f.decision(), contextDigest: { executionVenue: 'pacifica' } as any });
  if (defect === 'other_execution') f.setExecution({ decisionId: 'EXAMPLE-old-decision' } as any);
  if (defect === 'paused') f.c.subaccountStatus = 'phoenix_paused';
  expect((await f.service.entry(f.input())).ok).toBe(false); expect(f.orders.execute).not.toHaveBeenCalled();
 });
 it('rechecks the independent gate after the durable claim', async () => {
  const f = fixture(); f.repo.claim.mockImplementation(async () => { f.setBot({ ...f.bot(), status: 'executing' }); f.disable(); return true; });
  expect((await f.service.entry(f.input())).ok).toBe(false); expect(f.orders.execute).not.toHaveBeenCalled();
 });
 it('cannot send after losing the execution claim', async () => {
  const f = fixture(); f.repo.claim.mockImplementation(async () => { f.setBot({ ...f.bot(), status: 'paused' }); return true; });
  expect((await f.service.entry(f.input())).ok).toBe(false); expect(f.orders.execute).not.toHaveBeenCalled();
 });
 it('keeps uncertain outcomes durable and reconciles without resubmitting, even with gate off', async () => {
  const f = fixture(); f.orders.execute.mockImplementation(async i => { const r = filled(i, 'unknown'); r.data.fills = []; f.setRecord(r); return r; });
  expect(await f.service.entry(f.input())).toMatchObject({ ok: false, reason: 'position_unconfirmed' });
  f.setRecord(filled(f.execution()!.intent)); f.disable();
  expect(await f.service.reconcile(f.bot())).toBe(true);
  expect(f.orders.execute).toHaveBeenCalledTimes(1); expect(f.orders.reconcile).toHaveBeenCalledTimes(1); expect(f.repo.open).toHaveBeenCalledTimes(1);
 });
 it('refuses to report recovery complete on a lost no-land transition', async () => {
  const f = fixture(); const i = buildPhoenixAiEntry(f.bot(), f.decision().id, clamped(), f.a, '1', now);
  f.setExecution({ botId: f.bot().id, decisionId: f.decision().id, intent: i, authority: f.a, policyHash: orderIntentHash(aiTraderPolicyObject(f.bot())) });
  f.setBot({ ...f.bot(), status: 'executing' }); f.repo.noLand.mockResolvedValue(false);
  expect(await f.service.reconcile(f.bot())).toBe(false); expect(f.orders.execute).not.toHaveBeenCalled();
 });
 it.each(['missing', 'wrong_epoch', 'wrong_size', 'write_failure'])('attempts a shared reduce-only close on %s protection', async defect => {
  const f = fixture(), original = f.safety.protect.getMockImplementation()!;
  f.safety.protect.mockImplementation(async request => {
   if (request.action === 'cancel') return { state: 'completed' } as any;
   if (defect === 'missing') return { state: 'unknown' } as any;
   const result = await original(request);
   if (defect === 'wrong_epoch') result.observation.protection.after.position.epoch = 'EXAMPLE-other';
   if (defect === 'wrong_size') result.observation.protection.after.position.baseLots = '65';
   return result;
  });
  if (defect === 'write_failure') f.repo.open.mockResolvedValue(false);
  expect((await f.service.entry(f.input())).ok).toBe(false);
  expect(f.safety.close).toHaveBeenCalledTimes(1); expect(f.safety.close.mock.calls[0][0].action).toBe('close');
 });
 it('cannot suppress the emergency close by failing the attention-state write', async () => {
  const f = fixture(); f.safety.protect.mockRejectedValue(new Error('EXAMPLE-bracket')); f.repo.unprotected.mockRejectedValue(new Error('EXAMPLE-db'));
  expect((await f.service.entry(f.input())).ok).toBe(false); expect(f.safety.close).toHaveBeenCalledTimes(1);
 });
 it('reads only the trader PDA, rejects the authority and explicit subaccount overrides', async () => {
  const f = fixture(), reads = f.service.analysis(f.bot());
  await expect(reads.getPositions!(identity.traderAccountAddress)).resolves.toEqual([]);
  await expect(reads.getPositions!(identity.authorityWalletAddress)).rejects.toThrow('identity');
  await expect(reads.getBalances!(identity.traderAccountAddress, 'EXAMPLE-main')).rejects.toThrow('identity');
 });
 it.each(['partial', 'stale', 'wrong_trader', 'ack'])('keeps %s close unresolved while the entry gate is off', async defect => {
  const f = fixture(); await f.service.entry(f.input()); f.disable(); const original = f.safety.close.getMockImplementation()!;
  f.safety.close.mockImplementation(async i => {
   const result = await original(i);
   if (defect === 'partial') result.order.data.remainingPositionLots = '1';
   if (defect === 'stale') result.after.position.observedAt = now - 5000;
   if (defect === 'wrong_trader') result.after.trader = identity.authorityWalletAddress;
   if (defect === 'ack') result.order.state = 'accepted';
   return result;
  });
  expect(await f.service.close(f.bot())).toMatchObject({ ok: true, closed: false }); expect(f.repo.close).not.toHaveBeenCalled();
 });
 it('graduation requires stable U03 provisioning plus U04 verified funding and repeats debt consent', async () => {
  const f = fixture(); f.setBot(aiBot({ paperMode: true, status: 'idle', phoenixBinding: null, phoenixExecutionBotId: null, protocolSubaccountId: null }));
  f.c.id = phoenixCreationId(f.bot().walletAddress, `ai:${f.bot().id}`);
  expect(await f.service.graduate(f.bot())).toMatchObject({ paperMode: false, phoenixExecutionBotId: f.c.id });
  expect(f.consumers.create.mock.calls[0][0]).toMatchObject({ requestId: 'ai:EXAMPLE-ai', consumer: { kind: 'ai', initialFundingBaseUnits: '100000000' } });
  expect(f.source.debt).toHaveBeenCalledTimes(2); expect(f.repo.graduate).toHaveBeenCalledTimes(1);
 });
 it('restarts graduation using the same custody and funding request without flipping an unfunded bot live', async () => {
  const f=fixture();f.setBot(aiBot({paperMode:true,status:'idle',phoenixBinding:null,phoenixExecutionBotId:null,protocolSubaccountId:null}));
  f.c.id=phoenixCreationId(f.bot().walletAddress,`ai:${f.bot().id}`);
  f.consumers.create.mockResolvedValueOnce({status:'completed',funded:false,botId:f.c.id,identity});
  expect(await f.service.graduate(f.bot())).toBeNull();expect(f.bot().paperMode).toBe(true);
  expect(await f.service.graduate(f.bot())).toMatchObject({paperMode:false});
  expect(f.consumers.create.mock.calls[0][0]).toEqual(f.consumers.create.mock.calls[1][0]);
 });
 it.each(['trial', 'unfunded', 'debt', 'late_debt', 'late_gate', 'wrong_bot'])('cannot graduate on %s', async defect => {
  const f = fixture(); f.setBot(aiBot({ paperMode: true, status: 'idle', phoenixBinding: null, phoenixExecutionBotId: null, protocolSubaccountId: null }));
  f.c.id = phoenixCreationId(f.bot().walletAddress, `ai:${f.bot().id}`);
  if (defect === 'trial') f.setBot({ ...f.bot(), graduationState: 'trial' });
  if (defect === 'debt') f.debt('1');
  f.consumers.create.mockImplementation(async () => {
   if (defect === 'late_debt') f.debt('1');
   if (defect === 'late_gate') f.disable();
   return { status: 'completed', funded: defect !== 'unfunded', identity, botId: defect === 'wrong_bot' ? 'EXAMPLE-other' : f.c.id };
  });
  await f.service.graduate(f.bot()).catch(() => null); expect(f.repo.graduate).not.toHaveBeenCalled();
 });
});
