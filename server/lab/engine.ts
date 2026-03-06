import type { LabTradeRecord, LabBacktestResult } from "@shared/schema";
import * as ind from "./indicators";

export interface OHLCV {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface EngineConfig {
  initialCapital: number;
  commission: number;
  positionSize: number;
  processOrdersOnClose?: boolean;
}

function p(params: Record<string, any>, name: string, fallback: string | null, defaultVal: any): any {
  if (params[name] !== undefined) return params[name];
  if (fallback && params[fallback] !== undefined) return params[fallback];
  return defaultVal;
}

export function runBacktest(
  candles: OHLCV[],
  params: Record<string, any>,
  ticker: string,
  timeframe: string,
  config: EngineConfig = { initialCapital: 1000, commission: 0.0005, positionSize: 1000 }
): LabBacktestResult {
  const n = candles.length;
  if (n < 10) {
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
  const volume = new Array(n);
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    open[i] = c.open;
    close[i] = c.close;
    high[i] = c.high;
    low[i] = c.low;
    volume[i] = c.volume;
  }

  const bbLen = p(params, "bbLen", null, 20);
  const bbMult = p(params, "bbMult", null, 2.0);
  const kcLen = p(params, "kcLen", null, 20);
  const kcMult = p(params, "kcMult", null, 1.5);
  const sqzLookback = p(params, "sqzLookback", null, 3);
  const momLen = p(params, "momLen", null, 12);
  const useLinReg = p(params, "useLinReg", null, true);
  const hullLen = p(params, "hullLen", null, 55);
  const useHull = p(params, "useHull", "useHullFilter", false);
  const useAdx = p(params, "useAdx", "useADXFilter", false);
  const adxLen = p(params, "adxLen", null, 14);
  const adxThresh = p(params, "adxThresh", null, 20);
  const adxRisingOk = p(params, "adxRisingOk", null, false);
  const useRsi = p(params, "useRsi", "useRSIFilter", false);
  const rsiLen = p(params, "rsiLen", null, 14);
  const rsiOB = p(params, "rsiOB", null, 70);
  const rsiOS = p(params, "rsiOS", null, 30);
  const blockExtremes = p(params, "blockExtremes", null, false);
  const useVolFilter = p(params, "useVolFilter", null, false);
  const volSmaLen = p(params, "volSmaLen", "volLen", 20);
  const volSurgeMult = p(params, "volSurgeMult", "volMult", 1.0);
  const useCandleFilter = p(params, "useCandleFilter", null, false);
  const bodyRatioMin = p(params, "bodyRatioMin", null, 0.5);
  const useEmaBias = p(params, "useEmaBias", null, false);
  const emaLen = p(params, "emaLen", null, 200);
  const cooldownBars = p(params, "cooldownBars", null, 0);
  const requireSqz = p(params, "requireSqz", null, true);
  const bbwPctile = p(params, "bbwPctile", null, 25);
  const bbwPctileLen = p(params, "bbwPctileLen", null, 100);

  const slMode: string = p(params, "slMode", null, "ATR");
  const slAtrLen = p(params, "slAtrLen", "atrLen", 14);
  const slAtrMult = p(params, "slAtrMult", "slMult", 2.0);
  const slPct = p(params, "slPct", null, 5.0);

  const tpMode: string = p(params, "tpMode", null, "ATR");
  const useTP1 = p(params, "useTP1", null, true);
  const tp1Mult = p(params, "tp1Mult", null, 1.5);
  const tp1Pct = p(params, "tp1Pct", null, 2.0);
  const tp1QtyPct = p(params, "tp1QtyPct", null, 30);
  const useTP2 = p(params, "useTP2", null, true);
  const tp2Mult = p(params, "tp2Mult", null, 3.0);
  const tp2Pct = p(params, "tp2Pct", null, 4.0);
  const tp2QtyPct = p(params, "tp2QtyPct", null, 30);
  const useTP3 = p(params, "useTP3", null, true);
  const tp3Mult = p(params, "tp3Mult", null, 5.0);
  const tp3Pct = p(params, "tp3Pct", null, 8.0);
  const tp3QtyPct = p(params, "tp3QtyPct", null, 50);

  const useTrail = p(params, "useTrail", "useTrailing", false);
  const trailMode: string = p(params, "trailMode", null, "ATR");
  const trailAtrMult = p(params, "trailAtrMult", "trailMult", 2.0);
  const trailPct = p(params, "trailPct", null, 1.0);
  const trailActivation: string = p(params, "trailActivation", null, "Immediately");
  const trailActAtr = p(params, "trailActAtr", null, 2.0);

  const useBE = p(params, "useBE", null, false);
  const beActivation: string = p(params, "beActivation", null, "After TP1");
  const beOffset = p(params, "beOffset", null, 0.1);
  const beActAtr = p(params, "beActAtr", null, 2.0);

  const exitOnMomFlip = p(params, "exitOnMomFlip", null, false);
  const exitOnHullFlip = p(params, "exitOnHullFlip", null, false);
  const exitOnResqueeze = p(params, "exitOnResqueeze", null, false);
  const exitOnRsiExtreme = p(params, "exitOnRsiExtreme", null, false);
  const exitOnAdxDrop = p(params, "exitOnAdxDrop", null, false);
  const adxDropLevel = p(params, "adxDropLevel", null, 15);

  const tradeDir: string = p(params, "tradeDir", null, "Both");
  const allowLong = tradeDir === "Both" || tradeDir === "Long Only";
  const allowShort = tradeDir === "Both" || tradeDir === "Short Only";

  const bb = ind.bollingerBands(close, bbLen, bbMult);
  const kc = ind.keltnerChannel(close, high, low, kcLen, kcLen, kcMult);
  const sqz = ind.squeeze(bb.upper, bb.lower, kc.upper, kc.lower);

  const bbW = ind.bbWidth(bb.upper, bb.lower, bb.basis);
  const bbwRank = ind.percentRank(bbW, bbwPctileLen);

  const hiH = ind.highest(high, momLen);
  const loL = ind.lowest(low, momLen);
  const momSma = ind.sma(close, momLen);
  const momInput = new Array(n);
  for (let i = 0; i < n; i++) {
    if (isNaN(hiH[i]) || isNaN(loL[i]) || isNaN(momSma[i])) {
      momInput[i] = 0;
    } else {
      const midHL = (hiH[i] + loL[i]) / 2;
      const midAll = (midHL + momSma[i]) / 2;
      momInput[i] = close[i] - midAll;
    }
  }
  const mom = useLinReg ? ind.linreg(momInput, momLen) : momInput;

  const hull = useHull || exitOnHullFlip ? ind.hullMa(close, hullLen) : null;
  const adxVals = useAdx || exitOnAdxDrop ? ind.adx(high, low, close, adxLen) : null;
  const rsiVals = useRsi || exitOnRsiExtreme ? ind.rsi(close, rsiLen) : null;
  const volSma = useVolFilter ? ind.volumeSma(volume, volSmaLen) : null;
  const slAtr = ind.atr(high, low, close, slAtrLen);
  const emaTrend = useEmaBias ? ind.ema(close, emaLen) : null;

  const sqzFired = new Array(n).fill(false);
  for (let i = 1; i < n; i++) {
    sqzFired[i] = !sqz[i] && sqz[i - 1];
  }

  const barsSinceSqzFired = new Array(n).fill(9999);
  for (let i = 0; i < n; i++) {
    if (sqzFired[i]) {
      barsSinceSqzFired[i] = 0;
    } else if (i > 0) {
      barsSinceSqzFired[i] = barsSinceSqzFired[i - 1] + 1;
    }
  }

  const warmup = Math.max(
    bbLen, kcLen, momLen * 2,
    useHull || exitOnHullFlip ? hullLen * 2 : 0,
    useAdx || exitOnAdxDrop ? adxLen * 2 : 0,
    useRsi || exitOnRsiExtreme ? rsiLen : 0,
    useVolFilter ? volSmaLen : 0,
    slAtrLen,
    useEmaBias ? emaLen : 0,
    requireSqz ? 0 : bbwPctileLen,
  ) + 10;

  function calcStop(isLong: boolean, refPrice: number, i: number): number {
    const atrVal = isNaN(slAtr[i]) ? refPrice * 0.02 : slAtr[i];
    switch (slMode) {
      case "ATR":
        return isLong ? refPrice - atrVal * slAtrMult : refPrice + atrVal * slAtrMult;
      case "Percentage":
        return isLong ? refPrice * (1 - slPct / 100) : refPrice * (1 + slPct / 100);
      case "BB Band":
        return isLong ? (isNaN(bb.lower[i]) ? refPrice * 0.95 : bb.lower[i])
                       : (isNaN(bb.upper[i]) ? refPrice * 1.05 : bb.upper[i]);
      case "Keltner Band":
        return isLong ? (isNaN(kc.lower[i]) ? refPrice * 0.95 : kc.lower[i])
                       : (isNaN(kc.upper[i]) ? refPrice * 1.05 : kc.upper[i]);
      default:
        return isLong ? refPrice - atrVal * slAtrMult : refPrice + atrVal * slAtrMult;
    }
  }

  function calcTP(isLong: boolean, refPrice: number, stopLevel: number, mult: number, pct: number, entryAtrVal: number): number {
    switch (tpMode) {
      case "ATR":
        return isLong ? refPrice + mult * entryAtrVal : refPrice - mult * entryAtrVal;
      case "Percentage":
        return isLong ? refPrice * (1 + pct / 100) : refPrice * (1 - pct / 100);
      case "Risk Multiple": {
        const risk = isLong ? refPrice - stopLevel : stopLevel - refPrice;
        return isLong ? refPrice + mult * risk : refPrice - mult * risk;
      }
      default:
        return isLong ? refPrice + mult * entryAtrVal : refPrice - mult * entryAtrVal;
    }
  }

  const trades: LabTradeRecord[] = [];
  const equityValues: number[] = new Array(n);
  let equity = config.initialCapital;

  interface Position {
    direction: "long" | "short";
    entryPrice: number;
    refPrice: number;
    entryBar: number;
    entryTimeIdx: number;
    entryAtr: number;
    remainingQty: number;
    stopLoss: number;
    tp1Level: number;
    tp2Level: number;
    tp3Level: number;
    tp1Hit: boolean;
    tp2Hit: boolean;
    tp3Hit: boolean;
    trailActive: boolean;
    trailLevel: number;
    beActive: boolean;
  }

  let position: Position | null = null;
  let pendingEntry: {
    direction: "long" | "short";
    refPrice: number;
    stopLoss: number;
    tp1Level: number;
    tp2Level: number;
    tp3Level: number;
    entryAtr: number;
    trailActive: boolean;
    trailLevel: number;
    signalBar: number;
  } | null = null;
  let pendingExit: {
    exitReason: string;
    signalBar: number;
  } | null = null;
  let pendingPartials: { qty: number; fillPriceRef: number; signalBar: number }[] = [];
  let barsSinceExit = 999;

  for (let i = 0; i < n; i++) {
    if (pendingEntry !== null && i > 0) {
      const fillPrice = open[i];
      position = {
        direction: pendingEntry.direction,
        entryPrice: fillPrice,
        refPrice: pendingEntry.refPrice,
        entryBar: i,
        entryTimeIdx: i,
        entryAtr: pendingEntry.entryAtr,
        remainingQty: 1,
        stopLoss: pendingEntry.stopLoss,
        tp1Level: pendingEntry.tp1Level,
        tp2Level: pendingEntry.tp2Level,
        tp3Level: pendingEntry.tp3Level,
        tp1Hit: false,
        tp2Hit: false,
        tp3Hit: false,
        trailActive: pendingEntry.trailActive,
        trailLevel: pendingEntry.trailLevel,
        beActive: false,
      };
      pendingEntry = null;
    }

    if (pendingPartials.length > 0 && position && i > 0) {
      for (const partial of pendingPartials) {
        const fillPrice = open[i];
        const dir = position.direction;
        const pnl = dir === "long"
          ? (fillPrice - position.entryPrice) / position.entryPrice
          : (position.entryPrice - fillPrice) / position.entryPrice;
        equity += partial.qty * config.positionSize * pnl - 2 * partial.qty * config.positionSize * config.commission;
        position.remainingQty -= partial.qty;
      }
      pendingPartials = [];
    }

    if (pendingExit !== null && position && i > 0) {
      const fillPrice = open[i];
      const dir = position.direction;
      const pnlPct = dir === "long"
        ? ((fillPrice - position.entryPrice) / position.entryPrice) * 100
        : ((position.entryPrice - fillPrice) / position.entryPrice) * 100;
      const pnlDollar = position.remainingQty * config.positionSize * (pnlPct / 100)
        - 2 * position.remainingQty * config.positionSize * config.commission;
      equity += pnlDollar;
      trades.push({
        entryTime: new Date(candles[position.entryTimeIdx].time).toISOString(),
        exitTime: new Date(candles[i].time).toISOString(),
        direction: dir,
        entryPrice: position.entryPrice,
        exitPrice: fillPrice,
        pnlPercent: Math.round(pnlPct * 100) / 100,
        pnlDollar: Math.round(pnlDollar * 100) / 100,
        exitReason: pendingExit.exitReason,
        barsHeld: i - position.entryBar,
      });
      position = null;
      pendingExit = null;
      barsSinceExit = 0;
    }

    if (i < warmup) {
      equityValues[i] = equity;
      continue;
    }

    const justEntered = position !== null && position.entryBar === i;

    if (position && !pendingExit && !justEntered) {
      const dir = position.direction;
      const isLong = dir === "long";
      const atrNow = isNaN(slAtr[i]) ? close[i] * 0.02 : slAtr[i];

      if (useTP1 && !position.tp1Hit && position.tp1Level !== 0) {
        const hit = isLong ? close[i] >= position.tp1Level : close[i] <= position.tp1Level;
        if (hit) {
          pendingPartials.push({ qty: position.remainingQty * (tp1QtyPct / 100), fillPriceRef: close[i], signalBar: i });
          position.tp1Hit = true;
        }
      }

      if (useTP2 && !position.tp2Hit && position.tp1Hit && position.tp2Level !== 0) {
        const hit = isLong ? close[i] >= position.tp2Level : close[i] <= position.tp2Level;
        if (hit) {
          const currentQty = position.remainingQty - pendingPartials.reduce((s, pp) => s + pp.qty, 0);
          pendingPartials.push({ qty: currentQty * (tp2QtyPct / 100), fillPriceRef: close[i], signalBar: i });
          position.tp2Hit = true;
        }
      }

      if (useTP3 && !position.tp3Hit && position.tp2Hit && position.tp3Level !== 0) {
        const hit = isLong ? close[i] >= position.tp3Level : close[i] <= position.tp3Level;
        if (hit) {
          position.tp3Hit = true;
          pendingExit = { exitReason: "TP3", signalBar: i };
        }
      }

      if (position && !pendingExit && useBE && !position.beActive) {
        let shouldActivateBE = false;
        if (beActivation === "After TP1") shouldActivateBE = position.tp1Hit;
        else if (beActivation === "After TP2") shouldActivateBE = position.tp2Hit;
        else if (beActivation === "Custom ATR Distance") {
          const dist = isLong ? close[i] - position.refPrice : position.refPrice - close[i];
          shouldActivateBE = dist >= beActAtr * position.entryAtr;
        }
        if (shouldActivateBE) {
          position.beActive = true;
          position.stopLoss = isLong
            ? position.refPrice * (1 + beOffset / 100)
            : position.refPrice * (1 - beOffset / 100);
        }
      }

      if (position && !pendingExit && useTrail) {
        let shouldActivateTrail = false;
        if (trailActivation === "Immediately") shouldActivateTrail = true;
        else if (trailActivation === "After TP1") shouldActivateTrail = position.tp1Hit;
        else if (trailActivation === "After TP2") shouldActivateTrail = position.tp2Hit;
        else if (trailActivation === "Custom ATR Distance") {
          const dist = isLong ? close[i] - position.refPrice : position.refPrice - close[i];
          shouldActivateTrail = dist >= trailActAtr * position.entryAtr;
        }

        if (shouldActivateTrail) {
          position.trailActive = true;
          let newTrail: number;
          if (trailMode === "ATR") {
            newTrail = isLong ? close[i] - trailAtrMult * atrNow : close[i] + trailAtrMult * atrNow;
          } else {
            newTrail = isLong ? close[i] * (1 - trailPct / 100) : close[i] * (1 + trailPct / 100);
          }
          if (position.trailLevel === 0) {
            position.trailLevel = newTrail;
          } else {
            position.trailLevel = isLong
              ? Math.max(position.trailLevel, newTrail)
              : Math.min(position.trailLevel, newTrail);
          }
          if (isLong && position.trailLevel > position.stopLoss) {
            position.stopLoss = position.trailLevel;
          } else if (!isLong && position.trailLevel < position.stopLoss) {
            position.stopLoss = position.trailLevel;
          }
        }
      }

      if (position && !pendingExit) {
        const slHit = isLong ? close[i] <= position.stopLoss : close[i] >= position.stopLoss;
        if (slHit) {
          const reason = position.beActive ? "BE Stop" : position.trailActive ? "Trail Stop" : "Stop Loss";
          pendingExit = { exitReason: reason, signalBar: i };
        }
      }
    }

    if (position && !pendingExit) {
      const dir = position.direction;
      const isLong = dir === "long";

      if (exitOnMomFlip) {
        const momBearish = !isNaN(mom[i]) && mom[i] < 0;
        const momFall = !isNaN(mom[i]) && !isNaN(mom[i - 1]) && mom[i] < mom[i - 1];
        const momBullish = !isNaN(mom[i]) && mom[i] > 0;
        const momRise = !isNaN(mom[i]) && !isNaN(mom[i - 1]) && mom[i] > mom[i - 1];
        if (isLong && momBearish && momFall) pendingExit = { exitReason: "Mom Flip", signalBar: i };
        if (!isLong && momBullish && momRise) pendingExit = { exitReason: "Mom Flip", signalBar: i };
      }

      if (!pendingExit && exitOnHullFlip && hull) {
        const hullBull = !isNaN(hull[i]) && !isNaN(hull[i - 2]) && hull[i] - hull[i - 2] > 0;
        const hullBear = !isNaN(hull[i]) && !isNaN(hull[i - 2]) && hull[i] - hull[i - 2] < 0;
        if (isLong && hullBear) pendingExit = { exitReason: "Hull Flip", signalBar: i };
        if (!isLong && hullBull) pendingExit = { exitReason: "Hull Flip", signalBar: i };
      }

      if (!pendingExit && exitOnResqueeze) {
        if (sqz[i] && i > 0 && !sqz[i - 1]) {
          pendingExit = { exitReason: "Re-Squeeze", signalBar: i };
        }
      }

      if (!pendingExit && exitOnRsiExtreme && useRsi && rsiVals) {
        if (isLong && !isNaN(rsiVals[i]) && rsiVals[i] >= rsiOB) pendingExit = { exitReason: "RSI OB", signalBar: i };
        if (!isLong && !isNaN(rsiVals[i]) && rsiVals[i] <= rsiOS) pendingExit = { exitReason: "RSI OS", signalBar: i };
      }

      if (!pendingExit && exitOnAdxDrop && useAdx && adxVals) {
        if (!isNaN(adxVals[i]) && !isNaN(adxVals[i - 1]) &&
            adxVals[i] < adxDropLevel && adxVals[i - 1] >= adxDropLevel) {
          pendingExit = { exitReason: "ADX Drop", signalBar: i };
        }
      }
    }

    if (!position && !pendingEntry && !pendingExit && i > 0) {
      barsSinceExit++;
      if (barsSinceExit < cooldownBars) {
        equityValues[i] = equity;
        continue;
      }

      const recentSqueeze = requireSqz
        ? (barsSinceSqzFired[i] <= sqzLookback)
        : (!isNaN(bbwRank[i]) && bbwRank[i] <= bbwPctile
            ? true
            : (() => {
                for (let k = i; k >= Math.max(0, i - sqzLookback); k--) {
                  if (!isNaN(bbwRank[k]) && bbwRank[k] <= bbwPctile) return true;
                }
                return false;
              })());

      const momPositive = !isNaN(mom[i]) && mom[i] > 0;
      const momNegative = !isNaN(mom[i]) && mom[i] < 0;
      const momRising = !isNaN(mom[i]) && !isNaN(mom[i - 1]) && mom[i] > mom[i - 1];
      const momFalling = !isNaN(mom[i]) && !isNaN(mom[i - 1]) && mom[i] < mom[i - 1];

      const hullSlope = hull && !isNaN(hull[i]) && !isNaN(hull[i - 2]) ? hull[i] - hull[i - 2] : 0;
      const hullBull = !useHull || hullSlope > 0;
      const hullBear = !useHull || hullSlope < 0;

      let adxOk = true;
      if (useAdx && adxVals) {
        const av = adxVals[i];
        if (isNaN(av)) {
          adxOk = false;
        } else {
          adxOk = av >= adxThresh || (adxRisingOk && !isNaN(adxVals[i - 2]) && av > adxVals[i - 2]);
        }
      }

      const rsiLongOk = !useRsi || !blockExtremes || !rsiVals || isNaN(rsiVals[i]) || rsiVals[i] < rsiOB;
      const rsiShortOk = !useRsi || !blockExtremes || !rsiVals || isNaN(rsiVals[i]) || rsiVals[i] > rsiOS;
      const volOk = !useVolFilter || (volSma && !isNaN(volSma[i]) && volume[i] > volSma[i] * volSurgeMult);

      let strongBody = true;
      if (useCandleFilter) {
        const candleBody = Math.abs(close[i] - open[i]);
        const candleRange = high[i] - low[i];
        strongBody = candleRange > 0 ? (candleBody / candleRange) >= bodyRatioMin : false;
      }

      const emaLongOk = !useEmaBias || (emaTrend && !isNaN(emaTrend[i]) && close[i] > emaTrend[i]);
      const emaShortOk = !useEmaBias || (emaTrend && !isNaN(emaTrend[i]) && close[i] < emaTrend[i]);

      const longCondition = recentSqueeze && momPositive && momRising && hullBull && adxOk && rsiLongOk && volOk && strongBody && emaLongOk && allowLong;
      const shortCondition = recentSqueeze && momNegative && momFalling && hullBear && adxOk && rsiShortOk && volOk && strongBody && emaShortOk && allowShort;

      if (longCondition || shortCondition) {
        const dir: "long" | "short" = longCondition ? "long" : "short";
        const isLong = dir === "long";
        const refPrice = close[i];
        const entryAtr = isNaN(slAtr[i]) ? refPrice * 0.02 : slAtr[i];
        const stopLevel = calcStop(isLong, refPrice, i);
        const t1 = useTP1 ? calcTP(isLong, refPrice, stopLevel, tp1Mult, tp1Pct, entryAtr) : 0;
        const t2 = useTP2 ? calcTP(isLong, refPrice, stopLevel, tp2Mult, tp2Pct, entryAtr) : 0;
        const t3 = useTP3 ? calcTP(isLong, refPrice, stopLevel, tp3Mult, tp3Pct, entryAtr) : 0;

        let initTrailActive = false;
        let initTrailLevel = 0;
        if (useTrail && trailActivation === "Immediately") {
          initTrailActive = true;
          if (trailMode === "ATR") {
            initTrailLevel = isLong ? refPrice - trailAtrMult * entryAtr : refPrice + trailAtrMult * entryAtr;
          } else {
            initTrailLevel = isLong ? refPrice * (1 - trailPct / 100) : refPrice * (1 + trailPct / 100);
          }
        }

        pendingEntry = {
          direction: dir,
          refPrice,
          stopLoss: stopLevel,
          tp1Level: t1,
          tp2Level: t2,
          tp3Level: t3,
          entryAtr,
          trailActive: initTrailActive,
          trailLevel: initTrailLevel,
          signalBar: i,
        };
      }
    }

    if (position) {
      const dir = position.direction;
      const unrealized = dir === "long"
        ? ((close[i] - position.entryPrice) / position.entryPrice) * position.remainingQty * config.positionSize
        : ((position.entryPrice - close[i]) / position.entryPrice) * position.remainingQty * config.positionSize;
      equityValues[i] = equity + unrealized;
    } else {
      equityValues[i] = equity;
    }
  }

  if (position) {
    const lastClose = close[n - 1];
    const pnlPct = position.direction === "long"
      ? ((lastClose - position.entryPrice) / position.entryPrice) * 100
      : ((position.entryPrice - lastClose) / position.entryPrice) * 100;
    const pnlDollar = position.remainingQty * config.positionSize * (pnlPct / 100)
      - 2 * position.remainingQty * config.positionSize * config.commission;
    equity += pnlDollar;
    trades.push({
      entryTime: new Date(candles[position.entryTimeIdx].time).toISOString(),
      exitTime: new Date(candles[n - 1].time).toISOString(),
      direction: position.direction,
      entryPrice: position.entryPrice,
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
  for (let t = 0; t < trades.length; t++) {
    if (trades[t].pnlPercent > 0) {
      winCount++;
      grossProfit += trades[t].pnlDollar;
    } else {
      grossLoss -= trades[t].pnlDollar;
    }
  }
  const netProfitPercent = ((equity - config.initialCapital) / config.initialCapital) * 100;

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
    params,
    trades,
    equityCurve,
  };
}
