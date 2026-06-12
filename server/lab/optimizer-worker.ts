import { workerData, parentPort } from "worker_threads";
import { runBacktest, compilePine, createSharedArrays, type OHLCV, type PinePlan, type PineSharedArrays } from "./engine";
import type { LabPineInput, LabBacktestResult, LabJobProgress, LabCheckpoint, GuidedInsights } from "@shared/schema";
import { makeRng, hashStringToSeed, deriveComboSeed, deriveConfigSeed, deriveStageSeed, type SeededRng } from "./rng";
import { sharpeFromTrades, robustScore, oosBoundaryMs, computeWindowMetrics, robustnessRank } from "./metrics";
import { runPineParityTest } from "./pine/index";

// Module-level seeded RNG. Reseeded per (job, combo) inside run() so that
// optimizer behavior is fully reproducible from (jobSeed, combo) regardless
// of which pool worker processes the combo. All call sites that previously
// used rng.random() now use rng.random(). See .local/session_plan.md T001a.
let rng: SeededRng = makeRng(0xdeadbeef);

interface WorkerInput {
  jobId: string;
  config: {
    tickers: string[];
    timeframes: string[];
    randomSamples: number;
    topK: number;
    refinementsPerSeed: number;
    minTrades: number;
    maxDrawdownCap: number;
    minAvgBarsHeld: number;
    parsedInputs: LabPineInput[];
    processOrdersOnClose?: boolean;
    guidedInsights?: GuidedInsights;
    guidedInsightsPerCombo?: Record<string, GuidedInsights>;
    deepSearch?: boolean;
    coordinateTune?: boolean;
    pineScript?: string;
    strategyId?: number;
    engineType?: string;
    slippage?: number;
    // Validity (Task 188): fixed config date range + holdout fraction. Used to
    // derive an absolute, resume-stable IS/OOS boundary timestamp in the worker.
    startDate?: string;
    endDate?: string;
    outOfSampleFraction?: number;
  };
  candlesByCombo: Record<string, OHLCV[]>;
  resumeCheckpoint?: LabCheckpoint;
  // T001a/b: seeded PRNG + worker pool support.
  // randomSeed: master job seed. If omitted, derived from jobId hash.
  // comboFilter: optional set of "ticker|tf" keys this worker should process.
  //              When omitted, worker processes the full cartesian product
  //              (single-worker mode). Used by WorkerPool for round-robin
  //              combo partitioning so each pool member handles a disjoint
  //              subset, with deterministic per-combo seeding.
  randomSeed?: number;
  comboFilter?: string[];
  // T005: per-config partitioning within a combo.
  // When `slotsPerCombo` is provided, the random-search stage iterates ONLY
  // the listed slot indices for each combo (round-robin partition across the
  // pool). PRNG is reseeded per slot via deriveConfigSeed so the params for
  // slot K of combo C are independent of which worker processed them.
  //
  // `isLead` selects the worker that runs the merge + refinement / deep /
  // coordinate stages. Non-lead workers stream their per-slot random results
  // back to the lead via the pool. `peerCount` is how many peer workers the
  // lead must wait for before refinement.
  slotsPerCombo?: Record<string, number[]> | null;
  isLead?: boolean;
  peerCount?: number;
}

type PartialResult = LiteBacktestResult | LabBacktestResult;

type WorkerMessage =
  | { type: "progress"; data: LabJobProgress }
  | { type: "partial-checkpoint"; combo: string; stage: "random" | "refine" | "deep" | "coordinate"; iteration: number; deepRound?: number; results: PartialResult[]; refineSeeds?: Record<string, any>[]; coordinateCompleted?: string[] }
  | { type: "combo-complete"; combo: string; results: LabBacktestResult[]; disposition?: { status: "ok" | "no-trades" | "data-unavailable"; reason?: string } }
  | { type: "best-discovery"; combo: string; stage: "deep"; deepRound: number; score: number; params: Record<string, any> }
  | { type: "done"; results: LabBacktestResult[]; totalConfigsTested?: number; parityChecked?: boolean; parityMatch?: boolean; parityDiffs?: string[] }
  | { type: "error"; message: string; isResourceError?: boolean }
  // T005: per-slot peer<->lead random-search streaming.
  | { type: "slot-result"; combo: string; slot: number; result: LiteBacktestResult | null }
  | { type: "combo-random-done"; combo: string };

let lastSendTime = Date.now();
const HEARTBEAT_INTERVAL_MS = 30_000;

function send(msg: WorkerMessage) {
  lastSendTime = Date.now();
  parentPort?.postMessage(msg);
}

function sendHeartbeat(jobId: string, stage: string, globalCurrent: number, grandTotal: number, startTime: number, tickerProgress: Record<string, any>) {
  if (Date.now() - lastSendTime < HEARTBEAT_INTERVAL_MS) return;
  send({ type: "progress", data: {
    jobId, status: "random_search",
    stage,
    current: Math.min(globalCurrent, grandTotal), total: grandTotal,
    percent: Math.min(99, Math.round((globalCurrent / grandTotal) * 100)),
    elapsed: Date.now() - startTime,
    tickerProgress,
  }});
}

interface LiteBacktestResult {
  ticker: string;
  timeframe: string;
  netProfitPercent: number;
  winRatePercent: number;
  maxDrawdownPercent: number;
  profitFactor: number;
  totalTrades: number;
  params: Record<string, any>;
  avgBarsHeld: number;
  sharpeRatio?: number;
  compiledPath?: "compiled" | "interpreter";
}

function toLiteResult(r: LabBacktestResult | LiteBacktestResult | any): LiteBacktestResult {
  if ('avgBarsHeld' in r && !('trades' in r)) return r as LiteBacktestResult;
  const trades = Array.isArray(r.trades) ? r.trades : [];
  const avgBarsHeld = trades.length > 0
    ? trades.reduce((sum: number, t: any) => sum + (t.barsHeld ?? 0), 0) / trades.length
    : 0;
  return {
    ticker: r.ticker,
    timeframe: r.timeframe,
    netProfitPercent: r.netProfitPercent,
    winRatePercent: r.winRatePercent,
    maxDrawdownPercent: r.maxDrawdownPercent,
    profitFactor: r.profitFactor,
    totalTrades: r.totalTrades,
    params: r.params,
    avgBarsHeld,
    // Pine runtime does not compute Sharpe → fall back to the trade-level
    // formula so the risk-adjusted objective has a real value for Pine results
    // (native results already carry sharpeRatio; a real 0 is preserved by ??).
    sharpeRatio: r.sharpeRatio ?? sharpeFromTrades(r.trades),
    compiledPath: r.compiledPath,
  };
}

function scoreLite(r: LiteBacktestResult): number {
  return robustScore(r);
}

function meetsFiltersLite(r: LiteBacktestResult, config: WorkerInput["config"]): boolean {
  if (r.totalTrades < config.minTrades) return false;
  if (r.maxDrawdownPercent > config.maxDrawdownCap) return false;
  if (config.minAvgBarsHeld > 0 && r.totalTrades > 0) {
    if (r.avgBarsHeld < config.minAvgBarsHeld) return false;
  }
  return true;
}

function canonicalizeParams(params: Record<string, any>, inputs: LabPineInput[]): string {
  const parts: string[] = [];
  for (const input of inputs) {
    if (!input.optimizable) continue;
    const val = params[input.name];
    if (input.type === "float") {
      parts.push(`${input.name}=${Math.round((val ?? 0) * 10000)}`);
    } else {
      parts.push(`${input.name}=${val}`);
    }
  }
  return parts.join("|");
}

function normalizedParamDistance(a: Record<string, any>, b: Record<string, any>, inputs: LabPineInput[]): number {
  let sumSq = 0;
  let count = 0;
  for (const input of inputs) {
    if (!input.optimizable) continue;
    count++;
    switch (input.type) {
      case "int":
      case "float": {
        const min = input.min ?? 0;
        const max = input.max ?? 100;
        const range = max - min;
        if (range === 0) continue;
        const va = typeof a[input.name] === "number" ? a[input.name] : (input.default ?? min);
        const vb = typeof b[input.name] === "number" ? b[input.name] : (input.default ?? min);
        const diff = (va - vb) / range;
        sumSq += diff * diff;
        break;
      }
      case "bool": {
        const va = a[input.name] ?? input.default;
        const vb = b[input.name] ?? input.default;
        if (va !== vb) sumSq += 1;
        break;
      }
      case "string": {
        const va = a[input.name] ?? input.default;
        const vb = b[input.name] ?? input.default;
        if (va !== vb) sumSq += 1;
        break;
      }
    }
  }
  return count > 0 ? Math.sqrt(sumSq / count) : 0;
}

function selectDiverseSeeds<T extends { params: Record<string, any> }>(results: T[], count: number, inputs: LabPineInput[]): T[] {
  if (results.length <= count) return [...results];
  const selected: T[] = [results[0]];
  const remaining = new Set(results.slice(1).map((_, i) => i + 1));

  while (selected.length < count && remaining.size > 0) {
    let bestIdx = -1;
    let bestMinDist = -1;
    for (const idx of Array.from(remaining)) {
      let minDist = Infinity;
      for (const sel of selected) {
        const d = normalizedParamDistance(results[idx].params, sel.params, inputs);
        if (d < minDist) minDist = d;
      }
      if (minDist > bestMinDist) {
        bestMinDist = minDist;
        bestIdx = idx;
      }
    }
    if (bestIdx >= 0) {
      selected.push(results[bestIdx]);
      remaining.delete(bestIdx);
    } else {
      break;
    }
  }
  return selected;
}

