import type { LabTradeRecord, LabBacktestResult } from "@shared/schema";
import * as ind from "./indicators";
import type { OHLCV, EngineConfig } from "./engine";

function p(params: Record<string, any>, name: string, defaultVal: any): any {
  return params[name] !== undefined ? params[name] : defaultVal;
}

function stochastic(close: number[], length: number): number[] {
  const n = close.length;
  const result = new Array(n).fill(NaN);
  for (let i = length - 1; i < n; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - length + 1; j <= i; j++) {
      if (close[j] > hi) hi = close[j];
      if (close[j] < lo) lo = close[j];
    }
    result[i] = hi !== lo ? ((close[i] - lo) / (hi - lo)) * 100 : 50;
  }
  return result;
}

function roc(data: number[], period: number): number[] {
  const n = data.length;
  const result = new Array(n).fill(NaN);
  for (let i = period; i < n; i++) {
    result[i] = data[i - period] !== 0 ? ((data[i] - data[i - period]) / data[i - period]) * 100 : 0;
  }
  return result;
}

function dmi(high: number[], low: number[], close: number[], period: number): { diPlus: number[]; diMinus: number[]; adx: number[] } {
  const n = high.length;
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const upMove = high[i] - high[i - 1];
    const downMove = low[i - 1] - low[i];
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }
  const atrVals = ind.atr(high, low, close, period);
  const smoothPlus = ind.rma(plusDM, period);
  const smoothMinus = ind.rma(minusDM, period);

  const diPlus = new Array(n).fill(NaN);
  const diMinus = new Array(n).fill(NaN);
  const dx = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    if (isNaN(atrVals[i]) || atrVals[i] === 0 || isNaN(smoothPlus[i])) continue;
    diPlus[i] = (smoothPlus[i] / atrVals[i]) * 100;
    diMinus[i] = (smoothMinus[i] / atrVals[i]) * 100;
    const sum = diPlus[i] + diMinus[i];
    dx[i] = sum === 0 ? 0 : (Math.abs(diPlus[i] - diMinus[i]) / sum) * 100;
  }

  const adx = ind.rma(dx, period);
  return { diPlus, diMinus, adx };
}

