import React,{useEffect,useRef,useState} from 'react';
import {BarChart3} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Card,CardContent,CardHeader,CardTitle} from '@/components/ui/card';
import {walletAuthHeaders} from '@/lib/queryClient';
import {GridReadOrder} from '@/lib/grid-live-view';
import type {GridBotSummary} from '../../../../shared/grid-surface';
import type {GridIntent} from '../../../../shared/grid-draft';
import {GridPlannerSheet} from '../grid-planner/GridPlannerSheet';
import {gridSetupAccess} from '@/lib/grid-setup-view';
import {PLANNING_BANNER} from '@/lib/grid-planner-view';
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
  const [planner,setPlanner]=useState(false),[start,setStart]=useState(false),[worker,setWorker]=useState(false);
  const [create,setCreate]=useState<{key:number;intent?:GridIntent}|null>(null),[refresh,setRefresh]=useState(0);
  const order=useRef(new GridReadOrder());
  useEffect(()=>{setBots([]);setEnabled(false);setSelected(null);setCreate(null);setError('');if(!authenticated||!identity)return;
    const controller=new AbortController();const seq=order.current.next();
    setPlanner(false);setStart(false);setWorker(false);
    Promise.allSettled([gridJson('/status',{signal:controller.signal}),gridJson('?includeStopped=true',{signal:controller.signal}),
      fetch('/api/grid-planner/status',{credentials:'include',headers:walletAuthHeaders(),signal:controller.signal}).then(async r=>r.ok?r.json():null)
    ]).then(([status,list,planning])=>{
      if(controller.signal.aborted||!order.current.accepts(seq))return;
      if(status.status==='fulfilled'){setEnabled(status.value.enabled===true);setStart(status.value.startEnabled===true);setWorker(status.value.workerEnabled===true);}
      if(list.status==='fulfilled')setBots(list.value.bots);
      else setError('Grid bots unavailable. Retry to load current state.');
      if(planning.status==='fulfilled')setPlanner(planning.value?.enabled===true&&planning.value?.planningOnly===true&&planning.value?.name==='Grid Planner');
    });
    return()=>{controller.abort();order.current.next();};
  },[authenticated,identity,refresh]);
  const access=gridSetupAccess(planner,enabled,start,worker);
  if(!access.setup&&!bots.length)return <GridComingSoon/>;
  return <Card data-testid="card-grid-bot"><CardHeader><CardTitle className="text-amber-500">Grid Bot</CardTitle></CardHeader><CardContent className="space-y-3">
    <p className="text-sm text-muted-foreground">Choose a range and plan your Pacifica grid. PnL excludes funding.</p>
    {!access.live&&<p className="text-sm text-muted-foreground">{PLANNING_BANNER}</p>}
    {!authenticated?<p className="text-sm">Connect your wallet to view your Grid bots.</p>:<>
      <div className="flex flex-wrap gap-2">{access.setup?<Button onClick={()=>setCreate({key:Date.now()})}>{access.live?'Set up Grid Bot':'Open Grid Bot'}</Button>:null}<Button variant="outline" onClick={()=>setRefresh(v=>v+1)}>Refresh bots</Button></div>
      <p role="status" className="text-sm">{error||(!bots.length?'No Grid bots loaded.':'')}</p>
      <div className="grid gap-3 sm:grid-cols-2">{bots.map(bot=><button key={bot.id} onClick={()=>setSelected(bot.id)} className="rounded-xl border p-4 text-left hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        <span className="block font-medium">{bot.market} · {bot.direction}</span><span className="block text-sm capitalize">{bot.status.replaceAll('_',' ')}</span><span className="block text-xs text-muted-foreground">{bot.lowerPrice} – {bot.upperPrice} · {bot.gridCount} intervals</span><span className="block text-xs">Realised / unrealised PnL: UNKNOWN until details refresh · excludes funding</span>
      </button>)}</div>
    </>}
    {selected&&identity?<GridBotDrawer key={identity+selected} id={selected} createEnabled={enabled} onClose={()=>{setSelected(null);setRefresh(v=>v+1);}} onAdjust={intent=>{setSelected(null);setCreate({key:Date.now(),intent});}}/>:null}
    {create&&identity?<GridPlannerSheet key={identity+create.key} identity={identity} open plannerEnabled={planner} createEnabled={enabled} liveEnabled={access.live}
      onOpenChange={open=>{if(!open)setCreate(null);}} initialIntent={create.intent} onSaved={()=>{setCreate(null);setRefresh(v=>v+1);}}/>:null}
  </CardContent></Card>;
}
function GridComingSoon(){
  return <div className="gradient-border p-5 noise flex flex-col gap-3 opacity-60 select-none cursor-not-allowed" aria-hidden="true" data-testid="card-grid-bot-coming-soon">
    <div className="flex items-start justify-between">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-muted/50 to-muted/30 flex items-center justify-center flex-shrink-0"><BarChart3 className="w-5 h-5 text-muted-foreground"/></div>
        <div><h3 className="font-semibold">Grid Bot</h3><p className="text-xs text-muted-foreground">Automated grid trading</p></div>
      </div>
      <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground border border-border/60 shrink-0">Coming soon</span>
    </div>
    <p className="text-sm text-muted-foreground">Buys and sells automatically within a price range, capturing volatility without predicting direction.</p>
  </div>;
}
