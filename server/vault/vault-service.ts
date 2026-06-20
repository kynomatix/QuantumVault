/**
 * Phase 0a Vaults: service layer.
 *
 * Composes the generalized agent swap primitive (server/agent-wallet) with the
 * cost-basis accounting in storage and live Jupiter quotes. Two user actions:
 *
 *   parkUsdc    spare agent-wallet USDC  ->  yield token
 *   unparkToUsdc  yield token            ->  USDC
 *
 * Money-safety rules:
 *  - On-chain is the source of truth. The swap is fail-closed (realized delta),
 *    and a DB write that fails AFTER a successful on-chain swap is surfaced as a
 *    non-fatal warning, never reported as a money failure.
 *  - Every swap is gated on a fresh live quote and a price-impact cap; a null
 *    (unavailable) price impact is rejected, not ignored.
 *  - Only registry assets with a hand-verified mint are routable.
 */

import Decimal from "decimal.js";
import {
  executeAgentSwap,
  getAgentUsdcBalance,
  getAgentTokenBalanceRaw,
  USDC_MINT,
} from "../agent-wallet";
import { getBestQuote } from "../swap/index.js";
import { storage } from "../storage";
import { getEnabledYieldAssets, getYieldAssetByKey, type YieldAsset } from "./yield-assets";
import type { VaultPosition } from "@shared/schema";

const USDC_DECIMALS = 6;
/** Reject any vault swap whose router price impact exceeds 0.5%. */
export const VAULT_MAX_PRICE_IMPACT = 0.005;
const DEFAULT_SLIPPAGE_BPS = 100;
const MAX_SLIPPAGE_BPS = 500;

function clampSlippage(bps?: number): number {
  if (typeof bps !== "number" || !(bps > 0)) return DEFAULT_SLIPPAGE_BPS;
  return Math.min(Math.round(bps), MAX_SLIPPAGE_BPS);
}

/** UI amount -> raw base units, floored (never rounds up past the real balance). */
function toRaw(amountUi: number, decimals: number): bigint {
  const raw = new Decimal(amountUi).mul(new Decimal(10).pow(decimals)).toFixed(0, Decimal.ROUND_DOWN);
  return BigInt(raw);
}

function fromRaw(raw: bigint, decimals: number): number {
  return Number(new Decimal(raw.toString()).div(new Decimal(10).pow(decimals)).toFixed(decimals));
}

// --- Preview ----------------------------------------------------------------

export interface VaultPreview {
  assetKey: string;
  direction: "park" | "unpark";
  inputRaw: string;
  expectedOutRaw: string | null;
  expectedOut: number | null;
  priceImpactPct: number | null;
  wouldReject: boolean;
  reason?: string;
}

