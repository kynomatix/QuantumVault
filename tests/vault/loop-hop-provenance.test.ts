/**
 * tests/vault/loop-hop-provenance.test.ts
 *
 * Unit tests for the hop-close provenance helpers (pickCloseTxSig and
 * verifyCloseTxLanded).  All 6 work-order acceptance criteria are covered here
 * with NO network calls and NO database access.
 *
 * The helpers are exported from loop-executor for test purposes only.
 */

import { describe, expect, it, vi } from "vitest";
import { pickCloseTxSig, verifyCloseTxLanded } from "../../server/vault/loop/loop-executor";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ATA_PREP_SIG = "ataPrepSig1111111111111111111111111111111111111111111111";
const CLOSE_SIG    = "closeSig111111111111111111111111111111111111111111111111";
const OTHER_SIG    = "otherSig111111111111111111111111111111111111111111111111";

/** A close-attempt op that had ATA prep BEFORE the write-ahead close sig. */
function makeOp({
  sigs,
  meta,
  step = "loop_sig_writeahead",
}: {
  sigs: string[];
  meta?: Record<string, unknown>;
  step?: string;
}) {
  return {
    step,
    txSignatures: sigs,
    metadata: meta ?? null,
  };
}

/** A minimal mock Connection whose getSignatureStatuses is controlled per-test. */
function makeConnection(
  respondWith: (sigs: string[]) => Array<{
    confirmationStatus?: string;
    err?: unknown;
  } | null>,
) {
  return {
    getSignatureStatuses: vi.fn(async (sigs: string[]) => ({
      value: respondWith(sigs),
    })),
  };
}

// ---------------------------------------------------------------------------
// pickCloseTxSig — pure, synchronous
// ---------------------------------------------------------------------------

