import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const hb=path.resolve('../grid-long-adx-20261022-handback');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const {scratch}=read(hb+'/tip.json');
const root=fs.readFileSync(hb+'/study-root.txt','utf8').trim();
const focused=fs.readFileSync(hb+'/focused-root.txt','utf8').trim();
const intent=read(focused+'/intent.json'),result=read(focused+'/result.json');
if(result.result?.passed!==28||result.result?.failed!==0||result.result?.skipped!==0||result.result?.exitCode!==0||result.sshExit!==0||result.localExit!==0)throw Error('Focused runner evidence did not pass');
const git=args=>execFileSync('git.exe',args,{cwd:scratch,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const bindings=[];
for(const item of intent.bindings){
 const bytes=fs.readFileSync(item.file);
 const tested=execFileSync('git.exe',['show',intent.tipCommitHash+':'+item.file],{cwd:scratch,stdio:['ignore','pipe','pipe']});
 const exactBytes=bytes.equals(tested),inherited=item.file.includes('/grid-ranging-pairs/');
 if(!exactBytes&&(!inherited||!Buffer.from(bytes.toString('utf8').replaceAll('\r\n','\n')).equals(tested)))throw Error('Tested source differs: '+item.file);
 if(git(['rev-parse',intent.tipCommitHash+':'+item.file])!==item.blobHash)throw Error('Tested source blob differs');
 bindings.push({...item,sha256:createHash('sha256').update(bytes).digest('hex'),exactBytes,lineEndingNormalization:!exactBytes});
}
const completion=read(root+'/completion.json'),reconciliation=read(root+'/estimator-reconciliation.json');
if(completion.cellCount!==720||!reconciliation.passed)throw Error('Incomplete verified results');
const expected=1+720*26*2*7;
const csvRows=fs.readFileSync(hb+'/LONG-ADX-ALL-CELLS.csv','utf8').trimEnd().split('\n').length;
if(csvRows!==expected)throw Error('Missing CSV rows');
const record={testedCommitHash:intent.tipCommitHash,bindings,focusedResult:result,cellCount:completion.cellCount,csvRows,estimatorReconciliation:reconciliation,passed:true};
fs.writeFileSync(root+'/delivery-verification.json',JSON.stringify(record)+'\n');
console.log(JSON.stringify({passed:true,testedFiles:bindings.length,csvRows,cellCount:completion.cellCount}));
