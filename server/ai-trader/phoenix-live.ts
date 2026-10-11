import type { AiTraderBot, AiTraderDecision, TradingBot } from '@shared/schema';
import type { PhoenixAiBinding } from '../../shared/phoenix-ai-contract';
import type { ProtocolAdapter } from '../protocol/adapter';
import type { PhoenixConsumerService } from '../protocol/phoenix/consumer-service';
import type { PhoenixOrderService } from '../protocol/phoenix/order-service';
import type { PhoenixOrderStore, PhoenixOrderRecord } from '../protocol/phoenix/order-store';
import type { PhoenixOrderIntent, PhoenixOrderAuthority } from '../protocol/phoenix/order-contract';
import { orderIntentHash } from '../protocol/phoenix/order-contract';
import type { PhoenixSafetyService } from '../protocol/phoenix/safety-service';
import { assertProtectionSnapshot, protectionStatus } from '../protocol/phoenix/protection-contract';
import { phoenixCreationId } from '../protocol/phoenix/provisioning-store';
import { phoenixRiskStopped } from '../protocol/phoenix/lifecycle';
import { canGoLive } from './graduation';
import type { ExecuteDecisionInput, ExecuteDecisionResult } from './executor';
import { aiTraderPolicyObject, assertPhoenixAiBinding, assertPhoenixAiCustody } from './phoenix-policy';
import { buildPhoenixAiEntry, phoenixAiFill } from './phoenix-sizing';

export interface PhoenixAiExecution {
  botId: string; decisionId: string; intent: PhoenixOrderIntent; policyHash: string; authority: PhoenixOrderAuthority;
}
export interface PhoenixAiRepository {
  bot(id: string): Promise<AiTraderBot | undefined>;
  decision(id: string): Promise<AiTraderDecision | undefined>;
  execution(botId: string): Promise<PhoenixAiExecution | null>;
  prepare(bot: AiTraderBot, decisionId: string, intent: PhoenixOrderIntent, authority: PhoenixOrderAuthority): Promise<PhoenixAiExecution>;
  claim(bot: AiTraderBot, decisionId: string, source: 'external_http' | 'internal_cycle'): Promise<boolean>;
  graduate(expected: AiTraderBot, binding: PhoenixAiBinding, policyHmac: string): Promise<AiTraderBot | null>;
  open(bot: AiTraderBot, execution: PhoenixAiExecution, order: PhoenixOrderRecord): Promise<boolean>;
  noLand(bot: AiTraderBot, execution: PhoenixAiExecution): Promise<boolean>;
  recoverPrepared(bot: AiTraderBot, execution: PhoenixAiExecution): Promise<boolean>;
  unprotected(bot: AiTraderBot, execution: PhoenixAiExecution, order: PhoenixOrderRecord): Promise<void>;
  close(bot: AiTraderBot, execution: PhoenixAiExecution, result: Awaited<ReturnType<PhoenixSafetyService['close']>>): Promise<boolean>;
}
export interface PhoenixAiSource {
  custody(id: string): Promise<TradingBot | undefined>;
  verifyPolicy(bot: AiTraderBot): Promise<boolean>;
  policyHmac(bot: AiTraderBot): Promise<string>;
  /** Complete fresh owner and bot debt enumeration. AI borrow deployment is
   * unavailable until its own U11 consent/IO gate is installed. */
  debt(bot: AiTraderBot, executionBotId: string): Promise<{ ownerWallet: string; executionBotId: string;
    complete: boolean; debtRaw: string; observedAt: number; source: string; reference: string }>;
  snapshot(bot: AiTraderBot, binding: PhoenixAiBinding): Promise<{ authority: PhoenixOrderAuthority; sequence: string;
    equity?: { micros: string; observedAt: number; source: string; reference: string } }>;
  closeIntent(bot: AiTraderBot, execution: PhoenixAiExecution): Promise<PhoenixOrderIntent>;
  /** U07/U08 reconciled venue-detected exit, with the same U05/U06 raw proof. */
  exit(bot: AiTraderBot, execution: PhoenixAiExecution): Promise<Awaited<ReturnType<PhoenixSafetyService['close']>> | null>;
  analysis(bot: AiTraderBot): Partial<ProtocolAdapter>;
  registrationTerms: { maxPositions: number; maxCostLamports: string };
}

/** Factory-only integration: the same reviewed U03/U04/U05/U06 services, not
 * adapter placeMarketOrder. Production IO remains uninstalled in U14. */
