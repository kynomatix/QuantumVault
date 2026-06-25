/**
 * Jupiter Lend BORROW executor — Phase D, brick #3 (THE money path).
 *
 * This is the ONLY file that moves money for the borrow engine. It mirrors the
 * audited park/unpark money-path (vault-service.ts):
 *   per-scope serialize -> re-run the ENFORCED risk gate -> gas top-up ->
 *   pure plan (borrow-engine-core) -> build SDK ix -> sign/send/confirm/verify
 *   via executeAgentInstructions (realized-delta, fail-closed) -> persist the
 *   AUTHORITATIVE on-chain result.
 *
 * Money-safety contract:
 *  - On-chain is the source of truth. executeAgentInstructions confirms by
 *    polling and verifies a POSITIVE realized delta of the output mint, so a
 *    "success" always means funds actually moved.
 *  - Once a tx confirms and funds move, we ALWAYS persist the real position
 *    (nftId + observed debt/collateral) and never mark it `failed`. A
 *    post-confirm verify miss is a logged WARNING, never a fund-losing failure
 *    (see borrow-engine-core's contract). `failed` is reserved for "no money
 *    moved".
 *  - The risk gate (previewBorrowEligibility / evaluateBorrowRequest, hard max
 *    LTV 0.3) is re-run IMMEDIATELY before signing an open and must return
 *    ok && allowed, or we refuse. This is the same gate the preview route uses;
 *    while borrow is owner-pending it fails closed by design.
 *  - @jup-ag/lend is imported LAZILY; BN comes from 'bn.js' (never anchor).
 *
 * MVP scope (matches the Vault's all-in/all-out, no-knobs philosophy):
 *   - OPEN a new position (deposit collateral + borrow USDC), account scope.
 *   - FULL CLOSE (repay ALL + withdraw ALL).
 *   Partial repay / partial withdraw / per-bot scope are deferred.
 */

import Decimal from "decimal.js";
import {
  executeAgentInstructions,
  executeAgentInstructionsConfirmOnly,
  getServerConnection,
  getAgentTokenBalanceRawStrict,
  USDC_MINT,
} from "../agent-wallet";
import { PublicKey } from "@solana/web3.js";
import { storage } from "../storage";
import { ensureVaultGas } from "./gas-funding";
import { JupiterLendBorrowRoute, type BorrowVaultConfig } from "./jupiter-lend-borrow-route";
import { previewBorrowEligibility } from "./borrow-eligibility";
import { readBorrowOracleContext } from "./borrow-oracle-freshness";
import { evaluateCollateralWithdraw } from "./borrow-risk-policy";
import {
  planBorrowOpen,
  planBorrowClose,
  planSupplyCollateral,
  planBorrowMore,
  planRepayPartial,
  planWithdrawPartial,
  verifyOpenOutcome,
  verifyCloseOutcome,
  verifySupplyOutcome,
  verifyRepayOutcome,
  verifyBorrowMoreOutcome,
  verifyWithdrawOutcome,
  hasSufficientRepayBalance,
  type AmountSpec,
} from "./borrow-engine-core";

const DEBT_VENUE = "jupiter_lend";
/** Extra USDC headroom over the read debt to absorb interest accrued before the
 *  repay tx lands. 50 bps — purely a pre-flight guard; the operate is atomic. */
const REPAY_BUFFER_BPS = 50;

// --- Per-scope serializer (mirrors vault-service.withScopeLock) --------------
// A borrow open/close moves on-chain funds then records debt; two concurrent
// clicks/retries on the SAME borrow scope must never interleave. Serialize the
// WHOLE op without ever holding a DB tx across on-chain calls.
const scopeTails = new Map<string, Promise<void>>();
export async function withBorrowLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = scopeTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  scopeTails.set(key, prev.then(() => gate));
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (scopeTails.get(key) === undefined) { /* noop */ }
    // Best-effort cleanup: drop the tail if it is the one we just released.
    queueMicrotask(() => {
      const tail = scopeTails.get(key);
      if (tail) tail.then(() => {
        if (scopeTails.get(key) === tail) scopeTails.delete(key);
      }).catch(() => {});
    });
  }
}

function borrowLockKey(walletAddress: string, tradingBotId: string | null, vaultId: number | string): string {
  return JSON.stringify(["borrow", walletAddress, tradingBotId ?? null, String(vaultId)]);
}

// --- Helpers ----------------------------------------------------------------

function fromRaw(raw: bigint | string, decimals: number): number {
  return Number(new Decimal(raw.toString()).div(new Decimal(10).pow(decimals)).toFixed(decimals));
}

/** Map an SDK-free AmountSpec to the SDK BN / MAX sentinel for the given leg. */
function specToBN(
  BN: any,
  spec: AmountSpec,
  leg: "col" | "debt",
  MAX_WITHDRAW: any,
  MAX_REPAY: any,
): any {
  if (spec.kind === "max") return leg === "col" ? MAX_WITHDRAW : MAX_REPAY;
  return new BN(spec.raw.toString());
}

/** Decode a live position health read into a storable snapshot. */
function buildHealthSnapshot(
  cfg: BorrowVaultConfig,
  collateralRaw: bigint,
  debtRaw: bigint,
  oraclePriceUsd: number | null,
  source: string,
) {
  const collateralUi = fromRaw(collateralRaw, cfg.collateralDecimals);
  const debtUsd = fromRaw(debtRaw, cfg.debtDecimals);
  const price = oraclePriceUsd ?? cfg.oraclePriceLiquidateUsd ?? null;
  const collateralValueUsd = price != null ? collateralUi * price : null;
  const ltv = collateralValueUsd && collateralValueUsd > 0 ? debtUsd / collateralValueUsd : null;
  const healthFactor =
    collateralValueUsd && debtUsd > 0
      ? (collateralValueUsd * cfg.liquidationThreshold) / debtUsd
      : null;
  return {
    snapshot: {
      healthFactor,
      ltv,
      collateralValueUsd,
      debtUsd,
      source,
    },
    collateralValueUsd,
    debtUsd,
  };
}

// --- Eligibility gate (re-run immediately before signing) --------------------

function buildEligibilityDeps(borrowRoute: JupiterLendBorrowRoute) {
  return {
    getVaultConfig: (mint: string) => borrowRoute.getVaultConfig(mint),
    getActiveBorrowPositionsAllWallets: () => storage.getActiveBorrowPositionsAllWallets(),
    readBorrowOracleContext: (vault: BorrowVaultConfig) => readBorrowOracleContext(vault),
  };
}

// --- OPEN -------------------------------------------------------------------

export interface BorrowOpenParams {
  walletAddress: string;
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  /** Collateral mint that resolves the Jupiter Lend vault (e.g. INF -> vault 43). */
  collateralMint: string;
  /** Collateral to deposit, raw base units. Must already sit in the agent wallet. */
  collateralRaw: bigint;
  /** USDC to borrow, raw base units (6 dp). */
  requestedDebtRaw: bigint;
  /** MVP: account scope only (null). A bot id is reserved for later. */
  tradingBotId?: string | null;
}

export interface BorrowOpenResult {
  success: boolean;
  borrowPositionId?: string;
  venuePositionId?: number;
  signature?: string;
  borrowedUsdc?: number;
  collateralValueUsd?: number | null;
  observedDebtRaw?: string;
  observedCollateralRaw?: string;
  /** Set when the tx confirmed (money moved) but the post-open sanity check missed. */
  verifyWarning?: string;
  dbWarning?: string;
  error?: string;
}

