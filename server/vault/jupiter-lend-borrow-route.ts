/**
 * Jupiter Lend (on Fluid) BORROW route — READ-ONLY health + preview layer.
 * Phase B of the borrow/carry engine: it reads loan-risk facts and projects a
 * hypothetical borrow's health, but it NEVER moves money. There are no
 * getOperateIx / init / liquidate calls in this file by design.
 *
 * Money-safety contract (mirrors jupiter-lend-route.ts):
 *   - On-chain is the authority. Every read returns null when the source is
 *     unreadable or fails an assertion. It NEVER falls back to a guess.
 *   - @jup-ag/lend is imported LAZILY inside methods (no top-level import), so a
 *     heavy/throwing SDK import can never break unrelated routes or startup.
 *   - BN is imported from 'bn.js', never from anchor.
 *
 * Read split (verified Phase A + B on mainnet):
 *   - REST `@jup-ag/lend/api` getVaults() = vault CONFIG + dashboard reads. It
 *     powers `previewBorrow` (a UI projection, not a money gate).
 *   - On-chain `@jup-ag/lend/borrow` = the authority for a money decision:
 *     readOraclePrice (price the protocol uses), getFinalPosition (simulate),
 *     getCurrentPosition (an existing position's live health).
 *
 * Scale constants confirmed against the live INF→USDC vault (id 43, 2026-06-24):
 *   collateralFactor 750 → 0.75 (÷1000), liquidationThreshold 800 → 0.80 (÷1000),
 *   liquidationPenalty 500 → 0.05 (÷10000, i.e. bps), borrowRate 466 → 4.66% APR
 *   (÷10000), borrowLimitUtilization + oraclePrice* scaled ÷1e15.
 */

import { PublicKey } from "@solana/web3.js";
import { getServerConnection } from "../agent-wallet";
import { BORROW_PREVIEW_ASSUMPTIONS } from "./borrow-preview-assumptions";

/** Read-only signer used for on-chain account derivation in simulate/read calls. */
const READONLY_SIGNER = new PublicKey("11111111111111111111111111111111");

/** Scaled-fixed-point decoders (confirmed on the live INF vault). */
const SCALE_FACTOR = 1000; // collateralFactor / liquidationThreshold
const SCALE_PENALTY = 10000; // liquidationPenalty (basis points)
const SCALE_RATE = 10000; // borrowRate / supplyRate (basis points)
const SCALE_1E15 = 1e15; // borrowLimitUtilization + oraclePrice*

/** raw → fraction (e.g. "750" → 0.75). */
export function decodeFactorToFraction(raw: string | number): number {
  return Number(raw) / SCALE_FACTOR;
}
/** raw bps → fraction (e.g. "500" → 0.05). */
export function decodePenaltyToFraction(raw: string | number): number {
  return Number(raw) / SCALE_PENALTY;
}
/** raw bps → APR fraction (e.g. "466" → 0.0466). */
export function decodeRateToFraction(raw: string | number): number {
  return Number(raw) / SCALE_RATE;
}
/** raw 1e15-scaled → fraction/price (e.g. utilization or USD oracle price). */
export function decode1e15(raw: string | number): number {
  return Number(raw) / SCALE_1E15;
}

/** Decoded, money-decision-ready view of a borrow vault's config. */
export interface BorrowVaultConfig {
  vaultId: number;
  vaultAddress: string;
  oracleAddress: string;
  collateralMint: string;
  collateralSymbol: string;
  collateralDecimals: number;
  debtMint: string;
  debtSymbol: string;
  debtDecimals: number;
  /** Max LTV the protocol allows to OPEN/increase a borrow (fraction 0..1). */
  maxLtv: number;
  /** LTV at which liquidation begins (fraction 0..1). */
  liquidationThreshold: number;
  /** Liquidation penalty (fraction 0..1). */
  liquidationPenalty: number;
  /** Current borrow APR (fraction). */
  borrowApr: number;
  /** Current supply APR (fraction). */
  supplyApr: number;
  /** Borrow fee (fraction). */
  borrowFee: number;
  /** Pool utilization (fraction 0..1). */
  utilization: number;
  /** Oracle price liquidation uses, USD per collateral token. */
  oraclePriceLiquidateUsd: number;
  /** Oracle price operate uses, USD per collateral token. */
  oraclePriceOperateUsd: number;
  /** Market (reference) price of collateral, USD. */
  marketPriceUsd: number;
  /** Live borrowable USDC, raw base units. */
  borrowableUsdcRaw: string;
  /** Live withdrawable collateral, raw base units. */
  withdrawableCollateralRaw: string;
  /** Minimum borrow (USDC), raw base units. */
  minimumBorrowingRaw: string;
}