describe("pickCloseTxSig", () => {
  // WO acceptance 5: backward compatibility — legacy record has no explicit meta.
  it("legacy record (no meta.closeTxSignature): returns the last sig in txSignatures", () => {
    const op = makeOp({ sigs: [ATA_PREP_SIG, CLOSE_SIG] });
    expect(pickCloseTxSig(op)).toBe(CLOSE_SIG);
  });

  it("legacy record with single sig: returns that sig", () => {
    const op = makeOp({ sigs: [CLOSE_SIG] });
    expect(pickCloseTxSig(op)).toBe(CLOSE_SIG);
  });

  // New records carry explicit identity regardless of array ordering.
  it("new record with meta.closeTxSignature: returns the explicit meta value", () => {
    const op = makeOp({
      sigs: [ATA_PREP_SIG, CLOSE_SIG],
      meta: { closeTxSignature: CLOSE_SIG },
    });
    expect(pickCloseTxSig(op)).toBe(CLOSE_SIG);
  });

  it("explicit meta wins even when it differs from the last array element (invariant guard)", () => {
    // Should never occur in practice, but explicit meta is always authoritative.
    const op = makeOp({
      sigs: [ATA_PREP_SIG, OTHER_SIG],
      meta: { closeTxSignature: CLOSE_SIG },
    });
    expect(pickCloseTxSig(op)).toBe(CLOSE_SIG);
  });

  // WO acceptance 6: malformed records must fail closed.
  it("malformed: empty txSignatures array, no meta → null", () => {
    const op = makeOp({ sigs: [] });
    expect(pickCloseTxSig(op)).toBeNull();
  });

  it("malformed: null txSignatures, no meta → null", () => {
    const op = { step: "loop_sig_writeahead", txSignatures: null, metadata: null };
    expect(pickCloseTxSig(op)).toBeNull();
  });

  it("malformed: non-string elements in txSignatures with no meta → null", () => {
    const op = {
      step: "loop_sig_writeahead",
      txSignatures: [42, null, undefined] as unknown[],
      metadata: null,
    };
    expect(pickCloseTxSig(op)).toBeNull();
  });

  it("malformed: meta.closeTxSignature is empty string → falls through to array", () => {
    const op = makeOp({
      sigs: [ATA_PREP_SIG, CLOSE_SIG],
      meta: { closeTxSignature: "" },
    });
    // Empty string is rejected; falls back to last array element.
    expect(pickCloseTxSig(op)).toBe(CLOSE_SIG);
  });

  it("wrong step: returns null regardless of signatures", () => {
    const op = makeOp({ sigs: [CLOSE_SIG], step: "atas_prepared" });
    expect(pickCloseTxSig(op)).toBeNull();
  });

  it("wrong step: returns null for null step", () => {
    const op = { step: null, txSignatures: [CLOSE_SIG], metadata: null };
    expect(pickCloseTxSig(op)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// verifyCloseTxLanded — async, controlled-RPC
// ---------------------------------------------------------------------------

describe("verifyCloseTxLanded", () => {
  // WO acceptance 1:
  // ATA-prep sig is confirmed, close sig is null (expired/not found) → not proven.
  it("WO#1 – ATA-prep confirmed, close sig null/expired → not_landed (never re-lever)", async () => {
    const op = makeOp({ sigs: [ATA_PREP_SIG, CLOSE_SIG] });
    // Connection returns [confirmed-for-ATA-prep, null-for-close-sig].
    // BEFORE this fix the bug was: .some() matched the ATA-prep → "landed".
    // AFTER the fix: only the close sig is checked → null → "not_landed".
    const conn = makeConnection((sigs) => {
      expect(sigs).toEqual([CLOSE_SIG]); // must only probe the close sig
      return [null]; // close sig not found / expired
    });
    const result = await verifyCloseTxLanded(op, conn as any);
    expect(result).toBe("not_landed");
    expect(conn.getSignatureStatuses).toHaveBeenCalledOnce();
  });

  // WO acceptance 2:
  // ATA-prep + close sig present; close is confirmed/finalized, no error → proven.
  it("WO#2 – ATA-prep + close present, close confirmed with no error → landed", async () => {
    const op = makeOp({ sigs: [ATA_PREP_SIG, CLOSE_SIG] });
    const conn = makeConnection((sigs) => {
      expect(sigs).toEqual([CLOSE_SIG]);
      return [{ confirmationStatus: "finalized" }];
    });
    const result = await verifyCloseTxLanded(op, conn as any);
    expect(result).toBe("landed");
  });

  it("WO#2 – confirmationStatus 'confirmed' also qualifies", async () => {
    const op = makeOp({ sigs: [CLOSE_SIG] });
    const conn = makeConnection(() => [{ confirmationStatus: "confirmed" }]);
    expect(await verifyCloseTxLanded(op, conn as any)).toBe("landed");
  });

  // WO acceptance 3: failed/errored main-close tx must not prove the close.
  it("WO#3 – close sig with err field set → not_landed", async () => {
    const op = makeOp({ sigs: [CLOSE_SIG] });
    const conn = makeConnection(() => [{ confirmationStatus: "finalized", err: { InstructionError: [0, "Custom"] } }]);
    expect(await verifyCloseTxLanded(op, conn as any)).toBe("not_landed");
  });

  it("WO#3 – close sig with non-null err and unconfirmed status → not_landed", async () => {
    const op = makeOp({ sigs: [CLOSE_SIG] });
    const conn = makeConnection(() => [{ confirmationStatus: "processed", err: true }]);
    expect(await verifyCloseTxLanded(op, conn as any)).toBe("not_landed");
  });

  it("WO#3 – 'processed' confirmationStatus without error is not enough → not_landed", async () => {
    const op = makeOp({ sigs: [CLOSE_SIG] });
    const conn = makeConnection(() => [{ confirmationStatus: "processed" }]);
    expect(await verifyCloseTxLanded(op, conn as any)).toBe("not_landed");
  });

  // WO acceptance 4: RPC failure → unknown, resumable (not terminal, not proven).
  it("WO#4 – getSignatureStatuses throws → unverifiable (resumable)", async () => {
    const op = makeOp({ sigs: [CLOSE_SIG] });
    const conn = {
      getSignatureStatuses: vi.fn().mockRejectedValueOnce(new Error("RPC unavailable")),
    };
    expect(await verifyCloseTxLanded(op, conn as any)).toBe("unverifiable");
  });

  // WO acceptance 5: legacy record — no meta.closeTxSignature, uses last array element.
  it("WO#5 – legacy record (no meta), close sig last: checks the close sig, not prep sig", async () => {
    const op = makeOp({ sigs: [ATA_PREP_SIG, CLOSE_SIG] }); // no meta
    const conn = makeConnection((sigs) => {
      expect(sigs).toEqual([CLOSE_SIG]); // ordering invariant
      return [{ confirmationStatus: "finalized" }];
    });
    expect(await verifyCloseTxLanded(op, conn as any)).toBe("landed");
  });

  it("WO#5 – legacy single-sig record (no ATA prep): checks the sole sig", async () => {
    const op = makeOp({ sigs: [CLOSE_SIG] });
    const conn = makeConnection((sigs) => {
      expect(sigs).toEqual([CLOSE_SIG]);
      return [{ confirmationStatus: "confirmed" }];
    });
    expect(await verifyCloseTxLanded(op, conn as any)).toBe("landed");
  });

  // WO acceptance 6: malformed / inconsistent record → fail closed (malformed),
  // never proceeds to an RPC call that could return a spurious result.
  it("WO#6 – empty txSignatures, no meta → malformed (no RPC call)", async () => {
    const op = makeOp({ sigs: [] });
    const conn = { getSignatureStatuses: vi.fn() };
    expect(await verifyCloseTxLanded(op, conn as any)).toBe("malformed");
    expect(conn.getSignatureStatuses).not.toHaveBeenCalled();
  });

  it("WO#6 – null txSignatures, no meta → malformed (no RPC call)", async () => {
    const op = { step: "loop_sig_writeahead", txSignatures: null, metadata: null };
    const conn = { getSignatureStatuses: vi.fn() };
    expect(await verifyCloseTxLanded(op, conn as any)).toBe("malformed");
    expect(conn.getSignatureStatuses).not.toHaveBeenCalled();
  });

  it("WO#6 – wrong step → malformed (no RPC call)", async () => {
    const op = makeOp({ sigs: [CLOSE_SIG], step: "atas_prepared" });
    const conn = { getSignatureStatuses: vi.fn() };
    expect(await verifyCloseTxLanded(op, conn as any)).toBe("malformed");
    expect(conn.getSignatureStatuses).not.toHaveBeenCalled();
  });
});
