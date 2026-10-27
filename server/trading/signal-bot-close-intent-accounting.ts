import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import { botTrades, botPositions, botSubscriptions, publishedBots, pendingProfitShares } from '@shared/schema';
import type { ProtocolAdapter } from '../protocol/adapter';
import type { CloseIntent, CloseScope } from './signal-bot-close-intent-types';
import { subscriberCloseAccounting, subscriberPartialExecution } from './subscriber-close-accounting';
import type { CloseResult, CloseSnapshot } from '../protocol/close-outcome';
import { summarizeSignalBotCloseFills } from './signal-bot-close-integrity';

export type IntentFill = NonNullable<ReturnType<typeof summarizeSignalBotCloseFills>>;

/** Read history under the scope lock, using DB time on both sides of the read. */
export async function readIntentFillEvidence(scope: CloseScope, adapter: ProtocolAdapter, intent: CloseIntent) {
  const { closeIntentStore: store } = await import('./close-intent-store');
  const attempt = intent.attempt_log[intent.attempt_log.length - 1];
  const orderId = attempt?.outcome?.kind === 'acknowledged' ? attempt.outcome.orderId : undefined;
  let trades: import('../protocol/protocol-types').TradeRecord[] = [];
  if (orderId) try {
    trades = await adapter.getTradeHistory(intent.original_account, { internalSymbol: intent.market,
      startTime: attempt.timestamp, endTime: await store.databaseTime(scope), limit: 200, maxPages: 10 });
  } catch { /* Retain unavailable economics without replaying the send. */ }
  const observedAt = await store.databaseTime(scope);
  const after = intent.last_evidence.after as CloseSnapshot | undefined;
  const remaining = after?.positions.find(p => p.internalSymbol === intent.market)?.baseSize;
  const closeResult: CloseResult = { account: intent.original_account, market: intent.market,
    outcome: intent.close_kind === 'partial' || (remaining !== undefined && remaining !== 0) ? 'partial'
      : intent.last_evidence.objectiveMet === true ? 'confirmed' : 'unknown',
    baseline: intent.position_epoch.strictBaseline?.evidence, observation: after?.evidence,
    remainingSize: after ? remaining ?? 0 : undefined, reason: 'durable_close_observation' };
  const accounting = subscriberCloseAccounting({ account: intent.original_account, market: intent.market,
    orderId, openSide: intent.position_side, requestedSize: Number(intent.requested_size_base),
    sentAt: attempt?.timestamp ?? observedAt, observedAt, baseline: intent.position_epoch.strictBaseline ?? undefined,
    closeResult, trades });
  // The strict accounting validator rejects duplicates, invalid identities and overcoverage.
  let fill = accounting.size !== null && accounting.fee !== null && accounting.price !== null
    && Number(accounting.size) === Number(intent.requested_size_base)
    ? summarizeSignalBotCloseFills({ trades: trades.filter(t => t.orderId === orderId), market: intent.market, openSide: intent.position_side,
      expectedSize: Number(intent.requested_size_base), notBeforeMs: attempt.timestamp, requireExactSize: true }) : null;
  if (fill && intent.authority_ref.subscriberAccounting === true) {
    const net = intent.close_kind === 'partial' ? subscriberPartialExecution(accounting).pnl
      : accounting.pnl === null ? null : Number(accounting.pnl);
    fill = { ...fill, realizedPnl: net === null ? null : net + fill.fee };
  }
  return { fill, accounting, closeResult };
}

export async function attributableIntentFill(adapter: ProtocolAdapter, intent: CloseIntent, scope: CloseScope): Promise<IntentFill | null> {
  return (await readIntentFillEvidence(scope, adapter, intent)).fill;
}