export function runAdaptiveRegimeBacktest(
  candles: OHLCV[],
  params: Record<string, any>,
  ticker: string,
  timeframe: string,
  config: EngineConfig,
): LabBacktestResult {
  const n = candles.length;
  if (n < 60) {
    return {
      ticker, timeframe, netProfitPercent: 0, winRatePercent: 0,
      maxDrawdownPercent: 0, profitFactor: 0, totalTrades: 0,
      params, trades: [], equityCurve: [],
    };
  }

  const open = new Array(n);
  const close = new Array(n);
  const high = new Array(n);
  const low = new Array(n);
  const hl2 = new Array(n);
  for (let i = 0; i < n; i++) {
    open[i] = candles[i].open;
    close[i] = candles[i].close;
    high[i] = candles[i].high;
    low[i] = candles[i].low;
    hl2[i] = (candles[i].high + candles[i].low) / 2;
  }

  const entryMode: string = p(params, "entry_mode", "Ribbon + ST");
  const ribbonEmaFast = p(params, "ribbon_ema_fast", 8);
  const ribbonEmaMid = p(params, "ribbon_ema_mid", 21);
  const ribbonEmaSlow = p(params, "ribbon_ema_slow", 55);
  const requireRibbonFlip = p(params, "require_ribbon_flip", true);
  const usePullbackEntry = p(params, "use_pullback_entry", false);

  const stAtrLength = p(params, "st_atr_length", 10);
  const stMultiplierManual = p(params, "st_multiplier", 3.0);
  const usePresetSt = p(params, "use_preset_st", true);
  const presetChoice: string = p(params, "preset_choice", "Small Cap / Degen");

  function getPresetStMult(preset: string): number {
    switch (preset) {
      case "Large Cap (BTC/ETH)": return 2.5;
      case "Mid Cap": return 2.8;
      case "Small Cap / Degen": return 3.0;
      case "Extreme Vol / Memecoin": return 3.5;
      default: return 3.0;
    }
  }
  const stMultiplier = usePresetSt ? getPresetStMult(presetChoice) : stMultiplierManual;

  const useStopLoss = p(params, "use_stop_loss", true);
  const stopType: string = p(params, "stop_type", "ATR");
  const stopAtrMult = p(params, "stop_atr_mult", 3.0);
  const stopPercent = p(params, "stop_percent", 5.0);

  const useTrailStop = p(params, "use_trail_stop", true);
  const trailType: string = p(params, "trail_type", "ATR");
  const trailAtrMult = p(params, "trail_atr_mult", 3.5);
  const trailPercent = p(params, "trail_percent", 4.0);

  const useTakeProfit = p(params, "use_take_profit", false);
  const tpType: string = p(params, "tp_type", "ATR");
  const tpAtrMult = p(params, "tp_atr_mult", 6.0);
  const tpPercent = p(params, "tp_percent", 10.0);
  const tpRrRatio = p(params, "tp_rr_ratio", 2.0);

  const exitOnRibbonFlip = p(params, "exit_on_ribbon_flip", false);
  const exitModeRaw: string = p(params, "exit_mode", "");
  const exitOnStFlip = exitModeRaw === "ST Flip" || p(params, "exit_on_st_flip", false);
  const flipOnSignal = p(params, "flip_on_signal", true);

  const pyramidAtrDistance = p(params, "pyramid_atr_distance", 3.0);
  const usePyramiding = p(params, "use_pyramiding", true);
  const PYRAMID_MAX = usePyramiding ? p(params, "pyramid_max", 3) : 1;

  const showCandlePatterns = p(params, "show_candle_patterns", true);
  const useCandleForRange = p(params, "use_candle_for_range", false);
  const candleTrendLen = p(params, "candle_trend_len", 14);
  const candleThreshold = p(params, "candle_threshold", 80);
  const showHammer = p(params, "show_hammer", true);
  const showEngulfing = p(params, "show_engulfing", true);
  const showStar = p(params, "show_star", true);
  const showHarami = p(params, "show_harami", true);
  const showSoldiers = p(params, "show_soldiers", true);
  const showTweezer = p(params, "show_tweezer", true);

  const showExhaustion = p(params, "show_exhaustion", true);
  const exhaustMinScore = p(params, "exhaust_min_score", 3);
  const showOnlyExtreme = p(params, "show_only_extreme", false);
  const useExhaustConfirm = p(params, "use_exhaust_confirm", false);
  const exhaustMaLen = p(params, "exhaust_ma_len", 200);

  const showCvi = p(params, "show_cvi", true);
  const cviLength = p(params, "cvi_length", 3);
  const cviBullThreshold = p(params, "cvi_bull_threshold", -0.51);
  const cviBearThreshold = p(params, "cvi_bear_threshold", 0.43);
  const useCviForRange = p(params, "use_cvi_for_range", false);

  const enableRangeTrading = p(params, "enable_range_trading", false);
  const rangeMode: string = p(params, "range_mode", "BB Bounce");
  const bbLength = p(params, "bb_length", 20);
  const bbMult = p(params, "bb_mult", 2.0);
  const rangeRsiLength = p(params, "range_rsi_length", 14);
  const rangeRsiOb = p(params, "range_rsi_ob", 70);
  const rangeRsiOs = p(params, "range_rsi_os", 30);

  const useVolFilter = p(params, "use_vol_filter", true);
  const volFilterMult = p(params, "vol_filter_mult", 3.5);
  const volFilterBars = p(params, "vol_filter_bars", 2);
  const tradeDirection: string = p(params, "trade_direction", "Both");
  const allowLong = tradeDirection !== "Short Only";
  const allowShort = tradeDirection !== "Long Only";

  const emaFast = ind.ema(close, ribbonEmaFast);
  const emaMid = ind.ema(close, ribbonEmaMid);
  const emaSlow = ind.ema(close, ribbonEmaSlow);

  const stAtr = ind.atr(high, low, close, stAtrLength);

  const riskAtr = ind.atr(high, low, close, 14);

  const ma200 = ind.ema(close, exhaustMaLen);
  const maDistArr = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!isNaN(ma200[i]) && ma200[i] !== 0) maDistArr[i] = ((close[i] - ma200[i]) / ma200[i]) * 100;
  }
  const maDistStdArr = ind.stdev(maDistArr, 100);

  const rsiEx = ind.rsi(close, 14);

  const keltMa = ind.ema(close, 20);
  const keltAtr = ind.atr(high, low, close, 20);

  const dmiVals = dmi(high, low, close, 14);

  const rocEx = roc(close, 10);
  const absRoc = new Array(n);
  for (let i = 0; i < n; i++) absRoc[i] = isNaN(rocEx[i]) ? NaN : Math.abs(rocEx[i]);
  const rocAvg = ind.sma(absRoc, 50);

  const bbExBasis = ind.sma(close, 20);
  const bbExDev = ind.stdev(close, 20);

  const wrVals = ind.percentRank(close, 14);

  const lwma8 = ind.wma(close, 8);

  const cviSmaHl2 = ind.sma(hl2, cviLength);
  const cviAtrRaw = ind.atr(high, low, close, cviLength);
  const cviVol = ind.sma(cviAtrRaw, cviLength);

  const rangeBb = ind.bollingerBands(close, bbLength, bbMult);
  const rangeRsi = ind.rsi(close, rangeRsiLength);

  const stochK = stochastic(close, candleTrendLen);

  const currentAtr = riskAtr;
  const avgAtr = ind.sma(currentAtr, 50);

  const warmup = Math.max(
    ribbonEmaSlow, stAtrLength, exhaustMaLen + 100, 14 * 2 + 1,
    candleTrendLen, bbLength, rangeRsiLength, cviLength * 2, 60
  ) + 5;

  const ribbonBull = new Array(n).fill(false);
  const ribbonBear = new Array(n).fill(false);
  const ribbonFlipBull = new Array(n).fill(false);
  const ribbonFlipBear = new Array(n).fill(false);

  for (let i = 0; i < n; i++) {
    if (isNaN(emaFast[i]) || isNaN(emaMid[i]) || isNaN(emaSlow[i])) continue;
    ribbonBull[i] = emaFast[i] > emaMid[i] && emaMid[i] > emaSlow[i];
    ribbonBear[i] = emaFast[i] < emaMid[i] && emaMid[i] < emaSlow[i];
    if (i > 0) {
      ribbonFlipBull[i] = ribbonBull[i] && !ribbonBull[i - 1];
      ribbonFlipBear[i] = ribbonBear[i] && !ribbonBear[i - 1];
    }
  }

  const stUpF = new Array(n).fill(NaN);
  const stDnF = new Array(n).fill(NaN);
  const stDir = new Array(n).fill(1);
  const supertrend = new Array(n).fill(NaN);
  const stBull = new Array(n).fill(false);
  const stFlipLong = new Array(n).fill(false);
  const stFlipShort = new Array(n).fill(false);

  for (let i = 0; i < n; i++) {
    if (isNaN(stAtr[i])) continue;
    const stUp = hl2[i] - stMultiplier * stAtr[i];
    const stDn = hl2[i] + stMultiplier * stAtr[i];

    if (i === 0 || isNaN(stUpF[i - 1])) {
      stUpF[i] = stUp;
      stDnF[i] = stDn;
      stDir[i] = 1;
    } else {
      stUpF[i] = close[i - 1] > stUpF[i - 1] ? Math.max(stUp, stUpF[i - 1]) : stUp;
      stDnF[i] = close[i - 1] < stDnF[i - 1] ? Math.min(stDn, stDnF[i - 1]) : stDn;
      stDir[i] = close[i] > stDnF[i - 1] ? 1 : close[i] < stUpF[i - 1] ? -1 : stDir[i - 1];
    }

    supertrend[i] = stDir[i] === 1 ? stUpF[i] : stDnF[i];
    stBull[i] = stDir[i] === 1;

    if (i > 0) {
      stFlipLong[i] = stBull[i] && !stBull[i - 1];
      stFlipShort[i] = !stBull[i] && stBull[i - 1];
    }
  }

  const smoothK = new Array(n).fill(0);
  const alpha = 2.0 / (20.0 + 1.0);
  for (let i = 0; i < n; i++) {
    const k = isNaN(stochK[i]) ? 50 : stochK[i];
    const prevSk = i > 0 ? smoothK[i - 1] : k;
    if (k > 50) {
      smoothK[i] = prevSk + (100 - prevSk) * alpha;
    } else if (k < 50) {
      smoothK[i] = prevSk + (0 - prevSk) * alpha;
    } else {
      smoothK[i] = k;
    }
  }

  const isUptrend = new Array(n).fill(false);
  const isDowntrend = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    const k = isNaN(stochK[i]) ? 50 : stochK[i];
    isUptrend[i] = k >= candleThreshold && smoothK[i] >= candleThreshold;
    isDowntrend[i] = k <= (100 - candleThreshold) && smoothK[i] <= (100 - candleThreshold);
  }

  const obCount = new Array(n).fill(0);
  const osCount = new Array(n).fill(0);
  const cviValue = new Array(n).fill(0);
  const cviOversold = new Array(n).fill(false);
  const cviOverbought = new Array(n).fill(false);
  const cviBullSignal = new Array(n).fill(false);
  const cviBearSignal = new Array(n).fill(false);

  for (let i = 0; i < n; i++) {
    let ob = 0, os = 0;

    const mdz = (!isNaN(maDistArr[i]) && !isNaN(maDistStdArr[i]) && maDistStdArr[i] !== 0)
      ? maDistArr[i] / maDistStdArr[i] : 0;
    if (mdz > 2) ob++;
    if (mdz < -2) os++;

    if (!isNaN(rsiEx[i])) {
      if (rsiEx[i] > 70) ob++;
      if (rsiEx[i] < 30) os++;
    }

    if (!isNaN(keltMa[i]) && !isNaN(keltAtr[i])) {
      if (close[i] > keltMa[i] + 2.5 * keltAtr[i]) ob++;
      if (close[i] < keltMa[i] - 2.5 * keltAtr[i]) os++;
    }

    if (!isNaN(dmiVals.adx[i]) && dmiVals.adx[i] > 30) { ob++; os++; }

    if (!isNaN(rocEx[i]) && !isNaN(rocAvg[i]) && rocAvg[i] > 0) {
      if (rocEx[i] > rocAvg[i] * 2) ob++;
      if (rocEx[i] < -rocAvg[i] * 2) os++;
    }

    if (!isNaN(bbExBasis[i]) && !isNaN(bbExDev[i])) {
      const bbUpper = bbExBasis[i] + 2 * bbExDev[i];
      const bbLower = bbExBasis[i] - 2 * bbExDev[i];
      const bbPct = bbUpper !== bbLower ? (close[i] - bbLower) / (bbUpper - bbLower) : 0.5;
      if (bbPct > 1.0) ob++;
      if (bbPct < 0.0) os++;
    }

    if (!isNaN(wrVals[i])) {
      if (wrVals[i] > 95) ob++;
      if (wrVals[i] < 5) os++;
    }

    obCount[i] = ob;
    osCount[i] = os;

    if (!isNaN(cviVol[i]) && cviVol[i] !== 0 && !isNaN(cviSmaHl2[i])) {
      cviValue[i] = (close[i] - cviSmaHl2[i]) / (cviVol[i] * Math.sqrt(cviLength));
    }
    cviOversold[i] = cviValue[i] <= cviBullThreshold;
    cviOverbought[i] = cviValue[i] >= cviBearThreshold;
    if (i > 0) {
      cviBullSignal[i] = cviOversold[i - 1] && !cviOversold[i];
      cviBearSignal[i] = cviOverbought[i - 1] && !cviOverbought[i];
    }
  }

  const barsSinceExtreme = new Array(n).fill(999);
  for (let i = 0; i < n; i++) {
    const candleRange = high[i] - low[i];
    const isExtremeVol = !isNaN(avgAtr[i]) && candleRange > avgAtr[i] * volFilterMult;
    barsSinceExtreme[i] = isExtremeVol ? 0 : (i > 0 ? barsSinceExtreme[i - 1] + 1 : 999);
  }

  interface Position {
    direction: "long" | "short";
    entries: { price: number; bar: number }[];
    avgEntryPrice: number;
    stopLevel: number;
    tpLevel: number;
    trailLevel: number;
    isRangeTrade: boolean;
    pyramidCount: number;
    lastEntryPrice: number;
    entryBar: number;
    entryTimeIdx: number;
  }

  const trades: LabTradeRecord[] = [];
  const equityValues = new Array(n);
  let equity = config.initialCapital;
  let position: Position | null = null;

  for (let i = 0; i < n; i++) {
    if (i < warmup) {
      equityValues[i] = equity;
      continue;
    }

    const atrNow = isNaN(riskAtr[i]) ? close[i] * 0.02 : riskAtr[i];

    function calcStopDist(): number {
      switch (stopType) {
        case "ATR": return stopAtrMult * atrNow;
        case "Percent": return close[i] * (stopPercent / 100);
        default: return stopAtrMult * atrNow;
      }
    }

    function calcTpDist(stopDist: number): number {
      switch (tpType) {
        case "ATR": return tpAtrMult * atrNow;
        case "Percent": return close[i] * (tpPercent / 100);
        case "R:R": return stopDist * tpRrRatio;
        default: return tpAtrMult * atrNow;
      }
    }

    function calcTrailDist(): number {
      switch (trailType) {
        case "ATR": return trailAtrMult * atrNow;
        case "Percent": return close[i] * (trailPercent / 100);
        default: return trailAtrMult * atrNow;
      }
    }

    if (position) {
      const isLong = position.direction === "long";

      if (useTrailStop && !position.isRangeTrade) {
        const tDist = calcTrailDist();
        const potentialTrail = isLong ? close[i] - tDist : close[i] + tDist;
        if (position.trailLevel === 0) {
          position.trailLevel = potentialTrail;
        } else {
          position.trailLevel = isLong
            ? Math.max(position.trailLevel, potentialTrail)
            : Math.min(position.trailLevel, potentialTrail);
        }
      }

      let effectiveStop = NaN;
      if (useStopLoss && useTrailStop && position.trailLevel !== 0) {
        effectiveStop = isLong
          ? Math.max(position.stopLevel, position.trailLevel)
          : Math.min(position.stopLevel, position.trailLevel);
      } else if (useTrailStop && position.trailLevel !== 0) {
        effectiveStop = position.trailLevel;
      } else if (useStopLoss) {
        effectiveStop = position.stopLevel;
      }

      let exitReason = "";
      let exitPrice = close[i];

      if (!isNaN(effectiveStop)) {
        if (isLong && low[i] <= effectiveStop) { exitReason = "Stop"; exitPrice = Math.min(open[i], effectiveStop); }
        if (!isLong && high[i] >= effectiveStop) { exitReason = "Stop"; exitPrice = Math.max(open[i], effectiveStop); }
      }

      if (!exitReason && useTakeProfit && !isNaN(position.tpLevel)) {
        if (isLong && high[i] >= position.tpLevel) { exitReason = "TP"; exitPrice = Math.max(open[i], position.tpLevel); }
        if (!isLong && low[i] <= position.tpLevel) { exitReason = "TP"; exitPrice = Math.min(open[i], position.tpLevel); }
      }

      const ribbonLong = requireRibbonFlip ? ribbonFlipBull[i] : (ribbonBull[i] && i > 0 && !ribbonBull[i - 1]);
      const ribbonShort = requireRibbonFlip ? ribbonFlipBear[i] : (ribbonBear[i] && i > 0 && !ribbonBear[i - 1]);
      let entryLongRaw = false, entryShortRaw = false;
      switch (entryMode) {
        case "Ribbon Only": entryLongRaw = ribbonLong; entryShortRaw = ribbonShort; break;
        case "Ribbon + ST": entryLongRaw = ribbonLong && stBull[i]; entryShortRaw = ribbonShort && !stBull[i]; break;
        case "Full Regime": entryLongRaw = (ribbonLong && stBull[i]) || stFlipLong[i]; entryShortRaw = (ribbonShort && !stBull[i]) || stFlipShort[i]; break;
        case "ST Only": entryLongRaw = stFlipLong[i]; entryShortRaw = stFlipShort[i]; break;
      }

      if (!exitReason && flipOnSignal) {
        if (isLong && entryShortRaw && allowShort) exitReason = "Flip";
        if (!isLong && entryLongRaw && allowLong) exitReason = "Flip";
      }

      if (!exitReason && isLong) {
        if (exitOnRibbonFlip && ribbonFlipBear[i]) exitReason = "Ribbon";
        if (!exitReason && exitOnStFlip && stFlipShort[i]) exitReason = "ST Flip";
        if (!exitReason && position.isRangeTrade && !isNaN(rangeBb.basis[i]) && close[i] > rangeBb.basis[i]) exitReason = "Target";
      }

      if (!exitReason && !isLong) {
        if (exitOnRibbonFlip && ribbonFlipBull[i]) exitReason = "Ribbon";
        if (!exitReason && exitOnStFlip && stFlipLong[i]) exitReason = "ST Flip";
        if (!exitReason && position.isRangeTrade && !isNaN(rangeBb.basis[i]) && close[i] < rangeBb.basis[i]) exitReason = "Target";
      }

      if (exitReason) {
        const pnlPct = isLong
          ? ((exitPrice - position.avgEntryPrice) / position.avgEntryPrice) * 100
          : ((position.avgEntryPrice - exitPrice) / position.avgEntryPrice) * 100;
        const pnlDollar = position.pyramidCount * config.positionSize * (pnlPct / 100)
          - 2 * position.pyramidCount * config.positionSize * config.commission;
        equity += pnlDollar;
        trades.push({
          entryTime: new Date(candles[position.entryTimeIdx].time).toISOString(),
          exitTime: new Date(candles[i].time).toISOString(),
          direction: position.direction,
          entryPrice: position.avgEntryPrice,
          exitPrice,
          pnlPercent: Math.round(pnlPct * 100) / 100,
          pnlDollar: Math.round(pnlDollar * 100) / 100,
          exitReason,
          barsHeld: i - position.entryBar,
        });

        if (exitReason === "Flip") {
          const flipDir: "long" | "short" = isLong ? "short" : "long";
          const flipIsLong = flipDir === "long";
          const sDist = calcStopDist();
          const tDist = calcTpDist(sDist);
          position = {
            direction: flipDir,
            entries: [{ price: close[i], bar: i }],
            avgEntryPrice: close[i],
            stopLevel: flipIsLong ? close[i] - sDist : close[i] + sDist,
            tpLevel: useTakeProfit ? (flipIsLong ? close[i] + tDist : close[i] - tDist) : NaN,
            trailLevel: 0,
            isRangeTrade: false,
            pyramidCount: 1,
            lastEntryPrice: close[i],
            entryBar: i,
            entryTimeIdx: i,
          };
        } else {
          position = null;
        }
      } else {
        const pyramidDist = pyramidAtrDistance * atrNow;
        if (position.pyramidCount < PYRAMID_MAX) {
          if (isLong && ribbonBull[i] && close[i] > position.lastEntryPrice + pyramidDist) {
            position.pyramidCount++;
            position.entries.push({ price: close[i], bar: i });
            const totalPrice = position.entries.reduce((s, e) => s + e.price, 0);
            position.avgEntryPrice = totalPrice / position.entries.length;
            position.lastEntryPrice = close[i];
            if (useStopLoss) {
              position.stopLevel = Math.max(position.stopLevel, close[i] - calcStopDist());
            }
          }
          if (!isLong && ribbonBear[i] && close[i] < position.lastEntryPrice - pyramidDist) {
            position.pyramidCount++;
            position.entries.push({ price: close[i], bar: i });
            const totalPrice = position.entries.reduce((s, e) => s + e.price, 0);
            position.avgEntryPrice = totalPrice / position.entries.length;
            position.lastEntryPrice = close[i];
            if (useStopLoss) {
              position.stopLevel = Math.min(position.stopLevel, close[i] + calcStopDist());
            }
          }
        }
      }
    }

    if (!position && i > 0) {
      const volFilterOn = useVolFilter && barsSinceExtreme[i] < volFilterBars;

      const pullbackBull = ribbonBull[i] && low[i] <= emaMid[i] && close[i] > emaMid[i];
      const pullbackBear = ribbonBear[i] && high[i] >= emaMid[i] && close[i] < emaMid[i];

      const ribbonLong = usePullbackEntry ? pullbackBull
        : (requireRibbonFlip ? ribbonFlipBull[i] : (ribbonBull[i] && !ribbonBull[i - 1]));
      const ribbonShort = usePullbackEntry ? pullbackBear
        : (requireRibbonFlip ? ribbonFlipBear[i] : (ribbonBear[i] && !ribbonBear[i - 1]));

      let entryLongRaw = false, entryShortRaw = false;
      switch (entryMode) {
        case "Ribbon Only": entryLongRaw = ribbonLong; entryShortRaw = ribbonShort; break;
        case "Ribbon + ST": entryLongRaw = ribbonLong && stBull[i]; entryShortRaw = ribbonShort && !stBull[i]; break;
        case "Full Regime": entryLongRaw = (ribbonLong && stBull[i]) || stFlipLong[i]; entryShortRaw = (ribbonShort && !stBull[i]) || stFlipShort[i]; break;
        case "ST Only": entryLongRaw = stFlipLong[i]; entryShortRaw = stFlipShort[i]; break;
      }

      let rangeLongRaw = false, rangeShortRaw = false;
      if (enableRangeTrading) {
        const bbPos = (!isNaN(rangeBb.upper[i]) && !isNaN(rangeBb.lower[i]) && rangeBb.upper[i] !== rangeBb.lower[i])
          ? (close[i] - rangeBb.lower[i]) / (rangeBb.upper[i] - rangeBb.lower[i]) : 0.5;
        const bbLong = bbPos < 0.15 && !isNaN(rangeRsi[i]) && rangeRsi[i] < rangeRsiOs && close[i] > open[i];
        const bbShort = bbPos > 0.85 && !isNaN(rangeRsi[i]) && rangeRsi[i] > rangeRsiOb && close[i] < open[i];

        const exhaustBullTrade = osCount[i] >= exhaustMinScore;
        const exhaustBearTrade = obCount[i] >= exhaustMinScore;

        const cTop = Math.max(open[i], close[i]);
        const cBot = Math.min(open[i], close[i]);
        const hlWidth = high[i] - low[i];
        const bodWidth = cTop - cBot;
        const hwPer = hlWidth > 0 ? ((high[i] - cTop) / hlWidth) * 100 : 0;
        const lwPer = hlWidth > 0 ? ((cBot - low[i]) / hlWidth) * 100 : 0;
        const bPer = hlWidth > 0 ? (bodWidth / hlWidth) * 100 : 0;
        const gc = close[i] > open[i];
        const rc = close[i] < open[i];
        const doji = Math.abs(close[i] - open[i]) < hlWidth * 0.001;

        let anyBullPattern = false, anyBearPattern = false;
        if (showCandlePatterns && i >= 3) {
          const cTop1 = Math.max(open[i-1], close[i-1]);
          const cBot1 = Math.min(open[i-1], close[i-1]);
          const hlW1 = high[i-1] - low[i-1];
          const bodW1 = cTop1 - cBot1;
          const bPer1 = hlW1 > 0 ? (bodW1 / hlW1) * 100 : 0;
          const gc1 = close[i-1] > open[i-1];
          const rc1 = close[i-1] < open[i-1];
          const doji1 = Math.abs(close[i-1] - open[i-1]) < hlW1 * 0.001;

          const cTop2 = i >= 2 ? Math.max(open[i-2], close[i-2]) : 0;
          const cBot2 = i >= 2 ? Math.min(open[i-2], close[i-2]) : 0;
          const hlW2 = i >= 2 ? high[i-2] - low[i-2] : 0;
          const bodW2 = cTop2 - cBot2;
          const bPer2 = hlW2 > 0 ? (bodW2 / hlW2) * 100 : 0;
          const gc2 = i >= 2 && close[i-2] > open[i-2];
          const rc2 = i >= 2 && close[i-2] < open[i-2];

          const hammer = showHammer && lwPer > bPer * 2 && bPer < 50 && hwPer < 2 && !doji && isDowntrend[i];
          const invHammer = showHammer && hwPer > bPer * 2 && bPer < 50 && lwPer < 2 && !doji && isDowntrend[i];
          const bullEngulfing = showEngulfing && rc1 && gc && bodWidth > bodW1 / 2 && open[i] < close[i-1] && cTop > cTop1 && !doji1 && isDowntrend[i-1];
          const mStar = showStar && rc2 && bPer2 > 80 && bodW1 < bodW2 / 2 && gc && close[i] > (high[i-2] + low[i-2]) / 2 && isDowntrend[i-2];
          const bullHarami = showHarami && gc && high[i] <= cTop1 && low[i] >= cBot1 && rc1 && isDowntrend[i-1];
          const soldiers = showSoldiers && i >= 3 && gc2 && bPer2 > 70 && gc1 && bPer1 > 70 && cBot1 >= cBot2 && cBot1 <= cTop2 && close[i-1] > high[i-2] && gc && bPer > 70 && cBot >= cBot1 && cBot <= cTop1 && close[i] > high[i-1] && isDowntrend[i-3];
          const tweezerBtm = showTweezer && Math.abs(low[i] - low[i-1]) < hlWidth * 0.001 && gc && rc1 && isDowntrend[i-1];

          anyBullPattern = hammer || invHammer || bullEngulfing || mStar || bullHarami || soldiers || tweezerBtm;

          const hMan = showHammer && lwPer > bPer * 2 && bPer < 50 && hwPer < 2 && !doji && isUptrend[i];
          const sStar = showHammer && hwPer > bPer * 2 && bPer < 50 && lwPer < 2 && !doji && isUptrend[i];
          const bearEngulfing = showEngulfing && gc1 && rc && bodWidth > bodW1 / 2 && open[i] > close[i-1] && cBot < cBot1 && !doji1 && isUptrend[i-1];
          const eStar = showStar && gc2 && bPer2 > 80 && bodW1 < bodW2 / 2 && rc && close[i] < (high[i-2] + low[i-2]) / 2 && isUptrend[i-2];
          const bearHarami = showHarami && rc && high[i] <= cTop1 && low[i] >= cBot1 && gc1 && isUptrend[i-1];
          const crows = showSoldiers && i >= 3 && rc2 && bPer2 > 70 && rc1 && bPer1 > 70 && cTop1 <= cTop2 && cTop1 >= cBot2 && close[i-1] < low[i-2] && rc && bPer > 70 && cTop <= cTop1 && cTop >= cBot1 && close[i] < low[i-1] && isUptrend[i-3];
          const tweezerTop = showTweezer && Math.abs(high[i] - high[i-1]) < hlWidth * 0.001 && rc && gc1 && isUptrend[i-1];

          anyBearPattern = hMan || sStar || bearEngulfing || eStar || bearHarami || crows || tweezerTop;
        }

        switch (rangeMode) {
          case "BB Bounce": rangeLongRaw = bbLong; rangeShortRaw = bbShort; break;
          case "Exhaustion Signals": rangeLongRaw = exhaustBullTrade; rangeShortRaw = exhaustBearTrade; break;
          case "Candle Patterns": rangeLongRaw = anyBullPattern; rangeShortRaw = anyBearPattern; break;
          case "CVI Signals": rangeLongRaw = cviBullSignal[i]; rangeShortRaw = cviBearSignal[i]; break;
          case "Any Signal": rangeLongRaw = bbLong || exhaustBullTrade || anyBullPattern || cviBullSignal[i];
                              rangeShortRaw = bbShort || exhaustBearTrade || anyBearPattern || cviBearSignal[i]; break;
        }

        if (useCviForRange) {
          rangeLongRaw = rangeLongRaw || cviBullSignal[i];
          rangeShortRaw = rangeShortRaw || cviBearSignal[i];
        }
      }

      const entryLong = (entryLongRaw || (enableRangeTrading && rangeLongRaw)) && allowLong && !volFilterOn;
      const entryShort = (entryShortRaw || (enableRangeTrading && rangeShortRaw)) && allowShort && !volFilterOn;

      if (entryLong || entryShort) {
        const dir: "long" | "short" = entryLong ? "long" : "short";
        const isLong = dir === "long";
        const sDist = calcStopDist();
        const tDist = calcTpDist(sDist);
        const isRange = entryLong ? (enableRangeTrading && rangeLongRaw && !entryLongRaw)
                                  : (enableRangeTrading && rangeShortRaw && !entryShortRaw);
        position = {
          direction: dir,
          entries: [{ price: close[i], bar: i }],
          avgEntryPrice: close[i],
          stopLevel: isLong ? close[i] - sDist : close[i] + sDist,
          tpLevel: useTakeProfit ? (isLong ? close[i] + tDist : close[i] - tDist) : NaN,
          trailLevel: 0,
          isRangeTrade: isRange,
          pyramidCount: 1,
          lastEntryPrice: close[i],
          entryBar: i,
          entryTimeIdx: i,
        };
      }
    }

    if (position) {
      const dir = position.direction;
      const unrealized = dir === "long"
        ? ((close[i] - position.avgEntryPrice) / position.avgEntryPrice) * position.pyramidCount * config.positionSize
        : ((position.avgEntryPrice - close[i]) / position.avgEntryPrice) * position.pyramidCount * config.positionSize;
      equityValues[i] = equity + unrealized;
    } else {
      equityValues[i] = equity;
    }
  }

  if (position) {
    const lastClose = close[n - 1];
    const pnlPct = position.direction === "long"
      ? ((lastClose - position.avgEntryPrice) / position.avgEntryPrice) * 100
      : ((position.avgEntryPrice - lastClose) / position.avgEntryPrice) * 100;
    const pnlDollar = position.pyramidCount * config.positionSize * (pnlPct / 100)
      - 2 * position.pyramidCount * config.positionSize * config.commission;
    equity += pnlDollar;
    trades.push({
      entryTime: new Date(candles[position.entryTimeIdx].time).toISOString(),
      exitTime: new Date(candles[n - 1].time).toISOString(),
      direction: position.direction,
      entryPrice: position.avgEntryPrice,
      exitPrice: lastClose,
      pnlPercent: Math.round(pnlPct * 100) / 100,
      pnlDollar: Math.round(pnlDollar * 100) / 100,
      exitReason: "Open Position",
      barsHeld: n - 1 - position.entryBar,
    });
  }

  let winCount = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const t of trades) {
    if (t.pnlPercent > 0) { winCount++; grossProfit += t.pnlDollar; }
    else { grossLoss -= t.pnlDollar; }
  }
  const netProfitPercent = ((equity - config.initialCapital) / config.initialCapital) * 100;

  const tradeReturns = trades.map(t => t.pnlPercent);
  let sharpeRatio = 0;
  if (tradeReturns.length >= 2) {
    const mean = tradeReturns.reduce((s, r) => s + r, 0) / tradeReturns.length;
    const variance = tradeReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (tradeReturns.length - 1);
    const stdDev = Math.sqrt(variance);
    sharpeRatio = stdDev > 0 ? Math.round((mean / stdDev) * 100) / 100 : 0;
  }

  let maxEquity = config.initialCapital;
  let maxDrawdown = 0;
  for (let i = 0; i < n; i++) {
    const eq = equityValues[i];
    if (eq > maxEquity) maxEquity = eq;
    const dd = ((maxEquity - eq) / maxEquity) * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const step = Math.max(1, Math.floor(n / 500));
  const equityCurve: { time: string; equity: number }[] = [];
  for (let i = 0; i < n; i += step) {
    equityCurve.push({ time: new Date(candles[i].time).toISOString(), equity: equityValues[i] });
  }
  if (n > 0 && (n - 1) % step !== 0) {
    equityCurve.push({ time: new Date(candles[n - 1].time).toISOString(), equity: equityValues[n - 1] });
  }

  return {
    ticker,
    timeframe,
    netProfitPercent: Math.round(netProfitPercent * 100) / 100,
    winRatePercent: trades.length > 0 ? Math.round((winCount / trades.length) * 10000) / 100 : 0,
    maxDrawdownPercent: Math.round(maxDrawdown * 100) / 100,
    profitFactor: grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : grossProfit > 0 ? 999 : 0,
    totalTrades: trades.length,
    sharpeRatio,
    params,
    trades,
    equityCurve,
  };
}
