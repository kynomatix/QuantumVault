/**
 * tests/vault/agent-sol-withdraw-storage.test.ts — WO2B2B
 *
 * Storage-layer contract for the durable agent-SOL withdrawal state machine
 * (REAL DatabaseStorage methods against a scripted server/db mock):
 *
 *  - getOrCreateAgentSolWithdrawIntent — race-safe INSERT … ON CONFLICT DO
 *    NOTHING + adopt-on-conflict; the pinned trio is persisted at intent time.
 *  - precommitAgentSolWithdrawSignature — per-wallet advisory lock taken
 *    BEFORE the FOR UPDATE row read; full rejection ladder (not_found →
 *    wallet_mismatch → wrong_type → not_pending → pinned_mismatch →
 *    already_signed → amount_mismatch → signer_rotated → conflict →
 *    duplicate_signature); BigInt-exact amount compare (±1 lamport and the
 *    2^53 float trap); write-ahead appends signature + broadcast identity +
 *    re-asserted pins in ONE update with step withdraw_sig_writeahead.
 *  - transitionAgentSolWithdraw — single guarded UPDATE; requireNoSignature
 *    adds the FOUR widened (WO2B2C-A2) no-evidence predicates — signature
 *    pin, blockhash pin, lastValidBlockHeight pin, empty txSignatures —
 *    identical to hasBroadcastIdentityEvidence; requireSignature binds to the exact
 *    persisted signature; false (no write matched) when the guard misses.
 *  - finalizeAgentSolWithdrawSuccess — same lock discipline; provenance
 *    re-verified INSIDE the lock (malformed → not_finalized, ZERO writes);
 *    BigInt half-up lamports→6dp SOL ledger math; status flip + equity event
 *    in the SAME transaction (insert failure propagates → rollback).
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { inspect } from "node:util";

// ---------------------------------------------------------------------------
// Mock server/db BEFORE importing storage (vi.hoisted for the spies).
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => ({
  dbInsert: vi.fn(),
  dbUpdate: vi.fn(),
  dbSelect: vi.fn(),
  dbTransaction: vi.fn(),
}));

vi.mock("../../server/db", () => ({
  db: {
    insert: h.dbInsert,
    update: h.dbUpdate,
    select: h.dbSelect,
    transaction: h.dbTransaction,
  },
  pool: {
    connect: vi.fn(() =>
      Promise.resolve({ release: vi.fn(), query: vi.fn(() => ({ rows: [] })) })
    ),
  },
  ensureSchema: vi.fn(),
  checkUmkStorageSecretHealth: vi.fn(),
}));

import {
  DatabaseStorage,
  AGENT_SOL_WITHDRAW_LOCK_NAMESPACE,
  AGENT_SOL_WITHDRAW_OP_TYPE,
} from "../../server/storage";

// ---------------------------------------------------------------------------
// Chainable recording query-builder stubs
// ---------------------------------------------------------------------------
type ChainCall = { method: string; args: unknown[] };

function makeChain(result: unknown, log?: ChainCall[]) {
  const p = Promise.resolve(result);
  const chain: any = new Proxy(
    {},
    {
      get(_t, prop: string | symbol) {
        if (prop === "then") return p.then.bind(p);
        if (prop === "catch") return p.catch.bind(p);
        if (prop === "finally") return p.finally.bind(p);
        return (...args: unknown[]) => {
          log?.push({ method: String(prop), args });
          return chain;
        };
      },
    }
  );
  return chain;
}

function makeRejectedChain(err: Error, log?: ChainCall[]) {
  const p = Promise.reject(err);
  p.catch(() => {}); // arm a no-op guard so vitest never sees an unhandled rejection
  const chain: any = new Proxy(
    {},
    {
      get(_t, prop: string | symbol) {
        if (prop === "then") return p.then.bind(p);
        if (prop === "catch") return p.catch.bind(p);
        if (prop === "finally") return p.finally.bind(p);
        return (...args: unknown[]) => {
          log?.push({ method: String(prop), args });
          return chain;
        };
      },
    }
  );
  return chain;
}

/** Serialize any drizzle SQL object / plain payload for containment probes. */
function probe(x: unknown): string {
  try {
    const s = JSON.stringify(x);
    if (s !== undefined) return s;
  } catch {
    /* bigint / circular → fall through */
  }
  return inspect(x, { depth: 30 });
}

function findCall(log: ChainCall[], method: string): ChainCall {
  const c = log.find((e) => e.method === method);
  expect(c, `expected builder call .${method}()`).toBeDefined();
  return c!;
}

