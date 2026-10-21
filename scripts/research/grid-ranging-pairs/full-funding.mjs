import fs from 'node:fs';import os from 'node:os';
import {ROOT,read,write,json,START,END,DAY,HOUR,checkpoint,freeze} from './io.mjs';
import {month,nextMonth} from './funding.mjs';
import {assessFunding} from '../grid-walkforward/funding-coverage.mjs';
const all=read(ROOT+'/candidate-universe.json'),screen=read(ROOT+'/screen.json');
if(screen.length!==all.length)throw Error('Screen incomplete');
const pending=screen.filter(r=>r.passed&&r.stage!=='full-inherited'),results=screen.filter(r=>!r.passed||r.stage==='full-inherited');let cursor=0;
async function one(s){const r=all.find(x=>x.symbol===s.symbol),out={...s,stage:'full-funding',passed:false};const map=new Map(read(ROOT+'/'+r.symbol+'-first-funding.json').rows.map(x=>[x.time,x.rate]));
 try{const firstMonth=Date.UTC(new Date(r.begin).getUTCFullYear(),new Date(r.begin).getUTCMonth(),1);let previous=nextMonth(firstMonth);
  for(let t=nextMonth(previous);t<Date.UTC(2026,9,1);t=nextMonth(t)){
   await month(r,t,map);const check=assessFunding([...map].map(([time,rate])=>({time,rate})),previous,t);if(!check.passed){out.failure={month:new Date(previous).toISOString().slice(0,7),missing:check.missing.slice(0,10),missingCount:check.missingAnchors,ambiguousDays:check.ambiguousDays,invalid:check.invalid.slice(0,5)};throw Error('Incomplete observed funding in '+out.failure.month)}previous=t;
  }
  let cursor=END;for(let page=0;page<8;page++){const j=await json('https://www.okx.com/api/v5/public/funding-rate-history?'+new URLSearchParams({instId:r.okx.instId,after:String(cursor),limit:'400'}),r.symbol+'-recent-funding');if(!j.data.length)break;for(const v of j.data){const time=Number(v.fundingTime),rate=Number(v.realizedRate||v.fundingRate);if(v.instId!==r.okx.instId||!Number.isSafeInteger(time)||!Number.isFinite(rate)||(!v.realizedRate&&!v.fundingRate))throw Error('Invalid recent funding');if(v.realizedRate&&v.fundingRate&&Number(v.realizedRate)!==Number(v.fundingRate))throw Error('Reported and realized funding disagree');if(map.has(time)&&map.get(time)!==rate)throw Error('Conflicting recent funding');map.set(time,rate)}const min=Math.min(...j.data.map(x=>Number(x.fundingTime)));if(min>=cursor)throw Error('Nonprogressing funding pagination');cursor=min;if(cursor<=Date.UTC(2026,8,1))break;}
  const rows=[...map].map(([time,rate])=>({time,rate})).filter(x=>x.time>=r.begin&&x.time<END).sort((a,b)=>a.time-b.time);const coverage=assessFunding(rows,r.begin,END);write(r.symbol+'-funding.json',{symbol:r.symbol,rows,coverage});if(!coverage.passed){out.failure={missing:coverage.missing.slice(0,10),missingCount:coverage.missingAnchors,ambiguousDays:coverage.ambiguousDays,invalid:coverage.invalid.slice(0,5)};throw Error('Full-period observed funding incomplete')};out.passed=true;out.fundingRows=rows.length;
 }catch(e){out.reason=e.message;write(r.symbol+'-funding-partial.json',{rows:[...map].map(([time,rate])=>({time,rate})).sort((a,b)=>a.time-b.time),failure:out.failure,reason:e.message});}
 return out;
}
async function worker(id){for(;;){if(id===1&&os.freemem()<1.8*2**30)return;const s=pending[cursor++];if(!s)return;results.push(await one(s));write('full-funding-screen.json',results);checkpoint('Full-period funding screen',{completed:results.length,total:all.length,passing:results.filter(x=>x.passed).length});}}
await Promise.all([worker(0),worker(1)]);write('full-funding-screen.json',results);const summary={total:all.length,passing:results.filter(r=>r.passed).length,rejected:results.filter(r=>!r.passed).length,complete:results.length===all.length};write('full-funding-summary.json',summary);freeze();console.log(JSON.stringify(summary));
