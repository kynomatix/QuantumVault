import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { walletAuthHeaders } from '@/lib/queryClient';
import { safeResponseJson } from '@/lib/safe-fetch';

interface Detail {
  start:{satisfied:boolean;reason:string|null;message:string};
  isActive:boolean; configured:boolean;
  config:{maxPositionSize:string|null;totalInvestment:string;leverage:number;riskConfig:{stopLossPercent?:number;takeProfitPercent?:number}|null};
  signal:{status:string;reason?:string|null};
  position:{side:string;baseLots:string}|null;
  protection:{conditionalExists:boolean;legs:{triggerTicks:string;direction:string;side:string}[]}|null;
}
export function PhoenixSignalPanel({botId,walletAddress}:{botId:string;walletAddress?:string}) {
  const [detail,setDetail]=useState<Detail|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const [size,setSize]=useState(''),[capital,setCapital]=useState(''),[leverage,setLeverage]=useState('1'),[sl,setSl]=useState(''),[tp,setTp]=useState('');
  const headers=()=>({...walletAuthHeaders(),...(walletAddress?{'x-wallet-address':walletAddress}:{}),'Content-Type':'application/json'});
  async function refresh(fill=false){
    const res=await fetch(`/api/phoenix/bots/${encodeURIComponent(botId)}/runtime`,{headers:headers(),cache:'no-store'});
    const data=await safeResponseJson(res); if(!res.ok) throw new Error(data.error??'Runtime unavailable');
    const next=data as Detail;setDetail(next);
    if(fill){setSize(next.config.maxPositionSize??'');setCapital(next.config.totalInvestment);setLeverage(String(next.config.leverage));setSl(String(next.config.riskConfig?.stopLossPercent??''));setTp(String(next.config.riskConfig?.takeProfitPercent??''));}
  }
  useEffect(()=>{setDetail(null);setMessage('');void refresh(true).catch(()=>setMessage('Runtime observations unavailable; position and protection are unknown.'));},[botId,walletAddress]);
  async function patch(input:Record<string,unknown>){setBusy(true);setMessage('');try{
    const res=await fetch(`/api/trading-bots/${encodeURIComponent(botId)}`,{method:'PATCH',headers:headers(),body:JSON.stringify(input)});
    const data=await safeResponseJson(res);if(!res.ok)throw new Error(data.error??'Configuration refused');
    setMessage(input.isActive===false?`Entries paused. Orders cancelled: ${data.safety?.allOrdersCancelled===true?'confirmed':'unverified'}. Position closed: ${data.safety?.positionClosed===true?'confirmed':'unverified'}.`:'Fixed Signal policy saved. Webhook secret rotated.');
    await refresh();
  }catch(e){setMessage(e instanceof Error?e.message:'Runtime request unavailable');}finally{setBusy(false);}}
  return <section className="space-y-3 rounded-lg border p-3" data-testid="phoenix-signal-panel">
    <p className="font-medium">Phoenix Signal · {detail?.isActive?'Active':'Stopped'}</p>
    <p className="text-sm">{detail?.start?.message ?? 'Check the Lab source in this bot’s Settings.'}</p>
    <div className="flex gap-2"><Button disabled title={detail?.start?.satisfied ? 'Start is controlled by the Phoenix rollout.' : detail?.start?.message ?? 'Lab source is unknown.'}>Start</Button>
      <Button variant="outline" disabled={busy} onClick={()=>void patch({isActive:false})}>Pause and attempt safety</Button>
      <Button variant="outline" disabled={busy} onClick={()=>void refresh().catch(()=>setMessage('Runtime observations unavailable.'))}>Refresh</Button></div>
    <div className="grid grid-cols-2 gap-2">
      {[['Fixed position size (USDC)',size,setSize],['Allocated capital (USDC)',capital,setCapital],['Leverage',leverage,setLeverage],['Stop loss (%)',sl,setSl],['Take profit (%)',tp,setTp]].map(([label,value,setter])=><div key={label as string}>
        <Label htmlFor={`${botId}-${label}`}>{label as string}</Label><Input id={`${botId}-${label}`} value={value as string} inputMode="decimal" disabled={busy} onChange={e=>(setter as (v:string)=>void)(e.target.value)}/></div>)}
    </div>
    <Button variant="outline" disabled={busy||detail?.isActive===true} onClick={()=>void patch({maxPositionSize:size,totalInvestment:capital,leverage:Number(leverage),riskConfig:{stopLossPercent:Number(sl),takeProfitPercent:Number(tp)}})}>Save fixed Signal policy</Button>
    <p className="text-sm">Signal: {detail?.signal.status??'unknown'}{detail?.signal.reason?` · ${detail.signal.reason}`:''}</p>
    <p className="text-sm">Position: {detail?.position?`${detail.position.side} · ${detail.position.baseLots} native lots`:'unknown'}</p>
    <p className="text-sm">TP/SL: {detail?.protection?detail.protection.legs.length?detail.protection.legs.map(leg=>`${detail.position?.side==='long'?(leg.direction==='greater'?'TP':'SL'):detail.position?.side==='short'?(leg.direction==='less'?'TP':'SL'):'Native trigger'}: ${leg.side} at ${leg.direction} ${leg.triggerTicks} ticks`).join('; '):`No native legs · account ${detail.protection.conditionalExists?'ready':'not set up'}`:'unknown'}</p>
    {message&&<p role="status" className="text-sm">{message}</p>}
  </section>;
}
