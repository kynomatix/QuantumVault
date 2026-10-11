import {describe,it,expect,vi} from 'vitest';
import Decimal from 'decimal.js';
import {calculateGrid} from '../../server/grid-bot/engine';
import {computeGridPolicyHmac,type GridPolicy} from '../../server/grid-bot/policy-hmac';
import {createGridFeeQuote} from '../../server/grid-bot/fee-authority';
import {projectGridStop,GRID_STOP_EXECUTION_CUSHION} from '../../server/grid-bot/stop-clearance';
import {preflightGridLaunch,GridProvision,type LaunchFacts} from '../../server/grid-bot/provision';
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
  it('admits unchanged seed-off geometry with a funded stop and valid canary entry',()=>{const f=launchFixture();expect(preflightGridLaunch(f.policy,f.policyHash,umk(),f.facts,clock)).toMatchObject({ok:true});});
  it.each(['policy','fees','price','constraints','quota','recycler','slots','stop','canary','sol','transport','balance','durable security'])('failed %s preflight reserves and sends nothing',async defect=>{
    const f=launchFixture(defect==='canary');
    if(defect==='policy')f.policy.upperPrice='111.00000000';if(defect==='fees')f.facts.maker={...f.facts.maker,expiresAt:clock};
    if(defect==='price')f.facts.bookPrice='101';if(defect==='constraints')f.facts.maxLeverage='1';if(defect==='quota')f.facts.observedCredits='0';
    if(defect==='recycler')f.facts.recycler.reuse=false;if(defect==='slots')f.facts.availableSlots=24;
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
    const p=new GridProvision({now:()=>clock,durableUmk:async()=>({umk:umk(),cleanup:vi.fn()}),observe,custody:{reserve:async()=>account,confirmCreated:vi.fn(),confirmReused:vi.fn()},verifyEmpty:async()=>({account:account.account,masterAccount:account.masterAccount,state:'empty',observedAt:clock,expiresAt:clock+5000}),execution:{run},existing:async k=>done.get(k),markCanary});
    const result=await p.start({wallet:'EXAMPLE',policy:f.policy,policyHmac:f.policyHash});expect(result,result.reason).toMatchObject({state:'canary'});
    expect(calls).toEqual(seed?['create','fund','leverage','seed']:['create','fund','leverage']);expect(markCanary).toHaveBeenCalledOnce();
    if(seed){const r=done.get(`grid:${f.policy.id}:launch:seed`).exact_request;expect(r.data).toMatchObject({slippage_percent:'0.5',reduce_only:false});expect(r.authority.facts.taker.account).toBe(account.account);}
  });
});
