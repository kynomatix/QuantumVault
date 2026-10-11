import type { Pool, PoolClient } from 'pg';
import { phoenixIdentityFromBot } from './identity';
import { orderIntentHash, validateOrderIntent, type PhoenixOrderIntent, type PhoenixAdmission } from './order-contract';
import type { PhoenixAttemptInput } from './operation-store';

export type OrderState = 'admitted' | 'funding' | 'signing' | 'submission_pending' | 'accepted' | 'landed' | 'unknown' | 'settled' | 'rejected';
export interface PhoenixFill { fillId: string; orderId: string; baseLots: string; quoteMicros: string; feeMicros: string }
export interface PhoenixOrderRecord {
  id: string; intent: PhoenixOrderIntent; intent_hash: string; state: OrderState; revision: number;
  data: { admission: PhoenixAdmission; attempt?: PhoenixAttemptInput; orderId?: string; fills?: PhoenixFill[];
    remainingLots?: string; remainingPositionLots?: string; positionEpoch?: string; outcomeSource?: string; outcomeReference?: string; reason?: string };
}
export interface OrderRepository {
  prepare(intent: PhoenixOrderIntent, admission: PhoenixAdmission): Promise<{ record: PhoenixOrderRecord; created: boolean }>;
  find(intent: PhoenixOrderIntent): Promise<PhoenixOrderRecord | null>;
  read(intent: PhoenixOrderIntent, id: string): Promise<PhoenixOrderRecord>;
  change(record: PhoenixOrderRecord, state: OrderState, data?: Partial<PhoenixOrderRecord['data']>): Promise<PhoenixOrderRecord>;
}

/** Same trading_bots row lock as U04. Durable active rows exclude funding/park/close
 * across processes and restarts; no process-local mutex can authorize a money leg. */
export class PhoenixOrderStore implements OrderRepository {
  constructor(private readonly pool: Pick<Pool, 'connect'>) {}
  private async locked<T>(intent: PhoenixOrderIntent, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    validateOrderIntent(intent);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const { rows: [b] } = await c.query('SELECT * FROM trading_bots WHERE id=$1 AND wallet_address=$2 FOR UPDATE', [intent.botId, intent.ownerWallet]);
      if (!b) throw new Error('Phoenix bot not owned');
      const identity = phoenixIdentityFromBot({ id: b.id, walletAddress: b.wallet_address, activeProtocol: b.active_protocol,
        protocolSubaccountId: b.protocol_subaccount_id, derivationIndex: b.derivation_index, derivationPathVersion: b.derivation_path_version,
        phoenixAuthorityWallet: b.phoenix_authority_wallet, phoenixTraderAccount: b.phoenix_trader_account, phoenixNetwork: b.phoenix_network,
        phoenixProgramAddress: b.phoenix_program_address, phoenixPortfolioIndex: b.phoenix_portfolio_index, phoenixSubaccountIndex: b.phoenix_subaccount_index });
      if (orderIntentHash(identity) !== orderIntentHash(intent.identity)) throw new Error('Phoenix order identity mismatch');
      const result = await fn(c); await c.query('COMMIT'); return result;
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  private verify(record: PhoenixOrderRecord, intent: PhoenixOrderIntent) {
    if (!record || record.intent_hash !== orderIntentHash(record.intent) || record.intent_hash !== orderIntentHash(intent)) throw new Error('Order replay payload mismatch');
    return record;
  }
  async find(input: PhoenixOrderIntent) {
    const i = structuredClone(input);
    return this.locked(i, async c => {
      const { rows: [r] } = await c.query('SELECT * FROM phoenix_order_intents WHERE bot_id=$1 AND request_key=$2', [i.botId, i.requestKey]);
      return r ? this.verify(r, i) : null;
    });
  }
  async read(input: PhoenixOrderIntent, id: string) {
    const i = structuredClone(input);
    return this.locked(i, async c => this.verify((await c.query('SELECT * FROM phoenix_order_intents WHERE bot_id=$1 AND id=$2', [i.botId, id])).rows[0], i));
  }
  async prepare(input: PhoenixOrderIntent, snapshot: PhoenixAdmission) {
    const i = structuredClone(input), admission = structuredClone(snapshot);
    return this.locked(i, async c => {
      const replay = (await c.query('SELECT * FROM phoenix_order_intents WHERE bot_id=$1 AND request_key=$2', [i.botId, i.requestKey])).rows[0];
      if (replay) return { record: this.verify(replay, i), created: false };
      const busy = await c.query(`SELECT 1 FROM phoenix_operations WHERE bot_id=$1 AND state NOT IN ('completed','failed','dropped')`, [i.botId]);
      if (busy.rows.length) throw new Error('Phoenix funding/registration unresolved');
      const registered = await c.query(`SELECT 1 FROM phoenix_operations WHERE bot_id=$1 AND kind='register' AND state='completed'`, [i.botId]);
      if (!registered.rows.length) throw new Error('Phoenix registration not confirmed');
      const newer = await c.query(`SELECT 1 FROM phoenix_order_intents WHERE bot_id=$1 AND sequence >= $2::numeric`, [i.botId, i.sequence]);
      if (newer.rows.length) throw new Error('Reordered Phoenix signal');
      const { rows: [record] } = await c.query(`INSERT INTO phoenix_order_intents (bot_id,request_key,sequence,intent,intent_hash,data)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [i.botId, i.requestKey, i.sequence, i, orderIntentHash(i), { admission }]);
      return { record, created: true };
    });
  }
  async change(input: PhoenixOrderRecord, state: OrderState, patch: Partial<PhoenixOrderRecord['data']> = {}) {
    const record = structuredClone(input), data = structuredClone(patch);
    return this.locked(record.intent, async c => {
      const current = this.verify((await c.query('SELECT * FROM phoenix_order_intents WHERE id=$1 FOR UPDATE', [record.id])).rows[0], record.intent);
      const transitions: Record<OrderState, OrderState[]> = {
        admitted: ['funding', 'signing', 'rejected'], funding: ['signing', 'unknown'], signing: ['submission_pending', 'unknown', 'rejected'],
        submission_pending: ['accepted', 'unknown', 'landed', 'settled'], accepted: ['unknown', 'landed', 'settled'],
        landed: ['landed', 'settled'], unknown: ['landed', 'settled'], settled: [], rejected: [],
      };
      if (current.revision !== record.revision || !transitions[current.state].includes(state)) throw new Error('Stale Phoenix order transition');
      if (state === 'signing') {
        const busy = await c.query(`SELECT 1 FROM phoenix_operations WHERE bot_id=$1 AND state NOT IN ('completed','failed','dropped')`, [record.intent.botId]);
        if (busy.rows.length) throw new Error('Funding must settle before order signing');
      }
      const next = { ...current.data, ...data };
      if (current.data.attempt && orderIntentHash(next.attempt) !== orderIntentHash(current.data.attempt)) throw new Error('Immutable order signature');
      if (state === 'submission_pending' && !next.attempt) throw new Error('Order signature required before submission');
      const { rows: [updated] } = await c.query(`UPDATE phoenix_order_intents SET state=$2,data=$3,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`, [record.id, state, next]);
      return updated as PhoenixOrderRecord;
    });
  }
}
