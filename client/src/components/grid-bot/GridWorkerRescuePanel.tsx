import React,{useEffect,useRef,useState} from 'react';
import {useWallet} from '@solana/wallet-adapter-react';
import {useGridRescue} from './GridWorkerContext';
import {GridWorkerRescueView} from './GridWorkerRescueView';
// Shared styles load through the adjacent GridWorkerDrawerSlot.
export function GridWorkerRescuePanel({botId,stopped}:{botId:string;stopped?:boolean}){
  const {context,state,driverState}=useGridRescue(),wallet=useWallet(),identity=wallet.publicKey?.toBase58()??null;
  const current=useRef(identity);current.current=identity;
  const [confirming,setConfirming]=useState(false);
  useEffect(()=>setConfirming(false),[botId,context?.cache,driverState.mode,state.status?.rescue?.live]);
  if(!context)return null;
  return <GridWorkerRescueView state={state} botId={botId} names={context.names} driverState={driverState} stopped={stopped} confirming={confirming}
    canSign={!!wallet.signMessage&&identity===context.cache.wallet} onConfirm={()=>setConfirming(true)} onCancel={()=>setConfirming(false)}
    onStart={()=>{const target=botId,sign=wallet.signMessage;if(sign)void context.driver.start(target,sign,()=>current.current===context.cache.wallet);}}
    onContinue={context.driver.continueHere} onRefresh={()=>{void context.cache.refresh();void context.driver.focus();}}/>;
}