/** A preview hint. `source` makes it unmistakable whether it is a protocol fact or an owner-pending UI assumption. */
export interface BorrowPreviewHint {
  code: string;
  message: string;
  /** "protocol" = a limit the protocol itself enforces; "preview_assumption" = an owner-pending UI hint, NOT enforced. */
  source: "protocol" | "preview_assumption";
}

/** Projection of a hypothetical borrow. Pure UI preview — never a money gate. */
export interface BorrowPreview {
  ok: boolean;
  reason?: string;
  /** Projected loan-to-value (fraction). */
  ltv: number | null;
  /** Health factor: >1 safe, =1 at liquidation, null when there is no debt. */
  healthFactor: number | null;
  /** Collateral USD price at which the position would hit liquidation, null when no debt. */
  liquidationPriceUsd: number | null;
  /** Max borrowable USDC (min of protocol max-LTV cap and live liquidity), raw base units. */
  maxBorrowUsdcRaw: string | null;
  /** Borrow at the suggested safe (preview-only) LTV, raw base units. */
  suggestedSafeBorrowUsdcRaw: string | null;
  collateralValueUsd: number | null;
  debtValueUsd: number | null;
  hints: BorrowPreviewHint[];
}

/** On-chain simulate result (the authority that cross-checks `previewBorrow`). */
export interface BorrowSimulation {
  vaultId: number;
  resultTick: number;
  collateralRaw: string;
  debtRaw: string;
  /** Best-effort decoded oracle price (USD per collateral token), null if unreadable. */
  oraclePriceUsd: number | null;
}

/** Live health of an EXISTING on-chain position. */
export interface LivePositionHealth {
  vaultId: number;
  positionId: number;
  collateralRaw: string;
  debtRaw: string;
  /** Whether the protocol marks the position as liquidatable. */
  liquidatable: boolean;
  tick: number;
  oraclePriceUsd: number | null;
}

/**
 * Builds a decoded BorrowVaultConfig from a raw REST vault object. Pure (no
 * network), so it is the single, testable decode path shared by every read.
 * Returns null if the row is not a USDC-borrow vault or is missing risk fields.
 */
