/**
 * Jupiter Lend BORROW — multi-hop REPAY orchestrators (sources #2/#3/#4).
 *
 * The borrow engine's RepayDialog offers four funding sources. Source #1 ("Pay
 * from Trading Agent USDC") is a single atomic tx and lives in the executor as
 * `executeRepayFromAgentUsdc`. The other three are MULTI-HOP — they move money
 * across two or three separate transactions that cannot be made atomic:
 *
 *   #2  Pay from Your Wallet USDC   — user transfers USDC -> agent, then repay.
 *   #3  Pay with deposited collateral (DELEVERAGE) — withdraw collateral ->
 *       swap to USDC -> repay.
 *   #4  Pay with any wallet token   — user transfers token -> agent -> swap to
 *       USDC -> repay.
 *
 * This file is a thin ORCHESTRATOR. It never builds its own money instructions;
 * it COMPOSES the already-audited, independently fail-closed primitives:
 *   - executeWithdrawCollateral / executeRepayFromAgentUsdc (this engine), each
 *     of which serializes on the account+vault `withBorrowLock`, re-runs its risk
 *     gate, and proves the result from a realized on-chain delta.
 *   - executeAgentSwapToUsdc (agent-wallet), an ExactIn swap whose realized
 *     output-token delta is the source of truth.
 *
 * Money-safety contract for the COMPOSITION (the single-tx legs already enforce
 * their own):
 *  - A 5-minute scope lock CANNOT span a multi-hop op, so cross-step safety comes
 *    from a DB-backed, idempotent, RESUMABLE state machine (borrow_operations
 *    with a per-wallet UNIQUE clientRequestId + a jsonb metadata breadcrumb).
 *  - Every step persists BEFORE it acts and records its realized on-chain amount
 *    + tx signature AFTER. A retry with the same clientRequestId resumes from the
 *    last proven step; it never re-runs a confirmed leg.
 *  - On-chain balances are the resume AUTHORITY. The presence of withdrawn
 *    collateral / a swapped USDC delta in the agent wallet — read STRICTLY (fail
 *    closed on an unreadable balance) — is what proves a leg landed, not a
 *    returned signature.
 *  - The repay leg is CAPPED at live debt by `executeRepayFromAgentUsdc`, so no
 *    composition can ever overpay; any USDC beyond the debt simply remains as
 *    recoverable trading-wallet USDC.
 *  - Funds at every intermediate step sit in the agent wallet (recoverable),
 *    never stranded. A leg failure marks the op `needs_attention` and stops; it
 *    never fabricates success.
 *  - Concurrent runs of the SAME op (double-click / racing retry) serialize on a
 *    `multihop:<wallet>:<clientRequestId>` lock so the on-chain idempotency reads
 *    cannot interleave into a double-withdraw.
 */

import { PublicKey } from "@solana/web3.js";
import { storage } from "../storage";
import type { BorrowOperation } from "@shared/schema";
import {
  executeAgentSwapToUsdc,
  getAgentTokenBalanceRawStrict,
  getServerConnection,
  USDC_MINT,
} from "../agent-wallet";
import {
  executeWithdrawCollateral,
  executeRepayFromAgentUsdc,
  withBorrowLock,
} from "./jupiter-lend-borrow-executor";
import { JupiterLendBorrowRoute } from "./jupiter-lend-borrow-route";
import { getDetectableYieldAssets, getEnabledYieldAssets } from "./yield-assets";
import { getYieldRoute } from "./yield-routes";
import { unparkToUsdc } from "./vault-service";

const DEFAULT_SWAP_SLIPPAGE_BPS = 100;
const MAX_SWAP_SLIPPAGE_BPS = 500;

export interface MultiHopRepayResult {
  success: boolean;
  operationId?: string;
  /** Realized debt reduction in USDC (UI units), from the repay leg's on-chain read. */
  repaidUsdc?: number;
  /** AUTHORITATIVE remaining debt after the repay, raw base units. */
  observedDebtRaw?: string;
  fullyRepaid?: boolean;
  /** USDC the deleverage/swap produced, raw base units (proceeds fed to the repay). */
  swappedUsdcRaw?: string;
  /** Every on-chain signature this op produced, oldest first. */
  signatures?: string[];
  /** Last persisted step (for client resume / display). */
  step?: string;
  /** True when funds are safe but a leg needs operator/retry attention. */
  needsAttention?: boolean;
  warning?: string;
  error?: string;
}

type Meta = Record<string, any>;

function readMeta(op: BorrowOperation): Meta {
  return (op.metadata as Meta | null) ?? {};
}

function clampSlippage(bps?: number): number {
  if (typeof bps !== "number" || !Number.isFinite(bps) || bps <= 0) return DEFAULT_SWAP_SLIPPAGE_BPS;
  return Math.min(Math.round(bps), MAX_SWAP_SLIPPAGE_BPS);
}

/** Strict agent-token balance as bigint. THROWS on an unreadable balance so a
 *  caller can fail closed — never use the fail-open reader on a money path. */
