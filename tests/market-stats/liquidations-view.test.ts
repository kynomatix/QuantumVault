import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LiquidationHeatmapView } from '../../client/src/components/market-stats/LiquidationHeatmap';
import type { LiquidationStatsResponse } from '../../shared/market-stats';
import { modelLiquidations } from '../../server/market-stats/liquidations-model';
import { END, hour } from './liquidations-fixtures';
vi.mock('../../client/src/lib/queryClient', () => ({ walletAuthHeaders: () => ({}), getActiveWalletAddress: () => null }));

function card(): LiquidationStatsResponse {
  return { status: 'available', value: modelLiquidations([hour(0, 100), hour(1, 120)], END).value,
    serverNow: END + 7200000, source: 'OKX BTC-USDT-SWAP', basis: 'oi-leverage-v2', asOf: END,
    fetchedAt: END + 3600000, expiresAt: END + 26 * 3600000, gaps: [] };
}
describe('modelled monthly liquidation display', () => {
  it('renders assumptions, two clusters, candle chart and keyboard-accessible values', () => {
    const html = renderToStaticMarkup(createElement(LiquidationHeatmapView, { card: card(), now: END }));
    for (const text of ['Estimated liquidation zones', 'updated daily', 'Largest estimated cluster above price',
      'Largest estimated cluster below price', 'Price often moves towards these pools', 'What this covers',
      '50/50', '5x 10%', '100x 10%', 'not real positions', 'not a forecast', 'oi-leverage-v2', 'new OI / previous OI',
      'closes are spread across all open positions', 'unknown starting book', '4-hour sample',
      'Outside range', 'Long', 'Short', 'UTC', 'overflow-x-auto', 'min-w-[900px]', 'Heatmap covers the last 30 days', '180 days']) expect(html).toContain(text);
    expect(html).not.toContain('90 days'); expect(html).not.toContain('Weekly');
  });
  it('hides expired charts and explains the 26-hour freshness ceiling', () => {
    const data = card(), html = renderToStaticMarkup(createElement(LiquidationHeatmapView, { card: data, now: data.expiresAt }));
    expect(html).toContain('Unavailable'); expect(html).toContain('26 hours'); expect(html).not.toContain('Current reference');
  });
  it('renders the unavailable reason and marks missing hours rather than zero exposure', () => {
    const data: LiquidationStatsResponse = { ...card(), status: 'unavailable', value: null,
      reason: 'Incomplete OKX hourly inputs', gaps: [{ time: END, input: 'candles' }] };
    const html = renderToStaticMarkup(createElement(LiquidationHeatmapView, { card: data, now: END }));
    expect(html).toContain('Incomplete OKX hourly inputs'); expect(html).toContain('candles at 2026-10-17T00:00 UTC');
    expect(html).not.toContain('No modelled exposure');
  });
});
