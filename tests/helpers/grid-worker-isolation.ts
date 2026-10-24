import {randomInt,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';

/** All advisory identities are database-wide, including fixture serial pool ids. */
export function gridWorkerIsolation() {
  const canonical='qv:grid-worker:v3:',prefix=canonical+randomUUID()+':';
  const walletNamespace=String(randomInt(1_000_000,2_000_000_000));
  const rewrite=(sql:string)=> {
    const changed=sql.replaceAll(canonical,prefix).replaceAll('927412',walletNamespace);
    return changed.replaceAll('p.prosrc',`replace(replace(p.prosrc,'${prefix}','${canonical}'),'${walletNamespace}','927412')`);
  };
  return (c:PoolClient)=>{
    c.query=new Proxy(c.query,{apply(query,receiver,args){
      if(typeof args[0]==='string')args[0]=rewrite(args[0]);
      else if(args[0]&&typeof args[0].text==='string')args[0]={...args[0],text:rewrite(args[0].text),
        ...(Array.isArray(args[0].values)?{values:args[0].values.map((v:unknown)=>typeof v==='string'?v.replaceAll(canonical,prefix):v===927412?Number(walletNamespace):v)}:{})};
      if(Array.isArray(args[1]))args[1]=args[1].map(v=>typeof v==='string'?v.replaceAll(canonical,prefix):v===927412?Number(walletNamespace):v);
      return Reflect.apply(query,receiver,args);
    }});
    return c;
  };
}
