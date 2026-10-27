import { accountDurableClose } from './signal-bot-close-intent-accounting';
import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import type { InsertBotTrade } from '@shared/schema';
import type { ProtocolAdapter } from '../protocol/adapter';
import type { MarketOrderParams } from '../protocol/protocol-types';
import { validSnapshot, type CloseSnapshot } from '../protocol/close-outcome';
import type { CloseIntent, CloseScope, NewCloseIntent, StrictCloseOpenOrders } from './signal-bot-close-intent-types';
import { CLOSE_IN_PROGRESS } from './signal-bot-close-intent-types';
import { closeIntentStore as store } from './close-intent-store';

export function exactExposure(snapshot: CloseSnapshot, market: string): string | null {
  const position = snapshot.positions.find(row => row.internalSymbol === market);
  if (!position || position.baseSize === 0) return '0';
  return position.sizeBaseExact ?? null;
}

export function closeObjectiveMet(intent: CloseIntent, after: CloseSnapshot, databaseTime = after.evidence.receivedAt): boolean {
  if (!validSnapshot(after, intent.original_account, databaseTime) || after.evidence.environment !== intent.environment) return false;
  const attempt = intent.attempt_log[intent.attempt_log.length - 1];
  if (!attempt?.outcome?.orderId || attempt.outcome.kind !== 'acknowledged'
    || attempt.receivedAt === undefined || after.evidence.dispatchedAt! < attempt.receivedAt) return false;
  const bound = intent.last_evidence.watermarkLowerBound ?? intent.position_epoch.strictBaseline?.evidence.lastOrderId;
  if (typeof after.evidence.lastOrderId !== 'number' || (typeof bound === 'number' && after.evidence.lastOrderId < bound)) return false;
  const exposure = exactExposure(after, intent.market);
  if (exposure === null) return false;
  if (intent.close_kind === 'full') return new Decimal(exposure).isZero();
  const expected = new Decimal(intent.original_position_size_base).minus(intent.requested_size_base)
    .mul(intent.position_side === 'long' ? 1 : -1);
  return new Decimal(exposure).eq(expected);
}

export function closeReleaseEvidence(intent: CloseIntent, databaseTime: number,
  first: CloseSnapshot, second: CloseSnapshot, orders: StrictCloseOpenOrders): boolean {
  if (intent.attempt_count < 1 || intent.attempt_log.length !== intent.attempt_count) return false;
  if (intent.attempt_log.some(attempt => !Number.isSafeInteger(attempt.timestamp)
    || !Number.isSafeInteger(attempt.expiry_window) || attempt.expiry_window <= 0)) return false;
  const expiry = Math.max(...intent.attempt_log.map(attempt => attempt.timestamp + attempt.expiry_window));
  const threshold = expiry + 300_000;
  if (!(databaseTime > threshold) || first.evidence.requestId === second.evidence.requestId) return false;
  const lowerBound = intent.last_evidence.watermarkLowerBound ?? intent.position_epoch.strictBaseline?.evidence.lastOrderId;
  if (typeof lowerBound !== 'number' || !Number.isSafeInteger(lowerBound)) return false;
  for (const snapshot of [first, second]) {
    if (!validSnapshot(snapshot, intent.original_account, databaseTime) || snapshot.evidence.environment !== intent.environment
      || !(snapshot.evidence.dispatchedAt! > threshold)
      || typeof snapshot.evidence.lastOrderId !== 'number' || snapshot.evidence.lastOrderId < lowerBound
      || typeof snapshot.evidence.venueClockMs !== 'number' || snapshot.evidence.venueClockMs < expiry + 60_000) return false;
  }
  if (second.evidence.lastOrderId! < first.evidence.lastOrderId! || orders.lastOrderId < second.evidence.lastOrderId!) return false;
  const one = exactExposure(first, intent.market), two = exactExposure(second, intent.market);
  if (one === null || two === null || !new Decimal(one).eq(two)) return false;
  return orders.account === intent.original_account && orders.environment === intent.environment
    && orders.complete === true && orders.fresh === true && orders.noDedup === true
    && orders.dispatchedAt > threshold && orders.receivedAt >= orders.dispatchedAt
    && orders.receivedAt <= databaseTime && databaseTime - orders.receivedAt <= 10_000 && Number.isSafeInteger(orders.lastOrderId)
    && orders.lastOrderId >= lowerBound && !orders.orders.some(order => order.market === intent.market && order.orderType === 'market')
    && intent.last_evidence.contradiction !== true;
}

