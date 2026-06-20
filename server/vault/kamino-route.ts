/**
 * Kamino Lend yield route (direct deposit/withdraw of USDC into the main-market
 * USDC reserve). The cToken (kUSDC) is held in the agent wallet's ATA and is a
 * yield-bearing claim: its USDC redemption value rises as interest accrues.
 *
 * Money-safety contract (same as the swap route):
 *   - On-chain is truth. valueInUsdc returns null when the reserve is missing,
 *     fails assertions, or is stale. It NEVER falls back to a 1:1 guess.
 *   - park/unpark verify the realized on-chain balance delta and fail closed on
 *     an ambiguous or zero delta.
 *
 * SDK isolation: @kamino-finance/klend-sdk is imported LAZILY inside methods, so
 * a heavy or throwing SDK import can never break the swap routes or server
 * startup. This module has no top-level klend-sdk import.
 *
 * On-chain facts verified on mainnet (see .agents/memory/kamino-usdc-onchain-facts.md):
 *   - getReserveByMint returns a DUST reserve; the canonical USDC reserve is PINNED
 *     by address and its mints/decimals are asserted on every load.
 *   - exchangeRate = collateralMintSupply / totalLiquidity (cTokens per USDC), < 1,
 *     so USDC value = kUsdcRaw / rate.
 */

import Decimal from "decimal.js";
import {
  PublicKey,
  ComputeBudgetProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  getServerConnection,
  USDC_MINT,
  TOKEN_PROGRAM_ID,
  getAgentTokenBalanceRaw,
  getAssociatedTokenAddressSync,
  createIdempotentAtaInstruction,
  executeAgentInstructions,
} from "../agent-wallet";
import type { YieldAsset } from "./yield-assets";
import type {
  YieldRoute,
  YieldRoutePreview,
  YieldRouteExecResult,
  YieldRouteValuation,
  ParkArgs,
  UnparkArgs,
} from "./yield-routes";

/** Pinned, on-chain-verified Kamino main-market USDC constants. */
export const KAMINO_PROGRAM_ID = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
export const KAMINO_MAIN_MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
/** The canonical high-TVL USDC reserve (NOT the dust reserves getReserveByMint returns). */
export const KAMINO_USDC_RESERVE = "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59";
/** kUSDC collateral (cToken) mint for that reserve. */
export const KAMINO_KUSDC_MINT = "B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D";
export const KAMINO_USDC_DECIMALS = 6;

/**
 * Treat the reserve as too stale to value from if it has not been refreshed in
 * this many slots. ~9000 slots is ~1 hour. This is a sanity guard against an RPC
 * node serving very old account data (or a frozen reserve), NOT a per-slot gate:
 * interest drift over an hour on a stablecoin reserve is negligible and the SDK's
 * estimated rate extrapolates it anyway.
 *
 * IMPORTANT (verified on mainnet): the reserve's `lastUpdate.stale` flag sits at 1
 * in normal rest and is only 0 in the exact slot someone refreshes it. So the flag
 * is NOT a usability signal and we intentionally do NOT gate on it -- doing so
 * would reject the reserve almost always. We gate on slot-distance only.
 */
export const KAMINO_RESERVE_STALE_SLOTS = 9000;

/**
 * Tolerated negative slot skew. getSlot() and getAccountInfo() are separate RPC
 * calls, so the reserve's lastUpdate.slot can legitimately read a few slots AHEAD
 * of our getSlot() result. We accept a small lead as fresh, but a reserve whose
 * lastUpdate.slot is implausibly far in the future indicates a corrupt decode or a
 * bad RPC response and must fail closed. ~150 slots is ~1 min.
 */
export const KAMINO_MAX_SLOT_SKEW = 150;

const VALUATION_SOURCE = "redemption_rate";

/** High-precision, round-down Decimal so base-unit conversions never round up funds. */
const D = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_DOWN });

/**
 * Reserve is fresh enough to value from. Gated on slot-distance only (see
 * KAMINO_RESERVE_STALE_SLOTS for why the on-chain stale flag is ignored). A small
 * negative `behind` (reserve read at a slot slightly NEWER than our separate
 * getSlot() result, i.e. RPC node skew) is treated as fresh; an implausibly far
 * future lastUpdate slot fails closed.
 */
