import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {gridWindow,type WindowLevel} from '../../server/grid-bot/window';
import {gridClaimPlacementBudget,type RetainedGridSlot} from '../../server/grid-bot/slot-budget';
import {GridPacificaSender} from '../../server/grid-bot/execution';
import {PacificaTransportAuthority} from '../../server/protocol/pacifica/pacifica-transport';
import {requestDigest,type ExactGridRequest} from '../../server/grid-bot/launch-storage';
import type {GridVenueOrder} from '../../server/grid-bot/order-identity';
import {PER_BOT_ORDINARY_MAX,VENUE_OPEN_ORDER_CAPACITY,GRID_PROTECTION_RESERVE} from '../../shared/grid-capacity';
import {gridNotificationText} from '../../server/grid-bot/notifications';

const sendOwned=async<T>(_r:ExactGridRequest,_lease:string,post:()=>Promise<T>)=>post();
const levels=(count=101):WindowLevel[]=>Array.from({length:count},(_,i)=>({id:'EXAMPLE_'+i,ordinal:i+1,price:String(100+i),size:'1',side:'buy',reduceOnly:false,attempt:0}));
const facts=()=>({levels:levels(),owned:[],positionSize:'0',bookPrice:'100',freeSlots:100,inventoryComplete:true,entriesAllowed:true,canaryRemaining:'100000'});
const request=(i=0):ExactGridRequest=>({kind:'limit',botId:randomUUID(),account:'EXAMPLE_SUB',masterAccount:'EXAMPLE_MASTER',path:'/orders/create',operationType:'create_order',timestamp:1000,expiryMs:5000,data:{symbol:'BTC',price:String(100+i),amount:'1',side:'bid',reduce_only:false,tif:'ALO',client_order_id:randomUUID()},authority:{}});
function retained(count:number){return Array.from({length:count},(_,i)=>({bot_id:'EXAMPLE_BOT',slots:1,state:'confirmed',venue_order_id:String(i+1),exact_request:request(i)} satisfies RetainedGridSlot));}
const inventory=(claims:RetainedGridSlot[]):{account:string;inventoryComplete:boolean;orders:GridVenueOrder[]}=>({account:'EXAMPLE_SUB',inventoryComplete:true,orders:claims.map(c=>({orderId:c.venue_order_id!,clientOrderId:String(c.exact_request.data.client_order_id),symbol:'BTC',side:'long',price:String(c.exact_request.data.price),amount:'1',filledAmount:'0',cancelledAmount:'0',reduceOnly:false,orderType:'limit',createdAt:1000,updatedAt:1000,status:'open'} satisfies GridVenueOrder))});

