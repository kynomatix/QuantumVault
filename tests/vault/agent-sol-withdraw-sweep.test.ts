/**
 * tests/vault/agent-sol-withdraw-sweep.test.ts — WO2B2C-A1/A2
 *
 * Pins sweepAbandonedSolWithdrawals: the bounded background recovery for
 * abandoned durable SOL withdrawals.
 *
 *  - READ-AND-CAS ONLY: across EVERY path the sweep never decrypts keys,
 *    never touches the durable executor, never precommits a signature —
 *    proven by spies on the full signing/broadcast surface.
 *  - Only stale, freshly re-read 'pending' rows with ZERO broadcast-identity
 *    evidence (A2-widened: txSignatures entry, signature pin, blockhash pin,
 *    lastValidBlockHeight pin — ALL absent) AND a fully COHERENT pinned
 *    intent (crid; positive requestedLamports; destination = the row's own
 *    wallet; signer pin) are terminalized, via the existing atomic
 *    no-signature CAS (requireNoSignature) with the fixed operator error
 *    text. Partial breadcrumbs and incoherent intents are ANOMALIES: manual
 *    review, zero writes, zero RPC — later rows keep processing.
 *  - Broadcast-identity-bearing rows route through the SHARED reconcile core:
 *    landed → locked exactly-once finalize (idempotent via
 *    already_succeeded); onchain_failed/expired → signature-bound terminal
 *    CAS; still_valid/unverifiable → best-effort breadcrumb, row stays
 *    pending. Malformed/partial evidence stays pending for MANUAL review
 *    with zero writes and zero RPC.
 *  - Bounded, oldest-first, per-row isolated, parallel-safe (lost CAS = lost
 *    race counter, never a second write).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../server/storage", () => ({
  AGENT_SOL_WITHDRAW_OP_TYPE: "agent_sol_withdraw",
  storage: {
    getStaleAgentSolWithdrawOperations: vi.fn(),
    getBorrowOperationById: vi.fn(),
    transitionAgentSolWithdraw: vi.fn(),
    finalizeAgentSolWithdrawSuccess: vi.fn(),
    // Signing-surface spies — the sweep must NEVER call these.
    precommitAgentSolWithdrawSignature: vi.fn(),
    getOrCreateAgentSolWithdrawIntent: vi.fn(),
    // Referenced by unrelated handler paths in the module; harmless spies.
    getWallet: vi.fn(),
    getBorrowOperationByClientRequestId: vi.fn(),
    getBorrowOperations: vi.fn(),
  },
}));

vi.mock("../../server/vault/reset-blockers", () => ({
  TERMINAL_OPERATION_STATUSES: new Set(["succeeded", "completed", "failed"]),
}));

vi.mock("../../server/agent-wallet", () => ({
  executeAgentSolWithdrawDurable: vi.fn(),
  getAgentSolBalanceLamportsStrict: vi.fn(),
  getSignatureStatusStrict: vi.fn(),
  getBlockHeightStrict: vi.fn(),
}));

vi.mock("../../server/session-v3", () => ({
  getUmkForWebhook: vi.fn(),
  decryptAgentKeyStrict: vi.fn(),
}));

import { storage } from "../../server/storage";
import {
  executeAgentSolWithdrawDurable,
  getAgentSolBalanceLamportsStrict,
  getSignatureStatusStrict,
  getBlockHeightStrict,
} from "../../server/agent-wallet";
import { getUmkForWebhook, decryptAgentKeyStrict } from "../../server/session-v3";
import {
  sweepAbandonedSolWithdrawals,
  SOL_WITHDRAW_ABANDONED_AFTER_MS,
  SOL_WITHDRAW_SWEEP_LIMIT,
  SOL_WITHDRAW_ABANDONED_ERROR,
  SOL_WITHDRAW_EXPIRY_SLACK_BLOCKS,
} from "../../server/vault/agent-sol-withdraw";

const NOW = new Date("2026-07-27T12:00:00Z");
const CUTOFF_MS = NOW.getTime() - SOL_WITHDRAW_ABANDONED_AFTER_MS;
const STALE_AT = new Date(CUTOFF_MS - 60_000); // provably stale
const FRESH_AT = new Date(NOW.getTime() - 60_000); // went active again
const WALLET = "WaLLetAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SIG = "5sweepSigBase58XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const LVBH = 500;

let opSeq = 0;
/** Clean pending intent: ZERO broadcast-identity evidence, fully COHERENT pins. */
function cleanOp(over: Record<string, unknown> = {}) {
  return {
    id: `op-${++opSeq}`,
    walletAddress: WALLET,
    operationType: "agent_sol_withdraw",
    status: "pending",
    step: "intent_created",
    clientRequestId: `crid-${opSeq}`,
    txSignatures: [],
    metadata: {
      requestedLamports: "47500000",
      destinationWallet: WALLET,
      sourceAgentPublicKey: "AGENTPK",
    },
    result: null,
    error: null,
    createdAt: STALE_AT,
    updatedAt: STALE_AT,
    ...over,
  } as any;
}

