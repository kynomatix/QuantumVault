/**
 * tests/vault/loop-open-recovery.test.ts — Power Work Order 1 (F4/F5)
 *
 * Loop OPEN recovery foundation:
 *  A. pickOpenTxSig       — main-open tx identity selector (fail closed)
 *  B. verifyOpenTxLanded  — typed verdict incl. blockhash-expiry proof
 *  +  reconcileAmbiguousLoopOpen — verdict-driven repair (restore/finalize/block)
 *  D. executeLoopOpen recovery gate (SL-07: stuck pending row reconciled
 *     BEFORE fresh-open gates; op established by link/crid only)
 *  C. executeLoopHop Phase 2a child reconciliation (SL-10: completed child is
 *     adopted, never re-broadcast; ambiguous child resolved before a fresh
 *     numbered attempt)
 *  E. runOpen outer catch (SL-08: durable-state-gated row restore — repairs
 *     provably-pre-broadcast strands, keeps rows pending when the write-ahead
 *     recorded, fails closed when the op cannot be reloaded)
 *
 * Helper tests are pure / controlled; caller tests drive the REAL
 * executeLoopOpen / executeLoopHop with mocked storage, RPC, SDK, and fetch.
 */

import { describe, expect, it, vi, beforeEach, afterAll } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — hoisted before imports by vitest.
// borrow-engine-core stays REAL (pure math/planning); everything that touches
// the network, DB, or lock machinery is controlled here.
// ---------------------------------------------------------------------------

vi.mock("../../server/storage", () => ({
  storage: {
    getBorrowOperationByClientRequestId: vi.fn(),
    getBorrowOperationById: vi.fn(),
    getBorrowOperations: vi.fn(),
    getBorrowPosition: vi.fn(),
    getBorrowPositions: vi.fn(),
    createBorrowOperation: vi.fn(),
    updateBorrowOperation: vi.fn(),
    createBorrowPosition: vi.fn(),
    updateBorrowPosition: vi.fn(),
    createEquityEvent: vi.fn(),
  },
}));

vi.mock("../../server/agent-wallet", () => ({
  getServerConnection: vi.fn(),
  executeAgentInstructions: vi.fn(),
  executeAgentInstructionsConfirmOnly: vi.fn(),
  executeAgentSwap: vi.fn(),
  getAgentTokenBalanceRawStrict: vi.fn(),
  NATIVE_SOL_MINT: "So11111111111111111111111111111111111111112",
}));

vi.mock("../../server/vault/gas-funding", () => ({
  ensureVaultGas: vi.fn(),
}));

// REAL keyed-mutex semantics (not a passthrough): same-key sections are
// mutually exclusive, so (a) the parallel-retry test below actually exercises
// serialization, and (b) any nested same-key acquisition self-deadlocks into a
// visible vitest timeout — the exact production failure mode of the
// non-reentrant withBorrowLock.
vi.mock("../../server/vault/jupiter-lend-borrow-executor", () => {
  const chains = new Map<string, Promise<unknown>>();
  const withBorrowLock = vi.fn(async (key: string, fn: () => Promise<unknown>) => {
    const prev = chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    chains.set(
      key,
      prev.then(() => gate),
    );
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  });
  return {
    withBorrowLock,
    borrowLockKey: vi.fn((w: string, b: string | null, v: number | null) => `${w}:${b ?? ""}:${v ?? ""}`),
  };
});

vi.mock("../../server/vault/jupiter-lend-borrow-route", () => {
  const getLoopVaultConfig = vi.fn();
  const readLoopLivePositionHealth = vi.fn();
  class JupiterLendBorrowRoute {
    getLoopVaultConfig = getLoopVaultConfig;
    readLoopLivePositionHealth = readLoopLivePositionHealth;
  }
  return {
    JupiterLendBorrowRoute,
    WSOL_MINT: "So11111111111111111111111111111111111111112",
    __routeMocks: { getLoopVaultConfig, readLoopLivePositionHealth },
  };
});

vi.mock("../../server/vault/loop/loop-risk-policy", () => ({
  LOOP_VAULT_ALLOWLIST: { 47: { collateralSymbol: "JupSOL" }, 4: { collateralSymbol: "JitoSOL" } },
  LOOP_ALLOCATION_POLICY: { rateStalenessMs: 60_000, hopMinCarryGainApy: 0.005 },
  LOOP_RISK_POLICY: { maxLeverage: 4, minNetCarryApy: 0.005 },
  computeLoopTargetLeverage: vi.fn(),
  evaluateLoopOpenRequest: vi.fn(),
  recoverHopSolReturned: vi.fn(),
}));

vi.mock("../../server/vault/loop/loop-rate-oracle", () => ({
  getFreshLoopRates: vi.fn(),
  sampleAndPersistLoopRates: vi.fn(),
  netCarryAt: vi.fn(),
  pickBestLoopVault: vi.fn(),
  LOOP_RATE_REGISTRY: {},
}));

vi.mock("@jup-ag/lend/flashloan", () => ({
  getFlashloanIx: vi.fn(),
}));

vi.mock("@jup-ag/lend/borrow", () => ({
  getOperateIx: vi.fn(),
  MAX_WITHDRAW_AMOUNT: "MAX_WITHDRAW_SENTINEL",
  MAX_REPAY_AMOUNT: "MAX_REPAY_SENTINEL",
}));

// ---------------------------------------------------------------------------
// Imports (resolved after mocks above are applied)
// ---------------------------------------------------------------------------

import {
  pickOpenTxSig,
  verifyOpenTxLanded,
  reconcileAmbiguousLoopOpen,
  executeLoopOpen,
  executeLoopHop,
} from "../../server/vault/loop/loop-executor";
import { storage } from "../../server/storage";
import { getServerConnection, executeAgentInstructionsConfirmOnly } from "../../server/agent-wallet";
import { ensureVaultGas } from "../../server/vault/gas-funding";
import { withBorrowLock } from "../../server/vault/jupiter-lend-borrow-executor";
import { evaluateLoopOpenRequest } from "../../server/vault/loop/loop-risk-policy";
import { getFreshLoopRates, pickBestLoopVault } from "../../server/vault/loop/loop-rate-oracle";
import * as jlbr from "../../server/vault/jupiter-lend-borrow-route";
import { getFlashloanIx } from "@jup-ag/lend/flashloan";
import { getOperateIx } from "@jup-ag/lend/borrow";

const routeMocks = (jlbr as unknown as {
  __routeMocks: { getLoopVaultConfig: ReturnType<typeof vi.fn>; readLoopLivePositionHealth: ReturnType<typeof vi.fn> };
}).__routeMocks;

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const WSOL = "So11111111111111111111111111111111111111112";
const WALLET = "wallet-open-recovery";
const AGENT_PK = "11111111111111111111111111111111"; // valid base58 (system program)
const ATA_PREP_SIG = "openAtaPrepSig111111111111111111111111111111111111111";
const OPEN_SIG = "openMainSig11111111111111111111111111111111111111111111";
const OTHER_SIG = "openOtherSig1111111111111111111111111111111111111111111";

