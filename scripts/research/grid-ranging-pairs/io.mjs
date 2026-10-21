import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {setTimeout as delay} from 'node:timers/promises';
export const HB='C:/Apps/Replit/conductor-worktrees/grid-ranging-pairs-20261021-handback';
export const ROOT=fs.readFileSync(HB+'/coverage-root.txt','utf8').trim();
export const hash=b=>createHash('sha256').update(b).digest('hex');
export const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
export const write=(name,v)=>fs.writeFileSync(path.join(ROOT,name),JSON.stringify(v,null,2)+'\n');
export const START=Date.UTC(2022,2,1),END=Date.UTC(2026,9,19),DAY=86400000,HOUR=3600000;
const records=[];let seq=0;const session=Date.now().toString(36);let rateGate=0;
export async function capture(url,label){
 for(let attempt=0;attempt<3;attempt++){
  const next=Math.max(Date.now(),rateGate);rateGate=next+120;if(next>Date.now())await delay(next-Date.now());
  const id=++seq,r={url,label,attempt,requestedAt:new Date().toISOString()};
  try{const resp=await fetch(url,{signal:AbortSignal.timeout(25000)}),bytes=Buffer.from(await resp.arrayBuffer());
   Object.assign(r,{status:resp.status,file:'raw-'+session+'-'+String(id).padStart(6,'0')+'.response',sha256:hash(bytes),bytes:bytes.length});fs.writeFileSync(path.join(ROOT,r.file),bytes);
   if(resp.ok)return bytes;
   if(resp.status!==429&&resp.status<500)throw Error('HTTP '+resp.status);
   const retry=resp.headers.get('retry-after');await delay(Math.max(5000*2**attempt,Number(retry||0)*1000));
  }catch(e){r.error=e.message;if(attempt===2)throw e;if(r.status&&r.status!==429&&r.status<500)throw e;await delay(1500*2**attempt);}
  finally{r.completedAt=new Date().toISOString();records.push(r);fs.appendFileSync(path.join(ROOT,'requests.jsonl'),JSON.stringify(r)+'\n');}
 }
 throw Error('HTTP retries exhausted');
}
export async function json(url,label){const j=JSON.parse(await capture(url,label));if(j.code!==undefined&&j.code!==null&&j.code!=='0')throw Error('API '+j.code+': '+j.msg);if(j.success===false)throw Error('API success false');return j;}
export function bound(file,sha256){const b=fs.readFileSync(file);if(sha256&&hash(b)!==sha256.toLowerCase())throw Error('Inherited SHA-256 mismatch '+file);return JSON.parse(b);}
export function checkpoint(phase,extra={}){fs.writeFileSync(HB+'/RESUME.md','# Ranging pairs checkpoint\n\n'+phase+' at '+new Date().toISOString()+'\nEvidence: '+ROOT+'\nPreregistration commit hash: f7fc916fcebd2c17ac42c348c467d909ec98f2ae\nADMITTED unique new simulations: 0\n'+JSON.stringify(extra)+'\n');}
export function freeze(){const files=fs.readdirSync(ROOT).filter(n=>!n.startsWith('manifest')).map(file=>({file,bytes:fs.statSync(path.join(ROOT,file)).size,sha256:hash(fs.readFileSync(path.join(ROOT,file)))}));write('manifest.json',{createdAt:new Date().toISOString(),files});write('manifest-sha256.json',{manifestSha256:hash(fs.readFileSync(path.join(ROOT,'manifest.json')))});}
