// WO-8f: Hyperliquid market-context enrichment. Supplies open interest, 24h
// volume, funding, and mark/oracle premium as CONFIRMATION context for the
// AI Trader's LLM decision (server/ai-trader/context-builder.ts) — never a
// gate, never load-bearing. A null snapshot must never block a decision or
// touch G9 candle-staleness gating, which lives entirely in context-builder.ts
// and is unaffected by anything in this file.
//
// Why Hyperliquid: Binance's futures API 451s from this server (geo-blocked,
// verified live against fapi.binance.com this session, not just for end
// users); Pacifica's own open interest is too thin to be a meaningful
// confirmation signal. Hyperliquid is free, keyless, not geo-blocked, and
// reportedly the 3rd-largest perpetuals exchange by open interest — the best
// real participation signal available, even though QuantumVault trades on
// Pacifica, not Hyperliquid.
//
// Data source: POST https://api.hyperliquid.xyz/info, body
// {"type":"metaAndAssetCtxs"} — verified live this session. No API key. The
// response is a 2-element array: [0].universe[i].name is the coin ticker,
// [1][i] is that same index's asset context (openInterest, dayNtlVlm,
// funding, markPx, oraclePx, premium — all numeric values arrive as
// strings). One request returns every listed asset.

const HL_INFO_URL = "https://api.hyperliquid.xyz/info";
const FETCH_TIMEOUT_MS = 2_000;

// One HTTP call returns every asset's context, so multiple bots/markets
// deciding around the same moment should share one upstream call rather than
// each firing their own. This is a short-lived whole-response cache (not a
// per-cycle token threaded through callers, since fetchHlSnapshot's signature
// is fixed to a single internalSymbol argument) — bots decide on a cadence of
// 15m or slower, so a few-second cache only ever affects bots that happen to
// fire within the same handful of seconds.
const RESPONSE_CACHE_MS = 5_000;

// Rolling per-market history depth used for delta/trend math.
export const HL_HISTORY_WINDOW = 12;

export interface HlSnapshot {
  openInterest: number;
  volume24h: number;
  fundingRate: number;
  markPrice: number;
  oraclePrice: number;
  premium: number;
}

export type HlVolumeTrend = "rising" | "falling" | "flat" | "unknown";

export interface HlParticipationSnapshot extends HlSnapshot {
  hlSymbol: string;
  /** % change vs. the immediately preceding snapshot; null on the first reading for a market. */
  openInterestDeltaPct: number | null;
  /** % change vs. the oldest snapshot currently held in the up-to-12-reading window; null until a second reading exists. */
  openInterestDeltaPctWindow: number | null;
  volumeTrend: HlVolumeTrend;
  /** Up to the last 3 funding readings, oldest first (includes this cycle's). */
  fundingTrajectory: number[];
}

// Covers every ticker the AI Trader popup's platform-wide market list offers
// today (server/docs-markdown.ts / client/src/pages/App.tsx: SOL, BTC, ETH,
// SUI, APT, ARB, DOGE, WIF, BONK, PEPE, JUP, RENDER — all verified live on
// Hyperliquid's metaAndAssetCtxs universe this session). A market outside
// this table (e.g. a future Flash-only exotic) resolves to null rather than
// throwing, per spec — it just renders "unavailable this cycle" until added.
const SYMBOL_MAP: Record<string, string> = {
  "SOL-PERP": "SOL",
  "BTC-PERP": "BTC",
  "ETH-PERP": "ETH",
  "SUI-PERP": "SUI",
  "APT-PERP": "APT",
  "ARB-PERP": "ARB",
  "DOGE-PERP": "DOGE",
  "WIF-PERP": "WIF",
  // Hyperliquid lists these two under its "k"-prefixed 1000x-scaled tickers
  // (low unit price -> rescaled for tick-size reasons) — verified live
  // against metaAndAssetCtxs this session: "BONK"/"PEPE" are NOT in its
  // universe, "kBONK"/"kPEPE" are.
  "BONK-PERP": "kBONK",
  "PEPE-PERP": "kPEPE",
  "JUP-PERP": "JUP",
  "RENDER-PERP": "RENDER",
};

export function mapToHlSymbol(internalSymbol: string): string | null {
  return SYMBOL_MAP[internalSymbol] ?? null;
}

interface RawAssetCtx {
  funding?: string;
  openInterest?: string;
  dayNtlVlm?: string;
  premium?: string;
  oraclePx?: string;
  markPx?: string;
}

interface RawUniverseEntry {
  name?: string;
}

let cachedUniverse: { byCoin: Map<string, RawAssetCtx>; fetchedAt: number } | null = null;
let inflightFetch: Promise<Map<string, RawAssetCtx> | null> | null = null;

async function fetchWholeUniverse(): Promise<Map<string, RawAssetCtx> | null> {
  const now = Date.now();
  if (cachedUniverse && now - cachedUniverse.fetchedAt < RESPONSE_CACHE_MS) {
    return cachedUniverse.byCoin;
  }
  if (inflightFetch) {
    return inflightFetch;
  }
  inflightFetch = (async (): Promise<Map<string, RawAssetCtx> | null> => {
    try {
      const res = await fetch(HL_INFO_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "metaAndAssetCtxs" }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body) || body.length < 2) return null;
      const meta = body[0] as { universe?: RawUniverseEntry[] } | undefined;
      const ctxs = body[1] as RawAssetCtx[] | undefined;
      if (!meta || !Array.isArray(meta.universe) || !Array.isArray(ctxs)) return null;
      const byCoin = new Map<string, RawAssetCtx>();
      for (let i = 0; i < meta.universe.length; i++) {
        const name = meta.universe[i]?.name;
        const ctx = ctxs[i];
        if (typeof name === "string" && ctx) byCoin.set(name, ctx);
      }
      cachedUniverse = { byCoin, fetchedAt: Date.now() };
      return byCoin;
    } catch {
      // Timeout (AbortSignal fires), network error, non-JSON body, etc. —
      // all fold into "no data this cycle", never a throw.
      return null;
    } finally {
      inflightFetch = null;
    }
  })();
  return inflightFetch;
}

