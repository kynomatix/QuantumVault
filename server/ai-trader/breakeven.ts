// Breakeven Protect — pure math + types for the AI Trader monitor's one-way
// stop-loss ratchet. PURE MODULE (paper-math conventions): no I/O, no storage,
// no adapter access — everything here is unit-testable in isolation.
//
// Rule (owner-approved 2026-07-17): once an open position's max favorable
// excursion since entry has covered >= 75% of the entry→TP distance, move the
// stop loss to entry ± a small fee buffer so a stop-out from that point on is
// a tiny net win instead of a full loss. Fires once per position, only ever
// tightens, never loosens. Applies to ALL AI Trader bots (paper + live,
// scanner included) — always-on, no user knob (defaults over choices).

import {
  evaluatePaperBracket,
  type PaperCandle,
  type PaperSide,
  type PaperBracketHit,
} from "./paper-math";

/** Fire when the favorable extreme has covered this fraction of entry→TP. */
export const BREAKEVEN_TRIGGER_PROGRESS = 0.75;

/**
 * New-SL offset from entry, in the favorable direction. Sized so a breakeven
 * stop-out nets slightly POSITIVE after costs on both paths:
 *   2 × 0.04% taker legs + 0.05% stop-fill slippage allowance (matches the
 *   paper synthetic slippage per leg) + 0.02% cushion = 0.15%.
 * A plain entry-price stop would net a small LOSS after fees — the owner
 * explicitly asked for "at least a small amount of profit".
 */
export const BREAKEVEN_BUFFER_RATE = 0.0015;

/** Bounded venue-move retries per decision (live only). */
export const BREAKEVEN_MAX_MOVE_ATTEMPTS = 5;

/**
 * Audit blob persisted inside clampedDecision when the ratchet fires. Its
 * PRESENCE is the fire-once flag. clampedDecision.stopLossPrice is mutated to
 * the moved stop at the same write, so every existing reader (parseOpenDecision,
 * G10 self-heal, exit classification, DTOs) sees the CURRENT stop; the original
 * is preserved here (and in rawDecision) for the audit trail.
 */
export interface BreakevenProtectState {
  originalStopLossPrice: number;
  movedStopLossPrice: number;
  /** ISO timestamp of the move (paper segmentation boundary derives from it). */
  movedAt: string;
  /** Progress toward TP (0..1+) measured when the ratchet fired. */
  progressAtFire: number;
}

/**
 * Validate a raw clampedDecision.breakevenProtect blob. Returns null when the
 * blob is absent; a PRESENT-but-malformed blob is coerced into a conservative
 * "already fired" state anchored at the moved/current stop so the ratchet
 * never re-fires or re-calls the venue on corrupt state.
 */
export function parseBreakevenProtect(
  raw: unknown,
  currentStopLossPrice: number,
  fallbackMovedAtMs: number
): BreakevenProtectState | null {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const numOk = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
  const movedAtMs = typeof o.movedAt === "string" ? new Date(o.movedAt).getTime() : NaN;
  return {
    originalStopLossPrice: numOk(o.originalStopLossPrice) ? o.originalStopLossPrice : currentStopLossPrice,
    movedStopLossPrice: numOk(o.movedStopLossPrice) ? o.movedStopLossPrice : currentStopLossPrice,
    movedAt: Number.isFinite(movedAtMs) ? (o.movedAt as string) : new Date(fallbackMovedAtMs).toISOString(),
    progressAtFire: numOk(o.progressAtFire) ? o.progressAtFire : BREAKEVEN_TRIGGER_PROGRESS,
  };
}

/**
 * Max favorable excursion across the given candles: highest high for a long,
 * lowest low for a short. Null when there are no candles.
 */
