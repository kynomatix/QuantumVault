/**
 * PER-BOT BORROW HEALTH ENUMERATOR (P1 monitoring obligation).
 *
 * Live HF / LTV per open per-bot (Flash) borrow position, plus a single
 * "headline" = the WORST position. This is the always-on safety read the
 * Carry-Trade Advisor (P2) leans on: health ALWAYS overrides carry.
 *
 * DESIGN CONTRACT (keep it testable + money-safe):
 *   - The CLASSIFICATION + METRICS are PURE (no I/O): they take already-read,
 *     on-chain-authoritative facts (a LivePositionHealth + a decoded
 *     BorrowVaultConfig) and return health. The async `enumerateBotBorrowHealth`
 *     is the only part that touches storage / the chain, and it just orchestrates
 *     the pure core.
 *   - FAIL CLOSED. A position whose live read OR vault config OR collateral USD
 *     value is unreadable is reported `unavailable` (never a guessed "healthy").
 *     The headline is `unavailable` (actionBlocked) if ANY position is.
 *   - The health BANDS reuse the SAME owner-ratified thresholds as the enforced
 *     borrow gate (BORROW_RISK_POLICY.alerts), so monitoring and the open-gate
 *     never disagree on what "urgent" means.
 *   - A zero-debt position has NO liquidation risk → `healthy`, HF null. (A
 *     per-bot borrow normally carries debt, but a mid-unwind row may be zeroed.)
 */

import {
  BORROW_RISK_POLICY,
  PERBOT_CARVE_DEFAULT_TARGET_LTV,
} from "./borrow-risk-policy";
import {
  JupiterLendBorrowRoute,
  type BorrowVaultConfig,
  type LivePositionHealth,
} from "./jupiter-lend-borrow-route";
import { storage } from "../storage";

/** Health bands, worst → best. `unavailable` = unreadable (fail closed). */
export type BorrowHealthBand =
  | "unavailable"
  | "liquidation"
  | "urgent"
  | "nudge"
  | "healthy";

/** Worst-first severity ranking for picking the headline (higher = worse). */
export const BAND_SEVERITY: Record<BorrowHealthBand, number> = {
  unavailable: 4,
  liquidation: 3,
  urgent: 2,
  nudge: 1,
  healthy: 0,
};

export interface PerBotPositionHealth {
  /** DB borrow_positions.id. */
  borrowPositionId: string;
  venuePositionId: number | null;
  collateralAssetKey: string | null;
  collateralMint: string | null;
  /** "available" once metrics are computed; "unavailable" when fail-closed. */
  status: "available" | "unavailable";
  collateralValueUsd: number | null;
  debtUsd: number | null;
  ltv: number | null;
  /** >1 safe, =1 at liquidation, null when there is no debt (no liq risk). */
  healthFactor: number | null;
  liquidatable: boolean | null;
  band: BorrowHealthBand;
  /** Present only when status === "unavailable". */
  reason?: string;
}

export interface BotBorrowHealthSummary {
  /** True when the bot has ≥1 non-terminal per-bot borrow position. */
  applicable: boolean;
  positions: PerBotPositionHealth[];
  headline: {
    band: BorrowHealthBand;
    /** Lowest (worst) health factor across positions that carry debt; null otherwise. */
    healthFactor: number | null;
    /**
     * True when we cannot safely advise on this bot: any position is unreadable.
     * (liquidation/urgent are NOT blocked — they drive a "repay now" recommendation.)
     */
    actionBlocked: boolean;
  };
}

const isFiniteNum = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);
const inUnitRange = (n: number) => isFiniteNum(n) && n > 0 && n <= 1;
const isDecimals = (n: number) => Number.isInteger(n) && n >= 0 && n <= 18;

/**
 * Map a health factor to an alert band. PURE. Reuses the enforced gate's
 * thresholds. A position with NO debt has no liquidation risk → healthy. An
 * unreadable (null / non-finite) health factor on a debt-bearing position is
 * `unavailable` (fail closed), never a guess.
 */