// ---------------------------------------------------------------------------
// Transaction harness (precommit + finalize)
// ---------------------------------------------------------------------------
function makeTx(opts: {
  selects: unknown[][];
  updateRows?: unknown[];
  insertError?: Error;
}) {
  const updateLog: ChainCall[] = [];
  const insertLog: ChainCall[] = [];
  const firstSelectLog: ChainCall[] = [];
  const execute = vi.fn(async () => ({ rows: [] }));
  const select = vi.fn();
  opts.selects.forEach((rows, i) => {
    select.mockReturnValueOnce(makeChain(rows, i === 0 ? firstSelectLog : undefined));
  });
  select.mockReturnValue(makeChain([]));
  const update = vi.fn(() => makeChain(opts.updateRows ?? [], updateLog));
  const insert = vi.fn(() =>
    opts.insertError ? makeRejectedChain(opts.insertError, insertLog) : makeChain([], insertLog)
  );
  const tx = { execute, select, update, insert, updateLog, insertLog, firstSelectLog };
  h.dbTransaction.mockImplementationOnce(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));
  return tx;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const WALLET = "WalletStorageTest111111111111111111111111111";
const AGENT = "AgentPkStorageTest11111111111111111111111111";
const OP_ID = "op-sol-storage-11111111";
const CRID = "crid-storage-test-1";
const SIG = "SigStorageBase58Withdraw11111111111111111111";
const LAMPORTS_STR = "47500000";

const pins = () => ({
  requestedLamports: LAMPORTS_STR,
  destinationWallet: WALLET,
  sourceAgentPublicKey: AGENT,
});

const baseOp = (over: Record<string, unknown> = {}) => ({
  id: OP_ID,
  walletAddress: WALLET,
  borrowPositionId: null,
  operationType: "agent_sol_withdraw",
  status: "pending",
  step: "intent_created",
  clientRequestId: CRID,
  txSignatures: [] as unknown,
  metadata: pins() as Record<string, unknown>,
  error: null,
  result: null,
  ...over,
});

const evidenceOp = (
  over: Record<string, unknown> = {},
  metaOver: Record<string, unknown> = {}
) =>
  baseOp({
    step: "withdraw_sig_writeahead",
    txSignatures: [SIG],
    metadata: {
      ...pins(),
      withdrawTxSignature: SIG,
      withdrawBlockhash: "BlockhashStorage111",
      withdrawLastValidBlockHeight: 351_000_123,
      ...metaOver,
    },
    ...over,
  });

const walletRow = (over: Record<string, unknown> = {}) => ({
  address: WALLET,
  agentPublicKey: AGENT,
  ...over,
});

const sib = (over: Record<string, unknown> = {}) => ({
  id: "op-sibling-1",
  walletAddress: WALLET,
  operationType: "agent_sol_withdraw",
  status: "succeeded",
  txSignatures: [] as unknown,
  metadata: {} as Record<string, unknown>,
  ...over,
});

function precommitParams(overrides: {
  signedDest?: string;
  signedSource?: string;
  precommit?: Record<string, unknown>;
} = {}) {
  return {
    operationId: OP_ID,
    walletAddress: WALLET,
    signedSourceAgentPublicKey: overrides.signedSource ?? AGENT,
    signedDestinationWallet: overrides.signedDest ?? WALLET,
    precommit: {
      signature: SIG,
      blockhash: "BlockhashStorage111",
      lastValidBlockHeight: 351_000_123,
      lamports: 47_500_000,
      ...(overrides.precommit ?? {}),
    },
  };
}

function makeStorage() {
  return new DatabaseStorage();
}

beforeEach(() => {
  h.dbInsert.mockReset();
  h.dbUpdate.mockReset();
  h.dbSelect.mockReset();
  h.dbTransaction.mockReset();
});

// ---------------------------------------------------------------------------
// [0] Exported constants
// ---------------------------------------------------------------------------
describe("[0] constants", () => {
  it("pins the advisory-lock namespace and the op type", () => {
    expect(AGENT_SOL_WITHDRAW_LOCK_NAMESPACE).toBe(927411);
    expect(AGENT_SOL_WITHDRAW_OP_TYPE).toBe("agent_sol_withdraw");
  });
});

