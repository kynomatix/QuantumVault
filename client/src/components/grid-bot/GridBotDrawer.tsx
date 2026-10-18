import {gridCycleDisplayLevels} from '@/lib/grid-live-view';
import React,{useEffect,useRef,useState} from 'react';
import {RefreshCw,X} from 'lucide-react';
import {Sheet,SheetContent,SheetHeader,SheetTitle,SheetDescription} from '@/components/ui/sheet';
import {Button} from '@/components/ui/button';
import {Switch} from '@/components/ui/switch';
import {AlertDialog,AlertDialogContent,AlertDialogHeader,AlertDialogTitle,AlertDialogDescription,AlertDialogFooter,AlertDialogCancel,AlertDialogAction} from '@/components/ui/alert-dialog';
import {GridReadOrder,GridActionKeys,gridAdjustReady,gridFactsFresh,gridRangeState,gridBreakevenView,gridProfitCoversPosition,gridBreakevenSentence,gridStopProtected,gridVisibleActions,gridCanAdjust,gridCanStartAgain,gridLaunchState,gridAutoResumeView} from '@/lib/grid-live-view';
import {gridStartConfirmation,submitGridStart} from '@/lib/grid-start-view';
import {readableDecimal} from '@/lib/grid-planner-view';
import type {GridBotSurface,GridOwnerAction} from '../../../../shared/grid-surface';
import type {GridIntent} from '../../../../shared/grid-draft';
import {gridJson} from './GridDraftCard';
import {VENUE_OPEN_ORDER_CAPACITY,GRID_PROTECTION_RESERVE} from '../../../../shared/grid-capacity';
import {GridBotChart} from './GridBotChart';
const value=(x:string|number|null|undefined)=>x===null||x===undefined||x==='UNKNOWN'?'—':x;
const price=(x:string|null|undefined)=>x&&x!=='UNKNOWN'?(x.startsWith('-')?'-$'+readableDecimal(x.slice(1)):'$'+readableDecimal(x)):'—';
export function GridBotOverview({surface,now,chart,busy=false,onResume,onReview}:{surface:GridBotSurface;now:number;chart?:React.ReactNode;busy?:boolean;onResume?:()=>void;onReview?:()=>void}){
  const fresh=gridFactsFresh(surface,now),distance=gridBreakevenSentence(surface,now),protectedAtStop=gridStopProtected(surface,now);
  const auto=gridAutoResumeView(surface,now),band=surface.autoResume?.band;
  const status=auto?.state==='waiting'&&band?auto.title+' · resumes between '+price(band.lower)+' and '+price(band.upper):auto?.title??gridLaunchState(surface);
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><p role="status" className="text-lg font-semibold">{status}</p><p className="text-sm">{surface.bot.direction} · {surface.bot.gridCount} grids</p></div><span className="rounded-full border px-2.5 py-1 text-xs font-medium">{gridRangeState(surface,now)}</span></div>
    {auto?.state==='attention'?<div className="space-y-2"><p className="text-sm">{auto.detail}</p><Button variant="outline" disabled={busy} onClick={auto.action==='resume'?onResume:onReview}>{auto.action==='resume'?'Resume':'Review'}</Button></div>:null}
    <div><p className="text-sm text-muted-foreground">Total P&L</p><p className="mt-1 text-3xl font-semibold tabular-nums">{price(fresh?surface.pnl.total:null)}</p><p className="text-xs text-muted-foreground">Excludes funding</p></div>
    {chart}
    {(distance||protectedAtStop)&&<div className="space-y-1 text-xs text-muted-foreground">{distance&&<p>{distance}</p>}{protectedAtStop&&<p>Protected: even if it hits its stop, this bot keeps a profit.</p>}</div>}
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm"><dt className="text-muted-foreground">Range</dt><dd className="text-right tabular-nums">{price(surface.bot.lowerPrice)} – {price(surface.bot.upperPrice)}</dd><dt className="text-muted-foreground">Stop</dt><dd className="text-right tabular-nums">{price(surface.bot.stopLossPrice)}</dd><dt className="text-muted-foreground">Position</dt><dd className="text-right">{fresh&&surface.position?surface.position.size+' '+surface.position.direction:'—'}</dd></dl>
    {!surface.observedAt?<p className="text-xs text-muted-foreground">Not loaded yet.</p>:!fresh?<p className="text-xs text-muted-foreground">Last observation is out of date. Refresh state for current values.</p>:surface.pnl.total===null||!surface.position?<p className="text-xs text-muted-foreground">Not loaded yet.</p>:null}
  </div>;
}
const localDate=(input:string|null|undefined)=>{
  const at=Date.parse(input??'');
  return Number.isFinite(at)?new Date(at).toLocaleString(undefined,{day:'numeric',month:'short',year:'numeric',hour:'numeric',minute:'2-digit'}):'—';
};
export function GridBotDetails({surface,now,busy=false,onAutoResumeChange}:{surface:GridBotSurface;now:number;busy?:boolean;onAutoResumeChange?:(enabled:boolean)=>void}){
  const fresh=gridFactsFresh(surface,now),breakeven=gridBreakevenView(surface,now);
  return <details className="rounded-lg border p-4 text-sm"><summary className="cursor-pointer font-medium">Details</summary><div className="mt-4 space-y-4">
    <GridAutoResumeSetting surface={surface} busy={busy} onChange={onAutoResumeChange}/>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
      <dt>Investment</dt><dd className="text-right tabular-nums">{price(surface.bot.totalInvestment)}</dd>
      <dt>Leverage</dt><dd className="text-right">{value(surface.bot.leverage??surface.bot.createIntent?.leverage)}×</dd>
      <dt>Grids</dt><dd className="text-right">{surface.bot.gridCount}</dd>
      <dt>Started</dt><dd className="text-right">{localDate(surface.qualification.firstConfirmedAt)}</dd>
      <dt>Fees</dt><dd className="text-right tabular-nums">{price(surface.pnl.fees)}</dd>
      <dt>Average entry</dt><dd className="text-right tabular-nums">{price(fresh?surface.pnl.averageEntry:null)}</dd>
      <dt>Realised P&L</dt><dd className="text-right tabular-nums">{price(surface.pnl.realised)}</dd>
      <dt>Unrealised P&L</dt><dd className="text-right tabular-nums">{price(fresh?surface.pnl.unrealised:null)}</dd>
      <dt>Breakeven</dt><dd className={"text-right tabular-nums "+(breakeven?.tone==='profit'?'text-emerald-500':breakeven?.tone==='loss'?'text-red-500':'')}>{gridProfitCoversPosition(surface,now)?'Profit covers your position':price(breakeven?.price)}</dd>
      <dt>Completed cycles</dt><dd className="text-right">{value(surface.cycles)}</dd>
      <dt>Mark price</dt><dd className="text-right tabular-nums">{price(fresh?surface.mark:null)}</dd>
      <dt>USDC left</dt><dd className="text-right tabular-nums">{price(surface.bot.status==='stopped'||fresh?surface.residual:null)}</dd>
    </dl>
    {surface.bot.status==='stopped'&&<p>Run ended · realised P&L {price(surface.endedRun?.realised)} · final breakeven {price(surface.endedRun?.finalBreakeven)}</p>}
    <p className="text-xs text-muted-foreground">Stop protection estimates a close at the stop price, using the higher venue fee plus the approved builder fee limit. Paid fees are already included. Funding and price slippage are excluded; protection is hidden when the fee reading is unavailable or out of date.</p>
  </div></details>;
}
/** Retained diagnostic facts stay in history, outside the user-facing Details. */
export function GridBotHistory({surface,now,historyRef}:{surface:GridBotSurface;now:number;historyRef?:React.RefObject<HTMLDetailsElement|null>}){
  const fresh=gridFactsFresh(surface,now);
  return <details ref={historyRef} className="rounded-lg border p-4 text-sm"><summary className="cursor-pointer font-medium">History and logs</summary><div className="mt-4 space-y-3">
    <p>Draft creation: {surface.draftEnabled?'on':'off'} · New starts: {surface.startConfigured?'on':'off'} · Worker: {surface.workerRunning?'running':'unavailable'}</p>
    <p>Last confirmed return to master: {price(surface.returnedFunds.amount)} · {localDate(surface.returnedFunds.confirmedAt)}. Settlement: {surface.sweep==='Confirmed terminal'?'Settlement complete':surface.sweep}.</p>
    <p>First trading exposure confirmed: {localDate(surface.qualification.firstConfirmedAt)}. Clean period began: {localDate(surface.qualification.cleanSince)} · Qualifying checks: {value(surface.qualification.cleanTicks)} · Qualified: {localDate(surface.qualification.promotedAt)}</p>
    <p>Last observation: {localDate(surface.observedAt)}</p>
    <p>{[surface.lifecycle.action,surface.lifecycle.state].filter(Boolean).join(' · ')||'No pending action'}</p>
    {surface.autoResume?.heldReason&&<p>Auto-resume: {surface.autoResume.heldReason}</p>}
    {surface.lifecycle.blocker&&<p className="break-words">Blocked: {surface.lifecycle.blocker}</p>}
    {surface.operations.map(op=><p key={op.id}>{op.type} · {op.state}</p>)}
    <div className="space-y-1"><h3 className="font-medium">Capacity and launch authorities</h3><p>Ordinary window ceiling: {surface.capacity.ordinaryWindow} · Reserved slots: {surface.capacity.reservedSlots}</p><p>Exchange live orders: {value(fresh?surface.capacity.liveOrders:null)} · Exchange maximum: —</p><p>Proven account capacity: {VENUE_OPEN_ORDER_CAPACITY}. Empty-account ordinary window: {VENUE_OPEN_ORDER_CAPACITY-GRID_PROTECTION_RESERVE}; existing orders and pending sends reduce it.</p><p>History window: {fresh&&surface.authorities.safeWindow?'Inferred from full replay and stable exchange history identifiers':'Unavailable'}</p><p>Resume: {surface.authorities.resume?'Current position, fees, margin and security are rechecked on request':'Worker unavailable'}</p><p>Lost sweep lookup: unavailable; a missing reply remains unconfirmed</p><p>Breaker: retained terminal venue failures; uncertain requests stay unresolved</p><p>Worker: {surface.workerRunning?'Running':surface.workerEnabled?'Configured on; unavailable':'Off'} · New Starts: {surface.startEnabled?'On':'Off'}</p>{surface.entriesBlockedReasons.map(reason=><p key={reason}>Entries blocked: {reason.replaceAll('_',' ')}</p>)}<p>Owner notifications: {surface.notifications.pending} pending · {surface.notifications.uncertain} uncertain delivery</p></div>
    <div><h3 className="font-medium">{surface.bot.policyVersion==='2.0.0'?'Cycling orders':'Grid levels'}</h3><p className="text-xs text-muted-foreground">{surface.bot.policyVersion==='2.0.0'?'Each fill flips to the other side, one grid step away. Partial fills wait until enough has filled to meet the exchange minimum.':'Persisted ledger states; current exchange data may be unavailable.'}</p><div className="mt-2 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="pr-3">Level</th><th className="pr-3">Price</th><th className="pr-3">Size</th><th className="pr-3">Side</th><th>{surface.bot.policyVersion==='2.0.0'?'State':'State / filled'}</th></tr></thead><tbody>{gridCycleDisplayLevels(surface,now).map(l=><tr key={l.id} className="border-t"><td className="py-2">{l.ordinal}</td><td className="pr-3">{price(l.price)}</td><td className="pr-3">{l.size}</td><td className="pr-3">{l.side}{l.reduceOnly?' exit':''}</td><td>{l.status}{surface.bot.policyVersion!=='2.0.0'&&<> / {value(l.cumulativeFilledSize)}</>}</td></tr>)}</tbody></table>{surface.bot.policyVersion==='2.0.0'&&!gridCycleDisplayLevels(surface,now).length&&<p role="status">Waiting for complete cycle history.</p>}</div></div>
  </div></details>;
}
export function GridAutoResumeSetting({surface,busy,onChange}:{surface:GridBotSurface;busy:boolean;onChange?:((enabled:boolean)=>void)}){
  const a=surface.autoResume;
  if(!a||['draft','failed','stopped'].includes(surface.bot.status))return null;
  if(a.unavailableReason==='range_unavailable')return <p className="text-muted-foreground">Auto-resume isn't available for this range.</p>;
  return <div className="flex items-center justify-between gap-4"><label htmlFor="grid-auto-resume" className="font-medium">Auto-resume when price returns</label><Switch id="grid-auto-resume" checked={a.enabled} disabled={busy||!onChange||!a.available&&!a.enabled||surface.bot.status==='stopping'} onCheckedChange={onChange}/></div>;
}
export function GridStartAgain({surface,createEnabled,busy,onAdjust}:{surface:GridBotSurface;createEnabled:boolean;busy:boolean;onAdjust:(intent:GridIntent)=>void}){
  if(!createEnabled||!gridCanStartAgain(surface))return null;
  return <div className="space-y-2"><Button variant="outline" disabled={busy} onClick={()=>{
    if(!busy&&createEnabled&&gridCanStartAgain(surface)&&surface.bot.createIntent)onAdjust({...surface.bot.createIntent,rangeSource:'manual'});
  }}>Start again with the same settings</Button><p className="text-xs text-muted-foreground">Opens an editable draft with your saved settings. A new bot starts a fresh run with a fresh breakeven.</p></div>;
}
export function GridBotDrawer({id,createEnabled,onClose,onAdjust}:{id:string;createEnabled:boolean;onClose:()=>void;onAdjust:(intent:GridIntent)=>void}){
  const [surface,setSurface]=useState<GridBotSurface|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[adjust,setAdjust]=useState(false),[now,setNow]=useState(Date.now());
  const [confirm,setConfirm]=useState<'start'|'stop'|'adjust'|null>(null);
  const reader=useRef<AbortController|null>(null);
  const history=useRef<HTMLDetailsElement>(null);
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
  const setAutoResume=async(enabled:boolean)=>{
    if(writing.current||!surface?.autoResume)return;
    writing.current=true;reads.current.next();reader.current?.abort();setBusy(true);setMessage('Saving auto-resume preference…');
    try{await gridJson('/'+id+'/auto-resume',{method:'POST',body:JSON.stringify({enabled,expectedGeneration:surface.autoResume.generation})});if(alive.current)setMessage(enabled?'Auto-resume enabled. Current safety checks still apply.':'Auto-resume off.');}
    catch(error){if(alive.current)setMessage((error as Error).message+'. Refresh state before changing this preference again.');}
    finally{writing.current=false;if(alive.current){setBusy(false);void load();}}
  };
  const start=async()=>{
    if(writing.current||!surface?.startEnabled||surface.bot.status!=='draft'||!surface.startDraft)return;
    writing.current=true;reads.current.next();reader.current?.abort();setBusy(true);setMessage('Checking launch authority…');
    try{const result=await submitGridStart(id,surface.startDraft,(path,options)=>gridJson(path.slice('/api/grid-bots'.length),options));if(alive.current)setMessage(result.reason??'Launch recorded. Waiting for exchange confirmation.');}
    catch(error){if(alive.current)setMessage((error as Error).message+' Refresh state before retrying this draft.');}
    finally{writing.current=false;if(alive.current){setBusy(false);void load();}}
  };
  const canAdjust=createEnabled&&!!surface&&gridCanAdjust(surface),autoView=surface?gridAutoResumeView(surface,now):null;
  return <Sheet open onOpenChange={open=>{if(!open)onClose();}}><SheetContent className="flex h-full w-full flex-col p-0 sm:max-w-2xl overflow-hidden">
    <SheetHeader className="border-b px-6 py-4 text-left"><div className="flex items-center justify-between gap-3"><SheetTitle>{surface?.bot.market??'Pacifica'} Grid Bot</SheetTitle><div className="flex shrink-0 gap-1"><Button variant="ghost" size="icon" disabled={busy} aria-label="Refresh state" title="Refresh state" onClick={()=>void load()}><RefreshCw className="h-4 w-4"/></Button><Button variant="ghost" size="icon" aria-label="Close bot details" title="Close bot details" onClick={onClose}><X className="h-4 w-4"/></Button></div></div><SheetDescription>{surface?<>Pacifica · {price(surface.bot.totalInvestment)} investment · {value(surface.bot.leverage??surface.bot.createIntent?.leverage)}×</>:'Loading bot details…'}</SheetDescription></SheetHeader>
    <div className="flex-1 space-y-5 overflow-y-auto px-6 py-4">
      <p role="status" aria-live="polite" className="text-sm">{message||(!surface?'Loading current bot state…':'')}</p>
      {surface?<><GridBotOverview surface={surface} now={now} chart={<GridBotChart surface={surface} compact/>} busy={busy} onResume={()=>void act('resume')} onReview={()=>{if(history.current){history.current.open=true;history.current.scrollIntoView({block:'nearest'});}}}/><GridBotDetails surface={surface} now={now} busy={busy} onAutoResumeChange={enabled=>void setAutoResume(enabled)}/><GridBotHistory surface={surface} now={now} historyRef={history}/></>:null}
    </div>
    <div className="space-y-2 border-t bg-background p-4"><div className="flex flex-wrap gap-2">{surface?.startEnabled&&surface.bot.status==='draft'&&surface.startDraft?<Button disabled={busy} onClick={()=>setConfirm('start')}>Start bot</Button>:null}{surface&&gridVisibleActions(surface).filter(action=>action!=='resume'||autoView?.state!=='attention').map(action=><Button key={action} variant={action==='stop'?'destructive':'outline'} disabled={busy} onClick={()=>action==='stop'?setConfirm('stop'):void act(action)}>{action==='resync'?'Re-sync':action[0].toUpperCase()+action.slice(1)}</Button>)}</div>
      {surface&&<GridStartAgain surface={surface} createEnabled={createEnabled} busy={busy||adjust} onAdjust={onAdjust}/>}
      {canAdjust&&surface?.bot.status!=='stopped'&&<Button variant="outline" disabled={busy||adjust} onClick={()=>{if(!surface?.bot.createIntent)return;if(gridAdjustReady(surface))onAdjust({...surface.bot.createIntent,rangeSource:'manual'});else setConfirm('adjust');}}>Adjust Range</Button>}
      {((canAdjust&&surface?.bot.status!=='stopped')||adjust)&&<p className="text-xs text-muted-foreground">Adjust range ends this bot and starts a new setup. {adjust?'Waiting for terminal settlement. You may close this drawer; reopen and choose Adjust Range to continue.':''}</p>}
    </div>
    <AlertDialog open={confirm!==null} onOpenChange={open=>{if(!open)setConfirm(null);}}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{confirm==='start'?'Start this Grid bot?':confirm==='adjust'?'Stop before adjusting range?':'Stop this Grid bot?'}</AlertDialogTitle><AlertDialogDescription>{confirm==='start'&&surface?gridStartConfirmation(surface.bot.totalInvestment,surface.bot.seedAtCreation===true):'This requests cancellation and a reduce-only close of the residual position. Settlement remains pending until exchange confirmation.'}{confirm==='adjust'?' A new editable draft opens only after confirmed terminal settlement.':''}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Keep bot</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={()=>confirm==='start'?void start():void act('stop',confirm==='adjust')}>{confirm==='start'?'Confirm Start':'Confirm Stop'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </SheetContent></Sheet>;
}
