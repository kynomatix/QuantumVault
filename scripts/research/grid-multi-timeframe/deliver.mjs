import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
const hb=path.resolve('../grid-multi-timeframe-20261022-handback'),baseCommitHash='4eac0f17c072d35c13d5d8b954199b64490feabf',hash=b=>createHash('sha256').update(b).digest('hex');
const call=(exe,args,cwd=process.cwd())=>execFileSync(exe,args,{cwd,windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim(),git=(args,cwd)=>call('git.exe',args,cwd);
const deliverables=['MULTI-TIMEFRAME-REPORT.md','OWNER-NOTE.md','REVIEW.md','LESSONS.md','COMPARISONS.csv','QUARTERS.csv','RETENTION.csv','PAIR-FREQUENCIES.csv'];
for(const name of deliverables)fs.copyFileSync(hb+'/'+name,'scripts/research/grid-multi-timeframe/'+name);
call(process.execPath,['scripts/research/grid-multi-timeframe/commit.mjs','research: deliver registered multi-timeframe grid study']);
const {tipCommitHash,scratch}=JSON.parse(fs.readFileSync(hb+'/tip.json','utf8'));
const changed=git(['diff','--name-only',baseCommitHash,tipCommitHash],scratch).split('\n').filter(Boolean);
if(changed.some(p=>!p.startsWith('scripts/research/grid-multi-timeframe/')&&p!=='tests/research/grid-multi-timeframe.test.ts'))throw Error('Out-of-scope delivery diff');
const registrationCommitHash=JSON.parse(fs.readFileSync(fs.readFileSync(hb+'/study-root.txt','utf8').trim()+'/registration.json','utf8')).preregistrationCommitHash;
git(['merge-base','--is-ancestor',registrationCommitHash,tipCommitHash],scratch);
git(['update-ref','refs/heads/mtf-delivery',tipCommitHash],scratch);const bundle=hb+'/multi-timeframe.bundle';
git(['bundle','create',bundle,'refs/heads/mtf-delivery','--not',baseCommitHash],scratch);git(['bundle','verify',bundle],scratch);
const sourceFiles=changed.map(file=>{const bytes=execFileSync('git.exe',['show',tipCommitHash+':'+file],{cwd:scratch,windowsHide:true,stdio:['ignore','pipe','pipe'],maxBuffer:32*1024*1024});if(!bytes.equals(fs.readFileSync(file)))throw Error('Working research bytes differ from commit: '+file);return {file,sha256:hash(bytes),bytes:bytes.length,blobHash:git(['rev-parse',tipCommitHash+':'+file],scratch)};});
const installer=`#!/usr/bin/env bash
set -euo pipefail
target=$1
bundle=$2
tip=$3
base=$4
cd "$target"
test "$(git branch --show-current)" = feat/grid-multi-timeframe
current=$(git rev-parse HEAD)
test "$current" = "$base" || test "$current" = "$tip"
git bundle verify "$bundle"
git fetch --no-tags "$bundle" refs/heads/mtf-delivery:refs/remotes/mtf-handback/tip
test "$(git rev-parse refs/remotes/mtf-handback/tip)" = "$tip"
in_scope(){ case "$1" in scripts/research/grid-multi-timeframe/*|tests/research/grid-multi-timeframe.test.ts) return 0;; *) return 1;; esac; }
mapfile -t files < <(git diff-tree --no-commit-id --name-only -r "$base" "$tip")
# Unrelated tracked work is not overwritten. Identical delivery edits may be staged or unstaged.
while IFS= read -r file; do
  test -z "$file" && continue
  in_scope "$file" || { echo 'Unrelated tracked edits present'; exit 1; }
done < <(git diff --name-only HEAD)
while IFS= read -r file; do
  test -z "$file" && continue
  in_scope "$file" || { echo 'Unrelated staged edits present'; exit 1; }
  git show ":$file" | cmp - <(git show "$tip:$file")
done < <(git diff --cached --name-only)
for file in "\${files[@]}"; do
  in_scope "$file" || { echo 'Out-of-scope delivery'; exit 1; }
  if test -e "$file"; then git show "$tip:$file" | cmp - "$file"; fi
done
for file in "\${files[@]}"; do
  if ! test -e "$file"; then mkdir -p "$(dirname "$file")"; git show "$tip:$file" > "$file"; fi
  git show "$tip:$file" | cmp - "$file"
done
git reset --mixed "$tip"
git diff --quiet
echo 'Multi-timeframe research commit installed; no push or merge performed.'
`;
fs.writeFileSync(hb+'/install-mtf.sh',installer);
fs.writeFileSync(hb+'/INSTALL-MTF.ps1',`param([string]$Target='C:\\Apps\\Replit\\conductor-worktrees\\grid-multi-timeframe-20261022')
$ErrorActionPreference='Stop'
$manifest=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'DELIVERY-MANIFEST.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$bundle=Join-Path $PSScriptRoot 'multi-timeframe.bundle'
if((Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.bundleSha256){throw 'Bundle SHA-256 mismatch'}
& 'C:\\Program Files\\Git\\bin\\bash.exe' -lc 'bash "$1" "$2" "$3" "$4" "$5"' install (Join-Path $PSScriptRoot 'install-mtf.sh') $Target $bundle $manifest.tipCommitHash $manifest.baseCommitHash
if($LASTEXITCODE -ne 0){throw 'Research installer refused or failed'}
`);
const manifest={baseCommitHash,preregistrationCommitHash:registrationCommitHash,tipCommitHash,branch:'feat/grid-multi-timeframe',bundleSha256:hash(fs.readFileSync(bundle)),bundleBytes:fs.statSync(bundle).size,sourceFiles,artifacts:deliverables.map(file=>({file,sha256:hash(fs.readFileSync(hb+'/'+file)),bytes:fs.statSync(hb+'/'+file).size})),installerFiles:['INSTALL-MTF.ps1','install-mtf.sh'].map(file=>({file,sha256:hash(fs.readFileSync(hb+'/'+file))}))};
fs.writeFileSync(hb+'/DELIVERY-MANIFEST.json',JSON.stringify(manifest)+'\n');
const rehearsal=hb+'/evidence/install-'+new Date().toISOString().replace(/[-:.]/g,'');if(fs.existsSync(rehearsal))throw Error('Rehearsal root exists');
git(['clone','--shared','--no-checkout',scratch,rehearsal]);git(['checkout','-b','feat/grid-multi-timeframe',baseCommitHash],rehearsal);git(['config','core.autocrlf','true'],rehearsal);
for(const {file}of sourceFiles){const target=path.join(rehearsal,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(file,target);}git(['add','--',sourceFiles[0].file],rehearsal);
const args=['-NoProfile','-ExecutionPolicy','Bypass','-File',hb+'/INSTALL-MTF.ps1','-Target',rehearsal];
const first=call('powershell.exe',args),second=call('powershell.exe',args),labelHashes=text=>text.split(/\r?\n/).map(line=>/\b[a-f0-9]{40}\b/i.test(line)?'Git commit hash output: '+line:line).join('\n');fs.writeFileSync(hb+'/installer-rehearsal.utf8.log',labelHashes(first)+'\n'+labelHashes(second)+'\n');
if(git(['rev-parse','HEAD'],rehearsal)!==tipCommitHash)throw Error('Rehearsal tip differs');
for(const {file,sha256}of sourceFiles)if(hash(fs.readFileSync(path.join(rehearsal,file)))!==sha256)throw Error('Installed bytes differ');
const verification={tipCommitHash,bundleVerified:true,preregistrationAncestor:true,scopeVerified:true,sourceBytesVerified:true,installerRehearsal:rehearsal,coreAutocrlf:true,identicalUntrackedEditsAccepted:true,identicalStagedEditAccepted:true,idempotentInstall:true,sourceFiles:sourceFiles.length};fs.writeFileSync(hb+'/DELIVERY-VERIFICATION.json',JSON.stringify(verification)+'\n');console.log(JSON.stringify({tipCommitHash,bundleBytes:manifest.bundleBytes,sourceFiles:sourceFiles.length,installerVerified:true}));
