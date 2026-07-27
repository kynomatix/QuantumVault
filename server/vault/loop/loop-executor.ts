/**
 * SOL Loop Vault (qntSOL) — loop executor (P2).
 *
 * Executes the PROVEN atomic loop sandwich from scripts/probe-sol-loop.mjs
 * (P1 live mainnet round trips on JupSOL vault 4 + mSOL vault 47) through the
 * real borrow-engine plumbing: borrow_positions / borrow_operations rows,
 * write-ahead signatures, fail-closed verification, and equity events.
 *
 * OPEN  (atomic): wrap principal → flash-borrow P·(L−1) WSOL → swap P·L WSOL
 *                 → LST → operate(deposit LST, borrow WSOL) → flash payback.
 * CLOSE (atomic): flash-borrow debt×1.02 → operate(repay MAX, withdraw MAX)
 *                 → swap LST → WSOL → flash payback → unwrap leftovers.
 * PARTIAL UNWIND: same shape with exact proportional repay/withdraw amounts.
 *
 * Money-safety discipline (same as jupiter-lend-borrow-executor):
 * - PLAN (pure builders in borrow-engine-core) → EXECUTE → VERIFY (live
 *   on-chain re-read is the authority, never the plan).
 * - Write-ahead signature via the FATAL onBeforeBroadcast hook: "no sig
 *   recorded" == "tx never broadcast" stays a TRUE invariant.
 * - A failed Solana tx still returns a signature; only `onChainFailed` proves
 *   nothing moved. Ambiguous outcomes are resolved by probing live position
 *   state, and fail CLOSED (keep the position row conservative) when the
 *   probe is unreadable.
 * - Loop rows are `kind='loop'` and MUST stay out of borrow-only machinery.
 *
 * TX SIZE: the loop tx measured 1215/1232 bytes in P1 — ATA creates MUST live
 * in a separate prep tx, and the swap MUST be quoted with the restrictive
 * route params below or the tx blows the packet limit.
 */

import Decimal from "decimal.js";
import {
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  TransactionInstruction,
  type AddressLookupTableAccount,
  type Connection,
} from "@solana/web3.js";
import {
  getServerConnection,
  executeAgentInstructions,
  executeAgentInstructionsConfirmOnly,
  executeAgentSwap,
  getAgentTokenBalanceRawStrict,
  NATIVE_SOL_MINT,
} from "../../agent-wallet";
import { storage, AGENT_SOL_WITHDRAW_OP_TYPE } from "../../storage";
import { ensureVaultGas } from "../gas-funding";
import { TERMINAL_OPERATION_STATUSES } from "../reset-blockers";
import {
  JupiterLendBorrowRoute,
  WSOL_MINT,
  type BorrowVaultConfig,
  type LivePositionHealth,
} from "../jupiter-lend-borrow-route";
import { withBorrowLock, borrowLockKey } from "../jupiter-lend-borrow-executor";
import {
  computeLoopOpenAmounts,
  planLoopOpen,
  planLoopClose,
  planLoopPartialUnwind,
  planLoopDeleverToHold,
  planLoopHoldExit,
  sizeLoopDeleverWithdraw,
  computeLoopReleverAmounts,
  verifyLoopOpenOutcome,
  verifyLoopCloseOutcome,
  verifyLoopPartialUnwindOutcome,
  verifyLoopDeleverToHoldOutcome,
  verifyLoopReleverOutcome,
  DEFAULT_SOL_DEBT_DUST_RAW,
  DEFAULT_LST_COLLATERAL_DUST_RAW,
  type AmountSpec,
} from "../borrow-engine-core";
import {
  computeLoopTargetLeverage,
  evaluateLoopOpenRequest,
  recoverHopSolReturned,
  LOOP_ALLOCATION_POLICY,
  LOOP_HOP_RECOVERY_POLICY,
  LOOP_RISK_POLICY,
  LOOP_VAULT_ALLOWLIST,
  type HopSolReturnedSource,
  type LoopPolicyReason,
} from "./loop-risk-policy";
import { getFreshLoopRates, sampleAndPersistLoopRates, netCarryAt, LOOP_RATE_REGISTRY, type FreshLoopRate } from "./loop-rate-oracle";
import type { BorrowPosition, BorrowOperation } from "@shared/schema";

// --- Constants ---------------------------------------------------------------

/** Same venue string as the borrow engine — loop rows differ by `kind`, not venue. */
const DEBT_VENUE = "jupiter_lend";

const QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
const SWAP_IX_URL = "https://lite-api.jup.ag/swap/v1/swap-instructions";
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** Rent-exempt lamports for one SPL token account. */
const ATA_RENT_LAMPORTS = 2_039_280;
/** First-time opens mint a position NFT (~0.0215 SOL observed) — budget with headroom. */
const LOOP_NFT_MINT_RENT_LAMPORTS = 30_000_000;
/** Priority fees for prep + loop tx (1.4M CU × 50k µLam ≈ 70k lamports) + base fees + margin. */
const LOOP_FEE_HEADROOM_LAMPORTS = 300_000;
const LOOP_CU_LIMIT = 1_400_000;
const PREP_CU_LIMIT = 60_000;
const CU_PRICE_MICRO_LAMPORTS = 50_000;
const DEFAULT_SLIPPAGE_BPS = 50;
/**
 * Extra pad ON TOP of the swap's slippageBps when sizing the delever-to-hold
 * LST withdrawal (oracle staleness / rounding). Any over-withdrawn sliver
 * comes back to the agent as native SOL via the WSOL ATA close.
 */
const DELEVER_SIZING_PAD_BPS = 20;
/** Flash 2% over live debt on a full close — repay MAX takes only what is owed. */
const CLOSE_FLASH_BUFFER_NUM = 102n;
const CLOSE_FLASH_BUFFER_DEN = 100n;
/**
 * Partial unwind flash cushion. The vault's EXACT repay pull can round UP a
 * hair above the requested amount (same Fluid exchange-price rounding class as
 * the deposit round-up), so an ATA funded with exactly `repayRaw` fails the
 * repay transfer with SPL "insufficient funds" (custom error 0x1). Verified by
 * live simulation on vault 4 / position 5659: flash=repayRaw FAILED at the
 * operate ix, flash=repayRaw+0.001 SOL SUCCEEDED. The cushion rides through
 * the tx and comes back to the agent when the WSOL ATA is closed at the end.
 */
const UNWIND_FLASH_CUSHION_LAMPORTS = 1_000_000n;
/**
 * The swap's worst-case output must cover the flash payback even when the
 * repay pull rounds up. Require minOut to clear repayRaw by this margin
 * (10k lamports = 0.00001 SOL — noise vs any real unwind size).
 * ASSUMES the SDK flashloan fee stays 0 (payback == flash amount). If the fee
 * ever becomes nonzero, payback = flash x (1e4+fee)/1e4 and this FIXED margin
 * stops scaling with unwind size — large unwinds would revert atomically at
 * the payback ix (fail closed, no money moves). Switch to a proportional
 * margin like the close path's 2% buffer in that case.
 */
const UNWIND_MIN_OUT_MARGIN_LAMPORTS = 10_000n;
/** Partial unwind sizing bounds: 1..9000 bps (>90% must use the full close). */
const MAX_UNWIND_BPS = 9000;
/** Bound the reuse scan: only probe the newest N closed rows on this vault. */
const REUSE_SCAN_LIMIT = 3;

// --- Small helpers (verbatim ports from the probe, TS-typed) ------------------

function ataFor(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM,
  )[0];
}

function ixCreateAtaIdempotent(payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ataFor(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent
  });
}

function ixSyncNative(account: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [{ pubkey: account, isSigner: false, isWritable: true }],
    data: Buffer.from([17]), // SyncNative
  });
}

function ixCloseAccount(account: PublicKey, dest: PublicKey, owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]), // CloseAccount (unwrap WSOL leftovers)
  });
}

function deserializeJupIx(ix: any): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: (ix.accounts || []).map((a: any) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ix.data, "base64"),
  });
}

function cuIxs(limit: number): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: limit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE_MICRO_LAMPORTS }),
  ];
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.split("?")[0]}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

/**
 * Quote with the route constraints that keep the atomic sandwich under the
 * 1232-byte tx limit (unconstrained routes measured OVER the limit in P1).
 * LST<->SOL pairs always have deep direct pools.
 */
async function jupQuote(inputMint: string, outputMint: string, amountRaw: bigint, slippageBps: number): Promise<any> {
  const u =
    `${QUOTE_URL}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw.toString()}` +
    `&slippageBps=${slippageBps}&restrictIntermediateTokens=true&onlyDirectRoutes=true&maxAccounts=28`;
  return fetchJson(u);
}

async function jupSwapIxs(quote: any, userPublicKey: string): Promise<any> {
  return fetchJson(SWAP_IX_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey, wrapAndUnwrapSol: false }),
  });
}

async function loadAlts(connection: Connection, addresses: string[]): Promise<AddressLookupTableAccount[]> {
  const uniq = [...new Set(addresses)];
  const out: AddressLookupTableAccount[] = [];
  for (const addr of uniq) {
    const r = await connection.getAddressLookupTable(new PublicKey(addr));
    if (r.value) out.push(r.value);
  }
  return out;
}

/** Map an SDK-free AmountSpec to the SDK BN / MAX sentinel for the given leg. */
function specToBN(BN: any, spec: AmountSpec, leg: "col" | "debt", MAX_WITHDRAW: any, MAX_REPAY: any): any {
  if (spec.kind === "max") return leg === "col" ? MAX_WITHDRAW : MAX_REPAY;
  return new BN(spec.raw.toString());
}

function lamportsToSol(raw: bigint): string {
  return new Decimal(raw.toString()).div(1e9).toFixed(9);
}

/**
 * SOL-denominated health snapshot for a loop row. NEVER fills the USD fields —
 * `oraclePriceUsd`/`oraclePriceOperateUsd` on a WSOL-debt vault are SOL-per-LST
 * rates, and writing them into USD fields would poison every USD consumer.
 */
function buildLoopHealthSnapshot(
  cfg: BorrowVaultConfig,
  collateralRaw: bigint,
  debtRaw: bigint,
  solPerLst: number | null,
  source: string,
): NonNullable<BorrowPosition["healthSnapshot"]> {
  const col = Number(new Decimal(collateralRaw.toString()).div(1e9));
  const debt = Number(new Decimal(debtRaw.toString()).div(1e9));
  const rate = solPerLst ?? cfg.oraclePriceOperateUsd; // SOL per LST on loop vaults
  const colValueSol = Number.isFinite(rate) && rate > 0 ? col * rate : null;
  const ltv = colValueSol && colValueSol > 0 ? debt / colValueSol : null;
  const healthFactor =
    colValueSol && debt > 0 ? (colValueSol * cfg.liquidationThreshold) / debt : null;
  return {
    healthFactor,
    ltv,
    source,
    denomination: "SOL",
    collateralValueSol: colValueSol,
    debtSol: debt,
  };
}

/**
 * SOL-denominated per-position card view: actual leverage, current balance
 * (equity) in SOL, and PnL vs the SOL principal that went into the loop.
 *
 * PnL = (current equity) + (SOL already returned by unwinds/delever/close)
 *       - (SOL principal deposited at open).
 * Every swap cost, flash-loan fee, and slippage the loop pays shows up here,
 * because equity is valued from on-chain amounts while principal is what the
 * user actually put in.
 *
 * Principal and opened-at leverage come from the position's LATEST loop_open
 * op (positions have no metadata column; NFT reuse re-claims the SAME row
 * across lifecycles, so the latest open anchors the current lifecycle).
 * Returned SOL is summed from the SUCCEEDED returning ops of that lifecycle
 * (result.solReturnedLamports on loop_close / loop_unwind / loop_delever_hold /
 * loop_relever) — no new write path, and past unwinds are already covered.
 * Fail closed: any op whose returned amount could not be measured
 * (solDeltaUnknown) makes PnL null rather than a guess.
 */
export interface LoopSolView {
  /** Actual live leverage (collateral value / equity); falls back to opened-at leverage. */
  leverage: number | null;
  /** Current equity in SOL (collateral valued at the live LST rate, minus debt). */
  balanceSol: number | null;
  /** True when balanceSol came from a live on-chain read (vs the last stored snapshot). */
  balanceLive: boolean;
  pnlSol: number | null;
  /** PnL as a fraction of principal (0.05 = +5%). */
  pnlPct: number | null;
  principalSol: number | null;
  returnedSol: number;
}

// loop_relever results currently carry no solReturnedLamports (observed amounts
// only) — included so that IF a relever ever measures stranded SOL, it counts.
const LOOP_RETURNING_OP_TYPES = new Set(["loop_close", "loop_unwind", "loop_delever_hold", "loop_relever"]);

export function buildLoopSolView(
  row: BorrowPosition,
  live: { collateralRaw: string; debtRaw: string; oraclePriceUsd: number | null } | null,
  allOps: BorrowOperation[],
): LoopSolView {
  const rowOps = allOps.filter((op) => op.borrowPositionId === row.id);

  // Lifecycle anchor: the latest loop_open op for this row. Prefer a SUCCEEDED
  // open; a pending row may only have an unresolved open (ambiguous-kept-pending),
  // so fall back to the latest open of any status there.
  const openOps = rowOps
    .filter((op) => op.operationType === "loop_open")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const openOp =
    openOps.find((op) => op.status === "succeeded") ??
    (row.status === "pending" ? openOps[0] ?? null : null);

  // Principal + opened-at leverage: from the anchoring open op's metadata.
  let principalSol: number | null = null;
  let openedLeverage: number | null = null;
  if (openOp) {
    const m = (openOp.metadata ?? {}) as Record<string, unknown>;
    if (typeof m.principalLamports === "string" && /^\d+$/.test(m.principalLamports)) {
      principalSol = Number(new Decimal(m.principalLamports).div(1e9));
    }
    if (typeof m.leverage === "number" && Number.isFinite(m.leverage)) {
      openedLeverage = m.leverage;
    }
  }

  // Returned SOL: succeeded returning ops of THIS lifecycle (at/after the open).
  const openAt = openOp ? new Date(openOp.createdAt).getTime() : null;
  let returnedLamports = 0n;
  let returnedUnknown = false;
  for (const op of rowOps) {
    if (op.status !== "succeeded") continue;
    if (!LOOP_RETURNING_OP_TYPES.has(op.operationType)) continue;
    if (openAt !== null && new Date(op.createdAt).getTime() < openAt) continue;
    const r = (op.result ?? {}) as Record<string, unknown>;
    if (typeof r.solReturnedLamports === "string" && /^\d+$/.test(r.solReturnedLamports)) {
      returnedLamports += BigInt(r.solReturnedLamports);
    } else if (r.solDeltaUnknown) {
      returnedUnknown = true; // measured amount lost -> PnL would be a guess
    }
  }
  const returnedSol = Number(new Decimal(returnedLamports.toString()).div(1e9));

  // Equity: live read first, stored SOL snapshot second, closed rows are 0.
  let balanceSol: number | null = null;
  let collateralValueSol: number | null = null;
  let balanceLive = false;
  const isActive = row.status === "open" || row.status === "pending";
  if (!isActive) {
    balanceSol = 0;
  } else if (live) {
    // On WSOL-debt loop vaults the oracle price IS the SOL-per-LST rate.
    const rate = live.oraclePriceUsd;
    if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
      const col = Number(new Decimal(live.collateralRaw).div(1e9));
      const debt = Number(new Decimal(live.debtRaw).div(1e9));
      collateralValueSol = col * rate;
      balanceSol = collateralValueSol - debt;
      balanceLive = true;
    }
  }
  if (isActive && balanceSol === null) {
    const snap = row.healthSnapshot as { denomination?: string; collateralValueSol?: number | null; debtSol?: number | null } | null;
    if (
      snap &&
      snap.denomination === "SOL" &&
      typeof snap.collateralValueSol === "number" &&
      typeof snap.debtSol === "number"
    ) {
      collateralValueSol = snap.collateralValueSol;
      balanceSol = snap.collateralValueSol - snap.debtSol;
    }
  }

  // Leverage: actual (collateral value / equity) when readable, else opened-at.
  let leverage: number | null = null;
  if (collateralValueSol !== null && balanceSol !== null && balanceSol > 0) {
    leverage = collateralValueSol / balanceSol;
  } else if (openedLeverage !== null) {
    leverage = openedLeverage;
  }

  const pnlSol =
    principalSol !== null && balanceSol !== null && !returnedUnknown
      ? balanceSol + returnedSol - principalSol
      : null;
  const pnlPct = pnlSol !== null && principalSol !== null && principalSol > 0 ? pnlSol / principalSol : null;

  return { leverage, balanceSol, balanceLive, pnlSol, pnlPct, principalSol, returnedSol };
}

/**
 * Wallet-level lifetime P/L for the SOL Loop card: total across ALL historical
 * positions (every lifecycle, including past lifecycles on reused NFT rows —
 * which the per-position view intentionally excludes because it anchors on the
 * LATEST open).
 *
 * pnlSol = (current equity of active rows) + (every SOL ever returned by
 *          succeeded loop_close / loop_unwind / loop_delever_hold / loop_relever)
 *        - (every SOL principal that ever went in via a succeeded loop_open).
 *
 * Fail closed, never a guess: any succeeded open missing its recorded
 * principal, any returning op whose amount could not be measured
 * (solDeltaUnknown), or any active row whose equity is unreadable makes
 * pnlSol null (renders as an em dash client-side). Display only.
 */
export interface LoopLifetimeView {
  pnlSol: number | null;
  principalSol: number | null;
  returnedSol: number;
  equitySol: number | null;
}

export function buildLoopLifetimeView(
  positions: Array<BorrowPosition & { solView: LoopSolView }>,
  allOps: BorrowOperation[],
): LoopLifetimeView {
  // Principal: every succeeded loop_open ever (loop_* op types are loop-only,
  // so no kind filter is needed on the wallet-wide ops list).
  let principalLamports = 0n;
  let principalUnknown = false;
  let openCount = 0;
  for (const op of allOps) {
    if (op.operationType !== "loop_open" || op.status !== "succeeded") continue;
    openCount += 1;
    const m = (op.metadata ?? {}) as Record<string, unknown>;
    if (typeof m.principalLamports === "string" && /^\d+$/.test(m.principalLamports)) {
      principalLamports += BigInt(m.principalLamports);
    } else {
      principalUnknown = true; // recorded open with no measured principal -> no guessing
    }
  }

  // Returned: every succeeded returning op ever.
  let returnedLamports = 0n;
  let returnedUnknown = false;
  for (const op of allOps) {
    if (op.status !== "succeeded") continue;
    if (!LOOP_RETURNING_OP_TYPES.has(op.operationType)) continue;
    const r = (op.result ?? {}) as Record<string, unknown>;
    if (typeof r.solReturnedLamports === "string" && /^\d+$/.test(r.solReturnedLamports)) {
      returnedLamports += BigInt(r.solReturnedLamports);
    } else if (r.solDeltaUnknown) {
      returnedUnknown = true;
    }
  }
  const returnedSol = Number(new Decimal(returnedLamports.toString()).div(1e9));

  // Equity: sum of the active rows' current balances (already computed by the
  // per-position view). One unreadable active row poisons the total.
  let equitySol: number | null = 0;
  for (const p of positions) {
    if (p.status !== "open" && p.status !== "pending") continue;
    if (typeof p.solView.balanceSol === "number" && Number.isFinite(p.solView.balanceSol)) {
      equitySol += p.solView.balanceSol;
    } else {
      equitySol = null;
      break;
    }
  }

  const principalSol = principalUnknown ? null : Number(new Decimal(principalLamports.toString()).div(1e9));
  const pnlSol =
    openCount > 0 && principalSol !== null && equitySol !== null && !returnedUnknown
      ? equitySol + returnedSol - principalSol
      : null;
  return { pnlSol, principalSol, returnedSol, equitySol };
}

async function failOp(opId: string, step: string, error: string): Promise<void> {
  try {
    await storage.updateBorrowOperation(opId, { status: "failed", step, error: error.slice(0, 1000) });
  } catch (e) {
    console.warn(`[loop-executor] could not mark op ${opId} failed at ${step}:`, e);
  }
}

/**
 * Restore a PENDING loop position row after its open attempt is PROVEN dead
 * (never broadcast, failed on-chain atomically, or expired past its blockhash
 * window). Reused rows go back to the reusable `closed` pool with zeroed
 * amounts; fresh rows become `failed`. CAS-guarded on `pending` — can never
 * clobber a row that moved on (e.g. a concurrent reconcile finalized it open).
 * Returns true only when THIS call performed the restore.
 */
async function restoreLoopPendingRow(positionId: string, wasReuse: boolean): Promise<boolean> {
  try {
    const updated = wasReuse
      ? await storage.updateBorrowPosition(
          positionId,
          { status: "closed", collateralAmountRaw: "0", debtAmountRaw: "0" },
          "pending",
        )
      : await storage.updateBorrowPosition(positionId, { status: "failed" }, "pending");
    return !!updated;
  } catch (e) {
    console.warn(`[loop-executor] could not restore loop position row ${positionId}:`, e);
    return false;
  }
}

/**
 * TRUE when the durable loop_open record carries ANY evidence that the FATAL
 * main-open write-ahead hook persisted: the write-ahead step itself, the
 * ambiguous terminal marker (only reachable AFTER a signature came back, which
 * requires the write-ahead persist), or the metadata keys the hook merges
 * atomically with the step. The hook throws when its persist fails and the
 * broadcast is aborted — so the ABSENCE of every one of these on a RELOADED
 * record proves the main open tx was never sent. The ATA-prep signature never
 * counts as evidence. Callers treat "recorded" as "may have broadcast" and
 * must NOT restore the position row in that case.
 */
function loopOpenWriteaheadRecorded(op: Pick<BorrowOperation, "step" | "metadata">): boolean {
  const meta = (op.metadata ?? {}) as Record<string, unknown>;
  return (
    op.step === "loop_sig_writeahead" ||
    op.step === "open_ambiguous" ||
    Object.prototype.hasOwnProperty.call(meta, "openTxSignature") ||
    Object.prototype.hasOwnProperty.call(meta, "lastValidBlockHeight")
  );
}

/** Best-effort equity event — audit trail only, never fails the money op. */
async function recordLoopEquityEvent(p: {
  walletAddress: string;
  eventType: "loop_open" | "loop_close" | "loop_unwind" | "loop_delever_hold" | "loop_relever";
  amountLamports: bigint;
  txSignature: string | null;
  notes: string;
}): Promise<void> {
  try {
    await storage.createEquityEvent({
      walletAddress: p.walletAddress,
      tradingBotId: null,
      eventType: p.eventType,
      amount: lamportsToSol(p.amountLamports),
      assetType: "SOL",
      txSignature: p.txSignature,
      notes: p.notes,
    });
  } catch (e) {
    console.warn(`[loop-executor] equity event ${p.eventType} failed (non-fatal):`, e);
  }
}

function isUniqueViolation(e: unknown): boolean {
  const code = (e as any)?.code;
  const msg = e instanceof Error ? e.message : String(e);
  return code === "23505" || /duplicate key|unique constraint/i.test(msg);
}

// --- Shared position loading ---------------------------------------------------

interface LoadedLoopPosition {
  pos: BorrowPosition;
  vaultId: number;
  nftId: number;
}

async function loadOpenLoopPosition(
  walletAddress: string,
  borrowPositionId: string,
): Promise<{ ok: true; loaded: LoadedLoopPosition } | { ok: false; error: string }> {
  const pos = await storage.getBorrowPosition(walletAddress, borrowPositionId);
  if (!pos) return { ok: false, error: "Loop position not found." };
  if ((pos as any).kind !== "loop") return { ok: false, error: "That position is not a loop position." };
  if (pos.status !== "open") return { ok: false, error: `Loop position is '${pos.status}', not open.` };
  const vaultId = Number(pos.venueVaultId);
  const nftId = Number(pos.venuePositionId);
  if (!Number.isInteger(vaultId) || vaultId <= 0 || !Number.isInteger(nftId) || nftId <= 0) {
    return { ok: false, error: "Loop position row is missing its venue vault/position identifiers." };
  }
  return { ok: true, loaded: { pos, vaultId, nftId } };
}

// --- OPEN ----------------------------------------------------------------------

export interface LoopOpenParams {
  walletAddress: string;
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  /** Jupiter Lend Multiply vault id (must be on LOOP_VAULT_ALLOWLIST). */
  vaultId: number;
  /** SOL principal, raw lamports. */
  principalLamports: bigint;
  /**
   * Leverage multiple. OMIT for the normal path: the executor derives the
   * DYNAMIC target (live vault LT + min open health buffer + per-vault and
   * platform caps, positive carry required) via `computeLoopTargetLeverage`.
   * An explicit value is an owner-only API override — still fully policy-gated.
   */
  leverage?: number;
  slippageBps?: number;
  clientRequestId?: string;
  /**
   * Report the exact SOL bar (principal + rent + fees) WITHOUT executing.
   * The client uses this to collect the FULL bar from the USER's wallet
   * before the real open, so an open never consumes SOL the agent wallet
   * already held — that SOL is gas plumbing for other operations.
   */
  preflightOnly?: boolean;
  /**
   * INTERNAL: set ONLY by callers that already hold the borrow lock for this
   * exact (wallet, null, vaultId) key (e.g. executeLoopLstDepositOpen, which
   * serializes swap + open under one lock). The lock is a promise-chain
   * serializer and NOT reentrant — nesting the same key self-deadlocks
   * forever. Never set this from a route handler.
   */
  callerHoldsBorrowLock?: boolean;
}

export interface LoopOpenResult {
  success: boolean;
  borrowPositionId?: string;
  venuePositionId?: number;
  signature?: string;
  observedCollateralRaw?: string;
  observedDebtRaw?: string;
  policyReasons?: LoopPolicyReason[];
  verifyWarning?: string;
  error?: string;
  /** Present when the failure is a SOL shortfall the user can fix by depositing. */
  gasShortfall?: LoopGasShortfall;
  /** Present (with success:true) when the call was a preflight — nothing executed. */
  preflight?: LoopGasShortfall;
}

/** Exact SOL bar vs. what the agent wallet held, for a client "deposit X SOL" prompt. */
export interface LoopGasShortfall {
  requiredLamports: number;
  heldLamports: number;
}

/**
 * Fresh rate row for one vault from the SAME staleness-gated table the
 * allocation brain reads. If the table has no fresh row (e.g. right after
 * boot, before the hourly sampler has run), sample ONCE on demand and re-read.
 * Returns null when rates are genuinely unavailable — callers fail closed.
 */
async function resolveFreshLoopRate(vaultId: number): Promise<FreshLoopRate | null> {
  const staleness = LOOP_ALLOCATION_POLICY.rateStalenessMs;
  try {
    let rates = await getFreshLoopRates(staleness);
    let row = rates.get(vaultId) ?? null;
    if (!row) {
      await sampleAndPersistLoopRates();
      rates = await getFreshLoopRates(staleness);
      row = rates.get(vaultId) ?? null;
    }
    return row;
  } catch (e) {
    console.error(`[loop-executor] rate resolution failed for vault ${vaultId}:`, e);
    return null;
  }
}

// --- LST deposit assets ------------------------------------------------------

/** One LST the loop accepts as a deposit (its vault's collateral token). */
export interface LoopDepositAsset {
  vaultId: number;
  symbol: string;
  mint: string;
  decimals: number;
}

// Mint/decimals never change for a vault, so successful reads cache forever.
const depositAssetCache = new Map<number, LoopDepositAsset>();

/**
 * Every LST the loop can accept as a deposit: the collateral token of each
 * tracked loop vault (allowlisted or not — deposits are converted to SOL, so
 * any tracked LST is fine as an INPUT; the open itself still only targets
 * allowlisted vaults). Fail-open per asset: an unreadable vault config just
 * omits that asset — the client then simply doesn't offer it.
 */
export async function getLoopDepositAssets(): Promise<LoopDepositAsset[]> {
  const borrowRoute = new JupiterLendBorrowRoute();
  const out: LoopDepositAsset[] = [];
  for (const reg of LOOP_RATE_REGISTRY) {
    const cached = depositAssetCache.get(reg.vaultId);
    if (cached) {
      out.push(cached);
      continue;
    }
    try {
      const cfg = await borrowRoute.getLoopVaultConfig(reg.vaultId);
      if (!cfg || cfg.debtMint !== WSOL_MINT || !cfg.collateralMint) continue;
      const asset: LoopDepositAsset = {
        vaultId: reg.vaultId,
        symbol: cfg.collateralSymbol,
        mint: cfg.collateralMint,
        decimals: cfg.collateralDecimals,
      };
      depositAssetCache.set(reg.vaultId, asset);
      out.push(asset);
    } catch {
      /* omit this asset; retried on the next call */
    }
  }
  return out;
}

