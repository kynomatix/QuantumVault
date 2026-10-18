export const HEAT_COLOR_TIERS = [0.2, 0.45, 0.75] as const;
export const HEAT_COLORS = ['rgba(88,78,218,0.24)', 'rgba(52,125,244,0.34)',
  'rgba(111,90,246,0.58)', 'rgba(206,199,252,0.95)'] as const;
export const HEAT_LEGEND = `linear-gradient(90deg,${HEAT_COLORS.join(',')})`;

/** Invert heatColor's square-root scale; this changes visibility only. */
export function heatmapMinUsd(proportion: number, scaleMaxUsd: number) {
  return Math.max(0, Math.min(1, proportion)) ** 2 * scaleMaxUsd;
}

/** All coordinates are CSS pixels relative to the chart inside its scroller. */
export function placeHeatmapTooltip(
  point: { x: number; y: number },
  viewport: { scrollLeft: number; width: number; height: number },
  size = { width: 256, height: 128 },
) {
  const left = viewport.scrollLeft + 8;
  const right = viewport.scrollLeft + viewport.width - 8;
  let x = point.x + 12;
  if (x + size.width > right) x = point.x - 12 - size.width;
  return {
    x: Math.max(left, Math.min(x, right - size.width)),
    y: Math.max(8, Math.min(point.y - 80, viewport.height - size.height - 8)),
  };
}
