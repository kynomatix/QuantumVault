type NumSeries = ArrayLike<number>;

export function sma(data: NumSeries, period: number): number[] {
  const result: number[] = new Array(data.length).fill(NaN);
  if (period <= 0 || data.length < period) return result;
  let firstValid = -1;
  for (let i = 0; i <= data.length - period; i++) {
    let allValid = true;
    for (let j = i; j < i + period; j++) {
      if (isNaN(data[j])) { allValid = false; break; }
    }
    if (allValid) { firstValid = i; break; }
  }
  if (firstValid < 0) return result;
  let sum = 0;
  for (let i = firstValid; i < firstValid + period; i++) sum += data[i];
  result[firstValid + period - 1] = sum / period;
  for (let i = firstValid + period; i < data.length; i++) {
    const leaving = data[i - period];
    const entering = data[i];
    if (isNaN(entering)) { sum = NaN; result[i] = NaN; continue; }
    if (isNaN(sum)) {
      sum = 0;
      for (let j = i - period + 1; j <= i; j++) {
        if (isNaN(data[j])) { sum = NaN; break; }
        sum += data[j];
      }
      result[i] = isNaN(sum) ? NaN : sum / period;
      continue;
    }
    sum += entering - leaving;
    result[i] = sum / period;
  }
  return result;
}

export function ema(data: NumSeries, period: number): number[] {
  const result: number[] = new Array(data.length).fill(NaN);
  const k = 2 / (period + 1);
  const k1 = 1 - k;
  let prev = NaN;
  for (let i = 0; i < data.length; i++) {
    if (isNaN(prev)) {
      if (i >= period - 1) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += data[j];
        prev = sum / period;
        result[i] = prev;
      }
    } else {
      prev = data[i] * k + prev * k1;
      result[i] = prev;
    }
  }
  return result;
}

export function pineEma(data: NumSeries, period: number): number[] {
  const result: number[] = new Array(data.length).fill(NaN);
  const k = 2 / (period + 1);
  const k1 = 1 - k;
  let prev = NaN;
  for (let i = 0; i < data.length; i++) {
    if (isNaN(prev)) {
      if (!isNaN(data[i])) {
        prev = data[i];
        result[i] = prev;
      }
    } else {
      prev = data[i] * k + prev * k1;
      result[i] = prev;
    }
  }
  return result;
}

export function rma(data: NumSeries, period: number): number[] {
  const result: number[] = new Array(data.length).fill(NaN);
  const k = 1 / period;
  const k1 = 1 - k;
  let prev = NaN;
  for (let i = 0; i < data.length; i++) {
    if (isNaN(prev)) {
      if (i >= period - 1) {
        let sum = 0;
        let valid = true;
        for (let j = i - period + 1; j <= i; j++) {
          if (isNaN(data[j])) { valid = false; break; }
          sum += data[j];
        }
        if (valid) {
          prev = sum / period;
          result[i] = prev;
        }
      }
    } else {
      prev = data[i] * k + prev * k1;
      result[i] = prev;
    }
  }
  return result;
}

export function wma(data: NumSeries, period: number): number[] {
  const result: number[] = new Array(data.length).fill(NaN);
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    let hasNaN = false;
    for (let j = 0; j < period; j++) {
      const v = data[i - period + 1 + j];
      if (isNaN(v)) { hasNaN = true; break; }
      sum += v * (j + 1);
    }
    if (!hasNaN) result[i] = sum / denom;
  }
  return result;
}

export function hullMa(data: NumSeries, period: number): number[] {
  const halfPeriod = Math.floor(period / 2);
  const sqrtPeriod = Math.floor(Math.sqrt(period));
  const wma1 = wma(data, halfPeriod);
  const wma2 = wma(data, period);
  const diff: number[] = new Array(data.length);
  for (let i = 0; i < data.length; i++) {
    diff[i] = isNaN(wma1[i]) || isNaN(wma2[i]) ? NaN : 2 * wma1[i] - wma2[i];
  }
  return wma(diff, sqrtPeriod);
}

