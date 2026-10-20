// Read-only arithmetic and evidence-binding checks; no product test execution.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=process.argv[2],results=[];
const assert=(condition,message)=>{if(!condition)throw Error(message);};
for(const file of ['phase-b-registered-summary.json','phase-c-lines-registered-summary.json','phase-c-movement-summary.json','phase-c-risk-summary.json','phase-d-summary.json']){
 const s=JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
 const admitted=s.summaries.filter(r=>r.dimension==='all').reduce((n,r)=>n+r.n,0),rejected=s.rejections.reduce((n,r)=>n+r.count,0);
 assert(admitted===s.admitted&&admitted+rejected===s.total,`Admission arithmetic: ${file}`);
 assert(s.summaries.every(r=>Number.isFinite(r.netReturn)&&Number.isFinite(r.maxDrawdown)&&r.n>0),`Nonfinite admitted result: ${file}`);
 const years=[...new Set(s.summaries.filter(r=>r.dimension==='year').map(r=>Number(r.value)))].sort();
 assert([2022,2023,2024,2025,2026].every(y=>years.includes(y)),`Year missing: ${file}`);
 results.push({file,admitted,rejected,total:s.total,years});
}
const bindings=[];
for(const name of fs.readdirSync(root).filter(n=>/-complete\.json$/.test(n))){
 const meta=JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));
 if(!meta.runsSha256)continue;
 const file=name.replace('-complete.json','.jsonl'),digest=createHash('sha256');
 for await(const chunk of fs.createReadStream(path.join(root,file)))digest.update(chunk);
 const runsSha256=digest.digest('hex');
 assert(runsSha256.toLowerCase()===meta.runsSha256.toLowerCase(),`Raw evidence changed: ${file}`);
 bindings.push({file,runsSha256});
}
const diagnostics=JSON.parse(fs.readFileSync(path.join(root,'phase-c-lines-diagnostics-corrected.json'),'utf8')).diagnostics;
for(const d of diagnostics){
 const m=d.minimumOnly;if(!m)continue;
 assert(m.rejected===m.minimumRejected+m.otherRejected&&m.rejected<=m.attempts,`Minimum diagnostic arithmetic: ${d.setting}`);
 assert(Object.values(m.reasons).reduce((n,v)=>n+v,0)===m.rejected,`Minimum rejection inventory: ${d.setting}`);
}
const receipts=JSON.parse(fs.readFileSync(path.join(root,'test-run-inventory.json'),'utf8')).runs;
assert(receipts.length===18,'Missing retained FRACTAL receipt');
fs.writeFileSync(path.join(root,'final-integrity-audit.json'),JSON.stringify({createdAt:new Date().toISOString(),kind:'read-only static evidence audit',results,bindings,minimumDiagnostics:diagnostics.length,retainedRunnerReceipts:receipts.length},null,2)+'\n');
console.log(`Integrity verified: ${results.length} phase summaries, ${bindings.length} raw evidence bindings, ${diagnostics.length} minimum diagnostics, ${receipts.length} runner receipts.`);
