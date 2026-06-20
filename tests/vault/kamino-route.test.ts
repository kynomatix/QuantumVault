import { describe, it, expect } from "vitest";
import {
  isReserveFresh,
  usdcValueFromKusdcRaw,
  kusdcFromUsdcRaw,
  KAMINO_RESERVE_STALE_SLOTS,
  KAMINO_MAX_SLOT_SKEW,
} from "../../server/vault/kamino-route";

describe("kamino-route freshness gate (slot-distance only; on-chain stale flag ignored)", () => {
  it("accepts a recently-updated reserve up to the threshold", () => {
    expect(isReserveFresh(1000, 1000)).toBe(true);
    expect(isReserveFresh(1000, 1000 + KAMINO_RESERVE_STALE_SLOTS)).toBe(true);
  });

  it("rejects a reserve too many slots behind", () => {
    expect(isReserveFresh(1000, 1000 + KAMINO_RESERVE_STALE_SLOTS + 1)).toBe(false);
  });

  it("treats a small negative skew (reserve slightly newer than our slot read) as fresh", () => {
    expect(isReserveFresh(1000 + KAMINO_MAX_SLOT_SKEW, 1000)).toBe(true);
  });

  it("rejects an implausibly far-future lastUpdate slot (corrupt decode / bad RPC)", () => {
    expect(isReserveFresh(1000 + KAMINO_MAX_SLOT_SKEW + 1, 1000)).toBe(false);
  });

  it("rejects non-finite slots", () => {
    expect(isReserveFresh(Number.NaN, 1000)).toBe(false);
    expect(isReserveFresh(1000, Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("kamino-route rate math (rate = cTokens per USDC, < 1)", () => {
  // rate 0.8 means 1 USDC mints 0.8 kUSDC, and 1 kUSDC redeems for 1.25 USDC.
  const rate = "0.8";

  it("values kUSDC above face when rate < 1 (interest accrued)", () => {
    expect(usdcValueFromKusdcRaw(BigInt(1_000_000), rate)).toBe("1250000");
  });

  it("mints fewer kUSDC than USDC deposited when rate < 1", () => {
    expect(kusdcFromUsdcRaw(BigInt(1_000_000), rate)).toBe("800000");
  });

  it("treats zero as zero, not null", () => {
    expect(usdcValueFromKusdcRaw(BigInt(0), rate)).toBe("0");
    expect(kusdcFromUsdcRaw(BigInt(0), rate)).toBe("0");
  });

  it("floors (never rounds funds up) and returns an integer string", () => {
    // 1_000_001 / 0.8 = 1250001.25 -> floor 1250001
    expect(usdcValueFromKusdcRaw(BigInt(1_000_001), rate)).toBe("1250001");
    // 1_000_001 * 0.8 = 800000.8 -> floor 800000
    expect(kusdcFromUsdcRaw(BigInt(1_000_001), rate)).toBe("800000");
  });

  it("returns null on a non-positive or invalid rate", () => {
    expect(usdcValueFromKusdcRaw(BigInt(1_000_000), "0")).toBeNull();
    expect(usdcValueFromKusdcRaw(BigInt(1_000_000), "-0.5")).toBeNull();
    expect(kusdcFromUsdcRaw(BigInt(1_000_000), "0")).toBeNull();
    expect(usdcValueFromKusdcRaw(BigInt(1_000_000), "not-a-number")).toBeNull();
  });

  it("stays exact for large holdings (no float drift)", () => {
    // 1_000_000_000_000 (1M USDC of kUSDC) / 0.8 = 1_250_000_000_000
    expect(usdcValueFromKusdcRaw(BigInt(1_000_000_000_000), rate)).toBe("1250000000000");
  });
});
