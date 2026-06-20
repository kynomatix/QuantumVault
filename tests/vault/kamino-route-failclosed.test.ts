import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey } from "@solana/web3.js";

/**
 * Fail-closed valuation/preview tests for the Kamino route. We mock only the
 * agent-wallet seam (the route's single runtime dependency) so these run without
 * network: a stubbed Connection controls what the reserve load sees. The real
 * klend-sdk import still runs, but every path here returns before it decodes
 * anything, so no live reserve data is needed.
 */

const getAccountInfoMock = vi.fn();
const getSlotMock = vi.fn(async () => 1000);

vi.mock("../../server/agent-wallet", () => ({
  getServerConnection: () => ({
    getAccountInfo: getAccountInfoMock,
    getSlot: getSlotMock,
  }),
  USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  getAgentTokenBalanceRaw: vi.fn(),
}));

import { KaminoYieldRoute, KAMINO_PROGRAM_ID } from "../../server/vault/kamino-route";
import type { YieldAsset } from "../../server/vault/yield-assets";

const asset: YieldAsset = {
  key: "kamino_usdc",
  displayName: "Kamino USDC",
  mint: "B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D",
  decimals: 6,
  route: "kamino",
  valuation: "redemption_rate",
  defaultEligible: true,
  tag: "",
  enabled: false,
};

const route = new KaminoYieldRoute(asset);
const ONE_KUSDC = BigInt(1_000_000);
const TEN_USDC = BigInt(10_000_000);

beforeEach(() => {
  getAccountInfoMock.mockReset();
  getSlotMock.mockReset();
  getSlotMock.mockResolvedValue(1000);
});

describe("kamino-route fail-closed (no 1:1 fallback)", () => {
  it("valueInUsdc returns null when the reserve account is missing", async () => {
    getAccountInfoMock.mockResolvedValue(null);
    const v = await route.valueInUsdc(ONE_KUSDC);
    expect(v.valueUsdcRaw).toBeNull();
    expect(v.source).toBe("redemption_rate");
  });

  it("valueInUsdc returns null when the reserve is not owned by the Kamino program", async () => {
    getAccountInfoMock.mockResolvedValue({
      owner: new PublicKey("11111111111111111111111111111111"),
      data: Buffer.alloc(8),
    });
    const v = await route.valueInUsdc(ONE_KUSDC);
    expect(v.valueUsdcRaw).toBeNull();
  });

  it("valueInUsdc short-circuits a zero holding to '0' without touching the chain", async () => {
    getAccountInfoMock.mockImplementation(() => {
      throw new Error("chain should not be read for a zero holding");
    });
    const v = await route.valueInUsdc(BigInt(0));
    expect(v.valueUsdcRaw).toBe("0");
    expect(getAccountInfoMock).not.toHaveBeenCalled();
  });

  it("previewPark rejects when the reserve rate is unavailable", async () => {
    getAccountInfoMock.mockResolvedValue(null);
    const p = await route.previewPark(TEN_USDC, 100);
    expect(p.expectedOutRaw).toBeNull();
    expect(p.wouldReject).toBe(true);
    expect(p.priceImpactPct).toBeNull();
  });

  it("previewUnpark rejects when the reserve rate is unavailable", async () => {
    getAccountInfoMock.mockResolvedValue({
      owner: new PublicKey("11111111111111111111111111111111"),
      data: Buffer.alloc(8),
    });
    const p = await route.previewUnpark(ONE_KUSDC, 100);
    expect(p.expectedOutRaw).toBeNull();
    expect(p.wouldReject).toBe(true);
  });

  it("previews reject a non-positive amount before any chain read", async () => {
    getAccountInfoMock.mockImplementation(() => {
      throw new Error("chain should not be read for a zero amount");
    });
    const park = await route.previewPark(BigInt(0), 100);
    const unpark = await route.previewUnpark(BigInt(0), 100);
    expect(park.wouldReject).toBe(true);
    expect(unpark.wouldReject).toBe(true);
    expect(getAccountInfoMock).not.toHaveBeenCalled();
  });

  it("park/unpark fail closed while the route is not yet enabled", async () => {
    const p = await route.park({} as never);
    const u = await route.unpark({} as never);
    expect(p.success).toBe(false);
    expect(u.success).toBe(false);
  });

  it("the pinned program id is the Kamino Lend program", () => {
    expect(KAMINO_PROGRAM_ID).toBe("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
  });
});