/** Route and worker enter this writer with the scope lock and DB transaction held. */
export async function accountDurableClose(client: any, intent: CloseIntent,
  mode: 'confirmed' | 'flat' | 'still_open' | 'residual' | 'not_sent', fill?: IntentFill | null): Promise<void> {
  const { storage, DatabaseStorage } = await import('../storage');
  const db = drizzle(client);
  const [trade] = await db.select().from(botTrades).where(eq(botTrades.id, intent.original_trade_id));
  if (!trade) throw new Error('close_intent_trade_missing');
  const payload = trade.webhookPayload && typeof trade.webhookPayload === 'object' ? trade.webhookPayload : {};
  const flat = mode === 'flat' || (mode === 'confirmed' && intent.close_kind === 'full');
  const partial = mode === 'confirmed' && intent.close_kind === 'partial';
  const orderId = intent.attempt_log[intent.attempt_log.length - 1]?.outcome?.orderId;
  const exact = mode === 'confirmed' && fill && fill.realizedPnl !== null ? fill : null;
  const netPnl = exact ? exact.realizedPnl! - exact.fee : null;
  const fillId = DatabaseStorage.canonicalCloseFillId({ signature: orderId ?? `close-intent-${intent.id}`,
    botId: intent.bot_id, side: 'CLOSE', market: intent.market, size: Number(intent.requested_size_base) });
  const closeAccounting = exact ? { kind: 'venue_exact', fillPrice: exact.fillPrice, pnl: exact.realizedPnl!, fee: exact.fee,
    protocolFillId: fillId, observedAt: exact.fillTimestampMs } : { kind: 'unavailable', reason: 'venue_fill_unattributed',
    observedAt: (intent.last_evidence.after as any)?.evidence.receivedAt ?? null, observationPrice: null };
  const [position] = partial ? await db.select().from(botPositions).where(and(eq(botPositions.tradingBotId, intent.bot_id), eq(botPositions.market, intent.market))) : [];
  const after = intent.last_evidence.after as import('../protocol/close-outcome').CloseSnapshot | undefined;
  const residual = after?.positions.find(p => p.internalSymbol === intent.market);
  if (partial && (!position || !residual || !Number.isFinite(residual.entryPrice))) throw new Error('partial_close_residual_unavailable');
  const result = await storage.recordCloseEventAtomic({ botId: intent.bot_id,
    update: { tradeId: intent.original_trade_id, fields: {
      status: flat || partial ? 'executed' : 'failed',
      fee: exact ? String(exact.fee) : null, pnl: netPnl === null ? null : String(netPnl),
      price: exact ? String(exact.fillPrice) : '0', txSignature: orderId ?? null,
      ...(flat || partial ? { protocolFillId: fillId } : {}),
      errorMessage: flat || partial ? null : mode === 'still_open' ? 'close_expired_unconfirmed'
        : mode === 'not_sent' ? 'close_not_sent' : 'close_residual_attention',
      webhookPayload: { ...payload, closeIntentId: intent.id, closeAttention: mode === 'residual', closeAccounting,
        ...(partial ? { partialCloseAccounting: { status: exact ? 'complete' : 'accounting_unavailable' } } : {}) },
    } }, deltas: { totalPnlDelta: netPnl ?? 0, totalVolumeDelta: exact ? exact.fillPrice * exact.filledSize : 0 },
    ...(flat ? exact ? { confirmedPositionClose: { walletAddress: intent.owner_wallet, market: intent.market,
      realizedPnlDelta: netPnl!, feeDelta: exact.fee } } : { confirmedPositionCloseIncomplete: { walletAddress: intent.owner_wallet, market: intent.market } } : {}),
    ...(partial ? { confirmedPositionReduction: { market: intent.market,
      expectedBaseSize: intent.position_epoch.baseSize!, expectedLastTradeId: intent.position_epoch.lastTradeId,
      residualBaseSize: residual!.baseSize, residualEntryPrice: residual!.entryPrice,
      realizedPnlDelta: netPnl ?? 0, feeDelta: exact?.fee ?? 0 } } : {}),
  }, client);
  if (result.isNew && exact && netPnl! > 0) await persistCreatorShare(db, intent, netPnl!, fillId);
}

