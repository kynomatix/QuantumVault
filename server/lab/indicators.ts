export function sma(data: number[], period: number): number[] {
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

export function ema(data: number[], period: number): number[] {
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

export function pineEma(data: number[], period: number): number[] {
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

export function rma(data: number[], period: number): number[] {
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

export function wma(data: number[], period: number): number[] {
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

export function hullMa(data: number[], period: number): number[] {
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

export function stdev(data: number[], period: number): number[] {
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

export function bollingerBands(data: number[], period: number, mult: number): { upper: number[]; basis: number[]; lower: number[] } {
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

export function trueRange(high: number[], low: number[], close: number[]): number[] {
  const result: number[] = [high[0] - low[0]];
  for (let i = 1; i < high.length; i++) {
    const hl = high[i] - low[i];
    const hc = Math.abs(high[i] - close[i - 1]);
    const lc = Math.abs(low[i] - close[i - 1]);
    result.push(Math.max(hl, hc, lc));
  }
  return result;
}

export function atr(high: number[], low: number[], close: number[], period: number): number[] {
  const tr = trueRange(high, low, close);
  return rma(tr, period);
}

export function keltnerChannel(close: number[], high: number[], low: number[], smaLen: number, atrLen: number, mult: number): { upper: number[]; basis: number[]; lower: number[] } {
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

export function rsi(data: number[], period: number): number[] {
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

export function adx(high: number[], low: number[], close: number[], period: number): number[] {
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

export function linreg(data: number[], period: number): number[] {
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

export function volumeSma(volume: number[], period: number): number[] {
  return sma(volume, period);
}

export function squeeze(bbUpper: number[], bbLower: number[], kcUpper: number[], kcLower: number[]): boolean[] {
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

export function highest(data: number[], period: number): number[] {
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

export function lowest(data: number[], period: number): number[] {
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

export function percentRank(data: number[], period: number): number[] {
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

export function bbWidth(bbUpper: number[], bbLower: number[], bbBasis: number[]): number[] {
  const n = bbUpper.length;
  const result: number[] = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!isNaN(bbUpper[i]) && !isNaN(bbLower[i]) && !isNaN(bbBasis[i]) && bbBasis[i] !== 0) {
      result[i] = ((bbUpper[i] - bbLower[i]) / bbBasis[i]) * 100;
    }
  }
  return result;
}

export function vwma(src: number[], volume: number[], period: number): number[] {
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

export function hma(src: number[], period: number): number[] {
  return hullMa(src, period);
}

export function dema(src: number[], period: number): number[] {
  const e1 = pineEma(src, period);
  const e2 = pineEma(e1, period);
  const n = src.length;
  const result: number[] = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!isNaN(e1[i]) && !isNaN(e2[i])) result[i] = 2 * e1[i] - e2[i];
  }
  return result;
}

export function tema(src: number[], period: number): number[] {
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

export function alma(src: number[], period: number, offset: number, sigma: number): number[] {
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

export function swma(src: number[]): number[] {
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

export function cci(src: number[], period: number): number[] {
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

export function macd(src: number[], fast: number, slow: number, signalPeriod: number): { macd: number[]; signal: number[]; hist: number[] } {
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

export function supertrend(high: number[], low: number[], close: number[], factor: number, atrPeriod: number): { supertrend: number[]; direction: number[] } {
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

export function percentileNearestRank(data: number[], period: number, percentage: number): number[] {
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

export function percentileLinearInterpolation(data: number[], period: number, percentage: number): number[] {
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