async function strictBalanceRaw(agentPublicKey: string, mint: string): Promise<bigint> {
  const b = await getAgentTokenBalanceRawStrict(agentPublicKey, mint);
  return BigInt(b.amountRaw);
}

/**
 * Reconcile an in-flight withdraw signature recorded by the executor's onBeforeBroadcast
 * hook. A withdraw tx is AMOUNT-EXACT and pulls from the lend position (which still
 * holds collateral until the tx lands), so re-broadcasting one that may still land
 * DOUBLE-withdraws. The agent wallet balance is NOT safe proof — it reads 0 while
 * the tx is in-flight — so the signature's on-chain status is the only authority:
 *   - "landed"    : confirmed/finalized — the collateral DID move to the wallet.
 *   - "reverted"  : landed but failed atomically — provably no money moved.
 *   - "expired"   : never landed AND the blockhash window has passed — it can never
 *                   land now (Solana invalidates the tx), so a fresh withdraw is safe.
 *   - "in_flight" : not yet visible and still within the validity window — MUST wait
 *                   (re-broadcasting here is the double-withdraw bug).
 * Any read failure is treated as "in_flight" (wait) — we never assume a tx dropped.
 */
async function reconcileWithdrawSignature(
  signature: string,
  lastValidBlockHeight?: number,
): Promise<"landed" | "reverted" | "expired" | "in_flight"> {
  const connection = getServerConnection();
  try {
    const statuses = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const st = statuses.value[0];
    if (st) {
      if (st.err) return "reverted";
      if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return "landed";
      return "in_flight"; // processed-only: still settling.
    }
  } catch {
    return "in_flight"; // RPC read failed: wait, never assume dropped.
  }
  // Not found in history. Only a PASSED blockhash window proves it can never land.
  if (typeof lastValidBlockHeight === "number" && Number.isFinite(lastValidBlockHeight)) {
    try {
      const h = await connection.getBlockHeight("confirmed");
      if (h > lastValidBlockHeight) return "expired";
    } catch {
      /* fall through to in_flight */
    }
  }
  return "in_flight";
}

/**
 * Idempotent op resolution. Returns the existing op for this (wallet,
 * clientRequestId) or creates a fresh one. The partial UNIQUE index makes a
 * concurrent create race resolve to the single winner.
 */
async function resolveOrCreateOp(p: {
  walletAddress: string;
  borrowPositionId: string;
  clientRequestId: string;
  operationType: string;
  metadata: Meta;
}): Promise<BorrowOperation> {
  const existing = await storage.getBorrowOperationByClientRequestId(p.walletAddress, p.clientRequestId);
  if (existing) return existing;
  try {
    return await storage.createBorrowOperation({
      walletAddress: p.walletAddress,
      borrowPositionId: p.borrowPositionId,
      operationType: p.operationType,
      status: "processing",
      step: "initialized",
      clientRequestId: p.clientRequestId,
      metadata: p.metadata,
    });
  } catch {
    // UNIQUE violation (concurrent create) -> the winner now exists.
    const again = await storage.getBorrowOperationByClientRequestId(p.walletAddress, p.clientRequestId);
    if (again) return again;
    throw new Error("Could not start the repay operation.");
  }
}

/** A previously-succeeded op replays its stored result verbatim (idempotent). */
function replaySucceeded(op: BorrowOperation): MultiHopRepayResult {
  const r = (op.result as Meta | null) ?? {};
  return {
    success: true,
    operationId: op.id,
    repaidUsdc: r.repaidUsdc,
    observedDebtRaw: r.observedDebtRaw,
    fullyRepaid: r.fullyRepaid,
    swappedUsdcRaw: r.swappedUsdcRaw,
    signatures: (op.txSignatures as string[] | null) ?? [],
    step: op.step ?? "final_read",
  };
}

async function finalize(op: BorrowOperation, result: Meta): Promise<MultiHopRepayResult> {
  await storage.updateBorrowOperation(op.id, { status: "succeeded", step: "final_read", result });
  const fresh = await storage.getBorrowOperationById(op.id);
  return {
    success: true,
    operationId: op.id,
    repaidUsdc: result.repaidUsdc,
    observedDebtRaw: result.observedDebtRaw,
    fullyRepaid: result.fullyRepaid,
    swappedUsdcRaw: result.swappedUsdcRaw,
    signatures: ((fresh?.txSignatures ?? op.txSignatures) as string[] | null) ?? [],
    step: "final_read",
  };
}

async function failClosed(op: BorrowOperation, step: string, error: string, needsAttention: boolean): Promise<MultiHopRepayResult> {
  await storage.updateBorrowOperation(op.id, { status: needsAttention ? "needs_attention" : "failed", step, error });
  return { success: false, operationId: op.id, step, error, needsAttention };
}