export async function executeBorrowOpen(params: BorrowOpenParams): Promise<BorrowOpenResult> {
  const tradingBotId = params.tradingBotId ?? null;
  if (tradingBotId) {
    return { success: false, error: "Per-bot borrow scope is not supported yet (account scope only)." };
  }
  if (params.collateralRaw <= 0n) return { success: false, error: "Collateral must be greater than zero." };
  if (params.requestedDebtRaw <= 0n) return { success: false, error: "Borrow amount must be greater than zero." };

  const borrowRoute = new JupiterLendBorrowRoute();
  const cfg = await borrowRoute.getVaultConfig(params.collateralMint);
  if (!cfg) return { success: false, error: "Borrow vault is unavailable right now." };

  return withBorrowLock(borrowLockKey(params.walletAddress, tradingBotId, cfg.vaultId), async () => {
    // 1) ENFORCED risk gate, re-run immediately before signing. Refuse unless we
    //    could fully evaluate (ok) AND it is allowed. Same gate as the preview.
    const elig = await previewBorrowEligibility(
      params.walletAddress,
      { collateralMint: params.collateralMint, collateralRaw: params.collateralRaw, requestedDebtRaw: params.requestedDebtRaw },
      buildEligibilityDeps(borrowRoute),
    );
    if (!elig.ok) return { success: false, error: "Could not fully evaluate borrow risk; refusing to borrow." };
    if (!elig.allowed) {
      const deny = elig.reasons?.find((r) => r.severity === "deny");
      return { success: false, error: deny?.message || "This borrow is not allowed under the risk limits." };
    }

    // 2) Gas: the agent wallet pays; account scope funds its own gas. Make sure it
    //    can cover the tx fee + first-time USDC ATA rent before signing.
    const gas = await ensureVaultGas({
      payingPublicKey: params.agentPublicKey,
      funderPublicKey: params.agentPublicKey,
      funderSecretKey: params.agentSecretKey,
      destMint: USDC_MINT,
      label: "Borrow",
    });
    if (!gas.ok) return { success: false, error: gas.error || "Could not cover the network gas for this borrow." };

    // 3) Pure plan -> SDK instructions (lazy import; positionId 0 mints a new NFT).
    const plan = planBorrowOpen({ collateralRaw: params.collateralRaw, debtRaw: params.requestedDebtRaw });
    const borrow = await import("@jup-ag/lend/borrow");
    const BN = (await import("bn.js")).default;
    const connection = getServerConnection();
    const signer = new PublicKey(params.agentPublicKey);

    let operate;
    try {
      operate = await borrow.getOperateIx({
        vaultId: cfg.vaultId,
        positionId: plan.positionId,
        colAmount: specToBN(BN, plan.colAmount, "col", borrow.MAX_WITHDRAW_AMOUNT, borrow.MAX_REPAY_AMOUNT),
        debtAmount: specToBN(BN, plan.debtAmount, "debt", borrow.MAX_WITHDRAW_AMOUNT, borrow.MAX_REPAY_AMOUNT),
        connection,
        signer,
      });
    } catch (e: any) {
      return { success: false, error: `Could not build the borrow transaction: ${e?.message || e}` };
    }
    if (!operate?.ixs?.length) return { success: false, error: "Borrow transaction had no instructions." };

    // 4) Resumable record: a 'pending' position + an op log row, written BEFORE
    //    signing. We persist the predicted nftId and a CONSERVATIVE liability (the
    //    requested debt) up front so a crash between send and the post-confirm
    //    write can never lose the position linkage or under-report the debt
    //    (sumOpenBorrowDebtUsdc counts every non-closed/non-failed row, so a
    //    pending row already shows as a liability). The authoritative on-chain
    //    amounts overwrite these after confirmation; a pre-send failure marks the
    //    row failed (excluded again) before any money moves.
    const position = await storage.createBorrowPosition({
      walletAddress: params.walletAddress,
      tradingBotId,
      debtVenue: DEBT_VENUE,
      venueVaultId: String(cfg.vaultId),
      venuePositionId: String(operate.nftId),
      collateralAssetKey: cfg.collateralSymbol.toLowerCase(),
      collateralMint: cfg.collateralMint,
      collateralAmountRaw: params.collateralRaw.toString(),
      debtAssetKey: "usdc",
      debtMint: cfg.debtMint,
      debtAmountRaw: params.requestedDebtRaw.toString(),
      status: "pending",
    });
    const op = await storage.createBorrowOperation({
      walletAddress: params.walletAddress,
      borrowPositionId: position.id,
      operationType: "borrow_open",
      status: "pending",
      step: "gate_passed",
    });

    // 5) THE money move: sign/send/confirm + verify a POSITIVE USDC delta.
    const exec = await executeAgentInstructions({
      agentPublicKey: params.agentPublicKey,
      agentSecretKey: params.agentSecretKey,
      instructions: operate.ixs,
      verifyOutputMint: USDC_MINT,
      addressLookupTables: operate.addressLookupTableAccounts,
      label: "Borrow open",
    });

    const nftId = operate.nftId;

    // 5b) Decide whether money moved — DO NOT blindly trust `!exec.success`.
    //     executeAgentInstructions verifies the USDC delta with a fail-OPEN reader,
    //     so a post-confirm RPC hiccup can report failure for a borrow that DID
    //     land. A returned signature means the tx was broadcast and may be on-chain;
    //     marking such a row failed would drop a real debt. We only mark failed when
    //     it is provably safe (no signature = never sent, or an on-chain probe shows
    //     nothing). Otherwise we fail CLOSED: record the position, never lose it.
    let usdcDeltaRaw: bigint;
    let preReadLive: Awaited<ReturnType<typeof borrowRoute.readLivePositionHealth>> = null;
    const recovered = !(exec.success && exec.outputReceivedRaw);
    if (!recovered) {
      usdcDeltaRaw = BigInt(exec.outputReceivedRaw!);
    } else if (!exec.signature || exec.onChainFailed) {
      // Provably no money moved -> safe to mark failed:
      //   - no signature   = the tx was never broadcast (pre-send / preflight).
      //   - onChainFailed   = the tx landed but FAILED atomically (st.err); nothing
      //                       was committed. This is the COMMON revert case, and the
      //                       one where a null position-read would otherwise be
      //                       mistaken for "unreadable" and recorded as false debt.
      await storage.updateBorrowOperation(op.id, { status: "failed", step: "exec_failed", error: exec.error || "borrow open failed", ...(exec.signature ? { appendTxSignature: exec.signature } : {}) });
      await storage.updateBorrowPosition(position.id, { status: "failed" }, "pending");
      return { success: false, signature: exec.signature, error: exec.error || "Borrow failed." };
    } else {
      // Signature exists, tx was NOT reported as an on-chain failure, but the USDC
      // delta could not be verified (RPC lag / fail-open read). Probe the position
      // by nftId to disambiguate.
      preReadLive = await borrowRoute.readLivePositionHealth(params.collateralMint, nftId);
      if (preReadLive && BigInt(preReadLive.debtRaw) <= 0n && BigInt(preReadLive.collateralRaw) <= 0n) {
        // Definitive read: nothing on-chain -> no money moved.
        await storage.updateBorrowOperation(op.id, { status: "failed", step: "exec_failed", error: exec.error || "borrow open failed", appendTxSignature: exec.signature });
        await storage.updateBorrowPosition(position.id, { status: "failed" }, "pending");
        return { success: false, signature: exec.signature, error: exec.error || "Borrow failed." };
      }
      // A real position exists, OR the probe itself failed (null). Fail CLOSED:
      // treat as money-moved and record a conservative liability below.
      usdcDeltaRaw = preReadLive ? BigInt(preReadLive.debtRaw) : params.requestedDebtRaw;
    }

    // 6) Read the AUTHORITATIVE on-chain position. Money has moved; from here we
    //    persist reality and NEVER mark failed. Reuse the probe read if we have it.
    const live = preReadLive ?? await borrowRoute.readLivePositionHealth(params.collateralMint, nftId);
    let observedColRaw: bigint;
    let observedDebtRaw: bigint;
    let healthSource: string;
    let oraclePriceUsd: number | null = null;
    if (live) {
      observedColRaw = BigInt(live.collateralRaw);
      observedDebtRaw = BigInt(live.debtRaw);
      oraclePriceUsd = live.oraclePriceUsd;
      healthSource = "open_onchain";
    } else {
      // Position read failed post-borrow. Persist a CONSERVATIVE liability: never
      // under-report debt. Use the larger of requested debt and the received USDC.
      observedColRaw = params.collateralRaw;
      observedDebtRaw = usdcDeltaRaw > params.requestedDebtRaw ? usdcDeltaRaw : params.requestedDebtRaw;
      healthSource = "open_unverified";
    }

    const health = buildHealthSnapshot(cfg, observedColRaw, observedDebtRaw, oraclePriceUsd, healthSource);

    // 7) Advisory sanity check (a miss is a warning, not a failure).
    let verifyWarning: string | undefined;
    if (recovered) {
      // Execution reported an error but a signature existed and the position was
      // found / could not be ruled out — we recorded it rather than lose the debt.
      verifyWarning = `Borrow execution reported an error but the transaction was sent (signature ${exec.signature}); recorded the on-chain position to avoid losing the debt.`;
      console.warn("[Borrow] open recovered from reported exec failure", { positionId: position.id, nftId, hadLiveRead: !!live });
    }
    if (live) {
      const v = verifyOpenOutcome({
        requestedCollateralRaw: params.collateralRaw,
        requestedDebtRaw: params.requestedDebtRaw,
        usdcDeltaRaw,
        observedColRaw,
        observedDebtRaw,
      });
      if (!v.ok) {
        const miss = `Borrow landed (signature ${exec.signature}) but the position read differs from the request (${v.reason}). Recorded the on-chain amounts.`;
        verifyWarning = verifyWarning ? `${verifyWarning} ${miss}` : miss;
        console.warn(`[Borrow] open verify miss: ${v.reason}`, { positionId: position.id, nftId });
      }
    } else {
      const unread = `Borrow landed (signature ${exec.signature}) but the position could not be re-read; recorded a conservative debt estimate pending reconcile.`;
      verifyWarning = verifyWarning ? `${verifyWarning} ${unread}` : unread;
    }

    // 8) Persist the on-chain truth + mark open (CAS on still-pending).
    let dbWarning: string | undefined;
    const updated = await storage.updateBorrowPosition(
      position.id,
      {
        venuePositionId: String(nftId),
        status: "open",
        collateralAmountRaw: observedColRaw.toString(),
        debtAmountRaw: observedDebtRaw.toString(),
        healthSnapshot: health.snapshot,
        healthAsOf: new Date(),
        healthSource,
      },
      "pending",
    );
    if (!updated) {
      // CAS lost (a concurrent finalizer already moved it). The op log still
      // captures the signature; surface a soft warning.
      dbWarning = `Borrow succeeded (signature ${exec.signature}) but the position record was updated by another process.`;
      console.warn("[Borrow] open CAS lost on pending->open", { positionId: position.id });
    }
    await storage.updateBorrowOperation(op.id, { status: "succeeded", step: "open_confirmed", appendTxSignature: exec.signature });

    return {
      success: true,
      borrowPositionId: position.id,
      venuePositionId: nftId,
      signature: exec.signature,
      borrowedUsdc: fromRaw(usdcDeltaRaw, cfg.debtDecimals),
      collateralValueUsd: health.collateralValueUsd,
      observedDebtRaw: observedDebtRaw.toString(),
      observedCollateralRaw: observedColRaw.toString(),
      verifyWarning,
      dbWarning,
    };
  });
}

