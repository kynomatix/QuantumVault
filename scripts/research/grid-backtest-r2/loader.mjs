import '../grid-direction/loader.mjs';
import {registerHooks} from 'node:module';
import {readFileSync} from 'node:fs';
import {parameterizeResearch} from './adapter.mjs';
registerHooks({load(url,context,next) {
  if(url.endsWith('/server/grid-bot/trail-backtest.ts'))
    return {format:'module-typescript',source:parameterizeResearch(readFileSync(new URL(url),'utf8')),shortCircuit:true};
  if(url.endsWith('/server/grid-bot/move-policy.ts')){
    const source=readFileSync(new URL(url),'utf8');
    const guard="c.provenance.source==='pacifica'&&c.provenance.venue==='pacifica'&&c.provenance.basis==='perp'&&c.provenance.proxy==='direct'";
    if(!source.includes(guard))throw Error('Research move provenance adapter no longer matches');
    return {format:'module-typescript',source:source.replace(guard,"((c.provenance.source==='pacifica'&&c.provenance.venue==='pacifica')||(c.provenance.source==='okx'&&c.provenance.venue==='okx'))&&c.provenance.proxy==='direct'&&c.provenance.basis==='perp'"),shortCircuit:true};
  }
  return next(url,context);
}});