export function favorableExtreme(candles: readonly PaperCandle[], side: PaperSide): number | null {
  if (candles.length === 0) return null;
  let extreme = side === "long" ? -Infinity : Infinity;
  for (const c of candles) {
    if (side === "long") {
      if (c.high > extreme) extreme = c.high;
    } else if (c.low < extreme) {
      extreme = c.low;
    }
  }
  return Number.isFinite(extreme) ? extreme : null;
}

/**
 * Fraction of the entry→TP distance covered by the favorable extreme.
 * Returns 0 on degenerate inputs (zero/negative distance, bad numbers) —
 * a degenerate bracket must never fire the ratchet.
 */
export function progressTowardTp(
  side: PaperSide,
  entryPrice: number,
  takeProfitPrice: number,
  extreme: number
): number {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(takeProfitPrice) || !Number.isFinite(extreme)) return 0;
  const distance = side === "long" ? takeProfitPrice - entryPrice : entryPrice - takeProfitPrice;
  if (distance <= 0) return 0;
  const travelled = side === "long" ? extreme - entryPrice : entryPrice - extreme;
  return travelled <= 0 ? 0 : travelled / distance;
}

/** The moved stop: entry nudged in the favorable direction by the fee buffer. */
export function breakevenStopPrice(side: PaperSide, entryPrice: number): number {
  return side === "long"
    ? entryPrice * (1 + BREAKEVEN_BUFFER_RATE)
    : entryPrice * (1 - BREAKEVEN_BUFFER_RATE);
}

/** Is `price` on the favorable (still-open) side of `level` for this side? */
export function isFavorableSideOf(side: PaperSide, price: number, level: number): boolean {
  return side === "long" ? price > level : price < level;
}

/**
 * One-way ratchet guard: the candidate stop must be strictly TIGHTER than the
 * current stop (closer to/beyond entry in the favorable direction). Protects
 * against loosening when the AI already set a stop at or above breakeven.
 */
export function isTighterStop(side: PaperSide, candidateSl: number, currentSl: number): boolean {
  return side === "long" ? candidateSl > currentSl : candidateSl < currentSl;
}

/**
 * Segmented paper-bracket evaluation across a mid-trade stop move.
 *
 * Boundary convention mirrors the entry-candle exclusion (monitor WO-5): the
 * candle DURING which the move happened (`time <= moveCandleOpen`) still
 * evaluates against the ORIGINAL stop — its extremes predate the move, so it
 * must never test the new tighter stop (false-trigger otherwise). Strictly
 * later candles evaluate against the MOVED stop. TP is unchanged throughout.
 * Chronological correctness: the pre-move segment is evaluated first.
 */
export function evaluatePaperBracketWithMove(
  candles: readonly PaperCandle[],
  side: PaperSide,
  originalStopLossPrice: number,
  movedStopLossPrice: number,
  takeProfitPrice: number,
  moveCandleOpen: number
): PaperBracketHit | null {
  const pre = candles.filter((c) => c.time <= moveCandleOpen);
  const post = candles.filter((c) => c.time > moveCandleOpen);
  const preHit = evaluatePaperBracket(pre, side, originalStopLossPrice, takeProfitPrice);
  if (preHit) return preHit;
  return evaluatePaperBracket(post, side, movedStopLossPrice, takeProfitPrice);
}

/**
 * G8 consecutive-loss predicate (architect correction, breakeven-protect PR):
 * a stop-loss exit only counts toward the consecutive-loss streak when it
 * actually LOST money. A breakeven-protect stop-out is `exitReason: "sl"` with
 * a small positive PnL — three of those in a row must not pause the bot for
 * "consecutive stop-losses". Unknown PnL (null) on an SL exit still counts:
 * an exit we cannot account for is never treated as a win (fail closed).
 */
export function countsAsSlLoss(exitReason: string | null | undefined, realizedPnl: number | null | undefined): boolean {
  if (exitReason !== "sl") return false;
  return !(typeof realizedPnl === "number" && Number.isFinite(realizedPnl) && realizedPnl >= 0);
}
