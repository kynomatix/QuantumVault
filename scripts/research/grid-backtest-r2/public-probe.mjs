import fs from 'node:fs';
import {createHash} from 'node:crypto';
const out=process.argv[2],results=[];
for(const [name,url] of Object.entries({
 info:'https://api.pacifica.fi/api/v1/info',
 mark:'https://api.pacifica.fi/api/v1/kline/mark?symbol=BTC&interval=1h&start_time=1767225600000&end_time=1767312000000',
 funding:'https://api.pacifica.fi/api/v1/funding_rate/history?symbol=BTC&limit=4000',
})){
 const startedAt=new Date().toISOString();
 try{
  const r=await fetch(url,{signal:AbortSignal.timeout(30000)}),s=await r.text();
  fs.writeFileSync(`${out}/node-public-${name}.json`,s);
  let j;try{j=JSON.parse(s);}catch{}
  const row={name,url,startedAt,status:r.status,success:j?.success,rows:j?.data?.length,bytes:s.length,sha256:createHash('sha256').update(s).digest('hex'),keys:Object.keys(j??{})};
  results.push(row);console.log(JSON.stringify(row));
 }catch(e){const row={name,url,startedAt,error:e.message,cause:e.cause?.message};results.push(row);console.log(JSON.stringify(row));}
}
fs.writeFileSync(`${out}/public-probe.json`,JSON.stringify(results,null,2)+'\n');
