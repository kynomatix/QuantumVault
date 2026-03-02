import type { LabPineInput, LabBacktestResult, LabOptimizationConfig, LabJobProgress, LabCheckpoint } from "@shared/schema";
import { runBacktest, type OHLCV } from "./engine";
import { fetchOHLCV } from "./datafeed";

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

export interface OptimizationCallbacks {
  onProgress: (progress: LabJobProgress) => void;
  onComboCheckpoint: (completedCombo: string, comboResults: LabBacktestResult[]) => Promise<void>;
  onPartialCheckpoint?: (combo: string, stage: "random" | "refine", iteration: number, partialResults: LabBacktestResult[]) => Promise<void>;
}

export async function runOptimization(
  config: LabOptimizationConfig,
  onProgress: (progress: LabJobProgress) => void,
  jobId: string,
  abortSignal?: { aborted: boolean },
  callbacks?: OptimizationCallbacks,
  resumeCheckpoint?: LabCheckpoint
): Promise<LabBacktestResult[]> {
  const startTime = Date.now();
  const allResults: LabBacktestResult[] = [];
  const inputs = config.parsedInputs;
  const effectiveOnProgress = callbacks?.onProgress ?? onProgress;

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

  if (completedCombos.size > 0 || resumeCombo) {
    console.log(`[QuantumLab] Resuming optimization: ${completedCombos.size}/${combos.length} combos done${resumeCombo ? `, mid-combo ${resumeCombo} at ${resumeStage} iter ${resumeIteration}` : ""}`);
  }

  for (const combo of combos) {
    const key = `${combo.ticker}|${combo.timeframe}`;

    if (completedCombos.has(key)) {
      continue;
    }

    if (abortSignal?.aborted) {
      effectiveOnProgress({
        jobId, status: "error", stage: "Cancelled by user",
        current: globalCurrent, total: totalSamples * combos.length,
        percent: Math.round((globalCurrent / (totalSamples * combos.length)) * 100),
        elapsed: Date.now() - startTime, tickerProgress, error: "Cancelled",
      });
      return allResults;
    }
    tickerProgress[key] = { status: "running" };

    effectiveOnProgress({
      jobId,
      status: "fetching",
      stage: `Fetching data for ${combo.ticker.split("/")[0]} ${combo.timeframe}`,
      current: globalCurrent,
      total: totalSamples * combos.length,
      percent: Math.round((globalCurrent / (totalSamples * combos.length)) * 100),
      elapsed: Date.now() - startTime,
      tickerProgress,
    });

    let candles: OHLCV[];
    try {
      candles = await fetchOHLCV(
        combo.ticker,
        combo.timeframe,
        config.startDate,
        config.endDate,
        (msg: string) => effectiveOnProgress({
          jobId,
          status: "fetching",
          stage: msg,
          current: globalCurrent,
          total: totalSamples * combos.length,
          percent: Math.round((globalCurrent / (totalSamples * combos.length)) * 100),
          elapsed: Date.now() - startTime,
          tickerProgress,
        })
      );
    } catch (err: any) {
      console.log(`Failed to fetch data for ${combo.ticker}: ${err.message}`);
      tickerProgress[key] = { status: "complete", best: 0 };
      completedCombos.add(key);
      if (callbacks?.onComboCheckpoint) {
        await callbacks.onComboCheckpoint(key, []).catch(e => console.log(`[QuantumLab] Checkpoint save error: ${e.message}`));
      }
      continue;
    }

    if (candles.length < 100) {
      console.log(`Not enough candles for ${combo.ticker} ${combo.timeframe}: ${candles.length}`);
      tickerProgress[key] = { status: "complete", best: 0 };
      completedCombos.add(key);
      if (callbacks?.onComboCheckpoint) {
        await callbacks.onComboCheckpoint(key, []).catch(e => console.log(`[QuantumLab] Checkpoint save error: ${e.message}`));
      }
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

    if (isResumingThisCombo) {
      console.log(`[QuantumLab] Resuming combo ${key}: skip ${skipRandomUntil} random samples, ${comboResults.length} partial results loaded`);
    }

    effectiveOnProgress({
      jobId,
      status: "random_search",
      stage: `Random Search — ${combo.ticker.split("/")[0]} ${combo.timeframe} — ${skipRandomUntil}/${config.randomSamples}`,
      current: globalCurrent,
      total: totalSamples * combos.length,
      percent: Math.round((globalCurrent / (totalSamples * combos.length)) * 100),
      elapsed: Date.now() - startTime,
      bestSoFar: {
        netProfitPercent: baseline.netProfitPercent,
        winRatePercent: baseline.winRatePercent,
        maxDrawdownPercent: baseline.maxDrawdownPercent,
        profitFactor: baseline.profitFactor,
      },
      tickerProgress,
    });

    const randomStart = skipRefineEntirely ? config.randomSamples : skipRandomUntil;

    for (let s = randomStart; s < config.randomSamples; s++) {
      if (abortSignal?.aborted) { globalCurrent += (config.randomSamples - s); break; }
      const params = generateRandomParams(inputs);
      const result = runBacktest(candles, params, combo.ticker, combo.timeframe);
      if (result.totalTrades >= config.minTrades && result.maxDrawdownPercent <= config.maxDrawdownCap) {
        comboResults.push(result);
      }
      globalCurrent++;

      if (s % 3 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }

      if (s % 10 === 0) {
        const best = comboResults.length > 0 ? comboResults.sort((a, b) => scoreResult(b) - scoreResult(a))[0] : null;
        effectiveOnProgress({
          jobId,
          status: "random_search",
          stage: `Random Search — ${combo.ticker.split("/")[0]} ${combo.timeframe} — ${s}/${config.randomSamples}`,
          current: globalCurrent,
          total: totalSamples * combos.length,
          percent: Math.round((globalCurrent / (totalSamples * combos.length)) * 100),
          elapsed: Date.now() - startTime,
          bestSoFar: best ? {
            netProfitPercent: best.netProfitPercent,
            winRatePercent: best.winRatePercent,
            maxDrawdownPercent: best.maxDrawdownPercent,
            profitFactor: best.profitFactor,
          } : undefined,
          tickerProgress,
          eta: estimateEta(startTime, globalCurrent, totalSamples * combos.length),
        });
      }

      if (s % 25 === 0 && s > 0 && callbacks?.onPartialCheckpoint) {
        const topPartial = [...comboResults].sort((a, b) => scoreResult(b) - scoreResult(a)).slice(0, 10);
        await callbacks.onPartialCheckpoint(key, "random", s + 1, topPartial).catch(e =>
          console.log(`[QuantumLab] Partial checkpoint error: ${e.message}`)
        );
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    if (abortSignal?.aborted) continue;

    comboResults.sort((a, b) => scoreResult(b) - scoreResult(a));
    const topSeeds = comboResults.slice(0, config.topK);

    effectiveOnProgress({
      jobId,
      status: "refinement",
      stage: `Refining top ${topSeeds.length} seeds — ${combo.ticker.split("/")[0]} ${combo.timeframe}`,
      current: globalCurrent,
      total: totalSamples * combos.length,
      percent: Math.round((globalCurrent / (totalSamples * combos.length)) * 100),
      elapsed: Date.now() - startTime,
      tickerProgress,
    });

    const refineStartIteration = config.randomSamples;

    for (let seedIdx = 0; seedIdx < topSeeds.length; seedIdx++) {
      if (abortSignal?.aborted) break;
      const seed = topSeeds[seedIdx];
      for (let r = 0; r < config.refinementsPerSeed; r++) {
        if (abortSignal?.aborted) { globalCurrent += (config.refinementsPerSeed - r); break; }

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
        if (r % 3 === 0) {
          await new Promise(resolve => setImmediate(resolve));
        }
      }

      const best = comboResults.length > 0 ? comboResults.sort((a, b) => scoreResult(b) - scoreResult(a))[0] : null;
      effectiveOnProgress({
        jobId,
        status: "refinement",
        stage: `Refining seed ${seedIdx + 1}/${topSeeds.length} — ${combo.ticker.split("/")[0]} ${combo.timeframe}`,
        current: globalCurrent,
        total: totalSamples * combos.length,
        percent: Math.round((globalCurrent / (totalSamples * combos.length)) * 100),
        elapsed: Date.now() - startTime,
        bestSoFar: best ? {
          netProfitPercent: best.netProfitPercent,
          winRatePercent: best.winRatePercent,
          maxDrawdownPercent: best.maxDrawdownPercent,
          profitFactor: best.profitFactor,
        } : undefined,
        tickerProgress,
        eta: estimateEta(startTime, globalCurrent, totalSamples * combos.length),
      });

      if (seedIdx % 3 === 0 && callbacks?.onPartialCheckpoint) {
        const actualIter = refineStartIteration + seedIdx * config.refinementsPerSeed + config.refinementsPerSeed;
        const topPartial = [...comboResults].sort((a, b) => scoreResult(b) - scoreResult(a)).slice(0, 10);
        await callbacks.onPartialCheckpoint(key, "refine", actualIter, topPartial).catch(e =>
          console.log(`[QuantumLab] Partial checkpoint error: ${e.message}`)
        );
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    comboResults.sort((a, b) => scoreResult(b) - scoreResult(a));
    const topForCombo = comboResults.slice(0, 10);
    allResults.push(...topForCombo);

    tickerProgress[key] = {
      status: "complete",
      best: topForCombo[0]?.netProfitPercent ?? 0,
    };

    completedCombos.add(key);
    if (callbacks?.onComboCheckpoint) {
      await callbacks.onComboCheckpoint(key, topForCombo).catch(e => console.log(`[QuantumLab] Checkpoint save error: ${e.message}`));
    }
  }

  allResults.sort((a, b) => scoreResult(b) - scoreResult(a));

  effectiveOnProgress({
    jobId,
    status: "complete",
    stage: "Optimization complete",
    current: totalSamples * combos.length,
    total: totalSamples * combos.length,
    percent: 100,
    elapsed: Date.now() - startTime,
    bestSoFar: allResults[0] ? {
      netProfitPercent: allResults[0].netProfitPercent,
      winRatePercent: allResults[0].winRatePercent,
      maxDrawdownPercent: allResults[0].maxDrawdownPercent,
      profitFactor: allResults[0].profitFactor,
    } : undefined,
    tickerProgress,
  });

  return allResults;
}

function estimateEta(startTime: number, current: number, total: number): number {
  if (current === 0) return 0;
  const elapsed = Date.now() - startTime;
  const rate = current / elapsed;
  return Math.round((total - current) / rate);
}
