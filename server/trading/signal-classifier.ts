/**
 * Signal Classifier
 *
 * Classifies incoming TradingView webhook signals against the current tracked
 * (DB) position and returns one of five types: OPEN, PYRAMID, PARTIAL_CLOSE,
 * FULL_CLOSE, or FLIP.
 *
 * Design principle — anchor on intent, not a raw on-chain read:
 *   Pacifica has a ~10 s position-propagation lag.  Immediately after an entry
 *   fill the on-chain positions endpoint may still return size ≈ 0, so using
 *   it to classify a reduce signal would produce OPEN instead of PARTIAL_CLOSE.
 *   We use the DB position (which reflects what we last executed) as the source
 *   of truth for classification; the exchange's `reduceOnly` flag then makes
 *   the execution safe regardless of the current on-chain read.
 *
 * Covered cases (documented as regression anchors):
 *   ┌─────────────────────────────────┬────────────────────────────────────┐
 *   │ Scenario                        │ Expected type                      │
 *   ├─────────────────────────────────┼────────────────────────────────────┤
 *   │ FLAT, buy 2, tvSize=2           │ OPEN(add=2)                        │
 *   │ LONG 3, buy 1, tvSize=4         │ PYRAMID(add=1)                     │
 *   │ LONG 3, sell 1, tvSize=2        │ PARTIAL_CLOSE(close=1, frac=0.33)  │
 *   │ LONG 3, sell 3, tvSize=0        │ FULL_CLOSE(close=3)                │
 *   │ LONG 3, sell 2.9, tvSize=0.1    │ FULL_CLOSE (dust threshold)        │
 *   │ LONG 3, sell 4, tvSize=-1       │ FLIP(close=3, add=1)               │
 *   │ SHORT 3, buy 1, tvSize=-2       │ PARTIAL_CLOSE(close=1, frac=0.33)  │
 *   │ SHORT 3, buy 4, tvSize=1        │ FLIP(close=3, add=1)               │
 *   │ LONG 3, sell 1, tvSize=null     │ PARTIAL_CLOSE(close=1)  ← key fix  │
 *   │ Stale read shows FLAT, DB=LONG3 │ PARTIAL_CLOSE (uses DB, not chain) │
 *   └─────────────────────────────────┴────────────────────────────────────┘
 */

export type SignalType =
  | 'OPEN'
  | 'PYRAMID'
  | 'PARTIAL_CLOSE'
  | 'FULL_CLOSE'
  | 'FLIP';

export interface CurrentPositionState {
  side: 'LONG' | 'SHORT' | 'FLAT';
  /** Absolute value of the current position in base-asset units. */
  size: number;
  entryPrice: number;
}

export interface IncomingTvSignal {
  action: 'buy' | 'sell';
  /** Size of the incoming order (always positive). */
  contracts: number;
  /**
   * TradingView `strategy.position_size` — the SIGNED target state after the
   * trade executes (positive = long, negative = short, 0 = flat).
   * Null when the alert doesn't include this field.
   */
  strategyPositionSize: number | null;
}

export interface ClassifiedSignal {
  type: SignalType;
  /**
   * Contracts to close (positive, 0 for OPEN/PYRAMID).
   * For PARTIAL_CLOSE the exchange must be called with reduceOnly=true.
   */
  closeSize: number;
  /** Contracts to open/add (positive, 0 for PARTIAL_CLOSE/FULL_CLOSE). */
  addSize: number;
  /**
   * Fraction of the existing position being closed [0,1].
   * Meaningful for PARTIAL_CLOSE and FULL_CLOSE; 0 for OPEN/PYRAMID.
   * Used by the subscriber fan-out to close a proportional slice.
   */
  closedFraction: number;
}

/**
 * Dust threshold: if the target remaining position is less than this
 * fraction of the original we round it up to a FULL_CLOSE to avoid
 * leaving hair-thin dust positions that confuse the reconciler.
 */
const DUST_FRACTION = 0.03; // 3 %