describe('100-order policy with observed account capacity and protection reserve',()=>{
  it('has one ordinary ceiling and chunks 95 admissible placements into nine tens and five',()=>{
    expect(PER_BOT_ORDINARY_MAX).toBe(100);expect(VENUE_OPEN_ORDER_CAPACITY-GRID_PROTECTION_RESERVE).toBe(95);
    expect(gridWindow(facts()).map(c=>c.length)).toEqual([...Array(9).fill(10),5]);
    expect(gridWindow({...facts(),freeSlots:999}).flat()).toHaveLength(95);
  });
  it('subtracts all other account orders and keeps five slots untouched',()=>{
    expect(gridWindow({...facts(),freeSlots:30}).flat()).toHaveLength(25);
    expect(gridWindow({...facts(),freeSlots:5}).flat()).toHaveLength(0);
  });
  it('retains all 100 owned levels without rolling away a former 20-order window',()=>{
    const f=facts();f.levels=levels(100);
    const owned=f.levels.map((l,i)=>({levelId:l.id,orderId:String(i+1),clientOrderId:randomUUID(),remaining:'1',reduceOnly:false}));
    expect(gridWindow({...f,owned,freeSlots:0})).toEqual([]);
    expect(()=>gridWindow({...f,levels:levels().map(l=>({...l,reduceOnly:true})),positionSize:'101'})).toThrow('ordinary Grid slot cap');
  });
  it('settles owned cancellations before reuse, preserves backed exits, and keeps the canary amount cap',()=>{
    const f=facts();f.levels[100].reduceOnly=true;
    const owned=[{levelId:f.levels[99].id,orderId:'1',clientOrderId:randomUUID(),remaining:'1',reduceOnly:false}];
    expect(gridWindow({...f,owned,positionSize:'1',entriesAllowed:false}).flat()).toEqual([{kind:'cancel',order:owned[0]}]);
    expect(gridWindow({...f,positionSize:'1',entriesAllowed:false}).flat()).toEqual([{kind:'place',level:f.levels[100]}]);
    expect(gridWindow({...facts(),canaryRemaining:'250'}).flat()).toHaveLength(2);
  });
  it('does not subtract 80 exactly confirmed live claims twice',()=>{
    const claims=retained(80);expect(gridClaimPlacementBudget('EXAMPLE_BOT','EXAMPLE_SUB',20,claims,inventory(claims))).toBe(15);
    const all=retained(95);expect(gridClaimPlacementBudget('EXAMPLE_BOT','EXAMPLE_SUB',5,all,inventory(all))).toBe(0);
  });
  it('keeps submitted and ambiguous reservations despite appearances in inventory',()=>{
    const claims=retained(80),o=inventory(claims);claims[0].state='unconfirmed';claims[1].state='submitted';
    expect(gridClaimPlacementBudget('EXAMPLE_BOT','EXAMPLE_SUB',100,claims,o)).toBe(13);
    claims[2].exact_request.data.client_order_id=randomUUID();expect(gridClaimPlacementBudget('EXAMPLE_BOT','EXAMPLE_SUB',100,claims,o)).toBe(12);
    o.orders.push({...o.orders[0],orderId:'99',clientOrderId:null});expect(gridClaimPlacementBudget('EXAMPLE_BOT','EXAMPLE_SUB',100,claims,o)).toBe(11);
  });
  it('fails closed on incomplete, wrong-account and duplicate observations; absent inventory retains every claim',()=>{
    const claims=retained(80),o=inventory(claims);
    expect(gridClaimPlacementBudget('EXAMPLE_BOT','EXAMPLE_SUB',100,claims,{...o,inventoryComplete:false})).toBe(0);
    expect(gridClaimPlacementBudget('EXAMPLE_BOT','EXAMPLE_SUB',100,claims,{...o,account:'EXAMPLE_OTHER'})).toBe(0);
    expect(gridClaimPlacementBudget('EXAMPLE_BOT','EXAMPLE_SUB',100,claims,{...o,orders:[...o.orders,o.orders[0]]})).toBe(0);
    expect(gridClaimPlacementBudget('EXAMPLE_BOT','EXAMPLE_SUB',100,claims,null)).toBe(15);
  });
});

describe('typed Pacifica capacity response',()=>{
  it.each([{success:false,code:10},{success:false,error_code:10},{success:false,error:'OPEN_ORDER_LIMIT_REACHED'}])('recognizes only exact documented rejection %j',async response=>{
    const sub=nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)),r=request();r.timestamp=Date.now();r.account=bs58.encode(sub.publicKey);
    const fetcher=vi.fn(async()=>new Response(JSON.stringify(response),{status:422}));
    const sender=new GridPacificaSender(new PacificaTransportAuthority('EXAMPLE1_'+bs58.encode(new Uint8Array(16).fill(9))),fetcher as typeof fetch,{observe:async()=>({requestDigest:requestDigest(r),context:{policy:null as any,confirmedAt:0,fundedAt:0,alreadyPlaced:true},bookPrice:null,observedAt:null,readStartedAt:0}),valid:()=>true},{validatePayload:async()=>{},finalMargin:async()=>{},sendOwned});
    expect(await sender.send(r,Buffer.from(sub.secretKey))).toEqual({rateLimited:false,capacityRejectedDigest:requestDigest(r)});expect(fetcher).toHaveBeenCalledOnce();
  });
  it('gives the capacity outbox an explicit owner-facing message',()=>expect(gridNotificationText({bot_id:'EXAMPLE_BOT',event_key:'venue_order_capacity',kind:'venue_capacity',evidence:{},wallet_address:'EXAMPLE',market:'BTC-PERP'}).body).toContain('new placements paused'));
});
