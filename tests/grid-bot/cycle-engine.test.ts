import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { calculateGrid, minimumInvestment } from '../../server/grid-bot/engine';
import type { GridInput } from '../../server/grid-bot/engine-types';
import { gridSeedPriceBounds } from '../../server/grid-bot/cycle-engine';
import { projectGridStop } from '../../server/grid-bot/stop-clearance';

const base:GridInput={policyVersion:'2.0.0',side:'long',lower:'80',upper:'120',start:'95',intervals:4,
  investment:'600',leverage:'1',seed:true,entryScale:'flat',profitScale:'flat',tick:'0.01',lot:'0.001',
  minimumQuote:'10',investmentStep:'0.01',transferFloor:'0.01',effectiveMakerCostRate:'0.0001'};
function plan(input:Partial<GridInput>={}) {const r=calculateGrid({...base,...input});expect(r.ok).toBe(true);if(!r.ok)throw Error(r.issues[0].reason);return r.plan;}
describe('v2 fixed future cycle capacity',()=>{
  for(const side of ['long','short'] as const) for(const entryScale of ['flat','ascending','descending'] as const)
    for(const profitScale of ['flat','ascending','descending'] as const) {
      it(`matches v1 quantity extrema for ${side}, entry ${entryScale}, profit ${profitScale}`,()=>{
        const geometry={side,entryScale,profitScale,seed:true};
        const legacy=plan({...geometry,policyVersion:'1.0.0'}),cyclic=plan(geometry);
        for(const role of ['entry','seed_exit'] as const){
          const ranked=(p:typeof legacy)=>p.lines.filter(l=>l.role===role)
            .sort((a,b)=>new Decimal(a.quantity).cmp(b.quantity)||a.ordinal-b.ordinal).map(l=>l.ordinal);
          const old=ranked(legacy),next=ranked(cyclic);
          expect(old.length).toBeGreaterThan(1);
          // Nonbinding minimums and fine lots isolate the inherited quote weights and anchor-price divisor.
          expect([...legacy.lines,...cyclic.lines].filter(l=>l.role===role)
            .every(l=>new Decimal(l.quantity).mul(l.price).gt(base.minimumQuote))).toBe(true);
          expect(next[0]).toBe(old[0]);expect(next.at(-1)).toBe(old.at(-1));
          expect(next).toEqual(old);
        }
      });
    }
  for(const side of ['long','short'] as const) for(const seed of [true,false]) for(const start of ['95','100'])
    for(const scale of ['flat','ascending','descending'] as const) {
      it(`${side}, seed ${seed}, start ${start}, ${scale}`,()=>{
        const p=plan({side,seed,start,entryScale:scale,profitScale:scale});
        expect(p.cycles).toHaveLength(start==='100'?4:5);
        for(const c of p.cycles!){
          expect(Math.abs(c.openingOrdinal-c.closingOrdinal)).toBe(1);
          expect(new Decimal(c.openingPrice)[side==='long'?'lt':'gt'](c.closingPrice)).toBe(true);
          expect(new Decimal(c.quantity).mod(base.lot).isZero()).toBe(true);
          expect(new Decimal(c.quantity).mul(c.openingPrice).gte(base.minimumQuote)).toBe(true);
          expect(c.initialInventory).toBe(seed&&c.anchor==='closing'?c.quantity:'0');
          expect(c.initialOpeningCredit).toBe(seed&&c.anchor==='closing'?'0':c.quantity);
        }
        const sum=p.cycles!.reduce((q,c)=>q.plus(c.quantity),new Decimal(0));
        expect(sum.mul(p.capacityPrice!).eq(p.capacityNotional!)).toBe(true);
        expect(sum.mul(p.capacityPrice!).lte(new Decimal(base.investment).mul(base.leverage))).toBe(true);
        expect(new Decimal(p.capacityNotional!).plus(p.unallocatedNotional).eq(base.investment)).toBe(true);
      });
    }
  it.each([1,100])('supports %s intervals with funded owners at both extremes',intervals=>{
    const p=plan({intervals,start:'100',investment:'3000'});expect(p.cycles![0].ownerOrdinal).toBe(0);
    expect(p.cycles!.at(-1)!.ownerOrdinal).toBe(intervals);
  });
  it('uses the future opening endpoint to lift a closing-anchor quantity',()=>{
    const p=plan({lower:'90',upper:'100',start:'95',intervals:1,investment:'22.40',seed:false});
    expect(p.cycles!.map(c=>c.quantity)).toEqual(['0.112','0.112']);
    expect(p.cycles!.map(c=>[c.openingOrdinal,c.closingOrdinal])).toEqual([[0,1],[0,1]]);
    expect(p.capacityNotional).toBe('22.4');
    expect(calculateGrid({...base,lower:'90',upper:'100',start:'95',intervals:1,investment:'22.39',seed:false}).ok).toBe(false);
  });
  it('uses zero-based openingOrderLift owner ordinals in both versions',()=>{
    const geometry={lower:'90',upper:'100',start:'95',intervals:1,investment:'22.40',seed:true,
      entryScale:'descending' as const,profitScale:'descending' as const};
    const cyclic=plan(geometry);
    expect(cyclic.openingOrderLift?.ordinals).toEqual([1]);
    expect(cyclic.lines[1].quantity).toBe('0.112');expect(cyclic.cycles![1].ownerOrdinal).toBe(1);
    // v1 lifts the bottom entry when its descending weight initially receives less than the minimum.
    const legacy=plan({policyVersion:'1.0.0',seed:false,investment:'21',start:'95',entryScale:'descending'});
    expect(legacy.openingOrderLift?.ordinals).toEqual([0]);
    expect(legacy.lines[0].ordinal).toBe(0);expect(legacy.lines[0].quantity).toBe('0.125');
  });
  it('finds the first legal quote quantum even when the doubling probe would exceed maximum quote',()=>{
    const input={...base,lower:'90',upper:'100',start:'95',intervals:1,seed:false,maximumQuote:'12'};
    const r=minimumInvestment(input);expect(r.ok).toBe(true);if(!r.ok)return;
    expect(r.investment).toBe('22.4');expect(r.evaluations).toBeLessThan(258);
    expect(calculateGrid({...input,investment:new Decimal(r.investment).minus(input.investmentStep).toFixed()}).ok).toBe(false);
    expect(minimumInvestment({...input,maximumQuote:'11'}).ok).toBe(false);
  });
  it('rejects fee-negative geometry before an underfunding diagnosis',()=>{
    const r=minimumInvestment({...base,effectiveMakerCostRate:'1'});
    expect(r.ok).toBe(false);if(!r.ok)expect(r.issues[0].code).toBe('fee_clearance');
    expect(r.evaluations).toBe(1);
  });
  it('includes adverse bounded seed price in W and checks aggregate seed limits',()=>{
    for(const side of ['long','short'] as const){const p=plan({side,upper:'100',lower:'90',start:'99.99',intervals:1});
      expect(p.capacityPrice).toBe(gridSeedPriceBounds('99.99','0.01').high);}
    expect(calculateGrid({...base,maximumQuote:'150'}).ok).toBe(false);
  });
  it.each(['long','short'] as const)('uses the raw reference seed band for %s capacity and stop projection',side=>{
    const p=plan({side,upper:'100',lower:'90',start:'99.991',intervals:1});
    expect(p.start).toBe('99.99');expect(p.seedPriceBounds).toEqual({low:'99.49',high:'100.5'});
    expect(p.capacityPrice).toBe('100.5');
    expect(new Decimal(p.capacityPrice!).gt(gridSeedPriceBounds(p.start,base.tick).high)).toBe(true);
    const stop=projectGridStop({plan:p,funding:base.investment,stop:side==='long'?'80':'130',tick:base.tick,
      maxLeverage:'20',makerRate:'0',takerRate:'0',observedAt:1,expiresAt:100},2);
    expect(stop.state).toBe('available');
    if(stop.state==='available')expect(stop.projection.seedWorstPrice).toBe(side==='long'?'100.5':'99.49');
  });
  it('denies a seeded v2 stop projection with missing execution bounds',()=>{
    const p=plan();delete p.seedPriceBounds;
    expect(projectGridStop({plan:p,funding:base.investment,stop:'70',tick:base.tick,maxLeverage:'20',
      makerRate:'0',takerRate:'0',observedAt:1,expiresAt:100},2)).toEqual({state:'unavailable',reason:'Seed execution bounds are unavailable.'});
  });
  it('keeps seed-off closing anchors funded without inventing seed inventory',()=>{
    const on=plan(),off=plan({seed:false});
    expect(off.cycles!.map(c=>c.quantity)).toEqual(on.cycles!.map(c=>c.quantity));
    expect(off.seedQuantity).toBe('0');expect(off.cycles!.every(c=>c.initialOpeningCredit===c.quantity)).toBe(true);
  });
  it('rejects collapsed ticks and start-boundary geometry',()=>{
    expect(calculateGrid({...base,intervals:100,tick:'1'}).ok).toBe(false);
    for(const start of ['80','120'])expect(calculateGrid({...base,start}).ok).toBe(false);
  });
  it('checks reachable upper reopening inventory even with seed disabled',()=>{
    const p=plan({investment:'60',leverage:'10',seed:false});
    const common={funding:'60',stop:'85',tick:'0.01',maxLeverage:'20',makerRate:'0',takerRate:'0',observedAt:1,expiresAt:100};
    expect(projectGridStop({plan:p,...common},2).state).toBe('unavailable');
    const {policyVersion,cycles,capacityPrice,capacityNotional,...legacy}=p;
    expect(projectGridStop({plan:legacy,...common},2).state).toBe('available');
  });
  it('keeps the implicit v1 engine exactly equivalent to explicitly selected v1',()=>{
    const {policyVersion,...legacy}=base;
    expect(calculateGrid(legacy)).toEqual(calculateGrid({...legacy,policyVersion:'1.0.0'}));
    const p=calculateGrid({...legacy,seed:false});expect(p.ok).toBe(true);
    if(p.ok){expect(p.plan.policyVersion).toBeUndefined();expect(p.plan.cycles).toBeUndefined();expect(p.plan.lines.filter(l=>l.role==='seed_exit').every(l=>l.quantity==='0')).toBe(true);}
  });
});
