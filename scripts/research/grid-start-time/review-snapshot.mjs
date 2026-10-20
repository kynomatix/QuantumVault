// Exact-byte copies and the reviewer's unchanged read-only scan. No allowlists.
// Partitioning limits memory; the union is the declared complete review map.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=path.resolve(process.argv[2]),targetCommitHash=process.argv[3],work=path.resolve(fileURLToPath(new URL('../../..',import.meta.url))),handback=path.resolve(root,'../..');
if(!/^[a-f0-9]{40}$/.test(targetCommitHash??''))throw Error('Explicit target commit hash required');
const reviewerPath='C:/Apps/Replit/qv-orchestrator/qv-opus-read-reviewer.mjs',scannerPath=path.join(work,'scripts/qv-secrets-scan.mjs');
const {canonicalJson,scanInputManifest}=await import(pathToFileURL(reviewerPath).href);
const hash=b=>createHash('sha256').update(b).digest('hex').toUpperCase(),inputs=new Map();
const bind=(p,purpose='evidence')=>{
 p=path.resolve(p);if(!fs.existsSync(p)||!fs.statSync(p).isFile())throw Error('Missing review input: '+p);
 inputs.set(p,{originalPath:p,purpose,bytes:fs.statSync(p).size});
};
const walk=(dir,purpose,skip=()=>false)=>{
 for(const d of fs.readdirSync(dir,{withFileTypes:true})){
  if(skip(d.name))continue;
  const p=path.join(dir,d.name);
  if(d.isSymbolicLink())throw Error('Review input alias');
  if(d.isDirectory())walk(p,purpose,skip);else if(d.isFile())bind(p,purpose);
 }
};
walk(path.join(work,'scripts/research/grid-backtest-r2'),'source');
walk(path.join(work,'scripts/research/grid-finder'),'source');
walk(path.join(work,'scripts/research/grid-start-time'),'source');
walk(path.join(work,'scripts/research/grid-entry-filters'),'support');
bind(path.join(work,'tests/research/grid-entry-filters.test.ts'),'support');
bind(path.join(work,'tests/research/grid-start-time.test.ts'),'source');
bind(path.join(work,'tests/research/grid-finder.test.ts'),'source');
for(const name of fs.readdirSync(root).filter(f=>/^runtime-inputs-.*\.json$/.test(f)))
 for(const f of JSON.parse(fs.readFileSync(path.join(root,name),'utf8')).files)bind(f,'support');