/**
 * Classify an incoming TradingView signal against the current DB position.
 *
 * The caller is responsible for passing the DB position (not the on-chain
 * position) to avoid misclassification during protocol propagation lags.
 */
export function classifySignal(
  position: CurrentPositionState,
  signal: IncomingTvSignal,
): ClassifiedSignal {
  const { side, size } = position;
  const { action, contracts, strategyPositionSize } = signal;

  // ── 1. Explicit FULL_CLOSE: TV says target size is zero ─────────────────
  if (strategyPositionSize !== null && Math.abs(strategyPositionSize) < 0.0001) {
    if (side === 'FLAT' || size < 0.0001) {
      // Already flat — caller will handle the no-position case.
      return { type: 'FULL_CLOSE', closeSize: 0, addSize: 0, closedFraction: 1 };
    }
    return { type: 'FULL_CLOSE', closeSize: size, addSize: 0, closedFraction: 1 };
  }

  // ── 2. No existing position → OPEN ───────────────────────────────────────
  if (side === 'FLAT' || size < 0.0001) {
    return { type: 'OPEN', closeSize: 0, addSize: contracts, closedFraction: 0 };
  }

  const isCurrentlyLong = side === 'LONG';
  const signalIsLong = action === 'buy';

  // ── 3. Same direction → PYRAMID ─────────────────────────────────────────
  if (isCurrentlyLong === signalIsLong) {
    return { type: 'PYRAMID', closeSize: 0, addSize: contracts, closedFraction: 0 };
  }

  // ── 4. Opposite direction — PARTIAL_CLOSE, FULL_CLOSE, or FLIP ──────────
  // Here: (LONG + sell) or (SHORT + buy).

  if (strategyPositionSize !== null) {
    const targetSigned = strategyPositionSize;

    // Flip: TV target crosses zero to the opposite side.
    const crossesZero =
      (isCurrentlyLong && targetSigned < -0.0001) ||
      (!isCurrentlyLong && targetSigned > 0.0001);

    if (crossesZero) {
      return {
        type: 'FLIP',
        closeSize: size,
        addSize: Math.abs(targetSigned),
        closedFraction: 1,
      };
    }

    // Reduce: target is 0 ≤ |targetSigned| < current size.
    // (tvSize===0 was already handled above.)
    const targetSize = Math.abs(targetSigned);
    const sliceToClose = size - targetSize;

    if (sliceToClose <= 0.0001) {
      // Target ≥ current: treat as pyramid (TV may have rounded up slightly).
      return { type: 'PYRAMID', closeSize: 0, addSize: contracts, closedFraction: 0 };
    }

    const fraction = Math.min(sliceToClose / size, 1);

    if (fraction >= 1 - DUST_FRACTION) {
      // Closing ≥ 97 % → treat as full close to avoid dust.
      return { type: 'FULL_CLOSE', closeSize: size, addSize: 0, closedFraction: 1 };
    }

    return {
      type: 'PARTIAL_CLOSE',
      closeSize: sliceToClose,
      addSize: 0,
      closedFraction: fraction,
    };
  }

  // ── 5. No strategyPositionSize: contracts-vs-position heuristic ──────────
  // This is the KEY fix: previously this fell through to flip detection even
  // when contracts < position (e.g. sell 1 while LONG 3 was misclassified as
  // FLIP because there was no strategyPositionSize to disambiguate).

  const fraction = Math.min(contracts / size, 1);

  if (fraction >= 1 - DUST_FRACTION) {
    // contracts ≥ 97 % of position → full close.
    return { type: 'FULL_CLOSE', closeSize: size, addSize: 0, closedFraction: 1 };
  }

  if (contracts > 0.0001 && contracts < size) {
    // contracts < position → partial reduce, not a flip.
    return {
      type: 'PARTIAL_CLOSE',
      closeSize: contracts,
      addSize: 0,
      closedFraction: fraction,
    };
  }

  // contracts ≥ position and no tvSize → ambiguous; assume flip.
  return {
    type: 'FLIP',
    closeSize: size,
    addSize: Math.max(0, contracts - size),
    closedFraction: 1,
  };
}
