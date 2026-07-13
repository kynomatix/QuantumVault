#!/usr/bin/env tsx
/**
 * ZEC-Pattern Analysis — Brick 4, Phase 4A diagnostic.
 *
 * "ZEC" = Zero-Edge Close: an executed AI-Trader trade whose candle path came
 * within 0.5% of its take-profit level (price nearly reached TP) but then
 * reversed at least 1R adversely against the position before closing.
 *
 * Detection per closed executed decision (exit_reason != 'tp'):
 *   LONG:  first candle where high >= takeProfitPrice × 0.995 ("near-TP bar").
 *          If found, ZEC iff (nearTPBar.high − min(subsequent lows)) ≥ 1R.
 *   SHORT: first candle where low <= takeProfitPrice × 1.005 ("near-TP bar").
 *          If found, ZEC iff (max(subsequent highs) − nearTPBar.low) ≥ 1R.
 *   1R = |entryPrice − stopLossPrice|
 *
 * Read-only. Never writes to the DB.
 *
 * Usage:
 *   tsx scripts/zec-pattern-analysis.ts
 *   tsx scripts/zec-pattern-analysis.ts --verbose
 *
 * Note: for trades where the candle cache lacks data the decision is silently
 * skipped and counted in the "no-candle-data" bucket. Run QuantumLab (which
 * populates the cache) for the relevant markets/timeframes first to maximise
 * coverage. Candles that are NOT cached will be fetched live from OKX, so the
 * script may be slow when running against many historical trades.
 */
import { db } from "../server/db";
import { aiTraderDecisions, aiTraderBots } from "@shared/schema";
import { eq, and, isNotNull } from "drizzle-orm";
import { fetchOHLCV } from "../server/lab/datafeed";
import { marketToDatafeedTicker } from "../server/ai-trader/context-builder";
import type { OHLCV } from "../server/lab/engine";

const VERBOSE = process.argv.includes("--verbose");

// ─── Types ────────────────────────────────────────────────────────────────────

interface DecisionFields {
  id: string;
  botId: string | null;
  entryPrice: number;
  exitReason: string | null;
  realizedPnl: number | null;
  action: string;
  takeProfitPrice: number;
  stopLossPrice: number;
  decidedAt: Date;
  closedAt: Date;
}

interface ZecMatch {
  decisionId: string;
  botId: string;
  market: string;
  timeframe: string;
  action: string;
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  oneR: number;
  nearTPPrice: number;       // the near-TP bar's high (long) or low (short)
  adverseSwing: number;      // how far price reversed from the near-TP bar
  adverseSwingR: number;     // adverseSwing / 1R
  exitReason: string | null;
  realizedPnl: number | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractDecisionFields(row: {
  id: string;
  botId: string | null;
  entryPrice: string | null;
  exitReason: string | null;
  realizedPnl: string | null;
  rawDecision: unknown;
  clampedDecision: unknown;
  decidedAt: Date | null;
  closedAt: Date | null;
}): DecisionFields | null {
  const entryPrice = parseFloat(row.entryPrice ?? "");
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  if (!row.decidedAt || !row.closedAt) return null;

  // Prefer clamped_decision (post-guardrail) for TP/SL; fall back to raw_decision.
  // Guardrails do not modify TP/SL prices, so both should agree, but clamped is
  // the canonical execution reference.
  const dec = (row.clampedDecision ?? row.rawDecision) as Record<string, unknown> | null;
  if (!dec) return null;

  const raw = row.rawDecision as Record<string, unknown> | null;

  const action = (dec.action ?? raw?.action) as string | undefined;
  if (action !== "long" && action !== "short") return null;

  const tp = Number(dec.takeProfitPrice ?? raw?.takeProfitPrice);
  const sl = Number(dec.stopLossPrice ?? raw?.stopLossPrice);
  if (!Number.isFinite(tp) || tp <= 0) return null;
  if (!Number.isFinite(sl) || sl <= 0) return null;

  const oneR = Math.abs(entryPrice - sl);
  if (oneR <= 0) return null;

  return {
    id: row.id,
    botId: row.botId,
    entryPrice,
    exitReason: row.exitReason,
    realizedPnl: row.realizedPnl !== null ? parseFloat(row.realizedPnl) : null,
    action,
    takeProfitPrice: tp,
    stopLossPrice: sl,
    decidedAt: row.decidedAt,
    closedAt: row.closedAt,
  };
}

interface ZecResult {
  isZec: boolean;
  nearTPPrice?: number;
  adverseSwing?: number;
}

function detectZec(
  candles: OHLCV[],
  action: string,
  takeProfitPrice: number,
  oneR: number
): ZecResult {
  const NEAR_THRESHOLD = 0.005; // 0.5%

  if (action === "long") {
    // Near-TP: first candle where high came within 0.5% of TP from below
    const nearTPFloor = takeProfitPrice * (1 - NEAR_THRESHOLD);
    const nearTPIdx = candles.findIndex((c) => c.high >= nearTPFloor);
    if (nearTPIdx === -1) return { isZec: false };

    const nearTPHigh = candles[nearTPIdx].high;
    const barsAfter = candles.slice(nearTPIdx + 1);
    if (barsAfter.length === 0) return { isZec: false };

    // Adverse move: from the near-TP bar's high, how far did price fall?
    const minLow = Math.min(...barsAfter.map((c) => c.low));
    const adverseSwing = nearTPHigh - minLow;
    return { isZec: adverseSwing >= oneR, nearTPPrice: nearTPHigh, adverseSwing };
  }

  if (action === "short") {
    // Near-TP: first candle where low came within 0.5% of TP from above
    const nearTPCeiling = takeProfitPrice * (1 + NEAR_THRESHOLD);
    const nearTPIdx = candles.findIndex((c) => c.low <= nearTPCeiling);
    if (nearTPIdx === -1) return { isZec: false };

    const nearTPLow = candles[nearTPIdx].low;
    const barsAfter = candles.slice(nearTPIdx + 1);
    if (barsAfter.length === 0) return { isZec: false };

    const maxHigh = Math.max(...barsAfter.map((c) => c.high));
    const adverseSwing = maxHigh - nearTPLow;
    return { isZec: adverseSwing >= oneR, nearTPPrice: nearTPLow, adverseSwing };
  }

  return { isZec: false };
}

function fmt2(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  return n.toFixed(2);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== ZEC-Pattern Analysis ===\n");

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set — cannot connect to DB.");
    process.exit(1);
  }