export function classifyBorrowHealthBand(
  healthFactor: number | null,
  hasDebt: boolean,
): BorrowHealthBand {
  if (!hasDebt) return "healthy";
  if (!isFiniteNum(healthFactor)) return "unavailable";
  const a = BORROW_RISK_POLICY.alerts;
  if (healthFactor <= a.liquidation) return "liquidation";
  if (healthFactor <= a.healthFactorUrgent) return "urgent";
  if (healthFactor <= a.healthFactorNudge) return "nudge";
  return "healthy";
}

/**
 * Compute one position's health from already-read facts. PURE. `vault === null`
 * or `live === null` (unreadable) ⇒ unavailable. With debt present but an
 * unreadable collateral USD value ⇒ unavailable (fail closed). Mirrors the LTV /
 * HF math used by previewBorrow + the enforced gate (oracle LIQUIDATION price).
 */
export function computePerBotPositionHealth(input: {
  borrowPositionId: string;
  venuePositionId: number | null;
  collateralAssetKey: string | null;
  collateralMint: string | null;
  live: LivePositionHealth | null;
  vault: BorrowVaultConfig | null;
}): PerBotPositionHealth {
  const base = {
    borrowPositionId: input.borrowPositionId,
    venuePositionId: input.venuePositionId,
    collateralAssetKey: input.collateralAssetKey,
    collateralMint: input.collateralMint,
  };
  const unavailable = (reason: string): PerBotPositionHealth => ({
    ...base,
    status: "unavailable",
    collateralValueUsd: null,
    debtUsd: null,
    ltv: null,
    healthFactor: null,
    liquidatable: null,
    band: "unavailable",
    reason,
  });

  if (!input.vault) return unavailable("Vault config is unreadable.");
  if (!input.live) return unavailable("Live on-chain position is unreadable.");

  const vault = input.vault;
  const live = input.live;
  if (!isDecimals(vault.collateralDecimals) || !isDecimals(vault.debtDecimals)) {
    return unavailable("Vault decimals are invalid.");
  }

  let collateralRaw: bigint;
  let debtRaw: bigint;
  try {
    collateralRaw = BigInt(live.collateralRaw);
    debtRaw = BigInt(live.debtRaw);
  } catch {
    return unavailable("Live position amounts are unparseable.");
  }

  const debtUsd = Number(debtRaw) / 10 ** vault.debtDecimals;
  if (!isFiniteNum(debtUsd) || debtUsd < 0) {
    return unavailable("Debt is unreadable.");
  }
  const hasDebt = debtUsd > 0;

  // Collateral USD on the LIQUIDATION oracle price (honest, not flattering).
  const price = vault.oraclePriceLiquidateUsd;
  const colTokens = Number(collateralRaw) / 10 ** vault.collateralDecimals;
  const collateralValueUsd =
    isFiniteNum(price) && price > 0 && isFiniteNum(colTokens) && colTokens >= 0
      ? colTokens * price
      : null;

  // No debt → no liquidation risk, regardless of collateral readability.
  if (!hasDebt) {
    return {
      ...base,
      status: "available",
      collateralValueUsd,
      debtUsd: 0,
      ltv: collateralValueUsd !== null ? 0 : null,
      healthFactor: null,
      liquidatable: live.liquidatable ?? false,
      band: "healthy",
    };
  }

  // Debt present: an unreadable collateral value or liq threshold ⇒ fail closed.
  if (collateralValueUsd === null || !inUnitRange(vault.liquidationThreshold)) {
    return unavailable("Collateral USD value is unreadable; cannot size health.");
  }

  const ltv =
    collateralValueUsd > 0 ? debtUsd / collateralValueUsd : Infinity;
  const healthFactor =
    (collateralValueUsd * vault.liquidationThreshold) / debtUsd;
  if (!isFiniteNum(healthFactor)) {
    return unavailable("Health factor could not be computed.");
  }

  // The protocol's OWN liquidatable flag is on-chain truth and DOMINATES our
  // locally-reconstructed HF: if Jupiter marks the position liquidatable, never
  // report a softer band. Price / threshold / timing drift between the REST
  // config and the position read could otherwise understate a position the
  // protocol itself already considers liquidatable. Fail-closed monitoring —
  // "health always overrides carry" only holds if we never under-report.
  const band: BorrowHealthBand =
    live.liquidatable === true
      ? "liquidation"
      : classifyBorrowHealthBand(healthFactor, true);

  return {
    ...base,
    status: "available",
    collateralValueUsd,
    debtUsd,
    ltv: isFiniteNum(ltv) ? ltv : null,
    healthFactor,
    liquidatable: live.liquidatable ?? null,
    band,
  };
}

