import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
const hb=path.resolve('../grid-long-adx-20261022-handback'),{tipCommitHash,scratch}=JSON.parse(fs.readFileSync(hb+'/tip.json','utf8'));
const baseCommitHash='f04a278b4223755aefde0f92586595fb1c4ff7d1',git=args=>execFileSync('git.exe',args,{cwd:scratch,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
if(git(['rev-parse','HEAD'])!==tipCommitHash)throw Error('Delivery tip mismatch');
const files=git(['diff-tree','--no-commit-id','--name-only','-r',baseCommitHash,tipCommitHash]).split('\n');
for(const file of files)if(!file.startsWith('scripts/research/grid-long-adx/')&&file!=='tests/research/grid-long-adx.test.ts')throw Error('Out-of-scope path: '+file);
const preregistrationCommitHash='91d78346a32b2523839342f2661a9bf8d689671a';
if(git(['rev-parse',preregistrationCommitHash+':scripts/research/grid-long-adx/PREREGISTRATION.md'])!==git(['rev-parse',tipCommitHash+':scripts/research/grid-long-adx/PREREGISTRATION.md']))throw Error('Preregistration changed');
const bundle=hb+'/long-adx.bundle';git(['bundle','create',bundle,'refs/heads/long-adx-delivery','--not',baseCommitHash]);
const verification=git(['bundle','verify',bundle]);
const hash=b=>createHash('sha256').update(b).digest('hex');
const binding=[];for(const file of files){const bytes=fs.readFileSync(file),blob=execFileSync('git.exe',['show',tipCommitHash+':'+file],{cwd:scratch,maxBuffer:64*1024*1024});if(!bytes.equals(blob))throw Error('Working file differs from committed bytes: '+file);binding.push({file,sha256:hash(bytes),bytes:bytes.length});}
const manifest={baseCommitHash,preregistrationCommitHash,tipCommitHash,bundleSha256:hash(fs.readFileSync(bundle)),bundleBytes:fs.statSync(bundle).size,files:binding,verified:true,createdAt:new Date().toISOString()};
fs.writeFileSync(hb+'/DELIVERY-MANIFEST.json',JSON.stringify(manifest,null,2)+'\n');fs.writeFileSync(hb+'/bundle-verification.txt',verification+'\n');
console.log(JSON.stringify({tipCommitHash,bundleSha256:manifest.bundleSha256,bundleBytes:manifest.bundleBytes,files:files.length,verified:true}));
