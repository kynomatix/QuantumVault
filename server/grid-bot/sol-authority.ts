import Decimal from 'decimal.js';
/** One shared in-flight/value authority per exact execution wallet. Never rounds lamports. */
export function createGridSolReader(read:(wallet:string)=>Promise<bigint>,maxAgeMs=5000,deadlineMs=1000){
  type Fact={balance:string;observedAt:number};
  const cache=new Map<string,{promise:Promise<Fact|null>;settled:boolean;observedAt:number}>();
  return async(wallet:string,signal:AbortSignal):Promise<Fact|null>=>{
    signal.throwIfAborted();const now=Date.now();
    for(const [key,value] of cache)if(value.settled&&now-value.observedAt>maxAgeMs)cache.delete(key);
    let entry=cache.get(wallet);
    if(!entry){
      if(cache.size>=1000)return null;
      entry={promise:Promise.resolve(null),settled:false,observedAt:now};const retained=entry;
      entry.promise=Promise.resolve().then(()=>read(wallet)).then(lamports=>typeof lamports==='bigint'&&lamports>=0n
        ?{balance:new Decimal(lamports.toString()).div('1000000000').toFixed(),observedAt:now}:null).catch(()=>null).finally(()=>{retained.settled=true;});
      cache.set(wallet,entry);
    }
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{const fact=await Promise.race([entry.promise,new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),deadlineMs);})]);
      signal.throwIfAborted();return fact&&Date.now()-fact.observedAt<=maxAgeMs?fact:null;
    }finally{if(timer)clearTimeout(timer);}
  };
}
