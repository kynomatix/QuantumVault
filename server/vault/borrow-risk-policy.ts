/**
 * BORROW RISK POLICY — the ENFORCED money gate for Phase C borrowing.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * This is the real safety gate. It is the OPPOSITE of
 * `borrow-preview-assumptions.ts` (which is inert, preview-only, never gates
 * money). The numbers here were RATIFIED by the owner 2026-06-24 (the
 * "Decision Wall" in docs/VAULTS_ARCHITECTURE.md). The eventual money path MUST
 * call `evaluateBorrowRequest` immediately before signing and refuse to proceed
 * unless `allowed === true`.
 *
 * DESIGN CONTRACT (do not break — it is what keeps this testable + reusable):
 *   - PURE. No I/O: no SDK import, no DB, no network, no clock. It is fed
 *     already-read, on-chain-authoritative facts and returns a decision. The
 *     ONLY import is a TYPE (`BorrowVaultConfig`), which compiles away.
 *   - FAIL CLOSED. Anything unreadable (null oracle age, null price move,
 *     unreadable collateral value) is a hard DENY, never a guess.
 *   - VENUE / ASSET / SCOPE AGNOSTIC. The MVP only accepts `scope: "account"`,
 *     but the contract is shaped so per-bot borrowing later is a NEW CALLER,
 *     not a rewrite of this module.
 *
 * "Tunable" numbers below are conservative LAUNCH defaults: the MODEL each
 * encodes is fixed; the exact number is revisited once there is live borrow
 * volume. Changing one is a policy change, made HERE, on purpose.
 * ───────────────────────────────────────────────────────────────────────────
 */

import type { BorrowVaultConfig } from "./jupiter-lend-borrow-route";

/** Owner-ratified enforced thresholds (Decision Wall, 2026-06-24). */
export const BORROW_RISK_POLICY = {
  /**
   * Recommended SAFE max LTV (Decision Wall #1, revised 2026-06-26 — "encourage
   * safety, not force it"). Borrowing above this is ALLOWED but WARNED; the user
   * may take the loan all the way to the protocol's own ceiling if they choose
   * ("their call, not ours"). This supersedes the original 0.30 hard force.
   */
  recommendedMaxLtv: 0.5,
  /**
   * Absolute platform BACKSTOP max LTV — defence-in-depth against a misreporting
   * protocol config, NOT the per-asset cap. The real ceiling for each collateral
   * is the protocol's own collateralFactor (e.g. INF = 0.75 on Jupiter Lend),
   * applied as effectiveMaxLtv = min(hardMaxLtv, vault.maxLtv). Set well above
   * any legitimate collateral factor so it only ever catches a garbage read.
   */
  hardMaxLtv: 0.9,
  /** Circuit breakers that PAUSE new borrows (Decision Wall #2). Stop + alert; never auto-liquidate. */
  circuitBreakers: {
    /** Pause new borrows when the vault's borrow APR exceeds this (fraction). */
    borrowAprCeiling: 0.15,
    /** Pause when pool utilization exceeds this (fraction) — a near-full pool can block withdrawing collateral even after repay. */
    utilizationCeiling: 0.9,
    /** Pause when total platform borrow debt (after this request) would exceed this (USD) — beta cap. */
    aggregateExposureCapUsd: 50_000,
    /** Pause when a single collateral would exceed this share of aggregate debt (fraction)... */
    perCollateralConcentrationMax: 0.5,
    /** ...but only once the book is non-trivial. Below this aggregate (USD), concentration is meaningless (the first borrow is 100% concentrated by definition). */
    concentrationFloorUsd: 10_000,
    /** Freeze when the oracle price is older than this (seconds). */
    oracleMaxAgeSec: 120,
    /** Freeze when the collateral moved more than this in 1h (absolute fraction, e.g. 0.15 = 15%). */
    priceMove1hCeiling: 0.15,
  },
  /** Health-factor ALERT bands (Decision Wall #3). liquidation = 1.0. */
  alerts: {
    /** Gentle nudge at/below this health factor. */
    healthFactorNudge: 1.6,
    /** Urgent "danger zone" WARNING at/below this health factor. No longer a hard deny — borrowing toward the protocol ceiling is the user's call (see recommendedMaxLtv). */
    healthFactorUrgent: 1.3,
    /** Liquidation reference — the ONLY hard health floor: an open/increase/withdraw that would land at or below it is denied (fail closed). */
    liquidation: 1.0,
  },
  /** Fee model (Decision Wall #4): a cut of POSITIVE net carry only. */
  fee: {
    /** Share of positive net carry taken as the platform fee (basis points). */
    carryProfitShareBps: 1000,
  },
} as const;