export function stdev(data: NumSeries, period: number): number[] {
  const result: number[] = new Array(data.length).fill(NaN);
  if (period <= 0 || data.length < period) return result;
  let firstValid = -1;
  for (let i = 0; i <= data.length - period; i++) {
    let allValid = true;
    for (let j = i; j < i + period; j++) {
      if (isNaN(data[j])) { allValid = false; break; }
    }
    if (allValid) { firstValid = i; break; }
  }
  if (firstValid < 0) return result;
  let sum = 0;
  let sumSq = 0;
  for (let i = firstValid; i < firstValid + period; i++) {
    sum += data[i];
    sumSq += data[i] * data[i];
  }
  result[firstValid + period - 1] = Math.sqrt(Math.max(0, (sumSq - (sum * sum) / period) / period));
  for (let i = firstValid + period; i < data.length; i++) {
    const old = data[i - period];
    if (isNaN(data[i]) || isNaN(old)) {
      sum = 0; sumSq = 0;
      let valid = true;
      for (let j = i - period + 1; j <= i; j++) {
        if (isNaN(data[j])) { valid = false; break; }
        sum += data[j]; sumSq += data[j] * data[j];
      }
      if (!valid) { result[i] = NaN; sum = NaN; continue; }
    } else {
      sum += data[i] - old;
      sumSq += data[i] * data[i] - old * old;
    }
    const variance = (sumSq - (sum * sum) / period) / period;
    result[i] = Math.sqrt(Math.max(0, variance));
  }
  return result;
}

export function bollingerBands(data: NumSeries, period: number, mult: number): { upper: number[]; basis: number[]; lower: number[] } {
  const basis = sma(data, period);
  const sd = stdev(data, period);
  const n = data.length;
  const upper: number[] = new Array(n);
  const lower: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    if (isNaN(basis[i])) {
      upper[i] = NaN;
      lower[i] = NaN;
    } else {
      const offset = mult * sd[i];
      upper[i] = basis[i] + offset;
      lower[i] = basis[i] - offset;
    }
  }
  return { upper, basis, lower };
}

export function trueRange(high: NumSeries, low: NumSeries, close: NumSeries): number[] {
  const result: number[] = [high[0] - low[0]];
  for (let i = 1; i < high.length; i++) {
    const hl = high[i] - low[i];
    const hc = Math.abs(high[i] - close[i - 1]);
    const lc = Math.abs(low[i] - close[i - 1]);
    result.push(Math.max(hl, hc, lc));
  }
  return result;
}

export function atr(high: NumSeries, low: NumSeries, close: NumSeries, period: number): number[] {
  const tr = trueRange(high, low, close);
  return rma(tr, period);
}

export function keltnerChannel(close: NumSeries, high: NumSeries, low: NumSeries, smaLen: number, atrLen: number, mult: number): { upper: number[]; basis: number[]; lower: number[] } {
  const basis = sma(close, smaLen);
  const atrVals = atr(high, low, close, atrLen);
  const n = close.length;
  const upper: number[] = new Array(n);
  const lower: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    if (isNaN(basis[i]) || isNaN(atrVals[i])) {
      upper[i] = NaN;
      lower[i] = NaN;
    } else {
      upper[i] = basis[i] + mult * atrVals[i];
      lower[i] = basis[i] - mult * atrVals[i];
    }
  }
  return { upper, basis, lower };
}

