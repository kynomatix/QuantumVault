import { describe, it, expect } from 'vitest';
import { readPriceExcursion, observedExcursionMetrics } from '../../shared/ai-trader-excursion';
import { ExcursionObservations } from '../../server/ai-trader/excursion-observation';
const T = 900_000, boot = 'test-boot';
const provenance = { source: 'okx', venue: 'okx', basis: 'perp', proxy: 'direct', finality: 'finalized', timeSemantic: 'open_time' };
const bar = (time: number, high = 108, low = 95, extra = {}) =>
  ({ time, open: 100, close: 100, high, low, provenance, ...extra });
function observed() {
  const store = new ExcursionObservations(boot);
  store.paper('d', [bar(0, 900, 1), bar(T,104,98),bar(2*T),bar(3*T,2000,1),bar(4*T,6000,1)], 0,T,6*T,3*T);
  return store.forClose('d',0,3*T);
}
describe('bounded excursion evidence', () => {
  it('clears every retained observation at monitor shutdown', () => {
    const store=new ExcursionObservations(boot);
    store.live('one',100,0,T,'pacifica');store.live('two',101,0,T,'pacifica');
    expect(store.size).toBe(2);store.clear();expect(store.size).toBe(0);
    expect(store.forClose('one',0,2*T)).toMatchObject({status:'unavailable',reason:'no_retained_observation'});
  });
  it('excludes entry, first hit and all post-hit candles without changing input', () => {
    expect(observed()).toMatchObject({ status:'observed', basis:'paper_closed_candles', coverage:'partial',
      sampleCount:2, expectedInteriorBars:2, missingInteriorBars:0,
      high:{price:108,atMs:2*T},low:{price:95,atMs:2*T},fromMs:T,throughMs:2*T });
  });
  it('keeps boundary completeness separate from complete interior coverage', () => {
    const v=observed(); expect(v.status==='observed'&&v.coverage).toBe('partial');
  });
  it('reports missing interior bars and excludes the currently forming candle', () => {
    const store=new ExcursionObservations(boot);
    store.paper('d',[bar(2*T),bar(4*T),bar(5*T,1000,1)],0,T,5*T+T/2,null);
    expect(store.forClose('d',0,6*T)).toMatchObject({sampleCount:2,expectedInteriorBars:4,missingInteriorBars:2,high:{price:108}});
  });
  it('does not mistake unfinalized or unknown-provenance bars for observed coverage', () => {
    const store=new ExcursionObservations(boot);
    store.paper('d',[bar(T),bar(2*T,200,1,{provenance:{...provenance,finality:'forming'}}),
      bar(3*T,300,1,{provenance:{...provenance,source:'unknown'}})],0,T,4*T,null);
    expect(store.forClose('d',0,4*T)).toMatchObject({sampleCount:1,missingInteriorBars:2,high:{price:108}});
  });
  it('recomputes an earlier hit rather than retaining a later peak', () => {
    const store=new ExcursionObservations(boot);
    const bars=[bar(T,104,98),bar(2*T,108,95),bar(3*T,150,90)];
    store.paper('d',bars,0,T,4*T,null);
    store.paper('d',bars,0,T,4*T,2*T);
    expect(store.forClose('d',0,2*T)).toMatchObject({sampleCount:1,high:{price:104},low:{price:98}});
  });
  it.each([
    [[], 'empty_window'],
    [[bar(2*T),bar(T)],'malformed_window'],
    [[bar(T),bar(T)],'malformed_window'],
    [[bar(T,90,80)],'malformed_window'],
    [[bar(T),bar(2*T,108,95,{provenance:{...provenance,source:'gate',venue:'gate'}})],'mixed_provenance'],
    [Array.from({length:20_001},(_,i)=>bar(i*T)),'window_limit'],
  ])('classifies unusable windows without throwing %#', (bars,reason) => {
    const store=new ExcursionObservations(boot);
    expect(()=>store.paper('d',bars as any,0,T,4*T,null)).not.toThrow();
    expect(store.forClose('d',0,4*T)).toMatchObject({status:'unavailable',reason});
  });
  it('contains hostile observation getters instead of affecting a close', () => {
    const store=new ExcursionObservations(boot), bad=new Proxy({}, {get(){throw Error('bad observation');}});
    expect(()=>store.paper('d',[bad],0,T,4*T,null)).not.toThrow();
    expect(store.forClose('d',0,4*T)).toMatchObject({status:'unavailable',reason:'malformed_window'});
    expect(readPriceExcursion(bad)).toBeNull();
  });
  it('keeps post-ratchet live observations and sparse-poll provenance', () => {
    const store=new ExcursionObservations(boot);
    for(const [time,price] of [[T,100],[2*T,110],[3*T,95]])store.live('d',price,0,time,'pacifica');
    const v=store.forClose('d',0,4*T);
    expect(v).toMatchObject({status:'observed',basis:'live_sampled_marks',sampleCount:3,
      missingInteriorBars:null,high:{price:110,atMs:2*T},low:{price:95,atMs:3*T}});
    if(v.status!=='observed')throw Error('fixture');
    expect(observedExcursionMetrics(v,'long',100,90,120)).toMatchObject({favorablePct:10,adversePct:5,targetProgress:0.5,adverseRisk:0.5});
    expect(observedExcursionMetrics(v,'short',100,120,90)).toMatchObject({favorablePct:5,adversePct:10,targetProgress:0.5,adverseRisk:0.5});
  });
  it('preserves zero observed favorable excursion without asserting lifetime zero', () => {
    const store=new ExcursionObservations(boot);store.live('d',95,0,T,'pacifica');
    const v=store.forClose('d',0,2*T);if(v.status!=='observed')throw Error('fixture');
    expect(observedExcursionMetrics(v,'long',100,null,null)).toMatchObject({favorablePct:0,adversePct:5,targetProgress:null,adverseRisk:null});
  });
  it('does not include sampled marks after the terminal time', () => {
    const store=new ExcursionObservations(boot);store.live('d',100,0,3*T,'pacifica');
    expect(store.forClose('d',0,2*T)).toMatchObject({status:'unavailable',reason:'terminal_precedes_sample'});
  });
  it('does not extend manual-close coverage or mutate a retained snapshot', () => {
    const store=new ExcursionObservations(boot);store.live('d',100,0,T,'pacifica');
    const first=store.forClose('d',0,4*T);
    if(first.status!=='observed')throw Error('fixture');
    first.high.price=999;
    expect(store.forClose('d',0,5*T)).toMatchObject({throughMs:T,high:{price:100}});
  });
  it('withholds a record bound to a different decision start', () => {
    const v=observed();
    expect(readPriceExcursion(v,{decisionStartedAtMs:1,closedAtMs:4*T})).toBeNull();
  });
  it('rejects paper coverage straddling the terminal boundary', () => {
    expect(readPriceExcursion(observed(),{decisionStartedAtMs:0,closedAtMs:2*T+1})).toBeNull();
  });
  it('bounds memory and honestly reports eviction and restart loss', () => {
    const store=new ExcursionObservations(boot,2);
    for(const id of ['a','b','c'])store.live(id,100,0,T,'pacifica');
    expect(store.size).toBe(2);
    expect(store.forClose('a',0,2*T)).toMatchObject({reason:'no_retained_observation'});
    expect(new ExcursionObservations('new-boot').forClose('b',0,2*T)).toMatchObject({reason:'no_retained_observation'});
    store.forget('b');expect(store.size).toBe(1);
  });
  it.each([NaN,Infinity,0,-1,null,'100'])('ignores malformed live marks %s', price => {
    const store=new ExcursionObservations(boot);store.live('d',price,0,T,'pacifica');
    expect(store.size).toBe(0);
  });
  it('does not double count same-time samples or a backwards clock', () => {
    const store=new ExcursionObservations(boot);
    store.live('d',100,0,2*T,'pacifica');store.live('d',999,0,2*T,'pacifica');store.live('d',999,0,T,'pacifica');
    expect(store.forClose('d',0,4*T)).toMatchObject({sampleCount:1,high:{price:100}});
  });
  it.each([{},null,{version:2},{...observed(),coverage:'complete'},{...observed(),sampleCount:Infinity},
    {...observed(),bootId:'x'.repeat(65)},{...observed(),high:{price:NaN,atMs:T}}])('rejects malformed persisted records %#', value => {
    expect(readPriceExcursion(value)).toBeNull();
  });
  it('copies only the declared bounded fields, never arbitrary JSON', () => {
    const value={...observed(),secrets:'not retained',extra:Array(100)};
    const clean=readPriceExcursion(value);
    expect(clean).not.toHaveProperty('secrets');expect(clean).not.toHaveProperty('extra');
  });
});
