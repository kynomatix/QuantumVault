import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {GridExecution,GridPacificaSender,reconcileGridLimit,type GridExecutionDeps} from '../../server/grid-bot/execution';
import {GridLaunchTransientError,requestDigest,type ExactGridRequest,type DurableGridOperation,type GridClaim} from '../../server/grid-bot/launch-storage';
import {GridLaunchReads} from '../../server/grid-bot/launch-reads';
import {PacificaTransportAuthority} from '../../server/protocol/pacifica/pacifica-transport';
import {parseGridVenueOrders,type GridVenueOrder} from '../../server/grid-bot/order-identity';
import {gridWindow,type WindowLevel} from '../../server/grid-bot/window';
import {executeGridWindow} from '../../server/grid-bot/placement';
import {reconcileGridLaunch} from '../../server/grid-bot/launch-reconciliation';
const request=():ExactGridRequest=>({kind:'limit',botId:randomUUID(),account:'EXAMPLE_SUB',masterAccount:'EXAMPLE_MASTER',path:'/orders/create',operationType:'create_order',timestamp:1000,expiryMs:5000,data:{symbol:'BTC',price:'90',amount:'1',side:'bid',reduce_only:false,tif:'ALO',client_order_id:randomUUID()},authority:{}});
const claim:GridClaim={credits:'10',slots:1,canaryIncrement:'90',observedCredits:'300',availableSlots:100,observedAt:1000,expiresAt:6000};
function harness(){const r=request();let row:DurableGridOperation|null=null;
  const deps:GridExecutionDeps={storage:{read:vi.fn(async()=>row),prepare:vi.fn(async()=>row={id:randomUUID(),state:'prepared',exact_request:r,exact_request_digest:requestDigest(r),failure_classification:null}),submit:vi.fn(async()=>{row!.state='submitted';return true;}),settle:vi.fn(async(_op,outcome)=>{row!.state=outcome.state;row!.failure_classification=outcome.reason;})},preflight:vi.fn(async()=>true),send:vi.fn(async()=>({rateLimited:false})),reconcile:vi.fn(async()=>({state:'unknown' as const}))};return {r,deps,execution:new GridExecution(deps),get row(){return row;}};}
