import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { botTrades, botPositions, tradingBots } from '../../shared/schema';
import type { SubscriberCloseAccounting } from '../../server/trading/subscriber-close-accounting';
import { subscriberCloseAccounting } from '../../server/trading/subscriber-close-accounting';
import { recoverSubscriberCloseEvidence } from '../../server/trading/subscriber-close-recovery';
import type { ProtocolAdapter } from '../../server/protocol/adapter';
import type { CloseSnapshot } from '../../server/protocol/close-outcome';

const holder = vi.hoisted(() => ({ db: undefined as NodePgDatabase | undefined }));
vi.mock('../../server/db', () => ({ pool: {}, db: new Proxy({}, {
  get(_target, name) {
    if (!holder.db) throw new Error('test database unavailable');
    const member = Reflect.get(holder.db, name);
    return typeof member === 'function' ? member.bind(holder.db) : member;
  },
}) }));
// This suite has no durable intents; canonical scope fencing is covered in the isolated intent suite.
vi.mock('../../server/trading/close-intent-store',()=>({closeIntentStore:{guardLinkedSubscriberRepair:(_id:any,_canonical:any,legacy:any)=>legacy()}}));
import { DatabaseStorage } from '../../server/storage';

// FRACTAL supplies the connection. All writes target connection-private TEMP
// tables built from the real Drizzle schema, never the runner's shared tables.
describe('subscriber later evidence repair with real Drizzle/node-postgres', () => {
  let client: Client;
  const store = new DatabaseStorage();
  const accounting: SubscriberCloseAccounting = { version: 1, account: 'EXAMPLE_ACCOUNT', market: 'BTC-PERP',
    orderId: 'EXAMPLE_ORDER', outcome: 'confirmed', size: '0.25', price: '65000', fee: '1', pnl: '249',
    volume: '16250', entryPrice: '64000', fillIds: ['EXAMPLE_FILL'], timestamp: 1, reason: null,
    pnlConvention: 'net_of_close_fee' };
  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
    await client.connect();
    holder.db = drizzle(client);
    for (const table of [botTrades, botPositions, tradingBots]) {
      const config = getTableConfig(table);
      await client.query(`CREATE TEMP TABLE "${config.name}" (${config.columns.map(c => `"${c.name}" ${c.getSQLType()}`).join(',')})`);
    }
  });
  afterAll(async () => { await client?.end(); });
  beforeEach(async () => {
    await client.query('TRUNCATE pg_temp.bot_trades, pg_temp.bot_positions, pg_temp.trading_bots');
    await client.query(`INSERT INTO pg_temp.trading_bots (id, stats) VALUES ('EXAMPLE_BOT', $1::jsonb)`,
      [JSON.stringify({ totalPnl: 4, totalVolume: 200 })]);
    await client.query(`INSERT INTO pg_temp.bot_positions
      (id, trading_bot_id, market, base_size, avg_entry_price, cost_basis, realized_pnl, total_fees, last_trade_id)
      VALUES ('EXAMPLE_POSITION', 'EXAMPLE_BOT', 'BTC-PERP', 3, 99, 297, 4, 1, 'EXAMPLE_NEW_EPOCH')`);
    await client.query(`INSERT INTO pg_temp.bot_trades
      (id, trading_bot_id, market, side, size, price, pnl, fee, status, tx_signature, protocol_fill_id, pnl_convention, webhook_payload)
      VALUES ('EXAMPLE_CLOSE', 'EXAMPLE_BOT', 'BTC-PERP', 'CLOSE', 0, 0, NULL, NULL, 'recovered',
      'EXAMPLE_ORDER', 'tx-EXAMPLE_RECONCILER', 'net_of_close_fee', $1::jsonb)`,
      [JSON.stringify({ closeAccounting: { kind: 'unavailable', reason: 'missing_history' } })]);
  });
  const repair = (value = accounting) => store.remediateSubscriberCloseAccountingAtomic({
    botId: 'EXAMPLE_BOT', tradeId: 'EXAMPLE_CLOSE', accounting: value,
  });
  it('repairs a reconciler-first close once and retains canonical identity and reopened exposure', async () => {
    const first = await repair();
    expect(first.remediated).toBe(true);
    expect(first.trade.protocolFillId).toBe('tx-EXAMPLE_RECONCILER');
    expect(Number(first.trade.pnl)).toBe(249);
    expect(Number(first.trade.fee)).toBe(1);
    expect(Number(first.trade.size)).toBe(0.25);
    expect((await repair()).remediated).toBe(false);
    const { rows: [position] } = await client.query('SELECT * FROM pg_temp.bot_positions');
    expect(Number(position.realized_pnl)).toBe(253);
    expect(Number(position.total_fees)).toBe(2);
    expect(Number(position.base_size)).toBe(3);
    expect(position.last_trade_id).toBe('EXAMPLE_NEW_EPOCH');
    const { rows: [bot] } = await client.query('SELECT stats FROM pg_temp.trading_bots');
    expect(bot.stats).toMatchObject({ totalPnl: 253, totalVolume: 16450, winningTrades: 1, totalTrades: 1 });
  });
  it('rejects conflicting evidence after the first repair', async () => {
    await repair();
    await expect(repair({ ...accounting, pnl: '250' })).rejects.toThrow('conflicting exact');
  });
  it('discovers delayed evidence durably and repairs the canonical row exactly once after restart', async () => {
    const now = Date.now();
    const baseline: CloseSnapshot = { positions: [{ internalSymbol: 'BTC-PERP', baseSize: 0.25,
      entryPrice: 64000, markPrice: null, unrealizedPnl: null, leverage: 2, liquidationPrice: null, marginMode: 'cross' }],
      evidence: { account: 'EXAMPLE_ACCOUNT', environment: 'EXAMPLE', requestId: 'EXAMPLE_SNAPSHOT',
        startedAt: now - 200, dispatchedAt: now - 200, receivedAt: now - 100, lastOrderId: 1,
        complete: true, fresh: true, noDedup: true } };
    const pending = subscriberCloseAccounting({ account: 'EXAMPLE_ACCOUNT', market: 'BTC-PERP',
      orderId: 'EXAMPLE_ORDER', openSide: 'long', requestedSize: 0.25, sentAt: now - 100, observedAt: now,
      baseline, closeResult: { outcome: 'confirmed', account: 'EXAMPLE_ACCOUNT', market: 'BTC-PERP',
        baseline: baseline.evidence, reason: 'qualified_flat_observation' }, trades: [] });
    // The reconciler won first; the submitting route attaches its durable
    // strict outcome to that same row while fills are still delayed.
    expect((await repair(pending)).remediated).toBe(false);
    expect((await store.getSubscriberCloseAccountingCandidates('EXAMPLE_BOT')).length).toBe(1);
    const placeMarketOrder = vi.fn();
    const getTradeHistory = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([{
      tradeId: 'EXAMPLE_FILL', orderId: 'EXAMPLE_ORDER', internalSymbol: 'BTC-PERP', side: 'short',
      price: 65000, size: 0.25, fee: 1, timestamp: now,
    }]);
    const adapter = { protocolName: 'pacifica', getTradeHistory, placeMarketOrder } as unknown as ProtocolAdapter;
    const recover = () => recoverSubscriberCloseEvidence({ botId: 'EXAMPLE_BOT', account: 'EXAMPLE_ACCOUNT',
      adapter, storage: new DatabaseStorage() });
    expect(await recover()).toBe(0);
    expect(await recover()).toBe(1);
    expect(await recover()).toBe(0);
    expect(await store.getSubscriberCloseAccountingCandidates('EXAMPLE_BOT')).toEqual([]);
    const { rows: [trade] } = await client.query('SELECT * FROM pg_temp.bot_trades');
    expect(trade.id).toBe('EXAMPLE_CLOSE');
    expect(trade.protocol_fill_id).toBe('tx-EXAMPLE_RECONCILER');
    expect(Number(trade.pnl)).toBe(249);
    expect(trade.webhook_payload.subscriberShareEligibility).toMatchObject({ eligible: true,
      canonicalFillId: 'tx-EXAMPLE_RECONCILER' });
    const { rows: [position] } = await client.query('SELECT * FROM pg_temp.bot_positions');
    expect(Number(position.realized_pnl)).toBe(253);
    expect(Number(position.base_size)).toBe(3);
    expect(placeMarketOrder).not.toHaveBeenCalled();
  });
  it('does not attach an unrelated order to a fuzzy reconciler winner', async () => {
    expect((await repair({ ...accounting, orderId: 'EXAMPLE_OTHER' })).remediated).toBe(false);
    const { rows: [trade] } = await client.query('SELECT pnl FROM pg_temp.bot_trades');
    expect(trade.pnl).toBeNull();
  });
  it('rejects partial accounting and rolls back a repair if the owning position is absent', async () => {
    await expect(repair({ ...accounting, outcome: 'partial' })).rejects.toThrow('exact confirmed');
    await client.query('TRUNCATE pg_temp.bot_positions');
    await expect(repair()).rejects.toThrow('position missing');
    const { rows: [trade] } = await client.query('SELECT pnl FROM pg_temp.bot_trades');
    expect(trade.pnl).toBeNull();
  });
});
