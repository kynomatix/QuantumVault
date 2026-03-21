import { workerData, parentPort } from "worker_threads";
import { runBacktest, compilePine, type OHLCV, type PinePlan } from "./engine";
import type { LabPineInput, LabBacktestResult, LabJobProgress, LabCheckpoint, GuidedInsights } from "@shared/schema";

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
  };
  candlesByCombo: Record<string, OHLCV[]>;
  resumeCheckpoint?: LabCheckpoint;
}

type WorkerMessage =
  | { type: "progress"; data: LabJobProgress }
  | { type: "partial-checkpoint"; combo: string; stage: "random" | "refine" | "deep" | "coordinate"; iteration: number; deepRound?: number; results: LabBacktestResult[]; refineSeeds?: Record<string, any>[]; coordinateCompleted?: string[] }
  | { type: "combo-complete"; combo: string; results: LabBacktestResult[] }
  | { type: "best-discovery"; combo: string; stage: "deep"; deepRound: number; score: number; params: Record<string, any> }
  | { type: "done"; results: LabBacktestResult[]; totalConfigsTested?: number }
  | { type: "error"; message: string; isResourceError?: boolean };

function send(msg: WorkerMessage) {
  parentPort?.postMessage(msg);
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

function selectDiverseSeeds(results: LabBacktestResult[], count: number, inputs: LabPineInput[]): LabBacktestResult[] {
  if (results.length <= count) return [...results];
  const selected: LabBacktestResult[] = [results[0]];
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
    delta = (Math.random() - 0.5) * 2 * effectiveAmount;
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
        params[input.name] = min + Math.floor(Math.random() * (range + 1)) * step;
        break;
      }
      case "float": {
        const min = input.min ?? 0.1;
        const max = input.max ?? 10;
        const step = input.step ?? 0.1;
        const range = Math.floor((max - min) / step);
        const val = min + Math.floor(Math.random() * (range + 1)) * step;
        params[input.name] = Math.round(val * 10000) / 10000;
        break;
      }
      case "bool":
        params[input.name] = Math.random() > 0.5;
        break;
      case "string":
        if (input.options && input.options.length > 0) {
          params[input.name] = input.options[Math.floor(Math.random() * input.options.length)];
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
  const u1 = Math.random();
  const u2 = Math.random();
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
  const seed = topConfigs[Math.floor(Math.random() * topConfigs.length)].params;

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
        params[input.name] = Math.random() < 0.65 ? seedBool : !seedBool;
        break;
      }
      case "string": {
        if (input.options && input.options.length > 1) {
          const seedStr = typeof seedVal === "string" ? seedVal : (input.default ?? input.options[0]);
          if (Math.random() < 0.65) {
            params[input.name] = seedStr;
          } else {
            const others = input.options.filter(o => o !== seedStr);
            params[input.name] = others.length > 0 ? others[Math.floor(Math.random() * others.length)] : seedStr;
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
          params[input.name] = min + Math.floor(Math.random() * (range + 1)) * step;
          break;
        }
        case "float": {
          const min = input.min ?? 0.1;
          const max = input.max ?? 10;
          const step = input.step ?? 0.1;
          const range = Math.floor((max - min) / step);
          const val = min + Math.floor(Math.random() * (range + 1)) * step;
          params[input.name] = Math.round(val * 10000) / 10000;
          break;
        }
        case "bool":
          params[input.name] = Math.random() > 0.5;
          break;
        case "string":
          if (input.options && input.options.length > 0) {
            params[input.name] = input.options[Math.floor(Math.random() * input.options.length)];
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
            params[input.name] = globalMin + Math.floor(Math.random() * (range + 1)) * step;
          } else {
            const range = Math.floor((narrowMax - narrowMin) / step);
            params[input.name] = narrowMin + Math.floor(Math.random() * (range + 1)) * step;
          }
        } else {
          const range = Math.floor((globalMax - globalMin) / step);
          params[input.name] = globalMin + Math.floor(Math.random() * (range + 1)) * step;
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
            const val = globalMin + Math.floor(Math.random() * (range + 1)) * step;
            params[input.name] = Math.round(val * 10000) / 10000;
          } else {
            const fineStep = Math.max(step / 2, 0.001);
            const range = Math.floor((narrowMax - narrowMin) / fineStep);
            const val = narrowMin + Math.floor(Math.random() * Math.max(1, range + 1)) * fineStep;
            params[input.name] = Math.round(Math.min(narrowMax, val) * 10000) / 10000;
          }
        } else {
          const range = Math.floor((globalMax - globalMin) / step);
          const val = globalMin + Math.floor(Math.random() * (range + 1)) * step;
          params[input.name] = Math.round(val * 10000) / 10000;
        }
        break;
      }
      case "bool":
        params[input.name] = Math.random() > 0.5;
        break;
      case "string":
        if (input.options && input.options.length > 0) {
          params[input.name] = input.options[Math.floor(Math.random() * input.options.length)];
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
  const toJitter = optimizable.sort(() => Math.random() - 0.5).slice(0, jitterCount);

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
  if (boolInputs.length > 0 && Math.random() < 0.35) {
    const toBool = boolInputs[Math.floor(Math.random() * boolInputs.length)];
    params[toBool.name] = !params[toBool.name];
  }

  const stringInputs = inputs.filter(i => i.optimizable && i.type === "string" && i.options && i.options.length > 1);
  if (stringInputs.length > 0 && Math.random() < 0.35) {
    const toStr = stringInputs[Math.floor(Math.random() * stringInputs.length)];
    const currentStr = params[toStr.name];
    const others = toStr.options!.filter(o => o !== currentStr);
    if (others.length > 0) {
      params[toStr.name] = others[Math.floor(Math.random() * others.length)];
    }
  }

  return params;
}

