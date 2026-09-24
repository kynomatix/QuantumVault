import { beforeEach, describe, expect, it, vi } from "vitest";

const wallet = vi.hoisted(() => ({
  getServerConnection: vi.fn(),
  computeRequiredGasLamports: vi.fn(),
  resolveAgentKeypair: vi.fn(),
  executeAgentSwap: vi.fn(),
  getAgentTokenBalanceRaw: vi.fn(),
}));
const swap = vi.hoisted(() => ({ getBestQuote: vi.fn() }));

vi.mock("../../server/agent-wallet", () => ({
  ...wallet,
  GAS_FEE_BUFFER_LAMPORTS: 5000,
  USDC_MINT: ["EPjFWdd5Auf", "qSSqeM2qN1x", "zybapC8G4wE", "GGkZwyTDt1v"].join(""),
  NATIVE_SOL_MINT: "So11111111111111111111111111111111111111112",
}));
vi.mock("../../server/swap/index.js", () => ({ getBestQuote: swap.getBestQuote }));
vi.mock("../../server/vault/yield-routes", () => ({ VAULT_MAX_PRICE_IMPACT: 0.005 }));

import { ensureVaultGas } from "../../server/vault/gas-funding";

describe("Vault gas quote availability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wallet.computeRequiredGasLamports.mockResolvedValue(5_000_000);
    wallet.getServerConnection.mockReturnValue({ getBalance: vi.fn(async () => 1_000_000) });
    wallet.getAgentTokenBalanceRaw.mockResolvedValue({ amountRaw: "100000000", decimals: 6, uiAmount: 100 });
  });

  it("returns a safe temporary-pricing failure instead of throwing or claiming no route", async () => {
    swap.getBestQuote.mockResolvedValue({ kind: "unavailable", failure: { provider: "jupiter", failureClass: "rate_limited", status: 429, retryAfterMs: 1000 } });
    const result = await ensureVaultGas({
      payingPublicKey: "11111111111111111111111111111111",
      funderPublicKey: "11111111111111111111111111111111",
      funderSecretKey: new Uint8Array(64),
      destMint: null,
      label: "Park",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("pricing is temporarily unavailable");
    expect(result.error).not.toContain("no USDC -> SOL route");
    expect(wallet.executeAgentSwap).not.toHaveBeenCalled();
  });

  it("inherits risk-reducing priority through both gas pricing and refill execution", async () => {
    const getBalance = vi.fn()
      .mockResolvedValueOnce(1_000_000)
      .mockResolvedValueOnce(1_000_000)
      .mockResolvedValueOnce(6_000_000)
      .mockResolvedValueOnce(6_000_000);
    wallet.getServerConnection.mockReturnValue({ getBalance });
    swap.getBestQuote.mockResolvedValue({
      kind: "quote",
      quote: { provider: "jupiter", inAmountRaw: "100000000", outAmountRaw: "100000000", priceImpactPct: 0, slippageBps: 100, raw: {} },
    });
    wallet.executeAgentSwap.mockResolvedValue({ success: true, signature: "sig", outputReceivedRaw: "5000000" });

    const result = await ensureVaultGas({
      payingPublicKey: "11111111111111111111111111111111",
      funderPublicKey: "11111111111111111111111111111111",
      funderSecretKey: new Uint8Array(64),
      destMint: null,
      label: "Loop Close",
      purpose: "risk_reducing",
    });

    expect(result.ok).toBe(true);
    expect(swap.getBestQuote).toHaveBeenCalledWith(expect.objectContaining({ purpose: "risk_reducing" }));
    expect(wallet.executeAgentSwap).toHaveBeenCalledWith(expect.objectContaining({ purpose: "risk_reducing" }));
  });
});
