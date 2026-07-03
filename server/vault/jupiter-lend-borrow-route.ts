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

import { PublicKey, Transaction } from "@solana/web3.js";
import { getServerConnection } from "../agent-wallet";
import { BORROW_PREVIEW_ASSUMPTIONS } from "./borrow-preview-assumptions";
import {
  positionRawToNativeRaw,
  scaleByExchangePrice,
  parseExchangePricesReturn,
  type VaultExchangePrices,
} from "./borrow-engine-core";

/** Read-only signer used for on-chain account derivation in simulate/read calls. */
const READONLY_SIGNER = new PublicKey("11111111111111111111111111111111");

/**
 * Program addresses for the getExchangePrices simulate (pinned; the vaults id is
 * ALSO asserted against the SDK's own program at runtime, so an SDK upgrade that
 * moves programs fails closed instead of deriving wrong PDAs).
 */
const VAULTS_PROGRAM_ID = new PublicKey("jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi");
const LIQUIDITY_PROGRAM_ID = new PublicKey("jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC");
/** Funded fee payer for read-only simulates (same fallback the SDK itself uses). */
const SIMULATE_FEE_PAYER = new PublicKey("HEyJLdMfZhhQ7FHCtjD5DWDFNFQhaeAVAsHeWqoY6dSD");

/** Exchange prices move only with interest accrual — a short cache is safe and
 * saves one simulate per read. E only GROWS, so a cached (slightly older, thus
 * slightly smaller) E makes the repay cap MORE conservative, never less. */
const EXCHANGE_PRICE_CACHE_MS = 30_000;

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
  /**
   * DEBT-TOKEN liquidity-market utilization (decoded borrowLimitUtilization).
   * WARNING: this is a market-wide metric shared by every vault with the same
   * debt token, NOT per-vault — and on WSOL markets it reads >1 (verified live
   * 2026-07-03: 2.652 on ALL WSOL-debt vaults), so it is unusable as a 0..1
   * fraction there. Do not gate loop opens on it.
   */
  utilization: number;
  /**
   * Per-vault WITHDRAW-side utilization: 1 − withdrawableUntilLimit /
   * totalSupplyLiquidity (fraction 0..1). Measures how much of the vault's
   * supplied collateral is NOT instantly withdrawable — the figure that
   * predicts whether an unwind's withdraw leg could be blocked. null when the
   * source fields are missing/unreadable (loop policy fails closed on null).
   */
  withdrawUtilization: number | null;
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

/** Live health of an EXISTING on-chain position. All raw amounts are NATIVE
 * token units representing TRUE amounts: the SDK's normalized max(decimals,9)
 * scale AND the vault exchange prices (interest accrual index) are both
 * converted away at the read boundary, so the whole engine speaks
 * native-units-of-what-is-actually-owed/held consistently. */
export interface LivePositionHealth {
  vaultId: number;
  positionId: number;
  /** NATIVE collateral-token raw, TRUE amount = colRaw × supply exchange price
   * (FLOORED — never over-reports the asset). */
  collateralRaw: string;
  /** NATIVE debt-token (USDC) raw, TRUE owed = debtRaw × borrow exchange price
   * (CEIL'd — never under-reports the liability). */
  debtRaw: string;
  /**
   * NATIVE debt-token raw, FLOORED from (ledgerRaw − 1) × borrow exchange price
   * — the MOST an exact partial repay may pass so it can never overshoot the
   * true on-chain debt (VaultUserDebtTooLow): repaying X burns ~X/E + 1 ledger
   * units and E only grows after this read, so the burn stays ≤ the ledger
   * balance.
   */
  maxRepayNativeRaw: string;
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
  if (!v || !v.borrowToken) return null;
  if (String(v.borrowToken.symbol || "").toUpperCase() !== "USDC") return null;
  return decodeVaultConfigAnyDebt(v);
}

