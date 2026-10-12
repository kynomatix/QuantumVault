import {describe,it,expect,vi} from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import type {Pool} from 'pg';
import {GridFirstPlacementAuthority,type GridFirstPlacementContext} from '../../server/grid-bot/first-placement';
import {GridLaunchStorage,requestDigest,type ExactGridRequest} from '../../server/grid-bot/launch-storage';
import {GridPacificaSender} from '../../server/grid-bot/execution';
import {PacificaTransportAuthority} from '../../server/protocol/pacifica/pacifica-transport';
import {policy as basePolicy} from './draft-fixtures';

const base=basePolicy();
const policy=()=>({...base,startPrice:'100.50000000',lowerPrice:'100.00000000',upperPrice:'102.00000000',gridCount:2,
  levels:[100,101,102].map((price,i)=>({ordinal:i+1,price:price.toFixed(8),size:'1.00000000',side:'buy' as const,reduceOnly:false}))});
const request=(kind:'seed'|'limit'='limit'):ExactGridRequest=>({kind,botId:policy().id,account:'EXAMPLE_SUB',masterAccount:'EXAMPLE_MASTER',
  path:kind==='seed'?'/orders/create_market':'/orders/create',operationType:kind==='seed'?'create_market_order':'create_order',timestamp:1000,expiryMs:5000,
  data:{symbol:'BTC',side:'bid',amount:'1.00000000',reduce_only:false,client_order_id:'EXAMPLE',...(kind==='seed'?{slippage_percent:'0.5'}:{price:'100.00000000',tif:'ALO'})},
  authority:{policy:policy(),policyHmac:'EXAMPLE'}});
const context=():GridFirstPlacementContext=>({policy:policy(),confirmedAt:900,fundedAt:1000,alreadyPlaced:false});
const book=(price='100.5',t=1000)=>({success:true,error:null,data:{s:'BTC',t,l:[[{p:String(Number(price)-0.01),a:'1'}],[{p:String(Number(price)+0.01),a:'1'}]]}});
function harness(ctx:GridFirstPlacementContext|null=context(),raw:unknown=book(),now=1000){
  const storage={firstPlacementContext:vi.fn(async()=>ctx)},reads={json:vi.fn(async()=>raw)};
  const authority=new GridFirstPlacementAuthority(storage,reads,()=>now);
  return {authority,storage,reads,setNow:(n:number)=>{now=n;}};
}

