export function extractCanonicalPolicy(source){
 const boundary=source.indexOf('export function computeGridPolicyHmac(');
 if(boundary<0||!source.slice(0,boundary).includes('export function canonicalGridPolicy('))throw Error('Canonical policy boundary changed');
 let pure=source.slice(0,boundary);
 for(const line of ["import { createHmac, timingSafeEqual } from 'node:crypto';","import { deriveSubkey, zeroizeBuffer } from '../crypto-v3';"]){if(pure.split(line).length!==2)throw Error('Canonical policy imports changed');pure=pure.replace(line,'');}
 return pure;
}
