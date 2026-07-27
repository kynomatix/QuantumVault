/**
 * tests/vault/agent-sol-withdraw-state.test.ts — WO2B2B
 *
 * State-machine tests for the durable agent-SOL withdrawal orchestrator
 * (server/vault/agent-sol-withdraw.ts) against a hand-rolled in-memory
 * storage fake that mirrors the REAL storage semantics:
 *
 *  - getOrCreateAgentSolWithdrawIntent: (wallet, clientRequestId) unique
 *    across ALL operation types; adopt-don't-create on replay.
 *  - precommitAgentSolWithdrawSignature: sync-atomic CAS with the real
 *    rejection ladder (not_found → wallet_mismatch → wrong_type →
 *    not_pending → pinned_mismatch → already_signed → amount_mismatch →
 *    signer_rotated → conflict → duplicate_signature).
 *  - transitionAgentSolWithdraw: guarded single-row update (pending-only,
 *    requireNoSignature / requireSignature predicates).
 *  - finalizeAgentSolWithdrawSuccess: provenance-checked, atomic success +
 *    equity event, idempotent via already_succeeded.
 *
 * The durable executor is mocked to honor its WO2B2A contract exactly:
 * persist-before-send, persist-throw → not_broadcast, deterministic
 * signature per clientRequestId, and a send counter proving at-most-one
 * broadcast per logical request across every path in this file.
 *
 * Every response body in every test is swept for the absence of transaction
 * bytes ('transaction' key) — the durable route NEVER returns bytes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  type OpRow = {
    id: string;
    walletAddress: string;
    operationType: string;
    status: string;
    step: string | null;
    error: string | null;
    clientRequestId: string | null;
    txSignatures: string[];
    metadata: Record<string, any>;
    result: Record<string, any> | null;
  };
  const TERMINAL = new Set(["succeeded", "completed", "failed"]);
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

  const store = {
    ops: new Map<string, OpRow>(),
    wallets: new Map<string, any>(),
    equityEvents: [] as any[],
    nextId: 1,
    fail: {
      getWallet: false,
      getOrCreate: false,
      precommit: false,
      transition: false,
      finalize: false,
      getOps: false,
      getById: false,
      getByCrid: false,
    },
    /** Op ids hidden from getBorrowOperations — simulates the race window
     * where a sibling appears between the conflict gate and the atomic
     * precommit scan. */
    hideFromList: new Set<string>(),
    reset() {
      this.ops.clear();
      this.wallets.clear();
      this.equityEvents = [];
      this.nextId = 1;
      for (const k of Object.keys(this.fail)) (this.fail as any)[k] = false;
      this.hideFromList.clear();
    },
    seedWallet(addr: string, agentPk = "AGENT_PK_1") {
      this.wallets.set(addr, {
        address: addr,
        agentPublicKey: agentPk,
        agentPrivateKeyEncryptedV3: "enc-v3",
      });
    },
    addOp(partial: Partial<OpRow> & { walletAddress: string; operationType: string }): OpRow {
      const id = `op-${this.nextId++}`;
      const row: OpRow = {
        id,
        status: "pending",
        step: null,
        error: null,
        clientRequestId: null,
        txSignatures: [],
        metadata: {},
        result: null,
        ...partial,
      };
      this.ops.set(id, row);
      return row;
    },
  };

  const displayNegSol = (lamports: bigint): string => {
    const micro = (lamports + 500n) / 1000n;
    const whole = micro / 1_000_000n;
    const frac = (micro % 1_000_000n).toString().padStart(6, "0");
    return `-${whole}.${frac}`;
  };

  const storageMock = {
    async getWallet(addr: string) {
      if (store.fail.getWallet) throw new Error("getWallet down");
      const w = store.wallets.get(addr);
      return w ? clone(w) : undefined;
    },
    async getOrCreateAgentSolWithdrawIntent(p: any) {
      if (store.fail.getOrCreate) throw new Error("intent down");
      for (const row of store.ops.values()) {
        if (row.walletAddress === p.walletAddress && row.clientRequestId === p.clientRequestId) {
          return { operation: clone(row), created: false };
        }
      }
      const row = store.addOp({
        walletAddress: p.walletAddress,
        operationType: "agent_sol_withdraw",
        clientRequestId: p.clientRequestId,
        step: "intent_created",
        metadata: { ...p.pinned },
      });
      return { operation: clone(row), created: true };
    },
    async precommitAgentSolWithdrawSignature(p: any) {
      if (store.fail.precommit) throw new Error("precommit down");
      const op = store.ops.get(p.operationId);
      if (!op) return { won: false, reason: "not_found" };
      if (op.walletAddress !== p.walletAddress) return { won: false, reason: "wallet_mismatch", operation: clone(op) };
      if (op.operationType !== "agent_sol_withdraw") return { won: false, reason: "wrong_type", operation: clone(op) };
      if (op.status !== "pending") return { won: false, reason: "not_pending", operation: clone(op) };
      const m = op.metadata ?? {};
      let pinned: bigint | null = null;
      try {
        pinned = BigInt(m.requestedLamports);
      } catch {
        pinned = null;
      }
      if (
        pinned === null ||
        pinned <= 0n ||
        m.destinationWallet !== op.walletAddress ||
        m.destinationWallet !== p.signedDestinationWallet ||
        typeof m.sourceAgentPublicKey !== "string" ||
        m.sourceAgentPublicKey !== p.signedSourceAgentPublicKey
      ) {
        return { won: false, reason: "pinned_mismatch", operation: clone(op) };
      }
      if (op.txSignatures.length > 0 || typeof m.withdrawTxSignature === "string") {
        return { won: false, reason: "already_signed", operation: clone(op) };
      }
      let signed: bigint | null = null;
      try {
        signed = BigInt(p.precommit.lamports);
      } catch {
        signed = null;
      }
      if (signed === null || signed !== pinned) return { won: false, reason: "amount_mismatch", operation: clone(op) };
      const w = store.wallets.get(p.walletAddress);
      if (!w || w.agentPublicKey !== m.sourceAgentPublicKey) {
        return { won: false, reason: "signer_rotated", operation: clone(op) };
      }
      for (const sib of store.ops.values()) {
        if (sib.id === op.id || sib.walletAddress !== op.walletAddress) continue;
        if (
          (sib.operationType === "agent_sol_withdraw" || sib.operationType === "loop_hop") &&
          !TERMINAL.has(sib.status)
        ) {
          return { won: false, reason: "conflict", operation: clone(op) };
        }
      }
      for (const sib of store.ops.values()) {
        if (sib.id === op.id || sib.walletAddress !== op.walletAddress) continue;
        if (sib.operationType !== "agent_sol_withdraw") continue;
        const sm = sib.metadata ?? {};
        if (sib.txSignatures.includes(p.precommit.signature) || sm.withdrawTxSignature === p.precommit.signature) {
          return { won: false, reason: "duplicate_signature", operation: clone(op) };
        }
      }
      op.txSignatures.push(p.precommit.signature);
      op.metadata = {
        ...m,
        withdrawTxSignature: p.precommit.signature,
        withdrawBlockhash: p.precommit.blockhash,
        withdrawLastValidBlockHeight: p.precommit.lastValidBlockHeight,
      };
      op.step = "withdraw_sig_writeahead";
      return { won: true, operation: clone(op) };
    },
    async transitionAgentSolWithdraw(p: any) {
      if (store.fail.transition) throw new Error("transition down");
      const op = store.ops.get(p.operationId);
      if (
        !op ||
        op.walletAddress !== p.walletAddress ||
        op.operationType !== "agent_sol_withdraw" ||
        op.status !== "pending"
      ) {
        return false;
      }
      const m = op.metadata ?? {};
      if (p.requireNoSignature) {
        if (typeof m.withdrawTxSignature === "string" || op.txSignatures.length > 0) return false;
      }
      if (p.requireSignature !== undefined) {
        if (m.withdrawTxSignature !== p.requireSignature) return false;
      }
      if (p.toStatus) op.status = p.toStatus;
      op.step = p.step;
      if (p.error !== undefined) op.error = p.error;
      if (p.mergeMetadata) op.metadata = { ...m, ...p.mergeMetadata };
      if (p.result !== undefined) op.result = p.result;
      return true;
    },
    async finalizeAgentSolWithdrawSuccess(p: any) {
      if (store.fail.finalize) throw new Error("finalize down");
      const op = store.ops.get(p.operationId);
      if (!op || op.walletAddress !== p.walletAddress) return { outcome: "not_finalized", reason: "not_found" };
      if (op.operationType !== "agent_sol_withdraw") {
        return { outcome: "not_finalized", reason: "wrong_type", operation: clone(op) };
      }
      if (op.status === "succeeded") return { outcome: "already_succeeded", operation: clone(op) };
      if (op.status !== "pending") return { outcome: "not_finalized", reason: "not_pending", operation: clone(op) };
      const m = op.metadata ?? {};
      let lamports: bigint | null = null;
      try {
        lamports = BigInt(m.requestedLamports);
      } catch {
        lamports = null;
      }
      const sigOk =
        typeof m.withdrawTxSignature === "string" &&
        m.withdrawTxSignature === p.expectedSignature &&
        op.txSignatures.length > 0 &&
        op.txSignatures[op.txSignatures.length - 1] === p.expectedSignature;
      if (
        !sigOk ||
        lamports === null ||
        lamports <= 0n ||
        m.destinationWallet !== op.walletAddress ||
        typeof m.sourceAgentPublicKey !== "string" ||
        m.sourceAgentPublicKey.length === 0
      ) {
        return { outcome: "not_finalized", reason: "malformed_provenance", operation: clone(op) };
      }
      const display = displayNegSol(lamports);
      op.status = "succeeded";
      op.step = "withdraw_succeeded";
      op.result = {
        signature: p.expectedSignature,
        withdrawnLamports: m.requestedLamports,
        destinationWallet: m.destinationWallet,
        sourceAgentPublicKey: m.sourceAgentPublicKey,
        withdrawnSolDisplay: display,
      };
      store.equityEvents.push({
        walletAddress: op.walletAddress,
        eventType: "sol_withdraw",
        amount: display,
        assetType: "SOL",
        txSignature: p.expectedSignature,
        tradingBotId: null,
      });
      return { outcome: "finalized", operation: clone(op) };
    },
    async getBorrowOperations(w: string) {
      if (store.fail.getOps) throw new Error("list down");
      return clone(
        [...store.ops.values()].filter((o) => o.walletAddress === w && !store.hideFromList.has(o.id)),
      );
    },
    async getBorrowOperationById(id: string) {
      if (store.fail.getById) throw new Error("byId down");
      const op = store.ops.get(id);
      return op ? clone(op) : undefined;
    },
    async getBorrowOperationByClientRequestId(w: string, crid: string) {
      if (store.fail.getByCrid) throw new Error("byCrid down");
      for (const op of store.ops.values()) {
        if (op.walletAddress === w && op.clientRequestId === crid) return clone(op);
      }
      return undefined;
    },
  };

  // ——— Durable executor mock (honors the WO2B2A contract) ———
  const exec = {
    mode: "confirmed" as "confirmed" | "failed_on_chain" | "ambiguous" | "build_failed",
    sendCount: 0,
    calls: 0,
  };
  const sigFor = (crid: string) => `sig-${crid}`;
  const BH = "BH-1";
  const LVBH = 1000;

  const executeAgentSolWithdrawDurable = async (
    _agentPk: string,
    _secret: Uint8Array,
    _dest: string,
    lamports: number,
    crid: string,
    persist: (p: any) => Promise<void>,
  ) => {
    exec.calls++;
    if (exec.mode === "build_failed") {
      return { state: "not_broadcast", error: "build failed: rpc down" };
    }
    const precommit = { signature: sigFor(crid), blockhash: BH, lastValidBlockHeight: LVBH, lamports };
    try {
      await persist(precommit);
    } catch (e) {
      return { state: "not_broadcast", error: `durability callback rejected: ${(e as Error).message}` };
    }
    exec.sendCount++;
    if (exec.mode === "confirmed") return { state: "confirmed", signature: precommit.signature, lamports };
    if (exec.mode === "failed_on_chain") {
      return {
        state: "failed_on_chain",
        signature: precommit.signature,
        lamports,
        error: 'Transaction failed on-chain: {"InstructionError":[0,1]}',
      };
    }
    return {
      state: "ambiguous",
      signature: precommit.signature,
      lamports,
      error: "send failed after durability precommit: ws closed",
    };
  };

  const readers = {
    balance: vi.fn(),
    sigStatus: vi.fn(),
    blockHeight: vi.fn(),
  };

  const session = {
    umkCleanups: 0,
    keyCleanups: 0,
    umkMode: "ok" as "ok" | "null" | "throw",
    keyMode: "ok" as "ok" | "null",
    reset() {
      this.umkCleanups = 0;
      this.keyCleanups = 0;
      this.umkMode = "ok";
      this.keyMode = "ok";
    },
  };

  return { store, storageMock, exec, executeAgentSolWithdrawDurable, readers, session, sigFor, BH, LVBH, displayNegSol };
});

