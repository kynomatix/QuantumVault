/**
 * Vaults: service layer.
 *
 * Composes the per-asset yield route (server/vault/yield-routes) with the
 * cost-basis accounting in storage. Two user actions:
 *
 *   parkUsdc      spare agent-wallet USDC  ->  yield token
 *   unparkToUsdc  yield token              ->  USDC
 *
 * The route handles the on-chain leg and valuation; this layer handles balance
 * checks and DB accounting, and stays protocol-agnostic (it never assumes a swap).
 *
 * Money-safety rules:
 *  - On-chain is the source of truth. The route is fail-closed (realized delta),
 *    and a DB write that fails AFTER a successful on-chain leg is surfaced as a
 *    non-fatal warning, never reported as a money failure.
 *  - Only registry assets with a hand-verified mint are routable.
 */

import Decimal from "decimal.js";
import { getAgentUsdcBalance, getAgentTokenBalanceRaw, getAgentTokenBalanceRawStrict, USDC_MINT } from "../agent-wallet";
import { storage } from "../storage";
import { getEnabledYieldAssets, getYieldAssetByKey, type YieldAsset } from "./yield-assets";
import { getYieldRoute, VAULT_MAX_PRICE_IMPACT } from "./yield-routes";
import { ensureVaultGas } from "./gas-funding";
import { vaultLockKey } from "./scope";
import type { VaultPosition } from "@shared/schema";

export { VAULT_MAX_PRICE_IMPACT } from "./yield-routes";

const USDC_DECIMALS = 6;
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

// --- Per-scope serializer ---------------------------------------------------

/**
 * Lightweight in-process async mutex keyed by (wallet, scope, asset). A vault
 * park/unpark moves on-chain funds (gas top-up + swap/redeem) and then records cost
 * basis; two concurrent clicks or retries on the SAME scope must never interleave
 * those on-chain legs. This serializes the WHOLE op without ever holding a DB
 * transaction across on-chain calls (the brief cost-basis write keeps its own DB
 * advisory lock inside storage).
 */
