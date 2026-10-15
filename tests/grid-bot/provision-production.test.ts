import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import Decimal from 'decimal.js';
import {GridProvision,type GridProvisionDeps} from '../../server/grid-bot/provision';
import {GridExecution} from '../../server/grid-bot/execution';
import {reconcileGridTransfer} from '../../server/grid-bot/launch-reconciliation';
import {gridReconciliationOutcome} from '../../server/grid-bot/execution';
import {gridLevelRequest} from '../../server/grid-bot/placement';
import {requestDigest,GridLaunchTransientError,gridProvisionAttempt,gridOperationCouldHaveLanded,type DurableGridOperation,type ExactGridRequest} from '../../server/grid-bot/launch-storage';
import {observePacificaConstraints} from '../../server/protocol/market-constraints';
import {launchAuthorityFixture,clock,umk} from './launch-authority-fixtures';
beforeEach(()=>vi.spyOn(Date,'now').mockReturnValue(clock));
afterEach(()=>vi.restoreAllMocks());
function fixture(seed=false,reused=false){
  const f=launchAuthorityFixture(seed),account={...f.account,reused},operations=new Map<string,DurableGridOperation>(),sent:ExactGridRequest[]=[],steps:string[]=[];
  const execution=new GridExecution({now:()=>clock,storage:{read:async(_bot,key)=>operations.get(key)??null,
    prepare:async(key,r)=>{const op={id:key,state:'prepared',exact_request:r,exact_request_digest:requestDigest(r),failure_classification:null,submitted_at:null};operations.set(key,op);return op;},
    submit:async op=>{op.state='submitted';op.submitted_at=new Date(clock);return true;},settle:async(op,outcome)=>{
      // Recovery can settle a copy; persist against the durable identity like the real ledger.
      const retained=operations.get(op.id);if(!retained)throw Error('EXAMPLE settlement record missing');
      retained.state=outcome.state;retained.failure_classification=outcome.reason;
      if(outcome.transferProof)retained.transfer_recovery=outcome.transferProof;},
    expirePrepared:async op=>{if(op.state!=='prepared'||op.submitted_at!==null||op.exact_request.timestamp+op.exact_request.expiryMs>clock)return false;
      op.state='failed';op.failure_classification='policy';return true;}},
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
  return {...f,authorityDeps:f.deps,account,operations,sent,steps,deps,start:()=>new GridProvision(deps).start({wallet:account.wallet,policy:f.policy,policyHmac:f.policyHash})};
}
describe('C6 provisioning with the real C5 raw-read authority',()=>{
  it('C4 replaces a proven expired fund with a new UUID and follows the confirmed replacement on restart',async()=>{
    const f=fixture();expect((await f.start()).state).toBe('canary');
    const base=`grid:${f.policy.id}:launch:fund`,op=f.operations.get(base),created=f.operations.get(`grid:${f.policy.id}:launch:create`);
    if(!op||!created)throw Error('EXAMPLE launch records missing');
    const oldTransferKey=op.exact_request.data.idempotency_key;
    expect(created.state).toBe('confirmed');expect(op.exact_request.expiryMs).toBe(5000);
    created.exact_request.timestamp=clock-20000;created.exact_request_digest=requestDigest(created.exact_request);
    op.exact_request.timestamp=clock-10000;op.exact_request_digest=requestDigest(op.exact_request);op.state='unconfirmed';op.failure_classification='unknown';
    for(const [key,row] of f.operations)if(row!==op&&row!==created)f.operations.delete(key);
    const result=reconcileGridTransfer(op.exact_request,{account:f.account.account,masterAccount:f.account.masterAccount,complete:true,
      startedAt:clock-1000,observedAt:clock-1000,balanceAt:clock-1000,balance:'0',ownedAccounts:[f.account.account],subaccountHistory:[],mainHistory:[]},
      {reused:false,operations:[created,op]},clock);
    expect(result.state).toBe('not_landed');if(result.state!=='not_landed')throw Error('EXAMPLE expiry proof failed');
    const terminal=gridReconciliationOutcome(result);Object.assign(op,{state:terminal.state,failure_classification:terminal.reason,transfer_recovery:terminal.transferProof});
    f.sent.length=0;
    const restart=()=>new GridProvision(f.deps).start({wallet:f.account.wallet,policy:f.policy,policyHmac:f.policyHash,account:f.account});
    expect((await restart()).state).toBe('canary');expect((await restart()).state).toBe('canary');
    const transfers=f.sent.filter(r=>r.kind==='fund');expect(transfers).toHaveLength(1);expect(transfers[0].data.idempotency_key).not.toBe(oldTransferKey);
    expect(transfers[0].data.idempotency_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const replacement=await gridProvisionAttempt(f.deps.existing,f.policy.id,'fund',clock);expect(replacement.key).toContain(':retry:');expect(replacement.op?.state).toBe('confirmed');
  });
  it.each(['submitted','unconfirmed','confirmed','failed'] as const)('never replaces a %s funding attempt with send history',async state=>{
    const f=fixture();await f.start();const key=`grid:${f.policy.id}:launch:fund`,op=f.operations.get(key);if(!op)throw Error('EXAMPLE funding absent');
    op.state=state;op.failure_classification='policy';op.exact_request.timestamp=clock-6000;op.exact_request_digest=requestDigest(op.exact_request);
    expect(op.submitted_at).not.toBeNull();expect(gridOperationCouldHaveLanded(op)).toBe(true);
    expect(await gridProvisionAttempt(f.deps.existing,f.policy.id,'fund',clock)).toEqual({key,op});
  });
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
  it.each(['create','fund','leverage','seed','limit'] as const)('restarts a crash after preparing %s with fresh authority, preserving the unsent attempt',async kind=>{
    const f=fixture(true);let crashed=false,now=clock;
    vi.mocked(Date.now).mockImplementation(()=>now);f.deps.now=()=>now;
    f.deps.verifyEmpty=async()=>({account:f.account.account,masterAccount:f.account.masterAccount,state:'empty',observedAt:now,expiresAt:now+5000});
    // Crash immediately after durable prepare, before the submit CAS or sender.
    const ledger=new Map<string,DurableGridOperation>();
    f.deps.execution=new GridExecution({now:()=>now,storage:{read:async(_bot,key)=>ledger.get(key)??null,
      prepare:async(key,r)=>{const op:DurableGridOperation={id:'EXAMPLE_'+ledger.size,state:'prepared',submitted_at:null,exact_request:structuredClone(r),exact_request_digest:requestDigest(r),failure_classification:null};
        ledger.set(key,op);if(r.kind===kind&&!crashed){crashed=true;throw Error('EXAMPLE process crash');}return op;},
      submit:async op=>{op.state='submitted';op.submitted_at=new Date(now);return true;},settle:async(op,outcome)=>{op.state=outcome.state;},
      expirePrepared:async op=>{if(op.state!=='prepared'||op.submitted_at!==null||op.exact_request.timestamp+op.exact_request.expiryMs>now)return false;
        op.state='failed';op.failure_classification='policy';return true;}},
      preflight:async r=>{const facts=r.authority.facts as {observedAt:number;expiresAt:number};return facts.observedAt===now&&facts.expiresAt>now;},
      send:async r=>{f.sent.push(r);return {rateLimited:false,...(r.kind==='fund'?{terminalTransferDigest:requestDigest(r)}:{})};},
      reconcile:async op=>({state:'confirmed',requestDigest:op.exact_request_digest,releaseSlot:false})});
    f.deps.existing=async key=>ledger.get(key)??null;
    await expect(f.start()).rejects.toThrow('process crash');
    const expired=[...ledger.values()].find(op=>op.state==='prepared');if(!expired)throw Error('EXAMPLE crash record absent');
    const retainedDigest=expired.exact_request_digest,retainedRequest=structuredClone(expired.exact_request);
    now+=6000;f.raw.master.updated_at=now;f.raw.sub.updated_at=now;f.raw.book.t=now;
    f.authorityDeps.sol=async()=>({balance:'0.1',observedAt:now});
    const restart=()=>new GridProvision(f.deps).start({wallet:f.account.wallet,policy:f.policy,policyHmac:f.policyHash,account:f.account});
    expect((await restart()).state).toBe('canary');expect((await restart()).state).toBe('canary');
    expect(f.sent.map(r=>r.kind)).toEqual(['create','fund','leverage','seed','limit']);
    expect(expired.state).toBe('failed');expect(expired.submitted_at).toBeNull();expect(expired.exact_request_digest).toBe(retainedDigest);
    expect(expired.exact_request).toEqual(retainedRequest);
    const retry=await gridProvisionAttempt(f.deps.existing,f.policy.id,kind==='limit'?'entry':kind,now);
    expect(retry.key).toContain(':retry:');expect(retry.op?.state).toBe('confirmed');expect(retry.op?.exact_request.timestamp).toBe(now);
  });
});
