import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {calculateSpending,withinSpendingCaps,futureNonOwnerInvestmentAllowed,type SpendingFacts} from '../../server/grid-worker/spending';
import {assertWorkerEgress,guardedWorkerFetch} from '../../server/grid-worker/egress';
import {gridPayload,authorizeGridPayload,type PayloadAuthority} from '../../server/grid-worker/payload';
import type {ExactGridRequest} from '../../server/grid-bot/launch-storage';
import {gridStartStatus,submitGridStart} from '../../client/src/lib/grid-start-view';

const now=Date.now();
const facts=(patch:Partial<SpendingFacts>={}):SpendingFacts=>({observedAt:now,complete:true,quoteDecimals:2,positionNotional:'0',orders:[],entries:[],feeReserve:'0',fundingReserve:'0',remainingSlippageReserve:'0',uncertainTransfers:[],...patch});
const caps={startScope:'owner_allowlist',perBotCap:null,globalCeiling:null};
describe('U3 bounded spending',()=>{
  it('rounds outward, deduplicates durable lineage only, and retains unknown transfers separately',()=>{
    const order={lineage:'EXAMPLE_ORDER',amount:'1',worstPrice:'10.001',reduceOnly:false};
    const r=calculateSpending('20',2,facts({positionNotional:'1.001',orders:[order],entries:[order,{...order,lineage:null}],feeReserve:'0.001',remainingSlippageReserve:'0.001',uncertainTransfers:[{operationId:'EXAMPLE_TRANSFER',amount:'20'},{operationId:'EXAMPLE_TRANSFER',amount:'19'}]}),now);
    expect(r).toMatchObject({budget:'40',exposure:'21.03',fees:'0.01',reserve:'40.01',cash:'40.01',uncertain:true});
    expect(withinSpendingCaps(r,caps,{reserve:'1000',cash:'1000'})).toBe(true);
  });
  it('freezes new risk above budget and rejects incomplete or stale facts',()=>{
    const r=calculateSpending('100',2,facts({positionNotional:'200.001'}),now);
    expect(r.aboveBudget).toBe(true);expect(withinSpendingCaps(r,caps,{reserve:'0',cash:'0'})).toBe(false);
    for(const bad of [{complete:false},{observedAt:now-5001},{positionNotional:'Infinity'},{remainingSlippageReserve:'-1'}])expect(()=>calculateSpending('100',2,facts(bad),now)).toThrow();
  });
  it('enforces both caps at the boundary and never opens expanded scope',()=>{
    const r=calculateSpending('250',1,facts(),now);
    expect(futureNonOwnerInvestmentAllowed('250','250')).toBe(true);
    for(const [i,c] of [['250.01','250'],['250',null],['251','251']])expect(futureNonOwnerInvestmentAllowed(i!,c)).toBe(false);
    expect(withinSpendingCaps(r,{...caps,globalCeiling:'500'},{reserve:'250',cash:'250'})).toBe(true);
    expect(withinSpendingCaps(r,{...caps,globalCeiling:'500'},{reserve:'250.01',cash:'250'})).toBe(false);
    expect(withinSpendingCaps(r,{...caps,startScope:'expanded'},{reserve:'0',cash:'0'})).toBe(false);
  });
});
const req=(kind:ExactGridRequest['kind']='fund'):ExactGridRequest=>({botId:randomUUID(),kind,masterAccount:'EXAMPLE_MASTER',account:'EXAMPLE_SUB',
  path:'/account/subaccount/transfer',operationType:'transfer_funds',timestamp:now,expiryMs:5000,
  data:{to_account:kind==='sweep'?'EXAMPLE_MASTER':'EXAMPLE_SUB',amount:'100',idempotency_key:randomUUID()},authority:{}});