export interface CloseIdentity {
  owner_wallet: string;
  bot_id: string;
  source_key: string;
  signer_mode: NewCloseIntent['signer_mode'];
  authority_ref: Record<string, unknown>;
  baseSize: string | null;
  cachedBaseSize?: number;
  lastTradeId: string | null;
}

/** Caller holds the original identity; this path never asks a replacement bot to sign. */
export async function submitDurableClose(input: {
  adapter: ProtocolAdapter; params: MarketOrderParams; identity: CloseIdentity;
  trade: InsertBotTrade; kind: 'full' | 'partial'; positionSide: 'long' | 'short';
  parentScope?: CloseScope;
  validateIdentity?: () => Promise<boolean>;
}): Promise<{ intent: CloseIntent; created: boolean }> {
  await store.ready();
  const { adapter, params, identity } = input;
  if (!adapter.getCloseEnvironment || !adapter.prepareReduceOnlyMarketOrder || !adapter.sendPreparedReduceOnlyMarketOrder)
    throw new Error('durable_close_adapter_unavailable');
  const environment = adapter.getCloseEnvironment();
  const result = await store.withScope(environment, params.agentPublicKey, params.internalSymbol, async scope => {
    const unresolved = await store.unresolved(scope);
    if (unresolved) {
      assertCloseObjective(unresolved, input.kind, params.sizeBaseExact ?? String(params.sizeBase), identity.source_key);
      return { intent: unresolved, created: false };
    }
    if (await store.hasLegacyPending(scope)) throw new Error(CLOSE_IN_PROGRESS);
    if (input.validateIdentity && !await input.validateIdentity()) throw new Error('close_account_or_epoch_changed');
    const prepared = await adapter.prepareReduceOnlyMarketOrder!({ ...params, clientOrderId: randomUUID(), reduceOnly: true });
    let baseline: CloseSnapshot | undefined;
    try { baseline = await readIntentSnapshot(scope, adapter, params.agentPublicKey); } catch { /* bounded first full close below */ }
    const exposure = baseline ? exactExposure(baseline, params.internalSymbol) : null;
    if (baseline && (exposure === null || new Decimal(exposure).isZero()
      || new Decimal(exposure).isPositive() !== (input.positionSide === 'long')
      || (input.kind === 'full' ? !new Decimal(exposure).abs().eq(prepared.operationData.amount)
        : new Decimal(exposure).abs().lt(prepared.operationData.amount)))) throw new Error('close_target_changed_or_unknown');
    const fallback = !baseline;
    if (fallback && (input.kind !== 'full' || (identity.baseSize === null && identity.cachedBaseSize === undefined)
      || !new Decimal(identity.baseSize ?? identity.cachedBaseSize!).abs().eq(prepared.operationData.amount)
      || new Decimal(identity.baseSize ?? identity.cachedBaseSize!).isPositive() !== (input.positionSide === 'long')))
      throw new Error('close_target_changed_or_unknown');
    if (input.validateIdentity && !await input.validateIdentity()) throw new Error('close_account_or_epoch_changed');
    const created = await store.create(scope, {
      owner_wallet: identity.owner_wallet, bot_id: identity.bot_id, source_key: identity.source_key,
      signer_mode: identity.signer_mode, authority_ref: identity.authority_ref,
      environment, original_account: params.agentPublicKey, signer_public_key: params.agentPublicKey,
      market: params.internalSymbol, close_kind: input.kind, position_side: input.positionSide,
      original_position_size_base: fallback ? prepared.operationData.amount : exposure!.replace(/^-/, ''),
      requested_size_base: prepared.operationData.amount, client_order_id: prepared.operationData.client_order_id,
      request_payload: { ...prepared.operationData, account: params.agentPublicKey },
      position_epoch: { sizeSource: fallback ? 'db_cache_bounded_fallback' : 'strict', strict: !fallback,
        cacheBaseSizeText: fallback ? identity.baseSize : null, strictBaseline: baseline ?? null,
        baseSize: identity.baseSize ?? (identity.cachedBaseSize === undefined ? null : String(identity.cachedBaseSize)), lastTradeId: identity.lastTradeId },
    }, input.kind === 'partial' ? { ...input.trade, webhookPayload: {
      ...(input.trade.webhookPayload && typeof input.trade.webhookPayload === 'object' ? input.trade.webhookPayload : {}),
      partialClose: true, closeIntentPending: true,
      partialCloseAccounting: { status: 'pending_venue_authority', expectedBaseSize: identity.baseSize ?? String(identity.cachedBaseSize ?? ''),
        expectedLastTradeId: identity.lastTradeId, requestedClosedSize: Number(prepared.operationData.amount) },
    } } : input.trade);
    if (!created.created) {
      assertCloseObjective(created.intent, input.kind, prepared.operationData.amount, identity.source_key);
      return created;
    }
    let intent = created.intent;
    try {
    const now = await store.databaseTime(scope);
    const attempt = { attemptId: randomUUID(), timestamp: now, expiry_window: 5_000, admittedAt: now };
    // The commit returns before the signer can receive this attempt header.
    intent = await store.admit(scope, intent, attempt);
    await store.assertSendAuthorized(scope, intent);
    const outcome = await adapter.sendPreparedReduceOnlyMarketOrder!(prepared, attempt, params.agentSecretKey);
    intent = await store.outcome(scope, intent, attempt.attemptId, outcome);
    if (fallback && outcome.kind === 'not_entered') {
      intent = await store.settle(scope, intent, { status: 'released', release_mode: 'not_sent',
        completed_at: new Date(await store.databaseTime(scope)), last_error_code: 'close_not_sent' },
        client => accountDurableClose(client, intent, 'not_sent'));
      return { intent, created: true };
    }
    try {
      const after = await readIntentSnapshot(scope, adapter, intent.original_account);
      if (input.validateIdentity && !await input.validateIdentity()) {
        intent = await store.mutate(scope, intent, { status: 'needs_user',
          last_evidence: { ...intent.last_evidence, contradiction: true, objectiveMet: false },
          last_error_code: 'close_account_or_epoch_changed' });
      } else {
        intent = await persistCloseObservation(scope, intent, after);
        if (intent.last_evidence.objectiveMet === true) intent = await confirmDurableClose(scope, intent, adapter);
        else if (intent.authority_ref.subscriberAccounting === true) {
          const { readIntentFillEvidence } = await import('./signal-bot-close-intent-accounting');
          const evidence = await readIntentFillEvidence(scope, adapter, intent);
          intent = await store.mutate(scope, intent, { last_evidence: { ...intent.last_evidence, subscriberAccounting: evidence.accounting, closeResult: evidence.closeResult } });
        }
      }
    } catch { /* admitted unknown is deliberately durable */ }
    return { intent, created: true };
    } catch {
      // Once identity exists, an uncertain admission/outcome commit is never a new send.
      const persisted = await store.byId(scope, intent.id).catch(() => intent);
      if (!persisted) throw new Error('durable_close_identity_missing');
      return { intent: persisted, created: true };
    }
  }, false, input.parentScope);
  // A parent account scope is released by its caller; the worker handles its effects.
  if (result?.intent.status === 'confirmed' && !input.parentScope) {
    const { scheduleCloseEffects } = await import('./signal-bot-close-intent-effects');
    scheduleCloseEffects(result.intent);
  }
  return result!;
}

