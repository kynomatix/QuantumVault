/**
 * COLLATERAL STAKING-APY SOURCE (Part A — display-only "yield bracket").
 *
 * Surfaces each yield-bearing borrow COLLATERAL's own native staking APY (e.g. the
 * SOL staking yield an INF / JitoSOL / mSOL holder earns just by holding it) so the
 * lending UI can show a small badge next to the deposited amount. This is purely
 * INFORMATIONAL — it is NEVER a money gate, never sizes a trade, and a missing value
 * simply means no badge.
 *
 * SOURCE: DeFiLlama liquid-staking pools (the same fail-soft fetcher the vault yield
 * oracle uses). We read `apyBase` — the yield reflected in the LST's redemption value,
 * i.e. what a holder actually realizes — and ignore reward-token incentives a plain
 * holder would not capture.
 *
 * REGISTRY IS KEYED BY MINT, NOT SYMBOL. Symbols re-case / collide across venues; the
 * on-chain mint is the only stable join key. Each mint below is the SAME address the
 * borrow oracle registry verified for that collateral.
 *
 * NON-BLOCKING (stale-while-revalidate): the DeFiLlama /pools index is ~10MB, so a
 * read path must NEVER synchronously await it. Reads serve the in-memory cache (or
 * null when cold) and kick off a single de-duped background refresh when the cache
 * is stale. There is no background poller — refresh is triggered only by reads.
 */

import { fetchDefiLlamaApy } from "./defillama-apy";

interface CollateralApyEntry {
  /** DeFiLlama pool id for this collateral's liquid-staking pool. */
  poolId: string;
  /** Human label (matches the collateral ticker) — for logs/diagnostics only. */
  label: string;
}

/**
 * Yield-bearing collateral → its DeFiLlama liquid-staking pool. Keyed by MINT.
 *
 * Only the launch-allowlisted, mint-VERIFIED yield collaterals are wired (mints match
 * the borrow oracle registry). Non-yield collaterals (SOL, BTC variants, JUP, xStocks)
 * and yield assets with no clean keyless native pool (JLP, syrupUSDC) are intentionally
 * ABSENT → they get no badge.
 *
 * Forward-compat (NOT wired — not on the collateral allowlist, so they never reach this
 * map; listed so a future allowlist addition has its verified pool id ready):
 *   jupSOL → jupiter-staked-sol   52bd72a7-9e81-4112-abb4-71673e8de9bf
 *   bSOL   → blazestake           387d6732-59f0-4ae0-8a88-aba75a5cbe4a
 *   hSOL   → helius-staked-sol    d7e101d6-8e6c-4348-9c5f-62398872a301
 *   vSOL   → the-vault-liquid-staking 8b46fdde-a5e4-4574-9926-6ba8047f4fca
 */
const COLLATERAL_APY_REGISTRY: Record<string, CollateralApyEntry> = {
  // INF (Sanctum Infinity) — sanctum-infinity.
  "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm": {
    poolId: "3075a746-bdd1-4aac-bcd5-b035abee2622",
    label: "INF",
  },
  // JitoSOL (Jito) — jito-liquid-staking.
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: {
    poolId: "0e7d0722-9054-4907-8593-567b353c0900",
    label: "JitoSOL",
  },
  // mSOL (Marinade) — marinade-liquid-staking.
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: {
    poolId: "b3f93865-5ec8-4662-90a0-11808e0aa2bd",
    label: "mSOL",
  },
};

const TTL_MS = 30 * 60 * 1000; // 30 min — LST APYs move slowly; display-only.

let cache: Map<string, number> | null = null; // mint -> staking APY (PERCENT)
let cacheAt = 0;
let inflight: Promise<void> | null = null;

function isStale(): boolean {
  return cache === null || Date.now() - cacheAt > TTL_MS;
}

/** Single de-duped background refresh. Fail-soft: a transient empty/failed feed never
 * wipes a good last-known map. Never throws. */
function refresh(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const poolIds = Object.values(COLLATERAL_APY_REGISTRY).map((e) => e.poolId);
      const llama = await fetchDefiLlamaApy(poolIds);
      const next = new Map<string, number>();
      for (const [mint, entry] of Object.entries(COLLATERAL_APY_REGISTRY)) {
        const row = llama.get(entry.poolId);
        // Prefer apyBase (reflected in the LST's redemption value — what a holder
        // actually realizes); fall back to total apy only if base is absent.
        const apy = row ? (row.apyBase ?? row.apy) : null;
        if (typeof apy === "number" && Number.isFinite(apy) && apy >= 0) {
          next.set(mint, apy);
        }
      }
      if (next.size > 0) {
        cache = next;
        cacheAt = Date.now();
      } else if (cache === null) {
        // First fetch returned nothing measurable: mark attempted (empty) so reads
        // don't hammer the 10MB endpoint; a later read still retries after the TTL.
        cache = new Map();
        cacheAt = Date.now();
      }
    } catch {
      // fail soft — display-only, leave the last-known cache intact.
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Staking APY (PERCENT) for ONE collateral mint, or null when the mint is not a
 * registered yield-bearing collateral OR no measured APY is cached yet. NEVER blocks
 * on the network. Display-only.
 */
export function getCollateralStakingApyByMint(mint: string): number | null {
  if (isStale()) void refresh(); // fire-and-forget; serve what we have now
  if (!cache) return null;
  return cache.get(mint) ?? null;
}

/**
 * Bulk variant: maps each requested mint to its cached staking APY (or null). Triggers
 * the same non-blocking background refresh. Display-only.
 */
export function getCollateralStakingApyMap(mints: string[]): Map<string, number | null> {
  if (isStale()) void refresh();
  const out = new Map<string, number | null>();
  for (const m of mints) out.set(m, cache?.get(m) ?? null);
  return out;
}