/** Borrow scope. The MVP enforces "account"; "bot" is reserved for a later caller. */
export type BorrowScope = "account" | "bot";

/** Platform-wide debt context, measured in USD, as it stands BEFORE this request. */
export interface BorrowExposureContext {
  /** Total platform borrow debt across ALL positions, USD, before this request. */
  aggregateDebtUsd: number;
  /** Existing platform-wide debt against THIS collateral asset, USD, before this request. */
  collateralDebtUsd: number;
}

/** Freshness facts about the collateral oracle. `null` means unreadable → hard deny. */
export interface BorrowOracleContext {
  /** Seconds since the oracle last published. `null` = unreadable. */
  publishAgeSec: number | null;
  /** Absolute fractional move of the collateral price over the last 1h (0.2 = 20%). `null` = unreadable. */
  priceMove1hAbs: number | null;
}

/** Everything the policy needs to decide a borrow. All facts are caller-supplied and on-chain-authoritative. */
export interface BorrowPolicyInput {
  scope: BorrowScope;
  walletAddress: string;
  /** True when the request comes from the owner wallet (Decision Wall #7 first-live gate). */
  isOwnerWallet: boolean;
  /** True when the wallet is on the beta borrow allowlist (Decision Wall #7). */
  isBorrowAllowlisted: boolean;
  /** True when the collateral mint is on the launch collateral allowlist (Decision Wall #5). Resolved by the caller against a verified-mint registry. */
  collateralAllowlisted: boolean;
  collateralMint: string;
  collateralSymbol: string;
  /** TOTAL collateral that will back the resulting position, raw base units. */
  collateralRaw: bigint;
  /** This position's CURRENT debt, raw base units (0n for a fresh open). */
  existingDebtRaw: bigint;
  /** ADDITIONAL USDC debt requested now, raw base units. */
  requestedDebtRaw: bigint;
  /** Decoded, on-chain-authoritative vault config (from jupiter-lend-borrow-route). */
  vault: BorrowVaultConfig;
  exposure: BorrowExposureContext;
  oracle: BorrowOracleContext;
}

export type BorrowPolicySeverity = "deny" | "warn" | "info";

export interface BorrowPolicyReason {
  code: string;
  severity: BorrowPolicySeverity;
  message: string;
  facts?: Record<string, unknown>;
}

export interface BorrowPolicyDecision {
  /** True only when NO reason has severity "deny". */
  allowed: boolean;
  projectedLtv: number | null;
  projectedHealthFactor: number | null;
  projectedDebtUsd: number | null;
  collateralValueUsd: number | null;
  /** min(platform hard cap, protocol max LTV). */
  effectiveMaxLtv: number;
  /** The most ADDITIONAL USDC (raw) this request could take and still pass every gate; null if collateral is unreadable. Convenience hint — the evaluator is the authority. */
  maxAllowedAdditionalDebtRaw: string | null;
  reasons: BorrowPolicyReason[];
}

const LTV_EPSILON = 1e-9;

/**
 * THE ENFORCED GATE. Pure. Returns a structured allow/deny decision for a
 * single account-level borrow request. The money path must refuse unless
 * `allowed === true`, and must re-run this immediately before signing.
 */