function parseFiniteNumber(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Raw current-cycle Hyperliquid snapshot for one internal market symbol (e.g.
 * "SOL-PERP"). Unknown symbols, network errors, timeouts, and malformed/
 * missing fields all resolve to null — this function never throws. Callers
 * MUST treat null as "no participation data this cycle" and proceed with the
 * decision unaffected; this data is never load-bearing.
 */
export async function fetchHlSnapshot(internalSymbol: string): Promise<HlSnapshot | null> {
  const hlSymbol = mapToHlSymbol(internalSymbol);
  if (!hlSymbol) return null;
  try {
    const byCoin = await fetchWholeUniverse();
    if (!byCoin) return null;
    const ctx = byCoin.get(hlSymbol);
    if (!ctx) return null;
    const openInterest = parseFiniteNumber(ctx.openInterest);
    const volume24h = parseFiniteNumber(ctx.dayNtlVlm);
    const fundingRate = parseFiniteNumber(ctx.funding);
    const markPrice = parseFiniteNumber(ctx.markPx);
    const oraclePrice = parseFiniteNumber(ctx.oraclePx);
    const premium = parseFiniteNumber(ctx.premium);
    if (
      openInterest === null ||
      volume24h === null ||
      fundingRate === null ||
      markPrice === null ||
      oraclePrice === null ||
      premium === null
    ) {
      return null;
    }
    return { openInterest, volume24h, fundingRate, markPrice, oraclePrice, premium };
  } catch {
    return null;
  }
}

// Rolling per-market history of the last HL_HISTORY_WINDOW snapshots, oldest
// first. In-memory only (module-level Map) — an MVP tradeoff, not a
// database: a server restart drops all history, and deltas read as null/
// "unknown" until the window rebuilds. AI Trader's fastest cadence is 15m,
// so a fresh process rebuilds a useful few-reading window within 30-45
// minutes and a full 12-reading window within ~3 hours.
const history = new Map<string, HlSnapshot[]>();

function recordSnapshot(hlSymbol: string, snapshot: HlSnapshot): HlSnapshot[] {
  const existing = history.get(hlSymbol) ?? [];
  const updated = [...existing, snapshot].slice(-HL_HISTORY_WINDOW);
  history.set(hlSymbol, updated);
  return updated;
}

function pctChange(from: number, to: number): number | null {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return ((to - from) / Math.abs(from)) * 100;
}

function volumeTrendFrom(window: HlSnapshot[]): HlVolumeTrend {
  if (window.length < 2) return "unknown";
  const delta = pctChange(window[0].volume24h, window[window.length - 1].volume24h);
  if (delta === null) return "unknown";
  if (delta > 2) return "rising";
  if (delta < -2) return "falling";
  return "flat";
}

/**
 * Delta-enriched participation snapshot for one internal market symbol — this
 * is what context-builder.ts renders into the prompt. Fetches (or reuses the
 * cached) current Hyperliquid snapshot, appends it to that market's rolling
 * history, and derives OI/volume/funding trends from that history:
 *  - openInterestDeltaPct: vs. the immediately preceding reading.
 *  - openInterestDeltaPctWindow: vs. the oldest reading in the up-to-12-entry
 *    window held BEFORE this call's reading is added (i.e. how far OI has
 *    moved across roughly the stored window).
 *  - volumeTrend: rising/falling/flat (>2%/<-2%/else) across the stored
 *    window, oldest vs. newest; "unknown" with fewer than 2 readings.
 *  - fundingTrajectory: up to the last 3 funding readings, oldest first,
 *    including this cycle's.
 * Resolves to null under the exact same conditions as fetchHlSnapshot
 * (unknown symbol, timeout, network error, malformed/missing data) —
 * callers render the fixed "unavailable this cycle" line and proceed.
 */
export async function getHlParticipationSnapshot(
  internalSymbol: string
): Promise<HlParticipationSnapshot | null> {
  const hlSymbol = mapToHlSymbol(internalSymbol);
  if (!hlSymbol) return null;
  const snapshot = await fetchHlSnapshot(internalSymbol);
  if (!snapshot) return null;

  const priorWindow = history.get(hlSymbol) ?? [];
  const previous = priorWindow.length > 0 ? priorWindow[priorWindow.length - 1] : null;
  const oldestInWindow = priorWindow.length > 0 ? priorWindow[0] : null;
  const updatedWindow = recordSnapshot(hlSymbol, snapshot);

  const openInterestDeltaPct = previous ? pctChange(previous.openInterest, snapshot.openInterest) : null;
  const openInterestDeltaPctWindow = oldestInWindow
    ? pctChange(oldestInWindow.openInterest, snapshot.openInterest)
    : null;
  const volumeTrend = volumeTrendFrom(updatedWindow);
  const fundingTrajectory = updatedWindow.slice(-3).map((s) => s.fundingRate);

  return {
    ...snapshot,
    hlSymbol,
    openInterestDeltaPct,
    openInterestDeltaPctWindow,
    volumeTrend,
    fundingTrajectory,
  };
}
