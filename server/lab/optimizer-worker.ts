import { workerData, parentPort } from "worker_threads";
import { runBacktest, type OHLCV } from "./engine";
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
    parsedInputs: LabPineInput[];
    guidedInsights?: GuidedInsights;
    guidedInsightsPerCombo?: Record<string, GuidedInsights>;
  };
  candlesByCombo: Record<string, OHLCV[]>;
  resumeCheckpoint?: LabCheckpoint;
}

type WorkerMessage =
  | { type: "progress"; data: LabJobProgress }
  | { type: "partial-checkpoint"; combo: string; stage: "random" | "refine"; iteration: number; results: LabBacktestResult[] }
  | { type: "combo-complete"; combo: string; results: LabBacktestResult[] }
  | { type: "done"; results: LabBacktestResult[] }
  | { type: "error"; message: string };

function send(msg: WorkerMessage) {
  parentPort?.postMessage(msg);
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

function generateGuidedParams(inputs: LabPineInput[], insights: GuidedInsights): Record<string, any> {
  const params: Record<string, any> = {};
  const sensitivityMap = new Map(insights.paramSensitivity.map(ps => [ps.name, ps]));
  const impactScores = insights.paramSensitivity.map(ps => ps.impactScore);
  const medianImpact = impactScores.length > 0
    ? impactScores.sort((a, b) => a - b)[Math.floor(impactScores.length / 2)]
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

function jitterParams(baseParams: Record<string, any>, inputs: LabPineInput[], jitterCount: number = 4): Record<string, any> {
  const params = { ...baseParams };
  const optimizable = inputs.filter(i => i.optimizable && (i.type === "int" || i.type === "float"));
  const toJitter = optimizable.sort(() => Math.random() - 0.5).slice(0, jitterCount);

  for (const input of toJitter) {
    const min = input.min ?? 0;
    const max = input.max ?? 100;
    const range = max - min;
    const jitterAmount = range * 0.15;

    if (input.type === "int") {
      const step = input.step ?? 1;
      const currentVal = params[input.name] ?? input.default;
      const newVal = currentVal + (Math.random() - 0.5) * 2 * jitterAmount;
      params[input.name] = Math.max(min, Math.min(max, Math.round(newVal / step) * step));
    } else {
      const step = input.step ?? 0.1;
      const currentVal = params[input.name] ?? input.default;
      const newVal = currentVal + (Math.random() - 0.5) * 2 * jitterAmount;
      params[input.name] = Math.max(min, Math.min(max, Math.round(newVal / step) * step));
      params[input.name] = Math.round(params[input.name] * 10000) / 10000;
    }
  }

  const boolInputs = inputs.filter(i => i.optimizable && i.type === "bool");
  if (boolInputs.length > 0 && Math.random() < 0.2) {
    const toBool = boolInputs[Math.floor(Math.random() * boolInputs.length)];
    params[toBool.name] = !params[toBool.name];
  }

  return params;
}

function scoreResult(r: LabBacktestResult): number {
  return r.netProfitPercent * 1000 + r.winRatePercent * 10 - r.maxDrawdownPercent * 5;
}

function estimateEta(startTime: number, current: number, total: number): number {
  if (current === 0) return 0;
  const elapsed = Date.now() - startTime;
  const rate = current / elapsed;
  return Math.round((total - current) / rate);
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
  const inputs = config.parsedInputs;

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
  const resumePartialResults = resumeCheckpoint?.partialResults ?? [];

  const tickerProgress: Record<string, { status: "pending" | "running" | "complete"; best?: number }> = {};
  for (const combo of combos) {
    const key = `${combo.ticker}|${combo.timeframe}`;
    tickerProgress[key] = completedCombos.has(key) ? { status: "complete" } : { status: "pending" };
  }

  const totalSamples = config.randomSamples + config.topK * config.refinementsPerSeed;
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
        current: globalCurrent, total: totalSamples * combos.length,
        percent: Math.round((globalCurrent / (totalSamples * combos.length)) * 100),
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

    const defaultParams: Record<string, any> = {};
    for (const input of inputs) {
      defaultParams[input.name] = input.default;
    }
    const baseline = runBacktest(candles, defaultParams, combo.ticker, combo.timeframe);

    const isResumingThisCombo = resumeCombo === key;
    const skipRandomUntil = isResumingThisCombo && resumeStage === "random" ? resumeIteration : 0;
    const skipRefineEntirely = isResumingThisCombo && resumeStage === "refine";
    let comboResults: LabBacktestResult[] = isResumingThisCombo && resumePartialResults.length > 0
      ? [...resumePartialResults]
      : [baseline];

    const randomStart = skipRefineEntirely ? config.randomSamples : skipRandomUntil;

    let lastCheckpointTime = Date.now();
    const CHECKPOINT_INTERVAL_MS = 60_000;

    const comboKey = `${combo.ticker}|${combo.timeframe}`;
    const comboInsights = config.guidedInsightsPerCombo?.[comboKey] ?? config.guidedInsights;
    const hasGuided = !!comboInsights && comboInsights.paramSensitivity.length > 0;

    for (let s = randomStart; s < config.randomSamples; s++) {
      if (aborted) { globalCurrent += (config.randomSamples - s); break; }
      const useGuided = hasGuided && Math.random() < 0.8;
      const params = useGuided
        ? generateGuidedParams(inputs, comboInsights!)
        : generateRandomParams(inputs);
      const result = runBacktest(candles, params, combo.ticker, combo.timeframe);
      if (result.totalTrades >= config.minTrades && result.maxDrawdownPercent <= config.maxDrawdownCap) {
        comboResults.push(result);
      }
      globalCurrent++;

      if (s % 10 === 0) {
        const best = comboResults.length > 0 ? comboResults.sort((a, b) => scoreResult(b) - scoreResult(a))[0] : null;
        send({ type: "progress", data: {
          jobId, status: "random_search",
          stage: `${hasGuided ? "Guided" : "Random"} Search — ${combo.ticker.split("/")[0]} ${combo.timeframe} — ${s}/${config.randomSamples}`,
          current: globalCurrent, total: totalSamples * combos.length,
          percent: Math.round((globalCurrent / (totalSamples * combos.length)) * 100),
          elapsed: Date.now() - startTime,
          bestSoFar: best ? {
            netProfitPercent: best.netProfitPercent, winRatePercent: best.winRatePercent,
            maxDrawdownPercent: best.maxDrawdownPercent, profitFactor: best.profitFactor,
          } : undefined,
          tickerProgress,
          eta: estimateEta(startTime, globalCurrent, totalSamples * combos.length),
        }});
      }

      const now = Date.now();
      if (now - lastCheckpointTime >= CHECKPOINT_INTERVAL_MS) {
        lastCheckpointTime = now;
        const topPartial = [...comboResults].sort((a, b) => scoreResult(b) - scoreResult(a)).slice(0, 10);
        send({ type: "partial-checkpoint", combo: key, stage: "random", iteration: s + 1, results: topPartial });
      }
    }

    if (aborted) continue;

    comboResults.sort((a, b) => scoreResult(b) - scoreResult(a));
    const topSeeds = comboResults.slice(0, config.topK);

    const refineStartIteration = config.randomSamples;

    for (let seedIdx = 0; seedIdx < topSeeds.length; seedIdx++) {
      if (aborted) break;
      const seed = topSeeds[seedIdx];
      for (let r = 0; r < config.refinementsPerSeed; r++) {
        if (aborted) { globalCurrent += (config.refinementsPerSeed - r); break; }

        const currentRefineIter = refineStartIteration + seedIdx * config.refinementsPerSeed + r;
        if (isResumingThisCombo && resumeStage === "refine" && currentRefineIter < resumeIteration) {
          globalCurrent++;
          continue;
        }

        const jitteredParams = jitterParams(seed.params, inputs);
        const result = runBacktest(candles, jitteredParams, combo.ticker, combo.timeframe);
        if (result.totalTrades >= config.minTrades && result.maxDrawdownPercent <= config.maxDrawdownCap) {
          comboResults.push(result);
        }
        globalCurrent++;
      }

      const best = comboResults.length > 0 ? comboResults.sort((a, b) => scoreResult(b) - scoreResult(a))[0] : null;
      send({ type: "progress", data: {
        jobId, status: "refinement",
        stage: `Refining seed ${seedIdx + 1}/${topSeeds.length} — ${combo.ticker.split("/")[0]} ${combo.timeframe}`,
        current: globalCurrent, total: totalSamples * combos.length,
        percent: Math.round((globalCurrent / (totalSamples * combos.length)) * 100),
        elapsed: Date.now() - startTime,
        bestSoFar: best ? {
          netProfitPercent: best.netProfitPercent, winRatePercent: best.winRatePercent,
          maxDrawdownPercent: best.maxDrawdownPercent, profitFactor: best.profitFactor,
        } : undefined,
        tickerProgress,
        eta: estimateEta(startTime, globalCurrent, totalSamples * combos.length),
      }});

      const refNow = Date.now();
      if (refNow - lastCheckpointTime >= CHECKPOINT_INTERVAL_MS) {
        lastCheckpointTime = refNow;
        const actualIter = refineStartIteration + seedIdx * config.refinementsPerSeed + config.refinementsPerSeed;
        const topPartial = [...comboResults].sort((a, b) => scoreResult(b) - scoreResult(a)).slice(0, 10);
        send({ type: "partial-checkpoint", combo: key, stage: "refine", iteration: actualIter, results: topPartial });
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

  send({ type: "progress", data: {
    jobId, status: "complete", stage: "Optimization complete",
    current: totalSamples * combos.length, total: totalSamples * combos.length,
    percent: 100, elapsed: Date.now() - startTime,
    bestSoFar: allResults[0] ? {
      netProfitPercent: allResults[0].netProfitPercent, winRatePercent: allResults[0].winRatePercent,
      maxDrawdownPercent: allResults[0].maxDrawdownPercent, profitFactor: allResults[0].profitFactor,
    } : undefined,
    tickerProgress,
  }});

  send({ type: "done", results: allResults });
}

run().catch((err: any) => {
  send({ type: "error", message: err.message || String(err) });
});
