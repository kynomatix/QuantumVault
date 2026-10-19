import {describe,it,expect} from 'vitest';
import {qualifyAutomaticTrail,trailHistory,trailDataHold,trailCapHold,GRID_TRAIL_POLICY} from '../../server/grid-bot/trail-policy';
import {qualifyGridDow} from '../../server/grid-bot/move-policy';
import {behaviourPolicy} from './behaviour-fixtures';
import {moveCandles,moveBase,moveDuration} from './range-move-fixtures';
const bars=()=>[...Array.from({length:85},(_,i)=>({...moveCandles()[0],time:moveBase-(85-i)*moveDuration,open:90,close:90,high:91,low:89})),...moveCandles()];
describe('offline automatic trail policy',()=>{
  it('uses the shipped confirmed Dow result and never accepts an unconfirmed pivot',()=>{
    const p=behaviourPolicy('repeat_all'),candles=bars(),now=candles.at(-1)!.time+moveDuration;
    const history=trailHistory(p,moveBase);
    const shipped=qualifyGridDow({policy:p,candles,timeframe:'15m',now,after:moveBase});
    const result=qualifyAutomaticTrail({policy:p,history,candles,timeframe:'15m',now,variant:'b'});
    expect(result).toEqual({eligible:true,decisionAt:now,close:'123',confirmedAt:shipped.confirmedAt});
    expect(shipped.confirmedAt).toBeLessThanOrEqual(now);
    expect(qualifyAutomaticTrail({policy:p,history,candles,timeframe:'15m',now:now-moveDuration,variant:'b'})).toEqual({eligible:false,reason:'forming'});
  });
  it('holds gaps, stale, forming, source changes and short warm-up',()=>{
    const candles=bars(),now=candles.at(-1)!.time+moveDuration;
    expect(trailDataHold(candles,'15m',now)).toBeNull();
    expect(trailDataHold(candles.filter((_,i)=>i!==50),'15m',now)).toBe('gap');
    expect(trailDataHold(candles,'15m',now+moveDuration)).toBe('stale');
    expect(trailDataHold(candles.slice(1),'15m',now)).toBe('warmup');
    const changed=structuredClone(candles);changed[50].provenance.source='EXAMPLE_SOURCE' as any;
    expect(trailDataHold(changed,'15m',now)).toBe('source');
    changed[50]=structuredClone(candles[50]);changed[99].provenance.finality='forming' as any;
    expect(trailDataHold(changed,'15m',now)).toBe('forming');
  });
  it('counts manual and automatic moves across serialization, toggles and restarts',()=>{
    const p=behaviourPolicy('repeat_all'),history=trailHistory(p,moveBase);
    history.moves.push({actor:'manual',decisionAt:moveBase,activatedAt:moveBase+1,lower:'90',upper:'130'});
    const shifted={...p,lowerPrice:'90',upperPrice:'130',levels:p.levels.map(l=>({...l,price:String(Number(l.price)+10)}))};
    const restored=JSON.parse(JSON.stringify(history));
    expect(trailCapHold(shifted,restored,moveBase+1000)).toBe('cooldown');
    expect(trailCapHold(shifted,restored,moveBase+3600001)).toBeNull();
    expect(trailCapHold({...shifted,direction:'short'},restored,moveBase+3600001)).toBe('history');
    expect(trailCapHold(shifted,restored,moveBase+3600001,{lowerPrice:'80',upperPrice:'120'})).toBe('direction');
    expect(trailCapHold(shifted,restored,moveBase+3600001,{lowerPrice:'120',upperPrice:'160'})).toBe('move_size');
    for(const mode of ['repeat_all','step_back','step_back_edge'] as const){
      const toggled={...shifted,gridPolicyExtension:{...shifted.gridPolicyExtension!,mode}};
      expect(trailCapHold(toggled,restored,moveBase+1000)).toBe('cooldown');
    }
  });
  it('enforces rolling, lifetime and original-width caps, including their boundaries',()=>{
    const original=behaviourPolicy('repeat_all');
    for(const [count,spacing,expected] of [[3,3600001,'rolling_cap'],[10,86400001,'lifetime_cap']] as const){
      const h=trailHistory(original,moveBase);
      for(let i=1;i<=count;i++)h.moves.push({actor:'automatic',decisionAt:moveBase+i*spacing,activatedAt:moveBase+i*spacing+1,lower:String(80+i),upper:String(120+i)});
      const p={...original,lowerPrice:String(80+count),upperPrice:String(120+count)};
      expect(trailCapHold(p,h,moveBase+(count+1)*spacing)).toBe(expected);
    }
    const h=trailHistory(original,moveBase);
    h.moves.push({actor:'manual',decisionAt:moveBase,activatedAt:moveBase+1,lower:'110',upper:'150'});
    const p={...original,lowerPrice:'110',upperPrice:'150',levels:original.levels.map(l=>({...l,price:String(Number(l.price)+30)}))};
    expect(trailCapHold(p,h,moveBase+86400001,{lowerPrice:'120',upperPrice:'160'})).toBeNull();
    expect(trailCapHold(p,h,moveBase+86400001,{lowerPrice:'130',upperPrice:'170'})).toBe('distance_cap');
    expect(GRID_TRAIL_POLICY.maximumEdgeIntervals).toBe(2);
  });
  it('retains the decision watermark and distinguishes the fixed and simple-edge arms',()=>{
    const p=behaviourPolicy('repeat_all'),candles=bars(),now=candles.at(-1)!.time+moveDuration,h=trailHistory(p,moveBase);
    expect(qualifyAutomaticTrail({policy:p,history:h,candles,timeframe:'15m',now,variant:'a'})).toEqual({eligible:false,reason:'fixed_range'});
    expect(qualifyAutomaticTrail({policy:p,history:h,candles,timeframe:'15m',now,variant:'c'}).eligible).toBe(true);
    h.lastDecisionAt=now;
    expect(qualifyAutomaticTrail({policy:p,history:JSON.parse(JSON.stringify(h)),candles,timeframe:'15m',now,variant:'d'})).toEqual({eligible:false,reason:'duplicate'});
  });
});
