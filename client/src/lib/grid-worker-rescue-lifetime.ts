type Lock={release:()=>Promise<void>};
type WakeNavigator={wakeLock?:{request:(type:'screen')=>Promise<Lock>}};
/** One effect/attempt owns the prompt and each asynchronously granted wake lock. */
export function installRescuePageLifetime(page:EventTarget,visibility:EventTarget&{visibilityState:string},agent:WakeNavigator){
  let current=true,pending=false,sentinel:Lock|null=null;
  const release=()=>{const lock=sentinel;sentinel=null;void lock?.release().catch(()=>{});};
  const wake=async()=>{
    if(!current||pending||sentinel||visibility.visibilityState!=='visible'||!agent.wakeLock)return;
    pending=true;
    try{const lock=await agent.wakeLock.request('screen');if(!current||visibility.visibilityState!=='visible')await lock.release();else sentinel=lock;}catch{/* Refusal is tolerated; the screen-on instruction remains necessary. */}finally{pending=false;}
  };
  const changed=()=>{if(visibility.visibilityState==='visible')void wake();else release();};
  const leave=(event:Event)=>{event.preventDefault();(event as BeforeUnloadEvent).returnValue='';};
  page.addEventListener('beforeunload',leave);visibility.addEventListener('visibilitychange',changed);void wake();
  return()=>{current=false;page.removeEventListener('beforeunload',leave);visibility.removeEventListener('visibilitychange',changed);release();};
}
