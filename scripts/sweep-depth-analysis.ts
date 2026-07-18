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
 *
 * ── Phase B extension: AAVE-Pattern Counter ──────────────────────────────────
 * Scans ai_trader_decisions for closed SL-exit trades where the stop was placed
 * inside the active-range sweep zone (contextDigest.activeRange populated) AND
 * price moved ≥ 1R in the thesis direction after the stop filled — i.e. a
 * sweep-stop that was a false breakout, not a real reversal.
 *
 * Run:  npx tsx scripts/sweep-depth-analysis.ts --aave
 * Opts: --verbose      (per-decision detail lines)
 *       --timeframe 1h (filter to one TF)
 */

import { pool, db, closePool } from "../server/db";
import { aiTraderDecisions, aiTraderBots } from "@shared/schema";
import { eq, and, isNotNull, inArray } from "drizzle-orm";
import { fetchOHLCV } from "../server/lab/datafeed";
import { marketToDatafeedTicker } from "../server/ai-trader/context-builder";
import { SWEEP_BUFFER_ATR } from "../server/ai-trader/guardrails";
import type { OHLCV } from "../server/lab/engine";

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

// ─── AAVE-Pattern Counter (Phase B extension) ─────────────────────────────────
// Run with: npx tsx scripts/sweep-depth-analysis.ts --aave

const AAVE_MODE  = process.argv.includes("--aave");
const VERBOSE    = process.argv.includes("--verbose");
const TF_FILTER  = process.argv.includes("--timeframe")
  ? process.argv[process.argv.indexOf("--timeframe") + 1]
  : null;

interface AaveDecisionFields {
  id:             string;
  botId:          string;
  action:         "long" | "short";
  entryPrice:     number;
  stopLossPrice:  number;
  takeProfitPrice: number;
  decidedAt:      Date;
  closedAt:       Date;
  exitReason:     string | null;
  realizedPnl:    number | null;
  activeRange:    { high: number; low: number } | null;
  atr14:          number | null;
}

function parseAaveDecision(row: {
  id: string; botId: string | null; entryPrice: string | null;
  exitReason: string | null; realizedPnl: string | null;
  rawDecision: unknown; clampedDecision: unknown; contextDigest: unknown;
  decidedAt: Date | null; closedAt: Date | null;
}): AaveDecisionFields | null {
  const entryPrice = parseFloat(row.entryPrice ?? "");
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  if (!row.decidedAt || !row.closedAt || !row.botId) return null;
  const dec = (row.clampedDecision ?? row.rawDecision) as Record<string, unknown> | null;
  if (!dec) return null;
  const action = dec.action as string | undefined ?? (row.rawDecision as any)?.action;
  if (action !== "long" && action !== "short") return null;
  const tp = Number(dec.takeProfitPrice ?? (row.rawDecision as any)?.takeProfitPrice);
  const sl = Number(dec.stopLossPrice   ?? (row.rawDecision as any)?.stopLossPrice);
  if (!Number.isFinite(tp) || tp <= 0 || !Number.isFinite(sl) || sl <= 0) return null;
  const digest = row.contextDigest as Record<string, unknown> | null;
  let activeRange: { high: number; low: number } | null = null;
  let atr14: number | null = null;
  if (digest) {
    const ar = digest.activeRange as Record<string, unknown> | null;
    if (ar && typeof ar.high === "number" && typeof ar.low === "number" &&
        Number.isFinite(ar.high) && Number.isFinite(ar.low)) {
      activeRange = { high: ar.high, low: ar.low };
    }
    if (typeof digest.atr14 === "number" && Number.isFinite(digest.atr14)) {
      atr14 = digest.atr14 as number;
    }
  }
  return {
    id: row.id, botId: row.botId, action: action as "long" | "short",
    entryPrice, stopLossPrice: sl, takeProfitPrice: tp,
    decidedAt: row.decidedAt, closedAt: row.closedAt,
    exitReason: row.exitReason,
    realizedPnl: row.realizedPnl !== null ? parseFloat(row.realizedPnl) : null,
    activeRange, atr14,
  };
}

function aaveComputeAtr14(candles: OHLCV[]): number | null {
  if (candles.length < 14) return null;
  let atr = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tr = i === 0 ? c.high - c.low : Math.max(
      c.high - c.low,
      Math.abs(c.high - candles[i - 1].close),
      Math.abs(c.low  - candles[i - 1].close)
    );
    if (i < 13) { atr += tr; }
    else if (i === 13) { atr = (atr + tr) / 14; }
    else { atr = (13 * atr + tr) / 14; }
  }
  return atr > 0 ? atr : null;
}