/** Read live debt for a position; null = unreadable (fail closed upstream). */
async function readLiveDebtRaw(walletAddress: string, borrowPositionId: string): Promise<{ debtRaw: bigint; collateralMint: string } | null> {
  const position = await storage.getBorrowPosition(walletAddress, borrowPositionId);
  if (!position) return null;
  const route = new JupiterLendBorrowRoute();
  const nftId = position.venuePositionId ? Number(position.venuePositionId) : NaN;
  if (!Number.isFinite(nftId)) return { debtRaw: BigInt(position.debtAmountRaw || "0"), collateralMint: position.collateralMint };
  const live = await route.readLivePositionHealth(position.collateralMint, nftId);
  if (!live) return null;
  return { debtRaw: BigInt(live.debtRaw), collateralMint: position.collateralMint };
}

/**
 * Shared SWAP -> REPAY tail used by #3 (deleverage) and #4 (wallet token). The
 * input token is assumed already sitting in the agent wallet (withdrawn
 * collateral for #3, the user's transferred token for #4). Swaps the FULL input
 * balance to USDC, then repays the realized proceeds (capped at debt by the
 * repay leg). Resumable: a zero input balance means the swap already happened —
 * the recorded `swapUsdcRaw` is replayed into the repay.
 *
 * PRECONDITION (full-balance swap): the agent wallet is not expected to hold
 * pre-existing loose balance of `inputMint` beyond what this op put there
 * (withdrawn collateral / the user's transfer). Borrow collateral lives in the
 * lend protocol, not loose in the wallet, and vault parks use yield STABLECOINS
 * (a distinct asset class from LST collateral), so this holds in practice. If a
 * loose balance ever did exist it would be swept into this repay (over-converted
 * to USDC, capped at debt, remainder recoverable as wallet USDC — never lost).
 * Making the swap amount-exact would require threading an amount through the
 * shared, audited deposit-any-asset swap path (out of scope here).
 */
async function swapThenRepay(
  op: BorrowOperation,
  args: {
    walletAddress: string;
    agentPublicKey: string;
    agentSecretKey: Uint8Array;
    borrowPositionId: string;
    inputMint: string;
    slippageBps: number;
  },
): Promise<MultiHopRepayResult> {
  // ---- SWAP leg ------------------------------------------------------------
  if ((op.step ?? "") !== "swap_confirmed" && (op.step ?? "") !== "repay_confirmed") {
    let inputBal: bigint;
    try {
      inputBal = await strictBalanceRaw(args.agentPublicKey, args.inputMint);
    } catch {
      return failClosed(op, "swap_failed", "Could not read the wallet balance to swap; nothing was changed.", true);
    }

    let proceedsRaw: bigint;
    if (inputBal > 0n) {
      const swap = await executeAgentSwapToUsdc(args.agentPublicKey, args.agentSecretKey, args.inputMint, args.slippageBps);
      if (!swap.success || !swap.usdcReceivedRaw || BigInt(swap.usdcReceivedRaw) <= 0n) {
        // The input token is still in the agent wallet -> recoverable. Stop.
        return failClosed(op, "swap_failed", swap.error || "The swap to USDC did not complete. Your funds are safe in the trading wallet.", true);
      }
      proceedsRaw = BigInt(swap.usdcReceivedRaw);
      await storage.updateBorrowOperation(op.id, {
        step: "swap_confirmed",
        mergeMetadata: { swapSig: swap.signature, swapUsdcRaw: proceedsRaw.toString() },
        ...(swap.signature ? { appendTxSignature: swap.signature } : {}),
      });
    } else {
      // Nothing to swap -> a prior run already converted it. Replay the proceeds.
      const recorded = readMeta(op).swapUsdcRaw;
      if (!recorded || BigInt(recorded) <= 0n) {
        return failClosed(op, "swap_failed", "No swap proceeds were found to repay with.", true);
      }
      proceedsRaw = BigInt(recorded);
      await storage.updateBorrowOperation(op.id, { step: "swap_confirmed" });
    }
    op = (await storage.getBorrowOperationById(op.id)) ?? op;
    return repayProceeds(op, { ...args, proceedsRaw });
  }

  // Resuming AT/AFTER swap_confirmed: replay the recorded proceeds.
  const recorded = readMeta(op).swapUsdcRaw;
  if (!recorded || BigInt(recorded) <= 0n) {
    return failClosed(op, "swap_failed", "No swap proceeds were found to repay with.", true);
  }
  return repayProceeds(op, { ...args, proceedsRaw: BigInt(recorded) });
}

