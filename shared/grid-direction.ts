export const BTC_TREND_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const BTC_TREND_CACHE_MS = 24 * 60 * 60 * 1000;
export const BTC_TREND_PERIODS = 50;

export type GridDirectionSuggestion = {
  regime: 'above' | 'below';
  sourceVenue: 'okx' | 'gate' | 'hyperliquid';
  asOf: number; movingAverage: number; lastClose: number;
  retrievedAt: number; serverNow: number; expiresAt: number;
} | {
  regime: 'unavailable'; sourceVenue: null; asOf: null; movingAverage: null; lastClose: null;
  retrievedAt: number; serverNow: number; expiresAt: number; reason: string;
};
