import { useEffect, useRef, useState } from 'react';
import { LineStyle, type ISeriesPrimitive, type Logical, type UTCTimestamp } from 'lightweight-charts';
import type { LiquidationStats } from '@shared/market-stats';
import { createSharedTradePriceChart } from '../SharedTradePriceChart';

const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
const compact = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(n);
export function heatColor(amount: number, max: number) {
  const t = max > 0 ? Math.sqrt(amount / max) : 0;
  return t > 0.75 ? '#eed38a' : t > 0.45 ? '#54b3a0' : t > 0.2 ? '#385a72' : '#27203e';
}
export default function LiquidationHeatmapChart({ data }: { data: LiquidationStats }) {
  const container = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState({ column: data.columns.length - 1, band: 60 });
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!container.current) return;
    const chart = createSharedTradePriceChart(container.current);
    const series = chart.addCandlestickSeries({ upColor: '#75ddc1', downColor: '#f099ad', borderVisible: false,
      wickUpColor: '#a2e9d7', wickDownColor: '#f3b2c0', priceLineVisible: false, lastValueVisible: false });
    series.setData(data.columns.map(c => ({ time: c.time / 1000 as UTCTimestamp, ...c.candle })));
    series.createPriceLine({ price: data.currentPrice, color: '#e6dfed', lineWidth: 1,
      lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'Last close' });
    const primitive: ISeriesPrimitive = {
      autoscaleInfo: () => ({ priceRange: { minValue: data.priceRange.lower, maxValue: data.priceRange.upper } }),
      paneViews: () => [{ zOrder: () => 'bottom', renderer: () => ({ draw(target) {
        target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
          ctx.save(); ctx.beginPath(); ctx.rect(0, 0, mediaSize.width, mediaSize.height); ctx.clip();
          data.columns.forEach((column, index) => {
            const left = chart.timeScale().logicalToCoordinate(index - 0.5 as Logical);
            const right = chart.timeScale().logicalToCoordinate(index + 0.5 as Logical);
            if (left === null || right === null || right < 0 || left > mediaSize.width) return;
            column.bins.forEach(([long, short], band) => {
              const amount = long + short;
              if (!amount) return;
              const bottom = series.priceToCoordinate(data.priceRange.lower + band * data.bandWidth);
              const top = series.priceToCoordinate(data.priceRange.lower + (band + 1) * data.bandWidth);
              if (top === null || bottom === null) return;
              ctx.fillStyle = heatColor(amount, data.scaleMaxUsd);
              ctx.fillRect(left, top, Math.max(1, right - left), Math.max(1, bottom - top));
            });
          });
          ctx.restore();
        });
      } }) }],
    };
    series.attachPrimitive(primitive);
    const show: Parameters<typeof chart.subscribeCrosshairMove>[0] = event => {
      if (!event.point || event.logical === undefined || event.logical === null) { setPointer(null); return; }
      const price = series.coordinateToPrice(event.point.y);
      if (price === null) return;
      setSelected({ column: Math.max(0, Math.min(data.columns.length - 1, Math.round(event.logical))),
        band: Math.max(0, Math.min(data.columns[0].bins.length - 1, Math.floor((price - data.priceRange.lower) / data.bandWidth))) });
      setPointer({ x: Math.max(8, Math.min(event.point.x + 12, (container.current?.clientWidth ?? 900) - 280)),
        y: Math.max(8, event.point.y - 80) });
    };
    chart.subscribeCrosshairMove(show); chart.subscribeClick(show); chart.timeScale().fitContent();
    const resize = new ResizeObserver(() => {
      if (container.current) chart.applyOptions({ width: container.current.clientWidth, height: container.current.clientHeight });
    });
    resize.observe(container.current);
    return () => { resize.disconnect(); chart.unsubscribeCrosshairMove(show); chart.unsubscribeClick(show); series.detachPrimitive(primitive); chart.remove(); };
  }, [data]);
  const columnIndex = Math.min(selected.column, data.columns.length - 1), bandIndex = Math.min(selected.band, data.columns[0].bins.length - 1);
  const column = data.columns[columnIndex], bins = column.bins[bandIndex];
  const low = data.priceRange.lower + bandIndex * data.bandWidth;
  const date = new Date(column.sampleAsOf).toISOString().replace('T', ' ').slice(0, 16);
  return <>
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground">
      <span>30 days · 4-hour candles and end-of-block exposure · UTC</span><span>Current reference: {money(data.currentPrice)} (last completed close)</span>
    </div>
    <div className="max-w-full overflow-x-auto overscroll-x-contain rounded-xl border border-border bg-[#0c0c16]" role="region" aria-label="Scrollable monthly Bitcoin liquidation chart" tabIndex={0}>
      <div className="relative min-w-[900px]">
        <div ref={container} className="h-[360px]" role="img" aria-label="Modelled liquidation bands beneath Bitcoin candles. Brighter bands represent larger USD-equivalent exposure. Use the time and price controls below for values." />
        {pointer && <div role="tooltip" className="pointer-events-none absolute z-10 w-64 rounded-lg border border-border bg-[#151522] p-3 text-[11px] shadow-xl" style={{ left: pointer.x, top: pointer.y }}>
          <p>{date} UTC</p><p className="mt-1">Band {money(low)}–{money(low + data.bandWidth)}</p>
          <p>{money(bins[0] + bins[1])} modelled</p><p>Long {money(bins[0])} / Short {money(bins[1])}</p>
        </div>}
      </div>
    </div>
    <div className="mt-3 flex flex-wrap items-center justify-end gap-2 text-[10px] text-muted-foreground">
      <span>Modelled USD</span><span>$0</span><span className="h-2 w-28 rounded-sm" style={{ background: 'linear-gradient(90deg,#27203e,#385a72,#54b3a0,#eed38a)' }} /><span>{compact(data.scaleMaxUsd)}</span>
    </div>
    <p role="status" aria-live="polite" className="mt-3 min-h-10 text-xs leading-relaxed text-muted-foreground">{date} UTC · {money(low)}–{money(low + data.bandWidth)} · {money(bins[0] + bins[1])} modelled · Long {money(bins[0])} / Short {money(bins[1])}</p>
    <details className="mt-2 text-xs text-muted-foreground"><summary className="w-fit cursor-pointer text-violet-300">Explore chart values</summary>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label>4-hour sample<select className="mt-1 block w-full rounded border border-border bg-card p-2" value={columnIndex}
          onChange={e => setSelected(s => ({ ...s, column: Number(e.target.value) }))}>
          {data.columns.map((c, i) => <option key={c.time} value={i}>{new Date(c.sampleAsOf).toISOString().slice(0, 16).replace('T', ' ')} UTC</option>)}
        </select></label>
        <label>Price band<select className="mt-1 block w-full rounded border border-border bg-card p-2" value={bandIndex}
          onChange={e => setSelected(s => ({ ...s, band: Number(e.target.value) }))}>
          {data.columns[0].bins.map((_, i) => <option key={i} value={i}>{money(data.priceRange.lower + i * data.bandWidth)}–{money(data.priceRange.lower + (i + 1) * data.bandWidth)}</option>)}
        </select></label>
      </div>
    </details>
  </>;
}