for(const f of ['scripts/grid-trail-loader.mjs','scripts/research/grid-direction/loader.mjs','scripts/research/grid-direction/proxy-policy.mjs','scripts/research/grid-defaults/design.mjs','client/src/lib/grid-setup-view.ts','client/src/components/grid-planner/GridRangingFinder.tsx','client/src/components/grid-planner/GridPlannerSheet.tsx','shared/grid-regime.ts','server/grid-planner/candle-pool.ts','server/grid-planner/finder-candle-cache.ts'])bind(path.join(work,f),'support');
bind(reviewerPath,'support');bind(scannerPath,'support');
for(const f of fs.readdirSync(handback,{withFileTypes:true}).filter(f=>f.isFile()&&!f.name.endsWith('.bundle')&&!['REVIEW-SCAN-STATUS.md','RESUME.md'].includes(f.name)))bind(path.join(handback,f.name),f.name==='PREREGISTRATION.md'?'contract':'evidence');
// Scratch Git stores and bundle transports are not reviewer-readable text.
// All research/public evidence files are retained, including failed attempts.
walk(root,'evidence',name=>name.includes('scratch')||name.startsWith('review-snapshot-')||name.endsWith('.bundle')||name==='source-artifact');
for(const f of fs.readdirSync(root).filter(f=>/^complete-.*\.json$/.test(f))){
 const m=JSON.parse(fs.readFileSync(path.join(root,f),'utf8'));
 for(const b of [...(m.bindings??[]),...(m.publicFacts?.bindings??[])])bind(b.file);
}
const prior='C:/Apps/Replit/conductor-worktrees/grid-backtest-r2-20261020-handback';
for(const f of ['ROUND-2-REPORT.md','PREREGISTRATION.md','LESSONS-R2.md'])bind(path.join(prior,f),'support');
const priorRoot=path.join(prior,'evidence/r2-20261020T062012Z');
bind(path.join(priorRoot,'node-public-info.json'),'support');
for(const name of ['public-history-path.txt','okx-funding-path.txt']){
 bind(path.join(priorRoot,name),'support');
 const dir=fs.readFileSync(path.join(priorRoot,name),'utf8').trim();
 for(const file of ['manifest.json','manifest-sha256.json'])bind(path.join(dir,file),'support');
}
for(const item of JSON.parse(fs.readFileSync(path.join(root,'baseline-reconciliation.json'),'utf8')).results){
 bind(item.priorPath,'support');
 bind(path.join(path.dirname(item.priorPath), 'complete-'+item.period+'.json'),'support');
}
const trailEvidence='C:/Apps/Replit/conductor-worktrees/grid-trail-backtest-20261019-handback/evidence',configPath=path.join(trailEvidence,'round2-20261019T044511Z/evaluation/configuration.json');
bind(configPath,'support');
const candleRoot=JSON.parse(fs.readFileSync(configPath,'utf8')).sourceDirectory;
bind(path.join(candleRoot,'manifest.json'),'support');
const directionEvidence='C:/Apps/Replit/conductor-worktrees/grid-direction-backtest-20261019-handback/evidence/direction-20261019T095720Z';
for(const folder of ['snapshot','fallback-snapshot-v2'])for(const file of ['manifest.json','manifest-sha256.json'])bind(path.join(directionEvidence,folder,file),'support');
const profile={kind:'research-only-readonly-input-scan',reviewerPath,scannerPath,partitionBytes:16*1024*1024,maximumEstimatedMemoryFraction:0.7,independentOpusReview:false};
const contractDigest=hash(fs.readFileSync(path.join(handback,'PREREGISTRATION.md'))),profileSha256=hash(Buffer.from(canonicalJson(profile)));
const destination=path.join(root,'review-snapshot-'+new Date().toISOString().replace(/[-:.]/g,''));
if(fs.existsSync(destination))throw Error('Fresh review root required');
fs.mkdirSync(destination);fs.writeFileSync(path.join(destination,'profile.json'),JSON.stringify(profile,null,2)+'\n');
const ordered=[...inputs.values()].sort((a,b)=>a.originalPath.localeCompare(b.originalPath)),batches=[];let batch=[],size=0;
for(const item of ordered){
 if(batch.length&&size+item.bytes>profile.partitionBytes){batches.push(batch);batch=[];size=0;}
 batch.push(item);size+=item.bytes;
}if(batch.length)batches.push(batch);
const results=[],closure=[];
for(const [index,items] of batches.entries()){
 const dir=path.join(destination,String(index).padStart(4,'0')),sourceRoot=path.join(dir,'inputs');fs.mkdirSync(sourceRoot,{recursive:true});
 const files=items.map((item,i)=>{
  const copyPath=path.join(sourceRoot,String(i).padStart(4,'0')+'-'+path.basename(item.originalPath));
  fs.copyFileSync(item.originalPath,copyPath);
  const bytes=fs.readFileSync(copyPath);const row={...item,copyPath,sha256:hash(bytes)};closure.push(row);return row;
 });
 const body={schemaVersion:1,unitId:'research/grid-start-time',targetSha:targetCommitHash,targetCommitHash,contractDigest,profileSha256,sourceRoot,files};
 const manifest={...body,manifestSha256:hash(Buffer.from(canonicalJson(body)))};
 fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 global.gc?.();
 const estimatedBytes=items.reduce((s,r)=>s+r.bytes,0)*8;
 let result;
 if(estimatedBytes>os.freemem()*profile.maximumEstimatedMemoryFraction){
  result={partition:index,state:'incomplete',reason:'Exact snapshot exceeds the conservative scanner memory budget; not skipped as clean',estimatedBytes};
 }else{
  try{
   const scan=await scanInputManifest(manifest,scannerPath);
   fs.writeFileSync(path.join(dir,'scan.json'),JSON.stringify(scan,null,2)+'\n');
   result={partition:index,state:'clean',findingCount:scan.rawFindingCount??0};
  }catch(error){
   if(error.scanEvidence)fs.writeFileSync(path.join(dir,'scan.json'),JSON.stringify(error.scanEvidence,null,2)+'\n');
   result={partition:index,state:'blocked',reason:error.code??error.message,findingCount:error.scanEvidence?.rawFindingCount??error.scanEvidence?.rawReport?.findingCount??null};
  }
 }
 results.push(result);global.gc?.();
}
const clean=results.every(r=>r.state==='clean'&&r.findingCount===0);
const summary={createdAt:new Date().toISOString(),targetCommitHash,scannerPath,scannerSha256:hash(fs.readFileSync(scannerPath)),reviewerPath,reviewerSha256:hash(fs.readFileSync(reviewerPath)),status:clean?'zero-findings':'UNSEALED',files:closure.length,partitions:results.length,results};
fs.writeFileSync(path.join(destination,'review-input-map.json'),JSON.stringify({profile,files:closure},null,2)+'\n');
fs.writeFileSync(path.join(destination,'summary.json'),JSON.stringify(summary,null,2)+'\n');
fs.writeFileSync(path.join(root,'review-snapshot-path.txt'),destination+'\n');
const counts=Object.fromEntries(['clean','blocked','incomplete'].map(k=>[k,results.filter(r=>r.state===k).length]));
fs.writeFileSync(path.join(handback,'REVIEW-SCAN-STATUS.md'),`Readonly snapshot scan: **${summary.status}**.\n\nThe reviewer's own unchanged scanner examined the exact input-map partitions. ${closure.length} files; ${counts.clean} clean partitions, ${counts.blocked} blocked, ${counts.incomplete} incomplete. All findings and errors are preserved; nothing was allowlisted, suppressed or rewritten. This is a research scan, not an independent Opus review or conductor gate.\n\nSnapshot: ${destination}\n\n${clean?'Zero findings were established for the declared closure.':'Zero findings were not established. Do not freeze, seal or treat this handback as approved gate evidence.'}\n`);
console.log(`Readonly scan ${summary.status}: ${closure.length} files, partitions ${JSON.stringify(counts)}`);