const scopeTails = new Map<number, Promise<void>>();
async function withScopeLock<T>(key: number, fn: () => Promise<T>): Promise<T> {
  const prev = scopeTails.get(key) ?? Promise.resolve();
  let resolveNext!: () => void;
  const next = new Promise<void>((r) => {
    resolveNext = r;
  });
  const myTail = prev.then(() => next);
  scopeTails.set(key, myTail);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    resolveNext();
    if (scopeTails.get(key) === myTail) scopeTails.delete(key);
  }
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

  const inDecimals = params.direction === "park" ? USDC_DECIMALS : asset.decimals;
  const outDecimals = params.direction === "park" ? asset.decimals : USDC_DECIMALS;

  const inputRaw = toRaw(params.amount, inDecimals);
  if (inputRaw <= BigInt(0)) return { ...base, reason: "Amount is too small" };

  const route = getYieldRoute(asset);
  const slippage = clampSlippage(params.slippageBps);
  const p =
    params.direction === "park"
      ? await route.previewPark(inputRaw, slippage)
      : await route.previewUnpark(inputRaw, slippage);

  return {
    assetKey: asset.key,
    direction: params.direction,
    inputRaw: inputRaw.toString(),
    expectedOutRaw: p.expectedOutRaw,
    expectedOut: p.expectedOutRaw === null ? null : fromRaw(BigInt(p.expectedOutRaw), outDecimals),
    priceImpactPct: p.priceImpactPct,
    wouldReject: p.wouldReject,
    reason: p.reason,
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
  /** Vault scope: omit/null = account vault; a bot id = that bot's per-bot wallet. */
  tradingBotId?: string | null;
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  assetKey: string;
  amountUsdc?: number; // ignored when `all` is true
  all?: boolean;
  slippageBps?: number;
  /** Account agent that backstops gas. For a per-bot wallet this is the main agent. */
  funderPublicKey?: string;
  funderSecretKey?: Uint8Array;
}): Promise<ParkResult> {
  const asset = getYieldAssetByKey(params.assetKey);
  if (!asset) return { success: false, error: "Unknown or disabled asset" };

  return withScopeLock(vaultLockKey(params.walletAddress, params.tradingBotId ?? null, params.assetKey), async () => {
    // Money-safety: a per-bot vault MUST gas off a SEPARATE account funder. Without
    // an explicit, distinct funder the gas backstop would fall back to the bot's own
    // key and could sell the bot's trading USDC for gas. Fail closed instead.
    if (params.tradingBotId) {
      if (!params.funderPublicKey || !params.funderSecretKey || params.funderPublicKey === params.agentPublicKey) {
        return { success: false, error: "Per-bot vault gas requires a separate account funder wallet." };
      }
    }
    // Hands-off gas: make sure the paying wallet can cover the tx fee + (first-time)
    // yield-token ATA rent BEFORE the swap. The account agent backstops a short bot
    // wallet; a short agent buys SOL with its own USDC. Fail closed if it cannot.
    const gas = await ensureVaultGas({
      payingPublicKey: params.agentPublicKey,
      funderPublicKey: params.funderPublicKey ?? params.agentPublicKey,
      funderSecretKey: params.funderSecretKey ?? params.agentSecretKey,
      destMint: asset.mint,
      label: "Park",
    });
    if (!gas.ok) return { success: false, error: gas.error || "Could not cover the network gas for this park." };

  let inputRaw: bigint;
  if (params.all) {
    // All-in park: read the RAW on-chain USDC balance with the STRICT reader, which
    // THROWS on an unreadable balance (fail closed) instead of reporting 0. We park
    // 100% of it; any passed amountUsdc is ignored. A genuinely missing ATA reads as
    // 0 -> "no spare USDC", never a fabricated baseline.
    const bal = await getAgentTokenBalanceRawStrict(params.agentPublicKey, USDC_MINT);
    if (bal.amountRaw !== "0" && bal.decimals !== USDC_DECIMALS) {
      return { success: false, error: "Unexpected USDC decimals on-chain." };
    }
    inputRaw = BigInt(bal.amountRaw);
    if (inputRaw <= BigInt(0)) return { success: false, error: "No spare USDC to park." };
  } else {
    if (!(params.amountUsdc && params.amountUsdc > 0)) {
      return { success: false, error: "Amount must be greater than zero" };
    }
    inputRaw = toRaw(params.amountUsdc, USDC_DECIMALS);
    if (inputRaw <= BigInt(0)) return { success: false, error: "Amount is too small" };

    // Spare USDC check against on-chain balance.
    const spareUsdc = await getAgentUsdcBalance(params.agentPublicKey);
    if (inputRaw > toRaw(spareUsdc, USDC_DECIMALS)) {
      return { success: false, error: `Not enough spare USDC in your bot wallet. Available: ${spareUsdc.toFixed(2)} USDC.` };
    }
  }

  const route = getYieldRoute(asset);
  const exec = await route.park({
    agentPublicKey: params.agentPublicKey,
    agentSecretKey: params.agentSecretKey,
    amountUsdcRaw: inputRaw,
    slippageBps: clampSlippage(params.slippageBps),
  });
  if (!exec.success || !exec.outputReceivedRaw) {
    return { success: false, priceImpactPct: exec.priceImpactPct ?? null, error: exec.error || "Park failed" };
  }

  // ExactIn: USDC spent equals exactly the input amount.
  const usdcSpent = fromRaw(inputRaw, USDC_DECIMALS);

  let position: VaultPosition | undefined;
  let dbWarning: string | undefined = exec.warning;
  try {
    position = await storage.applyVaultPark({
      walletAddress: params.walletAddress,
      tradingBotId: params.tradingBotId ?? null,
      assetKey: asset.key,
      mint: asset.mint,
      tokensReceivedRaw: exec.outputReceivedRaw,
      usdcSpent,
      txSignature: exec.signature,
      notes: `Parked ${usdcSpent.toFixed(6)} USDC into ${asset.displayName}`,
    });
  } catch (e: any) {
    dbWarning = `Park succeeded on-chain (signature ${exec.signature}) but recording your cost basis failed. Your funds are safe in the bot wallet.`;
    console.error("[Vault] applyVaultPark failed after a successful park", e);
  }

  return {
    success: true,
    signature: exec.signature,
    tokensReceived: exec.outputReceived,
    usdcSpent,
    priceImpactPct: exec.priceImpactPct ?? null,
    position,
    dbWarning,
  };
  });
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
  /** Vault scope: omit/null = account vault; a bot id = that bot's per-bot wallet. */
  tradingBotId?: string | null;
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  assetKey: string;
  amountToken?: number; // ignored when `all` is true
  all?: boolean;
  slippageBps?: number;
  /** Account agent that backstops gas. For a per-bot wallet this is the main agent. */
  funderPublicKey?: string;
  funderSecretKey?: Uint8Array;
}): Promise<UnparkResult> {
  const asset = getYieldAssetByKey(params.assetKey);
  if (!asset) return { success: false, error: "Unknown or disabled asset" };

  return withScopeLock(vaultLockKey(params.walletAddress, params.tradingBotId ?? null, params.assetKey), async () => {
    // Money-safety: a per-bot vault MUST gas off a SEPARATE account funder (see
    // parkUsdc). Fail closed if no distinct funder was supplied.
    if (params.tradingBotId) {
      if (!params.funderPublicKey || !params.funderSecretKey || params.funderPublicKey === params.agentPublicKey) {
        return { success: false, error: "Per-bot vault gas requires a separate account funder wallet." };
      }
    }
    // Hands-off gas: make sure the paying wallet can cover the tx fee + (first-time)
    // USDC ATA rent BEFORE the redeem/swap. Fail closed if gas cannot be covered.
    const gas = await ensureVaultGas({
      payingPublicKey: params.agentPublicKey,
      funderPublicKey: params.funderPublicKey ?? params.agentPublicKey,
      funderSecretKey: params.funderSecretKey ?? params.agentSecretKey,
      destMint: USDC_MINT,
      label: "Unpark",
    });
    if (!gas.ok) return { success: false, error: gas.error || "Could not cover the network gas for this unpark." };

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

  const route = getYieldRoute(asset);
  const exec = await route.unpark({
    agentPublicKey: params.agentPublicKey,
    agentSecretKey: params.agentSecretKey,
    amountTokenRaw: sellRaw,
    slippageBps: clampSlippage(params.slippageBps),
  });
  if (!exec.success || !exec.outputReceivedRaw) {
    return { success: false, priceImpactPct: exec.priceImpactPct ?? null, error: exec.error || "Unpark failed" };
  }

  // Derive USDC received from the on-chain measured raw delta, not the UI estimate.
  const usdcReceived = fromRaw(BigInt(exec.outputReceivedRaw), USDC_DECIMALS);
  let position: VaultPosition | undefined;
  let costBasisRemoved: number | undefined;
  let realizedPnl: number | undefined;
  let dbWarning: string | undefined = exec.warning;
  try {
    const r = await storage.applyVaultUnpark({
      walletAddress: params.walletAddress,
      tradingBotId: params.tradingBotId ?? null,
      assetKey: asset.key,
      mint: asset.mint,
      tokensSoldRaw: sellRaw.toString(),
      usdcReceived,
      txSignature: exec.signature,
      notesPrefix: `Unparked ${asset.displayName}.`,
    });
    position = r.position;
    costBasisRemoved = r.costBasisRemoved;
    realizedPnl = r.realizedPnl;
  } catch (e: any) {
    dbWarning = `Unpark succeeded on-chain (signature ${exec.signature}) but updating your cost basis failed. Your USDC is safe in the bot wallet.`;
    console.error("[Vault] applyVaultUnpark failed after a successful unpark", e);
  }

  return {
    success: true,
    signature: exec.signature,
    usdcReceived,
    tokensSold: fromRaw(sellRaw, asset.decimals),
    costBasisRemoved,
    realizedPnl,
    priceImpactPct: exec.priceImpactPct ?? null,
    position,
    dbWarning,
  };
  });
}

// --- Valuation --------------------------------------------------------------

export interface VaultPositionView {
  assetKey: string;
  displayName: string;
  mint: string;
  decimals: number;
  route: YieldAsset["route"];
  valuation: YieldAsset["valuation"];
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
  tradingBotId?: string | null,
): Promise<VaultPositionView[]> {
  const enabled = getEnabledYieldAssets();
  const dbRows = await storage.getVaultPositions(walletAddress, tradingBotId ?? null);
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
      const val = await getYieldRoute(asset).valueInUsdc(onChainRaw);
      currentValueUsdc = val.valueUsdcRaw === null ? null : fromRaw(BigInt(val.valueUsdcRaw), USDC_DECIMALS);
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
      route: asset.route,
      valuation: asset.valuation,
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
