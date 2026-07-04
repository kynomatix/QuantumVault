/**
 * Fixed Yield vault — deposit executor (Exponent PT markets).
 *
 * Money path: USDC → underlying (Jupiter swap) → buy PT (Exponent ixWrapperBuyPt).
 * Clones the audited loop-executor swap-leg op machine exactly:
 *   - one borrow_operations row per logical deposit (client_request_id idempotent),
 *   - write-ahead signature + strict pre-leg baseline BEFORE every broadcast,
 *   - an ambiguous leg is reconciled by ON-CHAIN SIGNATURE STATUS (never by a
 *     balance read alone — an in-flight tx reads as "nothing arrived"),
 *   - a failed-on-chain leg clears its breadcrumb and retries; an unknown leg
 *     only retries once the recorded blockhash window is provably over.
 *
 * Steps: initialized → swap_sent → swapped → buy_sent → bought → succeeded.
 * The fy_positions row + equity event are written AFTER 'bought' but BEFORE the
 * op is marked succeeded, guarded by metadata ids so a resume never double-inserts.
 */

import { PublicKey } from "@solana/web3.js";
import {
  getServerConnection,
  executeAgentInstructions,
  executeAgentSwap,
  getAgentTokenBalanceRawStrict,
  USDC_MINT,
} from "../../agent-wallet";
import { storage } from "../../storage";
import { ensureVaultGas } from "../gas-funding";
import { withBorrowLock } from "../jupiter-lend-borrow-executor";
import { pickBestFixedYieldMarket, getFixedYieldMarketQuote, type ExponentMarketView } from "./exponent-markets";

const DEFAULT_SLIPPAGE_BPS = 100; // 1% — PT books are thinner than spot
const ATA_RENT_LAMPORTS = 2_039_280;
// Buy leg may create SY + PT ATAs (setupIxs); +1 margin for the underlying ATA.
const EXTRA_RENT_LAMPORTS = 3 * ATA_RENT_LAMPORTS;
const MIN_DEPOSIT_USDC = 1;
// PT trades at a discount to the underlying pre-maturity. Outside this band the
// pinned price is garbage — fail closed rather than compute a nonsense minPtOut.
const PT_PRICE_SANE_MIN = 0.5;
const PT_PRICE_SANE_MAX = 1.001;

export interface FyDepositResult {
  success: boolean;
  /** True when the op is safe to retry with the SAME clientRequestId. */
  resumable?: boolean;
  error?: string;
  positionId?: string;
  ptAmountRaw?: string;
  ptAmountUi?: number;
  usdcSpent?: number;
  underlyingSymbol?: string;
  marketAddress?: string;
  maturityTs?: number;
  impliedApy?: number;
  swapSignature?: string;
  buySignature?: string;
}

export function fyLockKey(walletAddress: string): string {
  return JSON.stringify(["fy", walletAddress]);
}

function isUniqueViolation(e: unknown): boolean {
  const code = (e as any)?.code ?? (e as any)?.cause?.code;
  return code === "23505";
}

