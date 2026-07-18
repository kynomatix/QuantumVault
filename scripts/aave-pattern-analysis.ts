#!/usr/bin/env tsx
/**
 * AAVE-Pattern Analysis — SL-PLACE Phase B diagnostic.
 *
 * "AAVE pattern" = a stopped AI-Trader trade where the stop candle swept the
 * active-range extreme by ≤ SWEEP_BUFFER_ATR × ATR(14) AND price then
 * traveled ≥ 1R in the original thesis direction after the stop filled.
 *
 * In other words: the SL was placed inside the routine sweep zone, got tagged
 * by a wick, and then the move continued exactly as anticipated — the loss was
 * caused by SL placement, not thesis failure.
 *
 * Detection per closed executed SL-exit decision:
 *   LONG: the stop candle's LOW ≤ stopLossPrice (tagged), AND that candle's
 *         low reached activeRangeLow ± SWEEP_BUFFER_ATR×ATR14, AND
 *         max(subsequent highs) − stopLossPrice ≥ 1R.
 *   SHORT: the stop candle's HIGH ≥ stopLossPrice (tagged), AND that candle's
 *          high reached activeRangeHigh ± SWEEP_BUFFER_ATR×ATR14, AND
 *          stopLossPrice − min(subsequent lows) ≥ 1R.
 *
 * "activeRange" is read from the contextDigest stored with each decision.
 * ATR(14) is computed from indicator candles surrounding the entry bar.
 *
 * Approach for sweep-zone test:
 *   LONG: stop was within sweepBuffer of rangeLow
 *         (activeRangeLow - sweepBuffer ≤ stopLossPrice ≤ activeRangeLow)
 *   SHORT: stop was within sweepBuffer of rangeHigh
 *          (activeRangeHigh ≤ stopLossPrice ≤ activeRangeHigh + sweepBuffer)
 *
 * Candle requirement: the candle window from decidedAt to closedAt + 10 bars,
 * fetched via the datafeed. If no candles, the decision is silently skipped.
 *
 * Read-only. Never writes to the DB.
 *
 * Usage:
 *   tsx scripts/aave-pattern-analysis.ts
 *   tsx scripts/aave-pattern-analysis.ts --verbose
 *   tsx scripts/aave-pattern-analysis.ts --timeframe 1h
 */
import { db } from "../server/db";
import { aiTraderDecisions, aiTraderBots } from "@shared/schema";
import { eq, and, isNotNull, inArray } from "drizzle-orm";
import { fetchOHLCV } from "../server/lab/datafeed";
import { marketToDatafeedTicker } from "../server/ai-trader/context-builder";
import { SWEEP_BUFFER_ATR } from "../server/ai-trader/guardrails";
import type { OHLCV } from "../server/lab/engine";

const VERBOSE       = process.argv.includes("--verbose");
const TF_FILTER     = process.argv.includes("--timeframe")
  ? process.argv[process.argv.indexOf("--timeframe") + 1]
  : null;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ActiveRangeSnapshot {
  high: number;
  low:  number;
  atr14?: number;
}

interface DecisionFields {
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
  activeRange:    ActiveRangeSnapshot | null;
  atr14:          number | null;
}