export function evaluateBorrowRequest(input: BorrowPolicyInput): BorrowPolicyDecision {
  const cb = BORROW_RISK_POLICY.circuitBreakers;
  const alerts = BORROW_RISK_POLICY.alerts;
  const { vault } = input;
  const reasons: BorrowPolicyReason[] = [];
  const deny = (code: string, message: string, facts?: Record<string, unknown>) =>
    reasons.push({ code, severity: "deny", message, facts });
  const warn = (code: string, message: string, facts?: Record<string, unknown>) =>
    reasons.push({ code, severity: "warn", message, facts });

  // ── Input helpers (fail closed: every caller-supplied fact must be sane) ──
  const finite = (n: number) => typeof n === "number" && Number.isFinite(n);
  const nonNegFinite = (n: number) => finite(n) && n >= 0;
  const unitRange = (n: number) => finite(n) && n > 0 && n <= 1;
  const isDecimals = (n: number) => Number.isInteger(n) && n >= 0 && n <= 18;
  const safeBigInt = (s: string): bigint | null => {
    try {
      if (typeof s !== "string" || s.trim() === "") return null;
      const v = BigInt(s);
      return v >= BigInt(0) ? v : null;
    } catch {
      return null;
    }
  };
  const minBorrowRaw = safeBigInt(vault.minimumBorrowingRaw);
  const borrowableRaw = safeBigInt(vault.borrowableUsdcRaw);

  // ── Money math (defensive; nulls when a fact is unreadable, never throws) ──
  const colTokens = isDecimals(vault.collateralDecimals)
    ? Number(input.collateralRaw) / 10 ** vault.collateralDecimals
    : NaN;
  const colPriceUsd = vault.oraclePriceLiquidateUsd; // honest: the price the protocol liquidates against
  const collateralValueUsdRaw = colTokens * colPriceUsd;
  const collateralValueUsd =
    Number.isFinite(collateralValueUsdRaw) && collateralValueUsdRaw > 0 ? collateralValueUsdRaw : null;

  const debtDivisor = isDecimals(vault.debtDecimals) ? 10 ** vault.debtDecimals : NaN;
  const existingDebtUsd = Number(input.existingDebtRaw) / debtDivisor;
  const requestedDebtUsd = Number(input.requestedDebtRaw) / debtDivisor;
  const projectedDebtUsd = existingDebtUsd + requestedDebtUsd;
  const debtComputable =
    collateralValueUsd !== null && Number.isFinite(projectedDebtUsd) && projectedDebtUsd >= 0;

  const effectiveMaxLtv = Math.min(
    BORROW_RISK_POLICY.hardMaxLtv,
    finite(vault.maxLtv) ? vault.maxLtv : BORROW_RISK_POLICY.hardMaxLtv,
  );

  const projectedLtv = debtComputable ? projectedDebtUsd / (collateralValueUsd as number) : null;
  const projectedHealthFactor =
    debtComputable && projectedDebtUsd > 0 && unitRange(vault.liquidationThreshold)
      ? ((collateralValueUsd as number) * vault.liquidationThreshold) / projectedDebtUsd
      : null;

  // ── Structural gates (no math needed) ────────────────────────────────────
  if (input.scope !== "account") {
    deny("scope_not_supported", "Only account-level borrowing is supported right now.", { scope: input.scope });
  }
  if (!(input.isOwnerWallet || input.isBorrowAllowlisted)) {
    deny(
      "not_borrow_allowlisted",
      "Borrowing is currently limited to the owner wallet and approved beta users.",
    );
  }
  if (!input.collateralAllowlisted) {
    deny("collateral_not_allowlisted", `${input.collateralSymbol} is not on the launch collateral allowlist.`, {
      collateralMint: input.collateralMint,
    });
  }

  // ── Collateral / vault sanity (fail closed) ──────────────────────────────
  if (collateralValueUsd === null) {
    deny("collateral_unreadable_value", "Collateral has no readable USD value; cannot size a borrow safely.");
  }
  if (!(effectiveMaxLtv > 0)) {
    deny("invalid_vault_config", "Vault risk parameters are invalid; refusing to borrow.", {
      effectiveMaxLtv,
    });
  }
  // Projected debt must be computable even when collateral IS readable: a
  // non-finite/negative debt makes LTV + health unreadable, which would
  // otherwise silently skip those gates. Fail closed.
  if (collateralValueUsd !== null && !debtComputable) {
    deny("debt_unreadable", "Projected debt could not be computed safely; refusing to borrow.");
  }

  // ── Full input sanity (fail closed on ANY non-finite / unparseable fact) ──
  // An enforced signing gate must not trust caller-supplied risk facts: a NaN
  // APR/util/threshold, a negative exposure, or an unparseable raw string must
  // produce a structured deny — never a silent `allowed:true` and never a throw.
  const badFacts: string[] = [];
  if (!unitRange(vault.maxLtv)) badFacts.push("maxLtv");
  if (!unitRange(vault.liquidationThreshold)) badFacts.push("liquidationThreshold");
  if (!(finite(vault.oraclePriceLiquidateUsd) && vault.oraclePriceLiquidateUsd > 0))
    badFacts.push("oraclePriceLiquidateUsd");
  if (!nonNegFinite(vault.borrowApr)) badFacts.push("borrowApr");
  if (!nonNegFinite(vault.utilization)) badFacts.push("utilization");
  if (!isDecimals(vault.collateralDecimals)) badFacts.push("collateralDecimals");
  if (!isDecimals(vault.debtDecimals)) badFacts.push("debtDecimals");
  if (!nonNegFinite(input.exposure.aggregateDebtUsd)) badFacts.push("exposure.aggregateDebtUsd");
  if (!nonNegFinite(input.exposure.collateralDebtUsd)) badFacts.push("exposure.collateralDebtUsd");
  // A single-collateral's debt cannot exceed the platform aggregate. If it does,
  // otherCollateralDebtUsd would clamp to 0 and disguise an impossible
  // multi-asset book as a single-asset bootstrap, bypassing the concentration cap.
  if (
    nonNegFinite(input.exposure.aggregateDebtUsd) &&
    nonNegFinite(input.exposure.collateralDebtUsd) &&
    input.exposure.collateralDebtUsd > input.exposure.aggregateDebtUsd
  )
    badFacts.push("exposure.collateralDebtUsd>aggregateDebtUsd");
  if (input.collateralRaw < BigInt(0)) badFacts.push("collateralRaw");
  if (input.existingDebtRaw < BigInt(0)) badFacts.push("existingDebtRaw");
  if (input.oracle.publishAgeSec !== null && !nonNegFinite(input.oracle.publishAgeSec))
    badFacts.push("oracle.publishAgeSec");
  if (input.oracle.priceMove1hAbs !== null && !nonNegFinite(input.oracle.priceMove1hAbs))
    badFacts.push("oracle.priceMove1hAbs");
  if (minBorrowRaw === null) badFacts.push("minimumBorrowingRaw");
  if (borrowableRaw === null) badFacts.push("borrowableUsdcRaw");
  if (badFacts.length > 0) {
    deny("invalid_inputs", "One or more risk inputs are missing or invalid; refusing to borrow.", {
      fields: badFacts,
    });
  }

  // ── Requested debt sanity ────────────────────────────────────────────────
  if (input.requestedDebtRaw <= BigInt(0)) {
    deny("non_positive_borrow", "Borrow amount must be greater than zero.");
  } else {
    if (minBorrowRaw !== null && input.requestedDebtRaw < minBorrowRaw) {
      deny("below_protocol_minimum", "Below the protocol's minimum borrow amount.", {
        requestedDebtRaw: input.requestedDebtRaw.toString(),
        minimumBorrowingRaw: vault.minimumBorrowingRaw,
      });
    }
    if (borrowableRaw !== null && input.requestedDebtRaw > borrowableRaw) {
      deny("exceeds_live_borrowable", "More than the pool currently has available to borrow.", {
        requestedDebtRaw: input.requestedDebtRaw.toString(),
        borrowableUsdcRaw: vault.borrowableUsdcRaw,
      });
    }
  }

  // ── Hard max-LTV cap (Decision Wall #1) ──────────────────────────────────
  if (projectedLtv !== null && projectedLtv > effectiveMaxLtv + LTV_EPSILON) {
    const bound = vault.maxLtv < BORROW_RISK_POLICY.hardMaxLtv ? "protocol_max_ltv" : "platform_hard_cap";
    deny(
      "exceeds_max_ltv",
      `This borrow would push LTV to ${(projectedLtv * 100).toFixed(1)}%, above the ${(
        effectiveMaxLtv * 100
      ).toFixed(0)}% cap.`,
      { projectedLtv, effectiveMaxLtv, bound },
    );
  }

  // ── Market circuit breakers (Decision Wall #2) ───────────────────────────
  if (vault.borrowApr > cb.borrowAprCeiling) {
    deny("borrow_apr_too_high", `Borrow rate (${(vault.borrowApr * 100).toFixed(2)}%) is above the ${(
      cb.borrowAprCeiling * 100
    ).toFixed(0)}% ceiling.`, { borrowApr: vault.borrowApr });
  }
  if (vault.utilization > cb.utilizationCeiling) {
    deny("utilization_too_high", "Pool is too heavily utilized to borrow safely right now.", {
      utilization: vault.utilization,
    });
  }

  // ── Exposure + concentration breakers (Decision Wall #2) ─────────────────
  const aggregateAfterUsd = input.exposure.aggregateDebtUsd + requestedDebtUsd;
  const collateralAfterUsd = input.exposure.collateralDebtUsd + requestedDebtUsd;
  if (aggregateAfterUsd > cb.aggregateExposureCapUsd) {
    deny("aggregate_exposure_cap", "Platform borrow exposure cap reached; new borrows are paused.", {
      aggregateAfterUsd,
      capUsd: cb.aggregateExposureCapUsd,
    });
  }
  const otherCollateralDebtUsd = Math.max(
    0,
    input.exposure.aggregateDebtUsd - input.exposure.collateralDebtUsd,
  );
  const concentration = aggregateAfterUsd > 0 ? collateralAfterUsd / aggregateAfterUsd : 0;
  // Concentration only binds once the book is non-trivial AND there is OTHER
  // collateral to diversify into. A single-asset book is 100% concentrated by
  // necessity (you cannot bootstrap above the floor otherwise), so the aggregate
  // exposure cap is its real guard; the concentration cap is a SCALE protection
  // that kicks in once a second collateral exists.
  if (
    otherCollateralDebtUsd > 0 &&
    aggregateAfterUsd >= cb.concentrationFloorUsd &&
    concentration > cb.perCollateralConcentrationMax
  ) {
    deny("concentration_cap", `${input.collateralSymbol} would exceed the ${(
      cb.perCollateralConcentrationMax * 100
    ).toFixed(0)}% single-collateral concentration cap.`, { concentration });
  }

  // ── Oracle freshness + volatility (Decision Wall #2; fail closed) ─────────
  if (input.oracle.publishAgeSec === null) {
    deny("oracle_unreadable", "Could not read the oracle's publish time; refusing to borrow.");
  } else if (input.oracle.publishAgeSec > cb.oracleMaxAgeSec) {
    deny("oracle_stale", "Oracle price is stale; refusing to borrow until it refreshes.", {
      publishAgeSec: input.oracle.publishAgeSec,
    });
  }
  if (input.oracle.priceMove1hAbs === null) {
    deny("price_move_unreadable", "Could not read recent price volatility; refusing to borrow.");
  } else if (input.oracle.priceMove1hAbs > cb.priceMove1hCeiling) {
    deny("price_volatility_freeze", "Collateral price is moving too fast right now; borrowing is paused.", {
      priceMove1hAbs: input.oracle.priceMove1hAbs,
    });
  }

  // ── Recommended-LTV guidance (encourage, don't force; Decision Wall #1) ───
  // Above the recommended safe LTV we WARN but still allow, as long as the
  // request stays within the protocol's own ceiling (effectiveMaxLtv). The user
  // may borrow up to that ceiling if they choose — "their call, not ours".
  if (
    projectedLtv !== null &&
    projectedLtv > BORROW_RISK_POLICY.recommendedMaxLtv + LTV_EPSILON &&
    projectedLtv <= effectiveMaxLtv + LTV_EPSILON
  ) {
    warn(
      "above_recommended_ltv",
      `This borrow takes LTV to ${(projectedLtv * 100).toFixed(1)}%, above the recommended ${(
        BORROW_RISK_POLICY.recommendedMaxLtv * 100
      ).toFixed(0)}% safe level. You can proceed, but a smaller drop in ${input.collateralSymbol} could risk liquidation.`,
      { projectedLtv, recommendedMaxLtv: BORROW_RISK_POLICY.recommendedMaxLtv },
    );
  }

  // ── Health band (Decision Wall #3) ───────────────────────────────────────
  // Liquidation itself is the ONLY hard floor (fail closed). The urgent band
  // WARNS instead of denying — within the protocol ceiling, a thin buffer is the
  // user's informed choice, not a platform veto.
  if (projectedHealthFactor !== null) {
    if (projectedHealthFactor <= alerts.liquidation) {
      deny(
        "health_below_liquidation",
        `This borrow would open the loan at or below the liquidation point (health ${projectedHealthFactor.toFixed(
          2,
        )}). Refusing.`,
        { projectedHealthFactor },
      );
    } else if (projectedHealthFactor < alerts.healthFactorUrgent) {
      warn(
        "health_below_urgent",
        `Health would be in the danger zone (${projectedHealthFactor.toFixed(
          2,
        )}, urgent below ${alerts.healthFactorUrgent}) — very close to liquidation.`,
        { projectedHealthFactor },
      );
    }
  }

  const allowed = reasons.every((r) => r.severity !== "deny");

  // ── Max additional borrow hint (UI convenience; NOT authorization) ────────
  // Only emitted when the request itself passes every gate; null on any deny so
  // no caller can mistake a sizing hint on an invalid request for permission.
  let maxAllowedAdditionalDebtRaw: string | null = null;
  if (allowed && collateralValueUsd !== null && effectiveMaxLtv > 0 && borrowableRaw !== null) {
    const ltvHeadroomUsd = Math.max(0, effectiveMaxLtv * collateralValueUsd - existingDebtUsd);
    const liveBorrowableUsd = Number(borrowableRaw) / 10 ** vault.debtDecimals;
    const aggregateHeadroomUsd = Math.max(0, cb.aggregateExposureCapUsd - input.exposure.aggregateDebtUsd);
    let maxUsd = Math.min(ltvHeadroomUsd, liveBorrowableUsd, aggregateHeadroomUsd);
    // Concentration only binds once the book is non-trivial AND there is OTHER
    // collateral to diversify into (mirrors the deny logic above).
    if (otherCollateralDebtUsd > 0 && input.exposure.aggregateDebtUsd >= cb.concentrationFloorUsd) {
      const m = cb.perCollateralConcentrationMax;
      const concentrationHeadroomUsd = Math.max(
        0,
        (m * input.exposure.aggregateDebtUsd - input.exposure.collateralDebtUsd) / (1 - m),
      );
      maxUsd = Math.min(maxUsd, concentrationHeadroomUsd);
    }
    maxAllowedAdditionalDebtRaw = BigInt(
      Math.max(0, Math.floor(maxUsd * 10 ** vault.debtDecimals)),
    ).toString();
  }

  return {
    allowed,
    projectedLtv,
    projectedHealthFactor,
    projectedDebtUsd: debtComputable ? projectedDebtUsd : null,
    collateralValueUsd,
    effectiveMaxLtv,
    maxAllowedAdditionalDebtRaw,
    reasons,
  };
}