export function isReserveFresh(
  lastUpdateSlot: number,
  currentSlot: number,
  staleSlots: number = KAMINO_RESERVE_STALE_SLOTS,
): boolean {
  if (!Number.isFinite(lastUpdateSlot) || !Number.isFinite(currentSlot)) return false;
  const behind = currentSlot - lastUpdateSlot;
  return behind >= -KAMINO_MAX_SLOT_SKEW && behind <= staleSlots;
}

/**
 * USDC base units redeemable for `kusdcRaw` cTokens at `rate` (cTokens per USDC).
 * value = kUsdcRaw / rate, floored. Returns null on a non-positive/invalid rate.
 */
export function usdcValueFromKusdcRaw(kusdcRaw: bigint, rate: Decimal.Value): string | null {
  if (kusdcRaw <= BigInt(0)) return "0";
  try {
    const r = new D(rate);
    if (!r.isFinite() || r.lte(0)) return null;
    const usdc = new D(kusdcRaw.toString()).div(r).floor();
    if (!usdc.isFinite() || usdc.lt(0)) return null;
    return usdc.toFixed(0);
  } catch {
    return null;
  }
}

/**
 * cToken (kUSDC) base units minted for depositing `usdcRaw` USDC at `rate`
 * (cTokens per USDC). amount = usdcRaw * rate, floored. Estimate only; the real
 * minted amount is the measured on-chain delta.
 */
export function kusdcFromUsdcRaw(usdcRaw: bigint, rate: Decimal.Value): string | null {
  if (usdcRaw <= BigInt(0)) return "0";
  try {
    const r = new D(rate);
    if (!r.isFinite() || r.lte(0)) return null;
    const kusdc = new D(usdcRaw.toString()).mul(r).floor();
    if (!kusdc.isFinite() || kusdc.lt(0)) return null;
    return kusdc.toFixed(0);
  } catch {
    return null;
  }
}

interface LoadedReserve {
  /**
   * The pinned, asserted, fresh KaminoReserve (klend-sdk type; the SDK is loaded
   * via dynamic import so we keep it `any` to avoid a top-level type import).
   */
  reserve: any;
  /** estimated current exchange rate (cTokens per USDC). */
  rate: Decimal;
}

/**
 * Loads the pinned USDC reserve, asserts it is the right account, gates on
 * freshness, and returns the reserve plus the estimated current exchange rate.
 * Returns null on any failure (fail closed). Never throws.
 *
 * This is the SINGLE assert path: both read-only valuation and the park/unpark
 * instruction builder depend on it, so the money-safety asserts (program owner,
 * liquidity/cToken mints, decimals, freshness) can never drift between read and
 * write.
 */
async function loadFreshUsdcReserve(connection: Connection): Promise<LoadedReserve | null> {
  try {
    const klend = await import("@kamino-finance/klend-sdk");
    const programId = new PublicKey(KAMINO_PROGRAM_ID);
    const reservePk = new PublicKey(KAMINO_USDC_RESERVE);

    const acc = await connection.getAccountInfo(reservePk);
    if (!acc) return null;
    // Assert the account is owned by the Kamino program before trusting the decode.
    if (!acc.owner.equals(programId)) return null;

    const reserve = await klend.getSingleReserve(reservePk, connection, 450, acc);

    // Assert this is the USDC<->kUSDC reserve we pinned, with the expected decimals.
    if (!reserve.getLiquidityMint().equals(new PublicKey(USDC_MINT))) return null;
    if (!reserve.getCTokenMint().equals(new PublicKey(KAMINO_KUSDC_MINT))) return null;
    if (reserve.state.liquidity.mintDecimals.toNumber() !== KAMINO_USDC_DECIMALS) return null;

    const currentSlot = await connection.getSlot();
    const lastSlot = Number(reserve.state.lastUpdate.slot.toString());
    if (!isReserveFresh(lastSlot, currentSlot)) return null;

    const rate = reserve.getEstimatedCollateralExchangeRate(currentSlot, 0);
    const rateD = new D(rate.toString());
    if (!rateD.isFinite() || rateD.lte(0)) return null;
    return { reserve, rate: rateD };
  } catch {
    return null;
  }
}