// --- FULL CLOSE -------------------------------------------------------------

export interface BorrowCloseParams {
  walletAddress: string;
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  /** Our DB borrow_positions row id. */
  borrowPositionId: string;
}

export interface BorrowCloseResult {
  success: boolean;
  signature?: string;
  collateralReturned?: number;
  observedDebtRaw?: string;
  /** true => status is `closed`; false => left non-terminal pending reconcile. */
  finalized: boolean;
  verifyWarning?: string;
  dbWarning?: string;
  error?: string;
}

export async function executeBorrowClose(params: BorrowCloseParams): Promise<BorrowCloseResult> {
  const position = await storage.getBorrowPosition(params.walletAddress, params.borrowPositionId);
  if (!position) return { success: false, finalized: false, error: "Borrow position not found." };
  if (position.status !== "open") {
    return { success: false, finalized: false, error: `Borrow position is not open (status: ${position.status}).` };
  }
  if (!position.venuePositionId) {
    return { success: false, finalized: false, error: "Borrow position has no on-chain id; cannot close." };
  }
  if (position.tradingBotId) {
    return { success: false, finalized: false, error: "Per-bot borrow scope is not supported yet." };
  }

  const nftId = Number(position.venuePositionId);
  if (!Number.isInteger(nftId) || nftId <= 0) {
    return { success: false, finalized: false, error: "Borrow position has an invalid on-chain id." };
  }

  const borrowRoute = new JupiterLendBorrowRoute();
  const cfg = await borrowRoute.getVaultConfig(position.collateralMint);
  if (!cfg) return { success: false, finalized: false, error: "Borrow vault is unavailable right now." };

  return withBorrowLock(borrowLockKey(params.walletAddress, null, cfg.vaultId), async () => {
    // 1) Read the live debt — we must know it to confirm the wallet can repay ALL.
    //    Fail closed if unreadable (never close blindly).
    const live = await borrowRoute.readLivePositionHealth(position.collateralMint, nftId);
    if (!live) return { success: false, finalized: false, error: "Could not read the live position; refusing to close." };
    const debtRaw = BigInt(live.debtRaw);

    // 2) Pre-flight: the agent wallet must hold enough USDC to repay all debt +
    //    a small interest buffer. The operate pulls repayment from the signer.
    const usdcBal = BigInt((await getAgentTokenBalanceRawStrict(params.agentPublicKey, USDC_MINT)).amountRaw);
    const buffer = (debtRaw * BigInt(REPAY_BUFFER_BPS)) / 10_000n;
    if (!hasSufficientRepayBalance(usdcBal, debtRaw, buffer)) {
      return {
        success: false,
        finalized: false,
        error: `Not enough USDC in the wallet to repay the loan (need ~${fromRaw(debtRaw + buffer, cfg.debtDecimals).toFixed(2)} USDC).`,
      };
    }

    // 3) Gas: cover the tx fee + first-time collateral ATA rent (we receive it back).
    const gas = await ensureVaultGas({
      payingPublicKey: params.agentPublicKey,
      funderPublicKey: params.agentPublicKey,
      funderSecretKey: params.agentSecretKey,
      destMint: position.collateralMint,
      label: "Repay",
    });
    if (!gas.ok) return { success: false, finalized: false, error: gas.error || "Could not cover the network gas for this repay." };

    // 4) Pure plan -> SDK ix: repay ALL, withdraw ALL.
    const plan = planBorrowClose(nftId);
    const borrow = await import("@jup-ag/lend/borrow");
    const BN = (await import("bn.js")).default;
    const connection = getServerConnection();
    const signer = new PublicKey(params.agentPublicKey);

    let operate;
    try {
      operate = await borrow.getOperateIx({
        vaultId: cfg.vaultId,
        positionId: plan.positionId,
        colAmount: specToBN(BN, plan.colAmount, "col", borrow.MAX_WITHDRAW_AMOUNT, borrow.MAX_REPAY_AMOUNT),
        debtAmount: specToBN(BN, plan.debtAmount, "debt", borrow.MAX_WITHDRAW_AMOUNT, borrow.MAX_REPAY_AMOUNT),
        connection,
        signer,
      });
    } catch (e: any) {
      return { success: false, finalized: false, error: `Could not build the repay transaction: ${e?.message || e}` };
    }
    if (!operate?.ixs?.length) return { success: false, finalized: false, error: "Repay transaction had no instructions." };

    // 5) Mark closing (CAS on still-open) + op log.
    const claimed = await storage.updateBorrowPosition(position.id, { status: "closing" }, "open");
    if (!claimed) return { success: false, finalized: false, error: "Borrow position changed state; close aborted." };
    const op = await storage.createBorrowOperation({
      walletAddress: params.walletAddress,
      borrowPositionId: position.id,
      operationType: "borrow_close",
      status: "pending",
      step: "claimed",
    });

    // 6) THE money move: verify a POSITIVE COLLATERAL delta returned to the wallet.
    const exec = await executeAgentInstructions({
      agentPublicKey: params.agentPublicKey,
      agentSecretKey: params.agentSecretKey,
      instructions: operate.ixs,
      verifyOutputMint: position.collateralMint,
      addressLookupTables: operate.addressLookupTableAccounts,
      label: "Borrow close",
    });

    if (!exec.success || !exec.outputReceivedRaw) {
      // Operate is atomic -> nothing moved. Revert to open (CAS on still-closing).
      await storage.updateBorrowOperation(op.id, { status: "failed", step: "exec_failed", error: exec.error || "borrow close failed", ...(exec.signature ? { appendTxSignature: exec.signature } : {}) });
      await storage.updateBorrowPosition(position.id, { status: "open" }, "closing");
      return { success: false, finalized: false, signature: exec.signature, error: exec.error || "Repay/withdraw failed." };
    }

    const collateralDeltaRaw = BigInt(exec.outputReceivedRaw);

    // 7) Re-read to confirm debt is cleared.
    const after = await borrowRoute.readLivePositionHealth(position.collateralMint, nftId);
    const observedDebtRaw = after ? BigInt(after.debtRaw) : null;

    let verifyWarning: string | undefined;
    let finalized = false;
    let dbWarning: string | undefined;

    if (observedDebtRaw !== null) {
      const v = verifyCloseOutcome({ observedDebtRaw, collateralDeltaRaw });
      if (v.ok) {
        const health = buildHealthSnapshot(cfg, after ? BigInt(after.collateralRaw) : 0n, observedDebtRaw, after?.oraclePriceUsd ?? null, "closed");
        const closed = await storage.updateBorrowPosition(
          position.id,
          { status: "closed", debtAmountRaw: observedDebtRaw.toString(), collateralAmountRaw: after ? BigInt(after.collateralRaw).toString() : "0", healthSnapshot: health.snapshot, healthAsOf: new Date(), healthSource: "closed" },
          "closing",
        );
        finalized = Boolean(closed);
        if (!closed) dbWarning = "Close confirmed on-chain but the record was updated by another process.";
        await storage.updateBorrowOperation(op.id, { status: "succeeded", step: "closed", appendTxSignature: exec.signature });
      } else {
        // Debt NOT cleared. Do not finalize; keep the real (re-read) debt and leave
        // the position non-terminal for reconcile. Fail-closed on liability.
        verifyWarning = `Repay landed (signature ${exec.signature}) but debt is not fully cleared (${v.reason}); left open with the on-chain debt.`;
        await storage.updateBorrowPosition(position.id, { status: "open", debtAmountRaw: observedDebtRaw.toString() }, "closing");
        await storage.updateBorrowOperation(op.id, { status: "failed", step: "debt_not_cleared", error: v.reason, appendTxSignature: exec.signature });
        console.warn(`[Borrow] close verify miss: ${v.reason}`, { positionId: position.id, nftId });
      }
    } else {
      // Collateral came back (delta > 0) but we cannot re-read the position. Leave
      // it non-terminal ('closing') for a reconcile pass — never finalize on an
      // unconfirmed debt (would under-report liability).
      verifyWarning = `Repay landed (signature ${exec.signature}) but the position could not be re-read; left pending reconcile.`;
      await storage.updateBorrowOperation(op.id, { status: "succeeded", step: "close_unverified", appendTxSignature: exec.signature });
      console.warn("[Borrow] close could not re-read position", { positionId: position.id, nftId });
    }

    return {
      success: true,
      signature: exec.signature,
      collateralReturned: fromRaw(collateralDeltaRaw, cfg.collateralDecimals),
      observedDebtRaw: observedDebtRaw != null ? observedDebtRaw.toString() : undefined,
      finalized,
      verifyWarning,
      dbWarning,
    };
  });
}

