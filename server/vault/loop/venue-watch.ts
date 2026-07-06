/**
 * CROSS-VENUE SOL BORROW WATCH — display-only telemetry.
 *
 * Samples the main SOL borrow market of venues we do NOT loop on yet, so the
 * owner's rates dialog can show what borrowing SOL costs elsewhere (Kamino,
 * Save, Loopscale, ...) next to our live Jupiter Lend vaults. This NEVER feeds
 * the picker, sizing, or any money path — the loop still only opens on
 * `LOOP_VAULT_ALLOWLIST` vaults.
 *
 * Identity discipline (same stance as LOOP_RATE_REGISTRY): every row is
 * pinned by DeFiLlama pool UUID, and the reading is REFUSED (nulled) unless
 * the row's underlying token is native SOL — never resolve by name/symbol.
 *
 * Not covered here: P0 / Project Zero (marginfi v2 rebrand) — DeFiLlama only
 * tracks their LST product, not a native-SOL borrow market. Needs direct SDK
 * integration (@0dotxyz/p0-ts-sdk) before it can be added.
 */

const SOL_MINT = "So11111111111111111111111111111111111111112";
const LEND_BORROW_URL = "https://yields.llama.fi/lendBorrow";
const FETCH_TIMEOUT_MS = 15_000;
const CACHE_MS = 10 * 60 * 1000;

interface VenueWatchEntry {
  /** Display name shown in the dialog. */
  venue: string;
  /** Pinned DeFiLlama pool UUID — the AUTHORITY for this row. */
  llamaPool: string;
  /**
   * Optional fixed note shown instead of the dynamic verdict when borrow-rate
   * data is unavailable (e.g. architecture mismatch, CF-gated API, etc.).
   */
  note?: string;
}

/**
 * Pinned from yields.llama.fi (main SOL market per venue).
 *
 * Loopscale (pinned 2026-07-06): pool 6b824912 is present in the DeFiLlama
 * pools API but absent from the lendBorrow API (no borrow-side data exposed).
 * Their API is also Cloudflare-protected with no public subdomain.
 * Shown as a fixed-note row so the table remains complete.
 */
const VENUE_WATCH_REGISTRY: readonly VenueWatchEntry[] = [
  { venue: "Kamino", llamaPool: "525b2dab-ea6a-4cbc-a07f-84ce561d1f83" },
  { venue: "Save",   llamaPool: "1170b465-309b-4026-b10d-abdf7b1ac369" },
  {
    venue: "Loopscale",
    llamaPool: "6b824912-fb93-469c-ab3c-8cdcf7bb13a8",
    note: "Fixed-rate order-book · borrow rate not publicly exposed",
  },
] as const;

export interface VenueSolBorrowReading {
  venue: string;
  /** SOL borrow APY as a FRACTION (0.05 = 5%); null = unreadable this sample. */
  borrowApy: number | null;
  /** Total supplied to the market (USD); null = unreadable. */
  supplyUsd: number | null;
  /** Utilization borrowed/supplied as a fraction; null = unreadable. */
  utilization: number | null;
  /** Max LTV the venue advertises for SOL collateral markets; null = unreadable. */
  maxLtv: number | null;
  asOf: string;
  /**
   * Fixed note for this venue (shown instead of dynamic verdict when borrow
   * data is unavailable, e.g. architecture mismatch or gated API).
   */
  note?: string;
}

const asFiniteOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

let cache: { at: number; rows: VenueSolBorrowReading[] } | null = null;

/**
 * Fetch (or serve cached, 10 min) readings for every registry venue.
 * Fail-soft: on upstream failure returns the stale cache if one exists, else
 * an empty array (client hides the section). Never throws. Bounded memory:
 * only the pinned rows are retained from the upstream payload.
 */
export async function getVenueSolBorrowRates(): Promise<VenueSolBorrowReading[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  try {
    const res = await fetch(LEND_BORROW_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`lendBorrow HTTP ${res.status}`);
    const all = (await res.json()) as any[];
    if (!Array.isArray(all)) throw new Error("lendBorrow payload not an array");

    const pinned = new Map<string, any>();
    for (const row of all) {
      if (row && typeof row.pool === "string" && VENUE_WATCH_REGISTRY.some((r) => r.llamaPool === row.pool)) {
        pinned.set(row.pool, row);
      }
    }

    const asOf = new Date().toISOString();
    const rows: VenueSolBorrowReading[] = VENUE_WATCH_REGISTRY.map((reg) => {
      const row = pinned.get(reg.llamaPool);
      // Identity check: the pinned pool must be a native-SOL market, or every
      // field reads null (refuse — the UUID now points at something else).
      const isSol =
        row &&
        Array.isArray(row.underlyingTokens) &&
        row.underlyingTokens.length === 1 &&
        row.underlyingTokens[0] === SOL_MINT;
      if (!isSol) {
        return { venue: reg.venue, borrowApy: null, supplyUsd: null, utilization: null, maxLtv: null, asOf, note: reg.note };
      }
      const borrowPct = asFiniteOrNull(row.apyBaseBorrow);
      const supplyUsd = asFiniteOrNull(row.totalSupplyUsd);
      const borrowUsd = asFiniteOrNull(row.totalBorrowUsd);
      return {
        venue: reg.venue,
        borrowApy: borrowPct !== null ? borrowPct / 100 : null,
        supplyUsd,
        utilization:
          supplyUsd !== null && supplyUsd > 0 && borrowUsd !== null ? borrowUsd / supplyUsd : null,
        maxLtv: asFiniteOrNull(row.ltv),
        asOf,
        note: reg.note,
      };
    });
    cache = { at: Date.now(), rows };
    return rows;
  } catch {
    return cache?.rows ?? [];
  }
}