function scoreResult(r: LabBacktestResult): number {
  const dd = r.maxDrawdownPercent;
  const safeMaxLev = dd > 0 ? Math.min(20, 80 / dd) : 20;
  const leveragedProfit = r.netProfitPercent * safeMaxLev;
  return leveragedProfit * 100 + r.winRatePercent * 10 + r.profitFactor * 50 - dd * 50;
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
  engineConfig: { initialCapital: number; commission: number; positionSize: number; processOrdersOnClose?: boolean };
  seedResult: LabBacktestResult;
  seedScore: number;
  testedSignatures: Set<string>;
  startTime: number;
  comboKey: string;
  tickerProgress: Record<string, { status: "pending" | "running" | "complete"; best?: number }>;
  completedParams: string[];
  resumePartialResults?: LabBacktestResult[];
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

function coordinateTune(ctx: CoordinateTuneContext): { results: LabBacktestResult[]; totalTests: number } {
  const {
    jobId, candles, ticker, timeframe, inputs, config, engineConfig,
    seedResult, testedSignatures, startTime, comboKey, tickerProgress, completedParams,
  } = ctx;
  let bestScore = ctx.seedScore;
  let bestResult = seedResult;
  const allResults: LabBacktestResult[] = [seedResult];
  if (ctx.resumePartialResults && ctx.resumePartialResults.length > 0) {
    for (const pr of ctx.resumePartialResults) {
      const sig = canonicalizeParams(pr.params, inputs);
      if (!testedSignatures.has(sig)) {
        testedSignatures.add(sig);
      }
      allResults.push(pr);
      const prScore = scoreResult(pr);
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

      const result = runBacktest(candles, testParams, ticker, timeframe, engineConfig);
      if (!meetsFilters(result, config)) continue;

      const score = scoreResult(result);
      allResults.push(result);
      if (score > paramBestScore) {
        paramBestScore = score;
        paramBestResult = result;
      }
    }

    const improvement = paramBestScore - paramStartScore;
    paramImpact.push({ name: input.name, improvement });

    if (paramBestScore > bestScore) {
      bestScore = paramBestScore;
      bestResult = paramBestResult;
    }

    completedParamSet.add(input.name);

    const best = allResults.sort((a, b) => scoreResult(b) - scoreResult(a))[0];
    send({ type: "progress", data: {
      jobId, status: "refinement",
      stage: `Coordinate Tune — ${input.name} — ${ticker.split("/")[0]} ${timeframe} — best Δ${improvement > 0 ? "+" : ""}${improvement.toFixed(1)}`,
      current: Math.min(currentTest, grandTotal), total: grandTotal,
      percent: Math.min(99, Math.round((currentTest / grandTotal) * 100)),
      elapsed: Date.now() - startTime,
      bestSoFar: best ? {
        netProfitPercent: best.netProfitPercent, winRatePercent: best.winRatePercent,
        maxDrawdownPercent: best.maxDrawdownPercent, profitFactor: best.profitFactor,
      } : undefined,
      tickerProgress,
      eta: estimateEta(startTime, currentTest, grandTotal),
    }});

    const topPartial = [...allResults].sort((a, b) => scoreResult(b) - scoreResult(a)).slice(0, 10);
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

              const result = runBacktest(candles, testParams, ticker, timeframe, engineConfig);
              if (!meetsFilters(result, config)) continue;

              const score = scoreResult(result);
              allResults.push(result);
              if (score > bestScore) {
                bestScore = score;
                bestResult = result;
              }
            }
          }

          const best = allResults.sort((a, b) => scoreResult(b) - scoreResult(a))[0];
          send({ type: "progress", data: {
            jobId, status: "refinement",
            stage: `Pair Tune — ${inputA.name} × ${inputB.name} — ${ticker.split("/")[0]} ${timeframe}`,
            current: Math.min(currentTest, grandTotal), total: grandTotal,
            percent: Math.min(99, Math.round((currentTest / grandTotal) * 100)),
            elapsed: Date.now() - startTime,
            bestSoFar: best ? {
              netProfitPercent: best.netProfitPercent, winRatePercent: best.winRatePercent,
              maxDrawdownPercent: best.maxDrawdownPercent, profitFactor: best.profitFactor,
            } : undefined,
            tickerProgress,
            eta: estimateEta(startTime, currentTest, grandTotal),
          }});

          const topPartial = [...allResults].sort((a, b) => scoreResult(b) - scoreResult(a)).slice(0, 10);
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

let aborted = false;

parentPort?.on("message", (msg: any) => {
  if (msg?.type === "abort") {
    aborted = true;
  }
});

async function run() {
  const { jobId, config, candlesByCombo, resumeCheckpoint } = workerData as WorkerInput;
  const startTime = Date.now();
  const allResults: LabBacktestResult[] = [];
  let coordinateTotalTests = 0;
  const inputs = config.parsedInputs;

  let pinePlan: PinePlan | undefined;
  if (config.pineScript) {
    try {
      pinePlan = compilePine(config.pineScript);
    } catch (e: any) {
      send({ type: "error", message: `PineScript compilation failed: ${e.message}` });
      return;
    }
  }

  const combos: { ticker: string; timeframe: string }[] = [];
  for (const ticker of config.tickers) {
    for (const tf of config.timeframes) {
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
  let globalCurrent = completedCombos.size * totalSamples;

  if (resumeCombo && !completedCombos.has(resumeCombo)) {
    globalCurrent += resumeIteration;
  }

  for (const combo of combos) {
    const key = `${combo.ticker}|${combo.timeframe}`;

    if (completedCombos.has(key)) continue;

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

    const candles = candlesByCombo[key];
    if (!candles || candles.length < 100) {
      tickerProgress[key] = { status: "complete", best: 0 };
      completedCombos.add(key);
      send({ type: "combo-complete", combo: key, results: [] });
      continue;
    }

    const engineConfig = {
      initialCapital: 1000,
      commission: 0.0005,
      positionSize: 1000,
      processOrdersOnClose: config.processOrdersOnClose,
      pinePlan,
    };

    const defaultParams: Record<string, any> = {};
    for (const input of inputs) {
      defaultParams[input.name] = input.default;
    }
    const baseline = runBacktest(candles, defaultParams, combo.ticker, combo.timeframe, engineConfig);

    if (config.coordinateTune) {
      const isResumingCoordinate = resumeCombo === key && resumeStage === "coordinate";
      const resumeCoordinateCompleted = isResumingCoordinate ? (resumeCheckpoint?.coordinateCompleted ?? []) : [];

      let seedResult: LabBacktestResult;
      if (isResumingCoordinate && resumePartialResults.length > 0) {
        seedResult = [...resumePartialResults].sort((a, b) => scoreResult(b) - scoreResult(a))[0];
      } else {
        const comboInsights = config.guidedInsightsPerCombo?.[key] ?? config.guidedInsights;
        if (comboInsights?.topConfigs && comboInsights.topConfigs.length > 0) {
          const bestConfig = comboInsights.topConfigs.sort((a, b) => b.score - a.score)[0];
          seedResult = runBacktest(candles, bestConfig.params, combo.ticker, combo.timeframe, engineConfig);
        } else {
          seedResult = baseline;
        }
      }

      const testedSignatures = new Set<string>();
      testedSignatures.add(canonicalizeParams(defaultParams, inputs));
      testedSignatures.add(canonicalizeParams(seedResult.params, inputs));
      if (isResumingCoordinate && resumePartialResults.length > 0) {
        for (const pr of resumePartialResults) {
          testedSignatures.add(canonicalizeParams(pr.params, inputs));
        }
      }

      const tuneResult = coordinateTune({
        jobId, candles, ticker: combo.ticker, timeframe: combo.timeframe,
        inputs, config, engineConfig,
        seedResult, seedScore: scoreResult(seedResult),
        testedSignatures, startTime, comboKey: key,
        tickerProgress, completedParams: resumeCoordinateCompleted,
        resumePartialResults: isResumingCoordinate ? resumePartialResults : undefined,
      });

      coordinateTotalTests += tuneResult.totalTests;
      const topForCombo = tuneResult.results.sort((a, b) => scoreResult(b) - scoreResult(a)).slice(0, 10);
      allResults.push(...topForCombo);
      tickerProgress[key] = { status: "complete", best: topForCombo[0]?.netProfitPercent ?? 0 };
      completedCombos.add(key);
      send({ type: "combo-complete", combo: key, results: topForCombo });
      continue;
    }

    const isResumingThisCombo = resumeCombo === key;
    const skipRandomUntil = isResumingThisCombo && resumeStage === "random" ? resumeIteration : 0;
    const skipRefineEntirely = isResumingThisCombo && (resumeStage === "refine" || resumeStage === "deep");
    const skipDeepUntilRound = isResumingThisCombo && resumeStage === "deep" ? resumeDeepRound : 0;
    let comboResults: LabBacktestResult[] = isResumingThisCombo && resumePartialResults.length > 0
      ? [...resumePartialResults]
      : [baseline];

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
    const FIRST_CHECKPOINT_MS = 10_000;
    const CHECKPOINT_INTERVAL_MS = 60_000;

    const comboKey = `${combo.ticker}|${combo.timeframe}`;
    const comboInsights = config.guidedInsightsPerCombo?.[comboKey] ?? config.guidedInsights;
    const hasGuided = !!comboInsights && comboInsights.paramSensitivity.length > 0;
    const hasPerturbation = hasGuided && !!comboInsights?.topConfigs && comboInsights.topConfigs.length > 0;
    const searchLabel = hasPerturbation ? "Perturbation" : hasGuided ? "Guided" : "Random";

    for (let s = randomStart; s < config.randomSamples; s++) {
      if (aborted) { globalCurrent += (config.randomSamples - s); break; }

      const progress = s / config.randomSamples;
      const guidedRatio = hasGuided ? (0.50 + progress * 0.20) : 0;
      const useGuided = hasGuided && Math.random() < guidedRatio;

      let params: Record<string, any>;
      let isDuplicate = true;
      for (let attempt = 0; attempt < 4; attempt++) {
        params = useGuided
          ? generateGuidedParams(inputs, comboInsights!)
          : generateRandomParams(inputs);
        const sig = canonicalizeParams(params, inputs);
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

      const result = runBacktest(candles, params!, combo.ticker, combo.timeframe, engineConfig);
      if (meetsFilters(result, config)) {
        comboResults.push(result);
      }
      globalCurrent++;

      if (s % 10 === 0) {
        const best = comboResults.length > 0 ? comboResults.sort((a, b) => scoreResult(b) - scoreResult(a))[0] : null;
        send({ type: "progress", data: {
          jobId, status: "random_search",
          stage: `${searchLabel} Search — ${combo.ticker.split("/")[0]} ${combo.timeframe} — ${s}/${config.randomSamples}`,
          current: Math.min(globalCurrent, grandTotal), total: grandTotal,
          percent: Math.min(99, Math.round((globalCurrent / grandTotal) * 100)),
          elapsed: Date.now() - startTime,
          bestSoFar: best ? {
            netProfitPercent: best.netProfitPercent, winRatePercent: best.winRatePercent,
            maxDrawdownPercent: best.maxDrawdownPercent, profitFactor: best.profitFactor,
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
        const topPartial = [...comboResults].sort((a, b) => scoreResult(b) - scoreResult(a)).slice(0, 10);
        send({ type: "partial-checkpoint", combo: key, stage: "random", iteration: s + 1, results: topPartial });
      }
    }

    if (aborted) continue;

    comboResults.sort((a, b) => scoreResult(b) - scoreResult(a));
    const topSeeds = isResumingThisCombo && resumeRefineSeeds && (resumeStage === "refine" || resumeStage === "deep")
      ? resumeRefineSeeds.map(params => ({ params } as LabBacktestResult))
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

          const result = runBacktest(candles, jitteredParams!, combo.ticker, combo.timeframe, engineConfig);
          if (meetsFilters(result, config)) {
            comboResults.push(result);
          }
          globalCurrent++;
        }

        const best = comboResults.length > 0 ? comboResults.sort((a, b) => scoreResult(b) - scoreResult(a))[0] : null;
        send({ type: "progress", data: {
          jobId, status: "refinement",
          stage: `Refining seed ${seedIdx + 1}/${topSeeds.length} — ${combo.ticker.split("/")[0]} ${combo.timeframe}`,
          current: Math.min(globalCurrent, grandTotal), total: grandTotal,
          percent: Math.min(99, Math.round((globalCurrent / grandTotal) * 100)),
          elapsed: Date.now() - startTime,
          bestSoFar: best ? {
            netProfitPercent: best.netProfitPercent, winRatePercent: best.winRatePercent,
            maxDrawdownPercent: best.maxDrawdownPercent, profitFactor: best.profitFactor,
          } : undefined,
          tickerProgress,
          eta: estimateEta(startTime, globalCurrent, grandTotal),
        }});

        const actualIter = refineStartIteration + seedIdx * config.refinementsPerSeed + config.refinementsPerSeed;
        const refineKeepCount = Math.max(10, config.topK);
        const topPartial = [...comboResults].sort((a, b) => scoreResult(b) - scoreResult(a)).slice(0, refineKeepCount);
        send({ type: "partial-checkpoint", combo: key, stage: "refine", iteration: actualIter, results: topPartial, refineSeeds: refineSeedParams });
        lastCheckpointTime = Date.now();
        checkpointCount++;
      }
    }

    if (config.deepSearch && !aborted) {
      const deepRadii = [0.12, 0.08, 0.05];
      const numOptimizable = inputs.filter(i => i.optimizable && (i.type === "int" || i.type === "float")).length;
      let previousRoundBest: LabBacktestResult[] = [];
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
        comboResults.sort((a, b) => scoreResult(b) - scoreResult(a));

        let deepSeeds: LabBacktestResult[];
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
          const exploratory: LabBacktestResult[] = [];
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
            const er = runBacktest(candles, rp!, combo.ticker, combo.timeframe, engineConfig);
            if (meetsFilters(er, config)) {
              exploratory.push(er);
              comboResults.push(er);
            }
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
              const bdResult = runBacktest(candles, bd.params, combo.ticker, combo.timeframe, engineConfig);
              const existingSigs = new Set(deepSeeds.map(s => canonicalizeParams(s.params, inputs)));
              if (!existingSigs.has(bdSig)) {
                deepSeeds = [bdResult, ...deepSeeds.filter(s => canonicalizeParams(s.params, inputs) !== bdSig)].slice(0, deepSeedsPerRound);
              }
              comboResults.push(bdResult);
              testedSignatures.add(bdSig);
            }
          }
          injectedResumeBest = true;
        }

        const roundDiscoveries: LabBacktestResult[] = [];
        let comboBestScore = comboResults.length > 0
          ? Math.max(...comboResults.map(r => scoreResult(r)))
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

            const result = runBacktest(candles, jittered!, combo.ticker, combo.timeframe, engineConfig);
            if (meetsFilters(result, config)) {
              comboResults.push(result);
              roundDiscoveries.push(result);
              const resultScore = scoreResult(result);
              if (resultScore > comboBestScore + 1e-9) {
                comboBestScore = resultScore;
                send({ type: "best-discovery", combo: key, stage: "deep", deepRound: round, score: resultScore, params: { ...result.params } });
              }
            }
            globalCurrent++;
          }

          const best = comboResults.length > 0 ? comboResults.sort((a, b) => scoreResult(b) - scoreResult(a))[0] : null;
          send({ type: "progress", data: {
            jobId, status: "refinement",
            stage: `Deep R${round + 1} (${Math.round(radius * 100)}%) — seed ${seedIdx + 1}/${deepSeeds.length} — ${combo.ticker.split("/")[0]} ${combo.timeframe}`,
            current: Math.min(globalCurrent, grandTotal), total: grandTotal,
            percent: Math.min(99, Math.round((globalCurrent / grandTotal) * 100)),
            elapsed: Date.now() - startTime,
            bestSoFar: best ? {
              netProfitPercent: best.netProfitPercent, winRatePercent: best.winRatePercent,
              maxDrawdownPercent: best.maxDrawdownPercent, profitFactor: best.profitFactor,
            } : undefined,
            tickerProgress,
            eta: estimateEta(startTime, globalCurrent, grandTotal),
          }});

          const deepCheckpointCount = Math.max(10, config.topK);
          const topPartial = [...comboResults].sort((a, b) => scoreResult(b) - scoreResult(a)).slice(0, deepCheckpointCount);
          send({ type: "partial-checkpoint", combo: key, stage: "deep", iteration: totalSamples, deepRound: round, results: topPartial, refineSeeds: refineSeedParams });
          lastCheckpointTime = Date.now();
          checkpointCount++;
        }

        previousRoundBest = [...roundDiscoveries].sort((a, b) => scoreResult(b) - scoreResult(a)).slice(0, Math.max(10, deepSeedsPerRound));

        const deepCheckpointCount2 = Math.max(10, config.topK);
        const topAfterRound = [...comboResults].sort((a, b) => scoreResult(b) - scoreResult(a)).slice(0, deepCheckpointCount2);
        send({ type: "partial-checkpoint", combo: key, stage: "deep", iteration: totalSamples, deepRound: round + 1, results: topAfterRound, refineSeeds: refineSeedParams });
        lastCheckpointTime = Date.now();
      }
    }

    comboResults.sort((a, b) => scoreResult(b) - scoreResult(a));
    const topForCombo = comboResults.slice(0, 10);
    allResults.push(...topForCombo);

    tickerProgress[key] = { status: "complete", best: topForCombo[0]?.netProfitPercent ?? 0 };
    completedCombos.add(key);
    send({ type: "combo-complete", combo: key, results: topForCombo });
  }

  allResults.sort((a, b) => scoreResult(b) - scoreResult(a));

  const finalTotal = config.coordinateTune ? coordinateTotalTests : grandTotal;
  send({ type: "progress", data: {
    jobId, status: "complete", stage: "Optimization complete",
    current: finalTotal, total: finalTotal,
    percent: 100, elapsed: Date.now() - startTime,
    bestSoFar: allResults[0] ? {
      netProfitPercent: allResults[0].netProfitPercent, winRatePercent: allResults[0].winRatePercent,
      maxDrawdownPercent: allResults[0].maxDrawdownPercent, profitFactor: allResults[0].profitFactor,
    } : undefined,
    tickerProgress,
  }});

  send({ type: "done", results: allResults, totalConfigsTested: config.coordinateTune ? coordinateTotalTests : undefined });
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