// ---------------------------------------------------------------------------
// PHASE 1 SINGLE-TX MONEY OPS (supply / borrow-more / repay-from-agent /
// withdraw). Two safety classes, exactly as borrow-engine-core documents:
//   * borrow-more & withdraw RECEIVE a positive output delta (USDC / collateral
//     lands in the wallet) -> executeAgentInstructions is the money-moved proof;
//     the recovered-failure handling mirrors the OPEN path (a returned signature
//     that we cannot disprove is recorded, never dropped).
//   * supply & repay send funds OUT with no positive delta ->
//     executeAgentInstructionsConfirmOnly + an AUTHORITATIVE position re-read is
//     the proof, and we fail CLOSED on the dangerous direction (never record
//     MORE collateral / LESS debt than the chain proves).
// All four serialize on the per-scope borrow lock, target the EXACT minted
// venuePositionId, and persist on-chain truth. Per-bot scope is still deferred.
// ---------------------------------------------------------------------------

/** Load + validate an EXISTING open, account-scope position owned by the wallet. */
async function loadOpenAccountPosition(
  walletAddress: string,
  borrowPositionId: string,
): Promise<{ ok: true; position: Awaited<ReturnType<typeof storage.getBorrowPosition>> & {}; nftId: number } | { ok: false; error: string }> {
  const position = await storage.getBorrowPosition(walletAddress, borrowPositionId);
  if (!position) return { ok: false, error: "Borrow position not found." };
  if (position.tradingBotId) return { ok: false, error: "Per-bot borrow scope is not supported yet (account scope only)." };
  if (position.status !== "open") return { ok: false, error: `Borrow position is not open (status: ${position.status}).` };
  if (!position.venuePositionId) return { ok: false, error: "Borrow position has no on-chain id yet." };
  const nftId = Number(position.venuePositionId);
  if (!Number.isInteger(nftId) || nftId <= 0) return { ok: false, error: "Borrow position has an invalid on-chain id." };
  return { ok: true, position, nftId };
}

// --- SUPPLY collateral ------------------------------------------------------

export interface SupplyCollateralParams {
  walletAddress: string;
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  /** Collateral mint that resolves the Jupiter Lend vault. */
  collateralMint: string;
  /** Collateral to deposit, raw base units. Must already sit in the agent wallet. */
  collateralRaw: bigint;
  /**
   * Add to THIS existing position. Omit to add to the wallet's single open
   * position for this collateral, or to MINT a new supply-only position when none
   * exists. Multiple open positions for the same collateral + no id => refused.
   */
  borrowPositionId?: string | null;
  tradingBotId?: string | null;
}

export interface SupplyCollateralResult {
  success: boolean;
  borrowPositionId?: string;
  venuePositionId?: number;
  signature?: string;
  observedCollateralRaw?: string;
  collateralValueUsd?: number | null;
  verifyWarning?: string;
  dbWarning?: string;
  error?: string;
}

