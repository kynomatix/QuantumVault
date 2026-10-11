import type { Pool, PoolClient } from 'pg';
import { phoenixIdentityFromBot } from './identity';
import { orderIntentHash } from './order-contract';
import { assertTarget, unsigned, type AccountingTarget } from './accounting-contract';
import type { AccountingRepository, AccountingState } from './accounting-service';
import { phoenixEquity, phoenixPayoutProvenance } from './accounting-equity';
import { enrichEvent, reducePhoenixHistory } from './accounting-reducer';

export class PhoenixAccountingStore implements AccountingRepository {
  constructor(private readonly pool: Pick<Pool, 'connect'>, private readonly now = Date.now) {}
  private async locked<T>(target: AccountingTarget, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    assertTarget(target); const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const row = (await c.query('SELECT * FROM trading_bots WHERE id=$1 FOR UPDATE', [target.botId])).rows[0];
      if (!row || row.wallet_address !== target.ownerWallet) throw new Error('Accounting bot owner mismatch');
      const bot = Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase()), v]));
      if (orderIntentHash(phoenixIdentityFromBot(bot)) !== orderIntentHash(target.identity)) throw new Error('Accounting trader mismatch');
      const result = await fn(c); await c.query('COMMIT'); return result;
    } catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
  }
  async read(target: AccountingTarget): Promise<AccountingState> {
    return this.locked(target, async c => {
      const row = (await c.query('SELECT * FROM phoenix_accounting_state WHERE bot_id=$1', [target.botId])).rows[0];
      const events = (await c.query('SELECT data FROM phoenix_accounting_events WHERE bot_id=$1', [target.botId])).rows.map(r => r.data);
      const epochs = (await c.query('SELECT data FROM phoenix_position_epochs WHERE bot_id=$1 ORDER BY opened_at,epoch_id', [target.botId])).rows.map(r => r.data);
      return { revision: row?.revision ?? 0, status: row?.status ?? 'unknown', origin: row?.origin ?? null,
        snapshot: row?.snapshot ?? null, events, epochs };
    });
  }
  async commit(target: AccountingTarget, expectedRevision: number, next: AccountingState) {
    await this.locked(target, async c => {
      const current = (await c.query('SELECT * FROM phoenix_accounting_state WHERE bot_id=$1', [target.botId])).rows[0];
      if ((current?.revision ?? 0) !== expectedRevision || next.revision !== expectedRevision + 1 || !next.origin || !next.snapshot) throw new Error('Stale accounting commit');
      if (next.status !== 'complete' || next.origin.flat !== true || !next.origin.reference
        || unsigned(next.origin.slot) > unsigned(next.snapshot.slot)
        || (current && orderIntentHash(current.origin) !== orderIntentHash(next.origin))
        || (current && unsigned(current.snapshot.slot) > unsigned(next.snapshot.slot))) throw new Error('Accounting origin/watermark changed');
      phoenixEquity(target, next.snapshot, this.now());
      if (orderIntentHash(reducePhoenixHistory(target, next.events, next.snapshot, this.now())) !== orderIntentHash(next.epochs)) throw new Error('Invalid derived epochs');
      const previousEvents = (await c.query('SELECT data FROM phoenix_accounting_events WHERE bot_id=$1', [target.botId])).rows;
      for (const { data } of previousEvents) {
        const event = next.events.find(e => e.id === data.id);
        if (!event) throw new Error('History lost a durable event');
        enrichEvent(data, event);
      }
      if (next.events.some(e => unsigned(e.slot) < unsigned(next.origin!.slot))) throw new Error('Event precedes origin');
      // U04 receipts do not yet prove a debited, uncredited transit asset. Retain
      // pending claims as unknown instead of adding a guessed amount to equity.
      for (const claim of next.snapshot.inTransit) {
        const operation = (await c.query(`SELECT id FROM phoenix_operations WHERE id=$1 AND bot_id=$2
          AND kind IN ('withdraw','transfer') AND state IN ('submission_pending','queued','unknown')`, [claim.operationId, target.botId])).rows[0];
        if (!operation || claim.valueMicros !== null) throw new Error('Unproven in-transit valuation');
      }
      const registered = await c.query(`SELECT 1 FROM phoenix_operations o JOIN phoenix_operation_attempts a ON a.operation_id=o.id
        WHERE o.bot_id=$1 AND o.kind='register' AND o.state='completed' AND a.signature=$2 AND a.state='confirmed'`,
      [target.botId, next.origin.registrationSignature]);
      if (!registered.rows.length) throw new Error('Accounting origin is not this bot registration');
      for (const e of next.events) {
        await c.query(`INSERT INTO phoenix_accounting_events(bot_id,event_id,data) VALUES($1,$2,$3)
          ON CONFLICT(bot_id,event_id) DO UPDATE SET data=EXCLUDED.data`, [target.botId, e.id, e]);
      }
      const subscribers = (await c.query(`SELECT s.id,s.subscriber_wallet_address,p.creator_wallet_address FROM bot_subscriptions s
        JOIN published_bots p ON p.id=s.published_bot_id WHERE s.subscriber_bot_id=$1`, [target.botId])).rows;
      if (subscribers.length > 1) throw new Error('Ambiguous subscriber provenance');
      const subscriber = subscribers[0];
      const binding = subscriber ? { botId: target.botId, payerWallet: subscriber.subscriber_wallet_address,
        creatorWallet: subscriber.creator_wallet_address, subscriptionId: subscriber.id } : null;
      for (const e of next.epochs) {
        const prior = (await c.query('SELECT payout_provenance FROM phoenix_position_epochs WHERE bot_id=$1 AND epoch_id=$2', [target.botId, e.id])).rows[0];
        const provenance = phoenixPayoutProvenance(target, e, prior ? prior.payout_provenance.subscription : binding);
        await c.query(`INSERT INTO phoenix_position_epochs(bot_id,epoch_id,opened_at,data,payout_provenance) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(bot_id,epoch_id) DO UPDATE SET data=EXCLUDED.data,payout_provenance=EXCLUDED.payout_provenance`,
        [target.botId, e.id, e.openedAt, e, provenance]);
      }
      // Link exact U05 signatures/fills without treating an IOC completion as flat
      // or changing its unresolved submission/cancellation/funding state.
      const orders = (await c.query('SELECT id,data,intent FROM phoenix_order_intents WHERE bot_id=$1', [target.botId])).rows;
      for (const order of orders) {
        const matched = next.events.filter(e => e.signature === order.data.attempt?.signature && e.market === order.intent.market && e.kind !== 'funding');
        if (!matched.length) continue;
        const receiptIds = new Set((order.data.fills ?? []).map((f: { fillId: string }) => f.fillId));
        if (receiptIds.size && [...receiptIds].some(id => !matched.some(e => e.fillId === id))) throw new Error('Order receipt/history fill mismatch');
        const eventIds = matched.map(e => e.id).sort();
        await c.query(`UPDATE phoenix_order_intents SET data=jsonb_set(data,'{accountingEventIds}',$2::jsonb),revision=revision+1
          WHERE id=$1 AND data->'accountingEventIds' IS DISTINCT FROM $2::jsonb`, [order.id, JSON.stringify(eventIds)]);
      }
      const snapshotId = orderIntentHash([target.identity, next.snapshot]);
      await c.query(`INSERT INTO phoenix_equity_snapshots(bot_id,snapshot_hash,data) VALUES($1,$2,$3)
        ON CONFLICT(bot_id,snapshot_hash) DO NOTHING`, [target.botId, snapshotId, next.snapshot]);
      await c.query(`INSERT INTO phoenix_accounting_state(bot_id,revision,status,origin,snapshot) VALUES($1,$2,'complete',$3,$4)
        ON CONFLICT(bot_id) DO UPDATE SET revision=EXCLUDED.revision,status=EXCLUDED.status,origin=EXCLUDED.origin,snapshot=EXCLUDED.snapshot`,
      [target.botId, next.revision, next.origin, next.snapshot]);
    });
  }
  async invalidate(target: AccountingTarget, expectedRevision: number) {
    await this.locked(target, async c => {
      await c.query(`UPDATE phoenix_accounting_state SET status='unknown',revision=revision+1 WHERE bot_id=$1 AND revision=$2`, [target.botId, expectedRevision]);
    });
  }
}
