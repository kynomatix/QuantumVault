import {createGridSolReader} from '../../server/grid-bot/sol-authority';
import * as provision from '../../server/grid-bot/provision';
import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {gridEntrySafety,gridRiskTrigger,reconcileGridReduction,gridOwnedLive} from '../../server/grid-bot/lifecycle-policy';
import {GridLifecycleService,gridResumeClearance,type GridLifecycleDeps,type GridSettlementFact} from '../../server/grid-bot/lifecycle-service';
import {gridTerminalFact} from '../../server/grid-bot/lifecycle-runtime';
import {reconcileGridLimit} from '../../server/grid-bot/execution';
import {requestDigest,type ExactGridRequest,type DurableGridOperation} from '../../server/grid-bot/launch-storage';
import {reconcileGridTransfer} from '../../server/grid-bot/launch-reconciliation';
import type {GridTransferEvidence} from '../../server/grid-bot/transfer-evidence';
import type {GridObservation} from '../../server/grid-bot/reconciliation';
import type {GridVenueOrder} from '../../server/grid-bot/order-identity';
const signal=()=>new AbortController().signal;
const policy={direction:'long' as const,stopLossPrice:'80',lowerPrice:'90',upperPrice:'110'};
const recycler=()=>({reuse:true,recycle:true,deployment:'EXAMPLE',expectedDeployment:'EXAMPLE',checkedAt:Date.now()});
function fixture(action:string|null='stop'){
  const now=Date.now(),claim={id:randomUUID(),leaseToken:randomUUID(),account:'EXAMPLE_SUB',masterAccount:'EXAMPLE_MASTER'};
  const request:ExactGridRequest={kind:'limit',botId:claim.id,account:claim.account,masterAccount:claim.masterAccount,path:'/orders/create',operationType:'create_order',timestamp:now,expiryMs:5000,
    data:{symbol:'BTC',price:'90',amount:'1',side:'bid',reduce_only:false,tif:'ALO',client_order_id:randomUUID()},authority:{levelId:randomUUID()}};
  const order:GridVenueOrder={orderId:'10',clientOrderId:String(request.data.client_order_id),symbol:'BTC',side:'long',price:'90',amount:'1',filledAmount:'0',cancelledAmount:'0',reduceOnly:false,orderType:'limit',status:'open',createdAt:now,updatedAt:now};
  const bot={wallet_address:'EXAMPLE_OWNER',market:'BTC-PERP',direction:'long',stop_loss_price:'80',lower_price:'90',upper_price:'110',status:action==='stop'?'stopping':action?'pausing':'active',consecutive_failures:0,sol_balance:'0.1',sol_balance_observed_at:new Date(now)};
  let life:any=action?{action,epoch:'1',active_request:randomUUID(),state:'pending',previous_status:'active'}:null;
  const observation:GridObservation={account:claim.account,symbol:'BTC',observedAt:now,inventoryComplete:true,position:{direction:'long',size:'1'},orders:[],trades:[],history:{from:0,through:now,inclusive:true,publicationLagMs:0,source:'EXAMPLE_REVIEWED'},mark:{price:'100',observedAt:now}};
  const operations:any[]=[];
  const launch={transaction:vi.fn(async(fn:any)=>fn({query:vi.fn(async()=>({rows:[]}))})),pilotExposure:vi.fn(async()=>({limitUsd:'100',exposureUsd:'0'})),read:vi.fn(async()=>null),prepare:vi.fn(async(_key:string,r:ExactGridRequest)=>{const op={id:randomUUID(),exact_request:structuredClone(r),exact_request_digest:requestDigest(r),state:'prepared',failure_classification:null};operations.push(op);return op;}),submit:vi.fn(async()=>true),settle:vi.fn(async(op:any,outcome:any)=>{op.state=outcome.state;}),expirePrepared:vi.fn(async()=>false)};
  const monitor={launch,assertLease:vi.fn(async()=>bot),planningState:vi.fn(async()=>({levels:[],fills:[],reserved:[],observation,entriesAllowed:true})),snapshot:vi.fn(async()=>({bot,operations})),reconcile:vi.fn(async()=>({entriesAllowed:true}))};
  const storage={monitor,state:vi.fn(async()=>({bot,life})),request:vi.fn(async(_wallet:string,_id:string,_key:string,act:string,evidence:any)=>{life={action:act,epoch:'2',active_request:randomUUID(),state:'pending',evidence};bot.status=act==='stop'?'stopping':'pausing';return life;}),blocked:vi.fn(async()=>{}),sol:vi.fn(async()=>{}),safetyObservation:vi.fn(async()=>{}),complete:vi.fn(async()=>{})};
  const proof:GridSettlementFact={account:claim.account,masterAccount:claim.masterAccount,observedAt:now,balance:'0',withdrawable:'0',settlementComplete:true,source:'EXAMPLE_REVIEWED',recycler:recycler()};
  const deps={storage,observe:vi.fn(async()=>observation),send:vi.fn(async(_claim:unknown,_request:ExactGridRequest)=>({rateLimited:false})),recover:vi.fn(async(_claim:unknown,_op:any)=>({state:'unknown' as const})),sol:vi.fn(async()=>({balance:'0.1',observedAt:now})),resume:vi.fn(async()=>null),settlement:vi.fn(async()=>proof),recycle:vi.fn(async()=>{})};
  const service=new GridLifecycleService(deps as unknown as GridLifecycleDeps);
  const own=(reduceOnly=false)=>{request.data.reduce_only=reduceOnly;request.data.side=reduceOnly?'ask':'bid';order.reduceOnly=reduceOnly;order.side=reduceOnly?'short':'long';observation.orders=[order];operations.push({id:randomUUID(),state:'confirmed',exact_request:request,exact_request_digest:requestDigest(request),venue_order_id:order.orderId,level_id:request.authority.levelId});};
  return {claim,request,order,bot,observation,operations,launch,monitor,storage,deps,service,proof,own,get life(){return life;}};
}
describe('Grid lifecycle boundary and failure drills',()=>{
  it.each(['authentication','quota','transport'] as const)('lifecycle recovery preserves terminal %s and never resends',async failureClass=>{
    const f=fixture();f.own();const op=f.operations[0];op.state='unconfirmed';
    f.deps.recover.mockResolvedValue({state:'rejected',requestDigest:requestDigest(f.request),failureClass,releaseSlot:true} as any);
    await f.service.tick(f.claim,signal());
    expect(f.launch.settle).toHaveBeenCalledWith(op,expect.objectContaining({state:'failed',reason:failureClass,terminalFailure:{classification:failureClass,requestDigest:requestDigest(f.request)}}),f.claim.leaseToken);
    expect(f.deps.send).not.toHaveBeenCalled();
  });
  it.each([['0.049999999',false],['0.05',true],['0.099999999',true],['0.10',true],[null,false]] as const)('SOL boundary %s entry %s',(sol,allowed)=>{
    const now=Date.now();expect(gridEntrySafety({sol,solObservedAt:now,failures:0,mark:{price:'100',observedAt:now}},now).allowed).toBe(allowed);
  });
  it.each([4,5,6])('breaker boundary %s',failures=>{const now=Date.now();expect(gridEntrySafety({sol:'1',solObservedAt:now,failures,mark:{price:'100',observedAt:now}},now).allowed).toBe(failures<5);});
  it('denies stale SOL, unknown or malformed mark without fabricating a price',()=>{const now=Date.now();for(const mark of [null,{price:'bad',observedAt:now},{price:'100',observedAt:now-5001}])expect(gridEntrySafety({sol:'1',solObservedAt:now,failures:0,mark},now).allowed).toBe(false);expect(gridEntrySafety({sol:'1',solObservedAt:now-5001,failures:0,mark:{price:'100',observedAt:now}},now).allowed).toBe(false);});
  it.each([['long','80','80','stop'],['long','80','80.01','band'],['short','120','120','stop'],['short','120','119.99','band'],['long','80','90','none'],['long','80','110','none']] as const)('%s stop %s at %s is %s',(direction,stopLossPrice,price,kind)=>{
    const now=Date.now();expect(gridRiskTrigger({...policy,direction,stopLossPrice},{price,observedAt:now},now).kind).toBe(kind);
  });
  it('requires a reachable signed stop and fresh mark; never invents PnL evidence',()=>{const now=Date.now();expect(gridRiskTrigger({...policy,stopLossPrice:null},null,now).kind).toBe('unavailable');expect(gridRiskTrigger(policy,{price:'80',observedAt:now-5001},now).kind).toBe('unavailable');expect(gridRiskTrigger(policy,{price:'80',observedAt:now},now)).toMatchObject({kind:'stop',evidence:{pnl:null,includesFunding:false}});});
  it('external cancellation requires exact CLOID, price, amount and signing window',()=>{const f=fixture();f.order.status='cancelled';f.order.cancelledAmount='1';expect(reconcileGridLimit(f.request,[f.order])).toMatchObject({state:'confirmed',orderStatus:'cancelled',releaseSlot:true});for(const delta of [{price:'91'},{amount:'2'},{createdAt:f.request.timestamp-1},{clientOrderId:randomUUID()}])expect(reconcileGridLimit(f.request,[{...f.order,...delta}])).toEqual({state:'unknown'});expect(reconcileGridLimit(f.request,[])).toEqual({state:'unknown'});});
  it('cancel recovery proves the requested venue id and preserves a raced fill',()=>{const f=fixture(),r:ExactGridRequest={...f.request,kind:'cancel',data:{symbol:'BTC',order_id:'10'},authority:{originalRequest:f.request}};f.order.status='filled';f.order.filledAmount='1';expect(reconcileGridReduction(r,[f.order])).toMatchObject({state:'confirmed',orderStatus:'filled',requestDigest:requestDigest(r)});expect(reconcileGridReduction({...r,data:{...r.data,order_id:'11'}},[f.order])).toEqual({state:'unknown'});});
  it('close partial cancellation never implies a full fill or flatness',()=>{const f=fixture(),r={...f.request,kind:'close' as const,data:{...f.request.data,reduce_only:true,side:'ask'}};Object.assign(f.order,{reduceOnly:true,side:'short',orderType:'market',status:'cancelled',filledAmount:'0.4',cancelledAmount:'0.6'});expect(reconcileGridReduction(r,[f.order])).toMatchObject({state:'confirmed',orderStatus:'cancelled'});expect(reconcileGridReduction(r,[{...f.order,status:'filled'}])).toEqual({state:'unknown'});});
  it.each(['pause','band'])('%s preserves backed exits and does not close',async action=>{const f=fixture(action);f.own(true);expect(await f.service.tick(f.claim,signal())).toBe('paused');expect(f.storage.complete).toHaveBeenCalledWith(f.claim,f.life.active_request,action==='band'?'range_exhausted':'paused');expect(f.deps.send).not.toHaveBeenCalled();expect(f.deps.recycle).not.toHaveBeenCalled();});
  it('latches durable stop evidence even when history/inventory is unavailable',async()=>{const f=fixture(null);f.observation.mark!.price='80';f.observation.inventoryComplete=false;expect(await f.service.tick(f.claim,signal())).toBe('inventory_unavailable');expect(f.storage.request).toHaveBeenCalledWith('EXAMPLE_OWNER',f.claim.id,expect.any(String),'stop',expect.objectContaining({price:'80',pnl:null}),'risk',f.claim);expect(f.deps.send).not.toHaveBeenCalled();});
  it('breaker latches a pause but never a close',async()=>{const f=fixture(null);f.bot.consecutive_failures=5;await f.service.tick(f.claim,signal());expect(f.storage.request.mock.calls[0][3]).toBe('pause');expect(f.deps.send).not.toHaveBeenCalled();});
  it('stop cancels only its retained entry identity before closing',async()=>{const f=fixture();f.own();await f.service.tick(f.claim,signal());expect(f.deps.send).toHaveBeenCalledWith(f.claim,expect.objectContaining({kind:'cancel',data:{symbol:'BTC',order_id:'10'}}));});
  it('orphan orders block cancellation and all sweep work',async()=>{const f=fixture();f.observation.orders=[f.order];expect(gridOwnedLive([],f.observation)[0].operation).toBeNull();expect(await f.service.tick(f.claim,signal())).toBe('unrelated_order_requires_review');expect(f.deps.send).not.toHaveBeenCalled();expect(f.deps.settlement).not.toHaveBeenCalled();});
  it('risk-denied stop keeps exits and sends only the exact reduce-only residual',async()=>{const f=fixture();f.own(true);f.bot.consecutive_failures=9;f.bot.sol_balance='0';f.observation.position!.size='0.02';f.monitor.reconcile.mockResolvedValue({entriesAllowed:false});await f.service.tick(f.claim,signal());expect(f.deps.send).toHaveBeenCalledWith(f.claim,expect.objectContaining({kind:'close',data:expect.objectContaining({amount:'0.02',side:'ask',reduce_only:true,slippage_percent:'0.5'})}));});
  it('close uncertainty blocks another close after restart',async()=>{const f=fixture();await f.service.tick(f.claim,signal());expect(await new GridLifecycleService(f.deps as unknown as GridLifecycleDeps).tick(f.claim,signal())).toBe('venue_operation_unresolved');expect(f.deps.send).toHaveBeenCalledOnce();expect(f.deps.recycle).not.toHaveBeenCalled();});
  it.each(['long','short'] as const)('%s unresolved entry cancel cannot wedge a stop close or hide a later fill',async direction=>{
    const f=fixture();f.bot.direction=direction;f.observation.position!.direction=direction;f.own();
    if(direction==='short'){f.request.data.side='ask';f.order.side='short';f.operations[0].exact_request_digest=requestDigest(f.request);}
    await f.service.tick(f.claim,signal()); // The cancel send does not land.
    const cancel=f.operations.find(op=>op.exact_request.kind==='cancel');
    expect(cancel.state).toBe('unconfirmed');
    await f.service.tick(f.claim,signal());
    expect(f.deps.send).toHaveBeenLastCalledWith(f.claim,expect.objectContaining({kind:'close',data:expect.objectContaining({reduce_only:true,side:direction==='long'?'ask':'bid',amount:'1'})}));
    const close=f.operations.find(op=>op.exact_request.kind==='close');
    // An uncertain close is not replayed even though the cancel is also unresolved.
    expect(await f.service.tick(f.claim,signal())).toBe('venue_operation_unresolved');expect(f.deps.send).toHaveBeenCalledTimes(2);
    f.deps.recover.mockImplementation(async(_claim:any,op:any)=>op.id===close.id?{state:'confirmed',requestDigest:op.exact_request_digest,releaseSlot:true} as never:{state:'unknown'});
    f.observation.position!.size='0';await f.service.tick(f.claim,signal());
    expect(await f.service.tick(f.claim,signal())).toBe('venue_operation_unresolved');expect(f.deps.recycle).not.toHaveBeenCalled();expect(f.deps.settlement).not.toHaveBeenCalled();
    // The same pending stop reconciles and closes a later fill of the still-resting entry.
    f.observation.position!.size='0.25';await f.service.tick(f.claim,signal());
    expect(f.monitor.reconcile).toHaveBeenCalled();expect(f.deps.send).toHaveBeenLastCalledWith(f.claim,expect.objectContaining({kind:'close',data:expect.objectContaining({amount:'0.25',reduce_only:true})}));
    expect(f.deps.send.mock.calls.filter(c=>c[1].kind==='cancel')).toHaveLength(1);expect(cancel.state).toBe('unconfirmed');expect(f.deps.recycle).not.toHaveBeenCalled();
  });

  it.each(['fund','sweep'] as const)('expired unknown %s keeps Stop protection but blocks transfer replay and recycling',async kind=>{
    const f=fixture();f.own(true);f.monitor.reconcile.mockResolvedValue({entriesAllowed:false});
    const r:ExactGridRequest={...f.request,kind,path:'/account/subaccount/transfer',operationType:'transfer_funds',timestamp:Date.now()-6000,expiryMs:5000,data:{to_account:kind==='fund'?f.claim.account:f.claim.masterAccount,amount:'1'},authority:{}};
    const transfer={id:randomUUID(),state:'unconfirmed',exact_request:r,exact_request_digest:requestDigest(r)};f.operations.push(transfer);
    await f.service.tick(f.claim,signal());expect(f.deps.send).toHaveBeenCalledWith(f.claim,expect.objectContaining({kind:'close',data:expect.objectContaining({reduce_only:true,amount:'1'})}));
    const close=f.operations.find(op=>op.exact_request.kind==='close');f.deps.recover.mockImplementation(async(_claim:any,op:any)=>op.id===close.id?{state:'confirmed',requestDigest:op.exact_request_digest,releaseSlot:true} as never:{state:'unknown'});
    f.observation.position!.size='0';await f.service.tick(f.claim,signal());f.observation.orders=[];
    expect(await f.service.tick(f.claim,signal())).toBe('transfer_outcome_unknown');expect(f.deps.send).toHaveBeenCalledOnce();expect(transfer.state).toBe('unconfirmed');expect(f.deps.settlement).not.toHaveBeenCalled();expect(f.deps.recycle).not.toHaveBeenCalled();
  });
  it('unknown expired transfer permits only retained entry cancellation before Stop close',async()=>{
    const f=fixture();f.own();const r:ExactGridRequest={...f.request,kind:'fund',path:'/account/subaccount/transfer',operationType:'transfer_funds',timestamp:Date.now()-6000,data:{to_account:f.claim.account,amount:'1'},authority:{}};
    f.operations.push({id:randomUUID(),state:'submitted',exact_request:r,exact_request_digest:requestDigest(r)});await f.service.tick(f.claim,signal());
    expect(f.deps.send).toHaveBeenCalledWith(f.claim,expect.objectContaining({kind:'cancel',data:{symbol:'BTC',order_id:'10'}}));expect(f.deps.recycle).not.toHaveBeenCalled();
  });
  it.each([{timestamp:Date.now(),account:'EXAMPLE_SUB'},{timestamp:Date.now()-6000,account:'EXAMPLE_FOREIGN'}])('live or mismatched transfer stays fully blocked: %j',async patch=>{
    const f=fixture(),r:ExactGridRequest={...f.request,kind:'fund',path:'/account/subaccount/transfer',operationType:'transfer_funds',...patch,data:{to_account:f.claim.account,amount:'1'},authority:{}};
    f.operations.push({id:randomUUID(),state:'unconfirmed',exact_request:r,exact_request_digest:requestDigest(r)});expect(await f.service.tick(f.claim,signal())).toBe('venue_operation_unresolved');expect(f.deps.send).not.toHaveBeenCalled();
  });
  it('resume reconciles and denies missing current authority',async()=>{const f=fixture('resume');expect(await f.service.tick(f.claim,signal())).toBe('resume_authority_unavailable');expect(f.monitor.reconcile).toHaveBeenCalledOnce();expect(f.storage.complete).not.toHaveBeenCalled();expect(f.deps.send).not.toHaveBeenCalled();});
  it('Stop still processes when production resume authority is unavailable',async()=>{
    const f=fixture('stop');f.deps.resume.mockRejectedValue(Error('EXAMPLE launch authority unavailable'));
    f.observation.position!.size='0';expect(await f.service.tick(f.claim,signal())).toBe('stopped');
    expect(f.deps.resume).not.toHaveBeenCalled();expect(f.deps.recycle).toHaveBeenCalledOnce();
  });
  it('resume cannot bypass unresolved inventory',async()=>{const f=fixture('resume');f.monitor.reconcile.mockResolvedValue({entriesAllowed:false});expect(await f.service.tick(f.claim,signal())).toBe('reconciliation_required');expect(f.deps.resume).not.toHaveBeenCalled();});
  it('re-sync reconciles without silently resuming entries',async()=>{const f=fixture('resync');expect(await f.service.tick(f.claim,signal())).toBe('paused');expect(f.storage.complete).toHaveBeenCalledWith(f.claim,f.life.active_request,'paused');});
  it.each([null,{direction:'long' as const,size:'0'}])('stop never terminalizes unavailable position or history',async position=>{const f=fixture();f.observation.position=position;f.monitor.reconcile.mockResolvedValue({entriesAllowed:false});await f.service.tick(f.claim,signal());expect(f.deps.recycle).not.toHaveBeenCalled();expect(f.deps.settlement).not.toHaveBeenCalled();});
  it('unexplained residual cannot be swept',async()=>{const f=fixture();f.observation.position!.size='0';f.proof.balance='2';f.proof.withdrawable='1';expect(await f.service.tick(f.claim,signal())).toBe('unexplained_unsweepable_residual');expect(f.deps.send).not.toHaveBeenCalled();});
  it('lost sweep response stays unresolved despite a later zero balance',async()=>{const f=fixture();f.observation.position!.size='0';f.proof.balance=f.proof.withdrawable='2';await f.service.tick(f.claim,signal());f.proof.balance=f.proof.withdrawable='0';expect(await f.service.tick(f.claim,signal())).toBe('venue_operation_unresolved');expect(f.deps.send).toHaveBeenCalledOnce();expect(f.deps.recycle).not.toHaveBeenCalled();});
  it('only full fresh zero proof reaches the atomic recycler',async()=>{const f=fixture();f.observation.position!.size='0';expect(await f.service.tick(f.claim,signal())).toBe('stopped');expect(f.deps.recycle).toHaveBeenCalledWith(f.claim,f.life.active_request,f.proof);expect(f.deps.send).not.toHaveBeenCalled();});
  it('C6 Stop cancels, closes, sweeps and releases only after each exact operation settles',async()=>{
    const f=fixture();f.own();
    f.deps.send.mockImplementation(async(_claim,r)=>({rateLimited:false,...(r.kind==='sweep'?{terminalTransferDigest:requestDigest(r)}:{})}));
    const service=new GridLifecycleService({...f.deps,recover:async(_claim:unknown,op:{exact_request:ExactGridRequest;exact_request_digest:string})=>{
      return reconcileGridReduction(op.exact_request,f.observation.orders);
    }} as unknown as GridLifecycleDeps);
    expect(await service.tick(f.claim,signal())).toBe('pending');expect(f.deps.send.mock.calls.at(-1)?.[1].kind).toBe('cancel');
    f.order.status='cancelled';f.order.cancelledAmount='1';
    expect(await service.tick(f.claim,signal())).toBe('recovered_reobserve_required');
    expect(await service.tick(f.claim,signal())).toBe('pending');const close=f.operations.find(op=>op.exact_request.kind==='close').exact_request;
    expect(close.data).toMatchObject({reduce_only:true,amount:'1'});expect(f.deps.recycle).not.toHaveBeenCalled();
    f.observation.orders.push({...f.order,orderId:'11',clientOrderId:String(close.data.client_order_id),side:'short',reduceOnly:true,orderType:'market',status:'filled',filledAmount:'1',cancelledAmount:'0',createdAt:close.timestamp,updatedAt:close.timestamp});
    f.observation.position!.size='0';f.proof.balance=f.proof.withdrawable='100';
    expect(await service.tick(f.claim,signal())).toBe('recovered_reobserve_required');
    expect(await service.tick(f.claim,signal())).toBe('confirmed');expect(f.deps.send.mock.calls.at(-1)?.[1]).toMatchObject({kind:'sweep',data:{amount:'100'}});
    expect(f.deps.recycle).not.toHaveBeenCalled();
    f.proof.balance=f.proof.withdrawable='0';expect(await service.tick(f.claim,signal())).toBe('stopped');
    expect(f.deps.send.mock.calls.map(call=>call[1].kind)).toEqual(['cancel','close','sweep']);expect(f.deps.recycle).toHaveBeenCalledOnce();
  });
  it.each(['pending_balance','pending_interest','total_margin_used','spot_collateral','spot_market_value','positions_count','orders_count','stop_orders_count','updated_at'])('terminal proof rejects %s uncertainty',field=>{const f=fixture();f.observation.position!.size='0';const data:any={balance:'0',available_to_withdraw:'0',account_equity:'0',pending_balance:'0',pending_interest:'0',total_margin_used:'0',spot_collateral:'0',spot_market_value:'0',positions_count:0,orders_count:0,stop_orders_count:0,updated_at:Date.now(),spot_balances:[]};expect(gridTerminalFact({success:true,data},f.claim,f.observation,0,recycler(),Date.now())).not.toBeNull();data[field]=field==='updated_at'?Date.now()-5001:field.endsWith('_count')?1:'1';expect(gridTerminalFact({success:true,data},f.claim,f.observation,0,recycler(),Date.now())).toBeNull();});
});

