import { tokenize } from "./tokenizer";
import { parse, type Stmt } from "./parser";
import { executePine, createSharedArrays, type PineEngineConfig, type OHLCV, type PineSharedArrays } from "./runtime";
import type { LabBacktestResult } from "@shared/schema";

export type { OHLCV, PineEngineConfig } from "./runtime";
export type { PineSharedArrays } from "./runtime";
export { createSharedArrays } from "./runtime";

export interface PinePlan {
  ast: Stmt[];
  source: string;
}

export function compilePine(source: string): PinePlan {
  const tokens = tokenize(source);
  const ast = parse(tokens);
  return { ast, source };
}

export function runPineBacktest(
  plan: PinePlan,
  candles: OHLCV[],
  params: Record<string, any>,
  ticker: string,
  timeframe: string,
  config: PineEngineConfig,
  shared?: PineSharedArrays,
  sharedIndicatorCache?: Map<string, any>,
): LabBacktestResult {
  return executePine(plan.ast, candles, params, ticker, timeframe, config, shared, sharedIndicatorCache);
}

export interface ParityResult {
  match: boolean;
  compiledPath: "compiled" | "interpreter";
  interpreterMs: number;
  compiledMs: number;
  speedup: string;
  diffs: string[];
  compiled: { netProfitPercent: number; winRatePercent: number; maxDrawdownPercent: number; totalTrades: number; profitFactor: number };
  interpreted: { netProfitPercent: number; winRatePercent: number; maxDrawdownPercent: number; totalTrades: number; profitFactor: number };
}

export function runPineParityTest(
  plan: PinePlan,
  candles: OHLCV[],
  params: Record<string, any>,
  ticker: string,
  timeframe: string,
  config: PineEngineConfig,
): ParityResult {
  const t0 = performance.now();
  const interpreted = executePine(plan.ast, candles, params, ticker, timeframe, config, undefined, undefined, true);
  const interpreterMs = performance.now() - t0;

  const t1 = performance.now();
  const compiled = executePine(plan.ast, candles, params, ticker, timeframe, config);
  const compiledMs = performance.now() - t1;

  const compiledUsedCompiler = (compiled as any).compiledPath === "compiled";

  const diffs: string[] = [];
  const tol = 0.01;

  if (compiled.totalTrades !== interpreted.totalTrades) {
    diffs.push(`totalTrades: compiled=${compiled.totalTrades} vs interpreted=${interpreted.totalTrades}`);
  }
  if (Math.abs(compiled.netProfitPercent - interpreted.netProfitPercent) > tol) {
    diffs.push(`netProfitPercent: compiled=${compiled.netProfitPercent} vs interpreted=${interpreted.netProfitPercent}`);
  }
  if (Math.abs(compiled.maxDrawdownPercent - interpreted.maxDrawdownPercent) > tol) {
    diffs.push(`maxDrawdownPercent: compiled=${compiled.maxDrawdownPercent} vs interpreted=${interpreted.maxDrawdownPercent}`);
  }
  if (Math.abs(compiled.winRatePercent - interpreted.winRatePercent) > tol) {
    diffs.push(`winRatePercent: compiled=${compiled.winRatePercent} vs interpreted=${interpreted.winRatePercent}`);
  }
  if (Math.abs(compiled.profitFactor - interpreted.profitFactor) > tol) {
    diffs.push(`profitFactor: compiled=${compiled.profitFactor} vs interpreted=${interpreted.profitFactor}`);
  }

  if (compiled.totalTrades === interpreted.totalTrades && compiled.trades && interpreted.trades) {
    for (let i = 0; i < Math.min(compiled.trades.length, interpreted.trades.length, 5); i++) {
      const ct = compiled.trades[i];
      const it = interpreted.trades[i];
      if (ct.direction !== it.direction || Math.abs((ct.pnlPercent ?? 0) - (it.pnlPercent ?? 0)) > 0.01) {
        diffs.push(`trade[${i}]: compiled=${ct.direction}/${ct.pnlPercent}% vs interpreted=${it.direction}/${it.pnlPercent}%`);
      }
    }
  }

  return {
    match: diffs.length === 0,
    compiledPath: compiledUsedCompiler ? "compiled" : "interpreter",
    interpreterMs: Math.round(interpreterMs * 100) / 100,
    compiledMs: Math.round(compiledMs * 100) / 100,
    speedup: interpreterMs > 0 ? `${(interpreterMs / compiledMs).toFixed(2)}x` : "N/A",
    diffs,
    compiled: {
      netProfitPercent: compiled.netProfitPercent,
      winRatePercent: compiled.winRatePercent,
      maxDrawdownPercent: compiled.maxDrawdownPercent,
      totalTrades: compiled.totalTrades,
      profitFactor: compiled.profitFactor,
    },
    interpreted: {
      netProfitPercent: interpreted.netProfitPercent,
      winRatePercent: interpreted.winRatePercent,
      maxDrawdownPercent: interpreted.maxDrawdownPercent,
      totalTrades: interpreted.totalTrades,
      profitFactor: interpreted.profitFactor,
    },
  };
}