/** REPAY leg: repay an exact USDC amount (capped at live debt by the executor). */
async function repayProceeds(
  op: BorrowOperation,
  args: {
    walletAddress: string;
    agentPublicKey: string;
    agentSecretKey: Uint8Array;
    borrowPositionId: string;
    proceedsRaw: bigint;
  },
): Promise<MultiHopRepayResult> {
  // Idempotent short-circuit: if the debt is already cleared, the repay landed
  // on a prior run. Treat as success rather than re-spending.
  const live = await readLiveDebtRaw(args.walletAddress, args.borrowPositionId);
  if (live && live.debtRaw <= 0n) {
    return finalize(op, {
      repaidUsdc: readMeta(op).repaidUsdc,
      observedDebtRaw: "0",
      fullyRepaid: true,
      swappedUsdcRaw: readMeta(op).swapUsdcRaw,
    });
  }

  const repay = await executeRepayFromAgentUsdc({
    walletAddress: args.walletAddress,
    agentPublicKey: args.agentPublicKey,
    agentSecretKey: args.agentSecretKey,
    borrowPositionId: args.borrowPositionId,
    amount: args.proceedsRaw,
  });

  if (!repay.success) {
    // The proceeds are USDC sitting in the agent wallet -> recoverable.
    return failClosed(op, "repay_failed", repay.error || "The repay did not complete. The funds are safe in your trading wallet.", true);
  }

  await storage.updateBorrowOperation(op.id, {
    step: "repay_confirmed",
    mergeMetadata: { repaySig: repay.signature, observedDebtRaw: repay.observedDebtRaw, repaidUsdc: repay.repaidUsdc },
    ...(repay.signature ? { appendTxSignature: repay.signature } : {}),
  });
  op = (await storage.getBorrowOperationById(op.id)) ?? op;

  return finalize(op, {
    repaidUsdc: repay.repaidUsdc,
    observedDebtRaw: repay.observedDebtRaw,
    fullyRepaid: !!repay.fullyRepaid,
    swappedUsdcRaw: readMeta(op).swapUsdcRaw,
  });
}

// ===========================================================================
// #2  Pay from Your Wallet USDC
// ===========================================================================

export interface RepayFromWalletUsdcParams {
  walletAddress: string;
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  borrowPositionId: string;
  clientRequestId: string;
  /** The user-signed, already-CONFIRMED USDC transfer (wallet -> agent) signature. */
  transferSignature: string;
  /** Optional cap; the realized credited USDC and live debt always bound it. */
  requestedRepayRaw?: bigint;
}

/**
 * #2: the client first sends a user-signed USDC transfer into the agent wallet
 * and waits for confirmation, then calls this with the transfer signature. We
 * read the REALIZED USDC credited to the agent IN THAT TX (the source of truth),
 * then repay min(credited, requested, live debt). Tying the repay to a confirmed
 * inbound transfer is what keeps it from ever spending pre-existing trading
 * capital when the transfer never landed.
 */
export async function executeRepayFromWalletUsdc(params: RepayFromWalletUsdcParams): Promise<MultiHopRepayResult> {
  return withBorrowLock(`multihop:${params.walletAddress}:${params.clientRequestId}`, async () => {
    let op = await resolveOrCreateOp({
      walletAddress: params.walletAddress,
      borrowPositionId: params.borrowPositionId,
      clientRequestId: params.clientRequestId,
      operationType: "repay_wallet_usdc",
      metadata: { source: "wallet_usdc", positionId: params.borrowPositionId },
    });
    if (op.status === "succeeded") return replaySucceeded(op);

    // ---- TRANSFER confirmation -------------------------------------------
    // The transfer credit is only recorded (transferUsdcRaw) once it confirms.
    // Until then the op rests at "initialized" OR "transfer_unconfirmed"; BOTH
    // must re-read the on-chain credit so a transfer that confirms slightly
    // after the first POST (RPC lag, or a client resume that POSTs before its
    // own confirm wait) recovers instead of wedging forever.
    let creditedRaw: bigint;
    const stepNow = op.step ?? "";
    if (stepNow === "initialized" || stepNow === "transfer_unconfirmed") {
      const credited = await readInboundUsdcCredit(params.transferSignature, params.agentPublicKey);
      if (credited === null) {
        // Not visible on-chain yet -> soft retry (202): funds are safe, the SAME
        // clientRequestId resumes once the transfer confirms.
        return failClosed(op, "transfer_unconfirmed", "Your USDC transfer has not confirmed yet. Wait a moment and tap Retry.", true);
      }
      if (credited <= 0n) {
        return failClosed(op, "transfer_unconfirmed", "No USDC from that transfer reached the trading wallet.", false);
      }
      creditedRaw = credited;
      await storage.updateBorrowOperation(op.id, {
        step: "transfer_confirmed",
        mergeMetadata: { transferUsdcRaw: creditedRaw.toString() },
        appendTxSignature: params.transferSignature,
      });
      op = (await storage.getBorrowOperationById(op.id)) ?? op;
    } else {
      creditedRaw = BigInt(readMeta(op).transferUsdcRaw || "0");
      if (creditedRaw <= 0n) {
        return failClosed(op, "transfer_unconfirmed", "No USDC from that transfer reached the trading wallet.", false);
      }
    }

    // ---- REPAY -----------------------------------------------------------
    let cap = creditedRaw;
    if (params.requestedRepayRaw && params.requestedRepayRaw > 0n && params.requestedRepayRaw < cap) {
      cap = params.requestedRepayRaw;
    }
    return repayProceeds(op, {
      walletAddress: params.walletAddress,
      agentPublicKey: params.agentPublicKey,
      agentSecretKey: params.agentSecretKey,
      borrowPositionId: params.borrowPositionId,
      proceedsRaw: cap,
    });
  });
}

