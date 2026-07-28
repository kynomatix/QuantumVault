import { describe, expect, it, vi } from "vitest";
import { assessResetAgentOnChainStrict } from "../../server/vault/reset-agent-onchain";

const secretKey = new Uint8Array([1, 2, 3]);

function adapter(result: unknown = { hasOpenPositions: false, hasExchangeFunds: false }) {
  return {
    assessAgentWalletResetStateStrict: vi.fn(async () => result),
  } as any;
}

describe("strict Reset Agent Wallet on-chain assessment", () => {
  it("delegates to the purpose-built authenticated adapter boundary", async () => {
    const a = adapter();

    await expect(assessResetAgentOnChainStrict("agent", secretKey, a)).resolves.toEqual({ blocked: false });

    expect(a.assessAgentWalletResetStateStrict).toHaveBeenCalledWith({
      agentPublicKey: "agent",
      agentSecretKey: secretKey,
    });
  });

  it("fails closed when the active adapter has no strict reset reader", async () => {
    await expect(assessResetAgentOnChainStrict("agent", secretKey, {} as any)).rejects.toThrow();
  });

  it.each([
    [null],
    [{}],
    [{ hasOpenPositions: false }],
    [{ hasOpenPositions: 0, hasExchangeFunds: false }],
    [{ hasOpenPositions: false, hasExchangeFunds: "false" }],
  ])("rejects malformed adapter result %#", async (result) => {
    await expect(assessResetAgentOnChainStrict("agent", secretKey, adapter(result))).rejects.toThrow();
  });

  it("propagates adapter transport/decode failure instead of converting it to clean state", async () => {
    const a = {
      assessAgentWalletResetStateStrict: vi.fn(async () => {
        throw new Error("private upstream detail");
      }),
    } as any;
    await expect(assessResetAgentOnChainStrict("agent", secretKey, a)).rejects.toThrow("private upstream detail");
  });

  it("gives open-position risk precedence when both venue flags are true", async () => {
    await expect(
      assessResetAgentOnChainStrict(
        "agent",
        secretKey,
        adapter({ hasOpenPositions: true, hasExchangeFunds: true }),
      ),
    ).resolves.toEqual({ blocked: true, reason: "open_positions" });
  });

  it("blocks exchange funds or liabilities", async () => {
    await expect(
      assessResetAgentOnChainStrict(
        "agent",
        secretKey,
        adapter({ hasOpenPositions: false, hasExchangeFunds: true }),
      ),
    ).resolves.toEqual({ blocked: true, reason: "exchange_funds" });
  });
});
