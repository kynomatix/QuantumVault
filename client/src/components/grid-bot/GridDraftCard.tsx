import React,{useEffect,useRef,useState} from 'react';
import { Button } from '@/components/ui/button';
import { Card,CardContent,CardHeader,CardTitle } from '@/components/ui/card';
import { walletAuthHeaders } from '@/lib/queryClient';
import { readableGridNumber } from '@/lib/grid-draft-view';
import { GridCreateSheet } from './GridCreateSheet';
export function GridDraftCard({authenticated,identity}:{authenticated:boolean;identity:string|null}) {
  const [enabled,setEnabled]=useState(false),[open,setOpen]=useState(false),[bots,setBots]=useState<Record<string,unknown>[]>([]),[detail,setDetail]=useState<Record<string,unknown>|null>(null);
  const epoch=useRef(0);
  const refresh=async()=>{const current=epoch.current;try{const r=await fetch('/api/grid-bots',{credentials:'include',headers:walletAuthHeaders()});if(!r.ok)return;const data=await r.json();if(current===epoch.current)setBots(data.bots);}catch{}};
  const inspect=async(id:string)=>{const current=epoch.current;try{const r=await fetch('/api/grid-bots/'+id,{credentials:'include',headers:walletAuthHeaders()});if(!r.ok)return;const data=await r.json();if(current===epoch.current)setDetail(data.bot);}catch{}};
  useEffect(()=>{epoch.current++;setEnabled(false);setOpen(false);setBots([]);setDetail(null);if(!authenticated)return;const c=new AbortController();fetch('/api/grid-bots/status',{credentials:'include',headers:walletAuthHeaders(),signal:c.signal}).then(async r=>{if(!r.ok)return;const d=await r.json();if(c.signal.aborted)return;setEnabled(d.enabled===true);if(d.enabled===true)void refresh();}).catch(()=>{});return()=>{c.abort();epoch.current++;};},[authenticated,identity]);
  if(!enabled)return null;
  return <Card><CardHeader><CardTitle>Pacifica Grid drafts</CardTitle></CardHeader><CardContent className="space-y-3"><p className="text-sm text-muted-foreground">Save a range and review its costs. Drafts do not trade.</p><Button onClick={()=>setOpen(true)}>Create Grid draft</Button>
    {bots.map(bot=><Button className="block" variant="outline" key={String(bot.id)} onClick={()=>void inspect(String(bot.id))}>{String(bot.market)} · {String(bot.status)}</Button>)}
    {detail?<dl className="grid grid-cols-2 gap-2 text-sm"><dt>Range</dt><dd>{readableGridNumber(String(detail.lowerPrice))}–{readableGridNumber(String(detail.upperPrice))}</dd><dt>Investment</dt><dd>${readableGridNumber(String(detail.totalInvestment),2)}</dd><dt>Stop</dt><dd>{readableGridNumber(typeof detail.stopLossPrice==='string'?detail.stopLossPrice:null)}</dd><dt>Direction / intervals</dt><dd>{String(detail.direction)} / {String(detail.gridCount)}</dd><dt>Status</dt><dd>{String(detail.status)}</dd></dl>:null}
    <GridCreateSheet key={identity??'anonymous'} open={open} onOpenChange={setOpen} onSaved={()=>void refresh()}/>
  </CardContent></Card>;
}
