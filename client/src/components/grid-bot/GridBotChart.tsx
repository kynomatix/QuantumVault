import React,{useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {type CandlestickData,type UTCTimestamp,type ISeriesApi,type IPriceLine,type IChartApi} from 'lightweight-charts';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {createSharedTradePriceChart} from '../SharedTradePriceChart';
import {chartStyle,resolveChartStyle} from '../chartStyle';
import type {PlannerChart} from '@/lib/grid-planner-view';
import type {GridBotSurface} from '../../../../shared/grid-surface';
import {gridCycleDisplayLevels,gridFactsFresh,gridBreakevenView,gridProfitCoversPosition} from '@/lib/grid-live-view';
import {gridJson} from './GridDraftCard';
import {GridChartSourceInfo} from '../grid-planner/GridChartSourceInfo';
function updatePriceLine(series:ISeriesApi<'Candlestick'>,lines:Map<string,IPriceLine>,key:string,price:string|null,title:string,color:string,kind:'level'|'boundary'|'live'='live'){
  const line=lines.get(key);
  if(price===null||!Number.isFinite(Number(price))||Number(price)<=0){if(line)series.removePriceLine(line);lines.delete(key);return;}
  const options={price:Number(price),title:kind==='level'?'':title,color,lineWidth:key==='breakeven'?chartStyle.widths.breakeven:chartStyle.widths.line,lineStyle:kind==='level'?chartStyle.level.lineStyle:chartStyle.range.lineStyle,axisLabelVisible:kind!=='level',...(key==='breakeven'?{axisLabelColor:color,axisLabelTextColor:chartStyle.labels.breakevenText}:key==='stop'?{axisLabelColor:color,axisLabelTextColor:chartStyle.labels.stopText}:{})};
  if(line)line.applyOptions(options);else lines.set(key,series.createPriceLine(options));
}
function Canvas({chart,surface,fresh,now}:{chart:Extract<PlannerChart,{state:'available'}>;surface:GridBotSurface;fresh:boolean;now:number}){
  const cycleProjectionVisible=surface.bot.policyVersion==='2.0.0'&&gridCycleDisplayLevels(surface,now).length>0;
  const container=useRef<HTMLDivElement>(null);
  const [hovered,setHovered]=useState<{price:string;detail:string;left:number;top:number}|null>(null);
  const liveLines=useRef<{canvas:IChartApi;series:ISeriesApi<'Candlestick'>;style:ReturnType<typeof resolveChartStyle>;range:{lower:number;upper:number}|null;levels:Map<string,IPriceLine>;live:Map<string,IPriceLine>;fitted:boolean;times:UTCTimestamp[];hoverLevels:GridBotSurface['levels'];precision:number;prices:number[];breakevenPrice:number|null}|null>(null);
  useEffect(()=>{if(!container.current)return;const canvas=createSharedTradePriceChart(container.current);
    const series=canvas.addCandlestickSeries({...chartStyle.candles,priceLineVisible:false,lastValueVisible:false});
    const state={canvas,series,style:resolveChartStyle(container.current),range:null as {lower:number;upper:number}|null,levels:new Map<string,IPriceLine>(),live:new Map<string,IPriceLine>(),fitted:false,times:[] as UTCTimestamp[],hoverLevels:[] as GridBotSurface['levels'],precision:2,prices:[] as number[],breakevenPrice:null as number|null};
    liveLines.current=state;
    series.attachPrimitive({
      paneViews:()=>[{zOrder:()=> 'bottom',renderer:()=>({draw(target){target.useMediaCoordinateSpace(({context:ctx,mediaSize})=>{
        if(!state.range)return;const top=series.priceToCoordinate(state.range.upper),bottom=series.priceToCoordinate(state.range.lower);
        if(top===null||bottom===null)return;
        ctx.save();ctx.beginPath();ctx.rect(0,0,mediaSize.width,mediaSize.height);ctx.clip();
        ctx.fillStyle=state.style.rangeFill;ctx.fillRect(0,top,mediaSize.width,bottom-top);ctx.restore();
      });}})}],
      autoscaleInfo:()=>{const prices=[...state.prices,...(state.breakevenPrice===null?[]:[state.breakevenPrice])];return prices.length?{priceRange:{minValue:Math.min(...prices),maxValue:Math.max(...prices)}}:null;}
    });
    const showLevel:Parameters<IChartApi['subscribeCrosshairMove']>[0]=event=>{
      const point=event.point;if(!point||!container.current){setHovered(null);return;}
      const nearby=state.hoverLevels.map(level=>{const y=series.priceToCoordinate(Number(level.price));return {level,distance:y===null?Infinity:Math.abs(y-point.y)};}).sort((a,b)=>a.distance-b.distance)[0];
      setHovered(nearby&&nearby.distance<=8?{price:Number(nearby.level.price).toFixed(state.precision),detail:`${nearby.level.ordinal} ${nearby.level.side} ${nearby.level.size} · ${nearby.level.status}`,
        left:Math.max(4,Math.min(point.x+8,container.current.clientWidth-220)),top:Math.max(4,Math.min(point.y-52,container.current.clientHeight-52))}:null);
    };
    canvas.subscribeCrosshairMove(showLevel);canvas.subscribeClick(showLevel);
    let frame=0;const observer=new ResizeObserver(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{if(container.current)canvas.applyOptions({width:container.current.clientWidth,height:container.current.clientHeight});});});observer.observe(container.current);
    return()=>{liveLines.current=null;observer.disconnect();cancelAnimationFrame(frame);canvas.unsubscribeCrosshairMove(showLevel);canvas.unsubscribeClick(showLevel);canvas.remove();};
  },[surface.bot.id,chart.timeframe]);
  useEffect(()=>{const live=liveLines.current;if(!live)return;const {canvas,series,levels}=live;
    const lower=Number(surface.bot.lowerPrice),upper=Number(surface.bot.upperPrice);
    live.range=Number.isFinite(lower)&&lower>0&&Number.isFinite(upper)&&upper>lower?{lower,upper}:null;
    setHovered(null);live.hoverLevels=gridCycleDisplayLevels(surface,now).filter(level=>Number.isFinite(Number(level.price))&&Number(level.price)>0);
    live.prices=[...live.hoverLevels.map(level=>Number(level.price)),...([surface.bot.lowerPrice,surface.bot.upperPrice,surface.bot.stopLossPrice].filter((price):price is string=>price!==null).map(Number))].filter(price=>Number.isFinite(price)&&price>0);
    const candles=chart.candles.map(c=>({time:Math.floor(c.time/1000) as UTCTimestamp,open:c.open,high:c.high,low:c.low,close:c.close}));
    const timeScale=canvas.timeScale(),viewport=live.fitted?timeScale.getVisibleLogicalRange():null,previousTimes=live.times;
    const valid=candles.every((c,i)=>!i||c.time>candles[i-1].time);
    if(valid){series.setData(candles as CandlestickData[]);live.times=candles.map(c=>c.time);}
    const precision=Math.min(12,Math.max(2,...surface.levels.map(l=>l.price.split('.')[1]?.length??0)));
    live.precision=precision;
    series.applyOptions({priceFormat:{type:'custom',minMove:10**-precision,formatter:(price:number)=>'$'+price.toLocaleString('en-US',{minimumFractionDigits:precision,maximumFractionDigits:precision})}});
    const retained=new Set<string>();
    const line=(key:string,price:string|null,title:string,color:string,kind:'level'|'boundary')=>{retained.add(key);updatePriceLine(series,levels,key,price,title,color,kind);};
    for(const l of live.hoverLevels.filter(l=>surface.bot.policyVersion!=='2.0.0'||Number(l.size)>0))line('level:'+l.id,l.price,'',l.reduceOnly?live.style.exit:live.style.entry,'level');
    line('lower',surface.bot.lowerPrice,'Lower range',live.style.range,'boundary');line('upper',surface.bot.upperPrice,'Upper range',live.style.range,'boundary');line('stop',surface.bot.stopLossPrice,'Stop',live.style.stop,'boundary');
    for(const [key,priceLine] of levels)if(!retained.has(key)){series.removePriceLine(priceLine);levels.delete(key);}
    const period=chart.timeframe==='15m'?900:chart.timeframe==='4h'?14400:3600;
    const markers=surface.fills.map(f=>({time:(Math.floor(f.time/1000/period)*period) as UTCTimestamp,position:f.leg==='entry'?'belowBar' as const:'aboveBar' as const,color:f.leg==='entry'?live.style.entry:live.style.exit,shape:f.leg==='entry'?'arrowUp' as const:'arrowDown' as const,text:f.leg+' '+f.size+' @ $'+f.price})).filter(m=>candles.length&&m.time>=candles[0].time&&m.time<=candles[candles.length-1].time);
    series.setMarkers(markers);
    if(!live.fitted&&valid&&candles.length){timeScale.fitContent();live.fitted=true;}else if(viewport){
      const indices=new Map(live.times.map((time,index)=>[time,index])),anchor=previousTimes.findIndex(time=>indices.has(time));
      const shift=anchor<0?0:indices.get(previousTimes[anchor])!-anchor;
      timeScale.setVisibleLogicalRange({from:viewport.from+shift,to:viewport.to+shift});
    }
  },[chart,surface,cycleProjectionVisible]);
  useEffect(()=>{const live=liveLines.current;if(!live)return;
    const update=(key:string,price:string|null,title:string,color:string)=>updatePriceLine(live.series,live.live,key,price,title,color);
    const b=fresh?gridBreakevenView(surface,now):null;
    live.breakevenPrice=b?Number(b.price):null;
    update('breakeven',b?.price??null,'Breakeven',b?.tone==='profit'?live.style.breakevenProfit:b?.tone==='loss'?live.style.breakevenLoss:live.style.muted);
  },[chart,surface,fresh,now]);
  return <div className="relative h-full w-full"><div ref={container} className="h-full w-full" aria-label="Perpetual candle chart with persisted Grid range, mandatory stop and breakeven"/>
    {hovered&&<div role="status" className="pointer-events-none absolute max-w-[min(212px,calc(100%-0.5rem))] break-words rounded border bg-popover px-2 py-1 text-xs text-popover-foreground shadow" style={{left:hovered.left,top:hovered.top}}>Grid price ${hovered.price}<span className="block text-muted-foreground">{hovered.detail}</span></div>}
  </div>;
}
export function GridBotChart({surface,onClose,compact=false}:{surface:GridBotSurface;onClose?:()=>void;compact?:boolean}){
  const [chart,setChart]=useState<PlannerChart|null>(null),[timeframe,setTimeframe]=useState('1h'),[refresh,setRefresh]=useState(0),[expired,setExpired]=useState(false);
  const [now,setNow]=useState(Date.now());useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  const [expanded,setExpanded]=useState(!compact);
  // A stable portal host moves between the compact slot and the existing dialog.
  // Moving its DOM node preserves the chart, viewport and fetched candles.
  const [host]=useState(()=>{if(typeof document==='undefined')return null;const node=document.createElement('div');node.className='h-full w-full';return node;});
  const compactSlot=useRef<HTMLDivElement>(null),fullSlot=useRef<HTMLDivElement>(null);
  useEffect(()=>{const slot=expanded?fullSlot.current:compactSlot.current;if(host&&slot)slot.appendChild(host);},[expanded,chart?.state,host]);
  useEffect(()=>{setChart(null);setExpired(false);},[surface.bot.id,timeframe]);
  useEffect(()=>{const controller=new AbortController();
    gridJson('/'+surface.bot.id+'/chart?timeframe='+timeframe,{signal:controller.signal}).then(data=>{if(controller.signal.aborted)return;setChart(data);setExpired(false);}).catch(()=>{if(!controller.signal.aborted)setChart({state:'unavailable',reason:'Chart request unavailable'} as PlannerChart);});
    return()=>controller.abort();
  },[surface.bot.id,timeframe,refresh]);
  useEffect(()=>{if(chart?.state!=='available')return;
    const timer=setTimeout(()=>setExpired(true),Math.max(0,chart.retrievedAt+chart.validForMs-Date.now()));return()=>clearTimeout(timer);
  },[chart]);
  const unavailable=chart?.state==='unavailable'?chart.reason:'Loading chart…';
  return <>{compact&&<div className="space-y-2"><div className="h-[180px] overflow-hidden rounded-lg border"><div ref={compactSlot} className="h-full w-full"/>{chart?.state!=='available'&&<p role="status" className="p-3 text-xs text-muted-foreground">{unavailable}</p>}</div><div className="flex items-center justify-between gap-2"><p className="text-xs text-muted-foreground">{timeframe} candles{expired?' · stale':''} · excludes funding</p><Button size="sm" variant="outline" onClick={()=>setExpanded(true)}>Open trade chart</Button></div></div>}
    {host&&chart?.state==='available'?createPortal(<Canvas chart={chart} surface={surface} fresh={gridFactsFresh(surface,now)} now={now}/>,host):null}
    <Dialog open={expanded} onOpenChange={open=>{setExpanded(open);if(!open)onClose?.();}}><DialogContent className="flex max-h-[95dvh] w-[1200px] max-w-[95vw] flex-col overflow-y-auto"><DialogHeader><DialogTitle>{surface.bot.market} Grid trade chart</DialogTitle><DialogDescription>PnL excludes funding. Persisted range, mandatory stop and breakeven overlay direct perpetual candles; these are chart prices.</DialogDescription></DialogHeader>
    <div className="flex flex-wrap gap-2">{['15m','1h','4h'].map(t=><Button key={t} size="sm" variant={t===timeframe?'default':'outline'} aria-pressed={t===timeframe} onClick={()=>setTimeframe(t)}>{t}</Button>)}<Button size="sm" variant="outline" onClick={()=>setRefresh(v=>v+1)}>Refresh chart</Button></div>
    {gridProfitCoversPosition(surface,now)&&<p role="status" className="text-sm text-emerald-500">Profit covers your position</p>}
    {chart?.state==='available'?<><GridChartSourceInfo venue={chart.candles[0]?.provenance.venue.toUpperCase()??'Unknown'} timeframe={chart.timeframe}><p>{chart.candles[0]?.provenance.venue.toUpperCase()} direct perpetual candles · {chart.timeframe} · {chart.actualBars}/{chart.requestedBars} bars{chart.partial?' · partial coverage':''}</p><p>Retrieved {new Date(chart.retrievedAt).toLocaleString()}{expired?' · STALE':''}. Candle times are opening times; forming candles are unfinished. These are chart prices.</p></GridChartSourceInfo>{expired&&<p role="status" className="text-xs text-amber-500">Chart cache expired; refresh for a new observation.</p>}<div ref={fullSlot} className="h-[60dvh] min-h-[280px]"/><p className="text-xs">Levels show the persisted ledger state, not a guarantee of resting venue orders. Hover or tap a line for its price and ledger state. Up to 100 recent confirmed fills are marked within candle coverage. Forming candles are unfinished.</p></>:<p role="status">{unavailable}</p>}
  </DialogContent></Dialog></>;
}