/**
 * Reduce per-position health to a single headline = the WORST position. PURE.
 * Empty list ⇒ not applicable (healthy headline, nothing to block). Any
 * unreadable position ⇒ headline unavailable + actionBlocked. Otherwise the
 * headline band is the worst present and the headline HF is the lowest HF among
 * positions that carry debt.
 */
export function summarizeBotBorrowHealth(
  positions: PerBotPositionHealth[],
): BotBorrowHealthSummary {
  if (positions.length === 0) {
    return {
      applicable: false,
      positions,
      headline: { band: "healthy", healthFactor: null, actionBlocked: false },
    };
  }

  let worstBand: BorrowHealthBand = "healthy";
  for (const p of positions) {
    if (BAND_SEVERITY[p.band] > BAND_SEVERITY[worstBand]) worstBand = p.band;
  }

  let worstHf: number | null = null;
  for (const p of positions) {
    if (isFiniteNum(p.healthFactor)) {
      worstHf = worstHf === null ? p.healthFactor : Math.min(worstHf, p.healthFactor);
    }
  }

  return {
    applicable: true,
    positions,
    headline: {
      band: worstBand,
      healthFactor: worstHf,
      actionBlocked: worstBand === "unavailable",
    },
  };
}

/** Injectable I/O for testability; defaults to the real storage + borrow route. */
export interface BotBorrowHealthDeps {
  getBorrowPositions(
    walletAddress: string,
    tradingBotId: string,
  ): Promise<
    Array<{
      id: string;
      status: string | null;
      venuePositionId: string | number | null;
      collateralMint: string | null;
      collateralAssetKey: string | null;
    }>
  >;
  getVaultConfig(collateralMint: string): Promise<BorrowVaultConfig | null>;
  readLivePositionHealth(
    collateralMint: string,
    positionId: number,
  ): Promise<LivePositionHealth | null>;
}

function defaultDeps(): BotBorrowHealthDeps {
  const route = new JupiterLendBorrowRoute();
  return {
    getBorrowPositions: (w, b) => storage.getBorrowPositions(w, b),
    getVaultConfig: (m) => route.getVaultConfig(m),
    readLivePositionHealth: (m, p) => route.readLivePositionHealth(m, p),
  };
}

/**
 * Just the chain/REST I/O a SINGLE row's health read needs — a narrower slice of
 * BotBorrowHealthDeps so the account-level monitor (FC-2) can share the EXACT
 * per-row read without dragging in the per-bot `getBorrowPositions` enumerator.
 */
export interface RowHealthDeps {
  getVaultConfig(collateralMint: string): Promise<BorrowVaultConfig | null>;
  readLivePositionHealth(
    collateralMint: string,
    positionId: number,
  ): Promise<LivePositionHealth | null>;
}

export function defaultRowHealthDeps(): RowHealthDeps {
  const route = new JupiterLendBorrowRoute();
  return {
    getVaultConfig: (m) => route.getVaultConfig(m),
    readLivePositionHealth: (m, p) => route.readLivePositionHealth(m, p),
  };
}

/**
 * Read ONE borrow position's live health (vault config + on-chain position) and
 * reduce to a PerBotPositionHealth. SCOPE-AGNOSTIC: account-level (tradingBotId
 * null) and per-bot rows go through the identical path — the pure
 * computePerBotPositionHealth only takes facts. Fail-closed per failure mode
 * (unreadable config/position ⇒ `unavailable`, never a guessed "healthy"); never
 * throws. Pass a shared `cfgCache` to read each distinct mint's config once.
 */
