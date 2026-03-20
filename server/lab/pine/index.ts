import { tokenize } from "./tokenizer";
import { parse, type Stmt } from "./parser";
import { executePine, type PineEngineConfig, type OHLCV } from "./runtime";
import type { LabBacktestResult } from "@shared/schema";

export type { OHLCV, PineEngineConfig } from "./runtime";

export interface PinePlan {
  ast: Stmt[];
  source: string;
  _compiledCache?: {
    fn: Function;
    warmupCount: number;
  };
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
): LabBacktestResult {
  return executePine(plan.ast, candles, params, ticker, timeframe, config, plan);
}
