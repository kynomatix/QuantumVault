import Decimal from 'decimal.js';
import { btcTrendExpiresAt, btcUtcWeekStart, BTC_WEEKLY_SOURCES, validBtcStoredWeek,
  BTC_TREND_NEGATIVE_CACHE_MS, BTC_TREND_PERIODS, BTC_TREND_PUBLICATION_GRACE_MS, BTC_TREND_WEEK_MS,
  type BtcStoredWeek, type GridDirectionSuggestion } from '../../shared/grid-direction';
import type { PlannerDeps } from './types';

const DecimalPrice = Decimal.clone({ precision: 64 });
const unavailable = (now: number, reason: string, retryAt = now + BTC_TREND_NEGATIVE_CACHE_MS): GridDirectionSuggestion => ({
  regime: 'unavailable', sourceVenue: null, asOf: null, movingAverage: null, lastClose: null,
  retrievedAt: now, serverNow: now, expiresAt: Math.max(now + 1, retryAt), reason });

/** Only persisted, complete UTC Monday weeks are decision inputs. */
export function computeBtcDirection(raw: BtcStoredWeek[], now: number): GridDirectionSuggestion {
  const weeks = [...raw].sort((a, b) => a.weekStart - b.weekStart).slice(-BTC_TREND_PERIODS);
  if (weeks.length !== BTC_TREND_PERIODS) return unavailable(now, 'Fewer than 50 stored completed BTC weeks.');
  if (!weeks.every((row, i) => validBtcStoredWeek(row, now)
    && (!i || row.weekStart - weeks[i - 1].weekStart === BTC_TREND_WEEK_MS))) {
    return unavailable(now, 'Stored BTC weekly history or provenance is incomplete.');
  }
  const last = weeks[weeks.length - 1], asOf = last.weekStart + BTC_TREND_WEEK_MS;
  if (asOf !== btcUtcWeekStart(now)) return unavailable(now, 'Stored BTC weekly history is stale.');
  const average = weeks.reduce((sum, row) => sum.plus(row.close), new DecimalPrice(0)).div(BTC_TREND_PERIODS);
  const lastClose = new DecimalPrice(last.close);
  if (lastClose.eq(average)) return unavailable(now, 'BTC has no above/below 50-week average suggestion.');
  const movingAverage = average.toNumber(), close = lastClose.toNumber();
  if (close === movingAverage) return unavailable(now, 'BTC has no representable above/below average suggestion.');
  const source = weeks.every(row => row.source === weeks[0].source) ? weeks[0].source : 'mixed';
  const sourceAggregation = weeks.every(row => row.aggregation === weeks[0].aggregation)
    ? weeks[0].aggregation === 'daily' ? 'weekly-from-daily' : 'native' : 'mixed';
  return { regime: lastClose.gt(average) ? 'above' : 'below', source,
    sourceVenue: source === 'mixed' ? 'mixed' : BTC_WEEKLY_SOURCES[source].venue,
    sourceBasis: source === 'mixed' ? 'mixed' : BTC_WEEKLY_SOURCES[source].basis,
    sourceAggregation, asOf, movingAverage, lastClose: close,
    retrievedAt: Math.max(...weeks.map(row => row.fetchedAt)), serverNow: now, expiresAt: btcTrendExpiresAt(asOf) };
}

// No process-local cache, job, attempt time or negative result. PostgreSQL owns concurrency and cadence.
export class PlannerDirection {
  constructor(private deps: Pick<PlannerDeps, 'now' | 'btcWeeklyCandles' | 'btcWeeklyStore'>) {}
  async read(): Promise<GridDirectionSuggestion> {
    const now = this.deps.now(), store = this.deps.btcWeeklyStore;
    if (!store) return unavailable(now, 'BTC weekly storage is unavailable.');
    try {
      let snapshot = await store.read(now);
      const completed = btcUtcWeekStart(now);
      const incomplete = snapshot.weeks.length !== BTC_TREND_PERIODS || snapshot.weeks.some((row, i) =>
        row.weekStart !== completed - (BTC_TREND_PERIODS - i) * BTC_TREND_WEEK_MS);
      if (incomplete
        && now >= completed + BTC_TREND_PUBLICATION_GRACE_MS && this.deps.btcWeeklyCandles) {
        await store.refresh(now, signal => this.deps.btcWeeklyCandles!(signal, completed - 55 * BTC_TREND_WEEK_MS, completed));
        snapshot = await store.read(this.deps.now());
      }
      const value = computeBtcDirection(snapshot.weeks, this.deps.now());
      if (value.regime !== 'unavailable') return value;
      const clock = this.deps.now();
      const retryAt = clock < completed + BTC_TREND_PUBLICATION_GRACE_MS
        ? completed + BTC_TREND_PUBLICATION_GRACE_MS
        : (snapshot.lastAttemptAt ?? clock) + BTC_TREND_NEGATIVE_CACHE_MS;
      return unavailable(clock, value.reason, retryAt);
    } catch { return unavailable(this.deps.now(), 'BTC weekly storage is unavailable.'); }
  }
}