// ===========================================================================
// #3  Pay with deposited collateral (DELEVERAGE)
// ===========================================================================

export interface DeleverageRepayParams {
  walletAddress: string;
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  borrowPositionId: string;
  clientRequestId: string;
  /** Collateral to withdraw and sell, raw base units. */
  collateralRaw: bigint;
  slippageBps?: number;
}

/**
 * #3: fully server-side deleverage. Withdraw `collateralRaw` of collateral
 * (gated by evaluateCollateralWithdraw inside the executor), swap it to USDC,
 * repay the proceeds (capped at debt). Any USDC beyond the debt remains as
 * recoverable trading-wallet USDC.
 *
 * Resume authority for the withdraw leg is the durable, write-ahead withdraw
 * SIGNATURE (recorded before broadcast), reconciled by on-chain status — NOT the
 * agent's collateral balance, which reads 0 while a withdraw is in-flight and
 * would risk a double-withdraw. A crash between withdraw and swap is reconciled by
 * signature, never re-withdrawn off a stale balance.
 */
export async function executeDeleverageRepay(params: DeleverageRepayParams): Promise<MultiHopRepayResult> {
  if (params.collateralRaw <= 0n) {
    return { success: false, error: "Collateral amount must be greater than zero." };
  }
  return withBorrowLock(`multihop:${params.walletAddress}:${params.clientRequestId}`, async () => {
    const position = await storage.getBorrowPosition(params.walletAddress, params.borrowPositionId);
    if (!position) return { success: false, error: "Borrow position not found." };
    const collateralMint = position.collateralMint;
    const slippageBps = clampSlippage(params.slippageBps);

    let op = await resolveOrCreateOp({
      walletAddress: params.walletAddress,
      borrowPositionId: params.borrowPositionId,
      clientRequestId: params.clientRequestId,
      operationType: "repay_deleverage",
      metadata: { source: "deleverage", positionId: params.borrowPositionId, collateralMint, collateralRaw: params.collateralRaw.toString(), slippageBps },
    });
    if (op.status === "succeeded") return replaySucceeded(op);

    // ---- WITHDRAW leg ----------------------------------------------------
    // A withdraw tx is AMOUNT-EXACT and pulls from the lend position (which keeps
    // its collateral until the tx lands), so re-broadcasting one that MIGHT still
    // land double-withdraws. The agent wallet balance is NOT safe proof — it reads
    // 0 while a withdraw is in-flight. The only authority is the durable,
    // broadcast-time withdraw signature, recorded by the onBeforeBroadcast hook BELOW
    // (BEFORE confirmation), reconciled by on-chain status. Step meanings:
    //   - "initialized"     -> no withdraw ever attempted; withdraw.
    //   - "withdraw_failed" -> the prior withdraw is PROVEN to have moved no money
    //     (no tx broadcast, OR the broadcast tx reverted/expired) -> RESTARTABLE.
    //   - "withdrawing"     -> a withdraw MAY be in-flight. Reconcile by signature:
    //       landed -> recover; reverted/expired -> re-withdraw; in_flight -> wait.
    //       NO recorded sig at "withdrawing" => onBeforeBroadcast never fired => the tx
    //       was provably never broadcast => safe to withdraw.
    const step = op.step ?? "";
    if (step === "initialized" || step === "withdraw_failed" || step === "withdrawing") {
      let recovered = false;
      if (step === "withdrawing") {
        const meta = readMeta(op);
        if (meta.withdrawSig) {
          const status = await reconcileWithdrawSignature(meta.withdrawSig, meta.withdrawLastValidBlockHeight);
          if (status === "landed") {
            recovered = true;
          } else if (status === "in_flight") {
            return failClosed(op, "withdrawing", "Your collateral withdrawal is still settling. Your funds are safe — tap Retry in a moment.", true);
          }
          // "reverted" | "expired": the recorded tx can NEVER move money now -> fall
          // through with recovered=false to re-withdraw. The fresh onBeforeBroadcast
          // overwrites the dead sig; a crash before that re-reconciles the same dead
          // sig (still reverted/expired) -> re-withdraw: safe and idempotent.
        }
        // No recorded sig at "withdrawing" => never broadcast => recovered stays
        // false => withdraw below (safe: nothing left the position).
      }
      if (!recovered) {
        await storage.updateBorrowOperation(op.id, { step: "withdrawing" });
        const w = await executeWithdrawCollateral({
          walletAddress: params.walletAddress,
          agentPublicKey: params.agentPublicKey,
          agentSecretKey: params.agentSecretKey,
          borrowPositionId: params.borrowPositionId,
          amount: params.collateralRaw,
          // WRITE-AHEAD: durably record the withdraw signature BEFORE the tx is
          // broadcast (this hook is fatal — if the persist throws, the withdraw is
          // aborted before send). This makes "no sig recorded" provably mean "never
          // broadcast", so resume reconciles by signature status and never
          // re-broadcasts blindly off a stale wallet balance (double-withdraw).
          onBeforeBroadcast: async ({ signature, lastValidBlockHeight }) => {
            await storage.updateBorrowOperation(op.id, {
              mergeMetadata: { withdrawSig: signature, withdrawLastValidBlockHeight: lastValidBlockHeight },
              appendTxSignature: signature,
            });
          },
        });
        if (w.success) {
          await storage.updateBorrowOperation(op.id, {
            step: "withdraw_confirmed",
            mergeMetadata: { withdrawnCollateralReturned: w.collateralReturned },
          });
        } else {
          // The withdraw returned failure. Distinguish PROVEN no-money (restartable
          // "withdraw_failed") from an AMBIGUOUS broadcast: the executor's realized-
          // delta check can false-negative on an in-flight tx, so if a sig WAS
          // broadcast we MUST reconcile by status before deciding it is restartable.
          op = (await storage.getBorrowOperationById(op.id)) ?? op; // refresh: onBeforeBroadcast may have recorded a sig
          const meta = readMeta(op);
          const sig = meta.withdrawSig as string | undefined;
          if (!sig) {
            // No tx was ever broadcast -> provably nothing moved -> restartable.
            return failClosed(op, "withdraw_failed", w.error || "The collateral withdrawal did not complete.", false);
          }
          const status = await reconcileWithdrawSignature(sig, meta.withdrawLastValidBlockHeight);
          if (status === "landed") {
            // False negative: the tx actually landed -> proceed to the swap leg.
            await storage.updateBorrowOperation(op.id, { step: "withdraw_confirmed", mergeMetadata: { withdrawRecovered: true } });
          } else if (status === "in_flight") {
            return failClosed(op, "withdrawing", "Your collateral withdrawal is still settling. Your funds are safe — tap Retry in a moment.", true);
          } else {
            // "reverted" | "expired" -> provably no money moved -> restartable.
            return failClosed(op, "withdraw_failed", w.error || "The collateral withdrawal did not complete.", false);
          }
        }
      } else {
        // Withdraw signature confirmed landed on resume; collateral is in the wallet.
        await storage.updateBorrowOperation(op.id, { step: "withdraw_confirmed", mergeMetadata: { withdrawRecovered: true } });
      }
      op = (await storage.getBorrowOperationById(op.id)) ?? op;
    }

    // ---- SWAP -> REPAY tail ----------------------------------------------
    return swapThenRepay(op, {
      walletAddress: params.walletAddress,
      agentPublicKey: params.agentPublicKey,
      agentSecretKey: params.agentSecretKey,
      borrowPositionId: params.borrowPositionId,
      inputMint: collateralMint,
      slippageBps,
    });
  });
}

