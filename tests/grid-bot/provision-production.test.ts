import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import Decimal from 'decimal.js';
import {GridProvision,type GridProvisionDeps} from '../../server/grid-bot/provision';
import {GridExecution} from '../../server/grid-bot/execution';
import {gridLevelRequest} from '../../server/grid-bot/placement';
import {requestDigest,GridLaunchTransientError,type DurableGridOperation,type ExactGridRequest} from '../../server/grid-bot/launch-storage';
import {observePacificaConstraints} from '../../server/protocol/market-constraints';
import {launchAuthorityFixture,clock,umk} from './launch-authority-fixtures';
beforeEach(()=>vi.spyOn(Date,'now').mockReturnValue(clock));
afterEach(()=>vi.restoreAllMocks());
function fixture(seed=false,reused=false){
  const f=launchAuthorityFixture(seed),account={...f.account,reused},operations=new Map<string,DurableGridOperation>(),sent:ExactGridRequest[]=[],steps:string[]=[];
  const execution=new GridExecution({now:()=>clock,storage:{read:async(_bot,key)=>operations.get(key)??null,
    prepare:async(key,r)=>{const op={id:key,state:'prepared',exact_request:r,exact_request_digest:requestDigest(r),failure_classification:null};operations.set(key,op);return op;},
    submit:async op=>{op.state='submitted';return true;},settle:async(op,outcome)=>{op.state=outcome.state;}},
    preflight:async()=>true,send:async r=>{sent.push(r);return {rateLimited:false,...(r.kind==='fund'?{terminalTransferDigest:requestDigest(r)}:{})};},
    reconcile:async op=>({state:'confirmed',requestDigest:op.exact_request_digest,releaseSlot:false})});
  const deps:GridProvisionDeps={now:()=>clock,durableUmk:async()=>({umk:umk(),cleanup:vi.fn()}),
    observe:(policy,a)=>f.authority.observe(account.wallet,policy,a,umk()),
    custody:{reserve:vi.fn(async()=>account),confirmCreated:vi.fn(),confirmReused:vi.fn()},
    verifyEmpty:async()=>({account:account.account,masterAccount:account.masterAccount,state:'empty',observedAt:clock,expiresAt:clock+5000}),
    existing:async key=>operations.get(key)??null,markCanary:vi.fn(),execution,beforeStep:async(_a,kind)=>{steps.push(kind);return {};},
    prepareFirstEntry:async({admission,facts,now,policy,policyHmac})=>{
      const l=policy.levels.find(line=>line.ordinal===admission.firstEntryOrdinal);if(!l)throw Error('EXAMPLE first entry missing');
      return {request:gridLevelRequest({account,level:{...l,id:'EXAMPLE_LEVEL',attempt:0},market:policy.market,protocolSymbol:'BTC',signerGeneration:'EXAMPLE_GENERATION',
        deployment:facts.recycler.deployment,fee:facts.maker,constraint:observePacificaConstraints({tick_size:facts.tick,lot_size:facts.lot,min_order_size:facts.minimumQuote},policy.market,facts.observedAt),
        now,authority:{policy,policyHmac,facts}}),claim:{credits:'10',slots:1,canaryIncrement:new Decimal(l.price).mul(l.size).toFixed(),
          observedCredits:facts.observedCredits,availableSlots:facts.availableSlots,observedAt:facts.observedAt,expiresAt:facts.expiresAt}};
    }};
  return {...f,account,operations,sent,steps,deps,start:()=>new GridProvision(deps).start({wallet:account.wallet,policy:f.policy,policyHmac:f.policyHash})};
}
describe('C6 provisioning with the real C5 raw-read authority',()=>{
  it.each([{seed:false,reused:false},{seed:true,reused:false},{seed:false,reused:true}])('progresses full funding and unchanged seed/ALO geometry: %j',async({seed,reused})=>{
    const f=fixture(seed,reused);expect((await f.start()).state).toBe('canary');
    const expected=[...(!reused?['create']:[]),'fund','leverage',...(seed?['seed']:[]),'limit'];
    expect(f.sent.map(r=>r.kind)).toEqual(expected);expect(f.steps).toEqual(expected);
    expect(f.sent.find(r=>r.kind==='fund')?.data.amount).toBe(f.policy.totalInvestment);
    expect(f.sent.at(-1)).toMatchObject({kind:'limit',data:{tif:'ALO',reduce_only:false}});
    if(reused)expect(f.deps.custody.confirmReused).toHaveBeenCalledOnce();else expect(f.deps.custody.confirmCreated).toHaveBeenCalledOnce();
    expect(f.deps.markCanary).toHaveBeenCalledOnce();
  });
  it('missing real CARRY approval denies before reservation or funding',async()=>{const f=fixture();f.raw.approvals=[];
    expect((await f.start()).state).toBe('denied');expect(f.deps.custody.reserve).not.toHaveBeenCalled();expect(f.sent).toEqual([]);});
  it('a Stop between funding and leverage blocks every subsequent send',async()=>{
    const f=fixture();f.deps.beforeStep=async(_a,kind)=>{if(kind==='leverage')throw new GridLaunchTransientError('EXAMPLE Stop owns account');return {};};
    expect((await f.start()).state).toBe('pending');expect(f.sent.map(r=>r.kind)).toEqual(['create','fund']);expect(f.deps.markCanary).not.toHaveBeenCalled();
  });
  it('post-fund book movement is reread from raw observations before seed or entry',async()=>{
    const f=fixture(true);f.deps.beforeStep=async(_a,kind)=>{if(kind==='seed')f.raw.book.l=[[{p:'119.99',a:'1'}],[{p:'120.01',a:'1'}]];return {};};
    expect((await f.start()).state).toBe('denied');expect(f.sent.map(r=>r.kind)).toEqual(['create','fund','leverage']);
  });
  it('unknown retained funding prevents even a fresh facts read',async()=>{
    const f=fixture(),r:ExactGridRequest={kind:'fund',botId:f.policy.id,account:f.account.account,masterAccount:f.account.masterAccount,path:'/account/subaccount/transfer',operationType:'transfer_funds',timestamp:clock-10000,expiryMs:5000,data:{to_account:f.account.account,amount:'100'},authority:{}};
    f.operations.set(`grid:${f.policy.id}:launch:fund`,{id:'EXAMPLE_RETAINED',state:'unconfirmed',exact_request:r,exact_request_digest:requestDigest(r),failure_classification:null});
    const observe=vi.fn(f.deps.observe);f.deps.observe=observe;f.deps.execution={run:vi.fn(async()=> 'pending' as const)};
    expect((await new GridProvision(f.deps).start({wallet:f.account.wallet,policy:f.policy,policyHmac:f.policyHash,account:f.account})).state).toBe('pending');
    expect(observe).not.toHaveBeenCalled();expect(f.sent).toEqual([]);
  });
});
