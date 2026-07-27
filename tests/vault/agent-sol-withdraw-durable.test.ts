/**
 * tests/vault/agent-sol-withdraw-durable.test.ts — WO2B2A + WO2B2B
 *
 * Pins the durable native-SOL withdrawal primitives in server/agent-wallet.ts:
 *
 *  - buildWithdrawSolFromAgentTransaction (LEGACY): deterministic base58
 *    signature extracted from the REAL signed bytes, exact safe-integer
 *    lamports, zero broadcasts, numeric-edge rejection BEFORE any RPC call,
 *    and a byte-shape pin: exactly ONE instruction (SystemProgram.transfer),
 *    NO memo — unchanged from its historical shape.
 *  - buildWithdrawSolLamportsFromAgentTransaction (WO2B2B): exact raw-lamport
 *    input (no float round-tripping), REQUIRED domain-separated memo as a
 *    second instruction, deterministic signature, zero broadcasts, and
 *    rejection of every non-positive/non-safe-integer lamport edge and every
 *    empty/oversized memo BEFORE any RPC call.
 *  - Domain separation: two different clientRequestIds can NEVER share signed
 *    bytes/signatures even with identical amount/destination/blockhash; the
 *    same clientRequestId under the same blockhash reproduces the same
 *    signature.
 *  - executeAgentSolWithdrawDurable (WO2B2B signature): raw lamports +
 *    clientRequestId; validates the clientRequestId BEFORE building (raw
 *    length ≤ 128, nonempty after trim); durability callback exactly once
 *    after signing and strictly before send; exact-byte single broadcast with
 *    confirmed preflight; memo instruction present in the broadcast bytes;
 *    mutually exclusive result states (confirmed / failed_on_chain /
 *    ambiguous / not_broadcast) with the precomputed signature governing
 *    every post-precommit failure; no internal retry.
 *  - executeAgentSolWithdraw (existing Reset executor) remains independently
 *    callable with unchanged semantics.
 *
 * Real @solana/web3.js crypto (Keypair/Transaction signing) is used; only the
 * Connection class is replaced so no test ever touches the network.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { connMock } = vi.hoisted(() => ({
  connMock: {
    getLatestBlockhash: vi.fn(),
    sendRawTransaction: vi.fn(),
    confirmTransaction: vi.fn(),
  },
}));

vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();
  // Plain class (NOT vi.fn) so vi.resetAllMocks can never strip the redirect.
  class MockConnection {
    constructor() {
      return connMock as any;
    }
  }
  return { ...actual, Connection: MockConnection };
});

import { Keypair, Transaction, SystemInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import {
  buildWithdrawSolFromAgentTransaction,
  buildWithdrawSolLamportsFromAgentTransaction,
  buildAgentSolWithdrawMemo,
  SOL_WITHDRAW_MEMO_PROGRAM_ID,
  executeAgentSolWithdrawDurable,
  executeAgentSolWithdraw,
  type DurableSolWithdrawPrecommit,
  type DurableSolWithdrawResult,
} from "../../server/agent-wallet";

const agentKeypair = Keypair.generate();
const AGENT_PK = agentKeypair.publicKey.toBase58();
const SECRET = agentKeypair.secretKey; // resolveAgentKeypair = Keypair.fromSecretKey
const USER_PK = Keypair.generate().publicKey.toBase58();

const BLOCKHASH = bs58.encode(Buffer.alloc(32, 7));
const LVBH = 1234;
const AMOUNT_SOL = 0.0475;
const EXPECTED_LAMPORTS = 47_500_000;
const CRID = "wo2b2b-test-crid-1";
const MEMO = `qv:agent_sol_withdraw:${CRID}`;

function primeClean() {
  connMock.getLatestBlockhash.mockResolvedValue({ blockhash: BLOCKHASH, lastValidBlockHeight: LVBH });
  // Echo the embedded fee-payer signature, exactly like a real RPC node.
  connMock.sendRawTransaction.mockImplementation(async (raw: Buffer) => {
    const tx = Transaction.from(raw);
    return bs58.encode(tx.signature!);
  });
  connMock.confirmTransaction.mockResolvedValue({ context: { slot: 1 }, value: { err: null } });
}

beforeEach(() => {
  vi.resetAllMocks();
  primeClean();
});

// ---------------------------------------------------------------------------
// Memo identity helper
// ---------------------------------------------------------------------------

describe("buildAgentSolWithdrawMemo", () => {
  it("produces the pinned domain-separated identity string", () => {
    expect(buildAgentSolWithdrawMemo(CRID)).toBe(`qv:agent_sol_withdraw:${CRID}`);
    expect(buildAgentSolWithdrawMemo("other")).toBe("qv:agent_sol_withdraw:other");
  });
});

// ---------------------------------------------------------------------------
// LEGACY builder — deterministic signature, exact lamports, zero sends,
// and the historical byte shape: ONE instruction, NO memo.
// ---------------------------------------------------------------------------

describe("buildWithdrawSolFromAgentTransaction (extended result)", () => {
  it("returns the deterministic signature embedded in the signed bytes and the exact encoded lamports, without broadcasting", async () => {
    const res = await buildWithdrawSolFromAgentTransaction(AGENT_PK, USER_PK, SECRET, AMOUNT_SOL);

    // Signature identity: decode the serialized transaction and compare.
    const tx = Transaction.from(Buffer.from(res.transaction, "base64"));
    expect(tx.signature).not.toBeNull();
    expect(bs58.encode(tx.signature!)).toBe(res.signature);
    expect(tx.verifySignatures()).toBe(true);

    // LEGACY shape pin: exactly one instruction, NO memo (WO2B2B adds the
    // memo ONLY to the raw-lamport durable builder).
    expect(tx.instructions).toHaveLength(1);

    // Exact lamports as ENCODED in the transfer instruction.
    const decoded = SystemInstruction.decodeTransfer(tx.instructions[0]);
    expect(Number(decoded.lamports)).toBe(EXPECTED_LAMPORTS);
    expect(res.lamports).toBe(EXPECTED_LAMPORTS);
    expect(decoded.fromPubkey.toBase58()).toBe(AGENT_PK);
    expect(decoded.toPubkey.toBase58()).toBe(USER_PK);

    // Window passthrough + legacy fields intact (source compatibility).
    expect(res.blockhash).toBe(BLOCKHASH);
    expect(res.lastValidBlockHeight).toBe(LVBH);
    expect(typeof res.message).toBe("string");

    // Builder NEVER broadcasts.
    expect(connMock.sendRawTransaction).not.toHaveBeenCalled();
    expect(connMock.confirmTransaction).not.toHaveBeenCalled();

    // Determinism: same key + same blockhash + same lamports → same signature.
    const res2 = await buildWithdrawSolFromAgentTransaction(AGENT_PK, USER_PK, SECRET, AMOUNT_SOL);
    expect(res2.signature).toBe(res.signature);
  });

  it("encodes nearest-lamport rounding exactly (1.5 lamports → 2)", async () => {
    const res = await buildWithdrawSolFromAgentTransaction(AGENT_PK, USER_PK, SECRET, 1.5e-9);
    expect(res.lamports).toBe(2);
    const tx = Transaction.from(Buffer.from(res.transaction, "base64"));
    expect(Number(SystemInstruction.decodeTransfer(tx.instructions[0]).lamports)).toBe(2);
  });

  const badAmounts: Array<{ label: string; amount: number }> = [
    { label: "NaN", amount: Number.NaN },
    { label: "+Infinity", amount: Number.POSITIVE_INFINITY },
    { label: "-Infinity", amount: Number.NEGATIVE_INFINITY },
    { label: "zero", amount: 0 },
    { label: "negative", amount: -0.5 },
    { label: "sub-lamport rounding to zero", amount: 4e-10 },
    { label: "unsafe lamport magnitude", amount: 1e10 },
  ];

  it.each(badAmounts)("rejects $label before signing or any RPC call", async ({ amount }) => {
    await expect(
      buildWithdrawSolFromAgentTransaction(AGENT_PK, USER_PK, SECRET, amount),
    ).rejects.toThrow(/Invalid withdraw amount/);
    expect(connMock.getLatestBlockhash).not.toHaveBeenCalled();
    expect(connMock.sendRawTransaction).not.toHaveBeenCalled();
    expect(connMock.confirmTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// WO2B2B raw-lamport builder — exact integer lamports, REQUIRED memo,
// domain separation, zero sends.
// ---------------------------------------------------------------------------

describe("buildWithdrawSolLamportsFromAgentTransaction (WO2B2B)", () => {
  it("encodes the exact raw lamports plus a memo instruction carrying the domain-separated identity, without broadcasting", async () => {
    const res = await buildWithdrawSolLamportsFromAgentTransaction(
      AGENT_PK, USER_PK, SECRET, EXPECTED_LAMPORTS, MEMO,
    );

    const tx = Transaction.from(Buffer.from(res.transaction, "base64"));
    expect(bs58.encode(tx.signature!)).toBe(res.signature);
    expect(tx.verifySignatures()).toBe(true);

    // Shape pin: transfer FIRST, memo SECOND, nothing else.
    expect(tx.instructions).toHaveLength(2);
    const decoded = SystemInstruction.decodeTransfer(tx.instructions[0]);
    expect(Number(decoded.lamports)).toBe(EXPECTED_LAMPORTS);
    expect(decoded.fromPubkey.toBase58()).toBe(AGENT_PK);
    expect(decoded.toPubkey.toBase58()).toBe(USER_PK);

    const memoIx = tx.instructions[1];
    expect(memoIx.programId.toBase58()).toBe(SOL_WITHDRAW_MEMO_PROGRAM_ID);
    expect(memoIx.keys).toHaveLength(0);
    expect(Buffer.from(memoIx.data).toString("utf8")).toBe(MEMO);

    expect(res.lamports).toBe(EXPECTED_LAMPORTS);
    expect(res.blockhash).toBe(BLOCKHASH);
    expect(res.lastValidBlockHeight).toBe(LVBH);

    expect(connMock.sendRawTransaction).not.toHaveBeenCalled();
    expect(connMock.confirmTransaction).not.toHaveBeenCalled();
  });

  it("domain separation: same memo → same signature; different memo → different signature and different bytes", async () => {
    const a1 = await buildWithdrawSolLamportsFromAgentTransaction(
      AGENT_PK, USER_PK, SECRET, EXPECTED_LAMPORTS, buildAgentSolWithdrawMemo("crid-A"),
    );
    const a2 = await buildWithdrawSolLamportsFromAgentTransaction(
      AGENT_PK, USER_PK, SECRET, EXPECTED_LAMPORTS, buildAgentSolWithdrawMemo("crid-A"),
    );
    const b = await buildWithdrawSolLamportsFromAgentTransaction(
      AGENT_PK, USER_PK, SECRET, EXPECTED_LAMPORTS, buildAgentSolWithdrawMemo("crid-B"),
    );

    // Same identity under the same blockhash reproduces identical signed bytes.
    expect(a2.signature).toBe(a1.signature);
    expect(a2.transaction).toBe(a1.transaction);

    // A different logical id can never share bytes or signature.
    expect(b.signature).not.toBe(a1.signature);
    expect(b.transaction).not.toBe(a1.transaction);
  });

  const badLamports: Array<{ label: string; lamports: number }> = [
    { label: "zero", lamports: 0 },
    { label: "negative", lamports: -1 },
    { label: "fractional", lamports: 1.5 },
    { label: "NaN", lamports: Number.NaN },
    { label: "unsafe integer (2^53)", lamports: 2 ** 53 },
  ];

  it.each(badLamports)("rejects $label lamports before signing or any RPC call", async ({ lamports }) => {
    await expect(
      buildWithdrawSolLamportsFromAgentTransaction(AGENT_PK, USER_PK, SECRET, lamports, MEMO),
    ).rejects.toThrow(/Invalid withdraw amount: lamports must be a positive safe integer/);
    expect(connMock.getLatestBlockhash).not.toHaveBeenCalled();
    expect(connMock.sendRawTransaction).not.toHaveBeenCalled();
  });

  it.each([
    { label: "empty string", memo: "" },
    { label: "whitespace-only", memo: "   " },
  ])("rejects a $label memo before any RPC call (memo is REQUIRED)", async ({ memo }) => {
    await expect(
      buildWithdrawSolLamportsFromAgentTransaction(AGENT_PK, USER_PK, SECRET, EXPECTED_LAMPORTS, memo),
    ).rejects.toThrow(/domain-separated memo is required/);
    expect(connMock.getLatestBlockhash).not.toHaveBeenCalled();
    expect(connMock.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("rejects an oversized memo (>256 chars) before any RPC call", async () => {
    await expect(
      buildWithdrawSolLamportsFromAgentTransaction(AGENT_PK, USER_PK, SECRET, EXPECTED_LAMPORTS, "m".repeat(257)),
    ).rejects.toThrow(/at most 256 characters/);
    expect(connMock.getLatestBlockhash).not.toHaveBeenCalled();
    expect(connMock.sendRawTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Durable executor (WO2B2B signature: raw lamports + clientRequestId)
// ---------------------------------------------------------------------------

describe("executeAgentSolWithdrawDurable", () => {
  it("calls the durability callback once after signing, strictly before a single exact-byte broadcast (memo included), then confirms cleanly", async () => {
    const seen: DurableSolWithdrawPrecommit[] = [];
    const persist = vi.fn(async (p: DurableSolWithdrawPrecommit) => {
      seen.push(p);
      // Strictly pre-broadcast: nothing sent while the callback runs.
      expect(connMock.sendRawTransaction).not.toHaveBeenCalled();
    });

    const res = await executeAgentSolWithdrawDurable(
      AGENT_PK, SECRET, USER_PK, EXPECTED_LAMPORTS, CRID, persist,
    );

    expect(res.state).toBe("confirmed");
    const ok = res as Extract<DurableSolWithdrawResult, { state: "confirmed" }>;
    expect(ok.lamports).toBe(EXPECTED_LAMPORTS);

    // Callback exactly once, with the full precommit payload.
    expect(persist).toHaveBeenCalledTimes(1);
    const p = seen[0];
    expect(p.blockhash).toBe(BLOCKHASH);
    expect(p.lastValidBlockHeight).toBe(LVBH);
    expect(p.lamports).toBe(EXPECTED_LAMPORTS);
    expect(p.signature).toBe(ok.signature);

    // Single send of the EXACT already-signed bytes with confirmed preflight.
    expect(connMock.sendRawTransaction).toHaveBeenCalledTimes(1);
    const [sentBytes, sendOpts] = connMock.sendRawTransaction.mock.calls[0];
    const sentTx = Transaction.from(sentBytes);
    expect(bs58.encode(sentTx.signature!)).toBe(p.signature);
    expect(sentTx.verifySignatures()).toBe(true);
    expect(Number(SystemInstruction.decodeTransfer(sentTx.instructions[0]).lamports)).toBe(EXPECTED_LAMPORTS);
    expect(sendOpts).toEqual({ skipPreflight: false, preflightCommitment: "confirmed" });

    // The broadcast bytes carry the domain-separated memo for THIS request id.
    expect(sentTx.instructions).toHaveLength(2);
    expect(sentTx.instructions[1].programId.toBase58()).toBe(SOL_WITHDRAW_MEMO_PROGRAM_ID);
    expect(Buffer.from(sentTx.instructions[1].data).toString("utf8")).toBe(MEMO);

    // Ordering: persist → send → confirm.
    expect(persist.mock.invocationCallOrder[0]).toBeLessThan(
      connMock.sendRawTransaction.mock.invocationCallOrder[0],
    );
    expect(connMock.sendRawTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      connMock.confirmTransaction.mock.invocationCallOrder[0],
    );

    // Confirmation against the exact signed-for blockhash window.
    expect(connMock.confirmTransaction).toHaveBeenCalledTimes(1);
    expect(connMock.confirmTransaction).toHaveBeenCalledWith(
      { signature: p.signature, blockhash: BLOCKHASH, lastValidBlockHeight: LVBH },
      "confirmed",
    );
  });

  it("same clientRequestId → same precomputed signature; different clientRequestId → different signature", async () => {
    const sigs: string[] = [];
    const persist = vi.fn(async (p: DurableSolWithdrawPrecommit) => {
      sigs.push(p.signature);
    });

    await executeAgentSolWithdrawDurable(AGENT_PK, SECRET, USER_PK, EXPECTED_LAMPORTS, "crid-A", persist);
    await executeAgentSolWithdrawDurable(AGENT_PK, SECRET, USER_PK, EXPECTED_LAMPORTS, "crid-A", persist);
    await executeAgentSolWithdrawDurable(AGENT_PK, SECRET, USER_PK, EXPECTED_LAMPORTS, "crid-B", persist);

    expect(sigs).toHaveLength(3);
    expect(sigs[1]).toBe(sigs[0]); // deterministic replay identity under the same blockhash
    expect(sigs[2]).not.toBe(sigs[0]); // domain separation across request ids
  });

  it.each([
    { label: "empty", crid: "" },
    { label: "whitespace-only", crid: "   " },
    { label: "over 128 raw chars", crid: "x".repeat(129) },
    { label: "128 trimmed but 129 raw chars", crid: ` ${"x".repeat(128)}` },
  ])("invalid clientRequestId ($label) → not_broadcast before the callback and before ANY RPC traffic", async ({ crid }) => {
    const persist = vi.fn(async () => {});

    const res = await executeAgentSolWithdrawDurable(
      AGENT_PK, SECRET, USER_PK, EXPECTED_LAMPORTS, crid, persist,
    );

    expect(res.state).toBe("not_broadcast");
    expect("signature" in res).toBe(false);
    expect((res as any).error).toContain("invalid clientRequestId");
    expect(persist).not.toHaveBeenCalled();
    expect(connMock.getLatestBlockhash).not.toHaveBeenCalled();
    expect(connMock.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("callback rejection → not_broadcast: zero sends, zero confirms, and NO signature in the result", async () => {
    const persist = vi.fn(async () => {
      throw new Error("wal write failed");
    });

    const res = await executeAgentSolWithdrawDurable(
      AGENT_PK, SECRET, USER_PK, EXPECTED_LAMPORTS, CRID, persist,
    );

    expect(res.state).toBe("not_broadcast");
    expect("signature" in res).toBe(false);
    expect((res as any).error).toContain("wal write failed");
    expect(persist).toHaveBeenCalledTimes(1);
    expect(connMock.sendRawTransaction).not.toHaveBeenCalled();
    expect(connMock.confirmTransaction).not.toHaveBeenCalled();
  });

  it("validation failure (zero lamports) → not_broadcast before the callback and before ANY RPC traffic", async () => {
    const persist = vi.fn(async () => {});

    const res = await executeAgentSolWithdrawDurable(AGENT_PK, SECRET, USER_PK, 0, CRID, persist);

    expect(res.state).toBe("not_broadcast");
    expect("signature" in res).toBe(false);
    expect(persist).not.toHaveBeenCalled();
    expect(connMock.getLatestBlockhash).not.toHaveBeenCalled();
    expect(connMock.sendRawTransaction).not.toHaveBeenCalled();
    expect(connMock.confirmTransaction).not.toHaveBeenCalled();
  });

  it("build failure (blockhash fetch dies) → not_broadcast, callback never invoked", async () => {
    connMock.getLatestBlockhash.mockRejectedValue(new Error("rpc down"));
    const persist = vi.fn(async () => {});

    const res = await executeAgentSolWithdrawDurable(
      AGENT_PK, SECRET, USER_PK, EXPECTED_LAMPORTS, CRID, persist,
    );

    expect(res.state).toBe("not_broadcast");
    expect("signature" in res).toBe(false);
    expect((res as any).error).toContain("rpc down");
    expect(persist).not.toHaveBeenCalled();
    expect(connMock.sendRawTransaction).not.toHaveBeenCalled();
    expect(connMock.confirmTransaction).not.toHaveBeenCalled();
  });

  it("missing callback → not_broadcast with zero RPC traffic", async () => {
    const res = await executeAgentSolWithdrawDurable(
      AGENT_PK,
      SECRET,
      USER_PK,
      EXPECTED_LAMPORTS,
      CRID,
      undefined as unknown as (p: DurableSolWithdrawPrecommit) => Promise<void>,
    );

    expect(res.state).toBe("not_broadcast");
    expect(connMock.getLatestBlockhash).not.toHaveBeenCalled();
    expect(connMock.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("confirmed on-chain error → failed_on_chain (definite, NOT ambiguous) with the precomputed signature", async () => {
    connMock.confirmTransaction.mockResolvedValue({
      context: { slot: 2 },
      value: { err: { InstructionError: [0, { Custom: 1 }] } },
    });
    const seen: DurableSolWithdrawPrecommit[] = [];
    const persist = vi.fn(async (p: DurableSolWithdrawPrecommit) => {
      seen.push(p);
    });

    const res = await executeAgentSolWithdrawDurable(
      AGENT_PK, SECRET, USER_PK, EXPECTED_LAMPORTS, CRID, persist,
    );

    expect(res.state).toBe("failed_on_chain");
    const failed = res as Extract<DurableSolWithdrawResult, { state: "failed_on_chain" }>;
    expect(failed.signature).toBe(seen[0].signature);
    expect(failed.lamports).toBe(EXPECTED_LAMPORTS);
    expect(failed.error).toContain("InstructionError");
    expect(connMock.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("send exception after the precommit → ambiguous with the precomputed signature; exactly one send, zero confirms, no retry", async () => {
    connMock.sendRawTransaction.mockRejectedValue(new Error("blockhash not found"));
    const seen: DurableSolWithdrawPrecommit[] = [];
    const persist = vi.fn(async (p: DurableSolWithdrawPrecommit) => {
      seen.push(p);
    });

    const res = await executeAgentSolWithdrawDurable(
      AGENT_PK, SECRET, USER_PK, EXPECTED_LAMPORTS, CRID, persist,
    );

    expect(res.state).toBe("ambiguous");
    const amb = res as Extract<DurableSolWithdrawResult, { state: "ambiguous" }>;
    expect(amb.signature).toBe(seen[0].signature);
    expect(amb.lamports).toBe(EXPECTED_LAMPORTS);
    expect(amb.error).toContain("blockhash not found");
    expect(connMock.sendRawTransaction).toHaveBeenCalledTimes(1); // no internal retry
    expect(connMock.confirmTransaction).not.toHaveBeenCalled();
  });

  it("RPC-returned signature mismatch → ambiguous for the PRECOMPUTED signature; never a replacement send", async () => {
    const alienSig = bs58.encode(Buffer.alloc(64, 9));
    connMock.sendRawTransaction.mockResolvedValue(alienSig);
    const seen: DurableSolWithdrawPrecommit[] = [];
    const persist = vi.fn(async (p: DurableSolWithdrawPrecommit) => {
      seen.push(p);
    });

    const res = await executeAgentSolWithdrawDurable(
      AGENT_PK, SECRET, USER_PK, EXPECTED_LAMPORTS, CRID, persist,
    );

    expect(res.state).toBe("ambiguous");
    const amb = res as Extract<DurableSolWithdrawResult, { state: "ambiguous" }>;
    expect(amb.signature).toBe(seen[0].signature); // precomputed, NOT the alien one
    expect(amb.signature).not.toBe(alienSig);
    expect(amb.lamports).toBe(EXPECTED_LAMPORTS);
    expect(connMock.sendRawTransaction).toHaveBeenCalledTimes(1); // never a second send
    expect(connMock.confirmTransaction).not.toHaveBeenCalled();
  });

  it("confirmation exception after send → ambiguous with the precomputed signature and exact lamports", async () => {
    connMock.confirmTransaction.mockRejectedValue(new Error("ws closed"));
    const seen: DurableSolWithdrawPrecommit[] = [];
    const persist = vi.fn(async (p: DurableSolWithdrawPrecommit) => {
      seen.push(p);
    });

    const res = await executeAgentSolWithdrawDurable(
      AGENT_PK, SECRET, USER_PK, EXPECTED_LAMPORTS, CRID, persist,
    );

    expect(res.state).toBe("ambiguous");
    const amb = res as Extract<DurableSolWithdrawResult, { state: "ambiguous" }>;
    expect(amb.signature).toBe(seen[0].signature);
    expect(amb.lamports).toBe(EXPECTED_LAMPORTS);
    expect(amb.error).toContain("ws closed");
    expect(connMock.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Existing Reset executor — unchanged, separately callable
// ---------------------------------------------------------------------------

describe("executeAgentSolWithdraw (existing Reset executor) is untouched", () => {
  it("still succeeds standalone with its legacy result shape (no callback involved)", async () => {
    const res = await executeAgentSolWithdraw(AGENT_PK, SECRET, USER_PK, AMOUNT_SOL);

    expect(res.success).toBe(true);
    expect(typeof res.signature).toBe("string");
    const sentTx = Transaction.from(connMock.sendRawTransaction.mock.calls[0][0]);
    expect(bs58.encode(sentTx.signature!)).toBe(res.signature);
    expect(connMock.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(connMock.confirmTransaction).toHaveBeenCalledTimes(1);
  });

  it("still maps a confirmed on-chain error to its legacy {success:false} shape", async () => {
    connMock.confirmTransaction.mockResolvedValue({
      context: { slot: 3 },
      value: { err: { InstructionError: [0, "Custom"] } },
    });

    const res = await executeAgentSolWithdraw(AGENT_PK, SECRET, USER_PK, AMOUNT_SOL);

    expect(res.success).toBe(false);
    expect(res.error).toContain("Transaction failed");
  });
});
