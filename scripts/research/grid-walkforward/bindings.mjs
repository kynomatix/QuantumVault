import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
export function researchBindings(work, mapFile){
 const paths=new Set(JSON.parse(fs.readFileSync(mapFile,'utf8')).files.map(p=>path.resolve(p)));
 // These hooks execute before the recording hook is registered.
 for(const file of ['server/grid-bot/policy-hmac.ts','scripts/grid-trail-loader.mjs','scripts/research/grid-direction/loader.mjs','scripts/research/grid-direction/proxy-policy.mjs','scripts/research/grid-backtest-r2/loader.mjs','scripts/research/grid-backtest-r2/adapter.mjs','scripts/research/grid-defaults/design.mjs','scripts/research/grid-finder/loader.mjs','scripts/research/grid-finder/source.mjs'])paths.add(path.resolve(work,file));
 for(const file of fs.readdirSync(path.join(work,'scripts/research/grid-walkforward')).filter(n=>n.endsWith('.mjs')))paths.add(path.resolve(work,'scripts/research/grid-walkforward',file));
 paths.add(path.resolve(mapFile));
 return [...paths].sort().map(file=>{const b=fs.readFileSync(file);return {file,sha256:createHash('sha256').update(b).digest('hex'),bytes:b.length};});
}
