import {LineStyle} from 'lightweight-charts';

/** Shared price-chart presentation; independent of any trading feature. */
export const chartStyle = {
  candles: {upColor:'#38bdf8',downColor:'#7854d4',wickUpColor:'#38bdf8',wickDownColor:'#7854d4',borderVisible:false},
  widths: {line:1,breakeven:2},
  range: {opacity:0.1,lineStyle:LineStyle.Solid},
  level: {lineStyle:LineStyle.Dashed,opacity:0.85},
} as const;

export function chartCandleColor(rising:boolean,alpha=1){
  if(alpha===1)return rising?chartStyle.candles.upColor:chartStyle.candles.downColor;
  return rising?`rgba(56,189,248,${alpha})`:`rgba(120,84,212,${alpha})`;
}

/** Resolve app HSL tokens to RGB accepted by lightweight-charts 4. */
export function resolveChartStyle(container:HTMLElement){
  const styles=getComputedStyle(container),swatch=document.createElement('span');
  swatch.style.display='none';container.appendChild(swatch);
  const color=(token:string,alpha=1)=>{
    swatch.style.color=`hsl(${styles.getPropertyValue(`--${token}`).trim()} / ${alpha})`;
    return getComputedStyle(swatch).color;
  };
  try{return {range:color('primary'),rangeFill:color('primary',chartStyle.range.opacity),
    entry:color('primary',chartStyle.level.opacity),exit:color('chart-2',chartStyle.level.opacity),
    stop:color('destructive'),muted:color('muted-foreground')};}
  finally{swatch.remove();}
}