describe('post-funding first-placement book authority',()=>{
  it.each(['seed','limit'] as const)('reads the exact symbol only after confirmed funding for %s',async kind=>{
    const h=harness(),r=request(kind),p=await h.authority.observe(r);expect(p).not.toBeNull();
    expect(h.reads.json).toHaveBeenCalledWith(r.masterAccount,'/book',{symbol:'BTC'});
    expect(h.storage.firstPlacementContext.mock.invocationCallOrder[0]).toBeLessThan(h.reads.json.mock.invocationCallOrder[0]);
  });
  it('never reads without retained confirmation and funding authority',async()=>{const h=harness(null);expect(await h.authority.observe(request())).toBeNull();expect(h.reads.json).not.toHaveBeenCalled();});
  it.each([['confirmation',1001,1000],['funding',900,1001]] as const)('never reads before %s',async(_name,confirmedAt,fundedAt)=>{
    const h=harness({...context(),confirmedAt,fundedAt});expect(await h.authority.observe(request())).toBeNull();expect(h.reads.json).not.toHaveBeenCalled();
  });
  it.each([5000,5001])('uses inclusive five-second age at transport: %s',async age=>{
    const h=harness(),r=request(),p=(await h.authority.observe(r))!;h.setNow(1000+age);expect(h.authority.valid(p,r)).toBe(age===5000);
  });
  it.each(['100.6005','100.60050001'])('uses inclusive relative deviation cap: %s',async price=>{
    // Exact decimal book levels avoid binary floating-point rounding at the equality boundary.
    const raw=book();raw.data.l=[[{p:price,a:'1'}],[{p:price==='100.6005'?'100.6005':'100.60050001',a:'1'}]];
    raw.data.l[0][0].p=price==='100.6005'?'100.5905':'100.59050001';raw.data.l[1][0].p=price==='100.6005'?'100.6105':'100.61050001';
    expect((await harness(context(),raw).authority.observe(request()))!==null).toBe(price==='100.6005');
  });
  it.each(['100.505','100.50500001'])('uses inclusive half-spacing when stricter than the deviation cap: %s',async price=>{
    const c=context();c.policy.levels[1].price='100.01000000';
    const raw=book();raw.data.l=[[{p:price==='100.505'?'100.495':'100.49500001',a:'1'}],[{p:price==='100.505'?'100.515':'100.51500001',a:'1'}]];
    expect((await harness(c,raw).authority.observe(request()))!==null).toBe(price==='100.505');
  });
  it.each(['identity','future','pre-funding','empty','crossed','invalid','envelope','range','side flip'] as const)('rejects %s with no proof',async defect=>{
    const c=context(),raw=book();
    if(defect==='identity')raw.data.s='ETH';if(defect==='future')raw.data.t=1001;if(defect==='pre-funding')raw.data.t=999;
    if(defect==='empty')raw.data.l[0]=[];if(defect==='crossed')raw.data.l[0][0].p='101';if(defect==='invalid')raw.data.l[0][0].a='NaN';
    if(defect==='envelope')raw.success=false;
    if(defect==='range'){c.policy.upperPrice='100.49';}
    if(defect==='side flip'){c.policy.startPrice='101.00000000';raw.data.l=[[{p:'100.99',a:'1'}],[{p:'101.03',a:'1'}]];}
    expect(await harness(c,raw).authority.observe(request())).toBeNull();
  });
  it('does not turn a timeout or 429 into a proof',async()=>{const h=harness();h.reads.json.mockRejectedValueOnce(Error('EXAMPLE read unavailable'));await expect(h.authority.observe(request())).rejects.toThrow();});
  it('rechecks retained authority after the asynchronous book read',async()=>{const h=harness();h.storage.firstPlacementContext.mockResolvedValueOnce(context()).mockResolvedValueOnce(null);expect(await h.authority.observe(request())).toBeNull();expect(h.reads.json).toHaveBeenCalledOnce();});
  it('binds the final check to the unchanged request',async()=>{const h=harness(),r=request(),p=(await h.authority.observe(r))!;expect(h.authority.valid(p,{...r,account:'EXAMPLE_OTHER'})).toBe(false);});
});

describe('first-placement signing boundary',()=>{
  const sub=nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
  it.each([5000,5001])('rechecks after synchronous signing/preparation at %s ms',async delay=>{
    const h=harness(),r={...request(),account:bs58.encode(sub.publicKey)},transport=new PacificaTransportAuthority('EXAMPLE1_'+bs58.encode(new Uint8Array(16).fill(9)));
    const original=transport.restInit.bind(transport);vi.spyOn(transport,'restInit').mockImplementation((...args)=>{const init=original(...args);h.setNow(1000+delay);return init;});
    const post=vi.fn(async()=>new Response(null,{status:200})),sender=new GridPacificaSender(transport,post as typeof fetch,h.authority);
    if(delay===5000){await sender.send(r,Buffer.from(sub.secretKey));expect(post).toHaveBeenCalledOnce();}
    else {await expect(sender.send(r,Buffer.from(sub.secretKey))).rejects.toThrow('expired');expect(post).not.toHaveBeenCalled();}
  });
  it('fails closed when the concrete authority is absent, while reduce-only orders remain usable',async()=>{
    const r={...request(),account:bs58.encode(sub.publicKey)},post=vi.fn(async()=>new Response(null,{status:200}));
    const sender=new GridPacificaSender(new PacificaTransportAuthority('EXAMPLE1_'+bs58.encode(new Uint8Array(16).fill(9))),post as typeof fetch);
    await expect(sender.send(r,Buffer.from(sub.secretKey))).rejects.toThrow('first placement');expect(post).not.toHaveBeenCalled();
    await sender.send({...r,data:{...r.data,reduce_only:true}},Buffer.from(sub.secretKey));expect(post).toHaveBeenCalledOnce();
  });
});

