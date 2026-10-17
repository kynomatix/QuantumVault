export type StatsCard<T> = {
  source: string;
  basis: string;
  asOf: number | null;
  fetchedAt: number | null;
  expiresAt: number;
} & ({ status: 'available'; value: T; asOf: number; fetchedAt: number }
  | { status: 'unavailable'; value: null; reason: string });

export type CycleStats = { regime: 'bull' | 'bear'; lastClose: number; movingAverage: number; distancePercent: number };
export type DowStats = { trend: 'uptrend' | 'downtrend' | 'mixed'; lastPivotAt: number };
export type CotStats = { smartIndex: number; speculatorIndex: number;
  latestFlip: { state: 'bullish_flip' | 'bearish_flip'; reportDate: string } | null };
export type FundingStats = { hourlyRate: number; estimatedDailyPercent: number; openInterestBtc: number };
export type DowCards = { daily: StatsCard<DowStats>; weekly: StatsCard<DowStats> };
export type MarketStats = {
  serverNow: number;
  expiresAt: number;
  cycle: StatsCard<CycleStats>;
  dow: DowCards;
  cot: StatsCard<CotStats>;
  funding: StatsCard<FundingStats>;
};

export type LiquidationGap = { time: number; input: 'open-interest' | 'candles' };
export type LiquidationCluster = { lower: number; upper: number; notionalUsd: number; side: 'long' | 'short' | 'both' };
export type LiquidationColumn = {
  time: number; sampleAsOf: number;
  candle: { open: number; high: number; low: number; close: number };
  /** USD-equivalent live notional, [long, short], at the LAST hourly state. */
  bins: [number, number][];
  excludedUsd: number;
};
export type LiquidationStats = {
  methodologyVersion: 'oi-leverage-v2'; asset: 'BTC'; instrument: 'BTC-USDT-SWAP';
  currentPrice: number; priceRange: { lower: number; upper: number }; bandWidth: number;
  columns: LiquidationColumn[]; scaleMaxUsd: number; excludedUsd: number;
  /** Confirmed 4H UTC history for scrolling; older candles have no modelled bands. */
  candles?: { time: number; open: number; high: number; low: number; close: number }[];
  summary: { above: LiquidationCluster | null; below: LiquidationCluster | null };
  modelStartedAt: number; displayStartedAt: number; initialOiBtc: number;
};
export type LiquidationStatsCard = StatsCard<LiquidationStats> & { gaps: LiquidationGap[] };
export type LiquidationStatsResponse = LiquidationStatsCard & { serverNow: number };
