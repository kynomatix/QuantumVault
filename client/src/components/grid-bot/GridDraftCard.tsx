import { gridBehaviourCopy } from '../../../../shared/grid-behaviour';
import React,{useEffect,useRef,useState} from 'react';
import {BarChart3} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {walletAuthHeaders} from '@/lib/queryClient';
import {GridReadOrder} from '@/lib/grid-live-view';
import type {GridBotSummary} from '../../../../shared/grid-surface';
import type {GridIntent} from '../../../../shared/grid-draft';
import {GridPlannerSheet} from '../grid-planner/GridPlannerSheet';
import {gridSetupAccess} from '@/lib/grid-setup-view';
import {readableDecimal} from '@/lib/grid-planner-view';
import {GridBotDrawer} from './GridBotDrawer';
export const gridJson=async(path:string,options:RequestInit={})=>{
  const r=await fetch('/api/grid-bots'+path,{...options,credentials:'include',headers:{...walletAuthHeaders(),'Content-Type':'application/json',...options.headers}});
  const body=await r.json();if(!r.ok)throw Error(body.error??'Grid request unavailable');return body;
};
type GridDraftCardProps = {
  authenticated:boolean;
  identity:string|null;
  renderLayout?:(card:React.ReactNode,bots:React.ReactNode)=>React.ReactNode;
};
export function GridDraftCard({authenticated,identity,renderLayout}:GridDraftCardProps){
  return <GridCollection key={String(authenticated)+identity} authenticated={authenticated} identity={identity} renderLayout={renderLayout}/>;
}
function GridCollection({authenticated,identity,renderLayout}:GridDraftCardProps){
  const [enabled,setEnabled]=useState(false),[bots,setBots]=useState<GridBotSummary[]>([]),[selected,setSelected]=useState<string|null>(null),[error,setError]=useState('');
  const [planner,setPlanner]=useState(false),[start,setStart]=useState(false),[worker,setWorker]=useState(false);
  const [create,setCreate]=useState<{key:number;intent?:GridIntent}|null>(null),[refresh,setRefresh]=useState(0);
  const order=useRef(new GridReadOrder());
  useEffect(()=>{if(!authenticated||!identity)return;
    setError('');
    const controller=new AbortController();const seq=order.current.next();
    Promise.allSettled([gridJson('/status',{signal:controller.signal}),gridJson('?includeStopped=true',{signal:controller.signal}),
      fetch('/api/grid-planner/status',{credentials:'include',headers:walletAuthHeaders(),signal:controller.signal}).then(async r=>r.ok?r.json():null)
    ]).then(([status,list,planning])=>{
      if(controller.signal.aborted||!order.current.accepts(seq))return;
      if(status.status==='fulfilled'){setEnabled(status.value.enabled===true);setStart(status.value.startEnabled===true);setWorker(status.value.workerEnabled===true);}
      else{setEnabled(false);setStart(false);setWorker(false);}
      if(list.status==='fulfilled')setBots(list.value.bots);
      else setError('Grid bots unavailable. Try again.');
      setPlanner(planning.status==='fulfilled'&&planning.value?.enabled===true&&planning.value?.planningOnly===true&&planning.value?.name==='Grid Planner');
    });
    return()=>{controller.abort();order.current.next();};
  },[authenticated,identity,refresh]);
  useEffect(()=>{
    if(!authenticated||!identity)return;
    const onFocus=()=>setRefresh((value)=>value+1);
    window.addEventListener('focus',onFocus);
    return()=>window.removeEventListener('focus',onFocus);
  },[authenticated,identity]);
  const access=gridSetupAccess(planner,enabled,start,worker);
  const card=!access.setup&&!bots.length?<GridComingSoon/>:(
    <div className="gradient-border p-5 noise flex flex-col gap-3" data-testid="card-grid-bot">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary/30 to-accent/30 flex items-center justify-center flex-shrink-0">
            <BarChart3 className="w-5 h-5 text-primary" aria-hidden="true"/>
          </div>
          <div>
            <h3 className="font-semibold">Grid Bot</h3>
            <p className="text-xs text-muted-foreground">Range trading on Pacifica</p>
          </div>
        </div>
        {!access.live&&<span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground border border-border/60 shrink-0">Planning</span>}
      </div>
      <p className="text-sm text-muted-foreground">Pick a range and the bot buys low and sells high inside it, again and again.</p>
      {!access.live&&<p className="text-xs text-muted-foreground/70">Planning only for now: no orders are placed.</p>}
      {access.setup&&(
        <div className="flex items-center gap-2 mt-auto pt-1">
          <Button className="flex-1 bg-gradient-to-r from-primary to-accent hover:opacity-90" onClick={()=>setCreate({key:Date.now()})} data-testid="button-plan-grid">
            Plan a grid →
          </Button>
        </div>
      )}
    </div>
  );
  const botSection=authenticated&&(
    <>
      {error&&<div role="status" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"><p>{error}</p>
        <Button type="button" size="sm" variant="outline" onClick={()=>setRefresh(value=>value+1)} data-testid="button-retry-grid-bots">Retry loading bots</Button>
      </div>}
      {bots.length>0&&<div className="space-y-4" data-testid="section-grid-bots">
        <div className="flex items-center gap-3">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap flex items-center gap-1.5">
            <BarChart3 className="w-3.5 h-3.5" aria-hidden="true"/>
            Grid Bots
          </h2>
          <div className="h-px flex-1 bg-border/50"/>
        </div>
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-5">{bots.map(bot=>(
          <button type="button" key={bot.id} onClick={()=>setSelected(bot.id)} className="gradient-border p-5 noise hover:scale-[1.01] transition-transform cursor-pointer text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" data-testid={`grid-bot-card-${bot.id}`}>
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl flex items-center justify-center bg-gradient-to-br from-primary/30 to-accent/30">
                  <BarChart3 className="w-6 h-6 text-primary" aria-hidden="true"/>
                </div>
                <div>
                  <h3 className="font-semibold text-base">{bot.name||bot.market}</h3>
                  <p className="text-sm text-muted-foreground">{bot.market} · {bot.direction}</p>
                </div>
              </div>
              <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-muted text-muted-foreground capitalize">{bot.status.replaceAll('_',' ')}</span>
            </div>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="p-2.5 rounded-lg bg-muted/30"><p className="text-sm font-bold">{readableDecimal(bot.lowerPrice)} – {readableDecimal(bot.upperPrice)}</p><p className="text-xs text-muted-foreground">Range</p></div>
              <div className="p-2.5 rounded-lg bg-muted/30">{bot.behaviourMode && <p className="text-xs">{gridBehaviourCopy(bot.behaviourMode,bot.direction).label}</p>}<p className="text-lg font-bold">{bot.gridCount}</p><p className="text-xs text-muted-foreground">Grids</p></div>
              <div className="min-w-0 p-2.5 rounded-lg bg-muted/30"><p className="text-lg font-bold text-muted-foreground" title="P&L unavailable" aria-label="P&L unavailable">—</p><p className="text-xs text-muted-foreground">P&amp;L</p></div>
            </div>
            <span className="mt-4 block text-sm font-medium text-primary">View bot</span>
          </button>
        ))}</div>
      </div>}
    </>
  );
  return <>
    {renderLayout?renderLayout(card,botSection):<>{card}{botSection}</>}
    {selected&&identity?<GridBotDrawer key={identity+selected} id={selected} createEnabled={enabled} onClose={()=>{setSelected(null);setRefresh(v=>v+1);}} onAdjust={intent=>{setSelected(null);setCreate({key:Date.now(),intent});}}/>:null}
    {create&&identity?<GridPlannerSheet key={identity+create.key} identity={identity} open plannerEnabled={planner} createEnabled={enabled} liveEnabled={access.live}
      onOpenChange={open=>{if(!open)setCreate(null);}} initialIntent={create.intent} onSaved={()=>{setCreate(null);setRefresh(v=>v+1);}}/>:null}
  </>;
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