export async function executeSupplyCollateral(params: SupplyCollateralParams): Promise<SupplyCollateralResult> {
  const tradingBotId = params.tradingBotId ?? null;
  if (tradingBotId) return { success: false, error: "Per-bot borrow scope is not supported yet (account scope only)." };
  if (params.collateralRaw <= 0n) return { success: false, error: "Collateral must be greater than zero." };

  const borrowRoute = new JupiterLendBorrowRoute();
  const cfg = await borrowRoute.getVaultConfig(params.collateralMint);
  if (!cfg) return { success: false, error: "Borrow vault is unavailable right now." };

  return withBorrowLock(borrowLockKey(params.walletAddress, tradingBotId, cfg.vaultId), async () => {
    // 1) Resolve the target position (prefer add-to-existing over a 2nd NFT).
    let existing: (Awaited<ReturnType<typeof storage.getBorrowPosition>> & {}) | null = null;
    if (params.borrowPositionId) {
      const loaded = await loadOpenAccountPosition(params.walletAddress, params.borrowPositionId);
      if (!loaded.ok) return { success: false, error: loaded.error };
      if (loaded.position!.collateralMint !== params.collateralMint) {
        return { success: false, error: "Collateral mint does not match the selected position." };
      }
      existing = loaded.position!;
    } else {
      const open = (await storage.getBorrowPositions(params.walletAddress, null)).filter(
        (p) => p.status === "open" && p.collateralMint === params.collateralMint && !p.tradingBotId,
      );
      if (open.length > 1) {
        return { success: false, error: "You have multiple open positions for this collateral; choose which one to add to." };
      }
      existing = open[0] ?? null;
    }

    const targetNftId = existing ? Number(existing.venuePositionId) : 0;
    if (existing && (!Number.isInteger(targetNftId) || targetNftId <= 0)) {
      return { success: false, error: "Selected position has an invalid on-chain id." };
    }

    // 2) Strict balance: the agent wallet must actually hold the collateral.
    //    Fail CLOSED if unreadable (never sign against an unknown balance).
    let colBal: bigint;
    try {
      colBal = BigInt((await getAgentTokenBalanceRawStrict(params.agentPublicKey, params.collateralMint)).amountRaw);
    } catch {
      return { success: false, error: "Could not read the collateral balance; refusing to supply." };
    }
    if (colBal < params.collateralRaw) {
      return { success: false, error: `Not enough ${cfg.collateralSymbol} in the trading wallet to supply.` };
    }

    // 3) Gas: collateral only LEAVES the wallet, so no inbound ATA rent.
    const gas = await ensureVaultGas({
      payingPublicKey: params.agentPublicKey,
      funderPublicKey: params.agentPublicKey,
      funderSecretKey: params.agentSecretKey,
      destMint: null,
      label: "Add Collateral",
    });
    if (!gas.ok) return { success: false, error: gas.error || "Could not cover the network gas to add collateral." };

    // 4) Pre-read live collateral (0 for a new mint) — the supply proof baseline.
    const preLive = existing ? await borrowRoute.readLivePositionHealth(params.collateralMint, targetNftId) : null;
    const preColRaw = preLive ? BigInt(preLive.collateralRaw) : 0n;

    // 5) Pure plan -> SDK ix. positionId 0 mints a new supply-only NFT.
    const plan = planSupplyCollateral(targetNftId, params.collateralRaw);
    const borrow = await import("@jup-ag/lend/borrow");
    const BN = (await import("bn.js")).default;
    const connection = getServerConnection();
    const signer = new PublicKey(params.agentPublicKey);

    let operate;
    try {
      operate = await borrow.getOperateIx({
        vaultId: cfg.vaultId,
        positionId: plan.positionId,
        colAmount: specToBN(BN, plan.colAmount, "col", borrow.MAX_WITHDRAW_AMOUNT, borrow.MAX_REPAY_AMOUNT),
        debtAmount: specToBN(BN, plan.debtAmount, "debt", borrow.MAX_WITHDRAW_AMOUNT, borrow.MAX_REPAY_AMOUNT),
        connection,
        signer,
      });
    } catch (e: any) {
      return { success: false, error: `Could not build the supply transaction: ${e?.message || e}` };
    }
    if (!operate?.ixs?.length) return { success: false, error: "Supply transaction had no instructions." };

    const nftId = existing ? targetNftId : Number(operate.nftId);

    // 6) Resumable record BEFORE signing. A new mint gets a 'pending' position
    //    (collateral 0 — never over-report); an existing one just logs the op.
    let position = existing;
    if (!position) {
      position = await storage.createBorrowPosition({
        walletAddress: params.walletAddress,
        tradingBotId,
        debtVenue: DEBT_VENUE,
        venueVaultId: String(cfg.vaultId),
        venuePositionId: String(nftId),
        collateralAssetKey: cfg.collateralSymbol.toLowerCase(),
        collateralMint: cfg.collateralMint,
        collateralAmountRaw: "0",
        debtAssetKey: "usdc",
        debtMint: cfg.debtMint,
        debtAmountRaw: "0",
        status: "pending",
      });
    }
    const op = await storage.createBorrowOperation({
      walletAddress: params.walletAddress,
      borrowPositionId: position!.id,
      operationType: "supply_collateral",
      status: "pending",
      step: "gate_passed",
    });

    // 7) THE money move (confirm-only: funds leave, no positive delta to verify).
    const exec = await executeAgentInstructionsConfirmOnly({
      agentPublicKey: params.agentPublicKey,
      agentSecretKey: params.agentSecretKey,
      instructions: operate.ixs,
      gasDestMint: null,
      addressLookupTables: operate.addressLookupTableAccounts,
      label: "Add Collateral",
    });

    // 8) Provably-nothing-moved => mark failed (safe; funds still in the wallet).
    if (exec.onChainFailed || !exec.signature) {
      await storage.updateBorrowOperation(op.id, { status: "failed", step: "exec_failed", error: exec.error || "supply failed", ...(exec.signature ? { appendTxSignature: exec.signature } : {}) });
      if (!existing) await storage.updateBorrowPosition(position!.id, { status: "failed" }, "pending");
      return { success: false, signature: exec.signature, error: exec.error || "Adding collateral failed." };
    }

    // 9) AUTHORITATIVE re-read is the proof. Record on-chain truth; fail CLOSED on
    //    the dangerous direction (never record MORE collateral than proven).
    const postLive = await borrowRoute.readLivePositionHealth(params.collateralMint, nftId);
    let observedColRaw: bigint;
    let observedDebtRaw: bigint;
    let oraclePriceUsd: number | null = null;
    let healthSource: string;
    let verifyWarning: string | undefined;

    if (postLive) {
      observedColRaw = BigInt(postLive.collateralRaw);
      observedDebtRaw = BigInt(postLive.debtRaw);
      oraclePriceUsd = postLive.oraclePriceUsd;
      healthSource = "supply_onchain";
      const v = verifySupplyOutcome({ preColRaw, postColRaw: observedColRaw, depositedRaw: params.collateralRaw });
      if (!v.ok) {
        verifyWarning = `Add Collateral sent (signature ${exec.signature}) but the position read differs (${v.reason}). Recorded the on-chain collateral.`;
        console.warn(`[Borrow] supply verify miss: ${v.reason}`, { positionId: position!.id, nftId });
      }
    } else {
      // Confirmed (or ambiguous) but unreadable: keep the PRE collateral so we
      // never over-report. A live re-read self-heals the increase later.
      observedColRaw = preColRaw;
      observedDebtRaw = existing ? BigInt(existing.debtAmountRaw) : 0n;
      healthSource = existing ? (existing.healthSource ?? "supply_unverified") : "supply_unverified";
      verifyWarning = `Add Collateral confirmed (signature ${exec.signature}) but the position could not be re-read; kept the prior collateral pending reconcile.`;
      console.warn("[Borrow] supply could not re-read position", { positionId: position!.id, nftId });
    }

    const health = buildHealthSnapshot(cfg, observedColRaw, observedDebtRaw, oraclePriceUsd, healthSource);
    let dbWarning: string | undefined;
    const updated = await storage.updateBorrowPosition(
      position!.id,
      {
        venuePositionId: String(nftId),
        status: "open",
        collateralAmountRaw: observedColRaw.toString(),
        debtAmountRaw: observedDebtRaw.toString(),
        healthSnapshot: health.snapshot,
        healthAsOf: new Date(),
        healthSource,
      },
      existing ? "open" : "pending",
    );
    if (!updated) {
      dbWarning = `Collateral added (signature ${exec.signature}) but the position record was updated by another process.`;
      console.warn("[Borrow] supply CAS lost", { positionId: position!.id });
    }
    await storage.updateBorrowOperation(op.id, { status: "succeeded", step: "supply_confirmed", appendTxSignature: exec.signature });

    return {
      success: true,
      borrowPositionId: position!.id,
      venuePositionId: nftId,
      signature: exec.signature,
      observedCollateralRaw: observedColRaw.toString(),
      collateralValueUsd: health.collateralValueUsd,
      verifyWarning,
      dbWarning,
    };
  });
}

// --- BORROW MORE ------------------------------------------------------------

export interface BorrowMoreParams {
  walletAddress: string;
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  borrowPositionId: string;
  /** ADDITIONAL USDC to borrow, raw base units (6 dp). */
  requestedDebtRaw: bigint;
}

export interface BorrowMoreResult {
  success: boolean;
  signature?: string;
  borrowedUsdc?: number;
  observedDebtRaw?: string;
  verifyWarning?: string;
  dbWarning?: string;
  error?: string;
}

