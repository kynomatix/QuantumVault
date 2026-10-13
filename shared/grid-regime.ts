export type GridRegime = { state: 'available'; market: string; timeframe: string; adx: number;
  label: 'ranging' | 'transitional' | 'trending'; venue: 'okx' | 'gate' | 'hyperliquid' | 'pacifica';
  bars: number; latestFinalizedTime: number } | { state: 'unavailable'; reason: string };
