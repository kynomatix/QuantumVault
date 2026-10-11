import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { PhoenixTraderIdentity } from '../../../shared/phoenix-read-contract';
import { phoenixIdentityFromBot, type PhoenixBotIdentityColumns } from './identity';
import { PHOENIX_PUBLIC_ADDRESSES } from './sdk-boundary';
import { validateFundingIntent, validateFundingReceipt, type FundingTerms, type FundingHistory, type FundingReceipt } from './funding-contract';
import { planProtection, type ProtectionTerms, type ProtectionProgress, type ProtectionRequest } from './protection-contract';

export type PhoenixOperationKind = 'register' | 'deposit' | 'withdraw' | 'transfer' | 'protection';
export type PhoenixOperationState = 'prepared' | 'submission_pending' | 'queued' | 'unknown' | 'completed' | 'failed' | 'dropped';
export interface PhoenixIntent {
  botId: string;
  ownerWallet: string;
  requestKey: string;
  kind: PhoenixOperationKind;
  identity: PhoenixTraderIdentity;
  mint: string;
  amountBaseUnits: string;
  feeBaseUnits: string;
  destination: string;
  registration?: { maxPositions: number; maxCostLamports: string; name: string; market: string };
  funding?: FundingTerms;
  /** U05 funding child; bound to a durably claimed entry, never an independent park/withdraw. */
  executionOrderId?: string;
  protection?: ProtectionTerms;
}
export interface StoredPhoenixOperation {
  id: string; bot_id: string; request_key: string; kind: PhoenixOperationKind;
  intent: PhoenixIntent; intent_hash: string; state: PhoenixOperationState; revision: number;
  observation: Record<string, unknown> | null;
  created_at: Date;
}
export interface PhoenixAttemptInput {
  signature: string; blockhash: string; lastValidBlockHeight: string; transactionHash: string;
}

export class PhoenixProtectionPendingError extends Error {
  constructor() { super('Earlier protection attempt unresolved'); }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function phoenixIntentHash(intent: PhoenixIntent): string {
  return createHash('sha256').update(canonical(intent)).digest('hex');
}

function rowBot(row: Record<string, any>): PhoenixBotIdentityColumns {
  return { id: row.id, walletAddress: row.wallet_address, activeProtocol: row.active_protocol,
    protocolSubaccountId: row.protocol_subaccount_id, derivationIndex: row.derivation_index,
    derivationPathVersion: row.derivation_path_version, phoenixAuthorityWallet: row.phoenix_authority_wallet,
    phoenixTraderAccount: row.phoenix_trader_account, phoenixNetwork: row.phoenix_network,
    phoenixProgramAddress: row.phoenix_program_address, phoenixPortfolioIndex: row.phoenix_portfolio_index,
    phoenixSubaccountIndex: row.phoenix_subaccount_index };
}

/** U03/U04 persistence only. No signing, sending, RPC, registration or capability grant.
 * Uses a checked-out client for every transaction; no process-local locking.
 */
export class PhoenixOperationStore {
  constructor(private readonly pool: Pick<Pool, 'connect'>) {}

  async findProtection(request: ProtectionRequest): Promise<StoredPhoenixOperation | null> {
    return this.transaction(async client => {
      await this.lockBot(client, request.botId, request.ownerWallet);
      const { rows: [row] } = await client.query('SELECT id FROM phoenix_operations WHERE bot_id=$1 AND request_key=$2', [request.botId, request.requestKey]);
      if (!row) return null;
      const operation = await this.lockOperation(client, request.botId, request.ownerWallet, row.id);
      if (canonical(operation.intent.protection?.request) !== canonical(request)) throw new Error('Protection replay payload mismatch');
      return operation;
    });
  }

  async protectionInFlight(botId: string, ownerWallet: string, operationId: string): Promise<boolean> {
    return this.transaction(async client => {
      await this.lockBot(client, botId, ownerWallet);
      const protection = await this.pendingProtection(client, botId, operationId);
      const orders = await client.query(`SELECT 1 FROM phoenix_order_intents WHERE bot_id=$1 AND state NOT IN ('settled','rejected')`, [botId]);
      return !!(protection.rows.length || orders.rows.length);
    });
  }

  private pendingProtection(client: PoolClient, botId: string, operationId: string) {
    return client.query(`SELECT 1 FROM phoenix_operations o JOIN phoenix_operation_attempts a ON a.operation_id=o.id
      WHERE o.bot_id=$1 AND o.id<>$2 AND o.kind='protection' AND a.state='submission_pending'`, [botId, operationId]);
  }

