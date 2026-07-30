import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Keypair,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

const connectionMocks = vi.hoisted(() => ({
  getBalance: vi.fn(),
  getAccountInfo: vi.fn(),
  getMinimumBalanceForRentExemption: vi.fn(),
  getTokenAccountBalance: vi.fn(),
  getLatestBlockhash: vi.fn(),
  getBlockHeight: vi.fn(),
  sendRawTransaction: vi.fn(),
  getSignatureStatuses: vi.fn(),
}));

const swapMocks = vi.hoisted(() => ({
  getBestQuote: vi.fn(),
  getProviderByName: vi.fn(),
}));

vi.mock("@solana/web3.js", async (importActual) => {
  const actual = await importActual<typeof import("@solana/web3.js")>();
  return {
    ...actual,
    Connection: class {
      getBalance = connectionMocks.getBalance;
      getAccountInfo = connectionMocks.getAccountInfo;
      getMinimumBalanceForRentExemption = connectionMocks.getMinimumBalanceForRentExemption;
      getTokenAccountBalance = connectionMocks.getTokenAccountBalance;
      getLatestBlockhash = connectionMocks.getLatestBlockhash;
      getBlockHeight = connectionMocks.getBlockHeight;
      sendRawTransaction = connectionMocks.sendRawTransaction;
      getSignatureStatuses = connectionMocks.getSignatureStatuses;
    },
  };
});

vi.mock("../../server/swap/index.js", () => swapMocks);

import {
  NATIVE_SOL_MINT,
  executeAgentInstructions,
  executeAgentInstructionsConfirmOnly,
  executeAgentSwap,
} from "../../server/agent-wallet";

const BLOCKHASH = "11111111111111111111111111111111";
const INPUT_MINT = "B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D";

function signer() {
  const keypair = Keypair.generate();
  return {
    keypair,
    publicKey: keypair.publicKey.toBase58(),
    secretKey: keypair.secretKey,
  };
}

function instructionFor(publicKey: PublicKey) {
  return SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: publicKey, lamports: 0 });
}

function preflightRejection() {
  return new SendTransactionError({
    action: "simulate",
    signature: "",
    transactionMessage: "Transaction simulation failed",
    logs: [],
  });
}

function setupCommon() {
  connectionMocks.getBalance.mockResolvedValue(10_000_000);
  connectionMocks.getAccountInfo.mockResolvedValue(null);
  connectionMocks.getMinimumBalanceForRentExemption.mockResolvedValue(2_000_000);
  connectionMocks.getLatestBlockhash.mockResolvedValue({ blockhash: BLOCKHASH, lastValidBlockHeight: 500 });
  connectionMocks.getBlockHeight.mockResolvedValue(350);
  connectionMocks.sendRawTransaction.mockResolvedValue("rpc-returned-signature");
  connectionMocks.getSignatureStatuses.mockResolvedValue({
    value: [{ err: null, confirmationStatus: "confirmed" }],
  });
}