export async function computeRowHealth(
  row: {
    id: string;
    venuePositionId: string | number | null;
    collateralMint: string | null;
    collateralAssetKey: string | null;
  },
  deps: RowHealthDeps = defaultRowHealthDeps(),
  cfgCache?: Map<string, BorrowVaultConfig | null>,
): Promise<PerBotPositionHealth> {
  const mint = row.collateralMint ?? null;
  const venueId = row.venuePositionId != null ? Number(row.venuePositionId) : NaN;
  let vault: BorrowVaultConfig | null = null;
  let live: LivePositionHealth | null = null;

  if (mint) {
    if (cfgCache) {
      if (!cfgCache.has(mint)) {
        try {
          cfgCache.set(mint, await deps.getVaultConfig(mint));
        } catch {
          cfgCache.set(mint, null);
        }
      }
      vault = cfgCache.get(mint) ?? null;
    } else {
      try {
        vault = await deps.getVaultConfig(mint);
      } catch {
        vault = null;
      }
    }
    if (Number.isInteger(venueId) && venueId > 0) {
      try {
        live = await deps.readLivePositionHealth(mint, venueId);
      } catch {
        live = null;
      }
    }
  }

  return computePerBotPositionHealth({
    borrowPositionId: row.id,
    venuePositionId: Number.isInteger(venueId) ? venueId : null,
    collateralAssetKey: row.collateralAssetKey ?? null,
    collateralMint: mint,
    live,
    vault,
  });
}

/**
 * Enumerate live health for every non-terminal per-bot borrow position of one
 * bot. Lazy / event-driven by design (called on Equity-tab open + after
 * open/close mutations) — NOT a poller. Fail-closed per position; never throws on
 * a single bad read (that position is reported `unavailable`).
 *
 * AUTHZ is the CALLER's job (the route enforces bot ∈ session wallet + Flash);
 * this helper only reads what it is told.
 */
export async function enumerateBotBorrowHealth(
  walletAddress: string,
  tradingBotId: string,
  deps: BotBorrowHealthDeps = defaultDeps(),
): Promise<BotBorrowHealthSummary> {
  const rows = (await deps.getBorrowPositions(walletAddress, tradingBotId)).filter(
    (r) => r.status !== "closed" && r.status !== "failed",
  );

  const cfgCache = new Map<string, BorrowVaultConfig | null>();
  const out: PerBotPositionHealth[] = [];

  for (const r of rows) {
    out.push(
      await computeRowHealth(
        {
          id: r.id,
          venuePositionId: r.venuePositionId,
          collateralMint: r.collateralMint ?? null,
          collateralAssetKey: r.collateralAssetKey ?? null,
        },
        deps,
        cfgCache,
      ),
    );
  }

  return summarizeBotBorrowHealth(out);
}

// --- DEFEND-THE-LOAN: suggested collateral top-up -----------------------------

/** Facts a top-up suggestion needs. All USD on the LIQUIDATION oracle price. */
export interface TopUpSuggestionFacts {
  /** Debt in USD (debtRaw / 10^debtDecimals). */
  debtUsd: number;
  /** Collateral USD value at the liquidation oracle price. */
  collateralValueUsd: number;
  /** Liquidation oracle price, USD per collateral token (> 0). */
  collateralPriceUsd: number;
  collateralDecimals: number;
  /** LTV to restore to; defaults to PERBOT_CARVE_DEFAULT_TARGET_LTV (0.5). */
  targetLtv?: number;
}

export interface TopUpSuggestion {
  /** Additional collateral to add, raw base units (rounded UP). 0n when already safe. */
  suggestedCollateralRaw: bigint;
  /** Same amount in whole tokens (display). */
  suggestedCollateralTokens: number;
  /** USD value of the suggested top-up at the liquidation oracle price. */
  suggestedCollateralUsd: number;
  /** The LTV the suggestion restores to. */
  targetLtv: number;
}

/**
 * SUGGESTED per-bot collateral top-up to restore `targetLtv` (default 0.5). PURE.
 *
 * "Defend the loan" math: how much MORE collateral (raw base units) to add so the
 * position's LTV (debt / collateral value) returns to the target. Uses the SAME
 * honest LIQUIDATION oracle price as the health read, so the suggestion and the
 * displayed health never disagree. Rounds the raw amount UP so adding it reaches
 * (never just-misses) the target.
 *
 * Returns a 0n suggestion when the position is already at/above target or carries
 * no debt. Returns null (fail closed) when any fact is unreadable — the caller
 * must NOT fabricate a suggestion from a bad read.
 */
