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
import { getEnabledYieldAssets, getDetectableYieldAssets, getYieldAssetByKey, type YieldAsset } from "./yield-assets";
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
  /** True only for market-swap routes (Jupiter). Direct deposit/mint routes
   *  (Kamino, Jupiter Lend) have no price impact, so the UI shows "None". */
  impactApplies: boolean;
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
    impactApplies: false,
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
    impactApplies: route.kind === "jupiter",
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
  /** Realized USDC received, raw base units (exact on-chain delta). For callers
   *  that must feed the proceeds into another money leg (e.g. repay) as an exact
   *  bigint — never re-derive from the UI float, which loses precision. */
  usdcReceivedRaw?: string;
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
  amountToken?: number; // ignored when `all` is true OR amountTokenRaw is set
  /** Exact token amount to sell, raw base units. Takes precedence over
   *  amountToken (no float round-trip) and is clamped to the on-chain balance.
   *  Ignored when `all` is true. */
  amountTokenRaw?: bigint;
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

  // On-chain token balance is the truth for how much can be sold. Money-leg
  // callers pass an exact `amountTokenRaw`; for them read with the STRICT reader
  // so an UNREADABLE balance is DETECTED rather than silently treated as 0 (which
  // would surface a misleading "no balance"). We CATCH the throw and return a
  // restartable failure instead of letting it bubble: the multi-hop repay
  // orchestrator inspects the returned result, and an uncaught throw here would
  // wedge its op at the "unparking" step before any money moved. The fail-open
  // reader stays fine for the float/all-out paths (a 0 there means "nothing to do").
  let onChainRaw: bigint;
  if (params.amountTokenRaw != null) {
    try {
      const strict = await getAgentTokenBalanceRawStrict(params.agentPublicKey, asset.mint);
      onChainRaw = BigInt(strict.amountRaw);
    } catch {
      return { success: false, error: `Could not read your ${asset.displayName} balance. Your funds are safe — please try again.` };
    }
  } else {
    const onChain = await getAgentTokenBalanceRaw(params.agentPublicKey, asset.mint);
    onChainRaw = BigInt(onChain.amountRaw);
  }
  if (onChainRaw <= BigInt(0)) {
    return { success: false, error: `No ${asset.displayName} balance to unpark.` };
  }

  let sellRaw: bigint;
  if (params.all) {
    sellRaw = onChainRaw;
  } else if (params.amountTokenRaw != null) {
    // Exact raw amount (no float round-trip) — preferred by money-leg callers.
    sellRaw = params.amountTokenRaw;
    if (sellRaw <= BigInt(0)) return { success: false, error: "Amount is too small" };
    if (sellRaw > onChainRaw) sellRaw = onChainRaw; // clamp to available
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
    usdcReceivedRaw: BigInt(exec.outputReceivedRaw).toString(),
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
  // When true, also enumerate DISABLED (but real-mint) yield assets, so funds that
  // were parked while an asset was enabled and later disabled are still surfaced.
  // Default false keeps the original enabled-only view for existing callers; only
  // the carry advisor needs the detectable set (to fail closed on a disabled park).
  opts?: { includeDisabled?: boolean },
): Promise<VaultPositionView[]> {
  const assetSet = opts?.includeDisabled ? getDetectableYieldAssets() : getEnabledYieldAssets();
  const dbRows = await storage.getVaultPositions(walletAddress, tradingBotId ?? null);
  const dbByKey = new Map(dbRows.map((r) => [r.assetKey, r] as const));

  const views: VaultPositionView[] = [];
  for (const asset of assetSet) {
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

/**
 * Sum the live USDC value of every yield token a wallet holds on-chain, for
 * counting parked Vault funds as equity (NOT for moving money). This reads the
 * DETECTABLE asset set (enabled OR disabled with a real mint) so a token that
 * was parked and later disabled is still valued.
 *
 * Money-safety / fail-closed: this feeds balance snapshots and the live
 * portfolio total, so it MUST never fabricate a number. It uses the STRICT
 * balance reader (throws on an unreadable balance) and returns `ok: false` if
 * any read throws OR a held token cannot be priced. The caller then refuses to
 * persist/serve a partial total (mirrors the snapshot writer's failed-read
 * skip), and the next read retries on fresh data.
 *
 * @param agentPublicKey the wallet that holds the tokens — the account agent for
 *   the account vault, or a bot's own wallet pubkey for a per-bot Flash vault.
 */
export async function sumVaultPositionValueUsdc(
  agentPublicKey: string,
): Promise<{ valueUsdc: number; ok: boolean }> {
  let valueUsdc = 0;
  for (const asset of getDetectableYieldAssets()) {
    let raw: bigint;
    try {
      const bal = await getAgentTokenBalanceRawStrict(agentPublicKey, asset.mint);
      raw = BigInt(bal.amountRaw);
    } catch {
      return { valueUsdc: 0, ok: false }; // unreadable balance — fail closed
    }
    if (raw <= BigInt(0)) continue;
    try {
      const val = await getYieldRoute(asset).valueInUsdc(raw);
      if (val.valueUsdcRaw === null) return { valueUsdc: 0, ok: false }; // held but unpriceable
      valueUsdc += fromRaw(BigInt(val.valueUsdcRaw), USDC_DECIMALS);
    } catch {
      return { valueUsdc: 0, ok: false }; // valuation threw — fail closed
    }
  }
  return { valueUsdc, ok: true };
}

/**
 * Value an already-fetched set of vault rows against ONE wallet, for the
 * read-only "all parked balances" aggregate (account + per-bot). Unlike
 * getVaultPositionViews this does NOT scan every enabled asset — it values only
 * the rows it is handed (Vault parking always writes a row), so RPC stays
 * bounded by the number of parked bots.
 *
 * Honest, not fail-open: a row whose on-chain balance can't be read (the strict
 * reader throws) or can't be priced is returned with currentValueUsdc=null plus
 * a warning, so the caller leaves it out of totals instead of fabricating a
 * zero. A row that reads a genuine on-chain zero (already unparked) is dropped.
 * Assets resolve from the DETECTABLE set (verified mints, ENABLED OR DISABLED)
 * so a token still held after its asset was disabled is valued; blank-mint
 * placeholder rows are skipped (they would throw on `new PublicKey("")`).
 */
export async function valueVaultRowsForWallet(
  agentPublicKey: string,
  rows: VaultPosition[],
): Promise<{ views: VaultPositionView[]; warnings: string[] }> {
  const byKey = new Map(getDetectableYieldAssets().map((a) => [a.key, a] as const));
  const views: VaultPositionView[] = [];
  const warnings: string[] = [];

  for (const row of rows) {
    const asset = byKey.get(row.assetKey);
    if (!asset) {
      warnings.push(`${row.assetKey} is no longer available`);
      continue;
    }

    let onChainRaw = BigInt(0);
    let onChainAmount = 0;
    let unreadable = false;
    try {
      const bal = await getAgentTokenBalanceRawStrict(agentPublicKey, asset.mint);
      onChainRaw = BigInt(bal.amountRaw);
      onChainAmount = bal.uiAmount;
    } catch {
      unreadable = true; // fail honest: surface as "couldn't refresh", not zero
    }

    // A clean on-chain zero means the position is already emptied — don't show it.
    if (!unreadable && onChainRaw <= BigInt(0)) continue;

    let currentValueUsdc: number | null = null;
    if (!unreadable) {
      try {
        const val = await getYieldRoute(asset).valueInUsdc(onChainRaw);
        currentValueUsdc = val.valueUsdcRaw === null ? null : fromRaw(BigInt(val.valueUsdcRaw), USDC_DECIMALS);
      } catch {
        currentValueUsdc = null;
      }
    }
    if (currentValueUsdc === null) {
      warnings.push(`${asset.displayName} balance couldn't be refreshed`);
    }

    const costBasisUsdc = Number(row.usdcCostBasis);
    const unrealizedPnl = currentValueUsdc !== null ? currentValueUsdc - costBasisUsdc : null;

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
      costBasisMissing: false,
    });
  }

  return { views, warnings };
}
