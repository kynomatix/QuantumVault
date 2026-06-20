/**
 * Jupiter Lend yield route (direct deposit/redeem of USDC into Jupiter Lend Earn).
 * The receipt token jlUSDC is held in the agent wallet's ATA and is a yield-bearing
 * claim: its USDC redemption value rises as interest accrues (same model as Kamino's
 * kUSDC).
 *
 * Money-safety contract (same as the Kamino route):
 *   - On-chain is truth. valueInUsdc returns null when the protocol token details are
 *     unreadable or fail assertions. It NEVER falls back to a 1:1 guess.
 *   - park/unpark verify the realized on-chain balance delta (via
 *     executeAgentInstructions) and fail closed on an ambiguous or zero delta.
 *
 * SDK isolation: @jup-ag/lend is imported LAZILY inside methods, so a heavy or
 * throwing SDK import can never break the swap routes or server startup. This module
 * has no top-level @jup-ag/lend import. (BN is imported from 'bn.js', never from
 * anchor: a throwing anchor import would silently de-register this route.)
 *
 * On-chain facts verified on mainnet (2026-06-20):
 *   - The jlUSDC receipt mint pinned below is in the protocol's OWN getLendingTokens()
 *     list (id 2); getLendingTokenDetails reports asset == USDC, decimals == 6, SPL
 *     owner, supply > 0. Verified via the registry, NEVER by symbol. The redemption
 *     rate is totalAssets/totalSupply (scale independent), asserted on every load.
 *   - On-DEX jlUSDC swap liquidity is negligible, so exit is an in-protocol redeem,
 *     NOT a swap. That is why this needs its own route, not the "jupiter" swap seam.
 *   - The SDK's getDepositIxs/getRedeemIxs already include their own idempotent
 *     ATA-create instructions but no compute-budget ix, so we prepend exactly one.
 */

