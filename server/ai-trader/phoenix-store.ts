import { marketEntryKey, lockRetainedMarketEntry, confirmMarketEntry, type CooldownQuery } from './market-entry-cooldown';
import type { Pool } from 'pg';
import type { AiTraderBot } from '@shared/schema';
import { storage } from '../storage';
import { appendTelemetry } from '../telemetry';
import type { PhoenixAiBinding } from '../../shared/phoenix-ai-contract';
import { aiTraderPolicyObject, assertPhoenixAiBinding } from './phoenix-policy';
import { orderIntentHash, type PhoenixOrderIntent, type PhoenixOrderAuthority } from '../protocol/phoenix/order-contract';
import type { PhoenixOrderRecord } from '../protocol/phoenix/order-store';
import type { PhoenixSafetyService } from '../protocol/phoenix/safety-service';
import { phoenixAiFill } from './phoenix-sizing';
import { phoenixAiClosedAccounting } from './phoenix-accounting';
import { assertPhoenixAiCustody } from './phoenix-policy';
import { PhoenixAccountingStore } from '../protocol/phoenix/accounting-store';
import { PhoenixOrderStore } from '../protocol/phoenix/order-store';
import { reconcilePhoenixBotAccounting, phoenixAccountingTarget } from '../protocol/phoenix/accounting-runtime';
import { appendRequiredEntryPrebroadcast, journalBase, type JournalEventInput } from './execution-journal';
import type { PhoenixAiRepository, PhoenixAiExecution } from './phoenix-live';
import { AI_TRADER_PROPOSAL_EXPIRY_MS } from './state-authority';

/** U14 records only the consumer binding. U05 owns signing/attempts/receipts.
 * AI transitions keep the existing atomic journal and decision predicates. */
