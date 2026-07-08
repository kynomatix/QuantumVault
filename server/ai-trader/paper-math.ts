// Agentic Trader Plan Part B, WO-5 — paper-trading math. PURE MODULE: no imports
// beyond types, no I/O, no adapter/storage access. Built and unit-tested in WO-5
// (external audit, Gemini 3.5 #6) because WO-6's monitor imports it — without this
// split, WO-5's paper acceptance tests would depend on WO-6 code.
//
// Conventions (plan §2e):
// - Every paper fill pays a 0.05% synthetic slippage penalty per leg, always in
//   the adverse direction (entries fill worse than mark, exits fill worse than
//   the trigger level).
// - Candle-vs-bracket evaluation is CONSERVATIVE: if one candle spans both the
//   SL and the TP, count it as an SL hit — intra-candle path is unknowable, and
//   the paper record must never flatter the strategy.
// - Fees are modeled as taker on both legs (paper mirrors the live G4/G3 fee
//   assumptions so graduation stats are comparable to live economics).

export type PaperSide = "long" | "short";

/** A single OHLCV candle as served by the lab datafeed (time in ms epoch). */
export interface PaperCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** Synthetic slippage per fill leg — 0.05% (plan §2e, binding). */
export const PAPER_SLIPPAGE_PER_LEG = 0.0005;

/**
 * Hypothetical entry fill: mark price penalized in the adverse direction.
 * Longs BUY (fill higher than mark), shorts SELL (fill lower than mark).
 */
export function paperEntryPrice(markPrice: number, side: PaperSide): number {
  if (!Number.isFinite(markPrice) || markPrice <= 0) {
    throw new Error(`paperEntryPrice: invalid mark price ${markPrice}`);
  }
  return side === "long"
    ? markPrice * (1 + PAPER_SLIPPAGE_PER_LEG)
    : markPrice * (1 - PAPER_SLIPPAGE_PER_LEG);
}

/**
 * Hypothetical exit fill at a bracket trigger level, penalized in the adverse
 * direction. A long exit is a SELL (fills below the level); a short exit is a
 * BUY (fills above the level). Applies identically to SL and TP legs — the
 * trigger level is what differs, not the slippage sign.
 */
export function paperExitPrice(triggerLevel: number, side: PaperSide): number {
  if (!Number.isFinite(triggerLevel) || triggerLevel <= 0) {
    throw new Error(`paperExitPrice: invalid trigger level ${triggerLevel}`);
  }
  return side === "long"
    ? triggerLevel * (1 - PAPER_SLIPPAGE_PER_LEG)
    : triggerLevel * (1 + PAPER_SLIPPAGE_PER_LEG);
}

/**
 * Does this single candle trigger the SL leg, the TP leg, neither — or both
 * (in which case the conservative rule counts it as SL)?
 *
 * Long:  SL below entry (low ≤ sl triggers), TP above entry (high ≥ tp triggers).
 * Short: SL above entry (high ≥ sl triggers), TP below entry (low ≤ tp triggers).
 * Trigger comparisons are inclusive — touching the level counts as a fill
 * (conservative for SL; for TP it matches how exchanges trigger stop orders).
 */
export function evaluateCandleAgainstBracket(
  candle: PaperCandle,
  side: PaperSide,
  stopLossPrice: number,
  takeProfitPrice: number
): "sl" | "tp" | null {
  const slHit = side === "long" ? candle.low <= stopLossPrice : candle.high >= stopLossPrice;
  const tpHit = side === "long" ? candle.high >= takeProfitPrice : candle.low <= takeProfitPrice;
  if (slHit) return "sl"; // conservative: SL wins whenever it's touched, even if TP also hit
  if (tpHit) return "tp";
  return null;
}

export interface PaperBracketHit {
  leg: "sl" | "tp";
  /** The bracket level that triggered. */
  triggerLevel: number;
  /** Trigger level after the adverse exit-slippage penalty. */
  exitPrice: number;
  /** `time` of the candle that triggered. */
  candleTime: number;
}

/**
 * Walk candles oldest→newest and return the first bracket trigger, or null if
 * the position survives the whole window. Callers (WO-6 monitor) are
 * responsible for passing only candles AFTER the entry candle — this function
 * evaluates exactly the window it is given.
 */
export function evaluatePaperBracket(
  candles: readonly PaperCandle[],
  side: PaperSide,
  stopLossPrice: number,
  takeProfitPrice: number
): PaperBracketHit | null {
  if (!Number.isFinite(stopLossPrice) || !Number.isFinite(takeProfitPrice)) {
    throw new Error(
      `evaluatePaperBracket: non-finite bracket (sl=${stopLossPrice}, tp=${takeProfitPrice})`
    );
  }
  for (const candle of candles) {
    const hit = evaluateCandleAgainstBracket(candle, side, stopLossPrice, takeProfitPrice);
    if (hit) {
      const triggerLevel = hit === "sl" ? stopLossPrice : takeProfitPrice;
      return {
        leg: hit,
        triggerLevel,
        exitPrice: paperExitPrice(triggerLevel, side),
        candleTime: candle.time,
      };
    }
  }
  return null;
}

export interface PaperPnlResult {
  /** Price PnL before fees (slippage already embedded in the fill prices). */
  grossPnl: number;
  /** Taker fees paid on both legs: rate × (entryNotional + exitNotional). */
  fees: number;
  /** grossPnl − fees. */
  netPnl: number;
}

/**
 * Realized PnL for a completed paper round trip. `entryPrice`/`exitPrice` are
 * expected to already carry their slippage penalties (paperEntryPrice /
 * paperExitPrice outputs); this only adds the two taker-fee legs on notional.
 */
export function paperRealizedPnl(args: {
  side: PaperSide;
  entryPrice: number;
  exitPrice: number;
  sizeBase: number;
  takerFeeRate: number;
}): PaperPnlResult {
  const { side, entryPrice, exitPrice, sizeBase, takerFeeRate } = args;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) throw new Error(`paperRealizedPnl: invalid entryPrice ${entryPrice}`);
  if (!Number.isFinite(exitPrice) || exitPrice <= 0) throw new Error(`paperRealizedPnl: invalid exitPrice ${exitPrice}`);
  if (!Number.isFinite(sizeBase) || sizeBase <= 0) throw new Error(`paperRealizedPnl: invalid sizeBase ${sizeBase}`);
  if (!Number.isFinite(takerFeeRate) || takerFeeRate < 0) throw new Error(`paperRealizedPnl: invalid takerFeeRate ${takerFeeRate}`);
  const direction = side === "long" ? 1 : -1;
  const grossPnl = (exitPrice - entryPrice) * sizeBase * direction;
  const fees = takerFeeRate * (entryPrice + exitPrice) * sizeBase;
  return { grossPnl, fees, netPnl: grossPnl - fees };
}