  async read(botId: string, ownerWallet: string, operationId: string) {
    return this.transaction(async client => {
      const operation = await this.lockOperation(client, botId, ownerWallet, operationId);
      const attempts = await client.query('SELECT * FROM phoenix_operation_attempts WHERE operation_id = $1 ORDER BY attempt_number DESC LIMIT 1', [operationId]);
      const row = attempts.rows[0];
      return { operation, attempt: row ? { signature: row.signature, blockhash: row.blockhash,
        lastValidBlockHeight: row.last_valid_block_height, transactionHash: row.transaction_hash } as PhoenixAttemptInput : undefined };
    });
  }

  /** Pre-send refusals remain prepared, preserving retry identity and public recovery details. */
  async annotatePrepared(botId: string, ownerWallet: string, operationId: string, revision: number, observation: Record<string, unknown>) {
    return this.transaction(async client => {
      const operation = await this.lockOperation(client, botId, ownerWallet, operationId);
      if (operation.state !== 'prepared' || operation.revision !== revision) throw new Error('Phoenix stale preparation');
      const result = await client.query(`UPDATE phoenix_operations SET observation = $2, revision = revision + 1,
        updated_at = now() WHERE id = $1 RETURNING *`, [operationId, { ...structuredClone(observation), ...(operation.observation?.funding ? { funding: operation.observation.funding } : {}) }]);
      return result.rows[0] as StoredPhoenixOperation;
    });
  }

  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  private async lockBot(client: PoolClient, botId: string, ownerWallet: string) {
    const result = await client.query('SELECT * FROM trading_bots WHERE id = $1 AND wallet_address = $2 FOR UPDATE', [botId, ownerWallet]);
    if (!result.rows[0]) throw new Error('Phoenix bot not owned');
    return phoenixIdentityFromBot(rowBot(result.rows[0]));
  }

