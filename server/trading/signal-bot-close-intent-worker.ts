import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import type { ProtocolAdapter } from '../protocol/adapter';
import { readCloseSnapshot, validSnapshot } from '../protocol/close-outcome';
import { closeIntentStore as store } from './close-intent-store';
import { closeReleaseEvidence, exactExposure, persistCloseObservation, readIntentSnapshot, confirmDurableClose } from './signal-bot-close-intent';
import type { CloseIntent, CloseScope, PreparedReduceOnlyMarketOrder } from './signal-bot-close-intent-types';

export interface CloseWorkerDependencies {
  adapter(intent: CloseIntent): ProtocolAdapter;
  epochUnchanged(intent: CloseIntent): Promise<boolean>;
  signer(intent: CloseIntent): Promise<{ secretKey: Uint8Array; cleanup(): void } | null>;
  account(client: any, intent: CloseIntent, mode: 'confirmed' | 'flat' | 'still_open' | 'residual' | 'not_sent', fill?: import('./signal-bot-close-intent-accounting').IntentFill | null): Promise<void>;
}
let dependencies: CloseWorkerDependencies | undefined;
export function registerCloseWorkerDependencies(value: CloseWorkerDependencies): void { dependencies = value; }

export async function releaseUnsentClose(scope: CloseScope, intent: CloseIntent,
  account: CloseWorkerDependencies['account']): Promise<CloseIntent> {
  const neverSent = intent.attempt_count === 0 && intent.status === 'needs_user';
  const boundedUnsent = intent.attempt_count > 0 && intent.attempt_log.every(a => a.outcome?.kind === 'not_entered');
  if (!neverSent && !boundedUnsent) throw new Error('close_unsent_release_denied');
  return store.settle(scope, intent, { status: 'released', release_mode: 'not_sent',
    completed_at: new Date(await store.databaseTime(scope)), last_error_code: 'close_not_sent' },
    client => account(client, intent, 'not_sent'));
}

/** One public-original-account observation pass. No active-bot inventory is consulted. */
export async function observeCloseIntent(scope: CloseScope, initial: CloseIntent,
  deps: CloseWorkerDependencies): Promise<void> {
  let intent = initial;
  if (!['pending', 'needs_user'].includes(intent.status)) return;
  if ((intent.attempt_count === 0 && intent.status === 'needs_user')
    || (intent.position_epoch.sizeSource === 'db_cache_bounded_fallback' && intent.attempt_count === 1
      && intent.attempt_log[0]?.outcome?.kind === 'not_entered')) {
    await releaseUnsentClose(scope, intent, deps.account); return;
  }
  const adapter = deps.adapter(intent);
  if (adapter.protocolName !== 'pacifica' || adapter.getCloseEnvironment?.() !== intent.environment)
    throw new Error('original_close_environment_unavailable');
  const now = await store.databaseTime(scope);
  const epochUnchanged = await deps.epochUnchanged(intent);
  let after = await readIntentSnapshot(scope, adapter, intent.original_account);
  intent = await persistCloseObservation(scope, intent, after);
  if (!epochUnchanged) {
    intent = await store.mutate(scope, intent, { status: 'needs_user',
      last_evidence: { ...intent.last_evidence, contradiction: true, objectiveMet: false },
      last_error_code: 'close_account_or_epoch_changed' });
    return;
  }
  if (intent.last_evidence.objectiveMet === true) {
    try { await confirmDurableClose(scope, intent, adapter, deps.account); return; }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'partial_close_residual_unavailable'
        || now - new Date(intent.created_at).getTime() < 900_000) throw error;
      // Continue to S4's independent expiry/flat/residual proof; never replay this send.
      intent = await store.mutate(scope, intent, { status: 'needs_user', last_error_code: 'partial_close_residual_unavailable' });
    }
  }
  const prior = intent.attempt_log[intent.attempt_log.length - 1];
  const baseline = intent.position_epoch.strictBaseline;
  const watermark = baseline?.evidence.lastOrderId;
  const exposure = exactExposure(after, intent.market);
  const retryProof = intent.position_epoch.strict === true && typeof watermark === 'number'
    && validSnapshot(after, intent.original_account, await store.databaseTime(scope)) && after.evidence.environment === intent.environment
    && after.evidence.lastOrderId === watermark && exposure !== null
    && new Decimal(exposure).eq(new Decimal(intent.original_position_size_base).mul(intent.position_side === 'long' ? 1 : -1));
  const retryDue = !prior || (prior.receivedAt !== undefined
    && now >= prior.receivedAt + (intent.attempt_count === 1 ? 30_000 : 120_000));
  if (intent.status === 'pending' && intent.attempt_count < 3 && retryDue
    && (intent.attempt_count === 0 || (intent.dispatch_state === 'proven_not_landed'
      && prior?.outcome?.kind === 'not_entered' && after.evidence.dispatchedAt! >= prior.receivedAt!))) {
    if (!retryProof) {
      intent = await store.mutate(scope, intent, { status: 'needs_user', last_error_code: 'close_retry_generation_not_proven' });
    } else {
      const signing = await deps.signer(intent);
      if (signing && await deps.epochUnchanged(intent)) {
        try {
          const admittedAt = await store.databaseTime(scope);
          const attempt = { attemptId: randomUUID(), timestamp: admittedAt, expiry_window: 5_000, admittedAt,
            ...(prior ? { priorProof: { attemptId: prior.attemptId, committedAt: prior.receivedAt!, watermark } } : {}) };
          const prepared: PreparedReduceOnlyMarketOrder = { account: intent.original_account,
            environment: intent.environment, market: intent.market, operationData: (({ account: _account, ...operation }) => operation)(intent.request_payload) };
          intent = await store.admit(scope, intent, attempt);
          await store.assertSendAuthorized(scope, intent);
          const outcome = await adapter.sendPreparedReduceOnlyMarketOrder!(prepared, attempt, signing.secretKey);
          intent = await store.outcome(scope, intent, attempt.attemptId, outcome);
        } finally { signing.cleanup(); }
        return;
      }
      signing?.cleanup();
      intent = await store.mutate(scope, intent, { status: 'needs_user', last_error_code: 'original_close_signer_unavailable' });
    }
  }
  if (intent.attempt_count === 0) return;
  const maxExpiry = Math.max(...intent.attempt_log.map(attempt => attempt.timestamp + attempt.expiry_window));
  if (!(await store.databaseTime(scope) > maxExpiry + 300_000) || !adapter.getCloseOpenOrders) return;
  // These independent reads are dispatched only after the DB expiry barrier.
  const first = await readIntentSnapshot(scope, adapter, intent.original_account);
  const second = await readIntentSnapshot(scope, adapter, intent.original_account);
  const ordersStart = await store.databaseTime(scope);
  const rawOrders = await adapter.getCloseOpenOrders(intent.original_account);
  const ordersEnd = await store.databaseTime(scope);
  if (ordersEnd < ordersStart || ordersEnd - ordersStart > 10_000) return;
  const orders = { ...rawOrders, dispatchedAt: ordersStart, receivedAt: ordersEnd };
  if (!await deps.epochUnchanged(intent)
    || !closeReleaseEvidence(intent, await store.databaseTime(scope), first, second, orders)) return;
  const size = new Decimal(exactExposure(second, intent.market)!);
  const original = new Decimal(intent.original_position_size_base).mul(intent.position_side === 'long' ? 1 : -1);
  const allUnsent = intent.attempt_log.every(a => a.outcome?.kind === 'not_entered');
  const mode = allUnsent && size.eq(original) ? 'not_sent' : size.isZero() ? 'flat' : size.eq(original) ? 'still_open' : 'residual';
  await store.settle(scope, intent, { status: 'released', release_mode: mode,
    completed_at: new Date(await store.databaseTime(scope)),
    last_error_code: mode === 'flat' ? null : mode === 'not_sent' ? 'close_not_sent' : mode === 'still_open' ? 'close_expired_unconfirmed' : 'close_residual_attention',
    last_evidence: { ...intent.last_evidence, release: { first, second, orders } } },
    client => deps.account(client, intent, mode));
}

