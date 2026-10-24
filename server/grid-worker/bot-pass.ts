/** A bot failure is local; cancellation and loss of host authority still stop the pass. */
export async function serviceBotPass<C extends {id:string}>(signal:AbortSignal,d:{
  assertHolder:()=>void;claim:(seen:string[])=>Promise<C|null>;allowed:(claim:C)=>boolean;
  refused:(claim:C)=>Promise<unknown>;tick:(claim:C)=>Promise<unknown>;
  observed:(claim:C,error?:unknown)=>Promise<unknown>;observationFailed:(claim:C)=>Promise<unknown>;
  release:(claim:C)=>Promise<unknown>;
}){
  const seen:string[]=[];
  for(let i=0;i<100;i++){
    signal.throwIfAborted();d.assertHolder();const claim=await d.claim(seen);if(!claim)break;seen.push(claim.id);
    try{
      if(!d.allowed(claim)){await d.refused(claim);continue;}
      await d.tick(claim);await d.observed(claim);
    }catch(error){
      signal.throwIfAborted();d.assertHolder();
      try{await d.observed(claim,error);}catch{await d.observationFailed(claim);}
    }finally{await d.release(claim);}
  }
}