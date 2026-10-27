import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { getTableColumns } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { botTrades, botPositions, tradingBots, botSubscriptions, publishedBots, pendingProfitShares } from '../../shared/schema';
import { SignalBotCloseIntentStorage } from '../../server/trading/signal-bot-close-intent-storage';
import { probeSchemaMigrationManifest } from '../../server/schema-readiness-probe';
import { readDbSchemaMigrationManifest } from '../helpers/schema-migration-manifest';
import { newIntent, snapshot, orders } from '../helpers/close-intent-fixtures';
import type { CloseIntent, CloseScope } from '../../server/trading/signal-bot-close-intent-types';
vi.mock('../../server/vault/auto-repark',()=>({maybeScheduleAutoRepark:vi.fn(async()=>{})}));
vi.mock('../../server/notification-service',()=>({sendTradeNotification:vi.fn(async()=>true)}));
const holder = vi.hoisted(() => ({ store: undefined as any, pool: undefined as any }));
vi.mock('../../server/trading/close-intent-store', () => ({ get closeIntentStore() { return holder.store; } }));
vi.mock('../../server/db', async () => { const { drizzle } = await import('drizzle-orm/node-postgres'); return { get pool() { return holder.pool; }, get db() { return drizzle(holder.pool); } }; });

import { submitDurableClose } from '../../server/trading/signal-bot-close-intent';
import { observeCloseIntent, registerCloseWorkerDependencies, runCloseIntentWorkerPass } from '../../server/trading/signal-bot-close-intent-worker';