let running = false;
export async function runCloseIntentWorkerPass(): Promise<void> {
  if (running || !dependencies) return;
  running = true;
  try {
    await store.ready();
    for (const row of [...await store.due(), ...await store.dueAccounting()]) {
      try { const observed = await store.withScope(row.environment, row.original_account, row.market, async scope => {
        let current = await store.byId(scope, row.id);
        if (!current) return;
        try {
          if (current.status === 'confirmed' && (current.last_evidence.accountingPending === true || current.last_evidence.notificationPending === true || current.last_evidence.effectsPending === true)) {
            const { repairIntentAccounting } = await import('./signal-bot-close-intent-accounting');
            if (current.last_evidence.accountingPending === true) await repairIntentAccounting(scope, current, dependencies!.adapter(current));
            return await store.byId(scope, row.id);
          }
          if (!['pending', 'needs_user'].includes(current.status)) return;
          await observeCloseIntent(scope, current, dependencies!);
          return await store.byId(scope, row.id);
        }
        catch {
          current = await store.byId(scope, row.id);
          if (current?.status === 'confirmed') await store.recordRepairFailure(scope, current);
          else if (current && ['pending', 'needs_user'].includes(current.status)) {
            const now = await store.databaseTime(scope);
            await store.mutate(scope, current, { next_action_at: new Date(now + 300_000),
              status: now - new Date(current.created_at).getTime() >= 900_000 ? 'needs_user' : current.status,
              last_error_code: 'close_observation_unavailable' });
          }
        }
      }, true);
      if (observed?.status === 'confirmed') {
        const { dispatchConfirmedCloseEffects } = await import('./signal-bot-close-intent-effects');
        await dispatchConfirmedCloseEffects(observed);
      }
      } catch { /* Scope acquisition/teardown failures cannot starve later accounts. */ }
    }
  } finally { running = false; }
}
let timer: ReturnType<typeof setInterval> | undefined;
export function startCloseIntentWorker(): void {
  if (timer) return;
  timer = setInterval(() => { void runCloseIntentWorkerPass().catch(() => {}); }, 5_000);
  timer.unref();
  void runCloseIntentWorkerPass().catch(() => {});
}
export function stopCloseIntentWorker(): void { if (timer) clearInterval(timer); timer = undefined; }