export function decodeVaultConfig(v: any): BorrowVaultConfig | null {
  try {
    if (!v || !v.supplyToken || !v.borrowToken) return null;
    if (String(v.borrowToken.symbol || "").toUpperCase() !== "USDC") return null;

    const required = [
      v.collateralFactor,
      v.liquidationThreshold,
      v.liquidationPenalty,
      v.borrowRate,
      v.borrowLimitUtilization,
      v.minimumBorrowing,
      v.borrowable,
      v.withdrawable,
      v.oraclePriceLiquidate,
      v.oraclePriceOperate,
    ];
    if (required.some((x) => x === undefined || x === null || String(x).length === 0)) return null;

    const cfg: BorrowVaultConfig = {
      vaultId: Number(v.id),
      vaultAddress: String(v.address),
      oracleAddress: String(v.oracle),
      collateralMint: String(v.supplyToken.address),
      collateralSymbol: String(v.supplyToken.symbol),
      collateralDecimals: Number(v.supplyToken.decimals),
      debtMint: String(v.borrowToken.address),
      debtSymbol: String(v.borrowToken.symbol),
      debtDecimals: Number(v.borrowToken.decimals),
      maxLtv: decodeFactorToFraction(v.collateralFactor),
      liquidationThreshold: decodeFactorToFraction(v.liquidationThreshold),
      liquidationPenalty: decodePenaltyToFraction(v.liquidationPenalty),
      borrowApr: decodeRateToFraction(v.borrowRate),
      supplyApr: decodeRateToFraction(v.supplyRate ?? 0),
      borrowFee: decodeRateToFraction(v.borrowFee ?? 0),
      utilization: decode1e15(v.borrowLimitUtilization),
      oraclePriceLiquidateUsd: decode1e15(v.oraclePriceLiquidate),
      oraclePriceOperateUsd: decode1e15(v.oraclePriceOperate),
      marketPriceUsd: Number(v.supplyToken.price ?? 0),
      borrowableUsdcRaw: String(v.borrowable),
      withdrawableCollateralRaw: String(v.withdrawable),
      minimumBorrowingRaw: String(v.minimumBorrowing),
    };

    // Fail closed if any decoded number is non-finite or out of a sane range.
    // A garbled risk field must never silently produce a flattering preview.
    const finite = (n: number) => Number.isFinite(n);
    const inUnitRange = (n: number) => finite(n) && n > 0 && n <= 1; // (0, 1]
    const nonNegFinite = (n: number) => finite(n) && n >= 0;
    const isDecimals = (n: number) => Number.isInteger(n) && n >= 0 && n <= 18;
    if (
      !finite(cfg.vaultId) ||
      !isDecimals(cfg.collateralDecimals) ||
      !isDecimals(cfg.debtDecimals) ||
      !inUnitRange(cfg.maxLtv) ||
      !inUnitRange(cfg.liquidationThreshold) ||
      cfg.maxLtv > cfg.liquidationThreshold || // max-open LTV must sit below the liq threshold
      !(finite(cfg.liquidationPenalty) && cfg.liquidationPenalty >= 0 && cfg.liquidationPenalty < 1) ||
      !nonNegFinite(cfg.borrowApr) ||
      !nonNegFinite(cfg.supplyApr) ||
      !nonNegFinite(cfg.borrowFee) ||
      !nonNegFinite(cfg.utilization) ||
      !(finite(cfg.oraclePriceLiquidateUsd) && cfg.oraclePriceLiquidateUsd > 0) ||
      !(finite(cfg.oraclePriceOperateUsd) && cfg.oraclePriceOperateUsd > 0)
    ) {
      return null;
    }
    return cfg;
  } catch {
    return null;
  }
}

/**
 * Pure projection of a hypothetical borrow against a vault config. Uses the
 * oracle LIQUIDATION price (the price the protocol actually liquidates against),
 * so the health/liq-price numbers are honest rather than flattering. All hints
 * are informational; the "preview_assumption" ones come from the owner-pending
 * BORROW_PREVIEW_ASSUMPTIONS and gate nothing.
 */
