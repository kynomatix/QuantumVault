import type { LabPineInput } from "@shared/schema";

interface TradeRecord {
  direction: "long" | "short";
  pnlPercent: number;
  pnlDollar: number;
  exitReason: string;
  barsHeld: number;
}

function sanitizeTrade(raw: any): TradeRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const dir = raw.direction;
  if (dir !== "long" && dir !== "short") return null;
  const pnl = typeof raw.pnlPercent === "number" ? raw.pnlPercent : parseFloat(raw.pnlPercent);
  if (isNaN(pnl)) return null;
  return {
    direction: dir,
    pnlPercent: pnl,
    pnlDollar: typeof raw.pnlDollar === "number" ? raw.pnlDollar : 0,
    exitReason: typeof raw.exitReason === "string" ? raw.exitReason : "unknown",
    barsHeld: typeof raw.barsHeld === "number" ? raw.barsHeld : 0,
  };
}

interface ResultData {
  ticker: string;
  timeframe: string;
  netProfitPercent: number;
  winRatePercent: number;
  maxDrawdownPercent: number;
  profitFactor: number;
  totalTrades: number;
  params: Record<string, any>;
  trades: TradeRecord[];
}

export interface ParamBucket {
  range: string;
  rangeMin: number;
  rangeMax: number;
  count: number;
  avgProfit: number;
  avgWinRate: number;
  avgDrawdown: number;
  avgProfitFactor: number;
}

export interface ParamSensitivity {
  name: string;
  label: string;
  type: string;
  buckets: ParamBucket[];
  bestBucket: ParamBucket;
  worstBucket: ParamBucket;
  impactScore: number;
  recommendation: string;
}

export interface ComboFit {
  ticker: string;
  timeframe: string;
  count: number;
  avgProfit: number;
  avgWinRate: number;
  avgDrawdown: number;
  avgProfitFactor: number;
  bestLevProfit: number;
  bestLeverage: number;
  rating: "strong" | "moderate" | "weak" | "poor";
}

export interface DirectionalBias {
  longWinRate: number;
  shortWinRate: number;
  longAvgPnl: number;
  shortAvgPnl: number;
  longCount: number;
  shortCount: number;
  bias: "long" | "short" | "neutral";
  biasStrength: number;
}

export interface ExitReasonBreakdown {
  reason: string;
  count: number;
  percent: number;
  avgPnl: number;
  winRate: number;
}

export interface TradePatterns {
  avgBarsWinners: number;
  avgBarsLosers: number;
  barsRatio: number;
  exitReasons: ExitReasonBreakdown[];
  avgWinSize: number;
  avgLossSize: number;
  winLossRatio: number;
}

export type SuggestionSeverity = "info" | "warning" | "critical";

export interface Suggestion {
  text: string;
  severity: SuggestionSeverity;
  category: string;
}

export interface StrategyInsightsReport {
  strategyName: string;
  totalResults: number;
  totalRuns: number;
  totalTrades: number;
  paramSensitivity: ParamSensitivity[];
  comboFit: ComboFit[];
  directionalBias: DirectionalBias;
  tradePatterns: TradePatterns;
  suggestions: Suggestion[];
}

function computeMaxSafeLeverage(dd: number): number {
  if (dd <= 0) return 1;
  return Math.min(20, Math.max(1, Math.floor((100 / dd) * 0.8)));
}

