import {expect,it} from 'vitest';
import {HOUR,DAY,SLOTS,SETTINGS,randomHour,launches,offsetWindow,physicalKey,scenarioKey,armRows,stats,spread,addAdmissionMask,pairRows,cohortKey}
  from '../../scripts/research/grid-start-time/core.mjs';

it('has exactly all 21 weekday/time slots and the eight physical configurations',()=>{
  expect(SLOTS).toHaveLength(21);expect(new Set(SLOTS.map(s=>s.hour)).size).toBe(21);
  expect(SLOTS.map(s=>s.hour)).toEqual(Array.from({length:21},(_,i)=>i*8));
  expect(SETTINGS).toHaveLength(8);expect(new Set(SETTINGS.map(s=>s.config)).size).toBe(8);
  expect(SETTINGS.filter(s=>s.leverage===3).map(s=>s.id)).toEqual(['A_3X','A_3X']);
});
it('has reproducible hourly draws shared across markets and deduplicates collisions',()=>{
  let collisions=0;
  for(let i=0;i<100;i++) {
    const anchor=Date.UTC(2022,0,2)+i*7*DAY,rows=launches(anchor),hour=randomHour(anchor);
    expect(randomHour(anchor)).toBe(hour);expect(Number.isInteger(hour)&&hour>=0&&hour<168).toBe(true);
    expect(rows.flatMap(r=>r.slots).sort()).toEqual([...SLOTS.map(s=>s.id),'RANDOM'].sort());
    expect(new Set(rows.map(r=>r.launchAt)).size).toBe(rows.length);
    const random=rows.find(r=>r.slots.includes('RANDOM'))!;
    expect(random.launchAt).toBe(anchor+hour*HOUR);
    if(hour%8===0){collisions++;expect(random.slots).toHaveLength(2);expect(rows).toHaveLength(21);}
    else expect(rows).toHaveLength(22);
  }
  expect(collisions).toBeGreaterThan(0);
});
it('does not shorten or roll back a horizon that overruns its period',()=>{
  const anchor=Date.UTC(2025,11,14),through=anchor+14*DAY;
  const d={duration:HOUR,indices:new Map(Array.from({length:22*24},(_,i)=>[anchor+i*HOUR,i]))};
  const base={launchAt:anchor,horizonDays:14,reason:'stale base rejection'};
  const sunday=offsetWindow(d,base,launches(anchor)[0],through);
  expect(sunday.reason).toBeNull();expect(sunday.end-sunday.start).toBe(14*24);
  const later=offsetWindow(d,base,{anchor,launchAt:anchor+8*HOUR,slots:['Sun-08']},through);
  expect(later.reason).toBe('period boundary');expect(later.endAt).toBe(through+8*HOUR);
});
it('records missing hourly boundaries without borrowing another candle',()=>{
  const d={duration:HOUR,indices:new Map([[0,0],[14*DAY-HOUR,335]])};
  const w=offsetWindow(d,{horizonDays:14},{anchor:0,launchAt:HOUR,slots:['RANDOM']},20*DAY);
  expect(w.reason).toBe('missing_boundary');expect(w.start).toBe(-1);
});
it('uses launch UTC year and keeps the Sunday anchor for pairing across year end',()=>{
  const anchor=Date.UTC(2025,11,28),launchAt=Date.UTC(2026,0,1),d={duration:HOUR,indices:new Map()};
  const w=offsetWindow(d,{horizonDays:14},{anchor,launchAt,slots:['Thu-00']},launchAt+30*DAY);
  expect(w.year).toBe(2026);expect(w.anchor).toBe(anchor);
});
it('separates physical identity from timing comparison identity',()=>{
  const r={anchor:0,launchAt:0,market:'BTC',horizonDays:14,direction:'long',path:'OHLC',markPath:'OLHC',config:'A_WEEK-b100'};
  expect(physicalKey(r)).not.toBe(physicalKey({...r,launchAt:8*HOUR}));
  expect(scenarioKey(r)).toBe(scenarioKey({...r,launchAt:8*HOUR}));
  expect(physicalKey(r)).not.toBe(physicalKey({...r,config:'B_REPEAT-b100'}));
});
it('counts R1 as conditional membership and keeps unknown signals distinct from failures',()=>{
  const r={setting:'A_WEEK',admitted:true,reason:null,r1:'pass'};
  expect(armRows(r).map(x=>[x.arm,x.admitted])).toEqual([['A_WEEK',true],['C_R1',true]]);
  expect(armRows({...r,r1:'unavailable'})[1].reason).toBe('R1 signal unavailable');
  expect(armRows({...r,r1:'fail'})[1].reason).toBe('R1 condition not met');
  expect(armRows({...r,admitted:false,reason:'funding'})[1].reason).toBe('funding');
});
it('excludes rejected rows and distinguishes empty samples from zero returns',()=>{
  const a={admitted:true,netReturn:0,protectiveStop:false,maxDrawdown:.02,market:'BTC',launchAt:0,anchor:0};
  const s=stats([a,{...a,netReturn:.1,protectiveStop:true,maxDrawdown:.3},{...a,admitted:false,netReturn:100}]);
  expect(s.admitted).toBe(2);expect(s.mean).toBe(.05);expect(s.median).toBe(.05);
  expect(s.profitable).toBe(.5);expect(s.stopRate).toBe(.5);expect(s.worstDrawdown).toBe(.3);
  expect(s.launches).toBe(1);expect(s.weeks).toBe(1);expect(stats([]).mean).toBeNull();
});
it('excludes unavailable cells and reports Sunday extremes and competition ranks',()=>{
  const s=spread([{slot:'Sun-00',mean:5},{slot:'Mon-00',mean:1},{slot:'Tue-00',mean:2},{slot:'Wed-00',mean:null}],'mean');
  expect(s.sundayRank).toBe(1);expect(s.rangeOutlier).toBe(true);expect(s.availableSlots).toBe(3);
  expect(s.min).toBe(1);expect(s.max).toBe(5);expect(s.sd).toBeCloseTo(Math.sqrt(26/9));
  expect(spread([{slot:'Sun-00',mean:1},{slot:'Mon-00',mean:1}],'mean').sundayRank).toBe(1);
});
it('requires all fixed slots for the common cohort and does not use random to fill a missing slot',()=>{
  const mask=new Map(),r={anchor:0,launchAt:0,market:'BTC',horizonDays:14,direction:'long',path:'OHLC',markPath:'OHLC',setting:'A_WEEK',builderRate:.001,r1:'pass',admitted:true};
  for(const s of SLOTS.slice(0,-1))addAdmissionMask(mask,{...r,slots:[s.id]});
  addAdmissionMask(mask,{...r,slots:['RANDOM']});
  expect(mask.get(cohortKey({...r,arm:'A_WEEK'}))).not.toBe(2**21-1);
  addAdmissionMask(mask,{...r,slots:[SLOTS.at(-1)!.id],r1:'fail'});
  expect(mask.get(cohortKey({...r,arm:'A_WEEK'}))).toBe(2**21-1);
  expect(mask.get(cohortKey({...r,arm:'C_R1'}))).not.toBe(2**21-1);
});
it('does not let repeated collision memberships create new cohort bits',()=>{
  const mask=new Map(),r={anchor:0,market:'BTC',horizonDays:14,direction:'long',path:'OHLC',markPath:'OLHC',setting:'A_MONTH',builderRate:0,admitted:true,slots:['Sun-00','RANDOM']};
  addAdmissionMask(mask,r);addAdmissionMask(mask,r);
  expect(mask.get(cohortKey({...r,arm:'A_MONTH'}))).toBe(1);
});
it('pairs only jointly admitted same-scenario rows and preserves direction of the difference',()=>{
  const r={anchor:0,launchAt:0,market:'BTC',horizonDays:14,direction:'long',path:'OHLC',markPath:'OHLC',admitted:true,netReturn:.04};
  const first=[r,{...r,market:'ETH',netReturn:99}],second=[{...r,launchAt:8*HOUR,netReturn:.01},{...r,market:'ETH',admitted:false},{...r,horizonDays:30}];
  const pairs=pairRows(first,second);expect(pairs).toHaveLength(1);expect(pairs[0].netReturn).toBeCloseTo(.03);
  expect(pairs[0].launchAt).toBe(0);
});
