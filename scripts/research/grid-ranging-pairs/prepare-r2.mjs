import fs from 'node:fs';import path from 'node:path';
import {ROOT,HB,read,bound,hash} from './io.mjs';
import {selections} from './design.mjs';
const frozen=bound(ROOT+'/frozen-snapshot-r2.json',read(ROOT+'/frozen-snapshot-r2-sha256.json').snapshotSha256);
if(frozen.summary.certified<24)throw Error('Fewer than 24 certified markets');
for(const f of frozen.files)if(hash(fs.readFileSync(f.file))!==f.sha256)throw Error('Frozen snapshot drift: '+f.file);
const coverage=read(ROOT+'/coverage.json').filter(x=>x.passed);
const selected=selections(coverage.map(x=>({...x,daily:bound(x.dailyFile,x.dailySha256).rows})));
const root=HB+'/evidence/study-r2-'+new Date().toISOString().replace(/[-:.]/g,'');fs.mkdirSync(root);
fs.writeFileSync(root+'/selections.json',JSON.stringify(selected)+'\n',{flag:'wx'});
const sources=[];for(const dir of ['scripts/research/grid-ranging-pairs','scripts/research/grid-sizing-stops','scripts/research/grid-sizing-1b','scripts/research/grid-backtest-r2','scripts/research/grid-defaults','scripts/research/grid-walkforward'])for(const name of fs.readdirSync(dir).filter(x=>x.endsWith('.mjs'))){const file=path.resolve(dir,name);sources.push({file,sha256:hash(fs.readFileSync(file))});}
fs.writeFileSync(root+'/registration.json',JSON.stringify({frozenFile:ROOT+'/frozen-snapshot-r2.json',frozenSha256:hash(fs.readFileSync(ROOT+'/frozen-snapshot-r2.json')),sources,selectionsSha256:hash(fs.readFileSync(root+'/selections.json')),createdAt:new Date().toISOString(),outcomes:0})+'\n',{flag:'wx'});
fs.writeFileSync(HB+'/study-r2-root.txt',root+'\n');console.log(JSON.stringify({root,markets:coverage.length,selectionCells:selected.length,outcomes:0}));