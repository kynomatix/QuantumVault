/**
 * Yield-route seam.
 *
 * The vault parks idle USDC into a yield-bearing stablecoin and pulls it back.
 * HOW funds move and HOW the holding is valued differ per asset, so each asset
 * declares a route (see yield-assets.ts). Today:
 *   - SwapYieldRoute (jupiter): mint/redeem through the Jupiter swap seam. Used by
 *     NAV tokens (Perena USD*, ONyc). Valued by a live market quote.
 *   - KaminoYieldRoute (kamino): direct Kamino Lend deposit/withdraw, valued by the
 *     reserve redemption rate. Added in Phase 2.
 *
 * Money-safety contract: routes are MONEY-AWARE. They never infer realized amounts
 * from nominal inputs; every exec result carries the realized, on-chain measured
 * output delta (raw base units) plus the signature. Valuation returns null when the
 * source is unavailable or stale, never a guess. Amounts in/out of this seam are raw
 * integer base units; callers convert to UI units using the mint decimals.
 */

import { executeAgentSwap, USDC_MINT } from "../agent-wallet";
import { getBestQuote } from "../swap/index.js";
import { KaminoYieldRoute } from "./kamino-route";
import type { YieldAsset } from "./yield-assets";

/** Reject any vault swap whose router price impact exceeds 0.5%. */
export const VAULT_MAX_PRICE_IMPACT = 0.005;
const DEFAULT_VALUATION_SLIPPAGE_BPS = 100;

export interface YieldRoutePreview {
  /** Expected output in raw base units, or null when no route/price is available. */
  expectedOutRaw: string | null;
  /** Swap price impact (fraction); null for non-swap routes. */
  priceImpactPct: number | null;
  wouldReject: boolean;
  reason?: string;
  /** "market_quote" | "redemption_rate" */
  valuationSource: string;
}

export interface YieldRouteExecResult {
  success: boolean;
  signature?: string;
  /** Realized output delta, raw base units (on-chain measured). Source of truth. */
  outputReceivedRaw?: string;
  /** Realized output delta, UI units. */
  outputReceived?: number;
  priceImpactPct?: number | null;
  valuationSource?: string;
  /** Non-fatal note (e.g. an on-chain success whose bookkeeping needs attention). */
  warning?: string;
  error?: string;
}

export interface YieldRouteValuation {
  /** USDC value of the holding in raw base units, or null when unavailable/stale. */
  valueUsdcRaw: string | null;
  source: string;
}

export interface ParkArgs {
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  amountUsdcRaw: bigint;
  slippageBps: number;
}

export interface UnparkArgs {
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  amountTokenRaw: bigint;
  slippageBps: number;
}

export interface YieldRoute {
  readonly kind: YieldAsset["route"];
  readonly valuationSource: string;
  previewPark(amountUsdcRaw: bigint, slippageBps: number): Promise<YieldRoutePreview>;
  previewUnpark(amountTokenRaw: bigint, slippageBps: number): Promise<YieldRoutePreview>;
  park(args: ParkArgs): Promise<YieldRouteExecResult>;
  unpark(args: UnparkArgs): Promise<YieldRouteExecResult>;
  /** Live USDC value of an on-chain holding of `amountTokenRaw`, or null when unknown. */
  valueInUsdc(amountTokenRaw: bigint): Promise<YieldRouteValuation>;
}

/**
 * Jupiter swap route. Parks by swapping USDC -> token and unparks token -> USDC,
 * gated on a fresh live quote and the price-impact cap. A null (unavailable) price
 * impact is rejected, not ignored.
 */
class SwapYieldRoute implements YieldRoute {
  readonly kind = "jupiter" as const;
  readonly valuationSource = "market_quote";

  constructor(private readonly asset: YieldAsset) {}

  private async quoteWithCap(
    inputMint: string,
    outputMint: string,
    amountRaw: bigint,
    slippageBps: number,
  ): Promise<YieldRoutePreview> {
    if (amountRaw <= BigInt(0)) {
      return {
        expectedOutRaw: null,
        priceImpactPct: null,
        wouldReject: true,
        reason: "Amount is too small",
        valuationSource: this.valuationSource,
      };
    }
    const quote = await getBestQuote({
      inputMint,
      outputMint,
      amountRaw: amountRaw.toString(),
      slippageBps,
    });
    if (!quote) {
      return {
        expectedOutRaw: null,
        priceImpactPct: null,
        wouldReject: true,
        reason: "No swap route available for this asset",
        valuationSource: this.valuationSource,
      };
    }

    const impact = quote.priceImpactPct;
    let wouldReject = false;
    let reason: string | undefined;
    if (impact === null || impact === undefined) {
      wouldReject = true;
      reason = "The router did not report a price impact";
    } else if (impact > VAULT_MAX_PRICE_IMPACT) {
      wouldReject = true;
      reason = `Price impact ${(impact * 100).toFixed(2)}% exceeds the ${(VAULT_MAX_PRICE_IMPACT * 100).toFixed(2)}% cap`;
    }

    return {
      expectedOutRaw: quote.outAmountRaw,
      priceImpactPct: impact ?? null,
      wouldReject,
      reason,
      valuationSource: this.valuationSource,
    };
  }

