import Decimal from 'decimal.js';
import { suggestGridRange } from '../grid-bot/range';
import { plannerRegime } from './regime';
import { marketSnapshot } from './market-snapshot';
import type { PlannerDeps, PlannerChart, PlannerCandle } from './types';
import type { ProvenancedOHLCV } from '../lab/datafeed';
import type { ProtocolMarket } from '../protocol/protocol-types';
import { gridHistoryWindow, type GridRangePeriod } from '../../shared/grid-lookback';
import { atr } from '../lab/indicators';
import { GRID_RUNTIME_POLICY } from '../grid-bot/runtime-policy';
import { validateCandles } from './chart';

/** Time-window advisory only; the execution range detector and draft schema are unchanged. */
export function timeWindowRange(market: string, timeframe: '15m' | '1h' | '4h', period: GridRangePeriod,
  candles: PlannerCandle[], now: number) {
  const deny = (reason: string) => ({ state: 'unavailable' as const, reason, manualAvailable: true, policyVersion: GRID_RUNTIME_POLICY.version });
  const window = gridHistoryWindow(timeframe, period)!;
  const end = Math.floor(now / window.duration) * window.duration;
  const chosen = candles.filter(c => c.time >= end - window.rangeBars * window.duration && c.time < end);
  if (chosen.length !== window.rangeBars) return deny(`Cannot cover the last ${period}: ${candles[0]?.provenance.venue ?? 'the source pool'} returned ${chosen.length} of ${window.rangeBars} finalized bars within its history, quota and request limits. Try a shorter period or refresh later.`);
  if (!validateCandles(candles, now) || !candles.every((c, i) => c.time % window.duration === 0
    && (!i || c.time === candles[i - 1].time + window.duration) && Number.isFinite(c.volume) && c.volume >= 0
    && c.time + window.duration <= now && c.provenance.finality === 'finalized') || chosen.at(-1)!.time + window.duration !== end)
    return deny('Complete, fresh, finalized perpetual history is required for this period.');
  if (candles.length < 28) return deny('The range buffer needs more history; ADX needs 28 bars.');
  const recent = candles.slice(-200);
  const volatility = atr(recent.map(c => c.high), recent.map(c => c.low), recent.map(c => c.close), 14).at(-1) ?? NaN;
  if (!Number.isFinite(volatility) || volatility < 0) return deny('ATR(14) buffer unavailable for this period.');
  const buffer = new Decimal(volatility).mul('0.5');
  const lower = new Decimal(Math.min(...chosen.map(c => c.low))).minus(buffer);
  const upper = new Decimal(Math.max(...chosen.map(c => c.high))).plus(buffer);
  const stopBuffer = new Decimal(volatility).mul(GRID_RUNTIME_POLICY.stop.atrBuffers[timeframe]);
  const longStop = lower.minus(stopBuffer), shortStop = upper.plus(stopBuffer);
  if (lower.lte(0) || upper.lte(lower) || longStop.lte(0)) return deny('This period produces an invalid range or stop; enter a manual range.');
  return { state: 'available' as const, manualAvailable: true, policyVersion: GRID_RUNTIME_POLICY.version,
    market, timeframe, period, includedBars: chosen.length, latestFinalizedTime: chosen.at(-1)!.time,
    lowerPrice: lower.toFixed(), upperPrice: upper.toFixed(), longStop: longStop.toFixed(), shortStop: shortStop.toFixed(),
    atr: new Decimal(volatility).toFixed(), buffer: buffer.toFixed() };
}

/** Bounded read-only history; range failure does not discard an independent ADX observation. */
export class PlannerRangeFacts {
  private starts: number[] = [];
  private active = 0;
  async read(row: ProtocolMarket, timeframe: '15m' | '1h' | '4h', bars: number, deps: PlannerDeps, signal: AbortSignal, chart?: PlannerChart, period?: GridRangePeriod) {
    const now = deps.now(); this.starts = this.starts.filter(t => now - t < 60_000);
    if (this.active >= 2 || this.starts.length >= 12) throw Error('Range advisory is busy; refresh later');
    if (!chart && !deps.rangeCandles) throw Error('Finalized perpetual history unavailable');
    this.active++; this.starts.push(now);
    try {
      const historyBars = period ? gridHistoryWindow(timeframe, period)!.chartBars : bars;
      const candles = chart ? chart.state === 'available' ? chart.candles : [] : await deps.rangeCandles!(row.internalSymbol, timeframe, historyBars, signal);
      signal.throwIfAborted();
      const retrievedAt = deps.now(), regime = plannerRegime(row.internalSymbol, timeframe, period ? candles.slice(-200) : candles, retrievedAt);
      // The execution range policy retains its existing admitted sources. Pacifica ADX stays advisory.
      const rangeCandles = candles.filter((c: PlannerCandle): c is ProvenancedOHLCV => c.provenance.source !== 'pacifica');
      let range = period ? timeWindowRange(row.internalSymbol, timeframe, period, candles, retrievedAt)
        : suggestGridRange(row.internalSymbol, timeframe, bars as 100 | 200, rangeCandles, retrievedAt);
      if (range.state === 'unavailable' && chart?.state === 'unavailable') range = { ...range, reason: chart.reason };
      if (range.state === 'available') {
        const constraints = marketSnapshot(row, deps).constraints;
        if (constraints.state !== 'available') range = { state: 'unavailable', reason: 'Pacifica tick unavailable', manualAvailable: true, policyVersion: range.policyVersion };
        else {
          const tick = new Decimal(constraints.value.tick);
          const snap = (v: string, mode: Decimal.Rounding) => new Decimal(v).div(tick).toDecimalPlaces(0, mode).mul(tick).toFixed();
          range = { ...range, lowerPrice: snap(range.lowerPrice, Decimal.ROUND_CEIL), upperPrice: snap(range.upperPrice, Decimal.ROUND_FLOOR),
            longStop: snap(range.longStop, Decimal.ROUND_FLOOR), shortStop: snap(range.shortStop, Decimal.ROUND_CEIL) };
          if (new Decimal(range.lowerPrice).gte(range.upperPrice) || new Decimal(range.longStop).lte(0))
            range = { state: 'unavailable', reason: 'Suggested range or stop collapses at the venue tick; enter a manual range.', manualAvailable: true, policyVersion: range.policyVersion };
        }
      }
      const duration = timeframe === '15m' ? 900_000 : timeframe === '1h' ? 3_600_000 : 14_400_000;
      const historyRemaining = regime.state === 'available' ? regime.latestFinalizedTime + duration * 2 - retrievedAt : 60_000;
      return { state: 'available' as const, market: row.internalSymbol, timeframe, requestedBars: bars, retrievedAt,
        validForMs: Math.max(0, Math.min(60_000, historyRemaining)), regime, range };
    } finally { this.active--; }
  }
}