export function rsi(data: NumSeries, period: number): number[] {
  const result: number[] = new Array(data.length).fill(NaN);
  if (data.length < period + 1) return result;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = data[i] - data[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  const pm1 = period - 1;
  for (let i = period + 1; i < data.length; i++) {
    const change = data[i] - data[i - 1];
    if (change > 0) {
      avgGain = (avgGain * pm1 + change) / period;
      avgLoss = (avgLoss * pm1) / period;
    } else {
      avgGain = (avgGain * pm1) / period;
      avgLoss = (avgLoss * pm1 - change) / period;
    }
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

export function adx(high: NumSeries, low: NumSeries, close: NumSeries, period: number): number[] {
  const result: number[] = new Array(high.length).fill(NaN);
  if (high.length < period * 2) return result;
  const plusDM: number[] = [0];
  const minusDM: number[] = [0];
  for (let i = 1; i < high.length; i++) {
    const upMove = high[i] - high[i - 1];
    const downMove = low[i - 1] - low[i];
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  const atrVals = atr(high, low, close, period);
  const smoothPlusDM = rma(plusDM, period);
  const smoothMinusDM = rma(minusDM, period);
  const dx: number[] = new Array(high.length);
  for (let i = 0; i < high.length; i++) {
    if (isNaN(atrVals[i]) || atrVals[i] === 0 || isNaN(smoothPlusDM[i])) {
      dx[i] = 0;
    } else {
      const plusDI = (smoothPlusDM[i] / atrVals[i]) * 100;
      const minusDI = (smoothMinusDM[i] / atrVals[i]) * 100;
      const sum = plusDI + minusDI;
      dx[i] = sum === 0 ? 0 : (Math.abs(plusDI - minusDI) / sum) * 100;
    }
  }
  const adxVals = rma(dx, period);
  for (let i = 0; i < high.length; i++) {
    result[i] = adxVals[i];
  }
  return result;
}

export function linreg(data: NumSeries, period: number): number[] {
  const result: number[] = new Array(data.length).fill(NaN);
  if (data.length < period) return result;
  const sumXConst = (period * (period - 1)) / 2;
  const sumX2Const = (period * (period - 1) * (2 * period - 1)) / 6;
  const denom = period * sumX2Const - sumXConst * sumXConst;
  if (denom === 0) return result;
  const pm1 = period - 1;

  for (let i = pm1; i < data.length; i++) {
    let sumY = 0;
    let sumXY = 0;
    for (let j = 0; j < period; j++) {
      const val = data[i - pm1 + j];
      sumY += val;
      sumXY += j * val;
    }
    const slope = (period * sumXY - sumXConst * sumY) / denom;
    const intercept = (sumY - slope * sumXConst) / period;
    result[i] = intercept + slope * pm1;
  }
  return result;
}

export function volumeSma(volume: NumSeries, period: number): number[] {
  return sma(volume, period);
}

export function squeeze(bbUpper: NumSeries, bbLower: NumSeries, kcUpper: NumSeries, kcLower: NumSeries): boolean[] {
  const n = bbUpper.length;
  const result: boolean[] = new Array(n);
  for (let i = 0; i < n; i++) {
    if (isNaN(bbUpper[i]) || isNaN(kcUpper[i])) {
      result[i] = false;
    } else {
      result[i] = bbLower[i] > kcLower[i] && bbUpper[i] < kcUpper[i];
    }
  }
  return result;
}

export function highest(data: NumSeries, period: number): number[] {
  const result: number[] = new Array(data.length).fill(NaN);
  for (let i = period - 1; i < data.length; i++) {
    let max = -Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (data[j] > max) max = data[j];
    }
    result[i] = max;
  }
  return result;
}

export function lowest(data: NumSeries, period: number): number[] {
  const result: number[] = new Array(data.length).fill(NaN);
  for (let i = period - 1; i < data.length; i++) {
    let min = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (data[j] < min) min = data[j];
    }
    result[i] = min;
  }
  return result;
}

export function percentRank(data: NumSeries, period: number): number[] {
  const result: number[] = new Array(data.length).fill(NaN);
  for (let i = period; i < data.length; i++) {
    let count = 0;
    for (let j = i - period; j < i; j++) {
      if (data[j] <= data[i]) count++;
    }
    result[i] = (count / period) * 100;
  }
  return result;
}

export function bbWidth(bbUpper: NumSeries, bbLower: NumSeries, bbBasis: NumSeries): number[] {
  const n = bbUpper.length;
  const result: number[] = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!isNaN(bbUpper[i]) && !isNaN(bbLower[i]) && !isNaN(bbBasis[i]) && bbBasis[i] !== 0) {
      result[i] = ((bbUpper[i] - bbLower[i]) / bbBasis[i]) * 100;
    }
  }
  return result;
}

export function vwma(src: NumSeries, volume: NumSeries, period: number): number[] {
  const n = src.length;
  const result: number[] = new Array(n).fill(NaN);
  if (period <= 0 || n < period) return result;
  const pv: number[] = new Array(n);
  for (let i = 0; i < n; i++) pv[i] = src[i] * volume[i];
  const numer = sma(pv, period);
  const denom = sma(volume, period);
  for (let i = 0; i < n; i++) {
    if (!isNaN(numer[i]) && !isNaN(denom[i]) && denom[i] !== 0) result[i] = numer[i] / denom[i];
  }
  return result;
}

export function hma(src: NumSeries, period: number): number[] {
  return hullMa(src, period);
}

export function dema(src: NumSeries, period: number): number[] {
  const e1 = pineEma(src, period);
  const e2 = pineEma(e1, period);
  const n = src.length;
  const result: number[] = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!isNaN(e1[i]) && !isNaN(e2[i])) result[i] = 2 * e1[i] - e2[i];
  }
  return result;
}

export function tema(src: NumSeries, period: number): number[] {
  const e1 = pineEma(src, period);
  const e2 = pineEma(e1, period);
  const e3 = pineEma(e2, period);
  const n = src.length;
  const result: number[] = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!isNaN(e1[i]) && !isNaN(e2[i]) && !isNaN(e3[i])) result[i] = 3 * e1[i] - 3 * e2[i] + e3[i];
  }
  return result;
}

