/**
 * CARRY-TRADE ADVISOR — pure DECISION ENGINE (P2, slice 3).
 *
 * Turns already-assembled facts (the measured best yield, the per-bot borrow
 * APR, the bot's live borrow health, and its open debt) into a SINGLE
 * recommendation: park the borrowed USDC into the best vault, repay the loan,
 * hold, or "can't safely advise". RECOMMEND-ONLY — it never moves money and
 * NEVER returns an executable amount (the park/repay endpoints re-gate and size
 * the move themselves; see the advisor route).
 *
 * DESIGN CONTRACT (keep it testable + money-safe):
 *   - PURE. No I/O: fed already-read facts, returns a decision. Deterministic.
 *   - HEALTH ALWAYS OVERRIDES CARRY. If we cannot read health, we do not advise
 *     (`unavailable`). If health is anything below `healthy` (nudge / urgent /
 *     liquidation), we recommend REPAY regardless of how good the spread looks.
 *   - THE SPREAD IS GROSS + FLOATING, NEVER RISK-FREE. We subtract a flat haircut
 *     (fees + rate staleness + the yield leg's own depeg/NAV/exit risk) and only
 *     recommend parking when the NET spread clears a minimum. A thin positive net
 *     spread is HOLD, not park.
 *   - FAIL CLOSED on every unreadable input (null/non-finite borrow APR, no
 *     measured yield) — never advise a money move off a guess or a stale number.
 */

import { BORROW_RISK_POLICY } from "./borrow-risk-policy";
import type { BotBorrowHealthSummary } from "./borrow-health";
import type { RankedYieldDestination } from "./carry-yield-ranker";

export type CarryTradeAction = "park" | "repay" | "hold" | "unavailable";

/** Machine-readable reason for the recommendation (drives UI copy). */
export type CarryTradeReason =
  | "park_positive_carry" // not parked + net spread clears the minimum → park to best vault
  | "hold_positive_carry" // ALREADY parked + net spread clears the minimum → keep funds where they are
  | "repay_negative_carry" // net spread at/below zero → paying interest for nothing
  | "repay_health_nudge" // health below healthy → de-risk by repaying
  | "repay_health_urgent"
  | "repay_health_liquidation"
  | "hold_thin_spread" // positive but under the minimum → not worth the round-trip
  | "hold_no_debt" // no open per-bot debt → nothing to carry
  | "hold_yield_unavailable" // not parked + no MEASURED vault yield → can't size a park safely
  | "hold_parked_yield_unavailable" // parked but the parked vault's yield is unmeasured → fail closed
  | "unavailable_health" // health unreadable → cannot advise (fail closed)
  | "unavailable_borrow_apr"; // borrow APR unreadable → cannot size carry (fail closed)

/** Where this bot's borrowed funds are ALREADY parked (identity only; the APY is
 * resolved from `rankedYields` so there is a single measured-yield source). */
export interface CarryParkedPosition {
  assetKey: string;
  displayName: string;
}

/** The destination the carry math was computed against. When the bot is already
 * parked this is that vault; otherwise it is the best measured vault. */
export interface CarryActiveDestination {
  assetKey: string;
  displayName: string;
  /** Measured APY of this destination, PERCENT. null only when a PARKED vault's
   * yield cannot be measured (unmeasured → we fail closed, see reason). */
  apyPct: number | null;
  /** True when the bot's funds are ALREADY parked here (vs. a suggestion to park). */
  isParked: boolean;
}

export interface CarryTradeInput {
  /** Measured yield destinations, best first (from rankMeasuredYieldDestinations). */
  rankedYields: RankedYieldDestination[];
  /** Where this bot's borrowed funds are ALREADY parked, if anywhere. null/omitted
   * = not parked. When set, the carry is computed off THIS vault, not the best. */
  currentParked?: CarryParkedPosition | null;
  /** Current per-bot debt-vault borrow APR as a FRACTION (e.g. 0.0466 = 4.66%). null = unreadable. */
  borrowApr: number | null;
  /** Live per-bot borrow health (the authoritative safety gate). */
  healthSummary: BotBorrowHealthSummary;
  /** Total open per-bot debt for this bot, USD. <= 0 means nothing to carry. */
  debtUsd: number;
}

