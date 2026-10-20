import fs from 'node:fs';
import path from 'node:path';
import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=process.argv[2],loaded=new Set();
registerHooks({load(url,context,next){
 if(url.startsWith('file:'))loaded.add(fileURLToPath(url));
 return next(url,context);
}});
for(const specifier of ['./data.mjs','./fixed-replay.mjs','./movement.mjs','./projection.mjs','../grid-direction/core.mjs','../../../server/grid-bot/trail-backtest.ts'])
 await import(specifier);
fs.writeFileSync(path.join(root,'runtime-inputs.json'),JSON.stringify({files:[...loaded].sort(),method:'Actual source/vendor modules loaded through the research hooks; no replay, network request or database connection.'},null,2)+'\n');
console.log(`Bound ${loaded.size} runtime inputs`);
