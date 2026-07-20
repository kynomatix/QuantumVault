// Agentic Trader Plan §Part B, WO-3. Builds the LLM decision-cycle prompt for one
// AI Trader bot from verified market/adapter/history data ONLY. No user-controlled
// free text is interpolated: `bot`'s market/timeframe/mode/riskProfile fields are
// platform enums the user merely *selects*, and the only free-form strings that
// could ever flow through this module (an LLM's own past `rationale`/`invalidation`
// text) are deliberately NOT included in the history block — WO-3 §6 pins that
// block's fields to side/entry/exit/exitReason/realizedPnl/regime tag only.
import { fetchOHLCV, isNonCryptoSymbol, isCacheDegradedError } from "../lab/datafeed";
import type { OHLCV } from "../lab/engine";
import { ema, rsi, macd, atr, adx, bollingerBands, supertrend, obv } from "../lab/indicators";
import type { ProtocolAdapter } from "../protocol/adapter";
import type { AiTraderBot, AiTraderDecision } from "@shared/schema";
import { getHlParticipationSnapshot, type HlParticipationSnapshot } from "./hl-context";
import { getCotSnapshot, type CotSnapshot } from "./cot-service";
import { getSessionContext } from "./session-context";
import { detectPivots, classifyDow, type DowStructureResult } from "./dow-structure";
import { detectHTFLevels, type HtfLevel } from "./htf-levels";
import { detectWM, type WMFormation } from "./wm-detector";
import { detectActiveRange, type ActiveRange } from "./active-range";
import { SWEEP_BUFFER_ATR } from "./guardrails";

export type AiTraderTimeframe = "15m" | "1h" | "4h" | "1d";

export interface BuildMarketContextInput {
  market: string;
  timeframe: AiTraderTimeframe;
  adapter: ProtocolAdapter;
  bot: AiTraderBot;
  recentDecisions: AiTraderDecision[];
  /**
   * The server-managed agent SIGNING pubkey for this bot's venue account
   * (wallet.agentPublicKey), resolved by the caller via storage.getWallet —
   * NOT the user's connected wallet address. Required since WO-5: the old
   * WO-3 placeholder passed bot.walletAddress here, which reads the wrong
   * (empty) account on every venue.
   */
  agentPublicKey: string;
  /**
   * WO-B (scanner bots only): a single pre-computed digest line describing
   * the scanner's selection rationale. Injected verbatim into the user prompt
   * before the candle blocks and stamped into contextDigest.scannerNote.
   * Undefined for fixed-ticker bots — context-builder is unchanged for them.
   */
  scannerNote?: string;
}

export type BuildMarketContextResult =
  | { system: string; user: string; contextDigest: Record<string, unknown> }
  | { stale: true; reason: string };

// Timeframes fetchOHLCV/datafeed.ts actually serves today (its own TIMEFRAME_MS +
// SYNTHETIC_TIMEFRAMES tables, server/lab/datafeed.ts L498/L547). Duplicated here
// (module-private in datafeed.ts, not exported) rather than exporting it there —
// WO-3 is scoped to this file only.
const TIMEFRAME_MS: Record<AiTraderTimeframe | "1w", number> = {
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
  "1w": 604_800_000,
};

// WO-3 step 1: 15m→1h, 1h→4h, 4h→1d, 1d→1w "if available else 1d only". `1w` is
// NOT in datafeed.ts's TIMEFRAME_MS/SYNTHETIC_TIMEFRAMES today, so `1d` has no
// parent block — that is the documented fallback, not an omission.
const PARENT_TIMEFRAME: Record<AiTraderTimeframe, AiTraderTimeframe | "1w" | null> = {
  "15m": "1h",
  "1h": "4h",
  "4h": "1d",
  "1d": null,
};

// WO-3.1: indicator computation and CSV serialization now use two different
// windows. WO-3's original 100-bar fetch could never seed a 200-period EMA
// (the lab's ema() is SMA-seeded at period-1) and left EMA50 under-converged —
// a genuine spec bug, since amended. INDICATOR_BARS is the wider window fed to
// every indicator function; SELECTED_BARS remains the number of most-recent
// bars actually serialized into the CSV block, so prompt token size is
// unchanged from WO-3.
const INDICATOR_BARS = 400;
const SELECTED_BARS = 100;
const PARENT_BARS = 30;
// Brick 2 + Brick 4: wider parent fetch for pivot computation. The 30-bar window
// is too shallow for N=3 fractals with 4 required alternating pivots — almost every
// call would return "insufficient". PARENT_BARS=30 remains the render window written
// into the CSV block (token economy unchanged from WO-3.1). Same computation-vs-render
// split as the INDICATOR_BARS/SELECTED_BARS EMA fix. Brick 4 (HTF levels / ZEC
// pattern) reuses the parentIndicatorCandles variable produced by this fetch.
const PARENT_INDICATOR_BARS = 400;

// Platform-wide taker fee convention already duplicated in server/routes.ts
// (DEFAULT_EXCHANGE_FEE_RATE) and server/trade-retry-service.ts — no ProtocolAdapter
// method exposes a numeric fee rate today, so this mirrors that existing constant
// rather than inventing a second source of truth.
const EXCHANGE_TAKER_FEE_RATE = 0.0004;

// G6 trade-frequency day-caps (plan §5): 6/day for LTF (15m/1h), 2/day for HTF (4h/1d).
const LTF_TIMEFRAMES = new Set<AiTraderTimeframe>(["15m", "1h"]);

// AI-Trader smartLeverageCap (G1 echo), exact formula from the plan's B0 primitives
// section (docs/AGENTIC_TRADER_PLAN.md ~L513-515): ddProxy = k * ATR(14)/price
// (k≈3 swing allowance), smartLeverageCap = clamp(floor(0.5/ddProxy), 1, 5). This is
// an ECHO for the prompt only — the enforced clamp itself lives in a later WO.
const SMART_LEVERAGE_K = 3;
const SMART_LEVERAGE_HARD_CEILING = 5;

// Exchange market symbols (e.g. "BTC-PERP", "EURUSD-PERP" — validated against
// server/market-registry.ts and used for adapter.getPrice/order calls) use a
// different naming convention than the Lab/datafeed layer's ccxt-style tickers
// (e.g. "BTC/USDT", "EURUSD/USDT" — see server/lab/datafeed.ts
// symbolToOkxInstId/isNonCryptoSymbol, both of which split the ticker on "/").
// Passing the raw exchange symbol straight to fetchOHLCV silently produces an
// invalid OKX instrument ID (e.g. "BTC-PERP-USDT-SWAP" doesn't exist) and
// fetchOHLCV returns zero candles — surfaced live during WO-7's round-trip
// test, but the mismatch was latent since WO-3/WO-4 first called fetchOHLCV
// with bot.market. Strip the "-PERP" suffix (same convention already used by
// server/market-liquidity-service.ts's buildMarketFromRegistry) and append
// "/USDT" to get a ticker datafeed.ts actually understands. Only fetchOHLCV
// call sites need this — adapter.getPrice/getPosition/etc. still take the raw
// exchange symbol.
export function marketToDatafeedTicker(market: string): string {
  const base = market.replace(/-PERP$/, "");
  return `${base}/USDT`;
}