  previewPark(amountUsdcRaw: bigint, slippageBps: number): Promise<YieldRoutePreview> {
    return this.quoteWithCap(USDC_MINT, this.asset.mint, amountUsdcRaw, slippageBps);
  }

  previewUnpark(amountTokenRaw: bigint, slippageBps: number): Promise<YieldRoutePreview> {
    return this.quoteWithCap(this.asset.mint, USDC_MINT, amountTokenRaw, slippageBps);
  }

  async park(args: ParkArgs): Promise<YieldRouteExecResult> {
    const swap = await executeAgentSwap({
      agentPublicKey: args.agentPublicKey,
      agentSecretKey: args.agentSecretKey,
      inputMint: USDC_MINT,
      outputMint: this.asset.mint,
      amountRaw: args.amountUsdcRaw.toString(),
      slippageBps: args.slippageBps,
      maxPriceImpactPct: VAULT_MAX_PRICE_IMPACT,
    });
    if (!swap.success || !swap.outputReceivedRaw) {
      return { success: false, priceImpactPct: swap.priceImpactPct ?? null, error: swap.error || "Swap failed" };
    }
    return {
      success: true,
      signature: swap.signature,
      outputReceivedRaw: swap.outputReceivedRaw,
      outputReceived: swap.outputReceived,
      priceImpactPct: swap.priceImpactPct ?? null,
      valuationSource: this.valuationSource,
    };
  }

  async unpark(args: UnparkArgs): Promise<YieldRouteExecResult> {
    const swap = await executeAgentSwap({
      agentPublicKey: args.agentPublicKey,
      agentSecretKey: args.agentSecretKey,
      inputMint: this.asset.mint,
      outputMint: USDC_MINT,
      amountRaw: args.amountTokenRaw.toString(),
      slippageBps: args.slippageBps,
      maxPriceImpactPct: VAULT_MAX_PRICE_IMPACT,
    });
    // Raw measured delta is the source of truth; a route that cannot report it fails closed.
    if (!swap.success || !swap.outputReceivedRaw) {
      return { success: false, priceImpactPct: swap.priceImpactPct ?? null, error: swap.error || "Swap failed" };
    }
    return {
      success: true,
      signature: swap.signature,
      outputReceivedRaw: swap.outputReceivedRaw,
      outputReceived: swap.outputReceived,
      priceImpactPct: swap.priceImpactPct ?? null,
      valuationSource: this.valuationSource,
    };
  }

  async valueInUsdc(amountTokenRaw: bigint): Promise<YieldRouteValuation> {
    if (amountTokenRaw <= BigInt(0)) return { valueUsdcRaw: "0", source: this.valuationSource };
    try {
      const q = await getBestQuote({
        inputMint: this.asset.mint,
        outputMint: USDC_MINT,
        amountRaw: amountTokenRaw.toString(),
        slippageBps: DEFAULT_VALUATION_SLIPPAGE_BPS,
      });
      if (!q) return { valueUsdcRaw: null, source: this.valuationSource };
      return { valueUsdcRaw: q.outAmountRaw, source: this.valuationSource };
    } catch {
      return { valueUsdcRaw: null, source: this.valuationSource };
    }
  }
}

/**
 * Resolves the yield route for an asset. The kamino route currently serves
 * read-only valuation + previews; its park/unpark fail closed until Phase 2b/2c,
 * and the kamino asset stays disabled in the registry so they are never reached.
 */
export function getYieldRoute(asset: YieldAsset): YieldRoute {
  switch (asset.route) {
    case "jupiter":
      return new SwapYieldRoute(asset);
    case "kamino":
      return new KaminoYieldRoute(asset);
    default:
      throw new Error(`Unknown yield route "${(asset as YieldAsset).route}" for asset ${asset.key}`);
  }
}