export class PhoenixAiStore implements PhoenixAiRepository {
  constructor(private readonly pool: Pick<Pool, 'query' | 'connect'>, private readonly now = Date.now) {}
  bot(id: string) { return storage.getAiTraderBot(id); }
  decision(id: string) { return storage.getAiTraderDecision(id); }
  async execution(botId: string): Promise<PhoenixAiExecution | null> {
    const { rows: [r] } = await this.pool.query(`SELECT * FROM phoenix_ai_executions WHERE bot_id=$1
      AND state IN ('prepared','open','attention')`, [botId]);
    return r ? { botId: r.bot_id, decisionId: r.decision_id, intent: r.intent, policyHash: r.policy_hash, authority: r.authority } : null;
  }
  async prepare(bot: AiTraderBot, decisionId: string, intent: PhoenixOrderIntent, authority: PhoenixOrderAuthority) {
    const b = assertPhoenixAiBinding(bot), policyHash = orderIntentHash(aiTraderPolicyObject(bot));
    if (intent.botId !== b.executionBotId || intent.ownerWallet !== bot.walletAddress
      || intent.requestKey !== `ai:entry:${decisionId}` || orderIntentHash(intent.identity) !== orderIntentHash(b.identity)) throw new Error('Phoenix AI intent binding mismatch');
    const { rows: [r] } = await this.pool.query(`INSERT INTO phoenix_ai_executions
      (bot_id,decision_id,execution_bot_id,intent,policy_hash,authority) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (bot_id,decision_id) DO UPDATE SET bot_id=EXCLUDED.bot_id RETURNING *`,
    [bot.id, decisionId, b.executionBotId, intent, policyHash, authority]);
    if (!r || r.execution_bot_id !== b.executionBotId || r.policy_hash !== policyHash
      || orderIntentHash(r.intent) !== orderIntentHash(intent)) throw new Error('Phoenix AI replay payload mismatch');
    return { botId: bot.id, decisionId, intent: r.intent as PhoenixOrderIntent, policyHash, authority: r.authority as PhoenixOrderAuthority };
  }
  async claim(bot: AiTraderBot, decisionId: string, source: 'external_http' | 'internal_cycle') {
    const claim = await storage.claimAiTraderExecution({ botId: bot.id, decisionId,
      expectedStatus: source === 'external_http' ? 'proposed' : 'analyzing', now: new Date(this.now()), expiryMs: AI_TRADER_PROPOSAL_EXPIRY_MS, expectedIdentity: marketEntryKey(bot) });
    if (claim.status !== "claimed") return claim;
    const execution = await this.execution(bot.id);
    if (!execution || execution.decisionId !== decisionId) throw new Error('Phoenix AI prebroadcast identity missing');
    // This required journal write is before the shared order service can sign.
    const a = execution.authority;
    if (a.price.source !== 'phoenix-execution' || a.price.observedAt > this.now()
      || this.now() - a.price.observedAt >= 5000) throw new Error('Phoenix AI prebroadcast price expired');
    await appendRequiredEntryPrebroadcast({ bot, decisionId, side: execution.intent.side === 'buy' ? 'long' : 'short',
      clientOrderId: execution.intent.requestKey, sizeBase: Number(execution.intent.baseUnits),
      price: Number(a.price.usd), observedAt: new Date(a.price.observedAt) });
    return claim;
  }
  async graduate(bot: AiTraderBot, binding: PhoenixAiBinding, policyHmac: string): Promise<AiTraderBot | null> {
    const { rows } = await this.pool.query(`UPDATE ai_trader_bots SET phoenix_execution_bot_id=$2,phoenix_binding=$3,
      protocol_subaccount_id=$4,policy_hmac=$5,paper_mode=false,updated_at=now()
      WHERE id=$1 AND wallet_address=$6 AND protocol='phoenix' AND paper_mode=true AND status='idle'
        AND policy_hmac=$7 AND allocated_usdc=$8 AND market=$9 AND max_leverage=$10
        AND graduation_state=$12 AND (graduation_state='waived' OR (current_qualification_era_digest=$11
        AND graduated_qualification_era_digest=$11)) RETURNING id`,
    [bot.id, binding.executionBotId, binding, binding.identity.traderAccountAddress, policyHmac, bot.walletAddress,
      bot.policyHmac, bot.allocatedUsdc, bot.market, bot.maxLeverage, bot.currentQualificationEraDigest, bot.graduationState]);
    return rows.length ? await this.bot(bot.id) ?? null : null;
  }
  private async state(e: PhoenixAiExecution, state: string) {
    await this.pool.query('UPDATE phoenix_ai_executions SET state=$3 WHERE bot_id=$1 AND decision_id=$2', [e.botId, e.decisionId, state]);
  }
  async open(bot: AiTraderBot, e: PhoenixAiExecution, order: PhoenixOrderRecord) {
    const f = phoenixAiFill(order), d = await this.decision(e.decisionId);
    if (d?.outcome === 'executed' && Number(d.entryPrice).toFixed(8) === f.entryPrice.toFixed(8) && bot.status === 'open') { await this.state(e, 'open'); return true; }
    if (!d?.decidedAt) return false;
    const observedAt = new Date(d.decidedAt), side = e.intent.side === 'buy' ? 'long' : 'short';
    const base = { ...journalBase(bot, e.decisionId), attemptId: `entry:${e.decisionId}`, action: 'entry' as const,
      cause: 'decision' as const, side: side as 'long' | 'short', observedAt, recordedAfterBroadcast: true };
    const result = await storage.commitAiTraderDirectLiveEntryTransition({ botId: bot.id, decisionId: e.decisionId,
      disposition: 'open', side, observedAt, entryPrice: f.entryPrice, sizeBase: f.sizeBase, journalEvents: [
        { ...base, eventType: 'broadcast_result', venueStatus: order.state === 'settled' ? 'filled' : 'partial_fill',
          venueOrderId: order.data.orderId, transactionSignature: order.data.attempt?.signature },
        { ...base, eventType: 'position_observed', price: f.entryPrice, sizeBase: f.sizeBase },
        { ...base, eventType: 'fill_observed', price: f.entryPrice, sizeBase: f.sizeBase, fee: f.fee },
        { ...base, eventType: 'bracket_verified' },
        { ...base, eventType: 'entry_terminal_open', price: f.entryPrice, sizeBase: f.sizeBase },
      ] });
    if (result.status === 'conflict') return false;
    await this.state(e, 'open'); return true;
  }
  async noLand(bot: AiTraderBot, e: PhoenixAiExecution) {
    const d = await this.decision(e.decisionId);
    if (!d?.decidedAt) return false;
    const observedAt = new Date(d.decidedAt), side = e.intent.side === 'buy' ? 'long' : 'short';
    const base = { ...journalBase(bot, e.decisionId), attemptId: `entry:${e.decisionId}`, action: 'entry' as const,
      cause: 'decision' as const, side: side as 'long' | 'short', observedAt, failureCode: 'venue_rejected' as const, recordedAfterBroadcast: true };
    const result = await storage.commitAiTraderDirectLiveEntryTransition({ botId: bot.id, decisionId: e.decisionId,
      disposition: 'no_land', side, observedAt, journalEvents: [
        { ...base, eventType: 'broadcast_result', venueStatus: 'rejected' }, { ...base, eventType: 'entry_terminal_no_land' },
      ] });
    if (result.status === 'conflict') return false;
    await this.state(e, 'no_land'); return true;
  }
  async recoverPrepared(bot: AiTraderBot, e: PhoenixAiExecution) {
    // The AI row lock serializes this with claimAiTraderExecution. A claim that
    // has won changes status to executing before the order service can sign.
    const { rows } = await this.pool.query(`WITH idle_bot AS MATERIALIZED (
      SELECT id FROM ai_trader_bots WHERE id=$1 AND protocol='phoenix'
        AND paper_mode=false AND status='idle' FOR UPDATE)
      UPDATE phoenix_ai_executions e SET state='no_land'
      FROM idle_bot b WHERE e.bot_id=b.id AND e.decision_id=$2 AND e.state='prepared'
        AND e.execution_bot_id=$3 AND e.intent->>'requestKey'=$4
        AND NOT EXISTS (SELECT 1 FROM phoenix_order_intents o WHERE o.bot_id=e.execution_bot_id
          AND o.request_key=e.intent->>'requestKey') RETURNING e.bot_id`,
    [bot.id, e.decisionId, e.intent.botId, e.intent.requestKey]);
    return rows.length === 1;
  }
  async unprotected(bot: AiTraderBot, e: PhoenixAiExecution, order: PhoenixOrderRecord) {
    const f = phoenixAiFill(order), client = await this.pool.connect();
    const query: CooldownQuery = async (text, values) => client.query(text, values ? [...values] : undefined);
    try {
      await client.query('BEGIN');
      await client.query('SAVEPOINT cooldown_identity');
      let cooldownHeld = false;
      try {
        cooldownHeld = await lockRetainedMarketEntry(query, bot.id, e.decisionId);
        await client.query('RELEASE SAVEPOINT cooldown_identity');
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT cooldown_identity');
        appendTelemetry('ai_trader_market_cooldown_reconciliation_required');
      }
      // Row count distinguishes the first durable fill from replay.
      const { rows } = await client.query(`UPDATE ai_trader_decisions SET outcome='executed',entry_price=$3
        WHERE bot_id=$1 AND id=$2 AND closed_at IS NULL AND outcome IS NULL RETURNING id`,
      [bot.id, e.decisionId, f.entryPrice]);
      await client.query(`UPDATE ai_trader_bots SET status='paused',pause_reason='bracket_failed',updated_at=now()
        WHERE id=$1 AND protocol='phoenix' AND paper_mode=false
          AND EXISTS(SELECT 1 FROM ai_trader_decisions WHERE id=$2 AND bot_id=$1 AND outcome='executed' AND closed_at IS NULL)`,
      [bot.id, e.decisionId]);
      if (rows.length && cooldownHeld) {
        await client.query('SAVEPOINT cooldown_confirmation');
        try {
          await confirmMarketEntry(query, bot.id, e.decisionId);
          await client.query('RELEASE SAVEPOINT cooldown_confirmation');
        } catch {
          await client.query('ROLLBACK TO SAVEPOINT cooldown_confirmation');
          appendTelemetry('ai_trader_market_cooldown_reconciliation_required');
        }
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    await this.state(e, 'attention');
  }
  async close(bot: AiTraderBot, e: PhoenixAiExecution, result: Awaited<ReturnType<PhoenixSafetyService['close']>>) {
    if (!result.positionClosed) return false;
    const exit = phoenixAiFill(result.order);
    let accounting: ReturnType<typeof phoenixAiClosedAccounting> | null = null;
    try {
      const custody = await storage.getTradingBotById(e.intent.botId);
      if (!custody) throw new Error('Phoenix AI accounting custody missing');
      assertPhoenixAiCustody(bot, custody);
      if (!(await reconcilePhoenixBotAccounting(custody)).synced) throw new Error('Phoenix AI accounting pending');
      const entry = await new PhoenixOrderStore(this.pool).find(e.intent);
      if (!entry) throw new Error('Phoenix AI accounting entry unavailable');
      accounting = phoenixAiClosedAccounting(await new PhoenixAccountingStore(this.pool, this.now)
        .read(phoenixAccountingTarget(custody)), entry, result.order, this.now());
    } catch { /* Shared history incomplete: retain unknown PnL and daily-risk hold. */ }
    const observedAt = accounting?.closedAt ?? new Date(this.now());
    const dayStart = new Date(observedAt); dayStart.setUTCHours(0, 0, 0, 0);
    const side = e.intent.side === 'buy' ? 'long' : 'short';
    const base = { ...journalBase(bot, e.decisionId), attemptId: `close:${e.decisionId}`, action: 'close' as const,
      cause: 'venue_detected' as const, side: side as 'long' | 'short', observedAt, recordedAfterBroadcast: true };
    // U07 cashflow/PnL must reconcile independently. A fill is not proof of net
    // PnL or complete fees; unknown values retain the existing daily-risk hold.
    const journalEvents: JournalEventInput[] = [
      { ...base, eventType: 'attempt_claimed' },
      { ...base, eventType: 'fill_observed', price: exit.entryPrice, sizeBase: exit.sizeBase,
        fee: accounting?.feesPaid ?? null, realizedPnl: accounting?.realizedPnl ?? null },
      { ...base, eventType: 'close_terminal_confirmed', price: exit.entryPrice, sizeBase: exit.sizeBase,
        fee: accounting?.feesPaid ?? null, realizedPnl: accounting?.realizedPnl ?? null },
    ];
    const transition = await storage.commitAiTraderConfirmedCloseTransition({ botId: bot.id, decisionId: e.decisionId,
      expectedBotStatus: bot.status, expectedPauseReason: bot.pauseReason, side, sizeBase: exit.sizeBase,
      close: { exitPrice: exit.entryPrice, exitReason: accounting?.liquidation ? 'liquidation' : 'venue_detected',
        realizedPnl: accounting?.realizedPnl ?? null, feesPaid: accounting?.feesPaid ?? null, closedAt: observedAt },
      isStopLossLoss: false, forcedPauseReason: accounting ? null : 'phoenix_accounting_pending', dayStart,
      policy: { recentClosedLimit: 60, malfunctionTradesPerDay: 20, consecutiveSlLimit: 3, dailyLossBreakerPct: 15 }, journalEvents });
    if (transition.status === 'conflict') return false;
    await this.state(e, 'closed'); return true;
  }
}