function fmtPrice(v: number): string {
  if (!Number.isFinite(v)) return "n/a";
  const abs = Math.abs(v);
  const decimals = abs >= 1 ? 2 : abs >= 0.01 ? 4 : abs >= 0.0001 ? 6 : 8;
  return v.toFixed(decimals);
}

function fmtPct1(v: number): string {
  return Number.isFinite(v) ? v.toFixed(1) : "n/a";
}

function fmtMacdComponent(v: number): string {
  return Number.isFinite(v) ? v.toFixed(4) : "n/a";
}

function fmtObv(v: number): string {
  return Number.isFinite(v) ? Math.round(v).toString() : "n/a";
}

// WO-8f formatting helpers for the Hyperliquid participation block. Deltas
// and rates keep the file's existing convention of a plain toFixed (no
// forced "+" sign — a negative already renders its own "-"), matching
// fmtPct1/fmtMacdComponent above.
function fmtPct1Signed(v: number | null): string {
  return v === null || !Number.isFinite(v) ? "n/a" : `${v.toFixed(1)}%`;
}

function fmtRatePct4(v: number): string {
  return Number.isFinite(v) ? `${(v * 100).toFixed(4)}%` : "n/a";
}

function fmtCommaNum(v: number): string {
  return Number.isFinite(v) ? Math.round(v).toLocaleString("en-US") : "n/a";
}

function fmtUsd0(v: number): string {
  return Number.isFinite(v) ? `$${Math.round(v).toLocaleString("en-US")}` : "n/a";
}

function isoMinute(timeMs: number): string {
  return new Date(timeMs).toISOString().slice(0, 16);
}

function lastTwo(values: number[]): { value: number; prev: number } {
  const n = values.length;
  return { value: n >= 1 ? values[n - 1] : NaN, prev: n >= 2 ? values[n - 2] : NaN };
}

function candlesToCsv(candles: OHLCV[]): string {
  const header = "time,open,high,low,close,volume";
  const rows = candles.map(
    (c) => `${isoMinute(c.time)},${c.open},${c.high},${c.low},${c.close},${c.volume}`
  );
  return [header, ...rows].join("\n");
}

function adxRegimeTag(adxValue: number | undefined | null): string {
  if (adxValue === undefined || adxValue === null || !Number.isFinite(adxValue)) {
    return "regime unknown (no ADX recorded)";
  }
  if (adxValue > 25) return `trending (ADX ${adxValue.toFixed(1)})`;
  if (adxValue < 20) return `ranging (ADX ${adxValue.toFixed(1)})`;
  return `transitional (ADX ${adxValue.toFixed(1)})`;
}

// COT-B: omission threshold — genuinely stale feed (>16 days old) is distinct from
// the 9-day background-refresh trigger in cot-service.ts. Also omit when the
// rolling window has < 120 weeks (state='insufficient_data').
const COT_OMISSION_THRESHOLD_MS = 16 * 24 * 60 * 60 * 1000;

/** Format the one-line BTC COT bias for injection near the funding line. */
function buildCotBiasLine(snap: CotSnapshot): string {
  const sentiment =
    snap.state === "bullish_flip" ? "accumulating" :
    snap.state === "bearish_flip" ? "distributing" :
    "neutral";
  const bias =
    snap.state === "bullish_flip" ? "long" :
    snap.state === "bearish_flip" ? "short" :
    "neutral";
  return (
    `BTC positioning (COT, weekly): commercials ${sentiment}` +
    ` — smart ${Math.round(snap.commIndex)}/100, retail/spec ${Math.round(snap.dumbIndex)}/100` +
    ` — macro bias ${bias}.`
  );
}

function decisionSide(d: AiTraderDecision): string {
  const clamped = d.clampedDecision as { action?: string } | null | undefined;
  const raw = d.rawDecision as { action?: string } | null | undefined;
  return clamped?.action ?? raw?.action ?? "unknown";
}

// ─── SL-PLACE Phase A: Active-range prompt helpers ────────────────────────────
// Kept module-private; consumed only by buildMarketContext.

/** Format an age-in-bars as a human-readable "Xh ago" / "Xm ago" string. */
function fmtBarsAgo(ageBars: number, tfMs: number): string {
  if (ageBars === 0) return "current";
  const totalMs = ageBars * tfMs;
  const hrs = totalMs / 3_600_000;
  if (hrs < 1) return `${Math.round(totalMs / 60_000)}m ago`;
  return `${Number.isInteger(hrs) ? hrs : hrs.toFixed(1)}h ago`;
}

/** Format a span of bars as "Xh" / "Xm". */
function fmtSpanBars(bars: number, tfMs: number): string {
  const hrs = (bars * tfMs) / 3_600_000;
  if (hrs < 1) return `${Math.round(hrs * 60)}m`;
  return `${Number.isInteger(hrs) ? hrs : hrs.toFixed(0)}h`;
}

/**
 * Render the single-line active-range injection.
 * Example: "Active range (48 bars, 12h old): high 91.78 (13h ago) · low 89.86 (2h ago) · price at 62% of range."
 */
function buildActiveRangeLine(r: ActiveRange, tfMs: number, atr14: number, timeframe: AiTraderTimeframe): string {
  const spanLabel = fmtSpanBars(r.bars, tfMs);
  const highLabel = fmtBarsAgo(r.ageOfHigh, tfMs);
  const lowLabel  = fmtBarsAgo(r.ageOfLow,  tfMs);
  const pct = Math.round(r.pctInRange * 100);

  // SL-PLACE Phase B: render quantified safe zones so the model sees concrete
  // minimum-viable SL placements, not just a qualitative guideline.
  let safeZoneSuffix = "";
  if (Number.isFinite(atr14) && atr14 > 0) {
    const mult      = SWEEP_BUFFER_ATR[timeframe] ?? 0.75;
    const buffer    = mult * atr14;
    const shortSafe = r.high + buffer;
    const longSafe  = r.low  - buffer;
    safeZoneSuffix = (
      ` Safe zones (${mult}×ATR=${fmtPrice(buffer)}):` +
      ` short stops ≥ ${fmtPrice(shortSafe)} · long stops ≤ ${fmtPrice(longSafe)}.`
    );
  }

  return (
    `Active range (${r.bars} bars, ${spanLabel} old): ` +
    `high ${fmtPrice(r.high)} (${highLabel}) · ` +
    `low ${fmtPrice(r.low)} (${lowLabel}) · ` +
    `price at ${pct}% of range.${safeZoneSuffix}`
  );
}

