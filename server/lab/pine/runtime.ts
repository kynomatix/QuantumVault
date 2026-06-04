import type { Expr, Stmt } from "./parser";
import type { LabTradeRecord, LabBacktestResult } from "@shared/schema";
import * as ind from "../indicators";
import { compilePineHotLoop, TA_WHITELIST, type CompilerContext } from "./compiler";

export const TA_IMPL_REGISTRY: ReadonlySet<string> = new Set([
  "crossover", "crossunder", "cross", "change", "rising", "falling",
  "sma", "ema", "wma", "linreg", "rma", "vwma", "swma", "hma", "dema", "tema", "alma",
  "rsi", "cci", "mfi", "roc", "dev", "median", "percentrank", "cum",
  "stoch", "macd", "bb", "kc", "atr", "tr", "adx", "supertrend", "dmi",
  "highest", "lowest", "barssince", "valuewhen", "pivothigh", "pivotlow",
  "percentile_nearest_rank", "percentile_linear_interpolation",
  "vwap",
  // TV v5 parity additions (session_plan.md T001-T003):
  "obv", "sar", "aroon", "tsi", "wpr", "bbw", "kcw", "mom",
  "accdist", "ad", "highestbars", "lowestbars",
  "cmo", "bop", "cog", "correlation", "pearsonr", "variance",
  "pvt", "nvi", "pvi", "iii", "wad", "vortex", "range", "mode",
]);

(function assertTaParity() {
  const missing: string[] = [];
  for (const name of TA_WHITELIST) {
    if (!TA_IMPL_REGISTRY.has(name)) missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error(
      `[Pine] TA whitelist/runtime parity violation — compiler whitelists these ta.* functions but runtime has no implementation: ${missing.join(", ")}. ` +
      `Add cases to evalTaCall (and supporting paths) in runtime.ts, then add the name to TA_IMPL_REGISTRY.`
    );
  }
  const extras: string[] = [];
  for (const name of TA_IMPL_REGISTRY) {
    if (!TA_WHITELIST.has(name)) extras.push(name);
  }
  if (extras.length > 0) {
    throw new Error(
      `[Pine] TA registry has names not in compiler whitelist: ${extras.join(", ")}. ` +
      `Add to TA_WHITELIST in compiler.ts or remove from TA_IMPL_REGISTRY.`
    );
  }
})();

export interface OHLCV {
  time: number; open: number; high: number; low: number; close: number; volume: number;
}

export interface PineEngineConfig {
  initialCapital: number;
  commission: number;
  positionSize: number;
  processOrdersOnClose?: boolean;
}

// NA represents PineScript's "na" value — intentionally typed as any since it
// substitutes for any Pine type (number, bool, string) in the dynamic runtime.
const NA: any = null;
function isNa(v: any): boolean { return v === null || v === undefined || (typeof v === 'number' && isNaN(v)); }
function toNum(v: any): number { return isNa(v) ? NaN : Number(v); }

interface PendingExit {
  id: string;
  fromEntry: string;
  stop: number | null;
  limit: number | null;
  trailPrice: number | null;
  trailOffset: number | null;
  qtyPercent: number;
  trailActivated: boolean;
  trailExtreme: number;
}

interface PendingEntry {
  id: string;
  direction: "long" | "short";
  bar: number;
  time: number;
}

interface Position {
  direction: "long" | "short";
  size: number;
  avgPrice: number;
  entryBar: number;
  entryTime: number;
  entries: { id: string; qty: number; price: number; bar: number }[];
}

class Broker {
  position: Position | null = null;
  pendingExits: PendingExit[] = [];
  pendingEntries: PendingEntry[] = [];
  pendingCloses: { id: string; qtyPercent: number; comment: string; isCloseAll: boolean }[] = [];
  trades: LabTradeRecord[] = [];
  equity: number;
  private config: PineEngineConfig;
  private _posSizeHistory: number[] = [];

  constructor(config: PineEngineConfig) {
    this.config = config;
    this.equity = config.initialCapital;
  }

  get positionSize(): number { return this.position ? (this.position.direction === "long" ? this.position.size : -this.position.size) : 0; }
  get positionAvgPrice(): number { return this.position ? this.position.avgPrice : NaN; }

  snapshotPositionSize(bar: number) { this._posSizeHistory[bar] = this.positionSize; }
  getPositionSizeHistory(offset: number, currentBar?: number): number {
    const bar = currentBar !== undefined ? currentBar : this._posSizeHistory.length - 1;
    const idx = bar - offset;
    return idx >= 0 ? (this._posSizeHistory[idx] ?? 0) : 0;
  }

  queueEntry(id: string, direction: "long" | "short", bar: number, time: number) {
    this.pendingEntries = this.pendingEntries.filter(e => e.id !== id);
    this.pendingEntries.push({ id, direction, bar, time });
  }

  fillPendingEntries(price: number, bar: number, time: number) {
    for (const pe of this.pendingEntries) {
      this.applyEntry(pe.id, pe.direction, bar, price, time);
    }
    this.pendingEntries = [];
  }

  queueClose(id: string, qtyPercent: number, comment: string, isCloseAll: boolean) {
    if (isCloseAll) {
      this.pendingCloses = [{ id, qtyPercent, comment, isCloseAll }];
      return;
    }
    const existing = this.pendingCloses.findIndex(pc => pc.id === id && !pc.isCloseAll);
    if (existing >= 0) {
      this.pendingCloses[existing] = { id, qtyPercent, comment, isCloseAll };
    } else {
      this.pendingCloses.push({ id, qtyPercent, comment, isCloseAll });
    }
  }

  fillPendingCloses(price: number, bar: number, time: number) {
    for (const pc of this.pendingCloses) {
      if (pc.isCloseAll) {
        this.closeAll(bar, price, time, pc.comment);
      } else {
        this.close(pc.id, bar, price, time, pc.qtyPercent, pc.comment);
      }
    }
    this.pendingCloses = [];
  }

  applyEntry(id: string, direction: "long" | "short", bar: number, price: number, time: number) {
    if (this.position && this.position.direction !== direction) {
      this.closeAll(bar, price, time, "Reversal");
    }
    if (!this.position) {
      this.position = {
        direction, size: 1, avgPrice: price, entryBar: bar, entryTime: time,
        entries: [{ id, qty: 1, price, bar }],
      };
      this.pendingExits = [];
    }
  }

  close(id: string, bar: number, price: number, time: number, qtyPercent: number = 100, comment: string = "") {
    if (!this.position) return;
    if (id && this.position.entries.length > 0) {
      const hasMatch = this.position.entries.some(e => e.id === id);
      if (!hasMatch) return;
    }
    const closeQty = Math.min(this.position.size, this.position.size * (qtyPercent / 100));
    if (closeQty <= 0) return;
    this.recordClose(closeQty, price, bar, time, comment || "Close");
  }

  closeAll(bar: number, price: number, time: number, reason: string = "Close All") {
    if (!this.position) return;
    this.recordClose(this.position.size, price, bar, time, reason);
  }

  addExit(id: string, fromEntry: string, stop: number | null, limit: number | null,
          trailPrice: number | null, trailOffset: number | null, qtyPercent: number) {
    const existing = this.pendingExits.findIndex(e => e.id === id);
    const exit: PendingExit = {
      id, fromEntry,
      stop: isNa(stop) ? null : stop,
      limit: isNa(limit) ? null : limit,
      trailPrice: isNa(trailPrice) ? null : trailPrice,
      trailOffset: isNa(trailOffset) ? null : trailOffset,
      qtyPercent: isNa(qtyPercent) ? 100 : qtyPercent,
      trailActivated: false,
      trailExtreme: 0,
    };
    if (existing >= 0) {
      const old = this.pendingExits[existing];
      exit.trailActivated = old.trailActivated;
      exit.trailExtreme = old.trailExtreme;
      this.pendingExits[existing] = exit;
    } else {
      this.pendingExits.push(exit);
    }
  }

  evaluateExits(bar: number, o: number, h: number, l: number, c: number, time: number) {
    if (!this.position || this.pendingExits.length === 0) return;
    const isLong = this.position.direction === "long";
    const toRemove: number[] = [];
    const originalSize = this.position.size;

    const entryIds = new Set(this.position.entries.map(e => e.id));
    const remainingByEntry = new Map<string, number>();
    const effectiveQty: number[] = [];
    for (const ex of this.pendingExits) {
      const key = ex.fromEntry || "__all__";
      const isEligible = !ex.fromEntry || entryIds.has(ex.fromEntry);
      if (!isEligible) {
        effectiveQty.push(0);
        continue;
      }
      const remaining = remainingByEntry.get(key) ?? 100;
      const qp = (isNaN(ex.qtyPercent) || ex.qtyPercent < 0) ? 100 : ex.qtyPercent;
      const eff = Math.min(qp, remaining);
      effectiveQty.push(eff);
      remainingByEntry.set(key, Math.max(0, remaining - eff));
    }

    for (let i = 0; i < this.pendingExits.length; i++) {
      const ex = this.pendingExits[i];
      if (!this.position) break;

      if (effectiveQty[i] <= 0) continue;

      let fillPrice: number | null = null;
      let reason = ex.id;

      if (ex.stop !== null) {
        if (isLong && l <= ex.stop) { fillPrice = Math.min(o, ex.stop); reason = "Stop"; }
        if (!isLong && h >= ex.stop) { fillPrice = Math.max(o, ex.stop); reason = "Stop"; }
      }

      if (fillPrice === null && ex.limit !== null) {
        if (isLong && h >= ex.limit) { fillPrice = Math.max(o, ex.limit); reason = "TP"; }
        if (!isLong && l <= ex.limit) { fillPrice = Math.min(o, ex.limit); reason = "TP"; }
      }

      if (fillPrice === null && ex.trailPrice !== null && ex.trailOffset !== null) {
        const wasActivated = ex.trailActivated;
        if (!ex.trailActivated) {
          if (isLong && h >= ex.trailPrice) { ex.trailActivated = true; ex.trailExtreme = h; }
          if (!isLong && l <= ex.trailPrice) { ex.trailActivated = true; ex.trailExtreme = l; }
        }
        if (ex.trailActivated) {
          if (isLong) {
            ex.trailExtreme = Math.max(ex.trailExtreme, h);
            const trailStop = ex.trailExtreme - ex.trailOffset;
            if (l <= trailStop) {
              fillPrice = wasActivated ? Math.min(o, trailStop) : trailStop;
              reason = "Trail";
            }
          } else {
            ex.trailExtreme = Math.min(ex.trailExtreme, l);
            const trailStop = ex.trailExtreme + ex.trailOffset;
            if (h >= trailStop) {
              fillPrice = wasActivated ? Math.max(o, trailStop) : trailStop;
              reason = "Trail";
            }
          }
        }
      }

      if (fillPrice !== null && this.position) {
        const closeQty = originalSize * (effectiveQty[i] / 100);
        this.recordClose(Math.min(closeQty, this.position.size), fillPrice, bar, time, reason);
        if (!this.position) {
          toRemove.push(i);
          break;
        }
        if (ex.stop !== null && ex.limit !== null && reason === "TP") {
          ex.limit = null;
          ex.qtyPercent = 100;
        } else if (ex.stop !== null && ex.limit !== null && reason === "Stop") {
          ex.stop = null;
          ex.qtyPercent = 100;
        } else {
          toRemove.push(i);
        }
      }
    }

    for (let i = toRemove.length - 1; i >= 0; i--) {
      this.pendingExits.splice(toRemove[i], 1);
    }
  }

  private recordClose(qty: number, price: number, bar: number, time: number, reason: string) {
    if (!this.position) return;
    const pos = this.position;
    const isLong = pos.direction === "long";
    const grossPnlPct = isLong
      ? ((price - pos.avgPrice) / pos.avgPrice) * 100
      : ((pos.avgPrice - price) / pos.avgPrice) * 100;
    const pnlDollar = qty * this.config.positionSize * (grossPnlPct / 100)
      - 2 * qty * this.config.positionSize * this.config.commission;
    // Report pnlPercent NET of commission so it matches TV's "Net P&L %" column.
    // 2× commission accounts for the entry + exit fee charged on this slice.
    const netPnlPct = grossPnlPct - 2 * this.config.commission * 100;
    this.equity += pnlDollar;
    this.trades.push({
      entryTime: new Date(pos.entryTime).toISOString(),
      exitTime: new Date(time).toISOString(),
      direction: pos.direction,
      entryPrice: pos.avgPrice,
      exitPrice: price,
      pnlPercent: Math.round(netPnlPct * 100) / 100,
      pnlDollar: Math.round(pnlDollar * 100) / 100,
      exitReason: reason,
      barsHeld: bar - pos.entryBar,
    });
    pos.size -= qty;
    if (pos.size <= 0.0001) {
      this.position = null;
      this.pendingExits = [];
    }
  }

  getEquityWithUnrealized(price: number): number {
    if (!this.position) return this.equity;
    const isLong = this.position.direction === "long";
    const pnl = isLong
      ? ((price - this.position.avgPrice) / this.position.avgPrice) * this.position.size * this.config.positionSize
      : ((this.position.avgPrice - price) / this.position.avgPrice) * this.position.size * this.config.positionSize;
    return this.equity + pnl;
  }
}

type Series = Float64Array | number[];
interface PrecomputedSeries { [name: string]: Series }

export interface PineSharedArrays {
  n: number;
  openArr: Float64Array;
  highArr: Float64Array;
  lowArr: Float64Array;
  closeArr: Float64Array;
  volArr: Float64Array;
  hl2Arr: Float64Array;
  hlc3Arr: Float64Array;
  ohlc4Arr: Float64Array;
  numHighArr: Float64Array | number[];
  numLowArr: Float64Array | number[];
  numCloseArr: Float64Array | number[];
}

export function createSharedArrays(candles: OHLCV[]): PineSharedArrays {
  const n = candles.length;
  const openArr = new Float64Array(n);
  const highArr = new Float64Array(n);
  const lowArr = new Float64Array(n);
  const closeArr = new Float64Array(n);
  const volArr = new Float64Array(n);
  const hl2Arr = new Float64Array(n);
  const hlc3Arr = new Float64Array(n);
  const ohlc4Arr = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    openArr[i] = c.open; highArr[i] = c.high; lowArr[i] = c.low;
    closeArr[i] = c.close; volArr[i] = c.volume;
    hl2Arr[i] = (c.high + c.low) / 2;
    hlc3Arr[i] = (c.high + c.low + c.close) / 3;
    ohlc4Arr[i] = (c.open + c.high + c.low + c.close) / 4;
  }
  return {
    n, openArr, highArr, lowArr, closeArr, volArr, hl2Arr, hlc3Arr, ohlc4Arr,
    numHighArr: highArr,
    numLowArr: lowArr,
    numCloseArr: closeArr,
  };
}

