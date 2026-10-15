import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
import Decimal from 'decimal.js';
import * as production from '../../server/grid-bot/launch-authority';
import {GridProvision,type GridProvisionDeps} from '../../server/grid-bot/provision';
import {GRID_START_ROUTE_ENABLED,GRID_WORKER_ENABLED} from '../../server/grid-bot/service';
import {gridClientOrderId} from '../../server/grid-bot/order-identity';
import {requestDigest,GridLaunchTransientError,type ExactGridRequest} from '../../server/grid-bot/launch-storage';
import {launchAuthorityFixture,clock,umk} from './launch-authority-fixtures';
beforeEach(()=>vi.spyOn(Date,'now').mockReturnValue(clock));
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
const prepareFirstEntry:NonNullable<GridProvisionDeps['prepareFirstEntry']>=async({account,policy,policyHmac,admission,facts,now})=>{
  const line=policy.levels.find(l=>l.ordinal===admission.firstEntryOrdinal)!;
  const request:ExactGridRequest={kind:'limit',botId:policy.id,account:account.account,masterAccount:account.masterAccount,path:'/orders/create',operationType:'create_order',timestamp:now,expiryMs:5000,
    data:{symbol:'BTC',price:line.price,amount:line.size,side:line.side==='buy'?'bid':'ask',tif:'ALO',reduce_only:false,client_order_id:gridClientOrderId({botId:policy.id,level:line.ordinal,attempt:0,leg:'entry'})},
    authority:{policy,policyHmac,facts,levelId:'EXAMPLE_LEVEL',levelAttempt:0}};
  return {request,claim:{credits:'10',slots:1,canaryIncrement:new Decimal(line.price).mul(line.size).toFixed(),observedCredits:facts.observedCredits,availableSlots:facts.availableSlots,observedAt:facts.observedAt,expiresAt:facts.expiresAt}};
};
describe('C5 default provision wiring',()=>{
  it.each([false,true])('uses production reads for initial admission and every intervening step, seed=%s',async seed=>{
    const f=launchAuthorityFixture(seed),observations=vi.spyOn(f.authority,'observe');vi.spyOn(production,'defaultGridLaunchAuthority').mockResolvedValue(f.authority);
    const done=new Map<string,any>(),run=vi.fn(async(key:string,request:ExactGridRequest)=>{done.set(key,{state:'confirmed',exact_request:request,exact_request_digest:requestDigest(request)});return 'confirmed' as const;});
    const key=umk(),cleanup=vi.fn(()=>key.fill(0)),reserve=vi.fn(async()=>f.account),markCanary=vi.fn();
    const p=new GridProvision({now:()=>clock,durableUmk:async()=>({umk:key,cleanup}),custody:{reserve,confirmCreated:vi.fn(),confirmReused:vi.fn()},
      verifyEmpty:async()=>({account:f.account.account,masterAccount:f.account.masterAccount,state:'empty',observedAt:clock,expiresAt:clock+5000}),
      existing:async key=>done.get(key)??null,execution:{run},markCanary,prepareFirstEntry});
    expect(await p.start({wallet:f.account.wallet,policy:f.policy,policyHmac:f.policyHash})).toMatchObject({state:'canary',account:f.account});
    expect(observations.mock.calls.map(c=>c[2]?.account??null)).toEqual(seed?[null,null,f.account.account,f.account.account,f.account.account,f.account.account]:[null,null,f.account.account,f.account.account,f.account.account]);
    const requests=run.mock.calls.map(c=>c[1]);expect(requests.map(r=>r.kind)).toEqual(seed?['create','fund','leverage','seed','limit']:['create','fund','leverage','limit']);
    expect(requests.find(r=>r.kind==='fund')!.data.amount).toBe(f.policy.totalInvestment);
    if(seed){const r=requests.find(r=>r.kind==='seed')!;expect(r.data.amount).toBe((r.authority.admission as Extract<import('../../server/grid-bot/provision').LaunchAdmission,{ok:true}>).plan.seedQuantity);}
    const entry=requests.at(-1)!,line=f.policy.levels.find(l=>l.price===entry.data.price)!;expect(entry.data.amount).toBe(line.size);
    expect(cleanup).toHaveBeenCalledOnce();expect(key.every(v=>v===0)).toBe(true);expect(markCanary).toHaveBeenCalledOnce();
  });
  it('missing production authority reserves and sends nothing and cleans the UMK',async()=>{
    const f=launchAuthorityFixture();vi.spyOn(production,'defaultGridLaunchAuthority').mockResolvedValue(f.authority);f.deps.configuration=()=>({builderCode:null,builderOwner:null});
    const reserve=vi.fn(),run=vi.fn(),cleanup=vi.fn(),p=new GridProvision({now:()=>clock,durableUmk:async()=>({umk:umk(),cleanup}),
      custody:{reserve,confirmCreated:vi.fn(),confirmReused:vi.fn()},verifyEmpty:vi.fn(),execution:{run},existing:async()=>null,markCanary:vi.fn()});
    expect(await p.start({wallet:f.account.wallet,policy:f.policy,policyHmac:f.policyHash})).toMatchObject({state:'denied'});
    expect(reserve).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();expect(cleanup).toHaveBeenCalledOnce();expect(f.cleanup).toHaveBeenCalledOnce();
  });
  it('keeps both production gates hard false even with enabling environment values',()=>{
    vi.stubEnv('GRID_START_ROUTE_ENABLED','true');vi.stubEnv('GRID_WORKER_ENABLED','true');
    expect(GRID_START_ROUTE_ENABLED).toBe(false);expect(GRID_WORKER_ENABLED).toBe(false);
  });
  it('preserves quota/backoff as pending while sending and reserving nothing',async()=>{
    const f=launchAuthorityFixture();vi.spyOn(production,'defaultGridLaunchAuthority').mockResolvedValue(f.authority);
    vi.mocked(f.deps.reads.json).mockRejectedValueOnce(new GridLaunchTransientError('EXAMPLE_BACKOFF'));
    const reserve=vi.fn(),run=vi.fn(),cleanup=vi.fn(),p=new GridProvision({now:()=>clock,durableUmk:async()=>({umk:umk(),cleanup}),
      custody:{reserve,confirmCreated:vi.fn(),confirmReused:vi.fn()},verifyEmpty:vi.fn(),execution:{run},existing:async()=>null,markCanary:vi.fn()});
    expect(await p.start({wallet:f.account.wallet,policy:f.policy,policyHmac:f.policyHash})).toMatchObject({state:'pending'});
    expect(reserve).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();expect(cleanup).toHaveBeenCalledOnce();expect(f.cleanup).toHaveBeenCalledOnce();
  });
});