function toUi(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

/** Load the Exponent market via the SDK and verify it against the pinned facts. */
async function loadVerifiedMarket(meta: Record<string, any>): Promise<{ market: any; error?: string }> {
  const sdk: any = await import("@exponent-labs/exponent-sdk");
  const connection = getServerConnection();
  const market = await sdk.MarketThree.load(sdk.LOCAL_ENV, connection, new PublicKey(meta.marketAddress));
  const mintPt: PublicKey | undefined = market?.mintPt;
  if (!mintPt || mintPt.toBase58() !== meta.ptMint) {
    return { market: null, error: "Fixed Yield market changed on-chain (PT mint mismatch). Deposit aborted." };
  }
  const expSec = Number(market?.vault?.expirationTimestamp ?? 0);
  const pinnedTs = Number(meta.maturityTs ?? 0);
  if (!Number.isFinite(expSec) || expSec <= 0 || Math.abs(expSec - pinnedTs) > 86_400) {
    return { market: null, error: "Fixed Yield market maturity does not match the quoted market. Deposit aborted." };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (expSec <= nowSec + 3 * 86_400) {
    return { market: null, error: "This fixed-rate market is too close to maturity to enter. Try again later." };
  }
  return { market };
}

/**
 * Deposit USDC into the best fixed-rate market. Account scope only (v1).
 * Serialized per wallet; idempotent per clientRequestId.
 */
export async function executeFixedYieldDeposit(params: {
  walletAddress: string;
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  amountUsdc: number;
  clientRequestId: string;
  slippageBps?: number;
}): Promise<FyDepositResult> {
  const { walletAddress, agentPublicKey, agentSecretKey } = params;
  const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

  if (!Number.isFinite(params.amountUsdc) || params.amountUsdc < MIN_DEPOSIT_USDC) {
    return { success: false, error: `Minimum deposit is ${MIN_DEPOSIT_USDC} USDC.` };
  }
  if (!params.clientRequestId || typeof params.clientRequestId !== "string") {
    return { success: false, error: "Missing request id. Refresh and try again." };
  }

  return withBorrowLock(fyLockKey(walletAddress), async () => {
    const connection = getServerConnection();

    // --- Op row: resume-or-create (idempotent per clientRequestId) ----------
    let op = await storage.getBorrowOperationByClientRequestId(walletAddress, params.clientRequestId);
    if (op && op.operationType !== "fy_deposit") {
      return { success: false, error: "This request id belongs to a different operation. Refresh and try again." };
    }
    if (op?.status === "succeeded" && op.result) {
      return op.result as unknown as FyDepositResult;
    }
    if (op?.status === "failed") {
      return {
        success: false,
        error: op.error || "This deposit attempt already failed. Start a new deposit.",
      };
    }

    if (!op) {
      // Pin the market NOW so every retry of this logical deposit uses the
      // exact same market/PT/maturity — never a silently different pick.
      const best = await pickBestFixedYieldMarket();
      if (!best) {
        return { success: false, error: "No eligible fixed-rate market is available right now. Try again later." };
      }
      const ptPrice = best.ptPriceInAsset;
      if (ptPrice === null || ptPrice <= PT_PRICE_SANE_MIN || ptPrice >= PT_PRICE_SANE_MAX) {
        return { success: false, error: "The fixed-rate market price looks unreliable right now. Try again later." };
      }
      const amountUsdcRaw = BigInt(Math.round(params.amountUsdc * 1e6));
      try {
        op = await storage.createBorrowOperation({
          walletAddress,
          operationType: "fy_deposit",
          status: "pending",
          step: "initialized",
          clientRequestId: params.clientRequestId,
          metadata: {
            kind: "fy",
            venue: "exponent",
            marketAddress: best.marketAddress,
            vaultAddress: best.vaultAddress,
            ptMint: best.ptMint,
            underlyingMint: best.underlyingMint,
            underlyingSymbol: best.underlyingSymbol,
            underlyingDecimals: best.underlyingDecimals,
            maturityTs: best.maturityTs,
            impliedApy: best.impliedApy,
            ptPriceAtPin: ptPrice,
            amountUsdcRaw: amountUsdcRaw.toString(),
          },
        });
      } catch (e) {
        if (isUniqueViolation(e)) {
          op = await storage.getBorrowOperationByClientRequestId(walletAddress, params.clientRequestId);
        }
        if (!op) throw e;
      }
    }
    const opId = op.id;
    let meta = (op.metadata ?? {}) as Record<string, any>;
    const underlyingMint: string = meta.underlyingMint;
    const underlyingDecimals: number = Number(meta.underlyingDecimals ?? 9);
    const ptMint: string = meta.ptMint;

    const failOp = async (step: string, error: string) => {
      await storage.updateBorrowOperation(opId, { status: "failed", step, error });
    };

    let realizedUnderlyingRaw: bigint | null = null;
    let swapSignature: string | undefined = typeof meta.swapSignature === "string" ? meta.swapSignature : undefined;
    let buySignature: string | undefined = typeof meta.buySignature === "string" ? meta.buySignature : undefined;
    let ptReceivedRaw: bigint | null = null;
    try {
      if (typeof meta.realizedUnderlyingRaw === "string") realizedUnderlyingRaw = BigInt(meta.realizedUnderlyingRaw);
    } catch {
      realizedUnderlyingRaw = null;
    }
    try {
      if (typeof meta.ptReceivedRaw === "string") ptReceivedRaw = BigInt(meta.ptReceivedRaw);
    } catch {
      ptReceivedRaw = null;
    }

    try {
      // --- Resume an ambiguous SWAP by on-chain status (never balance-only) --
      if (realizedUnderlyingRaw === null && op.step === "swap_sent" && swapSignature) {
        const statuses = await connection.getSignatureStatuses([swapSignature], { searchTransactionHistory: true });
        const st = statuses.value[0];
        const landedOk = !!st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized");
        if (landedOk) {
          const beforeRaw = BigInt(String(meta.underlyingBeforeRaw ?? ""));
          const nowRaw = BigInt((await getAgentTokenBalanceRawStrict(agentPublicKey, underlyingMint)).amountRaw);
          const delta = nowRaw - beforeRaw;
          if (delta <= 0n) {
            return {
              success: false,
              resumable: true,
              swapSignature,
              error: "The conversion landed on-chain but the credited amount could not be measured yet. Wait a minute and retry.",
            };
          }
          realizedUnderlyingRaw = delta;
          await storage.updateBorrowOperation(opId, {
            step: "swapped",
            mergeMetadata: { realizedUnderlyingRaw: realizedUnderlyingRaw.toString() },
          });
        } else if (st && st.err) {
          // Failed on-chain: USDC never left. Clear breadcrumb, retry fresh below.
          await storage.updateBorrowOperation(opId, {
            step: "initialized",
            mergeMetadata: { swapSignature: null, underlyingBeforeRaw: null },
          });
          swapSignature = undefined;
        } else {
          const lvbh = Number(meta.swapLastValidBlockHeight ?? 0);
          let expired = false;
          if (Number.isFinite(lvbh) && lvbh > 0) {
            const h = await connection.getBlockHeight("confirmed").catch(() => null);
            if (h !== null && h > lvbh + 30) expired = true;
          }
          if (!expired) {
            return {
              success: false,
              resumable: true,
              swapSignature,
              error: "A previous conversion is still unresolved on-chain. Wait a minute and retry.",
            };
          }
          await storage.updateBorrowOperation(opId, {
            step: "initialized",
            mergeMetadata: { swapSignature: null, underlyingBeforeRaw: null },
          });
          swapSignature = undefined;
        }
      }

      // --- Resume an ambiguous BUY by on-chain status ------------------------
      if (ptReceivedRaw === null && op.step === "buy_sent" && buySignature) {
        const statuses = await connection.getSignatureStatuses([buySignature], { searchTransactionHistory: true });
        const st = statuses.value[0];
        const landedOk = !!st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized");
        if (landedOk) {
          const beforeRaw = BigInt(String(meta.ptBeforeRaw ?? ""));
          const nowRaw = BigInt((await getAgentTokenBalanceRawStrict(agentPublicKey, ptMint)).amountRaw);
          const delta = nowRaw - beforeRaw;
          if (delta <= 0n) {
            return {
              success: false,
              resumable: true,
              buySignature,
              error: "The purchase landed on-chain but the credited amount could not be measured yet. Wait a minute and retry.",
            };
          }
          ptReceivedRaw = delta;
          await storage.updateBorrowOperation(opId, {
            step: "bought",
            mergeMetadata: { ptReceivedRaw: ptReceivedRaw.toString(), buySignature },
          });
        } else if (st && st.err) {
          // Failed on-chain: the underlying never left. Retry the buy leg.
          await storage.updateBorrowOperation(opId, {
            step: "swapped",
            mergeMetadata: { buySignature: null, ptBeforeRaw: null },
          });
          buySignature = undefined;
        } else {
          const lvbh = Number(meta.buyLastValidBlockHeight ?? 0);
          let expired = false;
          if (Number.isFinite(lvbh) && lvbh > 0) {
            const h = await connection.getBlockHeight("confirmed").catch(() => null);
            if (h !== null && h > lvbh + 30) expired = true;
          }
          if (!expired) {
            return {
              success: false,
              resumable: true,
              buySignature,
              error: "A previous purchase is still unresolved on-chain. Wait a minute and retry.",
            };
          }
          await storage.updateBorrowOperation(opId, {
            step: "swapped",
            mergeMetadata: { buySignature: null, ptBeforeRaw: null },
          });
          buySignature = undefined;
        }
      }

      // --- Gas: fund fees + the up-to-3 new ATAs (skip once past the legs) ---
      if (ptReceivedRaw === null) {
        const gas = await ensureVaultGas({
          payingPublicKey: agentPublicKey,
          funderPublicKey: agentPublicKey,
          funderSecretKey: agentSecretKey,
          destMint: underlyingMint,
          label: "Fixed Yield",
          extraRentLamports: EXTRA_RENT_LAMPORTS,
        });
        if (!gas.ok) {
          return { success: false, resumable: true, error: gas.error || "Not enough SOL for network fees. Retry in a moment." };
        }
      }

      // --- Leg 1: swap USDC → underlying (skipped when already 'swapped') ----
      if (realizedUnderlyingRaw === null && ptReceivedRaw === null) {
        const amountUsdcRaw = BigInt(String(meta.amountUsdcRaw));
        const bal = BigInt((await getAgentTokenBalanceRawStrict(agentPublicKey, USDC_MINT)).amountRaw); // throws → fail closed
        if (bal < amountUsdcRaw) {
          return {
            success: false,
            resumable: true,
            error: `Not enough spare USDC in the internal wallet (have ${toUi(bal, 6).toFixed(2)}, need ${toUi(amountUsdcRaw, 6).toFixed(2)}).`,
          };
        }

        // Write-ahead baseline BEFORE broadcast — the swap reconcile depends on it.
        const underlyingBefore = BigInt((await getAgentTokenBalanceRawStrict(agentPublicKey, underlyingMint)).amountRaw);
        await storage.updateBorrowOperation(opId, {
          mergeMetadata: { underlyingBeforeRaw: underlyingBefore.toString() },
        });

        const swap = await executeAgentSwap({
          agentPublicKey,
          agentSecretKey,
          inputMint: USDC_MINT,
          outputMint: underlyingMint,
          amountRaw: amountUsdcRaw.toString(),
          slippageBps,
          onBeforeBroadcast: async (info) => {
            await storage.updateBorrowOperation(opId, {
              step: "swap_sent",
              appendTxSignature: info.signature,
              mergeMetadata: {
                swapSignature: info.signature,
                swapLastValidBlockHeight: info.lastValidBlockHeight,
              },
            });
          },
        });

        if (!swap.success) {
          if (swap.signature) {
            // Broadcast happened, outcome unknown — leave the breadcrumb.
            return {
              success: false,
              resumable: true,
              swapSignature: swap.signature,
              error: `${swap.error || "Conversion did not complete."} Your USDC is safe. Retry to reconcile.`,
            };
          }
          await storage.updateBorrowOperation(opId, {
            step: "initialized",
            mergeMetadata: { swapSignature: null, underlyingBeforeRaw: null },
          });
          return {
            success: false,
            resumable: true,
            error: `${swap.error || "Conversion failed."} Your USDC is untouched. Retry in a moment.`,
          };
        }

        realizedUnderlyingRaw = BigInt(swap.outputReceivedRaw!);
        swapSignature = swap.signature;
        await storage.updateBorrowOperation(opId, {
          step: "swapped",
          mergeMetadata: { realizedUnderlyingRaw: realizedUnderlyingRaw.toString(), swapSignature },
        });
      }

      // --- Leg 2: buy PT with the realized underlying -------------------------
      if (ptReceivedRaw === null) {
        if (realizedUnderlyingRaw === null || realizedUnderlyingRaw <= 0n) {
          await failOp("swapped", "Internal error: no converted amount recorded.");
          return { success: false, error: "Something went wrong recording the conversion. Start a new deposit." };
        }

        const { market, error: mktError } = await loadVerifiedMarket(meta);
        if (!market) {
          // Nothing broadcast — the underlying sits in the wallet. Resumable.
          return { success: false, resumable: true, error: mktError };
        }

        // PT decimals from the chain (authoritative), cached in metadata.
        let ptDecimals = Number(meta.ptDecimals ?? NaN);
        if (!Number.isFinite(ptDecimals)) {
          const supply = await connection.getTokenSupply(new PublicKey(ptMint));
          ptDecimals = supply.value.decimals;
          await storage.updateBorrowOperation(opId, { mergeMetadata: { ptDecimals } });
        }

        // minPtOut from the pinned picker price (sanity-gated at pin time):
        // expected PT ≈ baseIn / ptPrice, then the slippage haircut.
        const ptPrice = Number(meta.ptPriceAtPin);
        if (!Number.isFinite(ptPrice) || ptPrice <= PT_PRICE_SANE_MIN || ptPrice >= PT_PRICE_SANE_MAX) {
          return { success: false, resumable: true, error: "The market price on record looks unreliable. Retry in a moment." };
        }
        const baseInUi = toUi(realizedUnderlyingRaw, underlyingDecimals);
        const minPtOut = BigInt(Math.floor((baseInUi / ptPrice) * (1 - slippageBps / 10_000) * 10 ** ptDecimals));
        if (minPtOut <= 0n) {
          return { success: false, resumable: true, error: "Deposit too small to protect against slippage. Start a new, larger deposit." };
        }

        // Strict PT baseline BEFORE broadcast — the buy reconcile depends on it.
        const ptBefore = BigInt((await getAgentTokenBalanceRawStrict(agentPublicKey, ptMint)).amountRaw);
        await storage.updateBorrowOperation(opId, {
          mergeMetadata: { ptBeforeRaw: ptBefore.toString() },
        });

        const owner = new PublicKey(agentPublicKey);
        const { ixs, setupIxs } = await market.ixWrapperBuyPt({
          owner,
          baseIn: realizedUnderlyingRaw,
          minPtOut,
        });

        const altAccount = market.addressLookupTable
          ? (await connection.getAddressLookupTable(market.addressLookupTable)).value
          : null;

        const buy = await executeAgentInstructions({
          agentPublicKey,
          agentSecretKey,
          instructions: [...setupIxs, ...ixs],
          verifyOutputMint: ptMint,
          addressLookupTables: altAccount ? [altAccount] : undefined,
          label: "Fixed Yield Buy",
          onBeforeBroadcast: async (info) => {
            await storage.updateBorrowOperation(opId, {
              step: "buy_sent",
              appendTxSignature: info.signature,
              mergeMetadata: {
                buySignature: info.signature,
                buyLastValidBlockHeight: info.lastValidBlockHeight,
              },
            });
          },
        });

        if (!buy.success) {
          if (buy.onChainFailed) {
            // Landed but reverted: the underlying never left. Retry the buy leg.
            await storage.updateBorrowOperation(opId, {
              step: "swapped",
              mergeMetadata: { buySignature: null, ptBeforeRaw: null },
            });
            return {
              success: false,
              resumable: true,
              error: `${buy.error || "The purchase was rejected on-chain."} Your converted funds are safe. Retry in a moment.`,
            };
          }
          if (buy.signature) {
            // Broadcast, outcome unknown — leave the 'buy_sent' breadcrumb.
            return {
              success: false,
              resumable: true,
              buySignature: buy.signature,
              error: `${buy.error || "The purchase did not complete."} Your funds are safe. Retry to reconcile.`,
            };
          }
          await storage.updateBorrowOperation(opId, {
            step: "swapped",
            mergeMetadata: { buySignature: null, ptBeforeRaw: null },
          });
          return {
            success: false,
            resumable: true,
            error: `${buy.error || "The purchase failed."} Your converted funds are safe. Retry in a moment.`,
          };
        }

        ptReceivedRaw = BigInt(buy.outputReceivedRaw!);
        buySignature = buy.signature;
        await storage.updateBorrowOperation(opId, {
          step: "bought",
          mergeMetadata: { ptReceivedRaw: ptReceivedRaw.toString(), buySignature },
        });
      }

      // --- Persist: position row + equity event, then mark succeeded ---------
      // Re-read metadata: the legs above merged fields the local copy may lack.
      const fresh = await storage.getBorrowOperationById(opId);
      meta = (fresh?.metadata ?? meta) as Record<string, any>;
      const ptDecimals = Number(meta.ptDecimals ?? underlyingDecimals);
      const usdcSpent = toUi(BigInt(String(meta.amountUsdcRaw)), 6);
      const maturityTs = Number(meta.maturityTs);
      const maturityDate = new Date(maturityTs * 1000);

      let positionId: string | undefined = typeof meta.fyPositionId === "string" ? meta.fyPositionId : undefined;
      if (!positionId) {
        const row = await storage.createFyPosition({
          walletAddress,
          venue: "exponent",
          marketAddress: meta.marketAddress,
          venueVaultAddress: meta.vaultAddress ?? null,
          ptMint,
          ptDecimals,
          underlyingMint,
          underlyingSymbol: meta.underlyingSymbol,
          ptAmountRaw: ptReceivedRaw!.toString(),
          costBasisUsdc: usdcSpent.toFixed(6),
          impliedApyAtEntry: Number.isFinite(Number(meta.impliedApy)) ? Number(meta.impliedApy).toFixed(6) : null,
          maturityAt: maturityDate,
          status: "active",
        });
        positionId = row.id;
        await storage.updateBorrowOperation(opId, { mergeMetadata: { fyPositionId: positionId } });
      }

      if (!meta.equityEventId) {
        const maturityLabel = maturityDate.toISOString().slice(0, 10);
        const event = await storage.createEquityEvent({
          walletAddress,
          eventType: "fy_deposit",
          amount: usdcSpent.toFixed(6),
          assetType: "USDC",
          txSignature: buySignature ?? null,
          notes: `Locked ${usdcSpent.toFixed(2)} USDC at a fixed rate (PT-${meta.underlyingSymbol}, matures ${maturityLabel})`,
        });
        await storage.updateBorrowOperation(opId, { mergeMetadata: { equityEventId: event.id } });
      }

      const result: FyDepositResult = {
        success: true,
        positionId,
        ptAmountRaw: ptReceivedRaw!.toString(),
        ptAmountUi: toUi(ptReceivedRaw!, ptDecimals),
        usdcSpent,
        underlyingSymbol: meta.underlyingSymbol,
        marketAddress: meta.marketAddress,
        maturityTs,
        impliedApy: Number(meta.impliedApy),
        swapSignature,
        buySignature,
      };
      await storage.updateBorrowOperation(opId, {
        status: "succeeded",
        step: "succeeded",
        result: result as unknown as Record<string, unknown>,
      });
      return result;
    } catch (e: any) {
      // Unknown throw mid-machine: keep the op row + breadcrumbs so the SAME
      // clientRequestId resumes from the last recorded step. Never mark failed
      // here — money may be mid-flight.
      console.error("[fixed-yield] deposit error (resumable):", e?.message || e);
      return {
        success: false,
        resumable: true,
        swapSignature,
        buySignature,
        error: "Something went wrong mid-deposit. Your funds are safe — retry to resume from where it stopped.",
      };
    }
  });
}

// ---------------------------------------------------------------------------
// Early exit: sell the position's PT back into the underlying on the same
// Exponent market (ixWrapperSellPt), then swap underlying → USDC. All-out per
// position (no partial exits — platform philosophy). Pre-maturity only: after
// maturity the AMM path is not the redemption path; v1 notifies instead.
//
// Steps: initialized → sell_sent → sold → swap_sent → swapped → succeeded.
// ---------------------------------------------------------------------------

export interface FyExitResult {
  success: boolean;
  /** True when the op is safe to retry with the SAME clientRequestId. */
  resumable?: boolean;
  error?: string;
  positionId?: string;
  usdcReceived?: number;
  ptSoldRaw?: string;
  costBasisUsdc?: number;
  sellSignature?: string;
  swapSignature?: string;
}

/** Verify the market on-chain for an EXIT (no minimum-days gate — we are leaving). */
async function loadVerifiedMarketForExit(meta: Record<string, any>): Promise<{ market: any; error?: string }> {
  const sdk: any = await import("@exponent-labs/exponent-sdk");
  const connection = getServerConnection();
  const market = await sdk.MarketThree.load(sdk.LOCAL_ENV, connection, new PublicKey(meta.marketAddress));
  const mintPt: PublicKey | undefined = market?.mintPt;
  if (!mintPt || mintPt.toBase58() !== meta.ptMint) {
    return { market: null, error: "The market on-chain no longer matches this position (PT mint mismatch). Exit aborted." };
  }
  return { market };
}

/**
 * Sell a fixed-rate position back to USDC before maturity.
 * Serialized per wallet; idempotent per clientRequestId.
 */
export async function executeFixedYieldExit(params: {
  walletAddress: string;
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  positionId: string;
  clientRequestId: string;
  slippageBps?: number;
}): Promise<FyExitResult> {
  const { walletAddress, agentPublicKey, agentSecretKey } = params;
  const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

  if (!params.positionId || typeof params.positionId !== "string") {
    return { success: false, error: "Missing position id. Refresh and try again." };
  }
  if (!params.clientRequestId || typeof params.clientRequestId !== "string") {
    return { success: false, error: "Missing request id. Refresh and try again." };
  }

  return withBorrowLock(fyLockKey(walletAddress), async () => {
    const connection = getServerConnection();

    let op = await storage.getBorrowOperationByClientRequestId(walletAddress, params.clientRequestId);
    if (op && op.operationType !== "fy_exit") {
      return { success: false, error: "This request id belongs to a different operation. Refresh and try again." };
    }
    if (op?.status === "succeeded" && op.result) {
      return op.result as unknown as FyExitResult;
    }
    if (op?.status === "failed") {
      return { success: false, error: op.error || "This exit attempt already failed. Start a new exit." };
    }

    if (!op) {
      const position = await storage.getFyPositionById(params.positionId);
      if (!position || position.walletAddress !== walletAddress) {
        return { success: false, error: "Position not found." };
      }
      if (position.status !== "active") {
        return { success: false, error: "This position is no longer active." };
      }
      const nowMs = Date.now();
      if (position.maturityAt && position.maturityAt.getTime() <= nowMs) {
        return {
          success: false,
          error: "This position has matured — it no longer trades on the market. Redemption support is coming; your funds remain yours on-chain.",
        };
      }
      const rowAmountRaw = BigInt(position.ptAmountRaw);
      if (rowAmountRaw <= 0n) {
        return { success: false, error: "This position has no balance to exit." };
      }

      // Live price for the SELL protection — unfiltered quote (the market may
      // be too close to maturity for NEW deposits but must still price exits).
      const quote = await getFixedYieldMarketQuote(position.marketAddress);
      const ptPrice = quote?.ptPriceInAsset ?? null;
      if (ptPrice === null || ptPrice <= PT_PRICE_SANE_MIN || ptPrice >= PT_PRICE_SANE_MAX) {
        return { success: false, error: "The market price looks unreliable right now. Try again in a few minutes." };
      }
      if (quote?.ptMint && quote.ptMint !== position.ptMint) {
        return { success: false, error: "The market listing changed (PT mint mismatch). Exit aborted." };
      }

      // Sell what we actually hold, capped at what the row says is this
      // position's share (strict read — fail closed on unreadable).
      const heldRaw = BigInt((await getAgentTokenBalanceRawStrict(agentPublicKey, position.ptMint)).amountRaw);
      if (heldRaw <= 0n) {
        return { success: false, error: "No PT tokens found in the internal wallet for this position. Contact support before retrying." };
      }
      const ptToSellRaw = heldRaw < rowAmountRaw ? heldRaw : rowAmountRaw;

      try {
        op = await storage.createBorrowOperation({
          walletAddress,
          operationType: "fy_exit",
          status: "pending",
          step: "initialized",
          clientRequestId: params.clientRequestId,
          metadata: {
            kind: "fy",
            venue: "exponent",
            positionId: position.id,
            marketAddress: position.marketAddress,
            ptMint: position.ptMint,
            ptDecimals: position.ptDecimals,
            underlyingMint: position.underlyingMint,
            underlyingSymbol: position.underlyingSymbol,
            costBasisUsdc: position.costBasisUsdc,
            ptToSellRaw: ptToSellRaw.toString(),
            ptPriceAtPin: ptPrice,
          },
        });
      } catch (e) {
        if (isUniqueViolation(e)) {
          op = await storage.getBorrowOperationByClientRequestId(walletAddress, params.clientRequestId);
        }
        if (!op) throw e;
      }
    }
    const opId = op.id;
    let meta = (op.metadata ?? {}) as Record<string, any>;
    const ptMint: string = meta.ptMint;
    const underlyingMint: string = meta.underlyingMint;

    let sellSignature: string | undefined = typeof meta.sellSignature === "string" ? meta.sellSignature : undefined;
    let swapSignature: string | undefined = typeof meta.swapSignature === "string" ? meta.swapSignature : undefined;
    let realizedUnderlyingRaw: bigint | null = null;
    let usdcReceivedRaw: bigint | null = null;
    try {
      if (typeof meta.realizedUnderlyingRaw === "string") realizedUnderlyingRaw = BigInt(meta.realizedUnderlyingRaw);
    } catch {
      realizedUnderlyingRaw = null;
    }
    try {
      if (typeof meta.usdcReceivedRaw === "string") usdcReceivedRaw = BigInt(meta.usdcReceivedRaw);
    } catch {
      usdcReceivedRaw = null;
    }

    try {
      // --- Resume an ambiguous SELL by on-chain status ----------------------
      if (realizedUnderlyingRaw === null && op.step === "sell_sent" && sellSignature) {
        const statuses = await connection.getSignatureStatuses([sellSignature], { searchTransactionHistory: true });
        const st = statuses.value[0];
        const landedOk = !!st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized");
        if (landedOk) {
          const beforeRaw = BigInt(String(meta.underlyingBeforeRaw ?? ""));
          const nowRaw = BigInt((await getAgentTokenBalanceRawStrict(agentPublicKey, underlyingMint)).amountRaw);
          const delta = nowRaw - beforeRaw;
          if (delta <= 0n) {
            return {
              success: false,
              resumable: true,
              sellSignature,
              error: "The sale landed on-chain but the credited amount could not be measured yet. Wait a minute and retry.",
            };
          }
          realizedUnderlyingRaw = delta;
          await storage.updateBorrowOperation(opId, {
            step: "sold",
            mergeMetadata: { realizedUnderlyingRaw: realizedUnderlyingRaw.toString() },
          });
        } else if (st && st.err) {
          // Failed on-chain: the PT never left. Retry the sell leg fresh.
          await storage.updateBorrowOperation(opId, {
            step: "initialized",
            mergeMetadata: { sellSignature: null, underlyingBeforeRaw: null },
          });
          sellSignature = undefined;
        } else {
          const lvbh = Number(meta.sellLastValidBlockHeight ?? 0);
          let expired = false;
          if (Number.isFinite(lvbh) && lvbh > 0) {
            const h = await connection.getBlockHeight("confirmed").catch(() => null);
            if (h !== null && h > lvbh + 30) expired = true;
          }
          if (!expired) {
            return {
              success: false,
              resumable: true,
              sellSignature,
              error: "A previous sale is still unresolved on-chain. Wait a minute and retry.",
            };
          }
          await storage.updateBorrowOperation(opId, {
            step: "initialized",
            mergeMetadata: { sellSignature: null, underlyingBeforeRaw: null },
          });
          sellSignature = undefined;
        }
      }

      // --- Resume an ambiguous SWAP by on-chain status ----------------------
      if (usdcReceivedRaw === null && op.step === "swap_sent" && swapSignature) {
        const statuses = await connection.getSignatureStatuses([swapSignature], { searchTransactionHistory: true });
        const st = statuses.value[0];
        const landedOk = !!st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized");
        if (landedOk) {
          const beforeRaw = BigInt(String(meta.usdcBeforeRaw ?? ""));
          const nowRaw = BigInt((await getAgentTokenBalanceRawStrict(agentPublicKey, USDC_MINT)).amountRaw);
          const delta = nowRaw - beforeRaw;
          if (delta <= 0n) {
            return {
              success: false,
              resumable: true,
              swapSignature,
              error: "The conversion landed on-chain but the credited amount could not be measured yet. Wait a minute and retry.",
            };
          }
          usdcReceivedRaw = delta;
          await storage.updateBorrowOperation(opId, {
            step: "swapped",
            mergeMetadata: { usdcReceivedRaw: usdcReceivedRaw.toString() },
          });
        } else if (st && st.err) {
          // Failed on-chain: the underlying never left. Retry the swap leg.
          await storage.updateBorrowOperation(opId, {
            step: "sold",
            mergeMetadata: { swapSignature: null, usdcBeforeRaw: null },
          });
          swapSignature = undefined;
        } else {
          const lvbh = Number(meta.swapLastValidBlockHeight ?? 0);
          let expired = false;
          if (Number.isFinite(lvbh) && lvbh > 0) {
            const h = await connection.getBlockHeight("confirmed").catch(() => null);
            if (h !== null && h > lvbh + 30) expired = true;
          }
          if (!expired) {
            return {
              success: false,
              resumable: true,
              swapSignature,
              error: "A previous conversion is still unresolved on-chain. Wait a minute and retry.",
            };
          }
          await storage.updateBorrowOperation(opId, {
            step: "sold",
            mergeMetadata: { swapSignature: null, usdcBeforeRaw: null },
          });
          swapSignature = undefined;
        }
      }

      // --- Gas: fees + possible SY/underlying ATAs on the sell leg ----------
      if (usdcReceivedRaw === null) {
        const gas = await ensureVaultGas({
          payingPublicKey: agentPublicKey,
          funderPublicKey: agentPublicKey,
          funderSecretKey: agentSecretKey,
          destMint: underlyingMint,
          label: "Fixed Yield Exit",
          extraRentLamports: EXTRA_RENT_LAMPORTS,
        });
        if (!gas.ok) {
          return { success: false, resumable: true, error: gas.error || "Not enough SOL for network fees. Retry in a moment." };
        }
      }

      // --- Leg 1: sell PT → underlying (skipped when already 'sold') --------
      if (realizedUnderlyingRaw === null && usdcReceivedRaw === null) {
        const ptToSellRaw = BigInt(String(meta.ptToSellRaw));
        const heldRaw = BigInt((await getAgentTokenBalanceRawStrict(agentPublicKey, ptMint)).amountRaw); // throws → fail closed
        if (heldRaw < ptToSellRaw) {
          return {
            success: false,
            resumable: true,
            error: "The wallet's PT balance no longer covers this exit. Retry in a moment — if this persists, contact support.",
          };
        }

        const { market, error: mktError } = await loadVerifiedMarketForExit(meta);
        if (!market) {
          return { success: false, resumable: true, error: mktError };
        }

        const ptDecimals = Number(meta.ptDecimals);
        const underlyingDecimals = Number(meta.underlyingDecimals ?? 9);
        const ptPrice = Number(meta.ptPriceAtPin);
        if (!Number.isFinite(ptPrice) || ptPrice <= PT_PRICE_SANE_MIN || ptPrice >= PT_PRICE_SANE_MAX) {
          return { success: false, resumable: true, error: "The market price on record looks unreliable. Retry in a moment." };
        }
        const ptUi = toUi(ptToSellRaw, ptDecimals);
        const minBaseOut = BigInt(Math.floor(ptUi * ptPrice * (1 - slippageBps / 10_000) * 10 ** underlyingDecimals));
        if (minBaseOut <= 0n) {
          return { success: false, resumable: true, error: "Position too small to protect against slippage. Contact support." };
        }

        // Write-ahead baseline BEFORE broadcast — the sell reconcile depends on it.
        const underlyingBefore = BigInt((await getAgentTokenBalanceRawStrict(agentPublicKey, underlyingMint)).amountRaw);
        await storage.updateBorrowOperation(opId, {
          mergeMetadata: { underlyingBeforeRaw: underlyingBefore.toString(), underlyingDecimals },
        });

        const owner = new PublicKey(agentPublicKey);
        const { ixs, setupIxs } = await market.ixWrapperSellPt({
          owner,
          amount: ptToSellRaw,
          minBaseOut,
        });

        const altAccount = market.addressLookupTable
          ? (await connection.getAddressLookupTable(market.addressLookupTable)).value
          : null;

        const sell = await executeAgentInstructions({
          agentPublicKey,
          agentSecretKey,
          instructions: [...setupIxs, ...ixs],
          verifyOutputMint: underlyingMint,
          addressLookupTables: altAccount ? [altAccount] : undefined,
          label: "Fixed Yield Sell",
          onBeforeBroadcast: async (info) => {
            await storage.updateBorrowOperation(opId, {
              step: "sell_sent",
              appendTxSignature: info.signature,
              mergeMetadata: {
                sellSignature: info.signature,
                sellLastValidBlockHeight: info.lastValidBlockHeight,
              },
            });
          },
        });

        if (!sell.success) {
          if (sell.onChainFailed) {
            // Landed but reverted: the PT never left. Retry the sell leg.
            await storage.updateBorrowOperation(opId, {
              step: "initialized",
              mergeMetadata: { sellSignature: null, underlyingBeforeRaw: null },
            });
            return {
              success: false,
              resumable: true,
              error: `${sell.error || "The sale was rejected on-chain."} Your position is untouched. Retry in a moment.`,
            };
          }
          if (sell.signature) {
            return {
              success: false,
              resumable: true,
              sellSignature: sell.signature,
              error: `${sell.error || "The sale did not complete."} Your funds are safe. Retry to reconcile.`,
            };
          }
          await storage.updateBorrowOperation(opId, {
            step: "initialized",
            mergeMetadata: { sellSignature: null, underlyingBeforeRaw: null },
          });
          return {
            success: false,
            resumable: true,
            error: `${sell.error || "The sale failed."} Your position is untouched. Retry in a moment.`,
          };
        }

        realizedUnderlyingRaw = BigInt(sell.outputReceivedRaw!);
        sellSignature = sell.signature;
        await storage.updateBorrowOperation(opId, {
          step: "sold",
          mergeMetadata: { realizedUnderlyingRaw: realizedUnderlyingRaw.toString(), sellSignature },
        });
      }

      // --- Leg 2: swap underlying → USDC -------------------------------------
      if (usdcReceivedRaw === null) {
        if (realizedUnderlyingRaw === null || realizedUnderlyingRaw <= 0n) {
          await failOpExit(opId, "sold", "Internal error: no sale proceeds recorded.");
          return { success: false, error: "Something went wrong recording the sale. Contact support before retrying." };
        }

        // Write-ahead USDC baseline BEFORE broadcast.
        const usdcBefore = BigInt((await getAgentTokenBalanceRawStrict(agentPublicKey, USDC_MINT)).amountRaw);
        await storage.updateBorrowOperation(opId, {
          mergeMetadata: { usdcBeforeRaw: usdcBefore.toString() },
        });

        const swap = await executeAgentSwap({
          agentPublicKey,
          agentSecretKey,
          inputMint: underlyingMint,
          outputMint: USDC_MINT,
          amountRaw: realizedUnderlyingRaw.toString(),
          slippageBps,
          onBeforeBroadcast: async (info) => {
            await storage.updateBorrowOperation(opId, {
              step: "swap_sent",
              appendTxSignature: info.signature,
              mergeMetadata: {
                swapSignature: info.signature,
                swapLastValidBlockHeight: info.lastValidBlockHeight,
              },
            });
          },
        });

        if (!swap.success) {
          if (swap.signature) {
            return {
              success: false,
              resumable: true,
              swapSignature: swap.signature,
              error: `${swap.error || "Conversion did not complete."} Your funds are safe. Retry to reconcile.`,
            };
          }
          await storage.updateBorrowOperation(opId, {
            step: "sold",
            mergeMetadata: { swapSignature: null, usdcBeforeRaw: null },
          });
          return {
            success: false,
            resumable: true,
            error: `${swap.error || "Conversion failed."} The sale proceeds sit safely in the internal wallet. Retry in a moment.`,
          };
        }

        usdcReceivedRaw = BigInt(swap.outputReceivedRaw!);
        swapSignature = swap.signature;
        await storage.updateBorrowOperation(opId, {
          step: "swapped",
          mergeMetadata: { usdcReceivedRaw: usdcReceivedRaw.toString(), swapSignature },
        });
      }

      // --- Persist: close the position + equity event, then mark succeeded --
      const fresh = await storage.getBorrowOperationById(opId);
      meta = (fresh?.metadata ?? meta) as Record<string, any>;
      const usdcReceived = toUi(usdcReceivedRaw!, 6);
      const costBasisUsdc = Number(meta.costBasisUsdc ?? NaN);

      if (!meta.positionClosed) {
        await storage.updateFyPosition(String(meta.positionId), {
          status: "exited",
          ptAmountRaw: "0",
        });
        await storage.updateBorrowOperation(opId, { mergeMetadata: { positionClosed: true } });
      }

      if (!meta.equityEventId) {
        const pnl = Number.isFinite(costBasisUsdc) ? usdcReceived - costBasisUsdc : null;
        const pnlNote = pnl !== null ? ` (${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} vs. cost)` : "";
        const event = await storage.createEquityEvent({
          walletAddress,
          eventType: "fy_withdraw",
          amount: usdcReceived.toFixed(6),
          assetType: "USDC",
          txSignature: swapSignature ?? null,
          notes: `Exited fixed-rate position early (PT-${meta.underlyingSymbol}) for ${usdcReceived.toFixed(2)} USDC${pnlNote}`,
        });
        await storage.updateBorrowOperation(opId, { mergeMetadata: { equityEventId: event.id } });
      }

      const result: FyExitResult = {
        success: true,
        positionId: String(meta.positionId),
        usdcReceived,
        ptSoldRaw: String(meta.ptToSellRaw),
        costBasisUsdc: Number.isFinite(costBasisUsdc) ? costBasisUsdc : undefined,
        sellSignature,
        swapSignature,
      };
      await storage.updateBorrowOperation(opId, {
        status: "succeeded",
        step: "succeeded",
        result: result as unknown as Record<string, unknown>,
      });
      return result;
    } catch (e: any) {
      // Unknown throw mid-machine: keep the op row + breadcrumbs so the SAME
      // clientRequestId resumes from the last recorded step. Never mark failed
      // here — money may be mid-flight.
      console.error("[fixed-yield] exit error (resumable):", e?.message || e);
      return {
        success: false,
        resumable: true,
        sellSignature,
        swapSignature,
        error: "Something went wrong mid-exit. Your funds are safe — retry to resume from where it stopped.",
      };
    }
  });
}

async function failOpExit(opId: string, step: string, error: string): Promise<void> {
  await storage.updateBorrowOperation(opId, { status: "failed", step, error });
}
