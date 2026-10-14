import {describe,it,expect,vi} from 'vitest';
import Decimal from 'decimal.js';
import {calculateGrid} from '../../server/grid-bot/engine';
import {computeGridPolicyHmac,type GridPolicy} from '../../server/grid-bot/policy-hmac';
import {createGridFeeQuote} from '../../server/grid-bot/fee-authority';
import {projectGridStop,GRID_STOP_EXECUTION_CUSHION} from '../../server/grid-bot/stop-clearance';
import {preflightGridLaunch,GridProvision,GRID_FUND_IDENTITY_LEVEL,GRID_SEED_IDENTITY_LEVEL,type LaunchFacts} from '../../server/grid-bot/provision';
import {gridClientOrderId} from '../../server/grid-bot/order-identity';
import {GridExecution} from '../../server/grid-bot/execution';
import {GridLaunchTransientError,requestDigest,type DurableGridOperation,type ExactGridRequest} from '../../server/grid-bot/launch-storage';
import {GRID_START_ROUTE_ENABLED,GRID_WORKER_ENABLED} from '../../server/grid-bot/service';
import {policy as basePolicy,umk,clock} from './draft-fixtures';

export function launchFixture(seed=false,start='100'){
  const calc=calculateGrid({side:'long',lower:'90',upper:'110',start,intervals:20,entryScale:'flat',profitScale:'flat',seed,leverage:'2',tick:'0.01',lot:'0.001',minimumQuote:'1',investmentStep:'0.01',transferFloor:'1',effectiveMakerCostRate:'0',investment:'100'});
  if(!calc.ok)throw Error(JSON.stringify(calc.issues));const plan=calc.plan;
  const policy:GridPolicy={...basePolicy(),startPrice:new Decimal(start).toFixed(8),gridCount:20,leverage:2,seedAtCreation:seed,levels:plan.lines.map(l=>({ordinal:l.ordinal+1,price:new Decimal(l.price).toFixed(8),size:new Decimal(l.quantity).toFixed(8),side:l.role==='seed_exit'?'sell':'buy',reduceOnly:l.role==='seed_exit'}))};
  const h=computeGridPolicyHmac(policy,umk());if(!h.ok)throw Error();
  const quote=(role:'maker'|'taker',intent:'entry'|'profit')=>{const r=createGridFeeQuote({account:'EXAMPLE_MASTER',subaccountId:null,market:'BTC-PERP',liquidityRole:role,builderCode:'CARRY',intent},{account:'EXAMPLE_MASTER',maker_fee:'0',taker_fee:'0'},[{builder_code:'CARRY',fee_rate:'0'}],[{builder_code:'CARRY',max_fee_rate:'0'}],clock);if(r.availability!=='available')throw Error(r.reason);return r.quote;};
  const facts:LaunchFacts={observedAt:clock,expiresAt:clock+5000,masterAccount:'EXAMPLE_MASTER',account:null,bookPrice:'100',bookSource:'/book',tick:'0.01',lot:'0.001',minimumQuote:'1',maximumQuote:'10000',minimumPrice:'1',maximumPrice:'10000',maxLeverage:'10',restrictions:'unrestricted',maker:quote('maker','entry'),profit:quote('maker','profit'),taker:quote('taker','entry'),masterWithdrawable:'100',sol:'0.1',availableSlots:100,subaccountCount:0,observedCredits:'300',availableGridCredits:'150',transportReady:true,inventoryComplete:true,recycler:{reuse:true,recycle:true,deployment:'EXAMPLE',expectedDeployment:'EXAMPLE',checkedAt:clock}};
  facts.bookPrice=start;return {policy,policyHash:h.digest,facts,plan};
}
function prepareFirstEntry({account,policy,policyHmac,admission,facts,now}:Parameters<NonNullable<import('../../server/grid-bot/provision').GridProvisionDeps['prepareFirstEntry']>>[0]){
  const line=policy.levels.find(l=>l.ordinal===admission.firstEntryOrdinal)!;
  const request:ExactGridRequest={kind:'limit',botId:policy.id,account:account.account,masterAccount:account.masterAccount,path:'/orders/create',operationType:'create_order',timestamp:now,expiryMs:5000,
    data:{symbol:policy.market.replace(/-PERP$/,''),price:line.price,amount:line.size,side:line.side==='buy'?'bid':'ask',tif:'ALO',reduce_only:false,
      client_order_id:gridClientOrderId({botId:policy.id,level:line.ordinal,attempt:0,leg:'entry'})},authority:{policy,policyHmac,facts,levelId:'EXAMPLE',levelAttempt:0}};
  return Promise.resolve({request,claim:{credits:'10',slots:1 as const,canaryIncrement:new Decimal(line.price).mul(line.size).toFixed(),observedCredits:facts.observedCredits,availableSlots:facts.availableSlots,observedAt:facts.observedAt,expiresAt:facts.expiresAt}});
}
describe('projected new-subaccount stop clearance',()=>{
  const plan={side:'long' as const,start:'100',investment:'100',leverage:'10',lines:[],seedQuantity:'10',allocatedNotional:'1000',unallocatedNotional:'0',feeGate:'evaluated' as const,feeRows:[]};
  const input={plan,funding:'100',stop:'96',tick:'0.01',maxLeverage:'20',makerRate:'0',takerRate:'0',observedAt:clock,expiresAt:clock+5000};
  it('matches Pacifica long formula including the worst seed and tick-rounded 1% cushion',()=>{
    expect(GRID_STOP_EXECUTION_CUSHION).toBe('0.01');
    const r=projectGridStop(input,clock);expect(r).toMatchObject({state:'available',liquidation:'92.83',validatedClearance:'0.93'});
    expect(projectGridStop({...input,stop:'93.75'},clock).state).toBe('unavailable');
    expect(projectGridStop({...input,stop:'93.76'},clock).state).toBe('available');
  });
  it('matches short formula and denies a stop inside the tick-aware cushion',()=>{
    const short={...input,plan:{...plan,side:'short' as const},stop:'105'};
    expect(projectGridStop(short,clock)).toMatchObject({state:'available',liquidation:'106.82',validatedClearance:'1.07'});
    expect(projectGridStop({...short,stop:'105.76'},clock).state).toBe('unavailable');
    expect(projectGridStop({...short,stop:'105.75'},clock).state).toBe('available');
  });
  it('includes every admitted entry and fees using only the supplied new account funding',()=>{
    const r=projectGridStop({...input,plan:{...plan,lines:[{ordinal:0,price:'90',quantity:'2',notional:'180',role:'entry',pairedExitOrdinal:1}]},takerRate:'0.001',makerRate:'0.001'},clock);
    expect(r.state).toBe('available');if(r.state==='available')expect(r.projection).toMatchObject({size:'12',funding:'100',fees:'1.185'});
    expect(projectGridStop({...input,funding:'0'},clock).state).toBe('unavailable');
  });
  it.each([{maxLeverage:''},{funding:'NaN'},{tick:'0'},{stop:'96.001'},{expiresAt:clock},{observedAt:clock+1},{makerRate:'unknown'}])('denies unknown, stale or non-tick input %j',patch=>expect(projectGridStop({...input,...patch},clock).state).toBe('unavailable'));
});
describe('Grid launch preflight and hard production gates',()=>{
  it.each(['long','short'] as const)('keeps seed and funding identities disjoint from every %s gridCount boundary',side=>{
    const botId=basePolicy().id;
    expect(GRID_SEED_IDENTITY_LEVEL).toBeGreaterThan(101);expect(GRID_SEED_IDENTITY_LEVEL).not.toBe(GRID_FUND_IDENTITY_LEVEL);
    const seed=gridClientOrderId({botId,level:GRID_SEED_IDENTITY_LEVEL,attempt:0,leg:'entry'});
    const fund=gridClientOrderId({botId,level:GRID_FUND_IDENTITY_LEVEL,attempt:0,leg:'profit'});
    expect(seed).not.toBe(fund);
    for(let intervals=1;intervals<=100;intervals++){
      const result=calculateGrid({side,lower:'90',upper:'110',start:'100',intervals,entryScale:'flat',profitScale:'flat',seed:true,leverage:'2',tick:'0.01',lot:'0.001',minimumQuote:'1',investmentStep:'0.01',transferFloor:'1',effectiveMakerCostRate:'0',investment:'10000'});
      expect(result.ok).toBe(true);if(!result.ok)throw Error('EXAMPLE geometry failed');
      expect(result.plan.lines).toHaveLength(intervals+1);
      for(const line of result.plan.lines)for(const leg of ['entry','profit'] as const){
        const id=gridClientOrderId({botId,level:line.ordinal+1,attempt:0,leg});expect(id).not.toBe(seed);expect(id).not.toBe(fund);
      }
      if(side==='short'&&intervals===100)expect(result.plan.lines[100]).toMatchObject({ordinal:100,role:'entry'});
    }
  });
  it.each(['stale','future'] as const)('makes zero custody or execution mutations with %s recycler evidence',async mode=>{
    const f=launchFixture();f.facts.recycler.checkedAt=mode==='stale'?clock-5001:clock+1;
    const reserve=vi.fn(),run=vi.fn();
    const p=new GridProvision({now:()=>clock,durableUmk:async()=>({umk:umk(),cleanup:vi.fn()}),observe:async()=>f.facts,custody:{reserve,confirmCreated:vi.fn(),confirmReused:vi.fn()},verifyEmpty:vi.fn(),execution:{run},existing:vi.fn(),markCanary:vi.fn()});
    expect((await p.start({wallet:'EXAMPLE',policy:f.policy,policyHmac:f.policyHash})).state).toBe('denied');expect(reserve).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();
  });
  it.each(['quota','read backoff'] as const)('returns pending without mutations for transient %s',async mode=>{
    const f=launchFixture();f.facts.availableGridCredits='0';const cleanup=vi.fn(),reserve=vi.fn(),run=vi.fn();
    const p=new GridProvision({now:()=>clock,durableUmk:async()=>({umk:umk(),cleanup}),observe:async()=>{if(mode==='read backoff')throw new GridLaunchTransientError('backoff');return f.facts;},custody:{reserve,confirmCreated:vi.fn(),confirmReused:vi.fn()},verifyEmpty:vi.fn(),execution:{run},existing:vi.fn(),markCanary:vi.fn()});
    expect((await p.start({wallet:'EXAMPLE',policy:f.policy,policyHmac:f.policyHash})).state).toBe('pending');expect(reserve).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();expect(cleanup).toHaveBeenCalledOnce();
  });
  it('completes create/fund/leverage/seed with a real advancing clock beyond one request expiry',async()=>{
    vi.useRealTimers();const f=launchFixture(true,'109');
    const account={botId:f.policy.id,wallet:'EXAMPLE',masterAccount:'EXAMPLE_MASTER',account:'EXAMPLE_SUB',leaseToken:'EXAMPLE',reused:false};
    const done=new Map<string,DurableGridOperation>(),requests:ExactGridRequest[]=[];
    const execution=new GridExecution({now:Date.now,storage:{
      read:async(_bot,key)=>done.get(key)??null,
      prepare:async(key,r,claim)=>{const now=Date.now();expect(r.timestamp).toBeLessThanOrEqual(now);expect(r.timestamp+r.expiryMs).toBeGreaterThan(now);expect(claim.expiresAt).toBeGreaterThan(now);
        const op={id:key,state:'prepared',exact_request:r,exact_request_digest:requestDigest(r),failure_classification:null};done.set(key,op);return op;},
      submit:async op=>{op.state='submitted';return true;},settle:async(op,outcome)=>{done.get(op.id)!.state=outcome.state;}
    },preflight:async r=>preflightGridLaunch(f.policy,f.policyHash,umk(),r.authority.facts as LaunchFacts,Date.now(),done.get(`grid:${f.policy.id}:launch:fund`)?.state==='confirmed').ok,
      send:async r=>{requests.push(r);await new Promise(resolve=>setTimeout(resolve,1700));return {rateLimited:false};},
      reconcile:async op=>({state:'confirmed',requestDigest:op.exact_request_digest,releaseSlot:true})});
    const p=new GridProvision({now:Date.now,durableUmk:async()=>({umk:umk(),cleanup:vi.fn()}),
      observe:async(_policy,a)=>{const now=Date.now(),facts=structuredClone(f.facts);facts.observedAt=now;facts.expiresAt=now+5000;facts.recycler.checkedAt=now;facts.account=a?.account??null;
        for(const k of ['maker','profit','taker'] as const){const old=facts[k]!,owner=a?.account??facts.masterAccount;
          const q=createGridFeeQuote({account:owner,subaccountId:null,market:old.market,liquidityRole:old.liquidityRole,builderCode:old.builderCode,intent:old.intent},{account:owner,maker_fee:'0',taker_fee:'0'},[{builder_code:'CARRY',fee_rate:'0'}],[{builder_code:'CARRY',max_fee_rate:'0'}],now);
          if(q.availability!=='available')throw Error(q.reason);facts[k]=q.quote;}
        await new Promise(resolve=>setTimeout(resolve,10));return facts;},
      custody:{reserve:async()=>account,confirmCreated:vi.fn(),confirmReused:vi.fn()},verifyEmpty:async()=>{const now=Date.now();return {account:account.account,masterAccount:account.masterAccount,state:'empty',observedAt:now,expiresAt:now+5000};},
      execution,existing:async key=>done.get(key)??null,markCanary:vi.fn(),prepareFirstEntry});
    expect(await p.start({wallet:'EXAMPLE',policy:f.policy,policyHmac:f.policyHash})).toMatchObject({state:'canary'});
    expect(requests.map(r=>r.kind)).toEqual(['create','fund','leverage','seed','limit']);
    expect(requests[3].timestamp-requests[0].timestamp).toBeGreaterThan(5000);
    for(const r of requests)expect(r.timestamp).toBeGreaterThan((r.authority.facts as LaunchFacts).recycler.checkedAt);
    expect(requests[3].data.client_order_id).toBe(gridClientOrderId({botId:f.policy.id,level:103,attempt:0,leg:'entry'}));
    expect(requests[3].data.client_order_id).not.toBe(requests[1].data.idempotency_key);
  },15000);
  it('admits unchanged seed-off geometry with a funded stop and valid canary entry',()=>{const f=launchFixture();expect(preflightGridLaunch(f.policy,f.policyHash,umk(),f.facts,clock)).toMatchObject({ok:true});});
  it.each(['policy','fees','price','constraints','quota','recycler','slots','stop','canary','sol','transport','balance','durable security'])('failed %s preflight reserves and sends nothing',async defect=>{
    const f=launchFixture(defect==='canary');
    if(defect==='policy')f.policy.upperPrice='111.00000000';if(defect==='fees')f.facts.maker={...f.facts.maker,expiresAt:clock};
    if(defect==='price')f.facts.bookPrice='101';if(defect==='constraints')f.facts.maxLeverage='1';if(defect==='quota')f.facts.observedCredits='0';
    if(defect==='recycler')f.facts.recycler.reuse=false;if(defect==='slots')f.facts.availableSlots=5;
    if(defect==='stop'){f.policy.stopLossPrice='1.00000000';const h=computeGridPolicyHmac(f.policy,umk());if(h.ok)f.policyHash=h.digest;}
    if(defect==='sol')f.facts.sol=null;if(defect==='transport')f.facts.transportReady=false;if(defect==='balance')f.facts.masterWithdrawable='99';
    const reserve=vi.fn(),send=vi.fn(),cleanup=vi.fn();
    const provision=new GridProvision({now:()=>clock,durableUmk:async()=>defect==='durable security'?null:{umk:umk(),cleanup},observe:async()=>f.facts,custody:{reserve,confirmCreated:vi.fn(),confirmReused:vi.fn()},verifyEmpty:vi.fn(),execution:{run:send},existing:vi.fn(),markCanary:vi.fn()});
    expect((await provision.start({wallet:'EXAMPLE',policy:f.policy,policyHmac:f.policyHash})).state).toBe('denied');expect(reserve).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
  });
  it('denies an aggregate seed exceeding venue limits before custody or funding',()=>{const f=launchFixture(true,'106');f.facts.maximumQuote='20';expect(preflightGridLaunch(f.policy,f.policyHash,umk(),f.facts,clock)).toMatchObject({ok:false,reason:'The unchanged aggregate seed exceeds current market bounds.'});});
  it('denies extra signed levels instead of ignoring them',()=>{const f=launchFixture();f.policy.levels.push({...f.policy.levels[0],ordinal:99});expect(preflightGridLaunch(f.policy,f.policyHash,umk(),f.facts,clock)).toMatchObject({ok:false,reason:'Grid policy signature or version changed.'});});
  it('production cannot enable start or workers through environment configuration',()=>{process.env.GRID_WORKER_ENABLED='true';expect(GRID_START_ROUTE_ENABLED).toBe(false);expect(GRID_WORKER_ENABLED).toBe(false);delete process.env.GRID_WORKER_ENABLED;});
  it.each([false,true])('journals exact funding then leverage and optional seed=%s with fresh reserved-account fees',async seed=>{
    const f=launchFixture(seed,'109'),account={botId:f.policy.id,wallet:'EXAMPLE',masterAccount:'EXAMPLE_MASTER',account:'EXAMPLE_SUB',leaseToken:'EXAMPLE',reused:false};
    const done=new Map<string,any>(),calls:string[]=[];
    const observe=vi.fn(async(_p:GridPolicy,a:typeof account|null)=>{const facts=structuredClone(f.facts);if(a){facts.account=a.account;
      for(const k of ['maker','profit','taker'] as const){const old=facts[k]!;const q=createGridFeeQuote({account:a.account,subaccountId:null,market:old.market,liquidityRole:old.liquidityRole,builderCode:old.builderCode,intent:old.intent},{account:a.account,maker_fee:'0',taker_fee:'0'},[{builder_code:'CARRY',fee_rate:'0'}],[{builder_code:'CARRY',max_fee_rate:'0'}],clock);if(q.availability!=='available')throw Error();facts[k]=q.quote;}}
      return facts;});
    const markCanary=vi.fn(),run=vi.fn(async(key,r)=>{calls.push(r.kind);done.set(key,{state:'confirmed',exact_request:r});return 'confirmed' as const;});
    const p=new GridProvision({now:()=>clock,durableUmk:async()=>({umk:umk(),cleanup:vi.fn()}),observe,custody:{reserve:async()=>account,confirmCreated:vi.fn(),confirmReused:vi.fn()},verifyEmpty:async()=>({account:account.account,masterAccount:account.masterAccount,state:'empty',observedAt:clock,expiresAt:clock+5000}),execution:{run},existing:async k=>done.get(k),markCanary,prepareFirstEntry});
    const result=await p.start({wallet:'EXAMPLE',policy:f.policy,policyHmac:f.policyHash});expect(result,result.reason).toMatchObject({state:'canary'});
    expect(calls).toEqual(seed?['create','fund','leverage','seed','limit']:['create','fund','leverage','limit']);expect(markCanary).toHaveBeenCalledOnce();
    const entry=done.get(`grid:${f.policy.id}:launch:entry`).exact_request;expect(entry.data).toMatchObject({tif:'ALO',reduce_only:false});
    const line=f.policy.levels.find(l=>l.price===entry.data.price)!;expect(entry.data.amount).toBe(line.size);
    await p.start({wallet:'EXAMPLE',policy:f.policy,policyHmac:f.policyHash,account});expect(run).toHaveBeenCalledTimes(seed?5:4);
    if(seed){const r=done.get(`grid:${f.policy.id}:launch:seed`).exact_request;expect(r.data).toMatchObject({slippage_percent:'0.5',reduce_only:false});expect(r.authority.facts.taker.account).toBe(account.account);}
  });
  it.each([false,true])('retains an ambiguous first entry after a crash without a second send or sweep: seed=%s',async seed=>{
    const f=launchFixture(seed,'109'),account={botId:f.policy.id,wallet:'EXAMPLE',masterAccount:'EXAMPLE_MASTER',account:'EXAMPLE_SUB',leaseToken:'EXAMPLE',reused:false};
    const done=new Map<string,DurableGridOperation>(),sent:ExactGridRequest[]=[];
    const execution=new GridExecution({now:()=>clock,storage:{read:async(_bot,key)=>done.get(key)??null,
      prepare:async(key,r)=>{const op={id:key,state:'prepared',exact_request:r,exact_request_digest:requestDigest(r),failure_classification:null};done.set(key,op);return op;},
      submit:async op=>{op.state='submitted';return true;},settle:async(op,outcome)=>{op.state=outcome.state;}},
      preflight:async()=>true,send:async r=>{sent.push(r);if(r.kind==='limit')throw Error('EXAMPLE crash or rejected first-placement authority');return {rateLimited:false};},
      reconcile:async op=>op.exact_request.kind==='limit'?{state:'unknown'}:{state:'confirmed',requestDigest:op.exact_request_digest,releaseSlot:true}});
    const observe=async(_p:GridPolicy,a:typeof account|null)=>{const facts=structuredClone(f.facts);facts.account=a?.account??null;
      for(const k of ['maker','profit','taker'] as const){const old=facts[k]!,owner=a?.account??facts.masterAccount;
        const q=createGridFeeQuote({account:owner,subaccountId:null,market:old.market,liquidityRole:old.liquidityRole,builderCode:old.builderCode,intent:old.intent},{account:owner,maker_fee:'0',taker_fee:'0'},[{builder_code:'CARRY',fee_rate:'0'}],[{builder_code:'CARRY',max_fee_rate:'0'}],clock);if(q.availability!=='available')throw Error();facts[k]=q.quote;}
      return facts;};
    const markCanary=vi.fn(),p=new GridProvision({now:()=>clock,durableUmk:async()=>({umk:umk(),cleanup:vi.fn()}),observe,
      custody:{reserve:async()=>account,confirmCreated:vi.fn(),confirmReused:vi.fn()},verifyEmpty:async()=>({account:account.account,masterAccount:account.masterAccount,state:'empty',observedAt:clock,expiresAt:clock+5000}),execution,existing:async key=>done.get(key)??null,markCanary,prepareFirstEntry});
    expect(await p.start({wallet:'EXAMPLE',policy:f.policy,policyHmac:f.policyHash})).toMatchObject({state:'pending',account});
    const old=done.get(`grid:${f.policy.id}:launch:entry`)!,retainedDigest=old.exact_request_digest;
    expect(old.state).toBe('unconfirmed');expect(sent.filter(r=>r.kind==='limit')).toHaveLength(1);
    expect(await p.start({wallet:'EXAMPLE',policy:f.policy,policyHmac:f.policyHash,account})).toMatchObject({state:'pending',account});
    expect(sent.filter(r=>r.kind==='limit')).toHaveLength(1);expect(sent.some(r=>r.kind==='sweep')).toBe(false);
    expect(old.exact_request_digest).toBe(retainedDigest);expect(markCanary).not.toHaveBeenCalled();
  });
  it('missing first-entry preparation authority admits no mutation',async()=>{
    const f=launchFixture(),reserve=vi.fn(),run=vi.fn();const p=new GridProvision({now:()=>clock,durableUmk:async()=>({umk:umk(),cleanup:vi.fn()}),observe:async()=>f.facts,
      custody:{reserve,confirmCreated:vi.fn(),confirmReused:vi.fn()},verifyEmpty:vi.fn(),execution:{run},existing:vi.fn(),markCanary:vi.fn()});
    expect(await p.start({wallet:'EXAMPLE',policy:f.policy,policyHmac:f.policyHash})).toMatchObject({state:'pending'});expect(reserve).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();
  });
});
