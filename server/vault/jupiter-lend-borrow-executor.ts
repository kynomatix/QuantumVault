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
import {
  planBorrowOpen,
  planBorrowClose,
  verifyOpenOutcome,
  verifyCloseOutcome,
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
async function withBorrowLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
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
