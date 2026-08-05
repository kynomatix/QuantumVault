import { describe, expect, it } from "vitest";
import {
  isMultiplierMarketQuarantined,
  MULTIPLIER_UNQUALIFIED_REASON,
} from "../../server/ai-trader/multiplier-market-quarantine";

describe("multiplier market quarantine", () => {
  it.each([
    "1MBONK-PERP",
    "1MPEPE-PERP",
    "1KWEN-PERP",
    "1KMEW-PERP",
    "1KPUMP-PERP",
    "1KMON-PERP",
  ])("quarantines current registry symbol %s", (market) => {
    expect(isMultiplierMarketQuarantined(market)).toBe(true);
  });

  it.each([
    "BONK1M-PERP",
    "KMON-PERP",
    "1-PERP",
    "10X-PERP",
    "1M-PERP",
  ])("does not quarantine false-positive control %s", (market) => {
    expect(isMultiplierMarketQuarantined(market)).toBe(false);
  });

  it("strips one terminal perp suffix and matches the prefix case-insensitively", () => {
    expect(isMultiplierMarketQuarantined("1mbonk-perp")).toBe(true);
    expect(isMultiplierMarketQuarantined("1KWEN")).toBe(true);
    expect(isMultiplierMarketQuarantined("X-1MBONK-PERP")).toBe(false);
  });

  it("exports one fixed refusal reason", () => {
    expect(MULTIPLIER_UNQUALIFIED_REASON).toBe("multiplier_unqualified");
  });
});