describe('write ahead and exact identity execution',()=>{
  it.each(['Grid fixed quota share exhausted','Durable Grid rate-limit backoff'])('returns pending without submitting or sending for %s',async reason=>{
    const h=harness();vi.mocked(h.deps.storage.prepare).mockRejectedValue(new GridLaunchTransientError(reason));
    expect(await h.execution.run('EXAMPLE',h.r,claim,'EXAMPLE')).toBe('pending');
    expect(h.deps.storage.submit).not.toHaveBeenCalled();expect(h.deps.send).not.toHaveBeenCalled();
  });
  it('does not disguise an ownership failure as a transient quota denial',async()=>{
    const h=harness();vi.mocked(h.deps.storage.prepare).mockRejectedValue(Error('Lost Grid ownership'));
    await expect(h.execution.run('EXAMPLE',h.r,claim,'EXAMPLE')).rejects.toThrow('Lost Grid ownership');expect(h.deps.send).not.toHaveBeenCalled();
  });
  it('uses the configured share on all reads and retains 429 as a transient denial',async()=>{
    const ledger={claimRead:vi.fn(async()=>randomUUID()),recordRateLimit:vi.fn(async()=>{})};
    const fetcher=vi.fn(async()=>new Response('{}',{status:200}));
    const reads=new GridLaunchReads(new PacificaTransportAuthority('EXAMPLE1_'+bs58.encode(new Uint8Array(16).fill(9))),ledger,'0.25',fetcher as typeof fetch);
    await reads.json('EXAMPLE_MASTER','/account',{});expect(ledger.claimRead).toHaveBeenLastCalledWith('EXAMPLE_MASTER','1','300','0.25');
    fetcher.mockImplementationOnce(async()=>new Response(null,{status:429}));
    await expect(reads.json('EXAMPLE_MASTER','/account',{})).rejects.toBeInstanceOf(GridLaunchTransientError);
    expect(ledger.recordRateLimit).toHaveBeenCalledWith('EXAMPLE_MASTER');
    ledger.claimRead.mockRejectedValueOnce(new GridLaunchTransientError('backoff'));
    await expect(reads.json('EXAMPLE_MASTER','/account',{})).rejects.toBeInstanceOf(GridLaunchTransientError);expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('zero signing or preparation after failed authority',async()=>{const h=harness();vi.mocked(h.deps.preflight).mockResolvedValue(false);expect(await h.execution.run('EXAMPLE',h.r,claim,'EXAMPLE')).toBe('not_sent');expect(h.deps.storage.prepare).not.toHaveBeenCalled();expect(h.deps.send).not.toHaveBeenCalled();});
  it('rechecks after durable preparation and never signs with lost authority',async()=>{const h=harness();vi.mocked(h.deps.preflight).mockResolvedValueOnce(true).mockResolvedValueOnce(false);expect(await h.execution.run('EXAMPLE',h.r,claim,'EXAMPLE')).toBe('not_sent');expect(h.deps.storage.prepare).toHaveBeenCalledOnce();expect(h.deps.send).not.toHaveBeenCalled();});
  it.each(['timeout','http-success','429'])('%s stays unresolved across restart without a second send',async(mode)=>{const h=harness();if(mode==='timeout')vi.mocked(h.deps.send).mockRejectedValue(Error('EXAMPLE'));if(mode==='429')vi.mocked(h.deps.send).mockResolvedValue({rateLimited:true});
    expect(await h.execution.run('EXAMPLE',h.r,claim,'EXAMPLE')).toBe('pending');expect(h.row?.state).toBe('unconfirmed');
    const restart=new GridExecution(h.deps);expect(await restart.run('EXAMPLE',h.r,claim,'EXAMPLE_NEW_LEASE')).toBe('pending');expect(h.deps.send).toHaveBeenCalledOnce();
    if(mode==='429')expect(h.deps.storage.settle).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({rateLimited:true,reason:'quota'}));
  });
  it('crash between submitted marker and send never replays',async()=>{const h=harness();await h.deps.storage.prepare('EXAMPLE',h.r,claim,'EXAMPLE');await h.deps.storage.submit(h.row!,'EXAMPLE');expect(await h.execution.run('EXAMPLE',h.r,claim,'EXAMPLE')).toBe('pending');expect(h.deps.send).not.toHaveBeenCalled();});
  it('rejects changed payload on retry and wrong reconciliation digest',async()=>{const h=harness();await h.execution.run('EXAMPLE',h.r,claim,'EXAMPLE');await expect(h.execution.run('EXAMPLE',{...h.r,timestamp:1001},claim,'EXAMPLE')).rejects.toThrow('changed');vi.mocked(h.deps.reconcile).mockResolvedValue({state:'confirmed',requestDigest:'EXAMPLE_HASH',releaseSlot:false});expect(await h.execution.run('EXAMPLE',h.r,claim,'EXAMPLE')).toBe('pending');});
  it('confirms only a terminal transfer response bound to this exact request',async()=>{const h=harness();h.r.kind='fund';h.r.path='/account/subaccount/transfer';h.r.operationType='transfer_funds';h.r.data={to_account:h.r.account,amount:'100'};
    vi.mocked(h.deps.send).mockResolvedValue({rateLimited:false,terminalTransferDigest:requestDigest(h.r)});expect(await h.execution.run('EXAMPLE',h.r,{...claim,slots:0},'EXAMPLE')).toBe('confirmed');expect(h.deps.reconcile).not.toHaveBeenCalled();});
  it('seed history needs the exact full aggregate fill, never acknowledgement or partial exposure',()=>{const r={...request(),kind:'seed' as const};r.data={symbol:'BTC',amount:'1',side:'bid',reduce_only:false,client_order_id:r.data.client_order_id};
    const order:GridVenueOrder={orderId:'1',clientOrderId:String(r.data.client_order_id),symbol:'BTC',price:'100',amount:'1',filledAmount:'1',cancelledAmount:null,reduceOnly:false,orderType:'market',side:'long',status:'filled',createdAt:1000,updatedAt:1001};
    const e={kind:'seed' as const,account:r.account,complete:true,orders:[order],observedAt:1001};expect(reconcileGridLaunch(r,e,1001).state).toBe('confirmed');
    for(const patch of [{status:'open' as const},{status:'partially_filled' as const,filledAmount:'0.5'},{amount:'2'},{clientOrderId:randomUUID()}])expect(reconcileGridLaunch(r,{...e,orders:[{...order,...patch}]},1001).state).toBe('unknown');
  });
  it('only exact documented zero-fill post-only history is an expected crossing',()=>{const r=request();const rows=parseGridVenueOrders([{order_id:'1',client_order_id:r.data.client_order_id,symbol:'BTC',side:'bid',initial_price:'90',amount:'1',filled_amount:'0',reduce_only:false,order_type:'limit',created_at:1000,updated_at:1001,order_status:'rejected',reason:'post_only_rejected'}],true);
    expect(reconcileGridLimit(r,rows).state).toBe('expected_alo_cross');
    expect(reconcileGridLimit(r,[{...rows[0],reason:'EXAMPLE_error_text'}]).state).toBe('rejected');
    for(const patch of [{filledAmount:'0.1'},{price:'91'},{amount:'2'},{reduceOnly:true},{createdAt:999},{clientOrderId:randomUUID()}])expect(reconcileGridLimit(r,[{...rows[0],...patch} as GridVenueOrder]).state).toBe('unknown');
    expect(reconcileGridLimit(r,[...rows,...rows]).state).toBe('unknown');expect(reconcileGridLimit(r,[]).state).toBe('unknown');
  });
  it('signs only synthetic identities through the Grid transport with the retained timestamp and no redirects',async()=>{
    const sub=nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)),master=nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
    const r={...request(),account:bs58.encode(sub.publicKey),masterAccount:bs58.encode(master.publicKey)};
    const fetcher=vi.fn(async()=>new Response(null,{status:429})),key='EXAMPLE1_'+bs58.encode(new Uint8Array(16).fill(9));
    const sender=new GridPacificaSender(new PacificaTransportAuthority(key),fetcher as typeof fetch);expect(await sender.send(r,Buffer.from(sub.secretKey))).toEqual({rateLimited:true});
    const [url,init]=fetcher.mock.calls[0] as unknown as [string,RequestInit];expect(url).toBe('https://api.pacifica.fi/api/v1/orders/create');expect(init.redirect).toBe('error');expect(new Headers(init.headers).get('PF-API-KEY')).toBe(key);
    expect(JSON.parse(String(init.body))).toMatchObject({account:r.account,timestamp:1000,expiry_window:5000,tif:'ALO'});
    await expect(sender.send({...r,path:'/EXAMPLE'},Buffer.from(sub.secretKey))).rejects.toThrow();expect(fetcher).toHaveBeenCalledOnce();
  });
});
describe('bounded rolling placement',()=>{
  const levels=():WindowLevel[]=>Array.from({length:20},(_,i)=>({id:'EXAMPLE_'+i,ordinal:i+1,price:String(80+i),size:'1',reduceOnly:false,side:'buy',attempt:0}));
  const facts=()=>({levels:levels(),owned:[],positionSize:'0',bookPrice:'100',freeSlots:100,inventoryComplete:true,entriesAllowed:true,canaryRemaining:'10000'});
  it('chunks twenty valid actions into 10+10 without treating ten as the resting cap',()=>expect(gridWindow(facts()).map(c=>c.length)).toEqual([10,10]));
  it('prioritizes backed exits and blocks unbacked profits',()=>{const f=facts();f.levels[19].reduceOnly=true;expect(gridWindow({...f,positionSize:'1'})[0][0]).toMatchObject({level:{id:'EXAMPLE_19',reduceOnly:true}});expect(()=>gridWindow(f)).toThrow('backing');});
  it('entry denial retains backed exits; protection reserve remains free',()=>{const f=facts();f.levels[0].reduceOnly=true;expect(gridWindow({...f,positionSize:'1',entriesAllowed:false,freeSlots:6}).flat()).toHaveLength(1);expect(gridWindow({...facts(),freeSlots:5})).toEqual([]);});
  it('refuses unknown inventory and does not shrink orders to fit canary',()=>{expect(()=>gridWindow({...facts(),inventoryComplete:false})).toThrow();expect(gridWindow({...facts(),canaryRemaining:'79'})).toEqual([]);});
  it('an uncertain exit blocks every subsequent entry and chunk',async()=>{const f=facts();f.levels[19].reduceOnly=true;const chunks=gridWindow({...f,positionSize:'1'}),run=vi.fn(async()=> 'pending' as const),prepare=vi.fn(async()=>({key:'EXAMPLE',request:request(),claim,leaseToken:'EXAMPLE'}));expect(await executeGridWindow(chunks,{run},prepare)).toEqual({confirmed:0,state:'pending'});expect(run).toHaveBeenCalledOnce();});
});

describe('Grid terminal sweep sender',()=>{
  it.each([true,false])('requires the full nested terminal envelope: %s',async terminal=>{
    const sub=nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));const r:ExactGridRequest={...request(),kind:'sweep',account:bs58.encode(sub.publicKey),path:'/account/subaccount/transfer',operationType:'transfer_funds',data:{to_account:'EXAMPLE_MASTER',amount:'1'},authority:{settlementComplete:true}};
    const body=terminal?{success:true,error:null,data:{success:true,error:null}}:{success:true};const fetcher=vi.fn(async()=>new Response(JSON.stringify(body),{status:200}));
    const sender=new GridPacificaSender(new PacificaTransportAuthority('EXAMPLE1_'+bs58.encode(new Uint8Array(16).fill(9))),fetcher as typeof fetch);
    expect(await sender.send(r,Buffer.from(sub.secretKey))).toEqual(terminal?{rateLimited:false,terminalTransferDigest:requestDigest(r)}:{rateLimited:false});
    expect(JSON.parse(String((fetcher.mock.calls[0] as unknown as [string,RequestInit])[1].body))).toMatchObject({account:r.account,to_account:r.masterAccount,amount:'1'});
  });
});