/** Read-only: quote a hypothetical park/unpark and report what the real swap would do. */
export async function previewVaultSwap(params: {
  assetKey: string;
  direction: "park" | "unpark";
  amount: number; // park: USDC; unpark: token UI amount
  slippageBps?: number;
}): Promise<VaultPreview> {
  const base: VaultPreview = {
    assetKey: params.assetKey,
    direction: params.direction,
    inputRaw: "0",
    expectedOutRaw: null,
    expectedOut: null,
    priceImpactPct: null,
    wouldReject: true,
  };

  const asset = getYieldAssetByKey(params.assetKey);
  if (!asset) return { ...base, reason: "Unknown or disabled asset" };
  if (!(params.amount > 0)) return { ...base, reason: "Amount must be greater than zero" };

  const inputMint = params.direction === "park" ? USDC_MINT : asset.mint;
  const outputMint = params.direction === "park" ? asset.mint : USDC_MINT;
  const inDecimals = params.direction === "park" ? USDC_DECIMALS : asset.decimals;
  const outDecimals = params.direction === "park" ? asset.decimals : USDC_DECIMALS;

  const inputRaw = toRaw(params.amount, inDecimals);
  if (inputRaw <= BigInt(0)) return { ...base, reason: "Amount is too small" };

  const quote = await getBestQuote({
    inputMint,
    outputMint,
    amountRaw: inputRaw.toString(),
    slippageBps: clampSlippage(params.slippageBps),
  });
  if (!quote) {
    return { ...base, inputRaw: inputRaw.toString(), reason: "No swap route available for this asset" };
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

  const expectedOutRaw = quote.outAmountRaw;
  return {
    assetKey: asset.key,
    direction: params.direction,
    inputRaw: inputRaw.toString(),
    expectedOutRaw,
    expectedOut: fromRaw(BigInt(expectedOutRaw), outDecimals),
    priceImpactPct: impact ?? null,
    wouldReject,
    reason,
  };
}

// --- Park -------------------------------------------------------------------

export interface ParkResult {
  success: boolean;
  signature?: string;
  tokensReceived?: number;
  usdcSpent?: number;
  priceImpactPct?: number | null;
  position?: VaultPosition;
  dbWarning?: string;
  error?: string;
}

export async function parkUsdc(params: {
  walletAddress: string;
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  assetKey: string;
  amountUsdc: number;
  slippageBps?: number;
}): Promise<ParkResult> {
  const asset = getYieldAssetByKey(params.assetKey);
  if (!asset) return { success: false, error: "Unknown or disabled asset" };
  if (!(params.amountUsdc > 0)) return { success: false, error: "Amount must be greater than zero" };

  const inputRaw = toRaw(params.amountUsdc, USDC_DECIMALS);
  if (inputRaw <= BigInt(0)) return { success: false, error: "Amount is too small" };

  // Spare USDC check against on-chain balance.
  const spareUsdc = await getAgentUsdcBalance(params.agentPublicKey);
  if (inputRaw > toRaw(spareUsdc, USDC_DECIMALS)) {
    return { success: false, error: `Not enough spare USDC in your bot wallet. Available: ${spareUsdc.toFixed(2)} USDC.` };
  }

  const swap = await executeAgentSwap({
    agentPublicKey: params.agentPublicKey,
    agentSecretKey: params.agentSecretKey,
    inputMint: USDC_MINT,
    outputMint: asset.mint,
    amountRaw: inputRaw.toString(),
    slippageBps: clampSlippage(params.slippageBps),
    maxPriceImpactPct: VAULT_MAX_PRICE_IMPACT,
  });
  if (!swap.success || !swap.outputReceivedRaw) {
    return { success: false, priceImpactPct: swap.priceImpactPct ?? null, error: swap.error || "Swap failed" };
  }

  // ExactIn: USDC spent equals exactly the input amount.
  const usdcSpent = fromRaw(inputRaw, USDC_DECIMALS);

  let position: VaultPosition | undefined;
  let dbWarning: string | undefined;
  try {
    position = await storage.applyVaultPark({
      walletAddress: params.walletAddress,
      assetKey: asset.key,
      mint: asset.mint,
      tokensReceivedRaw: swap.outputReceivedRaw,
      usdcSpent,
      txSignature: swap.signature,
      notes: `Parked ${usdcSpent.toFixed(6)} USDC into ${asset.displayName}`,
    });
  } catch (e: any) {
    dbWarning = `Swap succeeded on-chain (signature ${swap.signature}) but recording your cost basis failed. Your funds are safe in the bot wallet.`;
    console.error("[Vault] applyVaultPark failed after a successful swap", e);
  }

  return {
    success: true,
    signature: swap.signature,
    tokensReceived: swap.outputReceived,
    usdcSpent,
    priceImpactPct: swap.priceImpactPct ?? null,
    position,
    dbWarning,
  };
}

// --- Unpark -----------------------------------------------------------------

export interface UnparkResult {
  success: boolean;
  signature?: string;
  usdcReceived?: number;
  tokensSold?: number;
  costBasisRemoved?: number;
  realizedPnl?: number;
  priceImpactPct?: number | null;
  position?: VaultPosition;
  dbWarning?: string;
  error?: string;
}

export async function unparkToUsdc(params: {
  walletAddress: string;
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  assetKey: string;
  amountToken?: number; // ignored when `all` is true
  all?: boolean;
  slippageBps?: number;
}): Promise<UnparkResult> {
  const asset = getYieldAssetByKey(params.assetKey);
  if (!asset) return { success: false, error: "Unknown or disabled asset" };

  // On-chain token balance is the truth for how much can be sold.
  const onChain = await getAgentTokenBalanceRaw(params.agentPublicKey, asset.mint);
  const onChainRaw = BigInt(onChain.amountRaw);
  if (onChainRaw <= BigInt(0)) {
    return { success: false, error: `No ${asset.displayName} balance to unpark.` };
  }

  let sellRaw: bigint;
  if (params.all) {
    sellRaw = onChainRaw;
  } else {
    if (!(params.amountToken && params.amountToken > 0)) {
      return { success: false, error: "Amount must be greater than zero" };
    }
    sellRaw = toRaw(params.amountToken, asset.decimals);
    if (sellRaw <= BigInt(0)) return { success: false, error: "Amount is too small" };
    if (sellRaw > onChainRaw) sellRaw = onChainRaw; // clamp to available
  }

  const swap = await executeAgentSwap({
    agentPublicKey: params.agentPublicKey,
    agentSecretKey: params.agentSecretKey,
    inputMint: asset.mint,
    outputMint: USDC_MINT,
    amountRaw: sellRaw.toString(),
    slippageBps: clampSlippage(params.slippageBps),
    maxPriceImpactPct: VAULT_MAX_PRICE_IMPACT,
  });
  if (!swap.success || swap.outputReceived === undefined) {
    return { success: false, priceImpactPct: swap.priceImpactPct ?? null, error: swap.error || "Swap failed" };
  }

  const usdcReceived = swap.outputReceived;
  let position: VaultPosition | undefined;
  let costBasisRemoved: number | undefined;
  let realizedPnl: number | undefined;
  let dbWarning: string | undefined;
  try {
    const r = await storage.applyVaultUnpark({
      walletAddress: params.walletAddress,
      assetKey: asset.key,
      mint: asset.mint,
      tokensSoldRaw: sellRaw.toString(),
      usdcReceived,
      txSignature: swap.signature,
      notesPrefix: `Unparked ${asset.displayName}.`,
    });
    position = r.position;
    costBasisRemoved = r.costBasisRemoved;
    realizedPnl = r.realizedPnl;
  } catch (e: any) {
    dbWarning = `Swap succeeded on-chain (signature ${swap.signature}) but updating your cost basis failed. Your USDC is safe in the bot wallet.`;
    console.error("[Vault] applyVaultUnpark failed after a successful swap", e);
  }

  return {
    success: true,
    signature: swap.signature,
    usdcReceived,
    tokensSold: fromRaw(sellRaw, asset.decimals),
    costBasisRemoved,
    realizedPnl,
    priceImpactPct: swap.priceImpactPct ?? null,
    position,
    dbWarning,
  };
}

// --- Valuation --------------------------------------------------------------

export interface VaultPositionView {
  assetKey: string;
  displayName: string;
  mint: string;
  decimals: number;
  type: YieldAsset["type"];
  tag: string;
  defaultEligible: boolean;
  onChainAmountRaw: string;
  onChainAmount: number;
  /** Live USDC value of the on-chain holding, or null when no quote is available. */
  currentValueUsdc: number | null;
  /** Recorded average-cost basis, or null when there is no DB row for it. */
  costBasisUsdc: number | null;
  /** currentValue - costBasis, when both are known. */
  unrealizedPnl: number | null;
  /** True when the wallet holds the token on-chain but we have no recorded basis. */
  costBasisMissing: boolean;
}

/**
 * Read-only view of a wallet's parked positions. On-chain balance drives the
 * display value; the DB row only supplies cost basis. A token held on-chain with
 * no DB row is still shown, flagged costBasisMissing.
 */
export async function getVaultPositionViews(
  walletAddress: string,
  agentPublicKey: string,
): Promise<VaultPositionView[]> {
  const enabled = getEnabledYieldAssets();
  const dbRows = await storage.getVaultPositions(walletAddress);
  const dbByKey = new Map(dbRows.map((r) => [r.assetKey, r] as const));

  const views: VaultPositionView[] = [];
  for (const asset of enabled) {
    let onChainRaw = BigInt(0);
    let onChainAmount = 0;
    try {
      const bal = await getAgentTokenBalanceRaw(agentPublicKey, asset.mint);
      onChainRaw = BigInt(bal.amountRaw);
      onChainAmount = bal.uiAmount;
    } catch {
      // treat as zero balance
    }

    const dbRow = dbByKey.get(asset.key);
    const hasOnChain = onChainRaw > BigInt(0);
    if (!hasOnChain && !dbRow) continue;

    let currentValueUsdc: number | null = hasOnChain ? null : 0;
    if (hasOnChain) {
      try {
        const q = await getBestQuote({
          inputMint: asset.mint,
          outputMint: USDC_MINT,
          amountRaw: onChainRaw.toString(),
          slippageBps: DEFAULT_SLIPPAGE_BPS,
        });
        if (q) currentValueUsdc = fromRaw(BigInt(q.outAmountRaw), USDC_DECIMALS);
      } catch {
        // leave null: quote unavailable
      }
    }

    const costBasisUsdc = dbRow ? Number(dbRow.usdcCostBasis) : null;
    const costBasisMissing = hasOnChain && !dbRow;
    const unrealizedPnl =
      currentValueUsdc !== null && costBasisUsdc !== null ? currentValueUsdc - costBasisUsdc : null;

    views.push({
      assetKey: asset.key,
      displayName: asset.displayName,
      mint: asset.mint,
      decimals: asset.decimals,
      type: asset.type,
      tag: asset.tag,
      defaultEligible: asset.defaultEligible,
      onChainAmountRaw: onChainRaw.toString(),
      onChainAmount,
      currentValueUsdc,
      costBasisUsdc,
      unrealizedPnl,
      costBasisMissing,
    });
  }
  return views;
}