// ---------------------------------------------------------------------------
// [1] getOrCreateAgentSolWithdrawIntent
// ---------------------------------------------------------------------------
describe("[1] getOrCreateAgentSolWithdrawIntent", () => {
  it("creates the intent row with the full pinned trio, status pending, step intent_created", async () => {
    const created = baseOp();
    const log: ChainCall[] = [];
    h.dbInsert.mockReturnValueOnce(makeChain([created], log));

    const storage = makeStorage();
    const out = await storage.getOrCreateAgentSolWithdrawIntent({
      walletAddress: WALLET,
      clientRequestId: CRID,
      pinned: {
        requestedLamports: LAMPORTS_STR,
        destinationWallet: WALLET,
        sourceAgentPublicKey: AGENT,
      },
    });

    expect(out.created).toBe(true);
    expect(out.operation).toBe(created);

    const values = findCall(log, "values").args[0] as Record<string, any>;
    expect(values).toMatchObject({
      walletAddress: WALLET,
      borrowPositionId: null,
      operationType: "agent_sol_withdraw",
      status: "pending",
      step: "intent_created",
      clientRequestId: CRID,
      metadata: {
        requestedLamports: LAMPORTS_STR,
        destinationWallet: WALLET,
        sourceAgentPublicKey: AGENT,
      },
    });
    // Race-safe insert shape: conflict-tolerant + returning
    expect(log.some((c) => c.method === "onConflictDoNothing")).toBe(true);
    expect(log.some((c) => c.method === "returning")).toBe(true);
  });

  it("adopts the existing row on conflict (created:false) via the wallet-scoped crid lookup", async () => {
    h.dbInsert.mockReturnValueOnce(makeChain([])); // conflict → no row returned
    const existing = baseOp({ step: "withdraw_sig_writeahead" });

    const storage = makeStorage();
    const reselect = vi
      .spyOn(storage, "getBorrowOperationByClientRequestId")
      .mockResolvedValue(existing as any);

    const out = await storage.getOrCreateAgentSolWithdrawIntent({
      walletAddress: WALLET,
      clientRequestId: CRID,
      pinned: {
        requestedLamports: LAMPORTS_STR,
        destinationWallet: WALLET,
        sourceAgentPublicKey: AGENT,
      },
    });

    expect(out.created).toBe(false);
    expect(out.operation).toBe(existing);
    expect(reselect).toHaveBeenCalledWith(WALLET, CRID);
  });

  it("throws loudly when the insert conflicts but the reselect finds nothing", async () => {
    h.dbInsert.mockReturnValueOnce(makeChain([]));
    const storage = makeStorage();
    vi.spyOn(storage, "getBorrowOperationByClientRequestId").mockResolvedValue(undefined as any);

    await expect(
      storage.getOrCreateAgentSolWithdrawIntent({
        walletAddress: WALLET,
        clientRequestId: CRID,
        pinned: {
          requestedLamports: LAMPORTS_STR,
          destinationWallet: WALLET,
          sourceAgentPublicKey: AGENT,
        },
      })
    ).rejects.toThrow(/no row exists/);
  });
});

// ---------------------------------------------------------------------------
// [2] precommitAgentSolWithdrawSignature — lock discipline + happy path
// ---------------------------------------------------------------------------
describe("[2] precommit — advisory lock + write-ahead", () => {
  it("takes the per-wallet advisory lock BEFORE the FOR UPDATE row read, then write-aheads once", async () => {
    const tx = makeTx({
      selects: [[baseOp()], [walletRow()], [baseOp()]], // op, wallet, siblings (self only → skipped)
      updateRows: [baseOp({ step: "withdraw_sig_writeahead" })],
    });

    const storage = makeStorage();
    const out = await storage.precommitAgentSolWithdrawSignature(precommitParams());

    expect(out.won).toBe(true);
    if (out.won) expect((out.operation as any).step).toBe("withdraw_sig_writeahead");

    // Lock first: pg_advisory_xact_lock(927411, hashtext(wallet)) before ANY select.
    expect(tx.execute).toHaveBeenCalledTimes(1);
    const lockSql = probe(tx.execute.mock.calls[0][0]);
    expect(lockSql).toContain("pg_advisory_xact_lock");
    expect(lockSql).toContain("hashtext");
    expect(lockSql).toContain("927411");
    expect(lockSql).toContain(WALLET);
    expect(tx.execute.mock.invocationCallOrder[0]).toBeLessThan(
      tx.select.mock.invocationCallOrder[0]
    );

    // Row read is FOR UPDATE with LIMIT 1.
    expect(tx.firstSelectLog.some((c) => c.method === "for" && c.args[0] === "update")).toBe(true);
    expect(tx.firstSelectLog.some((c) => c.method === "limit" && c.args[0] === 1)).toBe(true);

    // ONE update: signature append + broadcast identity + re-asserted pins + step.
    expect(tx.update).toHaveBeenCalledTimes(1);
    const sets = findCall(tx.updateLog, "set").args[0] as Record<string, any>;
    expect(sets.step).toBe("withdraw_sig_writeahead");
    expect(probe(sets.txSignatures)).toContain(SIG);
    const metaProbe = probe(sets.metadata);
    expect(metaProbe).toContain(SIG);
    expect(metaProbe).toContain("BlockhashStorage111");
    expect(metaProbe).toContain("351000123");
    expect(metaProbe).toContain(LAMPORTS_STR);
    expect(metaProbe).toContain(WALLET);
    expect(metaProbe).toContain(AGENT);
  });
});