export interface CarryTradeRecommendation {
  action: CarryTradeAction;
  /** The top measured destination (informational context), or null if none. */
  bestAsset: RankedYieldDestination | null;
  /** The destination the carry math actually used — the bot's parked vault when
   * parked, else the best vault. null when no destination applies. The UI should
   * prefer this over `bestAsset` for APY / name / spread context. */
  activeAsset: CarryActiveDestination | null;
  /** active-vault APY − borrow APR, PERCENT. null when either leg is unreadable. */
  grossSpreadPct: number | null;
  /** Flat risk/fee haircut applied, PERCENT. */
  haircutPct: number;
  /** grossSpreadPct − haircutPct, PERCENT. null when grossSpreadPct is null. */
  netSpreadPct: number | null;
  reason: CarryTradeReason;
  /** Plain-language summary for the UI. */
  message: string;
  /** Set when action is "unavailable": what we could not read. */
  blockedBy: "health" | "borrow_apr" | null;
}

const isFiniteNum = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);

/**
 * Decide the single carry-trade recommendation for one bot. PURE.
 *
 * Order matters and encodes "health always overrides carry":
 *   1. health unreadable            → unavailable (cannot advise)
 *   2. health below healthy         → repay (de-risk; ignores spread)
 *   3. no open debt                 → hold (nothing to carry)
 *   4. borrow APR unreadable        → unavailable (cannot size carry)
 *   5. resolve the ACTIVE vault     → the bot's parked vault if parked, else the
 *                                     best measured vault. Parked-but-unmeasured
 *                                     → hold (fail closed). Not-parked + no
 *                                     measured yield → hold (can't park off an estimate).
 *   6. net spread <= 0              → repay (negative carry)
 *   7. net spread >= minimum        → park (best vault) when NOT parked, else
 *                                     hold (keep funds where they already earn)
 *   8. thin positive net spread     → hold
 */
