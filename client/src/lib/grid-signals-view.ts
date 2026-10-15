import { gridDirectionText } from './grid-direction-view';
import type { GridDirectionSuggestion } from '../../../shared/grid-direction';
import { btcUtcWeekStart, BTC_TREND_WEEK_MS } from '../../../shared/grid-direction';
import { WEEKLY_SWING_BASIS, type GridSignals, type SignalDirection } from '../../../shared/grid-signals';
import type { GridRegime } from '../../../shared/grid-regime';
import { gridHistoryWindow } from '../../../shared/grid-lookback';

export interface GridSignalView {
  name: 'Macro' | 'Weekly structure' | 'Trend' | 'Funding';
  direction: SignalDirection; unavailable: boolean; summary: string; brief?: string; detail: string; basis: string;
}
const utc = (time: number) => new Date(time).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
const explanations: Record<GridSignalView['name'], string> = {
  Macro: 'This is the broad BTC market backdrop, even when you choose another market. The last finalized BTC weekly close is compared with the simple average of 50 weekly closes. Above that average favours long grids; below it favours short grids. It is a slow backdrop, not a forecast for your selected market.',
  'Weekly structure': 'This describes the selected market\'s longer-term price direction using confirmed weekly swing highs and lows. Higher highs and higher lows favour long grids; lower highs and lower lows favour short grids. Mixed structure gives no clear preference between long and short grids. Confirmation takes time, so recent turns may not appear yet.',
  Trend: 'ADX measures trend strength; +DI and −DI indicate its direction. Sideways conditions can suit either long or short grids, but do not guarantee a safe range. Outside sideways conditions, higher +DI suggests long grids and higher −DI suggests short grids. A strong trend can carry price beyond a grid\'s range.',
  Funding: 'Funding is an hourly payment between holders of long and short perpetual positions. A positive rate means long grids pay and short grids receive; a negative rate reverses that. Multiply the hourly rate by 8 or 24 for the displayed estimates if the rate holds. Payments depend on open position value, not total grid investment; receiving funding does not ensure profit.',
};
const unknown = (name: GridSignalView['name'], reason: string, basis: string): GridSignalView => ({
  name, direction: 'neutral', unavailable: true, summary: 'Unavailable',
  detail: `${reason}${name === 'Weekly structure' ? ` ${WEEKLY_SWING_BASIS}` : name === 'Trend' ? ' Below 20: sideways; 20–25: transitional; above 25: trending.' : ''}`,
  basis: `${basis} As-of unavailable.`,
});
const numeric = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
const stamp = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0;
export function isGridSignals(value: unknown, market: string): value is GridSignals {
  if (!value || typeof value !== 'object') return false;
  const v = value as GridSignals;
  if (v.market !== market || !stamp(v.serverNow)) return false;
  const w = v.weekly, f = v.funding;
  const unavailable = (s: unknown) => !!s && typeof s === 'object' && (s as { state: string }).state === 'unavailable'
    && typeof (s as { reason: string }).reason === 'string' && (s as { reason: string }).reason.length > 0;
  if (!unavailable(w)) {
    if (!w || w.state !== 'available' || w.market !== market || !['long', 'short', 'neutral'].includes(w.direction)
      || !['okx', 'gate', 'hyperliquid', 'pacifica'].includes(w.venue)
      || !stamp(w.asOf) || w.asOf !== btcUtcWeekStart(v.serverNow) || !stamp(w.retrievedAt)
      || w.asOf > w.retrievedAt || w.retrievedAt > v.serverNow || w.expiresAt !== w.asOf + BTC_TREND_WEEK_MS
      || !Number.isInteger(w.weeks) || w.weeks < 7 || w.weeks > 52) return false;
    for (const pair of [w.highs, w.lows]) if (!Array.isArray(pair) || pair.length !== 2 || !pair.every((s, i) =>
      s && stamp(s.time) && s.time === btcUtcWeekStart(s.time) && s.time + 3 * BTC_TREND_WEEK_MS <= w.asOf
      && s.time >= w.asOf - w.weeks * BTC_TREND_WEEK_MS && numeric(s.price) && s.price > 0
      && (!i || s.time > pair[i - 1].time))) return false;
  }
  if (!unavailable(f) && (!f || f.state !== 'available' || f.market !== market || !numeric(f.hourlyRate)
    || !Number.isFinite(f.hourlyRate * 2400) || !['next-hour estimate', 'last settled hour'].includes(f.basis)
    || !stamp(f.observedAt) || f.observedAt > v.serverNow || !stamp(f.expiresAt) || f.expiresAt <= v.serverNow)) return false;
  return true;
}

