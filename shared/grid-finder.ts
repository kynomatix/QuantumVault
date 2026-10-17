export type GridFinderTimeframe = '15m' | '1h' | '4h';
export interface GridFinderCandidate {
  market: string; symbol: string; adx: number; lowerPrice: string; upperPrice: string;
  venue: 'okx' | 'gate' | 'hyperliquid'; latestFinalizedTime: number; updatedAt: number;
}
export interface GridFinderPage {
  state: 'available'; timeframe: GridFinderTimeframe; historyCut: number; universe: string;
  cursor: number; nextCursor: number | null; total: number; ineligible: number;
  checked: number; unavailable: number; notRanging: number; truncated: boolean;
  deadlineReached: boolean; candidates: GridFinderCandidate[];
}
export const GRID_FINDER_LIMITS = Object.freeze({ markets: 20, concurrentReads: 2, deadlineMs: 15_000, bars: 100 });
