import {beforeAll,afterAll,it,expect} from 'vitest';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {storage} from '../../server/storage';
import {pool,closePool} from '../../server/db';
let botId:string;
const observations:unknown[]=[];
beforeAll(async()=>{botId=(await storage.createAiTraderBot({walletAddress:'synthetic-pagination-discovery',protocol:'pacifica',market:'SOL-PERP',timeframe:'1h',allocatedUsdc:'100',graduationCriteria:{periodDays:30,minTrades:10,minNetPnl:0,maxDrawdownPct:30},policyHmac:'fixture-only'} as any)).id;});
afterAll(async()=>{if(process.env.QV_DISCOVERY_ARTIFACT)writeFileSync(join(process.env.QV_DISCOVERY_ARTIFACT!,'precision-observations.json'),JSON.stringify(observations,null,2)+'\n');if(botId){await pool.query('DELETE FROM ai_trader_decisions WHERE bot_id=$1',[botId]);await pool.query('DELETE FROM ai_trader_bots WHERE id=$1',[botId]);}await closePool();});
for(const fixture of [
 {name:'distinct whole-millisecond timestamps',times:['125000','124000','123000','122000','121000'],outcomes:'all'},
 {name:'distinct microseconds within one millisecond',times:['123900','123800','123700','123600','123500'],outcomes:'all'},
 {name:'exact equal microsecond timestamp with ID tie-break',times:['123900','123900','123900','123900','123900'],outcomes:'all'},
 {name:'executed filter with sub-millisecond rows',times:['123900','123800','123700','123600','123500'],outcomes:'executed'},
 {name:'non-flat filter with sub-millisecond rows',times:['123900','123800','123700','123600','123500'],outcomes:'non_flat'},
] as const){
 it('preserves every history row: '+fixture.name,async()=>{
  await pool.query('DELETE FROM ai_trader_decisions WHERE bot_id=$1',[botId]);
  for(let i=0;i<fixture.times.length;i++)await pool.query('INSERT INTO ai_trader_decisions(id,bot_id,raw_decision,outcome,decided_at) VALUES($1,$2,$3::jsonb,$4,$5::timestamp)',['precision-'+(5-i),botId,JSON.stringify({action:'flat'}),i===1?'flat':'executed','2026-01-02 03:04:05.'+fixture.times[i]]);
  const raw=(await pool.query(`SELECT id,outcome,to_char(decided_at,'YYYY-MM-DD HH24:MI:SS.US') AS exact_timestamp FROM ai_trader_decisions WHERE bot_id=$1 ORDER BY decided_at DESC,id DESC`,[botId])).rows;
  const expected=raw.filter(r=>fixture.outcomes==='executed'?r.outcome==='executed':fixture.outcomes==='non_flat'?r.outcome!=='flat':true).map(r=>r.id);
  const pages:unknown[]=[];const actual:string[]=[];let before:Date|undefined,beforeId:string|undefined;
  for(let page=0;page<5;page++){
   const result=await storage.getAiTraderDecisionsPaged(botId,2,{outcomes:fixture.outcomes,before,beforeId});
   pages.push({rows:result.rows.map(r=>({id:r.id,decidedAt:r.decidedAt?.toISOString()})),nextCursor:result.nextCursor});actual.push(...result.rows.map(r=>r.id));
   if(!result.nextCursor)break;before=new Date(result.nextCursor.before);beforeId=result.nextCursor.beforeId;
  }
  observations.push({fixture,raw,expected,actual,pages});
  expect(new Set(actual).size).toBe(actual.length);
  expect(actual).toEqual(expected);
 });
}