/**
 * SOL gas floor for a Kamino park. Covers the tx fee plus a possible first-time
 * kUSDC ATA rent (~0.002 SOL).
 */
const KAMINO_PARK_MIN_SOL_GAS = 0.01;
/** SOL gas floor for a Kamino unpark (USDC ATA normally already exists). */
const KAMINO_UNPARK_MIN_SOL_GAS = 0.005;
/** Compute-unit ceiling for a single refresh + deposit/redeem batch. */
const KAMINO_RESERVE_OP_COMPUTE_UNITS = 400_000;

/**
 * Builds the on-chain instruction batch for a Kamino reserve deposit (park) or
 * redeem (unpark), pinned to the asserted `reserve`. Mirrors the SDK's own
 * account wiring (addDepositReserveLiquidityIx / addRedeemReserveCollateralIx)
 * but PINS the reserve by address so the dust-reserve trap in getReserveByMint
 * can never apply. Returns null on any build failure (fail closed).
 *
 * Order: [computeBudget, refreshReserve, idempotent-create destination ATA,
 * deposit|redeem]. The refresh ix is required before a deposit/redeem and its
 * oracle accounts are taken from the reserve's own config (unset ones fall back
 * to the program id, matching the SDK's optionalAccount behavior).
 */
async function buildReserveInstructions(
  action: "deposit" | "redeem",
  agentPublicKey: string,
  amountRaw: bigint,
  reserve: any,
): Promise<TransactionInstruction[] | null> {
  try {
    const klend = await import("@kamino-finance/klend-sdk");
    const BN = (await import("bn.js")).default;

    const programId = new PublicKey(KAMINO_PROGRAM_ID);
    const marketPk = new PublicKey(KAMINO_MAIN_MARKET);
    const reservePk = new PublicKey(KAMINO_USDC_RESERVE);
    const usdcMint = new PublicKey(USDC_MINT);
    const kusdcMint = new PublicKey(KAMINO_KUSDC_MINT);
    const owner = new PublicKey(agentPublicKey);

    const [lendingMarketAuthority] = klend.lendingMarketAuthPda(marketPk, programId);
    // Both USDC and kUSDC are standard SPL tokens, so the ATAs derive under
    // TOKEN_PROGRAM_ID -- which MUST match how getAgentTokenBalanceRaw derives
    // them, or the realized-delta verification would watch the wrong account.
    const usdcAta = getAssociatedTokenAddressSync(usdcMint, owner);
    const kusdcAta = getAssociatedTokenAddressSync(kusdcMint, owner);
    const liquidityTokenProgram = reserve.getLiquidityTokenProgram();

    // Refresh the reserve in-tx (required before deposit/redeem). Oracle accounts
    // come from the reserve's own config; unset ones fall back to the program id.
    // `isNotNullPubkey` is the SDK's own sentinel check (NULL_PUBKEY + default).
    const opt = (pk: PublicKey): PublicKey => (klend.isNotNullPubkey(pk) ? pk : programId);
    const ti = reserve.state.config.tokenInfo;
    const refreshIx = klend.refreshReserve(
      {
        reserve: reservePk,
        lendingMarket: marketPk,
        pythOracle: opt(ti.pythConfiguration.price),
        switchboardPriceOracle: opt(ti.switchboardConfiguration.priceAggregator),
        switchboardTwapOracle: opt(ti.switchboardConfiguration.twapAggregator),
        scopePrices: opt(ti.scopeConfiguration.priceFeed),
      },
      programId,
    );

    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: KAMINO_RESERVE_OP_COMPUTE_UNITS });
    const instructions: TransactionInstruction[] = [computeIx, refreshIx];

    if (action === "deposit") {
      // Ensure the kUSDC destination ATA exists (idempotent, no-op if present).
      instructions.push(createIdempotentAtaInstruction(owner, kusdcAta, owner, kusdcMint));
      instructions.push(
        klend.depositReserveLiquidity(
          { liquidityAmount: new BN(amountRaw.toString()) },
          {
            owner,
            reserve: reservePk,
            lendingMarket: marketPk,
            lendingMarketAuthority,
            reserveLiquidityMint: usdcMint,
            reserveLiquiditySupply: reserve.state.liquidity.supplyVault,
            reserveCollateralMint: kusdcMint,
            userSourceLiquidity: usdcAta,
            userDestinationCollateral: kusdcAta,
            collateralTokenProgram: TOKEN_PROGRAM_ID,
            liquidityTokenProgram,
            instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
          },
          programId,
        ),
      );
    } else {
      // Ensure the USDC destination ATA exists (idempotent; normally already does).
      instructions.push(createIdempotentAtaInstruction(owner, usdcAta, owner, usdcMint));
      instructions.push(
        klend.redeemReserveCollateral(
          { collateralAmount: new BN(amountRaw.toString()) },
          {
            owner,
            lendingMarket: marketPk,
            reserve: reservePk,
            lendingMarketAuthority,
            reserveLiquidityMint: usdcMint,
            reserveCollateralMint: kusdcMint,
            reserveLiquiditySupply: reserve.state.liquidity.supplyVault,
            userSourceCollateral: kusdcAta,
            userDestinationLiquidity: usdcAta,
            collateralTokenProgram: TOKEN_PROGRAM_ID,
            liquidityTokenProgram,
            instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY,
          },
          programId,
        ),
      );
    }

    return instructions;
  } catch {
    return null;
  }
}