  // ── 1. Fetch closed executed decisions ──────────────────────────────────────
  const rawDecisions = await db
    .select({
      id:              aiTraderDecisions.id,
      botId:           aiTraderDecisions.botId,
      entryPrice:      aiTraderDecisions.entryPrice,
      exitReason:      aiTraderDecisions.exitReason,
      realizedPnl:     aiTraderDecisions.realizedPnl,
      rawDecision:     aiTraderDecisions.rawDecision,
      clampedDecision: aiTraderDecisions.clampedDecision,
      decidedAt:       aiTraderDecisions.decidedAt,
      closedAt:        aiTraderDecisions.closedAt,
    })
    .from(aiTraderDecisions)
    .where(
      and(
        eq(aiTraderDecisions.outcome, "executed"),
        isNotNull(aiTraderDecisions.closedAt),
        isNotNull(aiTraderDecisions.entryPrice)
      )
    );

  // Filter out TP hits server-side: if the TP was filled there's no ZEC reversal
  const candidates = rawDecisions.filter((r) => r.exitReason !== "tp");
  console.log(`Scanned:              ${rawDecisions.length} closed executed decisions`);
  console.log(`TP-filled (excluded): ${rawDecisions.length - candidates.length}`);
  console.log(`Candidates:           ${candidates.length}\n`);

  if (candidates.length === 0) {
    console.log("No non-TP-filled decisions found. Nothing to analyse.");
    process.exit(0);
  }

  // ── 2. Cache bots by ID to avoid redundant queries ──────────────────────────
  const botIds = [...new Set(candidates.map((r) => r.botId).filter(Boolean))] as string[];
  const botRows = await db
    .select({ id: aiTraderBots.id, market: aiTraderBots.market, timeframe: aiTraderBots.timeframe })
    .from(aiTraderBots)
    .where(
      botIds.length === 1
        ? eq(aiTraderBots.id, botIds[0])
        : (aiTraderBots.id as any).in(botIds)   // drizzle inArray workaround for dynamic list
    );

  // Fallback: if inArray workaround is unreliable, fetch one by one
  const botMap = new Map<string, { market: string; timeframe: string }>();
  for (const bot of botRows) {
    botMap.set(bot.id, { market: bot.market, timeframe: bot.timeframe });
  }
  // If some bots weren't returned, fetch individually
  for (const id of botIds) {
    if (!botMap.has(id)) {
      const [bot] = await db
        .select({ id: aiTraderBots.id, market: aiTraderBots.market, timeframe: aiTraderBots.timeframe })
        .from(aiTraderBots)
        .where(eq(aiTraderBots.id, id));
      if (bot) botMap.set(bot.id, { market: bot.market, timeframe: bot.timeframe });
    }
  }

  // ── 3. Analyse each candidate ────────────────────────────────────────────────
  const matches: ZecMatch[] = [];
  let noFields    = 0;
  let noBotInfo   = 0;
  let noCandles   = 0;
  let scannedOk   = 0;