export async function executeBorrowMore(params: BorrowMoreParams): Promise<BorrowMoreResult> {
  if (params.requestedDebtRaw <= 0n) return { success: false, error: "Borrow amount must be greater than zero." };

  const loaded = await loadOpenAccountPosition(params.walletAddress, params.borrowPositionId);
  if (!loaded.ok) return { success: false, error: loaded.error };
  const { position, nftId } = loaded;

  const borrowRoute = new JupiterLendBorrowRoute();
  const cfg = await borrowRoute.getVaultConfig(position!.collateralMint);
  if (!cfg) return { success: false, error: "Borrow vault is unavailable right now." };

  return withBorrowLock(borrowLockKey(params.walletAddress, null, cfg.vaultId), async () => {
    // 1) LIVE position read — the authority for the per-position risk projection.
    //    Fail CLOSED if unreadable (never borrow more against an unknown debt).
    const live = await borrowRoute.readLivePositionHealth(position!.collateralMint, nftId);
    if (!live) return { success: false, error: "Could not read the live position; refusing to borrow more." };
    const liveColRaw = BigInt(live.collateralRaw);
    const preDebtRaw = BigInt(live.debtRaw);

    // 2) ENFORCED risk gate with LIVE total collateral + LIVE existing debt.
    const elig = await previewBorrowEligibility(
      params.walletAddress,
      {
        collateralMint: position!.collateralMint,
        collateralRaw: liveColRaw,
        requestedDebtRaw: params.requestedDebtRaw,
        existingDebtRawOverride: preDebtRaw,
      },
      buildEligibilityDeps(borrowRoute),
    );
    if (!elig.ok) return { success: false, error: "Could not fully evaluate borrow risk; refusing to borrow." };
    if (!elig.allowed) {
      const deny = elig.reasons?.find((r) => r.severity === "deny");
      return { success: false, error: deny?.message || "This borrow is not allowed under the risk limits." };
    }

    // 3) Gas: borrowed USDC lands -> cover first-time USDC ATA rent + fee.
    const gas = await ensureVaultGas({
      payingPublicKey: params.agentPublicKey,
      funderPublicKey: params.agentPublicKey,
      funderSecretKey: params.agentSecretKey,
      destMint: USDC_MINT,
      label: "Borrow",
    });
    if (!gas.ok) return { success: false, error: gas.error || "Could not cover the network gas for this borrow." };

    // 4) Pure plan -> SDK ix against the EXACT minted position.
    const plan = planBorrowMore(nftId, params.requestedDebtRaw);
    const borrow = await import("@jup-ag/lend/borrow");
    const BN = (await import("bn.js")).default;
    const connection = getServerConnection();
    const signer = new PublicKey(params.agentPublicKey);

    let operate;
    try {
      operate = await borrow.getOperateIx({
        vaultId: cfg.vaultId,
        positionId: plan.positionId,
        colAmount: specToBN(BN, plan.colAmount, "col", borrow.MAX_WITHDRAW_AMOUNT, borrow.MAX_REPAY_AMOUNT),
        debtAmount: specToBN(BN, plan.debtAmount, "debt", borrow.MAX_WITHDRAW_AMOUNT, borrow.MAX_REPAY_AMOUNT),
        connection,
        signer,
      });
    } catch (e: any) {
      return { success: false, error: `Could not build the borrow transaction: ${e?.message || e}` };
    }
    if (!operate?.ixs?.length) return { success: false, error: "Borrow transaction had no instructions." };

    const op = await storage.createBorrowOperation({
      walletAddress: params.walletAddress,
      borrowPositionId: position!.id,
      operationType: "borrow_more",
      status: "pending",
      step: "gate_passed",
    });

    // 5) THE money move: verify a POSITIVE USDC delta lands in the wallet.
    const exec = await executeAgentInstructions({
      agentPublicKey: params.agentPublicKey,
      agentSecretKey: params.agentSecretKey,
      instructions: operate.ixs,
      verifyOutputMint: USDC_MINT,
      addressLookupTables: operate.addressLookupTableAccounts,
      label: "Borrow more",
    });

    // 6) Decide whether money moved (mirror OPEN: a returned signature we cannot
    //    disprove must be RECORDED — never drop the new debt).
    let usdcDeltaRaw: bigint;
    let preReadLive: Awaited<ReturnType<typeof borrowRoute.readLivePositionHealth>> = null;
    const recovered = !(exec.success && exec.outputReceivedRaw);
    if (!recovered) {
      usdcDeltaRaw = BigInt(exec.outputReceivedRaw!);
    } else if (!exec.signature || exec.onChainFailed) {
      await storage.updateBorrowOperation(op.id, { status: "failed", step: "exec_failed", error: exec.error || "borrow more failed", ...(exec.signature ? { appendTxSignature: exec.signature } : {}) });
      return { success: false, signature: exec.signature, error: exec.error || "Borrow failed." };
    } else {
      preReadLive = await borrowRoute.readLivePositionHealth(position!.collateralMint, nftId);
      if (preReadLive && BigInt(preReadLive.debtRaw) <= preDebtRaw) {
        // Definitive read: debt did not grow -> nothing moved.
        await storage.updateBorrowOperation(op.id, { status: "failed", step: "exec_failed", error: exec.error || "borrow more failed", appendTxSignature: exec.signature });
        return { success: false, signature: exec.signature, error: exec.error || "Borrow failed." };
      }
      usdcDeltaRaw = preReadLive ? BigInt(preReadLive.debtRaw) - preDebtRaw : params.requestedDebtRaw;
    }

    // 7) Read AUTHORITATIVE debt; from here we persist reality (never under-report
    //    debt). Reuse the probe read if we have it.
    const after = preReadLive ?? await borrowRoute.readLivePositionHealth(position!.collateralMint, nftId);
    let observedColRaw: bigint;
    let observedDebtRaw: bigint;
    let oraclePriceUsd: number | null = null;
    let healthSource: string;
    if (after) {
      observedColRaw = BigInt(after.collateralRaw);
      observedDebtRaw = BigInt(after.debtRaw);
      oraclePriceUsd = after.oraclePriceUsd;
      healthSource = "borrow_more_onchain";
    } else {
      // Conservative liability: never under-report. Use the larger of the read
      // baseline + request and the realized delta.
      observedColRaw = liveColRaw;
      observedDebtRaw = preDebtRaw + (usdcDeltaRaw > params.requestedDebtRaw ? usdcDeltaRaw : params.requestedDebtRaw);
      healthSource = "borrow_more_unverified";
    }

    let verifyWarning: string | undefined;
    if (recovered) {
      verifyWarning = `Borrow execution reported an error but the transaction was sent (signature ${exec.signature}); recorded the on-chain debt to avoid losing it.`;
      console.warn("[Borrow] borrow-more recovered from reported exec failure", { positionId: position!.id, nftId, hadLiveRead: !!after });
    }
    if (after) {
      const v = verifyBorrowMoreOutcome({ preDebtRaw, postDebtRaw: observedDebtRaw, usdcDeltaRaw, borrowedRaw: params.requestedDebtRaw });
      if (!v.ok) {
        const miss = `Borrow landed (signature ${exec.signature}) but the position read differs (${v.reason}). Recorded the on-chain debt.`;
        verifyWarning = verifyWarning ? `${verifyWarning} ${miss}` : miss;
        console.warn(`[Borrow] borrow-more verify miss: ${v.reason}`, { positionId: position!.id, nftId });
      }
    } else {
      const unread = `Borrow landed (signature ${exec.signature}) but the position could not be re-read; recorded a conservative debt estimate pending reconcile.`;
      verifyWarning = verifyWarning ? `${verifyWarning} ${unread}` : unread;
    }

    const health = buildHealthSnapshot(cfg, observedColRaw, observedDebtRaw, oraclePriceUsd, healthSource);
    let dbWarning: string | undefined;
    const updated = await storage.updateBorrowPosition(
      position!.id,
      {
        status: "open",
        collateralAmountRaw: observedColRaw.toString(),
        debtAmountRaw: observedDebtRaw.toString(),
        healthSnapshot: health.snapshot,
        healthAsOf: new Date(),
        healthSource,
      },
      "open",
    );
    if (!updated) {
      dbWarning = `Borrow succeeded (signature ${exec.signature}) but the position record was updated by another process.`;
      console.warn("[Borrow] borrow-more CAS lost", { positionId: position!.id });
    }
    await storage.updateBorrowOperation(op.id, { status: "succeeded", step: "borrow_more_confirmed", appendTxSignature: exec.signature });

    return {
      success: true,
      signature: exec.signature,
      borrowedUsdc: fromRaw(usdcDeltaRaw, cfg.debtDecimals),
      observedDebtRaw: observedDebtRaw.toString(),
      verifyWarning,
      dbWarning,
    };
  });
}

// --- REPAY from the Trading Agent's USDC (single-tx; canonical source #1) ----

export interface RepayFromAgentUsdcParams {
  walletAddress: string;
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  borrowPositionId: string;
  /** USDC to repay, raw base units; or "max" to repay ALL debt (keep collateral). */
  amount: bigint | "max";
}

export interface RepayResult {
  success: boolean;
  signature?: string;
  repaidUsdc?: number;
  observedDebtRaw?: string;
  /** true when the debt is fully cleared (collateral may remain). */
  fullyRepaid?: boolean;
  verifyWarning?: string;
  dbWarning?: string;
  error?: string;
}