export function executePine(
  ast: Stmt[],
  candles: OHLCV[],
  rawParams: Record<string, any>,
  ticker: string,
  timeframe: string,
  config: PineEngineConfig,
  shared?: PineSharedArrays,
  sharedIndicatorCache?: Map<string, any>,
  forceInterpreter?: boolean,
): LabBacktestResult {
  const params: Record<string, any> = {};
  for (const [k, v] of Object.entries(rawParams)) {
    if (typeof v === "string") {
      const tsMatch = v.match(/^timestamp\(\s*"(.+?)"\s*\)?$/);
      if (tsMatch) {
        const d = Date.parse(tsMatch[1]);
        params[k] = isNaN(d) ? v : d;
        continue;
      }
    }
    params[k] = v;
  }
  const n = shared?.n ?? candles.length;
  if (n < 10) {
    return { ticker, timeframe, netProfitPercent: 0, winRatePercent: 0, maxDrawdownPercent: 0, profitFactor: 0, totalTrades: 0, params, trades: [], equityCurve: [] };
  }

  let openArr: Float64Array, highArr: Float64Array, lowArr: Float64Array,
      closeArr: Float64Array, volArr: Float64Array, hl2Arr: Float64Array,
      hlc3Arr: Float64Array, ohlc4Arr: Float64Array;
  if (shared) {
    openArr = shared.openArr; highArr = shared.highArr; lowArr = shared.lowArr;
    closeArr = shared.closeArr; volArr = shared.volArr; hl2Arr = shared.hl2Arr;
    hlc3Arr = shared.hlc3Arr; ohlc4Arr = shared.ohlc4Arr;
  } else {
    openArr = new Float64Array(n); highArr = new Float64Array(n);
    lowArr = new Float64Array(n); closeArr = new Float64Array(n);
    volArr = new Float64Array(n); hl2Arr = new Float64Array(n);
    hlc3Arr = new Float64Array(n); ohlc4Arr = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const c = candles[i];
      openArr[i] = c.open; highArr[i] = c.high; lowArr[i] = c.low;
      closeArr[i] = c.close; volArr[i] = c.volume;
      hl2Arr[i] = (c.high + c.low) / 2;
      hlc3Arr[i] = (c.high + c.low + c.close) / 3;
      ohlc4Arr[i] = (c.open + c.high + c.low + c.close) / 4;
    }
  }

  const builtinSeries: Record<string, number[] | Float64Array> = {
    close: closeArr, open: openArr, high: highArr, low: lowArr,
    volume: volArr, hl2: hl2Arr, hlc3: hlc3Arr, ohlc4: ohlc4Arr,
  };

  const numHighArr: Float64Array | number[] = shared?.numHighArr ?? highArr;
  const numLowArr: Float64Array | number[] = shared?.numLowArr ?? lowArr;
  const numCloseArr: Float64Array | number[] = shared?.numCloseArr ?? closeArr;

  const broker = new Broker(config);
  const vars: Record<string, any[]> = {};
  const varIsVar: Set<string> = new Set();
  const precomputed: PrecomputedSeries = {};
  const indicatorCache: Map<string, any> = sharedIndicatorCache ?? new Map();
  const dynNumArrays: Map<string, number[]> = new Map();
  let _lastFullSeries: number[] | null = null;
  const inputDefaults: Record<string, any> = {};
  const userFunctions: Record<string, { params: string[]; body: Stmt[] }> = {};
  let currentBar = 0;
  let opsThrottle = 0;
  let totalOps = 0;
  const MAX_OPS = 500000;
  const MAX_TOTAL_OPS = 150_000_000;

  const allSeries: Map<string, ArrayLike<any>> = new Map();
  for (const [k, v] of Object.entries(builtinSeries)) allSeries.set(k, v);

  const numSeriesCache: Map<string, Float64Array | number[]> = new Map<string, Float64Array | number[]>([
    ["high", numHighArr], ["low", numLowArr], ["close", numCloseArr],
  ]);
  function toNumArr(name: string): Float64Array | number[] {
    let cached = numSeriesCache.get(name);
    if (cached) return cached;
    const src = builtinSeries[name];
    if (src) { numSeriesCache.set(name, src); return src; }
    const pc = precomputed[name];
    if (pc) return pc;
    return [];
  }

  function setVar(name: string, value: any) {
    let arr = vars[name];
    if (!arr) {
      arr = new Array(n);
      vars[name] = arr;
      allSeries.set(name, arr);
    }
    arr[currentBar] = value;
  }

  function getVar(name: string, offset: number): any {
    const idx = currentBar - offset;
    if (idx < 0) return NA;
    const s = allSeries.get(name);
    if (s) {
      const v = s[idx];
      return v === undefined || (typeof v === 'number' && v !== v) ? NA : v;
    }
    return NA;
  }

  function resolveConst(e: Expr): any {
    if (e.k === "num") return e.v;
    if (e.k === "str") return e.v;
    if (e.k === "bool") return e.v;
    if (e.k === "na") return NA;
    if (e.k === "id") {
      if (params[e.name] !== undefined) return params[e.name];
      if (inputDefaults[e.name] !== undefined) return inputDefaults[e.name];
      return undefined;
    }
    if (e.k === "un") {
      const inner = resolveConst(e.e);
      if (inner === undefined) return undefined;
      if (e.op === "-" && typeof inner === "number") return -inner;
      if (e.op === "not") return !inner;
    }
    if (e.k === "bin") {
      const l = resolveConst(e.l);
      const r = resolveConst(e.r);
      if (l !== undefined && r !== undefined) return evalBinOp(e.op, l, r);
    }
    if (e.k === "tern") {
      const c = resolveConst(e.c);
      if (c !== undefined) return resolveConst(c ? e.t : e.f);
    }
    if (e.k === "call" && e.fn.k === "mem" && e.fn.obj.k === "id" && e.fn.obj.name === "math") {
      const mathFn = e.fn.prop;
      const constArgs = e.args.map(a => resolveConst(a));
      if (constArgs.every((a: any) => typeof a === "number")) {
        const fn = (Math as any)[mathFn];
        if (typeof fn === "function") return fn(...constArgs);
      }
    }
    if (e.k === "call" && e.fn.k === "id" && e.fn.name === "timestamp") {
      const tsArgs = e.args.map(a => resolveConst(a));
      if (tsArgs.length >= 3 && tsArgs.every((a: any) => typeof a === "number")) {
        return Date.UTC(tsArgs[0], tsArgs[1] - 1, tsArgs[2],
          tsArgs.length > 3 ? tsArgs[3] : 0,
          tsArgs.length > 4 ? tsArgs[4] : 0,
          tsArgs.length > 5 ? tsArgs[5] : 0);
      }
      if (tsArgs.length === 1 && typeof tsArgs[0] === "string") {
        const d = Date.parse(tsArgs[0]);
        return isNaN(d) ? undefined : d;
      }
    }
    if (e.k === "call" && e.fn.k === "id" && e.fn.name === "nz") {
      const val = resolveConst(e.args[0]);
      if (val !== undefined) {
        if (isNa(val)) {
          return e.args.length > 1 ? resolveConst(e.args[1]) ?? 0 : 0;
        }
        return val;
      }
    }
    return undefined;
  }

  function resolveSeries(e: Expr): Series | null {
    if (e.k === "id") {
      if (builtinSeries[e.name]) return toNumArr(e.name);
      if (precomputed[e.name]) return precomputed[e.name];
      if (inputDefaults[e.name] !== undefined) {
        const src = inputDefaults[e.name];
        if (typeof src === "string" && builtinSeries[src]) return toNumArr(src);
      }
      return null;
    }
    return null;
  }

  const UNSET = Symbol("unset");
  function scopedPrecompute(
    fn: { params: string[]; body: Stmt[] },
    callArgs: Expr[],
    callKw: [string, Expr][],
  ): { locals: string[]; success: boolean } {
    const saved: Map<string, { b?: Series | typeof UNSET; p?: Series | typeof UNSET; d?: any }> = new Map();
    const locals: string[] = [];
    const cacheKeysBefore = new Set(indicatorCache.keys());

    function save(sym: string) {
      if (!saved.has(sym)) {
        saved.set(sym, {
          b: builtinSeries[sym] !== undefined ? builtinSeries[sym] : UNSET,
          p: precomputed[sym] !== undefined ? precomputed[sym] : UNSET,
          d: inputDefaults[sym] !== undefined ? inputDefaults[sym] : UNSET,
        });
      }
    }

    function restore() {
      for (const [sym, s] of saved) {
        if (locals.includes(sym)) continue;
        if (s.b === UNSET) delete builtinSeries[sym]; else if (s.b !== undefined) builtinSeries[sym] = s.b as any;
        if (s.p === UNSET) delete precomputed[sym]; else if (s.p !== undefined) precomputed[sym] = s.p as any;
        if (s.d === UNSET) delete inputDefaults[sym]; else if (s.d !== undefined) inputDefaults[sym] = s.d;
      }
      for (const key of indicatorCache.keys()) {
        if (!cacheKeysBefore.has(key)) indicatorCache.delete(key);
      }
    }

    for (let i = 0; i < fn.params.length; i++) {
      const paramName = fn.params[i];
      if (i < callArgs.length) {
        const arg = callArgs[i];
        const series = tryGetSeries(arg);
        if (series) {
          save(paramName);
          builtinSeries[paramName] = series;
          locals.push(paramName);
        } else {
          const cv = resolveConst(arg);
          if (cv !== undefined) {
            save(paramName);
            inputDefaults[paramName] = cv;
            locals.push(paramName);
          } else {
            restore();
            return { locals: [], success: false };
          }
        }
      }
    }
    for (const [kwName, kwExpr] of callKw) {
      if (fn.params.includes(kwName)) {
        const cv = resolveConst(kwExpr);
        if (cv !== undefined) {
          save(kwName);
          inputDefaults[kwName] = cv;
          locals.push(kwName);
        }
      }
    }

    let allOk = true;
    for (const stmt of fn.body) {
      if (stmt.k === "decl" && !stmt.isVar) {
        save(stmt.name);
        if (!tryPrecompute(stmt.name, stmt.e)) {
          const cv = resolveConst(stmt.e);
          if (cv !== undefined) {
            if (typeof cv === "number") {
              precomputed[stmt.name] = new Array(n).fill(cv);
            } else {
              inputDefaults[stmt.name] = cv;
            }
          } else {
            allOk = false;
            break;
          }
        }
        locals.push(stmt.name);
      } else if (stmt.k === "expr") {
      } else {
        allOk = false;
        break;
      }
    }

    return { locals, success: allOk };
  }

  function tryPrecomputeUserFunc(name: string, funcName: string, callArgs: Expr[], callKw: [string, Expr][]): boolean {
    const fn = userFunctions[funcName];
    if (!fn) return false;
    const cacheKeysBefore = new Set(indicatorCache.keys());
    const originals = new Map<string, { b: Series | undefined; p: Series | undefined; d: any }>();
    for (const p of fn.params) {
      originals.set(p, { b: builtinSeries[p], p: precomputed[p], d: inputDefaults[p] });
    }
    for (const stmt of fn.body) {
      if (stmt.k === "decl") originals.set(stmt.name, { b: builtinSeries[stmt.name], p: precomputed[stmt.name], d: inputDefaults[stmt.name] });
    }

    const { success } = scopedPrecompute(fn, callArgs, callKw);

    let resultSeries: Series | null = null;
    if (success) {
      const lastStmt = fn.body.length > 0 ? fn.body[fn.body.length - 1] : null;
      if (lastStmt) {
        if (lastStmt.k === "expr") {
          resultSeries = tryGetSeries(lastStmt.e);
        } else if (lastStmt.k === "decl" && !lastStmt.isVar && precomputed[lastStmt.name]) {
          resultSeries = precomputed[lastStmt.name];
        }
      }
    }

    for (const [sym, orig] of originals) {
      if (orig.b !== undefined) builtinSeries[sym] = orig.b; else delete builtinSeries[sym];
      if (orig.p !== undefined) precomputed[sym] = orig.p; else delete precomputed[sym];
      if (orig.d !== undefined) inputDefaults[sym] = orig.d; else delete inputDefaults[sym];
    }
    for (const key of indicatorCache.keys()) {
      if (!cacheKeysBefore.has(key)) indicatorCache.delete(key);
    }

    if (resultSeries) {
      precomputed[name] = resultSeries;
      return true;
    }
    return false;
  }

  function tryPrecomputeUserFuncMulti(funcName: string, callArgs: Expr[], callKw: [string, Expr][], outputNames: string[]): (Series | null)[] | null {
    const fn = userFunctions[funcName];
    if (!fn) return null;
    const cacheKeysBefore = new Set(indicatorCache.keys());
    const originals = new Map<string, { b: Series | undefined; p: Series | undefined; d: any }>();
    for (const p of fn.params) {
      originals.set(p, { b: builtinSeries[p], p: precomputed[p], d: inputDefaults[p] });
    }
    for (const stmt of fn.body) {
      if (stmt.k === "decl") originals.set(stmt.name, { b: builtinSeries[stmt.name], p: precomputed[stmt.name], d: inputDefaults[stmt.name] });
    }

    const { success } = scopedPrecompute(fn, callArgs, callKw);

    let results: (Series | null)[] | null = null;
    if (success) {
      const lastStmt = fn.body.length > 0 ? fn.body[fn.body.length - 1] : null;
      if (lastStmt && lastStmt.k === "expr" && lastStmt.e.k === "call" && lastStmt.e.fn.k === "id" && lastStmt.e.fn.name === "__array_literal") {
        results = [];
        for (const arg of lastStmt.e.args) {
          const s = tryGetSeries(arg);
          results.push(s);
        }
        if (results.some(r => r === null)) results = null;
      }
    }

    for (const [sym, orig] of originals) {
      if (orig.b !== undefined) builtinSeries[sym] = orig.b; else delete builtinSeries[sym];
      if (orig.p !== undefined) precomputed[sym] = orig.p; else delete precomputed[sym];
      if (orig.d !== undefined) inputDefaults[sym] = orig.d; else delete inputDefaults[sym];
    }
    for (const key of indicatorCache.keys()) {
      if (!cacheKeysBefore.has(key)) indicatorCache.delete(key);
    }
    return results;
  }

  function tryPrecompute(name: string, e: Expr): boolean {
    if (e.k === "call" && e.fn.k === "mem" && e.fn.obj.k === "id" && e.fn.obj.name === "ta") {
      return precomputeIndicator(name, e.fn.prop, e.args, e.kw);
    }
    if (e.k === "call" && e.fn.k === "mem" && e.fn.obj.k === "id" && e.fn.obj.name === "input") {
      return false;
    }
    if (e.k === "call" && e.fn.k === "mem" && e.fn.obj.k === "mem") {
      return false;
    }
    if (e.k === "call" && e.fn.k === "id" && userFunctions[e.fn.name]) {
      return tryPrecomputeUserFunc(name, e.fn.name, e.args, e.kw);
    }
    if (e.k === "call" && e.fn.k === "id" && e.fn.name === "nz") {
      const inner = tryGetSeries(e.args[0]);
      if (inner) {
        const fallback = e.args.length > 1 ? resolveConst(e.args[1]) ?? 0 : 0;
        const result = new Array(n);
        for (let i = 0; i < n; i++) result[i] = isNaN(inner[i]) ? fallback : inner[i];
        precomputed[name] = result;
        return true;
      }
    }
    if (e.k === "sub") {
      const src = tryGetSeries(e.obj) ?? resolveSeries(e.obj);
      const offset = resolveConst(e.idx);
      if (src && typeof offset === 'number' && !isNaN(offset)) {
        const shifted = new Array(n).fill(NaN);
        for (let i = offset; i < n; i++) shifted[i] = src[i - offset];
        precomputed[name] = shifted;
        return true;
      }
      if (e.obj.k === "id" && e.idx.k === "bin" && e.idx.op === "+") {
        const src2 = resolveSeries(e.obj);
        const l = resolveConst(e.idx.l);
        const r = resolveConst(e.idx.r);
        if (src2 && typeof l === 'number' && typeof r === 'number') {
          const totalOffset = l + r;
          const shifted = new Array(n).fill(NaN);
          for (let i = totalOffset; i < n; i++) shifted[i] = src2[i - totalOffset];
          precomputed[name] = shifted;
          return true;
        }
      }
    }
    if (e.k === "bin") {
      const lSeries = tryGetSeries(e.l);
      const rSeries = tryGetSeries(e.r);
      if (lSeries && rSeries) {
        const result = new Array(n).fill(NaN);
        for (let i = 0; i < n; i++) {
          const lv = lSeries[i], rv = rSeries[i];
          if (isNaN(lv) || isNaN(rv)) continue;
          result[i] = evalBinOp(e.op, lv, rv);
        }
        precomputed[name] = result;
        return true;
      }
      const lConst = resolveConst(e.l);
      if (lConst !== undefined && rSeries) {
        const result = new Array(n).fill(NaN);
        for (let i = 0; i < n; i++) {
          if (isNaN(rSeries[i])) continue;
          result[i] = evalBinOp(e.op, toNum(lConst), rSeries[i]);
        }
        precomputed[name] = result;
        return true;
      }
      const rConst = resolveConst(e.r);
      if (lSeries && rConst !== undefined) {
        const result = new Array(n).fill(NaN);
        for (let i = 0; i < n; i++) {
          if (isNaN(lSeries[i])) continue;
          result[i] = evalBinOp(e.op, lSeries[i], toNum(rConst));
        }
        precomputed[name] = result;
        return true;
      }
    }
    if (e.k === "call" && e.fn.k === "mem" && e.fn.obj.k === "id" && e.fn.obj.name === "math") {
      const mathFn = e.fn.prop;
      if (e.args.length >= 2 && (mathFn === "max" || mathFn === "min")) {
        const a = tryGetSeries(e.args[0]) ?? (resolveConst(e.args[0]) !== undefined ? new Array(n).fill(resolveConst(e.args[0])) : null);
        const b = tryGetSeries(e.args[1]) ?? (resolveConst(e.args[1]) !== undefined ? new Array(n).fill(resolveConst(e.args[1])) : null);
        if (a && b) {
          const result = new Array(n).fill(NaN);
          const op = mathFn === "max" ? Math.max : Math.min;
          for (let i = 0; i < n; i++) result[i] = (isNaN(a[i]) || isNaN(b[i])) ? NaN : op(a[i], b[i]);
          precomputed[name] = result;
          return true;
        }
      }
      if (e.args.length >= 1) {
        const inner = tryGetSeries(e.args[0]);
        if (inner) {
          const result = new Array(n).fill(NaN);
          const fn = (Math as any)[mathFn];
          if (typeof fn === "function") {
            for (let i = 0; i < n; i++) result[i] = isNaN(inner[i]) ? NaN : fn(inner[i]);
            precomputed[name] = result;
            return true;
          }
        }
      }
    }
    if (e.k === "tern") {
      const condConst = resolveConst(e.c);
      if (condConst !== undefined) {
        const branch = condConst ? e.t : e.f;
        const s = tryGetSeries(branch);
        if (s) { precomputed[name] = s; return true; }
        const cv = resolveConst(branch);
        if (cv !== undefined && typeof cv === "number") { precomputed[name] = new Array(n).fill(cv); return true; }
      }
      const condSeries = tryGetSeries(e.c);
      if (condSeries) {
        const tSeries = tryGetSeries(e.t) ?? (resolveConst(e.t) !== undefined ? new Array(n).fill(resolveConst(e.t)) : null);
        const fSeries = tryGetSeries(e.f) ?? (resolveConst(e.f) !== undefined ? new Array(n).fill(resolveConst(e.f)) : null);
        if (tSeries && fSeries) {
          const result = new Array(n);
          for (let i = 0; i < n; i++) {
            const c = condSeries[i];
            result[i] = (isNaN(c as number) || !c) ? fSeries[i] : tSeries[i];
          }
          precomputed[name] = result;
          return true;
        }
      }
    }
    if (e.k === "un" && e.op === "-") {
      const inner = tryGetSeries(e.e);
      if (inner) {
        const result = new Array(n).fill(NaN);
        for (let i = 0; i < n; i++) result[i] = isNaN(inner[i]) ? NaN : -inner[i];
        precomputed[name] = result;
        return true;
      }
    }
    if (e.k === "un" && e.op === "not") {
      const inner = tryGetSeries(e.e);
      if (inner) {
        const result = new Array(n).fill(NaN);
        for (let i = 0; i < n; i++) result[i] = isNaN(inner[i]) ? NaN : (inner[i] ? 0 : 1);
        precomputed[name] = result;
        return true;
      }
    }
    const series = tryGetSeries(e);
    if (series) {
      precomputed[name] = series;
      return true;
    }
    const cv = resolveConst(e);
    if (cv !== undefined && typeof cv === "number") {
      precomputed[name] = new Array(n).fill(cv);
      return true;
    }
    if (cv !== undefined && typeof cv === "boolean") {
      precomputed[name] = new Array(n).fill(cv ? 1 : 0);
      return true;
    }
    return false;
  }

  function tryGetSeries(e: Expr): Series | null {
    if (e.k === "id") {
      if (builtinSeries[e.name]) return toNumArr(e.name);
      if (precomputed[e.name]) return precomputed[e.name];
      if (inputDefaults[e.name] !== undefined && typeof inputDefaults[e.name] === "string" && builtinSeries[inputDefaults[e.name]]) {
        return toNumArr(inputDefaults[e.name]);
      }
      if (inputDefaults[e.name] !== undefined && (typeof inputDefaults[e.name] === "number" || typeof inputDefaults[e.name] === "boolean")) {
        return new Array(n).fill(typeof inputDefaults[e.name] === "boolean" ? (inputDefaults[e.name] ? 1 : 0) : inputDefaults[e.name]);
      }
    }
    if (e.k === "bool") return new Array(n).fill(e.v ? 1 : 0);
    if (e.k === "mem" && e.obj.k === "id" && e.obj.name === "ta" && e.prop === "tr") {
      return ind.trueRange(numHighArr, numLowArr, numCloseArr);
    }
    if (e.k === "num") return new Array(n).fill(e.v);
    if (e.k === "un" && e.op === "-") {
      const inner = tryGetSeries(e.e);
      if (inner) { const r = new Array(n); for (let i = 0; i < n; i++) r[i] = isNaN(inner[i]) ? NaN : -inner[i]; return r; }
    }
    if (e.k === "sub") {
      const src = tryGetSeries(e.obj);
      const offset = resolveConst(e.idx);
      if (src && typeof offset === "number" && !isNaN(offset)) {
        const shifted = new Array(n).fill(NaN);
        for (let i = offset; i < n; i++) shifted[i] = src[i - offset];
        return shifted;
      }
    }
    if (e.k === "bin") {
      const lSeries = tryGetSeries(e.l);
      const rSeries = tryGetSeries(e.r);
      if (lSeries && rSeries) {
        const result = new Array(n).fill(NaN);
        for (let i = 0; i < n; i++) {
          const lv = lSeries[i], rv = rSeries[i];
          if (isNaN(lv) || isNaN(rv)) continue;
          result[i] = evalBinOp(e.op, lv, rv);
        }
        return result;
      }
      const lConst = resolveConst(e.l);
      if (lConst !== undefined && rSeries) {
        const result = new Array(n).fill(NaN);
        for (let i = 0; i < n; i++) {
          if (isNaN(rSeries[i])) continue;
          result[i] = evalBinOp(e.op, toNum(lConst), rSeries[i]);
        }
        return result;
      }
      const rConst = resolveConst(e.r);
      if (lSeries && rConst !== undefined) {
        const result = new Array(n).fill(NaN);
        for (let i = 0; i < n; i++) {
          if (isNaN(lSeries[i])) continue;
          result[i] = evalBinOp(e.op, lSeries[i], toNum(rConst));
        }
        return result;
      }
    }
    if (e.k === "tern") {
      const condSeries = tryGetSeries(e.c);
      if (condSeries) {
        const tSeries = tryGetSeries(e.t) ?? (resolveConst(e.t) !== undefined ? new Array(n).fill(resolveConst(e.t)) : null);
        const fSeries = tryGetSeries(e.f) ?? (resolveConst(e.f) !== undefined ? new Array(n).fill(resolveConst(e.f)) : null);
        if (tSeries && fSeries) {
          const result = new Array(n);
          for (let i = 0; i < n; i++) {
            const c = condSeries[i];
            result[i] = (isNaN(c as number) || !c) ? fSeries[i] : tSeries[i];
          }
          return result;
        }
      }
      const condConst = resolveConst(e.c);
      if (condConst !== undefined) {
        return tryGetSeries(condConst ? e.t : e.f);
      }
    }
    if (e.k === "call" && e.fn.k === "mem" && e.fn.obj.k === "id" && e.fn.obj.name === "math") {
      const mathFn = e.fn.prop;
      if (e.args.length >= 1) {
        const inner = tryGetSeries(e.args[0]);
        if (inner) {
          const fn = (Math as any)[mathFn];
          if (typeof fn === "function") {
            const result = new Array(n).fill(NaN);
            for (let i = 0; i < n; i++) result[i] = isNaN(inner[i]) ? NaN : fn(inner[i]);
            return result;
          }
        }
      }
      if (e.args.length >= 2 && (mathFn === "max" || mathFn === "min")) {
        const a = tryGetSeries(e.args[0]) ?? (resolveConst(e.args[0]) !== undefined ? new Array(n).fill(resolveConst(e.args[0])) : null);
        const b = tryGetSeries(e.args[1]) ?? (resolveConst(e.args[1]) !== undefined ? new Array(n).fill(resolveConst(e.args[1])) : null);
        if (a && b) {
          const result = new Array(n).fill(NaN);
          const op = mathFn === "max" ? Math.max : Math.min;
          for (let i = 0; i < n; i++) result[i] = (isNaN(a[i]) || isNaN(b[i])) ? NaN : op(a[i], b[i]);
          return result;
        }
      }
    }
    if (e.k === "call" && e.fn.k === "mem" && e.fn.obj.k === "id" && e.fn.obj.name === "ta") {
      return resolveNestedTaSeries(e.fn.prop, e.args, e.kw);
    }
    if (e.k === "call" && e.fn.k === "id" && e.fn.name === "nz") {
      const inner = tryGetSeries(e.args[0]);
      if (inner) {
        const fallback = e.args.length > 1 ? resolveConst(e.args[1]) ?? 0 : 0;
        const result = new Array(n);
        for (let i = 0; i < n; i++) result[i] = isNaN(inner[i]) ? fallback : inner[i];
        return result;
      }
    }
    const cv = resolveConst(e);
    if (cv !== undefined && (typeof cv === "number" || typeof cv === "boolean")) {
      return new Array(n).fill(typeof cv === "boolean" ? (cv ? 1 : 0) : cv);
    }
    return null;
  }

  function evalBinOp(op: string, l: any, r: any): any {
    if (op === "and") return l && r;
    if (op === "or") return l || r;
    const ln = toNum(l), rn = toNum(r);
    switch (op) {
      case "+": return typeof l === 'string' || typeof r === 'string' ? String(l) + String(r) : ln + rn;
      case "-": return ln - rn;
      case "*": return ln * rn;
      case "/": return rn === 0 ? NaN : ln / rn;
      case "%": return rn === 0 ? NaN : ln % rn;
      case "==": return l === r || (isNa(l) && isNa(r));
      case "!=": return l !== r && !(isNa(l) && isNa(r));
      case ">": return ln > rn;
      case "<": return ln < rn;
      case ">=": return ln >= rn;
      case "<=": return ln <= rn;
      default: return NaN;
    }
  }

  function precomputeIndicator(name: string, fn: string, args: Expr[], kw: [string, Expr][]): boolean {
    if (fn === "ad") fn = "accdist";
    if (fn === "pearsonr") fn = "correlation";
    const h = numHighArr;
    const l = numLowArr;
    const cl = numCloseArr;
    const op: Series = openArr;
    const numVol = (): Series => volArr;

    function getSource(idx: number): Series | null {
      const arg = args[idx];
      if (!arg) return cl;
      const s = resolveSeries(arg);
      if (s) return s;
      const ts = tryGetSeries(arg);
      if (ts) return ts;
      const c = resolveConst(arg);
      if (typeof c === 'string' && builtinSeries[c]) return toNumArr(c);
      return null;
    }

    function getLen(idx: number, def: number = 14): number {
      if (idx >= args.length) {
        const kwVal = kw.find(k => k[0] === 'length');
        if (kwVal) { const v = resolveConst(kwVal[1]); return typeof v === 'number' ? v : def; }
        return def;
      }
      const v = resolveConst(args[idx]);
      return typeof v === 'number' ? v : def;
    }

    switch (fn) {
      case "sma": {
        const src = getSource(0); const len = getLen(1);
        if (!src) return false;
        precomputed[name] = ind.sma(src, len); return true;
      }
      case "ema": {
        const src = getSource(0); const len = getLen(1);
        if (!src) return false;
        precomputed[name] = ind.pineEma(src, len); return true;
      }
      case "rma": {
        const src = getSource(0); const len = getLen(1);
        if (!src) return false;
        precomputed[name] = ind.rma(src, len); return true;
      }
      case "wma": {
        const src = getSource(0); const len = getLen(1);
        if (!src) return false;
        precomputed[name] = ind.wma(src, len); return true;
      }
      case "rsi": {
        const src = getSource(0); const len = getLen(1);
        if (!src) return false;
        precomputed[name] = ind.rsi(src, len); return true;
      }
      case "atr": {
        const len = getLen(0);
        precomputed[name] = ind.atr(h, l, cl, len); return true;
      }
      case "stdev": {
        const src = getSource(0); const len = getLen(1);
        if (!src) return false;
        precomputed[name] = ind.stdev(src, len); return true;
      }
      case "highest": {
        const src = getSource(0); const len = getLen(1);
        if (!src) return false;
        precomputed[name] = ind.highest(src, len); return true;
      }
      case "lowest": {
        const src = getSource(0); const len = getLen(1);
        if (!src) return false;
        precomputed[name] = ind.lowest(src, len); return true;
      }
      case "vwap": {
        const src = getSource(0) || cl;
        const result = new Array(n).fill(NaN);
        let cumPV = 0, cumV = 0;
        for (let i = 0; i < n; i++) {
          cumPV += src[i] * (volArr[i] || 1);
          cumV += (volArr[i] || 1);
          result[i] = cumV !== 0 ? cumPV / cumV : src[i];
        }
        precomputed[name] = result; return true;
      }
      case "tr": {
        precomputed[name] = ind.trueRange(h, l, cl); return true;
      }
      case "pivothigh": {
        let src = h, leftBars: number, rightBars: number;
        if (args.length >= 3) {
          const s = getSource(0); if (s) src = s;
          leftBars = getLen(1, 5); rightBars = getLen(2, 5);
        } else {
          leftBars = getLen(0, 5); rightBars = getLen(1, 5);
        }
        const result = new Array(n).fill(NaN);
        for (let i = leftBars + rightBars; i < n; i++) {
          const pivotIdx = i - rightBars;
          let isPivot = true;
          for (let j = pivotIdx - leftBars; j < pivotIdx; j++) {
            if (src[j] > src[pivotIdx]) { isPivot = false; break; }
          }
          if (isPivot) {
            for (let j = pivotIdx + 1; j <= pivotIdx + rightBars; j++) {
              if (src[j] >= src[pivotIdx]) { isPivot = false; break; }
            }
          }
          if (isPivot) result[i] = src[pivotIdx];
        }
        precomputed[name] = result; return true;
      }
      case "pivotlow": {
        let src = l, leftBars: number, rightBars: number;
        if (args.length >= 3) {
          const s = getSource(0); if (s) src = s;
          leftBars = getLen(1, 5); rightBars = getLen(2, 5);
        } else {
          leftBars = getLen(0, 5); rightBars = getLen(1, 5);
        }
        const result = new Array(n).fill(NaN);
        for (let i = leftBars + rightBars; i < n; i++) {
          const pivotIdx = i - rightBars;
          let isPivot = true;
          for (let j = pivotIdx - leftBars; j < pivotIdx; j++) {
            if (src[j] < src[pivotIdx]) { isPivot = false; break; }
          }
          if (isPivot) {
            for (let j = pivotIdx + 1; j <= pivotIdx + rightBars; j++) {
              if (src[j] <= src[pivotIdx]) { isPivot = false; break; }
            }
          }
          if (isPivot) result[i] = src[pivotIdx];
        }
        precomputed[name] = result; return true;
      }
      case "linreg": {
        const src = getSource(0); const len = getLen(1);
        if (!src) return false;
        precomputed[name] = ind.linreg(src, len); return true;
      }
      case "percentrank": {
        const src = getSource(0); const len = getLen(1);
        if (!src) return false;
        precomputed[name] = ind.percentRank(src, len); return true;
      }
      case "cum": {
        const src = getSource(0);
        if (!src) return false;
        const result = new Array(n).fill(NaN);
        let total = 0;
        for (let i = 0; i < n; i++) { total += isNaN(src[i]) ? 0 : src[i]; result[i] = total; }
        precomputed[name] = result; return true;
      }
      case "median": {
        const src = getSource(0); const len = getLen(1);
        if (!src) return false;
        const result = new Array(n).fill(NaN);
        for (let i = len - 1; i < n; i++) {
          const window = src.slice(i - len + 1, i + 1).filter(v => !isNaN(v)).sort((a, b) => a - b);
          if (window.length > 0) result[i] = window[Math.floor(window.length / 2)];
        }
        precomputed[name] = result; return true;
      }
      case "roc": {
        const src = getSource(0); const len = getLen(1, 1);
        if (!src) return false;
        const result = new Array(n).fill(NaN);
        for (let i = len; i < n; i++) {
          const prev = src[i - len];
          result[i] = prev !== 0 && !isNaN(prev) ? 100 * (src[i] - prev) / prev : NaN;
        }
        precomputed[name] = result; return true;
      }
      case "dmi": {
        const diLen = getLen(0, 14);
        const adxSmooth = args.length > 1 ? getLen(1, diLen) : diLen;
        const { diPlus, diMinus, adxVal } = computeDmi(diLen, adxSmooth);
        precomputed[name] = adxVal as number[];
        precomputed[name + "__diplus"] = diPlus as number[];
        precomputed[name + "__diminus"] = diMinus as number[];
        return true;
      }
      case "stoch": {
        const srcArr = getSource(0) || cl;
        const hSource = args.length > 1 ? getSource(1) : h;
        const lSource = args.length > 2 ? getSource(2) : l;
        const len = args.length > 3 ? getLen(3, 14) : 14;
        if (!srcArr || !hSource || !lSource) return false;
        const res = new Array(n).fill(NaN);
        for (let i = len - 1; i < n; i++) {
          let hh = -Infinity, ll = Infinity;
          for (let j = i - len + 1; j <= i; j++) {
            if (hSource[j] > hh) hh = hSource[j];
            if (lSource[j] < ll) ll = lSource[j];
          }
          const range = hh - ll;
          res[i] = range > 0 ? ((srcArr[i] - ll) / range) * 100 : 50;
        }
        precomputed[name] = res;
        return true;
      }
      case "falling": {
        const src = getSource(0);
        const len = getLen(1, 1);
        if (!src) return false;
        const result = new Array(n).fill(0);
        for (let i = len; i < n; i++) {
          let isFalling = true;
          for (let j = 0; j < len; j++) {
            if (isNaN(src[i - j]) || isNaN(src[i - j - 1]) || src[i - j] >= src[i - j - 1]) { isFalling = false; break; }
          }
          result[i] = isFalling ? 1 : 0;
        }
        precomputed[name] = result;
        return true;
      }
      case "rising": {
        const src = getSource(0);
        const len = getLen(1, 1);
        if (!src) return false;
        const result = new Array(n).fill(0);
        for (let i = len; i < n; i++) {
          let isRising = true;
          for (let j = 0; j < len; j++) {
            if (isNaN(src[i - j]) || isNaN(src[i - j - 1]) || src[i - j] <= src[i - j - 1]) { isRising = false; break; }
          }
          result[i] = isRising ? 1 : 0;
        }
        precomputed[name] = result;
        return true;
      }
      case "dev": {
        const src = getSource(0); const len = getLen(1);
        if (!src) return false;
        precomputed[name] = ind.stdev(src, len);
        return true;
      }
      case "mfi": {
        const srcArr = getSource(0) || cl;
        const len = getLen(1, 14);
        if (!srcArr) return false;
        const vol: Float64Array | number[] = volArr;
        const result = new Array(n).fill(NaN);
        for (let i = len; i < n; i++) {
          let posFlow = 0, negFlow = 0;
          for (let j = i - len + 1; j <= i; j++) {
            const flow = srcArr[j] * (vol[j] || 1);
            if (srcArr[j] > srcArr[j - 1]) posFlow += flow;
            else if (srcArr[j] < srcArr[j - 1]) negFlow += flow;
          }
          result[i] = negFlow === 0 ? 100 : 100 - (100 / (1 + posFlow / negFlow));
        }
        precomputed[name] = result;
        return true;
      }
      case "change": {
        const src = getSource(0);
        if (!src) return false;
        const len = args.length > 1 ? getLen(1, 1) : 1;
        const result = new Array(n).fill(NaN);
        for (let i = len; i < n; i++) {
          result[i] = (isNaN(src[i]) || isNaN(src[i - len])) ? NaN : src[i] - src[i - len];
        }
        precomputed[name] = result; return true;
      }
      case "crossover": {
        const a = getSource(0);
        const bExpr = args[1];
        const b = bExpr ? (tryGetSeries(bExpr) ?? (resolveConst(bExpr) !== undefined ? new Array(n).fill(resolveConst(bExpr)) : null)) : null;
        if (!a || !b) return false;
        const result = new Array(n).fill(0);
        for (let i = 1; i < n; i++) {
          if (!isNaN(a[i]) && !isNaN(b[i]) && !isNaN(a[i-1]) && !isNaN(b[i-1])) {
            result[i] = (a[i] > b[i] && a[i-1] <= b[i-1]) ? 1 : 0;
          }
        }
        precomputed[name] = result; return true;
      }
      case "crossunder": {
        const a = getSource(0);
        const bExpr = args[1];
        const b = bExpr ? (tryGetSeries(bExpr) ?? (resolveConst(bExpr) !== undefined ? new Array(n).fill(resolveConst(bExpr)) : null)) : null;
        if (!a || !b) return false;
        const result = new Array(n).fill(0);
        for (let i = 1; i < n; i++) {
          if (!isNaN(a[i]) && !isNaN(b[i]) && !isNaN(a[i-1]) && !isNaN(b[i-1])) {
            result[i] = (a[i] < b[i] && a[i-1] >= b[i-1]) ? 1 : 0;
          }
        }
        precomputed[name] = result; return true;
      }
      case "cross": {
        const a = getSource(0);
        const bExpr = args[1];
        const b = bExpr ? (tryGetSeries(bExpr) ?? (resolveConst(bExpr) !== undefined ? new Array(n).fill(resolveConst(bExpr)) : null)) : null;
        if (!a || !b) return false;
        const result = new Array(n).fill(0);
        for (let i = 1; i < n; i++) {
          if (!isNaN(a[i]) && !isNaN(b[i]) && !isNaN(a[i-1]) && !isNaN(b[i-1])) {
            result[i] = ((a[i] > b[i] && a[i-1] <= b[i-1]) || (a[i] < b[i] && a[i-1] >= b[i-1])) ? 1 : 0;
          }
        }
        precomputed[name] = result; return true;
      }
      case "vwma": {
        const src = getSource(0); const len = getLen(1);
        if (!src) return false;
        precomputed[name] = ind.vwma(src, volArr, len); return true;
      }
      case "hma": {
        const src = getSource(0); const len = getLen(1);
        if (!src) return false;
        precomputed[name] = ind.hma(src, len); return true;
      }
      case "dema": {
        const src = getSource(0); const len = getLen(1);
        if (!src) return false;
        precomputed[name] = ind.dema(src, len); return true;
      }
      case "tema": {
        const src = getSource(0); const len = getLen(1);
        if (!src) return false;
        precomputed[name] = ind.tema(src, len); return true;
      }
      case "alma": {
        const src = getSource(0); const len = getLen(1, 9);
        const offConst = args.length > 2 ? resolveConst(args[2]) : undefined;
        const sigConst = args.length > 3 ? resolveConst(args[3]) : undefined;
        const off = typeof offConst === "number" ? offConst : 0.85;
        const sig = typeof sigConst === "number" ? sigConst : 6;
        if (!src) return false;
        precomputed[name] = ind.alma(src, len, off, sig); return true;
      }
      case "swma": {
        const src = getSource(0);
        if (!src) return false;
        precomputed[name] = ind.swma(src); return true;
      }
      case "cci": {
        const src = getSource(0); const len = getLen(1, 20);
        if (!src) return false;
        precomputed[name] = ind.cci(src, len); return true;
      }
      case "percentile_nearest_rank": {
        const src = getSource(0); const len = getLen(1);
        const pConst = args.length > 2 ? resolveConst(args[2]) : undefined;
        if (!src || typeof pConst !== "number") return false;
        precomputed[name] = ind.percentileNearestRank(src, len, pConst); return true;
      }
      case "percentile_linear_interpolation": {
        const src = getSource(0); const len = getLen(1);
        const pConst = args.length > 2 ? resolveConst(args[2]) : undefined;
        if (!src || typeof pConst !== "number") return false;
        precomputed[name] = ind.percentileLinearInterpolation(src, len, pConst); return true;
      }
      case "macd": {
        const src = getSource(0);
        const fast = getLen(1, 12); const slow = getLen(2, 26); const sig = getLen(3, 9);
        if (!src) return false;
        const m = ind.macd(src, fast, slow, sig);
        precomputed[name] = m.macd;
        precomputed[name + "__signal"] = m.signal;
        precomputed[name + "__hist"] = m.hist;
        return true;
      }
      case "supertrend": {
        const factor = getLen(0, 3);
        const atrPeriod = getLen(1, 10);
        const s = ind.supertrend(h, l, cl, factor, atrPeriod);
        precomputed[name] = s.supertrend;
        precomputed[name + "__direction"] = s.direction;
        return true;
      }
      case "bb": {
        const src = getSource(0); const len = getLen(1, 20);
        const mConst = args.length > 2 ? resolveConst(args[2]) : undefined;
        const mult = typeof mConst === "number" ? mConst : 2.0;
        if (!src) return false;
        const b = ind.bollingerBands(src, len, mult);
        precomputed[name] = b.basis;
        precomputed[name + "__upper"] = b.upper as number[];
        precomputed[name + "__lower"] = b.lower as number[];
        return true;
      }
      case "kc": {
        const src = getSource(0); const len = getLen(1, 20);
        const mConst = args.length > 2 ? resolveConst(args[2]) : undefined;
        const mult = typeof mConst === "number" ? mConst : 1.5;
        if (!src) return false;
        const b = ind.keltnerChannel(src, h, l, len, len, mult);
        precomputed[name] = b.basis;
        precomputed[name + "__upper"] = b.upper as number[];
        precomputed[name + "__lower"] = b.lower as number[];
        return true;
      }
      case "adx": {
        const diLen = getLen(0, 14);
        const adxSmooth = args.length > 1 ? getLen(1, diLen) : diLen;
        const { adxVal } = computeDmi(diLen, adxSmooth);
        precomputed[name] = adxVal as number[];
        return true;
      }
      case "obv": {
        precomputed[name] = ind.obv(cl, numVol()); return true;
      }
      case "accdist": {
        precomputed[name] = ind.accdist(h, l, cl, numVol()); return true;
      }
      case "pvt": {
        precomputed[name] = ind.pvt(cl, numVol()); return true;
      }
      case "nvi": {
        precomputed[name] = ind.nvi(cl, numVol()); return true;
      }
      case "pvi": {
        precomputed[name] = ind.pvi(cl, numVol()); return true;
      }
      case "iii": {
        precomputed[name] = ind.iii(h, l, cl, numVol()); return true;
      }
      case "wad": {
        precomputed[name] = ind.wad(h, l, cl); return true;
      }
      case "bop": {
        precomputed[name] = ind.bop(op, h, l, cl); return true;
      }
      case "mom": {
        const src = getSource(0); const len = getLen(1, 10);
        if (!src) return false;
        precomputed[name] = ind.mom(src, len); return true;
      }
      case "wpr": {
        const len = getLen(0, 14);
        precomputed[name] = ind.wpr(h, l, cl, len); return true;
      }
      case "cmo": {
        const src = getSource(0); const len = getLen(1, 9);
        if (!src) return false;
        precomputed[name] = ind.cmo(src, len); return true;
      }
      case "bbw": {
        const src = getSource(0); const len = getLen(1, 20);
        const mConst = args.length > 2 ? resolveConst(args[2]) : undefined;
        const mult = typeof mConst === "number" ? mConst : 2.0;
        if (!src) return false;
        precomputed[name] = ind.bbw(src, len, mult); return true;
      }
      case "kcw": {
        const src = getSource(0); const len = getLen(1, 20);
        const mConst = args.length > 2 ? resolveConst(args[2]) : undefined;
        const mult = typeof mConst === "number" ? mConst : 1.5;
        if (!src) return false;
        precomputed[name] = ind.kcw(src, h, l, len, mult); return true;
      }
      case "highestbars": {
        const src = args.length > 1 ? getSource(0) : h;
        const len = args.length > 1 ? getLen(1) : getLen(0);
        if (!src) return false;
        precomputed[name] = ind.highestBars(src, len); return true;
      }
      case "lowestbars": {
        const src = args.length > 1 ? getSource(0) : l;
        const len = args.length > 1 ? getLen(1) : getLen(0);
        if (!src) return false;
        precomputed[name] = ind.lowestBars(src, len); return true;
      }
      case "range": {
        const src = getSource(0); const len = getLen(1);
        if (!src) return false;
        precomputed[name] = ind.rangeIndicator(src, len); return true;
      }
      case "variance": {
        const src = getSource(0); const len = getLen(1);
        if (!src) return false;
        precomputed[name] = ind.variance(src, len); return true;
      }
      case "correlation": {
        const s1 = getSource(0); const s2 = getSource(1); const len = getLen(2);
        if (!s1 || !s2) return false;
        precomputed[name] = ind.correlation(s1, s2, len); return true;
      }
      case "cog": {
        const src = getSource(0); const len = getLen(1);
        if (!src) return false;
        precomputed[name] = ind.cog(src, len); return true;
      }
      case "aroon": {
        const len = getLen(0, 14);
        const a = ind.aroon(h, l, len);
        precomputed[name] = a.upper;
        precomputed[name + "__lower"] = a.lower;
        return true;
      }
      case "tsi": {
        const src = getSource(0); const sLen = getLen(1, 13); const lLen = getLen(2, 25);
        if (!src) return false;
        precomputed[name] = ind.tsi(src, sLen, lLen); return true;
      }
      case "vortex": {
        const len = getLen(0, 14);
        const v = ind.vortex(h, l, cl, len);
        precomputed[name] = v.viPlus;
        precomputed[name + "__minus"] = v.viMinus;
        return true;
      }
      case "mode": {
        const src = getSource(0); const len = getLen(1);
        if (!src) return false;
        precomputed[name] = ind.mode(src, len); return true;
      }
      case "sar": {
        const startConst = resolveConst(args[0]);
        const incConst = resolveConst(args[1]);
        const maxConst = resolveConst(args[2]);
        const start = typeof startConst === "number" ? startConst : 0.02;
        const inc = typeof incConst === "number" ? incConst : 0.02;
        const mx = typeof maxConst === "number" ? maxConst : 0.2;
        precomputed[name] = ind.sar(h, l, start, inc, mx);
        return true;
      }
      case "barssince": case "valuewhen": return false;
      default: return false;
    }
  }

  function computeDmi(diLen: number, adxSmoothing: number): { diPlus: Series; diMinus: Series; adxVal: Series } {
    const cacheKey = `dmi_${diLen}_${adxSmoothing}`;
    if (indicatorCache.has(cacheKey)) return indicatorCache.get(cacheKey);

    const h = numHighArr;
    const l = numLowArr;
    const cl = numCloseArr;

    const plusDM: number[] = [0];
    const minusDM: number[] = [0];
    for (let i = 1; i < n; i++) {
      const upMove = h[i] - h[i - 1];
      const downMove = l[i - 1] - l[i];
      plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
      minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    }
    const atrVals = ind.atr(h, l, cl, diLen);
    const smoothPlus = ind.rma(plusDM, diLen);
    const smoothMinus = ind.rma(minusDM, diLen);

    const diPlus = new Array(n).fill(NaN);
    const diMinus = new Array(n).fill(NaN);
    const dx = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      if (!isNaN(atrVals[i]) && atrVals[i] !== 0 && !isNaN(smoothPlus[i])) {
        diPlus[i] = (smoothPlus[i] / atrVals[i]) * 100;
        diMinus[i] = (smoothMinus[i] / atrVals[i]) * 100;
        const sum = diPlus[i] + diMinus[i];
        dx[i] = sum === 0 ? 0 : (Math.abs(diPlus[i] - diMinus[i]) / sum) * 100;
      }
    }
    const adxVal = ind.rma(dx, adxSmoothing);
    const result = { diPlus, diMinus, adxVal };
    indicatorCache.set(cacheKey, result);
    return result;
  }

  function evalExpr(e: Expr): any {
    if ((++totalOps & 4095) === 0) { opsThrottle += 4096; if (totalOps > MAX_TOTAL_OPS) throw new Error("Global execution budget exceeded"); if (opsThrottle > MAX_OPS) throw new Error("Execution budget exceeded"); }

    switch (e.k) {
      case "num": return e.v;
      case "str": return e.v;
      case "bool": return e.v;
      case "na": return NA;
      case "id": return resolveId(e.name);
      case "bin": {
        if (e.op === "and") { const l = evalExpr(e.l); return l ? evalExpr(e.r) : false; }
        if (e.op === "or") { const l = evalExpr(e.l); return l ? l : evalExpr(e.r); }
        return evalBinOp(e.op, evalExpr(e.l), evalExpr(e.r));
      }
      case "un":
        if (e.op === "not") return !evalExpr(e.e);
        if (e.op === "-") return -toNum(evalExpr(e.e));
        return evalExpr(e.e);
      case "tern": {
        const c = evalExpr(e.c);
        return c ? evalExpr(e.t) : evalExpr(e.f);
      }
      case "call": return evalCall(e);
      case "sub": {
        const obj = e.obj;
        const idx = evalExpr(e.idx);
        const offset = Math.round(toNum(idx));
        if (obj.k === "id") return getVar(obj.name, offset);
        if (obj.k === "mem" && obj.obj.k === "id" && obj.obj.name === "strategy" && obj.prop === "position_size") {
          return broker.getPositionSizeHistory(offset, currentBar);
        }
        if (offset > 0 && currentBar >= offset) {
          const saved = currentBar;
          try {
            currentBar = saved - offset;
            return evalExpr(obj);
          } finally {
            currentBar = saved;
          }
        }
        return NA;
      }
      case "mem": return evalMember(e);
      case "switch_expr": {
        const switchVal = e.e ? evalExpr(e.e) : null;
        for (const c of e.cases) {
          if (c.val === null) return evalExpr(c.result);
          const cval = evalExpr(c.val);
          if (switchVal !== null && cval === switchVal) return evalExpr(c.result);
          if (switchVal === null && cval) return evalExpr(c.result);
        }
        return NA;
      }
    }
    return NA;
  }

  function execStmtForValue(stmt: any): any {
    if (stmt.k === "expr") {
      return evalExpr(stmt.e);
    }
    if (stmt.k === "switch") {
      const switchVal = stmt.e ? evalExpr(stmt.e) : null;
      for (const c of stmt.cases) {
        let matched = false;
        for (const v of c.vals) {
          if (v === null) { matched = true; break; }
          const cv = evalExpr(v);
          if (switchVal !== null && cv === switchVal) { matched = true; break; }
          if (switchVal === null && cv) { matched = true; break; }
        }
        if (matched) {
          for (let i = 0; i < c.body.length - 1; i++) execStmt(c.body[i]);
          const last = c.body[c.body.length - 1];
          return last ? execStmtForValue(last) : NA;
        }
      }
      return NA;
    }
    if (stmt.k === "if") {
      const cond = evalExpr(stmt.c);
      if (cond && cond !== NA) {
        for (let i = 0; i < stmt.body.length - 1; i++) execStmt(stmt.body[i]);
        const last = stmt.body[stmt.body.length - 1];
        return last ? execStmtForValue(last) : NA;
      }
      if (stmt.elifs) {
        for (const elif of stmt.elifs) {
          const ec = evalExpr(elif.c);
          if (ec && ec !== NA) {
            for (let i = 0; i < elif.body.length - 1; i++) execStmt(elif.body[i]);
            const last = elif.body[elif.body.length - 1];
            return last ? execStmtForValue(last) : NA;
          }
        }
      }
      if (stmt.el) {
        for (let i = 0; i < stmt.el.length - 1; i++) execStmt(stmt.el[i]);
        const last = stmt.el[stmt.el.length - 1];
        return last ? execStmtForValue(last) : NA;
      }
      return NA;
    }
    execStmt(stmt);
    return NA;
  }

  function resolveId(name: string): any {
    const s = allSeries.get(name);
    if (s) {
      const v = (s as any)[currentBar];
      return v === undefined || (typeof v === 'number' && v !== v) ? NA : v;
    }
    const p = params[name];
    if (p !== undefined) return p;
    const d = inputDefaults[name];
    if (d !== undefined) return d;
    switch (name) {
      case "bar_index": return currentBar;
      case "time": return candles[currentBar].time;
      case "na": return NA;
      case "true": return true;
      case "false": return false;
    }
    return NA;
  }

  function evalMember(e: { k: "mem"; obj: Expr; prop: string }): any {
    if (e.obj.k === "id") {
      const obj = e.obj.name;
      const prop = e.prop;

      if (obj === "strategy") {
        switch (prop) {
          case "long": return "long";
          case "short": return "short";
          case "position_size": return broker.positionSize;
          case "position_avg_price": return broker.positionAvgPrice;
          case "equity": return broker.getEquityWithUnrealized(closeArr[currentBar]);
          case "cash": return "cash";
          case "percent_of_equity": return "percent_of_equity";
          case "fixed": return "fixed";
        }
      }

      if (obj === "barstate") {
        switch (prop) {
          case "isconfirmed": return true;
          case "isfirst": return currentBar === 0;
          case "islast": return currentBar === n - 1;
          case "isnew": return true;
          case "isrealtime": return false;
          case "ishistory": return true;
        }
      }

      if (obj === "math") return { __ns: "math", fn: prop };
      if (obj === "ta") return { __ns: "ta", fn: prop };
      if (obj === "str") return { __ns: "str", fn: prop };
      if (obj === "color") return colorConst(prop);
      if (obj === "currency") return prop;
      if (obj === "dayofweek") {
        if (prop === "monday") return 2;
        if (prop === "sunday") return 1;
        return 0;
      }

      if (obj === "syminfo") {
        if (prop === "mintick") return 0.01;
        if (prop === "ticker") return ticker;
        return NA;
      }

      if (obj === "location") return prop;
      if (obj === "shape") return prop;
      if (obj === "size") return prop;
      if (obj === "plot") return prop;
      if (obj === "line") return { __ns: "line", fn: prop };
      if (obj === "label") return { __ns: "label", fn: prop };
      if (obj === "display") return prop;

      const v = getVar(obj, 0);
      if (v !== NA && typeof v === 'object' && v !== null) {
        return v[prop];
      }
    }

    if (e.obj.k === "mem") {
      const inner = evalMember(e.obj as any);
      if (inner && typeof inner === 'object' && inner.__ns) {
        return { __ns: inner.__ns + "." + inner.fn, fn: e.prop };
      }
      if (typeof inner === 'object' && inner !== null) return inner[e.prop];
    }

    const objVal = evalExpr(e.obj);
    if (typeof objVal === 'object' && objVal !== null) return objVal[e.prop];
    return NA;
  }

  function colorConst(name: string): string {
    return "#000000";
  }

  function evalCall(e: { k: "call"; fn: Expr; args: Expr[]; kw: [string, Expr][] }): any {
    const fnVal = evalExpr(e.fn);
    if (typeof fnVal === 'object' && fnVal && fnVal.__ns) {
      return evalBuiltinCall(fnVal.__ns, fnVal.fn, e.args, e.kw);
    }

    if (e.fn.k === "na") {
      if (!e.args || e.args.length === 0) return NA;
      return isNa(evalExpr(e.args[0]));
    }

    if (e.fn.k === "id") {
      const name = e.fn.name;
      if (name === "na") {
        if (e.args.length === 0) return NA;
        return isNa(evalExpr(e.args[0]));
      }
      if (name === "nz") {
        const v = evalExpr(e.args[0]);
        if (isNa(v)) return e.args.length > 1 ? evalExpr(e.args[1]) : 0;
        return v;
      }
      if (name === "fixnan") {
        const v = evalExpr(e.args[0]);
        if (!isNa(v)) return v;
        if (e.args[0].k === "id") {
          for (let b = currentBar - 1; b >= 0; b--) {
            const prev = getVar(e.args[0].name, currentBar - b);
            if (!isNa(prev)) return prev;
          }
        }
        return NA;
      }
      if (name === "float" || name === "int" || name === "bool" || name === "string") {
        return e.args.length > 0 ? evalExpr(e.args[0]) : NA;
      }
      if (name === "timestamp") {
        const tsArgs = e.args.map(a => evalExpr(a));
        if (tsArgs.length >= 3) {
          const yr = toNum(tsArgs[0]), mo = toNum(tsArgs[1]) - 1, dy = toNum(tsArgs[2]);
          const hr = tsArgs.length > 3 ? toNum(tsArgs[3]) : 0;
          const mn = tsArgs.length > 4 ? toNum(tsArgs[4]) : 0;
          const sc = tsArgs.length > 5 ? toNum(tsArgs[5]) : 0;
          return Date.UTC(yr, mo, dy, hr, mn, sc);
        }
        if (tsArgs.length === 1 && typeof tsArgs[0] === "string") {
          const d = Date.parse(tsArgs[0]);
          return isNaN(d) ? Date.now() : d;
        }
        return Date.now();
      }
      if (name === "alert" || name === "alertcondition" || name === "runtime") return NA;
      if (name === "__array_literal") return e.args.map(a => evalExpr(a));
      if (userFunctions[name]) {
        const fn = userFunctions[name];
        const savedVars: Record<string, any> = {};
        const savedAliases: { name: string; origB?: Series; origP?: Series }[] = [];
        for (let i = 0; i < fn.params.length; i++) {
          const paramName = fn.params[i];
          savedVars[paramName] = vars[paramName] ? vars[paramName][currentBar] : undefined;
          if (i < e.args.length) {
            const arg = e.args[i];
            if (arg.k === "id" && builtinSeries[arg.name]) {
              savedAliases.push({ name: paramName, origB: builtinSeries[paramName], origP: precomputed[paramName] });
              builtinSeries[paramName] = builtinSeries[arg.name];
            } else if (arg.k === "id" && precomputed[arg.name]) {
              savedAliases.push({ name: paramName, origB: builtinSeries[paramName], origP: precomputed[paramName] });
              precomputed[paramName] = precomputed[arg.name];
            }
            setVar(paramName, evalExpr(arg));
          } else {
            setVar(paramName, NA);
          }
        }
        for (const [kwName, kwExpr] of e.kw) {
          if (fn.params.includes(kwName)) {
            setVar(kwName, evalExpr(kwExpr));
          }
        }
        let result: any = NA;
        const bodyLen = fn.body.length;
        for (let si = 0; si < bodyLen - 1; si++) {
          const r = execStmt(fn.body[si]);
          if (r === "break" || r === "continue") break;
        }
        const lastStmt = bodyLen > 0 ? fn.body[bodyLen - 1] : null;
        if (lastStmt) {
          result = execStmtForValue(lastStmt);
        }
        for (const alias of savedAliases) {
          if (alias.origB !== undefined) builtinSeries[alias.name] = alias.origB; else delete builtinSeries[alias.name];
          if (alias.origP !== undefined) precomputed[alias.name] = alias.origP; else delete precomputed[alias.name];
        }
        for (const p of fn.params) {
          if (savedVars[p] !== undefined) {
            setVar(p, savedVars[p]);
          }
        }
        return result;
      }
    }

    if (e.fn.k === "mem" && e.fn.obj.k === "id") {
      const obj = e.fn.obj.name;
      const prop = e.fn.prop;

      if (obj === "input") return evalInputCall(prop, e.args, e.kw);
      if (obj === "strategy") return evalStrategyCall(prop, e.args, e.kw);
      if (obj === "color") return "#000000";
      if (obj === "line" || obj === "label" || obj === "box" || obj === "table") return NA;
    }

    return NA;
  }

  function evalBuiltinCall(ns: string, fn: string, args: Expr[], kw: [string, Expr][]): any {
    if (ns === "math") return evalMathCall(fn, args);
    if (ns === "ta") return evalTaCall(fn, args, kw);
    if (ns === "str") return evalStrCall(fn, args);
    if (ns === "strategy.commission") return fn;
    return NA;
  }

  function evalMathCall(fn: string, args: Expr[]): any {
    if (fn === "sum") {
      // math.sum(source, length): sliding sum of last `length` values of
      // `source` (NOT source+length). Static source → exact windowed sum with
      // full history; dynamic source → per-call-site accumulation. Warmup/NaN
      // handling matches ind.sma (math.sum === sma * length).
      const len = Math.round(toNum(evalExpr(args[1])));
      if (len <= 0 || currentBar < len - 1) return NA;
      const srcSeries = args[0] ? resolveExprSeries(args[0]) : null;
      const series = srcSeries ?? (() => {
        const key = `__mathSum_${JSON.stringify(args[0])}`;
        let arr = dynNumArrays.get(key);
        if (!arr) { arr = new Array(n).fill(NaN); dynNumArrays.set(key, arr); }
        arr[currentBar] = toNum(evalExpr(args[0]));
        return arr;
      })();
      let s = 0;
      for (let i = currentBar - len + 1; i <= currentBar; i++) {
        const v = series[i];
        if (isNaN(v)) return NA;
        s += v;
      }
      return s;
    }
    const vals = args.map(a => evalExpr(a));
    switch (fn) {
      case "abs": return Math.abs(toNum(vals[0]));
      case "max": {
        if (vals.length === 1 && Array.isArray(vals[0])) return Math.max(...vals[0].map(toNum));
        return Math.max(...vals.map(toNum));
      }
      case "min": {
        if (vals.length === 1 && Array.isArray(vals[0])) return Math.min(...vals[0].map(toNum));
        return Math.min(...vals.map(toNum));
      }
      case "sqrt": return Math.sqrt(toNum(vals[0]));
      case "round": return Math.round(toNum(vals[0]));
      case "floor": return Math.floor(toNum(vals[0]));
      case "ceil": return Math.ceil(toNum(vals[0]));
      case "log": return Math.log(toNum(vals[0]));
      case "log10": return Math.log10(toNum(vals[0]));
      case "pow": return Math.pow(toNum(vals[0]), toNum(vals[1]));
      case "avg": {
        const nums = vals.map(toNum).filter(v => !isNaN(v));
        return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : NaN;
      }
      case "sign": return Math.sign(toNum(vals[0]));
      case "round_to_mintick": {
        const v = toNum(vals[0]);
        return isNaN(v) ? NA : Math.round(v * 100) / 100;
      }
      default: return NaN;
    }
  }

  function resolveExprSeries(e: Expr): Series | null {
    if (e.k === "id") {
      if (builtinSeries[e.name]) return toNumArr(e.name);
      if (precomputed[e.name]) return precomputed[e.name];
      if (inputDefaults[e.name] !== undefined && typeof inputDefaults[e.name] === "string" && builtinSeries[inputDefaults[e.name]]) {
        return toNumArr(inputDefaults[e.name]);
      }
    }
    if (e.k === "call" && e.fn.k === "mem" && e.fn.obj.k === "id" && e.fn.obj.name === "ta") {
      return resolveNestedTaSeries(e.fn.prop, e.args, e.kw);
    }
    if (e.k === "call" && e.fn.k === "mem" && e.fn.obj.k === "id" && e.fn.obj.name === "math") {
      const mathFn = e.fn.prop;
      if (e.args.length >= 2 && (mathFn === "max" || mathFn === "min")) {
        const a = resolveExprSeries(e.args[0]);
        const b = resolveExprSeries(e.args[1]);
        if (a && b) {
          const result = new Array(n).fill(NaN);
          const op = mathFn === "max" ? Math.max : Math.min;
          for (let i = 0; i < n; i++) result[i] = (isNaN(a[i]) || isNaN(b[i])) ? NaN : op(a[i], b[i]);
          return result;
        }
      }
      if (e.args.length >= 1) {
        const inner = resolveExprSeries(e.args[0]);
        if (inner) {
          const result = new Array(n).fill(NaN);
          switch (mathFn) {
            case "abs": for (let i = 0; i < n; i++) result[i] = isNaN(inner[i]) ? NaN : Math.abs(inner[i]); break;
            case "sqrt": for (let i = 0; i < n; i++) result[i] = isNaN(inner[i]) ? NaN : Math.sqrt(inner[i]); break;
            case "log": for (let i = 0; i < n; i++) result[i] = isNaN(inner[i]) ? NaN : Math.log(inner[i]); break;
            case "log10": for (let i = 0; i < n; i++) result[i] = isNaN(inner[i]) ? NaN : Math.log10(inner[i]); break;
            case "ceil": for (let i = 0; i < n; i++) result[i] = isNaN(inner[i]) ? NaN : Math.ceil(inner[i]); break;
            case "floor": for (let i = 0; i < n; i++) result[i] = isNaN(inner[i]) ? NaN : Math.floor(inner[i]); break;
            case "round": for (let i = 0; i < n; i++) result[i] = isNaN(inner[i]) ? NaN : Math.round(inner[i]); break;
            case "sign": for (let i = 0; i < n; i++) result[i] = isNaN(inner[i]) ? NaN : Math.sign(inner[i]); break;
            default: break;
          }
          if (!result.every(v => isNaN(v))) return result;
        }
      }
    }
    if (e.k === "num") {
      const arr = new Array(n).fill(e.v);
      return arr;
    }
    if (e.k === "bin") {
      const lc = resolveConst(e.l);
      const rc = resolveConst(e.r);
      const lSeries = resolveExprSeries(e.l) ?? (lc !== undefined && typeof lc === "number" ? new Array(n).fill(lc) : null);
      const rSeries = resolveExprSeries(e.r) ?? (rc !== undefined && typeof rc === "number" ? new Array(n).fill(rc) : null);
      if (lSeries && rSeries) {
        const result = new Array(n).fill(NaN);
        for (let i = 0; i < n; i++) {
          if (!isNaN(lSeries[i]) && !isNaN(rSeries[i])) result[i] = evalBinOp(e.op, lSeries[i], rSeries[i]) as number;
        }
        return result;
      }
    }
    if (e.k === "id") {
      const cv = resolveConst(e);
      if (cv !== undefined && typeof cv === "number") return new Array(n).fill(cv);
    }
    return null;
  }

  function resolveNestedTaSeries(fn: string, innerArgs: Expr[], innerKw: [string, Expr][]): Series | null {
    if (fn === "ad") fn = "accdist";
    if (fn === "pearsonr") fn = "correlation";
    const h: Series = numHighArr;
    const l: Series = numLowArr;
    const cl: Series = numCloseArr;
    const op: Series = openArr;
    const numVol = (): Series => volArr;
    const cacheKey = `nested_${fn}_${innerArgs.map(a => {
      if (a.k === "id") {
        if (inputDefaults[a.name] !== undefined) return `@${a.name}=${inputDefaults[a.name]}`;
        if (precomputed[a.name]) { const pc = precomputed[a.name]; return `#${a.name}[${pc[0]},${pc[Math.min(10, pc.length-1)]},${pc.length}]`; }
        return a.name;
      }
      return a.k === "num" ? String(a.v) : "?";
    }).join("_")}`;
    if (indicatorCache.has(cacheKey)) return indicatorCache.get(cacheKey);

    function nSrc(idx: number): Series | null {
      if (idx >= innerArgs.length) return cl;
      return resolveExprSeries(innerArgs[idx]);
    }
    function nLen(idx: number, def: number = 14): number {
      if (idx >= innerArgs.length) return def;
      const v = resolveConst(innerArgs[idx]);
      return typeof v === "number" ? v : def;
    }

    let result: number[] | null = null;
    switch (fn) {
      case "sma": { const src = nSrc(0); const len = nLen(1); if (src) result = ind.sma(src, len); break; }
      case "ema": { const src = nSrc(0); const len = nLen(1); if (src) result = ind.pineEma(src, len); break; }
      case "rma": { const src = nSrc(0); const len = nLen(1); if (src) result = ind.rma(src, len); break; }
      case "wma": { const src = nSrc(0); const len = nLen(1); if (src) result = ind.wma(src, len); break; }
      case "rsi": { const src = nSrc(0); const len = nLen(1); if (src) result = ind.rsi(src, len); break; }
      case "atr": { const len = nLen(0); result = ind.atr(h, l, cl, len); break; }
      case "stdev": { const src = nSrc(0); const len = nLen(1); if (src) result = ind.stdev(src, len); break; }
      case "highest": { const src = nSrc(0); const len = nLen(1); if (src) result = ind.highest(src, len); break; }
      case "lowest": { const src = nSrc(0); const len = nLen(1); if (src) result = ind.lowest(src, len); break; }
      case "tr": { result = ind.trueRange(h, l, cl); break; }
      case "roc": {
        const src = nSrc(0); const len = nLen(1, 1);
        if (src) {
          result = new Array(n).fill(NaN);
          for (let i = len; i < n; i++) {
            const prev = src[i - len];
            result[i] = prev !== 0 && !isNaN(prev) ? 100 * (src[i] - prev) / prev : NaN;
          }
        }
        break;
      }
      case "change": {
        const src = nSrc(0);
        if (src) {
          const len = innerArgs.length > 1 ? nLen(1, 1) : 1;
          result = new Array(n).fill(NaN);
          for (let i = len; i < n; i++) {
            result[i] = (isNaN(src[i]) || isNaN(src[i - len])) ? NaN : src[i] - src[i - len];
          }
        }
        break;
      }
      case "crossover": {
        const a = nSrc(0);
        const b = innerArgs.length > 1 ? resolveExprSeries(innerArgs[1]) : null;
        if (a && b) {
          result = new Array(n).fill(0);
          for (let i = 1; i < n; i++) {
            if (!isNaN(a[i]) && !isNaN(b[i]) && !isNaN(a[i-1]) && !isNaN(b[i-1])) {
              result[i] = (a[i] > b[i] && a[i-1] <= b[i-1]) ? 1 : 0;
            }
          }
        }
        break;
      }
      case "crossunder": {
        const a = nSrc(0);
        const b = innerArgs.length > 1 ? resolveExprSeries(innerArgs[1]) : null;
        if (a && b) {
          result = new Array(n).fill(0);
          for (let i = 1; i < n; i++) {
            if (!isNaN(a[i]) && !isNaN(b[i]) && !isNaN(a[i-1]) && !isNaN(b[i-1])) {
              result[i] = (a[i] < b[i] && a[i-1] >= b[i-1]) ? 1 : 0;
            }
          }
        }
        break;
      }
      case "cross": {
        const a = nSrc(0);
        const b = innerArgs.length > 1 ? resolveExprSeries(innerArgs[1]) : null;
        if (a && b) {
          result = new Array(n).fill(0);
          for (let i = 1; i < n; i++) {
            if (!isNaN(a[i]) && !isNaN(b[i]) && !isNaN(a[i-1]) && !isNaN(b[i-1])) {
              const up = a[i] > b[i] && a[i-1] <= b[i-1];
              const dn = a[i] < b[i] && a[i-1] >= b[i-1];
              result[i] = (up || dn) ? 1 : 0;
            }
          }
        }
        break;
      }
      case "vwma": {
        const src = nSrc(0); const len = nLen(1);
        if (src) { result = ind.vwma(src, volArr, len); }
        break;
      }
      case "hma": { const src = nSrc(0); const len = nLen(1); if (src) result = ind.hma(src, len); break; }
      case "dema": { const src = nSrc(0); const len = nLen(1); if (src) result = ind.dema(src, len); break; }
      case "tema": { const src = nSrc(0); const len = nLen(1); if (src) result = ind.tema(src, len); break; }
      case "swma": { const src = nSrc(0); if (src) result = ind.swma(src); break; }
      case "cci": { const src = nSrc(0); const len = nLen(1, 20); if (src) result = ind.cci(src, len); break; }
      case "alma": {
        const src = nSrc(0); const len = nLen(1, 9);
        const offC = innerArgs.length > 2 ? resolveConst(innerArgs[2]) : undefined;
        const sigC = innerArgs.length > 3 ? resolveConst(innerArgs[3]) : undefined;
        const off = typeof offC === "number" ? offC : 0.85;
        const sig = typeof sigC === "number" ? sigC : 6;
        if (src) result = ind.alma(src, len, off, sig);
        break;
      }
      case "percentile_nearest_rank": {
        const src = nSrc(0); const len = nLen(1);
        const pC = innerArgs.length > 2 ? resolveConst(innerArgs[2]) : undefined;
        if (src && typeof pC === "number") result = ind.percentileNearestRank(src, len, pC);
        break;
      }
      case "percentile_linear_interpolation": {
        const src = nSrc(0); const len = nLen(1);
        const pC = innerArgs.length > 2 ? resolveConst(innerArgs[2]) : undefined;
        if (src && typeof pC === "number") result = ind.percentileLinearInterpolation(src, len, pC);
        break;
      }
      case "adx": {
        const diLen = nLen(0, 14);
        const adxSmooth = innerArgs.length > 1 ? nLen(1, diLen) : diLen;
        const { adxVal } = computeDmi(diLen, adxSmooth);
        result = adxVal as number[];
        break;
      }
      case "stoch": {
        const src = nSrc(0) || cl;
        const hi = nSrc(1) || h;
        const lo = nSrc(2) || l;
        const len = nLen(3, 14);
        result = new Array(n).fill(NaN);
        const hh = ind.highest(hi, len);
        const ll = ind.lowest(lo, len);
        for (let i = 0; i < n; i++) {
          const range = hh[i] - ll[i];
          if (!isNaN(src[i]) && !isNaN(hh[i]) && !isNaN(ll[i]) && range !== 0) {
            result[i] = 100 * (src[i] - ll[i]) / range;
          }
        }
        break;
      }
      case "bb": {
        const src = nSrc(0); const len = nLen(1, 20);
        const mC = innerArgs.length > 2 ? resolveConst(innerArgs[2]) : undefined;
        const mult = typeof mC === "number" ? mC : 2.0;
        if (src) { const b = ind.bollingerBands(src, len, mult); result = b.basis; }
        break;
      }
      case "kc": {
        const src = nSrc(0); const len = nLen(1, 20);
        const mC = innerArgs.length > 2 ? resolveConst(innerArgs[2]) : undefined;
        const mult = typeof mC === "number" ? mC : 1.5;
        if (src) { const b = ind.keltnerChannel(src, h, l, len, len, mult); result = b.basis; }
        break;
      }
      case "macd": {
        const src = nSrc(0); const fast = nLen(1, 12); const slow = nLen(2, 26); const sig = nLen(3, 9);
        if (src) result = ind.macd(src, fast, slow, sig).macd;
        break;
      }
      case "supertrend": {
        const factor = nLen(0, 3); const atrPeriod = nLen(1, 10);
        result = ind.supertrend(h, l, cl, factor, atrPeriod).supertrend;
        break;
      }
      case "dmi": {
        const diLen = nLen(0, 14);
        const adxSmooth = innerArgs.length > 1 ? nLen(1, diLen) : diLen;
        const { adxVal } = computeDmi(diLen, adxSmooth);
        result = adxVal as number[];
        break;
      }
      case "obv": result = ind.obv(cl, numVol()); break;
      case "accdist": result = ind.accdist(h, l, cl, numVol()); break;
      case "pvt": result = ind.pvt(cl, numVol()); break;
      case "nvi": result = ind.nvi(cl, numVol()); break;
      case "pvi": result = ind.pvi(cl, numVol()); break;
      case "iii": result = ind.iii(h, l, cl, numVol()); break;
      case "wad": result = ind.wad(h, l, cl); break;
      case "bop": result = ind.bop(op, h, l, cl); break;
      case "mom": { const src = nSrc(0); const len = nLen(1, 10); if (src) result = ind.mom(src, len); break; }
      case "wpr": { const len = nLen(0, 14); result = ind.wpr(h, l, cl, len); break; }
      case "cmo": { const src = nSrc(0); const len = nLen(1, 9); if (src) result = ind.cmo(src, len); break; }
      case "bbw": {
        const src = nSrc(0); const len = nLen(1, 20);
        const mC = innerArgs.length > 2 ? resolveConst(innerArgs[2]) : undefined;
        const mult = typeof mC === "number" ? mC : 2.0;
        if (src) result = ind.bbw(src, len, mult);
        break;
      }
      case "kcw": {
        const src = nSrc(0); const len = nLen(1, 20);
        const mC = innerArgs.length > 2 ? resolveConst(innerArgs[2]) : undefined;
        const mult = typeof mC === "number" ? mC : 1.5;
        if (src) result = ind.kcw(src, h, l, len, mult);
        break;
      }
      case "highestbars": {
        const src = innerArgs.length > 1 ? nSrc(0) : h;
        const len = innerArgs.length > 1 ? nLen(1) : nLen(0);
        if (src) result = ind.highestBars(src, len);
        break;
      }
      case "lowestbars": {
        const src = innerArgs.length > 1 ? nSrc(0) : l;
        const len = innerArgs.length > 1 ? nLen(1) : nLen(0);
        if (src) result = ind.lowestBars(src, len);
        break;
      }
      case "range": { const src = nSrc(0); const len = nLen(1); if (src) result = ind.rangeIndicator(src, len); break; }
      case "variance": { const src = nSrc(0); const len = nLen(1); if (src) result = ind.variance(src, len); break; }
      case "correlation": {
        const s1 = nSrc(0); const s2 = nSrc(1); const len = nLen(2);
        if (s1 && s2) result = ind.correlation(s1, s2, len);
        break;
      }
      case "cog": { const src = nSrc(0); const len = nLen(1); if (src) result = ind.cog(src, len); break; }
      case "aroon": { const len = nLen(0, 14); result = ind.aroon(h, l, len).upper; break; }
      case "tsi": {
        const src = nSrc(0); const sL = nLen(1, 13); const lL = nLen(2, 25);
        if (src) result = ind.tsi(src, sL, lL);
        break;
      }
      case "vortex": { const len = nLen(0, 14); result = ind.vortex(h, l, cl, len).viPlus; break; }
      case "mode": { const src = nSrc(0); const len = nLen(1); if (src) result = ind.mode(src, len); break; }
      case "sar": {
        const sC = resolveConst(innerArgs[0]);
        const iC = resolveConst(innerArgs[1]);
        const mC = resolveConst(innerArgs[2]);
        const s = typeof sC === "number" ? sC : 0.02;
        const inc = typeof iC === "number" ? iC : 0.02;
        const mx = typeof mC === "number" ? mC : 0.2;
        result = ind.sar(h, l, s, inc, mx);
        break;
      }
    }
    if (result) indicatorCache.set(cacheKey, result);
    return result;
  }

  function computeOnFly(fn: string, args: Expr[], kw: [string, Expr][]): number {
    if (fn === "ad") fn = "accdist";
    if (fn === "pearsonr") fn = "correlation";
    let isDynamic = false;

    function getH(): Float64Array | number[] { return numHighArr; }
    function getL_arr(): Float64Array | number[] { return numLowArr; }
    function getCl(): Float64Array | number[] { return numCloseArr; }
    function getOp(): Float64Array | number[] { return openArr; }
    function getVol(): Float64Array | number[] { return volArr; }

    function getSrc(idx: number): Series | null {
      if (idx >= args.length) return getCl();
      const a = args[idx];
      if (a.k === "id") {
        if (builtinSeries[a.name]) return toNumArr(a.name);
        if (precomputed[a.name]) return precomputed[a.name];
        if (vars[a.name]) {
          isDynamic = true;
          const arr = new Array(n).fill(NaN);
          for (let i = 0; i <= currentBar; i++) {
            const v = vars[a.name][i];
            arr[i] = v === undefined ? NaN : toNum(v);
          }
          return arr;
        }
        if (inputDefaults[a.name] !== undefined && typeof inputDefaults[a.name] === "string" && builtinSeries[inputDefaults[a.name]]) {
          return toNumArr(inputDefaults[a.name]);
        }
      }
      if (a.k === "mem" && a.obj.k === "id" && a.obj.name === "ta" && a.prop === "tr") {
        return ind.trueRange(getH(), getL_arr(), getCl());
      }
      if (a.k === "call" && a.fn.k === "mem" && a.fn.obj.k === "id" && a.fn.obj.name === "ta") {
        return resolveNestedTaSeries(a.fn.prop, a.args, a.kw);
      }
      if (a.k === "call" && a.fn.k === "mem" && a.fn.obj.k === "id" && a.fn.obj.name === "math") {
        return resolveExprSeries(a);
      }
      if (a.k === "bin") {
        const lSeries = resolveExprSeries(a.l);
        const rSeries = resolveExprSeries(a.r);
        if (lSeries && rSeries) {
          const result = new Array(n).fill(NaN);
          for (let i = 0; i < n; i++) {
            if (!isNaN(lSeries[i]) && !isNaN(rSeries[i])) result[i] = evalBinOp(a.op, lSeries[i], rSeries[i]);
          }
          return result;
        }
      }
      return null;
    }

    function getL(idx: number, def: number = 14): number {
      if (idx >= args.length) {
        const kwVal = kw.find(k => k[0] === "length");
        if (kwVal) { const v = resolveConst(kwVal[1]); return typeof v === "number" ? v : def; }
        return def;
      }
      const v = evalExpr(args[idx]);
      return typeof v === "number" && !isNaN(v) ? Math.round(v) : def;
    }

    function argKey(a: Expr): string {
      if (a.k === "id") {
        if (inputDefaults[a.name] !== undefined) return `@${a.name}=${inputDefaults[a.name]}`;
        if (precomputed[a.name]) {
          const pc = precomputed[a.name];
          return `#${a.name}[${pc[0]},${pc[Math.min(10, pc.length - 1)]},${pc.length}]`;
        }
        return a.name;
      }
      if (a.k === "num") return String(a.v);
      if (a.k === "str") return a.v;
      if (a.k === "un" && a.op === "-" && a.e.k === "num") return `-${a.e.v}`;
      if (a.k === "call" && a.fn.k === "mem") return `${(a.fn.obj as any).name || "?"}.${a.fn.prop}(${a.args.map(argKey).join(",")})`;
      if (a.k === "bin") return `(${argKey(a.l)}${a.op}${argKey(a.r)})`;
      const cv = resolveConst(a);
      if (cv !== undefined && cv !== null) return String(cv);
      return JSON.stringify(a).slice(0, 60);
    }
    const cacheKey = `${fn}_${args.map(argKey).join("_")}_${kw.map(k => `${k[0]}=${argKey(k[1])}`).join("_")}`;

    const hasDynamicSrc = args.length > 0 && args[0].k === "id" && !builtinSeries[args[0].name] && !precomputed[args[0].name] && vars[args[0].name];
    if (!hasDynamicSrc && indicatorCache.has(cacheKey)) {
      const cached = indicatorCache.get(cacheKey);
      return currentBar < cached.length ? (isNaN(cached[currentBar]) ? NA : cached[currentBar]) : NA;
    }

    function evalSrcFallback(idx: number): Series | null {
      const src = getSrc(idx);
      if (src) return src;
      if (idx < args.length) {
        isDynamic = true;
        const varName = `__dynSrc_${cacheKey}`;
        const v = toNum(evalExpr(args[idx]));
        let numArr = dynNumArrays.get(varName);
        if (!numArr) {
          numArr = new Array(n).fill(NaN);
          dynNumArrays.set(varName, numArr);
        }
        numArr[currentBar] = v;
        return numArr;
      }
      return null;
    }

    let result: number[] | null = null;
    switch (fn) {
      case "sma": { const src = evalSrcFallback(0); const len = getL(1); if (src) { if (isDynamic) return incrementalSma(src, len, currentBar); result = ind.sma(src, len); } break; }
      case "ema": { const src = evalSrcFallback(0); const len = getL(1); if (src) { if (isDynamic) return incrementalEma(cacheKey, src, len, currentBar); result = ind.pineEma(src, len); } break; }
      case "rma": { const src = evalSrcFallback(0); const len = getL(1); if (src) { if (isDynamic) return incrementalRma(cacheKey, src, len, currentBar); result = ind.rma(src, len); } break; }
      case "wma": { const src = evalSrcFallback(0); const len = getL(1); if (src) { if (isDynamic) return incrementalWma(src, len, currentBar); result = ind.wma(src, len); } break; }
      case "rsi": { const src = evalSrcFallback(0); const len = getL(1); if (src) { if (isDynamic) return incrementalRsi(cacheKey, src, len, currentBar); result = ind.rsi(src, len); } break; }
      case "atr": { const len = getL(0); result = ind.atr(getH(), getL_arr(), getCl(), len); break; }
      case "stdev": { const src = evalSrcFallback(0); const len = getL(1); if (src) { if (isDynamic) return incrementalStdev(src, len, currentBar); result = ind.stdev(src, len); } break; }
      case "highest": { const src = evalSrcFallback(0); const len = getL(1); if (src) { if (isDynamic) return incrementalHighest(src, len, currentBar); result = ind.highest(src, len); } break; }
      case "lowest": { const src = evalSrcFallback(0); const len = getL(1); if (src) { if (isDynamic) return incrementalLowest(src, len, currentBar); result = ind.lowest(src, len); } break; }
      case "tr": { result = ind.trueRange(getH(), getL_arr(), getCl()); break; }
      case "roc": {
        const src = getSrc(0); const len = getL(1, 1);
        if (src) {
          result = new Array(n).fill(NaN);
          for (let i = len; i < n; i++) {
            const prev = src[i - len];
            result[i] = prev !== 0 && !isNaN(prev) ? 100 * (src[i] - prev) / prev : NaN;
          }
        }
        break;
      }
      case "vwap": {
        const src = getSrc(0) || getCl();
        result = new Array(n).fill(NaN);
        let cumPV = 0, cumV = 0;
        for (let i = 0; i < n; i++) {
          cumPV += src[i] * (volArr[i] || 1);
          cumV += (volArr[i] || 1);
          result[i] = cumV !== 0 ? cumPV / cumV : src[i];
        }
        break;
      }
      case "pivothigh": {
        let src = getH(), leftBars: number, rightBars: number;
        if (args.length >= 3) { const s = getSrc(0); if (s) src = s; leftBars = getL(1, 5); rightBars = getL(2, 5); }
        else { leftBars = getL(0, 5); rightBars = getL(1, 5); }
        result = new Array(n).fill(NaN);
        for (let i = leftBars + rightBars; i < n; i++) {
          const pi = i - rightBars; let ok = true;
          for (let j = pi - leftBars; j < pi; j++) if (src[j] > src[pi]) { ok = false; break; }
          if (ok) for (let j = pi + 1; j <= pi + rightBars; j++) if (src[j] >= src[pi]) { ok = false; break; }
          if (ok) result[i] = src[pi];
        }
        break;
      }
      case "pivotlow": {
        let src = getL_arr(), leftBars: number, rightBars: number;
        if (args.length >= 3) { const s = getSrc(0); if (s) src = s; leftBars = getL(1, 5); rightBars = getL(2, 5); }
        else { leftBars = getL(0, 5); rightBars = getL(1, 5); }
        result = new Array(n).fill(NaN);
        for (let i = leftBars + rightBars; i < n; i++) {
          const pi = i - rightBars; let ok = true;
          for (let j = pi - leftBars; j < pi; j++) if (src[j] < src[pi]) { ok = false; break; }
          if (ok) for (let j = pi + 1; j <= pi + rightBars; j++) if (src[j] <= src[pi]) { ok = false; break; }
          if (ok) result[i] = src[pi];
        }
        break;
      }
      case "linreg": { const src = getSrc(0); const len = getL(1); if (src) result = ind.linreg(src, len); break; }
      case "percentrank": { const src = getSrc(0); const len = getL(1); if (src) result = ind.percentRank(src, len); break; }
      case "cum": {
        const src = getSrc(0);
        if (src) {
          result = new Array(n).fill(NaN);
          let total = 0;
          for (let i = 0; i < n; i++) { total += isNaN(src[i]) ? 0 : src[i]; result[i] = total; }
        }
        break;
      }
      case "falling": {
        const src = getSrc(0); const len = getL(1);
        if (src) {
          result = new Array(n).fill(0);
          for (let i = len; i < n; i++) {
            let ok = true;
            for (let j = 1; j <= len; j++) { if (src[i - j + 1] >= src[i - j]) { ok = false; break; } }
            result[i] = ok ? 1 : 0;
          }
        }
        break;
      }
      case "rising": {
        const src = getSrc(0); const len = getL(1);
        if (src) {
          result = new Array(n).fill(0);
          for (let i = len; i < n; i++) {
            let ok = true;
            for (let j = 1; j <= len; j++) { if (src[i - j + 1] <= src[i - j]) { ok = false; break; } }
            result[i] = ok ? 1 : 0;
          }
        }
        break;
      }
      case "dev": { const src = getSrc(0); const len = getL(1); if (src) result = ind.stdev(src, len); break; }
      case "median": {
        const src = getSrc(0); const len = getL(1);
        if (src) {
          result = new Array(n).fill(NaN);
          for (let i = len - 1; i < n; i++) {
            const window = src.slice(i - len + 1, i + 1).filter(v => !isNaN(v)).sort((a, b) => a - b);
            if (window.length > 0) result[i] = window[Math.floor(window.length / 2)];
          }
        }
        break;
      }
      case "mfi": {
        const srcArr = getSrc(0) || getCl();
        const len = getL(1, 14);
        if (srcArr) {
          result = new Array(n).fill(NaN);
          for (let i = len; i < n; i++) {
            let posMF = 0, negMF = 0;
            for (let j = i - len + 1; j <= i; j++) {
              const mf = srcArr[j] * (volArr[j] || 1);
              if (srcArr[j] > srcArr[j - 1]) posMF += mf;
              else if (srcArr[j] < srcArr[j - 1]) negMF += mf;
            }
            result[i] = negMF === 0 ? 100 : 100 - (100 / (1 + posMF / negMF));
          }
        }
        break;
      }
      case "vwma": {
        const src = getSrc(0); const len = getL(1);
        if (src) { result = ind.vwma(src, volArr, len); }
        break;
      }
      case "hma": { const src = getSrc(0); const len = getL(1); if (src) result = ind.hma(src, len); break; }
      case "dema": { const src = getSrc(0); const len = getL(1); if (src) result = ind.dema(src, len); break; }
      case "tema": { const src = getSrc(0); const len = getL(1); if (src) result = ind.tema(src, len); break; }
      case "swma": { const src = getSrc(0); if (src) result = ind.swma(src); break; }
      case "cci": { const src = getSrc(0); const len = getL(1, 20); if (src) result = ind.cci(src, len); break; }
      case "alma": {
        const src = getSrc(0); const len = getL(1, 9);
        const offC = args.length > 2 ? resolveConst(args[2]) : undefined;
        const sigC = args.length > 3 ? resolveConst(args[3]) : undefined;
        const off = typeof offC === "number" ? offC : 0.85;
        const sig = typeof sigC === "number" ? sigC : 6;
        if (src) result = ind.alma(src, len, off, sig);
        break;
      }
      case "percentile_nearest_rank": {
        const src = getSrc(0); const len = getL(1);
        const pC = args.length > 2 ? resolveConst(args[2]) : undefined;
        if (src && typeof pC === "number") result = ind.percentileNearestRank(src, len, pC);
        break;
      }
      case "percentile_linear_interpolation": {
        const src = getSrc(0); const len = getL(1);
        const pC = args.length > 2 ? resolveConst(args[2]) : undefined;
        if (src && typeof pC === "number") result = ind.percentileLinearInterpolation(src, len, pC);
        break;
      }
      case "stoch": {
        const src = getSrc(0) || getCl();
        const hi = getSrc(1) || getH();
        const lo = getSrc(2) || getL_arr();
        const len = getL(3, 14);
        result = new Array(n).fill(NaN);
        const hh = ind.highest(hi, len);
        const ll = ind.lowest(lo, len);
        for (let i = 0; i < n; i++) {
          const range = hh[i] - ll[i];
          if (!isNaN(src[i]) && !isNaN(hh[i]) && !isNaN(ll[i]) && range !== 0) {
            result[i] = 100 * (src[i] - ll[i]) / range;
          }
        }
        break;
      }
      case "adx": {
        const diLen = getL(0, 14);
        const adxSmooth = args.length > 1 ? getL(1, diLen) : diLen;
        const { adxVal } = computeDmi(diLen, adxSmooth);
        result = adxVal as number[];
        break;
      }
      case "obv": result = ind.obv(getCl(), getVol()); break;
      case "accdist": result = ind.accdist(getH(), getL_arr(), getCl(), getVol()); break;
      case "pvt": result = ind.pvt(getCl(), getVol()); break;
      case "nvi": result = ind.nvi(getCl(), getVol()); break;
      case "pvi": result = ind.pvi(getCl(), getVol()); break;
      case "iii": result = ind.iii(getH(), getL_arr(), getCl(), getVol()); break;
      case "wad": result = ind.wad(getH(), getL_arr(), getCl()); break;
      case "bop": result = ind.bop(getOp(), getH(), getL_arr(), getCl()); break;
      case "mom": { const src = getSrc(0); const len = getL(1, 10); if (src) result = ind.mom(src, len); break; }
      case "wpr": { const len = getL(0, 14); result = ind.wpr(getH(), getL_arr(), getCl(), len); break; }
      case "cmo": { const src = getSrc(0); const len = getL(1, 9); if (src) result = ind.cmo(src, len); break; }
      case "bbw": {
        const src = getSrc(0); const len = getL(1, 20);
        const mC = args.length > 2 ? resolveConst(args[2]) : undefined;
        const mult = typeof mC === "number" ? mC : 2.0;
        if (src) result = ind.bbw(src, len, mult);
        break;
      }
      case "kcw": {
        const src = getSrc(0); const len = getL(1, 20);
        const mC = args.length > 2 ? resolveConst(args[2]) : undefined;
        const mult = typeof mC === "number" ? mC : 1.5;
        if (src) result = ind.kcw(src, getH(), getL_arr(), len, mult);
        break;
      }
      case "highestbars": {
        const src = args.length > 1 ? getSrc(0) : getH();
        const len = args.length > 1 ? getL(1) : getL(0);
        if (src) result = ind.highestBars(src, len);
        break;
      }
      case "lowestbars": {
        const src = args.length > 1 ? getSrc(0) : getL_arr();
        const len = args.length > 1 ? getL(1) : getL(0);
        if (src) result = ind.lowestBars(src, len);
        break;
      }
      case "range": { const src = getSrc(0); const len = getL(1); if (src) result = ind.rangeIndicator(src, len); break; }
      case "variance": { const src = getSrc(0); const len = getL(1); if (src) result = ind.variance(src, len); break; }
      case "correlation": {
        const s1 = getSrc(0); const s2 = getSrc(1); const len = getL(2);
        if (s1 && s2) result = ind.correlation(s1, s2, len);
        break;
      }
      case "cog": { const src = getSrc(0); const len = getL(1); if (src) result = ind.cog(src, len); break; }
      case "aroon": { const len = getL(0, 14); result = ind.aroon(getH(), getL_arr(), len).upper; break; }
      case "tsi": {
        const src = getSrc(0); const sL = getL(1, 13); const lL = getL(2, 25);
        if (src) result = ind.tsi(src, sL, lL);
        break;
      }
      case "vortex": { const len = getL(0, 14); result = ind.vortex(getH(), getL_arr(), getCl(), len).viPlus; break; }
      case "mode": { const src = getSrc(0); const len = getL(1); if (src) result = ind.mode(src, len); break; }
      case "sar": {
        const sC = resolveConst(args[0]);
        const iC = resolveConst(args[1]);
        const mC = resolveConst(args[2]);
        const s = typeof sC === "number" ? sC : 0.02;
        const inc = typeof iC === "number" ? iC : 0.02;
        const mx = typeof mC === "number" ? mC : 0.2;
        result = ind.sar(getH(), getL_arr(), s, inc, mx);
        break;
      }
    }
    if (result) {
      if (!isDynamic) {
        indicatorCache.set(cacheKey, result);
        _lastFullSeries = result;
      }
      return currentBar < result.length ? (isNaN(result[currentBar]) ? NA : result[currentBar]) : NA;
    }
    return NA;
  }

  const emaState: Map<string, number> = new Map();
  const rmaState: Map<string, number> = new Map();
  const rsiState: Map<string, { avgGain: number; avgLoss: number }> = new Map();

  function incrementalSma(src: Series, len: number, bar: number): number {
    let sum = 0, count = 0;
    const start = Math.max(0, bar - len + 1);
    for (let i = start; i <= bar; i++) {
      const v = src[i];
      if (!isNaN(v)) { sum += v; count++; }
    }
    return count > 0 ? sum / count : NA;
  }

  function incrementalWma(src: Series, len: number, bar: number): number {
    if (bar < len - 1) return NA;
    const start = bar - len + 1;
    let weightedSum = 0;
    const denom = len * (len + 1) / 2;
    for (let i = start; i <= bar; i++) {
      const v = src[i];
      if (isNaN(v)) return NA;
      const w = i - start + 1;
      weightedSum += v * w;
    }
    return weightedSum / denom;
  }

  function incrementalEma(key: string, src: Series, len: number, bar: number): number {
    const alpha = 2 / (len + 1);
    const stateKey = `ema_${key}`;
    const v = src[bar];
    const prev = emaState.get(stateKey);
    if (prev === undefined || isNaN(prev)) {
      if (!isNaN(v)) {
        emaState.set(stateKey, v);
        return v;
      }
      return NA;
    }
    const result = alpha * v + (1 - alpha) * prev;
    emaState.set(stateKey, result);
    return isNaN(result) ? NA : result;
  }

  function incrementalRma(key: string, src: Series, len: number, bar: number): number {
    const alpha = 1 / len;
    const stateKey = `rma_${key}`;
    const prev = rmaState.get(stateKey);
    if (prev === undefined || isNaN(prev)) {
      if (bar >= len - 1) {
        let sum = 0;
        let valid = true;
        for (let j = bar - len + 1; j <= bar; j++) {
          if (isNaN(src[j])) { valid = false; break; }
          sum += src[j];
        }
        if (valid) {
          const sma = sum / len;
          rmaState.set(stateKey, sma);
          return sma;
        }
      }
      return NA;
    }
    const v = src[bar];
    const result = alpha * v + (1 - alpha) * prev;
    rmaState.set(stateKey, result);
    return isNaN(result) ? NA : result;
  }

  function incrementalRsi(key: string, src: Series, len: number, bar: number): number {
    const stateKey = `rsi_${key}`;
    if (bar < 1) return NA;
    const change = src[bar] - src[bar - 1];
    if (isNaN(change)) return NA;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    const prev = rsiState.get(stateKey);
    if (!prev || bar <= len) {
      let totalGain = 0, totalLoss = 0, count = 0;
      const start = Math.max(1, bar - len + 1);
      for (let i = start; i <= bar; i++) {
        const c = src[i] - src[i - 1];
        if (!isNaN(c)) {
          totalGain += c > 0 ? c : 0;
          totalLoss += c < 0 ? -c : 0;
          count++;
        }
      }
      if (count === 0) return NA;
      const avgGain = totalGain / count;
      const avgLoss = totalLoss / count;
      rsiState.set(stateKey, { avgGain, avgLoss });
      return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    const avgGain = (prev.avgGain * (len - 1) + gain) / len;
    const avgLoss = (prev.avgLoss * (len - 1) + loss) / len;
    rsiState.set(stateKey, { avgGain, avgLoss });
    return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  function incrementalStdev(src: Series, len: number, bar: number): number {
    const start = Math.max(0, bar - len + 1);
    let sum = 0, sumSq = 0, count = 0;
    for (let i = start; i <= bar; i++) {
      const v = src[i];
      if (!isNaN(v)) { sum += v; sumSq += v * v; count++; }
    }
    if (count < 2) return NA;
    const mean = sum / count;
    return Math.sqrt(Math.max(0, sumSq / count - mean * mean));
  }

  function incrementalHighest(src: Series, len: number, bar: number): number {
    const start = Math.max(0, bar - len + 1);
    let max = -Infinity;
    for (let i = start; i <= bar; i++) {
      if (!isNaN(src[i]) && src[i] > max) max = src[i];
    }
    return max === -Infinity ? NA : max;
  }

  function incrementalLowest(src: Series, len: number, bar: number): number {
    const start = Math.max(0, bar - len + 1);
    let min = Infinity;
    for (let i = start; i <= bar; i++) {
      if (!isNaN(src[i]) && src[i] < min) min = src[i];
    }
    return min === Infinity ? NA : min;
  }

  function getSrcForBb(e: Expr): Series | null {
    if (e.k === "id") {
      if (builtinSeries[e.name]) return toNumArr(e.name);
      if (precomputed[e.name]) return precomputed[e.name];
    }
    return null;
  }

  function argKeyForTa(a: Expr): string {
    if (a.k === "id") {
      if (inputDefaults[a.name] !== undefined) return `@${a.name}=${inputDefaults[a.name]}`;
      if (precomputed[a.name]) {
        const pc = precomputed[a.name];
        return `#${a.name}[${pc[0]},${pc[Math.min(10, pc.length - 1)]},${pc.length}]`;
      }
      return a.name;
    }
    if (a.k === "num") return String(a.v);
    const cv = resolveConst(a);
    if (cv !== undefined && cv !== null) return String(cv);
    return "expr";
  }

  function evalTaCall(fn: string, args: Expr[], kw: [string, Expr][]): any {
    if (fn === "ad") fn = "accdist";
    if (fn === "pearsonr") fn = "correlation";
    switch (fn) {
      case "sma": case "ema": case "rma": case "wma": case "rsi":
      case "atr": case "stdev": case "highest": case "lowest":
      case "pivothigh": case "pivotlow": case "vwap": case "tr":
      case "linreg": case "percentrank": case "cum": case "roc":
      case "falling": case "rising": case "dev": case "median": case "mfi":
      case "vwma": case "hma": case "dema": case "tema": case "alma":
      case "swma": case "cci": case "percentile_nearest_rank":
      case "percentile_linear_interpolation":
      case "obv": case "accdist": case "pvt": case "nvi": case "pvi":
      case "iii": case "wad": case "bop": case "mom": case "wpr": case "cmo":
      case "bbw": case "kcw": case "highestbars": case "lowestbars":
      case "range": case "variance": case "correlation": case "cog":
      case "tsi": case "mode": case "sar": {
        return computeOnFly(fn, args, kw);
      }
      case "aroon": {
        const len = args.length > 0 ? Math.round(toNum(evalExpr(args[0]))) : 14;
        const ck = `aroon_${len}`;
        if (!indicatorCache.has(ck)) indicatorCache.set(ck, ind.aroon(numHighArr, numLowArr, len));
        const a = indicatorCache.get(ck);
        const b = currentBar;
        return [
          b < a.upper.length && !isNaN(a.upper[b]) ? a.upper[b] : NA,
          b < a.lower.length && !isNaN(a.lower[b]) ? a.lower[b] : NA,
        ];
      }
      case "vortex": {
        const len = args.length > 0 ? Math.round(toNum(evalExpr(args[0]))) : 14;
        const ck = `vortex_${len}`;
        if (!indicatorCache.has(ck)) indicatorCache.set(ck, ind.vortex(numHighArr, numLowArr, numCloseArr, len));
        const v = indicatorCache.get(ck);
        const b = currentBar;
        return [
          b < v.viPlus.length && !isNaN(v.viPlus[b]) ? v.viPlus[b] : NA,
          b < v.viMinus.length && !isNaN(v.viMinus[b]) ? v.viMinus[b] : NA,
        ];
      }
      case "macd": {
        const srcArr = resolveExprSeries(args[0]);
        const fast = args.length > 1 ? Math.round(toNum(evalExpr(args[1]))) : 12;
        const slow = args.length > 2 ? Math.round(toNum(evalExpr(args[2]))) : 26;
        const sig = args.length > 3 ? Math.round(toNum(evalExpr(args[3]))) : 9;
        const ck = `macd_${argKeyForTa(args[0])}_${fast}_${slow}_${sig}`;
        if (!indicatorCache.has(ck) && srcArr) {
          indicatorCache.set(ck, ind.macd(srcArr, fast, slow, sig));
        }
        const m = indicatorCache.get(ck);
        if (!m) return [NA, NA, NA];
        const b = currentBar;
        return [
          b < m.macd.length && !isNaN(m.macd[b]) ? m.macd[b] : NA,
          b < m.signal.length && !isNaN(m.signal[b]) ? m.signal[b] : NA,
          b < m.hist.length && !isNaN(m.hist[b]) ? m.hist[b] : NA,
        ];
      }
      case "supertrend": {
        const factor = toNum(evalExpr(args[0]));
        const atrPeriod = args.length > 1 ? Math.round(toNum(evalExpr(args[1]))) : 10;
        const ck = `supertrend_${factor}_${atrPeriod}`;
        if (!indicatorCache.has(ck)) {
          indicatorCache.set(ck, ind.supertrend(numHighArr, numLowArr, numCloseArr, factor, atrPeriod));
        }
        const s = indicatorCache.get(ck);
        const b = currentBar;
        return [
          b < s.supertrend.length && !isNaN(s.supertrend[b]) ? s.supertrend[b] : NA,
          b < s.direction.length && !isNaN(s.direction[b]) ? s.direction[b] : NA,
        ];
      }
      case "dmi": {
        const diLen = toNum(evalExpr(args[0]));
        const adxSmooth = args.length > 1 ? toNum(evalExpr(args[1])) : diLen;
        const { diPlus, diMinus, adxVal } = computeDmi(diLen, adxSmooth);
        return [
          isNaN(diPlus[currentBar]) ? NA : diPlus[currentBar],
          isNaN(diMinus[currentBar]) ? NA : diMinus[currentBar],
          isNaN(adxVal[currentBar]) ? NA : adxVal[currentBar],
        ];
      }
      case "stoch": {
        const srcArr = resolveExprSeries(args[0]) || numCloseArr;
        const hArr = args.length > 1 ? (resolveExprSeries(args[1]) || numHighArr) : numHighArr;
        const lArr = args.length > 2 ? (resolveExprSeries(args[2]) || numLowArr) : numLowArr;
        const len = args.length > 3 ? Math.round(toNum(evalExpr(args[3]))) : 14;
        const ck = `stoch_${argKeyForTa(args[0])}_${len}`;
        if (!indicatorCache.has(ck)) {
          const res = new Array(n).fill(NaN);
          for (let i = len - 1; i < n; i++) {
            let hh = -Infinity, ll = Infinity;
            for (let j = i - len + 1; j <= i; j++) {
              if (hArr[j] > hh) hh = hArr[j];
              if (lArr[j] < ll) ll = lArr[j];
            }
            const range = hh - ll;
            res[i] = range > 0 ? ((srcArr[i] - ll) / range) * 100 : 50;
          }
          indicatorCache.set(ck, res);
        }
        const stochVals = indicatorCache.get(ck);
        _lastFullSeries = stochVals;
        return currentBar < stochVals.length && !isNaN(stochVals[currentBar]) ? stochVals[currentBar] : NA;
      }
      case "adx": {
        const diLen = Math.round(toNum(evalExpr(args[0])));
        const adxSmooth = args.length > 1 ? Math.round(toNum(evalExpr(args[1]))) : diLen;
        const { adxVal } = computeDmi(diLen, adxSmooth);
        return currentBar < adxVal.length && !isNaN(adxVal[currentBar]) ? adxVal[currentBar] : NA;
      }
      case "bb": {
        const srcArr = getSrcForBb(args[0]);
        const len = args.length > 1 ? toNum(evalExpr(args[1])) : 20;
        const mult = args.length > 2 ? toNum(evalExpr(args[2])) : 2.0;
        const ck = `bb_${argKeyForTa(args[0])}_${len}_${mult}`;
        if (!indicatorCache.has(ck) && srcArr) {
          indicatorCache.set(ck, ind.bollingerBands(srcArr, Math.round(len), mult));
        }
        const bands = indicatorCache.get(ck);
        if (!bands) return [NA, NA, NA];
        const b = currentBar;
        return [
          b < bands.basis.length && !isNaN(bands.basis[b]) ? bands.basis[b] : NA,
          b < bands.upper.length && !isNaN(bands.upper[b]) ? bands.upper[b] : NA,
          b < bands.lower.length && !isNaN(bands.lower[b]) ? bands.lower[b] : NA,
        ];
      }
      case "kc": {
        const srcArr = getSrcForBb(args[0]);
        const len = args.length > 1 ? toNum(evalExpr(args[1])) : 20;
        const mult = args.length > 2 ? toNum(evalExpr(args[2])) : 1.5;
        const ck = `kc_${argKeyForTa(args[0])}_${len}_${mult}`;
        if (!indicatorCache.has(ck)) {
          indicatorCache.set(ck, ind.keltnerChannel(
            srcArr || numCloseArr,
            numHighArr, numLowArr,
            Math.round(len), Math.round(len), mult));
        }
        const bands = indicatorCache.get(ck);
        const b = currentBar;
        return [
          b < bands.basis.length && !isNaN(bands.basis[b]) ? bands.basis[b] : NA,
          b < bands.upper.length && !isNaN(bands.upper[b]) ? bands.upper[b] : NA,
          b < bands.lower.length && !isNaN(bands.lower[b]) ? bands.lower[b] : NA,
        ];
      }
      case "crossover": {
        const a = toNum(evalExpr(args[0]));
        const b = toNum(evalExpr(args[1]));
        if (currentBar < 1) return false;
        const aPrev = getPrevVal(args[0]);
        const bPrev = getPrevVal(args[1]);
        return a > b && aPrev <= bPrev;
      }
      case "crossunder": {
        const a = toNum(evalExpr(args[0]));
        const b = toNum(evalExpr(args[1]));
        if (currentBar < 1) return false;
        const aPrev = getPrevVal(args[0]);
        const bPrev = getPrevVal(args[1]);
        return a < b && aPrev >= bPrev;
      }
      case "cross": {
        const a = toNum(evalExpr(args[0]));
        const b = toNum(evalExpr(args[1]));
        if (currentBar < 1) return false;
        const aPrev = getPrevVal(args[0]);
        const bPrev = getPrevVal(args[1]);
        return (a > b && aPrev <= bPrev) || (a < b && aPrev >= bPrev);
      }
      case "change": {
        const v = evalExpr(args[0]);
        const len = args.length > 1 ? toNum(evalExpr(args[1])) : 1;
        const prev = getPrevValN(args[0], len);
        return toNum(v) - toNum(prev);
      }
      case "barssince": {
        const cond = args[0];
        for (let b = currentBar; b >= 0; b--) {
          const saved = currentBar;
          currentBar = b;
          const val = evalExpr(cond);
          currentBar = saved;
          if (val && val !== NA) return saved - b;
        }
        return NA;
      }
      case "valuewhen": {
        const cond = args[0];
        const src = args[1];
        const occurrence = args.length > 2 ? toNum(evalExpr(args[2])) : 0;
        let found = 0;
        for (let b = currentBar; b >= 0; b--) {
          const saved = currentBar;
          currentBar = b;
          const condVal = evalExpr(cond);
          if (condVal && condVal !== NA) {
            if (found >= occurrence) {
              const result = evalExpr(src);
              currentBar = saved;
              return result;
            }
            found++;
          }
          currentBar = saved;
        }
        return NA;
      }
      case "cum": {
        const v = toNum(evalExpr(args[0]));
        const cumKey = "__ta_cum_" + (args[0].k === "id" ? args[0].name : "x");
        const prevCum = currentBar > 0 ? toNum(getVar(cumKey, 1)) : 0;
        const result = (isNaN(prevCum) ? 0 : prevCum) + (isNaN(v) ? 0 : v);
        setVar(cumKey, result);
        return result;
      }
      default: return NA;
    }
  }

  function getPrevVal(e: Expr): number {
    if (e.k === "id") return toNum(getVar(e.name, 1));
    if (currentBar < 1) return NaN;
    const saved = currentBar;
    currentBar = saved - 1;
    const v = toNum(evalExpr(e));
    currentBar = saved;
    return v;
  }

  function getPrevValN(e: Expr, offset: number): number {
    if (e.k === "id") return toNum(getVar(e.name, offset));
    if (currentBar < offset) return NaN;
    const saved = currentBar;
    currentBar = saved - offset;
    const v = toNum(evalExpr(e));
    currentBar = saved;
    return v;
  }

  function evalStrCall(fn: string, args: Expr[]): any {
    switch (fn) {
      case "tostring": return String(evalExpr(args[0]));
      case "format": return String(evalExpr(args[0]));
      default: return "";
    }
  }

  let currentDeclName: string | null = null;

  function evalInputCall(type: string, args: Expr[], kw: [string, Expr][]): any {
    if (currentDeclName && params[currentDeclName] !== undefined) {
      return params[currentDeclName];
    }
    if (currentDeclName && inputDefaults[currentDeclName] !== undefined) {
      const def = inputDefaults[currentDeclName];
      if (type === "source" && typeof def === "string" && builtinSeries[def]) {
        return builtinSeries[def][currentBar];
      }
      return def;
    }
    if (args.length > 0) {
      const kwDefval = kw.find(k => k[0] === "defval");
      if (kwDefval) return evalExpr(kwDefval[1]);
      return evalExpr(args[0]);
    }
    switch (type) {
      case "int": return 0;
      case "float": return 0.0;
      case "bool": return false;
      case "string": return "";
      case "time": return 0;
      case "source": return closeArr[currentBar];
      default: return 0;
    }
  }

  function evalStrategyCall(fn: string, args: Expr[], kw: [string, Expr][]): any {
    const getKw = (name: string): any => {
      const found = kw.find(k => k[0] === name);
      return found ? evalExpr(found[1]) : undefined;
    };

    const time = candles[currentBar].time;
    const bar = currentBar;

    switch (fn) {
      case "entry": {
        const id = args.length > 0 ? String(evalExpr(args[0])) : "Entry";
        const dir = args.length > 1 ? evalExpr(args[1]) : getKw("direction") || "long";
        const when = getKw("when");
        if (when !== undefined && !when) return NA;
        const direction = dir === "long" ? "long" as const : "short" as const;
        broker.queueEntry(id, direction, bar, time);
        return NA;
      }
      case "close": {
        const id = args.length > 0 ? String(evalExpr(args[0])) : "";
        const qtyPct = getKw("qty_percent") ?? 100;
        const comment = getKw("comment") ?? id;
        const when = getKw("when");
        if (when !== undefined && !when) return NA;
        broker.queueClose(id, toNum(qtyPct), String(comment), false);
        return NA;
      }
      case "close_all": {
        const comment = getKw("comment") ?? "Close All";
        broker.queueClose("", 100, String(comment), true);
        return NA;
      }
      case "exit": {
        const id = args.length > 0 ? String(evalExpr(args[0])) : "Exit";
        const fromEntry = args.length > 1 ? String(evalExpr(args[1])) : (getKw("from_entry") ?? "");
        const stop = getKw("stop");
        const limit = getKw("limit");
        const trailPrice = getKw("trail_price");
        const rawTrailOffset = getKw("trail_offset");
        const trailOffset = (rawTrailOffset != null && !isNa(rawTrailOffset)) ? rawTrailOffset * 0.01 : rawTrailOffset;
        const qtyPercent = getKw("qty_percent") ?? 100;
        broker.addExit(id, String(fromEntry), stop ?? null, limit ?? null, trailPrice ?? null, trailOffset ?? null, toNum(qtyPercent));
        return NA;
      }
      default: return NA;
    }
  }

  function execStmt(stmt: Stmt): "break" | "continue" | null {
    if ((++totalOps & 4095) === 0) { opsThrottle += 4096; if (totalOps > MAX_TOTAL_OPS) throw new Error("Global execution budget exceeded"); if (opsThrottle > MAX_OPS) throw new Error("Execution budget exceeded"); }

    switch (stmt.k) {
      case "decl": {
        currentDeclName = stmt.name;
        if (stmt.isVar) {
          if (currentBar === 0) {
            const v = evalExpr(stmt.e);
            setVar(stmt.name, v);
            varIsVar.add(stmt.name);
          } else {
            const prev = getVar(stmt.name, 1);
            setVar(stmt.name, prev);
          }
        } else {
          const pc = precomputed[stmt.name];
          if (pc) {
            const v = pc[currentBar];
            setVar(stmt.name, isNaN(v) ? NA : v);
          } else {
            const v = evalExpr(stmt.e);
            setVar(stmt.name, v);
          }
        }
        currentDeclName = null;
        break;
      }
      case "multi_decl": {
        let allPrecomputed = true;
        for (const nm of stmt.names) {
          if (!precomputed[nm]) { allPrecomputed = false; break; }
        }
        if (allPrecomputed) {
          for (const nm of stmt.names) {
            const v = precomputed[nm][currentBar];
            setVar(nm, isNaN(v) ? NA : v);
          }
          break;
        }
        const result = evalExpr(stmt.e);
        if (Array.isArray(result)) {
          for (let i = 0; i < stmt.names.length; i++) {
            setVar(stmt.names[i], i < result.length ? result[i] : NA);
          }
        }
        break;
      }
      case "reassign": {
        const v = evalExpr(stmt.e);
        if (stmt.target.k === "id") {
          setVar(stmt.target.name, v);
        }
        break;
      }
      case "aug": {
        const rhs = evalExpr(stmt.e);
        if (stmt.target.k === "id") {
          const cur = getVar(stmt.target.name, 0);
          let result: any;
          switch (stmt.op) {
            case "+=": result = toNum(cur) + toNum(rhs); break;
            case "-=": result = toNum(cur) - toNum(rhs); break;
            case "*=": result = toNum(cur) * toNum(rhs); break;
            case "/=": result = toNum(rhs) === 0 ? NaN : toNum(cur) / toNum(rhs); break;
            default: result = cur;
          }
          setVar(stmt.target.name, result);
        }
        break;
      }
      case "if": {
        const cond = evalExpr(stmt.c);
        if (cond) {
          for (const s of stmt.body) {
            const r = execStmt(s);
            if (r) return r;
          }
        } else {
          let handled = false;
          for (const elif of stmt.elifs) {
            if (evalExpr(elif.c)) {
              for (const s of elif.body) {
                const r = execStmt(s);
                if (r) return r;
              }
              handled = true;
              break;
            }
          }
          if (!handled && stmt.el) {
            for (const s of stmt.el) {
              const r = execStmt(s);
              if (r) return r;
            }
          }
        }
        break;
      }
      case "for": {
        const start = Math.round(toNum(evalExpr(stmt.start)));
        const end = Math.round(toNum(evalExpr(stmt.end)));
        const step = stmt.step ? Math.round(toNum(evalExpr(stmt.step))) : 1;
        if (step === 0) break;
        let iterations = 0;
        const maxIter = 10000;
        for (let i = start; step > 0 ? i <= end : i >= end; i += step) {
          if (++iterations > maxIter) break;
          setVar(stmt.v, i);
          let brk = false;
          for (const s of stmt.body) {
            const r = execStmt(s);
            if (r === "break") { brk = true; break; }
            if (r === "continue") break;
          }
          if (brk) break;
        }
        break;
      }
      case "while": {
        let iterations = 0;
        const maxIter = 10000;
        while (evalExpr(stmt.c) && ++iterations <= maxIter) {
          let brk = false;
          for (const s of stmt.body) {
            const r = execStmt(s);
            if (r === "break") { brk = true; break; }
            if (r === "continue") break;
          }
          if (brk) break;
        }
        break;
      }
      case "switch": {
        const switchVal = stmt.e ? evalExpr(stmt.e) : null;
        for (const c of stmt.cases) {
          let matched = false;
          for (const v of c.vals) {
            if (v === null) { matched = true; break; }
            const cv = evalExpr(v);
            if (switchVal !== null && cv === switchVal) { matched = true; break; }
            if (switchVal === null && cv) { matched = true; break; }
          }
          if (matched) {
            for (const s of c.body) {
              const r = execStmt(s);
              if (r) return r;
            }
            break;
          }
        }
        break;
      }
      case "func_decl": {
        userFunctions[stmt.name] = { params: stmt.params, body: stmt.body };
        break;
      }
      case "expr": {
        evalExpr(stmt.e);
        break;
      }
      case "break": return "break";
      case "continue": return "continue";
    }
    return null;
  }

  function resolveInputDefault(args: Expr[], kw: [string, Expr][], type: string): any {
    const kwDefval = kw.find(k => k[0] === "defval");
    if (kwDefval) {
      const v = resolveConst(kwDefval[1]);
      if (v !== undefined) return v;
    }
    if (args.length > 0) {
      const v = resolveConst(args[0]);
      if (v !== undefined) return v;
    }
    switch (type) {
      case "int": return 0;
      case "float": return 0.0;
      case "bool": return false;
      case "string": return "";
      case "source": return "close";
      case "time": return 0;
      default: return 0;
    }
  }

  function precomputePhase() {
    for (const stmt of ast) {
      if (stmt.k === "func_decl") {
        userFunctions[stmt.name] = { params: stmt.params, body: stmt.body };
        continue;
      }
      if (stmt.k === "decl" && !stmt.isVar) {
        if (stmt.e.k === "call" && stmt.e.fn.k === "mem" && stmt.e.fn.obj.k === "id" && stmt.e.fn.obj.name === "input") {
          if (params[stmt.name] !== undefined) {
            inputDefaults[stmt.name] = params[stmt.name];
          } else {
            inputDefaults[stmt.name] = resolveInputDefault(stmt.e.args, stmt.e.kw, stmt.e.fn.prop);
          }
          continue;
        }
        if (stmt.e.k === "call" && stmt.e.fn.k === "id" && stmt.e.fn.name === "strategy") {
          continue;
        }
        if (stmt.e.k === "id" && builtinSeries[stmt.e.name]) {
          builtinSeries[stmt.name] = builtinSeries[stmt.e.name];
          continue;
        }
        if (stmt.e.k === "str") {
          inputDefaults[stmt.name] = stmt.e.v;
          continue;
        }
        if (stmt.e.k === "num") {
          inputDefaults[stmt.name] = stmt.e.v;
          continue;
        }
        if (stmt.e.k === "bool") {
          inputDefaults[stmt.name] = stmt.e.v;
          continue;
        }
        if (stmt.e.k !== "na") {
          tryPrecompute(stmt.name, stmt.e);
        }
      }
    }
  }

  precomputePhase();

  const maxPasses = Math.min(ast.length, 32);
  for (let pass = 0; pass < maxPasses; pass++) {
    let newlyPrecomputed = 0;
    for (const stmt of ast) {
      if (stmt.k === "multi_decl") {
        if (stmt.names.every((nm: string) => precomputed[nm])) continue;
        if (stmt.e.k === "call" && stmt.e.fn.k === "id" && userFunctions[stmt.e.fn.name]) {
          const fn = userFunctions[stmt.e.fn.name];
          if (fn) {
            const tempResults = tryPrecomputeUserFuncMulti(stmt.e.fn.name, stmt.e.args, stmt.e.kw, stmt.names);
            if (tempResults) {
              for (let i = 0; i < stmt.names.length; i++) {
                const tr = tempResults[i];
                if (tr) { precomputed[stmt.names[i]] = tr; newlyPrecomputed++; }
              }
            }
          }
        }
        continue;
      }
      if (stmt.k !== "decl" || stmt.isVar) continue;
      if (precomputed[stmt.name]) continue;
      if (inputDefaults[stmt.name] !== undefined) continue;
      if (stmt.e.k === "call" && stmt.e.fn.k === "id" && stmt.e.fn.name === "strategy") continue;
      if (stmt.e.k === "id" && builtinSeries[stmt.e.name]) { builtinSeries[stmt.name] = builtinSeries[stmt.e.name]; continue; }
      if (stmt.e.k !== "na" && tryPrecompute(stmt.name, stmt.e)) newlyPrecomputed++;
    }
    if (newlyPrecomputed === 0) break;
  }

  for (const [k, v] of Object.entries(precomputed)) allSeries.set(k, v);

  function isVisualOnlyStmt(stmt: Stmt): boolean {
    if (stmt.k === "expr" && stmt.e.k === "call") {
      const fn = stmt.e.fn;
      if (fn.k === "id") {
        const name = fn.name;
        if (name === "plot" || name === "plotshape" || name === "plotchar" ||
            name === "plotcandle" || name === "plotarrow" || name === "plotbar" ||
            name === "bgcolor" || name === "barcolor" || name === "fill" ||
            name === "hline" || name === "label" || name === "line" || name === "box" ||
            name === "table") return true;
      }
      if (fn.k === "mem" && fn.obj.k === "id") {
        const obj = fn.obj.name;
        if (obj === "label" || obj === "line" || obj === "box" || obj === "table" ||
            obj === "color") return true;
      }
    }
    if (stmt.k === "decl" && !stmt.isVar) {
      const e = stmt.e;
      if (e.k === "call" && e.fn.k === "id") {
        const name = e.fn.name;
        if (name === "plot" || name === "plotshape" || name === "plotchar" ||
            name === "color" || name === "plotcandle" || name === "bgcolor" ||
            name === "barcolor") return true;
      }
      if (e.k === "call" && e.fn.k === "mem" && e.fn.obj.k === "id") {
        const obj = e.fn.obj.name;
        if (obj === "color") return true;
      }
    }
    return false;
  }

  const hotStmts: Stmt[] = [];
  for (const stmt of ast) {
    if (stmt.k === "func_decl") continue;
    if (stmt.k === "decl" && !stmt.isVar) {
      if (precomputed[stmt.name]) continue;
      if (inputDefaults[stmt.name] !== undefined) continue;
      if (stmt.e.k === "call" && stmt.e.fn.k === "id" && stmt.e.fn.name === "strategy") continue;
      if (stmt.e.k === "id" && builtinSeries[stmt.name]) continue;
    }
    if (isVisualOnlyStmt(stmt)) continue;
    hotStmts.push(stmt);
  }

  const equityValues = new Array(n);

  const varIsVarSet = new Set<string>();
  for (const s of hotStmts) {
    if (s.k === "decl" && s.isVar) varIsVarSet.add(s.name);
  }

  let compiledLoop: ((rctx: any) => void) | null = null;
  let usedCompiledPath = false;
  if (!forceInterpreter) {
    try {
      const compilerCtx: CompilerContext = {
        precomputedNames: new Set(Object.keys(precomputed)),
        builtinSeriesNames: new Set(Object.keys(builtinSeries)),
        inputDefaultNames: new Set(Object.keys(inputDefaults)),
        varIsVarNames: varIsVarSet,
        userFunctionNames: new Set(Object.keys(userFunctions)),
        paramNames: new Set(Object.keys(params)),
      };
      compiledLoop = compilePineHotLoop(hotStmts, userFunctions, compilerCtx) as any;
    } catch (e: any) {
      console.log("[Pine compiler] fallback:", e.message?.substring(0, 200));
    }
  }

  if (compiledLoop) {
    const rctx: any = {
      bar: 0,
      n,
      ticker,
      broker,
      builtinSeries,
      pc: precomputed,
      vars,
      params,
      inputDefaults,
      _openArr: openArr,
      _highArr: highArr,
      _lowArr: lowArr,
      _closeArr: closeArr,
      _candles: candles,
      _equityValues: equityValues,
      _processOrdersOnClose: !!config.processOrdersOnClose,
      _barFn: null as any,
      _N: null as any,
      _add: null as any,

      _varArrayCache: new Map<string, any[]>(),
      getVar(name: string, offset: number): any {
        const idx = rctx.bar - offset;
        if (idx < 0) return null;
        let s = rctx._varArrayCache.get(name);
        if (s === undefined) {
          const series = allSeries.get(name);
          if (series) { s = series as any; rctx._varArrayCache.set(name, s); }
          else return null;
        }
        const v = s[idx];
        return v === undefined || (typeof v === 'number' && v !== v) ? null : v;
      },

      setVar(name: string, value: any) {
        let arr = vars[name];
        if (!arr) {
          arr = new Array(n);
          vars[name] = arr;
          allSeries.set(name, arr);
          rctx._varArrayCache.set(name, arr);
        }
        arr[rctx.bar] = value;
      },

      markVar(name: string) {
        varIsVar.add(name);
        if (vars[name] && !allSeries.has(name)) {
          allSeries.set(name, vars[name]);
        }
      },

      toNum(v: any): number { return v == null ? NaN : Number(v); },
      toNumOrNull(v: any): number | null {
        if (v == null) return null;
        const num = Number(v);
        return isNaN(num) ? null : num;
      },
      trailOffsetToPrice(v: any): number | null {
        if (v == null) return null;
        const num = Number(v);
        if (isNaN(num)) return null;
        return num * 0.01;
      },
      isNa(v: any): boolean { return v === null || v === undefined || (typeof v === 'number' && isNaN(v)); },

      fixnan(v: any, name: string | null): any {
        if (v !== null && v !== undefined && !(typeof v === 'number' && isNaN(v))) return v;
        if (name) {
          for (let b = rctx.bar - 1; b >= 0; b--) {
            const prev = rctx.getVar(name, rctx.bar - b);
            if (prev !== null && prev !== undefined && !(typeof prev === 'number' && isNaN(prev))) return prev;
          }
        }
        return null;
      },

      binOp(op: string, l: any, r: any): any {
        return evalBinOp(op, l, r);
      },

      time(): number { return candles[rctx.bar].time; },
      close(): number { return closeArr[rctx.bar]; },

      getHistValue(ast: any, offset: any): any {
        const off = Math.round(toNum(offset));
        if (ast && ast.k === "id") {
          currentBar = rctx.bar;
          return getVar(ast.name, off);
        }
        if (rctx.bar < off) return null;
        const saved = currentBar;
        currentBar = rctx.bar - off;
        const v = evalExpr(ast);
        currentBar = saved;
        return v;
      },

      evalTaCallCompiled(fn: string, _evaledArgs: any[], astArgs: any[], astKw: any[]): any {
        currentBar = rctx.bar;
        return evalTaCall(fn, astArgs, astKw);
      },

      _TS_DYNAMIC: {} as any,
      _taSlots: [] as any[],
      _taDynSrc: [] as (number[] | undefined)[],
      _taDynState: [] as (number | undefined)[],
      taSlotRead(slot: number, fn: string, astArgs: any[], astKw: any[]): any {
        const cached = rctx._taSlots[slot];
        if (cached !== undefined) {
          if (cached === rctx._TS_DYNAMIC) {
            currentBar = rctx.bar;
            return evalTaCall(fn, astArgs, astKw);
          }
          if (Array.isArray(cached)) {
            const v = rctx.bar < cached.length ? cached[rctx.bar] : NaN;
            return (typeof v === 'number' && isNaN(v)) ? null : v;
          }
          return cached;
        }
        currentBar = rctx.bar;
        _lastFullSeries = null;
        const result = evalTaCall(fn, astArgs, astKw);
        if (_lastFullSeries) {
          rctx._taSlots[slot] = _lastFullSeries;
        } else {
          rctx._taSlots[slot] = rctx._TS_DYNAMIC;
        }
        return result;
      },
      taDynRma(slot: number, srcVal: number, len: number): any {
        const bar = rctx.bar;
        let src = rctx._taDynSrc[slot];
        if (!src) { src = new Array(n).fill(NaN); rctx._taDynSrc[slot] = src; }
        src[bar] = srcVal;
        const alpha = 1 / len;
        const prev = rctx._taDynState[slot];
        if (prev === undefined || isNaN(prev as number)) {
          if (bar >= len - 1) {
            let sum = 0;
            let valid = true;
            for (let i = bar - len + 1; i <= bar; i++) {
              if (isNaN(src[i])) { valid = false; break; }
              sum += src[i];
            }
            if (valid) {
              const sma = sum / len;
              rctx._taDynState[slot] = sma;
              return sma;
            }
          }
          return NA;
        }
        const result = alpha * srcVal + (1 - alpha) * (prev as number);
        rctx._taDynState[slot] = result;
        return isNaN(result) ? NA : result;
      },
      taDynEma(slot: number, srcVal: number, len: number): any {
        const alpha = 2 / (len + 1);
        const prev = rctx._taDynState[slot];
        if (prev === undefined || isNaN(prev as number)) {
          if (!isNaN(srcVal)) {
            rctx._taDynState[slot] = srcVal;
            return srcVal;
          }
          return NA;
        }
        const result = alpha * srcVal + (1 - alpha) * (prev as number);
        rctx._taDynState[slot] = result;
        return isNaN(result) ? NA : result;
      },
      taDynSma(slot: number, srcVal: number, len: number): any {
        const bar = rctx.bar;
        let src = rctx._taDynSrc[slot];
        if (!src) { src = new Array(n).fill(NaN); rctx._taDynSrc[slot] = src; }
        src[bar] = srcVal;
        if (bar < len - 1) return NA;
        let sum = 0;
        const start = bar - len + 1;
        for (let i = start; i <= bar; i++) {
          if (isNaN(src[i])) return NA;
          sum += src[i];
        }
        return sum / len;
      },
      taDynWma(slot: number, srcVal: number, len: number): any {
        const bar = rctx.bar;
        let src = rctx._taDynSrc[slot];
        if (!src) { src = new Array(n).fill(NaN); rctx._taDynSrc[slot] = src; }
        src[bar] = srcVal;
        if (bar < len - 1) return NA;
        const start = bar - len + 1;
        let weightedSum = 0;
        const denom = len * (len + 1) / 2;
        for (let i = start; i <= bar; i++) {
          const v = src[i];
          if (isNaN(v)) return NA;
          weightedSum += v * (i - start + 1);
        }
        return weightedSum / denom;
      },

      taDynHighest(slot: number, srcVal: number, len: number): any {
        const bar = rctx.bar;
        let src = rctx._taDynSrc[slot];
        if (!src) { src = new Array(n).fill(NaN); rctx._taDynSrc[slot] = src; }
        src[bar] = srcVal;
        if (bar < len - 1) return NA;
        let mx = -Infinity;
        for (let i = bar - len + 1; i <= bar; i++) {
          const v = src[i];
          if (v > mx) mx = v;
        }
        return mx === -Infinity ? NA : mx;
      },
      taDynLowest(slot: number, srcVal: number, len: number): any {
        const bar = rctx.bar;
        let src = rctx._taDynSrc[slot];
        if (!src) { src = new Array(n).fill(NaN); rctx._taDynSrc[slot] = src; }
        src[bar] = srcVal;
        if (bar < len - 1) return NA;
        let mn = Infinity;
        for (let i = bar - len + 1; i <= bar; i++) {
          const v = src[i];
          if (v < mn) mn = v;
        }
        return mn === Infinity ? NA : mn;
      },
      taDynBarssince(slot: number, condVal: any): any {
        const bar = rctx.bar;
        let src = rctx._taDynSrc[slot];
        if (!src) { src = new Array(n).fill(0); rctx._taDynSrc[slot] = src; }
        src[bar] = condVal ? 1 : 0;
        for (let i = bar; i >= 0; i--) {
          if (src[i]) return bar - i;
        }
        return NA;
      },
      taDynStdev(slot: number, srcVal: number, len: number): any {
        const bar = rctx.bar;
        let src = rctx._taDynSrc[slot];
        if (!src) { src = new Array(n).fill(NaN); rctx._taDynSrc[slot] = src; }
        src[bar] = srcVal;
        if (bar < len - 1) return NA;
        let sum = 0, count = 0;
        for (let i = bar - len + 1; i <= bar; i++) {
          const v = src[i];
          if (!isNaN(v)) { sum += v; count++; }
        }
        if (count === 0) return NA;
        const mean = sum / count;
        let sq = 0;
        for (let i = bar - len + 1; i <= bar; i++) {
          const v = src[i];
          if (!isNaN(v)) { const d = v - mean; sq += d * d; }
        }
        return Math.sqrt(sq / count);
      },
      taDynLinreg(slot: number, srcVal: number, len: number): any {
        const bar = rctx.bar;
        let src = rctx._taDynSrc[slot];
        if (!src) { src = new Array(n).fill(NaN); rctx._taDynSrc[slot] = src; }
        src[bar] = srcVal;
        if (bar < len - 1) return NA;
        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, cnt = 0;
        for (let i = 0; i < len; i++) {
          const y = src[bar - len + 1 + i];
          if (isNaN(y)) return NA;
          sumX += i; sumY += y; sumXY += i * y; sumX2 += i * i; cnt++;
        }
        const slope = (cnt * sumXY - sumX * sumY) / (cnt * sumX2 - sumX * sumX);
        const intercept = (sumY - slope * sumX) / cnt;
        return intercept + slope * (cnt - 1);
      },
      taDynPercentrank(slot: number, srcVal: number, len: number): any {
        const bar = rctx.bar;
        let src = rctx._taDynSrc[slot];
        if (!src) { src = new Array(n).fill(NaN); rctx._taDynSrc[slot] = src; }
        src[bar] = srcVal;
        if (bar < len) return NA;
        let count = 0;
        for (let i = bar - len; i < bar; i++) {
          if (src[i] <= srcVal) count++;
        }
        return (count / len) * 100;
      },

      evalCallFallback(fnAST: any, evaledArgs: any[], evaledKw: any[]): any {
        currentBar = rctx.bar;
        const callExpr: Expr = {
          k: "call",
          fn: fnAST,
          args: evaledArgs.map((v: any) => ({ k: "num", v: v } as Expr)),
          kw: evaledKw.map(([k, v]: [string, any]) => [k, { k: "num", v: v } as Expr] as [string, Expr]),
        };
        return evalCall(callExpr as any);
      },

      evalInputCall(type: string, evaledArgs: any[], evaledKw: [string, any][]): any {
        const kwDefval = evaledKw.find((k: any) => k[0] === "defval");
        if (kwDefval) return kwDefval[1];
        if (evaledArgs.length > 0) return evaledArgs[0];
        switch (type) {
          case "int": return 0;
          case "float": return 0.0;
          case "bool": return false;
          case "string": return "";
          case "source": return closeArr[rctx.bar];
          default: return 0;
        }
      },

      mathAvg(vals: any[]): number {
        const nums = vals.map(toNum).filter((v: number) => !isNaN(v));
        return nums.length > 0 ? nums.reduce((a: number, b: number) => a + b, 0) / nums.length : NaN;
      },

      // Pine's math.sum(source, length): sliding sum of the last `length`
      // values of `source`. Slotted + stateful (mirrors taDynSma) so each call
      // site keeps its own rolling buffer. Warmup/NaN handling matches ind.sma
      // (so math.sum === sma * length): NA until `length` bars, NA if any value
      // in the window is NaN.
      mathSumWindow(slot: number, srcVal: number, len: number): any {
        const bar = rctx.bar;
        let src = rctx._taDynSrc[slot];
        if (!src) { src = new Array(n).fill(NaN); rctx._taDynSrc[slot] = src; }
        src[bar] = srcVal;
        const L = Math.round(len);
        if (L <= 0 || bar < L - 1) return NA;
        let sum = 0;
        for (let i = bar - L + 1; i <= bar; i++) {
          if (isNaN(src[i])) return NA;
          sum += src[i];
        }
        return sum;
      },

      strFormat(...fmtArgs: any[]): string {
        return String(fmtArgs[0] ?? "");
      },

      getMemberVar(obj: string, prop: string): any {
        currentBar = rctx.bar;
        const v = getVar(obj, 0);
        if (v !== null && v !== undefined && typeof v === 'object') return v[prop];
        return null;
      },

      setMemberVar(obj: string, prop: string, value: any) {
        currentBar = rctx.bar;
        const v = getVar(obj, 0);
        if (v !== null && v !== undefined && typeof v === 'object') v[prop] = value;
      },

      evalMember(inner: any, prop: string): any {
        if (inner && typeof inner === 'object' && inner.__ns) {
          return { __ns: inner.__ns + "." + inner.fn, fn: prop };
        }
        if (typeof inner === 'object' && inner !== null) return inner[prop];
        return null;
      },

      getMemberDynamic(obj: any, prop: string): any {
        if (typeof obj === 'object' && obj !== null) return obj[prop];
        return null;
      },

      timestamp(tsArgs: any[]): number {
        if (tsArgs.length >= 3) {
          return Date.UTC(toNum(tsArgs[0]), toNum(tsArgs[1]) - 1, toNum(tsArgs[2]),
            tsArgs.length > 3 ? toNum(tsArgs[3]) : 0,
            tsArgs.length > 4 ? toNum(tsArgs[4]) : 0,
            tsArgs.length > 5 ? toNum(tsArgs[5]) : 0);
        }
        if (tsArgs.length === 1 && typeof tsArgs[0] === "string") {
          const d = Date.parse(tsArgs[0]);
          return isNaN(d) ? Date.now() : d;
        }
        return Date.now();
      },
    };

    compiledLoop(rctx);
    usedCompiledPath = true;
  } else {
    for (currentBar = 0; currentBar < n; currentBar++) {
      opsThrottle = 0;

      if (!config.processOrdersOnClose && currentBar > 0) {
        broker.fillPendingCloses(openArr[currentBar], currentBar, candles[currentBar].time);
        broker.fillPendingEntries(openArr[currentBar], currentBar, candles[currentBar].time);
        broker.evaluateExits(currentBar, openArr[currentBar], highArr[currentBar], lowArr[currentBar], closeArr[currentBar], candles[currentBar].time);
      }
      broker.snapshotPositionSize(currentBar);

      for (const stmt of hotStmts) {
        try {
          execStmt(stmt);
        } catch (e: any) {
          if (e.message === "Global execution budget exceeded") {
            console.log(`[PineScript] Global budget exceeded at bar ${currentBar}/${n}`);
            currentBar = n;
            break;
          }
          if (e.message === "Execution budget exceeded") break;
        }
      }

      if (config.processOrdersOnClose) {
        broker.fillPendingCloses(closeArr[currentBar], currentBar, candles[currentBar].time);
        broker.fillPendingEntries(closeArr[currentBar], currentBar, candles[currentBar].time);
        broker.evaluateExits(currentBar, openArr[currentBar], highArr[currentBar], lowArr[currentBar], closeArr[currentBar], candles[currentBar].time);
      }

      equityValues[currentBar] = broker.getEquityWithUnrealized(closeArr[currentBar]);
    }
  }

  if (broker.position) {
    const lastClose = closeArr[n - 1];
    broker.closeAll(n - 1, lastClose, candles[n - 1].time, "Open Position");
  }

  const trades = broker.trades;
  let winCount = 0, grossProfit = 0, grossLoss = 0;
  for (const t of trades) {
    // Classify wins/losses by NET dollar PnL so trades that gross positive but
    // net negative after commission are correctly counted as losses (matches TV).
    if (t.pnlDollar > 0) { winCount++; grossProfit += t.pnlDollar; }
    else grossLoss -= t.pnlDollar;
  }

  const netProfitPercent = ((broker.equity - config.initialCapital) / config.initialCapital) * 100;
  let maxEquity = config.initialCapital, maxDrawdown = 0;
  for (let i = 0; i < n; i++) {
    const eq = equityValues[i] || config.initialCapital;
    if (eq > maxEquity) maxEquity = eq;
    const dd = ((maxEquity - eq) / maxEquity) * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const step = Math.max(1, Math.floor(n / 500));
  const equityCurve: { time: string; equity: number }[] = [];
  for (let i = 0; i < n; i += step) {
    equityCurve.push({ time: new Date(candles[i].time).toISOString(), equity: equityValues[i] || config.initialCapital });
  }
  if (n > 0 && (n - 1) % step !== 0) {
    equityCurve.push({ time: new Date(candles[n - 1].time).toISOString(), equity: equityValues[n - 1] || config.initialCapital });
  }

  return {
    ticker, timeframe,
    compiledPath: usedCompiledPath ? "compiled" : "interpreter",
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
