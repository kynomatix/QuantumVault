export type Scale = 'flat' | 'ascending' | 'descending';
export interface GridGeometryInput {
  policyVersion?: '1.0.0' | '2.0.0'; maximumQuote?: string;
  side: 'long' | 'short'; lower: string; upper: string; start: string;
  intervals: number; entryScale: Scale; profitScale: Scale; seed: boolean;
  leverage: string; tick: string; lot: string; minimumQuote: string;
  investmentStep: string; transferFloor: string; effectiveMakerCostRate?: string | null;
}
export interface GridInput extends GridGeometryInput { investment: string }
export type GridPriceInput = Pick<GridGeometryInput, 'lower' | 'upper' | 'intervals' | 'tick'>;
export interface GridPriceLevel { ordinal: number; price: string }
export type GridPriceResult = { ok: true; lines: GridPriceLevel[] } | { ok: false; issues: GridIssue[] };
export type GridIssueCode = 'invalid_decimal' | 'invalid_geometry' | 'invalid_start'
  | 'duplicate_prices' | 'invalid_investment' | 'underfunded' | 'fee_clearance' | 'search_limit';
export interface GridIssue { code: GridIssueCode; reason: string; ordinal?: number }
export interface GridLine {
  ordinal: number; price: string; quantity: string; notional: string;
  role: 'entry' | 'seed_exit' | 'virtual'; pairedExitOrdinal: number | null;
}
export interface PairFee {
  ordinal: number; entryPrice: string; exitPrice: string; quantity: string;
  spread: string; requiredSpread: string; assumedRoundTripFee: string; clears: boolean;
}
export interface GridPlan {
  policyVersion?: '2.0.0'; cycles?: GridCycle[]; capacityPrice?: string; capacityNotional?: string;
  side: 'long' | 'short'; start: string; investment: string; leverage: string;
  lines: GridLine[]; seedQuantity: string; allocatedNotional: string; unallocatedNotional: string;
  feeGate: 'not_evaluated' | 'evaluated'; feeRows: PairFee[];
  openingOrderLift?: { count: number; minimumQuote: string; ordinals?: number[] };
}
/** All ordinals here are zero-based, including reconstructed persisted cycle owners. */
export interface GridCycle {
  ownerOrdinal: number; anchor: 'opening' | 'closing';
  openingOrdinal: number; closingOrdinal: number; openingPrice: string; closingPrice: string;
  quantity: string; initialInventory: string; initialOpeningCredit: string;
}
export type GridResult = { ok: true; plan: GridPlan } | { ok: false; issues: GridIssue[] };
export type MinimumResult = { ok: true; investment: string; plan: GridPlan; evaluations: number }
  | { ok: false; issues: GridIssue[]; evaluations: number };
