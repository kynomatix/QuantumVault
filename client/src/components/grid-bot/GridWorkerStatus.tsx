import React,{useEffect,useMemo,useRef,useState} from 'react';
import {useWallet} from '@solana/wallet-adapter-react';
import {walletAuthHeaders} from '@/lib/queryClient';
import {GridWorkerActions} from '@/lib/grid-worker-actions';
import {currentPause} from '@/lib/grid-worker-view';
import {useGridWorker} from './GridWorkerContext';
import {GridWorkerDrawerView,GridWorkerStatusView} from './GridWorkerStatusView';
import './grid-worker.css';
export function GridWorkerStatus(){
  const {context,state}=useGridWorker(),wallet=useWallet();const identity=wallet.publicKey?.toBase58()??null;
  const alive=useRef(true),currentWallet=useRef(identity);currentWallet.current=identity;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const actions=useMemo(()=>context?new GridWorkerActions(context.cache,async(path,body)=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
    try{const r=await fetch('/api/grid-worker'+path,{method:'POST',credentials:'include',headers:{...walletAuthHeaders(),'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});return {status:r.status,body:await r.json()};}
    finally{clearTimeout(timer);}
  }):null,[context?.cache]);
  const [rowsCollapsed,setRowsCollapsed]=useState(false),s=state.status;
  const finalRows=!!s&&currentPause(s)&&s.cancellationsComplete&&(s.executionMode==='legacy'||s.pauseAckRevision===s.pauseRevision);
  useEffect(()=>{setRowsCollapsed(false);if(!finalRows)return;const t=setTimeout(()=>setRowsCollapsed(true),10000);return()=>clearTimeout(t);},[finalRows,s?.pauseRevision]);
  if(!context)return null;
  return <GridWorkerStatusView state={state} names={context.names} canSign={!!wallet.signMessage&&identity===context.cache.wallet} rowsCollapsed={rowsCollapsed}
    onRefresh={()=>void context.cache.refresh()} onSeen={ids=>void actions?.seen(ids)}
    onAction={(action,target)=>{if(wallet.signMessage)void actions?.run(action,target,wallet.signMessage,()=>alive.current&&currentWallet.current===context.cache.wallet);}}/>;
}
export function GridWorkerDrawerLine({botId}:{botId:string}){const {state}=useGridWorker();return <GridWorkerDrawerView state={state} botId={botId}/>;}
