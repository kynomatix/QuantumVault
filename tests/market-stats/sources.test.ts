import { describe, it, expect } from 'vitest';
import { computeBtcDirection } from '../../server/grid-planner/direction';
import { detectPivots, detectClosedPivots } from '../../server/ai-trader/dow-structure';
import { cycleStats, dowStats, validDailyWindow, cotStats, fundingStats, DAY, utcDayStart } from '../../server/market-stats/sources';
import { btcUtcWeekStart, BTC_TREND_WEEK_MS as WEEK } from '../../shared/grid-direction';
import { NOW, weeks, days } from './fixtures';

describe('Market Stats source meanings', () => {
  it('shares the Grid SMA, price basis, expiry and exact distance', () => {
    const direction = computeBtcDirection(weeks(), NOW), card = cycleStats(direction, NOW);
    expect(card.status).toBe('available');
    if (card.status !== 'available' || direction.regime === 'unavailable') throw Error('EXAMPLE expected available');
    expect(card.value.movingAverage).toBe(direction.movingAverage);
    expect(card.value.lastClose).toBe(direction.lastClose);
    expect(card.value.distancePercent).toBeCloseTo((200 / 102 - 1) * 100);
    expect(card.asOf).toBe(btcUtcWeekStart(NOW));
    expect(card.fetchedAt).toBe(NOW - 1_000);
    expect(card.expiresAt).toBe(direction.expiresAt);
    expect(card.value.regime).toBe('bull');
  });
  it('retains equality as unavailable and computes bear without a live price', () => {
    expect(cycleStats(computeBtcDirection(weeks('100'), NOW), NOW).status).toBe('unavailable');
    expect(cycleStats(computeBtcDirection(weeks('50'), NOW), NOW)).toMatchObject({ value: { regime: 'bear' } });
  });
  it('closed feeds retain the final confirming neighbor while legacy feeds discard forming bars', () => {
    const bars = [1, 2, 3, 10, 3, 2, 1].map(high => ({ high, low: 0.5 }));
    expect(detectPivots(bars)).toEqual([]);
    expect(detectClosedPivots(bars)).toEqual([{ index: 3, type: 'high', price: 10 }]);
    expect(detectPivots([...bars, { high: 100, low: 0 }])).toEqual(detectClosedPivots(bars));
  });
  it('uses complete UTC days and Monday weeks with original capture and pivot times', () => {
    const raw = days(), result = dowStats(raw, NOW, NOW - 500);
    expect(result.daily.status).toBe('available'); expect(result.weekly.status).toBe('available');
    expect(result.daily.asOf).toBe(utcDayStart(NOW));
    expect(result.daily.expiresAt).toBe(utcDayStart(NOW) + DAY);
    expect(result.weekly.asOf).toBe(btcUtcWeekStart(NOW));
    expect(result.weekly.expiresAt).toBe(btcUtcWeekStart(NOW) + WEEK);
    if (result.daily.status === 'available') expect(result.daily.value.lastPivotAt).toBeLessThan(utcDayStart(NOW) - 3 * DAY);
    expect(result.daily.fetchedAt).toBe(NOW - 500);
  });
  it.each(['gap', 'forming', 'nonUTC', 'NaN', 'mixed', 'stale'] as const)('rejects %s candle history', kind => {
    const raw = days();
    if (kind === 'gap') raw.splice(10, 1);
    if (kind === 'forming') raw.at(-1)!.provenance.finality = 'forming';
    if (kind === 'nonUTC') raw[0].time += 1;
    if (kind === 'NaN') raw[10].high = NaN;
    if (kind === 'mixed') raw[10].provenance.source = 'gate';
    if (kind === 'stale') raw.forEach(c => c.time -= DAY);
    expect(validDailyWindow(raw, NOW)).toBe(false);
    expect(dowStats(raw, NOW, NOW).daily.status).toBe('unavailable');
  });
  it('invalidates daily and weekly windows exactly at their UTC boundaries', () => {
    expect(validDailyWindow(days(), utcDayStart(NOW) + DAY)).toBe(false);
    const monday = btcUtcWeekStart(NOW) + WEEK;
    const result = dowStats(days(monday), monday, monday);
    expect(result.weekly.asOf).toBe(monday);
  });
  it('does not turn insufficient confirmed pivots into mixed', () => {
    const raw = days().map(c => ({ ...c, open: 100, close: 100, high: 101, low: 99 }));
    expect(dowStats(raw, NOW, NOW).daily).toMatchObject({ status: 'unavailable', value: null });
  });
  it('keeps the older stored COT flip when the latest report is neutral', () => {
    const snapshot = { reportDate: '2026-10-13', commIndex: 40, dumbIndex: 60, weeksInWindow: 120,
      fetchedAt: NOW - 10_000, retryAt: NOW + DAY, latestFlip: { reportDate: '2026-10-06', state: 'bullish_flip' as const } };
    expect(cotStats(snapshot, NOW)).toMatchObject({ status: 'available', value: { latestFlip: snapshot.latestFlip } });
    expect(cotStats({ ...snapshot, latestFlip: null }, NOW)).toMatchObject({ status: 'available', value: { latestFlip: null } });
    expect(cotStats({ ...snapshot, reportDate: '2026-10-01', fetchedAt: NOW }, NOW).status).toBe('unavailable');
    expect(cotStats({ ...snapshot, commIndex: null }, NOW).status).toBe('unavailable');
  });
  it('preserves zero funding and OI, projects hourly rates and rejects missing or stale data', () => {
    expect(fundingStats({ fundingRate: 0, openInterest: 0, fetchedAt: NOW - 1 }, NOW)).toMatchObject({
      status: 'available', asOf: NOW - 1, value: { estimatedDailyPercent: 0, openInterestBtc: 0 } });
    const projected = fundingStats({ fundingRate: 0.0001, openInterest: 100, fetchedAt: NOW }, NOW);
    expect(projected.status).toBe('available');
    if (projected.status === 'available') expect(projected.value.estimatedDailyPercent).toBeCloseTo(0.24);
    expect(fundingStats(null, NOW).status).toBe('unavailable');
    expect(fundingStats({ fundingRate: NaN, openInterest: 1, fetchedAt: NOW }, NOW).status).toBe('unavailable');
    expect(fundingStats({ fundingRate: 0, openInterest: -1, fetchedAt: NOW }, NOW).status).toBe('unavailable');
    expect(fundingStats({ fundingRate: 0, openInterest: 1, fetchedAt: NOW - 3_600_000 }, NOW).status).toBe('unavailable');
  });
});
