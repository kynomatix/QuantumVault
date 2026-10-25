import React,{useEffect,useRef} from 'react';
import {controlCopy,controlLabels,controlReasons,limitDate} from '@/lib/grid-worker-controls-copy';
import {controlOffer} from '@/lib/grid-worker-controls-offer';
import {emptyControl,type ControlKind} from '@/lib/grid-worker-controls-state';
import {controlsVisible,type WorkerPresentation} from '@/lib/grid-worker-view';
import type {ControlQuotaPolicy,HostTransitionParams} from '../../../../shared/grid-worker-controls';
export interface WorkerControlsProps {
  state:WorkerPresentation;canSign:boolean;onOpen?:(kind:ControlKind)=>void;onCheck?:(checked:boolean)=>void;
  onCancel?:()=>void;onSign?:()=>void;onCheckResult?:()=>void;
}
export function GridWorkerControlsView({state:p,canSign,onOpen,onCheck,onCancel,onSign,onCheckResult}:WorkerControlsProps){
  const panel=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement|null>(null);
  const c=p.control??emptyControl,s=p.status;
  useEffect(()=>{if(c.phase==='confirming')panel.current?.focus();},[c.phase,c.kind]);
  if(!p.admitted||!s||!controlsVisible(s))return null;
  const q=s.quotaPolicy,offer=s.hostTransitionOffer;
  const seconds=q?.earliestSecondsLeft==null?null:q.earliestSecondsLeft-p.elapsedSeconds;
  const showLimits=!q?.available||seconds===null||seconds<=14*86400;
  const kind:ControlKind|null=offer?(offer.direction==='to_test'?'handover':'trading'):s.executionMode==='legacy'?'handover':null;
  const locked=p.busy||p.rescueUncertain||c.phase==='unknown'||p.outcome?.saved==='unknown';
  const active=['preparing','confirming','signing','sending'].includes(c.phase)&&!!c.kind;
  const begin=(k:ControlKind,event:React.MouseEvent<HTMLButtonElement>)=>{trigger.current=event.currentTarget;onOpen?.(k);};
  const reason=(k:ControlKind)=>!canSign?'Connect your wallet to sign.':p.elapsedSeconds>=60||['stale','checking'].includes(p.overlay)?'This opens once this page reaches the server again.':s.rescue?.live||s.rescue?.unknownOpen?controlReasons.rescue:
    (k==='renewal'?s.quotaRenewal?.blockedBy:offer?.blockedBy)?controlReasons[(k==='renewal'?s.quotaRenewal!.blockedBy:offer!.blockedBy)!]:!controlOffer(p,k)?controlCopy.unavailable:'';
  const button=(k:ControlKind)=><button type="button" disabled={locked||!canSign||!controlOffer(p,k)} onClick={e=>begin(k,e)}>{controlLabels[k].button}</button>;
  const request=c.request,renewal=request?.action==='quota_policy'?request.policies as ControlQuotaPolicy[]:null;
  const params=request?.action==='host_transition'?request.params as HostTransitionParams:null;
  return <div className="gw-controls">
    {c.notice&&<p role="status" aria-live="polite" className={c.phase==='saved'?'gw-teal':'gw-red'}>{c.notice}</p>}
    {c.phase==='unknown'&&<button type="button" onClick={onCheckResult}>Check again</button>}
    {kind&&<section>
      <h3>{controlLabels[kind].title}</h3>
      <p>{kind==='handover'?'This hands grid bots to the worker, in test mode first.':'The worker is in test mode. Turning on trading allows real orders, subject to its checks and request limits.'}</p>
      {kind==='trading'&&<p>{controlCopy.fallback}</p>}
      {!active&&c.phase!=='unknown'&&<div className="gw-actions">{button(kind)}</div>}
      {reason(kind)&&<p className="gw-muted">{reason(kind)}</p>}
    </section>}
    {showLimits&&<section className={seconds!==null&&seconds<=0?'gw-red':seconds!==null&&seconds<=3*86400?'gw-amber':'gw-muted'} aria-label="Request limits">
      {!q?.available||!q.earliestValidUntil?<p role="status">Request limits couldn't be checked. Refresh status.</p>:<>
        <p role="status">{seconds!==null&&seconds<=0?'Some request limits have ended. Renew them. Stop or rescue requests may be refused.':`Request limits end on ${limitDate(q.earliestValidUntil)}. When a required limit ends, some worker requests, including stop or close requests, may be refused.`}</p>
        <p>{seconds!==null&&seconds>0?(seconds<86400?'Under a day left.':`${Math.floor(seconds/86400)} ${Math.floor(seconds/86400)===1?'day':'days'} left.`):`Earliest end date: ${limitDate(q.earliestValidUntil)}.`}</p>
        {!active&&c.phase!=='unknown'&&s.quotaRenewal&&<div className="gw-actions">{button('renewal')}</div>}
        {s.quotaRenewal&&reason('renewal')&&<p>{reason('renewal')}</p>}
      </>}
    </section>}
    {active&&<div className="gw-confirm" tabIndex={-1} ref={panel} aria-label="Before you sign">
      <h3>{c.kind==='renewal'?'Renew limits':'Before you sign'}</h3>
      {c.kind==='handover'&&<ul>
        <li>After this, the main app can never run grid bots again, for any user. Only the worker runs them, apart from a rescue close you sign yourself.</li>
        <li>Test mode: the worker checks in, but places no orders and runs no stops.</li>
        <li>New grid activity stays paused until you press Resume new activity.</li>
        <li>There's no way back to the old mode. The main app won't run grid bots again.</li>
      </ul>}
      {c.kind==='trading'&&<ul>
        <li>Grid bots you start can place real orders on Pacifica with real money. Trading fees apply.</li>
        <li>In trading mode, the worker can attempt stops and closes while it is online and request limits are available.</li>
        <li>New grid activity stays paused until you press Resume new activity.</li>
        <li>There's no way back to test mode or to the old mode. You can still pause new activity and request Stop for each bot.</li>
        <li>{controlCopy.waiting}</li>
        <li>If the worker goes down, it cannot run automatic stops. An eligible rescue close needs your signature and available request limits.</li>
      </ul>}
      {params&&<>
        <p>When you sign, the server checks every grid account on Pacifica. If any still holds a position, an order or a balance, it refuses this change.</p>
        <details open><summary>What you're signing</summary><dl className="gw-rows">
          <div><dt>Who runs grid bots</dt><dd>The worker</dd></div>
          <div><dt>Mode</dt><dd>{params.runMode==='test'?'Test: no orders, no stops':'Trading: real orders'}</dd></div>
          <div><dt>New activity</dt><dd>Stays paused</dd></div>
          <div><dt>Main app version</dt><dd>{params.commitHash.slice(0,7)}</dd></div>
          <div><dt>Change number</dt><dd>{params.expectedScopeRevision} → {(BigInt(params.expectedScopeRevision)+1n).toString()}</dd></div>
        </dl></details>
      </>}
      {renewal&&<>
        <p>This keeps the same request limits and moves their end date to {limitDate(renewal[0].valid_until)}.</p>
        {renewal.map(row=><section key={row.provider}><h4>{row.provider==='pacifica_rest'?'Pacifica requests':'Backup RPC requests'}</h4><dl className="gw-rows">
          <div><dt>Total requests per {row.window_ms/1000} seconds</dt><dd>{row.total_units}</dd></div>
          <div><dt>Worker's share</dt><dd>{row.worker_limit_units}</dd></div>
          <div><dt>Kept for stops and closes</dt><dd>{row.worker_protective_reserve_units}</dd></div>
          <div><dt>New end date</dt><dd>{limitDate(row.valid_until)}</dd></div>
        </dl></section>)}
        <p>Requests already used in the current window still count.</p>
      </>}
      {c.message&&<><p>{controlCopy.wallet}</p><pre className="gw-transcript" data-worker-transcript="true">{c.message}</pre><p className="gw-muted">{controlCopy.fingerprint}</p></>}
      <p role="status" aria-live="polite">{c.phase==='preparing'?'Preparing the signature.':c.phase==='signing'?controlLabels[c.kind!].signing:c.phase==='sending'?controlLabels[c.kind!].sending:''}</p>
      <label className="gw-tick"><input type="checkbox" checked={c.checked} disabled={c.phase!=='confirming'} onChange={e=>onCheck?.(e.target.checked)}/>{controlLabels[c.kind!].tick}</label>
      <div className="gw-actions"><button type="button" className="gw-danger" disabled={c.phase!=='confirming'||!c.checked||!canSign||p.busy} onClick={onSign}>{c.phase==='signing'?'Check your wallet…':controlLabels[c.kind!].sign}</button>
        <button type="button" disabled={c.phase!=='confirming'} onClick={()=>{onCancel?.();trigger.current?.focus();}}>Not now</button></div>
    </div>}
  </div>;
}
