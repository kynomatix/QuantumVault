/** Read-only chart/range windows. Saved draft lookback metadata remains unchanged. */
export const GRID_RANGE_PERIODS = ['day', 'week', 'month'] as const;
export type GridRangePeriod = typeof GRID_RANGE_PERIODS[number];
export const GRID_HISTORY_MAX_BARS = 4_320;
const DAYS = { day: 1, week: 7, month: 30 } as const;
export function gridHistoryWindow(timeframe: string, period: string) {
  const duration = timeframe === '15m' ? 900_000 : timeframe === '1h' ? 3_600_000 : timeframe === '4h' ? 14_400_000 : 0;
  if (!duration || !GRID_RANGE_PERIODS.includes(period as GridRangePeriod)) return null;
  const rangeBars = DAYS[period as GridRangePeriod] * 86_400_000 / duration;
  return { period: period as GridRangePeriod, duration, rangeBars, chartBars: Math.max(100, Math.ceil(rangeBars * 1.5)) };
}

/** Legacy 100/200 requests stay supported; a period and a bar count cannot be mixed. */
export function gridHistoryRequest(timeframe: unknown, period: unknown, bars: unknown) {
  if (typeof timeframe !== 'string') return null;
  if (period !== undefined) {
    if (typeof period !== 'string' || bars !== undefined) return null;
    return gridHistoryWindow(timeframe, period);
  }
  if (!['15m', '1h', '4h'].includes(timeframe) || !['100', '200'].includes(String(bars))) return null;
  return { period: undefined, rangeBars: Number(bars), chartBars: Number(bars) };
}
