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

import { BORROW_RISK_POLICY } from "./borrow-risk-policy";
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