// ─── Brick 2, Phase 2B: Dow-structure prompt helpers ─────────────────────────
// Kept module-private; consumed only by buildMarketContext.

/**
 * Render the measurement substring for one DowStructureResult.
 * HH/HL / LH/LL → "HH/HL (last swing high X > Y; last swing low A > B)"
 * mixed / insufficient → classification word only.
 */
function dowMeasurements(r: DowStructureResult): string {
  const { classification: cls, pivots } = r;
  if (cls !== "HH/HL" && cls !== "LH/LL") return cls;
  const highs = pivots.filter((p) => p.type === "high");
  const lows  = pivots.filter((p) => p.type === "low");
  if (highs.length !== 2 || lows.length !== 2) return cls;
  // highs[0]/lows[0] = earlier pivot; highs[1]/lows[1] = more recent.
  const op = cls === "HH/HL" ? ">" : "<";
  return (
    `${cls} (last swing high ${fmtPrice(highs[1].price)} ${op} ${fmtPrice(highs[0].price)};` +
    ` last swing low ${fmtPrice(lows[1].price)} ${op} ${fmtPrice(lows[0].price)})`
  );
}

/**
 * Build the full "Structure (Dow): ..." prompt line and derive the alignment value.
 *
 * Alignment truth table:
 *   true  — both sides are directional (HH/HL or LH/LL) AND they match
 *   false — both sides are directional AND they are opposite
 *   null  — either side is mixed/insufficient, OR no parent timeframe
 */
function buildDowLine(
  tf: string,
  sel: DowStructureResult,
  parentTf: string | null,
  par: DowStructureResult | null
): { line: string; aligned: boolean | null } {
  const selStr = dowMeasurements(sel);
  if (!parentTf || !par) {
    return { line: `Structure (Dow): ${tf} ${selStr}`, aligned: null };
  }
  const parStr = dowMeasurements(par);
  const sCls = sel.classification;
  const pCls = par.classification;
  const selDir = sCls === "HH/HL" || sCls === "LH/LL";
  const parDir = pCls === "HH/HL" || pCls === "LH/LL";
  let suffix = "";
  let aligned: boolean | null = null;
  if (selDir && parDir) {
    aligned = sCls === pCls;
    suffix = aligned
      ? " — aligned."
      : ` — MISALIGNED (${tf} counter to ${parentTf}).`;
  }
  return {
    line: `Structure (Dow): ${tf} ${selStr} · ${parentTf} ${parStr}${suffix}`,
    aligned,
  };
}

// ─── Brick 4, Phase 4B: HTF-levels prompt helpers ────────────────────────────

/**
 * Convert a closed-bar count to a human-readable duration using the timeframe's
 * millisecond length. Returns "0m" when bars=0 (edge: lost on the very last bar).
 */
function barsToDuration(bars: number, tfMs: number): string {
  const totalMs = bars * tfMs;
  const hours = totalMs / 3_600_000;
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(totalMs / 86_400_000)}d`;
}

/** Format one HtfLevel for the prompt line. */
function fmtHtfLevel(level: HtfLevel, tfMs: number): string {
  const parts: string[] = [`${level.touchCount} touches`];
  if (level.rejectedFromAbove > 0) {
    parts.push(`rejected ${level.rejectedFromAbove}x`);
  } else if (level.defendedFromBelow > 0) {
    parts.push(`defended ${level.defendedFromBelow}x`);
  }
  if (level.status === "lost") {
    const ago = level.barsSinceLastTouch === 0
      ? "recently"
      : `${barsToDuration(level.barsSinceLastTouch, tfMs)} ago`;
    parts.push(`LOST ${ago}`);
  } else {
    parts.push(level.status); // "intact" or "reclaimed"
    if (level.barsSinceLastTouch > 0) {
      parts.push(`last ${barsToDuration(level.barsSinceLastTouch, tfMs)}`);
    }
  }
  return `${fmtPrice(level.price)} (${parts.join(", ")})`;
}

/**
 * Build the full HTF levels prompt line from the ≤4 selected levels.
 * Levels arrive sorted ascending from detectHTFLevels.
 * "above" renders nearest-first (ascending = correct order).
 * "below" renders nearest-first (descending = reversed).
 */
function buildHtfLine(levels: HtfLevel[], formingClose: number, tfMs: number): string {
  const above = levels.filter((l) => l.price > formingClose);
  const below = levels.filter((l) => l.price <= formingClose).reverse();
  const sections: string[] = [];
  if (above.length > 0) {
    sections.push(`above — ${above.map((l) => fmtHtfLevel(l, tfMs)).join(" · ")}`);
  }
  if (below.length > 0) {
    sections.push(`below — ${below.map((l) => fmtHtfLevel(l, tfMs)).join(" · ")}`);
  }
  return `HTF levels (touch-counted, 400-bar window): ${sections.join(". ")}.`;
}

// ─── Brick 3, Phase 3B: W/M formation prompt helper ──────────────────────────

/**
 * Render one WMFormation as the single "Formation:" prompt line.
 * Example (M): "Formation: M-pattern (double top) — peaks 64,230 / 64,190 (Δ 0.06×ATR),
 *               22 bars apart; neckline 63,580; price 0.4% above neckline; second-peak volume lower."
 */
function buildWmLine(f: WMFormation): string {
  const typeLabel  = f.type === "W" ? "W-pattern (double bottom)" : "M-pattern (double top)";
  const extremeWord = f.type === "W" ? "troughs" : "peaks";
  const secondWord  = f.type === "W" ? "second-trough" : "second-peak";
  const distPct  = (Math.abs(f.currentPriceDistFromNeckline) * 100).toFixed(1);
  const distDir  = f.currentPriceDistFromNeckline >= 0 ? "above" : "below";
  const volFact  = f.secondExtremeVolumeLower
    ? `${secondWord} volume lower`
    : `${secondWord} volume higher (no divergence)`;
  return (
    `Formation: ${typeLabel} — ${extremeWord} ${fmtPrice(f.extreme1.price)} / ${fmtPrice(f.extreme2.price)}` +
    ` (Δ ${f.deltaAtr.toFixed(2)}×ATR), ${f.barSeparation} bars apart;` +
    ` neckline ${fmtPrice(f.neckline.price)}; price ${distPct}% ${distDir} neckline; ${volFact}.`
  );
}

const SYSTEM_PROMPT = `You are an autonomous perpetual-futures trading strategist for QuantumVault's AI Trader. You operate on a fixed decision cadence and must respond with exactly one "decide" tool call — no prose, no free text.

Core stance: flat is a position. You are evaluated on risk-adjusted return net of fees, not on how often you trade. Overtrading destroys accounts through fees and slippage long before any edge can compound — when in doubt, stay flat.