import {
  PublicKey,
  ComputeBudgetProgram,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  getServerConnection,
  USDC_MINT,
  getAgentTokenBalanceRaw,
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

/** Pinned, on-chain-verified Jupiter Lend constants. */
export const JUPITER_LEND_PROGRAM_ID = "jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9";
/** jlUSDC receipt (lending-token) mint for the USDC market, verified on-chain. */
export const JLUSDC_MINT = "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D";
export const JLUSDC_DECIMALS = 6;

const VALUATION_SOURCE = "redemption_rate";

/** SOL gas floor for a park (tx fee + a possible first-time jlUSDC ATA rent). */
const JUPITER_LEND_PARK_MIN_SOL_GAS = 0.01;
/** SOL gas floor for an unpark (USDC ATA normally already exists). */
const JUPITER_LEND_UNPARK_MIN_SOL_GAS = 0.005;
/** Compute-unit ceiling for a single deposit/redeem batch. */
const JUPITER_LEND_OP_COMPUTE_UNITS = 400_000;

interface LoadedRate {
  /** Total underlying USDC base units backing the market. */
  totalAssets: bigint;
  /** Total jlUSDC shares outstanding. */
  totalSupply: bigint;
}

/**
 * Loads the jlUSDC market details from the protocol, asserts the pinned mint really
 * is the USDC market (asset == USDC, decimals == 6) with positive supply/assets, and
 * returns the raw totals for a scale-independent redemption rate. Returns null on any
 * failure or failed assertion (fail closed). Never throws.
 *
 * This is the SINGLE assert path: both read-only valuation and the park/unpark money
 * legs gate on it, so the money-safety asserts can never drift between read and write.
 */
async function loadJlUsdcRate(): Promise<LoadedRate | null> {
  try {
    const { getLendingTokenDetails } = await import("@jup-ag/lend/earn");
    const connection = getServerConnection();
    const d = await getLendingTokenDetails({
      lendingToken: new PublicKey(JLUSDC_MINT),
      connection,
    });
    // Assert the pinned receipt mint is the USDC market with expected decimals.
    if (!d.asset.equals(new PublicKey(USDC_MINT))) return null;
    if (d.decimals !== JLUSDC_DECIMALS) return null;
    const totalAssets = BigInt(d.totalAssets.toString());
    const totalSupply = BigInt(d.totalSupply.toString());
    if (totalAssets <= BigInt(0) || totalSupply <= BigInt(0)) return null;
    return { totalAssets, totalSupply };
  } catch {
    return null;
  }
}

/** USDC base units redeemable for `sharesRaw` jlUSDC at the current rate, floored. */
function usdcFromShares(sharesRaw: bigint, rate: LoadedRate): string {
  if (sharesRaw <= BigInt(0)) return "0";
  return ((sharesRaw * rate.totalAssets) / rate.totalSupply).toString();
}

/** jlUSDC shares minted for depositing `usdcRaw` USDC, floored. Estimate only; the real minted amount is the measured on-chain delta. */
function sharesFromUsdc(usdcRaw: bigint, rate: LoadedRate): string {
  if (usdcRaw <= BigInt(0)) return "0";
  return ((usdcRaw * rate.totalSupply) / rate.totalAssets).toString();
}

/**
 * Builds the Jupiter Lend deposit (park) or redeem (unpark) instruction batch via the
 * @jup-ag/lend SDK, pinned to the underlying USDC asset. The SDK returns its own
 * idempotent ATA-create ixs, so we only prepend a compute-budget limit (guarded so a
 * future SDK-supplied compute-budget ix can never cause a duplicate-instruction tx
 * failure). Returns null on any build failure (fail closed).
 *
 * NOTE: the SDK ix builders take `asset` = the UNDERLYING USDC mint (NOT the jlUSDC
 * receipt mint), and `signer` = the agent wallet that will sign and pay.
 */
async function buildLendInstructions(
  action: "deposit" | "redeem",
  agentPublicKey: string,
  amountRaw: bigint,
): Promise<TransactionInstruction[] | null> {
  try {
    const earn = await import("@jup-ag/lend/earn");
    const BN = (await import("bn.js")).default;
    const connection = getServerConnection();
    const signer = new PublicKey(agentPublicKey);
    const asset = new PublicKey(USDC_MINT);

    const built =
      action === "deposit"
        ? await earn.getDepositIxs({ amount: new BN(amountRaw.toString()), asset, signer, connection })
        : await earn.getRedeemIxs({ shares: new BN(amountRaw.toString()), asset, signer, connection });

    const ixs = built?.ixs;
    if (!ixs || ixs.length === 0) return null;

    // Defensive: the SDK does not add a compute-budget ix today, but if it ever does,
    // do NOT add a second SetComputeUnitLimit (a duplicate fails the whole tx).
    const hasComputeBudget = ixs.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId));
    if (hasComputeBudget) return ixs;
    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: JUPITER_LEND_OP_COMPUTE_UNITS });
    return [computeIx, ...ixs];
  } catch {
    return null;
  }
}

/**
 * Jupiter Lend route. Wires valuation + previews and park/unpark (direct Jupiter Lend
 * deposit/redeem). park/unpark verify the realized on-chain output-delta via
 * executeAgentInstructions and fail closed on any build or exec failure.
 */
export class JupiterLendYieldRoute implements YieldRoute {
  readonly kind = "jupiter_lend" as const;
  readonly valuationSource = VALUATION_SOURCE;

  constructor(private readonly asset: YieldAsset) {}

  async previewPark(amountUsdcRaw: bigint, _slippageBps: number): Promise<YieldRoutePreview> {
    if (amountUsdcRaw <= BigInt(0)) {
      return { expectedOutRaw: null, priceImpactPct: null, wouldReject: true, reason: "Amount is too small", valuationSource: this.valuationSource };
    }
    const rate = await loadJlUsdcRate();
    if (!rate) {
      return { expectedOutRaw: null, priceImpactPct: null, wouldReject: true, reason: "Jupiter Lend rate is unavailable", valuationSource: this.valuationSource };
    }
    return { expectedOutRaw: sharesFromUsdc(amountUsdcRaw, rate), priceImpactPct: null, wouldReject: false, valuationSource: this.valuationSource };
  }

