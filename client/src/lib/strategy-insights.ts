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

export interface ParamCorrelation {
  params: Record<string, any>;
  ticker: string;
  timeframe: string;
  netProfitPercent: number;
  winRatePercent: number;
  maxDrawdownPercent: number;
  profitFactor: number;
  totalTrades: number;
  maxSafeLeverage: number;
  leveragedProfit: number;
}

export interface TopBottomConfigs {
  top: ParamCorrelation[];
  bottom: ParamCorrelation[];
}

export interface ParamComboCorrelation {
  paramKey: string;
  paramValues: Record<string, any>;
  count: number;
  avgProfit: number;
  avgWinRate: number;
  avgDrawdown: number;
  avgProfitFactor: number;
}

export interface ParamCorrelations {
  bestCombos: ParamComboCorrelation[];
  worstCombos: ParamComboCorrelation[];
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
  filter?: { ticker?: string; timeframe?: string } | null;
  paramSensitivity: ParamSensitivity[];
  comboFit: ComboFit[];
  directionalBias: DirectionalBias;
  tradePatterns: TradePatterns;
  suggestions: Suggestion[];
  topBottomConfigs: TopBottomConfigs;
  paramCorrelations: ParamCorrelations;
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

function analyzeTopBottomConfigs(results: ResultData[]): TopBottomConfigs {
  const scored = results
    .filter(r => r.totalTrades >= 5)
    .map(r => {
      const lev = computeMaxSafeLeverage(r.maxDrawdownPercent);
      return {
        params: r.params,
        ticker: r.ticker,
        timeframe: r.timeframe,
        netProfitPercent: r.netProfitPercent,
        winRatePercent: r.winRatePercent,
        maxDrawdownPercent: r.maxDrawdownPercent,
        profitFactor: r.profitFactor,
        totalTrades: r.totalTrades,
        maxSafeLeverage: lev,
        leveragedProfit: r.netProfitPercent * lev,
      };
    });

  const byProfit = [...scored].sort((a, b) => b.netProfitPercent - a.netProfitPercent);
  const top = byProfit.slice(0, 10);
  const topIds = new Set(top.map((_, i) => i));
  const bottomCandidates = byProfit.slice().reverse().filter((_, i) => !topIds.has(byProfit.length - 1 - i));
  return {
    top,
    bottom: bottomCandidates.slice(0, 5),
  };
}

function analyzeParamCorrelations(results: ResultData[], inputs: LabPineInput[]): ParamCorrelations {
  const optimizable = inputs.filter(i => i.optimizable && (i.type === "int" || i.type === "float"));
  if (optimizable.length < 2 || results.length < 10) {
    return { bestCombos: [], worstCombos: [] };
  }

  const paramNames = optimizable.map(i => i.name).slice(0, 4);

  const comboMap = new Map<string, { values: Record<string, any>; profits: number[]; winRates: number[]; drawdowns: number[]; profitFactors: number[] }>();

  for (const r of results) {
    if (r.totalTrades < 5) continue;
    const comboValues: Record<string, any> = {};
    let skip = false;
    for (const name of paramNames) {
      const v = r.params[name];
      if (v === undefined || v === null) { skip = true; break; }
      comboValues[name] = v;
    }
    if (skip) continue;
    const key = paramNames.map(n => `${n}=${comboValues[n]}`).join("|");
    let entry = comboMap.get(key);
    if (!entry) {
      entry = { values: comboValues, profits: [], winRates: [], drawdowns: [], profitFactors: [] };
      comboMap.set(key, entry);
    }
    entry.profits.push(r.netProfitPercent);
    entry.winRates.push(r.winRatePercent);
    entry.drawdowns.push(r.maxDrawdownPercent);
    entry.profitFactors.push(r.profitFactor);
  }

  const combos: ParamComboCorrelation[] = [];
  for (const [key, entry] of comboMap) {
    if (entry.profits.length < 1) continue;
    combos.push({
      paramKey: key,
      paramValues: entry.values,
      count: entry.profits.length,
      avgProfit: avg(entry.profits),
      avgWinRate: avg(entry.winRates),
      avgDrawdown: avg(entry.drawdowns),
      avgProfitFactor: avg(entry.profitFactors),
    });
  }

  const sorted = combos.sort((a, b) => b.avgProfit - a.avgProfit);
  return {
    bestCombos: sorted.slice(0, 10),
    worstCombos: sorted.slice(-10).reverse(),
  };
}

export function generateInsightsReport(
  results: ResultData[],
  inputs: LabPineInput[],
  strategyName: string,
  totalRuns: number,
  filter?: { ticker?: string; timeframe?: string } | null,
): StrategyInsightsReport {
  let filtered = results;
  if (filter?.ticker) filtered = filtered.filter(r => r.ticker === filter.ticker);
  if (filter?.timeframe) filtered = filtered.filter(r => r.timeframe === filter.timeframe);

  const sanitized = filtered.map(r => ({
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
  const topBottomConfigs = analyzeTopBottomConfigs(sanitized);
  const paramCorrelations = analyzeParamCorrelations(sanitized, inputs);
  const suggestions = generateSuggestions(paramSensitivity, comboFit, directionalBias, tradePatterns);

  return {
    strategyName,
    totalResults: filtered.length,
    totalRuns,
    totalTrades,
    filter: filter || null,
    paramSensitivity,
    comboFit,
    directionalBias,
    tradePatterns,
    suggestions,
    topBottomConfigs,
    paramCorrelations,
  };
}

export function formatReportAsText(report: StrategyInsightsReport, pineScript?: string): string {
  const lines: string[] = [];

  lines.push("=== STRATEGY INSIGHTS REPORT ===");
  lines.push(`Strategy: ${report.strategyName}`);
  if (report.filter?.ticker || report.filter?.timeframe) {
    const parts: string[] = [];
    if (report.filter.ticker) parts.push(report.filter.ticker);
    if (report.filter.timeframe) parts.push(report.filter.timeframe);
    lines.push(`Filter: ${parts.join(" ")}`);
  }
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

  lines.push("--- TOP 10 BEST CONFIGURATIONS ---");
  if (report.topBottomConfigs.top.length === 0) {
    lines.push("Not enough data (need configs with 5+ trades).");
  } else {
    for (let i = 0; i < report.topBottomConfigs.top.length; i++) {
      const c = report.topBottomConfigs.top[i];
      const ticker = c.ticker.split("/")[0];
      lines.push(`\n#${i + 1}: ${ticker} ${c.timeframe} — profit ${c.netProfitPercent.toFixed(1)}%, WR ${c.winRatePercent.toFixed(1)}%, DD ${c.maxDrawdownPercent.toFixed(1)}%, PF ${c.profitFactor.toFixed(2)}, ${c.totalTrades} trades, safe leverage ${c.maxSafeLeverage}x (${c.leveragedProfit.toFixed(0)}% leveraged)`);
      lines.push(`  Params: ${Object.entries(c.params).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
  }
  lines.push("");

  lines.push("--- TOP 5 WORST CONFIGURATIONS (for contrast) ---");
  if (report.topBottomConfigs.bottom.length === 0) {
    lines.push("Not enough data.");
  } else {
    for (let i = 0; i < report.topBottomConfigs.bottom.length; i++) {
      const c = report.topBottomConfigs.bottom[i];
      const ticker = c.ticker.split("/")[0];
      lines.push(`\n#${i + 1}: ${ticker} ${c.timeframe} — profit ${c.netProfitPercent.toFixed(1)}%, WR ${c.winRatePercent.toFixed(1)}%, DD ${c.maxDrawdownPercent.toFixed(1)}%, PF ${c.profitFactor.toFixed(2)}, ${c.totalTrades} trades`);
      lines.push(`  Params: ${Object.entries(c.params).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
  }
  lines.push("");

  lines.push("--- PARAMETER CORRELATIONS ---");
  lines.push("(Which parameter combos work together vs against each other)");
  if (report.paramCorrelations.bestCombos.length === 0) {
    lines.push("Not enough data (need 2+ optimizable params and 10+ results).");
  } else {
    lines.push("\nBest performing parameter combinations:");
    for (const c of report.paramCorrelations.bestCombos) {
      lines.push(`  ${Object.entries(c.paramValues).map(([k, v]) => `${k}=${v}`).join(", ")} — avg profit ${c.avgProfit.toFixed(1)}%, WR ${c.avgWinRate.toFixed(1)}%, DD ${c.avgDrawdown.toFixed(1)}%, PF ${c.avgProfitFactor.toFixed(2)} (${c.count} configs)`);
    }
    lines.push("\nWorst performing parameter combinations:");
    for (const c of report.paramCorrelations.worstCombos) {
      lines.push(`  ${Object.entries(c.paramValues).map(([k, v]) => `${k}=${v}`).join(", ")} — avg profit ${c.avgProfit.toFixed(1)}%, WR ${c.avgWinRate.toFixed(1)}%, DD ${c.avgDrawdown.toFixed(1)}%, PF ${c.avgProfitFactor.toFixed(2)} (${c.count} configs)`);
    }
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
  lines.push("Please analyze this backtest report and suggest specific improvements to the Pine Script strategy. You have full authority to rewrite the strategy entirely if you believe a different approach would yield better results. Focus on:");
  lines.push("1. Parameter defaults and ranges — use the top/bottom configs and correlations to set optimal defaults");
  lines.push("2. Entry/exit logic — modify or replace conditions based on trade patterns and directional bias");
  lines.push("3. Risk management — adjust stop loss, take profit, and position sizing based on the data");
  lines.push("4. Structural changes — add/remove indicators, change signal logic, or redesign the strategy if the data supports it");
  lines.push("5. Provide the complete updated Pine Script, not just snippets");

  return lines.join("\n");
}
