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
