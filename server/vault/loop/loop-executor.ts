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
import { storage } from "../../storage";
import { ensureVaultGas } from "../gas-funding";
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
  LOOP_ALLOCATION_POLICY,
  LOOP_RISK_POLICY,
  LOOP_VAULT_ALLOWLIST,
  type LoopPolicyReason,
} from "./loop-risk-policy";
import { getFreshLoopRates, sampleAndPersistLoopRates, LOOP_RATE_REGISTRY, type FreshLoopRate } from "./loop-rate-oracle";
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
      }
      await storage.updateBorrowOperation(opId, { borrowPositionId: position.id });

      // Restore helper for provably-nothing-moved failures.
      const restorePositionRow = async () => {
        try {
          if (reuseCandidate) {
            await storage.updateBorrowPosition(
              position.id,
              { status: "closed", collateralAmountRaw: "0", debtAmountRaw: "0" },
              "pending",
            );
          } else {
            await storage.updateBorrowPosition(position.id, { status: "failed" }, "pending");
          }
        } catch (e) {
          console.warn(`[loop-executor] could not restore position row ${position.id}:`, e);
        }
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
            mergeMetadata: { blockhash: info.blockhash, lastValidBlockHeight: info.lastValidBlockHeight },
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

  await recordLoopEquityEvent({
    walletAddress: p.walletAddress,
    eventType: "loop_open",
    amountLamports: p.principalLamports,
    txSignature: p.signature,
    notes: `Opened ${p.cfg.collateralSymbol} loop: ${lamportsToSol(p.principalLamports)} SOL principal at ${p.leverage}x`,
  });

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
            mergeMetadata: { blockhash: info.blockhash, lastValidBlockHeight: info.lastValidBlockHeight },
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
