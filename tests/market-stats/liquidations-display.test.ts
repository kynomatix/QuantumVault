import { describe, expect, it, vi } from 'vitest';
import type { IChartApi, ISeriesApi, ISeriesPrimitivePaneRenderer } from 'lightweight-charts';
import { HEAT_COLOR_TIERS, heatmapMinUsd, placeHeatmapTooltip } from '../../client/src/components/market-stats/liquidation-heatmap-display';
import { createLiquidationHeatmapPrimitive, heatColor } from '../../client/src/components/market-stats/liquidation-heatmap-primitive';
import type { LiquidationStats } from '../../shared/market-stats';

describe('heatmap tooltip placement in the visible scroller', () => {
  const viewport = { scrollLeft: 0, width: 390, height: 360 };
  it('places the card to the right when it fits', () => {
    expect(placeHeatmapTooltip({ x: 30, y: 180 }, viewport)).toEqual({ x: 42, y: 100 });
  });
  it('flips left near the right edge of a phone', () => {
    expect(placeHeatmapTooltip({ x: 375, y: 180 }, viewport)).toEqual({ x: 107, y: 100 });
  });
  it('clamps to the visible left margin when neither side fits', () => {
    expect(placeHeatmapTooltip({ x: 150, y: 180 }, viewport).x).toBe(8);
  });
  it('uses scrollLeft for a tap near the visible right edge after scrolling', () => {
    const scrolled = { ...viewport, scrollLeft: 510 };
    const card = placeHeatmapTooltip({ x: 885, y: 180 }, scrolled);
    expect(card.x).toBe(617);
    expect(card.x).toBeGreaterThanOrEqual(518);
    expect(card.x + 256).toBeLessThanOrEqual(892);
  });
  it('clamps to the scrolled left margin', () => {
    expect(placeHeatmapTooltip({ x: 660, y: 180 }, { ...viewport, scrollLeft: 510 }).x).toBe(518);
  });
  it('keeps the card inside the top and bottom of the chart', () => {
    expect(placeHeatmapTooltip({ x: 30, y: 0 }, viewport).y).toBe(8);
    expect(placeHeatmapTooltip({ x: 30, y: 359 }, viewport).y).toBe(224);
    expect(placeHeatmapTooltip({ x: 30, y: 359 }, viewport, { width: 256, height: 150 }).y).toBe(202);
  });
});

describe('heatmap display threshold', () => {
  it('inverts the square-root colour scale and shares its actual tier boundaries', () => {
    expect(heatmapMinUsd(0, 1600)).toBe(0);
    expect(heatmapMinUsd(0.5, 1600)).toBe(400);
    expect(heatmapMinUsd(1, 1600)).toBe(1600);
    expect(HEAT_COLOR_TIERS).toEqual([0.2, 0.45, 0.75]);
    HEAT_COLOR_TIERS.forEach((tier, i) => {
      expect(heatColor(heatmapMinUsd(tier, 1600), 1600)).toBe(['#27203e', '#385a72', '#54b3a0'][i]);
      expect(heatColor(heatmapMinUsd(tier + 0.01, 1600), 1600)).toBe(['#385a72', '#54b3a0', '#eed38a'][i]);
    });
  });

  it('redraws from the live ref, skips only amounts below the threshold, and preserves all tooltip values', () => {
    const bins: [number, number][] = [[0, 0], [3, 6], [4, 6], [30, 50]];
    const data = { columns: [{ time: 0, bins }], priceRange: { lower: 0, upper: 4 }, bandWidth: 1, scaleMaxUsd: 100 } as LiquidationStats;
    const original = structuredClone(data), minUsd = { current: 0 }, requestUpdate = vi.fn();
    const primitive = createLiquidationHeatmapPrimitive(data, {
      timeScale: () => ({ options: () => ({ barSpacing: 5 }), timeToCoordinate: () => 10 }),
    } as unknown as IChartApi, { priceToCoordinate: (p: number) => 40 - p * 10 } as ISeriesApi<'Candlestick'>, minUsd);
    primitive.attached!({ requestUpdate } as Parameters<NonNullable<typeof primitive.attached>>[0]);
    primitive.updateAllViews!();
    const fillRect = vi.fn(), context = { save() {}, beginPath() {}, rect() {}, clip() {}, restore() {}, fillRect };
    const draw = () => primitive.paneViews!()[0].renderer()!.draw({
      useMediaCoordinateSpace: (fn: Function) => fn({ context, mediaSize: { width: 390, height: 360 } }),
    } as Parameters<ISeriesPrimitivePaneRenderer['draw']>[0]);
    draw(); expect(fillRect).toHaveBeenCalledTimes(3); // Default: every nonzero band, as before.
    fillRect.mockClear(); minUsd.current = 10; primitive.requestRedraw(); draw();
    expect(requestUpdate).toHaveBeenCalledTimes(2);
    expect(fillRect.mock.calls).toEqual([[7.5, 10, 5, 10], [7.5, 0, 5, 10]]); // Equality remains visible.
    fillRect.mockClear(); minUsd.current = heatmapMinUsd(0.76, 100); primitive.requestRedraw(); draw();
    expect(fillRect).toHaveBeenCalledOnce();
    expect(data).toEqual(original); // Tooltip and status read these exact, unfiltered bins.
    expect(data.columns[0].bins[1]).toEqual([3, 6]);
    expect(data.columns[0].bins[1][0] + data.columns[0].bins[1][1]).toBe(9);
    primitive.detached!(); primitive.requestRedraw();
    expect(requestUpdate).toHaveBeenCalledTimes(3);
  });
});