/** Full, coherent write-ahead provenance (selectWithdrawProvenance-valid). */
function sigOp(over: Record<string, unknown> = {}, metaOver: Record<string, unknown> = {}) {
  return cleanOp({
    txSignatures: [SIG],
    metadata: {
      withdrawTxSignature: SIG,
      withdrawBlockhash: "BHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      withdrawLastValidBlockHeight: LVBH,
      requestedLamports: "47500000",
      destinationWallet: WALLET,
      sourceAgentPublicKey: "AGENTPK",
      ...metaOver,
    },
    ...over,
  });
}

function primeRows(rows: any[]) {
  vi.mocked(storage.getStaleAgentSolWithdrawOperations as any).mockResolvedValue(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  vi.mocked(storage.getBorrowOperationById as any).mockImplementation(async (id: string) => byId.get(id));
}

/** All transition calls that used the pre-broadcast no-signature CAS. */
const noSigTerminalizations = () =>
  vi.mocked(storage.transitionAgentSolWithdraw as any).mock.calls.filter((c: any[]) => c[0]?.requireNoSignature === true);

function expectNeverTouchedSigningSurface() {
  expect(executeAgentSolWithdrawDurable).not.toHaveBeenCalled();
  expect(getAgentSolBalanceLamportsStrict).not.toHaveBeenCalled();
  expect(getUmkForWebhook).not.toHaveBeenCalled();
  expect(decryptAgentKeyStrict).not.toHaveBeenCalled();
  expect(storage.precommitAgentSolWithdrawSignature).not.toHaveBeenCalled();
  expect(storage.getOrCreateAgentSolWithdrawIntent).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  opSeq = 0;
  vi.mocked(storage.transitionAgentSolWithdraw as any).mockResolvedValue(true);
  vi.mocked(storage.finalizeAgentSolWithdrawSuccess as any).mockResolvedValue({
    outcome: "finalized",
    operation: { id: "x", status: "succeeded" },
  });
});

describe("sweepAbandonedSolWithdrawals — worklist bounds and ordering", () => {
  it("queries ONE bounded, oldest-first worklist with the exact cutoff and limit", async () => {
    primeRows([]);
    const res = await sweepAbandonedSolWithdrawals(NOW);
    expect(storage.getStaleAgentSolWithdrawOperations).toHaveBeenCalledTimes(1);
    expect(storage.getStaleAgentSolWithdrawOperations).toHaveBeenCalledWith({
      updatedBefore: new Date(CUTOFF_MS),
      limit: SOL_WITHDRAW_SWEEP_LIMIT,
    });
    expect(res.scanned).toBe(0);
    expect(res.errors).toBe(0);
  });

  it("processes rows in the worklist's (oldest-first) order", async () => {
    const a = cleanOp();
    const b = cleanOp();
    const c = cleanOp();
    primeRows([a, b, c]);
    await sweepAbandonedSolWithdrawals(NOW);
    const readOrder = vi.mocked(storage.getBorrowOperationById as any).mock.calls.map((call: any[]) => call[0]);
    expect(readOrder).toEqual([a.id, b.id, c.id]);
  });

  it("a worklist query failure is contained: errors=1, zero writes, no throw", async () => {
    vi.mocked(storage.getStaleAgentSolWithdrawOperations as any).mockRejectedValue(new Error("pool drained"));
    const res = await sweepAbandonedSolWithdrawals(NOW);
    expect(res.errors).toBe(1);
    expect(res.scanned).toBe(0);
    expect(storage.transitionAgentSolWithdraw).not.toHaveBeenCalled();
  });
});