interface AaveMatch {
  decisionId:      string;
  botId:           string;
  market:          string;
  timeframe:       string;
  action:          string;
  entryPrice:      number;
  stopLossPrice:   number;
  takeProfitPrice: number;
  oneR:            number;
  activeRangeHigh: number;
  activeRangeLow:  number;
  atr14:           number;
  sweepBuffer:     number;
  sweepBufferMult: number;
  sweepDepth:      number;   // how far below rangeLow (long) or above rangeHigh (short) the stop sits
  sweepDepthR:     number;   // sweepDepth / 1R
  continueMove:    number;   // how far price moved in thesis direction after stop
  continueMoveR:   number;   // continueMove / 1R
  exitReason:      string | null;
  realizedPnl:     number | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseDecisionFields(row: {
  id:              string;
  botId:           string | null;
  entryPrice:      string | null;
  exitReason:      string | null;
  realizedPnl:     string | null;
  rawDecision:     unknown;
  clampedDecision: unknown;
  contextDigest:   unknown;
  decidedAt:       Date | null;
  closedAt:        Date | null;
}): DecisionFields | null {
  const entryPrice = parseFloat(row.entryPrice ?? "");
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  if (!row.decidedAt || !row.closedAt) return null;
  if (!row.botId) return null;

  const dec = (row.clampedDecision ?? row.rawDecision) as Record<string, unknown> | null;
  if (!dec) return null;

  const action = (dec.action ?? (row.rawDecision as any)?.action) as string | undefined;
  if (action !== "long" && action !== "short") return null;

  const tp = Number(dec.takeProfitPrice ?? (row.rawDecision as any)?.takeProfitPrice);
  const sl = Number(dec.stopLossPrice   ?? (row.rawDecision as any)?.stopLossPrice);
  if (!Number.isFinite(tp) || tp <= 0) return null;
  if (!Number.isFinite(sl) || sl <= 0) return null;

  const oneR = Math.abs(entryPrice - sl);
  if (oneR <= 0) return null;

  // Extract active range + ATR14 from contextDigest
  let activeRange: ActiveRangeSnapshot | null = null;
  let atr14: number | null = null;
  const digest = row.contextDigest as Record<string, unknown> | null;
  if (digest) {
    const ar = digest.activeRange as Record<string, unknown> | null;
    if (ar && typeof ar.high === "number" && typeof ar.low === "number" &&
        Number.isFinite(ar.high) && Number.isFinite(ar.low)) {
      activeRange = { high: ar.high, low: ar.low };
    }
    if (typeof digest.atr14 === "number" && Number.isFinite(digest.atr14)) {
      atr14 = digest.atr14 as number;
    }
    // ATR might also live inside activeRange snapshot
    if (!atr14 && activeRange && typeof (ar as any)?.atr14 === "number") {
      atr14 = (ar as any).atr14;
    }
  }

  return {
    id:             row.id,
    botId:          row.botId,
    action:         action as "long" | "short",
    entryPrice,
    stopLossPrice:  sl,
    takeProfitPrice: tp,
    decidedAt:      row.decidedAt,
    closedAt:       row.closedAt,
    exitReason:     row.exitReason,
    realizedPnl:    row.realizedPnl !== null ? parseFloat(row.realizedPnl) : null,
    activeRange,
    atr14,
  };
}

/**
 * Estimate ATR(14) from a candle series (last value in the series).
 * Uses Wilder's EWM: ATR[n] = (13×ATR[n-1] + TR[n]) / 14.
 */
function computeAtr14(candles: OHLCV[]): number | null {
  if (candles.length < 14) return null;
  let atr: number | null = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tr = i === 0
      ? c.high - c.low
      : Math.max(
          c.high - c.low,
          Math.abs(c.high - candles[i - 1].close),
          Math.abs(c.low  - candles[i - 1].close)
        );
    if (i < 13) {
      atr = atr === null ? tr : atr + tr;
      if (i === 13) atr = (atr! + tr) / 14;
    } else if (i === 13) {
      atr = (atr! + tr) / 14;
    } else {
      atr = (13 * atr! + tr) / 14;
    }
  }
  return atr;
}

function fmt2(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  return n.toFixed(2);
}

