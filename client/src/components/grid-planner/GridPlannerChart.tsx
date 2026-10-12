import React, { useEffect, useRef, useState } from 'react';
import { LineStyle, type CandlestickData, type UTCTimestamp } from 'lightweight-charts';
import { Maximize2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { createSharedTradePriceChart } from '../SharedTradePriceChart';
import { readableTime, type PlannerChart } from '@/lib/grid-planner-view';
import type { GridLine } from '../../../../server/grid-bot/engine-types';

function PriceCanvas({ chart, lines }: { chart: Extract<PlannerChart, { state: 'available' }>; lines: GridLine[] }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    const canvas = createSharedTradePriceChart(container.current);
    const series = canvas.addCandlestickSeries({ upColor: '#22c55e', downColor: '#ef4444', borderVisible: false, wickUpColor: '#22c55e', wickDownColor: '#ef4444' });
    const candles = chart.candles.map(c => ({ time: Math.floor(c.time / 1000) as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close }));
    const uniqueSeconds = candles.every((c, i) => !i || c.time > candles[i - 1].time);
    if (uniqueSeconds) series.setData(candles as CandlestickData[]);
    const precision = Math.min(12, Math.max(...chart.candles.map(c => String(c.close).split('.')[1]?.length ?? 0),
      ...lines.map(l => l.price.split('.')[1]?.length ?? 0)));
    series.applyOptions({ priceFormat: { type: 'price', precision, minMove: 10 ** -precision } });
    for (const line of lines) series.createPriceLine({ price: Number(line.price), color: line.role === 'entry' ? '#22c55e' : '#a78bfa',
      lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `Hypothetical ${line.ordinal + 1}` });
    canvas.timeScale().fitContent();
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
        if (container.current) canvas.applyOptions({ width: container.current.clientWidth, height: container.current.clientHeight });
      });
    });
    observer.observe(container.current);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); canvas.remove(); };
  }, [chart, lines]);
  return <div ref={container} className="h-full min-h-[280px] w-full" aria-label="Direct perpetual candle chart with hypothetical grid lines" />;
}
export function GridPlannerChart({ chart, lines, stale }: { chart: PlannerChart | null; lines: GridLine[]; stale: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (!chart || chart.state === 'unavailable') return <p className="text-sm text-muted-foreground">Chart unavailable: {chart?.reason ?? 'choose a market to load candles'}</p>;
  const provenance = chart.candles[0].provenance;
  const label = `${provenance.venue.toUpperCase()} direct perpetual candles · ${chart.timeframe} · ${chart.actualBars}/${chart.requestedBars} bars${chart.partial ? ' · partial coverage' : ''}`;
  return <div className="space-y-2">
    <div className="flex items-center justify-between gap-2"><p className="text-xs text-muted-foreground">{label}</p><Button type="button" size="sm" variant="outline" onClick={() => setExpanded(true)} aria-label="Expand Planner chart"><Maximize2 className="h-4 w-4" /></Button></div>
    <div className="h-[300px]"><PriceCanvas chart={chart} lines={stale ? [] : lines} /></div>
    <p className="text-xs text-muted-foreground">Retrieved {readableTime(chart.retrievedAt)}. Candle times are opening times; forming candles are unfinished. {stale ? 'Chart cache expired; refresh for a new observation.' : 'These are OKX chart prices, separate from the Pacifica book reference.'}</p>
    <Dialog open={expanded} onOpenChange={setExpanded}><DialogContent className="max-w-[95vw] w-[1200px]"><DialogHeader><DialogTitle>Grid Planner chart</DialogTitle><DialogDescription>{label}</DialogDescription></DialogHeader><div className="h-[65vh]"><PriceCanvas chart={chart} lines={stale ? [] : lines} /></div></DialogContent></Dialog>
  </div>;
}
