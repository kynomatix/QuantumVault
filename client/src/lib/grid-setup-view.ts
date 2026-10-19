import { GRID_MODES_CREATION, type GridBehaviourMode } from '../../../shared/grid-behaviour';
import type { GridIntent } from '../../../shared/grid-draft';
import type { GridRegime } from '../../../shared/grid-regime';

export const GRID_SETUP_INITIAL = { market: '', side: 'long', lower: '', upper: '', intervals: '10', entryScale: 'flat', profitScale: 'flat',
  behaviourMode: 'step_back' as GridBehaviourMode, seed: true, leverage: '1', investment: '', stop: '', feePercent: '', timeframe: '1h', bars: '100', rangeWindow: 'week' };
export type GridSetupForm = typeof GRID_SETUP_INITIAL;
export function gridStoredMarket(identity: string): string {
  try { return localStorage.getItem(`grid-setup:last-market:${identity}`) || 'BTC-PERP'; }
  catch { return 'BTC-PERP'; }
}
export function gridRememberMarket(identity: string, market: string): void {
  try { localStorage.setItem(`grid-setup:last-market:${identity}`, market); }
  catch { /* Market selection still works when browser storage is unavailable. */ }
}
export function gridAvailableMarket(preferred: string, markets: readonly { market: string }[]): string {
  if (markets.some(m => m.market === preferred)) return preferred;
  return markets.some(m => m.market === 'BTC-PERP') ? 'BTC-PERP' : markets[0]?.market ?? '';
}
/** Clear old-market geometry synchronously, before either new-market request resolves. */
export function gridMarketChange(form: GridSetupForm, market: string, source: 'manual' | 'auto', percent: number | null) {
  return { form: { ...form, market, lower: '', upper: '', stop: '' },
    mode: source === 'auto' ? 'auto' as const : percent !== null ? 'percent' as const : 'manual' as const,
    note: market ? `Enter a range for ${market}` : '' };
}
export function gridSetupForm(intent: GridIntent | undefined, defaultMarket: string): GridSetupForm {
  return intent ? { ...GRID_SETUP_INITIAL, market: intent.market, side: intent.direction, lower: intent.lowerPrice, upper: intent.upperPrice,
    behaviourMode: intent.behaviourMode ?? 'repeat_all', intervals: String(intent.gridCount), entryScale: intent.entryScaleType, profitScale: intent.profitScaleType, seed: intent.seedAtCreation,
    leverage: intent.leverage, investment: intent.totalInvestment, stop: intent.stopPrice, timeframe: intent.timeframe, bars: String(intent.lookback) } : { ...GRID_SETUP_INITIAL, market: defaultMarket };
}
export function gridSetupIntent(form: GridSetupForm, stop: string, rangeSource: 'manual' | 'auto', timeRangeApplied = false, modesCreation = GRID_MODES_CREATION): GridIntent {
  return { schemaVersion: 1, protocol: 'pacifica', market: form.market, direction: form.side as GridIntent['direction'],
    lowerPrice: form.lower, upperPrice: form.upper, stopPrice: stop, gridCount: Number(form.intervals),
    entryScaleType: form.entryScale as GridIntent['entryScaleType'], profitScaleType: form.profitScale as GridIntent['profitScaleType'],
    ...(modesCreation ? { behaviourMode: form.behaviourMode } : {}), seedAtCreation: form.seed, totalInvestment: form.investment, leverage: form.leverage, timeframe: form.timeframe as GridIntent['timeframe'],
    lookback: Number(form.bars) as GridIntent['lookback'], rangeSource: timeRangeApplied ? 'manual' : rangeSource };
}
export function gridSetupAccess(planner: boolean, drafts: boolean, start: boolean, worker: boolean) {
  return { setup: planner || drafts, drafts, live: drafts && start && worker };
}
export function isGridRegime(value: unknown, market: string, timeframe: string): value is GridRegime {
  const r = value as Extract<GridRegime, { state: 'available' }>;
  if (!r || r.state !== 'available') return (value as GridRegime)?.state === 'unavailable' && typeof (value as { reason?: unknown }).reason === 'string';
  return r.market === market && r.timeframe === timeframe && Number.isFinite(r.adx) && r.adx >= 0 && r.adx <= 100
    && r.label === (r.adx < 20 ? 'ranging' : r.adx <= 25 ? 'transitional' : 'trending')
    && [r.plusDi, r.minusDi].every(di => di === undefined || Number.isFinite(di) && di >= 0 && di <= 100)
    && ['okx', 'gate', 'hyperliquid', 'pacifica'].includes(r.venue) && Number.isSafeInteger(r.bars) && r.bars >= 28 && r.bars <= 200
    && Number.isSafeInteger(r.latestFinalizedTime) && r.latestFinalizedTime > 0;
}