function setupSwapProvider(agentPublicKey: string) {
  swapMocks.getBestQuote.mockResolvedValue({ provider: "test", priceImpactPct: 0 });
  swapMocks.getProviderByName.mockReturnValue({
    buildSwapTransaction: vi.fn(async () => {
      const message = new TransactionMessage({
        payerKey: new PublicKey(agentPublicKey),
        recentBlockhash: BLOCKHASH,
        instructions: [],
      }).compileToV0Message();
      return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setupCommon();
});

describe("executeAgentInstructionsConfirmOnly broadcast provenance", () => {
  it("a no-hook preflight rejection is proven unsent and returns no signature", async () => {
    const s = signer();
    connectionMocks.sendRawTransaction.mockRejectedValueOnce(preflightRejection());
    const result = await executeAgentInstructionsConfirmOnly({
      agentPublicKey: s.publicKey,
      agentSecretKey: s.secretKey,
      instructions: [instructionFor(s.keypair.publicKey)],
    });
    expect(result.success).toBe(false);
    expect(result.signature).toBeUndefined();
    expect(result.onChainFailed).not.toBe(true);
  });

  it("a no-hook transport throw remains ambiguous and retains the deterministic signature", async () => {
    const s = signer();
    connectionMocks.sendRawTransaction.mockRejectedValueOnce(new Error("transport dropped after accept"));
    const result = await executeAgentInstructionsConfirmOnly({
      agentPublicKey: s.publicKey,
      agentSecretKey: s.secretKey,
      instructions: [instructionFor(s.keypair.publicKey)],
    });
    expect(result).toMatchObject({ success: false, error: "transport dropped after accept" });
    expect(result.signature).toBeTruthy();
    expect(result.onChainFailed).not.toBe(true);
  });

  it("hook failure is pre-broadcast and returns no signature", async () => {
    const s = signer();
    const result = await executeAgentInstructionsConfirmOnly({
      agentPublicKey: s.publicKey,
      agentSecretKey: s.secretKey,
      instructions: [instructionFor(s.keypair.publicKey)],
      onBeforeBroadcast: async () => { throw new Error("persist failed"); },
    });
    expect(result).toMatchObject({ success: false, error: "persist failed" });
    expect(result.signature).toBeUndefined();
    expect(connectionMocks.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("send transport throw after write-ahead retains the deterministic signature", async () => {
    const s = signer();
    let written = "";
    connectionMocks.sendRawTransaction.mockRejectedValueOnce(new Error("send transport down"));
    const result = await executeAgentInstructionsConfirmOnly({
      agentPublicKey: s.publicKey,
      agentSecretKey: s.secretKey,
      instructions: [instructionFor(s.keypair.publicKey)],
      onBeforeBroadcast: async ({ signature }) => { written = signature; },
    });
    expect(written).not.toBe("");
    expect(result).toMatchObject({ success: false, signature: written, error: "send transport down" });
    expect(result.onChainFailed).not.toBe(true);
  });

  it("status-poll throw after send retains the same ambiguous signature", async () => {
    const s = signer();
    let written = "";
    connectionMocks.getSignatureStatuses.mockRejectedValueOnce(new Error("poll failed"));
    const result = await executeAgentInstructionsConfirmOnly({
      agentPublicKey: s.publicKey,
      agentSecretKey: s.secretKey,
      instructions: [instructionFor(s.keypair.publicKey)],
      onBeforeBroadcast: async ({ signature }) => { written = signature; },
    });
    expect(result).toMatchObject({ success: false, signature: written, error: "poll failed" });
    expect(result.onChainFailed).not.toBe(true);
  });

  it("only authoritative st.err sets onChainFailed", async () => {
    const s = signer();
    connectionMocks.getSignatureStatuses.mockResolvedValueOnce({ value: [{ err: { InstructionError: [0, "x"] }, confirmationStatus: "confirmed" }] });
    const result = await executeAgentInstructionsConfirmOnly({
      agentPublicKey: s.publicKey,
      agentSecretKey: s.secretKey,
      instructions: [instructionFor(s.keypair.publicKey)],
      onBeforeBroadcast: vi.fn(),
    });
    expect(result.success).toBe(false);
    expect(result.signature).toBeTruthy();
    expect(result.onChainFailed).toBe(true);
  });
});

describe("executeAgentInstructions broadcast provenance", () => {
  it("a no-hook preflight rejection is proven unsent and returns no signature", async () => {
    const s = signer();
    connectionMocks.sendRawTransaction.mockRejectedValueOnce(preflightRejection());
    const result = await executeAgentInstructions({
      agentPublicKey: s.publicKey,
      agentSecretKey: s.secretKey,
      instructions: [instructionFor(s.keypair.publicKey)],
      verifyOutputMint: NATIVE_SOL_MINT,
    });
    expect(result.success).toBe(false);
    expect(result.signature).toBeUndefined();
    expect(result.onChainFailed).not.toBe(true);
  });

  it("hook failure is pre-broadcast and returns no signature", async () => {
    const s = signer();
    const result = await executeAgentInstructions({
      agentPublicKey: s.publicKey,
      agentSecretKey: s.secretKey,
      instructions: [instructionFor(s.keypair.publicKey)],
      verifyOutputMint: NATIVE_SOL_MINT,
      onBeforeBroadcast: async () => { throw new Error("persist failed"); },
    });
    expect(result.signature).toBeUndefined();
    expect(connectionMocks.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("send and poll throws after write-ahead retain identity without onChainFailed", async () => {
    for (const failure of ["send", "poll"] as const) {
      vi.clearAllMocks();
      setupCommon();
      const s = signer();
      let written = "";
      if (failure === "send") connectionMocks.sendRawTransaction.mockRejectedValueOnce(new Error("send failed"));
      else connectionMocks.getSignatureStatuses.mockRejectedValueOnce(new Error("poll failed"));
      const result = await executeAgentInstructions({
        agentPublicKey: s.publicKey,
        agentSecretKey: s.secretKey,
        instructions: [instructionFor(s.keypair.publicKey)],
        verifyOutputMint: NATIVE_SOL_MINT,
        onBeforeBroadcast: async ({ signature }) => { written = signature; },
      });
      expect(result.signature).toBe(written);
      expect(result.onChainFailed).not.toBe(true);
    }
  });

  it("post-send balance-read throw retains identity", async () => {
    const s = signer();
    let written = "";
    connectionMocks.getBalance
      .mockResolvedValueOnce(10_000_000)
      .mockResolvedValueOnce(100)
      .mockRejectedValueOnce(new Error("post-send balance failed"));
    const result = await executeAgentInstructions({
      agentPublicKey: s.publicKey,
      agentSecretKey: s.secretKey,
      instructions: [instructionFor(s.keypair.publicKey)],
      verifyOutputMint: NATIVE_SOL_MINT,
      onBeforeBroadcast: async ({ signature }) => { written = signature; },
    });
    expect(result).toMatchObject({ success: false, signature: written, error: "post-send balance failed" });
  });

  it("authoritative st.err retains identity and sets onChainFailed", async () => {
    const s = signer();
    connectionMocks.getSignatureStatuses.mockResolvedValueOnce({ value: [{ err: "custom", confirmationStatus: "confirmed" }] });
    const result = await executeAgentInstructions({
      agentPublicKey: s.publicKey,
      agentSecretKey: s.secretKey,
      instructions: [instructionFor(s.keypair.publicKey)],
      verifyOutputMint: NATIVE_SOL_MINT,
      onBeforeBroadcast: vi.fn(),
    });
    expect(result.signature).toBeTruthy();
    expect(result.onChainFailed).toBe(true);
  });
});

describe("executeAgentSwap broadcast provenance", () => {
  it("a no-hook preflight rejection is proven unsent and returns no signature", async () => {
    const s = signer();
    setupSwapProvider(s.publicKey);
    connectionMocks.sendRawTransaction.mockRejectedValueOnce(preflightRejection());
    const result = await executeAgentSwap({
      agentPublicKey: s.publicKey,
      agentSecretKey: s.secretKey,
      inputMint: INPUT_MINT,
      outputMint: NATIVE_SOL_MINT,
      amountRaw: "10",
    });
    expect(result.success).toBe(false);
    expect(result.signature).toBeUndefined();
    expect(result.onChainFailed).not.toBe(true);
  });

  it("hook failure is pre-broadcast and returns no signature", async () => {
    const s = signer();
    setupSwapProvider(s.publicKey);
    const result = await executeAgentSwap({
      agentPublicKey: s.publicKey,
      agentSecretKey: s.secretKey,
      inputMint: INPUT_MINT,
      outputMint: NATIVE_SOL_MINT,
      amountRaw: "10",
      onBeforeBroadcast: async () => { throw new Error("persist failed"); },
    });
    expect(result.signature).toBeUndefined();
    expect(connectionMocks.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("send and poll throws after write-ahead retain the exact signature", async () => {
    for (const failure of ["send", "poll"] as const) {
      vi.clearAllMocks();
      setupCommon();
      const s = signer();
      setupSwapProvider(s.publicKey);
      let written = "";
      if (failure === "send") connectionMocks.sendRawTransaction.mockRejectedValueOnce(new Error("send failed"));
      else connectionMocks.getSignatureStatuses.mockRejectedValueOnce(new Error("poll failed"));
      const result = await executeAgentSwap({
        agentPublicKey: s.publicKey,
        agentSecretKey: s.secretKey,
        inputMint: INPUT_MINT,
        outputMint: NATIVE_SOL_MINT,
        amountRaw: "10",
        onBeforeBroadcast: async ({ signature }) => { written = signature; },
      });
      expect(result.signature).toBe(written);
      expect(result.onChainFailed).not.toBe(true);
    }
  });

  it("authoritative st.err is the only swap onChainFailed result", async () => {
    const s = signer();
    setupSwapProvider(s.publicKey);
    connectionMocks.getSignatureStatuses.mockResolvedValueOnce({ value: [{ err: "swap failed", confirmationStatus: "confirmed" }] });
    const result = await executeAgentSwap({
      agentPublicKey: s.publicKey,
      agentSecretKey: s.secretKey,
      inputMint: INPUT_MINT,
      outputMint: NATIVE_SOL_MINT,
      amountRaw: "10",
      onBeforeBroadcast: vi.fn(),
    });
    expect(result.signature).toBeTruthy();
    expect(result.onChainFailed).toBe(true);
  });
});
