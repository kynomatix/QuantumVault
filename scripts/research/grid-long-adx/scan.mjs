import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';
const HB=path.resolve('../grid-long-adx-20261022-handback');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8')),hash=b=>createHash('sha256').update(b).digest('hex');
const targetCommitHash=read(HB+'/tip.json').tipCommitHash;
const reviewerPath='C:/Apps/Replit/qv-orchestrator/qv-opus-read-reviewer.mjs',scannerPath=path.resolve('scripts/qv-secrets-scan.mjs');
const {canonicalJson,scanInputManifest}=await import(pathToFileURL(reviewerPath).href);
const dest=HB+'/evidence/readonly-scan-'+new Date().toISOString().replace(/[-:.]/g,'');fs.mkdirSync(dest);
const inputs=new Map();
function bind(file,purpose='evidence',expectedSha256){file=path.resolve(file);if(fs.statSync(file).isFile())inputs.set(file,{originalPath:file,purpose,bytes:fs.statSync(file).size,...(expectedSha256?{expectedSha256}:{})});}
for(const name of fs.readdirSync('scripts/research/grid-long-adx'))bind('scripts/research/grid-long-adx/'+name,'source');
bind('tests/research/grid-long-adx.test.ts','source');
for(const name of fs.readdirSync(HB))if(/\.(md|json|ps1|sh)$/.test(name)&&!['REVIEW-SCAN-STATUS.md','RESUME.md'].includes(name))bind(HB+'/'+name);
const root=fs.readFileSync(HB+'/study-root.txt','utf8').trim();
if(!process.argv.includes('--source-only')){
for(const name of fs.readdirSync(root))bind(root+'/'+name);
for(const input of read(root+'/input-bindings.json'))bind(input.file,'inherited-support',input.sha256);
for(const name of fs.readdirSync(HB+'/evidence').filter(n=>n.startsWith('focused-'))){
 const dir=HB+'/evidence/'+name;for(const f of fs.readdirSync(dir))if(/\.(json|log|sh)$/.test(f))bind(dir+'/'+f);
}
}
bind(scannerPath,'support');bind(reviewerPath,'support');
const profile={kind:'research-long-adx-readonly-closure',scope:process.argv.includes('--source-only')?'preliminary-source-only':'complete',partitionBytes:8*1024*1024,independentReview:false};
const profileSha256=hash(Buffer.from(canonicalJson(profile))).toUpperCase(),contractDigest=hash(fs.readFileSync('scripts/research/grid-long-adx/PREREGISTRATION.md')).toUpperCase();
let index=0,batch=[],batchBytes=0;const closure=[],results=[];
async function flush(){
 if(!batch.length)return;const dir=dest+'/'+String(index).padStart(5,'0'),sourceRoot=dir+'/inputs';fs.mkdirSync(sourceRoot,{recursive:true});
 const files=batch.map((x,i)=>{const copyPath=sourceRoot+'/'+String(i).padStart(4,'0')+'-'+path.basename(x.item.originalPath);fs.writeFileSync(copyPath,x.bytes);return {...x.item,copyPath,bytes:x.bytes.length,sha256:hash(x.bytes).toUpperCase(),sourceOffset:x.offset,overlapBytes:x.overlap};});
 const body={schemaVersion:1,unitId:'research/grid-long-adx',targetSha:targetCommitHash,targetCommitHash,contractDigest,profileSha256,sourceRoot,files},manifest={...body,manifestSha256:hash(Buffer.from(canonicalJson(body))).toUpperCase()};fs.writeFileSync(dir+'/review-input-map.json',JSON.stringify(manifest)+'\n');
 try{const e=await scanInputManifest(manifest,scannerPath);fs.writeFileSync(dir+'/scan.json',JSON.stringify(e)+'\n');results.push({partition:index,state:'clean',findings:e.rawFindingCount??0});}
 catch(e){if(!e.scanEvidence)throw e;fs.writeFileSync(dir+'/scan.json',JSON.stringify(e.scanEvidence)+'\n');results.push({partition:index,state:'findings',findings:e.scanEvidence.rawFindingCount??e.scanEvidence.rawReport?.findingCount,details:(e.scanEvidence.rawReport?.findings??[]).map(f=>({path:f.path,line:f.line,ruleId:f.ruleId}))});}
 closure.push(...files);index++;batch=[];batchBytes=0;
}
async function add(item,bytes,offset,overlap){if(batchBytes+bytes.length>profile.partitionBytes||batch.length>=150)await flush();batch.push({item,bytes:Buffer.from(bytes),offset,overlap});batchBytes+=bytes.length;}
for(const item of inputs.values()){
 const sourceHash=createHash('sha256'),reconstructed=createHash('sha256');let carry=Buffer.alloc(0),overlap=Buffer.alloc(0),offset=0;
 for await(const bytes of fs.createReadStream(item.originalPath,{highWaterMark:1024*1024})){sourceHash.update(bytes);carry=Buffer.concat([carry,bytes]);if(carry.length<profile.partitionBytes)continue;const cut=carry.lastIndexOf(10,profile.partitionBytes-1);if(cut<0)continue;const part=carry.subarray(0,cut+1);reconstructed.update(part);await add(item,Buffer.concat([overlap,part]),offset-overlap.length,overlap.length);offset+=part.length;let cursor=part.length-2;for(let i=0;i<2;i++){const at=part.lastIndexOf(10,cursor);if(at<0){cursor=-1;break;}cursor=at-1;}overlap=Buffer.from(part.subarray(cursor+2));carry=Buffer.from(carry.subarray(cut+1));}
 if(carry.length||!offset){reconstructed.update(carry);await add(item,Buffer.concat([overlap,carry]),offset-overlap.length,overlap.length);offset+=carry.length;}item.sha256=sourceHash.digest('hex');item.reconstructedSha256=reconstructed.digest('hex');if(item.sha256!==item.reconstructedSha256||offset!==item.bytes)throw Error('Snapshot reconstruction differs');if(item.expectedSha256&&item.sha256!==item.expectedSha256)throw Error('Inherited input changed after analysis: '+item.originalPath);
}
await flush();const summary={targetCommitHash,createdAt:new Date().toISOString(),status:results.every(r=>r.state==='clean')?'zero-findings':'UNSEALED',sourceFiles:inputs.size,partitions:results.length,results,scannerSha256:hash(fs.readFileSync(scannerPath)),reviewerSha256:hash(fs.readFileSync(reviewerPath))};
fs.writeFileSync(dest+'/summary.json',JSON.stringify(summary)+'\n');fs.writeFileSync(dest+'/review-input-map.json',JSON.stringify({profile,sources:[...inputs.values()],files:closure})+'\n');fs.writeFileSync(HB+'/scan-root.txt',dest+'\n');console.log(JSON.stringify({status:summary.status,sourceFiles:inputs.size,partitions:results.length,findings:results.reduce((s,x)=>s+(x.findings??0),0),dest}));
