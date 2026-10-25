import {installRescuePageLifetime} from '../../lib/grid-worker-rescue-lifetime';
import React,{createContext,lazy,Suspense,useCallback,useContext,useEffect,useMemo,useState,useSyncExternalStore} from 'react';
import {walletAuthHeaders} from '@/lib/queryClient';
import {GridWorkerCache} from '@/lib/grid-worker-cache';
import {controlsVisible,type WorkerPresentation} from '@/lib/grid-worker-view';
import {gridWorkerBotNames,type WorkerBotName} from '@/lib/grid-worker-names';
import {GridWorkerRescueDriver,emptyRescueDriver} from '@/lib/grid-worker-rescue-driver';
import {rescueBotLocked} from '@/lib/grid-worker-rescue-copy';
const Context=createContext<{cache:GridWorkerCache;driver:GridWorkerRescueDriver;names:ReadonlyMap<string,string>;setBots:(bots:readonly WorkerBotName[])=>void}|null>(null);
const empty:WorkerPresentation={status:null,admitted:false,overlay:'none',elapsedSeconds:0,target:null,outcome:null,notice:'',busy:false};
const noop=()=>()=>{};
const emptySnapshot=()=>empty;
const Status=lazy(()=>import('./GridWorkerStatus').then(m=>({default:m.GridWorkerStatus})));
const Drawer=lazy(()=>import('./GridWorkerStatus').then(m=>({default:m.GridWorkerDrawerLine})));
// Denial survives remounts in this page, but owner data does not survive a wallet switch.
const deniedWallets=new Set<string>();
export function GridWorkerProvider({wallet,authenticated,children}:{wallet:string|null;authenticated:boolean;children:React.ReactNode}){
  const cache=useMemo(()=>{let admitted=false;return wallet&&authenticated?new GridWorkerCache(wallet,async signal=>{
    if(deniedWallets.has(wallet))return {status:404,body:null};
    const r=await fetch('/api/grid-worker/status',{credentials:'include',headers:walletAuthHeaders(),signal});
    if(r.status===200||r.status===503||r.status===409)admitted=true;
    if(r.status===404&&!admitted)deniedWallets.add(wallet);
    return {status:r.status,body:r.status===200?await r.json():null};
  }):null;},[wallet,authenticated]);
  const driver=useMemo(()=>cache?new GridWorkerRescueDriver(cache,async(path,body)=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
    try{const r=await fetch('/api/grid-worker'+path,{method:body===undefined?'GET':'POST',credentials:'include',headers:{...walletAuthHeaders(),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:controller.signal});return {status:r.status,body:await r.json().catch(()=>null)};}
    finally{clearTimeout(timer);}
  }):null,[cache]);
  const [collection,setCollection]=useState<{cache:GridWorkerCache|null;bots:readonly WorkerBotName[]}>({cache:null,bots:[]});
  const setBots=useCallback((bots:readonly WorkerBotName[])=>setCollection({cache,bots}),[cache]);
  const names=useMemo(()=>gridWorkerBotNames(collection.cache===cache?collection.bots:[]),[collection,cache]);
  useEffect(()=>{
    if(!cache||typeof window==='undefined'||typeof document==='undefined')return;
    const release=cache.retain();
    void cache.refresh();const timer=setInterval(()=>cache.tick(),1000);
    const focus=()=>{if(document.visibilityState==='visible'){void driver?.focus();void cache.refresh();}};
    window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);
    return()=>{clearInterval(timer);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);release();};
  },[cache,driver]);
  useEffect(()=>{if(!driver)return;return driver.retain();},[driver]);
  return <Context.Provider value={cache&&driver?{cache,driver,names,setBots}:null}><RescuePageLifetime/>{children}</Context.Provider>;
}
export function useGridWorker(){
  const context=useContext(Context);
  const state=useSyncExternalStore(context?.cache.subscribe??noop,context?.cache.snapshot??emptySnapshot,context?.cache.snapshot??emptySnapshot);
  return {context,state};
}
const emptyDriverSnapshot=()=>emptyRescueDriver;
export function useGridRescue(){
  const {context,state}=useGridWorker();
  const driverState=useSyncExternalStore(context?.driver.subscribe??noop,context?.driver.snapshot??emptyDriverSnapshot,context?.driver.snapshot??emptyDriverSnapshot);
  return {context,state,driverState};
}
export function useGridRescueLock(botId:string){const {context,state,driverState}=useGridRescue();return rescueBotLocked(state.status,botId)||!!context?.driver.locked(botId)||driverState.mode==='uncertain'&&driverState.botId===botId;}
function RescuePageLifetime(){
  const {context,state,driverState}=useGridRescue();
  const active=driverState.driving||['starting','uncertain'].includes(driverState.mode);
  useEffect(()=>{
    if(!active||typeof window==='undefined'||typeof document==='undefined')return;
    return installRescuePageLifetime(window,document,navigator as Parameters<typeof installRescuePageLifetime>[2]);
  },[context?.driver,active,driverState.botId,state.status?.rescue?.requestId]);
  return null;
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
