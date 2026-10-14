export type SignalDirection = 'long' | 'short' | 'neutral';
export type SignalUnavailable = { state: 'unavailable'; reason: string };
export type WeeklyStructure = SignalUnavailable | {
  state: 'available'; market: string; direction: SignalDirection; venue: string;
  asOf: number; retrievedAt: number; expiresAt: number; weeks: number;
  highs: { time: number; price: number }[]; lows: { time: number; price: number }[];
};
export type FundingSignal = SignalUnavailable | {
  state: 'available'; market: string; hourlyRate: number; basis: 'next-hour estimate' | 'last settled hour';
  observedAt: number; expiresAt: number;
};
export interface GridSignals { market: string; serverNow: number; weekly: WeeklyStructure; funding: FundingSignal }

export const WEEKLY_SWING_BASIS = 'UTC Monday weeks from seven finalized daily perpetual candles from one venue. A swing high/low is strictly above/below the two weeks on each side (ties do not qualify). Compare the latest two confirmed highs and latest two confirmed lows independently: both higher = up, both lower = down, otherwise sideways. The last two weeks cannot be confirmed swings.';
