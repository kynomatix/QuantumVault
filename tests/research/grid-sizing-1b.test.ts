import {describe,it,expect} from 'vitest';
import {sizingPolicy,NEW_ARMS} from '../../scripts/research/grid-sizing-1b/arms.mjs';
const market={symbol:'EXAMPLE',tick:'0.01',lot:'0.001',minimumQuote:'10',maximumQuote:'10000000',minimumPrice:'0.01',maximumPrice:'1000000'};
const geometry={lower:'80.00000000',upper:'120.00000000',longStop:'70.00000000',shortStop:'130.00000000'};
describe('Phase 1b independent entry and profit scaling',()=>{
 it.each([
  ['near_flat','descending','flat'],['flat_near','flat','descending'],
  ['near_further','descending','ascending'],['further_near','ascending','descending'],
 ])('%s uses each scale on the intended leg, both sides and leverage settings',(arm,entry,profit)=>{
  for(const direction of ['long','short'])for(const leverage of [1,3]){
   const {policy:p}=sizingPolicy({market,direction,geometry,reference:'100',leverage,makerRate:.00115,arm});
   expect(p.entryScaleType).toBe(entry);expect(p.profitScaleType).toBe(profit);
   expect(p.gridCount).toBe(10);expect(p.seedAtCreation).toBe(true);
   for(const closing of [false,true]){
    const levels=p.levels.filter(l=>l.reduceOnly===closing&&Number(l.price)!==100).sort((a,b)=>Math.abs(Number(a.price)-100)-Math.abs(Number(b.price)-100));
    expect(levels.length).toBeGreaterThan(1);
    const near=Number(levels[0].size)*Number(levels[0].price),far=Number(levels.at(-1)!.size)*Number(levels.at(-1)!.price),scale=closing?profit:entry;
    if(scale==='ascending')expect(far).toBeGreaterThan(near);
    if(scale==='descending')expect(near).toBeGreaterThan(far);
    if(scale==='flat')expect(Math.abs(far-near)).toBeLessThan(.25);
    for(const l of levels)expect(Number(l.size)*Number(l.price)).toBeGreaterThanOrEqual(10-1e-8);
   }
  }
 });
 it('dispatches only the four missing cells, without original arms',()=>{
  expect(Object.keys(NEW_ARMS)).toEqual(['near_flat','flat_near','near_further','further_near']);
 });
});