// ===========================================================================
// #4  Pay with any wallet token
// ===========================================================================

export interface RepayFromWalletTokenParams {
  walletAddress: string;
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  borrowPositionId: string;
  clientRequestId: string;
  /** The token the user transferred into the agent wallet (not USDC). */
  tokenMint: string;
  slippageBps?: number;
}

/**
 * #4: the client first sends a user-signed transfer of `tokenMint` into the
 * agent wallet and waits for confirmation, then calls this. We swap the FULL
 * agent balance of that token to USDC and repay the proceeds (capped at debt).
 * Resume authority is the agent's token balance.
 */
export async function executeRepayFromWalletToken(params: RepayFromWalletTokenParams): Promise<MultiHopRepayResult> {
  if (params.tokenMint === USDC_MINT) {
    return { success: false, error: "Use the wallet-USDC repay for USDC (no swap needed)." };
  }
  // Never liquidate PARKED savings: this leg swaps the FULL agent balance of the
  // token, so reject any registered yield/vault asset (enabled OR disabled) the
  // user may have parked. Arbitrary wallet tokens are fine.
  if (getDetectableYieldAssets().some((a) => a.mint === params.tokenMint)) {
    return { success: false, error: "That token is a parked savings asset and can't be used to repay. Unpark it first." };
  }
  return withBorrowLock(`multihop:${params.walletAddress}:${params.clientRequestId}`, async () => {
    const slippageBps = clampSlippage(params.slippageBps);
    let op = await resolveOrCreateOp({
      walletAddress: params.walletAddress,
      borrowPositionId: params.borrowPositionId,
      clientRequestId: params.clientRequestId,
      operationType: "repay_wallet_token",
      metadata: { source: "wallet_token", positionId: params.borrowPositionId, tokenMint: params.tokenMint, slippageBps },
    });
    if (op.status === "succeeded") return replaySucceeded(op);

    return swapThenRepay(op, {
      walletAddress: params.walletAddress,
      agentPublicKey: params.agentPublicKey,
      agentSecretKey: params.agentSecretKey,
      borrowPositionId: params.borrowPositionId,
      inputMint: params.tokenMint,
      slippageBps,
    });
  });
}

// ===========================================================================
// #5  Repay from parked Vault savings (Earn) — multi-hop
// ===========================================================================

