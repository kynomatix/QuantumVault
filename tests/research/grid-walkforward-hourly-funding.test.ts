import {describe,it,expect} from 'vitest';
import {HOUR,hourlyFundingCoverage,completeHourlyWeek} from '../../scripts/research/grid-walkforward/hourly-funding.mjs';
describe('supplementary observed hourly funding coverage',()=>{
 it('indexes clock jitter without changing actual payment times',()=>{const events=[0,1,2,3].map((n)=>({time:(10+n)*HOUR+(n%2?3000:-3000),rate:.0001,oraclePrice:100}));const c=hourlyFundingCoverage(events);expect(completeHourlyWeek(c,10*HOUR,13*HOUR)).toBe(true);expect(c.slots.get(10*HOUR)?.[0].time).toBe(10*HOUR-3000);});
 it('rejects missing, conflicting or excessively displaced observations',()=>{const e={time:10*HOUR,rate:.0001,oraclePrice:100};expect(completeHourlyWeek(hourlyFundingCoverage([e]),10*HOUR,11*HOUR)).toBe(false);expect(completeHourlyWeek(hourlyFundingCoverage([e,{...e,rate:.0002}]),10*HOUR,10*HOUR)).toBe(false);expect(hourlyFundingCoverage([{...e,time:e.time+60001}]).invalid).toHaveLength(1);});
});
