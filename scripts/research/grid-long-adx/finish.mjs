import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const hb=path.resolve('../grid-long-adx-20261022-handback');
const root=fs.readFileSync(hb+'/study-root.txt','utf8').trim();
// Event-driven completion, without a timer or state polling loop.
if(!fs.existsSync(root+'/completion.json'))await new Promise((resolve,reject)=>{
 const watcher=fs.watch(root,(_event,name)=>{if(String(name)==='completion.json'&&fs.existsSync(root+'/completion.json')){watcher.close();resolve();}});
 watcher.on('error',reject);
 if(fs.existsSync(root+'/completion.json')){watcher.close();resolve();}
});
const operation=hb+'/evidence/delivery-operation-'+new Date().toISOString().replace(/[-:.]/g,'');fs.mkdirSync(operation);
function run(name,command,args,cwd=process.cwd()){
 const log=fs.openSync(operation+'/'+name+'.utf8.log','wx');
 const result=spawnSync(command,args,{cwd,windowsHide:true,stdio:['ignore',log,log]});fs.closeSync(log);
 if(result.error)throw result.error;
 if(result.status!==0)throw Error(name+' failed; retained UTF-8 log at '+operation);
}
for(const name of ['reconcile','report','verify-delivery'])run(name,process.execPath,['scripts/research/grid-long-adx/'+name+'.mjs']);
for(const name of ['REVIEW.md','LESSONS.md','OWNER-TEST-REQUEST.md'])fs.copyFileSync(hb+'/'+name,'scripts/research/grid-long-adx/'+name);
run('commit',process.execPath,['scripts/research/grid-long-adx/prepare-delivery.mjs','research: report preregistered long ADX and squeeze results']);
run('bundle',process.execPath,['scripts/research/grid-long-adx/deliver.mjs']);
const manifest=JSON.parse(fs.readFileSync(hb+'/DELIVERY-MANIFEST.json','utf8'));
const {scratch}=JSON.parse(fs.readFileSync(hb+'/tip.json','utf8'));
const target=operation+'/installer-check';
run('clone','git.exe',['clone','--shared','--no-checkout',scratch,target]);
run('checkout','git.exe',['checkout','-b','feat/grid-long-adx',manifest.baseCommitHash],target);
run('installer','powershell.exe',['-NoProfile','-File',hb+'/INSTALL-LONG-ADX.ps1','-Target',target]);
const verification={tipCommitHash:manifest.tipCommitHash,baseCommitHash:manifest.baseCommitHash,bundleSha256:manifest.bundleSha256,target,passed:true,scope:'fresh clone, exact git-show/cmp bytes, dispatched branch, no merge or push'};
fs.writeFileSync(hb+'/INSTALLER-VERIFICATION.json',JSON.stringify(verification)+'\n');
run('scan',process.execPath,['scripts/research/grid-long-adx/scan.mjs']);
fs.writeFileSync(hb+'/delivery-operation-root.txt',operation+'\n');
console.log(JSON.stringify({operation,tipCommitHash:manifest.tipCommitHash,installerVerified:true,complete:true}));
