import {describe,it,expect} from 'vitest';
import Decimal from 'decimal.js';
import {gridPilotExposure,type GridPilotOperation} from '../../server/grid-bot/pilot-exposure';
import type {ExactGridRequest} from '../../server/grid-bot/launch-storage';
import type {GridEconomicFill} from '../../server/grid-bot/pnl';
import type {GridObservation} from '../../server/grid-bot/reconciliation';
const now=1_800_000_000_000;
function operation(id='EXAMPLE_ENTRY',kind:ExactGridRequest['kind']='limit',amount='1',price='100',state='confirmed'):GridPilotOperation{return {
  id,state,venue_order_id:id,canary_increment:new Decimal(amount).mul(price).toFixed(),exact_request:{kind,botId:'EXAMPLE_BOT',account:'EXAMPLE_ACCOUNT',masterAccount:'EXAMPLE_MASTER',
    path:'/orders/create',operationType:'create_order',timestamp:now-1,expiryMs:5000,data:{symbol:'BTC',amount,price,side:'bid',reduce_only:false,client_order_id:id},authority:{seedWorstPrice:price,leverage:10}}};}
const fill=(id='EXAMPLE_ENTRY',size='0.5',leg:'entry'|'exit'='entry',price='100'):GridEconomicFill=>({tradeId:id,operationId:id,orderId:id,levelId:null,time:now,leg,size,price,fee:'0'});
function observation(op:GridPilotOperation,filled='0.5',position=filled):GridObservation{return {
  account:'EXAMPLE_ACCOUNT',symbol:'BTC',observedAt:now,inventoryComplete:true,history:{from:0,through:now,inclusive:true,publicationLagMs:0,source:'EXAMPLE'},
  mark:{price:'100',observedAt:now},position:{direction:'long',size:position},trades:[],orders:[{orderId:op.id,clientOrderId:op.id,symbol:'BTC',side:'long',price:String(op.exact_request.data.price),amount:String(op.exact_request.data.amount),
    filledAmount:filled,cancelledAmount:'0',reduceOnly:false,orderType:'limit',createdAt:now-1,updatedAt:now,status:'partially_filled'}]};}
const evaluate=(operations:GridPilotOperation[],fills:GridEconomicFill[],o:GridObservation|null,authoritative=true,retainedUsd='0')=>gridPilotExposure({operations,fills,observation:o,authoritative,retainedUsd,now});
describe('C2 exact pilot notional and durable uncertainty',()=>{
  it('counts open filled position plus unchanged resting residual once, without dividing by leverage',()=>{
    const op=operation(),o=observation(op);
    expect(evaluate([op],[fill()],o)).toEqual({exposureUsd:'100',reason:null});
    o.position!.direction='short';o.orders[0].side='short';op.exact_request.data.side='ask';
    expect(evaluate([op],[fill()],o).exposureUsd).toBe('100');
  });
  it('includes the seed and every unresolved entry at their full retained worst-price reservation',()=>{
    const entry=operation(),seed=operation('EXAMPLE_SEED','seed','0.5','120','unconfirmed'),o=observation(entry);
    expect(evaluate([entry,seed],[fill()],o).exposureUsd).toBe('170'); // filled 60 + resting 50 + unresolved seed 60
    seed.canary_increment='80';expect(evaluate([entry,seed],[fill()],o).exposureUsd).toBe('190');
  });
  it('does not add reduce-only profits or stop closes to the risk of the position they protect',()=>{
    const op=operation(),profit=operation('EXAMPLE_PROFIT','limit','1','1000'),close=operation('EXAMPLE_CLOSE','close','1','1000');
    profit.exact_request.data.reduce_only=true;close.exact_request.data.reduce_only=true;
    expect(evaluate([op,profit,close],[fill()],observation(op)).exposureUsd).toBe('100');
  });
  it('uses the higher fresh mark and actual fill price, and releases only actual closed size',()=>{
    const op=operation(),o=observation(op,'0.5','0.25');o.mark!.price='120';
    expect(evaluate([op],[fill('EXAMPLE_ENTRY','0.5','entry','121'),fill('EXAMPLE_EXIT','0.25','exit')],o).exposureUsd).toBe('90.25');
  });
  it('keeps submitted and unconfirmed reservations even when their partial fills are observed',()=>{
    const op=operation();op.state='unconfirmed';
    expect(evaluate([op],[fill()],observation(op)).exposureUsd).toBe('150');
    op.state='submitted';expect(evaluate([op],[fill()],observation(op)).exposureUsd).toBe('150');
  });
  it('retains the durable high-water reservation on restart or incomplete history',()=>{
    const op=operation();expect(evaluate([op],[],null,false,'200').exposureUsd).toBe('200');
    op.state='failed';expect(evaluate([op],[],null,false,'200').exposureUsd).toBe('200');
  });
  it('retains known partial fills even when a failed operation has no unresolved reservation',()=>{
    const op=operation();op.state='failed';
    expect(evaluate([op],[fill()],observation(op),false).exposureUsd).toBe('50');
  });
  it.each(['missing','stale','future'] as const)('fails closed for a filled position with a %s mark',mode=>{
    const op=operation(),o=observation(op);if(mode==='missing')o.mark=null;else o.mark!.observedAt=mode==='stale'?now-5001:now+1;
    expect(evaluate([op],[fill()],o)).toEqual({exposureUsd:null,reason:'pilot_exposure_mark_unavailable'});
  });
  it('keeps decimal boundary precision instead of accepting a rounded $250 exposure',()=>{
    const op=operation('EXAMPLE_PRECISE','seed','1','250.000000000000000001','prepared');op.canary_increment='250.000000000000000001';
    expect(evaluate([op],[],null,false).exposureUsd).toBe('250.000000000000000001');
  });
  it('releases the unused reservation only after a complete terminal cancellation',()=>{
    const op=operation(),o=observation(op,'0','0');o.orders[0].status='cancelled';o.orders[0].cancelledAmount='1';
    expect(evaluate([op],[],o,true,'100').exposureUsd).toBe('0');
    expect(evaluate([op],[],o,false,'100').exposureUsd).toBe('100');
  });
  it('denies unknown economics and missing retained claims',()=>{
    const op=operation();op.canary_increment=null;expect(evaluate([op],[],null,false).exposureUsd).toBeNull();
    op.canary_increment='100';op.exact_request.data.price='Infinity';expect(evaluate([op],[],null,false).exposureUsd).toBeNull();
  });
});