// ---------------------------------------------------------------------------
// [3] precommit — rejection ladder (zero writes on every rejection)
// ---------------------------------------------------------------------------
describe("[3] precommit rejection ladder", () => {
  async function run(
    opRows: unknown[],
    opts: {
      walletRows?: unknown[];
      siblingRows?: unknown[];
      params?: Parameters<typeof precommitParams>[0];
    } = {}
  ) {
    const tx = makeTx({
      selects: [opRows, opts.walletRows ?? [walletRow()], opts.siblingRows ?? []],
    });
    const storage = makeStorage();
    const out = await storage.precommitAgentSolWithdrawSignature(
      precommitParams(opts.params ?? {})
    );
    return { tx, out };
  }

  it("not_found when the op row is missing (lock still taken)", async () => {
    const { tx, out } = await run([]);
    expect(out).toEqual({ won: false, reason: "not_found" });
    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("wallet_mismatch when the row belongs to a different wallet", async () => {
    const { tx, out } = await run([baseOp({ walletAddress: "OtherWallet999" })]);
    expect(out.won).toBe(false);
    if (!out.won) expect(out.reason).toBe("wallet_mismatch");
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("wrong_type when the row is not an agent_sol_withdraw op", async () => {
    const { out } = await run([baseOp({ operationType: "loop_hop" })]);
    if (!out.won) expect(out.reason).toBe("wrong_type");
    expect(out.won).toBe(false);
  });

  it.each(["succeeded", "completed", "failed", "parked"])(
    "not_pending when status is %s",
    async (status) => {
      const { tx, out } = await run([baseOp({ status })]);
      expect(out.won).toBe(false);
      if (!out.won) expect(out.reason).toBe("not_pending");
      expect(tx.update).not.toHaveBeenCalled();
    }
  );

  const pinnedMismatchCases: Array<{
    label: string;
    meta?: Record<string, unknown>;
    params?: Parameters<typeof precommitParams>[0];
  }> = [
    { label: "metadata entirely empty", meta: {} },
    { label: "pinned lamports '0'", meta: { ...pins(), requestedLamports: "0" } },
    { label: "pinned lamports negative", meta: { ...pins(), requestedLamports: "-5" } },
    { label: "pinned lamports non-numeric", meta: { ...pins(), requestedLamports: "abc" } },
    { label: "pinned lamports empty string", meta: { ...pins(), requestedLamports: "" } },
    {
      label: "pinned lamports is a number, not a string",
      meta: { ...pins(), requestedLamports: 47_500_000 },
    },
    {
      label: "pinned destination differs from the signed destination",
      meta: { ...pins(), destinationWallet: "OtherDestWallet" },
    },
    { label: "pinned source empty", meta: { ...pins(), sourceAgentPublicKey: "" } },
    {
      label: "pinned source missing",
      meta: { requestedLamports: LAMPORTS_STR, destinationWallet: WALLET },
    },
    {
      label: "signed destination param differs from the pins",
      params: { signedDest: "ElsewhereWallet111" },
    },
    {
      label: "signed source param differs from the pins",
      params: { signedSource: "ElsewhereAgent111" },
    },
  ];

  it.each(pinnedMismatchCases)("pinned_mismatch: $label", async ({ meta, params }) => {
    const { tx, out } = await run([baseOp(meta !== undefined ? { metadata: meta } : {})], {
      params,
    });
    expect(out.won).toBe(false);
    if (!out.won) expect(out.reason).toBe("pinned_mismatch");
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("already_signed when txSignatures is non-empty", async () => {
    const { tx, out } = await run([baseOp({ txSignatures: ["sig-old"] })]);
    expect(out.won).toBe(false);
    if (!out.won) expect(out.reason).toBe("already_signed");
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("already_signed when metadata.withdrawTxSignature exists even with empty txSignatures", async () => {
    const { out } = await run([
      baseOp({ metadata: { ...pins(), withdrawTxSignature: "sig-old" } }),
    ]);
    expect(out.won).toBe(false);
    if (!out.won) expect(out.reason).toBe("already_signed");
  });

  it.each([
    { label: "one lamport UNDER the pin", lamports: 47_499_999 },
    { label: "one lamport OVER the pin", lamports: 47_500_001 },
    { label: "fractional lamports (BigInt reject)", lamports: 47_500_000.5 },
  ])("amount_mismatch: $label", async ({ lamports }) => {
    const { tx, out } = await run([baseOp()], { params: { precommit: { lamports } } });
    expect(out.won).toBe(false);
    if (!out.won) expect(out.reason).toBe("amount_mismatch");
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("amount compare is BigInt-exact: 2^53 float trap does NOT false-match 2^53+1", async () => {
    // parseFloat('9007199254740993') === 9007199254740992 — a float compare
    // would false-pass here. The BigInt compare must reject.
    const { out } = await run(
      [baseOp({ metadata: { ...pins(), requestedLamports: "9007199254740993" } })],
      { params: { precommit: { lamports: 9_007_199_254_740_992 } } }
    );
    expect(out.won).toBe(false);
    if (!out.won) expect(out.reason).toBe("amount_mismatch");
  });

  it("signer_rotated when the wallet row is missing", async () => {
    const { tx, out } = await run([baseOp()], { walletRows: [] });
    expect(out.won).toBe(false);
    if (!out.won) expect(out.reason).toBe("signer_rotated");
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("signer_rotated when the wallet's CURRENT agent key differs from the pin", async () => {
    const { out } = await run([baseOp()], {
      walletRows: [walletRow({ agentPublicKey: "RotatedAgentPk999" })],
    });
    expect(out.won).toBe(false);
    if (!out.won) expect(out.reason).toBe("signer_rotated");
  });

  const conflictCases: Array<{ label: string; sibling: Record<string, unknown> }> = [
    { label: "PENDING sibling withdrawal", sibling: sib({ status: "pending" }) },
    {
      label: "RECOVERING loop_hop sibling",
      sibling: sib({ operationType: "loop_hop", status: "recovering" }),
    },
    {
      label: "PARKED loop_hop sibling (unknown-to-allowlist status fails closed)",
      sibling: sib({ operationType: "loop_hop", status: "parked" }),
    },
    { label: "NEEDS_ATTENTION sibling withdrawal", sibling: sib({ status: "needs_attention" }) },
    { label: "NULL-status sibling withdrawal (malformed row blocks)", sibling: sib({ status: null }) },
  ];

  it.each(conflictCases)("conflict: $label", async ({ sibling }) => {
    const { tx, out } = await run([baseOp()], { siblingRows: [baseOp(), sibling] });
    expect(out.won).toBe(false);
    if (!out.won) expect(out.reason).toBe("conflict");
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("terminal siblings and non-withdraw/non-hop op types never conflict (self row skipped)", async () => {
    const tx = makeTx({
      selects: [
        [baseOp()],
        [walletRow()],
        [
          baseOp(), // the row itself — must be skipped by id
          sib({ status: "succeeded" }),
          sib({ id: "s2", operationType: "loop_hop", status: "failed" }),
          sib({ id: "s3", operationType: "loop_hop", status: "completed" }),
          sib({ id: "s4", operationType: "borrow_open", status: "pending" }), // foreign type
        ],
      ],
      updateRows: [baseOp({ step: "withdraw_sig_writeahead" })],
    });
    const storage = makeStorage();
    const out = await storage.precommitAgentSolWithdrawSignature(precommitParams());
    expect(out.won).toBe(true);
    expect(tx.update).toHaveBeenCalledTimes(1);
  });

  it("duplicate_signature when a TERMINAL sibling withdrawal already carries the signature in txSignatures", async () => {
    const { tx, out } = await run([baseOp()], {
      siblingRows: [sib({ status: "succeeded", txSignatures: [SIG] })],
    });
    expect(out.won).toBe(false);
    if (!out.won) expect(out.reason).toBe("duplicate_signature");
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("duplicate_signature when a terminal sibling carries the signature in metadata.withdrawTxSignature", async () => {
    const { out } = await run([baseOp()], {
      siblingRows: [sib({ status: "failed", metadata: { withdrawTxSignature: SIG } })],
    });
    expect(out.won).toBe(false);
    if (!out.won) expect(out.reason).toBe("duplicate_signature");
  });

  it("duplicate-signature scan is withdraw-typed: a loop_hop sibling with the same sig does not block", async () => {
    const tx = makeTx({
      selects: [
        [baseOp()],
        [walletRow()],
        [sib({ operationType: "loop_hop", status: "completed", txSignatures: [SIG] })],
      ],
      updateRows: [baseOp({ step: "withdraw_sig_writeahead" })],
    });
    const storage = makeStorage();
    const out = await storage.precommitAgentSolWithdrawSignature(precommitParams());
    expect(out.won).toBe(true);
    expect(tx.update).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// [4] transitionAgentSolWithdraw — guarded single UPDATE
// ---------------------------------------------------------------------------
describe("[4] transitionAgentSolWithdraw", () => {
  function primeTransition(rows: unknown[]) {
    const log: ChainCall[] = [];
    h.dbUpdate.mockReturnValueOnce(makeChain(rows, log));
    return log;
  }

  it("returns true when the guard matches; sets carry status/step/error/metadata/result", async () => {
    const log = primeTransition([{ id: OP_ID }]);
    const storage = makeStorage();
    const ok = await storage.transitionAgentSolWithdraw({
      operationId: OP_ID,
      walletAddress: WALLET,
      toStatus: "failed",
      step: "withdraw_prebroadcast_failed",
      error: "gate closed",
      mergeMetadata: { probeMarker: "meta-merge-1" },
      result: { probeResult: "res-1" },
    });

    expect(ok).toBe(true);
    const sets = findCall(log, "set").args[0] as Record<string, any>;
    expect(sets.status).toBe("failed");
    expect(sets.step).toBe("withdraw_prebroadcast_failed");
    expect(sets.error).toBe("gate closed");
    expect(probe(sets.metadata)).toContain("meta-merge-1");
    expect(sets.result).toEqual({ probeResult: "res-1" });

    const where = probe(findCall(log, "where").args[0]);
    expect(where).toContain(OP_ID);
    expect(where).toContain(WALLET);
    expect(where).toContain("agent_sol_withdraw");
    expect(where).toContain("pending");
  });

  it("returns false when the guarded UPDATE matches no row", async () => {
    primeTransition([]);
    const storage = makeStorage();
    const ok = await storage.transitionAgentSolWithdraw({
      operationId: OP_ID,
      walletAddress: WALLET,
      step: "withdraw_ambiguous",
    });
    expect(ok).toBe(false);
  });

  it("step-only breadcrumb form: sets contain ONLY step + updatedAt", async () => {
    const log = primeTransition([{ id: OP_ID }]);
    const storage = makeStorage();
    await storage.transitionAgentSolWithdraw({
      operationId: OP_ID,
      walletAddress: WALLET,
      step: "withdraw_ambiguous",
    });
    const sets = findCall(log, "set").args[0] as Record<string, any>;
    expect(Object.keys(sets).sort()).toEqual(["step", "updatedAt"]);
  });

  it("requireNoSignature adds ALL FOUR widened no-evidence predicates (signature pin, blockhash pin, lastValidBlockHeight pin, empty txSignatures)", async () => {
    const log = primeTransition([{ id: OP_ID }]);
    const storage = makeStorage();
    await storage.transitionAgentSolWithdraw({
      operationId: OP_ID,
      walletAddress: WALLET,
      toStatus: "failed",
      step: "withdraw_prebroadcast_failed",
      requireNoSignature: true,
    });
    const where = probe(findCall(log, "where").args[0]);
    expect(where).toContain("withdrawTxSignature");
    expect(where).toContain("withdrawBlockhash");
    expect(where).toContain("withdrawLastValidBlockHeight");
    expect(where).toContain("jsonb_array_length");
  });

  it("A2: the DB guard INDEPENDENTLY refuses cleanup when any broadcast-identity breadcrumb matches (widened WHERE matches zero rows → false, no write)", async () => {
    // A blockhash-only anomaly means the widened predicate set matches no row:
    // the UPDATE returns nothing and the guard answers false — refusal happens
    // at the database, regardless of what any orchestration-layer classifier
    // concluded about the same row.
    const log = primeTransition([]);
    const storage = makeStorage();
    const ok = await storage.transitionAgentSolWithdraw({
      operationId: OP_ID,
      walletAddress: WALLET,
      toStatus: "failed",
      step: "withdraw_prebroadcast_failed",
      requireNoSignature: true,
    });
    expect(ok).toBe(false);
    const where = probe(findCall(log, "where").args[0]);
    expect(where).toContain("withdrawBlockhash");
    expect(where).toContain("withdrawLastValidBlockHeight");
  });

  it("requireSignature binds the guard to the exact persisted signature", async () => {
    const log = primeTransition([{ id: OP_ID }]);
    const storage = makeStorage();
    await storage.transitionAgentSolWithdraw({
      operationId: OP_ID,
      walletAddress: WALLET,
      toStatus: "failed",
      step: "withdraw_failed_on_chain",
      requireSignature: SIG,
    });
    const where = probe(findCall(log, "where").args[0]);
    expect(where).toContain(SIG);
    expect(where).not.toContain("jsonb_array_length");
  });
});

// ---------------------------------------------------------------------------
// [5] finalizeAgentSolWithdrawSuccess
// ---------------------------------------------------------------------------
describe("[5] finalizeAgentSolWithdrawSuccess", () => {
  it("finalizes atomically: lock → FOR UPDATE read → status flip + equity event in the SAME transaction", async () => {
    const updated = evidenceOp({ status: "succeeded", step: "withdraw_succeeded" });
    const tx = makeTx({ selects: [[evidenceOp()]], updateRows: [updated] });
    const storage = makeStorage();

    const out = await storage.finalizeAgentSolWithdrawSuccess({
      operationId: OP_ID,
      walletAddress: WALLET,
      expectedSignature: SIG,
    });

    expect(out.outcome).toBe("finalized");
    if (out.outcome === "finalized") expect(out.operation).toBe(updated);

    // Lock before read.
    const lockSql = probe(tx.execute.mock.calls[0][0]);
    expect(lockSql).toContain("pg_advisory_xact_lock");
    expect(lockSql).toContain("927411");
    expect(lockSql).toContain(WALLET);
    expect(tx.execute.mock.invocationCallOrder[0]).toBeLessThan(
      tx.select.mock.invocationCallOrder[0]
    );
    expect(tx.firstSelectLog.some((c) => c.method === "for" && c.args[0] === "update")).toBe(true);

    // Status flip content.
    const sets = findCall(tx.updateLog, "set").args[0] as Record<string, any>;
    expect(sets.status).toBe("succeeded");
    expect(sets.step).toBe("withdraw_succeeded");
    expect(sets.error).toBeNull();
    expect(sets.result).toMatchObject({
      signature: SIG,
      withdrawnLamports: LAMPORTS_STR,
      destinationWallet: WALLET,
      sourceAgentPublicKey: AGENT,
      withdrawnSolDisplay: "0.047500",
    });

    // Equity event in the SAME tx, negative 6dp SOL amount, no bot attribution.
    expect(tx.insert).toHaveBeenCalledTimes(1);
    const values = findCall(tx.insertLog, "values").args[0] as Record<string, any>;
    expect(values).toMatchObject({
      walletAddress: WALLET,
      tradingBotId: null,
      eventType: "sol_withdraw",
      amount: "-0.047500",
      assetType: "SOL",
      txSignature: SIG,
    });
    expect(String(values.notes)).toContain("47500000 lamports");
    expect(String(values.notes)).toContain(OP_ID);

    // Flip before ledger write (both inside the one transaction callback).
    expect(tx.update.mock.invocationCallOrder[0]).toBeLessThan(
      tx.insert.mock.invocationCallOrder[0]
    );
    expect(h.dbTransaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    { lamports: "1000", amount: "-0.000001", display: "0.000001" },
    { lamports: "1499", amount: "-0.000001", display: "0.000001" },
    { lamports: "1500", amount: "-0.000002", display: "0.000002" },
    { lamports: "999", amount: "-0.000001", display: "0.000001" },
    { lamports: "123456789", amount: "-0.123457", display: "0.123457" },
  ])(
    "BigInt half-up ledger math: $lamports lamports → $amount",
    async ({ lamports, amount, display }) => {
      const tx = makeTx({
        selects: [[evidenceOp({}, { requestedLamports: lamports })]],
        updateRows: [evidenceOp({ status: "succeeded" })],
      });
      const storage = makeStorage();
      const out = await storage.finalizeAgentSolWithdrawSuccess({
        operationId: OP_ID,
        walletAddress: WALLET,
        expectedSignature: SIG,
      });
      expect(out.outcome).toBe("finalized");
      const values = findCall(tx.insertLog, "values").args[0] as Record<string, any>;
      expect(values.amount).toBe(amount);
      const sets = findCall(tx.updateLog, "set").args[0] as Record<string, any>;
      expect((sets.result as any).withdrawnSolDisplay).toBe(display);
    }
  );

  it("already_succeeded is idempotent: zero writes", async () => {
    const tx = makeTx({ selects: [[evidenceOp({ status: "succeeded" })]] });
    const storage = makeStorage();
    const out = await storage.finalizeAgentSolWithdrawSuccess({
      operationId: OP_ID,
      walletAddress: WALLET,
      expectedSignature: SIG,
    });
    expect(out.outcome).toBe("already_succeeded");
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it.each([
    { label: "row missing", rows: [] as unknown[], reason: "not_found" },
    {
      label: "different wallet",
      rows: [evidenceOp({ walletAddress: "OtherWallet999" })],
      reason: "wallet_mismatch",
    },
    {
      label: "wrong op type",
      rows: [evidenceOp({ operationType: "loop_hop" })],
      reason: "wrong_type",
    },
    { label: "already failed", rows: [evidenceOp({ status: "failed" })], reason: "not_pending" },
  ])("not_finalized ($reason): $label — zero writes", async ({ rows, reason }) => {
    const tx = makeTx({ selects: [rows] });
    const storage = makeStorage();
    const out = await storage.finalizeAgentSolWithdrawSuccess({
      operationId: OP_ID,
      walletAddress: WALLET,
      expectedSignature: SIG,
    });
    expect(out.outcome).toBe("not_finalized");
    if (out.outcome === "not_finalized") expect(out.reason).toBe(reason);
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  const malformedCases: Array<{
    label: string;
    over?: Record<string, unknown>;
    metaOver?: Record<string, unknown>;
    expectedSignature?: string;
  }> = [
    { label: "metadata signature missing", metaOver: { withdrawTxSignature: undefined } },
    { label: "metadata signature differs", metaOver: { withdrawTxSignature: "OtherSig999" } },
    { label: "txSignatures empty (no final entry)", over: { txSignatures: [] } },
    {
      label: "final txSignatures entry differs from the metadata signature",
      over: { txSignatures: [SIG, "OtherSig999"] },
    },
    { label: "pinned lamports '0'", metaOver: { requestedLamports: "0" } },
    { label: "pinned lamports non-numeric", metaOver: { requestedLamports: "abc" } },
    { label: "pinned lamports missing", metaOver: { requestedLamports: undefined } },
    { label: "destination differs from the op wallet", metaOver: { destinationWallet: "OtherWallet999" } },
    { label: "source pin missing", metaOver: { sourceAgentPublicKey: undefined } },
    {
      label: "caller expectedSignature differs from coherent provenance",
      expectedSignature: "CallerDifferentSig999",
    },
  ];

  it.each(malformedCases)(
    "malformed_provenance: $label — never auto-fails, ZERO writes",
    async ({ over, metaOver, expectedSignature }) => {
      const tx = makeTx({ selects: [[evidenceOp(over ?? {}, metaOver ?? {})]] });
      const storage = makeStorage();
      const out = await storage.finalizeAgentSolWithdrawSuccess({
        operationId: OP_ID,
        walletAddress: WALLET,
        expectedSignature: expectedSignature ?? SIG,
      });
      expect(out.outcome).toBe("not_finalized");
      if (out.outcome === "not_finalized") expect(out.reason).toBe("malformed_provenance");
      expect(tx.update).not.toHaveBeenCalled();
      expect(tx.insert).not.toHaveBeenCalled();
    }
  );

  it("equity-event insert failure propagates out of the transaction (status flip rolls back with it)", async () => {
    const tx = makeTx({
      selects: [[evidenceOp()]],
      updateRows: [evidenceOp({ status: "succeeded" })],
      insertError: new Error("equity insert dead"),
    });
    const storage = makeStorage();
    await expect(
      storage.finalizeAgentSolWithdrawSuccess({
        operationId: OP_ID,
        walletAddress: WALLET,
        expectedSignature: SIG,
      })
    ).rejects.toThrow("equity insert dead");
    // The flip and the ledger write were attempted inside ONE transaction —
    // the propagated rejection is what triggers the real rollback in drizzle.
    expect(tx.update).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(h.dbTransaction).toHaveBeenCalledTimes(1);
  });
});