/** Facts for a collateral-WITHDRAW decision. All on-chain-authoritative. */
export interface CollateralWithdrawInput {
  /** Decoded, on-chain-authoritative vault config. */
  vault: BorrowVaultConfig;
  /** Current on-chain collateral backing the position, raw base units. */
  liveCollateralRaw: bigint;
  /** Current on-chain debt — UNCHANGED by a withdraw — raw base units (6 dp USDC). */
  liveDebtRaw: bigint;
  /** Collateral to withdraw now, raw; or "max" to withdraw down to the cap. */
  requestedWithdrawRaw: bigint | "max";
  /** Oracle freshness. Required (fail closed) only when debt remains. */
  oracle: BorrowOracleContext;
}

export interface CollateralWithdrawDecision {
  allowed: boolean;
  /** Collateral remaining after an EXACT withdraw, raw; null for "max"/unreadable. */
  postCollateralRaw: string | null;
  postLtv: number | null;
  postHealthFactor: number | null;
  effectiveMaxLtv: number;
  /**
   * Largest collateral (raw) the caller could withdraw and still pass every
   * gate. When debt remains, this is the amount that brings the position to
   * exactly `effectiveMaxLtv` (rounded DOWN, conservative). The executor MUST
   * resolve a "max" request WITH debt to THIS amount — never the protocol's
   * MAX_WITHDRAW sentinel, which would withdraw down to the looser protocol
   * collateral factor (e.g. 0.75) and leave the loan in the danger zone.
   * When debt is zero, this is the full collateral. null if unreadable.
   */
  maxWithdrawableRaw: string | null;
  reasons: BorrowPolicyReason[];
}

