/**
 * Vaults yield oracle (Phase 1).
 *
 * Reports a REAL, REALIZED net APY per yield asset for DISPLAY, replacing the
 * static marketing `apyLabel` strings. The number is measured, never projected:
 * the oracle samples each asset's own on-chain USDC price over time and annualizes
 * the realized movement between two samples. There is no protocol "target"/"current"
 * rate involved — only what actually happened to the price.
 *
 * Price source per asset (driven by yield-assets.ts `valuation`):
 *   - redemption_rate (Kamino, Jupiter Lend): the on-chain redemption rate, read as
 *     the USDC value of a fixed REFERENCE token amount via the route's valueInUsdc().
 *     This is a clean monotonic accrual (no spread/impact noise), so a SHORT trailing
 *     window (~12h) already yields a trustworthy number.
 *   - market_quote (Perena USD*, ONyc, USDY): a FIXED $1,000 USDC->token buy quote,
 *     reduced to USDC-per-token. Swap quotes carry spread/impact noise, so this needs
 *     a LONG trailing window (>=14 days) before a number is shown.
 *
 * MONEY-SAFETY CONTRACT (display-only, but the same discipline):
 *   - On-chain truth only. The price comes from the same routes/quotes used for money.
 *   - The oracle itself NEVER fabricates or projects a number. When the window is too
 *     short, the source is stale, or the value is anomalous, the entry's `apy` is null
 *     and `method` says why ("accruing" / "unavailable"). It is the CALLER's job to
 *     decide the fallback.
 *   - DISPLAY FALLBACK (owner-approved): until `apy` is a real measured number, the UI
 *     shows the asset's estimated RANGE (`apyLabel`) but ALWAYS clearly marked "est."
 *     (e.g. "~4-9% est." / caption "Est. APY"), so an estimate is never mistaken for
 *     the measured figure. The moment a real `apy` exists, it replaces the estimate.
 *   - Never throws. Any per-asset error degrades that one asset to "unavailable".
 *
 * LAZY, NON-BLOCKING (owner requirement: no background pollers):
 *   - getYieldTableCached() NEVER awaits external calls. It returns the in-memory
 *     cache immediately (or {} on a cold process) and triggers a single in-flight
 *     async refresh when the cache is missing/stale. Numbers appear on a later read.
 *   - Refreshes only happen when someone actually loads the vault assets endpoint.
 */

import { getEnabledYieldAssets, type YieldAsset } from "./yield-assets";
import { getYieldRoute, VAULT_MAX_PRICE_IMPACT } from "./yield-routes";
import { getBestQuote } from "../swap/index.js";
import { USDC_MINT } from "../agent-wallet";
import { storage } from "../storage";

/** How an asset's `apy` was derived (or why it is null). */
export type YieldApyMethod =
  | "trailing" // a real realized number computed from the price series
  | "accruing" // not enough trailing data yet (window too short) -> "rate building"
  | "unavailable"; // source stale / anomalous / errored -> "rate unavailable"

export interface YieldApyEntry {
  /** Realized net APY as a PERCENT (e.g. 7.4 = 7.4%), or null when not shown. */
  apy: number | null;
  /** Base (pre-reward) component, percent. Currently equal to `apy` (no reward split). */
  apyBase: number | null;
  /** Reward component, percent. Reserved for future reward-bearing assets. */
  apyReward: number | null;
  method: YieldApyMethod;
  /** ms epoch of the freshest sample backing this entry, or null. */
  asOf: number | null;
}

export type YieldTable = Record<string, YieldApyEntry>;

// --- Tuning constants. ---