function bucketize(values: number[], numBuckets: number = 4): { min: number; max: number }[] {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const buckets: { min: number; max: number }[] = [];
  const bucketSize = Math.ceil(sorted.length / numBuckets);
  for (let i = 0; i < numBuckets; i++) {
    const start = i * bucketSize;
    const end = Math.min(start + bucketSize - 1, sorted.length - 1);
    if (start >= sorted.length) break;
    buckets.push({ min: sorted[start], max: sorted[end] });
  }
  return buckets;
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function analyzeParamSensitivity(results: ResultData[], inputs: LabPineInput[]): ParamSensitivity[] {
  const optimizable = inputs.filter(i => i.optimizable && (i.type === "int" || i.type === "float"));
  const sensitivities: ParamSensitivity[] = [];

  for (const input of optimizable) {
    const paramValues = results.map(r => {
      const v = r.params[input.name];
      return typeof v === "number" ? v : parseFloat(v);
    }).filter(v => !isNaN(v) && isFinite(v));
    if (paramValues.length < 4) continue;

    const uniqueValues = new Set(paramValues);
    let ranges: { min: number; max: number }[];

    if (uniqueValues.size <= 6) {
      ranges = [...uniqueValues].sort((a, b) => a - b).map(v => ({ min: v, max: v }));
    } else {
      ranges = bucketize(paramValues, 4);
    }

    const buckets: ParamBucket[] = ranges.map(range => {
      const matching = results.filter(r => {
        const raw = r.params[input.name];
        const v = typeof raw === "number" ? raw : parseFloat(raw);
        return !isNaN(v) && v >= range.min && v <= range.max;
      });
      return {
        range: range.min === range.max ? `${range.min}` : `${range.min}–${range.max}`,
        rangeMin: range.min,
        rangeMax: range.max,
        count: matching.length,
        avgProfit: avg(matching.map(r => r.netProfitPercent)),
        avgWinRate: avg(matching.map(r => r.winRatePercent)),
        avgDrawdown: avg(matching.map(r => r.maxDrawdownPercent)),
        avgProfitFactor: avg(matching.map(r => r.profitFactor)),
      };
    }).filter(b => b.count > 0);

    if (buckets.length < 2) continue;

    const sorted = [...buckets].sort((a, b) => b.avgProfit - a.avgProfit);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    const impactScore = Math.abs(best.avgProfit - worst.avgProfit);

    let recommendation = "";
    if (impactScore > 5) {
      recommendation = `Focus ${input.label || input.name} in range ${best.range} (avg profit ${best.avgProfit.toFixed(1)}% vs ${worst.avgProfit.toFixed(1)}% in ${worst.range})`;
    } else if (impactScore > 2) {
      recommendation = `${input.label || input.name} range ${best.range} slightly favored (${best.avgProfit.toFixed(1)}% avg profit)`;
    } else {
      recommendation = `${input.label || input.name} has minimal impact on results — consider fixing to default`;
    }

    sensitivities.push({
      name: input.name,
      label: input.label || input.name,
      type: input.type,
      buckets,
      bestBucket: best,
      worstBucket: worst,
      impactScore,
      recommendation,
    });
  }

  return sensitivities.sort((a, b) => b.impactScore - a.impactScore);
}

function analyzeComboFit(results: ResultData[]): ComboFit[] {
  const comboMap = new Map<string, ResultData[]>();
  for (const r of results) {
    const key = `${r.ticker}|${r.timeframe}`;
    if (!comboMap.has(key)) comboMap.set(key, []);
    comboMap.get(key)!.push(r);
  }

  const fits: ComboFit[] = [];
  for (const [key, group] of comboMap) {
    const [ticker, timeframe] = key.split("|");
    const avgProfit = avg(group.map(r => r.netProfitPercent));
    const avgWinRate = avg(group.map(r => r.winRatePercent));
    const avgDrawdown = avg(group.map(r => r.maxDrawdownPercent));
    const avgProfitFactor = avg(group.map(r => r.profitFactor));

    let bestLevProfit = -Infinity;
    let bestLeverage = 1;
    for (const r of group) {
      const lev = computeMaxSafeLeverage(r.maxDrawdownPercent);
      const levP = r.netProfitPercent * lev;
      if (levP > bestLevProfit) {
        bestLevProfit = levP;
        bestLeverage = lev;
      }
    }

    let rating: ComboFit["rating"] = "poor";
    if (avgProfit > 10 && avgWinRate > 50) rating = "strong";
    else if (avgProfit > 5 || avgWinRate > 50) rating = "moderate";
    else if (avgProfit > 0) rating = "weak";

    fits.push({ ticker, timeframe, count: group.length, avgProfit, avgWinRate, avgDrawdown, avgProfitFactor, bestLevProfit, bestLeverage, rating });
  }

  return fits.sort((a, b) => b.avgProfit - a.avgProfit);
}

function analyzeDirectionalBias(results: ResultData[]): DirectionalBias {
  const allTrades: TradeRecord[] = [];
  for (const r of results) {
    if (r.trades) allTrades.push(...r.trades);
  }

  const longs = allTrades.filter(t => t.direction === "long");
  const shorts = allTrades.filter(t => t.direction === "short");

  const longWins = longs.filter(t => t.pnlPercent > 0).length;
  const shortWins = shorts.filter(t => t.pnlPercent > 0).length;

  const longWinRate = longs.length > 0 ? (longWins / longs.length) * 100 : 0;
  const shortWinRate = shorts.length > 0 ? (shortWins / shorts.length) * 100 : 0;
  const longAvgPnl = avg(longs.map(t => t.pnlPercent));
  const shortAvgPnl = avg(shorts.map(t => t.pnlPercent));

  const winRateDiff = longWinRate - shortWinRate;
  const pnlDiff = longAvgPnl - shortAvgPnl;

  let bias: DirectionalBias["bias"] = "neutral";
  let biasStrength = 0;
  if (Math.abs(winRateDiff) > 10 || Math.abs(pnlDiff) > 0.5) {
    bias = winRateDiff > 0 || pnlDiff > 0 ? "long" : "short";
    biasStrength = Math.abs(winRateDiff) + Math.abs(pnlDiff) * 10;
  }

  return { longWinRate, shortWinRate, longAvgPnl, shortAvgPnl, longCount: longs.length, shortCount: shorts.length, bias, biasStrength };
}

function analyzeTradePatterns(results: ResultData[]): TradePatterns {
  const allTrades: TradeRecord[] = [];
  for (const r of results) {
    if (r.trades) allTrades.push(...r.trades);
  }

  const winners = allTrades.filter(t => t.pnlPercent > 0);
  const losers = allTrades.filter(t => t.pnlPercent <= 0);

  const avgBarsWinners = avg(winners.map(t => t.barsHeld));
  const avgBarsLosers = avg(losers.map(t => t.barsHeld));
  const barsRatio = avgBarsLosers > 0 ? avgBarsWinners / avgBarsLosers : 0;

  const avgWinSize = avg(winners.map(t => t.pnlPercent));
  const avgLossSize = Math.abs(avg(losers.map(t => t.pnlPercent)));
  const winLossRatio = avgLossSize > 0 ? avgWinSize / avgLossSize : 0;

  const reasonMap = new Map<string, TradeRecord[]>();
  for (const t of allTrades) {
    const reason = t.exitReason || "unknown";
    if (!reasonMap.has(reason)) reasonMap.set(reason, []);
    reasonMap.get(reason)!.push(t);
  }

  const exitReasons: ExitReasonBreakdown[] = [];
  for (const [reason, trades] of reasonMap) {
    const wins = trades.filter(t => t.pnlPercent > 0).length;
    exitReasons.push({
      reason,
      count: trades.length,
      percent: allTrades.length > 0 ? (trades.length / allTrades.length) * 100 : 0,
      avgPnl: avg(trades.map(t => t.pnlPercent)),
      winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
    });
  }
  exitReasons.sort((a, b) => b.count - a.count);

  return { avgBarsWinners, avgBarsLosers, barsRatio, exitReasons, avgWinSize, avgLossSize, winLossRatio };
}

function generateSuggestions(
  paramSensitivity: ParamSensitivity[],
  comboFit: ComboFit[],
  directionalBias: DirectionalBias,
  tradePatterns: TradePatterns,
): Suggestion[] {
  const suggestions: Suggestion[] = [];

  for (const param of paramSensitivity) {
    if (param.impactScore > 5) {
      suggestions.push({
        text: param.recommendation,
        severity: "critical",
        category: "Parameters",
      });
    } else if (param.impactScore > 2) {
      suggestions.push({
        text: param.recommendation,
        severity: "warning",
        category: "Parameters",
      });
    } else {
      suggestions.push({
        text: param.recommendation,
        severity: "info",
        category: "Parameters",
      });
    }
  }

  const poorCombos = comboFit.filter(c => c.rating === "poor");
  if (poorCombos.length > 0) {
    const names = poorCombos.map(c => `${c.ticker.split("/")[0]} ${c.timeframe}`).join(", ");
    suggestions.push({
      text: `Consider removing underperforming combos: ${names} (consistently negative avg profit)`,
      severity: "warning",
      category: "Markets",
    });
  }

  const strongCombos = comboFit.filter(c => c.rating === "strong");
  if (strongCombos.length > 0) {
    const names = strongCombos.map(c => `${c.ticker.split("/")[0]} ${c.timeframe}`).join(", ");
    suggestions.push({
      text: `Strategy performs best on: ${names} — focus optimization here`,
      severity: "info",
      category: "Markets",
    });
  }

  if (directionalBias.bias !== "neutral" && directionalBias.biasStrength > 15) {
    const dir = directionalBias.bias;
    const otherDir = dir === "long" ? "short" : "long";
    const dirWR = dir === "long" ? directionalBias.longWinRate : directionalBias.shortWinRate;
    const otherWR = dir === "long" ? directionalBias.shortWinRate : directionalBias.longWinRate;
    suggestions.push({
      text: `Strong ${dir} bias detected (${dir} WR: ${dirWR.toFixed(1)}% vs ${otherDir} WR: ${otherWR.toFixed(1)}%). Consider ${otherDir === "short" ? "improving short entry conditions or disabling shorts" : "improving long entry conditions or disabling longs"}`,
      severity: "warning",
      category: "Direction",
    });
  }

  if (tradePatterns.winLossRatio < 1.0 && tradePatterns.avgLossSize > 0) {
    suggestions.push({
      text: `Average win (${tradePatterns.avgWinSize.toFixed(2)}%) is smaller than average loss (${tradePatterns.avgLossSize.toFixed(2)}%). Consider widening take profit or tightening stop loss to improve reward/risk ratio`,
      severity: "critical",
      category: "Risk Management",
    });
  } else if (tradePatterns.winLossRatio > 2.0) {
    suggestions.push({
      text: `Good reward/risk ratio: wins average ${tradePatterns.avgWinSize.toFixed(2)}% vs losses ${tradePatterns.avgLossSize.toFixed(2)}% (${tradePatterns.winLossRatio.toFixed(1)}:1)`,
      severity: "info",
      category: "Risk Management",
    });
  }

  if (tradePatterns.barsRatio > 2.0) {
    suggestions.push({
      text: `Winners held ${tradePatterns.avgBarsWinners.toFixed(1)} bars vs losers ${tradePatterns.avgBarsLosers.toFixed(1)} bars — losers are cut quickly, which is good`,
      severity: "info",
      category: "Trade Management",
    });
  } else if (tradePatterns.barsRatio < 0.8 && tradePatterns.avgBarsLosers > 0) {
    suggestions.push({
      text: `Losers held ${tradePatterns.avgBarsLosers.toFixed(1)} bars vs winners ${tradePatterns.avgBarsWinners.toFixed(1)} bars — consider adding a time-based exit to cut losing trades faster`,
      severity: "warning",
      category: "Trade Management",
    });
  }

  const slExits = tradePatterns.exitReasons.find(e => e.reason.toLowerCase().includes("sl") || e.reason.toLowerCase().includes("stop"));
  if (slExits && slExits.percent > 60) {
    suggestions.push({
      text: `${slExits.percent.toFixed(0)}% of trades exit via stop loss — entry conditions may be too loose, or stop loss too tight`,
      severity: "warning",
      category: "Risk Management",
    });
  }

  const tpExits = tradePatterns.exitReasons.find(e => e.reason.toLowerCase().includes("tp") || e.reason.toLowerCase().includes("take") || e.reason.toLowerCase().includes("profit"));
  if (tpExits && tpExits.percent > 60) {
    suggestions.push({
      text: `${tpExits.percent.toFixed(0)}% of trades hit take profit — consider using a trailing stop or wider TP to let winners run further`,
      severity: "info",
      category: "Trade Management",
    });
  }

  return suggestions;
}

export function generateInsightsReport(
  results: ResultData[],
  inputs: LabPineInput[],
  strategyName: string,
  totalRuns: number,
): StrategyInsightsReport {
  const sanitized = results.map(r => ({
    ...r,
    trades: (Array.isArray(r.trades) ? r.trades : [])
      .map(sanitizeTrade)
      .filter((t): t is TradeRecord => t !== null),
  }));
  const totalTrades = sanitized.reduce((s, r) => s + r.trades.length, 0);

  const paramSensitivity = analyzeParamSensitivity(sanitized, inputs);
  const comboFit = analyzeComboFit(sanitized);
  const directionalBias = analyzeDirectionalBias(sanitized);
  const tradePatterns = analyzeTradePatterns(sanitized);
  const suggestions = generateSuggestions(paramSensitivity, comboFit, directionalBias, tradePatterns);

  return {
    strategyName,
    totalResults: results.length,
    totalRuns,
    totalTrades,
    paramSensitivity,
    comboFit,
    directionalBias,
    tradePatterns,
    suggestions,
  };
}

export function formatReportAsText(report: StrategyInsightsReport, pineScript?: string): string {
  const lines: string[] = [];

  lines.push("=== STRATEGY INSIGHTS REPORT ===");
  lines.push(`Strategy: ${report.strategyName}`);
  lines.push(`Dataset: ${report.totalResults} configurations across ${report.totalRuns} optimization runs`);
  lines.push(`Total trades analyzed: ${report.totalTrades.toLocaleString()}`);
  lines.push("");

  lines.push("--- PARAMETER SENSITIVITY ---");
  if (report.paramSensitivity.length === 0) {
    lines.push("No significant parameter sensitivity detected.");
  } else {
    for (const param of report.paramSensitivity) {
      lines.push(`\n${param.label} (${param.name}) — Impact: ${param.impactScore.toFixed(1)}`);
      lines.push(`  Best range: ${param.bestBucket.range} → avg profit ${param.bestBucket.avgProfit.toFixed(1)}%, WR ${param.bestBucket.avgWinRate.toFixed(1)}%, DD ${param.bestBucket.avgDrawdown.toFixed(1)}%`);
      lines.push(`  Worst range: ${param.worstBucket.range} → avg profit ${param.worstBucket.avgProfit.toFixed(1)}%, WR ${param.worstBucket.avgWinRate.toFixed(1)}%, DD ${param.worstBucket.avgDrawdown.toFixed(1)}%`);
      lines.push(`  All ranges:`);
      for (const b of param.buckets) {
        lines.push(`    ${b.range} (${b.count} configs): profit ${b.avgProfit.toFixed(1)}%, WR ${b.avgWinRate.toFixed(1)}%, DD ${b.avgDrawdown.toFixed(1)}%, PF ${b.avgProfitFactor.toFixed(2)}`);
      }
    }
  }
  lines.push("");

  lines.push("--- TICKER/TIMEFRAME FIT ---");
  for (const combo of report.comboFit) {
    const ticker = combo.ticker.split("/")[0];
    lines.push(`${ticker} ${combo.timeframe} [${combo.rating.toUpperCase()}] — ${combo.count} configs, avg profit ${combo.avgProfit.toFixed(1)}%, WR ${combo.avgWinRate.toFixed(1)}%, DD ${combo.avgDrawdown.toFixed(1)}%, best leveraged: ${combo.bestLevProfit.toFixed(0)}% @${combo.bestLeverage}x`);
  }
  lines.push("");

  lines.push("--- DIRECTIONAL BIAS ---");
  const db = report.directionalBias;
  lines.push(`Long trades: ${db.longCount} total, ${db.longWinRate.toFixed(1)}% win rate, avg PnL ${db.longAvgPnl.toFixed(2)}%`);
  lines.push(`Short trades: ${db.shortCount} total, ${db.shortWinRate.toFixed(1)}% win rate, avg PnL ${db.shortAvgPnl.toFixed(2)}%`);
  lines.push(`Bias: ${db.bias} (strength: ${db.biasStrength.toFixed(1)})`);
  lines.push("");

  lines.push("--- TRADE PATTERNS ---");
  const tp = report.tradePatterns;
  lines.push(`Avg bars held — winners: ${tp.avgBarsWinners.toFixed(1)}, losers: ${tp.avgBarsLosers.toFixed(1)} (ratio: ${tp.barsRatio.toFixed(1)}x)`);
  lines.push(`Avg win: +${tp.avgWinSize.toFixed(2)}%, avg loss: -${tp.avgLossSize.toFixed(2)}% (reward/risk: ${tp.winLossRatio.toFixed(1)}:1)`);
  lines.push(`Exit reasons:`);
  for (const er of tp.exitReasons) {
    lines.push(`  ${er.reason}: ${er.count} trades (${er.percent.toFixed(1)}%), WR ${er.winRate.toFixed(1)}%, avg PnL ${er.avgPnl.toFixed(2)}%`);
  }
  lines.push("");

  lines.push("--- RECOMMENDATIONS ---");
  for (const s of report.suggestions) {
    const prefix = s.severity === "critical" ? "[!!!]" : s.severity === "warning" ? "[!!]" : "[i]";
    lines.push(`${prefix} [${s.category}] ${s.text}`);
  }
  lines.push("");

  if (pineScript) {
    lines.push("--- PINE SCRIPT ---");
    lines.push(pineScript);
    lines.push("");
  }

  lines.push("=== END REPORT ===");
  lines.push("");
  lines.push("Please analyze this backtest report and suggest specific improvements to the Pine Script strategy. Focus on:");
  lines.push("1. Parameter range adjustments based on the sensitivity analysis");
  lines.push("2. Entry/exit condition improvements based on trade patterns");
  lines.push("3. Any structural changes suggested by the directional bias or market fit data");

  return lines.join("\n");
}
