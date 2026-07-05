/**
 * Fixed Yield vault — Exponent Finance market discovery + picker (Phase A).
 *
 * Exponent runs principal-token (PT) markets on Solana: deposit the underlying
 * yield asset, buy PT at a discount, PT redeems at par at maturity — a fixed
 * rate locked to a date. This module reads Exponent's public market API,
 * filters to markets we consider safe for the vault, and picks the best
 * fixed rate. It is READ-ONLY: no money paths here.
 *
 * Money-safety posture (architect-reviewed):
 * - The API is an OFF-CHAIN source. It may inform display and candidate
 *   selection, but any money path MUST re-verify the market on-chain
 *   (load by on-chain discriminator → mintPt + vault expiration match) before
 *   trading.
 * - Underlyings are a CURATED allowlist pinned BY MINT (never symbol lookup —
 *   scam-impersonator precedent). v1: ONyc only (mint already verified and
 *   Jupiter-swappable by the stablecoin vault).
 * - Fail closed: API down / shape drift ⇒ no picks. Existing positions are
 *   never affected (they render from DB + chain, not from this API).
 *
 * The picker is deliberately venue-shaped so RateX can slot in later as a
 * second venue without reworking callers.
 */

const EXPONENT_MARKETS_API = "https://api.exponent.finance/markets";

/**
 * Exponent's USD-denominated markets use pseudo "USD" quote mints (analogous
 * to native SOL's So111... placeholder). Pinned exactly; 6dp and 9dp variants.
 */
const USD_QUOTE_MINTS = new Set<string>([
  "USD1111111111111111111111111111111111111111", // "US Dollar" (6 decimals)
  "USD1111111111111111111111111111111111111119", // "US Dollar 9 Decimals"
]);

/** Curated underlying assets we are willing to hold PT on. Pinned by mint. */
export interface FixedYieldUnderlying {
  mint: string;
  symbol: string;
  decimals: number;
}

export const FIXED_YIELD_UNDERLYINGS: Record<string, FixedYieldUnderlying> = {
  // ONyc — OnRe yield note. Mint verified on-chain previously (deep Jupiter
  // liquidity both ways; already the stablecoin vault's park asset).
  "5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5": {
    mint: "5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5",
    symbol: "ONyc",
    decimals: 9,
  },
};

/** Picker policy floors/caps (architect-reviewed). */
const MIN_DAYS_TO_MATURITY = 7; // too close to maturity: not worth the swap costs
const MAX_DAYS_TO_MATURITY = 240; // don't lock absurdly far out (covers ~Sep maturity + margin)
const MIN_LIQUIDITY_NORMALIZED = 250_000; // in quote units (~USD for USD-quoted markets)
const MAX_SANE_IMPLIED_APY = 0.5; // >50% fixed on a curated stable underlying = something is wrong
const CACHE_TTL_MS = 10 * 60 * 1000;

/** Pinned subset of the API record we rely on. Anything missing ⇒ record skipped. */
export interface ExponentMarketView {
  /** AMM market address used for trading (MarketTwo/MarketThree — resolved on-chain by account discriminator). */
  marketAddress: string;
  /** Exponent core vault (strip/merge) address. */
  vaultAddress: string;
  ptMint: string;
  underlyingMint: string;
  underlyingSymbol: string;
  underlyingDecimals: number;
  /** Fixed rate if held to maturity (fraction, e.g. 0.1585 = 15.85%). */
  impliedApy: number;
  maturityTs: number; // unix seconds
  daysToMaturity: number;
  /** PT price in underlying-asset terms (display / sanity only — money paths re-quote). */
  ptPriceInAsset: number | null;
  liquidityNormalized: number;
  platformName: string | null;
}

/**
 * Unfiltered per-market quote for EXIT paths. A held position's market may be
 * excluded from the eligible list (too close to maturity, thin liquidity) but
 * we still need its live PT price to protect an early sale.
 */
export interface FixedYieldMarketQuote {
  marketAddress: string;
  ptMint: string | null;
  ptPriceInAsset: number | null;
  maturityTs: number | null;
  marketStatus: string | null;
}

interface MarketsCache {
  fetchedAt: number;
  markets: ExponentMarketView[];
  quotes: Record<string, FixedYieldMarketQuote>;
}

let cache: MarketsCache | null = null;
let inFlight: Promise<ExponentMarketView[]> | null = null;

function asFiniteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asNonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Parse one raw API record into a pinned view, or null if ineligible/malformed. */
function parseEligibleMarket(raw: any, nowSec: number): ExponentMarketView | null {
  if (!raw || typeof raw !== "object") return null;
  if (raw.marketStatus !== "active") return null;

  const quoteMint = asNonEmptyString(raw.quoteAsset?.mint);
  if (!quoteMint || !USD_QUOTE_MINTS.has(quoteMint)) return null;

  const underlyingMint = asNonEmptyString(raw.underlyingAsset?.mint);
  if (!underlyingMint) return null;
  const underlying = FIXED_YIELD_UNDERLYINGS[underlyingMint];
  if (!underlying) return null;

  const vaultAddress = asNonEmptyString(raw.vaultAddress);
  const ptMint = asNonEmptyString(raw.ptMint);
  const impliedApy = asFiniteNumber(raw.impliedApy);
  const maturityTs = asFiniteNumber(raw.maturityDateUnixTs);
  if (!vaultAddress || !ptMint || impliedApy === null || maturityTs === null) return null;

  // Trading venue: current liquidity lives either on the new CLMM ("liquidity")
  // or a legacy AMM ("legacyLiquidity" + legacyMarketAddresses). The legacy pool
  // may be a MarketTwo OR MarketThree account — the money path resolves the class
  // on-chain by discriminator. We trade wherever the API points via
  // legacyMarketAddresses for now and verify on-chain before any trade.
  const legacyMarkets: unknown[] = Array.isArray(raw.legacyMarketAddresses)
    ? raw.legacyMarketAddresses
    : [];
  const marketAddress = asNonEmptyString(legacyMarkets[0]);
  if (!marketAddress) return null;

  const decimals = asFiniteNumber(raw.decimals) ?? underlying.decimals;
  const liquidityRaw =
    (asFiniteNumber(raw.legacyLiquidity) ?? 0) + (asFiniteNumber(raw.liquidity) ?? 0);
  const liquidityNormalized = liquidityRaw / 10 ** decimals;

  const daysToMaturity = (maturityTs - nowSec) / 86_400;
  if (daysToMaturity < MIN_DAYS_TO_MATURITY || daysToMaturity > MAX_DAYS_TO_MATURITY) return null;
  if (impliedApy <= 0 || impliedApy > MAX_SANE_IMPLIED_APY) return null;
  if (liquidityNormalized < MIN_LIQUIDITY_NORMALIZED) return null;

  return {
    marketAddress,
    vaultAddress,
    ptMint,
    underlyingMint,
    underlyingSymbol: underlying.symbol,
    underlyingDecimals: underlying.decimals,
    impliedApy,
    maturityTs,
    daysToMaturity: Math.floor(daysToMaturity),
    ptPriceInAsset: asFiniteNumber(raw.ptPriceInAsset),
    liquidityNormalized,
    platformName: asNonEmptyString(raw.platformName),
  };
}

/**
 * Fetch + filter eligible markets. Cached 10 min; single-flight. Throws on
 * failure when no cache exists (callers surface "rate unavailable" — never a
 * made-up number).
 */
export async function getEligibleFixedYieldMarkets(): Promise<ExponentMarketView[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.markets;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const res = await fetch(EXPONENT_MARKETS_API, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Exponent markets API HTTP ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body)) throw new Error("Exponent markets API: unexpected shape");
      const nowSec = Math.floor(Date.now() / 1000);
      const markets: ExponentMarketView[] = [];
      const quotes: Record<string, FixedYieldMarketQuote> = {};
      for (const raw of body) {
        const parsed = parseEligibleMarket(raw, nowSec);
        if (parsed) markets.push(parsed);
        // Unfiltered quote map: keyed by every listed trading address so exit
        // paths can still price a market the eligibility filter now excludes.
        if (raw && typeof raw === "object") {
          const legacyMarkets: unknown[] = Array.isArray(raw.legacyMarketAddresses)
            ? raw.legacyMarketAddresses
            : [];
          for (const addr of legacyMarkets) {
            const a = asNonEmptyString(addr);
            if (!a) continue;
            quotes[a] = {
              marketAddress: a,
              ptMint: asNonEmptyString(raw.ptMint),
              ptPriceInAsset: asFiniteNumber(raw.ptPriceInAsset),
              maturityTs: asFiniteNumber(raw.maturityDateUnixTs),
              marketStatus: asNonEmptyString(raw.marketStatus),
            };
          }
        }
      }
      cache = { fetchedAt: Date.now(), markets, quotes };
      return markets;
    } catch (err) {
      // Stale-but-real beats fabricated: serve an expired cache on transient
      // API failure, otherwise fail closed.
      if (cache) return cache.markets;
      throw err;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Best eligible market = highest fixed rate. Null when none qualify. */
export async function pickBestFixedYieldMarket(): Promise<ExponentMarketView | null> {
  const markets = await getEligibleFixedYieldMarkets();
  if (markets.length === 0) return null;
  return markets.reduce((best, m) => (m.impliedApy > best.impliedApy ? m : best));
}

/**
 * Live UNFILTERED quote for one market (exit paths). Null when the API no
 * longer lists the market — the caller must fail closed, never invent a price.
 */
export async function getFixedYieldMarketQuote(
  marketAddress: string,
): Promise<FixedYieldMarketQuote | null> {
  await getEligibleFixedYieldMarkets(); // populates/refreshes the shared cache
  return cache?.quotes[marketAddress] ?? null;
}