export interface RepayFromVaultSavingsParams {
  walletAddress: string;
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  borrowPositionId: string;
  clientRequestId: string;
  slippageBps?: number;
}

// A small cushion so the unpark proceeds reliably CLEAR the debt despite swap
// slippage / price drift. Over-shooting is money-safe: the repay leg caps every
// repay at the true on-chain debt, and any excess USDC stays recoverable in the
// trading wallet. Integer math keeps the sizing float-safe.
const VAULT_SAVINGS_REPAY_BUFFER_NUM = 102n; // +2%
const VAULT_SAVINGS_REPAY_BUFFER_DEN = 100n;

/**
 * #5: repay using funds the user PARKED in the Vault (Earn). This is the exact
 * bind a carry trader hits when their borrowed USDC is locked in a yield token
 * (e.g. ONyc) and source #1 (loose trading USDC) is empty. Fully server-side,
 * ACCOUNT scope:
 *   pick the user's largest-VALUE enabled yield holding -> unpark JUST ENOUGH of
 *   it to cover the live debt (+buffer) into USDC -> repay (capped at debt).
 *
 * Money-safety / resume model. unparkToUsdc has no write-ahead-signature hook, so
 * (unlike the deleverage withdraw) we cannot reconcile an in-flight swap by
 * signature. We lean on RECORDED PROCEEDS plus a conservative ambiguous case:
 *   - Once an unpark CONFIRMS we record its realized USDC (`unparkUsdcRaw`). Any
 *     resume that sees recorded proceeds drives ONLY the idempotent repay leg —
 *     it never unparks again (no double-liquidation of savings).
 *   - A CLEAN unpark failure (no USDC received) lands at "unpark_failed": the
 *     yield token never left the wallet, so a retry safely re-unparks.
 *   - The "unparking" marker (intent persisted, NO confirmed proceeds) means a
 *     crash hit between the on-chain swap and our DB write — unprovable either
 *     way. We FAIL CLOSED (funds are safe: still parked, or already USDC in the
 *     trading wallet) and never auto re-unpark.
 */