export async function persistCloseObservation(scope: CloseScope, intent: CloseIntent, snapshot: CloseSnapshot): Promise<CloseIntent> {
  const databaseTime = await store.databaseTime(scope);
  if (!validSnapshot(snapshot, intent.original_account, databaseTime) || snapshot.evidence.environment !== intent.environment)
    throw new Error('invalid_original_close_observation');
  const oldBound = intent.last_evidence.watermarkLowerBound ?? intent.position_epoch.strictBaseline?.evidence.lastOrderId;
  const bound = typeof oldBound === 'number' ? Math.max(oldBound, snapshot.evidence.lastOrderId ?? oldBound) : snapshot.evidence.lastOrderId;
  const now = databaseTime;
  const age = now - new Date(intent.created_at).getTime();
  const observed = Number(intent.last_evidence.observationCount ?? 0) + 1;
  const delay = intent.status === 'needs_user' || age >= 900_000 ? 300_000 : [5_000, 15_000, 30_000][Math.min(observed - 1, 2)] ?? 60_000;
  return store.mutate(scope, intent, {
    last_evidence: { ...intent.last_evidence, after: snapshot, watermarkLowerBound: bound,
      objectiveMet: closeObjectiveMet(intent, snapshot, databaseTime), observationCount: observed },
    last_observed_at: new Date(now), status: age >= 900_000 ? 'needs_user' : intent.status,
    next_action_at: new Date(Math.max(intent.dispatch_state === 'proven_not_landed' ? new Date(intent.next_action_at).getTime() : 0, now + (observed >= 4 && age < 900_000 ? 60_000 + Math.floor(Math.random() * 5_000) : delay))),
  });
}

