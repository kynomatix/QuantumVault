import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { phoenixMigrationFixture } from '../helpers/phoenix-schema';
import { probeSchemaMigrationManifest } from '../../server/schema-readiness';
import { aiBot, aiAuthority, clamped, now } from '../helpers/phoenix-ai';
import { buildPhoenixAiEntry } from '../../server/ai-trader/phoenix-sizing';
vi.mock('../../server/storage', () => ({ storage: {} }));
vi.mock('../../server/protocol/phoenix/accounting-runtime', () => ({ reconcilePhoenixBotAccounting: vi.fn(), phoenixAccountingTarget: vi.fn() }));
import { PhoenixAiStore } from '../../server/ai-trader/phoenix-store';
const schema = `phoenix_ai_u14_${randomUUID().replaceAll('-','')}`;
const migration = phoenixMigrationFixture().manifest.find(m=>m.id==='191-phoenix-ai-trader')!;
let pool: pg.Pool, bootstrap: pg.Pool;
const readinessQuery=(sql:string,params?:readonly unknown[])=>pool.query(
 sql.replaceAll("'public'",`'${schema}'`),
 params?.map(value=>typeof value==='string'&&value.startsWith('public.')?`${schema}.${value.slice(7)}`:value));
beforeAll(async () => {
 const url=process.env.DATABASE_URL;if(!url||new URL(url).pathname!=='/qvtest')throw new Error('Requires FRACTAL qvtest');
 bootstrap=new pg.Pool({connectionString:url});await bootstrap.query(`CREATE SCHEMA ${schema}`);
 pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:10});
 await pool.query(`CREATE TABLE trading_bots(id varchar PRIMARY KEY);
 CREATE TABLE ai_trader_bots(id varchar PRIMARY KEY,wallet_address text,protocol text NOT NULL,paper_mode boolean NOT NULL,protocol_subaccount_id text);
 CREATE TABLE ai_trader_decisions(id varchar PRIMARY KEY,bot_id varchar REFERENCES ai_trader_bots(id));`);
 await pool.query(migration.sql);
},30000);
afterAll(async()=>{await pool?.end();if(bootstrap){await bootstrap.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await bootstrap.end();}});
beforeEach(async()=>{
 await pool.query('TRUNCATE phoenix_ai_executions,ai_trader_decisions,ai_trader_bots,trading_bots');
 const b=aiBot();await pool.query("INSERT INTO trading_bots VALUES('EXAMPLE-bot')");
 await pool.query(`INSERT INTO ai_trader_bots(id,wallet_address,protocol,paper_mode,protocol_subaccount_id,phoenix_execution_bot_id,phoenix_binding)
 VALUES($1,$2,$3,$4,$5,$6,$7)`,[b.id,b.walletAddress,b.protocol,b.paperMode,b.protocolSubaccountId,b.phoenixExecutionBotId,b.phoenixBinding]);
 await pool.query("INSERT INTO ai_trader_decisions VALUES('EXAMPLE-decision','EXAMPLE-ai'),('EXAMPLE-next','EXAMPLE-ai')");
});
describe('U14 durable bindings and repeat-boot migration',()=>{
 it('repeat boot performs catalog checks without requiring an AI table DDL lock',async()=>{
  const c=await pool.connect();try{
   await c.query('BEGIN');await c.query('LOCK TABLE ai_trader_bots IN ACCESS SHARE MODE');
   const other=await pool.connect();try{await other.query("SET statement_timeout='1500ms'");await other.query(migration.sql);}finally{other.release();}
  }finally{await c.query('ROLLBACK');c.release();}
 });
 it('satisfies the real readiness descriptor in the isolated schema',async()=>{
  const readiness=await probeSchemaMigrationManifest(readinessQuery,[migration]);
  expect(readiness.unavailableCapabilities).toEqual([]);
 });
 it('detects a missing index in its own schema without relying on public tables',async()=>{
  await pool.query('DROP INDEX phoenix_ai_execution_active_unique');
  try {
   const readiness=await probeSchemaMigrationManifest(readinessQuery,[migration]);
   expect(readiness.unavailableCapabilities).toEqual(['phoenix']);
  } finally { await pool.query(migration.sql); }
 });
 it.each(['empty','null_identity','wrong_link','no_binding'])('rejects malformed %s live binding rather than accepting SQL NULL',async defect=>{
  const b=aiBot();let binding:any=b.phoenixBinding;
  if(defect==='empty')binding={};if(defect==='null_identity')binding={...binding,identity:null};
  if(defect==='wrong_link')binding={...binding,executionBotId:'EXAMPLE-other'};if(defect==='no_binding')binding=null;
  await expect(pool.query('UPDATE ai_trader_bots SET phoenix_binding=$1 WHERE id=$2',[binding,b.id])).rejects.toThrow();
 });
 it('supports paper Phoenix without live custody and refuses unprovisioned live graduation',async()=>{
  await pool.query("INSERT INTO ai_trader_bots(id,protocol,paper_mode) VALUES('EXAMPLE-paper','phoenix',true)");
  await expect(pool.query("UPDATE ai_trader_bots SET paper_mode=false WHERE id='EXAMPLE-paper'")).rejects.toThrow();
 });
 it('concurrent workers replay one immutable decision and prevent a second active execution',async()=>{
  const b=aiBot(),a=aiAuthority(),i=buildPhoenixAiEntry(b,'EXAMPLE-decision',clamped(),a,'1',now);
  const rs=await Promise.all(Array.from({length:4},()=>new PhoenixAiStore(pool,()=>now).prepare(b,'EXAMPLE-decision',i,a)));
  expect(new Set(rs.map(r=>JSON.stringify(r.intent))).size).toBe(1);
  await expect(new PhoenixAiStore(pool).prepare(b,'EXAMPLE-decision',{...i,baseUnits:'0.65'},a)).rejects.toThrow('replay');
  const next={...i,requestKey:'ai:entry:EXAMPLE-next',sequence:'2'};
  await expect(new PhoenixAiStore(pool).prepare(b,'EXAMPLE-next',next,a)).rejects.toThrow();
  expect((await pool.query('SELECT count(*) AS n FROM phoenix_ai_executions')).rows[0].n).toBe('1');
 });
});
