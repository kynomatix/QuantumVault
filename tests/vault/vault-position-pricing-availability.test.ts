import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const balance = vi.hoisted(() => vi.fn());
const valueInUsdc = vi.hoisted(() => vi.fn());
const storageMock = vi.hoisted(() => ({ getVaultPositions: vi.fn() }));
const asset = {
  key: "onyc",
  displayName: "OnRe ONyc",
  mint: ["5Y8NV33Vv7W", "bnLfq3zBcKS", "dYPrk7g2Koi", "Qoe7M2tcxp5"].join(""),
  decimals: 9,
  route: "jupiter" as const,
  valuation: "market_quote" as const,
  defaultEligible: false,
  riskClass: "float" as const,
  mayLoseValue: true,
  apyLabel: "~11.5%",
  tag: "Floats",
  riskNote: "Tokenized reinsurance.",
  enabled: true,
};

vi.mock("../../server/agent-wallet", () => ({
  getAgentUsdcBalance: vi.fn(),
  getAgentTokenBalanceRaw: balance,
  getAgentTokenBalanceRawStrict: balance,
  USDC_MINT: ["EPjFWdd5Auf", "qSSqeM2qN1x", "zybapC8G4wE", "GGkZwyTDt1v"].join(""),
}));
vi.mock("../../server/storage", () => ({ storage: storageMock }));
vi.mock("../../server/vault/yield-assets", () => ({
  getEnabledYieldAssets: () => [asset],
  getDetectableYieldAssets: () => [asset],
  getYieldAssetByKey: (key: string) => key === asset.key ? asset : null,
}));
vi.mock("../../server/vault/yield-routes", () => ({
  getYieldRoute: () => ({ valueInUsdc }),
  VAULT_MAX_PRICE_IMPACT: 0.005,
}));
vi.mock("../../server/vault/gas-funding", () => ({ ensureVaultGas: vi.fn() }));
vi.mock("../../server/vault/scope", () => ({ vaultLockKey: vi.fn(() => 1) }));

import { getVaultPositionViews, sumVaultPositionValueUsdc, valueVaultRowsForWallet } from "../../server/vault/vault-service";

describe("Vault position pricing availability", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps value and P/L unknown while carrying the temporary-pricing reason", async () => {
    balance.mockResolvedValue({ amountRaw: "92153819906", decimals: 9, uiAmount: 92.153819906 });
    storageMock.getVaultPositions.mockResolvedValue([{ assetKey: "onyc", usdcCostBasis: "98.36" }]);
    valueInUsdc.mockResolvedValue({ valueUsdcRaw: null, source: "market_quote", reasonCode: "quote_provider_unavailable" });
    const [view] = await getVaultPositionViews("wallet", "agent", null);
    expect(view).toMatchObject({ currentValueUsdc: null, unrealizedPnl: null, pricingReasonCode: "quote_provider_unavailable", costBasisUsdc: 98.36 });
    expect(valueInUsdc).toHaveBeenCalledWith(92_153_819_906n, "read");
  });

  it("defaults all three valuation helpers to read priority", async () => {
    balance.mockResolvedValue({ amountRaw: "92153819906", decimals: 9, uiAmount: 92.153819906 });
    valueInUsdc.mockResolvedValue({ valueUsdcRaw: "1000000", source: "market_quote" });

    storageMock.getVaultPositions.mockResolvedValue([{ assetKey: "onyc", usdcCostBasis: "1" }]);
    await getVaultPositionViews("wallet", "agent", null);
    expect(valueInUsdc).toHaveBeenLastCalledWith(92_153_819_906n, "read");

    valueInUsdc.mockClear();
    await sumVaultPositionValueUsdc("agent");
    expect(valueInUsdc).toHaveBeenLastCalledWith(92_153_819_906n, "read");

    valueInUsdc.mockClear();
    await valueVaultRowsForWallet("agent", [{ assetKey: "onyc", usdcCostBasis: "1" }] as any);
    expect(valueInUsdc).toHaveBeenLastCalledWith(92_153_819_906n, "read");
  });

  it("assigns money-path valuation at the three route call sites", () => {
    const source = readFileSync(new URL("../../server/routes.ts", import.meta.url), "utf8");
    expect(source).toContain('getVaultPositionViews(walletAddress, agentPublicKey, null, { purpose: "execution" })');
    expect(source).toContain('getVaultPositionViews(walletAddress, botCtx.botPublicKey, botCtx.botId, { purpose: "execution" })');
    expect(source).toContain('getVaultPositionViews(bot.walletAddress, botCtx.botPublicKey, bot.id, { purpose: "risk_reducing" })');
  });
});