function perturbNumericValue(
  currentVal: number,
  min: number,
  max: number,
  step: number,
  fraction: number,
  useGaussian: boolean = false
): number {
  const range = max - min;
  const stepsInRange = Math.floor(range / step);
  if (stepsInRange <= 0) return currentVal;

  const rawAmount = range * fraction;
  const minMovement = step;
  const effectiveAmount = Math.max(rawAmount, minMovement);

  let delta: number;
  if (useGaussian) {
    delta = gaussianRandom(0, effectiveAmount);
  } else {
    delta = (rng.random() - 0.5) * 2 * effectiveAmount;
  }

  if (Math.abs(delta) < step) {
    delta = delta >= 0 ? step : -step;
  }

  const newVal = currentVal + delta;
  const clamped = Math.max(min, Math.min(max, newVal));
  let snapped = Math.min(max, Math.max(min, Math.round((clamped - min) / step) * step + min));

  if (snapped === currentVal) {
    if (currentVal + step <= max) {
      snapped = currentVal + step;
    } else if (currentVal - step >= min) {
      snapped = currentVal - step;
    }
  }

  return snapped;
}

function generateRandomParams(inputs: LabPineInput[]): Record<string, any> {
  const params: Record<string, any> = {};
  for (const input of inputs) {
    if (!input.optimizable) {
      params[input.name] = input.default;
      continue;
    }
    switch (input.type) {
      case "int": {
        const min = input.min ?? 1;
        const max = input.max ?? 100;
        const step = input.step ?? 1;
        const range = Math.floor((max - min) / step);
        params[input.name] = min + Math.floor(rng.random() * (range + 1)) * step;
        break;
      }
      case "float": {
        const min = input.min ?? 0.1;
        const max = input.max ?? 10;
        const step = input.step ?? 0.1;
        const range = Math.floor((max - min) / step);
        const val = min + Math.floor(rng.random() * (range + 1)) * step;
        params[input.name] = Math.round(val * 10000) / 10000;
        break;
      }
      case "bool":
        params[input.name] = rng.random() > 0.5;
        break;
      case "string":
        if (input.options && input.options.length > 0) {
          params[input.name] = input.options[Math.floor(rng.random() * input.options.length)];
        } else {
          params[input.name] = input.default;
        }
        break;
      default:
        params[input.name] = input.default;
    }
  }
  return params;
}

function gaussianRandom(mean: number, stddev: number): number {
  const u1 = rng.random();
  const u2 = rng.random();
  const z = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) * Math.cos(2 * Math.PI * u2);
  return mean + z * stddev;
}

function generateGuidedParams(inputs: LabPineInput[], insights: GuidedInsights): Record<string, any> {
  if (insights.topConfigs && insights.topConfigs.length > 0) {
    return generatePerturbedParams(inputs, insights);
  }
  return generateBucketGuidedParams(inputs, insights);
}

function generatePerturbedParams(inputs: LabPineInput[], insights: GuidedInsights): Record<string, any> {
  const params: Record<string, any> = {};
  const topConfigs = insights.topConfigs!;
  const seed = topConfigs[Math.floor(rng.random() * topConfigs.length)].params;

  const sensitivityMap = new Map(insights.paramSensitivity.map(ps => [ps.name, ps]));
  const impactScores = insights.paramSensitivity.map(ps => ps.impactScore);
  const medianImpact = impactScores.length > 0
    ? [...impactScores].sort((a, b) => a - b)[Math.floor(impactScores.length / 2)]
    : 0;

  for (const input of inputs) {
    if (!input.optimizable) {
      params[input.name] = input.default;
      continue;
    }

    const seedVal = seed[input.name];
    const sensitivity = sensitivityMap.get(input.name);
    const impact = sensitivity?.impactScore ?? 0;

    let perturbFraction: number;
    if (impact > medianImpact * 1.5 && medianImpact > 0) {
      perturbFraction = 0.18;
    } else if (impact > medianImpact * 0.5 && medianImpact > 0) {
      perturbFraction = 0.25;
    } else {
      perturbFraction = 0.35;
    }

    switch (input.type) {
      case "int": {
        const min = input.min ?? 1;
        const max = input.max ?? 100;
        const step = input.step ?? 1;
        const seedNum = typeof seedVal === "number" ? seedVal : (input.default ?? min);
        params[input.name] = perturbNumericValue(seedNum, min, max, step, perturbFraction, true);
        break;
      }
      case "float": {
        const min = input.min ?? 0.1;
        const max = input.max ?? 10;
        const step = input.step ?? 0.1;
        const seedNum = typeof seedVal === "number" ? seedVal : (input.default ?? min);
        params[input.name] = Math.round(perturbNumericValue(seedNum, min, max, step, perturbFraction, true) * 10000) / 10000;
        break;
      }
      case "bool": {
        const seedBool = typeof seedVal === "boolean" ? seedVal : (input.default ?? false);
        params[input.name] = rng.random() < 0.65 ? seedBool : !seedBool;
        break;
      }
      case "string": {
        if (input.options && input.options.length > 1) {
          const seedStr = typeof seedVal === "string" ? seedVal : (input.default ?? input.options[0]);
          if (rng.random() < 0.65) {
            params[input.name] = seedStr;
          } else {
            const others = input.options.filter(o => o !== seedStr);
            params[input.name] = others.length > 0 ? others[Math.floor(rng.random() * others.length)] : seedStr;
          }
        } else {
          params[input.name] = input.options?.[0] ?? input.default;
        }
        break;
      }
      default:
        params[input.name] = input.default;
    }
  }
  return params;
}

function generateBucketGuidedParams(inputs: LabPineInput[], insights: GuidedInsights): Record<string, any> {
  const params: Record<string, any> = {};
  const sensitivityMap = new Map(insights.paramSensitivity.map(ps => [ps.name, ps]));
  const impactScores = insights.paramSensitivity.map(ps => ps.impactScore);
  const medianImpact = impactScores.length > 0
    ? [...impactScores].sort((a, b) => a - b)[Math.floor(impactScores.length / 2)]
    : 0;

  for (const input of inputs) {
    if (!input.optimizable) {
      params[input.name] = input.default;
      continue;
    }

    const sensitivity = sensitivityMap.get(input.name);
    if (!sensitivity || (sensitivity.bestBucket.rangeMin === 0 && sensitivity.bestBucket.rangeMax === 0)) {
      switch (input.type) {
        case "int": {
          const min = input.min ?? 1;
          const max = input.max ?? 100;
          const step = input.step ?? 1;
          const range = Math.floor((max - min) / step);
          params[input.name] = min + Math.floor(rng.random() * (range + 1)) * step;
          break;
        }
        case "float": {
          const min = input.min ?? 0.1;
          const max = input.max ?? 10;
          const step = input.step ?? 0.1;
          const range = Math.floor((max - min) / step);
          const val = min + Math.floor(rng.random() * (range + 1)) * step;
          params[input.name] = Math.round(val * 10000) / 10000;
          break;
        }
        case "bool":
          params[input.name] = rng.random() > 0.5;
          break;
        case "string":
          if (input.options && input.options.length > 0) {
            params[input.name] = input.options[Math.floor(rng.random() * input.options.length)];
          } else {
            params[input.name] = input.default;
          }
          break;
        default:
          params[input.name] = input.default;
      }
      continue;
    }

    const isHighImpact = sensitivity.impactScore >= medianImpact;
    const bestMin = sensitivity.bestBucket.rangeMin;
    const bestMax = sensitivity.bestBucket.rangeMax;

    switch (input.type) {
      case "int": {
        const globalMin = input.min ?? 1;
        const globalMax = input.max ?? 100;
        const step = input.step ?? 1;
        if (isHighImpact) {
          const narrowMin = Math.max(globalMin, Math.ceil(bestMin / step) * step);
          const narrowMax = Math.min(globalMax, Math.floor(bestMax / step) * step);
          if (narrowMin > narrowMax) {
            const range = Math.floor((globalMax - globalMin) / step);
            params[input.name] = globalMin + Math.floor(rng.random() * (range + 1)) * step;
          } else {
            const range = Math.floor((narrowMax - narrowMin) / step);
            params[input.name] = narrowMin + Math.floor(rng.random() * (range + 1)) * step;
          }
        } else {
          const range = Math.floor((globalMax - globalMin) / step);
          params[input.name] = globalMin + Math.floor(rng.random() * (range + 1)) * step;
        }
        break;
      }
      case "float": {
        const globalMin = input.min ?? 0.1;
        const globalMax = input.max ?? 10;
        const step = input.step ?? 0.1;
        if (isHighImpact) {
          const narrowMin = Math.max(globalMin, bestMin);
          const narrowMax = Math.min(globalMax, bestMax);
          if (narrowMin > narrowMax) {
            const range = Math.floor((globalMax - globalMin) / step);
            const val = globalMin + Math.floor(rng.random() * (range + 1)) * step;
            params[input.name] = Math.round(val * 10000) / 10000;
          } else {
            const fineStep = Math.max(step / 2, 0.001);
            const range = Math.floor((narrowMax - narrowMin) / fineStep);
            const val = narrowMin + Math.floor(rng.random() * Math.max(1, range + 1)) * fineStep;
            params[input.name] = Math.round(Math.min(narrowMax, val) * 10000) / 10000;
          }
        } else {
          const range = Math.floor((globalMax - globalMin) / step);
          const val = globalMin + Math.floor(rng.random() * (range + 1)) * step;
          params[input.name] = Math.round(val * 10000) / 10000;
        }
        break;
      }
      case "bool":
        params[input.name] = rng.random() > 0.5;
        break;
      case "string":
        if (input.options && input.options.length > 0) {
          params[input.name] = input.options[Math.floor(rng.random() * input.options.length)];
        } else {
          params[input.name] = input.default;
        }
        break;
      default:
        params[input.name] = input.default;
    }
  }
  return params;
}

