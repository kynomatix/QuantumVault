/**
 * Vaults yield oracle (Phase 1).
 *
 * Reports a REAL, MEASURED net APY per yield asset for DISPLAY, replacing the
 * static marketing `apyLabel` strings. The number is measured, never projected.
 *
 * APY SOURCE (per asset), in priority order:
 *   1. DeFiLlama yields index (PRIMARY, instant) — for assets carrying a
 *      `defiLlamaPoolId`. DeFiLlama has already measured the pool's realized APY, so
 *      we serve a real number immediately instead of waiting 12h–14d to accumulate
 *      our own price history. Headline = the trailing 30-day mean when the pool has
 *      no incentive-token rewards, else the base yield (the part actually reflected in
 *      the token's USDC value — incentive rewards a passive holder may not realize are
 *      excluded). Persisted to the yield_apy_cache table as last-good.
 *   2. DB last-good (`defillama_cached`) — if DeFiLlama is briefly unreachable, the
 *      last persisted number is served (while fresh, < STALE_MS) so the UI never
 *      regresses to an estimate during a transient outage.
 *   3. Self-measured trailing series (FALLBACK + sole source for assets DeFiLlama
 *      does not cover, e.g. Perena USD*): the oracle samples the asset's own on-chain
 *      USDC price over time and annualizes the realized movement. The price source is
 *      a published single-source NAV oracle when the asset carries a `navOracleFeed`
 *      (the protocol's EXACT NAV, e.g. Perena USD* via Switchboard — clean series, so
 *      a ~3d window), else the money-path valuation: a redemption_rate (clean accrual)
 *      needs ~12h, a market_quote (spread/impact noise) needs >=14d before a number
 *      shows. The APY is annualized over the full retained span (oldest→newest).
 *
 * MONEY-SAFETY CONTRACT (display-only, but the same discipline):
 *   - Measured numbers only. DeFiLlama reports realized pool APY; the self-measured
 *     path uses the same on-chain routes/quotes used for money.
 *   - The oracle itself NEVER fabricates or projects a number. When DeFiLlama has no
 *     entry, the cache is stale, the self-measured window is too short, or a value is
 *     anomalous, the entry's `apy` is null and `method` says why ("accruing" /
 *     "unavailable"). It is the CALLER's job to decide the fallback.
 *   - DISPLAY FALLBACK (owner-approved): until `apy` is a real measured number, the UI
 *     shows the asset's estimated RANGE (`apyLabel`) but ALWAYS clearly marked "est."
 *     (e.g. "~4-9% est." / caption "Est. APY"), so an estimate is never mistaken for
 *     the measured figure. The moment a real `apy` exists, it replaces the estimate.
 *   - Never throws. Any per-asset error degrades that one asset to "unavailable".
 *
 * LAZY, NON-BLOCKING (owner requirement: no background pollers):
 *   - getYieldTableCached() NEVER awaits external calls. It returns the in-memory
 *     cache immediately and triggers a single in-flight async refresh only when the
 *     cache is missing/stale. Numbers appear on a later read.
 *   - Refreshes are SLOW-POLLED: a built table is served for CACHE_TTL_MS (~6h)
 *     before the next read triggers a refresh. There is NO background timer — a
 *     refresh only ever runs when someone actually loads the vault assets endpoint.
 *   - INSTANT ON BOOT: warmYieldTableFromCache() (called once at startup) seeds the
 *     in-memory cache from the persisted last-good rows, with NO external call, so
 *     the very first read returns real numbers immediately instead of blanking out
 *     to the estimate for a few seconds. The first read still triggers a live
 *     refresh to upgrade the warmed last-good values to fresh DeFiLlama numbers.
 */

import { getEnabledYieldAssets, type YieldAsset } from "./yield-assets";
import { getYieldRoute, VAULT_MAX_PRICE_IMPACT } from "./yield-routes";
import { fetchDefiLlamaApy, type LlamaApy } from "./defillama-apy";
import { fetchSwitchboardFeedPrice } from "./switchboard-oracle";
import { getBestQuote } from "../swap/index.js";
import { USDC_MINT } from "../agent-wallet";
import { storage } from "../storage";
import type { YieldApyCache } from "@shared/schema";

/** How an asset's `apy` was derived (or why it is null). */
export type YieldApyMethod =
  | "defillama" // a real measured number from the DeFiLlama yields index (live)
  | "defillama_cached" // last-good DeFiLlama number from the DB (upstream briefly down)
  | "trailing" // a real realized number self-measured from our own price series
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

