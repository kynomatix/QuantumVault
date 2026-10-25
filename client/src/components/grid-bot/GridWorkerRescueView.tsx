import React from 'react';
import {botName,relativeAgo,restrictionText} from '@/lib/grid-worker-copy';
import {rescueBlockers,rescueCopy,rescueOutcome,rescuePhases,rescuePhoneWarnings,rescueStale,rescueStops,rescueTriggers} from '@/lib/grid-worker-rescue-copy';
import {emptyRescueDriver,type RescueDriverState} from '@/lib/grid-worker-rescue-state';
import type {WorkerPresentation} from '@/lib/grid-worker-view';
export interface RescueViewProps {
  state:WorkerPresentation;botId:string;names:ReadonlyMap<string,string>;driverState?:RescueDriverState;
  stopped?:boolean;confirming?:boolean;canSign?:boolean;onConfirm?:()=>void;onCancel?:()=>void;onStart?:()=>void;onContinue?:()=>void;onRefresh?:()=>void;
}
const remaining=(seconds:number)=>seconds<=0?'Checking the latest status':seconds<60?'Under a minute':relativeAgo(seconds);
const known=(map:Readonly<Record<string,string>>,key:string,fallback:string)=>Object.hasOwn(map,key)?map[key]:fallback;
export function GridWorkerRescueView({state:p,botId,names,driverState:d=emptyRescueDriver,stopped=false,confirming=false,canSign=false,onConfirm,onCancel,onStart,onContinue,onRefresh}:RescueViewProps){
  const s=p.status;if(!p.admitted||!s||s.executionMode!=='external')return null;
  const elapsed=p.rescueElapsedSeconds??p.elapsedSeconds,r=s.rescue?.botId===botId?s.rescue:null;
  const local=d.botId===botId,working=local&&(d.driving||['preparing','signing','starting','uncertain'].includes(d.mode));
  const offer=!stopped?s.rescueOffers?.find(o=>o.botId===botId):null;
  const outcome=!working&&r&&!r.live&&(r.unknownOpen||!stopped&&(r.completedSeconds===null||r.completedSeconds+elapsed<1800));
  const shown=working||r?.live||outcome||!!offer,phone=rescuePhoneWarnings(s,names,botId);
  if(!shown&&!phone.length)return null;
  const stale=rescueStale(p),name=botName(names,botId),live=!!r?.live;
  const unknown=!!s.rescue?.unknownOpen||p.control?.phase==='unknown',blocked=!!offer?.blockedBy||!!s.rescue?.live||unknown;
  const validOffer=!!offer&&Object.hasOwn(rescueTriggers,offer.trigger),ready=validOffer&&!blocked&&!stale&&!p.busy&&canSign&&!working;
  const continuing=live&&!d.driving&&['idle','refused'].includes(d.mode)&&r.stepIdleSeconds!==null&&r.stepIdleSeconds+elapsed>=15&&!stale;
  return <section className="gw-surface gw-rescue min-w-0" aria-label="Rescue close">
    {phone.map(text=><p className="gw-red gw-banner" role="status" key={text}>{text}</p>)}
    {shown&&<div className="gw-card">
      <h3 className="gw-name">{live?'Rescue close running':outcome?'Rescue close result':'Rescue close'} · {name}</h3>
      {stale&&<p role="status" className="gw-muted">{rescueCopy.stale}</p>}
      {restrictionText(s).map(text=><p role="status" className="gw-restriction" key={text}>{text}</p>)}
      {live?<>
        <p role="status">{known(rescuePhases,r.phase,rescueCopy.unknownPhase)}</p>
        <p>{r.expiresInSeconds-elapsed>0?'Up to '+remaining(r.expiresInSeconds-elapsed).toLowerCase()+' left':'Checking latest status'}</p>
        <p className="gw-red">{rescueStops(p)}</p><p>{rescueCopy.screen}</p>
        {!d.driving&&<p>{rescueCopy.watching}</p>}
        {continuing&&<div className="gw-actions"><button type="button" disabled={p.busy||p.control?.phase==='unknown'||p.outcome?.saved==='unknown'||!!p.rescueUncertain} onClick={onContinue}>Continue here</button><p className="gw-muted">No new signature needed.</p></div>}
        <p>{rescueCopy.queued}</p><p>{rescueCopy.restart}</p>
      </>:outcome?<>
        <p role="status" className={r?.phase==='complete'&&!r.unknownOpen?'gw-teal':'gw-red'}>{rescueOutcome(r!,elapsed)}</p>
        <p>{rescueCopy.funds}</p><p>{rescueCopy.queued}</p><p>{rescueCopy.pause}</p>
        {r?.unknownOpen&&<><p className="gw-red">{rescueStops(p)}</p><p>{rescueCopy.settlement}</p></>}
      </>:working?<>
        <p role="status">{d.mode==='uncertain'?rescueCopy.uncertain:d.mode==='signing'?'Check your wallet to sign the rescue close.':d.mode==='preparing'?'Preparing the rescue close.':rescueCopy.starting}</p>
        {d.mode==='signing'&&<p className="gw-wallet">Your wallet shows a QV-OWNER-ACTION message with action:break_glass_close and target ending …{botId.slice(-4)}. Sign only if it says that. Signing authorizes rescue orders. Trading fees may apply.</p>}
        {(d.mode==='uncertain'||d.mode==='starting')&&<p>{rescueCopy.screen}</p>}
      </>:<>
        <p>{offer?known(rescueTriggers,offer.trigger,rescueCopy.unavailable):rescueCopy.unavailable}</p>
        {offer?.blockedBy&&<p role="status">{known(rescueBlockers,offer.blockedBy,rescueCopy.unavailable)}</p>}
        {confirming&&<><p>{rescueCopy.lead}</p><p>{rescueCopy.takeover}</p><p>{rescueCopy.screen}</p><p>{rescueCopy.funds}</p><p>After takeover: {rescueCopy.queued} {rescueCopy.pause} {rescueCopy.restart}</p>
          <p>Signing authorizes rescue orders. Trading fees may apply.</p></>}
        <div className="gw-actions"><button type="button" className="gw-danger" disabled={!ready} onClick={confirming?onStart:onConfirm}>{confirming?'Sign rescue close':'Rescue close this bot'}</button>
          {confirming&&<button type="button" onClick={onCancel}>Keep bot</button>}
        </div>
        {!canSign&&validOffer&&<p className="gw-muted">Connect your wallet to sign.</p>}
      </>}
      {outcome&&r?.phase!=='complete'&&offer&&!working&&<>
        {offer.blockedBy&&<p>{known(rescueBlockers,offer.blockedBy,rescueCopy.unavailable)}</p>}
        {confirming&&<><p>{rescueCopy.lead}</p><p>{rescueCopy.takeover}</p><p>{rescueCopy.screen}</p><p>{rescueCopy.funds}</p><p>After takeover: {rescueCopy.queued} {rescueCopy.pause} {rescueCopy.restart}</p></>}
        <div className="gw-actions"><button type="button" className="gw-danger" disabled={!ready} onClick={confirming?onStart:onConfirm}>{confirming?'Sign rescue close':'Rescue close again'}</button>{confirming&&<button type="button" onClick={onCancel}>Keep bot</button>}</div>
        <p className="gw-muted">It checks what was already sent first, so nothing is sent twice.</p>
      </>}
      {local&&d.notice&&<p role="status" className="gw-red">{d.notice}</p>}
      {(!live&&(stale||d.mode==='uncertain'||d.mode==='refused'||!!offer?.blockedBy))&&<div className="gw-actions"><button type="button" onClick={onRefresh}>Check again</button></div>}
      {r&&<details><summary>Details</summary><dl className="gw-rows">
        <div><dt>Control remaining</dt><dd>{r.leaseRemainingSeconds===null?'Unavailable':remaining(r.leaseRemainingSeconds-elapsed)}</dd></div>
        <div><dt>Rescue time remaining</dt><dd>{remaining(r.expiresInSeconds-elapsed)}</dd></div>
        <div><dt>Last step</dt><dd>{r.stepIdleSeconds===null?'Unavailable':relativeAgo(r.stepIdleSeconds+elapsed)}</dd></div>
        {r.live&&r.waitSeconds!==null&&<div><dt>Waiting for earlier orders</dt><dd>{remaining(r.waitSeconds-elapsed)}</dd></div>}
      </dl></details>}
      {(live||working||unknown)&&<p className="gw-muted">{unknown?rescueCopy.unknownLocked:rescueCopy.locked}</p>}
    </div>}
  </section>;
}
