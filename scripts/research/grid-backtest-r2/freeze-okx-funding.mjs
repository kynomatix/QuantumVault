import fs from 'node:fs';
import path from 'node:path';
import {inflateRawSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {setTimeout} from 'node:timers/promises';
const root=process.argv[2],out=path.join(root,'okx-funding-'+new Date().toISOString().replace(/\D/g,'')),sha256=b=>createHash('sha256').update(b).digest('hex');
fs.mkdirSync(out);const manifest={createdAt:new Date().toISOString(),kind:'OKX settled funding proxy',requests:[],datasets:[],errors:[]};
const checkpoint=()=>fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
async function get(url,file){
 await setTimeout(650);const r=await fetch(url,{signal:AbortSignal.timeout(30000)}),bytes=Buffer.from(await r.arrayBuffer());
 fs.writeFileSync(path.join(out,file),bytes,{flag:'wx'});manifest.requests.push({url,file,status:r.status,sha256:sha256(bytes)});checkpoint();
 if(!r.ok)throw Error(`HTTP ${r.status}`);return bytes;
}
function unzip(b){
 const e=b.lastIndexOf(Buffer.from([80,75,5,6]));if(e<0)throw Error('Missing ZIP directory');
 let p=b.readUInt32LE(e+16);const count=b.readUInt16LE(e+10),texts=[];
 for(let i=0;i<count;i++){
  if(b.readUInt32LE(p)!==0x02014b50)throw Error('Invalid ZIP directory');
  const n=b.readUInt16LE(p+28),extra=b.readUInt16LE(p+30),comment=b.readUInt16LE(p+32),off=b.readUInt32LE(p+42),sz=b.readUInt32LE(p+20),method=b.readUInt16LE(p+10);
  const file=b.subarray(p+46,p+46+n).toString();if(b.readUInt32LE(off)!==0x04034b50)throw Error('Invalid ZIP header');
  const start=off+30+b.readUInt16LE(off+26)+b.readUInt16LE(off+28),raw=b.subarray(start,start+sz);
  if(![0,8].includes(method))throw Error('Unsupported ZIP compression');
  if(file.endsWith('.csv'))texts.push((method===8?inflateRawSync(raw):raw).toString());
  p+=46+n+extra+comment;
 }
 return texts;
}
for(const symbol of ['BTC','ETH','SOL','HYPE','ZEC']){
 const files=new Map(),rates=new Map();
 for(let y=2022,m=0;y<2026;){
  const begin=Date.UTC(y,m,1),end=Date.UTC(y,m+8,1);
  const url=`https://www.okx.com/api/v5/public/market-data-history?module=3&instType=SWAP&instFamilyList=${symbol}-USDT&dateAggrType=monthly&begin=${begin}&end=${end}`;
  const j=JSON.parse(await get(url,`index-${symbol}-${y}-${m}.json`));
  if(j.code!=='0')throw Error('OKX funding index rejected: '+j.msg);
  for(const group of j.data)for(const detail of group.details)for(const f of detail.groupDetails)files.set(f.url,f.filename);
  m+=9;y+=Math.floor(m/12);m%=12;
 }
 for(const [url,file] of files){
  for(const text of unzip(await get(url,file))){
   const lines=text.trim().split(/\r?\n/),header=lines.shift().split(',');
   if(header.join(',')!=='instrument_name,funding_rate,funding_time')throw Error('Unknown funding CSV schema');
   for(const line of lines){
    const [instrument,r,t]=line.split(','),time=Number(t),rate=Number(r);
    if(instrument!==`${symbol}-USDT-SWAP`||!Number.isSafeInteger(time)||!Number.isFinite(rate))throw Error('Invalid funding row');
    if(time<Date.UTC(2022,0,1)||time>=Date.UTC(2026,0,1))continue;
    if(rates.has(time)&&rates.get(time).rate!==rate)throw Error('Conflicting funding duplicate');
    rates.set(time,{time,rate});
   }
  }
 }
 const rows=[...rates.values()].sort((a,b)=>a.time-b.time),file=`funding-${symbol}.json`,bytes=JSON.stringify({symbol,source:'okx',proxy:true,rows});
 fs.writeFileSync(path.join(out,file),bytes,{flag:'wx'});
 manifest.datasets.push({symbol,file,sha256:sha256(bytes),count:rows.length,from:rows[0]?.time,through:rows.at(-1)?.time,archives:files.size});
 checkpoint();console.log(`${symbol}: ${rows.length} settled funding rows; ${files.size} monthly archives`);
}
manifest.completedAt=new Date().toISOString();checkpoint();
fs.writeFileSync(path.join(out,'manifest-sha256.json'),JSON.stringify({manifestSha256:sha256(fs.readFileSync(path.join(out,'manifest.json')))},null,2)+'\n');
fs.writeFileSync(path.join(root,'okx-funding-path.txt'),out+'\n');
console.log('OKX funding freeze complete');
