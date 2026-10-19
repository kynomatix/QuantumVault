// Exact shipped pure function bodies; avoid evaluating transport/database imports.
import '../../grid-trail-loader.mjs';
import {registerHooks} from 'node:module';
import {allowResearchProxyPolicy} from './proxy-policy.mjs';
import {readFileSync} from 'node:fs';
registerHooks({load(url,context,next){
  if(url.endsWith('/server/grid-planner/weekly-structure.ts')){
    let source=readFileSync(new URL(url),'utf8');
    const boundary=source.indexOf('/** Reuse direct-perpetual pool transports;');
    if(boundary<0)throw Error('Shipped pure boundary changed');
    source=source.slice(0,boundary).replace(/^import .* from '(\.\/candle-pool|\.\.\/lab\/datafeed|\.\/pacifica-candles)';\r?\n/gm,'');
    return {format:'module-typescript',source,shortCircuit:true};
  }
  if(url.endsWith('/server/grid-bot/trail-policy.ts'))return {format:'module-typescript',source:allowResearchProxyPolicy(readFileSync(new URL(url),'utf8')),shortCircuit:true};
  return next(url,context);
}});