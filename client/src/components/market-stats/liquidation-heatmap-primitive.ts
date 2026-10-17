import type { IChartApi, ISeriesApi, ISeriesPrimitive, ISeriesPrimitivePaneRenderer, ITimeScaleApi, Time, UTCTimestamp } from 'lightweight-charts';
import type { LiquidationColumn, LiquidationStats } from '@shared/market-stats';

export function heatColor(amount: number, max: number) {
  const t = max > 0 ? Math.sqrt(amount / max) : 0;
  return t > 0.75 ? '#eed38a' : t > 0.45 ? '#54b3a0' : t > 0.2 ? '#385a72' : '#27203e';
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

export function createLiquidationHeatmapPrimitive(data: LiquidationStats, chart: IChartApi, series: ISeriesApi<'Candlestick'>): ISeriesPrimitive {
  let columns: ReturnType<typeof mapHeatmapColumns> = [];
  let bands: { top: number; height: number }[] = [];
  const renderer: ISeriesPrimitivePaneRenderer = { draw(target) {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, mediaSize.width, mediaSize.height); ctx.clip();
      for (const { column, left, width } of columns) {
        if (left + width < 0 || left > mediaSize.width) continue;
        column.bins.forEach(([long, short], band) => {
          const amount = long + short, geometry = bands[band];
          if (!amount || !geometry) return;
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
    attached: ({ requestUpdate }) => requestUpdate(),
    autoscaleInfo: () => {
      const visible = chart.timeScale().getVisibleRange();
      if (visible && (Number(visible.to) * 1000 < data.columns[0].time
        || Number(visible.from) * 1000 > data.columns[data.columns.length - 1].time)) return null;
      return { priceRange: { minValue: data.priceRange.lower, maxValue: data.priceRange.upper } };
    },
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