function jitterParams(baseParams: Record<string, any>, inputs: LabPineInput[], jitterCount: number = 4, jitterRadius: number = 0.15): Record<string, any> {
  const params = { ...baseParams };
  const optimizable = inputs.filter(i => i.optimizable && (i.type === "int" || i.type === "float"));
  const toJitter = optimizable.sort(() => rng.random() - 0.5).slice(0, jitterCount);

  for (const input of toJitter) {
    const min = input.min ?? 0;
    const max = input.max ?? 100;
    const step = input.type === "int" ? (input.step ?? 1) : (input.step ?? 0.1);
    const currentVal = params[input.name] ?? input.default;
    const newVal = perturbNumericValue(currentVal, min, max, step, jitterRadius);

    if (input.type === "float") {
      params[input.name] = Math.round(newVal * 10000) / 10000;
    } else {
      params[input.name] = newVal;
    }
  }

  const boolInputs = inputs.filter(i => i.optimizable && i.type === "bool");
  if (boolInputs.length > 0 && rng.random() < 0.35) {
    const toBool = boolInputs[Math.floor(rng.random() * boolInputs.length)];
    params[toBool.name] = !params[toBool.name];
  }

  const stringInputs = inputs.filter(i => i.optimizable && i.type === "string" && i.options && i.options.length > 1);
  if (stringInputs.length > 0 && rng.random() < 0.35) {
    const toStr = stringInputs[Math.floor(rng.random() * stringInputs.length)];
    const currentStr = params[toStr.name];
    const others = toStr.options!.filter(o => o !== currentStr);
    if (others.length > 0) {
      params[toStr.name] = others[Math.floor(rng.random() * others.length)];
    }
  }

  return params;
}

function meetsFilters(result: LabBacktestResult, config: WorkerInput["config"]): boolean {
  if (result.totalTrades < config.minTrades) return false;
  if (result.maxDrawdownPercent > config.maxDrawdownCap) return false;
  if (config.minAvgBarsHeld > 0 && result.trades.length > 0) {
    const avgBars = result.trades.reduce((sum, t) => sum + (t.barsHeld ?? 0), 0) / result.trades.length;
    if (avgBars < config.minAvgBarsHeld) return false;
  }
  return true;
}

function estimateEta(startTime: number, current: number, total: number): number {
  if (current === 0) return 0;
  const elapsed = Date.now() - startTime;
  const rate = current / elapsed;
  return Math.round((total - current) / rate);
}

interface CoordinateTuneContext {
  jobId: string;
  candles: OHLCV[];
  ticker: string;
  timeframe: string;
  inputs: LabPineInput[];
  config: WorkerInput["config"];
  engineConfig: { initialCapital: number; commission: number; positionSize: number; processOrdersOnClose?: boolean; strategyId?: number; slippage?: number };
  seedResult: LiteBacktestResult;
  seedScore: number;
  testedSignatures: Set<string>;
  startTime: number;
  comboKey: string;
  tickerProgress: Record<string, { status: "pending" | "running" | "complete"; best?: number }>;
  completedParams: string[];
  resumePartialResults?: LiteBacktestResult[];
  sharedArrays?: PineSharedArrays;
  sharedIndicatorCache?: Map<string, any>;
}

function generateParamGrid(input: LabPineInput, currentVal: any): any[] {
  switch (input.type) {
    case "int": {
      const min = input.min ?? 1;
      const max = input.max ?? 100;
      const step = input.step ?? 1;
      const totalSteps = Math.floor((max - min) / step);
      const values = new Set<number>();
      values.add(currentVal);

      if (totalSteps <= 30) {
        for (let v = min; v <= max; v += step) {
          values.add(v);
        }
      } else {
        const range = max - min;
        const nearRadius = range * 0.15;
        const nearMin = Math.max(min, currentVal - nearRadius);
        const nearMax = Math.min(max, currentVal + nearRadius);
        const nearStep = step;
        for (let v = nearMin; v <= nearMax; v += nearStep) {
          const snapped = Math.max(min, Math.min(max, Math.round((v - min) / step) * step + min));
          values.add(snapped);
        }

        const coarseStep = Math.max(step, Math.ceil((range / 15) / step) * step);
        for (let v = min; v <= max; v += coarseStep) {
          values.add(v);
        }
        values.add(max);
      }

      return Array.from(values).sort((a, b) => a - b);
    }
    case "float": {
      const min = input.min ?? 0.1;
      const max = input.max ?? 10;
      const step = input.step ?? 0.1;
      const totalSteps = Math.floor((max - min) / step);
      const values = new Set<number>();
      values.add(Math.round(currentVal * 10000) / 10000);

      if (totalSteps <= 30) {
        for (let v = min; v <= max + step * 0.01; v += step) {
          values.add(Math.round(Math.min(max, v) * 10000) / 10000);
        }
      } else {
        const range = max - min;
        const nearRadius = range * 0.15;
        const nearMin = Math.max(min, currentVal - nearRadius);
        const nearMax = Math.min(max, currentVal + nearRadius);
        for (let v = nearMin; v <= nearMax + step * 0.01; v += step) {
          const snapped = Math.round(Math.min(max, Math.max(min, v)) * 10000) / 10000;
          values.add(snapped);
        }

        const coarseStep = Math.max(step, Math.ceil((range / 15) / step) * step);
        for (let v = min; v <= max + coarseStep * 0.01; v += coarseStep) {
          values.add(Math.round(Math.min(max, v) * 10000) / 10000);
        }
        values.add(Math.round(max * 10000) / 10000);
      }

      return Array.from(values).sort((a, b) => a - b);
    }
    case "bool":
      return [true, false];
    case "string":
      if (input.options && input.options.length > 0) {
        return [...input.options];
      }
      return [currentVal];
    default:
      return [currentVal];
  }
}

function coordinateTune(ctx: CoordinateTuneContext): { results: LiteBacktestResult[]; totalTests: number } {
  const {
    jobId, candles, ticker, timeframe, inputs, config, engineConfig,
    seedResult, testedSignatures, startTime, comboKey, tickerProgress, completedParams,
    sharedArrays, sharedIndicatorCache,
  } = ctx;
  let bestScore = ctx.seedScore;
  let bestResult = seedResult;
  const allResults: LiteBacktestResult[] = [seedResult];
  if (ctx.resumePartialResults && ctx.resumePartialResults.length > 0) {
    for (const pr of ctx.resumePartialResults) {
      const sig = canonicalizeParams(pr.params, inputs);
      if (!testedSignatures.has(sig)) {
        testedSignatures.add(sig);
      }
      allResults.push(pr);
      const prScore = scoreLite(pr);
      if (prScore > bestScore) {
        bestScore = prScore;
        bestResult = pr;
      }
    }
  }
  const completedParamSet = new Set(completedParams);

  const optimizable = inputs.filter(i => i.optimizable);
  const paramImpact: { name: string; improvement: number }[] = [];

  const totalGridSizes: number[] = optimizable
    .filter(i => !completedParamSet.has(i.name))
    .map(i => generateParamGrid(i, seedResult.params[i.name]).length);
  const totalSingleTests = totalGridSizes.reduce((a, b) => a + b, 0);

  const pairGridEstimate = Math.min(3, optimizable.length) * 15 * 15;
  const grandTotal = totalSingleTests + pairGridEstimate;
  let currentTest = 0;

  for (const input of optimizable) {
    if (aborted) break;
    if (completedParamSet.has(input.name)) {
      const grid = generateParamGrid(input, seedResult.params[input.name]);
      currentTest += grid.length;
      continue;
    }

    const grid = generateParamGrid(input, bestResult.params[input.name]);
    let paramBestScore = bestScore;
    let paramBestResult = bestResult;
    const paramStartScore = bestScore;

    for (let gi = 0; gi < grid.length; gi++) {
      if (aborted) break;
      const val = grid[gi];
      const testParams = { ...bestResult.params, [input.name]: val };
      const sig = canonicalizeParams(testParams, inputs);
      currentTest++;

      if (testedSignatures.has(sig)) continue;
      testedSignatures.add(sig);

      const result = runBacktest(candles, testParams, ticker, timeframe, engineConfig, sharedArrays, sharedIndicatorCache);
      const lite = toLiteResult(result);
      if (!meetsFiltersLite(lite, config)) continue;

      const score = scoreLite(lite);
      allResults.push(lite);
      if (score > paramBestScore) {
        paramBestScore = score;
        paramBestResult = lite;
      }
      sendHeartbeat(jobId, `Coordinate Tune — ${input.name} — ${ticker.split("/")[0]} ${timeframe}`, currentTest, grandTotal, startTime, tickerProgress);
    }

    const improvement = paramBestScore - paramStartScore;
    paramImpact.push({ name: input.name, improvement });

    if (paramBestScore > bestScore) {
      bestScore = paramBestScore;
      bestResult = paramBestResult;
    }

    completedParamSet.add(input.name);

    const best = allResults.sort((a, b) => scoreLite(b) - scoreLite(a))[0];
    send({ type: "progress", data: {
      jobId, status: "refinement",
      stage: `Coordinate Tune — ${input.name} — ${ticker.split("/")[0]} ${timeframe} — best Δ${improvement > 0 ? "+" : ""}${improvement.toFixed(1)}`,
      current: Math.min(currentTest, grandTotal), total: grandTotal,
      percent: Math.min(99, Math.round((currentTest / grandTotal) * 100)),
      elapsed: Date.now() - startTime,
      bestSoFar: best ? {
        netProfitPercent: best.netProfitPercent, winRatePercent: best.winRatePercent,
        maxDrawdownPercent: best.maxDrawdownPercent, profitFactor: best.profitFactor, sharpeRatio: best.sharpeRatio,
      } : undefined,
      tickerProgress,
      eta: estimateEta(startTime, currentTest, grandTotal),
    }});

    const coordKeep = isLowTimeframe(timeframe) ? 5 : 10;
    const topPartial = [...allResults].sort((a, b) => scoreLite(b) - scoreLite(a)).slice(0, coordKeep);
    send({ type: "partial-checkpoint", combo: comboKey, stage: "coordinate", iteration: currentTest, results: topPartial, coordinateCompleted: Array.from(completedParamSet) });
  }

  if (!aborted) {
    paramImpact.sort((a, b) => b.improvement - a.improvement);
    const topPairParams = paramImpact
      .filter(p => {
        const inp = inputs.find(i => i.name === p.name);
        return inp && inp.optimizable && (inp.type === "int" || inp.type === "float");
      })
      .slice(0, 3);

    if (topPairParams.length >= 2) {
      for (let i = 0; i < topPairParams.length - 1 && !aborted; i++) {
        for (let j = i + 1; j < topPairParams.length && !aborted; j++) {
          const inputA = inputs.find(inp => inp.name === topPairParams[i].name)!;
          const inputB = inputs.find(inp => inp.name === topPairParams[j].name)!;

          const gridA = generateParamGrid(inputA, bestResult.params[inputA.name]);
          const gridB = generateParamGrid(inputB, bestResult.params[inputB.name]);

          const limitA = gridA.length > 15 ? evenSample(gridA, 15, bestResult.params[inputA.name]) : gridA;
          const limitB = gridB.length > 15 ? evenSample(gridB, 15, bestResult.params[inputB.name]) : gridB;

          for (const valA of limitA) {
            if (aborted) break;
            for (const valB of limitB) {
              if (aborted) break;
              const testParams = { ...bestResult.params, [inputA.name]: valA, [inputB.name]: valB };
              const sig = canonicalizeParams(testParams, inputs);
              currentTest++;

              if (testedSignatures.has(sig)) continue;
              testedSignatures.add(sig);

              const result = runBacktest(candles, testParams, ticker, timeframe, engineConfig, sharedArrays, sharedIndicatorCache);
              const lite = toLiteResult(result);
              if (!meetsFiltersLite(lite, config)) continue;

              const score = scoreLite(lite);
              allResults.push(lite);
              if (score > bestScore) {
                bestScore = score;
                bestResult = lite;
              }
              sendHeartbeat(jobId, `Pair Tune — ${inputA.name} × ${inputB.name} — ${ticker.split("/")[0]} ${timeframe}`, currentTest, grandTotal, startTime, tickerProgress);
            }
          }

          const best = allResults.sort((a, b) => scoreLite(b) - scoreLite(a))[0];
          send({ type: "progress", data: {
            jobId, status: "refinement",
            stage: `Pair Tune — ${inputA.name} × ${inputB.name} — ${ticker.split("/")[0]} ${timeframe}`,
            current: Math.min(currentTest, grandTotal), total: grandTotal,
            percent: Math.min(99, Math.round((currentTest / grandTotal) * 100)),
            elapsed: Date.now() - startTime,
            bestSoFar: best ? {
              netProfitPercent: best.netProfitPercent, winRatePercent: best.winRatePercent,
              maxDrawdownPercent: best.maxDrawdownPercent, profitFactor: best.profitFactor, sharpeRatio: best.sharpeRatio,
            } : undefined,
            tickerProgress,
            eta: estimateEta(startTime, currentTest, grandTotal),
          }});

          const coordKeep2 = isLowTimeframe(timeframe) ? 5 : 10;
          const topPartial = [...allResults].sort((a, b) => scoreLite(b) - scoreLite(a)).slice(0, coordKeep2);
          send({ type: "partial-checkpoint", combo: comboKey, stage: "coordinate", iteration: currentTest, results: topPartial, coordinateCompleted: Array.from(completedParamSet) });
        }
      }
    }
  }

  return { results: allResults, totalTests: currentTest };
}

