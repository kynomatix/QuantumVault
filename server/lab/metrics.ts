// Trade-level metric helpers shared by all QuantumLab backtest paths.
//
// Single source of truth so a strategy's Sharpe is identical no matter which
// path computed it: the native engine return, the optimizer's Pine fallback
// (Pine runtime does not compute Sharpe), and the storage persistence fallback.

import type {
  LabBacktestResult,
  LabTradeRecord,
  LabWindowMetrics,
  LabOosMetrics,
} from "@shared/schema";

// Per-trade Sharpe: mean(per-trade % returns) / sample stdDev (n-1), rounded to
// 2dp. NOT annualized — a unitless consistency measure across trades. Matches
// the formula previously inlined in engine.ts and storage.calcSharpeFromTrades.
// < 2 trades or zero variance → 0 (no meaningful dispersion to measure).
export function sharpeFromTrades(trades: unknown): number {
  if (!Array.isArray(trades) || trades.length < 2) return 0;
  const returns = trades.map((t: any) => Number(t?.pnlPercent ?? 0));
  const n = returns.length;
  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  const stdDev = Math.sqrt(variance);
  return stdDev > 0 ? Math.round((mean / stdDev) * 100) / 100 : 0;
}

// Shared risk-adjusted objective for ranking optimizer results. Replaces the
// legacy score (netProfit × up-to-20× leverage), which rewarded raw curve-fit
// profit and ignored Sharpe entirely — the diagnosed overfit driver
// (docs/QUANTUMLAB_ACCURACY_DIAGNOSIS.md). Pure fn of result fields, so the
// lite + full scorers stay identical and the change is safe across resume.
// Scores are used only for RELATIVE ranking (sorts / strict-improvement
// guards), never compared to an absolute threshold — so the new, smaller scale
// is fine. Lives here (not in the worker) so it is unit-testable without
// triggering worker-thread bootstrap.
export function robustScore(m: {
  netProfitPercent: number;
  winRatePercent: number;
  maxDrawdownPercent: number;
  profitFactor: number;
  totalTrades: number;
  sharpeRatio?: number;
}): number {
  const net = m.netProfitPercent;
  const dd = Math.max(m.maxDrawdownPercent, 0);
  const sharpe = m.sharpeRatio ?? 0;
  const trades = m.totalTrades;

  // Calmar-ish return-to-DD, capped at 10×: beyond that is almost always a
  // tiny-DD curve-fit, not a durable edge. DD floored at 1% so a suspiciously
  // low drawdown can't manufacture an unbounded ratio.
  const calmar = Math.min(net / Math.max(dd, 1), 10);

  // Profit factor, clamped: PF from a couple of lucky trades (or the 999/0
  // sentinels the engine emits for zero-loss / zero-profit) is noise.
  const pf = Number.isFinite(m.profitFactor) ? Math.min(m.profitFactor, 5) : 5;

  // Trade-count confidence: stats from few trades are unreliable. Ramps 0→1
  // (20 trades ≈ 0.5, 50 ≈ 0.71, 100 ≈ 0.83). Multiplies only the positive
  // quality terms, so an under-traded config can't look better by being rare.
  const confidence = trades / (trades + 20);

  // Quality core: Sharpe (risk-adjusted return) is primary, then capped Calmar
  // and edge consistency (PF, win rate). Sharpe is per-trade and small (~0–2),
  // hence the ×100 weight.
  const quality =
      sharpe * 100
    + calmar * 40
    + pf * 20
    + m.winRatePercent * 0.5;

  // Confidence can only DISCOUNT a good config, never rescue a bad one:
  // applied to NEGATIVE quality it would let an under-traded loser outscore an
  // identical well-traded loser (smaller |confidence| → less negative). So gate
  // it on positive quality only. Raw return kept but heavily demoted (was the
  // dominant term); DD penalized explicitly, both outside the confidence gate
  // so losers stay penalized regardless of trade count.
  const adjustedQuality = quality >= 0 ? quality * confidence : quality;
  return adjustedQuality + net * 0.25 - dd * 2;
}

// ── Validity (Task 188): out-of-sample holdout helpers ───────────────────────
//
// The optimizer searches/selects on the in-sample HEAD slice and validates on
// the OOS tail. Search never sees OOS data (the real overfit fix). Finalize runs
// the surviving configs on the FULL window once, then splits the resulting trade
// list by entry time to produce IS-partition and OOS-partition metrics. These
// helpers are pure so they are unit-testable without the worker bootstrap.

// Minimum OOS trades for the partition to be considered conclusive. Fewer than
// this and the OOS window is marked `sufficient: false` (surfaced as
// "insufficient" rather than a misleading number) — robustScore's confidence
// term already discounts few-trade partitions, this is the harder gate.
export const MIN_OOS_TRADES = 5;

// Absolute IS/OOS boundary timestamp (ms) derived purely from the run's FIXED
// config date range. Resume-stable by construction: it does NOT depend on how
// many candles were fetched (candle drift across a resume can change array
// length but never moves this timestamp). Returns null when the holdout is
// disabled (fraction undefined/0) or the dates are unusable → full-window.
export function oosBoundaryMs(
  startDate: string | undefined,
  endDate: string | undefined,
  fraction: number | undefined,
): number | null {
  if (!fraction || fraction <= 0 || !startDate || !endDate) return null;
  const startMs = Date.parse(startDate);
  const endMs = Date.parse(endDate);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return startMs + (endMs - startMs) * (1 - fraction);
}