export class PhoenixAiTraderService {
  constructor(private readonly repository: PhoenixAiRepository, private readonly source: PhoenixAiSource,
    private readonly consumers: Pick<PhoenixConsumerService, 'create'>,
    private readonly orders: Pick<PhoenixOrderService, 'execute' | 'reconcile'>,
    private readonly orderStore: Pick<PhoenixOrderStore, 'find'>,
    private readonly safety: Pick<PhoenixSafetyService, 'close' | 'protect'>,
    private readonly enabled = () => false, private readonly now = Date.now) {}

  analysis(bot: AiTraderBot): Partial<ProtocolAdapter> {
    const b = assertPhoenixAiBinding(bot), reads = this.source.analysis(bot);
    return { ...reads, protocolName: 'phoenix', getPositions: async (account, subaccount) => {
      if (account !== b.identity.traderAccountAddress || subaccount !== undefined || !reads.getPositions) throw new Error('Phoenix AI read identity mismatch');
      return reads.getPositions(account);
    }, getBalances: async (account, subaccount) => {
      if (account !== b.identity.traderAccountAddress || subaccount !== undefined || !reads.getBalances) throw new Error('Phoenix AI read identity mismatch');
      return reads.getBalances(account);
    } };
  }
  private async debt(bot: AiTraderBot, executionBotId: string) {
    const p = await this.source.debt(bot, executionBotId), now = this.now();
    if (p.ownerWallet !== bot.walletAddress || p.executionBotId !== executionBotId || !p.complete
      || p.debtRaw !== '0' || !p.source || !p.reference || !Number.isSafeInteger(p.observedAt)
      || p.observedAt > now || now - p.observedAt >= 5000) throw new Error('Phoenix AI debt consent unavailable');
  }
  private async authorize(bot: AiTraderBot, newRisk: boolean) {
    const b = assertPhoenixAiBinding(bot), custody = await this.source.custody(b.executionBotId);
    if (!custody || (newRisk && !await this.source.verifyPolicy(bot))) throw new Error('Phoenix AI policy/key unavailable');
    assertPhoenixAiCustody(bot, custody);
    if (!custody.botSubaccountKeyEncryptedV3 && (custody.derivationIndex == null || custody.derivationPathVersion !== 1)) throw new Error('Phoenix AI bot key missing');
    if (newRisk && phoenixRiskStopped(custody.subaccountStatus)) throw new Error('Phoenix AI custody is recovery-only');
    return b;
  }
  async graduate(input: AiTraderBot): Promise<AiTraderBot | null> {
    const bot = await this.repository.bot(input.id);
    if (!this.enabled() || !bot || bot.protocol !== 'phoenix' || !bot.paperMode || bot.status !== 'idle'
      || !canGoLive(bot.graduationState, bot.currentQualificationEraDigest, bot.graduatedQualificationEraDigest).ok
      || !await this.source.verifyPolicy(bot)) throw new Error('Phoenix AI graduation unavailable');
    const requestId = `ai:${bot.id}`, executionBotId = phoenixCreationId(bot.walletAddress, requestId);
    await this.debt(bot, executionBotId);
    if (!/^[0-9]+\.[0-9]{2}$/.test(bot.allocatedUsdc) || bot.allocatedUsdc.includes('\n')) throw new Error('Phoenix AI funding amount invalid');
    const initialFundingBaseUnits = String(BigInt(bot.allocatedUsdc.replace('.', '')) * 10000n);
    const result = await this.consumers.create({ ownerWallet: bot.walletAddress, requestId,
      name: `AI Trader ${bot.market}`, market: bot.market, ...this.source.registrationTerms,
      consumer: { kind: 'ai', initialFundingBaseUnits } });
    if (!result.funded || result.status !== 'completed' || result.botId !== executionBotId || !result.identity) return null;
    const custody = await this.source.custody(executionBotId);
    if (!custody || !Number.isSafeInteger(custody.derivationIndex) || custody.derivationPathVersion !== 1) throw new Error('Phoenix AI provisioned custody missing');
    const binding: PhoenixAiBinding = { version: 1, aiBotId: bot.id, executionBotId, identity: result.identity,
      derivationIndex: custody.derivationIndex!, derivationPathVersion: 1 };
    const live = { ...bot, paperMode: false, phoenixExecutionBotId: executionBotId, phoenixBinding: binding,
      protocolSubaccountId: binding.identity.traderAccountAddress };
    assertPhoenixAiCustody(live, custody);
    // Repeat consent and the independent AI gate after potentially slow funding.
    await this.debt(bot, executionBotId);
    if (!this.enabled() || phoenixRiskStopped(custody.subaccountStatus)) return null;
    return this.repository.graduate(bot, binding, await this.source.policyHmac(live));
  }
  async entry(input: ExecuteDecisionInput): Promise<ExecuteDecisionResult> {
    try {
      if (!this.enabled()) throw new Error('Phoenix AI live gate disabled');
      const bot = await this.repository.bot(input.bot.id), d = await this.repository.decision(input.decisionId);
      if (!bot || bot.paperMode || bot.protocol !== 'phoenix' || !d || d.botId !== bot.id || d.outcome !== null
        || orderIntentHash(d.clampedDecision) !== orderIntentHash(input.clamped)
        || (d.contextDigest as any)?.executionVenue !== 'phoenix'
        || (d.rawDecision as any)?.action !== input.clamped.action
        || !bot.currentQualificationEraDigest || d.qualificationEraDigest !== bot.currentQualificationEraDigest) throw new Error('Phoenix AI decision identity changed');
      const binding = await this.authorize(bot, true);
      await this.debt(bot, binding.executionBotId);
      const existing = await this.repository.execution(bot.id);
      if (existing && existing.decisionId !== d.id) throw new Error('Phoenix AI previous execution requires recovery');
      if (existing && existing.decisionId === d.id) {
        if (existing.policyHash !== orderIntentHash(aiTraderPolicyObject(bot))) throw new Error('Phoenix AI replay policy changed');
        if (bot.status === 'proposed' || bot.status === 'analyzing') {
          if (!await this.repository.claim(bot, d.id, input.authoritySource ?? 'external_http')) throw new Error('Phoenix AI replay claim lost');
        }
        return this.adopt(await this.repository.bot(bot.id) ?? bot, existing);
      }
      const snapshot = await this.source.snapshot(bot, binding), equity = snapshot.equity;
      if (bot.sizingMode === 'risk_based' && (!equity || !equity.source || !equity.reference
        || !Number.isSafeInteger(equity.observedAt) || equity.observedAt > this.now()
        || this.now() - equity.observedAt >= 5000)) throw new Error('Phoenix AI sizing equity unknown');
      const intent = buildPhoenixAiEntry(bot, d.id, input.clamped, snapshot.authority, snapshot.sequence, this.now(), equity?.micros);
      const execution = await this.repository.prepare(bot, d.id, intent, snapshot.authority);
      if (!await this.repository.claim(bot, d.id, input.authoritySource ?? 'external_http')) throw new Error('Phoenix AI execution claim lost');
      const fresh = await this.repository.bot(bot.id);
      if (!fresh || fresh.status !== 'executing' || !this.enabled() || orderIntentHash(aiTraderPolicyObject(fresh)) !== execution.policyHash) throw new Error('Phoenix AI authority changed before entry');
      await this.authorize(fresh, true); await this.debt(fresh, binding.executionBotId);
      const order = await this.orders.execute(execution.intent);
      return this.adopt(fresh, execution, order);
    } catch (e) { return { ok: false, reason: 'execution_revalidation_failed', detail: e instanceof Error ? e.message : 'Phoenix AI authority unavailable' }; }
  }
  private async adopt(bot: AiTraderBot, execution: PhoenixAiExecution, supplied?: PhoenixOrderRecord): Promise<ExecuteDecisionResult> {
    const previous = supplied ?? await this.orderStore.find(execution.intent);
    if (!previous) {
      if (bot.status !== 'executing' || !await this.repository.noLand(bot, execution)) return { ok: false, reason: 'position_unconfirmed', detail: 'Phoenix AI no-land transition conflict; recovery retained' };
      return { ok: false, reason: 'order_failed', detail: 'Phoenix AI preparation has no durable U05 attempt; no transaction was sent' };
    }
    const order = supplied ?? await this.orders.reconcile(execution.intent, previous.id);
    if (order.state === 'rejected' && !order.data.fills?.length) {
      if (!await this.repository.noLand(bot, execution)) return { ok: false, reason: 'position_unconfirmed', detail: 'Phoenix AI rejection transition conflict; recovery retained' };
      return { ok: false, reason: 'order_failed', detail: 'Phoenix AI entry rejected' };
    }
    let fill: ReturnType<typeof phoenixAiFill>;
    try { fill = phoenixAiFill(order); } catch {
      return { ok: false, reason: 'position_unconfirmed', detail: 'Phoenix AI entry outcome unknown; recover the same durable order' };
    }
    try {
      const binding = await this.authorize(bot, false);
      const operation = await this.safety.protect({ botId: binding.executionBotId, ownerWallet: bot.walletAddress,
        requestKey: `ai:protect:${execution.decisionId}`, identity: binding.identity, market: execution.intent.market,
        assetId: order.data.admission.authority.assetId, action: 'replace', prices: execution.intent.protection });
      const p = operation.observation?.protection as import('../protocol/phoenix/protection-contract').ProtectionProgress | undefined;
      if (operation.state !== 'completed' || !p) throw new Error('Phoenix AI bracket not confirmed');
      assertProtectionSnapshot(p.after, { identity: binding.identity, market: execution.intent.market,
        assetId: order.data.admission.authority.assetId }, this.now());
      if (p.after.position.epoch !== order.data.positionEpoch || p.after.position.baseLots !== fill.lots
        || p.after.position.side !== (execution.intent.side === 'buy' ? 'long' : 'short')
        || !protectionStatus(p.after, execution.intent.protection!).protected) throw new Error('Phoenix AI bracket identity mismatch');
      if (!await this.repository.open(bot, execution, order)) throw new Error('Phoenix AI open journal conflict');
      return { ok: true, mode: 'live', entryPrice: fill.entryPrice };
    } catch {
      // Protection failure never suppresses the independent reduce-only close.
      try { await this.repository.unprotected(bot, execution, order); }
      catch { /* The immutable execution and U05 receipt retain recovery authority. */ }
      finally { await this.close(bot).catch(() => undefined); }
      return { ok: false, reason: 'bracket_failed', detail: 'Phoenix AI protection unverified; shared close attempted, recovery retained' };
    }
  }
  async reconcile(bot: AiTraderBot): Promise<boolean> {
    const execution = await this.repository.execution(bot.id);
    if (!execution) return bot.status === 'idle';
    if (bot.status === 'idle') return this.repository.recoverPrepared(bot, execution);
    const exit = await this.source.exit(bot, execution);
    if (exit && this.closed(execution, exit)) return this.repository.close(bot, execution, exit);
    // Recovery remains available with the AI entry gate disabled.
    if (bot.status === 'paused' && bot.pauseReason === 'bracket_failed') return (await this.close(bot)).closed;
    const result = await this.adopt(bot, execution);
    return result.ok || result.reason === 'order_failed';
  }
  async close(input: AiTraderBot): Promise<{ ok: true; closed: boolean } | { ok: false; detail: string; closed: false }> {
    const bot = await this.repository.bot(input.id), execution = bot && await this.repository.execution(bot.id);
    if (!bot || !execution) return { ok: false, closed: false, detail: 'Phoenix AI close identity unavailable' };
    await this.authorize(bot, false);
    const intent = await this.source.closeIntent(bot, execution);
    if (intent.action !== 'close' || intent.botId !== execution.intent.botId || intent.ownerWallet !== bot.walletAddress
      || intent.market !== execution.intent.market || orderIntentHash(intent.identity) !== orderIntentHash(execution.intent.identity)) throw new Error('Phoenix AI close binding mismatch');
    const result = await this.safety.close(intent);
    // Exit cannot be held hostage by conditional account or entry data failure.
    if (!this.closed(execution, result)) return { ok: true, closed: false };
    try { await this.safety.protect({ botId: intent.botId, ownerWallet: bot.walletAddress, requestKey: `ai:cancel:${execution.decisionId}`,
      identity: intent.identity, market: intent.market, assetId: result.before.assetId, action: 'cancel' }); } catch { /* retain custody for recovery */ }
    return { ok: true, closed: await this.repository.close(bot, execution, result) };
  }
  private closed(e: PhoenixAiExecution, result: Awaited<ReturnType<PhoenixSafetyService['close']>>) {
    const a = result.after, i = result.order.intent;
    return result.positionClosed && result.order.state === 'settled' && result.order.data.remainingPositionLots === '0'
      && i.action === 'close' && i.botId === e.intent.botId && i.market === e.intent.market
      && i.ownerWallet === e.intent.ownerWallet && !!result.order.data.outcomeSource && !!result.order.data.outcomeReference
      && orderIntentHash(i.identity) === orderIntentHash(e.intent.identity)
      && a?.venue === 'phoenix' && a.trader === e.intent.identity.traderAccountAddress && a.market === e.intent.market
      && !a.refreshFailed && !!a.source && !!a.reference && a.position.side === 'flat' && a.position.baseLots === '0'
      && Number.isSafeInteger(a.observedAt) && a.observedAt <= this.now() && this.now() - a.observedAt < 5000
      && Number.isSafeInteger(a.position.observedAt) && a.position.observedAt <= this.now()
      && this.now() - a.position.observedAt < 5000;
  }
}