export function previewBorrow(
  config: BorrowVaultConfig,
  collateralAmountRaw: bigint,
  borrowUsdcRaw: bigint,
): BorrowPreview {
  const empty: BorrowPreview = {
    ok: false,
    ltv: null,
    healthFactor: null,
    liquidationPriceUsd: null,
    maxBorrowUsdcRaw: null,
    suggestedSafeBorrowUsdcRaw: null,
    collateralValueUsd: null,
    debtValueUsd: null,
    hints: [],
  };

  if (collateralAmountRaw <= BigInt(0)) {
    return { ...empty, reason: "Collateral amount is too small" };
  }
  // Fail closed on a nonsensical (negative) borrow rather than returning ok:true.
  if (borrowUsdcRaw < BigInt(0)) {
    return { ...empty, reason: "Borrow amount cannot be negative" };
  }

  const colTokens = Number(collateralAmountRaw) / 10 ** config.collateralDecimals;
  const colPrice = config.oraclePriceLiquidateUsd;
  const collateralValueUsd = colTokens * colPrice;
  if (!(collateralValueUsd > 0)) {
    return { ...empty, reason: "Collateral has no readable value" };
  }

  const debtUsdc = Number(borrowUsdcRaw) / 10 ** config.debtDecimals;
  const ltv = debtUsdc / collateralValueUsd;
  const hasDebt = debtUsdc > 0;
  const healthFactor = hasDebt ? (collateralValueUsd * config.liquidationThreshold) / debtUsdc : null;
  const liquidationPriceUsd = hasDebt ? debtUsdc / (colTokens * config.liquidationThreshold) : null;

  const toRaw = (usd: number) => BigInt(Math.max(0, Math.floor(usd * 10 ** config.debtDecimals)));
  const maxByFactorRaw = toRaw(collateralValueUsd * config.maxLtv);
  const liveBorrowableRaw = BigInt(config.borrowableUsdcRaw);
  const maxBorrowUsdcRaw = maxByFactorRaw < liveBorrowableRaw ? maxByFactorRaw : liveBorrowableRaw;
  const suggestedSafe = BORROW_PREVIEW_ASSUMPTIONS.suggestedSafeLtv.value;
  const suggestedSafeBorrowUsdcRaw = toRaw(collateralValueUsd * suggestedSafe);

  const hints: BorrowPreviewHint[] = [];
  if (hasDebt && borrowUsdcRaw < BigInt(config.minimumBorrowingRaw)) {
    hints.push({
      code: "below_minimum",
      source: "protocol",
      message: "Below the protocol's minimum borrow amount.",
    });
  }
  if (ltv > config.maxLtv) {
    hints.push({
      code: "exceeds_protocol_max_ltv",
      source: "protocol",
      message: `Exceeds the protocol max LTV of ${(config.maxLtv * 100).toFixed(0)}%.`,
    });
  }
  if (borrowUsdcRaw > liveBorrowableRaw) {
    hints.push({
      code: "exceeds_live_borrowable",
      source: "protocol",
      message: "More than the pool currently has available to borrow.",
    });
  }
  if (ltv > suggestedSafe) {
    hints.push({
      code: "above_suggested_safe_ltv",
      source: "preview_assumption",
      message: `Above the suggested safe LTV of ${(suggestedSafe * 100).toFixed(0)}% (a cushion against liquidation).`,
    });
  }
  if (config.borrowApr > BORROW_PREVIEW_ASSUMPTIONS.borrowAprHintCeiling.value) {
    hints.push({
      code: "high_borrow_apr",
      source: "preview_assumption",
      message: `Borrow rate is high right now (${(config.borrowApr * 100).toFixed(2)}%).`,
    });
  }
  if (config.utilization > BORROW_PREVIEW_ASSUMPTIONS.utilizationHintCeiling.value) {
    hints.push({
      code: "high_utilization",
      source: "preview_assumption",
      message: "Pool is heavily utilized; withdrawing collateral may be constrained until it frees up.",
    });
  }

  return {
    ok: true,
    ltv,
    healthFactor,
    liquidationPriceUsd,
    maxBorrowUsdcRaw: maxBorrowUsdcRaw.toString(),
    suggestedSafeBorrowUsdcRaw: suggestedSafeBorrowUsdcRaw.toString(),
    collateralValueUsd,
    debtValueUsd: debtUsdc,
    hints,
  };
}

/**
 * Read-only Jupiter Lend borrow service. No method here moves money.
 */
export class JupiterLendBorrowRoute {
  readonly kind = "jupiter_lend_borrow" as const;

  /** Decoded config for the USDC-borrow vault of `collateralMint`, or null (fail closed). */
  async getVaultConfig(collateralMint: string): Promise<BorrowVaultConfig | null> {
    try {
      const { Client } = await import("@jup-ag/lend/api");
      const client = new Client();
      const vaults = await client.borrow.getVaults();
      const v = vaults.find(
        (x: any) =>
          x.supplyToken?.address === collateralMint &&
          String(x.borrowToken?.symbol || "").toUpperCase() === "USDC",
      );
      if (!v) return null;
      return decodeVaultConfig(v);
    } catch {
      return null;
    }
  }

