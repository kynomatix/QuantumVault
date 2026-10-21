import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {spawnSync} from 'node:child_process';
const HB='C:/Apps/Replit/conductor-worktrees/grid-sizing-stops-20261021-handback',work=process.cwd().replaceAll('\\','/');
const baseHash='083ea0ac0569fb40397a53ba03731ea7da365552',originMainHash='8a7e0d778ba646572fd443f288e3ee04a2ae4288';
const root=path.join(HB,'evidence','delivery-'+new Date().toISOString().replace(/[-:.]/g,'')).replaceAll('\\','/');
const q=s=>"'"+s.replaceAll("'","'\\''")+"'",hash=b=>createHash('sha256').update(b).digest('hex');
const r=spawnSync('C:/Program Files/Git/bin/bash.exe',['-lc',`bash ${q(work+'/scripts/research/grid-sizing-stops/bundle.sh')} ${q(work)} ${q(root)} ${baseHash} ${originMainHash}`],{encoding:'utf8',windowsHide:true});
if(r.error)throw r.error;if(r.status!==0)throw Error(r.stderr);
const git=(...args)=>{const x=spawnSync('git',['-C',root+'/repo',...args],{encoding:'utf8',windowsHide:true});if(x.error)throw x.error;if(x.status!==0)throw Error(x.stderr);return x.stdout.trim();};
const tipHash=git('rev-parse','HEAD');if(!/^[a-f0-9]{40}$/.test(tipHash))throw Error('Explicit commit hash required');
const bundle='SIZING-STOPS.bundle';fs.copyFileSync(root+'/probe.bundle',path.join(HB,bundle));
const bundleBytes=fs.statSync(path.join(HB,bundle)).size;if(bundleBytes>=1000000)throw Error('Thin bundle exceeds runner-safe size');
const files=git('diff','--name-only',baseHash,tipHash).split('\n').map(file=>({path:file,blobHash:git('rev-parse',tipHash+':'+file),sha256:hash(fs.readFileSync(path.join(work,file)))}));
if(files.some(f=>!f.path.startsWith('scripts/research/grid-sizing-stops/')&&f.path!=='tests/research/grid-sizing-stops.test.ts'))throw Error('Nonresearch diff');
const manifest={worktree:work,branch:'feat/grid-sizing-stops',baseHash,originMainHash,tipHash,bundle,bundleBytes,bundleSha256:hash(fs.readFileSync(path.join(HB,bundle))),files,scratchRoot:root,createdAt:new Date().toISOString()};
fs.writeFileSync(path.join(HB,'DELIVERY-MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n');
fs.writeFileSync(path.join(HB,'delivery-root.txt'),root+'\n');
const installer=String.raw`$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$target = 'C:\Apps\Replit\conductor-worktrees\grid-sizing-stops-20261021'
$expectedBranch = 'feat/grid-sizing-stops'
$delivery = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'DELIVERY-MANIFEST.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$bundle = Join-Path $PSScriptRoot $delivery.bundle
if ((Resolve-Path -LiteralPath $target).Path.Replace('\','/') -ne $delivery.worktree -or $delivery.branch -ne $expectedBranch) { throw 'Wrong sizing/stops worktree or branch' }
if ((Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash.ToLowerInvariant() -ne $delivery.bundleSha256) { throw 'Bundle SHA-256 mismatch' }
function GitChecked([string[]]$Arguments) {
    $result = & git -C $target @Arguments
    if ($LASTEXITCODE -ne 0) { throw ('Git failed: ' + ($Arguments -join ' ')) }
    return $result
}
$branch = (GitChecked @('branch', '--show-current')).Trim()
if ($branch -ne $expectedBranch) { throw 'Wrong branch; never install on main' }
$headHash = (GitChecked @('rev-parse', '--verify', 'HEAD')).Trim()
if ($headHash -ne $delivery.baseHash -and $headHash -ne $delivery.tipHash) { throw 'Unexpected HEAD; preserve the other revision' }
if (@(GitChecked @('diff', '--cached', '--name-only')).Count) { throw 'Staged work must be preserved' }
foreach ($file in $delivery.files) {
    if ($file.path -notmatch '^(scripts/research/grid-sizing-stops/[A-Za-z0-9_.-]+|tests/research/grid-sizing-stops\.test\.ts)$') { throw 'Unexpected candidate path' }
    $candidate = Join-Path $target $file.path
    if (Test-Path -LiteralPath $candidate) {
        if ((Get-Item -LiteralPath $candidate).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Candidate must not be an alias' }
        $blobHash = (GitChecked @('hash-object', ('--path=' + $file.path), '--', $candidate)).Trim()
        if ($blobHash -ne $file.blobHash) { throw ('Existing research file differs: ' + $file.path) }
    } elseif ($headHash -eq $delivery.tipHash) { throw 'Installed research file is missing' }
}
if ($headHash -eq $delivery.tipHash) { Write-Output 'Sizing/stops research is already installed and verified.'; exit 0 }
GitChecked @('bundle', 'verify', $bundle) | Out-Null
GitChecked @('fetch', '--no-tags', '--no-write-fetch-head', $bundle, 'refs/heads/qv-probe-tip') | Out-Null
GitChecked @('merge-base', '--is-ancestor', $delivery.baseHash, $delivery.tipHash) | Out-Null
$actual = @(GitChecked @('diff', '--name-only', $delivery.baseHash, $delivery.tipHash))
if (@(Compare-Object ($delivery.files.path | Sort-Object) ($actual | Sort-Object)).Count) { throw 'Bundle path inventory mismatch' }
foreach ($file in $delivery.files) {
    $blobHash = (GitChecked @('rev-parse', ($delivery.tipHash + ':' + $file.path))).Trim()
    if ($blobHash -ne $file.blobHash) { throw 'Bundle tree differs from delivery manifest' }
}
GitChecked (@('restore', '--source', $delivery.tipHash, '--staged', '--worktree', '--') + @($delivery.files.path)) | Out-Null
GitChecked @('update-ref', ('refs/heads/' + $expectedBranch), $delivery.tipHash, $delivery.baseHash) | Out-Null
GitChecked (@('diff', '--exit-code', $delivery.tipHash, '--') + @($delivery.files.path)) | Out-Null
GitChecked @('diff', '--cached', '--exit-code', $delivery.tipHash) | Out-Null
if ((GitChecked @('rev-parse', 'HEAD')).Trim() -ne $delivery.tipHash) { throw 'Install HEAD verification failed' }
Write-Output ('Installed research commitHash: ' + $delivery.tipHash + ' on ' + $branch)
`;
fs.writeFileSync(path.join(HB,'INSTALL-SIZING-STOPS.ps1'),installer);
console.log(JSON.stringify({tipHash,bundleBytes,files:files.length,root}));
