/**
 * PER-BOT BORROW — CARVE/OPEN + UNWIND/CLOSE orchestrators (Flash bots only).
 *
 * The account-level borrow engine is already SHIPPED. This is the per-bot
 * microcosm (owner-only Phase-0 proving). A per-bot loan is funded NOT from free
 * INF resting in an agent wallet (the agent is pass-through only; free assets
 * that rest there have no recovery path) but by CARVING collateral OUT of the
 * ACCOUNT borrow position (un-pledge), capped so the ACCOUNT lands at a target
 * LTV, passing it THROUGH the agent into the bot's own borrow position. On
 * bot-close the collateral is UNWOUND: returned to the account wallet and
 * re-pledged into the ACCOUNT position (so platform debt stays collateralised).
 *
 *   CARVE/OPEN  (perbot_carve_open):
 *     [withdraw account-capped @ targetLTV, deliver=false]
 *       -> [SPL transfer account -> bot]
 *       -> [bot supply + open]
 *   UNWIND/CLOSE (perbot_unwind_close):
 *     [bot close (repay-all + withdraw-all)]
 *       -> [SPL transfer bot -> account]
 *       -> [re-supply ACCOUNT position]
 *
 * This file is a thin ORCHESTRATOR. It never builds its own money instructions;
 * it COMPOSES already-audited, independently fail-closed primitives
 * (executeWithdrawCollateral / transferTokenToWalletExact / executeBorrowOpen /
 * executeBorrowClose / executeSupplyCollateral), each of which serialises on its
 * own `withBorrowLock`, re-runs its risk gate, and proves its result from a
 * realised on-chain delta.
 *
 * Money-safety contract for the COMPOSITION (the single-tx legs enforce their own):
 *  - A 5-minute scope lock CANNOT span a multi-leg op, so cross-leg safety comes
 *    from a DB-backed, idempotent, RESUMABLE state machine (borrow_operations with
 *    a per-wallet UNIQUE clientRequestId + a jsonb metadata breadcrumb).
 *  - Every leg persists its step BEFORE it acts and records its realised on-chain
 *    amount + tx signature AFTER. A retry with the same clientRequestId resumes
 *    from the last proven step; it never re-runs a confirmed leg.
 *  - The withdraw + both transfer legs are AMOUNT-EXACT and pull from a position /
 *    wallet that still holds the funds until the tx lands, so re-broadcasting one
 *    that MIGHT still land double-moves. The agent balance is NOT safe proof (it
 *    reads 0 while a tx is in-flight); the durable write-ahead signature
 *    reconciled by on-chain status is the only authority.
 *  - NO active compensating revert. On a leg failure the op stops at
 *    `needs_attention` with the funds left in a RECOVERABLE wallet/position; a
 *    retry FINISHES forward. (Closing a bot loan re-pledges via the separate
 *    UNWIND op — that is the "reverse", not an auto-rollback.)
 *  - Concurrent runs of the SAME op serialise on a `perbot-carve:<wallet>:<reqId>`
 *    / `perbot-unwind:<wallet>:<reqId>` lock (distinct from the executor
 *    borrowLockKey and from any proof-level lock — no re-entrant deadlock).
 */

import { storage } from "../storage";
import type { BorrowOperation } from "@shared/schema";
import {
  executeAgentSwap,
  getAgentTokenBalanceRawStrict,
  getServerConnection,
  transferTokenToWalletExact,
  USDC_MINT,
} from "../agent-wallet";
import {
  executeWithdrawCollateral,
  executeSupplyCollateral,
  executeBorrowOpen,
  executeBorrowClose,
  supplyToExistingBotPosition,
  borrowMoreOnExistingBotPosition,
  withBorrowLock,
} from "./jupiter-lend-borrow-executor";
import { JupiterLendBorrowRoute, type BorrowVaultConfig } from "./jupiter-lend-borrow-route";
import { readBorrowOracleContext } from "./borrow-oracle-freshness";
import { evaluateCollateralWithdraw, evaluateMaxCarveForTargetLtv } from "./borrow-risk-policy";
import { decideSwapResume } from "./borrow-engine-core";

const SWAP_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Account-position LTV tolerance for the post-withdraw on-chain assertion. A
 *  carve is sized to land the account at <= targetLtv; a tiny epsilon absorbs
 *  rounding / sub-second oracle jitter between the pre-sign gate and the re-read. */
const LTV_ASSERT_EPSILON = 0.01;

/** Collateral the carve may "lose" to protocol rounding on the round trip, raw. */
const COLL_DUST = 10n; // ~1e-8 INF @ 9 decimals

/** Debt a position may still show and still count as fully repaid, raw. Used by
 *  the unwind close-resume to detect a position that is already empty on-chain. */
const DEBT_DUST = 10_000n; // 0.01 USDC @ 6 decimals

/** Per-bot repay TOP-UP sizing (see the UNWIND/CLOSE top-up leg). The bot close
 *  repays via the MAX_REPAY sentinel — the only primitive that fully clears the
 *  true debt (getCurrentPosition UNDER-reads it, so an exact repay sized from it
 *  leaves dust and the withdraw-all is health-rejected). MAX_REPAY pulls slightly
 *  MORE USDC than the live debt, so a bot funded with ~exactly its borrow has no
 *  headroom and the SPL transfer 0x1s. The ACCOUNT close never hits this (its
 *  wallet carries ample spare USDC). So before the close we lend the bot a small,
 *  capped USDC headroom from the account (the funder), keep MAX_REPAY, then sweep
 *  the headroom back. Sized from the borrowed PRINCIPAL (a reliable debt upper
 *  bound), NEVER from the under-reading getCurrentPosition. */
const TOPUP_HEADROOM_BPS = 300n; // 3% of the borrowed principal...
const TOPUP_MIN_HEADROOM_RAW = 50_000n; // ...but at least 0.05 USDC (6 decimals).

function bmax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

type Meta = Record<string, any>;

function readMeta(op: BorrowOperation): Meta {
  return (op.metadata as Meta | null) ?? {};
}

/**
 * Guard a resume: a re-POST of the SAME clientRequestId with DIFFERENT
 * bot/collateral/amounts must NOT resume the stale breadcrumb under new inputs.
 * Compares the existing op's operationType + an immutable metadata subset against
 * the incoming params. Returns an error string on mismatch (the caller refuses
 * WITHOUT mutating the op); for a freshly-created op these match by construction.
 */
function validateOpIdentity(
  op: BorrowOperation,
  expectedType: string,
  expected: Record<string, string | number>,
): string | null {
  if (op.operationType !== expectedType) {
    return `Operation already exists as ${op.operationType}, not ${expectedType}; refusing to resume under a different type.`;
  }
  const meta = readMeta(op);
  for (const [k, v] of Object.entries(expected)) {
    if (String(meta[k]) !== String(v)) {
      return `Operation was started with different parameters (${k} changed); refusing to resume the same request id under changed inputs.`;
    }
  }
  return null;
}

/** Strict agent-token balance as bigint. THROWS on an unreadable balance so the
 *  caller fails closed — never the fail-open reader on a money path. */
async function strictBalanceRaw(agentPublicKey: string, mint: string): Promise<bigint> {
  const b = await getAgentTokenBalanceRawStrict(agentPublicKey, mint);
  return BigInt(b.amountRaw);
}

/**
 * Reconcile an in-flight, write-ahead signature (recorded by an onBeforeBroadcast
 * hook) by its on-chain status. Identical semantics to the deleverage withdraw
 * reconcile: "landed" (confirmed/finalized), "reverted" (landed but failed
 * atomically => no money moved), "expired" (never landed AND the blockhash window
 * passed => can never land => safe to retry), "in_flight" (not yet visible and
 * still valid => MUST wait). Any read failure => "in_flight" (never assume dropped).
 */
