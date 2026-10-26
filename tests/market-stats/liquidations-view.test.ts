import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LiquidationHeatmapView } from '../../client/src/components/market-stats/LiquidationHeatmap';
import type { LiquidationCoverageReason, LiquidationStatsResponse } from '../../shared/market-stats';
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
  it('defaults older cards to OKX and uses a simple headline source line', () => {
    const html = renderToStaticMarkup(createElement(LiquidationHeatmapView, { card: card(), now: END }));
    expect(html).toContain('Sources: OKX'); expect(html).not.toContain('One venue:');
    expect(html).not.toContain('relay'); expect(html).not.toContain('scheduler');
  });
  it.each([
    ['disabled', 'source unavailable'], ['deadline', 'source timed out'], ['http', 'source request failed'],
    ['malformed', 'data failed checks'], ['empty', 'no recent data'], ['stale', 'data too old'],
    ['baseline-only', 'not enough consecutive observations'], [undefined, 'no usable recent data'],
  ] as [LiquidationCoverageReason | undefined, string][])('explains omitted venues (%s)', (reason, explanation) => {
    const data = card();
    data.coverage = { venuesUsed: ['okx'], priceVenue: 'okx', venues: [{ venue: 'bybit', status: 'omitted', reason,
      firstObservation: null, lastObservation: null, lastFetchedAt: null, gaps: [], gapHours: 0, terminalLagHours: 0 }] };
    const html = renderToStaticMarkup(createElement(LiquidationHeatmapView, { card: data, now: END }));
    expect(html).toContain(`Bybit: left out (${explanation}).`);
    expect(html).toContain('Some venues have no usable recent observations');
  });
  it.each([1, 2])('snapshots all four sources and reports %s skipped hours', skippedRows => {
    const data = card();
    data.coverage = { venuesUsed: ['okx', 'binance', 'bybit', 'hyperliquid'], priceVenue: 'okx',
      venues: [{ venue: 'bybit', status: 'included', firstObservation: END - 14400000,
        lastObservation: END, lastFetchedAt: END, gaps: [], gapHours: 0, terminalLagHours: 0, skippedRows }] };
    const html = renderToStaticMarkup(createElement(LiquidationHeatmapView, { card: data, now: END }));
    expect(html.match(/Sources: [^<]+/)?.[0]).toMatchInlineSnapshot(`"Sources: OKX + Binance + Bybit + Hyperliquid"`);
    expect(html).toContain(`${skippedRows} ${skippedRows === 1 ? 'hour' : 'hours'} skipped after failing checks`);
    expect(html).not.toContain('left out');
  });
  it.each([{ venues: ['binance'] }, { venues: ['bybit', 'hyperliquid'] }, { venues: ['binance', 'bybit', 'hyperliquid'] }])(
    'renders actual source subsets and coverage details ($venues)', ({ venues }) => {
      const data = card(), included = venues as ('binance' | 'bybit' | 'hyperliquid')[];
      data.value!.methodologyVersion = 'oi-leverage-v3';
      data.coverage = { venuesUsed: ['okx', ...included], priceVenue: 'okx', venues: included.map(venue => ({ venue,
        status: 'included', firstObservation: END - 14400000, lastObservation: END - 7200000,
        lastFetchedAt: END, gaps: [{ start: END - 10800000, end: END - 10800000 }], gapHours: 1, terminalLagHours: 1 })) };
      const html = renderToStaticMarkup(createElement(LiquidationHeatmapView, { card: data, now: END }));
      const names = { binance: 'Binance', bybit: 'Bybit', hyperliquid: 'Hyperliquid' };
      expect(html).toContain(`Sources: OKX + ${included.map(v => names[v]).join(' + ')}`);
      for (const text of ['oi-leverage-v3', 'observations from', '1 missing hour', 'new baseline', 'not a continuous four-venue history',
        'All entries, price sweeps and notionals use OKX', 'without new open-interest changes']) expect(html).toContain(text);
      expect(html).not.toContain('relay'); expect(html).not.toContain('scheduler');
    });
});
