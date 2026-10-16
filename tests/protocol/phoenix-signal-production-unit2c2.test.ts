import { afterEach, expect, it, vi } from 'vitest';
import { identity, now } from '../helpers/phoenix-orders';
import { phoenixIdentityColumns } from '../../server/protocol/phoenix/identity';
import { createPhoenixSignalProduction } from '../../server/protocol/phoenix/signal-production';
import { PhoenixLifecycleStore } from '../../server/protocol/phoenix/lifecycle';
vi.mock('../../server/protocol/phoenix/lab-provenance',()=>({phoenixLabProvenanceSatisfied:()=>({satisfied:true})}));
vi.mock('../../server/session-v3',()=>({getUmkForWebhook:async()=>({umk:Buffer.alloc(32),cleanup(){}}),verifyBotPolicyHmac:()=>true}));
afterEach(()=>vi.restoreAllMocks());
function fixture() {
  const bot={id:'EXAMPLE-bot',walletAddress:'EXAMPLE-owner',activeProtocol:'phoenix',derivationIndex:1,...phoenixIdentityColumns(identity),
    isActive:true,executionActive:true,webhookSecret:'EXAMPLE',market:'SOL',policyHmac:'EXAMPLE'} as any;
  let receipt:any=null;const queries:string[]=[];
  const client={release:vi.fn(),query:vi.fn(async(q:string,p?:any[])=>{queries.push(q);
    if(q.startsWith("SELECT observation->'signalNoops'"))return {rows:[{receipt}]};
    if(q.startsWith('UPDATE phoenix_operations')){receipt=JSON.parse(p![2]);return {rows:[{id:'EXAMPLE-register'}]};}return {rows:[]};})};
  const execution={safety:vi.fn(async()=>({alreadyFlat:true,positionClosed:true})),snapshot:vi.fn(),forMarket:vi.fn()};
  const production=createPhoenixSignalProduction({pool:{connect:async()=>client,query:async()=>({rows:[]})} as any,getBot:async()=>bot,
    getWallet:async()=>({executionEnabled:true}),retained:async()=>({state:'completed',intent:{identity}}) as any,execution:execution as any});
  return {bot,client,queries,execution,production,receipt:()=>receipt};
}
it('durably retains a flat close before replying and returns it without touching a later position',async()=>{
  const f=fixture(),p={time:new Date().toISOString(),action:'sell',position_size:0};
  const first=await f.production.signal(f.bot,p);expect(first).toMatchObject({duplicate:false,signal:{status:'accepted'},safety:{alreadyFlat:true}});
  expect(f.receipt()).toEqual(first);expect(f.execution.safety).toHaveBeenCalledOnce();
  f.bot.isActive=false;const replay=await f.production.signal(f.bot,p);
  expect(replay).toMatchObject({...first,duplicate:true});expect(f.execution.safety).toHaveBeenCalledOnce();
  expect(f.queries.some(q=>q.includes('pg_advisory_unlock'))).toBe(true);expect(f.client.release).toHaveBeenCalledTimes(2);
});
it('commits pause before independent cancellation and close and reports partial safety honestly',async()=>{
  const f=fixture(),order:string[]=[];
  vi.spyOn(PhoenixLifecycleStore.prototype,'stop').mockImplementation(async()=>{order.push('paused');return {isActive:false} as any;});
  f.execution.safety.mockImplementation(async(...args:any[])=>{order.push(args[3]);if(args[3]==='cancel')throw new Error('EXAMPLE-cancel-unavailable');return {positionClosed:true} as any;});
  const result=await f.production.configure('EXAMPLE-owner','EXAMPLE-bot',{isActive:false});
  expect(order).toEqual(['paused','cancel','close']);expect(result).toMatchObject({safety:{allOrdersCancelled:false,positionClosed:true,cancellation:{state:'unknown'}}});
});
it('refuses rotated secrets and cross-owner calls before safety or dispatch',async()=>{
  const f=fixture();await expect(f.production.signal({...f.bot,webhookSecret:'REDACTED'},{time:new Date(now).toISOString(),action:'buy'})).rejects.toThrow('SECRET_ROTATED');
  await expect(f.production.configure('EXAMPLE-other',f.bot.id,{isActive:false})).rejects.toThrow('OWNED_SIGNAL_BOT_REQUIRED');expect(f.execution.safety).not.toHaveBeenCalled();
});
