import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveTradePriceDisplay } from "../../client/src/components/TradeHistoryModal";
import { formatCapitalAmount } from "../../client/src/components/DepositWithdraw";
import { deriveKnownBotEquity, resolveWithdrawalAuthority } from "../../client/src/components/BotManagementDrawer";

describe("accounting-incomplete client surfaces", () => {
  it("never presents an observation-context price as a venue fill", () => {
    expect(resolveTradePriceDisplay({
      price: "101.25",
      webhookPayload: {
        priceRole: "observation_context_only",
        closeAccounting: { kind: "unavailable" },
      },
    })).toEqual({
      value: null,
      label: "--",
      exportValue: "",
      note: "observation only; venue fill unavailable",
    });
    expect(resolveTradePriceDisplay({ price: "101.25", webhookPayload: {} })).toMatchObject({
      value: 101.25,
      exportValue: "101.25",
      note: "",
    });
  });

  it("uses the same unavailable provenance in both UI layouts, clipboard text, and CSV", () => {
    const source = readFileSync("client/src/components/TradeHistoryModal.tsx", "utf8");
    expect(source.match(/resolveTradePriceDisplay\(trade\)/g)).toHaveLength(3);
    expect(source).toContain("price: priceDisplay.exportValue");
    expect(source).toContain("priceNote: priceDisplay.note");
    expect(source).toContain("'Price basis'");
    expect(source).not.toContain('${Number(trade.price).toLocaleString()}');
  });

  it("keeps drawer accounting unknown through display and withdrawal authority", () => {
    expect(deriveKnownBotEquity(null, 50, 10)).toBeNull();
    expect(deriveKnownBotEquity(100, 50, 10)).toBe(140);
    expect(resolveWithdrawalAuthority(null, 1)).toEqual({ allowed: false, reason: "accounting_unavailable" });
    expect(resolveWithdrawalAuthority(5, 6)).toEqual({ allowed: false, reason: "exceeds_available" });
    expect(resolveWithdrawalAuthority(5, 5)).toEqual({ allowed: true, reason: null });
    const source = readFileSync("client/src/components/BotManagementDrawer.tsx", "utf8");
    expect(source).toContain("Withdrawal unavailable: accounting balance is incomplete.");
    expect(source).toContain("Bot equity: -- (accounting unavailable). Position sizing is disabled.");
    expect(source).not.toContain("setBotBalance(data.usdcBalance ?? 0)");
    expect(source).not.toContain("setExchangeFreeCollateral(data.freeCollateral ?? 0)");
  });

  it("uses shared price provenance in the dashboard recent-trades table", () => {
    const source = readFileSync("client/src/pages/App.tsx", "utf8");
    expect(source).toContain("TradeHistoryModal, resolveTradePriceDisplay");
    expect(source).toContain("const priceDisplay = resolveTradePriceDisplay(trade)");
    expect(source).not.toContain("${Number(trade.price).toLocaleString()}");
  });

  it("renders unknown capital as unavailable rather than zero", () => {
    expect(formatCapitalAmount(null)).toBe("--");
    expect(formatCapitalAmount(undefined)).toBe("--");
    expect(formatCapitalAmount(12.5)).toBe("$12.50");
    const source = readFileSync("client/src/components/DepositWithdraw.tsx", "utf8");
    expect(source).toContain("text-capital-accounting-incomplete");
    expect(source).not.toContain("capitalPool?.mainAccountBalance ?? 0");
    expect(source).not.toContain("capitalPool?.allocatedToBot ?? 0");
  });
});
