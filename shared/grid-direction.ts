export const BTC_TREND_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const BTC_TREND_PUBLICATION_GRACE_MS = 15 * 60 * 1000;
export const BTC_TREND_NEGATIVE_CACHE_MS = 30 * 60 * 1000;
export const BTC_TREND_PERIODS = 50;

export function btcTrendExpiresAt(asOf: number): number {
  return asOf + BTC_TREND_WEEK_MS;
}

export function btcUtcWeekStart(time: number): number {
  const monday = Date.UTC(1970, 0, 5);
  return Math.floor((time - monday) / BTC_TREND_WEEK_MS) * BTC_TREND_WEEK_MS + monday;
}
export const BTC_WEEKLY_SOURCES = {
  'okx-index': { venue: 'okx', basis: 'index', label: 'OKX index' },
  'gate-spot': { venue: 'gate', basis: 'spot', label: 'Gate.io spot' },
  'kraken-spot': { venue: 'kraken', basis: 'spot', label: 'Kraken spot' },
  'coinbase-spot': { venue: 'coinbase', basis: 'spot', label: 'Coinbase spot' },
  // A perpetual mark: its median includes both the oracle and perp prices.
  'pacifica-mark': { venue: 'pacifica', basis: 'perp', label: 'Pacifica mark' },
  'hyperliquid-perp': { venue: 'hyperliquid', basis: 'perp', label: 'Hyperliquid perp' },
  'pacifica-perp': { venue: 'pacifica', basis: 'perp', label: 'Pacifica perp' },
  'okx-perp': { venue: 'okx', basis: 'perp', label: 'OKX perp' },
} as const;
export type BtcWeeklySource = keyof typeof BTC_WEEKLY_SOURCES;
export type BtcStoredWeek = {
  market: 'BTC'; weekStart: number; close: string; source: BtcWeeklySource;
  basis: 'index' | 'spot' | 'perp'; aggregation: 'native' | 'daily'; finalized: true; fetchedAt: number;
};
export function btcWeeklySourceLabel(source: BtcWeeklySource | 'mixed'): string {
  return `BTC weekly close (${source === 'mixed' ? 'mixed sources' : BTC_WEEKLY_SOURCES[source].label})`;
}
export function validBtcStoredWeek(row: BtcStoredWeek, now: number): boolean {
  return row?.market === 'BTC' && Number.isSafeInteger(row.weekStart) && row.weekStart > 0
    && btcUtcWeekStart(row.weekStart) === row.weekStart && row.weekStart + BTC_TREND_WEEK_MS <= now
    && typeof row.close === 'string' && /^\d{1,12}(\.\d{1,18})?$/.test(row.close) && Number(row.close) > 0
    && Object.hasOwn(BTC_WEEKLY_SOURCES, row.source) && BTC_WEEKLY_SOURCES[row.source].basis === row.basis
    && ['native', 'daily'].includes(row.aggregation) && row.finalized === true
    && Number.isSafeInteger(row.fetchedAt) && row.fetchedAt >= row.weekStart + BTC_TREND_WEEK_MS && row.fetchedAt <= now;
}

export type GridDirectionSuggestion = {
  regime: 'above' | 'below';
  source: BtcWeeklySource | 'mixed';
  sourceVenue: typeof BTC_WEEKLY_SOURCES[BtcWeeklySource]['venue'] | 'mixed';
  sourceBasis: 'index' | 'spot' | 'perp' | 'mixed';
  sourceAggregation: 'native' | 'weekly-from-daily' | 'mixed';
  asOf: number; movingAverage: number; lastClose: number;
  retrievedAt: number; serverNow: number; expiresAt: number;
} | {
  regime: 'unavailable'; sourceVenue: null; asOf: null; movingAverage: null; lastClose: null;
  retrievedAt: number; serverNow: number; expiresAt: number; reason: string;
};
