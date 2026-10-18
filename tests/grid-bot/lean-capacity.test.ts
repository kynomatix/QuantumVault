import {describe,it,expect} from 'vitest';
import {cycleCapacity,requireCycleCapacity} from '../../server/grid-bot/cycle-capacity';
import {replayGridCycles} from '../../server/grid-bot/cycle-replay';
import {planCycleWindow} from '../../server/grid-bot/cycle-planner';
import {projectCycleOrders} from '../../server/grid-bot/cycle-projection';
import {cyclePolicy,history,operation,fill,terminal} from './cycle-fixtures';
function fixture(){const p={...cyclePolicy('long',false),totalInvestment:'120.00',sizingVersion:'lean-1' as const,safetyEnvelopePrice:'120.00000000'};return history(p);}
function opened(){const h=fixture(),op={...operation(h.policy,'EXAMPLE_OPEN',0,'opening','1',1),initialCredit:'1'};h.operations.push(op);return {h,op};}
describe('durable shared capital pool',()=>{
  it('escrows a whole candidate, retains credit on denial and survives serialization/restart',()=>{
    const {h,op}=opened(),candidate={...operation(h.policy,'EXAMPLE_SECOND',1,'opening','1',2),initialCredit:'1'};
    expect(cycleCapacity(h,'95')).toMatchObject({used:'120',remaining:'0'});
    expect(()=>requireCycleCapacity(cycleCapacity(h,'95',candidate))).toThrow('Waiting for room');
    expect(cycleCapacity(JSON.parse(JSON.stringify(h)),'95')).toEqual(cycleCapacity(h,'95'));
    const replay=replayGridCycles(h);if(!replay.ok)throw Error(replay.reason);
    expect(replay.cycles[1].openingCredit).toBe('1');
    expect(h.operations).toEqual([op]);
  });
  it('moves a known partial fill to held without freeing money, retaining full uncertainty',()=>{
    const {h,op}=opened();h.fills.push(fill(op,'EXAMPLE_PARTIAL','0.4',2));
    expect(cycleCapacity(h,'95')).toMatchObject({held:'48',reserved:'120',used:'168',remaining:'0'});
    h.progress.push({operationId:op.id,state:'live',observedAt:3,filledSize:'0.4',remainingSize:'0.6'});
    expect(cycleCapacity(h,'95')).toMatchObject({held:'48',reserved:'72',used:'120'});
    h.progress[0].remainingSize='0.3';expect(cycleCapacity(h,'95')?.used).toBe('120');
    h.progress[0]={...terminal(op,'0.4',5),historyThrough:4,observedAt:6};
    expect(cycleCapacity(h,'95')?.used).toBe('168');
    h.progress[0]=terminal(op,'0.4',5);expect(cycleCapacity(h,'95')).toMatchObject({used:'48',remaining:'72'});
  });
  it('releases held money only for a proven close and then admits an exact waiting candidate',()=>{
    const {h,op}=opened();h.fills.push(fill(op,'EXAMPLE_ENTRY','1',2));h.progress.push(terminal(op,'1',3));
    const close=operation(h.policy,'EXAMPLE_CLOSE',0,'closing','1',4);h.operations.push(close);
    h.allocations.push({operationId:close.id,cycleOrdinal:0,tradeId:'EXAMPLE_ENTRY',size:'1'});
    expect(cycleCapacity(h,'85')?.used).toBe('120');
    h.fills.push(fill(close,'EXAMPLE_EXIT','1',5));h.progress.push(terminal(close,'1',6));
    expect(cycleCapacity(h,'85')?.remaining).toBe('120');
    const candidate={...operation(h.policy,'EXAMPLE_REOPEN',1,'opening','1',7),initialCredit:'1'};
    expect(()=>requireCycleCapacity(cycleCapacity(h,'95',candidate))).not.toThrow();
  });
  it('never claims deferred profit quota before a request and never displaces held inventory',()=>{
    const h=fixture();expect(cycleCapacity(h,'95')?.used).toBe('0');
    const {h:full,op}=opened();full.fills.push(fill(op,'EXAMPLE_HELD','1',2));full.progress.push(terminal(op,'1',3));
    const replay=replayGridCycles(full);if(!replay.ok)throw Error(replay.reason);
    const pool=cycleCapacity(full,'95')!;
    const views=projectCycleOrders(replay.cycles,full.progress,'long','0.001','1','95',true,pool);
    expect(views.find(v=>v.ownerOrdinal===1&&v.leg==='opening')).toMatchObject({state:'waiting for room',size:'1'});
    const plan=planCycleWindow({cycles:replay.cycles,direction:'long',levels:full.policy.levels.map(l=>({id:'EXAMPLE_LEVEL_'+l.ordinal,ordinal:l.ordinal,attempt:0})),
      owned:[],positionSize:'1',bookPrice:'95',lot:'0.001',minimumQuote:'1',freeSlots:100,inventoryComplete:true,entriesAllowed:true,canaryRemaining:'1000',pool});
    expect(plan.chunks.flat().some(a=>a.kind==='place'&&!a.level.reduceOnly)).toBe(false);
    expect(plan.levels.find(l=>l.ordinal===2&&!l.reduceOnly)?.size).toBe('1');
    expect(replay.cycles[0].held).toBe('1');
  });
  it('blocks openings above the signed envelope and ignores the pool for unmarked policies',()=>{
    const h=fixture();expect(()=>requireCycleCapacity(cycleCapacity(h,'121'))).toThrow('Waiting for room');
    expect(cycleCapacity(history(cyclePolicy()),'121')).toBeUndefined();
  });
});