/** Deferred venue obligations commit with the close money; no signing or payout. */
async function persistCreatorShare(db: NodePgDatabase, intent: CloseIntent, pnl: number, fillId: string): Promise<void> {
  const [subscription] = await db.select({ published: publishedBots }).from(botSubscriptions)
    .innerJoin(publishedBots, eq(botSubscriptions.publishedBotId, publishedBots.id))
    .where(and(eq(botSubscriptions.subscriberBotId, intent.bot_id), eq(botSubscriptions.status, 'active'))).limit(1);
  if (!subscription) return;
  const published = subscription.published, percent = Number(published.profitSharePercent), amount = pnl * percent / 100;
  if (!Number.isFinite(percent) || percent <= 0 || amount < 0.01) return;
  await db.insert(pendingProfitShares).values({ subscriberBotId: intent.bot_id, subscriberWalletAddress: intent.owner_wallet,
    creatorWalletAddress: published.creatorWalletAddress, amount: String(amount), realizedPnl: String(pnl),
    profitSharePercent: String(percent), tradeId: fillId, publishedBotId: published.id,
    driftSubaccountId: null, protocolSubaccountId: intent.original_account, protocol: 'pacifica', status: 'deferred' })
    .onConflictDoNothing({ target: [pendingProfitShares.subscriberBotId, pendingProfitShares.tradeId] });
}

/** Claim under a short scope lock, then deliver outside every source scope lock. */
export async function notifyDurableClose(initial: CloseIntent, fill: IntentFill): Promise<void> {
  if (fill.realizedPnl === null) return;
  const { closeIntentStore: store } = await import('./close-intent-store');
  const intent = await store.withScope(initial.environment, initial.original_account, initial.market, async scope => {
    const current = await store.byId(scope, initial.id);
    if (!current || current.status !== 'confirmed' || current.last_evidence.notificationPending !== true) return;
    return store.updateConfirmedEvidence(scope, current, { notificationPending: false, notificationClaimed: true, notificationAttention: true });
  });
  if (!intent) return;
  const { sendTradeNotification } = await import('../notification-service');
  try {
    const bot = await (await import('../storage')).storage.getTradingBotById(intent.bot_id);
    await sendTradeNotification(intent.owner_wallet, { type: intent.close_kind === 'partial' ? 'partial_close' : 'position_closed', botName: bot?.name ?? 'Signal bot', market: intent.market,
      ...(intent.close_kind === 'partial' ? { side: intent.position_side === 'long' ? 'LONG' : 'SHORT', closedFraction: Number(intent.requested_size_base) / Number(intent.original_position_size_base), stageCount: 1 } : {}),
      size: fill.filledSize, price: fill.fillPrice, pnl: fill.realizedPnl! - fill.fee, closeReason: 'Close confirmed' });
    await store.withScope(intent.environment, intent.original_account, intent.market, async scope => {
      const current = await store.byId(scope, intent.id);
      if (current) await store.recordNotificationDelivered(scope, current);
    });
  } catch { /* The durable claim retains notification attention; uncertain delivery is never repeated. */ }
}

/** Exact money may arrive after terminal exposure, without replaying a close. */
export async function repairIntentAccounting(scope: CloseScope, intent: CloseIntent, adapter: ProtocolAdapter): Promise<void> {
  const { closeIntentStore: store } = await import('./close-intent-store');
  const { storage, DatabaseStorage } = await import('../storage');
  const fill = intent.last_evidence.accountingPending === true
    ? await attributableIntentFill(adapter, intent, scope) : intent.last_evidence.fill as IntentFill | null;
  if (intent.last_evidence.accountingPending === true && fill && fill.realizedPnl !== null) {
    await store.transaction(scope, async client => { const result = await storage.remediateReconcilerCloseAccountingAtomic({ botId: intent.bot_id,
      tradeId: intent.original_trade_id, closeIntentId: intent.id, evidence: { kind: 'venue_exact', fillPrice: fill.fillPrice, pnl: fill.realizedPnl!, fee: fill.fee,
        observedAt: fill.fillTimestampMs, protocolFillId: DatabaseStorage.canonicalCloseFillId({
          signature: intent.attempt_log[intent.attempt_log.length - 1].outcome!.orderId!, botId: intent.bot_id,
          side: 'CLOSE', market: intent.market, size: Number(intent.requested_size_base) }) } }, client);
      await persistCreatorShare(drizzle(client), intent, fill.realizedPnl! - fill.fee, result.trade.protocolFillId!);
    });
  }
  await store.recordAccountingRepair(scope, intent, !fill || fill.realizedPnl === null, fill);
}