async function reconcileSignature(
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

/** Idempotent op resolution. Returns the existing op for this (wallet,
 *  clientRequestId) or creates a fresh one; a concurrent create resolves to the
 *  single UNIQUE-index winner. */
async function resolveOrCreateOp(p: {
  walletAddress: string;
  borrowPositionId: string | null;
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
    const again = await storage.getBorrowOperationByClientRequestId(p.walletAddress, p.clientRequestId);
    if (again) return again;
    throw new Error("Could not start the per-bot borrow operation.");
  }
}

async function failClosed(
  op: BorrowOperation,
  step: string,
  error: string,
  needsAttention: boolean,
): Promise<PerbotCarveResult> {
  await storage.updateBorrowOperation(op.id, { status: needsAttention ? "needs_attention" : "failed", step, error });
  return { success: false, operationId: op.id, step, error, needsAttention };
}

/**
 * Resume-aware clean-bot guard rule (PURE — no I/O). Given the bot's borrow
 * positions, returns the non-terminal rows that must BLOCK the per-bot proof.
 *
 * The proof opens with `existingDebtRawOverride: 0`, which is only correct on a
 * bot with NO pre-existing borrow — so a FRESH run (no carve op yet for this
 * proofRunId) must refuse ANY non-terminal position, or it would undercount the
 * existing debt and stack a SECOND position.
 *
 * But the route contract is "re-POST the SAME proofRunId to FINISH a partial
 * run", and after a successful open the bot legitimately holds THIS run's OWN
 * position. So a RESUME (the carve op for this proofRunId already exists):
 *   - when `ownedBotPositionId` is SET (the carve op has write-ahead-linked its
 *     bot position id BEFORE the open broadcast), tolerates ONLY that exact row
 *     and blocks any FOREIGN non-terminal row (a concurrent run / a prior
 *     hard-stop on a different position); and
 *   - when `ownedBotPositionId` is NULL (no open of ours has begun, so we own NO
 *     position yet), blocks ANY non-terminal row (fail-safe). The write-ahead
 *     link guarantees "a row of ours exists ⇒ ownedBotPositionId is set", so a
 *     null owner on a resume means every live row is FOREIGN. (This also blocks
 *     the ultra-narrow crash window between the bot row insert and its write-ahead
 *     link, both BEFORE any broadcast — no money has moved, so a 409 asking the
 *     owner to reconcile the stale pending row is the safe outcome.)
 *
 * Terminal rows (closed/failed) never block. Generic so the caller keeps the full
 * row type for logging.
 */
export function selectBlockingBotPositions<T extends { id: string; status: string | null }>(params: {
  rows: T[];
  isResume: boolean;
  ownedBotPositionId: string | null;
}): T[] {
  const { rows, isResume, ownedBotPositionId } = params;
  return rows
    .filter((p) => p.status !== "closed" && p.status !== "failed")
    .filter((p) => !isResume || ownedBotPositionId === null || p.id !== ownedBotPositionId);
}

export interface PerbotCarveResult {
  success: boolean;
  operationId?: string;
  step?: string;
  needsAttention?: boolean;
  /** carve/open: the bot's new borrow position id. */
  borrowPositionId?: string;
  /** carve/open: realised collateral withdrawn from the account + carved to the bot, raw. */
  carvedRaw?: string;
  /** carve/open: account LTV after the carve (post-withdraw on-chain re-read). */
  accountPostLtv?: number | null;
  /** carve/open: realised borrowed-USDC delta in the bot wallet, raw. */
  borrowedUsdcRaw?: string;
  /** unwind/close: realised collateral returned to + re-pledged into the account, raw. */
  restoredRaw?: string;
  /** unwind/close: USDC repay top-up swept back from the bot to the account, raw. */
  sweptRaw?: string;
  /** Every on-chain signature this op produced, oldest first. */
  signatures?: string[];
  error?: string;
}

/** Pure LTV from raw amounts + an oracle price (Number math is fine at tiny P0
 *  size). Returns null when the price is unreadable (caller fails closed). */
function computeLtv(
  collateralRaw: bigint,
  debtRaw: bigint,
  collateralDecimals: number,
  debtDecimals: number,
  priceUsd: number | null | undefined,
): number | null {
  if (typeof priceUsd !== "number" || !Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  const collUsd = (Number(collateralRaw) / 10 ** collateralDecimals) * priceUsd;
  const debtUsd = Number(debtRaw) / 10 ** debtDecimals;
  if (collUsd <= 0) return debtUsd > 0 ? Infinity : 0;
  return debtUsd / collUsd;
}

// ===========================================================================
// PLANNER (DRY / preflight) — on-chain reads only, NO money movement.
// ===========================================================================

export interface PerbotCarvePlan {
  ok: boolean;
  error?: string;
  /** Account borrow position (carve source) DB id + on-chain nft id. */
  accountBorrowPositionId?: string;
  accountVenuePositionId?: number;
  /** Live account position facts, raw. */
  liveCollateralRaw?: string;
  liveDebtRaw?: string;
  accountLtvBefore?: number | null;
  /** Resolved + clamped carve target LTV. */
  targetLtv?: number | null;
  /** Max collateral the account can give up so it lands at <= targetLtv, raw. */
  maxCarveRaw?: string | null;
  /** Account LTV if the FULL maxCarve were taken. */
  postLtvAtMax?: number | null;
  /** Whether the requested carve fits under the cap. */
  carveWithinCap?: boolean;
  /** Projected account LTV at the EXACT requested carve (pre-sign gate preview). */
  projectedPostLtvAtCarve?: number | null;
  /** Whether evaluateCollateralWithdraw allows the EXACT requested carve. */
  carveAllowed?: boolean;
  reasons?: Array<{ code: string; severity: string; message: string }>;
}

/**
 * Resolve the account borrow position for `collateralMint`, read its LIVE health,
 * and compute the carve cap at the target LTV + the projection for the EXACT
 * requested carve. PURE money-wise (only reads). Used by the proof DRY/preflight
 * path and as the basis the execute path re-validates against.
 */
export async function planPerbotCarve(args: {
  walletAddress: string;
  vault: BorrowVaultConfig;
  carveRaw: bigint;
  requestedTargetLtv?: number;
  globalTargetLtv?: number;
}): Promise<PerbotCarvePlan> {
  const { walletAddress, vault, carveRaw } = args;
  const collateralMint = vault.collateralMint;

  // Account position = open, this collateral, NOT bot-scoped. Exactly one expected.
  const all = await storage.getBorrowPositions(walletAddress, null);
  const acctPositions = all.filter(
    (p) => p.status === "open" && p.collateralMint === collateralMint && !p.tradingBotId,
  );
  if (acctPositions.length === 0) {
    return { ok: false, error: "No open ACCOUNT borrow position for this collateral to carve from." };
  }
  if (acctPositions.length > 1) {
    return { ok: false, error: "Multiple open account borrow positions for this collateral; refusing to carve (ambiguous source)." };
  }
  const acctPos = acctPositions[0];
  const venueId = acctPos.venuePositionId ? Number(acctPos.venuePositionId) : NaN;
  if (!Number.isInteger(venueId) || venueId <= 0) {
    return { ok: false, error: "Account borrow position has no valid on-chain id." };
  }

  const route = new JupiterLendBorrowRoute();
  const live = await route.readLivePositionHealth(collateralMint, venueId);
  if (!live) {
    return { ok: false, error: "Could not read the live account position; refusing to size the carve (fail closed)." };
  }
  const liveCollateralRaw = BigInt(live.collateralRaw);
  const liveDebtRaw = BigInt(live.debtRaw);

  const oracle = await readBorrowOracleContext(vault);

  const carve = evaluateMaxCarveForTargetLtv({
    vault,
    liveCollateralRaw,
    liveDebtRaw,
    oracle,
    requestedTargetLtv: args.requestedTargetLtv,
    globalTargetLtv: args.globalTargetLtv,
  });

  const accountLtvBefore = computeLtv(
    liveCollateralRaw,
    liveDebtRaw,
    vault.collateralDecimals,
    vault.debtDecimals,
    live.oraclePriceUsd,
  );

  // Projection for the EXACT requested carve (what the pre-sign gate will re-run).
  const exact = evaluateCollateralWithdraw({
    vault,
    liveCollateralRaw,
    liveDebtRaw,
    requestedWithdrawRaw: carveRaw,
    oracle,
    targetMaxLtv: carve.targetLtv ?? undefined,
  });

  const maxCarveRaw = carve.maxCarveRaw;
  const carveWithinCap = carve.allowed && maxCarveRaw !== null ? carveRaw <= BigInt(maxCarveRaw) : false;

  return {
    ok: carve.allowed && maxCarveRaw !== null,
    accountBorrowPositionId: acctPos.id,
    accountVenuePositionId: venueId,
    liveCollateralRaw: liveCollateralRaw.toString(),
    liveDebtRaw: liveDebtRaw.toString(),
    accountLtvBefore,
    targetLtv: carve.targetLtv,
    maxCarveRaw,
    postLtvAtMax: carve.postLtvAtMax,
    carveWithinCap,
    projectedPostLtvAtCarve: exact.postLtv,
    carveAllowed: exact.allowed,
    reasons: [...carve.reasons, ...exact.reasons].map((r) => ({ code: r.code, severity: r.severity, message: r.message })),
  };
}

// ===========================================================================
// CARVE / OPEN op
// ===========================================================================

export interface PerbotCarveOpenParams {
  walletAddress: string;
  vault: BorrowVaultConfig;
  /** Account agent: signs the withdraw + the carve transfer + funds bot gas. */
  accountPublicKey: string;
  accountSecretKey: Uint8Array;
  /** Bot agent: signs the open; receives the carved collateral + borrowed USDC. */
  botPublicKey: string;
  botSecretKey: Uint8Array;
  tradingBotId: string;
  /** Account borrow position to carve FROM (DB id + on-chain nft id). */
  accountBorrowPositionId: string;
  accountVenuePositionId: number;
  /** Collateral to carve, raw (already validated <= cap by the planner). */
  carveRaw: bigint;
  /** USDC to borrow in the new bot position, raw. */
  requestedDebtRaw: bigint;
  /** Resolved + clamped target LTV (drives the pre-sign re-gate). */
  targetLtv: number;
  clientRequestId: string;
}

/**
 * CARVE/OPEN. Withdraw `carveRaw` collateral out of the account position (gated
 * AGAIN at `targetLtv` immediately before signing), assert the account lands at
 * <= targetLtv on an on-chain re-read, transfer it to the bot wallet, then open
 * the bot's borrow position. Resumable; never re-runs a confirmed leg.
 */
export async function runPerbotCarveOpen(params: PerbotCarveOpenParams): Promise<PerbotCarveResult> {
  if (params.carveRaw <= 0n) return { success: false, error: "Carve amount must be greater than zero." };
  if (params.requestedDebtRaw <= 0n) return { success: false, error: "Borrow amount must be greater than zero." };

  const collateralMint = params.vault.collateralMint;
  const route = new JupiterLendBorrowRoute();

  return withBorrowLock(`perbot-carve:${params.walletAddress}:${params.clientRequestId}`, async () => {
    let op = await resolveOrCreateOp({
      walletAddress: params.walletAddress,
      borrowPositionId: params.accountBorrowPositionId,
      clientRequestId: params.clientRequestId,
      operationType: "perbot_carve_open",
      metadata: {
        tradingBotId: params.tradingBotId,
        collateralMint,
        accountBorrowPositionId: params.accountBorrowPositionId,
        accountVenuePositionId: params.accountVenuePositionId,
        carveRaw: params.carveRaw.toString(),
        requestedDebtRaw: params.requestedDebtRaw.toString(),
        targetLtv: params.targetLtv,
        botPublicKey: params.botPublicKey,
        accountPublicKey: params.accountPublicKey,
      },
    });
    // Refuse to resume a same-reqId op that was started with different inputs.
    const idMismatch = validateOpIdentity(op, "perbot_carve_open", {
      tradingBotId: params.tradingBotId,
      collateralMint,
      accountBorrowPositionId: params.accountBorrowPositionId,
      accountVenuePositionId: params.accountVenuePositionId,
      carveRaw: params.carveRaw.toString(),
      requestedDebtRaw: params.requestedDebtRaw.toString(),
      targetLtv: params.targetLtv,
    });
    if (idMismatch) return { success: false, operationId: op.id, step: op.step ?? undefined, error: idMismatch, needsAttention: false };
    if (op.status === "succeeded") {
      const r = (op.result as Meta | null) ?? {};
      return {
        success: true,
        operationId: op.id,
        step: op.step ?? "final_read",
        borrowPositionId: r.borrowPositionId,
        carvedRaw: r.carvedRaw,
        accountPostLtv: r.accountPostLtv ?? null,
        borrowedUsdcRaw: r.borrowedUsdcRaw,
        signatures: (op.txSignatures as string[] | null) ?? [],
      };
    }

    // ---- WITHDRAW (carve) leg --------------------------------------------
    // Account-position withdraw is AMOUNT-EXACT and pulls from the position
    // (which keeps the collateral until the tx lands), so a blind re-broadcast
    // double-withdraws. Resume authority is the write-ahead signature reconciled
    // by status — never the agent balance (reads 0 while in-flight).
    let carvedRaw = BigInt(readMeta(op).carvedRawObserved || "0");
    const wStep = op.step ?? "";
    if (wStep === "initialized" || wStep === "withdraw_failed" || wStep === "withdrawing") {
      let recovered = false;
      if (wStep === "withdrawing") {
        const meta = readMeta(op);
        if (meta.withdrawSig) {
          const status = await reconcileSignature(meta.withdrawSig, meta.withdrawLvbh);
          if (status === "landed") recovered = true;
          else if (status === "in_flight") return failClosed(op, "withdrawing", "The collateral carve is still settling. Funds are safe in the account position — retry in a moment.", true);
          // reverted | expired -> dead tx, re-withdraw safely below.
        }
      }
      if (!recovered) {
        // PRE-SIGN RE-GATE (architect contract): re-read live account health +
        // oracle and re-run the EXACT-amount target-LTV gate immediately before
        // signing. Nothing has moved yet, so a deny here is RESTARTABLE.
        const oracle = await readBorrowOracleContext(params.vault);
        const liveBefore = await route.readLivePositionHealth(collateralMint, params.accountVenuePositionId);
        if (!liveBefore) return failClosed(op, "withdraw_failed", "Could not read the live account position; refusing to carve.", false);
        const gate = evaluateCollateralWithdraw({
          vault: params.vault,
          liveCollateralRaw: BigInt(liveBefore.collateralRaw),
          liveDebtRaw: BigInt(liveBefore.debtRaw),
          requestedWithdrawRaw: params.carveRaw,
          oracle,
          targetMaxLtv: params.targetLtv,
        });
        if (!gate.allowed) {
          const deny = gate.reasons.find((r) => r.severity === "deny");
          return failClosed(op, "withdraw_failed", deny?.message || "Carve is not allowed under the target LTV.", false);
        }

        await storage.updateBorrowOperation(op.id, { step: "withdrawing" });
        const w = await executeWithdrawCollateral({
          walletAddress: params.walletAddress,
          agentPublicKey: params.accountPublicKey,
          agentSecretKey: params.accountSecretKey,
          borrowPositionId: params.accountBorrowPositionId,
          amount: params.carveRaw,
          deliverToUserWallet: false, // STAY in the account agent wallet for the carve transfer.
          onBeforeBroadcast: async ({ signature, lastValidBlockHeight }) => {
            await storage.updateBorrowOperation(op.id, {
              mergeMetadata: { withdrawSig: signature, withdrawLvbh: lastValidBlockHeight },
              appendTxSignature: signature,
            });
          },
        });
        if (!w.success) {
          op = (await storage.getBorrowOperationById(op.id)) ?? op;
          const meta = readMeta(op);
          const sig = meta.withdrawSig as string | undefined;
          if (!sig) return failClosed(op, "withdraw_failed", w.error || "The collateral carve did not complete.", false);
          const status = await reconcileSignature(sig, meta.withdrawLvbh);
          if (status === "in_flight") return failClosed(op, "withdrawing", "The collateral carve is still settling. Funds are safe in the account position — retry in a moment.", true);
          if (status !== "landed") return failClosed(op, "withdraw_failed", w.error || "The collateral carve did not complete.", false);
          // false-negative: it actually landed -> fall through and record.
        }
        // The realised withdrawn amount is the EXACT carve (the withdraw is
        // amount-exact). Do NOT use w.observedCollateralRaw — that is the
        // post-withdraw REMAINING position collateral (the leftover stake), NOT the
        // withdrawn delta. Trusting it recorded the whole remaining stake as the carve
        // and the transfer leg then tried to move far more than was un-pledged.
        carvedRaw = params.carveRaw;
      } else {
        // Recovered on resume; the withdraw already landed at the ORIGINAL amount-exact
        // carve (persisted at op creation as metadata.carveRaw), not a re-measured balance.
        carvedRaw = BigInt(readMeta(op).carveRaw || params.carveRaw.toString());
      }

      // POST-WITHDRAW on-chain assertion: the account must now sit at <= target.
      const liveAfter = await route.readLivePositionHealth(collateralMint, params.accountVenuePositionId);
      if (!liveAfter) return failClosed(op, "account_withdrawn", "Carve landed but the account position is unreadable; funds are in the account wallet — reconcile before continuing.", true);
      const postLtv = computeLtv(
        BigInt(liveAfter.collateralRaw),
        BigInt(liveAfter.debtRaw),
        params.vault.collateralDecimals,
        params.vault.debtDecimals,
        liveAfter.oraclePriceUsd,
      );
      if (postLtv === null || postLtv > params.targetLtv + LTV_ASSERT_EPSILON) {
        return failClosed(op, "account_withdrawn", `Account post-carve LTV (${postLtv === null ? "unreadable" : postLtv.toFixed(4)}) exceeds the target (${params.targetLtv}). Carved collateral is in the account wallet — re-supply it before continuing.`, true);
      }
      await storage.updateBorrowOperation(op.id, {
        step: "account_withdrawn",
        mergeMetadata: { carvedRawObserved: carvedRaw.toString(), accountPostLtv: postLtv },
      });
      op = (await storage.getBorrowOperationById(op.id)) ?? op;
    }

    if (carvedRaw <= 0n) carvedRaw = BigInt(readMeta(op).carvedRawObserved || "0");
    if (carvedRaw <= 0n) return failClosed(op, "account_withdrawn", "Carved amount is zero after the withdraw; nothing to carve.", true);

    // ---- TRANSFER (account -> bot) leg -----------------------------------
    const tStep = op.step ?? "";
    if (tStep === "account_withdrawn" || tStep === "carving" || tStep === "carve_failed") {
      let recovered = false;
      if (tStep === "carving") {
        const meta = readMeta(op);
        if (meta.carveSig) {
          const status = await reconcileSignature(meta.carveSig, meta.carveLvbh);
          if (status === "landed") recovered = true;
          else if (status === "in_flight") return failClosed(op, "carving", "The carve transfer to the bot is still settling. Funds are safe in the account wallet — retry in a moment.", true);
        }
      }
      if (!recovered) {
        // AMOUNT-EXACT carve: the withdraw un-pledged exactly the ORIGINAL requested
        // carve (persisted at op creation as metadata.carveRaw, immutable) into the
        // account agent wallet. Re-derive the transfer amount here from that original
        // value CAPPED at the live strict wallet balance — never from a re-measured
        // position "remaining" reading, and never from params.carveRaw (a resume may
        // re-size it). Capping at the live balance means a stuck op can never try to
        // move more collateral than is actually in the wallet, and we never sweep
        // unrelated funds (cap is the requested amount, floor is what is held).
        const intendedCarveRaw = BigInt(readMeta(op).carveRaw || params.carveRaw.toString());
        let heldRaw: bigint;
        try {
          heldRaw = await strictBalanceRaw(params.accountPublicKey, collateralMint);
        } catch (e: any) {
          return failClosed(op, "carve_failed", `Could not read the carved collateral in the account wallet (${e?.message || e}). Funds are safe in the account wallet — retry in a moment.`, true);
        }
        carvedRaw = heldRaw < intendedCarveRaw ? heldRaw : intendedCarveRaw;
        if (carvedRaw <= 0n) {
          return failClosed(op, "carve_failed", "No carved collateral is in the account wallet to move to the bot. Funds are safe in the account position — retry in a moment.", true);
        }
        // Persist the TRUE carved amount BEFORE the broadcast so a crash mid-transfer
        // resumes with the right number (the open leg supplies exactly this).
        await storage.updateBorrowOperation(op.id, { step: "carving", mergeMetadata: { carvedRawObserved: carvedRaw.toString() } });
        const xfer = await transferTokenToWalletExact({
          agentPublicKey: params.accountPublicKey,
          agentSecretKey: params.accountSecretKey,
          toWalletAddress: params.botPublicKey,
          mint: collateralMint,
          amountRaw: carvedRaw,
          onBeforeBroadcast: async ({ signature, lastValidBlockHeight }) => {
            await storage.updateBorrowOperation(op.id, {
              mergeMetadata: { carveSig: signature, carveLvbh: lastValidBlockHeight },
              appendTxSignature: signature,
            });
          },
        });
        if (!xfer.success) {
          op = (await storage.getBorrowOperationById(op.id)) ?? op;
          const meta = readMeta(op);
          const sig = meta.carveSig as string | undefined;
          if (!sig) return failClosed(op, "carve_failed", xfer.error || "The carve transfer to the bot did not complete. Funds are safe in the account wallet.", true);
          const status = await reconcileSignature(sig, meta.carveLvbh);
          if (status === "in_flight") return failClosed(op, "carving", "The carve transfer to the bot is still settling. Funds are safe in the account wallet — retry in a moment.", true);
          if (status !== "landed") return failClosed(op, "carve_failed", xfer.error || "The carve transfer to the bot did not complete. Funds are safe in the account wallet.", true);
        }
      }
      await storage.updateBorrowOperation(op.id, { step: "carved_to_bot" });
      op = (await storage.getBorrowOperationById(op.id)) ?? op;
    }

    // ---- OPEN (bot supply + borrow) leg ----------------------------------
    // executeBorrowOpen is NOT clientRequestId-idempotent (it mints a fresh
    // position). It DOES, however, write-ahead the new position id onto THIS op
    // (via onPositionCreated, below) BEFORE it broadcasts — so once an open of
    // ours has begun, meta.borrowPositionId names our own row. Resume by an EXACT
    // id match: adopt ONLY our own live row; never adopt a foreign one.
    const oStep = op.step ?? "";
    if (oStep === "carved_to_bot" || oStep === "opening" || oStep === "open_failed") {
      const ownPositionId = readMeta(op).borrowPositionId as string | undefined;
      const liveBotRows = (await storage.getBorrowPositions(params.walletAddress, params.tradingBotId))
        .filter((p) => p.status !== "closed" && p.status !== "failed" && p.collateralMint === collateralMint);
      const ownLive = ownPositionId ? liveBotRows.find((p) => p.id === ownPositionId) : undefined;
      if (ownLive) {
        // OUR own non-terminal row exists — but its mere existence does NOT prove
        // the open LANDED. The executor write-aheads this row as 'pending' BEFORE
        // it broadcasts, so a crash in the send window leaves a matching 'pending'
        // row with NO money moved. We do NOT hold the open's signature here, so we
        // cannot tell a pre-broadcast crash (no money) from an in-flight tx (may
        // still land) — re-opening either could DOUBLE-OPEN. So finalise ONLY when
        // the open is PROVEN: status 'open' (the executor already confirmed it),
        // or a positive on-chain position read (it landed, the DB row just lagged).
        // Anything else fails CLOSED — the carved collateral is safe in the bot
        // wallet (recoverable via the unwind path).
        if (ownLive.status === "open") {
          // The executor finalized this row to 'open' with the OBSERVED debt
          // (executor line ~467-473). If the crash landed BETWEEN that finalize and
          // the op-metadata write of borrowedUsdcRaw (~685), metadata lacks it; fall
          // back to the row's debtAmountRaw (Jupiter Lend debt == borrowed USDC 1:1)
          // so the route's "borrowed USDC landed" check has a positive value on
          // resume (delta is 0 then) instead of false-500'ing with the loan OPEN.
          return finalizeCarveOpen(op, {
            borrowPositionId: ownLive.id,
            carvedRaw,
            accountPostLtv: readMeta(op).accountPostLtv ?? null,
            borrowedUsdcRaw: readMeta(op).borrowedUsdcRaw ?? ownLive.debtAmountRaw ?? undefined,
          });
        }
        const botVenueId = ownLive.venuePositionId ? Number(ownLive.venuePositionId) : NaN;
        const liveBot = Number.isFinite(botVenueId)
          ? await route.readLivePositionHealth(collateralMint, botVenueId)
          : null;
        if (liveBot && (BigInt(liveBot.debtRaw) > 0n || BigInt(liveBot.collateralRaw) > 0n)) {
          // The open DID land; the DB row just lagged behind the chain. Reconcile
          // the row pending->open with the OBSERVED on-chain amounts FIRST — the
          // downstream unwind (executeBorrowClose requires status 'open') cannot
          // close a 'pending' row — then finalise. borrowedUsdcRaw falls back to
          // the live position debt (Jupiter Lend debt is USDC-denominated 1:1).
          if (ownLive.status !== "open") {
            const reconciled = await storage.updateBorrowPosition(
              ownLive.id,
              { status: "open", collateralAmountRaw: liveBot.collateralRaw, debtAmountRaw: liveBot.debtRaw },
              ownLive.status ?? undefined,
            );
            if (!reconciled) {
              // CAS lost: the row left its prior status under us. Re-read; proceed
              // ONLY if it is now genuinely 'open' (a concurrent reconcile won the
              // race). Any other status means the unwind (requires 'open') cannot
              // close it -> fail closed for manual review (funds are on-chain).
              const fresh = await storage.getBorrowPosition(params.walletAddress, ownLive.id);
              if (!fresh || fresh.status !== "open") {
                return failClosed(op, op.step ?? "opening", "Bot borrow row could not be reconciled to 'open' (status changed under reconcile). Funds are on-chain; resolve the row before retrying.", true);
              }
            }
          }
          return finalizeCarveOpen(op, {
            borrowPositionId: ownLive.id,
            carvedRaw,
            accountPostLtv: readMeta(op).accountPostLtv ?? null,
            borrowedUsdcRaw: readMeta(op).borrowedUsdcRaw ?? liveBot.debtRaw,
          });
        }
        return failClosed(op, op.step ?? "opening", "A prior open for this bot is unconfirmed on-chain. Funds are safe in the bot wallet; reconcile the pending position before retrying.", true);
      }
      // No LIVE position of our own. Any OTHER live bot row is FOREIGN — refuse to
      // adopt or open over it (the route clean-bot guard normally blocks this;
      // fail closed here as defense in depth so the orchestrator is self-safe).
      const foreign = liveBotRows.filter((p) => p.id !== ownPositionId);
      if (foreign.length > 0) {
        return failClosed(op, op.step ?? "opening", "An unexpected borrow position exists on this bot that this run did not open. Reconcile it before retrying.", true);
      }
      // Clean: (re)open. A prior open that provably failed left the carved
      // collateral FREE in the bot wallet, so a fresh mint is safe.

      await storage.updateBorrowOperation(op.id, { step: "opening" });
      const botUsdcBefore = await strictBalanceRaw(params.botPublicKey, SWAP_USDC_MINT);
      const open = await executeBorrowOpen({
        walletAddress: params.walletAddress,
        agentPublicKey: params.botPublicKey,
        agentSecretKey: params.botSecretKey,
        collateralMint,
        collateralRaw: carvedRaw,
        requestedDebtRaw: params.requestedDebtRaw,
        tradingBotId: params.tradingBotId,
        funderPublicKey: params.accountPublicKey,
        funderSecretKey: params.accountSecretKey,
        existingDebtRawOverride: 0n,
        // Write-ahead the new bot position id onto THIS op BEFORE the broadcast,
        // so a crash in the send window is resumable and the route's clean-bot
        // guard can tell our own position from a foreign one.
        onPositionCreated: async (positionId) => {
          await storage.updateBorrowOperation(op.id, { mergeMetadata: { borrowPositionId: positionId } });
        },
      });
      if (!open.success || !open.borrowPositionId) {
        // The carved collateral is FREE in the BOT wallet (recoverable). A retry
        // re-opens; the UNWIND op can also return it to the account.
        return failClosed(op, "open_failed", `${open.error || "Open failed"}. Carved collateral is safe in the bot wallet.`, true);
      }
      const botUsdcAfter = await strictBalanceRaw(params.botPublicKey, SWAP_USDC_MINT);
      const borrowedDelta = botUsdcAfter - botUsdcBefore;
      await storage.updateBorrowOperation(op.id, {
        step: "bot_opened",
        borrowPositionId: open.borrowPositionId,
        mergeMetadata: {
          borrowPositionId: open.borrowPositionId,
          borrowedUsdcRaw: (open.observedDebtRaw ?? (borrowedDelta > 0n ? borrowedDelta.toString() : "0")),
          openSig: open.signature,
        },
        ...(open.signature ? { appendTxSignature: open.signature } : {}),
      });
      op = (await storage.getBorrowOperationById(op.id)) ?? op;
      return finalizeCarveOpen(op, {
        borrowPositionId: open.borrowPositionId,
        carvedRaw,
        accountPostLtv: readMeta(op).accountPostLtv ?? null,
        borrowedUsdcRaw: readMeta(op).borrowedUsdcRaw,
      });
    }

    // Resuming at/after bot_opened -> finalise from the breadcrumb.
    const meta = readMeta(op);
    if (!meta.borrowPositionId) return failClosed(op, op.step ?? "bot_opened", "Open step reached without a recorded position id.", true);
    return finalizeCarveOpen(op, {
      borrowPositionId: meta.borrowPositionId,
      carvedRaw,
      accountPostLtv: meta.accountPostLtv ?? null,
      borrowedUsdcRaw: meta.borrowedUsdcRaw,
    });
  });
}

async function finalizeCarveOpen(
  op: BorrowOperation,
  r: { borrowPositionId: string; carvedRaw: bigint; accountPostLtv: number | null; borrowedUsdcRaw?: string },
): Promise<PerbotCarveResult> {
  const result: Meta = {
    borrowPositionId: r.borrowPositionId,
    carvedRaw: r.carvedRaw.toString(),
    accountPostLtv: r.accountPostLtv,
    borrowedUsdcRaw: r.borrowedUsdcRaw,
  };
  await storage.updateBorrowOperation(op.id, { status: "succeeded", step: "final_read", borrowPositionId: r.borrowPositionId, result });
  const fresh = await storage.getBorrowOperationById(op.id);
  return {
    success: true,
    operationId: op.id,
    step: "final_read",
    borrowPositionId: r.borrowPositionId,
    carvedRaw: r.carvedRaw.toString(),
    accountPostLtv: r.accountPostLtv,
    borrowedUsdcRaw: r.borrowedUsdcRaw,
    signatures: ((fresh?.txSignatures ?? op.txSignatures) as string[] | null) ?? [],
  };
}

// ===========================================================================
// UNWIND / CLOSE op
// ===========================================================================

export interface PerbotUnwindCloseParams {
  walletAddress: string;
  vault: BorrowVaultConfig;
  accountPublicKey: string;
  accountSecretKey: Uint8Array;
  botPublicKey: string;
  botSecretKey: Uint8Array;
  tradingBotId: string;
  /** The bot's borrow position to close. */
  botBorrowPositionId: string;
  /** The account borrow position to re-pledge the returned collateral into. */
  accountBorrowPositionId: string;
  accountVenuePositionId: number;
  /** USDC the bot RECEIVED at open (the open's realised borrow delta) — a stable
   *  sizing BASELINE for the pre-close repay top-up. True debt = this principal +
   *  accrued interest, so principal sits just BELOW true debt; the headroom added
   *  on top is what covers the interest. The live getCurrentPosition debt
   *  UNDER-reads, so it is NOT used for sizing. */
  borrowedPrincipalRaw?: bigint;
  clientRequestId: string;
}

/**
 * UNWIND/CLOSE. Close the bot's borrow position (repay-all + withdraw-all),
 * transfer the returned collateral back to the account wallet, and re-supply it
 * into the ACCOUNT position. Resumable; a partial (collateral at the bot or the
 * account wallet, re-supply not yet done) stops at needs_attention and a retry
 * FINISHES the remaining legs — it never reports success early.
 */
/** A stable sizing BASELINE for the bot loan's repayable debt, raw (USDC, 6dp).
 *  The borrowed PRINCIPAL (USDC the bot received at open) sits just BELOW true
 *  debt (true debt = principal + accrued interest); the caller adds a headroom on
 *  top to cover that interest. Principal is NOT subject to the getCurrentPosition
 *  under-read that breaks exact-repay sizing, which is why it is the baseline.
 *  Prefer the caller-supplied value (the open's realised borrow delta), then the
 *  recorded open op, then the bot position's recorded debt. Returns 0n only when
 *  nothing is knowable (the top-up then degrades to a small fixed headroom over
 *  the bot's live USDC). */
async function resolvePrincipalRaw(params: PerbotUnwindCloseParams): Promise<bigint> {
  if (params.borrowedPrincipalRaw && params.borrowedPrincipalRaw > 0n) return params.borrowedPrincipalRaw;
  try {
    const ops = await storage.getBorrowOperations(params.walletAddress, params.botBorrowPositionId);
    const open = ops.find((o) => o.operationType === "perbot_carve_open");
    if (open) {
      const r = (open.result as Meta | null) ?? {};
      const m = readMeta(open);
      const cand = BigInt(r.borrowedUsdcRaw || m.requestedDebtRaw || "0");
      if (cand > 0n) return cand;
    }
  } catch {
    /* fall through to the next source */
  }
  try {
    const dbPos = await storage.getBorrowPosition(params.walletAddress, params.botBorrowPositionId);
    const cand = dbPos ? BigInt((dbPos as any).debtAmountRaw ?? "0") : 0n;
    if (cand > 0n) return cand;
  } catch {
    /* fall through */
  }
  return 0n;
}

/**
 * DISPLAY-only principal floor for a per-bot loan, raw (USDC, 6dp). READ-ONLY —
 * never used for money sizing (the repay path keeps using `resolvePrincipalRaw`
 * + MAX_REPAY).
 *
 * The live `getCurrentPosition` debt UNDER-reads (a $5.00 borrow reads back
 * ~$4.83), so a freshly-opened loan looks smaller than the user actually owes.
 * For DISPLAY we floor the shown debt at the realised principal recorded by the
 * open op = max(requestedDebtRaw, borrowedUsdcRaw) across the op metadata and
 * result. `requestedDebtRaw` is the user's intended borrow (the true principal);
 * `borrowedUsdcRaw` is also under-read but kept in the max as a safety net.
 * Returns 0n when there's no open op / nothing knowable (caller then falls back
 * to the live/stored debt).
 */
export async function resolveDisplayPrincipalRaw(
  walletAddress: string,
  botBorrowPositionId: string,
): Promise<bigint> {
  try {
    const ops = await storage.getBorrowOperations(walletAddress, botBorrowPositionId);
    const open = ops.find((o) => o.operationType === "perbot_carve_open");
    if (!open) return 0n;
    const r = (open.result as Meta | null) ?? {};
    const m = readMeta(open);
    let best = 0n;
    for (const v of [r.borrowedUsdcRaw, m.borrowedUsdcRaw, m.requestedDebtRaw]) {
      try {
        const cand = BigInt(v ?? "0");
        if (cand > best) best = cand;
      } catch {
        /* skip unparseable */
      }
    }
    return best;
  } catch {
    return 0n;
  }
}

export async function runPerbotUnwindClose(params: PerbotUnwindCloseParams): Promise<PerbotCarveResult> {
  const collateralMint = params.vault.collateralMint;
  const route = new JupiterLendBorrowRoute();

  return withBorrowLock(`perbot-unwind:${params.walletAddress}:${params.clientRequestId}`, async () => {
    let op = await resolveOrCreateOp({
      walletAddress: params.walletAddress,
      borrowPositionId: params.botBorrowPositionId,
      clientRequestId: params.clientRequestId,
      operationType: "perbot_unwind_close",
      metadata: {
        tradingBotId: params.tradingBotId,
        collateralMint,
        botBorrowPositionId: params.botBorrowPositionId,
        accountBorrowPositionId: params.accountBorrowPositionId,
        accountVenuePositionId: params.accountVenuePositionId,
        accountPublicKey: params.accountPublicKey,
        botPublicKey: params.botPublicKey,
      },
    });
    // Refuse to resume a same-reqId op that was started with different inputs.
    const idMismatch = validateOpIdentity(op, "perbot_unwind_close", {
      tradingBotId: params.tradingBotId,
      collateralMint,
      botBorrowPositionId: params.botBorrowPositionId,
      accountBorrowPositionId: params.accountBorrowPositionId,
      accountVenuePositionId: params.accountVenuePositionId,
    });
    if (idMismatch) return { success: false, operationId: op.id, step: op.step ?? undefined, error: idMismatch, needsAttention: false };
    if (op.status === "succeeded") {
      const r = (op.result as Meta | null) ?? {};
      return { success: true, operationId: op.id, step: op.step ?? "final_read", restoredRaw: r.restoredRaw, sweptRaw: r.sweptRaw, signatures: (op.txSignatures as string[] | null) ?? [] };
    }

    // Persist baselines BEFORE any move (bot collateral pre-close; account
    // position collateral pre-resupply) so resume can size + verify each leg.
    if (!readMeta(op).botCollBeforeRaw) {
      let botCollBefore: bigint;
      let acctPosCollBefore: bigint;
      try {
        botCollBefore = await strictBalanceRaw(params.botPublicKey, collateralMint);
      } catch {
        return failClosed(op, "initialized", "Could not read the bot collateral balance; nothing was changed.", true);
      }
      // FAIL CLOSED: the account-position baseline is the divisor for the
      // re-supply idempotency check. A substituted 0n would make `liveColl >=
      // 0 + returnedRaw - dust` pass spuriously for ANY funded account position
      // -> we'd finalize the unwind WITHOUT re-pledging, stranding the returned
      // INF free in the account wallet and leaving the account under-collateralised.
      const liveAcct = await route.readLivePositionHealth(collateralMint, params.accountVenuePositionId);
      if (!liveAcct) {
        return failClosed(op, "initialized", "Could not read the account position baseline; refusing to start the unwind (fail closed).", true);
      }
      acctPosCollBefore = BigInt(liveAcct.collateralRaw);
      await storage.updateBorrowOperation(op.id, {
        mergeMetadata: { botCollBeforeRaw: botCollBefore.toString(), acctPosCollBeforeRaw: acctPosCollBefore.toString() },
      });
      op = (await storage.getBorrowOperationById(op.id)) ?? op;
    }

    // ---- TOP-UP (account -> bot USDC) leg --------------------------------
    // Lend the bot a small, capped USDC headroom so the MAX_REPAY close fully
    // clears the debt without 0x1-ing a razor-thin bot wallet. Swept back after
    // (see the SWEEP leg). Sized from the borrowed PRINCIPAL (a stable baseline)
    // plus a headroom that covers accrued interest, never from the under-reading
    // live position.
    const upStep = op.step ?? "";
    // Legacy-resume bridge: an unwind op started by the PRE-FIX code (no TOP-UP
    // leg) is parked at "close_failed" (the close reverted -> never landed -> the
    // bot still owes the debt) with NO recorded top-up. A same-proofRunId re-POST
    // must still top up BEFORE retrying the close, or it repeats the original SPL
    // 0x1. A "closing" crash is deliberately NOT bridged: it is ambiguous (the
    // close may have landed), so the close leg's on-chain detection handles it; a
    // close that truly did not land self-heals to "close_failed" on the next round
    // (which this bridge then tops up). This also avoids fail-closing an unwind
    // whose close already landed just because the account is thin on USDC.
    const topupRecorded = readMeta(op).topupRaw !== undefined && readMeta(op).topupRaw !== null;
    const legacyPreTopup = upStep === "close_failed" && !topupRecorded;
    if (upStep === "initialized" || upStep === "topping_up" || upStep === "topup_failed" || legacyPreTopup) {
      let recovered = false;
      if (upStep === "topping_up") {
        const meta = readMeta(op);
        if (meta.topupSig) {
          const status = await reconcileSignature(meta.topupSig, meta.topupLvbh);
          if (status === "landed") recovered = true;
          else if (status === "in_flight") return failClosed(op, "topping_up", "The repay top-up to the bot is still settling. Funds are safe in the account wallet — retry in a moment.", true);
          // reverted | expired -> dead tx; recompute + re-send below.
        }
      }
      if (!recovered) {
        const principalRaw = await resolvePrincipalRaw(params);
        let botUsdcBefore: bigint;
        let acctUsdc: bigint;
        try {
          botUsdcBefore = await strictBalanceRaw(params.botPublicKey, USDC_MINT);
          acctUsdc = await strictBalanceRaw(params.accountPublicKey, USDC_MINT);
        } catch {
          return failClosed(op, "topup_failed", "Could not read the USDC balances to size the repay top-up; nothing was changed.", false);
        }
        // base = principal when known (baseline just below true debt; headroom
        // below covers the interest); else fall back to the bot's live USDC.
        const base = principalRaw > 0n ? principalRaw : botUsdcBefore;
        const headroom = bmax((base * TOPUP_HEADROOM_BPS) / 10_000n, TOPUP_MIN_HEADROOM_RAW);
        const target = base + headroom;
        const needRaw = target > botUsdcBefore ? target - botUsdcBefore : 0n;
        // Anomaly ceiling: a top-up bigger than ~1.5x the base means a misread
        // somewhere -> refuse rather than move a large amount of account USDC.
        const topupCeiling = base + bmax(base / 2n, TOPUP_MIN_HEADROOM_RAW * 4n);
        if (needRaw > topupCeiling) {
          return failClosed(op, "topup_failed", "The computed repay top-up exceeds the safety ceiling (read anomaly); refusing. Reconcile before retrying.", true);
        }
        if (needRaw > 0n && needRaw > acctUsdc) {
          return failClosed(op, "topup_failed", `The account wallet holds too little USDC to fund the repay top-up (needs ~${(Number(needRaw) / 1e6).toFixed(4)} USDC). Add a small USDC buffer to the account, then retry.`, true);
        }
        // Persist the protected baseline + planned top-up BEFORE moving money so a
        // mid-flight crash resumes with the right sweep cap (never sweeps the bot's
        // own pre-existing USDC).
        await storage.updateBorrowOperation(op.id, {
          step: "topping_up",
          mergeMetadata: { preTopupBotUsdcRaw: botUsdcBefore.toString(), topupRaw: needRaw.toString() },
        });
        if (needRaw > 0n) {
          const up = await transferTokenToWalletExact({
            agentPublicKey: params.accountPublicKey,
            agentSecretKey: params.accountSecretKey,
            toWalletAddress: params.botPublicKey,
            mint: USDC_MINT,
            amountRaw: needRaw,
            onBeforeBroadcast: async ({ signature, lastValidBlockHeight }) => {
              await storage.updateBorrowOperation(op.id, {
                mergeMetadata: { topupSig: signature, topupLvbh: lastValidBlockHeight },
                appendTxSignature: signature,
              });
            },
          });
          if (!up.success) {
            op = (await storage.getBorrowOperationById(op.id)) ?? op;
            const meta = readMeta(op);
            const sig = meta.topupSig as string | undefined;
            if (!sig) return failClosed(op, "topup_failed", up.error || "The repay top-up did not complete. Funds are safe in the account wallet.", true);
            const status = await reconcileSignature(sig, meta.topupLvbh);
            if (status === "in_flight") return failClosed(op, "topping_up", "The repay top-up to the bot is still settling. Funds are safe in the account wallet — retry in a moment.", true);
            if (status !== "landed") return failClosed(op, "topup_failed", up.error || "The repay top-up did not complete. Funds are safe in the account wallet.", true);
            // false-negative: it actually landed -> fall through.
          }
        }
      }
      await storage.updateBorrowOperation(op.id, { step: "topped_up" });
      op = (await storage.getBorrowOperationById(op.id)) ?? op;
    }

    // ---- CLOSE (bot position) leg ----------------------------------------
    let returnedRaw = BigInt(readMeta(op).returnedRaw || "0");
    const cStep = op.step ?? "";
    if (cStep === "topped_up" || cStep === "closing" || cStep === "close_failed") {
      const dbPos = await storage.getBorrowPosition(params.walletAddress, params.botBorrowPositionId);
      let closeLanded = !dbPos || dbPos.status === "closed";

      // RESUME-SAFE close detection. executeBorrowClose has NO write-ahead
      // signature and REJECTS any non-"open" DB status. A crash AFTER it claims
      // "closing" (CAS open->closing) and broadcasts, but BEFORE the DB finalize,
      // leaves DB="closing" while the close tx already landed on-chain. A blind
      // retry would (a) be rejected for status!="open" -> stall forever, OR (b)
      // re-close an already-empty position. So consult the LIVE on-chain position
      // (source of truth) before acting.
      if (!closeLanded && dbPos) {
        const botVenueId = dbPos.venuePositionId ? Number(dbPos.venuePositionId) : NaN;
        if (!Number.isInteger(botVenueId) || botVenueId <= 0) {
          return failClosed(op, "close_failed", "Bot borrow position has no valid on-chain id; cannot confirm close state.", true);
        }
        const liveBot = await route.readLivePositionHealth(collateralMint, botVenueId);
        if (!liveBot) {
          return failClosed(op, "close_failed", "Could not read the live bot position to confirm close state; reconcile before retrying.", true);
        }
        if (BigInt(liveBot.debtRaw) <= DEBT_DUST && BigInt(liveBot.collateralRaw) <= COLL_DUST) {
          // Close ALREADY landed on-chain; the DB row just lagged. Reconcile it
          // forward so the downstream route reconcile sees "closed".
          closeLanded = true;
          await storage.updateBorrowPosition(
            dbPos.id,
            { status: "closed", debtAmountRaw: BigInt(liveBot.debtRaw).toString(), collateralAmountRaw: BigInt(liveBot.collateralRaw).toString() },
            dbPos.status,
          );
        } else if (dbPos.status === "closing") {
          // Claimed "closing" but the close did NOT land (crash before/at
          // broadcast) — chain still shows the debt, so nothing was repaid/
          // withdrawn. Reset to "open" so executeBorrowClose can re-attempt.
          await storage.updateBorrowPosition(dbPos.id, { status: "open" }, "closing");
        }
      }

      if (!closeLanded) {
        await storage.updateBorrowOperation(op.id, { step: "closing" });
        const close = await executeBorrowClose({
          walletAddress: params.walletAddress,
          agentPublicKey: params.botPublicKey,
          agentSecretKey: params.botSecretKey,
          borrowPositionId: params.botBorrowPositionId,
          funderPublicKey: params.accountPublicKey,
          funderSecretKey: params.accountSecretKey,
        });
        if (!close.success || !close.finalized) {
          return failClosed(op, "close_failed", `${close.error || "Close did not finalise"}. The bot position may still be OPEN — reconcile before retrying.`, true);
        }
        if (close.signature) {
          await storage.updateBorrowOperation(op.id, { appendTxSignature: close.signature, mergeMetadata: { closeSig: close.signature } });
        }
      }
      // Realised collateral returned to the bot wallet = post-close balance minus
      // the persisted pre-close baseline (coexistence-safe: parked Perena / spare
      // USDC are different mints and never enter this delta).
      const botCollAfter = await strictBalanceRaw(params.botPublicKey, collateralMint);
      const botCollBefore = BigInt(readMeta(op).botCollBeforeRaw || "0");
      returnedRaw = botCollAfter - botCollBefore;
      if (returnedRaw <= 0n) {
        return failClosed(op, "bot_closed", "Bot position closed but no collateral returned to the bot wallet; reconcile before re-pledging.", true);
      }
      // History: a Title-Case internal "Repay Debt" event so the bot's user-facing
      // feed never shows a dangling "Borrow ..." (the P0-4 known item). The repay
      // type is in VAULT_INTERNAL_EVENT_TYPES => excluded from net-deposited PnL.
      // Amount = the borrow principal (resolvePrincipalRaw = the at-open debt). For
      // Jupiter Lend the debt incurred equals the USDC delivered, so this matches
      // the open's `borrow` row up to interest/rounding (a repay legitimately
      // clears principal+interest). Recorded EXACTLY-ONCE across crash-resume via
      // the close-tx existence check + repayEventRecorded flag. Non-fatal.
      if (!readMeta(op).repayEventRecorded) {
        try {
          const closeSig = (readMeta(op).closeSig as string | undefined) ?? null;
          // Idempotent insert: if a prior attempt recorded this repay but crashed
          // before persisting the flag, the close-tx-keyed row already exists — do
          // NOT duplicate it. closeSig is unique to THIS repay row (the close leg
          // emits no other equity event), so a hit is unambiguously our own row.
          // When closeSig is absent the meta flag is the only guard; that residual
          // window is sub-second and the row is purely cosmetic (non-fatal).
          const already = closeSig ? await storage.getEquityEventByTxSignature(closeSig) : undefined;
          if (!already) {
            const repaidRaw = await resolvePrincipalRaw(params);
            if (repaidRaw > 0n) {
              const ucfg = await route.getVaultConfig(collateralMint);
              const amtStr = (Number(repaidRaw) / 10 ** (ucfg?.debtDecimals ?? 6)).toFixed(6);
              const sym = ucfg?.collateralSymbol ?? "collateral";
              await storage.createEquityEvent({
                walletAddress: params.walletAddress,
                tradingBotId: params.tradingBotId,
                eventType: "repay",
                amount: amtStr,
                assetType: "USDC",
                txSignature: closeSig,
                notes: `Repaid ${amtStr} USDC of ${sym}-backed debt`,
              });
            }
          }
          // Flag set unconditionally (a zero principal => nothing to pair; never retry).
          await storage.updateBorrowOperation(op.id, { mergeMetadata: { repayEventRecorded: "1" } });
          op = (await storage.getBorrowOperationById(op.id)) ?? op;
        } catch (e) {
          console.warn("[Perbot unwind] failed to record repay equity event (non-fatal)", e);
        }
      }
      await storage.updateBorrowOperation(op.id, { step: "bot_closed", mergeMetadata: { returnedRaw: returnedRaw.toString() } });
      op = (await storage.getBorrowOperationById(op.id)) ?? op;
    }
    if (returnedRaw <= 0n) returnedRaw = BigInt(readMeta(op).returnedRaw || "0");
    if (returnedRaw <= 0n) return failClosed(op, "bot_closed", "No returned collateral recorded to re-pledge.", true);

    // ---- TRANSFER (bot -> account) leg -----------------------------------
    const tStep = op.step ?? "";
    if (tStep === "bot_closed" || tStep === "returning" || tStep === "return_failed") {
      let recovered = false;
      if (tStep === "returning") {
        const meta = readMeta(op);
        if (meta.returnSig) {
          const status = await reconcileSignature(meta.returnSig, meta.returnLvbh);
          if (status === "landed") recovered = true;
          else if (status === "in_flight") return failClosed(op, "returning", "The return transfer to the account is still settling. Funds are safe in the bot wallet — retry in a moment.", true);
        }
      }
      if (!recovered) {
        await storage.updateBorrowOperation(op.id, { step: "returning" });
        const xfer = await transferTokenToWalletExact({
          agentPublicKey: params.botPublicKey,
          agentSecretKey: params.botSecretKey,
          toWalletAddress: params.accountPublicKey,
          mint: collateralMint,
          amountRaw: returnedRaw,
          onBeforeBroadcast: async ({ signature, lastValidBlockHeight }) => {
            await storage.updateBorrowOperation(op.id, {
              mergeMetadata: { returnSig: signature, returnLvbh: lastValidBlockHeight },
              appendTxSignature: signature,
            });
          },
        });
        if (!xfer.success) {
          op = (await storage.getBorrowOperationById(op.id)) ?? op;
          const meta = readMeta(op);
          const sig = meta.returnSig as string | undefined;
          if (!sig) return failClosed(op, "return_failed", xfer.error || "The return transfer did not complete. Funds are safe in the bot wallet.", true);
          const status = await reconcileSignature(sig, meta.returnLvbh);
          if (status === "in_flight") return failClosed(op, "returning", "The return transfer to the account is still settling. Funds are safe in the bot wallet — retry in a moment.", true);
          if (status !== "landed") return failClosed(op, "return_failed", xfer.error || "The return transfer did not complete. Funds are safe in the bot wallet.", true);
        }
      }
      await storage.updateBorrowOperation(op.id, { step: "returned_to_account" });
      op = (await storage.getBorrowOperationById(op.id)) ?? op;
    }

    // ---- RE-SUPPLY (account position) leg --------------------------------
    const sStep = op.step ?? "";
    if (sStep === "returned_to_account" || sStep === "resupplying" || sStep === "resupply_failed") {
      // Idempotency: if the account position collateral already grew by ~returnedRaw
      // vs the persisted baseline, a prior run supplied it -> skip the re-supply.
      const acctPosCollBefore = BigInt(readMeta(op).acctPosCollBeforeRaw || "0");
      const liveAcct = await route.readLivePositionHealth(collateralMint, params.accountVenuePositionId);
      const alreadySupplied = !!liveAcct && BigInt(liveAcct.collateralRaw) >= acctPosCollBefore + returnedRaw - COLL_DUST;
      if (!alreadySupplied) {
        await storage.updateBorrowOperation(op.id, { step: "resupplying" });
        const supply = await executeSupplyCollateral({
          walletAddress: params.walletAddress,
          agentPublicKey: params.accountPublicKey,
          agentSecretKey: params.accountSecretKey,
          collateralMint,
          collateralRaw: returnedRaw,
          borrowPositionId: params.accountBorrowPositionId,
          tradingBotId: null, // re-pledge into the ACCOUNT position (executor rejects a bot id).
        });
        if (!supply.success) {
          return failClosed(op, "resupply_failed", `${supply.error || "Re-pledge failed"}. Returned collateral is safe in the account wallet — retry to finish.`, true);
        }
        if (supply.signature) {
          await storage.updateBorrowOperation(op.id, { appendTxSignature: supply.signature, mergeMetadata: { resupplySig: supply.signature } });
        }
      }
      // Re-collateralisation done (the money-safety priority); advance to the
      // top-up SWEEP, which only returns account-owned USDC and never blocks the
      // re-pledge above.
      await storage.updateBorrowOperation(op.id, { step: "resupplied" });
      op = (await storage.getBorrowOperationById(op.id)) ?? op;
    }

    // ---- SWEEP (bot -> account USDC) leg: return the repay top-up ----------
    // Money-safety: NEVER sweep all the bot's USDC (it may hold trade proceeds or
    // spare funds). Cap the sweep at the recorded top-up; the bot keeps the rest.
    // The close consumed the true debt from the bot's OWN funds, so the cap also
    // protects any pre-existing bot USDC. A zero top-up (bot self-funded the
    // close) skips this leg.
    let sweptRaw = BigInt(readMeta(op).sweptRaw || "0");
    const swStep = op.step ?? "";
    if (swStep === "resupplied" || swStep === "sweeping" || swStep === "sweep_failed") {
      const topupRaw = BigInt(readMeta(op).topupRaw || "0");
      let recovered = false;
      if (swStep === "sweeping") {
        const meta = readMeta(op);
        if (meta.sweepSig) {
          const status = await reconcileSignature(meta.sweepSig, meta.sweepLvbh);
          if (status === "landed") {
            recovered = true;
            sweptRaw = BigInt(meta.sweepPlannedRaw || "0");
          } else if (status === "in_flight") {
            return failClosed(op, "sweeping", "The repay top-up sweep back to the account is still settling. Funds are safe in the bot wallet — retry in a moment.", true);
          }
          // reverted | expired -> dead tx; recompute + re-send below.
        }
      }
      if (!recovered) {
        if (topupRaw <= 0n) {
          sweptRaw = 0n; // bot self-funded the close; nothing to return.
        } else {
          let botUsdcNow: bigint;
          try {
            botUsdcNow = await strictBalanceRaw(params.botPublicKey, USDC_MINT);
          } catch {
            return failClosed(op, "sweep_failed", "Could not read the bot USDC balance to size the top-up sweep; the top-up is safe in the bot wallet — retry.", true);
          }
          // Return AT MOST the top-up (cap protects any pre-existing bot USDC).
          const sweep = botUsdcNow < topupRaw ? botUsdcNow : topupRaw;
          if (sweep > 0n) {
            await storage.updateBorrowOperation(op.id, { step: "sweeping", mergeMetadata: { sweepPlannedRaw: sweep.toString() } });
            const sw = await transferTokenToWalletExact({
              agentPublicKey: params.botPublicKey,
              agentSecretKey: params.botSecretKey,
              toWalletAddress: params.accountPublicKey,
              mint: USDC_MINT,
              amountRaw: sweep,
              onBeforeBroadcast: async ({ signature, lastValidBlockHeight }) => {
                await storage.updateBorrowOperation(op.id, {
                  mergeMetadata: { sweepSig: signature, sweepLvbh: lastValidBlockHeight },
                  appendTxSignature: signature,
                });
              },
            });
            if (!sw.success) {
              op = (await storage.getBorrowOperationById(op.id)) ?? op;
              const meta = readMeta(op);
              const sig = meta.sweepSig as string | undefined;
              if (!sig) return failClosed(op, "sweep_failed", sw.error || "The top-up sweep did not complete. Funds are safe in the bot wallet.", true);
              const status = await reconcileSignature(sig, meta.sweepLvbh);
              if (status === "in_flight") return failClosed(op, "sweeping", "The repay top-up sweep back to the account is still settling. Funds are safe in the bot wallet — retry in a moment.", true);
              if (status !== "landed") return failClosed(op, "sweep_failed", sw.error || "The top-up sweep did not complete. Funds are safe in the bot wallet.", true);
              // false-negative: it actually landed -> fall through.
            }
            sweptRaw = sweep;
          } else {
            sweptRaw = 0n;
          }
        }
      }
      await storage.updateBorrowOperation(op.id, { step: "swept", mergeMetadata: { sweptRaw: sweptRaw.toString() } });
      op = (await storage.getBorrowOperationById(op.id)) ?? op;
    }
    if (sweptRaw <= 0n) sweptRaw = BigInt(readMeta(op).sweptRaw || "0");

    return finalizeUnwind(op, returnedRaw, sweptRaw);
  });
}

async function finalizeUnwind(op: BorrowOperation, returnedRaw: bigint, sweptRaw: bigint = 0n): Promise<PerbotCarveResult> {
  const result: Meta = { restoredRaw: returnedRaw.toString(), sweptRaw: sweptRaw.toString() };
  await storage.updateBorrowOperation(op.id, { status: "succeeded", step: "final_read", result });
  const fresh = await storage.getBorrowOperationById(op.id);
  return {
    success: true,
    operationId: op.id,
    step: "final_read",
    restoredRaw: returnedRaw.toString(),
    sweptRaw: sweptRaw.toString(),
    signatures: ((fresh?.txSignatures ?? op.txSignatures) as string[] | null) ?? [],
  };
}

// ===========================================================================
// PER-BOT COLLATERAL TOP-UP op ("defend the loan")
// ===========================================================================
//
// Add collateral to an EXISTING per-bot borrow position, funded from the ACCOUNT
// agent wallet (server-signed, no Phantom). Unlike carve/open it borrows nothing
// and MINTS nothing — it only strengthens a live loan's health. Legs mirror the
// carve/open shape (a source money leg -> transfer account->bot -> supply into
// the bot position), swapping the account-position WITHDRAW for a SWAP when the
// chosen source asset is not the collateral mint:
//
//   perbot_collateral_topup:
//     [SWAP source -> collateral in the account wallet]  (skipped if source==collateral)
//       -> [SPL transfer account -> bot]
//       -> [supply into the bot's EXISTING position]
//
// Same money-safety contract as the carve/unwind orchestrators (see the file
// header): a DB-backed, idempotent, RESUMABLE state machine; every leg persists
// its step BEFORE it acts and its realised amount + signature AFTER; the SWAP and
// the SPL transfer are reconciled by their WRITE-AHEAD signature (never a bare
// balance, which reads stale in-flight); no active compensating revert — a leg
// failure stops at needs_attention with the funds in a RECOVERABLE wallet, and a
// retry FINISHES forward. The SWAP is ExactIn (spend the source, supply the
// realised collateral delta) — landing the loan APPROXIMATELY at the target is
// fine (radical simplicity; we only ever IMPROVE health). Serialises on a
// `perbot-topup:<wallet>:<reqId>` lock, distinct from the executor borrowLockKey
// taken by the supply leg (no re-entrant deadlock).

const TOPUP_DEFAULT_SLIPPAGE_BPS = 100;
const TOPUP_MAX_SLIPPAGE_BPS = 500;

function clampTopupSlippage(bps?: number): number {
  if (typeof bps !== "number" || !Number.isFinite(bps) || bps <= 0) return TOPUP_DEFAULT_SLIPPAGE_BPS;
  return Math.min(Math.round(bps), TOPUP_MAX_SLIPPAGE_BPS);
}

export interface PerbotCollateralTopUpParams {
  walletAddress: string;
  vault: BorrowVaultConfig;
  /** Account agent: signs the swap + the account->bot transfer + funds bot gas. */
  accountPublicKey: string;
  accountSecretKey: Uint8Array;
  /** Bot agent: signs the supply into its OWN position. */
  botPublicKey: string;
  botSecretKey: Uint8Array;
  tradingBotId: string;
  /** The bot's EXISTING borrow position to add collateral to (DB id + nft id). */
  botBorrowPositionId: string;
  botVenuePositionId: number;
  /** The account-wallet asset to fund from (== collateral mint => no swap). */
  sourceMint: string;
  /** How much of the source asset to spend, raw. Capped at the live held balance. */
  sourceAmountRaw: bigint;
  /** Swap slippage (only used when sourceMint != collateral mint). */
  slippageBps?: number;
  clientRequestId: string;
  /**
   * TRUE only when the autonomous scanner created this op (never the manual Add
   * Collateral route). Stamped into op metadata so the resume selector can prove
   * an unfinished op is safe for the auto path to finish — see
   * `selectResumableTopUpOp`. Server-set only; not client-forwardable.
   */
  autoTopup?: boolean;
}

export interface PerbotTopUpResult {
  success: boolean;
  operationId?: string;
  step?: string;
  needsAttention?: boolean;
  borrowPositionId?: string;
  /** Collateral supplied into the bot position, raw (the transferred amount). */
  suppliedRaw?: string;
  /** Authoritative on-chain collateral total after the supply, raw. */
  observedCollateralRaw?: string;
  collateralValueUsd?: number | null;
  /** Every on-chain signature this op produced, oldest first. */
  signatures?: string[];
  error?: string;
}

async function failTopup(
  op: BorrowOperation,
  step: string,
  error: string,
  needsAttention: boolean,
): Promise<PerbotTopUpResult> {
  await storage.updateBorrowOperation(op.id, { status: needsAttention ? "needs_attention" : "failed", step, error });
  return { success: false, operationId: op.id, step, error, needsAttention };
}

async function finalizeTopup(
  op: BorrowOperation,
  r: { borrowPositionId: string; suppliedRaw?: string; observedCollateralRaw?: string; collateralValueUsd?: number | null },
): Promise<PerbotTopUpResult> {
  const result: Meta = {
    borrowPositionId: r.borrowPositionId,
    suppliedRaw: r.suppliedRaw,
    observedCollateralRaw: r.observedCollateralRaw,
    collateralValueUsd: r.collateralValueUsd ?? null,
  };
  await storage.updateBorrowOperation(op.id, { status: "succeeded", step: "final_read", borrowPositionId: r.borrowPositionId, result });
  const fresh = await storage.getBorrowOperationById(op.id);
  return {
    success: true,
    operationId: op.id,
    step: "final_read",
    borrowPositionId: r.borrowPositionId,
    suppliedRaw: r.suppliedRaw,
    observedCollateralRaw: r.observedCollateralRaw,
    collateralValueUsd: r.collateralValueUsd ?? null,
    signatures: ((fresh?.txSignatures ?? op.txSignatures) as string[] | null) ?? [],
  };
}

export async function runPerbotCollateralTopUp(params: PerbotCollateralTopUpParams): Promise<PerbotTopUpResult> {
  if (params.sourceAmountRaw <= 0n) return { success: false, error: "Top-up amount must be greater than zero." };

  const collateralMint = params.vault.collateralMint;
  const slippageBps = clampTopupSlippage(params.slippageBps);
  const isSwap = params.sourceMint !== collateralMint;
  const route = new JupiterLendBorrowRoute();

  return withBorrowLock(`perbot-topup:${params.walletAddress}:${params.clientRequestId}`, async () => {
    let op = await resolveOrCreateOp({
      walletAddress: params.walletAddress,
      borrowPositionId: params.botBorrowPositionId,
      clientRequestId: params.clientRequestId,
      operationType: "perbot_collateral_topup",
      metadata: {
        tradingBotId: params.tradingBotId,
        collateralMint,
        botBorrowPositionId: params.botBorrowPositionId,
        botVenuePositionId: params.botVenuePositionId,
        sourceMint: params.sourceMint,
        sourceAmountRaw: params.sourceAmountRaw.toString(),
        botPublicKey: params.botPublicKey,
        accountPublicKey: params.accountPublicKey,
        autoTopup: params.autoTopup === true,
      },
    });
    // Refuse to resume a same-reqId op that was started with different inputs.
    const idMismatch = validateOpIdentity(op, "perbot_collateral_topup", {
      tradingBotId: params.tradingBotId,
      collateralMint,
      botBorrowPositionId: params.botBorrowPositionId,
      botVenuePositionId: params.botVenuePositionId,
      sourceMint: params.sourceMint,
      sourceAmountRaw: params.sourceAmountRaw.toString(),
    });
    if (idMismatch) return { success: false, operationId: op.id, step: op.step ?? undefined, error: idMismatch, needsAttention: false };
    if (op.status === "succeeded") {
      const r = (op.result as Meta | null) ?? {};
      return {
        success: true,
        operationId: op.id,
        step: op.step ?? "final_read",
        borrowPositionId: r.borrowPositionId ?? params.botBorrowPositionId,
        suppliedRaw: r.suppliedRaw,
        observedCollateralRaw: r.observedCollateralRaw,
        collateralValueUsd: r.collateralValueUsd ?? null,
        signatures: (op.txSignatures as string[] | null) ?? [],
      };
    }

    // collateralInAccountRaw = the collateral now sitting in the ACCOUNT wallet,
    // ready to transfer to the bot (the realised swap output, or — when the source
    // IS the collateral — the capped held amount). Loaded from the breadcrumb on
    // a resume that is already at/after the swap step.
    let collateralInAccountRaw = BigInt(readMeta(op).collateralInAccountRaw || "0");

    // ---- SWAP leg (account wallet; only when source != collateral) ----------
    // The swap OUTPUT is not amount-exact, so it can NEVER be blindly re-broadcast
    // (a double-swap spends the source twice). Resume authority is the write-ahead
    // signature reconciled by status + the realised delta vs a persisted baseline.
    const sStep = op.step ?? "";
    if (isSwap && (sStep === "initialized" || sStep === "swap_failed" || sStep === "swapping")) {
      const meta = readMeta(op);
      const recordedSig = meta.swapSig as string | undefined;
      const status = recordedSig ? await reconcileSignature(recordedSig, meta.swapLvbh) : null;
      let currentOutBalanceRaw: bigint | null = null;
      if (recordedSig) {
        try { currentOutBalanceRaw = await strictBalanceRaw(params.accountPublicKey, collateralMint); }
        catch { currentOutBalanceRaw = null; }
      }
      const decision = decideSwapResume({
        recordedSig,
        status,
        swapOutBeforeRaw: meta.swapOutBeforeRaw ?? null,
        currentOutBalanceRaw,
      });

      if (decision.action === "stop_in_flight") {
        return failTopup(op, "swapping", "The swap to the collateral asset is still settling. Your funds are safe in the account wallet — retry in a moment.", true);
      }
      if (decision.action === "stop_needs_attention") {
        return failTopup(op, "swap_failed", decision.reason, true);
      }
      if (decision.action === "use_realized") {
        collateralInAccountRaw = decision.realizedRaw;
        await storage.updateBorrowOperation(op.id, { step: "swapped", mergeMetadata: { collateralInAccountRaw: collateralInAccountRaw.toString() } });
        op = (await storage.getBorrowOperationById(op.id)) ?? op;
      } else {
        // execute_swap | retry_swap: provably nothing is live, a fresh swap is safe.
        // Cap the swap input at the live held source balance (never sweep more).
        let heldSource: bigint;
        try { heldSource = await strictBalanceRaw(params.accountPublicKey, params.sourceMint); }
        catch { return failTopup(op, "swap_failed", "Could not read the source balance to swap; nothing was changed.", true); }
        const inputRaw = heldSource < params.sourceAmountRaw ? heldSource : params.sourceAmountRaw;
        if (inputRaw <= 0n) return failTopup(op, "swap_failed", "Not enough of the selected asset in the account wallet to fund the top-up.", true);

        // Persist the pre-swap collateral BASELINE before broadcasting so a crash
        // reconciles the realised delta (decideSwapResume), never a bare balance.
        let outBefore: bigint;
        try { outBefore = await strictBalanceRaw(params.accountPublicKey, collateralMint); }
        catch { return failTopup(op, "swap_failed", "Could not read the account collateral balance; nothing was changed.", true); }
        await storage.updateBorrowOperation(op.id, { step: "swapping", mergeMetadata: { swapOutBeforeRaw: outBefore.toString() } });

        const swap = await executeAgentSwap({
          agentPublicKey: params.accountPublicKey,
          agentSecretKey: params.accountSecretKey,
          inputMint: params.sourceMint,
          outputMint: collateralMint,
          amountRaw: inputRaw.toString(),
          slippageBps,
          onBeforeBroadcast: async ({ signature, lastValidBlockHeight }) => {
            await storage.updateBorrowOperation(op.id, {
              // lvbh 0 == "unknown" (provider-built tx): omit it so a reconcile
              // never falsely expires an in-flight swap (=> double-swap).
              mergeMetadata: { swapSig: signature, ...(lastValidBlockHeight > 0 ? { swapLvbh: lastValidBlockHeight } : {}) },
              appendTxSignature: signature,
            });
          },
        });
        if (!swap.success || !swap.outputReceivedRaw || BigInt(swap.outputReceivedRaw) <= 0n) {
          // The write-ahead sig may have actually landed (false negative).
          op = (await storage.getBorrowOperationById(op.id)) ?? op;
          const m2 = readMeta(op);
          const sig2 = m2.swapSig as string | undefined;
          if (sig2) {
            const st2 = await reconcileSignature(sig2, m2.swapLvbh);
            if (st2 === "in_flight") return failTopup(op, "swapping", "The swap is still settling. Your funds are safe in the account wallet — retry in a moment.", true);
            if (st2 === "landed") {
              let nowOut: bigint | null;
              try { nowOut = await strictBalanceRaw(params.accountPublicKey, collateralMint); } catch { nowOut = null; }
              const d2 = decideSwapResume({ recordedSig: sig2, status: "landed", swapOutBeforeRaw: m2.swapOutBeforeRaw ?? null, currentOutBalanceRaw: nowOut });
              if (d2.action !== "use_realized") {
                return failTopup(op, "swap_failed", d2.action === "stop_needs_attention" ? d2.reason : "The swap could not be reconciled. Your funds are safe in the account wallet.", true);
              }
              collateralInAccountRaw = d2.realizedRaw;
              await storage.updateBorrowOperation(op.id, { step: "swapped", mergeMetadata: { collateralInAccountRaw: collateralInAccountRaw.toString() } });
              op = (await storage.getBorrowOperationById(op.id)) ?? op;
            } else {
              return failTopup(op, "swap_failed", swap.error || "The swap to the collateral asset did not complete. Your funds are safe in the account wallet.", true);
            }
          } else {
            return failTopup(op, "swap_failed", swap.error || "The swap to the collateral asset did not complete. Your funds are safe in the account wallet.", true);
          }
        } else {
          collateralInAccountRaw = BigInt(swap.outputReceivedRaw);
          await storage.updateBorrowOperation(op.id, { step: "swapped", mergeMetadata: { collateralInAccountRaw: collateralInAccountRaw.toString() } });
          op = (await storage.getBorrowOperationById(op.id)) ?? op;
        }
      }
    } else if (!isSwap && sStep === "initialized") {
      // Source IS the collateral: no swap. The collateral to move is the requested
      // amount, capped at the live held balance (never sweep more than intended).
      let heldCol: bigint;
      try { heldCol = await strictBalanceRaw(params.accountPublicKey, collateralMint); }
      catch { return failTopup(op, "swap_failed", "Could not read the account collateral balance; nothing was changed.", true); }
      collateralInAccountRaw = heldCol < params.sourceAmountRaw ? heldCol : params.sourceAmountRaw;
      if (collateralInAccountRaw <= 0n) return failTopup(op, "swap_failed", "Not enough collateral in the account wallet to fund the top-up.", true);
      await storage.updateBorrowOperation(op.id, { step: "swapped", mergeMetadata: { collateralInAccountRaw: collateralInAccountRaw.toString() } });
      op = (await storage.getBorrowOperationById(op.id)) ?? op;
    }

    // ---- TRANSFER (account -> bot) leg ------------------------------------
    // AMOUNT-EXACT: move EXACTLY the intended collateral (persisted at the swap
    // step), CAPPED at the live strict wallet balance — so a stuck op can never
    // move more than is held, and we never sweep unrelated funds. Reconciled by
    // the write-ahead transfer signature (balance reads 0 while in-flight).
    const tStep = op.step ?? "";
    if (tStep === "swapped" || tStep === "transferring" || tStep === "transfer_failed") {
      let recovered = false;
      if (tStep === "transferring") {
        const meta = readMeta(op);
        if (meta.transferSig) {
          const s = await reconcileSignature(meta.transferSig, meta.transferLvbh);
          if (s === "landed") recovered = true;
          else if (s === "in_flight") return failTopup(op, "transferring", "The transfer to the bot is still settling. Your funds are safe in the account wallet — retry in a moment.", true);
        }
      }
      if (!recovered) {
        const intended = BigInt(readMeta(op).collateralInAccountRaw || collateralInAccountRaw.toString());
        let held: bigint;
        try { held = await strictBalanceRaw(params.accountPublicKey, collateralMint); }
        catch (e: any) { return failTopup(op, "transfer_failed", `Could not read the collateral in the account wallet (${e?.message || e}). Funds are safe in the account wallet — retry in a moment.`, true); }
        const moveRaw = held < intended ? held : intended;
        if (moveRaw <= 0n) return failTopup(op, "transfer_failed", "No collateral is in the account wallet to move to the bot. Retry in a moment.", true);
        await storage.updateBorrowOperation(op.id, { step: "transferring", mergeMetadata: { transferRaw: moveRaw.toString() } });
        const xfer = await transferTokenToWalletExact({
          agentPublicKey: params.accountPublicKey,
          agentSecretKey: params.accountSecretKey,
          toWalletAddress: params.botPublicKey,
          mint: collateralMint,
          amountRaw: moveRaw,
          onBeforeBroadcast: async ({ signature, lastValidBlockHeight }) => {
            await storage.updateBorrowOperation(op.id, {
              mergeMetadata: { transferSig: signature, transferLvbh: lastValidBlockHeight },
              appendTxSignature: signature,
            });
          },
        });
        if (!xfer.success) {
          op = (await storage.getBorrowOperationById(op.id)) ?? op;
          const meta = readMeta(op);
          const sig = meta.transferSig as string | undefined;
          if (!sig) return failTopup(op, "transfer_failed", xfer.error || "The transfer to the bot did not complete. Funds are safe in the account wallet.", true);
          const s = await reconcileSignature(sig, meta.transferLvbh);
          if (s === "in_flight") return failTopup(op, "transferring", "The transfer to the bot is still settling. Funds are safe in the account wallet — retry in a moment.", true);
          if (s !== "landed") return failTopup(op, "transfer_failed", xfer.error || "The transfer to the bot did not complete. Funds are safe in the account wallet.", true);
        }
      }
      await storage.updateBorrowOperation(op.id, { step: "transferred_to_bot" });
      op = (await storage.getBorrowOperationById(op.id)) ?? op;
    }

    // ---- SUPPLY (into the bot's EXISTING position) leg --------------------
    // Terminal leg. supplyToExistingBotPosition is bot-signed, confirm-only (no
    // positive delta), proves itself from an AUTHORITATIVE position re-read, and
    // fails CLOSED on the dangerous direction. It never mints. On resume the
    // write-ahead supply signature is the authority: landed => finalise (the
    // collateral is IN the position); in_flight => wait; reverted/expired => the
    // collateral is still in the BOT wallet, re-supply forward.
    const supStep = op.step ?? "";
    if (supStep === "transferred_to_bot" || supStep === "supplying" || supStep === "supply_failed") {
      const meta = readMeta(op);
      const supplySig = meta.supplySig as string | undefined;
      if (supplySig) {
        const s = await reconcileSignature(supplySig, meta.supplyLvbh);
        if (s === "in_flight") return failTopup(op, "supplying", "Adding the collateral is still settling. Your funds are safe in the bot wallet — retry in a moment.", true);
        if (s === "landed") {
          const live = await route.readLivePositionHealth(collateralMint, params.botVenuePositionId);
          return finalizeTopup(op, { borrowPositionId: params.botBorrowPositionId, suppliedRaw: meta.transferRaw, observedCollateralRaw: live?.collateralRaw });
        }
        // reverted | expired: nothing committed -> re-supply below.
      }
      await storage.updateBorrowOperation(op.id, { step: "supplying" });
      const supply = await supplyToExistingBotPosition({
        walletAddress: params.walletAddress,
        tradingBotId: params.tradingBotId,
        botPublicKey: params.botPublicKey,
        botSecretKey: params.botSecretKey,
        accountPublicKey: params.accountPublicKey,
        accountSecretKey: params.accountSecretKey,
        collateralMint,
        borrowPositionId: params.botBorrowPositionId,
        collateralRaw: BigInt(readMeta(op).transferRaw || collateralInAccountRaw.toString()),
        onBeforeBroadcast: async ({ signature, lastValidBlockHeight }) => {
          await storage.updateBorrowOperation(op.id, {
            mergeMetadata: { supplySig: signature, supplyLvbh: lastValidBlockHeight },
            appendTxSignature: signature,
          });
        },
      });
      if (!supply.success) {
        // The supply sig may have actually landed (false negative).
        op = (await storage.getBorrowOperationById(op.id)) ?? op;
        const m3 = readMeta(op);
        const sig3 = m3.supplySig as string | undefined;
        if (sig3) {
          const st3 = await reconcileSignature(sig3, m3.supplyLvbh);
          if (st3 === "in_flight") return failTopup(op, "supplying", "Adding the collateral is still settling. Your funds are safe in the bot wallet — retry in a moment.", true);
          if (st3 === "landed") {
            const live = await route.readLivePositionHealth(collateralMint, params.botVenuePositionId);
            return finalizeTopup(op, { borrowPositionId: params.botBorrowPositionId, suppliedRaw: m3.transferRaw, observedCollateralRaw: live?.collateralRaw });
          }
        }
        // Nothing committed: the collateral is safe in the BOT wallet; retry re-supplies.
        return failTopup(op, "supply_failed", `${supply.error || "Adding the collateral failed"}. Your funds are safe in the bot wallet.`, true);
      }
      return finalizeTopup(op, {
        borrowPositionId: params.botBorrowPositionId,
        suppliedRaw: readMeta(op).transferRaw,
        observedCollateralRaw: supply.observedCollateralRaw,
        collateralValueUsd: supply.collateralValueUsd,
      });
    }

    // Unexpected/stale step -> fail closed for inspection (funds are recoverable).
    return failTopup(op, op.step ?? "unknown", "The top-up is in an unexpected state; your funds are safe — please retry.", true);
  });
}

// ===========================================================================
// GROW LOAN op (carve MORE collateral + borrow MORE USDC into an EXISTING bot
// position). Symmetric to CARVE/OPEN, but the terminal legs target the bot's
// ALREADY-OPEN position instead of minting a fresh one: withdraw `carveRaw` MORE
// out of the account position (re-gated at `targetLtv` pre-sign, post-withdraw
// on-chain LTV assertion) -> transfer it to the bot wallet -> SUPPLY it into the
// bot's own position -> BORROW MORE USDC against it. Fully resumable: no confirmed
// leg is ever re-run (write-ahead signatures reconciled by on-chain status).
// ===========================================================================

export interface PerbotGrowLoanParams {
  walletAddress: string;
  vault: BorrowVaultConfig;
  /** Account agent: signs the withdraw + the carve transfer + funds the bot's gas. */
  accountPublicKey: string;
  accountSecretKey: Uint8Array;
  /** Bot agent: signs the supply + the borrow; receives the carved collateral + borrowed USDC. */
  botPublicKey: string;
  botSecretKey: Uint8Array;
  tradingBotId: string;
  /**
   * Account borrow position to carve MORE FROM (DB id + on-chain nft id).
   * null ⇔ zero-carve grow (carveRaw=0n, mode "grow" only): the borrow rides the
   * bot loan's OWN headroom, no account carve legs run, so no account position
   * is required (the owner may not even have one).
   */
  accountBorrowPositionId: string | null;
  accountVenuePositionId: number | null;
  /** EXISTING open bot borrow position to grow (DB id + on-chain nft id). */
  botBorrowPositionId: string;
  botVenuePositionId: number;
  /** ADDITIONAL collateral to carve, raw (already validated <= cap by the planner).
   *  0n is allowed in mode "grow" ONLY: skip carve/transfer/supply, borrow-only. */
  carveRaw: bigint;
  /** ADDITIONAL USDC to borrow into the bot position, raw. */
  requestedDebtRaw: bigint;
  /** Resolved + clamped target LTV (drives the ACCOUNT-side pre-sign re-gate). */
  targetLtv: number;
  clientRequestId: string;
  /**
   * "grow" (default): carve → transfer → supply → BORROW more USDC.
   * "add_collateral": same carve/transfer/supply legs but NO borrow leg —
   * requestedDebtRaw MUST be 0n. Runs under a DISTINCT operationType
   * ("perbot_carve_topup") + lock prefix so a same-reqId replay can never
   * mutate between modes (validateOpIdentity refuses cross-type resume).
   */
  mode?: "grow" | "add_collateral";
}

export async function runPerbotGrowLoan(params: PerbotGrowLoanParams): Promise<PerbotCarveResult> {
  const mode = params.mode ?? "grow";
  // carveRaw = 0 is allowed in mode "grow" ONLY: "borrow purely against the bot
  // loan's own headroom" — the carve/transfer/supply legs are skipped and the op
  // starts directly at the borrow leg. add_collateral MUST still carve (> 0).
  if (params.carveRaw < 0n) return { success: false, error: "Carve amount must not be negative." };
  if (mode === "add_collateral" && params.carveRaw <= 0n) return { success: false, error: "Carve amount must be greater than zero." };
  const zeroCarve = mode === "grow" && params.carveRaw === 0n;
  if (!zeroCarve && (params.accountBorrowPositionId == null || params.accountVenuePositionId == null)) {
    return { success: false, error: "Account borrow position required for a carve-backed grow." };
  }
  if (mode === "grow" && params.requestedDebtRaw <= 0n) return { success: false, error: "Borrow amount must be greater than zero." };
  // Add-collateral NEVER borrows: pin the debt to exactly 0 so the identity check
  // (requestedDebtRaw "0") + the skipped borrow leg can't disagree.
  if (mode === "add_collateral" && params.requestedDebtRaw !== 0n) {
    return { success: false, error: "Add-collateral must not borrow (requestedDebtRaw must be zero)." };
  }
  // NOTE: NOT "perbot_collateral_topup" — auto-topup's selectResumableTopUpOp
  // filters on that exact type; this manual carve top-up must stay invisible to it.
  const operationType = mode === "add_collateral" ? "perbot_carve_topup" : "perbot_grow_loan";
  const lockPrefix = mode === "add_collateral" ? "perbot-carve-topup" : "perbot-grow";

  const collateralMint = params.vault.collateralMint;
  const route = new JupiterLendBorrowRoute();

  return withBorrowLock(`${lockPrefix}:${params.walletAddress}:${params.clientRequestId}`, async () => {
    let op = await resolveOrCreateOp({
      walletAddress: params.walletAddress,
      borrowPositionId: params.botBorrowPositionId,
      clientRequestId: params.clientRequestId,
      operationType,
      metadata: {
        tradingBotId: params.tradingBotId,
        collateralMint,
        // Zero-carve ops have NO account position; omit the keys entirely (a
        // cross-shape replay under the same reqId still fails identity on carveRaw).
        ...(zeroCarve
          ? {}
          : {
              accountBorrowPositionId: params.accountBorrowPositionId!,
              accountVenuePositionId: params.accountVenuePositionId!,
            }),
        botBorrowPositionId: params.botBorrowPositionId,
        botVenuePositionId: params.botVenuePositionId,
        carveRaw: params.carveRaw.toString(),
        requestedDebtRaw: params.requestedDebtRaw.toString(),
        targetLtv: params.targetLtv,
        botPublicKey: params.botPublicKey,
        accountPublicKey: params.accountPublicKey,
      },
    });
    // Refuse to resume a same-reqId op that was started with different inputs.
    const idMismatch = validateOpIdentity(op, operationType, {
      tradingBotId: params.tradingBotId,
      collateralMint,
      ...(zeroCarve
        ? {}
        : {
            accountBorrowPositionId: params.accountBorrowPositionId!,
            accountVenuePositionId: params.accountVenuePositionId!,
          }),
      botBorrowPositionId: params.botBorrowPositionId,
      botVenuePositionId: params.botVenuePositionId,
      carveRaw: params.carveRaw.toString(),
      requestedDebtRaw: params.requestedDebtRaw.toString(),
      targetLtv: params.targetLtv,
    });
    if (idMismatch) return { success: false, operationId: op.id, step: op.step ?? undefined, error: idMismatch, needsAttention: false };
    if (op.status === "succeeded") {
      const r = (op.result as Meta | null) ?? {};
      return {
        success: true,
        operationId: op.id,
        step: op.step ?? "final_read",
        borrowPositionId: r.borrowPositionId ?? params.botBorrowPositionId,
        carvedRaw: r.carvedRaw,
        accountPostLtv: r.accountPostLtv ?? null,
        borrowedUsdcRaw: r.borrowedUsdcRaw,
        signatures: (op.txSignatures as string[] | null) ?? [],
      };
    }

    // ---- ZERO-CARVE grow: nothing to withdraw/transfer/supply — the bot's
    // existing collateral already backs the extra borrow. Advance a FRESH op
    // straight to the borrow leg (idempotent: a resume already at/after
    // supplied_to_bot passes through untouched; the identity check above pins
    // carveRaw "0" so a same-reqId replay can never re-size it into a carve).
    if (zeroCarve && (op.step ?? "initialized") === "initialized") {
      await storage.updateBorrowOperation(op.id, { step: "supplied_to_bot" });
      op = (await storage.getBorrowOperationById(op.id)) ?? op;
    }

    // ---- WITHDRAW (carve MORE) leg ---------------------------------------
    // Account-position withdraw is AMOUNT-EXACT and pulls from the position
    // (which keeps the collateral until the tx lands), so a blind re-broadcast
    // double-withdraws. Resume authority is the write-ahead signature reconciled
    // by status — never the agent balance (reads 0 while in-flight).
    let carvedRaw = BigInt(readMeta(op).carvedRawObserved || "0");
    const wStep = op.step ?? "";
    if (wStep === "initialized" || wStep === "withdraw_failed" || wStep === "withdrawing") {
      let recovered = false;
      if (wStep === "withdrawing") {
        const meta = readMeta(op);
        if (meta.withdrawSig) {
          const status = await reconcileSignature(meta.withdrawSig, meta.withdrawLvbh);
          if (status === "landed") recovered = true;
          else if (status === "in_flight") return failClosed(op, "withdrawing", "The collateral carve is still settling. Funds are safe in the account position — retry in a moment.", true);
          // reverted | expired -> dead tx, re-withdraw safely below.
        }
      }
      if (!recovered) {
        // PRE-SIGN RE-GATE: re-read live account health + oracle and re-run the
        // EXACT-amount target-LTV gate immediately before signing. Nothing has
        // moved yet, so a deny here is RESTARTABLE.
        const oracle = await readBorrowOracleContext(params.vault);
        const liveBefore = await route.readLivePositionHealth(collateralMint, params.accountVenuePositionId!);
        if (!liveBefore) return failClosed(op, "withdraw_failed", "Could not read the live account position; refusing to carve.", false);
        const gate = evaluateCollateralWithdraw({
          vault: params.vault,
          liveCollateralRaw: BigInt(liveBefore.collateralRaw),
          liveDebtRaw: BigInt(liveBefore.debtRaw),
          requestedWithdrawRaw: params.carveRaw,
          oracle,
          targetMaxLtv: params.targetLtv,
        });
        if (!gate.allowed) {
          const deny = gate.reasons.find((r) => r.severity === "deny");
          return failClosed(op, "withdraw_failed", deny?.message || "Carve is not allowed under the target LTV.", false);
        }

        await storage.updateBorrowOperation(op.id, { step: "withdrawing" });
        const w = await executeWithdrawCollateral({
          walletAddress: params.walletAddress,
          agentPublicKey: params.accountPublicKey,
          agentSecretKey: params.accountSecretKey,
          borrowPositionId: params.accountBorrowPositionId!,
          amount: params.carveRaw,
          deliverToUserWallet: false, // STAY in the account agent wallet for the carve transfer.
          onBeforeBroadcast: async ({ signature, lastValidBlockHeight }) => {
            await storage.updateBorrowOperation(op.id, {
              mergeMetadata: { withdrawSig: signature, withdrawLvbh: lastValidBlockHeight },
              appendTxSignature: signature,
            });
          },
        });
        if (!w.success) {
          op = (await storage.getBorrowOperationById(op.id)) ?? op;
          const meta = readMeta(op);
          const sig = meta.withdrawSig as string | undefined;
          if (!sig) return failClosed(op, "withdraw_failed", w.error || "The collateral carve did not complete.", false);
          const status = await reconcileSignature(sig, meta.withdrawLvbh);
          if (status === "in_flight") return failClosed(op, "withdrawing", "The collateral carve is still settling. Funds are safe in the account position — retry in a moment.", true);
          if (status !== "landed") return failClosed(op, "withdraw_failed", w.error || "The collateral carve did not complete.", false);
          // false-negative: it actually landed -> fall through and record.
        }
        // The realised withdrawn amount is the EXACT carve (amount-exact withdraw);
        // NEVER w.observedCollateralRaw (that is the post-withdraw REMAINING stake).
        carvedRaw = params.carveRaw;
      } else {
        // Recovered on resume; the withdraw already landed at the ORIGINAL amount-exact
        // carve (persisted at op creation as metadata.carveRaw), not a re-measured balance.
        carvedRaw = BigInt(readMeta(op).carveRaw || params.carveRaw.toString());
      }

      // POST-WITHDRAW on-chain assertion: the account must now sit at <= target.
      const liveAfter = await route.readLivePositionHealth(collateralMint, params.accountVenuePositionId!);
      if (!liveAfter) return failClosed(op, "account_withdrawn", "Carve landed but the account position is unreadable; funds are in the account wallet — reconcile before continuing.", true);
      const postLtv = computeLtv(
        BigInt(liveAfter.collateralRaw),
        BigInt(liveAfter.debtRaw),
        params.vault.collateralDecimals,
        params.vault.debtDecimals,
        liveAfter.oraclePriceUsd,
      );
      if (postLtv === null || postLtv > params.targetLtv + LTV_ASSERT_EPSILON) {
        return failClosed(op, "account_withdrawn", `Account post-carve LTV (${postLtv === null ? "unreadable" : postLtv.toFixed(4)}) exceeds the target (${params.targetLtv}). Carved collateral is in the account wallet — re-supply it before continuing.`, true);
      }
      await storage.updateBorrowOperation(op.id, {
        step: "account_withdrawn",
        mergeMetadata: { carvedRawObserved: carvedRaw.toString(), accountPostLtv: postLtv },
      });
      op = (await storage.getBorrowOperationById(op.id)) ?? op;
    }

    if (carvedRaw <= 0n) carvedRaw = BigInt(readMeta(op).carvedRawObserved || "0");
    // Zero-carve grows legitimately have carvedRaw = 0 (no withdraw ever ran).
    if (!zeroCarve && carvedRaw <= 0n) return failClosed(op, "account_withdrawn", "Carved amount is zero after the withdraw; nothing to carve.", true);

    // ---- TRANSFER (account -> bot) leg -----------------------------------
    const tStep = op.step ?? "";
    if (tStep === "account_withdrawn" || tStep === "carving" || tStep === "carve_failed") {
      let recovered = false;
      if (tStep === "carving") {
        const meta = readMeta(op);
        if (meta.carveSig) {
          const status = await reconcileSignature(meta.carveSig, meta.carveLvbh);
          if (status === "landed") recovered = true;
          else if (status === "in_flight") return failClosed(op, "carving", "The carve transfer to the bot is still settling. Funds are safe in the account wallet — retry in a moment.", true);
        }
      }
      if (!recovered) {
        // AMOUNT-EXACT: the withdraw un-pledged exactly the ORIGINAL requested carve
        // (metadata.carveRaw, immutable). Re-derive here from that value CAPPED at the
        // live strict wallet balance — never the position "remaining" reading, never
        // params.carveRaw (a resume may re-size it). Cap = requested, floor = held.
        const intendedCarveRaw = BigInt(readMeta(op).carveRaw || params.carveRaw.toString());
        let heldRaw: bigint;
        try {
          heldRaw = await strictBalanceRaw(params.accountPublicKey, collateralMint);
        } catch (e: any) {
          return failClosed(op, "carve_failed", `Could not read the carved collateral in the account wallet (${e?.message || e}). Funds are safe in the account wallet — retry in a moment.`, true);
        }
        carvedRaw = heldRaw < intendedCarveRaw ? heldRaw : intendedCarveRaw;
        if (carvedRaw <= 0n) {
          return failClosed(op, "carve_failed", "No carved collateral is in the account wallet to move to the bot. Funds are safe in the account position — retry in a moment.", true);
        }
        // Persist the TRUE carved amount BEFORE the broadcast so a crash mid-transfer
        // resumes with the right number (the supply leg supplies exactly this).
        await storage.updateBorrowOperation(op.id, { step: "carving", mergeMetadata: { carvedRawObserved: carvedRaw.toString() } });
        const xfer = await transferTokenToWalletExact({
          agentPublicKey: params.accountPublicKey,
          agentSecretKey: params.accountSecretKey,
          toWalletAddress: params.botPublicKey,
          mint: collateralMint,
          amountRaw: carvedRaw,
          onBeforeBroadcast: async ({ signature, lastValidBlockHeight }) => {
            await storage.updateBorrowOperation(op.id, {
              mergeMetadata: { carveSig: signature, carveLvbh: lastValidBlockHeight },
              appendTxSignature: signature,
            });
          },
        });
        if (!xfer.success) {
          op = (await storage.getBorrowOperationById(op.id)) ?? op;
          const meta = readMeta(op);
          const sig = meta.carveSig as string | undefined;
          if (!sig) return failClosed(op, "carve_failed", xfer.error || "The carve transfer to the bot did not complete. Funds are safe in the account wallet.", true);
          const status = await reconcileSignature(sig, meta.carveLvbh);
          if (status === "in_flight") return failClosed(op, "carving", "The carve transfer to the bot is still settling. Funds are safe in the account wallet — retry in a moment.", true);
          if (status !== "landed") return failClosed(op, "carve_failed", xfer.error || "The carve transfer to the bot did not complete. Funds are safe in the account wallet.", true);
        }
      }
      await storage.updateBorrowOperation(op.id, { step: "carved_to_bot" });
      op = (await storage.getBorrowOperationById(op.id)) ?? op;
    }

    // ---- SUPPLY (into the bot's EXISTING position) leg --------------------
    // NON-terminal (borrow-more follows). supplyToExistingBotPosition is bot-signed,
    // confirm-only, proves itself from an AUTHORITATIVE position re-read, fails
    // CLOSED on the dangerous direction, and never mints. On resume the write-ahead
    // supply signature is the authority: landed => advance (collateral is IN the
    // position); in_flight => wait; reverted/expired => collateral is still in the
    // BOT wallet, re-supply forward.
    const supStep = op.step ?? "";
    if (supStep === "carved_to_bot" || supStep === "supplying" || supStep === "supply_failed") {
      const meta = readMeta(op);
      const supplySig = meta.supplySig as string | undefined;
      let recovered = false;
      if (supplySig) {
        const s = await reconcileSignature(supplySig, meta.supplyLvbh);
        if (s === "in_flight") return failClosed(op, "supplying", "Adding the carved collateral is still settling. Your funds are safe in the bot wallet — retry in a moment.", true);
        if (s === "landed") recovered = true;
        // reverted | expired: nothing committed -> re-supply below.
      }
      if (!recovered) {
        const supplyRaw = BigInt(readMeta(op).carvedRawObserved || carvedRaw.toString());
        if (supplyRaw <= 0n) return failClosed(op, "supply_failed", "No carved collateral recorded to supply into the bot position; your funds are safe in the bot wallet — retry in a moment.", true);
        await storage.updateBorrowOperation(op.id, { step: "supplying" });
        const supply = await supplyToExistingBotPosition({
          walletAddress: params.walletAddress,
          tradingBotId: params.tradingBotId,
          botPublicKey: params.botPublicKey,
          botSecretKey: params.botSecretKey,
          accountPublicKey: params.accountPublicKey,
          accountSecretKey: params.accountSecretKey,
          collateralMint,
          borrowPositionId: params.botBorrowPositionId,
          collateralRaw: supplyRaw,
          onBeforeBroadcast: async ({ signature, lastValidBlockHeight }) => {
            await storage.updateBorrowOperation(op.id, {
              mergeMetadata: { supplySig: signature, supplyLvbh: lastValidBlockHeight },
              appendTxSignature: signature,
            });
          },
        });
        if (!supply.success) {
          // The supply sig may have actually landed (false negative).
          op = (await storage.getBorrowOperationById(op.id)) ?? op;
          const m3 = readMeta(op);
          const sig3 = m3.supplySig as string | undefined;
          if (sig3) {
            const st3 = await reconcileSignature(sig3, m3.supplyLvbh);
            if (st3 === "in_flight") return failClosed(op, "supplying", "Adding the carved collateral is still settling. Your funds are safe in the bot wallet — retry in a moment.", true);
            if (st3 !== "landed") return failClosed(op, "supply_failed", `${supply.error || "Adding the collateral failed"}. Your funds are safe in the bot wallet.`, true);
            // false-negative: it actually landed -> advance.
          } else {
            return failClosed(op, "supply_failed", `${supply.error || "Adding the collateral failed"}. Your funds are safe in the bot wallet.`, true);
          }
        }
      }
      await storage.updateBorrowOperation(op.id, { step: "supplied_to_bot" });
      op = (await storage.getBorrowOperationById(op.id)) ?? op;
    }

    // ---- ADD-COLLATERAL mode ends HERE: no borrow leg. The carved collateral
    // is supplied into the bot position (strictly LOWERS its LTV), so finalize
    // with no borrowedUsdcRaw. A resume that lands at/after supplied_to_bot
    // falls through the skipped legs above and finalizes idempotently here.
    if (mode === "add_collateral") {
      return finalizeGrow(op, {
        borrowPositionId: params.botBorrowPositionId,
        carvedRaw,
        accountPostLtv: readMeta(op).accountPostLtv ?? null,
      });
    }

    // ---- BORROW MORE (against the bot's grown position) leg ---------------
    // Terminal leg. borrowMoreOnExistingBotPosition is bot-signed and RECEIVES a
    // positive USDC delta (verifyOutputMint=USDC), so a returned signature we
    // cannot disprove is RECORDED (never lose the new debt). Store the pre-borrow
    // debt BASELINE BEFORE broadcasting so a crash reconciles the realised delta by
    // signature status. On resume: landed => finalise (debt grew); in_flight => wait;
    // reverted/expired => the carved collateral is already SUPPLIED (safe, backing
    // the loan), a retry re-borrows.
    const bStep = op.step ?? "";
    if (bStep === "supplied_to_bot" || bStep === "borrowing_more" || bStep === "borrow_more_failed") {
      const meta = readMeta(op);
      const borrowSig = meta.borrowMoreSig as string | undefined;
      if (borrowSig) {
        const s = await reconcileSignature(borrowSig, meta.borrowMoreLvbh);
        if (s === "in_flight") return failClosed(op, "borrowing_more", "The additional borrow is still settling. Your funds are safe — retry in a moment.", true);
        if (s === "landed") {
          const preDebtRaw = BigInt(meta.borrowPreDebtRaw || "0");
          const live = await route.readLivePositionHealth(collateralMint, params.botVenuePositionId);
          const delta = live && BigInt(live.debtRaw) > preDebtRaw ? (BigInt(live.debtRaw) - preDebtRaw).toString() : (meta.borrowedUsdcRaw ?? undefined);
          return finalizeGrow(op, { borrowPositionId: params.botBorrowPositionId, carvedRaw, accountPostLtv: meta.accountPostLtv ?? null, borrowedUsdcRaw: delta });
        }
        // reverted | expired: nothing committed -> re-borrow below.
      }
      // Persist the pre-borrow debt BASELINE before broadcasting so a crash reconciles the delta.
      const preLive = await route.readLivePositionHealth(collateralMint, params.botVenuePositionId);
      if (!preLive) return failClosed(op, "borrow_more_failed", "Could not read the bot position before borrowing; your added collateral is safe in the position — retry in a moment.", true);
      await storage.updateBorrowOperation(op.id, { step: "borrowing_more", mergeMetadata: { borrowPreDebtRaw: preLive.debtRaw } });
      const borrowMore = await borrowMoreOnExistingBotPosition({
        walletAddress: params.walletAddress,
        tradingBotId: params.tradingBotId,
        botPublicKey: params.botPublicKey,
        botSecretKey: params.botSecretKey,
        accountPublicKey: params.accountPublicKey,
        accountSecretKey: params.accountSecretKey,
        collateralMint,
        borrowPositionId: params.botBorrowPositionId,
        requestedDebtRaw: params.requestedDebtRaw,
        onBeforeBroadcast: async ({ signature, lastValidBlockHeight }) => {
          await storage.updateBorrowOperation(op.id, {
            mergeMetadata: { borrowMoreSig: signature, borrowMoreLvbh: lastValidBlockHeight },
            appendTxSignature: signature,
          });
        },
      });
      if (!borrowMore.success) {
        // The borrow sig may have actually landed (false negative).
        op = (await storage.getBorrowOperationById(op.id)) ?? op;
        const m3 = readMeta(op);
        const sig3 = m3.borrowMoreSig as string | undefined;
        if (sig3) {
          const st3 = await reconcileSignature(sig3, m3.borrowMoreLvbh);
          if (st3 === "in_flight") return failClosed(op, "borrowing_more", "The additional borrow is still settling. Your funds are safe — retry in a moment.", true);
          if (st3 === "landed") {
            const preDebtRaw = BigInt(m3.borrowPreDebtRaw || "0");
            const live = await route.readLivePositionHealth(collateralMint, params.botVenuePositionId);
            const delta = live && BigInt(live.debtRaw) > preDebtRaw ? (BigInt(live.debtRaw) - preDebtRaw).toString() : undefined;
            return finalizeGrow(op, { borrowPositionId: params.botBorrowPositionId, carvedRaw, accountPostLtv: m3.accountPostLtv ?? null, borrowedUsdcRaw: delta });
          }
        }
        // Nothing committed: the carved collateral is SUPPLIED into the bot position
        // (safe, backing the loan). A retry re-borrows.
        return failClosed(op, "borrow_more_failed", `${borrowMore.error || "The additional borrow failed"}. Your added collateral is safe in the bot position.`, true);
      }
      await storage.updateBorrowOperation(op.id, {
        step: "bot_borrowed",
        mergeMetadata: { borrowedUsdcRaw: borrowMore.borrowedDeltaRaw },
      });
      op = (await storage.getBorrowOperationById(op.id)) ?? op;
      return finalizeGrow(op, {
        borrowPositionId: params.botBorrowPositionId,
        carvedRaw,
        accountPostLtv: readMeta(op).accountPostLtv ?? null,
        borrowedUsdcRaw: borrowMore.borrowedDeltaRaw,
      });
    }

    // Resuming at/after bot_borrowed -> finalise from the breadcrumb.
    const meta = readMeta(op);
    return finalizeGrow(op, {
      borrowPositionId: params.botBorrowPositionId,
      carvedRaw,
      accountPostLtv: meta.accountPostLtv ?? null,
      borrowedUsdcRaw: meta.borrowedUsdcRaw,
    });
  });
}

async function finalizeGrow(
  op: BorrowOperation,
  r: { borrowPositionId: string; carvedRaw: bigint; accountPostLtv: number | null; borrowedUsdcRaw?: string },
): Promise<PerbotCarveResult> {
  const result: Meta = {
    borrowPositionId: r.borrowPositionId,
    carvedRaw: r.carvedRaw.toString(),
    accountPostLtv: r.accountPostLtv,
    borrowedUsdcRaw: r.borrowedUsdcRaw,
  };
  await storage.updateBorrowOperation(op.id, { status: "succeeded", step: "final_read", borrowPositionId: r.borrowPositionId, result });
  const fresh = await storage.getBorrowOperationById(op.id);
  return {
    success: true,
    operationId: op.id,
    step: "final_read",
    borrowPositionId: r.borrowPositionId,
    carvedRaw: r.carvedRaw.toString(),
    accountPostLtv: r.accountPostLtv,
    borrowedUsdcRaw: r.borrowedUsdcRaw,
    signatures: ((fresh?.txSignatures ?? op.txSignatures) as string[] | null) ?? [],
  };
}
