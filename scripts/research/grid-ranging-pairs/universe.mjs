import fs from 'node:fs';import {HB,ROOT,hash,read,write,json,START,END,DAY,checkpoint} from './io.mjs';
const p=await json('https://api.pacifica.fi/api/v1/info','pacifica-info');write('pacifica-info.json',p);
const o=await json('https://www.okx.com/api/v5/public/instruments?instType=SWAP','okx-instruments');write('okx-instruments.json',o);
const g=await json('https://api.gateio.ws/api/v4/futures/usdt/contracts','gate-contracts');write('gate-contracts.json',g);
write('pacifica-fees.json',await json('https://api.pacifica.fi/api/v1/info/fees','pacifica-fees'));
write('okx-tickers.json',await json('https://www.okx.com/api/v5/market/tickers?instType=SWAP','okx-tickers'));
const linear=o.data.filter(i=>i.state==='live'&&i.ctType==='linear'&&i.settleCcy==='USDT'&&i.instId===i.ctValCcy+'-USDT-SWAP');
const rows=p.data.filter(x=>x.instrument_type==='perpetual').map(m=>{const okx=linear.find(i=>i.ctValCcy===m.base_asset),gate=g.find(i=>i.name===m.base_asset+'_USDT'&&!i.in_delisting&&i.status==='trading');return {symbol:m.symbol,base:m.base_asset,universe:'A',pacifica:m,okx,gate,source:okx?'okx':gate?'gate':null};});
const names=new Set(rows.map(x=>x.base));for(const i of linear.filter(i=>+i.listTime<Date.UTC(2022,0,1)&&+i.listTime>0&&!names.has(i.ctValCcy)))rows.push({symbol:i.ctValCcy,base:i.ctValCcy,universe:'B',source:'okx',okx:i});
for(const r of rows){r.listedAt=r.source==='okx'?+r.okx.listTime:r.source==='gate'?Number(r.gate.launch_time||r.gate.create_time)*1000:null;r.begin=r.listedAt?Math.max(START,Math.ceil(r.listedAt/DAY)*DAY):null;r.historyPossible=r.begin!==null&&r.begin<=Date.UTC(2025,8,1);}
write('candidate-universe.json',rows);write('registration.json',{preregistrationCommitHash:'f7fc916fcebd2c17ac42c348c467d909ec98f2ae',preregistrationSha256:hash(fs.readFileSync('scripts/research/grid-ranging-pairs/PREREGISTRATION.md')),createdAt:new Date().toISOString(),outcomes:0});
checkpoint('Universe captured; coverage not certified',{A:rows.filter(r=>r.universe==='A').length,B:rows.filter(r=>r.universe==='B').length});
console.log(JSON.stringify({A:rows.filter(r=>r.universe==='A').length,B:rows.filter(r=>r.universe==='B').length,source:rows.reduce((a,r)=>(a[r.source||'unmapped']=(a[r.source||'unmapped']||0)+1,a),{}),insufficientHistory:rows.filter(r=>!r.historyPossible).map(r=>r.symbol),feeTiers:read(ROOT+'/pacifica-fees.json').data?.slice?.(0,2)}));
