import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Card,CardContent,CardHeader,CardTitle} from '@/components/ui/card';
import {walletAuthHeaders} from '@/lib/queryClient';
import {GridReadOrder} from '@/lib/grid-live-view';
import type {GridBotSummary} from '../../../../shared/grid-surface';
import type {GridIntent} from '../../../../shared/grid-draft';
import {GridCreateSheet} from './GridCreateSheet';
import {GridBotDrawer} from './GridBotDrawer';
export const gridJson=async(path:string,options:RequestInit={})=>{
  const r=await fetch('/api/grid-bots'+path,{...options,credentials:'include',headers:{...walletAuthHeaders(),'Content-Type':'application/json',...options.headers}});
  const body=await r.json();if(!r.ok)throw Error(body.error??'Grid request unavailable');return body;
};
export function GridDraftCard({authenticated,identity}:{authenticated:boolean;identity:string|null}){
  return <GridCollection key={String(authenticated)+identity} authenticated={authenticated} identity={identity}/>;
}
function GridCollection({authenticated,identity}:{authenticated:boolean;identity:string|null}){
  const [enabled,setEnabled]=useState(false),[bots,setBots]=useState<GridBotSummary[]>([]),[selected,setSelected]=useState<string|null>(null),[error,setError]=useState('');
  const [create,setCreate]=useState<{key:number;intent?:GridIntent}|null>(null),[refresh,setRefresh]=useState(0);
  const order=useRef(new GridReadOrder());
  useEffect(()=>{setBots([]);setEnabled(false);setSelected(null);setCreate(null);setError('');if(!authenticated||!identity)return;
    const controller=new AbortController();const seq=order.current.next();
    Promise.all([gridJson('/status',{signal:controller.signal}),gridJson('?includeStopped=true',{signal:controller.signal})]).then(([status,list])=>{
      if(!controller.signal.aborted&&order.current.accepts(seq)){setEnabled(status.enabled===true);setBots(list.bots);}
    }).catch(()=>{if(!controller.signal.aborted&&order.current.accepts(seq))setError('Grid bots unavailable. Retry to load current state.');});
    return()=>{controller.abort();order.current.next();};
  },[authenticated,identity,refresh]);
  return <Card data-testid="card-grid-bot"><CardHeader><CardTitle className="text-amber-500">Pacifica Grid Bots</CardTitle></CardHeader><CardContent className="space-y-3">
    <p className="text-sm text-muted-foreground">Live start and worker are disabled. PnL excludes funding.</p>
    {!authenticated?<p className="text-sm">Connect your wallet to view your Grid bots.</p>:<>
      <div className="flex flex-wrap gap-2">{enabled?<Button onClick={()=>setCreate({key:Date.now()})}>Create Grid draft</Button>:<span className="text-sm">Draft creation unavailable</span>}<Button variant="outline" onClick={()=>setRefresh(v=>v+1)}>Refresh bots</Button></div>
      <p role="status" className="text-sm">{error||(!bots.length?'No Grid bots loaded.':'')}</p>
      <div className="grid gap-3 sm:grid-cols-2">{bots.map(bot=><button key={bot.id} onClick={()=>setSelected(bot.id)} className="rounded-xl border p-4 text-left hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        <span className="block font-medium">{bot.market} · {bot.direction}</span><span className="block text-sm capitalize">{bot.status.replaceAll('_',' ')}</span><span className="block text-xs text-muted-foreground">{bot.lowerPrice} – {bot.upperPrice} · {bot.gridCount} intervals</span><span className="block text-xs">Realised / unrealised PnL: UNKNOWN until details refresh · excludes funding</span>
      </button>)}</div>
    </>}
    {selected&&identity?<GridBotDrawer key={identity+selected} id={selected} createEnabled={enabled} onClose={()=>{setSelected(null);setRefresh(v=>v+1);}} onAdjust={intent=>{setSelected(null);setCreate({key:Date.now(),intent});}}/>:null}
    {create?<GridCreateSheet key={(identity??'anonymous')+create.key} open onOpenChange={open=>{if(!open)setCreate(null);}} initialIntent={create.intent} onSaved={()=>{setCreate(null);setRefresh(v=>v+1);}}/>:null}
  </CardContent></Card>;
}
