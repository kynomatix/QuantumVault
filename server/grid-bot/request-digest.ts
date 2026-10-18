import {createHash} from 'node:crypto';

/** Preserve the v1 exact-request encoding for every retained operation and replay. */
export const canonicalRequest=(x:unknown):string=>JSON.stringify(x,(_,v)=>v && typeof v==='object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export const requestDigest=(x:unknown)=>createHash('sha256').update(canonicalRequest(x)).digest('hex');
