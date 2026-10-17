import { btcUtcWeekStart, BTC_TREND_WEEK_MS as WEEK, type BtcStoredWeek } from '../../shared/grid-direction';
import type { PlannerCandle } from '../../server/grid-planner/types';
import { DAY, utcDayStart } from '../../server/market-stats/sources';

export const NOW = Date.UTC(2026, 9, 17, 8);
export function weeks(last = '200'): BtcStoredWeek[] {
  return Array.from({ length: 50 }, (_, i) => ({ market: 'BTC', weekStart: btcUtcWeekStart(NOW) - (50 - i) * WEEK,
    close: i === 49 ? last : '100', source: 'okx-index', basis: 'index', aggregation: 'native', finalized: true, fetchedAt: NOW - 1_000 }));
}
export function days(now = NOW): PlannerCandle[] {
  return Array.from({ length: 364 }, (_, i) => {
    // Enough daily and weekly alternating confirmed pivots; prices stay positive.
    const mid = 1_000 + i + 80 * Math.sin(i * Math.PI / 28);
    return { time: utcDayStart(now) - (364 - i) * DAY, open: mid, close: mid, high: mid + 5, low: mid - 5, volume: 10,
      provenance: { source: 'okx', venue: 'okx', basis: 'perp', proxy: 'direct', finality: 'finalized', timeSemantic: 'open_time' } };
  });
}
