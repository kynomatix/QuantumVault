import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {setTimeout as delay} from 'node:timers/promises';
const hb=path.resolve('../grid-multi-timeframe-20261022-handback'),root=fs.readFileSync(hb+'/study-root.txt','utf8').trim(),out=root+'/candles15m';fs.mkdirSync(out);
const markets=JSON.parse(fs.readFileSync(root+'/markets.json','utf8')),Q=900000,hash=b=>createHash('sha256').update(b).digest('hex');let sequence=0;const records=[],certifications=[];
async function page(instId,after,label){
 const url='https://www.okx.com/api/v5/market/history-candles?'+new URLSearchParams({instId,bar:'15m',after:String(after),limit:'300'});
 for(let attempt=0;attempt<3;attempt++){
  const record={url,label,attempt,requestedAt:new Date().toISOString()};
  try{const response=await fetch(url,{signal:AbortSignal.timeout(15000)}),bytes=Buffer.from(await response.arrayBuffer()),file=out+'/raw-'+String(++sequence).padStart(6,'0')+'.response';fs.writeFileSync(file,bytes,{flag:'wx'});Object.assign(record,{status:response.status,file,sha256:hash(bytes)});
   if(response.status===429||response.status>=500){if(attempt===2)throw Error('HTTP retries exhausted '+response.status);await delay(Math.max(5000*2**attempt,Number(response.headers.get('retry-after')||0)*1000));continue;}
   if(!response.ok)throw Error('HTTP '+response.status);const json=JSON.parse(bytes);if(json.code!=='0'||!Array.isArray(json.data))throw Error('API '+json.code+': '+json.msg);return json.data;
  }catch(e){record.error=e.message;record.cause=e.cause?.code??null;if(attempt===2||record.status&&record.status!==429&&record.status<500)throw Error(e.message+(record.cause?' / '+record.cause:''));await delay(1500*2**attempt);}
  finally{records.push(record);fs.appendFileSync(out+'/requests.jsonl',JSON.stringify(record)+'\n');}
 }
}
function valid(raw){const a=raw.slice(0,8).map(Number);if(raw[8]!=='1'||a.some(x=>!Number.isFinite(x))||a[0]%Q||!a.slice(1,5).every(x=>x>0)||a[2]<Math.max(a[1],a[4])||a[3]>Math.min(a[1],a[4])||a[3]>a[2]||a.slice(5).some(x=>x<0))throw Error('Invalid or nonfinal 15m candle');return [a[0],a[1],a[2],a[3],a[4],a[6],a[7]];}
for(const m of markets){const result={symbol:m.symbol,universe:m.universe,passed:false,begin:m.required15mBegin,end:m.required15mEnd,pages:0};try{
 if(!m.first)throw Error('No eligible launch under inherited twelve-month rule');
 // Probe the oldest required boundary before spending requests on recent history.
 const first=(await page(m.candidate.okx.instId,result.begin+300*Q,m.symbol+'-oldest')).map(valid);result.pages++;
 if(!first.some(x=>x[0]===result.begin))throw Error('Oldest required 15m boundary absent from historical API');
 const map=new Map();let cursor=result.end;
 while(cursor>result.begin){const raw=await page(m.candidate.okx.instId,cursor,m.symbol+'-'+result.pages++);if(!raw.length)throw Error('Empty historical page before required boundary');let oldest=cursor;
  for(const x of raw.map(valid)){oldest=Math.min(oldest,x[0]);if(x[0]<result.begin||x[0]>=result.end)continue;if(map.has(x[0])&&JSON.stringify(map.get(x[0]))!==JSON.stringify(x))throw Error('Conflicting 15m candle');map.set(x[0],x);}
  if(oldest>=cursor)throw Error('15m pagination did not progress');cursor=oldest;
 }
 const rows=[...map.values()].sort((a,b)=>a[0]-b[0]);if(rows.length!==(result.end-result.begin)/Q||rows.some((x,i)=>x[0]!==result.begin+i*Q))throw Error('Gaps in required 15m history');
 result.file=out+'/'+m.symbol+'.json';fs.writeFileSync(result.file,JSON.stringify({symbol:m.symbol,rows})+'\n',{flag:'wx'});result.sha256=hash(fs.readFileSync(result.file));result.rows=rows.length;result.passed=true;
 }catch(e){result.reason=e.message;}
 certifications.push(result);fs.writeFileSync(out+'/certification.json',JSON.stringify(certifications)+'\n');
 fs.writeFileSync(hb+'/RESUME.md','15m acquisition completed '+certifications.length+'/'+markets.length+' markets; certified '+certifications.filter(x=>x.passed).length+'. No simulations yet. Evidence: '+root+'\n');
 console.log(JSON.stringify({symbol:m.symbol,passed:result.passed,reason:result.reason,pages:result.pages}));
}
const certified=certifications.filter(x=>x.passed).length;fs.writeFileSync(out+'/complete.json',JSON.stringify({certified,attemptedMarkets:markets.length,drop15m:certified<24,requests:records.length,completedAt:new Date().toISOString()})+'\n',{flag:'wx'});console.log(JSON.stringify({certified,drop15m:certified<24}));
