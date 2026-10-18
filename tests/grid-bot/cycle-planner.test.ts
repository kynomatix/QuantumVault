import {describe,expect,it} from 'vitest';
import {GridMonitorService} from '../../server/grid-bot/monitor-service';
import {planCycleWindow} from '../../server/grid-bot/cycle-planner';
import {projectCycleOrders} from '../../server/grid-bot/cycle-projection';
import {replayGridCycles,type CycleReplayInput} from '../../server/grid-bot/cycle-replay';
import {cyclePolicy,history,seeded,operation,fill,terminal} from './cycle-fixtures';
function cycles(h:CycleReplayInput){const r=replayGridCycles(h);if(!r.ok)throw Error(r.reason);return r.cycles;}
function plan(h:CycleReplayInput,extra:Partial<Parameters<typeof planCycleWindow>[0]>={}){
  const replay=cycles(h);
  return planCycleWindow({cycles:replay,direction:h.policy.direction,levels:h.policy.levels.map(l=>({id:`EXAMPLE_LEVEL_${l.ordinal}`,ordinal:l.ordinal,attempt:0})),
    owned:[],positionSize:String(replay.reduce((s,c)=>s+Number(c.held),0)),bookPrice:'95',lot:'0.001',minimumQuote:'1',freeSlots:100,
    inventoryComplete:true,entriesAllowed:true,canaryRemaining:'1000',...extra});
}
describe('cycle windows and live projections',()=>{
  it('permits v2 provisioning openings and keeps paused openings off in the production planner',async()=>{
    const h=history(cyclePolicy('long',false)),bot={direction:'long',status:'provisioning'};
    const storage={planningState:async()=>({cycle:{cycles:cycles(h)},levels:h.policy.levels.map(l=>({id:`EXAMPLE_LEVEL_${l.ordinal}`,ordinal:l.ordinal,placement_attempt:0})),
      observation:{position:{size:'0'},inventoryComplete:true},entriesAllowed:true,authority:{}}),snapshot:async()=>({bot})};
    const service=new GridMonitorService({storage:storage as any,observe:async()=>{throw Error('EXAMPLE unused');}});
    const input={owned:[],bookPrice:'95',lot:'0.001',minimumQuote:'1',freeSlots:100,canaryRemaining:'1000'};
    expect((await service.plan({} as any,input)).chunks.flat().some(a=>a.kind==='place'&&!a.level.reduceOnly)).toBe(true);
    bot.status='paused';expect((await service.plan({} as any,input)).chunks.flat()).toEqual([]);
  });
  it.each(['long','short'] as const)('places backed %s exits before recycling and keeps credit while paused',direction=>{
    const h=seeded(direction),owner=direction==='long'?2:1,close=operation(h.policy,'EXAMPLE_CLOSE',owner,'closing','0.4',4);
    h.operations.push(close);h.fills.push(fill(close,'EXAMPLE_CLOSE_FILL','0.4',5));h.progress.push(terminal(close,'0.4',6));
    h.allocations.push({operationId:close.id,cycleOrdinal:owner,tradeId:'EXAMPLE_SEED_FILL',size:'0.4'});
    const actions=plan(h).chunks.flat(),firstOpening=actions.findIndex(a=>a.kind==='place'&&!a.level.reduceOnly);
    expect(firstOpening).toBeGreaterThan(0);expect(actions.slice(0,firstOpening).every(a=>a.kind==='place'&&a.level.reduceOnly)).toBe(true);
    const recycled=actions.find(a=>a.kind==='place'&&!a.level.reduceOnly&&a.level.cycle?.ownerOrdinal===owner);
    expect(recycled).toMatchObject({kind:'place',level:{size:'0.4',initialCredit:'0',recycleAllocations:[{tradeId:'EXAMPLE_CLOSE_FILL',size:'0.4'}]}});
    expect(plan(h,{entriesAllowed:false}).chunks.flat().every(a=>a.kind==='place'&&a.level.reduceOnly)).toBe(true);
    expect(cycles(h).find(c=>c.cycle.ownerOrdinal===owner)?.openingCredit).toBe('0.4');
    const view=projectCycleOrders(cycles(h),h.progress,direction,'0.001','1','95',false);
    expect(view.find(v=>v.ownerOrdinal===owner&&v.leg==='opening')).toMatchObject({state:'paused',size:'0.4'});
  });
  it('keeps overlapping endpoints under separate owners',()=>{
    const h=history(cyclePolicy('long',false)),actions=plan(h).chunks.flat();
    const openings=actions.filter(a=>a.kind==='place'&&Number(a.level.price)===90);
    expect(openings).toHaveLength(2);
    expect(new Set(openings.map(a=>a.kind==='place'&&a.level.cycle!.ownerOrdinal)).size).toBe(2);
  });
  it('places a partial opening fill on its closing leg while retaining the opening order',()=>{
    const h=history(cyclePolicy('long',false)),op={...operation(h.policy,'EXAMPLE_OPEN',0,'opening','1',1),initialCredit:'1',recycleAllocations:[]};
    h.operations.push(op);h.fills.push(fill(op,'EXAMPLE_PARTIAL','0.4',2));h.progress.push({operationId:op.id,state:'live',observedAt:3,filledSize:'0.4',remainingSize:'0.6'});
    const p=plan(h,{bookPrice:'85',owned:[{levelId:'EXAMPLE_LEVEL_1',orderId:'EXAMPLE_ORDER',clientOrderId:'EXAMPLE_CLIENT',remaining:'0.6',reduceOnly:false,cycleLeg:'opening'}]});
    expect(p.chunks.flat()).toEqual([expect.objectContaining({kind:'place',level:expect.objectContaining({size:'0.4',reduceOnly:true,cycle:{ownerOrdinal:0,leg:'closing'}})})]);
    expect(p.allocations['EXAMPLE_LEVEL_1:closing']).toEqual([{tradeId:'EXAMPLE_PARTIAL',size:'0.4'}]);
  });
  it('places proven fills while the vanished terminal leg retains its uncertain residual',()=>{
    const h=history(cyclePolicy('long',false)),op={...operation(h.policy,'EXAMPLE_OPEN',0,'opening','1',1),initialCredit:'1',recycleAllocations:[]};
    h.operations.push(op);h.fills.push(fill(op,'EXAMPLE_FILL','0.4',5));
    h.progress.push({operationId:op.id,state:'terminal',filledSize:'0.4',terminalAt:20,historyThrough:10,observedAt:30});
    expect(cycles(h)[0]).toMatchObject({openingCommitments:'0.6',liveOpening:[op.id]});
    expect(plan(h,{bookPrice:'85'}).chunks.flat()).toEqual([expect.objectContaining({kind:'place',level:expect.objectContaining({size:'0.4',reduceOnly:true})})]);
  });
  it('shows fill, price and minimum waits without fabricating orders',()=>{
    const h=history(cyclePolicy('long',false)),view=projectCycleOrders(cycles(h),[],'long','0.001','1','95',true);
    expect(view.find(v=>v.ownerOrdinal===0&&v.leg==='closing')?.state).toBe('waiting for fills');
    expect(view.find(v=>v.ownerOrdinal===4&&v.leg==='opening')?.state).toBe('waiting for price');
    expect(projectCycleOrders(cycles(h),[],'long','0.001','1000','95',true).find(v=>v.leg==='opening')).toMatchObject({size:'0',state:'waiting for minimum'});
  });
});