  async previewUnpark(amountTokenRaw: bigint, _slippageBps: number): Promise<YieldRoutePreview> {
    if (amountTokenRaw <= BigInt(0)) {
      return { expectedOutRaw: null, priceImpactPct: null, wouldReject: true, reason: "Amount is too small", valuationSource: this.valuationSource };
    }
    const rate = await loadJlUsdcRate();
    if (!rate) {
      return { expectedOutRaw: null, priceImpactPct: null, wouldReject: true, reason: "Jupiter Lend rate is unavailable", valuationSource: this.valuationSource };
    }
    return { expectedOutRaw: usdcFromShares(amountTokenRaw, rate), priceImpactPct: null, wouldReject: false, valuationSource: this.valuationSource };
  }

  async valueInUsdc(amountTokenRaw: bigint): Promise<YieldRouteValuation> {
    if (amountTokenRaw <= BigInt(0)) return { valueUsdcRaw: "0", source: this.valuationSource };
    const rate = await loadJlUsdcRate();
    if (!rate) return { valueUsdcRaw: null, source: this.valuationSource };
    return { valueUsdcRaw: usdcFromShares(amountTokenRaw, rate), source: this.valuationSource };
  }

  async park(args: ParkArgs): Promise<YieldRouteExecResult> {
    if (args.amountUsdcRaw <= BigInt(0)) {
      return { success: false, priceImpactPct: null, error: "Amount is too small" };
    }
    try {
      // Assert the market is readable before moving money (fail closed if not).
      const rate = await loadJlUsdcRate();
      if (!rate) return { success: false, priceImpactPct: null, error: "Jupiter Lend is unavailable" };

      const instructions = await buildLendInstructions("deposit", args.agentPublicKey, args.amountUsdcRaw);
      if (!instructions) return { success: false, priceImpactPct: null, error: "Failed to build Jupiter Lend deposit" };

      const exec = await executeAgentInstructions({
        agentPublicKey: args.agentPublicKey,
        agentSecretKey: args.agentSecretKey,
        instructions,
        verifyOutputMint: JLUSDC_MINT,
        minSolGas: JUPITER_LEND_PARK_MIN_SOL_GAS,
        label: "Jupiter Lend park",
      });
      if (!exec.success || !exec.outputReceivedRaw) {
        return { success: false, signature: exec.signature, priceImpactPct: null, error: exec.error || "Jupiter Lend park failed" };
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
      return { success: false, priceImpactPct: null, error: e?.message || "Jupiter Lend park failed" };
    }
  }

  async unpark(args: UnparkArgs): Promise<YieldRouteExecResult> {
    if (args.amountTokenRaw <= BigInt(0)) {
      return { success: false, priceImpactPct: null, error: "Amount is too small" };
    }
    try {
      const rate = await loadJlUsdcRate();
      if (!rate) return { success: false, priceImpactPct: null, error: "Jupiter Lend is unavailable" };

      // Redeem by SHARES so unpark-all consumes the exact jlUSDC balance (no dust).
      const instructions = await buildLendInstructions("redeem", args.agentPublicKey, args.amountTokenRaw);
      if (!instructions) return { success: false, priceImpactPct: null, error: "Failed to build Jupiter Lend withdrawal" };

      const exec = await executeAgentInstructions({
        agentPublicKey: args.agentPublicKey,
        agentSecretKey: args.agentSecretKey,
        instructions,
        verifyOutputMint: USDC_MINT,
        minSolGas: JUPITER_LEND_UNPARK_MIN_SOL_GAS,
        label: "Jupiter Lend unpark",
      });
      if (!exec.success || !exec.outputReceivedRaw) {
        return { success: false, signature: exec.signature, priceImpactPct: null, error: exec.error || "Jupiter Lend unpark failed" };
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
      return { success: false, priceImpactPct: null, error: e?.message || "Jupiter Lend unpark failed" };
    }
  }
}

/** Re-exported so callers (e.g. a balance probe) can read the agent's jlUSDC holding. */
export async function getAgentJlUsdcRaw(agentPublicKey: string): Promise<bigint> {
  const bal = await getAgentTokenBalanceRaw(agentPublicKey, JLUSDC_MINT);
  return BigInt(bal.amountRaw);
}
