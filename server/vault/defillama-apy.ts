/**
 * Vaults: DeFiLlama yields source.
 *
 * Pulls the REAL, already-measured APY for a known set of pools from DeFiLlama's
 * public yields index. This lets the yield oracle serve a real number instantly
 * instead of waiting 12h–14d to self-measure it from on-chain price snapshots.
 *
 * Best-effort and FAIL-SOFT: any network error / timeout / unexpected shape
 * returns an empty map, and the caller falls back to the DB cache (last-good) and
 * then to the self-measured path. Display-only — never on a money path.
 *
 * BANDWIDTH NOTE: /pools returns the entire index (~10MB). We fetch it at most once
 * per oracle refresh (5-min in-memory TTL, only triggered on read — no background
 * poller), extract the few pools we care about, and drop the rest so the large
 * payload is a short-lived transient. There is no smaller official endpoint that
 * also carries the 30-day mean we use.
 */

/** The realized-APY components DeFiLlama reports for a pool (percent, or null). */
export interface LlamaApy {
  /** Total current APY (base + reward). */
  apy: number | null;
  /** Base yield reflected in the token's USDC value (excludes incentive tokens). */
  apyBase: number | null;
  /** Incentive-token component (usually NOT reflected in a receipt token's value). */
  apyReward: number | null;
  /** Trailing 30-day mean of the total APY. */
  apyMean30d: number | null;
}

const POOLS_URL = "https://yields.llama.fi/pools";
const FETCH_TIMEOUT_MS = 20_000;

const num = (x: unknown): number | null =>
  typeof x === "number" && Number.isFinite(x) ? x : null;

/**
 * Fetch the latest APY for the given DeFiLlama pool ids. Returns a Map keyed by
 * pool id; ids that are missing from the feed (or on any failure) are simply
 * absent. Never throws.
 */
export async function fetchDefiLlamaApy(poolIds: string[]): Promise<Map<string, LlamaApy>> {
  const want = new Set(poolIds.filter((p) => typeof p === "string" && p.length > 0));
  const out = new Map<string, LlamaApy>();
  if (want.size === 0) return out;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(POOLS_URL, {
      signal: ac.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return out;
    const body = (await res.json()) as { data?: unknown };
    const rows = Array.isArray(body?.data) ? (body.data as any[]) : [];
    for (const p of rows) {
      const id = p?.pool;
      if (typeof id === "string" && want.has(id) && !out.has(id)) {
        out.set(id, {
          apy: num(p.apy),
          apyBase: num(p.apyBase),
          apyReward: num(p.apyReward),
          apyMean30d: num(p.apyMean30d),
        });
        if (out.size === want.size) break;
      }
    }
  } catch {
    // network / abort / parse error -> fail soft (empty map)
  } finally {
    clearTimeout(timer);
  }
  return out;
}
