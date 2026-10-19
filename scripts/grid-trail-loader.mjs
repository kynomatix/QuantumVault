// Node 24's built-in TypeScript erasure, with repository extensionless import resolution.
// Optional vendor root contains only integrity-checked, locked pure-JS dependencies.
import {registerHooks,createRequire,isBuiltin} from 'node:module';
import {existsSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const vendor=process.env.GRID_TRAIL_VENDOR;
const requireVendor=vendor?createRequire(pathToFileURL(resolve(vendor,'package.json'))):null;
registerHooks({resolve(specifier,context,next){
  if(requireVendor&&!isBuiltin(specifier)&&!specifier.startsWith('.')&&!specifier.startsWith('/')&&!specifier.includes(':')){
    return next(pathToFileURL(requireVendor.resolve(specifier)).href,context);
  }
  if(specifier.startsWith('.')&&context.parentURL){
    const url=new URL(specifier,context.parentURL),path=fileURLToPath(url);
    if(!existsSync(path))for(const candidate of [path+'.ts',path.replace(/\.js$/,'.ts')])if(existsSync(candidate))return next(pathToFileURL(candidate).href,context);
  }
  return next(specifier,context);
}});