export async function executeRepayFromAgentUsdc(params: RepayFromAgentUsdcParams): Promise<RepayResult> {
  if (params.amount !== "max" && params.amount <= 0n) {
    return { success: false, error: "Repay amount must be greater than zero." };
  }

  const loaded = await loadOpenAccountPosition(params.walletAddress, params.borrowPositionId);
  if (!loaded.ok) return { success: false, error: loaded.error };
  const { position, nftId } = loaded;

  const borrowRoute = new JupiterLendBorrowRoute();
  const cfg = await borrowRoute.getVaultConfig(position!.collateralMint);
  if (!cfg) return { success: false, error: "Borrow vault is unavailable right now." };

  return withBorrowLock(borrowLockKey(params.walletAddress, null, cfg.vaultId), async () => {
    // 1) LIVE debt — required to cap the repay and prove it later. Fail CLOSED.
    const live = await borrowRoute.readLivePositionHealth(position!.collateralMint, nftId);
    if (!live) return { success: false, error: "Could not read the live position; refusing to repay." };
    const preDebtRaw = BigInt(live.debtRaw);
    if (preDebtRaw <= 0n) return { success: false, error: "This position has no debt to repay." };

    // 2) Resolve the repay leg. "max" repays ALL (keep collateral); a partial is
    //    CAPPED at the live debt so we never overpay.
    const isMax = params.amount === "max";
    const repayRaw = isMax ? preDebtRaw : (params.amount as bigint > preDebtRaw ? preDebtRaw : params.amount as bigint);

    // 3) Strict USDC balance (+ interest buffer). Fail CLOSED if unreadable.
    let usdcBal: bigint;
    try {
      usdcBal = BigInt((await getAgentTokenBalanceRawStrict(params.agentPublicKey, USDC_MINT)).amountRaw);
    } catch {
      return { success: false, error: "Could not read the USDC balance; refusing to repay." };
    }
    const buffer = isMax ? (preDebtRaw * BigInt(REPAY_BUFFER_BPS)) / 10_000n : 0n;
    if (!hasSufficientRepayBalance(usdcBal, repayRaw, buffer)) {
      return { success: false, error: `Not enough USDC in the trading wallet to repay (need ~${fromRaw(repayRaw + buffer, cfg.debtDecimals).toFixed(2)} USDC).` };
    }

    // 4) Gas: USDC only LEAVES the wallet -> no inbound ATA rent.
    const gas = await ensureVaultGas({
      payingPublicKey: params.agentPublicKey,
      funderPublicKey: params.agentPublicKey,
      funderSecretKey: params.agentSecretKey,
      destMint: null,
      label: "Repay",
    });
    if (!gas.ok) return { success: false, error: gas.error || "Could not cover the network gas for this repay." };

    // 5) Pure plan -> SDK ix.
    const plan = planRepayPartial(nftId, isMax ? "max" : repayRaw);
    const borrow = await import("@jup-ag/lend/borrow");
    const BN = (await import("bn.js")).default;
    const connection = getServerConnection();
    const signer = new PublicKey(params.agentPublicKey);

    let operate;
    try {
      operate = await borrow.getOperateIx({
        vaultId: cfg.vaultId,
        positionId: plan.positionId,
        colAmount: specToBN(BN, plan.colAmount, "col", borrow.MAX_WITHDRAW_AMOUNT, borrow.MAX_REPAY_AMOUNT),
        debtAmount: specToBN(BN, plan.debtAmount, "debt", borrow.MAX_WITHDRAW_AMOUNT, borrow.MAX_REPAY_AMOUNT),
        connection,
        signer,
      });
    } catch (e: any) {
      return { success: false, error: `Could not build the repay transaction: ${e?.message || e}` };
    }
    if (!operate?.ixs?.length) return { success: false, error: "Repay transaction had no instructions." };

    const op = await storage.createBorrowOperation({
      walletAddress: params.walletAddress,
      borrowPositionId: position!.id,
      operationType: "repay_agent_usdc",
      status: "pending",
      step: "gate_passed",
    });

    // 6) THE money move (confirm-only: USDC leaves, no positive delta to verify).
    const exec = await executeAgentInstructionsConfirmOnly({
      agentPublicKey: params.agentPublicKey,
      agentSecretKey: params.agentSecretKey,
      instructions: operate.ixs,
      gasDestMint: null,
      addressLookupTables: operate.addressLookupTableAccounts,
      label: "Repay",
    });

    // 7) Provably-nothing-moved => mark failed (safe; USDC still in the wallet).
    if (exec.onChainFailed || !exec.signature) {
      await storage.updateBorrowOperation(op.id, { status: "failed", step: "exec_failed", error: exec.error || "repay failed", ...(exec.signature ? { appendTxSignature: exec.signature } : {}) });
      return { success: false, signature: exec.signature, error: exec.error || "Repay failed." };
    }

    // 8) AUTHORITATIVE re-read is the proof. Fail CLOSED on the dangerous
    //    direction: never record LESS debt than the chain proves.
    const after = await borrowRoute.readLivePositionHealth(position!.collateralMint, nftId);
    let observedColRaw: bigint;
    let observedDebtRaw: bigint;
    let oraclePriceUsd: number | null = null;
    let healthSource: string;
    let verifyWarning: string | undefined;
    let fullyRepaid = false;

    if (after) {
      observedColRaw = BigInt(after.collateralRaw);
      observedDebtRaw = BigInt(after.debtRaw);
      oraclePriceUsd = after.oraclePriceUsd;
      healthSource = "repay_onchain";
      const v = verifyRepayOutcome({ preDebtRaw, postDebtRaw: observedDebtRaw, repaidRaw: repayRaw, fullRepay: isMax });
      if (v.ok) {
        fullyRepaid = isMax || observedDebtRaw <= 0n;
      } else {
        verifyWarning = `Repay sent (signature ${exec.signature}) but the position read differs (${v.reason}). Recorded the on-chain debt.`;
        console.warn(`[Borrow] repay verify miss: ${v.reason}`, { positionId: position!.id, nftId });
      }
    } else {
      // Confirmed but unreadable: KEEP the higher pre-debt so we never under-report.
      observedColRaw = BigInt(position!.collateralAmountRaw);
      observedDebtRaw = preDebtRaw;
      healthSource = "repay_unverified";
      verifyWarning = `Repay confirmed (signature ${exec.signature}) but the position could not be re-read; kept the prior debt pending reconcile.`;
      console.warn("[Borrow] repay could not re-read position", { positionId: position!.id, nftId });
    }

    const health = buildHealthSnapshot(cfg, observedColRaw, observedDebtRaw, oraclePriceUsd, healthSource);
    let dbWarning: string | undefined;
    const updated = await storage.updateBorrowPosition(
      position!.id,
      {
        status: "open",
        collateralAmountRaw: observedColRaw.toString(),
        debtAmountRaw: observedDebtRaw.toString(),
        healthSnapshot: health.snapshot,
        healthAsOf: new Date(),
        healthSource,
      },
      "open",
    );
    if (!updated) {
      dbWarning = `Repay confirmed (signature ${exec.signature}) but the position record was updated by another process.`;
      console.warn("[Borrow] repay CAS lost", { positionId: position!.id });
    }
    await storage.updateBorrowOperation(op.id, { status: "succeeded", step: fullyRepaid ? "repay_full_confirmed" : "repay_confirmed", appendTxSignature: exec.signature });

    return {
      success: true,
      signature: exec.signature,
      repaidUsdc: fromRaw(after ? (preDebtRaw - observedDebtRaw > 0n ? preDebtRaw - observedDebtRaw : 0n) : repayRaw, cfg.debtDecimals),
      observedDebtRaw: observedDebtRaw.toString(),
      fullyRepaid,
      verifyWarning,
      dbWarning,
    };
  });
}

// --- WITHDRAW collateral ----------------------------------------------------

export interface WithdrawCollateralParams {
  walletAddress: string;
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  borrowPositionId: string;
  /** Collateral to withdraw, raw base units; or "max" to withdraw to the cap. */
  amount: bigint | "max";
  /**
   * OPTIONAL write-ahead durability hook forwarded to `executeAgentInstructions`,
   * fired AFTER signing but STRICTLY BEFORE the withdraw tx is broadcast. A
   * multi-hop deleverage orchestrator uses it to durably record the withdraw
   * signature BEFORE broadcast so a crash mid-withdraw is reconciled by signature
   * status (never by a stale wallet balance) and "no sig recorded" provably means
   * "never broadcast". FATAL: throwing aborts the withdraw before it is sent.
   */
  onBeforeBroadcast?: (info: { signature: string; blockhash: string; lastValidBlockHeight: number }) => void | Promise<void>;
}

export interface WithdrawCollateralResult {
  success: boolean;
  signature?: string;
  collateralReturned?: number;
  observedCollateralRaw?: string;
  verifyWarning?: string;
  dbWarning?: string;
  error?: string;
}