export function alma(src: NumSeries, period: number, offset: number, sigma: number): number[] {
  const n = src.length;
  const result: number[] = new Array(n).fill(NaN);
  if (period <= 0 || n < period) return result;
  const m = offset * (period - 1);
  const s = period / sigma;
  const weights: number[] = new Array(period);
  let wSum = 0;
  for (let k = 0; k < period; k++) {
    const w = Math.exp(-((k - m) * (k - m)) / (2 * s * s));
    weights[k] = w;
    wSum += w;
  }
  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    let valid = true;
    for (let k = 0; k < period; k++) {
      const v = src[i - period + 1 + k];
      if (isNaN(v)) { valid = false; break; }
      sum += v * weights[k];
    }
    if (valid) result[i] = sum / wSum;
  }
  return result;
}

export function swma(src: NumSeries): number[] {
  const n = src.length;
  const result: number[] = new Array(n).fill(NaN);
  for (let i = 3; i < n; i++) {
    const a = src[i - 3], b = src[i - 2], c = src[i - 1], d = src[i];
    if (!isNaN(a) && !isNaN(b) && !isNaN(c) && !isNaN(d)) {
      result[i] = (a * 1 + b * 2 + c * 2 + d * 1) / 6;
    }
  }
  return result;
}

export function cci(src: NumSeries, period: number): number[] {
  const n = src.length;
  const result: number[] = new Array(n).fill(NaN);
  const basis = sma(src, period);
  for (let i = period - 1; i < n; i++) {
    if (isNaN(basis[i])) continue;
    let meanDev = 0;
    for (let j = i - period + 1; j <= i; j++) meanDev += Math.abs(src[j] - basis[i]);
    meanDev /= period;
    result[i] = meanDev === 0 ? 0 : (src[i] - basis[i]) / (0.015 * meanDev);
  }
  return result;
}

export function macd(src: NumSeries, fast: number, slow: number, signalPeriod: number): { macd: number[]; signal: number[]; hist: number[] } {
  const ef = pineEma(src, fast);
  const es = pineEma(src, slow);
  const n = src.length;
  const macdLine: number[] = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!isNaN(ef[i]) && !isNaN(es[i])) macdLine[i] = ef[i] - es[i];
  }
  const signal = pineEma(macdLine, signalPeriod);
  const hist: number[] = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!isNaN(macdLine[i]) && !isNaN(signal[i])) hist[i] = macdLine[i] - signal[i];
  }
  return { macd: macdLine, signal, hist };
}

export function supertrend(high: NumSeries, low: NumSeries, close: NumSeries, factor: number, atrPeriod: number): { supertrend: number[]; direction: number[] } {
  const n = close.length;
  const atrVals = atr(high, low, close, atrPeriod);
  const st: number[] = new Array(n).fill(NaN);
  const dir: number[] = new Array(n).fill(NaN);
  let finalUpper = NaN, finalLower = NaN;
  let prevDir = 1;
  let prevSt = NaN;
  for (let i = 0; i < n; i++) {
    const hl2 = (high[i] + low[i]) / 2;
    const a = atrVals[i];
    if (isNaN(a)) continue;
    const up = hl2 + factor * a;
    const lo = hl2 - factor * a;
    if (isNaN(finalUpper)) { finalUpper = up; finalLower = lo; prevDir = 1; prevSt = lo; st[i] = lo; dir[i] = 1; continue; }
    const prevClose = close[i - 1];
    finalUpper = (up < finalUpper || prevClose > finalUpper) ? up : finalUpper;
    finalLower = (lo > finalLower || prevClose < finalLower) ? lo : finalLower;
    let curDir: number;
    if (prevDir === 1) {
      curDir = close[i] < finalLower ? -1 : 1;
    } else {
      curDir = close[i] > finalUpper ? 1 : -1;
    }
    const curSt = curDir === 1 ? finalLower : finalUpper;
    st[i] = curSt;
    dir[i] = curDir;
    prevDir = curDir;
    prevSt = curSt;
  }
  return { supertrend: st, direction: dir };
}

export function percentileNearestRank(data: NumSeries, period: number, percentage: number): number[] {
  const n = data.length;
  const result: number[] = new Array(n).fill(NaN);
  if (period <= 0 || percentage < 0 || percentage > 100) return result;
  for (let i = period - 1; i < n; i++) {
    const window: number[] = [];
    let hasNaN = false;
    for (let j = i - period + 1; j <= i; j++) {
      if (isNaN(data[j])) { hasNaN = true; break; }
      window.push(data[j]);
    }
    if (hasNaN) continue;
    window.sort((a, b) => a - b);
    const rank = Math.ceil((percentage / 100) * period);
    const idx = Math.max(0, Math.min(period - 1, rank - 1));
    result[i] = window[idx];
  }
  return result;
}

