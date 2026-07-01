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
  transferTokenToWalletExact,
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
  capPositiveCollateralDeposit,
  resolveRepaidHistoryRaw,
  type AmountSpec,
} from "./borrow-engine-core";

const DEBT_VENUE = "jupiter_lend";
/** Extra USDC headroom over the read debt to absorb interest accrued before the
 *  repay tx lands. 50 bps — purely a pre-flight guard; the operate is atomic.
 *  Exported so the unified USDC-pool repay can size a Vault top-up to land the
 *  agent wallet at/above the executor's "max" balance bar (debt + this buffer). */
export const REPAY_BUFFER_BPS = 50;
/**
 * Rent a FIRST-TIME supply/open must pay to mint a new Jupiter Lend position NFT
 * (the mint, its Metaplex metadata + master-edition, and the NFT token account).
 * The metadata account alone is ~0.0151 SOL; the full set is ~0.022 SOL. We budget
 * 0.03 SOL of headroom so the gas top-up clears the bar and the on-chain mint can
 * never revert mid-instruction with "insufficient lamports". Leftover SOL stays in
 * the agent wallet, usable for future gas. Adding to an EXISTING position does not
 * mint an NFT and so needs none of this. (1 SOL = 1e9 lamports.) */
const NEW_POSITION_MINT_RENT_LAMPORTS = 30_000_000;

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
  /**
   * The SIGNING wallet that holds the collateral, mints the position NFT, and
   * receives the borrowed USDC. Account scope = the main agent wallet; per-bot
   * (Flash) scope = the bot's OWN isolated wallet.
   */
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  /** Collateral mint that resolves the Jupiter Lend vault (e.g. INF -> vault 43). */
  collateralMint: string;
  /** Collateral to deposit, raw base units. Must already sit in the agent wallet. */
  collateralRaw: bigint;
  /** USDC to borrow, raw base units (6 dp). */
  requestedDebtRaw: bigint;
  /**
   * Per-bot (Flash) borrow: the bot id this position belongs to. Account scope =
   * null. When set, the signer (agentPublicKey) is the bot's OWN wallet and a
   * separate account funder backstops its gas; the risk gate allows "bot" scope
   * only for the owner wallet (owner-only proving).
   */
  tradingBotId?: string | null;
  /**
   * OPTIONAL gas funder. A per-bot signer should not be forced to hold SOL for
   * rent/fees, so the account agent funds the gas. Omit for account scope (the
   * signer funds its own gas, byte-identical to before).
   */
  funderPublicKey?: string;
  funderSecretKey?: Uint8Array;
  /**
   * Per-bot scope: the bot's LIVE existing debt for this collateral (0 for a
   * fresh open). Bypasses the wallet-wide cache sum so the per-position LTV
   * projection counts only THIS bot's debt, never sibling bots'.
   */
  existingDebtRawOverride?: bigint;
  /**
   * OPTIONAL write-ahead hook. Invoked with the freshly-created position row id
   * AFTER the row is persisted but BEFORE the open transaction is broadcast. A
   * resumable orchestrator (per-bot carve) uses this to durably link the bot
   * position id onto its own operation BEFORE any money moves, so a crash in the
   * broadcast window can always recognise this run's own position on resume
   * (never adopt a foreign one). Awaited; if it throws, the open aborts before
   * broadcast (fail-closed — no money moves). Account scope omits it (no-op).
   */
  onPositionCreated?: (positionId: string) => Promise<void>;
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
  // Per-bot (Flash) borrowing is in owner-only proving (Phase 0). The risk gate
  // (re-run below, immediately before signing) is the authoritative scope guard:
  // it ALLOWS "bot" scope ONLY for the owner wallet and denies it otherwise, so a
  // stray bot id can never open a borrow for a non-owner. The public open route
  // always passes tradingBotId=null, so account scope stays byte-identical.
  if (params.collateralRaw <= 0n) return { success: false, error: "Collateral must be greater than zero." };
  if (params.requestedDebtRaw <= 0n) return { success: false, error: "Borrow amount must be greater than zero." };

  const borrowRoute = new JupiterLendBorrowRoute();
  const cfg = await borrowRoute.getVaultConfig(params.collateralMint);
  if (!cfg) return { success: false, error: "Borrow vault is unavailable right now." };

  return withBorrowLock(borrowLockKey(params.walletAddress, tradingBotId, cfg.vaultId), async () => {
    // 0) Strict collateral balance (fail CLOSED). The collateral must already sit
    //    in the agent wallet. Fluid rounds an exact-balance deposit UP by ~1 raw
    //    unit, so cap the deposit one wei below the held balance (never sweep the
    //    exact balance, or the supply CPI reverts SPL "insufficient funds").
    let heldColRaw: bigint;
    try {
      heldColRaw = BigInt((await getAgentTokenBalanceRawStrict(params.agentPublicKey, params.collateralMint)).amountRaw);
    } catch {
      return { success: false, error: "Could not read the collateral balance; refusing to borrow." };
    }
    if (heldColRaw < params.collateralRaw) {
      return { success: false, error: `Not enough ${cfg.collateralSymbol} in the trading wallet to deposit.` };
    }
    const effectiveCollateralRaw = capPositiveCollateralDeposit(params.collateralRaw, heldColRaw);
    if (effectiveCollateralRaw <= 0n) {
      return { success: false, error: `Not enough ${cfg.collateralSymbol} in the trading wallet to deposit.` };
    }

    // 1) ENFORCED risk gate, re-run immediately before signing. Use the EFFECTIVE
    //    collateral (what will actually back the loan) so the gate stays truthful.
    const elig = await previewBorrowEligibility(
      params.walletAddress,
      {
        collateralMint: params.collateralMint,
        collateralRaw: effectiveCollateralRaw,
        requestedDebtRaw: params.requestedDebtRaw,
        // Per-bot (Flash) scope is gated to the owner in the risk policy; the
        // public open route always passes tradingBotId=null (account scope).
        scope: tradingBotId ? "bot" : "account",
        // Per-bot: count ONLY this bot's existing debt for this collateral (a
        // fresh open = 0), bypassing the wallet-wide cache sum that would fold
        // in sibling bots' borrows and mis-state the per-position LTV.
        ...(tradingBotId ? { existingDebtRawOverride: params.existingDebtRawOverride ?? 0n } : {}),
      },
      buildEligibilityDeps(borrowRoute),
    );
    if (!elig.ok) return { success: false, error: "Could not fully evaluate borrow risk; refusing to borrow." };
    if (!elig.allowed) {
      const deny = elig.reasons?.find((r) => r.severity === "deny");
      return { success: false, error: deny?.message || "This borrow is not allowed under the risk limits." };
    }

    // 1b) NFT REUSE: instead of MINTING a fresh position NFT (~0.022 SOL rent),
    //     prefer re-depositing into a previously fully-closed (empty but on-chain-
    //     alive) position of THIS SAME scope. A full close zeroes the position yet
    //     leaves the NFT alive, so a reopen deposits+borrows into it and reclaims
    //     the rent already locked there. Fail CLOSED: reuse only when the chain
    //     PROVES the NFT empty; otherwise mint fresh (always safe). Applies to BOTH
    //     account (tradingBotId null) and per-bot scope — getBorrowPositions is
    //     already scoped by tradingBotId. The (wallet,vault,bot) borrow lock
    //     serializes opens, so a candidate can't be claimed by a concurrent open.
    let reuseCandidate: (Awaited<ReturnType<typeof storage.getBorrowPosition>> & {}) | null = null;
    {
      const scopeRows = await storage.getBorrowPositions(params.walletAddress, tradingBotId);
      const closedCandidates = scopeRows.filter(
        (p) =>
          p.status === "closed" &&
          p.collateralMint === params.collateralMint &&
          (p.tradingBotId ?? null) === tradingBotId &&
          Number.isInteger(Number(p.venuePositionId)) &&
          Number(p.venuePositionId) > 0,
      ); // getBorrowPositions is newest-first, so the most recent close wins
      for (const cand of closedCandidates) {
        if (await borrowRoute.isPositionEmptyReusable(params.collateralMint, Number(cand.venuePositionId))) {
          reuseCandidate = cand;
          break;
        }
      }
    }
    const reusing = !!reuseCandidate;
    // The SDK mints a fresh NFT for positionId 0; a real id reuses that position.
    const targetNftId = reusing ? Number(reuseCandidate!.venuePositionId) : 0;
    const willMint = !reusing;

    // 2) Gas: the agent wallet pays; account scope funds its own gas. MINTING a new
    //    position NFT costs ~0.022 SOL of mint/metadata/edition rent that must be
    //    budgeted on top of the tx fee + first-time USDC ATA rent, or the on-chain
    //    mint reverts "insufficient lamports". Reusing an empty closed position
    //    mints nothing, so it needs none of that extra rent.
    const gas = await ensureVaultGas({
      payingPublicKey: params.agentPublicKey,
      // Per-bot: the account agent funds the bot wallet's gas (the bot must not
      // be forced to hold SOL for rent/fees). Account scope: signer self-funds,
      // byte-identical to before (funder defaults to the signer).
      funderPublicKey: params.funderPublicKey ?? params.agentPublicKey,
      funderSecretKey: params.funderSecretKey ?? params.agentSecretKey,
      destMint: USDC_MINT,
      label: "Borrow",
      extraRentLamports: willMint ? NEW_POSITION_MINT_RENT_LAMPORTS : 0,
    });
    if (!gas.ok) return { success: false, error: gas.error || "Could not cover the network gas for this borrow." };

    // 3) Pure plan -> SDK instructions (lazy import; positionId 0 mints a new NFT,
    //    a real targetNftId reuses an empty closed position).
    const plan = planBorrowOpen({ collateralRaw: effectiveCollateralRaw, debtRaw: params.requestedDebtRaw, positionId: targetNftId });
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

    // A fresh mint returns its new nftId on `operate`; a reuse targets the empty
    // closed position we resolved above.
    const nftId = willMint ? Number(operate.nftId) : targetNftId;

    // 4) Resumable record: a 'pending' position + an op log row, written BEFORE
    //    signing. We persist the predicted nftId and a CONSERVATIVE liability (the
    //    requested debt) up front so a crash between send and the post-confirm
    //    write can never lose the position linkage or under-report the debt
    //    (sumOpenBorrowDebtUsdc counts every non-closed/non-failed row, so a
    //    pending row already shows as a liability). The authoritative on-chain
    //    amounts overwrite these after confirmation; a pre-send failure marks the
    //    row failed (excluded again) before any money moves. When REUSING an empty
    //    closed position we reactivate that row (CAS closed -> pending) instead of
    //    creating a new one, so the rest of the flow treats it exactly like a fresh
    //    pending row (the final CAS pending -> open below is identical).
    let position: Awaited<ReturnType<typeof storage.createBorrowPosition>>;
    if (reusing) {
      const reclaimed = await storage.updateBorrowPosition(
        reuseCandidate!.id,
        {
          status: "pending",
          venuePositionId: String(nftId),
          collateralAmountRaw: effectiveCollateralRaw.toString(),
          debtAmountRaw: params.requestedDebtRaw.toString(),
        },
        "closed",
      );
      if (!reclaimed) {
        return { success: false, error: "That position changed state; please try again." };
      }
      position = reclaimed;
    } else {
      position = await storage.createBorrowPosition({
        walletAddress: params.walletAddress,
        tradingBotId,
        debtVenue: DEBT_VENUE,
        venueVaultId: String(cfg.vaultId),
        venuePositionId: String(nftId),
        collateralAssetKey: cfg.collateralSymbol.toLowerCase(),
        collateralMint: cfg.collateralMint,
        collateralAmountRaw: effectiveCollateralRaw.toString(),
        debtAssetKey: "usdc",
        debtMint: cfg.debtMint,
        debtAmountRaw: params.requestedDebtRaw.toString(),
        status: "pending",
      });
    }
    const op = await storage.createBorrowOperation({
      walletAddress: params.walletAddress,
      borrowPositionId: position.id,
      operationType: "borrow_open",
      status: "pending",
      step: "gate_passed",
    });

    // 4b) WRITE-AHEAD link (resumable orchestrators): durably record this row's id
    //     on the caller's operation BEFORE the broadcast, so a crash in the send
    //     window can recognise this run's own position on resume. Awaited and
    //     fail-closed: a throw here aborts BEFORE money moves.
    if (params.onPositionCreated) await params.onPositionCreated(position.id);

    // 5) THE money move: sign/send/confirm + verify a POSITIVE USDC delta.
    const exec = await executeAgentInstructions({
      agentPublicKey: params.agentPublicKey,
      agentSecretKey: params.agentSecretKey,
      instructions: operate.ixs,
      verifyOutputMint: USDC_MINT,
      addressLookupTables: operate.addressLookupTableAccounts,
      label: "Borrow open",
    });

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
      // A reused position is still empty on-chain (nothing moved), so return it to
      // 'closed' to stay reuse-eligible; a fresh mint that never landed -> 'failed'.
      await storage.updateBorrowPosition(position.id, { status: reusing ? "closed" : "failed" }, "pending");
      return { success: false, signature: exec.signature, error: exec.error || "Borrow failed." };
    } else {
      // Signature exists, tx was NOT reported as an on-chain failure, but the USDC
      // delta could not be verified (RPC lag / fail-open read). Probe the position
      // by nftId to disambiguate.
      preReadLive = await borrowRoute.readLivePositionHealth(params.collateralMint, nftId);
      if (preReadLive && BigInt(preReadLive.debtRaw) <= 0n && BigInt(preReadLive.collateralRaw) <= 0n) {
        // Definitive read: nothing on-chain -> no money moved.
        await storage.updateBorrowOperation(op.id, { status: "failed", step: "exec_failed", error: exec.error || "borrow open failed", appendTxSignature: exec.signature });
        // Reused NFT proven still empty -> back to 'closed' (reuse-eligible); a
        // fresh mint that never landed -> 'failed'.
        await storage.updateBorrowPosition(position.id, { status: reusing ? "closed" : "failed" }, "pending");
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
      observedColRaw = effectiveCollateralRaw;
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
        requestedCollateralRaw: effectiveCollateralRaw,
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

    // 9) History row (LIABILITY: borrowed USDC adds debt, it is NOT a deposit).
    //    Non-fatal: the money already moved and the position is persisted, so a
    //    history-write hiccup must never fail a settled borrow. Excluded from
    //    net-deposited (equity-events-util) so it can't inflate PnL. Amount is the
    //    REALIZED on-chain USDC delta; notes carry the collateral so the client
    //    can render "Borrow USDC Against <SYMBOL>".
    try {
      const borrowedUsd = fromRaw(usdcDeltaRaw, cfg.debtDecimals);
      if (borrowedUsd > 0) {
        const collateralAmt = fromRaw(observedColRaw, cfg.collateralDecimals);
        await storage.createEquityEvent({
          walletAddress: params.walletAddress,
          tradingBotId,
          eventType: "borrow",
          amount: new Decimal(borrowedUsd).toFixed(6),
          assetType: "USDC",
          txSignature: exec.signature ?? null,
          notes: `Borrowed ${new Decimal(borrowedUsd).toFixed(6)} USDC against ${new Decimal(collateralAmt).toFixed(6)} ${cfg.collateralSymbol}`,
        });
      }
    } catch (e) {
      console.warn("[Borrow] open: failed to record equity event (non-fatal)", e);
    }

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
  /** The SIGNING wallet that repays the debt + receives the returned collateral. */
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  /** Our DB borrow_positions row id. */
  borrowPositionId: string;
  /**
   * OPTIONAL gas funder for a per-bot close: the account agent backstops the bot
   * wallet's gas. Its PRESENCE also marks the caller as per-bot-aware — the
   * account-scope (public) close path passes no funder, so a per-bot position
   * reached via that path is rejected rather than repaid from the wrong wallet.
   */
  funderPublicKey?: string;
  funderSecretKey?: Uint8Array;
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
  // The signer must own the on-chain position. A per-bot (Flash) position lives
  // on the bot's OWN wallet, so it can only be closed by the per-bot caller that
  // passes the bot wallet as the signer + an account gas funder. The account-
  // scope (public) close path provides NO funder -> reject a per-bot position
  // here so it can never be repaid/withdrawn from the wrong (account) wallet.
  if (position.tradingBotId && !params.funderPublicKey) {
    return { success: false, finalized: false, error: "This is a per-bot loan; close it from the bot's own borrow path." };
  }

  const nftId = Number(position.venuePositionId);
  if (!Number.isInteger(nftId) || nftId <= 0) {
    return { success: false, finalized: false, error: "Borrow position has an invalid on-chain id." };
  }

  const borrowRoute = new JupiterLendBorrowRoute();
  const cfg = await borrowRoute.getVaultConfig(position.collateralMint);
  if (!cfg) return { success: false, finalized: false, error: "Borrow vault is unavailable right now." };

  return withBorrowLock(borrowLockKey(params.walletAddress, position.tradingBotId ?? null, cfg.vaultId), async () => {
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
      // Per-bot: the account agent funds the bot wallet's gas. Account scope:
      // signer self-funds (funder defaults to the signer), byte-identical.
      funderPublicKey: params.funderPublicKey ?? params.agentPublicKey,
      funderSecretKey: params.funderSecretKey ?? params.agentSecretKey,
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
  // Populated when the supply failed purely because the agent wallet couldn't
  // cover network gas — lets the client offer an inline "top up just the
  // shortfall" deposit instead of a generic error.
  gasShortfall?: { requiredLamports: number; heldLamports: number };
}

export async function executeSupplyCollateral(params: SupplyCollateralParams): Promise<SupplyCollateralResult> {
  const tradingBotId = params.tradingBotId ?? null;
  if (tradingBotId) return { success: false, error: "Per-bot borrow scope is not supported yet (account scope only)." };
  if (params.collateralRaw <= 0n) return { success: false, error: "Collateral must be greater than zero." };

  const borrowRoute = new JupiterLendBorrowRoute();
  const cfg = await borrowRoute.getVaultConfig(params.collateralMint);
  if (!cfg) return { success: false, error: "Borrow vault is unavailable right now." };

  return withBorrowLock(borrowLockKey(params.walletAddress, tradingBotId, cfg.vaultId), async () => {
    // 1) Resolve the target position. Prefer add-to-existing over a 2nd NFT, and
    //    prefer REUSING a fully-closed (empty) position over minting a fresh one.
    let existing: (Awaited<ReturnType<typeof storage.getBorrowPosition>> & {}) | null = null;
    let reuseCandidate: (Awaited<ReturnType<typeof storage.getBorrowPosition>> & {}) | null = null;
    if (params.borrowPositionId) {
      const loaded = await loadOpenAccountPosition(params.walletAddress, params.borrowPositionId);
      if (!loaded.ok) return { success: false, error: loaded.error };
      if (loaded.position!.collateralMint !== params.collateralMint) {
        return { success: false, error: "Collateral mint does not match the selected position." };
      }
      existing = loaded.position!;
    } else {
      const all = await storage.getBorrowPositions(params.walletAddress, null);
      const open = all.filter(
        (p) => p.status === "open" && p.collateralMint === params.collateralMint && !p.tradingBotId,
      );
      if (open.length > 1) {
        return { success: false, error: "You have multiple open positions for this collateral; choose which one to add to." };
      }
      existing = open[0] ?? null;

      // No open position for this collateral: instead of MINTING a fresh position
      // NFT (~0.022 SOL rent), try to REUSE a previously fully-closed position. A
      // full close leaves the position NFT alive on-chain but zeroed, so we can
      // re-deposit into it — avoiding a new mint AND consuming the rent already
      // locked in that empty NFT. Fail closed: only reuse when the chain proves
      // it is empty; otherwise fall through to a fresh mint.
      if (!existing) {
        const closedCandidates = all.filter(
          (p) =>
            p.status === "closed" &&
            p.collateralMint === params.collateralMint &&
            !p.tradingBotId &&
            Number.isInteger(Number(p.venuePositionId)) &&
            Number(p.venuePositionId) > 0,
        ); // getBorrowPositions is newest-first, so the most recent close wins
        for (const cand of closedCandidates) {
          if (await borrowRoute.isPositionEmptyReusable(params.collateralMint, Number(cand.venuePositionId))) {
            reuseCandidate = cand;
            break;
          }
        }
      }
    }

    const reusing = !existing && !!reuseCandidate;
    const targetNftId = existing
      ? Number(existing.venuePositionId)
      : reusing
        ? Number(reuseCandidate!.venuePositionId)
        : 0;
    if (existing && (!Number.isInteger(targetNftId) || targetNftId <= 0)) {
      return { success: false, error: "Selected position has an invalid on-chain id." };
    }
    // We MINT a new NFT only when there is neither an open position to add to nor
    // an empty closed one to reuse.
    const willMint = targetNftId === 0;

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
    // Fluid rounds an exact-balance deposit UP by ~1 raw unit (see
    // capPositiveCollateralDeposit), so cap one wei below the held balance — a
    // full-balance sweep reverts the supply CPI with SPL "insufficient funds".
    const effectiveCollateralRaw = capPositiveCollateralDeposit(params.collateralRaw, colBal);
    if (effectiveCollateralRaw <= 0n) {
      return { success: false, error: `Not enough ${cfg.collateralSymbol} in the trading wallet to supply.` };
    }

    // 3) Gas: collateral only LEAVES the wallet, so no inbound ATA rent. BUT
    //    MINTING a new position NFT costs ~0.022 SOL of mint/metadata/edition rent
    //    that must be budgeted or the on-chain mint reverts "insufficient
    //    lamports". Adding to an existing position OR reusing an empty closed one
    //    mints nothing, so it needs none of this.
    const gas = await ensureVaultGas({
      payingPublicKey: params.agentPublicKey,
      funderPublicKey: params.agentPublicKey,
      funderSecretKey: params.agentSecretKey,
      destMint: null,
      label: "Add Collateral",
      extraRentLamports: willMint ? NEW_POSITION_MINT_RENT_LAMPORTS : 0,
    });
    if (!gas.ok) return {
      success: false,
      error: gas.error || "Could not cover the network gas to add collateral.",
      // Reflect any SOL already raised by a partial server-side gas top-up so the
      // popup doesn't overstate the remaining shortfall (no extra RPC needed).
      gasShortfall: {
        requiredLamports: gas.requiredLamports,
        heldLamports: gas.payerLamportsBefore + (gas.refilledLamports ?? 0) + (gas.fundedLamports ?? 0),
      },
    };

    // 4) Pre-read live collateral (0 for a new mint or a reused empty position) —
    //    the supply proof baseline.
    const preLive = !willMint ? await borrowRoute.readLivePositionHealth(params.collateralMint, targetNftId) : null;
    const preColRaw = preLive ? BigInt(preLive.collateralRaw) : 0n;

    // 5) Pure plan -> SDK ix. positionId 0 mints a new supply-only NFT.
    const plan = planSupplyCollateral(targetNftId, effectiveCollateralRaw);
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

    const nftId = willMint ? Number(operate.nftId) : targetNftId;

    // 6) Resumable record BEFORE signing. A new mint gets a 'pending' position
    //    (collateral 0 — never over-report); an existing one just logs the op.
    let position = existing;
    if (!position) {
      if (reusing) {
        // Reactivate the empty closed position we're reusing: claim it
        // closed -> pending (CAS) so the rest of the flow treats it exactly like
        // a freshly-minted pending row (final CAS pending -> open below). The
        // per-(wallet,vault) borrow lock serializes ops, so this only loses to an
        // out-of-band change, in which case we bail without moving funds.
        const reclaimed = await storage.updateBorrowPosition(
          reuseCandidate!.id,
          { status: "pending", venuePositionId: String(nftId) },
          "closed",
        );
        if (!reclaimed) {
          return { success: false, error: "That position changed state; please try again." };
        }
        position = reclaimed;
      } else {
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

    // 8) Provably-nothing-moved => safe; funds still in the wallet. A reused
    //    position is still empty on-chain, so return it to 'closed' to stay
    //    eligible for reuse; a fresh mint that never landed becomes 'failed'.
    if (exec.onChainFailed || !exec.signature) {
      await storage.updateBorrowOperation(op.id, { status: "failed", step: "exec_failed", error: exec.error || "supply failed", ...(exec.signature ? { appendTxSignature: exec.signature } : {}) });
      if (!existing) await storage.updateBorrowPosition(position!.id, { status: reusing ? "closed" : "failed" }, "pending");
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
      const v = verifySupplyOutcome({ preColRaw, postColRaw: observedColRaw, depositedRaw: effectiveCollateralRaw });
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

// --- SUPPLY collateral to an EXISTING per-bot position (defend the loan) -----
// A NARROW sibling of executeSupplyCollateral for the per-bot collateral top-up
// orchestrator. Unlike the account-scope supply it:
//   * REQUIRES an already-open per-bot position (NO find/mint/reuse path — you
//     cannot "defend" a loan that does not exist), targeting its exact nftId;
//   * signs the supply with the BOT key (the bot wallet owns its position NFT)
//     and funds the bot's network gas from the ACCOUNT (funder) wallet;
//   * exposes a write-ahead `onBeforeBroadcast` so the multi-leg orchestrator can
//     reconcile a crash by signature status. The confirm-only money move has no
//     positive inbound delta, so the AUTHORITATIVE position re-read is the proof
//     and we fail CLOSED on the dangerous direction — never record MORE
//     collateral than the chain proves. `failed` (no money moved) leaves the
//     collateral safe in the bot wallet for a forward retry.
export interface SupplyToExistingBotPositionParams {
  walletAddress: string;
  tradingBotId: string;
  /** The bot wallet that OWNS the position NFT and SIGNS the supply. */
  botPublicKey: string;
  botSecretKey: Uint8Array;
  /** The account wallet that FUNDS the bot's network gas (server-signed). */
  accountPublicKey: string;
  accountSecretKey: Uint8Array;
  collateralMint: string;
  /** The exact per-bot borrow position row to add to (must be open on-chain). */
  borrowPositionId: string;
  /** Collateral to deposit, raw base units. Must already sit in the BOT wallet. */
  collateralRaw: bigint;
  onBeforeBroadcast?: (info: { signature: string; blockhash: string; lastValidBlockHeight: number }) => void | Promise<void>;
}

export interface SupplyToExistingBotPositionResult {
  success: boolean;
  signature?: string;
  observedCollateralRaw?: string;
  collateralValueUsd?: number | null;
  verifyWarning?: string;
  dbWarning?: string;
  /** TRUE when the tx landed but FAILED atomically (nothing committed). */
  onChainFailed?: boolean;
  error?: string;
  gasShortfall?: { requiredLamports: number; heldLamports: number };
}

export async function supplyToExistingBotPosition(
  params: SupplyToExistingBotPositionParams,
): Promise<SupplyToExistingBotPositionResult> {
  if (!params.tradingBotId) return { success: false, error: "A trading bot id is required." };
  if (params.collateralRaw <= 0n) return { success: false, error: "Collateral must be greater than zero." };

  const borrowRoute = new JupiterLendBorrowRoute();
  const cfg = await borrowRoute.getVaultConfig(params.collateralMint);
  if (!cfg) return { success: false, error: "Borrow vault is unavailable right now." };

  return withBorrowLock(borrowLockKey(params.walletAddress, params.tradingBotId, cfg.vaultId), async () => {
    // 1) Load + validate the EXISTING open per-bot position (no mint path).
    const position = await storage.getBorrowPosition(params.walletAddress, params.borrowPositionId);
    if (!position) return { success: false, error: "Borrow position not found." };
    if (position.tradingBotId !== params.tradingBotId) {
      return { success: false, error: "Borrow position does not belong to this bot." };
    }
    if (position.status !== "open") return { success: false, error: `Borrow position is not open (status: ${position.status}).` };
    if (position.collateralMint !== params.collateralMint) {
      return { success: false, error: "Collateral mint does not match the position." };
    }
    const nftId = Number(position.venuePositionId);
    if (!Number.isInteger(nftId) || nftId <= 0) return { success: false, error: "Borrow position has no valid on-chain id." };

    // 2) Strict balance: the BOT wallet must actually hold the collateral. Fail
    //    CLOSED if unreadable (never sign against an unknown balance).
    let colBal: bigint;
    try {
      colBal = BigInt((await getAgentTokenBalanceRawStrict(params.botPublicKey, params.collateralMint)).amountRaw);
    } catch {
      return { success: false, error: "Could not read the bot collateral balance; refusing to supply." };
    }
    if (colBal < params.collateralRaw) {
      return { success: false, error: `Not enough ${cfg.collateralSymbol} in the bot wallet to supply.` };
    }
    // Fluid rounds an exact-balance deposit UP by ~1 raw unit (see
    // capPositiveCollateralDeposit), so cap one wei below the held balance.
    const effectiveCollateralRaw = capPositiveCollateralDeposit(params.collateralRaw, colBal);
    if (effectiveCollateralRaw <= 0n) {
      return { success: false, error: `Not enough ${cfg.collateralSymbol} in the bot wallet to supply.` };
    }

    // 3) Gas: collateral only LEAVES the wallet and we add to an EXISTING NFT (no
    //    mint), so no inbound ATA rent and no mint rent. The BOT pays; the ACCOUNT
    //    funds any shortfall.
    const gas = await ensureVaultGas({
      payingPublicKey: params.botPublicKey,
      funderPublicKey: params.accountPublicKey,
      funderSecretKey: params.accountSecretKey,
      destMint: null,
      label: "Add Collateral",
      extraRentLamports: 0,
    });
    if (!gas.ok) return {
      success: false,
      error: gas.error || "Could not cover the network gas to add collateral.",
      gasShortfall: {
        requiredLamports: gas.requiredLamports,
        heldLamports: gas.payerLamportsBefore + (gas.refilledLamports ?? 0) + (gas.fundedLamports ?? 0),
      },
    };

    // 4) Pre-read live collateral — the supply proof baseline.
    const preLive = await borrowRoute.readLivePositionHealth(params.collateralMint, nftId);
    const preColRaw = preLive ? BigInt(preLive.collateralRaw) : BigInt(position.collateralAmountRaw || "0");

    // 5) Pure plan -> SDK ix. positionId = the existing nft (NEVER 0 -> no mint).
    const plan = planSupplyCollateral(nftId, effectiveCollateralRaw);
    const borrow = await import("@jup-ag/lend/borrow");
    const BN = (await import("bn.js")).default;
    const connection = getServerConnection();
    const signer = new PublicKey(params.botPublicKey);

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

    // 6) THE money move (confirm-only: funds leave, no positive delta to verify).
    //    BOT-signed; the write-ahead hook lets the orchestrator reconcile a crash.
    const exec = await executeAgentInstructionsConfirmOnly({
      agentPublicKey: params.botPublicKey,
      agentSecretKey: params.botSecretKey,
      instructions: operate.ixs,
      gasDestMint: null,
      addressLookupTables: operate.addressLookupTableAccounts,
      label: "Add Collateral",
      onBeforeBroadcast: params.onBeforeBroadcast,
    });

    // 7) Provably-nothing-moved => safe; collateral still in the bot wallet.
    if (exec.onChainFailed || !exec.signature) {
      return {
        success: false,
        signature: exec.signature,
        onChainFailed: exec.onChainFailed,
        error: exec.error || "Adding collateral failed.",
      };
    }

    // 8) AUTHORITATIVE re-read is the proof. Record on-chain truth; fail CLOSED on
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
      const v = verifySupplyOutcome({ preColRaw, postColRaw: observedColRaw, depositedRaw: effectiveCollateralRaw });
      if (!v.ok) {
        verifyWarning = `Add Collateral sent (signature ${exec.signature}) but the position read differs (${v.reason}). Recorded the on-chain collateral.`;
        console.warn(`[Borrow] per-bot supply verify miss: ${v.reason}`, { positionId: position.id, nftId });
      }
    } else {
      // Confirmed (or ambiguous) but unreadable: keep the PRE collateral so we
      // never over-report. A live re-read self-heals the increase later.
      observedColRaw = preColRaw;
      observedDebtRaw = BigInt(position.debtAmountRaw || "0");
      healthSource = position.healthSource ?? "supply_unverified";
      verifyWarning = `Add Collateral confirmed (signature ${exec.signature}) but the position could not be re-read; kept the prior collateral pending reconcile.`;
      console.warn("[Borrow] per-bot supply could not re-read position", { positionId: position.id, nftId });
    }

    const health = buildHealthSnapshot(cfg, observedColRaw, observedDebtRaw, oraclePriceUsd, healthSource);
    let dbWarning: string | undefined;
    const updated = await storage.updateBorrowPosition(
      position.id,
      {
        collateralAmountRaw: observedColRaw.toString(),
        debtAmountRaw: observedDebtRaw.toString(),
        healthSnapshot: health.snapshot,
        healthAsOf: new Date(),
        healthSource,
      },
      "open",
    );
    if (!updated) {
      dbWarning = `Collateral added (signature ${exec.signature}) but the position record was updated by another process.`;
      console.warn("[Borrow] per-bot supply CAS lost", { positionId: position.id });
    }

    return {
      success: true,
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

    // History row (LIABILITY: borrowed USDC adds debt, it is NOT a deposit).
    //    Mirrors the OPEN path so a "Borrow More" shows up in the feed exactly like
    //    a first borrow — without this, every borrow via the dialog (which always
    //    routes through borrow-more) was invisible in Transaction History. Non-fatal:
    //    the money already moved and the position is persisted, so a history-write
    //    hiccup must never fail a settled borrow. Excluded from net-deposited so it
    //    can't inflate PnL.
    //
    //    MONEY-SAFETY: the user-visible amount MUST be a REALIZED on-chain figure,
    //    never the requested estimate. It is verified two ways: the USDC actually
    //    received (exec.outputReceivedRaw), or — on the recovered path — the real
    //    debt growth read back from chain (observedDebtRaw - preDebtRaw, which we
    //    have whenever `after` is non-null). When neither exists (recovered AND the
    //    position is unreadable, i.e. healthSource "borrow_more_unverified"), record
    //    NO history row rather than display a fabricated amount; the conservative
    //    debt is still persisted above and reconcile will surface it.
    const displayBorrowedRaw: bigint | null = !recovered
      ? BigInt(exec.outputReceivedRaw!)
      : after
        ? (observedDebtRaw > preDebtRaw ? observedDebtRaw - preDebtRaw : null)
        : null;
    try {
      if (displayBorrowedRaw != null && displayBorrowedRaw > 0n) {
        const borrowedUsd = fromRaw(displayBorrowedRaw, cfg.debtDecimals);
        if (borrowedUsd > 0) {
          const collateralAmt = fromRaw(observedColRaw, cfg.collateralDecimals);
          await storage.createEquityEvent({
            walletAddress: params.walletAddress,
            tradingBotId: position!.tradingBotId ?? null,
            eventType: "borrow",
            amount: new Decimal(borrowedUsd).toFixed(6),
            assetType: "USDC",
            txSignature: exec.signature ?? null,
            notes: `Borrowed ${new Decimal(borrowedUsd).toFixed(6)} USDC against ${new Decimal(collateralAmt).toFixed(6)} ${cfg.collateralSymbol}`,
          });
        }
      } else {
        console.warn("[Borrow] borrow-more: borrowed amount unverified (recovered + position unreadable); skipping history row to avoid a fabricated amount", { positionId: position!.id, nftId });
      }
    } catch (e) {
      console.warn("[Borrow] borrow-more: failed to record equity event (non-fatal)", e);
    }

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
  /**
   * OPTIONAL write-ahead hook fired with the repay signature STRICTLY BEFORE the
   * irreversible broadcast. A multi-hop caller uses this to durably record the
   * repay sig on its OWN op so a crash after the repay lands (but before the
   * caller recorded it) is reconciled by on-chain status, never blindly re-sent.
   */
  onBeforeBroadcast?: (info: { signature: string; blockhash: string; lastValidBlockHeight: number }) => void | Promise<void>;
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
    // A partial repay must cap at the FLOORED native debt, never the CEIL'd
    // `debtRaw`: passing even one native unit over the true on-chain debt reverts
    // with Jupiter VaultUserDebtTooLow. (Full repay uses the MAX_REPAY sentinel.)
    const maxRepayRaw = BigInt(live.maxRepayNativeRaw);

    // 2) Resolve the repay leg. "max" repays ALL (keep collateral); a partial is
    //    CAPPED at the live debt so we never overpay.
    const isMax = params.amount === "max";
    const repayRaw = isMax ? preDebtRaw : ((params.amount as bigint) > maxRepayRaw ? maxRepayRaw : (params.amount as bigint));

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
      onBeforeBroadcast: params.onBeforeBroadcast,
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

    // 9) History row (paydown: repay reduces a liability — muted/orange, never
    //    deposit-green). This is the single emit point for ALL repay sources: the
    //    multi-hop deleverage/wallet-swap repays all route their final paydown
    //    through this function. Non-fatal + excluded from net-deposited.
    //
    //    The repay is PROVEN on-chain here (confirmed signature, exec.onChainFailed
    //    is false) — so money DID move; only the AMOUNT can be uncertain. Pick the
    //    realized figure:
    //      - EXACT observed reduction (preDebt - observedDebt) ONLY when the re-read
    //        succeeded AND verified cleanly;
    //      - else a positive observed reduction is still a real, conservative
    //        on-chain figure → record it, but CAPPED at the amount we actually sent
    //        (repayRaw) so a noisy read can NEVER over-report the principal repaid;
    //      - else (re-read lagged the tx and shows >= the old debt, or unreadable)
    //        fall back to the sent amount (on-chain-derived: max => live preDebt,
    //        partial => capped at the floored true debt; dust-accurate).
    //    We mark the note "pending re-read" whenever the figure is inexact, and we
    //    ALWAYS emit the row. (A verify-MISS used to compute realized=0 and SKIP the
    //    row, so a confirmed repay vanished from the history/tax feed — the bug the
    //    owner saw: repay landed but no "Repay Debt" row appeared.)
    const { realizedRepaidRaw, exact: trustExact } = resolveRepaidHistoryRaw({
      preDebtRaw,
      observedDebtRaw,
      repayRaw,
      cleanVerified: after != null && !verifyWarning,
    });
    const repaidUsd = fromRaw(realizedRepaidRaw, cfg.debtDecimals);
    try {
      if (repaidUsd > 0) {
        const amtStr = new Decimal(repaidUsd).toFixed(6);
        await storage.createEquityEvent({
          walletAddress: params.walletAddress,
          tradingBotId: position!.tradingBotId ?? null,
          eventType: "repay",
          amount: amtStr,
          assetType: "USDC",
          txSignature: exec.signature ?? null,
          notes: trustExact
            ? `Repaid ${amtStr} USDC of ${cfg.collateralSymbol}-backed debt`
            : `Repaid ~${amtStr} USDC of ${cfg.collateralSymbol}-backed debt (confirmed on-chain; amount pending re-read)`,
        });
      }
    } catch (e) {
      console.warn("[Borrow] repay: failed to record equity event (non-fatal)", e);
    }

    return {
      success: true,
      signature: exec.signature,
      repaidUsdc: repaidUsd,
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
  /**
   * OPTIONAL idempotency / resume key. When present, the withdraw becomes a
   * two-leg resumable op: a retry with the SAME key — after the vault leg has
   * already landed the collateral in the agent wallet — just finishes (or
   * idempotently echoes) the delivery to the user's OWN wallet, NEVER a second
   * withdraw. Without it, delivery is still attempted but is not resumable.
   */
  clientRequestId?: string;
  /**
   * Deliver the withdrawn collateral on to the user's OWN wallet (the LIVE
   * Wallet-page withdraw). Default FALSE: internal callers (e.g. the deleverage
   * repay flow) need the collateral to STAY in the agent wallet so they can swap
   * it to USDC and repay — delivering it would break that primitive. Only the LIVE
   * withdraw route sets this true.
   */
  deliverToUserWallet?: boolean;
}

export interface WithdrawCollateralResult {
  success: boolean;
  signature?: string;
  collateralReturned?: number;
  observedCollateralRaw?: string;
  /**
   * Where the withdrawn collateral ended up:
   *  - "delivered": sent on to the user's own wallet (deliverySignature set).
   *  - "pending":   withdraw landed but the on-send failed; funds are SAFE in the
   *                 agent wallet and a retry (same clientRequestId) finishes it.
   *  - "agent":     left in the agent wallet (legacy / no-delivery path).
   */
  deliveryStatus?: "delivered" | "pending" | "agent";
  deliverySignature?: string;
  requiresRetry?: boolean;
  verifyWarning?: string;
  dbWarning?: string;
  error?: string;
}

type BorrowOp = NonNullable<Awaited<ReturnType<typeof storage.getBorrowOperationById>>>;

const WITHDRAW_DELIVERY_PENDING_MSG =
  "Your collateral was withdrawn safely but could not be sent to your wallet yet. Tap Withdraw again to finish delivery.";

/**
 * Reconcile a write-ahead signature (durably recorded BEFORE broadcast) by its
 * on-chain status. The agent wallet balance is NOT safe proof — it reads 0 while a
 * tx is in-flight and may hold unrelated same-mint funds — so the signature is the
 * only authority. Any read failure -> "in_flight" (wait); never assume a tx dropped.
 *   - "landed":   confirmed/finalized — the money DID move.
 *   - "reverted": landed but failed atomically — provably no money moved.
 *   - "expired":  never landed AND the blockhash window passed — can never land now.
 *   - "in_flight": not yet visible and still valid — MUST wait (re-send = double-spend).
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
      return "in_flight";
    }
  } catch {
    return "in_flight";
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

/**
 * Delivery leg of a collateral withdraw: send the EXACT withdrawn amount from the
 * agent wallet on to the user's OWN wallet. The caller MUST already hold the
 * account-vault borrow lock. Idempotent: re-reads the operation row and no-ops if
 * an earlier/concurrent retry already delivered. Maintains the `deliveryPending`
 * breadcrumb so a crash mid-delivery is resumable by clientRequestId.
 */
async function deliverWithdrawnCollateralCore(args: {
  opId: string;
  walletAddress: string;
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  mint: string;
  amountRaw: bigint;
}): Promise<{ deliveryStatus: "delivered" | "pending"; deliverySignature?: string; error?: string }> {
  // Idempotency: an earlier/concurrent retry may have already delivered.
  const fresh = await storage.getBorrowOperationById(args.opId);
  const meta = (fresh?.metadata ?? {}) as Record<string, any>;
  if (meta.deliveryPending === false && meta.deliverySignature) {
    return { deliveryStatus: "delivered", deliverySignature: meta.deliverySignature };
  }

  // A delivery tx may have been broadcast on a prior attempt but not recorded as
  // confirmed (crash in the window). Reconcile it by signature BEFORE sending again:
  // the strict balance read alone CANNOT prevent a double-deliver if the agent
  // independently holds the same mint. Only "reverted"/"expired" (provably no money
  // moved) fall through to a re-send.
  if (typeof meta.deliverySig === "string") {
    const status = await reconcileSignature(
      meta.deliverySig,
      typeof meta.deliveryLastValidBlockHeight === "number" ? meta.deliveryLastValidBlockHeight : undefined,
    );
    if (status === "landed") {
      await storage.updateBorrowOperation(args.opId, {
        step: "delivery_confirmed",
        mergeMetadata: { deliveryPending: false, deliverySignature: meta.deliverySig },
      });
      return { deliveryStatus: "delivered", deliverySignature: meta.deliverySig };
    }
    if (status === "in_flight") {
      return { deliveryStatus: "pending", error: "Delivery is still settling." };
    }
  }

  const del = await transferTokenToWalletExact({
    agentPublicKey: args.agentPublicKey,
    agentSecretKey: args.agentSecretKey,
    toWalletAddress: args.walletAddress,
    mint: args.mint,
    amountRaw: args.amountRaw,
    // WRITE-AHEAD: durably record the delivery signature BEFORE broadcast so a crash
    // after the transfer lands (but before we record it) is reconciled above, never
    // blindly re-sent.
    onBeforeBroadcast: async ({ signature, lastValidBlockHeight }) => {
      await storage.updateBorrowOperation(args.opId, {
        mergeMetadata: { deliverySig: signature, deliveryLastValidBlockHeight: lastValidBlockHeight },
      });
    },
  });

  if (!del.success) {
    await storage.updateBorrowOperation(args.opId, {
      step: "delivery_failed",
      mergeMetadata: { deliveryPending: true, lastDeliveryError: del.error || "delivery failed" },
    });
    return { deliveryStatus: "pending", error: del.error };
  }

  await storage.updateBorrowOperation(args.opId, {
    step: "delivery_confirmed",
    appendTxSignature: del.signature,
    mergeMetadata: { deliveryPending: false, deliverySignature: del.signature },
  });
  return { deliveryStatus: "delivered", deliverySignature: del.signature };
}

/**
 * Resolve a prior delivery-path withdraw op found by clientRequestId. Returns a
 * TERMINAL result, or NULL when the prior attempt provably moved no money (so the
 * caller may safely RE-RUN, reusing the same op row — the unique clientRequestId
 * forbids inserting a second). `runLocked` runs the money-moving branches under the
 * account-vault lock at the top level, or inline when the caller already holds it.
 *
 * Crash-resume taxonomy (all branches fail closed / never double-withdraw):
 *   - delivered          -> idempotent echo.
 *   - delivery owed       -> finish the on-send (reconciles any in-flight delivery sig).
 *   - legacy succeeded    -> funds in the agent (no breadcrumb): report "agent".
 *   - withdraw in_flight  -> wait (requiresRetry); funds safe, never re-withdraw.
 *   - withdraw landed      -> reconstruct the EXACT delta from the write-ahead
 *                            pre-balance + a fresh read, then deliver.
 *   - reverted/expired/no-sig -> provably never moved money -> NULL (safe re-run).
 */
async function resolveWithdrawResumption(
  params: WithdrawCollateralParams,
  prior: BorrowOp,
  runLocked: (fn: () => Promise<WithdrawCollateralResult>) => Promise<WithdrawCollateralResult>,
): Promise<WithdrawCollateralResult | null> {
  const meta = (prior.metadata ?? {}) as Record<string, any>;
  if (meta.deliveryWallet && meta.deliveryWallet !== params.walletAddress) {
    return { success: false, error: "This withdrawal belongs to a different wallet." };
  }

  // Already fully delivered -> idempotent echo (never a second money move).
  if (meta.deliveryPending === false && meta.deliverySignature) {
    return { success: true, signature: meta.withdrawSignature, deliveryStatus: "delivered", deliverySignature: meta.deliverySignature };
  }

  // Vault leg landed, delivery still owed -> finish it (deliverWithdrawnCollateralCore
  // reconciles any in-flight delivery sig before re-sending).
  if (meta.deliveryPending === true && typeof meta.deliveryMint === "string" && typeof meta.deliveryAmountRaw === "string") {
    return runLocked(async () => {
      const del = await deliverWithdrawnCollateralCore({
        opId: prior.id,
        walletAddress: params.walletAddress,
        agentPublicKey: params.agentPublicKey,
        agentSecretKey: params.agentSecretKey,
        mint: meta.deliveryMint as string,
        amountRaw: BigInt(meta.deliveryAmountRaw as string),
      });
      return {
        success: true,
        signature: meta.withdrawSignature,
        deliveryStatus: del.deliveryStatus,
        deliverySignature: del.deliverySignature,
        requiresRetry: del.deliveryStatus === "pending",
        verifyWarning: del.deliveryStatus === "pending" ? WITHDRAW_DELIVERY_PENDING_MSG : undefined,
      };
    });
  }

  // Vault leg succeeded but no delivery breadcrumb (legacy) -> funds in the agent.
  if (prior.status === "succeeded") {
    return { success: true, signature: meta.withdrawSignature, deliveryStatus: "agent" };
  }

  // Not succeeded: reconcile the write-ahead withdraw signature. "no sig" provably
  // means the withdraw was NEVER broadcast.
  const wsig = typeof meta.withdrawSig === "string" ? meta.withdrawSig : undefined;
  if (!wsig) return null; // never broadcast -> safe to re-run
  const status = await reconcileSignature(
    wsig,
    typeof meta.withdrawLastValidBlockHeight === "number" ? meta.withdrawLastValidBlockHeight : undefined,
  );
  if (status === "in_flight") {
    return { success: false, requiresRetry: true, error: "Your collateral withdrawal is still settling. Your funds are safe — refresh and tap Withdraw again in a moment." };
  }
  if (status === "reverted" || status === "expired") return null; // no money moved -> safe to re-run

  // status === "landed": collateral DID move into the agent but we crashed before the
  // breadcrumb. Reconstruct the EXACT delta from the write-ahead pre-balance + a fresh
  // on-chain read, then deliver. Missing breadcrumb data -> funds safe in the agent.
  if (typeof meta.preColRaw !== "string" || meta.nftId == null || typeof meta.collateralMint !== "string") {
    return { success: true, signature: wsig, deliveryStatus: "agent", verifyWarning: "Your collateral was withdrawn to your trading agent. Refresh to see it." };
  }
  return runLocked(async () => {
    const route = new JupiterLendBorrowRoute();
    const postLive = await route.readLivePositionHealth(meta.collateralMint as string, meta.nftId);
    if (!postLive) {
      // FAIL CLOSED: the withdraw provably landed (collateral IS in the agent) but we
      // cannot read the position to compute the EXACT delivery delta. Do NOT mark the
      // op succeeded — that would route every future retry to the legacy "agent"
      // branch and the user would never receive their collateral. Keep the op
      // resumable so a later retry reconstructs the delta and delivers.
      return {
        success: false,
        requiresRetry: true,
        error: "Your collateral was withdrawn but we can't confirm the exact amount yet. Your funds are safe — refresh and tap Withdraw again in a moment.",
      };
    }
    const delta = BigInt(meta.preColRaw as string) - BigInt(postLive.collateralRaw);
    if (delta <= 0n) {
      // Authoritative read shows no collateral left the position -> nothing to
      // deliver. Safe to finalize (this is a real read, not a null-read).
      await storage.updateBorrowOperation(prior.id, { status: "succeeded", step: "withdraw_confirmed", mergeMetadata: { withdrawSignature: wsig } });
      return { success: true, signature: wsig, deliveryStatus: "agent" };
    }
    await storage.updateBorrowOperation(prior.id, {
      status: "succeeded",
      step: "withdraw_confirmed",
      mergeMetadata: { deliveryPending: true, deliveryMint: meta.collateralMint, deliveryAmountRaw: delta.toString(), deliveryWallet: params.walletAddress, withdrawSignature: wsig },
    });
    const del = await deliverWithdrawnCollateralCore({
      opId: prior.id,
      walletAddress: params.walletAddress,
      agentPublicKey: params.agentPublicKey,
      agentSecretKey: params.agentSecretKey,
      mint: meta.collateralMint as string,
      amountRaw: delta,
    });
    return {
      success: true,
      signature: wsig,
      deliveryStatus: del.deliveryStatus,
      deliverySignature: del.deliverySignature,
      requiresRetry: del.deliveryStatus === "pending",
      verifyWarning: del.deliveryStatus === "pending" ? WITHDRAW_DELIVERY_PENDING_MSG : undefined,
    };
  });
}

export async function executeWithdrawCollateral(params: WithdrawCollateralParams): Promise<WithdrawCollateralResult> {
  const deliver = params.deliverToUserWallet === true;

  // Resume / idempotency (DELIVERY path only): a retry with the same clientRequestId
  // — after the vault leg already landed the collateral in the agent wallet — just
  // finishes (or echoes) delivery, even if the position is now CLOSED and unloadable
  // as "open". A NULL result means the prior attempt provably moved no money -> fall
  // through and re-run, REUSING the same op row (unique clientRequestId forbids a 2nd).
  if (deliver && params.clientRequestId) {
    const prior = await storage.getBorrowOperationByClientRequestId(params.walletAddress, params.clientRequestId);
    if (prior) {
      const vid = (prior.metadata as any)?.vaultId;
      const r = await resolveWithdrawResumption(params, prior, (fn) =>
        withBorrowLock(borrowLockKey(params.walletAddress, null, vid), fn),
      );
      if (r) return r;
    }
  }

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
    // Concurrency: a same-clientRequestId attempt may have created the op and landed
    // the withdraw while we waited for the lock. Re-check INSIDE the lock (we already
    // hold it, so run resume INLINE rather than re-locking) so a racing first attempt
    // can never double-withdraw. A NULL result means the prior attempt provably moved
    // no money -> REUSE that op row and re-run (unique clientRequestId forbids a 2nd).
    let existingOp: BorrowOp | null = null;
    if (deliver && params.clientRequestId) {
      const again = await storage.getBorrowOperationByClientRequestId(params.walletAddress, params.clientRequestId);
      if (again) {
        const r = await resolveWithdrawResumption(params, again, (fn) => fn());
        if (r) return r;
        existingOp = again;
      }
    }

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

    // Find-or-create: a NULL resume above (provably no money moved) reuses the SAME
    // op row — the unique clientRequestId forbids inserting a second. The delivery
    // path stores everything resume needs to reconstruct the EXACT delta after a
    // crash (preColRaw + nftId); the non-delivery path keeps the minimal breadcrumb.
    const op =
      existingOp ??
      (await storage.createBorrowOperation({
        walletAddress: params.walletAddress,
        borrowPositionId: position!.id,
        operationType: "withdraw_collateral",
        status: "pending",
        step: "gate_passed",
        ...(params.clientRequestId ? { clientRequestId: params.clientRequestId } : {}),
        // vaultId is the delivery-resume lock key when the position later closes.
        metadata: deliver
          ? {
              vaultId: cfg.vaultId,
              collateralMint: position!.collateralMint,
              nftId,
              preColRaw: preColRaw.toString(),
              intendedRaw: intendedRaw.toString(),
              fullWithdraw,
              deliveryWallet: params.walletAddress,
            }
          : { vaultId: cfg.vaultId, collateralMint: position!.collateralMint },
      }));

    // Safe re-run reusing a prior op (resume returned NULL = provably no money moved):
    // its delivery metadata is from the EARLIER attempt and may be stale (live
    // collateral can change between attempts). Refresh it to THIS attempt's values so a
    // later landed-without-breadcrumb resume reconstructs the correct delta. The fresh
    // withdraw's onBeforeBroadcast overwrites the stale withdrawSig before broadcast.
    if (existingOp && deliver) {
      await storage.updateBorrowOperation(op.id, {
        status: "pending",
        step: "gate_passed",
        mergeMetadata: {
          vaultId: cfg.vaultId,
          collateralMint: position!.collateralMint,
          nftId,
          preColRaw: preColRaw.toString(),
          intendedRaw: intendedRaw.toString(),
          fullWithdraw,
          deliveryWallet: params.walletAddress,
        },
      });
    }

    // 6) THE money move: verify a POSITIVE COLLATERAL delta returns to the wallet.
    const exec = await executeAgentInstructions({
      agentPublicKey: params.agentPublicKey,
      agentSecretKey: params.agentSecretKey,
      instructions: operate.ixs,
      verifyOutputMint: position!.collateralMint,
      addressLookupTables: operate.addressLookupTableAccounts,
      label: "Withdraw collateral",
      onBeforeBroadcast: async (info) => {
        // WRITE-AHEAD (delivery path only): durably record the WITHDRAW signature
        // BEFORE broadcast so a crash after it lands (but before the delivery
        // breadcrumb is written) is reconciled on retry, never blindly re-withdrawn.
        if (deliver) {
          await storage.updateBorrowOperation(op.id, {
            mergeMetadata: { withdrawSig: info.signature, withdrawLastValidBlockHeight: info.lastValidBlockHeight },
          });
        }
        // Preserve any caller hook (deleverage multi-hop records its own breadcrumb).
        if (params.onBeforeBroadcast) await params.onBeforeBroadcast(info);
      },
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
      if (!preReadLive && deliver) {
        // AMBIGUOUS + UNREADABLE on the DELIVER path: exec reported failure-with-signature
        // and we cannot read the position to confirm whether the withdraw landed. We must
        // NOT infer the delta and deliver it — that could either (a) deliver UNRELATED
        // same-mint funds the agent independently holds, or (b) strand the op in
        // deliveryPending forever if the withdraw never landed. The withdrawSig was
        // already written-ahead by onBeforeBroadcast, so bail to a resumable retry:
        // resolveWithdrawResumption reconciles it (landed -> deliver the exact delta;
        // reverted/expired -> safe re-run; in_flight -> wait). NEVER mark succeeded here.
        return {
          success: false,
          requiresRetry: true,
          signature: exec.signature,
          error: "Your withdrawal is still being confirmed. Your funds are safe — refresh and tap Withdraw again in a moment.",
        };
      }
      // Non-deliver (deleverage) path keeps its pre-existing behavior: it reads the
      // agent's collateral balance itself as its resume authority, so an inferred delta
      // here is informational only and never the source of truth for the next leg.
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
    // 9-NON-DELIVERY) Internal caller (e.g. deleverage repay): the collateral MUST
    //    stay in the agent wallet for the next leg (swap -> USDC -> repay). Mark the
    //    op succeeded with NO delivery breadcrumb and return "agent" — delivering it
    //    here would strand the next leg without its source funds.
    if (!deliver) {
      await storage.updateBorrowOperation(op.id, {
        status: "succeeded",
        step: nowEmpty ? "withdraw_closed" : "withdraw_confirmed",
        appendTxSignature: exec.signature,
        mergeMetadata: { withdrawSignature: exec.signature },
      });
      return {
        success: true,
        signature: exec.signature,
        collateralReturned: fromRaw(collateralDeltaRaw, cfg.collateralDecimals),
        observedCollateralRaw: observedColRaw.toString(),
        deliveryStatus: "agent",
        verifyWarning,
        dbWarning,
      };
    }

    // 9) Persist the pending DELIVERY breadcrumb BEFORE moving any money, so a
    //    crash between the vault leg and the on-send is resumable by clientRequestId.
    //    Delivers EXACTLY this op's realized delta (never sweeps the agent balance).
    await storage.updateBorrowOperation(op.id, {
      status: "succeeded",
      step: nowEmpty ? "withdraw_closed" : "withdraw_confirmed",
      appendTxSignature: exec.signature,
      mergeMetadata: {
        deliveryPending: true,
        deliveryMint: position!.collateralMint,
        deliveryAmountRaw: collateralDeltaRaw.toString(),
        deliveryWallet: params.walletAddress,
        withdrawSignature: exec.signature,
      },
    });

    // 10) DELIVERY leg: send the withdrawn collateral on to the user's OWN wallet.
    //     Non-fatal on failure — the collateral is SAFE in the agent wallet and a
    //     retry (same clientRequestId) finishes delivery.
    const delivery = await deliverWithdrawnCollateralCore({
      opId: op.id,
      walletAddress: params.walletAddress,
      agentPublicKey: params.agentPublicKey,
      agentSecretKey: params.agentSecretKey,
      mint: position!.collateralMint,
      amountRaw: collateralDeltaRaw,
    });
    const deliveryWarning = delivery.deliveryStatus === "pending" ? WITHDRAW_DELIVERY_PENDING_MSG : undefined;

    return {
      success: true,
      signature: exec.signature,
      collateralReturned: fromRaw(collateralDeltaRaw, cfg.collateralDecimals),
      observedCollateralRaw: observedColRaw.toString(),
      deliveryStatus: delivery.deliveryStatus,
      deliverySignature: delivery.deliverySignature,
      requiresRetry: delivery.deliveryStatus === "pending",
      verifyWarning: verifyWarning
        ? deliveryWarning
          ? `${verifyWarning} ${deliveryWarning}`
          : verifyWarning
        : deliveryWarning,
      dbWarning,
    };
  });
}