function evenSample<T>(arr: T[], count: number, preferVal?: T): T[] {
  if (arr.length <= count) return arr;
  const result: T[] = [];
  const step = (arr.length - 1) / (count - 1);
  for (let i = 0; i < count; i++) {
    result.push(arr[Math.round(i * step)]);
  }
  if (preferVal !== undefined) {
    const idx = arr.indexOf(preferVal);
    if (idx >= 0 && !result.includes(preferVal)) {
      result[Math.floor(count / 2)] = preferVal;
    }
  }
  return result;
}

const LOW_TF_MINUTES = new Set([1, 3, 5, 15, 30]);
function isLowTimeframe(tf: string): boolean {
  const match = tf.match(/^(\d+)(m|h|d)?$/i);
  if (!match) return false;
  const val = parseInt(match[1], 10);
  const unit = (match[2] || "m").toLowerCase();
  if (unit === "h" || unit === "d") return false;
  return LOW_TF_MINUTES.has(val);
}

const MAX_TRADES_LOW_TF = 200;
const MAX_EQUITY_POINTS_LOW_TF = 500;
const MAX_TRADES_HIGH_TF = 500;
const MAX_EQUITY_POINTS_HIGH_TF = 1000;

function trimResult(r: LabBacktestResult): LabBacktestResult {
  const lowTf = isLowTimeframe(r.timeframe);
  const maxTrades = lowTf ? MAX_TRADES_LOW_TF : MAX_TRADES_HIGH_TF;
  const maxEquity = lowTf ? MAX_EQUITY_POINTS_LOW_TF : MAX_EQUITY_POINTS_HIGH_TF;

  let trades = r.trades;
  if (trades.length > maxTrades) {
    trades = trades.slice(-maxTrades);
  }

  let equityCurve = r.equityCurve;
  if (equityCurve.length > maxEquity) {
    const keepLast = maxEquity - 1;
    const step = (equityCurve.length - 1) / keepLast;
    const sampled: typeof equityCurve = [];
    for (let i = 0; i < keepLast; i++) {
      sampled.push(equityCurve[Math.round(i * step)]);
    }
    sampled.push(equityCurve[equityCurve.length - 1]);
    equityCurve = sampled;
  }

  return { ...r, trades, equityCurve };
}

// Validity (Task 188): attach IS/OOS window metrics to a FINALIZED full-window
// result by partitioning its own trades (no engine re-run). No-op when the
// holdout is inactive for this combo (full-window only) or the result has no
// trades → legacy/short-window combos keep clean primary-only rows. Mutates +
// returns the same object (called right after trimResult).
function attachWindowMetrics(
  result: LabBacktestResult,
  oosBoundary: number | null,
  useSplit: boolean,
  initialCapital: number,
): LabBacktestResult {
  if (!useSplit || oosBoundary == null || !result.trades || result.trades.length === 0) return result;
  const { is, oos } = computeWindowMetrics(result.trades, oosBoundary, initialCapital);
  result.is = is;
  result.oos = oos;
  return result;
}

let aborted = false;

// T005: lead-worker state for receiving peer per-slot results during the
// per-config partitioned random stage. Populated by the parentPort message
// handler; drained in run() between random and refinement for each combo.
const peerSlotResults = new Map<string, Array<LiteBacktestResult | null>>();
const peerComboRandomDoneCount = new Map<string, number>();
const peerComboRandomDoneResolvers = new Map<string, () => void>();
let peerExpectedCount = 0;

function notePeerCombo(combo: string): void {
  const cur = (peerComboRandomDoneCount.get(combo) ?? 0) + 1;
  peerComboRandomDoneCount.set(combo, cur);
  if (cur >= peerExpectedCount) {
    const r = peerComboRandomDoneResolvers.get(combo);
    if (r) { peerComboRandomDoneResolvers.delete(combo); r(); }
  }
}

parentPort?.on("message", (msg: any) => {
  if (!msg) return;
  if (msg.type === "abort") {
    aborted = true;
    // Unblock any pending peer waits so the worker can exit promptly.
    for (const [, r] of peerComboRandomDoneResolvers) r();
    peerComboRandomDoneResolvers.clear();
    return;
  }
  if (msg.type === "peer-slot-result") {
    let arr = peerSlotResults.get(msg.combo);
    if (!arr) { arr = []; peerSlotResults.set(msg.combo, arr); }
    arr.push(msg.result ?? null);
    return;
  }
  if (msg.type === "peer-combo-random-done") {
    notePeerCombo(msg.combo);
    return;
  }
});