export function percentileLinearInterpolation(data: NumSeries, period: number, percentage: number): number[] {
  const n = data.length;
  const result: number[] = new Array(n).fill(NaN);
  if (period <= 0 || percentage < 0 || percentage > 100) return result;
  for (let i = period - 1; i < n; i++) {
    const window: number[] = [];
    let hasNaN = false;
    for (let j = i - period + 1; j <= i; j++) {
      if (isNaN(data[j])) { hasNaN = true; break; }
      window.push(data[j]);
    }
    if (hasNaN) continue;
    window.sort((a, b) => a - b);
    const rank = (percentage / 100) * (period - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    if (lo === hi) result[i] = window[lo];
    else result[i] = window[lo] + (rank - lo) * (window[hi] - window[lo]);
  }
  return result;
}

// ============================================================================
// TradingView Pine v5 ta.* parity additions (per session_plan.md T001-T002)
// ----------------------------------------------------------------------------
// Inventory cross-referenced against https://www.tradingview.com/pine-script-reference/v5/
// Already implemented above: sma ema wma linreg rma vwma swma hma dema tema
//   alma rsi cci mfi roc dev median percentrank cum stoch macd bb kc atr tr
//   adx supertrend dmi highest lowest pivothigh pivotlow
//   percentile_nearest_rank percentile_linear_interpolation (+ control-flow
//   crossover crossunder cross change rising falling barssince valuewhen vwap)
// Added below:
//   obv sar aroon tsi wpr bbw kcw mom accdist (alias: ad) highestbars
//   lowestbars cmo bop cog correlation (alias: pearsonr) variance pvt nvi
//   pvi iii wad vortex range mode
// Intentionally excluded (out of scope per project constraints):
//   request.* / ta.security_* — multi-symbol/multi-timeframe data fetching.
// ============================================================================

// ta.obv — https://www.tradingview.com/pine-script-reference/v5/#fun_ta.obv
export function obv(close: NumSeries, volume: NumSeries): number[] {
  const n = close.length;
  const r: number[] = new Array(n).fill(NaN);
  if (n === 0) return r;
  r[0] = 0;
  for (let i = 1; i < n; i++) {
    const prev = r[i - 1];
    const c = close[i], cp = close[i - 1], v = volume[i] || 0;
    if (isNaN(c) || isNaN(cp)) { r[i] = prev; continue; }
    r[i] = prev + (c > cp ? v : c < cp ? -v : 0);
  }
  return r;
}

// ta.accdist (alias ta.ad) — https://www.tradingview.com/pine-script-reference/v5/#fun_ta.accdist
export function accdist(high: NumSeries, low: NumSeries, close: NumSeries, volume: NumSeries): number[] {
  const n = close.length;
  const r: number[] = new Array(n).fill(NaN);
  let cum = 0;
  for (let i = 0; i < n; i++) {
    const h = high[i], l = low[i], c = close[i], v = volume[i] || 0;
    const rng = h - l;
    const mfm = rng === 0 ? 0 : ((c - l) - (h - c)) / rng;
    cum += mfm * v;
    r[i] = cum;
  }
  return r;
}

// ta.pvt — https://www.tradingview.com/pine-script-reference/v5/#fun_ta.pvt
export function pvt(close: NumSeries, volume: NumSeries): number[] {
  const n = close.length;
  const r: number[] = new Array(n).fill(NaN);
  if (n === 0) return r;
  r[0] = 0;
  for (let i = 1; i < n; i++) {
    const cp = close[i - 1];
    const ch = cp === 0 || isNaN(cp) ? 0 : (close[i] - cp) / cp;
    r[i] = r[i - 1] + ch * (volume[i] || 0);
  }
  return r;
}

// ta.nvi — https://www.tradingview.com/pine-script-reference/v5/#fun_ta.nvi
export function nvi(close: NumSeries, volume: NumSeries): number[] {
  const n = close.length;
  const r: number[] = new Array(n).fill(NaN);
  if (n === 0) return r;
  r[0] = 1000;
  for (let i = 1; i < n; i++) {
    const prev = r[i - 1];
    const cp = close[i - 1];
    if (volume[i] < volume[i - 1] && cp !== 0 && !isNaN(cp)) {
      r[i] = prev + ((close[i] - cp) / cp) * prev;
    } else {
      r[i] = prev;
    }
  }
  return r;
}

// ta.pvi — https://www.tradingview.com/pine-script-reference/v5/#fun_ta.pvi
export function pvi(close: NumSeries, volume: NumSeries): number[] {
  const n = close.length;
  const r: number[] = new Array(n).fill(NaN);
  if (n === 0) return r;
  r[0] = 1000;
  for (let i = 1; i < n; i++) {
    const prev = r[i - 1];
    const cp = close[i - 1];
    if (volume[i] > volume[i - 1] && cp !== 0 && !isNaN(cp)) {
      r[i] = prev + ((close[i] - cp) / cp) * prev;
    } else {
      r[i] = prev;
    }
  }
  return r;
}

// ta.iii — https://www.tradingview.com/pine-script-reference/v5/#fun_ta.iii
export function iii(high: NumSeries, low: NumSeries, close: NumSeries, volume: NumSeries): number[] {
  const n = close.length;
  const r: number[] = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const rng = high[i] - low[i];
    const v = volume[i] || 0;
    r[i] = (rng === 0 || v === 0) ? 0 : ((2 * close[i] - high[i] - low[i]) / rng) * v;
  }
  return r;
}

