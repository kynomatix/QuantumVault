import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MarketStatsView } from '../../client/src/components/market-stats/MarketStatsPage';
import { currentCard, signedPercent, utcTime } from '../../client/src/components/market-stats/format';
import { cycleStats, dowStats, cotStats, fundingStats } from '../../server/market-stats/sources';
import { computeBtcDirection } from '../../server/grid-planner/direction';
import type { MarketStats } from '../../shared/market-stats';
import { NOW, weeks, days } from './fixtures';
vi.mock('../../client/src/lib/queryClient', () => ({ walletAuthHeaders: () => ({}), getActiveWalletAddress: () => null }));

function snapshot(): MarketStats {
  return { serverNow: NOW, expiresAt: NOW + 3_600_000,
    cycle: cycleStats(computeBtcDirection(weeks(), NOW), NOW), dow: dowStats(days(), NOW, NOW),
    cot: cotStats({ reportDate: '2026-10-13', commIndex: 55, dumbIndex: 45, weeksInWindow: 120,
      fetchedAt: NOW, retryAt: NOW + 86_400_000, latestFlip: null }, NOW),
    funding: fundingStats({ fundingRate: 0, openInterest: 0, fetchedAt: NOW }, NOW) };
}
describe('Market Stats presentation', () => {
  it('renders four plain-language cards, honest index labels and zero funding/OI', () => {
    const html = renderToStaticMarkup(createElement(MarketStatsView, { data: snapshot(), now: NOW }));
    expect(html.match(/<article /g)).toHaveLength(4);
    expect(html).toContain('Commercial hedgers'); expect(html).toContain('Large + small traders; not pure retail');
    expect(html).toContain('not a probability'); expect(html).toContain('No flip in stored history');
    expect(html).toContain('Estimated daily funding cost: rate × 24, if the rate stays the same');
    expect(html).toContain('No funding payment at this rate.'); expect(html).toContain('0.000%');
    expect(html).toContain('UTC'); expect(html).toContain('role="meter"');
  });
  it('expires individual cards without hiding valid cards or presenting stale funding as current', () => {
    const data = snapshot(), now = NOW + 3_600_000;
    const html = renderToStaticMarkup(createElement(MarketStatsView, { data, now }));
    expect(html).toContain('Unavailable'); expect(html).toContain('Last available');
    expect(html).not.toContain('No funding payment at this rate.'); expect(html).toContain('Bull');
    expect(currentCard(data.funding, now)).toMatchObject({ status: 'unavailable', value: null, asOf: NOW });
  });
  it('keeps UTC and signed percentages explicit', () => {
    expect(utcTime(NOW)).toContain('08:00'); expect(utcTime(NOW)).toContain('UTC');
    expect(signedPercent(-0.24, 3)).toBe('-0.240%'); expect(signedPercent(0, 3)).toBe('0.000%');
  });
});