/** Serve the cached table for this long before a refresh is triggered. */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** Reference USDC notional for market_quote price samples (raw 6dp base units). */
const QUOTE_NOTIONAL_USDC_RAW = BigInt(1_000) * BigInt(1_000_000); // $1,000
/** Slippage hint for the (non-executed) valuation quote. */
const QUOTE_SLIPPAGE_BPS = 100;
/** Reference whole-token count for redemption_rate price samples. */
const REDEMPTION_REFERENCE_WHOLE_TOKENS = 1_000_000;
/** Min trailing window for a clean redemption-rate series before a number is shown. */
const MIN_WINDOW_MS_REDEMPTION = 12 * 60 * 60 * 1000; // 12h
/** Min trailing window for a noisy market-quote series before a number is shown. */
const MIN_WINDOW_MS_MARKET = 14 * 24 * 60 * 60 * 1000; // 14d
/** If even the freshest sample is older than this, the series is stale -> unavailable. */
const STALE_MS = 48 * 60 * 60 * 1000; // 48h
/** Retention: prune samples older than this on each build. */
const RETENTION_MS = 35 * 24 * 60 * 60 * 1000; // 35d
/** Sanity band for a realized APY (percent). Outside -> anomaly -> unavailable. */
const APY_MIN_PCT = -50;
const APY_MAX_PCT = 60;

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

// --- In-memory cache + single-flight guard (per process). ---
let cache: { table: YieldTable; builtAt: number } | null = null;
let refreshInFlight: Promise<void> | null = null;

const unavailable = (asOf: number | null = null): YieldApyEntry => ({
  apy: null,
  apyBase: null,
  apyReward: null,
  method: "unavailable",
  asOf,
});
const accruing = (asOf: number | null = null): YieldApyEntry => ({
  apy: null,
  apyBase: null,
  apyReward: null,
  method: "accruing",
  asOf,
});

/**
 * Sample the current USDC-per-whole-token price for an asset, or null when no
 * trustworthy quote/rate is available right now (so we never persist a bad point).
 */
