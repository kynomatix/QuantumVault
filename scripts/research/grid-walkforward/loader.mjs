import '../grid-finder/loader.mjs';
import {registerHooks} from 'node:module';import {readFileSync} from 'node:fs';
import {extractCanonicalPolicy} from './pure-policy.mjs';
registerHooks({load(url,context,next){
 if(url.endsWith('/server/grid-bot/policy-hmac.ts'))return {format:'module-typescript',source:extractCanonicalPolicy(readFileSync(new URL(url),'utf8')),shortCircuit:true};
 return next(url,context);
}});
