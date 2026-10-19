import '../grid-direction/loader.mjs';
import {registerHooks} from 'node:module';
import {readFileSync} from 'node:fs';
import {parameterizeIntervals} from './design.mjs';
registerHooks({load(url,context,next){
  if(url.endsWith('/server/grid-bot/trail-backtest.ts'))return {format:'module-typescript',source:parameterizeIntervals(readFileSync(new URL(url),'utf8')),shortCircuit:true};
  return next(url,context);
}});