Rules:
- Every stop loss must sit beyond the nearest obvious liquidity/structure level (a swing high/low, range boundary, or similar), never at an arbitrary distance from entry. Beyond means PAST the level with a volatility buffer calibrated by timeframe: 15m ≥ 0.9×ATR(14), 1h/4h ≥ 0.75×ATR(14), 1d ≥ 0.75×ATR(14) (provisional). The obvious swing point is where resting stops cluster — a stop at or just past it gets tagged by a routine sweep wick before the real move. This buffer applies to every structural stop (swing points, range boundaries, HTF levels, W/M pattern extremes). When an Active range is present in this context, the rendered safe-zone prices are the concrete minimum-viable SL placements; treat them as a floor, not a suggestion. If the buffered stop no longer supports ≥1.5:1 reward:risk, the setup is too tight — stay flat rather than shaving the buffer. In risk-based mode a wider stop costs zero additional dollars (size scales down proportionally to keep risk constant), so there is never a budget justification for shaving the buffer.
- Reject any setup whose reward:risk ratio is below 1.5:1 — target meaningfully more than the enforced minimum.
- Never increase size or leverage to recover a prior loss. No martingale, no revenge trading.
- On a lower timeframe (15m/1h), treat the higher timeframe trend shown in this context as the dominant bias. Do not fight it without a clearly stated, strong invalidation case.
- The fee context below is real: a take-profit that does not clear the round-trip fee by a wide margin is not a trade worth taking.
- Base your decision only on the market data, indicators, account state, and guardrails provided in this context. All of it comes from verified market/account data — none of it is user-supplied free text.

Hyperliquid participation data in this context (open interest, 24h volume, funding, and mark/oracle premium) is corroboration only, from a reference venue you do not trade on. Rising open interest alongside a price move signals conviction behind it; falling open interest against the move signals weak participation. It must never be the sole basis for an entry, and its absence or unavailability must never be a reason to refuse an otherwise valid decision. For non-crypto markets (stocks, FX, commodities) this data and the BTC COT line are intentionally omitted — treat their absence as expected, not as missing data.

BTC COT positioning data (when present in this context) is a weekly macro bias from the CFTC Legacy futures-only report, reflecting commercial-hedger versus speculator positioning. Because BTC sets the regime for the broader crypto market, this signal applies to all crypto markets — treat it as a tilt on directional lean and how much to trust a setup, never a standalone entry trigger. It degrades when the traded market decouples from BTC on an alt-specific move.

Session context (when present in this context) is liquidity fact, not signal — prefer standing aside on marginal setups in thin/boundary windows, widen breakout skepticism, cite it in the rationale when it moves the decision; never let it alone veto an otherwise strong setup.

Dow structure (when present in this context) is trend-structure confirmation — alignment between the selected and parent timeframe supports trend entries with normal conviction; misalignment or mixed on either timeframe warrants smaller position size or standing aside on directional setups; insufficient means the window lacks enough pivot history to classify structure. Never use Dow structure alone as an entry trigger.

HTF levels (when present in this context) mark multi-touch price zones where orders historically cluster — prefer taking profit IN FRONT of a level rather than beyond it, prefer stops BEYOND defended levels rather than inside them, a lost-then-reclaimed level is meaningful directional context. Placement guidance and confluence only, never a standalone trigger.

W/M formations (double bottom/top, when present in this context) mark a completed two-test structure where current price is within 0.5% of the neckline — immediately actionable. A neckline tested twice and now retested is confluence for directional lean and SL/TP placement: prefer stops beyond the pattern's far extreme, targets beyond the neckline. Weigh it with Dow structure and participation; it is never a standalone entry trigger.`;

