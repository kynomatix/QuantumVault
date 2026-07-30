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
    // WO2A hop single-flight / finalize surface
    claimLoopHopOpenAttempt: vi.fn(),
    clearLoopHopActiveChild: vi.fn(),
    finalizeLoopHopParent: vi.fn(),
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
  // WO2A budgets — REAL values so budget-gate behavior matches production.
  LOOP_HOP_RECOVERY_POLICY: { maxAutomaticPostCloseAgeMs: 6 * 60 * 60 * 1000, maxOpenBroadcastAttempts: 3 },
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
import { buildLoopSafetyInputs } from "../../server/vault/loop/loop-safety-tick";
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

  it("historical exec_failed requires an explicit exact signature and never gets keyless fallback", () => {
    expect(
      pickOpenTxSig(makeOpenOp({
        sigs: [ATA_PREP_SIG, OPEN_SIG],
        meta: { openTxSignature: OPEN_SIG },
        step: "exec_failed",
      })),
    ).toBe(OPEN_SIG);
    expect(pickOpenTxSig(makeOpenOp({ sigs: [OPEN_SIG], meta: {}, step: "exec_failed" }))).toBeNull();
    expect(
      pickOpenTxSig(makeOpenOp({ sigs: [OTHER_SIG], meta: { openTxSignature: OPEN_SIG }, step: "exec_failed" })),
    ).toBeNull();
  });

  it("wrong steps fail closed — including 'atas_prepared' where the ONLY sig is the ATA-prep tx", () => {
    // The exact bug class: an atas_prepared record's last sig IS the ATA-prep
    // sig. Promoting it to main-open identity would verify the WRONG tx.
    expect(pickOpenTxSig(makeOpenOp({ sigs: [ATA_PREP_SIG], step: "atas_prepared" }))).toBeNull();
    for (const step of ["initialized", "final_read", "tx_failed_onchain", "unexpected_error"]) {
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

  it("bug-shaped fresh failed/exec_failed reopens the actual failed row after strict live verification", async () => {
    const op = makeOpenOp({
      sigs: [ATA_PREP_SIG, OPEN_SIG],
      meta: openMeta({ openTxSignature: OPEN_SIG }),
      step: "exec_failed",
      status: "failed",
    });
    const conn = connWith({ statuses: [{ confirmationStatus: "finalized" }] });
    const route = stubRoute();
    route.readLoopLivePositionHealth.mockResolvedValue({
      collateralRaw: "5800000000",
      debtRaw: "4000000000",
      oraclePriceUsd: 1,
    });
    const out = await reconcileAmbiguousLoopOpen({
      op,
      position: makePendingRow({ status: "failed" }),
      walletAddress: WALLET,
      connection: conn,
      borrowRoute: route,
    });
    expect(out.outcome).toBe("finalized_open");
    expect(conn.getSignatureStatuses).toHaveBeenCalledWith([OPEN_SIG], { searchTransactionHistory: true });
    expect(storage.updateBorrowPosition).toHaveBeenCalledWith(
      "row-1",
      expect.objectContaining({ status: "open" }),
      "failed",
    );
    expect(storage.createEquityEvent).toHaveBeenCalledTimes(1);
    expect(storage.updateBorrowPosition).not.toHaveBeenCalledWith("row-1", { status: "failed" }, "pending");
  });

  it("bug-shaped exec_failed also repairs a pending row when the old restore CAS never landed", async () => {
    const op = makeOpenOp({
      sigs: [OPEN_SIG],
      meta: openMeta({ openTxSignature: OPEN_SIG }),
      step: "exec_failed",
      status: "failed",
    });
    const route = stubRoute();
    route.readLoopLivePositionHealth.mockResolvedValue({
      collateralRaw: "5800000000",
      debtRaw: "4000000000",
      oraclePriceUsd: 1,
    });
    const out = await reconcileAmbiguousLoopOpen({
      op,
      position: makePendingRow(),
      walletAddress: WALLET,
      connection: connWith({ statuses: [{ confirmationStatus: "finalized" }] }),
      borrowRoute: route,
    });
    expect(out.outcome).toBe("finalized_open");
    expect(storage.updateBorrowPosition).toHaveBeenCalledWith(
      "row-1",
      expect.objectContaining({ status: "open" }),
      "pending",
    );
    expect(storage.createEquityEvent).toHaveBeenCalledTimes(1);
  });

  it("bug-shaped reused exec_failed reopens the actual zeroed closed row from exact signature plus strict live truth", async () => {
    const op = makeOpenOp({
      sigs: [ATA_PREP_SIG, OPEN_SIG],
      meta: openMeta({ openTxSignature: OPEN_SIG, reuseNftId: 777 }),
      step: "exec_failed",
      status: "failed",
    });
    const route = stubRoute();
    route.readLoopLivePositionHealth.mockResolvedValue({
      collateralRaw: "5800000000",
      debtRaw: "4000000000",
      oraclePriceUsd: 1,
    });
    const row = {
      ...makePendingRow({ status: "closed" }),
      collateralAmountRaw: "0",
      debtAmountRaw: "0",
    };
    const out = await reconcileAmbiguousLoopOpen({
      op,
      position: row,
      walletAddress: WALLET,
      connection: connWith({ statuses: [{ confirmationStatus: "finalized" }] }),
      borrowRoute: route,
    });
    expect(out.outcome).toBe("finalized_open");
    expect(storage.updateBorrowPosition).toHaveBeenCalledWith(
      "row-1",
      expect.objectContaining({
        status: "open",
        collateralAmountRaw: "5800000000",
        debtAmountRaw: "4000000000",
      }),
      "closed",
    );
    expect(storage.createEquityEvent).toHaveBeenCalledTimes(1);
  });

  it("bug-shaped restored row stays closed when the live position is unreadable", async () => {
    const op = makeOpenOp({
      sigs: [OPEN_SIG],
      meta: openMeta({ openTxSignature: OPEN_SIG, reuseNftId: 777 }),
      step: "exec_failed",
      status: "failed",
    });
    const row = {
      ...makePendingRow({ status: "closed" }),
      collateralAmountRaw: "0",
      debtAmountRaw: "0",
    };
    const out = await reconcileAmbiguousLoopOpen({
      op,
      position: row,
      walletAddress: WALLET,
      connection: connWith({ statuses: [{ confirmationStatus: "finalized" }] }),
      borrowRoute: stubRoute(),
    });
    expect(out.outcome).toBe("blocked");
    expect(storage.updateBorrowPosition).not.toHaveBeenCalled();
    expect(storage.createEquityEvent).not.toHaveBeenCalled();
  });

  it("proven-dead bug-shaped reuse adopts an already-zeroed closed row idempotently", async () => {
    const op = makeOpenOp({
      sigs: [OPEN_SIG],
      meta: openMeta({
        openTxSignature: OPEN_SIG,
        lastValidBlockHeight: 1000,
        reuseNftId: 777,
      }),
      step: "exec_failed",
      status: "failed",
    });
    const row = {
      ...makePendingRow({ status: "closed" }),
      collateralAmountRaw: "0",
      debtAmountRaw: "0",
    };
    const out = await reconcileAmbiguousLoopOpen({
      op,
      position: row,
      walletAddress: WALLET,
      connection: connWith({ statuses: [null], height: 2000 }),
      borrowRoute: stubRoute(),
    });
    expect(out.outcome).toBe("restored");
    expect(storage.updateBorrowPosition).not.toHaveBeenCalled();
    expect(storage.updateBorrowOperation).toHaveBeenCalledWith("open-op-1", {
      step: "reconciled_tx_expired",
    });
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
        // WO2A: recent proven-close time — keeps the automatic budget gate
        // OPEN for these WO1 scenarios (parking is covered in
        // loop-hop-recovery.test.ts).
        closeDoneAt: new Date(Date.now() - 60_000).toISOString(),
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

  beforeEach(() => {
    // WO2A machinery defaults for the legacy WO1 scenarios.
    // Phase-2 head re-reads the parent row by id — without it every hop
    // resumes as "record could not be re-read".
    vi.mocked(storage.getBorrowOperationById as any).mockImplementation(async (id: string) =>
      id === "hop-op-1" ? hopOp() : undefined,
    );
    // Fresh attempts go through the atomic slot claim; the legacy child
    // (:open:1) was already reconciled by Phase 2a, so a new claim numbers 2.
    vi.mocked(storage.claimLoopHopOpenAttempt as any).mockImplementation(
      async (_opId: string, vaultId: number) => ({
        adopted: false,
        activeOpenClientRequestId: `${HOP_CRID}:open:2`,
        activeOpenVaultId: vaultId,
        openAttempts: 2,
      }),
    );
    vi.mocked(storage.clearLoopHopActiveChild as any).mockResolvedValue(true);
    vi.mocked(storage.finalizeLoopHopParent as any).mockImplementation(
      async (_id: string, _guard: any, patch: any) => ({
        ...hopOp(),
        status: patch.status,
        step: patch.step ?? "close_done",
        result: patch.result ?? null,
      }),
    );
  });

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
    // Parent terminalized from the child's ORIGINAL records — via the WO2A
    // CAS finalize (a rival that finalized first must win, never two writes).
    expect(storage.finalizeLoopHopParent).toHaveBeenCalledWith(
      "hop-op-1",
      expect.anything(), // CAS guard
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

  it("WO1-C1: adoption accounting uses the CHILD's persisted leverage + slippage — never this retry's values", async () => {
    // Child persisted leverage 2 / slippage 30bps; the resumed hop context
    // carries slippage 50bps (and would default target leverage differently).
    wireHop(
      makeOpenOp({
        id: "child-1",
        sigs: [OPEN_SIG],
        meta: openMeta({ openTxSignature: OPEN_SIG, principalLamports: "1900000000", leverage: 2, slippageBps: 30 }),
        step: "final_read",
        status: "succeeded",
        borrowPositionId: "newrow-1",
        clientRequestId: childCrid,
        result: { signature: OPEN_SIG },
      }),
    );

    const res = await executeLoopHop(hopParams);

    expect(res.success).toBe(true);
    // predicted = round((2×30bps)/10000 × 2.0 SOL × lev 2) + realized(0.1 SOL)
    //           = 24_000_000 + 100_000_000. With the retry's 50bps it would
    //           be 140_000_000 — the child's own persisted values must win.
    expect(res.predictedCostLamports).toBe("124000000");
    expect(res.realizedCostLamports).toBe("100000000");
    expect(storage.finalizeLoopHopParent).toHaveBeenCalledWith(
      "hop-op-1",
      expect.anything(), // CAS guard
      expect.objectContaining({
        result: expect.objectContaining({
          adoptedFromChildRecovery: true,
          predictedCostLamports: "124000000",
          realizedCostLamports: "100000000",
        }),
      }),
    );
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
  });

  it("WO1-C1: malformed durable child leverage AND slippage → parent RESUMABLE, never guessed-succeeded, zero broadcasts", async () => {
    wireHop(
      makeOpenOp({
        id: "child-1",
        sigs: [OPEN_SIG],
        meta: openMeta({
          openTxSignature: OPEN_SIG,
          principalLamports: "1900000000",
          leverage: "banana",
          slippageBps: "nope",
        }),
        step: "final_read",
        status: "succeeded",
        borrowPositionId: "newrow-1",
        clientRequestId: childCrid,
        result: { signature: OPEN_SIG },
      }),
    );

    const res = await executeLoopHop(hopParams);

    expect(res.success).toBe(false);
    expect((res as any).resumable).toBe(true);
    expect(res.error).toMatch(/unreadable|refusing/);
    const succeededWrites = vi
      .mocked(storage.updateBorrowOperation as any)
      .mock.calls.filter((c: unknown[]) => c[0] === "hop-op-1" && (c[1] as any)?.status === "succeeded");
    expect(succeededWrites).toHaveLength(0);
    expect(storage.finalizeLoopHopParent).not.toHaveBeenCalled(); // WO2A: no CAS finalize either
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
    expect(storage.createBorrowOperation).not.toHaveBeenCalled();
  });

  it("WO1-C1: MISSING durable child slippage → parent RESUMABLE (no fallback to the retry's slippage)", async () => {
    const meta = openMeta({ openTxSignature: OPEN_SIG, principalLamports: "1900000000", leverage: 2 });
    delete (meta as any).slippageBps;
    wireHop(
      makeOpenOp({
        id: "child-1",
        sigs: [OPEN_SIG],
        meta,
        step: "final_read",
        status: "succeeded",
        borrowPositionId: "newrow-1",
        clientRequestId: childCrid,
        result: { signature: OPEN_SIG },
      }),
    );

    const res = await executeLoopHop(hopParams);

    expect(res.success).toBe(false);
    expect((res as any).resumable).toBe(true);
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
  });

  it("WO1-C1: NEGATIVE durable child leverage or slippage → parent RESUMABLE, zero broadcasts", async () => {
    const childOf = (metaOverrides: Record<string, unknown>) =>
      makeOpenOp({
        id: "child-1",
        sigs: [OPEN_SIG],
        meta: openMeta({ openTxSignature: OPEN_SIG, principalLamports: "1900000000", ...metaOverrides }),
        step: "final_read",
        status: "succeeded",
        borrowPositionId: "newrow-1",
        clientRequestId: childCrid,
        result: { signature: OPEN_SIG },
      });

    wireHop(childOf({ leverage: -2, slippageBps: 30 }));
    const negLev = await executeLoopHop(hopParams);
    expect(negLev.success).toBe(false);
    expect((negLev as any).resumable).toBe(true);

    wireHop(childOf({ leverage: 2, slippageBps: -5 }));
    const negSlip = await executeLoopHop(hopParams);
    expect(negSlip.success).toBe(false);
    expect((negSlip as any).resumable).toBe(true);

    const succeededWrites = vi
      .mocked(storage.updateBorrowOperation as any)
      .mock.calls.filter((c: unknown[]) => c[0] === "hop-op-1" && (c[1] as any)?.status === "succeeded");
    expect(succeededWrites).toHaveLength(0);
    expect(storage.finalizeLoopHopParent).not.toHaveBeenCalled(); // WO2A: no CAS finalize either
    expect(executeAgentInstructionsConfirmOnly).not.toHaveBeenCalled();
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
    expect(storage.finalizeLoopHopParent).toHaveBeenCalledWith(
      "hop-op-1",
      expect.anything(), // CAS guard
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
    // WO2A: stateful parent CAS — the SECOND finalize must LOSE (row already
    // terminal) and the loser must report the winner's durable truth.
    let parentState: any = hopOp();
    vi.mocked(storage.getBorrowOperationById as any).mockImplementation(async () => parentState);
    vi.mocked(storage.finalizeLoopHopParent as any).mockImplementation(
      async (_id: string, _guard: any, patch: any) => {
        if (parentState.status !== "pending") return undefined; // CAS loss
        parentState = {
          ...parentState,
          status: patch.status,
          step: patch.step ?? parentState.step,
          result: patch.result ?? null,
        };
        return parentState;
      },
    );
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

  /**
   * WO1-C1 harness: FULL pipeline with STATEFUL op/row stores so a first call
   * and a later retry see each other's durable writes exactly like the DB.
   * The exec mock runs the real write-ahead hook, then reports success with
   * the exact main-open signature.
   */
  function wireStatefulOpenLifecycle() {
    const conn = wirePipeline();
    let opState: any = null;
    let rowState: any = null;
    let throwOpenCasOnce = false;
    vi.mocked(storage.createBorrowOperation as any).mockImplementation(async (rec: any) => {
      opState = {
        ...makeOpenOp({ sigs: [], meta: rec.metadata ?? openMeta(), step: rec.step ?? "initialized" }),
        status: "pending",
        borrowPositionId: null,
        clientRequestId: rec.clientRequestId ?? null,
      };
      return opState;
    });
    vi.mocked(storage.createBorrowPosition as any).mockImplementation(async () => {
      rowState = makePendingRow();
      return rowState;
    });
    vi.mocked(storage.updateBorrowOperation as any).mockImplementation(async (id: string, patch: any) => {
      if (!opState || id !== opState.id) return { id };
      if (patch.status) opState.status = patch.status;
      if (patch.step) opState.step = patch.step;
      if (patch.error) opState.error = patch.error;
      if (patch.result) opState.result = patch.result;
      if (Object.prototype.hasOwnProperty.call(patch, "borrowPositionId")) opState.borrowPositionId = patch.borrowPositionId;
      if (patch.appendTxSignature) opState.txSignatures = [...(opState.txSignatures ?? []), patch.appendTxSignature];
      if (patch.mergeMetadata) opState.metadata = { ...(opState.metadata ?? {}), ...patch.mergeMetadata };
      return opState;
    });
    vi.mocked(storage.updateBorrowPosition as any).mockImplementation(
      async (id: string, patch: any, expected?: string) => {
        if (throwOpenCasOnce && patch?.status === "open") {
          throwOpenCasOnce = false;
          throw new Error("finalize CAS write lost DB");
        }
        if (!rowState || id !== rowState.id) return null;
        if (expected && rowState.status !== expected) return null;
        rowState = { ...rowState, ...patch };
        return rowState;
      },
    );
    vi.mocked(storage.getBorrowOperationById as any).mockImplementation(async (id: string) =>
      opState && id === opState.id ? opState : undefined,
    );
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockImplementation(
      async (_w: string, crid: string) => (opState && opState.clientRequestId === crid ? opState : null),
    );
    vi.mocked(storage.getBorrowPositions as any).mockImplementation(async () => (rowState ? [rowState] : []));
    vi.mocked(storage.getBorrowOperations as any).mockImplementation(async () => (opState ? [opState] : []));
    vi.mocked(storage.getBorrowPosition as any).mockImplementation(async (_w: string, id: string) =>
      rowState && id === rowState.id ? rowState : null,
    );
    vi.mocked(executeAgentInstructionsConfirmOnly as any).mockImplementation(async (args: any) => {
      await args.onBeforeBroadcast?.({ signature: OPEN_SIG, blockhash: "bh", lastValidBlockHeight: 999_999 });
      return { success: true, signature: OPEN_SIG, onChainFailed: false };
    });
    return {
      conn,
      get op() {
        return opState;
      },
      get row() {
        return rowState;
      },
      armFinalizeCasThrow() {
        throwOpenCasOnce = true;
      },
    };
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

  it("WO1-C1 fail closed: op reload fails → row stays pending AND the op's step/provenance are NEVER overwritten", async () => {
    wirePipeline({ altThrows: true });
    vi.mocked(storage.getBorrowOperationById as any).mockRejectedValue(new Error("db read down"));

    const res = await executeLoopOpen(openParams);

    expect(res.success).toBe(false);
    expect(storage.updateBorrowPosition).not.toHaveBeenCalledWith("row-1", { status: "failed" }, "pending");
    // An UNPROVEN durable record is untouched — a later retry must be able to
    // classify the ORIGINAL step + signature evidence.
    const failWrites = vi
      .mocked(storage.updateBorrowOperation as any)
      .mock.calls.filter((c: unknown[]) => c[0] === "open-op-1" && (c[1] as any)?.status === "failed");
    expect(failWrites).toHaveLength(0);
  });

  it("WO1-C2 fail closed: reloaded op carries write-ahead evidence → op row NEVER mutated (no failed/step/error write), row stays pending", async () => {
    wirePipeline({ altThrows: true });
    vi.mocked(storage.getBorrowOperationById as any).mockResolvedValue(
      makeOpenOp({ sigs: [OPEN_SIG], meta: openMeta({ openTxSignature: OPEN_SIG }), step: "loop_sig_writeahead" }),
    );

    const res = await executeLoopOpen(openParams);

    expect(res.success).toBe(false);
    expect(storage.updateBorrowPosition).not.toHaveBeenCalledWith("row-1", { status: "failed" }, "pending");
    // WO1-C2: the borrow lock is only an IN-PROCESS serializer — a sibling
    // deployment may finalize this op concurrently, so the catch must not
    // write the op row AT ALL: no failed status, no error-only update.
    const catchSideWrites = vi
      .mocked(storage.updateBorrowOperation as any)
      .mock.calls.filter(
        (c: unknown[]) =>
          c[0] === "open-op-1" &&
          ((c[1] as any)?.status === "failed" || (c[1] as any)?.error !== undefined),
      );
    expect(catchSideWrites).toHaveLength(0);
    // …and the generic step never touches an evidence-bearing record.
    expect(storage.updateBorrowOperation).not.toHaveBeenCalledWith(
      "open-op-1",
      expect.objectContaining({ step: "unexpected_error" }),
    );
  });

  it("WO1-C1 regression: write-ahead persisted → finalize throws → retry reconciles the ORIGINAL row, NO second broadcast", async () => {
    const s = wireStatefulOpenLifecycle();
    s.armFinalizeCasThrow();

    const first = await executeLoopOpen(openParams);

    // The failure preserved the selector-eligible provenance verbatim.
    expect(first.success).toBe(false);
    expect(first.error).toMatch(/finalize CAS write lost DB/);
    expect(s.op.step).toBe("loop_sig_writeahead");
    // WO1-C2: the catch leaves the evidence-bearing op row COMPLETELY
    // untouched — still pending, no failed write anywhere.
    expect(s.op.status).toBe("pending");
    const failedWrites = vi
      .mocked(storage.updateBorrowOperation as any)
      .mock.calls.filter((c: unknown[]) => (c[1] as any)?.status === "failed");
    expect(failedWrites).toHaveLength(0);
    expect(s.op.metadata.openTxSignature).toBe(OPEN_SIG);
    expect(s.op.txSignatures[s.op.txSignatures.length - 1]).toBe(OPEN_SIG);
    expect(s.row.status).toBe("pending"); // never restored while the tx may land
    expect(executeAgentInstructionsConfirmOnly).toHaveBeenCalledTimes(1);

    // Later retry: the exact written-ahead signature is now CONFIRMED.
    s.conn.getSignatureStatuses.mockResolvedValue({ value: [{ confirmationStatus: "finalized" }] });
    const retry = await executeLoopOpen(openParams);

    expect(retry.success).toBe(true);
    expect(retry.signature).toBe(OPEN_SIG);
    expect(s.row.status).toBe("open"); // ORIGINAL row finalized
    expect(s.op.status).toBe("succeeded");
    expect(executeAgentInstructionsConfirmOnly).toHaveBeenCalledTimes(1); // ZERO rebroadcasts
    expect(storage.createBorrowPosition).toHaveBeenCalledTimes(1); // no second row
    expect(storage.createEquityEvent).toHaveBeenCalledTimes(1);
  });

  it("WO1-C2 sibling-interleaving: catch reload sees pending write-ahead, sibling finalizes succeeded BEFORE any catch write → terminal result untouched", async () => {
    const s = wireStatefulOpenLifecycle();
    s.armFinalizeCasThrow();
    const SIBLING_RESULT = { signature: OPEN_SIG, borrowPositionId: "row-1", finalizedBy: "sibling-deploy" };
    // The catch's reload returns a STALE pending snapshot while the durable
    // truth flips to a sibling finalizer's succeeded terminal state before
    // any catch-side write could land (blue/green overlap — the borrow lock
    // is only an in-process serializer).
    vi.mocked(storage.getBorrowOperationById as any).mockImplementationOnce(async () => {
      const stale = JSON.parse(JSON.stringify(s.op)); // pending + write-ahead evidence
      s.op.status = "succeeded";
      s.op.step = "opened";
      s.op.result = SIBLING_RESULT;
      return stale;
    });

    const first = await executeLoopOpen(openParams);

    expect(first.success).toBe(false);
    // The sibling's terminal finalization is sacrosanct: no failed overwrite,
    // no step regression, result untouched.
    expect(s.op.status).toBe("succeeded");
    expect(s.op.step).toBe("opened");
    expect(s.op.result).toEqual(SIBLING_RESULT);
    const catchWrites = vi
      .mocked(storage.updateBorrowOperation as any)
      .mock.calls.filter(
        (c: unknown[]) => (c[1] as any)?.status === "failed" || (c[1] as any)?.error !== undefined,
      );
    expect(catchWrites).toHaveLength(0);
    expect(executeAgentInstructionsConfirmOnly).toHaveBeenCalledTimes(1);
  });

  it("WO1-C1: preserved provenance + still-valid then unverifiable status → retry stays BLOCKED, row pending, no restore", async () => {
    const s = wireStatefulOpenLifecycle();
    s.armFinalizeCasThrow();
    await executeLoopOpen(openParams);
    expect(s.op.step).toBe("loop_sig_writeahead");

    // still_valid: null status, height inside lvbh+30 window
    s.conn.getSignatureStatuses.mockResolvedValue({ value: [null] });
    s.conn.getBlockHeight.mockResolvedValue(1_000_009);
    const blocked1 = await executeLoopOpen(openParams);
    expect(blocked1.success).toBe(false);
    expect(blocked1.error).toMatch(/still unresolved/);

    // unverifiable: RPC failure
    s.conn.getSignatureStatuses.mockRejectedValue(new Error("rpc down"));
    const blocked2 = await executeLoopOpen(openParams);
    expect(blocked2.success).toBe(false);
    expect(blocked2.error).toMatch(/still unresolved/);

    expect(s.row.status).toBe("pending");
    expect(executeAgentInstructionsConfirmOnly).toHaveBeenCalledTimes(1); // never rebroadcast
  });

  it("WO1-C1: op reload FAILS after write-ahead → record untouched; NEXT retry classifies the original and recovers", async () => {
    const s = wireStatefulOpenLifecycle();
    s.armFinalizeCasThrow();
    // The outer catch's own reload fails ONCE (first classification attempt).
    vi.mocked(storage.getBorrowOperationById as any).mockImplementationOnce(async () => {
      throw new Error("db read down");
    });

    const first = await executeLoopOpen(openParams);

    expect(first.success).toBe(false);
    // Fail closed: NOTHING was written to the op — status still pending,
    // step + signature evidence exactly as the write-ahead hook left them.
    expect(s.op.status).toBe("pending");
    expect(s.op.step).toBe("loop_sig_writeahead");
    expect(s.op.metadata.openTxSignature).toBe(OPEN_SIG);
    expect(s.row.status).toBe("pending");

    // Recovery: reload works again and the signature is confirmed.
    s.conn.getSignatureStatuses.mockResolvedValue({ value: [{ confirmationStatus: "finalized" }] });
    const retry = await executeLoopOpen(openParams);

    expect(retry.success).toBe(true);
    expect(retry.signature).toBe(OPEN_SIG);
    expect(s.row.status).toBe("open");
    expect(executeAgentInstructionsConfirmOnly).toHaveBeenCalledTimes(1); // no rebroadcast
    expect(storage.createEquityEvent).toHaveBeenCalledTimes(1);
  });

  it("proven pre-hook failure: reloaded no-evidence op still restores through exec_failed", async () => {
    wirePipeline();
    vi.mocked(storage.getBorrowOperationById as any).mockResolvedValue(
      makeOpenOp({
        sigs: [],
        meta: openMeta(),
        step: "atas_prepared",
        status: "pending",
        borrowPositionId: "row-1",
      }),
    );
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

  it("signatureless helper result with a failed operation reload preserves the pending row and operation", async () => {
    wirePipeline();
    vi.mocked(executeAgentInstructionsConfirmOnly as any).mockResolvedValue({
      success: false,
      signature: undefined,
      onChainFailed: false,
      error: "preflight rejected",
    });
    vi.mocked(storage.getBorrowOperationById as any).mockRejectedValueOnce(new Error("operation reload down"));

    const res = await executeLoopOpen(openParams);

    expect(res.success).toBe(false);
    expect(res.borrowPositionId).toBe("row-1");
    expect(storage.updateBorrowPosition).not.toHaveBeenCalledWith("row-1", { status: "failed" }, "pending");
    const terminalWrites = vi.mocked(storage.updateBorrowOperation as any).mock.calls.filter(
      (call: any[]) => call[0] === "open-op-1" && call[1]?.status === "failed",
    );
    expect(terminalWrites).toHaveLength(0);
  });

  it.each([
    ["missing", undefined],
    ["wrong operation type", makeOpenOp({ operationType: "loop_close" })],
    ["wrong wallet", makeOpenOp({ walletAddress: "different-wallet" })],
    ["wrong position link", makeOpenOp({ borrowPositionId: "different-row" })],
  ])("signatureless helper result with a %s operation reload preserves the pending row", async (_case, reloaded) => {
    wirePipeline();
    vi.mocked(executeAgentInstructionsConfirmOnly as any).mockResolvedValue({
      success: false,
      signature: undefined,
      onChainFailed: false,
      error: "preflight rejected",
    });
    vi.mocked(storage.getBorrowOperationById as any).mockResolvedValueOnce(reloaded as any);

    const res = await executeLoopOpen(openParams);

    expect(res.success).toBe(false);
    expect(res.borrowPositionId).toBe("row-1");
    expect(storage.updateBorrowPosition).not.toHaveBeenCalledWith("row-1", { status: "failed" }, "pending");
    const terminalWrites = vi.mocked(storage.updateBorrowOperation as any).mock.calls.filter(
      (call: any[]) => call[0] === "open-op-1" && call[1]?.status === "failed",
    );
    expect(terminalWrites).toHaveLength(0);
  });

  it("defense-in-depth: signatureless result after persisted hook adopts exact landed tx without restore or rebroadcast", async () => {
    const s = wireStatefulOpenLifecycle();
    vi.mocked(executeAgentInstructionsConfirmOnly as any).mockImplementationOnce(async (args: any) => {
      await args.onBeforeBroadcast?.({ signature: OPEN_SIG, blockhash: "bh", lastValidBlockHeight: 999_999 });
      return { success: false, signature: undefined, onChainFailed: false, error: "legacy helper lost identity" };
    });
    s.conn.getSignatureStatuses.mockResolvedValue({ value: [{ confirmationStatus: "finalized", err: null }] });

    const res = await executeLoopOpen(openParams);

    expect(res.success).toBe(true);
    expect(res.signature).toBe(OPEN_SIG);
    expect(s.row.status).toBe("open");
    expect(s.op.status).toBe("succeeded");
    expect(s.op.metadata.minCollateralRaw).toBe("5800000000");
    expect(s.op.metadata.nftId).toBe(777);
    expect(executeAgentInstructionsConfirmOnly).toHaveBeenCalledTimes(1);
    expect(storage.createEquityEvent).toHaveBeenCalledTimes(1);
    expect(storage.updateBorrowPosition).not.toHaveBeenCalledWith("row-1", { status: "failed" }, "pending");

    // Acceptance-matrix row 8: invoke the real safety-tick selection boundary
    // with the exact recovered row. Restoring status=open is what makes the
    // live leveraged position visible to the 60-second safety reflex again.
    const safety = buildLoopSafetyInputs(
      [{
        row: s.row,
        health: {
          status: "available",
          healthFactor: 1.5,
          liveDebtRaw: "1000000000",
          band: "healthy",
        } as any,
      }],
      new Map(),
      { liquidationFloor: 1.05 } as any,
    );
    expect(safety.skipped).toEqual([]);
    expect(safety.candidates.map((candidate) => candidate.row.id)).toEqual(["row-1"]);
  });
});