vi.mock("../../server/storage", () => ({
  storage: h.storageMock,
  AGENT_SOL_WITHDRAW_OP_TYPE: "agent_sol_withdraw",
  AGENT_SOL_WITHDRAW_LOCK_NAMESPACE: 927411,
}));

vi.mock("../../server/vault/reset-blockers", () => ({
  TERMINAL_OPERATION_STATUSES: new Set(["succeeded", "completed", "failed"]),
}));

vi.mock("../../server/agent-wallet", () => ({
  executeAgentSolWithdrawDurable: (...a: any[]) => (h.executeAgentSolWithdrawDurable as any)(...a),
  getAgentSolBalanceLamportsStrict: (...a: any[]) => h.readers.balance(...a),
  getSignatureStatusStrict: (...a: any[]) => h.readers.sigStatus(...a),
  getBlockHeightStrict: (...a: any[]) => h.readers.blockHeight(...a),
}));

vi.mock("../../server/session-v3", () => ({
  getUmkForWebhook: async (_w: string) => {
    if (h.session.umkMode === "throw") throw new Error("umk store down");
    if (h.session.umkMode === "null") return null;
    return { umk: new Uint8Array(32), cleanup: () => void h.session.umkCleanups++ };
  },
  decryptAgentKeyStrict: async () => {
    if (h.session.keyMode === "null") return null;
    return { secretKey: new Uint8Array(64), cleanup: () => void h.session.keyCleanups++ };
  },
}));

