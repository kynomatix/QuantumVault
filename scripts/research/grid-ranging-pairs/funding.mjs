import {inflateRawSync} from 'node:zlib';
import {json,capture} from './io.mjs';
function unzip(b){let end=-1;for(let i=b.length-22;i>=Math.max(0,b.length-65557);i--)if(b.readUInt32LE(i)===0x06054b50){end=i;break}if(end<0)throw Error('Missing ZIP directory');let p=b.readUInt32LE(end+16);const out=[];for(let i=0;i<b.readUInt16LE(end+10);i++){if(b.readUInt32LE(p)!==0x02014b50)throw Error('Invalid ZIP entry');const method=b.readUInt16LE(p+10),length=b.readUInt32LE(p+20),size=b.readUInt32LE(p+24),nl=b.readUInt16LE(p+28),el=b.readUInt16LE(p+30),cl=b.readUInt16LE(p+32),loc=b.readUInt32LE(p+42);const start=loc+30+b.readUInt16LE(loc+26)+b.readUInt16LE(loc+28),raw=b.subarray(start,start+length),data=method===8?inflateRawSync(raw):method===0?raw:null;if(!data||data.length!==size)throw Error('ZIP size mismatch');out.push(data);p+=46+nl+el+cl}return out}
function urls(x,a=[]){if(typeof x==='string'&&/^https:\/\//.test(x)&&/\.zip(?:\?|$)/.test(x))a.push(x);else if(x&&typeof x==='object')Object.values(x).forEach(v=>urls(v,a));return [...new Set(a)]}
const nextMonth=t=>{const d=new Date(t);return Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1)};
const indexCache=new Map();
async function month(r,t,map){const d=new Date(t),block=Math.floor(d.getUTCMonth()/9)*9,begin=Date.UTC(d.getUTCFullYear(),block,1),end=Date.UTC(d.getUTCFullYear(),block+9,0),key=r.okx.instId+'-'+begin;
 if(!indexCache.has(key)){const j=await json('https://www.okx.com/api/v5/public/market-data-history?'+new URLSearchParams({module:'3',instType:'SWAP',instFamilyList:r.base+'-USDT',dateAggrType:'monthly',begin:String(begin),end:String(end)}),key);indexCache.set(key,urls(j))}
 const keyMonth=new Date(t).toISOString().slice(0,7);const found=indexCache.get(key).filter(u=>u.includes(r.okx.instId+'-fundingrates-'+keyMonth+'.zip'));if(found.length!==1)throw Error('Funding archive not uniquely available '+keyMonth);
 for(const b of unzip(await capture(found[0],r.symbol+'-'+keyMonth))){const lines=b.toString('utf8').trim().split(/\r?\n/);if(lines.shift().replace(/^\uFEFF/,'')!=='instrument_name,funding_rate,funding_time')throw Error('Wrong archive schema');for(const line of lines){const [id,rawRate,rawTime]=line.split(','),time=Number(rawTime),rate=Number(rawRate);if(id!==r.okx.instId||!rawRate||!rawTime||!Number.isSafeInteger(time)||!Number.isFinite(rate))throw Error('Invalid funding row');if(map.has(time)&&map.get(time)!==rate)throw Error('Conflicting funding');map.set(time,rate)}}
}

export {month,nextMonth};