  async prepare(input: PhoenixIntent): Promise<{ operation: StoredPhoenixOperation; created: boolean }> {
    // Snapshot before awaiting: a caller cannot mutate the admitted identity while we wait for a lock.
    const intent = structuredClone(input);
    if (intent.funding) validateFundingIntent(intent);
    if (!['register', 'deposit', 'withdraw', 'transfer', 'protection'].includes(intent.kind)
      || typeof intent.requestKey !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(intent.requestKey)
      || intent.requestKey.includes('\n') || intent.mint !== PHOENIX_PUBLIC_ADDRESSES.usdcMint
      || typeof intent.destination !== 'string' || !intent.destination || intent.destination.length > 200) {
      throw new Error('Invalid Phoenix intent');
    }
    for (const amount of [intent.amountBaseUnits, intent.feeBaseUnits]) {
      if (typeof amount !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(amount) || amount.includes('\n')
        || BigInt(amount) > 18446744073709551615n) throw new Error('Invalid Phoenix base units');
    }
    if (['register', 'protection'].includes(intent.kind) ? intent.amountBaseUnits !== '0' : intent.amountBaseUnits === '0') {
      throw new Error('Invalid Phoenix operation amount');
    }
    if ((intent.kind === 'protection') !== !!intent.protection) throw new Error('Protection terms required');
    if (intent.protection) {
      const p = intent.protection, r = p.request;
      if (intent.funding || intent.executionOrderId || intent.feeBaseUnits !== '0' || intent.destination !== intent.identity.traderAccountAddress
        || r.botId !== intent.botId || r.ownerWallet !== intent.ownerWallet || r.requestKey !== intent.requestKey
        || canonical(r.identity) !== canonical(intent.identity)
        || canonical(planProtection(r, p.before, p.before.observedAt)) !== canonical(p)) throw new Error('Invalid protection terms');
    }
    return this.transaction(async client => {
      const identity = await this.lockBot(client, intent.botId, intent.ownerWallet);
      if (canonical(identity) !== canonical(intent.identity)) throw new Error('Phoenix intent identity mismatch');
      const intentHash = phoenixIntentHash(intent);
      const replay = await client.query('SELECT * FROM phoenix_operations WHERE bot_id = $1 AND request_key = $2', [intent.botId, intent.requestKey]);
      if (replay.rows[0]) {
        if (replay.rows[0].intent_hash !== intentHash || canonical(replay.rows[0].intent) !== canonical(intent)) {
          throw new Error('Phoenix replay payload mismatch');
        }
        return { operation: replay.rows[0], created: false };
      }
      {
        // The order table is absent only on a pre-U05 schema (including U04 fixtures).
        const orderSchema = await client.query("SELECT to_regclass('phoenix_order_intents') AS table_name");
        if (orderSchema.rows[0]?.table_name) {
          const active = (await client.query(`SELECT id,state,intent,data FROM phoenix_order_intents WHERE bot_id=$1 AND state NOT IN ('settled','rejected')`, [intent.botId])).rows[0];
          if ((active || intent.executionOrderId) && intent.kind !== 'protection') {
            if (!active || active.id !== intent.executionOrderId || active.state !== 'funding' || active.intent.action !== 'entry'
              || !intent.funding || !['wallet_funding', 'deposit'].includes(intent.funding.leg)) throw new Error('Phoenix order excludes conflicting funding/park');
            const used = (await client.query(`SELECT COALESCE(sum((intent->'funding'->>'grossBaseUnits')::numeric),0)::text AS amount
              FROM phoenix_operations WHERE bot_id=$1 AND intent->>'executionOrderId'=$2 AND intent->'funding'->>'leg'=$3`,
              [intent.botId, active.id, intent.funding.leg])).rows[0].amount;
            if (BigInt(used) + BigInt(intent.funding.grossBaseUnits) > BigInt(active.data.admission.fundingShortfallMicros)) throw new Error('Order funding budget exceeded');
          }
        } else if (intent.executionOrderId) throw new Error('Phoenix order schema unavailable');
      }
      if (intent.kind !== 'protection' && !['withdraw', 'transfer'].includes(intent.kind)) {
        const protection = await client.query(`SELECT 1 FROM phoenix_operations WHERE bot_id=$1 AND kind='protection' AND state NOT IN ('completed','failed','dropped')`, [intent.botId]);
        if (protection.rows.length) throw new Error('Protection unresolved; new funding unavailable');
      }
      if (intent.funding) {
        const registered = await client.query(`SELECT 1 FROM phoenix_operations WHERE bot_id = $1 AND kind = 'register' AND state = 'completed'`, [intent.botId]);
        if (!registered.rows.length) throw new Error('Phoenix registration not confirmed');
        const parentId = intent.funding.parentOperationId;
        if (parentId) {
          const parent = await this.lockOperation(client, intent.botId, intent.ownerWallet, parentId);
          const expectedParent = ({ deposit: 'wallet_funding', unwrap: 'withdraw', wallet_return: 'unwrap' } as Record<string, string>)[intent.funding.leg];
          if (!expectedParent || parent.state !== 'completed' || parent.intent.funding?.leg !== expectedParent
            || parent.intent.amountBaseUnits !== intent.funding.grossBaseUnits
            || !parent.observation?.funding) throw new Error('Funding parent not settled');
          const consumed = await client.query(`SELECT 1 FROM phoenix_operations WHERE bot_id = $1 AND intent->'funding'->>'parentOperationId' = $2`, [intent.botId, parentId]);
          if (consumed.rows.length) throw new Error('Funding parent already consumed');
        }
      }
      // Use explicit epoch milliseconds: U02's timestamp-without-time-zone column
      // cannot safely measure durations across database/client timezone settings.
      const observation = intent.funding ? { funding: { requestedAt: Date.now() } } : intent.protection ? { protection: {
        step: 0, before: intent.protection.before, after: intent.protection.before,
        remainingLegs: intent.protection.before.legs, allOrdersCancelled: false, protected: false,
      } } : null;
      const inserted = await client.query(`INSERT INTO phoenix_operations (bot_id, request_key, kind, intent, intent_hash, observation)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [intent.botId, intent.requestKey, intent.kind, intent, intentHash, observation]);
      return { operation: inserted.rows[0], created: true };
    });
  }

  private async lockOperation(client: PoolClient, botId: string, ownerWallet: string, operationId: string) {
    const identity = await this.lockBot(client, botId, ownerWallet);
    const result = await client.query('SELECT * FROM phoenix_operations WHERE id = $1 AND bot_id = $2 FOR UPDATE', [operationId, botId]);
    const operation = result.rows[0] as StoredPhoenixOperation | undefined;
    if (!operation || operation.intent_hash !== phoenixIntentHash(operation.intent)
      || operation.intent.botId !== botId || operation.intent.ownerWallet !== ownerWallet
      || operation.intent.kind !== operation.kind || operation.intent.requestKey !== operation.request_key
      || canonical(operation.intent.identity) !== canonical(identity)) throw new Error('Phoenix persisted intent mismatch');
    return operation;
  }

  /** Write-ahead send claim. A replay never grants another send. After a crash even
   * an unsent submission_pending attempt must be reconciled, never blindly retried.
   */
  async recordAttempt(botId: string, ownerWallet: string, operationId: string, revision: number, input: PhoenixAttemptInput) {
    const attempt = structuredClone(input);
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(attempt.signature) || attempt.signature.includes('\n')
      || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(attempt.blockhash) || attempt.blockhash.includes('\n')
      || !/^[0-9a-f]{64}$/.test(attempt.transactionHash) || attempt.transactionHash.length !== 64
      || !/^(0|[1-9][0-9]{0,19})$/.test(attempt.lastValidBlockHeight) || attempt.lastValidBlockHeight.includes('\n')) {
      throw new Error('Invalid Phoenix attempt');
    }
    return this.transaction(async client => {
      const operation = await this.lockOperation(client, botId, ownerWallet, operationId);
      const existing = await client.query('SELECT * FROM phoenix_operation_attempts WHERE signature = $1', [attempt.signature]);
      if (existing.rows[0]) {
        const prior = existing.rows[0];
        if (prior.operation_id !== operationId || prior.blockhash !== attempt.blockhash
          || prior.transaction_hash !== attempt.transactionHash || prior.last_valid_block_height !== attempt.lastValidBlockHeight) {
          throw new Error('Phoenix signature replay mismatch');
        }
        return { attempt: prior, created: false };
      }
      if (operation.state !== 'prepared' || operation.revision !== revision) throw new Error('Phoenix stale send claim');
      const count = await client.query('SELECT count(*)::integer AS count FROM phoenix_operation_attempts WHERE operation_id = $1', [operationId]);
      const next = count.rows[0].count + 1;
      if (next > (operation.kind === 'protection' ? 256 : 5)) throw new Error('Phoenix retry budget exhausted');
      if (operation.intent.protection && ['replace', 'breakeven'].includes(operation.intent.protection.request.action)) {
        // A pause/cancel claim permanently revokes older replacements, including after restart.
        const revoke = await client.query(`SELECT 1 FROM phoenix_operations WHERE bot_id=$1 AND kind='protection'
          AND intent->'protection'->'request'->>'action' IN ('pause','cancel') AND created_at >= $2 AND id <> $3`,
          [botId, operation.created_at, operation.id]);
        if (revoke.rows.length) throw new Error('Replacement revoked by safety action');
        // Under the same bot lock as the write-ahead claim: a prior cancel can
        // still hit a reused slot even when a fresh snapshot says it is empty.
        // All protection actions count, regardless of asset or operation state.
        if ((await this.pendingProtection(client, botId, operationId)).rows.length) throw new PhoenixProtectionPendingError();
      }
      const inserted = await client.query(`INSERT INTO phoenix_operation_attempts
        (operation_id, attempt_number, signature, blockhash, last_valid_block_height, transaction_hash)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [operationId, next, attempt.signature, attempt.blockhash, attempt.lastValidBlockHeight, attempt.transactionHash]);
      await client.query(`UPDATE phoenix_operations SET state = 'submission_pending', revision = revision + 1, updated_at = now() WHERE id = $1`, [operationId]);
      return { attempt: inserted.rows[0], created: true };
    });
  }