export function gridSignalViews(macro: GridDirectionSuggestion | null, signals: GridSignals | null,
  market: string, timeframe: string, regime: GridRegime): GridSignalView[] {
  const current = signals?.market === market ? signals : null;
  const macroText = gridDirectionText(macro);
  const macroView: GridSignalView = macro && macro.regime !== 'unavailable' ? {
    name: 'Macro', direction: macro.regime === 'above' ? 'long' : 'short', unavailable: false,
    summary: `BTC ${macro.regime} its 50-week average`,
    detail: `BTC weekly close ${macro.lastClose.toLocaleString()} versus 50-week average ${macro.movingAverage.toLocaleString()}.`,
    basis: `${macroText.basis} Persisted weekly observation; retrieved ${utc(macro.retrievedAt)}.`,
  } : unknown('Macro', macroText.basis, 'BTC weekly close versus its 50-week average; persisted weekly source pool.');
  const weekly = current?.weekly;
  const weeklyView: GridSignalView = weekly?.state === 'available' ? {
    name: 'Weekly structure', direction: weekly.direction, unavailable: false,
    summary: weekly.direction === 'long' ? 'Higher highs and higher lows' : weekly.direction === 'short' ? 'Lower highs and lower lows' : 'Sideways / mixed structure',
    detail: `${WEEKLY_SWING_BASIS} Highs: ${weekly.highs.map(s => `${s.price.toLocaleString()} (${utc(s.time)})`).join(' → ')}. Lows: ${weekly.lows.map(s => `${s.price.toLocaleString()} (${utc(s.time)})`).join(' → ')}.`,
    basis: `${market}, ${weekly.venue.toUpperCase()} direct perpetual pool; ${weekly.weeks} finalized weekly candles aggregated from UTC daily candles. As of ${utc(weekly.asOf)}; swing times are week opens.`,
  } : unknown('Weekly structure', weekly?.reason || 'No fresh finalized weekly history is available.', `${market}; direct perpetual candle pool, UTC weeks.`);
  const usable = regime.state === 'available' && regime.market === market && regime.timeframe === timeframe
    && numeric(regime.plusDi) && numeric(regime.minusDi);
  const trendView: GridSignalView = usable && regime.state === 'available' ? {
    name: 'Trend', direction: regime.label === 'ranging' || regime.plusDi === regime.minusDi ? 'neutral' : regime.plusDi! > regime.minusDi! ? 'long' : 'short', unavailable: false,
    summary: regime.label === 'ranging' ? 'Sideways — suits grids' : `${regime.label === 'transitional' ? 'Transitional' : 'Trending'}; ${regime.plusDi === regime.minusDi ? 'balanced direction' : regime.plusDi! > regime.minusDi! ? 'upward bias' : 'downward bias'}`,
    detail: `ADX(14) ${regime.adx.toFixed(1)}; +DI ${regime.plusDi!.toFixed(1)}, −DI ${regime.minusDi!.toFixed(1)}. Below 20: sideways; 20–25: transitional; above 25: trending.`,
    basis: `${market}, ${regime.venue.toUpperCase()} direct perpetual candles, ${timeframe}; ${regime.bars} finalized context bars (minimum 28). As of ${utc(regime.latestFinalizedTime + (gridHistoryWindow(timeframe, 'day')?.duration || 0))}.`,
  } : unknown('Trend', regime.state === 'unavailable' ? regime.reason : 'Directional indicator data is unavailable.', `${market}; ADX(14) and +DI/−DI on ${timeframe} finalized context candles, minimum 28 bars.`);
  const funding = current?.funding;
  const fundingView: GridSignalView = funding?.state === 'available' ? {
    name: 'Funding', direction: funding.hourlyRate > 0 ? 'short' : funding.hourlyRate < 0 ? 'long' : 'neutral', unavailable: false,
    summary: funding.hourlyRate > 0 ? 'Longs pay shorts' : funding.hourlyRate < 0 ? 'Shorts pay longs' : 'No funding payment at this rate',
    brief: funding.hourlyRate === 0 ? 'No funding payment at this rate' : `${funding.hourlyRate > 0 ? 'Shorts' : 'Longs'} receive about ${Number(Math.abs(funding.hourlyRate * 2400).toPrecision(3))}%/day of position value if this rate holds`,
    detail: `${funding.hourlyRate > 0 ? 'Longs pay shorts' : funding.hourlyRate < 0 ? 'Shorts pay longs' : 'Neither side pays'}: ${Math.abs(funding.hourlyRate * 100).toFixed(5)}% per hour; roughly ${Math.abs(funding.hourlyRate * 800).toFixed(4)}% per 8h / ${Math.abs(funding.hourlyRate * 2400).toFixed(4)}% per day of position notional if unchanged. The arrow marks the receiving side, a cost hint rather than a price forecast.`,
    basis: `${market}, Pacifica /info; hourly funding, ${funding.basis}. Observed ${utc(funding.observedAt)}. Rates can change each hour.`,
  } : unknown('Funding', funding?.reason || 'No fresh funding quote is available.', `${market}; Pacifica /info hourly funding.`);
  return [macroView, weeklyView, trendView, fundingView].map(view => ({
    ...view, detail: `${view.detail} ${explanations[view.name]}${view.unavailable ? ' This observation is unavailable, so it gives no current direction suggestion.' : ''}`,
  }));
}