/** Serve the cached table for this long before the next read triggers a refresh.
 *  ~6h = slow-polled (owner: "every six hours is plenty"); APYs barely move and a
 *  read still serves the (stale) cache instantly while the refresh runs. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
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
/**
 * Min trailing window for an asset priced by a published single-source NAV oracle
 * (navOracleFeed). The feed reports the exact NAV (stdev 0), so the series is clean
 * like a redemption rate, but the actual APY is annualized over the FULL retained
 * span (oldest→newest, up to RETENTION_MS), so this is only the gate before any
 * number is shown. 3 days smooths any intraday strategy-NAV wobble while staying
 * far more responsive than the 14d market-quote gate.
 */
const MIN_WINDOW_MS_NAV_ORACLE = 3 * 24 * 60 * 60 * 1000; // 3d
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
    // Published single-source NAV oracle (exact protocol NAV) takes precedence over
    // the valuation-based sampling. This is the asset's OWN authoritative USDC price
    // (e.g. Perena USD* via Switchboard), not a swap-quote proxy, so the series is
    // clean enough to annualize over a short window. fetchSwitchboardFeedPrice fails
    // soft (null) on any error / implausible value, so a bad read persists nothing.
    if (asset.navOracleFeed) {
      return await fetchSwitchboardFeedPrice(asset.navOracleFeed);
    }

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

/** Round a percent to one decimal place, preserving null. */
function round1(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 10) / 10;
}

/**
 * Pick the honest headline APY from a DeFiLlama pool record. The number must
 * reflect what a passive holder's parked balance actually grows by (the asset's
 * USDC value), so incentive-token rewards (apyReward) are excluded:
 *   - reward-free pool: use the trailing 30-day mean (smoother, realized).
 *   - pool WITH rewards: use the base yield, since the 30-day mean folds in reward
 *     tokens that are NOT reflected in the receipt token's redemption value.
 * Returns null when no trustworthy component exists or the value is anomalous.
 */
function chooseHeadline(l: LlamaApy): number | null {
  const base = l.apyBase != null && Number.isFinite(l.apyBase) ? l.apyBase : null;
  const mean = l.apyMean30d != null && Number.isFinite(l.apyMean30d) ? l.apyMean30d : null;
  const reward = l.apyReward != null && Number.isFinite(l.apyReward) ? l.apyReward : 0;
  let v: number | null;
  if (reward <= 0.01 && mean != null && mean > 0) v = mean;
  else if (base != null) v = base;
  else if (mean != null && mean > 0) v = mean;
  else v = null;
  if (v == null || !Number.isFinite(v) || v < APY_MIN_PCT || v > APY_MAX_PCT) return null;
  return v;
}

/**
 * Compute an APY entry for one asset. Never throws; degrades to an honest status.
 *
 * For DeFiLlama-backed assets (those with a `defiLlamaPoolId`) it serves the live
 * measured number (persisting last-good), then the fresh DB cache, then
 * "unavailable" — and does NO self-sampling (saves a quote/RPC per build). For
 * uncovered assets it falls through to the self-measured trailing-series path.
 */
