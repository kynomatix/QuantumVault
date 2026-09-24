import { beforeEach, describe, expect, it, vi } from "vitest";

const swap = vi.hoisted(() => ({ getBestQuote: vi.fn(), executeAgentSwap: vi.fn() }));

vi.mock("../../server/swap/index.js", () => ({ getBestQuote: swap.getBestQuote }));
vi.mock("../../server/agent-wallet", () => ({
  executeAgentSwap: swap.executeAgentSwap,
  USDC_MINT: ["EPjFWdd5Auf", "qSSqeM2qN1x", "zybapC8G4wE", "GGkZwyTDt1v"].join(""),
}));

import { getYieldRoute } from "../../server/vault/yield-routes";
import type { YieldAsset } from "../../server/vault/yield-assets";

const asset: YieldAsset = {
  key: "onyc",
  displayName: "OnRe ONyc",
  mint: ["5Y8NV33Vv7W", "bnLfq3zBcKS", "dYPrk7g2Koi", "Qoe7M2tcxp5"].join(""),
  decimals: 9,
  route: "jupiter",
  valuation: "market_quote",
  defaultEligible: false,
  riskClass: "float",
  mayLoseValue: true,
  apyLabel: "~11.5%",
  tag: "Floats",
  riskNote: "Tokenized reinsurance.",
  enabled: true,
};

describe("Swap yield route availability", () => {
  beforeEach(() => vi.clearAllMocks());

  it("distinguishes authoritative no-route from temporary provider unavailability", async () => {
    const route = getYieldRoute(asset);
    swap.getBestQuote.mockResolvedValueOnce({ kind: "no_route", provider: "jupiter", code: "NO_ROUTES_FOUND" });
    await expect(route.previewPark(734_175n, 100)).resolves.toMatchObject({ wouldReject: true, reasonCode: "no_route" });
    swap.getBestQuote.mockResolvedValueOnce({ kind: "unavailable", failure: { provider: "jupiter", failureClass: "rate_limited", status: 429, retryAfterMs: 1000 } });
    await expect(route.previewPark(734_175n, 100)).resolves.toMatchObject({ wouldReject: true, reasonCode: "quote_provider_unavailable" });
  });

  it("keeps valuation unknown and carries the truthful reason", async () => {
    const route = getYieldRoute(asset);
    swap.getBestQuote.mockResolvedValueOnce({ kind: "unavailable", failure: { provider: "jupiter", failureClass: "timeout", status: null, retryAfterMs: null } });
    await expect(route.valueInUsdc(92_153_819_906n)).resolves.toEqual({ valueUsdcRaw: null, source: "market_quote", reasonCode: "quote_provider_unavailable" });
    expect(swap.getBestQuote).toHaveBeenCalledWith(expect.objectContaining({ purpose: "execution" }));
  });

  it("lets a risk-reducing valuation bypass read shedding", async () => {
    const route = getYieldRoute(asset);
    swap.getBestQuote.mockResolvedValueOnce({ kind: "quote", quote: { provider: "jupiter", outAmountRaw: "639501772", priceImpactPct: 0.001 } });
    await expect(route.valueInUsdc(92_153_819_906n, "risk_reducing")).resolves.toMatchObject({ valueUsdcRaw: "639501772" });
    expect(swap.getBestQuote).toHaveBeenCalledWith(expect.objectContaining({ purpose: "risk_reducing" }));
  });

  it("returns a successful quote without weakening the impact cap", async () => {
    const route = getYieldRoute(asset);
    swap.getBestQuote.mockResolvedValueOnce({ kind: "quote", quote: { provider: "jupiter", outAmountRaw: "639501772", priceImpactPct: 0.001 } });
    await expect(route.previewPark(734_175n, 100)).resolves.toMatchObject({ expectedOutRaw: "639501772", wouldReject: false });
    swap.getBestQuote.mockResolvedValueOnce({ kind: "quote", quote: { provider: "jupiter", outAmountRaw: "639501772", priceImpactPct: 0.006 } });
    await expect(route.previewPark(734_175n, 100)).resolves.toMatchObject({ wouldReject: true });
  });

  it("marks an unpark swap as risk reducing at the shared provider queue", async () => {
    const route = getYieldRoute(asset);
    swap.executeAgentSwap.mockResolvedValueOnce({ success: true, signature: "sig", outputReceivedRaw: "1", outputReceived: 0.000001 });
    await expect(route.unpark({
      agentPublicKey: "wallet",
      agentSecretKey: new Uint8Array(64),
      amountTokenRaw: 1n,
      slippageBps: 100,
    })).resolves.toMatchObject({ success: true });
    expect(swap.executeAgentSwap).toHaveBeenCalledWith(expect.objectContaining({ purpose: "risk_reducing" }));
  });
});
