import {describe,expect,it} from 'vitest';
import {cycleOperation,cycleRequestDigest,normalizeCycleHistory,validateCycleFillPrices,type CycleOperationRow} from '../../server/grid-bot/cycle-history';
import {planCycleWindow} from '../../server/grid-bot/cycle-planner';
import {gridClientOrderId} from '../../server/grid-bot/order-identity';
import type {ExactGridRequest} from '../../server/grid-bot/launch-storage';
import type {GridObservation} from '../../server/grid-bot/reconciliation';
import {cyclePolicy} from './cycle-fixtures';

function fixture(){
  const policy=cyclePolicy('long',false),account='EXAMPLE_ACCOUNT';
  const levels=policy.levels.map(l=>({id:`EXAMPLE_LEVEL_${l.ordinal}`,ordinal:l.ordinal,placement_attempt:1}));
  const request:ExactGridRequest={kind:'limit',botId:policy.id,account,masterAccount:'EXAMPLE_MASTER',path:'/orders/create',operationType:'create_order',timestamp:10,expiryMs:5000,
    data:{symbol:'BTC',amount:'1',price:'80',side:'bid',reduce_only:false,client_order_id:gridClientOrderId({botId:policy.id,level:1,attempt:0,leg:'entry'})},
    authority:{policy,levelId:levels[0].id,levelAttempt:0,cycle:{ownerOrdinal:0,leg:'opening'},initialCredit:'1',recycleAllocations:[]}};
  const row:CycleOperationRow={id:'EXAMPLE_OPEN',state:'confirmed',exact_request:request,exact_request_digest:cycleRequestDigest(request),failure_classification:null,
    venue_order_id:'EXAMPLE_ORDER',level_id:levels[0].id};
  const observation:GridObservation={account,symbol:'BTC',observedAt:100,inventoryComplete:true,position:{direction:'long',size:'0.4'},mark:{price:'85',observedAt:100},
    history:{from:0,through:80,inclusive:true,publicationLagMs:0,source:'EXAMPLE_FULL'},trades:[],
    orders:[{orderId:'EXAMPLE_ORDER',clientOrderId:String(request.data.client_order_id),symbol:'BTC',side:'long',price:'80',amount:'1',filledAmount:'0.4',cancelledAmount:'0.6',
      reduceOnly:false,orderType:'limit',createdAt:10,updatedAt:50,status:'cancelled'}]};
  return {policy,account,levels,operations:[row],observation,historyComplete:true,now:100,noLand:{},
    fills:[{account,trade_id:'EXAMPLE_FILL',operation_id:row.id,venue_time:20,size:'0.4',price:'80',leg:'entry' as const}],
    orders:[{operation_id:row.id,order_id:'EXAMPLE_ORDER',status:'cancelled',filled:'0.4',remaining:'0',observed_at:100}],allocations:[]};
}
describe('complete cycle history adapter',()=>{
  it('releases only the proven unfilled residual and ignores mutable anchor roles',()=>{
    const f=fixture(),r=normalizeCycleHistory(f);
    expect(r.cycles[0]).toMatchObject({held:'0.4',initialCredit:'0.6',openingCredit:'0.6',liveOpening:[]});
    expect(r.input.operations[0]).toMatchObject({cycleOrdinal:0,leg:'opening',side:'buy'});
  });
  it('keeps a post-only rejection retryable after complete terminal history without losing initial credit',()=>{
    const f=fixture(),op=f.operations[0];op.state='failed';op.failure_classification='expected_rejection';
    f.fills=[];f.observation.position!.size='0';Object.assign(f.observation.orders[0],{status:'rejected',reason:'post_only_rejected',filledAmount:'0',cancelledAmount:'0'});
    Object.assign(f.orders[0],{status:'rejected',filled:'0'});
    f.observation.history!.through=40;
    expect(normalizeCycleHistory(f).cycles[0]).toMatchObject({initialCredit:'0',openingCommitments:'1',liveOpening:[op.id]});
    f.observation.history!.through=80;
    const replay=normalizeCycleHistory(f);
    expect(replay.cycles[0]).toMatchObject({initialCredit:'1',openingCredit:'1',openingCommitments:'0',liveOpening:[]});
    const retry=planCycleWindow({cycles:replay.cycles,direction:'long',levels:f.levels.map(l=>({...l,attempt:l.placement_attempt})),owned:[],positionSize:'0',
      bookPrice:'85',lot:'0.001',minimumQuote:'1',freeSlots:100,inventoryComplete:true,entriesAllowed:true,canaryRemaining:'1000'}).chunks.flat();
    expect(retry).toContainEqual(expect.objectContaining({kind:'place',level:expect.objectContaining({id:f.levels[0].id,size:'1',reduceOnly:false,attempt:1})}));
  });
  it('accepts the monitor neutral long label for an empty short account',()=>{
    const f=fixture();f.policy=cyclePolicy('short',false);f.operations=[];f.fills=[];f.orders=[];f.observation.orders=[];f.observation.position!.size='0';
    expect(normalizeCycleHistory(f).cycles.every(c=>c.held==='0')).toBe(true);
    f.observation.position!.size='0.1';expect(()=>normalizeCycleHistory(f)).toThrow('account inventory');
  });
  it('retains all uncertain opening commitment until terminal history catches up',()=>{
    const f=fixture();f.observation.history!.through=40;
    expect(normalizeCycleHistory(f).cycles[0]).toMatchObject({held:'0.4',initialCredit:'0',openingCommitments:'0.6',liveOpening:['EXAMPLE_OPEN']});
  });
  it('checks immutable request digest, full position parity and fill price',()=>{
    const changed=fixture();changed.operations[0].exact_request.data.amount='0.9';
    expect(()=>normalizeCycleHistory(changed)).toThrow('Corrupt cycle');
    const wrongPosition=fixture();wrongPosition.observation.position!.size='0.5';expect(()=>normalizeCycleHistory(wrongPosition)).toThrow('full account position');
    const wrongPrice=fixture();wrongPrice.fills[0].price='80.01';expect(()=>normalizeCycleHistory(wrongPrice)).toThrow('signed limit endpoint');
    const incomplete=fixture();incomplete.historyComplete=false;expect(()=>normalizeCycleHistory(incomplete)).toThrow();
  });
  it('rejects a foreign cycle owner even when the endpoint price overlaps',()=>{
    const f=fixture(),r=structuredClone(f.operations[0].exact_request);r.authority.cycle={ownerOrdinal:1,leg:'opening'};
    expect(()=>cycleOperation(f.policy,f.account,f.levels,'EXAMPLE_OTHER',r)).toThrow('Signed cycle authority');
  });
  it('keeps the first complete terminal proof stable across later full scans',()=>{
    const f=fixture(),proof={requestDigest:f.operations[0].exact_request_digest,orderId:'EXAMPLE_ORDER',filledSize:'0.4',terminalAt:50,historyThrough:80,observedAt:100};
    f.now=200;f.observation.observedAt=200;f.observation.history!.through=180;f.orders[0].observed_at=200;
    const result=normalizeCycleHistory({...f,terminals:{EXAMPLE_OPEN:proof}});
    expect(result.input.progress[0]).toMatchObject({observedAt:100,historyThrough:80});
    expect(()=>normalizeCycleHistory({...f,terminals:{EXAMPLE_OPEN:{...proof,filledSize:'0.5'}}})).toThrow('terminal proof');
  });
  it('checks endpoint prices and actual reduce-only legs before economic-ledger use',()=>{
    const f=fixture(),fill={operationId:'EXAMPLE_OPEN',price:'80.01',leg:'entry'};
    expect(()=>validateCycleFillPrices(f.policy,f.operations,[fill])).toThrow('signed endpoint');
    expect(()=>validateCycleFillPrices(f.policy,f.operations,[{...fill,price:'79.99'}])).not.toThrow();
    expect(()=>validateCycleFillPrices(f.policy,f.operations,[{...fill,price:'80',leg:'exit'}])).toThrow('identity');
  });
  it.each(['cancelled','rejected'] as const)('replays close allocations after %s releases the unused residual',status=>{
    const f=fixture(),request:ExactGridRequest={...structuredClone(f.operations[0].exact_request),timestamp:60,
      data:{symbol:'BTC',amount:'0.4',price:'90',side:'ask',reduce_only:true,client_order_id:gridClientOrderId({botId:f.policy.id,level:1,attempt:1,leg:'profit'})},
      authority:{policy:f.policy,levelId:f.levels[0].id,levelAttempt:1,cycle:{ownerOrdinal:0,leg:'closing'},fillAllocations:[{tradeId:'EXAMPLE_FILL',size:'0.4'}]}};
    const close:CycleOperationRow={...f.operations[0],id:'EXAMPLE_CLOSE',exact_request:request,exact_request_digest:cycleRequestDigest(request),venue_order_id:'EXAMPLE_CLOSE_ORDER'};
    if(status==='rejected'){close.state='failed';close.failure_classification='expected_rejection';}
    const filled=status==='rejected'?'0':'0.1',remaining=status==='rejected'?'0.4':'0.3';
    const data={...f,operations:[...f.operations,close],allocations:[{operation_id:close.id,account:f.account,trade_id:'EXAMPLE_FILL',size:'0.4',released_size:remaining}],
      fills:[...f.fills,...(status==='rejected'?[]:[{account:f.account,trade_id:'EXAMPLE_EXIT_FILL',operation_id:close.id,venue_time:70,size:'0.1',price:'90',leg:'exit' as const}])],
      orders:[...f.orders,{operation_id:close.id,order_id:'EXAMPLE_CLOSE_ORDER',status,filled,remaining:'0',observed_at:100}],
      observation:{...f.observation,position:{direction:'long' as const,size:remaining},orders:[...f.observation.orders,{...f.observation.orders[0],orderId:'EXAMPLE_CLOSE_ORDER',
        clientOrderId:String(request.data.client_order_id),side:'short' as const,price:'90',amount:'0.4',filledAmount:filled,cancelledAmount:status==='rejected'?'0':'0.3',status,reason:status==='rejected'?'post_only_rejected':null,reduceOnly:true,createdAt:60,updatedAt:80}]}};
    const replay=normalizeCycleHistory(data);
    expect(replay.cycles[0]).toMatchObject({held:remaining,openingCredit:status==='rejected'?'0.6':'0.7',liveClosing:[],availableEntryLots:[{tradeId:'EXAMPLE_FILL',size:remaining}]});
    const retry=planCycleWindow({cycles:replay.cycles,direction:'long',levels:f.levels.map(l=>({...l,attempt:2})),owned:[],positionSize:remaining,
      bookPrice:'85',lot:'0.001',minimumQuote:'1',freeSlots:100,inventoryComplete:true,entriesAllowed:true,canaryRemaining:'1000'}).chunks.flat();
    expect(retry).toContainEqual(expect.objectContaining({kind:'place',level:expect.objectContaining({id:f.levels[0].id,size:remaining,reduceOnly:true,attempt:2})}));
    data.allocations[0].size='0.1';expect(()=>normalizeCycleHistory(data)).toThrow('Durable cycle allocations');
  });
  it('accepts explicit no-land proof only with matching digest and no venue evidence',()=>{
    const f=fixture();f.fills=[];f.orders=[];f.observation.orders=[];f.observation.position!.size='0';f.operations[0].state='failed';
    const noLand={EXAMPLE_OPEN:{requestDigest:f.operations[0].exact_request_digest,at:50}};
    expect(normalizeCycleHistory({...f,noLand}).cycles[0].openingCredit).toBe('1');
    expect(()=>normalizeCycleHistory({...f,noLand:{EXAMPLE_OPEN:{...noLand.EXAMPLE_OPEN,requestDigest:'EXAMPLE_DIGEST'}}})).toThrow('no-land proof');
  });
});
