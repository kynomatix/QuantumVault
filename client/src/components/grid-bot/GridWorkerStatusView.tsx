import React from 'react';
import {aged,cardCopy,drawerCopy,phoneState,relativeAge,resumeReason,restrictionText} from '@/lib/grid-worker-copy';
import {controlsVisible,currentPause,type WorkerAction,type WorkerPresentation} from '@/lib/grid-worker-view';
import {GridWorkerInbox} from './GridWorkerInbox';
export interface WorkerViewProps {state:WorkerPresentation;names:ReadonlyMap<string,string>;canSign:boolean;onAction?:(action:WorkerAction,target:string)=>void;onRefresh?:()=>void;onSeen?:(ids:string[])=>void;expanded?:boolean;rowsCollapsed?:boolean}
export function GridWorkerStatusView({state:p,names,canSign,onAction,onRefresh,onSeen,expanded,rowsCollapsed=false}:WorkerViewProps){
  const s=p.status;if(!p.admitted||!controlsVisible(s)||!s)return null;
  const copy=cardCopy(p),phone=phoneState(p),stale=copy.tone==='muted',paused=currentPause(s),reason=resumeReason(s,stale);
  const monitor=aged(s.ages.monitorPollSeconds,p.elapsedSeconds),worker=aged(s.ages.workerCheckInSeconds,p.elapsedSeconds);
  const busy=p.busy||!canSign,unknown=p.overlay==='save_unknown';
  const sameOutcome=p.outcome?.pauseRevision===s.pauseRevision&&paused;
  const rows=!rowsCollapsed&&(paused||p.overlay==='pausing'||unknown);
  return <section className="gw-surface" aria-label="Grid worker">
    {(phone==='off'||phone==='stale')&&<div className="gw-banner" role="status">
      <strong>{phone==='stale'?'Phone alerts may be off':'Phone alerts are off'}</strong>
      <p>{phone==='stale'?"This page's view of the worker is out of date, so we can't tell whether phone alerts reach you.":monitor===null?"The desktop alert monitor (FRACTAL) hasn't checked in yet. It may be asleep or switched off, so nothing will reach your phone if a grid bot needs you.":`The desktop alert monitor (FRACTAL) hasn't checked in for ${relativeAge(monitor)}. It may be asleep or switched off, so nothing will reach your phone if a grid bot needs you.`}</p>
      {phone==='off'&&<><p>{s.host.observer_fenced?(s.unacknowledgedCritical>0?'New starts and resumes are on hold until the monitor checks in and you acknowledge the alert below.':'New starts and resumes are on hold until the monitor checks in.'):'Running bots carry on as they are. After 5 min without a check-in, new starts and resumes go on hold.'}</p><p className="gw-muted">Wake FRACTAL to turn phone alerts back on.</p></>}
    </div>}
    <div className="gw-card">
      <header><h2>Grid worker</h2><span className="gw-muted">Only you can see this</span></header>
      <p className={'gw-pill gw-'+copy.tone} role="status">● {copy.pill}</p><p>{copy.sentence}</p>
      {restrictionText(s).map(text=><p role="status" className="gw-restriction" key={text}>{text}</p>)}
      {s.cardState==='offline'&&<p>Your phone should be alerting you. If it isn't, the desktop alert monitor (FRACTAL) may be asleep too.</p>}
      {phone==='legacy'&&<p className="gw-muted">Phone alerts watch the worker, not the main app, so they don't cover your grid bots in this mode.</p>}
      {phone==='muted'&&<p className="gw-muted">{monitor===null?"Desktop alert monitor hasn't checked in yet. Phone alerts are off.":`Desktop alert monitor last checked in ${relativeAge(monitor)} ago. Phone alerts are off.`}</p>}
      <p className="gw-muted">{s.executionMode==='legacy'?`Status checked ${relativeAge(p.elapsedSeconds)} ago`:<>{worker===null?'No check-in recorded':`Worker checked in ${relativeAge(worker)} ago`} · Alert monitor {monitor===null?'not yet':`${relativeAge(monitor)} ago`}</>}</p>
      {p.overlay==='signing'&&p.target&&<p className="gw-wallet">Your wallet shows a QV-OWNER-ACTION message with action:{p.target.action} and {p.target.action==='ack_critical'?`target ending …${p.target.target.slice(-4)}`:'target:all'}. Sign only if it says that.</p>}
      {p.notice&&<p role="status" className="gw-red">{p.notice}</p>}
      {rows&&<dl className="gw-rows"><div><dt>Pause saved</dt><dd>{unknown?'Unknown':p.overlay==='pausing'&&!paused?'Saving…':paused?'Yes':'Unknown'}</dd></div>
        <div><dt>{s.executionMode==='legacy'?'Bots paused':'Worker confirmed'}</dt><dd>{s.executionMode==='legacy'?`${s.botsPaused.paused} of ${s.botsPaused.total}`:paused&&s.pauseAckRevision===s.pauseRevision?'Yes':sameOutcome&&p.outcome?.acknowledgementOutcome==='timeout'?'Not after 20 s':p.overlay==='pausing'?'Waiting':'Not confirmed yet'}</dd></div>
        <div><dt>Cancel waiting entry orders</dt><dd>{paused&&s.cancellationsComplete?'Done':paused?'In progress':'Not yet'}</dd></div>
      </dl>}
      <div className="gw-actions">
        {(!paused||unknown)&&<button type="button" className={unknown?'':'gw-primary'} disabled={busy} onClick={()=>onAction?.('pause','all')}>{p.overlay==='signing'&&p.target?.action==='pause'?'Check your wallet…':p.overlay==='pausing'?'Pausing…':unknown?'Pause again':'Pause new grid activity'}</button>}
        {paused&&!unknown&&s.cardState!=='pause_unconfirmed'&&<button type="button" disabled={busy||!!reason} onClick={()=>onAction?.('reset_pause','all')}>Resume new activity</button>}
        {(stale||unknown||s.cardState==='pause_unconfirmed')&&<button type="button" className={unknown?'gw-primary':''} disabled={p.busy} onClick={onRefresh}>Check again</button>}
      </div>
      {!canSign&&<p className="gw-muted">Connect your wallet to sign.</p>}
      {paused&&reason&&<p className="gw-muted">{reason}</p>}
      {paused&&s.cardState==='pause_unconfirmed'&&<p className="gw-muted">The pause stays saved, and the worker picks it up when it next checks in.</p>}
      {s.cardState==='offline'&&<p className="gw-muted">The worker is offline, so it can confirm the pause only when it's back. Orders already on Pacifica stay until then.</p>}
      <GridWorkerInbox status={s} names={names} busy={busy} onAcknowledge={id=>onAction?.('ack_critical','incident:'+id)} onSeen={onSeen} expanded={expanded}/>
    </div>
  </section>;
}
export function GridWorkerDrawerView({state,botId}:{state:WorkerPresentation;botId:string}){
  if(!state.admitted||!controlsVisible(state.status))return null;const line=drawerCopy(state,botId);
  return line?<p className="gw-drawer-line" role="status">{line}</p>:null;
}