export function decideCarryTrade(input: CarryTradeInput): CarryTradeRecommendation {
  const cfg = BORROW_RISK_POLICY.carryAdvisor;
  const haircutPct = cfg.spreadHaircutPct;
  const best = input.rankedYields.length > 0 ? input.rankedYields[0] : null;

  const parked = input.currentParked ?? null;

  const base = {
    bestAsset: best,
    activeAsset: null as CarryActiveDestination | null,
    haircutPct,
    grossSpreadPct: null as number | null,
    netSpreadPct: null as number | null,
  };

  // 1. Health unreadable → cannot advise. (actionBlocked is set only when a
  //    position read failed; the band is then "unavailable".)
  const headline = input.healthSummary.headline;
  if (headline.actionBlocked || headline.band === "unavailable") {
    return {
      ...base,
      action: "unavailable",
      reason: "unavailable_health",
      message: "Can't read this bot's loan health right now, so no recommendation. Try again shortly.",
      blockedBy: "health",
    };
  }

  // 2. Health below healthy → repay regardless of carry (health always overrides).
  if (headline.band === "liquidation") {
    return {
      ...base,
      action: "repay",
      reason: "repay_health_liquidation",
      message: "This loan is at the liquidation point. Repay now to protect your collateral.",
      blockedBy: null,
    };
  }
  if (headline.band === "urgent") {
    return {
      ...base,
      action: "repay",
      reason: "repay_health_urgent",
      message: "This loan is in the danger zone (very close to liquidation). Repaying is strongly recommended.",
      blockedBy: null,
    };
  }
  if (headline.band === "nudge") {
    return {
      ...base,
      action: "repay",
      reason: "repay_health_nudge",
      message: "This loan's safety buffer is getting thin. Paying some down is the safer move.",
      blockedBy: null,
    };
  }

  // 3. No open debt → nothing to carry.
  if (!isFiniteNum(input.debtUsd) || input.debtUsd <= 0) {
    return {
      ...base,
      action: "hold",
      reason: "hold_no_debt",
      message: "No open loan on this bot, so there's nothing to manage.",
      blockedBy: null,
    };
  }

  // 4. Borrow APR unreadable → cannot size the carry (fail closed).
  if (!isFiniteNum(input.borrowApr) || (input.borrowApr as number) < 0) {
    return {
      ...base,
      action: "unavailable",
      reason: "unavailable_borrow_apr",
      message: "Can't read the current borrow rate right now, so no recommendation. Try again shortly.",
      blockedBy: "borrow_apr",
    };
  }

  // 5. Resolve the ACTIVE destination — the vault the carry is computed against.
  //    When the bot is ALREADY parked, that vault is the active destination (we
  //    judge the carry on what it actually earns, NOT on some better vault it is
  //    not in). When NOT parked, the active destination is the best measured vault.
  let active: CarryActiveDestination;
  if (parked) {
    // The single source of measured yield stays `rankedYields`; look the parked
    // vault up there. Absent → its yield is unmeasured → fail closed (hold).
    const parkedRanked =
      input.rankedYields.find((r) => r.assetKey === parked.assetKey) ?? null;
    if (!parkedRanked) {
      return {
        ...base,
        activeAsset: {
          assetKey: parked.assetKey,
          displayName: parked.displayName,
          apyPct: null,
          isParked: true,
        },
        action: "hold",
        reason: "hold_parked_yield_unavailable",
        message: `Your funds are parked in ${parked.displayName}, but its current yield can't be measured right now, so there's no recommendation. Try again shortly.`,
        blockedBy: null,
      };
    }
    active = {
      assetKey: parkedRanked.assetKey,
      displayName: parkedRanked.displayName,
      apyPct: parkedRanked.apyPct,
      isParked: true,
    };
  } else {
    // Not parked + no MEASURED vault yield → can't compare (never park off an estimate).
    if (!best) {
      return {
        ...base,
        action: "hold",
        reason: "hold_yield_unavailable",
        message: "No measured vault yield is available to compare against right now. Holding for now.",
        blockedBy: null,
      };
    }
    active = {
      assetKey: best.assetKey,
      displayName: best.displayName,
      apyPct: best.apyPct,
      isParked: false,
    };
  }

  // Carry math off the ACTIVE vault. Yields are PERCENT; borrow APR is a FRACTION → to PERCENT.
  const activeApyPct = active.apyPct as number; // non-null on both branches above
  const borrowAprPct = (input.borrowApr as number) * 100;
  const grossSpreadPct = activeApyPct - borrowAprPct;
  const netSpreadPct = grossSpreadPct - haircutPct;
  const withSpread = { ...base, activeAsset: active, grossSpreadPct, netSpreadPct };

  // 6. Negative (or zero) net carry → repaying beats paying interest for nothing.
  if (netSpreadPct <= 0) {
    return {
      ...withSpread,
      action: "repay",
      reason: "repay_negative_carry",
      message: active.isParked
        ? `Your funds parked in ${active.displayName} earn ${activeApyPct.toFixed(1)}%, but this loan costs ${borrowAprPct.toFixed(1)}% — so paying it down beats holding.`
        : `Borrow costs ${borrowAprPct.toFixed(1)}% but the best vault only earns ${activeApyPct.toFixed(1)}%, so paying the loan down beats holding it.`,
      blockedBy: null,
    };
  }

  // 7. Net carry clears the minimum. Already parked → KEEP funds where they are
  //    (hold); not parked → park borrowed USDC into the best vault.
  if (netSpreadPct >= cfg.minParkNetSpreadPct) {
    if (active.isParked) {
      return {
        ...withSpread,
        action: "hold",
        reason: "hold_positive_carry",
        message: `Your funds parked in ${active.displayName} earn ${activeApyPct.toFixed(1)}% vs a ${borrowAprPct.toFixed(1)}% borrow rate — a ${netSpreadPct.toFixed(1)}% net edge after costs. Keeping them parked is working in your favor.`,
        blockedBy: null,
      };
    }
    return {
      ...withSpread,
      action: "park",
      reason: "park_positive_carry",
      message: `${active.displayName} earns ${activeApyPct.toFixed(1)}% vs a ${borrowAprPct.toFixed(1)}% borrow rate — a ${netSpreadPct.toFixed(1)}% net edge after costs. Parking the borrowed USDC there is worthwhile.`,
      blockedBy: null,
    };
  }

  // 8. Thin positive net spread → not worth the round-trip + risk.
  return {
    ...withSpread,
    action: "hold",
    reason: "hold_thin_spread",
    message: active.isParked
      ? `Your funds parked in ${active.displayName} have only about a ${netSpreadPct.toFixed(1)}% edge over the ${borrowAprPct.toFixed(1)}% borrow rate after costs — thin, but there's no clearly better move. Holding for now.`
      : `The edge over the borrow rate is only about ${netSpreadPct.toFixed(1)}% after costs — too thin to be worth moving funds. Holding for now.`,
    blockedBy: null,
  };
}
