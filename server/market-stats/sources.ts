import type { StatsCard, CycleStats, DowStats, DowCards, CotStats, FundingStats } from '../../shared/market-stats';
import { btcUtcWeekStart, BTC_TREND_WEEK_MS as WEEK, btcWeeklySourceLabel, type GridDirectionSuggestion } from '../../shared/grid-direction';
import { classifyDow, detectClosedPivots } from '../ai-trader/dow-structure';
import { aggregateStructureWeeks } from '../grid-planner/weekly-structure';
import { validateCandles } from '../grid-planner/chart';
import type { PlannerCandle } from '../grid-planner/types';

export const DAY = 86_400_000;
export const utcDayStart = (now: number) => Math.floor(now / DAY) * DAY;
export function unavailable<T>(source: string, basis: string, now: number, reason: string,
  expiresAt = now + 60_000, asOf: number | null = null, fetchedAt: number | null = null): StatsCard<T> {
  return { status: 'unavailable', value: null, source, basis, asOf, fetchedAt, expiresAt, reason };
}

export function cycleStats(direction: GridDirectionSuggestion, now: number): StatsCard<CycleStats> {
  const basis = 'Last completed UTC weekly close versus the 50-week simple moving average';
  if (direction.regime === 'unavailable') return unavailable('Shared BTC weekly store', basis, now, direction.reason, direction.expiresAt);
  return { status: 'available', source: btcWeeklySourceLabel(direction.source), basis,
    asOf: direction.asOf, fetchedAt: direction.retrievedAt, expiresAt: direction.expiresAt,
    value: { regime: direction.regime === 'above' ? 'bull' : 'bear', lastClose: direction.lastClose,
      movingAverage: direction.movingAverage, distancePercent: (direction.lastClose / direction.movingAverage - 1) * 100 } };
}

export function validDailyWindow(days: PlannerCandle[], now: number): boolean {
  return days.length === 364 && validateCandles(days, now) && days.every((c, i) =>
    c.time === utcDayStart(now) - (364 - i) * DAY && c.provenance.finality === 'finalized'
    && Number.isFinite(c.volume) && c.volume >= 0);
}

export function dowStats(days: PlannerCandle[], now: number, fetchedAt: number): DowCards {
  const source = days.length ? `${days[0].provenance.venue.toUpperCase()} BTC perpetual` : 'BTC perpetual candle sources';
  const basis = 'Confirmed Dow pivots; three closed bars on each side';
  const fail = (reason: string): StatsCard<DowStats> => unavailable(source, basis, now, reason,
    Math.min(now + 60_000, utcDayStart(now) + DAY));
  if (!validDailyWindow(days, now)) return { daily: fail('Completed UTC daily history is invalid, missing or gapped.'),
    weekly: fail('Completed UTC weekly history is unavailable.') };
  const classify = (bars: PlannerCandle[], period: number, boundary: number): StatsCard<DowStats> => {
    if (!bars.length || bars.at(-1)!.time + period !== boundary) return fail('The latest completed period is missing.');
    const result = classifyDow(detectClosedPivots(bars));
    if (result.classification === 'insufficient') return fail('Not enough confirmed highs and lows in the available history.');
    return { status: 'available', source, basis, asOf: boundary, fetchedAt, expiresAt: boundary + period,
      value: { trend: result.classification === 'HH/HL' ? 'uptrend' : result.classification === 'LH/LL' ? 'downtrend' : 'mixed',
        lastPivotAt: bars[result.pivots.at(-1)!.index].time } };
  };
  return { daily: classify(days, DAY, utcDayStart(now)), weekly: classify(aggregateStructureWeeks(days, now), WEEK, btcUtcWeekStart(now)) };
}

export type CotDisplay = { reportDate: string; commIndex: number | null; dumbIndex: number | null;
  weeksInWindow: number; fetchedAt: number; retryAt: number; latestFlip: CotStats['latestFlip'] };
export function cotStats(snapshot: CotDisplay | null, now: number): StatsCard<CotStats> {
  const source = 'CFTC · CME Bitcoin futures', basis = 'Legacy futures-only; 120-report positioning indices';
  const asOf = snapshot ? Date.parse(`${snapshot.reportDate}T00:00:00Z`) : NaN;
  const staleAt = asOf + 16 * DAY;
  if (!snapshot || !Number.isFinite(asOf) || asOf > now || now >= staleAt
    || !Number.isFinite(snapshot.fetchedAt) || snapshot.fetchedAt > now
    || snapshot.weeksInWindow < 120 || ![snapshot.commIndex, snapshot.dumbIndex].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100)) {
    return unavailable(source, basis, now, 'The latest valid report is missing or more than 16 days old.', now + 300_000,
      Number.isFinite(asOf) && asOf <= now ? asOf : null, snapshot?.fetchedAt ?? null);
  }
  return { status: 'available', source, basis, asOf, fetchedAt: snapshot.fetchedAt,
    expiresAt: Math.min(staleAt, snapshot.retryAt), value: { smartIndex: snapshot.commIndex!, speculatorIndex: snapshot.dumbIndex!, latestFlip: snapshot.latestFlip } };
}

export type FundingCapture = { fundingRate: number; openInterest: number; fetchedAt: number };
export function fundingStats(snapshot: FundingCapture | null, now: number): StatsCard<FundingStats> {
  const source = 'Hyperliquid · BTC', basis = 'Hourly snapshot; raw hourly funding rate × 24';
  if (!snapshot || !Number.isFinite(snapshot.fundingRate) || !Number.isFinite(snapshot.openInterest) || snapshot.openInterest < 0
    || !Number.isFinite(snapshot.fetchedAt) || snapshot.fetchedAt > now || snapshot.fetchedAt + 3_600_000 <= now
    || !Number.isFinite(snapshot.fundingRate * 24 * 100)) return unavailable(source, basis, now, 'Funding or open interest is missing, invalid or stale.');
  return { status: 'available', source, basis, asOf: snapshot.fetchedAt, fetchedAt: snapshot.fetchedAt,
    expiresAt: snapshot.fetchedAt + 3_600_000, value: { hourlyRate: snapshot.fundingRate,
      estimatedDailyPercent: snapshot.fundingRate * 24 * 100, openInterestBtc: snapshot.openInterest } };
}
