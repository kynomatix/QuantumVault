import type { GridGeometryInput, GridPlan, PairFee } from '../grid-bot/engine-types';
import type { ProtocolMarket } from '../protocol/protocol-types';
import type { ProvenancedOHLCV } from '../lab/datafeed';
import type { BtcStoredWeek } from '../../shared/grid-direction';
import type { BtcWeeklyStore } from './weekly-store';
import {PER_BOT_ORDINARY_MAX,GRID_FULL_WINDOW_SLOTS,GRID_PROTECTION_RESERVE,GRID_TRANSPORT_BATCH_ACTIONS} from '../../shared/grid-capacity';

// Pacifica candles are Planner-only; shared datafeed consumers keep their existing sources.
export type PlannerCandle = ProvenancedOHLCV | (Omit<ProvenancedOHLCV, 'provenance'> & {
  provenance: Omit<ProvenancedOHLCV['provenance'], 'source' | 'venue'> & {
    source: 'pacifica'; venue: 'pacifica'; aggregation?: 'weekly-from-daily';
  };
});

export type Fact<T> = { state: 'available'; value: T } | { state: 'unavailable'; reason: string };
export interface PlannerMarket {
  market: string; protocolSymbol: string; name: string;
  constraints: Fact<{ tick: string; lot: string; minimumQuote: string; observedAt: number; expiresAt: number;
    maxLeverage: Fact<string>; maximumQuote: Fact<string>; priceBounds: Fact<{ minimum: string; maximum: string }>;
    restrictions: Fact<string>; source: '/info'; venue: 'pacifica' }>;
  reference: Fact<{ price: string; observedAt: number; expiresAt: number; label: 'Cached Pacifica book reference price' }>;
}
export interface PlannerDeps {
  getMarkets(): Promise<ProtocolMarket[]>;
  refreshReference?(market: string, symbol: string, signal: AbortSignal): Promise<void>;
  cachedReference(market: string): { price: number; observedAt: number | null } | null;
  candles(market: string, timeframe: string, bars: number, signal: AbortSignal): Promise<PlannerCandle[]>;
  rangeCandles?(market: string, timeframe: string, bars: number, signal: AbortSignal): Promise<PlannerCandle[]>;
  btcWeeklyCandles?(signal: AbortSignal, start: number, end: number): Promise<BtcStoredWeek[]>;
  btcWeeklyStore?: BtcWeeklyStore;
  now(): number;
}
export interface PlannerQuery {
  market: string; side: 'long' | 'short'; lower: string; upper: string; intervals: number;
  entryScale: GridGeometryInput['entryScale']; profitScale: GridGeometryInput['profitScale']; seed: boolean;
  leverage: string; investment: string; stop: string; fee: string | null;
}
export interface PlannerPreview {
  state: 'diagnostic' | 'hypothetical_checks_passed' | 'rejected' | 'unavailable';
  reasons: string[]; market: PlannerMarket; retrievedAt: number; validForMs: number;
  requestedPlan: GridPlan | null; minimumPlan: GridPlan | null;
  minimum: Fact<string>; assumedMinimum: Fact<string>; feeRows: PairFee[];
  fee: { state: 'unknown' } | { state: 'assumption'; rate: string; label: 'Your assumption — not a venue quote' };
  stop: { state: 'unavailable'; reason: string };
  policy: typeof PLANNER_POLICY;
}
export const PLANNER_POLICY = {
  source: 'Owner 100-grid ruling 2026-10-14; H.5 capacity floor 2026-09-28',
  ordinaryWindow: PER_BOT_ORDINARY_MAX, requiredAvailableSlots: GRID_FULL_WINDOW_SLOTS, reserveSlots: GRID_PROTECTION_RESERVE, maximumIntervals: 100, transportBatch: GRID_TRANSPORT_BATCH_ACTIONS,
  liveAvailableSlots: { state: 'unavailable', reason: 'No account inventory is read by the Planner' },
  venueRestingMaximum: { state: 'unavailable', reason: 'Not established by the transport batch limit' },
  seedTakerFee: { state: 'unavailable', reason: 'No venue fee quote is read by the Planner' },
} as const;
export type PlannerChart = { state: 'available'; market: string; timeframe: string; requestedBars: number;
  actualBars: number; partial: boolean; retrievedAt: number; cacheInsertedAt: number; validForMs: number;
  candles: PlannerCandle[] } | { state: 'unavailable'; reason: string };
