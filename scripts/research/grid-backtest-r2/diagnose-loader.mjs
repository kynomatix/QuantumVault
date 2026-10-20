import '../grid-defaults/loader.mjs';
import {registerHooks} from 'node:module';
registerHooks({load(url,context,next) {
  const result=next(url,context);
  if(url.endsWith('/server/grid-bot/trail-backtest.ts')) {
    const text=String(result.source),needle="if(!canonicalGridPolicy(policy))throw Error('Generated research policy is not canonical');";
    if(text.split(needle).length!==2)throw Error('Diagnostic boundary changed');
    return {...result,source:text.replace(needle,"globalThis.__r2DiagnosticPolicy=policy;"+needle)};
  }
  return result;
}});