describe.skipIf(!process.env.DATABASE_URL)('durable close intents on isolated PostgreSQL', () => {
  const schema = 'close_intent_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  let pool: Pool, store: SignalBotCloseIntentStorage;
  const trade = { tradingBotId: 'EXAMPLE_BOT', walletAddress: 'EXAMPLE_OWNER', market: 'BTC-PERP', side: 'CLOSE', size: '1', price: '100' };
  const migration = readDbSchemaMigrationManifest().manifest.find(row => row.id.startsWith('206-'))!;
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}`, max: 5 });
    const columns = Object.values(getTableColumns(botTrades)).map(column => `"${column.name}" ${column.getSQLType()}${column.name === 'id' ? ' PRIMARY KEY DEFAULT gen_random_uuid()' : column.name === 'executed_at' ? ' DEFAULT now()' : ''}`);
    await pool.query(`CREATE TABLE bot_trades (${columns.join(',')})`);
    holder.pool = pool;
    for (const [name, table] of [['trading_bots', tradingBots], ['bot_positions', botPositions], ['bot_subscriptions', botSubscriptions], ['published_bots', publishedBots], ['pending_profit_shares', pendingProfitShares]] as const) {
      const cols = Object.values(getTableColumns(table)).map(c => `"${c.name}" ${c.getSQLType()}${c.name === 'id' ? ' PRIMARY KEY DEFAULT gen_random_uuid()' : ''}`);
      await pool.query(`CREATE TABLE ${name} (${cols.join(',')})`);
    }
    await pool.query('CREATE UNIQUE INDEX ON pending_profit_shares(subscriber_bot_id,trade_id)');
    await pool.query('CREATE TABLE wallets(address text PRIMARY KEY,agent_public_key text)');
    await pool.query('CREATE UNIQUE INDEX ON bot_positions(trading_bot_id,market)');
    await pool.query(migration.sql);
    store = new SignalBotCloseIntentStorage(pool); holder.store = store;
    vi.spyOn(store, 'ready').mockResolvedValue();
  });
  afterAll(async () => { await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); });
  beforeEach(async () => { vi.clearAllMocks(); await pool.query('TRUNCATE signal_bot_close_intents,bot_trades,bot_positions,trading_bots,wallets,bot_subscriptions,published_bots,pending_profit_shares'); });
  const scope = <T>(work: (s: CloseScope) => Promise<T>, market = 'BTC-PERP') => store.withScope('EXAMPLE', 'EXAMPLE_ACCOUNT', market, work);
  async function create(s: CloseScope, source?: string) { return (await store.create(s, newIntent(source), trade)).intent!; }
  async function admit(s: CloseScope, row: CloseIntent, timestamp?: number) {
    const now = timestamp ?? await store.databaseTime(s);
    return store.admit(s, row, { attemptId: randomUUID(), timestamp: now, expiry_window: 5000, admittedAt: now });
  }
  const deps = (size = '1', watermark = 7) => ({
    adapter: vi.fn(() => ({ protocolName: 'pacifica', getCloseEnvironment: () => 'EXAMPLE', getCloseConfirmationSnapshot: vi.fn(async () => snapshot(size, watermark)),
      sendPreparedReduceOnlyMarketOrder: vi.fn(), getCloseOpenOrders: vi.fn() }) as any),
    epochUnchanged: vi.fn(async () => true), signer: vi.fn(async () => null), account: vi.fn(async () => {}),
  });
  it('accepts the actual manifest and rejects a missing trigger or broadened due predicate', async () => {
    const query = (text: string, values?: readonly unknown[]) => pool.query(text.replaceAll("'public'", `'${schema}'`), values?.map(v => typeof v === 'string' ? v.replace(/^public\./, schema + '.') : v));
    const result = await probeSchemaMigrationManifest(query, [migration]);
    if (result.evidence.length) {
      const definitions = await pool.query("SELECT conname,pg_get_constraintdef(oid,true) AS definition FROM pg_constraint WHERE conrelid='signal_bot_close_intents'::regclass ORDER BY conname");
      console.log('EXAMPLE catalog mismatches', JSON.stringify(result.evidence));
      console.log('EXAMPLE close constraints', JSON.stringify(definitions.rows));
    }
    expect(result.unavailableCapabilities).toEqual([]);
    await pool.query('ALTER TABLE signal_bot_close_intents DISABLE TRIGGER sb_close_preserve_identity_trigger');
    expect((await probeSchemaMigrationManifest(query, [migration])).unavailableCapabilities).toEqual(['signal_bot_close_intent']);
    await pool.query('ALTER TABLE signal_bot_close_intents ENABLE TRIGGER sb_close_preserve_identity_trigger');
    await pool.query('DROP INDEX sb_close_due_idx');
    await pool.query("CREATE INDEX sb_close_due_idx ON signal_bot_close_intents(next_action_at,id) WHERE status IN ('pending','needs_user','released')");
    expect((await probeSchemaMigrationManifest(query, [migration])).unavailableCapabilities).toEqual(['signal_bot_close_intent']);
    await pool.query('DROP INDEX sb_close_due_idx');
    await pool.query("CREATE INDEX sb_close_due_idx ON signal_bot_close_intents(next_action_at,id) WHERE status IN ('pending','needs_user')");
  });
  it('owner DDL validates the schema it creates despite a different caller search path and rejects a changed CHECK', async () => {
    const ddl = readFileSync(new URL('../fixtures/owner-close-intent-ddl-r3.sql', import.meta.url), 'utf8')
      .replaceAll('public.', schema + '.').replaceAll("'public'", "'" + schema + "'").replace('search_path = public,', 'search_path = ' + schema + ',');
    expect(ddl.split('\n').filter(line => /CHECK/i.test(line) && /CASE/i.test(line))).toEqual([]);
    const client = await pool.connect();
    try {
      await client.query('SET search_path = pg_catalog');
      await client.query(ddl); await client.query(ddl);
      await client.query(`ALTER TABLE ${schema}.signal_bot_close_intents DROP CONSTRAINT sb_close_protocol_check`);
      await client.query(`ALTER TABLE ${schema}.signal_bot_close_intents ADD CONSTRAINT sb_close_protocol_check CHECK (protocol IN ('pacifica','EXAMPLE'))`);
      await expect(client.query(ddl)).rejects.toThrow('constraint mismatch');
      await client.query('ROLLBACK');
    } finally {
      await client.query('ROLLBACK');
      await client.query(`ALTER TABLE ${schema}.signal_bot_close_intents DROP CONSTRAINT IF EXISTS sb_close_protocol_check`);
      await client.query(`ALTER TABLE ${schema}.signal_bot_close_intents ADD CONSTRAINT sb_close_protocol_check CHECK (protocol = 'pacifica')`);
      await client.query(`SET search_path = ${schema}`); client.release();
    }
  });
  it('deduplicates source and unresolved scope without an orphan pending trade', async () => {
    await scope(async s => {
      const row = await create(s, 'EXAMPLE_SOURCE');
      expect((await store.create(s, newIntent('EXAMPLE_SOURCE'), trade)).intent.id).toBe(row.id);
      expect((await store.create(s, newIntent('EXAMPLE_NEW_CLICK'), trade)).intent.id).toBe(row.id);
      expect((await pool.query('SELECT count(*)::int AS n FROM bot_trades')).rows[0].n).toBe(1);
    });
  });
  it('rolls back the trade when an insert conflicts outside this scope', async () => {
    let first: CloseIntent;
    await scope(async s => { first = await create(s); });
    await store.withScope('EXAMPLE', 'EXAMPLE_OTHER', 'BTC-PERP', async s => {
      const input = { ...newIntent(), original_account: s.account, signer_public_key: s.account, client_order_id: first!.client_order_id };
      input.request_payload = { ...input.request_payload, account: s.account, client_order_id: first!.client_order_id };
      await expect(store.create(s, input, trade)).rejects.toThrow();
    });
    expect((await pool.query('SELECT count(*)::int AS n FROM bot_trades')).rows[0].n).toBe(1);
  });
  it('commits the immutable admitted header before sign and survives a new storage instance', async () => {
    let admitted: CloseIntent;
    await scope(async s => {
      admitted = await admit(s, await create(s));
      const other = new SignalBotCloseIntentStorage(pool);
      expect((await pool.query('SELECT attempt_log FROM signal_bot_close_intents WHERE id=$1', [admitted.id])).rows[0].attempt_log).toEqual(admitted.attempt_log);
      await expect(store.mutate(s, admitted, { attempt_log: [{ ...admitted.attempt_log[0], timestamp: 1 }] })).rejects.toThrow('immutable');
    });
    await scope(async s => {
      const restarted = (await store.byId(s, admitted!.id))!; const d = deps();
      await observeCloseIntent(s, restarted, d);
      expect(d.signer).not.toHaveBeenCalled();
      expect((await store.byId(s, restarted.id))!.attempt_log).toEqual(admitted!.attempt_log);
    });
  });
  it('increments once for each CAS, conflict update and batch update, and rejects a stale revision', async () => {
    await scope(async s => {
      const first = await create(s); const updated = await store.mutate(s, first, { last_error_code: 'EXAMPLE' });
      expect(BigInt(updated.revision)).toBe(BigInt(first.revision) + 1n);
      await expect(store.mutate(s, first, { last_error_code: 'EXAMPLE_STALE' })).rejects.toThrow('revision_conflict');
      await pool.query('UPDATE signal_bot_close_intents SET revision=revision+1,last_error_code=$1', ['EXAMPLE_BATCH']);
      const conflict = await pool.query("INSERT INTO signal_bot_close_intents SELECT * FROM signal_bot_close_intents WHERE id=$1 ON CONFLICT(id) DO UPDATE SET revision=signal_bot_close_intents.revision+1 RETURNING revision", [first.id]);
      expect(BigInt(conflict.rows[0].revision)).toBe(BigInt(first.revision) + 3n);
      await expect(pool.query('UPDATE signal_bot_close_intents SET last_error_code=$1', ['EXAMPLE_BAD'])).rejects.toThrow('revision');
    });
  });
  it('excludes released rows from due and unresolved and forbids reopening or deletion', async () => {
    await scope(async s => {
      let row = await create(s); row = await store.mutate(s, row, { status: 'needs_user' });
      row = await store.settle(s, row, { status: 'released', release_mode: 'not_sent', completed_at: new Date() }, async client => { await client.query("UPDATE bot_trades SET status='failed',error_message='close_not_sent' WHERE id=$1", [row.original_trade_id]); });
      expect(await store.unresolved(s)).toBeUndefined(); expect(await store.due()).toEqual([]);
      await expect(pool.query("UPDATE signal_bot_close_intents SET status='pending',completed_at=NULL,release_mode=NULL,revision=revision+1 WHERE id=$1", [row.id])).rejects.toThrow('Terminal');
      await expect(pool.query('DELETE FROM signal_bot_close_intents WHERE id=$1', [row.id])).rejects.toThrow('retained');
      expect((await create(s)).id).not.toBe(row.id);
    });
  });
  it('requires fresh independent venue-clock reads and no live market before committing release', async () => {
    await scope(async s => {
      const row = await admit(s, await create(s), Date.now() - 400000);
      const d = deps(); const adapter = d.adapter();
      d.adapter.mockReturnValue(adapter);
      adapter.getCloseOpenOrders.mockImplementation(async () => orders());
      adapter.getCloseConfirmationSnapshot.mockImplementation(async () => {
        const value = snapshot(); delete value.evidence.venueClockMs; return value;
      });
      await observeCloseIntent(s, row, d);
      expect((await store.byId(s,row.id))!.status).toBe('pending'); expect(d.account).not.toHaveBeenCalled();
      adapter.getCloseConfirmationSnapshot.mockImplementation(async () => snapshot());
      adapter.getCloseOpenOrders.mockImplementation(async () => ({...orders(),orders:[{market:'BTC-PERP',orderType:'market'}]}));
      await observeCloseIntent(s, (await store.byId(s,row.id))!, d);
      expect((await store.byId(s,row.id))!.status).toBe('pending'); expect(d.account).not.toHaveBeenCalled();
      adapter.getCloseOpenOrders.mockImplementation(async () => ({...orders(),orders:[{market:'BTC-PERP',orderType:'stop_loss_market'}]}));
      await observeCloseIntent(s, (await store.byId(s,row.id))!, d);
      expect((await store.byId(s,row.id))!).toMatchObject({status:'released',release_mode:'still_open'});
      expect(d.account).toHaveBeenCalledTimes(1); expect(await store.unresolved(s)).toBeUndefined();
    });
  });
  it('rolls back settlement when canonical accounting fails', async () => {
    await scope(async s => { const row = await create(s);
      await expect(store.settle(s, row, { status: 'released', release_mode: 'not_sent', completed_at: new Date() }, async () => { throw new Error('EXAMPLE_ROLLBACK'); })).rejects.toThrow('EXAMPLE_ROLLBACK');
      expect((await store.byId(s, row.id))!.status).toBe('pending');
    });
  });
  it.each(['inactive','missing'])('observes the original account after restart with an %s bot', async _state => {
    await scope(async s => { const row = await admit(s, await create(s)); const d = deps(); d.epochUnchanged.mockResolvedValue(false);
      await observeCloseIntent(s, row, d);
      expect(d.adapter.mock.results[0].value.getCloseConfirmationSnapshot).toHaveBeenCalledWith('EXAMPLE_ACCOUNT');
      expect(d.signer).not.toHaveBeenCalled(); expect((await store.byId(s, row.id))!.status).toBe('needs_user');
    });
  });
  it('a same-size reopen with watermark advancement cannot authorize retry', async () => {
    await scope(async s => { let row = await admit(s, await create(s), Date.now() - 40000);
      row = await store.mutate(s, row, { dispatch_state: 'proven_not_landed', attempt_log: [{ ...row.attempt_log[0], outcome: { kind: 'not_entered', cause: 'ENOTFOUND' }, receivedAt: Date.now() - 31000 }] });
      const d = deps('1', 8); await observeCloseIntent(s, row, d);
      expect(d.signer).not.toHaveBeenCalled(); expect((await store.byId(s, row.id))!.status).toBe('needs_user');
    });
  });
  it('a busy session lock makes a restarted worker skip, while opens remain blocked', async () => {
    let release!: () => void, entered!: () => void;
    const arrived = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = scope(async s => { await create(s); entered(); await gate; });
    await arrived;
    try {
      expect(await store.withScope('EXAMPLE','EXAMPLE_ACCOUNT','BTC-PERP', async () => 'unsafe', true)).toBeUndefined();
    } finally { release(); await held; }
    const send = vi.fn(); await expect(store.withOpenFence('EXAMPLE','EXAMPLE_ACCOUNT','BTC-PERP', send)).rejects.toThrow('prior_close');
    expect(send).not.toHaveBeenCalled();
  });
  it.each(['webhook_partial','user_partial','subscriber_partial'])('%s creates one partial row before the market send', async family => {
    let prepared = false;
    const adapter = { protocolName: 'pacifica', getCloseEnvironment: () => 'EXAMPLE', getCloseConfirmationSnapshot: async () => snapshot(),
      prepareReduceOnlyMarketOrder: vi.fn(async (p: any) => {
        expect((await pool.query('SELECT count(*)::int AS n FROM signal_bot_close_intents')).rows[0].n).toBe(0); prepared = true;
        return { account: p.agentPublicKey, environment: 'EXAMPLE', market: 'BTC-PERP', operationData: { symbol: 'BTC', amount: '0.25', side: 'ask', reduce_only: true, client_order_id: p.clientOrderId } };
      }),
      sendPreparedReduceOnlyMarketOrder: vi.fn(async (_p: any, a: any) => {
        expect(prepared).toBe(true);
        const durable = (await pool.query('SELECT * FROM signal_bot_close_intents')).rows[0];
        expect(durable.attempt_log[0].timestamp).toBe(a.timestamp); expect(durable.request_payload.amount).toBe('0.25');
        expect((await pool.query('SELECT count(*)::int AS n FROM bot_trades')).rows[0].n).toBe(1);
        return { kind: 'acknowledged', orderId: 'EXAMPLE_ORDER' };
      }) } as any;
    const result = await submitDurableClose({ adapter, params: { agentPublicKey: 'EXAMPLE_ACCOUNT', agentSecretKey: new Uint8Array(), mainWalletAddress: 'EXAMPLE_OWNER', internalSymbol: 'BTC-PERP', side: 'short', sizeBase: 0.25, reduceOnly: true },
      identity: { owner_wallet: 'EXAMPLE_OWNER', bot_id: 'EXAMPLE_BOT', source_key: family, signer_mode: 'external_key', authority_ref: { mode: 'EXAMPLE' }, baseSize: '1', lastTradeId: 'EXAMPLE_ENTRY' }, trade, kind: 'partial', positionSide: 'long' });
    expect(result.intent.close_kind).toBe('partial'); expect(adapter.sendPreparedReduceOnlyMarketOrder).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT side,webhook_payload FROM bot_trades')).rows[0]).toMatchObject({ side: 'short', webhook_payload: { partialClose: true } });
  });
  it('an admitted sender loses authority after its session lock is lost and another pass releases', async () => {
    await scope(async s => {
      const row = await admit(s, await create(s), Date.now() - 400000);
      await store.transaction(s, async client => { await client.query('SELECT pg_advisory_unlock_all()'); });
      await scope(async other => {
        const current = (await store.byId(other, row.id))!;
        await store.settle(other, current, { status: 'released', release_mode: 'still_open', completed_at: new Date() }, async () => {});
      });
      await expect(store.assertSendAuthorized(s, row)).rejects.toThrow('close_send_authority_lost');
    });
  });
  it.each(['webhook_partial','user_partial','subscriber_partial'])('%s completes the SAME row and money once through the real atomic finalizer', async family => {
    const { DatabaseStorage } = await import('../../server/storage');
    const writer = new DatabaseStorage();
    await pool.query("INSERT INTO trading_bots(id,wallet_address,active_protocol,stats) VALUES('EXAMPLE_BOT','EXAMPLE_OWNER','pacifica','{}')");
    await pool.query("INSERT INTO bot_positions(trading_bot_id,wallet_address,market,base_size,avg_entry_price,realized_pnl,total_fees,last_trade_id) VALUES('EXAMPLE_BOT','EXAMPLE_OWNER','BTC-PERP',1,100,0,0,'EXAMPLE_ENTRY')");
    let row!: CloseIntent;
    await scope(async s => {
      const input = { ...newIntent(family), close_kind: 'partial' as const, requested_size_base: '0.25' };
      input.request_payload.amount = '0.25';
      row = (await store.create(s, input, { ...trade, side: 'short', size: '0.25', webhookPayload: { partialClose: true } })).intent;
      row = await store.mutate(s, row, { last_evidence: { objectiveMet: true } });
    });
    const event = { botId: 'EXAMPLE_BOT', update: { tradeId: row.original_trade_id, fields: { status: 'executed', pnl: '24', fee: '1', protocolFillId: 'EXAMPLE_FILL', webhookPayload: { partialClose: true, partialCloseAccounting: { status: 'complete' } } } },
      deltas: { totalPnlDelta: 24, totalVolumeDelta: 25 }, confirmedPositionReduction: { market: 'BTC-PERP', expectedBaseSize: '1', expectedLastTradeId: 'EXAMPLE_ENTRY', residualBaseSize: 0.75, residualEntryPrice: 100, realizedPnlDelta: 24, feeDelta: 1 } };
    // Legacy consumers cannot promote an intent, even with a claimed objective.
    expect((await writer.recordCloseEventAtomic(event)).isNew).toBe(false);
    await scope(async s=>{
      const current=(await store.byId(s,row.id))!;
      const confirmed={...current,last_evidence:{after:snapshot('0.75',8)}};
      const {accountDurableClose}=await import('../../server/trading/signal-bot-close-intent-accounting');
      await store.settle(s,current,{status:'confirmed',completed_at:new Date(await store.databaseTime(s))},client=>accountDurableClose(client,confirmed,'confirmed',{fillPrice:100,filledSize:0.25,fee:1,realizedPnl:25,fillTimestampMs:Date.now()} as any));
    });
    expect((await writer.recordCloseEventAtomic(event)).isNew).toBe(false);
    expect((await pool.query('SELECT count(*)::int AS n FROM bot_trades')).rows[0].n).toBe(1);
    expect((await pool.query('SELECT status FROM signal_bot_close_intents')).rows[0].status).toBe('confirmed');
    expect((await pool.query('SELECT base_size,realized_pnl,total_fees FROM bot_positions')).rows[0]).toMatchObject({ base_size: '0.75000000', realized_pnl: '24.000000', total_fees: '1.000000' });
    expect((await pool.query('SELECT stats FROM trading_bots')).rows[0].stats).toMatchObject({ totalPnl: 24, totalVolume: 25, totalTrades: 0 });
  });

  it('a pending partial cannot lend its outcome or money to a full request', async () => {
    await pool.query("INSERT INTO bot_positions(trading_bot_id,wallet_address,market,base_size,avg_entry_price,realized_pnl,total_fees) VALUES('EXAMPLE_BOT','EXAMPLE_OWNER','BTC-PERP',1,100,0,0)");
    await scope(async s => {
      const input = newIntent('EXAMPLE_PARTIAL');
      await store.create(s, { ...input, close_kind: 'partial', requested_size_base: '0.5', request_payload: { ...input.request_payload, amount: '0.5' } }, { ...trade, size: '0.5' });
    });
    const send = vi.fn(), prepare = vi.fn();
    await expect(submitDurableClose({ adapter: { getCloseEnvironment: () => 'EXAMPLE', prepareReduceOnlyMarketOrder: prepare, sendPreparedReduceOnlyMarketOrder: send } as any,
      params: { agentPublicKey: 'EXAMPLE_ACCOUNT', internalSymbol: 'BTC-PERP', sizeBaseExact: '1' } as any,
      identity: {} as any, trade, kind: 'full', positionSide: 'long' })).rejects.toThrow('already in progress');
    expect(send).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
    expect((await pool.query('SELECT base_size,realized_pnl,total_fees FROM bot_positions')).rows[0]).toMatchObject({ base_size: '1.00000000', realized_pnl: '0.000000', total_fees: '0.000000' });
    expect((await pool.query('SELECT status FROM bot_trades')).rows).toEqual([{status:'pending'}]);
    expect((await pool.query('SELECT count(*)::int AS n FROM pending_profit_shares')).rows[0].n).toBe(0);
  });
  it('blocks a legacy pending close on the same account/market, reports attention, and unblocks after reconciliation', async () => {
    await pool.query("INSERT INTO trading_bots(id,wallet_address,active_protocol,protocol_subaccount_id,stats) VALUES('EXAMPLE_BOT','EXAMPLE_OWNER','pacifica','EXAMPLE_ACCOUNT','{}')");
    const legacy = await pool.query("INSERT INTO bot_trades(trading_bot_id,wallet_address,market,side,size,price,status) VALUES('EXAMPLE_BOT','EXAMPLE_OWNER','BTC-PERP','CLOSE','1','0','pending') RETURNING id");
    const send = vi.fn();
    await expect(store.withOpenFence('EXAMPLE','EXAMPLE_ACCOUNT','BTC-PERP',send)).rejects.toThrow('prior_close');
    await scope(async s => { expect(await store.hasLegacyPending(s)).toBe(true); });
    expect(await store.statusForBot('EXAMPLE_OWNER','EXAMPLE_BOT')).toMatchObject({ unresolved: true, tradeId: legacy.rows[0].id });
    expect(send).not.toHaveBeenCalled();
    await pool.query("UPDATE bot_trades SET status='executed' WHERE id=$1",[legacy.rows[0].id]);
    await store.withOpenFence('EXAMPLE','EXAMPLE_ACCOUNT','BTC-PERP',send);
    expect(send).toHaveBeenCalledOnce();
  });
  it('rejects changing an already recorded outcome or receipt time', async () => {
    await scope(async s => {
      let row = await admit(s,await create(s));
      row = await store.outcome(s,row,row.attempt_log[0].attemptId,{kind:'not_entered',cause:'ENOTFOUND'});
      await expect(store.mutate(s,row,{attempt_log:[{...row.attempt_log[0],outcome:{kind:'acknowledged',orderId:'EXAMPLE_ORDER'}}]})).rejects.toThrow('Recorded close outcome is immutable');
      await expect(store.mutate(s,row,{attempt_log:[{...row.attempt_log[0],receivedAt:row.attempt_log[0].receivedAt!+1}]})).rejects.toThrow('Recorded close outcome is immutable');
    });
  });
  it.each([true,false])('serializes request/worker confirmation and repairs delayed attributable money exactly once (fill initially available: %s)', async available => {
    await pool.query("INSERT INTO trading_bots(id,wallet_address,active_protocol,stats) VALUES('EXAMPLE_BOT','EXAMPLE_OWNER','pacifica','{}')");
    await pool.query("INSERT INTO bot_positions(trading_bot_id,wallet_address,market,base_size,avg_entry_price,cost_basis,realized_pnl,total_fees,last_trade_id) VALUES('EXAMPLE_BOT','EXAMPLE_OWNER','BTC-PERP',1,100,100,0,0,'EXAMPLE_ENTRY')");
    await pool.query("INSERT INTO published_bots(id,creator_wallet_address,profit_share_percent) VALUES('EXAMPLE_PUBLISHED','EXAMPLE_CREATOR',10)");
    await pool.query("INSERT INTO bot_subscriptions(published_bot_id,subscriber_bot_id,status) VALUES('EXAMPLE_PUBLISHED','EXAMPLE_BOT','active')");
    let active=0,peak=0;const acquire=()=>{peak=Math.max(peak,++active);},returned=()=>{active--;};
    pool.on('acquire',acquire);pool.on('release',returned);
    let entered!:()=>void,release!:()=>void,reads=0,fillAvailable=available;
    const arrived=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
    const adapter={protocolName:'pacifica',getCloseEnvironment:()=> 'EXAMPLE',
      prepareReduceOnlyMarketOrder:async(p:any)=>({account:'EXAMPLE_ACCOUNT',environment:'EXAMPLE',market:'BTC-PERP',operationData:{symbol:'BTC',side:'ask',amount:'1',reduce_only:true,client_order_id:p.clientOrderId}}),
      sendPreparedReduceOnlyMarketOrder:vi.fn(async()=>{entered();await gate;return {kind:'acknowledged',orderId:'EXAMPLE_ORDER'};}),
      getCloseConfirmationSnapshot:vi.fn(async()=>snapshot(++reads===1?'1':'0',reads===1?7:8)),
      getTradeHistory:vi.fn(async(_account:any,options:any)=>fillAvailable?[{tradeId:'EXAMPLE_FILL',orderId:'EXAMPLE_ORDER',internalSymbol:'BTC-PERP',side:'short',venueEventKind:'close_long',size:1,price:125,fee:1,realizedPnl:25,timestamp:options.startTime,subaccountId:'EXAMPLE_ACCOUNT'}]:[])} as any;
    const {accountDurableClose}=await import('../../server/trading/signal-bot-close-intent-accounting');
    registerCloseWorkerDependencies({adapter:()=>adapter,epochUnchanged:async()=>true,signer:async()=>null,account:accountDurableClose});
    const pending=submitDurableClose({adapter,params:{agentPublicKey:'EXAMPLE_ACCOUNT',agentSecretKey:new Uint8Array(),mainWalletAddress:'EXAMPLE_OWNER',internalSymbol:'BTC-PERP',side:'short',sizeBase:1,sizeBaseExact:'1',reduceOnly:true},identity:{owner_wallet:'EXAMPLE_OWNER',bot_id:'EXAMPLE_BOT',source_key:'EXAMPLE_RACE',signer_mode:'external_key',authority_ref:{mode:'EXAMPLE'},baseSize:'1',lastTradeId:'EXAMPLE_ENTRY'},trade,kind:'full',positionSide:'long'});
    await arrived;
    try { await runCloseIntentWorkerPass();expect(adapter.getCloseConfirmationSnapshot).toHaveBeenCalledTimes(1); }
    finally { release(); }
    const result=await pending;
    expect(result.intent.status).toBe('confirmed');expect(adapter.sendPreparedReduceOnlyMarketOrder).toHaveBeenCalledOnce();
    let money=(await pool.query('SELECT realized_pnl,total_fees,base_size FROM bot_positions')).rows[0];
    expect(money).toMatchObject({base_size:'0.00000000',realized_pnl:available?'24.000000':'0.000000',total_fees:available?'1.000000':'0.000000'});
    if(!available){
      expect((await pool.query('SELECT webhook_payload FROM bot_trades')).rows[0].webhook_payload.closeAccounting.kind).toBe('unavailable');
      fillAvailable=true;await pool.query('UPDATE signal_bot_close_intents SET revision=revision+1,next_action_at=clock_timestamp()');await runCloseIntentWorkerPass();await runCloseIntentWorkerPass();
    }
    money=(await pool.query('SELECT realized_pnl,total_fees FROM bot_positions')).rows[0];
    expect(money).toMatchObject({realized_pnl:'24.000000',total_fees:'1.000000'});
    expect((await pool.query('SELECT stats FROM trading_bots')).rows[0].stats).toMatchObject({totalPnl:24,totalVolume:125});
    expect((await pool.query('SELECT count(*)::int AS n FROM bot_trades')).rows[0].n).toBe(1);
    expect((await pool.query('SELECT amount,status FROM pending_profit_shares')).rows).toEqual([{amount:'2.400000',status:'deferred'}]);
    pool.removeListener('acquire',acquire);pool.removeListener('release',returned);expect(peak).toBeLessThanOrEqual(2);
  });

  it('waits for a held fence, then allows the open instead of a spurious busy refusal', async()=>{
    let entered!:()=>void,release!:()=>void;
    const arrived=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
    const held=scope(async()=>{entered();await gate;});await arrived;
    const send=vi.fn(async()=> 'EXAMPLE_OPEN');
    const opening=store.withOpenFence('EXAMPLE','EXAMPLE_ACCOUNT','BTC-PERP',send);
    const timer=setTimeout(release,50);
    try {expect(await opening).toBe('EXAMPLE_OPEN');expect(send).toHaveBeenCalledOnce();}
    finally {clearTimeout(timer);release();await held;}
  });
  it.each(['released','confirmed'])('allows account teardown after %s and retains a fresh source',async status=>{
    await scope(async s=>{let row=await create(s);row=await store.settle(s,row,{status:status as any,
      completed_at:new Date(await store.databaseTime(s)),release_mode:status==='released'?'not_sent':null},async client=>{await client.query("UPDATE bot_trades SET status=$2 WHERE id=$1",[row.original_trade_id,status==='released'?'failed':'executed']);});});
    const remove=vi.fn(async()=> 'EXAMPLE_DELETED');expect(await store.withAccount('EXAMPLE','EXAMPLE_ACCOUNT',remove)).toBe('EXAMPLE_DELETED');
    expect(remove).toHaveBeenCalledOnce();await scope(async s=>expect((await create(s,'EXAMPLE_FRESH')).status).toBe('pending'));
  });
  it('shows old queue attention without retaining an unresolved close or disabling Close',async()=>{
    vi.spyOn(store,'legacyInventory').mockResolvedValueOnce([{id:'EXAMPLE_QUEUE',original_trade_id:'EXAMPLE_OLD_TRADE',bot_id:'EXAMPLE_BOT',protocol:null,protocol_subaccount_id:null}]);
    expect(await store.statusForBot('EXAMPLE_OWNER','EXAMPLE_BOT')).toMatchObject({unresolved:false,message:'Close needs your attention. The position may still be open.'});
  });

  async function seedMoney(bot = 'EXAMPLE_BOT', account = 'EXAMPLE_ACCOUNT', size = '1') {
    await pool.query("INSERT INTO trading_bots(id,wallet_address,active_protocol,protocol_subaccount_id,stats) VALUES($1,'EXAMPLE_OWNER','pacifica',$2,'{}')", [bot,account]);
    await pool.query("INSERT INTO bot_positions(trading_bot_id,wallet_address,market,base_size,avg_entry_price,cost_basis,realized_pnl,total_fees,last_trade_id) VALUES($1,'EXAMPLE_OWNER','BTC-PERP',$2,100,100,0,0,'EXAMPLE_ENTRY')",[bot,size]);
  }
  function adapterFor(account = 'EXAMPLE_ACCOUNT', partial = false) {
    let reads=0; const state={ available:true };
    const adapter={protocolName:'pacifica',getCloseEnvironment:()=> 'EXAMPLE',
      prepareReduceOnlyMarketOrder:async(p:any)=>({account,environment:'EXAMPLE',market:'BTC-PERP',operationData:{symbol:'BTC',side:'ask',amount:partial?'0.5':'1',reduce_only:true,client_order_id:p.clientOrderId}}),
      sendPreparedReduceOnlyMarketOrder:vi.fn(async()=>({kind:'acknowledged',orderId:'EXAMPLE_ORDER'})),
      getCloseConfirmationSnapshot:vi.fn(async()=>{const value=snapshot(++reads===1?'1':partial?'0.5':'0',reads===1?7:8);value.evidence.account=account;return value;}),
      getTradeHistory:vi.fn(async(_a:any,o:any)=>state.available?[{tradeId:'EXAMPLE_FILL',orderId:'EXAMPLE_ORDER',internalSymbol:'BTC-PERP',side:'short',venueEventKind:'close_long',size:partial?0.5:1,price:125,fee:1,realizedPnl:25,timestamp:o.startTime,subaccountId:account}]:[])} as any;
    return {adapter,state};
  }
  async function submitMoney(adapter:any, bot='EXAMPLE_BOT', account='EXAMPLE_ACCOUNT', partial=false, source='EXAMPLE_R4') {
    const result=await submitDurableClose({adapter,params:{agentPublicKey:account,agentSecretKey:new Uint8Array(),mainWalletAddress:'EXAMPLE_OWNER',internalSymbol:'BTC-PERP',side:'short',sizeBase:partial?0.5:1,sizeBaseExact:partial?'0.5':'1',reduceOnly:true},identity:{owner_wallet:'EXAMPLE_OWNER',bot_id:bot,source_key:source,signer_mode:'external_key',authority_ref:{subscriberAccounting:true},baseSize:'1',lastTradeId:'EXAMPLE_ENTRY'},trade:{...trade,tradingBotId:bot,size:partial?'0.5':'1'},kind:partial?'partial':'full',positionSide:'long'});
    if(!result.intent)throw new Error('EXAMPLE_INTENT_NOT_ADMITTED');
    return {...result,intent:result.intent};
  }
  it.each([899,901])('S13 N2 legacy age %s seconds controls blocking without dropping reconciliation',async age=>{
    await seedMoney();
    const row=(await pool.query("INSERT INTO bot_trades(trading_bot_id,wallet_address,market,side,size,price,status,executed_at) VALUES('EXAMPLE_BOT','EXAMPLE_OWNER','BTC-PERP','CLOSE','1','0','pending',clock_timestamp()-($1::integer*interval '1 second')) RETURNING id",[age])).rows[0];
    await scope(async s=>expect(await store.hasLegacyPending(s)).toBe(age<900));
    expect(await store.statusForBot('EXAMPLE_OWNER','EXAMPLE_BOT')).toMatchObject({unresolved:age<900,tradeId:row.id,...(age>900?{message:'An earlier close could not be confirmed. Check the position.'}:{})});
    const send=vi.fn();if(age>900){await store.withOpenFence('EXAMPLE','EXAMPLE_ACCOUNT','BTC-PERP',send);expect(send).toHaveBeenCalledOnce();
      const intent=(await scope(s=>create(s)))!;expect(await store.statusForBot('EXAMPLE_OWNER','EXAMPLE_BOT')).toMatchObject({unresolved:true,tradeId:intent.original_trade_id});}
    expect((await pool.query('SELECT status FROM bot_trades WHERE id=$1',[row.id])).rows[0].status).toBe('pending');
  });
  it.each(['route','worker'])('S13 N1 %s confirmed published partial dispatches original-account subscriber intents and effects once across restart',async confirmer=>{
    const {registerPartialCloseFanout,dispatchPartialCloseEffects}=await import('../../server/trading/signal-bot-close-intent-effects').catch(()=>({registerPartialCloseFanout:(_f:any)=>{},dispatchPartialCloseEffects:async(_s:any,_i:any)=>{}}));
    const {sendTradeNotification}=await import('../../server/notification-service');
    const {maybeScheduleAutoRepark}=await import('../../server/vault/auto-repark');
    await seedMoney();await seedMoney('EXAMPLE_SUB_A','EXAMPLE_ACCOUNT_A');await seedMoney('EXAMPLE_SUB_B','EXAMPLE_ACCOUNT_B');
    await pool.query("INSERT INTO published_bots(id,trading_bot_id,is_active) VALUES('EXAMPLE_PUBLISHED','EXAMPLE_BOT',true)");
    const subscriberAdapters=[adapterFor('EXAMPLE_ACCOUNT_A',true),adapterFor('EXAMPLE_ACCOUNT_B',true)];
    const fanout=vi.fn(async(_bot:any,signal:any)=>{expect(signal.partialCloseFraction).toBe(0.5);for(const [index,sub] of subscriberAdapters.entries())await submitMoney(sub.adapter,index===0?'EXAMPLE_SUB_A':'EXAMPLE_SUB_B',index===0?'EXAMPLE_ACCOUNT_A':'EXAMPLE_ACCOUNT_B',true,signal.originId);});
    registerPartialCloseFanout(fanout);
    const source=adapterFor('EXAMPLE_ACCOUNT',true);
    if(confirmer==='worker') source.adapter.getCloseConfirmationSnapshot.mockResolvedValue(snapshot('1',7));
    const result=await submitMoney(source.adapter,'EXAMPLE_BOT','EXAMPLE_ACCOUNT',true);
    if(confirmer==='worker') {
      expect(result.intent.status).toBe('pending');expect(fanout).not.toHaveBeenCalled();expect(sendTradeNotification).not.toHaveBeenCalled();expect(maybeScheduleAutoRepark).not.toHaveBeenCalled();
      source.adapter.getCloseConfirmationSnapshot.mockResolvedValue(snapshot('0.5',8));
      const {accountDurableClose}=await import('../../server/trading/signal-bot-close-intent-accounting');
      registerCloseWorkerDependencies({adapter:()=>source.adapter,epochUnchanged:async()=>true,signer:async()=>null,account:accountDurableClose});
      await pool.query('UPDATE signal_bot_close_intents SET revision=revision+1,next_action_at=clock_timestamp()');await runCloseIntentWorkerPass();
    }
    expect((await pool.query('SELECT status FROM signal_bot_close_intents WHERE id=$1',[result.intent.id])).rows[0].status).toBe('confirmed');expect(fanout).toHaveBeenCalledOnce();
    expect(subscriberAdapters.map(s=>s.adapter.sendPreparedReduceOnlyMarketOrder.mock.calls.length)).toEqual([1,1]);
    expect((await pool.query("SELECT original_account,close_kind,requested_size_base FROM signal_bot_close_intents WHERE bot_id<>'EXAMPLE_BOT' ORDER BY original_account")).rows).toEqual(['EXAMPLE_ACCOUNT_A','EXAMPLE_ACCOUNT_B'].map(original_account=>({original_account,close_kind:'partial',requested_size_base:'0.5'})));
    expect(vi.mocked(sendTradeNotification).mock.calls.filter(c=>c[1].type==='partial_close')).toHaveLength(3);
    expect(maybeScheduleAutoRepark).toHaveBeenCalledTimes(3);
    holder.store=new SignalBotCloseIntentStorage(pool);vi.spyOn(holder.store,'ready').mockResolvedValue(undefined);
    try{await scope(async s=>{await dispatchPartialCloseEffects(s,(await store.byId(s,result.intent.id))!);});await runCloseIntentWorkerPass();}
    finally{holder.store=store;}
    expect(fanout).toHaveBeenCalledOnce();expect(maybeScheduleAutoRepark).toHaveBeenCalledTimes(3);expect(sendTradeNotification).toHaveBeenCalledTimes(3);
    registerPartialCloseFanout(async()=>{});
  });
  it.each(['before','after'])('S13 K-R3 legacy subscriber marker %s canonical confirmation cannot wedge delayed accounting',async order=>{
    await seedMoney();const {adapter,state}=adapterFor();state.available=false;
    const {storage}=await import('../../server/storage');const {accountDurableClose}=await import('../../server/trading/signal-bot-close-intent-accounting');
    let legacyDone=false;
    if(order==='before')adapter.sendPreparedReduceOnlyMarketOrder.mockImplementation(async()=>{
      await pool.query("UPDATE bot_trades SET webhook_payload=COALESCE(webhook_payload,'{}')||$1::jsonb",[JSON.stringify({subscriberCloseAccounting:{account:'EXAMPLE_ACCOUNT',orderId:'EXAMPLE_ORDER',reason:'unavailable'}})]);legacyDone=true;return {kind:'acknowledged',orderId:'EXAMPLE_ORDER'};
    });
    const result=await submitMoney(adapter);expect(result.intent.status).toBe('confirmed');
    if(!legacyDone)await pool.query("UPDATE bot_trades SET webhook_payload=webhook_payload||$1::jsonb WHERE id=$2",[JSON.stringify({subscriberCloseAccounting:{account:'EXAMPLE_ACCOUNT',orderId:'EXAMPLE_ORDER',reason:'unavailable'}}),result.intent.original_trade_id]);
    state.available=true;registerCloseWorkerDependencies({adapter:()=>adapter,epochUnchanged:async()=>true,signer:async()=>null,account:accountDurableClose});
    await pool.query('UPDATE signal_bot_close_intents SET revision=revision+1,next_action_at=clock_timestamp()');
    await expect(runCloseIntentWorkerPass()).resolves.toBeUndefined();
    await pool.query('UPDATE signal_bot_close_intents SET revision=revision+1,next_action_at=clock_timestamp()');await runCloseIntentWorkerPass();
    expect((await pool.query('SELECT pnl,fee FROM bot_trades')).rows[0]).toEqual({pnl:'24.00',fee:'1.000000'});
    expect((await pool.query('SELECT realized_pnl,total_fees FROM bot_positions')).rows[0]).toEqual({realized_pnl:'24.000000',total_fees:'1.000000'});
    expect(adapter.sendPreparedReduceOnlyMarketOrder).toHaveBeenCalledOnce();
    // A late legacy route cannot replace the canonical payload, economics or exposure.
    const late={outcome:'confirmed',reason:'unavailable',account:'EXAMPLE_ACCOUNT',market:'BTC-PERP',orderId:'EXAMPLE_ORDER',pnl:null,fee:null,size:null,price:null,volume:null,fillIds:[],recovery:{account:'EXAMPLE_ACCOUNT',market:'BTC-PERP',orderId:'EXAMPLE_ORDER',closeResult:{outcome:'confirmed'}}} as any;
    await storage.remediateSubscriberCloseAccountingAtomic({botId:'EXAMPLE_BOT',tradeId:result.intent.original_trade_id,accounting:late});
    expect((await pool.query('SELECT pnl FROM bot_trades')).rows[0].pnl).toBe('24.00');
  });
  it('S13 K-R3 adopts already applied subscriber economics without a second delta',async()=>{
    await seedMoney();const {adapter,state}=adapterFor();state.available=false;
    const result=await submitMoney(adapter);
    await pool.query("UPDATE bot_trades SET pnl='24',fee='1',price='125',webhook_payload=webhook_payload||$1::jsonb WHERE id=$2",[JSON.stringify({subscriberCloseAccounting:{reason:null,pnl:'24',fee:'1'}}),result.intent.original_trade_id]);
    await pool.query("UPDATE bot_positions SET realized_pnl='24',total_fees='1'");
    state.available=true;const {accountDurableClose}=await import('../../server/trading/signal-bot-close-intent-accounting');
    registerCloseWorkerDependencies({adapter:()=>adapter,epochUnchanged:async()=>true,signer:async()=>null,account:accountDurableClose});
    for(let pass=0;pass<2;pass++){await pool.query('UPDATE signal_bot_close_intents SET revision=revision+1,next_action_at=clock_timestamp()');await runCloseIntentWorkerPass();}
    expect((await pool.query('SELECT realized_pnl,total_fees FROM bot_positions')).rows[0]).toEqual({realized_pnl:'24.000000',total_fees:'1.000000'});
    expect((await pool.query('SELECT last_evidence FROM signal_bot_close_intents')).rows[0].last_evidence.accountingPending).toBe(false);
    expect(adapter.sendPreparedReduceOnlyMarketOrder).toHaveBeenCalledOnce();
  });
  it('S13 K-R3 throwing repair does not starve a later row and N3 backoff exhausts after eight attempts',async()=>{
    await seedMoney();await seedMoney('EXAMPLE_OTHER','EXAMPLE_OTHER_ACCOUNT');
    const bad=adapterFor(),good=adapterFor('EXAMPLE_OTHER_ACCOUNT');bad.state.available=false;good.state.available=false;
    await submitMoney(bad.adapter);await submitMoney(good.adapter,'EXAMPLE_OTHER','EXAMPLE_OTHER_ACCOUNT');good.state.available=true;
    const {accountDurableClose}=await import('../../server/trading/signal-bot-close-intent-accounting');
    registerCloseWorkerDependencies({adapter:row=>{if(row.bot_id==='EXAMPLE_BOT')throw Error('EXAMPLE_REPAIR_FAILURE');return good.adapter;},epochUnchanged:async()=>true,signer:async()=>null,account:accountDurableClose});
    for(let attempt=1;attempt<=8;attempt++){
      await pool.query('UPDATE signal_bot_close_intents SET revision=revision+1,next_action_at=clock_timestamp()');await expect(runCloseIntentWorkerPass()).resolves.toBeUndefined();
      const row=(await pool.query("SELECT *,extract(epoch from next_action_at-updated_at)*1000 AS delay FROM signal_bot_close_intents WHERE bot_id='EXAMPLE_BOT'")).rows[0];
      expect(row.last_evidence.repairAttempts).toBe(attempt);expect(Number(row.delay)).toBeCloseTo(Math.min(30000*2**(attempt-1),1800000),-1);
    }
    expect((await pool.query("SELECT pnl FROM bot_trades WHERE trading_bot_id='EXAMPLE_OTHER'")).rows[0].pnl).toBe('24.00');
    expect((await store.statusForBot('EXAMPLE_OWNER','EXAMPLE_BOT'))?.message).toContain('Accounting needs your attention');
    expect((await pool.query("SELECT last_evidence FROM signal_bot_close_intents WHERE bot_id='EXAMPLE_BOT'")).rows[0].last_evidence).toMatchObject({repairAttention:true,accountingPending:false});
  });
  it('S13 N3 teardown retains its five second timeout after nested market scope',async()=>{
    await store.withAccount('EXAMPLE','EXAMPLE_ACCOUNT',async parent=>{
      await store.withScope('EXAMPLE','EXAMPLE_ACCOUNT','BTC-PERP',async()=>{},false,parent);
      await store.transaction(parent,async client=>expect((await client.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe('5s'));
    });
  });
  it.each([true,false])('S13 N3 missing partial residual is bounded; independent S4 proof=%s',async proof=>{
    await seedMoney();await pool.query('DELETE FROM bot_positions');
    let row!:CloseIntent;
    await scope(async s=>{const input=newIntent();row=await store.create(s,{...input,created_at:new Date(Date.now()-1000000),close_kind:'partial',requested_size_base:'0.5',request_payload:{...input.request_payload,amount:'0.5'}} as any,{...trade,size:'0.5'}).then(r=>r.intent!);row=await admit(s,row,Date.now()-1000000);row=await store.outcome(s,row,row.attempt_log[0].attemptId,{kind:'acknowledged',orderId:'EXAMPLE_ORDER'});});
    const {accountDurableClose}=await import('../../server/trading/signal-bot-close-intent-accounting');
    const {adapter}=adapterFor('EXAMPLE_ACCOUNT',true);adapter.getCloseConfirmationSnapshot=vi.fn(async()=>snapshot('0.5',8));adapter.getCloseOpenOrders=async()=>({...orders(),lastOrderId:8,complete:proof});
    registerCloseWorkerDependencies({adapter:()=>adapter,epochUnchanged:async()=>true,signer:async()=>null,account:accountDurableClose});
    await pool.query('UPDATE signal_bot_close_intents SET revision=revision+1,next_action_at=clock_timestamp()');
    await runCloseIntentWorkerPass();
    expect((await pool.query('SELECT status,release_mode FROM signal_bot_close_intents')).rows[0]).toEqual(proof?{status:'released',release_mode:'residual'}:{status:'needs_user',release_mode:null});
    expect(adapter.sendPreparedReduceOnlyMarketOrder).not.toHaveBeenCalled();
  });

});
