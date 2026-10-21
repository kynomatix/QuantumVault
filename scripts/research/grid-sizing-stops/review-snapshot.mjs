// Read-only use of the reviewer's unchanged scanner, including every input byte.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root=path.resolve(process.argv[2]),targetCommitHash=process.argv[3],work=process.cwd(),handback='C:/Apps/Replit/conductor-worktrees/grid-sizing-stops-20261021-handback';
if(!/^[a-f0-9]{40}$/.test(targetCommitHash??''))throw Error('Explicit target commit hash required');
const reviewerPath='C:/Apps/Replit/qv-orchestrator/qv-opus-read-reviewer.mjs',scannerPath=path.join(work,'scripts/qv-secrets-scan.mjs');
const {canonicalJson,scanInputManifest}=await import(pathToFileURL(reviewerPath).href);
const hash=b=>createHash('sha256').update(b).digest('hex').toUpperCase(),inputs=new Map();
const bind=(file,purpose='support')=>{file=path.resolve(file);const stat=fs.statSync(file);if(!stat.isFile())throw Error('Missing review input');inputs.set(file,{originalPath:file,purpose,bytes:stat.size});};
for(const phase of ['phase1','phase2']){
 const dir=fs.readFileSync(path.join(handback,phase+'-root.txt'),'utf8').trim();
 for(const name of fs.readdirSync(dir)){
  const file=path.join(dir,name);if(!fs.statSync(file).isFile())continue;bind(file,'evidence');
  if(name.endsWith('-complete.json'))for(const item of JSON.parse(fs.readFileSync(file,'utf8')).bindings)bind(item.file);
 }
}
for(const file of JSON.parse(fs.readFileSync(path.join(handback,'runtime-inputs.json'),'utf8')).files)bind(file);
for(const file of fs.readdirSync(path.join(work,'scripts/research/grid-sizing-stops')))bind(path.join(work,'scripts/research/grid-sizing-stops',file),'source');
bind(path.join(work,'tests/research/grid-sizing-stops.test.ts'),'source');
for(const file of ['scripts/grid-trail-loader.mjs','scripts/research/grid-walkforward/loader.mjs','scripts/research/grid-walkforward/pure-policy.mjs','scripts/research/grid-finder/loader.mjs','scripts/research/grid-finder/source.mjs','scripts/research/grid-backtest-r2/loader.mjs','scripts/research/grid-backtest-r2/adapter.mjs','scripts/research/grid-direction/loader.mjs','scripts/research/grid-squeeze-diag/stats.mjs'])bind(path.join(work,file));
for(const r of JSON.parse(fs.readFileSync(path.join(handback,'validation.json'),'utf8')).runs){bind(r.receiptPath,'evidence');if(r.utf8ReceiptPath)bind(r.utf8ReceiptPath,'evidence');}
for(const [dir,names]of [['grid-backtest-r2-20261020-handback',['ROUND-2-REPORT.md','LESSONS-R2.md']],['grid-walkforward-20261021-handback',['WALKFORWARD-REPORT.md']],['grid-squeeze-diag-20261021-handback',['SQUEEZE-DIAG-REPORT.md']]])for(const name of names)bind(path.resolve(work,'..',dir,name));
bind(reviewerPath);bind(scannerPath);
for(const file of fs.readdirSync(handback,{withFileTypes:true}).filter(x=>x.isFile()&&!x.name.endsWith('.bundle')&&!['REVIEW-SCAN-STATUS.md','RESUME.md'].includes(x.name)))bind(path.join(handback,file.name),'evidence');
const destination=path.join(root,'review-snapshot-'+new Date().toISOString().replace(/[-:.]/g,''));
if(fs.existsSync(destination))throw Error('Fresh snapshot root required');fs.mkdirSync(destination);
const profile={kind:'research-readonly-snapshot',reviewerPath,scannerPath,partitionBytes:8*1024*1024,independentOpusReview:false,lineBoundaryChunks:true};
const contractDigest=hash(fs.readFileSync(path.join(work,'scripts/research/grid-sizing-stops/PREREGISTRATION-PHASE1.md'))),profileSha256=hash(Buffer.from(canonicalJson(profile)));
fs.writeFileSync(path.join(destination,'profile.json'),JSON.stringify(profile,null,2)+'\n');
const closure=[],results=[];let index=0;
async function scanChunk(item,bytes,offset,overlapBytes){
 const dir=path.join(destination,String(index).padStart(5,'0')),sourceRoot=path.join(dir,'inputs');fs.mkdirSync(sourceRoot,{recursive:true});
 const copyPath=path.join(sourceRoot,path.basename(item.originalPath));fs.writeFileSync(copyPath,bytes);
 const row={...item,bytes:bytes.length,copyPath,sha256:hash(bytes),sourceOffset:offset,overlapBytes};
 const body={schemaVersion:1,unitId:'research/grid-sizing-stops',targetSha:targetCommitHash,targetCommitHash,contractDigest,profileSha256,sourceRoot,files:[row]};
 const manifest={...body,manifestSha256:hash(Buffer.from(canonicalJson(body)))};
 fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 let result;
 try{const scan=await scanInputManifest(manifest,scannerPath);fs.writeFileSync(path.join(dir,'scan.json'),JSON.stringify(scan)+'\n');result={partition:index,state:'clean',findingCount:scan.rawFindingCount??0};}
 catch(error){if(error.scanEvidence)fs.writeFileSync(path.join(dir,'scan.json'),JSON.stringify(error.scanEvidence)+'\n');result={partition:index,state:'blocked',reason:error.code??error.message,findingCount:error.scanEvidence?.rawFindingCount??error.scanEvidence?.rawReport?.findingCount??null};}
 closure.push(row);results.push(result);index++;global.gc?.();
}
for(const item of [...inputs.values()].sort((a,b)=>a.originalPath.localeCompare(b.originalPath))){
 // Split only at complete line boundaries. Retain two previous lines at each
 // boundary so adjacent hash labels and scanner context are not lost.
 let carry=Buffer.alloc(0),offset=0,overlap=Buffer.alloc(0);const sourceHash=createHash('sha256'),reconstructedHash=createHash('sha256');
 for await(const bytes of fs.createReadStream(item.originalPath,{highWaterMark:1024*1024})){
  sourceHash.update(bytes);carry=Buffer.concat([carry,bytes]);
  if(carry.length<profile.partitionBytes)continue;
  const cut=carry.lastIndexOf(10,profile.partitionBytes);if(cut<0)continue;
  const body=carry.subarray(0,cut+1);reconstructedHash.update(body);
  await scanChunk(item,Buffer.concat([overlap,body]),offset-overlap.length,overlap.length);offset+=body.length;
  let cursor=body.length-2;for(let i=0;i<2;i++){const at=body.lastIndexOf(10,cursor);if(at<0){cursor=-1;break;}cursor=at-1;}
  overlap=Buffer.from(body.subarray(cursor+2));carry=Buffer.from(carry.subarray(cut+1));
 }
 if(carry.length||!offset){reconstructedHash.update(carry);await scanChunk(item,Buffer.concat([overlap,carry]),offset-overlap.length,overlap.length);offset+=carry.length;}
 const sourceSha256=sourceHash.digest('hex').toUpperCase(),reconstructedSha256=reconstructedHash.digest('hex').toUpperCase();
 if(sourceSha256!==reconstructedSha256||offset!==item.bytes)throw Error('Snapshot reconstruction differs');
 item.sha256=sourceSha256;item.reconstructedSha256=reconstructedSha256;
}
const clean=results.every(r=>r.state==='clean'&&r.findingCount===0);
const summary={createdAt:new Date().toISOString(),targetCommitHash,scannerPath,scannerSha256:hash(fs.readFileSync(scannerPath)),reviewerPath,reviewerSha256:hash(fs.readFileSync(reviewerPath)),status:clean?'zero-findings':'UNSEALED',sourceFiles:inputs.size,partitions:results.length,results};
fs.writeFileSync(path.join(destination,'review-input-map.json'),JSON.stringify({profile,sources:[...inputs.values()],files:closure},null,2)+'\n');
fs.writeFileSync(path.join(destination,'summary.json'),JSON.stringify(summary,null,2)+'\n');
fs.writeFileSync(path.join(root,'review-snapshot-path.txt'),destination+'\n');
const blocked=results.filter(r=>r.state!=='clean').length;
fs.writeFileSync(path.join(handback,'REVIEW-SCAN-STATUS.md'),`Read-only snapshot scan: **${summary.status}**.\n\nThe reviewer's unchanged scanner examined ${inputs.size} complete source files in ${results.length} partitions; ${blocked} partitions were blocked. Large inputs are split at whole-line boundaries with overlapping context; non-overlapping bytes reconstruct each original SHA-256 hash exactly. The review-input map retains each byte range and hash. All findings are retained; no scanner rule, allowlist or immutable production literal was changed.\n\nSnapshot: ${destination}\n\n${clean?'Zero findings established for the declared closure.':'Zero findings NOT established. Do not freeze or seal this handback as approved evidence.'} This is not independent Opus review or conductor approval. Scan outputs and the final resume/status note are terminal records rather than recursively scanned inputs.\n`);
console.log(`Readonly scan ${summary.status}: ${inputs.size} source files, ${results.length} partitions, ${blocked} blocked.`);