export async function executeRepayFromVaultSavings(params: RepayFromVaultSavingsParams): Promise<MultiHopRepayResult> {
  return withBorrowLock(`multihop:${params.walletAddress}:${params.clientRequestId}`, async () => {
    const slippageBps = clampSlippage(params.slippageBps);
    let op = await resolveOrCreateOp({
      walletAddress: params.walletAddress,
      borrowPositionId: params.borrowPositionId,
      clientRequestId: params.clientRequestId,
      operationType: "repay_vault_savings",
      metadata: { source: "vault_savings", positionId: params.borrowPositionId, slippageBps },
    });
    if (op.status === "succeeded") return replaySucceeded(op);

    // RESUME (confirmed proceeds): a prior run already converted savings to USDC.
    // Never unpark again — just (re)drive the idempotent, debt-capped repay leg.
    const recorded = readMeta(op).unparkUsdcRaw;
    if (recorded && BigInt(recorded) > 0n) {
      return repayProceeds(op, {
        walletAddress: params.walletAddress,
        agentPublicKey: params.agentPublicKey,
        agentSecretKey: params.agentSecretKey,
        borrowPositionId: params.borrowPositionId,
        proceedsRaw: BigInt(recorded),
      });
    }

    // RESUME (ambiguous in-flight unpark): intent persisted, no confirmed
    // proceeds. A crash landed between the on-chain swap and our DB write; we
    // cannot prove which side. Fail closed — funds are safe and we never auto
    // re-unpark (which would double-liquidate the savings).
    if ((op.step ?? "") === "unparking") {
      return failClosed(
        op,
        "unparking",
        "Your savings withdrawal is being verified. Your funds are safe — check your trading wallet for USDC and repay from there, or start a new repayment.",
        true,
      );
    }

    // Live debt is the authority for sizing.
    const live = await readLiveDebtRaw(params.walletAddress, params.borrowPositionId);
    if (!live) return failClosed(op, "initialized", "Could not read your live loan balance; nothing was changed.", false);
    if (live.debtRaw <= 0n) {
      return finalize(op, { repaidUsdc: 0, observedDebtRaw: "0", fullyRepaid: true });
    }

    // Pick the largest-VALUE enabled yield asset the agent actually holds.
    // On-chain STRICT reads are the truth (this also catches a yield token bought
    // via a manual swap that has no vault_positions DB row). Any unreadable
    // balance or missing price fails closed — no guessing on a money path.
    type Candidate = { assetKey: string; displayName: string; balanceRaw: bigint; valueUsdcRaw: bigint };
    let best: Candidate | null = null;
    for (const asset of getEnabledYieldAssets()) {
      let balanceRaw: bigint;
      try {
        balanceRaw = await strictBalanceRaw(params.agentPublicKey, asset.mint);
      } catch {
        return failClosed(op, "initialized", `Could not read your ${asset.displayName} savings balance; nothing was changed.`, true);
      }
      if (balanceRaw <= 0n) continue;
      const val = await getYieldRoute(asset).valueInUsdc(balanceRaw);
      if (!val.valueUsdcRaw) {
        return failClosed(op, "initialized", `Could not price your ${asset.displayName} savings right now; nothing was changed. Try again shortly.`, true);
      }
      const valueUsdcRaw = BigInt(val.valueUsdcRaw);
      if (valueUsdcRaw <= 0n) continue;
      if (!best || valueUsdcRaw > best.valueUsdcRaw) {
        best = { assetKey: asset.key, displayName: asset.displayName, balanceRaw, valueUsdcRaw };
      }
    }
    if (!best) {
      return failClosed(op, "initialized", "You have no Vault savings to repay from. Park some funds first, or use another source.", false);
    }

    // Size: unpark JUST ENOUGH to cover the debt (+buffer), capped at the holding.
    // All integer math (float-safe). If the asset can't cover the full debt, sell
    // all of it for a partial paydown.
    const neededUsdcRaw = (live.debtRaw * VAULT_SAVINGS_REPAY_BUFFER_NUM) / VAULT_SAVINGS_REPAY_BUFFER_DEN;
    let sellRaw: bigint;
    if (best.valueUsdcRaw <= neededUsdcRaw) {
      sellRaw = best.balanceRaw;
    } else {
      // CEIL division: never let integer truncation shave a raw unit off the
      // +buffer target (that would slightly underpay). Still clamped to holding.
      sellRaw = (best.balanceRaw * neededUsdcRaw + best.valueUsdcRaw - 1n) / best.valueUsdcRaw;
      if (sellRaw <= 0n) sellRaw = best.balanceRaw; // never round down to nothing
      if (sellRaw > best.balanceRaw) sellRaw = best.balanceRaw;
    }

    // UNPARK leg. Persist the INTENT before acting so a crash lands at "unparking"
    // (handled conservatively above) and never silently re-unparks.
    await storage.updateBorrowOperation(op.id, {
      step: "unparking",
      mergeMetadata: { unparkAssetKey: best.assetKey, unparkSellRaw: sellRaw.toString() },
    });

    const unpark = await unparkToUsdc({
      walletAddress: params.walletAddress,
      tradingBotId: null, // ACCOUNT scope: the borrow engine + parked savings are account-level
      agentPublicKey: params.agentPublicKey,
      agentSecretKey: params.agentSecretKey,
      assetKey: best.assetKey,
      amountTokenRaw: sellRaw,
      slippageBps,
    });
    if (!unpark.success || !unpark.usdcReceivedRaw || BigInt(unpark.usdcReceivedRaw) <= 0n) {
      // The yield token never left the wallet -> recoverable. Restartable failure.
      return failClosed(op, "unpark_failed", unpark.error || "Could not convert your Vault savings to USDC. Your funds are safe.", true);
    }
    const proceedsRaw = BigInt(unpark.usdcReceivedRaw);
    await storage.updateBorrowOperation(op.id, {
      step: "unpark_confirmed",
      // `swapUsdcRaw` is what finalize() surfaces as swappedUsdcRaw to the client.
      mergeMetadata: {
        unparkSig: unpark.signature,
        unparkUsdcRaw: proceedsRaw.toString(),
        swapUsdcRaw: proceedsRaw.toString(),
        unparkAssetKey: best.assetKey,
      },
      ...(unpark.signature ? { appendTxSignature: unpark.signature } : {}),
    });
    op = (await storage.getBorrowOperationById(op.id)) ?? op;

    return repayProceeds(op, {
      walletAddress: params.walletAddress,
      agentPublicKey: params.agentPublicKey,
      agentSecretKey: params.agentSecretKey,
      borrowPositionId: params.borrowPositionId,
      proceedsRaw,
    });
  });
}

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Read the REALIZED USDC credited to the agent wallet in a specific (already
 * user-signed) transfer transaction. Returns the positive base-unit delta, 0 if
 * the tx moved no USDC to the agent, or null if the tx is not yet confirmed /
 * failed (caller must NOT proceed in that case). This is the source of truth for
 * #2 — we never trust a returned signature or a balance snapshot.
 */
async function readInboundUsdcCredit(signature: string, agentPublicKey: string): Promise<bigint | null> {
  const connection = getServerConnection();
  let tx;
  try {
    tx = await connection.getParsedTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  } catch {
    return null;
  }
  if (!tx || tx.meta?.err) return null;
  // Validate the signer is a real pubkey shape (defensive; not strictly needed).
  try { new PublicKey(agentPublicKey); } catch { return null; }

  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  const match = (b: { owner?: string; mint?: string }) => b.owner === agentPublicKey && b.mint === USDC_MINT;
  const preAmt = (() => { const b = pre.find(match); return b ? BigInt(b.uiTokenAmount.amount) : 0n; })();
  const postAmt = (() => { const b = post.find(match); return b ? BigInt(b.uiTokenAmount.amount) : 0n; })();
  const delta = postAmt - preAmt;
  return delta > 0n ? delta : 0n;
}