const authority:PayloadAuthority={currentMaster:'EXAMPLE_MASTER',investment:'100',leverage:2,maxLeverage:'10',fundAlreadyUsed:false};
describe('U3 exact destination and payload authority',()=>{
  it('builds the allowed transfer and rejects extras, prototypes, missing keys and destinations',()=>{
    expect(gridPayload(req())).toMatchObject({amount:'100',to_account:'EXAMPLE_SUB'});
    for(const data of [{...req().data,builder_code:'EXAMPLE'},{amount:'100'},Object.assign(Object.create({inherited:true}),req().data),{...req().data,to_account:'EXAMPLE_OTHER'}])expect(()=>gridPayload({...req(),data})).toThrow();
  });
  it('requires current master, exact investment and once-only funding; sweep mismatch never signs',()=>{
    expect(()=>authorizeGridPayload(req(),authority,now)).not.toThrow();
    for(const a of [{...authority,currentMaster:'EXAMPLE_OTHER'},{...authority,investment:'99'},{...authority,fundAlreadyUsed:true}])expect(()=>authorizeGridPayload(req(),a,now)).toThrow();
    expect(()=>authorizeGridPayload(req('sweep'),{...authority,currentMaster:'EXAMPLE_OTHER'},now)).toThrow('GRID_TRANSFER_REFUSED');
  });
  it('requires venue-bounded policy leverage and owned fresh bounded closes',()=>{
    const r={...req('leverage'),path:'/account/leverage',operationType:'update_leverage',data:{symbol:'BTC',leverage:2}};
    expect(()=>authorizeGridPayload(r,authority,now)).not.toThrow();
    expect(()=>authorizeGridPayload(r,{...authority,leverage:3},now)).toThrow();
    const close={...req('close'),path:'/orders/create_market',operationType:'create_market_order',data:{symbol:'BTC',amount:'1',side:'ask',reduce_only:true,slippage_percent:'0.5',client_order_id:randomUUID()}};
    const position={account:'EXAMPLE_SUB',symbol:'BTC',size:'1',side:'ask' as const,observedAt:now,complete:true};
    expect(()=>authorizeGridPayload(close,{...authority,position},now)).not.toThrow();
    expect(()=>authorizeGridPayload(close,{...authority,position:{...position,size:'0.9'}},now)).toThrow();
  });
});
describe('U3 egress',()=>{
  it.each(['https://example.com/api/v1/info','https://api.pacifica.fi:8443/api/v1/info','https://api.pacifica.fi/api/v1/withdraw','https://api.pacifica.fi/api/v1/unknown'])('refuses %s',url=>expect(()=>assertWorkerEgress(url,{kind:'venue',method:'GET'})).toThrow());
  it('rejects RPC sends and redirects before any followup request',async()=>{
    expect(()=>assertWorkerEgress('https://api.mainnet-beta.solana.com/',{kind:'rpc',method:'POST',rpcMethod:'sendTransaction'})).toThrow();
    const fetcher=vi.fn<typeof fetch>(async()=>new Response(null,{status:302,headers:{location:'https://example.com'}}));
    await expect(guardedWorkerFetch(fetcher,'https://api.pacifica.fi/api/v1/info',{kind:'venue',method:'GET'},{method:'GET'})).rejects.toThrow('GRID_EGRESS_REFUSED');
    expect(fetcher).toHaveBeenCalledOnce();expect(fetcher.mock.calls[0]?.[1]).toMatchObject({redirect:'error'});
  });
});
describe('U3 pending Start UI',()=>{
  it('recovers a lost POST response by request key without posting twice',async()=>{
    const send=vi.fn(async(_path:string,options?:RequestInit):Promise<unknown>=>{
      if(options?.method==='POST')throw Error('EXAMPLE_LOST_REPLY');
      return {external:true,request:{state:'pending'}};
    });
    const result=await submitGridStart(randomUUID(),{draftRevision:'EXAMPLE_REVISION',serverIntentDigest:'EXAMPLE_DIGEST'},send,true);
    expect(result).toMatchObject({state:'pending',requestState:'pending',reason:'Waiting to start'});
    expect(send).toHaveBeenCalledTimes(2);expect(send.mock.calls[1][0]).toContain('/start-request?requestKey=');
    expect(JSON.parse(String(send.mock.calls[0][1]?.body))).toMatchObject({confirmed:true});
  });
  it('uses request state rather than claiming running',()=>{
    expect(gridStartStatus('pending')).toBe('Waiting to start');
    for(const state of ['expired','superseded','refused'] as const)expect(gridStartStatus(state)).not.toMatch(/running|[0-9]/i);
  });
});