export function computePerbotTopUpSuggestion(
  f: TopUpSuggestionFacts,
): TopUpSuggestion | null {
  const targetLtv = f.targetLtv ?? PERBOT_CARVE_DEFAULT_TARGET_LTV;
  if (!inUnitRange(targetLtv)) return null;
  if (!isFiniteNum(f.debtUsd) || f.debtUsd < 0) return null;
  if (!isFiniteNum(f.collateralValueUsd) || f.collateralValueUsd < 0) return null;
  if (!isFiniteNum(f.collateralPriceUsd) || f.collateralPriceUsd <= 0) return null;
  if (!isDecimals(f.collateralDecimals)) return null;

  const zero: TopUpSuggestion = {
    suggestedCollateralRaw: 0n,
    suggestedCollateralTokens: 0,
    suggestedCollateralUsd: 0,
    targetLtv,
  };

  // No debt → no liquidation risk → nothing to defend.
  if (f.debtUsd === 0) return zero;

  const requiredCollateralUsd = f.debtUsd / targetLtv;
  const additionalUsd = requiredCollateralUsd - f.collateralValueUsd;
  if (additionalUsd <= 0) return zero; // already at/above target

  const additionalTokens = additionalUsd / f.collateralPriceUsd;
  if (!isFiniteNum(additionalTokens) || additionalTokens <= 0) return null;

  // Round UP to the next raw unit so the top-up reaches (not just-misses) target.
  const scale = 10 ** f.collateralDecimals;
  const rawCeil = BigInt(Math.ceil(additionalTokens * scale));
  if (rawCeil <= 0n) return zero;

  return {
    suggestedCollateralRaw: rawCeil,
    suggestedCollateralTokens: Number(rawCeil) / scale,
    suggestedCollateralUsd: (Number(rawCeil) / scale) * f.collateralPriceUsd,
    targetLtv,
  };
}

/**
 * Derive the top-up suggestion from the SAME raw facts the health read uses (a
 * LivePositionHealth + BorrowVaultConfig). Mirrors computePerBotPositionHealth's
 * extraction (liquidation oracle price, decimals) so suggestion and health agree.
 * Null (fail closed) on any unreadable fact.
 */
export function derivePerbotTopUpSuggestion(
  live: LivePositionHealth | null,
  vault: BorrowVaultConfig | null,
  targetLtv?: number,
): TopUpSuggestion | null {
  if (!vault || !live) return null;
  if (!isDecimals(vault.collateralDecimals) || !isDecimals(vault.debtDecimals)) {
    return null;
  }
  let collateralRaw: bigint;
  let debtRaw: bigint;
  try {
    collateralRaw = BigInt(live.collateralRaw);
    debtRaw = BigInt(live.debtRaw);
  } catch {
    return null;
  }
  const price = vault.oraclePriceLiquidateUsd;
  if (!isFiniteNum(price) || price <= 0) return null;
  if (!inUnitRange(vault.liquidationThreshold)) return null;
  const debtUsd = Number(debtRaw) / 10 ** vault.debtDecimals;
  const colTokens = Number(collateralRaw) / 10 ** vault.collateralDecimals;
  const collateralValueUsd = colTokens * price;
  return computePerbotTopUpSuggestion({
    debtUsd,
    collateralValueUsd,
    collateralPriceUsd: price,
    collateralDecimals: vault.collateralDecimals,
    targetLtv,
  });
}

// --- REMOVE-COLLATERAL: removable spare -----------------------------------

/** Facts the removable-spare read needs. All USD on the LIQUIDATION oracle price. */
export interface RemovableSpareFacts {
  /** Debt in USD (debtRaw / 10^debtDecimals). */
  debtUsd: number;
  /** Collateral USD value at the liquidation oracle price. */
  collateralValueUsd: number;
  /** Liquidation oracle price, USD per collateral token (> 0). */
  collateralPriceUsd: number;
  collateralDecimals: number;
  /** The position's exact live collateral, raw. Caps the spare (never float-derive
   *  more than the position holds) and IS the spare when the debt is zero. */
  collateralRaw: bigint;
  /** LTV ceiling the remainder must respect; defaults to PERBOT_CARVE_DEFAULT_TARGET_LTV (0.5). */
  targetLtv?: number;
}

