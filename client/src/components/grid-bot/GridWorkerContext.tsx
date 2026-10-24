import React,{createContext,lazy,Suspense,useContext,useEffect,useMemo,useSyncExternalStore} from 'react';
import {walletAuthHeaders} from '@/lib/queryClient';
import {GridWorkerCache} from '@/lib/grid-worker-cache';
import {controlsVisible,type WorkerPresentation} from '@/lib/grid-worker-view';
import {gridWorkerBotNames,type WorkerBotName} from '@/lib/grid-worker-names';
const Context=createContext<{cache:GridWorkerCache;names:ReadonlyMap<string,string>}|null>(null);
const empty:WorkerPresentation={status:null,admitted:false,overlay:'none',elapsedSeconds:0,target:null,outcome:null,notice:'',busy:false};
const noop=()=>()=>{};
const emptySnapshot=()=>empty;
const Status=lazy(()=>import('./GridWorkerStatus').then(m=>({default:m.GridWorkerStatus})));
const Drawer=lazy(()=>import('./GridWorkerStatus').then(m=>({default:m.GridWorkerDrawerLine})));
// Denial survives remounts in this page, but owner data does not survive a wallet switch.
const deniedWallets=new Set<string>();
export function GridWorkerProvider({wallet,authenticated,bots,children}:{wallet:string|null;authenticated:boolean;bots:readonly WorkerBotName[];children:React.ReactNode}){
  const cache=useMemo(()=>{let admitted=false;return wallet&&authenticated?new GridWorkerCache(wallet,async signal=>{
    if(deniedWallets.has(wallet))return {status:404,body:null};
    const r=await fetch('/api/grid-worker/status',{credentials:'include',headers:walletAuthHeaders(),signal});
    if(r.status===200||r.status===503||r.status===409)admitted=true;
    if(r.status===404&&!admitted)deniedWallets.add(wallet);
    return {status:r.status,body:r.status===200?await r.json():null};
  }):null;},[wallet,authenticated]);
  const names=useMemo(()=>gridWorkerBotNames(bots),[bots]);
  useEffect(()=>{
    if(!cache||typeof window==='undefined'||typeof document==='undefined')return;
    const release=cache.retain();
    void cache.refresh();const timer=setInterval(()=>cache.tick(),1000);
    const focus=()=>{if(document.visibilityState==='visible')void cache.refresh();};
    window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);
    return()=>{clearInterval(timer);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);release();};
  },[cache]);
  return <Context.Provider value={cache?{cache,names}:null}>{children}</Context.Provider>;
}
export function useGridWorker(){
  const context=useContext(Context);
  const state=useSyncExternalStore(context?.cache.subscribe??noop,context?.cache.snapshot??emptySnapshot,context?.cache.snapshot??emptySnapshot);
  return {context,state};
}
export function GridWorkerStatusSlot(){
  const {state,context}=useGridWorker();
  if(!state.admitted)return null;
  // Explicitly admitted first-load errors keep a small shell without loading private copy.
  if(!state.status)return <section role="status" className="rounded-xl border p-4"><strong>Not checked recently</strong><p>The latest status isn't confirmed.</p><button type="button" onClick={()=>void context?.cache.refresh()}>Check again</button></section>;
  if(!controlsVisible(state.status))return null;
  return <Suspense fallback={null}><Status/></Suspense>;
}
export function GridWorkerDrawerSlot({botId}:{botId:string}){
  const {state}=useGridWorker();if(!state.admitted||!controlsVisible(state.status))return null;
  return <Suspense fallback={null}><Drawer botId={botId}/></Suspense>;
}