/** Wrapped SOL mint — the debt token of every SOL Loop Vault (pinned by MINT, not symbol). */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Loop-vault variant of `decodeVaultConfig`: accepts ONLY WSOL-debt vaults,
 * pinned by the debt MINT (never by symbol — symbols are impersonatable).
 * Numeric fields keep their `...Usd` names but are DEBT-TOKEN (SOL) denominated
 * for these vaults: Jupiter's pegged-vault oracle prices the collateral in the
 * debt token (verified live 2026-07-03: vault 47 oraclePriceLiquidate ≈ 1.391 =
 * mSOL/SOL rate, NOT $). Ratio math (LTV / health factor) stays unit-consistent
 * as long as config and position come from the SAME vault.
 */
export function decodeLoopVaultConfig(v: any): BorrowVaultConfig | null {
  if (!v || !v.borrowToken) return null;
  if (String(v.borrowToken.address || "") !== WSOL_MINT) return null;
  return decodeVaultConfigAnyDebt(v);
}

/** Shared decode body — debt-token acceptance is the CALLER's gate (see wrappers above). */
function decodeVaultConfigAnyDebt(v: any): BorrowVaultConfig | null {
  try {
    if (!v || !v.supplyToken || !v.borrowToken) return null;

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

    // Per-vault withdraw-side utilization (see interface doc). Nullable on
    // unreadable inputs rather than failing the whole decode, so the USDC
    // borrow dashboard keeps working if the API ever drops these fields; the
    // loop open policy fails closed on null.
    let withdrawUtilization: number | null = null;
    {
      const ts = Number(v.totalSupplyLiquidity);
      const wd = Number(v.withdrawableUntilLimit);
      // wd > ts is impossible on a coherent read (can't withdraw more than is
      // supplied) — treat it as unreadable (null → loop policy denies) instead
      // of clamping to 0, which would be the MOST permissive value. Allow a
      // tiny tolerance for rounding between the two REST fields.
      if (Number.isFinite(ts) && ts > 0 && Number.isFinite(wd) && wd >= 0 && wd <= ts * 1.001) {
        withdrawUtilization = Math.min(Math.max(1 - Math.min(wd, ts) / ts, 0), 1);
      }
    }

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
      withdrawUtilization,
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
   * Decoded config for a SOL Loop Vault, keyed by VAULT ID (the authority — a
   * collateral mint is AMBIGUOUS: JupSOL alone has WSOL-debt vault 4 plus
   * USDC/USDG/EURC/USDS/... siblings sharing the same mint). Accepts ONLY
   * WSOL-debt vaults via `decodeLoopVaultConfig` (fail closed on anything else).
   */
  async getLoopVaultConfig(vaultId: number): Promise<BorrowVaultConfig | null> {
    try {
      if (!Number.isInteger(vaultId) || vaultId <= 0) return null;
      const { Client } = await import("@jup-ag/lend/api");
      const client = new Client();
      const vaults = await client.borrow.getVaults();
      const v = vaults.find((x: any) => Number(x?.id) === vaultId);
      if (!v) return null;
      return decodeLoopVaultConfig(v);
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
    const config = await this.getVaultConfig(collateralMint).catch(() => null);
    if (!config) return null;
    return this.readOraclePriceForConfig(config);
  }

  /**
   * On-chain oracle read for an ALREADY-RESOLVED vault config (shared by the
   * USDC-borrow and loop-vault paths — the config's own oracle address keeps the
   * price in that vault's native denomination: $ for USDC vaults, SOL for loop
   * vaults).
   */
  private async readOraclePriceForConfig(config: BorrowVaultConfig): Promise<number | null> {
    try {
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

  /** Per-vault exchange-price cache (tiny + bounded: one entry per borrow vault). */
  private exchangePriceCache = new Map<number, { at: number; prices: VaultExchangePrices }>();

  /**
   * Live vault exchange prices — the interest accrual index that converts the
   * venue's RAW ledger units into TRUE amounts (owed = debtRaw × borrow price;
   * collateral = colRaw × supply price; both ÷1e12). The SDK does not export its
   * internal getExchangePrices, so this replicates it: simulate the program's
   * read-only `getExchangePrices` instruction and parse the return data
   * (4 LE u128s). Fail closed (null) on ANY failure, wrong program id, missing
   * return log, or out-of-bounds price — a garbage price must never scale debt.
   */
  async getVaultExchangePrices(config: BorrowVaultConfig): Promise<VaultExchangePrices | null> {
    try {
      const cached = this.exchangePriceCache.get(config.vaultId);
      if (cached && Date.now() - cached.at < EXCHANGE_PRICE_CACHE_MS) return cached.prices;

      const borrow = await import("@jup-ag/lend/borrow");
      const BN = (await import("bn.js")).default;
      const connection = getServerConnection();
      const program = borrow.getVaultsProgram({ connection, signer: READONLY_SIGNER });
      // The PDA seeds below are derived against the PINNED vaults program id; if
      // the SDK ever moves to a different program, our derivation would be wrong
      // — fail closed instead.
      if (!program.programId.equals(VAULTS_PROGRAM_ID)) return null;

      const vaultIdLe = new BN(config.vaultId).toArrayLike(Buffer, "le", 2);
      const [vaultState] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault_state"), vaultIdLe],
        VAULTS_PROGRAM_ID,
      );
      const [vaultConfig] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault_config"), vaultIdLe],
        VAULTS_PROGRAM_ID,
      );
      const [supplyTokenReserves] = PublicKey.findProgramAddressSync(
        [Buffer.from("reserve"), new PublicKey(config.collateralMint).toBuffer()],
        LIQUIDITY_PROGRAM_ID,
      );
      const [borrowTokenReserves] = PublicKey.findProgramAddressSync(
        [Buffer.from("reserve"), new PublicKey(config.debtMint).toBuffer()],
        LIQUIDITY_PROGRAM_ID,
      );

      const ix = await (program.methods as any)
        .getExchangePrices()
        .accounts({ vaultState, vaultConfig, supplyTokenReserves, borrowTokenReserves })
        .instruction();
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      tx.feePayer = SIMULATE_FEE_PAYER;
      const sim = await connection.simulateTransaction(tx);
      if (sim.value.err) return null;
      const retLog = sim.value.logs?.find((l) => l.startsWith("Program return:"));
      if (!retLog) return null;
      const parts = retLog.split(" ");
      const b64 = parts[3];
      if (!b64) return null;
      const prices = parseExchangePricesReturn(Buffer.from(b64, "base64"));
      if (!prices) return null;

      this.exchangePriceCache.set(config.vaultId, { at: Date.now(), prices });
      return prices;
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
      if (finalPos.colRaw == null || finalPos.debtRaw == null) return null;

      // getFinalPosition returns RAW LEDGER units normalized to max(decimals, 9)
      // dp like getCurrentPosition; scale by the vault exchange prices (TRUE
      // amounts) then convert to NATIVE so this on-chain simulate is directly
      // comparable to the native-unit `previewBorrow` it cross-checks.
      // Both FLOORED (an advisory cross-check, not a liability of record).
      const exPrices = await this.getVaultExchangePrices(config);
      if (!exPrices) return null;
      const collateralRaw = positionRawToNativeRaw(
        scaleByExchangePrice(BigInt(finalPos.colRaw.toString()), exPrices.vaultSupplyExchangePrice, "floor"),
        config.collateralDecimals,
        "floor",
      );
      const debtRaw = positionRawToNativeRaw(
        scaleByExchangePrice(BigInt(finalPos.debtRaw.toString()), exPrices.vaultBorrowExchangePrice, "floor"),
        config.debtDecimals,
        "floor",
      );

      const oraclePriceUsd = await this.readOraclePriceUsd(collateralMint);
      return {
        vaultId: config.vaultId,
        resultTick: Number(finalPos.tick),
        collateralRaw: collateralRaw.toString(),
        debtRaw: debtRaw.toString(),
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
    const config = await this.getVaultConfig(collateralMint).catch(() => null);
    if (!config) return null;
    return this.readLiveHealthForConfig(config, positionId);
  }

  /**
   * Loop-vault variant: live health keyed by VAULT ID (never by collateral
   * mint — JupSOL/mSOL each have several sibling vaults sharing the mint, and a
   * mint-keyed read would query the position id in the WRONG vault, potentially
   * reading a DIFFERENT USER's position with the same numeric id). Fail closed
   * (null) unless the vault decodes as a WSOL-debt loop vault. All amounts are
   * SOL-denominated (see `decodeLoopVaultConfig`).
   */
  async readLoopLivePositionHealth(
    vaultId: number,
    positionId: number,
  ): Promise<LivePositionHealth | null> {
    const config = await this.getLoopVaultConfig(vaultId).catch(() => null);
    if (!config) return null;
    return this.readLiveHealthForConfig(config, positionId);
  }

  /** Shared live-position read for an ALREADY-RESOLVED vault config. */
  private async readLiveHealthForConfig(
    config: BorrowVaultConfig,
    positionId: number,
  ): Promise<LivePositionHealth | null> {
    try {
      const borrow = await import("@jup-ag/lend/borrow");
      const connection = getServerConnection();

      const pos = await borrow.getCurrentPosition({
        vaultId: config.vaultId,
        positionId,
        connection,
      });
      if (!pos) return null;
      // Money GATE: an unreadable amount is NOT zero. A `?? "0"` fallback would
      // under-report the liability (and falsely pass the repay / empty-reuse
      // gates downstream), so fail CLOSED on a missing colRaw/debtRaw.
      if (pos.colRaw == null || pos.debtRaw == null) return null;

      // The SDK returns RAW LEDGER units (not amounts!) normalized to
      // max(decimals, 9) dp. True owed = raw × vaultBorrowExchangePrice; true
      // collateral = raw × vaultSupplyExchangePrice (the accrual index; verified
      // on-chain — treating raw as an amount understates debt by the accrued
      // interest, ~3.6% on vault 43). Scale by the live exchange prices, then
      // convert to NATIVE token units, ONCE here, so the whole engine (display,
      // health, repay cap, verify, storage) speaks true native amounts:
      // collateral FLOORED (asset), debt CEIL'd (liability).
      const exPrices = await this.getVaultExchangePrices(config);
      if (!exPrices) return null; // unreadable accrual index ⇒ amounts unknowable ⇒ fail closed
      const colPositionRaw = BigInt(pos.colRaw.toString());
      const debtPositionRaw = BigInt(pos.debtRaw.toString());
      const collateralRaw = positionRawToNativeRaw(
        scaleByExchangePrice(colPositionRaw, exPrices.vaultSupplyExchangePrice, "floor"),
        config.collateralDecimals,
        "floor",
      );
      const debtRaw = positionRawToNativeRaw(
        scaleByExchangePrice(debtPositionRaw, exPrices.vaultBorrowExchangePrice, "ceil"),
        config.debtDecimals,
        "ceil",
      );
      // Repay CAP: scale (ledger − 1 unit) and FLOOR. Repaying amount X burns
      // ~X/E_exec + 1 ledger units; E_exec ≥ E_read (E is monotone
      // non-decreasing, and the 30s cache only makes E_read smaller/safer), so
      // the burn ≤ (ledger − 1) + 1 = ledger — an exact cap-sized repay can
      // never trip VaultUserDebtTooLow.
      const maxRepayNativeRaw = positionRawToNativeRaw(
        scaleByExchangePrice(
          debtPositionRaw > 0n ? debtPositionRaw - 1n : 0n,
          exPrices.vaultBorrowExchangePrice,
          "floor",
        ),
        config.debtDecimals,
        "floor",
      );

      const oraclePriceUsd = await this.readOraclePriceForConfig(config);
      return {
        vaultId: config.vaultId,
        positionId,
        collateralRaw: collateralRaw.toString(),
        debtRaw: debtRaw.toString(),
        maxRepayNativeRaw: maxRepayNativeRaw.toString(),
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