/**
 * Kamino Lend route. Phase 2a wires read-only valuation + previews. park/unpark
 * are added in Phase 2b/2c; until then they fail closed, and the kamino asset
 * stays disabled in the registry so they are never reached.
 */
export class KaminoYieldRoute implements YieldRoute {
  readonly kind = "kamino" as const;
  readonly valuationSource = VALUATION_SOURCE;

  constructor(private readonly asset: YieldAsset) {}

  async previewPark(amountUsdcRaw: bigint, _slippageBps: number): Promise<YieldRoutePreview> {
    if (amountUsdcRaw <= BigInt(0)) {
      return {
        expectedOutRaw: null,
        priceImpactPct: null,
        wouldReject: true,
        reason: "Amount is too small",
        valuationSource: this.valuationSource,
      };
    }
    const loaded = await loadFreshUsdcReserve(getServerConnection());
    if (!loaded) {
      return {
        expectedOutRaw: null,
        priceImpactPct: null,
        wouldReject: true,
        reason: "Kamino reserve rate is unavailable",
        valuationSource: this.valuationSource,
      };
    }
    const out = kusdcFromUsdcRaw(amountUsdcRaw, loaded.rate);
    return {
      expectedOutRaw: out,
      priceImpactPct: null,
      wouldReject: out === null,
      reason: out === null ? "Kamino reserve rate is unavailable" : undefined,
      valuationSource: this.valuationSource,
    };
  }

  async previewUnpark(amountTokenRaw: bigint, _slippageBps: number): Promise<YieldRoutePreview> {
    if (amountTokenRaw <= BigInt(0)) {
      return {
        expectedOutRaw: null,
        priceImpactPct: null,
        wouldReject: true,
        reason: "Amount is too small",
        valuationSource: this.valuationSource,
      };
    }
    const loaded = await loadFreshUsdcReserve(getServerConnection());
    if (!loaded) {
      return {
        expectedOutRaw: null,
        priceImpactPct: null,
        wouldReject: true,
        reason: "Kamino reserve rate is unavailable",
        valuationSource: this.valuationSource,
      };
    }
    const out = usdcValueFromKusdcRaw(amountTokenRaw, loaded.rate);
    return {
      expectedOutRaw: out,
      priceImpactPct: null,
      wouldReject: out === null,
      reason: out === null ? "Kamino reserve rate is unavailable" : undefined,
      valuationSource: this.valuationSource,
    };
  }