describe('retained first-placement context',()=>{
  function retained(){
    const r=request(),p=policy(),b:any={...Object.fromEntries(Object.entries(p).filter(([k])=>k!=='levels').map(([k,v])=>[k.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()),v])),
      account:r.account,master_account:r.masterAccount,created_at:new Date(900),client_request_id:'EXAMPLE',server_intent_digest:'EXAMPLE',policy_hmac:'EXAMPLE',status:'provisioning',released_at:null};
    const f:ExactGridRequest={...r,kind:'fund',path:'/account/subaccount/transfer',operationType:'transfer_funds',data:{to_account:r.account,amount:p.totalInvestment}};
    const ops:any[]=[{idempotency_key:`grid:${r.botId}:launch:fund`,state:'confirmed',exact_request:f,exact_request_digest:requestDigest(f),terminal_at:new Date(1000)}];
    const query=vi.fn(async(sql:string)=>({rows:sql.includes('JOIN grid_launch_accounts')?[b]:sql.includes('SELECT ordinal')?p.levels.map(l=>({...l,reduce_only:l.reduceOnly})):sql.includes('FROM grid_operations')?ops:[]}));
    const c={query,release:vi.fn()},storage=new GridLaunchStorage({connect:async()=>c} as unknown as Pool,async()=>{});
    return {r,b,f,ops,storage};
  }
  it('uses saved owner-confirmed immutable preview and the exact terminal funding record',async()=>{const h=retained();expect(await h.storage.firstPlacementContext(h.r)).toMatchObject({confirmedAt:900,fundedAt:1000,alreadyPlaced:false});});
  it.each(['missing confirmation','wrong account','policy drift','pending funding','fund digest','fund amount','released custody','ambiguous exposure'] as const)('fails closed on %s',async defect=>{
    const h=retained();if(defect==='missing confirmation')h.b.server_intent_digest=null;if(defect==='wrong account')h.b.account='EXAMPLE_OTHER';
    if(defect==='policy drift')h.b.start_price='100.60000000';if(defect==='pending funding')h.ops[0].state='unconfirmed';
    if(defect==='fund digest')h.ops[0].exact_request_digest='EXAMPLE';
    if(defect==='fund amount'){h.f.data.amount='1';h.ops[0].exact_request_digest=requestDigest(h.f);}
    if(defect==='released custody')h.b.released_at=new Date(1000);
    if(defect==='ambiguous exposure'){const q={...h.r,timestamp:999};h.ops.push({state:'unconfirmed',exact_request:q,exact_request_digest:requestDigest(q)});}
    expect(await h.storage.firstPlacementContext(h.r)).toBeNull();
  });
  it('permits the current submitted record without treating it as a confirmed placement',async()=>{const h=retained();h.ops.push({state:'submitted',exact_request:h.r,exact_request_digest:requestDigest(h.r)});expect(await h.storage.firstPlacementContext(h.r)).toMatchObject({alreadyPlaced:false});});
  it('a confirmed seed cannot substitute for the first resting-entry proof',async()=>{const h=retained(),q=request('seed');h.ops.push({state:'confirmed',exact_request:q,exact_request_digest:requestDigest(q)});expect(await h.storage.firstPlacementContext(h.r)).toMatchObject({alreadyPlaced:false});});
  it('recognizes a confirmed resting entry after restart; a duplicate does not reset its authority',async()=>{const h=retained();h.ops.push({state:'confirmed',exact_request:h.r,exact_request_digest:requestDigest(h.r)});expect(await h.storage.firstPlacementContext(h.r)).toMatchObject({alreadyPlaced:true});});
});