const CFG_47 = {
  vaultId: 47,
  collateralSymbol: "JupSOL",
  collateralMint: "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v",
  debtMint: WSOL,
  liquidationThreshold: 0.9,
  borrowApr: 0.03,
  minimumBorrowingRaw: "0",
  oraclePriceOperateUsd: 0.9,
  withdrawUtilization: 0.5,
};

function makeOpenOp({
  sigs,
  meta,
  step = "loop_sig_writeahead",
  status = "pending",
  id = "open-op-1",
  borrowPositionId = "row-1",
  clientRequestId = null as string | null,
  result = null as Record<string, unknown> | null,
}: {
  sigs: unknown[];
  meta?: Record<string, unknown>;
  step?: string;
  status?: string;
  id?: string;
  borrowPositionId?: string | null;
  clientRequestId?: string | null;
  result?: Record<string, unknown> | null;
}) {
  return {
    id,
    walletAddress: WALLET,
    operationType: "loop_open",
    status,
    step,
    borrowPositionId,
    clientRequestId,
    txSignatures: sigs,
    metadata: meta ?? null,
    result,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any;
}

/** Standard durable open metadata as written at op creation. */
function openMeta(extra?: Record<string, unknown>) {
  return {
    kind: "loop",
    vaultId: 47,
    collateralSymbol: "JupSOL",
    principalLamports: "2000000000",
    leverage: 3,
    slippageBps: 50,
    flashLamports: "4000000000",
    reuseNftId: null,
    ...(extra ?? {}),
  };
}

function makePendingRow({
  id = "row-1",
  vaultId = 47,
  nftId = "777",
  status = "pending",
}: { id?: string; vaultId?: number; nftId?: string; status?: string } = {}) {
  return {
    id,
    walletAddress: WALLET,
    status,
    kind: "loop",
    venueVaultId: String(vaultId),
    venuePositionId: nftId,
    collateralAmountRaw: "5800000000",
    debtAmountRaw: "4000000000",
  } as any;
}

function stubRoute() {
  return {
    getLoopVaultConfig: vi.fn().mockResolvedValue(CFG_47),
    readLoopLivePositionHealth: vi.fn().mockResolvedValue(null),
  } as any;
}

function connWith({
  statuses,
  height,
}: {
  statuses?: Array<{ confirmationStatus?: string; err?: unknown } | null> | Error;
  height?: number | Error;
}) {
  return {
    getSignatureStatuses: vi.fn(async () => {
      if (statuses instanceof Error) throw statuses;
      return { value: statuses ?? [null] };
    }),
    getBlockHeight: vi.fn(async () => {
      if (height instanceof Error) throw height;
      return height ?? 0;
    }),
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Safe defaults; individual tests override as needed.
  vi.mocked(storage.updateBorrowOperation as any).mockResolvedValue({ id: "op" });
  vi.mocked(storage.updateBorrowPosition as any).mockResolvedValue(makePendingRow());
  vi.mocked(storage.createEquityEvent as any).mockResolvedValue({});
  vi.mocked(storage.getBorrowPositions as any).mockResolvedValue([]);
  vi.mocked(storage.getBorrowOperations as any).mockResolvedValue([]);
  vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockResolvedValue(null);
  vi.mocked(storage.getBorrowOperationById as any).mockResolvedValue(null);
  vi.mocked(storage.getBorrowPosition as any).mockResolvedValue(null);
  vi.mocked(getFreshLoopRates as any).mockResolvedValue([]);
  vi.mocked(pickBestLoopVault as any).mockReturnValue(null);
  vi.mocked(evaluateLoopOpenRequest as any).mockReturnValue({ allowed: true, reasons: [] });
  vi.mocked(ensureVaultGas as any).mockResolvedValue({
    ok: true,
    requiredLamports: 2_340_000_000,
    payerLamportsBefore: 10_000_000_000,
    refilledLamports: 0,
    fundedLamports: 0,
  });
  routeMocks.getLoopVaultConfig.mockResolvedValue(null);
  routeMocks.readLoopLivePositionHealth.mockResolvedValue(null);
});

// ============================================================================
// A. pickOpenTxSig — pure, synchronous
// ============================================================================

describe("pickOpenTxSig", () => {
  it("legacy: no meta key, [ATA, open] — returns LAST sig (main open), never the ATA-prep", () => {
    expect(pickOpenTxSig(makeOpenOp({ sigs: [ATA_PREP_SIG, OPEN_SIG] }))).toBe(OPEN_SIG);
  });

  it("legacy: single sig — returns it", () => {
    expect(pickOpenTxSig(makeOpenOp({ sigs: [OPEN_SIG] }))).toBe(OPEN_SIG);
  });

  it("legacy: empty array — null (fail closed)", () => {
    expect(pickOpenTxSig(makeOpenOp({ sigs: [] }))).toBeNull();
  });

  it("legacy: null txSignatures — null", () => {
    expect(pickOpenTxSig({ step: "loop_sig_writeahead", txSignatures: null, metadata: null })).toBeNull();
  });

  it("legacy: malformed trailing entry — null, never skips back to an earlier string", () => {
    expect(pickOpenTxSig(makeOpenOp({ sigs: [OPEN_SIG, 42] }))).toBeNull();
    expect(pickOpenTxSig(makeOpenOp({ sigs: [OPEN_SIG, null] }))).toBeNull();
  });

  it("explicit: meta.openTxSignature matches last entry — returns it", () => {
    expect(
      pickOpenTxSig(makeOpenOp({ sigs: [ATA_PREP_SIG, OPEN_SIG], meta: { openTxSignature: OPEN_SIG } })),
    ).toBe(OPEN_SIG);
  });

  it("explicit: mismatch vs last entry — null (inconsistent record, fail closed)", () => {
    expect(
      pickOpenTxSig(makeOpenOp({ sigs: [ATA_PREP_SIG, OTHER_SIG], meta: { openTxSignature: OPEN_SIG } })),
    ).toBeNull();
  });

  it("explicit: empty/non-string key present — null, never falls through to the array", () => {
    expect(pickOpenTxSig(makeOpenOp({ sigs: [OPEN_SIG], meta: { openTxSignature: "" } }))).toBeNull();
    expect(
      pickOpenTxSig(makeOpenOp({ sigs: [OPEN_SIG], meta: { openTxSignature: 123 } as Record<string, unknown> })),
    ).toBeNull();
  });

  it("step 'open_ambiguous' is ACCEPTED (only reachable post-write-ahead with a signature)", () => {
    expect(
      pickOpenTxSig(makeOpenOp({ sigs: [OPEN_SIG], meta: { openTxSignature: OPEN_SIG }, step: "open_ambiguous" })),
    ).toBe(OPEN_SIG);
  });

  it("wrong steps fail closed — including 'atas_prepared' where the ONLY sig is the ATA-prep tx", () => {
    // The exact bug class: an atas_prepared record's last sig IS the ATA-prep
    // sig. Promoting it to main-open identity would verify the WRONG tx.
    expect(pickOpenTxSig(makeOpenOp({ sigs: [ATA_PREP_SIG], step: "atas_prepared" }))).toBeNull();
    for (const step of ["initialized", "final_read", "tx_failed_onchain", "exec_failed", "unexpected_error"]) {
      expect(pickOpenTxSig(makeOpenOp({ sigs: [OPEN_SIG], step }))).toBeNull();
    }
    expect(pickOpenTxSig({ step: null, txSignatures: [OPEN_SIG], metadata: null })).toBeNull();
  });
});

// ============================================================================
// B. verifyOpenTxLanded — async, controlled RPC
// ============================================================================

describe("verifyOpenTxLanded", () => {
  const waOp = (meta?: Record<string, unknown>) =>
    makeOpenOp({ sigs: [ATA_PREP_SIG, OPEN_SIG], meta: { openTxSignature: OPEN_SIG, ...(meta ?? {}) } });

  it("confirmed/finalized without error → landed; only the MAIN open sig is queried", async () => {
    const conn = connWith({ statuses: [{ confirmationStatus: "finalized" }] });
    expect(await verifyOpenTxLanded(waOp(), conn)).toBe("landed");
    expect(conn.getSignatureStatuses).toHaveBeenCalledWith([OPEN_SIG], { searchTransactionHistory: true });
    const conn2 = connWith({ statuses: [{ confirmationStatus: "confirmed" }] });
    expect(await verifyOpenTxLanded(waOp(), conn2)).toBe("landed");
  });

  it("status with err → onchain_failed (atomic tx ⇒ nothing moved)", async () => {
    const conn = connWith({ statuses: [{ confirmationStatus: "finalized", err: { InstructionError: [1, "x"] } }] });
    expect(await verifyOpenTxLanded(waOp(), conn)).toBe("onchain_failed");
  });

  it("'processed' → still_valid (not final enough to adopt, not proof of death)", async () => {
    const conn = connWith({ statuses: [{ confirmationStatus: "processed" }] });
    expect(await verifyOpenTxLanded(waOp(), conn)).toBe("still_valid");
  });

  it("null status + height within lastValidBlockHeight+buffer → still_valid", async () => {
    const conn = connWith({ statuses: [null], height: 1030 }); // lvbh 1000 + 30 buffer: NOT strictly past
    expect(await verifyOpenTxLanded(waOp({ lastValidBlockHeight: 1000 }), conn)).toBe("still_valid");
  });

  it("null status + height strictly past lastValidBlockHeight+buffer → expired", async () => {
    const conn = connWith({ statuses: [null], height: 1031 });
    expect(await verifyOpenTxLanded(waOp({ lastValidBlockHeight: 1000 }), conn)).toBe("expired");
    expect(conn.getBlockHeight).toHaveBeenCalled();
  });

  it("null status + string lastValidBlockHeight parses; missing/malformed lvbh → still_valid (expiry unprovable)", async () => {
    const conn = connWith({ statuses: [null], height: 5000 });
    expect(await verifyOpenTxLanded(waOp({ lastValidBlockHeight: "1000" }), conn)).toBe("expired");
    const connB = connWith({ statuses: [null], height: 5000 });
    expect(await verifyOpenTxLanded(waOp(), connB)).toBe("still_valid"); // no lvbh recorded
    expect(connB.getBlockHeight).not.toHaveBeenCalled();
    const connC = connWith({ statuses: [null], height: 5000 });
    expect(await verifyOpenTxLanded(waOp({ lastValidBlockHeight: "not-a-number" }), connC)).toBe("still_valid");
  });

  it("getSignatureStatuses throws → unverifiable", async () => {
    const conn = connWith({ statuses: new Error("RPC down") });
    expect(await verifyOpenTxLanded(waOp(), conn)).toBe("unverifiable");
  });

  it("getBlockHeight throws (after null status) → unverifiable, NOT expired", async () => {
    const conn = connWith({ statuses: [null], height: new Error("RPC down") });
    expect(await verifyOpenTxLanded(waOp({ lastValidBlockHeight: 1000 }), conn)).toBe("unverifiable");
  });

  it("malformed provenance → malformed with ZERO RPC calls", async () => {
    const conn = connWith({ statuses: [{ confirmationStatus: "finalized" }] });
    expect(await verifyOpenTxLanded(makeOpenOp({ sigs: [ATA_PREP_SIG], step: "atas_prepared" }), conn)).toBe(
      "malformed",
    );
    expect(
      await verifyOpenTxLanded(makeOpenOp({ sigs: [OTHER_SIG], meta: { openTxSignature: OPEN_SIG } }), conn),
    ).toBe("malformed");
    expect(conn.getSignatureStatuses).not.toHaveBeenCalled();
    expect(conn.getBlockHeight).not.toHaveBeenCalled();
  });
});

// ============================================================================
// reconcileAmbiguousLoopOpen — verdict-driven repair (direct unit)
// ============================================================================

describe("reconcileAmbiguousLoopOpen", () => {
  const FRESH_RESTORE: [string, Record<string, unknown>, string] = ["row-1", { status: "failed" }, "pending"];
  const REUSE_RESTORE: [string, Record<string, unknown>, string] = [
    "row-1",
    { status: "closed", collateralAmountRaw: "0", debtAmountRaw: "0" },
    "pending",
  ];

  it("dead-step op (tx_failed_onchain): re-runs the row restore → restored", async () => {
    const op = makeOpenOp({ sigs: [OPEN_SIG], meta: openMeta(), step: "tx_failed_onchain", status: "failed" });
    const out = await reconcileAmbiguousLoopOpen({
      op,
      position: makePendingRow(),
      walletAddress: WALLET,
      connection: connWith({}),
      borrowRoute: stubRoute(),
    });
    expect(out.outcome).toBe("restored");
    expect(storage.updateBorrowPosition).toHaveBeenCalledWith(...FRESH_RESTORE);
  });

  it("dead-step op with reuse metadata: restores to the reusable closed pool (zeroed)", async () => {
    const op = makeOpenOp({
      sigs: [],
      meta: openMeta({ reuseNftId: 777 }),
      step: "exec_failed",
      status: "failed",
    });
    const out = await reconcileAmbiguousLoopOpen({
      op,
      position: makePendingRow(),
      walletAddress: WALLET,
      connection: connWith({}),
      borrowRoute: stubRoute(),
    });
    expect(out.outcome).toBe("restored");
    expect(storage.updateBorrowPosition).toHaveBeenCalledWith(...REUSE_RESTORE);
  });

  it("restore CAS lost → blocked (never clobbers a row that moved on)", async () => {
    vi.mocked(storage.updateBorrowPosition as any).mockResolvedValue(null);
    const op = makeOpenOp({ sigs: [], meta: openMeta(), step: "exec_failed", status: "failed" });
    const out = await reconcileAmbiguousLoopOpen({
      op,
      position: makePendingRow(),
      walletAddress: WALLET,
      connection: connWith({}),
      borrowRoute: stubRoute(),
    });
    expect(out.outcome).toBe("blocked");
  });

  it("no write-ahead record (pending, step initialized) → restore + terminalize pre_broadcast_reconciled", async () => {
    const op = makeOpenOp({ sigs: [], meta: openMeta(), step: "initialized", status: "pending" });
    const conn = connWith({});
    const out = await reconcileAmbiguousLoopOpen({
      op,
      position: makePendingRow(),
      walletAddress: WALLET,
      connection: conn,
      borrowRoute: stubRoute(),
    });
    expect(out.outcome).toBe("restored");
    expect(storage.updateBorrowPosition).toHaveBeenCalledWith(...FRESH_RESTORE);
    expect(storage.updateBorrowOperation).toHaveBeenCalledWith(
      "open-op-1",
      expect.objectContaining({ status: "failed", step: "pre_broadcast_reconciled" }),
    );
    expect(conn.getSignatureStatuses).not.toHaveBeenCalled(); // never touched RPC
  });

  it("still_valid → blocked, row untouched", async () => {
    const op = makeOpenOp({ sigs: [OPEN_SIG], meta: openMeta({ openTxSignature: OPEN_SIG, lastValidBlockHeight: 1000 }) });
    const out = await reconcileAmbiguousLoopOpen({
      op,
      position: makePendingRow(),
      walletAddress: WALLET,
      connection: connWith({ statuses: [null], height: 1010 }),
      borrowRoute: stubRoute(),
    });
    expect(out.outcome).toBe("blocked");
    if (out.outcome === "blocked") expect(out.reason).toMatch(/may still land/);
    expect(storage.updateBorrowPosition).not.toHaveBeenCalled();
  });

  it("unverifiable → blocked, row untouched", async () => {
    const op = makeOpenOp({ sigs: [OPEN_SIG], meta: openMeta({ openTxSignature: OPEN_SIG }) });
    const out = await reconcileAmbiguousLoopOpen({
      op,
      position: makePendingRow(),
      walletAddress: WALLET,
      connection: connWith({ statuses: new Error("rpc") }),
      borrowRoute: stubRoute(),
    });
    expect(out.outcome).toBe("blocked");
    expect(storage.updateBorrowPosition).not.toHaveBeenCalled();
  });

  it("malformed provenance (write-ahead step, empty sigs) → blocked, row untouched", async () => {
    const op = makeOpenOp({ sigs: [], meta: openMeta({ lastValidBlockHeight: 1000 }) });
    const out = await reconcileAmbiguousLoopOpen({
      op,
      position: makePendingRow(),
      walletAddress: WALLET,
      connection: connWith({}),
      borrowRoute: stubRoute(),
    });
    expect(out.outcome).toBe("blocked");
    if (out.outcome === "blocked") expect(out.reason).toMatch(/malformed/);
    expect(storage.updateBorrowPosition).not.toHaveBeenCalled();
  });

  it("evidence-bearing unexpected_error op → blocked (selector stays strict; deliberate)", async () => {
    const op = makeOpenOp({
      sigs: [OPEN_SIG],
      meta: openMeta({ openTxSignature: OPEN_SIG }),
      step: "unexpected_error",
      status: "failed",
    });
    const out = await reconcileAmbiguousLoopOpen({
      op,
      position: makePendingRow(),
      walletAddress: WALLET,
      connection: connWith({}),
      borrowRoute: stubRoute(),
    });
    expect(out.outcome).toBe("blocked");
    expect(storage.updateBorrowPosition).not.toHaveBeenCalled();
  });

  it("onchain_failed → restore + reconciled_tx_failed_onchain (pending op → failOp)", async () => {
    const op = makeOpenOp({ sigs: [OPEN_SIG], meta: openMeta({ openTxSignature: OPEN_SIG }) });
    const out = await reconcileAmbiguousLoopOpen({
      op,
      position: makePendingRow(),
      walletAddress: WALLET,
      connection: connWith({ statuses: [{ confirmationStatus: "finalized", err: { ix: 1 } }] }),
      borrowRoute: stubRoute(),
    });
    expect(out.outcome).toBe("restored");
    expect(storage.updateBorrowPosition).toHaveBeenCalledWith(...FRESH_RESTORE);
    expect(storage.updateBorrowOperation).toHaveBeenCalledWith(
      "open-op-1",
      expect.objectContaining({ status: "failed", step: "reconciled_tx_failed_onchain" }),
    );
  });

  it("expired → restore + reconciled_tx_expired; already-failed op gets a step breadcrumb only", async () => {
    const op = makeOpenOp({
      sigs: [OPEN_SIG],
      meta: openMeta({ openTxSignature: OPEN_SIG, lastValidBlockHeight: 1000 }),
      step: "open_ambiguous",
      status: "failed",
    });
    const out = await reconcileAmbiguousLoopOpen({
      op,
      position: makePendingRow(),
      walletAddress: WALLET,
      connection: connWith({ statuses: [null], height: 2000 }),
      borrowRoute: stubRoute(),
    });
    expect(out.outcome).toBe("restored");
    expect(storage.updateBorrowPosition).toHaveBeenCalledWith(...FRESH_RESTORE);
    // Breadcrumb: step only — must NOT flip status again or write an error.
    expect(storage.updateBorrowOperation).toHaveBeenCalledWith("open-op-1", { step: "reconciled_tx_expired" });
  });

  it("landed → finalizes from ORIGINAL durable values (CAS row open, op succeeded, equity event once)", async () => {
    const route = stubRoute();
    const row = makePendingRow();
    vi.mocked(storage.updateBorrowPosition as any).mockResolvedValue({ ...row, status: "open" });
    const op = makeOpenOp({ sigs: [ATA_PREP_SIG, OPEN_SIG], meta: openMeta({ openTxSignature: OPEN_SIG }) });
    const out = await reconcileAmbiguousLoopOpen({
      op,
      position: row,
      walletAddress: WALLET,
      connection: connWith({ statuses: [{ confirmationStatus: "finalized" }] }),
      borrowRoute: route,
    });
    expect(out.outcome).toBe("finalized_open");
    if (out.outcome === "finalized_open") {
      expect(out.result.success).toBe(true);
      expect(out.result.signature).toBe(OPEN_SIG);
      expect(out.result.borrowPositionId).toBe("row-1");
    }
    // Row CAS'd pending→open exactly once; op marked succeeded; ONE equity event.
    expect(storage.updateBorrowPosition).toHaveBeenCalledWith(
      "row-1",
      expect.objectContaining({ status: "open" }),
      "pending",
    );
    expect(storage.updateBorrowOperation).toHaveBeenCalledWith(
      "open-op-1",
      expect.objectContaining({ status: "succeeded" }),
    );
    expect(storage.createEquityEvent).toHaveBeenCalledTimes(1);
    expect(route.getLoopVaultConfig).toHaveBeenCalledWith(47);
  });

  it("landed but originals unreadable (missing principal) → blocked, ZERO finalize side effects", async () => {
    const meta = openMeta({ openTxSignature: OPEN_SIG });
    delete (meta as Record<string, unknown>).principalLamports;
    const op = makeOpenOp({ sigs: [OPEN_SIG], meta });
    const out = await reconcileAmbiguousLoopOpen({
      op,
      position: makePendingRow(),
      walletAddress: WALLET,
      connection: connWith({ statuses: [{ confirmationStatus: "confirmed" }] }),
      borrowRoute: stubRoute(),
    });
    expect(out.outcome).toBe("blocked");
    if (out.outcome === "blocked") expect(out.reason).toMatch(/LANDED/);
    expect(storage.updateBorrowPosition).not.toHaveBeenCalled();
    expect(storage.createEquityEvent).not.toHaveBeenCalled();
  });

  it("landed but row/vault cross-check fails → blocked (never finalizes into the wrong vault)", async () => {
    const op = makeOpenOp({ sigs: [OPEN_SIG], meta: openMeta({ openTxSignature: OPEN_SIG }) });
    const out = await reconcileAmbiguousLoopOpen({
      op,
      position: makePendingRow({ vaultId: 48 }), // row says 48, op says 47
      walletAddress: WALLET,
      connection: connWith({ statuses: [{ confirmationStatus: "confirmed" }] }),
      borrowRoute: stubRoute(),
    });
    expect(out.outcome).toBe("blocked");
    expect(storage.updateBorrowPosition).not.toHaveBeenCalled();
  });

  it("landed but vault config unreadable → blocked (finalize deferred, nothing written)", async () => {
    const route = stubRoute();
    route.getLoopVaultConfig.mockResolvedValue(null);
    const op = makeOpenOp({ sigs: [OPEN_SIG], meta: openMeta({ openTxSignature: OPEN_SIG }) });
    const out = await reconcileAmbiguousLoopOpen({
      op,
      position: makePendingRow(),
      walletAddress: WALLET,
      connection: connWith({ statuses: [{ confirmationStatus: "confirmed" }] }),
      borrowRoute: route,
    });
    expect(out.outcome).toBe("blocked");
    expect(storage.updateBorrowPosition).not.toHaveBeenCalled();
  });
});

// ============================================================================
// D. executeLoopOpen — F4 recovery gate (SL-07)
// ============================================================================

describe("executeLoopOpen — recovery gate", () => {
  const openParams = {
    walletAddress: WALLET,
    agentPublicKey: AGENT_PK,
    agentSecretKey: new Uint8Array(64),
    vaultId: 47,
    principalLamports: 2_000_000_000n,
    leverage: 3, // explicit → computeLoopTargetLeverage not needed
  };

  it("SL-07a: pending row with NO provable op → fail-closed refusal BEFORE any fresh-open gate", async () => {
    vi.mocked(storage.getBorrowPositions as any).mockResolvedValue([makePendingRow()]);
    vi.mocked(storage.getBorrowOperations as any).mockResolvedValue([]);

    const res = await executeLoopOpen(openParams);

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/still unresolved/);
    expect(res.error).toMatch(/never guessed/);
    // Blocked BEFORE the fresh-open pipeline: no config read, no gas, no op row.
    expect(routeMocks.getLoopVaultConfig).not.toHaveBeenCalled();
    expect(ensureVaultGas).not.toHaveBeenCalled();
    expect(storage.createBorrowOperation).not.toHaveBeenCalled();
    // …and the gate ran under the vault-scoped borrow lock.
    expect(withBorrowLock).toHaveBeenCalledWith(`${WALLET}::47`, expect.any(Function));
  });

  it("callerHoldsBorrowLock: gate runs INLINE — never re-acquires the non-reentrant lock", async () => {
    vi.mocked(storage.getBorrowPositions as any).mockResolvedValue([makePendingRow()]);
    vi.mocked(storage.getBorrowOperations as any).mockResolvedValue([]);

    const res = await executeLoopOpen({ ...openParams, callerHoldsBorrowLock: true });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/still unresolved/);
    expect(withBorrowLock).not.toHaveBeenCalled();
  });

  it("SL-07a: 2+ unresolved linked ops → blocked (never guesses which owns the row)", async () => {
    vi.mocked(storage.getBorrowPositions as any).mockResolvedValue([makePendingRow()]);
    vi.mocked(storage.getBorrowOperations as any).mockResolvedValue([
      makeOpenOp({ sigs: [], meta: openMeta(), step: "initialized", id: "a" }),
      makeOpenOp({ sigs: [], meta: openMeta(), step: "initialized", id: "b" }),
    ]);

    const res = await executeLoopOpen(openParams);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/2 unresolved operations/);
    expect(storage.updateBorrowPosition).not.toHaveBeenCalled();
  });

  it("still-valid broadcast window → blocked, row kept pending", async () => {
    vi.mocked(storage.getBorrowPositions as any).mockResolvedValue([makePendingRow()]);
    vi.mocked(storage.getBorrowOperations as any).mockResolvedValue([
      makeOpenOp({ sigs: [OPEN_SIG], meta: openMeta({ openTxSignature: OPEN_SIG, lastValidBlockHeight: 1000 }) }),
    ]);
    vi.mocked(getServerConnection as any).mockReturnValue(connWith({ statuses: [null], height: 1005 }));

    const res = await executeLoopOpen(openParams);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/may still land/);
    expect(storage.updateBorrowPosition).not.toHaveBeenCalled();
    expect(storage.createBorrowOperation).not.toHaveBeenCalled();
  });

  it("SL-07b: provably-never-broadcast op → row restored, THEN the fresh open proceeds", async () => {
    vi.mocked(storage.getBorrowPositions as any).mockResolvedValue([makePendingRow()]);
    vi.mocked(storage.getBorrowOperations as any).mockResolvedValue([
      makeOpenOp({ sigs: [], meta: openMeta(), step: "initialized", status: "pending" }),
    ]);
    // Fresh-open pipeline then hits the (mocked null) config read — proof the
    // gate released the flow instead of blocking.
    routeMocks.getLoopVaultConfig.mockResolvedValue(null);

    const res = await executeLoopOpen(openParams);

    expect(storage.updateBorrowPosition).toHaveBeenCalledWith("row-1", { status: "failed" }, "pending");
    expect(storage.updateBorrowOperation).toHaveBeenCalledWith(
      "open-op-1",
      expect.objectContaining({ status: "failed", step: "pre_broadcast_reconciled" }),
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Could not read loop vault 47 config/);
  });

  it("second retry after restore is a no-op gate pass (idempotent repair)", async () => {
    // First call: restore happens. Second call: no pending row remains.
    vi.mocked(storage.getBorrowPositions as any)
      .mockResolvedValueOnce([makePendingRow()])
      .mockResolvedValue([makePendingRow({ status: "failed" })]);
    vi.mocked(storage.getBorrowOperations as any).mockResolvedValue([
      makeOpenOp({ sigs: [], meta: openMeta(), step: "initialized", status: "pending" }),
    ]);
    routeMocks.getLoopVaultConfig.mockResolvedValue(null);

    await executeLoopOpen(openParams);
    await executeLoopOpen(openParams);

    const restoreCalls = vi
      .mocked(storage.updateBorrowPosition as any)
      .mock.calls.filter((c: unknown[]) => c[0] === "row-1" && (c[2] as string) === "pending");
    expect(restoreCalls).toHaveLength(1); // restored exactly once across both retries
  });

  it("idempotent crid retry of a LANDED attempt → adopts the durable result, no new attempt", async () => {
    const row = makePendingRow();
    vi.mocked(storage.getBorrowPositions as any).mockResolvedValue([row]);
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockResolvedValue(
      makeOpenOp({
        sigs: [OPEN_SIG],
        meta: openMeta({ openTxSignature: OPEN_SIG }),
        step: "final_read",
        status: "succeeded",
        clientRequestId: "crid-original",
        result: { signature: OPEN_SIG, observedCollateralRaw: "5800000000", observedDebtRaw: "4000000000" },
      }),
    );

    const res = await executeLoopOpen({ ...openParams, clientRequestId: "crid-original" });

    expect(res.success).toBe(true);
    expect(res.signature).toBe(OPEN_SIG);
    expect(res.borrowPositionId).toBe("row-1");
    expect(storage.createBorrowOperation).not.toHaveBeenCalled();
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
  });

  it("LANDED attempt reconciled under a DIFFERENT request → finalized + 'close it first' refusal", async () => {
    const row = makePendingRow();
    vi.mocked(storage.getBorrowPositions as any).mockResolvedValue([row]);
    vi.mocked(storage.getBorrowOperations as any).mockResolvedValue([
      makeOpenOp({
        sigs: [ATA_PREP_SIG, OPEN_SIG],
        meta: openMeta({ openTxSignature: OPEN_SIG }),
        clientRequestId: "someone-elses-crid",
      }),
    ]);
    vi.mocked(getServerConnection as any).mockReturnValue(
      connWith({ statuses: [{ confirmationStatus: "finalized" }] }),
    );
    routeMocks.getLoopVaultConfig.mockResolvedValue(CFG_47); // reconcile's finalize needs cfg
    vi.mocked(storage.updateBorrowPosition as any).mockResolvedValue({ ...row, status: "open" });

    const res = await executeLoopOpen(openParams);

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/actually LANDED/);
    expect(res.error).toMatch(/Close it/);
    // The stuck attempt WAS finalized (row open, op succeeded) — money truth restored.
    expect(storage.updateBorrowOperation).toHaveBeenCalledWith(
      "open-op-1",
      expect.objectContaining({ status: "succeeded" }),
    );
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled(); // never re-broadcast
  });

  it("pending row on a DIFFERENT vault does not trip the gate", async () => {
    vi.mocked(storage.getBorrowPositions as any).mockResolvedValue([makePendingRow({ id: "other", vaultId: 48 })]);
    routeMocks.getLoopVaultConfig.mockResolvedValue(null);

    const res = await executeLoopOpen(openParams);
    expect(res.error).toMatch(/Could not read loop vault 47 config/); // normal flow reached
    expect(storage.getBorrowOperations).not.toHaveBeenCalled();
  });
});

