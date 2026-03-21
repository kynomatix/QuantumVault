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
