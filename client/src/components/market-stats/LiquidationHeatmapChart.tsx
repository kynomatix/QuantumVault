import { useEffect, useRef, useState } from 'react';
import { LineStyle, type UTCTimestamp } from 'lightweight-charts';
import type { LiquidationStats } from '@shared/market-stats';
import { createSharedTradePriceChart } from '../SharedTradePriceChart';
import { chartStyle } from '../chartStyle';
import { createLiquidationHeatmapPrimitive, createLiquidationCandleHalo } from './liquidation-heatmap-primitive';
import { HEAT_COLOR_TIERS, HEAT_COLORS, HEAT_LEGEND, heatmapMinUsd, placeHeatmapTooltip } from './liquidation-heatmap-display';
export { heatColor } from './liquidation-heatmap-primitive';

const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
const compact = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(n);
export default function LiquidationHeatmapChart({ data }: { data: LiquidationStats }) {
  const container = useRef<HTMLDivElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const primitiveRef = useRef<ReturnType<typeof createLiquidationHeatmapPrimitive> | null>(null);
  const [threshold, setThreshold] = useState(0);
  const minUsd = useRef(0);
  minUsd.current = heatmapMinUsd(threshold, data.scaleMaxUsd);
  const [selected, setSelected] = useState({ column: data.columns.length - 1, band: 60 });
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!container.current) return;
    const chart = createSharedTradePriceChart(container.current);
    const series = chart.addCandlestickSeries({ ...chartStyle.candles, priceLineVisible: false, lastValueVisible: false });
    // Model candles remain authoritative within the 30-day window.
    const candles = new Map((data.candles ?? []).map(c => [c.time, c]));
    for (const c of data.columns) candles.set(c.time, { time: c.time, ...c.candle });
    series.setData([...candles.values()].sort((a, b) => a.time - b.time).map(c => ({ ...c, time: c.time / 1000 as UTCTimestamp })));
    chart.timeScale().applyOptions({ fixLeftEdge: true, fixRightEdge: true });
    // Vertical swipes scroll the page; horizontal drag and pinch stay with the chart.
    chart.applyOptions({ handleScroll: { vertTouchDrag: false } });
    series.createPriceLine({ price: data.currentPrice, color: '#e6dfed', lineWidth: 1,
      lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'Last close' });
    const primitive = createLiquidationHeatmapPrimitive(data, chart, series, minUsd);
    primitiveRef.current = primitive;
    series.attachPrimitive(primitive);
    const halo = createLiquidationCandleHalo([...candles.values()], chart, series);
    series.attachPrimitive(halo);
    const show: Parameters<typeof chart.subscribeCrosshairMove>[0] = event => {
      if (!event.point || typeof event.time !== 'number') { setPointer(null); return; }
      const column = data.columns.findIndex(c => c.time === Number(event.time) * 1000);
      if (column < 0) { setPointer(null); return; }
      const price = series.coordinateToPrice(event.point.y);
      if (price === null) return;
      setSelected({ column,
        band: Math.max(0, Math.min(data.columns[0].bins.length - 1, Math.floor((price - data.priceRange.lower) / data.bandWidth))) });
      if (container.current) setPointer(placeHeatmapTooltip(event.point,
        { scrollLeft: 0, width: container.current.clientWidth, height: container.current.clientHeight },
        { width: 256, height: tooltip.current?.offsetHeight ?? 128 }));
    };
    chart.subscribeCrosshairMove(show); chart.subscribeClick(show);
    // Phones open on the latest ~8 days (48 four-hour columns); drag or pinch for the rest.
    const first = container.current.clientWidth < 640 ? Math.max(0, data.columns.length - 48) : 0;
    chart.timeScale().setVisibleRange({ from: data.columns[first].time / 1000 as UTCTimestamp,
      to: data.columns[data.columns.length - 1].time / 1000 as UTCTimestamp });
    const resize = new ResizeObserver(() => {
      if (container.current) chart.applyOptions({ width: container.current.clientWidth, height: container.current.clientHeight });
    });
    resize.observe(container.current);
    return () => { primitiveRef.current = null; resize.disconnect(); chart.unsubscribeCrosshairMove(show); chart.unsubscribeClick(show); series.detachPrimitive(halo); series.detachPrimitive(primitive); chart.remove(); };
  }, [data]);
  const columnIndex = Math.min(selected.column, data.columns.length - 1), bandIndex = Math.min(selected.band, data.columns[0].bins.length - 1);
  const column = data.columns[columnIndex], bins = column.bins[bandIndex];
  const low = data.priceRange.lower + bandIndex * data.bandWidth;
  const date = new Date(column.sampleAsOf).toISOString().replace('T', ' ').slice(0, 16);
  return <>
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground">
      <span>30 days · 4-hour candles and end-of-block exposure · UTC</span><span>Current reference: {money(data.currentPrice)} (last completed close)</span>
    </div>
    <p className="mb-2 text-[10px] text-muted-foreground">Heatmap covers the last 30 days · Drag or pinch to move and zoom; older candles go back 180 days.</p>
    <div className="overflow-hidden rounded-xl border border-border bg-[#0c0c16]" role="region" aria-label="Monthly Bitcoin liquidation chart">
      <div className="relative">
        <div ref={container} className="h-[360px]" role="img" aria-label="Modelled liquidation bands beneath Bitcoin candles. Brighter bands represent larger USD-equivalent exposure. Use the time and price controls below for values." />
        {pointer && <div ref={tooltip} role="tooltip" className="pointer-events-none absolute z-10 w-64 rounded-lg border border-border bg-[#151522] p-3 text-[11px] shadow-xl" style={{ left: pointer.x, top: pointer.y }}>
          <p>{date} UTC</p><p className="mt-1">Band {money(low)}–{money(low + data.bandWidth)}</p>
          <p>{money(bins[0] + bins[1])} modelled</p><p>Long {money(bins[0])} / Short {money(bins[1])}</p>
        </div>}
      </div>
    </div>
    <div className="mt-3 flex flex-wrap items-center justify-end gap-2 text-[10px] text-muted-foreground">
      <span>Modelled USD</span><span>$0</span><span className="h-2 w-28 rounded-sm" style={{ background: HEAT_LEGEND }} /><span>{compact(data.scaleMaxUsd)}</span>
      <label className="ml-2 flex items-center gap-2">Hide below {compact(minUsd.current)}
        <span className="relative inline-flex w-28 pb-2">
          <input type="range" min="0" max="1" step="0.01" value={threshold} className="w-full" style={{ accentColor: HEAT_COLORS[3] }}
            aria-valuetext={`Hide below ${compact(minUsd.current)}`} onChange={e => {
              const next = Number(e.target.value);
              minUsd.current = heatmapMinUsd(next, data.scaleMaxUsd);
              setThreshold(next); primitiveRef.current?.requestRedraw();
            }} />
          <span aria-hidden="true" className="pointer-events-none absolute inset-x-2 bottom-0 h-1">
            {HEAT_COLOR_TIERS.map(tier => <span key={tier} className="absolute h-1 border-l border-muted-foreground" style={{ left: `${tier * 100}%` }} />)}
          </span>
        </span>
      </label>
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
