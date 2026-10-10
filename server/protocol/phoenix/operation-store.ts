import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { PhoenixTraderIdentity } from '../../../shared/phoenix-read-contract';
import { phoenixIdentityFromBot, type PhoenixBotIdentityColumns } from './identity';
import { PHOENIX_PUBLIC_ADDRESSES } from './sdk-boundary';

export type PhoenixOperationKind = 'register' | 'deposit' | 'withdraw' | 'transfer';
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
}
export interface StoredPhoenixOperation {
  id: string; bot_id: string; request_key: string; kind: PhoenixOperationKind;
  intent: PhoenixIntent; intent_hash: string; state: PhoenixOperationState; revision: number;
  observation: Record<string, unknown> | null;
}
export interface PhoenixAttemptInput {
  signature: string; blockhash: string; lastValidBlockHeight: string; transactionHash: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
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
    if (!['register', 'deposit', 'withdraw', 'transfer'].includes(intent.kind)
      || typeof intent.requestKey !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(intent.requestKey)
      || intent.requestKey.includes('\n') || intent.mint !== PHOENIX_PUBLIC_ADDRESSES.usdcMint
      || typeof intent.destination !== 'string' || !intent.destination || intent.destination.length > 200) {
      throw new Error('Invalid Phoenix intent');
    }
    for (const amount of [intent.amountBaseUnits, intent.feeBaseUnits]) {
      if (typeof amount !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(amount) || amount.includes('\n')
        || BigInt(amount) > 18446744073709551615n) throw new Error('Invalid Phoenix base units');
    }
    if (intent.kind === 'register' ? intent.amountBaseUnits !== '0' : intent.amountBaseUnits === '0') {
      throw new Error('Invalid Phoenix operation amount');
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
      const inserted = await client.query(`INSERT INTO phoenix_operations (bot_id, request_key, kind, intent, intent_hash)
        VALUES ($1,$2,$3,$4,$5) RETURNING *`, [intent.botId, intent.requestKey, intent.kind, intent, intentHash]);
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
      if (next > 5) throw new Error('Phoenix retry budget exhausted');
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
    observation: { source: string; reference: string; attemptOutcome?: 'confirmed' | 'failed' | 'expired' }) {
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
        : state === 'prepared' ? !!pending.rows[0] && (outcome === 'failed' || outcome === 'expired')
        : state === 'queued' ? operation.kind === 'withdraw' && ((pending.rows[0] && outcome === 'confirmed') || (queueRecovery && !outcome))
        : state === 'completed' ? (pending.rows[0] && outcome === 'confirmed') || (queueRecovery && !outcome)
        : state === 'dropped' ? queueRecovery && !outcome
        : state === 'failed' ? (pending.rows[0] && (outcome === 'failed' || outcome === 'expired')) || (operation.state === 'prepared' && !outcome)
        : false;
      if (!allowed) throw new Error('Phoenix invalid state transition');
      if (outcome) await client.query('UPDATE phoenix_operation_attempts SET state = $2 WHERE id = $1', [pending.rows[0].id, outcome]);
      const result = await client.query(`UPDATE phoenix_operations SET state = $2, observation = $3,
        revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING *`, [operationId, state, evidence]);
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
}