  /**
   * Decoded configs for the LAUNCH-allowlisted borrow vaults — the read-only
   * source the UI uses to render the Borrow form (collateral symbol/decimals,
   * max LTV, live borrowable, oracle price). It is server-derived: the caller
   * passes the launch allowlist (`ALLOWED_BORROW_VAULT_IDS`); the client never
   * supplies vault ids or mints. One `getVaults()` fetch, decode each row, keep
   * only USDC-debt vaults whose decoded `vaultId` is in the allowlist. Returns
   * [] (fail closed) on any read/decoding failure — never a guessed config.
   */
  async getLaunchVaultConfigs(allowedVaultIds: ReadonlySet<number>): Promise<BorrowVaultConfig[]> {
    try {
      const { Client } = await import("@jup-ag/lend/api");
      const client = new Client();
      const vaults = await client.borrow.getVaults();
      const out: BorrowVaultConfig[] = [];
      for (const v of vaults) {
        const cfg = decodeVaultConfig(v);
        if (cfg && allowedVaultIds.has(cfg.vaultId)) out.push(cfg);
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Convenience: fetch config then project a hypothetical borrow. */
  async previewBorrowForCollateral(
    collateralMint: string,
    collateralAmountRaw: bigint,
    borrowUsdcRaw: bigint,
  ): Promise<BorrowPreview | null> {
    const config = await this.getVaultConfig(collateralMint);
    if (!config) return null;
    return previewBorrow(config, collateralAmountRaw, borrowUsdcRaw);
  }

  /**
   * Reads the on-chain oracle price the protocol uses for `collateralMint`'s
   * vault. This is the money-decision authority (REST is only a cross-check).
   * Returns USD per collateral token, or null (fail closed).
   */
  async readOraclePriceUsd(collateralMint: string): Promise<number | null> {
    try {
      const config = await this.getVaultConfig(collateralMint);
      if (!config) return null;
      const borrow = await import("@jup-ag/lend/borrow");
      const connection = getServerConnection();
      // NOTE: do NOT pass `signer`. With a signer, the SDK routes through
      // Anchor's tx `simulate` (needs a real fee-payer/blockhash) and throws;
      // omitting it does a plain account read, which is what we want here.
      const reading = await borrow.readOraclePrice({
        connection,
        oracle: new PublicKey(config.oracleAddress),
      });
      const raw = reading?.oraclePriceLiquidate ?? reading?.oraclePriceOperate;
      if (raw === undefined || raw === null) return null;
      const price = decode1e15(String(raw));
      return price > 0 ? price : null;
    } catch {
      return null;
    }
  }

  /**
   * On-chain simulate of a hypothetical borrow against a fresh (empty) position
   * via getFinalPosition. This is the on-chain authority that cross-checks the
   * REST-based `previewBorrow`. Read-only. Returns null (fail closed) on any
   * failure — e.g. if the SDK requires a real position to simulate against.
   */
  async simulateBorrowOnChain(
    collateralMint: string,
    collateralAmountRaw: bigint,
    borrowUsdcRaw: bigint,
  ): Promise<BorrowSimulation | null> {
    try {
      const config = await this.getVaultConfig(collateralMint);
      if (!config) return null;
      const borrow = await import("@jup-ag/lend/borrow");
      const BN = (await import("bn.js")).default;
      const connection = getServerConnection();
      const program = borrow.getVaultsProgram({ connection, signer: READONLY_SIGNER });

      const syntheticEmptyPosition = {
        tick: borrow.INIT_TICK,
        tickId: 0,
        colRaw: new BN(0),
        finalAmount: new BN(0),
        debtRaw: new BN(0),
        dustDebtRaw: new BN(0),
        isSupplyOnlyPosition: false,
        userLiquidationStatus: false,
        postLiquidationBranchId: 0,
      };

      const finalPos = await borrow.getFinalPosition({
        vaultId: config.vaultId,
        currentPosition: syntheticEmptyPosition as any,
        newColAmount: new BN(collateralAmountRaw.toString()),
        newDebtAmount: new BN(borrowUsdcRaw.toString()),
        program,
        connection,
        signer: READONLY_SIGNER,
      });
      if (!finalPos) return null;

      const oraclePriceUsd = await this.readOraclePriceUsd(collateralMint);
      return {
        vaultId: config.vaultId,
        resultTick: Number(finalPos.tick),
        collateralRaw: finalPos.colRaw?.toString() ?? "0",
        debtRaw: finalPos.debtRaw?.toString() ?? "0",
        oraclePriceUsd,
      };
    } catch {
      return null;
    }
  }

  /**
   * Live health of an EXISTING on-chain position (the money-decision authority
   * for an open loan). Fail closed (null) on any unreadable read.
   *
   * NOTE: end-to-end validation is DEFERRED to Phase C's first controlled
   * position — zero borrow positions exist yet, so this path cannot be exercised
   * against a real position today. The Phase B probe proves the program load,
   * the on-chain oracle read, and getFinalPosition (simulate); it does NOT
   * exercise getCurrentPosition, whose e2e proof waits on a real Phase C
   * position. This method stays fail-closed (null) until then.
   */
  async readLivePositionHealth(
    collateralMint: string,
    positionId: number,
  ): Promise<LivePositionHealth | null> {
    try {
      const config = await this.getVaultConfig(collateralMint);
      if (!config) return null;
      const borrow = await import("@jup-ag/lend/borrow");
      const connection = getServerConnection();

      const pos = await borrow.getCurrentPosition({
        vaultId: config.vaultId,
        positionId,
        connection,
      });
      if (!pos) return null;

      const oraclePriceUsd = await this.readOraclePriceUsd(collateralMint);
      return {
        vaultId: config.vaultId,
        positionId,
        collateralRaw: pos.colRaw?.toString() ?? "0",
        debtRaw: pos.debtRaw?.toString() ?? "0",
        liquidatable: Boolean(pos.userLiquidationStatus),
        tick: Number(pos.tick),
        oraclePriceUsd,
      };
    } catch {
      return null;
    }
  }

  /**
   * Reuse check for the supply path: is `positionId` an EMPTY position we can
   * re-deposit collateral into instead of MINTING a fresh NFT (~0.022 SOL rent)?
   * A full close (max repay + max withdraw) leaves the position NFT alive on-chain
   * but zeroed; this confirms it is provably empty so the caller can reuse it.
   *
   * Returns true ONLY when the on-chain position exists and collateral, debt, AND
   * dust-debt are all zero. Fail closed: any unreadable read, a non-existent
   * position, or ANY nonzero amount => false (the caller then mints fresh).
   */
  async isPositionEmptyReusable(
    collateralMint: string,
    positionId: number,
  ): Promise<boolean> {
    try {
      if (!Number.isInteger(positionId) || positionId <= 0) return false;
      const config = await this.getVaultConfig(collateralMint);
      if (!config) return false;
      const borrow = await import("@jup-ag/lend/borrow");
      const connection = getServerConnection();
      const pos = await borrow.getCurrentPosition({
        vaultId: config.vaultId,
        positionId,
        connection,
      });
      if (!pos) return false;
      // Money GATE: this proves the position is empty before we reuse (deposit
      // into) it. A missing/unparseable amount field is NOT "zero" — it is
      // unreadable, so fail CLOSED (false => caller mints fresh, always safe).
      // Never let a `?? "0"` fallback mistake an unreadable amount for empty.
      if (pos.colRaw == null || pos.debtRaw == null || pos.dustDebtRaw == null) return false;
      const col = BigInt(pos.colRaw.toString());
      const debt = BigInt(pos.debtRaw.toString());
      const dust = BigInt(pos.dustDebtRaw.toString());
      return col === 0n && debt === 0n && dust === 0n;
    } catch {
      return false;
    }
  }
}
