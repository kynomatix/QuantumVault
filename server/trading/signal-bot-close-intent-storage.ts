import type { Pool, PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { botTrades, type InsertBotTrade } from '@shared/schema';
import { SIGNAL_BOT_CLOSE_INTENT_LOCK_NAMESPACE as NS } from '../wallet-lock-constants';
import type { CloseIntent, CloseScope, NewCloseIntent, CloseAttempt, CloseSendOutcome } from './signal-bot-close-intent-types';
import { closeIntentMessage, CLOSE_SAVE_FAILED } from './signal-bot-close-intent-types';
import { requireSchemaCapabilityReady } from '../schema-readiness';

const clients = new WeakMap<object, PoolClient>();
const unresolved = "status IN ('pending','needs_user')";
const scopeKey = (environment: string, account: string, market: string) => `${environment}:${account}:${market}`;

/** This module owns every intent write, including the revision increment. */
export class SignalBotCloseIntentStorage {
  constructor(private readonly pool: Pool) {}

  async ready(): Promise<void> {
    await requireSchemaCapabilityReady('signal_bot_close_intent', async (text, values) => {
      const result = await this.pool.query(text, values as any[]);
      return result;
    });
  }

  /** Missing rollout table cannot contain an unresolved intent. Other readiness failures stay fenced. */
  private async capabilityAbsent(): Promise<boolean> {
    const result = await this.pool.query("SELECT to_regclass(current_schema()||'.signal_bot_close_intents') IS NOT NULL AS present");
    return result.rows[0]?.present === false;
  }

  async withScope<T>(environment: string, account: string, market: string,
    work: (scope: CloseScope) => Promise<T>, tryOnly = false, parent?: CloseScope): Promise<T | undefined> {
    if (parent && (parent.environment !== environment || parent.account !== account || parent.market !== '*'))
      throw new Error('close_parent_scope_mismatch');
    const client = parent ? this.client(parent) : await this.pool.connect();
    const accountKey = scopeKey(environment, account, '*');
    const key = scopeKey(environment, account, market);
    let accountHeld = false, held = false;
    const token = {};
    try {
      await client.query("SET lock_timeout = '5s'");
      if (!parent) {
        const shared = await client.query(`SELECT ${tryOnly ? 'pg_try_advisory_lock_shared' : 'pg_advisory_lock_shared'}($1,hashtext($2)) AS held`, [NS, accountKey]);
        accountHeld = !tryOnly || shared.rows[0]?.held === true;
        if (!accountHeld) return undefined;
      }
      const lock = await client.query(`SELECT ${tryOnly ? 'pg_try_advisory_lock' : 'pg_advisory_lock'}($1,hashtext($2)) AS held`, [NS, key]);
      held = !tryOnly || lock.rows[0]?.held === true;
      if (!held) return undefined;
      clients.set(token, client);
      return await work({ environment, account, market, token });
    } finally {
      clients.delete(token);
      if (held) await client.query('SELECT pg_advisory_unlock($1,hashtext($2))', [NS, key]).catch(() => {});
      if (accountHeld) await client.query('SELECT pg_advisory_unlock_shared($1,hashtext($2))', [NS, accountKey]).catch(() => {});
      if (!parent) await client.query('RESET lock_timeout').catch(() => {});
      if (!parent) client.release();
    }
  }

  /** Serialize one execution's external effects without locking its trading scope. */
  async withEffects<T>(intentId: string, work: () => Promise<T>): Promise<T | undefined> {
    const client = await this.pool.connect();
    const key = `close-effects:${intentId}`;
    let held = false;
    try {
      held = (await client.query('SELECT pg_try_advisory_lock($1,hashtext($2)) AS held', [NS,key])).rows[0]?.held === true;
      if (held) return await work();
    } finally {
      if (held) await client.query('SELECT pg_advisory_unlock($1,hashtext($2))', [NS,key]).catch(() => {});
      client.release();
    }
  }

  async withAccount<T>(environment: string, account: string, work: (scope: CloseScope) => Promise<T>): Promise<T> {
    try { await this.ready(); } catch (error) {
      if (await this.capabilityAbsent()) return work({ environment, account, market: '*', token: {} });
      throw error;
    }
    const client = await this.pool.connect();
    const key = scopeKey(environment, account, '*');
    const token = {};
    let held = false;
    try {
      await client.query("SET lock_timeout = '5s'");
      await client.query('SELECT pg_advisory_lock($1,hashtext($2))', [NS, key]);
      held = true;
      const blocked = await client.query(`SELECT id FROM signal_bot_close_intents WHERE environment=$1 AND original_account=$2 AND ${unresolved} LIMIT 1`, [environment, account]);
      if (blocked.rowCount) throw new Error('prior_close_confirmation_pending');
      clients.set(token, client);
      return await work({ environment, account, market: '*', token });
    } finally {
      clients.delete(token);
      if (held) await client.query('SELECT pg_advisory_unlock($1,hashtext($2))', [NS, key]).catch(() => {});
      await client.query('RESET lock_timeout').catch(() => {});
      client.release();
    }
  }

  async withOpenFence<T>(environment: string, account: string, market: string, send: () => Promise<T>): Promise<T> {
    try { await this.ready(); } catch (error) { if (await this.capabilityAbsent()) return send(); throw error; }
    const result = await this.withScope(environment, account, market, async scope => {
      if (await this.unresolved(scope) || await this.hasLegacyPending(scope)) throw new Error('prior_close_confirmation_pending');
      return send();
    });
    return result as T;
  }

  async withLifecycle<T>(account: string | null | undefined, work: () => Promise<T>): Promise<T> {
    if (!account) return work();
    const { getAdapter } = await import('../protocol/adapter-registry');
    const environment = getAdapter('pacifica').getCloseEnvironment!();
    return this.withAccount(environment, account, () => work());
  }

  async withOwnerLifecycle<T>(owner: string, agent: string | null | undefined, work: () => Promise<T>, destinations: readonly (string | null | undefined)[] = []): Promise<T> {
    try { await this.ready(); } catch (error) { if (await this.capabilityAbsent()) return work(); throw error; }
    const { getAdapter } = await import('../protocol/adapter-registry');
    const environment = getAdapter('pacifica').getCloseEnvironment!();
    const client = await this.pool.connect();
    const held: string[] = [];
    try {
      await client.query("SET lock_timeout = '5s'");
      const bots = await client.query("SELECT protocol_subaccount_id FROM trading_bots WHERE wallet_address=$1 AND active_protocol='pacifica'", [owner]);
      const accounts = [...new Set([agent, ...destinations, ...bots.rows.map(row => row.protocol_subaccount_id)].filter(Boolean))].sort() as string[];
      for (const account of accounts) {
        const key = scopeKey(environment, account, '*');
        await client.query('SELECT pg_advisory_lock($1,hashtext($2))', [NS, key]);
        held.push(key);
      }
      const current = await client.query('SELECT agent_public_key FROM wallets WHERE address=$1', [owner]);
      if ((current.rows[0]?.agent_public_key ?? null) !== (agent ?? null)) throw new Error('close_account_generation_changed');
      const again = await client.query("SELECT protocol_subaccount_id FROM trading_bots WHERE wallet_address=$1 AND active_protocol='pacifica'", [owner]);
      if (JSON.stringify(again.rows.map(row => row.protocol_subaccount_id).sort()) !== JSON.stringify(bots.rows.map(row => row.protocol_subaccount_id).sort())) throw new Error('close_account_generation_changed');
      const blocked = await client.query(`SELECT id FROM signal_bot_close_intents WHERE (owner_wallet=$1 OR (environment=$2 AND original_account=ANY($3::text[]))) AND ${unresolved} LIMIT 1`, [owner, environment, accounts]);
      if (blocked.rowCount) throw new Error('prior_close_confirmation_pending');
      return await work();
    } finally {
      for (const key of held.reverse()) await client.query('SELECT pg_advisory_unlock($1,hashtext($2))', [NS, key]).catch(() => {});
      await client.query('RESET lock_timeout').catch(() => {});
      client.release();
    }
  }

  async withBotLifecycle<T>(botId: string, destinations: readonly (string | null | undefined)[], work: () => Promise<T>): Promise<T> {
    const identity = async () => (await this.pool.query("SELECT b.wallet_address,b.active_protocol,b.protocol_subaccount_id,w.agent_public_key FROM trading_bots b LEFT JOIN wallets w ON w.address=b.wallet_address WHERE b.id=$1", [botId])).rows[0];
    const original = await identity();
    const account = original?.active_protocol === 'pacifica' ? original.protocol_subaccount_id ?? original.agent_public_key : undefined;
    return this.withLifecycleAccounts([account, ...destinations], async () => {
      const current = await identity();
      if (JSON.stringify(current) !== JSON.stringify(original)) throw new Error('close_account_generation_changed');
      return work();
    });
  }

  async withLifecycleAccounts<T>(accounts: readonly (string | null | undefined)[], work: () => Promise<T>): Promise<T> {
    const unique = [...new Set(accounts.filter(Boolean))].sort() as string[];
    const next = (index: number): Promise<T> => index === unique.length ? work()
      : this.withLifecycle(unique[index], () => next(index + 1));
    return next(0);
  }

  /** Public status is persistent and includes the pre-rollout observation-only queue. */
  async statusForBot(owner: string, botId: string): Promise<{ message: string; unresolved: boolean; tradeId?: string } | null> {
    try { await this.ready(); } catch { return { message: CLOSE_SAVE_FAILED, unresolved: false }; }
    const rows = await this.pool.query(`SELECT * FROM signal_bot_close_intents WHERE owner_wallet=$1 AND bot_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`, [owner, botId]);
    const latest = rows.rows[0] as CloseIntent | undefined;
    const pendingLegacy = await this.pool.query("SELECT t.id,(t.executed_at > clock_timestamp()-interval '15 minutes') AS blocking FROM bot_trades t JOIN trading_bots b ON b.id=t.trading_bot_id WHERE b.id=$1 AND b.wallet_address=$2 AND b.active_protocol='pacifica' AND upper(t.side)='CLOSE' AND t.status='pending' AND NOT EXISTS (SELECT 1 FROM signal_bot_close_intents i WHERE i.original_trade_id=t.id) ORDER BY t.executed_at DESC LIMIT 1", [botId,owner]);
    if (pendingLegacy.rows[0]?.blocking) return { message: 'Close needs your attention. The position may still be open.', unresolved: true, tradeId: pendingLegacy.rows[0].id };
    if (latest && ['pending','needs_user'].includes(latest.status)) return { message: closeIntentMessage(latest), unresolved: true, tradeId: latest.original_trade_id };
    if (pendingLegacy.rows[0]) return { message: 'An earlier close could not be confirmed. Check the position.', unresolved: false, tradeId: pendingLegacy.rows[0].id };
    if (!latest || !['pending','needs_user'].includes(latest.status)) {
      const attention = await this.pool.query("SELECT * FROM signal_bot_close_intents r WHERE owner_wallet=$1 AND bot_id=$2 AND release_mode='residual' AND NOT EXISTS (SELECT 1 FROM signal_bot_close_intents c WHERE c.environment=r.environment AND c.original_account=r.original_account AND c.market=r.market AND c.status='confirmed' AND c.created_at>r.created_at) ORDER BY created_at DESC LIMIT 1", [owner, botId]);
      if (attention.rows[0]) return { message: closeIntentMessage(attention.rows[0]), unresolved: false, tradeId: attention.rows[0].original_trade_id };
    }

    if (latest?.last_evidence.fanoutAttention === true) return { message: 'Copy-trade update could not be delivered to some followers', unresolved: false, tradeId: latest.original_trade_id };
    if (latest?.last_evidence.notificationAttention === true) return { message: 'Close confirmed. Notification delivery needs your attention.', unresolved: false, tradeId: latest.original_trade_id };
    if (latest?.last_evidence.parkingAttention === true) return { message: 'Close confirmed. Fund parking needs your attention.', unresolved: false, tradeId: latest.original_trade_id };
    if (latest?.last_evidence.repairAttention === true) return { message: 'Close confirmed. Accounting needs your attention.', unresolved: false, tradeId: latest.original_trade_id };
    if (latest) return { message: closeIntentMessage(latest), unresolved: ['pending','needs_user'].includes(latest.status), tradeId: latest.original_trade_id };
    const legacy = await this.legacyInventory(owner, botId);
    return legacy.length ? { message: 'Close needs your attention. The position may still be open.', unresolved: false, tradeId: legacy[0].original_trade_id } : null;
  }

  async hasUnresolvedPosition(botId: string, market: string): Promise<boolean> {
    const present = await this.pool.query("SELECT to_regclass(current_schema()||'.signal_bot_close_intents') IS NOT NULL AS present");
    if (!present.rows[0]?.present) return false;
    return !!(await this.pool.query(`SELECT id FROM signal_bot_close_intents WHERE bot_id=$1 AND market=$2 AND ${unresolved} LIMIT 1`, [botId, market])).rowCount;
  }

  async hasUnresolvedTrade(tradeId: string): Promise<boolean> {
    const present = await this.pool.query("SELECT to_regclass(current_schema()||'.signal_bot_close_intents') IS NOT NULL AS present");
    if (!present.rows[0]?.present) return false;
    return !!(await this.pool.query(`SELECT id FROM signal_bot_close_intents WHERE original_trade_id=$1 AND ${unresolved} LIMIT 1`, [tradeId])).rowCount;
  }

  async historyStatuses(owner: string, botId: string): Promise<Map<string, string>> {
    try { await this.ready(); } catch { return new Map(); }
    const rows = await this.pool.query('SELECT * FROM signal_bot_close_intents WHERE owner_wallet=$1 AND bot_id=$2 ORDER BY created_at', [owner, botId]);
    const statuses = new Map<string, string>(rows.rows.map((row: CloseIntent) => {
      const resolvedResidual = row.release_mode === 'residual' && rows.rows.some((later: CloseIntent) => later.status === 'confirmed'
        && later.environment === row.environment && later.original_account === row.original_account && later.market === row.market
        && new Date(later.created_at).getTime() > new Date(row.created_at).getTime());
      return [row.original_trade_id, resolvedResidual ? 'Position closed.' : closeIntentMessage(row)];
    }));
    for (const row of await this.legacyInventory(owner, botId)) if (!statuses.has(row.original_trade_id))
      statuses.set(row.original_trade_id, 'Close needs your attention. The position may still be open.');
    return statuses;
  }

  async legacyInventory(owner?: string, botId?: string): Promise<Array<{ id: string; original_trade_id: string; bot_id: string; protocol: string | null; protocol_subaccount_id: string | null }>> {
    return (await this.pool.query(`SELECT q.id,q.original_trade_id,q.bot_id,q.protocol,q.protocol_subaccount_id FROM trade_retry_queue q LEFT JOIN trading_bots b ON b.id=q.bot_id WHERE lower(q.side)='close' AND q.status IN ('pending','processing','cooldown') AND (q.protocol IS NULL OR q.protocol NOT IN ('phoenix','flash','drift') OR b.id IS NULL OR q.protocol_subaccount_id IS NULL OR b.active_protocol='pacifica') AND ($1::text IS NULL OR q.wallet_address=$1) AND ($2::text IS NULL OR q.bot_id=$2) ORDER BY q.created_at,q.id`, [owner ?? null, botId ?? null])).rows;
  }

  private client(scope: CloseScope): PoolClient {
    const client = clients.get(scope.token);
    if (!client) throw new Error('close_scope_not_held');
    return client;
  }

  async transaction<T>(scope: CloseScope, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = this.client(scope);
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock($1,hashtext($2))', [NS, scopeKey(scope.environment, scope.account, scope.market)]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  }

  async unresolved(scope: CloseScope): Promise<CloseIntent | undefined> {
    return (await this.client(scope).query(`SELECT * FROM signal_bot_close_intents WHERE environment=$1 AND original_account=$2 AND market=$3 AND ${unresolved} LIMIT 1`, [scope.environment, scope.account, scope.market])).rows[0];
  }

  async hasLegacyPending(scope: CloseScope): Promise<boolean> {
    const result = await this.client(scope).query(`SELECT t.id FROM bot_trades t JOIN trading_bots b ON b.id=t.trading_bot_id LEFT JOIN wallets w ON w.address=b.wallet_address WHERE upper(t.side)='CLOSE' AND t.status='pending' AND t.executed_at > clock_timestamp()-interval '15 minutes' AND t.market=$1 AND b.active_protocol='pacifica' AND COALESCE(b.protocol_subaccount_id,w.agent_public_key)=$2 AND NOT EXISTS (SELECT 1 FROM signal_bot_close_intents i WHERE i.original_trade_id=t.id) LIMIT 1`, [scope.market, scope.account]);
    return !!result.rowCount;
  }

  /** Worker is serial: one scope connection, at most one additional awaited pool query. */
  async dueAccounting(): Promise<CloseIntent[]> {
    return (await this.pool.query("SELECT * FROM signal_bot_close_intents WHERE status='confirmed' AND (last_evidence->>'accountingPending'='true' OR last_evidence->>'notificationPending'='true' OR last_evidence->>'effectsPending'='true') AND next_action_at<=clock_timestamp() ORDER BY next_action_at,id LIMIT 10")).rows;
  }

  /** Terminal evidence changes use the same scope lock and revision fence as confirmation. */
  async updateConfirmedEvidence(scope: CloseScope, current: CloseIntent, evidence: Record<string, unknown>, delayMs = 0): Promise<CloseIntent> {
    const result = await this.client(scope).query("UPDATE signal_bot_close_intents SET last_evidence=last_evidence||$3::jsonb,next_action_at=clock_timestamp()+($4::double precision*interval '1 millisecond'),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 AND revision=$2 AND status='confirmed' RETURNING *", [current.id,current.revision,JSON.stringify(evidence),delayMs]);
    if (!result.rows[0]) throw new Error('close_terminal_revision_changed');
    return result.rows[0];
  }

  /** Eight observations, exponential 30 s backoff capped at 30 min, then owner attention. */
  async recordRepairFailure(scope: CloseScope, current: CloseIntent): Promise<void> {
    const attempts = Number(current.last_evidence.repairAttempts ?? 0) + 1;
    const exhausted = attempts >= 8;
    await this.updateConfirmedEvidence(scope, current, { repairAttempts: attempts, repairAttention: exhausted && current.last_evidence.accountingPending === true,
      ...(exhausted ? { fanoutAttention: current.last_evidence.effectsPending === true && current.last_evidence.fanoutDelivered !== true,
        parkingAttention: current.last_evidence.effectsPending === true && current.last_evidence.parkingDelivered !== true } : {}),
      ...(exhausted ? { accountingPending: false, notificationPending: false, effectsPending: false } : {}) },
      Math.min(30_000 * 2 ** (attempts - 1), 1_800_000));
  }

  async recordAccountingRepair(scope: CloseScope, current: CloseIntent, pending: boolean, fill?: import('./signal-bot-close-intent-accounting').IntentFill | null): Promise<void> {
    const updated = await this.updateConfirmedEvidence(scope, current, { accountingPending: pending, fill: fill ?? null });
    if (pending) await this.recordRepairFailure(scope, updated);
  }

  /** A legacy consumer may observe a durable trade, but cannot write its money or payload. */
  async guardLinkedSubscriberRepair<T>(tradeId: string, canonical: (client: PoolClient) => Promise<T>, legacy: () => Promise<T>): Promise<T> {
    const present = await this.pool.query("SELECT to_regclass(current_schema()||'.signal_bot_close_intents') IS NOT NULL AS present");
    if (!present.rows[0]?.present) return legacy();
    const linked = (await this.pool.query('SELECT * FROM signal_bot_close_intents WHERE original_trade_id=$1', [tradeId])).rows[0] as CloseIntent | undefined;
    if (!linked) return legacy();
    return await this.withScope(linked.environment, linked.original_account, linked.market, scope =>
      this.transaction(scope, canonical)) as T;
  }

  async recordNotificationDelivered(scope: CloseScope, current: CloseIntent): Promise<void> {
    await this.client(scope).query("UPDATE signal_bot_close_intents SET last_evidence=last_evidence||jsonb_build_object('notificationPending',false,'notificationAttention',false),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 AND revision=$2 AND status='confirmed'", [current.id,current.revision]);
  }

  async byId(scope: CloseScope, id: string): Promise<CloseIntent | undefined> {
    return (await this.client(scope).query('SELECT * FROM signal_bot_close_intents WHERE id=$1 AND environment=$2 AND original_account=$3 AND market=$4', [id, scope.environment, scope.account, scope.market])).rows[0];
  }

  async create(scope: CloseScope, input: NewCloseIntent, trade: InsertBotTrade): Promise<{ intent: CloseIntent; created: boolean }> {
    if (input.environment !== scope.environment || input.original_account !== scope.account || input.market !== scope.market)
      throw new Error('close_scope_mismatch');
    const prior = await this.unresolved(scope);
    if (prior) return { intent: prior, created: false };
    try {
      return await this.transaction(scope, async client => {
        const old = await client.query('SELECT * FROM signal_bot_close_intents WHERE owner_wallet=$1 AND bot_id=$2 AND source_key=$3', [input.owner_wallet, input.bot_id, input.source_key]);
        if (old.rows[0]) return { intent: old.rows[0] as CloseIntent, created: false };
        const [pending] = await drizzle(client).insert(botTrades).values({ ...trade, protocol: 'pacifica', side: input.close_kind === 'partial' ? (input.position_side === 'long' ? 'short' : 'long') : 'CLOSE', status: 'pending', fee: null, pnl: null }).returning();
        const values: Record<string, unknown> = { ...input, original_trade_id: pending.id };
        const names = Object.keys(values);
        const result = await client.query(`INSERT INTO signal_bot_close_intents (${names.join(',')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT DO NOTHING RETURNING *`, names.map(name => values[name]));
        if (!result.rows[0]) throw new Error('close_intent_insert_conflict');
        return { intent: result.rows[0] as CloseIntent, created: true };
      });
    } catch (error) {
      // The failed transaction rolls the pending row back before re-reading.
      const existing = await this.unresolved(scope) ?? (await this.client(scope).query('SELECT * FROM signal_bot_close_intents WHERE owner_wallet=$1 AND bot_id=$2 AND source_key=$3', [input.owner_wallet, input.bot_id, input.source_key])).rows[0];
      if (existing) return { intent: existing, created: false };
      throw error;
    }
  }

  async databaseTime(scope: CloseScope): Promise<number> {
    return Math.floor(Number((await this.client(scope).query('SELECT extract(epoch FROM clock_timestamp())*1000 AS now')).rows[0].now));
  }

  private async update(client: PoolClient, current: CloseIntent, fields: Record<string, unknown>): Promise<CloseIntent> {
    const allowed = new Set(['status','dispatch_state','attempt_count','attempt_log','last_evidence','last_observed_at','next_action_at','last_error_code','completed_at','release_mode']);
    if (Object.keys(fields).some(name => !allowed.has(name))) throw new Error('immutable_close_intent_field');
    const names = Object.keys(fields);
    const result = await client.query(`UPDATE signal_bot_close_intents SET ${names.map((name, i) => `${name}=$${i + 3}`).join(',')},revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 AND revision=$2 AND ${unresolved} RETURNING *`, [current.id, current.revision, ...names.map(name => ['attempt_log', 'last_evidence'].includes(name) ? JSON.stringify(fields[name]) : fields[name])]);
    if (!result.rows[0]) throw new Error('close_intent_revision_conflict');
    return result.rows[0];
  }

  async mutate(scope: CloseScope, current: CloseIntent, fields: Record<string, unknown>): Promise<CloseIntent> {
    return this.transaction(scope, client => this.update(client, current, fields));
  }

  async assertSendAuthorized(scope: CloseScope, current: CloseIntent): Promise<void> {
    const client = this.client(scope);
    const result = await client.query(`SELECT i.id FROM signal_bot_close_intents i
      WHERE i.id=$1 AND i.revision=$2 AND i.status='pending' AND i.dispatch_state='admitted_unknown'
      AND EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
        AND classid=$3::oid AND objid=(hashtext($4)::bigint & 4294967295)::oid
        AND objsubid=2 AND mode='ExclusiveLock' AND granted)`,
    [current.id, current.revision, NS, scopeKey(scope.environment, scope.account, scope.market)]);
    if (!result.rowCount) throw new Error('close_send_authority_lost');
  }

  async admit(scope: CloseScope, current: CloseIntent, attempt: CloseAttempt): Promise<CloseIntent> {
    if (current.status !== 'pending' || current.attempt_count >= 3 ||
      (current.attempt_count > 0 && current.dispatch_state !== 'proven_not_landed')) throw new Error('close_send_not_authorized');
    const prior = current.attempt_log[current.attempt_log.length - 1];
    if (!Number.isSafeInteger(attempt.timestamp) || attempt.timestamp !== attempt.admittedAt || attempt.expiry_window !== 5_000) throw new Error('close_header_invalid');
    if (current.attempt_count > 0 && (prior?.outcome?.kind !== 'not_entered'
      || attempt.priorProof?.attemptId !== prior.attemptId || attempt.priorProof.committedAt !== prior.receivedAt
      || attempt.priorProof.watermark !== current.position_epoch.strictBaseline?.evidence.lastOrderId))
      throw new Error('close_retry_proof_missing');
    return this.mutate(scope, current, { dispatch_state: 'admitted_unknown', attempt_count: current.attempt_count + 1,
      attempt_log: [...current.attempt_log, attempt], next_action_at: new Date(attempt.admittedAt + 5_000) });
  }

  async outcome(scope: CloseScope, current: CloseIntent, attemptId: string, outcome: CloseSendOutcome): Promise<CloseIntent> {
    const now = await this.databaseTime(scope);
    const attempts = current.attempt_log.map(attempt => attempt.attemptId === attemptId ? { ...attempt, outcome, receivedAt: now } : attempt);
    if (attempts[attempts.length - 1]?.attemptId !== attemptId) throw new Error('close_attempt_changed');
    return this.mutate(scope, current, { attempt_log: attempts,
      dispatch_state: outcome.kind === 'not_entered' ? 'proven_not_landed' : 'admitted_unknown',
      last_error_code: outcome.cause ?? null, next_action_at: new Date(now + (outcome.kind === 'not_entered' ? (current.attempt_count === 1 ? 30_000 : 120_000) : 5_000)) });
  }

  async settle(scope: CloseScope, current: CloseIntent, fields: Record<string, unknown>,
    accounting: (client: PoolClient) => Promise<void>): Promise<CloseIntent> {
    return this.transaction(scope, async client => {
      const next = await this.update(client, current, fields);
      await accounting(client);
      return next;
    });
  }

  async due(limit = 50): Promise<CloseIntent[]> {
    return (await this.pool.query(`SELECT * FROM signal_bot_close_intents WHERE ${unresolved} AND next_action_at<=clock_timestamp() ORDER BY next_action_at,id LIMIT $1`, [limit])).rows;
  }

  async completeLinked<T>(tradeId: string, work: (client?: PoolClient) => Promise<T>): Promise<T> {
    const present = await this.pool.query("SELECT to_regclass(current_schema()||'.signal_bot_close_intents') IS NOT NULL AS present");
    if (!present.rows[0]?.present) return work();
    const found = await this.pool.query('SELECT * FROM signal_bot_close_intents WHERE original_trade_id=$1', [tradeId]);
    const linked: CloseIntent | undefined = found.rows[0];
    if (!linked) return work();
    const result = await this.withScope(linked.environment, linked.original_account, linked.market, async scope => {
      const current = (await this.byId(scope, linked.id))!;
      if (current.status === 'released') throw new Error('released_close_cannot_confirm');
      if (current.status !== 'confirmed') {
        // Legacy finalizers do not promote durable intents or attach payloads.
        // Only confirmDurableClose can settle exposure, money and effects together.
        const [trade] = await drizzle(this.client(scope)).select().from(botTrades).where(eq(botTrades.id, current.original_trade_id));
        return { trade, isNew: false } as T;
      }
      return this.transaction(scope, async client => {
        const result = await work(client);
        const canonical = result as { trade?: { id?: string; status?: string }; isNew?: boolean };
        if (!canonical.trade || canonical.trade.id !== current.original_trade_id || !(current.close_kind === 'partial' ? ['executed','recovered','pending'] : ['executed','recovered']).includes(String(canonical.trade.status))) throw new Error('close_atomic_accounting_not_applied');
        return result;
      });
    });
    return result as T;
  }
}
