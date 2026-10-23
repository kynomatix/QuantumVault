import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableColumns } from 'drizzle-orm';
import * as schema from '@shared/schema';
import { lockMarketEntry, marketEntryBlock, reserveMarketEntry, lockRetainedMarketEntry, confirmMarketEntry,
  releaseNeverSentMarketEntry, verifyMarketEntrySchema, preflightMarketEntries, type CooldownQuery } from '../../server/ai-trader/market-entry-cooldown';
import { readDbSchemaMigrationManifest } from '../helpers/schema-migration-manifest';
import { probeSchemaMigrationManifest } from '../../server/schema-readiness';
import * as journal from '../../server/ai-trader/execution-journal';
let PhoenixAiStore: typeof import('../../server/ai-trader/phoenix-store')['PhoenixAiStore'];
import { aiBot, aiAuthority, clamped, filled, now as phoenixNow } from '../helpers/phoenix-ai';
import { buildPhoenixAiEntry } from '../../server/ai-trader/phoenix-sizing';
import { orderIntentHash } from '../../server/protocol/phoenix/order-contract';
import { aiTraderPolicyObject } from '../../server/ai-trader/phoenix-policy';

let pool: pg.Pool, bootstrap: pg.Pool, testDb: ReturnType<typeof drizzle<typeof schema>>;
vi.mock('../../server/db', () => ({ get db() { return testDb; }, get pool() { return pool; } }));
vi.mock('../../server/telemetry', () => ({ appendTelemetry: vi.fn() }));
const namespace = `cooldown_${randomUUID().replaceAll('-', '')}`;
const ddl = readFileSync(new URL('../fixtures/ai-trader-market-entry-attempts.sql', import.meta.url), 'utf8');
let storage: typeof import('../../server/storage')['storage'];
const key = { ownerWallet: 'EXAMPLE-owner', market: 'SOL-PERP', paperMode: true };
const query: CooldownQuery = async (text, values) => pool.query(text, values ? [...values] : undefined);
const migration = readDbSchemaMigrationManifest().manifest.find((entry) => entry.id === '204-ai-trader-market-cooldown-verify')!;
async function transaction<T>(fn: (q: CooldownQuery) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await fn(async (text, values) => client.query(text, values ? [...values] : undefined)); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
async function seed(botId: string, decisionId = `${botId}-decision`, patch: Partial<typeof key> = {}) {
  const k = { ...key, ...patch };
  await pool.query(`INSERT INTO ai_trader_bots(id,wallet_address,market,paper_mode,status,pause_reason,protocol)
    VALUES($1,$2,$3,$4,'analyzing',NULL,'pacifica')`, [botId,k.ownerWallet,k.market,k.paperMode]);
  await pool.query(`INSERT INTO ai_trader_decisions(id,bot_id,decided_at,context_digest) VALUES($1,$2,clock_timestamp(),'{}')`, [decisionId,botId]);
  return { botId, decisionId, expectedStatus: 'analyzing' as const, now: new Date(), expiryMs: 300000 };
}
beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url || new URL(url).pathname !== '/qvtest') throw new Error('Requires FRACTAL qvtest');
  bootstrap = new pg.Pool({ connectionString: url });
  await bootstrap.query(`CREATE SCHEMA ${namespace}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${namespace}`, max: 8 });
  testDb = drizzle(pool, { schema });
  // Full column projection, isolated from the shared database's migration state.
  for (const [name, table] of [['ai_trader_bots',schema.aiTraderBots],['ai_trader_decisions',schema.aiTraderDecisions],['ai_trader_execution_events',schema.aiTraderExecutionEvents]] as const) {
    const columns = Object.values(getTableColumns(table)).map((column) => `"${column.name}" ${column.getSQLType()}${column.name === 'id' ? ' PRIMARY KEY DEFAULT gen_random_uuid()' : column.name === 'event_identity' ? ' UNIQUE' : ''}`);
    await pool.query(`CREATE TABLE ${name} (${columns.join(',')})`);
  }
  await pool.query('ALTER TABLE ai_trader_execution_events ALTER COLUMN recorded_at SET DEFAULT clock_timestamp()');
  await pool.query(ddl);
  await pool.query('CREATE TABLE phoenix_ai_executions(bot_id varchar,decision_id varchar,state text)');
  ({ storage } = await import('../../server/storage'));
  ({ PhoenixAiStore } = await import('../../server/ai-trader/phoenix-store'));
}, 60000);
beforeEach(async () => { await pool.query('TRUNCATE ai_trader_market_entry_attempts,ai_trader_decisions,ai_trader_bots,ai_trader_execution_events,phoenix_ai_executions'); });
afterAll(async () => { await pool?.end(); if (bootstrap) { await bootstrap.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`); await bootstrap.end(); } });

describe('cross-bot market entry authority', () => {
  it('two PostgreSQL connections race through the real storage claim; exactly one wins and the loser is skipped', async () => {
    const a = await seed('EXAMPLE-a'), b = await seed('EXAMPLE-b');
    const results = await Promise.all([storage.claimAiTraderExecution(a),storage.claimAiTraderExecution(b)]);
    expect(results.map((r) => r.status).sort()).toEqual(['claimed','market_entry_pending']);
    expect((await pool.query("SELECT count(*)::int AS n FROM ai_trader_bots WHERE status='executing'")).rows[0].n).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM ai_trader_decisions WHERE outcome='market_cooldown_skipped'")).rows[0].n).toBe(1);
    const winner = results.findIndex((r) => r.status === 'claimed') === 0 ? a : b;
    expect((await storage.claimAiTraderExecution(winner)).status).toBe('bot_conflict');
  });
  it('retained pending blocks a different bot after restart and across analysis buckets', async () => {
    const a = await seed('EXAMPLE-a'); expect((await storage.claimAiTraderExecution(a)).status).toBe('claimed');
    await pool.query("UPDATE ai_trader_market_entry_attempts SET admitted_at=clock_timestamp()-interval '2 days'");
    expect((await storage.claimAiTraderExecution(await seed('EXAMPLE-b'))).status).toBe('market_entry_pending');
  });
  it('same bot re-entry remains allowed while siblings are blocked by its retained attempts', async () => {
    const a = await seed('EXAMPLE-a'); await storage.claimAiTraderExecution(a);
    await pool.query("UPDATE ai_trader_decisions SET outcome='executed'; UPDATE ai_trader_bots SET status='analyzing'");
    await transaction(async (q) => { await lockRetainedMarketEntry(q,a.botId,a.decisionId); await confirmMarketEntry(q,a.botId,a.decisionId); });
    await pool.query("INSERT INTO ai_trader_decisions(id,bot_id,decided_at) VALUES('EXAMPLE-next','EXAMPLE-a',clock_timestamp())");
    expect((await storage.claimAiTraderExecution({ ...a,decisionId:'EXAMPLE-next' })).status).toBe('claimed');
    expect((await storage.claimAiTraderExecution(await seed('EXAMPLE-b'))).status).toBe('market_entry_pending');
  });
  it.each([{ownerWallet:'EXAMPLE-other'}, {market:'BTC-PERP'}, {paperMode:false}])('owner, canonical market and mode are independent: %j', async (patch) => {
    await storage.claimAiTraderExecution(await seed('EXAMPLE-a'));
    expect((await storage.claimAiTraderExecution(await seed('EXAMPLE-b',undefined,patch))).status).toBe('claimed');
  });
  it('stale sender market identity cannot reserve one market and send another', async () => {
    const a = await seed('EXAMPLE-a');
    expect((await storage.claimAiTraderExecution({ ...a,expectedIdentity:{...key,market:'BTC-PERP'} })).status).toBe('bot_conflict');
    expect((await pool.query('SELECT * FROM ai_trader_market_entry_attempts')).rows).toHaveLength(0);
  });
  it('confirmation uses its own DB clock, survives deletion and graduation, and replay preserves it', async () => {
    const a = await seed('EXAMPLE-a'); await storage.claimAiTraderExecution(a);
    await transaction(async (q) => { await lockRetainedMarketEntry(q,a.botId,a.decisionId); await confirmMarketEntry(q,a.botId,a.decisionId); });
    const first = (await pool.query('SELECT first_confirmed_at::text AS at FROM ai_trader_market_entry_attempts')).rows[0].at;
    await transaction(async (q) => { await lockRetainedMarketEntry(q,a.botId,a.decisionId); await confirmMarketEntry(q,a.botId,a.decisionId); });
    await pool.query('UPDATE ai_trader_bots SET paper_mode=false; DELETE FROM ai_trader_decisions; DELETE FROM ai_trader_bots');
    expect((await pool.query('SELECT first_confirmed_at::text AS at,paper_mode FROM ai_trader_market_entry_attempts')).rows[0]).toEqual({at:first,paper_mode:true});
    expect(await marketEntryBlock(query,key,'EXAMPLE-new')).toMatchObject({status:'market_cooldown'});
  });
  it.each([-1,0,1])('four hour predicate keeps microsecond precision at boundary offset %i', async (micros) => {
    await reserveMarketEntry(query,key,'EXAMPLE-a','EXAMPLE-d');
    await pool.query("UPDATE ai_trader_market_entry_attempts SET admitted_at='2026-01-01',state='confirmed',first_confirmed_at='2026-01-01 00:00:00.123456+00'");
    const deterministic: CooldownQuery = (text,values) => query(text.replace('clock_timestamp()',`('2026-01-01 04:00:00.123456+00'::timestamptz + interval '${micros} microseconds')`),values);
    expect((await marketEntryBlock(deterministic,key,'EXAMPLE-b'))?.status ?? null).toBe(micros < 0 ? 'market_cooldown' : null);
  });
  it('samples the DB clock after an advisory lock wait', async () => {
    const holder = await pool.connect(), waiter = await pool.connect();
    try {
      await holder.query('BEGIN'); await waiter.query('BEGIN');
      const holderQuery: CooldownQuery = (text,values) => holder.query(text,values ? [...values] : undefined);
      const waiterQuery: CooldownQuery = (text,values) => waiter.query(text,values ? [...values] : undefined);
      await lockMarketEntry(holderQuery,key);
      await reserveMarketEntry(holderQuery,key,'EXAMPLE-a','EXAMPLE-d');
      await holder.query("UPDATE ai_trader_market_entry_attempts SET admitted_at=clock_timestamp()-interval '4 hours',state='confirmed',first_confirmed_at=clock_timestamp()-interval '4 hours'+interval '80 milliseconds'");
      const blocked = lockMarketEntry(waiterQuery,key).then(() => marketEntryBlock(waiterQuery,key,'EXAMPLE-b'));
      await holder.query('SELECT pg_sleep(0.12)'); await holder.query('COMMIT');
      expect(await blocked).toBeNull();
      await waiter.query('COMMIT');
    } finally { holder.release(); waiter.release(); }
  });
  it('never-sent release is attempt-specific and does not erase an older confirmation', async () => {
    await reserveMarketEntry(query,key,'EXAMPLE-a','EXAMPLE-old'); await confirmMarketEntry(query,'EXAMPLE-a','EXAMPLE-old');
    await reserveMarketEntry(query,key,'EXAMPLE-a','EXAMPLE-next');
    await releaseNeverSentMarketEntry(query,'EXAMPLE-wrong','EXAMPLE-next');
    expect((await marketEntryBlock(query,key,'EXAMPLE-b'))?.status).toBe('market_entry_pending');
    await releaseNeverSentMarketEntry(query,'EXAMPLE-a','EXAMPLE-next');
    expect((await marketEntryBlock(query,key,'EXAMPLE-b'))?.status).toBe('market_cooldown');
  });
  it('real pre-send state transition releases only with an exact decision/status CAS', async () => {
    const a = await seed('EXAMPLE-a'); await storage.claimAiTraderExecution(a);
    const transition = {botId:a.botId,decisionId:a.decisionId,expectedStatus:'executing',expectedPauseReason:null,
      nextStatus:'idle',nextPauseReason:null,expectedDecisionOutcome:null,decisionOutcome:'aborted_order',neverSentEntry:true};
    expect(await storage.transitionAiTraderState({...transition,expectedStatus:'open'})).toBeUndefined();
    expect((await marketEntryBlock(query,key,'EXAMPLE-b'))?.status).toBe('market_entry_pending');
    expect(await storage.transitionAiTraderState(transition)).toBeDefined();
    expect(await marketEntryBlock(query,key,'EXAMPLE-b')).toBeNull();
  });
  it('failed transaction cannot leave a pending reservation', async () => {
    await expect(transaction(async (q) => { await lockMarketEntry(q,key); await reserveMarketEntry(q,key,'EXAMPLE-a','EXAMPLE-d'); throw new Error('EXAMPLE rollback'); })).rejects.toThrow('EXAMPLE rollback');
    expect(await marketEntryBlock(query,key,'EXAMPLE-b')).toBeNull();
  });
});
describe('entry-only schema readiness', () => {
  it('owner DDL meets the real verify-only manifest and uses single-line checks', async () => {
    expect(await verifyMarketEntrySchema(query)).toBe(true);
    expect((await probeSchemaMigrationManifest(query,[migration])).unavailableCapabilities).toEqual([]);
    expect(migration.sql).not.toMatch(/CREATE|ALTER|DELETE|TRUNCATE/i);
    expect(ddl.split('\n').filter((line) => line.includes(' CHECK '))).toHaveLength(4);
  });
  it.each(['ai_market_entry_pending','ai_market_entry_confirmed'])('missing index %s fails entry closed', async (index) => {
    const definition = (await pool.query('SELECT pg_get_indexdef($1::regclass) AS sql',[index])).rows[0].sql as string;
    await pool.query(`DROP INDEX ${index}`);
    try { expect((await storage.claimAiTraderExecution(await seed('EXAMPLE-a'))).status).toBe('schema_unavailable'); }
    finally { await pool.query(definition); }
  });
  it('missing check fails closed and repeat startup cannot recreate a missing table', async () => {
    const constraint = (await pool.query("SELECT pg_get_constraintdef(oid) AS sql FROM pg_constraint WHERE conrelid='ai_trader_market_entry_attempts'::regclass AND conname='ai_market_entry_clock'")).rows[0].sql as string;
    await pool.query('ALTER TABLE ai_trader_market_entry_attempts DROP CONSTRAINT ai_market_entry_clock');
    expect(await verifyMarketEntrySchema(query)).toBe(false);
    await pool.query(`ALTER TABLE ai_trader_market_entry_attempts ADD CONSTRAINT ai_market_entry_clock ${constraint}`);
    await pool.query('ALTER TABLE ai_trader_market_entry_attempts RENAME TO retained_entry_history');
    try { await pool.query(migration.sql); expect(await verifyMarketEntrySchema(query)).toBe(false); }
    finally { await pool.query('ALTER TABLE retained_entry_history RENAME TO ai_trader_market_entry_attempts'); }
  });
  it.each(["'infinity'",'NULL',"'-infinity'"])('rejects invalid admission timestamp %s', async (value) => {
    await expect(pool.query(`INSERT INTO ai_trader_market_entry_attempts(attempt_id,decision_id,bot_id,owner_wallet,market,paper_mode,admitted_at)
      VALUES('EXAMPLE-a','EXAMPLE-d','EXAMPLE-b','EXAMPLE-owner','SOL-PERP',true,${value})`)).rejects.toThrow();
  });
});

async function writerFixture(paperMode: boolean, phoenix = false) {
  const a = await seed(phoenix ? 'EXAMPLE-ai' : 'EXAMPLE-a', 'EXAMPLE-decision', {paperMode});
  if (phoenix) {
    const p = aiBot({id:a.botId});
    await pool.query("UPDATE ai_trader_bots SET protocol='phoenix',protocol_subaccount_id=$1,phoenix_binding=$2,phoenix_execution_bot_id=$3",[p.protocolSubaccountId,p.phoenixBinding,p.phoenixExecutionBotId]);
  }
  await pool.query("UPDATE ai_trader_decisions SET decided_at=date_trunc('milliseconds',clock_timestamp()-interval '1 minute')");
  const result = await storage.claimAiTraderExecution(a);
  expect(result.status).toBe('claimed');
  if (result.status !== 'claimed') throw new Error('Fixture claim failed');
  const observedAt = new Date(result.decision.decidedAt!);
  const base = {...journal.journalBase(result.bot,a.decisionId),attemptId:`entry:${a.decisionId}`,
    action:'entry' as const,cause:paperMode ? 'paper' as const : 'decision' as const,side:'long' as const,observedAt};
  if (!paperMode) await journal.appendRequiredEntryPrebroadcast({bot:result.bot,decisionId:a.decisionId,side:'long',
    clientOrderId:'EXAMPLE-order',sizeBase:2,price:150,observedAt});
  const paperEvents: [journal.JournalEventInput,journal.JournalEventInput,journal.JournalEventInput] = [
    {...base,eventType:'attempt_claimed'}, {...base,eventType:'fill_observed',price:150,sizeBase:2},
    {...base,eventType:'entry_terminal_open',price:150,sizeBase:2},
  ];
  const liveEvents: journal.JournalEventInput[] = [
    {...base,eventType:'broadcast_result',venueStatus:'filled'}, {...base,eventType:'position_observed',price:150,sizeBase:2},
    {...base,eventType:'fill_observed',price:150,sizeBase:2}, {...base,eventType:'bracket_verified'},
    {...base,eventType:'entry_terminal_open',price:150,sizeBase:2},
  ];
  const params = {botId:a.botId,decisionId:a.decisionId,entryPrice:150,sizeBase:2,side:'long' as const,observedAt,journalEvents:paperMode ? paperEvents : liveEvents};
  const paperParams = {...params,journalEvents:paperEvents};
  return {a,bot:result.bot,params,paperParams,base};
}
async function retained() {
  return (await pool.query('SELECT state,first_confirmed_at::text AS at FROM ai_trader_market_entry_attempts')).rows[0] as {state:string;at:string|null};
}
async function fault(table: string, enabled: boolean) {
  if (enabled) {
    await pool.query(`CREATE OR REPLACE FUNCTION cooldown_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'EXAMPLE injected write failure'; END $$`);
    await pool.query(`CREATE TRIGGER cooldown_test_fault BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION cooldown_fault()`);
  } else await pool.query(`DROP TRIGGER cooldown_test_fault ON ${table}`);
}
describe('first durable entry writers and failure isolation', () => {
  it.each([true,false])('paperMode=%s commits original clock with entry and replay never advances it', async (paperMode) => {
    const {params,paperParams} = await writerFixture(paperMode);
    const write = () => paperMode ? storage.commitAiTraderPaperEntryTransition(paperParams) : storage.commitAiTraderDirectLiveEntryTransition({...params,disposition:'open'});
    expect((await write()).status).toBe('applied');
    const first = await retained(); expect(first.state).toBe('confirmed');
    expect((await pool.query('SELECT a.first_confirmed_at > d.decided_at AS later FROM ai_trader_market_entry_attempts a JOIN ai_trader_decisions d ON d.id=a.decision_id')).rows[0].later).toBe(true);
    expect((await write()).status).toBe('replayed'); expect(await retained()).toEqual(first);
  });
  it('paper cooldown write failure rolls back both executed decision and bot state', async () => {
    const {paperParams:params} = await writerFixture(true); await fault('ai_trader_market_entry_attempts',true);
    try { await expect(storage.commitAiTraderPaperEntryTransition(params)).rejects.toThrow(); }
    finally { await fault('ai_trader_market_entry_attempts',false); }
    expect(await retained()).toEqual({state:'pending',at:null});
    expect((await storage.getAiTraderDecision(params.decisionId))?.outcome).toBeNull();
    expect((await storage.getAiTraderBot(params.botId))?.status).toBe('executing');
  });
  it('live cooldown fault preserves open protection state and a replay cannot invent the clock', async () => {
    const {params} = await writerFixture(false); await fault('ai_trader_market_entry_attempts',true);
    try { expect((await storage.commitAiTraderDirectLiveEntryTransition({...params,disposition:'open'})).status).toBe('applied'); }
    finally { await fault('ai_trader_market_entry_attempts',false); }
    expect(await retained()).toEqual({state:'pending',at:null});
    expect((await storage.getAiTraderBot(params.botId))?.status).toBe('open');
    expect((await storage.commitAiTraderDirectLiveEntryTransition({...params,disposition:'open'})).status).toBe('replayed');
    expect(await retained()).toEqual({state:'pending',at:null});
  });
  it('combined cooldown and journal failure rolls back direct write; degraded recovery protects and never backfills a clock', async () => {
    const {params} = await writerFixture(false);
    await fault('ai_trader_market_entry_attempts',true); await fault('ai_trader_execution_events',true);
    const recovery = {disposition:'adopt_for_protective_close' as const,botId:params.botId,decisionId:params.decisionId,
      expectedBotStatus:'executing',expectedPauseReason:null,expectedDecisionOutcome:null,entryPrice:150,
      targetBotStatus:'paused' as const,targetPauseReason:'bracket_failed',journalBatches:[params.journalEvents]};
    try {
      await expect(storage.commitAiTraderDirectLiveEntryTransition({...params,disposition:'open'})).rejects.toThrow();
      expect((await storage.commitAiTraderRecoveryTransition(recovery)).status).toBe('applied');
      expect((await storage.getAiTraderDecision(params.decisionId))?.outcome).toBe('executed');
      expect((await storage.getAiTraderBot(params.botId))?.status).toBe('paused');
    } finally { await fault('ai_trader_market_entry_attempts',false); await fault('ai_trader_execution_events',false); }
    expect(await retained()).toEqual({state:'pending',at:null});
    expect((await storage.commitAiTraderRecoveryTransition(recovery)).status).toBe('replayed');
    expect(await retained()).toEqual({state:'pending',at:null});
  });
  it('quarantined and generic no-land outcomes retain exclusion; recovery adoption confirms it', async () => {
    const {params,base} = await writerFixture(false);
    expect((await storage.commitAiTraderDirectLiveEntryTransition({...params,disposition:'quarantined',entryPrice:undefined,sizeBase:undefined,
      journalEvents:[{...base,eventType:'broadcast_result',venueStatus:'unknown',failureCode:'venue_unconfirmed'}]})).status).toBe('applied');
    expect(await retained()).toEqual({state:'pending',at:null});
    expect((await storage.commitAiTraderRecoveryTransition({disposition:'adopt_open',botId:params.botId,decisionId:params.decisionId,
      expectedBotStatus:'paused',expectedPauseReason:'position_unconfirmed',expectedDecisionOutcome:'unconfirmed_landing',entryPrice:150,
      targetBotStatus:'open',targetPauseReason:null,journalBatches:[]})).status).toBe('applied');
    expect((await retained()).state).toBe('confirmed');
  });
  it.each(['open','noLand'] as const)('Phoenix %s respects the existing decision timestamp writer contract', async (method) => {
    const {bot,params} = await writerFixture(false,true);
    const fixtureBot = aiBot(), authority = aiAuthority();
    const intent = buildPhoenixAiEntry(fixtureBot,params.decisionId,clamped(),authority,'1',phoenixNow);
    const execution = {botId:bot.id,decisionId:params.decisionId,intent,authority,policyHash:orderIntentHash(aiTraderPolicyObject(fixtureBot))};
    await pool.query('INSERT INTO phoenix_ai_executions VALUES($1,$2,$3)',[bot.id,params.decisionId,'prepared']);
    const store = new PhoenixAiStore(pool,()=>Date.now()+10000);
    const written=await (method === 'noLand' ? store.noLand(bot,execution) : store.open(bot,execution,filled(intent)));
    expect(written).toBe(true);
    expect((await retained()).state).toBe(method === 'open' ? 'confirmed' : 'pending');
  });
  it('Phoenix unprotected first fill confirms atomically and preserves its original clock after replay', async () => {
    const {bot,params} = await writerFixture(false,true), fixtureBot=aiBot(),authority=aiAuthority();
    const intent=buildPhoenixAiEntry(fixtureBot,params.decisionId,clamped(),authority,'1',phoenixNow);
    const execution={botId:bot.id,decisionId:params.decisionId,intent,authority,policyHash:orderIntentHash(aiTraderPolicyObject(fixtureBot))};
    const store=new PhoenixAiStore(pool);
    await store.unprotected(bot,execution,filled(intent)); const first=await retained();
    expect(first.state).toBe('confirmed'); expect((await storage.getAiTraderBot(bot.id))?.status).toBe('paused');
    await store.unprotected(bot,execution,filled(intent)); expect(await retained()).toEqual(first);
  });
});

describe('preflight through the real Drizzle db (production regression 2026-10-23)', () => {
  const bot = (id: string, market = key.market) => ({ id, walletAddress: key.ownerWallet, paperMode: key.paperMode, market } as any);
  it('returns an empty map, not null, when nothing blocks one market', async () => {
    await expect(preflightMarketEntries(bot('fixed-bot'), ['SPCX-PERP'])).resolves.toEqual({});
  });
  it('blocks a sibling pending attempt across several candidate markets and ignores the bot itself', async () => {
    const first = await seed('sibling-bot');
    await transaction(async (q) => { await lockMarketEntry(q, key); await reserveMarketEntry(q, key, first.botId, first.decisionId); });
    await expect(preflightMarketEntries(bot('other-bot'), [key.market, 'ETH-PERP', key.market]))
      .resolves.toEqual({ [key.market]: { status: 'market_entry_pending' } });
    await expect(preflightMarketEntries(bot('sibling-bot'), [key.market])).resolves.toEqual({});
  });
});
