import {describe,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {readCycleState,validateLockedCycleRequest} from '../../server/grid-bot/cycle-storage';
import type {ExactGridRequest} from '../../server/grid-bot/launch-storage';
import type {GridObservation} from '../../server/grid-bot/reconciliation';
import {cyclePolicy} from './cycle-fixtures';

function fixture(){
  const policy=cyclePolicy('long',false),now=200000;
  const bot={id:policy.id,status:'active',created_at:new Date(1),protocol:policy.protocol,market:policy.market,direction:policy.direction,
    upper_price:policy.upperPrice,lower_price:policy.lowerPrice,start_price:policy.startPrice,grid_count:policy.gridCount,total_investment:policy.totalInvestment,
    leverage:policy.leverage,entry_scale_type:policy.entryScaleType,profit_scale_type:policy.profitScaleType,policy_version:policy.policyVersion,
    fee_policy_version:policy.feePolicyVersion,runtime_policy_version:policy.runtimePolicyVersion,stop_loss_percent:policy.stopLossPercent,
    stop_loss_price:policy.stopLossPrice,seed_at_creation:policy.seedAtCreation};
  const levels=policy.levels.map(l=>({id:`EXAMPLE_LEVEL_${l.ordinal}`,ordinal:l.ordinal,placement_attempt:0,price:l.price,size:l.size,side:l.side,reduce_only:l.reduceOnly}));
  const observation:GridObservation={account:'EXAMPLE_ACCOUNT',symbol:'BTC',observedAt:now,orders:[],trades:[],position:{direction:'long',size:'0'},inventoryComplete:true,
    history:{from:0,through:80000,inclusive:true,publicationLagMs:120000,source:'pacifica_full_replay_stable_last_id',lastId:'EXAMPLE_LAST'},mark:{price:'95',observedAt:now}};
  const state={boot_id:'EXAMPLE_BOOT',generation:'1',safe_through:80000,reconciled_at:new Date(now),observation,blocked_reasons:[]};
  const events=[{event_key:'canary-clock',evidence:{full:{generation:'1',safeThrough:80000,completedAt:now}}}];
  const query=vi.fn(async(sql:string)=>{
    if(sql.startsWith('SELECT id,bot_id,ordinal,price,size,side,reduce_only,status,venue_order_id,client_order_uuid,placement_attempt,cumulative_filled_size,last_filled_at,created_at,updated_at FROM grid_levels'))return {rows:levels};
    if(sql.startsWith('SELECT * FROM grid_monitor_state'))return {rows:[state]};
    if(sql.startsWith('SELECT event_key,evidence'))return {rows:events};
    if(sql.startsWith('SELECT * FROM grid_operations')||sql.startsWith('SELECT * FROM grid_exact_fills')||sql.startsWith('SELECT p.*')||sql.startsWith('SELECT a.*'))return {rows:[]};
    throw Error('EXAMPLE unexpected SQL: '+sql);
  });
  return {bot,state,events,query,c:{query} as unknown as PoolClient,now};
}
describe('locked cycle completeness gates',()=>{
  it('requires a matching durable full generation and fresh completion',async()=>{
    const f=fixture();expect((await readCycleState(f.c,f.bot,'EXAMPLE_ACCOUNT',f.now)).cycles).toHaveLength(5);
    f.events[0].evidence.full.generation='0';await expect(readCycleState(f.c,f.bot,'EXAMPLE_ACCOUNT',f.now)).rejects.toThrow('Durable complete');
    f.events[0].evidence.full.generation='1';f.events[0].evidence.full.completedAt=f.now-5000;
    await expect(readCycleState(f.c,f.bot,'EXAMPLE_ACCOUNT',f.now)).rejects.toThrow('Durable complete');
  });
  it('rejects unowned complete-account trades and position mismatch',async()=>{
    const f=fixture();f.state.observation.trades.push({tradeId:'EXAMPLE_ORPHAN',orderId:'EXAMPLE_ORDER',clientOrderId:null,symbol:'BTC',side:'open_long',time:10,size:'1',price:'80',fee:'0'});
    await expect(readCycleState(f.c,f.bot,'EXAMPLE_ACCOUNT',f.now)).rejects.toThrow('incomplete');
    f.state.observation.trades=[];f.state.observation.position!.size='1';
    await expect(readCycleState(f.c,f.bot,'EXAMPLE_ACCOUNT',f.now)).rejects.toThrow('incomplete');
  });
  it('leaves v1 admission untouched and fails closed for v2 without durable proof',async()=>{
    const f=fixture(),r:ExactGridRequest={kind:'close',botId:f.bot.id,account:'EXAMPLE_ACCOUNT',masterAccount:'EXAMPLE_MASTER',timestamp:f.now,expiryMs:5000,
      path:'/orders/create_market',operationType:'create_market_order',data:{symbol:'BTC',side:'ask',amount:'1',reduce_only:true},authority:{cycleAllocations:[]}};
    expect(await validateLockedCycleRequest(f.c,{...f.bot,policy_version:'1.0.0'},r,f.now,'EXAMPLE_CLOSE')).toBeNull();expect(f.query).not.toHaveBeenCalled();
    f.events.length=0;await expect(validateLockedCycleRequest(f.c,f.bot,r,f.now,'EXAMPLE_CLOSE')).rejects.toThrow('Durable complete');
  });
});
