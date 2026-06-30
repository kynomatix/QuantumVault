/**
 * Vaults: Switchboard On-Demand NAV oracle source.
 *
 * Some yield assets publish their EXACT USDC NAV (net asset value per whole token)
 * as an official Switchboard On-Demand price feed sourced from on-chain account
 * parsing — the protocol's OWN authoritative price, not a swap-quote proxy. Reading
 * that feed lets the yield oracle measure a real, exact realized APY from a clean
 * single-source price series, instead of annualizing a noisy market swap quote.
 *
 * We read the feed's current value through Switchboard's public Crossbar gateway
 * `/simulate` endpoint, which runs the feed's job definitions and returns the
 * freshly-computed result (no on-chain write, no RPC, no SDK). For a single-source
 * NAV feed this returns the exact value with stdev 0.
 *
 * Best-effort and FAIL-SOFT: any network error / timeout / unexpected shape /
 * implausible value returns null, and the caller simply persists no new price
 * sample this build (the existing trailing series is used). Display-only — this is
 * never on a money path. Never throws.
 *
 * VERIFY THE FEED PUBKEY against the protocol's own developer docs before wiring it
 * (see the `navOracleFeed` field in yield-assets.ts). Switchboard publishes both a
 * single-source feed (from on-chain account parsing = the exact NAV) and, for some
 * assets, a multi-source aggregate the docs warn can be manipulated — use the
 * single-source one for valuation.
 */

const CROSSBAR_BASE = "https://crossbar.switchboard.xyz/simulate/solana/mainnet";
const FETCH_TIMEOUT_MS = 12_000;

/**
 * Plausibility band for a USDC-denominated stablecoin NAV. A single bad/garbage
 * feed read would poison the trailing series for the whole retention window, so we
 * fail closed on anything outside this band. A USD-pegged yield stablecoin's NAV
 * starts at ~$1 and only accrues; this band stays valid for many years of growth
 * while still rejecting a zero / depeg-crash / malformed read.
 */
const NAV_PRICE_MIN = 0.5;
const NAV_PRICE_MAX = 10;

/**
 * Max allowed dispersion (stdev) for a feed we treat as an EXACT single-source NAV.
 * A true single-source feed (from on-chain account parsing) reports stdev exactly 0;
 * a multi-source aggregate (the kind Perena's docs warn can be manipulated) reports
 * a non-zero spread. If a wrong/aggregate feed pubkey is ever pasted by mistake, a
 * meaningful stdev rejects it rather than letting a manipulable price reach the
 * advisor's repay-vs-hold gate. Tiny epsilon tolerates float noise around 0. When
 * the response omits stdev we do not block (price-band is still the hard gate).
 */
const NAV_MAX_STDEV = 0.02;

const toNum = (x: unknown): number =>
  typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN;

/**
 * Pull the per-feed result row out of whatever envelope Crossbar returns. Tolerant
 * of: a top-level array `[{...}]`, an envelope `{ results: [...] }` / `{ data: [...] }`,
 * or a single bare object `{ result, ... }`. Returns null if no row is found.
 */
function extractFeedRow(body: unknown): Record<string, unknown> | null {
  const firstObj = (arr: unknown): Record<string, unknown> | null =>
    Array.isArray(arr) && arr[0] && typeof arr[0] === "object" ? (arr[0] as Record<string, unknown>) : null;
  if (Array.isArray(body)) return firstObj(body);
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    if (Array.isArray(o.results)) return firstObj(o.results);
    if (Array.isArray(o.data)) return firstObj(o.data);
    if ("result" in o) return o; // bare single-feed object
  }
  return null;
}

/**
 * Read the current value of a Switchboard On-Demand feed (Solana mainnet pubkey)
 * via the Crossbar `/simulate` gateway. Returns the numeric result, or null on any
 * failure / implausible value / non-single-source dispersion. Never throws.
 */
export async function fetchSwitchboardFeedPrice(feed: string): Promise<number | null> {
  if (typeof feed !== "string" || feed.length === 0) return null;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${CROSSBAR_BASE}/${feed}`, {
      signal: ac.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    // Crossbar returns per-feed results: [{ feed, result, stdev, variance, ... }].
    const row = extractFeedRow(body);
    if (!row) return null;

    const price = toNum(row.result);
    if (!Number.isFinite(price) || price < NAV_PRICE_MIN || price > NAV_PRICE_MAX) return null;

    // Single-source NAV invariant: when the feed reports dispersion, reject anything
    // beyond float noise so a mistakenly-wired multi-source aggregate cannot pass.
    const stdev = toNum(row.stdev);
    if (Number.isFinite(stdev) && Math.abs(stdev) > NAV_MAX_STDEV) return null;

    return price;
  } catch {
    // network / abort / parse error -> fail soft (null)
    return null;
  } finally {
    clearTimeout(timer);
  }
}