  for (const row of candidates) {
    const fields = extractDecisionFields(row as any);
    if (!fields) { noFields++; continue; }
    if (!fields.botId) { noFields++; continue; }

    const bot = botMap.get(fields.botId);
    if (!bot) { noBotInfo++; continue; }

    const ticker    = marketToDatafeedTicker(bot.market);
    const startIso  = fields.decidedAt.toISOString();
    // Extend the end window slightly so we capture the closing bar
    const endIso    = new Date(fields.closedAt.getTime() + 60_000).toISOString();

    let candles: OHLCV[] = [];
    try {
      candles = await fetchOHLCV(ticker, bot.timeframe, startIso, endIso);
    } catch {
      // fetchOHLCV throws on network/config errors; treat as no-data
    }

    if (candles.length === 0) {
      noCandles++;
      if (VERBOSE) {
        console.log(
          `  [SKIP no-candles] ${fields.id.slice(0, 8)} ${bot.market} ` +
          `${startIso.slice(0, 16)} → ${endIso.slice(0, 16)}`
        );
      }
      continue;
    }

    scannedOk++;
    const oneR = Math.abs(fields.entryPrice - fields.stopLossPrice);
    const zec  = detectZec(candles, fields.action, fields.takeProfitPrice, oneR);

    if (zec.isZec) {
      matches.push({
        decisionId:      fields.id,
        botId:           fields.botId,
        market:          bot.market,
        timeframe:       bot.timeframe,
        action:          fields.action,
        entryPrice:      fields.entryPrice,
        stopLossPrice:   fields.stopLossPrice,
        takeProfitPrice: fields.takeProfitPrice,
        oneR,
        nearTPPrice:     zec.nearTPPrice!,
        adverseSwing:    zec.adverseSwing!,
        adverseSwingR:   zec.adverseSwing! / oneR,
        exitReason:      fields.exitReason,
        realizedPnl:     fields.realizedPnl,
      });
    } else if (VERBOSE) {
      console.log(
        `  [no-zec] ${fields.id.slice(0, 8)} ${bot.market} ${fields.action} ` +
        `entry=${fmt2(fields.entryPrice)} tp=${fmt2(fields.takeProfitPrice)} ` +
        `candles=${candles.length}`
      );
    }
  }

  // ── 4. Report ─────────────────────────────────────────────────────────────────
  console.log(`\n─── Scan Summary ───────────────────────────────────────────`);
  console.log(`Candidates with parseable fields: ${candidates.length - noFields - noBotInfo}`);
  console.log(`Skipped — missing TP/SL/entry fields: ${noFields}`);
  console.log(`Skipped — bot not found:              ${noBotInfo}`);
  console.log(`Skipped — no candle data available:   ${noCandles}`);
  console.log(`Successfully scanned:                 ${scannedOk}`);
  console.log(`ZEC patterns detected:                ${matches.length}`);

  if (matches.length === 0) {
    console.log("\nNo ZEC patterns found in the scanned decisions.");
    process.exit(0);
  }

  // Aggregate stats
  const affectedBots    = new Set(matches.map((m) => m.botId));
  const affectedMarkets = new Set(matches.map((m) => m.market));
  const totalPnl        = matches.reduce((s, m) => s + (m.realizedPnl ?? 0), 0);
  const avgAdverse      = matches.reduce((s, m) => s + m.adverseSwingR, 0) / matches.length;

  console.log(`\n─── ZEC Pattern Results ─────────────────────────────────────`);
  console.log(`Affected bots:    ${affectedBots.size}  (${[...affectedBots].map((id) => id.slice(0, 8)).join(", ")})`);
  console.log(`Affected markets: ${[...affectedMarkets].join(", ")}`);
  console.log(`Total realized PnL of ZEC trades: $${fmt2(totalPnl)}`);
  console.log(`Average adverse swing:            ${avgAdverse.toFixed(2)}R`);

  // ── 5. Per-match detail ───────────────────────────────────────────────────────
  console.log(`\n─── ZEC Trade Detail ────────────────────────────────────────`);
  for (let i = 0; i < matches.length; i++) {
    const m    = matches[i];
    const pctOfTp = ((m.nearTPPrice / m.takeProfitPrice - 1) * 100 * (m.action === "long" ? 1 : -1));
    const distFromEntry = m.action === "long"
      ? ((m.nearTPPrice - m.entryPrice) / m.entryPrice * 100).toFixed(2) + "% above entry"
      : ((m.entryPrice - m.nearTPPrice) / m.entryPrice * 100).toFixed(2) + "% below entry";

    console.log(
      `\n[${i + 1}] id=${m.decisionId.slice(0, 8)} bot=${m.botId.slice(0, 8)}` +
      `\n    ${m.market} ${m.timeframe} ${m.action.toUpperCase()}` +
      `\n    entry=$${fmt2(m.entryPrice)}  SL=$${fmt2(m.stopLossPrice)}  TP=$${fmt2(m.takeProfitPrice)}` +
      `\n    1R=$${fmt2(m.oneR)}` +
      `\n    near-TP: $${fmt2(m.nearTPPrice)}  (${Math.abs(pctOfTp).toFixed(3)}% from TP, ${distFromEntry})` +
      `\n    adverse reversal: $${fmt2(m.adverseSwing)} = ${m.adverseSwingR.toFixed(2)}R` +
      `\n    exit_reason=${m.exitReason ?? "null"}  realized_pnl=$${fmt2(m.realizedPnl)}`
    );
  }

  console.log(`\n─────────────────────────────────────────────────────────────`);
  console.log(`Done.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