export async function executeLoopOpen(params: LoopOpenParams): Promise<LoopOpenResult> {
  const { walletAddress, agentPublicKey, agentSecretKey, vaultId, principalLamports } = params;
  const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

  if (principalLamports <= 0n) return { success: false, error: "Principal must be > 0." };
  if (!LOOP_VAULT_ALLOWLIST[vaultId]) {
    return { success: false, error: `Vault ${vaultId} is not on the loop launch allowlist.` };
  }

  // --- F4 RECOVERY GATE (SL-07) ----------------------------------------------
  // A stuck PENDING row for this (wallet, vault) is reconciled BEFORE any
  // fresh-open gate below (config read, carry/leverage policy, sizing): the
  // recovery of an attempt that already broadcast must never depend on
  // TODAY'S profitability or this retry's parameters. Same lock dispatch as
  // runOpen itself (the borrow lock is NOT reentrant — inline when the caller
  // already holds the key); runOpen's active-row check stays unchanged below
  // as the race-closing recheck.
  const recoveryGate = () =>
    reconcilePendingLoopOpenForVault({
      walletAddress,
      vaultId,
      clientRequestId: params.clientRequestId ?? null,
    });
  const recoveryBlock = params.callerHoldsBorrowLock
    ? await recoveryGate()
    : await withBorrowLock(borrowLockKey(walletAddress, null, vaultId), recoveryGate);
  if (recoveryBlock) return recoveryBlock;

  const borrowRoute = new JupiterLendBorrowRoute();
  const cfg = await borrowRoute.getLoopVaultConfig(vaultId);
  if (!cfg) return { success: false, error: `Could not read loop vault ${vaultId} config — refusing (fail closed).` };
  if (cfg.debtMint !== WSOL_MINT) {
    return { success: false, error: `Vault ${vaultId} does not borrow WSOL — refusing.` };
  }

  // DYNAMIC leverage: the venue's LIVE liquidation threshold + the min open
  // health buffer + the caps decide, and only when the carry is PROFITABLE
  // (staking APY > borrow APR — otherwise levering loses money and we refuse,
  // exactly like the allocation brain holds existing rows unlevered).
  // Staking APY comes from the same fresh rate table the brain reads
  // (sample once on demand if empty, e.g. right after boot); fail closed.
  let stakingApyForGate: number | null = null;
  let leverage: number;
  {
    const rateRes = await resolveFreshLoopRate(vaultId);
    stakingApyForGate = rateRes?.stakingApy ?? null;
    if (typeof params.leverage === "number") {
      leverage = params.leverage; // owner override — still fully policy-gated below
    } else {
      const target = computeLoopTargetLeverage({
        vaultId,
        liquidationThreshold: cfg.liquidationThreshold,
        stakingApy: rateRes?.stakingApy ?? null,
        borrowApr: cfg.borrowApr,
      });
      if (target.leverage === null) {
        return {
          success: false,
          error:
            target.reason === "carry_nonpositive"
              ? `Looping ${cfg.collateralSymbol} is not profitable right now (staking yield does not beat the SOL borrow rate) — refusing to open a levered position.`
              : `Cannot determine a safe leverage for ${cfg.collateralSymbol} right now (${target.reason ?? "inputs unreadable"}) — refusing (fail closed). Try again shortly.`,
        };
      }
      leverage = target.leverage;
    }
  }

  // Pure sizing (throws on insane leverage) — before any money I/O.
  let flashLamports: bigint;
  let totalSwapLamports: bigint;
  try {
    const amounts = computeLoopOpenAmounts(principalLamports, leverage);
    flashLamports = amounts.flashLamports;
    totalSwapLamports = amounts.totalSwapLamports;
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
  const minBorrowRaw = BigInt(cfg.minimumBorrowingRaw || "0");
  if (flashLamports < minBorrowRaw) {
    return {
      success: false,
      error: `Borrowed leg ${lamportsToSol(flashLamports)} SOL is below the vault minimum ${lamportsToSol(minBorrowRaw)} SOL. Increase the principal.`,
    };
  }

  const runOpen = async (): Promise<LoopOpenResult> => {
    const connection = getServerConnection();
    const agentPubkey = new PublicKey(agentPublicKey);
    const wsolMintPk = new PublicKey(WSOL_MINT);
    const lstMintPk = new PublicKey(cfg.collateralMint);

    // ONE loop per (wallet, vault): refuse while an open OR pending row exists.
    const existing = await storage.getBorrowPositions(walletAddress, null, "loop");
    const active = existing.find(
      (r) => String(r.venueVaultId) === String(vaultId) && (r.status === "open" || r.status === "pending"),
    );
    if (active) {
      return {
        success: false,
        error:
          active.status === "open"
            ? `You already have an open ${cfg.collateralSymbol} loop on vault ${vaultId}. Close it before opening a new one.`
            : `A previous ${cfg.collateralSymbol} loop attempt is still unresolved (position ${active.id}). It must be reconciled before a new open.`,
      };
    }

    // NFT reuse: a full close leaves the position NFT zeroed-but-alive on-chain
    // and its ~0.0215 SOL rent is NOT reclaimable — reuse it instead of minting.
    // Fail closed: reuse ONLY when the live read PROVES the position is empty
    // (an unreadable candidate mints fresh — never risk writing into a live position).
    let reuseCandidate: BorrowPosition | null = null;
    let reuseNftId = 0;
    const closedSameVault = existing
      .filter((r) => r.status === "closed" && String(r.venueVaultId) === String(vaultId))
      .slice(0, REUSE_SCAN_LIMIT);
    for (const cand of closedSameVault) {
      const candNft = Number(cand.venuePositionId);
      if (!Number.isInteger(candNft) || candNft <= 0) continue;
      const live = await borrowRoute.readLoopLivePositionHealth(vaultId, candNft).catch(() => null);
      if (live && BigInt(live.debtRaw) === 0n && BigInt(live.collateralRaw) === 0n) {
        reuseCandidate = cand;
        reuseNftId = candNft;
        break;
      }
    }
    const willMint = reuseNftId === 0;

    // ATA presence — creates MUST be a separate prep tx (loop tx is 1215/1232 bytes).
    const wsolAta = ataFor(agentPubkey, wsolMintPk);
    const lstAta = ataFor(agentPubkey, lstMintPk);
    const infos = await connection.getMultipleAccountsInfo([wsolAta, lstAta]);
    const prepIxs: TransactionInstruction[] = [];
    if (!infos[0]) prepIxs.push(ixCreateAtaIdempotent(agentPubkey, agentPubkey, wsolMintPk));
    if (!infos[1]) prepIxs.push(ixCreateAtaIdempotent(agentPubkey, agentPubkey, lstMintPk));

    // Gas gate: principal + NFT mint rent (first open) + missing ATA rents + fees.
    const extraRentLamports =
      Number(principalLamports) +
      (willMint ? LOOP_NFT_MINT_RENT_LAMPORTS : 0) +
      prepIxs.length * ATA_RENT_LAMPORTS +
      LOOP_FEE_HEADROOM_LAMPORTS;
    // User-funded: the "gas" bar includes the PRINCIPAL, so never auto-sell the
    // account's trading USDC to meet it — fail closed with the exact shortfall
    // and let the client prompt a SOL deposit from the user's wallet.
    const gas = await ensureVaultGas({
      payingPublicKey: agentPublicKey,
      funderPublicKey: agentPublicKey,
      funderSecretKey: agentSecretKey,
      destMint: null,
      label: "Loop Open",
      extraRentLamports,
      allowUsdcRefill: false,
    });
    // PREFLIGHT: return the exact bar without executing anything — even when
    // the wallet technically holds enough. The client always collects the FULL
    // bar from the USER's wallet first, so pre-existing agent SOL (gas
    // plumbing) is never consumed as loop principal.
    if (params.preflightOnly) {
      return {
        success: true,
        preflight: {
          requiredLamports: gas.requiredLamports,
          heldLamports: gas.payerLamportsBefore + (gas.refilledLamports ?? 0) + (gas.fundedLamports ?? 0),
        },
      };
    }
    if (!gas.ok) {
      return {
        success: false,
        error: gas.error || "Loop Open: insufficient SOL for principal + rent + fees.",
        gasShortfall: {
          requiredLamports: gas.requiredLamports,
          heldLamports: gas.payerLamportsBefore + (gas.refilledLamports ?? 0) + (gas.fundedLamports ?? 0),
        },
      };
    }

    // Durable op row (idempotency-lite: a duplicate clientRequestId refuses).
    let opId: string;
    try {
      const op = await storage.createBorrowOperation({
        walletAddress,
        operationType: "loop_open",
        status: "pending",
        step: "initialized",
        clientRequestId: params.clientRequestId ?? null,
        metadata: {
          kind: "loop",
          vaultId,
          collateralSymbol: cfg.collateralSymbol,
          principalLamports: principalLamports.toString(),
          leverage,
          slippageBps,
          flashLamports: flashLamports.toString(),
          reuseNftId: reuseNftId || null,
        },
      });
      opId = op.id;
    } catch (e) {
      if (isUniqueViolation(e)) {
        return { success: false, error: "This loop open was already submitted. Check its status before retrying." };
      }
      throw e;
    }

    // F5 lifecycle context (SL-08): the outer catch below can only repair a
    // stranded PENDING row if it knows which row this attempt created/claimed
    // and its restore semantics. Plain locals — a throw at ANY later line
    // (even the op-row link write itself, which is what strands an UNLINKED
    // row) still has the exact row id in hand.
    let lifecyclePositionId: string | null = null;
    let lifecycleWasReuse = false;

    try {
      // Prep tx (one-time per wallet): create missing token accounts.
      if (prepIxs.length > 0) {
        const prep = await executeAgentInstructionsConfirmOnly({
          agentPublicKey,
          agentSecretKey,
          instructions: [...cuIxs(PREP_CU_LIMIT), ...prepIxs],
          label: "Loop Open ATA prep",
        });
        if (!prep.success) {
          await failOp(opId, "ata_prep_failed", prep.error || "ATA prep tx did not confirm.");
          return { success: false, error: prep.error || "Loop Open: token account prep failed. Nothing was moved." };
        }
        await storage.updateBorrowOperation(opId, {
          step: "atas_prepared",
          ...(prep.signature ? { appendTxSignature: prep.signature } : {}),
        });
      } else {
        await storage.updateBorrowOperation(opId, { step: "atas_prepared" });
      }

      // Swap quote (WSOL -> LST) — its REAL market rate feeds the policy gate.
      const quote = await jupQuote(WSOL_MINT, cfg.collateralMint, totalSwapLamports, slippageBps);
      const minOut = BigInt(quote.otherAmountThreshold);
      if (minOut <= 0n) {
        await failOp(opId, "quote_failed", "Swap quote returned a zero min-out.");
        return { success: false, error: "Loop Open: swap quote unusable. Nothing was moved." };
      }
      const outAmountNum = Number(quote.outAmount);
      const marketSolPerLst =
        Number.isFinite(outAmountNum) && outAmountNum > 0 ? Number(totalSwapLamports) / outAmountNum : null;

      // Policy gate — PURE, fail closed on unreadables. After the quote so the
      // depeg check sees the REAL market rate this open would execute at.
      const decision = evaluateLoopOpenRequest({
        vaultId,
        requestedLeverage: leverage,
        principalLamports,
        stakePoolSolPerLst: cfg.oraclePriceOperateUsd, // SOL-per-LST on WSOL-debt vaults
        marketSolPerLst,
        borrowApr: cfg.borrowApr,
        // Per-vault withdraw-side utilization — NOT cfg.utilization, which is
        // the debt-token market metric and reads >1 on WSOL (would deny every
        // loop open with a nonsense "265%"). null = unreadable → policy denies.
        utilization: cfg.withdrawUtilization,
        stakingApy: stakingApyForGate,
        liquidationThreshold: cfg.liquidationThreshold,
      });
      if (!decision.allowed) {
        const denyMsgs = decision.reasons.filter((r) => r.severity === "deny").map((r) => r.message);
        await failOp(opId, "policy_denied", denyMsgs.join(" | ") || "Loop policy denied the open.");
        return {
          success: false,
          policyReasons: decision.reasons,
          error: `Loop Open blocked by risk policy: ${denyMsgs.join(" ")}`,
        };
      }

      const swapResp = await jupSwapIxs(quote, agentPublicKey);
      if ((swapResp.setupInstructions || []).length > 0) {
        // Creates inside the loop tx blow the 1232-byte limit — abort clean.
        await failOp(opId, "swap_setup_ixs", `Swap returned ${swapResp.setupInstructions.length} setup ix(s) despite ATAs existing.`);
        return { success: false, error: "Loop Open: swap route needs extra account setup — aborted before any transfer. Retry shortly." };
      }
      if (!swapResp.swapInstruction) {
        await failOp(opId, "swap_ix_missing", "Swap response carried no swapInstruction.");
        return { success: false, error: "Loop Open: swap instructions unavailable. Nothing was moved." };
      }

      // SDK legs (lazy imports — heavy deps stay out of boot).
      const flash = await import("@jup-ag/lend/flashloan");
      const borrowMod = await import("@jup-ag/lend/borrow");
      const BN = (await import("bn.js")).default;
      const { borrowIx, paybackIx } = await flash.getFlashloanIx({
        amount: new BN(flashLamports.toString()),
        asset: wsolMintPk,
        signer: agentPubkey,
        connection,
      });

      const plan = planLoopOpen({
        lstCollateralRaw: minOut,
        wsolDebtRaw: flashLamports,
        positionId: reuseNftId,
      });
      const operate = await borrowMod.getOperateIx({
        vaultId,
        positionId: plan.positionId,
        colAmount: specToBN(BN, plan.colAmount, "col", borrowMod.MAX_WITHDRAW_AMOUNT, borrowMod.MAX_REPAY_AMOUNT),
        debtAmount: specToBN(BN, plan.debtAmount, "debt", borrowMod.MAX_WITHDRAW_AMOUNT, borrowMod.MAX_REPAY_AMOUNT),
        connection,
        signer: agentPubkey,
      });
      const nftId = reuseNftId || Number(operate.nftId);
      if (!Number.isInteger(nftId) || nftId <= 0) {
        await failOp(opId, "nft_id_unresolved", `SDK did not resolve a position NFT id (got ${String(operate.nftId)}).`);
        return { success: false, error: "Loop Open: could not resolve the position id. Nothing was moved." };
      }

      // Position row BEFORE broadcast — a crash after send still has a row to reconcile.
      let position: BorrowPosition;
      if (reuseCandidate) {
        const updated = await storage.updateBorrowPosition(
          reuseCandidate.id,
          {
            status: "pending",
            venuePositionId: String(nftId),
            collateralAmountRaw: minOut.toString(),
            debtAmountRaw: flashLamports.toString(),
          },
          "closed", // CAS: only claim a row that is STILL closed
        );
        if (!updated) {
          await failOp(opId, "reuse_cas_lost", `Reuse row ${reuseCandidate.id} was claimed concurrently.`);
          return { success: false, error: "Loop Open: position row changed underneath us — retry. Nothing was moved." };
        }
        position = updated;
        lifecyclePositionId = position.id;
        lifecycleWasReuse = true;
      } else {
        position = await storage.createBorrowPosition({
          walletAddress,
          tradingBotId: null,
          debtVenue: DEBT_VENUE,
          venueVaultId: String(vaultId),
          venuePositionId: String(nftId),
          collateralAssetKey: cfg.collateralSymbol.toLowerCase(),
          collateralMint: cfg.collateralMint,
          collateralAmountRaw: minOut.toString(),
          debtAssetKey: "wsol",
          debtMint: WSOL_MINT,
          debtAmountRaw: flashLamports.toString(),
          status: "pending",
          kind: "loop",
        });
        lifecyclePositionId = position.id;
        lifecycleWasReuse = false;
      }
      await storage.updateBorrowOperation(opId, { borrowPositionId: position.id });

      // Restore helper for provably-nothing-moved failures.
      const restorePositionRow = async () => {
        await restoreLoopPendingRow(position.id, !!reuseCandidate);
      };

      // The atomic sandwich — verbatim probe order.
      const instructions: TransactionInstruction[] = [
        ...cuIxs(LOOP_CU_LIMIT),
        SystemProgram.transfer({ fromPubkey: agentPubkey, toPubkey: wsolAta, lamports: Number(principalLamports) }),
        ixSyncNative(wsolAta),
        borrowIx,
        deserializeJupIx(swapResp.swapInstruction),
        ...operate.ixs,
        paybackIx,
      ];
      const alts = [
        ...(await loadAlts(connection, swapResp.addressLookupTableAddresses || [])),
        ...(operate.addressLookupTableAccounts || []),
      ];

      const exec = await executeAgentInstructionsConfirmOnly({
        agentPublicKey,
        agentSecretKey,
        instructions,
        addressLookupTables: alts,
        label: "Loop Open",
        onBeforeBroadcast: async (info) => {
          // FATAL write-ahead: throw => tx is NOT broadcast, nothing moved.
          const updated = await storage.updateBorrowOperation(opId, {
            step: "loop_sig_writeahead",
            appendTxSignature: info.signature,
            mergeMetadata: {
              blockhash: info.blockhash,
              lastValidBlockHeight: info.lastValidBlockHeight,
              // F4: exact main-open tx identity — same fail-closed contract
              // as closeTxSignature on the close leg (pickOpenTxSig cross-
              // checks it against the FINAL txSignatures entry).
              openTxSignature: info.signature,
            },
          });
          if (!updated) throw new Error("write-ahead signature persist failed — refusing to broadcast");
        },
      });

      if (exec.onChainFailed || (!exec.success && !exec.signature)) {
        // Provably nothing moved (atomic on-chain failure) or never broadcast.
        await restorePositionRow();
        await failOp(opId, exec.onChainFailed ? "tx_failed_onchain" : "exec_failed", exec.error || "Loop open tx failed.");
        return { success: false, signature: exec.signature, error: exec.error || "Loop Open failed — nothing was moved." };
      }

      if (!exec.success) {
        // AMBIGUOUS: sent, confirmation unknown. Probe live state before deciding.
        // STRICT gate: the live read has NO ownership check and SDK-predicted NFT
        // ids are globally sequential, so a merely-nonempty position could be a
        // racing user's mint under the same predicted id. Finalize ONLY when the
        // observed amounts pass the exact loop-open verifier for OUR flash/minOut
        // legs; anything else stays pending (fail closed).
        const live = await borrowRoute.readLoopLivePositionHealth(vaultId, nftId).catch(() => null);
        if (live) {
          const strict = verifyLoopOpenOutcome({
            flashDebtRaw: flashLamports,
            minCollateralRaw: minOut,
            observedDebtRaw: BigInt(live.debtRaw),
            observedColRaw: BigInt(live.collateralRaw),
          });
          if (strict.ok) {
            // It landed and the amounts match OUR open — finalize with this read.
            return await finalizeLoopOpen({
              opId, position, cfg, borrowRoute, walletAddress, vaultId, nftId,
              flashLamports, minOut, principalLamports, leverage,
              signature: exec.signature!, preRead: live,
            });
          }
        }
        // Unreadable, still-empty, or amounts don't match our legs: fail CLOSED —
        // keep the pending row so the vault refuses new opens until reconciled.
        await failOp(
          opId,
          "open_ambiguous",
          `Confirmation unknown for ${exec.signature}; live position read ${live ? "did not strictly match our open legs" : "unreadable"}. Position row kept pending.`,
        );
        return {
          success: false,
          signature: exec.signature,
          borrowPositionId: position.id,
          error:
            "Loop Open was sent but could not be confirmed. The position row is held pending until the transaction is verified — check the signature before retrying.",
        };
      }

      return await finalizeLoopOpen({
        opId, position, cfg, borrowRoute, walletAddress, vaultId, nftId,
        flashLamports, minOut, principalLamports, leverage,
        signature: exec.signature!, preRead: null,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // F5 (SL-08): a throw AFTER the position row was created/claimed but
      // provably BEFORE the main open tx could have been broadcast must not
      // strand the row as a permanent pending blocker. Restore is gated on
      // the RELOADED durable op record — never in-memory reasoning alone:
      //  - reload fails             → fail closed (row stays pending);
      //  - write-ahead recorded     → the tx MAY be in flight → keep pending
      //    (the F4 reconciler resolves it from its exact signature later);
      //  - no write-ahead recorded  → the FATAL hook never persisted, so the
      //    tx was never broadcast → restore. The ATA-prep sig never counts.
      if (lifecyclePositionId) {
        let opNow: BorrowOperation | null | undefined;
        let reloadOk = false;
        try {
          opNow = await storage.getBorrowOperationById(opId);
          reloadOk = true;
        } catch (repairErr) {
          console.warn(
            `[loop-executor] open outer-catch: could not reload op ${opId} to prove pre-broadcast state — row ${lifecyclePositionId} stays pending (fail closed):`,
            repairErr,
          );
        }
        if (!reloadOk || !opNow) {
          // WO1-C1 (SL-08): nothing about the durable record is PROVEN — fail
          // closed WITHOUT touching its step or provenance. A later retry
          // reloads and classifies the ORIGINAL record; a generic failure
          // step written here would make a written-ahead attempt permanently
          // unclassifiable (strict selector fails → blocked → manual review).
          return { success: false, error: `Loop Open failed: ${msg}` };
        }
        if (loopOpenWriteaheadRecorded(opNow)) {
          // WO1-C2 (SL-08): the main-open tx MAY be in flight — keep the row
          // pending and do NOT mutate the op row AT ALL: no failed status, no
          // step write, no error-only update. The reload above is only a
          // SNAPSHOT and the borrow lock is only an in-process serializer: a
          // sibling deployment (blue/green overlap) can finalize this op as
          // succeeded between our reload and any write here, and a catch-side
          // write would overwrite that terminal result. The selector-eligible
          // step + exact signature evidence are already durable from the
          // write-ahead; the reconciler classifies them on the next retry.
          console.warn(
            `[loop-executor] open outer-catch: op ${opId} carries main-open write-ahead evidence — leaving the durable record untouched (row ${lifecyclePositionId} stays pending): ${msg}`,
          );
          return { success: false, error: `Loop Open failed: ${msg}` };
        }
        await restoreLoopPendingRow(lifecyclePositionId, lifecycleWasReuse);
      }
      await failOp(opId, "unexpected_error", msg);
      return { success: false, error: `Loop Open failed: ${msg}` };
    }
  };

  // The borrow lock is NOT reentrant (promise-chain serializer): a caller that
  // already holds this exact key must NOT re-acquire it or it deadlocks.
  if (params.callerHoldsBorrowLock) {
    return await runOpen();
  }
  return await withBorrowLock(borrowLockKey(walletAddress, null, vaultId), runOpen);
}

/** Success finalization for an open: authoritative live re-read gates everything. */
async function finalizeLoopOpen(p: {
  opId: string;
  position: BorrowPosition;
  cfg: BorrowVaultConfig;
  borrowRoute: JupiterLendBorrowRoute;
  walletAddress: string;
  vaultId: number;
  nftId: number;
  flashLamports: bigint;
  minOut: bigint;
  principalLamports: bigint;
  leverage: number;
  signature: string;
  preRead: LivePositionHealth | null;
}): Promise<LoopOpenResult> {
  const live = p.preRead ?? (await p.borrowRoute.readLoopLivePositionHealth(p.vaultId, p.nftId).catch(() => null));

  let observedColRaw = p.minOut;
  let observedDebtRaw = p.flashLamports;
  let verifyWarning: string | undefined;
  let healthSource = "loop_open_onchain";

  if (live) {
    observedColRaw = BigInt(live.collateralRaw);
    observedDebtRaw = BigInt(live.debtRaw);
    const verify = verifyLoopOpenOutcome({
      flashDebtRaw: p.flashLamports,
      minCollateralRaw: p.minOut,
      observedDebtRaw,
      observedColRaw,
    });
    if (!verify.ok) {
      // ADVISORY: the atomic tx landed, so the position IS open on-chain — we
      // record the on-chain truth and surface the anomaly loudly.
      verifyWarning = `Loop open verification flagged '${verify.reason}' — recorded on-chain observed amounts.`;
    }
  } else {
    // Confirmed tx + unreadable position: it opened, but we could not verify.
    // Record PLANNED amounts (flash leg = debt ceiling, minOut = collateral floor).
    verifyWarning = "Loop opened (tx confirmed) but the live position read failed — recorded planned amounts.";
    healthSource = "loop_open_unverified";
  }

  const snapshot = buildLoopHealthSnapshot(p.cfg, observedColRaw, observedDebtRaw, live?.oraclePriceUsd ?? null, healthSource);
  const opened = await storage.updateBorrowPosition(
    p.position.id,
    {
      status: "open",
      venuePositionId: String(p.nftId),
      collateralAmountRaw: observedColRaw.toString(),
      debtAmountRaw: observedDebtRaw.toString(),
      healthSnapshot: snapshot,
      healthAsOf: new Date(),
      healthSource,
      // P3 policy loop: a fresh open is by definition the LEVERED state.
      policyState: "levered",
      policyReason: "loop_open",
      policyStateChangedAt: new Date(),
    },
    "pending",
  );
  if (!opened) {
    console.warn(`[loop-executor] open finalize: position ${p.position.id} was not pending — recording anyway is skipped (CAS lost).`);
  }

  await storage.updateBorrowOperation(p.opId, {
    status: "succeeded",
    step: "final_read",
    result: {
      signature: p.signature,
      nftId: p.nftId,
      observedCollateralRaw: observedColRaw.toString(),
      observedDebtRaw: observedDebtRaw.toString(),
      ...(verifyWarning ? { verifyWarning } : {}),
    },
  });

  // Equity event ONLY on CAS win. Losing the pending→open CAS means another
  // finalizer (a concurrent reconcile in a sibling process — e.g. blue/green
  // deploy overlap) already owned this exact open and recorded its event;
  // firing again would double-count the principal in loop accounting.
  if (opened) {
    await recordLoopEquityEvent({
      walletAddress: p.walletAddress,
      eventType: "loop_open",
      amountLamports: p.principalLamports,
      txSignature: p.signature,
      notes: `Opened ${p.cfg.collateralSymbol} loop: ${lamportsToSol(p.principalLamports)} SOL principal at ${p.leverage}x`,
    });
  }

  return {
    success: true,
    borrowPositionId: p.position.id,
    venuePositionId: p.nftId,
    signature: p.signature,
    observedCollateralRaw: observedColRaw.toString(),
    observedDebtRaw: observedDebtRaw.toString(),
    ...(verifyWarning ? { verifyWarning } : {}),
  };
}

// --- OPEN RECOVERY (F4/F5: SL-07/08/10) ----------------------------------------

type LoopOpenReconcileOutcome =
  | { outcome: "finalized_open"; result: LoopOpenResult }
  | { outcome: "restored" }
  | { outcome: "blocked"; reason: string };

/**
 * Reconcile ONE ambiguous/stuck loop-open attempt from its DURABLE records +
 * on-chain truth. Money invariants:
 *  - NEVER clears a pending row while the recorded open tx could still land
 *    (still-valid / RPC-unverifiable / malformed provenance ⇒ blocked).
 *  - Adopting a LANDED open finalizes from the ORIGINAL op/row values
 *    (principal, leverage, flash, minOut, nftId) — never a retry's parameters,
 *    and never guesses: any unparseable original ⇒ blocked.
 *  - Restores ONLY on proof the tx is dead: provably never broadcast (no
 *    write-ahead record — the hook is FATAL), confirmed on-chain failure
 *    (atomic ⇒ nothing moved), or expiry past lastValidBlockHeight + buffer
 *    read from a LIVE block height.
 * Double-finalize is impossible: finalizeLoopOpen's row CAS (pending→open)
 * precedes the op's succeeded write, succeeded ops are adopted—not re-run—by
 * every caller, and finalize itself never broadcasts anything.
 * The caller must hold the borrow lock for this (wallet, vault) key.
 *
 * @internal exported for unit tests only — not a public API surface.
 */
export async function reconcileAmbiguousLoopOpen(p: {
  op: BorrowOperation;
  position: BorrowPosition;
  walletAddress: string;
  connection: Pick<Connection, "getSignatureStatuses" | "getBlockHeight">;
  borrowRoute: JupiterLendBorrowRoute;
}): Promise<LoopOpenReconcileOutcome> {
  const { op, position } = p;
  const meta = (op.metadata ?? {}) as Record<string, unknown>;
  const wasReuse = meta.reuseNftId != null;
  const restoreBlocked: LoopOpenReconcileOutcome = {
    outcome: "blocked",
    reason: "its position row could not be restored (state changed underneath the repair — will re-check).",
  };

  // (a) Steps that already PROVED the tx dead (their own row-restore is
  // best-effort and may have failed mid-crash) — just re-run the restore.
  if (
    op.status === "failed" &&
    (op.step === "tx_failed_onchain" ||
      op.step === "exec_failed" ||
      op.step === "reconciled_tx_failed_onchain" ||
      op.step === "reconciled_tx_expired" ||
      op.step === "pre_broadcast_reconciled")
  ) {
    return (await restoreLoopPendingRow(position.id, wasReuse)) ? { outcome: "restored" } : restoreBlocked;
  }

  // (b) No write-ahead record ⇒ the main open tx was provably never broadcast
  // (the FATAL hook persists step+signature or the send is aborted).
  if (!loopOpenWriteaheadRecorded(op)) {
    if (!(await restoreLoopPendingRow(position.id, wasReuse))) return restoreBlocked;
    if (op.status === "pending") {
      await failOp(
        op.id,
        "pre_broadcast_reconciled",
        "Open reconciled: main open tx provably never broadcast (no write-ahead record). Row restored.",
      );
    }
    return { outcome: "restored" };
  }

  // (c) Broadcast window: resolve from the EXACT recorded signature only.
  const verdict = await verifyOpenTxLanded(op, p.connection);
  if (verdict === "malformed") {
    return {
      outcome: "blocked",
      reason: "its transaction provenance is malformed — refusing to guess (manual review required).",
    };
  }
  if (verdict === "still_valid") {
    return {
      outcome: "blocked",
      reason: "its open transaction may still land (not provably expired) — waiting for on-chain resolution.",
    };
  }
  if (verdict === "unverifiable") {
    return {
      outcome: "blocked",
      reason: "the RPC could not verify its open transaction — will re-check on the next attempt.",
    };
  }

  if (verdict === "onchain_failed" || verdict === "expired") {
    if (!(await restoreLoopPendingRow(position.id, wasReuse))) return restoreBlocked;
    const step = verdict === "expired" ? "reconciled_tx_expired" : "reconciled_tx_failed_onchain";
    const note =
      verdict === "expired"
        ? "Open reconciled: recorded open tx expired past lastValidBlockHeight without landing. Row restored."
        : "Open reconciled: recorded open tx failed on-chain (atomic — nothing moved). Row restored.";
    if (op.status === "pending") {
      await failOp(op.id, step, note);
    } else {
      try {
        await storage.updateBorrowOperation(op.id, { step });
      } catch {
        /* breadcrumb only — the restore already succeeded */
      }
    }
    return { outcome: "restored" };
  }

  // verdict === "landed": finalize from the ORIGINAL durable values only.
  const sig = pickOpenTxSig(op);
  if (!sig) {
    return {
      outcome: "blocked",
      reason: "its transaction provenance is malformed — refusing to guess (manual review required).",
    };
  }
  const vaultId = Number(meta.vaultId);
  const nftId = Number(position.venuePositionId);
  const leverage = Number(meta.leverage);
  let flashLamports: bigint;
  let minOut: bigint;
  let principalLamports: bigint;
  try {
    flashLamports = BigInt(String(meta.flashLamports));
    minOut = BigInt(String(position.collateralAmountRaw));
    principalLamports = BigInt(String(meta.principalLamports));
  } catch {
    return {
      outcome: "blocked",
      reason: "its open LANDED but the original amounts are unreadable — manual review required (never finalizing from guesses).",
    };
  }
  if (
    !Number.isInteger(vaultId) ||
    vaultId <= 0 ||
    String(position.venueVaultId) !== String(vaultId) ||
    !Number.isInteger(nftId) ||
    nftId <= 0 ||
    flashLamports <= 0n ||
    minOut <= 0n ||
    principalLamports <= 0n ||
    !Number.isFinite(leverage) ||
    leverage < 1
  ) {
    return {
      outcome: "blocked",
      reason: "its open LANDED but the original records are inconsistent — manual review required (never finalizing from guesses).",
    };
  }
  const cfg = await p.borrowRoute.getLoopVaultConfig(vaultId).catch(() => null);
  if (!cfg) {
    return {
      outcome: "blocked",
      reason: "its open LANDED but the vault config is unreadable right now — will finalize on the next attempt.",
    };
  }
  const result = await finalizeLoopOpen({
    opId: op.id,
    position,
    cfg,
    borrowRoute: p.borrowRoute,
    walletAddress: p.walletAddress,
    vaultId,
    nftId,
    flashLamports,
    minOut,
    principalLamports,
    leverage,
    signature: sig,
    preRead: null,
  });
  return { outcome: "finalized_open", result };
}

/**
 * F4 recovery gate for executeLoopOpen (SL-07): when THIS (wallet, vault) has
 * a stuck PENDING loop row, reconcile it BEFORE any fresh-open gate runs.
 *
 * Returns null when the fresh open may proceed (no pending row, or the dead
 * attempt's row was just restored); otherwise the LoopOpenResult to surface —
 * the fail-closed refusal (row kept pending), or, for the EXACT idempotent
 * retry of an attempt that actually landed, its adopted success result.
 *
 * The op is established ONLY by position link or exact client request id —
 * never by loose vault scans or timestamps; zero or 2+ candidates ⇒ blocked.
 */
async function reconcilePendingLoopOpenForVault(args: {
  walletAddress: string;
  vaultId: number;
  clientRequestId: string | null;
}): Promise<LoopOpenResult | null> {
  const { walletAddress, vaultId } = args;

  let pendingScan: BorrowPosition | undefined;
  try {
    const rows = await storage.getBorrowPositions(walletAddress, null, "loop");
    pendingScan = rows.find((r) => String(r.venueVaultId) === String(vaultId) && r.status === "pending");
  } catch {
    // Rows unreadable: let the normal open flow surface the read failure.
    return null;
  }
  if (!pendingScan) return null;
  const pendingRow = pendingScan;

  const blocked = (reason: string): LoopOpenResult => ({
    success: false,
    error: `A previous loop open attempt on vault ${vaultId} is still unresolved (position ${pendingRow.id}): ${reason}`,
  });

  // Establish the EXACT associated operation — link or exact crid only.
  let op: BorrowOperation | null = null;
  try {
    if (args.clientRequestId) {
      const byCrid = await storage.getBorrowOperationByClientRequestId(walletAddress, args.clientRequestId);
      if (byCrid && byCrid.operationType === "loop_open" && byCrid.borrowPositionId === pendingRow.id) {
        if (byCrid.status === "succeeded" || byCrid.status === "completed") {
          // Idempotent retry of an attempt that already finished — adopt its
          // durable result verbatim; never open again under the same crid.
          // (Row still pending here = finalize's tolerated lost-CAS corner.)
          const r = (byCrid.result ?? {}) as Record<string, unknown>;
          return {
            success: true,
            borrowPositionId: pendingRow.id,
            ...(Number.isInteger(Number(pendingRow.venuePositionId)) && Number(pendingRow.venuePositionId) > 0
              ? { venuePositionId: Number(pendingRow.venuePositionId) }
              : {}),
            ...(typeof r.signature === "string" && r.signature ? { signature: r.signature } : {}),
            ...(typeof r.observedCollateralRaw === "string" ? { observedCollateralRaw: r.observedCollateralRaw } : {}),
            ...(typeof r.observedDebtRaw === "string" ? { observedDebtRaw: r.observedDebtRaw } : {}),
            ...(typeof r.verifyWarning === "string" ? { verifyWarning: r.verifyWarning } : {}),
          };
        }
        op = byCrid;
      }
    }
    if (!op) {
      const linked = (await storage.getBorrowOperations(walletAddress, pendingRow.id)).filter(
        (o) => o.operationType === "loop_open" && o.status !== "succeeded" && o.status !== "completed",
      );
      if (linked.length === 1) {
        op = linked[0];
      } else if (linked.length > 1) {
        return blocked(
          `${linked.length} unresolved operations reference it — cannot prove which one owns it (manual review required).`,
        );
      }
    }
  } catch {
    op = null;
  }
  if (!op) {
    return blocked("no single operation could be proven for it — it is never guessed at or cleared (manual review required).");
  }

  const outcome = await reconcileAmbiguousLoopOpen({
    op,
    position: pendingRow,
    walletAddress,
    connection: getServerConnection(),
    borrowRoute: new JupiterLendBorrowRoute(),
  });
  if (outcome.outcome === "restored") return null; // row repaired → fresh open proceeds
  if (outcome.outcome === "finalized_open") {
    if (args.clientRequestId && op.clientRequestId === args.clientRequestId) {
      return outcome.result; // this request IS that attempt — idempotent adopt
    }
    return {
      success: false,
      error: `A previous loop open on vault ${vaultId} actually LANDED and has just been reconciled (position ${pendingRow.id}). Close it before opening a new one.`,
    };
  }
  return blocked(outcome.reason);
}

// --- LST DEPOSIT → SOL → OPEN ------------------------------------------------

export interface LoopLstDepositOpenParams {
  walletAddress: string;
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  /** Mint of the deposited LST (must be a tracked loop deposit asset). */
  mint: string;
  /** Requested LST amount, raw base units — capped at what the wallet holds. */
  amountRaw: string;
  /** REQUIRED: the retry handle. The same id resumes, never re-swaps. */
  clientRequestId: string;
  /** Vault the OPEN targets (route picks the best one; must be allowlisted). */
  vaultId: number;
  slippageBps?: number;
}

export interface LoopLstDepositOpenResult {
  success: boolean;
  error?: string;
  /**
   * true = the deposited funds are safe in the internal wallet and a retry
   * with the SAME clientRequestId picks up where this attempt stopped.
   */
  resumable?: boolean;
  /**
   * true = this clientRequestId can NEVER succeed (op row already terminally
   * failed). The client must drop its retry handle and start a fresh deposit;
   * any tokens still in the internal wallet are swept by the next attempt.
   */
  terminal?: boolean;
  /** Realized SOL from the conversion (set once the swap step is done). */
  swappedLamports?: string;
  swapSignature?: string;
  open?: LoopOpenResult;
  alreadyCompleted?: boolean;
}

/**
 * Deposit-any-LST open: the user's LST is already in the agent wallet (client
 * transferred it via /api/agent/deposit-token); this converts it to SOL and
 * opens the loop into the given (best) vault, sizing the principal so the open
 * consumes ONLY the swapped SOL — pre-existing agent SOL stays untouched.
 *
 * Money-safety model (mirrors the borrow-op machine):
 * - Durable op row keyed by clientRequestId; every retry loads it and resumes
 *   from the step breadcrumb, so the swap can never run twice.
 * - Swap signature is written BEFORE broadcast (onBeforeBroadcast); an
 *   ambiguous swap is reconciled by ON-CHAIN SIGNATURE STATUS, never by a
 *   balance read alone (in-flight balances read stale → double-swap).
 * - Realized SOL = strict output delta (fail-closed reads only).
 * - The open leg reuses executeLoopOpen wholesale (its own op row, policy
 *   gates, verification). An open failure leaves the op at step 'swapped'
 *   with the SOL intact — retry-safe.
 */
export async function executeLoopLstDepositOpen(
  params: LoopLstDepositOpenParams,
): Promise<LoopLstDepositOpenResult> {
  const { walletAddress, agentPublicKey, agentSecretKey, mint } = params;
  const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

  if (!params.clientRequestId || typeof params.clientRequestId !== "string") {
    return { success: false, error: "clientRequestId is required for a safe retry path." };
  }

  // PIN the vault to the persisted op row BEFORE taking the lock. The lock key
  // includes vaultId, and the route re-picks the "best" vault on every call —
  // if that pick drifts between the original attempt and a retry, the retry
  // would take a DIFFERENT lock key and could run concurrently with the
  // original under disjoint locks (double-consuming the swapped SOL).
  let vaultId = params.vaultId;
  const priorOp = await storage.getBorrowOperationByClientRequestId(walletAddress, params.clientRequestId);
  if (priorOp && priorOp.operationType === "loop_lst_deposit") {
    const persisted = Number((priorOp.metadata as any)?.vaultId);
    if (Number.isFinite(persisted) && persisted > 0) {
      vaultId = persisted;
    }
  }

  if (!LOOP_VAULT_ALLOWLIST[vaultId]) {
    return { success: false, error: `Vault ${vaultId} is not on the loop launch allowlist.` };
  }
  const assets = await getLoopDepositAssets();
  const asset = assets.find((a) => a.mint === mint);
  if (!asset) {
    return { success: false, error: "This token is not supported as a loop deposit." };
  }
  if (mint === NATIVE_SOL_MINT || mint === WSOL_MINT) {
    return { success: false, error: "Use the normal SOL deposit path for SOL." };
  }

  const connection = getServerConnection();

  // Same lock the open path takes: one loop money-op per wallet+vault at a time.
  return await withBorrowLock(borrowLockKey(walletAddress, null, vaultId), async () => {
    // Load-or-create the durable op row (idempotent on clientRequestId).
    let op = await storage.getBorrowOperationByClientRequestId(walletAddress, params.clientRequestId);
    if (op && op.operationType !== "loop_lst_deposit") {
      return { success: false, error: "This request id was already used by a different operation." };
    }
    if (op && (op.status === "succeeded" || op.status === "completed")) {
      return { success: true, alreadyCompleted: true, swappedLamports: (op.metadata as any)?.realizedLamports };
    }
    if (op && op.status === "failed") {
      // terminal:true tells the client to DROP its retry handle: this id can
      // never succeed, and a fresh deposit sweeps any tokens still held.
      return {
        success: false,
        terminal: true,
        error: "This deposit attempt already failed. Your funds stay safe in your account. Start a new deposit.",
      };
    }
    if (!op) {
      // FRESH deposit: refuse when the target vault already has an active or
      // unresolved loop — BEFORE any money moves, so nothing gets stranded.
      const existing = await storage.getBorrowPositions(walletAddress, null, "loop");
      const active = existing.find(
        (r) => (r.status === "open" || r.status === "pending") && String(r.venueVaultId) === String(vaultId),
      );
      if (active) {
        return {
          success: false,
          error:
            active.status === "open"
              ? `You already have an open ${asset.symbol} loop. Close it before depositing more.`
              : "A previous loop attempt is still unresolved. It must be reconciled before a new deposit.",
        };
      }
      try {
        op = await storage.createBorrowOperation({
          walletAddress,
          operationType: "loop_lst_deposit",
          status: "pending",
          step: "initialized",
          clientRequestId: params.clientRequestId,
          metadata: {
            kind: "loop",
            mint,
            symbol: asset.symbol,
            requestedAmountRaw: params.amountRaw,
            vaultId,
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

    let realizedLamports: bigint | null = null;
    let swapSignature: string | undefined = typeof meta.swapSignature === "string" ? meta.swapSignature : undefined;
    try {
      if (typeof meta.realizedLamports === "string") realizedLamports = BigInt(meta.realizedLamports);
    } catch {
      realizedLamports = null;
    }

    try {
      // --- Resume an ambiguous swap by ON-CHAIN STATUS (never balance-only) ---
      if (realizedLamports === null && op.step === "swap_sent" && swapSignature) {
        const statuses = await connection.getSignatureStatuses([swapSignature], { searchTransactionHistory: true });
        const st = statuses.value[0];
        const landedOk = !!st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized");
        if (landedOk) {
          // The swap landed: realized = strict SOL now minus the write-ahead
          // baseline. Both reads are strict (throw → fail closed, retryable).
          const beforeRaw = BigInt(String(meta.solBeforeLamports ?? ""));
          const nowRaw = BigInt((await getAgentTokenBalanceRawStrict(agentPublicKey, NATIVE_SOL_MINT)).amountRaw);
          const delta = nowRaw - beforeRaw;
          if (delta <= 0n) {
            return {
              success: false,
              resumable: true,
              swapSignature,
              error:
                "The conversion landed on-chain but the credited SOL could not be measured yet. Wait a minute and retry.",
            };
          }
          realizedLamports = delta;
          await storage.updateBorrowOperation(opId, {
            step: "swapped",
            mergeMetadata: { realizedLamports: realizedLamports.toString() },
          });
        } else if (st && st.err) {
          // Failed on-chain: the LST never left the wallet. Clear the
          // breadcrumb and fall through to a fresh swap in this same call.
          await storage.updateBorrowOperation(opId, {
            step: "initialized",
            mergeMetadata: { swapSignature: null, solBeforeLamports: null },
          });
          swapSignature = undefined;
        } else {
          // Not found: only safe to re-swap once the recorded blockhash window
          // is provably over (the tx can never land afterwards). 0 = no hint.
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
            mergeMetadata: { swapSignature: null, solBeforeLamports: null },
          });
          swapSignature = undefined;
        }
      }

      // --- Swap LST → SOL (skipped entirely when already 'swapped') ---
      if (realizedLamports === null) {
        const bal = await getAgentTokenBalanceRawStrict(agentPublicKey, mint); // throws → fail closed
        let toSwap = BigInt(bal.amountRaw);
        let requested = 0n;
        try {
          requested = BigInt(String(meta.requestedAmountRaw ?? params.amountRaw));
        } catch {
          requested = 0n;
        }
        if (requested > 0n && requested < toSwap) toSwap = requested;
        if (toSwap <= 0n) {
          await failOp(opId, "no_tokens", `No ${asset.symbol} found in the deposit wallet to convert.`);
          return {
            success: false,
            error: `No ${asset.symbol} arrived in the deposit wallet. If your transfer just confirmed, wait a few seconds and start a new deposit.`,
          };
        }

        // Write-ahead baseline BEFORE any broadcast: the ambiguous-swap
        // reconcile above depends on this exact pre-swap lamport reading.
        const solBefore = BigInt((await getAgentTokenBalanceRawStrict(agentPublicKey, NATIVE_SOL_MINT)).amountRaw);
        await storage.updateBorrowOperation(opId, {
          mergeMetadata: { swapAmountRaw: toSwap.toString(), solBeforeLamports: solBefore.toString() },
        });

        const swap = await executeAgentSwap({
          agentPublicKey,
          agentSecretKey,
          inputMint: mint,
          outputMint: NATIVE_SOL_MINT,
          amountRaw: toSwap.toString(),
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
            // Broadcast happened but the outcome is unknown/failed — leave the
            // 'swap_sent' breadcrumb; the resume block above reconciles it.
            return {
              success: false,
              resumable: true,
              swapSignature: swap.signature,
              error: `${swap.error || "Conversion did not complete."} Your deposit is safe. Retry to reconcile.`,
            };
          }
          // Nothing broadcast: the LST is untouched. Fully retryable.
          await storage.updateBorrowOperation(opId, {
            step: "initialized",
            mergeMetadata: { swapSignature: null, solBeforeLamports: null },
          });
          return {
            success: false,
            resumable: true,
            error: `${swap.error || "Conversion failed."} Your deposit is safe in the internal wallet. Retry in a moment.`,
          };
        }

        realizedLamports = BigInt(swap.outputReceivedRaw!);
        swapSignature = swap.signature;
        await storage.updateBorrowOperation(opId, {
          step: "swapped",
          mergeMetadata: { realizedLamports: realizedLamports.toString() },
        });

        // Audit trail (best-effort): the deposit credited as realized SOL.
        // Distinct 'loop_deposit' type so the history feed labels it as a
        // vault deposit (NOT "SOL Deposit (Gas)"). It is EXTERNAL capital
        // arriving, so it deliberately stays OUT of VAULT_INTERNAL_EVENT_TYPES.
        try {
          const lstUi = (Number(toSwap) / 10 ** asset.decimals)
            .toFixed(Math.min(asset.decimals, 6))
            .replace(/(\.\d*?)0+$/, "$1")
            .replace(/\.$/, "");
          await storage.createEquityEvent({
            walletAddress,
            eventType: "loop_deposit",
            amount: lamportsToSol(realizedLamports),
            assetType: "SOL",
            txSignature: swapSignature ?? null,
            notes: `Deposited ${lstUi} ${asset.symbol}, converted to SOL for the loop`,
          });
        } catch (e) {
          console.warn("[loop-executor] lst-deposit equity event failed (non-fatal):", e);
        }
      }

      // --- Size the principal so the open consumes ONLY the swapped SOL ---
      // Preflight with principal=realized to learn the exact overhead bar
      // (NFT mint rent + missing ATA rents + fee headroom); the true principal
      // is realized minus that overhead.
      const pf = await executeLoopOpen({
        walletAddress,
        agentPublicKey,
        agentSecretKey,
        vaultId,
        principalLamports: realizedLamports,
        slippageBps,
        preflightOnly: true,
        callerHoldsBorrowLock: true, // we hold this exact lock — re-acquiring deadlocks
      });
      if (!pf.success || !pf.preflight) {
        return {
          success: false,
          resumable: true,
          swappedLamports: realizedLamports.toString(),
          swapSignature,
          error: pf.error || "Could not size the loop open. Your converted SOL is safe. Retry in a moment.",
        };
      }
      const overhead = BigInt(Math.max(0, Math.round(pf.preflight.requiredLamports))) - realizedLamports;
      const principal = realizedLamports - (overhead > 0n ? overhead : 0n);
      if (principal <= 0n) {
        return {
          success: false,
          resumable: true,
          swappedLamports: realizedLamports.toString(),
          swapSignature,
          error: `The converted SOL (${lamportsToSol(realizedLamports)} SOL) is too small to cover account rent and fees. It stays safe in the internal wallet.`,
        };
      }

      // --- Open (its own op row + policy gates + verification) ---
      const attempt = Number(meta.openAttempts ?? 0) + 1;
      await storage.updateBorrowOperation(opId, { mergeMetadata: { openAttempts: attempt } });
      const openResult = await executeLoopOpen({
        walletAddress,
        agentPublicKey,
        agentSecretKey,
        vaultId,
        principalLamports: principal,
        slippageBps,
        clientRequestId: `${params.clientRequestId}:open:${attempt}`,
        callerHoldsBorrowLock: true, // we hold this exact lock — re-acquiring deadlocks
      });

      if (!openResult.success) {
        // The SOL is intact in the agent wallet; the op stays at 'swapped'.
        return {
          success: false,
          resumable: true,
          swappedLamports: realizedLamports.toString(),
          swapSignature,
          open: openResult,
          error: `${openResult.error || "Loop open failed."} Your converted SOL is safe. Retry to finish.`,
        };
      }

      await storage.updateBorrowOperation(opId, {
        status: "succeeded",
        step: "opened",
        result: {
          swapSignature: swapSignature ?? null,
          realizedLamports: realizedLamports.toString(),
          principalLamports: principal.toString(),
          borrowPositionId: openResult.borrowPositionId ?? null,
          openSignature: openResult.signature ?? null,
        },
      });

      return {
        success: true,
        swappedLamports: realizedLamports.toString(),
        swapSignature,
        open: openResult,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // NEVER terminal-fail after money may have moved: the op keeps its step
      // breadcrumb so a retry resumes instead of re-swapping.
      console.error(`[loop-executor] lst-deposit-open op ${opId} threw:`, e);
      return {
        success: false,
        resumable: true,
        ...(realizedLamports !== null ? { swappedLamports: realizedLamports.toString() } : {}),
        ...(swapSignature ? { swapSignature } : {}),
        error: `Deposit conversion hit an error: ${msg}. Your funds are safe. Retry with the same request.`,
      };
    }
  });
}

// --- CLOSE (full unwind) ---------------------------------------------------------

export interface LoopCloseParams {
  walletAddress: string;
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  borrowPositionId: string;
  slippageBps?: number;
  clientRequestId?: string;
}

export interface LoopCloseResult {
  success: boolean;
  signature?: string;
  /** Realized SOL returned to the agent wallet, raw lamports. */
  solReturnedLamports?: string;
  /** True when the position was already in the target state on-chain — state stamped WITHOUT a transaction (no signature by design). */
  selfHeal?: boolean;
  verifyWarning?: string;
  error?: string;
  gasShortfall?: LoopGasShortfall;
}

export async function executeLoopClose(params: LoopCloseParams): Promise<LoopCloseResult> {
  const { walletAddress, agentPublicKey, agentSecretKey, borrowPositionId } = params;
  const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

  const loadedRes = await loadOpenLoopPosition(walletAddress, borrowPositionId);
  if (!loadedRes.ok) return { success: false, error: loadedRes.error };
  const { vaultId } = loadedRes.loaded;

  const borrowRoute = new JupiterLendBorrowRoute();
  const cfg = await borrowRoute.getLoopVaultConfig(vaultId);
  if (!cfg) return { success: false, error: `Could not read loop vault ${vaultId} config — refusing (fail closed).` };

  return await withBorrowLock(borrowLockKey(walletAddress, null, vaultId), async () => {
    // Re-load under the lock — status may have changed while we waited.
    const relock = await loadOpenLoopPosition(walletAddress, borrowPositionId);
    if (!relock.ok) return { success: false, error: relock.error };
    const { pos, nftId } = relock.loaded;

    const connection = getServerConnection();
    const agentPubkey = new PublicKey(agentPublicKey);
    const wsolMintPk = new PublicKey(WSOL_MINT);
    const lstMintPk = new PublicKey(cfg.collateralMint);

    // LIVE read is the sizing authority (collateral accrues; recorded amounts stale).
    const live = await borrowRoute.readLoopLivePositionHealth(vaultId, nftId);
    if (!live) return { success: false, error: "Loop Close: could not read the live position — refusing (fail closed). Retry shortly." };
    const liveDebt = BigInt(live.debtRaw);
    const liveCol = BigInt(live.collateralRaw);

    // Self-heal: already flat on-chain (a prior close landed but we crashed
    // before recording it) — mark closed without a transaction.
    if (liveDebt <= DEFAULT_SOL_DEBT_DUST_RAW && liveCol <= DEFAULT_LST_COLLATERAL_DUST_RAW) {
      const snapshot = buildLoopHealthSnapshot(cfg, liveCol, liveDebt, live.oraclePriceUsd, "loop_close_selfheal");
      await storage.updateBorrowPosition(
        pos.id,
        {
          status: "closed",
          collateralAmountRaw: liveCol.toString(),
          debtAmountRaw: liveDebt.toString(),
          healthSnapshot: snapshot,
          healthAsOf: new Date(),
          healthSource: "loop_close_selfheal",
          policyState: null,
          policyReason: "loop_close",
          policyStateChangedAt: new Date(),
        },
        "open",
      );
      try {
        await storage.createBorrowOperation({
          walletAddress,
          borrowPositionId: pos.id,
          operationType: "loop_close",
          status: "succeeded",
          step: "already_closed_onchain",
          clientRequestId: params.clientRequestId ?? null,
          metadata: { kind: "loop", vaultId, nftId, selfHeal: true },
        });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
      }
      return { success: true, selfHeal: true, verifyWarning: "Position was already flat on-chain — marked closed without a transaction." };
    }
    if (liveCol <= 0n) {
      return { success: false, error: "Loop Close: position shows debt without collateral — refusing automated close. Contact support." };
    }

    // A ZERO-DEBT position (the P3 HOLD state) exits with a plain withdraw-all:
    // nothing is owed, so there is nothing to flash-repay.
    const isHoldExit = liveDebt <= 0n;
    // Flash 2% over live debt; repay MAX takes only what is owed, surplus rides back.
    const flashRepay = isHoldExit ? 0n : (liveDebt * CLOSE_FLASH_BUFFER_NUM) / CLOSE_FLASH_BUFFER_DEN;

    let opId: string;
    try {
      const op = await storage.createBorrowOperation({
        walletAddress,
        borrowPositionId: pos.id,
        operationType: "loop_close",
        status: "pending",
        step: "initialized",
        clientRequestId: params.clientRequestId ?? null,
        metadata: {
          kind: "loop",
          vaultId,
          nftId,
          slippageBps,
          liveDebtRaw: liveDebt.toString(),
          liveCollateralRaw: liveCol.toString(),
          flashRepayRaw: flashRepay.toString(),
          ...(isHoldExit ? { holdExit: true } : {}),
        },
      });
      opId = op.id;
    } catch (e) {
      if (isUniqueViolation(e)) {
        return { success: false, error: "This loop close was already submitted. Check its status before retrying." };
      }
      throw e;
    }

    try {
      // ATAs must exist (WSOL ATA is closed at the end of every unwind tx).
      const wsolAta = ataFor(agentPubkey, wsolMintPk);
      const lstAta = ataFor(agentPubkey, lstMintPk);
      const infos = await connection.getMultipleAccountsInfo([wsolAta, lstAta]);
      const prepIxs: TransactionInstruction[] = [];
      if (!infos[0]) prepIxs.push(ixCreateAtaIdempotent(agentPubkey, agentPubkey, wsolMintPk));
      if (!infos[1]) prepIxs.push(ixCreateAtaIdempotent(agentPubkey, agentPubkey, lstMintPk));

      const gas = await ensureVaultGas({
        payingPublicKey: agentPublicKey,
        funderPublicKey: agentPublicKey,
        funderSecretKey: agentSecretKey,
        destMint: null,
        label: "Loop Close",
        extraRentLamports: prepIxs.length * ATA_RENT_LAMPORTS + LOOP_FEE_HEADROOM_LAMPORTS,
      });
      if (!gas.ok) {
        await failOp(opId, "gas_failed", gas.error || "insufficient SOL for fees");
        return {
          success: false,
          error: gas.error || "Loop Close: insufficient SOL for fees.",
          gasShortfall: {
            requiredLamports: gas.requiredLamports,
            heldLamports: gas.payerLamportsBefore + (gas.refilledLamports ?? 0) + (gas.fundedLamports ?? 0),
          },
        };
      }

      if (prepIxs.length > 0) {
        const prep = await executeAgentInstructionsConfirmOnly({
          agentPublicKey,
          agentSecretKey,
          instructions: [...cuIxs(PREP_CU_LIMIT), ...prepIxs],
          label: "Loop Close ATA prep",
        });
        if (!prep.success) {
          await failOp(opId, "ata_prep_failed", prep.error || "ATA prep tx did not confirm.");
          return { success: false, error: prep.error || "Loop Close: token account prep failed. Nothing was moved." };
        }
        await storage.updateBorrowOperation(opId, {
          step: "atas_prepared",
          ...(prep.signature ? { appendTxSignature: prep.signature } : {}),
        });
      } else {
        await storage.updateBorrowOperation(opId, { step: "atas_prepared" });
      }

      // Swap the withdrawn LST back to WSOL; proceeds must cover the flash payback.
      const quote = await jupQuote(cfg.collateralMint, WSOL_MINT, liveCol, slippageBps);
      const minOut = BigInt(quote.otherAmountThreshold);
      if (!isHoldExit && minOut <= liveDebt) {
        await failOp(opId, "swap_would_not_cover_payback", `minOut ${minOut} <= live debt ${liveDebt}`);
        return {
          success: false,
          error: "Loop Close: the swap's worst-case output would not cover the debt repayment (slippage/depeg). Nothing was moved — retry with market calm or higher slippage.",
        };
      }

      // WO2A: persist THIS close's conservative attribution floor BEFORE any
      // broadcast. If the tx later lands but its exact output goes unmeasured
      // (crash window / ambiguous-but-cleared), recovery sizes the re-loop from
      // this floor — the close's OWN worst case (minOut − flashRepay − fee
      // headroom) — never from a whole-wallet balance delta, which would
      // attribute out-of-band credits/debits to the hop. Both writes are
      // return-checked: no durable floor ⇒ no broadcast.
      const attributableFloor = computeCloseAttributableFloor(minOut, flashRepay);
      if (attributableFloor <= 0n) {
        await failOp(opId, "attributable_floor_nonpositive", `minOut ${minOut} - flashRepay ${flashRepay} - headroom ${LOOP_FEE_HEADROOM_LAMPORTS} <= 0`);
        return {
          success: false,
          error: "Loop Close: the swap's worst-case output leaves no attributable margin over the debt repayment. Nothing was moved — retry with market calm or lower slippage.",
        };
      }
      const floorPersisted = await storage.updateBorrowOperation(opId, {
        mergeMetadata: {
          closeMinOutRaw: minOut.toString(),
          closeFlashRepayRaw: flashRepay.toString(),
          attributableFloorRaw: attributableFloor.toString(),
        },
      });
      if (!floorPersisted) {
        await failOp(opId, "floor_persist_failed", "attribution-floor write did not persist — refusing to broadcast");
        return {
          success: false,
          error: "Loop Close: could not durably record the attribution floor. Nothing was moved — retry.",
        };
      }

      const swapResp = await jupSwapIxs(quote, agentPublicKey);
      if ((swapResp.setupInstructions || []).length > 0) {
        await failOp(opId, "swap_setup_ixs", `Swap returned ${swapResp.setupInstructions.length} setup ix(s).`);
        return { success: false, error: "Loop Close: swap route needs extra account setup — aborted. Retry shortly." };
      }
      if (!swapResp.swapInstruction) {
        await failOp(opId, "swap_ix_missing", "Swap response carried no swapInstruction.");
        return { success: false, error: "Loop Close: swap instructions unavailable. Nothing was moved." };
      }

      const borrowMod = await import("@jup-ag/lend/borrow");
      const BN = (await import("bn.js")).default;
      // HOLD exit skips the flash loan entirely — the withdraw needs no repay funding.
      let flashLegs: { borrowIx: TransactionInstruction; paybackIx: TransactionInstruction } | null = null;
      if (!isHoldExit) {
        const flash = await import("@jup-ag/lend/flashloan");
        flashLegs = await flash.getFlashloanIx({
          amount: new BN(flashRepay.toString()),
          asset: wsolMintPk,
          signer: agentPubkey,
          connection,
        });
      }
      const plan = isHoldExit ? planLoopHoldExit(nftId) : planLoopClose(nftId);
      const operate = await borrowMod.getOperateIx({
        vaultId,
        positionId: plan.positionId,
        colAmount: specToBN(BN, plan.colAmount, "col", borrowMod.MAX_WITHDRAW_AMOUNT, borrowMod.MAX_REPAY_AMOUNT),
        debtAmount: specToBN(BN, plan.debtAmount, "debt", borrowMod.MAX_WITHDRAW_AMOUNT, borrowMod.MAX_REPAY_AMOUNT),
        connection,
        signer: agentPubkey,
      });

      const instructions: TransactionInstruction[] = [
        ...cuIxs(LOOP_CU_LIMIT),
        ...(flashLegs ? [flashLegs.borrowIx] : []),
        ...operate.ixs,
        deserializeJupIx(swapResp.swapInstruction),
        ...(flashLegs ? [flashLegs.paybackIx] : []),
        ixCloseAccount(wsolAta, agentPubkey, agentPubkey), // unwrap leftovers to native SOL
      ];
      const alts = [
        ...(await loadAlts(connection, swapResp.addressLookupTableAddresses || [])),
        ...(operate.addressLookupTableAccounts || []),
      ];

      // Realized native-SOL delta is the credited-funds source of truth.
      const exec = await executeAgentInstructions({
        agentPublicKey,
        agentSecretKey,
        instructions,
        verifyOutputMint: NATIVE_SOL_MINT,
        addressLookupTables: alts,
        label: "Loop Close",
        onBeforeBroadcast: async (info) => {
          const updated = await storage.updateBorrowOperation(opId, {
            step: "loop_sig_writeahead",
            appendTxSignature: info.signature,
            mergeMetadata: {
              blockhash: info.blockhash,
              lastValidBlockHeight: info.lastValidBlockHeight,
              // Explicit identity for the hop-close provenance check: lets the
              // resume path verify this specific tx without confusing an
              // ATA-prep sig (which is appended first) with the close tx.
              closeTxSignature: info.signature,
            },
          });
          if (!updated) throw new Error("write-ahead signature persist failed — refusing to broadcast");
        },
      });

      if (exec.onChainFailed || (!exec.success && !exec.signature)) {
        await failOp(opId, exec.onChainFailed ? "tx_failed_onchain" : "exec_failed", exec.error || "Loop close tx failed.");
        return { success: false, signature: exec.signature, error: exec.error || "Loop Close failed — the position is unchanged." };
      }

      if (exec.success) {
        const solDelta = BigInt(exec.outputReceivedRaw || "0");
        const post = await borrowRoute.readLoopLivePositionHealth(vaultId, nftId).catch(() => null);
        if (post) {
          const postDebt = BigInt(post.debtRaw);
          const postCol = BigInt(post.collateralRaw);
          const verify = verifyLoopCloseOutcome({
            observedDebtRaw: postDebt,
            observedColRaw: postCol,
            solDeltaLamports: solDelta,
          });
          if (!verify.ok) {
            // Fail closed: do NOT mark closed. Persist the on-chain truth.
            const snapshot = buildLoopHealthSnapshot(cfg, postCol, postDebt, post.oraclePriceUsd, "loop_close_verify_failed");
            await storage.updateBorrowPosition(pos.id, {
              collateralAmountRaw: postCol.toString(),
              debtAmountRaw: postDebt.toString(),
              healthSnapshot: snapshot,
              healthAsOf: new Date(),
              healthSource: "loop_close_verify_failed",
            });
            await failOp(opId, "close_verify_failed", `verify: ${verify.reason}; solDelta=${solDelta}`);
            return {
              success: false,
              signature: exec.signature,
              solReturnedLamports: solDelta.toString(),
              error: `Loop Close transaction landed but verification failed (${verify.reason}). The position stays open — check it before retrying.`,
            };
          }
          const snapshot = buildLoopHealthSnapshot(cfg, postCol, postDebt, post.oraclePriceUsd, "loop_close_onchain");
          await storage.updateBorrowPosition(
            pos.id,
            {
              status: "closed",
              collateralAmountRaw: postCol.toString(),
              debtAmountRaw: postDebt.toString(),
              healthSnapshot: snapshot,
              healthAsOf: new Date(),
              healthSource: "loop_close_onchain",
              policyState: null,
              policyReason: "loop_close",
              policyStateChangedAt: new Date(),
            },
            "open",
          );
          await storage.updateBorrowOperation(opId, {
            status: "succeeded",
            step: "final_read",
            result: { signature: exec.signature, solReturnedLamports: solDelta.toString() },
          });
          await recordLoopEquityEvent({
            walletAddress,
            eventType: "loop_close",
            amountLamports: solDelta,
            txSignature: exec.signature ?? null,
            notes: `Closed ${cfg.collateralSymbol} loop: ${lamportsToSol(solDelta)} SOL returned`,
          });
          return { success: true, signature: exec.signature, solReturnedLamports: solDelta.toString() };
        }

        // Atomic tx confirmed (repay MAX + withdraw MAX are IN it) but the
        // post-read failed: the position IS flat by construction — mark closed
        // with an explicit unverified source.
        await storage.updateBorrowPosition(
          pos.id,
          {
            status: "closed",
            collateralAmountRaw: "0",
            debtAmountRaw: "0",
            healthAsOf: new Date(),
            healthSource: "loop_close_unverified",
            policyState: null,
            policyReason: "loop_close",
            policyStateChangedAt: new Date(),
          },
          "open",
        );
        await storage.updateBorrowOperation(opId, {
          status: "succeeded",
          step: "close_unverified",
          result: { signature: exec.signature, solReturnedLamports: solDelta.toString(), unverified: true },
        });
        await recordLoopEquityEvent({
          walletAddress,
          eventType: "loop_close",
          amountLamports: solDelta,
          txSignature: exec.signature ?? null,
          notes: `Closed ${cfg.collateralSymbol} loop: ${lamportsToSol(solDelta)} SOL returned`,
        });
        return {
          success: true,
          signature: exec.signature,
          solReturnedLamports: solDelta.toString(),
          verifyWarning: "Close confirmed but the final position read failed — marked closed (atomic tx repaid MAX + withdrew MAX).",
        };
      }

      // AMBIGUOUS (sig, not onChainFailed, delta unverified): probe live state.
      const probe = await borrowRoute.readLoopLivePositionHealth(vaultId, nftId).catch(() => null);
      if (probe && BigInt(probe.debtRaw) <= DEFAULT_SOL_DEBT_DUST_RAW && BigInt(probe.collateralRaw) <= DEFAULT_LST_COLLATERAL_DUST_RAW) {
        // The close landed (position flat) — SOL went to the wallet atomically,
        // we just could not measure the delta. No equity event (unknown amount).
        const snapshot = buildLoopHealthSnapshot(cfg, BigInt(probe.collateralRaw), BigInt(probe.debtRaw), probe.oraclePriceUsd, "loop_close_ambiguous_cleared");
        await storage.updateBorrowPosition(
          pos.id,
          {
            status: "closed",
            collateralAmountRaw: probe.collateralRaw,
            debtAmountRaw: probe.debtRaw,
            healthSnapshot: snapshot,
            healthAsOf: new Date(),
            healthSource: "loop_close_ambiguous_cleared",
            policyState: null,
            policyReason: "loop_close",
            policyStateChangedAt: new Date(),
          },
          "open",
        );
        await storage.updateBorrowOperation(opId, {
          status: "succeeded",
          step: "close_ambiguous_but_cleared",
          result: { signature: exec.signature, solDeltaUnknown: true },
        });
        return {
          success: true,
          signature: exec.signature,
          verifyWarning: "Close landed (position is flat on-chain) but the returned SOL amount could not be measured.",
        };
      }
      if (probe) {
        // Still carrying debt — the tx did not land (or landed and failed). Unchanged.
        await failOp(opId, "close_ambiguous_not_landed", `sig ${exec.signature} unconfirmed; live position still open.`);
        return { success: false, signature: exec.signature, error: "Loop Close could not be confirmed and the position is still open on-chain. Retry." };
      }
      // Unreadable: fail closed — keep the position open; a retry self-heals via
      // the already-flat check if the tx actually landed.
      await failOp(opId, "close_ambiguous_unreadable", `sig ${exec.signature} unconfirmed; live read unreadable.`);
      return {
        success: false,
        signature: exec.signature,
        error: "Loop Close result is unknown (confirmation and position read both failed). The position stays open — retry shortly; an already-landed close is detected automatically.",
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await failOp(opId, "unexpected_error", msg);
      return { success: false, error: `Loop Close failed: ${msg}` };
    }
  });
}

// --- HOP (P4: fully unwind one pair, re-loop onto a better allowlisted pair) ------

// -- Hop-close provenance helpers (exported for unit tests) ----------------------

/**
 * Resolve the specific Loop Close transaction signature from a close-attempt
 * operation record. Returns null when the record is malformed or the step
 * carries no provable close identity.
 *
 * Selector ordering (WO2A-C2 — identity evidence BEFORE any lifecycle-step
 * restriction):
 *  1. meta.closeTxSignature PRESENT — written atomically by the write-ahead
 *     hook; metadata merges survive every later step overwrite (failOp
 *     ambiguous overwrites, unexpected_error, any future step). The identity
 *     is therefore step-INDEPENDENT: accepted at ANY current step, but ONLY
 *     as a non-empty string exactly equal to the FINAL raw txSignatures
 *     entry. A malformed or mismatched explicit identity returns null
 *     IMMEDIATELY and NEVER falls back to any array entry (an inconsistent
 *     record proves nothing).
 *  2. meta.closeTxSignature genuinely ABSENT — legacy record predating the
 *     explicit field. The last-entry ordering invariant (the ATA-prep
 *     signature, if any, is appended BEFORE the write-ahead hook fires, so
 *     the close sig is always last) is trustworthy ONLY inside the crash
 *     window itself: valid ONLY at "loop_sig_writeahead" with a non-empty
 *     final raw entry. Keyless records at ANY other step → null (pre-
 *     broadcast records may carry ONLY an ATA-prep signature; promoting it
 *     is the exact bug class this selector prevents).
 *
 * The former C1 two-step ambiguous allowlist is REMOVED: ambiguous records
 * flow through the general explicit-key rule above (a keyless ambiguous
 * record is corrupt, not legacy — it still fails closed via rule 2).
 *
 * Fail closed: any record where neither source yields a non-empty string
 * returns null; callers must not treat the attempt as proven.
 *
 * @internal exported for unit tests only — not a public API surface.
 */
export function pickCloseTxSig(co: {
  step: string | null;
  txSignatures: unknown[] | null;
  metadata: Record<string, unknown> | null | undefined;
}): string | null {
  // WO2A-C2: inspect the record's identity evidence (final RAW txSignatures
  // entry + explicit meta-key presence) BEFORE any lifecycle-step restriction.

  // Identify the final RAW entry of the txSignatures array — do NOT filter
  // through to an earlier element when the trailing entry is malformed.
  // A non-string or empty trailing entry means the record itself is malformed;
  // quietly skipping it could silently promote an earlier ATA-prep signature
  // into the close-sig position, re-introducing the exact bug this fix closes.
  const arr = Array.isArray(co.txSignatures) ? co.txSignatures : [];
  const rawLast = arr.length > 0 ? arr[arr.length - 1] : undefined;
  const lastSig = typeof rawLast === "string" && rawLast.length > 0 ? rawLast : null;

  const meta = (co.metadata ?? {}) as Record<string, unknown>;
  const hasExplicit = Object.prototype.hasOwnProperty.call(meta, "closeTxSignature");

  if (hasExplicit) {
    // Explicit identity: step-INDEPENDENT (the write-ahead hook wrote it
    // atomically with the final array entry; metadata merges survive every
    // later step overwrite, so it outlives failOp's unexpected_error and
    // ambiguous overwrites alike). Accept ONLY a non-empty string that
    // matches the final RAW array entry exactly. Any deviation is an
    // inconsistent record — fail closed IMMEDIATELY, without querying or
    // proving any transaction and WITHOUT ever falling back to an array
    // entry:
    //   • empty / non-string explicit  → the identity itself is malformed.
    //   • lastSig is null              → trailing entry is malformed; cannot cross-check.
    //   • explicit !== lastSig         → identity and array disagree; fail closed.
    const explicit = meta.closeTxSignature;
    if (typeof explicit !== "string" || explicit.length === 0) return null;
    if (lastSig === null) return null;
    if (explicit !== lastSig) return null;
    return explicit;
  }

  // Legacy fallback: the explicit identity key is genuinely absent. The
  // last-entry ordering invariant is trustworthy ONLY inside the crash
  // window itself — every other keyless step fails closed. (WO2A-C2 removed
  // the C1 two-ambiguous-step allowlist: ambiguous records prove identity
  // via the explicit key or not at all.)
  if (co.step !== "loop_sig_writeahead") return null;
  // Ordering invariant: the close write-ahead sig is always the FINAL entry in
  // txSignatures (any ATA-prep sig is appended before the write-ahead hook fires).
  // If the trailing entry is not a valid non-empty string, the record is malformed.
  return lastSig;
}

/**
 * Verify whether the main Loop Close transaction for a crash-window close-
 * attempt op actually landed on-chain, without risk of confusing an earlier
 * ATA-prep transaction with the close tx.
 *
 * Returns (WO2A-C1 verdict table — uncertainty is NEVER a landing verdict):
 *  "landed"       — confirmed/finalized with no error.
 *  "not_landed"   — the tx landed WITH an on-chain error: atomic tx ⇒ the
 *                   close provably did not move money.
 *  "malformed"    — cannot identify the close sig; callers must fail closed.
 *  "unverifiable" — null status (index lag can hide a landed tx even with
 *                   searchTransactionHistory), a nonterminal status
 *                   ("processed" or unknown), or an RPC failure. Callers must
 *                   stay resumable: never authorize the floor from it, never
 *                   terminalize the parent as closed_outside_hop from it.
 *
 * @internal exported for unit tests only — not a public API surface.
 */
export async function verifyCloseTxLanded(
  co: {
    step: string | null;
    txSignatures: unknown[] | null;
    metadata: Record<string, unknown> | null | undefined;
  },
  connection: Pick<Connection, "getSignatureStatuses">,
): Promise<"landed" | "not_landed" | "malformed" | "unverifiable"> {
  const closeTxSig = pickCloseTxSig(co);
  if (!closeTxSig) return "malformed";
  try {
    const result = await connection.getSignatureStatuses([closeTxSig], { searchTransactionHistory: true });
    const st = result.value[0];
    if (st == null) return "unverifiable";
    if (st.err) return "not_landed";
    if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return "landed";
    return "unverifiable"; // "processed" / other nonterminal — not yet a verdict either way
  } catch {
    return "unverifiable";
  }
}

// -- WO2A hop-recovery helpers (exported for unit tests) --------------------------

/**
 * Conservative attribution floor for a close leg, computed from ITS OWN quote:
 * worst-case swap output (minOut) minus the flash repayment minus fee headroom.
 * This is the least SOL the close can return to the agent wallet if its tx
 * lands, so a figureless recovery may size the re-loop from it without ever
 * consulting wallet balances. Clamped at 0 — callers must treat a nonpositive
 * floor as un-broadcastable (fail closed pre-broadcast).
 *
 * @internal exported for unit tests only — not a public API surface.
 */
export function computeCloseAttributableFloor(minOutRaw: bigint, flashRepayRaw: bigint): bigint {
  const floor = minOutRaw - flashRepayRaw - BigInt(LOOP_FEE_HEADROOM_LAMPORTS);
  return floor > 0n ? floor : 0n;
}

/**
 * Verify a RAW signature string landed (confirmed/finalized, no error).
 * Unlike verifyCloseTxLanded this takes the signature directly — needed when
 * the close attempt is still in memory (direct path) or when a SUCCEEDED close
 * op recorded its sig in result/metadata (the succeeded branch trusts its own
 * recorded sig without the selector's final-entry cross-check).
 *
 * WO2A-C1 verdict table (uncertainty is NEVER a landing verdict):
 *  "landed"       — confirmed/finalized with no error.
 *  "not_landed"   — the tx landed WITH an on-chain error (atomic ⇒ nothing
 *                   moved), or the input carries no signature at all.
 *  "unverifiable" — null status (index lag can hide a landed tx even with
 *                   searchTransactionHistory), a nonterminal status
 *                   ("processed" or unknown), or an RPC failure. Callers must
 *                   stay resumable — never book success, never authorize a
 *                   floor, never terminalize from it.
 *
 * @internal exported for unit tests only — not a public API surface.
 */
export async function verifyRawSigLanded(
  signature: string | null | undefined,
  connection: Pick<Connection, "getSignatureStatuses">,
): Promise<"landed" | "not_landed" | "unverifiable"> {
  if (typeof signature !== "string" || signature.length === 0) return "not_landed";
  try {
    const res = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const st = res.value[0];
    if (st == null) return "unverifiable";
    if (st.err) return "not_landed";
    if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return "landed";
    return "unverifiable"; // "processed" / other nonterminal — not yet a verdict either way
  } catch {
    return "unverifiable";
  }
}

/**
 * WO2A broadcast-budget basis: count numbered open children that carry durable
 * MAIN-OPEN write-ahead evidence (loopOpenWriteaheadRecorded — metadata merges
 * survive later step overwrites, so a failed child that once broadcast still
 * counts). Children that provably never broadcast (row absent, preflight-
 * declined, policy-denied pre-broadcast) consume no budget.
 *
 * @internal exported for unit tests only — not a public API surface.
 */
export async function countHopBroadcastAttempts(
  walletAddress: string,
  parentClientRequestId: string,
  openAttempts: number,
): Promise<number> {
  let count = 0;
  for (let n = 1; n <= openAttempts; n++) {
    const child = await storage.getBorrowOperationByClientRequestId(walletAddress, `${parentClientRequestId}:open:${n}`);
    if (child && child.operationType === "loop_open" && loopOpenWriteaheadRecorded(child)) count++;
  }
  return count;
}

/** Outcome of scanning a hop's own close children for attribution proof (WO2A). */
export type OlderCloseRecovery =
  | {
      kind: "recovered";
      raw: bigint;
      source: HopSolReturnedSource;
      signature: string | null;
      /** The proven close child — its updatedAt anchors closeDoneAt on a resume. */
      provenOp: BorrowOperation;
    }
  /** An own close PROVABLY landed but carries no exact figure and no floor (legacy/corrupt record) — resumable, never terminal, never sized. */
  | { kind: "proven_unattributable"; provenOp: BorrowOperation }
  /** RPC could not verify at least one candidate — resumable, retry later. */
  | { kind: "unverifiable" }
  /** No own close attempt proves this hop moved money. */
  | { kind: "none" };

/**
 * WO2A: walk this hop's OWN numbered close children (newest → oldest) for
 * close-output attribution proof. Rules:
 *  - SUCCEEDED child with the selfHeal marker → SKIP: it was stamped WITHOUT a
 *    transaction (position found already flat), so it is never proof that THIS
 *    hop's close moved money.
 *  - SUCCEEDED child with an exact result figure → exact. A malformed exact is
 *    proven_unattributable: it IS our close (success paths CAS-close the
 *    position first), but the record is corrupt — fail closed resumable rather
 *    than guessing or silently downgrading to the floor.
 *  - SUCCEEDED figureless child (ambiguous-but-cleared) → its own persisted
 *    floor, but ONLY once its recorded signed tx is verified LANDED (probe-flat
 *    alone can also mean "our tx expired AND someone closed it out-of-band").
 *    Not-landed → skip; landed with no floor → proven_unattributable.
 *  - NON-SUCCEEDED child → verifyCloseTxLanded; the selector decides which
 *    records still carry a provable close identity (WO2A-C2: a surviving
 *    explicit closeTxSignature matching the final raw entry proves identity
 *    at ANY step — unexpected_error and the failOp ambiguous overwrites
 *    included; keyless records only at crash-window loop_sig_writeahead).
 *    Landed → ONLY that child's own persisted floor (no exact was ever
 *    measured); landed with no floor → proven_unattributable;
 *    not_landed/malformed → keep scanning older. Records without a provable
 *    identity cost no RPC call.
 *  - Only loop_close children are inspected (WO2A-C1): a foreign op type under
 *    a close crid is corrupt linkage, never close proof.
 *  - Any unverifiable candidate (null status, nonterminal status, RPC failure)
 *    keeps the hop resumable — uncertainty never authorizes the floor and
 *    never lets the scan fall through to a closed_outside_hop terminal.
 * A position closes at most once, so the first proven child decides.
 *
 * @internal exported for unit tests only — not a public API surface.
 */
export async function recoverFromOlderProvenClose(
  walletAddress: string,
  closeCridFor: (n: number) => string,
  fromAttempt: number,
  connection: Pick<Connection, "getSignatureStatuses">,
): Promise<OlderCloseRecovery> {
  let sawUnverifiable = false;
  for (let n = fromAttempt; n >= 1; n--) {
    const co = await storage.getBorrowOperationByClientRequestId(walletAddress, closeCridFor(n));
    if (!co) continue;
    // WO2A-C1: only loop_close children can prove the unwind was ours. A
    // foreign op type under a close crid is corrupt linkage — skip it.
    if (co.operationType !== "loop_close") continue;
    const coMeta = (co.metadata ?? {}) as Record<string, any>;
    const r = (co.result ?? {}) as Record<string, any>;
    const floorRaw = typeof coMeta.attributableFloorRaw === "string" ? coMeta.attributableFloorRaw : null;

    if (co.status === "succeeded") {
      if (coMeta.selfHeal === true) continue;
      const exact = typeof r.solReturnedLamports === "string" && r.solReturnedLamports ? r.solReturnedLamports : null;
      if (exact) {
        const rec = recoverHopSolReturned({ exactCloseOutputRaw: exact });
        if (rec.ok) {
          const sig = typeof r.signature === "string" && r.signature ? r.signature : null;
          return { kind: "recovered", raw: rec.solReturnedRaw, source: rec.source, signature: sig, provenOp: co };
        }
        return { kind: "proven_unattributable", provenOp: co };
      }
      const sig =
        typeof r.signature === "string" && r.signature
          ? r.signature
          : typeof coMeta.closeTxSignature === "string" && coMeta.closeTxSignature
            ? (coMeta.closeTxSignature as string)
            : null;
      if (!sig) continue; // figureless AND signatureless success — cannot prove it moved money
      const verdict = await verifyRawSigLanded(sig, connection);
      if (verdict === "unverifiable") {
        sawUnverifiable = true;
        continue;
      }
      if (verdict !== "landed") continue;
      const rec = recoverHopSolReturned({ attributableFloorRaw: floorRaw });
      if (rec.ok) return { kind: "recovered", raw: rec.solReturnedRaw, source: rec.source, signature: sig, provenOp: co };
      return { kind: "proven_unattributable", provenOp: co };
    }

    // Non-succeeded child (failed / still-pending): its close tx may have
    // landed anyway. The selector inside verifyCloseTxLanded decides which
    // records still carry a provable close identity — ANY step whose
    // surviving explicit key matches the final raw entry (WO2A-C2), plus
    // keyless crash-window records. "malformed" covers everything else
    // (keyless post-write-ahead steps, mismatched or malformed identities)
    // without an RPC call → keep scanning older.
    const verdict = await verifyCloseTxLanded(co, connection);
    if (verdict === "landed") {
      const rec = recoverHopSolReturned({ attributableFloorRaw: floorRaw });
      if (rec.ok) return { kind: "recovered", raw: rec.solReturnedRaw, source: rec.source, signature: pickCloseTxSig(co), provenOp: co };
      return { kind: "proven_unattributable", provenOp: co };
    }
    if (verdict === "unverifiable") {
      sawUnverifiable = true;
      continue;
    }
    // not_landed / malformed → keep scanning older attempts
  }
  return sawUnverifiable ? { kind: "unverifiable" } : { kind: "none" };
}

/**
 * Resolve the specific MAIN Loop Open transaction signature from an open-
 * attempt operation record (F4 open recovery). Same fail-closed discipline as
 * pickCloseTxSig above.
 *
 * Valid ONLY for the two lifecycle steps a loop_open op can durably carry
 * AFTER the write-ahead persisted:
 *  - "loop_sig_writeahead" — crash window between the FATAL write-ahead
 *    persist and any later step write;
 *  - "open_ambiguous"      — the ambiguous branch's terminal marker, written
 *    exclusively after the executor returned WITH a signature (a hook failure
 *    aborts the broadcast and surfaces NO signature → step "exec_failed").
 * Any other step fails closed WITHOUT touching RPC: pre-write-ahead records
 * (e.g. "atas_prepared") may carry ONLY the ATA-prep signature in
 * txSignatures, and promoting that to the main-open identity is the exact
 * bug class this selector exists to prevent.
 *
 * Precedence:
 *  1. meta.openTxSignature — merged atomically by the write-ahead hook; must
 *     exactly equal the FINAL raw txSignatures entry or the record is
 *     inconsistent (fail closed).
 *  2. txSignatures[last]   — legacy records that predate the explicit key;
 *     the ATA-prep sig (when present) is appended BEFORE the write-ahead
 *     fires, so the main open sig is always LAST. A malformed trailing entry
 *     fails closed — never "skip back" to an earlier entry.
 *
 * @internal exported for unit tests only — not a public API surface.
 */
export function pickOpenTxSig(oo: {
  step: string | null;
  txSignatures: unknown[] | null;
  metadata: Record<string, unknown> | null | undefined;
}): string | null {
  if (oo.step !== "loop_sig_writeahead" && oo.step !== "open_ambiguous") return null;

  const arr = Array.isArray(oo.txSignatures) ? oo.txSignatures : [];
  const rawLast = arr.length > 0 ? arr[arr.length - 1] : undefined;
  const lastSig = typeof rawLast === "string" && rawLast.length > 0 ? rawLast : null;

  const meta = (oo.metadata ?? {}) as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(meta, "openTxSignature")) {
    const explicit = meta.openTxSignature;
    if (typeof explicit !== "string" || explicit.length === 0) return null;
    if (lastSig === null || explicit !== lastSig) return null;
    return explicit;
  }
  return lastSig;
}

export type LoopOpenTxVerdict =
  | "landed" //          confirmed/finalized without error — adopt & finalize
  | "onchain_failed" //  landed WITH an error: atomic tx ⇒ nothing moved — restorable
  | "expired" //         provably dead past lastValidBlockHeight + buffer — restorable
  | "still_valid" //     may still land (or expiry unprovable) — keep pending
  | "unverifiable" //    RPC failure — keep pending, re-check later
  | "malformed"; //      provenance unusable — fail closed, never guess

/** Same +30 safety buffer as the executor's own in-flight confirm loop. */
const OPEN_EXPIRY_BLOCK_BUFFER = 30;

/**
 * Verify the main Loop Open tx of a crash-window/ambiguous open attempt.
 * A NULL signature status is NOT proof of expiry (RPC index lag / still in
 * flight): "expired" additionally requires a VALID recorded
 * lastValidBlockHeight AND a successful LIVE block-height read strictly past
 * it + OPEN_EXPIRY_BLOCK_BUFFER. Missing/malformed expiry metadata or any RPC
 * failure stays ambiguous — callers keep the row pending, never restore.
 *
 * @internal exported for unit tests only — not a public API surface.
 */
export async function verifyOpenTxLanded(
  oo: {
    step: string | null;
    txSignatures: unknown[] | null;
    metadata: Record<string, unknown> | null | undefined;
  },
  connection: Pick<Connection, "getSignatureStatuses" | "getBlockHeight">,
): Promise<LoopOpenTxVerdict> {
  const sig = pickOpenTxSig(oo);
  if (!sig) return "malformed";

  let st: { err: unknown; confirmationStatus?: string | null } | null | undefined;
  try {
    const res = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
    st = res.value[0];
  } catch {
    return "unverifiable";
  }

  if (st) {
    if (st.err) return "onchain_failed";
    if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return "landed";
    return "still_valid"; // "processed" — not final enough to adopt, not proof of death
  }

  const meta = (oo.metadata ?? {}) as Record<string, unknown>;
  const lvbhRaw = meta.lastValidBlockHeight;
  const lvbh =
    typeof lvbhRaw === "number"
      ? lvbhRaw
      : typeof lvbhRaw === "string" && lvbhRaw.trim() !== ""
        ? Number(lvbhRaw)
        : NaN;
  if (!Number.isFinite(lvbh) || lvbh <= 0) return "still_valid"; // expiry unprovable → ambiguous

  let height: number;
  try {
    height = await connection.getBlockHeight("confirmed");
  } catch {
    return "unverifiable";
  }
  return height > lvbh + OPEN_EXPIRY_BLOCK_BUFFER ? "expired" : "still_valid";
}

export interface LoopHopParams {
  walletAddress: string;
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  /** The CURRENTLY OPEN loop position to unwind. */
  borrowPositionId: string;
  /** The better allowlisted vault to re-loop onto (must differ from current). */
  targetVaultId: number;
  slippageBps?: number;
  /** REQUIRED — the retry/idempotency key for the whole hop op. */
  clientRequestId: string;
  /** Free-form policy audit string (e.g. the allocation reason that triggered it). */
  policyReason?: string;
  /**
   * WO2A recovery mode. "automatic" (default — allocation tick / resume sweep)
   * enforces LOOP_HOP_RECOVERY_POLICY and PARKS the hop when a budget is
   * exceeded; "manual" (admin resume) may drive exactly one more attempt per
   * invocation even on a parked or budget-exhausted parent.
   */
  mode?: "automatic" | "manual";
}

export interface LoopHopResult {
  success: boolean;
  /** The NEW loop position id (set once the re-open lands). */
  borrowPositionId?: string;
  closeSignature?: string;
  openSignature?: string;
  /** SOL realized from the unwind, raw lamports (the re-loop principal budget). */
  solReturnedLamports?: string;
  /** Estimated hop cost (2 full-notional swap slippage + rent overhead), raw lamports. */
  predictedCostLamports?: string;
  /**
   * Realized rent+fee overhead (solReturned − principal), raw lamports. NOTE:
   * this is an OVERHEAD proxy only — it does NOT include the swap slippage paid
   * on each leg (that is priced into solReturned itself and cannot be cheaply
   * isolated), so it UNDERSTATES the true all-in hop cost. `predictedCost` is
   * the honest all-in estimate.
   */
  realizedCostLamports?: string;
  verifyWarning?: string;
  /** True = declined by the execution-time carry re-gate (NOT an error; nothing moved). */
  policyDenied?: boolean;
  /** True = interrupted after money moved; retry the SAME clientRequestId to resume. */
  resumable?: boolean;
  /** True = this clientRequestId already succeeded. */
  alreadyCompleted?: boolean;
  /** True = this clientRequestId terminally failed BEFORE any money moved; use a fresh one. */
  terminal?: boolean;
  /** WO2A: true = the hop exceeded its automatic recovery budget (or was already parked) and waits for MANUAL resume. */
  parked?: boolean;
  /** WO2A: why the hop parked (open_broadcast_budget_exhausted | post_close_age_exceeded | close_done_time_unknown). */
  parkReason?: string;
  /**
   * WO2A-C1: true ONLY on the invocation that WON the pending→parked CAS —
   * the single caller allowed to journal/notify this park. Every other parked
   * result (rival parked first, parked-door refusal, durable-truth re-read)
   * reports the SAME park a second time; journaling those would double-alert.
   * Cross-process truthful because the flag rides the CAS outcome itself,
   * never sweep-query timing.
   */
  parkedByThisInvocation?: boolean;
  /**
   * WO2B2C: true = a FRESH hop (durable parent persisted; zero close evidence)
   * deferred because this wallet has an unfinished durable SOL withdrawal, or
   * because that could not be verified (fail closed). Nothing was gated, read
   * strictly, written, or broadcast — retry the SAME clientRequestId once the
   * withdrawal reaches a terminal status.
   */
  deferredForSolWithdraw?: boolean;
  /** WO2A: how the recovered close output was attributed. */
  principalSource?: HopSolReturnedSource;
  error?: string;
}

/**
 * Execution-time carry re-gate for a hop: recompute BOTH pairs' net carry at
 * their OWN dynamic target leverage from FRESH single-vault reads (the sampled
 * decision-table may be minutes old after hysteresis), and require the target
 * to still beat the current pair by more than `hopMinCarryGainApy`. Fail closed
 * on any unreadable input — an unmeasurable edge is NOT an edge.
 */
async function evaluateHopCarryGain(
  fromVaultId: number,
  toVaultId: number,
): Promise<{ ok: boolean; gainApy: number | null; fromCarryApy: number | null; toCarryApy: number | null; toLeverage: number | null; reason?: string }> {
  const fromRate = await resolveFreshLoopRate(fromVaultId);
  const toRate = await resolveFreshLoopRate(toVaultId);
  if (!fromRate) return { ok: false, gainApy: null, fromCarryApy: null, toCarryApy: null, toLeverage: null, reason: "current pair rates unreadable" };
  if (!toRate) return { ok: false, gainApy: null, fromCarryApy: null, toCarryApy: null, toLeverage: null, reason: "target pair rates unreadable" };

  const fromTarget = computeLoopTargetLeverage({
    vaultId: fromVaultId,
    liquidationThreshold: fromRate.liquidationThreshold,
    stakingApy: fromRate.stakingApy,
    borrowApr: fromRate.borrowApr,
  });
  const toTarget = computeLoopTargetLeverage({
    vaultId: toVaultId,
    liquidationThreshold: toRate.liquidationThreshold,
    stakingApy: toRate.stakingApy,
    borrowApr: toRate.borrowApr,
  });
  if (fromTarget.leverage === null) return { ok: false, gainApy: null, fromCarryApy: null, toCarryApy: null, toLeverage: null, reason: "current pair leverage unreadable" };
  if (toTarget.leverage === null) return { ok: false, gainApy: null, fromCarryApy: null, toCarryApy: null, toLeverage: null, reason: "target pair not profitable to loop right now" };

  const fromCarryApy = netCarryAt(fromRate.stakingApy, fromRate.borrowApr, fromTarget.leverage);
  const toCarryApy = netCarryAt(toRate.stakingApy, toRate.borrowApr, toTarget.leverage);
  if (fromCarryApy === null || toCarryApy === null) {
    return { ok: false, gainApy: null, fromCarryApy, toCarryApy, toLeverage: toTarget.leverage, reason: "net carry unreadable" };
  }
  const gainApy = toCarryApy - fromCarryApy;
  return {
    ok: gainApy > LOOP_ALLOCATION_POLICY.hopMinCarryGainApy,
    gainApy,
    fromCarryApy,
    toCarryApy,
    toLeverage: toTarget.leverage,
    reason: gainApy > LOOP_ALLOCATION_POLICY.hopMinCarryGainApy ? undefined : "carry gain no longer clears the hop threshold",
  };
}

/**
 * P4 HOP (plan §4.4/§5): fully unwind the current loop pair to SOL and re-loop
 * that SOL onto a BETTER allowlisted pair. NOT atomic in one transaction — a
 * loop tx is already 1215/1232 bytes, so a close+open in one tx is impossible.
 * Instead each leg is INDIVIDUALLY atomic and the whole hop is CRASH-RESUMABLE
 * through a durable op row, so funds are never stranded:
 *
 *  - PRE-CLOSE (no money moved): re-gate the carry edge at EXECUTION time
 *    (fresh reads) — if the target no longer beats the current pair by
 *    `hopMinCarryGainApy`, decline cleanly (policyDenied, nothing closed).
 *    Record the pre-close agent SOL baseline. → step `pre_gated`.
 *  - CLOSE: full unwind to SOL via executeLoopClose (its own lock + op + swap
 *    reconcile). solReturned = its reported figure, ELSE the STRICT balance
 *    delta vs the pre-close baseline (self-heal / ambiguous-clear paths report
 *    no figure). → step `close_done`, solReturned persisted.
 *  - RE-OPEN: size the principal from the REAL solReturned exactly like the
 *    deposit-open path (preflight → overhead → principal = solReturned −
 *    overhead), open on the target. If the target is unopenable at this size,
 *    FALL BACK to the best openable allowlisted vault (which may be the ORIGINAL
 *    pair — a hop that reverses to where it started is still fund-safe). If
 *    nothing is openable, leave it resumable: the SOL sits safely in the agent
 *    wallet and the next tick / retry re-loops it. → step `opened`, succeeded.
 *
 * NO wrapping borrow lock: the close and open take DIFFERENT lock keys
 * (fromVault vs toVault), and the op row is the cross-leg coordination point.
 */
export async function executeLoopHop(params: LoopHopParams): Promise<LoopHopResult> {
  const { walletAddress, agentPublicKey, agentSecretKey, borrowPositionId, targetVaultId } = params;
  const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

  if (!params.clientRequestId || typeof params.clientRequestId !== "string") {
    return { success: false, error: "clientRequestId is required for a safe hop retry path." };
  }
  if (!LOOP_VAULT_ALLOWLIST[targetVaultId]) {
    return { success: false, error: `Hop target vault ${targetVaultId} is not on the loop launch allowlist.` };
  }

  // Load-or-create the durable op row (idempotent on clientRequestId). Do this
  // BEFORE touching the source position: on a RESUME the close has already run,
  // so the source position is CLOSED and cannot be re-loaded — we read the
  // source vault from the op metadata instead (only the FRESH path reads chain).
  let op = await storage.getBorrowOperationByClientRequestId(walletAddress, params.clientRequestId);
  if (op && op.operationType !== "loop_hop") {
    return { success: false, error: "This request id was already used by a different operation." };
  }
  if (op && (op.status === "succeeded" || op.status === "completed")) {
    const r = (op.result ?? {}) as Record<string, any>;
    return {
      success: true,
      alreadyCompleted: true,
      borrowPositionId: r.borrowPositionId ?? undefined,
      closeSignature: r.closeSignature ?? undefined,
      openSignature: r.openSignature ?? undefined,
      solReturnedLamports: r.solReturnedLamports ?? undefined,
    };
  }
  if (op && op.status === "failed") {
    // Terminal ONLY when it failed BEFORE the close (money never moved). If the
    // close had already run, the op would carry a solReturnedLamports crumb and
    // must be resumable, not terminal — guard on that.
    const meta0 = (op.metadata ?? {}) as Record<string, any>;
    if (!meta0.solReturnedLamports) {
      return {
        success: false,
        terminal: true,
        error: "This hop attempt was declined or failed before any funds moved. Your position is unchanged.",
      };
    }
  }

  // WO2A door: automatic recovery must NEVER re-drive a PARKED hop — parked
  // means the automatic budget was already exhausted and a human explicitly
  // owns the next attempt. Defense in depth: the resume sweep's query also
  // excludes parked rows, so this door only fires on a direct automatic call.
  const mode: "automatic" | "manual" = params.mode === "manual" ? "manual" : "automatic";
  if (op && op.status === "parked" && mode !== "manual") {
    const metaParked = (op.metadata ?? {}) as Record<string, any>;
    return {
      success: false,
      parked: true,
      parkReason: typeof metaParked.parkReason === "string" ? metaParked.parkReason : "parked",
      error: "This hop is parked for manual resume. Automatic recovery will not touch it — resume it explicitly from the admin surface.",
    };
  }

  let fromVaultId: number;
  if (op) {
    // RESUME: trust the source vault recorded at creation (the source position
    // may already be closed, so we cannot re-derive it from chain).
    const m = (op.metadata ?? {}) as Record<string, any>;
    const fv = Number(m.fromVaultId);
    if (!Number.isInteger(fv) || fv <= 0) {
      return { success: false, resumable: true, error: "Hop op is missing its source vault id; cannot safely resume." };
    }
    fromVaultId = fv;
  } else {
    // FRESH: the source position MUST still be open (fail closed).
    const loaded = await loadOpenLoopPosition(walletAddress, borrowPositionId);
    if (!loaded.ok) return { success: false, error: loaded.error };
    fromVaultId = loaded.loaded.vaultId;
    if (fromVaultId === targetVaultId) {
      return { success: false, error: "Hop target is the same pair as the current position — nothing to do." };
    }
    try {
      op = await storage.createBorrowOperation({
        walletAddress,
        borrowPositionId, // the SOURCE position; result records the new one
        operationType: "loop_hop",
        status: "pending",
        step: "initialized",
        clientRequestId: params.clientRequestId,
        metadata: {
          kind: "loop",
          fromVaultId,
          toVaultId: targetVaultId,
          slippageBps,
          sourceBorrowPositionId: borrowPositionId,
          ...(params.policyReason ? { policyReason: params.policyReason } : {}),
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

  let solReturned: bigint | null = null;
  try {
    if (typeof meta.solReturnedLamports === "string") solReturned = BigInt(meta.solReturnedLamports);
  } catch {
    solReturned = null;
  }
  let closeSignature: string | undefined = typeof meta.closeSignature === "string" ? meta.closeSignature : undefined;
  let targetLeverage: number | null = typeof meta.targetLeverage === "number" ? meta.targetLeverage : null;
  // WO2A attribution/budget state. principalSource travels with solReturned;
  // closeDoneAt is IMMUTABLE once merged (first proof wins) and is the ONLY
  // basis for the post-close age budget — never parent row timestamps, which
  // move on every breadcrumb write and would reset the clock forever.
  let principalSource: HopSolReturnedSource | null =
    meta.principalSource === "exact" || meta.principalSource === "conservative_floor" ? meta.principalSource : null;
  let closeDoneAtCandidate: string | null = null;
  const closeCridFor = (n: number) => `${params.clientRequestId}:close:${n}`;

  try {
    // ---- PHASE 1: PRE-CLOSE GATE + CLOSE (skipped once solReturned is known) ----
    if (solReturned === null) {
      // Per-attempt close crid (mirrors the re-open leg below). executeLoopClose
      // REJECTS a duplicate clientRequestId (the unique index has no status
      // filter), so a FAILED close row under a FIXED crid would wedge every retry
      // on "already submitted" — freezing the hop and, via hopInFlightPositionIds,
      // excluding the position from all allocation decisions. Each attempt gets
      // its own crid; executeLoopClose re-reads live state and self-heals if the
      // position is already flat, so retries progress instead of deadlocking.
      const priorCloseAttempts = Number(meta.closeAttempts ?? 0);

      // The persisted pre-close SOL baseline is the durable marker that the gate
      // already passed and the close leg is in play. Its PRESENCE means we must
      // NOT re-gate or re-read the baseline on resume: after the close, a fresh
      // read is post-close (overstated), and a rate that has since drifted would
      // falsely decline a hop whose funds have already moved.
      let baseline: bigint | null = null;
      try {
        if (typeof meta.preCloseAgentLamports === "string") baseline = BigInt(meta.preCloseAgentLamports);
      } catch {
        baseline = null;
      }

      // Ground truth for "did the unwind move money?": the source position is no
      // longer open (a loop is only marked closed AFTER its unwind tx confirms).
      // This survives executeLoopClose's own crash window — position closed but
      // its op not yet marked succeeded — where blindly re-invoking it would fail
      // loadOpenLoopPosition and stall the hop forever.
      const sourceStillOpen = (await loadOpenLoopPosition(walletAddress, borrowPositionId)).ok;

      if (sourceStillOpen) {
        // Money has NOT moved yet.
        if (baseline === null) {
          // WO2B2C reciprocal withdraw↔hop gate — GENUINELY FRESH hops only:
          // no pre-close baseline, no close-attempt write-ahead, no recorded
          // close signature — nothing can have been broadcast, so deferring is
          // free. Any close evidence at all BYPASSES this gate: recovering
          // in-play money always outranks a withdrawal's claim on the wallet.
          //
          // The durable parent above is ALREADY persisted, and the withdraw
          // side persists its own intent row BEFORE scanning for non-terminal
          // loop_hop rows — each side scans only after its own row is durable,
          // so whichever commits second sees the other and exactly one defers
          // (a mutual miss is impossible). Deferral is deliberately writeless:
          // the parent stays pending/'initialized' and the SAME clientRequestId
          // retries cleanly once the withdrawal terminals.
          //
          // Allowlist semantics, matching the withdraw side's blocker scan:
          // only proven-terminal statuses pass; unknown statuses and an
          // unreadable or malformed scan defer FAIL-CLOSED. An abandoned
          // pending withdrawal therefore defers fresh hops until it is
          // resolved — the deliberate mirror of a parked hop blocking
          // withdrawals.
          if (priorCloseAttempts === 0 && closeSignature === undefined) {
            let withdrawBlocker: BorrowOperation | undefined;
            try {
              const walletOps = await storage.getBorrowOperations(walletAddress);
              withdrawBlocker = walletOps.find(
                (o) =>
                  o.operationType === AGENT_SOL_WITHDRAW_OP_TYPE &&
                  !TERMINAL_OPERATION_STATUSES.has(String(o.status ?? "")),
              );
            } catch (e) {
              return {
                success: false,
                resumable: true,
                deferredForSolWithdraw: true,
                error: `Could not verify that no SOL withdrawal is in flight for this wallet (${e instanceof Error ? e.message : "operation scan failed"}). The hop deferred before any carry check, balance read, or close attempt — your position is unchanged. Retry with the same request id.`,
              };
            }
            if (withdrawBlocker) {
              return {
                success: false,
                resumable: true,
                deferredForSolWithdraw: true,
                error: `A SOL withdrawal for this wallet is still settling (status '${withdrawBlocker.status}'). The hop deferred before any funds moved — your position is unchanged. Retry with the same request id once the withdrawal finishes.`,
              };
            }
          }
          // FRESH: execution-time carry re-gate — a decline is clean and terminal
          // for THIS attempt (nothing has moved).
          const gate = await evaluateHopCarryGain(fromVaultId, targetVaultId);
          if (!gate.ok) {
            await failOp(opId, "carry_gate_failed", gate.reason ?? "hop no longer beats the carry threshold");
            return {
              success: false,
              policyDenied: true,
              error: `Hop declined: ${gate.reason ?? "the better pair no longer beats the current one by enough to justify the switch"}. Your position is unchanged.`,
            };
          }
          targetLeverage = gate.toLeverage;

          // Write-ahead a genuine PRE-close SOL baseline (STRICT read → fail
          // closed): the self-heal / ambiguous-clear close paths report no
          // returned figure, so we reconstruct solReturned from this baseline.
          baseline = BigInt((await getAgentTokenBalanceRawStrict(agentPublicKey, NATIVE_SOL_MINT)).amountRaw);
          const baselinePersisted = await storage.updateBorrowOperation(opId, {
            step: "pre_gated",
            mergeMetadata: {
              preCloseAgentLamports: baseline.toString(),
              ...(targetLeverage != null ? { targetLeverage } : {}),
              gateGainApy: gate.gainApy,
              gateFromCarryApy: gate.fromCarryApy,
              gateToCarryApy: gate.toCarryApy,
              // WO2A: the ONLY destinations a recovery pass may open on,
              // persisted AT the gate that authorized the hop: the requested
              // target (gate-approved) and the original source (it was already
              // levered pre-hop and passed the source-side gate — restoring it
              // is never a new bet). pickBestLoopVault is deliberately NOT
              // consulted at recovery time: "best" then is a NEW allocation
              // decision nobody authorized. NOTE for future HOLD-style
              // callers: persist [target] only — a hop is the only flow whose
              // source re-lever is pre-authorized.
              authorizedRecoveryVaultIds: [targetVaultId, fromVaultId],
            },
          });
          // The persisted baseline is how a no-figure close path (self-heal /
          // ambiguous-clear) reconstructs solReturned on resume. If it did not
          // persist, a post-close crash would leave the hop resumable forever
          // (funds safe in wallet, never re-looped) — refuse to close until it's
          // durable.
          if (!baselinePersisted) {
            return {
              success: false,
              resumable: true,
              error: "Could not record the pre-unwind baseline. Your funds are safe. Wait a minute and retry.",
            };
          }
        }

        // CLOSE — full unwind to SOL (its own lock + op + swap reconcile).
        // Write-ahead the attempt number BEFORE the call so a resume can find and
        // vet every close op we created (mirrors openAttempts on the re-open leg).
        // If that write does not persist, a resume can't discover this close op
        // and would mis-terminal a genuine own-close as closed_outside_hop — so
        // refuse to broadcast until the attempt marker is durable.
        const closeAttempt = priorCloseAttempts + 1;
        const attemptPersisted = await storage.updateBorrowOperation(opId, { mergeMetadata: { closeAttempts: closeAttempt } });
        if (!attemptPersisted) {
          return {
            success: false,
            resumable: true,
            error: "Could not record the unwind attempt. Your funds are safe. Wait a minute and retry.",
          };
        }
        const close = await executeLoopClose({
          walletAddress,
          agentPublicKey,
          agentSecretKey,
          borrowPositionId,
          slippageBps,
          clientRequestId: closeCridFor(closeAttempt),
        });
        if (!close.success) {
          // The unwind did not complete: the source position is still open (or
          // unresolved). Nothing to re-open yet — resumable, funds intact.
          return {
            success: false,
            resumable: true,
            ...(close.signature ? { closeSignature: close.signature } : {}),
            error: `${close.error || "Unwind did not complete."} Your position is safe. Retry to finish the hop.`,
          };
        }
        closeSignature = close.signature;

        // WO2A close-output attribution (direct path): exact figure first;
        // else THIS close's own pre-broadcast floor — but only once its signed
        // tx provably landed; a signatureless self-heal is NOT proof this hop
        // moved money and may only recover through an OLDER proven own-close.
        // Whole-wallet balance deltas are gone: they attribute out-of-band
        // credits/debits to the hop and re-lever money it never touched.
        if (close.solReturnedLamports) {
          const rec = recoverHopSolReturned({ exactCloseOutputRaw: close.solReturnedLamports });
          if (!rec.ok) {
            return {
              success: false,
              resumable: true,
              ...(closeSignature ? { closeSignature } : {}),
              error: "The unwind landed but its reported output is unreadable. Your funds are safe. Wait a minute and retry.",
            };
          }
          solReturned = rec.solReturnedRaw;
          principalSource = rec.source;
          closeDoneAtCandidate = new Date().toISOString();
        } else if (close.signature) {
          // Ambiguous-but-cleared: the close verified the position flat but
          // could not measure the returned SOL. Probe-flat ALONE also matches
          // "our tx expired AND someone closed it out-of-band", so the floor
          // may size the re-loop ONLY once this attempt's own tx is confirmed.
          const verdict = await verifyRawSigLanded(close.signature, getServerConnection());
          if (verdict !== "landed") {
            // Fresh broadcast — a not-yet-visible sig may still land. Never
            // terminalize here; the resume path re-checks once settled.
            return {
              success: false,
              resumable: true,
              ...(closeSignature ? { closeSignature } : {}),
              error: "Could not yet confirm on-chain whether the unwind landed. Your funds are safe. Wait a minute and retry.",
            };
          }
          const closeOpRow = await storage.getBorrowOperationByClientRequestId(walletAddress, closeCridFor(closeAttempt));
          const closeOpMeta = (closeOpRow?.metadata ?? {}) as Record<string, any>;
          const rec = recoverHopSolReturned({
            attributableFloorRaw: typeof closeOpMeta.attributableFloorRaw === "string" ? closeOpMeta.attributableFloorRaw : null,
          });
          if (!rec.ok) {
            return {
              success: false,
              resumable: true,
              ...(closeSignature ? { closeSignature } : {}),
              error: "The unwind landed but carries no exact output and no recorded attribution floor. Your funds are safe; this hop needs a manual look.",
            };
          }
          solReturned = rec.solReturnedRaw;
          principalSource = rec.source;
          closeDoneAtCandidate = new Date().toISOString();
        } else {
          // Signatureless self-heal success: the position was found already
          // flat, and NO transaction backs this attempt. Only an EARLIER
          // numbered close child of THIS hop can prove the unwind was ours.
          const older = await recoverFromOlderProvenClose(walletAddress, closeCridFor, closeAttempt - 1, getServerConnection());
          if (older.kind === "recovered") {
            solReturned = older.raw;
            principalSource = older.source;
            if (!closeSignature && older.signature) closeSignature = older.signature;
            const provenAt = older.provenOp.updatedAt instanceof Date
              ? older.provenOp.updatedAt.getTime()
              : Date.parse(String(older.provenOp.updatedAt));
            closeDoneAtCandidate = Number.isFinite(provenAt) ? new Date(provenAt).toISOString() : null;
          } else if (older.kind === "unverifiable") {
            return {
              success: false,
              resumable: true,
              error: "Could not yet confirm on-chain whether an earlier unwind attempt landed. Your funds are safe. Wait a minute and retry.",
            };
          } else if (older.kind === "proven_unattributable") {
            return {
              success: false,
              resumable: true,
              error: "The unwind provably ran but its output cannot be attributed (no exact figure and no recorded floor). Your funds are safe; this hop needs a manual look.",
            };
          } else {
            await failOp(opId, "closed_outside_hop", "position already flat and no own close attempt proves this hop moved money");
            return {
              success: false,
              error: "Hop aborted: the position was closed outside this hop, so there is nothing to re-loop. Your funds are safe in your account.",
            };
          }
        }
      } else {
        // RESUME after a crash: the source is no longer open. "Closed" ALONE is
        // NOT proof that OUR unwind ran — a position closed OUTSIDE this hop (a
        // user close, a safety unwind) also reads closed, and attributing
        // anything to it would re-lever funds this hop never touched. WO2A:
        // recoverFromOlderProvenClose walks our OWN numbered close children for
        // proof — an exact figure, else the proven child's own persisted floor
        // (verified-landed first) — and SELF-HEAL successes are EXCLUDED as
        // proof (they were stamped without a transaction; treating them as
        // proven was the old code's bug class). No wallet-delta fallback
        // exists anymore, so an unproven close can never seize out-of-band
        // funds.
        const older = await recoverFromOlderProvenClose(
          walletAddress,
          closeCridFor,
          priorCloseAttempts,
          getServerConnection(),
        );
        if (older.kind === "unverifiable") {
          // A candidate close sig exists but the RPC could not confirm whether
          // it landed. Refuse to re-lever (could seize an out-of-band close)
          // and refuse to terminal (could de-lever a real own-close).
          return {
            success: false,
            resumable: true,
            error: "Could not yet confirm on-chain whether the unwind landed. Your funds are safe. Wait a minute and retry.",
          };
        }
        if (older.kind === "proven_unattributable") {
          // Our close provably landed, but its record carries no exact figure
          // and no floor (legacy/corrupt). Sizing from ANY other source would
          // guess — stay resumable for a manual look, never terminal.
          return {
            success: false,
            resumable: true,
            error: "The unwind provably ran but its output cannot be attributed (no exact figure and no recorded floor). Your funds are safe; this hop needs a manual look.",
          };
        }
        if (older.kind === "none") {
          // Nothing this hop did closed the position → re-levering would seize
          // funds the user (or a safety unwind) deliberately took out. Terminal:
          // failing the op frees the position from hopInFlightPositionIds so the
          // allocation brain can act on it normally again.
          await failOp(opId, "closed_outside_hop", "source position closed outside this hop — refusing to re-lever");
          return {
            success: false,
            error: "Hop aborted: the position was closed outside this hop, so there is nothing to re-loop. Your funds are safe in your account.",
          };
        }
        solReturned = older.raw;
        principalSource = older.source;
        if (!closeSignature && older.signature) closeSignature = older.signature;
        // WO2A: the age budget anchors on the PROVEN close child's own terminal
        // write time (its updatedAt) — never this parent's timestamps.
        const provenAt = older.provenOp.updatedAt instanceof Date
          ? older.provenOp.updatedAt.getTime()
          : Date.parse(String(older.provenOp.updatedAt));
        closeDoneAtCandidate = Number.isFinite(provenAt) ? new Date(provenAt).toISOString() : null;
      }

      // WO2A: return-checked close_done persist. Also merges principalSource
      // and the IMMUTABLE closeDoneAt (merged only when absent — first proof
      // wins; a later resume must never slide the budget clock forward).
      const closeDoneMerge: Record<string, unknown> = {
        solReturnedLamports: solReturned.toString(),
        ...(principalSource ? { principalSource } : {}),
        ...(closeSignature ? { closeSignature } : {}),
      };
      const existingCloseDoneAt = typeof meta.closeDoneAt === "string" && meta.closeDoneAt ? meta.closeDoneAt : null;
      if (!existingCloseDoneAt && closeDoneAtCandidate) closeDoneMerge.closeDoneAt = closeDoneAtCandidate;
      const closeDonePersisted = await storage.updateBorrowOperation(opId, {
        step: "close_done",
        mergeMetadata: closeDoneMerge,
      });
      if (!closeDonePersisted) {
        // The attribution crumb is what lets every later pass (and the budget
        // clock) trust solReturned without re-deriving it — refuse to proceed
        // to the open leg until it is durable.
        return {
          success: false,
          resumable: true,
          ...(closeSignature ? { closeSignature } : {}),
          error: "Could not durably record the unwind result. Your funds are safe. Wait a minute and retry.",
        };
      }
    } else if (solReturned !== null && op.step !== "close_done" && op.step !== "opened") {
      // Defensive: solReturned crumb exists but the step wasn't advanced — treat
      // as close_done (the close provably happened) and proceed to re-open.
      const stepAdvanced = await storage.updateBorrowOperation(opId, { step: "close_done" });
      if (!stepAdvanced) {
        return {
          success: false,
          resumable: true,
          error: "Could not advance the hop record. Your funds are safe. Wait a minute and retry.",
        };
      }
    }

    // ---- PHASE 2: RE-OPEN (size from the real solReturned; fallback + resume) ----
    if (solReturned === null || solReturned <= 0n) {
      return {
        success: false,
        resumable: true,
        ...(closeSignature ? { closeSignature } : {}),
        error: "Hop is mid-flight but the unwound SOL is not yet measurable. Your funds are safe. Retry shortly.",
      };
    }

    // WO2A: re-read the parent once — the close leg may have merged crumbs
    // this pass, and the active-child slot, budgets and authorization list
    // must be judged from what is DURABLE, never a stale pre-close load.
    const parentNow = await storage.getBorrowOperationById(opId);
    if (!parentNow) {
      return {
        success: false,
        resumable: true,
        solReturnedLamports: solReturned.toString(),
        ...(closeSignature ? { closeSignature } : {}),
        error: "The hop record could not be re-read. Your funds are safe. Retry shortly.",
      };
    }
    const metaNow = (parentNow.metadata ?? {}) as Record<string, any>;
    if (principalSource === null && (metaNow.principalSource === "exact" || metaNow.principalSource === "conservative_floor")) {
      principalSource = metaNow.principalSource;
    }
    const activeSlotCrid =
      typeof metaNow.activeOpenClientRequestId === "string" && metaNow.activeOpenClientRequestId
        ? (metaNow.activeOpenClientRequestId as string)
        : null;
    // Set when the persisted slot turns out to be a crash-orphan (claimed, but
    // its child op was never created — provably nothing broadcast under it):
    // the fresh flow below must REUSE that crid, never mint a rival beside it.
    let slotOrphanToReuse: { crid: string; vaultId: number | null } | null = null;

    // ---- PHASE 2a: RECONCILE ANY PRIOR CHILD OPEN ATTEMPT (F4/SL-10/WO2A) ----
    // Runs BEFORE the budget gate (a prior child that LANDED must be adopted,
    // never parked away from) and BEFORE a new attempt is numbered. A prior
    // child that broadcast — or LANDED — is resolved from ITS OWN durable
    // records; it is never superseded while unproven and never re-opened with
    // this retry's sizing.
    const solRecovered = solReturned;
    const priorOpenAttempts = Number(metaNow.openAttempts ?? 0);
    if (activeSlotCrid || priorOpenAttempts > 0) {
      // SL-10 lock discipline: the whole child scan + reconcile + adoption is
      // serialized under the SAME borrow-lock key the open path's recovery
      // gate uses — a concurrent executeLoopOpen or a concurrent retry of this
      // hop must never race this child to a double finalize (double equity
      // event). The child op is read INSIDE the lock so a lock-waiter sees the
      // winner's terminal write instead of a stale pending shape. The lock is
      // RELEASED before the fresh-attempt flow below: executeLoopOpen acquires
      // the same key itself and withBorrowLock is NOT reentrant.
      const reopenVaultCandidate = Number(metaNow.reopenVaultId);
      const phase2aLockVault =
        Number.isInteger(reopenVaultCandidate) && reopenVaultCandidate > 0
          ? reopenVaultCandidate
          : targetVaultId;
      const phase2a = await withBorrowLock(
        borrowLockKey(walletAddress, null, phase2aLockVault),
        async (): Promise<LoopHopResult | { slotOrphan: { crid: string; vaultId: number | null } } | null> => {
      // WO2A slot-first: the persisted active-child slot IS the single-flight
      // record — resolve it before any legacy numbered scan.
      let child: BorrowOperation | null = null;
      let slotChildCrid: string | null = null;
      if (activeSlotCrid) {
        const c = await storage.getBorrowOperationByClientRequestId(walletAddress, activeSlotCrid);
        if (c && c.operationType === "loop_open") {
          child = c;
          slotChildCrid = activeSlotCrid;
        } else if (!c) {
          // Slot claimed but its child op was never created (crash in the
          // claim→create gap): provably nothing was broadcast under that crid.
          // Signal the fresh flow to REUSE it — the slot stays claimed.
          // (Returned rather than written to the captured `let`: CFA can't see
          // closure writes, and the outer reads would narrow to `never`.)
          return {
            slotOrphan: {
              crid: activeSlotCrid,
              vaultId:
                Number.isInteger(Number(metaNow.activeOpenVaultId)) && Number(metaNow.activeOpenVaultId) > 0
                  ? Number(metaNow.activeOpenVaultId)
                  : null,
            },
          };
        } else {
          // The slot's crid resolves to a non-open op — corrupt linkage; a
          // human look beats guessing which record to trust.
          return {
            success: false,
            resumable: true,
            solReturnedLamports: solRecovered.toString(),
            ...(closeSignature ? { closeSignature } : {}),
            error: "The hop's recovery slot points at an unexpected record. Your funds are safe. Retry with the same request to resume.",
          };
        }
      }
      if (!child) {
        // Legacy rows (pre-slot): newest→oldest — the attempt counter was
        // merged BEFORE the child op row was created, so the newest numbered
        // crid may have no op at all (crash in that gap ⇒ provably nothing
        // broadcast under it) — fall back to the newest attempt that recorded
        // one. At most ONE child can be unresolved: a new number was only
        // issued after the previous child was proven dead.
        for (let n = priorOpenAttempts; n >= 1; n--) {
          const c = await storage.getBorrowOperationByClientRequestId(
            walletAddress,
            `${params.clientRequestId}:open:${n}`,
          );
          if (c && c.operationType === "loop_open") {
            child = c;
            break;
          }
        }
      }
      if (child) {
        const childMeta = (child.metadata ?? {}) as Record<string, unknown>;
        const childResumable = (why: string): LoopHopResult => ({
          success: false,
          resumable: true,
          solReturnedLamports: solRecovered.toString(),
          ...(closeSignature ? { closeSignature } : {}),
          error: `${why} Your funds are safe. Retry with the same request to resume.`,
        });
        // Adopt = terminalize THIS hop from the child's ORIGINAL records ONLY:
        // its persisted principal, leverage, slippage, vault and row identity.
        // A resumed retry may carry DIFFERENT sizing, so no current-retry
        // value (slippage/target leverage/rates) or default may leak into the
        // adopted accounting (WO1-C1). Missing or malformed durable fields ⇒
        // null ⇒ the parent stays RESUMABLE — never guessed-succeeded, and
        // nothing is broadcast. Formulas mirror the normal path (realized =
        // rent/fee overhead proxy; predicted = both legs' slippage on the
        // whole notional + overhead) evaluated with the CHILD's own values.
        const adoptChild = async (
          openSignature: string | null,
          adoptedRowId: string | null,
        ): Promise<LoopHopResult | null> => {
          const childVaultId = Number(childMeta.vaultId);
          let childPrincipal: bigint;
          try {
            childPrincipal = BigInt(String(childMeta.principalLamports));
          } catch {
            return null;
          }
          if (!Number.isInteger(childVaultId) || childVaultId <= 0 || childPrincipal <= 0n) return null;
          if (!adoptedRowId) return null; // row identity must be the child's own
          const childLev = Number(childMeta.leverage);
          if (!Number.isFinite(childLev) || childLev < 1) return null;
          const childSlipBps = childMeta.slippageBps == null ? NaN : Number(childMeta.slippageBps);
          if (!Number.isFinite(childSlipBps) || childSlipBps < 0) return null;
          const overheadL = solRecovered - childPrincipal;
          const realized = overheadL > 0n ? overheadL : 0n;
          const predicted =
            BigInt(Math.max(0, Math.round((2 * childSlipBps) / 10000 * Number(solRecovered) * childLev))) + realized;
          // WO2A: adoption finalizes via CAS — guarded on the slot crid when
          // the child came from the slot, and on an EMPTY slot for legacy
          // children (a sibling's live claim wins; we re-read and report).
          const finalized = await storage.finalizeLoopHopParent(
            opId,
            slotChildCrid
              ? { expectedActiveOpenClientRequestId: slotChildCrid }
              : { requireNoActiveChild: true },
            {
              status: "succeeded",
              step: "opened",
              borrowPositionId: adoptedRowId,
              clearActiveChild: true,
              result: {
                borrowPositionId: adoptedRowId,
                closeSignature: closeSignature ?? null,
                openSignature,
                solReturnedLamports: solRecovered.toString(),
                principalLamports: childPrincipal.toString(),
                predictedCostLamports: predicted.toString(),
                realizedCostLamports: realized.toString(),
                ...(principalSource ? { principalSource } : {}),
                fromVaultId,
                toVaultId: childVaultId,
                reversed: childVaultId === fromVaultId,
                adoptedFromChildRecovery: true,
              },
            },
          );
          if (!finalized) {
            // CAS lost: a sibling finalized/parked/claimed first. Report the
            // durable truth instead of double-finalizing.
            const now = await storage.getBorrowOperationById(opId);
            if (now && (now.status === "succeeded" || now.status === "completed")) {
              const r2 = (now.result ?? {}) as Record<string, any>;
              return {
                success: true,
                alreadyCompleted: true,
                ...(typeof r2.borrowPositionId === "string" ? { borrowPositionId: r2.borrowPositionId } : {}),
                ...(typeof r2.closeSignature === "string" ? { closeSignature: r2.closeSignature } : {}),
                ...(typeof r2.openSignature === "string" ? { openSignature: r2.openSignature } : {}),
                ...(typeof r2.solReturnedLamports === "string" ? { solReturnedLamports: r2.solReturnedLamports } : {}),
              };
            }
            return childResumable("The hop record changed underneath this adoption.");
          }
          return {
            success: true,
            ...(adoptedRowId ? { borrowPositionId: adoptedRowId } : {}),
            closeSignature,
            ...(openSignature ? { openSignature } : {}),
            solReturnedLamports: solRecovered.toString(),
            predictedCostLamports: predicted.toString(),
            realizedCostLamports: realized.toString(),
            ...(childVaultId === fromVaultId
              ? { verifyWarning: "The target pair was no longer openable, so the SOL was re-looped onto the original pair (your funds are safe)." }
              : {}),
          };
        };

        if (child.status === "succeeded" || child.status === "completed") {
          // SL-10 crash shape: the child open COMPLETED but the parent hop
          // never persisted "opened" — adopt it; NEVER broadcast another open.
          const r = (child.result ?? {}) as Record<string, unknown>;
          const adopted = await adoptChild(
            typeof r.signature === "string" && r.signature ? r.signature : null,
            child.borrowPositionId ?? null,
          );
          return (
            adopted ??
            childResumable(
              "A previous re-open attempt already succeeded but its records are unreadable — refusing to guess its amounts.",
            )
          );
        }

        const childProvenDead =
          child.status === "failed" &&
          (child.step === "tx_failed_onchain" ||
            child.step === "exec_failed" ||
            child.step === "reconciled_tx_failed_onchain" ||
            child.step === "reconciled_tx_expired" ||
            child.step === "pre_broadcast_reconciled");

        if (childProvenDead || !loopOpenWriteaheadRecorded(child)) {
          // Provably dead or provably never broadcast: repair its linked row
          // if one is still stuck pending, terminalize a dangling pending
          // child, then a FRESH numbered attempt below is safe.
          if (child.borrowPositionId) {
            let childRow: BorrowPosition | undefined;
            try {
              childRow = await storage.getBorrowPosition(walletAddress, child.borrowPositionId);
            } catch {
              childRow = undefined;
            }
            if (childRow && childRow.status === "pending") {
              const repaired = await restoreLoopPendingRow(childRow.id, childMeta.reuseNftId != null);
              if (!repaired) {
                return childResumable("A previous re-open attempt's position row could not be repaired yet.");
              }
            }
          }
          if (child.status === "pending") {
            await failOp(
              child.id,
              "pre_broadcast_reconciled",
              "Hop child open provably never broadcast — superseded by a fresh numbered attempt.",
            );
          }
          if (slotChildCrid) {
            // WO2A: the dead child still occupies the slot — release it (CAS)
            // so the fresh flow below claims a NEW numbered attempt.
            const cleared = await storage.clearLoopHopActiveChild(opId, slotChildCrid);
            if (!cleared) {
              return childResumable("The recovery slot changed underneath this cleanup.");
            }
          }
          // fall through to the normal fresh-attempt flow below
        } else {
          // Ambiguous: write-ahead recorded, outcome unproven — resolve from
          // the child's exact recorded signature before anything fresh.
          if (!child.borrowPositionId) {
            return childResumable(
              "A previous re-open attempt broadcast a transaction but is not linked to its position row — refusing to guess.",
            );
          }
          let childRow: BorrowPosition | undefined;
          try {
            childRow = await storage.getBorrowPosition(walletAddress, child.borrowPositionId);
          } catch {
            childRow = undefined;
          }
          if (!childRow) {
            return childResumable("A previous re-open attempt's position row could not be loaded.");
          }
          const outcome = await reconcileAmbiguousLoopOpen({
            op: child,
            position: childRow,
            walletAddress,
            connection: getServerConnection(),
            borrowRoute: new JupiterLendBorrowRoute(),
          });
          if (outcome.outcome === "finalized_open") {
            const adopted = await adoptChild(
              outcome.result.signature ?? null,
              outcome.result.borrowPositionId ?? child.borrowPositionId,
            );
            return (
              adopted ??
              childResumable(
                "A previous re-open attempt LANDED and was finalized, but its records are unreadable for the hop summary.",
              )
            );
          }
          if (outcome.outcome === "blocked") {
            return childResumable(`A previous re-open attempt is still unresolved: ${outcome.reason}`);
          }
          // "restored": the dead attempt was repaired — a fresh attempt is safe.
          if (slotChildCrid) {
            // WO2A: same slot release as the proven-dead branch above.
            const cleared = await storage.clearLoopHopActiveChild(opId, slotChildCrid);
            if (!cleared) {
              return childResumable("The recovery slot changed underneath this cleanup.");
            }
          }
        }
      }
      // No child op recorded at all (the counter ran ahead of op creation —
      // nothing was ever broadcast under those crids), or the prior child was
      // proven dead / never-broadcast and repaired above: fresh attempt safe.
      return null;
        },
      );
      if (phase2a && "slotOrphan" in phase2a) {
        // Outer-scope assignment on purpose — TS control-flow analysis only
        // trusts writes it can see from the read sites in THIS scope.
        slotOrphanToReuse = phase2a.slotOrphan;
      } else if (phase2a) {
        return phase2a;
      }
    }

    // ---- WO2A BUDGET GATE (automatic mode only; strictly AFTER Phase 2a) ----
    // Phase 2a already ran: budgets must never park a hop whose prior child
    // actually LANDED (that child gets adopted above, not counted against a
    // budget). Manual mode skips the gate — the operator owns the decision —
    // and a manual failure simply leaves the row as it was.
    if (mode === "automatic") {
      const broadcastAttempts = await countHopBroadcastAttempts(
        walletAddress,
        params.clientRequestId,
        Number(metaNow.openAttempts ?? 0),
      );
      let closeDoneAtMs: number | null = null;
      const closeDoneAtStr =
        typeof metaNow.closeDoneAt === "string" && metaNow.closeDoneAt ? metaNow.closeDoneAt : closeDoneAtCandidate;
      if (closeDoneAtStr) {
        const t = Date.parse(closeDoneAtStr);
        if (Number.isFinite(t)) closeDoneAtMs = t;
      }
      if (closeDoneAtMs === null) {
        // Legacy rows (close_done written before WO2A): backfill the immutable
        // anchor from the newest SUCCEEDED non-self-heal close child's own
        // terminal write time. Self-heal successes are excluded — they carry
        // no transaction and may long postdate the real unwind.
        const nClose = Number(metaNow.closeAttempts ?? 0);
        for (let n = nClose; n >= 1; n--) {
          const co = await storage.getBorrowOperationByClientRequestId(walletAddress, closeCridFor(n));
          if (!co || co.status !== "succeeded") continue;
          if (((co.metadata ?? {}) as Record<string, any>).selfHeal === true) continue;
          const t = co.updatedAt instanceof Date ? co.updatedAt.getTime() : Date.parse(String(co.updatedAt));
          if (Number.isFinite(t)) {
            closeDoneAtMs = t;
            await storage.updateBorrowOperation(opId, {
              mergeMetadata: { closeDoneAt: new Date(t).toISOString() },
            });
          }
          break;
        }
      }
      const attemptsExhausted = broadcastAttempts >= LOOP_HOP_RECOVERY_POLICY.maxOpenBroadcastAttempts;
      const ageExceeded =
        closeDoneAtMs === null ||
        Date.now() - closeDoneAtMs > LOOP_HOP_RECOVERY_POLICY.maxAutomaticPostCloseAgeMs;
      if (attemptsExhausted || ageExceeded) {
        const parkReason = attemptsExhausted
          ? "open_broadcast_budget_exhausted"
          : closeDoneAtMs === null
            ? "close_done_time_unknown"
            : "post_close_age_exceeded";
        // Park via CAS from pending only. The active-child slot (if any) is
        // deliberately NOT cleared — a manual resume reconciles it first.
        const parkedOk = await storage.finalizeLoopHopParent(
          opId,
          { expectedStatus: "pending" },
          {
            status: "parked",
            step: "parked",
            mergeMetadata: {
              parkedAt: new Date().toISOString(),
              parkReason,
              parkPrincipalLamports: solReturned.toString(),
              ...(principalSource ? { parkPrincipalSource: principalSource } : {}),
              parkBroadcastAttempts: broadcastAttempts,
              parkOpenAttempts: Number(metaNow.openAttempts ?? 0),
              parkCloseAttempts: Number(metaNow.closeAttempts ?? 0),
            },
          },
        );
        if (!parkedOk) {
          const now = await storage.getBorrowOperationById(opId);
          if (now && (now.status === "succeeded" || now.status === "completed")) {
            const r2 = (now.result ?? {}) as Record<string, any>;
            return {
              success: true,
              alreadyCompleted: true,
              ...(typeof r2.borrowPositionId === "string" ? { borrowPositionId: r2.borrowPositionId } : {}),
              ...(typeof r2.closeSignature === "string" ? { closeSignature: r2.closeSignature } : {}),
              ...(typeof r2.openSignature === "string" ? { openSignature: r2.openSignature } : {}),
              ...(typeof r2.solReturnedLamports === "string" ? { solReturnedLamports: r2.solReturnedLamports } : {}),
            };
          }
          if (now && now.status === "parked") {
            const mp = (now.metadata ?? {}) as Record<string, any>;
            return {
              success: false,
              parked: true,
              parkReason: typeof mp.parkReason === "string" ? mp.parkReason : parkReason,
              solReturnedLamports: solReturned.toString(),
              ...(closeSignature ? { closeSignature } : {}),
              error: "This hop was parked by a concurrent attempt. Resume it manually from the admin surface.",
            };
          }
          return {
            success: false,
            resumable: true,
            solReturnedLamports: solReturned.toString(),
            ...(closeSignature ? { closeSignature } : {}),
            error: "The hop record changed while parking it. Retry shortly.",
          };
        }
        return {
          success: false,
          parked: true,
          // This invocation WON the pending→parked CAS — it alone may be
          // journaled/notified by the caller (WO2A-C1).
          parkedByThisInvocation: true,
          parkReason,
          solReturnedLamports: solReturned.toString(),
          ...(principalSource ? { principalSource } : {}),
          ...(closeSignature ? { closeSignature } : {}),
          error: `Hop parked for manual resume (${parkReason.split("_").join(" ")}). The unwound SOL stays safe in the agent wallet; resume from the admin surface when ready.`,
        };
      }
    }

    // ---- FRESH RE-OPEN ATTEMPT (WO2A: authorized destinations + atomic slot) ----
    // Recovery may open ONLY on pre-authorized destinations: the list persisted
    // at gate time (legacy rows: the equally-pre-close [target, source] pair
    // from creation). pickBestLoopVault is NOT consulted — "best right now" is
    // a NEW allocation decision nobody authorized. At most ONE fallback per
    // pass, shared by the preflight-failure and policy-deny triggers.
    const authorizedRecoveryVaultIds: number[] = (
      Array.isArray(metaNow.authorizedRecoveryVaultIds)
        ? (metaNow.authorizedRecoveryVaultIds as unknown[]).map(Number)
        : [Number(metaNow.toVaultId ?? targetVaultId), Number(metaNow.fromVaultId ?? fromVaultId)]
    ).filter(
      (v, i, arr) => Number.isInteger(v) && v > 0 && !!LOOP_VAULT_ALLOWLIST[v] && arr.indexOf(v) === i,
    );
    let fallbackUsed = false;

    type OpenAttemptOutcome =
      | { kind: "opened"; open: LoopOpenResult; slotCrid: string; vaultId: number; principal: bigint; overhead: bigint }
      | { kind: "preflight_failed"; error?: string }
      | { kind: "principal_too_small" }
      | { kind: "open_failed"; open: LoopOpenResult; slotCrid: string; vaultId: number }
      | { kind: "blocked"; result: LoopHopResult };

    const preflightOn = (vaultId: number) =>
      executeLoopOpen({
        walletAddress,
        agentPublicKey,
        agentSecretKey,
        vaultId,
        principalLamports: solReturned!,
        slippageBps,
        preflightOnly: true,
        callerHoldsBorrowLock: false,
      });

    // Exact overhead (NFT mint rent + missing ATA rents + fee headroom) from
    // the preflight; the true principal is solReturned − overhead.
    const sizeFrom = (pf: LoopOpenResult): { principal: bigint; overhead: bigint } | null => {
      if (!pf.preflight) return null;
      const overheadRaw = BigInt(Math.max(0, Math.round(pf.preflight.requiredLamports))) - solReturned!;
      const overhead = overheadRaw > 0n ? overheadRaw : 0n;
      const principal = solReturned! - overhead;
      return principal <= 0n ? null : { principal, overhead };
    };

    const durableTruthOrResumable = async (why: string): Promise<LoopHopResult> => {
      const now = await storage.getBorrowOperationById(opId);
      if (now && (now.status === "succeeded" || now.status === "completed")) {
        const r2 = (now.result ?? {}) as Record<string, any>;
        return {
          success: true,
          alreadyCompleted: true,
          ...(typeof r2.borrowPositionId === "string" ? { borrowPositionId: r2.borrowPositionId } : {}),
          ...(typeof r2.closeSignature === "string" ? { closeSignature: r2.closeSignature } : {}),
          ...(typeof r2.openSignature === "string" ? { openSignature: r2.openSignature } : {}),
          ...(typeof r2.solReturnedLamports === "string" ? { solReturnedLamports: r2.solReturnedLamports } : {}),
        };
      }
      if (now && now.status === "parked") {
        const mp = (now.metadata ?? {}) as Record<string, any>;
        return {
          success: false,
          parked: true,
          parkReason: typeof mp.parkReason === "string" ? mp.parkReason : "parked",
          solReturnedLamports: solReturned!.toString(),
          ...(closeSignature ? { closeSignature } : {}),
          error: "This hop was parked by a concurrent attempt. Resume it manually from the admin surface.",
        };
      }
      return {
        success: false,
        resumable: true,
        solReturnedLamports: solReturned!.toString(),
        ...(closeSignature ? { closeSignature } : {}),
        error: `${why} Your funds are safe. Retry shortly.`,
      };
    };

    const runOpenAttempt = async (vaultIdWanted: number, presetSlotCrid: string | null): Promise<OpenAttemptOutcome> => {
      let vaultId = vaultIdWanted;
      let pf = await preflightOn(vaultId);
      if (!pf.success || !pf.preflight) return { kind: "preflight_failed", error: pf.error };
      let sized = sizeFrom(pf);
      if (!sized) return { kind: "principal_too_small" };
      let slotCrid: string;
      if (presetSlotCrid) {
        // Crash-orphan slot: reuse the SAME durable crid — nothing was ever
        // broadcast under it, and reusing it preserves single-flight.
        slotCrid = presetSlotCrid;
      } else {
        const claim = await storage.claimLoopHopOpenAttempt(opId, vaultId);
        if (!claim) {
          return {
            kind: "blocked",
            result: await durableTruthOrResumable("The hop record changed underneath this attempt."),
          };
        }
        slotCrid = claim.activeOpenClientRequestId;
        if (claim.adopted) {
          // The slot was already claimed by another attempt. A live rival
          // child means a process is mid-open: reconciliation belongs to
          // Phase 2a on the NEXT pass — NEVER broadcast a rival beside it.
          const rival = await storage.getBorrowOperationByClientRequestId(walletAddress, slotCrid);
          if (rival) {
            return {
              kind: "blocked",
              result: {
                success: false,
                resumable: true,
                solReturnedLamports: solReturned!.toString(),
                ...(closeSignature ? { closeSignature } : {}),
                error: "Another attempt is already re-opening this hop. Retry shortly to reconcile it.",
              },
            };
          }
          // Adopted a crash-orphan slot mid-pass: honor ITS pinned vault (the
          // durable intent) — re-preflight and re-size when it differs.
          if (claim.activeOpenVaultId != null && claim.activeOpenVaultId !== vaultId) {
            vaultId = claim.activeOpenVaultId;
            pf = await preflightOn(vaultId);
            if (!pf.success || !pf.preflight) {
              return {
                kind: "blocked",
                result: {
                  success: false,
                  resumable: true,
                  solReturnedLamports: solReturned!.toString(),
                  ...(closeSignature ? { closeSignature } : {}),
                  error: `${pf.error || "Could not size a re-loop on the pinned recovery vault."} Your unwound SOL is safe; retry shortly.`,
                },
              };
            }
            sized = sizeFrom(pf);
            if (!sized) return { kind: "principal_too_small" };
          }
        }
      }
      const open = await executeLoopOpen({
        walletAddress,
        agentPublicKey,
        agentSecretKey,
        vaultId,
        principalLamports: sized.principal,
        slippageBps,
        clientRequestId: slotCrid,
        callerHoldsBorrowLock: false,
      });
      if (!open.success) return { kind: "open_failed", open, slotCrid, vaultId };
      return { kind: "opened", open, slotCrid, vaultId, principal: sized.principal, overhead: sized.overhead };
    };

    let chosenVaultId = slotOrphanToReuse?.vaultId ?? authorizedRecoveryVaultIds[0] ?? targetVaultId;
    let outcome = await runOpenAttempt(chosenVaultId, slotOrphanToReuse?.crid ?? null);

    if (outcome.kind === "preflight_failed" && !fallbackUsed) {
      // Target unopenable at this size → at most ONE fallback, and only to the
      // other pre-authorized destination (typically the ORIGINAL pair —
      // restoring it is never a new bet; a reversing hop is still fund-safe).
      const next = authorizedRecoveryVaultIds.find((v) => v !== chosenVaultId);
      if (next != null) {
        if (slotOrphanToReuse) {
          // The orphan slot pins a different vault; release it (CAS) before
          // re-targeting so no rival crid can coexist with it.
          const cleared = await storage.clearLoopHopActiveChild(opId, slotOrphanToReuse.crid);
          if (!cleared) {
            return await durableTruthOrResumable("The recovery slot changed underneath this retry.");
          }
          slotOrphanToReuse = null;
        }
        fallbackUsed = true;
        chosenVaultId = next;
        // The fallback pair's own target leverage is unknown here — keep the
        // cost estimate honest instead of pricing it with the old target's.
        targetLeverage = null;
        outcome = await runOpenAttempt(chosenVaultId, null);
      }
    }

    if (outcome.kind === "open_failed" && !fallbackUsed) {
      // Policy-deny fallback: ONLY when the child provably never broadcast
      // (denies happen pre-sign) — a signed or ambiguous failure must stay on
      // its numbered crid for Phase 2a to reconcile on the next pass.
      const denied =
        Array.isArray(outcome.open.policyReasons) &&
        outcome.open.policyReasons.some((r) => r.severity === "deny") &&
        !outcome.open.signature;
      if (denied) {
        const childAfterDeny = await storage.getBorrowOperationByClientRequestId(walletAddress, outcome.slotCrid);
        const provablyNeverBroadcast =
          !childAfterDeny || (childAfterDeny.status === "failed" && !loopOpenWriteaheadRecorded(childAfterDeny));
        // Hoist out of the closure: narrowing on a `let` union doesn't
        // propagate into callbacks.
        const deniedVaultId = outcome.vaultId;
        const next = authorizedRecoveryVaultIds.find((v) => v !== deniedVaultId);
        if (provablyNeverBroadcast && next != null) {
          const cleared = await storage.clearLoopHopActiveChild(opId, outcome.slotCrid);
          if (cleared) {
            fallbackUsed = true;
            chosenVaultId = next;
            targetLeverage = null;
            outcome = await runOpenAttempt(chosenVaultId, null);
          }
        }
      }
    }

    if (outcome.kind === "blocked") return outcome.result;
    if (outcome.kind === "preflight_failed") {
      return {
        success: false,
        resumable: true,
        solReturnedLamports: solReturned.toString(),
        ...(closeSignature ? { closeSignature } : {}),
        error: `${outcome.error || "Could not size a re-loop."} Your unwound SOL is safe in your account and will be re-looped on the next attempt.`,
      };
    }
    if (outcome.kind === "principal_too_small") {
      return {
        success: false,
        resumable: true,
        solReturnedLamports: solReturned.toString(),
        ...(closeSignature ? { closeSignature } : {}),
        error: `The unwound SOL (${lamportsToSol(solReturned)} SOL) is too small to cover account rent and fees for a re-loop. It stays safe in your account.`,
      };
    }
    if (outcome.kind === "open_failed") {
      // The SOL is intact in the agent wallet; the op stays at close_done and
      // the numbered child stays in the slot for Phase 2a to reconcile.
      return {
        success: false,
        resumable: true,
        solReturnedLamports: solReturned.toString(),
        ...(closeSignature ? { closeSignature } : {}),
        error: `${outcome.open.error || "Re-loop open failed."} Your unwound SOL is safe. Retry to finish the hop.`,
      };
    }

    // predictedCost = both legs' slippage on the whole notional + rent overhead;
    // realizedCost = the rent/fee overhead proxy (see the field doc).
    const effLev = targetLeverage ?? 1;
    const predictedCost =
      BigInt(Math.max(0, Math.round((2 * slippageBps) / 10000 * Number(solReturned) * effLev))) +
      outcome.overhead;
    const realizedCost = solReturned - outcome.principal;

    // WO2A: finalize via CAS on the slot this attempt owns — a rival that
    // finalized/parked first wins, and the durable truth is reported instead
    // of a second terminal write (double-equity risk).
    const finalized = await storage.finalizeLoopHopParent(
      opId,
      { expectedActiveOpenClientRequestId: outcome.slotCrid },
      {
        status: "succeeded",
        step: "opened",
        borrowPositionId: outcome.open.borrowPositionId ?? borrowPositionId,
        clearActiveChild: true,
        result: {
          borrowPositionId: outcome.open.borrowPositionId ?? null,
          closeSignature: closeSignature ?? null,
          openSignature: outcome.open.signature ?? null,
          solReturnedLamports: solReturned.toString(),
          principalLamports: outcome.principal.toString(),
          predictedCostLamports: predictedCost.toString(),
          realizedCostLamports: realizedCost.toString(),
          ...(principalSource ? { principalSource } : {}),
          fromVaultId,
          toVaultId: outcome.vaultId,
          reversed: outcome.vaultId === fromVaultId,
        },
      },
    );
    if (!finalized) {
      return await durableTruthOrResumable("The hop record changed underneath this attempt's finalize.");
    }

    return {
      success: true,
      borrowPositionId: outcome.open.borrowPositionId,
      closeSignature,
      openSignature: outcome.open.signature,
      solReturnedLamports: solReturned.toString(),
      predictedCostLamports: predictedCost.toString(),
      realizedCostLamports: realizedCost.toString(),
      ...(principalSource ? { principalSource } : {}),
      ...(outcome.vaultId === fromVaultId
        ? { verifyWarning: "The target pair was no longer openable, so the SOL was re-looped onto the original pair (your funds are safe)." }
        : {}),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // NEVER terminal-fail after money may have moved: keep the step breadcrumb so
    // a retry resumes from close_done instead of re-closing.
    console.error(`[loop-executor] hop op ${opId} threw:`, e);
    return {
      success: false,
      resumable: true,
      ...(solReturned !== null ? { solReturnedLamports: solReturned.toString() } : {}),
      ...(closeSignature ? { closeSignature } : {}),
      error: `Hop hit an error: ${msg}. Your funds are safe. Retry with the same request to resume.`,
    };
  }
}

// --- PARTIAL UNWIND ---------------------------------------------------------------

export interface LoopPartialUnwindParams {
  walletAddress: string;
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  borrowPositionId: string;
  /** Fraction of the position to unwind, basis points (1..9000). */
  unwindBps: number;
  slippageBps?: number;
  clientRequestId?: string;
}

export interface LoopPartialUnwindResult {
  success: boolean;
  signature?: string;
  solReturnedLamports?: string;
  observedCollateralRaw?: string;
  observedDebtRaw?: string;
  verifyWarning?: string;
  error?: string;
  gasShortfall?: LoopGasShortfall;
}

export async function executeLoopPartialUnwind(params: LoopPartialUnwindParams): Promise<LoopPartialUnwindResult> {
  const { walletAddress, agentPublicKey, agentSecretKey, borrowPositionId, unwindBps } = params;
  const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

  if (!Number.isInteger(unwindBps) || unwindBps < 1 || unwindBps > MAX_UNWIND_BPS) {
    return { success: false, error: `unwindBps must be an integer in 1..${MAX_UNWIND_BPS} (use the full close beyond 90%).` };
  }

  const loadedRes = await loadOpenLoopPosition(walletAddress, borrowPositionId);
  if (!loadedRes.ok) return { success: false, error: loadedRes.error };
  const { vaultId } = loadedRes.loaded;

  const borrowRoute = new JupiterLendBorrowRoute();
  const cfg = await borrowRoute.getLoopVaultConfig(vaultId);
  if (!cfg) return { success: false, error: `Could not read loop vault ${vaultId} config — refusing (fail closed).` };

  return await withBorrowLock(borrowLockKey(walletAddress, null, vaultId), async () => {
    const relock = await loadOpenLoopPosition(walletAddress, borrowPositionId);
    if (!relock.ok) return { success: false, error: relock.error };
    const { pos, nftId } = relock.loaded;

    const connection = getServerConnection();
    const agentPubkey = new PublicKey(agentPublicKey);
    const wsolMintPk = new PublicKey(WSOL_MINT);
    const lstMintPk = new PublicKey(cfg.collateralMint);

    const live = await borrowRoute.readLoopLivePositionHealth(vaultId, nftId);
    if (!live) return { success: false, error: "Partial unwind: could not read the live position — refusing (fail closed). Retry shortly." };
    const liveDebt = BigInt(live.debtRaw);
    const liveCol = BigInt(live.collateralRaw);
    if (liveDebt <= 0n || liveCol <= 0n) {
      return { success: false, error: "Partial unwind: the position reads flat or broken on-chain — use the full close path." };
    }

    // Proportional sizing: repay CEIL (debt never under-repaid for the slice),
    // withdraw FLOOR (collateral never over-withdrawn). Repay is capped at the
    // venue's max exact repay so it can never overshoot true debt.
    const bps = BigInt(unwindBps);
    let repayRaw = (liveDebt * bps + 9_999n) / 10_000n;
    const maxRepay = BigInt(live.maxRepayNativeRaw || "0");
    if (maxRepay > 0n && repayRaw > maxRepay) repayRaw = maxRepay;
    const withdrawRaw = (liveCol * bps) / 10_000n;
    if (repayRaw <= 0n || withdrawRaw <= 0n) {
      return { success: false, error: "Partial unwind: the requested fraction rounds to zero — increase the percentage." };
    }
    const remainingDebt = liveDebt - repayRaw;
    const remainingCol = liveCol - withdrawRaw;
    if (remainingDebt <= DEFAULT_SOL_DEBT_DUST_RAW || remainingCol <= DEFAULT_LST_COLLATERAL_DUST_RAW) {
      return { success: false, error: "Partial unwind would leave a dust-sized position — use the full close instead." };
    }

    let opId: string;
    try {
      const op = await storage.createBorrowOperation({
        walletAddress,
        borrowPositionId: pos.id,
        operationType: "loop_unwind",
        status: "pending",
        step: "initialized",
        clientRequestId: params.clientRequestId ?? null,
        metadata: {
          kind: "loop",
          vaultId,
          nftId,
          unwindBps,
          slippageBps,
          liveDebtRaw: liveDebt.toString(),
          liveCollateralRaw: liveCol.toString(),
          repayRaw: repayRaw.toString(),
          withdrawRaw: withdrawRaw.toString(),
        },
      });
      opId = op.id;
    } catch (e) {
      if (isUniqueViolation(e)) {
        return { success: false, error: "This unwind was already submitted. Check its status before retrying." };
      }
      throw e;
    }

    try {
      const wsolAta = ataFor(agentPubkey, wsolMintPk);
      const lstAta = ataFor(agentPubkey, lstMintPk);
      const infos = await connection.getMultipleAccountsInfo([wsolAta, lstAta]);
      const prepIxs: TransactionInstruction[] = [];
      if (!infos[0]) prepIxs.push(ixCreateAtaIdempotent(agentPubkey, agentPubkey, wsolMintPk));
      if (!infos[1]) prepIxs.push(ixCreateAtaIdempotent(agentPubkey, agentPubkey, lstMintPk));

      const gas = await ensureVaultGas({
        payingPublicKey: agentPublicKey,
        funderPublicKey: agentPublicKey,
        funderSecretKey: agentSecretKey,
        destMint: null,
        label: "Loop Unwind",
        extraRentLamports: prepIxs.length * ATA_RENT_LAMPORTS + LOOP_FEE_HEADROOM_LAMPORTS,
      });
      if (!gas.ok) {
        await failOp(opId, "gas_failed", gas.error || "insufficient SOL for fees");
        return {
          success: false,
          error: gas.error || "Loop Unwind: insufficient SOL for fees.",
          gasShortfall: {
            requiredLamports: gas.requiredLamports,
            heldLamports: gas.payerLamportsBefore + (gas.refilledLamports ?? 0) + (gas.fundedLamports ?? 0),
          },
        };
      }

      if (prepIxs.length > 0) {
        const prep = await executeAgentInstructionsConfirmOnly({
          agentPublicKey,
          agentSecretKey,
          instructions: [...cuIxs(PREP_CU_LIMIT), ...prepIxs],
          label: "Loop Unwind ATA prep",
        });
        if (!prep.success) {
          await failOp(opId, "ata_prep_failed", prep.error || "ATA prep tx did not confirm.");
          return { success: false, error: prep.error || "Loop Unwind: token account prep failed. Nothing was moved." };
        }
        await storage.updateBorrowOperation(opId, {
          step: "atas_prepared",
          ...(prep.signature ? { appendTxSignature: prep.signature } : {}),
        });
      } else {
        await storage.updateBorrowOperation(opId, { step: "atas_prepared" });
      }

      // Swap the withdrawn slice back to WSOL; must cover the flash payback
      // (including the rounded-up repay pull — see UNWIND_MIN_OUT_MARGIN).
      const quote = await jupQuote(cfg.collateralMint, WSOL_MINT, withdrawRaw, slippageBps);
      const minOut = BigInt(quote.otherAmountThreshold);
      if (minOut <= repayRaw + UNWIND_MIN_OUT_MARGIN_LAMPORTS) {
        await failOp(opId, "swap_would_not_cover_payback", `minOut ${minOut} <= repay ${repayRaw} + margin ${UNWIND_MIN_OUT_MARGIN_LAMPORTS}`);
        return {
          success: false,
          error: "Loop Unwind: the swap's worst-case output would not cover the repayment (slippage/depeg). Nothing was moved.",
        };
      }
      const swapResp = await jupSwapIxs(quote, agentPublicKey);
      if ((swapResp.setupInstructions || []).length > 0) {
        await failOp(opId, "swap_setup_ixs", `Swap returned ${swapResp.setupInstructions.length} setup ix(s).`);
        return { success: false, error: "Loop Unwind: swap route needs extra account setup — aborted. Retry shortly." };
      }
      if (!swapResp.swapInstruction) {
        await failOp(opId, "swap_ix_missing", "Swap response carried no swapInstruction.");
        return { success: false, error: "Loop Unwind: swap instructions unavailable. Nothing was moved." };
      }

      const flash = await import("@jup-ag/lend/flashloan");
      const borrowMod = await import("@jup-ag/lend/borrow");
      const BN = (await import("bn.js")).default;
      // Flash-borrow a cushion above the exact repay: the vault's repay pull
      // can round up past repayRaw, and an exactly-funded ATA fails SPL 0x1.
      // The surplus returns to the agent via the WSOL ATA close at tx end.
      const flashAmountRaw = repayRaw + UNWIND_FLASH_CUSHION_LAMPORTS;
      const { borrowIx, paybackIx } = await flash.getFlashloanIx({
        amount: new BN(flashAmountRaw.toString()),
        asset: wsolMintPk,
        signer: agentPubkey,
        connection,
      });
      const plan = planLoopPartialUnwind(nftId, { repayWsolRaw: repayRaw, withdrawLstRaw: withdrawRaw });
      const operate = await borrowMod.getOperateIx({
        vaultId,
        positionId: plan.positionId,
        colAmount: specToBN(BN, plan.colAmount, "col", borrowMod.MAX_WITHDRAW_AMOUNT, borrowMod.MAX_REPAY_AMOUNT),
        debtAmount: specToBN(BN, plan.debtAmount, "debt", borrowMod.MAX_WITHDRAW_AMOUNT, borrowMod.MAX_REPAY_AMOUNT),
        connection,
        signer: agentPubkey,
      });

      const instructions: TransactionInstruction[] = [
        ...cuIxs(LOOP_CU_LIMIT),
        borrowIx,
        ...operate.ixs,
        deserializeJupIx(swapResp.swapInstruction),
        paybackIx,
        ixCloseAccount(wsolAta, agentPubkey, agentPubkey),
      ];
      const alts = [
        ...(await loadAlts(connection, swapResp.addressLookupTableAddresses || [])),
        ...(operate.addressLookupTableAccounts || []),
      ];

      const exec = await executeAgentInstructions({
        agentPublicKey,
        agentSecretKey,
        instructions,
        verifyOutputMint: NATIVE_SOL_MINT,
        addressLookupTables: alts,
        label: "Loop Unwind",
        onBeforeBroadcast: async (info) => {
          const updated = await storage.updateBorrowOperation(opId, {
            step: "loop_sig_writeahead",
            appendTxSignature: info.signature,
            mergeMetadata: { blockhash: info.blockhash, lastValidBlockHeight: info.lastValidBlockHeight },
          });
          if (!updated) throw new Error("write-ahead signature persist failed — refusing to broadcast");
        },
      });

      if (exec.onChainFailed || (!exec.success && !exec.signature)) {
        await failOp(opId, exec.onChainFailed ? "tx_failed_onchain" : "exec_failed", exec.error || "Loop unwind tx failed.");
        return { success: false, signature: exec.signature, error: exec.error || "Loop Unwind failed — the position is unchanged." };
      }

      const persistObserved = async (
        post: LivePositionHealth,
        source: string,
      ): Promise<{ postDebt: bigint; postCol: bigint }> => {
        const postDebt = BigInt(post.debtRaw);
        const postCol = BigInt(post.collateralRaw);
        const snapshot = buildLoopHealthSnapshot(cfg, postCol, postDebt, post.oraclePriceUsd, source);
        await storage.updateBorrowPosition(pos.id, {
          collateralAmountRaw: postCol.toString(),
          debtAmountRaw: postDebt.toString(),
          healthSnapshot: snapshot,
          healthAsOf: new Date(),
          healthSource: source,
        });
        return { postDebt, postCol };
      };

      if (exec.success) {
        const solDelta = BigInt(exec.outputReceivedRaw || "0");
        const post = await borrowRoute.readLoopLivePositionHealth(vaultId, nftId).catch(() => null);
        let verifyWarning: string | undefined;
        let observed: { postDebt: bigint; postCol: bigint } | null = null;
        if (post) {
          observed = await persistObserved(post, "loop_unwind_onchain");
          const verify = verifyLoopPartialUnwindOutcome({
            debtBeforeRaw: liveDebt,
            debtAfterRaw: observed.postDebt,
            repayRequestedRaw: repayRaw,
            colBeforeRaw: liveCol,
            colAfterRaw: observed.postCol,
            withdrawRequestedRaw: withdrawRaw,
          });
          if (!verify.ok) {
            // ADVISORY here: the position stays open either way and the row now
            // carries the on-chain truth — surface the anomaly loudly.
            verifyWarning = `Partial unwind verification flagged '${verify.reason}' — recorded on-chain observed amounts.`;
          }
        } else {
          // Fail closed: keep the PRIOR (higher-debt) amounts rather than guess.
          verifyWarning = "Unwind confirmed but the position re-read failed — recorded amounts unchanged until the next health scan.";
        }
        await storage.updateBorrowOperation(opId, {
          status: "succeeded",
          step: post ? "final_read" : "unwind_unverified",
          result: {
            signature: exec.signature,
            solReturnedLamports: solDelta.toString(),
            ...(observed
              ? { observedDebtRaw: observed.postDebt.toString(), observedCollateralRaw: observed.postCol.toString() }
              : {}),
            ...(verifyWarning ? { verifyWarning } : {}),
          },
        });
        await recordLoopEquityEvent({
          walletAddress,
          eventType: "loop_unwind",
          amountLamports: solDelta,
          txSignature: exec.signature ?? null,
          notes: `Partial unwind ${cfg.collateralSymbol} loop (${(unwindBps / 100).toFixed(0)}%): ${lamportsToSol(solDelta)} SOL returned`,
        });
        return {
          success: true,
          signature: exec.signature,
          solReturnedLamports: solDelta.toString(),
          ...(observed
            ? { observedDebtRaw: observed.postDebt.toString(), observedCollateralRaw: observed.postCol.toString() }
            : {}),
          ...(verifyWarning ? { verifyWarning } : {}),
        };
      }

      // AMBIGUOUS: probe whether the slice actually came off.
      const probe = await borrowRoute.readLoopLivePositionHealth(vaultId, nftId).catch(() => null);
      if (probe && BigInt(probe.debtRaw) < liveDebt) {
        const observed = await persistObserved(probe, "loop_unwind_ambiguous_landed");
        await storage.updateBorrowOperation(opId, {
          status: "succeeded",
          step: "unwind_ambiguous_but_landed",
          result: {
            signature: exec.signature,
            solDeltaUnknown: true,
            observedDebtRaw: observed.postDebt.toString(),
            observedCollateralRaw: observed.postCol.toString(),
          },
        });
        return {
          success: true,
          signature: exec.signature,
          observedDebtRaw: observed.postDebt.toString(),
          observedCollateralRaw: observed.postCol.toString(),
          verifyWarning: "Unwind landed (debt reduced on-chain) but the returned SOL amount could not be measured.",
        };
      }
      if (probe) {
        await failOp(opId, "unwind_ambiguous_not_landed", `sig ${exec.signature} unconfirmed; live debt unchanged.`);
        return { success: false, signature: exec.signature, error: "Loop Unwind could not be confirmed and the position is unchanged on-chain. Retry." };
      }
      await failOp(opId, "unwind_ambiguous_unreadable", `sig ${exec.signature} unconfirmed; live read unreadable.`);
      return {
        success: false,
        signature: exec.signature,
        error: "Loop Unwind result is unknown (confirmation and position read both failed). Recorded amounts are unchanged — retry shortly.",
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await failOp(opId, "unexpected_error", msg);
      return { success: false, error: `Loop Unwind failed: ${msg}` };
    }
  });
}

// --- DELEVER TO HOLD (P3 policy leg) -----------------------------------------------
//
// Clears ALL WSOL debt in one atomic tx (flash borrow → repay MAX + withdraw the
// exact LST needed → swap → flash payback) and leaves the REMAINING collateral
// supplied. The row stays `open` with policyState='holding' — the allocation
// tick re-levers or fully exits later. Same fail-closed contract as the close.

export interface LoopDeleverParams {
  walletAddress: string;
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  borrowPositionId: string;
  slippageBps?: number;
  clientRequestId?: string;
  /** Why the policy loop chose HOLD (persisted to the row + decision journal). */
  policyReason?: string;
}

export interface LoopDeleverResult {
  success: boolean;
  signature?: string;
  /** Leftover native SOL returned to the agent wallet (cushion + swap surplus), raw lamports. */
  solReturnedLamports?: string;
  observedDebtRaw?: string;
  observedCollateralRaw?: string;
  /** True when the position was already in the target state on-chain — state stamped WITHOUT a transaction (no signature by design). */
  selfHeal?: boolean;
  verifyWarning?: string;
  error?: string;
  gasShortfall?: LoopGasShortfall;
}

export async function executeLoopDeleverToHold(params: LoopDeleverParams): Promise<LoopDeleverResult> {
  const { walletAddress, agentPublicKey, agentSecretKey, borrowPositionId } = params;
  const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const policyReason = (params.policyReason || "carry_negative").slice(0, 200);

  const loadedRes = await loadOpenLoopPosition(walletAddress, borrowPositionId);
  if (!loadedRes.ok) return { success: false, error: loadedRes.error };
  const { vaultId } = loadedRes.loaded;

  const borrowRoute = new JupiterLendBorrowRoute();
  const cfg = await borrowRoute.getLoopVaultConfig(vaultId);
  if (!cfg) return { success: false, error: `Could not read loop vault ${vaultId} config — refusing (fail closed).` };

  return await withBorrowLock(borrowLockKey(walletAddress, null, vaultId), async () => {
    const relock = await loadOpenLoopPosition(walletAddress, borrowPositionId);
    if (!relock.ok) return { success: false, error: relock.error };
    const { pos, nftId } = relock.loaded;

    const connection = getServerConnection();
    const agentPubkey = new PublicKey(agentPublicKey);
    const wsolMintPk = new PublicKey(WSOL_MINT);
    const lstMintPk = new PublicKey(cfg.collateralMint);

    const live = await borrowRoute.readLoopLivePositionHealth(vaultId, nftId);
    if (!live) return { success: false, error: "Loop Delever: could not read the live position — refusing (fail closed). Retry shortly." };
    const liveDebt = BigInt(live.debtRaw);
    const liveCol = BigInt(live.collateralRaw);

    // Self-heal: debt already cleared on-chain (a prior delever landed but we
    // crashed before recording it) — just stamp the HOLD state, no transaction.
    if (liveDebt <= DEFAULT_SOL_DEBT_DUST_RAW && liveCol > DEFAULT_LST_COLLATERAL_DUST_RAW) {
      const snapshot = buildLoopHealthSnapshot(cfg, liveCol, liveDebt, live.oraclePriceUsd, "loop_delever_selfheal");
      await storage.updateBorrowPosition(pos.id, {
        collateralAmountRaw: liveCol.toString(),
        debtAmountRaw: liveDebt.toString(),
        healthSnapshot: snapshot,
        healthAsOf: new Date(),
        healthSource: "loop_delever_selfheal",
        policyState: "holding",
        policyReason,
        policyStateChangedAt: new Date(),
      });
      try {
        await storage.createBorrowOperation({
          walletAddress,
          borrowPositionId: pos.id,
          operationType: "loop_delever_hold",
          status: "succeeded",
          step: "already_delevered_onchain",
          clientRequestId: params.clientRequestId ?? null,
          metadata: { kind: "loop", vaultId, nftId, selfHeal: true, policyReason },
        });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
      }
      return { success: true, selfHeal: true, verifyWarning: "Debt was already cleared on-chain — marked holding without a transaction." };
    }
    if (liveDebt <= 0n || liveCol <= 0n) {
      return { success: false, error: "Loop Delever: the position reads flat or broken on-chain — use the full close path." };
    }

    // Size the LST withdrawal: swapped at worst case it must cover the flash
    // payback (debt + cushion). Fail closed on any sizing refusal.
    // The withdrawable gate is skipped ONLY when the config value is unreadable
    // — a genuine 0 must refuse here, not waste a fee reverting on-chain.
    const flashAmountRaw = liveDebt + UNWIND_FLASH_CUSHION_LAMPORTS;
    let withdrawableGate: bigint | undefined;
    try {
      withdrawableGate = BigInt(cfg.withdrawableCollateralRaw);
      if (withdrawableGate < 0n) withdrawableGate = undefined;
    } catch {
      withdrawableGate = undefined;
    }
    const sizing = sizeLoopDeleverWithdraw({
      flashPaybackRaw: flashAmountRaw,
      solPerLst: live.oraclePriceUsd ?? NaN,
      sizingMarginBps: slippageBps + DELEVER_SIZING_PAD_BPS,
      liveCollateralRaw: liveCol,
      withdrawableCollateralRaw: withdrawableGate,
    });
    if (!sizing.ok) {
      const friendly =
        sizing.reason === "delever_would_empty_collateral" || sizing.reason === "delever_remainder_below_dust"
          ? "Loop Delever would leave almost nothing supplied — use the full close instead."
          : sizing.reason === "delever_exceeds_withdrawable"
            ? "Loop Delever: the vault does not have enough withdrawable liquidity right now. Retry shortly."
            : `Loop Delever refused (fail closed): ${sizing.reason}.`;
      return { success: false, error: friendly };
    }
    const withdrawRaw = sizing.withdrawLstRaw;

    let opId: string;
    try {
      const op = await storage.createBorrowOperation({
        walletAddress,
        borrowPositionId: pos.id,
        operationType: "loop_delever_hold",
        status: "pending",
        step: "initialized",
        clientRequestId: params.clientRequestId ?? null,
        metadata: {
          kind: "loop",
          vaultId,
          nftId,
          slippageBps,
          policyReason,
          liveDebtRaw: liveDebt.toString(),
          liveCollateralRaw: liveCol.toString(),
          flashAmountRaw: flashAmountRaw.toString(),
          withdrawRaw: withdrawRaw.toString(),
        },
      });
      opId = op.id;
    } catch (e) {
      if (isUniqueViolation(e)) {
        return { success: false, error: "This delever was already submitted. Check its status before retrying." };
      }
      throw e;
    }

    try {
      const wsolAta = ataFor(agentPubkey, wsolMintPk);
      const lstAta = ataFor(agentPubkey, lstMintPk);
      const infos = await connection.getMultipleAccountsInfo([wsolAta, lstAta]);
      const prepIxs: TransactionInstruction[] = [];
      if (!infos[0]) prepIxs.push(ixCreateAtaIdempotent(agentPubkey, agentPubkey, wsolMintPk));
      if (!infos[1]) prepIxs.push(ixCreateAtaIdempotent(agentPubkey, agentPubkey, lstMintPk));

      const gas = await ensureVaultGas({
        payingPublicKey: agentPublicKey,
        funderPublicKey: agentPublicKey,
        funderSecretKey: agentSecretKey,
        destMint: null,
        label: "Loop Delever",
        extraRentLamports: prepIxs.length * ATA_RENT_LAMPORTS + LOOP_FEE_HEADROOM_LAMPORTS,
      });
      if (!gas.ok) {
        await failOp(opId, "gas_failed", gas.error || "insufficient SOL for fees");
        return {
          success: false,
          error: gas.error || "Loop Delever: insufficient SOL for fees.",
          gasShortfall: {
            requiredLamports: gas.requiredLamports,
            heldLamports: gas.payerLamportsBefore + (gas.refilledLamports ?? 0) + (gas.fundedLamports ?? 0),
          },
        };
      }

      if (prepIxs.length > 0) {
        const prep = await executeAgentInstructionsConfirmOnly({
          agentPublicKey,
          agentSecretKey,
          instructions: [...cuIxs(PREP_CU_LIMIT), ...prepIxs],
          label: "Loop Delever ATA prep",
        });
        if (!prep.success) {
          await failOp(opId, "ata_prep_failed", prep.error || "ATA prep tx did not confirm.");
          return { success: false, error: prep.error || "Loop Delever: token account prep failed. Nothing was moved." };
        }
        await storage.updateBorrowOperation(opId, {
          step: "atas_prepared",
          ...(prep.signature ? { appendTxSignature: prep.signature } : {}),
        });
      } else {
        await storage.updateBorrowOperation(opId, { step: "atas_prepared" });
      }

      // Swap the withdrawn LST slice to WSOL; worst case must clear the TRUE
      // debt pull (repay MAX) with margin — the cushion rides back via ATA close.
      const quote = await jupQuote(cfg.collateralMint, WSOL_MINT, withdrawRaw, slippageBps);
      const minOut = BigInt(quote.otherAmountThreshold);
      if (minOut <= liveDebt + UNWIND_MIN_OUT_MARGIN_LAMPORTS) {
        await failOp(opId, "swap_would_not_cover_payback", `minOut ${minOut} <= debt ${liveDebt} + margin ${UNWIND_MIN_OUT_MARGIN_LAMPORTS}`);
        return {
          success: false,
          error: "Loop Delever: the swap's worst-case output would not cover the repayment (slippage/depeg). Nothing was moved.",
        };
      }
      const swapResp = await jupSwapIxs(quote, agentPublicKey);
      if ((swapResp.setupInstructions || []).length > 0) {
        await failOp(opId, "swap_setup_ixs", `Swap returned ${swapResp.setupInstructions.length} setup ix(s).`);
        return { success: false, error: "Loop Delever: swap route needs extra account setup — aborted. Retry shortly." };
      }
      if (!swapResp.swapInstruction) {
        await failOp(opId, "swap_ix_missing", "Swap response carried no swapInstruction.");
        return { success: false, error: "Loop Delever: swap instructions unavailable. Nothing was moved." };
      }

      const flash = await import("@jup-ag/lend/flashloan");
      const borrowMod = await import("@jup-ag/lend/borrow");
      const BN = (await import("bn.js")).default;
      const { borrowIx, paybackIx } = await flash.getFlashloanIx({
        amount: new BN(flashAmountRaw.toString()),
        asset: wsolMintPk,
        signer: agentPubkey,
        connection,
      });
      const plan = planLoopDeleverToHold(nftId, { withdrawLstRaw: withdrawRaw });
      const operate = await borrowMod.getOperateIx({
        vaultId,
        positionId: plan.positionId,
        colAmount: specToBN(BN, plan.colAmount, "col", borrowMod.MAX_WITHDRAW_AMOUNT, borrowMod.MAX_REPAY_AMOUNT),
        debtAmount: specToBN(BN, plan.debtAmount, "debt", borrowMod.MAX_WITHDRAW_AMOUNT, borrowMod.MAX_REPAY_AMOUNT),
        connection,
        signer: agentPubkey,
      });

      const instructions: TransactionInstruction[] = [
        ...cuIxs(LOOP_CU_LIMIT),
        borrowIx,
        ...operate.ixs,
        deserializeJupIx(swapResp.swapInstruction),
        paybackIx,
        ixCloseAccount(wsolAta, agentPubkey, agentPubkey), // return cushion + surplus as native SOL
      ];
      const alts = [
        ...(await loadAlts(connection, swapResp.addressLookupTableAddresses || [])),
        ...(operate.addressLookupTableAccounts || []),
      ];

      const exec = await executeAgentInstructions({
        agentPublicKey,
        agentSecretKey,
        instructions,
        verifyOutputMint: NATIVE_SOL_MINT,
        addressLookupTables: alts,
        label: "Loop Delever",
        onBeforeBroadcast: async (info) => {
          const updated = await storage.updateBorrowOperation(opId, {
            step: "loop_sig_writeahead",
            appendTxSignature: info.signature,
            mergeMetadata: { blockhash: info.blockhash, lastValidBlockHeight: info.lastValidBlockHeight },
          });
          if (!updated) throw new Error("write-ahead signature persist failed — refusing to broadcast");
        },
      });

      if (exec.onChainFailed || (!exec.success && !exec.signature)) {
        await failOp(opId, exec.onChainFailed ? "tx_failed_onchain" : "exec_failed", exec.error || "Loop delever tx failed.");
        return { success: false, signature: exec.signature, error: exec.error || "Loop Delever failed — the position is unchanged." };
      }

      const persistHolding = async (
        postDebt: bigint,
        postCol: bigint,
        oraclePriceUsd: number | null,
        source: string,
      ): Promise<void> => {
        const snapshot = buildLoopHealthSnapshot(cfg, postCol, postDebt, oraclePriceUsd, source);
        await storage.updateBorrowPosition(pos.id, {
          collateralAmountRaw: postCol.toString(),
          debtAmountRaw: postDebt.toString(),
          healthSnapshot: snapshot,
          healthAsOf: new Date(),
          healthSource: source,
          policyState: "holding",
          policyReason,
          policyStateChangedAt: new Date(),
        });
      };

      if (exec.success) {
        const solDelta = BigInt(exec.outputReceivedRaw || "0");
        const post = await borrowRoute.readLoopLivePositionHealth(vaultId, nftId).catch(() => null);
        if (post) {
          const postDebt = BigInt(post.debtRaw);
          const postCol = BigInt(post.collateralRaw);
          const verify = verifyLoopDeleverToHoldOutcome({ observedDebtRaw: postDebt, observedColRaw: postCol });
          if (!verify.ok) {
            // Fail closed: do NOT stamp HOLD. Persist the on-chain truth loudly.
            const snapshot = buildLoopHealthSnapshot(cfg, postCol, postDebt, post.oraclePriceUsd, "loop_delever_verify_failed");
            await storage.updateBorrowPosition(pos.id, {
              collateralAmountRaw: postCol.toString(),
              debtAmountRaw: postDebt.toString(),
              healthSnapshot: snapshot,
              healthAsOf: new Date(),
              healthSource: "loop_delever_verify_failed",
            });
            await failOp(opId, "delever_verify_failed", `verify: ${verify.reason}; solDelta=${solDelta}`);
            return {
              success: false,
              signature: exec.signature,
              solReturnedLamports: solDelta.toString(),
              observedDebtRaw: postDebt.toString(),
              observedCollateralRaw: postCol.toString(),
              error: `Loop Delever transaction landed but verification failed (${verify.reason}). Recorded on-chain observed amounts — check the position.`,
            };
          }
          await persistHolding(postDebt, postCol, post.oraclePriceUsd, "loop_delever_onchain");
          await storage.updateBorrowOperation(opId, {
            status: "succeeded",
            step: "final_read",
            result: {
              signature: exec.signature,
              solReturnedLamports: solDelta.toString(),
              observedDebtRaw: postDebt.toString(),
              observedCollateralRaw: postCol.toString(),
            },
          });
          await recordLoopEquityEvent({
            walletAddress,
            eventType: "loop_delever_hold",
            amountLamports: solDelta,
            txSignature: exec.signature ?? null,
            notes: `Delever ${cfg.collateralSymbol} Loop to Hold: repaid ${lamportsToSol(liveDebt)} SOL debt, ${lamportsToSol(solDelta)} SOL returned`,
          });
          return {
            success: true,
            signature: exec.signature,
            solReturnedLamports: solDelta.toString(),
            observedDebtRaw: postDebt.toString(),
            observedCollateralRaw: postCol.toString(),
          };
        }

        // Atomic tx confirmed (repay MAX + exact withdraw are IN it) but the
        // post-read failed: debt IS cleared and collateral reduced by exactly
        // the withdrawn amount, by construction — record deterministically.
        const deterministicCol = liveCol - withdrawRaw;
        await persistHolding(0n, deterministicCol, null, "loop_delever_unverified");
        await storage.updateBorrowOperation(opId, {
          status: "succeeded",
          step: "delever_unverified",
          result: { signature: exec.signature, solReturnedLamports: solDelta.toString(), unverified: true },
        });
        await recordLoopEquityEvent({
          walletAddress,
          eventType: "loop_delever_hold",
          amountLamports: solDelta,
          txSignature: exec.signature ?? null,
          notes: `Delever ${cfg.collateralSymbol} Loop to Hold: repaid ${lamportsToSol(liveDebt)} SOL debt, ${lamportsToSol(solDelta)} SOL returned`,
        });
        return {
          success: true,
          signature: exec.signature,
          solReturnedLamports: solDelta.toString(),
          observedDebtRaw: "0",
          observedCollateralRaw: deterministicCol.toString(),
          verifyWarning: "Delever confirmed but the final position read failed — recorded deterministic amounts (atomic tx repaid MAX).",
        };
      }

      // AMBIGUOUS: probe whether the debt actually cleared.
      const probe = await borrowRoute.readLoopLivePositionHealth(vaultId, nftId).catch(() => null);
      if (probe && BigInt(probe.debtRaw) <= DEFAULT_SOL_DEBT_DUST_RAW && BigInt(probe.collateralRaw) > DEFAULT_LST_COLLATERAL_DUST_RAW) {
        const postDebt = BigInt(probe.debtRaw);
        const postCol = BigInt(probe.collateralRaw);
        await persistHolding(postDebt, postCol, probe.oraclePriceUsd, "loop_delever_ambiguous_landed");
        await storage.updateBorrowOperation(opId, {
          status: "succeeded",
          step: "delever_ambiguous_but_landed",
          result: {
            signature: exec.signature,
            solDeltaUnknown: true,
            observedDebtRaw: postDebt.toString(),
            observedCollateralRaw: postCol.toString(),
          },
        });
        return {
          success: true,
          signature: exec.signature,
          observedDebtRaw: postDebt.toString(),
          observedCollateralRaw: postCol.toString(),
          verifyWarning: "Delever landed (debt cleared on-chain) but the returned SOL amount could not be measured.",
        };
      }
      if (probe) {
        await failOp(opId, "delever_ambiguous_not_landed", `sig ${exec.signature} unconfirmed; live debt unchanged.`);
        return { success: false, signature: exec.signature, error: "Loop Delever could not be confirmed and the position still carries debt on-chain. Retry." };
      }
      await failOp(opId, "delever_ambiguous_unreadable", `sig ${exec.signature} unconfirmed; live read unreadable.`);
      return {
        success: false,
        signature: exec.signature,
        error: "Loop Delever result is unknown (confirmation and position read both failed). Recorded amounts are unchanged — retry shortly; an already-landed delever is detected automatically.",
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await failOp(opId, "unexpected_error", msg);
      return { success: false, error: `Loop Delever failed: ${msg}` };
    }
  });
}

// --- RE-LEVER (HOLD -> LEVERED, allocation tick) --------------------------------

export interface LoopReleverParams {
  walletAddress: string;
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  borrowPositionId: string;
  /**
   * Target leverage. OMIT for the normal path: the executor derives the
   * DYNAMIC target (live vault LT + min open health buffer + caps, positive
   * carry required) — same function the allocation brain uses. An explicit
   * value (e.g. the brain passing its own computed target) is still bounded
   * by the caps and fully policy-gated.
   */
  leverage?: number;
  slippageBps?: number;
  clientRequestId?: string;
  /** Why the policy loop chose LEVERED (persisted to the row + decision journal). */
  policyReason?: string;
}

export interface LoopReleverResult {
  success: boolean;
  signature?: string;
  observedDebtRaw?: string;
  observedCollateralRaw?: string;
  policyReasons?: LoopPolicyReason[];
  /** True when the position was already in the target state on-chain — state stamped WITHOUT a transaction (no signature by design). */
  selfHeal?: boolean;
  verifyWarning?: string;
  error?: string;
  gasShortfall?: LoopGasShortfall;
}

/**
 * Return a HOLD position (debt cleared, collateral supplied) to leverage L on
 * the SAME position NFT. Atomic sandwich, identical to the open's but with NO
 * principal transfer leg — the equity is already supplied as LST:
 *   flash-borrow F = equity x (L-1) WSOL -> swap F to LST -> operate
 *   (deposit minOut LST + borrow F against the position) -> flash payback.
 * LEVERAGE-INCREASING: this path IS gated by `evaluateLoopOpenRequest`
 * (depeg band / borrow APR ceiling / utilization), unlike the deleverage
 * reflex which must never be blocked. Fails closed on every unreadable input.
 */
export async function executeLoopRelever(params: LoopReleverParams): Promise<LoopReleverResult> {
  const { walletAddress, agentPublicKey, agentSecretKey, borrowPositionId } = params;
  const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const policyReason = (params.policyReason || "carry_positive").slice(0, 200);

  const loadedRes = await loadOpenLoopPosition(walletAddress, borrowPositionId);
  if (!loadedRes.ok) return { success: false, error: loadedRes.error };
  const { vaultId } = loadedRes.loaded;

  const vaultPolicy = LOOP_VAULT_ALLOWLIST[vaultId];
  if (!vaultPolicy) return { success: false, error: `Vault ${vaultId} is not on the loop launch allowlist.` };

  const borrowRoute = new JupiterLendBorrowRoute();
  const cfg = await borrowRoute.getLoopVaultConfig(vaultId);
  if (!cfg) return { success: false, error: `Could not read loop vault ${vaultId} config — refusing (fail closed).` };
  if (cfg.debtMint !== WSOL_MINT) {
    return { success: false, error: `Vault ${vaultId} does not borrow WSOL — refusing.` };
  }

  // DYNAMIC leverage (same function + same rate table as the open path and
  // the allocation brain). Explicit values stay bounded by BOTH caps.
  let stakingApyForGate: number | null = null;
  let leverage: number;
  {
    const rateRes = await resolveFreshLoopRate(vaultId);
    stakingApyForGate = rateRes?.stakingApy ?? null;
    if (typeof params.leverage === "number") {
      leverage = params.leverage;
    } else {
      const target = computeLoopTargetLeverage({
        vaultId,
        liquidationThreshold: cfg.liquidationThreshold,
        stakingApy: rateRes?.stakingApy ?? null,
        borrowApr: cfg.borrowApr,
      });
      if (target.leverage === null) {
        return {
          success: false,
          error:
            target.reason === "carry_nonpositive"
              ? `Looping ${cfg.collateralSymbol} is not profitable right now — refusing to re-lever.`
              : `Cannot determine a safe leverage for ${cfg.collateralSymbol} right now (${target.reason ?? "inputs unreadable"}) — refusing (fail closed).`,
        };
      }
      leverage = target.leverage;
    }
  }
  const effectiveCap = Math.min(vaultPolicy.maxLeverage, LOOP_RISK_POLICY.hardCapLeverage);
  if (!Number.isFinite(leverage) || leverage <= 1 || leverage > effectiveCap) {
    return { success: false, error: `Re-lever leverage ${leverage} is outside (1, ${effectiveCap}].` };
  }

  return await withBorrowLock(borrowLockKey(walletAddress, null, vaultId), async () => {
    const relock = await loadOpenLoopPosition(walletAddress, borrowPositionId);
    if (!relock.ok) return { success: false, error: relock.error };
    const { pos, nftId } = relock.loaded;

    const connection = getServerConnection();
    const agentPubkey = new PublicKey(agentPublicKey);
    const wsolMintPk = new PublicKey(WSOL_MINT);
    const lstMintPk = new PublicKey(cfg.collateralMint);

    // LIVE state decides, never the row's policyState: a re-lever is valid
    // ONLY from a debt-free position (anything else is already levered or broken).
    const live = await borrowRoute.readLoopLivePositionHealth(vaultId, nftId);
    if (!live) return { success: false, error: "Loop Re-Lever: could not read the live position — refusing (fail closed). Retry shortly." };
    const liveDebt = BigInt(live.debtRaw);
    const liveCol = BigInt(live.collateralRaw);

    // Self-heal: debt already on-chain (a prior re-lever landed but we crashed
    // before recording it) — just stamp the LEVERED state, no transaction.
    if (liveDebt > DEFAULT_SOL_DEBT_DUST_RAW && liveCol > DEFAULT_LST_COLLATERAL_DUST_RAW) {
      const snapshot = buildLoopHealthSnapshot(cfg, liveCol, liveDebt, live.oraclePriceUsd, "loop_relever_selfheal");
      await storage.updateBorrowPosition(pos.id, {
        collateralAmountRaw: liveCol.toString(),
        debtAmountRaw: liveDebt.toString(),
        healthSnapshot: snapshot,
        healthAsOf: new Date(),
        healthSource: "loop_relever_selfheal",
        policyState: "levered",
        policyReason,
        policyStateChangedAt: new Date(),
      });
      try {
        await storage.createBorrowOperation({
          walletAddress,
          borrowPositionId: pos.id,
          operationType: "loop_relever",
          status: "succeeded",
          step: "already_levered_onchain",
          clientRequestId: params.clientRequestId ?? null,
          metadata: { kind: "loop", vaultId, nftId, selfHeal: true, policyReason },
        });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
      }
      return { success: true, selfHeal: true, verifyWarning: "The position already carries debt on-chain — marked levered without a transaction." };
    }
    if (liveCol <= DEFAULT_LST_COLLATERAL_DUST_RAW) {
      return { success: false, error: "Loop Re-Lever: the position holds no meaningful collateral on-chain — nothing to re-lever." };
    }

    // Pure sizing off the LIVE collateral at the venue's own operate price.
    const sized = computeLoopReleverAmounts(liveCol, live.oraclePriceUsd ?? NaN, leverage);
    if (!sized.ok) {
      return { success: false, error: `Loop Re-Lever refused (fail closed): ${sized.reason}.` };
    }
    const { flashLamports, equityLamports } = sized;
    const minBorrowRaw = BigInt(cfg.minimumBorrowingRaw || "0");
    if (flashLamports < minBorrowRaw) {
      return {
        success: false,
        error: `Re-lever borrow leg ${lamportsToSol(flashLamports)} SOL is below the vault minimum ${lamportsToSol(minBorrowRaw)} SOL — staying in hold.`,
      };
    }

    let opId: string;
    try {
      const op = await storage.createBorrowOperation({
        walletAddress,
        borrowPositionId: pos.id,
        operationType: "loop_relever",
        status: "pending",
        step: "initialized",
        clientRequestId: params.clientRequestId ?? null,
        metadata: {
          kind: "loop",
          vaultId,
          nftId,
          leverage,
          slippageBps,
          policyReason,
          liveCollateralRaw: liveCol.toString(),
          equityLamports: equityLamports.toString(),
          flashLamports: flashLamports.toString(),
        },
      });
      opId = op.id;
    } catch (e) {
      if (isUniqueViolation(e)) {
        return { success: false, error: "This re-lever was already submitted. Check its status before retrying." };
      }
      throw e;
    }

    try {
      const wsolAta = ataFor(agentPubkey, wsolMintPk);
      const lstAta = ataFor(agentPubkey, lstMintPk);
      const infos = await connection.getMultipleAccountsInfo([wsolAta, lstAta]);
      const prepIxs: TransactionInstruction[] = [];
      if (!infos[0]) prepIxs.push(ixCreateAtaIdempotent(agentPubkey, agentPubkey, wsolMintPk));
      if (!infos[1]) prepIxs.push(ixCreateAtaIdempotent(agentPubkey, agentPubkey, lstMintPk));

      // No NFT mint (existing position) and no principal leg — fees + ATA rent only.
      const gas = await ensureVaultGas({
        payingPublicKey: agentPublicKey,
        funderPublicKey: agentPublicKey,
        funderSecretKey: agentSecretKey,
        destMint: null,
        label: "Loop Re-Lever",
        extraRentLamports: prepIxs.length * ATA_RENT_LAMPORTS + LOOP_FEE_HEADROOM_LAMPORTS,
      });
      if (!gas.ok) {
        await failOp(opId, "gas_failed", gas.error || "insufficient SOL for fees");
        return {
          success: false,
          error: gas.error || "Loop Re-Lever: insufficient SOL for fees.",
          gasShortfall: {
            requiredLamports: gas.requiredLamports,
            heldLamports: gas.payerLamportsBefore + (gas.refilledLamports ?? 0) + (gas.fundedLamports ?? 0),
          },
        };
      }

      if (prepIxs.length > 0) {
        const prep = await executeAgentInstructionsConfirmOnly({
          agentPublicKey,
          agentSecretKey,
          instructions: [...cuIxs(PREP_CU_LIMIT), ...prepIxs],
          label: "Loop Re-Lever ATA prep",
        });
        if (!prep.success) {
          await failOp(opId, "ata_prep_failed", prep.error || "ATA prep tx did not confirm.");
          return { success: false, error: prep.error || "Loop Re-Lever: token account prep failed. Nothing was moved." };
        }
        await storage.updateBorrowOperation(opId, {
          step: "atas_prepared",
          ...(prep.signature ? { appendTxSignature: prep.signature } : {}),
        });
      } else {
        await storage.updateBorrowOperation(opId, { step: "atas_prepared" });
      }

      // Swap quote (WSOL -> LST) — its REAL market rate feeds the policy gate.
      const quote = await jupQuote(WSOL_MINT, cfg.collateralMint, flashLamports, slippageBps);
      const minOut = BigInt(quote.otherAmountThreshold);
      if (minOut <= 0n) {
        await failOp(opId, "quote_failed", "Swap quote returned a zero min-out.");
        return { success: false, error: "Loop Re-Lever: swap quote unusable. Nothing was moved." };
      }
      const outAmountNum = Number(quote.outAmount);
      const marketSolPerLst =
        Number.isFinite(outAmountNum) && outAmountNum > 0 ? Number(flashLamports) / outAmountNum : null;

      // Policy gate — leverage-increasing, so the SAME gate as a fresh open
      // (depeg band, borrow APR ceiling, utilization). Fail closed on unreadables.
      const decision = evaluateLoopOpenRequest({
        vaultId,
        requestedLeverage: leverage,
        principalLamports: equityLamports,
        stakePoolSolPerLst: cfg.oraclePriceOperateUsd,
        marketSolPerLst,
        borrowApr: cfg.borrowApr,
        utilization: cfg.withdrawUtilization,
        stakingApy: stakingApyForGate,
        liquidationThreshold: cfg.liquidationThreshold,
      });
      if (!decision.allowed) {
        const denyMsgs = decision.reasons.filter((r) => r.severity === "deny").map((r) => r.message);
        await failOp(opId, "policy_denied", denyMsgs.join(" | ") || "Loop policy denied the re-lever.");
        return {
          success: false,
          policyReasons: decision.reasons,
          error: `Loop Re-Lever blocked by risk policy: ${denyMsgs.join(" ")}`,
        };
      }

      const swapResp = await jupSwapIxs(quote, agentPublicKey);
      if ((swapResp.setupInstructions || []).length > 0) {
        await failOp(opId, "swap_setup_ixs", `Swap returned ${swapResp.setupInstructions.length} setup ix(s).`);
        return { success: false, error: "Loop Re-Lever: swap route needs extra account setup — aborted. Retry shortly." };
      }
      if (!swapResp.swapInstruction) {
        await failOp(opId, "swap_ix_missing", "Swap response carried no swapInstruction.");
        return { success: false, error: "Loop Re-Lever: swap instructions unavailable. Nothing was moved." };
      }

      const flash = await import("@jup-ag/lend/flashloan");
      const borrowMod = await import("@jup-ag/lend/borrow");
      const BN = (await import("bn.js")).default;
      const { borrowIx, paybackIx } = await flash.getFlashloanIx({
        amount: new BN(flashLamports.toString()),
        asset: wsolMintPk,
        signer: agentPubkey,
        connection,
      });
      // Same shape as an open, on the EXISTING position NFT: deposit the
      // swapped LST floor + borrow the flash leg against it.
      const plan = planLoopOpen({
        lstCollateralRaw: minOut,
        wsolDebtRaw: flashLamports,
        positionId: nftId,
      });
      const operate = await borrowMod.getOperateIx({
        vaultId,
        positionId: plan.positionId,
        colAmount: specToBN(BN, plan.colAmount, "col", borrowMod.MAX_WITHDRAW_AMOUNT, borrowMod.MAX_REPAY_AMOUNT),
        debtAmount: specToBN(BN, plan.debtAmount, "debt", borrowMod.MAX_WITHDRAW_AMOUNT, borrowMod.MAX_REPAY_AMOUNT),
        connection,
        signer: agentPubkey,
      });

      // Atomic sandwich — NO principal transfer/syncNative: the flash borrow
      // funds the WSOL ATA, operate's borrow leg funds the payback.
      const instructions: TransactionInstruction[] = [
        ...cuIxs(LOOP_CU_LIMIT),
        borrowIx,
        deserializeJupIx(swapResp.swapInstruction),
        ...operate.ixs,
        paybackIx,
      ];
      const alts = [
        ...(await loadAlts(connection, swapResp.addressLookupTableAddresses || [])),
        ...(operate.addressLookupTableAccounts || []),
      ];

      const exec = await executeAgentInstructionsConfirmOnly({
        agentPublicKey,
        agentSecretKey,
        instructions,
        addressLookupTables: alts,
        label: "Loop Re-Lever",
        onBeforeBroadcast: async (info) => {
          const updated = await storage.updateBorrowOperation(opId, {
            step: "loop_sig_writeahead",
            appendTxSignature: info.signature,
            mergeMetadata: { blockhash: info.blockhash, lastValidBlockHeight: info.lastValidBlockHeight },
          });
          if (!updated) throw new Error("write-ahead signature persist failed — refusing to broadcast");
        },
      });

      if (exec.onChainFailed || (!exec.success && !exec.signature)) {
        // Atomic on-chain failure or never broadcast: position unchanged (still HOLD).
        await failOp(opId, exec.onChainFailed ? "tx_failed_onchain" : "exec_failed", exec.error || "Loop re-lever tx failed.");
        return { success: false, signature: exec.signature, error: exec.error || "Loop Re-Lever failed — the position is unchanged." };
      }

      const persistLevered = async (
        postDebt: bigint,
        postCol: bigint,
        oraclePriceUsd: number | null,
        source: string,
      ): Promise<void> => {
        const snapshot = buildLoopHealthSnapshot(cfg, postCol, postDebt, oraclePriceUsd, source);
        await storage.updateBorrowPosition(pos.id, {
          collateralAmountRaw: postCol.toString(),
          debtAmountRaw: postDebt.toString(),
          healthSnapshot: snapshot,
          healthAsOf: new Date(),
          healthSource: source,
          policyState: "levered",
          policyReason,
          policyStateChangedAt: new Date(),
        });
      };
      const equityNote = `Re-Lever ${cfg.collateralSymbol} Loop: borrowed ${lamportsToSol(flashLamports)} SOL at ${leverage}x`;

      if (exec.success) {
        const post = await borrowRoute.readLoopLivePositionHealth(vaultId, nftId).catch(() => null);
        if (post) {
          const postDebt = BigInt(post.debtRaw);
          const postCol = BigInt(post.collateralRaw);
          const verify = verifyLoopReleverOutcome({
            preColRaw: liveCol,
            flashDebtRaw: flashLamports,
            minCollateralAddRaw: minOut,
            observedDebtRaw: postDebt,
            observedColRaw: postCol,
          });
          if (!verify.ok) {
            // Fail closed: do NOT stamp LEVERED. Persist the on-chain truth loudly.
            const snapshot = buildLoopHealthSnapshot(cfg, postCol, postDebt, post.oraclePriceUsd, "loop_relever_verify_failed");
            await storage.updateBorrowPosition(pos.id, {
              collateralAmountRaw: postCol.toString(),
              debtAmountRaw: postDebt.toString(),
              healthSnapshot: snapshot,
              healthAsOf: new Date(),
              healthSource: "loop_relever_verify_failed",
            });
            await failOp(opId, "relever_verify_failed", `verify: ${verify.reason}`);
            return {
              success: false,
              signature: exec.signature,
              observedDebtRaw: postDebt.toString(),
              observedCollateralRaw: postCol.toString(),
              error: `Loop Re-Lever transaction landed but verification failed (${verify.reason}). Recorded on-chain observed amounts — check the position.`,
            };
          }
          await persistLevered(postDebt, postCol, post.oraclePriceUsd, "loop_relever_onchain");
          await storage.updateBorrowOperation(opId, {
            status: "succeeded",
            step: "final_read",
            result: {
              signature: exec.signature,
              observedDebtRaw: postDebt.toString(),
              observedCollateralRaw: postCol.toString(),
            },
          });
          await recordLoopEquityEvent({
            walletAddress,
            eventType: "loop_relever",
            amountLamports: flashLamports,
            txSignature: exec.signature ?? null,
            notes: equityNote,
          });
          return {
            success: true,
            signature: exec.signature,
            observedDebtRaw: postDebt.toString(),
            observedCollateralRaw: postCol.toString(),
          };
        }

        // Atomic tx confirmed (exact deposit minOut floor + exact borrow flash
        // are IN it) but the post-read failed — record deterministically.
        const deterministicCol = liveCol + minOut;
        await persistLevered(flashLamports, deterministicCol, null, "loop_relever_unverified");
        await storage.updateBorrowOperation(opId, {
          status: "succeeded",
          step: "relever_unverified",
          result: { signature: exec.signature, unverified: true },
        });
        await recordLoopEquityEvent({
          walletAddress,
          eventType: "loop_relever",
          amountLamports: flashLamports,
          txSignature: exec.signature ?? null,
          notes: equityNote,
        });
        return {
          success: true,
          signature: exec.signature,
          observedDebtRaw: flashLamports.toString(),
          observedCollateralRaw: deterministicCol.toString(),
          verifyWarning: "Re-lever confirmed but the final position read failed — recorded deterministic amounts (atomic tx).",
        };
      }

      // AMBIGUOUS: probe whether the debt actually appeared.
      const probe = await borrowRoute.readLoopLivePositionHealth(vaultId, nftId).catch(() => null);
      if (probe && BigInt(probe.debtRaw) > DEFAULT_SOL_DEBT_DUST_RAW && BigInt(probe.collateralRaw) > DEFAULT_LST_COLLATERAL_DUST_RAW) {
        const postDebt = BigInt(probe.debtRaw);
        const postCol = BigInt(probe.collateralRaw);
        await persistLevered(postDebt, postCol, probe.oraclePriceUsd, "loop_relever_ambiguous_landed");
        await storage.updateBorrowOperation(opId, {
          status: "succeeded",
          step: "relever_ambiguous_but_landed",
          result: {
            signature: exec.signature,
            observedDebtRaw: postDebt.toString(),
            observedCollateralRaw: postCol.toString(),
          },
        });
        await recordLoopEquityEvent({
          walletAddress,
          eventType: "loop_relever",
          amountLamports: postDebt,
          txSignature: exec.signature ?? null,
          notes: equityNote,
        });
        return {
          success: true,
          signature: exec.signature,
          observedDebtRaw: postDebt.toString(),
          observedCollateralRaw: postCol.toString(),
          verifyWarning: "Re-lever landed (debt live on-chain) but confirmation was not observed directly.",
        };
      }
      if (probe) {
        await failOp(opId, "relever_ambiguous_not_landed", `sig ${exec.signature} unconfirmed; live debt still clear.`);
        return { success: false, signature: exec.signature, error: "Loop Re-Lever could not be confirmed and the position is still debt-free on-chain. It stays in hold; the next tick may retry." };
      }
      await failOp(opId, "relever_ambiguous_unreadable", `sig ${exec.signature} unconfirmed; live read unreadable.`);
      return {
        success: false,
        signature: exec.signature,
        error: "Loop Re-Lever result is unknown (confirmation and position read both failed). Recorded amounts are unchanged — an already-landed re-lever is detected automatically on retry.",
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await failOp(opId, "unexpected_error", msg);
      return { success: false, error: `Loop Re-Lever failed: ${msg}` };
    }
  });
}
