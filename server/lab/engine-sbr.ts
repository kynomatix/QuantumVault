import type { LabTradeRecord, LabBacktestResult } from "@shared/schema";
import * as ind from "./indicators";
import type { OHLCV, EngineConfig } from "./engine";

function p(params: Record<string, any>, name: string, defaultVal: any): any {
  return params[name] !== undefined ? params[name] : defaultVal;
}

function dmi(
  high: number[],
  low: number[],
  close: number[],
  period: number,
): { diPlus: number[]; diMinus: number[]; adx: number[] } {
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

// Pine-compatible pivot high detection.
// At bar i, result[i] = high[i - rightBars] if it is a pivot high, else NaN.
// Left side: src[j] > src[pivot] disqualifies (equal is OK).
// Right side: src[j] >= src[pivot] disqualifies (equal kills it). Asymmetric by design.
function pivotHigh(src: number[], leftBars: number, rightBars: number): number[] {
  const n = src.length;
  const result = new Array(n).fill(NaN);
  for (let i = leftBars + rightBars; i < n; i++) {
    const pi = i - rightBars;
    let ok = true;
    for (let j = pi - leftBars; j < pi; j++) {
      if (src[j] > src[pi]) { ok = false; break; }
    }
    if (ok) {
      for (let j = pi + 1; j <= pi + rightBars; j++) {
        if (src[j] >= src[pi]) { ok = false; break; }
      }
    }
    if (ok) result[i] = src[pi];
  }
  return result;
}

// Pine-compatible pivot low detection.
// Left side: src[j] < src[pivot] disqualifies (equal is OK).
// Right side: src[j] <= src[pivot] disqualifies (equal kills it). Asymmetric by design.
function pivotLow(src: number[], leftBars: number, rightBars: number): number[] {
  const n = src.length;
  const result = new Array(n).fill(NaN);
  for (let i = leftBars + rightBars; i < n; i++) {
    const pi = i - rightBars;
    let ok = true;
    for (let j = pi - leftBars; j < pi; j++) {
      if (src[j] < src[pi]) { ok = false; break; }
    }
    if (ok) {
      for (let j = pi + 1; j <= pi + rightBars; j++) {
        if (src[j] <= src[pi]) { ok = false; break; }
      }
    }
    if (ok) result[i] = src[pi];
  }
  return result;
}

export function runSbrBacktest(
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

  const open   = new Array(n);
  const close  = new Array(n);
  const high   = new Array(n);
  const low    = new Array(n);
  const volume = new Array(n);
  for (let i = 0; i < n; i++) {
    open[i]   = candles[i].open;
    close[i]  = candles[i].close;
    high[i]   = candles[i].high;
    low[i]    = candles[i].low;
    volume[i] = candles[i].volume;
  }

  // Parameters
  const pivotLen       = p(params, "pivot_len",       10);
  const zoneTol        = p(params, "zone_tolerance",  0.3);
  const maxBarsRetest  = p(params, "max_bars_retest", 30);
  const useAdx         = p(params, "use_adx",         true);
  const adxLen         = p(params, "adx_len",         14);
  const adxThreshold   = p(params, "adx_threshold",   18.0);
  const useVol         = p(params, "use_vol",         true);
  const volMult        = p(params, "vol_mult",        1.3);
  const useBody        = p(params, "use_body",        true);
  const bodyPct        = p(params, "body_pct",        0.45);
  const cooldownBars   = p(params, "cooldown_bars",   5);
  const atrLen         = p(params, "atr_len",         14);
  const slAtrMult      = p(params, "sl_atr_mult",     1.5);
  const tp1Atr         = p(params, "tp1_atr",         2.0);
  const useTrail       = p(params, "use_trail",       true);
  const trailAtrMult   = p(params, "trail_atr_mult",  2.0);
  const trailTrigger   = p(params, "trail_trigger",   1.5);
  const tradeDir       = p(params, "trade_dir",       "Both");
  const allowLong      = tradeDir === "Both" || tradeDir === "Long Only";
  const allowShort     = tradeDir === "Both" || tradeDir === "Short Only";

  // Date filter (matches Flux Momentum convention)
  const useDateFilter  = p(params, "useDateFilter",   false);
  const backtestStart  = p(params, "backtestStart",   null);
  const backtestEnd    = p(params, "backtestEnd",     null);
  let dateStartMs = 0;
  let dateEndMs   = Infinity;
  if (useDateFilter) {
    if (backtestStart) {
      const parsed = typeof backtestStart === "string" ? Date.parse(backtestStart) : Number(backtestStart);
      if (Number.isFinite(parsed)) dateStartMs = parsed;
    }
    if (backtestEnd) {
      const parsed = typeof backtestEnd === "string" ? Date.parse(backtestEnd) : Number(backtestEnd);
      if (Number.isFinite(parsed)) dateEndMs = parsed;
    }
  }

  // Precompute indicators
  const atrArr  = ind.atr(high, low, close, atrLen);
  const adxVals = dmi(high, low, close, adxLen);
  const volMaArr = ind.sma(volume, 20);
  const phArr   = pivotHigh(high, pivotLen, pivotLen);
  const plArr   = pivotLow(low,   pivotLen, pivotLen);

  // Config
  const posSize    = config.positionSize   || 1000;
  const commission = config.commission     || 0.0005;
  const initCap    = config.initialCapital || 1000;

  // Accounting
  let equity    = initCap;
  let peakEq    = initCap;
  let maxDD     = 0;
  const trades: LabTradeRecord[] = [];
  const equityValues = new Array(n).fill(initCap);

  // BOS + swing state
  let lastSwingHigh = NaN;
  let lastSwingLow  = NaN;
  let bosBull       = false;
  let bosBear       = false;
  let bosLevelBull  = NaN;
  let bosLevelBear  = NaN;
  let bosBarBull    = -999;
  let bosBarBear    = -999;
  let lastTradeBar  = -999;

  // Position & pending entry
  interface Position {
    dir: "long" | "short";
    entryBar: number;
    entryPrice: number;
    entryTime: number;
    trailActivated: boolean;
    trailExtreme: number;
  }

  interface PendingEntry {
    dir: "long" | "short";
    fillBar: number;
  }

  let position: Position | null     = null;
  let pendingEntry: PendingEntry | null = null;

  for (let i = 0; i < n; i++) {
    const time = candles[i].time;

    // ── 1. Fill pending market entry at this bar's open ─────────────────────
    if (pendingEntry && pendingEntry.fillBar === i) {
      const entryPrice = open[i];
      position = {
        dir: pendingEntry.dir,
        entryBar: i,
        entryPrice,
        entryTime: time,
        trailActivated: false,
        trailExtreme: entryPrice,
      };
      pendingEntry = null;
    }

    // ── 2. Track whether we're in a trade at bar start (Pine semantics) ─────
    //    Used for BOS detection: exits are intrabar, but Pine sees the pre-exit
    //    position_size when running the script at bar start.
    const wasInTrade = position !== null;

    // ── 3. Process intrabar exits ───────────────────────────────────────────
    if (position !== null) {
      const { dir, entryPrice } = position;
      const h = high[i];
      const l = low[i];
      const o = open[i];
      const atr = atrArr[i];

      // Dynamic SL/TP/trail levels recomputed each bar from current ATR
      // (Pine calls strategy.exit every bar with updated levels)
      const sl            = dir === "long" ? entryPrice - slAtrMult * atr    : entryPrice + slAtrMult * atr;
      const tp            = dir === "long" ? entryPrice + tp1Atr * atr       : entryPrice - tp1Atr * atr;
      const trailActPrice = dir === "long" ? entryPrice + trailTrigger * atr  : entryPrice - trailTrigger * atr;
      const trailOffset   = trailAtrMult * atr;

      let exitPrice: number | null = null;
      let exitReason = "";

      // Gap open beyond SL
      if (dir === "long" && o <= sl) {
        exitPrice = o; exitReason = "sl";
      } else if (dir === "short" && o >= sl) {
        exitPrice = o; exitReason = "sl";
      }

      if (exitPrice === null) {
        // Update trail before checking stops
        if (useTrail && !isNaN(atr)) {
          if (!position.trailActivated) {
            if (dir === "long"  && h >= trailActPrice) { position.trailActivated = true; position.trailExtreme = h; }
            if (dir === "short" && l <= trailActPrice) { position.trailActivated = true; position.trailExtreme = l; }
          }
          if (position.trailActivated) {
            position.trailExtreme = dir === "long"
              ? Math.max(position.trailExtreme, h)
              : Math.min(position.trailExtreme, l);
          }
        }

        const trailStop = position.trailActivated
          ? (dir === "long" ? position.trailExtreme - trailOffset : position.trailExtreme + trailOffset)
          : NaN;

        // SL
        if      (dir === "long"  && l <= sl) { exitPrice = sl; exitReason = "sl"; }
        else if (dir === "short" && h >= sl) { exitPrice = sl; exitReason = "sl"; }

        // TP (only if SL not hit)
        if (exitPrice === null) {
          if      (dir === "long"  && h >= tp) { exitPrice = tp; exitReason = "tp"; }
          else if (dir === "short" && l <= tp) { exitPrice = tp; exitReason = "tp"; }
        }

        // Trail (only if SL and TP not hit)
        if (exitPrice === null && position.trailActivated && !isNaN(trailStop)) {
          if      (dir === "long"  && l <= trailStop) { exitPrice = trailStop; exitReason = "trail"; }
          else if (dir === "short" && h >= trailStop) { exitPrice = trailStop; exitReason = "trail"; }
        }
      }

      // Forced close at date range end
      if (exitPrice === null && useDateFilter && time > dateEndMs) {
        exitPrice = o; exitReason = "date_end";
      }

      if (exitPrice !== null) {
        const pnlPct    = dir === "long"
          ? (exitPrice - entryPrice) / entryPrice * 100
          : (entryPrice - exitPrice) / entryPrice * 100;
        const pnlDollar = posSize * (pnlPct / 100) - 2 * posSize * commission;
        equity  += pnlDollar;
        peakEq   = Math.max(peakEq, equity);
        maxDD    = Math.max(maxDD, (peakEq - equity) / peakEq * 100);
        trades.push({
          entryTime:  new Date(position.entryTime).toISOString(),
          exitTime:   new Date(time).toISOString(),
          direction:  dir,
          entryPrice,
          exitPrice:  Math.round(exitPrice * 10000) / 10000,
          pnlPercent: Math.round(pnlPct * 100) / 100,
          pnlDollar:  Math.round(pnlDollar * 100) / 100,
          exitReason,
          barsHeld:   i - position.entryBar,
        });
        position = null;
      }
    }

    // Equity snapshot (unrealized if still in position)
    if (position !== null) {
      const unrealized = position.dir === "long"
        ? (close[i] - position.entryPrice) / position.entryPrice * posSize
        : (position.entryPrice - close[i]) / position.entryPrice * posSize;
      equityValues[i] = equity + unrealized;
    } else {
      equityValues[i] = equity;
    }

    // ── 4. Update swing levels from precomputed pivot arrays ─────────────────
    if (!isNaN(phArr[i])) lastSwingHigh = phArr[i];
    if (!isNaN(plArr[i])) lastSwingLow  = plArr[i];

    // ── 5. BOS detection (only when flat at bar START — matches Pine semantics)
    if (!wasInTrade && pendingEntry === null) {
      if (!isNaN(lastSwingHigh) && close[i] > lastSwingHigh && !bosBull) {
        bosBull = true; bosLevelBull = lastSwingHigh; bosBarBull = i;
      }
      if (!isNaN(lastSwingLow) && close[i] < lastSwingLow && !bosBear) {
        bosBear = true; bosLevelBear = lastSwingLow; bosBarBear = i;
      }
    }

    // ── 6. Structure invalidation (runs AFTER retest check so last valid bar counts)
    if (bosBull && (i - bosBarBull) > maxBarsRetest) bosBull = false;
    if (bosBear && (i - bosBarBear) > maxBarsRetest) bosBear = false;

    // ── 7. Entry conditions ───────────────────────────────────────────────────
    const inDateRange = !useDateFilter || (time >= dateStartMs && time <= dateEndMs);
    if (position === null && pendingEntry === null && inDateRange) {
      const atr = atrArr[i];
      if (isNaN(atr) || atr <= 0) continue;

      const adxOk = !useAdx || (!isNaN(adxVals.adx[i]) && adxVals.adx[i] > adxThreshold);
      const volMa = volMaArr[i];
      const volOk = !useVol || (!isNaN(volMa) && volume[i] > volMa * volMult);
      const bodySize = Math.abs(close[i] - open[i]);
      const rangeSize = high[i] - low[i];
      const bodyOk = !useBody || (rangeSize > 0 && bodySize / rangeSize >= bodyPct);
      const cooldownOk = (i - lastTradeBar) >= cooldownBars;

      // Bullish retest: low dips into zone, close above BOS level
      if (bosBull && allowLong && adxOk && volOk && bodyOk && cooldownOk) {
        const zoneTop = bosLevelBull + zoneTol * atr;
        if ((i - bosBarBull) <= maxBarsRetest && low[i] <= zoneTop && close[i] > bosLevelBull) {
          pendingEntry = { dir: "long", fillBar: i + 1 };
          lastTradeBar = i;
          bosBull = false;
        }
      }

      // Bearish retest: high touches zone, close below BOS level
      if (bosBear && allowShort && adxOk && volOk && bodyOk && cooldownOk && pendingEntry === null) {
        const zoneBot = bosLevelBear - zoneTol * atr;
        if ((i - bosBarBear) <= maxBarsRetest && high[i] >= zoneBot && close[i] < bosLevelBear) {
          pendingEntry = { dir: "short", fillBar: i + 1 };
          lastTradeBar = i;
          bosBear = false;
        }
      }
    }
  }

  // Close any still-open position at last bar close
  if (position !== null) {
    const lastClose = close[n - 1];
    const pnlPct    = position.dir === "long"
      ? (lastClose - position.entryPrice) / position.entryPrice * 100
      : (position.entryPrice - lastClose) / position.entryPrice * 100;
    const pnlDollar = posSize * (pnlPct / 100) - 2 * posSize * commission;
    equity += pnlDollar;
    trades.push({
      entryTime:  new Date(position.entryTime).toISOString(),
      exitTime:   new Date(candles[n - 1].time).toISOString(),
      direction:  position.dir,
      entryPrice: position.entryPrice,
      exitPrice:  Math.round(lastClose * 10000) / 10000,
      pnlPercent: Math.round(pnlPct * 100) / 100,
      pnlDollar:  Math.round(pnlDollar * 100) / 100,
      exitReason: "Open Position",
      barsHeld:   n - 1 - position.entryBar,
    });
  }

  // Summary stats
  let winCount = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const t of trades) {
    if (t.pnlDollar > 0) { winCount++; grossProfit += t.pnlDollar; }
    else { grossLoss -= t.pnlDollar; }
  }

  const netProfitPercent = ((equity - initCap) / initCap) * 100;

  // Equity curve (sampled)
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
    netProfitPercent:  Math.round(netProfitPercent * 100) / 100,
    winRatePercent:    trades.length > 0 ? Math.round((winCount / trades.length) * 10000) / 100 : 0,
    maxDrawdownPercent: Math.round(maxDD * 100) / 100,
    profitFactor:      grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : (grossProfit > 0 ? 999 : 0),
    totalTrades:       trades.length,
    params,
    trades,
    equityCurve,
  };
}
