/**
 * tests/vault/loop-hop-provenance.test.ts
 *
 * Covers the hop-close provenance helpers (pickCloseTxSig, verifyCloseTxLanded)
 * and — critically — the real executeLoopHop caller through the crash-resume
 * provenance path where the source position is already absent.
 *
 * Helper tests: pure / in-process, no network, no DB.
 * Caller tests: executeLoopHop with controlled storage and RPC stubs.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — hoisted before imports by vitest.
// Only the three modules actually invoked in the RESUME→provenance code path
// are mocked; everything else (borrow-engine-core, gas-funding, etc.) is
// left as the real module — consistent with existing tests that already import
// loop-executor without mocking.
// ---------------------------------------------------------------------------

vi.mock("../../server/storage", () => ({
  storage: {
    getBorrowOperationByClientRequestId: vi.fn(),
    getBorrowPosition: vi.fn(),
    updateBorrowOperation: vi.fn().mockResolvedValue({ id: "hop-op-id" }),
    createBorrowOperation: vi.fn(),
    getBorrowPositionsByWallet: vi.fn(),
    // WO2A surface: parent reload + single-flight slot + CAS finalize.
    getBorrowOperationById: vi.fn(),
    claimLoopHopOpenAttempt: vi.fn(),
    clearLoopHopActiveChild: vi.fn(),
    finalizeLoopHopParent: vi.fn(),
  },
}));

vi.mock("../../server/agent-wallet", () => ({
  getServerConnection: vi.fn(),
  NATIVE_SOL_MINT: "So11111111111111111111111111111111111111112",
  getAgentTokenBalanceRawStrict: vi.fn(),
  executeAgentInstructions: vi.fn(),
  executeAgentInstructionsConfirmOnly: vi.fn(),
  executeAgentSwap: vi.fn(),
}));

vi.mock("../../server/vault/loop/loop-risk-policy", () => ({
  // Target vault 47 is on the allowlist for caller tests.
  LOOP_VAULT_ALLOWLIST: { 47: { collateralSymbol: "JupSOL" } },
  LOOP_ALLOCATION_POLICY: { hopMinCarryGainApy: 0.005 },
  LOOP_RISK_POLICY: { maxLeverage: 4, minNetCarryApy: 0.005 },
  // WO2A budgets — REAL values so budget-gate behavior matches production.
  LOOP_HOP_RECOVERY_POLICY: { maxAutomaticPostCloseAgeMs: 6 * 60 * 60 * 1000, maxOpenBroadcastAttempts: 3 },
  computeLoopTargetLeverage: vi.fn(),
  evaluateLoopOpenRequest: vi.fn(),
  recoverHopSolReturned: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (resolved after mocks above are applied)
// ---------------------------------------------------------------------------

import {
  pickCloseTxSig,
  verifyCloseTxLanded,
  executeLoopHop,
} from "../../server/vault/loop/loop-executor";
import { storage } from "../../server/storage";
import { getServerConnection } from "../../server/agent-wallet";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const ATA_PREP_SIG = "ataPrepSig1111111111111111111111111111111111111111111111";
const CLOSE_SIG    = "closeSig111111111111111111111111111111111111111111111111";
const OTHER_SIG    = "otherSig111111111111111111111111111111111111111111111111";

function makeOp({
  sigs,
  meta,
  step = "loop_sig_writeahead",
}: {
  sigs: unknown[];
  meta?: Record<string, unknown>;
  step?: string;
}) {
  return {
    step,
    txSignatures: sigs,
    metadata: meta ?? null,
  };
}

function makeConnection(
  respondWith: (sigs: string[]) => Array<{ confirmationStatus?: string; err?: unknown } | null>,
) {
  return {
    getSignatureStatuses: vi.fn(async (sigs: string[]) => ({
      value: respondWith(sigs),
    })),
  };
}

// ============================================================================
// pickCloseTxSig — pure, synchronous
// ============================================================================

describe("pickCloseTxSig", () => {

  // --- Legacy path (no explicit meta key) -----------------------------------

  it("legacy: no meta key, two sigs — returns the LAST sig (close), not the first (ATA-prep)", () => {
    const op = makeOp({ sigs: [ATA_PREP_SIG, CLOSE_SIG] });
    expect(pickCloseTxSig(op)).toBe(CLOSE_SIG);
  });

  it("legacy: no meta key, single sig — returns that sig", () => {
    const op = makeOp({ sigs: [CLOSE_SIG] });
    expect(pickCloseTxSig(op)).toBe(CLOSE_SIG);
  });

  it("legacy: no meta key, empty array — null (malformed, fail closed)", () => {
    const op = makeOp({ sigs: [] });
    expect(pickCloseTxSig(op)).toBeNull();
  });

  it("legacy: no meta key, null txSignatures — null (malformed)", () => {
    const op = { step: "loop_sig_writeahead", txSignatures: null, metadata: null };
    expect(pickCloseTxSig(op)).toBeNull();
  });

  // Correction 1 requirement: do NOT filter through to an earlier string element;
  // a malformed trailing entry must fail closed.
  it("legacy: trailing entry is non-string (number) — null, does not fall back to earlier string", () => {
    const op = makeOp({ sigs: [CLOSE_SIG, 42] }); // number last
    expect(pickCloseTxSig(op)).toBeNull();
  });

  it("legacy: trailing entry is null — null, does not fall back to earlier string", () => {
    const op = makeOp({ sigs: [CLOSE_SIG, null] }); // null last
    expect(pickCloseTxSig(op)).toBeNull();
  });

  it("legacy: all entries non-string — null", () => {
    const op = { step: "loop_sig_writeahead", txSignatures: [42, null, undefined] as unknown[], metadata: null };
    expect(pickCloseTxSig(op)).toBeNull();
  });

  // --- Explicit meta path (new records) -------------------------------------

  it("explicit: meta.closeTxSignature present, matches last array entry — returns it", () => {
    const op = makeOp({
      sigs: [ATA_PREP_SIG, CLOSE_SIG],
      meta: { closeTxSignature: CLOSE_SIG },
    });
    expect(pickCloseTxSig(op)).toBe(CLOSE_SIG);
  });

  it("explicit: single-sig array, meta.closeTxSignature matches — returns sig", () => {
    const op = makeOp({ sigs: [CLOSE_SIG], meta: { closeTxSignature: CLOSE_SIG } });
    expect(pickCloseTxSig(op)).toBe(CLOSE_SIG);
  });

  // Correction 1: mismatch must fail closed, NOT return the meta value.
  it("explicit: meta.closeTxSignature differs from last array entry — null (inconsistent, fail closed)", () => {
    const op = makeOp({
      sigs: [ATA_PREP_SIG, OTHER_SIG],     // last = OTHER_SIG
      meta: { closeTxSignature: CLOSE_SIG }, // meta says CLOSE_SIG — mismatch
    });
    expect(pickCloseTxSig(op)).toBeNull();
  });

  it("explicit: meta.closeTxSignature is empty string — null (malformed identity)", () => {
    const op = makeOp({
      sigs: [ATA_PREP_SIG, CLOSE_SIG],
      meta: { closeTxSignature: "" }, // empty — malformed
    });
    // Must not silently fall through to the array; the key is present but invalid.
    expect(pickCloseTxSig(op)).toBeNull();
  });

  it("explicit: meta.closeTxSignature is non-string (null) — null (malformed identity)", () => {
    const op = makeOp({
      sigs: [ATA_PREP_SIG, CLOSE_SIG],
      meta: { closeTxSignature: null } as Record<string, unknown>,
    });
    expect(pickCloseTxSig(op)).toBeNull();
  });

  it("explicit: meta.closeTxSignature is a number — null (malformed identity)", () => {
    const op = makeOp({
      sigs: [CLOSE_SIG],
      meta: { closeTxSignature: 12345 } as Record<string, unknown>,
    });
    expect(pickCloseTxSig(op)).toBeNull();
  });

  it("explicit: meta matches, but trailing array entry is non-string — null (can't cross-check)", () => {
    const op = makeOp({
      sigs: [CLOSE_SIG, 99],                   // trailing is a number, not a string
      meta: { closeTxSignature: CLOSE_SIG },
    });
    // lastSig = null (trailing is non-string), can't verify consistency → fail closed.
    expect(pickCloseTxSig(op)).toBeNull();
  });

  // --- Step guard -----------------------------------------------------------

  it("wrong step ('atas_prepared') — null regardless of signatures", () => {
    const op = makeOp({ sigs: [CLOSE_SIG], step: "atas_prepared" });
    expect(pickCloseTxSig(op)).toBeNull();
  });

  it("null step — null", () => {
    const op = { step: null, txSignatures: [CLOSE_SIG], metadata: null };
    expect(pickCloseTxSig(op)).toBeNull();
  });
});

// ============================================================================
// verifyCloseTxLanded — async, controlled RPC
// ============================================================================

describe("verifyCloseTxLanded", () => {

  // WO acceptance 1: ATA-prep confirmed, close null/expired → not proven.
  it("WO#1 – ATA-prep confirmed, close sig null/expired → not_landed, only close sig checked", async () => {
    const op = makeOp({ sigs: [ATA_PREP_SIG, CLOSE_SIG] }); // no meta (legacy)
    const conn = makeConnection((sigs) => {
      expect(sigs).toEqual([CLOSE_SIG]); // only the close sig — not ATA_PREP_SIG
      return [null]; // not found / expired
    });
    expect(await verifyCloseTxLanded(op, conn as any)).toBe("not_landed");
    expect(conn.getSignatureStatuses).toHaveBeenCalledOnce();
  });

  // WO acceptance 2: close confirmed, no error → proven.
  it("WO#2 – close finalized, no error → landed", async () => {
    const op = makeOp({ sigs: [ATA_PREP_SIG, CLOSE_SIG] });
    const conn = makeConnection((sigs) => {
      expect(sigs).toEqual([CLOSE_SIG]);
      return [{ confirmationStatus: "finalized" }];
    });
    expect(await verifyCloseTxLanded(op, conn as any)).toBe("landed");
  });

  it("WO#2 – 'confirmed' status also qualifies", async () => {
    const op = makeOp({ sigs: [CLOSE_SIG] });
    const conn = makeConnection(() => [{ confirmationStatus: "confirmed" }]);
    expect(await verifyCloseTxLanded(op, conn as any)).toBe("landed");
  });

  // WO acceptance 3: errored close → not proven.
  it("WO#3 – close sig landed but has tx error → not_landed", async () => {
    const op = makeOp({ sigs: [CLOSE_SIG] });
    const conn = makeConnection(() => [{ confirmationStatus: "finalized", err: { InstructionError: [0, "Custom"] } }]);
    expect(await verifyCloseTxLanded(op, conn as any)).toBe("not_landed");
  });

  it("WO#3 – 'processed' without error is not enough → not_landed", async () => {
    const op = makeOp({ sigs: [CLOSE_SIG] });
    const conn = makeConnection(() => [{ confirmationStatus: "processed" }]);
    expect(await verifyCloseTxLanded(op, conn as any)).toBe("not_landed");
  });

  // WO acceptance 4: RPC throws → unverifiable.
  it("WO#4 – getSignatureStatuses throws → unverifiable", async () => {
    const op = makeOp({ sigs: [CLOSE_SIG] });
    const conn = { getSignatureStatuses: vi.fn().mockRejectedValueOnce(new Error("RPC timeout")) };
    expect(await verifyCloseTxLanded(op, conn as any)).toBe("unverifiable");
  });

  // WO acceptance 5: legacy record uses last-element invariant.
  it("WO#5 – legacy two-sig record: probes close sig (last), not ATA-prep sig (first)", async () => {
    const op = makeOp({ sigs: [ATA_PREP_SIG, CLOSE_SIG] }); // no meta
    const conn = makeConnection((sigs) => {
      expect(sigs).toEqual([CLOSE_SIG]);
      return [{ confirmationStatus: "finalized" }];
    });
    expect(await verifyCloseTxLanded(op, conn as any)).toBe("landed");
  });

  it("WO#5 – legacy single-sig record", async () => {
    const op = makeOp({ sigs: [CLOSE_SIG] });
    const conn = makeConnection(() => [{ confirmationStatus: "confirmed" }]);
    expect(await verifyCloseTxLanded(op, conn as any)).toBe("landed");
  });

  // WO acceptance 6: malformed records fail closed without any RPC call.
  it("WO#6 – empty txSignatures, no meta → malformed, no RPC", async () => {
    const op = makeOp({ sigs: [] });
    const conn = { getSignatureStatuses: vi.fn() };
    expect(await verifyCloseTxLanded(op, conn as any)).toBe("malformed");
    expect(conn.getSignatureStatuses).not.toHaveBeenCalled();
  });

  it("WO#6 – null txSignatures → malformed, no RPC", async () => {
    const op = { step: "loop_sig_writeahead", txSignatures: null, metadata: null };
    const conn = { getSignatureStatuses: vi.fn() };
    expect(await verifyCloseTxLanded(op, conn as any)).toBe("malformed");
    expect(conn.getSignatureStatuses).not.toHaveBeenCalled();
  });

  it("WO#6 – wrong step → malformed, no RPC", async () => {
    const op = makeOp({ sigs: [CLOSE_SIG], step: "atas_prepared" });
    const conn = { getSignatureStatuses: vi.fn() };
    expect(await verifyCloseTxLanded(op, conn as any)).toBe("malformed");
    expect(conn.getSignatureStatuses).not.toHaveBeenCalled();
  });

  it("WO#6 – explicit meta mismatches last array entry → malformed, no RPC", async () => {
    const op = makeOp({
      sigs: [ATA_PREP_SIG, OTHER_SIG],
      meta: { closeTxSignature: CLOSE_SIG }, // mismatch
    });
    const conn = { getSignatureStatuses: vi.fn() };
    expect(await verifyCloseTxLanded(op, conn as any)).toBe("malformed");
    expect(conn.getSignatureStatuses).not.toHaveBeenCalled();
  });

  it("WO#6 – empty explicit meta → malformed, no RPC", async () => {
    const op = makeOp({ sigs: [CLOSE_SIG], meta: { closeTxSignature: "" } });
    const conn = { getSignatureStatuses: vi.fn() };
    expect(await verifyCloseTxLanded(op, conn as any)).toBe("malformed");
    expect(conn.getSignatureStatuses).not.toHaveBeenCalled();
  });

  it("WO#6 – non-string trailing array entry → malformed, no RPC", async () => {
    const op = makeOp({ sigs: [CLOSE_SIG, null] }); // null last
    const conn = { getSignatureStatuses: vi.fn() };
    expect(await verifyCloseTxLanded(op, conn as any)).toBe("malformed");
    expect(conn.getSignatureStatuses).not.toHaveBeenCalled();
  });
});

// ============================================================================
// executeLoopHop — caller-level provenance boundary
//
// Drives the REAL executeLoopHop function into the RESUME state where the
// source position is absent and a crash-window close attempt exists.
// Asserts behavior at the caller boundary: which sig is queried, whether the
// hop re-levers, and whether the result is resumable vs terminal.
//
// Minimal fixture setup:
//   - Hop op is PENDING with fromVaultId + closeAttempts=1 + preCloseAgentLamports
//     already persisted (gate and baseline already recorded).
//   - Source borrow position shows status=closed → loadOpenLoopPosition returns
//     ok:false → sourceStillOpen=false → provenance branch entered.
//   - Close sub-op (attempt 1) has step=loop_sig_writeahead with an ATA-prep sig
//     at index 0 and the close sig at index 1, plus meta.closeTxSignature
//     consistent with the last array entry.
// ============================================================================

describe("executeLoopHop — caller-level provenance boundary", () => {
  const WALLET      = "wallet-abc123";
  const POS_ID      = "pos-xyz";
  const HOP_CRID    = "hop-crid-test-001";
  const TARGET_VAULT = 47;   // in mocked LOOP_VAULT_ALLOWLIST
  const FROM_VAULT   = 4;    // different from TARGET_VAULT

  const ATA_SIG_C   = "callerAtaPrep11111111111111111111111111111111111111111";
  const CLOSE_SIG_C = "callerCloseSig1111111111111111111111111111111111111111";

  /** The durable hop op row in the RESUME / crash-window state. */
  const hopOp = {
    id: "hop-op-id",
    operationType: "loop_hop",
    status: "pending",
    step: "pre_gated",
    walletAddress: WALLET,
    borrowPositionId: POS_ID,
    clientRequestId: HOP_CRID,
    metadata: {
      fromVaultId: FROM_VAULT,
      closeAttempts: 1,                      // one close attempt already recorded
      preCloseAgentLamports: "5000000000",   // baseline persisted → gate skipped
    },
    result: null,
    txSignatures: [],
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  /**
   * Source position is CLOSED — forces sourceStillOpen=false and enters the
   * provenance branch without executing a new close.
   */
  const closedPosition = {
    id: POS_ID,
    walletAddress: WALLET,
    status: "closed",    // pos.status !== "open" → loadOpenLoopPosition: ok:false
    kind: "loop",
    venueVaultId: String(FROM_VAULT),
    venuePositionId: "123",
  };

  /**
   * Close sub-op in the crash window: step=loop_sig_writeahead, not succeeded.
   * txSignatures=[ata_prep_sig, close_sig], meta.closeTxSignature=close_sig.
   */
  const closeOp = {
    id: "close-op-id",
    operationType: "loop_close",
    status: "pending",                    // NOT succeeded — crash window
    step: "loop_sig_writeahead",
    txSignatures: [ATA_SIG_C, CLOSE_SIG_C],
    metadata: {
      closeTxSignature: CLOSE_SIG_C,     // explicit identity, consistent with last
      blockhash: "test-blockhash",
      lastValidBlockHeight: 999999999,
    },
    result: null,
    error: null,
    walletAddress: WALLET,
    borrowPositionId: POS_ID,
    clientRequestId: `${HOP_CRID}:close:1`,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const hopParams = {
    walletAddress: WALLET,
    agentPublicKey: "11111111111111111111111111111111",
    agentSecretKey: new Uint8Array(64),
    borrowPositionId: POS_ID,
    targetVaultId: TARGET_VAULT,
    clientRequestId: HOP_CRID,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure updateBorrowOperation (used by failOp) resolves without throwing.
    vi.mocked(storage.updateBorrowOperation as any).mockResolvedValue({ id: "hop-op-id" });
  });

  function setupStorageResume() {
    vi.mocked(storage.getBorrowOperationByClientRequestId as any).mockImplementation(
      async (_wallet: string, crid: string) => {
        if (crid === HOP_CRID)                         return hopOp;
        if (crid === `${HOP_CRID}:close:1`)             return closeOp;
        return null;
      },
    );
    vi.mocked(storage.getBorrowPosition as any).mockResolvedValue(closedPosition);
  }

  // ---------------------------------------------------------------------------
  // WO-caller#1:
  //   ATA-prep sig is confirmed on-chain; main-close sig is null (not found).
  //   Assertion boundary: the caller must NOT re-lever, must return unsuccessful,
  //   and must NOT set alreadyCompleted or borrowPositionId (no open ran).
  //   The RPC stub asserts that ONLY the close sig is checked — not ATA_SIG_C.
  // ---------------------------------------------------------------------------
  it("WO-caller#1: ATA-prep confirmed + close unlanded → close not proven, no re-lever, unsuccessful", async () => {
    setupStorageResume();

    const mockConn = {
      getSignatureStatuses: vi.fn().mockImplementation(async (sigs: string[]) => {
        // Critical assertion: only the CLOSE sig must be queried.
        // If ATA_SIG_C appeared here, the provenance check is still broken.
        expect(sigs).not.toContain(ATA_SIG_C);
        expect(sigs).toEqual([CLOSE_SIG_C]);
        return { value: [null] }; // null = not found / unlanded
      }),
    };
    vi.mocked(getServerConnection as any).mockReturnValue(mockConn);

    const result = await executeLoopHop(hopParams);

    // Close not proven → closed_outside_hop terminal.
    expect(result.success).toBe(false);
    // Must not have re-levered: no new position was opened.
    expect(result.borrowPositionId).toBeUndefined();
    // Must not look like a normal idempotent-complete.
    expect((result as any).alreadyCompleted).toBeUndefined();
    // The status RPC was called exactly once (for the single close attempt).
    expect(mockConn.getSignatureStatuses).toHaveBeenCalledOnce();
  });

  // ---------------------------------------------------------------------------
  // WO-caller#2:
  //   The status RPC throws (network error).  The hop must remain resumable
  //   at the CALLER level — the op must NOT be marked failed (failOp not called
  //   with status:"failed"), and the returned result must carry resumable:true.
  // ---------------------------------------------------------------------------
  it("WO-caller#2: status RPC throws → resumable at caller, op not terminally failed", async () => {
    setupStorageResume();

    const mockConn = {
      getSignatureStatuses: vi.fn().mockRejectedValue(new Error("RPC timeout")),
    };
    vi.mocked(getServerConnection as any).mockReturnValue(mockConn);

    const result = await executeLoopHop(hopParams);

    // Must be resumable, not terminal.
    expect(result.success).toBe(false);
    expect((result as any).resumable).toBe(true);
    // No re-lever occurred.
    expect(result.borrowPositionId).toBeUndefined();
    // failOp must NOT have been called — the hop op stays pending, not failed.
    expect(storage.updateBorrowOperation).not.toHaveBeenCalledWith(
      "hop-op-id",
      expect.objectContaining({ status: "failed" }),
    );
  });
});