function aaveTfMs(tf: string): number {
  switch (tf) {
    case "15m": return 15 * 60_000;
    case "1h":  return 60 * 60_000;
    case "4h":  return  4 * 60 * 60_000;
    case "1d":  return 24 * 60 * 60_000;
    default:    return 60 * 60_000;
  }
}

function f2(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  return n.toFixed(2);
}

async function mainAave(): Promise<void> {
  console.log("=== AAVE-Pattern Counter  SL-PLACE Phase B baseline ===\n");
  if (TF_FILTER) console.log(`Filtering to timeframe: ${TF_FILTER}\n`);

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set."); process.exit(1);
  }

  const rawRows = await db.select({
    id:              aiTraderDecisions.id,
    botId:           aiTraderDecisions.botId,
    entryPrice:      aiTraderDecisions.entryPrice,
    exitReason:      aiTraderDecisions.exitReason,
    realizedPnl:     aiTraderDecisions.realizedPnl,
    rawDecision:     aiTraderDecisions.rawDecision,
    clampedDecision: aiTraderDecisions.clampedDecision,
    contextDigest:   aiTraderDecisions.contextDigest,
    decidedAt:       aiTraderDecisions.decidedAt,
    closedAt:        aiTraderDecisions.closedAt,
  }).from(aiTraderDecisions).where(and(
    eq(aiTraderDecisions.outcome,    "executed"),
    eq(aiTraderDecisions.exitReason, "sl"),
    isNotNull(aiTraderDecisions.closedAt),
    isNotNull(aiTraderDecisions.entryPrice),
  ));

  console.log(`SL-exit closed decisions: ${rawRows.length}`);
  if (rawRows.length === 0) {
    console.log("No SL-exit decisions found. Run AI Trader first.");
    await pool.end(); process.exit(0);
  }

  const allParsed = rawRows.map((r) => parseAaveDecision(r as any)).filter(Boolean) as AaveDecisionFields[];
  const withRange = allParsed.filter((d) => d.activeRange !== null);
  console.log(`Parseable: ${allParsed.length}  With active-range: ${withRange.length}  No-range (skipped): ${allParsed.length - withRange.length}`);

  if (withRange.length === 0) {
    console.log("\nNo decisions with active-range data yet.");
    console.log("contextDigest.activeRange is populated from SL-PLACE Phase B onward.");
    await pool.end(); process.exit(0);
  }

  const botIds = [...new Set(withRange.map((d) => d.botId))];
  const botRows = botIds.length === 0 ? [] : await db
    .select({ id: aiTraderBots.id, market: aiTraderBots.market, timeframe: aiTraderBots.timeframe })
    .from(aiTraderBots)
    .where(botIds.length === 1 ? eq(aiTraderBots.id, botIds[0]) : inArray(aiTraderBots.id, botIds));
  const botMap = new Map(botRows.map((b) => [b.id, { market: b.market, timeframe: b.timeframe }]));

  const candidates = TF_FILTER
    ? withRange.filter((d) => botMap.get(d.botId)?.timeframe === TF_FILTER)
    : withRange;

  let noBot = 0, noCandles = 0, noAtr = 0, notInZone = 0, scannedOk = 0;
  const matches: Array<{
    market: string; timeframe: string; action: string; sl: number;
    rangeLow: number; rangeHigh: number; atr14: number; sweepBuffer: number;
    sweepMult: number; sweepDepth: number; sweepDepthR: number;
    continueMove: number; continueMoveR: number;
    exitReason: string | null; realizedPnl: number | null; decisionId: string;
  }> = [];

  for (const d of candidates) {
    const bot = botMap.get(d.botId);
    if (!bot) { noBot++; continue; }

    const ticker   = marketToDatafeedTicker(bot.market);
    const startIso = new Date(d.decidedAt.getTime() - 14 * aaveTfMs(bot.timeframe)).toISOString();
    const endIso   = new Date(d.closedAt.getTime()  + 10 * aaveTfMs(bot.timeframe)).toISOString();
    let candles: OHLCV[] = [];
    try { candles = await fetchOHLCV(ticker, bot.timeframe, startIso, endIso); } catch { /* skip */ }
    if (candles.length < 14) { noCandles++; continue; }

    const tf = bot.timeframe as keyof typeof SWEEP_BUFFER_ATR;
    const sweepMult   = SWEEP_BUFFER_ATR[tf] ?? 0.75;
    const atr14       = d.atr14 && Number.isFinite(d.atr14) && d.atr14 > 0
      ? d.atr14 : aaveComputeAtr14(candles);
    if (!atr14 || atr14 <= 0) { noAtr++; continue; }

    const sweepBuffer = sweepMult * atr14;
    const oneR        = Math.abs(d.entryPrice - d.stopLossPrice);
    if (oneR <= 0) { noAtr++; continue; }

    const ar  = d.activeRange!;
    const sl  = d.stopLossPrice;
    let inZone = false, sweepDepth = 0;

    if (d.action === "long") {
      if (sl >= ar.low - sweepBuffer && sl <= ar.low) { inZone = true; sweepDepth = ar.low - sl; }
    } else {
      if (sl >= ar.high && sl <= ar.high + sweepBuffer) { inZone = true; sweepDepth = sl - ar.high; }
    }

    scannedOk++;
    if (!inZone) { notInZone++; continue; }

    let stopIdx = -1;
    for (let i = 0; i < candles.length; i++) {
      if (d.action === "long"  && candles[i].low  <= sl) { stopIdx = i; break; }
      if (d.action === "short" && candles[i].high >= sl) { stopIdx = i; break; }
    }
    if (stopIdx === -1 || stopIdx + 1 >= candles.length) { notInZone++; continue; }

    const after = candles.slice(stopIdx + 1);
    const continueMove = d.action === "long"
      ? Math.max(...after.map((c) => c.high)) - sl
      : sl - Math.min(...after.map((c) => c.low));
    const continueMoveR = continueMove / oneR;

    if (VERBOSE) {
      const zoneStr = d.action === "long"
        ? `rangeLow=${f2(ar.low)} sweepDepth=$${f2(sweepDepth)}`
        : `rangeHigh=${f2(ar.high)} sweepDepth=$${f2(sweepDepth)}`;
      console.log(`  [${continueMoveR >= 1 ? "AAVE" : "no-cont"}] ${d.id.slice(0, 8)} ${bot.market} ${bot.timeframe} ${d.action.toUpperCase()}  SL=${f2(sl)}  ${zoneStr}  cont=${f2(continueMove)}=${continueMoveR.toFixed(2)}R`);
    }

    if (continueMoveR >= 1) {
      matches.push({
        market: bot.market, timeframe: bot.timeframe, action: d.action,
        sl, rangeLow: ar.low, rangeHigh: ar.high, atr14, sweepBuffer, sweepMult,
        sweepDepth, sweepDepthR: sweepDepth / oneR,
        continueMove, continueMoveR,
        exitReason: d.exitReason, realizedPnl: d.realizedPnl, decisionId: d.id,
      });
    }
  }

  console.log(`\n─── Scan Summary ─────────────────────────────────────────────`);
  console.log(`Candidates:              ${candidates.length}`);
  console.log(`No bot info:             ${noBot}`);
  console.log(`Insufficient candles:    ${noCandles}`);
  console.log(`ATR unavailable:         ${noAtr}`);
  console.log(`Scanned OK:              ${scannedOk}`);
  console.log(`In zone, no continuation:${notInZone}`);
  console.log(`AAVE patterns (≥1R cont):${matches.length}`);

  const sweepTotal = matches.length + notInZone;
  if (scannedOk > 0) {
    const sweepPct = sweepTotal / scannedOk;
    const aavePct  = sweepTotal > 0 ? matches.length / sweepTotal : 0;
    console.log(`\nOf ${scannedOk} scanned SL decisions:`);
    console.log(`  ${sweepTotal} (${(sweepPct * 100).toFixed(1)}%) had SL in sweep zone`);
    if (sweepTotal > 0) {
      console.log(`  of those, ${matches.length} (${(aavePct * 100).toFixed(1)}%) had ≥1R continuation → AAVE pattern`);
      console.log(`\nPhase B baseline: aavePct = ${(aavePct * 100).toFixed(1)}%  (n=${sweepTotal})`);
    }
  }

  if (matches.length > 0) {
    const byKey = new Map<string, number>();
    for (const m of matches) byKey.set(`${m.market}/${m.timeframe}`, (byKey.get(`${m.market}/${m.timeframe}`) ?? 0) + 1);
    console.log(`\n─── By Market/TF ─────────────────────────────────────────────`);
    for (const [k, n] of [...byKey.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
    const avgSweepR = matches.reduce((s, m) => s + m.sweepDepthR, 0) / matches.length;
    const avgContR  = matches.reduce((s, m) => s + m.continueMoveR, 0) / matches.length;
    console.log(`\n─── Aggregate ────────────────────────────────────────────────`);
    console.log(`Avg sweep depth: ${avgSweepR.toFixed(3)}R  Avg post-stop cont: ${avgContR.toFixed(2)}R`);
    console.log(`Total realized PnL: $${f2(matches.reduce((s, m) => s + (m.realizedPnl ?? 0), 0))}`);
  } else {
    console.log("\nNo AAVE patterns found. Re-run after more SL-exit data accumulates.");
  }

  await closePool();
}

// ─── Entry point ──────────────────────────────────────────────────────────────

if (AAVE_MODE) {
  mainAave().catch((e) => { console.error(e); process.exit(1); });
} else {
  main().catch((e) => { console.error(e); process.exit(1); });
}