export interface RemovableSpare {
  /** Collateral safe to remove, raw base units (rounded DOWN). 0n when none. */
  removableRaw: bigint;
  /** Same amount in whole tokens (display). */
  removableTokens: number;
  /** USD value of the removable spare at the liquidation oracle price. */
  removableUsd: number;
  /** The LTV ceiling the remainder respects. */
  targetLtv: number;
}

/**
 * REMOVABLE spare collateral: the exact MIRROR of computePerbotTopUpSuggestion in
 * the opposite direction. PURE. How much collateral (raw base units) can leave the
 * position while the REMAINDER still keeps LTV <= target. Uses the SAME honest
 * LIQUIDATION oracle price as the health read.
 *
 * Rounds the raw amount DOWN so removing it never pushes the loan past target
 * (the top-up mirror rounds UP for the same reason in its direction). A zero
 * debt makes the ENTIRE live collateral spare — returned as the exact raw amount,
 * never a float round-trip. Returns null (fail closed) when any fact is
 * unreadable — the caller must NOT fabricate a spare from a bad read.
 */
export function computePerbotRemovableSpare(f: RemovableSpareFacts): RemovableSpare | null {
  const targetLtv = f.targetLtv ?? PERBOT_CARVE_DEFAULT_TARGET_LTV;
  if (!inUnitRange(targetLtv)) return null;
  if (!isFiniteNum(f.debtUsd) || f.debtUsd < 0) return null;
  if (!isFiniteNum(f.collateralValueUsd) || f.collateralValueUsd < 0) return null;
  if (!isFiniteNum(f.collateralPriceUsd) || f.collateralPriceUsd <= 0) return null;
  if (!isDecimals(f.collateralDecimals)) return null;
  if (f.collateralRaw < 0n) return null;

  const scale = 10 ** f.collateralDecimals;
  const toView = (raw: bigint): RemovableSpare => ({
    removableRaw: raw,
    removableTokens: Number(raw) / scale,
    removableUsd: (Number(raw) / scale) * f.collateralPriceUsd,
    targetLtv,
  });

  // No debt -> the whole position is spare (exact raw, no float round-trip).
  if (f.debtUsd === 0) return toView(f.collateralRaw);

  const requiredCollateralUsd = f.debtUsd / targetLtv;
  const spareUsd = f.collateralValueUsd - requiredCollateralUsd;
  if (spareUsd <= 0) return toView(0n);

  const spareTokens = spareUsd / f.collateralPriceUsd;
  if (!isFiniteNum(spareTokens)) return null;
  if (spareTokens <= 0) return toView(0n);

  // Round DOWN so the remainder can never land past the target LTV.
  let rawFloor = BigInt(Math.floor(spareTokens * scale));
  if (rawFloor <= 0n) return toView(0n);
  if (rawFloor > f.collateralRaw) rawFloor = f.collateralRaw; // never more than held
  return toView(rawFloor);
}

/**
 * Derive the removable spare from the SAME raw facts the health read uses (a
 * LivePositionHealth + BorrowVaultConfig). Mirrors derivePerbotTopUpSuggestion's
 * extraction (liquidation oracle price, decimals) so spare and health agree.
 * Null (fail closed) on any unreadable fact.
 */
export function derivePerbotRemovableSpare(
  live: LivePositionHealth | null,
  vault: BorrowVaultConfig | null,
  targetLtv?: number,
): RemovableSpare | null {
  if (!vault || !live) return null;
  if (!isDecimals(vault.collateralDecimals) || !isDecimals(vault.debtDecimals)) {
    return null;
  }
  let collateralRaw: bigint;
  let debtRaw: bigint;
  try {
    collateralRaw = BigInt(live.collateralRaw);
    debtRaw = BigInt(live.debtRaw);
  } catch {
    return null;
  }
  const price = vault.oraclePriceLiquidateUsd;
  if (!isFiniteNum(price) || price <= 0) return null;
  if (!inUnitRange(vault.liquidationThreshold)) return null;
  const debtUsd = Number(debtRaw) / 10 ** vault.debtDecimals;
  const colTokens = Number(collateralRaw) / 10 ** vault.collateralDecimals;
  const collateralValueUsd = colTokens * price;
  return computePerbotRemovableSpare({
    debtUsd,
    collateralValueUsd,
    collateralPriceUsd: price,
    collateralDecimals: vault.collateralDecimals,
    collateralRaw,
    targetLtv,
  });
}
