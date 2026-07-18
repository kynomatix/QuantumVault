#!/usr/bin/env tsx
/**
 * Sweep-Depth Analyzer — SL-PLACE Phase 0 deliverable.
 *
 * Measures, per timeframe (15m / 1h / 4h), how far price wicks BEYOND
 * an N-bar rolling range extreme before reversing at least 1×ATR back
 * inside the range. Outputs p50 / p75 / p90 in ATR units per TF across
 * major markets available in lab_candle_cache.
 *
 * These percentiles become the empirical sweep-buffer constants for Phase B.
 * A p90 buffer dodges 90 % of sweeps but costs RR on every trade — pick the
 * percentile consciously; p75 is a practical starting point.
 *
 * Run:  npx tsx scripts/sweep-depth-analysis.ts
 * Opts: --N 50   (rolling range lookback, default 50)
 *       --M 20   (reversal check window in bars, default 20)
 */

import { pool } from "../server/db";

const N_DEFAULT = 50;
const M_DEFAULT = 20;

const args = process.argv.slice(2);
const N = parseInt(args[args.indexOf("--N") + 1] ?? "") || N_DEFAULT;
const M = parseInt(args[args.indexOf("--M") + 1] ?? "") || M_DEFAULT;

interface Candle { time: number; open: number; high: number; low: number; close: number }

async function fetchCandles(symbol: string, timeframe: string, limit?: number): Promise<Candle[]> {
  const q = limit
    ? `SELECT time, open, high, low, close FROM lab_candle_cache WHERE symbol=$1 AND timeframe=$2 ORDER BY time DESC LIMIT $3`
    : `SELECT time, open, high, low, close FROM lab_candle_cache WHERE symbol=$1 AND timeframe=$2 ORDER BY time ASC`;
  const params = limit ? [symbol, timeframe, limit] : [symbol, timeframe];
  const { rows } = await pool.query(q, params);
  const candles = rows.map((r: Record<string, unknown>) => ({
    time: Number(r.time), open: Number(r.open), high: Number(r.high),
    low: Number(r.low), close: Number(r.close),
  }));
  return limit ? candles.reverse() : candles;
}

function computeATR14(candles: Candle[]): number[] {
  const atrs = new Array(candles.length).fill(0);
  if (candles.length < 14) return atrs;
  const trs = [candles[0].high - candles[0].low];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    ));
  }
  let atr = trs.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
  atrs[13] = atr;
  for (let i = 14; i < candles.length; i++) {
    atr = (atr * 13 + trs[i]) / 14;
    atrs[i] = atr;
  }
  return atrs;
}

function percentile(arr: number[], p: number): number {
  if (!arr.length) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function analyzeSweeps(candles: Candle[], n: number, m: number) {
  const atrs = computeATR14(candles);
  const depths: number[] = [];

  for (let i = n; i < candles.length - m; i++) {
    const atr = atrs[i];
    if (atr <= 0) continue;

    let rollLow = Infinity, rollHigh = -Infinity;
    for (let j = i - n; j < i; j++) {
      if (candles[j].low < rollLow) rollLow = candles[j].low;
      if (candles[j].high > rollHigh) rollHigh = candles[j].high;
    }

    if (candles[i].low < rollLow) {
      const depth = (rollLow - candles[i].low) / atr;
      for (let j = i + 1; j <= i + m && j < candles.length; j++) {
        if (candles[j].close >= rollLow + atr) { depths.push(depth); break; }
      }
    }

    if (candles[i].high > rollHigh) {
      const depth = (candles[i].high - rollHigh) / atr;
      for (let j = i + 1; j <= i + m && j < candles.length; j++) {
        if (candles[j].close <= rollHigh - atr) { depths.push(depth); break; }
      }
    }
  }

  return {
    n: depths.length,
    p50: percentile(depths, 0.50),
    p75: percentile(depths, 0.75),
    p90: percentile(depths, 0.90),
  };
}

const COMBOS: [string, string, number | undefined][] = [
  // 15m — use shorter recent-data symbols (full dataset)
  ["SOL/USDT",    "15m", undefined],
  ["BTC/USDT",    "15m", undefined],
  ["ETH/USDT",    "15m", undefined],
  ["ARB/USDT",    "15m", undefined],
  ["AAVE/USDT",   "15m", undefined],
  // 1h — cap large datasets at 5 000 bars (most recent, still representative)
  ["SOL/USDT:USDT",  "1h", 5000],
  ["BTC/USDT:USDT",  "1h", 5000],
  ["ETH/USDT:USDT",  "1h", 5000],
  ["ARB/USDT:USDT",  "1h", 5000],
  ["AAVE/USDT",      "1h", undefined],
  // 4h — full dataset, manageable size
  ["SOL/USDT:USDT",  "4h", undefined],
  ["BTC/USDT:USDT",  "4h", undefined],
  ["ETH/USDT:USDT",  "4h", undefined],
  ["ARB/USDT:USDT",  "4h", undefined],
  ["AAVE/USDT",      "4h", undefined],
];

async function main() {
  console.log(`\nSweep-Depth Analyzer  N=${N} bars rolling range  M=${M} bars reversal window\n`);
  console.log(
    "Symbol".padEnd(20) + "TF".padEnd(6) + "Bars".padEnd(8) + "Sweeps".padEnd(9) +
    "p50×ATR".padEnd(10) + "p75×ATR".padEnd(10) + "p90×ATR"
  );
  console.log("-".repeat(70));

  const byTf: Record<string, { p50s: number[]; p75s: number[]; p90s: number[] }> = {
    "15m": { p50s: [], p75s: [], p90s: [] },
    "1h":  { p50s: [], p75s: [], p90s: [] },
    "4h":  { p50s: [], p75s: [], p90s: [] },
  };

  for (const [symbol, tf, limit] of COMBOS) {
    const candles = await fetchCandles(symbol, tf, limit);
    if (candles.length < N + M + 14) {
      console.log(`${symbol.padEnd(20)}${tf.padEnd(6)}${"—".padEnd(8)}insufficient data`);
      continue;
    }
    const r = analyzeSweeps(candles, N, M);
    if (r.n > 0) {
      byTf[tf].p50s.push(r.p50);
      byTf[tf].p75s.push(r.p75);
      byTf[tf].p90s.push(r.p90);
    }
    const fmt = (v: number) => isNaN(v) ? "  n/a" : v.toFixed(3).padStart(7);
    console.log(
      symbol.padEnd(20) + tf.padEnd(6) + String(candles.length).padEnd(8) + String(r.n).padEnd(9) +
      (fmt(r.p50) + "×").padEnd(10) + (fmt(r.p75) + "×").padEnd(10) + fmt(r.p90) + "×"
    );
  }

  console.log("-".repeat(70));
  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN;
  const fmt = (v: number) => isNaN(v) ? "  n/a" : v.toFixed(3).padStart(7);
  for (const tf of ["15m", "1h", "4h"]) {
    const g = byTf[tf];
    console.log(
      `${"AGGREGATE".padEnd(20)}${tf.padEnd(6)}${"".padEnd(8)}${"".padEnd(9)}` +
      (fmt(avg(g.p50s)) + "×").padEnd(10) + (fmt(avg(g.p75s)) + "×").padEnd(10) + fmt(avg(g.p90s)) + "×"
    );
  }
  console.log();

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