  /** Only U03/U04's authoritative chain observer may supply these outcomes.
   * Timeout/404 belongs to unknown, never failed/expired/completed.
   */
  async observe(botId: string, ownerWallet: string, operationId: string, revision: number,
    state: Exclude<PhoenixOperationState, 'submission_pending'>,
    observation: { source: string; reference: string; attemptOutcome?: 'confirmed' | 'failed' | 'expired'; fundingReceipt?: FundingReceipt; protection?: ProtectionProgress }) {
    const evidence = structuredClone(observation);
    if (!evidence.source || !evidence.reference) throw new Error('Phoenix observation evidence required');
    return this.transaction(async client => {
      const operation = await this.lockOperation(client, botId, ownerWallet, operationId);
      if (operation.revision !== revision || ['completed', 'failed', 'dropped'].includes(operation.state)) throw new Error('Phoenix stale observation');
      const pending = await client.query(`SELECT * FROM phoenix_operation_attempts WHERE operation_id = $1 AND state = 'submission_pending'`, [operationId]);
      const confirmed = await client.query(`SELECT 1 FROM phoenix_operation_attempts WHERE operation_id = $1 AND state = 'confirmed'`, [operationId]);
      // A temporary observation outage must not erase a confirmed withdrawal's
      // ability to recover its queue outcome after restart.
      const queueRecovery = operation.kind === 'withdraw' && confirmed.rows.length > 0
        && ['queued', 'unknown'].includes(operation.state) && !pending.rows.length;
      const outcome = evidence.attemptOutcome;
      const allowed = state === 'unknown' ? !outcome && operation.state !== 'prepared'
        : state === 'prepared' ? !!pending.rows[0] && (outcome === 'failed' || outcome === 'expired' || (operation.kind === 'protection' && outcome === 'confirmed'))
        : state === 'queued' ? operation.kind === 'withdraw' && ((pending.rows[0] && outcome === 'confirmed') || (queueRecovery && !outcome))
        : state === 'completed' ? (pending.rows[0] && outcome === 'confirmed') || (queueRecovery && !outcome)
          || (operation.kind === 'protection' && operation.state === 'prepared' && !outcome && !!evidence.protection)
        : state === 'dropped' ? (queueRecovery && !outcome) || (operation.intent.funding && operation.kind === 'withdraw' && pending.rows[0] && outcome === 'confirmed')
        : state === 'failed' ? (pending.rows[0] && (outcome === 'failed' || outcome === 'expired' || (operation.kind === 'protection' && outcome === 'confirmed'))) || (operation.state === 'prepared' && !outcome)
        : false;
      if (!allowed) throw new Error('Phoenix invalid state transition');
      if (operation.kind === 'protection' && !evidence.protection) throw new Error('Protection before/after evidence required');
      let retained: Record<string, unknown> = evidence;
      if (operation.intent.funding) {
        const prior = operation.observation?.funding as FundingHistory | undefined;
        if (!prior || !Number.isSafeInteger(prior.requestedAt)) throw new Error('Funding request timestamp missing');
        const funding: FundingHistory = { ...prior };
        const receipt = evidence.fundingReceipt;
        if (['queued', 'completed', 'dropped'].includes(state) && !receipt) throw new Error('Funding receipt required');
        if (receipt) {
          const latest = await client.query(`SELECT signature FROM phoenix_operation_attempts WHERE operation_id = $1 ORDER BY attempt_number DESC LIMIT 1`, [operationId]);
          validateFundingReceipt(operation, latest.rows[0]?.signature, receipt);
          if (state !== (receipt.outcome === 'settled' ? 'completed' : receipt.outcome)) throw new Error('Funding receipt state mismatch');
          if (receipt.intentHash !== operation.intent_hash || receipt.finalized !== true
            || !Number.isSafeInteger(receipt.observedAt) || receipt.observedAt < funding.requestedAt
            || receipt.observedAt > Date.now() || (funding.receipt && receipt.observedAt < funding.receipt.observedAt)
            || (funding.queueRequestId && receipt.queueRequestId !== funding.queueRequestId)) throw new Error('Funding receipt binding mismatch');
          if (state === 'queued') funding.queuedAt ??= receipt.observedAt;
          if (state === 'completed') funding.completedAt = receipt.observedAt;
          if (state === 'dropped') funding.droppedAt = receipt.observedAt;
          funding.queueRequestId ??= receipt.queueRequestId;
          funding.receipt = receipt;
          funding.events = state === operation.state ? prior?.events : [...(prior?.events ?? []), { state, observedAt: receipt.observedAt, source: receipt.source, reference: receipt.reference, receipt }];
        }
        retained = { ...evidence, funding };
      }
      if (outcome) await client.query('UPDATE phoenix_operation_attempts SET state = $2 WHERE id = $1', [pending.rows[0].id, outcome]);
      const result = await client.query(`UPDATE phoenix_operations SET state = $2, observation = $3,
        revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING *`, [operationId, state, retained]);
      return result.rows[0] as StoredPhoenixOperation;
    });
  }

  async recover(botId: string, ownerWallet: string): Promise<StoredPhoenixOperation[]> {
    return this.transaction(async client => {
      await this.lockBot(client, botId, ownerWallet);
      const result = await client.query(`SELECT * FROM phoenix_operations WHERE bot_id = $1
        AND state NOT IN ('completed','failed','dropped') ORDER BY created_at`, [botId]);
      return Promise.all(result.rows.map(row => this.lockOperation(client, botId, ownerWallet, row.id)));
    });
  }

  /** Owned history remains available after restart, including settled legs awaiting a successor. */
  async fundingHistory(botId: string, ownerWallet: string): Promise<StoredPhoenixOperation[]> {
    return this.transaction(async client => {
      await this.lockBot(client, botId, ownerWallet);
      const rows = await client.query(`SELECT id FROM phoenix_operations WHERE bot_id = $1 AND intent ? 'funding' ORDER BY created_at`, [botId]);
      return Promise.all(rows.rows.map(row => this.lockOperation(client, botId, ownerWallet, row.id)));
    });
  }
}
