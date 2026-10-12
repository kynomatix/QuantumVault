import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import type { Pool, PoolClient } from 'pg';
import { requireSchemaCapabilityReady } from '../schema-readiness';
import type { GridPolicy, SignedGridLevel } from './policy-hmac';

/** Trusted reconciliation must supply operation-specific terminal facts; a fill alone is never terminal proof. */
export interface GridOperationConfirmation {
  requestIdentity:string;type:string;source:string;observedAt:Date;
  venueOrderId:string|null;clientOrderUuid:string|null;transactionSignature:string|null;confirmedAmountUsdc:string|null;
  expectedSize?:string;filledSize?:string;
}
export class GridStorageError extends Error {
  constructor(public code: 'not_found' | 'conflict' | 'invariant' | 'lost_lease', message = code) { super(message); }
}
export interface DraftRecord extends Omit<GridPolicy, 'levels'> {
  walletAddress: string; clientRequestId: string; serverIntentDigest: string; draftRevision: string;
  createIntent: unknown; authoritySnapshot: unknown; policyHmac: string; name: string;
  rangeSource: 'manual' | 'auto'; chartTimeframe: string;
}
export type StoredBot = DraftRecord & { status: string; totalFees: string; residualUsdc: string | null; createdAt: Date; updatedAt: Date };
export type StoredLevel = SignedGridLevel & { id: string; botId: string; status: string; cumulativeFilledSize: string };
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const row = <T>(r: Record<string, unknown>): T => Object.fromEntries(Object.entries(r).map(([k, v]) => [camel(k), v])) as T;
const snake = (s: string) => s.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
const decimal = (v: unknown, nullable = false) => v === null && nullable || typeof v === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v);
function botRow(r: Record<string, unknown>): StoredBot {
  for (const key of ['upper_price','lower_price','start_price','total_investment','total_fees'])
    if (!decimal(r[key])) throw new GridStorageError('invariant');
  for (const key of ['stop_loss_percent','stop_loss_price','sol_balance','residual_usdc'])
    if (!decimal(r[key], true)) throw new GridStorageError('invariant');
  return row<StoredBot>(r);
}
const equal = (a: unknown, b: unknown): boolean => {
  if (a instanceof Date || b instanceof Date) return new Date(a as string).getTime() === new Date(b as string).getTime();
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
    return Object.keys(x).length === Object.keys(y).length && Object.keys(x).every(k => equal(x[k], y[k]));
  } return a === b;
};
export class GridStorage {
  constructor(private pool: Pool, private readiness = () => requireSchemaCapabilityReady('grid_bot', async (q, v) => this.pool.query(q, v ? [...v] : undefined))) {}
  private async transaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    await this.readiness(); const c = await this.pool.connect();
    try { await c.query('BEGIN'); const value = await fn(c); await c.query('COMMIT'); return value; }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  async createDraftWithLevels(bot: DraftRecord, levels: SignedGridLevel[]): Promise<{ bot: StoredBot; result: 'created' | 'existing_request' }> {
    if (levels.length !== bot.gridCount + 1 || !levels.every((l, i) => l.ordinal === i + 1)
      || !/^[0-9A-F]{64}$/.test(bot.serverIntentDigest)) throw new GridStorageError('invariant');
    return this.transaction(async c => {
      const keys = Object.keys(bot), values = keys.map(k => bot[k as keyof DraftRecord]);
      const created = await c.query(`INSERT INTO grid_bots (${keys.map(snake).join(',')}) VALUES (${keys.map((_, i) => '$'+(i+1)).join(',')}) ON CONFLICT (wallet_address,client_request_id) DO NOTHING RETURNING *`, values);
      if (!created.rowCount) {
        const existing = await c.query('SELECT * FROM grid_bots WHERE wallet_address=$1 AND client_request_id=$2', [bot.walletAddress,bot.clientRequestId]);
        if (!existing.rows[0]) throw new GridStorageError('invariant');
        return { bot: botRow(existing.rows[0]), result: 'existing_request' };
      }
      for (const l of levels) await c.query('INSERT INTO grid_levels (id,bot_id,ordinal,price,size,side,reduce_only) VALUES ($1,$2,$3,$4,$5,$6,$7)', [randomUUID(),bot.id,l.ordinal,l.price,l.size,l.side,l.reduceOnly]);
      return { bot: botRow(created.rows[0]), result: 'created' };
    });
  }
  async findByClientRequest(wallet: string, request: string): Promise<StoredBot | null> {
    await this.readiness(); const r = await this.pool.query('SELECT * FROM grid_bots WHERE wallet_address=$1 AND client_request_id=$2', [wallet,request]);
    return r.rows[0] ? botRow(r.rows[0]) : null;
  }
  async listBots(wallet: string, includeStopped = false): Promise<StoredBot[]> {
    await this.readiness(); const r = await this.pool.query("SELECT * FROM grid_bots WHERE wallet_address=$1 AND ($2 OR status <> 'stopped') ORDER BY created_at DESC,id", [wallet,includeStopped]);
    return r.rows.map(botRow);
  }
  async getBotSnapshot(wallet: string, id: string): Promise<{ bot: StoredBot; levels: StoredLevel[]; operations: Record<string,unknown>[] }> {
    return this.transaction(async c => {
      // One MVCC snapshot for the bot, geometry and unresolved operations.
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const b = await c.query('SELECT * FROM grid_bots WHERE wallet_address=$1 AND id=$2', [wallet,id]);
      if (!b.rows[0]) throw new GridStorageError('not_found');
      const l = await c.query('SELECT * FROM grid_levels WHERE bot_id=$1 ORDER BY ordinal', [id]);
      const o = await c.query("SELECT * FROM grid_operations WHERE bot_id=$1 AND state IN ('prepared','submitted','unconfirmed') ORDER BY prepared_at,id",[id]);
      const bot = botRow(b.rows[0]);
      if (l.rows.length !== bot.gridCount + 1 || !l.rows.every((v, i) => v.ordinal === i + 1 && decimal(v.price) && decimal(v.size) && decimal(v.cumulative_filled_size))) throw new GridStorageError('invariant');
      return { bot, levels: l.rows.map(v => row<StoredLevel>(v)), operations: o.rows.map(v => row<Record<string,unknown>>(v)) };
    });
  }
  async listFills(wallet: string, id: string, limit: number, cursor: { time: string; trade: string } | null) {
    await this.getBotSnapshot(wallet,id);
    const r = await this.pool.query('SELECT * FROM grid_fills WHERE bot_id=$1 AND ($2::timestamptz IS NULL OR (venue_fill_time,venue_trade_id) > ($2::timestamptz,$3)) ORDER BY venue_fill_time,venue_trade_id LIMIT $4', [id,cursor?.time ?? null,cursor?.trade ?? '',limit+1]);
    for (const f of r.rows) if (!['price','size','fee'].every(k => decimal(f[k]))) throw new GridStorageError('invariant');
    const hasMore = r.rows.length > limit, fills = r.rows.slice(0,limit), last = fills.at(-1);
    return { fills: fills.map(v => row<Record<string,unknown>>(v)), next: hasMore && last ? { time: new Date(last.venue_fill_time).toISOString(), trade: last.venue_trade_id as string } : null };
  }
  async prepareOperation(input: Record<string,unknown> & { botId: string; idempotencyKey: string; requestIdentity: string; type: string }) {
    const allowed = new Set(['botId','levelId','parentOperationId','idempotencyKey','requestIdentity','type','attempt','clientOrderUuid','venueOrderId','transactionSignature','amountUsdc','triggerPrice','triggerPnl','triggerObservedAt','notificationType','notificationPayload']);
    if (Object.keys(input).some(k => !allowed.has(k))) throw new GridStorageError('invariant');
    const immutable={levelId:null,parentOperationId:null,attempt:1,clientOrderUuid:null,venueOrderId:null,transactionSignature:null,amountUsdc:null,triggerPrice:null,triggerPnl:null,triggerObservedAt:null,notificationType:null,notificationPayload:null,...input};
    return this.transaction(async c => {
      // Bot lock serializes preparation against fill accounting and parent/level validation.
      const owner = await c.query('SELECT id,status FROM grid_bots WHERE id=$1 FOR UPDATE',[input.botId]);
      if(!owner.rowCount || owner.rows[0].status==='draft' && ['provision_subaccount','set_leverage','fund_subaccount','seed_position','place_level_order'].includes(input.type)) throw new GridStorageError('invariant');
      if (input.levelId) {
        const level = await c.query('SELECT id FROM grid_levels WHERE id=$1 AND bot_id=$2',[input.levelId,input.botId]);
        if (!level.rowCount) throw new GridStorageError('invariant');
      }
      if (input.parentOperationId) {
        const parent = await c.query('SELECT id FROM grid_operations WHERE id=$1 AND bot_id=$2',[input.parentOperationId,input.botId]);
        if (!parent.rowCount) throw new GridStorageError('invariant');
      }
      const candidate = { id: randomUUID(), ...immutable }, keys = Object.keys(candidate);
      const r = await c.query(`INSERT INTO grid_operations (${keys.map(snake).join(',')}) VALUES (${keys.map((_,i)=>'$'+(i+1)).join(',')}) ON CONFLICT DO NOTHING RETURNING *`, keys.map(k => candidate[k as keyof typeof candidate]));
      if (r.rowCount) return row<Record<string,unknown>>(r.rows[0]);
      const existing = await c.query('SELECT * FROM grid_operations WHERE idempotency_key=$1 OR request_identity=$2',[input.idempotencyKey,input.requestIdentity]);
      if (existing.rows.length !== 1) throw new GridStorageError('conflict');
      const result = row<Record<string,unknown>>(existing.rows[0]);
      if (!Object.entries(immutable).every(([k,v]) => ['amountUsdc','triggerPrice','triggerPnl'].includes(k) && v!==null ? new Decimal(v as string).eq(result[k] as string) : equal(v,result[k]))) throw new GridStorageError('conflict');
      return result;
    });
  }
  async transitionOperation(id: string, expected: string, next: string, failure: string | null = null, confirmation?: GridOperationConfirmation) {
    const transitions: Record<string,string[]> = { prepared:['submitted','unconfirmed','confirmed','failed'], submitted:['unconfirmed','confirmed','failed'], unconfirmed:['confirmed','failed'] };
    if (!transitions[expected]?.includes(next) || ['failed','unconfirmed'].includes(next) && !failure || next === 'confirmed' && failure) throw new GridStorageError('invariant');
    return this.transaction(async c => {
      const current=await c.query('SELECT * FROM grid_operations WHERE id=$1 AND state=$2 FOR UPDATE',[id,expected]);
      if(!current.rowCount)throw new GridStorageError('conflict');
      if(next==='confirmed'){
        const op=current.rows[0];
        if(!confirmation || confirmation.requestIdentity!==op.request_identity || confirmation.type!==op.type
          || !confirmation.source.trim() || !(confirmation.observedAt instanceof Date) || !Number.isFinite(confirmation.observedAt.getTime()) || confirmation.observedAt.getTime()>Date.now()
          || confirmation.venueOrderId!==op.venue_order_id || confirmation.clientOrderUuid!==op.client_order_uuid || confirmation.transactionSignature!==op.transaction_signature
          || (op.amount_usdc===null?confirmation.confirmedAmountUsdc!==null:!decimal(confirmation.confirmedAmountUsdc) || !new Decimal(confirmation.confirmedAmountUsdc!).eq(op.amount_usdc))
          || op.type==='seed_position' && (!decimal(confirmation.expectedSize) || !decimal(confirmation.filledSize) || !new Decimal(confirmation.expectedSize!).gt(0) || !new Decimal(confirmation.filledSize!).eq(confirmation.expectedSize!) || !op.client_order_uuid && !op.venue_order_id))throw new GridStorageError('invariant');
      }
      const r = await c.query("UPDATE grid_operations SET state=$3,failure_classification=$4,submitted_at=CASE WHEN $3 IN ('submitted','confirmed') THEN COALESCE(submitted_at,clock_timestamp()) ELSE submitted_at END,terminal_at=CASE WHEN $3 IN ('confirmed','failed') THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp() WHERE id=$1 AND state=$2 RETURNING *",[id,expected,next,failure]);
      if (!r.rowCount) throw new GridStorageError('conflict'); return row<Record<string,unknown>>(r.rows[0]);
    });
  }
  async recordFillAndLevelState(fill: { botId: string; levelId: string; venueTradeId: string; venueOrderId: string | null; clientOrderUuid: string | null; side: string; price: string; size: string; fee: string; feeAsset: string; partial: boolean; venueFillTime: Date }, operationId: string | null) {
    return this.transaction(async c => {
      const b = await c.query('SELECT id FROM grid_bots WHERE id=$1 FOR UPDATE',[fill.botId]);
      const l = await c.query('SELECT * FROM grid_levels WHERE id=$1 AND bot_id=$2 FOR UPDATE',[fill.levelId,fill.botId]);
      if (!b.rowCount || !l.rowCount || l.rows[0].side !== fill.side || !decimal(fill.size) || !decimal(fill.fee)) throw new GridStorageError('invariant');
      if(operationId){
        const operation=await c.query('SELECT * FROM grid_operations WHERE id=$1 AND bot_id=$2 AND level_id=$3 FOR UPDATE',[operationId,fill.botId,fill.levelId]);
        const op=operation.rows[0];
        if(!op || !['seed_position','place_level_order'].includes(op.type) || (!op.venue_order_id && !op.client_order_uuid)
          || op.venue_order_id && op.venue_order_id!==fill.venueOrderId || op.client_order_uuid && op.client_order_uuid!==fill.clientOrderUuid)throw new GridStorageError('invariant');
      }
      const candidate = { id: randomUUID(),...fill }, keys = Object.keys(candidate);
      const inserted = await c.query(`INSERT INTO grid_fills (${keys.map(snake).join(',')}) VALUES (${keys.map((_,i)=>'$'+(i+1)).join(',')}) ON CONFLICT (venue_trade_id) DO NOTHING RETURNING id`,keys.map(k=>candidate[k as keyof typeof candidate]));
      if (!inserted.rowCount) {
        const r = await c.query('SELECT * FROM grid_fills WHERE venue_trade_id=$1',[fill.venueTradeId]);
        const existing = row<Record<string,unknown>>(r.rows[0]);
        if (!Object.entries(fill).every(([k,v]) => ['price','size','fee'].includes(k) ? new Decimal(v as string).eq(existing[k] as string) : equal(v,existing[k]))) throw new GridStorageError('conflict');
        return 'duplicate' as const;
      }
      const quantity = new Decimal(l.rows[0].cumulative_filled_size).plus(fill.size);
      if (quantity.gt(l.rows[0].size)) throw new GridStorageError('invariant');
      await c.query("UPDATE grid_levels SET cumulative_filled_size=$2,status=$3,last_filled_at=$4,updated_at=clock_timestamp() WHERE id=$1",[fill.levelId,quantity.toFixed(),quantity.eq(l.rows[0].size)?'filled':'partially_filled',fill.venueFillTime]);
      await c.query('UPDATE grid_bots SET total_fees=total_fees+$2,updated_at=clock_timestamp() WHERE id=$1',[fill.botId,fill.fee]);
      return 'recorded' as const;
    });
  }
  async claimLease(states: string[], token: string, durationMs: number) {
    if (!states.length || !Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 300_000) throw new GridStorageError('invariant');
    return this.transaction(async c => {
      // An expired token is an uncertain old worker, not permission to take over money work.
      const r = await c.query("WITH candidate AS (SELECT id FROM grid_bots WHERE status=ANY($1::text[]) AND lease_token IS NULL ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE grid_bots SET lease_token=$2,lease_expires_at=clock_timestamp()+$3*interval '1 millisecond' FROM candidate WHERE grid_bots.id=candidate.id RETURNING grid_bots.*",[states,token,durationMs]);
      return r.rows[0] ? botRow(r.rows[0]) : null;
    });
  }
  async renewLease(id: string, token: string, durationMs: number) {
    if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 300_000) throw new GridStorageError('invariant');
    await this.readiness(); const r = await this.pool.query("UPDATE grid_bots SET lease_expires_at=clock_timestamp()+$3*interval '1 millisecond' WHERE id=$1 AND lease_token=$2 AND lease_expires_at>clock_timestamp() RETURNING id",[id,token,durationMs]);
    if (!r.rowCount) throw new GridStorageError('lost_lease');
  }
  async releaseLease(id: string, token: string) {
    await this.readiness(); const r = await this.pool.query('UPDATE grid_bots SET lease_token=NULL,lease_expires_at=NULL WHERE id=$1 AND lease_token=$2 AND lease_expires_at>clock_timestamp() RETURNING id',[id,token]);
    if (!r.rowCount) throw new GridStorageError('lost_lease');
  }
  async compareAndSetLifecycle(id: string, expected: string, next: string, token: string, patch: Record<string,unknown> = {}) {
    const allowed = new Set(['pauseReason','lastTickAt','reconciliationCursor','lastReconciliationAt','startupReconciledAt','canaryStartedAt','canaryCleanSince','canaryPromotedAt','canaryCleanTicks','consecutiveFailures','incidentIdentity','incidentOpenedAt','incidentNotifiedAt','solBalance','solBalanceObservedAt','solGuardState','lowestActiveBuyLevel','highestActiveSellLevel']);
    if (Object.keys(patch).some(k=>!allowed.has(k)) || expected === 'draft' || next === 'draft' || next === 'stopped') throw new GridStorageError('invariant');
    return this.transaction(async c => {
      const entries = Object.entries(patch), updates = entries.map(([k],i)=>`${snake(k)}=$${i+5}`);
      const r = await c.query(`UPDATE grid_bots SET status=$3,updated_at=clock_timestamp()${updates.length?','+updates.join(','):''} WHERE id=$1 AND status=$2 AND lease_token=$4 AND lease_expires_at>clock_timestamp() RETURNING *`,[id,expected,next,token,...entries.map(([,v])=>v)]);
      if (!r.rowCount) throw new GridStorageError('lost_lease'); return botRow(r.rows[0]);
    });
  }
  async finalizeTerminalStop(id:string,token:string,operationId:string,amount:string|null,observedAt:Date|null) {
    if(!decimal(amount,true) || (amount===null)!==(observedAt===null) || observedAt && (!Number.isFinite(observedAt.getTime()) || observedAt.getTime()>Date.now()))throw new GridStorageError('invariant');
    return this.transaction(async c=>{
      const b=await c.query("SELECT id FROM grid_bots WHERE id=$1 AND status='stopping' AND lease_token=$2 AND lease_expires_at>clock_timestamp() FOR UPDATE",[id,token]);
      if(!b.rowCount)throw new GridStorageError('lost_lease');
      const op=await c.query("SELECT id FROM grid_operations WHERE id=$1 AND bot_id=$2 AND type='stop_trigger' AND state='confirmed' FOR UPDATE",[operationId,id]);
      if(!op.rowCount || (await c.query("SELECT id FROM grid_operations WHERE bot_id=$1 AND state IN ('prepared','submitted','unconfirmed')",[id])).rowCount)throw new GridStorageError('invariant');
      const result=await c.query("UPDATE grid_bots SET status='stopped',terminal_stop_operation_id=$2,residual_usdc=$3,residual_observed_at=$4,updated_at=clock_timestamp() WHERE id=$1 AND status='stopping' AND lease_token=$5 AND lease_expires_at>clock_timestamp() RETURNING *",[id,operationId,amount,observedAt,token]);
      if(!result.rowCount)throw new GridStorageError('lost_lease');return botRow(result.rows[0]);
    });
  }
  async setResidual(id: string, operationId: string, amount: string | null, observedAt: Date | null) {
    if (!decimal(amount,true) || (amount===null)!==(observedAt===null)) throw new GridStorageError('invariant');
    return this.transaction(async c => {
      const r = await c.query("UPDATE grid_bots SET residual_usdc=$3,residual_observed_at=$4,updated_at=clock_timestamp() WHERE id=$1 AND EXISTS (SELECT 1 FROM grid_operations WHERE id=$2 AND bot_id=$1 AND type IN ('sweep_subaccount','sync') AND state='confirmed') RETURNING id",[id,operationId,amount,observedAt]);
      if (!r.rowCount) throw new GridStorageError('conflict');
    });
  }
}
