export const SIGNAL_CHART_TIMEFRAMES = ['1h', '2h', '4h', '12h', '1d'] as const;
export type SignalChartTimeframe = typeof SIGNAL_CHART_TIMEFRAMES[number];
export const SIGNAL_CHART_BAR_MS: Record<SignalChartTimeframe, number> = {
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '12h': 43_200_000, '1d': 86_400_000,
};
export function isSignalChartTimeframe(value: unknown): value is SignalChartTimeframe {
  return SIGNAL_CHART_TIMEFRAMES.includes(value as SignalChartTimeframe);
}
/** TradingView intervals are minutes for intraday signals and D/1D for daily. */
export function signalChartTimeframe(value: unknown): SignalChartTimeframe | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim().toLowerCase();
  if (isSignalChartTimeframe(normalized)) return normalized;
  switch (normalized) {
    case '60': return '1h';
    case '120': return '2h';
    case '240': return '4h';
    case '720': return '12h';
    case '1440': case 'd': return '1d';
    default: return null;
  }
}