// ta.wad — Williams Acc/Dist — https://www.tradingview.com/pine-script-reference/v5/#fun_ta.wad
export function wad(high: NumSeries, low: NumSeries, close: NumSeries): number[] {
  const n = close.length;
  const r: number[] = new Array(n).fill(NaN);
  if (n === 0) return r;
  r[0] = 0;
  for (let i = 1; i < n; i++) {
    const cp = close[i - 1];
    if (close[i] > cp) r[i] = r[i - 1] + (close[i] - Math.min(low[i], cp));
    else if (close[i] < cp) r[i] = r[i - 1] + (close[i] - Math.max(high[i], cp));
    else r[i] = r[i - 1];
  }
  return r;
}

// ta.bop — https://www.tradingview.com/pine-script-reference/v5/#fun_ta.bop
export function bop(open: NumSeries, high: NumSeries, low: NumSeries, close: NumSeries): number[] {
  const n = close.length;
  const r: number[] = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const rng = high[i] - low[i];
    r[i] = rng === 0 ? 0 : (close[i] - open[i]) / rng;
  }
  return r;
}

// ta.mom — https://www.tradingview.com/pine-script-reference/v5/#fun_ta.mom
export function mom(src: NumSeries, length: number): number[] {
  const n = src.length;
  const r: number[] = new Array(n).fill(NaN);
  for (let i = length; i < n; i++) {
    if (!isNaN(src[i]) && !isNaN(src[i - length])) r[i] = src[i] - src[i - length];
  }
  return r;
}

// ta.wpr — Williams %R — https://www.tradingview.com/pine-script-reference/v5/#fun_ta.wpr
export function wpr(high: NumSeries, low: NumSeries, close: NumSeries, length: number): number[] {
  const n = close.length;
  const r: number[] = new Array(n).fill(NaN);
  const hh = highest(high, length);
  const ll = lowest(low, length);
  for (let i = 0; i < n; i++) {
    if (isNaN(hh[i]) || isNaN(ll[i])) continue;
    const rng = hh[i] - ll[i];
    r[i] = rng === 0 ? 0 : -100 * (hh[i] - close[i]) / rng;
  }
  return r;
}

// ta.cmo — Chande Momentum Oscillator — https://www.tradingview.com/pine-script-reference/v5/#fun_ta.cmo
export function cmo(src: NumSeries, length: number): number[] {
  const n = src.length;
  const r: number[] = new Array(n).fill(NaN);
  if (n < length + 1) return r;
  for (let i = length; i < n; i++) {
    let up = 0, dn = 0;
    let valid = true;
    for (let j = i - length + 1; j <= i; j++) {
      const ch = src[j] - src[j - 1];
      if (isNaN(ch)) { valid = false; break; }
      if (ch > 0) up += ch; else dn -= ch;
    }
    if (!valid) continue;
    const sum = up + dn;
    r[i] = sum === 0 ? 0 : 100 * (up - dn) / sum;
  }
  return r;
}

// ta.bbw — Bollinger Band Width — https://www.tradingview.com/pine-script-reference/v5/#fun_ta.bbw
export function bbw(src: NumSeries, length: number, mult: number): number[] {
  const b = bollingerBands(src, length, mult);
  const n = src.length;
  const r: number[] = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!isNaN(b.basis[i]) && b.basis[i] !== 0) r[i] = (b.upper[i] - b.lower[i]) / b.basis[i];
  }
  return r;
}

