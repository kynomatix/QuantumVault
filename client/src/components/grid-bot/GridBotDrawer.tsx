import React,{useEffect,useRef,useState} from 'react';
import {RefreshCw,X} from 'lucide-react';
import {VENUE_OPEN_ORDER_CAPACITY,GRID_PROTECTION_RESERVE} from '../../../../shared/grid-capacity';
import {Sheet,SheetContent,SheetHeader,SheetTitle,SheetDescription} from '@/components/ui/sheet';
import {Button} from '@/components/ui/button';
import {AlertDialog,AlertDialogContent,AlertDialogHeader,AlertDialogTitle,AlertDialogDescription,AlertDialogFooter,AlertDialogCancel,AlertDialogAction} from '@/components/ui/alert-dialog';
import {GridReadOrder,GridActionKeys,gridAdjustReady,gridFactsFresh,gridRangeState,gridBreakevenView,gridVisibleActions,gridCanAdjust,gridLaunchState} from '@/lib/grid-live-view';
import {gridStartConfirmation,submitGridStart} from '@/lib/grid-start-view';
import {readableDecimal} from '@/lib/grid-planner-view';
import type {GridBotSurface,GridOwnerAction} from '../../../../shared/grid-surface';
import type {GridIntent} from '../../../../shared/grid-draft';
import {gridJson} from './GridDraftCard';
import {GridBotChart} from './GridBotChart';
const value=(x:string|number|null|undefined)=>x===null||x===undefined||x==='UNKNOWN'?'—':x;
const price=(x:string|null|undefined)=>x?readableDecimal(x):'—';
export function GridBotOverview({surface,now}:{surface:GridBotSurface;now:number}){
  const fresh=gridFactsFresh(surface,now);
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-lg font-semibold">{gridLaunchState(surface)}</p><p className="text-sm">{surface.bot.direction} · {surface.bot.gridCount} grids</p></div><span className="rounded-full border px-2.5 py-1 text-xs font-medium">{gridRangeState(surface,now)}</span></div>
    <div><p className="text-sm text-muted-foreground">Total P&L</p><p className="mt-1 text-3xl font-semibold tabular-nums">{value(fresh?surface.pnl.total:null)}</p><p className="text-xs text-muted-foreground">Excludes funding</p></div>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm"><dt className="text-muted-foreground">Range</dt><dd className="text-right tabular-nums">{price(surface.bot.lowerPrice)} – {price(surface.bot.upperPrice)}</dd><dt className="text-muted-foreground">Stop</dt><dd className="text-right tabular-nums">{price(surface.bot.stopLossPrice)}</dd><dt className="text-muted-foreground">Position</dt><dd className="text-right">{fresh&&surface.position?surface.position.size+' '+surface.position.direction:'—'}</dd></dl>
    {!surface.observedAt?<p className="text-xs text-muted-foreground">Not loaded yet.</p>:!fresh?<p className="text-xs text-muted-foreground">Last observation is out of date. Refresh state for current values.</p>:surface.pnl.total===null||!surface.position?<p className="text-xs text-muted-foreground">Not loaded yet.</p>:null}
  </div>;
}
export function GridBotDetails({surface,now}:{surface:GridBotSurface;now:number}){
  const fresh=gridFactsFresh(surface,now),breakeven=gridBreakevenView(surface,now);
  const lifecycle=[surface.lifecycle.action,surface.lifecycle.state].filter(Boolean).join(' · ')||'No pending action';
  return <details className="rounded-lg border p-4 text-sm"><summary className="cursor-pointer font-medium">Details</summary><div className="mt-4 space-y-4">
    <p>Configured switches: draft creation {surface.draftEnabled?'on':'off'}; new Starts {surface.startConfigured?'on':'off'}. Start also requires the worker to be running.</p>
    <p>Last confirmed return to master: {surface.returnedFunds.amount===null?'Unavailable':'$'+surface.returnedFunds.amount}{surface.returnedFunds.confirmedAt?' at '+surface.returnedFunds.confirmedAt:''}. This is retained settlement evidence.</p>
    <div className="space-y-1"><h3 className="font-medium">Retained clean-history progress</h3><p>First trading exposure confirmed: {surface.qualification.firstConfirmedAt??'Unavailable'}</p><p>Clean period began: {surface.qualification.cleanSince??'Unavailable'} · Qualifying checks: {surface.qualification.cleanTicks??'Unavailable'}</p><p>{surface.qualification.promotedAt?'Qualified at '+surface.qualification.promotedAt:'Qualification pending; fresh history and risk checks are required.'}</p></div>
    <dl className="grid grid-cols-2 gap-2"><dt>Realised P&L</dt><dd>{value(surface.pnl.realised)}</dd><dt>Unrealised P&L</dt><dd>{value(fresh?surface.pnl.unrealised:null)}</dd><dt>Average open</dt><dd>{value(fresh?surface.pnl.averageEntry:null)}</dd><dt>Breakeven</dt><dd className={breakeven?.tone==='profit'?'text-emerald-500':breakeven?.tone==='loss'?'text-red-500':''}>{value(breakeven?.price)}{breakeven?.percent!==null&&breakeven?.percent!==undefined?' · '+breakeven.percent+'% from breakeven':''}</dd><dt>Completed cycles</dt><dd>{value(surface.cycles)}</dd><dt>Fees</dt><dd>{value(surface.pnl.fees)}</dd><dt>Mark price</dt><dd>{value(fresh?surface.mark:null)}</dd><dt>USDC left</dt><dd>{value(surface.bot.status==='stopped'||fresh?surface.residual:null)}</dd><dt>Settlement</dt><dd>{surface.sweep==='Confirmed terminal'?'Settlement complete':value(surface.sweep)}</dd><dt>Last updated</dt><dd>{surface.observedAt?new Date(surface.observedAt).toLocaleTimeString():'—'}{!fresh?' · stale or unavailable':''}</dd></dl>
    <div className="space-y-1"><h3 className="font-medium">Lifecycle</h3><p>{lifecycle}</p>{surface.lifecycle.blocker?<p className="break-words">Blocked: {surface.lifecycle.blocker}</p>:null}<p>Stopping and sweeping remain pending until all orders, fills and custody settlement are confirmed.</p>{surface.operations.map(op=><p key={op.id}>{op.type} · {op.state}</p>)}</div>
    <div className="space-y-1"><h3 className="font-medium">Capacity and launch authorities</h3><p>Ordinary window ceiling: {surface.capacity.ordinaryWindow} · Reserved slots: {surface.capacity.reservedSlots}</p><p>Exchange live orders: {value(fresh?surface.capacity.liveOrders:null)} · Exchange maximum: —</p><p>Proven account capacity: {VENUE_OPEN_ORDER_CAPACITY}. Empty-account ordinary window: {VENUE_OPEN_ORDER_CAPACITY-GRID_PROTECTION_RESERVE}; existing orders and pending sends reduce it.</p><p>History window: {fresh&&surface.authorities.safeWindow?'Inferred from full replay and stable exchange history identifiers':'Unavailable'}</p><p>Resume: {surface.authorities.resume?'Current position, fees, margin and security are rechecked on request':'Worker unavailable'}</p><p>Lost sweep lookup: unavailable; a missing reply remains unconfirmed</p><p>Breaker: retained terminal venue failures; uncertain requests stay unresolved</p><p>Worker: {surface.workerRunning?'Running':surface.workerEnabled?'Configured on; unavailable':'Off'} · New Starts: {surface.startEnabled?'On':'Off'}</p>{surface.entriesBlockedReasons.map(reason=><p key={reason}>Entries blocked: {reason.replaceAll('_',' ')}</p>)}<p>Owner notifications: {surface.notifications.pending} pending · {surface.notifications.uncertain} uncertain delivery</p></div>
    <div><h3 className="font-medium">Grid levels</h3><p className="text-xs text-muted-foreground">Persisted ledger states; current exchange data may be unavailable.</p><div className="mt-2 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="pr-3">Level</th><th className="pr-3">Price</th><th className="pr-3">Size</th><th className="pr-3">Side</th><th>State / filled</th></tr></thead><tbody>{surface.levels.map(l=><tr key={l.id} className="border-t"><td className="py-2">{l.ordinal}</td><td className="pr-3">{price(l.price)}</td><td className="pr-3">{l.size}</td><td className="pr-3">{l.side}{l.reduceOnly?' exit':''}</td><td>{l.status} / {value(l.cumulativeFilledSize)}</td></tr>)}</tbody></table></div></div>
  </div></details>;
}
export function GridBotDrawer({id,createEnabled,onClose,onAdjust}:{id:string;createEnabled:boolean;onClose:()=>void;onAdjust:(intent:GridIntent)=>void}){
  const [surface,setSurface]=useState<GridBotSurface|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[chart,setChart]=useState(false),[adjust,setAdjust]=useState(false),[now,setNow]=useState(Date.now());
  const [confirm,setConfirm]=useState<'start'|'stop'|'adjust'|null>(null);
  const reader=useRef<AbortController|null>(null);
  const reads=useRef(new GridReadOrder()),keys=useRef(new GridActionKeys()),alive=useRef(true),writing=useRef(false),adjusting=useRef(false),createAllowed=useRef(createEnabled),handled=useRef(false);
  createAllowed.current=createEnabled;
  const load=async()=>{if(writing.current)return;reader.current?.abort();reader.current=new AbortController();const seq=reads.current.next();try{const next:GridBotSurface=await gridJson('/'+id+'/surface',{signal:reader.current.signal});if(!alive.current||!reads.current.accepts(seq))return;
      setSurface(next);setNow(Date.now());
      if(adjusting.current&&createAllowed.current&&gridCanAdjust(next)&&gridAdjustReady(next)&&next.bot.createIntent&&!handled.current){handled.current=true;onAdjust({...next.bot.createIntent,rangeSource:'manual'});}
    }catch{if(alive.current&&reads.current.accepts(seq)){setSurface(null);setMessage('Current bot state unavailable. Actions are disabled until refreshed.');}}};
  useEffect(()=>{alive.current=true;void load();const timer=setInterval(()=>void load(),10000),clock=setInterval(()=>setNow(Date.now()),1000);return()=>{alive.current=false;reader.current?.abort();reads.current.next();clearInterval(timer);clearInterval(clock);};},[id]);
  const act=async(action:GridOwnerAction,forAdjust=false)=>{if(writing.current||!surface||!gridVisibleActions(surface).includes(action))return;
    writing.current=true;reads.current.next();reader.current?.abort();setBusy(true);setMessage('Submitting '+action+' request…');
    if(forAdjust){adjusting.current=true;setAdjust(true);}
    try{await gridJson('/'+id+'/'+action,{method:'POST',body:JSON.stringify({requestId:keys.current.key(id,action,()=>crypto.randomUUID())})});keys.current.accepted(id,action);if(alive.current)setMessage('Request recorded. Waiting for confirmed venue state.');}
    catch(e){if(alive.current)setMessage((e as Error).message+'. Refresh state; a manual retry uses the same request identity.');}
    finally{writing.current=false;if(alive.current){setBusy(false);void load();}}
  };
  const start=async()=>{
    if(writing.current||!surface?.startEnabled||surface.bot.status!=='draft'||!surface.startDraft)return;
    writing.current=true;reads.current.next();reader.current?.abort();setBusy(true);setMessage('Checking launch authority…');
    try{const result=await submitGridStart(id,surface.startDraft,(path,options)=>gridJson(path.slice('/api/grid-bots'.length),options));if(alive.current)setMessage(result.reason??'Launch recorded. Waiting for exchange confirmation.');}
    catch(error){if(alive.current)setMessage((error as Error).message+' Refresh state before retrying this draft.');}
    finally{writing.current=false;if(alive.current){setBusy(false);void load();}}
  };
  const canAdjust=createEnabled&&!!surface&&gridCanAdjust(surface);
  return <Sheet open onOpenChange={open=>{if(!open)onClose();}}><SheetContent className="flex h-full w-full flex-col p-0 sm:max-w-2xl overflow-hidden">
    <SheetHeader className="border-b px-6 py-4 text-left"><div className="flex items-center justify-between gap-3"><SheetTitle>{surface?.bot.market??'Pacifica'} Grid Bot</SheetTitle><div className="flex shrink-0 gap-1"><Button variant="ghost" size="icon" disabled={busy} aria-label="Refresh state" title="Refresh state" onClick={()=>void load()}><RefreshCw className="h-4 w-4"/></Button><Button variant="ghost" size="icon" aria-label="Close bot details" title="Close bot details" onClick={onClose}><X className="h-4 w-4"/></Button></div></div><SheetDescription>{!surface?'Loading worker state…':surface.workerRunning?(surface.startEnabled?'Grid worker running; new Starts enabled.':'Grid worker running; new Starts off.'):'Grid worker off or unavailable.'}</SheetDescription></SheetHeader>
    <div className="flex-1 space-y-5 overflow-y-auto px-6 py-4">
      <p role="status" aria-live="polite" className="text-sm">{message||(!surface?'Loading current bot state…':'')}</p>
      {surface?<><GridBotOverview surface={surface} now={now}/><Button variant="outline" onClick={()=>setChart(true)}>Open trade chart</Button><GridBotDetails surface={surface} now={now}/></>:null}
    </div>
    <div className="space-y-2 border-t bg-background p-4"><div className="flex flex-wrap gap-2">{surface?.startEnabled&&surface.bot.status==='draft'&&surface.startDraft?<Button disabled={busy} onClick={()=>setConfirm('start')}>Start bot</Button>:null}{surface&&gridVisibleActions(surface).map(action=><Button key={action} variant={action==='stop'?'destructive':'outline'} disabled={busy} onClick={()=>action==='stop'?setConfirm('stop'):void act(action)}>{action==='resync'?'Re-sync':action[0].toUpperCase()+action.slice(1)}</Button>)}</div>
      {canAdjust&&<Button variant="outline" disabled={busy||adjust} onClick={()=>{if(!surface?.bot.createIntent)return;if(gridAdjustReady(surface))onAdjust({...surface.bot.createIntent,rangeSource:'manual'});else setConfirm('adjust');}}>Adjust Range</Button>}
      {(canAdjust||adjust)&&<p className="text-xs text-muted-foreground">Adjust Range stops this bot to confirmed terminal status, then opens a new editable draft. {adjust?'Waiting for terminal settlement. You may close this drawer; reopen and choose Adjust Range to continue.':''}</p>}
    </div>
    <AlertDialog open={confirm!==null} onOpenChange={open=>{if(!open)setConfirm(null);}}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{confirm==='start'?'Start this Grid bot?':confirm==='adjust'?'Stop before adjusting range?':'Stop this Grid bot?'}</AlertDialogTitle><AlertDialogDescription>{confirm==='start'&&surface?gridStartConfirmation(surface.bot.totalInvestment,surface.bot.seedAtCreation===true):'This requests cancellation and a reduce-only close of the residual position. Settlement remains pending until exchange confirmation.'}{confirm==='adjust'?' A new editable draft opens only after confirmed terminal settlement.':''}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Keep bot</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={()=>confirm==='start'?void start():void act('stop',confirm==='adjust')}>{confirm==='start'?'Confirm Start':'Confirm Stop'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    {chart&&surface?<GridBotChart surface={surface} onClose={()=>setChart(false)}/>:null}
  </SheetContent></Sheet>;
}
