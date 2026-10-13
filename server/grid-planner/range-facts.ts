import Decimal from 'decimal.js';
import { suggestGridRange } from '../grid-bot/range';
import { plannerRegime } from './regime';
import { marketSnapshot } from './market-snapshot';
import type { PlannerDeps } from './types';
import type { ProtocolMarket } from '../protocol/protocol-types';

/** Bounded read-only history; range failure does not discard an independent ADX observation. */
export class PlannerRangeFacts {
  private starts: number[] = [];
  private active = 0;
  async read(row: ProtocolMarket, timeframe: '15m' | '1h' | '4h', bars: 100 | 200, deps: PlannerDeps, signal: AbortSignal) {
    const now = deps.now(); this.starts = this.starts.filter(t => now - t < 60_000);
    if (this.active >= 2 || this.starts.length >= 12) throw Error('Range advisory is busy; refresh later');
    if (!deps.rangeCandles) throw Error('Finalized perpetual history unavailable');
    this.active++; this.starts.push(now);
    try {
      const candles = await deps.rangeCandles(row.internalSymbol, timeframe, bars, signal);
      signal.throwIfAborted();
      const retrievedAt = deps.now(), regime = plannerRegime(row.internalSymbol, timeframe, candles, retrievedAt);
      let range = suggestGridRange(row.internalSymbol, timeframe, bars, candles, retrievedAt);
      if (range.state === 'available') {
        const constraints = marketSnapshot(row, deps).constraints;
        if (constraints.state !== 'available') range = { state: 'unavailable', reason: 'Pacifica tick unavailable', manualAvailable: true, policyVersion: range.policyVersion };
        else {
          const tick = new Decimal(constraints.value.tick);
          const snap = (v: string, mode: Decimal.Rounding) => new Decimal(v).div(tick).toDecimalPlaces(0, mode).mul(tick).toFixed();
          range = { ...range, lowerPrice: snap(range.lowerPrice, Decimal.ROUND_CEIL), upperPrice: snap(range.upperPrice, Decimal.ROUND_FLOOR),
            longStop: snap(range.longStop, Decimal.ROUND_FLOOR), shortStop: snap(range.shortStop, Decimal.ROUND_CEIL) };
        }
      }
      const duration = timeframe === '15m' ? 900_000 : timeframe === '1h' ? 3_600_000 : 14_400_000;
      const historyRemaining = regime.state === 'available' ? regime.latestFinalizedTime + duration * 2 - retrievedAt : 60_000;
      return { state: 'available' as const, market: row.internalSymbol, timeframe, requestedBars: bars, retrievedAt,
        validForMs: Math.max(0, Math.min(60_000, historyRemaining)), regime, range };
    } finally { this.active--; }
  }
}