async function computeEntry(
  asset: YieldAsset,
  llama: LlamaApy | null,
  cached: YieldApyCache | null,
): Promise<YieldApyEntry> {
  // --- DeFiLlama-backed assets: instant real number, no self-sampling. ---
  if (asset.defiLlamaPoolId) {
    if (llama) {
      const headline = chooseHeadline(llama);
      if (headline != null) {
        // Persist last-good (best-effort) for cold-start / outage fallback.
        try {
          await storage.upsertYieldApyCache({
            assetKey: asset.key,
            apy: headline.toFixed(4),
            apyBase: llama.apyBase != null ? llama.apyBase.toFixed(4) : null,
            apyReward: llama.apyReward != null ? llama.apyReward.toFixed(4) : null,
            apyMean30d: llama.apyMean30d != null ? llama.apyMean30d.toFixed(4) : null,
            source: "defillama",
            poolId: asset.defiLlamaPoolId,
          });
        } catch {
          // persistence is best-effort
        }
        return {
          apy: round1(headline),
          apyBase: round1(llama.apyBase),
          apyReward: round1(llama.apyReward),
          method: "defillama",
          asOf: Date.now(),
        };
      }
    }
    // DeFiLlama missing/failed this build -> serve last-good DB cache while fresh.
    if (cached && cached.apy != null) {
      const asOfMs = new Date(cached.asOf).getTime();
      const apyNum = Number(cached.apy);
      if (Number.isFinite(asOfMs) && Number.isFinite(apyNum) && Date.now() - asOfMs < STALE_MS) {
        return {
          apy: round1(apyNum),
          apyBase: cached.apyBase != null ? round1(Number(cached.apyBase)) : null,
          apyReward: cached.apyReward != null ? round1(Number(cached.apyReward)) : null,
          method: "defillama_cached",
          asOf: asOfMs,
        };
      }
    }
    // No live data and no fresh cache: honest "unavailable" (UI shows est.).
    return unavailable();
  }

  // --- Self-measured path (assets DeFiLlama does not cover, e.g. Perena USD*). ---
  // A published single-source NAV oracle yields a clean series (exact NAV), so it
  // uses the short NAV-oracle gate regardless of the asset's money-path `valuation`.
  // Otherwise: a clean redemption rate needs only ~12h; a noisy market quote ~14d.
  const minWindowMs = asset.navOracleFeed
    ? MIN_WINDOW_MS_NAV_ORACLE
    : asset.valuation === "market_quote"
      ? MIN_WINDOW_MS_MARKET
      : MIN_WINDOW_MS_REDEMPTION;

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

/** Build the full table: resolve every enabled asset in parallel, then prune. */
async function buildTable(): Promise<YieldTable> {
  const assets = getEnabledYieldAssets();

  // PRIMARY source: one DeFiLlama fetch covering all mapped pools (best-effort).
  const poolIds = assets
    .map((a) => a.defiLlamaPoolId)
    .filter((p): p is string => typeof p === "string" && p.length > 0);
  let llama: Map<string, LlamaApy> = new Map();
  if (poolIds.length) {
    try {
      llama = await fetchDefiLlamaApy(poolIds);
    } catch {
      llama = new Map();
    }
  }

  // Last-good cache, for the fallback when DeFiLlama is briefly unreachable.
  const cacheByKey = new Map<string, YieldApyCache>();
  try {
    for (const row of await storage.getYieldApyCacheAll()) cacheByKey.set(row.assetKey, row);
  } catch {
    // ignore; assets simply lose the cached fallback this build
  }

  const entries = await Promise.allSettled(
    assets.map((a) =>
      computeEntry(
        a,
        a.defiLlamaPoolId ? llama.get(a.defiLlamaPoolId) ?? null : null,
        cacheByKey.get(a.key) ?? null,
      ),
    ),
  );
  const table: YieldTable = {};
  assets.forEach((a, i) => {
    const r = entries[i];
    table[a.key] = r.status === "fulfilled" ? r.value : unavailable();
  });

  // Bounded retention (best-effort) for the self-measured snapshot series.
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

/**
 * Warm the in-memory cache from the persisted last-good rows, with NO external
 * call, so the first read after a (re)start returns real numbers INSTANTLY
 * instead of blanking to the estimate for a few seconds while the first live
 * refresh runs. Best-effort and idempotent (no-op once the cache is populated).
 *
 * `builtAt` is left at 0 so the cache reads as already-stale: the first
 * getYieldTableCached() still kicks off a live DeFiLlama refresh to upgrade these
 * warmed `defillama_cached` values to fresh `defillama` numbers. Only seeds
 * entries whose persisted row is still fresh (< STALE_MS); anything older or
 * uncovered stays absent so the UI shows the estimate until a real number lands.
 * Call once at server startup.
 */
export async function warmYieldTableFromCache(): Promise<void> {
  if (cache) return; // already warmed/built this process
  const byKey = new Map<string, YieldApyCache>();
  try {
    for (const row of await storage.getYieldApyCacheAll()) byKey.set(row.assetKey, row);
  } catch {
    return; // best-effort; the lazy refresh will populate on the first read
  }
  if (!byKey.size) return;
  const now = Date.now();
  const table: YieldTable = {};
  for (const a of getEnabledYieldAssets()) {
    if (!a.defiLlamaPoolId) continue; // self-measured assets are never cached here
    const cached = byKey.get(a.key);
    if (!cached || cached.apy == null) continue;
    const asOfMs = new Date(cached.asOf).getTime();
    const apyNum = Number(cached.apy);
    if (!Number.isFinite(asOfMs) || !Number.isFinite(apyNum) || now - asOfMs >= STALE_MS) continue;
    table[a.key] = {
      apy: round1(apyNum),
      apyBase: cached.apyBase != null ? round1(Number(cached.apyBase)) : null,
      apyReward: cached.apyReward != null ? round1(Number(cached.apyReward)) : null,
      method: "defillama_cached",
      asOf: asOfMs,
    };
  }
  // Re-check the guard: a concurrent read may have built a fresh table meanwhile.
  if (!cache && Object.keys(table).length) cache = { table, builtAt: 0 };
}