async function run() {
  const { jobId, config, candlesByCombo, resumeCheckpoint, randomSeed, comboFilter, slotsPerCombo, isLead: isLeadInput, peerCount } = workerData as WorkerInput;
  const masterSeed = (typeof randomSeed === "number" ? randomSeed : hashStringToSeed(jobId)) >>> 0;
  const isLead = isLeadInput !== false; // defaults to true for single-worker / per-combo modes
  peerExpectedCount = peerCount ?? 0;
  const slotsPerComboMap: Record<string, number[]> | null = slotsPerCombo ?? null;
  // Set a default RNG state from the master seed; will be re-seeded per combo
  // below so the random search for any given (jobSeed, combo) is reproducible
  // regardless of which pool worker owns it.
  rng = makeRng(masterSeed);
  const comboFilterSet = comboFilter && comboFilter.length > 0 ? new Set(comboFilter) : null;
  const startTime = Date.now();
  const allResults: LabBacktestResult[] = [];
  let coordinateTotalTests = 0;
  const inputs = config.parsedInputs;

  // Validity (Task 188): absolute IS/OOS boundary timestamp (ms), derived ONCE
  // from the fixed config date range. Identical for every combo; null disables
  // the holdout (legacy runs / holdout off → full-window everywhere). Derived
  // from fixed config (not candle count) so a resumed run picks the same split.
  const oosBoundary = oosBoundaryMs(config.startDate, config.endDate, config.outOfSampleFraction);

  let pinePlan: PinePlan | undefined;
  if (config.pineScript) {
    try {
      pinePlan = compilePine(config.pineScript);
    } catch (e: any) {
      send({ type: "error", message: `PineScript compilation failed: ${e.message}` });
      return;
    }
  }

  // Fidelity (Task 188): engine self-consistency (compiled vs interpreter),
  // checked once per traded Pine combo during finalize and aggregated to the
  // run. Native engines (sbr/ar38) have no compiled/interpreter split → never
  // checked, so parityChecked stays false and the run records NULL parity
  // (an honest "not applicable", never a false "passed").
  let parityChecked = false;
  let parityMatch = true;
  const parityDiffs: string[] = [];

  const combos: { ticker: string; timeframe: string }[] = [];
  for (const ticker of config.tickers) {
    for (const tf of config.timeframes) {
      const key = `${ticker}|${tf}`;
      if (comboFilterSet && !comboFilterSet.has(key)) continue;
      combos.push({ ticker, timeframe: tf });
    }
  }

  const completedCombos = new Set<string>(resumeCheckpoint?.completedCombos ?? []);
  const resumeCombo = resumeCheckpoint?.currentCombo ?? null;
  const resumeStage = resumeCheckpoint?.currentStage ?? null;
  const resumeIteration = resumeCheckpoint?.currentIteration ?? 0;
  const resumeDeepRound = resumeCheckpoint?.currentDeepRound ?? 0;
  const resumePartialResults = resumeCheckpoint?.partialResults ?? [];
  const resumeRefineSeeds = resumeCheckpoint?.refineSeeds ?? null;

  const tickerProgress: Record<string, { status: "pending" | "running" | "complete"; best?: number }> = {};
  for (const combo of combos) {
    const key = `${combo.ticker}|${combo.timeframe}`;
    tickerProgress[key] = completedCombos.has(key) ? { status: "complete" } : { status: "pending" };
  }

  const deepRounds = config.deepSearch ? 3 : 0;
  const deepSeedsPerRound = config.topK;
  const deepRefinesPerSeed = config.refinementsPerSeed;
  const deepSamplesTotal = deepRounds * deepSeedsPerRound * deepRefinesPerSeed;
  const totalSamples = config.randomSamples + config.topK * config.refinementsPerSeed + deepSamplesTotal;
  const grandTotal = totalSamples * combos.length;
  // When running under a worker pool (comboFilter set), only count this
  // worker's already-completed combos toward its progress denominator.
  const myComboKeys = new Set(combos.map(c => `${c.ticker}|${c.timeframe}`));
  let myCompletedCount = 0;
  for (const k of completedCombos) if (myComboKeys.has(k)) myCompletedCount++;
  let globalCurrent = myCompletedCount * totalSamples;

  if (resumeCombo && !completedCombos.has(resumeCombo) && myComboKeys.has(resumeCombo)) {
    globalCurrent += resumeIteration;
  }

  for (const combo of combos) {
    const key = `${combo.ticker}|${combo.timeframe}`;

    if (completedCombos.has(key)) continue;

    // T001a: deterministic per-combo RNG. The (jobSeed, combo) tuple alone
    // determines the random search trajectory for this combo, so the same
    // job seed yields identical results whether the combo is processed by
    // worker 0 of a 1-worker pool or worker 2 of a 4-worker pool.
    rng = makeRng(deriveComboSeed(masterSeed, key));

    if (aborted) {
      send({ type: "progress", data: {
        jobId, status: "error", stage: "Cancelled by user",
        current: Math.min(globalCurrent, grandTotal), total: grandTotal,
        percent: Math.round((Math.min(globalCurrent, grandTotal) / grandTotal) * 100),
        elapsed: Date.now() - startTime, tickerProgress, error: "Cancelled",
      }});
      send({ type: "done", results: allResults });
      return;
    }

    tickerProgress[key] = { status: "running" };

    const fullCandles = candlesByCombo[key];
    if (!fullCandles || fullCandles.length < 100) {
      // Data-unavailable combo (e.g. a symbol/timeframe with no fetchable
      // candles). Report a clear terminal disposition so finalization treats
      // this as a legitimate empty combo rather than a missing-coverage gap
      // (which used to wedge the run into a pause→pump spam loop).
      tickerProgress[key] = { status: "complete", best: 0 };
      completedCombos.add(key);
      send({ type: "combo-complete", combo: key, results: [], disposition: { status: "data-unavailable", reason: `No candle data available (${fullCandles?.length ?? 0} candles fetched)` } });
      continue;
    }

    // Validity (Task 188): OOS holdout. SEARCH/SELECT runs on the in-sample HEAD
    // slice (candles up to oosBoundary) so the optimizer NEVER sees the OOS tail
    // — the real overfit fix. FINALIZE re-runs survivors on the full window and
    // partitions trades into IS/OOS metrics. The split is by absolute TIMESTAMP
    // (resume-stable), and falls back to full-window for THIS combo when the IS
    // head is too short to search on (rare; tiny datasets). MIN_IS_BARS mirrors
    // the data-unavailable floor so search always has signal.
    const MIN_IS_BARS = 100;
    const splitIdx = oosBoundary != null
      ? fullCandles.findIndex(c => Number(c.time) >= oosBoundary)
      : -1;
    const useSplit = splitIdx >= MIN_IS_BARS && (fullCandles.length - splitIdx) >= 1;
    // Diagnostic: holdout was requested but this combo can't split (IS head too
    // short — e.g. a late-listing asset whose data starts after startDate). It
    // silently runs full-window; log so it isn't an invisible robustness gap.
    if (oosBoundary != null && !useSplit) {
      console.log(`[QuantumLab] OOS holdout: combo ${key} falls back to full-window (IS head too short: splitIdx=${splitIdx}, candles=${fullCandles.length})`);
    }
    // `candles` is the SEARCH working set: all existing search stages reference
    // it transparently, so rebinding it to the IS slice routes every stage
    // (random/peer/refine/deep/coordinate) onto in-sample data with no churn.
    const candles = useSplit ? fullCandles.slice(0, splitIdx) : fullCandles;

    const engineConfig = {
      initialCapital: 1000,
      commission: 0.0005,
      positionSize: 1000,
      processOrdersOnClose: config.processOrdersOnClose,
      pinePlan,
      strategyId: config.strategyId,
      engineType: config.engineType,
      slippage: config.slippage,
    };

    // Search uses the IS-window shared arrays (built from `candles` = IS slice).
    // Finalize needs its OWN full-window shared arrays — passing IS shared arrays
    // against the full candle array (or vice-versa) silently corrupts indicator
    // values (THE main trap). When there's no split they're the same object.
    const sharedArrays = pinePlan ? createSharedArrays(candles) : undefined;
    const fullSharedArrays = !useSplit
      ? sharedArrays
      : (pinePlan ? createSharedArrays(fullCandles) : undefined);

    // T005: assigned slot indices for this worker. When the pool runs in
    // per-slot mode, slotsPerComboMap[key] is the round-robin subset of
    // [0..randomSamples-1] for this worker. Otherwise (per-combo mode or
    // single-worker), the worker runs every slot for its combos.
    const assignedSlotsRaw: number[] = slotsPerComboMap?.[key]
      ?? Array.from({ length: config.randomSamples }, (_, i) => i);
    const assignedSlots = assignedSlotsRaw.slice().sort((a, b) => a - b);

    // T005: non-lead fast-path. Run only assigned random slots, stream
    // per-slot results back via the pool, then move to the next combo.
    // Refinement / deep / coordinate stages all run on the lead.
    if (!isLead) {
      const baselineForFilters = {} as Record<string, never>; // unused
      const _ = baselineForFilters; void _;
      // sharedIndicatorCache must NOT be shared across parameter combos —
      // each runBacktest call creates its own when undefined.
      const sharedIndicatorCache: Map<string, any> | undefined = undefined;
      const comboInsightsNL = config.guidedInsightsPerCombo?.[key] ?? config.guidedInsights;
      const hasGuidedNL = !!comboInsightsNL && comboInsightsNL.paramSensitivity.length > 0;
      const localStage = `Random Search (peer) — ${combo.ticker.split("/")[0]} ${combo.timeframe}`;
      for (const s of assignedSlots) {
        if (aborted) break;
        // Per-slot deterministic seed. Same (masterSeed, key, s) → same params
        // regardless of which worker holds the slot or pool size. No dedup
        // here: dedup decisions would diverge across pool sizes (the "earlier
        // slot" set is local to each worker). The lead dedups uniformly when
        // building testedSignatures for refinement.
        rng = makeRng(deriveConfigSeed(masterSeed, key, s));
        const progress = s / Math.max(1, config.randomSamples);
        const guidedRatio = hasGuidedNL ? (0.50 + progress * 0.20) : 0;
        const useGuided = hasGuidedNL && rng.random() < guidedRatio;
        const params = useGuided
          ? generateGuidedParams(inputs, comboInsightsNL!)
          : generateRandomParams(inputs);
        const result = runBacktest(candles, params, combo.ticker, combo.timeframe, engineConfig, sharedArrays, sharedIndicatorCache);
        const lite = toLiteResult(result);
        const resultMsg: LiteBacktestResult | null = meetsFiltersLite(lite, config) ? lite : null;
        send({ type: "slot-result", combo: key, slot: s, result: resultMsg });
        globalCurrent++;
        sendHeartbeat(jobId, localStage, globalCurrent, grandTotal, startTime, tickerProgress);
      }
      send({ type: "combo-random-done", combo: key });
      tickerProgress[key] = { status: "complete", best: 0 };
      completedCombos.add(key);
      delete candlesByCombo[key];
      continue;
    }

    // CORRECTNESS FIX: do NOT share the indicator cache across parameter combos.
    // The Pine runtime's indicator cache key is derived from the argument variable
    // NAME (e.g. "atr_len") rather than the resolved VALUE. Reusing a single cache
    // across different parameter sets returns stale results from the first combo to
    // every subsequent combo, making the optimizer effectively ignore parameter
    // changes for any indicator that takes a parameter input. Each runBacktest call
    // creates its own private cache when this is undefined (runtime.ts line ~400).
    const sharedIndicatorCache: Map<string, any> | undefined = undefined;

    const defaultParams: Record<string, any> = {};
    for (const input of inputs) {
      defaultParams[input.name] = input.default;
    }
    const baseline = runBacktest(candles, defaultParams, combo.ticker, combo.timeframe, engineConfig, sharedArrays, sharedIndicatorCache);

    if (config.coordinateTune) {
      const isResumingCoordinate = resumeCombo === key && resumeStage === "coordinate";
      const resumeCoordinateCompleted = isResumingCoordinate ? (resumeCheckpoint?.coordinateCompleted ?? []) : [];

      let seedLite: LiteBacktestResult;
      if (isResumingCoordinate && resumePartialResults.length > 0) {
        const resumeLites = resumePartialResults.map(r => toLiteResult(r));
        seedLite = [...resumeLites].sort((a, b) => scoreLite(b) - scoreLite(a))[0];
      } else {
        const comboInsights = config.guidedInsightsPerCombo?.[key] ?? config.guidedInsights;
        if (comboInsights?.topConfigs && comboInsights.topConfigs.length > 0) {
          const bestConfig = comboInsights.topConfigs.sort((a, b) => b.score - a.score)[0];
          seedLite = toLiteResult(runBacktest(candles, bestConfig.params, combo.ticker, combo.timeframe, engineConfig, sharedArrays, sharedIndicatorCache));
        } else {
          seedLite = toLiteResult(baseline);
        }
      }

      const testedSignatures = new Set<string>();
      testedSignatures.add(canonicalizeParams(defaultParams, inputs));
      testedSignatures.add(canonicalizeParams(seedLite.params, inputs));
      if (isResumingCoordinate && resumePartialResults.length > 0) {
        for (const pr of resumePartialResults) {
          testedSignatures.add(canonicalizeParams(pr.params, inputs));
        }
      }

      const resumeLites = isResumingCoordinate
        ? resumePartialResults.map(r => toLiteResult(r))
        : undefined;

      const tuneResult = coordinateTune({
        jobId, candles, ticker: combo.ticker, timeframe: combo.timeframe,
        inputs, config, engineConfig,
        seedResult: seedLite, seedScore: scoreLite(seedLite),
        testedSignatures, startTime, comboKey: key,
        tickerProgress, completedParams: resumeCoordinateCompleted,
        resumePartialResults: resumeLites,
        sharedArrays, sharedIndicatorCache,
      });

      coordinateTotalTests += tuneResult.totalTests;
      const topLites = tuneResult.results.sort((a, b) => scoreLite(b) - scoreLite(a)).slice(0, 10);
      // Only surface results that actually traded — a zero-trade result has no
      // trades/equityCurve and must not be written as a misleading "clean zero".
      // Finalize on the FULL window (fullCandles + fullSharedArrays), then split
      // trades into IS/OOS metrics and re-rank by the OOS-dominant robustness
      // score (amendment #4) — the IS-search top-10 are re-judged on OOS here.
      // attachWindowMetrics MUST run BEFORE trimResult: trim drops the EARLIEST
      // trades (slice(-maxTrades)) — exactly the IS partition — so partitioning
      // a trimmed list would corrupt is/oos on high-trade-count configs. trim's
      // {...r} spread preserves the attached is/oos fields.
      const topForCombo = topLites
        .map(lite => trimResult(attachWindowMetrics(
          runBacktest(fullCandles, lite.params, combo.ticker, combo.timeframe, engineConfig, fullSharedArrays, sharedIndicatorCache),
          oosBoundary, useSplit, engineConfig.initialCapital,
        )))
        .filter(r => (r.totalTrades ?? 0) > 0)
        .sort((a, b) => robustnessRank(b) - robustnessRank(a));
      allResults.push(...topForCombo);
      // Fidelity (Task 188): engine self-consistency for this Pine combo's best
      // config on the FULL window. Aggregated to the run. Native engines skip.
      if (pinePlan && topForCombo.length > 0) {
        try {
          const pr = runPineParityTest(pinePlan, fullCandles, topForCombo[0].params, combo.ticker, combo.timeframe, engineConfig);
          parityChecked = true;
          if (!pr.match) {
            parityMatch = false;
            for (const d of pr.diffs.slice(0, 3)) parityDiffs.push(`${combo.ticker} ${combo.timeframe}: ${d}`);
          }
        } catch (e: any) {
          console.log(`[QuantumLab] parity check error ${combo.ticker} ${combo.timeframe}: ${e.message}`);
        }
      }
      const coordDisposition = topForCombo.length > 0
        ? { status: "ok" as const }
        : { status: "no-trades" as const, reason: "No parameter set met the minimum-trades filter" };
      tickerProgress[key] = { status: "complete", best: topForCombo[0]?.netProfitPercent ?? 0 };
      completedCombos.add(key);
      send({ type: "combo-complete", combo: key, results: topForCombo, disposition: coordDisposition });

      delete candlesByCombo[key];
      continue;
    }

    const isResumingThisCombo = resumeCombo === key;
    const skipRandomUntil = isResumingThisCombo && resumeStage === "random" ? resumeIteration : 0;
    const skipRefineEntirely = isResumingThisCombo && (resumeStage === "refine" || resumeStage === "deep");
    const skipDeepUntilRound = isResumingThisCombo && resumeStage === "deep" ? resumeDeepRound : 0;
    const baselineLite = toLiteResult(baseline);
    let comboResults: LiteBacktestResult[] = isResumingThisCombo && resumePartialResults.length > 0
      ? resumePartialResults.map(r => toLiteResult(r))
      : [baselineLite];

    const testedSignatures = new Set<string>();
    testedSignatures.add(canonicalizeParams(defaultParams, inputs));

    if (isResumingThisCombo && resumePartialResults.length > 0) {
      for (const pr of resumePartialResults) {
        testedSignatures.add(canonicalizeParams(pr.params, inputs));
      }
    }
    if (isResumingThisCombo && resumeRefineSeeds) {
      for (const rs of resumeRefineSeeds) {
        testedSignatures.add(canonicalizeParams(rs, inputs));
      }
    }

    const randomStart = skipRefineEntirely ? config.randomSamples : skipRandomUntil;

    let lastCheckpointTime = Date.now();
    let checkpointCount = 0;
    const lowTf = isLowTimeframe(combo.timeframe);
    const FIRST_CHECKPOINT_MS = lowTf ? 30_000 : 10_000;
    const CHECKPOINT_INTERVAL_MS = lowTf ? 180_000 : 60_000;
    const PARTIAL_KEEP_COUNT = lowTf ? 5 : 10;

    const comboKey = `${combo.ticker}|${combo.timeframe}`;
    const comboInsights = config.guidedInsightsPerCombo?.[comboKey] ?? config.guidedInsights;
    const hasGuided = !!comboInsights && comboInsights.paramSensitivity.length > 0;
    const hasPerturbation = hasGuided && !!comboInsights?.topConfigs && comboInsights.topConfigs.length > 0;
    const searchLabel = hasPerturbation ? "Perturbation" : hasGuided ? "Guided" : "Random";

    // T005: lead processes its assigned slots only (in per-slot mode) or
    // all slots (per-combo / single-worker mode). Each slot is reseeded
    // deterministically via deriveConfigSeed so that slot K of combo C
    // always uses the same PRNG state regardless of pool size.
    const leadSlots = assignedSlots.filter(s => s >= randomStart);
    for (const s of leadSlots) {
      if (aborted) { break; }

      rng = makeRng(deriveConfigSeed(masterSeed, key, s));

      const progress = s / Math.max(1, config.randomSamples);
      const guidedRatio = hasGuided ? (0.50 + progress * 0.20) : 0;
      const useGuided = hasGuided && rng.random() < guidedRatio;

      const params = useGuided
        ? generateGuidedParams(inputs, comboInsights!)
        : generateRandomParams(inputs);
      // T005: NO dedup against testedSignatures in the random stage. With
      // per-slot reseed each slot's params is fully deterministic; dedup
      // here would skip slots whose params happen to match an earlier
      // slot's — but the "earlier slot" set depends on partition mode and
      // would diverge between N=1 (sees every prior slot) and N=4 (each
      // worker sees only its own). Dedup uniformly after the peer merge.
      const result = runBacktest(candles, params, combo.ticker, combo.timeframe, engineConfig, sharedArrays, sharedIndicatorCache);
      const lite = toLiteResult(result);
      if (meetsFiltersLite(lite, config)) {
        comboResults.push(lite);
      }
      globalCurrent++;
      sendHeartbeat(jobId, `${searchLabel} Search — ${combo.ticker.split("/")[0]} ${combo.timeframe} — ${s}/${config.randomSamples}`, globalCurrent, grandTotal, startTime, tickerProgress);

      if (s % (lowTf ? 25 : 10) === 0) {
        const best = comboResults.length > 0 ? comboResults.sort((a, b) => scoreLite(b) - scoreLite(a))[0] : null;
        send({ type: "progress", data: {
          jobId, status: "random_search",
          stage: `${searchLabel} Search — ${combo.ticker.split("/")[0]} ${combo.timeframe} — ${s}/${config.randomSamples}`,
          current: Math.min(globalCurrent, grandTotal), total: grandTotal,
          percent: Math.min(99, Math.round((globalCurrent / grandTotal) * 100)),
          elapsed: Date.now() - startTime,
          bestSoFar: best ? {
            netProfitPercent: best.netProfitPercent, winRatePercent: best.winRatePercent,
            maxDrawdownPercent: best.maxDrawdownPercent, profitFactor: best.profitFactor, sharpeRatio: best.sharpeRatio,
          } : undefined,
          tickerProgress,
          eta: estimateEta(startTime, globalCurrent, grandTotal),
        }});
      }

      const now = Date.now();
      const interval = checkpointCount === 0 ? FIRST_CHECKPOINT_MS : CHECKPOINT_INTERVAL_MS;
      if (now - lastCheckpointTime >= interval) {
        lastCheckpointTime = now;
        checkpointCount++;
        const topPartial = [...comboResults].sort((a, b) => scoreLite(b) - scoreLite(a)).slice(0, PARTIAL_KEEP_COUNT);
        send({ type: "partial-checkpoint", combo: key, stage: "random", iteration: s + 1, results: topPartial });
      }
    }

    if (aborted) continue;

    // T005: lead awaits peer slot results from the per-config-partitioned
    // random stage, then merges them into comboResults / testedSignatures
    // before starting refinement. This restores parity with the single-
    // worker random trajectory: refinement sees the full unioned result
    // set regardless of how the random stage was partitioned.
    if (peerExpectedCount > 0) {
      await new Promise<void>((resolve) => {
        if ((peerComboRandomDoneCount.get(key) ?? 0) >= peerExpectedCount) { resolve(); return; }
        peerComboRandomDoneResolvers.set(key, resolve);
      });
      const peers = peerSlotResults.get(key) ?? [];
      for (const r of peers) {
        if (!r) continue;
        // No dedup — peer results were already filtered for meetsFilters
        // before being sent. Dedup here would diverge from single-worker
        // mode where the same slots were processed in slot-index order.
        comboResults.push(r);
      }
      peerSlotResults.delete(key);
    }

    if (aborted) continue;

    // T005: rebuild testedSignatures from the full unioned comboResults so
    // refinement's dedup behaves the same regardless of partition mode.
    testedSignatures.clear();
    testedSignatures.add(canonicalizeParams(defaultParams, inputs));
    for (const r of comboResults) {
      testedSignatures.add(canonicalizeParams(r.params, inputs));
    }
    if (isResumingThisCombo && resumeRefineSeeds) {
      for (const rs of resumeRefineSeeds) testedSignatures.add(canonicalizeParams(rs, inputs));
    }

    // T005: reseed PRNG for the refinement stage so its trajectory is a
    // pure function of (masterSeed, comboKey), independent of how many
    // peer slots streamed in or in what order.
    rng = makeRng(deriveStageSeed(masterSeed, key, "refine"));

    // Deterministic sort: primary by score desc, tiebreak by canonical
    // params signature ascending. Ensures selectDiverseSeeds picks the
    // same elements when ties are present.
    comboResults.sort((a, b) => {
      const ds = scoreLite(b) - scoreLite(a);
      if (ds !== 0) return ds;
      const sa = canonicalizeParams(a.params, inputs);
      const sb = canonicalizeParams(b.params, inputs);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
    const topSeeds = isResumingThisCombo && resumeRefineSeeds && (resumeStage === "refine" || resumeStage === "deep")
      ? resumeRefineSeeds.map(params => ({ params } as LiteBacktestResult))
      : selectDiverseSeeds(comboResults, config.topK, inputs);
    const refineSeedParams = topSeeds.map(s => s.params);

    const refineStartIteration = config.randomSamples;
    const skipStandardRefine = isResumingThisCombo && resumeStage === "deep";

    if (skipStandardRefine) {
      globalCurrent += totalSamples - config.randomSamples;
    } else {
      for (let seedIdx = 0; seedIdx < topSeeds.length; seedIdx++) {
        if (aborted) break;
        const seed = topSeeds[seedIdx];
        for (let r = 0; r < config.refinementsPerSeed; r++) {
          if (aborted) { globalCurrent += (config.refinementsPerSeed - r); break; }

          const currentRefineIter = refineStartIteration + seedIdx * config.refinementsPerSeed + r;
          if (isResumingThisCombo && resumeStage === "refine" && currentRefineIter < resumeIteration) {
            continue;
          }

          let jitteredParams: Record<string, any>;
          let isDuplicate = true;
          for (let attempt = 0; attempt < 4; attempt++) {
            jitteredParams = jitterParams(seed.params, inputs);
            const sig = canonicalizeParams(jitteredParams, inputs);
            if (!testedSignatures.has(sig)) {
              testedSignatures.add(sig);
              isDuplicate = false;
              break;
            }
          }
          if (isDuplicate) {
            globalCurrent++;
            continue;
          }

          const result = runBacktest(candles, jitteredParams!, combo.ticker, combo.timeframe, engineConfig, sharedArrays, sharedIndicatorCache);
          const lite = toLiteResult(result);
          if (meetsFiltersLite(lite, config)) {
            comboResults.push(lite);
          }
          globalCurrent++;
          sendHeartbeat(jobId, `Refining seed ${seedIdx + 1}/${topSeeds.length} — ${combo.ticker.split("/")[0]} ${combo.timeframe}`, globalCurrent, grandTotal, startTime, tickerProgress);
        }

        const best = comboResults.length > 0 ? comboResults.sort((a, b) => scoreLite(b) - scoreLite(a))[0] : null;
        send({ type: "progress", data: {
          jobId, status: "refinement",
          stage: `Refining seed ${seedIdx + 1}/${topSeeds.length} — ${combo.ticker.split("/")[0]} ${combo.timeframe}`,
          current: Math.min(globalCurrent, grandTotal), total: grandTotal,
          percent: Math.min(99, Math.round((globalCurrent / grandTotal) * 100)),
          elapsed: Date.now() - startTime,
          bestSoFar: best ? {
            netProfitPercent: best.netProfitPercent, winRatePercent: best.winRatePercent,
            maxDrawdownPercent: best.maxDrawdownPercent, profitFactor: best.profitFactor, sharpeRatio: best.sharpeRatio,
          } : undefined,
          tickerProgress,
          eta: estimateEta(startTime, globalCurrent, grandTotal),
        }});

        const isLastSeed = seedIdx === topSeeds.length - 1;
        const refineElapsed = Date.now() - lastCheckpointTime;
        const REFINE_CHECKPOINT_INTERVAL = lowTf ? 180_000 : 60_000;
        if (isLastSeed || refineElapsed >= REFINE_CHECKPOINT_INTERVAL) {
          const actualIter = refineStartIteration + seedIdx * config.refinementsPerSeed + config.refinementsPerSeed;
          const refineKeepCount = lowTf ? Math.max(5, config.topK) : Math.max(10, config.topK);
          const topPartial = [...comboResults].sort((a, b) => scoreLite(b) - scoreLite(a)).slice(0, refineKeepCount);
          send({ type: "partial-checkpoint", combo: key, stage: "refine", iteration: actualIter, results: topPartial, refineSeeds: refineSeedParams });
          lastCheckpointTime = Date.now();
          checkpointCount++;
        }
      }
    }

    if (config.deepSearch && !aborted) {
      // T005: deep-search stage is also reseeded deterministically so that
      // (masterSeed, comboKey) fully determines its trajectory regardless
      // of pool size / partition mode.
      rng = makeRng(deriveStageSeed(masterSeed, key, "deep"));
      const deepRadii = [0.12, 0.08, 0.05];
      const numOptimizable = inputs.filter(i => i.optimizable && (i.type === "int" || i.type === "float")).length;
      let previousRoundBest: LiteBacktestResult[] = [];
      let injectedResumeBest = false;

      for (let round = 0; round < deepRounds; round++) {
        if (aborted) {
          globalCurrent += (deepRounds - round) * deepSeedsPerRound * deepRefinesPerSeed;
          break;
        }
        if (round < skipDeepUntilRound) {
          globalCurrent += deepSeedsPerRound * deepRefinesPerSeed;
          continue;
        }
        const radius = deepRadii[round] ?? 0.05;
        comboResults.sort((a, b) => scoreLite(b) - scoreLite(a));

        let deepSeeds: LiteBacktestResult[];
        const eliteCount = Math.max(1, Math.ceil(deepSeedsPerRound * 0.30));
        const novelCount = deepSeedsPerRound - eliteCount;

        if (round === 0) {
          deepSeeds = selectDiverseSeeds(comboResults, deepSeedsPerRound, inputs);
        } else if (round === 1) {
          const elites = comboResults.slice(0, eliteCount);
          const novelPool = previousRoundBest.length > 0 ? previousRoundBest : comboResults;
          const novelCandidates = selectDiverseSeeds(novelPool, novelCount + eliteCount, inputs);
          const novelOnly = novelCandidates.filter(
            c => !elites.some(e => canonicalizeParams(e.params, inputs) === canonicalizeParams(c.params, inputs))
          ).slice(0, novelCount);
          deepSeeds = [...elites, ...novelOnly];
          while (deepSeeds.length < deepSeedsPerRound && comboResults.length > deepSeeds.length) {
            deepSeeds.push(comboResults[deepSeeds.length]);
          }
        } else {
          const elites = comboResults.slice(0, eliteCount);
          const exploratoryCount = Math.max(1, Math.ceil(deepSeedsPerRound * 0.25));
          const remainingNovel = deepSeedsPerRound - eliteCount - exploratoryCount;
          const novelCandidates = selectDiverseSeeds(
            previousRoundBest.length > 0 ? previousRoundBest : comboResults,
            remainingNovel + eliteCount, inputs
          );
          const novelOnly = novelCandidates.filter(
            c => !elites.some(e => canonicalizeParams(e.params, inputs) === canonicalizeParams(c.params, inputs))
          ).slice(0, remainingNovel);
          const exploratory: LiteBacktestResult[] = [];
          for (let e = 0; e < exploratoryCount; e++) {
            let rp: Record<string, any>;
            let isDup = true;
            for (let attempt = 0; attempt < 4; attempt++) {
              rp = generateRandomParams(inputs);
              const sig = canonicalizeParams(rp, inputs);
              if (!testedSignatures.has(sig)) {
                testedSignatures.add(sig);
                isDup = false;
                break;
              }
            }
            if (isDup) continue;
            const er = runBacktest(candles, rp!, combo.ticker, combo.timeframe, engineConfig, sharedArrays, sharedIndicatorCache);
            const erLite = toLiteResult(er);
            if (meetsFiltersLite(erLite, config)) {
              exploratory.push(erLite);
              comboResults.push(erLite);
            }
            sendHeartbeat(jobId, `Deep R${round + 1} explore — ${combo.ticker.split("/")[0]} ${combo.timeframe}`, globalCurrent, grandTotal, startTime, tickerProgress);
          }
          deepSeeds = [...elites, ...novelOnly, ...exploratory];
          while (deepSeeds.length < deepSeedsPerRound && comboResults.length > deepSeeds.length) {
            deepSeeds.push(comboResults[deepSeeds.length]);
          }
        }

        if (!injectedResumeBest && resumeCheckpoint?.bestDiscovery?.params) {
          const bd = resumeCheckpoint.bestDiscovery;
          if (bd.combo === key) {
            const bdSig = canonicalizeParams(bd.params, inputs);
            if (!testedSignatures.has(bdSig)) {
              const bdResult = runBacktest(candles, bd.params, combo.ticker, combo.timeframe, engineConfig, sharedArrays, sharedIndicatorCache);
              const bdLite = toLiteResult(bdResult);
              const existingSigs = new Set(deepSeeds.map(s => canonicalizeParams(s.params, inputs)));
              if (!existingSigs.has(bdSig)) {
                deepSeeds = [bdLite, ...deepSeeds.filter(s => canonicalizeParams(s.params, inputs) !== bdSig)].slice(0, deepSeedsPerRound);
              }
              comboResults.push(bdLite);
              testedSignatures.add(bdSig);
            }
          }
          injectedResumeBest = true;
        }

        const roundDiscoveries: LiteBacktestResult[] = [];
        let comboBestScore = comboResults.length > 0
          ? Math.max(...comboResults.map(r => scoreLite(r)))
          : -Infinity;

        for (let seedIdx = 0; seedIdx < deepSeeds.length; seedIdx++) {
          if (aborted) {
            globalCurrent += (deepSeeds.length - seedIdx) * deepRefinesPerSeed;
            break;
          }
          const seed = deepSeeds[seedIdx];
          for (let r = 0; r < deepRefinesPerSeed; r++) {
            if (aborted) { globalCurrent += (deepRefinesPerSeed - r); break; }

            let jittered: Record<string, any>;
            let isDuplicate = true;
            for (let attempt = 0; attempt < 4; attempt++) {
              jittered = jitterParams(seed.params, inputs, numOptimizable, radius);
              const sig = canonicalizeParams(jittered, inputs);
              if (!testedSignatures.has(sig)) {
                testedSignatures.add(sig);
                isDuplicate = false;
                break;
              }
            }
            if (isDuplicate) {
              globalCurrent++;
              continue;
            }

            const result = runBacktest(candles, jittered!, combo.ticker, combo.timeframe, engineConfig, sharedArrays, sharedIndicatorCache);
            const lite = toLiteResult(result);
            if (meetsFiltersLite(lite, config)) {
              comboResults.push(lite);
              roundDiscoveries.push(lite);
              const resultScore = scoreLite(lite);
              if (resultScore > comboBestScore + 1e-9) {
                comboBestScore = resultScore;
                send({ type: "best-discovery", combo: key, stage: "deep", deepRound: round, score: resultScore, params: { ...lite.params } });
              }
            }
            sendHeartbeat(jobId, `Deep R${round + 1} — seed ${seedIdx + 1}/${deepSeeds.length} — ${combo.ticker.split("/")[0]} ${combo.timeframe}`, globalCurrent, grandTotal, startTime, tickerProgress);
            globalCurrent++;
          }

          const best = comboResults.length > 0 ? comboResults.sort((a, b) => scoreLite(b) - scoreLite(a))[0] : null;
          send({ type: "progress", data: {
            jobId, status: "refinement",
            stage: `Deep R${round + 1} (${Math.round(radius * 100)}%) — seed ${seedIdx + 1}/${deepSeeds.length} — ${combo.ticker.split("/")[0]} ${combo.timeframe}`,
            current: Math.min(globalCurrent, grandTotal), total: grandTotal,
            percent: Math.min(99, Math.round((globalCurrent / grandTotal) * 100)),
            elapsed: Date.now() - startTime,
            bestSoFar: best ? {
              netProfitPercent: best.netProfitPercent, winRatePercent: best.winRatePercent,
              maxDrawdownPercent: best.maxDrawdownPercent, profitFactor: best.profitFactor, sharpeRatio: best.sharpeRatio,
            } : undefined,
            tickerProgress,
            eta: estimateEta(startTime, globalCurrent, grandTotal),
          }});

          const isLastDeepSeed = seedIdx === deepSeeds.length - 1;
          const deepSeedElapsed = Date.now() - lastCheckpointTime;
          const DEEP_CHECKPOINT_INTERVAL = lowTf ? 180_000 : 60_000;
          if (isLastDeepSeed || deepSeedElapsed >= DEEP_CHECKPOINT_INTERVAL) {
            const deepCheckpointCount = lowTf ? Math.max(5, config.topK) : Math.max(10, config.topK);
            const topPartial = [...comboResults].sort((a, b) => scoreLite(b) - scoreLite(a)).slice(0, deepCheckpointCount);
            send({ type: "partial-checkpoint", combo: key, stage: "deep", iteration: totalSamples, deepRound: round, results: topPartial, refineSeeds: refineSeedParams });
            lastCheckpointTime = Date.now();
            checkpointCount++;
          }
        }

        previousRoundBest = [...roundDiscoveries].sort((a, b) => scoreLite(b) - scoreLite(a)).slice(0, Math.max(10, deepSeedsPerRound));

        const deepCheckpointCount2 = lowTf ? Math.max(5, config.topK) : Math.max(10, config.topK);
        const topAfterRound = [...comboResults].sort((a, b) => scoreLite(b) - scoreLite(a)).slice(0, deepCheckpointCount2);
        send({ type: "partial-checkpoint", combo: key, stage: "deep", iteration: totalSamples, deepRound: round + 1, results: topAfterRound, refineSeeds: refineSeedParams });
        lastCheckpointTime = Date.now();
      }
    }

    comboResults.sort((a, b) => scoreLite(b) - scoreLite(a));
    // Only surface results that actually traded. A zero-trade result (e.g. the
    // default-param baseline seed when no sampled config met min_trades) carries
    // no trades/equityCurve and must NOT be written as a misleading "clean zero"
    // success row. If nothing traded, this combo reports "no-trades" (empty),
    // not a fake zero result.
    const tradedLites = comboResults.filter(r => (r.totalTrades ?? 0) > 0);
    const topLitesForCombo = tradedLites.slice(0, 10);
    const topForCombo: LabBacktestResult[] = [];
    for (let fi = 0; fi < topLitesForCombo.length; fi++) {
      const lite = topLitesForCombo[fi];
      sendHeartbeat(jobId, `Finalizing ${combo.ticker.split("/")[0]} ${combo.timeframe} — ${fi + 1}/${topLitesForCombo.length}`, globalCurrent, grandTotal, startTime, tickerProgress);
      // Finalize on the FULL window (fullCandles + fullSharedArrays), then split
      // trades into IS/OOS metrics. Primary cols stay full-period (headline).
      // attachWindowMetrics BEFORE trimResult — trim drops the earliest (IS)
      // trades, so partitioning must happen on the full trade list first.
      topForCombo.push(trimResult(attachWindowMetrics(
        runBacktest(fullCandles, lite.params, combo.ticker, combo.timeframe, engineConfig, fullSharedArrays, sharedIndicatorCache),
        oosBoundary, useSplit, engineConfig.initialCapital,
      )));
    }
    // Re-rank by the OOS-dominant robustness score (amendment #4): IS-search
    // top-10 re-judged on out-of-sample before they become the combo's winners.
    topForCombo.sort((a, b) => robustnessRank(b) - robustnessRank(a));
    allResults.push(...topForCombo);

    // Fidelity (Task 188): engine self-consistency for this Pine combo's best
    // config on the FULL window. Aggregated to the run. Native engines skip.
    if (pinePlan && topForCombo.length > 0) {
      try {
        const pr = runPineParityTest(pinePlan, fullCandles, topForCombo[0].params, combo.ticker, combo.timeframe, engineConfig);
        parityChecked = true;
        if (!pr.match) {
          parityMatch = false;
          for (const d of pr.diffs.slice(0, 3)) parityDiffs.push(`${combo.ticker} ${combo.timeframe}: ${d}`);
        }
      } catch (e: any) {
        console.log(`[QuantumLab] parity check error ${combo.ticker} ${combo.timeframe}: ${e.message}`);
      }
    }

    const disposition = topForCombo.length > 0
      ? { status: "ok" as const }
      : { status: "no-trades" as const, reason: "No parameter set met the minimum-trades filter" };
    tickerProgress[key] = { status: "complete", best: topForCombo[0]?.netProfitPercent ?? 0 };
    completedCombos.add(key);
    send({ type: "combo-complete", combo: key, results: topForCombo, disposition });

    delete candlesByCombo[key];
  }

  // Global cross-combo ranking uses the same OOS-dominant robustness score so
  // the run's overall "best" reflects out-of-sample robustness, not IS-fit.
  // Combos without a holdout (legacy/short) get a flat robustScore*0.75 demotion
  // (see robustnessRank) → consistent ordering whether or not OOS is present.
  allResults.sort((a, b) => robustnessRank(b) - robustnessRank(a));

  const finalTotal = config.coordinateTune ? coordinateTotalTests : grandTotal;
  send({ type: "progress", data: {
    jobId, status: "complete", stage: "Optimization complete",
    current: finalTotal, total: finalTotal,
    percent: 100, elapsed: Date.now() - startTime,
    bestSoFar: allResults[0] ? {
      netProfitPercent: allResults[0].netProfitPercent, winRatePercent: allResults[0].winRatePercent,
      maxDrawdownPercent: allResults[0].maxDrawdownPercent, profitFactor: allResults[0].profitFactor, sharpeRatio: allResults[0].sharpeRatio,
    } : undefined,
    tickerProgress,
  }});

  send({
    type: "done",
    results: allResults,
    totalConfigsTested: config.coordinateTune ? coordinateTotalTests : undefined,
    parityChecked,
    parityMatch: parityChecked ? parityMatch : undefined,
    parityDiffs: parityDiffs.slice(0, 10),
  });
}

process.on("uncaughtException", (err: Error) => {
  const isResource = err.message?.includes("heap") || err.message?.includes("Allocation failed") || err.message?.includes("out of memory");
  try {
    send({ type: "error", message: `Uncaught: ${err.message || String(err)}`, isResourceError: isResource });
  } catch {}
  process.exit(1);
});

run().catch((err: any) => {
  send({ type: "error", message: err.message || String(err) });
});
