import Decimal from 'decimal.js';
import { GRID_MODES_CREATION } from '../../../shared/grid-behaviour';
import { gridIntentSchema, type GridIntent } from '../../../shared/grid-draft';
import type { GridSetupForm } from './grid-setup-view';
export type GridSetupMode = 'simple' | 'advanced';
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
const sessionModes = new Map<string, GridSetupMode>();
const mode = (value: unknown): value is GridSetupMode => value === 'simple' || value === 'advanced';
const key = (identity: string, botId?: string) => botId
  ? `grid-setup:bot-mode:v1:${encodeURIComponent(identity)}:${encodeURIComponent(botId)}`
  : `grid-setup:mode:v1:${encodeURIComponent(identity)}`;
export function gridReadMode(identity: string, botId?: string, storage?: Storage): GridSetupMode | null {
  if (!identity) return null;
  let raw: string | null;
  try {
    raw = (storage ?? localStorage).getItem(key(identity, botId));
  } catch { return sessionModes.get(key(identity, botId)) ?? null; }
  try {
    const value = JSON.parse(raw ?? 'null');
    return value?.presetVersion === 1 && mode(value.mode) ? value.mode : null;
  } catch { return null; }
}
export function gridRememberMode(identity: string, value: GridSetupMode, botId?: string, storage?: Storage): void {
  if (identity && mode(value)) sessionModes.set(key(identity, botId), value);
  try {
    if (identity && mode(value)) (storage ?? localStorage).setItem(key(identity, botId), JSON.stringify({ mode: value, presetVersion: 1 }));
  } catch { /* Identity-scoped memory retains this browser session's choice. */ }
}
export function gridSimplePreset(form: GridSetupForm): GridSetupForm {
  return { ...form, lower: '', upper: '', stop: '', intervals: '10', behaviourMode: 'step_back',
    entryScale: 'ascending', profitScale: 'descending', seed: true, timeframe: '1h', rangeWindow: 'week', bars: '100',
    leverage: ['1', '2', '3'].includes(form.leverage) ? form.leverage : '1' };
}
export function gridSimpleCompatible(intent: GridIntent, enabled = GRID_MODES_CREATION): boolean {
  return enabled && gridIntentSchema.safeParse(intent).success && intent.gridCount === 10 && intent.behaviourMode === 'step_back'
    && intent.entryScaleType === 'ascending' && intent.profitScaleType === 'descending' && intent.seedAtCreation
    && intent.timeframe === '1h' && intent.lookback === 100 && intent.rangeSource === 'manual' && ['1', '2', '3'].includes(intent.leverage);
}
export function gridSetupScreen(identity: string, intent?: GridIntent, botId?: string, storage?: Storage): GridSetupMode | 'chooser' {
  if (intent) return botId && gridReadMode(identity, botId, storage) === 'simple' && gridSimpleCompatible(intent) ? 'simple' : 'advanced';
  return gridReadMode(identity, undefined, storage) ?? 'chooser';
}
export function gridSimpleLeverages(maximum: string | null): string[] {
  if (!maximum || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(maximum)) return [];
  return ['1', '2', '3'].filter(value => new Decimal(value).lte(maximum));
}
/** Mirror the shipped (or retained) buffer without replacing it with a planner default. */
export function gridSimpleSideStop(form: GridSetupForm, side: string): string {
  if (side === form.side) return form.stop;
  try {
    const lower = new Decimal(form.lower), upper = new Decimal(form.upper), stop = new Decimal(form.stop);
    const buffer = form.side === 'long' ? lower.minus(stop) : stop.minus(upper);
    const next = side === 'long' ? lower.minus(buffer) : upper.plus(buffer);
    return lower.gt(0) && upper.gt(lower) && buffer.gt(0) && next.gt(0) ? next.toFixed() : '';
  } catch { return ''; }
}
export type GridSimpleIssue = { message: string; action: 'refresh' | 'amount' | 'leverage' | 'market' | 'none' };
/** Diagnostics select a fixed, plain fix; no diagnostic is interpolated into Simple copy. */
export function gridSimpleIssue(input: { reasons?: readonly string[]; minimum?: string | null; investment: string; leverage: string;
  unavailable?: boolean; launchUnavailable?: boolean }): GridSimpleIssue | null {
  if (input.launchUnavailable) return { message: 'Grid launch is unavailable right now.', action: 'none' };
  const reasons = (input.reasons ?? []).join(' ').toLowerCase();
  if (/liquidation|clearance.*stop|stop.*clearance/.test(reasons)) return Number(input.leverage) > 1
    ? { message: 'Try 1x so we can check the stop before liquidation.', action: 'leverage' }
    : { message: "This setup isn't available for this market. Choose another market.", action: 'market' };
  if (/fee.*(?:spacing|spread|clearance)|spread|outside.*range|start.*(?:range|between)/.test(reasons))
    return { message: "This setup isn't available for this market. Choose another market.", action: 'market' };
  // An authoritative minimum belongs to this revision only; callers discard mismatched previews.
  if (input.minimum && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(input.minimum) && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(input.investment)) {
    const shortfall = Decimal.max(0, new Decimal(input.minimum).minus(input.investment)).toDecimalPlaces(2, Decimal.ROUND_CEIL);
    if (shortfall.gt(0)) return { message: `Add $${shortfall.toFixed(2)} to use this setup.`, action: 'amount' };
  }
  if (/minimum|investment|underfund|amount/.test(reasons)) return { message: "We couldn't check the amount. Refresh to try again.", action: 'refresh' };
  return input.unavailable || reasons ? { message: "We couldn't check this setup. Refresh to try again.", action: 'refresh' } : null;
}