// ta.kcw — Keltner Channel Width — https://www.tradingview.com/pine-script-reference/v5/#fun_ta.kcw
export function kcw(src: NumSeries, high: NumSeries, low: NumSeries, length: number, mult: number): number[] {
  const b = keltnerChannel(src, high, low, length, length, mult);
  const n = src.length;
  const r: number[] = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!isNaN(b.basis[i]) && b.basis[i] !== 0) r[i] = (b.upper[i] - b.lower[i]) / b.basis[i];
  }
  return r;
}

// ta.highestbars — https://www.tradingview.com/pine-script-reference/v5/#fun_ta.highestbars
export function highestBars(src: NumSeries, length: number): number[] {
  const n = src.length;
  const r: number[] = new Array(n).fill(NaN);
  for (let i = length - 1; i < n; i++) {
    let mx = -Infinity, mxIdx = i;
    for (let j = i - length + 1; j <= i; j++) {
      if (src[j] > mx) { mx = src[j]; mxIdx = j; }
    }
    r[i] = mxIdx - i;
  }
  return r;
}

// ta.lowestbars — https://www.tradingview.com/pine-script-reference/v5/#fun_ta.lowestbars
export function lowestBars(src: NumSeries, length: number): number[] {
  const n = src.length;
  const r: number[] = new Array(n).fill(NaN);
  for (let i = length - 1; i < n; i++) {
    let mn = Infinity, mnIdx = i;
    for (let j = i - length + 1; j <= i; j++) {
      if (src[j] < mn) { mn = src[j]; mnIdx = j; }
    }
    r[i] = mnIdx - i;
  }
  return r;
}

// ta.range — https://www.tradingview.com/pine-script-reference/v5/#fun_ta.range
export function rangeIndicator(src: NumSeries, length: number): number[] {
  const hh = highest(src, length);
  const ll = lowest(src, length);
  const n = src.length;
  const r: number[] = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!isNaN(hh[i]) && !isNaN(ll[i])) r[i] = hh[i] - ll[i];
  }
  return r;
}

// ta.variance — https://www.tradingview.com/pine-script-reference/v5/#fun_ta.variance
export function variance(src: NumSeries, length: number): number[] {
  const sd = stdev(src, length);
  const n = src.length;
  const r: number[] = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) if (!isNaN(sd[i])) r[i] = sd[i] * sd[i];
  return r;
}

// ta.correlation / ta.pearsonr — https://www.tradingview.com/pine-script-reference/v5/#fun_ta.correlation
export function correlation(s1: NumSeries, s2: NumSeries, length: number): number[] {
  const n = Math.min(s1.length, s2.length);
  const r: number[] = new Array(n).fill(NaN);
  for (let i = length - 1; i < n; i++) {
    let sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
    let valid = true;
    for (let j = i - length + 1; j <= i; j++) {
      const x = s1[j], y = s2[j];
      if (isNaN(x) || isNaN(y)) { valid = false; break; }
      sx += x; sy += y; sxy += x * y; sx2 += x * x; sy2 += y * y;
    }
    if (!valid) continue;
    const num = length * sxy - sx * sy;
    const den = Math.sqrt((length * sx2 - sx * sx) * (length * sy2 - sy * sy));
    r[i] = den === 0 ? 0 : num / den;
  }
  return r;
}

// ta.cog — Center of Gravity — https://www.tradingview.com/pine-script-reference/v5/#fun_ta.cog
export function cog(src: NumSeries, length: number): number[] {
  const n = src.length;
  const r: number[] = new Array(n).fill(NaN);
  for (let i = length - 1; i < n; i++) {
    let num = 0, den = 0;
    let valid = true;
    for (let k = 0; k < length; k++) {
      const v = src[i - k];
      if (isNaN(v)) { valid = false; break; }
      num += v * (k + 1);
      den += v;
    }
    if (valid && den !== 0) r[i] = -num / den;
  }
  return r;
}

// ta.aroon — https://www.tradingview.com/pine-script-reference/v5/#fun_ta.aroon
// Returns [upper, lower]; window of length+1 bars.
export function aroon(high: NumSeries, low: NumSeries, length: number): { upper: number[]; lower: number[] } {
  const n = high.length;
  const upper: number[] = new Array(n).fill(NaN);
  const lower: number[] = new Array(n).fill(NaN);
  const W = length + 1;
  for (let i = length; i < n; i++) {
    let mxIdx = i, mnIdx = i;
    let mx = high[i], mn = low[i];
    for (let j = i - length; j <= i; j++) {
      if (high[j] >= mx) { mx = high[j]; mxIdx = j; }
      if (low[j] <= mn) { mn = low[j]; mnIdx = j; }
    }
    const barsSinceHigh = i - mxIdx;
    const barsSinceLow = i - mnIdx;
    upper[i] = 100 * (length - barsSinceHigh) / length;
    lower[i] = 100 * (length - barsSinceLow) / length;
  }
  return { upper, lower };
}

