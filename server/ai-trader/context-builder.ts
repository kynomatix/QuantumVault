// Agentic Trader Plan §Part B, WO-3. Builds the LLM decision-cycle prompt for one
// AI Trader bot from verified market/adapter/history data ONLY. No user-controlled
// free text is interpolated: `bot`'s market/timeframe/mode/riskProfile fields are
// platform enums the user merely *selects*, and the only free-form strings that
// could ever flow through this module (an LLM's own past `rationale`/`invalidation`
// text) are deliberately NOT included in the history block — WO-3 §6 pins that
// block's fields to side/entry/exit/exitReason/realizedPnl/regime tag only.
import { fetchOHLCV } from "../lab/datafeed";
import type { OHLCV } from "../lab/engine";
import { ema, rsi, macd, atr, adx, bollingerBands, supertrend, obv } from "../lab/indicators";
import type { ProtocolAdapter } from "../protocol/adapter";
import type { AiTraderBot, AiTraderDecision } from "@shared/schema";

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

function fmtPrice(v: number): string {
  return Number.isFinite(v) ? v.toFixed(2) : "n/a";
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

function decisionSide(d: AiTraderDecision): string {
  const clamped = d.clampedDecision as { action?: string } | null | undefined;
  const raw = d.rawDecision as { action?: string } | null | undefined;
  return clamped?.action ?? raw?.action ?? "unknown";
}

const SYSTEM_PROMPT = `You are an autonomous perpetual-futures trading strategist for QuantumVault's AI Trader. You operate on a fixed decision cadence and must respond with exactly one "decide" tool call — no prose, no free text.

Core stance: flat is a position. You are evaluated on risk-adjusted return net of fees, not on how often you trade. Overtrading destroys accounts through fees and slippage long before any edge can compound — when in doubt, stay flat.

Rules:
- Every stop loss must sit beyond the nearest obvious liquidity/structure level (a swing high/low, range boundary, or similar), never at an arbitrary distance from entry.
- Reject any setup whose reward:risk ratio is below 1.5:1 — target meaningfully more than the enforced minimum.
- Never increase size or leverage to recover a prior loss. No martingale, no revenge trading.
- On a lower timeframe (15m/1h), treat the higher timeframe trend shown in this context as the dominant bias. Do not fight it without a clearly stated, strong invalidation case.
- The fee context below is real: a take-profit that does not clear the round-trip fee by a wide margin is not a trade worth taking.
- Base your decision only on the market data, indicators, account state, and guardrails provided in this context. All of it comes from verified market/account data — none of it is user-supplied free text.`;

export async function buildMarketContext(
  input: BuildMarketContextInput
): Promise<BuildMarketContextResult> {
  const { market, timeframe, adapter, bot, recentDecisions } = input;

  const tfMs = TIMEFRAME_MS[timeframe];
  const now = Date.now();
  const selectedEnd = new Date(now).toISOString();
  const selectedStart = new Date(now - INDICATOR_BARS * tfMs).toISOString();

  const selectedRaw = await fetchOHLCV(market, timeframe, selectedStart, selectedEnd);
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
  let parentCandles: OHLCV[] = [];
  if (parentTf) {
    const parentTfMs = TIMEFRAME_MS[parentTf];
    const parentStart = new Date(now - PARENT_BARS * parentTfMs).toISOString();
    const parentRaw = await fetchOHLCV(market, parentTf, parentStart, selectedEnd);
    parentCandles = parentRaw.slice(-PARENT_BARS);
  }

  const price = await adapter.getPrice(market);
  if (price === null) {
    return { stale: true, reason: `No live price available for ${market}` };
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
  ].join("\n");

  const fundingInfo = await adapter.getFundingRate(market);
  const roundTripFeePct = 2 * EXCHANGE_TAKER_FEE_RATE * 100;
  const microstateBlock = [
    `Mark price: ${fmtPrice(price)}`,
    `Funding rate: ${(fundingInfo.rate * 100).toFixed(4)}% (next funding at ${new Date(
      fundingInfo.nextFundingTime
    ).toISOString()})`,
    `Taker fee: ${(EXCHANGE_TAKER_FEE_RATE * 100).toFixed(2)}% per side, ${roundTripFeePct.toFixed(
      2
    )}% round-trip. TP distance must clear this by a wide margin (guardrail G4 requires ≥ 4x).`,
  ].join("\n");

  // WO-5 corrective (was a flagged WO-3 spec gap): positions are read with the
  // caller-resolved agent SIGNING pubkey (input.agentPublicKey), never the
  // user's connected wallet address — bot.walletAddress owns nothing on any
  // venue, so the old placeholder always read an empty account and would have
  // told the model "no open position" while one was open.
  const positions = await adapter.getPositions(input.agentPublicKey, bot.protocolSubaccountId ?? undefined);
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

  const guardrailBlock = [
    `Max leverage: ${maxLeverage}x (bot cap ${bot.maxLeverage}x, smart volatility cap ${smartLeverageCap}x, hard ceiling ${SMART_LEVERAGE_HARD_CEILING}x)`,
    `Size bounds: 10%-90% of allocated collateral as margin`,
    `Reward:risk floor (enforced): >= 1.2 after fees (target >= 1.5 per your instructions above)`,
    `Cooldown: ${cooldownRemainingMs > 0 ? `${Math.round(cooldownRemainingMs / 60_000)}m remaining before next entry` : "clear, no cooldown active"}`,
    `Trades today: ${tradesToday}/${maxTradesPerDay} (${LTF_TIMEFRAMES.has(timeframe) ? "LTF" : "HTF"} cap)`,
  ].join("\n");

  const selectedCsv = candlesToCsv(csvCandles);
  const parentCsv = parentCandles.length > 0 ? candlesToCsv(parentCandles) : null;

  const userSections = [
    `# Market context — ${market} (${timeframe}), generated ${new Date(now).toISOString()}`,
    `Bot mode: ${bot.mode}, risk profile: ${bot.riskProfile}${bot.paperMode ? " (paper trading)" : ""}`,
    `## Indicators (${timeframe})`,
    indicatorBlock,
    `## Market microstate`,
    microstateBlock,
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
  const user = userSections.join("\n\n");

  const contextDigest = {
    market,
    timeframe,
    generatedAt: new Date(now).toISOString(),
    price,
    fundingRate: fundingInfo.rate,
    nextFundingTime: fundingInfo.nextFundingTime,
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
