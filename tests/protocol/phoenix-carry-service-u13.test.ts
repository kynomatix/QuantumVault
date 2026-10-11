// Primitive tests use an explicit trusted rollout fixture; U16 tests exercise the real owner gate.
vi.mock('../../server/protocol/phoenix/rollout', async importOriginal => ({
  ...await importOriginal<typeof import('../../server/protocol/phoenix/rollout')>(),
  phoenixCanaryAllows: () => true, phoenixExposureAllows: () => true,
}));
import { describe, expect, it, vi } from 'vitest';
import { PhoenixCarryService } from '../../server/protocol/phoenix/carry-service';
import { carryRepayIntent } from '../../server/protocol/phoenix/carry-contract';
import { CarryMemory, carryFixture } from '../helpers/phoenix-carry';
import { now } from '../helpers/phoenix-orders';
import type { ParkingReceipt } from '../../server/protocol/phoenix/parking-contract';
import { createCarryExecutor, carryRepaymentAuthorizer } from '../../server/protocol/phoenix/carry-executor';

function setup() {
  const {i,f}=carryFixture(), store=new CarryMemory();let receipt:ParkingReceipt|null=null,enabled=true;
  const io={snapshot:async()=>structuredClone(f.parking),submit:vi.fn(async()=>{}),receipt:vi.fn(async()=>receipt)};
  const facts=vi.fn(async()=>structuredClone(f));
  const service=()=>new PhoenixCarryService(store,io,{facts},()=>enabled,()=>now);
  const cash=(wallet:string,venue='0')=>{f.parking.walletUsdc=wallet;f.lender.walletUsdcRaw=wallet;f.parking.withdrawableUsdc=venue;};
  const settle=(state:ParkingReceipt['state']='settled',received?:string)=>{
    const l=store.r.legs.at(-1)!.leg;receipt={key:l.key,state,spent:state==='settled'?l.amount:'0',
      received:state==='settled'?(received??l.amount):'0',finalized:true,slot:'100',source:'EXAMPLE-chain',reference:'EXAMPLE-receipt'};
  };
  return {i,f,store,io,facts,service,cash,settle,disable:()=>{enabled=false;}};
}
describe('U13 restart-safe close settlement',()=>{
  it('signals a claimed leg without settlement evidence and never resends it',async()=>{
    const x=setup(), warning=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try {
      x.cash('50000000'); await x.service().start(x.i); await x.service().resume(x.i);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('operator reconciliation required'),expect.objectContaining({intentId:x.store.r.id}));
      expect(x.io.submit).toHaveBeenCalledTimes(1); expect(x.store.r.state).toBe('active');
    } finally { warning.mockRestore(); }
  });
  it.each(['partial','protection','unknown_close','foreign_history','stale_debt'])(
    'refuses %s before creating a spend intent',async defect=>{
      const x=setup();
      if(defect==='partial')x.f.close.fullyClosed=false;
      if(defect==='protection')x.f.parking.protections[0].orderbookOrderIds=['1'];
      if(defect==='unknown_close')x.f.close.authoritative=false;
      if(defect==='foreign_history')x.f.economics.history[0].bot_id='EXAMPLE-other';
      if(defect==='stale_debt')x.f.lender.observedAt=now-5000;
      await expect(x.service().start(x.i)).rejects.toThrow();expect(x.io.submit).not.toHaveBeenCalled();expect(x.store.r).toBeUndefined();
    });
  it('waits for queued cash, unwraps once and parks the chosen amount across fresh service instances',async()=>{
    const x=setup();x.cash('10000000','40000000');await x.service().start(x.i);
    expect(x.store.r.legs[0].leg.kind).toBe('withdraw');x.settle('pending');
    x.f.parking.pendingReturnUsdc=x.f.lender.queuedUsdcRaw='40000000';
    await x.service().resume(x.i);await x.service().resume(x.i);expect(x.io.submit).toHaveBeenCalledTimes(1);
    x.settle();x.f.parking.pendingReturnUsdc=x.f.lender.queuedUsdcRaw='0';await x.service().resume(x.i);
    expect(x.store.r.legs.at(-1)!.leg.kind).toBe('unwrap');
    x.settle();x.cash('50000000');await x.service().resume(x.i);
    expect(x.store.r.legs.at(-1)!.leg).toMatchObject({kind:'park',amount:'40000000',asset:'EXAMPLE-yield'});
    x.settle('settled','39000000');await x.service().resume(x.i);await x.service().resume(x.i);
    expect(x.store.r.state).toBe('completed');expect(x.io.submit).toHaveBeenCalledTimes(3);
  });
  it('never turns a dropped withdrawal into wallet cash or a retry',async()=>{
    const x=setup();x.cash('10000000','40000000');await x.service().start(x.i);x.settle('dropped');
    await x.service().resume(x.i);await x.service().resume(x.i);
    expect(x.store.r.state).toBe('attention');expect(x.io.submit).toHaveBeenCalledTimes(1);
  });
  it.each(['optout','expiry','destination'])(
    'observes the pending leg after %s and stops further spending',async change=>{
      const x=setup();x.cash('10000000','40000000');await x.service().start(x.i);
      if(change==='optout')x.f.parking.autoPark=false;
      if(change==='destination')x.f.parking.destination='EXAMPLE-new-destination';
      const resume=change==='expiry'?new PhoenixCarryService(x.store,x.io,{facts:async()=>{
        const f=structuredClone(x.f);f.parking.observedAt=f.lender.observedAt=f.lender.oracleObservedAt=now+60001;
        f.parking.protections.forEach(p=>p.observedAt=now+60001);return f;
      }},()=>true,()=>now+60001):x.service();
      x.settle('pending');await resume.resume(x.i);expect(x.io.submit).toHaveBeenCalledTimes(1);
      x.settle();await resume.resume(x.i);expect(x.store.r.state).toBe('cancelled');expect(x.io.submit).toHaveBeenCalledTimes(1);
    });
  it('re-evaluates rates after settlement and repays only the immutable authorized cap',async()=>{
    const x=setup();x.cash('10000000','40000000');await x.service().start(x.i);x.settle();await x.service().resume(x.i);
    x.settle();x.cash('50000000');x.f.economics.borrowApr=0.5;await x.service().resume(x.i);
    const leg=x.store.r.legs.at(-1)!.leg;expect(leg).toMatchObject({kind:'repay',amount:'30000000',targetFinalDebtRaw:'60000000'});
    const child=carryRepayIntent(x.store.r,leg);expect(child).toMatchObject({action:'repay',automation:{kind:'carry',targetFinalDebtRaw:'60000000'}});
    x.settle();await x.service().resume(x.i);expect(x.io.submit).toHaveBeenCalledTimes(3);
  });
  it.each(['rates','queue','optout','cash'])(
    'stops a changed %s between the claim and spend',async change=>{
      const x=setup();let reads=0;
      x.facts.mockImplementation(async()=>{
        if(++reads===3){
          if(change==='rates')x.f.economics.borrowApr=0.5;
          if(change==='queue')x.f.economics.pendingQueueAgeSeconds=500;
          if(change==='optout')x.f.parking.autoPark=false;
          if(change==='cash')x.cash('12000000');
        }
        return structuredClone(x.f);
      });
      await x.service().start(x.i);await x.service().resume(x.i);
      expect(x.io.submit).not.toHaveBeenCalled();expect(x.store.r.legs).toHaveLength(1);expect(x.store.r.state).toBe('active');
    });
  it.each([false,true])('health can repay only available cash with independent repayment consent=%s',async allow=>{
    const x=setup();x.f.health.band=x.f.economics.healthSummary.headline.band='urgent';x.f.economics.costs=null;
    x.i.carry!.allowRepay=allow;x.cash('7000000');await x.service().start(x.i);
    if(allow)expect(x.store.r.legs.at(-1)!.leg).toMatchObject({kind:'repay',amount:'7000000',targetFinalDebtRaw:'83000000'});
    else {expect(x.store.r.state).toBe('attention');expect(x.io.submit).not.toHaveBeenCalled();}
  });
  it('requires fresh repay opt-in at the U11 primitive boundary, including gate-off recovery',async()=>{
    const x=setup();x.i.carry!.choice='repay';await x.service().start(x.i);x.disable();
    const child=carryRepayIntent(x.store.r,x.store.r.legs.at(-1)!.leg);
    const authorize=carryRepaymentAuthorizer(x.service(),async()=>x.store.read());
    await authorize(child,x.f.lender);x.f.autoRepayEnabled=false;
    await expect(authorize(child,x.f.lender)).rejects.toThrow('repayment');
  });
  it('keeps failed park attempts ambiguous across replay and never auto-unparks existing holdings',async()=>{
    const x=setup();x.io.submit.mockRejectedValue(new Error('EXAMPLE-timeout'));await x.service().start(x.i);
    await x.service().resume(x.i);expect(x.io.submit).toHaveBeenCalledTimes(1);expect(x.store.r.state).toBe('active');
    const y=setup();y.f.parking.holdings=[{asset:'EXAMPLE-yield',tokenUnits:'40000000',valueUsdc:'40000000',redeemable:false}];
    y.f.economics.parkedAsset='EXAMPLE-yield';await y.service().start(y.i);
    expect(y.io.submit).not.toHaveBeenCalled();expect(y.store.r.state).toBe('completed');
    const executor=createCarryExecutor(y.io,{run:vi.fn()},{read:vi.fn()},vi.fn());
    await expect(executor.submit(y.store.r,{key:'EXAMPLE',kind:'unpark',amount:'1',asset:'EXAMPLE-yield'})).rejects.toThrow('cannot unpark');
  });
  it('does not create a missing lender child on replay, and requires terminal measured repayment evidence',async()=>{
    const x=setup();x.i.carry!.choice='repay';await x.service().start(x.i);
    const run=vi.fn(),read=vi.fn().mockRejectedValue(new Error('EXAMPLE-missing')),observe=vi.fn();
    const executor=createCarryExecutor(x.io,{run},{read},observe),l=x.store.r.legs.at(-1)!.leg;
    expect(await executor.receipt(x.store.r,l)).toBeNull();expect(run).not.toHaveBeenCalled();
    read.mockResolvedValue({status:'pending',metadata:{legs:{repay:{state:'claimed'}}}});
    run.mockResolvedValue({status:'completed',metadata:{legs:{repay:{state:'completed'}}}});observe.mockResolvedValue(null);
    expect(await executor.receipt(x.store.r,l)).toBeNull();expect(run).toHaveBeenCalledTimes(1);expect(observe).toHaveBeenCalledTimes(1);
  });
});