// ta.tsi — True Strength Index — https://www.tradingview.com/pine-script-reference/v5/#fun_ta.tsi
// Pine uses ema-double-smoothed PC over abs(PC). Output in range ~[-1, 1] (not 100-scaled).
export function tsi(src: NumSeries, shortLen: number, longLen: number): number[] {
  const n = src.length;
  const pc: number[] = new Array(n).fill(NaN);
  const apc: number[] = new Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    if (!isNaN(src[i]) && !isNaN(src[i - 1])) {
      const d = src[i] - src[i - 1];
      pc[i] = d; apc[i] = Math.abs(d);
    }
  }
  const num = pineEma(pineEma(pc, longLen), shortLen);
  const den = pineEma(pineEma(apc, longLen), shortLen);
  const r: number[] = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!isNaN(num[i]) && !isNaN(den[i]) && den[i] !== 0) r[i] = num[i] / den[i];
  }
  return r;
}

// ta.vortex — https://www.tradingview.com/pine-script-reference/v5/#fun_ta.vortex
export function vortex(high: NumSeries, low: NumSeries, close: NumSeries, length: number): { viPlus: number[]; viMinus: number[] } {
  const n = close.length;
  const tr = trueRange(high, low, close);
  const vmp: number[] = new Array(n).fill(0);
  const vmn: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    vmp[i] = Math.abs(high[i] - low[i - 1]);
    vmn[i] = Math.abs(low[i] - high[i - 1]);
  }
  const viPlus: number[] = new Array(n).fill(NaN);
  const viMinus: number[] = new Array(n).fill(NaN);
  for (let i = length; i < n; i++) {
    let sP = 0, sN = 0, sT = 0;
    for (let j = i - length + 1; j <= i; j++) { sP += vmp[j]; sN += vmn[j]; sT += tr[j]; }
    if (sT !== 0) { viPlus[i] = sP / sT; viMinus[i] = sN / sT; }
  }
  return { viPlus, viMinus };
}

// ta.mode — https://www.tradingview.com/pine-script-reference/v5/#fun_ta.mode
// Returns the most frequent value in the window; ties → smallest. NaN if all NaN.
export function mode(src: NumSeries, length: number): number[] {
  const n = src.length;
  const r: number[] = new Array(n).fill(NaN);
  for (let i = length - 1; i < n; i++) {
    const counts = new Map<number, number>();
    let valid = true;
    for (let j = i - length + 1; j <= i; j++) {
      const v = src[j];
      if (isNaN(v)) { valid = false; break; }
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    if (!valid) continue;
    let best = NaN, bestC = -1;
    for (const [v, c] of counts) {
      if (c > bestC || (c === bestC && v < best)) { best = v; bestC = c; }
    }
    r[i] = best;
  }
  return r;
}

// ta.sar — Parabolic SAR (Wilder) — https://www.tradingview.com/pine-script-reference/v5/#fun_ta.sar
export function sar(high: NumSeries, low: NumSeries, start: number, increment: number, maxAcc: number): number[] {
  const n = high.length;
  const r: number[] = new Array(n).fill(NaN);
  if (n < 2) return r;
  // Initialize: assume initial uptrend, ep=first high, sar=first low, af=start.
  let isLong = true;
  let af = start;
  let ep = high[0];
  let sarVal = low[0];
  r[0] = sarVal;
  for (let i = 1; i < n; i++) {
    const prevSar = sarVal;
    sarVal = prevSar + af * (ep - prevSar);
    if (isLong) {
      // SAR cannot exceed the prior two lows.
      sarVal = Math.min(sarVal, low[i - 1], i >= 2 ? low[i - 2] : low[i - 1]);
      if (low[i] < sarVal) {
        // Flip to short.
        isLong = false;
        sarVal = ep;
        ep = low[i];
        af = start;
      } else {
        if (high[i] > ep) { ep = high[i]; af = Math.min(af + increment, maxAcc); }
      }
    } else {
      sarVal = Math.max(sarVal, high[i - 1], i >= 2 ? high[i - 2] : high[i - 1]);
      if (high[i] > sarVal) {
        isLong = true;
        sarVal = ep;
        ep = high[i];
        af = start;
      } else {
        if (low[i] < ep) { ep = low[i]; af = Math.min(af + increment, maxAcc); }
      }
    }
    r[i] = sarVal;
  }
  return r;
}
