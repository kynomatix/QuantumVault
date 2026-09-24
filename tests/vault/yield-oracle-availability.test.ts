import { describe, expect, it, vi } from "vitest";

const swap = vi.hoisted(() => ({ getBestQuote: vi.fn() }));
const storageMock = vi.hoisted(() => ({
  getYieldApyCacheAll: vi.fn(async () => []),
  insertYieldPriceSnapshot: vi.fn(),
  getYieldPriceSnapshots: vi.fn(async () => []),
  upsertYieldApyCache: vi.fn(),
  pruneYieldPriceSnapshots: vi.fn(),
}));

vi.mock("../../server/swap/index.js", () => ({ getBestQuote: swap.getBestQuote }));
vi.mock("../../server/agent-wallet", () => ({ USDC_MINT: ["EPjFWdd5Auf", "qSSqeM2qN1x", "zybapC8G4wE", "GGkZwyTDt1v"].join("") }));
vi.mock("../../server/storage", () => ({ storage: storageMock }));
vi.mock("../../server/vault/yield-routes", () => ({ VAULT_MAX_PRICE_IMPACT: 0.005, getYieldRoute: vi.fn() }));
vi.mock("../../server/vault/yield-assets", () => ({
  getEnabledYieldAssets: () => [{
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
  }],
}));

import { refreshYieldTableNow } from "../../server/vault/yield-oracle";

describe("Yield oracle quote availability", () => {
  it("keeps provider failure fail-soft and persists no false price sample", async () => {
    swap.getBestQuote.mockResolvedValue({ kind: "unavailable", failure: { provider: "jupiter", failureClass: "timeout", status: null, retryAfterMs: null } });
    const table = await refreshYieldTableNow();
    expect(table.onyc.apy).toBeNull();
    expect(["accruing", "unavailable"]).toContain(table.onyc.method);
    expect(storageMock.insertYieldPriceSnapshot).not.toHaveBeenCalled();
  });
});
