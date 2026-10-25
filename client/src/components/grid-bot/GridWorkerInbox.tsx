import React,{useState} from 'react';
import {botName,incidentCopy,relativeAge,unknownIncident} from '@/lib/grid-worker-copy';
import type {WorkerIncident,WorkerStatus} from '@/lib/grid-worker-view';
export function inboxGroups(s:WorkerStatus){
  const critical:WorkerIncident[][]=[],notices=new Map<string,WorkerIncident[]>();
  for(const i of s.incidents){
    if(i.severity==='critical'||!incidentCopy[i.code]||incidentCopy[i.code].kind!=='notice'){critical.push([i]);continue;}
    if(i.seen&&i.last_seen_seconds!==null&&i.last_seen_seconds>86400)continue;
    notices.set(i.code,[...(notices.get(i.code)??[]),i]);
  }
  return [...critical,...notices.values()];
}
export function GridWorkerInbox({status:s,names,busy,onAcknowledge,onSeen,expanded=false}:{status:WorkerStatus;names:ReadonlyMap<string,string>;busy:boolean;onAcknowledge?:(id:string)=>void;onSeen?:(ids:string[])=>void;expanded?:boolean}){
  const [manualOpen,setManualOpen]=useState(expanded),[all,setAll]=useState(expanded);
  const groups=inboxGroups(s),open=manualOpen||s.unacknowledgedCritical>0||s.incidents.some(i=>!incidentCopy[i.code]);
  const visible=open?groups.slice(0,all?groups.length:3):[];
  const seen=(items:WorkerIncident[][])=>onSeen?.(items.flat().filter(i=>incidentCopy[i.code]?.kind==='notice'&&i.severity!=='critical').map(i=>i.id));
  return <div className="gw-inbox">
    <button type="button" aria-expanded={open} onClick={()=>{setManualOpen(!manualOpen);if(!manualOpen)seen(groups.slice(0,all?groups.length:3));}}>
      {s.unacknowledgedCritical>0?`${s.unacknowledgedCritical} ${s.unacknowledgedCritical===1?'alert needs':'alerts need'} you`:s.acknowledgedCritical>0?`${s.acknowledgedCritical} acknowledged alerts`:`${s.incidentCounts.warning??0} notices`}
    </button>
    {open&&<>
      {visible.length===0?<p>No alerts to show.</p>:<ul className="gw-list">{visible.map(group=>{
        const i=group[0],copy=incidentCopy[i.code]??unknownIncident,critical=i.severity==='critical'||copy.kind!=='notice';
        const unfinished=['stop_failed','protective_failure'].includes(i.code);
        const named=[...new Set(group.filter(x=>x.bot_id!==null).map(x=>botName(names,x.bot_id)))];
        return <li key={i.id} className="gw-incident"><div className="gw-grow">
          <strong className={critical?'gw-red':'gw-muted'}>{critical?(i.acknowledged?'Acknowledged':'Needs you'):'Notice'}</strong>
          <p>{copy.text}{i.code==='lease_lost'&&i.afterRescue===true?' This happened after your rescue close.':''}{critical&&i.bot_id?<span className="gw-name"> · {botName(names,i.bot_id)}</span>:named.length>0?<span className="gw-name"> · on {new Set(group.map(x=>x.bot_id).filter(Boolean)).size} bots: {named.join(', ')}</span>:null}</p>
          <p className="gw-muted">{relativeAge(i.first_seen_seconds)} ago{critical&&i.acknowledged?(i.resolved_at?' · cleared':copy.kind==='condition'?' · still happening':' · waiting for review'):critical&&i.resolved_at?' · cleared, needs acknowledgement':''}{i.occurrence_count>1?` · happened ${i.occurrence_count} times`:''}</p>
        </div>{critical&&!i.acknowledged?(i.canAcknowledge?<button type="button" disabled={busy} onClick={()=>onAcknowledge?.(i.id)}>Acknowledge</button>:<span className="gw-muted">Review needed</span>):critical&&!i.resolved_at?<span className="gw-muted">{unfinished?'Clears once the bot is closed':copy.kind==='condition'?'Clears once fixed':'Stays open until reviewed'}</span>:null}</li>;
      })}</ul>}
      {!all&&groups.length>3&&<button type="button" onClick={()=>{setAll(true);seen(groups);}}>Show {groups.length-3} more</button>}
      {s.truncated&&<p className="gw-muted">Only the latest returned alerts are listed here. More alerts exist beyond this list.</p>}
      <p className="gw-muted">{s.unacknowledgedCritical+s.acknowledgedCritical>0?"Acknowledging asks your wallet to sign. It records that you've seen the alert; it doesn't fix the problem or resume anything.":"Notices are for your information and don't need a signature."}</p>
    </>}
  </div>;
}
