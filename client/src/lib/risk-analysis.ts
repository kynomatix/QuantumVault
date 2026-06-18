import { getMaxLeverage } from "@/lib/exchange-constants";
import type { LabTradeRecord, LabRiskAnalysis } from "@shared/schema";

// Default per-market leverage cap used when no ticker (and thus no venue cap) is
// available. Intentionally low so risk math never assumes more headroom than a
// market actually allows.
export const CONSERVATIVE_FALLBACK = 5;

export function calculateRiskAnalysis(
  trades: LabTradeRecord[],
  netProfitPercent: number,
  maxDrawdownPercent: number,
  winRatePercent: number,
  equityCurve?: { time: string; equity: number }[],
  ticker?: string,
  maxLeverageOverride?: number
): LabRiskAnalysis {
  const closedTrades = trades.filter(t => t.exitReason !== "Open Position");
  if (closedTrades.length === 0) {
    return {
      maxDrawdownPercent, recommendedLeverage: 1, maxSafeLeverage: 1, liquidationBuffer: 0,
      longestLosingStreak: 0, avgLossPercent: 0, avgWinPercent: 0,
      worstTradePercent: 0, recoveryFactor: 0, kellyPercent: 0, riskOfRuin: 100,
      recommendedWalletAllocation: 0, minCapitalRequired: 0, streakDrawdownPercent: 0,
      avgBarsInDrawdown: 0, riskRating: "EXTREME",
      recommendations: ["Insufficient trade data for risk analysis."],
    };
  }

  const wins = closedTrades.filter(t => t.pnlPercent > 0);
  const losses = closedTrades.filter(t => t.pnlPercent <= 0);
  const avgWinPercent = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPercent, 0) / wins.length : 0;
  const avgLossPercent = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnlPercent, 0) / losses.length) : 0;
  const worstTradePercent = Math.min(...closedTrades.map(t => t.pnlPercent));

  let longestLosingStreak = 0, currentStreak = 0;
  for (const t of closedTrades) {
    if (t.pnlPercent <= 0) { currentStreak++; longestLosingStreak = Math.max(longestLosingStreak, currentStreak); }
    else { currentStreak = 0; }
  }
  const streakDrawdownPercent = longestLosingStreak * avgLossPercent;

  let avgBarsInDrawdown = 0;
  if (equityCurve && equityCurve.length > 1) {
    let peakEquity = equityCurve[0].equity, drawdownBars = 0, drawdownPeriods = 0, totalDrawdownBars = 0, inDrawdown = false;
    for (const pt of equityCurve) {
      if (pt.equity >= peakEquity) { peakEquity = pt.equity; if (inDrawdown) { totalDrawdownBars += drawdownBars; drawdownPeriods++; drawdownBars = 0; inDrawdown = false; } }
      else { inDrawdown = true; drawdownBars++; }
    }
    if (inDrawdown) { totalDrawdownBars += drawdownBars; drawdownPeriods++; }
    avgBarsInDrawdown = drawdownPeriods > 0 ? Math.round(totalDrawdownBars / drawdownPeriods) : 0;
  }

  const winRate = winRatePercent / 100, lossRate = 1 - winRate;
  const kellyPercent = avgLossPercent > 0 && avgWinPercent > 0
    ? Math.max(0, (winRate * avgWinPercent - lossRate * avgLossPercent) / avgWinPercent) * 100 : 0;

  let riskOfRuin = 0;
  if (avgWinPercent > 0 && avgLossPercent > 0 && winRate > 0 && winRate < 1) {
    const rr = avgWinPercent / avgLossPercent;
    const edgeRatio = (1 + rr) * winRate - 1;
    if (edgeRatio <= 0) riskOfRuin = 100;
    else { const q = lossRate / winRate; const bankrollUnits = 100 / avgLossPercent; riskOfRuin = Math.min(100, Math.max(0, Math.pow(q, bankrollUnits) * 100)); }
  }

  const recoveryFactor = maxDrawdownPercent > 0 ? netProfitPercent / maxDrawdownPercent : 0;

  const MAX_LEVERAGE_CAP = maxLeverageOverride ?? (ticker ? getMaxLeverage(ticker) : CONSERVATIVE_FALLBACK);
  const maxSafeLeverage = maxDrawdownPercent > 0 ? Math.min(MAX_LEVERAGE_CAP, Math.max(1, Math.floor((100 / maxDrawdownPercent) * 0.8))) : 1;
  const streakSafety = streakDrawdownPercent > 0 ? Math.min(MAX_LEVERAGE_CAP, Math.max(1, Math.floor(100 / (streakDrawdownPercent * 1.5)))) : maxSafeLeverage;
  const recommendedLeverage = Math.max(1, Math.min(maxSafeLeverage, streakSafety));
  const recDD = maxDrawdownPercent * recommendedLeverage;
  const liquidationBuffer = recDD > 0 ? Math.round((100 - recDD) / 100 * 100) : 0;

  const fixedTradeSize = 1000;
  const recDrawdownDollar = (maxDrawdownPercent * recommendedLeverage / 100) * fixedTradeSize;
  const recStreakDollar = (streakDrawdownPercent * recommendedLeverage / 100) * fixedTradeSize;
  const worstCaseBuffer = Math.max(recDrawdownDollar, recStreakDollar) * 1.5;
  const recommendedWalletAllocation = Math.round(fixedTradeSize + worstCaseBuffer);
  const minCapitalRequired = Math.round(fixedTradeSize + recDrawdownDollar);

  let riskRating: LabRiskAnalysis["riskRating"];
  if (recDD <= 15 && longestLosingStreak <= 3 && recoveryFactor >= 3) riskRating = "LOW";
  else if (recDD <= 35 && longestLosingStreak <= 6 && recoveryFactor >= 1.5) riskRating = "MODERATE";
  else if (recDD <= 60 && recoveryFactor >= 0.5) riskRating = "HIGH";
  else riskRating = "EXTREME";

  const recommendations: string[] = [];
  recommendations.push(`Use ${recommendedLeverage}x leverage (max safe: ${maxSafeLeverage}x). At ${recommendedLeverage}x, max drawdown would be ${recDD.toFixed(1)}%.`);
  if (longestLosingStreak >= 4) recommendations.push(`Strategy had ${longestLosingStreak} consecutive losses (${(streakDrawdownPercent * recommendedLeverage).toFixed(1)}% at ${recommendedLeverage}x). Allocate extra buffer capital.`);
  if (recommendedLeverage <= 2) recommendations.push(`High per-trade drawdown limits leverage to ${recommendedLeverage}x. Consider tightening stop losses.`);
  recommendations.push(`Allocate at least $${recommendedWalletAllocation} per $1,000 trade size to survive worst-case drawdowns at ${recommendedLeverage}x.`);
  if (recoveryFactor < 1) recommendations.push(`Recovery factor is ${recoveryFactor.toFixed(2)} — drawdowns are larger than returns. High risk.`);
  else if (recoveryFactor >= 3) recommendations.push(`Strong recovery factor of ${recoveryFactor.toFixed(2)} — strategy recovers well from drawdowns.`);
  if (riskOfRuin > 20) recommendations.push(`Risk of ruin is ${riskOfRuin.toFixed(1)}%. Use half-Kelly position sizing to protect capital.`);
  if (kellyPercent > 0) recommendations.push(`Kelly criterion suggests ${kellyPercent.toFixed(1)}% of capital per trade. Use half-Kelly (${(kellyPercent / 2).toFixed(1)}%) for safety.`);
  if (avgBarsInDrawdown > 20) recommendations.push(`Average drawdown lasts ${avgBarsInDrawdown} bars. Be patient — early losses are normal.`);

  return {
    maxDrawdownPercent: Math.round(maxDrawdownPercent * 100) / 100, recommendedLeverage, maxSafeLeverage,
    liquidationBuffer: Math.max(0, liquidationBuffer), longestLosingStreak,
    avgLossPercent: Math.round(avgLossPercent * 100) / 100, avgWinPercent: Math.round(avgWinPercent * 100) / 100,
    worstTradePercent: Math.round(worstTradePercent * 100) / 100, recoveryFactor: Math.round(recoveryFactor * 100) / 100,
    kellyPercent: Math.round(kellyPercent * 100) / 100, riskOfRuin: Math.round(riskOfRuin * 100) / 100,
    recommendedWalletAllocation, minCapitalRequired, streakDrawdownPercent: Math.round(streakDrawdownPercent * 100) / 100,
    avgBarsInDrawdown, riskRating, recommendations,
  };
}