// ─── WO2B2C-A2: widened broadcast-identity evidence + coherent-intent gate ──
describe("sweepAbandonedSolWithdrawals — A2 widened evidence + coherent intent", () => {
  it("BLOCKHASH-ONLY breadcrumb is EVIDENCE: manual review, ZERO transition calls, ZERO RPC", async () => {
    primeRows([
      cleanOp({
        metadata: {
          requestedLamports: "47500000",
          destinationWallet: WALLET,
          sourceAgentPublicKey: "AGENTPK",
          withdrawBlockhash: "BHonlyXXXXXXXXXXXXXXXXXXXXXXXXXX",
        },
      }),
    ]);
    const res = await sweepAbandonedSolWithdrawals(NOW);
    expect(res.manualReview).toBe(1);
    expect(res.terminalizedAbandoned).toBe(0);
    expect(storage.transitionAgentSolWithdraw).not.toHaveBeenCalled(); // ZERO writes of ANY kind
    expect(getSignatureStatusStrict).not.toHaveBeenCalled(); // no RPC — nothing to classify
    expectNeverTouchedSigningSurface();
  });

  it("LASTVALIDBLOCKHEIGHT-ONLY breadcrumb is EVIDENCE: manual review, zero writes, zero RPC", async () => {
    primeRows([
      cleanOp({
        metadata: {
          requestedLamports: "47500000",
          destinationWallet: WALLET,
          sourceAgentPublicKey: "AGENTPK",
          withdrawLastValidBlockHeight: LVBH,
        },
      }),
    ]);
    const res = await sweepAbandonedSolWithdrawals(NOW);
    expect(res.manualReview).toBe(1);
    expect(res.terminalizedAbandoned).toBe(0);
    expect(storage.transitionAgentSolWithdraw).not.toHaveBeenCalled();
    expect(getSignatureStatusStrict).not.toHaveBeenCalled();
    expectNeverTouchedSigningSurface();
  });

  it("EXPLICIT-NULL signature pin is EVIDENCE (JS `!== undefined` ↔ SQL `->` IS NULL parity): manual review, zero writes", async () => {
    primeRows([
      cleanOp({
        metadata: {
          requestedLamports: "47500000",
          destinationWallet: WALLET,
          sourceAgentPublicKey: "AGENTPK",
          withdrawTxSignature: null,
        },
      }),
    ]);
    const res = await sweepAbandonedSolWithdrawals(NOW);
    expect(res.manualReview).toBe(1);
    expect(storage.transitionAgentSolWithdraw).not.toHaveBeenCalled();
    expect(getSignatureStatusStrict).not.toHaveBeenCalled();
    expectNeverTouchedSigningSurface();
  });

  const INCOHERENT: Array<[string, Record<string, unknown>]> = [
    ["missing clientRequestId", { clientRequestId: null }],
    ["blank clientRequestId", { clientRequestId: "   " }],
    [
      "zero requestedLamports",
      { metadata: { requestedLamports: "0", destinationWallet: WALLET, sourceAgentPublicKey: "AGENTPK" } },
    ],
    [
      "unparseable requestedLamports",
      { metadata: { requestedLamports: "47.5e6", destinationWallet: WALLET, sourceAgentPublicKey: "AGENTPK" } },
    ],
    [
      "destination is NOT the row's wallet",
      {
        metadata: {
          requestedLamports: "47500000",
          destinationWallet: "SomeOtherWalletBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
          sourceAgentPublicKey: "AGENTPK",
        },
      },
    ],
    [
      "missing sourceAgentPublicKey pin",
      { metadata: { requestedLamports: "47500000", destinationWallet: WALLET } },
    ],
  ];
  it.each(INCOHERENT)(
    "INCOHERENT INTENT (%s): manual review, ZERO writes — never reaches the no-signature CAS",
    async (_label, over) => {
      primeRows([cleanOp(over)]);
      const res = await sweepAbandonedSolWithdrawals(NOW);
      expect(res.manualReview).toBe(1);
      expect(res.terminalizedAbandoned).toBe(0);
      expect(storage.transitionAgentSolWithdraw).not.toHaveBeenCalled();
      expect(getSignatureStatusStrict).not.toHaveBeenCalled();
      expectNeverTouchedSigningSurface();
    },
  );

  it("ANOMALY DOES NOT WEDGE THE PASS: incoherent row → manual review; the LATER coherent row still terminalizes", async () => {
    const bad = cleanOp({
      metadata: { requestedLamports: "0", destinationWallet: WALLET, sourceAgentPublicKey: "AGENTPK" },
    });
    const good = cleanOp();
    primeRows([bad, good]);
    const res = await sweepAbandonedSolWithdrawals(NOW);
    expect(res.manualReview).toBe(1);
    expect(res.terminalizedAbandoned).toBe(1);
    const noSig = noSigTerminalizations();
    expect(noSig).toHaveLength(1);
    expect(noSig[0][0].operationId).toBe(good.id);
    expectNeverTouchedSigningSurface();
  });
});