  async valueInUsdc(amountTokenRaw: bigint): Promise<YieldRouteValuation> {
    if (amountTokenRaw <= BigInt(0)) return { valueUsdcRaw: "0", source: this.valuationSource };
    const loaded = await loadFreshUsdcReserve(getServerConnection());
    if (!loaded) return { valueUsdcRaw: null, source: this.valuationSource };
    return { valueUsdcRaw: usdcValueFromKusdcRaw(amountTokenRaw, loaded.rate), source: this.valuationSource };
  }

  async park(args: ParkArgs): Promise<YieldRouteExecResult> {
    if (args.amountUsdcRaw <= BigInt(0)) {
      return { success: false, priceImpactPct: null, error: "Amount is too small" };
    }
    try {
      const loaded = await loadFreshUsdcReserve(getServerConnection());
      if (!loaded) {
        return { success: false, priceImpactPct: null, error: "Kamino reserve is unavailable" };
      }
      const instructions = await buildReserveInstructions(
        "deposit",
        args.agentPublicKey,
        args.amountUsdcRaw,
        loaded.reserve,
      );
      if (!instructions) {
        return { success: false, priceImpactPct: null, error: "Failed to build Kamino deposit" };
      }
      const exec = await executeAgentInstructions({
        agentPublicKey: args.agentPublicKey,
        agentSecretKey: args.agentSecretKey,
        instructions,
        verifyOutputMint: KAMINO_KUSDC_MINT,
        minSolGas: KAMINO_PARK_MIN_SOL_GAS,
        label: "Kamino park",
      });
      if (!exec.success || !exec.outputReceivedRaw) {
        return { success: false, signature: exec.signature, priceImpactPct: null, error: exec.error || "Kamino park failed" };
      }
      return {
        success: true,
        signature: exec.signature,
        outputReceivedRaw: exec.outputReceivedRaw,
        outputReceived: exec.outputReceived,
        priceImpactPct: null,
        valuationSource: this.valuationSource,
      };
    } catch (e: any) {
      return { success: false, priceImpactPct: null, error: e?.message || "Kamino park failed" };
    }
  }

  async unpark(args: UnparkArgs): Promise<YieldRouteExecResult> {
    if (args.amountTokenRaw <= BigInt(0)) {
      return { success: false, priceImpactPct: null, error: "Amount is too small" };
    }
    try {
      const loaded = await loadFreshUsdcReserve(getServerConnection());
      if (!loaded) {
        return { success: false, priceImpactPct: null, error: "Kamino reserve is unavailable" };
      }
      const instructions = await buildReserveInstructions(
        "redeem",
        args.agentPublicKey,
        args.amountTokenRaw,
        loaded.reserve,
      );
      if (!instructions) {
        return { success: false, priceImpactPct: null, error: "Failed to build Kamino withdrawal" };
      }
      const exec = await executeAgentInstructions({
        agentPublicKey: args.agentPublicKey,
        agentSecretKey: args.agentSecretKey,
        instructions,
        verifyOutputMint: USDC_MINT,
        minSolGas: KAMINO_UNPARK_MIN_SOL_GAS,
        label: "Kamino unpark",
      });
      if (!exec.success || !exec.outputReceivedRaw) {
        return { success: false, signature: exec.signature, priceImpactPct: null, error: exec.error || "Kamino unpark failed" };
      }
      return {
        success: true,
        signature: exec.signature,
        outputReceivedRaw: exec.outputReceivedRaw,
        outputReceived: exec.outputReceived,
        priceImpactPct: null,
        valuationSource: this.valuationSource,
      };
    } catch (e: any) {
      return { success: false, priceImpactPct: null, error: e?.message || "Kamino unpark failed" };
    }
  }
}

/** Re-exported so callers (e.g. a balance probe) can read the agent's kUSDC holding. */
export async function getAgentKusdcRaw(agentPublicKey: string): Promise<bigint> {
  const bal = await getAgentTokenBalanceRaw(agentPublicKey, KAMINO_KUSDC_MINT);
  return BigInt(bal.amountRaw);
}
