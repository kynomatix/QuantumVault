/**
 * Live-Data & Monitoring Spine — shared types (Phase 0, tracer bullet).
 *
 * Phase 0 is READ-ONLY shadow mode: connect each venue's real-time price feed,
 * store the latest tick + a bounded basis-deviation sample per symbol, and log.
 * NO consumers, NO trading, NO money path. See docs/LIVE_DATA_SPINE_PLAN.md.
 */

export type Venue = 'pacifica' | 'flash';

/**
 * A single real-time price observation for one symbol on one venue.
 *
 * Risk decisions (later phases) MUST use the venue's own `mark`. `oracle` is the
 * venue/settlement oracle price used ONLY for an intra-venue mark-vs-oracle
 * sanity cross-check; it is null when the venue/source does not provide one.
 */
export interface PriceTick {
  venue: Venue;
  /** Internal canonical symbol, e.g. "SOL-PERP". */
  internalSymbol: string;
  /** Venue mark price in USD. */
  mark: number;
  /** Venue/settlement oracle price in USD, or null when unavailable. */
  oracle: number | null;
  /** Funding rate as provided by the venue, or null when N/A. */
  funding: number | null;
  /** Source-reported timestamp of the price (ms epoch). */
  publishTime: number;
  /** Local wall-clock time the tick was received (ms epoch). */
  receivedAt: number;
}

/**
 * Summary statistics over a bounded window of |mark - oracle| / oracle samples
 * for one symbol. Used in Phase 0 to characterise the normal basis distribution
 * so later phases can seed per-symbol deviation thresholds (~p99.5 of normal).
 */
export interface BasisStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

/** Per-symbol view of the store, computed on demand for status/logging. */
export interface SymbolStatus {
  venue: Venue;
  internalSymbol: string;
  latest: PriceTick | null;
  lastSeenAt: number | null;
  /** now - lastSeenAt, or null if never seen. */
  ageMs: number | null;
  tickCount: number;
  /** Basis stats over the bounded deviation ring, or null when no samples. */
  basis: BasisStats | null;
}