describe("sweepAbandonedSolWithdrawals — provably pre-broadcast rows", () => {
  it("terminalizes a stale clean-pending row via the EXACT no-signature CAS with the fixed error text", async () => {
    const op = cleanOp();
    primeRows([op]);
    const res = await sweepAbandonedSolWithdrawals(NOW);
    expect(storage.transitionAgentSolWithdraw).toHaveBeenCalledTimes(1);
    expect(storage.transitionAgentSolWithdraw).toHaveBeenCalledWith({
      operationId: op.id,
      walletAddress: WALLET,
      toStatus: "failed",
      step: "withdraw_prebroadcast_failed",
      error: SOL_WITHDRAW_ABANDONED_ERROR,
      requireNoSignature: true,
    });
    expect(res.terminalizedAbandoned).toBe(1);
    expect(res.scanned).toBe(1);
    // Never classified a signature (there is none) and never finalized.
    expect(getSignatureStatusStrict).not.toHaveBeenCalled();
    expect(storage.finalizeAgentSolWithdrawSuccess).not.toHaveBeenCalled();
    expectNeverTouchedSigningSurface();
  });

  it("a lost CAS (concurrent precommit won) is a lost race — counted, no retry, no second write", async () => {
    vi.mocked(storage.transitionAgentSolWithdraw as any).mockResolvedValue(false);
    primeRows([cleanOp()]);
    const res = await sweepAbandonedSolWithdrawals(NOW);
    expect(res.raceLost).toBe(1);
    expect(res.terminalizedAbandoned).toBe(0);
    expect(storage.transitionAgentSolWithdraw).toHaveBeenCalledTimes(1);
  });

  it("TOCTOU freshness: the fresh re-read shows recent activity → skipped, ZERO writes", async () => {
    const staleCopy = cleanOp(); // worklist snapshot (stale)
    primeRows([staleCopy]);
    vi.mocked(storage.getBorrowOperationById as any).mockResolvedValue(cleanOp({ id: staleCopy.id, updatedAt: FRESH_AT }));
    const res = await sweepAbandonedSolWithdrawals(NOW);
    expect(res.skipped).toBe(1);
    expect(storage.transitionAgentSolWithdraw).not.toHaveBeenCalled();
  });

  it("TOCTOU evidence: a write-ahead appeared between worklist and re-read → reconcile path, NEVER the no-signature CAS", async () => {
    const staleCopy = cleanOp();
    primeRows([staleCopy]);
    vi.mocked(storage.getBorrowOperationById as any).mockResolvedValue(sigOp({ id: staleCopy.id }));
    vi.mocked(getSignatureStatusStrict as any).mockResolvedValue({ err: null, confirmationStatus: "confirmed" });
    const res = await sweepAbandonedSolWithdrawals(NOW);
    expect(getSignatureStatusStrict).toHaveBeenCalledWith(SIG);
    expect(noSigTerminalizations()).toHaveLength(0);
    expect(res.finalized).toBe(1);
  });

  it("an unreadable fresh updatedAt fails SAFE: skipped, zero writes", async () => {
    const op = cleanOp({ updatedAt: "not-a-date" });
    primeRows([op]);
    const res = await sweepAbandonedSolWithdrawals(NOW);
    expect(res.skipped).toBe(1);
    expect(storage.transitionAgentSolWithdraw).not.toHaveBeenCalled();
  });

  it("terminal and vanished rows are skipped; unknown non-terminal statuses go to MANUAL review — all untouched", async () => {
    const term = cleanOp({ status: "succeeded" });
    const gone = cleanOp();
    const weird = cleanOp({ status: "reconciling_v9" });
    const wrongType = cleanOp({ operationType: "loop_hop" });
    primeRows([term, gone, weird, wrongType]);
    vi.mocked(storage.getBorrowOperationById as any).mockImplementation(async (id: string) =>
      id === gone.id ? undefined : [term, weird, wrongType].find((r) => r.id === id),
    );
    const res = await sweepAbandonedSolWithdrawals(NOW);
    expect(res.scanned).toBe(4);
    expect(res.skipped).toBe(3); // terminal + vanished + wrong-type
    expect(res.manualReview).toBe(1); // unknown status surfaces
    expect(storage.transitionAgentSolWithdraw).not.toHaveBeenCalled();
    expect(storage.finalizeAgentSolWithdrawSuccess).not.toHaveBeenCalled();
  });
});

