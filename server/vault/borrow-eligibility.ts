/**
 * BORROW PREVIEW ELIGIBILITY — Phase C, brick #4 (NON-money, read-only).
 *
 * The seam the read-only preview route (and, later, the money path) uses to ask
 * "could this borrow be authorized, and what would it look like?". It assembles
 * the enforced gate's input from LIVE on-chain reads + the platform exposure
 * cache + the launch allowlist, runs `evaluateBorrowRequest`, and returns BOTH:
 *   - a PROJECTION (LTV / health / collateral value) that is always useful, and
 *   - the honest DECISION (currently fail-closed; see oracle note below).
 *
 * Split, mirroring borrow-risk-policy.ts:
 *   - `evaluateBorrowPreview` is PURE (facts in → response out): short-circuits
 *     on an unreadable vault or an unreadable exposure book, else runs the gate.
 *     Fully testable with no I/O.
 *   - `previewBorrowEligibility` is the thin async wrapper that does the I/O.
 *
 * ORACLE FRESHNESS: the oracle publish age + 1h price move are read by an
 * injected `readBorrowOracleContext(vault)` (see `borrow-oracle-freshness.ts`),
 * which itself fails closed to {null,null} on ANY uncertainty. So a vault with no
 * verified feed mapping, or any unreadable Hermes read, still makes the enforced
 * gate fail closed (`oracle_unreadable` / `price_move_unreadable`). The
 * `UNREADABLE_ORACLE_CONTEXT` constant below is retained for the vault-unreadable
 * short-circuit (no vault → nothing to read) and for tests.
 */

import {
  evaluateBorrowRequest,
  type BorrowPolicyInput,
  type BorrowPolicyDecision,
  type BorrowExposureContext,
  type BorrowOracleContext,
} from "./borrow-risk-policy";
import {
  buildBorrowExposureContext,
  type BorrowExposureResult,
} from "./borrow-exposure-context";
import type { BorrowVaultConfig } from "./jupiter-lend-borrow-route";
import {
  isCollateralVaultAllowlisted,
  isBorrowAllowlisted,
  isBorrowOwnerWallet,
} from "./borrow-allowlist";

/**
 * Unreadable oracle reading (both null) → enforced gate fails closed. Retained
 * for the vault-unreadable short-circuit (no vault → nothing to read), the
 * throwing-reader guard in `previewBorrowEligibility`, and tests.
 */
export const UNREADABLE_ORACLE_CONTEXT: BorrowOracleContext = {
  publishAgeSec: null,
  priceMove1hAbs: null,
};

const NOT_LIVE_REASON =
  "Borrowing is in read-only preview. The beta allowlist and borrow execution are not enabled yet.";

export interface BorrowPreviewFacts {
  walletAddress: string;
  /** Resolved on-chain vault config, or null when unreadable. */
  vault: BorrowVaultConfig | null;
  /** Result of building the platform exposure book (only meaningful when vault present). */
  exposureResult: BorrowExposureResult | null;
  collateralRaw: bigint;
  existingDebtRaw: bigint;
  requestedDebtRaw: bigint;
  oracle: BorrowOracleContext;
}

export interface BorrowPreviewResponse {
  /** True only when we could fully EVALUATE the request (not "allowed"). */
  ok: boolean;
  /** The enforced gate's decision. */
  allowed: boolean;
  collateral: {
    vaultId: number;
    symbol: string;
    mint: string;
    decimals: number;
  } | null;
  /** Always populated when the vault is readable; independent of allow/deny. */
  projection: {
    collateralValueUsd: number | null;
    projectedLtv: number | null;
    projectedHealthFactor: number | null;
    effectiveMaxLtv: number | null;
    projectedDebtUsd: number | null;
    maxAllowedAdditionalDebtRaw: string | null;
  } | null;
  decision: BorrowPolicyDecision | null;
  reasons: { code: string; severity: string; message: string; facts?: Record<string, unknown> }[];
  notLiveReason: string;
}

/**
 * PURE: facts → preview response. Short-circuits fail-closed on an unreadable
 * vault or unreadable exposure book; otherwise runs the enforced gate.
 */