async function samplePrice(asset: YieldAsset): Promise<number | null> {
  try {
    if (asset.valuation === "market_quote") {
      // Fixed-notional buy quote: $1,000 USDC -> token. price = 1000 / tokensOut.
      const q = await getBestQuote({
        inputMint: USDC_MINT,
        outputMint: asset.mint,
        amountRaw: QUOTE_NOTIONAL_USDC_RAW.toString(),
        slippageBps: QUOTE_SLIPPAGE_BPS,
      });
      if (!q || !q.outAmountRaw) return null;
      // Reject distorted/unverifiable samples. A thin or liquidity-impaired route
      // would persist a wrong price that later surfaces a plausible-but-false APY
      // (the broad clamp would not catch it). Mirror the money path's impact gate
      // (yield-routes quoteWithCap): fail closed on null/non-finite/over-cap impact
      // so the asset's `apy` honestly stays null instead of persisting a bad price.
      const impact = q.priceImpactPct;
      if (impact == null || !Number.isFinite(impact) || impact > VAULT_MAX_PRICE_IMPACT) return null;
      const tokensOut = Number(BigInt(q.outAmountRaw)) / Math.pow(10, asset.decimals);
      if (!(tokensOut > 0)) return null;
      const price = 1000 / tokensOut;
      return Number.isFinite(price) && price > 0 ? price : null;
    }

    // redemption_rate: USDC value of a fixed reference token amount via the route.
    const route = getYieldRoute(asset);
    const referenceRaw = BigInt(REDEMPTION_REFERENCE_WHOLE_TOKENS) * BigInt(10) ** BigInt(asset.decimals);
    const val = await route.valueInUsdc(referenceRaw);
    if (!val || val.valueUsdcRaw == null) return null;
    const usdc = Number(BigInt(val.valueUsdcRaw)) / 1e6; // USDC is 6dp
    const price = usdc / REDEMPTION_REFERENCE_WHOLE_TOKENS;
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

/**
 * Compute a realized APY entry for one asset from its persisted price series plus
 * a freshly-sampled point. Never throws; degrades to an honest status entry.
 */
async function computeEntry(asset: YieldAsset): Promise<YieldApyEntry> {
  const minWindowMs =
    asset.valuation === "market_quote" ? MIN_WINDOW_MS_MARKET : MIN_WINDOW_MS_REDEMPTION;

  // Persist a fresh sample (best-effort) so the series keeps growing on each build.
  const now = Date.now();
  const fresh = await samplePrice(asset);
  if (fresh != null) {
    try {
      await storage.insertYieldPriceSnapshot({
        assetKey: asset.key,
        priceUsdcPerToken: fresh.toFixed(12),
      });
    } catch {
      // Persisting is best-effort; fall back to whatever is already stored.
    }
  }

  // Read the trailing series (oldest first) within retention.
  let series: { price: number; t: number }[] = [];
  try {
    const since = new Date(now - RETENTION_MS);
    const rows = await storage.getYieldPriceSnapshots(asset.key, since);
    series = rows
      .map((r) => ({ price: Number(r.priceUsdcPerToken), t: new Date(r.asOf).getTime() }))
      .filter((p) => Number.isFinite(p.price) && p.price > 0 && Number.isFinite(p.t));
  } catch {
    return unavailable();
  }

  if (series.length < 2) return accruing(series.length ? series[series.length - 1].t : null);

  const newest = series[series.length - 1];
  const oldest = series[0];

  // Stale: even the freshest sample is too old to trust.
  if (now - newest.t > STALE_MS) return unavailable(newest.t);

  const windowMs = newest.t - oldest.t;
  if (windowMs < minWindowMs) return accruing(newest.t);

  // Annualize the realized price movement over the actual elapsed time.
  const growth = newest.price / oldest.price;
  if (!(growth > 0) || !Number.isFinite(growth)) return unavailable(newest.t);
  const years = windowMs / MS_PER_YEAR;
  if (!(years > 0)) return unavailable(newest.t);

  const apyPct = (Math.pow(growth, 1 / years) - 1) * 100;
  if (!Number.isFinite(apyPct) || apyPct < APY_MIN_PCT || apyPct > APY_MAX_PCT) {
    return unavailable(newest.t);
  }

  const rounded = Math.round(apyPct * 10) / 10;
  return { apy: rounded, apyBase: rounded, apyReward: null, method: "trailing", asOf: newest.t };
}

/** Build the full table: sample + compute every enabled asset in parallel, then prune. */
async function buildTable(): Promise<YieldTable> {
  const assets = getEnabledYieldAssets();
  const entries = await Promise.allSettled(assets.map((a) => computeEntry(a)));
  const table: YieldTable = {};
  assets.forEach((a, i) => {
    const r = entries[i];
    table[a.key] = r.status === "fulfilled" ? r.value : unavailable();
  });

  // Bounded retention (best-effort).
  try {
    await storage.pruneYieldPriceSnapshots(new Date(Date.now() - RETENTION_MS));
  } catch {
    // ignore prune failures
  }

  return table;
}

/** Run a refresh, guarded so only one runs at a time. Swallows errors. */
function triggerRefresh(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const table = await buildTable();
      cache = { table, builtAt: Date.now() };
    } catch {
      // Leave the previous cache in place; a later read will retry.
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/**
 * Returns the current yield table WITHOUT blocking on any external call.
 *
 * - Fresh cache  -> returned as-is.
 * - Stale cache  -> returned immediately; an async refresh is kicked off.
 * - Cold process -> returns {} immediately and kicks off the first refresh; the
 *   numbers appear on a subsequent read (the client refetches).
 */
export function getYieldTableCached(): YieldTable {
  const now = Date.now();
  if (cache && now - cache.builtAt < CACHE_TTL_MS) return cache.table;
  void triggerRefresh();
  return cache?.table ?? {};
}

/** Test/diagnostic helper: force a synchronous (awaited) refresh. */
export async function refreshYieldTableNow(): Promise<YieldTable> {
  await triggerRefresh();
  return cache?.table ?? {};
}