describe("sweepAbandonedSolWithdrawals — signature-bearing rows (shared reconcile core)", () => {
  it("LANDED → locked finalize with the exact persisted signature; exactly-once across repeat sweeps (already_succeeded)", async () => {
    const op = sigOp();
    primeRows([op]);
    vi.mocked(getSignatureStatusStrict as any).mockResolvedValue({ err: null, confirmationStatus: "finalized" });

    const first = await sweepAbandonedSolWithdrawals(NOW);
    expect(storage.finalizeAgentSolWithdrawSuccess).toHaveBeenCalledTimes(1);
    expect(storage.finalizeAgentSolWithdrawSuccess).toHaveBeenCalledWith({
      operationId: op.id,
      walletAddress: WALLET,
      expectedSignature: SIG,
    });
    expect(first.finalized).toBe(1);

    // The row somehow reappears in a later worklist (e.g. raced retention):
    // finalize is idempotent — no double success, no failure write.
    vi.mocked(storage.finalizeAgentSolWithdrawSuccess as any).mockResolvedValue({
      outcome: "already_succeeded",
      operation: { id: op.id, status: "succeeded" },
    });
    const second = await sweepAbandonedSolWithdrawals(NOW);
    expect(second.alreadySucceeded).toBe(1);
    expect(second.finalized).toBe(0);
    expect(noSigTerminalizations()).toHaveLength(0);
    expectNeverTouchedSigningSurface();
  });

  it("LANDED but the finalize write throws → row stays pending (roll forward later), never terminalized", async () => {
    primeRows([sigOp()]);
    vi.mocked(getSignatureStatusStrict as any).mockResolvedValue({ err: null, confirmationStatus: "confirmed" });
    vi.mocked(storage.finalizeAgentSolWithdrawSuccess as any).mockRejectedValue(new Error("db blip"));
    const res = await sweepAbandonedSolWithdrawals(NOW);
    expect(res.stillPending).toBe(1);
    expect(res.errors).toBe(0); // handled inside the core, not row-fatal
    expect(storage.transitionAgentSolWithdraw).not.toHaveBeenCalled();
  });

  it("ONCHAIN_FAILED → signature-bound terminal CAS (requireSignature), counted reconciledFailed", async () => {
    const op = sigOp();
    primeRows([op]);
    vi.mocked(getSignatureStatusStrict as any).mockResolvedValue({
      err: { InstructionError: [0, "Custom"] },
      confirmationStatus: "confirmed",
    });
    const res = await sweepAbandonedSolWithdrawals(NOW);
    expect(res.reconciledFailed).toBe(1);
    expect(storage.transitionAgentSolWithdraw).toHaveBeenCalledTimes(1);
    const call = vi.mocked(storage.transitionAgentSolWithdraw as any).mock.calls[0][0];
    expect(call).toMatchObject({
      operationId: op.id,
      walletAddress: WALLET,
      toStatus: "failed",
      step: "withdraw_failed_onchain",
      requireSignature: SIG,
    });
    expect(call.requireNoSignature).toBeUndefined();
    expect(call.error).toContain("Transaction failed on-chain");
  });

  it("EXPIRED is STRICT: height == lvbh+slack stays still_valid (breadcrumb only); height == lvbh+slack+1 terminalizes withdraw_expired", async () => {
    // Boundary: NOT yet expired.
    primeRows([sigOp()]);
    vi.mocked(getSignatureStatusStrict as any).mockResolvedValue(null);
    vi.mocked(getBlockHeightStrict as any).mockResolvedValue(LVBH + SOL_WITHDRAW_EXPIRY_SLACK_BLOCKS);
    let res = await sweepAbandonedSolWithdrawals(NOW);
    expect(res.stillPending).toBe(1);
    let call = vi.mocked(storage.transitionAgentSolWithdraw as any).mock.calls[0][0];
    expect(call.step).toBe("withdraw_still_valid");
    expect(call.toStatus).toBeUndefined(); // breadcrumb, not a status change
    expect(call.requireSignature).toBe(SIG);

    // Strictly beyond: expired.
    vi.resetAllMocks();
    vi.mocked(storage.transitionAgentSolWithdraw as any).mockResolvedValue(true);
    primeRows([sigOp()]);
    vi.mocked(getSignatureStatusStrict as any).mockResolvedValue(null);
    vi.mocked(getBlockHeightStrict as any).mockResolvedValue(LVBH + SOL_WITHDRAW_EXPIRY_SLACK_BLOCKS + 1);
    res = await sweepAbandonedSolWithdrawals(NOW);
    expect(res.reconciledFailed).toBe(1);
    call = vi.mocked(storage.transitionAgentSolWithdraw as any).mock.calls[0][0];
    expect(call).toMatchObject({ toStatus: "failed", step: "withdraw_expired", requireSignature: SIG });
  });

  it("UNVERIFIABLE (RPC read failure) → best-effort breadcrumb, stays pending; a breadcrumb write failure is swallowed", async () => {
    primeRows([sigOp()]);
    vi.mocked(getSignatureStatusStrict as any).mockRejectedValue(new Error("rpc 429"));
    vi.mocked(storage.transitionAgentSolWithdraw as any).mockRejectedValue(new Error("db blip"));
    const res = await sweepAbandonedSolWithdrawals(NOW);
    expect(res.stillPending).toBe(1);
    expect(res.errors).toBe(0);
    const call = vi.mocked(storage.transitionAgentSolWithdraw as any).mock.calls[0][0];
    expect(call.step).toBe("withdraw_unverifiable");
    expect(call.toStatus).toBeUndefined();
  });

  it("MALFORMED provenance (write-ahead not the last txSignatures entry) → manual review: ZERO writes, ZERO RPC", async () => {
    const op = sigOp({ txSignatures: [SIG, "someOtherLaterSig"] });
    primeRows([op]);
    const res = await sweepAbandonedSolWithdrawals(NOW);
    expect(res.manualReview).toBe(1);
    expect(getSignatureStatusStrict).not.toHaveBeenCalled();
    expect(getBlockHeightStrict).not.toHaveBeenCalled();
    expect(storage.transitionAgentSolWithdraw).not.toHaveBeenCalled();
    expect(storage.finalizeAgentSolWithdrawSuccess).not.toHaveBeenCalled();
  });

  it("PARTIAL evidence (txSignatures entry, no metadata pin) → evidence blocks terminalization; row stays pending for manual review", async () => {
    const op = cleanOp({ txSignatures: ["orphanSig"] }); // no withdrawTxSignature pin
    primeRows([op]);
    const res = await sweepAbandonedSolWithdrawals(NOW);
    expect(res.manualReview).toBe(1);
    expect(noSigTerminalizations()).toHaveLength(0); // NEVER the pre-broadcast CAS
    expect(storage.transitionAgentSolWithdraw).not.toHaveBeenCalled();
  });

  it("a transition CAS loss on a failed/expired verdict is a lost race (another writer owns the row)", async () => {
    primeRows([sigOp()]);
    vi.mocked(getSignatureStatusStrict as any).mockResolvedValue({ err: { x: 1 }, confirmationStatus: "confirmed" });
    vi.mocked(storage.transitionAgentSolWithdraw as any).mockResolvedValue(false);
    const res = await sweepAbandonedSolWithdrawals(NOW);
    expect(res.raceLost).toBe(1);
    expect(res.reconciledFailed).toBe(0);
  });
});

