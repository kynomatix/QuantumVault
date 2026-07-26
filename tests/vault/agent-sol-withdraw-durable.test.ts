/**
 * tests/vault/agent-sol-withdraw-durable.test.ts — WO2B2A
 *
 * Pins the durable native-SOL withdrawal primitive in server/agent-wallet.ts:
 *
 *  - buildWithdrawSolFromAgentTransaction: deterministic base58 signature
 *    extracted from the REAL signed bytes, exact safe-integer lamports as
 *    encoded in the transfer instruction, zero broadcasts, and numeric-edge
 *    rejection BEFORE any RPC call.
 *  - executeAgentSolWithdrawDurable: durability callback exactly once after
 *    signing and strictly before send; exact-byte single broadcast with
 *    confirmed preflight; mutually exclusive result states (confirmed /
 *    failed_on_chain / ambiguous / not_broadcast) with the precomputed
 *    signature governing every post-precommit failure; no internal retry.
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
// Builder — deterministic signature, exact lamports, zero sends
// ---------------------------------------------------------------------------

describe("buildWithdrawSolFromAgentTransaction (extended result)", () => {
  it("returns the deterministic signature embedded in the signed bytes and the exact encoded lamports, without broadcasting", async () => {
    const res = await buildWithdrawSolFromAgentTransaction(AGENT_PK, USER_PK, SECRET, AMOUNT_SOL);

    // Signature identity: decode the serialized transaction and compare.
    const tx = Transaction.from(Buffer.from(res.transaction, "base64"));
    expect(tx.signature).not.toBeNull();
    expect(bs58.encode(tx.signature!)).toBe(res.signature);
    expect(tx.verifySignatures()).toBe(true);

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
// Durable executor
// ---------------------------------------------------------------------------

describe("executeAgentSolWithdrawDurable", () => {
  it("calls the durability callback once after signing, strictly before a single exact-byte broadcast, then confirms cleanly", async () => {
    const seen: DurableSolWithdrawPrecommit[] = [];
    const persist = vi.fn(async (p: DurableSolWithdrawPrecommit) => {
      seen.push(p);
      // Strictly pre-broadcast: nothing sent while the callback runs.
      expect(connMock.sendRawTransaction).not.toHaveBeenCalled();
    });

    const res = await executeAgentSolWithdrawDurable(AGENT_PK, SECRET, USER_PK, AMOUNT_SOL, persist);

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

  it("callback rejection → not_broadcast: zero sends, zero confirms, and NO signature in the result", async () => {
    const persist = vi.fn(async () => {
      throw new Error("wal write failed");
    });

    const res = await executeAgentSolWithdrawDurable(AGENT_PK, SECRET, USER_PK, AMOUNT_SOL, persist);

    expect(res.state).toBe("not_broadcast");
    expect("signature" in res).toBe(false);
    expect((res as any).error).toContain("wal write failed");
    expect(persist).toHaveBeenCalledTimes(1);
    expect(connMock.sendRawTransaction).not.toHaveBeenCalled();
    expect(connMock.confirmTransaction).not.toHaveBeenCalled();
  });

  it("validation failure → not_broadcast before the callback and before ANY RPC traffic", async () => {
    const persist = vi.fn(async () => {});

    const res = await executeAgentSolWithdrawDurable(AGENT_PK, SECRET, USER_PK, 0, persist);

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

    const res = await executeAgentSolWithdrawDurable(AGENT_PK, SECRET, USER_PK, AMOUNT_SOL, persist);

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
      AMOUNT_SOL,
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

    const res = await executeAgentSolWithdrawDurable(AGENT_PK, SECRET, USER_PK, AMOUNT_SOL, persist);

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

    const res = await executeAgentSolWithdrawDurable(AGENT_PK, SECRET, USER_PK, AMOUNT_SOL, persist);

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

    const res = await executeAgentSolWithdrawDurable(AGENT_PK, SECRET, USER_PK, AMOUNT_SOL, persist);

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

    const res = await executeAgentSolWithdrawDurable(AGENT_PK, SECRET, USER_PK, AMOUNT_SOL, persist);

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