/** Exact text matters: a coalesced request cannot borrow another objective. */
export function assertCloseObjective(intent: CloseIntent, kind: 'full' | 'partial', size: string, sourceKey?: string): void {
  if (intent.close_kind !== kind || intent.requested_size_base !== size || (kind === 'partial' && intent.source_key !== sourceKey)) throw new Error(CLOSE_IN_PROGRESS);
}

/** DB brackets are conservative dispatch bounds; app-clock offsets never authorize intent actions. */
export async function readIntentSnapshot(scope: CloseScope, adapter: ProtocolAdapter, account: string): Promise<CloseSnapshot> {
  if (!adapter.getCloseConfirmationSnapshot) throw new Error('close_confirmation_reader_unavailable');
  const start = await store.databaseTime(scope);
  const snapshot = await adapter.getCloseConfirmationSnapshot(account);
  const end = await store.databaseTime(scope);
  if (!validSnapshot(snapshot, account, snapshot.evidence.receivedAt) || end < start || end - start > 10_000)
    throw new Error('invalid_close_confirmation_evidence');
  return { ...snapshot, evidence: { ...snapshot.evidence, startedAt: start, dispatchedAt: start, receivedAt: end } };
}

export async function confirmDurableClose(scope: CloseScope, intent: CloseIntent, adapter: ProtocolAdapter,
  account = accountDurableClose): Promise<CloseIntent> {
  const { readIntentFillEvidence } = await import('./signal-bot-close-intent-accounting');
  const now = await store.databaseTime(scope);
  if (!closeObjectiveMet(intent, intent.last_evidence.after as CloseSnapshot, now)) throw new Error('close_confirmation_stale');
  const evidence = await readIntentFillEvidence(scope, adapter, intent);
  const fill = evidence.fill;
  const subscriberPartial = intent.close_kind === 'partial' && intent.authority_ref.subscriberAccounting === true;
  const settled = await store.settle(scope, intent, { status: 'confirmed', completed_at: new Date(await store.databaseTime(scope)),
    last_error_code: null, last_evidence: { ...intent.last_evidence, accountingPending: !fill || fill.realizedPnl === null, notificationPending: !subscriberPartial, ...(intent.close_kind === 'partial' ? { effectsPending: !subscriberPartial } : {}), fill, subscriberAccounting: evidence.accounting, closeResult: evidence.closeResult } },
    client => account(client, intent, 'confirmed', fill));
  return settled;
}
