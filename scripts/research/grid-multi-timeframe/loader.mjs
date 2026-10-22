import '../grid-walkforward/loader.mjs';
import {registerHooks} from 'node:module';import {readFileSync} from 'node:fs';
import {adaptLookback,adaptReplay} from './core.mjs';
registerHooks({load(url,context,next){
 if(url.endsWith('/shared/grid-lookback.ts'))return {format:'module-typescript',source:adaptLookback(readFileSync(new URL(url),'utf8')),shortCircuit:true};
 if(url.endsWith('/scripts/research/grid-sizing-stops/replay.mjs'))return {format:'module',source:adaptReplay(readFileSync(new URL(url),'utf8')),shortCircuit:true};
 return next(url,context);
}});
