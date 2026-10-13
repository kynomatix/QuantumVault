import type { GridIntent } from '../../../shared/grid-draft';
import type { GridRegime } from '../../../shared/grid-regime';

export const GRID_SETUP_INITIAL = { market: '', side: 'long', lower: '', upper: '', intervals: '10', entryScale: 'flat', profitScale: 'flat',
  seed: true, leverage: '1', investment: '', stop: '', feePercent: '', timeframe: '1h', bars: '100' };
export type GridSetupForm = typeof GRID_SETUP_INITIAL;
export function gridSetupForm(intent?: GridIntent): GridSetupForm {
  return intent ? { ...GRID_SETUP_INITIAL, market: intent.market, side: intent.direction, lower: intent.lowerPrice, upper: intent.upperPrice,
    intervals: String(intent.gridCount), entryScale: intent.entryScaleType, profitScale: intent.profitScaleType, seed: intent.seedAtCreation,
    leverage: intent.leverage, investment: intent.totalInvestment, stop: intent.stopPrice, timeframe: intent.timeframe, bars: String(intent.lookback) } : { ...GRID_SETUP_INITIAL };
}
export function gridSetupIntent(form: GridSetupForm, stop: string, rangeSource: 'manual' | 'auto'): GridIntent {
  return { schemaVersion: 1, protocol: 'pacifica', market: form.market, direction: form.side as GridIntent['direction'],
    lowerPrice: form.lower, upperPrice: form.upper, stopPrice: stop, gridCount: Number(form.intervals),
    entryScaleType: form.entryScale as GridIntent['entryScaleType'], profitScaleType: form.profitScale as GridIntent['profitScaleType'],
    seedAtCreation: form.seed, totalInvestment: form.investment, leverage: form.leverage, timeframe: form.timeframe as GridIntent['timeframe'],
    lookback: Number(form.bars) as GridIntent['lookback'], rangeSource };
}
export function gridSetupAccess(planner: boolean, drafts: boolean, start: boolean, worker: boolean) {
  return { setup: planner || drafts, drafts, live: drafts && start && worker };
}
export function isGridRegime(value: unknown, market: string, timeframe: string): value is GridRegime {
  const r = value as Extract<GridRegime, { state: 'available' }>;
  if (!r || r.state !== 'available') return (value as GridRegime)?.state === 'unavailable' && typeof (value as { reason?: unknown }).reason === 'string';
  return r.market === market && r.timeframe === timeframe && Number.isFinite(r.adx) && r.adx >= 0 && r.adx <= 100
    && r.label === (r.adx < 20 ? 'ranging' : r.adx <= 25 ? 'transitional' : 'trending')
    && ['okx', 'gate', 'hyperliquid'].includes(r.venue) && Number.isSafeInteger(r.bars) && r.bars >= 28 && r.bars <= 200
    && Number.isSafeInteger(r.latestFinalizedTime) && r.latestFinalizedTime > 0;
}
