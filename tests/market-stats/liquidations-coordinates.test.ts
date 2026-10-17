import { describe, expect, it, vi } from 'vitest';
import type { IChartApi, ISeriesApi, ISeriesPrimitivePaneRenderer, ITimeScaleApi, Time } from 'lightweight-charts';
import { createLiquidationHeatmapPrimitive, mapHeatmapColumns } from '../../client/src/components/market-stats/liquidation-heatmap-primitive';
import { modelLiquidations } from '../../server/market-stats/liquidations-model';
import { END, hour } from './liquidations-fixtures';

describe('heatmap time coordinates', () => {
  const data = () => modelLiquidations(Array.from({ length: 720 }, (_, i) => hour(i, 100 + i)), END).value;
  function scale() {
    let spacing = 5, offset = 0;
    const timeToCoordinate = vi.fn((time: number) => offset + (time - END / 1000) / 14400 * spacing);
    const timeScale = { timeToCoordinate, options: () => ({ barSpacing: spacing }), getVisibleRange: () => null } as unknown as ITimeScaleApi<Time>;
    return { timeScale, timeToCoordinate, move: () => { spacing = 9; offset = -123; } };
  }
  it('maps all 180 columns to their own timestamp with distinct increasing centers and positive widths', () => {
    const value = data(), { timeScale, timeToCoordinate } = scale();
    const mapped = mapHeatmapColumns(value.columns, timeScale);
    expect(mapped).toHaveLength(180);
    mapped.forEach((c, i) => {
      expect(timeToCoordinate).toHaveBeenNthCalledWith(i + 1, value.columns[i].time / 1000);
      expect(c.width).toBe(5); expect(c.left).toBe(c.x - 2.5);
      if (i) expect(c.x).toBeGreaterThan(mapped[i - 1].x);
    });
  });
  it('does not depend on column position, history length or missing series times', () => {
    const { timeScale, timeToCoordinate } = scale(), columns = data().columns;
    const full = mapHeatmapColumns(columns, timeScale);
    expect(mapHeatmapColumns([columns[55], columns[170]], timeScale)).toEqual([full[55], full[170]]);
    timeToCoordinate.mockReturnValueOnce(null as unknown as number);
    expect(mapHeatmapColumns(columns.slice(0, 2), timeScale)).toEqual([full[1]]);
  });
  it('keeps views stable and recomputes geometry after pan, zoom and resize updates', () => {
    const { timeScale, move } = scale(), requestUpdate = vi.fn();
    const value = data();
    const primitive = createLiquidationHeatmapPrimitive(value, { timeScale: () => timeScale } as IChartApi,
      { priceToCoordinate: (p: number) => 400 - p } as ISeriesApi<'Candlestick'>);
    primitive.attached!({ requestUpdate } as Parameters<NonNullable<typeof primitive.attached>>[0]);
    expect(requestUpdate).toHaveBeenCalledOnce();
    expect(primitive.paneViews!()).toBe(primitive.paneViews!());
    const fillRect = vi.fn(), context = { save() {}, beginPath() {}, rect() {}, clip() {}, restore() {}, fillRect };
    const draw = () => primitive.paneViews!()[0].renderer()!.draw({
      useMediaCoordinateSpace: (fn: Function) => fn({ context, mediaSize: { width: 2000, height: 400 } }),
    } as Parameters<ISeriesPrimitivePaneRenderer['draw']>[0]);
    primitive.updateAllViews!(); draw();
    expect(fillRect).toHaveBeenCalled();
    const before = fillRect.mock.calls[0]; fillRect.mockClear();
    move(); primitive.updateAllViews!(); draw();
    const after = fillRect.mock.calls[0];
    expect(before[2]).toBe(5); expect(after[2]).toBe(9); expect(after[0]).not.toBe(before[0]);
  });
  it('lets older candle-only history autoscale without the model price range', () => {
    const { timeScale } = scale(), value = data();
    timeScale.getVisibleRange = () => ({ from: (END / 1000 - 86400) as never, to: (END / 1000 - 14400) as never });
    const primitive = createLiquidationHeatmapPrimitive(value, { timeScale: () => timeScale } as IChartApi, {} as ISeriesApi<'Candlestick'>);
    expect(primitive.autoscaleInfo!(0, 179)).toBeNull();
  });
});
