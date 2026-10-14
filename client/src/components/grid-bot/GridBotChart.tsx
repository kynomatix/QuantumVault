import React,{useEffect,useRef,useState} from 'react';
import {LineStyle,type CandlestickData,type UTCTimestamp,type ISeriesApi,type IPriceLine,type IChartApi} from 'lightweight-charts';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {createSharedTradePriceChart} from '../SharedTradePriceChart';
import type {PlannerChart} from '@/lib/grid-planner-view';
import type {GridBotSurface} from '../../../../shared/grid-surface';
import {gridFactsFresh,gridBreakevenView} from '@/lib/grid-live-view';
import {gridJson} from './GridDraftCard';
function updatePriceLine(series:ISeriesApi<'Candlestick'>,lines:Map<string,IPriceLine>,key:string,price:string|null,title:string,color:string){
  const line=lines.get(key);
  if(price===null||!Number.isFinite(Number(price))||Number(price)<=0){if(line)series.removePriceLine(line);lines.delete(key);return;}
  const options={price:Number(price),title,color,lineWidth:1 as const,lineStyle:LineStyle.Dashed,axisLabelVisible:true};
  if(line)line.applyOptions(options);else lines.set(key,series.createPriceLine(options));
}
function Canvas({chart,surface,fresh,now}:{chart:Extract<PlannerChart,{state:'available'}>;surface:GridBotSurface;fresh:boolean;now:number}){
  const container=useRef<HTMLDivElement>(null);
  const liveLines=useRef<{canvas:IChartApi;series:ISeriesApi<'Candlestick'>;levels:Map<string,IPriceLine>;live:Map<string,IPriceLine>;fitted:boolean;times:UTCTimestamp[]}|null>(null);
  useEffect(()=>{if(!container.current)return;const canvas=createSharedTradePriceChart(container.current);
    const series=canvas.addCandlestickSeries({upColor:'#22c55e',downColor:'#ef4444',borderVisible:false,wickUpColor:'#22c55e',wickDownColor:'#ef4444'});
    liveLines.current={canvas,series,levels:new Map(),live:new Map(),fitted:false,times:[]};
    let frame=0;const observer=new ResizeObserver(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{if(container.current)canvas.applyOptions({width:container.current.clientWidth,height:container.current.clientHeight});});});observer.observe(container.current);
    return()=>{liveLines.current=null;observer.disconnect();cancelAnimationFrame(frame);canvas.remove();};
  },[surface.bot.id,chart.timeframe]);
  useEffect(()=>{const live=liveLines.current;if(!live)return;const {canvas,series,levels}=live;
    const candles=chart.candles.map(c=>({time:Math.floor(c.time/1000) as UTCTimestamp,open:c.open,high:c.high,low:c.low,close:c.close}));
    const timeScale=canvas.timeScale(),viewport=live.fitted?timeScale.getVisibleLogicalRange():null,previousTimes=live.times;
    const valid=candles.every((c,i)=>!i||c.time>candles[i-1].time);
    if(valid){series.setData(candles as CandlestickData[]);live.times=candles.map(c=>c.time);}
    const precision=Math.min(12,Math.max(2,...surface.levels.map(l=>l.price.split('.')[1]?.length??0)));
    series.applyOptions({priceFormat:{type:'price',precision,minMove:10**-precision}});
    const retained=new Set<string>();
    const line=(key:string,price:string|null,title:string,color:string)=>{retained.add(key);updatePriceLine(series,levels,key,price,title,color);};
    for(const l of surface.levels)line('level:'+l.id,l.price,`${l.ordinal} ${l.side} ${l.size} · ${l.status}`,l.reduceOnly?'#a78bfa':'#f59e0b');
    line('lower',surface.bot.lowerPrice,'Lower range','#94a3b8');line('upper',surface.bot.upperPrice,'Upper range','#94a3b8');line('stop',surface.bot.stopLossPrice,'Stop','#ef4444');
    for(const [key,priceLine] of levels)if(!retained.has(key)){series.removePriceLine(priceLine);levels.delete(key);}
    const period=chart.timeframe==='15m'?900:chart.timeframe==='4h'?14400:3600;
    const markers=surface.fills.map(f=>({time:(Math.floor(f.time/1000/period)*period) as UTCTimestamp,position:f.leg==='entry'?'belowBar' as const:'aboveBar' as const,color:f.leg==='entry'?'#f59e0b':'#a78bfa',shape:f.leg==='entry'?'arrowUp' as const:'arrowDown' as const,text:f.leg+' '+f.size+' @ '+f.price})).filter(m=>candles.length&&m.time>=candles[0].time&&m.time<=candles[candles.length-1].time);
    series.setMarkers(markers);
    if(!live.fitted&&valid&&candles.length){timeScale.fitContent();live.fitted=true;}else if(viewport){
      const indices=new Map(live.times.map((time,index)=>[time,index])),anchor=previousTimes.findIndex(time=>indices.has(time));
      const shift=anchor<0?0:indices.get(previousTimes[anchor])!-anchor;
      timeScale.setVisibleLogicalRange({from:viewport.from+shift,to:viewport.to+shift});
    }
  },[chart,surface]);
  useEffect(()=>{const live=liveLines.current;if(!live)return;
    const update=(key:string,price:string|null,title:string,color:string)=>updatePriceLine(live.series,live.live,key,price,title,color);
    update('mark',fresh?surface.mark:null,'Pacifica mark','#38bdf8');
    const b=fresh?gridBreakevenView(surface,now):null;
    update('breakeven',b?.price??null,`Breakeven${b?.percent==null?'':` · ${b.percent}%`}`,b?.tone==='profit'?'#10b981':b?.tone==='loss'?'#ef4444':'#94a3b8');
  },[chart,surface,fresh,now]);
  return <div ref={container} className="h-full w-full" aria-label="Perpetual candle chart with persisted Grid levels, range and stop"/>;
}
export function GridBotChart({surface,onClose}:{surface:GridBotSurface;onClose:()=>void}){
  const [chart,setChart]=useState<PlannerChart|null>(null),[timeframe,setTimeframe]=useState('1h'),[refresh,setRefresh]=useState(0),[expired,setExpired]=useState(false);
  const [now,setNow]=useState(Date.now());useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{setChart(null);setExpired(false);},[surface.bot.id,timeframe]);
  useEffect(()=>{const controller=new AbortController();
    gridJson('/'+surface.bot.id+'/chart?timeframe='+timeframe,{signal:controller.signal}).then(data=>{if(controller.signal.aborted)return;setChart(data);setExpired(false);}).catch(()=>{if(!controller.signal.aborted)setChart({state:'unavailable',reason:'Chart request unavailable'} as PlannerChart);});
    return()=>controller.abort();
  },[surface.bot.id,timeframe,refresh]);
  useEffect(()=>{if(chart?.state!=='available')return;
    const timer=setTimeout(()=>setExpired(true),Math.max(0,chart.retrievedAt+chart.validForMs-Date.now()));return()=>clearTimeout(timer);
  },[chart]);
  return <Dialog open onOpenChange={open=>{if(!open)onClose();}}><DialogContent className="flex max-h-[95dvh] w-[1200px] max-w-[95vw] flex-col overflow-y-auto"><DialogHeader><DialogTitle>{surface.bot.market} Grid trade chart</DialogTitle><DialogDescription>PnL excludes funding. Persisted levels and stop overlay direct perpetual candles; these are chart prices, separate from the Pacifica execution mark.</DialogDescription></DialogHeader>
    <div className="flex flex-wrap gap-2">{['15m','1h','4h'].map(t=><Button key={t} size="sm" variant={t===timeframe?'default':'outline'} aria-pressed={t===timeframe} onClick={()=>setTimeframe(t)}>{t}</Button>)}<Button size="sm" variant="outline" onClick={()=>setRefresh(v=>v+1)}>Refresh chart</Button></div>
    {chart?.state==='available'?<><p className="text-xs">{chart.candles[0]?.provenance.venue.toUpperCase()} · {chart.actualBars}/{chart.requestedBars} bars · {new Date(chart.retrievedAt).toLocaleString()}{expired?' · STALE':''}</p><div className="h-[60dvh] min-h-[280px]"><Canvas chart={chart} surface={surface} fresh={gridFactsFresh(surface,now)} now={now}/></div><p className="text-xs">Levels show the persisted ledger state, not a guarantee of resting venue orders. Up to 100 recent confirmed fills are marked within candle coverage. Forming candles are unfinished.</p></>:<p role="status">{chart?.state==='unavailable'?chart.reason:'Loading chart…'}</p>}
  </DialogContent></Dialog>;
}
