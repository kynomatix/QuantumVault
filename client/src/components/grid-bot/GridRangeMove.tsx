import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {walletAuthHeaders} from '@/lib/queryClient';

type MoveSurface={enabled:boolean;mode:'off'|'ask';generation:string;direction:'long'|'short';available:boolean;epochs:{ordinal:number;lower_price:string;upper_price:string;stop_loss_price:string;activated_at:string}[]};
type Information={state:'available'|'unavailable';adx?:number;plusDi?:number;minusDi?:number;atr?:number;edgeAtr?:number;adxDeclining?:boolean;reason?:string};
type Proposal={proposal:Record<string,unknown>&{policy:{lowerPrice:string;upperPrice:string;stopLossPrice:string};expiresAt:number;confirmation:{information:Information}};proposalHash:string;old:{lower:string;upper:string;stop:string}};
async function request(id:string,path:string,body?:unknown,signal?:AbortSignal){
  const response=await fetch('/api/grid-bots/'+id+path,{method:body===undefined?'GET':'POST',credentials:'include',signal,headers:{...walletAuthHeaders(),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await response.json();if(!response.ok)throw Error(value.error??'Range moving is unavailable');return value;
}
export function GridRangeMove({id,revision,onChanged,compact=false}:{id:string;revision?:string;onChanged?:()=>void;compact?:boolean}){
  const [state,setState]=useState<MoveSurface|null>(null),[proposal,setProposal]=useState<Proposal|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const [qualified,setQualified]=useState<Proposal|null>(null);
  const key=useRef(''),alive=useRef(true),writing=useRef(false);
  useEffect(()=>{alive.current=true;const controller=new AbortController();
    request(id,'/range-move',undefined,controller.signal).then(value=>{if(!controller.signal.aborted)setState(value);}).catch(()=>{if(!controller.signal.aborted)setState(null);});
    return()=>{alive.current=false;controller.abort();};
  },[id,revision]);
  useEffect(()=>{
    setQualified(null);if(compact||!state?.enabled||state.mode!=='ask'||!state.available)return;
    const controller=new AbortController();let timer:number|undefined;
    request(id,'/range-move/proposal',{},controller.signal).then((next:Proposal)=>{
      if(controller.signal.aborted)return;setQualified(next);timer=window.setTimeout(()=>setQualified(null),Math.max(0,next.proposal.expiresAt-Date.now()));
    }).catch(()=>{});
    return()=>{controller.abort();if(timer!==undefined)window.clearTimeout(timer);};
  },[id,revision,compact,state?.enabled,state?.mode,state?.generation,state?.available]);
  const perform=async(work:()=>Promise<void>)=>{if(writing.current)return;writing.current=true;setBusy(true);setMessage('');try{await work();}catch(error){if(alive.current)setMessage((error as Error).message);}finally{writing.current=false;if(alive.current)setBusy(false);}};
  if(!state)return null;
  const latest=state.epochs[0],direction=state.direction==='long'?'up':'down',information=(proposal??qualified)?.proposal.confirmation.information;
  if(compact)return latest?.ordinal>1?<span className="mt-2 block text-xs">Range moved {direction} · Range {latest.ordinal}</span>:null;
  if(!state.enabled&&state.epochs.length<2)return null;
  return <section className="space-y-3 rounded-lg border p-4 text-sm" aria-label="Range following">
    {state.enabled&&<>
      <label className="flex items-center justify-between gap-3">Follow price {direction}
        <select aria-label={'Follow price '+direction} value={state.mode} disabled={busy} onChange={event=>{const mode=event.target.value;void perform(async()=>{
          const saved=await request(id,'/range-following',{mode,generation:state.generation});if(alive.current)setState({...state,...saved,generation:String(saved.generation)});
        });}} className="rounded border bg-background p-2"><option value="off">Off</option><option value="ask">Ask me</option></select>
      </label>
      {state.mode==='ask'&&qualified&&<p>Price closed {state.direction==='long'?'above':'below'} your range</p>}
      <Button variant="outline" disabled={busy||!state.available} onClick={()=>void perform(async()=>{
        const next=await request(id,'/range-move/proposal',{});if(alive.current){key.current=crypto.randomUUID();setProposal(next);}
      })}>Move range {direction}</Button>
      {information&&<p className="text-xs text-muted-foreground">{information.state==='available'
        ?`DI+ ${information.plusDi?.toFixed(1)} / DI? ${information.minusDi?.toFixed(1)} ? ADX ${information.adx?.toFixed(1)}${information.adxDeclining?' (declining)':''} ? ATR(14) ${information.atr?.toFixed(4)} ? ${information.edgeAtr?.toFixed(2)} ATR beyond the old edge.`
        :information.reason} DI/ADX/ATR are information for this manual move.</p>}
      {proposal&&<div role="group" aria-label="Confirm range move" className="space-y-3 border-t pt-3">
        <p>Range: {proposal.old.lower} – {proposal.old.upper} → {proposal.proposal.policy.lowerPrice} – {proposal.proposal.policy.upperPrice}</p>
        <p>Stop: {proposal.old.stop} → {proposal.proposal.policy.stopLossPrice}</p>
        <p>Investment and leverage stay the same</p><p>Existing holdings stay with this bot</p>
        <div className="flex gap-2"><Button disabled={busy} onClick={()=>void perform(async()=>{
          if(Date.now()>=proposal.proposal.expiresAt){setProposal(null);throw Error('Confirmation expired. Check the move again.');}
          await request(id,'/range-move/confirm',{requestId:key.current,proposal:proposal.proposal,proposalHash:proposal.proposalHash});
          if(alive.current){setProposal(null);setMessage('Move requested. Waiting for confirmed orders and the new range.');onChanged?.();}
        })}>Confirm move {direction}</Button><Button variant="ghost" disabled={busy} onClick={()=>setProposal(null)}>Cancel</Button></div>
      </div>}
    </>}
    {message&&<p role="status">{message}</p>}
    {latest?.ordinal>1&&<p role="status">Range moved {direction}. Current range: {latest.lower_price} – {latest.upper_price}. Stop: {latest.stop_loss_price}.</p>}
    <details><summary>Range history</summary><ol className="mt-2 space-y-2">{state.epochs.map(epoch=><li key={epoch.ordinal}>Range {epoch.ordinal}: {epoch.lower_price} – {epoch.upper_price}; stop {epoch.stop_loss_price} · {new Date(epoch.activated_at).toLocaleString()}</li>)}</ol></details>
  </section>;
}
