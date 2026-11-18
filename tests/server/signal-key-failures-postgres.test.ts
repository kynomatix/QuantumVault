import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { getTableColumns } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tradingBots, botTrades, botSubscriptions, publishedBots } from '../../shared/schema';
const holder=vi.hoisted(()=>({pool:undefined as any}));
vi.mock('../../server/db',async()=>{const {drizzle}=await import('drizzle-orm/node-postgres');return {get pool(){return holder.pool;},get db(){return drizzle(holder.pool);},isConnectionClassError:()=>false};});
vi.mock('../../server/trading/close-intent-store',()=>({closeIntentStore:{withBotLifecycle:async(_id:unknown,_accounts:unknown,work:()=>Promise<unknown>)=>work()}}));
import { DatabaseStorage } from '../../server/storage';

describe('SB01 PostgreSQL atomic streak',()=>{
 const schema='sb01_'+randomUUID().replaceAll('-','');
 const admin=new Pool({connectionString:process.env.DATABASE_URL,max:1});
 // Missing SB01 methods on base represent absent writes; assertions stay identical.
 let pool:Pool;const store=new Proxy(new DatabaseStorage(),{get(target,key){const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value??(async()=>undefined);}});
 const increment=async()=>{const result=await store.incrementSignalKeyFailure('EXAMPLE','agent_decrypt');expect(result,'counted failure must persist a streak').toBeDefined();return result!;};
 beforeAll(async()=>{
  if(!process.env.DATABASE_URL) throw new Error('FRACTAL PostgreSQL required');
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool=new Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:8});holder.pool=pool;
  for(const [name,table] of [['trading_bots',tradingBots],['bot_trades',botTrades],['bot_subscriptions',botSubscriptions],['published_bots',publishedBots]] as const){
   const columns=Object.values(getTableColumns(table)).map(c=>`"${c.name}" ${c.getSQLType()}${c.name==='id'?' PRIMARY KEY':''}`);
   await pool.query(`CREATE TABLE ${name} (${columns.join(',')})`);
  }
 });
 afterAll(async()=>{await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
 beforeEach(async()=>{await pool.query('TRUNCATE trading_bots,bot_trades,bot_subscriptions,published_bots');await pool.query("INSERT INTO trading_bots(id,is_active,active_protocol,stats,updated_at) VALUES ('EXAMPLE',true,'pacifica',NULL,'2026-01-01')");});
 const row=async()=> (await pool.query("SELECT *,stats->'signalKeyFailures' AS streak FROM trading_bots WHERE id='EXAMPLE'")).rows[0];
 it('atomic.concurrent.increments.claim.once.and.keeps.updatedAt',async()=>{
  const results=await Promise.all(Array.from({length:12},()=>increment()));
  expect(results.map(r=>r!.count).sort((a,b)=>a-b)).toEqual(Array.from({length:12},(_,i)=>i+1));
  const first=results[0]!.firstAt;expect(new Set(results.map(r=>r!.firstAt)).size).toBe(1);
  const claims=await Promise.all(results.map(()=>store.claimSignalKeyFailureAlert('EXAMPLE',first)));
  expect(claims.filter(Boolean)).toHaveLength(1);expect((await row()).updated_at.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  await store.setSignalKeyFailurePauseOutcome('EXAMPLE',first,'not_flat',claims.find(Boolean) as string);
  await pool.query("UPDATE trading_bots SET stats=jsonb_set(stats,'{signalKeyFailures,alertedAt}',to_jsonb((now()-interval '25 hours')::text))");
  expect((await Promise.all(results.map(()=>store.claimSignalKeyFailureAlert('EXAMPLE',first)))).filter(Boolean)).toHaveLength(1);
 });
 it('r2.expired.incomplete.lease.two.concurrent.reclaims.one.winner',async()=>{
  for(let i=0;i<3;i++) await increment();
  const first=(await row()).streak.firstAt;
  const original=await store.claimSignalKeyFailureAlert('EXAMPLE',first);
  expect(original).toBeTruthy();expect((await row()).streak.alertedAt).toBeNull();expect((await row()).streak.outcome).toBeNull();
  await pool.query("UPDATE trading_bots SET stats=jsonb_set(stats,'{signalKeyFailures,claimedAt}',to_jsonb((now()-interval '121 seconds')::text))");
  const claims=await Promise.all([1,2].map(()=>store.claimSignalKeyFailureAlert('EXAMPLE',first)));
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(await store.setSignalKeyFailurePauseOutcome('EXAMPLE',first,'not_flat',original as string)).toBe(false);
  expect(await store.setSignalKeyFailurePauseOutcome('EXAMPLE',first,'not_flat',claims.find(Boolean) as string)).toBe(true);
  const completed=(await row()).streak;expect(completed.outcome).toBe('not_flat');expect(completed.alertedAt).toBeTruthy();
  expect(await store.claimSignalKeyFailureAlert('EXAMPLE',first)).toBe(false);
 });
 it('r2.young.incomplete.lease.cannot.be.reclaimed',async()=>{
  for(let i=0;i<3;i++) await increment();
  const first=(await row()).streak.firstAt;await store.claimSignalKeyFailureAlert('EXAMPLE',first);
  await pool.query("UPDATE trading_bots SET stats=jsonb_set(stats,'{signalKeyFailures,claimedAt}',to_jsonb((now()-interval '119 seconds')::text))");
  expect(await store.claimSignalKeyFailureAlert('EXAMPLE',first)).toBe(false);expect((await row()).streak.alertedAt).toBeNull();
 });
 it('existing.stats.writers.merge.between.failures.without.losing.streak',async()=>{
  const one=await increment();
  await store.recomputeAndMergeBotStats('EXAMPLE',{totalPnlDelta:2,totalVolumeDelta:10});
  await store.updateTradingBotStats('EXAMPLE',{totalVolume:20} as any);
  const two=await increment();
  expect(two!.count).toBe(2);expect(two!.firstAt).toBe(one!.firstAt);expect((await row()).stats.totalPnl).toBe(2);expect((await row()).stats.totalVolume).toBe(20);
 });
 it('clear.only.writes.existing.streak.and.resume.atomically.clears',async()=>{
  const before=(await pool.query("SELECT xmin::text FROM trading_bots")).rows[0].xmin;
  await store.clearSignalKeyFailures('EXAMPLE');expect((await pool.query("SELECT xmin::text FROM trading_bots")).rows[0].xmin).toBe(before);
  const streak=await increment();
  await pool.query("UPDATE trading_bots SET is_active=false");await store.updateTradingBot('EXAMPLE',{isActive:true});
  expect((await row()).is_active).toBe(true);expect((await row()).streak).toBeNull();
  expect(await store.pauseActiveSignalBot('EXAMPLE','EXAMPLE_REASON',streak!.firstAt)).toBeUndefined();
 });
 it('cleared.generation.vetoes.stale.pause.and.claim',async()=>{
  const old=await increment();await store.clearSignalKeyFailures('EXAMPLE');
  const next=await increment();expect(next!.firstAt).not.toBe(old!.firstAt);
  expect(await store.pauseActiveSignalBot('EXAMPLE','EXAMPLE',old!.firstAt)).toBeUndefined();expect(await store.claimSignalKeyFailureAlert('EXAMPLE',old!.firstAt)).toBe(false);
  expect((await row()).is_active).toBe(true);
 });
 it.each(['phoenix','flash','paused'])('excluded.%s.has.no.increment',async protocol=>{
  await pool.query('UPDATE trading_bots SET active_protocol=$1,is_active=$2',[protocol==='paused'?'pacifica':protocol,protocol!=='paused']);
  expect(await store.incrementSignalKeyFailure('EXAMPLE','agent_decrypt')).toBeUndefined();expect((await row()).streak).toBeNull();
 });
 it('atomic.pause.returns.only.one.transition',async()=>{
  await increment();await increment();const streak=await increment();const claim=await store.claimSignalKeyFailureAlert('EXAMPLE',streak.firstAt);
  expect((await Promise.all([1,2,3].map(()=>store.pauseActiveSignalBot('EXAMPLE','EXAMPLE',streak!.firstAt,claim as string)))).filter(Boolean)).toHaveLength(1);
 });
 it('subscription.transition.returning.is.exactly.once',async()=>{
  await pool.query("INSERT INTO bot_subscriptions(id,subscriber_bot_id,status) VALUES ('EXAMPLE_SUB','EXAMPLE_BOT','active')");
  expect((await Promise.all([1,2,3].map(()=>store.markBotSubscriptionPausedBySubscriberBotId('EXAMPLE_BOT','execution_disabled')))).filter(Boolean)).toHaveLength(1);
 });
 it('r3.stale.lease.cannot.pause.winner.owes.notice',async()=>{
  await increment();await increment();const streak=await increment();const a=await store.claimSignalKeyFailureAlert('EXAMPLE',streak.firstAt);
  await pool.query("UPDATE trading_bots SET stats=jsonb_set(stats,'{signalKeyFailures,claimedAt}',to_jsonb((now()-interval '121 seconds')::text))");
  const b=await store.claimSignalKeyFailureAlert('EXAMPLE',streak.firstAt);
  expect(b).toBeTruthy();expect(await store.pauseActiveSignalBot('EXAMPLE','EXAMPLE',streak.firstAt,a as string)).toBeUndefined();expect((await row()).is_active).toBe(true);
  expect(await store.pauseActiveSignalBot('EXAMPLE','EXAMPLE',streak.firstAt,b as string)).toBeDefined();
  expect((await row()).streak).toMatchObject({outcome:'paused',alertedAt:null,claimedAt:b});
  await pool.query("UPDATE trading_bots SET stats=jsonb_set(stats,'{signalKeyFailures,claimedAt}',to_jsonb((now()-interval '121 seconds')::text))");
  const claims=await Promise.all([1,2].map(()=>store.reclaimPausedSignalKeyFailureNotice('EXAMPLE')));expect(claims.filter(Boolean)).toHaveLength(1);
  const c=claims.find(Boolean)!;expect(await store.setSignalKeyFailurePauseOutcome('EXAMPLE',c.firstAt,'paused',c.claimedAt!)).toBe(true);
  expect(await store.reclaimPausedSignalKeyFailureNotice('EXAMPLE')).toBeUndefined();
 });
 it.each([null,{}, {totalPnl:4}])('r3.resume.without.streak.preserves.%j',async stats=>{
  await pool.query('UPDATE trading_bots SET is_active=false,stats=$1',[stats]);await store.updateTradingBot('EXAMPLE',{isActive:true});expect((await row()).stats).toEqual(stats);
 });
 it('r3.resume.removes.only.streak.in.stored.and.supplied.stats',async()=>{
  await increment();await pool.query("UPDATE trading_bots SET stats=stats || '{\"totalPnl\":4}'::jsonb");
  await store.updateTradingBot('EXAMPLE',{isActive:true});expect((await row()).stats).toEqual({totalPnl:4});
  await store.updateTradingBot('EXAMPLE',{isActive:true,stats:{totalPnl:9,signalKeyFailures:{count:3}} as any});expect((await row()).stats).toEqual({totalPnl:9});
 });

 it.each(['legacy','key'] as const)('r4.pause.updatedAt.%s',async mode=>{
  let first:string|undefined,claim:string|undefined;
  if(mode==='key'){await increment();await increment();const streak=await increment();first=streak.firstAt;claim=await store.claimSignalKeyFailureAlert('EXAMPLE',first) as string;}
  expect(await store.pauseActiveSignalBot('EXAMPLE','EXAMPLE',first,claim)).toBeDefined();
  expect((await row()).updated_at.toISOString()==='2026-01-01T00:00:00.000Z').toBe(mode==='key');
 });
 it('r4.owed.pause.survives.signing.clear.and.crash.recovery',async()=>{
  await increment();await increment();const streak=await increment();const claim=await store.claimSignalKeyFailureAlert('EXAMPLE',streak.firstAt);
  await store.pauseActiveSignalBot('EXAMPLE','EXAMPLE',streak.firstAt,claim as string);
  await store.clearSignalKeyFailures('EXAMPLE');expect((await row()).streak).toMatchObject({outcome:'paused',alertedAt:null});
  await pool.query("UPDATE trading_bots SET stats=jsonb_set(stats,'{signalKeyFailures,claimedAt}',to_jsonb((now()-interval '121 seconds')::text))");
  const claims=await Promise.all([1,2].map(()=>store.reclaimPausedSignalKeyFailureNotice('EXAMPLE')));expect(claims.filter(Boolean)).toHaveLength(1);
  const winner=claims.find(Boolean)!;await store.setSignalKeyFailurePauseOutcome('EXAMPLE',winner.firstAt,'paused',winner.claimedAt!);
  expect(await store.reclaimPausedSignalKeyFailureNotice('EXAMPLE')).toBeUndefined();
  await store.clearSignalKeyFailures('EXAMPLE');expect((await row()).streak).toBeNull();
 });

 it('r10.active.and.inactive.listings.veto.atomic.pause',async()=>{
  await increment();await increment();const streak=await increment();const claim=await store.claimSignalKeyFailureAlert('EXAMPLE',streak.firstAt);
  await pool.query("INSERT INTO published_bots(id,trading_bot_id,is_active) VALUES ('EXAMPLE_LISTING','EXAMPLE',true)");
  expect(await store.pauseActiveSignalBot('EXAMPLE','EXAMPLE',streak.firstAt,claim as string)).toBeUndefined();
  expect((await row()).is_active).toBe(true);
  await pool.query("UPDATE published_bots SET is_active=false");
  expect(await store.pauseActiveSignalBot('EXAMPLE','EXAMPLE',streak.firstAt,claim as string)).toBeUndefined();
  expect((await row()).is_active).toBe(true);
 });

 it('r10.warning.refresh.rejects.inactive.bot.without.changing.lease', async () => {
  await increment(); await increment(); const streak = await increment();
  const claim = await store.claimSignalKeyFailureAlert('EXAMPLE', streak.firstAt);
  expect(claim).toBeTruthy();
  await pool.query("UPDATE trading_bots SET is_active=false WHERE id='EXAMPLE'");
  expect(await store.refreshSignalKeyFailureAlert('EXAMPLE', streak.firstAt, claim as string, true)).toBe(false);
  expect((await row()).streak.claimedAt).toBe(claim);
 });

 it('r7.stale.claimant.cannot.complete.takeover.lease',async()=>{
  await increment();await increment();const streak=await increment();const lease=await store.claimSignalKeyFailureAlert('EXAMPLE',streak.firstAt);expect(lease).toBeTruthy();
  await pool.query("UPDATE trading_bots SET stats=jsonb_set(stats,'{signalKeyFailures,claimedAt}',to_jsonb((now()-interval '121 seconds')::text))");
  const takeover=await store.claimSignalKeyFailureAlert('EXAMPLE',streak.firstAt);expect(takeover).toBeTruthy();expect(takeover).not.toBe(lease);
  expect(await store.setSignalKeyFailurePauseOutcome('EXAMPLE',streak.firstAt,'already_paused',lease as string)).toBe(false);
  expect((await row()).streak).toMatchObject({claimedAt:takeover,outcome:null,alertedAt:null});
  expect(await store.claimSignalKeyFailureAlert('EXAMPLE',streak.firstAt)).toBe(false);
  expect(await store.setSignalKeyFailurePauseOutcome('EXAMPLE',streak.firstAt,'not_flat',takeover as string)).toBe(true);
  expect((await row()).streak).toMatchObject({claimedAt:takeover,outcome:'not_flat',alertedAt:expect.any(String)});
  expect((await row()).updated_at.toISOString()).toBe('2026-01-01T00:00:00.000Z');
 });
 it.each(['paused','active'] as const)('r8.refresh.fences.generation.and.lease.%s',async mode=>{
  await increment();await increment();const streak=await increment();
  await store.claimSignalKeyFailureAlert('EXAMPLE',streak.firstAt);
  await pool.query("UPDATE trading_bots SET stats=jsonb_set(stats,'{signalKeyFailures,claimedAt}',to_jsonb((now()-interval '121 seconds')::text))");
  const expired=(await row()).streak.claimedAt;
  if(mode==='paused')await store.pauseActiveSignalBot('EXAMPLE','EXAMPLE',streak.firstAt,expired);
  const refreshed=await store.refreshSignalKeyFailureAlert('EXAMPLE',streak.firstAt,expired);
  expect(refreshed).toBeTruthy();expect(refreshed).not.toBe(expired);
  const snapshot=await row();
  expect(await store.refreshSignalKeyFailureAlert('EXAMPLE','EXAMPLE_OTHER',refreshed as string)).toBe(false);
  expect(await store.refreshSignalKeyFailureAlert('EXAMPLE',streak.firstAt,expired)).toBe(false);
  expect(await row()).toEqual(snapshot);
  expect(await store.claimSignalKeyFailureAlert('EXAMPLE',streak.firstAt)).toBe(false);
  expect(await store.reclaimPausedSignalKeyFailureNotice('EXAMPLE')).toBeUndefined();
  expect(await store.setSignalKeyFailurePauseOutcome('EXAMPLE',streak.firstAt,mode==='paused'?'paused':'not_flat',expired)).toBe(false);
  expect(await store.setSignalKeyFailurePauseOutcome('EXAMPLE',streak.firstAt,mode==='paused'?'paused':'not_flat',refreshed as string)).toBe(true);
  expect((await row()).updated_at.toISOString()).toBe('2026-01-01T00:00:00.000Z');
 });
 it.each(['paused','active'] as const)('r8.takeover.prevents.old.refresh.with.no.write.%s',async mode=>{
  await increment();await increment();const streak=await increment();
  await store.claimSignalKeyFailureAlert('EXAMPLE',streak.firstAt);
  await pool.query("UPDATE trading_bots SET stats=jsonb_set(stats,'{signalKeyFailures,claimedAt}',to_jsonb((now()-interval '121 seconds')::text))");
  const expired=(await row()).streak.claimedAt;
  if(mode==='paused')await store.pauseActiveSignalBot('EXAMPLE','EXAMPLE',streak.firstAt,expired);
  const takeover=mode==='paused'?(await store.reclaimPausedSignalKeyFailureNotice('EXAMPLE'))!.claimedAt:await store.claimSignalKeyFailureAlert('EXAMPLE',streak.firstAt);
  expect(takeover).toBeTruthy();const snapshot=await row();
  expect(await store.refreshSignalKeyFailureAlert('EXAMPLE',streak.firstAt,expired)).toBe(false);
  expect(await row()).toEqual(snapshot);
  expect(await store.refreshSignalKeyFailureAlert('EXAMPLE',streak.firstAt,takeover as string)).toBeTruthy();
 });

});