describe("sweepAbandonedSolWithdrawals — isolation, parallel safety, and the no-sign proof", () => {
  it("per-row isolation: a mid-list row failure is contained; earlier AND later rows still process", async () => {
    const a = cleanOp();
    const b = cleanOp();
    const c = cleanOp();
    primeRows([a, b, c]);
    vi.mocked(storage.getBorrowOperationById as any).mockImplementation(async (id: string) => {
      if (id === b.id) throw new Error("db blip");
      return [a, c].find((r) => r.id === id);
    });
    const res = await sweepAbandonedSolWithdrawals(NOW);
    expect(res.scanned).toBe(3);
    expect(res.errors).toBe(1);
    expect(res.terminalizedAbandoned).toBe(2); // a and c both terminalized
    const terminalizedIds = noSigTerminalizations().map((call: any[]) => call[0].operationId);
    expect(terminalizedIds.sort()).toEqual([a.id, c.id].sort());
  });

  it("PARALLEL sweeps over the same row: the CAS admits exactly one winner (1 terminalized + 1 lost race, 1+1 scans)", async () => {
    const op = cleanOp();
    primeRows([op]);
    vi.mocked(storage.transitionAgentSolWithdraw as any)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const [r1, r2] = await Promise.all([sweepAbandonedSolWithdrawals(NOW), sweepAbandonedSolWithdrawals(NOW)]);
    expect(r1.terminalizedAbandoned + r2.terminalizedAbandoned).toBe(1);
    expect(r1.raceLost + r2.raceLost).toBe(1);
    expect(r1.scanned + r2.scanned).toBe(2);
  });

  it("PROOF: across every row class in one pass, the sweep NEVER touches the signing/broadcast surface", async () => {
    const rows = [
      cleanOp(), // pre-broadcast terminalize
      sigOp(), // landed → finalize
      sigOp(), // onchain_failed → terminal CAS
      sigOp(), // null status → expiry math
      sigOp({ txSignatures: [SIG, "later"] }), // malformed → manual
      cleanOp({ status: "reconciling_v9" }), // unknown status → manual
      cleanOp({ status: "failed" }), // terminal → skip
      cleanOp({ updatedAt: FRESH_AT }), // fresh again → skip
    ];
    primeRows(rows);
    vi.mocked(getSignatureStatusStrict as any)
      .mockResolvedValueOnce({ err: null, confirmationStatus: "confirmed" })
      .mockResolvedValueOnce({ err: { code: 1 }, confirmationStatus: "confirmed" })
      .mockResolvedValueOnce(null);
    vi.mocked(getBlockHeightStrict as any).mockResolvedValue(LVBH + SOL_WITHDRAW_EXPIRY_SLACK_BLOCKS + 100);
    const res = await sweepAbandonedSolWithdrawals(NOW);
    expect(res.scanned).toBe(rows.length);
    expect(res.terminalizedAbandoned).toBe(1);
    expect(res.finalized).toBe(1);
    expect(res.reconciledFailed).toBe(2); // on-chain failure + expiry
    expect(res.manualReview).toBe(2);
    expect(res.skipped).toBe(2);
    expect(res.errors).toBe(0);
    expectNeverTouchedSigningSurface();
  });
});
