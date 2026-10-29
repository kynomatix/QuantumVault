import type { IChartApi, ISeriesApi, ISeriesPrimitive, ISeriesPrimitivePaneRenderer, ITimeScaleApi, Time, UTCTimestamp } from 'lightweight-charts';
import type { LiquidationColumn, LiquidationStats } from '@shared/market-stats';
import { HEAT_COLOR_TIERS, HEAT_COLORS } from './liquidation-heatmap-display';

export function heatColor(amount: number, max: number) {
  const t = max > 0 ? Math.sqrt(amount / max) : 0;
  return t > HEAT_COLOR_TIERS[2] ? HEAT_COLORS[3] : t > HEAT_COLOR_TIERS[1] ? HEAT_COLORS[2] : t > HEAT_COLOR_TIERS[0] ? HEAT_COLORS[1] : HEAT_COLORS[0];
}

/** Exterior navy underlay leaves even one-pixel QV candle cores intact. */
export function createLiquidationCandleHalo(candles: { time: number; open: number; high: number; low: number; close: number }[],
  chart: IChartApi, series: ISeriesApi<'Candlestick'>): ISeriesPrimitive {
  let points: { x: number; high: number; low: number; open: number; close: number; down: boolean }[] = [];
  const renderer: ISeriesPrimitivePaneRenderer = { draw(target) {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, mediaSize.width, mediaSize.height); ctx.clip();
      ctx.strokeStyle = '#090a10'; ctx.fillStyle = '#090a10'; ctx.lineCap = 'butt';
      const bodyWidth = Math.max(1, Math.floor(chart.timeScale().options().barSpacing * 0.7));
      for (const p of points) {
        // One extra exterior pixel on down candles separates purple from violet heat.
        const halo = p.down ? 2 : 1;
        ctx.lineWidth = 1 + halo * 2; ctx.beginPath();
        const x = Math.round(p.x) + 0.5;
        ctx.moveTo(x, p.high); ctx.lineTo(x, p.low); ctx.stroke();
        ctx.fillRect(Math.round(p.x - bodyWidth / 2) - halo, Math.round(Math.min(p.open, p.close)) - halo,
          bodyWidth + halo * 2, Math.max(1, Math.round(Math.abs(p.open - p.close))) + halo * 2);
      }
      ctx.restore();
    });
  } };
  const views = [{ zOrder: () => 'bottom' as const, renderer: () => renderer }];
  return { paneViews: () => views, updateAllViews() {
    points = candles.flatMap(c => {
      const x = chart.timeScale().timeToCoordinate(c.time / 1000 as UTCTimestamp);
      const high = series.priceToCoordinate(c.high), low = series.priceToCoordinate(c.low);
      const open = series.priceToCoordinate(c.open), close = series.priceToCoordinate(c.close);
      return x === null || high === null || low === null || open === null || close === null ? []
        : [{ x, high, low, open, close, down: c.close < c.open }];
    });
  } };
}

/** Coordinates are CSS/media pixels, just like timeToCoordinate and priceToCoordinate. */
export function mapHeatmapColumns(columns: LiquidationColumn[], timeScale: Pick<ITimeScaleApi<Time>, 'timeToCoordinate' | 'options'>) {
  const width = timeScale.options().barSpacing;
  if (!Number.isFinite(width) || width <= 0) return [];
  return columns.flatMap(column => {
    const x = timeScale.timeToCoordinate(column.time / 1000 as UTCTimestamp);
    return x === null ? [] : [{ column, x, left: x - width / 2, width }];
  });
}

export function createLiquidationHeatmapPrimitive(data: LiquidationStats, chart: IChartApi, series: ISeriesApi<'Candlestick'>,
  minUsd: { current: number } = { current: 0 }): ISeriesPrimitive & { requestRedraw: () => void } {
  let requestRedraw: (() => void) | undefined;
  let columns: ReturnType<typeof mapHeatmapColumns> = [];
  let bands: { top: number; height: number }[] = [];
  const renderer: ISeriesPrimitivePaneRenderer = { draw(target) {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, mediaSize.width, mediaSize.height); ctx.clip();
      for (const { column, left, width } of columns) {
        if (left + width < 0 || left > mediaSize.width) continue;
        column.bins.forEach(([long, short], band) => {
          const amount = long + short, geometry = bands[band];
          if (!amount || amount < minUsd.current || !geometry) return;
          ctx.fillStyle = heatColor(amount, data.scaleMaxUsd);
          ctx.fillRect(left, geometry.top, width, geometry.height);
        });
      }
      ctx.restore();
    });
  } };
  // Keep both the view and its array stable, as required by the primitive API's caches.
  const views = [{ zOrder: () => 'bottom' as const, renderer: () => renderer }];
  return {
    attached: ({ requestUpdate }) => { requestRedraw = requestUpdate; requestUpdate(); },
    detached: () => { requestRedraw = undefined; },
    requestRedraw: () => requestRedraw?.(),
    // No autoscaleInfo: auto-fit follows the visible candles and bands outside the scale clip.
    updateAllViews() {
      columns = mapHeatmapColumns(data.columns, chart.timeScale());
      bands = Array.from({ length: data.columns[0].bins.length }, (_, band) => {
        const bottom = series.priceToCoordinate(data.priceRange.lower + band * data.bandWidth);
        const top = series.priceToCoordinate(data.priceRange.lower + (band + 1) * data.bandWidth);
        return top === null || bottom === null ? { top: 0, height: 0 } : { top, height: Math.max(1, bottom - top) };
      });
    },
    paneViews: () => views,
  };
}
