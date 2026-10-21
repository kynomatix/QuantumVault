import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';import {HB,ROOT,hash,read} from './io.mjs';
const targetCommitHash=process.argv[2];if(!/^[a-f0-9]{40}$/.test(targetCommitHash||''))throw Error('Target commit hash required');
const reviewerPath='C:/Apps/Replit/qv-orchestrator/qv-opus-read-reviewer.mjs',scannerPath=path.resolve('scripts/qv-secrets-scan.mjs');const {canonicalJson,scanInputManifest}=await import(pathToFileURL(reviewerPath).href);
const destination=HB+'/evidence/readonly-review-'+new Date().toISOString().replace(/[-:.]/g,'');fs.mkdirSync(destination);const sourceRoot=destination+'/inputs';fs.mkdirSync(sourceRoot);const paths=new Map();function bind(p,purpose='evidence'){p=path.resolve(p);if(fs.statSync(p).isFile())paths.set(p,purpose)}
if(process.argv.includes('--receipt')){bind(HB+'/FOCUSED-RUN.utf8.log');}else{
 for(const name of fs.readdirSync(ROOT))bind(ROOT+'/'+name);
 for(const name of fs.readdirSync('scripts/research/grid-ranging-pairs'))bind('scripts/research/grid-ranging-pairs/'+name,'source');
 bind('tests/research/grid-ranging-pairs.test.ts','source');bind('scripts/research/grid-walkforward/funding-coverage.mjs','source');
 for(const row of read(ROOT+'/screen.json'))if(row.inherited)for(const key of ['priceFile','fundingFile'])bind(row.inherited[key]);
 for(const name of fs.readdirSync(HB))if(fs.statSync(HB+'/'+name).isFile()&&!name.endsWith('.bundle')&&!['RESUME.md','REVIEW-SCAN-STATUS.md'].includes(name))bind(HB+'/'+name);
 bind(reviewerPath,'source');bind(scannerPath,'source');
}
const files=[];let i=0;for(const [originalPath,purpose]of paths){const bytes=fs.readFileSync(originalPath),copyPath=sourceRoot+'/'+String(i++).padStart(5,'0')+'-'+path.basename(originalPath);fs.writeFileSync(copyPath,bytes);files.push({originalPath,copyPath,purpose,bytes:bytes.length,sha256:hash(bytes).toUpperCase()});}
const profile={mode:'readonly',independentReview:false},body={schemaVersion:1,unitId:'research/grid-ranging-pairs',targetSha:targetCommitHash,targetCommitHash,contractDigest:hash(fs.readFileSync('scripts/research/grid-ranging-pairs/PREREGISTRATION.md')).toUpperCase(),profileSha256:hash(Buffer.from(canonicalJson(profile))).toUpperCase(),sourceRoot,files};const manifest={...body,manifestSha256:hash(Buffer.from(canonicalJson(body))).toUpperCase()};fs.writeFileSync(destination+'/review-input-map.json',JSON.stringify(manifest,null,2)+'\n');let summary;
try{const evidence=await scanInputManifest(manifest,scannerPath);fs.writeFileSync(destination+'/scan.json',JSON.stringify(evidence,null,2)+'\n');summary={status:'zero-findings',files:files.length,findingCount:evidence.rawFindingCount??0};}catch(error){fs.writeFileSync(destination+'/scan.json',JSON.stringify(error.scanEvidence??{reason:error.message},null,2)+'\n');summary={status:'UNSEALED',files:files.length,reason:error.code??error.message,findingCount:error.scanEvidence?.rawReport?.findingCount??null};}
fs.writeFileSync(destination+'/summary.json',JSON.stringify(summary,null,2)+'\n');fs.writeFileSync(HB+'/review-snapshot-path.txt',destination+'\n');console.log(JSON.stringify({...summary,destination}));