// Split a trade list into IS / OOS partitions by ENTRY time. A trade that opens
// in-sample but closes out-of-sample is assigned to IS (by entry) — this can only
// inflate the IS partition we already distrust, never the OOS partition we judge
// on. boundaryMs null → everything is in-sample (no split).
export function partitionTradesByEntry(
  trades: LabTradeRecord[],
  boundaryMs: number | null,
): { isTrades: LabTradeRecord[]; oosTrades: LabTradeRecord[] } {
  if (boundaryMs == null) return { isTrades: trades, oosTrades: [] };
  const isTrades: LabTradeRecord[] = [];
  const oosTrades: LabTradeRecord[] = [];
  for (const t of trades) {
    const entryMs = Date.parse(t.entryTime);
    if (Number.isFinite(entryMs) && entryMs >= boundaryMs) oosTrades.push(t);
    else isTrades.push(t);
  }
  return { isTrades, oosTrades };
}

// Trade-level window metrics. Net profit is EXACT for the engine's fixed-notional
// sizing (qty*positionSize, equity does NOT compound) → summing pnlDollar /
// initialCapital matches the engine's netProfitPercent semantics. maxDrawdown is
// APPROXIMATE: walked from the per-trade cumulative equity path (close-to-close on
// trade boundaries), since a partition has no intrabar equity. PF uses the same
// 999/0 sentinels the engine emits (clamped downstream by robustScore).
export function metricsFromTrades(
  trades: LabTradeRecord[],
  initialCapital: number,
): LabWindowMetrics {
  const totalTrades = trades.length;
  if (totalTrades === 0) {
    return { netProfitPercent: 0, winRatePercent: 0, maxDrawdownPercent: 0, profitFactor: 0, totalTrades: 0, sharpeRatio: 0 };
  }
  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let netDollar = 0;
  let equity = initialCapital;
  let peak = initialCapital;
  let maxDd = 0;
  for (const t of trades) {
    const pnl = Number(t.pnlDollar ?? 0);
    netDollar += pnl;
    if (pnl > 0) { wins++; grossProfit += pnl; }
    else if (pnl < 0) { grossLoss += -pnl; }
    equity += pnl;
    if (equity > peak) peak = equity;
    if (peak > 0) {
      const dd = ((peak - equity) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
    }
  }
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
  return {
    netProfitPercent: Math.round((netDollar / initialCapital) * 100 * 100) / 100,
    winRatePercent: Math.round((wins / totalTrades) * 100 * 100) / 100,
    maxDrawdownPercent: Math.round(maxDd * 100) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
    totalTrades,
    sharpeRatio: sharpeFromTrades(trades),
  };
}

// Partition a finalized full-window result's trades into IS + OOS metrics. Pure
// (no engine re-run): the trades already came from the full-window backtest.
export function computeWindowMetrics(
  trades: LabTradeRecord[],
  boundaryMs: number,
  initialCapital: number,
): { is: LabWindowMetrics; oos: LabOosMetrics } {
  const { isTrades, oosTrades } = partitionTradesByEntry(trades, boundaryMs);
  const is = metricsFromTrades(isTrades, initialCapital);
  const oosBase = metricsFromTrades(oosTrades, initialCapital);
  return { is, oos: { ...oosBase, sufficient: oosTrades.length >= MIN_OOS_TRADES } };
}

// OOS-dominant ranking score for finalized results (architect amendment #4).
// Rewards out-of-sample performance and PENALIZES IS→OOS divergence (the
// overfit signature). Degrades gracefully:
//   - no/insufficient OOS (legacy rows, holdout disabled, too-few OOS trades) →
//     robustScore(full) * 0.75 — a flat, deterministic demotion that never
//     rewards insufficiency and preserves full-period relative ordering.
//   - sufficient OOS → 0.35*robustScore(IS) + 0.65*robustScore(OOS)
//     - 50*max(0, sharpe_IS - sharpe_OOS). The Sharpe GAP (not ratio) is the
//       scale-stable divergence metric; a config that looks great in-sample but
//       falls apart out-of-sample is pushed down hard.
export function robustnessRank(r: LabBacktestResult): number {
  const full = robustScore({
    netProfitPercent: r.netProfitPercent,
    winRatePercent: r.winRatePercent,
    maxDrawdownPercent: r.maxDrawdownPercent,
    profitFactor: r.profitFactor,
    totalTrades: r.totalTrades,
    sharpeRatio: r.sharpeRatio,
  });
  if (!r.is || !r.oos || !r.oos.sufficient) return full * 0.75;
  const isScore = robustScore(r.is);
  const oosScore = robustScore(r.oos);
  const sharpeGap = Math.max(0, r.is.sharpeRatio - r.oos.sharpeRatio);
  return 0.35 * isScore + 0.65 * oosScore - 50 * sharpeGap;
}
