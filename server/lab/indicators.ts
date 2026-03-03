export function sma(data: number[], period: number): number[] {
  const result: number[] = new Array(data.length).fill(NaN);
  if (period <= 0 || data.length < period) return result;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i];
  result[period - 1] = sum / period;
  for (let i = period; i < data.length; i++) {
    sum += data[i] - data[i - period];
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

export function wma(data: number[], period: number): number[] {
  const result: number[] = new Array(data.length).fill(NaN);
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += data[i - period + 1 + j] * (j + 1);
    }
    result[i] = sum / denom;
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
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < period; i++) {
    sum += data[i];
    sumSq += data[i] * data[i];
  }
  result[period - 1] = Math.sqrt((sumSq - (sum * sum) / period) / period);
  for (let i = period; i < data.length; i++) {
    const old = data[i - period];
    sum += data[i] - old;
    sumSq += data[i] * data[i] - old * old;
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
  return ema(tr, period);
}

export function keltnerChannel(close: number[], high: number[], low: number[], emaLen: number, atrLen: number, mult: number): { upper: number[]; basis: number[]; lower: number[] } {
  const basis = ema(close, emaLen);
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
  const smoothPlusDM = ema(plusDM, period);
  const smoothMinusDM = ema(minusDM, period);
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
  const adxVals = ema(dx, period);
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
