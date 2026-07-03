/**
 * SOL LOOP VAULT (qntSOL) — KEEPER RISK POLICY (vendored, P3).
 *
 * VENDORED from `docs/qntsol/keeper/src/policy.ts` (pristine reference; docs/
 * is gitignored, so THIS copy is the live code — plan §4.1). Deterministic
 * risk policy: the deleverage reflex and the oracle sanity band. Deterministic
 * on purpose — any LLM layer is advisory only and never reaches these code
 * paths with authority.
 *
 * Caller contracts (P3):
 *  - `decideDeleverage` expects a NUMERIC healthFactor. HOLD rows (zero debt,
 *    HF null) must NEVER be passed in — filter them out at the call site.
 *  - `evaluateOracle` gates ONLY risk-increasing paths (open / lever-up).
 *    Deleverage is always allowed regardless of the oracle verdict.
 */

import type { DeleverageDecision, PositionHealth, VenueState } from "./types";

export interface DeleveragePolicyParams {
  /** Start reducing when healthFactor falls below floor * this, e.g. 1.25. */
  healthReduceMultiple: number;
  /** Full unwind when healthFactor falls below floor * this, e.g. 1.10. */
  healthUnwindMultiple: number;
  /** Reduce when net carry falls below this, e.g. 0.005. Negative carry always reduces. */
  carryReduceApy: number;
  /** Fraction to shave per reduce action, e.g. 0.25. */
  reduceStep: number;
}

export function decideDeleverage(
  positions: PositionHealth[],
  states: Map<string, VenueState>,
  p: DeleveragePolicyParams,
): DeleverageDecision[] {
  if (p.healthUnwindMultiple >= p.healthReduceMultiple) {
    throw new Error("unwind multiple must be below reduce multiple");
  }
  const out: DeleverageDecision[] = [];
  for (const pos of positions) {
    const reduceAt = pos.liquidationFloor * p.healthReduceMultiple;
    const unwindAt = pos.liquidationFloor * p.healthUnwindMultiple;
    const st = states.get(pos.venue);

    if (pos.healthFactor <= unwindAt) {
      out.push({
        positionId: pos.positionId, venue: pos.venue,
        action: "unwind", fraction: 1,
        reason: `health ${pos.healthFactor.toFixed(3)} <= unwind bound ${unwindAt.toFixed(3)}`,
      });
      continue;
    }
    if (pos.healthFactor <= reduceAt) {
      out.push({
        positionId: pos.positionId, venue: pos.venue,
        action: "reduce", fraction: p.reduceStep,
        reason: `health ${pos.healthFactor.toFixed(3)} <= reduce bound ${reduceAt.toFixed(3)}`,
      });
      continue;
    }
    // Fixed rate positions do not bleed when spot rates spike; the spread is locked.
    if (st && !st.isFixedRate && st.netCarryApy < p.carryReduceApy) {
      out.push({
        positionId: pos.positionId, venue: pos.venue,
        action: "reduce", fraction: p.reduceStep,
        reason: `net carry ${(st.netCarryApy * 100).toFixed(2)}% below floor`,
      });
      continue;
    }
    out.push({ positionId: pos.positionId, venue: pos.venue, action: "none", fraction: 0, reason: "healthy" });
  }
  return out;
}

export interface OracleReading {
  source: "stakePool" | "sanctum" | "pythEma";
  /** LST fair value in SOL per LST token. */
  priceSol: number;
  /** Seconds since this source last updated. */
  ageSeconds: number;
}

export interface OraclePolicyParams {
  /** Max allowed age per source in seconds. */
  maxAgeSeconds: Record<OracleReading["source"], number>;
  /** Max fractional deviation of any cross check from the primary, e.g. 0.01. */
  sanityBand: number;
}

export type OracleVerdict =
  | { ok: true; markPriceSol: number }
  | { ok: false; reason: string };

/**
 * Stake pool exchange rate is the primary. Cross checks must sit inside the
 * band. Marking rule: min(primary fair value, freshest market cross check)
 * when the market prints below fair value, so a depeg marks down NAV.
 */
export function evaluateOracle(
  readings: OracleReading[],
  p: OraclePolicyParams,
): OracleVerdict {
  const fresh = readings.filter((r) => r.ageSeconds <= p.maxAgeSeconds[r.source]);
  const primary = fresh.find((r) => r.source === "stakePool");
  if (!primary) return { ok: false, reason: "primary stake pool reading missing or stale" };

  const crossChecks = fresh.filter((r) => r.source !== "stakePool");
  if (crossChecks.length === 0) {
    return { ok: false, reason: "no fresh cross check available" };
  }
  for (const c of crossChecks) {
    const dev = Math.abs(c.priceSol - primary.priceSol) / primary.priceSol;
    if (dev > p.sanityBand) {
      return { ok: false, reason: `${c.source} deviates ${(dev * 100).toFixed(2)}% from primary` };
    }
  }
  const lowestMarket = Math.min(...crossChecks.map((c) => c.priceSol));
  return { ok: true, markPriceSol: Math.min(primary.priceSol, lowestMarket) };
}