export function evaluateBorrowPreview(f: BorrowPreviewFacts): BorrowPreviewResponse {
  if (!f.vault) {
    return {
      ok: false,
      allowed: false,
      collateral: null,
      projection: null,
      decision: null,
      reasons: [
        {
          code: "vault_unreadable",
          severity: "deny",
          message: "Could not read the borrow vault on-chain; refusing to preview.",
        },
      ],
      notLiveReason: NOT_LIVE_REASON,
    };
  }

  const collateral = {
    vaultId: f.vault.vaultId,
    symbol: f.vault.collateralSymbol,
    mint: f.vault.collateralMint,
    decimals: f.vault.collateralDecimals,
  };

  if (!f.exposureResult || !f.exposureResult.ok || !f.exposureResult.exposure) {
    const reasons = (f.exposureResult?.reasons ?? [
      { code: "exposure_unreadable", message: "Platform borrow exposure is unreadable; refusing to preview." },
    ]).map((r) => ({ code: r.code, severity: "deny", message: r.message, facts: r.facts }));
    return {
      ok: false,
      allowed: false,
      collateral,
      projection: null,
      decision: null,
      reasons,
      notLiveReason: NOT_LIVE_REASON,
    };
  }

  const exposure: BorrowExposureContext = f.exposureResult.exposure;

  const input: BorrowPolicyInput = {
    scope: "account",
    walletAddress: f.walletAddress,
    isOwnerWallet: isBorrowOwnerWallet(f.walletAddress),
    isBorrowAllowlisted: isBorrowAllowlisted(f.walletAddress),
    collateralAllowlisted: isCollateralVaultAllowlisted(f.vault.vaultId),
    collateralMint: f.vault.collateralMint,
    collateralSymbol: f.vault.collateralSymbol,
    collateralRaw: f.collateralRaw,
    existingDebtRaw: f.existingDebtRaw,
    requestedDebtRaw: f.requestedDebtRaw,
    vault: f.vault,
    exposure,
    oracle: f.oracle,
  };

  const decision = evaluateBorrowRequest(input);

  return {
    ok: true,
    allowed: decision.allowed,
    collateral,
    projection: {
      collateralValueUsd: decision.collateralValueUsd,
      projectedLtv: decision.projectedLtv,
      projectedHealthFactor: decision.projectedHealthFactor,
      effectiveMaxLtv: decision.effectiveMaxLtv,
      projectedDebtUsd: decision.projectedDebtUsd,
      maxAllowedAdditionalDebtRaw: decision.maxAllowedAdditionalDebtRaw,
    },
    decision,
    reasons: decision.reasons.map((r) => ({ code: r.code, severity: r.severity, message: r.message, facts: r.facts })),
    notLiveReason: NOT_LIVE_REASON,
  };
}

export interface PreviewBorrowParams {
  collateralMint: string;
  collateralRaw: bigint;
  requestedDebtRaw: bigint;
}

export interface BorrowEligibilityDeps {
  getVaultConfig: (collateralMint: string) => Promise<BorrowVaultConfig | null>;
  getActiveBorrowPositionsAllWallets: () => Promise<
    {
      status: string;
      collateralMint: string;
      collateralAssetKey: string;
      debtAssetKey: string;
      debtMint: string;
      debtAmountRaw: string;
      walletAddress: string;
    }[]
  >;
  /**
   * Reads the collateral oracle's freshness facts (publish age + 1h move) for a
   * resolved vault. MUST fail closed to {null,null} on any uncertainty; the
   * enforced gate turns either null into a hard deny.
   */
  readBorrowOracleContext: (vault: BorrowVaultConfig) => Promise<BorrowOracleContext>;
}

/**
 * Thin async wrapper: does the live I/O, then calls the pure evaluator.
 * `existingDebtRaw` is the caller wallet's own current debt for THIS collateral
 * (account scope), summed from the cache — used by the gate for the per-position
 * projection. The platform-wide exposure is built separately for the breakers.
 */
export async function previewBorrowEligibility(
  walletAddress: string,
  params: PreviewBorrowParams,
  deps: BorrowEligibilityDeps,
): Promise<BorrowPreviewResponse> {
  const vault = await deps.getVaultConfig(params.collateralMint);

  if (!vault) {
    return evaluateBorrowPreview({
      walletAddress,
      vault: null,
      exposureResult: null,
      collateralRaw: params.collateralRaw,
      existingDebtRaw: BigInt(0),
      requestedDebtRaw: params.requestedDebtRaw,
      oracle: UNREADABLE_ORACLE_CONTEXT,
    });
  }

  const rows = await deps.getActiveBorrowPositionsAllWallets();

  // Platform-wide exposure book for the aggregate + concentration breakers. The
  // vault's own debtMint is the on-chain-authoritative USDC mint we verify every
  // counted row against.
  const exposureResult = buildBorrowExposureContext(rows, params.collateralMint, vault.debtMint, {});

  // This caller wallet's current debt for THIS collateral (account scope only),
  // for the per-position projection. Mirrors the exposure builder's validity
  // rules; an unreadable own-row leaves existingDebt at 0 only because the
  // platform exposure book (above) will already have failed closed on it.
  let existingDebtRaw = BigInt(0);
  for (const r of rows) {
    if (r.walletAddress !== walletAddress) continue;
    if (r.collateralMint !== params.collateralMint) continue;
    if (r.status === "closed" || r.status === "failed") continue;
    if (String(r.debtAssetKey).toLowerCase() !== "usdc" || r.debtMint !== vault.debtMint) continue;
    try {
      const v = BigInt(r.debtAmountRaw);
      if (v > BigInt(0)) existingDebtRaw += v;
    } catch {
      /* platform exposure book already fails closed on this row */
    }
  }

  // Oracle freshness for THIS vault. The reader fails closed to {null,null} on
  // any uncertainty (unmapped feed, unreadable Hermes, wrong-map cross-check),
  // which the enforced gate turns into a hard deny. Belt-and-suspenders: if a
  // (future/custom) injected reader THROWS instead of returning structured
  // nulls, swallow it to UNREADABLE so a faulty DI caller still gets a deny —
  // never a 500 that skips the oracle gate. The production reader already
  // catches internally.
  let oracle: BorrowOracleContext;
  try {
    oracle = await deps.readBorrowOracleContext(vault);
  } catch {
    oracle = UNREADABLE_ORACLE_CONTEXT;
  }

  return evaluateBorrowPreview({
    walletAddress,
    vault,
    exposureResult,
    collateralRaw: params.collateralRaw,
    existingDebtRaw,
    requestedDebtRaw: params.requestedDebtRaw,
    oracle,
  });
}
