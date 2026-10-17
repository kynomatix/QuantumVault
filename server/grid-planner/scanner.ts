import { suggestGridRange, gridTimeframeMs } from '../grid-bot/range';
import { plannerRegime } from './regime';
import type { PlannerCandle, PlannerDeps } from './types';
import type { ProvenancedOHLCV } from '../lab/datafeed';
import type { ProtocolMarket } from '../protocol/protocol-types';
import { GRID_FINDER_LIMITS, type GridFinderCandidate, type GridFinderPage, type GridFinderTimeframe } from '../../shared/grid-finder';

type Measurement = { state: 'ranging'; candidate: GridFinderCandidate } | { state: 'not-ranging' | 'unavailable' };
export function qualifyRangingMarket(market: string, symbol: string, timeframe: GridFinderTimeframe,
  candles: PlannerCandle[], now: number, historyCut: number): Measurement {
  const duration = gridTimeframeMs(timeframe)!;
  if (candles.length !== GRID_FINDER_LIMITS.bars || candles.at(-1)!.time + duration !== historyCut
    || Math.floor(now / duration) * duration !== historyCut) return { state: 'unavailable' };
  const regime = plannerRegime(market, timeframe, candles, now);
  // Use the same 100 bars for both facts. Pacifica is not admitted by the active-range policy.
  if (regime.state !== 'available' || !candles.every((c): c is ProvenancedOHLCV => c.provenance.source !== 'pacifica'))
    return { state: 'unavailable' };
  const range = suggestGridRange(market, timeframe, 100, candles as ProvenancedOHLCV[], now);
  if (range.state !== 'available') return { state: 'unavailable' };
  if (regime.adx >= 20) return { state: 'not-ranging' };
  return { state: 'ranging', candidate: { market, symbol, adx: regime.adx, lowerPrice: range.lowerPrice,
    upperPrice: range.upperPrice, venue: regime.venue as GridFinderCandidate['venue'],
    latestFinalizedTime: regime.latestFinalizedTime, updatedAt: now } };
}

/** One on-demand batch per process; duplicate callers share work and own cancellation independently. */
export class RangingMarketFinder {
  private cache = new Map<string, Measurement>();
  private job?: { key: string; controller: AbortController; promise: Promise<GridFinderPage>; users: number };
  constructor(private deps: PlannerDeps) {}

  async read(rows: ProtocolMarket[], timeframe: GridFinderTimeframe, cursor: number, signal: AbortSignal): Promise<GridFinderPage> {
    const duration = gridTimeframeMs(timeframe);
    if (!duration || !Number.isSafeInteger(cursor) || cursor < 0) throw Error('Invalid finder interval or cursor');
    signal.throwIfAborted();
    const markets = [...new Map(rows.filter(row => row.isActive && /^[A-Za-z0-9-]+-PERP$/.test(row.internalSymbol))
      .map(row => [row.internalSymbol, row])).values()].sort((a, b) => a.internalSymbol < b.internalSymbol ? -1 : a.internalSymbol > b.internalSymbol ? 1 : 0);
    if (cursor > markets.length) throw Error('Invalid finder cursor');
    const historyCut = Math.floor(this.deps.now() / duration) * duration;
    const universe = markets.map(row => row.internalSymbol).join(',');
    const key = `${timeframe}:${historyCut}:${cursor}:${universe}`;
    if (this.job && (this.job.key !== key || this.job.controller.signal.aborted)) throw Error('Finder is busy; try again');
    if (!this.job) {
      const controller = new AbortController();
      const created = { key, controller, users: 0, promise: Promise.resolve<GridFinderPage>(null!) };
      const timer = setTimeout(() => controller.abort(), GRID_FINDER_LIMITS.deadlineMs);
      this.job = created;
      created.promise = this.scan(markets, rows.length - markets.length, timeframe, historyCut, universe, cursor, controller.signal)
        .finally(() => { clearTimeout(timer); if (this.job === created) this.job = undefined; });
    }
    const owned = this.job;
    owned.users++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value?: GridFinderPage, error?: unknown) => {
        if (settled) return; settled = true;
        signal.removeEventListener('abort', abort);
        if (!--owned.users) owned.controller.abort();
        if (error) reject(error); else resolve(value!);
      };
      const abort = () => finish(undefined, Error('Finder request cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      owned.promise.then(value => finish(value), error => finish(undefined, error));
      if (signal.aborted) abort();
    });
  }

  private async scan(markets: ProtocolMarket[], ineligible: number, timeframe: GridFinderTimeframe, historyCut: number,
    universe: string, cursor: number, signal: AbortSignal): Promise<GridFinderPage> {
    let checked = 0, unavailable = 0, notRanging = 0;
    const candidates: GridFinderCandidate[] = [], batch = markets.slice(cursor, cursor + GRID_FINDER_LIMITS.markets);
    let assigned = 0;
    const worker = async () => {
      while (!signal.aborted && assigned < batch.length) {
        const row = batch[assigned++], key = `${row.internalSymbol}:${timeframe}:${historyCut}`;
        let result = this.cache.get(key);
        if (!result) {
          try {
            const candles = await this.deps.candles(row.internalSymbol, timeframe, GRID_FINDER_LIMITS.bars, signal);
            signal.throwIfAborted();
            result = qualifyRangingMarket(row.internalSymbol, row.protocolSymbol, timeframe, candles, this.deps.now(), historyCut);
            // Missing data may recover on a later click; successful measurements belong to this finalized cut.
            if (result.state !== 'unavailable') {
              this.cache.set(key, result);
              if (this.cache.size > 512) this.cache.delete(this.cache.keys().next().value!);
            }
          } catch { result = { state: 'unavailable' }; }
        }
        checked++;
        if (result.state === 'ranging') candidates.push(result.candidate);
        else if (result.state === 'unavailable') unavailable++;
        else notRanging++;
      }
    };
    await Promise.all(Array.from({ length: GRID_FINDER_LIMITS.concurrentReads }, worker));
    const next = cursor + checked;
    return { state: 'available', timeframe, historyCut, universe, cursor, nextCursor: next < markets.length ? next : null,
      total: markets.length, ineligible, checked, unavailable, notRanging, truncated: next < markets.length,
      deadlineReached: signal.aborted, candidates: candidates.sort((a, b) => a.adx - b.adx || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0)) };
  }
}
