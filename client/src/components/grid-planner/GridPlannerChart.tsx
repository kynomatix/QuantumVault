import React, { useEffect, useRef, useState } from 'react';
import { LineStyle, type CandlestickData, type ISeriesPrimitive, type Logical, type UTCTimestamp } from 'lightweight-charts';
import { Maximize2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { createSharedTradePriceChart } from '../SharedTradePriceChart';
import { readableTime, type PlannerChart, type PlannerRange } from '@/lib/grid-planner-view';
import type { GridLine } from '../../../../server/grid-bot/engine-types';
import { gridMeasuredStart } from '../../../../shared/grid-lookback';

function PriceCanvas({ chart, lines, range, period }: { chart: Extract<PlannerChart, { state: 'available' }>; lines: GridLine[]; range: PlannerRange | null; period?: string }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    const canvas = createSharedTradePriceChart(container.current);
    const styles = getComputedStyle(container.current);
    // lightweight-charts 4 expects RGB/hex; resolve the app's HSL tokens in the browser.
    const swatch = document.createElement('span'); swatch.style.display = 'none'; container.current.appendChild(swatch);
    const color = (token: string, alpha = 1) => {
      swatch.style.color = `hsl(${styles.getPropertyValue(`--${token}`).trim()} / ${alpha})`;
      return getComputedStyle(swatch).color;
    };
    const primary = color('primary'), down = color('destructive'), up = color('chart-4');
    const bandColor = color('primary', 0.1);
    canvas.applyOptions({ layout: { textColor: color('muted-foreground') },
      grid: { vertLines: { color: color('border', 0.3) }, horzLines: { color: color('border', 0.3) } },
      timeScale: { borderColor: color('border') }, rightPriceScale: { borderColor: color('border') } });
    const series = canvas.addCandlestickSeries({ upColor: up, downColor: down, borderVisible: false, wickUpColor: up, wickDownColor: down });
    const finalized = chart.candles.filter(c => c.provenance.finality === 'finalized');
    const measuredStart = period && finalized.length ? gridMeasuredStart(chart.timeframe, period, finalized.at(-1)!.time) : null;
    const candles = chart.candles.map(c => {
      const dim = measuredStart !== null && c.time < measuredStart;
      const tint = color(c.close >= c.open ? 'chart-4' : 'destructive', dim ? 0.38 : 1);
      return { time: Math.floor(c.time / 1000) as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close, color: tint, wickColor: tint };
    });
    const uniqueSeconds = candles.every((c, i) => !i || c.time > candles[i - 1].time);
    if (uniqueSeconds) series.setData(candles as CandlestickData[]);
    const periodFill = color('primary', 0.035), periodLine = color('muted-foreground', 0.65), periodText = color('muted-foreground');
    if (measuredStart !== null && chart.candles.length > 1) {
      const duration = chart.candles[1].time - chart.candles[0].time;
      const measuredPeriod: ISeriesPrimitive = { paneViews: () => [{ zOrder: () => 'bottom', renderer: () => ({ draw(target) {
        target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
          const start = canvas.timeScale().logicalToCoordinate((measuredStart - chart.candles[0].time) / duration as Logical);
          const end = canvas.timeScale().logicalToCoordinate(((finalized.at(-1)!.time - chart.candles[0].time) / duration + 1) as Logical);
          if (start === null || end === null) return;
          ctx.save(); ctx.beginPath(); ctx.rect(0, 0, mediaSize.width, mediaSize.height); ctx.clip();
          ctx.fillStyle = periodFill; ctx.fillRect(Math.max(0, start), 0, Math.max(0, end - Math.max(0, start)), mediaSize.height);
          ctx.strokeStyle = periodLine; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
          ctx.beginPath(); ctx.moveTo(start, 0); ctx.lineTo(start, mediaSize.height); ctx.stroke();
          ctx.setLineDash([]); ctx.fillStyle = periodText; ctx.font = '11px sans-serif';
          ctx.fillText('Range period', Math.max(6, start + 6), 16); ctx.restore();
        });
      } }) }] };
      series.attachPrimitive(measuredPeriod);
    }
    const precision = Math.min(12, Math.max(...chart.candles.map(c => String(c.close).split('.')[1]?.length ?? 0),
      ...lines.map(l => l.price.split('.')[1]?.length ?? 0),
      ...[range?.lower, range?.upper, range?.stop].map(p => p?.split('.')[1]?.length ?? 0)));
    series.applyOptions({ priceFormat: { type: 'price', precision, minMove: 10 ** -precision } });
    for (const line of lines) series.createPriceLine({ price: Number(line.price), color: line.role === 'entry' ? color('primary', 0.5) : color('chart-2', 0.5),
      lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `Level ${line.ordinal + 1}` });
    if (lines.length) series.attachPrimitive({
      autoscaleInfo: () => ({ priceRange: { minValue: Number(lines[0].price), maxValue: Number(lines[lines.length - 1].price) } }),
    });
    if (range) {
      const lower = Number(range.lower), upper = Number(range.upper), stop = range.stop === null ? null : Number(range.stop);
      // A native pane primitive follows both axes and resize, with no fabricated candles.
      const band: ISeriesPrimitive = {
        paneViews: () => [{ zOrder: () => 'bottom', renderer: () => ({ draw(target) {
          target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
            const top = series.priceToCoordinate(upper), bottom = series.priceToCoordinate(lower);
            if (top === null || bottom === null) return;
            ctx.save(); ctx.beginPath(); ctx.rect(0, 0, mediaSize.width, mediaSize.height); ctx.clip();
            ctx.fillStyle = bandColor; ctx.fillRect(0, top, mediaSize.width, bottom - top); ctx.restore();
          });
        } }) }],
        autoscaleInfo: () => ({ priceRange: { minValue: Math.min(lower, stop ?? lower), maxValue: Math.max(upper, stop ?? upper) } }),
      };
      series.attachPrimitive(band);
      for (const [price, title] of [[lower, 'Proposed lower'], [upper, 'Proposed upper']] as const)
        series.createPriceLine({ price, title, color: primary, lineWidth: 2, lineStyle: LineStyle.Solid, axisLabelVisible: true });
      if (stop !== null) series.createPriceLine({ price: stop, title: 'Proposed stop', color: down, lineWidth: 2, lineStyle: LineStyle.Solid, axisLabelVisible: true });
    }
    swatch.remove();
    canvas.timeScale().fitContent();
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
        if (container.current) canvas.applyOptions({ width: container.current.clientWidth, height: container.current.clientHeight });
      });
    });
    observer.observe(container.current);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); canvas.remove(); };
  }, [chart, lines, range, period]);
  return <div ref={container} className="h-full min-h-[280px] w-full" aria-label="Direct perpetual candle chart with measured range period, dimmed context candles, proposed range band, stop and hypothetical grid levels" />;
}
export function GridPlannerChart({ chart, lines, range = null, period, stale, loading = false, hasMarket = false, error = '', onRetry, levelMessage }: {
  chart: PlannerChart | null; lines: GridLine[]; range?: PlannerRange | null; stale: boolean; loading?: boolean;
  hasMarket?: boolean; error?: string; onRetry?: () => void; levelMessage?: string; period?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!chart || chart.state === 'unavailable') return <div className="flex min-h-[280px] flex-col items-center justify-center gap-3 rounded-xl border border-border bg-card/40 p-5 text-center">
    <p role="status" className="text-sm text-muted-foreground">{loading ? 'Loading candles…' : hasMarket
      ? 'Candles are temporarily unavailable from the price source. Try again shortly.' : 'Choose a market to load candles.'}</p>
    {!loading && hasMarket && <>
      <p role="alert" className="text-sm text-destructive">{error || chart?.reason || 'The price source did not return usable perpetual candles.'}</p>
      {onRetry && <Button type="button" size="sm" variant="outline" onClick={onRetry}>Retry chart</Button>}
    </>}
    {levelMessage && <p role="status" className="text-xs text-muted-foreground">{levelMessage}</p>}
  </div>;
  const provenance = chart.candles[0].provenance;
  const label = `${provenance.venue.toUpperCase()} direct perpetual candles · ${chart.timeframe} · ${chart.actualBars}/${chart.requestedBars} bars${chart.partial ? ' · partial coverage' : ''}`;
  const note = `Retrieved ${readableTime(chart.retrievedAt)}. Candle times are opening times; forming candles are unfinished. ${stale ? 'Chart cache expired; refresh for a new observation.' : `These are ${provenance.venue.toUpperCase()} trade candle prices, separate from the Pacifica book reference.`}`;
  return <div className="space-y-2">
    <div className="flex items-center justify-between gap-2"><p className="text-xs text-muted-foreground">{label}</p><Button type="button" size="sm" variant="outline" onClick={() => setExpanded(true)} aria-label="Expand Planner chart"><Maximize2 className="h-4 w-4" /></Button></div>
    <div className="h-[300px] rounded-xl border border-border bg-card/40 overflow-hidden"><PriceCanvas chart={chart} lines={lines} range={stale ? null : range} period={period} /></div>
    {levelMessage && <p role="status" className="text-xs text-muted-foreground">{levelMessage}</p>}
    <p className="text-xs text-muted-foreground">{note}</p>
    {period && <p className="text-xs text-muted-foreground">Range period: {period === 'day' ? '24 hours' : period === 'week' ? '7 days' : '30 days'}, ending at the latest finalized candle close. Earlier context candles are dimmed and still feed ATR/ADX.</p>}
    <p className="text-xs text-muted-foreground">Shaded band and solid edges: your proposed range. Dashed lines: quantized levels from the preview labelled above. Red line: proposed stop, not certified liquidation protection.</p>
    <Dialog open={expanded} onOpenChange={setExpanded}><DialogContent className="max-w-[95vw] w-[1200px] max-h-[95dvh] overflow-y-auto"><DialogHeader><DialogTitle className="text-xl">Grid Planner chart</DialogTitle><DialogDescription>{label}</DialogDescription></DialogHeader><div className="h-[65vh]"><PriceCanvas chart={chart} lines={lines} range={stale ? null : range} period={period} /></div>{levelMessage && <p role="status" className="text-xs text-muted-foreground">{levelMessage}</p>}<p className="text-xs text-muted-foreground">{note}</p></DialogContent></Dialog>
  </div>;
}
