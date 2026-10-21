import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {spawnSync} from 'node:child_process';
const HB='C:/Apps/Replit/conductor-worktrees/grid-sizing-stops-20261021-handback',source=path.resolve('scripts/research/grid-sizing-stops');
const hash=b=>createHash('sha256').update(b).digest('hex');
const runs=[];
for(const dir of fs.readdirSync(path.join(HB,'evidence'),{withFileTypes:true}).filter(d=>d.isDirectory()&&d.name.startsWith('focused-'))){
 const file=path.join(HB,'evidence',dir.name,'fractal.log');if(!fs.existsSync(file))continue;
 const bytes=fs.readFileSync(file);let text=bytes.toString('utf8');if(bytes[0]===255&&bytes[1]===254)text=bytes.toString('utf16le');
 const line=text.split(/\r?\n/).find(l=>l.startsWith('STDOUT: {'));if(!line)throw Error('Missing runner receipt');const receipt=JSON.parse(line.slice(8));
 const utf8Path=path.join(HB,'evidence',dir.name,'fractal.utf8.log');fs.writeFileSync(utf8Path,text.replace(/^\uFEFF/,''),'utf8');
 runs.push({commitHash:receipt.sha,host:receipt.host,passed:receipt.passed,failed:receipt.failed,skipped:receipt.skipped,exitCode:receipt.exitCode,kind:receipt.kind,state:receipt.state,runId:receipt.runId,receiptPath:file,receiptSha256:hash(bytes),utf8ReceiptPath:utf8Path,utf8ReceiptSha256:hash(fs.readFileSync(utf8Path)),bundleSha256:receipt.bundleSha256,argv:receipt.request.argv,cleanup:receipt.cleanup});
}
const checks=[];
for(const file of fs.readdirSync(source).filter(n=>n.endsWith('.mjs'))){const r=spawnSync(process.execPath,['--check',path.join(source,file)],{encoding:'utf8',windowsHide:true});if(r.error)throw r.error;checks.push({file:path.join(source,file),passed:r.status===0});if(r.status!==0)throw Error(r.stderr);}
const current=fs.readFileSync(path.join(source,'replay.mjs')),generated=spawnSync(process.execPath,[path.join(source,'extend-replay.mjs')],{encoding:'utf8',windowsHide:true});if(generated.error)throw generated.error;
if(generated.status!==0||!current.equals(fs.readFileSync(path.join(source,'replay.mjs'))))throw Error('Generated replay differs from its mechanical source extension');
const diff=spawnSync('git',['diff','--name-only','HEAD'],{encoding:'utf8',windowsHide:true});if(diff.error)throw diff.error;if(diff.status!==0||diff.stdout.trim())throw Error('Unexpected tracked-file modifications');
const deliveryFile=path.join(HB,'DELIVERY-MANIFEST.json'),delivery=fs.existsSync(deliveryFile)?JSON.parse(fs.readFileSync(deliveryFile,'utf8')):null;
const review={status:runs.at(-1)?.failed===0?'focused-tests-pass':'test-blocked',runs,syntaxChecks:checks,generatedReplaySha256:hash(current),trackedProductionChanges:0,independentReview:false,deliveryCommitHash:delivery?.tipHash??null,latestRunMatchesDelivery:delivery?runs.at(-1)?.commitHash===delivery.tipHash:null};
fs.writeFileSync(path.join(HB,'validation.json'),JSON.stringify(review,null,2)+'\n');
const lines=['# Validation and review','', 'TEST REQUEST (owner): focused. TEST-RISK: REQUIRED. TEST-DEFECT: REQUIRED for the two failed fixture attempts. All product tests ran on FRACTAL through bundle-v1, without pushing or resetting the shared database. No local Vitest, npx, WSL, browser or capture command was used.', '',
'| Commit hash | Host | Passed | Failed | Skipped | Scope |','|---|---|---:|---:|---:|---|'];
for(const r of runs)lines.push(`| ${r.commitHash} | ${r.host} | ${r.passed} | ${r.failed} | ${r.skipped} | ${r.argv.join(', ')} |`);
lines.push('','The first fixture omitted the planner transferFloor and complete policy metadata; the second fixed transferFloor but still lacked the metadata needed by retainedGridCycles. The third supplied the complete product-planned policy and passed. The research policy wrapper already supplied both inputs; those fixture corrections did not change simulated outcomes. The first request also named a nonexistent funding test; subsequent requests use the actual hourly-funding test file.', '',
`Static syntax checks passed for ${checks.length} research modules. The generated replay exactly matches the mechanical extension of the inherited round-2 source. No tracked production file differs from the research base.`, '',
'Static review checked: actual product sizing and minimum lifting; matching admission across stop variants; actual funding timestamps and complete horizon coverage; trade-price terminal executions; liquidation priority; inclusion of every admitted loss; same frozen range on re-entry; full-bar cooldown and original horizon; cumulative fees, funding, drawdown and underwater duration; unique path counting; paired comparisons and calendar blocks; development-only selection and explicit survivor/mark-proxy caveats.', '',
'This was self-review, not independent Opus review or conductor pre-freeze/gate evidence. The separate snapshot scan uses the reviewer’s unchanged read-only scanner. Funding gaps, sparse launch slots, current venue constraints, full-fill hourly paths, finite history and survivor-only OKX data limit generalization.', '',
'All raw runner receipts and their SHA-256 hashes are indexed in [validation.json](./validation.json). Test receipts identify the tested commit; final source equivalence is recorded separately in the delivery manifest.','');
fs.writeFileSync(path.join(HB,'VALIDATION.md'),lines.join('\n'));
console.log(JSON.stringify({testRuns:runs.length,latest:runs.at(-1),syntaxModules:checks.length}));
