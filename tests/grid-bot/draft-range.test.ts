import { describe,it,expect } from 'vitest';
import { suggestGridRange } from '../../server/grid-bot/range';
import { detectActiveRange,deriveStructuralSafeZones } from '../../server/ai-trader/active-range';
import type { ProvenancedOHLCV } from '../../server/lab/datafeed';
const step=3_600_000,now=1_800_000_000_000, end=Math.floor(now/step)*step;
const candles=():ProvenancedOHLCV[]=>Array.from({length:100},(_,i)=>({time:end-(100-i)*step,open:100,high:102,low:98,close:100,volume:1,provenance:{source:'okx',venue:'okx',basis:'perp',proxy:'direct',finality:'finalized',timeSemantic:'open_time'}}));
describe('Grid finalized range',()=>{
  it('includes the latest finalized candle without changing legacy forming-tail behavior',()=>{const bars=candles();bars[99].high=105;const typed=detectActiveRange(bars,100,{finalizedOnly:true,intrabarAtr:3,driftAtr:6,maximumBars:400}),legacy=detectActiveRange(bars,100);expect(typed?.high).toBe(105);expect(legacy?.high).toBe(102);expect(suggestGridRange('BTC-PERP','1h',100,bars,now).state).toBe('available');});
  it.each(['forming','spot','proxy','partial','mixed','gap','nan','volume','stale'])('keeps manual available for %s data',kind=>{const bars=candles();if(kind==='forming')bars[99].provenance.finality='forming';if(kind==='spot')bars[0].provenance.basis='spot';if(kind==='proxy')bars[0].provenance.proxy='proxy';if(kind==='partial')bars.pop();if(kind==='mixed')bars[0].provenance.venue='gate';if(kind==='gap')bars[3].time+=1;if(kind==='nan')bars[1].high=NaN;if(kind==='volume')bars[1].volume=-1;if(kind==='stale')bars.forEach(b=>b.time-=step);
    expect(suggestGridRange('BTC-PERP','1h',100,bars,now)).toMatchObject({state:'unavailable',manualAvailable:true});});
  it('uses the owner timeframe buffer and advisory ADX',()=>{const r=suggestGridRange('BTC-PERP','1h',100,candles(),now);expect(r.state).toBe('available');if(r.state!=='available')throw Error();expect(r.buffer).toBe('3');expect(r.longStop).toBe('95');expect(r.shortStop).toBe('105');expect(r.stopReachability).toBe('unavailable');expect(r.adxLabel).toBe('ranging');});
  it('refuses degenerate structural safe zones',()=>{expect(deriveStructuralSafeZones(1,1,1,.75).state).toBe('unavailable');expect(deriveStructuralSafeZones(2,1,10,.75).state).toBe('unavailable');});
});