function fmtPct(n: number): string {
  return (n * 100).toFixed(3) + "%";
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== AAVE-Pattern Analysis (SL-PLACE Phase B baseline) ===\n");
  if (TF_FILTER) console.log(`Filtering to timeframe: ${TF_FILTER}\n`);

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set — cannot connect to DB.");
    process.exit(1);
  }

  // ── 1. Fetch SL-exit closed executed decisions ───────────────────────────────
  const rawDecisions = await db
    .select({
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
    })
    .from(aiTraderDecisions)
    .where(
      and(
        eq(aiTraderDecisions.outcome, "executed"),
        eq(aiTraderDecisions.exitReason, "sl"),
        isNotNull(aiTraderDecisions.closedAt),
        isNotNull(aiTraderDecisions.entryPrice)
      )
    );

  console.log(`SL-exit closed decisions fetched: ${rawDecisions.length}`);

  if (rawDecisions.length === 0) {
    console.log("No SL-exit decisions found. Run AI Trader first to accumulate data.");
    process.exit(0);
  }

  // ── 2. Parse fields; filter to decisions that have active-range data ─────────
  const allParsed  = rawDecisions.map((r) => parseDecisionFields(r as any)).filter(Boolean) as DecisionFields[];
  const withRange  = allParsed.filter((d) => d.activeRange !== null);
  const noRange    = allParsed.length - withRange.length;

  console.log(`Parseable decisions:           ${allParsed.length}`);
  console.log(`With active-range snapshot:    ${withRange.length}`);
  console.log(`Without active-range (skipped): ${noRange}`);

  // ── 3. Cache bot info ────────────────────────────────────────────────────────
  const botIds = [...new Set(withRange.map((d) => d.botId))];
  const botRows = botIds.length > 0
    ? await db
        .select({ id: aiTraderBots.id, market: aiTraderBots.market, timeframe: aiTraderBots.timeframe })
        .from(aiTraderBots)
        .where(botIds.length === 1 ? eq(aiTraderBots.id, botIds[0]) : inArray(aiTraderBots.id, botIds))
    : [];

  const botMap = new Map<string, { market: string; timeframe: string }>();
  for (const bot of botRows) {
    botMap.set(bot.id, { market: bot.market, timeframe: bot.timeframe });
  }
  for (const id of botIds) {
    if (!botMap.has(id)) {
      const [bot] = await db
        .select({ id: aiTraderBots.id, market: aiTraderBots.market, timeframe: aiTraderBots.timeframe })
        .from(aiTraderBots)
        .where(eq(aiTraderBots.id, id));
      if (bot) botMap.set(bot.id, { market: bot.market, timeframe: bot.timeframe });
    }
  }

  // ── 4. Analyse each candidate ─────────────────────────────────────────────────
  const candidates = TF_FILTER
    ? withRange.filter((d) => {
        const bot = botMap.get(d.botId);
        return bot?.timeframe === TF_FILTER;
      })
    : withRange;

  const matches: AaveMatch[] = [];
  let noBot     = 0;
  let noCandles = 0;
  let noAtr     = 0;
  let notInZone = 0;
  let scannedOk = 0;

  for (const d of candidates) {
    const bot = botMap.get(d.botId);
    if (!bot) { noBot++; continue; }

    const ticker   = marketToDatafeedTicker(bot.market);
    const startIso = new Date(d.decidedAt.getTime() - 14 * tfMs(bot.timeframe)).toISOString();
    const endIso   = new Date(d.closedAt.getTime()  + 10 * tfMs(bot.timeframe)).toISOString();

    let candles: OHLCV[] = [];
    try {
      candles = await fetchOHLCV(ticker, bot.timeframe, startIso, endIso);
    } catch {
      // network/config error
    }

    if (candles.length < 14) { noCandles++; continue; }

    // Determine ATR: prefer contextDigest value, fall back to local computation
    const tf = bot.timeframe as keyof typeof SWEEP_BUFFER_ATR;
    const sweepMult = SWEEP_BUFFER_ATR[tf] ?? 0.75;

    let atr14 = d.atr14;
    if (!atr14 || !Number.isFinite(atr14)) {
      atr14 = computeAtr14(candles);
    }
    if (!atr14 || !Number.isFinite(atr14) || atr14 <= 0) { noAtr++; continue; }

    const sweepBuffer = sweepMult * atr14;
    const oneR        = Math.abs(d.entryPrice - d.stopLossPrice);
    const ar          = d.activeRange!;

    // ── Sweep-zone membership check ───────────────────────────────────────────
    const sl  = d.stopLossPrice;
    let inSweepZone = false;
    let sweepDepth  = 0;

    if (d.action === "long") {
      // Zone: [rangeLow - sweepBuffer, rangeLow]
      if (sl >= ar.low - sweepBuffer && sl <= ar.low) {
        inSweepZone = true;
        sweepDepth  = ar.low - sl; // how far BELOW rangeLow the stop sits
      }
    } else {
      // Zone: [rangeHigh, rangeHigh + sweepBuffer]
      if (sl >= ar.high && sl <= ar.high + sweepBuffer) {
        inSweepZone = true;
        sweepDepth  = sl - ar.high; // how far ABOVE rangeHigh the stop sits
      }
    }

    scannedOk++;
    if (!inSweepZone) { notInZone++; continue; }

    // ── Find stop candle + measure post-stop continuation ────────────────────
    // Split candles at the stop event (first candle that would have triggered SL)
    let stopIdx = -1;
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (d.action === "long"  && c.low  <= sl) { stopIdx = i; break; }
      if (d.action === "short" && c.high >= sl) { stopIdx = i; break; }
    }
    if (stopIdx === -1) {
      // No stop-trigger candle found in the window; skip
      notInZone++;
      continue;
    }

    const barsAfterStop = candles.slice(stopIdx + 1);
    if (barsAfterStop.length === 0) { notInZone++; continue; }

    // Post-stop continuation in thesis direction
    let continueMove: number;
    if (d.action === "long") {
      // Thesis was up; did price rise above SL after the sweep?
      const maxHigh = Math.max(...barsAfterStop.map((c) => c.high));
      continueMove  = maxHigh - sl;
    } else {
      const minLow  = Math.min(...barsAfterStop.map((c) => c.low));
      continueMove  = sl - minLow;
    }

    const continueMoveR = continueMove / oneR;

    // AAVE pattern: continuation ≥ 1R after the sweep
    if (continueMoveR >= 1) {
      matches.push({
        decisionId:      d.id,
        botId:           d.botId,
        market:          bot.market,
        timeframe:       bot.timeframe,
        action:          d.action,
        entryPrice:      d.entryPrice,
        stopLossPrice:   sl,
        takeProfitPrice: d.takeProfitPrice,
        oneR,
        activeRangeHigh: ar.high,
        activeRangeLow:  ar.low,
        atr14,
        sweepBuffer,
        sweepBufferMult: sweepMult,
        sweepDepth,
        sweepDepthR:     sweepDepth / oneR,
        continueMove,
        continueMoveR,
        exitReason:      d.exitReason,
        realizedPnl:     d.realizedPnl,
      });

      if (VERBOSE) {
        console.log(
          `  [AAVE] id=${d.id.slice(0, 8)} ${bot.market} ${bot.timeframe} ${d.action.toUpperCase()}` +
          `  SL=${fmt2(sl)} rangeLow=${fmt2(ar.low)} rangeHigh=${fmt2(ar.high)}` +
          `  sweepDepth=${fmt2(sweepDepth)} (${fmtPct(sweepDepth / d.entryPrice)} of entry)` +
          `  continueMove=${fmt2(continueMove)}=${continueMoveR.toFixed(2)}R`
        );
      }
    } else if (VERBOSE) {
      console.log(
        `  [in-zone but no-continue] id=${d.id.slice(0, 8)} ${bot.market} ${d.action.toUpperCase()}` +
        `  continue=${fmt2(continueMove)}=${continueMoveR.toFixed(2)}R  (need ≥1R)`
      );
    }
  }

  // ── 5. Report ─────────────────────────────────────────────────────────────────
  console.log(`\n─── Scan Summary ─────────────────────────────────────────────`);
  console.log(`Candidates analysed:                   ${candidates.length}`);
  console.log(`Skipped — bot not found:               ${noBot}`);
  console.log(`Skipped — insufficient candle data:    ${noCandles}`);
  console.log(`Skipped — ATR unavailable:             ${noAtr}`);
  console.log(`Successfully scanned (fields OK):      ${scannedOk}`);
  console.log(`In sweep zone but no 1R continuation:  ${notInZone}`);
  console.log(`AAVE patterns (sweep + ≥1R continue):  ${matches.length}`);

  if (candidates.length === 0) {
    console.log("\nNo decisions with active-range data available yet.");
    console.log("The contextDigest.activeRange field is populated from SL-PLACE Phase B onward.");
    process.exit(0);
  }

  const sweepZoneTotal = matches.length + notInZone;
  const sweepZonePct = scannedOk > 0 ? sweepZoneTotal / scannedOk : 0;
  const aavePct      = sweepZoneTotal > 0 ? matches.length / sweepZoneTotal : 0;

  console.log(`\nOf ${scannedOk} scanned SL decisions:`);
  console.log(`  ${sweepZoneTotal} (${fmtPct(sweepZonePct)}) had SL in the sweep zone`);
  if (sweepZoneTotal > 0) {
    console.log(`  of those, ${matches.length} (${fmtPct(aavePct)}) showed ≥1R continuation → AAVE pattern`);
  }

  if (matches.length === 0) {
    console.log("\nNo AAVE patterns found in the scanned period.");
    console.log("This is the Phase B baseline — re-run after accumulating more SL-exit data.");
    process.exit(0);
  }

  // Per-market/timeframe breakdown
  const byMarket = new Map<string, number>();
  for (const m of matches) {
    const key = `${m.market}/${m.timeframe}`;
    byMarket.set(key, (byMarket.get(key) ?? 0) + 1);
  }

  console.log(`\n─── By Market/Timeframe ──────────────────────────────────────`);
  for (const [key, count] of [...byMarket.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key}: ${count}`);
  }

  const totalPnl    = matches.reduce((s, m) => s + (m.realizedPnl ?? 0), 0);
  const avgSweepR   = matches.reduce((s, m) => s + m.sweepDepthR, 0) / matches.length;
  const avgContR    = matches.reduce((s, m) => s + m.continueMoveR, 0) / matches.length;
  const p50ContR    = [...matches].sort((a, b) => a.continueMoveR - b.continueMoveR)[Math.floor(matches.length / 2)]?.continueMoveR ?? 0;

  console.log(`\n─── Aggregate Stats ──────────────────────────────────────────`);
  console.log(`Total realized PnL of AAVE trades:   $${fmt2(totalPnl)}`);
  console.log(`Avg sweep depth (inside zone):        ${avgSweepR.toFixed(3)}R`);
  console.log(`Avg post-stop continuation:           ${avgContR.toFixed(2)}R`);
  console.log(`Median post-stop continuation:        ${p50ContR.toFixed(2)}R`);

  // ── 6. Per-match detail ───────────────────────────────────────────────────────
  console.log(`\n─── AAVE Trade Detail ────────────────────────────────────────`);
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const zonePct = m.action === "long"
      ? fmtPct((m.activeRangeLow - m.stopLossPrice) / m.atr14)
      : fmtPct((m.stopLossPrice  - m.activeRangeHigh) / m.atr14);

    console.log(
      `\n[${i + 1}] id=${m.decisionId.slice(0, 8)} bot=${m.botId.slice(0, 8)}` +
      `\n    ${m.market} ${m.timeframe} ${m.action.toUpperCase()}` +
      `\n    entry=$${fmt2(m.entryPrice)}  SL=$${fmt2(m.stopLossPrice)}  TP=$${fmt2(m.takeProfitPrice)}` +
      `\n    1R=$${fmt2(m.oneR)}` +
      `\n    activeRange: low=$${fmt2(m.activeRangeLow)}  high=$${fmt2(m.activeRangeHigh)}` +
      `\n    sweepBuffer: ${m.sweepBufferMult}×ATR($${fmt2(m.atr14)})=$${fmt2(m.sweepBuffer)}` +
      `\n    sweep depth: $${fmt2(m.sweepDepth)} (${zonePct} of ATR inside zone, ${m.sweepDepthR.toFixed(3)}R)` +
      `\n    post-stop continuation: $${fmt2(m.continueMove)} = ${m.continueMoveR.toFixed(2)}R` +
      `\n    exit_reason=${m.exitReason ?? "null"}  realized_pnl=$${fmt2(m.realizedPnl)}`
    );
  }

  console.log(`\n─────────────────────────────────────────────────────────────`);
  console.log(`Done. (Phase B baseline — record results in sl-place-phase0-findings.md §Phase B)`);
  process.exit(0);
}

/** Milliseconds per timeframe bar. */
function tfMs(tf: string): number {
  switch (tf) {
    case "15m": return 15 * 60_000;
    case "1h":  return 60 * 60_000;
    case "4h":  return  4 * 60 * 60_000;
    case "1d":  return 24 * 60 * 60_000;
    default:    return 60 * 60_000;
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