export async function buildMarketContext(
  input: BuildMarketContextInput
): Promise<BuildMarketContextResult> {
  const { market, timeframe, adapter, bot, recentDecisions, scannerNote } = input;

  const tfMs = TIMEFRAME_MS[timeframe];
  const now = Date.now();
  const selectedEnd = new Date(now).toISOString();
  const selectedStart = new Date(now - INDICATOR_BARS * tfMs).toISOString();

  const datafeedTicker = marketToDatafeedTicker(market);
  let selectedRaw: OHLCV[];
  try {
    selectedRaw = await fetchOHLCV(datafeedTicker, timeframe, selectedStart, selectedEnd, undefined, {
      deadlineMs: 45_000,
      callerClass: "context",
    });
  } catch (err) {
    // Degraded candle cache (DB pressure): never build a prompt without
    // data and never trigger a network fallback — report stale, the
    // decision cycle skips this boundary and retries on the next one.
    if (isCacheDegradedError(err)) {
      return { stale: true, reason: `Candle cache degraded (DB pressure) for ${market} ${timeframe}` };
    }
    throw err;
  }
  if (selectedRaw.length === 0) {
    return { stale: true, reason: `No ${timeframe} candle data returned for ${market}` };
  }
  // Indicator computation uses the wide (up to 400-bar) window; the CSV block
  // below only ever serializes the most recent SELECTED_BARS of it.
  const indicatorCandles = selectedRaw.slice(-INDICATOR_BARS);
  const csvCandles = indicatorCandles.slice(-SELECTED_BARS);

  // G9: staleness gate. Never build a prompt on stale data.
  const newest = indicatorCandles[indicatorCandles.length - 1];
  const ageMs = now - newest.time;
  if (ageMs > 2 * tfMs) {
    return {
      stale: true,
      reason: `Newest ${timeframe} candle is ${Math.round(ageMs / 60_000)}m old (max allowed ${Math.round(
        (2 * tfMs) / 60_000
      )}m)`,
    };
  }

  const parentTf = PARENT_TIMEFRAME[timeframe];
  let parentIndicatorCandles: OHLCV[] = [];
  let parentCandles: OHLCV[] = [];
  if (parentTf) {
    const parentTfMs = TIMEFRAME_MS[parentTf];
    // Brick 2+4: fetch PARENT_INDICATOR_BARS for pivot computation.
    // parentCandles (PARENT_BARS=30) is the CSV render slice only — token economy unchanged.
    const parentStart = new Date(now - PARENT_INDICATOR_BARS * parentTfMs).toISOString();
    try {
      const parentRaw = await fetchOHLCV(datafeedTicker, parentTf, parentStart, selectedEnd, undefined, {
        deadlineMs: 45_000,
        callerClass: "context",
      });
      parentIndicatorCandles = parentRaw.slice(-PARENT_INDICATOR_BARS);
      parentCandles = parentIndicatorCandles.slice(-PARENT_BARS); // CSV render only
    } catch (err) {
      // Parent TF is an enrichment: on a degraded cache read proceed without
      // it (Dow/HTF lines simply omit parent context) rather than failing
      // the whole decision cycle. Other errors still propagate.
      if (!isCacheDegradedError(err)) throw err;
      console.warn(`[ContextBuilder] Parent ${parentTf} candle cache degraded for ${market} — proceeding without parent context`);
    }
  }

  // Brick 2, Phase 2B: Dow structure enrichment (enrichment rule — try/catch omits
  // the line and stamps null on any error; the decision cycle proceeds unaffected).
  // Computation uses the wide 400-bar windows (both TFs) so the pivot detector has
  // enough bars for N=3 fractals with 4 required alternating pivots.
  // Brick 4 (HTF levels / ZEC pattern) reuses parentIndicatorCandles from above.
  let dowLine: string | null = null;
  let dowDigest: { selected: string; parent: string | null; aligned: boolean | null } | null = null;
  try {
    const selResult = classifyDow(detectPivots(indicatorCandles));
    const parResult =
      parentTf && parentIndicatorCandles.length > 0
        ? classifyDow(detectPivots(parentIndicatorCandles))
        : null;
    const built = buildDowLine(timeframe, selResult, parentTf, parResult);
    dowLine = built.line;
    dowDigest = {
      selected: selResult.classification,
      parent:   parResult?.classification ?? null,
      aligned:  built.aligned,
    };
  } catch {
    // enrichment rule: omit line, digest null, decision proceeds
  }

  // Crypto-only context signals: BTC COT and Hyperliquid open-interest/funding
  // corroboration are meaningless for stock / FX / commodity perps — skip the
  // fetches entirely and label the sections "not applicable" so the model never
  // reads intentional absence as a data-integrity problem.
  // Known gap (harmless): non-crypto bases deliberately absent from
  // NON_CRYPTO_PYTH_MAP (NATGAS, SPCX, COPPER, …) classify as "crypto" here,
  // but they are feed-dead — buildMarketContext returns stale before any
  // injection — and they sit in SCANNER_FEED_EXCLUDE.
  const nonCryptoMarket = isNonCryptoSymbol(datafeedTicker);

  // WO-8f / PRICE-STARVE: fetch the HL snapshot here — before the venue price
  // check — so hlSnapshot.markPrice is available as a fallback tier if the
  // Pacifica /book call is still starved after the priority upgrade above.
  // hl-context.ts resolves all failure modes to null; the try/catch is
  // defense-in-depth against future contract changes.
  // (Skipped for non-crypto markets — Hyperliquid lists crypto only, so the
  // call could never succeed; this also removes the useless HL price-fallback
  // tier for those markets.)
  let hlSnapshot: HlParticipationSnapshot | null;
  if (nonCryptoMarket) {
    hlSnapshot = null;
  } else {
    try {
      hlSnapshot = await getHlParticipationSnapshot(market);
    } catch {
      hlSnapshot = null;
    }
  }

  // PRICE-STARVE fix: request at 'normal' priority (270-credit cap) so the
  // analyze cycle is not starved by background dashboard sweeps that compete
  // for the 162-credit background cap.  If the venue price is still null,
  // the three-tier fallback resolves a reference price without aborting:
  //   1. hl_reference — hlSnapshot.markPrice (Hyperliquid, just fetched above)
  //   2. candle       — newest candle close when age < 1 TF interval
  //   3. stale-fail   — all sources dry; cycle aborts (G9 semantics preserved)
  // The paper executor reads markPrice from contextDigest.price automatically.
  let price = await adapter.getPrice(market, { priority: 'normal' });
  let priceSource: 'venue' | 'hl_reference' | 'candle' = 'venue';
  if (price === null) {
    // Tier 1: HL reference — ratio guard vs newest candle close to reject
    // unit-scale mismatches (e.g. HL kBONK = 1000× raw BONK → ratio ≈ 1000;
    // any ratio outside [0.5, 2.0] is almost certainly a scale bug, not basis).
    const candleClose = indicatorCandles[indicatorCandles.length - 1].close;
    const hlMark = hlSnapshot?.markPrice;
    if (hlMark != null && Number.isFinite(hlMark) && hlMark > 0 && candleClose > 0) {
      const ratio = hlMark / candleClose;
      if (ratio >= 0.5 && ratio <= 2.0) {
        price = hlMark;
        priceSource = 'hl_reference';
        console.warn(`[ContextBuilder] venue price null for ${market} — using HL markPrice ${hlMark}`);
      } else {
        console.warn(
          `[ContextBuilder] HL markPrice ${hlMark} rejected for ${market}: ratio ${ratio.toFixed(4)} outside [0.5, 2.0] (unit-scale guard)`,
        );
      }
    }
    // Tier 2: newest candle close when age < 1 TF interval (fallback for both
    // HL-unavailable and HL-ratio-rejected).
    if (price === null) {
      const newest = indicatorCandles[indicatorCandles.length - 1];
      const closeAge = now - newest.time;
      if (closeAge < tfMs) {
        price = newest.close;
        priceSource = 'candle';
        console.warn(
          `[ContextBuilder] venue price null for ${market} — using newest ${timeframe} candle close ${price} (age ${Math.round(closeAge / 1000)}s)`,
        );
      } else {
        // Tier 3: all sources dry → stale-fail (G9 semantics preserved).
        return { stale: true, reason: `No live price available for ${market}` };
      }
    }
  }

  // Brick 4, Phase 4B: HTF levels enrichment (enrichment rule — try/catch omits block,
  // stamps null on any error; decision proceeds unaffected). Reuses indicatorCandles
  // (400-bar selected) and parentIndicatorCandles (400-bar parent) already fetched above —
  // no additional I/O. Placed after the price fetch so buildHtfLine uses the live adapter
  // price as the "above/below" reference (consistent with what the model sees).
  // Null convention: BOTH "try/catch error" AND "no qualifying levels" stamp htfLevels=null;
  // there is no empty-array case.
  let htfLine: string | null = null;
  let htfDigest: HtfLevel[] | null = null;
  try {
    const htfResult = detectHTFLevels(indicatorCandles, parentIndicatorCandles);
    if (htfResult.levels.length > 0) {
      htfDigest = htfResult.levels;
      htfLine = buildHtfLine(htfResult.levels, price, tfMs);
    }
    // Empty levels array → htfLine/htfDigest stay null (omission rule: no qualifying levels).
  } catch {
    // enrichment rule: omit block, digest null, decision proceeds
  }

  // SL-PLACE Phase A: Active-range enrichment (enrichment rule — try/catch omits the line
  // and stamps null on any error; decision cycle proceeds unaffected). Reuses indicatorCandles
  // (400-bar selected) and the live adapter price already fetched above — no additional I/O.
  // Null convention: BOTH the "try/catch error" case AND the "no qualifying range" case
  // (insufficient data, degenerate range, or invalid ATR) stamp activeRange=null. The range
  // high/low are RAW extremes — no fractal or touch-count gate — so a lone non-fractal extreme
  // that HTF-levels would exclude (e.g. the AAVE 91.78 case) still appears here correctly.
  let activeRangeLine: string | null = null;
  let activeRangeDigest: ActiveRange | null = null;
  try {
    const ar = detectActiveRange(indicatorCandles, price);
    if (ar !== null) {
      activeRangeDigest = ar;
      // Line built below, after atr14 is computed (needed for safe-zone rendering).
    }
  } catch {
    // enrichment rule: omit line, digest null, decision proceeds
  }

  // Brick 3, Phase 3B: W/M formation enrichment (enrichment rule — try/catch omits the line
  // and stamps null on any error; decision cycle proceeds unaffected). Uses indicatorCandles
  // (400-bar selected window) — no additional I/O. Null convention: BOTH the "try/catch error"
  // case AND the "no detection" case stamp wmFormation=null; there is no "detection but no line"
  // case — any non-null WMFormation always produces a line.
  let wmLine: string | null = null;
  let wmDigest: WMFormation | null = null;
  try {
    const wm = detectWM(indicatorCandles);
    if (wm !== null) {
      wmDigest = wm;
      wmLine = buildWmLine(wm);
    }
  } catch {
    // enrichment rule: omit line, digest null, decision proceeds
  }

  const closes = indicatorCandles.map((c) => c.close);
  const highs = indicatorCandles.map((c) => c.high);
  const lows = indicatorCandles.map((c) => c.low);
  const volumes = indicatorCandles.map((c) => c.volume);

  const ema20 = lastTwo(ema(closes, 20));
  const ema50 = lastTwo(ema(closes, 50));
  const ema200 = lastTwo(ema(closes, 200));
  const rsi14 = lastTwo(rsi(closes, 14));
  const macdResult = macd(closes, 12, 26, 9);
  const macdLast = lastTwo(macdResult.macd);
  const signalLast = lastTwo(macdResult.signal);
  const histLast = lastTwo(macdResult.hist);
  const atr14 = lastTwo(atr(highs, lows, closes, 14));
  const adx14 = lastTwo(adx(highs, lows, closes, 14));
  const bb = bollingerBands(closes, 20, 2);
  const bbUpper = lastTwo(bb.upper);
  const bbBasis = lastTwo(bb.basis);
  const bbLower = lastTwo(bb.lower);
  const st = supertrend(highs, lows, closes, 3, 10);
  const stValue = lastTwo(st.supertrend);
  const stDir = lastTwo(st.direction);
  const obvVals = lastTwo(obv(closes, volumes));

  // SL-PLACE Phase B: build active range line now that atr14 is available for
  // safe-zone rendering. Detection already ran above (try/catch; digest set on success).
  if (activeRangeDigest !== null) {
    try {
      activeRangeLine = buildActiveRangeLine(activeRangeDigest, tfMs, atr14.value, timeframe);
    } catch {
      // enrichment rule: omit line on error
    }
  }

  const indicatorBlock = [
    `EMA(20): ${fmtPrice(ema20.value)} (prev ${fmtPrice(ema20.prev)})`,
    `EMA(50): ${fmtPrice(ema50.value)} (prev ${fmtPrice(ema50.prev)})`,
    `EMA(200): ${fmtPrice(ema200.value)} (prev ${fmtPrice(ema200.prev)})`,
    `RSI(14): ${fmtPct1(rsi14.value)} (prev ${fmtPct1(rsi14.prev)})`,
    `MACD(12,26,9): macd=${fmtMacdComponent(macdLast.value)} signal=${fmtMacdComponent(
      signalLast.value
    )} hist=${fmtMacdComponent(histLast.value)} (prev macd=${fmtMacdComponent(
      macdLast.prev
    )} signal=${fmtMacdComponent(signalLast.prev)} hist=${fmtMacdComponent(histLast.prev)})`,
    `ATR(14): ${fmtPrice(atr14.value)} (prev ${fmtPrice(atr14.prev)})`,
    `ADX(14): ${fmtPct1(adx14.value)} (prev ${fmtPct1(adx14.prev)})`,
    `Bollinger(20,2): upper=${fmtPrice(bbUpper.value)} basis=${fmtPrice(bbBasis.value)} lower=${fmtPrice(
      bbLower.value
    )} (prev upper=${fmtPrice(bbUpper.prev)} basis=${fmtPrice(bbBasis.prev)} lower=${fmtPrice(bbLower.prev)})`,
    `Supertrend(3,10): ${fmtPrice(stValue.value)} dir=${stDir.value === 1 ? "up" : stDir.value === -1 ? "down" : "n/a"} (prev ${fmtPrice(
      stValue.prev
    )} dir=${stDir.prev === 1 ? "up" : stDir.prev === -1 ? "down" : "n/a"})`,
    `OBV: ${fmtObv(obvVals.value)} (prev ${fmtObv(obvVals.prev)})`,
    // Brick 2, Phase 2B: Dow structure line (omitted when dowLine is null).
    ...(dowLine !== null ? [dowLine] : []),
    // Brick 4, Phase 4B: HTF levels line (omitted when no levels qualify or on error).
    ...(htfLine !== null ? [htfLine] : []),
    // SL-PLACE Phase A: Active-range line (omitted when null or on error). Raw walk-back
    // extremes; no fractal/touch gate, so it captures lone non-fractal highs/lows that
    // HTF-levels omits. Placed after HTF-levels so the model sees both in proximity.
    ...(activeRangeLine !== null ? [activeRangeLine] : []),
    // Brick 3, Phase 3B: W/M formation line (omitted when no detection or on error).
    ...(wmLine !== null ? [wmLine] : []),
  ].join("\n");

  // COT-B: fetch COT snapshot and fundingRate concurrently — both are cached reads.
  // getCotSnapshot() is fail-open; the IIFE applies the omission threshold so
  // cotSnapshot is null whenever the line must be absent from the prompt.
  const [fundingInfo, cotSnapshot] = await Promise.all([
    adapter.getFundingRate(market),
    (async (): Promise<CotSnapshot | null> => {
      // BTC COT is a crypto-regime signal — never inject it for stock/FX/commodity markets.
      if (nonCryptoMarket) return null;
      try {
        const snap = await getCotSnapshot();
        if (!snap) return null;
        const reportAgeMs = now - new Date(snap.reportDate).getTime();
        if (snap.state === "insufficient_data" || reportAgeMs > COT_OMISSION_THRESHOLD_MS) return null;
        return snap;
      } catch {
        return null;
      }
    })(),
  ]);
  const roundTripFeePct = 2 * EXCHANGE_TAKER_FEE_RATE * 100;
  // The ProtocolAdapter contract types nextFundingTime as a required number, but
  // the Pacifica adapter (server/protocol/pacifica/pacifica-adapter.ts) violates
  // it in two paths (fast-path market-cache read and its own catch fallback),
  // returning `undefined` — `new Date(undefined).toISOString()` throws
  // RangeError: Invalid time value, discovered live during WO-7's round-trip
  // test. Fixing the Pacifica adapter's contract violation is out of scope
  // here (a protocol-adapter/money-adjacent file); guard defensively instead.
  const nextFundingLabel =
    typeof fundingInfo.nextFundingTime === "number" && Number.isFinite(fundingInfo.nextFundingTime)
      ? new Date(fundingInfo.nextFundingTime).toISOString()
      : "unknown";
  const microstateBlock = [
    `Mark price: ${fmtPrice(price)}${priceSource === 'hl_reference' ? ' (HL reference — venue price unavailable this cycle)' : priceSource === 'candle' ? ' (candle close — venue and HL price unavailable this cycle)' : ''}`,
    `Funding rate (Pacifica — this is what your position actually pays): ${(fundingInfo.rate * 100).toFixed(
      4
    )}% (next funding at ${nextFundingLabel})`,
    `Taker fee: ${(EXCHANGE_TAKER_FEE_RATE * 100).toFixed(2)}% per side, ${roundTripFeePct.toFixed(
      2
    )}% round-trip. TP distance must clear this by a wide margin (guardrail G4 requires ≥ 4x).`,
    // COT-B: inject one line near the funding line when snapshot passes omission threshold.
    ...(cotSnapshot ? [buildCotBiasLine(cotSnapshot)] : []),
  ].join("\n");

  // WO-8f / PRICE-STARVE: hlSnapshot was fetched before the venue price check
  // (see above) so its markPrice can serve as a fallback tier when /book is
  // quota-starved.  The variable remains in scope for participationBlock and
  // contextDigest below.
  const participationBlock = nonCryptoMarket
    ? "Participation data: not applicable — this is a stock/FX/commodity market. Crypto-derived corroboration (Hyperliquid open interest/funding, BTC COT) is intentionally omitted for non-crypto markets; judge the setup on price action and the venue data above."
    : hlSnapshot
    ? [
        `Open interest: ${fmtCommaNum(hlSnapshot.openInterest)} ${hlSnapshot.hlSymbol} (Δ ${fmtPct1Signed(
          hlSnapshot.openInterestDeltaPct
        )} since last cycle, Δ ${fmtPct1Signed(hlSnapshot.openInterestDeltaPctWindow)} over stored window)`,
        `24h volume: ${fmtUsd0(hlSnapshot.volume24h)} (trend: ${hlSnapshot.volumeTrend})`,
        `HL funding: ${fmtRatePct4(hlSnapshot.fundingRate)} (trajectory, oldest to newest: ${hlSnapshot.fundingTrajectory
          .map((r) => fmtRatePct4(r))
          .join(", ")})`,
        `Mark/oracle premium: ${fmtRatePct4(hlSnapshot.premium)}`,
        `HL-vs-Pacifica funding spread: ${fmtRatePct4(
          hlSnapshot.fundingRate - fundingInfo.rate
        )} (positive = HL funding richer than Pacifica)`,
      ].join("\n")
    : "Participation data: unavailable this cycle";

  // WO-5 corrective (was a flagged WO-3 spec gap): positions are read with the
  // caller-resolved agent SIGNING pubkey (input.agentPublicKey), never the
  // user's connected wallet address — bot.walletAddress owns nothing on any
  // venue, so the old placeholder always read an empty account and would have
  // told the model "no open position" while one was open.
  // WO-7.1: a sub-provisioned live bot's positions live on its OWN subaccount
  // (read with the sub pubkey, no subaccountId param); canary/paper bots read
  // the main agent account as before.
  const positions = await adapter.getPositions(bot.protocolSubaccountId ?? input.agentPublicKey, undefined);
  const openPosition = positions.find((p) => p.internalSymbol.toUpperCase() === market.toUpperCase());
  const allocatedUsdc = parseFloat(bot.allocatedUsdc);
  const accountBlock = openPosition
    ? [
        `Allocated collateral: $${fmtPrice(allocatedUsdc)}`,
        `Open position: ${openPosition.baseSize > 0 ? "long" : "short"} ${Math.abs(
          openPosition.baseSize
        )} @ entry ${fmtPrice(openPosition.entryPrice)}, mark ${fmtPrice(openPosition.markPrice)}, leverage ${
          openPosition.leverage
        }x`,
        `Unrealized PnL: $${fmtPrice(openPosition.unrealizedPnl)}`,
      ].join("\n")
    : [`Allocated collateral: $${fmtPrice(allocatedUsdc)}`, `Open position: none (flat)`, `Unrealized PnL: $0.00`].join(
        "\n"
      );

  const historyLines =
    recentDecisions.length === 0
      ? ["No closed trades yet."]
      : recentDecisions.map((d, i) => {
          const digest = d.contextDigest as { indicators?: { adx14?: { value?: number } } } | null | undefined;
          const regime = adxRegimeTag(digest?.indicators?.adx14?.value);
          const entry = d.entryPrice !== null && d.entryPrice !== undefined ? fmtPrice(parseFloat(d.entryPrice)) : "n/a";
          const exit = d.exitPrice !== null && d.exitPrice !== undefined ? fmtPrice(parseFloat(d.exitPrice)) : "n/a";
          const pnl =
            d.realizedPnl !== null && d.realizedPnl !== undefined ? fmtPrice(parseFloat(d.realizedPnl)) : "n/a";
          return `${i + 1}. side=${decisionSide(d)} entry=${entry} exit=${exit} exitReason=${
            d.exitReason ?? "n/a"
          } realizedPnl=$${pnl} regime=${regime}`;
        });
  const historyBlock = historyLines.join("\n");

  const closedWithTimes = recentDecisions.filter((d) => d.closedAt);
  const lastClosedAt = closedWithTimes.length > 0 ? new Date(closedWithTimes[0].closedAt as Date).getTime() : null;
  const cooldownRemainingMs = lastClosedAt !== null ? Math.max(0, tfMs - (now - lastClosedAt)) : 0;
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const tradesToday = closedWithTimes.filter(
    (d) => new Date(d.closedAt as Date).getTime() >= startOfDay.getTime()
  ).length;
  const maxTradesPerDay = LTF_TIMEFRAMES.has(timeframe) ? 6 : 2;

  const ddProxy = Number.isFinite(atr14.value) && price > 0 ? (SMART_LEVERAGE_K * atr14.value) / price : NaN;
  const smartLeverageCap = Number.isFinite(ddProxy) && ddProxy > 0
    ? Math.max(1, Math.min(SMART_LEVERAGE_HARD_CEILING, Math.floor(0.5 / ddProxy)))
    : SMART_LEVERAGE_HARD_CEILING;
  const maxLeverage = Math.min(bot.maxLeverage, smartLeverageCap, SMART_LEVERAGE_HARD_CEILING);

  const guardrailLines = [
    `Max leverage: ${maxLeverage}x (bot cap ${bot.maxLeverage}x, smart volatility cap ${smartLeverageCap}x, hard ceiling ${SMART_LEVERAGE_HARD_CEILING}x)`,
    `Size bounds: 10%-90% of allocated collateral as margin`,
    `Reward:risk floor (enforced): >= 1.2 after fees (target >= 1.5 per your instructions above)`,
    `Cooldown: ${cooldownRemainingMs > 0 ? `${Math.round(cooldownRemainingMs / 60_000)}m remaining before next entry` : "clear, no cooldown active"}`,
    `Trades today: ${tradesToday}/${maxTradesPerDay} (${LTF_TIMEFRAMES.has(timeframe) ? "LTF" : "HTF"} cap)`,
  ];
  if (bot.sizingMode === "risk_based") {
    guardrailLines.push(
      `Sizing: automatic and risk-normalised to a confidence-scaled fraction of live equity — sizePct and leverage requests are ignored, so focus on stop quality and report confidence honestly because it directly moves position size.`
    );
  }
  const guardrailBlock = guardrailLines.join("\n");

  // Brick 1, Phase 1B: session context enrichment block (pure clock math, no I/O).
  // Enrichment rule: a try/catch omits the block on any error; decision proceeds.
  let sessionCtxBlock: string | null = null;
  let sessionCtxDigest: {
    session: string;
    weekendFlag: boolean;
    weeklyOpenProximity: boolean;
  } | null = null;
  try {
    const sc = getSessionContext(new Date(now));
    sessionCtxBlock = sc.block;
    sessionCtxDigest = {
      session: sc.label,
      weekendFlag: sc.label === "weekend",
      weeklyOpenProximity: sc.nearWeeklyOpen,
    };
  } catch {
    // enrichment rule: omit block, decision proceeds unaffected
  }

  const selectedCsv = candlesToCsv(csvCandles);
  const parentCsv = parentCandles.length > 0 ? candlesToCsv(parentCandles) : null;

  const userSections = [
    `# Market context — ${market} (${timeframe}), generated ${new Date(now).toISOString()}`,
    `Bot mode: ${bot.mode}, risk profile: ${bot.riskProfile}${bot.paperMode ? " (paper trading)" : ""}`,
    `## Indicators (${timeframe})`,
    indicatorBlock,
    `## Market microstate`,
    microstateBlock,
    ...(sessionCtxBlock !== null ? [sessionCtxBlock] : []),
    `## Market participation — Hyperliquid (reference venue; you trade on Pacifica)`,
    participationBlock,
    `## Account state`,
    accountBlock,
    `## Last ${recentDecisions.length} closed trades (most recent first)`,
    historyBlock,
    `## Guardrails (self-censor before the enforced clamp)`,
    guardrailBlock,
    `## Candles — ${timeframe} (oldest -> newest, CSV)`,
    selectedCsv,
  ];
  if (parentCsv) {
    userSections.push(`## Candles — ${parentTf} parent timeframe (oldest -> newest, CSV)`, parentCsv);
  }
  // WO-B: scanner bots inject a selection-rationale note so the model knows
  // this market was chosen by the scanner sweep rather than a user pick.
  if (scannerNote) {
    userSections.push(`## Scanner selection note`, scannerNote);
  }
  const user = userSections.join("\n\n");

  const contextDigest = {
    market,
    timeframe,
    generatedAt: new Date(now).toISOString(),
    price,
    priceSource,
    fundingRate: fundingInfo.rate,
    nextFundingTime: fundingInfo.nextFundingTime,
    participation: hlSnapshot
      ? {
          hlSymbol: hlSnapshot.hlSymbol,
          openInterest: hlSnapshot.openInterest,
          openInterestDeltaPct: hlSnapshot.openInterestDeltaPct,
          openInterestDeltaPctWindow: hlSnapshot.openInterestDeltaPctWindow,
          volume24h: hlSnapshot.volume24h,
          volumeTrend: hlSnapshot.volumeTrend,
          fundingRate: hlSnapshot.fundingRate,
          fundingTrajectory: hlSnapshot.fundingTrajectory,
          markPrice: hlSnapshot.markPrice,
          oraclePrice: hlSnapshot.oraclePrice,
          premium: hlSnapshot.premium,
        }
      : null,
    // COT-B: Phase A pre-declared field. Null when snapshot was absent or omitted.
    cotSignal: cotSnapshot
      ? {
          state: cotSnapshot.state,
          commIndex: cotSnapshot.commIndex,
          dumbIndex: cotSnapshot.dumbIndex,
          reportDate: cotSnapshot.reportDate,
        }
      : null,
    // Brick 1, Phase 1B: session context stamp. Null when module threw (enrichment rule).
    // Mapping: session=label, weekendFlag=(label==="weekend"), weeklyOpenProximity=nearWeeklyOpen.
    sessionContext: sessionCtxDigest,
    // Brick 2, Phase 2B: Dow structure stamp. Null when try/catch triggered (enrichment rule).
    // selected/parent hold the DowClassification strings (not the timeframe labels).
    // aligned truth table: true=both directional+matching, false=both directional+opposite,
    // null=either side mixed/insufficient OR no parent timeframe.
    dowStructure: dowDigest,
    // Brick 4, Phase 4B: HTF levels stamp. Null in BOTH the "try/catch error" case (enrichment
    // rule) AND the "no qualifying levels" case (empty result from detectHTFLevels). There is
    // never an empty-array value — null is the uniform signal for "absent from prompt".
    // Non-null (non-empty HtfLevel[]) means ≥1 level met minTouches and was selected.
    htfLevels: htfDigest,
    // Brick 3, Phase 3B: W/M formation stamp. Null in BOTH the "try/catch error" case
    // (enrichment rule) AND the "no detection" case. Same null convention as htfLevels.
    // Non-null means a qualifying formation was found and the Formation: line is in the prompt.
    wmFormation: wmDigest,
    // SL-PLACE Phase A: Active-range stamp. Null in BOTH the "try/catch error" case
    // (enrichment rule) AND the "no qualifying range" case (insufficient data, degenerate
    // range, or invalid ATR). Non-null means the "Active range …" line is in the prompt.
    // high/low are RAW walk-back extremes; no fractal or touch-count gate was applied.
    activeRange: activeRangeDigest,
    // WO-B: present only for scanner bots; undefined/absent for fixed-ticker bots.
    scannerNote: scannerNote ?? null,
    indicators: {
      ema20,
      ema50,
      ema200,
      rsi14,
      macd: { value: macdLast.value, prev: macdLast.prev },
      signal: { value: signalLast.value, prev: signalLast.prev },
      hist: { value: histLast.value, prev: histLast.prev },
      atr14,
      adx14,
      bollinger: { upper: bbUpper, basis: bbBasis, lower: bbLower },
      supertrend: { value: stValue, direction: stDir },
      obv: obvVals,
    },
    account: {
      allocatedUsdc,
      hasPosition: !!openPosition,
      unrealizedPnl: openPosition ? openPosition.unrealizedPnl : 0,
    },
    guardrailEcho: {
      maxLeverage,
      smartLeverageCap,
      sizePctMin: 10,
      sizePctMax: 90,
      rrFloor: 1.2,
      cooldownRemainingMs,
      tradesToday,
      maxTradesPerDay,
    },
  };

  return { system: SYSTEM_PROMPT, user, contextDigest };
}
