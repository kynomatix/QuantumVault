import { beforeEach, describe, expect, it, vi } from "vitest";

const getMarketInfoMock = vi.fn();

vi.mock("../../server/market-registry", () => ({
  getMarketInfo: (...args: unknown[]) => getMarketInfoMock(...args),
}));

import {
  isAiTraderMarketAdmitted,
  SCANNER_MARKET_UNADMITTED_REASON,
} from "../../server/ai-trader/market-admission";

describe("exact AI Trader market admission", () => {
  beforeEach(() => {
    getMarketInfoMock.mockReset();
  });

  it("admits an exact registry key", () => {
    getMarketInfoMock.mockReturnValue({ internalSymbol: "BTC-PERP" });
    expect(isAiTraderMarketAdmitted("BTC-PERP")).toBe(true);
    expect(getMarketInfoMock).toHaveBeenCalledWith("BTC-PERP");
  });

  it("fails closed without trimming, case folding, aliases, or fallback", () => {
    getMarketInfoMock.mockReturnValue(undefined);
    for (const market of ["btc-perp", " BTC-PERP", "BTC", "UNKNOWN-PERP", ""]) {
      expect(isAiTraderMarketAdmitted(market)).toBe(false);
    }
    expect(getMarketInfoMock.mock.calls.map(([market]) => market)).toEqual([
      "btc-perp",
      " BTC-PERP",
      "BTC",
      "UNKNOWN-PERP",
    ]);
  });

  it("exports one fixed refusal reason", () => {
    expect(SCANNER_MARKET_UNADMITTED_REASON).toBe("scanner_market_unadmitted");
  });
});