import {
  handleAgentSolWithdraw,
  handleConfirmSolWithdraw,
  parseWithdrawRequest,
  classifyWithdrawSignature,
  selectWithdrawProvenance,
  SOL_WITHDRAW_RESERVE_LAMPORTS,
  SOL_WITHDRAW_EXPIRY_SLACK_BLOCKS,
} from "../../server/vault/agent-sol-withdraw";

const WALLET = "UserWallet1111111111111111111111";
const AMOUNT = 0.0475;
const LAMPORTS = 47_500_000;
const CRID = "crid-happy-1";

const withdraw = (crid: string, amount: number = AMOUNT) =>
  handleAgentSolWithdraw(WALLET, { clientRequestId: crid, amount });

const noTxBytes = (r: { body: Record<string, unknown> }) => {
  expect(JSON.stringify(r.body)).not.toContain('"transaction"');
};

const opByCrid = (crid: string) => {
  const row = [...h.store.ops.values()].find((o) => o.clientRequestId === crid);
  expect(row).toBeDefined();
  return row!;
};

/** Seed a pending op that already owns a coherent write-ahead (crash-resume). */
function seedEvidenceOp(crid: string, overrides: Record<string, any> = {}) {
  const sig = h.sigFor(crid);
  return h.store.addOp({
    walletAddress: WALLET,
    operationType: "agent_sol_withdraw",
    clientRequestId: crid,
    step: "withdraw_sig_writeahead",
    txSignatures: [sig],
    metadata: {
      requestedLamports: String(LAMPORTS),
      destinationWallet: WALLET,
      sourceAgentPublicKey: "AGENT_PK_1",
      withdrawTxSignature: sig,
      withdrawBlockhash: h.BH,
      withdrawLastValidBlockHeight: h.LVBH,
      ...overrides.metadata,
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "metadata")),
  });
}

beforeEach(() => {
  h.store.reset();
  h.session.reset();
  h.exec.mode = "confirmed";
  h.exec.sendCount = 0;
  h.exec.calls = 0;
  h.readers.balance.mockReset().mockResolvedValue(10_000_000_000n);
  h.readers.sigStatus.mockReset().mockResolvedValue({ err: null, confirmationStatus: "confirmed" });
  h.readers.blockHeight.mockReset().mockResolvedValue(500);
  h.store.seedWallet(WALLET);
});

// ---------------------------------------------------------------------------
// parseWithdrawRequest (pure)
// ---------------------------------------------------------------------------