async function seed(extraOwner=false){
 await pool.query('DELETE FROM ai_trader_decisions WHERE bot_id=$1',[botId]);
 for(let i=5;i>=1;i--)await pool.query("INSERT INTO ai_trader_decisions(id,bot_id,raw_decision,outcome,decided_at) VALUES($1,$2,'{}','executed',$3::timestamp)",['extra-'+i,botId,'2026-01-02 03:04:05.123'+i+'00']);
 if(extraOwner){const other=(await storage.createAiTraderBot({walletAddress:'synthetic-other-'+Math.random(),protocol:'pacifica',market:'SOL-PERP',timeframe:'1h',allocatedUsdc:'100',graduationCriteria:{periodDays:30,minTrades:10,minNetPnl:0,maxDrawdownPct:30},policyHmac:'fixture-only'} as any)).id;
  await pool.query("INSERT INTO ai_trader_decisions(id,bot_id,raw_decision,outcome,decided_at) VALUES('foreign-cursor',$1,'{}','executed','2026-01-02 03:04:05.123400'::timestamp)",[other]);return other;}
}
for(const legacy of [false,true])it('exact ordering survives '+(legacy?'legacy Date':'raw precise')+' cursor transport',async()=>{
 await seed();let opts:any={},actual:string[]=[];for(let p=0;p<4;p++){const r=await storage.getAiTraderDecisionsPaged(botId,2,opts);actual.push(...r.rows.map(x=>x.id));if(!r.nextCursor)break;
  expect(r.nextCursor.before).toMatch(/\.\d{6}Z$/);expect(Object.keys(r.rows[0])).not.toContain('cursorBefore');opts={...r.nextCursor,before:legacy?new Date(r.nextCursor.before):r.nextCursor.before};}
 expect(actual).toEqual(['extra-5','extra-4','extra-3','extra-2','extra-1']);
});
for(const legacy of [false,true])it('deleted boundary is '+(legacy?'explicitly expired for legacy cursor':'usable with precise cursor'),async()=>{
 await seed();const first=await storage.getAiTraderDecisionsPaged(botId,2);const cursor=first.nextCursor!;await pool.query('DELETE FROM ai_trader_decisions WHERE id=$1',[cursor.beforeId]);
 if(legacy)await expect(storage.getAiTraderDecisionsPaged(botId,2,{...cursor,before:new Date(cursor.before)})).rejects.toMatchObject({name:'AiTraderHistoryCursorError'});
 else expect((await storage.getAiTraderDecisionsPaged(botId,2,cursor)).rows.map(x=>x.id)).toEqual(['extra-3','extra-2']);
});
for(const legacy of [false,true])it('foreign boundary rejects without exposing other bot rows '+legacy,async()=>{
 const other=await seed(true);try{await expect(storage.getAiTraderDecisionsPaged(botId,2,{before:legacy?new Date('2026-01-02T03:04:05.123Z'):'2026-01-02T03:04:05.123400Z',beforeId:'foreign-cursor'})).rejects.toMatchObject({name:'AiTraderHistoryCursorError'});}
 finally{await pool.query('DELETE FROM ai_trader_bots WHERE id=$1',[other]);}
});
for(const before of ['2026-01-02T03:04:05.124Z','2026-01-02T03:04:05.123999Z'])it('mismatched existing boundary refuses '+before,async()=>{
 await seed();await expect(storage.getAiTraderDecisionsPaged(botId,2,{before,beforeId:'extra-4'})).rejects.toMatchObject({name:'AiTraderHistoryCursorError'});
});
for(const opts of [{before:'garbage',beforeId:'x'},{before:'2026-02-30T03:04:05.123000Z',beforeId:'x'},
 {before:'2026-01-02T14:04:05.123000+11:00',beforeId:'x'},{before:'2026-01-02T03:04:05.123Z'},
 {beforeId:'x'},{before:new Date(NaN),beforeId:'x'},{before:'2026-01-02T03:04:05.123000Z',beforeId:''}])it('invalid/partial cursor does not silently restart '+JSON.stringify(opts),async()=>{
 await seed();await expect(storage.getAiTraderDecisionsPaged(botId,2,opts)).rejects.toMatchObject({name:'AiTraderHistoryCursorError'});
});
it('insertion above a precise boundary does not duplicate prior rows or skip remaining rows',async()=>{
 await seed();const first=await storage.getAiTraderDecisionsPaged(botId,2);await pool.query("INSERT INTO ai_trader_decisions(id,bot_id,raw_decision,outcome,decided_at) VALUES('extra-new',$1,'{}','executed','2026-01-02 03:04:05.123900'::timestamp)",[botId]);
 const second=await storage.getAiTraderDecisionsPaged(botId,20,first.nextCursor!);expect(second.rows.map(x=>x.id)).toEqual(['extra-3','extra-2','extra-1']);
});


for(const asDate of [false,true])it('legacy cursor uses the actual application Date projection '+asDate,async()=>{
 await seed();
 const boundary=await storage.getAiTraderDecision('extra-4');
 expect(boundary?.decidedAt?.toISOString()).toBe('2026-01-02T03:04:05.123Z');
 const before=asDate?boundary!.decidedAt!:'2026-01-02T03:04:05.123Z';
 const page=await storage.getAiTraderDecisionsPaged(botId,2,{before,beforeId:'extra-4'});
 expect(page.rows.map(r=>r.id)).toEqual(['extra-3','extra-2']);
});
it('a null timestamp boundary preserves a null nextCursor',async()=>{
 await seed();
 await pool.query("INSERT INTO ai_trader_decisions(id,bot_id,raw_decision,outcome,decided_at) VALUES('null-boundary',$1,'{}','executed',NULL)",[botId]);
 const page=await storage.getAiTraderDecisionsPaged(botId,1);
 expect(page.rows.map(r=>r.id)).toEqual(['null-boundary']);
 expect(page.rows[0].decidedAt).toBeNull();
 expect(page.nextCursor).toBeNull();
});