/**
 * THE ENFORCED GATE for pulling collateral OUT of an existing borrow position.
 * Pure. Withdrawing collateral WORSENS health, so this is the opposite-direction
 * sibling of `evaluateBorrowRequest`: debt is held constant and collateral
 * shrinks. The money path must refuse unless `allowed === true`, and must re-run
 * this immediately before signing.
 *
 * Rules (fail closed):
 *   - debt == 0  → no liquidation risk; allow withdrawing ALL collateral.
 *   - debt  > 0  → the oracle must be readable + fresh + not mid-crash; the
 *                  post-withdraw LTV must stay <= min(hardMaxLtv, vault.maxLtv)
 *                  (the protocol's own ceiling) and post-withdraw health must
 *                  stay strictly above liquidation. LTV above the recommended
 *                  safe level, or a thin (urgent-band) health buffer, WARNS but
 *                  is allowed — the protocol ceiling is the user's call.
 */
export function evaluateCollateralWithdraw(input: CollateralWithdrawInput): CollateralWithdrawDecision {
  const cb = BORROW_RISK_POLICY.circuitBreakers;
  const alerts = BORROW_RISK_POLICY.alerts;
  const { vault } = input;
  const reasons: BorrowPolicyReason[] = [];
  const deny = (code: string, message: string, facts?: Record<string, unknown>) =>
    reasons.push({ code, severity: "deny", message, facts });
  const warn = (code: string, message: string, facts?: Record<string, unknown>) =>
    reasons.push({ code, severity: "warn", message, facts });

  const finite = (n: number) => typeof n === "number" && Number.isFinite(n);
  const nonNegFinite = (n: number) => finite(n) && n >= 0;
  const unitRange = (n: number) => finite(n) && n > 0 && n <= 1;
  const isDecimals = (n: number) => Number.isInteger(n) && n >= 0 && n <= 18;

  const effectiveMaxLtv = Math.min(
    BORROW_RISK_POLICY.hardMaxLtv,
    finite(vault.maxLtv) ? vault.maxLtv : BORROW_RISK_POLICY.hardMaxLtv,
  );

  const fail = (postCollateralRaw: string | null = null): CollateralWithdrawDecision => ({
    allowed: false,
    postCollateralRaw,
    postLtv: null,
    postHealthFactor: null,
    effectiveMaxLtv,
    maxWithdrawableRaw: null,
    reasons,
  });

  // ── Vault sanity (fail closed) ───────────────────────────────────────────
  const badFacts: string[] = [];
  if (!unitRange(vault.maxLtv)) badFacts.push("maxLtv");
  if (!unitRange(vault.liquidationThreshold)) badFacts.push("liquidationThreshold");
  if (!(finite(vault.oraclePriceLiquidateUsd) && vault.oraclePriceLiquidateUsd > 0))
    badFacts.push("oraclePriceLiquidateUsd");
  if (!isDecimals(vault.collateralDecimals)) badFacts.push("collateralDecimals");
  if (!isDecimals(vault.debtDecimals)) badFacts.push("debtDecimals");
  if (input.liveCollateralRaw < 0n) badFacts.push("liveCollateralRaw");
  if (input.liveDebtRaw < 0n) badFacts.push("liveDebtRaw");
  if (input.requestedWithdrawRaw !== "max" && input.requestedWithdrawRaw <= 0n)
    badFacts.push("requestedWithdrawRaw");
  if (badFacts.length > 0) {
    deny("invalid_inputs", "One or more risk inputs are missing or invalid; refusing to withdraw.", {
      fields: badFacts,
    });
    return fail();
  }

  const price = vault.oraclePriceLiquidateUsd;
  const colDiv = 10 ** vault.collateralDecimals;
  const debtDiv = 10 ** vault.debtDecimals;
  const debtUsd = Number(input.liveDebtRaw) / debtDiv;
  const hasDebt = input.liveDebtRaw > 0n;

  // ── No debt → no liquidation risk; allow the full withdraw. ──────────────
  if (!hasDebt) {
    const isMax = input.requestedWithdrawRaw === "max";
    if (!isMax && (input.requestedWithdrawRaw as bigint) > input.liveCollateralRaw) {
      deny("exceeds_collateral", "Cannot withdraw more collateral than the position holds.", {
        requestedWithdrawRaw: (input.requestedWithdrawRaw as bigint).toString(),
        liveCollateralRaw: input.liveCollateralRaw.toString(),
      });
      return fail();
    }
    const postCollateralRaw = isMax
      ? "0"
      : (input.liveCollateralRaw - (input.requestedWithdrawRaw as bigint)).toString();
    return {
      allowed: true,
      postCollateralRaw,
      postLtv: 0,
      postHealthFactor: null,
      effectiveMaxLtv,
      maxWithdrawableRaw: input.liveCollateralRaw.toString(),
      reasons,
    };
  }

  // ── Debt remains → oracle must be readable, fresh, and not mid-crash. ─────
  if (input.oracle.publishAgeSec === null) {
    deny("oracle_unreadable", "Could not read the oracle's publish time; refusing to withdraw collateral.");
  } else if (input.oracle.publishAgeSec > cb.oracleMaxAgeSec) {
    deny("oracle_stale", "Oracle price is stale; refusing to withdraw collateral until it refreshes.", {
      publishAgeSec: input.oracle.publishAgeSec,
    });
  }
  if (input.oracle.priceMove1hAbs === null) {
    deny("price_move_unreadable", "Could not read recent price volatility; refusing to withdraw collateral.");
  } else if (nonNegFinite(input.oracle.priceMove1hAbs) && input.oracle.priceMove1hAbs > cb.priceMove1hCeiling) {
    deny("price_volatility_freeze", "Collateral price is moving too fast right now; withdrawals are paused.", {
      priceMove1hAbs: input.oracle.priceMove1hAbs,
    });
  }

  // Largest withdraw that keeps LTV <= effectiveMaxLtv (round the kept collateral
  // UP, so the withdraw is rounded DOWN — conservative). minColValueUsd is the
  // collateral USD needed to keep debt at exactly the cap.
  const minColValueUsd = debtUsd / effectiveMaxLtv;
  const minColTokens = minColValueUsd / price;
  const minColRaw = BigInt(Math.ceil(minColTokens * colDiv));
  const maxWithdrawableRaw = input.liveCollateralRaw > minColRaw ? input.liveCollateralRaw - minColRaw : 0n;

  // Resolve the requested withdraw to an exact post-collateral.
  const isMax = input.requestedWithdrawRaw === "max";
  const requestedRaw = isMax ? maxWithdrawableRaw : (input.requestedWithdrawRaw as bigint);

  if (!isMax && requestedRaw > input.liveCollateralRaw) {
    deny("exceeds_collateral", "Cannot withdraw more collateral than the position holds.", {
      requestedWithdrawRaw: requestedRaw.toString(),
      liveCollateralRaw: input.liveCollateralRaw.toString(),
    });
  }

  const postCollateralRaw = input.liveCollateralRaw > requestedRaw ? input.liveCollateralRaw - requestedRaw : 0n;
  const postColTokens = Number(postCollateralRaw) / colDiv;
  const postColValueUsd = postColTokens * price;

  let postLtv: number | null = null;
  let postHealthFactor: number | null = null;
  if (!(postColValueUsd > 0)) {
    // Withdrawing (nearly) all collateral while debt remains is never allowed.
    deny("withdraw_leaves_no_collateral", "Cannot withdraw this much while the loan still has debt.");
  } else {
    postLtv = debtUsd / postColValueUsd;
    postHealthFactor = (postColValueUsd * vault.liquidationThreshold) / debtUsd;
    if (postLtv > effectiveMaxLtv + LTV_EPSILON) {
      deny(
        "exceeds_max_ltv",
        `This withdrawal would push LTV to ${(postLtv * 100).toFixed(1)}%, above the ${(
          effectiveMaxLtv * 100
        ).toFixed(0)}% cap.`,
        { postLtv, effectiveMaxLtv },
      );
    } else if (postLtv > BORROW_RISK_POLICY.recommendedMaxLtv + LTV_EPSILON) {
      warn(
        "above_recommended_ltv",
        `This withdrawal takes LTV to ${(postLtv * 100).toFixed(1)}%, above the recommended ${(
          BORROW_RISK_POLICY.recommendedMaxLtv * 100
        ).toFixed(0)}% safe level. Allowed, but it raises liquidation risk.`,
        { postLtv, recommendedMaxLtv: BORROW_RISK_POLICY.recommendedMaxLtv },
      );
    }
    if (postHealthFactor <= alerts.liquidation) {
      deny(
        "health_below_liquidation",
        `This withdrawal would push the loan to or below the liquidation point (health ${postHealthFactor.toFixed(
          2,
        )}). Refusing.`,
        { postHealthFactor },
      );
    } else if (postHealthFactor < alerts.healthFactorUrgent) {
      warn(
        "health_below_urgent",
        `Health would be in the danger zone (${postHealthFactor.toFixed(
          2,
        )}, urgent below ${alerts.healthFactorUrgent}) — very close to liquidation.`,
        { postHealthFactor },
      );
    }
  }

  const allowed = reasons.every((r) => r.severity !== "deny");
  return {
    allowed,
    postCollateralRaw: postCollateralRaw.toString(),
    postLtv,
    postHealthFactor,
    effectiveMaxLtv,
    maxWithdrawableRaw: maxWithdrawableRaw.toString(),
    reasons,
  };
}

/**
 * Carry-profit-share fee (Decision Wall #4). PURE. Takes a cut of POSITIVE net
 * carry only — never a fee on the borrow itself, and zero when carry is zero or
 * negative. `netCarryUsd` = yield earned − borrow interest (already netted).
 */
export function computeCarryProfitFee(
  netCarryUsd: number,
  shareBps: number = BORROW_RISK_POLICY.fee.carryProfitShareBps,
): number {
  if (!Number.isFinite(netCarryUsd) || netCarryUsd <= 0) return 0;
  const bps = Number.isFinite(shareBps) && shareBps > 0 ? shareBps : 0;
  return netCarryUsd * (bps / 10_000);
}