// ============================================================================
// C. executeLoopHop — Phase 2a child reconciliation (SL-10)
// ============================================================================

describe("executeLoopHop — child open reconciliation", () => {
  const HOP_CRID = "hop-crid-777";
  const SRC_POS = "src-pos-1";

  const hopOp = (metaExtra?: Record<string, unknown>) =>
    ({
      id: "hop-op-1",
      walletAddress: WALLET,
      operationType: "loop_hop",
      status: "pending",
      step: "close_done",
      borrowPositionId: SRC_POS,
      clientRequestId: HOP_CRID,
      txSignatures: [],
      result: null,
      error: null,
      metadata: {
        kind: "loop",
        fromVaultId: 4,
        toVaultId: 47,
        slippageBps: 50,
        sourceBorrowPositionId: SRC_POS,
        closeAttempts: 1,
        preCloseAgentLamports: "5000000000",
        solReturnedLamports: "2000000000",
        closeSignature: "hopCloseSig111111111111111111111111111111111111111",
        openAttempts: 1,
        ...(metaExtra ?? {}),
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as any;

  const hopParams = {
    walletAddress: WALLET,
    agentPublicKey: AGENT_PK,
    agentSecretKey: new Uint8Array(64),
    borrowPositionId: SRC_POS,
    targetVaultId: 47,
    clientRequestId: HOP_CRID,
  };

  const childCrid = `${HOP_CRID}:open:1`;

  function wireHop(child: any) {
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockImplementation(
      async (_w: string, crid: string) => {
        if (crid === HOP_CRID) return hopOp();
        if (crid === childCrid) return child;
        return null;
      },
    );
  }

  it("SL-10: completed child open + parent crash before 'opened' → ADOPT, zero broadcasts", async () => {
    wireHop(
      makeOpenOp({
        id: "child-1",
        sigs: [OPEN_SIG],
        meta: openMeta({ openTxSignature: OPEN_SIG, principalLamports: "1900000000" }),
        step: "final_read",
        status: "succeeded",
        borrowPositionId: "newrow-1",
        clientRequestId: childCrid,
        result: { signature: OPEN_SIG, observedCollateralRaw: "5510000000", observedDebtRaw: "3800000000" },
      }),
    );

    const res = await executeLoopHop(hopParams);

    expect(res.success).toBe(true);
    expect(res.borrowPositionId).toBe("newrow-1");
    expect(res.openSignature).toBe(OPEN_SIG);
    expect(res.solReturnedLamports).toBe("2000000000");
    expect(res.realizedCostLamports).toBe("100000000"); // 2.0 − 1.9 SOL overhead
    // Parent terminalized from the child's ORIGINAL records…
    expect(storage.updateBorrowOperation).toHaveBeenCalledWith(
      "hop-op-1",
      expect.objectContaining({
        status: "succeeded",
        step: "opened",
        borrowPositionId: "newrow-1",
        result: expect.objectContaining({
          adoptedFromChildRecovery: true,
          openSignature: OPEN_SIG,
          principalLamports: "1900000000",
          toVaultId: 47,
          reversed: false,
        }),
      }),
    );
    // …and NOTHING was broadcast or even sized: no preflight, no new op, no exec.
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
    expect(ensureVaultGas).not.toHaveBeenCalled();
    expect(storage.createBorrowOperation).not.toHaveBeenCalled();
  });

  it("ambiguous child whose tx LANDED → finalize child, then adopt (no re-open)", async () => {
    const child = makeOpenOp({
      id: "child-1",
      sigs: [OPEN_SIG],
      meta: openMeta({ openTxSignature: OPEN_SIG, principalLamports: "1900000000", lastValidBlockHeight: 999999 }),
      step: "loop_sig_writeahead",
      status: "pending",
      borrowPositionId: "newrow-1",
      clientRequestId: childCrid,
    });
    wireHop(child);
    const childRow = makePendingRow({ id: "newrow-1", vaultId: 47, nftId: "777" });
    vi.mocked(storage.getBorrowPosition as any).mockResolvedValue(childRow);
    vi.mocked(getServerConnection as any).mockReturnValue(
      connWith({ statuses: [{ confirmationStatus: "finalized" }] }),
    );
    routeMocks.getLoopVaultConfig.mockResolvedValue(CFG_47);
    vi.mocked(storage.updateBorrowPosition as any).mockResolvedValue({ ...childRow, status: "open" });

    const res = await executeLoopHop(hopParams);

    expect(res.success).toBe(true);
    expect(res.openSignature).toBe(OPEN_SIG);
    expect(res.borrowPositionId).toBe("newrow-1");
    // Child finalized (row open + child op succeeded), parent adopted.
    expect(storage.updateBorrowPosition).toHaveBeenCalledWith(
      "newrow-1",
      expect.objectContaining({ status: "open" }),
      "pending",
    );
    expect(storage.updateBorrowOperation).toHaveBeenCalledWith(
      "child-1",
      expect.objectContaining({ status: "succeeded" }),
    );
    expect(storage.updateBorrowOperation).toHaveBeenCalledWith(
      "hop-op-1",
      expect.objectContaining({ status: "succeeded", step: "opened" }),
    );
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
    // Reconciliation ran under the same vault-scoped lock the open gate uses.
    expect(withBorrowLock).toHaveBeenCalledWith(`${WALLET}::47`, expect.any(Function));
  });

  it("parallel retries on the same ambiguous LANDED child → ONE finalize, ONE equity event, both adopt", async () => {
    // Stateful child + row: the winner's terminal writes are visible to the
    // lock-waiter, exactly like the DB. Without Phase 2a locking, both racers
    // read the pending child and both attempt finalize (2 CAS attempts, and —
    // before the equity gating — 2 equity events).
    let childState: any = makeOpenOp({
      id: "child-1",
      sigs: [OPEN_SIG],
      meta: openMeta({ openTxSignature: OPEN_SIG, principalLamports: "1900000000", lastValidBlockHeight: 999999 }),
      step: "loop_sig_writeahead",
      status: "pending",
      borrowPositionId: "newrow-1",
      clientRequestId: childCrid,
    });
    let rowState: any = makePendingRow({ id: "newrow-1", vaultId: 47, nftId: "777" });
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockImplementation(
      async (_w: string, crid: string) => {
        if (crid === HOP_CRID) return hopOp();
        if (crid === childCrid) return childState;
        return null;
      },
    );
    vi.mocked(storage.getBorrowPosition as any).mockImplementation(async () => rowState);
    vi.mocked(storage.updateBorrowOperation as any).mockImplementation(async (id: string, patch: any) => {
      if (id === "child-1" && patch?.status === "succeeded") {
        childState = { ...childState, status: "succeeded", step: patch.step ?? childState.step, result: patch.result ?? null };
      }
      return { id };
    });
    vi.mocked(storage.updateBorrowPosition as any).mockImplementation(
      async (id: string, patch: any, expected?: string) => {
        if (id !== "newrow-1") return makePendingRow();
        if (expected && rowState.status !== expected) return null; // CAS
        rowState = { ...rowState, ...patch };
        return rowState;
      },
    );
    vi.mocked(getServerConnection as any).mockReturnValue(
      connWith({ statuses: [{ confirmationStatus: "finalized" }] }),
    );
    routeMocks.getLoopVaultConfig.mockResolvedValue(CFG_47);

    const [a, b] = await Promise.all([executeLoopHop(hopParams), executeLoopHop(hopParams)]);

    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(a.openSignature).toBe(OPEN_SIG);
    expect(b.openSignature).toBe(OPEN_SIG);
    // THE regression guards: exactly one pending→open CAS (the waiter adopted
    // the winner's terminal child instead of re-finalizing)…
    const casCalls = vi
      .mocked(storage.updateBorrowPosition as any)
      .mock.calls.filter((c: unknown[]) => c[0] === "newrow-1" && (c[2] as string) === "pending");
    expect(casCalls).toHaveLength(1);
    // …and exactly one loop_open equity event.
    expect(storage.createEquityEvent).toHaveBeenCalledTimes(1);
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
  });

  it("ambiguous child provably EXPIRED → restore child + terminalize it, then fresh attempt path continues", async () => {
    const child = makeOpenOp({
      id: "child-1",
      sigs: [OPEN_SIG],
      meta: openMeta({ openTxSignature: OPEN_SIG, lastValidBlockHeight: 1000 }),
      step: "loop_sig_writeahead",
      status: "pending",
      borrowPositionId: "newrow-1",
      clientRequestId: childCrid,
    });
    wireHop(child);
    vi.mocked(storage.getBorrowPosition as any).mockResolvedValue(makePendingRow({ id: "newrow-1" }));
    vi.mocked(getServerConnection as any).mockReturnValue(connWith({ statuses: [null], height: 2000 }));
    // Fresh-attempt preflight will fail on (mocked null) config → resumable.
    routeMocks.getLoopVaultConfig.mockResolvedValue(null);

    const res = await executeLoopHop(hopParams);

    // Child repaired + terminalized.
    expect(storage.updateBorrowPosition).toHaveBeenCalledWith("newrow-1", { status: "failed" }, "pending");
    expect(storage.updateBorrowOperation).toHaveBeenCalledWith(
      "child-1",
      expect.objectContaining({ status: "failed", step: "reconciled_tx_expired" }),
    );
    // Flow fell through to the fresh-attempt sizing (which failed benignly).
    expect(res.success).toBe(false);
    expect((res as any).resumable).toBe(true);
    expect(res.error).toMatch(/Could not size a re-loop|config/);
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
  });

  it("ambiguous child still unresolved (still_valid) → resumable, NO fresh attempt, NO restore", async () => {
    const child = makeOpenOp({
      id: "child-1",
      sigs: [OPEN_SIG],
      meta: openMeta({ openTxSignature: OPEN_SIG, lastValidBlockHeight: 1000 }),
      step: "loop_sig_writeahead",
      status: "pending",
      borrowPositionId: "newrow-1",
      clientRequestId: childCrid,
    });
    wireHop(child);
    vi.mocked(storage.getBorrowPosition as any).mockResolvedValue(makePendingRow({ id: "newrow-1" }));
    vi.mocked(getServerConnection as any).mockReturnValue(connWith({ statuses: [null], height: 1010 }));

    const res = await executeLoopHop(hopParams);

    expect(res.success).toBe(false);
    expect((res as any).resumable).toBe(true);
    expect(res.error).toMatch(/still unresolved/);
    expect(res.error).toMatch(/may still land/);
    expect(storage.updateBorrowPosition).not.toHaveBeenCalled();
    expect(ensureVaultGas).not.toHaveBeenCalled(); // fresh attempt never sized
    expect(storage.createBorrowOperation).not.toHaveBeenCalled();
  });

  it("counter ran ahead (openAttempts=1 but no child op) → fresh attempt is safe", async () => {
    wireHop(null); // child crid returns null
    routeMocks.getLoopVaultConfig.mockResolvedValue(null); // preflight fails benignly

    const res = await executeLoopHop(hopParams);

    expect(res.success).toBe(false);
    expect((res as any).resumable).toBe(true);
    expect(res.error).toMatch(/Could not size a re-loop|config/);
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
  });
});

// ============================================================================
// E. runOpen outer catch — durable-state-gated row restore (SL-08)
// ============================================================================

describe("executeLoopOpen — outer-catch lifecycle repair", () => {
  const ALT_ADDR = "SysvarRent111111111111111111111111111111111";
  const JUP_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

  const openParams = {
    walletAddress: WALLET,
    agentPublicKey: AGENT_PK,
    agentSecretKey: new Uint8Array(64),
    vaultId: 47,
    principalLamports: 2_000_000_000n,
    leverage: 3,
    clientRequestId: "e2e-open-1",
  };

  /** Wires the FULL pipeline up to instruction assembly. */
  function wirePipeline({ altThrows = false }: { altThrows?: boolean } = {}) {
    routeMocks.getLoopVaultConfig.mockResolvedValue(CFG_47);
    routeMocks.readLoopLivePositionHealth.mockResolvedValue(null); // reuse scan: nothing reusable
    const connection = {
      getMultipleAccountsInfo: vi.fn(async () => [{ owner: "x" }, { owner: "x" }]), // both ATAs exist
      getAddressLookupTable: altThrows
        ? vi.fn(async () => {
            throw new Error("ALT read failed");
          })
        : vi.fn(async () => ({ value: null })),
      getSignatureStatuses: vi.fn(),
      getBlockHeight: vi.fn(),
    };
    vi.mocked(getServerConnection as any).mockReturnValue(connection);
    vi.mocked(storage.createBorrowOperation as any).mockResolvedValue(
      makeOpenOp({ sigs: [], meta: openMeta(), step: "initialized" }),
    );
    vi.mocked(storage.createBorrowPosition as any).mockResolvedValue(makePendingRow());
    vi.mocked(getFlashloanIx as any).mockResolvedValue({
      borrowIx: { keys: [], programId: JUP_PROGRAM, data: Buffer.alloc(0) },
      paybackIx: { keys: [], programId: JUP_PROGRAM, data: Buffer.alloc(0) },
    });
    vi.mocked(getOperateIx as any).mockResolvedValue({
      nftId: "777",
      ixs: [],
      addressLookupTableAccounts: [],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        const payload = u.includes("/quote")
          ? { otherAmountThreshold: "5800000000", outAmount: "5900000000" }
          : {
              setupInstructions: [],
              swapInstruction: { programId: JUP_PROGRAM, accounts: [], data: "" },
              addressLookupTableAddresses: [ALT_ADDR],
            };
        return {
          ok: true,
          status: 200,
          json: async () => payload,
          text: async () => JSON.stringify(payload),
        } as any;
      }),
    );
    return connection;
  }

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("SL-08a: throw AFTER row create, pre-write-ahead (ALT load) → reloads op, proves no broadcast, restores row", async () => {
    wirePipeline({ altThrows: true });
    // Reload shows a pre-write-ahead record → restore is safe.
    vi.mocked(storage.getBorrowOperationById as any).mockResolvedValue(
      makeOpenOp({ sigs: [], meta: openMeta(), step: "atas_prepared" }),
    );

    const res = await executeLoopOpen(openParams);

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/ALT read failed/);
    expect(storage.getBorrowOperationById).toHaveBeenCalledWith("open-op-1");
    expect(storage.updateBorrowPosition).toHaveBeenCalledWith("row-1", { status: "failed" }, "pending");
    expect(storage.updateBorrowOperation).toHaveBeenCalledWith(
      "open-op-1",
      expect.objectContaining({ status: "failed", step: "unexpected_error" }),
    );
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
  });

  it("SL-08b: the op-row LINK write itself throws → row restored via in-memory lifecycle id", async () => {
    wirePipeline();
    vi.mocked(storage.updateBorrowOperation as any).mockImplementation(async (_id: string, patch: any) => {
      if (patch && Object.prototype.hasOwnProperty.call(patch, "borrowPositionId")) {
        throw new Error("link write lost DB");
      }
      return { id: "open-op-1" };
    });
    vi.mocked(storage.getBorrowOperationById as any).mockResolvedValue(
      makeOpenOp({ sigs: [], meta: openMeta(), step: "atas_prepared", borrowPositionId: null }),
    );

    const res = await executeLoopOpen(openParams);

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/link write lost DB/);
    // The row was NOT linked on the op, yet it still got restored (SL-08's point).
    expect(storage.updateBorrowPosition).toHaveBeenCalledWith("row-1", { status: "failed" }, "pending");
  });

  it("fail closed: op reload fails → row stays pending (no blind restore), op still terminalized", async () => {
    wirePipeline({ altThrows: true });
    vi.mocked(storage.getBorrowOperationById as any).mockRejectedValue(new Error("db read down"));

    const res = await executeLoopOpen(openParams);

    expect(res.success).toBe(false);
    expect(storage.updateBorrowPosition).not.toHaveBeenCalledWith("row-1", { status: "failed" }, "pending");
    expect(storage.updateBorrowOperation).toHaveBeenCalledWith(
      "open-op-1",
      expect.objectContaining({ status: "failed", step: "unexpected_error" }),
    );
  });

  it("fail closed: reloaded op carries write-ahead evidence → row is NOT restored", async () => {
    wirePipeline({ altThrows: true });
    vi.mocked(storage.getBorrowOperationById as any).mockResolvedValue(
      makeOpenOp({ sigs: [OPEN_SIG], meta: openMeta({ openTxSignature: OPEN_SIG }), step: "loop_sig_writeahead" }),
    );

    const res = await executeLoopOpen(openParams);

    expect(res.success).toBe(false);
    expect(storage.updateBorrowPosition).not.toHaveBeenCalledWith("row-1", { status: "failed" }, "pending");
  });

  it("regression: exec returns no-signature failure → existing exec_failed restore path unchanged", async () => {
    wirePipeline();
    vi.mocked(executeAgentInstructionsConfirmOnly as any).mockResolvedValue({
      success: false,
      onChainFailed: false,
      signature: undefined,
      error: "write-ahead signature persist failed — refusing to broadcast",
    });

    const res = await executeLoopOpen(openParams);

    expect(res.success).toBe(false);
    expect(storage.updateBorrowPosition).toHaveBeenCalledWith("row-1", { status: "failed" }, "pending");
    expect(storage.updateBorrowOperation).toHaveBeenCalledWith(
      "open-op-1",
      expect.objectContaining({ status: "failed", step: "exec_failed" }),
    );
  });
});