describe("parseWithdrawRequest", () => {
  it("accepts a valid body, trims the clientRequestId, and converts SOL to exact lamports", () => {
    const p = parseWithdrawRequest({ clientRequestId: "  abc  ", amount: AMOUNT });
    expect(p).toEqual({ ok: true, clientRequestId: "abc", lamports: LAMPORTS });
  });

  it("accepts the 0.000001 SOL minimum (exactly 1000 lamports)", () => {
    const p = parseWithdrawRequest({ clientRequestId: "x", amount: 0.000001 });
    expect(p).toEqual({ ok: true, clientRequestId: "x", lamports: 1000 });
  });

  it.each([
    { label: "missing clientRequestId", body: { amount: 1 } },
    { label: "non-string clientRequestId", body: { clientRequestId: 42, amount: 1 } },
    { label: "empty clientRequestId", body: { clientRequestId: "", amount: 1 } },
    { label: "whitespace clientRequestId", body: { clientRequestId: "   ", amount: 1 } },
    { label: "129-char clientRequestId", body: { clientRequestId: "x".repeat(129), amount: 1 } },
    { label: "missing amount", body: { clientRequestId: "x" } },
    { label: "string amount", body: { clientRequestId: "x", amount: "5" } },
    { label: "zero amount", body: { clientRequestId: "x", amount: 0 } },
    { label: "negative amount", body: { clientRequestId: "x", amount: -1 } },
    { label: "NaN amount", body: { clientRequestId: "x", amount: Number.NaN } },
    { label: "Infinity amount", body: { clientRequestId: "x", amount: Number.POSITIVE_INFINITY } },
    { label: "below 1000 lamports", body: { clientRequestId: "x", amount: 0.0000009 } },
    { label: "null body", body: null },
  ])("rejects $label", ({ body }) => {
    const p = parseWithdrawRequest(body);
    expect(p.ok).toBe(false);
  });

  it("pins the reserve and slack constants", () => {
    expect(SOL_WITHDRAW_RESERVE_LAMPORTS).toBe(5_000_000n);
    expect(SOL_WITHDRAW_EXPIRY_SLACK_BLOCKS).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// classifyWithdrawSignature (pure, mocked strict readers)
// ---------------------------------------------------------------------------

describe("classifyWithdrawSignature", () => {
  it("checks err BEFORE confirmationStatus: a landed-but-failed tx is onchain_failed even at finalized", async () => {
    h.readers.sigStatus.mockResolvedValue({ err: { InstructionError: [0, 1] }, confirmationStatus: "finalized" });
    const v = await classifyWithdrawSignature("s", h.LVBH);
    expect(v.verdict).toBe("onchain_failed");
  });

  it.each(["confirmed", "finalized"] as const)("%s → landed", async (level) => {
    h.readers.sigStatus.mockResolvedValue({ err: null, confirmationStatus: level });
    expect((await classifyWithdrawSignature("s", h.LVBH)).verdict).toBe("landed");
  });

  it("processed → still_valid (below commitment, NOT a transport failure; unverifiable is reserved for RPC read failures)", async () => {
    h.readers.sigStatus.mockResolvedValue({ err: null, confirmationStatus: "processed" });
    expect((await classifyWithdrawSignature("s", h.LVBH)).verdict).toBe("still_valid");
  });

  it("unknown non-terminal confirmation level → still_valid, never a verdict", async () => {
    h.readers.sigStatus.mockResolvedValue({ err: null, confirmationStatus: "someFutureLevel" });
    expect((await classifyWithdrawSignature("s", h.LVBH)).verdict).toBe("still_valid");
  });

  it("unknown sig at height == lvbh + slack → still_valid (expiry is STRICTLY greater)", async () => {
    h.readers.sigStatus.mockResolvedValue(null);
    h.readers.blockHeight.mockResolvedValue(h.LVBH + SOL_WITHDRAW_EXPIRY_SLACK_BLOCKS);
    expect((await classifyWithdrawSignature("s", h.LVBH)).verdict).toBe("still_valid");
  });

  it("unknown sig at height == lvbh + slack + 1 → expired", async () => {
    h.readers.sigStatus.mockResolvedValue(null);
    h.readers.blockHeight.mockResolvedValue(h.LVBH + SOL_WITHDRAW_EXPIRY_SLACK_BLOCKS + 1);
    expect((await classifyWithdrawSignature("s", h.LVBH)).verdict).toBe("expired");
  });

  it("status read transport failure → unverifiable, never a verdict", async () => {
    h.readers.sigStatus.mockRejectedValue(new Error("rpc down"));
    expect((await classifyWithdrawSignature("s", h.LVBH)).verdict).toBe("unverifiable");
  });

  it("block height transport failure → unverifiable, never expired", async () => {
    h.readers.sigStatus.mockResolvedValue(null);
    h.readers.blockHeight.mockRejectedValue(new Error("rpc down"));
    expect((await classifyWithdrawSignature("s", h.LVBH)).verdict).toBe("unverifiable");
  });
});

// ---------------------------------------------------------------------------
// Happy path + idempotent replay (matrix 1-2)
// ---------------------------------------------------------------------------

describe("happy path and replay", () => {
  it("executes exactly one transfer, finalizes atomically with ONE SOL equity event, and never returns tx bytes", async () => {
    const r = await withdraw(CRID);

    expect(r.http).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.state).toBe("succeeded");
    expect(r.body.signature).toBe(h.sigFor(CRID));
    expect(r.body.withdrawnLamports).toBe(String(LAMPORTS));
    expect(r.body.withdrawnSol).toBe("-0.047500");
    noTxBytes(r);

    const op = opByCrid(CRID);
    expect(op.status).toBe("succeeded");
    expect(op.step).toBe("withdraw_succeeded");
    expect(op.txSignatures).toEqual([h.sigFor(CRID)]);
    expect(op.metadata.withdrawTxSignature).toBe(h.sigFor(CRID));
    expect(op.metadata.withdrawBlockhash).toBe(h.BH);
    expect(op.metadata.withdrawLastValidBlockHeight).toBe(h.LVBH);

    expect(h.store.equityEvents).toHaveLength(1);
    expect(h.store.equityEvents[0]).toMatchObject({
      eventType: "sol_withdraw",
      assetType: "SOL",
      amount: "-0.047500",
      txSignature: h.sigFor(CRID),
      tradingBotId: null,
    });

    expect(h.exec.sendCount).toBe(1);
    expect(h.session.umkCleanups).toBe(1);
    expect(h.session.keyCleanups).toBe(1);
  });

  it("replaying the same clientRequestId after success answers 200 from the stored row with ZERO new executions", async () => {
    await withdraw(CRID);
    const r2 = await withdraw(CRID);

    expect(r2.http).toBe(200);
    expect(r2.body.success).toBe(true);
    expect(r2.body.signature).toBe(h.sigFor(CRID));
    noTxBytes(r2);

    expect(h.exec.calls).toBe(1); // executor never re-entered
    expect(h.exec.sendCount).toBe(1);
    expect(h.store.equityEvents).toHaveLength(1);
  });

  it("retry with the same clientRequestId but DIFFERENT amount → 409 withdraw_conflict, intent never mutated", async () => {
    await withdraw(CRID);
    const r2 = await withdraw(CRID, 0.05);

    expect(r2.http).toBe(409);
    expect(r2.body.terminal).toBe(true);
    expect(r2.body.step).toBe("withdraw_conflict");
    noTxBytes(r2);

    expect(opByCrid(CRID).metadata.requestedLamports).toBe(String(LAMPORTS)); // pins untouched
    expect(h.exec.calls).toBe(1);
    expect(h.store.equityEvents).toHaveLength(1);
  });

  it("clientRequestId already owned by a DIFFERENT operation type → 409 withdraw_conflict, zero executions", async () => {
    h.store.addOp({
      walletAddress: WALLET,
      operationType: "loop_hop",
      clientRequestId: "crid-loop",
      status: "pending",
    });

    const r = await withdraw("crid-loop");
    expect(r.http).toBe(409);
    expect(r.body.step).toBe("withdraw_conflict");
    expect(r.body.terminal).toBe(true);
    noTxBytes(r);
    expect(h.exec.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Wallet gates
// ---------------------------------------------------------------------------

describe("wallet gates", () => {
  it("unknown wallet → 404, nothing created", async () => {
    const r = await handleAgentSolWithdraw("UnknownWallet", { clientRequestId: "c", amount: 1 });
    expect(r.http).toBe(404);
    expect(h.store.ops.size).toBe(0);
  });

  it("wallet without agent keys → 400, nothing created", async () => {
    h.store.wallets.set("NoAgent", { address: "NoAgent", agentPublicKey: null, agentPrivateKeyEncryptedV3: null });
    const r = await handleAgentSolWithdraw("NoAgent", { clientRequestId: "c", amount: 1 });
    expect(r.http).toBe(400);
    expect(h.store.ops.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Concurrent-operation conflict gate (matrix 4) — terminal ALLOWLIST
// ---------------------------------------------------------------------------

describe("conflict gate", () => {
  it.each([
    { type: "agent_sol_withdraw", status: "pending" },
    { type: "loop_hop", status: "pending" },
    { type: "loop_hop", status: "parked" }, // unknown status BLOCKS (fail closed)
    { type: "agent_sol_withdraw", status: "reconciling" }, // unknown status BLOCKS
  ])("non-terminal sibling $type/$status blocks: 409 withdraw_conflict, zero executions", async ({ type, status }) => {
    h.store.addOp({ walletAddress: WALLET, operationType: type, status, clientRequestId: "other" });

    const r = await withdraw(CRID);
    expect(r.http).toBe(409);
    expect(r.body.step).toBe("withdraw_conflict");
    noTxBytes(r);

    const op = opByCrid(CRID);
    expect(op.status).toBe("failed");
    expect(op.step).toBe("withdraw_conflict");
    expect(h.exec.calls).toBe(0);
    expect(h.exec.sendCount).toBe(0);
  });

  it.each(["succeeded", "completed", "failed"])(
    "terminal sibling (%s) does NOT block — withdrawal proceeds to success",
    async (status) => {
      h.store.addOp({ walletAddress: WALLET, operationType: "loop_hop", status, clientRequestId: "other" });

      const r = await withdraw(CRID);
      expect(r.http).toBe(200);
      expect(h.exec.sendCount).toBe(1);
    },
  );

  it("pending sibling of an UNRELATED type does not block", async () => {
    h.store.addOp({ walletAddress: WALLET, operationType: "vault_park", status: "pending", clientRequestId: "other" });

    const r = await withdraw(CRID);
    expect(r.http).toBe(200);
    expect(h.exec.sendCount).toBe(1);
  });

  it("sibling appearing AFTER the gate (atomic precommit scan catches it) → 409 withdraw_conflict; cleanups still run", async () => {
    const sib = h.store.addOp({
      walletAddress: WALLET,
      operationType: "loop_hop",
      status: "pending",
      clientRequestId: "raced-in",
    });
    h.store.hideFromList.add(sib.id); // gate can't see it; the precommit CAS can

    const r = await withdraw(CRID);
    expect(r.http).toBe(409);
    expect(r.body.step).toBe("withdraw_conflict");
    noTxBytes(r);

    const op = opByCrid(CRID);
    expect(op.status).toBe("failed");
    expect(op.step).toBe("withdraw_conflict");
    expect(op.txSignatures).toEqual([]); // requireNoSignature guard held
    expect(h.exec.sendCount).toBe(0); // persist rejected → nothing broadcast
    expect(h.session.umkCleanups).toBe(1);
    expect(h.session.keyCleanups).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed reads → retryable 202, nothing sent, nothing terminalized (matrix 6)
// ---------------------------------------------------------------------------

describe("fail-closed reads", () => {
  it("intent create/load failure → 202, no op row, zero executions", async () => {
    h.store.fail.getOrCreate = true;
    const r = await withdraw(CRID);
    expect(r.http).toBe(202);
    expect(r.body.pending).toBe(true);
    noTxBytes(r);
    expect(h.store.ops.size).toBe(0);
    expect(h.exec.calls).toBe(0);
  });

  it("concurrent-op list read failure → 202, op stays cleanly pending, zero executions", async () => {
    h.store.fail.getOps = true;
    const r = await withdraw(CRID);
    expect(r.http).toBe(202);
    const op = opByCrid(CRID);
    expect(op.status).toBe("pending");
    expect(op.step).toBe("intent_created");
    expect(h.exec.calls).toBe(0);
  });

  it("strict balance read failure → 202, never assumes zero, never terminalizes", async () => {
    h.readers.balance.mockRejectedValue(new Error("rpc down"));
    const r = await withdraw(CRID);
    expect(r.http).toBe(202);
    const op = opByCrid(CRID);
    expect(op.status).toBe("pending");
    expect(h.exec.calls).toBe(0);
  });

  it("UMK store failure → 202, op stays pending for the same clientRequestId", async () => {
    h.session.umkMode = "throw";
    const r = await withdraw(CRID);
    expect(r.http).toBe(202);
    expect(opByCrid(CRID).status).toBe("pending");
    expect(h.exec.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pre-broadcast failures terminalize safely (nothing was sent)
// ---------------------------------------------------------------------------

describe("pre-broadcast terminalization", () => {
  it("build failure → 400 withdraw_prebroadcast_failed terminal (fresh clientRequestId guidance), zero sends", async () => {
    h.exec.mode = "build_failed";
    const r = await withdraw(CRID);
    expect(r.http).toBe(400);
    expect(r.body.terminal).toBe(true);
    expect(r.body.step).toBe("withdraw_prebroadcast_failed");
    noTxBytes(r);
    const op = opByCrid(CRID);
    expect(op.status).toBe("failed");
    expect(op.txSignatures).toEqual([]);
    expect(h.exec.sendCount).toBe(0);
  });

  it("precommit store failure → not_broadcast → 400 terminal, SANITIZED body (detail persisted server-side only); zero sends", async () => {
    h.store.fail.precommit = true;
    const r = await withdraw(CRID);
    expect(r.http).toBe(400);
    expect(r.body.step).toBe("withdraw_prebroadcast_failed");
    expect(String(r.body.error)).toContain("not broadcast");
    // Detailed cause is preserved on the row for operators, never in the body.
    expect(opByCrid(CRID).error).toBeTruthy();
    expect(h.exec.sendCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Balance gate (matrix 7) — exact boundary passes
// ---------------------------------------------------------------------------

describe("balance gate", () => {
  it("balance EXACTLY amount + reserve passes", async () => {
    h.readers.balance.mockResolvedValue(BigInt(LAMPORTS) + SOL_WITHDRAW_RESERVE_LAMPORTS);
    const r = await withdraw(CRID);
    expect(r.http).toBe(200);
    expect(h.exec.sendCount).toBe(1);
  });

  it("balance one lamport short → 400 withdraw_prebroadcast_failed; replay answers the stored terminal without re-reading the chain", async () => {
    h.readers.balance.mockResolvedValue(BigInt(LAMPORTS) + SOL_WITHDRAW_RESERVE_LAMPORTS - 1n);
    const r = await withdraw(CRID);
    expect(r.http).toBe(400);
    expect(r.body.terminal).toBe(true);
    expect(r.body.step).toBe("withdraw_prebroadcast_failed");
    expect(h.exec.calls).toBe(0);

    h.readers.balance.mockClear();
    const r2 = await withdraw(CRID);
    expect(r2.http).toBe(400);
    expect(r2.body.step).toBe("withdraw_prebroadcast_failed");
    expect(h.readers.balance).not.toHaveBeenCalled(); // stored terminal, no new gates
    expect(h.exec.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// UMK / key gates (matrix 8) — op survives for the SAME clientRequestId
// ---------------------------------------------------------------------------

describe("UMK and key gates", () => {
  it("UMK missing → 400 re-key with pending:true; the SAME clientRequestId resumes to success after re-keying", async () => {
    h.session.umkMode = "null";
    const r = await withdraw(CRID);
    expect(r.http).toBe(400);
    expect(r.body.pending).toBe(true);
    expect(String(r.body.error)).toContain("re-key");
    expect(opByCrid(CRID).status).toBe("pending");
    expect(h.exec.calls).toBe(0);

    h.session.umkMode = "ok";
    const r2 = await withdraw(CRID);
    expect(r2.http).toBe(200);
    expect(h.exec.sendCount).toBe(1);
    expect(h.store.equityEvents).toHaveLength(1);
  });

  it("agent key decrypt failure → 400 re-key; UMK handle still cleaned up", async () => {
    h.session.keyMode = "null";
    const r = await withdraw(CRID);
    expect(r.http).toBe(400);
    expect(r.body.pending).toBe(true);
    expect(h.session.umkCleanups).toBe(1);
    expect(h.exec.calls).toBe(0);
    expect(opByCrid(CRID).status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// Post-broadcast verdicts on resume (matrix 9) — evidence exists, NEVER re-execute
// ---------------------------------------------------------------------------

describe("write-ahead resume verdicts", () => {
  it("landed → finalizes: 200, ONE equity event, executor NEVER re-entered", async () => {
    seedEvidenceOp(CRID);
    const r = await withdraw(CRID);

    expect(r.http).toBe(200);
    expect(r.body.signature).toBe(h.sigFor(CRID));
    expect(h.exec.calls).toBe(0); // at-most-once: evidence rows never re-execute
    expect(h.store.equityEvents).toHaveLength(1);
    expect(opByCrid(CRID).status).toBe("succeeded");
  });

  it("on-chain failure → 400 withdraw_failed_onchain terminal with the persisted signature", async () => {
    seedEvidenceOp(CRID);
    h.readers.sigStatus.mockResolvedValue({ err: { InstructionError: [0, 1] }, confirmationStatus: "finalized" });

    const r = await withdraw(CRID);
    expect(r.http).toBe(400);
    expect(r.body.step).toBe("withdraw_failed_onchain");
    expect(r.body.signature).toBe(h.sigFor(CRID));
    expect(opByCrid(CRID).status).toBe("failed");
    expect(h.store.equityEvents).toHaveLength(0);
    expect(h.exec.calls).toBe(0);
  });

  it("expired (strictly beyond lvbh + slack) → 400 withdraw_expired terminal", async () => {
    seedEvidenceOp(CRID);
    h.readers.sigStatus.mockResolvedValue(null);
    h.readers.blockHeight.mockResolvedValue(h.LVBH + SOL_WITHDRAW_EXPIRY_SLACK_BLOCKS + 1);

    const r = await withdraw(CRID);
    expect(r.http).toBe(400);
    expect(r.body.step).toBe("withdraw_expired");
    expect(opByCrid(CRID).status).toBe("failed");
    expect(h.exec.calls).toBe(0);
  });

  it("still within the window (height == lvbh + slack) → 202 with signature, breadcrumb only, row stays pending", async () => {
    seedEvidenceOp(CRID);
    h.readers.sigStatus.mockResolvedValue(null);
    h.readers.blockHeight.mockResolvedValue(h.LVBH + SOL_WITHDRAW_EXPIRY_SLACK_BLOCKS);

    const r = await withdraw(CRID);
    expect(r.http).toBe(202);
    expect(r.body.signature).toBe(h.sigFor(CRID));
    const op = opByCrid(CRID);
    expect(op.status).toBe("pending");
    expect(op.step).toBe("withdraw_still_valid");
    expect(h.exec.calls).toBe(0);
  });

  it("processed level → 202, breadcrumb withdraw_still_valid (per contract: nonterminal status = still_valid), row stays pending", async () => {
    seedEvidenceOp(CRID);
    h.readers.sigStatus.mockResolvedValue({ err: null, confirmationStatus: "processed" });

    const r = await withdraw(CRID);
    expect(r.http).toBe(202);
    const op = opByCrid(CRID);
    expect(op.status).toBe("pending");
    expect(op.step).toBe("withdraw_still_valid");
    expect(op.metadata.lastReconcileVerdict).toBe("still_valid");
    expect(h.exec.calls).toBe(0);
  });

  it("status read failure during reconcile → 202, breadcrumb withdraw_unverifiable, nothing terminalized", async () => {
    seedEvidenceOp(CRID);
    h.readers.sigStatus.mockRejectedValue(new Error("rpc down"));

    const r = await withdraw(CRID);
    expect(r.http).toBe(202);
    const op = opByCrid(CRID);
    expect(op.status).toBe("pending");
    expect(op.step).toBe("withdraw_unverifiable");
    expect(op.metadata.lastReconcileVerdict).toBe("unverifiable");
    expect(h.exec.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Live ambiguous + lost-ack roll-forward (matrix 10)
// ---------------------------------------------------------------------------

describe("ambiguous broadcast and lost-ack recovery", () => {
  it("ambiguous send → 202 with the precommitted signature + breadcrumb; retry reconciles to success with ONE total send", async () => {
    h.exec.mode = "ambiguous";
    const r = await withdraw(CRID);

    expect(r.http).toBe(202);
    expect(r.body.signature).toBe(h.sigFor(CRID));
    noTxBytes(r);
    const op = opByCrid(CRID);
    expect(op.status).toBe("pending");
    expect(op.step).toBe("withdraw_ambiguous");
    expect(op.metadata.lastAmbiguousError).toContain("ws closed");

    h.exec.mode = "confirmed"; // irrelevant: retry must NOT re-execute
    const r2 = await withdraw(CRID);
    expect(r2.http).toBe(200);
    expect(h.exec.sendCount).toBe(1);
    expect(h.exec.calls).toBe(1);
    expect(h.store.equityEvents).toHaveLength(1);
  });

  it("failed_on_chain from the live executor → 400 terminal with signature; no equity event", async () => {
    h.exec.mode = "failed_on_chain";
    const r = await withdraw(CRID);

    expect(r.http).toBe(400);
    expect(r.body.step).toBe("withdraw_failed_onchain");
    expect(r.body.signature).toBe(h.sigFor(CRID));
    expect(opByCrid(CRID).status).toBe("failed");
    expect(h.store.equityEvents).toHaveLength(0);
  });

  it("finalize failure after a landed transfer → 202 (landed, recording pending); retry rolls forward to 200 with ONE equity event", async () => {
    h.store.fail.finalize = true;
    const r = await withdraw(CRID);
    expect(r.http).toBe(202);
    expect(r.body.signature).toBe(h.sigFor(CRID));
    expect(h.exec.sendCount).toBe(1);
    expect(h.store.equityEvents).toHaveLength(0);

    h.store.fail.finalize = false;
    const r2 = await withdraw(CRID);
    expect(r2.http).toBe(200);
    expect(h.exec.sendCount).toBe(1); // reconciled, not re-sent
    expect(h.store.equityEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Same-clientRequestId race (matrix 11) — exactly one transfer, one ledger entry
// ---------------------------------------------------------------------------

describe("concurrency", () => {
  it("two concurrent requests with the SAME clientRequestId → ONE send, ONE equity event, both callers get success", async () => {
    const [a, b] = await Promise.all([withdraw(CRID), withdraw(CRID)]);

    expect(h.exec.sendCount).toBe(1);
    expect(h.store.equityEvents).toHaveLength(1);
    expect([...h.store.ops.values()].filter((o) => o.clientRequestId === CRID)).toHaveLength(1);
    for (const r of [a, b]) {
      expect(r.http).toBe(200);
      expect(r.body.signature).toBe(h.sigFor(CRID));
      noTxBytes(r);
    }
  });

  it("two concurrent requests with DIFFERENT clientRequestIds → never more than one send (conflict gates fail closed)", async () => {
    const [a, b] = await Promise.all([withdraw("crid-A"), withdraw("crid-B")]);

    expect(h.exec.sendCount).toBeLessThanOrEqual(1);
    expect(h.store.equityEvents.length).toBeLessThanOrEqual(1);
    const successes = [a, b].filter((r) => r.http === 200);
    expect(successes.length).toBeLessThanOrEqual(1);
    for (const r of [a, b]) noTxBytes(r);
  });
});

// ---------------------------------------------------------------------------
// Duplicate-signature backstop (matrix 12)
// ---------------------------------------------------------------------------

describe("duplicate-signature backstop", () => {
  it("a TERMINAL sibling already owning the would-be signature blocks the precommit → 400 terminal, zero sends", async () => {
    const newCrid = "crid-dup";
    h.store.addOp({
      walletAddress: WALLET,
      operationType: "agent_sol_withdraw",
      status: "succeeded", // terminal → passes the conflict gate
      clientRequestId: "old-crid",
      txSignatures: [h.sigFor(newCrid)],
      metadata: { withdrawTxSignature: h.sigFor(newCrid) },
    });

    const r = await withdraw(newCrid);
    expect(r.http).toBe(400);
    expect(r.body.terminal).toBe(true);
    expect(r.body.step).toBe("withdraw_prebroadcast_failed");
    // Body is stable/sanitized (WO Build 8.3); the rejection enum is preserved
    // server-side on the persisted row for operators.
    expect(String(r.body.error)).toContain("not broadcast");
    expect(String(r.body.error)).not.toContain("duplicate_signature");
    expect(String(opByCrid(newCrid).error)).toContain("duplicate_signature");
    noTxBytes(r);

    expect(h.exec.sendCount).toBe(0);
    expect(opByCrid(newCrid).txSignatures).toEqual([]);
    expect(h.store.equityEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Malformed persisted provenance → fail CLOSED (matrix 14)
// ---------------------------------------------------------------------------

describe("malformed provenance fails closed", () => {
  const variants: Array<{ label: string; mutate: (op: any) => void }> = [
    {
      label: "meta signature present but txSignatures empty",
      mutate: (op) => {
        op.txSignatures = [];
      },
    },
    {
      label: "last txSignatures entry differs from the meta signature",
      mutate: (op) => {
        op.txSignatures = ["some-other-sig"];
      },
    },
    {
      label: "null meta signature (evidence present, identity unusable)",
      mutate: (op) => {
        op.metadata.withdrawTxSignature = null;
      },
    },
    {
      label: "zero pinned lamports",
      mutate: (op) => {
        op.metadata.requestedLamports = "0";
      },
    },
    {
      label: "non-numeric pinned lamports",
      mutate: (op) => {
        op.metadata.requestedLamports = "abc";
      },
    },
    {
      label: "destination differs from the op wallet",
      mutate: (op) => {
        op.metadata.destinationWallet = "SomeOtherWallet";
      },
    },
    {
      label: "missing blockhash",
      mutate: (op) => {
        delete op.metadata.withdrawBlockhash;
      },
    },
    {
      label: "non-positive lastValidBlockHeight",
      mutate: (op) => {
        op.metadata.withdrawLastValidBlockHeight = 0;
      },
    },
  ];

  it.each(variants)("$label → 409 manual review; ZERO RPC probes, ZERO writes, NEVER auto-failed", async ({ mutate }) => {
    const op = seedEvidenceOp(CRID);
    mutate(op);
    const stepBefore = op.step;
    const statusBefore = op.status;

    const r = await withdraw(CRID);

    expect(r.http).toBe(409);
    expect(r.body.manualReview).toBe(true);
    expect(r.body.pending).toBe(true);
    noTxBytes(r);

    const after = opByCrid(CRID);
    expect(after.status).toBe(statusBefore); // never auto-terminalized
    expect(after.step).toBe(stepBefore); // zero writes
    expect(h.readers.sigStatus).not.toHaveBeenCalled(); // zero RPC
    expect(h.readers.blockHeight).not.toHaveBeenCalled();
    expect(h.exec.calls).toBe(0); // and certainly no re-execution
    expect(h.store.equityEvents).toHaveLength(0);
  });

  it("selectWithdrawProvenance itself rejects a coherent-looking row whose destination was tampered", () => {
    const op = seedEvidenceOp(CRID);
    op.metadata.destinationWallet = "Attacker";
    expect(selectWithdrawProvenance(op as any)).toEqual({ valid: false });
  });
});

// ---------------------------------------------------------------------------
// Neutralized legacy confirm endpoint (matrix 15)
// ---------------------------------------------------------------------------

describe("handleConfirmSolWithdraw (neutralized)", () => {
  it("legacy body without clientRequestId → 410 migrated; a spoofed ledger write is impossible", async () => {
    const r = await handleConfirmSolWithdraw(WALLET, { amount: 0.5, txSignature: "spoofed-sig" });
    expect(r.http).toBe(410);
    expect(r.body.migrated).toBe(true);
    expect(h.store.equityEvents).toHaveLength(0);
    expect(h.store.ops.size).toBe(0);
  });

  it("unknown clientRequestId → 404", async () => {
    const r = await handleConfirmSolWithdraw(WALLET, { clientRequestId: "nope" });
    expect(r.http).toBe(404);
  });

  it("clientRequestId owned by a different op type → 404", async () => {
    h.store.addOp({
      walletAddress: WALLET,
      operationType: "loop_hop",
      clientRequestId: "loop-crid",
      status: "pending",
    });
    const r = await handleConfirmSolWithdraw(WALLET, { clientRequestId: "loop-crid" });
    expect(r.http).toBe(404);
  });

  it("succeeded withdrawal → 200 normalized from the stored result with ZERO writes and ZERO RPC", async () => {
    await withdraw(CRID);
    h.readers.sigStatus.mockClear();
    h.readers.blockHeight.mockClear();

    const r = await handleConfirmSolWithdraw(WALLET, { clientRequestId: CRID });
    expect(r.http).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.signature).toBe(h.sigFor(CRID));
    noTxBytes(r);

    expect(h.readers.sigStatus).not.toHaveBeenCalled();
    expect(h.readers.blockHeight).not.toHaveBeenCalled();
    expect(h.store.equityEvents).toHaveLength(1); // unchanged
    expect(h.exec.calls).toBe(1); // unchanged
  });

  it("pending withdrawal with a coherent write-ahead → 202 carrying the persisted signature; row untouched", async () => {
    seedEvidenceOp(CRID);
    const r = await handleConfirmSolWithdraw(WALLET, { clientRequestId: CRID });
    expect(r.http).toBe(202);
    expect(r.body.pending).toBe(true);
    expect(r.body.signature).toBe(h.sigFor(CRID));
    expect(opByCrid(CRID).step).toBe("withdraw_sig_writeahead");
  });

  it("clean pending intent → 202 without a signature", async () => {
    h.store.addOp({
      walletAddress: WALLET,
      operationType: "agent_sol_withdraw",
      clientRequestId: CRID,
      step: "intent_created",
      metadata: {
        requestedLamports: String(LAMPORTS),
        destinationWallet: WALLET,
        sourceAgentPublicKey: "AGENT_PK_1",
      },
    });
    const r = await handleConfirmSolWithdraw(WALLET, { clientRequestId: CRID });
    expect(r.http).toBe(202);
    expect(r.body.signature).toBeUndefined();
  });

  it("lookup failure → 202 retryable, never 500", async () => {
    h.store.fail.getByCrid = true;
    const r = await handleConfirmSolWithdraw(WALLET, { clientRequestId: CRID });
    expect(r.http).toBe(202);
  });
});