describe('C4 lifecycle sweep recovery',()=>{
  it.each(['landed','not_landed'] as const)('recovers %s without resending the old sweep',async outcome=>{
    const f=fixture(),now=Date.now();f.observation.position!.size='0';
    const r:ExactGridRequest={kind:'sweep',botId:f.claim.id,account:f.claim.account,masterAccount:f.claim.masterAccount,
      path:'/account/subaccount/transfer',operationType:'transfer_funds',timestamp:now-6000,expiryMs:5000,
      data:{amount:'100',to_account:f.claim.masterAccount,idempotency_key:'EXAMPLE_OLD_SWEEP_KEY'},
      authority:{settlementComplete:true,settlement:{...f.proof,balance:'100',withdrawable:'100',observedAt:now-6100}}};
    const op:DurableGridOperation={id:randomUUID(),state:'unconfirmed',exact_request:r,exact_request_digest:requestDigest(r),failure_classification:'unknown'};
    f.operations.push(op);
    const evidence:GridTransferEvidence={account:r.account,masterAccount:r.masterAccount,complete:true,startedAt:now,observedAt:now,balanceAt:now,
      balance:outcome==='landed'?'0':'100',ownedAccounts:null,
      subaccountHistory:outcome==='landed'?[{amount:'-100',eventType:'subaccount_transfer',createdAt:r.timestamp+1}]:[],
      mainHistory:outcome==='landed'?[{amount:'100',eventType:'subaccount_transfer',createdAt:r.timestamp+1}]:[]};
    const result=reconcileGridTransfer(r,evidence,{reused:false,operations:[op]},now);
    expect(result.state).toBe(outcome==='landed'?'confirmed':'not_landed');
    const send=vi.fn(async(_claim:unknown,request:ExactGridRequest)=>({rateLimited:false,terminalTransferDigest:requestDigest(request)}));
    const service=new GridLifecycleService({...f.deps,recover:async()=>result,send} as unknown as GridLifecycleDeps);
    expect(await service.tick(f.claim,signal())).toBe('recovered_reobserve_required');
    expect(send).not.toHaveBeenCalled();expect(op.state).toBe(outcome==='landed'?'confirmed':'failed');
    if(outcome==='landed'){
      expect(await service.tick(f.claim,signal())).toBe('stopped');expect(f.deps.recycle).toHaveBeenCalledOnce();
    }else{
      f.proof.balance='100';f.proof.withdrawable='100';
      await service.tick(f.claim,signal());expect(send).toHaveBeenCalledOnce();
      const replacement=send.mock.calls[0][1];expect(replacement.kind).toBe('sweep');
      expect(replacement.data.idempotency_key).not.toBe(r.data.idempotency_key);
      expect(replacement.data.idempotency_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    expect(r.data.idempotency_key).toBe('EXAMPLE_OLD_SWEEP_KEY');
  });
});

describe('resume authority and close rejection',()=>{
  it.each(['Pause','Stop','off'])('%s during awaited automatic authority cannot complete Resume',async()=>{
    const f=fixture('resume');Object.assign(f.bot,{policy_hmac:'EXAMPLE_HASH',status:'range_exhausted'});Object.assign(f.life,{source:'risk',action:'band',state:'complete'});
    const token={generation:'1',cycle:'1',requestId:randomUUID(),epoch:'2',policyHash:'EXAMPLE_HASH',umkVersion:1};let current=true,release!:(value:any)=>void;
    const auto={armed:vi.fn(async()=>true),reserve:vi.fn(async()=>{Object.assign(f.life,{source:'auto',action:'resume',state:'pending',active_request:token.requestId,epoch:'2'});f.bot.status='resuming';return token;}),current:vi.fn(async()=>current),hold:vi.fn(async()=>{})};
    (f.storage as any).auto=auto;(f.deps as any).marketTick=async()=> '0.01';
    const cleanup=vi.fn(),authority={policy:{id:f.claim.id,direction:'long',stopLossPrice:'80'},policyHmac:'EXAMPLE_HASH',umk:Buffer.alloc(32,7),facts:{agentGeneration:{umkVersion:1},account:f.claim.account,masterAccount:f.claim.masterAccount,tick:'0.01'},cleanup};
    let entered!:()=>void;const enteredAuthority=new Promise<void>(resolve=>entered=resolve);f.deps.resume.mockImplementation(async()=>{entered();return new Promise(resolve=>release=resolve);});
    const running=f.service.tick(f.claim,signal());await enteredAuthority;current=false;release(authority);expect(await running).toBe('auto_resume_superseded');expect(f.storage.complete).not.toHaveBeenCalled();expect(f.deps.send).not.toHaveBeenCalled();expect(cleanup).toHaveBeenCalledOnce();
  });
  it('resumes only after fresh reconciliation and matching bot/account authority, then clears secrets',async()=>{
    const f=fixture('resume'),cleanup=vi.fn();Object.assign(f.bot,{policy_hmac:'EXAMPLE_HASH'});
    const authority={policy:{id:f.claim.id,direction:'long',stopLossPrice:'80'},policyHmac:'EXAMPLE_HASH',umk:Buffer.alloc(32,7),facts:{agentGeneration:{umkVersion:1},account:f.claim.account,masterAccount:f.claim.masterAccount,tick:'0.01'},risk:{account:f.claim.account,symbol:'BTC',positionSize:'1',liquidationPrice:'50',observedAt:Date.now(),source:'EXAMPLE'},cleanup};
    const gate=vi.spyOn(provision,'preflightGridResume').mockReturnValue({ok:true} as never);
    try{f.deps.resume.mockResolvedValue(authority as never);expect(await f.service.tick(f.claim,signal())).toBe('resumed');expect(f.monitor.reconcile).toHaveBeenCalledOnce();expect(f.storage.complete).toHaveBeenCalledWith(f.claim,f.life.active_request,'canary',expect.objectContaining({identity:{policyHash:'EXAMPLE_HASH',umkVersion:1}}));expect(cleanup).toHaveBeenCalledOnce();
      authority.facts.account='EXAMPLE_FOREIGN';expect(await f.service.tick(f.claim,signal())).toBe('resume_identity_changed');expect(f.storage.complete).toHaveBeenCalledOnce();expect(cleanup).toHaveBeenCalledTimes(2);
    }finally{gate.mockRestore();}
  });
  it('exact rejected market close resolves failure without implying flatness',()=>{const f=fixture(),r={...f.request,kind:'close' as const,data:{...f.request.data,reduce_only:true,side:'ask'}};Object.assign(f.order,{reduceOnly:true,side:'short',orderType:'market',status:'rejected'});expect(reconcileGridReduction(r,[f.order])).toMatchObject({state:'rejected',releaseSlot:true});expect(reconcileGridReduction(r,[{...f.order,filledAmount:'0.1'}])).toEqual({state:'unknown'});});
});

describe('resume existing-position 1% clearance',()=>{
  it.each([['long','101','100',true],['long','100.99','100',false],['short','99','100',true],['short','99.01','100',false]] as const)('%s stop %s versus current liquidation %s',(direction,stopLossPrice,liquidationPrice,expected)=>{
    const f=fixture('resume'),now=Date.now();f.observation.position!.direction=direction;const risk={account:f.claim.account,symbol:'BTC',positionSize:'1',liquidationPrice,observedAt:now,source:'EXAMPLE'};
    expect(gridResumeClearance(risk,f.observation,{direction,stopLossPrice} as never,'0.01',now)).toBe(expected);
    expect(gridResumeClearance({...risk,observedAt:now-5001},f.observation,{direction,stopLossPrice} as never,'0.01',now)).toBe(false);
    expect(gridResumeClearance({...risk,account:'EXAMPLE_FOREIGN'},f.observation,{direction,stopLossPrice} as never,'0.01',now)).toBe(false);
  });
});

it('SOL lookup failure cannot disable a retained reduce-only Stop',async()=>{const f=fixture();f.deps.sol.mockRejectedValue(Error('EXAMPLE_RPC_UNAVAILABLE'));expect(await f.service.tick(f.claim,signal())).toBe('pending');expect(f.deps.send).toHaveBeenCalledWith(f.claim,expect.objectContaining({kind:'close'}));});


describe('strict shared execution-wallet SOL authority',()=>{
 it('shares a strict bigint read only for the exact execution wallet',async()=>{const strict=vi.fn(async()=>50000000n),read=createGridSolReader(strict);const results=await Promise.all([read('EXAMPLE_MASTER',signal()),read('EXAMPLE_MASTER',signal())]);expect(strict).toHaveBeenCalledTimes(1);expect(strict).toHaveBeenCalledWith('EXAMPLE_MASTER');expect(results[0]?.balance).toBe('0.05');await read('EXAMPLE_OTHER_MASTER',signal());expect(strict).toHaveBeenCalledTimes(2);});
 it('rejects malformed or negative lamports and bounds an unresolved read',async()=>{expect(await createGridSolReader(async()=>-1n)('EXAMPLE_MASTER',signal())).toBeNull();const strict=vi.fn(()=>new Promise<bigint>(()=>{})),read=createGridSolReader(strict,5000,1);expect(await read('EXAMPLE_MASTER',signal())).toBeNull();expect(await read('EXAMPLE_MASTER',signal())).toBeNull();expect(strict).toHaveBeenCalledOnce();});
});
