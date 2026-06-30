/**
 * CARRY-TRADE ADVISOR — pure best-yield RANKER (P2, slice 2).
 *
 * Ranks the ENABLED vault yield destinations by their REAL, measured APY so the
 * Carry-Trade Advisor can recommend the single highest one (Lulo-like).
 *
 * DESIGN CONTRACT (keep it testable + money-safe):
 *   - PURE. No I/O: it is fed an already-read YieldTable (from the non-blocking
 *     getYieldTableCached) + the enabled-asset registry, and returns a ranking.
 *   - MEASURED-ONLY. A money recommendation may ONLY rank an asset whose APY was
 *     actually MEASURED — method `defillama` / `defillama_cached` / `trailing`
 *     with a finite number. The `apyLabel` marketing string (e.g. "~10%") is
 *     NEVER used for advice. An asset that is still self-measuring (Perena USD*
 *     in its 14d window → `accruing`), or whose oracle is `unavailable`, or that
 *     has no table entry yet (cold cache), is EXCLUDED with a reason — never
 *     guessed at and never ranked off its label.
 *   - DETERMINISTIC. Ties (equal APY) break by asset key so the ranking is stable.
 */

import type { YieldAsset, YieldRiskClass } from "./yield-assets";
import type { YieldTable } from "./yield-oracle";

/** Oracle methods that carry a REAL, measured APY usable for money advice. */
const MEASURED_METHODS = new Set(["defillama", "defillama_cached", "trailing"]);

/** Why an enabled asset could not be ranked (never recommendable right now). */
export type YieldExclusionReason =
  | "no_data" // no table entry yet (cold cache) — nothing measured
  | "accruing" // still self-measuring (e.g. Perena's 14d window) — no real APY yet
  | "unavailable"; // oracle could not produce a measured APY

/** A measured, rankable yield destination. APY is a PERCENT (e.g. 8.2 = 8.2%). */
export interface RankedYieldDestination {
  assetKey: string;
  displayName: string;
  /** Measured APY, PERCENT. Always finite (unmeasured assets are excluded). */
  apyPct: number;
  /** How the APY was measured (one of the MEASURED_METHODS). */
  method: string;
  /** Epoch ms the APY was measured/served, when the table provides it. */
  asOf: number | null;
  /** Display risk tier for the UI chip. */
  riskClass: YieldRiskClass;
  /** True only for assets that can genuinely lose principal (drives a warning). */
  mayLoseValue: boolean;
}

/** An enabled asset that could NOT be ranked, with a machine reason. */
export interface ExcludedYieldDestination {
  assetKey: string;
  displayName: string;
  reason: YieldExclusionReason;
}

export interface RankedYieldResult {
  /** Measured destinations, best APY first (deterministic tie-break by key). */
  ranked: RankedYieldDestination[];
  /** Enabled assets that are not recommendable right now, with reasons. */
  excluded: ExcludedYieldDestination[];
}

const isFiniteNum = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);

/**
 * Rank the enabled yield destinations by measured APY. PURE.
 *
 * @param yieldTable  Already-read table from getYieldTableCached() (may be {} on
 *                    a cold cache — every asset then falls to `no_data`).
 * @param enabledAssets  The candidate set (getEnabledYieldAssets()).
 */
export function rankMeasuredYieldDestinations(
  yieldTable: YieldTable,
  enabledAssets: YieldAsset[],
): RankedYieldResult {
  const ranked: RankedYieldDestination[] = [];
  const excluded: ExcludedYieldDestination[] = [];

  for (const asset of enabledAssets) {
    const entry = yieldTable[asset.key];
    if (!entry) {
      excluded.push({ assetKey: asset.key, displayName: asset.displayName, reason: "no_data" });
      continue;
    }

    const measured = MEASURED_METHODS.has(entry.method) && isFiniteNum(entry.apy);
    if (!measured) {
      // accruing (self-measuring window not filled) vs unavailable (oracle gave
      // nothing) vs a measured-method row that nonetheless has a null APY.
      const reason: YieldExclusionReason =
        entry.method === "accruing"
          ? "accruing"
          : entry.method === "unavailable"
            ? "unavailable"
            : "unavailable";
      excluded.push({ assetKey: asset.key, displayName: asset.displayName, reason });
      continue;
    }

    ranked.push({
      assetKey: asset.key,
      displayName: asset.displayName,
      apyPct: entry.apy as number,
      method: entry.method,
      asOf: isFiniteNum(entry.asOf) ? entry.asOf : null,
      riskClass: asset.riskClass,
      mayLoseValue: asset.mayLoseValue,
    });
  }

  ranked.sort((a, b) => (b.apyPct - a.apyPct) || (a.assetKey < b.assetKey ? -1 : a.assetKey > b.assetKey ? 1 : 0));

  return { ranked, excluded };
}