export async function executeWithdrawCollateral(params: WithdrawCollateralParams): Promise<WithdrawCollateralResult> {
  if (params.amount !== "max" && params.amount <= 0n) {
    return { success: false, error: "Withdraw amount must be greater than zero." };
  }

  const loaded = await loadOpenAccountPosition(params.walletAddress, params.borrowPositionId);
  if (!loaded.ok) return { success: false, error: loaded.error };
  const { position, nftId } = loaded;

  const borrowRoute = new JupiterLendBorrowRoute();
  const cfg = await borrowRoute.getVaultConfig(position!.collateralMint);
  if (!cfg) return { success: false, error: "Borrow vault is unavailable right now." };

  return withBorrowLock(borrowLockKey(params.walletAddress, null, cfg.vaultId), async () => {
    // 1) LIVE position read — collateral + debt. Fail CLOSED if unreadable.
    const live = await borrowRoute.readLivePositionHealth(position!.collateralMint, nftId);
    if (!live) return { success: false, error: "Could not read the live position; refusing to withdraw." };
    const preColRaw = BigInt(live.collateralRaw);
    const liveDebtRaw = BigInt(live.debtRaw);
    if (preColRaw <= 0n) return { success: false, error: "This position has no collateral to withdraw." };

    // 2) ENFORCED collateral-withdraw gate (oracle required only when debt remains).
    const oracle = await readBorrowOracleContext(cfg);
    const decision = evaluateCollateralWithdraw({
      vault: cfg,
      liveCollateralRaw: preColRaw,
      liveDebtRaw,
      requestedWithdrawRaw: params.amount,
      oracle,
    });
    if (!decision.allowed) {
      const deny = decision.reasons?.find((r) => r.severity === "deny");
      return { success: false, error: deny?.message || "This withdrawal is not allowed under the risk limits." };
    }

    // 3) Resolve the withdraw leg. With debt, a "max" MUST resolve to the gate's
    //    EXACT maxWithdrawableRaw (never the protocol MAX_WITHDRAW sentinel, which
    //    withdraws down to the looser collateral factor). With NO debt, the
    //    sentinel cleanly pulls everything.
    const isMax = params.amount === "max";
    const fullWithdraw = isMax && liveDebtRaw <= 0n;
    let withdrawArg: bigint | "max";
    let intendedRaw: bigint;
    if (isMax && liveDebtRaw > 0n) {
      const maxRaw = decision.maxWithdrawableRaw ? BigInt(decision.maxWithdrawableRaw) : 0n;
      if (maxRaw <= 0n) return { success: false, error: "No collateral can be safely withdrawn at the current price." };
      withdrawArg = maxRaw;
      intendedRaw = maxRaw;
    } else if (isMax) {
      withdrawArg = "max";
      intendedRaw = preColRaw;
    } else {
      withdrawArg = params.amount as bigint;
      intendedRaw = params.amount as bigint;
    }

    // 4) Gas: collateral RETURNS to the wallet -> cover first-time ATA rent + fee.
    const gas = await ensureVaultGas({
      payingPublicKey: params.agentPublicKey,
      funderPublicKey: params.agentPublicKey,
      funderSecretKey: params.agentSecretKey,
      destMint: position!.collateralMint,
      label: "Withdraw",
    });
    if (!gas.ok) return { success: false, error: gas.error || "Could not cover the network gas for this withdrawal." };

    // 5) Pure plan -> SDK ix.
    const plan = planWithdrawPartial(nftId, withdrawArg);
    const borrow = await import("@jup-ag/lend/borrow");
    const BN = (await import("bn.js")).default;
    const connection = getServerConnection();
    const signer = new PublicKey(params.agentPublicKey);

    let operate;
    try {
      operate = await borrow.getOperateIx({
        vaultId: cfg.vaultId,
        positionId: plan.positionId,
        colAmount: specToBN(BN, plan.colAmount, "col", borrow.MAX_WITHDRAW_AMOUNT, borrow.MAX_REPAY_AMOUNT),
        debtAmount: specToBN(BN, plan.debtAmount, "debt", borrow.MAX_WITHDRAW_AMOUNT, borrow.MAX_REPAY_AMOUNT),
        connection,
        signer,
      });
    } catch (e: any) {
      return { success: false, error: `Could not build the withdraw transaction: ${e?.message || e}` };
    }
    if (!operate?.ixs?.length) return { success: false, error: "Withdraw transaction had no instructions." };

    const op = await storage.createBorrowOperation({
      walletAddress: params.walletAddress,
      borrowPositionId: position!.id,
      operationType: "withdraw_collateral",
      status: "pending",
      step: "gate_passed",
    });

    // 6) THE money move: verify a POSITIVE COLLATERAL delta returns to the wallet.
    const exec = await executeAgentInstructions({
      agentPublicKey: params.agentPublicKey,
      agentSecretKey: params.agentSecretKey,
      instructions: operate.ixs,
      verifyOutputMint: position!.collateralMint,
      addressLookupTables: operate.addressLookupTableAccounts,
      label: "Withdraw collateral",
      onBeforeBroadcast: params.onBeforeBroadcast,
    });

    // 7) Decide whether money moved (mirror CLOSE: a returned signature we cannot
    //    disprove is recorded, never finalized on an unconfirmed read).
    let collateralDeltaRaw: bigint;
    let preReadLive: Awaited<ReturnType<typeof borrowRoute.readLivePositionHealth>> = null;
    const recovered = !(exec.success && exec.outputReceivedRaw);
    if (!recovered) {
      collateralDeltaRaw = BigInt(exec.outputReceivedRaw!);
    } else if (!exec.signature || exec.onChainFailed) {
      await storage.updateBorrowOperation(op.id, { status: "failed", step: "exec_failed", error: exec.error || "withdraw failed", ...(exec.signature ? { appendTxSignature: exec.signature } : {}) });
      return { success: false, signature: exec.signature, error: exec.error || "Withdrawal failed." };
    } else {
      preReadLive = await borrowRoute.readLivePositionHealth(position!.collateralMint, nftId);
      if (preReadLive && BigInt(preReadLive.collateralRaw) >= preColRaw) {
        // Definitive read: collateral did not shrink -> nothing moved.
        await storage.updateBorrowOperation(op.id, { status: "failed", step: "exec_failed", error: exec.error || "withdraw failed", appendTxSignature: exec.signature });
        return { success: false, signature: exec.signature, error: exec.error || "Withdrawal failed." };
      }
      collateralDeltaRaw = preReadLive ? preColRaw - BigInt(preReadLive.collateralRaw) : intendedRaw;
    }

    // 8) Read AUTHORITATIVE collateral; persist reality.
    const after = preReadLive ?? await borrowRoute.readLivePositionHealth(position!.collateralMint, nftId);
    let observedColRaw: bigint;
    let observedDebtRaw: bigint;
    let oraclePriceUsd: number | null = null;
    let healthSource: string;
    if (after) {
      observedColRaw = BigInt(after.collateralRaw);
      observedDebtRaw = BigInt(after.debtRaw);
      oraclePriceUsd = after.oraclePriceUsd;
      healthSource = "withdraw_onchain";
    } else {
      // Conservative: assume the intended collateral left. Never over-report
      // remaining collateral (a live re-read self-heals).
      observedColRaw = preColRaw > intendedRaw ? preColRaw - intendedRaw : 0n;
      observedDebtRaw = liveDebtRaw;
      healthSource = "withdraw_unverified";
    }

    let verifyWarning: string | undefined;
    if (recovered) {
      verifyWarning = `Withdraw execution reported an error but the transaction was sent (signature ${exec.signature}); recorded the on-chain position.`;
      console.warn("[Borrow] withdraw recovered from reported exec failure", { positionId: position!.id, nftId, hadLiveRead: !!after });
    }
    if (after) {
      const v = verifyWithdrawOutcome({ preColRaw, postColRaw: observedColRaw, collateralDeltaRaw, withdrawnRaw: intendedRaw, fullWithdraw });
      if (!v.ok) {
        const miss = `Withdraw landed (signature ${exec.signature}) but the position read differs (${v.reason}). Recorded the on-chain collateral.`;
        verifyWarning = verifyWarning ? `${verifyWarning} ${miss}` : miss;
        console.warn(`[Borrow] withdraw verify miss: ${v.reason}`, { positionId: position!.id, nftId });
      }
    } else {
      const unread = `Withdraw landed (signature ${exec.signature}) but the position could not be re-read; recorded a conservative estimate pending reconcile.`;
      verifyWarning = verifyWarning ? `${verifyWarning} ${unread}` : unread;
    }

    // A full close-out (no collateral AND no debt) marks the position closed.
    const nowEmpty = observedColRaw <= 0n && observedDebtRaw <= 0n;
    const nextStatus = nowEmpty ? "closed" : "open";
    const health = buildHealthSnapshot(cfg, observedColRaw, observedDebtRaw, oraclePriceUsd, nowEmpty ? "closed" : healthSource);
    let dbWarning: string | undefined;
    const updated = await storage.updateBorrowPosition(
      position!.id,
      {
        status: nextStatus,
        collateralAmountRaw: observedColRaw.toString(),
        debtAmountRaw: observedDebtRaw.toString(),
        healthSnapshot: health.snapshot,
        healthAsOf: new Date(),
        healthSource: nowEmpty ? "closed" : healthSource,
      },
      "open",
    );
    if (!updated) {
      dbWarning = `Withdraw confirmed (signature ${exec.signature}) but the position record was updated by another process.`;
      console.warn("[Borrow] withdraw CAS lost", { positionId: position!.id });
    }
    await storage.updateBorrowOperation(op.id, { status: "succeeded", step: nowEmpty ? "withdraw_closed" : "withdraw_confirmed", appendTxSignature: exec.signature });

    return {
      success: true,
      signature: exec.signature,
      collateralReturned: fromRaw(collateralDeltaRaw, cfg.collateralDecimals),
      observedCollateralRaw: observedColRaw.toString(),
      verifyWarning,
      dbWarning,
    };
  });
}
