export const BTC_TREND_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const BTC_TREND_PUBLICATION_GRACE_MS = 15 * 60 * 1000;
export const BTC_TREND_NEGATIVE_CACHE_MS = 30 * 60 * 1000;
export const BTC_TREND_PERIODS = 50;

export function btcTrendExpiresAt(asOf: number): number {
  // Native venue weeks may close before UTC Monday (OKX closes at Sunday 16:00 UTC).
  const monday = Date.UTC(1970, 0, 5);
  const completedMonday = Math.ceil((asOf - monday) / BTC_TREND_WEEK_MS) * BTC_TREND_WEEK_MS + monday;
  return completedMonday + BTC_TREND_WEEK_MS + BTC_TREND_PUBLICATION_GRACE_MS;
}

export type GridDirectionSuggestion = {
  regime: 'above' | 'below';
  sourceVenue: 'okx' | 'gate' | 'hyperliquid' | 'pacifica';
  sourceAggregation?: 'weekly-from-daily';
  asOf: number; movingAverage: number; lastClose: number;
  retrievedAt: number; serverNow: number; expiresAt: number;
} | {
  regime: 'unavailable'; sourceVenue: null; asOf: null; movingAverage: null; lastClose: null;
  retrievedAt: number; serverNow: number; expiresAt: number; reason: string;
};
